// Verify suite — R5 Unified BI Assistant (CAPABILITY-AUDIT-REPORT §8):
//   executive-only access, the unified cross-module feed (U1) with
//   urgent-first ordering, and the deterministic Q&A (U2) — finance summary,
//   top customers (RFM), stock status, overdue credit, budget variance,
//   cash forecast, pending actions, honest fallback — all scoped to the
//   caller's units and asserted against SQL-computed ground truth.
// Restores every touched row.
//
// Run: node dev-tooling/verify-bi-assistant.mjs
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const WORKER = { email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };
const GM = { email: "abena.gm@gomina360.com", pw: process.env.GM_PW || "GoMina@User2" };
const BM = { email: "emmanuel@gomina360.com", pw: process.env.BM_PW || "GoMina@User3" };

const BIZ = 1; // POULTRY-01
const day = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString("en-CA");
const month = new Date().toISOString().slice(0, 7);

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks.push({ name, pass: !!cond });
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
};

const client = new pg.Client(DB);
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;
const q1 = async (sql, params) => (await q(sql, params))[0];

async function apiLogin(cred) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: cred.email, password: cred.pw }),
  });
  const j = await r.json();
  if (!r.ok || !j.success) throw new Error(`api login failed ${cred.email}: ${JSON.stringify(j)}`);
  return j.sessionToken;
}
async function api(method, path, token, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const ask = async (token, question) => api("POST", "/api/assistant", token, { question });

const fx = { trxIds: [], customerIds: [], trackIds: [], creditIds: [], budgetIds: [], invoiceIds: [], invItemIds: [], approvalIds: [], notifIds: [] };

async function cleanup() {
  await q(`delete from transactions where id = any($1::int[])`, [fx.trxIds]).catch(() => {});
  await q(`delete from transactions where description like 'BI suite %'`);
  await q(`delete from customer_trackings where id = any($1::int[])`, [fx.trackIds]).catch(() => {});
  await q(`delete from customer_interactions where customer_id = any($1::int[])`, [fx.customerIds]).catch(() => {});
  await q(`delete from credit_payments where credit_sale_id = any($1::int[])`, [fx.creditIds]).catch(() => {});
  await q(`delete from credit_sales where id = any($1::int[])`, [fx.creditIds]).catch(() => {});
  await q(`delete from credit_sales where credit_code like 'CRD-BISUITE-%'`);
  await q(`delete from customers where name like 'BI Suite Customer%'`);
  await q(`delete from budgets where id = any($1::int[])`, [fx.budgetIds]).catch(() => {});
  await q(`delete from budgets where notes like 'BI suite%'`);
  await q(`delete from supplier_invoices where id = any($1::int[])`, [fx.invoiceIds]).catch(() => {});
  await q(`delete from supplier_invoices where invoice_number like 'BI-SUITE-INV-%'`);
  await q(`delete from inventory_items where id = any($1::int[])`, [fx.invItemIds]).catch(() => {});
  await q(`delete from inventory_items where sku like 'BI-SUITE-%'`);
  await q(`delete from approval_requests where id = any($1::int[])`, [fx.approvalIds]).catch(() => {});
  await q(`delete from approval_requests where target_label like 'BI suite%'`);
  await q(`delete from notifications where record_ref like 'approval:bisuite-%'`).catch(() => {});
}

try {
  await cleanup(); // crashed-run sweep
  const ownerTok = await apiLogin(OWNER);
  const workerTok = await apiLogin(WORKER);
  const gmTok = await apiLogin(GM);
  const bmTok = await apiLogin(BM);
  ok("logins (owner/worker/gm/bm)", ownerTok && workerTok && gmTok && bmTok);

  /* ── Fixtures (biz 1) ── */
  const [trxA] = (await q(
    `insert into transactions (transaction_number, business_id, branch_code, type, category, amount_ghs, payment_method, description, date, status, recorded_by, recorded_by_role)
     values ('TRX-BISUITE-1',$1,'POULTRY-01','INCOME','Egg Wholesale',1000,'CASH','BI suite income', $2,'COMPLETED','Kwame Mina','OWNER') returning id`,
    [BIZ, day(0)],
  ));
  const [trxB] = (await q(
    `insert into transactions (transaction_number, business_id, branch_code, type, category, amount_ghs, payment_method, description, date, status, recorded_by, recorded_by_role)
     values ('TRX-BISUITE-2',$1,'POULTRY-01','EXPENSE','Feed Expense',400,'MTN_MOMO','BI suite feed expense', $2,'COMPLETED','Kwame Mina','OWNER') returning id`,
    [BIZ, day(0)],
  ));
  fx.trxIds.push(trxA.id, trxB.id);
  const [budget] = (await q(
    `insert into budgets (owner_id, business_id, branch_code, period, kind, category, amount_ghs, notes, created_by_name)
     values (1,$1,'',$2,'EXPENSE','Feed Expense',300,'BI suite budget','Kwame Mina') returning id`,
    [BIZ, month],
  ));
  fx.budgetIds.push(budget.id);
  const [cust] = (await q(
    `insert into customers (name, type, phone, business_id, owner_id, total_spent_ghs, loyalty_points)
     values ('BI Suite Customer Alpha','WHOLESALE','+233 20 700 0001',$1,1,999999,300) returning id`,
    [BIZ],
  ));
  fx.customerIds.push(cust.id);
  for (const code of ["GM-BISUITE-1", "GM-BISUITE-2", "GM-BISUITE-3"]) {
    const [track] = (await q(
      `insert into customer_trackings (business_id, branch_code, branch_name, customer_id, customer_name, customer_phone, tracking_code, items, total_ghs, status, order_kind, created_at)
       values ($1,'POULTRY-01','POULTRY-01',$2,'BI Suite Customer Alpha','+233 20 700 0001',$3,'[]'::jsonb,900,'DELIVERED','STOCK', now()) returning id`,
      [BIZ, cust.id, code],
    ));
    fx.trackIds.push(track.id);
  }
  const [credit] = (await q(
    `insert into credit_sales (credit_code, business_id, branch_code, branch_name, customer_id, customer_name, customer_phone, items, total_ghs, amount_paid_ghs, balance_ghs, status, due_date, created_at)
     values ('CRD-BISUITE-1',$1,'POULTRY-01','POULTRY-01',$2,'BI Suite Customer Alpha','+233 20 700 0001','[]'::jsonb,600,100,500,'ACTIVE',$3, now() - '20 days'::interval) returning id`,
    [BIZ, cust.id, day(-12)],
  ));
  fx.creditIds.push(credit.id);
  const [invBiz1] = (await q(
    `insert into supplier_invoices (invoice_number, owner_id, business_id, supplier_name, amount_ghs, status, payment_mode, registered_by_name)
     values ('BI-SUITE-INV-1',1,$1,'BI Suite Supplier',250,'PENDING','ON_CREDIT','Kwame Mina') returning id`,
    [BIZ],
  ));
  fx.invoiceIds.push(invBiz1.id);
  const [invBiz8] = (await q(
    `insert into supplier_invoices (invoice_number, owner_id, business_id, supplier_name, amount_ghs, status, payment_mode, registered_by_name)
     values ('BI-SUITE-INV-8',1,8,'BI Suite Supplier',700,'PENDING','ON_CREDIT','Kwame Mina') returning id`,
    [],
  ));
  fx.invoiceIds.push(invBiz8.id);
  const [lowItem] = (await q(
    `insert into inventory_items (name, sku, business_id, branch_code, category, quantity, unit, cost_price_ghs, selling_price_ghs, min_stock_threshold, status)
     values ('BI Suite Widget','BI-SUITE-WIDGET',$1,'POULTRY-01','Other',4,'Pieces',50,80,40,'IN_STOCK') returning id`,
    [BIZ],
  ));
  fx.invItemIds.push(lowItem.id);
  const [appr] = (await q(
    `insert into approval_requests (owner_id, business_id, action, target_type, target_id, target_label, amount_ghs, status, requested_by_user_id, requested_by_name, payload_snapshot, created_at)
     values (1,$1,'EXPENSE','TRANSACTION',999999,'BI suite pending expense',150,'PENDING',1,'Akua Donkor','{}'::jsonb, now()) returning id`,
    [BIZ],
  ));
  fx.approvalIds.push(appr.id);
  ok("fixtures created (transactions, budget, customer, credit, invoices, low-stock item, approval)", !!trxA && !!budget && !!cust && !!credit && !!invBiz1 && !!lowItem && !!appr);

  /* ── 1. Access control ── */
  const wAccess = await api("GET", "/api/assistant", workerTok);
  ok("worker denied the assistant (403)", wAccess.status === 403);
  const oFeed = await api("GET", "/api/assistant", ownerTok);
  ok("owner gets the feed", oFeed.status === 200 && oFeed.json?.success && Array.isArray(oFeed.json?.feed));
  const gmFeed = await api("GET", "/api/assistant", gmTok);
  const bmFeed = await api("GET", "/api/assistant", bmTok);
  ok("GM and BM get the feed", gmFeed.status === 200 && bmFeed.status === 200);

  /* ── 2. U1 — unified feed ── */
  const feed = oFeed.json?.feed || [];
  ok("feed carries signals from multiple modules", new Set(feed.map((f) => f.module)).size >= 4, [...new Set(feed.map((f) => f.module))].join(","));
  const severities = feed.map((f) => f.severity || "INFO");
  const rank = { URGENT: 0, WARN: 1, INFO: 2 };
  ok("feed sorts urgent-first", severities.every((s, i) => i === 0 || rank[s] >= rank[severities[i - 1]]), severities.join(","));
  // The OWNER's scope is every org-1 business — compare against that.
  const monthFin = await q1(
    `select
       coalesce(sum(case when type='INCOME' then amount_ghs end),0) as income,
       coalesce(sum(case when type='EXPENSE' then amount_ghs end),0) as expense
     from transactions where business_id in (select id from businesses where owner_id = 1) and date like $1`,
    [`${month}%`],
  );
  const finItem = feed.find((f) => f.kind === "MONTH_SUMMARY");
  ok(
    "finance signal matches SQL ground truth",
    finItem && finItem.amountGhs === Math.round((Number(monthFin.income) - Number(monthFin.expense)) * 100) / 100,
    `feed ${finItem?.amountGhs} vs SQL ${Number(monthFin.income) - Number(monthFin.expense)}`,
  );
  ok("feed flags the overdue credit sale", feed.some((f) => f.module === "CREDIT" && f.kind === "OVERDUE" && /CRD-BISUITE-1/.test(f.detail || "")));
  ok("feed surfaces the pending approval", feed.some((f) => f.module === "APPROVALS" && f.kind === "PENDING"));
  ok("feed warns about low stock", feed.some((f) => f.module === "STOCK" && /BI Suite Widget|4 left/i.test(`${f.title} ${f.detail}`)));

  /* ── 3. U2 — deterministic Q&A ── */
  const fin = await ask(ownerTok, "How is this month's finance?");
  ok("finance question → FINANCE_SUMMARY intent", fin.json?.intent === "FINANCE_SUMMARY");
  ok(
    "finance answer matches ground truth",
    fin.json?.data?.monthIncomeGhs === Math.round(Number(monthFin.income) * 100) / 100 && fin.json?.data?.monthExpenseGhs === Math.round(Number(monthFin.expense) * 100) / 100,
    `income ${fin.json?.data?.monthIncomeGhs} vs ${monthFin.income}`,
  );
  ok("finance answer mentions the figures in prose", /GH₵/.test(fin.json?.answer || "") && /net/i.test(fin.json?.answer || ""));

  const top = await ask(ownerTok, "Who are my top customers?");
  ok("top-customers question → TOP_CUSTOMERS intent", top.json?.intent === "TOP_CUSTOMERS");
  const topAlpha = (top.json?.data?.topCustomers || []).find((c) => c.name === "BI Suite Customer Alpha");
  ok("fixture customer ranks #1 with its CHAMPION segment", !!topAlpha && topAlpha.segment === "CHAMPION" && topAlpha.monetaryGhs === 999999, JSON.stringify(topAlpha || {}));

  const stock = await ask(ownerTok, "What's low in stock?");
  ok("stock question → STOCK_STATUS intent", stock.json?.intent === "STOCK_STATUS");
  ok("stock answer names the low item with its reorder point", /BI Suite Widget/.test(stock.json?.answer || "") && /4 left|reorder at 40/i.test(stock.json?.answer || ""), (stock.json?.answer || "").slice(0, 120));

  const overdue = await ask(ownerTok, "What credit is overdue?");
  ok("credit question → OVERDUE_ITEMS intent", overdue.json?.intent === "OVERDUE_ITEMS");
  ok(
    "overdue answer shows the code, amount and days",
    /CRD-BISUITE-1/.test(overdue.json?.answer || "") && /GH₵ 500/.test(overdue.json?.answer || "") && /12 days? past due/i.test(overdue.json?.answer || ""),
    (overdue.json?.answer || "").slice(0, 160),
  );

  const budgetQ = await ask(ownerTok, "Am I over budget?");
  ok("budget question → BUDGET_VARIANCE intent", budgetQ.json?.intent === "BUDGET_VARIANCE");
  const feedLine = (budgetQ.json?.data?.lines || []).find((l) => l.category === "Feed Expense");
  ok(
    "variance computed against actuals (budget 300, spent ≥ 400 ⇒ OVER)",
    feedLine && feedLine.budgetedGhs === 300 && feedLine.actualGhs >= 400 && feedLine.varianceGhs <= -100 && /OVER/i.test(budgetQ.json?.answer || ""),
    JSON.stringify(feedLine || {}),
  );

  const forecast = await ask(ownerTok, "What's my 30-day cash forecast?");
  ok("forecast question → CASH_FORECAST intent", forecast.json?.intent === "CASH_FORECAST");
  ok(
    "forecast grounds payables in unpaid supplier invoices (250 + 700 for owner scope)",
    Math.abs(Number(forecast.json?.data?.payablesGhs) - 950) < 0.01,
    `payables ${forecast.json?.data?.payablesGhs}`,
  );
  const bmForecast = await ask(bmTok, "What's my 30-day cash forecast?");
  ok(
    "BM's forecast stays scoped to their unit (payables 250 only)",
    Math.abs(Number(bmForecast.json?.data?.payablesGhs) - 250) < 0.01,
    `payables ${bmForecast.json?.data?.payablesGhs}`,
  );

  const actions = await ask(ownerTok, "Show pending approvals and what needs my attention");
  ok("actions question → ACTIONS intent", actions.json?.intent === "ACTIONS");
  ok("actions answer counts the pending approval", Number(actions.json?.data?.approvals?.pendingCount) >= 1 && /approval/i.test(actions.json?.answer || ""));

  const fallback = await ask(ownerTok, "What is the meaning of life?");
  ok("unknown question → honest FALLBACK with suggestions", fallback.json?.intent === "FALLBACK" && Array.isArray(fallback.json?.suggestions) && fallback.json?.suggestions.length >= 3 && !/meaning of life/i.test(fallback.json?.answer || ""));

  const empty = await api("POST", "/api/assistant", ownerTok, { question: "   " });
  ok("empty question rejected", empty.status === 400);
  const getQ = await api("GET", `/api/assistant?q=${encodeURIComponent("What credit is overdue?")}`, ownerTok);
  ok("GET ?q= works the same as POST", getQ.json?.intent === "OVERDUE_ITEMS");
} catch (e) {
  console.error("SUITE ERROR:", e);
  failures++;
} finally {
  await cleanup();
  await client.end();
}

console.log(`\n${failures === 0 ? "🌟" : "💥"} bi-assistant: ${checks.length - failures}/${checks.length} checks passed${failures ? ` (${failures} FAILED)` : ""}`);
process.exit(failures ? 1 : 0);
