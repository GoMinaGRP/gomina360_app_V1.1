/**
 * Customer Order Tracking — shared domain logic.
 *
 * Every customer order carries a unique, unguessable tracking code
 * (GM-<BUSINESS>-<6 chars>). Staff manage the order through the
 * Customer Tracking console; customers follow ONLY their own order on the
 * public /track page (no login). The chain is anchored to
 * Business → Branch → Customer → Order (sale document/transaction) → Products.
 */

export const TRACK_STATUSES = [
  "RECEIVED",
  "CONFIRMED",
  "PROCESSING",
  // ── PRE-ORDER stages (ride the same order row & tracking code) ──
  "PROCUREMENT",
  "SHIPPED",
  "IN_TRANSIT",
  "ARRIVED",
  "RECEIVED_STOCK",
  "READY",
  "DISPATCHED",
  "DELIVERED",
  "COMPLETED",
  "CANCELLED",
] as const;

export type TrackStatus = (typeof TRACK_STATUSES)[number];

export const TRACK_STATUS_LABELS: Record<TrackStatus, string> = {
  RECEIVED: "Order Received",
  CONFIRMED: "Confirmed",
  PROCESSING: "Processing",
  PROCUREMENT: "Supplier Procurement",
  SHIPPED: "Shipped",
  IN_TRANSIT: "In Transit",
  ARRIVED: "Arrived",
  RECEIVED_STOCK: "Received Into Stock",
  READY: "Ready for Pickup",
  DISPATCHED: "Dispatched",
  DELIVERED: "Delivered",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

/** Order kinds — legacy rows are all STOCK; PREORDER/MIXED include pre-order lines. */
export const ORDER_KINDS = ["STOCK", "PREORDER", "MIXED"] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

/** Payment plan keys — how/when the customer pays. */
export const PAYMENT_PLAN_LABELS: Record<string, string> = {
  FULL_NOW: "Paid in full",
  DEPOSIT_NOW: "Deposit + balance",
  ON_FULFILLMENT: "Pay on fulfillment",
};

/** Status sequence preorders follow (a LINEAR chain; staff still control every hop). */
export const PREORDER_CHAIN: TrackStatus[] = [
  "RECEIVED",
  "CONFIRMED",
  "PROCUREMENT",
  "SHIPPED",
  "IN_TRANSIT",
  "ARRIVED",
  "RECEIVED_STOCK",
];

export const TERMINAL_STATUSES: TrackStatus[] = ["DELIVERED", "COMPLETED", "CANCELLED"];

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  PAID: "Paid",
  UNPAID: "Not paid yet",
  PENDING_CONFIRMATION: "Awaiting payment confirmation",
  CREDIT: "Credit — paying in installments",
  DEPOSIT_PAID: "Deposit paid — balance due",
};

/** The deposit currently demanded (0 when the order has none). */
export function depositDue(row: any): number {
  const snap = (row?.preorderSnapshot || {}) as any;
  return Number(snap.depositDueGhs || 0);
}

/** Balance still owed after the payments already logged (0 = settled). */
export function balanceDue(row: any, payments?: any[]): number {
  if (row?.balanceDueGhs != null) return Math.max(0, Number(row.balanceDueGhs));
  const total = Number(row?.totalGhs || 0);
  const paid = (payments || []).reduce((a, p) => a + (p.kind === "REFUND" ? -p.amountGhs : p.amountGhs), 0);
  return Math.max(0, total - paid);
}

