import { throttle, clientIp } from "@/lib/rateLimit";
import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import { customerTrackings, businesses, inventoryItems, serviceAreas, pickupLocations, organizations } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import {
  uniqueTrackingCode,
  linkCrmCustomer,
  notifyOnlineOrder,
  normalizeDeliveryPin,
} from "@/lib/trackingServer";
import { googleMapsLink, businessServesLocation, haversineM } from "@/lib/tracking";
import { validatePhone, PHONE_EXACT_DIGITS_STOREFRONT } from "@/lib/phone";
import { buildPreorderSnapshot, optionDepositPerUnit, orderKindFor, resolvePreorders } from "@/lib/preorder";

/**
 * PUBLIC online checkout — customers order WITHOUT logging in.
 *
 * Prices and availability are ALWAYS re-derived server-side from live
 * inventory (client numbers are never trusted). The order lands as an
 * ONLINE tracking (status RECEIVED, payment UNPAID or PENDING_CONFIRMATION),
 * chain-linked to Business → Branch → Customer → Product → Payment →
 * Delivery, and the branch team + owner get a bell notification. The
 * customer gets back their unique GM-* tracking code for the public /track
 * page — their only key to this order.
 */
export async function POST(request: NextRequest) {
  // Orders decrement stock — refresh the short-lived public catalog cache.
  ttlInvalidate("menu");
  ttlInvalidate("init");
  // M7: IP-level throttle — public order spam / stock probing. Generous cap:
  // a family on shared wifi can each still retry a failed checkout.
  const limited = throttle(clientIp(request), { key: "order", limit: 30, windowMs: 60_000 });
  if (limited) return limited;
  try {
    const body = await request.json();
    const businessId = Number(body.businessId);
    if (!businessId) {
      return NextResponse.json({ success: false, error: "Choose a business to order from." }, { status: 400 });
    }
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    // Only ACTIVE / EXPANDING units trade publicly (mirrors /api/menu).
    if (!biz || !["ACTIVE", "EXPANDING"].includes((biz.status || "").toUpperCase())) {
      return NextResponse.json({ success: false, error: "That business is not taking online orders." }, { status: 404 });
    }
    // Platform kill switch: a suspended organization never takes online orders.
    if (biz.ownerId != null) {
      const [owningOrg] = await db
        .select({ status: organizations.status })
        .from(organizations)
        .where(eq(organizations.id, Number(biz.ownerId)));
      if (owningOrg && (owningOrg.status || "").toUpperCase() !== "ACTIVE") {
        return NextResponse.json({ success: false, error: "That business is not taking online orders." }, { status: 404 });
      }
    }
    // Switched off the customer storefront by the OWNER / authorized staff
    // (Manage Businesses → Online).
    if (biz.onlineOrderingEnabled === false) {
      return NextResponse.json(
        { success: false, error: "That business is not taking online orders right now." },
        { status: 404 },
      );
    }

    const customerName = String(body.customerName || "").trim().slice(0, 80);
    if (customerName.length < 2) {
      return NextResponse.json({ success: false, error: "Please enter your name." }, { status: 400 });
    }
    // Same rules as the storefront field — the customer number must be a
    // Ghana-local EXACTLY-10-digit number; anything else is stopped here
    // before any stock or money is touched.
    const phoneVerdict = validatePhone(String(body.customerPhone || "").slice(0, 30), { exactDigits: PHONE_EXACT_DIGITS_STOREFRONT });
    if (!phoneVerdict.ok) {
      return NextResponse.json({ success: false, error: phoneVerdict.error }, { status: 400 });
    }
    const customerPhone = phoneVerdict.value.slice(0, 20);
    const fulfillmentType = body.fulfillmentType === "DELIVERY" ? "DELIVERY" : "PICKUP";
    // Fulfilment switches managed per branch (Manage Businesses → Online).
    if (fulfillmentType === "PICKUP" && biz.pickupEnabled === false) {
      return NextResponse.json(
        { success: false, error: `${biz.name} is not offering pickup right now — please choose Delivery.` },
        { status: 400 },
      );
    }
    if (fulfillmentType === "DELIVERY" && biz.deliveryEnabled === false) {
      return NextResponse.json(
        { success: false, error: `${biz.name} is not offering delivery right now — please choose Pickup.` },
        { status: 400 },
      );
    }
    const destinationAddress = String(body.destinationAddress || "").trim().slice(0, 200);
    if (fulfillmentType === "DELIVERY" && destinationAddress.length < 3) {
      return NextResponse.json(
        { success: false, error: "Tell us where to deliver (area / landmark)." },
        { status: 400 },
      );
    }
    const paymentChoice = body.paymentChoice === "MOMO_NOW" ? "MOMO_NOW" : "ON_DELIVERY";
    const momoRef = String(body.momoRef || "").trim().slice(0, 40);
    const customerNote = String(body.note || "").trim().slice(0, 300);

    // Google-Maps delivery pin (customer-picked on the storefront picker).
    // Optional at the API level — a phone-fallback address alone still works —
    // but the storefront strongly guides every delivery customer to pin.
    let pin: ReturnType<typeof normalizeDeliveryPin> = null;
    // Google-Places-style reference of the address the customer picked from
    // the autocomplete (formatted label, place_id, its own lat/lng) — kept
    // separately from the pin so a manual pin nudge never loses which
    // *address* was selected. Optional; purely additive to the order record.
    let deliveryPlace: { placeId: string; label: string; lat: number; lng: number } | null = null;
    if (fulfillmentType === "DELIVERY" && body.deliveryPlace && typeof body.deliveryPlace === "object") {
      const dp = body.deliveryPlace;
      const dpLat = Number(dp.lat), dpLng = Number(dp.lng);
      if (
        (dp.placeId != null && String(dp.placeId).trim() !== "") &&
        typeof dp.label === "string" && dp.label.trim() !== "" &&
        Number.isFinite(dpLat) && dpLat >= -90 && dpLat <= 90 &&
        Number.isFinite(dpLng) && dpLng >= -180 && dpLng <= 180
      ) {
        deliveryPlace = {
          placeId: String(dp.placeId).slice(0, 120),
          label: dp.label.trim().slice(0, 500),
          lat: dpLat,
          lng: dpLng,
        };
      }
    }
    if (fulfillmentType === "DELIVERY") {
      try {
        pin = normalizeDeliveryPin(body);
      } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 400 });
      }
      // Never accept a "customer pin" that sits on the SHOP itself — that is
      // the owner/branch pickup location, not the customer's doorstep (the
      // classic failure: pin dropped at map centre and never nudged).
      if (pin && biz.gpsLat != null && biz.gpsLng != null) {
        const shopGapM = haversineM(pin.deliveryLat, pin.deliveryLng, biz.gpsLat, biz.gpsLng);
        if (shopGapM < 75) {
          return NextResponse.json(
            { success: false, error: "The delivery pin is still at the shop's own location — move it to your actual delivery point and try again." },
            { status: 400 },
          );
        }
      }
    }

    // Service-area enforcement: the branch defines its OWN service areas /
    // localities (named map zones, each centre + radius) and/or a legacy
    // branch-pin radius. A delivery pin outside every configured zone is
    // refused up front — customers are only *shown* branches serving their
    // location, and this is the server-side guarantee behind it. Units with
    // no geocoded zone at all accept any pin. (Pickup remains available.)
    const activeAreas = await db
      .select()
      .from(serviceAreas)
      .where(and(eq(serviceAreas.businessId, businessId), eq(serviceAreas.active, true)));
    if (pin) {
      const verdict = businessServesLocation(biz, pin.deliveryLat, pin.deliveryLng, activeAreas);
      const hasGeoZones =
        activeAreas.some((a) => a.centerLat != null && a.centerLng != null && Number(a.radiusKm) > 0) ||
        (biz.serviceRadiusKm != null && Number(biz.serviceRadiusKm) > 0 && biz.gpsLat != null && biz.gpsLng != null);
      if (hasGeoZones && !verdict.serves) {
        const areaList = activeAreas.map((a) => a.name).filter(Boolean).join(", ");
        const gapKm = verdict.distanceM != null ? ` (about ${(Math.max(verdict.distanceM, 0) / 1000).toFixed(1)} km beyond)` : "";
        return NextResponse.json(
          {
            success: false,
            error: `Your pinned delivery point is outside ${biz.name}'s service area${gapKm}.${areaList ? ` We deliver to: ${areaList}.` : ""} Please choose Pickup or contact the branch.`,
          },
          { status: 400 },
        );
      }
    }

    // Pickup locations: when the unit runs named pickup points the customer
    // must choose one — it is snapshotted onto the order so the Business →
    // Branch → Orders → Delivery → Pickup chain survives later edits/removal.
    let pickupSnap: {
      pickupLocationId: number;
      pickupLocationName: string;
      pickupLocationAddress: string | null;
      pickupLat: number | null;
      pickupLng: number | null;
    } | null = null;
    if (fulfillmentType === "PICKUP") {
      const points = await db
        .select()
        .from(pickupLocations)
        .where(and(eq(pickupLocations.businessId, businessId), eq(pickupLocations.active, true)));
      if (points.length > 0) {
        const chosenId = Number(body.pickupLocationId);
        const chosen = points.find((p) => p.id === chosenId);
        if (!chosen) {
          return NextResponse.json(
            { success: false, error: `Choose where you will collect your order — ${biz.name} has ${points.length} pickup point${points.length === 1 ? "" : "s"}.` },
            { status: 400 },
          );
        }
        pickupSnap = {
          pickupLocationId: chosen.id,
          pickupLocationName: chosen.name,
          pickupLocationAddress: chosen.address || null,
          pickupLat: chosen.lat ?? null,
          pickupLng: chosen.lng ?? null,
        };
      }
    }

    const cart: { inventoryId: number; quantity: number }[] = Array.isArray(body.items)
      ? body.items.slice(0, 50).map((li: any) => ({
          inventoryId: Number(li?.inventoryId),
          quantity: Number(li?.quantity),
        }))
      : [];
    if (cart.length === 0 || cart.some((li) => !li.inventoryId || !(li.quantity > 0))) {
      return NextResponse.json({ success: false, error: "Your cart is empty." }, { status: 400 });
    }

    // Re-price & validate every line against live inventory — never trust the client.
    // Pre-order fulfillment selections (fulfillmentPicker {inventoryId: optionId})
    // resolve against the ACTIVE seller-configured options server-side; preorder
    // lines never require stock on hand (that's the entire point) but validate
    // every option again cross-checked to this branch/org.
    const fulfilmentPicker: Record<string, number> = body.fulfillmentPicker && typeof body.fulfillmentPicker === "object" ? body.fulfillmentPicker : {};
    // Pre-orders are a per-unit OFF/ON capability chosen by the OWNER (Manage
    // Businesses / Pre-Order Setup). If the unit is not enabled, any picker
    // entry is a stale or forged page-state — reject it with a clear reason.
    const wantsPreorders = Object.keys(fulfilmentPicker || {}).length > 0;
    if (wantsPreorders && biz.preOrderEnabled !== true) {
      return NextResponse.json(
        { success: false, error: "This branch does not accept pre-orders yet. Ask the branch to enable Pre-Orders in their setup." },
        { status: 403 },
      );
    }
    const ownerOrg = biz.ownerId != null ? Number(biz.ownerId) : null;
    const preorderResolution = await resolvePreorders({ businessId, ownerOrg, cart, fulfilmentPicker });
    const problems: string[] = [];
    if (preorderResolution?.problems?.length) {
      return NextResponse.json({ success: false, error: preorderResolution.problems.join(" "), errors: preorderResolution.problems }, { status: 409 });
    }
    const pByInv = new Map((preorderResolution?.lines || []).filter((l) => l.fulfill).map((l) => [l.inventoryId, l.fulfill]));
    const lines: any[] = [];
    for (const li of cart) {
      const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, li.inventoryId));
      if (!inv || inv.businessId !== businessId) {
        problems.push("One of the products is no longer sold by this branch — please refresh the menu.");
        continue;
      }
      const fu = pByInv.get(li.inventoryId);
      if (fu) {
        // Pre-order line — stock is irrelevant here; goods arrive later.
        lines.push({
          inventoryId: inv.id,
          description: `${inv.name} (${inv.sku})`,
          sku: inv.sku,
          quantity: li.quantity,
          unit: inv.unit,
          unitPrice: fu.priceGhs,
          total: fu.priceGhs * li.quantity,
          preorder: true,
          fulfillmentOptionId: fu.optionId,
          methodKey: fu.methodKey,
          methodLabel: fu.methodLabel,
          leadMinDays: fu.leadMinDays,
          leadMaxDays: fu.leadMaxDays,
          depositGhs: fu.depositGhs,
          termsKey: fu.termsKey,
        });
        continue;
      }
      if (inv.status === "OUT_OF_STOCK" || inv.quantity <= 0) {
        problems.push(`"${inv.name}" just went out of stock.`);
        continue;
      }
      if (li.quantity > inv.quantity) {
        problems.push(`"${inv.name}": only ${inv.quantity} ${inv.unit} available right now.`);
        continue;
      }
      lines.push({
        inventoryId: inv.id,
        description: `${inv.name} (${inv.sku})`,
        sku: inv.sku,
        quantity: li.quantity,
        unit: inv.unit,
        unitPrice: inv.sellingPriceGhs,
        total: inv.sellingPriceGhs * li.quantity,
      });
    }
    if (problems.length > 0) {
      return NextResponse.json({ success: false, error: problems.join(" "), errors: problems }, { status: 409 });
    }

    const totalGhs = lines.reduce((acc: number, li: any) => acc + li.total, 0);
    const code = await uniqueTrackingCode(biz.code);
    const now = new Date();

    // ── Pre-order canon: kind, snapshot, payment plan ──────────────────
    const resolvedForKind = (lines as any[]).map((li: any) =>
      li.preorder ? { inventoryId: li.inventoryId, quantity: li.quantity, fulfill: { optionId: li.fulfillmentOptionId, methodKey: li.methodKey, methodLabel: li.methodLabel, priceGhs: li.unitPrice, leadMinDays: li.leadMinDays, leadMaxDays: li.leadMaxDays, depositGhs: li.depositGhs, termsKey: li.termsKey } } : { inventoryId: li.inventoryId, quantity: li.quantity, fulfill: null },
    );
    const orderKind = orderKindFor(resolvedForKind as any);
    const hasPre = orderKind !== "STOCK";
    const snap = hasPre ? buildPreorderSnapshot(resolvedForKind as any) : null;
    const depositDueGhs = Number(snap?.depositDueGhs || 0);
    const paymentPlan = !hasPre ? undefined : depositDueGhs > 0 ? (depositDueGhs >= totalGhs - 0.005 ? "FULL_NOW" : "DEPOSIT_NOW") : "ON_FULFILLMENT";
    const expectedAt = hasPre ? snap?.etaEnd || null : null;
    const requiredNowGhs = hasPre ? (paymentPlan === "FULL_NOW" ? totalGhs : depositDueGhs) : 0;
    const balanceDueGhs = hasPre ? Math.max(0, totalGhs - (paymentPlan === "ON_FULFILLMENT" ? 0 : requiredNowGhs)) : 0;
    if (hasPre && requiredNowGhs > 0 && paymentChoice === "ON_DELIVERY") {
      // Preorders demanding a deposit cannot be pay-on-delivery; the customer
      // must settle the deposit up front (the whole reason a pre-order exists).
      return NextResponse.json(
        { success: false, error: `This pre-order needs an up-front deposit of GH₵ ${requiredNowGhs.toFixed(2)} — choose MTN MoMo to continue.` },
        { status: 400 },
      );
    }
    const paymentStatusInitial = hasPre
      ? paymentChoice === "MOMO_NOW"
        ? "PENDING_CONFIRMATION"
        : paymentPlan === "ON_FULFILLMENT"
        ? "UNPAID"
        : "PENDING_CONFIRMATION"
      : paymentChoice === "MOMO_NOW"
        ? "PENDING_CONFIRMATION"
        : "UNPAID";

    const customerId = await linkCrmCustomer({
      name: customerName,
      phone: customerPhone,
      businessId,
      spendGhs: 0, // spend accumulates when payment is confirmed
    });

    const [row] = await db
      .insert(customerTrackings)
      .values({
        trackingCode: code,
        businessId,
        branchCode: biz.code,
        branchName: biz.branchLocation || biz.name,
        customerId,
        customerName,
        customerPhone,
        items: lines,
        totalGhs,
        currency: "GHS",
        fulfillmentType,
        destinationAddress: fulfillmentType === "DELIVERY" ? destinationAddress : null,
        ...(pin || {}), // deliveryLat/Lng/accuracyM + canonical mapLink + pinnedAt (DELIVERY only)
        ...(deliveryPlace
          ? {
              deliveryPlaceId: deliveryPlace.placeId,
              deliveryPlaceLabel: deliveryPlace.label,
              deliveryPlaceLat: deliveryPlace.lat,
              deliveryPlaceLng: deliveryPlace.lng,
            }
          : {}), // the autocomplete pick, preserved across manual pin nudges
        ...(pickupSnap || {}), // chosen pickup point snapshot (PICKUP only)
        status: "RECEIVED",
        statusHistory: [
          {
            status: "RECEIVED",
            at: now.toISOString(),
            by: customerName,
            byRole: "CUSTOMER",
            note: pin
              ? "Online order placed on the GoMina 360 customer storefront — delivery point pinned on Google Maps."
              : "Online order placed on the GoMina 360 customer storefront.",
          },
        ],
        orderSource: "ONLINE",
        paymentChoice,
        paymentStatus: paymentStatusInitial,
        paymentMethod: paymentChoice === "MOMO_NOW" ? "MTN_MOMO" : null,
        paymentRef: momoRef || null,
        customerNote: customerNote || null,
        // Pre-order canon (additive columns — legacy rows stay null/STOCK):
        orderKind,
        paymentPlan: paymentPlan || null,
        preorderExpectedAt: expectedAt,
        preorderSnapshot: snap,
        balanceDueGhs: hasPre ? (paymentPlan === "ON_FULFILLMENT" ? totalGhs : balanceDueGhs) : null,
        createdByUserId: null,
        createdByName: customerName,
        createdByRole: "CUSTOMER",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await notifyOnlineOrder({
      businessId,
      code,
      customerName,
      totalGhs,
      itemsCount: lines.length,
    });

    return NextResponse.json({
      success: true,
      trackingCode: code,
      trackUrl: `/track?code=${encodeURIComponent(code)}`,
      order: {
        code,
        businessName: biz.name,
        branchName: biz.branchLocation,
        customerName,
        items: lines.map((li: any) => ({
          description: li.description,
          quantity: li.quantity,
          unit: li.unit,
          unitPrice: li.unitPrice,
          total: li.total,
        })),
        totalGhs,
        currency: "GHS",
        fulfillmentType,
        destinationAddress: fulfillmentType === "DELIVERY" ? destinationAddress : null,
        deliveryLocation: pin
          ? { lat: pin.deliveryLat, lng: pin.deliveryLng, accuracyM: pin.deliveryAccuracyM, mapLink: googleMapsLink(pin.deliveryLat, pin.deliveryLng) }
          : null,
        deliveryPlace: deliveryPlace
          ? { ...deliveryPlace, mapLink: googleMapsLink(deliveryPlace.lat, deliveryPlace.lng) }
          : null,
        pickupLocation:
          fulfillmentType === "PICKUP"
            ? pickupSnap
              ? {
                  name: pickupSnap.pickupLocationName,
                  address: pickupSnap.pickupLocationAddress,
                  lat: pickupSnap.pickupLat,
                  lng: pickupSnap.pickupLng,
                  mapLink:
                    pickupSnap.pickupLat != null && pickupSnap.pickupLng != null
                      ? googleMapsLink(pickupSnap.pickupLat, pickupSnap.pickupLng)
                      : null,
                }
              : biz.gpsLat != null && biz.gpsLng != null
                ? { lat: biz.gpsLat, lng: biz.gpsLng, address: biz.branchLocation || null }
                : null
            : null,
        status: "RECEIVED",
        payment: paymentStatusInitial,
        // Pre-order facts echoed to the customer (ETA window + deposit terms).
        preorder: hasPre
          ? {
              orderKind,
              expectedAt,
              etaStart: snap?.etaStart || null,
              etaEnd: snap?.etaEnd || null,
              depositDueGhs,
              requiredNowGhs,
              balanceDueGhs: paymentPlan === "ON_FULFILLMENT" ? totalGhs : balanceDueGhs,
              termsKey: snap?.termsKey || null,
              methods: snap?.methods || [],
              paymentPlan,
            }
          : null,
        // Customer help & MoMo payment numbers — shown straight after the
        // order lands (and again on the tracking page).
        help: biz.customerHelpPhone ? { phone: biz.customerHelpPhone } : null,
        momo: biz.momoNumber ? { number: biz.momoNumber, name: biz.momoName || null } : null,
        discountPercent: 0,
        discountGhs: 0,
        subtotalGhs: totalGhs,
      },
    });
  } catch (error: any) {
    console.error("POST /api/order error:", error);
    return NextResponse.json({ success: false, error: "Could not place your order. Please try again." }, { status: 500 });
  }
}
