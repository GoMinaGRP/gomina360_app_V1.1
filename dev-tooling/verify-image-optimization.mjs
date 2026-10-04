#!/usr/bin/env node
/**
 * verify-image-optimization.mjs — automatic image optimization, end to end.
 *
 * Requirement: every image-upload section optimizes images BEFORE upload with
 * a purpose-appropriate size/quality, generates display thumbnails where they
 * matter, and never degrades existing images or functionality — on desktop
 * and on mobile.
 *
 * Layers:
 *   A. STATIC — every <input type="file"> that accepts images is wired to the
 *      shared optimizer (src/lib/imageOptimize.ts); the only raw
 *      readAsDataURL calls left are the deliberate PDF pass-throughs; the
 *      preset table has the documented size ordering.
 *   B. DESKTOP BROWSER (real Chromium, real handlers, real uploads):
 *      inventory product photo (full pipeline + thumbnails + submission),
 *      storefront grid/lightbox byte behaviour, dashboard bootstrap payload,
 *      legacy rows without thumbnails (fallback), profile avatar, business
 *      logo (transparency preserved), expense receipt, asset images,
 *      employee photo.
 *   C. MOBILE BROWSER (isMobile, DPR 3) — the same upload pipeline and the
 *      storefront rendering on a phone profile.
 *   D. NO-REGRESSION — every pre-existing row's stored image bytes are
 *      byte-identical before/after the suite.
 *
 * Fixtures: synthetic photo-noise PNGs (multi-MB, larger than the old 5 MB
 * cap), a transparent-RGBA PNG for the logo check. All created rows are
 * deleted and all mutated rows restored in the finally block.
 *
 * Run: bash dev-tooling/run-suite.sh dev-tooling/verify-image-optimization.mjs
 */
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";

const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const OUT = new URL("./.verify-out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (cond, msg, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail++;
    console.error(`  ❌ ${msg}${extra ? ` — ${extra}` : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────── fixture image generation ─────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
/** Hand-rolled PNG writer (no dependencies): RGB noise or RGBA with alpha. */
function makePng(width, height, { alpha = false, transparent = false } = {}) {
  const channels = alpha ? 4 : 3;
  const stride = width * channels + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * channels;
      // Photo-like content: smooth gradients + texture + edges. (Pure noise
      // is the pathological worst case for JPEG and is not what a camera
      // produces; this behaves like a real 12 MP capture.)
      const base = (x * 255) / width;
      const band = y > height * 0.6 && y < height * 0.62 ? 60 : 0;
      const texture = ((x * 31 + y * 17) % 23) - 11 + (Math.random() * 14 - 7);
      const shade = base + texture + band;
      raw[o] = Math.max(0, Math.min(255, shade)) & 0xff;
      raw[o + 1] = Math.max(0, Math.min(255, 255 - base * 0.6 + texture)) & 0xff;
      raw[o + 2] = Math.max(0, Math.min(255, base * 0.4 + 90 + texture)) & 0xff;
      if (alpha) raw[o + 3] = transparent && x < width / 2 ? 0 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = alpha ? 6 : 2; // colour type
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 1 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const LARGE_PHOTO = makePng(3000, 2000); // realistic 6 MP capture, > old 5 MB upload cap, < 20 MB guard
const LARGE_PHOTO_B64 = LARGE_PHOTO.toString("base64");
const TRANSPARENT_LOGO = makePng(700, 700, { alpha: true, transparent: true });
const TRANSPARENT_LOGO_B64 = TRANSPARENT_LOGO.toString("base64");
console.log(`fixtures: photo ${(LARGE_PHOTO.length / 1024 / 1024).toFixed(1)} MB, transparent logo ${(TRANSPARENT_LOGO.length / 1024).toFixed(0)} KB`);

/* ───────────────────────────── database ───────────────────────────────── */

const db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await db.connect();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const q1 = async (sql, params = []) => (await q(sql, params))[0];

const TAG = `IMGOPT-${Date.now().toString(36).toUpperCase()}`;
const suiteStart = new Date();

const created = { businessId: 1, inventoryIds: [], transactionIds: [] };
const restore = []; // { table, column, id, value }

/**
 * "Existing images are never rewritten" guard: a content hash of every image
 * column in the tables the app stores images in, plus a real pre-existing
 * inventory photo (the fresh seed ships none), taken before the suite uploads
 * anything and re-checked at the end. Rows this suite creates/mutates are
 * excluded by name/id and restored separately.
 */
const IMAGE_TRACKED = [
  ["inventory_items", "id", "photo, photo_thumb, photos, photos_thumb"],
  ["employees", "id", "photo"],
  ["assets", "id", "asset_images"],
  ["transactions", "id", "receipt_image, receipt_images"],
];
async function imageFingerprint() {
  const out = {};
  for (const [table, key, cols] of IMAGE_TRACKED) {
    const rows = await q(`select ${key} as k, ${cols} from ${table} order by ${key}`);
    out[table] = Object.fromEntries(rows.map((r) => [String(r.k), JSON.stringify(r)]));
  }
  const biz = await q(`select id as k, logo from businesses where id <> 1 order by id`);
  out.businesses = Object.fromEntries(biz.map((r) => [String(r.k), JSON.stringify(r)]));
  const usr = await q(`select id as k, avatar_url from users where id <> 1 order by id`);
  out.users = Object.fromEntries(usr.map((r) => [String(r.k), JSON.stringify(r)]));
  return JSON.stringify(out);
}
/** Pre-existing rows (present before the suite) whose image data changed. */
function fingerprintDrift(beforeJson, afterJson) {
  const before = JSON.parse(beforeJson);
  const after = JSON.parse(afterJson);
  const drift = [];
  for (const table of Object.keys(before)) {
    for (const [id, row] of Object.entries(before[table])) {
      if (after[table]?.[id] !== row) drift.push(`${table}#${id}`);
    }
  }
  return drift;
}

/* ─────────────── A. static wiring + preset policy ─────────────────────── */

