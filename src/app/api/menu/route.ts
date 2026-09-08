import { NextResponse } from "next/server";
import { db } from "@/db";
import { businesses, inventoryItems, serviceAreas, pickupLocations } from "@/db/schema";
import { asc, eq, gt, ne, and } from "drizzle-orm";

/**
 * PUBLIC online-ordering menu — NO login required.
 *
 * Every active business/branch with sellable stock: product name, category,
 * unit, selling price, live availability. Deliberately excludes cost prices,
 * margins, thresholds and any internal fields. Photos are passed through
 * when the branch registered one.
 */
export async function GET() {
  try {
    const [bizRows, itemRows, areaRows, pickupRows] = await Promise.all([
      db.select().from(businesses).orderBy(asc(businesses.id)),
      db
        .select()
        .from(inventoryItems)
        .where(and(gt(inventoryItems.quantity, 0), ne(inventoryItems.status, "OUT_OF_STOCK")))
        .orderBy(asc(inventoryItems.name)),
      db.select().from(serviceAreas).where(eq(serviceAreas.active, true)),
      db.select().from(pickupLocations).where(eq(pickupLocations.active, true)),
    ]);

    const result = [];
    for (const b of bizRows) {
      // Only ACTIVE / EXPANDING units trade publicly — MAINTENANCE and
      // INACTIVE are hidden from the storefront (and refused at checkout).
      if (!["ACTIVE", "EXPANDING"].includes((b.status || "").toUpperCase())) continue;
      // Units the OWNER / authorized staff switched OFF for online ordering
      // never reach the customer storefront at all.
      if (b.onlineOrderingEnabled === false) continue;
      const products = itemRows
        .filter((i) => i.businessId === b.id)
        .map((i) => ({
          id: i.id,
          sku: i.sku,
          name: i.name,
          category: i.category,
          unit: i.unit,
          price: i.sellingPriceGhs,
          available: Math.max(0, Math.floor(i.quantity)),
          photo: i.photo || null,
        }));
      if (products.length === 0) continue;
      result.push({
        businessId: b.id,
        businessName: b.name,
        businessCode: b.code,
        // Branch identity — the storefront unit the order is linked to
        // (Business → Branch → Products → Orders → Delivery → Tracking).
        branchCode: b.code,
        category: b.category,
        branchName: b.branchLocation,
        contactPhone: b.contactPhone || null,
        // Public shop coordinates — the customer's pickup point, and the
        // storefront's starting centre for the delivery map. (Never any
        // customer data.)
        gpsLat: b.gpsLat ?? null,
        gpsLng: b.gpsLng ?? null,
        // Service area & fulfilment switches — drive the storefront's
        // "serving my location" Google-Maps filter and the pickup/delivery
        // options shown to the customer.
        serviceRadiusKm: b.serviceRadiusKm ?? null,
        serviceNote: b.serviceNote || null,
        pickupEnabled: b.pickupEnabled !== false,
        deliveryEnabled: b.deliveryEnabled !== false,
        // This unit's own service areas / localities (each branch defines its
        // own list) and its pickup points — drive the storefront's "serving
        // my location" filter and the PICKUP checkout chooser.
        serviceAreas: areaRows
          .filter((a) => a.businessId === b.id)
          .map((a) => ({
            id: a.id,
            name: a.name,
            centerLat: a.centerLat ?? null,
            centerLng: a.centerLng ?? null,
            radiusKm: a.radiusKm ?? null,
            note: a.note || null,
          })),
        pickupLocations: pickupRows
          .filter((p) => p.businessId === b.id)
          .map((p) => ({
            id: p.id,
            name: p.name,
            address: p.address || null,
            lat: p.lat ?? null,
            lng: p.lng ?? null,
            instructions: p.instructions || null,
          })),
        // Customer-facing help & payment contacts (post-order + /track).
        customerHelpPhone: b.customerHelpPhone || null,
        momoNumber: b.momoNumber || null,
        momoName: b.momoName || null,
        products,
      });
    }

    return NextResponse.json(
      { success: true, businesses: result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error: any) {
    console.error("GET /api/menu error:", error);
    return NextResponse.json({ success: false, error: "Could not load the menu." }, { status: 500 });
  }
}
