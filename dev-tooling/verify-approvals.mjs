/**
 * R1 Approvals framework — verification suite
 * ===========================================
 * Proves the policy-driven gate lifecycle end to end through the REAL API:
 *
 *   1. DEFAULT-OFF: with no approval_policies, expenses post exactly as
 *      before (COMPLETED, no requests, no notifications).
 *   2. POLICY CRUD: OWNER creates/gates; validation errors; GM sees but
 *      cannot delete; workers see no policies.
 *   3. EXPENSE gate: threshold respected (below passes), BM expense over
 *      threshold lands PENDING_APPROVAL + request + bell notification;
 *      OWNER's own expense is never gated (caller-is-approver).
 *   4. DECIDE permissions: worker and non-approver BM cannot decide (403).
 *   5. APPROVE / REJECT / WITHDRAW flows flip the underlying record and
 *      notify the requester; audit-trail rows are written.
 *   6. Linked zone: pending approvals appear in /api/tasks includeLinked.
 *   7. PURCHASE_ORDER gate: gated PO frozen in PENDING_APPROVAL (ADVANCE
 *      refused), released to RAISED on approval.
 *   8. INVENTORY_ADJUSTMENT gate: quantity withheld until approval; a newer
 *      pending adjustment supersedes the older one.
 *   9. DISCOUNT gate: over-threshold discount born PENDING_APPROVAL,
 *      released to SENT on approval, CANCELLED on rejection.
 *  10. DELETION gate: customer delete held; record stays alive until
 *      approval performs the same audited delete.
 *  11. GM-approver policy: a GENERAL_MANAGER-role policy lets the GM decide.
 *
 * Cleanup: removes every policy/request/notification/record it created and
 * restores the mutated user + inventory row. Run with the app on :3000:
 *   node dev-tooling/verify-approvals.mjs
 */

const BASE = "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const GM = { email: "abena.gm@gomina360.com", pw: "GoMina@User2" };
const BM = { email: "emmanuel@gomina360.com", pw: "GoMina@User3" };
const WORKER = { email: "akua.donkor@gomina360.com", pw: "GoMina@User10" };
const DB = "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const client = new pg.Client(DB);
await client.connect();
const q = (s, p = []) => client.query(s, p);
const q1 = async (s, p = []) => (await client.query(s, p)).rows[0];
const qa = async (s, p = []) => (await client.query(s, p)).rows;

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

const ownerTok = await apiLogin(OWNER);
const gmTok = await apiLogin(GM);
const bmTok = await apiLogin(BM);
const workerTok = await apiLogin(WORKER);
const bmUser = await q1(`select id, name, role, assigned_business_id from users where email = $1`, [BM.email]);
const ownerUser = await q1(`select id from users where email = $1`, [OWNER.email]);
const bizId = Number(bmUser.assigned_business_id);
const [bizRow] = (await q(`select id, code, name, owner_id from businesses where id = $1`, [bizId])).rows;
ok("setup: BM's business resolved", !!bizRow, `business id ${bizId}`);
console.log(`→ testing against business #${bizId} (${bizRow?.name}) of org #${bizRow?.owner_id}`);

// ── baseline: no policies, no requests (clean slate for idempotent runs;
//    also sweep artifacts a previously crashed run may have left behind) ──
await q(`delete from approval_requests`);
await q(`delete from approval_policies`);
await q(`delete from notifications where record_ref like 'approval:%'`);
await q(`delete from supplier_orders where notes = 'approvals suite PO'`);
await q(`delete from sales_documents where customer_name = 'Approvals Suite Customer'`);
await q(`delete from transactions where description like 'approvals suite expense%' or description like '%Approvals suite%' or category in ('Default-off expense','Below threshold expense','Gated expense','Owner own expense','Reject-me expense','Withdraw-me expense','GM-approver expense','Below GM threshold expense','Paused-policy expense')`);
await q(`delete from record_deletion_logs where module = 'CUSTOMERS' and record_id in (select id from customers where name = 'Approvals Suite Delete-Me')`);
await q(`delete from customers where name = 'Approvals Suite Delete-Me'`);
const bmManageSaved = bmUser ? (await q1(`select business_manage_ids from users where id = $1`, [bmUser.id])).business_manage_ids : null;
// Give the BM unit-manager power for this run (realistic gated user) — restored in cleanup.
await q(`update users set business_manage_ids = $1::jsonb where id = $2`, [JSON.stringify([bizId]), bmUser.id]);

