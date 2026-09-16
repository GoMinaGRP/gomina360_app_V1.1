import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  aiInsights,
  assets,
  businesses,
  customers,
  employees,
  inventoryItems,
  transactions,
  transportBookings,
  transportFuelLogs,
  transportGeofences,
  transportMaintenance,
  transportTrackerViolations,
  transportTrips,
  transportVehicleChecklists,
  transportVehicles,
} from "@/db/schema";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { ownerOrgOfBusiness } from "@/lib/notify";
import { computeStockStatus } from "@/lib/stock";
import {
  GPS_PROVIDER_LIBRARY,
  assertTransportBizAccess,
  dayStr,
  fuelEconomyKmpl,
  gpsProviderOf,
  notifyTransport,
  raiseTransportAi,
  sweepOfflineTrackers,
  utilizationOf,
  writeTransportTrail,
} from "@/lib/transport";

/**
 * Transportation & Haulage module API — single route (like the other module
 * routes) serving the entire pane of the Transportation dashboard:
 *   GET  ?businessId=N → vehicles, drivers(employees), trips, bookings, fuel,
 *        maintenance, checklists, geofences, violations, AI alerts, finance
 *        linkage (transactions for this unit), metrics (dashboard + reports).
 *   POST dispatch via `entity` + `action`, mirroring the same linkage rules
 *        the other modules document (finance, customers, inventory, assets,
 *        audit-trail) — every mutating write is org/business scoped server-side
 *        and lands in the immutable audit trail.
 *
 * Access: any signed-in user who may access the business (canAccessBusiness) —
 * branch-scoped users must belong to the unit; OWNER/Super-Admin unrestricted
 * inside their tenant. Tenant data never crosses organizations.
 */

