// Live verification of the Payroll statutory & settings upgrade, in real
// headless Chromium: editable SSNIT/Tier-2/PAYE configuration, automatic
// gross → employee deductions → net calculation with exact Ghana numbers,
// employer contributions shown separately, manual adjustment with live
// preview, statutory payslip breakdown before payment, payment → Finance
// ledger linkage, remittance report + CSV/PDF/XLSX downloads, worker
// authorization denial, legacy-data regression — then TEST-data purge + DB
// forensics.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-payroll2.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");
import { writeFileSync, mkdirSync, readdirSync, statSync, rmSync, readFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const SHOT = (n) => `/home/user/pay2-${n}.png`;
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const AKUA = { email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };
const DL_DIR = "/tmp/pay2-downloads";

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
let lastClickMiss = null;
const clickText = async (text) => {
  const found = await page.evaluate((t) => {
    const els = [...document.querySelectorAll("button, a")];
    const el = els.find((b) => (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().includes(t.toLowerCase()));
    if (el) { el.click(); return true; }
    return false;
  }, text);
  if (!found) lastClickMiss = text;
  return found;
};
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
async function apiLogin(email, pw) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pw }) }).then((x) => x.json());
  if (!r.sessionToken) throw new Error(`API login failed for ${email}`);
  return r.sessionToken;
}
const apiCall = (token) => async (method, body) => {
  const r = await fetch(`${BASE}/api/payroll`, { method, headers: { "Content-Type": "application/json", "x-gomina-session": token }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const num = (v) => Math.round(Number(v) * 100) / 100;

// ── Baselines (captured before any TEST data) ───────────────────────────────
const B = {
  sessionMax: (await q1("SELECT COALESCE(max(id),0) m FROM user_sessions")).m,
  runs: Number((await q1("SELECT count(*) c FROM payroll_runs")).c),
  entries: Number((await q1("SELECT count(*) c FROM payroll_entries")).c),
  att: Number((await q1("SELECT count(*) c FROM payroll_attendance")).c),
  txns: Number((await q1("SELECT count(*) c FROM transactions")).c),
  cfg: JSON.stringify(await q1("SELECT ssnit_employee_pct, ssnit_employer_pct, tier2_pct, tier2_bearer, paye_bands, custom_items, note, updated_by_user_id, updated_by_name, updated_by_role FROM payroll_statutory_config WHERE id=1")),
  net: Number((await q1("SELECT sum(net_pay_ghs) s FROM payroll_entries")).s),
};
rmSync(DL_DIR, { recursive: true, force: true });
mkdirSync(DL_DIR, { recursive: true });
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL_DIR, eventsEnabled: true });

let RUN_ID = null, ENTRY_ID = null;
const ownerToken = await apiLogin(OWNER.email, OWNER.pw);
const apiOwner = apiCall(ownerToken);

try {
  // ══ A. Statutory settings: read, edit, revert (authorized) ══════════════
  console.log("── A. Statutory Settings tab (editable rates) ──");
  await login(OWNER);
  await clickText("Employees & Payroll");
  await waitSel('[data-testid="emp-payroll-open"]');
  await clickTid("emp-payroll-open");
  await waitSel('[data-testid="prl-root"]');
  ok("A1 payroll center opens", await exists('[data-testid="prl-root"]'));
  await clickTid("prl-tab-SETTINGS");
  await waitSel('[data-testid="prl-set-ssnit-ee"]');
  ok("A2 settings form renders", await exists('[data-testid="prl-settings"]'));
  const ee0 = await page.$eval('[data-testid="prl-set-ssnit-ee"]', (e) => e.value);
  const er0 = await page.$eval('[data-testid="prl-set-ssnit-er"]', (e) => e.value);
  const t20 = await page.$eval('[data-testid="prl-set-tier2"]', (e) => e.value);
  ok("A3 default rates loaded (5.5 / 13 / 5)", ee0 === "5.5" && er0 === "13" && t20 === "5", `${ee0}/${er0}/${t20}`);
  const bandRows = await page.$$eval('[data-testid^="prl-set-band-"]', (els) => els.filter((e) => /^prl-set-band-\d+$/.test(e.dataset.testid)).length);
  ok("A4 PAYE bands rendered (7)", bandRows === 7, `${bandRows}`);
  await setTid("prl-set-ssnit-ee", "6");
  await clickTid("prl-set-save");
  await page.waitForFunction(() => document.querySelector('[data-testid="prl-notice"]') || document.querySelector('[data-testid="prl-set-error"]'), { timeout: 15000 });
  const cfgMid = await q1("SELECT ssnit_employee_pct p, updated_by_name u FROM payroll_statutory_config WHERE id=1");
  ok("A5 rate edit persists (6%) + stamped", num(cfgMid.p) === 6 && !!cfgMid.u, `${cfgMid.p} by ${cfgMid.u}`);
  await setTid("prl-set-ssnit-ee", "5.5");
  await clickTid("prl-set-save");
  await page.waitForFunction(() => !document.querySelector('[data-testid="prl-set-save"]:disabled') || true, { timeout: 5000 }).catch(() => {});
  await sleep(1200);
  const cfgBack = await q1("SELECT ssnit_employee_pct p FROM payroll_statutory_config WHERE id=1");
  ok("A6 rate reverted to 5.5", num(cfgBack.p) === 5.5);
  await page.screenshot({ path: SHOT("1-settings") });

  // ══ B. New run auto-computes statutory (exact Ghana math) ═══════════
  console.log("── B. Run creation → automatic gross→deductions→net ──");
  const att = await apiOwner("POST", { action: "ADD_ATTENDANCE", data: { employeeId: 2, date: "2026-09-08", status: "PRESENT", hoursWorked: 8, overtimeHours: 4, note: "TEST statutory OT" } });
  ok("B1 TEST attendance (OT 4h) via API", att.status === 200 && att.body?.success);
  const created = await apiOwner("POST", { data: { businessId: 2, period: "2026-09", notes: "TEST statutory run" } });
  RUN_ID = created.body?.run?.id;
  ENTRY_ID = created.body?.run?.entries?.[0]?.id;
  ok("B2 TEST run created (biz2 2026-09)", created.status === 200 && !!RUN_ID, `run ${RUN_ID}`);
  const e = created.body.run.entries[0];
  ok("B3 OT pulled from attendance (4h → GH₵109.62)", num(e.overtimeHours) === 4 && num(e.overtimePayGhs) === 109.62, `${e.overtimeHours}h/${e.overtimePayGhs}`);
  ok("B4 gross 3,909.62", num(e.grossPayGhs) === 3909.62, `${e.grossPayGhs}`);
  ok("B5 SSNIT EE 209.00 / ER 494.00", num(e.ssnitEmployeeGhs) === 209 && num(e.ssnitEmployerGhs) === 494, `${e.ssnitEmployeeGhs}/${e.ssnitEmployerGhs}`);
  ok("B6 Tier-2 190.00 (employer-borne)", num(e.tier2Ghs) === 190 && e.tier2Bearer === "EMPLOYER", `${e.tier2Ghs}/${e.tier2Bearer}`);
  ok("B7 taxable 3,700.62 → PAYE 538.36", num(e.taxableIncomeGhs) === 3700.62 && num(e.payeGhs) === 538.36, `${e.taxableIncomeGhs}/${e.payeGhs}`);
  ok("B8 employee deductions 747.36 → net 3,162.26", num(e.totalEmployeeDeductionsGhs) === 747.36 && num(e.netPayGhs) === 3162.26, `${e.totalEmployeeDeductionsGhs}/${e.netPayGhs}`);
  ok("B9 employer contributions 684 → cost 4,593.62", num(e.employerContributionsGhs) === 684 && num(e.employerCostGhs) === 4593.62, `${e.employerContributionsGhs}/${e.employerCostGhs}`);

  // ══ C. Run card breakdown in UI ═══════════════════════════════════════
  console.log("── C. UI run card breakdown ──");
  await clickTid("prl-tab-RUNS");
  await clickTid("prl-refresh");
  await waitSel(`[data-testid="prl-run-${RUN_ID}"]`);
  await clickTid(`prl-run-toggle-${RUN_ID}`);
  await waitSel(`[data-testid="prl-run-statutory-${RUN_ID}"]`);
  const strip = (await textOf(`[data-testid="prl-run-statutory-${RUN_ID}"]`)) || "";
  ok("C1 breakdown strip shows all figures", ["3,909.62", "209.00", "538.36", "3,162.26", "494.00", "190.00", "4,593.62"].every((x) => strip.includes(x)), strip.slice(0, 120));
  await page.screenshot({ path: SHOT("2-run-breakdown") });

  // ══ D. Manual adjustment (authorized) with live preview ═══════════════
  console.log("── D. Manual adjustment ──");
  await clickTid(`prl-entry-edit-${ENTRY_ID}`);
  await waitSel('[data-testid="prl-edit"]');
  await setTid("prl-edit-allowances", "100");
  await setTid("prl-edit-allowancenote", "TEST allowance");
  await sleep(400);
  ok("D1 live preview recomputes (gross 4,009.62 / PAYE 555.86 / net 3,244.76)",
    (await innerHas('[data-testid="prl-edit-pv-gross"]', "4,009.62")) &&
    (await innerHas('[data-testid="prl-edit-pv-paye"]', "555.86")) &&
    (await innerHas('[data-testid="prl-edit-pv-net"]', "3,244.76")));
  await page.screenshot({ path: SHOT("3-adjust-preview") });
  await clickTid("prl-edit-save");
  await sleep(1500);
  const afterAdj = (await q1(`SELECT gross_pay_ghs g, paye_ghs p, net_pay_ghs n, allowances_ghs a FROM payroll_entries WHERE id=${ENTRY_ID}`));
  ok("D2 adjustment persisted + recomputed", num(afterAdj.g) === 4009.62 && num(afterAdj.p) === 555.86 && num(afterAdj.n) === 3244.76, JSON.stringify(afterAdj));
  // revert the adjustment
  await clickTid(`prl-entry-edit-${ENTRY_ID}`);
  await waitSel('[data-testid="prl-edit"]');
  await setTid("prl-edit-allowances", "0");
  await setTid("prl-edit-allowancenote", "");
  await clickTid("prl-edit-save");
  await sleep(1500);
  const reverted = (await q1(`SELECT gross_pay_ghs g, paye_ghs p, net_pay_ghs n FROM payroll_entries WHERE id=${ENTRY_ID}`));
  ok("D3 reverted to canonical (3,909.62 / 538.36 / 3,162.26)", num(reverted.g) === 3909.62 && num(reverted.p) === 538.36 && num(reverted.n) === 3162.26);

  // ══ E. Payslip = payroll breakdown BEFORE payment ═════════════════════
  console.log("── E. Payslip breakdown before payment ──");
  await clickTid(`prl-entry-slip-${ENTRY_ID}`);
  await waitSel('[data-testid="prl-slip"]');
  ok("E1 gross shown", await innerHas('[data-testid="prl-slip-gross"]', "3,909.62"));
  ok("E2 SSNIT EE 209.00", await innerHas('[data-testid="prl-slip-ssnit"]', "209.00"));
  ok("E3 PAYE 538.36 (taxable 3,700.62)", (await innerHas('[data-testid="prl-slip-paye"]', "538.36")) && (await innerHas('[data-testid="prl-slip"]', "3,700.62")));
  ok("E4 total deductions 747.36", await innerHas('[data-testid="prl-slip-totded"]', "747.36"));
  ok("E5 net 3,162.26", await innerHas('[data-testid="prl-slip-net"]', "3,162.26"));
  ok("E6 employer section (494 / 190 / 4,593.62)",
    (await innerHas('[data-testid="prl-slip-er-ssnit"]', "494.00")) &&
    (await innerHas('[data-testid="prl-slip-tier2"]', "190.00")) &&
    (await innerHas('[data-testid="prl-slip-ercost"]', "4,593.62")));
  ok("E7 employer section labelled as not deducted", await innerHas('[data-testid="prl-slip"]', "not deducted from pay"));
  await page.screenshot({ path: SHOT("4-payslip-breakdown") });
  await clickTid("prl-slip-close");
  await sleep(400);

  // ══ F. Review → approve → pay → Finance linkage ═══════════════════════
  console.log("── F. Workflow + finance linkage ──");
  await clickTid(`prl-run-review-${RUN_ID}`);
  await sleep(1200);
  await clickTid(`prl-run-approve-${RUN_ID}`);
  await sleep(1200);
  await clickTid(`prl-run-pay-${RUN_ID}`);
  await waitSel(`[data-testid="prl-paymethods-${RUN_ID}"]`);
  await clickTid(`prl-paymethod-CASH-${RUN_ID}`);
  await sleep(2000);
  const paidRow = await q1(`SELECT e.status es, e.net_pay_ghs n, r.status rs FROM payroll_entries e JOIN payroll_runs r ON r.id=e.run_id WHERE e.id=${ENTRY_ID}`);
  ok("F1 entry + run PAID", paidRow.es === "PAID" && paidRow.rs === "PAID");
  const trx = await q1(`SELECT id, type, category, amount_ghs, payment_method, description, business_id, branch_code FROM transactions WHERE business_id=2 AND category='Staff Payroll' AND description LIKE 'Payroll 2026-09%' ORDER BY id DESC LIMIT 1`);
  ok("F2 ledger txn posted (EXPENSE / Staff Payroll / net)", trx && trx.type === "EXPENSE" && num(trx.amount_ghs) === 3162.26, trx ? `#${trx.id} ${trx.amount_ghs}` : "missing");
  ok("F3 ledger description carries gross→deductions→net", !!trx && trx.description.includes("gross 3909.62") && trx.description.includes("SSNIT 209") && trx.description.includes("PAYE 538.36") && trx.description.includes("= net 3162.26"), trx?.description?.slice(0, 110));
  ok("F4 txn linked to business + branch", !!trx && trx.business_id === 2 && trx.branch_code === "BLOCK-01");
  const linked = await q1(`SELECT transaction_id t FROM payroll_entries WHERE id=${ENTRY_ID}`);
  ok("F5 entry ↔ ledger reference", linked?.t === trx?.id);
  await clickTid("prl-refresh");
  await sleep(800);
  await page.screenshot({ path: SHOT("5-paid-run") });

  // ══ G. Reports: remittance panel + downloads ══════════════════════════
  console.log("── G. Reports & downloads ──");
  await clickTid("prl-tab-REPORTS");
  await waitSel('[data-testid="prl-remit-panel"]');
  const remit = (await textOf(`[data-testid="prl-remit-${RUN_ID}"]`)) || "";
  ok("G1 remittance row (EE 209 / ER 494 / total 703 / Tier-2 190 / PAYE 538.36 / cost 4,593.62)",
    ["209.00", "494.00", "703.00", "190.00", "538.36", "4,593.62"].every((x) => remit.includes(x)), remit.slice(0, 140));
  ok("G2 month label", remit.includes("Sep 2026"));
  const dlWait = async (before, want) => {
    for (let i = 0; i < 40; i++) {
      await sleep(350);
      const now = readdirSync(DL_DIR).filter((f) => f.endsWith(want) && !f.endsWith(".crdownload"));
      const fresh = now.filter((f) => !before.includes(f));
      if (fresh.length && fresh.every((f) => statSync(`${DL_DIR}/${f}`).size > 200)) return fresh;
    }
    return [];
  };
  let files0 = readdirSync(DL_DIR);
  await clickTid(`prl-dl-csv-${RUN_ID}`);
  const csvs = await dlWait(files0, ".csv");
  ok("G3 per-run CSV downloads", csvs.length >= 1, csvs.join(","));
  files0 = readdirSync(DL_DIR);
  await clickTid(`prl-dl-pdf-${RUN_ID}`);
  const pdfs = await dlWait(files0, ".pdf");
  ok("G4 per-run PDF downloads", pdfs.length >= 1, pdfs.join(","));
  files0 = readdirSync(DL_DIR);
  await clickTid(`prl-dl-xlsx-${RUN_ID}`);
  const xlsxs = await dlWait(files0, ".xlsx");
  ok("G5 per-run Excel downloads", xlsxs.length >= 1, xlsxs.join(","));
  files0 = readdirSync(DL_DIR);
  await clickTid("prl-dl-pdf-all");
  const pdfAll = await dlWait(files0, ".pdf");
  ok("G6 combined PDF downloads", pdfAll.length >= 1, pdfAll.join(","));
  files0 = readdirSync(DL_DIR);
  await clickTid("prl-csv");
  const csvAll = await dlWait(files0, ".csv");
  ok("G7 combined CSV downloads", csvAll.length >= 1);
  files0 = readdirSync(DL_DIR);
  await clickTid("prl-dl-xlsx-all");
  const xlsxAll = await dlWait(files0, ".xlsx");
  ok("G8 combined Excel downloads", xlsxAll.length >= 1);
  // CSV content sanity: statutory columns present
  if (csvAll.length) {
    const content = readFileSync(`${DL_DIR}/${csvAll[0]}`, "utf8");
    ok("G9 CSV carries statutory columns", content.includes("SSNIT 5.5% (EE)") && content.includes("PAYE") && content.includes("Employer Cost"));
  }
  await page.screenshot({ path: SHOT("6-reports-remit") });

  // ══ H. Authorization: workers denied ══════════════════════════════════
  console.log("── H. Negative authorization tests ──");
  const akuaToken = await apiLogin(AKUA.email, AKUA.pw);
  const apiAkua = apiCall(akuaToken);
  const deny1 = await apiAkua("POST", { data: { businessId: 1, period: "2026-10", notes: "TEST denied" } });
  ok("H1 worker cannot create a run (403)", deny1.status === 403, `${deny1.status}`);
  const deny2 = await apiAkua("POST", { action: "SAVE_STATUTORY", data: { ssnitEmployeePct: 9 } });
  ok("H2 worker cannot change statutory rates (403)", deny2.status === 403, `${deny2.status}`);
  const deny3 = await apiAkua("PATCH", { entryId: ENTRY_ID, action: "UPDATE_ENTRY", allowancesGhs: 5 });
  ok("H3 worker cannot adjust entries (403)", deny3.status === 403, `${deny3.status}`);

  // ══ I. Legacy regression: pre-statutory paid data untouched ════════════
  console.log("── I. Legacy data regression ──");
  const legacy = await q1("SELECT e.net_pay_ghs n, e.gross_pay_ghs g, r.status s FROM payroll_entries e JOIN payroll_runs r ON r.id=e.run_id WHERE e.id=1");
  ok("I1 legacy entry untouched (net 4,697.36, gross null)", num(legacy.n) === 4697.36 && legacy.g === null, JSON.stringify(legacy));
  await clickTid("prl-tab-RUNS");
  await clickTid("prl-refresh");
  await sleep(1000);
  await clickTid("prl-run-toggle-1");
  await waitSel('[data-testid="prl-entry-slip-1"]');
  await clickTid("prl-entry-slip-1");
  await waitSel('[data-testid="prl-slip"]');
  ok("I2 legacy payslip renders old style", !(await exists('[data-testid="prl-slip-gross"]')) && (await innerHas('[data-testid="prl-slip-net"]', "4,697.36")));
  await page.screenshot({ path: SHOT("7-legacy-payslip") });
  await clickTid("prl-slip-close");
} catch (err) {
  console.error("FATAL", err);
  failures++;
} finally {
  // ══ Z. Cleanup + forensics ════════════════════════════════════════════
  console.log("── Z. TEST-data purge + forensics ──");
  await client.query(`DELETE FROM transactions WHERE business_id=2 AND category='Staff Payroll' AND description LIKE 'Payroll 2026-09%'`);
  await client.query(`DELETE FROM payroll_entries WHERE run_id IN (SELECT id FROM payroll_runs WHERE notes LIKE '%TEST%')`);
  await client.query(`DELETE FROM payroll_runs WHERE notes LIKE '%TEST%'`);
  await client.query(`DELETE FROM payroll_attendance WHERE note LIKE '%TEST%'`);
  // Restore the statutory config row to its exact pre-run baseline
  const cfgB = JSON.parse(B.cfg);
  await client.query(
    `UPDATE payroll_statutory_config SET ssnit_employee_pct=$1, ssnit_employer_pct=$2, tier2_pct=$3, tier2_bearer=$4, paye_bands=$5, custom_items=$6, note=$7, updated_by_user_id=$8, updated_by_name=$9, updated_by_role=$10 WHERE id=1`,
    [cfgB.ssnit_employee_pct, cfgB.ssnit_employer_pct, cfgB.tier2_pct, cfgB.tier2_bearer, JSON.stringify(cfgB.paye_bands), JSON.stringify(cfgB.custom_items), cfgB.note, cfgB.updated_by_user_id, cfgB.updated_by_name, cfgB.updated_by_role]
  );
  await client.query(`DELETE FROM user_sessions WHERE id > ${B.sessionMax}`);
  const F = {
    runs: Number((await q1("SELECT count(*) c FROM payroll_runs")).c),
    entries: Number((await q1("SELECT count(*) c FROM payroll_entries")).c),
    att: Number((await q1("SELECT count(*) c FROM payroll_attendance")).c),
    txns: Number((await q1("SELECT count(*) c FROM transactions")).c),
    cfg: JSON.stringify(await q1("SELECT ssnit_employee_pct, ssnit_employer_pct, tier2_pct, tier2_bearer, paye_bands, custom_items, note, updated_by_user_id, updated_by_name, updated_by_role FROM payroll_statutory_config WHERE id=1")),
    net: Number((await q1("SELECT sum(net_pay_ghs) s FROM payroll_entries")).s),
    testLeft: Number((await q1("SELECT (SELECT count(*) FROM payroll_runs WHERE notes LIKE '%TEST%') + (SELECT count(*) FROM payroll_attendance WHERE note LIKE '%TEST%') + (SELECT count(*) FROM transactions WHERE description LIKE '%TEST%') c")).c),
  };
  ok("Z1 runs restored", F.runs === B.runs, `${F.runs}/${B.runs}`);
  ok("Z2 entries restored", F.entries === B.entries, `${F.entries}/${B.entries}`);
  ok("Z3 attendance restored", F.att === B.att, `${F.att}/${B.att}`);
  ok("Z4 transactions restored", F.txns === B.txns, `${F.txns}/${B.txns}`);
  ok("Z5 statutory config back to baseline", F.cfg === B.cfg);
  ok("Z6 net payroll total unchanged", F.net === B.net, `${F.net}/${B.net}`);
  ok("Z7 no TEST data left", F.testLeft === 0);
  rmSync(DL_DIR, { recursive: true, force: true });
  await browser.close();
  await client.end();
}

const passed = checks.filter((c) => c.pass).length;
console.log(`\n${passed}/${checks.length} checks passed · page errors: ${pageErrors.length}`);
if (pageErrors.length) { console.log("PAGE ERRORS:"); pageErrors.slice(0, 10).forEach((e) => console.log("  •", e)); }
if (failures || pageErrors.length) process.exit(1);