/** Customer-facing description of how/when payment happens. */
export function paymentExplainer(row: any): string {
  if (row.paymentStatus === "DEPOSIT_PAID") {
    const bal = row.balanceDueGhs != null ? ` GH₵ ${Number(row.balanceDueGhs).toFixed(2)}` : "";
    const when = row.preorderSnapshot?.termsKey === "ON_ARRIVAL" ? "when your goods arrive" : "when your order is ready";
    return `Deposit received — thank you! The balance${bal} is due ${when}.`;
  }
  if (row.paymentStatus === "CREDIT")
    return "This order is on credit — pay in installments with the business; your balance is shown below.";
  if (row.paymentStatus === "PAID") {
    const m = row.paymentMethod === "MTN_MOMO" ? "MTN MoMo" : row.paymentMethod === "CASH" ? "Cash" : null;
    return m ? `Payment received (${m}). Thank you!` : "Payment received. Thank you!";
  }
  if (row.paymentStatus === "PENDING_CONFIRMATION")
    return "You chose MTN MoMo — the business is confirming your payment.";
  if (row.paymentChoice === "ON_DELIVERY")
    return row.fulfillmentType === "DELIVERY"
      ? "Pay cash or MoMo when your order arrives."
      : "Pay cash or MoMo when you pick up your order.";
  return "Payment not completed yet.";
}

export const ORDER_SOURCE_LABELS: Record<string, string> = {
  SALE: "Counter sale",
  MANUAL: "Staff booking",
  ONLINE: "Online order",
};

/**
 * Allowed next statuses. Delivery orders flow …→ PROCESSING → DISPATCHED →
 * DELIVERED; pickup orders flow …→ PROCESSING → READY → COMPLETED. READY →
 * DISPATCHED covers orders switched to delivery after prep.
 */
export const ALLOWED_TRANSITIONS: Record<TrackStatus, TrackStatus[]> = {
  RECEIVED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["READY", "DISPATCHED", "CANCELLED"],
  // PRE-ORDER chain — linear; RECEIVED_STOCK hands back to the stock flow.
  // (STOCK orders never touch these statuses, so existing transitions are
  // byte-identical for them; transitions OUT of them only exist on preorders.)
  PROCUREMENT: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["IN_TRANSIT", "CANCELLED"],
  IN_TRANSIT: ["ARRIVED", "CANCELLED"],
  ARRIVED: ["RECEIVED_STOCK", "CANCELLED"],
  RECEIVED_STOCK: ["READY", "DISPATCHED", "CANCELLED"],
  READY: ["COMPLETED", "DISPATCHED", "CANCELLED"],
  DISPATCHED: ["DELIVERED"],
  DELIVERED: [],
  COMPLETED: [],
  CANCELLED: [],
};

/** Is this one of the pre-order-only intermediate stages? */
export const PREORDER_ONLY_STAGES: TrackStatus[] = ["PROCUREMENT", "SHIPPED", "IN_TRANSIT", "ARRIVED", "RECEIVED_STOCK"];

/**
 * Next statuses valid for THIS order. STOCK orders keep the exact legacy
 * behaviour; PREORDER/MIXED orders replace the CONFIRMED→PROCESSING hop with
 * CONFIRMED→PROCUREMENT and then walk the linear supplier chain. Dispatching
 * still requires DELIVERY fulfillment.
 */
export function nextStatuses(status: string, fulfillmentType: string, orderKind?: string): TrackStatus[] {
  const kind = orderKind || "STOCK";
  const st = (status as TrackStatus) || "RECEIVED";
  let opts: TrackStatus[] = ALLOWED_TRANSITIONS[st] || [];
  if (kind !== "STOCK" && st === "CONFIRMED") opts = ["PROCUREMENT", "CANCELLED"];
  return opts.filter((s) => s !== "DISPATCHED" || fulfillmentType === "DELIVERY");
}

export function isValidTransition(from: string, to: string, fulfillmentType: string, orderKind?: string): boolean {
  return nextStatuses(from, fulfillmentType, orderKind).includes(to as TrackStatus);
}

/** Customer-facing 5-step journey index (0-based) for the public stepper. */
export function journeyStep(status: string): number {
  switch (status) {
    case "CONFIRMED":
      return 1;
    case "PROCESSING":
      return 2;
    case "READY":
    case "DISPATCHED":
      return 3;
    case "DELIVERED":
    case "COMPLETED":
      return 4;
    default:
      return 0; // RECEIVED
  }
}

