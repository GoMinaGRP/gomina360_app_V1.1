#!/usr/bin/env node
/**
 * maps-audit.mjs — before/after standard-map evidence capture.
 * Renders the order page pin map (desktop), waits, screenshots to the given
 * directory, and records the tile layer + diagnostics state as JSON.
 *
 * Run: LD_LIBRARY_PATH=/tmp/al2023/lib OUTDIR=.evidence/maps-audit/before node dev-tooling/maps-audit.mjs
 */
import fs from "node:fs";
import { createRequire } from "module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");

const BASE = process.env.BASE || "http://localhost:3000";
const OUTDIR = process.env.OUTDIR || ".evidence/maps-audit/before";
fs.mkdirSync(OUTDIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1366, height: 900 },
});
const page = await browser.newPage();
try {
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 90000 });
  await page.waitForSelector("[data-testid^='oo-prod-']", { timeout: 60000 });
  await page.click("[data-testid='oo-delivery']");
  await page.waitForSelector("[data-testid='oo-pin-root']", { timeout: 30000 });
  await sleep(3500); // allow tile outcomes + failover chain to settle

  const state = await page.evaluate(() => ({
    tileImgs: [...document.querySelectorAll(".leaflet-tile-pane img")].map((i) => i.src.slice(0, 90)),
    banner: !!document.querySelector("[data-testid='oo-pin-map-offline']"),
    constrolText: document.querySelector("[data-testid='oo-pin-root']")?.innerText?.slice(0, 120) || "",
    lanes: window.__gominaMaps?.maps || null,
  }));

  // scroll the map into view for the shot
  await page.evaluate(() => document.querySelector("[data-testid='oo-pin-root']")?.scrollIntoView({ block: "center" }));
  await sleep(400);
  await page.screenshot({ path: `${OUTDIR}/standard-map-desktop.png` });
  fs.writeFileSync(`${OUTDIR}/state.json`, JSON.stringify(state, null, 2));
  console.log("captured:", OUTDIR);
  console.log("tile imgs:", state.tileImgs.length, "| banner:", state.banner, "| lanes:", state.lanes ? Object.keys(state.lanes).length : "(legacy — none)");
} finally {
  await browser.close().catch(() => {});
}
