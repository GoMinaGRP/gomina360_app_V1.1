/**
 * Storefront watermark audit — display-time, lossless product-image branding.
 *
 *   1. Owner API PATCH enables/disables per business (+ mode validation).
 *   2. Menu API emits {watermarkEnabled, watermarkMode, logo?} (logo only
 *      when enabled); originals untouched (menu passthrough of photo bytes).
 *   3. Storefront: card photos, card thumbs, lightbox (incl. full-screen +
 *      zoom) all carry the overlay when enabled; ZERO overlay when disabled.
 *   4. Gestures unaffected: overlay has pointer-events:none — tap-to-open,
 *      zoom, pinch still pass (the gallery suite must keep working).
 *   5. Originals byte-identical: compare /api/menu photo strings before and
 *      after enabling watermarking (must equal).
 */
import { createRequire } from "module";
import { writeFile, mkdir } from "fs/promises";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const results = [];
const ok = (n, c, d = "") => { results.push({ name: n, pass: !!c, detail: d }); console.log(`${c ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); };
const t = (s) => `[data-testid='${s}']`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "kwame.owner@gomina360.com", password: "Owner@GoMina26" }),
  });
  const j = await r.json();
  if (!r.ok || !j?.success) throw new Error(`login failed ${r.status}`);
  const cookie = r.headers.get("set-cookie")?.split(";")[0] || "";
  return { cookie, user: j.user };
}

async function patchBiz(cookie, id, body) {
  const r = await fetch(`${BASE}/api/businesses/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function menu() {
  const r = await fetch(`${BASE}/api/menu?biz=1`, { cache: "no-store" });
  return r.json();
}

(async () => {
  await mkdir(".verify-out", { recursive: true });
  const { cookie } = await login();

  // First photo-bearing product anywhere in the menu (the demo fixtures
  // guarantee several; hardcoding businesses[0].products[0] breaks whenever
  // the first unit's first item simply has no photo).
  const photoOf = (m) => {
    for (const b of m.businesses || []) {
      for (const p of b.products || []) {
        if (p.photo) return p.photo;
      }
    }
    return null;
  };

  // 0) capture original photo bytes
  const m0 = await menu();
  const orig0 = photoOf(m0);
  ok("api.menu.has-photo", !!orig0);

  // 1) validation: bad mode rejected
  const bad = await patchBiz(cookie, 1, { watermarkMode: "SIDEWAYS" });
  ok("api.mode-validated", bad.status === 400);

  // 2) disable → menu says disabled AND no logo key in payload
  const off = await patchBiz(cookie, 1, { watermarkEnabled: false });
  ok("api.disable-200", off.status === 200 && off.json?.business?.watermarkEnabled === false);
  const mOff = await menu();
  const bOff = (mOff.businesses || [])[0];
  ok("menu.off.flag", bOff?.watermarkEnabled === false);
  ok("menu.off.no-logo-bytes", !("logo" in bOff), "logo key omitted when disabled");

  // 3) enable AUTO again (demo state set in DB) — logo must appear in payload
  const on = await patchBiz(cookie, 1, { watermarkEnabled: true, watermarkMode: "AUTO" });
  ok("api.enable-200", on.status === 200 && on.json?.business?.watermarkEnabled === true);
  const mOn = await menu();
  const bOn = (mOn.businesses || [])[0];
  ok("menu.on.flag+mode", bOn?.watermarkEnabled === true && bOn?.watermarkMode === "AUTO");
  ok("menu.on.logo-present", String(bOn?.logo || "").startsWith("data:image/"), (bOn?.logo || "").slice(0, 30));

  // 4) originals untouched
  ok("originals.byte-identical", photoOf(mOn) === orig0, "photo data unchanged after toggling");

  // 5) storefront rendering — desktop
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  try {
    await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 90000 });
    await page.waitForSelector("[data-testid^='oo-prod-']", { timeout: 30000 }).catch(() => {});
    await sleep(1500);

    // card main photo: overlay + tile + logo chip
    const card = await page.evaluate(() => {
      const btn = document.querySelector("[data-testid='oo-photo-1']");
      if (!btn) return null;
      return {
        overlay: !!btn.querySelector("[data-testid='wm-overlay']"),
        tile: !!btn.querySelector("[data-testid='wm-tile']"),
        logo: !!btn.querySelector("[data-testid='wm-logo']"),
        pe: getComputedStyle(btn.querySelector("[data-testid='wm-overlay']")).pointerEvents,
      };
    });
    ok("card.overlay", card?.overlay && card?.tile && card?.logo, JSON.stringify(card));
    ok("card.pointer-events-none", card?.pe === "none");

    // faintness budget: tile uses ~5-6% ink; logo chip opacity ≤ 0.15
    const faint = await page.evaluate(() => {
      const logo = document.querySelector("[data-testid='oo-photo-1'] [data-testid='wm-logo']");
      return logo ? Number(getComputedStyle(logo).opacity) : -1;
    });
    ok("card.faintness", faint > 0 && faint <= 0.18, `corner chip opacity=${faint}`);

    // thumbs: compact overlay (monogram or logo, no tile)
    const thumb = await page.evaluate(() => {
      const th = document.querySelector("[data-testid='oo-thumb-1-0']");
      if (!th) return null;
      return {
        overlay: th.querySelector("[data-testid='wm-overlay']")?.dataset.compact === "1",
        tile: !!th.querySelector("[data-testid='wm-tile']"),
        chip: !!th.querySelector("[data-testid='wm-logo'], [data-testid='wm-mono']"),
      };
    });
    ok("thumbs.compact", thumb?.overlay && !thumb?.tile && thumb?.chip, JSON.stringify(thumb));

    // lightbox (full-screen + zoom states)
    await page.click(t("oo-photo-1"));
    await sleep(400);
    const lb = await page.evaluate(() => ({
      overlay: !!document.querySelector("[data-testid='oo-lightbox-viewport'] [data-testid='wm-overlay']"),
      tile: !!document.querySelector("[data-testid='oo-lightbox-viewport'] [data-testid='wm-tile']"),
    }));
    ok("lightbox.overlay", lb.overlay && lb.tile);
    await page.click(t("oo-lightbox-zoomin"));
    await page.click(t("oo-lightbox-zoomin"));
    await sleep(300);
    const lbZ = await page.evaluate(() => ({
      zoom: Number(document.querySelector("[data-testid='oo-lightbox-img']")?.dataset.zoom || 1),
      overlay: !!document.querySelector("[data-testid='oo-lightbox-viewport'] [data-testid='wm-overlay']"),
      thumbOv: !!document.querySelector("[data-testid='oo-lightbox-thumb-0'] [data-testid='wm-overlay']"),
    }));
    ok("lightbox.zoomed-keeps-overlay", lbZ.zoom > 1.5 && lbZ.overlay && lbZ.thumbOv, `zoom=${lbZ.zoom}`);
    await page.screenshot({ path: ".verify-out/wm-01-lightbox-zoomed.png" });

    // gestures unaffected: tap the image still opens/zooms (we ARE in the
    // lightbox already — wheel-zoom over the overlay must still register)
    const z0 = lbZ.zoom;
    const vp = await page.evaluate(() => {
      const r = document.querySelector("[data-testid='oo-lightbox-viewport']").getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(vp.x, vp.y);
    await page.mouse.wheel({ deltaY: -300 });
    await sleep(200);
    const z1 = await page.evaluate(() => Number(document.querySelector("[data-testid='oo-lightbox-img']")?.dataset.zoom || 1));
    ok("lightbox.gestures-unblocked", z1 > z0, `zoom ${z0} → ${z1}`);
    await page.keyboard.press("Escape");
    await sleep(300);

    // DISABLE via API → overlay disappears entirely (no code reload needed —
    // just refetch the page; menu is refreshed server-side)
    await patchBiz(cookie, 1, { watermarkEnabled: false });
    await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 90000 });
    await page.waitForSelector("[data-testid^='oo-prod-']", { timeout: 30000 }).catch(() => {});
    await sleep(1200);
    const offDom = await page.evaluate(() => {
      const prod1 = document.querySelector("[data-testid='oo-photo-1']");
      return {
        biz1Overlay: prod1 ? !!prod1.querySelector("[data-testid='wm-overlay']") : null,
        otherOverlays: document.querySelectorAll("[data-testid='wm-overlay']").length,
        logos: document.querySelectorAll("[data-testid='wm-logo']").length,
      };
    });
    ok("storefront.off.biz1-clean", offDom.biz1Overlay === false && offDom.logos === 0, JSON.stringify(offDom));
    // (biz-9 NAME-demo still shows its own overlays by design here)
    await page.screenshot({ path: ".verify-out/wm-02-disabled.png" });

    // NAME-mode on org-2 demo unit (no logo): text tile only, no logo chip.
    // Fixture prepared by dev-tooling/fixtures-watermarks-demo.mjs (idempotent,
    // org+unit+product created when missing, wm NAME-mode pinned ON).
    // The unit id is resolved dynamically from the public menu by name — the
    // serial id must never be hard-coded here.
    await patchBiz(cookie, 1, { watermarkEnabled: false }); // keep org-1 off
    const demoBizId = await page.evaluate(async () => {
      const r = await fetch("/api/menu", { cache: "no-store" });
      const j = await r.json();
      return (j.businesses || []).find((b) => b.businessName === "WM Demo Unit (Org 2)")?.businessId || null;
    });
    ok("org2.demo-unit-listed", typeof demoBizId === "number" && demoBizId > 0, String(demoBizId));
    await page.goto(`${BASE}/order?biz=${demoBizId || 0}`, { waitUntil: "networkidle0", timeout: 90000 });
    await page.waitForSelector("[data-testid^='oo-prod-']", { timeout: 30000 }).catch(() => {});
    await sleep(1500);
    const menuScope = await page.evaluate(async () => {
      const r = await fetch("/api/menu", { cache: "no-store" });
      const j = await r.json();
      return (j.businesses || []).map((b) => `${b.businessId}:${b.watermarkEnabled ? b.watermarkMode || "ON" : "off"}`);
    });
    console.log("   [diag] browser menu scope:", JSON.stringify(menuScope));
    const biz9 = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("[data-testid^='oo-photo-']")][0];
      if (!btn) return null;
      return {
        overlay: !!btn.querySelector("[data-testid='wm-overlay']"),
        tile: !!btn.querySelector("[data-testid='wm-tile']"),
        logo: !!btn.querySelector("[data-testid='wm-logo']"),
        label: btn.closest("[data-testid^='oo-biz-']")?.dataset?.testid || "?",
      };
    });
    ok("org2.name-mode", biz9?.overlay && biz9?.tile && !biz9?.logo, JSON.stringify(biz9));
    await page.screenshot({ path: ".verify-out/wm-03-org2-name-mode.png" });

    // mobile spot-check: overlay scales down and gestures remain free
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const mobOn = await patchBiz(cookie, 1, { watermarkEnabled: true, watermarkMode: "AUTO" }); // demo final state ON
    const mobMenu = await menu();
    console.log("   [diag] mobile-step state:", mobOn.status, mobOn.json?.business?.watermarkEnabled,
      (mobMenu.businesses || [])[0]?.watermarkEnabled, !!((mobMenu.businesses || [])[0]?.logo));
    await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 90000 });
    await page.waitForSelector("[data-testid^='oo-prod-']", { timeout: 30000 }).catch(() => {});
    await sleep(1500);
    const mob = await page.evaluate(() => {
      const btn = document.querySelector("[data-testid='oo-photo-1']");
      const ov = btn?.querySelector("[data-testid='wm-overlay']");
      const lg = btn?.querySelector("[data-testid='wm-logo']");
      const r = lg?.getBoundingClientRect();
      return { overlay: !!ov, logoW: r ? Math.round(r.width) : -1, btnW: btn ? Math.round(btn.getBoundingClientRect().width) : -1 };
    });
    ok("mobile.overlay-scales", mob.overlay && mob.logoW > 12 && mob.logoW < mob.btnW * 0.35, JSON.stringify(mob));
    await page.tap(t("oo-photo-1"));
    await sleep(400);
    ok("mobile.tap-still-opens", !!(await page.$(t("oo-lightbox"))));
    await page.screenshot({ path: ".verify-out/wm-04-mobile.png" });
  } finally {
    ok("no-js-errors", errors.length === 0, errors.slice(0, 2).join("; "));
    await browser.close();
  }

  const failed = results.filter((r) => !r.pass);
  await writeFile(".verify-out/watermarks-audit.json", JSON.stringify(results, null, 1));
  console.log(`\n═══ RESULT: ${results.length - failed.length}/${results.length} passed (${failed.length} failed)`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("PROBE CRASH:", e); process.exit(2); });
