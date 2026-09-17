import { NextResponse } from "next/server";
import { db } from "@/db";
import { businesses, inventoryItems, serviceAreas, pickupLocations, organizations, fulfillmentMethods, fulfillmentOptions } from "@/db/schema";
import { asc, eq, gt, inArray, and } from "drizzle-orm";
import { ttlGet, ttlSet } from "@/lib/ttlCache";

/**
 * PUBLIC online-ordering menu — NO login required.
 *
 * Every active business/branch with sellable stock: product name, category,
 * unit, selling price, live availability. Deliberately excludes cost prices,
 * margins, thresholds and any internal fields. Photos are passed through
 * when the branch registered one.
 *
 * Performance: the catalog is identical for every customer and expensive to
 * build, so it is cached server-side for a few seconds and invalidated by
 * every inventory/business write. Checkout always re-validates stock, so a
 * couple of seconds of catalog staleness can never oversell.
 */
const MENU_CACHE_KEY = "menu:v1";
const MENU_TTL_MS = 10_000;

export async function GET() {
  try {
    const cached = ttlGet<any>(MENU_CACHE_KEY);
    if (cached !== undefined) {
      return NextResponse.json(
        { success: true, businesses: cached },
        { headers: { "Cache-Control": "no-store", "X-Menu-Cache": "hit" } },
      );
    }
    const [bizRows, itemRows, areaRows, pickupRows, orgRows] = await Promise.all([
      db.select().from(businesses).orderBy(asc(businesses.id)),
      // Every catalogue row — including OUT_OF_STOCK products that carry an
      // active pre-order option (that is the whole point of pre-orders: sell
      // goods before they arrive). The per-product `sellable` gate below
      // still drops zero-stock items with NO option, so nothing extra leaks.
      db
        .select()
        .from(inventoryItems)
        .orderBy(asc(inventoryItems.name)),
      db.select().from(serviceAreas).where(eq(serviceAreas.active, true)),
      db.select().from(pickupLocations).where(eq(pickupLocations.active, true)),
      db.select().from(organizations),
    ]);

    const invHasStock = (i: any) => (i.quantity || 0) > 0 && i.status !== "OUT_OF_STOCK";
    // Pre-order options for the whole catalog (ACTIVE only, method ACTIVE
    // only) — scoped to units whose OWNER switched pre-orders ON, and the
    // catalogue is org-scoped, so no other tenant's options leak.
    const preorderBizIds = new Set(bizRows.filter((b: any) => b.preOrderEnabled === true).map((b: any) => Number(b.id)));
    const invIdsAll = itemRows.map((i) => i.id);
    const optsRows = invIdsAll.length
      ? await db.select().from(fulfillmentOptions).where(inArray(fulfillmentOptions.inventoryId, invIdsAll))
      : [];
    const activeOpts = optsRows.filter((o) => o.active && preorderBizIds.has(Number(o.businessId)));
    const methodIds = [...new Set(activeOpts.map((o) => o.methodId))];
    const methods = methodIds.length
      ? await db.select().from(fulfillmentMethods).where(inArray(fulfillmentMethods.id, methodIds))
      : [];
    const methodById = new Map(methods.filter((m) => m.active).map((m) => [m.id, m]));
    const optsByInventory = new Map<number, any[]>();
    for (const o of activeOpts) {
      const m = methodById.get(o.methodId);
      if (!m) continue;
      // exposure rule: option resolves only for the business it was written for.
      if (!itemRows.some((i) => i.id === o.inventoryId)) continue;
      const depositPerUnit =
        o.depositType === "PERCENT"
          ? Math.round((((o.priceGhs || 0) * (Number(o.depositValue) || 0)) / 100) * 100) / 100
          : o.depositType === "FIXED"
            ? Math.min(o.priceGhs || 0, Number(o.depositValue) || 0)
            : 0;
      const list = optsByInventory.get(o.inventoryId) || [];
      list.push({ ...o, methodKey: m.key, methodLabel: m.label, icon: m.icon, requiresPin: m.requiresPin, depositPerUnit });
      optsByInventory.set(o.inventoryId, list);
    }

    // Shared centralized marketplace across ALL participating organizations.
    // A SUSPENDED organization never trades publicly — its branches vanish
    // from the marketplace (platform-level kill switch).
    const orgById = new Map(orgRows.map((o) => [Number(o.id), o]));

    const result = [];
    for (const b of bizRows) {
      const org = b.ownerId != null ? orgById.get(Number(b.ownerId)) : undefined;
      if (org && (org.status || "").toUpperCase() !== "ACTIVE") continue;
      // Only ACTIVE / EXPANDING units trade publicly — MAINTENANCE and
      // INACTIVE are hidden from the storefront (and refused at checkout).
      if (!["ACTIVE", "EXPANDING"].includes((b.status || "").toUpperCase())) continue;
      // Units the OWNER / authorized staff switched OFF for online ordering
      // never reach the customer storefront at all.
      if (b.onlineOrderingEnabled === false) continue;
      const products = itemRows
        .filter((i) => i.businessId === b.id)
        .map((i) => {
          // Every image registered for the product — the primary `photo` plus
          // any extra shots in the `photos` array — exposed so the customer
          // storefront can render an Amazon-style gallery (main image,
          // thumbnails, click-to-preview, next/previous). Never cost prices,
          // margins or other internal fields.
          const gallery = Array.isArray(i.photos) && i.photos.length > 0
            ? i.photos.filter((p: any) => typeof p === "string" && p.length > 0)
            : [];
          const allPhotos: string[] = [];
          if (typeof i.photo === "string" && i.photo.length > 0) allPhotos.push(i.photo);
          for (const p of gallery) if (!allPhotos.includes(p)) allPhotos.push(p);
          const opts = optsByInventory.get(i.id) || [];
          const sellable = invHasStock(i) || opts.length > 0;
          if (!sellable) return null;
          return {
            id: i.id,
            sku: i.sku,
            name: i.name,
            category: i.category,
            unit: i.unit,
            price: i.sellingPriceGhs,
            available: Math.max(0, Math.floor(i.quantity)),
            inStock: invHasStock(i),
            photo: i.photo || null,
            photos: allPhotos,
            // Seller-configured pre-order fulfilment options (price / ETA /
            // deposit shown next to the product on the storefront). Empty for
            // stock-only products — the UI then renders nothing extra.
            preorderOptions: opts.map((o: any) => ({
              id: o.id,
              methodKey: o.methodKey,
              methodLabel: o.methodLabel,
              icon: o.icon,
              priceGhs: o.priceGhs,
              leadMinDays: o.leadMinDays,
              leadMaxDays: o.leadMaxDays,
              depositType: o.depositType,
              depositValue: o.depositValue,
              depositGhsUnit: o.depositPerUnit,
              termsKey: o.termsKey,
              requiresAddress: o.requiresAddress,
              requiresPin: o.requiresPin,
              capacityPerPeriod: o.capacityPerPeriod,
            })),
          };
        })
        .filter((p: any) => p != null);
      if (products.length === 0) continue;
      result.push({
        businessId: b.id,
        businessName: b.name,
        preOrderEnabled: b.preOrderEnabled === true,
        businessCode: b.code,
        // D1 — centralized shared marketplace with seller attribution:
        // each listing is attributed to the Owner/Organization that runs the
        // branch (products/orders route to that Owner's org internally).
        organizationId: org?.id ?? null,
        organizationName: org?.name ?? null,
        organizationSlug: org?.slug ?? null,
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

    ttlSet(MENU_CACHE_KEY, result, MENU_TTL_MS);
    return NextResponse.json(
      { success: true, businesses: result },
      { headers: { "Cache-Control": "no-store", "X-Menu-Cache": "miss" } },
    );
  } catch (error: any) {
    console.error("GET /api/menu error:", error);
    return NextResponse.json({ success: false, error: "Could not load the menu." }, { status: 500 });
  }
}
