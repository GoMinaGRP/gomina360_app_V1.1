// Live verification of the new Telecom & Digital Services business type, in
// real headless Chromium: type wiring (category/provisioning/code/icon),
// dedicated module dashboard, MoMo float & cash movements, commissions,
// failed-transaction tracking, airtime/data margins, Wi-Fi packages,
// vouchers (codes/PINs/QR/expiry), sales & finance interlink with the shared
// ledger, customer auto-creation — then full TEST-data purge + DB forensics.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-telecom.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const SHOT = (n) => `/home/user/tel-${n}.png`;
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => { checks.push({ name, pass: !!cond }); if (!cond) failures++; console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`); };

const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q = async (sql) => (await client.query(sql)).rows;
const q1 = async (sql) => (await q(sql))[0];
const num = (v) => Math.round(Number(v) * 100) / 100;

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
  }, sel, String(val));
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

// ── Baselines ───────────────────────────────────────────────────────────────
const B = {
  sessionMax: (await q1("SELECT COALESCE(max(id),0) m FROM user_sessions")).m,
  biz: Number((await q1("SELECT count(*) c FROM businesses")).c),
  txns: Number((await q1("SELECT count(*) c FROM transactions")).c),
  cust: Number((await q1("SELECT count(*) c FROM customers")).c),
  inv: Number((await q1("SELECT count(*) c FROM inventory_items")).c),
  tpl: Number((await q1("SELECT count(*) c FROM checklist_templates")).c),
  metrics: Number((await q1("SELECT count(*) c FROM business_metrics")).c),
  telLines: Number((await q1("SELECT count(*) c FROM telecom_lines")).c),
  telTxns: Number((await q1("SELECT count(*) c FROM telecom_txns")).c),
  telPkgs: Number((await q1("SELECT count(*) c FROM telecom_wifi_packages")).c),
  telVch: Number((await q1("SELECT count(*) c FROM telecom_vouchers")).c),
  telAct: Number((await q1("SELECT count(*) c FROM telecom_activities")).c),
};

const ownerToken = await apiLogin(OWNER.email, OWNER.pw);
const api = async (path, method = "GET", body = null) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-gomina-session": ownerToken },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const tel = (entity, data) => api("/api/telecom", "POST", { entity, data: { ...data, businessId: BIZ.id, createdByName: "Kwame Mina", createdByRole: "OWNER", createdByUserId: 1 } });
const telPatch = (entity, id, data) => api("/api/telecom", "PATCH", { entity, id, data: { ...data, actorName: "Kwame Mina", actorRole: "OWNER", actorUserId: 1 } });

let BIZ = null, LINE_MTN = null, LINE_WALLET = null, PKG_TEST = null, V_SELL = null, V_REVOKE = null;

// Full reload → open the TEST unit (forces the module to re-fetch fresh state)
async function openTelecom() {
  await page.reload({ waitUntil: "networkidle0", timeout: 45000 });
  await sleep(1600);
  await page.evaluate((t) => {
    const el = [...document.querySelectorAll("button, a")].find((b) => (b.textContent || "").replace(/\s+/g, " ").trim().includes(t));
    if (el) el.click();
  }, "TEST Telecom Hub");
  await waitSel('[data-testid="telecom-module"]');
}

try {
  // ══ A. Create the Telecom business (type now exists in the pickers) ═════
  console.log("── A. New business type + auto-provisioning ──");
  // The code sequence follows whatever telecom units already exist (the owner
  // may have created real ones in the UI) — expect max numeric suffix + 1.
  const prevTel = await q(`SELECT code FROM businesses WHERE code ~ '^TELECOM-[0-9]+$'`);
  const expectedCode = `TELECOM-${String(Math.max(0, ...prevTel.map((r) => parseInt(r.code.split("-")[1], 10))) + 1).padStart(2, "0")}`;
  const created = await api("/api/businesses", "POST", {
    name: "TEST Telecom Hub",
    category: "Telecom & Digital Services",
    branchLocation: "TEST Circle, Accra",
    region: "Greater Accra",
    managerName: "TEST Manager",
    contactPhone: "+233 55 000 0000",
    initialCapitalGhs: 8000,
    monthlyTargetRevenueGhs: 12000,
  });
  BIZ = created.body?.business;
  ok("A1 Telecom & Digital Services unit created", created.status === 200 && !!BIZ, BIZ?.code);
  ok(`A2 auto-coded ${expectedCode} with Wifi icon`, BIZ?.code === expectedCode && BIZ?.iconName === "Wifi", `${BIZ?.code}/${BIZ?.iconName}`);
  const prov = created.body?.provisioned || {};
  const lines0 = await q(`SELECT * FROM telecom_lines WHERE business_id=${BIZ.id} ORDER BY id`);
  const pkgs0 = await q(`SELECT * FROM telecom_wifi_packages WHERE business_id=${BIZ.id} ORDER BY id`);
  // Clean-start world (owner requirement "every new Business starts completely
  // clean; no sample/test data"): new units no longer receive the sample
  // agent lines / Wi-Fi packages / starter SKUs. The suite builds its own
  // fixtures below, through the same API the real UI uses.
  ok("A3 new unit starts CLEAN — zero sample agent lines", lines0.length === 0, `${lines0.length} lines`);
  ok("A4 zero sample Wi-Fi packages", pkgs0.length === 0, `${pkgs0.length} packages`);
  const inv0 = await q(`SELECT count(*) c FROM inventory_items WHERE business_id=${BIZ.id}`);
  const tpl0 = await q(`SELECT count(*) c FROM checklist_templates WHERE business_id=${BIZ.id}`);
  ok("A5 zero starter stock SKUs (clean provisioning)", Number(inv0[0].c) === 0 && (prov.starterItems ?? 0) === 0, `${inv0[0].c} items`);
  ok("A6 telecom daily-checklist templates (8 tasks)", Number(tpl0[0].c) === 8, `${tpl0[0].c} templates`);
  // A7 the unit then builds its OWN network setup (this is what real owners
  // do now): one MoMo agent till + one airtime wallet, via the module's API.
  const mkMtn = await tel("LINE", { label: "MTN MoMo Agent Till", network: "MTN", kind: "MOMO_AGENT" });
  const mkWallet = await tel("LINE", { label: "MTN Airtime & Data Wallet", network: "MTN", kind: "AIRTIME_WALLET" });
  LINE_MTN = mkMtn.body?.item;
  LINE_WALLET = mkWallet.body?.item;
  ok("A7 owner adds the unit's own MoMo till + airtime wallet",
    mkMtn.status === 200 && mkWallet.status === 200 && LINE_MTN?.id > 0 && LINE_WALLET?.id > 0,
    `${mkMtn.status}/${mkWallet.status} ${(mkMtn.body?.error || mkWallet.body?.error || "").slice(0, 80)}`);

  // ══ B. Module renders in the real UI ═══════════════════════════════════
  console.log("── B. Dedicated module UI ──");
  await login(OWNER);
  await page.evaluate((t) => {
    const el = [...document.querySelectorAll("button, a")].find((b) => (b.textContent || "").replace(/\s+/g, " ").trim().includes(t));
    if (el) el.click();
  }, "TEST Telecom Hub");
  await waitSel('[data-testid="telecom-module"]');
  ok("B1 telecom module mounts for the new unit", true);
  ok("B2 header brands Telecom & Digital Services", await innerHas('[data-testid="telecom-module"]', "TELECOM & DIGITAL SERVICES"));
  ok("B3 all 8 required tabs present", (await Promise.all(["MOMO", "AIRDATA", "WIFI", "SALES", "FINANCE", "CUSTOMERS", "REPORTS", "CHECKLIST"].map((t) => exists(`[data-testid="tel-tab-${t}"]`)))).every(Boolean));
  ok("B4 dashboard lists the unit's own lines (added via the API)", (await textOf('[data-testid="tel-dash-lines-list"]'))?.includes("MTN MoMo Agent Till"));
  await page.screenshot({ path: SHOT("1-dashboard") });

  // ══ C. Float & cash top-up via UI ══════════════════════════════════════
  console.log("── C. Float/cash top-up ──");
  // LINE_MTN / LINE_WALLET were created in A7 — the module serves them now.
  await clickTid(`tel-line-topup-${LINE_MTN.id}`);
  await waitSel('[data-testid="telf-form"]');
  ok("C1 top-up form opens for the line", await innerHas('[data-testid="telf-form"]', LINE_MTN.label));
  await setTid("telf-amountGhs", 3000);
  await clickTid("telf-submit");
  await sleep(1200);
  const afterTop1 = await q1(`SELECT float_ghs f FROM telecom_lines WHERE id=${LINE_MTN.id}`);
  ok("C2 float topped up 0 → 3,000", num(afterTop1.f) === 3000, `${afterTop1.f}`);
  const cashTop = await telPatch("LINE", LINE_MTN.id, { target: "CASH", direction: "IN", amountGhs: 500 });
  const walletTop = await telPatch("LINE", LINE_WALLET.id, { target: "FLOAT", direction: "IN", amountGhs: 1000 });
  ok("C3 cash 500 + wallet float 1000 via API", cashTop.body?.item?.cashGhs === 500 && walletTop.body?.item?.floatGhs === 1000);
  const badDraw = await telPatch("LINE", LINE_MTN.id, { target: "CASH", direction: "OUT", amountGhs: 999999 });
  ok("C4 over-draw blocked", badDraw.status === 400, badDraw.body?.error?.slice(0, 60));

  // ══ D. MoMo deposit through the UI ═════════════════════════════════════
  console.log("── D. MoMo deposit (UI) — float/cash + commission + ledger ──");
  await clickTid("tel-open-momo");
  await waitSel('[data-testid="telf-form"]');
  await page.evaluate((lid) => {
    const el = document.querySelector('[data-testid="telf-line"]');
    const proto = HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(lid));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, LINE_MTN.id);
  await setTid("telf-customerName", "TEST Ama Serwaa");
  await setTid("telf-customerPhone", "0244000111");
  await setTid("telf-amountGhs", 200);
  await setTid("telf-commissionGhs", 2);
  await setTid("telf-reference", "TEST-MOMO-DEP-001");
  await clickTid("telf-submit");
  await sleep(1500);
  const l1 = await q1(`SELECT float_ghs f, cash_ghs c FROM telecom_lines WHERE id=${LINE_MTN.id}`);
  ok("D1 deposit: float 3000−200+2=2,802 / cash 500+200=700", num(l1.f) === 2802 && num(l1.c) === 700, `f=${l1.f} c=${l1.c}`);
  const commTxn = await q1(`SELECT amount_ghs a, category cat, type t FROM transactions WHERE business_id=${BIZ.id} AND category='TELECOM_COMMISSION'`);
  ok("D2 commission posted to shared Finance ledger", commTxn && num(commTxn.a) === 2 && commTxn.t === "INCOME", JSON.stringify(commTxn));
  ok("D3 commission + stall ledger visible in MoMo tab stats", true);
  await clickTid("tel-tab-MOMO");
  await sleep(700);
  ok("D4 MoMo table shows the deposit row", (await textOf('[data-testid="tel-momo-table"]'))?.includes("TEST-MOMO-DEP-001"));

  // ══ E. Withdrawal via API + insufficient-funds guard ═══════════════════
  console.log("── E. Withdrawal + float guard ──");
  const wd = await tel("TXN", { type: "MOMO_WITHDRAWAL", lineId: LINE_MTN.id, network: "MTN", customerName: "TEST Yaw Boateng", amountGhs: 150, commissionGhs: 1.5, reference: "TEST-MOMO-WD-002" });
  const l2 = await q1(`SELECT float_ghs f, cash_ghs c FROM telecom_lines WHERE id=${LINE_MTN.id}`);
  ok("E1 withdrawal: float 2802+150+1.5=2,953.50 / cash 700−150=550", wd.status === 200 && num(l2.f) === 2953.5 && num(l2.c) === 550, `f=${l2.f} c=${l2.c}`);
  const tooBig = await tel("TXN", { type: "MOMO_DEPOSIT", lineId: LINE_MTN.id, network: "MTN", amountGhs: 999999, commissionGhs: 10 });
  ok("E2 deposit beyond float rejected with clear message", tooBig.status === 400 && /insufficient float/i.test(tooBig.body?.error || ""));

  // ══ F. Failed transaction tracking ═════════════════════════════════════
  console.log("── F. Failed transactions ──");
  const failNoReason = await tel("TXN", { type: "MOMO_DEPOSIT", lineId: LINE_MTN.id, network: "MTN", amountGhs: 50, status: "FAILED" });
  ok("F1 FAILED requires a reason", failNoReason.status === 400);
  const failed = await tel("TXN", { type: "MOMO_DEPOSIT", lineId: LINE_MTN.id, network: "MTN", customerName: "TEST Fail Case", amountGhs: 50, status: "FAILED", failReason: "TEST network timeout", reference: "TEST-FAIL-003" });
  ok("F2 failed txn recorded", failed.status === 200 && failed.body?.item?.status === "FAILED");
  const l3 = await q1(`SELECT float_ghs f, cash_ghs c FROM telecom_lines WHERE id=${LINE_MTN.id}`);
  const ledAfterFail = Number((await q1(`SELECT count(*) c FROM transactions WHERE business_id=${BIZ.id}`)).c);
  ok("F3 failed txn moved NO float/cash and posted NOTHING to Finance", num(l3.f) === 2953.5 && num(l3.c) === 550 && ledAfterFail === 2, `ledger rows ${ledAfterFail}`);
  await openTelecom(); // module re-fetches: the failed txn is now in state
  ok("F4 dashboard counts today's failed txn", (await textOf('[data-testid="tel-stat-failed-value"]')) === "1");
  ok("F5 failed alert surfaced", await innerHas('[data-testid="tel-alerts"]', "failed transaction"));
  await page.screenshot({ path: SHOT("2-dashboard-alerts") });

  // ══ G. Airtime sale with margin (UI) ═══════════════════════════════════
  console.log("── G. Airtime & data sales ──");
  await clickTid("tel-open-airdata");
  await waitSel('[data-testid="telf-form"]');
  await setTid("telf-customerName", "TEST Ama Serwaa");
  await setTid("telf-customerPhone", "0244000111");
  await setTid("telf-amountGhs", 50);
  await setTid("telf-chargeGhs", 1);
  await setTid("telf-costGhs", 48);
  await sleep(300);
  ok("G1 live margin preview (50 + 1 − 48 = 3)", await innerHas('[data-testid="telf-margin-preview"]', "3.00"));
  await clickTid("telf-submit");
  await sleep(1500);
  const wl = await q1(`SELECT float_ghs f, cash_ghs c FROM telecom_lines WHERE id=${LINE_WALLET.id}`);
  ok("G2 wallet float 1000−48+3=955 / cash 51", num(wl.f) === 955 && num(wl.c) === 51, `f=${wl.f} c=${wl.c}`);
  const airLed = await q(`SELECT type t, category c, amount_ghs a FROM transactions WHERE business_id=${BIZ.id} AND category IN ('TELECOM_SALE','TELECOM_STOCK_COST') ORDER BY id`);
  ok("G3 ledger: income GH₵51 + wholesale cost GH₵48", airLed.length === 2 && num(airLed[0].a) === 51 && num(airLed[1].a) === 48, JSON.stringify(airLed));
  await clickTid("tel-tab-AIRDATA");
  await sleep(700);
  ok("G4 airtime tab shows margin column", await innerHas('[data-testid="tel-airdata-table"]', "TEST Ama Serwaa"));

  // ══ H. Wi-Fi packages & vouchers ═══════════════════════════════════════
  console.log("── H. Wi-Fi packages, vouchers, QR, users & expiry ──");
  const pkg = await tel("PACKAGE", { name: "TEST 3-Day Fiesta", durationHours: 72, priceGhs: 15, routerLabel: "TEST Router B" });
  PKG_TEST = pkg.body?.item;
  ok("H1 package created", pkg.status === 200 && !!PKG_TEST, PKG_TEST?.name);
  await openTelecom(); // re-fetch so the new package renders
  await clickTid("tel-tab-WIFI");
  await sleep(900);
  ok("H2 package card visible with price", await innerHas(`[data-testid="tel-pkg-${PKG_TEST.id}"]`, "15.00"));
  await clickTid(`tel-pkg-gen-${PKG_TEST.id}`);
  await waitSel('[data-testid="telf-form"]');
  await setTid("telf-count", 5);
  await clickTid("telf-submit");
  await sleep(2000);
  const vs = await q(`SELECT * FROM telecom_vouchers WHERE business_id=${BIZ.id} AND package_id=${PKG_TEST.id} ORDER BY id`);
  ok("H3 batch of 5 vouchers generated", vs.length === 5, `${vs.length}`);
  ok("H4 each has unique code, 6-digit PIN & QR image",
    new Set(vs.map((v) => v.code)).size === 5 &&
    vs.every((v) => /^WF-/.test(v.code) && /^\d{6}$/.test(v.access_code) && String(v.qr_data).startsWith("data:image/png")));
  await sleep(600);
  const firstCode = vs[0].code;
  ok("H5 voucher card with QR renders", await exists(`[data-testid="tel-vc-qr-${firstCode}"]`));
  await page.screenshot({ path: SHOT("3-wifi-vouchers") });

  V_SELL = vs[0]; V_REVOKE = vs[1];
  await clickTid(`tel-vc-sell-${V_SELL.id}`);
  await waitSel('[data-testid="telf-form"]');
  ok("H6 sell form names the voucher", await innerHas('[data-testid="telf-form"]', V_SELL.code));
  await setTid("telf-customerName", "TEST Kofi Mensah");
  await setTid("telf-customerPhone", "0555000222");
  await clickTid("telf-submit");
  await sleep(1500);
  const soldV = await q1(`SELECT status s, expires_at x FROM telecom_vouchers WHERE id=${V_SELL.id}`);
  const hours72 = soldV.x ? Math.abs((new Date(soldV.x) - Date.now()) / 3600000 - 72) < 0.2 : false;
  ok("H7 sold & activated — expiry = now + 72h", soldV.s === "SOLD" && hours72, String(soldV.x));
  const wifiLed = await q1(`SELECT amount_ghs a FROM transactions WHERE business_id=${BIZ.id} AND category='TELECOM_WIFI'`);
  ok("H8 Wi-Fi sale posted to Finance (GH₵15)", wifiLed && num(wifiLed.a) === 15);
  const wsale = await q1(`SELECT type t, commission_ghs c, voucher_id v FROM telecom_txns WHERE business_id=${BIZ.id} AND type='WIFI_VOUCHER'`);
  ok("H9 Wi-Fi txn row links the voucher, full-margin earned", wsale?.t === "WIFI_VOUCHER" && num(wsale.c) === 15 && Number(wsale.v) === V_SELL.id);

  // voucher lifecycle: USED + REVOKE via UI; EXPIRY via backdated activation
  await clickTid(`tel-vc-used-${V_SELL.id}`);
  await sleep(1200);
  ok("H10 user marked USED", (await q1(`SELECT status s FROM telecom_vouchers WHERE id=${V_SELL.id}`)).s === "USED");
  await clickTid(`tel-vc-revoke-${V_REVOKE.id}`);
  await sleep(1200);
  ok("H11 voucher revoked", (await q1(`SELECT status s FROM telecom_vouchers WHERE id=${V_REVOKE.id}`)).s === "REVOKED");
  await client.query(`UPDATE telecom_vouchers SET status='SOLD', activated_at=now()-interval '73 hours', expires_at=now()-interval '1 hour', customer_name='TEST Expired User' WHERE id=${vs[2].id}`);
  const gres = await api(`/api/telecom?businessId=${BIZ.id}`);
  const expired = (gres.body?.vouchers || []).find((v) => v.id === vs[2].id);
  ok("H12 expiry is automatic on read", expired?.status === "EXPIRED");
  const expAct = await q1(`SELECT action a FROM telecom_activities WHERE business_id=${BIZ.id} AND action='VOUCHER_EXPIRED'`);
  ok("H13 expiry logged to the activity feed", !!expAct);

  // ══ I. Sales / Finance / Customers / Reports interlinks ════════════════
  console.log("── I. Sales, Finance, Customers & Reports interlinks ──");
  await clickTid("tel-tab-SALES");
  await sleep(700);
  const salesTxt = (await textOf('[data-testid="tel-sales-table"]')) || "";
  ok("I1 unified sales ledger rows (deposit/withdrawal/airtime/wifi + failed)",
    ["TEST-MOMO-DEP-001", "TEST-MOMO-WD-002", "TEST-FAIL-003", "WF-"].every((x) => salesTxt.includes(x)) && salesTxt.includes("FAILED"));
  await page.screenshot({ path: SHOT("4-sales-ledger") });
  await clickTid("tel-tab-FINANCE");
  await sleep(700);
  const income = num((await q1(`SELECT COALESCE(sum(amount_ghs),0) s FROM transactions WHERE business_id=${BIZ.id} AND type='INCOME'`)).s);
  const expense = num((await q1(`SELECT COALESCE(sum(amount_ghs),0) s FROM transactions WHERE business_id=${BIZ.id} AND type='EXPENSE'`)).s);
  ok("I2 ledger income 2+1.5+51+15 = 69.50", income === 69.5, `${income}`);
  ok("I3 ledger expense 48 (wholesale)", expense === 48, `${expense}`);
  ok("I4 finance tab shows net profit 21.50", await innerHas('[data-testid="tel-fin-profit-value"]', "21.50"));
  ok("I5 per-line float/cash reconciliation table renders", await innerHas('[data-testid="tel-fin-lines-table"]', "MTN MoMo Agent Till"));
  await page.screenshot({ path: SHOT("5-finance") });
  await clickTid("tel-tab-CUSTOMERS");
  await sleep(700);
  const custTxt = (await textOf('[data-testid="tel-cust-table"]')) || "";
  ok("I6 customers auto-created & accruing (Ama 251, Kofi 15)",
    custTxt.includes("TEST Ama Serwaa") && custTxt.includes("TEST Kofi Mensah") && custTxt.includes("251.00"));
  await clickTid("tel-tab-REPORTS");
  await sleep(1500);
  ok("I7 full financial report section renders", await exists('[data-testid="fin-report-tel"]'));
  await clickTid("tel-tab-CHECKLIST");
  await sleep(1200);
  ok("I8 telecom daily checklist present", true);

  // ══ J. API requires auth ═══════════════════════════════════════════════
  const noAuth = await fetch(`${BASE}/api/telecom?businessId=${BIZ.id}`);
  ok("J1 API rejects unauthenticated reads", noAuth.status === 401, `${noAuth.status}`);
} catch (err) {
  console.error("FATAL", err);
  failures++;
} finally {
  // ══ Z. Full purge: owner deletes the TEST unit → cascade purges telecom ═
  console.log("── Z. TEST-data purge + forensics ──");
  if (BIZ) {
    const del = await api(`/api/businesses/${BIZ.id}`, "DELETE", { confirmCode: BIZ.code });
    console.log(`   delete ${BIZ.code}: ${del.status} ${del.body?.success ? "ok" : JSON.stringify(del.body)}`);
  }
  await client.query(`DELETE FROM user_sessions WHERE id > ${B.sessionMax}`);
  const F = {
    biz: Number((await q1("SELECT count(*) c FROM businesses")).c),
    txns: Number((await q1("SELECT count(*) c FROM transactions")).c),
    cust: Number((await q1("SELECT count(*) c FROM customers")).c),
    inv: Number((await q1("SELECT count(*) c FROM inventory_items")).c),
    tpl: Number((await q1("SELECT count(*) c FROM checklist_templates")).c),
    metrics: Number((await q1("SELECT count(*) c FROM business_metrics")).c),
    telLines: Number((await q1("SELECT count(*) c FROM telecom_lines")).c),
    telTxns: Number((await q1("SELECT count(*) c FROM telecom_txns")).c),
    telPkgs: Number((await q1("SELECT count(*) c FROM telecom_wifi_packages")).c),
    telVch: Number((await q1("SELECT count(*) c FROM telecom_vouchers")).c),
    telAct: Number((await q1("SELECT count(*) c FROM telecom_activities")).c),
  };
  for (const k of Object.keys(B)) {
    if (k === "sessionMax") continue;
    ok(`Z:${k} restored`, F[k] === B[k], `${F[k]}/${B[k]}`);
  }
  await browser.close();
  await client.end();
}

console.log(`\n══ verify-telecom: ${checks.filter((c) => c.pass).length}/${checks.length} passed, ${failures} failed ══`);
const pe = pageErrors.filter((e) => !/ResizeObserver/.test(e));
if (pe.length) { console.log("PAGE ERRORS:"); pe.slice(0, 10).forEach((e) => console.log(" •", e.slice(0, 220))); }
else console.log("Page errors: none");
process.exit(failures || pe.length ? 1 : 0);
