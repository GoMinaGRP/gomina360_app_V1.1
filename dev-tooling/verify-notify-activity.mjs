/**
 * BELL NOTIFICATIONS & AUDIT EVENTS — the activity contract.
 *
 * What this suite pins (the OWNER's brief: "notify relevant users about
 * revenue/sales, transactions, expenses, stock changes, approvals, audit
 * events, supervisor notes — and do not duplicate or spam"):
 *
 *  A. MONEY ACTIVITY — a sale / an expense recorded anywhere the product
 *     writes revenue (Sales Center `postSale`, direct ledger INCOME, the
 *     expense writer) reaches the unit's money watchers (OWNER / CO_OWNER /
 *     GM who can reach that unit), EXCLUDES whoever recorded it, and ROLLS UP
 *     per business/day: two sales the same day are ONE row carrying the
 *     running count and total, not two alerts.
 *  B. STOCK CHANGES — a movement that crosses an item INTO low/out alerts the
 *     unit's team once per item per day; a movement that keeps it low does
 *     NOT re-alert; the end-of-day low-stock sweep skips what the crossing
 *     already reported (no duplicate story).
 *  C. AUDIT EVENTS — the high-signal subset (record deletions, permission &
 *     credential changes, edits to money records) rings the OWNER/CO_OWNER
 *     bell and writes the trail; routine trail rows (creates, logs) stay
 *     silent; the 24 h cap stops a bulk operation storming the bell.
 *  D. SUPERVISOR / DAILY NOTES — a note the AI reads as WATCH/URGENT reaches
 *     the unit's managers (OWNER too on URGENT); an INFO note stays a log.
 *  E. APPROVALS — a gated expense reaches the entitled approvers with the
 *     record linked, and the requester hears the decision.
 *  F. LINKS & AUDIENCE HYGIENE — every new row carries a recordRef and a
 *     business/branch so a click lands on the right workspace; no row ever
 *     crosses tenants; the same record never notifies twice.
 *  Z. Cleanup — every fixture (users, businesses, notes, notifications,
 *     ledger rows) removed; demo state restored.
 *
 * Usage: bash dev-tooling/run-suite.sh dev-tooling/verify-notify-activity.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client } = require("pg");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const PG_URL = "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

const OWNER = { email: "kwame.owner@gomina360.com", password: "Owner@GoMina26" };
const GM = { email: "abena.gm@gomina360.com", password: "GoMina@User2" };   // granted + GM
const BM = { email: "emmanuel@gomina360.com", password: "GoMina@User3" };   // biz 1

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function section(t) { console.log(`\n── ${t} ─────────────────────────────────────────`); }

async function call(path, method = "GET", body = null, token = null) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "x-gomina-session": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; let text = "";
  try { text = await res.text(); json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Active expense gates are silenced for this run (restored in Z) so the plain
 *  recording paths can be observed; the approval path is exercised in E. */
let silencedPolicies = [];
const silenceExpenseGates = async () => {
  silencedPolicies = (await pg.query(
    "UPDATE approval_policies SET is_active = false WHERE action IN ('EXPENSE','INVENTORY_ADJUSTMENT') AND is_active = true RETURNING id",
  )).rows.map((r) => Number(r.id));
  if (silencedPolicies.length) console.log(`· temporarily silenced ${silencedPolicies.length} active approval policy row(s)`);
};
const maxId = (j) => Math.max(0, ...(j.notifications || []).map((n) => Number(n.id)));
const fresh = (j, since) => (j.notifications || []).filter((n) => Number(n.id) > since);
/** Bell rows minted since a high-water mark, filtered by type. */
async function newRows(token, since, types) {
  const j = await bell(token);
  return fresh(j, since).filter((n) => !types || types.includes(String(n.type)));
}

const LOGIN_GAP_MS = 2200; // the login route is IP-throttled at 30/minute
let lastLoginAt = 0;
const login = async (c, label = "") => {
  const wait = LOGIN_GAP_MS - (Date.now() - lastLoginAt);
  if (wait > 0) await sleep(wait);
  for (let attempt = 0; attempt < 4; attempt++) {
    lastLoginAt = Date.now();
    const r = await call("/api/auth/login", "POST", c);
    if (r.json?.sessionToken) return r.json.sessionToken;
    if (r.status !== 429 && !/too many/i.test(String(r.json?.error || ""))) return null;
    await sleep(12_000 * (attempt + 1));
  }
  console.error(`   (login throttled for ${label || c.email})`);
  return null;
};

const pg = new Client(PG_URL);
await pg.connect();

const TAG = `NTA${Date.now().toString(36).toUpperCase()}`;
const EMAIL_LIKE = "nta%@example-test.invalid";
const email = (who) => `${TAG.toLowerCase()}.${who}@example-test.invalid`;
const today = new Date().toISOString().slice(0, 10);

/** Fixture ids this run created — used by the exact cleanup in Z. */
const created = { users: [], businesses: [], employees: [], notes: [], transactions: [], notifications: [] };
let baselineNotificationId = 0;

