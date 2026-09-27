// Verify suite — R3 Customer 360 & Dunning (CAPABILITY-AUDIT-REPORT §6):
//   interaction timeline CRUD + permissions, per-customer preferences, RFM
//   segmentation, the assembled 360 payload (orders, credit, statement with
//   running balance) and the marker-gated dunning sweep (T+1/T+7/T+30).
// Restores every touched row.
//
// Run: node dev-tooling/verify-customer-360.mjs
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const WORKER = { email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };
const GM = { email: "abena.gm@gomina360.com", pw: process.env.GM_PW || "GoMina@User2" };

const BIZ = 1; // POULTRY-01
const day = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString("en-CA");

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

const suiteStart = new Date();
const fx = { customerId: null, dormantId: null, newId: null, biz8Id: null, trackIds: [], creditIds: [], paymentIds: [], interactionIds: [] };

async function cleanup() {
  const codes = (await q(`select credit_code from credit_sales where customer_name = 'C360 Suite Customer'`)).map((r) => r.credit_code);
  await q(`delete from notifications where record_ref = any($1::text[])`, [codes.flatMap((c) => [`dunning:${c}:REMINDER`, `dunning:${c}:FIRM`, `dunning:${c}:FINAL`])]).catch(() => {});
  await q(`delete from system_markers where key like 'dunning:%' and substring(key from 9 for 20) ~ '^[0-9]+$'`).catch(() => {});
  const myMarkerIds = (await q(`select id from credit_sales where customer_name = 'C360 Suite Customer'`)).map((r) => r.id);
  for (const id of myMarkerIds) await q(`delete from system_markers where key like $1`, [`dunning:${id}:%`]).catch(() => {});
  await q(`delete from credit_payments where credit_sale_id = any($1::int[])`, [fx.creditIds]).catch(() => {});
  await q(`delete from credit_sales where customer_name = 'C360 Suite Customer'`);
  await q(`delete from customer_trackings where customer_id = any($1::int[])`, [[fx.customerId, fx.dormantId, fx.newId].filter(Boolean)]).catch(() => {});
  await q(`delete from customer_interactions where customer_id = any($1::int[])`, [[fx.customerId].filter(Boolean)]).catch(() => {});
  await q(`delete from customer_interactions where actor_name = 'Dunning sweep' and created_at >= $1`, [suiteStart]);
  await q(`delete from customers where name in ('C360 Suite Customer','C360 Suite Dormant','C360 Suite New','C360 Suite Biz8')`);
}

