// UI verification of the PER-FLOCK LIFECYCLE CHECKLIST features:
//   - FLOCKS tab "Checklist Plan" column with RECOMMENDED badge
//   - CHECKLIST tab Bird Type + Flock filters (incl. All Flocks) and the
//     prominent DAY N / WEEK N age badge on flock sections
//   - Lifecycle timeline view (stage bar, today slot, upcoming slots)
//   - Per-flock Plan editor: customize (fork) → rows → reset to recommended
//   - New Flock form: "Lifecycle checklist plan" picker (recommended /
//     saved template / customize) — creates a CUSTOMIZED flock end-to-end
//   - Mobile viewport (375px): filters + plan editor remain usable
//   - zero page errors
// Cleanup: the UI-created flock and its plan rows are purged via SQL.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-flock-plans-ui.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const reqRepo = createRequire(process.cwd() + "/package.json");
const puppeteer = req("puppeteer-core");
reqRepo("dotenv").config({ path: ".env.local" });

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const TS = Date.now().toString().slice(-7);
const UI_BATCH = `UI-VFY-${TS}`;
let fails = 0;
const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "✅" : "❌"} ${n}${x ? " — " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1400,950"] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 950 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/401|Failed to load resource|net::ERR_/.test(t)) pageErrors.push(t); } });

await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
await page.waitForSelector('[data-testid="login-email"]');
await page.type('[data-testid="login-email"]', OWNER.email);
await page.type('[data-testid="login-password"]', OWNER.pw);
await page.click('[data-testid="login-submit"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });

// open the poultry module
await page.waitForFunction(() => {
  const btns = [...document.querySelectorAll("aside button")];
  return btns.some((b) => /poultry/i.test(b.textContent || ""));
}, { timeout: 30000 });
await page.evaluate(() => {
  const el = [...document.querySelectorAll("aside button")].find((b) => /poultry/i.test(b.textContent || ""));
  if (el) el.click();
});
await sleep(3500);

const clickTab = async (needle) => {
  await page.evaluate((nd) => {
    const el = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim().toLowerCase().includes(nd));
    if (el) el.click();
  }, needle);
  await sleep(2400);
};
const bodyText = () => page.evaluate(() => document.body.innerText);

// ── 1. FLOCKS tab: Checklist Plan column ────────────────────────────────────
await clickTab("flock & batch");
{
  const t = await bodyText();
  ok("FLOCKS tab shows the Checklist Plan column", /checklist plan/i.test(t));
  ok("demo flocks show the RECOMMENDED badge", /RECOMMENDED/.test(t));
  ok("owner sees per-flock Plan… buttons", /Plan…/.test(t));
}

// ── 2. New Flock form: lifecycle plan picker ────────────────────────────────
{
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("button")].find((b) => /new flock/i.test(b.textContent || ""));
    if (el) el.click();
  });
  await sleep(1200);
  const picker = await page.$('[data-testid="flock-plan-picker"]');
  ok("new-flock form shows the Lifecycle checklist plan picker", !!picker);
  const pickerText = picker ? await page.evaluate((el) => el.innerText, picker) : "";
  ok("picker offers recommended / saved template / customize",
    /recommended gomina plan/i.test(pickerText) && /saved template/i.test(pickerText) && /customize now/i.test(pickerText));
  // fill the form: batch, bird type BROILERS, count — then choose CUSTOMIZE
  await page.evaluate((batch) => {
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      if (el instanceof HTMLInputElement) { setter.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }
      else if (el instanceof HTMLSelectElement) {
        const s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
        s.call(el, v); el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
    const labels = [...document.querySelectorAll("label, span")].filter((l) => /batch number/i.test(l.textContent || ""));
    for (const l of labels) {
      const input = l.parentElement?.querySelector("input");
      if (input) { setVal(input, batch); break; }
    }
    const countLabels = [...document.querySelectorAll("label, span")].filter((l) => /initial count/i.test(l.textContent || ""));
    for (const l of countLabels) {
      const input = l.parentElement?.querySelector("input");
      if (input) { setVal(input, "120"); break; }
    }
    const birdSelects = [...document.querySelectorAll("select")];
    for (const sel of birdSelects) {
      if ([...sel.options].some((o) => o.value === "BROILERS")) { setVal(sel, "BROILERS"); break; }
    }
  }, UI_BATCH);
  await sleep(300);
  // choose "Customize now"
  await page.evaluate(() => {
    const radio = [...document.querySelectorAll('input[type="radio"][name="checklistPlanMode"]')];
    const custom = radio[2];
    if (custom) custom.click();
  });
  await sleep(300);
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].filter((b) => /register|save|submit|add flock/i.test(b.textContent || ""));
    const submit = btns[btns.length - 1];
    if (submit) submit.click();
  });
  await sleep(3000);
  const t = await bodyText();
  ok("flock created from the form (customize mode)", !/Failed to save/i.test(t));
  const dbCheck = await (async () => {
    const { Client } = req("pg");
    const c = new Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
    await c.connect();
    const f = await c.query("select f.id, f.batch_number, p.source, (select count(*) from checklist_templates t where t.flock_id=f.id) rows from poultry_flocks f left join checklist_flock_plans p on p.flock_id=f.id where f.batch_number=$1", [UI_BATCH]);
    await c.end();
    return f.rows[0];
  })();
  ok("created flock forked at creation (rows + CUSTOM state)", dbCheck?.rows > 0 && dbCheck?.source === "CUSTOM", JSON.stringify(dbCheck));
  const flockTable = await bodyText();
  ok("FLOCKS table shows the CUSTOMIZED badge for the new flock", /CUSTOMIZED/.test(flockTable));
}

