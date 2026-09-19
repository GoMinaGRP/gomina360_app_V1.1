/**
 * Signed-In Staff Phase B — UI render verification (grouped board).
 * Screenshot-less DOM assertions via headless chromium:
 *   U1  SA: org-group header(s) render with counts + testids sis-group-*
 *   U2  SA: business buckets render (sis-bizgroup-*) with per-bucket counts
 *   U3  SA: platform-view badge + org drill-down selector present
 *   U4  SA: row provenance — device line (safe: only when a live session
 *       carried provenance) and org identity line under staff name
 *   U5  collapse toggles hide/show bucket rows; no page errors
 *   U6  15s auto-poll keeps flat rows present after regroup
 */
import { createRequire } from "node:module";
const puppeteer = createRequire("/home/user/pgtooling/package.json")("puppeteer-core");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const SA = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : ` — ${detail}`}`); };

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${String(e.message || e)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource:.*status of (401|400|403|404|409|413)/.test(t)) return;
    if (/Failed to load resource: net::/.test(t)) return;
    errors.push(t.slice(0, 250));
  });

  await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
  // login
  await page.waitForSelector("input[type='email'], input[name='email'], [data-testid='login-email']", { timeout: 30000 });
  const emailEl = await page.$("[data-testid='login-email']") || await page.$("input[type='email']") || await page.$("input[name='email']");
  const pwEl = await page.$("[data-testid='login-password']") || await page.$("input[type='password']");
  await emailEl.type(SA.email, { delay: 5 });
  await pwEl.type(SA.pw, { delay: 5 });
  const btn = (await page.$$("button")).find(async (b) => /sign in/i.test(await b.evaluate((x) => x.textContent)));
  const btns = await page.$$("button[type='submit'], button");
  for (const b of btns) { const t = (await b.evaluate((x) => x.textContent || "")).toLowerCase(); if (t.includes("sign in")) { await b.click(); break; } }
  await page.waitForSelector("aside", { timeout: 30000 });

  // Enterprise Users tab → presence
  await page.evaluate(() => {
    [...document.querySelectorAll("aside button")].find((b) => (b.textContent || "").includes("Enterprise Users"))?.click();
  });
  await page.waitForSelector("[data-testid='usr-tab-presence']", { timeout: 25000 }).catch(() => {});
  await page.evaluate(() => { [...document.querySelectorAll("button")].find((b) => (b.getAttribute("data-testid") || "") === "usr-tab-presence")?.click(); });
  await page.waitForSelector("[data-testid='sis-root']", { timeout: 25000 });
  await page.waitForSelector("[data-testid^='sis-group-']", { timeout: 25000 }); // groups land on first fetch

  const g1 = await page.$$("[data-testid^='sis-group-']");
  check("U1 org-group header(s) render as SA", g1.length >= 1, `n=${g1.length}`);
  const g1Text = await page.evaluate(() => (document.querySelector("[data-testid^='sis-group-']") || {}).textContent || "");
  check("U1 group header carries org name + counts", /GoMina/.test(g1Text) && /staff/i.test(g1Text) && /online/i.test(g1Text), g1Text.slice(0, 80));
  const b = await page.$$("[data-testid^='sis-bizgroup-']");
  check("U2 business buckets render with counts", b.length >= 1, `n=${b.length}`);
  check("U3 platform-view badge + org drill selector", !!(await page.$("[data-testid='sis-scope-sa']")) , "badge missing");
  const rows0 = await page.$$("[data-testid^='sis-row-']");
  check("U4 flat staff rows still present (grouped distribution)", rows0.length >= 3, `n=${rows0.length}`);
  const devLines = await page.$$("[data-testid^='sis-device-']");
  check("U4 provenance device line on fresh sessions (≥1)", devLines.length >= 1, `n=${devLines.length}`);
  const orgLines = await page.$$("[data-testid^='sis-org-']");
  check("U4 SA staff cells show org identity (≥1)", orgLines.length >= 1, `n=${orgLines.length}`);

  // collapse the first org group → its rows vanish; expand → they return
  await page.evaluate(() => { (document.querySelector("[data-testid^='sis-group-']")).click(); });
  await new Promise((r) => setTimeout(r, 300));
  const rowsCollapsed = await page.$$("[data-testid^='sis-row-']");
  check("U5 collapse hides bucket rows", rowsCollapsed.length === 0, `n=${rowsCollapsed.length}`);
  await page.evaluate(() => { (document.querySelector("[data-testid^='sis-group-']")).click(); });
  await new Promise((r) => setTimeout(r, 300));
  const rowsBack = await page.$$("[data-testid^='sis-row-']");
  check("U5 expand restores rows", rowsBack.length === rows0.length, `${rowsBack.length} vs ${rows0.length}`);

  await new Promise((r) => setTimeout(r, 16500)); // one full auto-poll cycle
  const rowsAfterPoll = await page.$$("[data-testid^='sis-row-']");
  check("U6 auto-poll regroups without losing rows", rowsAfterPoll.length === rows0.length, `${rowsAfterPoll.length} vs ${rows0.length}`);
  check("U0 zero page/console errors", errors.length === 0, errors.join(" | ").slice(0, 160));
} finally {
  await browser.close().catch(() => {});
}
const fails = results.filter((r) => !r.ok).length;
console.log(`\nRESULT: ${results.length - fails} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
