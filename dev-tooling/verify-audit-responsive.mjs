// Responsive verification of the AUDIT interface (Supervisor & Auditor
// Control Center + My Audit Issues) across phone / tablet / desktop.
//
// The reported bug: on phones the Records table was clipped by its
// overflow-hidden container — only Record/Module/Business columns visible,
// the audit actions unreachable, so auditing was impossible on mobile.
//
// Fix under test: below lg (1024px) every audit list renders as full cards
// (complete record info + the entire action set, labeled); from lg up the
// classic tables render. Identical testids in both layouts.
//
//   • PHONE (390×844): no horizontal overflow, cards, ALL 6 audit actions
//     inside the viewport, and the FULL workflow on a phone: filter → flag
//     with priority + photo → ISSUES tab → LOG tab → REPORTS tab → ACCESS
//     tab → detail drawer. Then the assigned WORKER on a phone: bell strip →
//     My Audit Issues → respond. Then the auditor verifies & closes on the
//     phone.
//   • TABLET (768×1024): cards, no overflow, modal opens.
//   • DESKTOP (1440×900): classic tables intact, workflow unchanged.
//
// TEST rows (checklist entry + review/updates/notifications/trail) are
// purged at the end. Canonical demo data is untouched.
// Run: bash dev-tooling/run-suite.sh dev-tooling/verify-audit-responsive.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const WORKER = { email: "akua.donkor@gomina360.com", pw: "GoMina@User10" };

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => { checks.push({ name, pass: !!cond }); if (!cond) failures++; console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`); };

const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;
const q1 = async (sql, params) => (await q(sql, params))[0];

const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TASK_LABEL = `TEST AUDITRESP — unswept storage room ${Date.now()}`;
const pageErrorsByCtx = {};
const errs = (ctx) => pageErrorsByCtx[ctx] || [];

async function newCtx(label, w, h) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: w, height: h });
  pageErrorsByCtx[label] = [];
  page.on("pageerror", (e) => pageErrorsByCtx[label].push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/401|403|Failed to load resource|net::ERR_/.test(t)) pageErrorsByCtx[label].push(t); } });
  return { ctx, page };
}

async function login(page, who) {
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 30000 });
  await page.type('[data-testid="login-email"]', who.email);
  await page.type('[data-testid="login-password"]', who.pw);
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(1800);
}

const helpers = (page) => {
  const tid = (t) => `[data-testid="${t}"]`;
  const exists = async (t) => !!(await page.$(tid(t)));
  const textOf = async (t) => page.$eval(tid(t), (e) => e.textContent || "").catch(() => "");
  const waitSel = (sel, t = 20000) => page.waitForSelector(sel, { timeout: t });
  const setVal = async (sel, val) => page.evaluate((s, v) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`no element ${s}`);
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, sel, val);
  const setTid = (t, val) => setVal(tid(t), val);
  const clickTid = async (t) => { await waitSel(tid(t)); await page.$eval(tid(t), (e) => e.click()); };
  return { tid, exists, textOf, waitSel, setVal, setTid, clickTid };
};

/** Which layout is active: "TBODY" = classic table, "DIV" = card list. */
const layoutOf = (page) => page.evaluate(() => document.querySelector('[data-testid="aud-rec-rows"]')?.tagName || "NONE");

/** Geometry: no document overflow + every visible button of every record
 *  row sits fully inside the viewport. */
async function geometryCheck(page, label, scopeSel) {
  return page.evaluate((sel) => {
    const iw = innerWidth;
    const rows = [...document.querySelectorAll(sel)];
    let buttons = 0, clipped = 0;
    for (const r of rows.slice(0, 40)) {
      for (const b of r.querySelectorAll("button")) {
        const rect = b.getBoundingClientRect();
        if (rect.width === 0) continue;
        buttons++;
        if (rect.right > iw + 1 || rect.left < -1) clipped++;
      }
    }
    return { iw, scrollW: document.documentElement.scrollWidth, buttons, clipped, rows: rows.length };
  }, scopeSel);
}

// ══ 0. Seed one deterministic checklist row (assigned to Akua Donkor) ════
const seeded = await q1(
  `INSERT INTO checklist_entries (business_id, branch_code, checklist_date, task_key, task_label, category, is_completed, notes, assigned_to_name, assigned_to_user_id)
   VALUES (1, 'POULTRY-01', TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD'), $1, $2, 'CLEANING', FALSE, 'TEST — intentionally pending for responsive-audit coverage', 'Akua Donkor', 10) RETURNING id`,
  [`TEST_AUDITRESP_${Date.now()}`, TASK_LABEL]
);
const CHK_ID = seeded.id;
console.log(`seeded checklist row ${CHK_ID}: ${TASK_LABEL}`);
const ROW_KEY = `CHECKLIST:checklist_entries:${CHK_ID}`;

try {
  // ═══ 1. PHONE — OWNER: everything visible + full audit workflow ════════
  console.log("\n── 1. PHONE 390×844 · owner — records, actions, full workflow ──");
  {
    const { ctx, page } = await newCtx("phone-owner", 390, 844);
    const H = helpers(page);
    await login(page, OWNER);
    ok("P1 sidebar → Audit & Review reachable on phone", await (async () => {
      await H.waitSel('[data-testid="nav-sidebar"]', 20000);
      await H.clickTid("audit-tab");
      await H.waitSel('[data-testid="aud-root"]');
      return !!(await H.waitSel('[data-testid="aud-scope"]'));
    })());

    await sleep(1200);
    let g = await geometryCheck(page, "phone", '[data-testid^="aud-rec-row-"]');
    ok("P2 phone: no horizontal document overflow", g.scrollW <= g.iw + 1, `scrollW=${g.scrollW} iw=${g.iw}`);
    ok("P3 phone: records render as CARDS (not the clipped table)", g.rows > 0 && (await layoutOf(page)) === "DIV", `${g.rows} cards, layout=${await layoutOf(page)}`);
    ok("P4 phone: ALL audit-action buttons fully inside the viewport", g.buttons > 0 && g.clipped === 0, `${g.buttons} buttons, ${g.clipped} clipped`);

    // complete record info on the card
    const cardTxt = await page.$eval(`[data-testid="aud-rec-row-CHECKLIST:checklist_entries:${CHK_ID}"]`, (e) => e.textContent || "").catch(() => "");
    ok("P5 phone: card shows ref, state, module, worker, date", /CHK-/.test(cardTxt) && /UNREVIEWED|OPERATIONS/.test(cardTxt) && /Akua Donkor/.test(cardTxt) && /\d{4}-\d{2}-\d{2}/.test(cardTxt), cardTxt.slice(0, 110));

    // filters usable on phone
    await H.setTid("aud-f-type", "CHECKLIST");
    await sleep(900);
    const chkRows = await page.$$eval('[data-testid^="aud-rec-row-CHECKLIST:"]', (n) => n.length).catch(() => 0);
    ok("P6 phone: type filter works (CHECKLIST only)", chkRows >= 1, `${chkRows} rows`);

    // detail drawer on phone
    await H.clickTid(`aud-open-${ROW_KEY}`);
    await H.waitSel('[data-testid="aud-detail"]');
    await H.waitSel('[data-testid="aud-detail-fields"], [data-testid="aud-detail-error"]', 15000);
    const drawer = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="aud-detail"]').getBoundingClientRect();
      return { left: Math.round(d.left), right: Math.round(d.right), iw: innerWidth, fields: !!document.querySelector('[data-testid="aud-detail-fields"]') };
    });
    ok("P7 phone: complete-record drawer fits viewport + fields render", drawer.left >= 0 && drawer.right <= drawer.iw + 1 && drawer.fields, JSON.stringify(drawer));
    await H.clickTid("aud-detail-close");
    await sleep(400);

    // FLAG the seeded record on the phone (full modal workflow)
    await H.clickTid(`aud-flag-${ROW_KEY}`);
    await H.waitSel('[data-testid="aud-action"]');
    const modal = await page.evaluate(() => {
      const m = document.querySelector('[data-testid="aud-action"]').getBoundingClientRect();
      return { left: Math.round(m.left), right: Math.round(m.right), iw: innerWidth, scrollable: document.querySelector('[data-testid="aud-action"]').scrollHeight >= document.querySelector('[data-testid="aud-action"]').clientHeight };
    });
    ok("P8 phone: flag modal fits viewport (scrollable if long)", modal.left >= 0 && modal.right <= modal.iw + 1, JSON.stringify(modal));
    ok("P9 phone: modal routes to the assigned worker", (await H.textOf("aud-action-routing")).includes("Akua Donkor"), (await H.textOf("aud-action-routing")).slice(0, 80));
    await H.setTid("aud-action-title", "TEST AUDITRESP — incomplete cleaning task");
    await H.setTid("aud-action-reason", "TEST AUDITRESP — task pending after close of business");
    await H.clickTid("aud-action-priority-high");
    await (await page.$('[data-testid="aud-action-photo"]')).uploadFile("/home/user/pgtooling/test-photo.png");
    await H.waitSel('[data-testid="aud-action-photo-preview"]');
    await H.clickTid("aud-action-submit");
    await H.waitSel('[data-testid="aud-notice"]');
    ok("P10 phone: flag submitted from the phone (notice + routing)", /Issue flagged/.test(await H.textOf("aud-notice")), (await H.textOf("aud-notice")).slice(0, 90));
    const flagReview = await q1("SELECT id, status, priority, assigned_user_id FROM audit_reviews WHERE issue_title LIKE 'TEST AUDITRESP%' ORDER BY id DESC");
    ok("P11 phone: review persisted (FLAGGED, HIGH, routed to user 10)", flagReview && flagReview.status === "FLAGGED" && flagReview.priority === "HIGH" && Number(flagReview.assigned_user_id) === 10, JSON.stringify(flagReview));
    const ISSUE_ID = flagReview.id;

    // ISSUES tab on phone
    await H.clickTid("aud-tab-ISSUES");
    await sleep(700);
    await H.waitSel(`[data-testid="aud-issue-${ISSUE_ID}"]`);
    const issueGeo = await page.evaluate((id) => {
      const iw = innerWidth;
      const card = document.querySelector(`[data-testid="aud-issue-${id}"]`);
      const r = card.getBoundingClientRect();
      const btns = [...card.querySelectorAll("button")].map((b) => b.getBoundingClientRect()).filter((b) => b.width > 0);
      return { left: Math.round(r.left), right: Math.round(r.right), iw, clipped: btns.filter((b) => b.right > iw + 1 || b.left < -1).length, pipeline: !!card.querySelector('[class*="rounded-full"]') };
    }, ISSUE_ID);
    ok("P12 phone: issue card + pipeline render, actions inside viewport", issueGeo.right <= issueGeo.iw + 1 && issueGeo.clipped === 0 && issueGeo.pipeline, JSON.stringify({ right: issueGeo.right, iw: issueGeo.iw, clipped: issueGeo.clipped }));
    ok("P13 phone: flag photo evidence visible on issue", !!(await page.$(`[data-testid="aud-issue-photo-${ISSUE_ID}"]`)));

    // LOG tab on phone
    await H.clickTid("aud-tab-LOG");
    await sleep(700);
    g = await geometryCheck(page, "phone", '[data-testid^="aud-log-row-"]');
    ok("P14 phone: audit log renders as cards, no clipped buttons", g.rows > 0 && g.clipped === 0, `${g.rows} rows, ${g.clipped} clipped`);
    ok("P15 phone: log shows the flag action just taken", (await page.evaluate(() => document.querySelector('[data-testid="aud-log-rows"]').textContent.includes("FLAG"))));

    // REPORTS tab on phone
    await H.clickTid("aud-tab-REPORTS");
    await sleep(1000);
    const rep = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth, iw: innerWidth,
      charts: ["aud-chart-module", "aud-chart-actions", "aud-chart-trend", "aud-chart-biz"].every((t) => !!document.querySelector(`[data-testid="${t}"]`)),
      disc: !!document.querySelector('[data-testid="aud-disc"]'),
      perf: !!document.querySelector('[data-testid="aud-perf"]'),
    }));
    ok("P16 phone: REPORTS tab — charts + discrepancies + performance render, no overflow", rep.charts && rep.disc && rep.perf && rep.scrollW <= rep.iw + 1, JSON.stringify(rep));

    // ACCESS tab on phone (owner-only)
    await H.clickTid("aud-tab-ACCESS");
    await sleep(700);
    const acc = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth, iw: innerWidth,
      form: !!document.querySelector('[data-testid="aud-grant-form"]'),
      users: !!document.querySelector('[data-testid="aud-grant-user"]'),
      save: !!document.querySelector('[data-testid="aud-grant-save"]'),
    }));
    ok("P17 phone: ACCESS tab — grant form usable, no overflow", acc.form && acc.users && acc.save && acc.scrollW <= acc.iw + 1, JSON.stringify(acc));
    ok("P18 phone: zero page errors (owner)", errs("phone-owner").length === 0, errs("phone-owner").slice(0, 2).join(" | ").slice(0, 120));
    await ctx.close();
  }

  // ═══ 2. PHONE — WORKER: receive, open, respond on a phone ══════════════
  console.log("\n── 2. PHONE 390×844 · worker — My Audit Issues inbox ──");
  {
    const { ctx, page } = await newCtx("phone-worker", 390, 844);
    const H = helpers(page);
    await login(page, WORKER);
    const strip = await H.waitSel('[data-testid="my-issues-strip"]', 25000).catch(() => null);
    ok("W1 worker phone: flagged-issue strip appears", !!strip);
    await H.clickTid("my-issues-open-btn");
    await H.waitSel('[data-testid="myi-root"]');
    const myi = await page.evaluate(() => {
      const m = document.querySelector('[data-testid="myi-root"]').getBoundingClientRect();
      return { left: Math.round(m.left), right: Math.round(m.right), iw: innerWidth, scrollable: document.querySelector('[data-testid="myi-root"]').scrollHeight > 0 };
    });
    ok("W2 worker phone: My Audit Issues modal fits viewport", myi.left >= 0 && myi.right <= myi.iw + 1, JSON.stringify(myi));
    const ISSUE_ID = Number((await q1("SELECT id FROM audit_reviews WHERE issue_title LIKE 'TEST AUDITRESP%' ORDER BY id DESC")).id);
    await H.waitSel(`[data-testid="myi-issue-${ISSUE_ID}"]`, 20000);
    ok("W3 worker phone: issue card + priority + photo evidence visible", !!(await page.$(`[data-testid="myi-issue-${ISSUE_ID}"]`)) && /HIGH/.test(await H.textOf(`myi-priority-${ISSUE_ID}`)) && !!(await page.$(`[data-testid="myi-photo-ev-${ISSUE_ID}"]`)));
    await H.setTid(`myi-note-${ISSUE_ID}`, "TEST AUDITRESP — storage swept and disinfected, photo re-attached");
    await H.clickTid(`myi-mark-resolved-${ISSUE_ID}`);
    await H.waitSel('[data-testid="myi-notice"]');
    ok("W4 worker phone: response sent (mark resolved)", /RESOLVED/.test(await H.textOf("myi-notice")), (await H.textOf("myi-notice")).slice(0, 80));
    const after = await q1("SELECT status, response_by_name FROM audit_reviews WHERE id = $1", [ISSUE_ID]);
    ok("W5 DB: issue now RESOLVED with worker response", after.status === "RESOLVED" && after.response_by_name === "Akua Donkor", JSON.stringify(after));
    ok("W6 worker phone: zero page errors", errs("phone-worker").length === 0, errs("phone-worker").slice(0, 2).join(" | ").slice(0, 120));
    await ctx.close();
  }

  // ═══ 3. PHONE — OWNER: review response & verify/close on a phone ═══════
  console.log("\n── 3. PHONE 390×844 · owner — verify & close ──");
  {
    const { ctx, page } = await newCtx("phone-verify", 390, 844);
    const H = helpers(page);
    await login(page, OWNER);
    await H.clickTid("audit-tab");
    await H.waitSel('[data-testid="aud-root"]');
    await H.clickTid("aud-tab-ISSUES");
    await sleep(700);
    // the worker already marked it RESOLVED → switch to the "Resolved · awaiting
    // verify" view (the default "Needs attention" view only lists open statuses)
    await H.clickTid("aud-issues-RESOLVED");
    await sleep(600);
    const ISSUE_ID = Number((await q1("SELECT id FROM audit_reviews WHERE issue_title LIKE 'TEST AUDITRESP%' ORDER BY id DESC")).id);
    await H.waitSel(`[data-testid="aud-issue-${ISSUE_ID}"]`, 20000);
    ok("V1 phone: response from the worker visible on the issue", !!(await page.$(`[data-testid="aud-issue-response-${ISSUE_ID}"]`)) && (await H.textOf(`aud-issue-response-${ISSUE_ID}`)).includes("Akua Donkor"));
    await H.clickTid(`aud-issue-verify-${ISSUE_ID}`);
    await H.waitSel('[data-testid="aud-verify"]');
    const vm = await page.evaluate(() => {
      const m = document.querySelector('[data-testid="aud-verify"]').getBoundingClientRect();
      return { left: Math.round(m.left), right: Math.round(m.right), iw: innerWidth };
    });
    ok("V2 phone: verify modal fits viewport", vm.left >= 0 && vm.right <= vm.iw + 1, JSON.stringify(vm));
    await H.setTid("aud-verify-note", "TEST AUDITRESP — photo matches, closing");
    await H.clickTid("aud-verify-submit");
    await H.waitSel('[data-testid="aud-notice"]');
    ok("V3 phone: issue verified & closed from the phone", /VERIFIED & closed/.test(await H.textOf("aud-notice")));
    const closed = await q1("SELECT status, resolved_by_name FROM audit_reviews WHERE id = $1", [ISSUE_ID]);
    ok("V4 DB: issue VERIFIED & closed by owner", closed.status === "VERIFIED" && closed.resolved_by_name === "Kwame Mina", JSON.stringify(closed));
    // record card reflects the verified state
    await H.clickTid("aud-tab-RECORDS");
    await sleep(700);
    await H.setTid("aud-f-type", "CHECKLIST");
    await sleep(900);
    ok("V5 phone: record state now VERIFIED on the card", /VERIFIED/.test(await H.textOf(`aud-rec-state-${ROW_KEY}`)), await H.textOf(`aud-rec-state-${ROW_KEY}`));
    await ctx.close();
  }

  // ═══ 4. TABLET 768×1024 — cards + modal ════════════════════════════════
  console.log("\n── 4. TABLET 768×1024 ──");
  {
    const { ctx, page } = await newCtx("tablet", 768, 1024);
    const H = helpers(page);
    await login(page, OWNER);
    await H.clickTid("audit-tab");
    await H.waitSel('[data-testid="aud-root"]');
    await sleep(1200);
    const g = await geometryCheck(page, "tablet", '[data-testid^="aud-rec-row-"]');
    ok("T1 tablet: cards (below lg), no overflow, all actions in viewport", g.rows > 0 && g.clipped === 0 && g.scrollW <= g.iw + 1 && (await layoutOf(page)) === "DIV", `${g.rows} cards, ${g.clipped} clipped, scrollW=${g.scrollW}, layout=${await layoutOf(page)}`);
    const anyKey = await page.evaluate(() => document.querySelector('[data-testid^="aud-rec-row-"]').getAttribute("data-testid").replace("aud-rec-row-", ""));
    await H.clickTid(`aud-verify-${anyKey}`);
    await H.waitSel('[data-testid="aud-action"]');
    ok("T2 tablet: verify action opens the modal", !!(await page.$('[data-testid="aud-action"]')));
    await H.clickTid("aud-action-close");
    ok("T3 tablet: zero page errors", errs("tablet").length === 0, errs("tablet").slice(0, 2).join(" | ").slice(0, 120));
    await ctx.close();
  }

  // ═══ 5. DESKTOP 1440×900 — classic tables unchanged ════════════════════
  console.log("\n── 5. DESKTOP 1440×900 — regression ──");
  {
    const { ctx, page } = await newCtx("desktop", 1440, 900);
    const H = helpers(page);
    await login(page, OWNER);
    await H.clickTid("audit-tab");
    await H.waitSel('[data-testid="aud-root"]');
    await sleep(1200);
    const g = await geometryCheck(page, "desktop", '[data-testid^="aud-rec-row-"]');
    const headers = await page.$$eval('[data-testid="aud-rec-rows"]', (n) => {
      const table = n[0]?.closest("table");
      return table ? [...table.querySelectorAll("thead th")].map((e) => e.textContent.trim()) : [];
    });
    ok("D1 desktop: classic 7-column table renders", (await layoutOf(page)) === "TBODY" && headers.length === 7, `${await layoutOf(page)}: ${headers.join(" | ")}`);
    ok("D2 desktop: all action buttons inside viewport", g.buttons > 0 && g.clipped === 0, `${g.buttons} buttons, ${g.clipped} clipped`);
    // history expansion still works on desktop
    await H.clickTid(`aud-hist-${ROW_KEY}`);
    await H.waitSel(`[data-testid="aud-hist-panel-${ROW_KEY}"]`);
    ok("D3 desktop: review-history expansion works", /Akua Donkor|VERIFIED|No reviews/.test(await page.evaluate((k) => document.querySelector(`[data-testid="aud-hist-panel-${k}"]`).textContent, ROW_KEY)));
    await H.clickTid("aud-tab-LOG");
    await sleep(600);
    ok("D4 desktop: audit log table renders", !!(await page.$('[data-testid="aud-log-rows"] tr')));
    await H.clickTid("aud-tab-REPORTS");
    await sleep(900);
    let chartsOk = true;
    for (const t of ["aud-chart-module", "aud-chart-actions", "aud-chart-trend", "aud-chart-biz"]) chartsOk = chartsOk && !!(await page.$(`[data-testid="${t}"]`));
    ok("D5 desktop: reports charts render", chartsOk);
    ok("D6 desktop: zero page errors", errs("desktop").length === 0, errs("desktop").slice(0, 2).join(" | ").slice(0, 120));
    await ctx.close();
  }
} finally {
  // ═══ 6. Cleanup — TEST rows only ═══════════════════════════════════════
  const ids = (await q("SELECT id FROM audit_reviews WHERE issue_title LIKE 'TEST AUDITRESP%'")).map((r) => r.id);
  if (ids.length) {
    await q(`DELETE FROM audit_issue_updates WHERE issue_id = ANY($1)`, [ids]);
    await q(`DELETE FROM notifications WHERE issue_id = ANY($1)`, [ids]);
    await q(`DELETE FROM audit_reviews WHERE id = ANY($1)`, [ids]);
  }
  await q(`DELETE FROM audit_trail WHERE reason LIKE 'TEST AUDITRESP%'`);
  await q(`DELETE FROM checklist_entries WHERE id = $1`, [CHK_ID]);
  const left = await q1("SELECT (SELECT count(*) FROM audit_reviews WHERE issue_title LIKE 'TEST AUDITRESP%') r, (SELECT count(*) FROM checklist_entries WHERE task_key LIKE 'TEST_AUDITRESP%') c");
  console.log(`\ncleanup: reviews/updates/notifications/trail/checklist purged (${JSON.stringify(left)})`);
  await client.end();
  await browser.close();
}

const total = checks.length;
const passed = checks.filter((c) => c.pass).length;
console.log(`\n${failures ? `❌ ${failures} FAILED` : "✅ ALL PASSED"} (${passed}/${total} responsive audit checks)`);
process.exit(failures ? 1 : 0);