try {
  await cleanup(); // crashed-run sweep
  const ownerTok = await apiLogin(OWNER);
  const workerTok = await apiLogin(WORKER);
  const gmTok = await apiLogin(GM);
  ok("logins (owner/worker/gm)", ownerTok && workerTok && gmTok);

  // ── Fixtures: champion (recent, frequent, high spend), dormant, new, biz-8 ──
  const [cust] = (await q(
    `insert into customers (name, type, phone, email, business_id, owner_id, total_spent_ghs, loyalty_points)
     values ('C360 Suite Customer','RETAIL','+233 20 000 0001','c360@suite.gh',$1,1,1500,120) returning id`,
    [BIZ],
  ));
  fx.customerId = cust.id;
  const [dormant] = (await q(
    `insert into customers (name, type, phone, business_id, owner_id, total_spent_ghs) values ('C360 Suite Dormant','WHOLESALE','+233 20 000 0002',$1,1,800) returning id`,
    [BIZ],
  ));
  fx.dormantId = dormant.id;
  const [newbie] = (await q(
    `insert into customers (name, type, phone, business_id, owner_id) values ('C360 Suite New','RETAIL','+233 20 000 0003',$1,1) returning id`,
    [BIZ],
  ));
  fx.newId = newbie.id;
  const [biz8] = (await q(
    `insert into customers (name, type, phone, business_id, owner_id) values ('C360 Suite Biz8','RETAIL','+233 20 000 0004',8,1) returning id`,
    [],
  ));
  fx.biz8Id = biz8.id;

  for (const [daysAgo, code] of [[100, "GM-C360-OLD"], [30, "GM-C360-MID"], [0, "GM-C360-NOW"]]) {
    const [t] = (await q(
      `insert into customer_trackings (business_id, branch_code, branch_name, customer_id, customer_name, customer_phone, tracking_code, items, total_ghs, status, order_kind, created_at)
       values ($1,'POULTRY-01','POULTRY-01',$2,'C360 Suite Customer','+233 20 000 0001',$3,'[{"description":"Eggs","quantity":1,"unitPrice":200,"total":200}]'::jsonb,200,'DELIVERED','STOCK', now() - ($4 || ' days')::interval) returning id`,
      [BIZ, fx.customerId, code, String(daysAgo)],
    ));
    fx.trackIds.push(t.id);
  }
  // Dormant: one order 200 days ago.
  await q(
    `insert into customer_trackings (business_id, branch_code, branch_name, customer_id, customer_name, customer_phone, tracking_code, items, total_ghs, status, order_kind, created_at)
     values ($1,'POULTRY-01','POULTRY-01',$2,'C360 Suite Dormant','+233 20 000 0002','GM-C360-DORM','[]'::jsonb,300,'DELIVERED','STOCK', now() - '200 days'::interval)`,
    [BIZ, fx.dormantId],
  );
  // Credit sales: A overdue 10d (FIRM), B paid (never dunned), C overdue 35d (FINAL).
  const [csA] = (await q(
    `insert into credit_sales (credit_code, business_id, branch_code, branch_name, customer_id, customer_name, customer_phone, items, subtotal_ghs, total_ghs, amount_paid_ghs, balance_ghs, status, due_date, created_at)
     values ('CRD-C360-A',$1,'POULTRY-01','POULTRY-01',$2,'C360 Suite Customer','+233 20 000 0001','[]'::jsonb,500,500,100,400,'ACTIVE',$3, now() - '20 days'::interval) returning id`,
    [BIZ, fx.customerId, day(-10)],
  ));
  const [csB] = (await q(
    `insert into credit_sales (credit_code, business_id, branch_code, branch_name, customer_id, customer_name, customer_phone, items, subtotal_ghs, total_ghs, amount_paid_ghs, balance_ghs, status, due_date, paid_at, created_at)
     values ('CRD-C360-B',$1,'POULTRY-01','POULTRY-01',$2,'C360 Suite Customer','+233 20 000 0001','[]'::jsonb,300,300,300,0,'PAID',$3, now(), now() - '50 days'::interval) returning id`,
    [BIZ, fx.customerId, day(-40)],
  ));
  const [csC] = (await q(
    `insert into credit_sales (credit_code, business_id, branch_code, branch_name, customer_id, customer_name, customer_phone, items, subtotal_ghs, total_ghs, amount_paid_ghs, balance_ghs, status, due_date, created_at)
     values ('CRD-C360-C',$1,'POULTRY-01','POULTRY-01',$2,'C360 Suite Customer','+233 20 000 0001','[]'::jsonb,250,250,0,250,'ACTIVE',$3, now() - '40 days'::interval) returning id`,
    [BIZ, fx.customerId, day(-35)],
  ));
  fx.creditIds = [csA.id, csB.id, csC.id];
  const [payA] = (await q(
    `insert into credit_payments (payment_number, credit_sale_id, business_id, branch_code, branch_name, amount_ghs, payment_method, created_at)
     values ('CRP-C360-A1',$1,$2,'POULTRY-01','POULTRY-01',100,'MTN_MOMO', now() - '15 days'::interval) returning id`,
    [csA.id, BIZ],
  ));
  const [payB] = (await q(
    `insert into credit_payments (payment_number, credit_sale_id, business_id, branch_code, branch_name, amount_ghs, payment_method, created_at)
     values ('CRP-C360-B1',$1,$2,'POULTRY-01','POULTRY-01',300,'CASH', now() - '45 days'::interval) returning id`,
    [csB.id, BIZ],
  ));
  fx.paymentIds = [payA.id, payB.id];
  ok("fixtures created (customers, orders, credit sales, payments)", !!cust && !!csA && !!payB);

  // ── 1. Interaction CRUD + permissions ──
  const badType = await api("POST", "/api/customer-interactions", ownerTok, { customerId: fx.customerId, type: "SMOKE_SIGNAL", summary: "x" });
  ok("invalid interaction type rejected", badType.status === 400);
  const badSummary = await api("POST", "/api/customer-interactions", ownerTok, { customerId: fx.customerId, type: "CALL", summary: "  " });
  ok("empty summary rejected", badSummary.status === 400);
  const badDate = await api("POST", "/api/customer-interactions", ownerTok, { customerId: fx.customerId, type: "CALL", summary: "x", followUpOn: "tomorrow" });
  ok("malformed follow-up date rejected", badDate.status === 400);

  const int1 = await api("POST", "/api/customer-interactions", ownerTok, {
    customerId: fx.customerId, type: "CALL", summary: "Called about the credit balance", detail: "Promised to pay by Friday.", followUpOn: day(3),
  });
  ok("owner logs an interaction", int1.status === 200 && int1.json?.interaction?.actorName === "Kwame Mina");
  fx.interactionIds.push(int1.json?.interaction?.id);

  const int2 = await api("POST", "/api/customer-interactions", workerTok, {
    customerId: fx.customerId, type: "VISIT", summary: "Delivered 10 crates, customer happy",
  });
  ok("worker with unit access logs an interaction", int2.status === 200);
  fx.interactionIds.push(int2.json?.interaction?.id);

  const wDenied = await api("POST", "/api/customer-interactions", workerTok, {
    customerId: fx.biz8Id, type: "NOTE", summary: "should not work",
  });
  ok("worker from another unit cannot log for that customer (403)", wDenied.status === 403);

  const timeline = await api("GET", `/api/customer-interactions?customerId=${fx.customerId}`, ownerTok);
  ok(
    "timeline lists both interactions, newest first",
    timeline.json?.success && (timeline.json.interactions || []).length === 2 && String(timeline.json.interactions[0]?.occurredAt || "") >= String(timeline.json.interactions[1]?.occurredAt || ""),
  );

  const patched = await api("PATCH", "/api/customer-interactions", ownerTok, { id: int1.json.interaction.id, summary: "Called — promised Friday payment (updated)" });
  ok("author edits an interaction", patched.json?.success && /updated/.test(patched.json?.interaction?.summary || ""));
  const wPatchDenied = await api("PATCH", "/api/customer-interactions", workerTok, { id: int1.json.interaction.id, summary: "hijack" });
  ok("non-author worker cannot edit the owner's interaction (403)", wPatchDenied.status === 403);
  const gmPatch = await api("PATCH", "/api/customer-interactions", gmTok, { id: int2.json.interaction.id, followUpOn: day(5) });
  ok("GM (manager) can edit a unit interaction", gmPatch.json?.success);

  const followUps = await api("GET", "/api/customer-interactions?followUps=1", ownerTok);
  ok(
    "follow-up feed shows upcoming reminders",
    (followUps.json?.followUps || []).some((f) => Number(f.customerId) === Number(fx.customerId) && f.followUpOn === day(5)),
  );

  const del = await api("DELETE", `/api/customer-interactions?id=${int2.json.interaction.id}`, workerTok);
  ok("author deletes their interaction", del.json?.success);
  fx.interactionIds = fx.interactionIds.filter((id) => id !== int2.json.interaction.id);

  // ── 2. Preferences (enterprise PATCH) ──
  const prefs = await api("PATCH", "/api/enterprise", ownerTok, {
    entityType: "CUSTOMERS", id: fx.customerId, data: { preferences: { paymentTerms: "NET_30", preferredChannel: "SMS", deliveryNote: "Leave with gatekeeper" } },
  });
  ok("owner saves customer preferences", prefs.json?.success);
  const prefRow = await q1(`select preferences from customers where id = $1`, [fx.customerId]);
  ok(
    "preferences persisted as sanitized key/value pairs",
    prefRow?.preferences?.paymentTerms === "NET_30" && prefRow?.preferences?.preferredChannel === "SMS",
    JSON.stringify(prefRow?.preferences || {}),
  );
  const wPrefs = await api("PATCH", "/api/enterprise", workerTok, { entityType: "CUSTOMERS", id: fx.customerId, data: { preferences: { paymentTerms: "CASH_ONLY" } } });
  ok("worker cannot edit preferences (403)", wPrefs.status === 403);

  // ── 3. RFM insights ──
  const insights = await api("GET", "/api/customer-interactions?insights=1", ownerTok);
  const mine = (insights.json?.insights || []).find((i) => Number(i.customerId) === Number(fx.customerId));
  const dormantIns = (insights.json?.insights || []).find((i) => Number(i.customerId) === Number(fx.dormantId));
  const newIns = (insights.json?.insights || []).find((i) => Number(i.customerId) === Number(fx.newId));
  ok("frequent, recent, high-spend customer → CHAMPION", mine?.segment === "CHAMPION", JSON.stringify(mine || {}));
  ok("200-day-silent customer → DORMANT", dormantIns?.segment === "DORMANT");
  ok("no-order customer → NEW", newIns?.segment === "NEW");
  ok("insights carry open credit (GH₵ 650)", Math.abs(Number(mine?.openCreditGhs) - 650) < 0.01, `GH₵ ${mine?.openCreditGhs}`);

  // ── 4. The 360 assembly ──
  const c360 = await api("GET", `/api/customer-interactions?customerId=${fx.customerId}&include360=1`, ownerTok);
  const d = c360.json?.customer360;
  ok("360 payload assembles", c360.status === 200 && !!d?.profile && d.profile.name === "C360 Suite Customer");
  ok("360 segment matches insights", d?.insights?.segment === "CHAMPION");
  ok("360 orders include all 3 trackings", (d?.orders || []).length === 3);
  ok("360 credit sales include all 3", (d?.creditSales || []).length === 3);
  ok("360 payments include both installments", (d?.payments || []).length === 2);
  ok(
    "statement balances: 1650 debits − 400 credits = 1250",
    Math.abs(Number(d?.statementBalanceGhs) - 1250) < 0.01,
    `GH₵ ${d?.statementBalanceGhs}`,
  );
  const lastLine = (d?.statement || [])[(d?.statement || []).length - 1];
  ok("statement lines carry a running balance", Math.abs(Number(lastLine?.balanceGhs) - 1250) < 0.01);
  ok("timeline inside 360 shows the surviving interaction", (d?.interactions || []).length === 1);

  const w360 = await api("GET", `/api/customer-interactions?customerId=${fx.biz8Id}&include360=1`, workerTok);
  ok("worker cannot open the 360 of another unit's customer (403)", w360.status === 403);
  const missing = await api("GET", `/api/customer-interactions?customerId=999999&include360=1`, ownerTok);
  ok("unknown customer 404s", missing.status === 404);

  // ── 5. Dunning sweep ──
  const daily = await api("GET", "/api/cron/daily?force=1", ownerTok);
  ok("daily ops runs the dunning step", daily.json?.ran === true && (daily.json?.steps || []).some((s) => s.step === "dunning" && s.ok), (daily.json?.steps || []).map((s) => `${s.step}${s.ok ? "" : "!"}`).join(","));

  const notifA = await q(
    `select * from notifications where type = 'CREDIT_OVERDUE' and record_ref = $1`,
    [`dunning:CRD-C360-A:FIRM`],
  );
  ok("10-days-overdue sale got the FIRM chase", notifA.length >= 1, `${notifA.length} notification(s)`);
  const notifC = await q(
    `select * from notifications where type = 'CREDIT_OVERDUE' and record_ref = $1`,
    [`dunning:CRD-C360-C:FINAL`],
  );
  ok("35-days-overdue sale got the FINAL notice (URGENT)", notifC.length >= 1 && notifC.every((n) => n.priority === "URGENT"));
  const notifB = await q(
    `select * from notifications where type = 'CREDIT_OVERDUE' and record_ref like $1`,
    [`dunning:CRD-C360-B:%`],
  );
  ok("settled sale is never dunned", notifB.length === 0);
  const notifRecipients = new Set(notifA.map((n) => n.user_id));
  ok("chase went to real recipients (owner + branch team)", notifRecipients.size >= 1, `${notifRecipients.size} recipient(s)`);

  const dunInts = await q(
    `select * from customer_interactions where customer_id = $1 and actor_name = 'Dunning sweep'`,
    [fx.customerId],
  );
  ok("each chase logged on the customer timeline", dunInts.length === 2, `${dunInts.length} dunning interactions`);
  ok(
    "dunning interactions are FOLLOW_UPs with stage detail",
    dunInts.every((r) => r.type === "FOLLOW_UP" && /firm|final/i.test(r.summary || "")),
  );
  const markers = await q(`select key from system_markers where key like 'dunning:%'`);
  const myMarkers = markers.filter((m) => [csA.id, csC.id].some((id) => m.key.startsWith(`dunning:${id}:`)));
  ok("stage markers recorded (one per sale)", myMarkers.length === 2, myMarkers.map((m) => m.key).join(", "));

  const before = (await q(`select count(*)::int as n from notifications where type = 'CREDIT_OVERDUE'`))[0].n;
  await api("GET", "/api/cron/daily?force=1", ownerTok);
  const after = (await q(`select count(*)::int as n from notifications where type = 'CREDIT_OVERDUE'`))[0].n;
  ok("re-running the sweep never duplicates a chase", before === after, `${before} → ${after}`);
} catch (e) {
  console.error("SUITE ERROR:", e);
  failures++;
} finally {
  await cleanup();
  await client.end();
}

console.log(`\n${failures === 0 ? "🌟" : "💥"} customer-360: ${checks.length - failures}/${checks.length} checks passed${failures ? ` (${failures} FAILED)` : ""}`);
process.exit(failures ? 1 : 0);