// ── 3. CHECKLIST tab: filters, age badge, isolation ─────────────────────────
await clickTab("checklist");
{
  await page.waitForSelector('[data-testid="checklist-filters"]', { timeout: 15000 });
  ok("Bird Type + Flock filters render", !!(await page.$('[data-testid="checklist-birdtype-filter"]')) && !!(await page.$('[data-testid="checklist-flock-filter"]')));
  ok("Today/Lifecycle view toggle renders", !!(await page.$('[data-testid="checklist-view-toggle"]')));
  const badge = await page.$('[data-testid="flock-age-badge"]');
  const badgeText = badge ? await page.evaluate((el) => el.innerText, badge) : "";
  ok("flock sections carry the prominent DAY/WEEK badge", /^(DAY|WEEK) \d+$/i.test(badgeText.trim()), badgeText.trim());

  // pick the UI flock in the Flock filter → focused view
  await page.evaluate((batch) => {
    const sel = document.querySelector('[data-testid="checklist-flock-filter"]');
    const opt = [...sel.options].find((o) => (o.textContent || "").includes(batch));
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
  }, UI_BATCH);
  await sleep(1800);
  let t = await bodyText();
  ok("flock filter focuses that flock's section", t.includes(UI_BATCH));
  ok("focused view hides the farm routine section (All-Flocks content)", !/FARM ROUTINE & CUSTOM/.test(t));
  ok("per-flock Plan… button appears for the selected flock", !!(await page.$('[data-testid="checklist-plan-btn"]')));

  // Bird type filter: ALL flocks + BROILERS → layer sections hidden
  await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="checklist-flock-filter"]');
    sel.value = "ALL"; sel.dispatchEvent(new Event("change", { bubbles: true }));
    const bsel = document.querySelector('[data-testid="checklist-birdtype-filter"]');
    bsel.value = "BROILERS"; bsel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(1500);
  t = await bodyText();
  const broilerChip = await page.evaluate(() =>
    [...document.querySelectorAll("span")].some((sp) => /BENCH-DEMO-B01/.test(sp.textContent || "")));
  const layerChip = await page.evaluate(() =>
    [...document.querySelectorAll("span")].some((sp) => sp.closest("select") === null && /BATCH-2026-L0\d|BENCH-DEMO-L01/.test(sp.textContent || "")));
  ok("bird type filter shows broiler flock sections", broilerChip);
  ok("bird type filter hides layer flock sections", !layerChip);
  await page.evaluate(() => {
    const bsel = document.querySelector('[data-testid="checklist-birdtype-filter"]');
    bsel.value = "ALL"; bsel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(1200);
}

// ── 4. Lifecycle timeline view ──────────────────────────────────────────────
{
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("button")].find((b) => /lifecycle/i.test(b.textContent || ""));
    if (el) el.click();
  });
  await sleep(1500);
  const lc = await page.$('[data-testid="checklist-lifecycle"]');
  ok("Lifecycle view renders", !!lc);
  const bar = await page.$('[data-testid="lifecycle-stage-bar"]');
  ok("stage timeline bar renders with today marker", !!bar && !!(await page.$('[data-testid^="lifecycle-flock-"]')));
  const t = await bodyText();
  ok("lifecycle shows current slot + upcoming auto-scheduled slots", /today · (week|day) \d+/i.test(t) && /upcoming \(auto-scheduled\)/i.test(t));
  ok("lifecycle explains no-restart continuity", /never restarts/i.test(t));
  // back to Today view
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("button")].find((b) => /^today$/i.test((b.textContent || "").trim()));
    if (el) el.click();
  });
  await sleep(1200);
}

