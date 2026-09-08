// Live verification of the ASSIGNMENT-ONLY Audit & Review access model:
//  1. NO worker/manager dashboard shows Audit & Review by default (WORKER,
//     BRANCH_MANAGER, GENERAL_MANAGER all verified, UI + API 403).
//  2. OWNER assigns MULTIPLE businesses AND specific branches to one user in
//     a single grant action (multi-select chips UI).
//  3. A granted auditor sees ONLY their assigned businesses, branches,
//     records and sections — branch-less/other-branch records are excluded and
//     review actions outside the scope are refused (server-enforced).
//  4. Delegated manager (canManageAuditors) opens the center to grant ONLY
//     inside their own businesses.
//  5. Revocation takes effect immediately (tab + API both gone).
// All TEST grants/records are purged; forensics must match the baseline.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-audit-access.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const KWABENA = { email: "kwabena.mensah@gomina360.com", pw: process.env.KWABENA_PW || "GoMina@User11", id: 11 };
const KOFI = { email: "kofi@gomina360.com", pw: process.env.KOFI_PW || "GoMina@User4", id: 4 };
const ABENA = { email: "abena.gm@gomina360.com", pw: process.env.ABENA_PW || "GoMina@User2" };

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => { checks.push({ name, pass: !!cond }); if (!cond) failures++; console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`); };

const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q = async (sql) => (await client.query(sql)).rows;
const q1 = async (sql) => (await q(sql))[0];
const D = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() + Number(offsetDays)); return d.toISOString().split("T")[0]; };

const pageErrors = [];
const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1500,950"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const B = {
  sessionMax: (await q1("SELECT COALESCE(max(id),0) m FROM user_sessions")).m,
  grantsMax: (await q1("SELECT COALESCE(max(id),0) m FROM audit_assignments")).m,
  grants: Number((await q1("SELECT count(*) c FROM audit_assignments")).c),
  comfort: (await q1("SELECT is_active FROM audit_assignments WHERE id=1"))?.is_active,
  kofiDeleg: (await q1("SELECT can_manage_auditors FROM users WHERE id=4"))?.can_manage_auditors,
  trailMax: (await q1("SELECT COALESCE(max(id),0) m FROM audit_trail")).m,
  trail: Number((await q1("SELECT count(*) c FROM audit_trail")).c),
  txnMax: (await q1("SELECT COALESCE(max(id),0) m FROM transactions")).m,
  txn: Number((await q1("SELECT count(*) c FROM transactions")).c),
  reviews: Number((await q1("SELECT count(*) c FROM audit_reviews")).c),
};

async function freshPage() {
  // separate context per persona so session cookies never bleed across logins
  const ctx = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/401|403|Failed to load resource|net::ERR_/.test(t)) pageErrors.push(t); } });
  return page;
}
async function login(page, email, pw) {
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 20000 });
  await page.evaluate(({ e, p }) => {
    for (const [tid, v] of [["login-email", e], ["login-password", p]]) {
      const el = document.querySelector(`[data-testid="${tid}"]`);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, { e: email, p: pw });
  await page.$eval('[data-testid="login-submit"]', (x) => x.click());
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(1800);
}
const auditApi = (page, suffix = "") => page.evaluate(async (s) => {
  const r = await fetch(`/api/audit${s}`);
  return { status: r.status, body: await r.json().catch(() => null) };
}, suffix);

let TEST_TXN_A = null, TEST_TXN_B = null;
try {
  // Two TEST transactions on business 2 (Block Factory): one on the granted
  // TEST branch, one on an un-granted branch — used to prove branch scoping.
  console.log("── A. No default Audit & Review for any non-owner role ──");
  const mkTxn = async (branch) => (await q1(`INSERT INTO transactions (business_id, branch_code, type, category, amount_ghs, payment_method, date, description, transaction_number, recorded_by, status)
    VALUES (2,'${branch}','EXPENSE','TEST Materials',10,'CASH','${D(0)}','TEST audit-scope probe','TEST-AUD-${branch}', 'TEST Audit', 'COMPLETED') RETURNING id`)).id;
  TEST_TXN_B = await mkTxn("BLOCK-01");
  TEST_TXN_A = await mkTxn("TEST-OTHER");
  ok("A0 TEST probe transactions on business 2 inserted", TEST_TXN_A > 0 && TEST_TXN_B > 0, `${TEST_TXN_B}/${TEST_TXN_A}`);

  let page = await freshPage();
  await login(page, KWABENA.email, KWABENA.pw);
  ok("A1 WORKER (no grants): no Audit & Review tab in the menu", !(await page.$('[data-testid="audit-tab"]')));
  let meta = await auditApi(page, "?meta=1");
  ok("A2 WORKER: API meta says ineligible", meta.status === 200 && meta.body?.eligible === false, meta.body?.level);
  let full = await auditApi(page);
  ok("A3 WORKER: full audit center fetch refused (403)", full.status === 403, `HTTP ${full.status}`);
  await page.close();

  page = await freshPage();
  await login(page, KOFI.email, KOFI.pw);
  ok("A4 BRANCH_MANAGER (no grants, no delegation): no Audit & Review tab", !(await page.$('[data-testid="audit-tab"]')));
  meta = await auditApi(page, "?meta=1");
  ok("A5 BRANCH_MANAGER: API meta ineligible (assignment-only now)", meta.body?.eligible === false, meta.body?.level);
  await page.close();

  page = await freshPage();
  await login(page, ABENA.email, ABENA.pw);
  ok("A6 GENERAL_MANAGER (no grants): no Audit & Review tab", !(await page.$('[data-testid="audit-tab"]')));
  meta = await auditApi(page, "?meta=1");
  ok("A7 GENERAL_MANAGER: API meta ineligible", meta.body?.eligible === false, meta.body?.level);
  await page.close();

  // ══ B. OWNER grants Kwabena: business 1 (all branches) + business 2
  //       (branch BLOCK-01 only), modules FINANCE+PAYROLL — via the UI ══
  console.log("── B. OWNER multi-business/multi-branch grant via UI ──");
  page = await freshPage();
  await login(page, OWNER.email, OWNER.pw);
  await page.waitForSelector('[data-testid="audit-tab"]', { timeout: 20000 });
  ok("B1 OWNER always sees Audit & Review", true);
  await page.$eval('[data-testid="audit-tab"]', (e) => e.click());
  await page.waitForSelector('[data-testid="aud-scope"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="aud-tab-ACCESS"]', { timeout: 15000 });
  await page.$eval('[data-testid="aud-tab-ACCESS"]', (e) => e.click());
  await page.waitForSelector('[data-testid="aud-grant-form"]', { timeout: 15000 });
  await page.evaluate((uid) => {
    const sel = document.querySelector('[data-testid="aud-grant-user"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, String(uid));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, KWABENA.id);
  await page.$eval('[data-testid="aud-grant-biz-1"]', (e) => e.click());
  await page.$eval('[data-testid="aud-grant-biz-2"]', (e) => e.click());
  await sleep(400);
  ok("B2 two businesses selected in one grant action", await page.$('[data-testid="aud-grant-branches-1"]') && await page.$('[data-testid="aud-grant-branches-2"]'));
  // leave business 1 with NO branch chips (= all branches); narrow business 2 to BLOCK-01
  const hasBiz2BranchChip = !!(await page.$('[data-testid="aud-grant-branch-2-BLOCK-01"]'));
  if (hasBiz2BranchChip) await page.$eval('[data-testid="aud-grant-branch-2-BLOCK-01"]', (e) => e.click());
  ok("B3 business 2 narrowed to the BLOCK-01 branch chip", hasBiz2BranchChip);
  await page.$eval('[data-testid="aud-grant-mod-FINANCE"]', (e) => e.click());
  await page.$eval('[data-testid="aud-grant-mod-PAYROLL"]', (e) => e.click());
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="aud-grant-note"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "TEST multi-scope grant");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.$eval('[data-testid="aud-grant-save"]', (e) => e.click());
  await page.waitForFunction(() => (document.querySelector('[data-testid="aud-access-notice"]')?.textContent || "").length > 0, { timeout: 15000 });
  const notice = await page.$eval('[data-testid="aud-access-notice"]', (e) => e.textContent || "");
  ok("B4 grant saved with 2 assignments reported", notice.includes("2 assignment"), notice.slice(0, 90));
  const g1 = await q1(`SELECT branch_code, modules, is_active FROM audit_assignments WHERE user_id=${KWABENA.id} AND business_id=1 AND note='TEST multi-scope grant'`);
  const g2 = await q1(`SELECT branch_code, modules, is_active FROM audit_assignments WHERE user_id=${KWABENA.id} AND business_id=2 AND note='TEST multi-scope grant'`);
  ok("B5 DB: biz1 unrestricted + biz2 BLOCK-01 branch grant active (FINANCE,PAYROLL)",
    g1?.branch_code === null && g1?.is_active === true && g2?.branch_code === "BLOCK-01" && g2?.is_active === true,
    JSON.stringify([g1?.branch_code ?? "ALL", g2?.branch_code ?? "ALL"]));

  // ══ C. Kwabena's audit view: only assigned businesses/branches/modules ═
  console.log("── C. Auditor sees exactly the assigned scope ──");
  const kw = await freshPage();
  await login(kw, KWABENA.email, KWABENA.pw);
  await kw.waitForSelector('[data-testid="audit-tab"]', { timeout: 20000 });
  ok("C1 granted WORKER now sees Audit & Review", true);
  meta = await auditApi(kw, "?meta=1");
  const bb = meta.body?.branchByBusiness || {};
  ok("C2 meta scope: businesses [1,2], branch restricted on 2 only",
    JSON.stringify((meta.body?.businessIds || []).sort()) === "[1,2]" && (bb["2"] || []).includes("BLOCK-01") && (bb["1"] === null || bb["1"] === undefined),
    JSON.stringify(meta.body?.branchByBusiness));
  full = await auditApi(kw);
  const recs = full.body?.records || [];
  const hasTxnA = recs.some((r) => r.recordType === "TRANSACTION" && r.recordId === TEST_TXN_A);
  const hasTxnB = recs.some((r) => r.recordType === "TRANSACTION" && r.recordId === TEST_TXN_B);
  const hasBiz3 = recs.some((r) => r.businessId === 3);
  const hasOps = recs.some((r) => r.module === "OPERATIONS" || r.module === "INVENTORY");
  const hasBiz2Other = recs.some((r) => r.businessId === 2 && r.branchCode && r.branchCode !== "BLOCK-01");
  ok("C3 assigned-branch record visible, other-branch record hidden", hasTxnB && !hasTxnA, `BLOCK-01:${hasTxnB} OTHER:${hasTxnA}`);
  ok("C4 unassigned businesses + ungranted modules fully excluded", !hasBiz3 && !hasOps && !hasBiz2Other);
  const reviewNeg = await kw.evaluate(async (id) => {
    const r = await fetch("/api/audit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recordType: "TRANSACTION", recordId: id, action: "COMMENT", comment: "TEST outside-scope probe" }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, TEST_TXN_A);
  ok("C5 review action on an out-of-branch record refused (403)", reviewNeg.status === 403, `HTTP ${reviewNeg.status}`);
  await kw.close();

  // ══ D. Delegated manager: grant console inside own businesses only ═══
  console.log("── D. Authorized-manager delegation ──");
  await page.waitForSelector('[data-testid="aud-delegate-toggle-4"]', { timeout: 15000 });
  await page.$eval('[data-testid="aud-delegate-toggle-4"]', (e) => e.click());
  await sleep(1200);
  ok("D1 OWNER delegates auditor management to Kofi (BRANCH_MANAGER biz 2)", (await q1("SELECT can_manage_auditors FROM users WHERE id=4"))?.can_manage_auditors === true);
  const kf = await freshPage();
  await login(kf, KOFI.email, KOFI.pw);
  await kf.waitForSelector('[data-testid="audit-tab"]', { timeout: 20000 });
  ok("D2 delegated manager sees Audit & Review (grant console)", true);
  meta = await auditApi(kf, "?meta=1");
  ok("D3 delegation scope: canGrant, records limited to own grants only", meta.body?.canGrant === true && (meta.body?.businessIds || []).length === 0 && (meta.body?.grantBusinessIds || []).join(",") === "2", JSON.stringify({ b: meta.body?.businessIds, g: meta.body?.grantBusinessIds }));
  const kfGrant = await kf.evaluate(async () => {
    const r = await fetch("/api/audit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "GRANT", userId: 12, businessId: 3, modules: ["FINANCE"] }) });
    return { status: r.status };
  });
  ok("D4 delegated manager CANNOT grant outside his businesses (403 on biz 3)", kfGrant.status === 403, `HTTP ${kfGrant.status}`);
  await kf.close();

  // ══ E. Revocation is immediate ═══════════════════════════════════════
  console.log("── E. Revoke = instant loss of access ──");
  const grantRows = await q(`SELECT id FROM audit_assignments WHERE user_id=${KWABENA.id} AND note='TEST multi-scope grant'`);
  ok("E1 both TEST grants present before revoke", grantRows.length === 2);
  for (const g of grantRows) {
    await page.waitForSelector(`[data-testid="aud-grant-revoke-${g.id}"]`, { timeout: 15000 });
    await page.$eval(`[data-testid="aud-grant-revoke-${g.id}"]`, (e) => e.click());
    await sleep(1100);
  }
  const kw2 = await freshPage();
  await login(kw2, KWABENA.email, KWABENA.pw);
  meta = await auditApi(kw2, "?meta=1");
  ok("E2 after revoking both grants the WORKER is ineligible again", meta.body?.eligible === false && !(await kw2.$('[data-testid="audit-tab"]')));
  full = await auditApi(kw2);
  ok("E3 full audit fetch refused again (403)", full.status === 403);
  await kw2.close();

  await page.$eval('[data-testid="aud-grant-form"]', (e) => e.scrollIntoView({ block: "center" }));
  await sleep(400);
  await page.screenshot({ path: "/home/user/aud-1-grant-console.png" });
  await page.close();
} catch (e) {
  ok("FATAL suite error", false, String(e?.message || e));
  try { const p = await browser.newPage(); await p.screenshot({ path: "/home/user/aud-error.png" }); } catch {}
} finally {
  console.log("── Z. TEST purge + forensics ──");
  await client.query(`DELETE FROM audit_assignments WHERE note LIKE 'TEST%'`);
  await client.query(`DELETE FROM audit_trail WHERE id > ${B.trailMax} AND (target_label ILIKE '%Kwabena Mensah%' OR target_label ILIKE '%Kofi Boahen%' OR detail ILIKE '%TEST multi-scope%')`);
  await client.query(`DELETE FROM transactions WHERE transaction_number LIKE 'TEST-AUD-%'`);
  await client.query(`DELETE FROM audit_reviews WHERE reason LIKE 'TEST%' OR comment LIKE 'TEST%'`);
  await client.query("UPDATE users SET can_manage_auditors=$1 WHERE id=4", [B.kofiDeleg ?? false]);
  await client.query(`DELETE FROM user_sessions WHERE id > ${B.sessionMax}`);
  const F = {
    grants: Number((await q1("SELECT count(*) c FROM audit_assignments")).c),
    trail: Number((await q1("SELECT count(*) c FROM audit_trail")).c),
    txn: Number((await q1("SELECT count(*) c FROM transactions")).c),
    reviews: Number((await q1("SELECT count(*) c FROM audit_reviews")).c),
    comfort: (await q1("SELECT is_active FROM audit_assignments WHERE id=1"))?.is_active,
    kofiDeleg: (await q1("SELECT can_manage_auditors FROM users WHERE id=4"))?.can_manage_auditors,
    emmanuel: (await q1("SELECT is_active FROM audit_assignments WHERE user_id=3 AND business_id=2"))?.is_active,
  };
  ok("Z1 audit tables back to baseline (grants/trail/reviews/txn)", F.grants === B.grants && F.trail === B.trail && F.reviews === B.reviews && F.txn === B.txn, JSON.stringify({ g: `${F.grants}/${B.grants}`, t: `${F.trail}/${B.trail}`, r: `${F.reviews}/${B.reviews}`, x: `${F.txn}/${B.txn}` }));
  ok("Z2 owner's revoked grant stays revoked + delegation restored + Emmanuel intact", F.comfort === false && F.kofiDeleg === (B.kofiDeleg ?? false) && F.emmanuel === true);
  ok("Z3 zero page errors", pageErrors.length === 0, pageErrors[0] || "");
  await browser.close();
  await client.end();
  console.log(`\n═══ RESULT: ${checks.length - failures}/${checks.length} passed, ${failures} failed ═══`);
  process.exit(failures ? 1 : 0);
}
