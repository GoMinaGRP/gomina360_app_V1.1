import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { businesses, transportGeofences, transportTrackerViolations, transportTrips, transportVehicles } from "@/db/schema";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { ownerOrgOfBusiness } from "@/lib/notify";
import crypto from "crypto";
import {
  GPS_PROVIDER_LIBRARY,
  evaluatePosition,
  gpsProviderOf,
  haversineKm,
  kmOfRoute,
  pushBreadcrumb,
  sweepOfflineTrackers,
  writeTransportTrail,
} from "@/lib/transport";
import { apiError } from "@/lib/apiError";

/**
 * GPS / vehicle-tracker API — provider-agnostic by design:
 *
 *  GET  ?businessId=N&live=1      → live tracker snapshot for the map:
 *        per-vehicle last position, health, today's mileage, unresolved
 *        violations, geofences, active-trip routes.
 *  POST action=REGISTER           → attach a tracker to a vehicle (any
 *        provider from the registry; generates the device secret for ingest).
 *  POST action=UNREGISTER         → detach.
 *  POST action=INGEST  (session)  → push positions for a vehicle owned by
 *        this user (driver phone / staff console).
 *  POST /api/transport/trackers   → **public device ingest**: same action but
 *        with `deviceId`+`secret` matching the vehicle's registered tracker —
 *        no login required. This is THE generic endpoint every supported
 *        provider (and any future webhook-capable vendor) pushes into.
 *  POST action=SIMULATE (session) → built-in tracker generator for pilots:
 *        accelerates a vehicle along its active trip corridor, emitting
 *        real positions through the exact same ingest path a physical
 *        tracker uses (identical alerting behaviour).
 *
 * Position normalization: providers disagree on payload shapes; the ingest
 * layer accepts {lat,lng,speed,ts} plus the common vendor aliases
 * (latitude/longitude, latitute/longitue, spd/speed_kmh/kmh, fixTime/dateTime/
 * timestamp) and a `positions[]` batch — one integration point, all vendors.
 */

const bad = (m: string, s = 400) => NextResponse.json({ success: false, error: m }, { status: s });
const newSecret = () => crypto.randomBytes(9).toString("hex");

type NormPoint = { ts: number; lat: number; lng: number; speed: number | null };

function normalizePositions(raw: any): NormPoint[] {
  const arr: any[] = Array.isArray(raw) ? raw : raw?.positions && Array.isArray(raw.positions) ? raw.positions : [raw];
  const out: NormPoint[] = [];
  for (const p of arr) {
    if (!p || typeof p !== "object") continue;
    const lat = Number(p.lat ?? p.latitude ?? p.latitute);
    const lng = Number(p.lng ?? p.lon ?? p.long ?? p.longitude ?? p.longitue);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) continue;
    let ts = Number(p.ts ?? p.timestamp ?? p.fixTime ?? p.dateTime ?? 0);
    if (!ts || ts < 10_000_000) ts = Date.now();
    if (ts < 1e12) ts = ts * 1000; // seconds → ms epoch
    const speed = p.speed != null ? Number(p.speed) : p.spd != null ? Number(p.spd) : p.speed_kmh != null ? Number(p.speed_kmh) : p.kmh != null ? Number(p.kmh) : null;
    out.push({ ts, lat, lng, speed: Number.isFinite(speed as any) ? (speed as any) : null });
  }
  return out.sort((a, b) => a.ts - b.ts).slice(-100);
}

