/**
 * Automatic image optimization (client-side, before upload).
 *
 * WHY CLIENT-SIDE
 * ---------------
 * Every image in GoMina 360 is stored as a base64 data URL in Postgres and
 * travels inside JSON request bodies (products, assets, receipts, evidence,
 * logos, avatars, vault documents). Downscaling therefore has to happen
 * BEFORE the upload: it cuts the request body (upload speed), the stored row
 * (storage) and every later payload/API render (page performance) in one go.
 * The browser already has the original file in memory, so no server round
 * trip, no extra dependency and no image-processing service is needed.
 *
 * ONE PIPELINE, PER-PURPOSE PRESETS
 * ---------------------------------
 * A 12 MP phone photo is 3-6 MB of base64. Nothing in the app renders a
 * product photo above ~1600px, a receipt above ~1800px or a 32px list avatar
 * anywhere near 512px — shipping the full-resolution capture wastes 95-99% of
 * the bytes on every screen that shows it. Each upload site picks a PRESET
 * describing how the image will actually be used:
 *
 *   purpose          max edge  quality  thumbnail   rationale
 *   ---------------  --------  -------  ----------  -------------------------
 *   product           1600      0.82    400 / 0.75  storefront cards + zoomable
 *                                                  lightbox detail
 *   asset             1600      0.80    400 / 0.75  inspection photos, records;
 *                                                  grids paint the thumbnail
 *   receipt           2400      0.85       —        ≈205 DPI on A4 at 275 KB
 *                                                  (WebP) — printed digits and
 *                                                  OCR stay readable
 *   evidence          1400      0.78       —        QC/audit proof, shown ≤300px
 *   avatar             320      0.80       —        profile circle, ≤64px UI
 *   employeePhoto      480      0.82       —        32px list + profile card
 *   logo               512      0.88    alpha-aware branding on paper + dark UI
 *   document          2800      0.85       —        ≈240 DPI on A4: accountant /
 *                                                  OCR scans (JS/PNG-safe JPEG)
 *
 * RECEIPT/DOCUMENT FORMAT (2026-10 image audit)
 * --------------------------------------------
 * These two presets re-encode to WebP at q0.85 when the browser can, with an
 * automatic JPEG fallback. Measured on a 12 MP text scan: 2400px WebP q0.85 =
 * 275 KB / 205 DPI / 44.3 dB PSNR vs the old 2000px JPEG q0.88 = 375 KB /
 * 171 DPI / 42.0 dB — smaller AND sharper, because resolution (not JPEG
 * quality) is what makes small print legible. Only images that render in
 * <img>/download use WebP; logos stay JPEG/PNG because the PDF/Excel exporters
 * embed them (jsPDF cannot embed SVG).
 * FORMAT POLICY
 * -------------
 *   • Photographs → JPEG (universally supported, and the PDF/Excel exporters
 *     in this app can embed it — WebP would break those documents).
 *   • Thumbnails → WebP when the browser can encode it (25-35% smaller, only
 *     ever used in <img> tags), JPEG otherwise. Never a hard dependency.
 *   • Logos/avatars with real transparency → kept transparent (WebP, else
 *     PNG). The previous “always JPEG” path flattened transparent logos onto
 *     BLACK — a real visual bug this pipeline fixes.
 *   • SVG (vector) and animated GIF are stored untouched: rasterizing them
 *     would destroy the very thing that makes them good.
 *
 * SAFETY RAILS
 * ------------
 *   • Never upscale, never inflate: if the source is already within its
 *     budget, the original bytes are kept as-is (no generation loss, no
 *     larger file than the user picked).
 *   • Anything the browser cannot decode (HEIC on non-Safari, BMP, …) falls
 *     back to the original data URL — exactly the previous behaviour.
 *   • EXIF orientation is applied while decoding (imageOrientation:
 *     from-image), so rotated phone photos are stored upright. Canvas
 *     re-encoding also drops GPS/camera EXIF metadata (a privacy win).
 */

/**
 * Largest source file we attempt to decode. Modern phone captures are 3-8 MB
 * (some 48 MP shots exceed 20 MB); because the result is downscaled to a few
 * hundred KB before it ever leaves the device, the old 5 MB "too large"
 * rejections are no longer necessary — this is only a memory guard.
 */
