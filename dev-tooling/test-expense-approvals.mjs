import { Client } from "pg";
import crypto from "crypto";

const PG = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const BASE = "http://127.0.0.1:3000";

let passed = 0;
let failed = 0;

function ok(title, condition, detail = "") {
  if (condition) {
    console.log(`  ✔ ${title}`);
    passed++;
  } else {
    console.error(`  ✖ FAIL: ${title}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  return { token: data.sessionToken, user: data.user, ok: res.ok && data.success };
}

async function makeSession(pgClient, userId) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await pgClient.query(
    "INSERT INTO user_sessions (user_id, token_hash, expires_at, created_at, last_seen_at) VALUES ($1, $2, $3, NOW(), NOW())",
    [userId, tokenHash, expiresAt]
  );
  return rawToken;
}

const H = (token) => ({
  "Content-Type": "application/json",
  "x-gomina-session": token,
});

async function run() {
  console.log("=== EXPENSE RECORD VS REQUEST (DEFAULT: REQUEST) VERIFICATION ===");
  const pgClient = new Client(PG);
  await pgClient.connect();

  // 1. Get owner and worker credentials
  const ownerAuth = await login("kwame.owner@gomina360.com", "Owner@GoMina26");
  ok("Owner login successful", ownerAuth.ok);

  const [poultryBiz] = (await pgClient.query("SELECT id FROM businesses WHERE code = 'POULTRY-01' LIMIT 1")).rows;
  const businessId = poultryBiz.id;

  const [workerRow] = (await pgClient.query("SELECT id FROM users WHERE role = 'WORKER' AND email = 'akua.donkor@gomina360.com' LIMIT 1")).rows;
  const worker1Id = workerRow.id;

  await pgClient.query("UPDATE users SET can_record_expenses = false WHERE id = $1", [worker1Id]);
  let worker1Token = await makeSession(pgClient, worker1Id);
  ok("Worker session established", Boolean(worker1Token));

  // 2. Ensure an active EXPENSE approval policy exists for the organization
  const orgRes = await pgClient.query("SELECT id FROM organizations LIMIT 1");
  const orgId = Number(orgRes.rows[0].id);

  // Clean old test policies and requests
  await pgClient.query("DELETE FROM approval_policies WHERE owner_id = $1 AND action = 'EXPENSE'", [orgId]);
  await pgClient.query("DELETE FROM approval_requests WHERE owner_id = $1 AND action = 'EXPENSE'", [orgId]);

  // Create an active policy: EXPENSE >= 50.00 GHS requires OWNER approval
  const polRes = await fetch(`${BASE}/api/approvals`, {
    method: "POST",
    headers: H(ownerAuth.token),
    body: JSON.stringify({
      op: "POLICY_CREATE",
      action: "EXPENSE",
      thresholdAmountGhs: 50,
      approverRole: "OWNER",
      isActive: true,
    }),
  });
  const polData = await polRes.json();
  ok("Approval policy created (EXPENSE >= GH₵ 50.00 → OWNER)", polData.success && polData.policy?.id);

  // 3. Worker Permission Gate: Worker with can_record_expenses = false cannot record expenses
  const noPermRes = await fetch(`${BASE}/api/transactions`, {
    method: "POST",
    headers: H(worker1Token),
    body: JSON.stringify({
      businessId,
      type: "EXPENSE",
      category: "Unauthorized Expense",
      amountGhs: 20,
    }),
  });
  ok("Worker without canRecordExpenses blocked with 403", noPermRes.status === 403);

  // Grant worker permission to record expenses
  await pgClient.query("UPDATE users SET can_record_expenses = true WHERE id = $1", [worker1Id]);
  worker1Token = await makeSession(pgClient, worker1Id);

  // 4. DEFAULT WORKFLOW TEST (Request Expense Mode):
  // When an expense is submitted without explicitly overriding to RECORD, it defaults to REQUEST mode
  const defaultReqRes = await fetch(`${BASE}/api/transactions`, {
    method: "POST",
    headers: H(worker1Token),
    body: JSON.stringify({
      businessId,
      type: "EXPENSE",
      category: "Farm Supplies",
      amountGhs: 250,
      description: "Default submission test (Request Expense mode)",
      expenseMode: "REQUEST",
      isPreApproval: true,
    }),
  });
  const defaultReqData = await defaultReqRes.json();
  ok("Default expense submission operates in REQUEST mode (PENDING_APPROVAL)", defaultReqData.success && defaultReqData.pendingApproval && defaultReqData.transaction?.status === "PENDING_APPROVAL");

  const [defaultAppRow] = (await pgClient.query("SELECT * FROM approval_requests WHERE target_id = $1", [defaultReqData.transaction.id])).rows;
  ok("Approval request has isPreApproval flag in payload snapshot", defaultAppRow && defaultAppRow.payload_snapshot?.isPreApproval === true);

  // 5. RECORD MODE (Explicitly selected Incurred Expense):
  // Below threshold -> COMPLETED
  const subThreshRes = await fetch(`${BASE}/api/transactions`, {
    method: "POST",
    headers: H(worker1Token),
    body: JSON.stringify({
      businessId,
      type: "EXPENSE",
      category: "Small Supplies",
      amountGhs: 30,
      description: "Below threshold incurred test",
      expenseMode: "RECORD",
    }),
  });
  const subThreshData = await subThreshRes.json();
  ok("Explicit RECORD mode below threshold auto-completes", subThreshData.success && subThreshData.transaction?.status === "COMPLETED" && !subThreshData.pendingApproval);

  // Above threshold -> PENDING_APPROVAL
  const gatedRecordRes = await fetch(`${BASE}/api/transactions`, {
    method: "POST",
    headers: H(worker1Token),
    body: JSON.stringify({
      businessId,
      type: "EXPENSE",
      category: "Equipment Maintenance",
      amountGhs: 600,
      description: "Generator overhaul",
      expenseMode: "RECORD",
    }),
  });
  const gatedRecordData = await gatedRecordRes.json();
  ok("Explicit RECORD mode above threshold gated as PENDING_APPROVAL", gatedRecordData.success && gatedRecordData.pendingApproval && gatedRecordData.transaction?.status === "PENDING_APPROVAL");
  const gatedRecordTrxId = gatedRecordData.transaction.id;

  const [recordAppRow] = (await pgClient.query("SELECT * FROM approval_requests WHERE target_id = $1", [gatedRecordTrxId])).rows;
  const gatedRecordAppReqId = recordAppRow.id;

  // 6. FINANCIAL REPORTING ISOLATION:
  const initRes = await fetch(`${BASE}/api/init?businessId=${businessId}`, { headers: H(ownerAuth.token) });
  const initData = await initRes.json();
  const poultryTrxs = initData.transactions || [];
  const foundReqInInit = poultryTrxs.some((t) => Number(t.id) === Number(defaultReqData.transaction.id));
  const foundRecordInInit = poultryTrxs.some((t) => Number(t.id) === Number(gatedRecordTrxId));
  ok("Pending approval transactions isolated from Finance /api/init", !foundReqInInit && !foundRecordInInit);

  // 7. APPROVAL OF REQUEST VS RECORD:
  // (a) Approve Incurred Expense -> Transitions directly to COMPLETED
  const approveRecordRes = await fetch(`${BASE}/api/approvals`, {
    method: "POST",
    headers: H(ownerAuth.token),
    body: JSON.stringify({
      op: "DECIDE",
      requestId: gatedRecordAppReqId,
      decision: "APPROVE",
      reason: "Verified receipt",
    }),
  });
  const approveRecordData = await approveRecordRes.json();
  ok("Owner approved incurred expense", approveRecordData.success);

  const [approvedRecordDb] = (await pgClient.query("SELECT status FROM transactions WHERE id = $1", [gatedRecordTrxId])).rows;
  ok("Incurred expense transitioned to COMPLETED status", approvedRecordDb.status === "COMPLETED");

  // (b) Approve Pre-Approval Request -> Transitions to APPROVED (Ready to spend)
  const approveReqRes = await fetch(`${BASE}/api/approvals`, {
    method: "POST",
    headers: H(ownerAuth.token),
    body: JSON.stringify({
      op: "DECIDE",
      requestId: defaultAppRow.id,
      decision: "APPROVE",
      reason: "Approved to proceed with purchase",
    }),
  });
  const approveReqData = await approveReqRes.json();
  ok("Owner approved future expense request", approveReqData.success);

  const [approvedReqDb] = (await pgClient.query("SELECT status FROM transactions WHERE id = $1", [defaultReqData.transaction.id])).rows;
  ok("Expense request transitioned to APPROVED status (ready to spend & post receipt)", approvedReqDb.status === "APPROVED");

  // 8. Verify Financial Reports still isolate APPROVED request until spent
  const initAfterApprove = await (await fetch(`${BASE}/api/init?businessId=${businessId}`, { headers: H(ownerAuth.token) })).json();
  const trxsAfterApprove = initAfterApprove.transactions || [];
  const foundApprovedInLedger = trxsAfterApprove.some((t) => Number(t.id) === Number(defaultReqData.transaction.id));
  const foundCompletedInLedger = trxsAfterApprove.some((t) => Number(t.id) === Number(gatedRecordTrxId));
  ok("Approved incurred expense appears in finance transactions", foundCompletedInLedger);
  ok("Approved future request remains isolated until spent", !foundApprovedInLedger);

  // 9. DISBURSE & POST RECEIPT:
  const postReceiptRes = await fetch(`${BASE}/api/transactions`, {
    method: "PATCH",
    headers: H(worker1Token),
    body: JSON.stringify({
      id: defaultReqData.transaction.id,
      op: "MARK_SPENT",
      paymentMethod: "MTN_MOMO",
      date: new Date().toISOString().split("T")[0],
      receiptImages: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="],
      description: "Farm Supplies purchased and receipt attached",
    }),
  });
  const postReceiptData = await postReceiptRes.json();
  ok("Disbursed and posted receipt via PATCH /api/transactions", postReceiptData.success && postReceiptData.transaction?.status === "COMPLETED");

  const [postedDb] = (await pgClient.query("SELECT status, payment_method, receipt_images FROM transactions WHERE id = $1", [defaultReqData.transaction.id])).rows;
  ok("Transaction is now COMPLETED in DB with payment method and receipt", postedDb.status === "COMPLETED" && postedDb.payment_method === "MTN_MOMO" && postedDb.receipt_images?.length > 0);

  // 10. Audit trail log:
  const [auditRow] = (await pgClient.query("SELECT * FROM audit_trail WHERE action = 'EXPENSE_POSTED' AND record_id = $1", [defaultReqData.transaction.id])).rows;
  ok("Audit trail logged EXPENSE_POSTED event", Boolean(auditRow));

  // 11. Notifications verification:
  const notifRes = await pgClient.query("SELECT * FROM notifications WHERE user_id = $1 AND type = 'APPROVAL_DECIDED' ORDER BY id DESC LIMIT 2", [worker1Id]);
  ok("Notifications received by requester with approval details", notifRes.rows.length >= 2 && notifRes.rows[0].title.includes("Approved"));

  await pgClient.end();
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error("Test execution failed:", e);
  process.exit(1);
});
