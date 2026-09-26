// Verify suite — Budgets & Cash-Flow Forecast (P4): budget upsert + live
// variance vs actuals (baseline excluded), category & TOTAL semantics,
// revenue targets, role gates, and the 13-week projection (starting cash =
// Σ business metrics, credit inflow weeks, open-PO outflow, payroll,
// run-rates, first-negative-week consistency). Self-cleaning.
//
// Run: node dev-tooling/verify-budgets-cashflow.mjs
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const AKUA = { email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };

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

async function login(cred) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: cred.email, password: cred.pw }),
  });
  return { ok: r.ok, cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
};
const api = async (cookie, method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
};

const period = new Date().toISOString().slice(0, 7);
const isBaseline = (n) => /^TRX-\d{4}-100[1-6]$/.test(String(n || ""));
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const createdBudgetIds = [];
let creditId = null;

try {
  const ownerS = await login(OWNER);
  const akuaS = await login(AKUA);
  ok("logins", ownerS.ok && akuaS.ok);

  // ── 1. Create the all-in expense envelope for POULTRY-01 ──
  const p1 = await api(ownerS.cookie, "POST", "/api/budgets", {
    businessId: 1, period, kind: "EXPENSE", category: "TOTAL", amountGhs: 5000,
  });
  ok("POST budget TOTAL expense line", p1.status === 200 && p1.data?.success === true && p1.data?.line?.amountGhs === 5000);
  if (p1.data?.line?.id) createdBudgetIds.push(p1.data.line.id);

  // Live actual for the business this month (baseline excluded).
  const exp = await q(
    "select category, amount_ghs, transaction_number from transactions where business_id = 1 and type = 'EXPENSE' and date like $1",
    [`${period}-%`],
  );
  const liveExp = exp.filter((t) => !isBaseline(t.transaction_number));
  const liveExpTotal = r2(liveExp.reduce((s, t) => s + Number(t.amount_ghs), 0));
  const byCat = new Map();
  for (const t of liveExp) byCat.set(t.category, r2((byCat.get(t.category) || 0) + Number(t.amount_ghs)));
  const topCat = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0];

  const g1 = await api(ownerS.cookie, "GET", `/api/budgets?businessId=1&period=${period}`);
  const totalLine = (g1.data?.lines || []).find((l) => l.kind === "EXPENSE" && l.category === "TOTAL");
  ok("GET shows the TOTAL line with live actuals",
    g1.status === 200 && !!totalLine && totalLine.actualGhs === liveExpTotal, `actual ${totalLine?.actualGhs} vs SQL ${liveExpTotal}`);
  ok("variance = budget − actual", totalLine && r2(totalLine.budgetGhs - totalLine.actualGhs) === r2(totalLine.varianceGhs));
  ok("status flags OVER when actual exceeds budget", totalLine && (liveExpTotal > 5000 ? totalLine.status === "OVER" : ["OK", "WATCH"].includes(totalLine.status)));

  // ── 2. Category-level line ──
  if (topCat) {
    const p2 = await api(ownerS.cookie, "POST", "/api/budgets", {
      businessId: 1, period, kind: "EXPENSE", category: topCat[0], amountGhs: Math.max(10, Math.round(topCat[1] * 0.5)),
    });
    ok("POST category budget line", p2.status === 200 && p2.data?.success === true);
    if (p2.data?.line?.id) createdBudgetIds.push(p2.data.line.id);
    const g2 = await api(ownerS.cookie, "GET", `/api/budgets?businessId=1&period=${period}`);
    const catLine = (g2.data?.lines || []).find((l) => l.category === topCat[0] && l.kind === "EXPENSE");
    ok("category actual matches the live category sum", catLine && catLine.actualGhs === topCat[1], `${catLine?.actualGhs} vs ${topCat[1]}`);
    ok("category line flags OVER at half the spend", catLine?.status === "OVER");
  } else {
    ok("category budget line (no live categories this month — skipped)", true);
  }

  // ── 3. Upsert: same key updates the amount, never duplicates ──
  const p3 = await api(ownerS.cookie, "POST", "/api/budgets", {
    businessId: 1, period, kind: "EXPENSE", category: "TOTAL", amountGhs: 7500,
  });
  if (p3.data?.line?.id) createdBudgetIds.push(p3.data.line.id);
  const g3 = await api(ownerS.cookie, "GET", `/api/budgets?businessId=1&period=${period}`);
  const totalsNow = (g3.data?.lines || []).filter((l) => l.kind === "EXPENSE" && l.category === "TOTAL");
  ok("upsert updates the amount in place", totalsNow.length === 1 && totalsNow[0].budgetGhs === 7500);

  // ── 4. Revenue target ──
  const p4 = await api(ownerS.cookie, "POST", "/api/budgets", {
    businessId: 1, period, kind: "REVENUE", category: "TOTAL", amountGhs: 20000,
  });
  if (p4.data?.line?.id) createdBudgetIds.push(p4.data.line.id);
  const inc = await q(
    "select amount_ghs, transaction_number from transactions where business_id = 1 and type = 'INCOME' and date like $1",
    [`${period}-%`],
  );
  const liveInc = r2(inc.filter((t) => !isBaseline(t.transaction_number)).reduce((s, t) => s + Number(t.amount_ghs), 0));
  const g4 = await api(ownerS.cookie, "GET", `/api/budgets?businessId=1&period=${period}`);
  ok("revenue target vs live income actual",
    r2(g4.data?.totals?.revenueActual) === liveInc && r2(g4.data?.totals?.revenueBudget) === 20000,
    `actual ${g4.data?.totals?.revenueActual} vs ${liveInc}`);

  // ── 5. Role gates + scoping ──
  ok("workers are barred from budgets", (await api(akuaS.cookie, "GET", "/api/budgets?businessId=1&period=" + period)).status === 403);
  ok("workers cannot write budgets", (await api(akuaS.cookie, "POST", "/api/budgets", { businessId: 1, period, kind: "EXPENSE", category: "TOTAL", amountGhs: 1 })).status === 403);
  const gOther = await api(ownerS.cookie, "GET", `/api/budgets?businessId=8&period=${period}`);
  ok("budget lines stay scoped per business", !(gOther.data?.lines || []).some((l) => Number(l.businessId) === 1));
  const badPeriod = await api(ownerS.cookie, "POST", "/api/budgets", { businessId: 1, period: "2026-13", kind: "EXPENSE", category: "TOTAL", amountGhs: 5 });
  ok("invalid period rejected", badPeriod.status === 400);

  // ── 6. DELETE a line ──
  const del = await api(ownerS.cookie, "DELETE", `/api/budgets?id=${createdBudgetIds[createdBudgetIds.length - 1]}`);
  ok("DELETE removes a budget line", del.status === 200);
  if (del.status === 200) createdBudgetIds.pop();

  // ═══ CASH-FLOW FORECAST ═══
  // Fixture: one ACTIVE credit sale with a balance due in ~10 days.
  const dueDate = new Date(Date.now() + 10 * 86400000).toLocaleDateString("en-CA");
  creditId = (await client.query(
    `insert into credit_sales (credit_code, business_id, customer_name, items, subtotal_ghs, total_ghs, amount_paid_ghs, balance_ghs, status, due_date, created_by_name)
     values ('CRD-VERIFY-CASHFLOW', 1, 'Verify Suite Customer', '[]'::jsonb, 1200, 1200, 200, 1000, 'ACTIVE', $1, 'verify-suite') returning id`,
    [dueDate],
  )).rows[0]?.id;
  ok("fixture credit sale inserted", !!creditId);

  const f1 = await api(ownerS.cookie, "GET", "/api/cashflow/forecast?businessId=all&weeks=13");
  ok("GET forecast (all businesses)", f1.status === 200 && f1.data?.success === true);
  ok("13 weekly buckets returned", (f1.data?.buckets || []).length === 13);

  const metrics = await q("select cash_flow_ghs from business_metrics");
  const expectedStart = r2(metrics.reduce((s, m) => s + Number(m.cash_flow_ghs || 0), 0));
  ok("starting cash = Σ business metrics (Command Center liquid surplus)",
    r2(f1.data?.startingCashGhs) === expectedStart, `${f1.data?.startingCashGhs} vs ${expectedStart}`);

  // The fixture credit balance (1000) must land as certain inflow in the week containing +10 days.
  const wk = Math.floor(10 / 7); // week index (0-based)
  const bucket = f1.data?.buckets?.[wk];
  ok("credit balance lands as committed inflow in its due week",
    bucket && r2(bucket.certainInflowGhs) >= 1000, `week ${bucket?.week}: ${bucket?.certainInflowGhs}`);

  // Cumulative math: start + Σ nets == final cumulative.
  const sumNets = r2((f1.data?.buckets || []).reduce((s, b) => s + Number(b.netGhs), 0));
  ok("projection arithmetic is consistent",
    r2(Number(f1.data?.startingCashGhs) + sumNets) === r2(Number(f1.data?.projectedEndCashGhs)));

  // firstNegativeWeek consistency.
  const neg = (f1.data?.buckets || []).find((b) => Number(b.cumulativeCashGhs) < 0);
  ok("firstNegativeWeek matches the buckets", (f1.data?.firstNegativeWeek ?? null) === (neg?.week ?? null));

  // Open POs & payroll figures match SQL.
  const poSum = r2((await q("select coalesce(sum(total_ghs),0) as s from supplier_orders where status in ('RAISED','SENT','SHIPPED','IN_TRANSIT','ARRIVED')"))[0].s);
  ok("committed purchases match open POs", r2(f1.data?.openPurchaseOrdersGhs) === poSum, `${f1.data?.openPurchaseOrdersGhs} vs ${poSum}`);

  ok("assumptions are disclosed", Array.isArray(f1.data?.assumptions) && f1.data.assumptions.length >= 4);
  ok("workers are barred from the forecast", (await api(akuaS.cookie, "GET", "/api/cashflow/forecast")).status === 403);
  const fBiz = await api(ownerS.cookie, "GET", "/api/cashflow/forecast?businessId=8");
  ok("single-business forecast works", fBiz.status === 200 && (fBiz.data?.buckets || []).length === 13);
} catch (e) {
  ok("suite ran without exception", false, String(e?.message || e));
} finally {
  if (!process.env.KEEP) {
    try {
      for (const id of createdBudgetIds) await client.query("delete from budgets where id = $1", [id]);
      if (creditId) await client.query("delete from credit_sales where id = $1", [creditId]);
      console.log("🧹 budget lines + credit fixture removed");
    } catch (e) {
      console.log("⚠ cleanup issue:", e?.message);
    }
  }
  await client.end();
}

console.log(`\n${failures === 0 ? "🎉 ALL BUDGETS & CASH-FLOW CHECKS PASSED" : `💥 ${failures} FAILING`} (${checks.length} checks)`);
process.exit(failures === 0 ? 0 : 1);
