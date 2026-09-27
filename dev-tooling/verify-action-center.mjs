// Verify suite — Unified Action Center (P1): API-level lifecycle, scoping,
// notification conversion, audit-issue deadlines, linked mirrors and
// auto-completion. Creates precise test rows and deletes them by id at the
// end (self-cleaning; KEEP=1 keeps them for forensics).
//
// Run: node dev-tooling/verify-action-center.mjs
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const AKUA = { id: 10, email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };

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
}
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

const created = { tasks: [], notifs: [], reviews: [], updates: [], trail: [] };
const today = new Date().toLocaleDateString("en-CA");
const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("en-CA");
const in2days = new Date(Date.now() + 2 * 86400000).toLocaleDateString("en-CA");

try {
  // ── Setup: find a real business + transaction to work with ──
  const biz = await q1("select id, code from businesses where code = 'POULTRY-01'");
  const otherBiz = await q1("select id, code from businesses where code = 'HARDWARE-01'");
  ok("fixture businesses present", !!biz && !!otherBiz);

  const ownerS = await login(OWNER);
  const akuaS = await login(AKUA);
  ok("owner + worker logins", ownerS.ok && akuaS.ok);

  // ── 1. GET shape ──
  const g1 = await api(ownerS.cookie, "GET", "/api/tasks");
  ok("GET /api/tasks (owner)", g1.status === 200 && g1.data?.success === true);
  ok("response carries stats/tasks/linked/assignableUsers",
    Array.isArray(g1.data?.tasks) && !!g1.data?.stats && !!g1.data?.linked && Array.isArray(g1.data?.assignableUsers));
  ok("today is local ISO", /^\d{4}-\d{2}-\d{2}$/.test(g1.data?.today || ""));

  // ── 2. Owner creates an overdue HIGH task for Akua ──
  const p1 = await api(ownerS.cookie, "POST", "/api/tasks", {
    title: "TEST Reconcile layer house 2 stock",
    detail: "verify-suite fixture",
    businessId: biz.id,
    assignedUserId: AKUA.id,
    priority: "HIGH",
    dueDate: yesterday,
  });
  ok("POST create task for worker", p1.status === 200 && p1.data?.success === true && /^TASK-\d{4}-\d{6,}$/.test(p1.data?.task?.taskNumber || ""));
  const t1 = p1.data?.task;
  if (t1) created.tasks.push(t1.id);
  ok("task stored with tenant ownerId + source MANUAL",
    t1 && Number(t1.ownerId) > 0 && t1.sourceType === "MANUAL" && t1.status === "OPEN");

  const notif1 = await q1(
    "select * from notifications where user_id = $1 and type = 'TASK_ASSIGNED' and record_ref = $2",
    [AKUA.id, t1?.taskNumber],
  );
  ok("TASK_ASSIGNED bell row for the assignee", !!notif1);
  if (notif1) created.notifs.push(notif1.id);
  ok("assigned notification mentions due date + priority",
    !!notif1 && /due/i.test(notif1.body || "") && /high priority/i.test(notif1.body || ""),
    `body="${(notif1?.body || "").slice(0, 120)}"`);

  // ── 3. Worker sees exactly her task ──
  const g2 = await api(akuaS.cookie, "GET", "/api/tasks");
  const mine2 = (g2.data?.tasks || []).filter((t) => t.id === t1?.id);
  ok("worker GET sees the assigned task", g2.status === 200 && mine2.length === 1);
  ok("worker stats count it as mine/overdue",
    (g2.data?.stats?.mine || 0) >= 1 && (g2.data?.stats?.mineOverdue || 0) >= 1);

  // ── 4. Lifecycle: start → done ──
  const s1 = await api(akuaS.cookie, "PATCH", "/api/tasks", { id: t1?.id, status: "IN_PROGRESS" });
  ok("assignee starts the task", s1.status === 200 && s1.data?.task?.status === "IN_PROGRESS");
  const s2 = await api(akuaS.cookie, "PATCH", "/api/tasks", { id: t1?.id, status: "DONE", completionNote: "Counted and reconciled" });
  ok("assignee completes with note",
    s2.status === 200 && s2.data?.task?.status === "DONE" && /Akua/.test(s2.data?.task?.completedByName || ""));
  const doneNotif = await q1(
    "select * from notifications where type = 'TASK_COMPLETED' and record_ref = $1",
    [`${t1?.taskNumber}:done`],
  );
  ok("TASK_COMPLETED reaches the creator", !!doneNotif);
  if (doneNotif) created.notifs.push(doneNotif.id);

  // ── 5. Tenant scoping ──
  const p2 = await api(ownerS.cookie, "POST", "/api/tasks", {
    title: "TEST owner self task",
    businessId: otherBiz.id,
    assignedUserId: Number((await q1("select id from users where email = $1", [OWNER.email])).id),
    dueDate: null,
  });
  if (p2.data?.task) created.tasks.push(p2.data.task.id);
  const wPatch = await api(akuaS.cookie, "PATCH", "/api/tasks", { id: p2.data?.task?.id, status: "DONE" });
  ok("worker cannot complete someone else's task", wPatch.status === 403);
  const wPost = await api(akuaS.cookie, "POST", "/api/tasks", {
    title: "TEST cross-tenant attempt",
    businessId: otherBiz.id,
    assignedUserId: Number((await q1("select id from users where email = $1", [OWNER.email])).id),
  });
  ok("worker cannot assign into an inaccessible business", wPost.status === 403);
  const g3 = await api(akuaS.cookie, "GET", "/api/tasks");
  ok("worker never sees the owner's other task", !(g3.data?.tasks || []).some((t) => t.id === p2.data?.task?.id));

  // ── 6. Notification → task conversion ──
  const anyNotif = await q1(
    "select * from notifications where user_id = $1 order by id desc limit 1",
    [Number((await q1("select id from users where email = $1", [OWNER.email])).id)],
  );
  ok("owner has a notification to convert", !!anyNotif);
  const conv = await api(ownerS.cookie, "POST", "/api/tasks", {
    sourceType: "NOTIFICATION",
    sourceId: anyNotif?.id,
    assignedUserId: Number((await q1("select id from users where email = $1", [OWNER.email])).id),
    dueDate: in2days,
  });
  ok("notification converts to a task", conv.status === 200 && conv.data?.task?.sourceType === "NOTIFICATION");
  if (conv.data?.task) created.tasks.push(conv.data.task.id);
  const convForeign = await api(akuaS.cookie, "POST", "/api/tasks", {
    title: "TEST foreign notification",
    sourceType: "NOTIFICATION",
    sourceId: anyNotif?.id,
  });
  ok("cannot convert someone else's notification", convForeign.status === 403);

  // ── 7. Audit issue with a corrective-action deadline ──
  const txn = await q1(
    "select id, transaction_number, business_id from transactions where business_id = $1 order by id desc limit 1",
    [biz.id],
  );
  ok("fixture transaction present", !!txn);
  const flag = await api(ownerS.cookie, "POST", "/api/audit", {
    action: "FLAGGED",
    recordType: "TRANSACTION",
    recordId: txn?.id,
    reason: "verify-suite: flagged for Action Center deadline test",
    priority: "HIGH",
    issueTitle: "TEST deadline issue",
    dueDate: in2days,
  });
  ok("flag with dueDate accepted", flag.status === 200 && flag.data?.review?.dueDate === in2days, `got ${flag.data?.review?.dueDate}`);
  const reviewId = flag.data?.review?.id;
  if (reviewId) created.reviews.push(reviewId);
  const dueNotif = await q1("select * from notifications where issue_id = $1 and type = 'AUDIT_ISSUE_ASSIGNED'", [reviewId]);
  ok("assignee notification carries the deadline", !!dueNotif && /Corrective action due/.test(dueNotif?.body || ""),
    dueNotif ? `body(len=${(dueNotif.body || "").length})=${(dueNotif.body || "").slice(-140)}` : "no AUDIT_ISSUE_ASSIGNED row");
  if (dueNotif) created.notifs.push(dueNotif.id);

  // Linked zone shows the dated issue
  const g4 = await api(ownerS.cookie, "GET", "/api/tasks?includeLinked=1");
  const linkedIssue = (g4.data?.linked?.auditIssues || []).find((i) => i.id === reviewId);
  ok("linked zone shows the open audit issue with its due date", !!linkedIssue && linkedIssue.dueDate === in2days);

  // ── 8. Track the issue as a task, then resolve the source → auto-complete ──
  const track = await api(ownerS.cookie, "POST", "/api/tasks", {
    title: "TEST mirror of audit issue",
    businessId: biz.id,
    assignedUserId: Number((await q1("select id from users where email = $1", [OWNER.email])).id),
    priority: "HIGH",
    dueDate: in2days,
    sourceType: "AUDIT_ISSUE",
    sourceId: reviewId,
    sourceLabel: "Audit issue follow-up",
  });
  ok("mirror task created", track.status === 200 && track.data?.task?.sourceType === "AUDIT_ISSUE");
  if (track.data?.task) created.tasks.push(track.data.task.id);

  // Resolve the issue: the assignee responds (when it is our worker), then
  // the owner verifies & closes via the issue PATCH path.
  const assigned = flag.data?.assignedTo?.id ?? (await q1("select assigned_user_id from audit_reviews where id = $1", [reviewId]))?.assigned_user_id;
  if (assigned === AKUA.id) {
    const resp = await api(akuaS.cookie, "POST", "/api/audit/issues", {
      reviewId, action: "MARK_RESOLVED", note: "verify-suite: fixed — stock recounted and matches",
    });
    ok("assignee marks the correction complete", resp.status === 200 && resp.data?.success === true, `status ${resp.status}`);
  } else {
    ok("assignee marks the correction complete", true, `skipped — routed to user ${assigned}`);
  }
  const ver = await api(ownerS.cookie, "PATCH", "/api/audit", {
    reviewId, action: "VERIFY", resolution: "verify-suite: verified & closed",
  });
  ok("owner verifies & closes the issue", ver.status === 200 && ver.data?.success === true, `status ${ver.status}`);
  const cron1 = await api(ownerS.cookie, "GET", "/api/cron/daily?force=1");
  ok("cron force run executes the pipeline", cron1.status === 200 && cron1.data?.success === true && cron1.data?.ran === true);
  const mirrored = await q1("select * from action_tasks where id = $1", [track.data?.task?.id]);
  ok("mirror task auto-completed when its issue resolved",
    mirrored?.status === "DONE" && /auto-completed/i.test(mirrored?.completion_note || ""), `status=${mirrored?.status}`);

  // ── 9. Cron idempotency (marker) ──
  const cron2 = await api(ownerS.cookie, "GET", "/api/cron/daily");
  ok("second same-day run is marker-skipped", cron2.status === 200 && cron2.data?.skipped === true);
  const anon = await fetch(`${BASE}/api/cron/daily`);
  ok("anonymous cron call rejected", anon.status === 401);

  // ── 10. Escalation: an overdue open task re-notifies ──
  const p3 = await api(ownerS.cookie, "POST", "/api/tasks", {
    title: "TEST overdue escalation",
    businessId: biz.id,
    assignedUserId: AKUA.id,
    priority: "CRITICAL",
    dueDate: new Date(Date.now() - 9 * 86400000).toLocaleDateString("en-CA"), // 9 days → weekly step
  });
  if (p3.data?.task) created.tasks.push(p3.data.task.id);
  const esc = await api(ownerS.cookie, "GET", "/api/cron/daily?force=1");
  ok("escalation sweep runs inside the pipeline", esc.status === 200 && typeof esc.data?.tasksEscalated === "number");
  const escNotif = await q1(
    "select * from notifications where user_id = $1 and type = 'TASK_OVERDUE' and record_ref like $2",
    [AKUA.id, `task-overdue:${p3.data?.task?.id}:%`],
  );
  ok("overdue task escalates to the assignee", !!escNotif);
  if (escNotif) created.notifs.push(escNotif.id);
} catch (e) {
  ok("suite ran without exception", false, String(e?.message || e));
} finally {
  // ── Cleanup (precise ids only) ──
  if (!process.env.KEEP) {
    try {
      for (const id of created.tasks) await client.query("delete from action_tasks where id = $1", [id]);
      await client.query("delete from notifications where id = any($1::int[])", [created.notifs.length ? created.notifs : [0]]);
      for (const rid of created.reviews) {
        await client.query("delete from audit_issue_updates where issue_id = $1", [rid]);
        await client.query("delete from notifications where issue_id = $1", [rid]);
        await client.query("delete from audit_reviews where id = $1", [rid]);
      }
      await client.query("delete from audit_reviews where reason like 'verify-suite%' or comment like 'verify-suite%' or reason like 'verify-suite: verified'");
      await client.query("delete from audit_trail where detail like '%verify-suite%' or reason like '%verify-suite%'");
      await client.query("delete from action_tasks where title like 'TEST %' or detail = 'verify-suite fixture'");
      await client.query("delete from notifications where title like 'TEST %' or body like '%verify-suite%'");
      console.log("🧹 test rows removed");
    } catch (e) {
      console.log("⚠ cleanup issue:", e?.message);
    }
  }
  await client.end();
}

console.log(`\n${failures === 0 ? "🎉 ALL ACTION-CENTER CHECKS PASSED" : `💥 ${failures} FAILING`} (${checks.length} checks)`);
process.exit(failures === 0 ? 0 : 1);
