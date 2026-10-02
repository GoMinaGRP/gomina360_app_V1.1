import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db } from "@/db";
import { businesses, inventoryItems, inventoryVariants, serviceAreas, pickupLocations, organizations, fulfillmentMethods, fulfillmentOptions } from "@/db/schema";
import { asc, eq, inArray, and } from "drizzle-orm";
import { ttlGet, ttlSet } from "@/lib/ttlCache";
import { compressJsonBody } from "@/lib/httpGzip";
import { storefrontVariants } from "@/lib/boutique";

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
// Cache key shares the app-wide "init" prefix so EVERY mutating route (all
// of them invalidate "init" by convention — sales, orders, inventory,
// service-areas, pickup points, businesses…) also flushes this snapshot.
// A standalone "menu:*" key would stay stale for up to MENU_TTL_MS after
// any write.
const MENU_CACHE_KEY = "init:menu:v1";
const MENU_TTL_MS = 10_000;
/** Browser/CDN freshness — the server TTL cache (10 s, invalidated on every
 *  inventory/business write) is the source of truth; browsers may serve the
 *  catalog up to 5 s stale and revalidate for another 30 s. Checkout always
 *  re-validates stock server-side, so a short CDN window can never oversell. */
const MENU_CLIENT_CACHE = "public, max-age=5, stale-while-revalidate=30";

type MenuSnapshot = { body: string; etag: string };

function snapshotOf(catalog: unknown): MenuSnapshot {
  const body = JSON.stringify({ success: true, businesses: catalog });
  const etag = `"menu-${createHash("sha1").update(body).digest("base64url").slice(0, 20)}"`;
  return { body, etag };
}

function menuResponse(request: Request, snap: MenuSnapshot, cacheMark: "hit" | "miss", ifNoneMatch: string | null) {
  const extraHeaders: Record<string, string> = {
    "Cache-Control": MENU_CLIENT_CACHE,
    ETag: snap.etag,
    "X-Menu-Cache": cacheMark,
  };
  if (ifNoneMatch && ifNoneMatch === snap.etag) {
    return new Response(null, { status: 304, headers: { ...extraHeaders, "Content-Type": "application/json" } });
  }
  const compressed = compressJsonBody(request, snap.body, extraHeaders);
  const bodyInit: BodyInit =
    typeof compressed.body === "string" ? compressed.body : new Uint8Array(compressed.body);
  return new Response(bodyInit, { status: 200, headers: compressed.headers });
}