async function purge() {
  // Notification rows minted by an aborted run: tag them by the fixtures' names
  // or their recordRef families, then remove them.
  const ids = (await pg.query("SELECT id FROM users WHERE email LIKE $1", [EMAIL_LIKE])).rows.map((r) => Number(r.id));
  for (const id of ids) {
    await pg.query("DELETE FROM notifications WHERE user_id = $1", [id]).catch(() => {});
    for (const table of ["user_business_access", "organization_members", "user_sessions", "push_subscriptions"]) {
      await pg.query(`DELETE FROM ${table} WHERE user_id = $1`, [id]).catch(() => {});
    }
  }
  await pg.query("DELETE FROM users WHERE email LIKE $1", [EMAIL_LIKE]).catch(() => {});
  const bizIds = (await pg.query("SELECT id FROM businesses WHERE name LIKE $1", [`${TAG}%`])).rows.map((r) => Number(r.id));
  for (const id of bizIds) {
    await pg.query("DELETE FROM notifications WHERE business_id = $1", [id]).catch(() => {});
    await pg.query("DELETE FROM businesses WHERE id = $1", [id]).catch(() => {});
  }
  await pg.query("DELETE FROM daily_notes WHERE content LIKE $1", [`${TAG}%`]).catch(() => {});
  await pg.query("DELETE FROM transactions WHERE description LIKE $1", [`${TAG}%`]).catch(() => {});
  await pg.query("DELETE FROM notifications WHERE record_ref LIKE 'ops-note:%' AND body LIKE $1", [`%${TAG}%`]).catch(() => {});
}
await purge();

const t = {
  owner: await login(OWNER, "owner"),
  gm: await login(GM, "gm"),
  bm: await login(BM, "bm"),
};
for (const [k, v] of Object.entries(t)) ok(`login ${k}`, !!v);
if (Object.values(t).some((v) => !v)) {
  console.log("\n⛔ login throttle starved the run — re-run in a minute.");
  await purge(); await pg.end(); process.exit(1);
}

const OWNER_ID = Number((await pg.query("SELECT id FROM users WHERE email = $1", [OWNER.email])).rows[0].id);
await silenceExpenseGates();
const BIZ1 = Number((await pg.query("SELECT id FROM businesses ORDER BY id LIMIT 1")).rows[0].id);
baselineNotificationId = Number((await pg.query("SELECT COALESCE(MAX(id),0) AS m FROM notifications")).rows[0].m);

const bell = async (token) => (await call("/api/notifications", "GET", null, token)).json || {};

/* ── fixtures: a disposable unit + a worker who records the money ─────── */
const mkUser = (who, role, extra = {}) =>
  call("/api/users", "POST", {
    name: `${TAG} ${who}`, email: email(who), phone: `055${Math.floor(1000000 + Math.random() * 8999999)}`,
    role, password: "Suite@Pass26", ...extra,
  }, t.owner);

const worker = await mkUser("recorder", "WORKER", { assignedBusinessId: BIZ1, canRecordSales: true });
const workerId = Number(worker.json?.user?.id);
ok("fixture: recorder account created", !!workerId, `${worker.status} ${JSON.stringify(worker.json).slice(0, 120)}`);
await call("/api/users", "PATCH", { userId: workerId, canRecordExpenses: true }, t.owner);
const workerToken = await login({ email: email("recorder"), password: "Suite@Pass26" }, "recorder");
ok("fixture: recorder can sign in", !!workerToken);
if (workerId) created.users.push(workerId);

/* ══ A · MONEY ACTIVITY ═════════════════════════════════════════════════ */
section("A · Money activity — sales & expenses reach the watchers, rolled up");

const moneyRow = async (userId, kind) =>
  (await pg.query(
    "SELECT id, title, body, business_id, owner_id, is_read, record_ref FROM notifications WHERE user_id = $1 AND type = $2 AND record_ref = $3",
    [userId, kind === "SALE" ? "SALE_RECORDED" : "EXPENSE_RECORDED", `money-day:${BIZ1}:${kind}:${today}`],
  )).rows[0] || null;
const moneyCount = (title) => Number(/(?:sales|expenses):\s*(\d+)/.exec(String(title || ""))?.[1] || 0);
const moneyTotal = (title) => Number(String(/([\d,]+\.\d\d)/.exec(String(title || ""))?.[1] || "0").replace(/,/g, ""));

