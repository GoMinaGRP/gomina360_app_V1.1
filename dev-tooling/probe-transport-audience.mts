/**
 * probe-transport-audience.mts — proves `notifyTransport` reaches the canonical
 * workspace audience, including a platform Super Admin who is NOT a member of
 * the tenant's organization (audit finding F-01).
 *
 * Before the fix, `notifyTransport` derived its audience from
 * `organization_members` directly, so that account received nothing at all:
 *
 *   notifyTransport inserted = { inserted: 3 } → recipients [2,1,3]
 *   probe super admin notified? NO
 *
 * Self-contained: it mints its own Super Admin, asserts, and removes
 * everything it created. Prints `RESULT: PASS` / `RESULT: FAIL …`.
 *
 *   npx tsx --tsconfig tsconfig.json dev-tooling/probe-transport-audience.mts
 */
import { db } from "@/db";
import { notifications, transportVehicles, businesses, users } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { notifyTransport } from "@/lib/transport";

(async () => {
  const biz = (await db.select({ id: businesses.id }).from(businesses).orderBy(businesses.id).limit(1))[0];
  const bizId = Number(biz.id);
  const stamp = Date.now().toString(36);
  const plate = `AUD-${stamp.toUpperCase().slice(-6)}`;

  // A platform account: no organization_members row, no assigned business.
  const pw = (await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, 2)).limit(1))[0];
  const [sa] = await db.insert(users).values({
    name: "Transport Probe Super Admin",
    email: `transportprobe.${stamp}@gomina360.test`,
    role: "OWNER", assignedBusinessId: null, phone: "+23355000099",
    passwordHash: pw?.h ?? null, isSuperAdmin: true, canViewFinance: true,
  } as any).returning();

  const ownerOrg = (await db.select({ ownerId: businesses.ownerId }).from(businesses)
    .where(eq(businesses.id, bizId)).limit(1))[0]?.ownerId ?? null;
  const [vehicle] = await db.insert(transportVehicles).values({
    businessId: bizId, ownerId: ownerOrg == null ? null : Number(ownerOrg),
    name: "Bell Audit Probe Vehicle",
    licensePlate: plate, make: "Probe", model: "Probe", status: "ACTIVE",
  } as any).returning();

  const res = await notifyTransport(bizId, {
    type: "TRANSPORT_UNAUTHORIZED_MOVEMENT",
    title: `[unauthorized movement] ${plate}`,
    body: "probe: vehicle moving outside an authorised window",
    recordType: "TRANSPORT_VEHICLE",
    recordId: Number(vehicle.id),
    recordRef: plate,
    actorName: "GPS monitor",
    priority: "CRITICAL",
  });

  const rows = await db.select({ userId: notifications.userId }).from(notifications)
    .where(and(eq(notifications.recordRef, plate), eq(notifications.type, "TRANSPORT_UNAUTHORIZED_MOVEMENT")));
  const ids = rows.map((r) => Number(r.userId));
  console.log(`inserted=${JSON.stringify(res)} recipients=${JSON.stringify(ids)} superAdmin=${sa.id}`);
  const ok = ids.includes(Number(sa.id));
  console.log(ok ? "RESULT: PASS" : "RESULT: FAIL — the platform Super Admin is blind to transport events");

  await db.delete(notifications).where(eq(notifications.recordRef, plate));
  await db.delete(transportVehicles).where(eq(transportVehicles.id, vehicle.id));
  await db.delete(users).where(eq(users.id, sa.id));
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("probe error:", e?.message || e);
  console.log("RESULT: FAIL — probe error");
  process.exit(1);
});