const created = { trxIds: [], poIds: [], docIds: [], customerId: null, invId: null, invOriginal: null };

async function postExpense(tok, amountGhs, category = "Verify Test Expense") {
  const res = await api("POST", "/api/transactions", tok, {
    businessId: bizId,
    type: "EXPENSE",
    category,
    amountGhs,
    paymentMethod: "CASH",
    description: `approvals suite expense ${amountGhs}`,
  });
  if (res.json?.transaction?.id) created.trxIds.push(Number(res.json.transaction.id));
  return res;
}

async function pendingRequestFor(targetType, targetId) {
  return q1(
    `select * from approval_requests where target_type = $1 and target_id = $2 and status = 'PENDING' order by id desc`,
    [targetType, targetId],
  );
}

// ════════════════════════════════════════════════════════════════════
console.log("\n── 1. Default-off behaviour");
// ════════════════════════════════════════════════════════════════════
{
  const res = await postExpense(bmTok, 250, "Default-off expense");
  ok("A1 no-policy expense posts directly", res.status === 200 && res.json?.success === true);
  ok("A2 no-policy expense is COMPLETED", res.json?.transaction?.status === "COMPLETED", JSON.stringify(res.json?.transaction?.status));
  ok("A3 no pendingApproval flag", res.json?.pendingApproval !== true);
  const n = (await q1(`select count(*)::int as n from approval_requests`)).n;
  ok("A4 zero approval requests created", n === 0, `n=${n}`);
}

// ════════════════════════════════════════════════════════════════════
console.log("\n── 2. Policy CRUD + validation");
// ════════════════════════════════════════════════════════════════════
{
  const bad = await api("POST", "/api/approvals", ownerTok, { op: "POLICY_CREATE", action: "NOT_A_THING" });
  ok("A5 invalid action rejected (400)", bad.status === 400 && /action must be one of/i.test(bad.json?.error || ""));
  const badDiscount = await api("POST", "/api/approvals", ownerTok, { op: "POLICY_CREATE", action: "DISCOUNT", thresholdAmountGhs: 50 });
  ok("A6 DISCOUNT policy rejects amount threshold", badDiscount.status === 400 && /thresholdPercent/i.test(badDiscount.json?.error || ""));
  const workerCreate = await api("POST", "/api/approvals", workerTok, { op: "POLICY_CREATE", action: "EXPENSE", thresholdAmountGhs: 10 });
  ok("A7 worker cannot create policies (403)", workerCreate.status === 403);
  const created1 = await api("POST", "/api/approvals", ownerTok, { op: "POLICY_CREATE", action: "EXPENSE", thresholdAmountGhs: 100, approverRole: "OWNER" });
  ok("A8 OWNER creates EXPENSE ≥ GH₵100 policy", created1.status === 200 && created1.json?.policy?.id > 0, JSON.stringify(created1.json));
  const gmView = await api("GET", "/api/approvals", gmTok);
  ok("A9 GM sees the policy", (gmView.json?.policies || []).some((p) => p.action === "EXPENSE" && Number(p.thresholdAmountGhs) === 100));
  const workerView = await api("GET", "/api/approvals", workerTok);
  ok("A10 worker sees no policies", (workerView.json?.policies || []).length === 0);
  const gmDelete = await api("POST", "/api/approvals", gmTok, { op: "POLICY_DELETE", policyId: created1.json?.policy?.id });
  ok("A11 GM cannot delete a policy (403)", gmDelete.status === 403);
  const badRole = await api("POST", "/api/approvals", ownerTok, { op: "POLICY_CREATE", action: "EXPENSE", approverRole: "BRANCH_MANAGER" });
  ok("A12 approverRole limited to OWNER/GM", badRole.status === 400);
}

