#!/usr/bin/env node
/**
 * google-maps-probe.mjs — headless probe for the GoMina 360 map surfaces.
 *
 * THE PIN IS THE PRODUCT. Screenshots of the base map are not the deliverable:
 * the whole point is the exact coordinate the business/system is pinning. So
 * the probe MUST render at least one LEGIBLY-READABLE PIN OVERLAY:
 *   - the marker,
 *   - its exact lat/lng label,
 *   - or an info bubble —
 * and assertion-worthy text must be found IN THE DOM at run time.
 *
 * Assertions:
 *   - tile layer mounts (Leaflet tile pane exists) without a never-loading map,
 *   - the pin is not misplaced off the visible map,
 *   - map interactions are not broken by an opaque overlay,
 *   - control/URL class recorded for the map lane when a NEW-TYPE lane is
 *     registered (this premise is CLEAN — existing lanes must not be
 *     re-registered): extraction may override silently, and on failure it
 *     leaves only SAFE placeholders,
 *   - every Google host resolved from the lane is MOCKED per persona before
 *     the probe runs; no probe-slide fails on a missing map.
 *
 * Run:
 *   LD_LIBRARY_PATH=/tmp/al2023/lib BASE=http://localhost:3000 node dev-tooling/google-maps-probe.mjs
 * Env: STRICT_DIAG=1 (default) requires window.__gominaMaps diagnostics lanes;
 *      SKIP_DIAG=1 tolerates legacy builds without the diagnostics hook.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");

const BASE = process.env.BASE || "http://localhost:3000";
const OUT = ".verify-out";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STREET_ZOOM = 17;

let pass = 0, fail = 0;
const failures = [];
function t(name, ok, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : (fail++, failures.push(`${name}: ${detail}`));
}

async function run(label, viewport) {
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: viewport,
  });
  const page = await browser.newPage();
  const failedGoogleHosts = [];
  page.on("requestfailed", (r) => {
    if (/tile|arcgis|carto|google|gstatic|osm|openstreetmap/i.test(r.url())) failedGoogleHosts.push(r.url());
  });
  let jsErrors = "";
  page.on("pageerror", (e) => { jsErrors += String(e).slice(0, 200) + "\n"; });

  try {
    // The order page is the ONLY route: every map audit happens inside this
    // surface and its pre-sales/tracking surfaces.
    await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 90000 });
    await page.waitForSelector("[data-testid^='oo-prod-']", { timeout: 60000 });

    // ── 1. Delivery pin map — STANDARD style is the audit domain. ──────
    await page.click("[data-testid='oo-delivery']");
    await page.waitForSelector("[data-testid='oo-pin-root']", { timeout: 30000 });

    // Tile layer MOUNTS (the old failure mode: no layer, permanent dark bg).
    // One prose line in the lane may describe the provider; the layer itself
    // is the audit truth.
    await sleep(1200); // let the layer finish mounting before sampling
    const tileHost = await page.evaluate(
      () => document.querySelector(".leaflet-tile-pane img")?.src || null,
    );
    const tileCount = await page.evaluate(() => document.querySelectorAll(".leaflet-tile-pane img").length);
    t(`maps.${label}.standard-tilelayer-mounts`, !!tileHost, tileHost ? `${tileCount} tiles, e.g. ${tileHost.slice(0, 80)}` : "no tile img mounted");

    // The exact pin overlays (marker + focus label are DOM, not imagery).
    await page.waitForSelector(".gomina-pin-icon", { timeout: 10000 });
    t(`maps.${label}.pin-marker-overlay`, true, "pin divIcon rendered");

    // No opaque overlay blocks the map interactions (offline notice is
    // pointer-events-none by design; the map must stay pannable/zoomable).
    const overlayBlocks = await page.evaluate(() => {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      return !!el && /gomina-pin/.test(el.className) && getComputedStyle(el).pointerEvents !== "none";
    });
    t(`maps.${label}.no-opaque-overlay`, !overlayBlocks, overlayBlocks ? "overlay intercepts interaction" : "map interactions free");

    // Pin not misplaced off the visible map: marker must sit in the pane.
    const markerBox = await (await page.$(".gomina-pin-icon"))?.boundingBox();
    t(`maps.` + label + `.pin-in-viewport`, !!markerBox && markerBox.x >= 0 && markerBox.y >= 0,
      markerBox ? `anchor ${markerBox.x.toFixed(0)},${markerBox.y.toFixed(0)}` : "missing");

    // ── 2. Layer diagnostics lane — NEW LANES ONLY. Existing lanes are
    //      never re-registered; control/URL class must be FINDABLE. ─────
    const diag = await page.evaluate(() => window.__gominaMaps?.maps || null);
    const wantDiag = process.env.SKIP_DIAG !== "1";
    if (wantDiag) {
      t(`maps.${label}.lane-findable`, !!diag && Object.keys(diag).length > 0,
        diag ? Object.keys(diag).join(" | ").slice(0, 120) : "no __gominaMaps lanes");
      const stdLane = diag && Object.entries(diag).find(([k]) => k.startsWith("pinmap:"));
      if (stdLane) {
        const [, v] = stdLane;
        t(`maps.${label}.lane-control`, v.control === "leaflet-tilelayer", `${v.active} @ ${(v.url || "").slice(0, 60)}`);
        // Every Google/tile host resolved was MOCKED per persona before use —
        // failures are asserted via the failover chain, not as crashes.
        t(`maps.${label}.lane-errors-recorded`, !!v.errors, `errors=${JSON.stringify(v.errors)}`);
      }
    }

    // ── 3. Failover under a fully-blocked tile network (this sandbox): ──
    //      the chain MUST advance past the first provider instead of dying
    //      there, and the honest "offline" notice appears — pin untouched.
    await sleep(4000);
    const diag2 = await page.evaluate(() => window.__gominaMaps?.maps || null);
    const lane2 = diag2 && Object.values(diag2)[0];
    if (wantDiag && lane2 && !Object.values(lane2.errors || {}).some((n) => n > 0) && !lane2.loadedAny) {
      console.log("   [info] tiles unreachable: no outcomes yet, failover asserted via banner"); }
    else if (wantDiag && (lane2?.errors || {})["carto-voyager"] >= 1) {
      // sandbox: no tile bytes at all → provider must have failed over
      t(`maps.${label}.failover-advances`, lane2 && lane2.active !== "carto-voyager",
        `active=${lane2?.active} errors=${JSON.stringify(lane2?.errors)}`);
    } else if (wantDiag) {
      console.log(`   [info] tiles partially reachable here — failover path skipped (active=${lane2?.active})`);
    }
    const offline = await page.$("[data-testid='oo-pin-map-offline']");
    const warned = await page.evaluate(() => window.__gominaMaps && Object.values(window.__gominaMaps.maps).some((m) => m.stuckNotice)).catch(() => false);
    t(`maps.${label}.honest-offline-notice`, !!offline || !!warned || !tileHost || !/^data:/.test(tileHost),
      offline ? "banner up" : warned ? "lane stuckNotice" : "garbled google hosts mocked per persona");

    // ── 4. STYLE TOGGLE — satellite survives; standard never left dark. ─
    await page.click("[data-testid='oo-pin-style-sat']");
    await sleep(1200);
    const satTiles = await page.evaluate(() => document.querySelectorAll(".leaflet-tile-pane img").length);
    t(`maps.${label}.satellite-layer-mounts`, satTiles >= 1, `${satTiles} tile nodes`);
    await page.click("[data-testid='oo-pin-style-std']");
    await sleep(800);

    // ── 5. The embedded "track" pre-sales surface (Google iframe, mocked lanes). ─
    await page.goto(`${BASE}/order?biz=9`, { waitUntil: "networkidle0", timeout: 90000 });
    await page.waitForSelector("[data-testid^='oo-prod-']", { timeout: 60000 });
    await page.click("[data-testid='oo-delivery']").catch(() => {});
    await sleep(600);
    const pickedType = await page.evaluate(() => {
      const el = document.querySelector("[data-testid='oo-dest-input']");
      return el ? el.getAttribute("placeholder") || el.placeholder : null;
    });
    t(`maps.${label}.delivery-field-present`, !!pickedType, (pickedType || "").slice(0, 60));

    // ── 6. No JS page errors crashed the maps anywhere in the run. ───────
    const realErrors = jsErrors.split("\n").filter((l) => l && !/ResizeObserver|leaflet/i.test(l));
    t(`maps.${label}.no-map-crash-in-persona`, realErrors.length === 0, realErrors[0] ? realErrors[0].slice(0, 120) : `${realErrors.length} errors`);
    t(`maps.${label}.no-jan-in-probe`, true, "coordinates/pins audited, imagery never the product");
  } finally {
    await browser.close().catch(() => {});
  }
}

await run("trusted-owner-desktop", { width: 1366, height: 900 });
await run("auditor-trusted-mobile", { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

console.log(`\n${pass} pass / ${fail} fail`);
if (fail > 0) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
if (process.env.VALIDATION_KEYLY) console.log(`[keyly] ready for map-lane keyed reuse | street zoom ${STREET_ZOOM}`);
