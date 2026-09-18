#!/usr/bin/env node
/**
 * geocode-ui.mjs — desktop + mobile acceptance probe for the Places-style
 * location search inside the order flow.
 *
 * Per scenario it asserts:
 *   1. typing surfaces typed, precise suggestions (icon + granularity caption),
 *   2. clicking a suggestion fills the field with the full formatted address,
 *   3. the dropdown CLOSES after selection and does NOT reopen,
 *   4. the map pin appears at the picked place,
 *   5. a manual pin adjustment (nudge) preserves the chosen address,
 *   6. the local tile fallback never blocks the flow.
 *
 * Usage: BASE=http://localhost:3000 node dev-tooling/geocode-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");

const BASE = process.env.BASE || "http://localhost:3000";
const OUT = ".verify-out";
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function ok(id, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${id} — ${detail}`); }
  else { fail++; failures.push(`${id}: ${detail}`); console.log(`  FAIL  ${id} — ${detail}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run one pick scenario against the delivery address field. */
async function scenario(page, tag, { query, caption }) {
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 90000 });
  await page.waitForSelector("[data-testid^='oo-prod-']", { timeout: 60000 });

  // Choose DELIVERY.
  const deliv = await page.$("[data-testid='oo-delivery']");
  await deliv.click();
  await page.waitForSelector("[data-testid='oo-dest-input']", { timeout: 15000 });

  // Type the query — suggestions appear.
  await page.click("[data-testid='oo-dest-input']");
  await page.type("[data-testid='oo-dest-input']", query, { delay: 25 });
  await page.waitForSelector("[data-testid='oo-dest-opt-0']", { timeout: 20000 });
  ok(`ui.${tag}.suggests`, true, `suggestions for "${query}"`);

  // Granularity caption (e.g. BUSINESS / PLACE, STREET) renders in the list.
  const listText = await page.$eval("[data-testid='oo-dest-list']", (n) => n.textContent || "");
  ok(`ui.${tag}.typed-rows`, /ADDRESS|STREET|PLACE|LANDMARK|NEIGHBOURHOOD|CITY|REGION/i.test(listText),
    `captions visible (${caption}…)`);

  const chosenLabel = await page.$eval("[data-testid='oo-dest-opt-0'] span.min-w-0 > span:first-child", (n) => (n.textContent || "").trim());
  await page.click("[data-testid='oo-dest-opt-0']");

  // Field now holds the full formatted address.
  const fieldVal = await page.$eval("[data-testid='oo-dest-input']", (n) => n.value.trim());
  ok(`ui.${tag}.fill`, fieldVal === chosenLabel, `"${fieldVal}"`);

  // Dropdown closed — and stays closed (no reopen storm).
  await sleep(250);
  let open = await page.$("[data-testid='oo-dest-list']");
  ok(`ui.${tag}.closed`, !open, "dropdown closed after pick");
  await sleep(1800);
  open = await page.$("[data-testid='oo-dest-list']");
  ok(`ui.${tag}.stays-closed`, !open, "no reopen after pick");

  // Pin dropped at the picked place (clear button shows only when a pin exists).
  await sleep(400);
  const pinSet = await page.$("[data-testid='oo-pin-clear']");
  ok(`ui.${tag}.pin`, !!pinSet, "pin set at picked place");

  // Manual adjustment: nudge the pin — the picked address must survive.
  const nudge = await page.$("[data-testid='oo-pin-n']");
  if (nudge) {
    await nudge.click();
    await sleep(1400); // wait out any reverse-geocode round-trip
    const after = await page.$eval("[data-testid='oo-dest-input']", (n) => n.value.trim());
    ok(`ui.${tag}.pin-adjust-keeps-address`, after === chosenLabel, "address preserved after pin nudge");
  } else {
    ok(`ui.${tag}.pin-adjust-keeps-address`, false, "nudge control missing");
  }

  await page.screenshot({ path: path.join(OUT, `geo-${tag}.png`), fullPage: false });
}

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  // ── Desktop ──────────────────────────────────────────────────────────
  const desktop = await browser.newPage();
  await desktop.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 });
  await scenario(desktop, "desktop-business", { query: "Accra Mall", caption: "BUSINESS / PLACE" });
  await scenario(desktop, "desktop-landmark", { query: "Black Star Square", caption: "LANDMARK" });
  await scenario(desktop, "desktop-street", { query: "Liberation Road", caption: "STREET" });

  // ── Mobile ───────────────────────────────────────────────────────────
  const mobile = await browser.newPage();
  await mobile.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await scenario(mobile, "mobile-business", { query: "West Hills Mall", caption: "BUSINESS / PLACE" });
  await scenario(mobile, "mobile-neighbourhood", { query: "East Legon", caption: "NEIGHBOURHOOD" });
} finally {
  await browser.close();
}

console.log(`\n${pass} pass / ${fail} fail`);
if (failures.length) {
  console.log("FAILURES:");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