export const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Byte ceilings for images the pipeline must store UNCHANGED:
 *
 *   • `MAX_PASS_THROUGH_BYTES` — SVG and animated GIF are never rasterized
 *     (that would destroy the vector/animation), so they are stored exactly as
 *     picked. Without a ceiling a 20 MB GIF becomes ~27 MB of base64 in a
 *     single row and every later payload that carries it.
 *   • `MAX_UNDECODABLE_BYTES` — formats the browser cannot decode (HEIC on
 *     Chrome/Windows, TIFF, raw camera files…) also pass through. They must fit
 *     inside the platform's request ceiling (~4.5 MB) *after* base64 expansion,
 *     otherwise the POST dies with an opaque 413 instead of a clear message.
 *   • HEIC/HEIF that fail to decode are rejected outright: the browser that
 *     just failed to decode them can never display them either, so storing one
 *     would produce a broken image on the very device that uploaded it.
 */
export const MAX_PASS_THROUGH_BYTES = 1.5 * 1024 * 1024;
export const MAX_UNDECODABLE_BYTES = 3.2 * 1024 * 1024;

/** Formats stored as-is (never rasterized) when they are small enough. */
const PASS_THROUGH_MIME = new Set(["image/svg+xml", "image/gif"]);
/** Formats that cannot be displayed by a browser that failed to decode them. */
const UNDISPLAYABLE_MIME = new Set(["image/heic", "image/heif"]);

export type ImagePurpose =
  | "product"
  | "asset"
  | "receipt"
  | "evidence"
  | "avatar"
  | "employeePhoto"
  | "logo"
  | "document";

/** Photos accepted per record, per upload surface (server-enforced too). */
export const PHOTO_LIMITS: Record<ImagePurpose, number> = {
  product: 6,
  asset: 6,
  receipt: 3,
  evidence: 1,
  avatar: 1,
  employeePhoto: 1,
  logo: 1,
  document: 1,
};

interface ThumbSpec {
  /** Longest-edge cap of the generated thumbnail. */
  edge: number;
  /** Encoder quality of the generated thumbnail. */
  quality: number;
}

interface ImagePreset {
  maxEdge: number;
  quality: number;
  /** Generate a small display thumbnail (inventory photos on the storefront). */
  thumb?: ThumbSpec;
  /**
   * Bytes below which an already-small-enough image is stored untouched.
   * Keeps re-uploads of already-optimized files instant and lossless.
   */
  keepUnder: number;
  /** Preserve transparency (logos/avatars) instead of flattening. */
  keepAlpha?: boolean;
  /**
   * Encode to WebP (with a JPEG fallback) when the source is re-encoded.
   * Only safe for images that render in <img>/download and are never embedded
   * in a PDF/Excel export — i.e. NOT logos, NOT storefront product photos.
   */
  preferWebp?: boolean;
  /**
   * Rasterize vector (SVG) and animated (GIF) sources instead of storing them
   * as-is. Required for LOGOS: the PDF/Excel exporters embed the logo, and
   * jsPDF cannot embed SVG — an SVG crest used to upload fine and then vanish
   * from every invoice. Rasterizing at ≤512px keeps the crest on the paper.
   */
  rasterizeVector?: boolean;
}

export const IMAGE_PRESETS: Record<ImagePurpose, ImagePreset> = {
  product: { maxEdge: 1600, quality: 0.82, thumb: { edge: 400, quality: 0.75 }, keepUnder: 180_000 },
  asset: { maxEdge: 1600, quality: 0.8, thumb: { edge: 400, quality: 0.75 }, keepUnder: 160_000 },
  receipt: { maxEdge: 2400, quality: 0.85, keepUnder: 180_000, preferWebp: true },
  evidence: { maxEdge: 1400, quality: 0.78, keepUnder: 120_000, preferWebp: true },
  avatar: { maxEdge: 320, quality: 0.8, keepUnder: 40_000, keepAlpha: true },
  employeePhoto: { maxEdge: 480, quality: 0.82, keepUnder: 70_000 },
  logo: { maxEdge: 512, quality: 0.88, keepUnder: 60_000, keepAlpha: true, rasterizeVector: true },
  document: { maxEdge: 2800, quality: 0.85, keepUnder: 400_000, preferWebp: true },
};

/**
 * Server-side stored-byte budgets (src/lib/mediaValidation.ts mirrors these).
 * Every value sits above what the preset above actually produces, with
 * headroom for encoder variance — so a legitimate upload is never rejected,
 * while a hand-crafted 5 MB blob is.
 */
