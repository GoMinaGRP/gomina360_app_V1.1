/**
 * verify-credit-sales.mjs — end-to-end proof of the Credit Sale feature.
 *
 * Coverage map (requirement → check):
 *  A  Create credit sale on secure order/customer code (GM-*) — stock deducted,
 *     CREDIT invoice, deposit books first installment (Finance + Receipt).
 *  B  Installments by GM-x / CRD-x secure codes — amounts/dates/status; overpay rejected.
 *  C  Business/Branch data isolation — anonymous 401, unauthorized business 403,
 *     scoped GET never leaks other branches' credit.
 *  D  Reflections — Customers (outstanding), Orders/Tracking console, public
 *     /track payload, Finance transactions feed (Reports source).
 *  E  UI (real Chromium) — Sales & Payments dashboard cards (Credit Sales /
 *     Amount Paid / Outstanding Balance), Credit register, modal installment,
 *     customer /track credit card + progress + history.
 *  F  Settle fully — status PAID everywhere (credit, order, invoice); UI shows
 *     fully-paid state; further payment rejected.
 *  Z  Cleanup + forensics back to baseline + zero page errors.
 *
 * All fixtures are TEST-prefixed and purged; inventory is restored exactly.
 * Run:  node dev-tooling/verify-credit-sales.mjs   (server on :3000 required)
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const SUFFIX = String(Date.now() % 100000);
const CUST = `TEST Credit Customer ${SUFFIX}`;
const PHONE = `+233000${SUFFIX}`;
const r2 = (n) => Math.round(n * 100) / 100;

const results = [];
let pass = 0, fail = 0;
function ok(id, cond, detail = "") {
  results.push({ id, ok: !!cond });
  if (cond) { pass++; console.log(`✅ ${id}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`❌ ${id}${detail ? " — " + detail : ""}`); }
}

async function apiLogin(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json().catch(() => ({}));
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return { cookie, json, status: res.status };
}
const apiFor = (cookie) => async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "content-type": "application/json", cookie, ...(opts.headers || {}) },
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
};

const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });

const created = {
  creditSaleIds: [], paymentIds: [], trxIds: [], docIds: [], trackingIds: [], customerIds: [],
};
const invBaseline = []; // [{id, quantity, status}]
let browser = null;
const pageErrors = [];
let baseline = null;

async function cleanup() {
  try {
    for (const id of created.paymentIds) await pg.query(`DELETE FROM credit_payments WHERE id=$1`, [id]);
    for (const id of created.creditSaleIds) await pg.query(`DELETE FROM credit_sales WHERE id=$1`, [id]);
    for (const id of created.trackingIds) await pg.query(`DELETE FROM customer_trackings WHERE id=$1`, [id]);
    for (const id of created.docIds) await pg.query(`DELETE FROM sales_documents WHERE id=$1`, [id]);
    for (const id of created.trxIds) await pg.query(`DELETE FROM transactions WHERE id=$1`, [id]);
    for (const id of created.customerIds) await pg.query(`DELETE FROM customers WHERE id=$1`, [id]);
    for (const inv of invBaseline) {
      await pg.query(`UPDATE inventory_items SET quantity=$2::double precision, status=$3 WHERE id=$1`, [inv.id, inv.quantity, inv.status]);
    }
    // purge any lingering TEST rows belt-and-braces (matching our suffix only)
    await pg.query(`DELETE FROM credit_sales WHERE customer_name LIKE $1`, [`TEST Credit Customer ${SUFFIX}%`]);
    await pg.query(`DELETE FROM customers WHERE name LIKE $1`, [`TEST Credit Customer ${SUFFIX}%`]);
    if (baseline) {
      await pg.query(`DELETE FROM user_sessions WHERE id > $1`, [baseline.maxSessionId]);
    }
  } catch (e) {
    console.log("cleanup warning:", e.message);
  }
}

(async () => {
  await pg.connect();
  console.log("── Credit Sale E2E — fixtures & baselines ──");
  const cnt = async (q) => (await pg.query(q)).rows[0].n;
  baseline = {
    customers: await cnt(`SELECT count(*)::int n FROM customers`),
    trackings: await cnt(`SELECT count(*)::int n FROM customer_trackings`),
    transactions: await cnt(`SELECT count(*)::int n FROM transactions`),
    docs: await cnt(`SELECT count(*)::int n FROM sales_documents`),
    creditSales: await cnt(`SELECT count(*)::int n FROM credit_sales`),
    creditPayments: await cnt(`SELECT count(*)::int n FROM credit_payments`),
    sessions: await cnt(`SELECT count(*)::int n FROM user_sessions`),
    maxSessionId: (await pg.query(`SELECT coalesce(max(id),0)::int n FROM user_sessions`)).rows[0].n,
  };

  // Pick a business with ≥2 well-stocked inventory items.
  const bizPick = (await pg.query(`
    SELECT business_id AS biz, count(*)::int AS items
    FROM inventory_items WHERE quantity >= 60 AND status='IN_STOCK'
    GROUP BY business_id HAVING count(*) >= 2 ORDER BY business_id LIMIT 1`)).rows[0];
  ok("S1 a business with enough stock exists for the fixture", !!bizPick, bizPick ? `biz ${bizPick.biz}` : "none");
  const BIZ = bizPick.biz;
  const items = (await pg.query(
    `SELECT id, name, selling_price_ghs AS price, quantity::float, status FROM inventory_items WHERE business_id=$1 AND quantity>=60 AND status='IN_STOCK' ORDER BY id LIMIT 2`, [BIZ])).rows;
  invBaseline.push({ id: items[0].id, quantity: items[0].quantity, status: items[0].status });
  invBaseline.push({ id: items[1].id, quantity: items[1].quantity, status: items[1].status });

  const Q1 = 2, Q2 = 3;
  const subtotal = r2(Q1 * items[0].price + Q2 * items[1].price);
  const total = r2(subtotal * 0.9); // 10% discount
  const deposit = r2(Math.min(Math.max(10, total * 0.25), total * 0.8)); // 25%, capped at 80%

  const ownerLogin = await apiLogin(OWNER.email, OWNER.pass);
  ok("S2 owner signed in", ownerLogin.status === 200 && ownerLogin.json.success === true);
  const owner = apiFor(ownerLogin.cookie);

  try {
    // ── A. Create the credit sale ────────────────────────────────────────
    console.log("── A. Create credit sale (secure code, deposit, stock) ──");
    const createRes = await owner("/api/credit-sales", {
      method: "POST",
      body: JSON.stringify({
        action: "create",
        businessId: BIZ,
        customerName: CUST,
        customerPhone: PHONE,
        cartItems: [
          { inventoryId: items[0].id, quantity: Q1 },
          { inventoryId: items[1].id, quantity: Q2 },
        ],
        discountPercent: 10,
        depositAmount: deposit,
        depositMethod: "MTN_MOMO",
        dueDate: "2026-09-15",
        notes: "TEST credit suite",
      }),
    });
    const A = createRes.json || {};
    ok("A1 credit sale created", createRes.status === 200 && A.success === true, A.success ? A.creditSale?.creditCode : A.error);
    ok("A2 totals: subtotal −10% discount = credit total",
      Math.abs(A.creditSale?.totalGhs - total) < 0.01 && Math.abs(A.creditSale?.subtotalGhs - subtotal) < 0.01,
      `total ${A.creditSale?.totalGhs} vs ${total}`);
    ok("A3 deposit recorded as first payment (paid vs balance)",
      Math.abs(A.creditSale?.amountPaidGhs - deposit) < 0.01 && Math.abs(A.creditSale?.balanceGhs - r2(total - deposit)) < 0.01);
    ok("A4 status ACTIVE with secure codes minted",
      A.creditSale?.status === "ACTIVE" && /^CRD-/.test(A.creditSale?.creditCode || "") && /^GM-/.test(A.trackingCode || ""),
      `order code ${A.trackingCode}`);
    ok("A5 CREDIT invoice linked", A.invoice?.documentType === "INVOICE" && A.invoice?.status === "CREDIT" && A.invoice?.paymentMethod === "CREDIT");
    ok("A6 deposit posted to Finance + Receipts",
      A.deposit?.transaction?.category === "Credit Deposit" && A.deposit?.transaction?.type === "INCOME" && A.deposit?.receipt?.documentType === "RECEIPT",
      A.deposit?.transaction?.transactionNumber);

    const creditId = A.creditSale.id;
    const creditCode = A.creditSale.creditCode;
    const trackCode = A.trackingCode;
    created.creditSaleIds.push(creditId);
    created.paymentIds.push(A.deposit.payment.id);
    created.trxIds.push(A.deposit.transaction.id);
    created.docIds.push(A.invoice.id, A.deposit.receipt.id);
    created.customerIds.push(A.creditSale.customerId);
    const trackRow = (await pg.query(`SELECT id, payment_status, stock_committed FROM customer_trackings WHERE tracking_code=$1`, [trackCode])).rows[0];
    created.trackingIds.push(trackRow.id);
    ok("A7 inventory deducted at sale time (both lines)",
      (await pg.query(`SELECT quantity::float q FROM inventory_items WHERE id=$1`, [items[0].id])).rows[0].q === items[0].quantity - Q1 &&
      (await pg.query(`SELECT quantity::float q FROM inventory_items WHERE id=$1`, [items[1].id])).rows[0].q === items[1].quantity - Q2);
    ok("A8 order in Customer Tracking: payment CREDIT, stock committed",
      trackRow.payment_status === "CREDIT" && trackRow.stock_committed === true);

    // ── B. Installments by secure code ───────────────────────────────────
    console.log("── B. Installments via the customer's GM-* code ──");
    let runningBalance = r2(total - deposit);
    const inst1 = r2(Math.max(5, runningBalance * 0.3));
    const pay1 = await owner("/api/credit-sales", {
      method: "POST",
      body: JSON.stringify({ action: "pay", code: trackCode, amount: inst1, paymentMethod: "CASH", note: "TEST installment 1" }),
    });
    ok("B1 installment accepted via the CUSTOMER's tracking code",
      pay1.status === 200 && pay1.json?.success === true && pay1.json?.transaction?.category === "Credit Installment",
      pay1.json?.payment?.paymentNumber);
    runningBalance = r2(runningBalance - inst1);
    ok("B2 balance rolls forward with dates & payment number",
      Math.abs(pay1.json?.creditSale?.balanceGhs - runningBalance) < 0.01 && /^CRP-\d{4}-\d+$/.test(pay1.json?.payment?.paymentNumber || ""),
      `outstanding ${pay1.json?.creditSale?.balanceGhs}`);
    created.paymentIds.push(pay1.json.payment.id);
    created.trxIds.push(pay1.json.transaction.id);
    created.docIds.push(pay1.json.receipt.id);

    const overpay = await owner("/api/credit-sales", {
      method: "POST",
      body: JSON.stringify({ action: "pay", creditSaleId: creditId, amount: r2(runningBalance + 50), paymentMethod: "CASH" }),
    });
    ok("B3 overpayment rejected with the live outstanding balance",
      overpay.status === 400 && /exceeds the outstanding balance/i.test(overpay.json?.error || ""));

    const byCrd = await owner(`/api/credit-sales?code=${encodeURIComponent(creditCode)}&businessId=${BIZ}&includePayments=1`);
    const rowByCrd = (byCrd.json?.creditSales || [])[0];
    ok("B4 lookup by CRD-* staff code returns sale + dated payment history",
      byCrd.status === 200 && rowByCrd?.id === creditId && (rowByCrd?.payments || []).length === 2,
      `${(rowByCrd?.payments || []).length} payments`);

    // ── C. Business/Branch data isolation ────────────────────────────────
    console.log("── C. Data isolation ──");
    const anon = await fetch(`${BASE}/api/credit-sales?businessId=${BIZ}`);
    ok("C1 anonymous read rejected (401)", anon.status === 401);

    let iso = null;
    const isoCandidates = (await pg.query(
      `SELECT id, email, role FROM users WHERE is_active IS NOT FALSE AND role <> 'OWNER' ORDER BY id LIMIT 8`)).rows;
    for (const cand of isoCandidates) {
      const l = await apiLogin(cand.email, `GoMina@User${cand.id}`);
      const scope = l.json?.accessibleBusinessIds;
      if (l.status === 200 && Array.isArray(scope) && !scope.includes(BIZ)) {
        iso = { ...cand, cookie: l.cookie, scope, label: cand.role.replace(/_/g, " ").toLowerCase() };
        break;
      }
    }
    if (iso) {
      const isoApi = apiFor(iso.cookie);
      const denied = await isoApi(`/api/credit-sales?businessId=${BIZ}`);
      ok(`C2 ${iso.label} cannot list another business's credit sales (403)`, denied.status === 403);
      const payDenied = await isoApi("/api/credit-sales", {
        method: "POST",
        body: JSON.stringify({ action: "pay", creditSaleId: creditId, amount: 1, paymentMethod: "CASH" }),
      });
      ok(`C3 ${iso.label} cannot record installments for another business (403)`, payDenied.status === 403);
      const scoped = await isoApi(`/api/credit-sales`);
      const leaks = (scoped.json?.creditSales || []).filter((c) => !(iso.scope.includes(c.businessId)));
      ok("C4 scoped list contains only accessible branches", scoped.status === 200 && leaks.length === 0,
        `scope [${iso.scope.join(",")}]`);
    } else {
      ok("C2-C4 isolation negative", false, "no non-privileged user outside the fixture business found");
    }

    // ── D. Reflections ───────────────────────────────────────────────────
    console.log("── D. Reflections across the system ──");
    const init = await owner("/api/init");
    const initCredit = (init.json?.creditSales || []).find((c) => c.id === creditId);
    ok("D1 init payload carries the credit sale (Sales register source)", !!initCredit);
    const initCust = (init.json?.customers || []).find((c) => c.name === CUST);
    ok("D2 Customers reflection: credit count + outstanding on the CRM row",
      !!initCust && initCust.creditSalesCount === 1 && Math.abs(initCust.creditOutstandingGhs - runningBalance) < 0.01,
      `outstanding ${initCust?.creditOutstandingGhs}`);
    const creditTrx = (init.json?.transactions || []).filter((t) => ["Credit Deposit", "Credit Installment"].includes(t.category));
    ok("D3 Finance/Reports feed: deposit + installment booked as INCOME",
      creditTrx.length === 2 && creditTrx.every((t) => t.type === "INCOME" && t.businessId === BIZ),
      creditTrx.map((t) => t.category).join(" + "));
    const staffTrack = await owner("/api/tracking");
    const staffRow = (staffTrack.json?.trackings || []).find((t) => t.trackingCode === trackCode);
    ok("D4 Orders console carries live credit position on the order",
      !!staffRow?.credit && staffRow.credit.creditCode === creditCode && Math.abs(staffRow.credit.balanceGhs - runningBalance) < 0.01);
    const pub = await fetch(`${BASE}/api/track?code=${encodeURIComponent(trackCode)}`).then((r) => r.json());
    ok("D5 public /track payload: payment status CREDIT + customer-safe credit summary",
      pub.tracking?.payment?.status === "CREDIT" &&
      Math.abs(pub.tracking?.credit?.balanceGhs - runningBalance) < 0.01 &&
      (pub.tracking?.credit?.payments || []).length === 2,
      `${pub.tracking?.credit?.progressPercent}% paid`);

    // ── E. UI in real Chromium ───────────────────────────────────────────
    console.log("── E. Sales & Payments dashboard + customer UI (Chromium) ──");
    browser = await puppeteer.launch({
      executablePath: "/tmp/al2023/chromium",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const hook = (page, tag) => {
      page.on("dialog", (d) => d.dismiss().catch(() => {}));
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const txt = m.text();
        if (/Failed to load resource/.test(txt) && /(401|400|403|404|409)/.test(txt)) return;
        if (/net::/.test(txt)) return;
        pageErrors.push(`[${tag}] ${txt.slice(0, 250)}`);
      });
      page.on("pageerror", (e) => pageErrors.push(`[${tag}] PAGEERROR ${String(e).slice(0, 250)}`));
    };
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    hook(page, "console");
    await page.setViewport({ width: 1440, height: 960 });
    await page.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 90000 });
    await page.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
    await page.type('[data-testid="login-email"]', OWNER.email);
    await page.type('[data-testid="login-password"]', OWNER.pass);
    await page.click('[data-testid="login-submit"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="login-email"]'), { timeout: 60000 });
    await page.waitForSelector('[data-testid="sidebar-tab-sales"]', { timeout: 30000 });
    await page.click('[data-testid="sidebar-tab-sales"]');
    await page.waitForSelector('[data-testid="bm-credit-summary"]', { timeout: 30000 });
    const summaryApi = await owner(`/api/credit-sales?businessId=${BIZ}`);
    const S = summaryApi.json?.summary || {};
    const num = (s) => Number(String(s || "").replace(/[^0-9.\-]/g, ""));
    // The executive view defaults to the first business; select the fixture branch.
    await page.select('[data-testid="bm-branch-select"]', String(BIZ)).catch(() => {});
    await new Promise((r) => setTimeout(r, 900));
    const cardSales = num(await page.$eval('[data-testid="bm-credit-total-sales"]', (e) => e.textContent));
    const cardPaid = num(await page.$eval('[data-testid="bm-credit-total-paid"]', (e) => e.textContent));
    const cardDue = num(await page.$eval('[data-testid="bm-credit-outstanding"]', (e) => e.textContent));
    ok("E1 dashboard card: Credit Sales total matches the branch register",
      Math.abs(cardSales - S.creditSalesTotalGhs) < 0.01, `card ${cardSales} vs api ${S.creditSalesTotalGhs}`);
    ok("E2 dashboard card: Amount Paid matches", Math.abs(cardPaid - S.amountPaidTotalGhs) < 0.01, `card ${cardPaid}`);
    ok("E3 dashboard card: Outstanding Balance matches", Math.abs(cardDue - S.outstandingBalanceTotalGhs) < 0.01, `card ${cardDue}`);
    await page.screenshot({ path: "/home/user/credit-1-sales-dashboard.png" });

    await page.click('[data-testid="bm-tab-credit"]');
    await page.waitForSelector('[data-testid="bm-credit-register"]', { timeout: 15000 });
    await page.waitForSelector(`[data-testid="bm-credit-row-${creditId}"]`, { timeout: 15000 });
    const rowBal = num(await page.$eval(`[data-testid="bm-credit-balance-${creditId}"]`, (e) => e.textContent));
    ok("E4 Credit register lists the TEST sale with live balance", Math.abs(rowBal - runningBalance) < 0.02, `row ${rowBal}`);

    await page.click(`[data-testid="bm-credit-pay-${creditId}"]`);
    await page.waitForSelector('[data-testid="bm-credit-modal"]', { timeout: 15000 });
    const modalBal = num(await page.$eval('[data-testid="bm-credit-modal-balance"]', (e) => e.textContent));
    ok("E5 modal shows totals + payment history", Math.abs(modalBal - runningBalance) < 0.02 &&
      !!(await page.$('[data-testid="bm-credit-history"]')));
    await page.type('[data-testid="bm-credit-pay-amount"]', "1.00");
    await page.select('[data-testid="bm-credit-pay-method"]', "CASH");
    await page.click('[data-testid="bm-credit-pay-submit"]');
    await page.waitForFunction(
      () => /Installment recorded/i.test(document.querySelector('[data-testid="bm-credit-flash"]')?.textContent || ""),
      { timeout: 15000 }
    );
    const uiPayRow = (await pg.query(
      `SELECT id, transaction_id AS trx, receipt_document_id AS doc FROM credit_payments WHERE credit_sale_id=$1 ORDER BY id DESC LIMIT 1`, [creditId])).rows[0];
    created.paymentIds.push(uiPayRow.id);
    created.trxIds.push(uiPayRow.trx);
    created.docIds.push(uiPayRow.doc);
    runningBalance = r2(runningBalance - 1);
    await new Promise((r) => setTimeout(r, 700));
    const modalBal2 = num(await page.$eval('[data-testid="bm-credit-modal-balance"]', (e) => e.textContent));
    ok("E6 UI-recorded installment updates the outstanding balance", Math.abs(modalBal2 - runningBalance) < 0.02,
      `${modalBal2} vs ${runningBalance}`);
    await page.screenshot({ path: "/home/user/credit-2-installment-modal.png" });
    await page.click('[data-testid="bm-credit-close"]');

    const tpage = await ctx.newPage();
    hook(tpage, "track");
    await tpage.goto(`${BASE}/track?code=${encodeURIComponent(trackCode)}`, { waitUntil: "networkidle2", timeout: 90000 });
    await tpage.waitForSelector('[data-testid="track-credit-card"]', { timeout: 30000 });
    const tBal = num(await tpage.$eval('[data-testid="track-credit-balance"]', (e) => e.textContent));
    const tRows = await tpage.$$eval('[data-testid="track-credit-history"] > div > div', (els) => els.length).catch(() => 0);
    ok("E7 customer /track credit card: balance + dated history (customer code = access key)",
      Math.abs(tBal - runningBalance) < 0.02 && tRows === 3, `balance ${tBal}, ${tRows} payments`);
    await tpage.screenshot({ path: "/home/user/credit-3-customer-tracking.png" });

    // ── F. Settle in full ────────────────────────────────────────────────
    console.log("── F. Settle fully ──");
    const settle = await owner("/api/credit-sales", {
      method: "POST",
      body: JSON.stringify({ action: "pay", creditSaleId: creditId, amount: runningBalance, paymentMethod: "MTN_MOMO", reference: "TEST-SETTLE" }),
    });
    ok("F1 final installment settles the credit (status PAID, zero balance)",
      settle.status === 200 && settle.json?.settled === true && settle.json?.creditSale?.status === "PAID" && Math.abs(settle.json?.creditSale?.balanceGhs) < 0.01);
    created.paymentIds.push(settle.json.payment.id);
    created.trxIds.push(settle.json.transaction.id);
    created.docIds.push(settle.json.receipt.id);
    const afterSettle = (await pg.query(
      `SELECT t.payment_status AS tps, d.status AS inv FROM customer_trackings t, sales_documents d WHERE t.id=$1 AND d.id=$2`,
      [trackRow.id, created.docIds[0]])).rows[0];
    ok("F2 order + invoice flip to PAID across Tracking and Sales documents",
      afterSettle.tps === "PAID" && afterSettle.inv === "PAID");
    const again = await owner("/api/credit-sales", {
      method: "POST",
      body: JSON.stringify({ action: "pay", creditSaleId: creditId, amount: 1, paymentMethod: "CASH" }),
    });
    ok("F3 further payment on a settled credit is rejected", again.status === 400 && /already fully paid/i.test(again.json?.error || ""));
    const initAfter = await owner("/api/init");
    const custAfter = (initAfter.json?.customers || []).find((c) => c.name === CUST);
    ok("F4 customer outstanding drops to zero after settlement",
      !!custAfter && Math.abs(custAfter.creditOutstandingGhs) < 0.01 && custAfter.creditSalesCount === 1);

    await tpage.reload({ waitUntil: "networkidle2", timeout: 90000 });
    await tpage.waitForSelector('[data-testid="track-credit-card"]', { timeout: 30000 });
    const settledShown = await tpage.$('[data-testid="track-credit-settled"]');
    ok("F5 customer /track page shows the fully-paid state", !!settledShown);
    await tpage.screenshot({ path: "/home/user/credit-4-settled-tracking.png" });
    await ctx.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    console.log("── Cleanup ──");
    await cleanup();
  }

  // ── Z. Forensics ─────────────────────────────────────────────────────
  console.log("── Z. Forensics & baseline ──");
  const after = {
    customers: await cnt(`SELECT count(*)::int n FROM customers`),
    trackings: await cnt(`SELECT count(*)::int n FROM customer_trackings`),
    transactions: await cnt(`SELECT count(*)::int n FROM transactions`),
    docs: await cnt(`SELECT count(*)::int n FROM sales_documents`),
    creditSales: await cnt(`SELECT count(*)::int n FROM credit_sales`),
    creditPayments: await cnt(`SELECT count(*)::int n FROM credit_payments`),
    sessions: await cnt(`SELECT count(*)::int n FROM user_sessions`),
  };
  ok("Z1 forensics back to baseline (customers/orders/finance/docs/credit/sessions)",
    after.customers === baseline.customers && after.trackings === baseline.trackings &&
    after.transactions === baseline.transactions && after.docs === baseline.docs &&
    after.creditSales === baseline.creditSales && after.creditPayments === baseline.creditPayments &&
    after.sessions === baseline.sessions,
    JSON.stringify(after));
  const invOk0 = (await pg.query(`SELECT quantity::float q, status FROM inventory_items WHERE id=$1`, [invBaseline[0].id])).rows[0];
  const invOk1 = (await pg.query(`SELECT quantity::float q, status FROM inventory_items WHERE id=$1`, [invBaseline[1].id])).rows[0];
  ok("Z2 inventory restored exactly", invOk0.q === invBaseline[0].quantity && invOk0.status === invBaseline[0].status &&
    invOk1.q === invBaseline[1].quantity && invOk1.status === invBaseline[1].status);
  const leftovers = (await pg.query(
    `SELECT (SELECT count(*)::int FROM credit_sales WHERE customer_name LIKE 'TEST%') +
            (SELECT count(*)::int FROM customers WHERE name LIKE 'TEST%') +
            (SELECT count(*)::int FROM customer_trackings WHERE customer_name LIKE 'TEST%') AS n`)).rows[0].n;
  ok("Z3 zero TEST leftovers", leftovers === 0);
  ok("Z4 zero page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  await pg.end();
  console.log(`\n═══ RESULT: ${pass}/${pass + fail} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("SUITE CRASH:", e);
  try { await cleanup(); } catch {}
  try { await pg.end(); } catch {}
  process.exit(1);
});