// ════════════════════════════════════════════════════════════════════
console.log("\n── 3. EXPENSE gate lifecycle");
// ════════════════════════════════════════════════════════════════════
{
  // Below threshold → passes untouched.
  const below = await postExpense(bmTok, 50, "Below threshold expense");
  ok("A13 expense below threshold is COMPLETED", below.json?.transaction?.status === "COMPLETED" && below.json?.pendingApproval !== true);

  // Over threshold as BM → gated.
  const gated = await postExpense(bmTok, 250, "Gated expense");
  ok("A14 gated expense returns pendingApproval", gated.json?.pendingApproval === true, JSON.stringify(gated.json?.message));
  ok("A15 gated expense stored as PENDING_APPROVAL", gated.json?.transaction?.status === "PENDING_APPROVAL");
  const trxId = Number(gated.json?.transaction?.id);
  let req = await pendingRequestFor("TRANSACTION", trxId);
  ok("A16 approval request row created", !!req && req.action === "EXPENSE" && Number(req.amount_ghs) === 250);
  const bell = await q1(`select count(*)::int as n from notifications where user_id = $1 and type = 'APPROVAL_REQUESTED' and record_ref = $2`, [ownerUser.id, `approval:${req.id}`]);
  ok("A17 approver bell notification created", bell.n >= 1, `n=${bell.n}`);

  // OWNER posting their own big expense → not gated.
  const own = await postExpense(ownerTok, 900, "Owner own expense");
  ok("A18 OWNER's own expense never gated", own.json?.transaction?.status === "COMPLETED" && own.json?.pendingApproval !== true);

  // Inbox scoping.
  const ownerView = await api("GET", "/api/approvals", ownerTok);
  ok("A19 OWNER inbox holds the pending request", (ownerView.json?.inbox || []).some((r) => Number(r.id) === Number(req.id)));
  const bmView = await api("GET", "/api/approvals", bmTok);
  ok("A20 non-approver BM inbox is empty", (bmView.json?.inbox || []).length === 0);
  ok("A21 BM sees own request in myRequests", (bmView.json?.myRequests || []).some((r) => Number(r.id) === Number(req.id)));
  const workerView = await api("GET", "/api/approvals", workerTok);
  ok("A22 worker inbox empty", (workerView.json?.inbox || []).length === 0);

  // Linked zone.
  const tasks = await api("GET", "/api/tasks?includeLinked=1", ownerTok);
  ok("A23 linked approvals in Action Center", (tasks.json?.linked?.approvals || []).some((a) => Number(a.id) === Number(req.id)));

  // Decide permission checks.
  const wDecide = await api("POST", "/api/approvals", workerTok, { op: "DECIDE", requestId: req.id, decision: "APPROVE" });
  ok("A24 worker cannot decide (403)", wDecide.status === 403);
  const bmDecide = await api("POST", "/api/approvals", bmTok, { op: "DECIDE", requestId: req.id, decision: "APPROVE" });
  ok("A25 non-approver BM cannot decide (403)", bmDecide.status === 403);

  // Approve.
  const approve = await api("POST", "/api/approvals", ownerTok, { op: "DECIDE", requestId: req.id, decision: "APPROVE" });
  ok("A26 OWNER approves", approve.status === 200 && approve.json?.request?.status === "APPROVED", JSON.stringify(approve.json?.error));
  const trx = await q1(`select status from transactions where id = $1`, [trxId]);
  ok("A27 expense flipped to COMPLETED", trx.status === "COMPLETED");
  const decidedBell = await q1(`select count(*)::int as n from notifications where user_id = $1 and type = 'APPROVAL_DECIDED' and record_ref = $2`, [bmUser.id, `approval:${req.id}`]);
  ok("A28 requester notified of decision", decidedBell.n >= 1);
  const auditRow = await q1(`select * from audit_trail where action = 'APPROVAL_APPROVE' and record_id = $1 and record_type = 'approval_requests'`, [req.id]);
  ok("A29 audit-trail row written", !!auditRow);
  const reDecide = await api("POST", "/api/approvals", ownerTok, { op: "DECIDE", requestId: req.id, decision: "APPROVE" });
  ok("A30 double-decide refused (409)", reDecide.status === 409);

  // Reject flow.
  const gated2 = await postExpense(bmTok, 300, "Reject-me expense");
  const trx2 = Number(gated2.json?.transaction?.id);
  const req2 = await pendingRequestFor("TRANSACTION", trx2);
  const reject = await api("POST", "/api/approvals", ownerTok, { op: "DECIDE", requestId: req2.id, decision: "REJECT", reason: "Not budgeted" });
  const rejReq = reject.json?.request || {};
  ok("A31 rejection recorded with reason", reject.status === 200 && rejReq.status === "REJECTED" && (rejReq.decisionReason ?? rejReq.decision_reason) === "Not budgeted");
  const trx2row = await q1(`select status from transactions where id = $1`, [trx2]);
  ok("A32 rejected expense marked REJECTED", trx2row.status === "REJECTED");

  // Withdraw flow.
  const gated3 = await postExpense(bmTok, 300, "Withdraw-me expense");
  const trx3 = Number(gated3.json?.transaction?.id);
  const req3 = await pendingRequestFor("TRANSACTION", trx3);
  const cancel = await api("POST", "/api/approvals", bmTok, { op: "CANCEL", requestId: req3.id });
  ok("A33 requester withdraws pending request", cancel.status === 200 && cancel.json?.request?.status === "CANCELLED");
  const trx3row = await q1(`select status from transactions where id = $1`, [trx3]);
  ok("A34 withdrawn expense released (CANCELLED)", trx3row.status === "CANCELLED");
  const otherCancel = await api("POST", "/api/approvals", gmTok, { op: "CANCEL", requestId: (await pendingRequestFor("TRANSACTION", trx2))?.id ?? 0 });
  ok("A35 non-owner cannot withdraw (404/403)", [403, 404].includes(otherCancel.status));
}

