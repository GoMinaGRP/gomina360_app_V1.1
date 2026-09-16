// Transportation & Haulage — shared helpers (server + client-safe utilities).
// Holds the GPS provider library (any vendor + future vendors), geo math
// (haversine, point-in-geofence, route-corridor deviation), per-role
// transportation scope resolution, alert fan-out (bell + push), and the
// AI-insight feed that flags maintenance/comppliance/fuel/behaviour risks.

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  aiInsights,
  notifications,
  organizationMembers,
  transportVehicles,
  transportGeofences,
  transportTrackerViolations,
  transportTrips,
  users,
} from "@/db/schema";
import { accessibleBusinessIds } from "@/lib/auth";
import { ownerOrgOfBusiness, orderNotificationRecipients } from "@/lib/notify";
import { pushAfterBell } from "@/lib/push";

// ── Static vocab ────────────────────────────────────────────────────────────
export const VEHICLE_TYPES = ["TRUCK", "VAN", "PICKUP", "TRAILER", "BUS", "BIKE", "CAR"] as const;
export const FUEL_TYPES = ["PETROL", "DIESEL", "LPG", "EV"] as const;
export const TRIP_STATUSES = ["PLANNED", "EN_ROUTE", "COMPLETED", "CANCELLED"] as const;
export const BOOKING_STATUSES = ["PENDING", "CONFIRMED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export const MAINT_CATEGORIES = ["PREVENTIVE", "ENGINE", "BRAKES", "TYRES", "BATTERY", "ELECTRICAL", "SUSPENSION", "BODY", "INSPECTION", "OTHER"] as const;
export const MAINT_STATUSES = ["DUE", "IN_PROGRESS", "DONE"] as const;
export const VIOLATION_KINDS = [
  "SPEEDING",
  "ROUTE_DEVIATION",
  "UNAUTHORIZED_MOVEMENT",
  "PROLONGED_STOP",
  "GEOFENCE_ENTER",
  "GEOFENCE_EXIT",
  "TRACKER_OFFLINE",
  "TRACKER_TAMPERED",
] as const;

// ── GPS tracker provider library ────────────────────────────────────────────
// Every vendor exposes a small capability map + the ingest hints the backend
// needs to accept its payloads. `driver: "ingest"` providers push positions
// straight into /api/transport/trackers/ingest (recommended); `driver: "poll"`
// providers would need a server polling job (left for gateways); "simulated"
// is NEVER polled — the app itself generates positions for demos/pilots.
// Registering a new tracker type = adding one entry, ZERO other changes.
export type GpsProvider = {
  key: string; // registry key (stored on the vehicle)
  label: string;
  vendor: string;
  driver: "ingest" | "poll" | "simulated" | "none";
  capabilities: ("live" | "history" | "speed" | "mileage" | "geofence" | "tamper" | "fuel")[];
  docs?: string;
  noKey?: boolean;
  devMode?: boolean;
};

export const GPS_PROVIDER_LIBRARY: GpsProvider[] = [
  { key: "MANUAL", label: "Manual / Phone GPS", vendor: "GoMina", driver: "ingest", capabilities: ["live", "history", "speed", "mileage"], noKey: true },
  { key: "SIMULATED", label: "Simulated tracker (pilot/demo)", vendor: "GoMina", driver: "simulated", capabilities: ["live", "history", "speed", "mileage", "geofence", "tamper"], devMode: true, noKey: true },
  { key: "TRACCAR", label: "Traccar Server (self-hosted)", vendor: "Traccar", driver: "ingest", capabilities: ["live", "history", "speed", "mileage", "geofence", "tamper"], docs: "https://www.traccar.org/osmand/" },
  { key: "TKSTAR", label: "TKStar series", vendor: "TKStar", driver: "poll", capabilities: ["live", "history", "speed", "geofence"] },
  { key: "JIMI", label: "Jimi/Concox (GT06N, GV25…)", vendor: "JimiIoT", driver: "poll", capabilities: ["live", "history", "speed", "mileage", "geofence", "tamper", "fuel"] },
  { key: "CARSYE", label: "Carsye GoTrail", vendor: "Carsye", driver: "ingest", capabilities: ["live", "speed", "geofence", "tamper"] },
  { key: "AFGPS", label: "AfriTrack GPS", vendor: "AfriTrack", driver: "poll", capabilities: ["live", "history", "speed", "mileage", "geofence"] },
  { key: "WEBHOOK", label: "Generic webhook (any provider)", vendor: "Custom", driver: "ingest", capabilities: ["live", "history", "speed", "mileage", "geofence", "tamper"], noKey: true },
  { key: "CUSTOM", label: "Custom provider (future)", vendor: "Custom", driver: "ingest", capabilities: ["live", "speed", "geofence"], noKey: true },
];

export const PROVIDER_BY_KEY: Record<string, GpsProvider> = Object.fromEntries(GPS_PROVIDER_LIBRARY.map((p) => [p.key, p]));
export const gpsProviderOf = (key: string | null | undefined) => PROVIDER_BY_KEY[String(key || "").toUpperCase()] ?? GPS_PROVIDER_LIBRARY[0];

// Phase-bucket per drift-to-violation hazard (severity points weighting for AI).
const VIOLATION_SEVERITY: Record<string, { severity: string; hint: string }> = {
  SPEEDING: { severity: "HIGH", hint: "Coach the driver — speeding affects roadworthy & insurance claims." },
  ROUTE_DEVIATION: { severity: "CRITICAL", hint: "Verify cargo/load status immediately — could be theft or a mechanical detour." },
  UNAUTHORIZED_MOVEMENT: { severity: "CRITICAL", hint: "Vehicle moves outside allowed hours — confirm the driver authorized this trip." },
  PROLONGED_STOP: { severity: "MEDIUM", hint: "Vehicle stopped unusually long — check loading/unloading integrity and engine-off discipline." },
  GEOFENCE_ENTER: { severity: "LOW", hint: "Vehicle entered a watched geofence — verify this was expected." },
  GEOFENCE_EXIT: { severity: "HIGH", hint: "Vehicle exited a restricted geofence — confirm destination plan." },
  TRACKER_OFFLINE: { severity: "HIGH", hint: "Tracker stopped reporting — check SIM/data and investigate possible jamming." },
  TRACKER_TAMPERED: { severity: "CRITICAL", hint: "Tracker reports tamper/unplug — send for inspection immediately." },
};

// ── Geo math ────────────────────────────────────────────────────────────────
const R_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(s));
}