/** Core ingest pipeline — shared by every auth path + the simulator. */
async function ingestPositions(vehicle: any, points: NormPoint[], opts?: { source?: string }) {
  let odometerToday = Number(vehicle.gpsMileageTodayKm || 0);
  let crumbs = Array.isArray(vehicle.gpsBreadcrumbs) ? vehicle.gpsBreadcrumbs : [];
  let last = crumbs[crumbs.length - 1] || (vehicle.gpsLastLat != null ? { lat: vehicle.gpsLastLat, lng: vehicle.gpsLastLng } : null);
  for (const pt of points) {
    // active trip tracking (route + mileage)
    const [activeTrip] = vehicle.id
      ? await db
          .select()
          .from(transportTrips)
          .where(and(eq(transportTrips.businessId, Number(vehicle.businessId)), eq(transportTrips.vehicleId, Number(vehicle.id)), eq(transportTrips.status, "EN_ROUTE")))
          .orderBy(desc(transportTrips.id))
          .limit(1)
      : [];
    let tripUpd: any = null;
    if (last) {
      const stepKm = haversineKm(last.lat, last.lng, pt.lat, pt.lng);
      if (stepKm < 50) odometerToday += stepKm; // ignore impossible jumps
      if (activeTrip && stepKm < 50) {
        const route = pushBreadcrumb(activeTrip.gpsRoute as any[], { ts: pt.ts, lat: pt.lat, lng: pt.lng, speed: pt.speed }, 5000);
        tripUpd = { gpsRoute: route, gpsDistanceKm: Math.round((Number(activeTrip.gpsDistanceKm || 0) + stepKm) * 100) / 100 };
        await db.update(transportTrips).set(tripUpd).where(eq(transportTrips.id, activeTrip.id));
      }
    }
    await evaluatePosition(vehicle, { ts: pt.ts, lat: pt.lat, lng: pt.lng, speed: pt.speed, source: opts?.source ?? null }, { activeTrip: activeTrip || null });
    crumbs = pushBreadcrumb(crumbs, { ts: pt.ts, lat: pt.lat, lng: pt.lng, speed: pt.speed, source: opts?.source ?? null }, 500);
    last = { lat: pt.lat, lng: pt.lng };
  }
  await db
    .update(transportVehicles)
    .set({
      gpsLastLat: points[points.length - 1].lat,
      gpsLastLng: points[points.length - 1].lng,
      gpsLastSpeedKmh: points[points.length - 1].speed,
      gpsLastSeenTs: new Date(points[points.length - 1].ts),
      gpsHealth: "ONLINE",
      gpsMileageTodayKm: Math.round(odometerToday * 100) / 100,
      gpsBreadcrumbs: crumbs,
      updatedAt: new Date(),
    })
    .where(eq(transportVehicles.id, Number(vehicle.id)));
  return { accepted: points.length };
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const sp = new URL(request.url).searchParams;
    if (sp.get("providers") === "1") {
      return NextResponse.json({ success: true, providers: GPS_PROVIDER_LIBRARY });
    }
    const businessId = Number(sp.get("businessId"));
    if (!businessId) return bad("businessId required");
    if (!(await canAccessBusiness(user, businessId))) return FORBIDDEN("You do not have access to that business.");
    await sweepOfflineTrackers();
    const vehicles = await db.select().from(transportVehicles).where(eq(transportVehicles.businessId, businessId)).orderBy(desc(transportVehicles.id));
    const violations = await db.select().from(transportTrackerViolations).where(eq(transportTrackerViolations.businessId, businessId)).orderBy(desc(transportTrackerViolations.id)).limit(150);
    const fences = await db.select().from(transportGeofences).where(eq(transportGeofences.businessId, businessId));
    const trips = await db.select().from(transportTrips).where(and(eq(transportTrips.businessId, businessId), eq(transportTrips.status, "EN_ROUTE")));
    return NextResponse.json({
      success: true,
      providers: GPS_PROVIDER_LIBRARY,
      vehicles: vehicles.map((v) => ({
        id: v.id, name: v.name, licensePlate: v.licensePlate, status: v.status,
        gpsEnabled: v.gpsEnabled, gpsProviderKey: v.gpsProviderKey, gpsDeviceImei: v.gpsDeviceImei,
        gpsDeviceLabel: v.gpsDeviceLabel ?? null, gpsSimNumber: v.gpsSimNumber ?? null,
        gpsHealth: v.gpsHealth,
        live: v.gpsLastLat != null ? {
          lat: v.gpsLastLat, lng: v.gpsLastLng, speedKmh: v.gpsLastSpeedKmh,
          seenTs: v.gpsLastSeenTs ? new Date(v.gpsLastSeenTs).toISOString() : null,
          moveState: (v.gpsLastSpeedKmh || 0) > 3 ? "MOVING" : "STATIONARY",
        } : null,
        mileageTodayKm: v.gpsMileageTodayKm,
        odometerKm: v.odometerKm,
        breadcrumbs: (Array.isArray(v.gpsBreadcrumbs) ? v.gpsBreadcrumbs : []).slice(-60),
      })),
      violations,
      geofences: fences,
      activeTrips: trips.map((t) => ({
        id: t.id, vehicleId: t.vehicleId, driverName: t.driverName, source: t.source, destination: t.destination,
        gpsRoute: (Array.isArray(t.gpsRoute) ? t.gpsRoute : []).slice(-120),
        gpsDistanceKm: t.gpsDistanceKm, startTs: t.startTs ? new Date(t.startTs).toISOString() : null,
      })),
    });
  } catch (e: any) {
    return apiError(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "").toUpperCase();

    // ── Public device ingest (provider webhook / hardware tracker push) ───
    // Auth = the vehicle's own secret, never the user session.
    if (action === "INGEST" && !body.sessionUser) {
      const deviceId = String(body.deviceId || body.imei || "").trim();
      if (deviceId) {
        return await deviceIngest(body, deviceId);
      }
    }

    // Session-protected actions below.
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const businessId = Number(body.businessId);
    if (!businessId) return bad("businessId required");
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    if (!biz) return bad("Business not found", 404);
    if (!(await canAccessBusiness(user, businessId))) return FORBIDDEN("You do not have access to that business.");
    const ownerId = await ownerOrgOfBusiness(businessId);
    const actor = { id: user.id, name: user.name, role: user.role, orgId: ownerId };

    if (action === "REGISTER") {
      const vehicleId = Number(body.vehicleId);
      const [veh] = await db.select().from(transportVehicles).where(and(eq(transportVehicles.id, vehicleId), eq(transportVehicles.businessId, businessId)));
      if (!veh) return bad("Vehicle not in this business.", 404);
      const key = String(body.providerKey || "MANUAL").toUpperCase();
      const provider = gpsProviderOf(key);
      const imei = body.deviceImei ? String(body.deviceImei).trim() : `SIM-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
      const secret = newSecret();
      const [u] = await db
        .update(transportVehicles)
        .set({
          gpsEnabled: true,
          gpsProviderKey: provider.key,
          gpsDeviceImei: imei,
          gpsDeviceSecret: secret,
          gpsDeviceLabel: body.deviceLabel ? String(body.deviceLabel).trim().slice(0, 80) || null : null,
          gpsSimNumber: body.simNumber ? String(body.simNumber).trim().replace(/[^0-9+]/g, "").slice(0, 24) || null : null,
          gpsHealth: provider.driver === "simulated" ? "STALE" : veh.gpsHealth ?? "UNKNOWN",
          updatedAt: new Date(),
        })
        .where(eq(transportVehicles.id, vehicleId))
        .returning();
      await writeTransportTrail(actor, { action: "CREATE", targetType: "TRANSPORT", targetLabel: `Tracker registered — ${veh.licensePlate}`, recordType: "TRANSPORT_VEHICLE", recordId: vehicleId, businessId, branchCode: veh.branchCode, detail: `provider ${provider.label} · device ${imei}` });
      // The secret is returned ONCE here (needed by installers to configure
      // the device / webhook); later reads never include it.
      return NextResponse.json({ success: true, vehicle: { ...u, gpsDeviceSecret: undefined }, deviceSecret: secret, deviceId: imei, ingestUrl: "/api/transport/trackers", provider });
    }
    if (action === "UNREGISTER") {
      const vehicleId = Number(body.vehicleId);
      const [veh] = await db.select().from(transportVehicles).where(and(eq(transportVehicles.id, vehicleId), eq(transportVehicles.businessId, businessId)));
      if (!veh) return bad("Vehicle not in this business.", 404);
      const [u] = await db
        .update(transportVehicles)
        .set({ gpsEnabled: false, gpsDeviceImei: null, gpsDeviceSecret: null, gpsHealth: "UNKNOWN", updatedAt: new Date() })
        .where(eq(transportVehicles.id, vehicleId))
        .returning();
      await writeTransportTrail(actor, { action: "UPDATE", targetType: "TRANSPORT", targetLabel: `Tracker unregistered — ${veh.licensePlate}`, recordType: "TRANSPORT_VEHICLE", recordId: vehicleId, businessId, branchCode: veh.branchCode });
      return NextResponse.json({ success: true, vehicle: { ...u, gpsDeviceSecret: undefined } });
    }
    if (action === "INGEST") {
      const vehicleId = Number(body.vehicleId);
      const [veh] = await db.select().from(transportVehicles).where(and(eq(transportVehicles.id, vehicleId), eq(transportVehicles.businessId, businessId)));
      if (!veh) return bad("Vehicle not in this business.", 404);
      if (!veh.gpsEnabled) return bad("No tracker registered on this vehicle.");
      const pts = normalizePositions(body);
      if (pts.length === 0) return bad("No valid positions in the payload.");
      const res = await ingestPositions(veh, pts, { source: `user:${user.name}` });
      return NextResponse.json({ success: true, ...res });
    }
    if (action === "SIMULATE") {
      // Pilot/demo generator: walk the vehicle along its active trip (or a
      // synthetic loop) in N steps, emitting through the real ingest path.
      const vehicleId = Number(body.vehicleId);
      const [veh] = await db.select().from(transportVehicles).where(and(eq(transportVehicles.id, vehicleId), eq(transportVehicles.businessId, businessId)));
      if (!veh) return bad("Vehicle not in this business.", 404);
      if (!veh.gpsEnabled) return bad("Register a (SIMULATED or other) tracker on the vehicle first.");
      const steps = Math.min(12, Math.max(1, Number(body.steps || 4)));
      const speed = body.speed != null ? Number(body.speed) : 55;
      const [trip] = await db
        .select()
        .from(transportTrips)
        .where(and(eq(transportTrips.businessId, businessId), eq(transportTrips.vehicleId, vehicleId), eq(transportTrips.status, "EN_ROUTE")))
        .orderBy(desc(transportTrips.id))
        .limit(1);
      const destLat = body.destLat != null ? Number(body.destLat) : (Number(veh.gpsLastLat ?? 5.6037) + 0.35); // default: head ~40 km N of Accra CBD
      const destLng = body.destLng != null ? Number(body.destLng) : veh.gpsLastLng ?? -0.1870;
      const startLat = veh.gpsLastLat ?? (Number(body.startLat ?? 5.6037) + (vehicleId % 7) * 0.004);
      const startLng = veh.gpsLastLng ?? Number(body.startLng ?? -0.187);
      const pts: NormPoint[] = [];
      const now = Date.now();
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        pts.push({
          ts: now - (steps - i) * 60_000,
          lat: startLat + (destLat - startLat) * f,
          lng: startLng + (destLng - startLng) * f,
          speed: Math.round(speed + (i % 3) * 4),
        });
      }
      const res = await ingestPositions(veh, pts, { source: `simulator` });
      const [v2] = await db.select().from(transportVehicles).where(eq(transportVehicles.id, vehicleId));
      return NextResponse.json({ success: true, ...res, tripId: trip?.id ?? null, last: { lat: v2.gpsLastLat, lng: v2.gpsLastLng, mileageTodayKm: v2.gpsMileageTodayKm } });
    }
    return bad("Unknown action.");
  } catch (e: any) {
    console.error("trackers POST error:", e);
    return apiError(e);
  }
}

/** Public tracker/webhook ingest — verified by the device secret only. */
async function deviceIngest(body: any, deviceId: string) {
  const secret = String(body.secret || body.token || "").trim();
  if (!secret) return bad("device secret required", 401);
  const [veh] = await db.select().from(transportVehicles).where(eq(transportVehicles.gpsDeviceImei, deviceId));
  if (!veh || !veh.gpsEnabled) return bad("unknown device", 404);
  if (!veh.gpsDeviceSecret || veh.gpsDeviceSecret !== secret) return bad("bad device secret", 401);
  const pts = normalizePositions(body);
  if (pts.length === 0) return bad("No valid positions in the payload.");
  const res = await ingestPositions(veh, pts, { source: `device:${deviceId}` });
  return NextResponse.json({ success: true, ...res });
}

