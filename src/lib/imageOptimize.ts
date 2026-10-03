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
 *   asset             1600      0.80       —        inspection photos, records
 *   receipt           1800      0.82       —        small printed digits must
 *                                                  stay readable
 *   evidence          1400      0.78       —        QC/audit proof, shown ≤300px
 *   avatar             320      0.80       —        profile circle, ≤64px UI
 *   employeePhoto      480      0.82       —        32px list + profile card
 *   logo               512      0.88    alpha-aware branding on paper + dark UI
 *   document          2000      0.88       —        vault/HR scans: text detail
 *
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

export type ImagePurpose =
  | "product"
  | "asset"
  | "receipt"
  | "evidence"
  | "avatar"
  | "employeePhoto"
  | "logo"
  | "document";

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
}

export const IMAGE_PRESETS: Record<ImagePurpose, ImagePreset> = {
  product: { maxEdge: 1600, quality: 0.82, thumb: { edge: 400, quality: 0.75 }, keepUnder: 180_000 },
  asset: { maxEdge: 1600, quality: 0.8, keepUnder: 160_000 },
  receipt: { maxEdge: 1800, quality: 0.82, keepUnder: 180_000 },
  evidence: { maxEdge: 1400, quality: 0.78, keepUnder: 120_000 },
  avatar: { maxEdge: 320, quality: 0.8, keepUnder: 40_000, keepAlpha: true },
  employeePhoto: { maxEdge: 480, quality: 0.82, keepUnder: 70_000 },
  logo: { maxEdge: 512, quality: 0.88, keepUnder: 60_000, keepAlpha: true },
  document: { maxEdge: 2000, quality: 0.88, keepUnder: 400_000 },
};

export interface OptimizedImage {
  /** Optimized data URL — always safe to store in the existing columns. */
  dataUrl: string;
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
      mime = canEncodeWebp() ? "image/webp" : "image/png";
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

  // Vector art and animations must stay exactly as uploaded.
  if (originalMime === "image/svg+xml" || originalMime === "image/gif") return untouched();
  // Anything a browser labels as a non-image (PDF uploads) is left alone; an
  // empty/unknown type is still attempted — some Android captures arrive with
  // no MIME at all and decode perfectly well.
  if (originalMime && !originalMime.startsWith("image/")) return untouched();

  const decoded = await decode(file);
  if (!decoded) return untouched();
  try {
    const { draw, width, height } = decoded;
    const longEdge = Math.max(width, height);

    // Already small enough? Keep the user's exact bytes (no generation loss).
    if (longEdge <= preset.maxEdge && originalBytes <= preset.keepUnder && !preset.thumb) {
      return { ...untouched(), width, height };
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

/** Convenience: optimized data URL only (most upload sites store one string). */
export async function optimizedDataUrl(file: Blob | File | string, purpose: ImagePurpose): Promise<string> {
  return (await optimizeImage(file, purpose)).dataUrl;
}

/** Convenience: optimized data URLs for a batch of files. */
export async function optimizedDataUrls(
  files: ArrayLike<Blob | File | string>,
  purpose: ImagePurpose,
): Promise<string[]> {
  return (await optimizeImages(files, purpose)).map((r) => r.dataUrl);
}

/** Human-readable summary for notices/tests: "3.9 MB → 148 KB (26× smaller)". */
export function optimizationSummary(images: OptimizedImage[]): string {
  const before = images.reduce((n, i) => n + i.originalBytes, 0);
  const after = images.reduce((n, i) => n + i.bytes, 0);
  if (!before || !after || after >= before) return "";
  const fmt = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
  return `${fmt(before)} → ${fmt(after)} (${Math.max(1, Math.round(before / after))}× smaller)`;
}
