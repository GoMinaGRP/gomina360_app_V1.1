import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { customerTrackings, businesses, inventoryItems, serviceAreas, pickupLocations } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import {
  uniqueTrackingCode,
  linkCrmCustomer,
  notifyOnlineOrder,
  normalizeDeliveryPin,
} from "@/lib/trackingServer";
import { googleMapsLink, businessServesLocation, haversineM } from "@/lib/tracking";
import { validatePhone, PHONE_EXACT_DIGITS_STOREFRONT } from "@/lib/phone";

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
    const problems: string[] = [];
    const lines: any[] = [];
    for (const li of cart) {
      const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, li.inventoryId));
      if (!inv || inv.businessId !== businessId) {
        problems.push("One of the products is no longer sold by this branch — please refresh the menu.");
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
        paymentStatus: paymentChoice === "MOMO_NOW" ? "PENDING_CONFIRMATION" : "UNPAID",
        paymentMethod: paymentChoice === "MOMO_NOW" ? "MTN_MOMO" : null,
        paymentRef: momoRef || null,
        customerNote: customerNote || null,
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
        payment: paymentChoice === "MOMO_NOW" ? "PENDING_CONFIRMATION" : "UNPAID",
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