// ════════════════════════════════════════════════════════════════════
console.log("\n── 4. PURCHASE_ORDER gate");
{
  const mkPol = await api("POST", "/api/approvals", ownerTok, { op: "POLICY_CREATE", action: "PURCHASE_ORDER", thresholdAmountGhs: 100, approverRole: "OWNER" });
  ok("B0 PURCHASE_ORDER policy created", mkPol.status === 200, JSON.stringify(mkPol.json?.error));
}
// ════════════════════════════════════════════════════════════════════
{
  const inv = await q1(
    `select i.id, i.name, i.sku from inventory_items i where i.business_id = $1 order by i.id limit 1`,
    [bizId],
  );
  ok("B1 inventory item resolved for PO line", !!inv, JSON.stringify(inv));
  const raise = await api("POST", "/api/procurement", bmTok, {
    action: "RAISE",
    businessId: bizId,
    supplierName: "Verify Approvals Supplier",
    items: [{ inventoryId: inv.id, description: inv.name, qty: 50, unitCostGhs: 5 }],
    notes: "approvals suite PO",
  });
  created.poIds.push(Number(raise.json?.order?.id));
  ok("B2 gated PO returns pendingApproval", raise.json?.pendingApproval === true, JSON.stringify(raise.json));
  ok("B3 PO born PENDING_APPROVAL", raise.json?.order?.status === "PENDING_APPROVAL");
  const poId = Number(raise.json?.order?.id);
  const req = await pendingRequestFor("SUPPLIER_ORDER", poId);
  ok("B4 PO approval request created", !!req && req.action === "PURCHASE_ORDER");
  const advance = await api("POST", "/api/procurement", bmTok, { action: "ADVANCE", id: poId, status: "SENT" });
  ok("B5 PENDING_APPROVAL PO is frozen (ADVANCE 400)", advance.status === 400, JSON.stringify(advance.json));
  const approve = await api("POST", "/api/approvals", ownerTok, { op: "DECIDE", requestId: req.id, decision: "APPROVE" });
  ok("B6 PO approved", approve.status === 200);
  const po = await q1(`select status, status_history from supplier_orders where id = $1`, [poId]);
  ok("B7 PO released to RAISED with history note", po.status === "RAISED" && JSON.stringify(po.status_history).includes("Unlocked by approval"));
  // Cleanup: cancel the PO so nothing lingers as open procurement.
  await api("POST", "/api/procurement", ownerTok, { action: "ADVANCE", id: poId, status: "CANCELLED" });
}