console.log("\n── A. static wiring audit ──");
const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
};
const sources = [...walk("src/components"), ...walk("src/app")];
const imageInputs = [];
for (const f of sources) {
  const text = readFileSync(f, "utf8");
  const re = /<input[^>]*type=["']file["'][^>]*>/g;
  let m;
  while ((m = re.exec(text))) {
    const tag = m[0];
    const am = tag.match(/accept\s*=\s*["']([^"']*)["']/);
    const accept = am ? am[1] : "";
    const isBackupZip = /zip/.test(accept);
    if (!isBackupZip && /image\/\*/.test(accept)) {
      imageInputs.push({ file: f, wired: text.includes("imageOptimize") });
    }
  }
}
const unwired = imageInputs.filter((i) => !i.wired);
ok(imageInputs.length >= 16, `every image uploader found in the app sources (${imageInputs.length} inputs)`);
ok(unwired.length === 0, "every image uploader goes through the shared optimizer", unwired.map((u) => u.file).join(", ") || "0 unwired");

const rawReaders = [];
for (const f of sources) {
  const text = readFileSync(f, "utf8");
  if (/readAsDataURL/.test(text) && !/imageOptimize/.test(text)) rawReaders.push(f);
}
ok(rawReaders.length === 0, "no component reads image files directly any more", rawReaders.join(", "));

const optimizerSrc = readFileSync("src/lib/imageOptimize.ts", "utf8");
const preset = (name) => {
  const m = new RegExp(`${name}:\\s*\\{\\s*maxEdge:\\s*(\\d+),\\s*quality:\\s*([\\d.]+)`).exec(optimizerSrc);
  return m ? { edge: Number(m[1]), quality: Number(m[2]) } : null;
};
const product = preset("product");
const document_ = preset("document");
const receipt = preset("receipt");
const evidence = preset("evidence");
const avatar = preset("avatar");
ok(!!product && product.edge === 1600 && product.quality === 0.82, "product photos: 1600px @ q0.82 (zoomable detail)", JSON.stringify(product));
ok(!!document_ && document_.edge === 2800 && document_.quality >= 0.85, "documents: 2800px @ q0.85 (≈240 DPI on A4 — accountant/OCR scans)", JSON.stringify(document_));
ok(!!receipt && receipt.edge === 2400 && receipt.quality >= 0.85, "receipts: 2400px @ q0.85 (≈205 DPI — printed digits stay readable)", JSON.stringify(receipt));
ok(!!evidence && !!avatar && evidence.edge > avatar.edge, "evidence (>avatar) sized by purpose", `${evidence?.edge} vs ${avatar?.edge}`);
ok(/thumb:\s*\{\s*edge:\s*400/.test(optimizerSrc), "product photos generate a ≤400px display thumbnail");
ok(/image\/gif|svg\+xml/.test(optimizerSrc), "vector/animated inputs are excluded from rasterizing");

// ── 2026-10 image-upload audit: the new enforcement layers ──
// (a) source ceiling + pass-through ceilings
ok(/MAX_SOURCE_IMAGE_BYTES = 20 \* 1024 \* 1024/.test(optimizerSrc), "20 MB source guard (memory ceiling, not a rejection rule)");
ok(/MAX_PASS_THROUGH_BYTES = 1\.5 \* 1024 \* 1024/.test(optimizerSrc), "SVG/animated GIF pass through only under 1.5 MB (bounded rows)");
ok(/MAX_UNDECODABLE_BYTES = 3\.2 \* 1024 \* 1024/.test(optimizerSrc), "un-decodable formats capped at 3.2 MB (inside the 4.5 MB request ceiling)");
ok(/UNDISPLAYABLE_MIME = new Set\(\["image\/heic", "image\/heif"\]\)/.test(optimizerSrc), "HEIC/HEIF the browser cannot decode is refused (would never display)");
// (b) budgets + caps exported and mirrored server-side
ok(/export const IMAGE_BYTE_BUDGETS: Record<ImagePurpose, number>/.test(optimizerSrc), "stored-byte budgets exported per purpose");
ok(/export const PHOTO_LIMITS: Record<ImagePurpose, number>/.test(optimizerSrc), "per-record photo caps exported");
ok(/product: 6,/.test(optimizerSrc) && /receipt: 3,/.test(optimizerSrc) && /asset: 6,/.test(optimizerSrc), "caps: 6 products, 6 assets, 3 receipts");
// (c) WebP policy is limited to screens-only presets
ok(/receipt: \{ maxEdge: 2400, quality: 0\.85, keepUnder: 180_000, preferWebp: true \}/.test(optimizerSrc), "receipts prefer WebP (JPEG fallback where unavailable)");
ok(/logo: \{[^}]*preferWebp/.test(optimizerSrc) === false, "logos never use WebP (PDF/Excel embed them)");
ok(/rasterizeVector: true/.test(optimizerSrc), "logos rasterise SVG/GIF so the crest reaches PDFs");
// (d) server-side validator wired into every image write path
const mediaSrc = readFileSync("src/lib/mediaValidation.ts", "utf8");
ok(/export function validateImageDataUrl/.test(mediaSrc) && /export function validateImageArray/.test(mediaSrc), "shared server validator exists (shape + budget + cap)");
ok(/IMAGE_BYTE_BUDGETS\[purpose\]/.test(mediaSrc), "server validator enforces the same budgets as the client");
const guardedRoutes = [
  "src/app/api/enterprise/route.ts",
  "src/app/api/transactions/route.ts",
  "src/app/api/audit/route.ts",
  "src/app/api/audit/issues/route.ts",
  "src/app/api/advisor-notes/route.ts",
  "src/app/api/block-factory/route.ts",
  "src/app/api/transport/route.ts",
  "src/app/api/poultry/feed-mill/route.ts",
  "src/app/api/aquaculture/feed-mill/route.ts",
  "src/app/api/employees/route.ts",
  "src/app/api/profile/route.ts",
  "src/app/api/logos/route.ts",
  "src/app/api/users/route.ts",
  "src/app/api/assets/route.ts",
];
const unguarded = guardedRoutes.filter((f) => !/mediaValidation/.test(readFileSync(f, "utf8")));
ok(unguarded.length === 0, `every image write route validates server-side (${guardedRoutes.length} routes)`, unguarded.join(", ") || "0 unguarded");
// (e) asset thumbnails (parallel array)
ok(/assetImagesThumb/.test(readFileSync("src/db/schema.ts", "utf8")), "assets carry a parallel thumbnail column");
ok(/assetImagesThumb: assetThumbsArr/.test(readFileSync("src/app/api/enterprise/route.ts", "utf8")), "asset create stores the validated thumbnail array");
ok(/assetImagesThumb: assetImages\.map\(/.test(readFileSync("src/components/AssetRegistrationModal.tsx", "utf8")), "asset form sends thumbnails positionally");
ok(/assetImagesThumb/.test(readFileSync("src/lib/businessBackup.ts", "utf8")), "business export/restore carries asset thumbnails");

// Thumbnails are POSITIONALLY aligned with photos[]: entry i belongs to
// photos[i]. A filter() that drops empty entries shifts every later
// thumbnail onto the wrong photo (a real bug this suite caught), so the
// writer must send nulls in place and the readers must index the raw array.
const sharedSrc = readFileSync("src/components/SharedEnterpriseModule.tsx", "utf8");
ok(
  /photosThumb:\s*invPhotoThumbs\.map\(/.test(sharedSrc) && !/photosThumb:\s*invPhotoThumbs\.filter/.test(sharedSrc),
  "client sends thumbnails positionally (null in place, never a shifting filter)",
);
const enterpriseSrc = readFileSync("src/app/api/enterprise/route.ts", "utf8");
ok(
  /const thumbsArr = photosArr\.map\(/.test(enterpriseSrc),
  "inventory create aligns thumbnails to photos by index",
);
for (const route of ["src/app/api/menu/route.ts", "src/app/api/menu/photo/route.ts"]) {
  const src = readFileSync(route, "utf8");
  const shifts = /photosThumb\s*\n?\s*\?\s*[a-zA-Z.]+\s*\.filter/.test(src);
  ok(!shifts && /thumbsRaw|galleryThumbs/.test(src), `${route.split("/").slice(-2).join("/")} indexes the raw thumbnail array (no shift)`);
}

// ── Data heal: damaged (shifted) thumbnail arrays are cleared by db:migrate ──
// The first image-optimization release could persist a SHORT photos_thumb
// array, which shifted later thumbnails onto the wrong photos. Production
// databases carrying such rows are healed by `npm run build` (db:migrate);
// readers then fall back to the full images.
{
  const healSku = `${TAG}-HEAL`;
  await q(`delete from inventory_items where sku = $1`, [healSku]);
  const photoA = "data:image/jpeg;base64," + Buffer.from("PHOTO-A-BYTES").toString("base64");
  const photoB = "data:image/jpeg;base64," + Buffer.from("PHOTO-B-BYTES").toString("base64");
  const thumbB = "data:image/webp;base64," + Buffer.from("THUMB-FOR-B").toString("base64");
  await q(
    `insert into inventory_items
       (name, sku, business_id, category, quantity, unit, cost_price_ghs, selling_price_ghs,
        min_stock_threshold, status, photo, photos, photo_thumb, photos_thumb)
     values ($1, $2, 1, 'Poultry & Eggs', 1, 'Units', 1, 2, 1, 'IN_STOCK', $3, $4::jsonb, $5, $6::jsonb)`,
    [healSku, healSku, photoA, JSON.stringify([photoA, photoB]), photoA, JSON.stringify([thumbB])],
  );
  const migrate = spawnSync("node", ["dev-tooling/migrate-production-schema.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db" },
    encoding: "utf8",
  });
  const row = await q1(`select photos_thumb, photo_thumb from inventory_items where sku = $1`, [healSku]);
  ok(
    migrate.status === 0 && row && row.photos_thumb === null && row.photo_thumb != null,
    "db:migrate clears damaged thumbnail arrays (readers fall back to the full images)",
    `exit=${migrate.status} cleared=${row?.photos_thumb === null}`,
  );
  await q(`delete from inventory_items where sku = $1`, [healSku]);
}

/* ───────────────────────────── browser ───────────────────────────────── */

// A pre-existing product photo (production has these; the fresh seed ships
// none) — the suite must leave its bytes exactly as they are.
// Defensive: purge any rows a previous (crashed) run of this suite left behind.
await q(`delete from inventory_variants where inventory_id in (select id from inventory_items where name like 'IMGOPT-%')`).catch(() => {});
await q(`delete from inventory_items where name like 'IMGOPT-%'`).catch(() => {});
const BASELINE_PHOTO = "data:image/jpeg;base64," + Buffer.from(makePng(64, 48)).toString("base64");
const baselineRow = await q1(
  `insert into inventory_items (name, sku, business_id, branch_code, branch_name, category, quantity, unit, cost_price_ghs, selling_price_ghs, min_stock_threshold, status, photo, photos)
   values ($1, $2, 1, 'POULTRY-01', 'Mina Akuafo Poultry Farm', 'Poultry & Eggs', 4, 'Units', 10, 15, 1, 'IN_STOCK', $3, $4) returning id`,
  [`${TAG} Pre-existing Row`, `${TAG}-BASE`, BASELINE_PHOTO, JSON.stringify([BASELINE_PHOTO])],
);
created.inventoryIds.push(Number(baselineRow.id));
const fingerprintBefore = await imageFingerprint();

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  args: [...(chromium.args || []), "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

/** Attach a synthetic File to a file input and fire the real change event. */
async function uploadFixture(page, selector, b64, name) {
  return page.evaluate(
    async (sel, data, fileName) => {
      const bin = atob(data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], fileName, { type: "image/png" });
      const el = document.querySelector(sel);
      if (!el) return { ok: false, error: "input not found: " + sel };
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    },
    selector,
    b64,
    name,
  );
}

/** Measure a data URL's decoded dimensions + byte size inside the browser. */
async function inspectDataUrl(page, dataUrl) {
  return page.evaluate(
    (url) =>
      new Promise((resolve) => {
        if (!url) return resolve(null);
        const img = new Image();
        img.onload = () =>
          resolve({
            width: img.naturalWidth,
            height: img.naturalHeight,
            bytes: Math.floor((url.split(",")[1] || "").length * 0.75),
            mime: (url.match(/^data:([^;,]+)/) || [])[1] || "",
          });
        img.onerror = () => resolve(null);
        img.src = url;
      }),
    dataUrl,
  );
}

async function login(page) {
  await page.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 120000 });
  await page.type('[data-testid="login-email"]', OWNER.email);
  await page.type('[data-testid="login-password"]', OWNER.pw);
  await page.click('[data-testid="login-submit"]');
  await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 120000 });
  await sleep(1800);
}