// ── 5. per-flock Plan editor: fork → rows → reset ──────────────────────────
{
  // open via the section Plan button of the UI flock
  await page.evaluate((batch) => {
    const sel = document.querySelector('[data-testid="checklist-flock-filter"]');
    const opt = [...sel.options].find((o) => (o.textContent || "").includes(batch));
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
  }, UI_BATCH);
  await sleep(1500);
  await page.evaluate(() => { document.querySelector('[data-testid="checklist-plan-btn"]')?.click(); });
  await sleep(1000);
  ok("FlockPlanEditor opens", !!(await page.$('[data-testid="flock-plan-editor"]')));
  const editorText = await page.evaluate(() => document.querySelector('[data-testid="flock-plan-editor"]')?.innerText || "");
  ok("editor shows the customized plan rows", /private task/i.test(editorText) && /Reset to recommended/i.test(editorText));
  ok("editor offers save-as-template + apply-template", /Save as reusable template/i.test(editorText) && /Apply a saved template/i.test(editorText));
  // add a per-flock task
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="flock-plan-new-label"]');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "UI verify per-flock task");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await sleep(200);
  await page.evaluate(() => { document.querySelector('[data-testid="flock-plan-add-btn"]')?.click(); });
  await sleep(2500);
  const rowsText = await page.evaluate(() => document.querySelector('[data-testid="flock-plan-rows"]')?.innerText || "");
  ok("per-flock task added from the editor", /UI verify per-flock task/i.test(rowsText));
  const t = await bodyText();
  ok("added task materialized in today's list", /UI verify per-flock task/i.test(t));
  // reset to recommended (two-step confirm)
  await page.evaluate(() => { document.querySelector('[data-testid="flock-plan-reset-btn"]')?.click(); });
  await sleep(300);
  await page.evaluate(() => { document.querySelector('[data-testid="flock-plan-reset-btn"]')?.click(); });
  await sleep(2500);
  const afterReset = await page.evaluate(() => document.querySelector('[data-testid="flock-plan-editor"]')?.innerText || "");
  ok("reset returns the flock to the recommended plan", /follows the recommended/i.test(afterReset) && !/private task/i.test(afterReset), afterReset.slice(0, 80));
  await page.evaluate(() => { [...document.querySelectorAll("button")].find((b) => /^done$/i.test((b.textContent || "").trim()))?.click(); });
  await sleep(800);
}

// ── 6. mobile viewport (375px) ──────────────────────────────────────────────
{
  await page.setViewport({ width: 375, height: 800 });
  await sleep(1200);
  const filters = await page.$('[data-testid="checklist-filters"]');
  ok("mobile 375px: filters still render", !!filters);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("mobile 375px: no horizontal page overflow", overflow <= 24, `${overflow}px`);
  const badge = await page.$('[data-testid="flock-age-badge"]');
  ok("mobile 375px: flock age badge visible", !!badge);
  // plan modal at mobile width
  await page.evaluate(() => { document.querySelector('[data-testid="checklist-plan-btn"]')?.click(); });
  await sleep(1000);
  const editor = await page.$('[data-testid="flock-plan-editor"]');
  ok("mobile 375px: plan editor opens", !!editor);
  const box = editor ? await editor.boundingBox() : null;
  ok("mobile 375px: editor fits the viewport", !!box && box.width <= 375, box ? `${Math.round(box.width)}px` : "none");
  await page.evaluate(() => { [...document.querySelectorAll("button")].find((b) => /^done$/i.test((b.textContent || "").trim()))?.click(); });
  await sleep(600);
  await page.setViewport({ width: 1400, height: 950 });
}

// ── cleanup ────────────────────────────────────────────────────────────────
{
  const { Client } = req("pg");
  const c = new Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
  await c.connect();
  // purge ALL UI-VFY test flocks (earlier crashed runs may have left some)
  // plus orphaned plan-state rows, so the suite is self-healing.
  const f = await c.query("select id from poultry_flocks where batch_number like 'UI-VFY-%'");
  const orphan = await c.query("select flock_id from checklist_flock_plans where flock_id not in (select id from poultry_flocks)");
  const ids = [...new Set([...f.rows.map((r) => r.id), ...orphan.rows.map((r) => r.flock_id)])];
  if (ids.length) {
    await c.query("delete from checklist_entries where flock_id = any($1)", [ids]);
    await c.query("delete from checklist_templates where flock_id = any($1)", [ids]);
    await c.query("delete from checklist_flock_plans where flock_id = any($1)", [ids]);
    await c.query("delete from notifications where type='CHECKLIST_OVERDUE' and record_id = any($1)", [ids]);
    await c.query("delete from audit_trail where (action like 'POULTRY_FLOCK_PLAN%' or action='CHECKLIST_ITEM_ADDED_FLOCK') and record_id = any($1)", [ids]);
    await c.query("delete from poultry_flocks where id = any($1)", [ids]);
  }
  const left = await c.query("select count(*) c from poultry_flocks where batch_number=$1", [UI_BATCH]);
  ok("cleanup: UI test flock purged", Number(left.rows[0].c) === 0);
  await c.end();
}

ok("zero page/console errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
await browser.close();
console.log(`\nUI PER-FLOCK: ${fails ? `${fails} FAILED` : "ALL PASS"}`);
process.exit(fails ? 1 : 0);
