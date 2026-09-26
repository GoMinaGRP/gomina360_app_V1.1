// Verify suite — Daily ops heartbeat (P2): the /api/cron/daily pipeline
// (checklists → low-stock → auto-complete → SLA escalation → per-user
// digest), marker idempotency, digest content and audit-issue deadlines.
// Self-cleaning: removes every row it creates.
//
// Run: node dev-tooling/verify-daily-ops.mjs
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

const today = new Date().toLocaleDateString("en-CA");
const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("en-CA");
const digestRef = (uid) => `digest:${uid}:${today}`;
const created = { notifs: [], reviews: [], tasks: [] };

try {
  const ownerS = await login(OWNER);
  const akuaS = await login(AKUA);
  ok("logins", ownerS.ok && akuaS.ok);

  // Give Akua something to be digested: an open task due today.
  const t = await api(ownerS.cookie, "POST", "/api/tasks", {
    title: "TEST digest fixture task",
    businessId: 1,
    assignedUserId: AKUA.id,
    priority: "MEDIUM",
    dueDate: today,
  });
  ok("fixture task for the digest", t.status === 200 && t.data?.success === true);
  if (t.data?.task) created.tasks.push(t.data.task.id);

  // An overdue dated audit issue for the SLA step.
  const txn = await q1("select id from transactions where business_id = 1 order by id desc limit 1");
  const flag = await api(ownerS.cookie, "POST", "/api/audit", {
    action: "FLAGGED", recordType: "TRANSACTION", recordId: txn?.id,
    reason: "verify-suite: daily-ops SLA fixture", priority: "HIGH",
    issueTitle: "TEST overdue-dated issue", dueDate: yesterday,
  });
  ok("fixture issue flagged with a past deadline", flag.status === 200 && flag.data?.review?.dueDate === yesterday);
  const reviewId = flag.data?.review?.id;
  if (reviewId) created.reviews.push(reviewId);

  // Clean any earlier digest rows for today so counts are deterministic,
  // then run the pipeline (force).
  await client.query("delete from notifications where type = 'DAILY_DIGEST' and record_ref like $1", [`digest:%:${today}`]);
  const run = await api(ownerS.cookie, "GET", "/api/cron/daily?force=1");
  ok("forced pipeline run succeeds", run.status === 200 && run.data?.ran === true && run.data?.via === "session");

  // ── 1. All five steps executed and reported ok ──
  const steps = run.data?.steps || [];
  for (const s of ["checklists", "low-stock", "auto-complete", "task-escalation", "issue-escalation", "digest"]) {
    ok(`pipeline step “${s}” ran`, steps.some((x) => x.step === s && x.ok === true));
  }
  ok("public response exposes counts, not user ids", typeof run.data?.digestsSent === "number" && !run.data?.digests);

  // ── 2. Digest landed for users with something on their plate ──
  const akuaDigest = await q1("select * from notifications where user_id = $1 and type = 'DAILY_DIGEST' and record_ref = $2", [AKUA.id, digestRef(AKUA.id)]);
  ok("Akua received her daily digest", !!akuaDigest);
  if (akuaDigest) created.notifs.push(akuaDigest.id);
  ok("digest counts her open action", /open action/i.test(akuaDigest?.body || "") && /due today/i.test(akuaDigest?.body || ""));
  ok("digest deep-links to the Action Center", /action center/i.test(akuaDigest?.body || ""));

  const ownerDigest = await q1("select * from notifications where user_id = $1 and type = 'DAILY_DIGEST' and record_ref = $2", [1, digestRef(1)]);
  ok("owner received his digest", !!ownerDigest);
  if (ownerDigest) created.notifs.push(ownerDigest.id);

  // ── 3. Digest dedupe: a second forced run never duplicates today's rows ──
  const countBefore = (await q("select id from notifications where type = 'DAILY_DIGEST' and record_ref like $1", [`digest:%:${today}`])).length;
  await api(ownerS.cookie, "GET", "/api/cron/daily?force=1");
  const countAfter = (await q("select id from notifications where type = 'DAILY_DIGEST' and record_ref like $1", [`digest:%:${today}`])).length;
  ok("second forced run does not duplicate digests", countBefore === countAfter, `${countBefore} → ${countAfter}`);

  // ── 4. Marker: unforced same-day run is skipped ──
  const again = await api(ownerS.cookie, "GET", "/api/cron/daily");
  ok("unforced same-day run is marker-skipped", again.data?.skipped === true);

  // ── 5. SLA: the dated issue escalated ──
  const sla = await q1(
    "select * from notifications where type = 'AUDIT_ISSUE_OVERDUE' and record_ref like $1 order by id desc",
    [`issue-overdue:${reviewId}:%`],
  );
  ok("overdue dated issue escalates (AUDIT_ISSUE_OVERDUE)", !!sla);
  if (sla) created.notifs.push(sla.id);
  ok("escalation states the days overdue and deadline", /1 day past|days past/.test(sla?.body || "") && String(sla?.body || "").includes(yesterday));

  // ── 6. Checklists ensured: today's entries exist for the demo businesses ──
  const cl = await q1("select count(*)::int as c from checklist_entries where checklist_date = $1", [today]);
  ok("today's checklists materialized", (cl?.c || 0) > 0, `${cl?.c} entries`);

  // ── 7. Worker cannot trigger the cron pipeline ──
  const wRun = await api(akuaS.cookie, "GET", "/api/cron/daily?force=1");
  ok("workers cannot trigger the pipeline", wRun.status === 401);
} catch (e) {
  ok("suite ran without exception", false, String(e?.message || e));
} finally {
  if (!process.env.KEEP) {
    try {
      for (const id of created.tasks) await client.query("delete from action_tasks where id = $1", [id]);
      for (const rid of created.reviews) {
        await client.query("delete from audit_issue_updates where issue_id = $1", [rid]);
        await client.query("delete from notifications where issue_id = $1", [rid]);
        await client.query("delete from audit_reviews where id = $1", [rid]);
      }
      await client.query("delete from notifications where id = any($1::int[])", [created.notifs.length ? created.notifs : [0]]);
      await client.query("delete from notifications where type = 'DAILY_DIGEST' and record_ref like $1", [`digest:%:${today}`]);
      await client.query("delete from notifications where type = 'TASK_ASSIGNED' and record_ref in (select task_number from action_tasks where title like 'TEST %')");
      await client.query("delete from audit_trail where detail like '%verify-suite%' or reason like '%verify-suite%'");
      await client.query("delete from notifications where body like '%verify-suite%' or title like 'TEST %'");
      await client.query("delete from action_tasks where title like 'TEST %'");
      console.log("🧹 test rows removed");
    } catch (e) {
      console.log("⚠ cleanup issue:", e?.message);
    }
  }
  await client.end();
}

console.log(`\n${failures === 0 ? "🎉 ALL DAILY-OPS CHECKS PASSED" : `💥 ${failures} FAILING`} (${checks.length} checks)`);
process.exit(failures === 0 ? 0 : 1);