// ════════════════════════════════════════════════════════════════════
console.log("\n── 5. INVENTORY_ADJUSTMENT gate");
// ════════════════════════════════════════════════════════════════════
{
  await api("POST", "/api/approvals", ownerTok, { op: "POLICY_CREATE", action: "INVENTORY_ADJUSTMENT", approverRole: "OWNER" });
  const item = await q1(`select id, name, sku, quantity from inventory_items where business_id = $1 order by id limit 1`, [bizId]);
  created.invId = item.id;
  created.invOriginal = Number(item.quantity);
  const res1 = await api("PATCH", "/api/enterprise", bmTok, {
    entityType: "INVENTORY",
    id: item.id,
    data: { quantity: created.invOriginal + 50 },
  });
  ok("C1 gated adjustment returns pendingApproval", res1.json?.pendingApproval === true, JSON.stringify(res1.json));
  let qty = (await q1(`select quantity from inventory_items where id = $1`, [item.id])).quantity;
  ok("C2 quantity withheld until approved", Number(qty) === created.invOriginal, `qty=${qty}`);
  const req1 = await pendingRequestFor("INVENTORY_ITEM", item.id);
  ok("C3 adjustment request created with payload", !!req1 && Number(req1.payload_snapshot?.newQuantity) === created.invOriginal + 50, JSON.stringify(req1?.payload_snapshot));

  // A second pending adjustment supersedes the first.
  const res2 = await api("PATCH", "/api/enterprise", bmTok, {
    entityType: "INVENTORY",
    id: item.id,
    data: { quantity: created.invOriginal + 100 },
  });
  ok("C4 second adjustment also gated", res2.json?.pendingApproval === true);
  const req1After = await q1(`select status from approval_requests where id = $1`, [req1.id]);
  ok("C5 first pending request superseded (CANCELLED)", req1After.status === "CANCELLED");
  const req2 = await pendingRequestFor("INVENTORY_ITEM", item.id);
  const approve = await api("POST", "/api/approvals", ownerTok, { op: "DECIDE", requestId: req2.id, decision: "APPROVE" });
  ok("C6 adjustment approved", approve.status === 200);
  qty = (await q1(`select quantity from inventory_items where id = $1`, [item.id])).quantity;
  ok("C7 approved quantity applied", Number(qty) === created.invOriginal + 100, `qty=${qty}`);
}

// ════════════════════════════════════════════════════════════════════
console.log("\n── 6. DISCOUNT gate");
// ════════════════════════════════════════════════════════════════════
{
  await api("POST", "/api/approvals", ownerTok, { op: "POLICY_CREATE", action: "DISCOUNT", thresholdPercent: 10, approverRole: "OWNER" });
  const mkDoc = (discountPercent) =>
    api("POST", "/api/sales-documents", bmTok, {
      documentType: "INVOICE",
      businessId: bizId,
      customerName: "Approvals Suite Customer",
      lineItems: [{ description: "Suite item", quantity: 10, unitPrice: 100 }],
      discountPercent,
    });
  const low = await mkDoc(5);
  created.docIds.push(Number(low.json?.document?.id));
  ok("D1 5% discount passes ungated", low.json?.document?.status === "SENT" && low.json?.pendingApproval !== true, JSON.stringify(low.json?.document?.status));
  const high = await mkDoc(15);
  created.docIds.push(Number(high.json?.document?.id));
  ok("D2 15% discount born PENDING_APPROVAL", high.json?.document?.status === "PENDING_APPROVAL" && high.json?.pendingApproval === true);
  const req = await pendingRequestFor("SALE_DOCUMENT", Number(high.json?.document?.id));
  ok("D3 discount request created", !!req && req.action === "DISCOUNT");
  await api("POST", "/api/approvals", ownerTok, { op: "DECIDE", requestId: req.id, decision: "APPROVE" });
  const doc = await q1(`select status from sales_documents where id = $1`, [Number(high.json?.document?.id)]);
  ok("D4 approved discount released as SENT", doc.status === "SENT");
  const high2 = await mkDoc(12);
  created.docIds.push(Number(high2.json?.document?.id));
  const req2 = await pendingRequestFor("SALE_DOCUMENT", Number(high2.json?.document?.id));
  await api("POST", "/api/approvals", ownerTok, { op: "DECIDE", requestId: req2.id, decision: "REJECT", reason: "Too generous" });
  const doc2 = await q1(`select status from sales_documents where id = $1`, [Number(high2.json?.document?.id)]);
  ok("D5 rejected discount CANCELLED", doc2.status === "CANCELLED");
}