/** Is the point inside the geofence? CIRCLE lat/lng+radius or POLYGON ring. */
export function pointInGeofence(lat: number, lng: number, fence: { kind?: string | null; lat?: number | null; lng?: number | null; radiusM?: number | null; polygon?: any }): boolean {
  if (fence.kind === "POLYGON") {
    const ring: [number, number][] = Array.isArray(fence.polygon) ? fence.polygon : [];
    if (ring.length < 3) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const dKm = haversineKm(lat, lng, Number(fence.lat ?? 0), Number(fence.lng ?? 0));
  return dKm * 1000 <= Number(fence.radiusM || 0);
}

/** How far (km) is the point from the straight line source→destination?
 *  Used by route-deviation alerts for in-transit trips. */
export function deviationKm(lat: number, lng: number, src: { lat: number; lng: number }, dst: { lat: number; lng: number }): number {
  // planar-ish approximation sufficient for regional driving.
  const toXY = (la: number, lo: number) => [rad(lo) * R_KM * Math.cos(rad(la)), rad(la) * R_KM] as const;
  const [px, py] = toXY(lat, lng);
  const [ax, ay] = toXY(src.lat, src.lng);
  const [bx, by] = toXY(dst.lat, dst.lng);
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return haversineKm(lat, lng, src.lat, src.lng);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return haversineKm(lat, lng, ax + t * dx, ay + t * dy);
}

export type GpsPoint = { ts: number; lat: number; lng: number; speed?: number | null; heading?: number | null; source?: string | null };

/** Append a position to a ring buffer (mutates a copy, returns the clipped value). */
export function pushBreadcrumb(existing: any[] | null | undefined, pt: GpsPoint, max = 500): GpsPoint[] {
  const arr = Array.isArray(existing) ? (existing as GpsPoint[]) : [];
  const next = [...arr, { ts: pt.ts, lat: pt.lat, lng: pt.lng, speed: pt.speed ?? null, heading: pt.heading ?? null, source: pt.source ?? null } as GpsPoint];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Sum distance (km) of an ordered breadcrumb list. */
export function kmOfRoute(points: { lat: number; lng: number }[]): number {
  let km = 0;
  for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  return km;
}

// ── Scope resolution (same discipline as every module): OWNER sees all org
// businesses; managers/workers see only businesses they can access. Falls back
// to branch-restriction for users limited to a single business.
export async function transportBizScopeOf(user: any): Promise<number[] | null> {
  return accessibleBusinessIds(user); // null ⇒ unrestricted (Super Admin / OWNER of everything)
}

/** May this session sign INTO this transportation business screen? Matches the
 *  carwash guard — data never crosses tenant boundaries. */
export async function assertTransportBizAccess(user: any, businessId: number): Promise<void> {
  const allowed = await accessibleBusinessIds(user);
  if (allowed === null) return;
  if (!allowed.map(Number).includes(Number(businessId))) {
    throw new Error("Forbidden: business outside your scope");
  }
}

// ── Activity + notification helpers ────────────────────────────────────────
export async function writeTransportTrail(actor: any, entry: { action: string; targetType?: string; targetLabel?: string; recordType?: string | null; recordId?: number | null; businessId?: number | null; branchCode?: string | null; reason?: string | null; detail?: string | null }) {
  const tOwnerId = entry.businessId != null ? await ownerOrgOfBusiness(Number(entry.businessId)) : (actor.orgId ?? null);
  const { auditTrail } = await import("@/db/schema");
  await db.insert(auditTrail).values({
    actorUserId: Number(actor.id),
    actorName: String(actor.name || "Transport"),
    actorRole: String(actor.role || "WORKER"),
    action: entry.action,
    targetType: entry.targetType || "TRANSPORT",
    targetLabel: entry.targetLabel || "Transportation",
    recordType: entry.recordType ?? null,
    recordId: entry.recordId ?? null,
    businessId: entry.businessId ?? null,
    branchCode: entry.branchCode ?? null,
    reason: entry.reason ?? null,
    detail: entry.detail ?? null,
    ownerId: tOwnerId,
  });
}

/** Bell + push fan-out to the OWNER and reachable managers of a business. */
export async function notifyTransport(businessId: number, input: { type: string; title: string; body?: string | null; recordType?: string | null; recordId?: number | null; recordRef?: string | null; branchCode?: string | null; actorName?: string | null; priority?: string | null; issueId?: number | null; extraUserIds?: number[] }) {
  const orgId = await ownerOrgOfBusiness(Number(businessId));
  const memberRows = await db.select({ userId: organizationMembers.userId }).from(organizationMembers).where(eq(organizationMembers.organizationId, Number(orgId ?? -1)));
  const memberIds = new Set(memberRows.map((m) => Number(m.userId)));
  let usersRows: any[] = [];
  if (memberIds.size > 0) {
    usersRows = await db
      .select({ id: users.id, name: users.name, role: users.role, isActive: users.isActive, assignedBusinessId: users.assignedBusinessId })
      .from(users)
      .where(inArray(users.id, [...memberIds]));
  }
  const candidates = usersRows.filter(
    (u) => u.isActive !== false && (u.role === "OWNER" || u.role === "GENERAL_MANAGER" || (u.role === "BRANCH_MANAGER" && Number(u.assignedBusinessId) === Number(businessId))),
  );
  const pushedIds = new Set<number>();
  const rows = [...candidates, ...(input.extraUserIds ?? []).map((id) => ({ id: Number(id) }))];
  const targets: { id: number }[] = [];
  for (const u of rows) {
    if (pushedIds.has(Number(u.id))) continue;
    pushedIds.add(Number(u.id));
    targets.push({ id: Number(u.id) });
  }
  if (targets.length === 0) return { inserted: 0 };
  let inserted = 0;
  const pushIds: number[] = [];
  for (const t of targets) {
    // own dup-guard: identical unread bell already open for this record/type
    const dup = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, Number(t.id)),
          eq(notifications.type, input.type),
          eq(notifications.recordType, input.recordType ?? null as any),
          eq(notifications.recordId, input.recordId ?? null as any),
          eq(notifications.isRead, false),
        ),
      )
      .limit(1);
    if (dup.length > 0) continue;
    await db.insert(notifications).values({
      userId: Number(t.id),
      type: input.type,
      title: input.title.slice(0, 240),
      body: (input.body || "").slice(0, 600) || null,
      issueId: input.issueId ?? null,
      recordType: input.recordType ?? null,
      recordId: input.recordId ?? null,
      recordRef: input.recordRef ?? null,
      businessId: Number(businessId),
      branchCode: input.branchCode ?? null,
      actorName: input.actorName ?? null,
      priority: input.priority ?? null,
      ownerId: orgId,
    });
    inserted++;
    pushIds.push(Number(t.id));
  }
  if (pushIds.length > 0) {
    pushAfterBell(pushIds, { type: input.type, title: input.title.slice(0, 240), body: (input.body || "").slice(0, 600), url: "/?tab=AUDIT" });
  }
  return { inserted };
}

