/** Fires a tagged transport violation so the family audit can read its recipients. */
import { db } from "@/db";
import { businesses, transportVehicles, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { recordViolation } from "@/lib/transport";
const TAG = process.argv[2] || "FINALAUD";
(async () => {
  const biz = (await db.select({ id: businesses.id, ownerId: businesses.ownerId }).from(businesses)
    .orderBy(businesses.id).limit(1))[0];
  const plate = `${TAG}-${Date.now().toString(36).toUpperCase().slice(-5)}`;
  const [v] = await db.insert(transportVehicles).values({
    businessId: Number(biz.id), ownerId: biz.ownerId == null ? null : Number(biz.ownerId),
    name: `${TAG} vehicle`, licensePlate: plate, make: "Probe", model: "Probe", status: "ACTIVE",
  } as any).returning();
  await recordViolation({ businessId: Number(biz.id), vehicleId: Number(v.id), plate,
    kind: "ROUTE_DEVIATION", detail: `${TAG} vehicle deviated from its route`,
    lat: 5.6, lng: -0.2 });
  await db.delete(transportVehicles).where(eq(transportVehicles.id, v.id));
  process.exit(0);
})().catch((e) => { console.error(e?.message || e); process.exit(0); });