/** How delivery timeline overlay stages map onto the semantic DOM. */
export const JOURNEY_STAGE_LABELS: Record<TrackStatus, string> = TRACK_STATUS_LABELS;

/** Linear stage list a preorder travels (drives the public stepper + audit). */
export const PREORDER_STAGE_LIST = PREORDER_CHAIN;

/** Build the customer-facing journey DOM for an order. STOCK orders use the
 *  legacy 5 steps; preorder orders get the extended chain rendered from the
 *  same primitive. Staff-configurable via this table only — no UI branches. */
export function journeyStages(orderKind: string | null | undefined): { key: string; preorderOnly: boolean; label: string }[] {
  const out: { key: string; preorderOnly: boolean; label: string }[] = [
    { key: "RECEIVED", preorderOnly: false, label: TRACK_STATUS_LABELS.RECEIVED },
    { key: "CONFIRMED", preorderOnly: false, label: TRACK_STATUS_LABELS.CONFIRMED },
  ];
  if (orderKind && orderKind !== "STOCK") {
    out.push(
      { key: "PROCUREMENT", preorderOnly: true, label: TRACK_STATUS_LABELS.PROCUREMENT },
      { key: "SHIPPED", preorderOnly: true, label: TRACK_STATUS_LABELS.SHIPPED },
      { key: "IN_TRANSIT", preorderOnly: true, label: TRACK_STATUS_LABELS.IN_TRANSIT },
      { key: "ARRIVED", preorderOnly: true, label: TRACK_STATUS_LABELS.ARRIVED },
      { key: "RECEIVED_STOCK", preorderOnly: true, label: TRACK_STATUS_LABELS.RECEIVED_STOCK },
    );
  } else {
    out.push({ key: "PROCESSING", preorderOnly: false, label: TRACK_STATUS_LABELS.PROCESSING });
  }
  out.push(
    { key: "READY", preorderOnly: false, label: "Ready / Dispatched" },
    { key: "DONE", preorderOnly: false, label: "Delivered / Completed" },
  );
  return out;
}

/** Index into `journeyStages` for the stepper (handles DONE collapsing). */
export function journeyStepIndex(status: string, orderKind?: string): number {
  const stages = journeyStages(orderKind);
  if (status === "READY" || status === "DISPATCHED") return stages.findIndex((s) => s.key === "READY");
  if (status === "DELIVERED" || status === "COMPLETED") return stages.findIndex((s) => s.key === "DONE");
  const i = stages.findIndex((s) => s.key === status);
  return i >= 0 ? i : 0;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ2345679"; // no I/L/O/0/1 — hard to misread

export function randomCodePart(len = 6): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/** GM-<BUSINESSWORD>-<6RANDOM>, e.g. GM-POULTRY-4K7XQ2. */
export function buildTrackingCode(bizCode: string | null | undefined): string {
  const word = String(bizCode || "HQ")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, " ")
    .trim()
    .split(/\s+/)[0]
    .slice(0, 8) || "HQ";
  return `GM-${word}-${randomCodePart(6)}`;
}

export function looksLikeTrackingCode(s: string): boolean {
  return /^GM-[A-Z0-9]{1,8}-[A-Z0-9]{4,10}$/.test(s);
}