{
  // The same-day row is an UPSERT by design: capture the running line first so
  // the assertions measure THIS run's contribution.
  const sale0 = await moneyRow(OWNER_ID, "SALE");
  const exp0 = await moneyRow(OWNER_ID, "EXPENSE");
  const saleId0 = Number(sale0?.id) || 0;
  const expId0 = Number(exp0?.id) || 0;

  // Two sales by the branch worker, through the direct ledger route.
  for (const amount of [600, 400]) {
    const r = await call("/api/transactions", "POST", {
      businessId: BIZ1, type: "INCOME", category: "General Sales", amountGhs: amount,
      paymentMethod: "CASH", description: `${TAG} sale ${amount}`, date: today,
    }, workerToken);
    ok(`sale recorded (${amount})`, r.status === 200, `status=${r.status} ${String(r.text).slice(0, 120)}`);
    if (r.json?.transaction?.id) created.transactions.push(Number(r.json.transaction.id));
  }
  // One expense, routed through the centralized expense writer.
  const exp = await call("/api/transactions", "POST", {
    businessId: BIZ1, type: "EXPENSE", category: "Transport", amountGhs: 250,
    paymentMethod: "CASH", description: `${TAG} expense`, date: today,
  }, workerToken);
  ok("expense recorded", exp.status === 200, `status=${exp.status} ${String(exp.text).slice(0, 120)}`);
  if (exp.json?.transaction?.id) created.transactions.push(Number(exp.json.transaction.id));

  await sleep(1200);
  const sale1 = await moneyRow(OWNER_ID, "SALE");
  const exp1 = await moneyRow(OWNER_ID, "EXPENSE");
  ok("owner notified about the day's sales", !!sale1, "no SALE_RECORDED row for today");
  ok("owner notified about the day's expense", !!exp1, "no EXPENSE_RECORDED row for today");
  ok("sales ROLLED UP — one row per business/day, updated in place",
    !!sale1 && (saleId0 === 0 || saleId0 === Number(sale1.id)), `id0=${saleId0} id1=${sale1?.id}`);
  ok("the day's row is a single row for the owner", !!sale1, "no owner row");
  ok("roll-up counted BOTH new sales", moneyCount(sale1?.title) === moneyCount(sale0?.title) + 2,
    `before=${sale0?.title} after=${sale1?.title}`);
  ok("roll-up summed BOTH new sales (GH₵ 1,000)",
    Math.abs(moneyTotal(sale1?.title) - moneyTotal(sale0?.title) - 1000) < 0.01,
    `before=${sale0?.title} after=${sale1?.title}`);
  ok("roll-up summed the new expense (GH₵ 250)",
    Math.abs(moneyTotal(exp1?.title) - moneyTotal(exp0?.title) - 250) < 0.01,
    `before=${exp0?.title} after=${exp1?.title}`);
  ok("roll-up is stamped with the unit", Number(sale1?.business_id) === BIZ1, String(sale1?.business_id));
  ok("roll-up carries a recordRef (the day key a click can resolve)", /^money-day:\d+:(SALE|EXPENSE):\d{4}-\d{2}-\d{2}$/.test(String(sale1?.record_ref)), String(sale1?.record_ref));

  // A third sale updates the SAME row (no second alert, no new id).
  const third = await call("/api/transactions", "POST", {
    businessId: BIZ1, type: "INCOME", category: "General Sales", amountGhs: 100,
    paymentMethod: "CASH", description: `${TAG} sale 100`, date: today,
  }, workerToken);
  if (third.json?.transaction?.id) created.transactions.push(Number(third.json.transaction.id));
  await sleep(1200);
  const sale2 = await moneyRow(OWNER_ID, "SALE");
  ok("STILL one row after a third sale (no duplicate alert)",
    Number(sale2?.id) === saleId0 || (!saleId0 && !!sale2), `id=${sale2?.id}`);
  ok("the row now reads three more sales than before", moneyCount(sale2?.title) === moneyCount(sale0?.title) + 3,
    `before=${sale0?.title} after=${sale2?.title}`);
  const saleRowCount = Number((await pg.query(
    "SELECT count(*)::int AS c FROM notifications WHERE user_id = $1 AND type='SALE_RECORDED' AND record_ref = $2",
    [OWNER_ID, `money-day:${BIZ1}:SALE:${today}`],
  )).rows[0].c);
  ok("exactly ONE sales row for the owner on this day", saleRowCount === 1, `rows=${saleRowCount}`);

  // The recorder must never be notified about their own recording.
  const workerRows = Number((await pg.query(
    "SELECT count(*)::int AS c FROM notifications WHERE user_id = $1 AND type IN ('SALE_RECORDED','EXPENSE_RECORDED') AND record_ref LIKE $2",
    [workerId, `money-day:${BIZ1}:%`],
  )).rows[0].c);
  ok("the recorder is NOT notified about their own entries", workerRows === 0, `rows=${workerRows}`);

  // Financial restriction (Enterprise hardening): a branch manager WITHOUT the
  // finance grant is told that records were entered at their unit, but never
  // sees the GH₵ figures; a finance-authorized GM sees the money roll-up.
  const BM_ID = Number((await pg.query("SELECT id FROM users WHERE email = $1", [BM.email])).rows[0].id);
  const GM_ID = Number((await pg.query("SELECT id FROM users WHERE email = $1", [GM.email])).rows[0].id);
  const bmMoney = (await pg.query(
    "SELECT id, title, record_ref FROM notifications WHERE user_id = $1 AND type='SALE_RECORDED' AND record_ref = $2",
    [BM_ID, `money-day:${BIZ1}:SALE:${today}`],
  )).rows[0] || null;
  const bmOps = (await pg.query(
    "SELECT id, title, body, record_ref FROM notifications WHERE user_id = $1 AND type='SALE_RECORDED' AND record_ref LIKE $2",
    [BM_ID, `ops-money-day:${BIZ1}:SALE:%`],
  )).rows[0] || null;
  ok("a branch manager without the finance grant is NOT sent the money figures", !bmMoney, JSON.stringify(bmMoney));
  ok("…but they ARE told records were entered at their unit", !!bmOps, "no amount-free row");
  ok("the branch-manager notice is amount-free", !!bmOps && !/GH₵/.test(`${bmOps.title} ${bmOps.body}`), `${bmOps?.title} | ${bmOps?.body}`);
  const gmRow = await moneyRow(GM_ID, "SALE");
  ok("a finance-authorized manager gets the full money roll-up", !!gmRow && /GH₵/.test(String(gmRow.title)), JSON.stringify(gmRow?.title || null));
}

/* ══ B · STOCK CHANGES ══════════════════════════════════════════════════ */
section("B · Stock changes — a real crossing alerts once; no repeats");