export async function GET(request: Request) {
  try {
    const ifNoneMatch = request.headers.get("if-none-match");
    const cached = ttlGet<MenuSnapshot>(MENU_CACHE_KEY);
    if (cached !== undefined) {
      return menuResponse(request, cached, "hit", ifNoneMatch);
    }
    const [rawBizRows, orgRows] = await Promise.all([
      db
        .select({
          id: businesses.id,
          name: businesses.name,
          code: businesses.code,
          category: businesses.category,
          branchLocation: businesses.branchLocation,
          contactPhone: businesses.contactPhone,
          status: businesses.status,
          logo: businesses.logo,
          gpsLat: businesses.gpsLat,
          gpsLng: businesses.gpsLng,
          onlineOrderingEnabled: businesses.onlineOrderingEnabled,
          preOrderEnabled: businesses.preOrderEnabled,
          pickupEnabled: businesses.pickupEnabled,
          deliveryEnabled: businesses.deliveryEnabled,
          serviceRadiusKm: businesses.serviceRadiusKm,
          serviceNote: businesses.serviceNote,
          customerHelpPhone: businesses.customerHelpPhone,
          momoNumber: businesses.momoNumber,
          momoName: businesses.momoName,
          watermarkEnabled: businesses.watermarkEnabled,
          watermarkMode: businesses.watermarkMode,
          ownerId: businesses.ownerId,
        })
        .from(businesses)
        .orderBy(asc(businesses.id)),
      db
        .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, status: organizations.status })
        .from(organizations),
    ]);

    // Shared centralized marketplace across ALL participating organizations.
    // A SUSPENDED organization never trades publicly — its branches vanish
    // from the marketplace (platform-level kill switch).  Filter branches
    // before reading product/photo rows so inactive tenants and offline units
    // do not force large inventory/photo payloads across the DB connection.
    const orgById = new Map(orgRows.map((o) => [Number(o.id), o]));
    const bizRows = rawBizRows.filter((b: any) => {
      const org = b.ownerId != null ? orgById.get(Number(b.ownerId)) : undefined;
      if (org && (org.status || "").toUpperCase() !== "ACTIVE") return false;
      if (!["ACTIVE", "EXPANDING"].includes((b.status || "").toUpperCase())) return false;
      if (b.onlineOrderingEnabled === false) return false;
      return true;
    });
    const publicBizIds = bizRows.map((b: any) => Number(b.id)).filter(Number.isFinite);
    if (publicBizIds.length === 0) {
      const snap = snapshotOf([]);
      ttlSet(MENU_CACHE_KEY, snap, MENU_TTL_MS);
      return menuResponse(request, snap, "miss", ifNoneMatch);
    }

    const [itemRows, variantRows, areaRows, pickupRows, optsRows, methodsRows] = await Promise.all([
      db
        .select({
          id: inventoryItems.id,
          sku: inventoryItems.sku,
          businessId: inventoryItems.businessId,
          name: inventoryItems.name,
          category: inventoryItems.category,
          quantity: inventoryItems.quantity,
          unit: inventoryItems.unit,
          sellingPriceGhs: inventoryItems.sellingPriceGhs,
          status: inventoryItems.status,
          photo: inventoryItems.photo,
          photos: inventoryItems.photos,
          description: inventoryItems.description,
          brand: inventoryItems.brand,
          model: inventoryItems.model,
          specifications: inventoryItems.specifications,
          variants: inventoryItems.variants,
        })
        .from(inventoryItems)
        .where(inArray(inventoryItems.businessId, publicBizIds))
        .orderBy(asc(inventoryItems.name)),
      db
        .select({
          id: inventoryVariants.id,
          inventoryId: inventoryVariants.inventoryId,
          size: inventoryVariants.size,
          color: inventoryVariants.color,
          sizeSystem: inventoryVariants.sizeSystem,
          sku: inventoryVariants.sku,
          quantity: inventoryVariants.quantity,
          minStockThreshold: inventoryVariants.minStockThreshold,
          status: inventoryVariants.status,
          isActive: inventoryVariants.isActive,
          sortOrder: inventoryVariants.sortOrder,
        })
        .from(inventoryVariants)
        .where(and(eq(inventoryVariants.isActive, true), inArray(inventoryVariants.businessId, publicBizIds)))
        .orderBy(asc(inventoryVariants.sortOrder), asc(inventoryVariants.id)),
      db
        .select({
          id: serviceAreas.id,
          businessId: serviceAreas.businessId,
          name: serviceAreas.name,
          centerLat: serviceAreas.centerLat,
          centerLng: serviceAreas.centerLng,
          radiusKm: serviceAreas.radiusKm,
          note: serviceAreas.note,
        })
        .from(serviceAreas)
        .where(and(eq(serviceAreas.active, true), inArray(serviceAreas.businessId, publicBizIds))),
      db
        .select({
          id: pickupLocations.id,
          businessId: pickupLocations.businessId,
          name: pickupLocations.name,
          address: pickupLocations.address,
          lat: pickupLocations.lat,
          lng: pickupLocations.lng,
          instructions: pickupLocations.instructions,
        })
        .from(pickupLocations)
        .where(and(eq(pickupLocations.active, true), inArray(pickupLocations.businessId, publicBizIds))),
      db
        .select({
          id: fulfillmentOptions.id,
          inventoryId: fulfillmentOptions.inventoryId,
          methodId: fulfillmentOptions.methodId,
          businessId: fulfillmentOptions.businessId,
          priceGhs: fulfillmentOptions.priceGhs,
          leadMinDays: fulfillmentOptions.leadMinDays,
          leadMaxDays: fulfillmentOptions.leadMaxDays,
          depositType: fulfillmentOptions.depositType,
          depositValue: fulfillmentOptions.depositValue,
          termsKey: fulfillmentOptions.termsKey,
          capacityPerPeriod: fulfillmentOptions.capacityPerPeriod,
          requiresAddress: fulfillmentOptions.requiresAddress,
          active: fulfillmentOptions.active,
        })
        .from(fulfillmentOptions)
        .where(and(eq(fulfillmentOptions.active, true), inArray(fulfillmentOptions.businessId, publicBizIds))),
      db
        .select({
          id: fulfillmentMethods.id,
          label: fulfillmentMethods.label,
          key: fulfillmentMethods.key,
          icon: fulfillmentMethods.icon,
          requiresPin: fulfillmentMethods.requiresPin,
          active: fulfillmentMethods.active,
        })
        .from(fulfillmentMethods)
        .where(eq(fulfillmentMethods.active, true)),
    ]);

    const invHasStock = (i: any) => (i.quantity || 0) > 0 && i.status !== "OUT_OF_STOCK";
    // Pre-order options for the whole catalog (ACTIVE only, method ACTIVE
    // only) — scoped to units whose OWNER switched pre-orders ON, and the
    // catalogue is org-scoped, so no other tenant's options leak.
    const preorderBizIds = new Set(bizRows.filter((b: any) => b.preOrderEnabled === true).map((b: any) => Number(b.id)));
    const activeOpts = optsRows.filter((o) => o.active && preorderBizIds.has(Number(o.businessId)));
    const itemIds = new Set(itemRows.map((i) => Number(i.id)));
    const methodById = new Map(methodsRows.filter((m) => m.active).map((m) => [m.id, m]));
    const optsByInventory = new Map<number, any[]>();
    const itemsByBiz = new Map<number, any[]>();
    for (const item of itemRows) {
      const bid = Number(item.businessId);
      const list = itemsByBiz.get(bid) || [];
      list.push(item);
      itemsByBiz.set(bid, list);
    }
    const areasByBiz = new Map<number, any[]>();
    for (const area of areaRows) {
      const bid = Number(area.businessId);
      const list = areasByBiz.get(bid) || [];
      list.push(area);
      areasByBiz.set(bid, list);
    }
    const pickupsByBiz = new Map<number, any[]>();
    for (const point of pickupRows) {
      const bid = Number(point.businessId);
      const list = pickupsByBiz.get(bid) || [];
      list.push(point);
      pickupsByBiz.set(bid, list);
    }
    // Boutique / apparel variant layer: active SIZE × COLOUR rows grouped per
    // item. Items without rows keep their legacy shape exactly (no new keys).
    const variantsByItem = new Map<number, any[]>();
    for (const v of variantRows as any[]) {
      const list = variantsByItem.get(Number(v.inventoryId)) || [];
      list.push(v);
      variantsByItem.set(Number(v.inventoryId), list);
    }
    for (const o of activeOpts) {
      const m = methodById.get(o.methodId);
      if (!m) continue;
      // exposure rule: option resolves only for a product in a public branch.
      if (!itemIds.has(Number(o.inventoryId))) continue;
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

    const result = [];
    for (const b of bizRows) {
      const org = b.ownerId != null ? orgById.get(Number(b.ownerId)) : undefined;
      const products = (itemsByBiz.get(Number(b.id)) || [])
        .map((i) => {
          // Per-variant availability for Boutique items — the storefront
          // renders these sizes/colours and disables the out-of-stock combos.
          const itemVariantRows = variantsByItem.get(Number(i.id)) || [];
          const vProjection = itemVariantRows.length > 0 ? storefrontVariants(itemVariantRows as any) : null;
          // Every registered product image remains available to the storefront,
          // but large uploaded data URLs are exposed as cacheable image URLs
          // instead of being inlined into the JSON catalogue.  This keeps
          // /api/menu small while preserving galleries, thumbnails and zoom.
          const gallery = Array.isArray(i.photos) && i.photos.length > 0
            ? i.photos.filter((p: any) => typeof p === "string" && p.length > 0)
            : [];
          const allPhotos: string[] = [];
          if (typeof i.photo === "string" && i.photo.length > 0) allPhotos.push(i.photo);
          for (const p of gallery) if (!allPhotos.includes(p)) allPhotos.push(p);
          const photoUrls = allPhotos.map((_photo, index) => `/api/menu/photo?item=${encodeURIComponent(String(i.id))}&index=${index}`);
          const opts = optsByInventory.get(i.id) || [];
          const variantAvailable = vProjection ? vProjection.totalAvailable : null;
          const sellable = (variantAvailable != null ? variantAvailable > 0 : invHasStock(i)) || opts.length > 0;
          if (!sellable) return null;
          return {
            id: i.id,
            sku: i.sku,
            name: i.name,
            category: i.category,
            unit: i.unit,
            price: i.sellingPriceGhs,
            available: Math.max(0, Math.floor(variantAvailable != null ? variantAvailable : i.quantity)),
            inStock: variantAvailable != null ? variantAvailable > 0 : invHasStock(i),
            // Boutique variant projection (only present for variant items):
            //   hasVariants + variantOptions.{sizes,colors,variants,totalAvailable}
            // The order page requires a size/colour choice for these products
            // and the server re-validates the chosen variant at checkout.
            ...(vProjection
              ? {
                  hasVariants: true,
                  variantOptions: {
                    sizes: vProjection.sizes,
                    colors: vProjection.colors,
                    variants: vProjection.variants,
                    totalAvailable: vProjection.totalAvailable,
                  },
                }
              : {}),
            photo: photoUrls[0] || null,
            photos: photoUrls,
            // Product catalogue details registered at stock-in — shown on the
            // storefront product view verbatim (no duplicate entry anywhere).
            description: i.description || null,
            brand: i.brand || null,
            model: i.model || null,
            specifications: Array.isArray(i.specifications) ? i.specifications : [],
            // Legacy display chips: for variant items the registered matrix
            // becomes the chip list (with live stock notes) so the lightbox
            // shows real availability instead of a stale display-only list.
            variants: vProjection
              ? vProjection.variants.slice(0, 60).map((v) => ({
                  name: [v.size ? `Size ${v.size}` : null, v.color || null].filter(Boolean).join(" · ") || "Standard",
                  note: v.inStock ? `${v.available} left` : "out of stock",
                }))
              : Array.isArray(i.variants)
                ? i.variants
                : [],
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
        // Storefront watermark preferences — the store UI composites a faint
        // logo/name overlay over product photos at display time (originals
        // never modified). Logo ships ONLY when watermarking is enabled so
        // disabled units keep the menu payload lean (a logo can be a large
        // data-URL).
        watermarkEnabled: b.watermarkEnabled === true,
        watermarkMode: b.watermarkMode || "AUTO",
        ...(b.watermarkEnabled === true ? { logo: b.logo || null } : {}),
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
        serviceAreas: (areasByBiz.get(Number(b.id)) || [])
          .map((a) => ({
            id: a.id,
            name: a.name,
            centerLat: a.centerLat ?? null,
            centerLng: a.centerLng ?? null,
            radiusKm: a.radiusKm ?? null,
            note: a.note || null,
          })),
        pickupLocations: (pickupsByBiz.get(Number(b.id)) || [])
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

    const snap = snapshotOf(result);
    ttlSet(MENU_CACHE_KEY, snap, MENU_TTL_MS);
    return menuResponse(request, snap, "miss", ifNoneMatch);
  } catch (error: any) {
    console.error("GET /api/menu error:", error);
    return NextResponse.json({ success: false, error: "Could not load the menu." }, { status: 500 });
  }
}