async function openSection(page, label) {
  await page.evaluate((lbl) => {
    const btn = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].find((b) => new RegExp(lbl, "i").test(b.textContent || ""));
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, label);
  await sleep(2200);
}

try {
  /* ═════════════ B. desktop browser, real uploads ═════════════ */
  console.log("\n── B. desktop browser (1440×900) ──");
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 160)));
  await login(page);
  let uploadBodyBytes = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/enterprise") && r.method() === "POST") {
      const body = r.postData() || "";
      if (body.length > uploadBodyBytes) uploadBodyBytes = body.length;
    }
  });

  // ── B1-B5 inventory product photo: upload → optimize → thumbnails → save
  await openSection(page, "inventory & stock");
  await page.click('[data-testid="shared-add-open"]');
  await page.waitForSelector('[data-testid="inv-photo-upload"]', { timeout: 30000 });
  await page.type('[data-testid="inv-name"]', `${TAG} Optimized Product`);
  await page.evaluate(() => {
    const qty = document.querySelector('[data-testid="inv-qty"]');
    if (qty) {
      qty.value = "";
      qty.dispatchEvent(new Event("input", { bubbles: true }));
      qty.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await page.type('[data-testid="inv-qty"]', "25");
  await uploadFixture(page, '[data-testid="inv-photo-upload"] input[type=file]', LARGE_PHOTO_B64, `${TAG}-product.png`);
  await page.waitForFunction(() => !!document.querySelector('[data-testid="inv-photo-previews"] img'), { timeout: 30000 });
  const notice = await page.$eval('[data-testid="inv-photo-optimized"]', (el) => el.textContent || "").catch(() => "");
  const preview = await page.$eval('[data-testid="inv-photo-previews"] img', (el) => el.getAttribute("src") || "");
  const previewInfo = await inspectDataUrl(page, preview);
  ok(!!previewInfo && previewInfo.bytes < 400 * 1024, "uploaded multi-MB photo is re-encoded before it leaves the browser", previewInfo ? `${(LARGE_PHOTO.length / 1024 / 1024).toFixed(1)} MB → ${Math.round(previewInfo.bytes / 1024)} KB` : "no preview");
  ok(!!previewInfo && previewInfo.width <= 1600 && previewInfo.height <= 1600, "longest edge capped at 1600px", previewInfo ? `${previewInfo.width}×${previewInfo.height}` : "-");
  ok(/→/.test(notice) && /smaller/.test(notice) && /(\d+)× smaller/.test(notice) && Number(RegExp.$1) >= 8, "the user sees a ≥8× optimization result", notice.slice(0, 60));

  await page.click('[data-testid="shared-add-submit"]');
  await sleep(900);
  // The shared form asks for confirmation before writing the record.
  if (await page.$('[data-testid="shared-confirm-entry-confirm"]')) {
    await page.click('[data-testid="shared-confirm-entry-confirm"]');
  }
  await sleep(2500);
  const row = await q1(
    `select id, photo, photo_thumb, photos, photos_thumb from inventory_items where name = $1 order by id desc limit 1`,
    [`${TAG} Optimized Product`],
  );
  ok(!!row, "product saved with the optimized photo");
  ok(uploadBodyBytes > 0 && uploadBodyBytes < 400 * 1024, "the upload request itself carries only the optimized bytes", uploadBodyBytes ? `${Math.round(uploadBodyBytes / 1024)} KB JSON body (source was ${(LARGE_PHOTO.length / 1024 / 1024).toFixed(1)} MB)` : "no POST captured");
  if (row) {
    created.inventoryIds.push(Number(row.id));
    const mainBytes = Math.floor(((row.photo || "").split(",")[1] || "").length * 0.75);
    const thumbBytes = Math.floor(((row.photo_thumb || "").split(",")[1] || "").length * 0.75);
    ok(mainBytes > 0 && mainBytes < 400 * 1024, "stored product photo ≤400 KB", `${Math.round(mainBytes / 1024)} KB`);
    ok(!!row.photo_thumb && thumbBytes < 60 * 1024, "stored display thumbnail ≤60 KB", `${Math.round(thumbBytes / 1024)} KB`);
    ok(Array.isArray(row.photos_thumb) && row.photos_thumb.length === (row.photos || []).length, "thumbnail array is parallel to the photo array", `${(row.photos_thumb || []).length}/${(row.photos || []).length}`);
    const thumbInfo = await inspectDataUrl(page, row.photo_thumb);
    ok(!!thumbInfo && Math.max(thumbInfo.width, thumbInfo.height) <= 400, "thumbnail long edge ≤400px", thumbInfo ? `${thumbInfo.width}×${thumbInfo.height}` : "-");
    ok(!!thumbInfo && /webp|jpeg/.test(thumbInfo.mime), "thumbnail uses a web-friendly format", thumbInfo?.mime || "-");
  }

  // ── B6-B8 storefront: thumbnails for the grid, full images for the lightbox
  const menu = await (await fetch(`${BASE}/api/menu`)).json();
  let productRow = null;
  for (const b of menu.businesses || []) {
    const hit = (b.products || []).find((p) => p.name === `${TAG} Optimized Product`);
    if (hit) {
      productRow = { branch: b, product: hit };
      break;
    }
  }
  ok(!!productRow, "restored product is live on the public storefront");
  if (productRow) {
    const { product: p } = productRow;
    ok(Array.isArray(p.thumbs) && p.thumbs.length === (p.photos || []).length, "storefront catalogue publishes parallel thumbnail URLs", `${(p.thumbs || []).length}/${(p.photos || []).length}`);
    const fullRes = await fetch(`${BASE}${p.photos[0]}`);
    const thumbRes = await fetch(`${BASE}${p.thumbs[0]}`);
    const fullBuf = Buffer.from(await fullRes.arrayBuffer());
    const thumbBuf = Buffer.from(await thumbRes.arrayBuffer());
    ok(fullRes.status === 200 && thumbRes.status === 200, "both the full image and the thumbnail are served", `${fullRes.status}/${thumbRes.status}`);
    ok(thumbBuf.length < 60 * 1024, "grid thumbnail is small (fast mobile storefront)", `${Math.round(thumbBuf.length / 1024)} KB`);
    ok(fullBuf.length > thumbBuf.length * 3, "the lightbox URL still serves the full-quality image", `${Math.round(fullBuf.length / 1024)} KB vs ${Math.round(thumbBuf.length / 1024)} KB`);
    const thumbType = thumbRes.headers.get("content-type") || "";
    ok(/webp|jpeg/.test(thumbType), "thumbnail is served with the right content type", thumbType);

    // ── B9-B10 storefront UI paints the thumbnail, lightbox the full image
    const shop = await browser.newPage();
    await shop.setViewport({ width: 1440, height: 900 });
    await shop.goto(`${BASE}/order`, { waitUntil: "networkidle2", timeout: 120000 });
    await shop.waitForSelector(`[data-testid="oo-photo-${p.id}"] img`, { timeout: 60000 }).catch(() => {});
    const cardSrc = await shop.$eval(`[data-testid="oo-photo-${p.id}"] img`, (el) => el.getAttribute("src") || "").catch(() => "");
    ok(/size=thumb/.test(cardSrc), "product card renders the thumbnail", cardSrc.slice(0, 70));
    const cardLoaded = await shop.$eval(`[data-testid="oo-photo-${p.id}"] img`, (el) => el.naturalWidth > 0 || (el.complete && el.currentSrc !== "")).catch(() => false);
    ok(!!cardLoaded, "thumbnail image decodes and paints");
    await shop.click(`[data-testid="oo-photo-${p.id}"]`);
    await sleep(1200);
    const lightboxSrc = await shop.evaluate(() => {
      const img = [...document.querySelectorAll('[data-testid^="lb-"] img, img')].map((i) => i.getAttribute("src") || "").find((s) => /\/api\/menu\/photo\?/.test(s) && !/size=thumb/.test(s));
      return img || "";
    });
    ok(!!lightboxSrc, "lightbox opens the full-resolution photo (no thumbnail)", lightboxSrc.slice(0, 70));

    // ── B10b "See details & zoom" path keeps full quality ──
    await q(
      `update inventory_items set description = $2, brand = $3, model = $4, specifications = $5 where id = $1`,
      [p.id, "Optimization test product.", "GoMina", `${TAG}-1`, JSON.stringify([{ key: "Warranty", value: "12 months" }])],
    );
    const detailsCard = await browser.newPage();
    await detailsCard.setViewport({ width: 1440, height: 900 });
    let detailsBtn = null;
    for (let attempt = 0; attempt < 8 && !detailsBtn; attempt++) {
      await sleep(2000); // menu cache TTL
      await detailsCard.goto(`${BASE}/order`, { waitUntil: "networkidle2", timeout: 120000 });
      detailsBtn = await detailsCard.$(`[data-testid="oo-details-${p.id}"]`);
    }
    ok(!!detailsBtn, "product details view is offered when details exist");
    if (detailsBtn) {
      await detailsBtn.click();
      await sleep(1500);
      const detailImg = await detailsCard.evaluate(() => {
        const img = [...document.querySelectorAll("img")].map((i) => i.getAttribute("src") || "").find((src) => /api\/menu\/photo\?/.test(src) && !/size=thumb/.test(src));
        return img || "";
      });
      ok(!!detailImg, "details view loads the full-resolution photo", detailImg.slice(0, 70));
      // Fetch the bytes directly: the detail/zoom image must stay much richer
      // than the grid thumbnail.
      const detailBytes = (await (await fetch(`${BASE}${detailImg}`)).arrayBuffer()).byteLength;
      ok(detailBytes > thumbBuf.length * 3, "detail/zoom image is several times richer than the grid thumbnail", `${Math.round(detailBytes / 1024)} KB vs ${Math.round(thumbBuf.length / 1024)} KB`);
      await detailsCard.close();
    } else {
      await detailsCard.close();
    }
    await shop.close();

    // ── B11 dashboard bootstrap carries the small thumbnail, not the full photo
    const init = await page.evaluate(async () => (await fetch("/api/init")).json()).catch(() => null);
    if (init?.success) {
      const item = (init.inventory || []).find((i) => Number(i.id) === Number(p.id));
      const bytes = item ? Math.floor(((item.photo || "").split(",")[1] || "").length * 0.75) : -1;
      ok(!!item && bytes > 0 && bytes < 60 * 1024, "dashboard bootstrap ships the ≤60 KB thumbnail", bytes >= 0 ? `${Math.round(bytes / 1024)} KB` : "row missing");
    } else {
      ok(false, "dashboard bootstrap payload inspected", "init fetch failed inside the signed-in page");
    }
  }

  // ── B11b one photo without a thumbnail must not shift its neighbours ──
  const ALIGN_A = "data:image/jpeg;base64," + Buffer.from("ALIGN-PHOTO-A").toString("base64");
  const ALIGN_B = "data:image/jpeg;base64," + Buffer.from("ALIGN-PHOTO-B").toString("base64");
  const ALIGN_TB = "data:image/webp;base64," + Buffer.from("ALIGN-THUMB-B").toString("base64");
  const alignRow = await q1(
    `insert into inventory_items (name, sku, business_id, branch_code, branch_name, category, quantity, unit, cost_price_ghs, selling_price_ghs, min_stock_threshold, status, photo, photos, photo_thumb, photos_thumb)
     values ($1, $2, 1, 'POULTRY-01', 'Mina Akuafo Poultry Farm', 'Poultry & Eggs', 6, 'Units', 1, 2, 1, 'IN_STOCK', $3, $4, null, $5) returning id`,
    [`${TAG} Align Product`, `${TAG}-ALIGN`, ALIGN_A, JSON.stringify([ALIGN_A, ALIGN_B]), JSON.stringify([null, ALIGN_TB])],
  );
  created.inventoryIds.push(Number(alignRow.id));
  let aligned = null;
  for (let attempt = 0; attempt < 8 && !aligned; attempt++) {
    await sleep(2000); // menu cache TTL
    const menuJson = await fetch(`${BASE}/api/menu`).then((r) => r.json()).catch(() => null);
    aligned = (menuJson?.businesses || []).flatMap((b) => b.products || []).find((x) => Number(x.id) === Number(alignRow.id)) || null;
  }
  if (aligned?.thumbs?.length === 2) {
    const bytesAt = async (url) => Buffer.from(await (await fetch(`${BASE}${url}`)).arrayBuffer()).toString();
    const served0 = await bytesAt(aligned.thumbs[0]);
    const served1 = await bytesAt(aligned.thumbs[1]);
    const full0 = await bytesAt(aligned.photos[0]);
    ok(served0 === full0, "a gallery photo without a thumbnail falls back to its OWN full image (no shift)");
    ok(served1 === Buffer.from(ALIGN_TB.split(",")[1], "base64").toString(), "the next photo still serves ITS OWN thumbnail");
  } else {
    ok(false, "gallery with a thumbnail gap is served with aligned thumbnails", `thumbs=${aligned?.thumbs?.length ?? "none"}`);
  }

  // ── B12 legacy rows without thumbnails keep working (fallback)
  const legacyPhoto = (await q1(`select photo from inventory_items where business_id = $1 and photo is not null limit 1`, [created.businessId]))?.photo || "";
  const legacy = await q1(
    `insert into inventory_items (name, sku, business_id, branch_code, branch_name, category, quantity, unit, cost_price_ghs, selling_price_ghs, min_stock_threshold, status, photo, photos)
     values ($1, $2, $3, $4, $5, 'Hardware & Tools', 9, 'Units', 5, 9, 1, 'IN_STOCK', $6, $7) returning id`,
    [`${TAG} Legacy Product`, `${TAG}-LEG`, created.businessId, "HARDWARE-01", "GoMina Hardware & Building Materials Depot", legacyPhoto, JSON.stringify([legacyPhoto])],
  );
  created.inventoryIds.push(Number(legacy.id));
  let legacyProduct = null;
  for (let attempt = 0; attempt < 8 && !legacyProduct; attempt++) {
    // The catalogue is cached for 10 s — a direct SQL insert cannot invalidate it.
    await sleep(2000);
    const legacyMenu = await (await fetch(`${BASE}/api/menu`)).json();
    for (const b of legacyMenu.businesses || []) {
      const hit = (b.products || []).find((p) => Number(p.id) === Number(legacy.id));
      if (hit) legacyProduct = hit;
    }
  }
  ok(!!legacyProduct, "legacy row (no thumbnails) still appears on the storefront");
  if (legacyProduct) {
    const r = await fetch(`${BASE}${legacyProduct.thumbs[0]}`);
    const buf = Buffer.from(await r.arrayBuffer());
    ok(r.status === 200 && buf.length > 0, "its thumbnail URL falls back to the full image instead of breaking", `${r.status}, ${Math.round(buf.length / 1024)} KB`);
  }
  ok(!pageErrors.length, "no page errors during the desktop flows", pageErrors.slice(0, 2).join(" | "));

  // ── B13 profile avatar: 320×320 preset, saved to the profile
  const beforeAvatar = (await q1(`select avatar_url from users where id = 1`))?.avatar_url || null;
  restore.push({ table: "users", column: "avatar_url", id: 1, value: beforeAvatar });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 120000 });
  await sleep(1500);
  await page.click('[data-testid="user-menu-btn"]');
  await sleep(500);
  const openedAvatar = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="open-profile-photo"]');
    if (!b) return false;
    b.click();
    return true;
  });
  ok(openedAvatar, "profile photo dialog opens");
  await sleep(800);
  await uploadFixture(page, '[data-testid="ppm-file"]', LARGE_PHOTO_B64, `${TAG}-avatar.png`);
  await sleep(1500);
  const pendingAvatar = await page.$eval('[data-testid="ppm-root"] img', (el) => el.getAttribute("src") || "").catch(() => "");
  const pendingInfo = await inspectDataUrl(page, pendingAvatar);
  ok(!!pendingInfo && pendingInfo.width === 320 && pendingInfo.height === 320, "avatar is square-cropped to 320×320", pendingInfo ? `${pendingInfo.width}×${pendingInfo.height}` : "-");
  ok(!!pendingInfo && pendingInfo.bytes < 60 * 1024, "avatar ≤60 KB", pendingInfo ? `${Math.round(pendingInfo.bytes / 1024)} KB` : "-");
  await page.click('[data-testid="ppm-save"]');
  await sleep(2000);
  const savedAvatar = (await q1(`select avatar_url from users where id = 1`))?.avatar_url || "";
  ok(/^data:image\//.test(savedAvatar) && Math.floor((savedAvatar.split(",")[1] || "").length * 0.75) < 60 * 1024, "avatar stored small on the profile", `${Math.round(Math.floor((savedAvatar.split(",")[1] || "").length * 0.75) / 1024)} KB`);

  // ── B14 business logo: transparency preserved (was flattened onto black)
  const beforeLogo = (await q1(`select logo from businesses where id = 1`))?.logo || null;
  restore.push({ table: "businesses", column: "logo", id: 1, value: beforeLogo });
  await openSection(page, "manage|businesses");
  await sleep(1200);
  const logoOpened = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="open-manage-businesses"]');
    if (!b) return false;
    b.click();
    return true;
  }).catch(() => false);
  if (logoOpened) {
    await page.waitForSelector('[data-testid="manage-biz-logos-POULTRY-01"]', { timeout: 30000 });
    await page.$eval('[data-testid="manage-biz-logos-POULTRY-01"]', (el) => el.click());
    await page.waitForSelector('[data-testid="bizlogo-mgr"]', { timeout: 30000 });
    await uploadFixture(page, '[data-testid="bizlogo-upload-1"]', TRANSPARENT_LOGO_B64, `${TAG}-logo.png`);
    await page.waitForSelector('[data-testid="bizlogo-preview-1"]', { timeout: 40000 });
    // The modal shows the optimized preview immediately but persists it in a
    // separate request — wait for the stored row to change before judging it.
    let savedLogo = beforeLogo || "";
    for (let i = 0; i < 30; i++) {
      savedLogo = (await q1(`select logo from businesses where id = 1`))?.logo || "";
      if (savedLogo && savedLogo !== beforeLogo) break;
      await sleep(500);
    }
    const previewLogo = await page.$eval('[data-testid="bizlogo-preview-1"]', (el) => el.getAttribute("src") || "").catch(() => "");
    const logoInfo = await inspectDataUrl(page, savedLogo);
    const previewInfo = await inspectDataUrl(page, previewLogo);
    ok(!!logoInfo && /webp|png/.test(logoInfo.mime), "transparent logo keeps a transparency-capable format",
      `stored=${logoInfo?.mime || "-"} preview=${previewInfo?.mime || "-"}`);
    ok(!savedLogo.includes("image/jpeg"), "logo is not flattened onto black any more", String(savedLogo).slice(0, 24));
    ok(!!logoInfo && Math.max(logoInfo.width, logoInfo.height) <= 512, "logo stays ≤512px for documents", logoInfo ? `${logoInfo.width}×${logoInfo.height}` : "-");
  } else {
    ok(false, "Manage Businesses dialog opens", "trigger not found");
  }

  // ── B15 expense receipt (Block Factory module): readable but small
  await page.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 120000 });
  await sleep(1200);
  await openSection(page, "block factory|concrete");
  await sleep(1500);
  const expenseOpened = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="bf-open-expense"]');
    if (!b) return false;
    b.click();
    return true;
  });
  if (expenseOpened) {
    await page.waitForSelector('[data-testid="bf-expense-receipt-upload"]', { timeout: 30000 });
    await uploadFixture(page, '[data-testid="bf-expense-receipt-upload"]', LARGE_PHOTO_B64, `${TAG}-receipt.png`);
    await page.waitForFunction(() => !!document.querySelector('[data-testid="bf-expense-receipt-upload"]')?.closest("div,form")?.parentElement?.querySelector("img"), { timeout: 30000 }).catch(() => {});
    await sleep(1200);
    const receiptSrc = await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="bf-expense-modal"]');
      const img = modal ? [...modal.querySelectorAll("img")].map((i) => i.getAttribute("src") || "").find((s) => s.startsWith("data:image/")) : "";
      return img || "";
    });
    const receiptInfo = await inspectDataUrl(page, receiptSrc);
    // The receipt budget is 700 KB (2400px ≈ 205 DPI on A4 — the resolution is
    // what makes small print readable; WebP lands ~275 KB, the JPEG fallback
    // ~500 KB, so the ceiling tracks the server budget).
    ok(!!receiptInfo && receiptInfo.bytes <= 700 * 1024, "receipt photo is compressed before upload", receiptInfo ? `${Math.round(receiptInfo.bytes / 1024)} KB` : "no preview");
    ok(!!receiptInfo && receiptInfo.width >= 2000, "receipt keeps enough resolution to read small print (≥2000px ≈ 170 DPI)", receiptInfo ? `${receiptInfo.width}×${receiptInfo.height}` : "-");
  } else {
    ok(false, "expense form opens in the Block Factory module", "bf-open-expense missing");
  }

  // ── B16 asset images (dedicated registration modal)
  await page.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 120000 });
  await sleep(1200);
  await openSection(page, "assets & machinery|assets");
  await sleep(1500);
  const assetOpened = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="asset-reg-open"]');
    if (!b) return false;
    b.click();
    return true;
  });
  if (assetOpened) {
    await sleep(1000);
    await uploadFixture(page, '[data-testid="ast-code"] ~ * input[type=file], input[type=file][accept="image/*"]', LARGE_PHOTO_B64, `${TAG}-asset.png`);
    await sleep(3000);
    const assetSrc = await page.evaluate(() => {
      const anchor = document.querySelector('[data-testid="ast-business"]');
      const scope = anchor?.closest("form") || document;
      const imgs = [...scope.querySelectorAll("img")].map((i) => i.getAttribute("src") || "").filter((s) => s.startsWith("data:image/"));
      return imgs[imgs.length - 1] || "";
    });
    const assetInfo = await inspectDataUrl(page, assetSrc);
    ok(!!assetInfo && assetInfo.bytes < 400 * 1024, "asset image is optimized before it is saved", assetInfo ? `${Math.round(assetInfo.bytes / 1024)} KB` : "no preview");
  } else {
    ok(false, "asset registration modal opens", "asset-reg-open missing");
  }

  // ── B17 employee photo (HR registration form)
  await page.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 120000 });
  await sleep(1200);
  await openSection(page, "employees|payroll");
  await sleep(1500);
  const empOpened = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="employee-reg-open"]');
    if (!b) return false;
    b.click();
    return true;
  });
  if (empOpened) {
    await sleep(1000);
    await uploadFixture(page, '[data-testid="ereg-photo-upload"] input[type=file]', LARGE_PHOTO_B64, `${TAG}-employee.png`);
    await sleep(3000);
    const empSrc = await page.evaluate(() => {
      const anchor = document.querySelector('[data-testid="ereg-photo-upload"]');
      const scope = anchor?.closest("form") || anchor?.parentElement || document;
      const imgs = [...scope.querySelectorAll("img")].map((i) => i.getAttribute("src") || "").filter((s) => s.startsWith("data:image/"));
      return imgs[imgs.length - 1] || "";
    });
    const empInfo = await inspectDataUrl(page, empSrc);
    ok(!!empInfo && empInfo.bytes < 90 * 1024, "employee photo is optimized before it is saved", empInfo ? `${Math.round(empInfo.bytes / 1024)} KB` : "no preview");
    await page.click('[data-testid="ereg-cancel"]').catch(() => {});
  } else {
    ok(false, "employee registration form opens", "employee-reg-open missing");
  }

  /* ═════════════ C. mobile browser ═════════════ */
  console.log("\n── C. mobile browser (390×844, DPR 3) ──");
  const mobileCtx = await browser.createBrowserContext();
  const mobile = await mobileCtx.newPage();
  await mobile.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await mobile.setUserAgent(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  );
  const mobileErrors = [];
  mobile.on("pageerror", (e) => mobileErrors.push(String(e.message).slice(0, 160)));
  await login(mobile);
  await openSection(mobile, "inventory & stock");
  await mobile.click('[data-testid="shared-add-open"]');
  await mobile.waitForSelector('[data-testid="inv-photo-camera"], [data-testid="inv-photo-upload"]', { timeout: 30000 });
  await mobile.type('[data-testid="inv-name"]', `${TAG} Mobile Product`);
  await mobile.type('[data-testid="inv-qty"]', "12");
  await uploadFixture(mobile, '[data-testid="inv-photo-upload"] input[type=file]', LARGE_PHOTO_B64, `${TAG}-mobile.png`);
  await mobile.waitForFunction(() => !!document.querySelector('[data-testid="inv-photo-previews"] img'), { timeout: 40000 });
  const mobilePreview = await mobile.$eval('[data-testid="inv-photo-previews"] img', (el) => el.getAttribute("src") || "");
  const mobileInfo = await inspectDataUrl(mobile, mobilePreview);
  ok(!!mobileInfo && mobileInfo.width <= 1600 && mobileInfo.bytes < 400 * 1024, "mobile upload produces the same optimized image", mobileInfo ? `${mobileInfo.width}×${mobileInfo.height}, ${Math.round(mobileInfo.bytes / 1024)} KB` : "-");
  await mobile.click('[data-testid="shared-add-submit"]');
  await sleep(900);
  if (await mobile.$('[data-testid="shared-confirm-entry-confirm"]')) {
    await mobile.click('[data-testid="shared-confirm-entry-confirm"]');
  }
  await sleep(2500);
  const mobileRow = await q1(`select id, photo_thumb from inventory_items where name = $1 order by id desc limit 1`, [`${TAG} Mobile Product`]);
  ok(!!mobileRow && !!mobileRow.photo_thumb, "mobile upload stores a display thumbnail too");
  if (mobileRow) created.inventoryIds.push(Number(mobileRow.id));

  // storefront on the phone profile
  const shopMobile = await mobileCtx.newPage();
  await shopMobile.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await shopMobile.goto(`${BASE}/order`, { waitUntil: "networkidle2", timeout: 120000 });
  // The storefront grid uses loading="lazy": on a 390×844 phone the fresh card
  // starts below the fold, and the client swaps in the ?size=thumb URL once the
  // catalogue payload settles. Bring the card into view and wait for the
  // thumbnail to be both requested and decoded before asserting on it —
  // otherwise the check races the lazy image rather than the behaviour.
  await shopMobile
    .waitForSelector(`[data-testid="oo-photo-${mobileRow?.id}"]`, { timeout: 60000 })
    .catch(() => {});
  await shopMobile
    .evaluate((id) => {
      document.querySelector(`[data-testid="oo-photo-${id}"]`)?.scrollIntoView({ block: "center" });
    }, mobileRow?.id)
    .catch(() => {});
  await shopMobile
    .waitForFunction(
      (id) => {
        const img = document.querySelector(`[data-testid="oo-photo-${id}"] img`);
        return !!img && /size=thumb/.test(img.getAttribute("src") || "") && img.naturalWidth > 0;
      },
      { timeout: 60000 },
      mobileRow?.id,
    )
    .catch(() => {});
  const mobileThumb = await shopMobile
    .$eval(`[data-testid="oo-photo-${mobileRow?.id}"] img`, (el) => ({ src: el.getAttribute("src") || "", w: el.naturalWidth }))
    .catch(() => null);
  ok(!!mobileThumb && /size=thumb/.test(mobileThumb.src) && mobileThumb.w > 0, "mobile storefront grid paints the thumbnail", mobileThumb ? `${mobileThumb.w}px wide` : "-");
  const mobileFull = await fetch(`${BASE}/api/menu/photo?item=${mobileRow?.id}&index=0`);
  const mobileFullBuf = Buffer.from(await mobileFull.arrayBuffer());
  ok(mobileFull.status === 200 && mobileFullBuf.length > 60 * 1024, "mobile lightbox still gets the detailed image", `${Math.round(mobileFullBuf.length / 1024)} KB`);
  ok(!mobileErrors.length, "no page errors on the mobile profile", mobileErrors.slice(0, 2).join(" | "));
  await shopMobile.close();

  /* ═════════════ D. no-regression on existing images ═════════════ */
  console.log("\n── D. existing images untouched ──");
  // Put the deliberately mutated rows back FIRST, so the comparison below is
  // against the true pre-suite state.
  for (const r of restore) await q(`update ${r.table} set ${r.column} = $1 where id = $2`, [r.value, r.id]);
  const beforeRow = await q1(`select photo from inventory_items where id = $1`, [baselineRow.id]);
  ok(beforeRow?.photo === BASELINE_PHOTO, "a pre-existing product photo is byte-identical after the suite", `${Math.round((beforeRow?.photo || "").length / 1024)} KB`);
  const fingerprintAfter = await imageFingerprint();
  const drift = fingerprintDrift(fingerprintBefore, fingerprintAfter);
  ok(drift.length === 0, "every pre-existing image row in the database is unchanged", drift.slice(0, 3).join(", "));
  const restoredAvatar = (await q1(`select avatar_url from users where id = 1`))?.avatar_url || null;
  const restoredLogo = (await q1(`select logo from businesses where id = 1`))?.logo || null;
  ok(restoredAvatar === (restore.find((r) => r.column === "avatar_url")?.value ?? null), "the mutated avatar was restored to its original value");
  ok(restoredLogo === (restore.find((r) => r.column === "logo")?.value ?? null), "the mutated logo was restored to its original value");
