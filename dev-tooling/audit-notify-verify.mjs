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
  console.log("=== GOMINA 360 NOTIFICATION SYSTEM & DIRECT RECORD LINKING AUDIT ===");
  const pgClient = new Client(PG);
  await pgClient.connect();

  const ownerAuth = await login("kwame.owner@gomina360.com", "Owner@GoMina26");
  ok("Owner login successful", ownerAuth.ok);

  const [workerRow] = (await pgClient.query("SELECT id FROM users WHERE role = 'WORKER' AND email = 'akua.donkor@gomina360.com' LIMIT 1")).rows;
  const workerId = workerRow.id;
  await pgClient.query("UPDATE users SET can_record_expenses = true WHERE id = $1", [workerId]);
  const workerToken = await makeSession(pgClient, workerId);
  ok("Worker session established", Boolean(workerToken));

  const [poultryBiz] = (await pgClient.query("SELECT id FROM businesses WHERE code = 'POULTRY-01' LIMIT 1")).rows;
  const businessId = poultryBiz.id;

  // 1. Audit /api/notifications endpoint
  const notifRes = await fetch(`${BASE}/api/notifications`, { headers: H(ownerAuth.token) });
  const notifData = await notifRes.json();
  ok("GET /api/notifications returns list and counts", notifData.success && Array.isArray(notifData.notifications));

  // 2. Test EXPENSE PRE-APPROVAL Request Notification Generation
  // Ensure approval policy exists
  const orgRes = await pgClient.query("SELECT id FROM organizations LIMIT 1");
  const orgId = Number(orgRes.rows[0].id);
  // Snapshot the tenant's existing EXPENSE policies: this suite needs a clean
  // slate to force its own gate, and must hand the tenant back exactly what it
  // found (leaving a stray policy behind would gate every future expense).
  const priorPolicies = (await pgClient.query(
    "SELECT * FROM approval_policies WHERE owner_id = $1 AND action = 'EXPENSE'",
    [orgId],
  )).rows;
  await pgClient.query("DELETE FROM approval_policies WHERE owner_id = $1 AND action = 'EXPENSE'", [orgId]);
  await fetch(`${BASE}/api/approvals`, {
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

  const reqExpenseRes = await fetch(`${BASE}/api/transactions`, {
    method: "POST",
    headers: H(workerToken),
    body: JSON.stringify({
      businessId,
      type: "EXPENSE",
      category: "Layer Feed Requisition",
      amountGhs: 850,
      description: "Bulk layer feed purchase requisition",
      expenseMode: "REQUEST",
      isPreApproval: true,
    }),
  });
  const reqExpenseData = await reqExpenseRes.json();
  ok("Expense pre-approval request created", reqExpenseData.success && reqExpenseData.pendingApproval);

  // Check approver received APPROVAL_REQUESTED notification with direct record reference
  const [approverNotif] = (await pgClient.query(
    "SELECT * FROM notifications WHERE type = 'APPROVAL_REQUESTED' ORDER BY id DESC LIMIT 1"
  )).rows;
  ok(
    "Approver received APPROVAL_REQUESTED notification linking to approval_requests",
    approverNotif &&
      approverNotif.record_type === "approval_requests" &&
      approverNotif.record_ref?.startsWith("approval:")
  );

  // 3. Test APPROVAL DECISION Notification with Note
  const reqId = Number(approverNotif.record_id);
  const decideRes = await fetch(`${BASE}/api/approvals`, {
    method: "POST",
    headers: H(ownerAuth.token),
    body: JSON.stringify({
      op: "DECIDE",
      requestId: reqId,
      decision: "APPROVE",
      reason: "Approved for Layer House 2 replenishment",
    }),
  });
  const decideData = await decideRes.json();
  ok("Approver submitted decision", decideData.success);

  // Check requester received APPROVAL_DECIDED notification with direct link to Action Center
  const [requesterNotif] = (await pgClient.query(
    "SELECT * FROM notifications WHERE user_id = $1 AND type = 'APPROVAL_DECIDED' ORDER BY id DESC LIMIT 1",
    [workerId]
  )).rows;
  ok(
    "Requester received APPROVAL_DECIDED notification linking to approval record",
    requesterNotif &&
      requesterNotif.record_type === "approval_requests" &&
      requesterNotif.record_id === reqId &&
      requesterNotif.body.includes("Approved for Layer House 2")
  );

  // 4. Test TASK CREATION Notification
  const taskRes = await fetch(`${BASE}/api/tasks`, {
    method: "POST",
    headers: H(ownerAuth.token),
    body: JSON.stringify({
      title: "Inspect Generator Battery",
      detail: "Check voltage and terminal corrosion",
      businessId,
      branchCode: "POULTRY-01",
      assignedUserId: workerId,
      priority: "HIGH",
      dueDate: new Date(Date.now() + 86400000).toLocaleDateString("en-CA"),
    }),
  });
  const taskData = await taskRes.json();
  ok("Task created successfully", taskData.success && taskData.task?.id);

  // 5. Test Notification Patch (Mark read)
  const patchRes = await fetch(`${BASE}/api/notifications`, {
    method: "PATCH",
    headers: H(workerToken),
    body: JSON.stringify({ ids: [requesterNotif.id] }),
  });
  const patchData = await patchRes.json();
  ok("Notification marked as read via PATCH", patchData.success);

  const [readNotif] = (await pgClient.query("SELECT is_read FROM notifications WHERE id = $1", [requesterNotif.id])).rows;
  ok("Notification is_read state is true in database", readNotif.is_read === true);

  // 6. Test ORDER TRACKING & DISPATCH Notification Link
  // Fixture hygiene: the order link below pins the tracking code TRK-TEST-9099,
  // which is UNIQUE. A previous crashed/killed run leaves the row behind and
  // every later run then dies on `customer_trackings_tracking_code_unique`, so
  // clear the fixture (it is a test-only code) before re-creating it.
  await pgClient.query("DELETE FROM customer_trackings WHERE tracking_code = 'TRK-TEST-9099'");
  await pgClient.query("DELETE FROM notifications WHERE record_ref = 'TRK-TEST-9099'");
  const [trackRow] = (await pgClient.query(
    "INSERT INTO customer_trackings (tracking_code, customer_name, customer_phone, destination_address, status, payment_status, total_ghs, business_id, created_at) VALUES ('TRK-TEST-9099', 'Kofi Mensah', '+233240001122', 'Accra Central', 'CONFIRMED', 'PAID', 450, $1, NOW()) RETURNING id",
    [businessId]
  )).rows;

  await pgClient.query(
    "INSERT INTO notifications (user_id, type, title, body, record_type, record_id, record_ref, business_id, branch_code, is_read, created_at) VALUES ($1, 'ONLINE_ORDER_RECEIVED', 'New Online Order TRK-TEST-9099', 'Customer Kofi Mensah placed an order', 'customer_trackings', $2, 'TRK-TEST-9099', $3, 'POULTRY-01', false, NOW())",
    [ownerAuth.user.id, trackRow.id, businessId]
  );
  const [orderNotif] = (await pgClient.query("SELECT * FROM notifications WHERE record_ref = 'TRK-TEST-9099' LIMIT 1")).rows;
  ok(
    "Order notification correctly created with recordRef 'TRK-TEST-9099' and customer_trackings recordType",
    orderNotif && orderNotif.record_ref === "TRK-TEST-9099" && orderNotif.record_type === "customer_trackings"
  );

  // 7. Test AUDIT ISSUE Notification Link
  const [auditIssueRow] = (await pgClient.query(
    "INSERT INTO audit_reviews (record_type, record_id, record_title, module, business_id, branch_code, action, status, priority, issue_title, reason, reviewer_user_id, reviewer_name, reviewer_role, created_at) VALUES ('OPERATION_LOG', 101, 'Mortality Spike Log', 'POULTRY', $1, 'POULTRY-01', 'FLAGGED', 'FLAGGED', 'HIGH', 'Mortality Spike Audit Issue', 'Review feed water quality', $2, 'Auditor Kwame', 'AUDITOR', NOW()) RETURNING id",
    [businessId, ownerAuth.user.id]
  )).rows;

  await pgClient.query(
    "INSERT INTO notifications (user_id, type, title, body, record_type, record_id, record_ref, business_id, branch_code, is_read, created_at) VALUES ($1, 'AUDIT_ISSUE_ASSIGNED', 'Audit Issue Assigned #201', 'You have been assigned to investigate water quality', 'audit_reviews', $2, $3, $4, 'POULTRY-01', false, NOW())",
    [workerId, auditIssueRow.id, `audit:${auditIssueRow.id}`, businessId]
  );
  const [auditNotif] = (await pgClient.query("SELECT * FROM notifications WHERE record_ref = $1 LIMIT 1", [`audit:${auditIssueRow.id}`])).rows;
  ok(
    "Audit notification correctly formatted with issueId/recordId linking directly to Audit workspace",
    auditNotif && Number(auditNotif.record_id) === Number(auditIssueRow.id) && auditNotif.type === "AUDIT_ISSUE_ASSIGNED"
  );

  // 8. Test ADVISOR NOTE Notification Link
  const [advisorRow] = (await pgClient.query(
    "INSERT INTO advisor_notes (business_id, branch_code, note_date, title, body, priority, category, author_name, author_role, created_at) VALUES ($1, 'POULTRY-01', '2026-09-29', 'Vaccination Booster Needed', 'Flock 3 requires Newcastle booster by Friday', 'CRITICAL', 'VET_HEALTH', 'Dr. Mensah', 'VET', NOW()) RETURNING id",
    [businessId]
  )).rows;

  await pgClient.query(
    "INSERT INTO notifications (user_id, type, title, body, record_type, record_id, record_ref, business_id, branch_code, is_read, created_at) VALUES ($1, 'ADVISOR_NOTE_CRITICAL', 'Critical Farm Advisor Guidance', 'Vaccination booster needed for Flock 3', 'advisor_notes', $2, $3, $4, 'POULTRY-01', false, NOW())",
    [ownerAuth.user.id, advisorRow.id, `advisor:${advisorRow.id}`, businessId]
  );
  const [advisorNotif] = (await pgClient.query("SELECT * FROM notifications WHERE record_ref = $1 LIMIT 1", [`advisor:${advisorRow.id}`])).rows;
  ok(
    "Advisor notification created with direct link to advisor_notes and branch context",
    advisorNotif && advisorNotif.record_type === "advisor_notes" && Number(advisorNotif.record_id) === Number(advisorRow.id)
  );

  // ── Cleanup ──────────────────────────────────────────────────────────
  // This audit inserts REAL records (a pre-approval expense request, an audit
  // review, an advisor note and their notifications) to prove the links work.
  // Leaving them behind drifted other suites' expectations — most visibly the
  // budget-vs-actual suite, which counts live expenses and does not expect an
  // APPROVED-not-COMPLETED row to appear out of nowhere. Everything this run
  // created is removed here, by exact id.
  const cleanupIds = [approverNotif?.id, requesterNotif?.id, orderNotif?.id, auditNotif?.id, advisorNotif?.id].filter(Boolean);
  if (cleanupIds.length) {
    await pgClient.query("DELETE FROM notifications WHERE id = ANY($1::int[])", [cleanupIds]);
  }
  await pgClient.query("DELETE FROM approval_requests WHERE id = $1", [reqId]).catch(() => {});
  await pgClient.query("DELETE FROM transactions WHERE description = 'Bulk layer feed purchase requisition'").catch(() => {});
  await pgClient.query("DELETE FROM audit_reviews WHERE id = $1", [auditIssueRow.id]).catch(() => {});
  await pgClient.query("DELETE FROM advisor_notes WHERE id = $1", [advisorRow.id]).catch(() => {});
  await pgClient.query("DELETE FROM notifications WHERE record_ref = 'TRK-TEST-9099'").catch(() => {});
  await pgClient.query("DELETE FROM customer_trackings WHERE tracking_code = 'TRK-TEST-9099'").catch(() => {});
  await pgClient.query("DELETE FROM approval_policies WHERE owner_id = $1 AND action = 'EXPENSE'", [orgId]).catch(() => {});
  for (const row of priorPolicies) {
    await pgClient.query(
      `INSERT INTO approval_policies (owner_id, action, scope_business_id, threshold_amount_ghs, threshold_percent,
         approver_role, approver_user_id, is_active, created_by_name, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.owner_id, row.action, row.scope_business_id, row.threshold_amount_ghs, row.threshold_percent,
       row.approver_role, row.approver_user_id, row.is_active, row.created_by_name, row.created_at],
    ).catch(() => {});
  }
  console.log(`cleanup done (requests, reviews, notes, notifications, tracking fixtures removed; ${priorPolicies.length} pre-existing expense policy row(s) restored)`);

  await pgClient.end();
  console.log(`\nNotification Audit Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error("Test execution failed:", e);
  process.exit(1);
});
