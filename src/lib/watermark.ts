/**
 * Customer-storefront watermarking — display-time, lossless branding for
 * product photos. The storefront composites a faint overlay (diagonal tiled
 * business name + subtle greyscale logo chip) ABOVE the image element; the
 * original inventory photo bytes are never touched, re-encoded, re-fetched
 * or re-saved. Owners enable/configure it per unit (Manage Businesses →
 * Online); the menu API emits {watermarkEnabled, watermarkMode, logo}.
 *
 * Faintness budget (measured against the "never interfere with product
 * visibility, galleries, full-screen and zoom" requirement):
 *   • text tile  ~5–6% dark ink (barely over print-registration levels),
 *   • logo chip  ~14% opacity, greyscale — reads as etched branding,
 *   • pointer-events: none — the overlay can never swallow taps, wheel,
 *     pinch or drag gestures (zoom/full-screen unaffected),
 *   • %-anchored sizing — identical look on 44px thumbnails and full-screen
 *     zoom, no raster re-scaling artifacts (the text is an SVG tile).
 */

export type WatermarkMode = "AUTO" | "LOGO" | "NAME";

export interface WatermarkSpec {
  enabled: boolean;
  mode: WatermarkMode;
  /** Business logo data URL (only present when enabled) or null. */
  logo: string | null;
  /** Business / branch display name used for the text tile. */
  name: string;
}

const NAME_CAP = 28;

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c] as string));
}

/** Trim a business name to a watermark-friendly short label. */
export function watermarkLabel(name: string): string {
  const t = String(name || "").trim();
  return t.length > NAME_CAP ? `${t.slice(0, NAME_CAP - 1)}…` : t;
}

/**
 * A repeated diagonal-text tile as an SVG data-URL — rendered by CSS
 * `background-repeat`, so coverage scales automatically to ANY surface size
 * (thumbnail → zoomed full-screen) with zero layout math and no raster cost.
 * Memoised: the tiles are byte-identical per label, so repeated product
 * cards render from one cached string.
 */
const tileCache = new Map<string, string>();

export function watermarkTileUri(name: string): string {
  const label = watermarkLabel(name) || "GoMina 360";
  const hit = tileCache.get(label);
  if (hit) return hit;
  const txt = escapeXml(label);
  // 190×96 tile, text rotated −22°. Two-tone treatment so it reads faintly
  // on BOTH light and saturated/dark photos: 12%-white ink with a 14%-dark
  // drop shadow underneath — the professional "etched" watermark look.
  const font = "ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="190" height="96" viewBox="0 0 190 96">` +
    `<g transform="rotate(-22 95 48)">` +
    `<text x="50%" y="calc(50% + 1px)" text-anchor="middle" dominant-baseline="middle" font-family="${font}" font-size="12.5" font-weight="700" letter-spacing="1.2" fill="rgba(15,23,42,0.14)">${txt}</text>` +
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="${font}" font-size="12.5" font-weight="700" letter-spacing="1.2" fill="rgba(255,255,255,0.13)">${txt}</text>` +
    `</g></svg>`;
  const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  tileCache.set(label, uri);
  if (tileCache.size > 60) {
    const firstKey = tileCache.keys().next().value;
    if (firstKey) tileCache.delete(firstKey);
  }
  return uri;
}

/** Resolve which rendering the spec wants for a given surface. */
export function watermarkRender(spec: WatermarkSpec | null | undefined): {
  active: boolean;
  showLogo: boolean;
  showText: boolean;
  text: string;
  logo: string | null;
} {
  if (!spec || !spec.enabled) {
    return { active: false, showLogo: false, showText: false, text: "", logo: null };
  }
  const hasLogo = !!spec.logo;
  const mode: WatermarkMode =
    spec.mode === "LOGO" || spec.mode === "NAME" ? spec.mode : "AUTO";
  // AUTO: prefer the logo when one exists, otherwise the name; LOGO: logo or
  // name-fallback (never silently empty); NAME: name always.
  let showLogo = false;
  let showText = false;
  if (mode === "NAME") {
    showText = true;
  } else if (mode === "LOGO") {
    showLogo = hasLogo;
    showText = !hasLogo;
  } else {
    showLogo = hasLogo;
    showText = !hasLogo;
  }
  // The text tile ALWAYS accompanies a logo watermark (the corner chip alone
  // is too easy to crop out) — the diagonal name is the resilient layer.
  if (showLogo) showText = true;
  const text = showText ? watermarkLabel(spec.name) : "";
  return { active: true, showLogo, showText, text, logo: showLogo ? spec.logo : null };
}