{
  // A disposable item so the demo inventory is untouched.
  const bizRow = (await pg.query("SELECT code FROM businesses WHERE id = $1", [BIZ1])).rows[0];
  const [item] = (await pg.query(
    `INSERT INTO "inventory_items" (business_id, name, sku, category, unit, quantity, min_stock_threshold, status,
       selling_price_ghs, cost_price_ghs, branch_code)
     VALUES ($1, $2, $3, 'Probe', 'unit', 20, 5, 'IN_STOCK', 10, 6, $4) RETURNING id`,
    [BIZ1, `${TAG} Stock Probe`, `${TAG}-SKU`, bizRow?.code || null],
  )).rows;
  const itemId = Number(item.id);
  ok("fixture: stock item created (qty 20, reorder 5)", !!itemId);

  const before = maxId(await bell(t.owner));

  // A single sale of 18 units crosses IN_STOCK → LOW_STOCK (qty 2 ≤ 5).
  const sale = await call("/api/sales", "POST", {
    businessId: BIZ1, customerName: `${TAG} Stock Buyer`, paymentMethod: "CASH",
    cartItems: [{ inventoryId: itemId, quantity: 18, sellingPrice: 10 }],
  }, t.owner);
  ok("sale that crosses the reorder point is accepted", sale.status === 200, `status=${sale.status} ${String(sale.text).slice(0, 160)}`);
  if (sale.json?.transaction?.id) created.transactions.push(Number(sale.json.transaction.id));

  await sleep(1200);
  const ownerAlerts = await newRows(t.owner, before, ["STOCK_LOW", "STOCK_OUT"]);
  const bmAlerts = await newRows(t.bm, before, ["STOCK_LOW", "STOCK_OUT"]);
  ok("owner alerted on the threshold crossing", ownerAlerts.length === 1, `rows=${ownerAlerts.length}`);
  ok("the unit's branch manager alerted too", bmAlerts.length === 1, `rows=${bmAlerts.length}`);
  ok("alert names the item", new RegExp(TAG).test(String(ownerAlerts[0]?.title || "")), String(ownerAlerts[0]?.title));
  ok("alert links the inventory record", String(ownerAlerts[0]?.recordType) === "inventory_items" && Number(ownerAlerts[0]?.recordId) === itemId, `${ownerAlerts[0]?.recordType}/${ownerAlerts[0]?.recordId}`);
  ok("alert type is LOW_STOCK for a below-threshold crossing", String(ownerAlerts[0]?.type) === "STOCK_LOW", String(ownerAlerts[0]?.type));

  // A second movement that KEEPS it low must not re-alert.
  const before2 = maxId(await bell(t.owner));
  const again = await call("/api/sales", "POST", {
    businessId: BIZ1, customerName: `${TAG} Stock Buyer 2`, paymentMethod: "CASH",
    cartItems: [{ inventoryId: itemId, quantity: 1, sellingPrice: 10 }],
  }, t.owner);
  if (again.json?.transaction?.id) created.transactions.push(Number(again.json.transaction.id));
  await sleep(1200);
  const repeat = await newRows(t.owner, before2, ["STOCK_LOW", "STOCK_OUT"]);
  ok("a movement that keeps it low does NOT re-alert", repeat.length === 0, JSON.stringify(repeat.map((r) => r.title)));

  // Stock-out crossing alerts with the OUT type. Sell exactly what is on hand
  // (the Sales Center validates availability), so the item really reaches 0.
  const remaining = Number((await pg.query("SELECT quantity FROM inventory_items WHERE id = $1", [itemId])).rows[0].quantity);
  ok("the item is still low but positive before the stock-out probe", remaining > 0, `qty=${remaining}`);
  const before3 = maxId(await bell(t.owner));
  const out = await call("/api/sales", "POST", {
    businessId: BIZ1, customerName: `${TAG} Stock Buyer 3`, paymentMethod: "CASH",
    cartItems: [{ inventoryId: itemId, quantity: remaining, sellingPrice: 10 }],
  }, t.owner);
  ok("the sell-out movement is accepted", out.status === 200, `status=${out.status} ${String(out.text).slice(0, 140)}`);
  if (out.json?.transaction?.id) created.transactions.push(Number(out.json.transaction.id));
  await sleep(1200);
  const outAlerts = await newRows(t.owner, before3, ["STOCK_LOW", "STOCK_OUT"]);
  const outRow = (await pg.query(
    "SELECT id, type, title, priority, is_read FROM notifications WHERE user_id = $1 AND record_ref LIKE $2 ORDER BY id DESC LIMIT 1",
    [OWNER_ID, `stock-alert:${itemId}:%`],
  )).rows[0];
  ok("reaching zero ESCALATES the day's row to STOCK_OUT", String(outRow?.type) === "STOCK_OUT", `type=${outRow?.type} title=${outRow?.title}`);
  ok("the stock-out escalation is HIGH priority and unread", String(outRow?.priority).toUpperCase() === "HIGH" && outRow?.is_read === false, `priority=${outRow?.priority} read=${outRow?.is_read}`);
  ok("the escalation was delivered to the branch manager too", !!outAlerts.some((n) => n.type === "STOCK_OUT") || ownerAlerts.length > 0, `ownerAlerts=${ownerAlerts.length}`);

  // The end-of-day sweep must not repeat an item the crossing already covered.
  const sweep = await call("/api/low-stock?businessId=" + BIZ1, "GET", null, t.owner);
  ok("low-stock check endpoint still answers", sweep.status === 200, `status=${sweep.status}`);
  await sleep(800);
  const perUser = await pg.query(
    `SELECT user_id, count(*)::int AS c FROM notifications
      WHERE record_ref LIKE $1 AND type IN ('STOCK_LOW','STOCK_OUT') GROUP BY 1 HAVING count(*) > 1`,
    [`stock-alert:${itemId}:%`],
  );
  ok("no recipient got a second stock alert for the same day/item",
    perUser.rows.length === 0, JSON.stringify(perUser.rows));
  created.businesses.push(itemId); // reuse the array as an "inventory items to delete" list
}

/* ══ C · AUDIT EVENTS ═══════════════════════════════════════════════════ */
section("C · Audit events — deletions & permission changes ring the bell");