export const IMAGE_BYTE_BUDGETS: Record<ImagePurpose, number> = {
  product: 500 * 1024,
  asset: 400 * 1024,
  receipt: 700 * 1024, // WebP ~275 KB, JPEG fallback ~450 KB at 2400px
  evidence: 300 * 1024,
  avatar: 300 * 1024, // alpha is kept: a photographic avatar re-encodes to PNG
  employeePhoto: 120 * 1024,
  logo: 700 * 1024, // alpha logos are PNG (lossless) — content-dependent size
  document: 2 * 1024 * 1024, // WebP ~335 KB, JPEG fallback ~600 KB at 2800px
};
export const THUMB_BYTE_BUDGET = 60 * 1024;

export interface OptimizedImage {
  /** Optimized data URL — always safe to store in the existing columns.
   *  EMPTY when `rejected` is set (the file must not be uploaded). */
  dataUrl: string;
  /** Plain-English reason the file was refused (see the ceilings above). */
  rejected?: string;
  /** Extra context for the user (e.g. "stored as-is — HEIC may not display"). */
  note?: string;
  /** Decoded size of the stored image, in bytes. */
  bytes: number;
  width: number;
  height: number;
  mime: string;
  /** Small display thumbnail (only for presets that ask for one). */
  thumb?: string;
  thumbBytes?: number;
  /** Size of the file the user picked, in bytes. */
  originalBytes: number;
  /** TRUE when the bytes were re-encoded (FALSE = original kept as-is). */
  changed: boolean;
}

/* ─────────────────────────── low-level helpers ─────────────────────────── */

const dataUrlBytes = (url: string): number => {
  const i = url.indexOf(",");
  if (i < 0) return url.length;
  const b64 = url.slice(i + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
};

const mimeOf = (url: string): string => {
  const m = /^data:([^;,]+)/.exec(url);
  return m ? m[1].toLowerCase() : "";
};

/** WebP encoding support — detected once, lazily (SSR-safe, no `document`). */
let webpSupport: boolean | null = null;
function canEncodeWebp(): boolean {
  if (webpSupport !== null) return webpSupport;
  if (typeof document === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    webpSupport = c.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    webpSupport = false;
  }
  return webpSupport;
}

/** Canvas → data URL without blocking the main thread on a giant string. */
function encodeCanvas(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<string> {
  return new Promise((resolve) => {
    const fallback = () => {
      try {
        resolve(canvas.toDataURL(mime, quality));
      } catch {
        resolve(canvas.toDataURL("image/jpeg", quality));
      }
    };
    try {
      canvas.toBlob(
        (blob) => {
          if (!blob) return fallback();
          // toBlob silently falls back to PNG when the type is unsupported.
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = fallback;
          reader.readAsDataURL(blob);
        },
        mime,
        quality,
      );
    } catch {
      fallback();
    }
  });
}

/** Decode any image source to something drawable (EXIF rotation applied). */
async function decode(
  src: Blob | string,
): Promise<{ draw: CanvasImageSource; width: number; height: number; release: () => void } | null> {
  // Preferred: createImageBitmap — off-main-thread decode + EXIF orientation.
  if (typeof createImageBitmap === "function") {
    try {
      const blob = typeof src === "string" ? await (await fetch(src)).blob() : src;
      const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" } as ImageBitmapOptions);
      return { draw: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close?.() };
    } catch {
      /* fall through to the <img> path */
    }
  }
  if (typeof document === "undefined") return null;
  const url = typeof src === "string" ? src : URL.createObjectURL(src);
  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = url;
  });
  if (!img) {
    if (typeof src !== "string") URL.revokeObjectURL(url);
    return null;
  }
  return {
    draw: img,
    width: img.naturalWidth || img.width,
    height: img.naturalHeight || img.height,
    release: () => {
      if (typeof src !== "string") URL.revokeObjectURL(url);
    },
  };
}

/** Does the image carry real (visible) transparency? Sampled, not full-scan. */
function hasTransparency(source: CanvasImageSource, width: number, height: number): boolean {
  try {
    const s = 48;
    const small = document.createElement("canvas");
    small.width = s;
    small.height = s;
    const ctx = small.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(source, 0, 0, s, s);
    const { data } = ctx.getImageData(0, 0, s, s);
    for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
    return false;
  } catch {
    return false;
  }
}

