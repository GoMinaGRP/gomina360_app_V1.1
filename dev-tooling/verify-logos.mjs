// Live verification of Company & Business-specific logos, in real headless
// Chromium: owner UI upload of company / business / branch logos, central
// persistence, bootstrap propagation, automatic document resolution
// (branch → business → company) on payslips, print view and downloadable
// payroll PDFs, authorization (worker denied / approved manager allowed),
// then TEST-data purge + DB forensics.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-logos.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");
import { writeFileSync, mkdirSync, readdirSync, statSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const SHOT = (n) => `/home/user/logo-${n}.png`;
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const EMMANUEL = { email: "emmanuel@gomina360.com", pw: process.env.EMMANUEL_PW || "GoMina@User3" };
const AKUA = { email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };
const DL_DIR = "/tmp/logo-downloads";

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => { checks.push({ name, pass: !!cond }); if (!cond) failures++; console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`); };

const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q = async (sql) => (await client.query(sql)).rows;
const q1 = async (sql) => (await q(sql))[0];

// ── Solid-color PNGs so each logo level is distinguishable ─────────────────
const CRC_T = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(r, g, b, size = 24) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const o = y * (size * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
writeFileSync("/tmp/logo-biz.png", makePng(220, 38, 38));    // red — business 1
writeFileSync("/tmp/logo-branch.png", makePng(34, 197, 94)); // green — branch POULTRY-01
writeFileSync("/tmp/logo-company.png", makePng(37, 99, 235)); // blue — GoMina company

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
const clickText = async (text) => page.evaluate((t) => {
  const el = [...document.querySelectorAll("button, a")].find((b) => (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().includes(t.toLowerCase()));
  if (el) { el.click(); return true; }
  return false;
}, text);
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
  if (await exists('[data-testid="login-email"]')) {
    await setTid("login-email", cred.email);
    await setTid("login-password", cred.pw);
    await clickTid("login-submit");
    await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  }
  await sleep(1800);
}
async function apiLogin(email, pw) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pw }) }).then((x) => x.json());
  if (!r.sessionToken) throw new Error(`API login failed for ${email}`);
  return r.sessionToken;
}
const logosApi = (token) => async (body, method = "POST") => {
  const r = await fetch(`${BASE}/api/logos`, { method, headers: { "Content-Type": "application/json", "x-gomina-session": token }, body: method === "POST" ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ── Branding self-heal BEFORE baseline capture: never let a TEST run start ──
// from (and later "restore" back to) a blanked crest. If the live rows lost
// the owner's real GoMina crest (e.g. sandbox rollback), refill them from the
// backup first — byte-identically; live non-empty values always win.
console.log(spawnSync("node", ["dev-tooling/restore-branding.mjs"], { encoding: "utf8" }).stdout.trim());

// ── Baselines (captured before any TEST data) ───────────────────────────────
const B = {
  sessionMax: (await q1("SELECT COALESCE(max(id),0) m FROM user_sessions")).m,
  biz: Number((await q1("SELECT count(*) c FROM businesses")).c),
  runs: Number((await q1("SELECT count(*) c FROM payroll_runs")).c),
  entries: Number((await q1("SELECT count(*) c FROM payroll_entries")).c),
  att: Number((await q1("SELECT count(*) c FROM payroll_attendance")).c),
  txns: Number((await q1("SELECT count(*) c FROM transactions")).c),
  net: Number((await q1("SELECT sum(net_pay_ghs) s FROM payroll_entries")).s),
  logos: JSON.stringify(await q("SELECT id, logo, branch_logos FROM businesses ORDER BY id")),
  company: JSON.stringify(await q1("SELECT company_logo, updated_by_user_id, updated_by_name, updated_by_role FROM company_settings WHERE id=1")),
  emmanuel: (await q1("SELECT can_manage_records c FROM users WHERE id=3")).c,
};
rmSync(DL_DIR, { recursive: true, force: true });
mkdirSync(DL_DIR, { recursive: true });
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL_DIR, eventsEnabled: true });

const ownerToken = await apiLogin(OWNER.email, OWNER.pw);
const logosOwner = logosApi(ownerToken);
let RUN1 = null, RUN1E = null, RUN2 = null, RUN2E = null;
let BIZ_LOGO = null, BRANCH_LOGO = null, CO_LOGO = null;

try {
  // ══ A. Owner UI: open logo manager for business 1 ═══════════════════════
  console.log("── A. Owner logo manager UI ──");
  await login(OWNER);
  await waitSel('[data-testid="open-manage-businesses"]');
  ok("A1 owner sees Manage Units", true);
  await clickTid("open-manage-businesses");
  await waitSel('[data-testid="manage-biz-row-POULTRY-01"]');
  await clickTid("manage-biz-logos-POULTRY-01");
  await waitSel('[data-testid="bizlogo-mgr"]');
  ok("A2 logo manager opens for POULTRY-01", await exists('[data-testid="bizlogo-mgr"]'));
  ok("A3 explains automatic resolution order", await innerHas('[data-testid="bizlogo-mgr"]', "branch logo → business logo"));

  // ══ B. Upload business / branch / company logos ═════════════════════════
  console.log("── B. Uploads via UI (file → client resize → save) ──");
  await (await page.$('[data-testid="bizlogo-upload-1"]')).uploadFile("/tmp/logo-biz.png");
  await waitSel('[data-testid="bizlogo-preview-1"]', 20000);
  ok("B1 business logo preview after upload", true);
  await (await page.$('[data-testid="bizlogo-branch-upload-1"]')).uploadFile("/tmp/logo-branch.png");
  await waitSel('[data-testid="bizlogo-branch-pending-1"]', 20000);
  ok("B2 branch image chosen (defaults to branch code POULTRY-01)",
    (await page.$eval('[data-testid="bizlogo-branch-code-1"]', (e) => e.value)) === "POULTRY-01");
  await clickTid("bizlogo-branch-save-1");
  await waitSel('[data-testid="bizlogo-branch-del-1-POULTRY-01"]', 20000);
  ok("B3 branch override listed after save", true);
  await (await page.$('[data-testid="bizlogo-company-upload"]')).uploadFile("/tmp/logo-company.png");
  await waitSel('[data-testid="bizlogo-company-preview"]', 20000);
  ok("B4 company logo preview after upload", true);
  await page.screenshot({ path: SHOT("1-logo-manager") });

  // ══ C. Persistence + bootstrap propagation ══════════════════════════════
  console.log("── C. Central persistence + /api/init carries logos ──");
  const biz1 = await q1("SELECT logo, branch_logos FROM businesses WHERE id=1");
  BIZ_LOGO = biz1.logo;
  BRANCH_LOGO = (biz1.branch_logos || {})["POULTRY-01"];
  CO_LOGO = (await q1("SELECT company_logo FROM company_settings WHERE id=1")).company_logo;
  ok("C1 business logo persisted (resized JPEG)", BIZ_LOGO?.startsWith("data:image/jpeg"));
  ok("C2 branch logo persisted under POULTRY-01", BRANCH_LOGO?.startsWith("data:image/jpeg"));
  ok("C3 company logo persisted with audit stamp", CO_LOGO?.startsWith("data:image/jpeg") &&
    (await q1("SELECT updated_by_name n FROM company_settings WHERE id=1")).n === "Kwame Mina");
  ok("C4 all three levels distinct", BIZ_LOGO !== BRANCH_LOGO && BIZ_LOGO !== CO_LOGO && BRANCH_LOGO !== CO_LOGO);
  const init = await fetch(`${BASE}/api/init`, { headers: { "x-gomina-session": ownerToken } }).then((x) => x.json());
  const initB1 = (init.businesses || []).find((b) => b.id === 1);
  ok("C5 bootstrap carries company + business + branch logos",
    init.companyLogo === CO_LOGO && initB1?.logo === BIZ_LOGO && initB1?.branchLogos?.["POULTRY-01"] === BRANCH_LOGO);

  // ══ D. Automatic logo on payslips: branch → business → company ══════════
  console.log("── D. Payslip resolution on real documents ──");
  const payroll = async (body) => {
    const r = await fetch(`${BASE}/api/payroll`, { method: "POST", headers: { "Content-Type": "application/json", "x-gomina-session": ownerToken }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const r1 = await payroll({ data: { businessId: 1, period: "2026-11", notes: "TEST logo run biz1" } });
  RUN1 = r1.body?.run?.id; RUN1E = r1.body?.run?.entries?.[0]?.id;
  ok("D1 TEST run biz1 2026-11 created", !!RUN1 && !!RUN1E, `run ${RUN1}`);
  const r2 = await payroll({ data: { businessId: 2, period: "2026-11", notes: "TEST logo run biz2" } });
  RUN2 = r2.body?.run?.id; RUN2E = r2.body?.run?.entries?.[0]?.id;
  ok("D2 TEST run biz2 2026-11 created (biz2 has no own logo)", !!RUN2 && !!RUN2E, `run ${RUN2}`);

  await clickText("Employees & Payroll");
  await waitSel('[data-testid="emp-payroll-open"]');
  await clickTid("emp-payroll-open");
  await waitSel('[data-testid="prl-root"]');
  await clickTid("prl-tab-RUNS");
  await clickTid("prl-refresh");
  await waitSel(`[data-testid="prl-run-${RUN1}"]`);
  await clickTid(`prl-run-toggle-${RUN1}`);
  await waitSel(`[data-testid="prl-entry-slip-${RUN1E}"]`);
  await clickTid(`prl-entry-slip-${RUN1E}`);
  await waitSel('[data-testid="prl-slip"]');
  const slipLogo1 = await page.$eval('[data-testid="prl-slip-logo"]', (e) => e.src).catch(() => null);
  ok("D3 payslip uses the BRANCH logo automatically", slipLogo1 === BRANCH_LOGO);
  await page.screenshot({ path: SHOT("2-payslip-branch-logo") });

  // E. Print view of the same payslip embeds the same logo
  console.log("── E. Printable payslip embeds the logo ──");
  await page.evaluate(() => {
    window.__prlHtml = null;
    window.open = () => ({ document: { write: (h) => { window.__prlHtml = h; }, close() {} }, focus() {}, print() {} });
  });
  await clickTid("prl-slip-print");
  await sleep(700);
  const prlHtml = await page.evaluate(() => window.__prlHtml);
  ok("E1 print payslip HTML embeds the branch logo", !!prlHtml && prlHtml.includes(BRANCH_LOGO));
  await clickTid("prl-slip-close");

  // F. Remove branch override → payslip falls back to business logo; biz2 → company
  console.log("── F. Fallback chain after branch-logo removal ──");
  const rm = await logosOwner({ action: "SET_BRANCH_LOGO", businessId: 1, branchCode: "POULTRY-01", logo: null });
  ok("F1 branch logo removed via API", rm.status === 200 && rm.body?.success && !((rm.body?.business?.branchLogos || {})["POULTRY-01"]));
  await login(OWNER); // full reload → bootstrap picks up the change
  await clickText("Employees & Payroll");
  await waitSel('[data-testid="emp-payroll-open"]');
  await clickTid("emp-payroll-open");
  await waitSel('[data-testid="prl-root"]');
  await clickTid("prl-tab-RUNS");
  await clickTid("prl-refresh");
  await waitSel(`[data-testid="prl-run-${RUN1}"]`);
  await clickTid(`prl-run-toggle-${RUN1}`);
  await waitSel(`[data-testid="prl-entry-slip-${RUN1E}"]`);
  await clickTid(`prl-entry-slip-${RUN1E}`);
  await waitSel('[data-testid="prl-slip"]');
  const slipLogo2 = await page.$eval('[data-testid="prl-slip-logo"]', (e) => e.src).catch(() => null);
  ok("F2 same payslip now uses the BUSINESS logo", slipLogo2 === BIZ_LOGO);
  await clickTid("prl-slip-close");
  await waitSel(`[data-testid="prl-run-${RUN2}"]`);
  await clickTid(`prl-run-toggle-${RUN2}`);
  await waitSel(`[data-testid="prl-entry-slip-${RUN2E}"]`);
  await clickTid(`prl-entry-slip-${RUN2E}`);
  await waitSel('[data-testid="prl-slip"]');
  const slipLogo3 = await page.$eval('[data-testid="prl-slip-logo"]', (e) => e.src).catch(() => null);
  ok("F3 business without a logo falls back to the COMPANY logo", slipLogo3 === CO_LOGO);
  await clickTid("prl-slip-close");

  // G. Downloadable payroll PDF carries the resolved logo inside the file
  console.log("── G. Downloadable PDF carries the logo ──");
  await clickTid("prl-tab-REPORTS");
  await waitSel(`[data-testid="prl-dl-pdf-${RUN1}"]`);
  const before = readdirSync(DL_DIR);
  await clickTid(`prl-dl-pdf-${RUN1}`);
  let pdfFile = null;
  for (let i = 0; i < 40 && !pdfFile; i++) {
    await sleep(350);
    const fresh = readdirSync(DL_DIR).filter((f) => f.endsWith(".pdf") && !f.endsWith(".crdownload") && !before.includes(f));
    if (fresh.length && fresh.every((f) => statSync(`${DL_DIR}/${f}`).size > 500)) pdfFile = fresh[0];
  }
  ok("G1 per-run payroll PDF downloaded", !!pdfFile, pdfFile || "none");
  ok("G2 PDF contains an embedded image (the logo)", !!pdfFile && readFileSync(`${DL_DIR}/${pdfFile}`).includes("/Subtype /Image"));

  // H. Authorization: worker denied, owner-approved manager allowed
  console.log("── H. Authorization ──");
  const akua = logosApi(await apiLogin(AKUA.email, AKUA.pw));
  const denied = await akua({ action: "SET_BUSINESS_LOGO", businessId: 1, logo: "data:image/png;base64,AAAA" });
  ok("H1 worker cannot manage logos (403)", denied.status === 403, `got ${denied.status}`);
  await client.query("UPDATE users SET can_manage_records=true WHERE id=3");
  const emmanuel = logosApi(await apiLogin(EMMANUEL.email, EMMANUEL.pw));
  const allowed = await emmanuel({ action: "SET_BUSINESS_LOGO", businessId: 1, logo: null }); // in-scope clear for his own business
  ok("H2 owner-approved manager (record-management permission) allowed", allowed.status === 200 && allowed.body?.success, `got ${allowed.status}`);
  await client.query("UPDATE users SET can_manage_records=$1 WHERE id=3", [B.emmanuel === null ? false : B.emmanuel]);
  // Fresh tab state (storage + session cookie), then sign in as the worker
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await page.evaluate(() => { try { sessionStorage.clear(); localStorage.clear(); } catch {} });
  const cookies = await page.cookies(BASE);
  if (cookies.length) await page.deleteCookie(...cookies);
  await page.reload({ waitUntil: "networkidle0", timeout: 45000 });
  await sleep(800);
  await login(AKUA);
  ok("H3 worker UI hides the Manage Units console", !(await exists('[data-testid="open-manage-businesses"]')));
} catch (err) {
  console.error("FATAL", err);
  failures++;
} finally {
  // ══ Z. Cleanup + forensics ══════════════════════════════════════════════
  console.log("── Z. TEST-data purge + forensics ──");
  await client.query("UPDATE users SET can_manage_records=$1 WHERE id=3", [B.emmanuel === null ? false : B.emmanuel]);
  await client.query(`DELETE FROM payroll_attendance WHERE note LIKE '%TEST%'`);
  await client.query(`DELETE FROM payroll_entries WHERE run_id IN (SELECT id FROM payroll_runs WHERE notes LIKE '%TEST%')`);
  await client.query(`DELETE FROM payroll_runs WHERE notes LIKE '%TEST%'`);
  await client.query(`DELETE FROM transactions WHERE description LIKE '%TEST%'`);
  // Restore pre-test branding state EXACTLY from the captured baseline —
  // the owner manages his real logos through the UI (e.g. the GoMina GRP
  // poultry crest); never blank columns, put every row back as found.
  const baseLogos = JSON.parse(B.logos);
  for (const row of baseLogos) {
    await client.query("UPDATE businesses SET logo=$1, branch_logos=$2 WHERE id=$3",
      [row.logo, row.branch_logos == null ? null : JSON.stringify(row.branch_logos), row.id]);
  }
  const cfgB = JSON.parse(B.company);
  await client.query("UPDATE company_settings SET company_logo=$1, updated_by_user_id=$2, updated_by_name=$3, updated_by_role=$4 WHERE id=1",
    [cfgB.company_logo, cfgB.updated_by_user_id, cfgB.updated_by_name, cfgB.updated_by_role]);
  await client.query(`DELETE FROM user_sessions WHERE id > ${B.sessionMax}`);
  const F = {
    biz: Number((await q1("SELECT count(*) c FROM businesses")).c),
    runs: Number((await q1("SELECT count(*) c FROM payroll_runs")).c),
    entries: Number((await q1("SELECT count(*) c FROM payroll_entries")).c),
    att: Number((await q1("SELECT count(*) c FROM payroll_attendance")).c),
    txns: Number((await q1("SELECT count(*) c FROM transactions")).c),
    net: Number((await q1("SELECT sum(net_pay_ghs) s FROM payroll_entries")).s),
    logos: JSON.stringify(await q("SELECT id, logo, branch_logos FROM businesses ORDER BY id")),
    company: JSON.stringify(await q1("SELECT company_logo, updated_by_user_id, updated_by_name, updated_by_role FROM company_settings WHERE id=1")),
    emmanuel: (await q1("SELECT can_manage_records c FROM users WHERE id=3")).c,
    testLeft: Number((await q1("SELECT (SELECT count(*) FROM payroll_runs WHERE notes LIKE '%TEST%') + (SELECT count(*) FROM transactions WHERE description LIKE '%TEST%') c")).c),
  };
  ok("Z1 businesses restored", F.biz === B.biz, `${F.biz}/${B.biz}`);
  ok("Z2 payroll runs restored", F.runs === B.runs, `${F.runs}/${B.runs}`);
  ok("Z3 payroll entries restored", F.entries === B.entries, `${F.entries}/${B.entries}`);
  ok("Z4 attendance restored", F.att === B.att, `${F.att}/${B.att}`);
  ok("Z5 transactions restored", F.txns === B.txns, `${F.txns}/${B.txns}`);
  ok("Z6 legacy payroll net total unchanged", F.net === B.net, `${F.net}/${B.net}`);
  ok("Z7 business logos back to baseline", F.logos === B.logos);
  ok("Z8 company logo back to baseline", F.company === B.company);
  ok("Z9 manager permission restored", F.emmanuel === B.emmanuel);
  ok("Z10 no TEST data left", F.testLeft === 0);
  rmSync(DL_DIR, { recursive: true, force: true });
  await browser.close();
  await client.end();
}

console.log(`\n══ verify-logos: ${checks.filter((c) => c.pass).length}/${checks.length} passed, ${failures} failed ══`);
const pe = pageErrors.filter((e) => !/ResizeObserver/.test(e));
if (pe.length) { console.log("PAGE ERRORS:"); pe.slice(0, 10).forEach((e) => console.log(" •", e.slice(0, 220))); }
else console.log("Page errors: none");
process.exit(failures || pe.length ? 1 : 0);
