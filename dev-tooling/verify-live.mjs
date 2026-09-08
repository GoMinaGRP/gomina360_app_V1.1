// Live verification of the Audit & Review issue workflow + restored payroll
// state, in a real headless Chromium. Covers: checklist/activity review, flag
// with photo evidence, auto-routing + notifications, the full pipeline
// (Flagged → Under Review → Correction Required → Resolved → Verified),
// assignee responses, auditor verify/close, per-issue thread + audit trail,
// scope enforcement — then purges TEST data and checks DB forensics.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-live.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");
import { writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const SHOT = (n) => `/home/user/live-${n}.png`;
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const AKUA = { name: "Akua Donkor", id: 10, email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };
const KWABENA = { name: "Kwabena Mensah", id: 11, email: "kwabena.mensah@gomina360.com", pw: process.env.KWABENA_PW || "GoMina@User11" };
let ASSIGNEE = AKUA; // resolved from the row actually flagged (seed order may vary)
const COMFORT = { email: "comfort.agbenyega@gomina360.com", pw: process.env.COMFORT_PW || "GoMina@User13" };

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => { checks.push({ name, pass: !!cond }); if (!cond) failures++; console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`); };

const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q = async (sql) => (await client.query(sql)).rows;
const q1 = async (sql) => (await q(sql))[0];

const pageErrors = [];
const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1500,950"] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/401|Failed to load resource|net::ERR_/.test(t)) pageErrors.push(t); } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitSel = (sel, timeout = 15000) => page.waitForSelector(sel, { timeout });
const exists = async (sel) => !!(await page.$(sel));
const textOf = async (sel) => page.$eval(sel, (e) => e.textContent || "").catch(() => null);
const innerHas = async (sel, needle) => ((await textOf(sel)) || "").toLowerCase().includes(needle.toLowerCase());
const clickSel = async (sel) => { await waitSel(sel); await page.$eval(sel, (e) => e.click()); };
const clickTid = (tid) => clickSel(`[data-testid="${tid}"]`);
const setVal = async (sel, val) => {
  await waitSel(sel);
  await page.evaluate((s, v) => {
    const el = document.querySelector(s);
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, sel, val);
};
const setTid = (tid, val) => setVal(`[data-testid="${tid}"]`, val);
async function login(cred) {
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await waitSel('[data-testid="login-email"]');
  await setTid("login-email", cred.email);
  await setTid("login-password", cred.pw);
  await clickTid("login-submit");
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(1800);
}
async function logout() {
  await page.evaluate(() => { const el = document.querySelector("header .w-7.h-7.rounded-full"); (el?.closest("button") || el)?.click(); });
  await waitSel('[data-testid="logout-btn"]');
  await clickTid("logout-btn");
  await waitSel('[data-testid="login-screen"]');
  await sleep(500);
}
writeFileSync("/home/user/pgtooling/test-photo.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

const sessionMax0 = (await q1("SELECT COALESCE(max(id),0) m FROM user_sessions")).m;
// Baseline counts captured at suite start — user data evolves between runs
// (the owner manages auditor grants / issues himself), so the forensics
// gate compares against THIS baseline, not hardcoded numbers.
const base0 = await q1("SELECT (SELECT count(*) FROM audit_reviews) rev, (SELECT count(*) FROM audit_issue_updates) thr, (SELECT count(*) FROM notifications) nof, (SELECT count(*) FROM audit_trail) trl, (SELECT count(*) FROM transactions) txn, (SELECT count(*) FROM payroll_runs) runs, (SELECT count(*) FROM audit_assignments) grants");
let ISSUE_ID = null;
let TEST_GRANT_ID = null;

try {
  console.log("── A. Checklists review + flag with evidence ──");
  await login(OWNER);
  await clickTid("audit-tab");
  await waitSel('[data-testid="aud-root"]');
  await waitSel('[data-testid="aud-scope"]');
  ok("A1 audit center renders (owner full control)", (await textOf('[data-testid="aud-scope"]')).includes("OWNER"));
  await setTid("aud-f-type", "CHECKLIST");
  await sleep(900);
  const chkRows = await page.$$eval('[data-testid^="aud-rec-row-CHECKLIST:"]', (n) => n.length).catch(() => 0);
  ok("A2 daily checklists & activities reviewable", chkRows >= 8, `${chkRows} rows`);
  const target = await page.evaluateHandle(() => {
    const rows = [...document.querySelectorAll('[data-testid^="aud-rec-row-CHECKLIST:"]')].filter((r) => r.textContent.includes("INCOMPLETE"));
    return rows.find((r) => r.textContent.includes("Akua Donkor")) || rows[0];
  });
  ASSIGNEE = (await page.evaluate((r) => (r?.textContent || "").includes("Kwabena Mensah"), target)) ? KWABENA : AKUA;
  const key = (await page.evaluate((r) => r?.getAttribute("data-testid"), target)).replace("aud-rec-row-", "");
  await clickSel(`[data-testid="aud-flag-${key}"]`);
  await waitSel('[data-testid="aud-action"]');
  ok("A3 flag modal shows dashboard routing target", await innerHas('[data-testid="aud-action-routing"]', ASSIGNEE.name));
  await setTid("aud-action-title", "TEST live check — incomplete task");
  await setTid("aud-action-reason", "TEST — task still pending after opening hours");
  await setTid("aud-action-evidence", "TEST attached photo");
  await (await page.$('[data-testid="aud-action-photo"]')).uploadFile("/home/user/pgtooling/test-photo.png");
  await waitSel('[data-testid="aud-action-photo-preview"]');
  await clickTid("aud-action-submit");
  await waitSel('[data-testid="aud-notice"]');
  ok(`A4 flag saved & routed to ${ASSIGNEE.name}'s dashboard`, await innerHas('[data-testid="aud-notice"]', `Routed to ${ASSIGNEE.name}`));
  const rev = await q1("SELECT * FROM audit_reviews WHERE issue_title LIKE 'TEST%' ORDER BY id DESC LIMIT 1");
  ISSUE_ID = rev?.id;
  ok("A5 DB: FLAGGED, assigned, linked to original checklist + photo stored",
    rev?.status === "FLAGGED" && rev?.assigned_user_id === ASSIGNEE.id && rev?.record_type === "CHECKLIST" && (rev?.evidence_photo || "").startsWith("data:image/"), rev?.record_ref);
  ok("A6 DB: thread FLAG + notification to assignee",
    Number((await q1(`SELECT count(*) c FROM audit_issue_updates WHERE issue_id=${ISSUE_ID}`))?.c) === 1 &&
    Number((await q1(`SELECT count(*) c FROM notifications WHERE issue_id=${ISSUE_ID} AND user_id=${ASSIGNEE.id} AND is_read=false`))?.c) === 1);
  await clickTid("aud-tab-ISSUES");
  await waitSel(`[data-testid="aud-issue-${ISSUE_ID}"]`);
  ok("A7 pipeline stepper: status = Flagged", (await textOf(`[data-testid="aud-issue-status-${ISSUE_ID}"]`)) === "Flagged");
  await page.screenshot({ path: SHOT("1-flagged") });
  await logout();

  console.log("── B. Assignee dashboard + respond ──");
  await login(ASSIGNEE);
  ok(`B1 issue on ${ASSIGNEE.name}'s dashboard strip`, await exists('[data-testid="my-issues-strip"]'));
  await waitSel('[data-testid="notif-badge"]', 20000).catch(() => null);
  ok("B2 unread bell badge", await exists('[data-testid="notif-badge"]'));
  await clickTid("my-issues-open-btn");
  await waitSel(`[data-testid="myi-issue-${ISSUE_ID}"]`);
  ok("B3 My Audit Issues shows the flag, linked to checklist", await page.$eval(`[data-testid="myi-issue-${ISSUE_ID}"]`, (e) => e.textContent.includes("CHK-")));
  await setTid(`myi-note-${ISSUE_ID}`, "TEST done late — completed and verified on floor");
  await (await page.$(`[data-testid="myi-photo-${ISSUE_ID}"]`)).uploadFile("/home/user/pgtooling/test-photo.png");
  await waitSel(`[data-testid="myi-photo-preview-${ISSUE_ID}"]`);
  await clickTid(`myi-send-review-${ISSUE_ID}`);
  await waitSel('[data-testid="myi-notice"]');
  ok("B4 responded with evidence & marked for review", (await q1(`SELECT status FROM audit_reviews WHERE id=${ISSUE_ID}`))?.status === "UNDER_REVIEW");
  ok("B5 reviewer notified", Number((await q1(`SELECT count(*) c FROM notifications WHERE issue_id=${ISSUE_ID} AND user_id=1 AND type='AUDIT_ISSUE_RESPONSE'`))?.c) === 1);
  await page.screenshot({ path: SHOT("2-inbox") });
  await clickTid("myi-close");
  await logout();

  console.log("── C. Correction → Resolved → Verified & closed ──");
  await login(OWNER);
  await waitSel('[data-testid="notif-badge"]', 20000).catch(() => null);
  await clickTid("notif-bell");
  await waitSel('[data-testid="notif-panel"]');
  const n = await page.evaluateHandle(() => [...document.querySelectorAll('[data-testid^="notif-item-"]')].find((x) => x.textContent.includes("Response ready for review")));
  await page.evaluate((el) => el.click(), await n.asElement());
  await waitSel(`[data-testid="aud-issue-${ISSUE_ID}"]`, 20000);
  ok("C1 notification deep-links to the issue in Audit Center", true);
  ok("C2 Under Review + response visible", (await textOf(`[data-testid="aud-issue-status-${ISSUE_ID}"]`)) === "Under Review" && (await exists(`[data-testid="aud-issue-response-${ISSUE_ID}"]`)));
  await clickSel(`[data-testid="aud-issue-correct-${ISSUE_ID}"]`);
  await waitSel('[data-testid="aud-correct"]');
  await setTid("aud-correct-note", "TEST attach the countersigned log sheet too");
  await clickTid("aud-correct-submit");
  await waitSel('[data-testid="aud-notice"]');
  ok("C3 correction sent back (assignee re-notified)", (await q1(`SELECT status FROM audit_reviews WHERE id=${ISSUE_ID}`))?.status === "CORRECTION_REQUIRED" &&
    Number((await q1(`SELECT count(*) c FROM notifications WHERE issue_id=${ISSUE_ID} AND user_id=${ASSIGNEE.id} AND type='AUDIT_CORRECTION_REQUIRED'`))?.c) === 1);
  await logout();
  await login(ASSIGNEE);
  await clickTid("my-issues-open-btn");
  await waitSel(`[data-testid="myi-issue-${ISSUE_ID}"]`);
  ok(`C4 ${ASSIGNEE.name} sees Correction Required`, (await textOf(`[data-testid="myi-status-${ISSUE_ID}"]`)) === "Correction Required");
  await setTid(`myi-note-${ISSUE_ID}`, "TEST countersigned log sheet attached");
  await clickTid(`myi-mark-resolved-${ISSUE_ID}`);
  await waitSel('[data-testid="myi-notice"]');
  ok("C5 correction complete → Resolved", (await q1(`SELECT status FROM audit_reviews WHERE id=${ISSUE_ID}`))?.status === "RESOLVED");
  await clickTid("myi-close");
  await logout();
  await login(OWNER);
  await clickTid("audit-tab");
  await waitSel('[data-testid="aud-root"]');
  await clickTid("aud-tab-ISSUES");
  await clickTid("aud-issues-RESOLVED");
  await waitSel(`[data-testid="aud-issue-${ISSUE_ID}"]`);
  await clickSel(`[data-testid="aud-issue-verify-${ISSUE_ID}"]`);
  await waitSel('[data-testid="aud-verify"]');
  ok("C6 verify modal shows the latest response", await innerHas('[data-testid="aud-verify"]', "countersigned"));
  await setTid("aud-verify-note", "TEST checked log sheet — all complete, closing");
  await clickTid("aud-verify-submit");
  await waitSel('[data-testid="aud-notice"]');
  await clickTid("aud-issues-VERIFIED");
  await waitSel(`[data-testid="aud-issue-${ISSUE_ID}"]`);
  const steps = (await q(`SELECT action FROM audit_issue_updates WHERE issue_id=${ISSUE_ID} ORDER BY id`)).map((r) => r.action).join(",");
  ok("C7 Verified & closed with 5-step thread", (await q1(`SELECT status, resolved_by_name FROM audit_reviews WHERE id=${ISSUE_ID}`))?.status === "VERIFIED" && steps === "FLAG,MARK_REVIEW,REQUEST_CORRECTION,MARK_RESOLVED,VERIFY", steps);
  const trailActs = (await q(`SELECT DISTINCT action FROM audit_trail WHERE record_type='CHECKLIST' AND record_id=(SELECT record_id FROM audit_reviews WHERE id=${ISSUE_ID})`)).map((t) => t.action);
  ok("C8 audit trail covers every action", ["FLAG", "RESPOND", "REQUEST_CORRECTION", "MARK_RESOLVED", "VERIFY"].every((a) => trailActs.includes(a)), trailActs.join(","));
  ok("C9 closure notification to assignee", Number((await q1(`SELECT count(*) c FROM notifications WHERE issue_id=${ISSUE_ID} AND user_id=${ASSIGNEE.id} AND type='AUDIT_ISSUE_VERIFIED'`))?.c) === 1);
  await page.screenshot({ path: SHOT("3-verified") });
  await logout();

  console.log("── D. Scope + restored-state regression ──");
  // Scoped-auditor check uses a TEMPORARY TEST grant (purged in cleanup):
  // Comfort's own grant belongs to the owner — he may grant/revoke it in the
  // UI at any time, and we must never mutate his data.
  TEST_GRANT_ID = (await q1(`INSERT INTO audit_assignments (user_id, user_name, user_role, business_id, branch_code, modules, note, is_active, granted_by_user_id, granted_by_name, granted_by_role)
    VALUES (${KWABENA.id}, '${KWABENA.name}', 'WORKER', 1, NULL, '["FINANCE","PAYROLL","ATTENDANCE"]'::jsonb, 'TEST scoped audit grant', true, 1, 'Kwame Mina', 'OWNER') RETURNING id`)).id;
  await login(KWABENA);
  await clickTid("audit-tab");
  await waitSel('[data-testid="aud-scope"]');
  ok("D1 auditor scope enforced (no OPERATIONS/checklists)", (await textOf('[data-testid="aud-scope"]')).includes("AUDITOR") &&
    (await page.$$eval('[data-testid^="aud-rec-row-CHECKLIST:"]', (x) => x.length).catch(() => 0)) === 0);
  await logout();
  const f = await q1(`SELECT
    (SELECT count(*) FROM payroll_runs WHERE status='PAID') runs_paid,
    (SELECT count(*) FROM payroll_attendance) att`);
  // Grant/issue identity checks (not raw counts — the owner adds/revokes
  // auditor grants and progresses seeded issues himself in the UI).
  const emanGrant = await q1(`SELECT is_active, modules FROM audit_assignments WHERE user_id=3 AND business_id=2`);
  const comfortGrant = await q1(`SELECT modules FROM audit_assignments WHERE user_id=13 AND business_id=1`);
  const seededIssue = await q1(`SELECT status, issue_title, assigned_user_id FROM audit_reviews WHERE id=2`);
  const seededNotif = await q1(`SELECT id, is_read FROM notifications WHERE id=1 AND issue_id=2 AND user_id=7 AND type='AUDIT_ISSUE_ASSIGNED'`);
  ok("D2 restored payroll runs all PAID (4)", Number(f.runs_paid) === 4 && Number(f.att) === 11, `paid=${f.runs_paid} att=${f.att}`);
  ok("D3 Emmanuel's restored grant active + Comfort's grant intact", emanGrant?.is_active === true && !!comfortGrant &&
    JSON.stringify(comfortGrant.modules) === JSON.stringify(["FINANCE", "PAYROLL", "ATTENDANCE"]),
    `emmanuel=${emanGrant?.is_active} comfort=${JSON.stringify(comfortGrant?.modules)}`);
  ok("D4 seeded issue & its seeded notification intact (owner may progress it)", !!seededIssue &&
    Number(seededIssue.assigned_user_id) === 7 && seededIssue.issue_title?.includes("deposit slip") && !!seededNotif,
    `status=${seededIssue?.status}`);
} catch (e) {
  ok("FATAL suite error", false, String(e?.message || e));
  try { await page.screenshot({ path: SHOT("error") }); } catch {}
} finally {
  console.log("── Cleanup ──");
  const testIds = (await q("SELECT id FROM audit_reviews WHERE issue_title LIKE 'TEST%' OR reason LIKE 'TEST%' OR resolution_note LIKE 'TEST%' OR response_note LIKE 'TEST%'")).map((r) => r.id);
  if (testIds.length) {
    await client.query(`DELETE FROM audit_issue_updates WHERE issue_id = ANY($1::int[])`, [testIds]);
    await client.query(`DELETE FROM notifications WHERE issue_id = ANY($1::int[])`, [testIds]);
    await client.query(`DELETE FROM audit_reviews WHERE id = ANY($1::int[])`, [testIds]);
  }
  await client.query(`DELETE FROM audit_trail WHERE reason LIKE 'TEST%' OR detail LIKE '%TEST%' OR target_label LIKE 'TEST%'`);
  await client.query(`DELETE FROM notifications WHERE title LIKE 'TEST%' OR body LIKE '%TEST%'`);
  const purgedGrants = (await client.query(`DELETE FROM audit_assignments WHERE note LIKE 'TEST%' RETURNING id`)).rows.map((r) => r.id);
  await client.query(`DELETE FROM user_sessions WHERE id > ${sessionMax0}`);
  console.log(`purged ${testIds.length} test issues + thread/notifs/trail/sessions + ${purgedGrants.length} TEST grants`);
  const z = await q1("SELECT (SELECT count(*) FROM audit_reviews) rev, (SELECT count(*) FROM audit_issue_updates) thr, (SELECT count(*) FROM notifications) nof, (SELECT count(*) FROM audit_trail) trl, (SELECT count(*) FROM transactions) txn, (SELECT count(*) FROM payroll_runs) runs, (SELECT count(*) FROM audit_assignments) grants");
  ok("Z1 forensics back to pre-test baseline", Number(z.rev) === Number(base0.rev) && Number(z.thr) === Number(base0.thr) && Number(z.nof) === Number(base0.nof) &&
    Number(z.trl) === Number(base0.trl) && Number(z.txn) === Number(base0.txn) && Number(z.runs) === Number(base0.runs) && Number(z.grants) === Number(base0.grants), JSON.stringify(z));
  ok("Z2 zero page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  console.log(`\n═══ RESULT: ${checks.filter((c) => c.pass).length}/${checks.length} passed, ${failures} failed ═══`);
  await browser.close();
  await client.end();
  process.exit(failures ? 1 : 0);
}
