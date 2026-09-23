/**
 * Client-side branding (logo) cache.
 *
 * The bootstrap payload no longer carries the ~50-120 KB of base64 company /
 * business crests — it carries a content-hashed `brandingVersion`. The blobs
 * live at /api/branding (ETag + browser cache) and this module mirrors them
 * in localStorage keyed by that version:
 *
 *   • version matches the cached copy  ⇒ hydrate with ZERO network requests
 *   • version differs (logo uploaded)  ⇒ one /api/branding fetch, then cached
 *
 * Consumers see exactly the same values as before (companyLogo via
 * setCompanyLogo, per-business logo/branchLogos on the businesses rows), so
 * invoices/receipts/quotation logo resolution is unchanged.
 */

const STORAGE_KEY = "gomina-branding-v1";

export interface BrandingPayload {
  v: string;
  companyLogo: string | null;
  businesses: Record<string, { logo: string | null; branchLogos: any }>;
}

export function readCachedBranding(version: string | null | undefined): BrandingPayload | null {
  if (!version || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== version) return null;
    if (typeof parsed.companyLogo !== "string" && parsed.companyLogo !== null) return null;
    if (!parsed.businesses || typeof parsed.businesses !== "object") return null;
    return parsed as BrandingPayload;
  } catch {
    return null;
  }
}

function storeBranding(payload: BrandingPayload) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* storage full / disabled — branding just stops being cached */
  }
}

let inflight: Promise<BrandingPayload | null> | null = null;

export function fetchBranding(): Promise<BrandingPayload | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/api/branding");
      if (!res.ok) return null;
      const d = await res.json();
      if (!d?.success || typeof d.v !== "string") return null;
      const payload: BrandingPayload = {
        v: d.v,
        companyLogo: d.companyLogo ?? null,
        businesses: d.businesses || {},
      };
      storeBranding(payload);
      return payload;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Merge cached/fetched logo fields onto a businesses row from init. */
export function withBranding(b: any, branding: BrandingPayload | null): any {
  if (!b || !brandingHas(branding, b.id)) return b;
  const entry = branding!.businesses[String(b.id)];
  return { ...b, logo: entry?.logo ?? null, branchLogos: entry?.branchLogos ?? null };
}

function brandingHas(branding: BrandingPayload | null, id: any): boolean {
  return !!branding && Object.prototype.hasOwnProperty.call(branding.businesses, String(id));
}
