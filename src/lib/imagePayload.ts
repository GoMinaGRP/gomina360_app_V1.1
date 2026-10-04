/**
 * imagePayload.ts — keep stored images OFF the wire unless a screen paints them.
 *
 * WHY
 * ---
 * Images live in Postgres as base64 data URLs. Any endpoint that `select()`s a
 * whole row ships those blobs to the browser — a 300-row ledger with receipts,
 * a stock list with 6 photos per item, a QC register with evidence shots. Most
 * consumers only ever need (a) a count, (b) a boolean "has photo", or (c) one
 * SMALL image for a list/tile. This module applies exactly those three shapes,
 * so the policy is identical everywhere instead of hand-rolled per route.
 *
 * CONTRACT
 * --------
 *   slimInventoryRows  — keep ONE ≤400px display thumbnail (`photoThumb`) as
 *                        the row's `photo`, publish `photoCount`, drop the
 *                        full `photos[]` / `photosThumb[]` arrays (and the raw
 *                        `photo` when a thumbnail exists). Legacy rows without
 *                        a thumbnail keep their (small, pre-thumbnail) photo.
 *                        `{ keepImage: false }` for lists that paint no image
 *                        at all: drop `photo` too and publish `hasPhoto` +
 *                        `photoCount` — the stock rows (name, price, qty) are
 *                        unchanged, only the unused bytes go away.
 *   stripReceipts      — receipts are evidence for the approver/auditor, not
 *                        list decoration: drop the blobs, publish
 *                        `receiptCount`. The Records drawer fetches the full
 *                        record on demand from its own endpoint.
 *   stripPhotos        — drop named image columns, publish `<flag>` (default
 *                        `hasPhoto`) so "📷 attached" indicators keep working.
 *
 * Nothing here mutates the input rows or touches the stored data — it is a
 * response-shaping layer, so restores, backups and the DB are unaffected.
 */

type Row = Record<string, any>;

/** Decoded byte length of a data URL (0 for non-data-URLs). */
function dataUrlBytes(value: unknown): number {
  if (typeof value !== "string" || !value.startsWith("data:")) return 0;
  const i = value.indexOf(",");
  if (i < 0) return 0;
  const b64 = value.slice(i + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/**
 * Keep one small image per row for lists/tiles.
 *
 * `photo` becomes the display thumbnail when one exists (falling back to the
 * stored photo — same rule `/api/init` and the storefront already use), so
 * grids keep painting and payloads shrink by roughly 12–15× per row.
 */
export function slimInventoryRows(
  rows: Row[] | null | undefined,
  opts: { keepImage?: boolean } = {},
): Row[] {
  if (!Array.isArray(rows)) return [];
  const keepImage = opts.keepImage !== false;
  return rows.map((row) => {
    const { photoThumb, photos, photosThumb, photo, ...rest } = row;
    const photosArr = Array.isArray(photos) ? photos : [];
    const count = photosArr.length > 0 ? photosArr.length : photo ? 1 : 0;
    const thumb = typeof photoThumb === "string" && photoThumb ? photoThumb : null;
    const full = typeof photo === "string" && photo ? photo : null;
    const picked = thumb || full;
    if (!keepImage) {
      // The caller's screens paint no image — publish the indicators only.
      return { ...rest, photoCount: count, hasPhoto: !!picked };
    }
    return {
      ...rest,
      /** One small image (thumbnail when available) — never the full set. */
      photo: picked,
      photoCount: count,
      /** Bytes of the image actually being sent (lets callers log/limit). */
      photoBytes: thumb ? dataUrlBytes(thumb) : full ? dataUrlBytes(full) : 0,
    };
  });
}

/** Drop stored receipt blobs; publish `receiptCount` instead. */
export function stripReceipts(rows: Row[] | null | undefined): Row[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const { receiptImage, receiptImages, ...rest } = row;
    const count = Array.isArray(receiptImages) && receiptImages.length > 0 ? receiptImages.length : receiptImage ? 1 : 0;
    return { ...rest, receiptCount: count };
  });
}

/**
 * Drop the named image columns and publish a boolean flag (default `hasPhoto`).
 * Use for photo columns no screen renders — the flag keeps indicators working.
 */
export function stripPhotos(
  rows: Row[] | null | undefined,
  fields: string[],
  opts: { flag?: string } = {},
): Row[] {
  if (!Array.isArray(rows)) return [];
  const flag = opts.flag || "hasPhoto";
  return rows.map((row) => {
    const out: Row = { ...row };
    let has = false;
    for (const f of fields) {
      const v = out[f];
      if (typeof v === "string" && v) has = true;
      else if (Array.isArray(v) && v.some((x) => typeof x === "string" && x)) has = true;
      delete out[f];
    }
    out[flag] = has;
    return out;
  });
}

/** Byte size of the image-ish payload of one row (for tests/diagnostics). */
export function imageBytesOf(row: Row): number {
  let total = 0;
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string" && value.startsWith("data:")) total += dataUrlBytes(value);
    else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string" && v.startsWith("data:")) total += dataUrlBytes(v);
    }
    // `photoBytes` is derived — never double-count it.
    if (key === "photoBytes") total -= Number(value) || 0;
  }
  return Math.max(0, total);
}