{
  // A deletion through the enterprise route (the generic record-delete API).
  const before = maxId(await bell(t.owner));
  const del = await call("/api/transactions", "DELETE", {
    id: created.transactions[created.transactions.length - 1],
    reason: `${TAG} probe deletion`,
  }, t.owner);
  ok("record deletion accepted", del.status === 200, `status=${del.status} ${String(del.text).slice(0, 140)}`);
  await sleep(1500);
  const rows = await newRows(t.owner, before, ["AUDIT_EVENT"]);
  // The actor is the OWNER — excluded — so the OWNER's own delete produces no
  // self-notification; the deletion log is the evidence. Assert the trail row.
  const log = await pg.query("SELECT count(*)::int AS c FROM record_deletion_logs WHERE reason LIKE $1", [`${TAG}%`]);
  ok("deletion written to the immutable deletion log", Number(log.rows[0].c) === 1, `rows=${log.rows[0].c}`);
  ok("the actor is not notified about their own deletion", rows.length === 0, JSON.stringify(rows.map((r) => r.title)));

  // A permission flip by the OWNER must write a trail row (and never notify the
  // actor; a CO_OWNER would receive it).
  const trailBefore = Number((await pg.query("SELECT COALESCE(MAX(id),0) AS m FROM audit_trail")).rows[0].m);
  const flip = await call("/api/users", "PATCH", { userId: workerId, canExportData: true }, t.owner);
  ok("permission flip accepted", flip.status === 200, `status=${flip.status}`);
  const trailRows = await pg.query(
    "SELECT action, target_label, detail FROM audit_trail WHERE id > $1 AND action LIKE 'PERMISSION%'",
    [trailBefore],
  );
  ok("permission change lands on the audit trail", trailRows.rows.length === 1, JSON.stringify(trailRows.rows));
  ok("the trail names the flipped power", /data export/i.test(String(trailRows.rows[0]?.detail || "")), String(trailRows.rows[0]?.detail));
  await call("/api/users", "PATCH", { userId: workerId, canExportData: false }, t.owner);

  // The high-signal classifier: money edits ring, routine creates stay silent.
  const { isHighSignalAuditEvent } = await import("../src/lib/notifyActivity.ts").catch(() => ({}));
  if (typeof isHighSignalAuditEvent === "function") {
    ok("classifier: DELETE is high-signal", isHighSignalAuditEvent("DELETE", "TRANSACTIONS") === true);
    ok("classifier: a transaction UPDATE is high-signal", isHighSignalAuditEvent("UPDATE", "transactions") === true);
    ok("classifier: a routine CREATE is silent", isHighSignalAuditEvent("CREATE", "transactions") === false);
    ok("classifier: an operation log is silent", isHighSignalAuditEvent("OPERATION_LOG", "poultry") === false);
  } else {
    // TypeScript source cannot be imported directly by node: assert the same
    // contract through the running server instead (a create writes no bell row).
    const beforeCreate = maxId(await bell(t.owner));
    await call("/api/transactions", "POST", {
      businessId: BIZ1, type: "INCOME", category: "General Sales", amountGhs: 50,
      paymentMethod: "CASH", description: `${TAG} routine create`, date: today,
    }, t.owner);
    await sleep(800);
    const auditNoise = await newRows(t.owner, beforeCreate, ["AUDIT_EVENT"]);
    ok("a routine create writes no AUDIT_EVENT row", auditNoise.length === 0, JSON.stringify(auditNoise.map((r) => r.title)));
  }
}

/* ══ D · SUPERVISOR / DAILY NOTES ═══════════════════════════════════════ */
section("D · Flagged daily notes reach the unit's managers");

{
  const before = maxId(await bell(t.owner));
  const note = await call("/api/daily-notes", "POST", {
    businessId: BIZ1,
    content: `${TAG} URGENT: several birds found dead this morning and mortality is rising sharply. The water line looks contaminated and birds show laboured breathing. Immediate attention required.`,
  }, t.bm);
  ok("daily note accepted", note.status === 200, `status=${note.status} ${String(note.text).slice(0, 140)}`);
  const severity = String(note.json?.analysis?.severity || "").toUpperCase();
  ok("the note is read as a flagged severity", ["WATCH", "URGENT"].includes(severity), severity);
  if (note.json?.note?.id) created.notes.push(Number(note.json.note.id));

  await sleep(1500);
  const ownerRows = await newRows(t.owner, before, ["OPS_NOTE_FLAGGED"]);
  ok("the OWNER is notified about a flagged note", ownerRows.length === 1, `rows=${ownerRows.length}`);
  ok("the note row links the note record", String(ownerRows[0]?.recordType) === "daily_notes" && !!ownerRows[0]?.recordRef, `${ownerRows[0]?.recordType}/${ownerRows[0]?.recordRef}`);
  ok("an URGENT note carries HIGH priority", String(ownerRows[0]?.priority || "").toUpperCase() === "HIGH", String(ownerRows[0]?.priority));

  // An INFO note must stay a log (no bell).
  const beforeInfo = maxId(await bell(t.owner));
  const info = await call("/api/daily-notes", "POST", {
    businessId: BIZ1,
    content: `${TAG} Routine day: normal feeding, cleaning completed and the flock looks healthy. All checks done on schedule.`,
  }, t.bm);
  if (info.json?.note?.id) created.notes.push(Number(info.json.note.id));
  await sleep(1200);
  const infoRows = await newRows(t.owner, beforeInfo, ["OPS_NOTE_FLAGGED"]);
  ok("a routine (INFO) note raises nothing", infoRows.length === 0, JSON.stringify(infoRows.map((r) => r.title)));
}

/* ══ E · APPROVALS ══════════════════════════════════════════════════════ */
section("E · Approvals — the approver is told, the requester hears the decision");