// ════════════════════════════════════════════════════════════════════
console.log("\n── 7. DELETION gate");
// ════════════════════════════════════════════════════════════════════
{
  await api("POST", "/api/approvals", ownerTok, { op: "POLICY_CREATE", action: "DELETION", approverRole: "OWNER" });
  const mk = await api("POST", "/api/enterprise", ownerTok, {
    entityType: "customer",
    data: { name: "Approvals Suite Delete-Me", type: "RETAIL", phone: "02000000099", businessId: bizId },
  });
  created.customerId = Number(mk.json?.customer?.id || mk.json?.item?.id);
  if (!created.customerId) {
    const row = await q1(`select id from customers where name = 'Approvals Suite Delete-Me' order by id desc`);
    created.customerId = Number(row?.id);
  }
  ok("E1 throwaway customer created", created.customerId > 0, JSON.stringify(mk.json));
  const del = await api("DELETE", "/api/enterprise", bmTok, {
    entityType: "CUSTOMERS",
    id: created.customerId,
    reason: "Suite: gated customer deletion",
  });
  ok("E2 gated delete returns pendingApproval", del.json?.pendingApproval === true, JSON.stringify(del.json));
  const still = await q1(`select id from customers where id = $1`, [created.customerId]);
  ok("E3 customer stays alive while pending", !!still);
  const req = await pendingRequestFor("CUSTOMER", created.customerId);
  ok("E4 deletion request created", !!req && req.action === "DELETION");
  await api("POST", "/api/approvals", ownerTok, { op: "DECIDE", requestId: req.id, decision: "APPROVE" });
  const gone = await q1(`select id from customers where id = $1`, [created.customerId]);
  ok("E5 approved deletion removes customer", !gone);
  const log = await q1(`select * from record_deletion_logs where module = 'CUSTOMERS' and record_id = $1 order by id desc`, [created.customerId]);
  ok("E6 immutable deletion log written", !!log && log.deleted_by_name === (await q1(`select name from users where email = $1`, [OWNER.email])).name, JSON.stringify(log?.deleted_by_name));
}

