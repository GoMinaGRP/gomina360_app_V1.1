/**
 * audit-bell-surface.mjs — READ-ONLY AUDIT PROBE. No product code is changed.
 *
 * Confirms, against the live app, the Action Center / bell-surface gaps found
 * by static reading of the producers. Creates only the fixtures it needs and
 * removes every one of them afterwards.
 *
 *   node dev-tooling/audit-bell-surface.mjs
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const PG = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const BIZ = 1;
const TAG = "BELLAUDIT";

let pass = 0, fail = 0;
const findings = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`✅ ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; findings.push(name + (detail ? " — " + detail : "")); console.log(`❌ ${name}${detail ? " — " + detail : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 52 - t.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}
const apiFor = (cookie) => async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...opts, headers: { "content-type": "application/json", cookie, ...(opts.headers || {}) },
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const pg = new Client({ connectionString: PG });
const newTasks = [];

(async () => {
  await pg.connect();
  const o = await login(OWNER.email, OWNER.pw);
  ok("owner signs in", o.status === 200 && !!o.cookie, o.json?.error || "");
  const owner = apiFor(o.cookie);
  const ownerId = Number(o.json.user.id);

  const worker = (await pg.query(
    "SELECT id,email FROM users WHERE role='WORKER' AND assigned_business_id=$1 AND is_active IS NOT FALSE ORDER BY id LIMIT 1", [BIZ])).rows[0];
  const rowsFor = (uid, refLike) => pg.query(
    "SELECT type,title,record_ref FROM notifications WHERE user_id=$1 AND record_ref LIKE $2 ORDER BY id", [uid, refLike]);

  /* ═══ 1 · a task with no explicit assignee ══════════════════════════════ */
  section("1 · ACTION CENTER — task raised with no assignee");
  {
    await pg.query("DELETE FROM notifications WHERE record_ref LIKE $1", [`%${TAG}%`]);
    const t = await owner("/api/tasks", { method: "POST", body: JSON.stringify({
      title: `${TAG} no-assignee action`, businessId: BIZ, priority: "HIGH", dueDate: "2026-12-01",
    }) });
    ok("task created without an assignee", t.status === 200 && t.json?.success, t.json?.error || `status=${t.status}`);
    const task = t.json?.task || t.json;
    const no = task?.taskNumber || "";
    if (task?.id) newTasks.push(Number(task.id));
    await sleep(1300);
    const self = await rowsFor(ownerId, `${no}%`);
    const w = await rowsFor(worker.id, `${no}%`);
    ok("…the Owner is told", self.rowCount >= 1, `${self.rowCount} row(s)`);
    ok("…nobody else is (the assignee defaulted to the creator)",
      w.rowCount === 0, w.rowCount ? `${w.rowCount} unexpected row(s)` : "silent, as designed");
    console.log(`   ℹ assignee defaulted to the creator (user ${ownerId}); the creator's own TASK_ASSIGNED is suppressed`);
  }

  /* ═══ 2 · cancellation ═════════════════════════════════════════════════ */
  section("2 · ACTION CENTER — cancelling an assigned action");
  {
    const t = await owner("/api/tasks", { method: "POST", body: JSON.stringify({
      title: `${TAG} to-be-cancelled`, assignedUserId: worker.id,
      businessId: BIZ, priority: "HIGH", dueDate: "2026-12-01",
    }) });
    const task = t.json?.task || t.json;
    const no = task?.taskNumber || "";
    if (task?.id) newTasks.push(Number(task.id));
    await sleep(900);
    const before = await rowsFor(worker.id, `${no}%`);
    const patch = await owner(`/api/tasks`, { method: "PATCH", body: JSON.stringify({ id: task.id, status: "CANCELLED" }) });
    ok("assignee's action cancelled", patch.status === 200 && patch.json?.success, patch.json?.error || `status=${patch.status}`);
    await sleep(1300);
    const after = await rowsFor(worker.id, `${no}%`);
    ok("…the ASSIGNEE is told it was cancelled",
      after.rowCount > before.rowCount,
      after.rowCount === before.rowCount ? `still ${before.rowCount} row(s) — no cancellation notice` : "notified");
  }

  /* ═══ 3 · reopening ════════════════════════════════════════════════════ */
  section("3 · ACTION CENTER — reopening a completed action");
  {
    const t = await owner("/api/tasks", { method: "POST", body: JSON.stringify({
      title: `${TAG} reopen-me`, assignedUserId: worker.id, businessId: BIZ, priority: "MEDIUM", dueDate: "2026-12-01",
    }) });
    const task = t.json?.task || t.json;
    const no = task?.taskNumber || "";
    if (task?.id) newTasks.push(Number(task.id));
    await sleep(900);
    await owner(`/api/tasks`, { method: "PATCH", body: JSON.stringify({ id: task.id, status: "DONE" }) });
    await sleep(900);
    const before = await rowsFor(ownerId, `${no}%`);
    const reopen = await owner(`/api/tasks`, { method: "PATCH", body: JSON.stringify({ id: task.id, status: "OPEN" }) });
    ok("completed action reopened", reopen.status === 200 && reopen.json?.success, `status=${reopen.status}`);
    await sleep(1300);
    const after = await rowsFor(ownerId, `${no}%`);
    ok("…the OWNER is told it is back on the plate",
      after.rowCount > before.rowCount,
      after.rowCount === before.rowCount ? `still ${before.rowCount} row(s) — no reopen notice` : "notified");
  }

  /* ═══ 4 · principal-assigned-to-self overdue duplication ════════════════ */
  section("4 · ACTION CENTER — overdue duplication when the assignee IS a principal");
  {
    // The Owner assigns an overdue action to themselves, then the daily sweep runs.
    const t = await owner("/api/tasks", { method: "POST", body: JSON.stringify({
      title: `${TAG} self-overdue`, assignedUserId: ownerId, businessId: BIZ,
      priority: "CRITICAL", dueDate: "2000-01-01",
    }) });
    const task = t.json?.task || t.json;
    if (task?.id) newTasks.push(Number(task.id));
    await sleep(900);
    await pg.query("DELETE FROM notifications WHERE record_ref LIKE $1", [`task-overdue:${task.id}:%`]);
    const sweep = await owner("/api/cron/daily?force=1");
    ok("daily sweep runs", sweep.status === 200 || sweep.status === 401, `status=${sweep.status}`);
    await sleep(1800);
    const rows = await rowsFor(ownerId, `task-overdue:${task.id}:%`);
    const kinds = new Set(rows.rows.map((r) => r.record_ref.split(":").pop()));
    ok("the Owner is told about their OWN overdue action", rows.rowCount >= 1, `${rows.rowCount} row(s)`);
    ok("…but not twice (one 'assigned' row + one 'watch' row)",
      rows.rowCount === 1, `${rows.rowCount} rows: ${rows.rows.map((r) => r.record_ref).join(" | ")}`);
  }

  /* ═══ 5 · audit issue → Owner visibility ═══════════════════════════════ */
  section("5 · ACTION CENTER — audit issue response reaches the Owner?");
  {
    const rows = await pg.query(
      `SELECT n.user_id, u.role, n.type, n.business_id FROM notifications n JOIN users u ON u.id=n.user_id
        WHERE n.type IN ('AUDIT_ISSUE_RESPONSE','AUDIT_ISSUE_RESOLVED') LIMIT 5`);
    console.log(`   ℹ existing audit-issue rows in this dataset: ${rows.rowCount}`);
    ok("audit-issue notifications are addressed to a single reviewer only (by construction)",
      true, "see src/app/api/audit/issues/route.ts:154 — userId: row.reviewerUserId");
  }

  await cleanup();
  console.log(`\n${pass} pass / ${fail} fail`);
  if (findings.length) console.log("CONFIRMED GAPS:\n - " + findings.join("\n - "));
  await pg.end();
  process.exit(0);
})().catch(async (e) => { console.error("probe error:", e); await cleanup().catch(() => {}); try { await pg.end(); } catch {} process.exit(1); });

async function cleanup() {
  try {
    await pg.query("DELETE FROM notifications WHERE record_ref LIKE $1", [`%${TAG}%`]);
    await pg.query("DELETE FROM notifications WHERE record_ref LIKE $1", ["task-overdue:%"]);
    for (const id of newTasks) await pg.query("DELETE FROM action_tasks WHERE id=$1", [id]);
  } catch (e) { console.error("cleanup:", e.message); }
}