/** Normalize customer-typed codes: trim, uppercase, drop inner spaces. */
export function normalizeTrackingCode(raw: string | null | undefined): string {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

const ROLE_LABELS: Record<string, string> = {
  OWNER: "Owner",
  GENERAL_MANAGER: "General Manager",
  BRANCH_MANAGER: "Branch Manager",
  WORKER: "Branch staff",
};

/** Canonical Google Maps link for a pin (opens the place page / directions). */
export function googleMapsLink(lat: number, lng: number): string {
  return `https://maps.google.com/?q=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
}

/** Google Maps LIVE follow URL (embeddable iframe src with the pin centred). */
export function googleMapsEmbed(lat: number, lng: number, zoom = 17): string {
  return `https://maps.google.com/maps?q=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}&z=${zoom}&hl=en&output=embed`;
}

/** Google Maps driving-route URL between two pins (staff/courier navigation). */
export function googleMapsRouteLink(
  fromLat: number, fromLng: number, toLat: number, toLng: number,
): string {
  return `https://www.google.com/maps/dir/?api=1&origin=${fromLat},${fromLng}&destination=${toLat},${toLng}&travelmode=driving`;
}

/**
 * Extract a pin from anything a customer/staff member pastes from Google
 * Maps — "…/@5.6037,-0.1870,17z", "…?q=5.6037,-0.1870", "…?query=…", or a
 * bare "5.6037, -0.1870" coordinate pair. Returns null when nothing valid.
 */
export function parseGoogleMapsPin(text: string): { lat: number; lng: number } | null {
  const s = String(text || "").trim();
  if (!s) return null;
  let m = s.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/) ||
    s.match(/[?&](?:q|query|ll|destination|origin)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/) ||
    s.match(/^(?:\s*pin\s*:?)?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/i);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** Small lat/lng nudge (metres) — the storefront "adjust the pin" arrows. */
export function nudgeLatLng(lat: number, lng: number, dNorthM: number, dEastM: number) {
  const newLat = Math.max(-90, Math.min(90, lat + dNorthM / 110540));
  const lngMeters = 111320 * Math.cos((newLat * Math.PI) / 180) || 1;
  const newLng = Math.max(-180, Math.min(180, lng + dEastM / lngMeters));
  return { lat: newLat, lng: newLng };
}

/** Great-circle distance in metres between two GPS fixes (haversine). Pure &
 *  isomorphic — used by the storefront's "serving my location" filter and by
 *  the order API's service-area enforcement. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A business/branch "serves" a customer location when no delivery-area
 *  radius is configured, or the branch has no GPS anchor to measure from
 *  (never hide a unit we cannot evaluate), or the customer is inside the
 *  radius. Returns the distance in metres when computable. */
export interface ServiceAreaInput {
  name?: string | null;
  centerLat?: number | null;
  centerLng?: number | null;
  radiusKm?: number | null;
}

/**
 * Does this Business/Branch serve the customer's Google-Maps location?
 * A unit can define its own list of named service areas/localities; each may
 * carry a map centre + coverage radius. A location is served when it falls
 * inside ANY geocoded area, otherwise we fall back to the legacy branch-pin
 * radius. Units with no geocoded area AND no branch anchor can never be
 * evaluated — they stay visible (never hide a unit we cannot judge) and any
 * name-only areas are shown to customers as advisory.
 */
export function businessServesLocation(
  biz: { serviceRadiusKm?: number | null; gpsLat?: number | null; gpsLng?: number | null },
  lat: number,
  lng: number,
  areas?: ServiceAreaInput[] | null,
): { serves: boolean; distanceM: number | null; areaName: string | null } {
  // 1. Named, geocoded service areas (closest containing area wins).
  const geoAreas = (areas || []).filter(
    (a) => a && a.centerLat != null && a.centerLng != null && Number(a.radiusKm) > 0,
  );
  if (geoAreas.length > 0) {
    let best: { distanceM: number; areaName: string | null } | null = null;
    for (const a of geoAreas) {
      const distanceM = haversineM(lat, lng, Number(a.centerLat), Number(a.centerLng));
      if (distanceM <= Number(a.radiusKm) * 1000 && (!best || distanceM < best.distanceM)) {
        best = { distanceM, areaName: a.name || null };
      }
    }
    if (best) return { serves: true, distanceM: best.distanceM, areaName: best.areaName };
    // Outside every named area — but if the unit ALSO has no branch radius
    // rule there is nothing more to evaluate; report the closest area's gap.
    const closest = Math.min(
      ...geoAreas.map((a) =>
        haversineM(lat, lng, Number(a.centerLat), Number(a.centerLng)) - Number(a.radiusKm) * 1000,
      ),
    );
    const radiusKm = biz.serviceRadiusKm == null ? null : Number(biz.serviceRadiusKm);
    const hasLegacyRule = biz.gpsLat != null && biz.gpsLng != null && radiusKm != null && radiusKm > 0;
    if (!hasLegacyRule) return { serves: false, distanceM: closest > 0 ? closest : null, areaName: null };
    // else fall through to the legacy rule as a second chance
  }

  // 2. Legacy branch-pin radius.
  const radiusKm = biz.serviceRadiusKm == null ? null : Number(biz.serviceRadiusKm);
  if (biz.gpsLat == null || biz.gpsLng == null) {
    if (geoAreas.length > 0) return { serves: false, distanceM: null, areaName: null };
    return { serves: true, distanceM: null, areaName: null };
  }
  const distanceM = haversineM(lat, lng, biz.gpsLat, biz.gpsLng);
  if (radiusKm == null || !(radiusKm > 0)) {
    if (geoAreas.length > 0) return { serves: false, distanceM, areaName: null };
    return { serves: true, distanceM, areaName: null };
  }
  return { serves: distanceM <= radiusKm * 1000, distanceM, areaName: null };
}

/**
 * Public payload — ONLY what is linked to this one tracking code.
 * Never leaks: customer phone, internal ids, staff account ids, other
 * orders, or any business data beyond the name/address of the selling unit.
 * The delivery pin IS included for delivery orders, but this payload is only
 * ever returned to the holder of the unguessable tracking code (the customer
 * themself) — staff/couriers see the same pin through the scoped staff API.
 */
export function publicTrackingPayload(row: any, biz: any, credit?: any) {
  const businessName = typeof biz === "string" ? biz : biz?.name || "GoMina 360 business";
  const gpsLat = typeof biz === "object" && biz ? biz.gpsLat : null;
  const gpsLng = typeof biz === "object" && biz ? biz.gpsLng : null;
  const branchAddress = typeof biz === "object" && biz ? biz.branchLocation : null;
  const helpPhone = typeof biz === "object" && biz ? biz.customerHelpPhone || null : null;
  const momoNumber = typeof biz === "object" && biz ? biz.momoNumber || null : null;
  const momoName = typeof biz === "object" && biz ? biz.momoName || null : null;
  const live =
    row.status === "DISPATCHED" && row.driverLat != null && row.driverLng != null
      ? {
          lat: row.driverLat,
          lng: row.driverLng,
          at: row.driverLocationAt ? new Date(row.driverLocationAt).toISOString() : null,
          driverName: row.driverName || null,
          vehicleNote: row.vehicleNote || null,
        }
      : null;
  return {
    code: row.trackingCode,
    businessName,
    businessCode: row.branchCode || null,
    branchName: row.branchName || null,
    customerName: row.customerName,
    items: (row.items || []).map((li: any) => ({
      description: li.description,
      quantity: li.quantity,
      unit: li.unit || null,
      unitPrice: li.unitPrice ?? null,
      total: li.total ?? null,
    })),
    // Percentage discount (if any) plus the pre-discount subtotal, so the
    // tracking page can show "Discount 5% −GH₵x" like any other receipt.
    discountPercent: Number(row.discountPercent) || 0,
    discountGhs: Number(row.discountGhs) || 0,
    subtotalGhs:
      row.totalGhs != null
        ? Math.round((Number(row.totalGhs) + (Number(row.discountGhs) || 0)) * 100) / 100
        : null,
    totalGhs: row.totalGhs ?? null,
    currency: row.currency || "GHS",
    fulfillmentType: row.fulfillmentType,
    destinationAddress:
      row.fulfillmentType === "DELIVERY" ? row.destinationAddress || null : null,
    // The customer's own Google-Maps delivery pin (they set it, so they may
    // see it back) — plus the branch pickup point (public shop coordinates)
    // for pickup orders so customers know where to collect.
    deliveryLocation:
      row.fulfillmentType === "DELIVERY" && row.deliveryLat != null && row.deliveryLng != null
        ? {
            lat: row.deliveryLat,
            lng: row.deliveryLng,
            accuracyM: row.deliveryAccuracyM ?? null,
            mapLink: row.deliveryMapLink || googleMapsLink(row.deliveryLat, row.deliveryLng),
          }
        : null,
    pickupLocation:
      row.fulfillmentType === "PICKUP"
        ? row.pickupLocationName
          ? {
              // Chosen named pickup point (snapshot from the order).
              name: row.pickupLocationName,
              address: row.pickupLocationAddress || null,
              lat: row.pickupLat ?? null,
              lng: row.pickupLng ?? null,
              mapLink:
                row.pickupLat != null && row.pickupLng != null
                  ? googleMapsLink(row.pickupLat, row.pickupLng)
                  : null,
            }
          : gpsLat != null && gpsLng != null
            ? { lat: gpsLat, lng: gpsLng, address: branchAddress || null, name: null, mapLink: googleMapsLink(gpsLat, gpsLng) }
            : null
        : null,
    // Customer help & MoMo payment numbers (set per unit in Manage
    // Businesses → Online) — shown after checkout and here on /track.
    help: helpPhone ? { phone: helpPhone } : null,
    momo: momoNumber ? { number: momoNumber, name: momoName } : null,
    status: row.status,
    statusLabel: TRACK_STATUS_LABELS[row.status as TrackStatus] || row.status,
    isTerminal: TERMINAL_STATUSES.includes(row.status),
    journeyStep: row.status === "CANCELLED" ? null : journeyStepIndex(row.status, row.orderKind || "STOCK"),
    // Full stage list for the public stepper (5-step legacy or preorder chain).
    journeyStagesList: journeyStages(row.orderKind || "STOCK"),
    orderKind: row.orderKind || "STOCK",
    paymentPlan: row.paymentPlan || "FULL_NOW",
    // Customer-safe subset of the pre-order snapshot (ETA window, methods,
    // deposit outstanding) — never the cost bookkeeping of the staff console.
    preorderSnapshot: (row.orderKind || "STOCK") !== "STOCK"
      ? {
          etaStart: (row.preorderSnapshot as any)?.etaStart || null,
          etaEnd: (row.preorderSnapshot as any)?.etaEnd || null,
          methods: (row.preorderSnapshot as any)?.methods || [],
          termsKey: (row.preorderSnapshot as any)?.termsKey || null,
          depositDueGhs: (row.preorderSnapshot as any)?.depositDueGhs ?? null,
        }
      : null,
    placedAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    // Payment status for the customer — never the MoMo reference (staff-only).
    payment: {
      status: row.paymentStatus || "UNPAID",
      label: PAYMENT_STATUS_LABELS[row.paymentStatus] || "Not paid yet",
      explainer: paymentExplainer(row),
    },
    // Credit sale summary (amounts, dates, installment history) when this
    // order is being paid off in installments — already customer-safe.
    credit: credit || null,
    sourceLabel: ORDER_SOURCE_LABELS[row.orderSource] || "Online order",
    customerNote: row.customerNote || null,
    history: (row.statusHistory || []).map((h: any) => ({
      status: h.status,
      label:
        h.status === "PAYMENT"
          ? "Payment Confirmed"
          : TRACK_STATUS_LABELS[h.status as TrackStatus] || h.status,
      at: h.at,
      by: h.byRole === "CUSTOMER" ? "You (customer)" : ROLE_LABELS[h.byRole] || "Staff",
      note: h.note || null,
    })),
    live,
    trackUrl: `/track?code=${encodeURIComponent(row.trackingCode)}`,
  };
}
