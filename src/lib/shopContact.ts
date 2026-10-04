/**
 * shopContact — the ONE place that turns a public storefront business row
 * (the `/api/menu` shape, which the tracking API mirrors) into the customer's
 * contact / enquiry links: phone, WhatsApp, directions.
 *
 * Used by:
 *   · the storefront product card      (/order — Call / WhatsApp / Directions)
 *   · the product lightbox             (/order — seller panel + "Ask about this item")
 *   · the focused-shop strip           (/order — the shop you are buying from)
 *   · the tracking page seller block   (/track — P3, same fallback chain)
 *
 * Contact fallback chain (matches the order model):
 *   1. the shop's own customer-help number  (`customerHelpPhone`)
 *   2. the shop's public contact number     (`contactPhone`)
 * Organisation-level support info is deliberately NOT used here — it is the
 * platform/tenant helpdesk (per-organisation), not the selling shop.
 *
 * Pure functions, no side effects: safe on the server and in the client.
 */

export type ShopLike = {
  businessId?: number;
  businessName?: string;
  branchName?: string;
  contactPhone?: string | null;
  /** Shop-specific help line configured by the owner (never the org helpdesk). */
  customerHelpPhone?: string | null;
  gpsLat?: number | null;
  gpsLng?: number | null;
  pickupLocations?: {
    name?: string;
    address?: string;
    lat?: number | null;
    lng?: number | null;
  }[];
};

/** The number a customer should actually call for this shop (may be ""). */
export function shopPhone(b?: ShopLike | null): string {
  return String(b?.customerHelpPhone || b?.contactPhone || "").trim();
}

/** `tel:` href — keeps a leading + and the digits, drops spaces/dashes. */
export function telHref(phone: string): string {
  const clean = String(phone || "").replace(/[^\d+]/g, "");
  return clean ? `tel:${clean}` : "";
}

/**
 * WhatsApp wants an international number without "+", spaces or a local
 * leading zero. Ghana numbers arrive as "+233 24 …" or "0240 000 000".
 */
export function waDigits(phone: string): string {
  const d = String(phone || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("233")) return d;
  if (d.startsWith("0")) return `233${d.slice(1)}`;
  if (d.length === 9) return `233${d}`; // 24 456 7801
  return d;
}

/** Prefilled WhatsApp chat link for a shop (may be "" when no number). */
export function waHref(phone: string, text: string): string {
  const n = waDigits(phone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : "";
}

/** Best postal/verbal address for a shop: pickup point → branch label. */
export function shopAddress(b?: ShopLike | null): string {
  const pt = (b?.pickupLocations || []).find((x) => x && (x.address || "").trim());
  return String(pt?.address || b?.branchName || "").trim();
}

/**
 * Directions: the shop's pin when it has one, else its first pickup point's
 * pin, else the address text (Google Maps geocodes it for the customer).
 * Returns "" when the shop has published no location at all.
 */
export function shopDirectionsUrl(b?: ShopLike | null): string {
  const pt = (b?.pickupLocations || []).find((x) => x && x.lat != null && x.lng != null);
  const lat = b?.gpsLat ?? pt?.lat ?? null;
  const lng = b?.gpsLng ?? pt?.lng ?? null;
  if (lat != null && lng != null)
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  const addr = shopAddress(b);
  return addr
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}`
    : "";
}

/**
 * The message a customer sends when they tap "Ask about this item" — it names
 * the shop, the product and its SKU so the seller knows exactly what is meant.
 */
export function shopAskText(
  b: ShopLike | null | undefined,
  p: { name?: string; sku?: string } | null | undefined,
): string {
  const shop = b?.businessName || "there";
  const item = [p?.name, p?.sku ? `(${p.sku})` : ""].filter(Boolean).join(" ");
  return `Hello ${shop}, I would like to ask about ${item || "an item"} on GoMina 360 before I order.`;
}

/**
 * Link back to the product in the storefront — appended to enquiry messages so
 * the seller can open the exact item the customer is looking at.
 */
export function productShareUrl(origin: string, bizId?: number | null, productId?: number | null): string {
  const base = String(origin || "").replace(/\/+$/, "");
  if (!base || !productId) return "";
  const qs = new URLSearchParams();
  if (bizId) qs.set("biz", String(bizId));
  qs.set("p", String(productId));
  return `${base}/order?${qs.toString()}`;
}