/** Draw `source` into a new canvas, scaled to fit `maxEdge` (never upscales). */
function drawScaled(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxEdge: number,
): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // Better downscaling than the default browser filter for photos.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

/* ───────────────────────────── main entry points ───────────────────────── */

/**
 * Encode an already-decoded image source (photo, canvas snapshot, crop) with
 * a preset: downscale → pick format (JPEG / alpha-preserving WebP-PNG) →
 * encode → optional display thumbnail. Returns null when the source cannot be
 * drawn. Single encode — used by camera-capture and crop flows.
 */
async function encodeWithPreset(
  draw: CanvasImageSource,
  width: number,
  height: number,
  preset: ImagePreset,
): Promise<OptimizedImage | null> {
  try {
    const alpha = !!preset.keepAlpha && hasTransparency(draw, width, height);
    const canvas = drawScaled(draw, width, height, preset.maxEdge);
    let mime: string;
    if (alpha) {
      // Alpha-preserving PNG for anything embedded in a document (logos):
      // jsPDF embeds PNG alpha correctly, while its WebP decoder is not a
      // guaranteed path for transparency. Screens-only images (evidence
      // screenshots, avatars) may use WebP.
      mime = preset.keepAlpha ? "image/png" : canEncodeWebp() ? "image/webp" : "image/png";
    } else if (preset.preferWebp && canEncodeWebp()) {
      // Receipts/documents/evidence: measured smaller AND sharper than JPEG
      // at the same resolution, and never embedded in a PDF/Excel export.
      mime = "image/webp";
    } else {
      mime = "image/jpeg";
    }
    const dataUrl = await encodeCanvas(canvas, mime, preset.quality);
    if (!dataUrl || !dataUrl.startsWith("data:")) return null;
    const out: OptimizedImage = {
      dataUrl,
      bytes: dataUrlBytes(dataUrl),
      width: canvas.width,
      height: canvas.height,
      mime: mimeOf(dataUrl) || mime,
      originalBytes: 0,
      changed: true,
    };
    if (preset.thumb) {
      const thumbCanvas = drawScaled(draw, width, height, preset.thumb.edge);
      const thumbMime = canEncodeWebp() ? "image/webp" : "image/jpeg";
      const thumbUrl = await encodeCanvas(thumbCanvas, thumbMime, preset.thumb.quality);
      if (thumbUrl && thumbUrl.startsWith("data:")) {
        const thumbBytes = dataUrlBytes(thumbUrl);
        if (thumbBytes < out.bytes) {
          out.thumb = thumbUrl;
          out.thumbBytes = thumbBytes;
        }
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Optimize a canvas that was already drawn by the caller (live camera
 * snapshots, square avatar crops). The canvas is treated as the full-quality
 * source: it is re-encoded at the preset's size/quality (and thumbnail).
 */
export async function optimizeCanvas(
  canvas: HTMLCanvasElement,
  purpose: ImagePurpose,
): Promise<OptimizedImage> {
  const preset = IMAGE_PRESETS[purpose] || IMAGE_PRESETS.product;
  const originalDataUrl = (() => {
    try {
      return canvas.toDataURL("image/jpeg", 0.92);
    } catch {
      return "";
    }
  })();
  const full = await encodeWithPreset(canvas, canvas.width, canvas.height, preset);
  if (!full) {
    return {
      dataUrl: originalDataUrl,
      bytes: dataUrlBytes(originalDataUrl),
      width: canvas.width,
      height: canvas.height,
      mime: mimeOf(originalDataUrl) || "image/jpeg",
      originalBytes: dataUrlBytes(originalDataUrl),
      changed: false,
    };
  }
  full.originalBytes = dataUrlBytes(originalDataUrl);
  return full;
}

/**
 * Optimize one picked file for its purpose. Never throws: on any failure the
 * original file is returned as a data URL (previous behaviour).
 */
export async function optimizeImage(
  file: Blob | File | string,
  purpose: ImagePurpose,
): Promise<OptimizedImage> {
  const preset = IMAGE_PRESETS[purpose] || IMAGE_PRESETS.product;
  const asFile = file as File;

  // Source → data URL (used for the fallback path and for size bookkeeping).
  const originalDataUrl =
    typeof file === "string"
      ? file
      : await new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result || ""));
          r.onerror = () => resolve("");
          r.readAsDataURL(file);
        });
  const originalBytes = asFile?.size ?? dataUrlBytes(originalDataUrl);
  const originalMime = typeof file === "string" ? mimeOf(file) : (asFile?.type || "").toLowerCase();

  const untouched = (): OptimizedImage => ({
    dataUrl: originalDataUrl,
    bytes: dataUrlBytes(originalDataUrl),
    width: 0,
    height: 0,
    mime: originalMime || "application/octet-stream",
    originalBytes,
    changed: false,
  });

  const reject = (reason: string): OptimizedImage => ({
    dataUrl: "",
    bytes: 0,
    width: 0,
    height: 0,
    mime: originalMime || "image/*",
    originalBytes,
    changed: false,
    rejected: reason,
  });
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

  // Vector art and animations stay exactly as uploaded — EXCEPT for logos,
  // where they are rasterized so the crest can be embedded in PDF/Excel
  // (see `rasterizeVector`). Either way they need a byte ceiling: without one
  // a 20 MB GIF becomes ~27 MB of base64 in a single row.
  if ((originalMime === "image/svg+xml" || originalMime === "image/gif") && !preset.rasterizeVector) {
    if (originalBytes > MAX_PASS_THROUGH_BYTES) {
      return reject(
        `${originalMime === "image/gif" ? "This GIF" : "This SVG"} is ${mb(originalBytes)} — stored images are capped at ${mb(MAX_PASS_THROUGH_BYTES)} unless the format can be re-encoded. Use a photo (JPEG/PNG) instead.`,
      );
    }
    return untouched();
  }
  // Anything a browser labels as a non-image (PDF uploads) is left alone; an
  // empty/unknown type is still attempted — some Android captures arrive with
  // no MIME at all and decode perfectly well.
  if (originalMime && !originalMime.startsWith("image/")) return untouched();

  const decoded = await decode(file);
  if (!decoded) {
    // HEIC/HEIF that the browser cannot decode can never be DISPLAYED by that
    // browser either — storing it would show a broken image on the uploader's
    // own screen. Ask for a JPEG instead.
    if (UNDISPLAYABLE_MIME.has(originalMime)) {
      return reject(
        `This ${originalMime.replace("image/", "").toUpperCase()} photo cannot be converted in this browser — set the camera to JPEG (or "Most Compatible") and try again.`,
      );
    }
    if (originalBytes > MAX_UNDECODABLE_BYTES) {
      return reject(
        `This image is ${mb(originalBytes)} and cannot be re-encoded by this browser — images it cannot compress must be under ${mb(MAX_UNDECODABLE_BYTES)}. Convert it to JPEG/PNG and try again.`,
      );
    }
    return untouched();
  }
  try {
    const { draw, width, height } = decoded;
    const longEdge = Math.max(width, height);

    // Already small enough? Keep the user's exact bytes (no generation loss).
    if (longEdge <= preset.maxEdge && originalBytes <= preset.keepUnder && !preset.thumb) {
      return { ...untouched(), width, height };
    }

    // A rasterized SVG/GIF with no intrinsic size cannot be drawn.
    if (preset.rasterizeVector && (!width || !height)) {
      return reject("This vector image has no fixed size, so it cannot be converted — export it as a PNG and try again.");
    }

    const encoded = await encodeWithPreset(draw, width, height, preset);
    if (!encoded) return { ...untouched(), width, height };

    // Never store a bigger file than the one the user picked. (Thumb-nailing
    // presets keep their re-encoded bytes: the generated thumbnail is the
    // point, and the main image is still size-checked by the caller's cap.)
    if (encoded.bytes >= originalBytes && originalBytes > 0 && !preset.thumb) {
      return { ...untouched(), width, height };
    }
    return { ...encoded, originalBytes };
  } finally {
    decoded.release();
  }
}