/* ══════════════════════════════════════════════════════════════════════════
   C. SERVER-SIDE ENFORCEMENT (the 2026-10 audit's G1/G4/G5 fixes)
   The browser pipeline keeps images small, but a browser is not an enforcement
   point. Each check below posts a payload the UI would never produce and
   asserts the API refuses it with a plain reason instead of storing it.
   ══════════════════════════════════════════════════════════════════════════ */
console.log("\n── C. server-side enforcement ──");
{
  const post = (url, body) =>
    page.evaluate(
      async (u, b) => {
        const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
        let json = null;
        try { json = await r.json(); } catch { /* non-JSON */ }
        return { status: r.status, json };
      },
      url,
      body,
    );
  const bigRecipe = (kb) => "data:image/jpeg;base64," + "A".repeat(Math.ceil((kb * 1024 * 4) / 3));
  const tinyRecipe = "data:image/jpeg;base64," + Buffer.from(makePng(24, 24)).toString("base64");

  // C1 — an oversized receipt (900 KB > the 700 KB receipt budget)
  const c1 = await post("/api/transactions", {
    businessId: created.businessId,
    type: "EXPENSE",
    category: "Supplies",
    amountGhs: 5,
    description: `${TAG} oversize receipt probe`,
    receiptImage: bigRecipe(900),
  });
  ok(c1.status === 400 && /limit after optimisation/i.test(JSON.stringify(c1.json)),
    "an oversized receipt is refused with the stored-byte limit (not stored)",
    `${c1.status} ${JSON.stringify(c1.json)?.slice(0, 90)}`);

  // C2 — more receipts than the 3-photo cap
  const c2 = await post("/api/transactions", {
    businessId: created.businessId,
    type: "EXPENSE",
    category: "Supplies",
    amountGhs: 5,
    description: `${TAG} receipt-cap probe`,
    receiptImages: [tinyRecipe, tinyRecipe, tinyRecipe, tinyRecipe],
  });
  ok(c2.status === 400 && /at most 3 image/i.test(JSON.stringify(c2.json)),
    "a 4th receipt photo is refused by the per-record cap",
    `${c2.status} ${JSON.stringify(c2.json)?.slice(0, 90)}`);

  // C3 — a non-image payload in an image field
  const c3 = await post("/api/transactions", {
    businessId: created.businessId,
    type: "EXPENSE",
    category: "Supplies",
    amountGhs: 5,
    description: `${TAG} non-image probe`,
    receiptImage: "data:text/plain;base64,aGVsbG8=",
  });
  ok(c3.status === 400, "a non-image data URL is refused in a receipt field", `${c3.status}`);

  // C4 — more product photos than the 6-photo cap (validated before any write)
  const c4 = await post("/api/enterprise", {
    entityType: "inventory",
    data: {
      name: `${TAG} photo-cap probe`,
      businessId: created.businessId,
      quantity: 1,
      photos: [tinyRecipe, tinyRecipe, tinyRecipe, tinyRecipe, tinyRecipe, tinyRecipe, tinyRecipe],
    },
  });
  ok(c4.status === 400 && /at most 6 image/i.test(JSON.stringify(c4.json)),
    "a 7th product photo is refused by the per-record cap",
    `${c4.status} ${JSON.stringify(c4.json)?.slice(0, 90)}`);

  // C5 — a product photo over the 500 KB budget
  const c5 = await post("/api/enterprise", {
    entityType: "inventory",
    data: { name: `${TAG} oversize photo probe`, businessId: created.businessId, quantity: 1, photos: [bigRecipe(600)] },
  });
  ok(c5.status === 400, "an oversized product photo is refused", `${c5.status}`);

  // C6 — nothing above was persisted (the probes never reached the DB)
  const probeRows = await q(`select id from transactions where description like '${TAG}%probe%'`);
  const probeItems = await q(`select id from inventory_items where name like '${TAG}%probe%'`);
  ok(probeRows.length === 0 && probeItems.length === 0,
    "no refused payload reached the database",
    `${probeRows.length} txns, ${probeItems.length} items`);

  /* ── D. bootstrap slimming (/api/init) ── */
  const initJson = await page.evaluate(async () => {
    const r = await fetch("/api/init");
    try { return await r.json(); } catch { return null; }
  });
  const data = initJson?.data || initJson || {};
  const txns = Array.isArray(data.transactions) ? data.transactions : [];
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const txnImages = txns.filter((t) => t.receiptImage || (Array.isArray(t.receiptImages) && t.receiptImages.length));
  ok(txns.length > 0, "bootstrap carries the ledger", `${txns.length} rows`);
  ok(txnImages.length === 0, "no receipt photo ships on bootstrap (counts only)", `${txnImages.length} rows with images`);
  ok(txns.every((t) => t.receiptCount === undefined || typeof t.receiptCount === "number"), "receipt counts are published instead");
  const assetImgs = assets.filter((a) => Array.isArray(a.assetImages) && a.assetImages.length > 1);
  ok(assetImgs.length === 0, "assets ship at most one (thumbnail-sized) image on bootstrap", `${assetImgs.length} multi-image rows`);
  const bootstrapBytes = JSON.stringify(data.transactions || []).length + JSON.stringify(data.assets || []).length;
  ok(bootstrapBytes < 4 * 1024 * 1024, "ledger + assets bootstrap stays small", `${Math.round(bootstrapBytes / 1024)} KB`);
}

