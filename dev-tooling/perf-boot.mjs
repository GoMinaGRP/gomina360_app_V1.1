#!/usr/bin/env node
/**
 * GoMina 360 — browser boot cost (real transferred bytes + slow-phone profile).
 *
 * Measures what a phone actually pays: JS/CSS/API bytes transferred (CDP
 * encodedDataLength, i.e. gzip/brotli sizes), time to the login screen, and
 * login → dashboard. The second pass repeats the run with 4G bandwidth and 4×
 * CPU throttling — the profile that matters for users in Ghana on low-end
 * Android handsets.
 *
 * Requirements (this repo already uses them for UI evidence scripts):
 *   - puppeteer-core  (resolved from PUPPETEER_CORE or a common node_modules path)
 *   - a Chromium/Chrome binary in CHROME (default: /tmp/al2023/chromium)
 *
 * Usage:
 *   node dev-tooling/perf-boot.mjs
 *   CHROME=/usr/bin/chromium BASE=http://127.0.0.1:3000 node dev-tooling/perf-boot.mjs
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const BASE = (process.env.BASE || "http://127.0.0.1:3000").replace(/\/$/, "");
const CHROME = process.env.CHROME || "/tmp/al2023/chromium";
const EMAIL = process.env.PERF_OWNER_EMAIL || "kwame.owner@gomina360.com";
const PASSWORD = process.env.PERF_OWNER_PASSWORD || "Owner@GoMina26";

function loadPuppeteer() {
  const candidates = [
    process.env.PUPPETEER_CORE,
    "/home/user/pgtooling/package.json",
    "/home/user/gomina360_app_V1.1/package.json",
  ].filter(Boolean);
  for (const anchor of candidates) {
    try {
      const require = createRequire(anchor);
      return require("puppeteer-core");
    } catch {
      /* try the next anchor */
    }
  }
  throw new Error(
    "puppeteer-core not found. Install it (npm i -D puppeteer-core) or set PUPPETEER_CORE=/path/to/package.json"
  );
}

if (!existsSync(CHROME)) {
  console.error(`Chromium not found at ${CHROME}. Set CHROME=/path/to/chromium.`);
  process.exit(1);
}

const puppeteer = loadPuppeteer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1366, height: 900 },
});

async function run(label, throttled) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  if (throttled) {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }

  const sizes = new Map();
  const urls = new Map();
  cdp.on("Network.requestWillBeSent", (e) => urls.set(e.requestId, e.request.url));
  cdp.on("Network.loadingFinished", (e) => sizes.set(e.requestId, e.encodedDataLength));

  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 180000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 90000 });
  const loginVisible = Date.now() - t0;

  const tLogin = Date.now();
  await page.type('[data-testid="login-email"]', EMAIL);
  await page.type('[data-testid="login-password"]', PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await page.waitForSelector('[data-testid="nav-sidebar"], [data-testid="command-center-root"]', { timeout: 180000 });
  const dashboardVisible = Date.now() - tLogin;
  await sleep(2500);

  const kind = { js: 0, css: 0, api: 0, html: 0, other: 0 };
  const apiCalls = [];
  const chunks = [];
  for (const [id, bytes] of sizes) {
    const u = (urls.get(id) || "").replace(BASE, "").split("?")[0];
    if (u.endsWith(".js")) { kind.js += bytes; chunks.push([u, bytes]); }
    else if (u.endsWith(".css")) kind.css += bytes;
    else if (u.startsWith("/api/")) { kind.api += bytes; apiCalls.push(u); }
    else if (u === "/" || u === "") kind.html += bytes;
    else kind.other += bytes;
  }
  chunks.sort((a, b) => b[1] - a[1]);
  const total = Object.values(kind).reduce((a, c) => a + c, 0);

  console.log(`\n──── ${label} ────`);
  console.log(`  login screen visible : ${loginVisible} ms`);
  console.log(`  login → dashboard    : ${dashboardVisible} ms`);
  console.log(`  transferred          : ${kb(total)}   (JS ${kb(kind.js)} in ${chunks.length} chunks · API ${kb(kind.api)} in ${apiCalls.length} calls · HTML ${kb(kind.html)} · other ${kb(kind.other)})`);
  console.log("  top JS chunks:");
  chunks.slice(0, 6).forEach(([u, b]) => console.log(`    ${kb(b).padStart(8)}  ${u.split("/").pop()}`));
  console.log("  API calls:");
  apiCalls.forEach((u) => console.log(`    ${u}`));
  await ctx.close();
}

console.log(`\nGoMina 360 boot-cost probe → ${BASE}  (chromium: ${CHROME})`);
await run("FAST NETWORK (baseline)", false);
await run("4G MOBILE + 4× CPU THROTTLE (slow-phone profile)", true);
await browser.close();
console.log("\nDone.\n");