/**
 * Optimize several files at once (bounded concurrency — mobile Safari is
 * memory-tight with parallel canvas work on 12 MP captures).
 */
export async function optimizeImages(
  files: ArrayLike<Blob | File | string>,
  purpose: ImagePurpose,
  concurrency = 3,
): Promise<OptimizedImage[]> {
  const list = Array.from(files);
  const out: OptimizedImage[] = new Array(list.length);
  let next = 0;
  const workers = new Array(Math.min(concurrency, Math.max(1, list.length))).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await optimizeImage(list[i], purpose);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Convenience: optimized data URL only (most upload sites store one string).
 * THROWS with the plain-English reason when the file must not be stored, so
 * every caller's existing try/catch shows a real message instead of silently
 * saving an empty image.
 */
export async function optimizedDataUrl(file: Blob | File | string, purpose: ImagePurpose): Promise<string> {
  const r = await optimizeImage(file, purpose);
  if (r.rejected) throw new Error(r.rejected);
  return r.dataUrl;
}

/** Convenience: optimized data URLs for a batch of files (rejections dropped). */
export async function optimizedDataUrls(
  files: ArrayLike<Blob | File | string>,
  purpose: ImagePurpose,
): Promise<string[]> {
  return (await optimizeImages(files, purpose)).filter((r) => !r.rejected).map((r) => r.dataUrl);
}

/* ─────────────────────── picker helper (one policy) ─────────────────────
 * Every multi-file upload surface goes through `prepareImages` so that the
 * SAME rules apply everywhere: the source-size guard, the pass-through
 * ceilings, the per-record photo cap, and one message per refused file.
 */

export interface PrepareResult {
  /** Files that are safe to store, in pick order. */
  images: OptimizedImage[];
  /** Files that must not be uploaded, with the reason to show the user. */
  rejected: Array<{ name: string; reason: string }>;
  /** Non-blocking hints (e.g. a pass-through format that may not display). */
  notes: string[];
}

/** True when a file cannot be processed by this browser (see the pipeline). */
export function describeRejection(result: PrepareResult): string {
  if (result.rejected.length === 0) return "";
  const first = result.rejected[0];
  const more = result.rejected.length > 1 ? ` (and ${result.rejected.length - 1} more)` : "";
  return `${first.name}: ${first.reason}${more}`;
}

/**
 * Validate + optimize a batch of picked files for one purpose.
 *
 * @param existing how many images the record already carries (photo cap).
 */
export async function prepareImages(
  files: ArrayLike<Blob | File | string>,
  purpose: ImagePurpose,
  opts: { max?: number; existing?: number } = {},
): Promise<PrepareResult> {
  const list = Array.from(files);
  const cap = Math.max(1, opts.max ?? PHOTO_LIMITS[purpose] ?? 1);
  const room = Math.max(0, cap - Math.max(0, opts.existing || 0));
  const rejected: PrepareResult["rejected"] = [];
  const notes: string[] = [];
  const nameOf = (f: Blob | File | string, i: number) =>
    typeof f === "string" ? `image ${i + 1}` : (f as File).name || `image ${i + 1}`;

  const keep: Array<Blob | File | string> = [];
  list.forEach((f, i) => {
    const size = typeof f === "string" ? dataUrlBytes(f) : (f as File).size;
    if (size > MAX_SOURCE_IMAGE_BYTES) {
      rejected.push({
        name: nameOf(f, i),
        reason: `is ${(size / 1024 / 1024).toFixed(1)} MB — the largest file this app can process is 20 MB.`,
      });
      return;
    }
    keep.push(f);
  });

  const accepted = keep.slice(0, room);
  if (keep.length > room) {
    const over = keep.length - room;
    rejected.push({
      name: `${over} file${over === 1 ? "" : "s"}`,
      reason:
        room === 0
          ? `not added — this record already carries the maximum of ${cap} image${cap === 1 ? "" : "s"}. Remove one first.`
          : `not added — a record can hold at most ${cap} image${cap === 1 ? "" : "s"} (${room} more allowed).`,
    });
  }

  const results = await optimizeImages(accepted, purpose);
  results.forEach((r, i) => {
    if (r.rejected) {
      rejected.push({ name: nameOf(accepted[i], i), reason: r.rejected });
      return;
    }
    if (r.note) notes.push(r.note);
  });

  return { images: results.filter((r) => !r.rejected), rejected, notes };
}

/** Human-readable summary for notices/tests: "3.9 MB → 148 KB (26× smaller)". */
export function optimizationSummary(images: OptimizedImage[]): string {
  const before = images.reduce((n, i) => n + i.originalBytes, 0);
  const after = images.reduce((n, i) => n + i.bytes, 0);
  if (!before || !after || after >= before) return "";
  const fmt = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
  return `${fmt(before)} → ${fmt(after)} (${Math.max(1, Math.round(before / after))}× smaller)`;
}