// ── AI insights generator ──────────────────────────────────────────────────
const money = (v: number) => `GH₵ ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

/** Emit an ai_insights row for a new transportation risk/opportunity. */
export async function raiseTransportAi(input: { businessId: number; branchCode?: string | null; title: string; category?: string; impact?: string; recommendation: string; metricAffected?: string; projectedGainGhs?: number }) {
  try {
    const { businessId } = input;
    const [exists] = await db
      .select({ id: aiInsights.id })
      .from(aiInsights)
      .where(and(eq(aiInsights.businessId, Number(businessId)), eq(aiInsights.title, input.title), eq(aiInsights.status, "NEW")))
      .limit(1);
    if (exists) return null;
    const [row] = await db
      .insert(aiInsights)
      .values({
        businessId: Number(businessId),
        title: input.title,
        category: input.category || "RISK",
        impactLevel: input.impact || "HIGH",
        recommendation: input.recommendation,
        metricAffected: input.metricAffected || "Transportation",
        projectedGainGhs: input.projectedGainGhs ?? 0,
        ownerId: await ownerOrgOfBusiness(Number(businessId)),
        status: "NEW",
      })
      .returning();
    return row;
  } catch {
    return null;
  }
}

// ── Violation ingestion ────────────────────────────────────────────────────
let _geoCache: { bizKey: string; at: number; rows: any[] } | null = null;
async function geofencesFor(businessId: number): Promise<any[]> {
  const key = String(businessId);
  if (_geoCache && _geoCache.bizKey === key && Date.now() - _geoCache.at < 10_000) return _geoCache.rows;
  const rows = await db.select().from(transportGeofences).where(and(eq(transportGeofences.businessId, Number(businessId)), eq(transportGeofences.active, true)));
  _geoCache = { bizKey: key, at: Date.now(), rows };
  return rows;
}

/** Create one unresolved violation with dup-fencing (same kind+vehicle+trip
 *  open) and then notify managers/OWNER + drop an AI insight. */
export async function recordViolation(input: { businessId: number; branchCode?: string | null; vehicleId: number; plate: string; tripId?: number | null; tripLabel?: string | null; kind: string; detail: string; lat?: number | null; lng?: number | null; actor?: any }) {
  const meta = VIOLATION_SEVERITY[input.kind] ?? { severity: "MEDIUM", hint: "" };
  const open = await db
    .select({ id: transportTrackerViolations.id })
    .from(transportTrackerViolations)
    .where(and(eq(transportTrackerViolations.businessId, Number(input.businessId)), eq(transportTrackerViolations.vehicleId, Number(input.vehicleId)), eq(transportTrackerViolations.kind, input.kind), eq(transportTrackerViolations.status, "UNRESOLVED")))
    .limit(4);
  // Allow one open alert of a kind per vehicle (or per active trip).
  const sameTrip = open.length > 0;
  if (sameTrip && input.kind !== "GEOFENCE_ENTER" && input.kind !== "GEOFENCE_EXIT") return null;

  const ownerId = await ownerOrgOfBusiness(Number(input.businessId));
  const [v] = await db
    .insert(transportTrackerViolations)
    .values({
      businessId: Number(input.businessId),
      branchCode: input.branchCode ?? null,
      ownerId,
      vehicleId: Number(input.vehicleId),
      tripId: input.tripId ?? null,
      kind: input.kind,
      severity: meta.severity,
      detail: input.detail,
      remedyHint: meta.hint,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      vehiclePlate: input.plate,
      tripLabel: input.tripLabel ?? null,
      status: "UNRESOLVED",
      createdByName: input.actor?.name ?? null,
      createdByRole: input.actor?.role ?? null,
    })
    .returning();
  try {
    await notifyTransport(Number(input.businessId), {
      type: `TRANSPORT_${input.kind}`,
      title: `[${input.kind.replace(/_/g, " ")}] ${input.plate}`,
      body: input.detail,
      recordType: "TRANSPORT_VEHICLE",
      recordId: Number(input.vehicleId),
      recordRef: input.plate,
      branchCode: input.branchCode ?? null,
      actorName: "GPS monitor",
      priority: meta.severity,
    });
    if (meta.severity === "CRITICAL" || meta.severity === "HIGH") {
      await raiseTransportAi({
        businessId: Number(input.businessId),
        branchCode: input.branchCode ?? null,
        title: `${input.kind.replace(/_/g, " ")} — ${input.plate}`,
        category: input.kind === "SPEEDING" ? "RISK" : "COMPLIANCE",
        impact: meta.severity,
        recommendation: meta.hint,
        metricAffected: "Transportation compliance",
        projectedGainGhs: 0,
      });
    }
  } catch (e) {
    console.error("transport violation notify warn:", e);
  }
  return v;
}

/** Evaluate one position against every geofence + the active trip corridor,
 *  record violations and return the auto-tracked “stay-in-corridor” verdict. */
export async function evaluatePosition(vehicle: any, pt: GpsPoint, opts?: { activeTrip?: any }) {
  const fences = await geofencesFor(vehicle.businessId);
  const now = pt.ts;
  let spentStationaryS = 0;
  let lastMoveTs = now;
  const crumbs: GpsPoint[] = Array.isArray(vehicle.gpsBreadcrumbs) ? vehicle.gpsBreadcrumbs : [];
  for (let i = crumbs.length - 1; i > 0; i--) {
    const a = crumbs[i], b = crumbs[i - 1];
    const d = haversineKm(a.lat, a.lng, b.lat, b.lng);
    const dt = Number(a.ts) - Number(b.ts);
    if (d < 0.2) spentStationaryS += Math.max(0, dt); else lastMoveTs = Number(a.ts);
    if (now - lastMoveTs > 30 * 60) break;
  }
  const stationaryMin = Math.round(spentStationaryS / 60);

  // ── geofence enter/exit transitions (last crumb vs this point)
  for (const f of fences) {
    const wasIn = crumbs.length > 0 ? pointInGeofence(crumbs[crumbs.length - 1].lat, crumbs[crumbs.length - 1].lng, f) : false;
    const isIn = pointInGeofence(pt.lat, pt.lng, f);
    if (!wasIn && isIn && f.notifyOnEnter) {
      await recordViolation({
        businessId: Number(vehicle.businessId), branchCode: vehicle.branchCode ?? null, vehicleId: Number(vehicle.id), plate: vehicle.licensePlate || vehicle.name,
        tripId: opts?.activeTrip?.id ?? null, tripLabel: opts?.activeTrip ? `${opts.activeTrip.source ?? "?"} → ${opts.activeTrip.destination ?? "?"}` : null,
        kind: "GEOFENCE_ENTER", detail: `Vehicle entered geofence “${f.name}”`, lat: pt.lat, lng: pt.lng,
      });
    } else if (wasIn && !isIn && f.notifyOnExit) {
      await recordViolation({
        businessId: Number(vehicle.businessId), branchCode: vehicle.branchCode ?? null, vehicleId: Number(vehicle.id), plate: vehicle.licensePlate || vehicle.name,
        tripId: opts?.activeTrip?.id ?? null, tripLabel: opts?.activeTrip ? `${opts.activeTrip.source ?? "?"} → ${opts.activeTrip.destination ?? "?"}` : null,
        kind: "GEOFENCE_EXIT", detail: `Vehicle left geofence “${f.name}”`, lat: pt.lat, lng: pt.lng,
      });
    }
  }

  // ── speeding (per live point)
  const speedLimit = Number(process.env.TRANSPORT_SPEED_LIMIT_KMH || 90);
  if (pt.speed != null && Number(pt.speed) > speedLimit) {
    await recordViolation({
      businessId: Number(vehicle.businessId), branchCode: vehicle.branchCode ?? null, vehicleId: Number(vehicle.id), plate: vehicle.licensePlate || vehicle.name,
      tripId: opts?.activeTrip?.id ?? null, kind: "SPEEDING",
      detail: `${vehicle.licensePlate} at ${Number(pt.speed).toFixed(0)} km/h over the ${speedLimit} km/h limit`,
      lat: pt.lat, lng: pt.lng,
    });
  }

  // ── route deviation while en route (≥4 km from the corridor)
  if (opts?.activeTrip?.sourceLat != null && opts?.activeTrip?.sourceLng != null && opts?.activeTrip?.destLat != null && opts?.activeTrip?.destLng != null) {
    const off = deviationKm(pt.lat, pt.lng, { lat: Number(opts.activeTrip.sourceLat), lng: Number(opts.activeTrip.sourceLng) }, { lat: Number(opts.activeTrip.destLat), lng: Number(opts.activeTrip.destLng) });
    if (off >= 4) {
      await recordViolation({
        businessId: Number(vehicle.businessId), branchCode: vehicle.branchCode ?? null, vehicleId: Number(vehicle.id), plate: vehicle.licensePlate || vehicle.name,
        tripId: Number(opts.activeTrip.id), tripLabel: `${opts.activeTrip.source ?? "?"} → ${opts.activeTrip.destination ?? "?"}`,
        kind: "ROUTE_DEVIATION", detail: `${vehicle.licensePlate} is ${off.toFixed(1)} km off the expected route`, lat: pt.lat, lng: pt.lng,
      });
    }
  }

  // ── prolonged stop (> 45 min stationary with engine assumed on)
  if (stationaryMin >= 45) {
    await recordViolation({
      businessId: Number(vehicle.businessId), branchCode: vehicle.branchCode ?? null, vehicleId: Number(vehicle.id), plate: vehicle.licensePlate || vehicle.name,
      tripId: opts?.activeTrip?.id ?? null, kind: "PROLONGED_STOP",
      detail: `${vehicle.licensePlate} stationary for ~${stationaryMin} min`, lat: pt.lat, lng: pt.lng,
    });
  }

  // ── unauthorized movement (overnight movement while no active trip)
  const hour = new Date(now).getHours();
  const night = hour < 5 || hour >= 22;
  if (night && !opts?.activeTrip) {
    const moved15 = crumbs.slice(-6).some((a, i, arr) => i > 0 && haversineKm(arr[i - 1].lat, arr[i - 1].lng, a.lat, a.lng) > 0.3);
    if (moved15) {
      await recordViolation({
        businessId: Number(vehicle.businessId), branchCode: vehicle.branchCode ?? null, vehicleId: Number(vehicle.id), plate: vehicle.licensePlate || vehicle.name,
        kind: "UNAUTHORIZED_MOVEMENT", detail: `${vehicle.licensePlate} moving at ${String(hour).padStart(2, "0")}:00 with no trip logged`, lat: pt.lat, lng: pt.lng,
      });
    }
  }

  return { stationaryMin, activeTrip: !!opts?.activeTrip };
}

// ── Performance / utilization & fuel-efficiency rollups ─────────────────────
export function utilizationOf(trips: any[], fromDay: string, toDay: string, vehicleCount: number) {
  const inWin = trips.filter((t) => t.status === "COMPLETED" && t.createdAt && dayStr(t.createdAt) >= fromDay && dayStr(t.createdAt) <= toDay);
  const km = inWin.reduce((s, t) => s + Number(t.actualKm || 0), 0);
  const days = Math.max(1, ((new Date(toDay).getTime() - new Date(fromDay).getTime()) / 86_400_000) + 1);
  const daysBusy = new Set(inWin.map((t) => dayStr(t.createdAt))).size;
  return {
    completed: inWin.length,
    km, kmPerDay: Math.round((km / days) * 10) / 10,
    utilizationPct: vehicleCount > 0 ? Math.round((daysBusy / days) * 1000) / 10 : 0,
  };
}
export const dayStr = (d: any) => { try { const t = new Date(d); return t.toISOString().slice(0, 10); } catch { return String(d).slice(0, 10); } };

/** km/L from the last N fuel logs + odometer/GPS deltas; null when data is thin. */
export function fuelEconomyKmpl(logs: any[]): number | null {
  if (logs.length < 2) return null;
  const sorted = [...logs].sort((a, b) => Number(a.odometerKm || 0) - Number(b.odometerKm || 0));
  let km = 0; let liters = 0;
  for (let i = 1; i < sorted.length; i++) {
    const dk = Number(sorted[i].odometerKm || 0) - Number(sorted[i - 1].odometerKm || 0);
    const l = Number(sorted[i].quantityLiters || 0);
    if (dk > 0 && l > 0) { km += dk; liters += l; }
  }
  if (km < 20 || liters <= 0) return null;
  return Math.round((km / liters) * 100) / 100;
}

/** nightly batch — mark trackers offline when they stop reporting. Idempotent. */
export async function sweepOfflineTrackers(nowTs = Date.now()) {
  const cutoffMs = 3 * 60 * 60 * 1000; // 3 h without a point ⇒ OFFLINE
  const rows = await db.select().from(transportVehicles).where(eq(transportVehicles.gpsEnabled, true));
  for (const v of rows) {
    const last = v.gpsLastSeenTs ? new Date(v.gpsLastSeenTs).getTime() : 0;
    if (!last) continue;
    if (nowTs - last > cutoffMs && v.gpsHealth !== "OFFLINE") {
      await db.update(transportVehicles).set({ gpsHealth: "OFFLINE" }).where(eq(transportVehicles.id, v.id));
      await recordViolation({
        businessId: Number(v.businessId), branchCode: v.branchCode ?? null, vehicleId: Number(v.id), plate: v.licensePlate || v.name,
        kind: "TRACKER_OFFLINE", detail: `${v.licensePlate} tracker silent for ${(Math.round((nowTs - last) / 60000))} min`, lat: v.gpsLastLat ?? null, lng: v.gpsLastLng ?? null,
      });
    }
  }
}

