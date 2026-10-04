/**
 * image-audit-bench.mjs — AUDIT EVIDENCE (read-only; changes nothing).
 *
 * Reproduces the shipped client-side pipeline's EXACT encode steps
 * (drawScaled → canvas draw with imageSmoothingQuality "high" → toBlob at
 * preset mime/quality) on two realistic sources:
 *
 *   A. a 12 MP phone photo (4032×3024, textured) → what each preset stores
 *   B. a 12 MP document/scan (small printed text) → receipt vs document
 *      presets, plus higher-quality variants, written out as crops so the
 *      text legibility can be inspected.
 *
 * Preset numbers are read from src/lib/imageOptimize.ts so the benchmark can
 * never drift from the shipped policy.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");

const src = readFileSync("src/lib/imageOptimize.ts", "utf8");
const presets = {};
for (const m of src.matchAll(/^\s{2}(\w+):\s*\{([^}]*)\}/gm)) {
  const body = m[2];
  const num = (k) => Number(new RegExp(`${k}:\\s*([\\d._]+)`).exec(body)?.[1]?.replace(/_/g, ""));
  const thumb = /thumb:\s*\{\s*edge:\s*(\d+),\s*quality:\s*([\d.]+)/.exec(body);
  presets[m[1]] = {
    maxEdge: num("maxEdge"),
    quality: num("quality"),
    keepUnder: num("keepUnder"),
    keepAlpha: /keepAlpha:\s*true/.test(body),
    thumb: thumb ? { edge: Number(thumb[1]), quality: Number(thumb[2]) } : null,
  };
}
console.log("presets read from source:", JSON.stringify(presets, null, 0), "\n");

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setContent("<html><body></body></html>");

const cfg = { presets };
const out = await page.evaluate(async (cfg) => {
  const mk = (w, h) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  };
  const kb = (n) => Math.round(n / 1024);
  const bytes = (url) => Math.floor((url.length - url.indexOf(",") - 1) * 3 / 4);

  // ── A. phone photo: gradients + fine grain + colour blocks (like a real capture)
  const photo = mk(4032, 3024);
  {
    const ctx = photo.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 4032, 3024);
    g.addColorStop(0, "#3b5b8a"); g.addColorStop(0.5, "#c9a06a"); g.addColorStop(1, "#25402b");
    ctx.fillStyle = g; ctx.fillRect(0, 0, 4032, 3024);
    for (let i = 0; i < 1400; i++) {
      ctx.fillStyle = `hsl(${(i * 37) % 360} 55% ${30 + (i % 40)}%)`;
      ctx.fillRect(Math.random() * 4032, Math.random() * 3024, 20 + Math.random() * 260, 12 + Math.random() * 160);
    }
    const id = ctx.getImageData(0, 0, 4032, 3024);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 26; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    ctx.putImageData(id, 0, 0);
  }
  const photoJpeg = photo.toDataURL("image/jpeg", 0.92);

  // ── B. document/scan: white paper, dense small text lines (receipt/ID scan)
  const doc = mk(3024, 4032);
  {
    const ctx = doc.getContext("2d");
    ctx.fillStyle = "#fbfaf7"; ctx.fillRect(0, 0, 3024, 4032);
    ctx.fillStyle = "#15161a";
    ctx.font = "28px monospace";
    for (let y = 90; y < 3980; y += 44) {
      let line = "";
      for (let x = 0; x < 46; x++) line += String.fromCharCode(33 + ((y * 7 + x * 13) % 90));
      ctx.fillText(line, 60, y);
    }
    ctx.font = "bold 54px monospace";
    ctx.fillText("TOTAL  GH₵ 1,284.50", 60, 3980);
  }
  const docPng = doc.toDataURL("image/png");

  const drawScaled = (source, w, h, maxEdge) => {
    const s = Math.min(1, maxEdge / Math.max(w, h));
    const c = mk(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return c;
  };
  const encode = (canvas, mime, q) => canvas.toDataURL(mime, q); // data URL == what toBlob+FileReader yields

  const run = (source, w, h, preset, mime = "image/jpeg", q = preset.quality) => {
    const c = drawScaled(source, w, h, preset.maxEdge);
    const url = encode(c, mime, q);
    const r = { dims: `${c.width}×${c.height}`, mime, bytes: bytes(url), kb: kb(bytes(url)) };
    if (preset.thumb) {
      const t = drawScaled(source, w, h, preset.thumb.edge);
      let tu = encode(t, "image/webp", preset.thumb.quality);
      if (!tu.startsWith("data:image/webp")) tu = encode(t, "image/jpeg", preset.thumb.quality);
      r.thumb = { dims: `${t.width}×${t.height}`, mime: tu.slice(5, tu.indexOf(";")), kb: kb(bytes(tu)) };
      r.thumb.crop = tu;
    }
    r.url = url;
    return r;
  };

  const results = { photoSourceKB: kb(bytes(photoJpeg)), docSourceKB: kb(bytes(docPng)), presets: {} };
  for (const [name, p] of Object.entries(cfg.presets)) {
    results.presets[name] = run(photo, 4032, 3024, p);
    if (name === "receipt") {
      results.receiptQ90 = run(photo, 4032, 3024, p, "image/jpeg", 0.9);
      results.receiptQ95 = run(photo, 4032, 3024, p, "image/jpeg", 0.95);
    }
  }
  // Document source through the two text-legibility presets + a higher-quality variant
  results.docThrough = {
    receipt: run(doc, 3024, 4032, cfg.presets.receipt),
    receiptQ90: run(doc, 3024, 4032, cfg.presets.receipt, "image/jpeg", 0.9),
    document: run(doc, 3024, 4032, cfg.presets.document),
  };
  results.docCrops = {
    receipt: run(doc, 3024, 4032, cfg.presets.receipt).url,
    receiptQ92: run(doc, 3024, 4032, cfg.presets.receipt, "image/jpeg", 0.92).url,
    document: run(doc, 3024, 4032, cfg.presets.document).url,
  };
  results.docsCropSource = docPng;

  // ── C. document-preset variants: bytes + PSNR against the ideal render at
  //      the same target size (A4 portrait scan, 11.69in long edge).
  const a4In = 11.69;
  const variant = (maxEdge, mime, qc) => {
    const c = drawScaled(doc, 3024, 4032, maxEdge);          // "ideal" target (high-quality smoothing)
    const ideal = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const url = encode(c, mime, qc);
    const img = new Image();
    return new Promise((resolve) => {
      img.onload = () => {
        const cc = mk(c.width, c.height);
        cc.getContext("2d").drawImage(img, 0, 0);
        const got = cc.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let se = 0;
        for (let i = 0; i < got.length; i += 4) {
          const d0 = got[i] - ideal[i], d1 = got[i + 1] - ideal[i + 1], d2 = got[i + 2] - ideal[i + 2];
          se += d0 * d0 + d1 * d1 + d2 * d2;
        }
        const mse = se / (got.length / 4 * 3);
        resolve({
          dims: `${c.width}×${c.height}`, mime, kb: kb(bytes(url)), q: qc,
          dpiA4: Math.round((c.height / a4In)),
          psnr: mse > 0 ? Math.round(10 * Math.log10((255 * 255) / mse) * 10) / 10 : 99,
          url,
        });
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  };
  results.docVariants = {};
  for (const [name, args] of Object.entries({
    "current 2000 q0.88 JPEG": [2000, "image/jpeg", 0.88],
    "2000 q0.92 JPEG": [2000, "image/jpeg", 0.92],
    "2400 q0.88 JPEG": [2400, "image/jpeg", 0.88],
    "2400 q0.85 webp": [2400, "image/webp", 0.85],
    "2800 q0.85 webp": [2800, "image/webp", 0.85],
  })) {
    results.docVariants[name] = await variant(...args);
  }
  results.docVariantCrops = {
    cur2000: results.docVariants["current 2000 q0.88 JPEG"]?.url,
    webp2400: results.docVariants["2400 q0.85 webp"]?.url,
  };
  return results;
}, cfg);

const log = (label, r) => console.log(`${label.padEnd(26)} ${r.dims.padEnd(12)} ${String(r.mime).padEnd(11)} ${String(r.kb).padStart(6)} KB${r.thumb ? `   thumb ${r.thumb.dims} ${r.thumb.mime} ${r.thumb.kb} KB` : ""}`);
console.log(`\nA. 12 MP phone photo (4032×3024) — source JPEG q0.92 = ${out.photoSourceKB} KB`);
for (const [name, r] of Object.entries(out.presets)) log(`  ${name}`, r);
log("  receipt @ q0.90", out.receiptQ90);
log("  receipt @ q0.95", out.receiptQ95);
console.log(`\nB. 12 MP document scan (3024×4032) — source PNG = ${out.docSourceKB} KB`);
for (const [name, r] of Object.entries(out.docThrough)) log(`  ${name}`, r);

// write crops (top-left 900×300 of each result) for visual inspection
const fs = await import("node:fs");
const cropOut = await page.evaluate(async (imgs) => {
  const cut = async (url) => {
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.onerror = r; img.src = url; });
    const c = document.createElement("canvas");
    c.width = 1000; c.height = 300;                       // 1:1 pixels from the stored image
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1000, 300);
    ctx.drawImage(img, 60, 90, 1000, 300, 0, 0, 1000, 300);
    return c.toDataURL("image/png");
  };
  const o = {};
  for (const [k, v] of Object.entries(imgs)) o[k] = await cut(v);
  return o;
}, { receipt: out.docCrops.receipt, receiptQ92: out.docCrops.receiptQ92, document: out.docCrops.document, doc2400webp: out.docVariantCrops.webp2400 });
for (const [k, v] of Object.entries(cropOut)) {
  fs.writeFileSync(`/home/user/audit-crop-${k}.png`, Buffer.from(v.split(",")[1], "base64"));
}
console.log("\nC. document-preset variants (A4 portrait scan, 11.69in long edge)");
for (const [name, r] of Object.entries(out.docVariants)) {
  if (r) console.log(`  ${name.padEnd(24)} ${r.dims.padEnd(12)} ${String(r.kb).padStart(5)} KB  ${String(r.dpiA4).padStart(4)} DPI  PSNR ${r.psnr} dB`);
}
console.log("\ncrops written: /home/user/audit-crop-receipt.png, -receiptQ92.png, -document.png");
await browser.close();