// ════════════════════════════════════════════════════════════════════
console.log("\n── 8. GM-approver policy + delegation cascade");
{
  // The OWNER ≥ GH₵100 policy from section 3 is still active. Adding a
  // ≥ GH₵1000 GM policy creates a cascade: the HIGHEST matching threshold
  // governs, so ≥1000 expenses go to the GM while 100-999 stay with the OWNER.
  await api("POST", "/api/approvals", ownerTok, { op: "POLICY_CREATE", action: "EXPENSE", thresholdAmountGhs: 1000, approverRole: "GENERAL_MANAGER" });
  const gated = await postExpense(bmTok, 1200, "GM-approver expense");
  ok("F1 GH₵1200 expense gated", gated.json?.pendingApproval === true);
  const req = await pendingRequestFor("TRANSACTION", Number(gated.json?.transaction?.id));
  const gmView = await api("GET", "/api/approvals", gmTok);
  ok("F2 GM inbox holds the ≥1000 request", (gmView.json?.inbox || []).some((r) => Number(r.id) === Number(req.id)));
  const gmDecide = await api("POST", "/api/approvals", gmTok, { op: "DECIDE", requestId: req.id, decision: "APPROVE" });
  ok("F3 GM decides the ≥1000 request", gmDecide.status === 200 && gmDecide.json?.request?.status === "APPROVED", JSON.stringify(gmDecide.json?.error));
  const trx = await q1(`select status from transactions where id = $1`, [Number(gated.json?.transaction?.id)]);
  ok("F4 GM-approved expense COMPLETED", trx.status === "COMPLETED");
  // 950 matches only the OWNER ≥100 policy → OWNER decides, GM cannot.
  const mid = await postExpense(bmTok, 950, "Cascade mid-tier expense");
  ok("F5 GH₵950 still gated under the OWNER policy", mid.json?.pendingApproval === true, JSON.stringify(mid.json?.transaction?.status));
  const reqMid = await pendingRequestFor("TRANSACTION", Number(mid.json?.transaction?.id));
  const gmMid = await api("POST", "/api/approvals", gmTok, { op: "DECIDE", requestId: reqMid.id, decision: "APPROVE" });
  ok("F6 GM cannot decide the sub-1000 request (403)", gmMid.status === 403);
  const ownerMid = await api("POST", "/api/approvals", ownerTok, { op: "DECIDE", requestId: reqMid.id, decision: "APPROVE" });
  ok("F7 OWNER decides the sub-1000 request", ownerMid.status === 200);
}

// ════════════════════════════════════════════════════════════════════
console.log("\n── 9. Deactivate policy → behaviour reverts");
// ════════════════════════════════════════════════════════════════════
{
  const pols = (await qa(`select * from approval_policies where action = 'EXPENSE' and is_active = true`));
  for (const p of pols) {
    await api("POST", "/api/approvals", ownerTok, { op: "POLICY_UPDATE", policyId: p.id, isActive: false });
  }
  const res = await postExpense(bmTok, 5000, "Paused-policy expense");
  ok("G1 paused policy no longer gates", res.json?.transaction?.status === "COMPLETED" && res.json?.pendingApproval !== true);
}

// ════════════════════════════════════════════════════════════════════
// Cleanup — leave the DB exactly as found.
// ════════════════════════════════════════════════════════════════════
{
  await q(`delete from approval_requests`);
  await q(`delete from approval_policies`);
  await q(`delete from notifications where record_ref like 'approval:%'`);
  if (created.trxIds.length) await q(`delete from transactions where id = any($1::int[])`, [created.trxIds]);
  if (created.poIds.length) await q(`delete from supplier_orders where id = any($1::int[])`, [created.poIds]);
  if (created.docIds.length) await q(`delete from sales_documents where id = any($1::int[])`, [created.docIds]);
  if (created.customerId) await q(`delete from record_deletion_logs where module = 'CUSTOMERS' and record_id = $1`, [created.customerId]);
  if (created.invId != null && created.invOriginal != null) {
    await q(
      `update inventory_items set quantity = $1::double precision,
         status = case when $1::double precision <= 0 then 'OUT_OF_STOCK' when $1::double precision < coalesce(min_stock_threshold, 0) then 'LOW_STOCK' else 'IN_STOCK' end
       where id = $2`,
      [created.invOriginal, created.invId],
    );
  }
  await q(`update users set business_manage_ids = $1 where id = $2`, [bmManageSaved === null || bmManageSaved === undefined ? null : JSON.stringify(bmManageSaved), bmUser.id]);
  await q(`delete from audit_trail where record_type = 'approval_requests'`);
  console.log("\n🧹 cleanup done (policies, requests, notifications, test records, user flags restored)");
}

console.log(`\n════════════════════════════════════════`);
console.log(`APPROVALS SUITE: ${passed} passed, ${failed} failed`);
console.log(`════════════════════════════════════════`);
await client.end();
process.exit(failed ? 1 : 0);