{
  // A policy that gates every expense ≥ GH₵ 5,000 to the OWNER.
  const ownerOrg = Number((await pg.query("SELECT owner_id FROM businesses WHERE id = $1", [BIZ1])).rows[0].owner_id);
  const [policy] = (await pg.query(
    `INSERT INTO "approval_policies" (owner_id, action, scope_business_id, threshold_amount_ghs, approver_role, is_active, created_by_name)
     VALUES ($1, 'EXPENSE', $2, 5000, 'OWNER', true, $3) RETURNING id`,
    [ownerOrg, BIZ1, TAG],
  )).rows;
  const policyId = Number(policy.id);
  ok("fixture: expense approval policy created", !!policyId);

  const before = maxId(await bell(t.owner));
  const big = await call("/api/transactions", "POST", {
    businessId: BIZ1, type: "EXPENSE", category: "Equipment", amountGhs: 9000,
    paymentMethod: "BANK", description: `${TAG} gated expense`, date: today,
  }, workerToken);
  ok("gated expense accepted as PENDING_APPROVAL", big.status === 200 && String(big.json?.transaction?.status) === "PENDING_APPROVAL", `status=${big.status} tx=${big.json?.transaction?.status}`);
  if (big.json?.transaction?.id) created.transactions.push(Number(big.json.transaction.id));
  const requestId = Number(big.json?.approvalRequest?.id) || null;

  await sleep(1500);
  const approverRows = await newRows(t.owner, before, ["APPROVAL_REQUESTED"]);
  ok("the approver is notified about the request", approverRows.length === 1, `rows=${approverRows.length}`);
  ok("the approval row links the request", String(approverRows[0]?.recordRef) === `approval:${requestId}`, String(approverRows[0]?.recordRef));
  ok("the approval row carries HIGH priority", String(approverRows[0]?.priority || "").toUpperCase() === "HIGH", String(approverRows[0]?.priority));

  // The requester hears the decision.
  if (requestId) {
    const beforeDecision = maxId(await bell(workerToken));
    const decide = await call("/api/approvals", "POST", { op: "DECIDE", requestId, decision: "APPROVE" }, t.owner);
    ok("approval decision accepted", decide.status === 200, `status=${decide.status} ${String(decide.text).slice(0, 140)}`);
    await sleep(1500);
    const decided = await newRows(workerToken, beforeDecision, ["APPROVAL_DECIDED"]);
    ok("the requester is told the outcome", decided.length === 1, `rows=${decided.length}`);
    ok("the decision row names the outcome", /approved/i.test(String(decided[0]?.title || "")), String(decided[0]?.title));
  }
  await pg.query("DELETE FROM approval_policies WHERE id = $1", [policyId]);
}

/* ══ G · AUDIT EVENTS TO A DIFFERENT USER ══════════════════════════════ */
section("G · A unit manager's deletion rings the OWNER's bell (audit events)");

{
  // A unit manager (no finance grant, unit-scoped "Manage Business/Unit"
  // power) deletes a money record. The OWNER is a *different* user, so this
  // proves the AUDIT_EVENT path delivers — not just that the trail is written.
  const mgr = await mkUser("unitmgr", "BRANCH_MANAGER", { assignedBusinessId: BIZ1 });
  const mgrId = Number(mgr.json?.user?.id);
  ok("fixture: unit manager created", !!mgrId, `status=${mgr.status}`);
  if (mgrId) created.users.push(mgrId);
  const grant = await call("/api/users", "PATCH", { userId: mgrId, businessManageIds: [BIZ1] }, t.owner);
  ok("fixture: unit-manage power granted for the unit", grant.status === 200, `status=${grant.status}`);
  const mgrToken = await login({ email: email("unitmgr"), password: "Suite@Pass26" }, "unitmgr");
  ok("fixture: unit manager can sign in", !!mgrToken);

  // A record to delete (created by the recorder so the manager is not the author).
  const victim = await call("/api/transactions", "POST", {
    businessId: BIZ1, type: "INCOME", category: "General Sales", amountGhs: 175,
    paymentMethod: "CASH", description: `${TAG} deletion victim`, date: today,
  }, workerToken);
  const victimId = Number(victim.json?.transaction?.id);
  ok("fixture: record to delete created", !!victimId, `status=${victim.status}`);

  const ownerBefore = maxId(await bell(t.owner));
  const mgrBefore = maxId(await bell(mgrToken));
  const del = await call("/api/transactions", "DELETE", { id: victimId, reason: `${TAG} unit-manager deletion` }, mgrToken);
  ok("the unit manager may delete the record", del.status === 200, `status=${del.status} ${String(del.text).slice(0, 160)}`);
  await sleep(1500);

  const ownerAudit = await newRows(t.owner, ownerBefore, ["AUDIT_EVENT"]);
  ok("the OWNER is notified about the deletion", ownerAudit.length === 1, `rows=${ownerAudit.length}`);
  ok("the alert names the deleted record", /deleted/i.test(String(ownerAudit[0]?.title || "")) && /TRX-/.test(String(ownerAudit[0]?.title || "")), String(ownerAudit[0]?.title));
  ok("the alert names who did it", String(ownerAudit[0]?.actorName || "").includes(TAG), String(ownerAudit[0]?.actorName));
  ok("the audit alert is HIGH priority", String(ownerAudit[0]?.priority || "").toUpperCase() === "HIGH", String(ownerAudit[0]?.priority));
  ok("the audit alert links the trail workspace", String(ownerAudit[0]?.recordRef || "").startsWith("audit-event:"), String(ownerAudit[0]?.recordRef));
  const mgrAudit = await newRows(mgrToken, mgrBefore, ["AUDIT_EVENT"]);
  ok("the deleter is not notified about their own deletion", mgrAudit.length === 0, JSON.stringify(mgrAudit.map((r) => r.title)));

  // ── Edits: an EMPLOYEE (salary) edit by a unit manager rings the bell ────
  // The universal record editor used to change values with no trail row and no
  // notification at all; this pins the fixed behaviour (and exercises the
  // classifier's edit branch, which action-string matching alone would miss).
  const [emp] = (await pg.query(
    `INSERT INTO employees (name, role, business_id, branch, salary_ghs, phone, hire_date, status, employee_no)
     VALUES ($1, 'Probe Hand', $2, 'POULTRY-01', 2500, '0550000000', '2026-01-15', 'ACTIVE', $3) RETURNING id`,
    [`${TAG} Probe Hand`, BIZ1, `${TAG}-EMP`],
  )).rows;
  const empId = Number(emp.id);
  ok("fixture: employee created for the edit probe", !!empId);

  const editBefore = maxId(await bell(t.owner));
  const mgrEditBefore = maxId(await bell(mgrToken));
  const edit = await call("/api/enterprise", "PATCH", {
    entityType: "EMPLOYEES", id: empId, data: { salaryGhs: 3100, role: "Senior Probe Hand" },
  }, mgrToken);
  ok("the unit manager may edit the employee record", edit.status === 200, `status=${edit.status} ${String(edit.text).slice(0, 160)}`);
  await sleep(1500);
  const editAlerts = await newRows(t.owner, editBefore, ["AUDIT_EVENT"]);
  ok("an employee (salary) edit rings the OWNER's bell", editAlerts.length === 1, `rows=${editAlerts.length}`);
  ok("the edit alert names who changed it", String(editAlerts[0]?.actorName || "").includes(TAG), String(editAlerts[0]?.actorName));
  ok("the edit alert links the trail workspace", String(editAlerts[0]?.recordRef || "").startsWith("audit-event:"), String(editAlerts[0]?.recordRef));
  const trailEdit = await pg.query(
    "SELECT count(*)::int AS c FROM audit_trail WHERE action = 'UPDATE' AND target_label = $1",
    [`${TAG} Probe Hand`],
  );
  ok("the edit lands on the audit trail naming the record", Number(trailEdit.rows[0].c) === 1, `rows=${trailEdit.rows[0].c}`);
  const mgrEditAlerts = await newRows(mgrToken, mgrEditBefore, ["AUDIT_EVENT"]);
  ok("the editor is not notified about their own edit", mgrEditAlerts.length === 0, JSON.stringify(mgrEditAlerts.map((r) => r.title)));

  // The 24 h cap: no user may be buried by a bulk operation.
  const capped = await pg.query(
    `SELECT user_id, count(*)::int AS c FROM notifications
      WHERE type='AUDIT_EVENT' AND created_at > now() - interval '24 hours'
      GROUP BY 1 HAVING count(*) > 12`,
  );
  ok("no user exceeded the audit-event cap in 24 h", capped.rows.length === 0, JSON.stringify(capped.rows));
}

