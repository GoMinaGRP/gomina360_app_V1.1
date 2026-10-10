/**
 * probe-owner-bell.mjs — DOES THE OWNER'S BELL ACTUALLY CARRY THEIR WORKSPACE?
 *
 * This probe is deliberately adversarial: it asserts the behaviour the Owner's
 * brief requires, against the running app, and is expected to FAIL before the
 * fix. Every case answers one question with real API calls and real bell rows.
 *
 *   A · the OWNER records a sale themselves → their own bell should still
 *       record it (their workspace is a complete ledger, not a peer feed)
 *   B · someone ELSE records a sale        → the OWNER must be told (control)
 *   C · a manager reached the unit ONLY by manage-delegation sees it in "My
 *       Workspace", so they must get its bell too
 *   D · a Super Admin's workspace is platform-wide, so every tenant's
 *       activity must reach them — including tenants they are not a member of
 *   E · Action Center: a task raised on a unit in the Owner's workspace must
 *       reach the Owner, and a task the Owner assigns to themselves must not
 *       be the one silent case
 *
 * Run: bash dev-tooling/run-suite.sh dev-tooling/probe-owner-bell.mjs
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const PG_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const GM = { email: "abena.gm@gomina360.com", pw: "GoMina@User2" };
const BM = { email: "emmanuel@gomina360.com", pw: "GoMina@User3" };

let pass = 0,
  fail = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`✅ ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail++;
    failures.push(name + (detail ? " — " + detail : ""));
    console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
  }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json().catch(() => ({}));
  const raw = res.headers.get("set-cookie") || "";
  const cookie = raw.split(/,(?=[^;]+?=gomina)/)[0].split(";")[0];
  return { status: res.status, json, cookie };
}
// `opts.body` is handed to fetch as-is, so callers must pass JSON.stringify(...)
// themselves — stringifying again here would make every route read a string
// instead of an object, and the failure looks like "the business is missing"
// rather than "the payload was double-encoded".
const apiFor = (cookie) => async (route, opts = {}) => {
  const res = await fetch(`${BASE}${route}`, {
    ...opts,
    headers: { "content-type": "application/json", cookie, ...(opts.headers || {}) },
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const pg = new Client({ connectionString: PG_URL });
const BIZ = 1; // Mina Akuafo Poultry Farm — org 1

(async () => {
  await pg.connect();
  const ownerLogin = await login(OWNER.email, OWNER.pw);
  const owner = apiFor(ownerLogin.cookie);
  const ownerId = Number(ownerLogin.json?.user?.id);
  const gmLogin = await login(GM.email, GM.pw);
  const gm = apiFor(gmLogin.cookie);
  const gmId = Number(gmLogin.json?.user?.id);
  const bmLogin = await login(BM.email, BM.pw);
  const bm = apiFor(bmLogin.cookie);
  const bmId = Number(bmLogin.json?.user?.id);

  const created = { users: [], orgs: [], tasks: [], txns: [] };
  const today = new Date().toISOString().slice(0, 10);
  const moneyRef = (biz) => `money-day:${biz}:SALE:${today}`;

  const bellHas = async (uid, ref, type = "SALE_RECORDED") => {
    const r = await pg.query(
      "SELECT title FROM notifications WHERE user_id=$1 AND record_ref=$2 AND type=$3 ORDER BY id DESC LIMIT 1",
      [uid, ref, type],
    );
    return r.rows[0] || null;
  };
  // Reset today's roll-up for the user under test so each case is unambiguous.
  const reset = async (uid) => {
    await pg.query("DELETE FROM notifications WHERE user_id=$1 AND record_ref LIKE 'money-day:%'", [uid]);
  };

  /* ── A · the OWNER acts personally ─────────────────────────────────────── */
  section("A · OWNER records the sale themselves");
  await reset(ownerId);
  const selfSale = await owner("/api/transactions", {
    method: "POST",
    body: JSON.stringify({
      businessId: BIZ, type: "INCOME", category: "Direct Receipt",
      amountGhs: 101, paymentMethod: "CASH", description: "TEST probe owner-self sale",
    }),
  });
  ok("A0 the OWNER's own sale is accepted and booked", selfSale.status === 200 && selfSale.json?.success,
    selfSale.json?.error || "");
  if (selfSale.json?.item?.id) created.txns.push(selfSale.json.item.id);
  await sleep(1200);
  const aRow = await bellHas(ownerId, moneyRef(BIZ));
  ok("A1 the OWNER's bell carries a sale they recorded THEMSELVES", !!aRow,
    aRow ? `"${aRow.title}"` : "no SALE_RECORDED row in the Owner's own bell");

  /* ── B · control: somebody else acts ───────────────────────────────────── */
  section("B · CONTROL — a branch manager records a sale");
  await reset(ownerId);
  const otherSale = await bm("/api/transactions", {
    method: "POST",
    body: JSON.stringify({
      businessId: BIZ, type: "INCOME", category: "Direct Receipt",
      amountGhs: 202, paymentMethod: "CASH", description: "TEST probe other-actor sale",
    }),
  });
  ok("B0 the manager's sale is accepted", otherSale.status === 200 && otherSale.json?.success,
    otherSale.json?.error || "");
  if (otherSale.json?.item?.id) created.txns.push(otherSale.json.item.id);
  await sleep(1200);
  const bRow = await bellHas(ownerId, moneyRef(BIZ));
  ok("B1 the OWNER is told about a sale somebody else recorded", !!bRow,
    bRow ? `"${bRow.title}"` : "no row");

  /* ── C · manage-delegation must count as workspace access ─────────────── */
  section("C · a manager whose ONLY route to the unit is manage-delegation");
  {
    const [pwRow] = (await pg.query("SELECT password_hash FROM users WHERE id=$1", [bmId])).rows;
    const ins = await pg.query(
      `INSERT INTO users (name, email, role, assigned_business_id, phone, password_hash,
                          can_record_sales, can_view_finance, can_manage_records,
                          business_manage_ids, primary_org_id)
       VALUES ('TEST Delegated Manager', $1, 'GENERAL_MANAGER', 2, '+233550000011', $2,
               true, true, true, '[3]'::jsonb, 1) RETURNING id`,
      [`probe.delegated.${Date.now().toString(36)}@gomina360.test`, pwRow.password_hash],
    );
    const dmId = Number(ins.rows[0].id);
    created.users.push(dmId);
    await pg.query("INSERT INTO organization_members (organization_id, user_id, role_in_org) VALUES (1, $1, 'MEMBER')", [dmId]);

    const addr = (await pg.query("SELECT email FROM users WHERE id=$1", [dmId])).rows[0].email;
    const dm2 = await login(addr, BM.pw);
    ok("C0 the delegated manager signs in", dm2.status === 200 && !!dm2.json?.success, dm2.json?.error || "");
    const dm = apiFor(dm2.cookie);

    // Does the app actually give them unit 3?
    const probeBiz = await dm("/api/aquaculture?businessId=3");
    ok("C1 the unit is inside their app scope (manage ⇒ access)",
      probeBiz.status !== 403, `HTTP ${probeBiz.status}`);

    await pg.query("DELETE FROM notifications WHERE user_id=$1 AND record_ref LIKE 'money-day:%'", [dmId]);
    const sale3 = await owner("/api/transactions", {
      method: "POST",
      body: JSON.stringify({
        businessId: 3, type: "INCOME", category: "Direct Receipt",
        amountGhs: 303, paymentMethod: "CASH", description: "TEST probe delegated-manager sale",
      }),
    });
    ok("C2 a sale is booked on the delegated unit", sale3.status === 200 && sale3.json?.success,
      sale3.json?.error || "");
    if (sale3.json?.item?.id) created.txns.push(sale3.json.item.id);
    await sleep(1200);
    const cRow = await bellHas(dmId, moneyRef(3));
    ok("C3 the delegated manager's bell carries that unit's sale", !!cRow,
      cRow ? `"${cRow.title}"` : "no row — they can open the unit but its money never rings");
  }

  /* ── D · a Super Admin's workspace is platform-wide ────────────────────── */
  section("D · a Super Admin outside the tenant's membership");
  {
    const [pwRow] = (await pg.query("SELECT password_hash FROM users WHERE id=$1", [gmId])).rows;
    const email = `probe.superadmin.${Date.now().toString(36)}@gomina360.test`;
    const ins = await pg.query(
      `INSERT INTO users (name, email, role, assigned_business_id, phone, password_hash,
                          is_super_admin, can_view_finance, can_record_sales)
       VALUES ('TEST Platform Super Admin', $1, 'OWNER', NULL, '+233550000022', $2,
               true, true, true) RETURNING id`,
      [email, pwRow.password_hash],
    );
    const saId = Number(ins.rows[0].id);
    created.users.push(saId);
    // deliberately NO organization_members row — a platform account
    const saLogin = await login(email, GM.pw);
    ok("D0 the platform Super Admin signs in", saLogin.status === 200 && !!saLogin.json?.success,
      saLogin.json?.error || "");
    const sa = apiFor(saLogin.cookie);
    const canSee = await sa("/api/aquaculture?businessId=3");
    ok("D1 unit 3 is inside their app scope (Super Admin ⇒ platform-wide)",
      canSee.status !== 403, `HTTP ${canSee.status}`);

    await pg.query("DELETE FROM notifications WHERE user_id=$1 AND record_ref LIKE 'money-day:%'", [saId]);
    const sale4 = await owner("/api/transactions", {
      method: "POST",
      body: JSON.stringify({
        businessId: 3, type: "INCOME", category: "Direct Receipt",
        amountGhs: 404, paymentMethod: "CASH", description: "TEST probe superadmin-visible sale",
      }),
    });
    ok("D2 a sale is booked on a unit the Super Admin can open", sale4.status === 200 && sale4.json?.success,
      sale4.json?.error || "");
    if (sale4.json?.item?.id) created.txns.push(sale4.json.item.id);
    await sleep(1200);
    const dRow = await bellHas(saId, moneyRef(3));
    ok("D3 the Super Admin's bell carries that sale", !!dRow,
      dRow ? `"${dRow.title}"` : "no row — platform-wide scope, platform-silent bell");
  }

  /* ── E · Action Center ─────────────────────────────────────────────────── */
  section("E · Action Center activity reaches the Owner's workspace");
  {
    await pg.query("DELETE FROM notifications WHERE user_id=$1 AND type IN ('TASK_ASSIGNED','TASK_OVERDUE','TASK_COMPLETED')", [ownerId]);
    const [worker] = (await pg.query("SELECT id FROM users WHERE role='WORKER' AND assigned_business_id=$1 LIMIT 1", [BIZ])).rows;
    const task = await owner("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "TEST probe owner-raised action", assignedUserId: worker.id, businessId: BIZ, priority: "HIGH", dueDate: "2026-10-01" }),
    });
    ok("E0 the Owner raises an action on their own unit", task.status === 200 && task.json?.success, task.json?.error || "");
    const taskId = Number(task.json?.task?.id || task.json?.id);
    // The dedupe key is the task NUMBER (TASK-2026-nnnnnn), not the row id.
    const taskNo = String(task.json?.task?.taskNumber || "");
    if (taskId) created.tasks.push(taskId);
    await sleep(1200);

    const wRow = await pg.query(
      "SELECT title FROM notifications WHERE user_id=$1 AND record_ref=$2 AND type='TASK_ASSIGNED' LIMIT 1",
      [worker.id, taskNo],
    );
    ok("E1 the ASSIGNEE is told", wRow.rowCount > 0, wRow.rows[0]?.title || `no row (ref ${taskNo})`);
    const oRow = await pg.query(
      "SELECT title FROM notifications WHERE user_id=$1 AND record_ref=$2 AND type='TASK_ASSIGNED' LIMIT 1",
      [ownerId, taskNo],
    );
    ok("E2 the OWNER who raised it in their workspace is also told", oRow.rowCount > 0,
      oRow.rows[0]?.title || "no row — their own workspace raised the action and their bell is silent");
  }

  /* ── F · isolation must survive the fix ────────────────────────────────── */
  section("F · nothing may cross an organization");
  {
    const [otherOrg] = (await pg.query(
      "SELECT b.id FROM businesses b JOIN organizations o ON o.id=b.owner_id WHERE o.id <> 1 LIMIT 1")).rows;
    if (!otherOrg) {
      console.log("   (skipped — only one organization in this database)");
    } else {
      await pg.query("DELETE FROM notifications WHERE user_id=$1 AND record_ref LIKE 'money-day:%'", [ownerId]);
      const saleX = await owner("/api/transactions", {
        method: "POST",
        body: JSON.stringify({
          businessId: Number(otherOrg.id), type: "INCOME", category: "Direct Receipt",
          amountGhs: 505, paymentMethod: "CASH", description: "TEST probe other-tenant sale",
        }),
      });
      if (saleX.json?.item?.id) created.txns.push(saleX.json.item.id);
      await sleep(1200);
      const xRow = await bellHas(ownerId, moneyRef(Number(otherOrg.id)));
      // The Owner is the recorded owner of BOTH demo orgs, so a row here is
      // legitimate; what must never happen is a row in ANOTHER tenant.
      // The real isolation rule: a bell row about business B may only go to a
      // user who is a member of B's organization, that organization's recorded
      // owner, or a platform Super Admin. Testing "b.owner_id = 1" would be
      // wrong — the demo Owner is the recorded owner of BOTH organizations, so
      // org 2 is legitimately his workspace.
      const foreign = await pg.query(
        `SELECT count(*)::int c FROM notifications n
          JOIN businesses b ON b.id = n.business_id
          JOIN organizations o ON o.id = b.owner_id
          JOIN users u ON u.id = n.user_id
         WHERE NOT (
             u.is_super_admin = true
             OR o.owner_user_id = n.user_id
             OR EXISTS (SELECT 1 FROM organization_members m
                         WHERE m.user_id = n.user_id AND m.organization_id = b.owner_id)
         )`,
      );
      ok("F1 no bell row anywhere was delivered outside the business's organization", foreign.rows[0].c === 0,
        `${foreign.rows[0].c} unauthorised row(s)`);
      ok("F2 the Owner is told about their own second organization", !!xRow,
        xRow ? `"${xRow.title}"` : "no row");
    }
  }

  /* ── cleanup ───────────────────────────────────────────────────────────── */
  section("Z · Cleanup");
  for (const id of created.tasks) await pg.query("DELETE FROM notifications WHERE user_id=ANY(SELECT id FROM users) AND body LIKE $1", [`%${id}%`]).catch(() => {});
  await pg.query("DELETE FROM notifications WHERE type LIKE 'TASK_%' AND record_ref LIKE 'TASK-2026-%'").catch(() => {});
  for (const id of created.tasks) await pg.query("DELETE FROM action_tasks WHERE id=$1", [id]).catch(() => {});
  for (const id of created.txns) await pg.query("DELETE FROM transactions WHERE id=$1", [id]).catch(() => {});
  await pg.query("DELETE FROM transactions WHERE description LIKE 'TEST probe %'").catch(() => {});
  for (const uid of created.users) {
    for (const t of ["user_sessions", "notifications", "user_business_access", "organization_members"]) {
      await pg.query(`DELETE FROM ${t} WHERE user_id=$1`, [uid]).catch(() => {});
    }
    await pg.query("DELETE FROM users WHERE id=$1", [uid]).catch(() => {});
  }
  await pg.query("DELETE FROM notifications WHERE record_ref LIKE 'money-day:%' AND user_id=$1", [ownerId]);
  const left = await pg.query(
    "SELECT count(*)::int c FROM transactions WHERE description LIKE 'TEST probe %'");
  ok("Z1 probe ledger rows removed", left.rows[0].c === 0, `${left.rows[0].c} left`);

  await pg.end();
  console.log(`\n${pass} pass / ${fail} fail`);
  if (fail) console.log("FAILED:\n - " + failures.join("\n - "));
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("probe error:", e);
  try { await pg.end(); } catch {}
  process.exit(1);
});