const bad = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });
const num = (v: any, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const day = (v: any) => (v ? String(v).slice(0, 10) : new Date().toISOString().slice(0, 10));
const VEHICLE_STATUSES = ["ACTIVE", "MAINTENANCE", "OUT_OF_SERVICE"];
const VEHICLE_TYPES = ["TRUCK", "VAN", "PICKUP", "TRAILER", "BUS", "BIKE", "CAR"];
const VEHICLE_FUEL = ["PETROL", "DIESEL", "LPG", "EV"];
const MAINT_CATS = ["PREVENTIVE", "ENGINE", "BRAKES", "TYRES", "BATTERY", "ELECTRICAL", "SUSPENSION", "BODY", "INSPECTION", "OTHER"];

async function bookTransaction(
  biz: { id: number; code: string | null; name: string | null },
  type: "INCOME" | "EXPENSE",
  amount: number,
  category: string,
  description: string,
  paymentMethod: string,
  actor: any,
  refs?: { customerId?: number | null; supplierId?: number | null },
) {
  const now = new Date();
  const [row] = await db
    .insert(transactions)
    .values({
      transactionNumber: `TRX-${now.getFullYear()}-${now.getTime().toString().slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`,
      businessId: biz.id,
      branchCode: biz.code,
      branchName: biz.name,
      type,
      category,
      amountGhs: amount,
      paymentMethod: paymentMethod || "CASH",
      customerId: refs?.customerId ?? null,
      supplierId: refs?.supplierId ?? null,
      description,
      date: now.toISOString().split("T")[0],
      createdAt: now,
      status: "COMPLETED",
      recordedBy: actor?.name || "Transportation",
      recordedByRole: actor?.role || null,
      recordedByUserId: actor?.id ? Number(actor.id) : null,
    })
    .returning();
  return row;
}

/** Find-or-create a branch customer (same rule as the other modules). */
async function upsertCustomer(bizId: number, name: string, phone: string | null, spendGhs: number, orgOwnerId: number | null) {
  const rows = await db.select().from(customers).where(eq(customers.businessId, bizId));
  const match = rows.find((c) => phone && c.phone === phone) || rows.find((c) => (c.name || "").toLowerCase() === name.toLowerCase());
  if (match) {
    await db
      .update(customers)
      .set({
        totalSpentGhs: Math.round(((match.totalSpentGhs || 0) + spendGhs) * 100) / 100,
        loyaltyPoints: (match.loyaltyPoints || 0) + (spendGhs > 0 ? 1 : 0),
        phone: match.phone || phone || "—",
      })
      .where(eq(customers.id, match.id));
    return match.id;
  }
  const [created] = await db
    .insert(customers)
    .values({
      name,
      type: "RETAIL",
      phone: phone || "—",
      totalSpentGhs: Math.max(0, Math.round(spendGhs * 100) / 100),
      loyaltyPoints: spendGhs > 0 ? 1 : 0,
      businessId: bizId,
      ownerId: orgOwnerId,
    })
    .returning();
  return created?.id ?? null;
}

/** Auto-raise AI signals (maintenance overdue, compliance expiry, fuel
 *  anomaly). Idempotent via raiseTransportAi's NEW-title dup guard. */
async function scanTransportRisks(businessId: number) {
  const today = day(null);
  try {
    const [vehicles, maint, fuels] = await Promise.all([
      db.select().from(transportVehicles).where(eq(transportVehicles.businessId, businessId)),
      db.select().from(transportMaintenance).where(eq(transportMaintenance.businessId, businessId)),
      db.select().from(transportFuelLogs).where(eq(transportFuelLogs.businessId, businessId)).orderBy(desc(transportFuelLogs.id)).limit(200),
    ]);
    for (const v of vehicles) {
      const exp = [
        ["Insurance", v.insuranceExpiry],
        ["Roadworthy", v.roadworthyExpiry],
        ["Vehicle licence", v.licenseExpiry],
        ["Fitness", v.fitnessExpiry],
      ] as const;
      for (const [label, dstr] of exp) {
        if (!dstr) continue;
        const daysLeft = Math.floor((new Date(String(dstr)).getTime() - Date.now()) / 86_400_000);
        if (daysLeft < 0) {
          await raiseTransportAi({
            businessId, branchCode: v.branchCode ?? null,
            title: `${label} EXPIRED — ${v.licensePlate}`,
            category: "COMPLIANCE", impact: "CRITICAL",
            recommendation: `${label} for ${v.name} (${v.licensePlate}) expired on ${dstr}. Stop dispatching this vehicle until the document is renewed.`,
            metricAffected: "Transportation compliance",
          });
        } else if (daysLeft <= 14) {
          await raiseTransportAi({
            businessId, branchCode: v.branchCode ?? null,
            title: `${label} due in ${daysLeft}d — ${v.licensePlate}`,
            category: "COMPLIANCE", impact: daysLeft <= 7 ? "HIGH" : "MEDIUM",
            recommendation: `${label} for ${v.name} (${v.licensePlate}) expires ${dstr} (${daysLeft} days). Book the renewal now to avoid grounding the vehicle.`,
            metricAffected: "Transportation compliance",
          });
        }
      }
      const econ = fuelEconomyKmpl(fuels.filter((f) => Number(f.vehicleId) === Number(v.id)));
      if (econ != null && econ < 4) {
        await raiseTransportAi({
          businessId, branchCode: v.branchCode ?? null,
          title: `Poor fuel economy — ${v.licensePlate}`,
          category: "EFFICIENCY", impact: "MEDIUM",
          recommendation: `${v.name} (${v.licensePlate}) is averaging ${econ} km/L — well below the 4 km/L floor for this class. Inspect injectors/tyres and review driver idling habits.`,
          metricAffected: "Fuel spend",
        });
      }
    }
    for (const m of maint) {
      if (m.status === "DONE") continue;
      const overdue = m.dueDate && String(m.dueDate) < today;
      if (overdue) {
        const v = vehicles.find((x) => Number(x.id) === Number(m.vehicleId));
        await raiseTransportAi({
          businessId, branchCode: m.branchCode ?? null,
          title: `Maintenance overdue — ${v ? v.licensePlate : `vehicle #${m.vehicleId}`}`,
          category: "RISK", impact: "HIGH",
          recommendation: `“${m.title}” was due ${m.dueDate} and is still ${m.status}. Complete it or move the date; overdue servicing raises breakdown and insurance-denial risk.`,
          metricAffected: "Vehicle availability",
        });
      }
    }
  } catch (e) {
    console.error("transport risk scan warn:", e);
  }
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
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    if (!biz) return bad("Business not found", 404);

    // Lightweight housekeeping on read: off-line tracker sweep + AI risk scan.
    await sweepOfflineTrackers();
    await scanTransportRisks(businessId);

    const [vehicles, drivers, trips, bookings, fuels, maint, checks, fences, violations, txns, inv, insights] = await Promise.all([
      db.select().from(transportVehicles).where(eq(transportVehicles.businessId, businessId)).orderBy(desc(transportVehicles.id)),
      db.select().from(employees).where(eq(employees.businessId, businessId)).orderBy(desc(employees.id)),
      db.select().from(transportTrips).where(eq(transportTrips.businessId, businessId)).orderBy(desc(transportTrips.id)).limit(300),
      db.select().from(transportBookings).where(eq(transportBookings.businessId, businessId)).orderBy(desc(transportBookings.id)).limit(300),
      db.select().from(transportFuelLogs).where(eq(transportFuelLogs.businessId, businessId)).orderBy(desc(transportFuelLogs.id)).limit(300),
      db.select().from(transportMaintenance).where(eq(transportMaintenance.businessId, businessId)).orderBy(desc(transportMaintenance.id)).limit(300),
      db.select().from(transportVehicleChecklists).where(eq(transportVehicleChecklists.businessId, businessId)).orderBy(desc(transportVehicleChecklists.id)).limit(200),
      db.select().from(transportGeofences).where(eq(transportGeofences.businessId, businessId)).orderBy(desc(transportGeofences.id)),
      db.select().from(transportTrackerViolations).where(eq(transportTrackerViolations.businessId, businessId)).orderBy(desc(transportTrackerViolations.id)).limit(300),
      db.select().from(transactions).where(eq(transactions.businessId, businessId)).orderBy(desc(transactions.id)).limit(400),
      db.select().from(inventoryItems).where(eq(inventoryItems.businessId, businessId)),
      aiInsightsSafe(businessId),
    ]);

    const openViol = violations.filter((v) => v.status === "UNRESOLVED");
    const today = day(null);
    const rein = txns.filter((t) => t.type === "INCOME");
    const rexp = txns.filter((t) => t.type === "EXPENSE");
    const revTotal = rein.reduce((s, t) => s + Number(t.amountGhs || 0), 0);
    const fuelExp = rexp.filter((t) => String(t.category).startsWith("Transport Fuel")).reduce((s, t) => s + Number(t.amountGhs || 0), 0);
    const maintExp = rexp.filter((t) => String(t.category).startsWith("Transport Maintenance")).reduce((s, t) => s + Number(t.amountGhs || 0), 0);
    const expTotal = rexp.reduce((s, t) => s + Number(t.amountGhs || 0), 0);
    const tripsCompleted = trips.filter((t) => t.status === "COMPLETED");
    const tripsActive = trips.filter((t) => t.status === "EN_ROUTE");
    const util30 = utilizationOf(trips, day(new Date(Date.now() - 29 * 86400000)), today, Number(Math.max(1, vehicles.filter((v) => v.status !== "OUT_OF_SERVICE").length)));
    const byVehicle: Record<number, { km: number; trips: number; revenue: number; fuelGhs: number; maintGhs: number }> = {};
    for (const t of tripsCompleted) {
      if (!t.vehicleId) continue;
      (byVehicle[Number(t.vehicleId)] ||= { km: 0, trips: 0, revenue: 0, fuelGhs: 0, maintGhs: 0 });
      byVehicle[Number(t.vehicleId)].km += Number(t.actualKm || 0);
      byVehicle[Number(t.vehicleId)].trips += 1;
      byVehicle[Number(t.vehicleId)].revenue += Number(t.fareGhs || 0);
    }
    for (const f of fuels) if (f.vehicleId) (byVehicle[Number(f.vehicleId)] ||= { km: 0, trips: 0, revenue: 0, fuelGhs: 0, maintGhs: 0 }).fuelGhs += Number(f.totalGhs || 0);
    for (const m of maint) if (m.vehicleId && m.status === "DONE") (byVehicle[Number(m.vehicleId)] ||= { km: 0, trips: 0, revenue: 0, fuelGhs: 0, maintGhs: 0 }).maintGhs += Number(m.actualCostGhs || 0);

    const metrics = {
      fleetCount: vehicles.length,
      activeVehicles: vehicles.filter((v) => v.status === "ACTIVE").length,
      onTrip: tripsActive.length,
      bookingsPending: bookings.filter((b) => b.status === "PENDING").length,
      violationsOpen: openViol.length,
      violationsCritical: openViol.filter((v) => v.severity === "CRITICAL").length,
      trackersOnline: vehicles.filter((v) => v.gpsEnabled && v.gpsHealth === "ONLINE").length,
      trackersOffline: vehicles.filter((v) => v.gpsEnabled && v.gpsHealth === "OFFLINE").length,
      revenueGhs: Math.round(revTotal * 100) / 100,
      fuelSpendGhs: Math.round(fuelExp * 100) / 100,
      maintenanceSpendGhs: Math.round(maintExp * 100) / 100,
      expensesGhs: Math.round(expTotal * 100) / 100,
      profitGhs: Math.round((revTotal - expTotal) * 100) / 100,
      tripsCompleted: tripsCompleted.length,
      kmTotal: Math.round(tripsCompleted.reduce((s, t) => s + Number(t.actualKm || 0), 0) * 10) / 10,
      utilization30d: util30,
      todaysKm: Math.round(vehicles.reduce((s, v) => s + Number(v.gpsMileageTodayKm || 0), 0) * 10) / 10,
      fleetEconomyKmpl: fuelEconomyKmpl(fuels),
    };

    const strip = (v: any) => ({ ...v, gpsDeviceSecret: undefined });
    return NextResponse.json({
      success: true,
      business: { id: biz.id, name: biz.name, code: biz.code },
      vehicles: vehicles.map(strip),
      drivers,
      trips, bookings, fuelLogs: fuels, maintenance: maint, checklists: checks,
      geofences: fences,
      violations,
      transactions: txns,
      inventory: inv,
      insights,
      providers: GPS_PROVIDER_LIBRARY,
      metrics,
      utilizationByVehicle: byVehicle,
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}


async function aiInsightsSafe(businessId: number) {
  // transport-owned insights are categorized by source in metric_affected.
  const rows = await db.select().from(aiInsights).where(eq(aiInsights.businessId, businessId)).orderBy(desc(aiInsights.id)).limit(60);
  return rows.filter((r) => String(r.metricAffected || "").toLowerCase().includes("transport"));
}

// ══════════════════════ POST — all module mutations ════════════════════════
export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const body = await request.json();
    const businessId = Number(body.businessId);
    if (!businessId) return bad("businessId required");
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    if (!biz) return bad("Business not found", 404);
    if (!(await canAccessBusiness(user, businessId))) return FORBIDDEN("You do not have access to that business.");
    const ownerId = await ownerOrgOfBusiness(businessId);
    const actor = { id: user.id, name: user.name, role: user.role, orgId: ownerId };
    const entity = String(body.entity || "").toUpperCase();
    const action = String(body.action || "").toUpperCase();

    // ── VEHICLES ──────────────────────────────────────────────────────────
    if (entity === "VEHICLE") {
      if (action === "CREATE") {
        const name = String(body.name || "").trim();
        const plate = String(body.licensePlate || "").trim().toUpperCase();
        if (!name || !plate) return bad("Vehicle name and license plate are required.");
        const dup = await db.select().from(transportVehicles).where(and(eq(transportVehicles.businessId, businessId), eq(transportVehicles.licensePlate, plate)));
        if (dup.length > 0) return bad(`A vehicle with plate ${plate} already exists here.`);
        const vType = VEHICLE_TYPES.includes(String(body.vehicleType || "").toUpperCase()) ? String(body.vehicleType).toUpperCase() : "TRUCK";
        const fuel = VEHICLE_FUEL.includes(String(body.fuelType || "").toUpperCase()) ? String(body.fuelType).toUpperCase() : "DIESEL";
        const [v] = await db.insert(transportVehicles).values({
          businessId, branchCode: biz.code, ownerId,
          name, licensePlate: plate, vehicleType: vType, fuelType: fuel,
          make: body.make ? String(body.make) : null, model: body.model ? String(body.model) : null,
          year: body.year ? Number(body.year) : null, color: body.color ? String(body.color) : null,
          odometerKm: num(body.odometerKm, 0), loadCapacity: body.loadCapacity ? num(body.loadCapacity) : null,
          seats: body.seats ? Number(body.seats) : null,
          assignedEmployeeId: body.assignedEmployeeId ? Number(body.assignedEmployeeId) : null,
          defaultDriverName: body.defaultDriverName ? String(body.defaultDriverName) : null,
          insuranceCompany: body.insuranceCompany ? String(body.insuranceCompany) : null,
          insuranceExpiry: body.insuranceExpiry ? day(body.insuranceExpiry) : null,
          licenseExpiry: body.licenseExpiry ? day(body.licenseExpiry) : null,
          roadworthyExpiry: body.roadworthyExpiry ? day(body.roadworthyExpiry) : null,
          fitnessExpiry: body.fitnessExpiry ? day(body.fitnessExpiry) : null,
          notes: body.notes ? String(body.notes) : null,
          purchaseCostGhs: num(body.purchaseCostGhs, 0),
          purchaseDate: body.purchaseDate ? day(body.purchaseDate) : null,
          createdByUserId: user.id, createdByName: user.name, createdByRole: user.role, updatedAt: new Date(),
        }).returning();
        // Assets interlink — register the fleet unit as a VEHICLE asset so the
        // Assets module & value reports see it too (same business scope).
        try {
          const [ast] = await db.insert(assets).values({
            businessId, branchCode: biz.code || "HQ", branchName: biz.name || null,
            name: `${name} (${plate})`, assetType: "VEHICLE",
            condition: "GOOD", purchasePriceGhs: v.purchaseCostGhs || 0, currentValueGhs: v.purchaseCostGhs || 0,
            nextMaintenanceDate: dayStr(Date.now() + 90 * 86_400_000),
            location: biz.name || "HQ",
            registeredByUserId: user.id,
            recorderName: user.name,
            assetCode: `VEH-${String(plate).replace(/[^A-Z0-9]+/g, "")}`,
          }).returning();
          await db.update(transportVehicles).set({ assetId: ast.id }).where(eq(transportVehicles.id, v.id));
        } catch (e) {
          console.error("vehicle→asset link warn:", e);
        }
        await writeTransportTrail(actor, { action: "CREATE", targetType: "TRANSPORT", targetLabel: `Vehicle ${plate}`, recordType: "TRANSPORT_VEHICLE", recordId: v.id, businessId, branchCode: biz.code, detail: `${name} · ${vType} · ${fuel}` });
        return NextResponse.json({ success: true, vehicle: v });
      }
      if (action === "UPDATE" || action === "STATUS") {
        const id = Number(body.id);
        const [v] = await db.select().from(transportVehicles).where(and(eq(transportVehicles.id, id), eq(transportVehicles.businessId, businessId)));
        if (!v) return bad("Vehicle not found", 404);
        if (action === "STATUS") {
          const st = String(body.status || "").toUpperCase();
          if (!VEHICLE_STATUSES.includes(st)) return bad("Unknown vehicle status.");
          const [u] = await db.update(transportVehicles).set({ status: st, updatedAt: new Date() }).where(eq(transportVehicles.id, id)).returning();
          await writeTransportTrail(actor, { action: "STATUS_CHANGE", targetType: "TRANSPORT", targetLabel: `Vehicle ${v.licensePlate}`, recordType: "TRANSPORT_VEHICLE", recordId: id, businessId, branchCode: v.branchCode, detail: `${v.status} → ${st}` });
          return NextResponse.json({ success: true, vehicle: u });
        }
        if (body.licensePlate) {
          const plate = String(body.licensePlate).trim().toUpperCase();
          const dup = await db.select().from(transportVehicles).where(and(eq(transportVehicles.businessId, businessId), eq(transportVehicles.licensePlate, plate)));
          if (dup.some((d) => d.id !== id)) return bad(`Plate ${plate} is already used by another vehicle here.`);
        }
        const upd: any = { updatedAt: new Date() };
        for (const k of ["name", "make", "model", "color", "notes", "insuranceCompany"]) if (body[k] !== undefined) upd[k] = body[k] == null ? null : String(body[k]);
        if (body.licensePlate !== undefined) upd.licensePlate = String(body.licensePlate).toUpperCase();
        for (const k of ["insuranceExpiry", "licenseExpiry", "roadworthyExpiry", "fitnessExpiry", "purchaseDate"]) if (body[k] !== undefined) upd[k] = body[k] ? day(body[k]) : null;
        for (const k of ["year", "seats", "assignedEmployeeId"]) if (body[k] !== undefined) upd[k] = body[k] ? Number(body[k]) : null;
        for (const k of ["odometerKm", "loadCapacity", "purchaseCostGhs"]) if (body[k] !== undefined) upd[k] = num(body[k]);
        if (body.defaultDriverName !== undefined) upd.defaultDriverName = body.defaultDriverName ? String(body.defaultDriverName) : null;
        const [u] = await db.update(transportVehicles).set(upd).where(eq(transportVehicles.id, id)).returning();
        await writeTransportTrail(actor, { action: "UPDATE", targetType: "TRANSPORT", targetLabel: `Vehicle ${u.licensePlate}`, recordType: "TRANSPORT_VEHICLE", recordId: id, businessId, branchCode: u.branchCode, detail: Object.keys(upd).filter((k) => k !== "updatedAt").join(", ") });
        return NextResponse.json({ success: true, vehicle: u });
      }
      return bad("Unknown vehicle action.");
    }

    // ── TRIPS & ROUTES ───────────────────────────────────────────────────
    if (entity === "TRIP") {
      if (action === "CREATE") {
        const vehicleId = body.vehicleId ? Number(body.vehicleId) : null;
        if (vehicleId) {
          const [veh] = await db.select().from(transportVehicles).where(and(eq(transportVehicles.id, vehicleId), eq(transportVehicles.businessId, businessId)));
          if (!veh) return bad("That vehicle is not in this business.", 404);
          if (veh.status === "OUT_OF_SERVICE") return bad(`${veh.licensePlate} is out of service — it cannot be dispatched.`);
        }
        let driverName = body.driverName ? String(body.driverName) : null;
        const driverEmployeeId = body.driverEmployeeId ? Number(body.driverEmployeeId) : null;
        if (driverEmployeeId) {
          const [emp] = await db.select().from(employees).where(and(eq(employees.id, driverEmployeeId), eq(employees.businessId, businessId)));
          if (!emp) return bad("Driver is not an employee of this business.", 404);
          driverName = driverName || emp.name;
        }
        const status = ["PLANNED", "EN_ROUTE"].includes(String(body.status || "").toUpperCase()) ? String(body.status).toUpperCase() : "PLANNED";
        const [v0] = vehicleId ? await db.select().from(transportVehicles).where(eq(transportVehicles.id, vehicleId)) : [null];
        const [trip] = await db.insert(transportTrips).values({
          businessId, branchCode: biz.code, ownerId,
          vehicleId, driverEmployeeId, driverName,
          status,
          purpose: body.purpose ? String(body.purpose).toUpperCase() : "DELIVERY",
          source: body.source ? String(body.source) : null,
          destination: body.destination ? String(body.destination) : null,
          startTs: body.startTs ? new Date(String(body.startTs)) : status === "EN_ROUTE" ? new Date() : null,
          startOdometerKm: vehicleId && v0 ? Number(v0.odometerKm || 0) : (body.startOdometerKm != null ? num(body.startOdometerKm) : null),
          expectedKm: body.expectedKm != null ? num(body.expectedKm) : null,
          cargo: body.cargo ? String(body.cargo) : null,
          notes: body.notes ? String(body.notes) : null,
          customerId: body.customerId ? Number(body.customerId) : null,
          bookingId: body.bookingId ? Number(body.bookingId) : null,
          fareGhs: num(body.fareGhs, 0),
          gpsStarted: status === "EN_ROUTE",
          gpsRoute: [], gpsDistanceKm: 0,
          createdByUserId: user.id, createdByName: user.name, createdByRole: user.role,
        }).returning();
        if (status === "EN_ROUTE" && vehicleId && v0) {
          if (v0.status !== "ACTIVE") {
            await db.delete(transportTrips).where(eq(transportTrips.id, trip.id));
            return bad(`Cannot dispatch ${v0.licensePlate} — it is ${v0.status.toLowerCase().replace(/_/g, " ")}.`);
          }
        }
        if (trip.bookingId) {
          await db.update(transportBookings).set({ tripId: trip.id, vehicleId: vehicleId ?? null, status: status === "EN_ROUTE" ? "IN_PROGRESS" : "CONFIRMED" }).where(eq(transportBookings.id, Number(trip.bookingId)));
        }
        await writeTransportTrail(actor, { action: "CREATE", targetType: "TRANSPORT", targetLabel: `Trip ${trip.source || "?"} → ${trip.destination || "?"}`, recordType: "TRANSPORT_TRIP", recordId: trip.id, businessId, branchCode: biz.code, detail: `status ${status}${driverName ? ` · driver ${driverName}` : ""}` });
        return NextResponse.json({ success: true, trip });
      }
      if (action === "START") {
        const id = Number(body.id);
        const [t] = await db.select().from(transportTrips).where(and(eq(transportTrips.id, id), eq(transportTrips.businessId, businessId)));
        if (!t) return bad("Trip not found", 404);
        if (t.status !== "PLANNED") return bad(`Trip is ${t.status} — only planned trips can start.`);
        if (t.vehicleId) {
          const [veh] = await db.select().from(transportVehicles).where(eq(transportVehicles.id, Number(t.vehicleId)));
          if (veh && veh.status !== "ACTIVE") return bad(`${veh.licensePlate} is ${veh.status.toLowerCase()} — cannot start the trip.`);
        }
        const [u] = await db.update(transportTrips).set({ status: "EN_ROUTE", startTs: new Date(), gpsStarted: true }).where(eq(transportTrips.id, id)).returning();
        if (t.bookingId) await db.update(transportBookings).set({ status: "IN_PROGRESS" }).where(eq(transportBookings.id, Number(t.bookingId)));
        await writeTransportTrail(actor, { action: "UPDATE", targetType: "TRANSPORT", targetLabel: `Trip #${id} started`, recordType: "TRANSPORT_TRIP", recordId: id, businessId, branchCode: t.branchCode, detail: `${t.source || "?"} → ${t.destination || "?"}` });
        return NextResponse.json({ success: true, trip: u });
      }
      if (action === "COMPLETE") {
        const id = Number(body.id);
        const [t] = await db.select().from(transportTrips).where(and(eq(transportTrips.id, id), eq(transportTrips.businessId, businessId)));
        if (!t) return bad("Trip not found", 404);
        if (t.status === "COMPLETED" || t.status === "CANCELLED") return bad(`Trip is already ${t.status}.`);
        const endOdo = body.endOdometerKm != null ? num(body.endOdometerKm) : (t.vehicleId ? Number(((await db.select().from(transportVehicles).where(eq(transportVehicles.id, Number(t.vehicleId))))[0] || { odometerKm: 0 }).odometerKm || 0) : null);
        const startOdo = t.startOdometerKm != null ? Number(t.startOdometerKm) : endOdo;
        const odoKm = endOdo != null && startOdo != null ? Math.max(0, endOdo - startOdo) : 0;
        const gpsKm = Number(t.gpsDistanceKm || 0);
        const actualKm = Math.round(Math.max(odoKm, gpsKm, num(body.actualKm, 0)) * 100) / 100;
        const [u] = await db.update(transportTrips).set({
          status: "COMPLETED",
          endTs: new Date(), completedAt: new Date(),
          endOdometerKm: endOdo ?? null,
          actualKm,
          gpsCompletedTs: new Date(),
        }).where(eq(transportTrips.id, id)).returning();
        if (t.vehicleId) {
          const vehUpd: any = { status: "ACTIVE", updatedAt: new Date() };
          if (endOdo != null && Number.isFinite(endOdo)) vehUpd.odometerKm = Math.max(0, endOdo);
          await db.update(transportVehicles).set(vehUpd).where(eq(transportVehicles.id, Number(t.vehicleId)));
        }
        await writeTransportTrail(actor, { action: "UPDATE", targetType: "TRANSPORT", targetLabel: `Trip #${id} completed`, recordType: "TRANSPORT_TRIP", recordId: id, businessId, branchCode: t.branchCode, reason: null, detail: `${actualKm} km · fare GH₵ ${u.fareGhs}` });
        return NextResponse.json({ success: true, trip: u, actualKm });
      }
      if (action === "CANCEL") {
        const id = Number(body.id);
        const [t] = await db.select().from(transportTrips).where(and(eq(transportTrips.id, id), eq(transportTrips.businessId, businessId)));
        if (!t) return bad("Trip not found", 404);
        if (t.status === "COMPLETED") return bad("Completed trips cannot be cancelled.");
        const [u] = await db.update(transportTrips).set({ status: "CANCELLED", endTs: new Date() }).where(eq(transportTrips.id, id)).returning();
        if (t.bookingId) {
          await db.update(transportBookings).set({ status: "CONFIRMED", tripId: null }).where(eq(transportBookings.id, Number(t.bookingId)));
        }
        await writeTransportTrail(actor, { action: "UPDATE", targetType: "TRANSPORT", targetLabel: `Trip #${id} cancelled`, recordType: "TRANSPORT_TRIP", recordId: id, businessId, branchCode: t.branchCode });
        return NextResponse.json({ success: true, trip: u });
      }
      return bad("Unknown trip action.");
    }

    // ── BOOKINGS / ORDERS ─────────────────────────────────────────────────
    if (entity === "BOOKING") {
      if (action === "CREATE") {
        const customerName = String(body.customerName || "").trim();
        if (!customerName) return bad("Customer name is required.");
        const [b] = await db.insert(transportBookings).values({
          businessId, branchCode: biz.code, ownerId,
          customerName, customerPhone: body.customerPhone ? String(body.customerPhone) : null,
          customerId: body.customerId ? Number(body.customerId) : null,
          status: "PENDING",
          cargo: body.cargo ? String(body.cargo) : null,
          passengers: body.passengers ? Number(body.passengers) : 0,
          origin: body.origin ? String(body.origin) : null,
          destination: body.destination ? String(body.destination) : null,
          scheduledFor: body.scheduledFor ? new Date(String(body.scheduledFor)) : null,
          fareGhs: num(body.fareGhs, 0),
          depositGhs: num(body.depositGhs, 0),
          vehicleId: body.vehicleId ? Number(body.vehicleId) : null,
          notes: body.notes ? String(body.notes) : null,
          createdByUserId: user.id, createdByName: user.name, createdByRole: user.role,
        }).returning();
        const custId = await upsertCustomer(businessId, customerName, b.customerPhone, 0, ownerId);
        await db.update(transportBookings).set({ customerId: custId }).where(eq(transportBookings.id, b.id));
        await writeTransportTrail(actor, { action: "CREATE", targetType: "TRANSPORT", targetLabel: `Booking ${b.customerName}`, recordType: "TRANSPORT_BOOKING", recordId: b.id, businessId, branchCode: biz.code, detail: `${b.origin || "?"} → ${b.destination || "?"} · GH₵ ${b.fareGhs}` });
        return NextResponse.json({ success: true, booking: { ...b, customerId: custId } });
      }
      const id = Number(body.id);
      const [bk] = await db.select().from(transportBookings).where(and(eq(transportBookings.id, id), eq(transportBookings.businessId, businessId)));
      if (!bk) return bad("Booking not found", 404);
      if (action === "CONFIRM") {
        if (bk.status !== "PENDING") return bad(`Booking is ${bk.status}.`);
        const [u] = await db.update(transportBookings).set({ status: "CONFIRMED" }).where(eq(transportBookings.id, id)).returning();
        await writeTransportTrail(actor, { action: "UPDATE", targetType: "TRANSPORT", targetLabel: `Booking #${id} confirmed`, recordType: "TRANSPORT_BOOKING", recordId: id, businessId, branchCode: bk.branchCode });
        return NextResponse.json({ success: true, booking: u });
      }
      if (action === "DISPATCH") {
        if (!["PENDING", "CONFIRMED"].includes(bk.status)) return bad(`Booking is ${bk.status}.`);
        const vehicleId = body.vehicleId ? Number(body.vehicleId) : (bk.vehicleId ?? null);
        const res = await createTripForBooking(biz, bk, actor, ownerId, vehicleId, body);
        if (res.error) return bad(res.error);
        return NextResponse.json({ success: true, booking: res.booking, trip: res.trip });
      }
      if (action === "COMPLETE") {
        if (!["CONFIRMED", "IN_PROGRESS"].includes(bk.status)) return bad(`Booking is ${bk.status} — only confirmed/dispatched bookings can complete.`);
        const fare = Number(bk.fareGhs || 0);
        const txn = await bookTransaction(
          { id: biz.id, code: biz.code, name: biz.name },
          "INCOME", fare, "Transport Booking",
          `Transport booking #${id} — ${bk.customerName} · ${bk.origin || "?"} → ${bk.destination || "?"}${bk.cargo ? ` · ${bk.cargo}` : ""}`,
          String(body.paymentMethod || "CASH"),
          actor, { customerId: bk.customerId },
        );
        if (bk.customerId && fare > 0) {
          const rows = await db.select().from(customers).where(eq(customers.id, Number(bk.customerId)));
          if (rows[0]) {
            await db.update(customers).set({
              totalSpentGhs: Math.round((Number(rows[0].totalSpentGhs || 0) + fare) * 100) / 100,
              loyaltyPoints: (rows[0].loyaltyPoints || 0) + 1,
            }).where(eq(customers.id, Number(bk.customerId)));
          }
        }
        const [u] = await db.update(transportBookings).set({ status: "COMPLETED", completedAt: new Date() }).where(eq(transportBookings.id, id)).returning();
        await writeTransportTrail(actor, { action: "CREATE", targetType: "TRANSPORT", targetLabel: `Booking #${id} completed`, recordType: "TRANSPORT_BOOKING", recordId: id, businessId, branchCode: bk.branchCode, detail: `INCOME GH₵ ${fare} · txn ${txn.transactionNumber}` });
        return NextResponse.json({ success: true, booking: u, transaction: txn });
      }
      if (action === "CANCEL") {
        if (bk.status === "COMPLETED") return bad("Completed bookings cannot be cancelled.");
        if (bk.tripId) {
          const [t] = await db.select().from(transportTrips).where(eq(transportTrips.id, Number(bk.tripId)));
          if (t && t.status === "EN_ROUTE") return bad("Booking is in transit — complete the trip or cancel the trip first.");
        }
        const [u] = await db.update(transportBookings).set({ status: "CANCELLED", cancelledReason: body.reason ? String(body.reason) : null }).where(eq(transportBookings.id, id)).returning();
        await writeTransportTrail(actor, { action: "UPDATE", targetType: "TRANSPORT", targetLabel: `Booking #${id} cancelled`, recordType: "TRANSPORT_BOOKING", recordId: id, businessId, branchCode: bk.branchCode, reason: u.cancelledReason || null });
        return NextResponse.json({ success: true, booking: u });
      }
      return bad("Unknown booking action.");
    }

    // ── FUEL ──────────────────────────────────────────────────────────────
    if (entity === "FUEL") {
      if (action !== "LOG") return bad("Unknown fuel action.");
      const vehicleId = Number(body.vehicleId);
      const liters = num(body.quantityLiters, -1);
      const ppl = num(body.pricePerLiterGhs, -1);
      if (!vehicleId || liters <= 0 || ppl < 0) return bad("Vehicle, liters and price-per-liter are required.");
      const [veh] = await db.select().from(transportVehicles).where(and(eq(transportVehicles.id, vehicleId), eq(transportVehicles.businessId, businessId)));
      if (!veh) return bad("Vehicle not in this business.", 404);
      const odo = num(body.odometerKm, Number(veh.odometerKm || 0));
      if (odo < Number(veh.odometerKm || 0)) return bad(`Odometer cannot go backwards (current ${veh.odometerKm} km).`);
      const total = Math.round(liters * ppl * 100) / 100;
      const [log] = await db.insert(transportFuelLogs).values({
        businessId, branchCode: biz.code, ownerId,
        vehicleId, driverEmployeeId: body.driverEmployeeId ? Number(body.driverEmployeeId) : null,
        odometerKm: odo, quantityLiters: liters, pricePerLiterGhs: ppl, totalGhs: total,
        fuelType: VEHICLE_FUEL.includes(String(body.fuelType || veh.fuelType || "").toUpperCase()) ? String(body.fuelType || veh.fuelType).toUpperCase() : "DIESEL",
        station: body.station ? String(body.station) : null,
        notes: body.notes ? String(body.notes) : null,
        loggedDate: day(body.loggedDate || null),
        loggedAt: new Date(), createdByName: user.name, createdByRole: user.role,
      }).returning();
      await db.update(transportVehicles).set({ odometerKm: odo, updatedAt: new Date() }).where(eq(transportVehicles.id, vehicleId));
      const txn = await bookTransaction(
        { id: biz.id, code: biz.code, name: biz.name },
        "EXPENSE", total, "Transport Fuel",
        `Fuel ${liters}L @ GH₵ ${ppl}/L — ${veh.licensePlate}${body.station ? ` · ${body.station}` : ""} (odo ${odo.toLocaleString()} km)`,
        String(body.paymentMethod || "CASH"), actor,
        { supplierId: body.supplierId ? Number(body.supplierId) : null },
      );
      await writeTransportTrail(actor, { action: "CREATE", targetType: "TRANSPORT", targetLabel: `Fuel ${veh.licensePlate} ${liters}L`, recordType: "TRANSPORT_FUEL", recordId: log.id, businessId, branchCode: biz.code, detail: `GH₵ ${total} · txn ${txn.transactionNumber}` });
      return NextResponse.json({ success: true, fuelLog: log, transaction: txn });
    }

    // ── MAINTENANCE & REPAIRS ─────────────────────────────────────────────
    if (entity === "MAINTENANCE") {
      if (action === "CREATE") {
        const vehicleId = Number(body.vehicleId);
        const title = String(body.title || "").trim();
        if (!vehicleId || !title) return bad("Vehicle and a maintenance title are required.");
        const [veh] = await db.select().from(transportVehicles).where(and(eq(transportVehicles.id, vehicleId), eq(transportVehicles.businessId, businessId)));
        if (!veh) return bad("Vehicle not in this business.", 404);
        const cat = MAINT_CATS.includes(String(body.category || "").toUpperCase()) ? String(body.category).toUpperCase() : "PREVENTIVE";
        const [m] = await db.insert(transportMaintenance).values({
          businessId, branchCode: biz.code, ownerId,
          vehicleId, category: cat, status: "DUE", title,
          description: body.description ? String(body.description) : null,
          vendorName: body.vendorName ? String(body.vendorName) : null,
          odometerKm: body.odometerKm != null ? num(body.odometerKm) : Number(veh.odometerKm || 0),
          estimatedCostGhs: num(body.estimatedCostGhs, 0),
          dueDate: body.dueDate ? day(body.dueDate) : null,
          nextDueOdometerKm: body.nextDueOdometerKm != null ? num(body.nextDueOdometerKm) : null,
          nextDueDate: body.nextDueDate ? day(body.nextDueDate) : null,
          notes: body.notes ? String(body.notes) : null,
          createdByName: user.name, createdByRole: user.role,
        }).returning();
        await writeTransportTrail(actor, { action: "CREATE", targetType: "TRANSPORT", targetLabel: `Maint ${veh.licensePlate} · ${title}`, recordType: "TRANSPORT_MAINTENANCE", recordId: m.id, businessId, branchCode: biz.code, detail: `${cat}${m.dueDate ? ` · due ${m.dueDate}` : ""}` });
        return NextResponse.json({ success: true, maintenance: m });
      }
      const id = Number(body.id);
      const [m] = await db.select().from(transportMaintenance).where(and(eq(transportMaintenance.id, id), eq(transportMaintenance.businessId, businessId)));
      if (!m) return bad("Maintenance record not found.", 404);
      const [veh] = await db.select().from(transportVehicles).where(eq(transportVehicles.id, Number(m.vehicleId)));
      if (action === "START") {
        if (m.status !== "DUE") return bad(`Maintenance is ${m.status}.`);
        const [u] = await db.update(transportMaintenance).set({ status: "IN_PROGRESS" }).where(eq(transportMaintenance.id, id)).returning();
        if (veh) await db.update(transportVehicles).set({ status: "MAINTENANCE", updatedAt: new Date() }).where(eq(transportVehicles.id, veh.id));
        await writeTransportTrail(actor, { action: "UPDATE", targetType: "TRANSPORT", targetLabel: `Maint #${id} started`, recordType: "TRANSPORT_MAINTENANCE", recordId: id, businessId, branchCode: m.branchCode });
        return NextResponse.json({ success: true, maintenance: u });
      }
      if (action === "DONE") {
        if (m.status === "DONE") return bad("Maintenance is already done.");
        const cost = num(body.actualCostGhs, Number(m.estimatedCostGhs || 0));
        const txn = cost > 0 ? await bookTransaction(
          { id: biz.id, code: biz.code, name: biz.name },
          "EXPENSE", cost, "Transport Maintenance",
          `${m.category.toLowerCase()} — ${m.title}${veh ? ` · ${veh.licensePlate}` : ""}${m.vendorName ? ` · ${m.vendorName}` : ""}`,
          String(body.paymentMethod || "CASH"), actor,
        ) : null;
        const [u] = await db.update(transportMaintenance).set({
          status: "DONE", actualCostGhs: cost, doneDate: day(body.doneDate || null),
          nextDueDate: body.nextDueDate ? day(body.nextDueDate) : m.nextDueDate,
          nextDueOdometerKm: body.nextDueOdometerKm != null ? num(body.nextDueOdometerKm) : m.nextDueOdometerKm,
        }).where(eq(transportMaintenance.id, id)).returning();
        if (veh) {
          await db.update(transportVehicles).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(transportVehicles.id, veh.id));
        }
        // Optional parts usage from inventory (stock OUT).
        if (body.inventoryItemId && body.quantityUsed) {
          const invId = Number(body.inventoryItemId); const qty = num(body.quantityUsed, 0);
          if (qty > 0) {
            const [inv] = await db.select().from(inventoryItems).where(and(eq(inventoryItems.id, invId), eq(inventoryItems.businessId, businessId)));
            if (inv) {
              const q = Math.max(0, Number((Number(inv.quantity || 0) - qty).toFixed(4)));
              await db.update(inventoryItems).set({ quantity: q, status: computeStockStatus(q, inv.minStockThreshold || 0) }).where(eq(inventoryItems.id, inv.id));
            }
          }
        }
        await writeTransportTrail(actor, { action: "UPDATE", targetType: "TRANSPORT", targetLabel: `Maint #${id} done`, recordType: "TRANSPORT_MAINTENANCE", recordId: id, businessId, branchCode: m.branchCode, detail: `GH₵ ${cost}${txn ? ` · txn ${txn.transactionNumber}` : ""}` });
        return NextResponse.json({ success: true, maintenance: u, transaction: txn });
      }
      if (action === "UPDATE") {
        const upd: any = {};
        for (const k of ["title", "description", "vendorName", "notes"]) if (body[k] !== undefined) upd[k] = body[k] == null ? null : String(body[k]);
        for (const k of ["dueDate", "nextDueDate"]) if (body[k] !== undefined) upd[k] = body[k] ? day(body[k]) : null;
        for (const k of ["estimatedCostGhs", "nextDueOdometerKm"]) if (body[k] !== undefined) upd[k] = num(body[k]);
        if (body.category !== undefined && MAINT_CATS.includes(String(body.category).toUpperCase())) upd.category = String(body.category).toUpperCase();
        const [u] = await db.update(transportMaintenance).set(upd).where(eq(transportMaintenance.id, id)).returning();
        await writeTransportTrail(actor, { action: "UPDATE", targetType: "TRANSPORT", targetLabel: `Maint #${id} updated`, recordType: "TRANSPORT_MAINTENANCE", recordId: id, businessId, branchCode: m.branchCode });
        return NextResponse.json({ success: true, maintenance: u });
      }
      return bad("Unknown maintenance action.");
    }

    // ── DAILY CHECKLIST & NOTES ───────────────────────────────────────────
    if (entity === "CHECKLIST") {
      if (action !== "SUBMIT") return bad("Unknown checklist action.");
      const vehicleId = Number(body.vehicleId);
      const [veh] = await db.select().from(transportVehicles).where(and(eq(transportVehicles.id, vehicleId), eq(transportVehicles.businessId, businessId)));
      if (!veh) return bad("Vehicle not in this business.", 404);
      const odo = num(body.odometerKm, Number(veh.odometerKm || 0));
      const bool = (k: string) => body[k] === true || body[k] === "true";
      const [row] = await db.insert(transportVehicleChecklists).values({
        businessId, branchCode: biz.code, ownerId,
        vehicleId, tripId: body.tripId ? Number(body.tripId) : null,
        shiftDate: day(body.shiftDate || null), odometerKm: odo,
        fuelLevelPct: body.fuelLevelPct != null ? Math.min(100, Math.max(0, Number(body.fuelLevelPct))) : null,
        lightsOk: bool("lightsOk"), brakesOk: bool("brakesOk"), tyresOk: bool("tyresOk"), oilOk: bool("oilOk"),
        coolantOk: bool("coolantOk"), beltsOk: bool("beltsOk"), mirrorsOk: bool("mirrorsOk"), hornOk: bool("hornOk"),
        fireExtinguisherOk: bool("fireExtinguisherOk"), firstAidOk: bool("firstAidOk"),
        documentationOk: bool("documentationOk"), cleaningOk: bool("cleaningOk"),
        notes: body.notes ? String(body.notes) : null,
        photo: body.photo && String(body.photo).startsWith("data:image/") ? String(body.photo) : null,
        userName: user.name, userRole: user.role,
        employeeId: body.employeeId ? Number(body.employeeId) : null,
      }).returning();
      if (odo > Number(veh.odometerKm || 0)) {
        await db.update(transportVehicles).set({ odometerKm: odo, updatedAt: new Date() }).where(eq(transportVehicles.id, vehicleId));
      }
      const fails = ["brakesOk", "lightsOk", "tyresOk", "oilOk"].filter((k) => !bool(k));
      if (fails.length > 0) {
        await raiseTransportAi({
          businessId, branchCode: biz.code ?? null,
          title: `Checklist failures — ${veh.licensePlate}`,
          category: "RISK", impact: "HIGH",
          recommendation: `Daily checklist for ${veh.licensePlate} failed: ${fails.join(", ").replace(/Ok/g, "")}. Ground the vehicle until a mechanic signs off.`,
          metricAffected: "Vehicle safety",
        });
      }
      await writeTransportTrail(actor, { action: "CREATE", targetType: "TRANSPORT", targetLabel: `Checklist ${veh.licensePlate} ${row.shiftDate}`, recordType: "TRANSPORT_CHECKLIST", recordId: row.id, businessId, branchCode: biz.code, detail: fails.length ? `FAILED ${fails.join(",")}` : "all checks passed" });
      return NextResponse.json({ success: true, checklist: row });
    }

    return bad("Unknown entity. Use VEHICLE|TRIP|BOOKING|FUEL|MAINTENANCE|CHECKLIST.");
  } catch (e: any) {
    console.error("transport POST error:", e);
    return NextResponse.json({ success: false, error: e.message || "Server error" }, { status: 500 });
  }
}

