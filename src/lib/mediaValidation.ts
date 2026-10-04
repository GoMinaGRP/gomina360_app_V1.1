/**
 * mediaValidation.ts — the ONE server-side gate for uploaded images.
 *
 * WHY
 * ---
 * Images are stored as base64 data URLs in Postgres and later shipped inside
 * JSON payloads. The browser pipeline (src/lib/imageOptimize.ts) keeps them
 * small, but a browser is not an enforcement point: a buggy client, a script,
 * a stale tab or a compromised session could POST a 20 MB blob straight into a
 * `text` column and from then on every response that carries that row pays for
 * it. Before this module only 4 of ~13 write paths checked anything.
 *
 * POLICY
 * ------
 *   • shape     — must be `data:image/<subtype>;base64,<payload>`, nothing else
 *                 (documents may additionally be `application/pdf`).
 *   • size      — decoded bytes must fit the purpose's stored budget. The
 *                 budgets mirror the client presets with headroom, so a normal
 *                 upload always passes and a hand-crafted one never does.
 *   • count     — lists are capped per purpose (identical caps in the client:
 *                 PHOTO_LIMITS in imageOptimize.ts).
 *   • tolerance — the MIME subtype itself is NOT allow-listed: the app's
 *                 documented promise is "any image format" (SVG, GIF, HEIC,
 *                 BMP, AVIF …), and a narrow list would silently break that.
 *                 Size + shape are what actually protect the database.
 *
 * Callers keep their own logging/messages; this module returns a plain reason
 * string that is safe to show the user.
 */
import { IMAGE_BYTE_BUDGETS, PHOTO_LIMITS, type ImagePurpose } from "./imageOptimize";

/** Budget for generated display thumbnails (400px), mirrored from the client. */
export const THUMB_BUDGET_BYTES = 60 * 1024;

export type ValidationOk = { ok: true; bytes: number; mime: string };
export type ValidationErr = { ok: false; error: string };
export type Validation = ValidationOk | ValidationErr;

/** Decoded byte length of a base64 data URL. */
export function dataUrlBytes(url: string): number {
  const i = url.indexOf(",");
  if (i < 0) return url.length;
  const b64 = url.slice(i + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
const fmtLimit = (n: number) => (n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : `${Math.round(n / 1024)} KB`);

/**
 * Validate one image data URL for a purpose ("product", "receipt", …).
 * Returns the decoded size on success so callers can log/audit it.
 */
export function validateImageDataUrl(
  value: unknown,
  purpose: ImagePurpose,
  opts: { maxBytes?: number; label?: string } = {},
): Validation {
  const label = opts.label || "image";
  if (value === null || value === undefined || value === "") {
    return { ok: false, error: `${label}: no image data.` };
  }
  if (typeof value !== "string") return { ok: false, error: `${label} must be an image.` };
  // Strict base64 (no whitespace/newlines — encoders never emit them, and a
  // padded payload would otherwise inflate the measured size) and a NON-EMPTY
  // payload: a zero-byte "image" stores a broken row for every later reader.
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.trim());
  if (!m) {
    return { ok: false, error: `${label} must be a base64 image (data:image/…;base64,…).` };
  }
  const bytes = dataUrlBytes(value);
  if (bytes < 4) {
    return { ok: false, error: `${label} is empty — the file did not upload. Try again.` };
  }
  const max = opts.maxBytes ?? IMAGE_BYTE_BUDGETS[purpose] ?? THUMB_BUDGET_BYTES;
  if (bytes > max) {
    return {
      ok: false,
      error: `${label} is ${fmtBytes(bytes)} — the limit after optimisation is ${fmtLimit(max)}.`,
    };
  }
  return { ok: true, bytes, mime: m[1].toLowerCase() };
}

/**
 * Validate an optional single image field. Absent/null passes through so
 * partial updates (PATCH) keep working; a present value is fully checked.
 */
export function validateOptionalImage(
  value: unknown,
  purpose: ImagePurpose,
  opts: { maxBytes?: number; label?: string } = {},
): Validation {
  if (value === null || value === undefined || value === "") return { ok: true, bytes: 0, mime: "" };
  return validateImageDataUrl(value, purpose, opts);
}

/**
 * Validate an image LIST (multi-photo records) against the purpose's count cap
 * and byte budget. `null`/`undefined` is treated as "field not present" and
 * passes; an empty array passes (clearing every photo is legitimate).
 *
 * `keepOrphans` positions are preserved: entries that are `null`/"" inside a
 * positional thumbnail array are skipped, not rejected (the arrays are written
 * POSITIONALLY so a missing thumb never shifts onto the wrong photo).
 */
export function validateImageArray(
  value: unknown,
  purpose: ImagePurpose,
  opts: { max?: number; label?: string; maxBytes?: number; allowNulls?: boolean } = {},
): Validation {
  if (value === null || value === undefined) return { ok: true, bytes: 0, mime: "" };
  if (!Array.isArray(value)) return { ok: false, error: `${opts.label || "images"} must be a list.` };
  const max = opts.max ?? PHOTO_LIMITS[purpose] ?? 1;
  if (value.length > max) {
    return {
      ok: false,
      error: `A record can hold at most ${max} image${max === 1 ? "" : "s"} — ${value.length} were sent.`,
    };
  }
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (entry === null || entry === undefined || entry === "") {
      if (opts.allowNulls) continue;
      continue;
    }
    const v = validateImageDataUrl(entry, purpose, {
      maxBytes: opts.maxBytes,
      label: `${opts.label || "image"} #${i + 1}`,
    });
    if (!v.ok) return v;
    bytes += v.bytes;
  }
  return { ok: true, bytes, mime: "" };
}

/** True when the value looks like an image data URL (cheap, no size check). */
export function isImageDataUrl(value: unknown): boolean {
  return typeof value === "string" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value);
}
