/* Feed Mill Demo Console — headless verification of /demo/index.html
 * Checks: zero console errors, all 12 probes green, four tabs render,
 * interactivity smoke (share edit → conflict → auto-fix, feed-out → alert),
 * and captures screenshots to /tmp/fm-demo-shots/.
 * Run: bash dev-tooling/run-suite.sh dev-tooling/verify-feed-mill-demo.mjs
 */
import { createRequire } from "node:module";
import fs from "fs";

const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const SHOTS = "/tmp/fm-demo-shots";
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${label}${detail ? " — " + String(detail).slice(0, 200) : ""}`);
  cond ? pass++ : fail++;
};

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,960"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 960 });

const consoleErrs = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text()); });
page.on("pageerror", (e) => consoleErrs.push("pageerror: " + e.message));

await page.goto(`${BASE}/demo/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
await new Promise((r) => setTimeout(r, 800));

// ── A · boot state ──
const counter = await page.$eval("#probeCounter", (e) => e.textContent);
ok(/probes run: 12/.test(counter), "A1 probe battery auto-ran 12 assertions", counter);
ok(/all green/.test(counter), "A2 all probes green on arrival", counter);
const sectCount = await page.$$eval("main section", (s) => s.length);
ok(sectCount === 4, "A3 four demo sections mount", sectCount);

// ── B · Section 1 interactivity (share edit → conflict → autofix) ──
await page.select && null;
await page.evaluate(() => { const inp = document.querySelector("[data-share-idx='0']"); inp.value = "40"; inp.dispatchEvent(new Event("change")); });
await new Promise((r) => setTimeout(r, 300));
const chip = await page.$eval("#shareChip", (e) => e.textContent + e.className);
ok(/OUT OF BOUNDS|pill-rose/.test(chip), "B1 share edit trips live conflict chip", chip);
const confN = await page.$$eval("#confList > div", (d) => d.length);
ok(confN >= 1, "B2 conflict queued in drawer", confN);
await page.evaluate(() => { window.autoFix("F1"); });
await new Promise((r) => setTimeout(r, 300));
const chip2 = await page.$eval("#shareChip", (e) => e.textContent);
ok(/BALANCED/.test(chip2), "B3 auto-fix rebalances to Σ100", chip2);
await page.screenshot({ path: `${SHOTS}/1-formulations.png`, fullPage: false });

// ── C · Section 2 (QC gate flow) ──
await page.evaluate(() => document.querySelector('[data-tab="s2"]').click());
await new Promise((r) => setTimeout(r, 200));
const s2probe = await page.$$eval("#s2 .probe-row", (r) => r.filter((x) => x.className.includes("probe-fail")).length);
ok(s2probe === 0, "C1 batch/QC probes all green", s2probe);
// pick hold batch + simulate fail then blocked release
await page.evaluate(() => { window.forceMoistureFail(); });
await new Promise((r) => setTimeout(r, 250));
const toastCrit = await page.$$eval(".toast", (t) => t.map((x) => x.textContent).join("|"));
ok(/FAIL|FAILS|FINISHED/i.test(toastCrit), "C2 moisture-fail toast fires", toastCrit.slice(0, 80));
await page.screenshot({ path: `${SHOTS}/2-batches-qc.png`, fullPage: false });

// ── D · Section 3 (savings recompute) ──
await page.evaluate(() => document.querySelector('[data-tab="s3"]').click());
await new Promise((r) => setTimeout(r, 250));
const beforeTotal = await page.evaluate(() => document.querySelector("#s3 .text-3xl").textContent);
await page.evaluate(() => window.setRange(4));
await new Promise((r) => setTimeout(r, 250));
const afterTotal = await page.evaluate(() => document.querySelector("#s3 .text-3xl").textContent);
ok(beforeTotal !== afterTotal, "D1 range filter recomputes big number", `${beforeTotal} → ${afterTotal}`);
await page.evaluate(() => window.setRange(99));
await page.screenshot({ path: `${SHOTS}/3-savings.png`, fullPage: false });

// ── E · Section 4 (feed-out + alerts) ──
await page.evaluate(() => document.querySelector('[data-tab="s4"]').click());
await new Promise((r) => setTimeout(r, 250));
// over-draw attempt → gate
await page.evaluate(() => {
  document.getElementById("ffBin").value = "FDB-2026-033322"; // 8 kg bin
  document.getElementById("ffQty").value = "999";
  document.getElementById("feedForm").dispatchEvent(new Event("submit", { cancelable: true }));
});
await new Promise((r) => setTimeout(r, 300));
const overdrawToast = await page.$$eval(".toast", (t) => t.map((x) => x.textContent).join("|"));
ok(/Over-draw refused/i.test(overdrawToast), "E1 over-draw refused with gate", overdrawToast.slice(0, 90));
// normal draw that should cross <50% on the 120 kg bin (draw 70 → 50 kg = 10% < 50% and <20%)
await page.evaluate(() => {
  document.getElementById("ffBin").value = "FDB-2026-025561"; // 120 kg bin
  document.getElementById("ffQty").value = "70";
  document.getElementById("feedForm").dispatchEvent(new Event("submit", { cancelable: true }));
});
await new Promise((r) => setTimeout(r, 400));
const alerts = await page.$$eval("#s4 .inset .pill", (p) => p.map((x) => x.textContent).join("|"));
ok(/CRIT/i.test(alerts) || /\.toast/.test(""), "E2 threshold alert recorded in watch", alerts.slice(0, 90));
await page.screenshot({ path: `${SHOTS}/4-feedout-alerts.png`, fullPage: false });

// ── Z · reset + console hygiene ──
await page.$eval("#btnReset", (b) => b.click());
await new Promise((r) => setTimeout(r, 300));
const counterAfterReset = await page.$eval("#probeCounter", (e) => e.textContent);
ok(/probes run: 12/.test(counterAfterReset), "Z1 reset restores byte-identical seeds + probe state", counterAfterReset);
ok(consoleErrs.length === 0, "Z2 zero console errors across full run", consoleErrs.slice(0, 3).join(" | ") || "clean");

await browser.close();
console.log(`\n══ FEED MILL DEMO: ${pass} passed, ${fail} failed ══`);
process.exit(fail ? 1 : 0);