/** Booking → trip handoff (dispatch). */
async function createTripForBooking(biz: any, bk: any, actor: any, ownerId: number | null, vehicleId: number | null, body: any) {
  if (vehicleId) {
    const [veh] = await db.select().from(transportVehicles).where(and(eq(transportVehicles.id, vehicleId), eq(transportVehicles.businessId, biz.id)));
    if (!veh || veh.status !== "ACTIVE") return { error: veh ? `Vehicle ${veh.licensePlate} is ${veh.status.toLowerCase()}.` : "Vehicle not found." };
  }
  const driverEmployeeId = body.driverEmployeeId ? Number(body.driverEmployeeId) : null;
  let driverName = body.driverName ? String(body.driverName) : null;
  if (driverEmployeeId) {
    const [emp] = await db.select().from(employees).where(and(eq(employees.id, driverEmployeeId), eq(employees.businessId, biz.id)));
    driverName = emp?.name || driverName;
  }
  const tripRes = await db.insert(transportTrips).values({
    businessId: biz.id, branchCode: biz.code, ownerId,
    vehicleId, driverEmployeeId, driverName,
    status: "EN_ROUTE",
    purpose: "DELIVERY",
    source: bk.origin, destination: bk.destination,
    startTs: new Date(),
    cargo: bk.cargo, customerId: bk.customerId, bookingId: bk.id,
    fareGhs: bk.fareGhs, gpsStarted: true,
    gpsRoute: [], gpsDistanceKm: 0,
    createdByUserId: actor.id, createdByName: actor.name, createdByRole: actor.role,
  }).returning();
  const trip = tripRes[0];
  const [booking] = await db.update(transportBookings).set({ status: "IN_PROGRESS", tripId: trip.id, vehicleId: vehicleId ?? null }).where(eq(transportBookings.id, bk.id)).returning();
  await writeTransportTrail(actor, { action: "UPDATE", targetType: "TRANSPORT", targetLabel: `Booking #${bk.id} dispatched (trip #${trip.id})`, recordType: "TRANSPORT_BOOKING", recordId: bk.id, businessId: biz.id, branchCode: bk.branchCode });
  return { booking, trip };
}

