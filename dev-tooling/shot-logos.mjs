// Presentation screenshots for the logo feature: uploads two readable logos
// through the REAL owner UI, captures the logo manager + a payslip carrying
// the branch logo, downloads the sales-style payroll PDF, then restores the
// exact pre-shot branding state (all NULL) — no residual data.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/shot-logos.mjs
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const B = {
  sessionMax: (await client.query("SELECT COALESCE(max(id),0) m FROM user_sessions")).rows[0].m,
  // Exact branding baseline — the owner manages real logos via the UI; put
  // every column back as found instead of blanking it.
  logos: JSON.stringify((await client.query("SELECT id, logo, branch_logos FROM businesses ORDER BY id")).rows),
  company: JSON.stringify((await client.query("SELECT company_logo, updated_by_user_id, updated_by_name, updated_by_role FROM company_settings WHERE id=1")).rows[0]),
};

const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitSel = (sel, t = 15000) => page.waitForSelector(sel, { timeout: t });
const clickTid = async (tid) => { await waitSel(`[data-testid="${tid}"]`); await page.$eval(`[data-testid="${tid}"]`, (e) => e.click()); };
const setTid = async (tid, val) => {
  await page.evaluate((s, v) => {
    const el = document.querySelector(`[data-testid="${s}"]`);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, tid, val);
};

try {
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await setTid("login-email", OWNER.email);
  await setTid("login-password", OWNER.pw);
  await clickTid("login-submit");
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(1800);

  await clickTid("open-manage-businesses");
  await waitSel('[data-testid="manage-biz-row-POULTRY-01"]');
  await clickTid("manage-biz-logos-POULTRY-01");
  await waitSel('[data-testid="bizlogo-mgr"]');
  await (await page.$('[data-testid="bizlogo-upload-1"]')).uploadFile("/home/user/pgtooling/logo-poultry.png");
  await waitSel('[data-testid="bizlogo-preview-1"]', 20000);
  await (await page.$('[data-testid="bizlogo-branch-upload-1"]')).uploadFile("/home/user/pgtooling/logo-poultry.png");
  await waitSel('[data-testid="bizlogo-branch-pending-1"]', 20000);
  await clickTid("bizlogo-branch-save-1");
  await waitSel('[data-testid="bizlogo-branch-del-1-POULTRY-01"]', 20000);
  await (await page.$('[data-testid="bizlogo-company-upload"]')).uploadFile("/home/user/pgtooling/logo-gomina.png");
  await waitSel('[data-testid="bizlogo-company-preview"]', 20000);
  await sleep(1200);
  await page.screenshot({ path: "/home/user/logo-1-logo-manager.png" });
  console.log("shot 1 done (logo manager)");
  await clickTid("manage-biz-close");
  await sleep(600);

  // Payslip with the resolved branch logo (legacy run 1 — no data created)
  await page.evaluate((t) => {
    const el = [...document.querySelectorAll("button, a")].find((b) => (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().includes(t));
    if (el) el.click();
  }, "employees & payroll");
  await waitSel('[data-testid="emp-payroll-open"]');
  await clickTid("emp-payroll-open");
  await waitSel('[data-testid="prl-root"]');
  await clickTid("prl-tab-RUNS");
  await clickTid("prl-refresh");
  await waitSel('[data-testid="prl-run-1"]');
  await clickTid("prl-run-toggle-1");
  await waitSel('[data-testid="prl-entry-slip-1"]');
  await clickTid("prl-entry-slip-1");
  await waitSel('[data-testid="prl-slip-logo"]');
  await sleep(900);
  await page.screenshot({ path: "/home/user/logo-2-payslip-branch-logo.png" });
  console.log("shot 2 done (payslip with branch logo)");
} finally {
  await browser.close();
  const baseLogos = JSON.parse(B.logos);
  for (const row of baseLogos) {
    await client.query("UPDATE businesses SET logo=$1, branch_logos=$2 WHERE id=$3",
      [row.logo, row.branch_logos == null ? null : JSON.stringify(row.branch_logos), row.id]);
  }
  const cfgB = JSON.parse(B.company);
  await client.query("UPDATE company_settings SET company_logo=$1, updated_by_user_id=$2, updated_by_name=$3, updated_by_role=$4 WHERE id=1",
    [cfgB.company_logo, cfgB.updated_by_user_id, cfgB.updated_by_name, cfgB.updated_by_role]);
  await client.query(`DELETE FROM user_sessions WHERE id > ${B.sessionMax}`);
  const chk = JSON.stringify((await client.query("SELECT id, logo, branch_logos FROM businesses ORDER BY id")).rows);
  const chkC = JSON.stringify((await client.query("SELECT company_logo, updated_by_user_id, updated_by_name, updated_by_role FROM company_settings WHERE id=1")).rows[0]);
  console.log("branding restored to baseline:", chk === B.logos && chkC === B.company ? "OK" : "MISMATCH");
  await client.end();
}