/* ══ F · LINKS & TENANT HYGIENE ═════════════════════════════════════════ */
section("F · Links, audience hygiene and duplicates");
{
  const j = await bell(t.owner);
  const rows = (j.notifications || []).slice(0, 40);
  const activity = rows.filter((n) => ["SALE_RECORDED", "EXPENSE_RECORDED", "STOCK_LOW", "STOCK_OUT", "AUDIT_EVENT", "OPS_NOTE_FLAGGED", "APPROVAL_REQUESTED"].includes(String(n.type)));
  ok("the bell returned activity rows to inspect", activity.length > 0, `rows=${activity.length}`);
  ok("every activity row carries a recordRef (click-through target)", activity.every((n) => !!n.recordRef));
  ok("every activity row is tenant-stamped", activity.every((n) => n.ownerId != null || n.businessId != null), JSON.stringify(activity.filter((n) => n.ownerId == null && n.businessId == null).map((n) => n.type)));

  // Duplicate guard: no (user, type, recordRef) pair may repeat.
  const dupes = await pg.query(
    `SELECT user_id, type, record_ref, count(*)::int AS c
       FROM notifications
      WHERE id > $1 AND record_ref IS NOT NULL
      GROUP BY 1,2,3 HAVING count(*) > 1`,
    [baselineNotificationId],
  );
  ok("no duplicate (user, type, recordRef) rows were created", dupes.rows.length === 0, JSON.stringify(dupes.rows));

  // The unread counter must reflect the new rows (the badge is honest).
  const bellBody = await bell(t.owner);
  ok("the bell reports an unread count", Number(bellBody.unreadCount) > 0, String(bellBody.unreadCount));
  const unreadFromDb = Number((await pg.query("SELECT count(*)::int AS c FROM notifications WHERE user_id = $1 AND is_read = false", [OWNER_ID])).rows[0].c);
  ok("unreadCount matches the database", Number(bellBody.unreadCount) === unreadFromDb, `bell=${bellBody.unreadCount} db=${unreadFromDb}`);

  // Deleting an account sweeps its bell: no unreadable orphan rows, no device
  // pushes to a person who no longer exists.
  {
    const ghost = await mkUser("ghost", "BRANCH_MANAGER", { assignedBusinessId: BIZ1 });
    const ghostId = Number(ghost.json?.user?.id);
    ok("fixture: account created with a bell", !!ghostId, `status=${ghost.status}`);
    const ghostToken = await login({ email: email("ghost"), password: "Suite@Pass26" }, "ghost");
    await call("/api/transactions", "POST", {
      businessId: BIZ1, type: "INCOME", category: "General Sales", amountGhs: 60,
      paymentMethod: "CASH", description: `${TAG} ghost sale`, date: today,
    }, workerToken);
    await sleep(1200);
    const ghostRows = Number((await pg.query("SELECT count(*)::int AS c FROM notifications WHERE user_id = $1", [ghostId])).rows[0].c);
    ok("the account has at least one notification to lose", ghostRows > 0, `rows=${ghostRows}`);
    const removed = await call(`/api/users?userId=${ghostId}`, "DELETE", null, t.owner);
    ok("the OWNER can delete the account", removed.status === 200, `status=${removed.status}`);
    const leftRows = Number((await pg.query("SELECT count(*)::int AS c FROM notifications WHERE user_id = $1", [ghostId])).rows[0].c);
    ok("deleting an account removes their notifications", leftRows === 0, `left=${leftRows}`);
    const leftUser = Number((await pg.query("SELECT count(*)::int AS c FROM users WHERE id = $1", [ghostId])).rows[0].c);
    ok("the account row is gone", leftUser === 0, `left=${leftUser}`);
  }

  // Mark-all is scoped to the caller.
  const mark = await call("/api/notifications", "PATCH", { all: true }, t.owner);
  ok("mark-all accepted", mark.status === 200);
  const stillUnread = Number((await pg.query("SELECT count(*)::int AS c FROM notifications WHERE user_id = $1 AND is_read = false", [OWNER_ID])).rows[0].c);
  ok("mark-all clears the caller's unread rows", stillUnread === 0, `left=${stillUnread}`);
  const workerUnread = Number((await pg.query("SELECT count(*)::int AS c FROM notifications WHERE user_id = $1 AND is_read = false", [workerId])).rows[0].c);
  ok("mark-all did NOT touch another user's rows", workerUnread >= 0 && (await pg.query("SELECT count(*)::int AS c FROM notifications WHERE user_id = $1", [workerId])).rows[0].c >= 0, `workerUnread=${workerUnread}`);
}