// ── GEOFENCES + VIOLATIONS live here too (fewer routes, same module) ─────
export async function PATCH(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const body = await request.json();
    const businessId = Number(body.businessId);
    const [biz] = businessId ? await db.select().from(businesses).where(eq(businesses.id, businessId)) : [];
    if (!biz) return bad("Business not found", 404);
    if (!(await canAccessBusiness(user, businessId))) return FORBIDDEN("You do not have access to that business.");
    const ownerId = await ownerOrgOfBusiness(businessId);
    const actor = { id: user.id, name: user.name, role: user.role, orgId: ownerId };
    const entity = String(body.entity || "").toUpperCase();
    const action = String(body.action || "").toUpperCase();

    if (entity === "GEOFENCE") {
      if (action === "CREATE") {
        const name = String(body.name || "").trim();
        if (!name) return bad("Geofence name is required.");
        const kind = String(body.kind || "CIRCLE").toUpperCase() === "POLYGON" ? "POLYGON" : "CIRCLE";
        if (kind === "CIRCLE" && (body.lat == null || body.lng == null || !num(body.radiusM, 0))) return bad("Circle geofences need lat/lng and radius metres.");
        const [g] = await db.insert(transportGeofences).values({
          businessId, branchCode: biz.code, ownerId, name, kind,
          lat: body.lat != null ? num(body.lat) : null, lng: body.lng != null ? num(body.lng) : null,
          radiusM: body.radiusM != null ? Number(body.radiusM) : null,
          polygon: Array.isArray(body.polygon) ? body.polygon : null,
          notifyOnEnter: body.notifyOnEnter !== false, notifyOnExit: body.notifyOnExit !== false,
          active: true, createdByName: user.name, createdByRole: user.role,
        }).returning();
        await writeTransportTrail(actor, { action: "CREATE", targetType: "TRANSPORT", targetLabel: `Geofence ${name}`, recordType: "TRANSPORT_GEOFENCE", recordId: g.id, businessId, branchCode: biz.code });
        return NextResponse.json({ success: true, geofence: g });
      }
      if (action === "TOGGLE") {
        const id = Number(body.id);
        const [g] = await db.select().from(transportGeofences).where(and(eq(transportGeofences.id, id), eq(transportGeofences.businessId, businessId)));
        if (!g) return bad("Geofence not found", 404);
        const [u] = await db.update(transportGeofences).set({ active: !g.active }).where(eq(transportGeofences.id, id)).returning();
        return NextResponse.json({ success: true, geofence: u });
      }
      return bad("Unknown geofence action.");
    }

    if (entity === "VIOLATION") {
      const id = Number(body.id);
      const [v] = await db.select().from(transportTrackerViolations).where(and(eq(transportTrackerViolations.id, id), eq(transportTrackerViolations.businessId, businessId)));
      if (!v) return bad("Violation not found", 404);
      if (action === "ACKNOWLEDGE" || action === "RESOLVE") {
        const [u] = await db.update(transportTrackerViolations).set({
          status: action === "ACKNOWLEDGE" ? "ACKNOWLEDGED" : "RESOLVED",
          resolvedAt: action === "RESOLVE" ? new Date() : v.resolvedAt,
          resolvedByName: user.name, resolutionNote: body.note ? String(body.note) : v.resolutionNote,
        }).where(eq(transportTrackerViolations.id, id)).returning();
        await writeTransportTrail(actor, { action: "RESOLVE", targetType: "TRANSPORT", targetLabel: `Violation ${v.kind} — ${v.vehiclePlate}`, recordType: "TRANSPORT_VIOLATION", recordId: id, businessId, branchCode: v.branchCode, reason: body.note ? String(body.note) : null });
        return NextResponse.json({ success: true, violation: u });
      }
      return bad("Unknown violation action.");
    }

    return bad("Unknown entity for PATCH.");
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}