/* ══════════════════════════════════════════════════════════════════════════
   E. LIST-API WIRE BUDGET — no screen paints an image on these payloads, so
   no image bytes may travel. Each endpoint below used to ship the stored
   blob(s) because it selected the whole row; the wire-shaping layer
   (src/lib/imagePayload) now publishes indicators (`photoCount`, `hasPhoto`,
   `receiptCount`) instead. These checks fail if that regresses.
   ══════════════════════════════════════════════════════════════════════════ */
console.log("\n── E. list-API wire budget ──");
{
  const bid = created.businessId;
  // Local POST helper (the section-C helpers are block-scoped).
  const wirePost = (url, body) =>
    page.evaluate(
      async (u, b) => {
        const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
        let json = null;
        try { json = await r.json(); } catch { /* non-JSON */ }
        return { status: r.status, json };
      },
      url,
      body,
    );
  const wireReceipt = "data:image/jpeg;base64," + Buffer.from(makePng(24, 24)).toString("base64");
  const wireTargets = [
    ["transactions", `/api/transactions?businessId=${bid}`],
    ["transport", `/api/transport?businessId=${bid}`],
    ["block-factory", `/api/block-factory?businessId=${bid}`],
    ["poultry/feed-mill", `/api/poultry/feed-mill?businessId=${bid}`],
    ["aquaculture/feed-mill", `/api/aquaculture/feed-mill?businessId=${bid}`],
  ];
  const inventoryRows = [];
  for (const [label, url] of wireTargets) {
    const out = await page.evaluate(async (u) => {
      const res = await fetch(u);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON */ }
      const rows = [];
      for (const key of ["inventory", "rawMaterials", "finishedFeeds"]) {
        if (Array.isArray(json?.[key])) {
          for (const r of json[key]) {
            rows.push({
              key,
              id: r?.id,
              name: String(r?.name || ""),
              hasPhotoBlob: typeof r?.photo === "string" && r.photo.startsWith("data:"),
              hasPhotoField: r?.photo !== undefined && r?.photo !== null,
              count: r?.photoCount,
              hasPhoto: r?.hasPhoto,
              carriesPhotosArray: "photos" in (r || {}),
              carriesThumbArray: "photosThumb" in (r || {}),
            });
          }
        }
      }
      const txns = Array.isArray(json?.transactions) ? json.transactions : [];
      return {
        status: res.status, bytes: text.length,
        hasDataUri: text.includes("data:image"),
        rows,
        txnBad: txns.filter((t) => "receiptImage" in t || "receiptImages" in t).length,
        txnCounts: txns.map((t) => t?.receiptCount).filter((v) => v !== undefined),
      };
    }, url);
    ok(out.status === 200, `${label} GET succeeds`, `HTTP ${out.status}`);
    ok(!out.hasDataUri, `${label} ships no stored image bytes`, `${Math.round(out.bytes / 1024)} KB payload`);
    ok(out.txnBad === 0, `${label} ledger carries \`receiptCount\`, never a receipt blob`, `${out.txnBad} rows with receipt fields`);
    inventoryRows.push(...out.rows.map((r) => ({ ...r, label })));
  }
  const withArrays = inventoryRows.filter((r) => r.carriesPhotosArray || r.carriesThumbArray);
  ok(withArrays.length === 0, "no stock row carries the full photo/thumbnail arrays",
    withArrays.length ? `${withArrays.length} rows (${withArrays[0].label} #${withArrays[0].id})` : `${inventoryRows.length} rows checked`);
  const withBlob = inventoryRows.filter((r) => r.hasPhotoBlob || r.hasPhotoField);
  ok(withBlob.length === 0, "no stock row ships a photo at all (these screens paint text, not images)",
    withBlob.length ? `${withBlob.length} rows, e.g. ${withBlob[0].label} #${withBlob[0].id}` : `${inventoryRows.length} rows checked`);
  const flagged = inventoryRows.filter((r) => r.count === undefined);
  ok(flagged.length === 0, "every stock row publishes a numeric `photoCount`",
    flagged.length ? `${flagged.length} rows missing it` : "all rows");

  // The suite's own product really does have images — the payload just must
  // not carry them, and the row must still say so.
  const own = inventoryRows.find((r) => r.name === `${TAG} Optimized Product`);
  ok(!!own && own.hasPhoto === true && Number(own.count) >= 1,
    "a row that HAS images is published as hasPhoto + photoCount (no silent data loss)",
    own ? `hasPhoto=${own.hasPhoto} count=${own.count}` : "created product missing from the payloads");

  // A real receipt (not just the refused probes) proves `receiptCount` works.
  const posted = await wirePost("/api/transactions", {
    businessId: bid,
    type: "EXPENSE",
    category: "Supplies",
    amountGhs: 7,
    description: `${TAG} wire receipt probe`,
    receiptImage: wireReceipt,
  });
  if (posted.status === 200 && posted.json?.transaction?.id) {
    created.transactionIds.push(Number(posted.json.transaction.id));
    const listed = await page.evaluate(async (u) => {
      const res = await fetch(u);
      const text = await res.text();
      const j = JSON.parse(text);
      const t = (j.transactions || []).find((x) => String(x.description || "").includes("wire receipt probe"));
      return { found: !!t, count: t?.receiptCount, hasBlob: !!t && ("receiptImage" in t || "receiptImages" in t), anyBlob: text.includes("data:image") };
    }, `/api/transactions?businessId=${bid}`);
    ok(listed.found && listed.count === 1 && !listed.hasBlob && !listed.anyBlob,
      "a stored receipt is listed as `receiptCount: 1` with zero bytes on the wire",
      listed.found ? `count=${listed.count} blob=${listed.hasBlob}` : "posted row not found in the list");
  } else {
    ok(false, "a receipt-bearing expense can be posted for the wire probe", `${posted.status} ${JSON.stringify(posted.json)?.slice(0, 80)}`);
  }
}

} catch (err) {
  fail++;
  console.error("💥 suite error:", err?.message || err);
} finally {
  /* ───────────────────────── cleanup / restore ───────────────────────── */
  console.log("\n── cleanup ──");
  try {
    for (const id of created.inventoryIds) {
      await q(`delete from inventory_variants where inventory_id = $1 and business_id = $2`, [id, created.businessId]).catch(() => {});
      await q(`delete from inventory_items where id = $1`, [id]).catch(() => {});
    }
    for (const t of created.transactionIds) await q(`delete from transactions where id = $1`, [t]).catch(() => {});
    for (const r of restore) {
      await q(`update ${r.table} set ${r.column} = $1 where id = $2`, [r.value, r.id]).catch(() => {});
    }
    await q(`delete from inventory_items where name like '${TAG}%'`).catch(() => {});
    await q(`delete from transactions where description like '${TAG}%'`).catch(() => {});
    await q(`delete from user_sessions where created_at >= $1`, [suiteStart]).catch(() => {});
    console.log(`  removed ${created.inventoryIds.length} test item(s); restored ${restore.length} mutated record(s)`);
  } catch (e) {
    console.error("  cleanup warning:", e?.message);
  }
  await browser.close();
  await db.end();

  console.log("\n" + "─".repeat(56));
  console.log(fail === 0 ? `✅ ALL IMAGE-OPTIMIZATION CHECKS PASSED (${pass} checks)` : `❌ ${fail} FAILED of ${pass + fail} checks`);
  process.exit(fail === 0 ? 0 : 1);
}