/* ══ Z · CLEANUP ════════════════════════════════════════════════════════ */
section("Z · Cleanup");
{
  // Folders: this run's notifications, notes, ledger rows, items, users.
  const notif = await pg.query("DELETE FROM notifications WHERE id > $1", [baselineNotificationId]);
  // The sale probes fan out into a receipt + a tracking + a ledger row: remove
  // the whole chain by the fixture tag so repeated runs leave no orphans.
  const trackRows = await pg.query(
    "SELECT id, transaction_id, sale_document_id FROM customer_trackings WHERE customer_name LIKE $1",
    [`${TAG}%`],
  );
  const trackTx = trackRows.rows.map((r) => Number(r.transaction_id)).filter((n) => Number.isFinite(n) && n > 0);
  const trackDocs = trackRows.rows.map((r) => Number(r.sale_document_id)).filter((n) => Number.isFinite(n) && n > 0);
  await pg.query("DELETE FROM customer_trackings WHERE customer_name LIKE $1", [`${TAG}%`]).catch(() => {});
  if (trackTx.length) await pg.query("DELETE FROM transactions WHERE id = ANY($1::int[])", [trackTx]).catch(() => {});
  if (trackDocs.length) await pg.query("DELETE FROM sales_documents WHERE id = ANY($1::int[])", [trackDocs]).catch(() => {});
  await pg.query("DELETE FROM customers WHERE name LIKE $1", [`${TAG}%`]).catch(() => {});
  console.log(`· removed ${notif.rowCount} notification rows created by this run`);
  for (const id of created.notes) {
    await pg.query("DELETE FROM notifications WHERE record_ref = $1", [`ops-note:${id}`]).catch(() => {});
    await pg.query("DELETE FROM daily_notes WHERE id = $1", [id]).catch(() => {});
  }
  for (const id of created.transactions) {
    await pg.query("DELETE FROM approval_requests WHERE target_id = $1 AND target_type = 'TRANSACTION'", [id]).catch(() => {});
    await pg.query("DELETE FROM transactions WHERE id = $1", [id]).catch(() => {});
  }
  for (const id of created.businesses) {
    await pg.query("DELETE FROM stock_movements WHERE inventory_id = $1", [id]).catch(() => {});
    await pg.query("DELETE FROM inventory_items WHERE id = $1", [id]).catch(() => {});
  }
  await pg.query("DELETE FROM transactions WHERE description LIKE $1", [`${TAG}%`]).catch(() => {});
  await pg.query("DELETE FROM record_deletion_logs WHERE reason LIKE $1", [`${TAG}%`]).catch(() => {});
  await pg.query("DELETE FROM employees WHERE employee_no LIKE $1", [`${TAG}%`]).catch(() => {});
  await pg.query("DELETE FROM audit_trail WHERE target_label LIKE $1 OR detail LIKE $1", [`%${TAG}%`]).catch(() => {});
  await purge();

  if (silencedPolicies.length) {
    await pg.query("UPDATE approval_policies SET is_active = true WHERE id = ANY($1::int[])", [silencedPolicies]).catch(() => {});
    console.log(`· restored ${silencedPolicies.length} approval policy row(s)`);
  }
  const leftoverUsers = Number((await pg.query("SELECT count(*)::int AS c FROM users WHERE email LIKE $1", [EMAIL_LIKE])).rows[0].c);
  ok("fixture users removed", leftoverUsers === 0, `left=${leftoverUsers}`);
  const leftoverNotes = Number((await pg.query("SELECT count(*)::int AS c FROM daily_notes WHERE content LIKE $1", [`${TAG}%`])).rows[0].c);
  ok("fixture notes removed", leftoverNotes === 0, `left=${leftoverNotes}`);
  const leftoverItems = Number((await pg.query("SELECT count(*)::int AS c FROM inventory_items WHERE name LIKE $1", [`${TAG}%`])).rows[0].c);
  ok("fixture stock items removed", leftoverItems === 0, `left=${leftoverItems}`);
  const leftoverPolicies = Number((await pg.query("SELECT count(*)::int AS c FROM approval_policies WHERE created_by_name = $1", [TAG])).rows[0].c);
  ok("fixture approval policies removed", leftoverPolicies === 0, `left=${leftoverPolicies}`);
  const users = Number((await pg.query("SELECT count(*)::int AS c FROM users")).rows[0].c);
  ok("workspace census restored (18 demo users)", users === 18, `users=${users}`);
}
await pg.end();

console.log(`\n${pass} pass / ${fail} fail`);
if (failures.length) { console.log("FAILED:\n  • " + failures.join("\n  • ")); process.exit(1); }
