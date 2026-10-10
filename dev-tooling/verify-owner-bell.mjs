/**
 * verify-owner-bell.mjs — "My Workspace must appear in my bell."
 *
 * The Owner's brief: an activity on a business inside an Owner/Super Admin's
 * My Workspace must reach that Owner's bell **regardless of which authorized
 * user performed it**. This suite pins that contract, and — just as important —
 * pins the two boundaries around it:
 *
 *   • non-principals are still NOT pinged for their own actions (the fix must
 *     not turn the bell into an echo of everything anyone typed);
 *   • nothing may be delivered outside the business's organization.
 *
 * Every case runs against the live app through its own APIs and reads real
 * bell rows. Fixtures are removed afterwards.
 *
 * Run: bash dev-tooling/run-suite.sh dev-tooling/verify-owner-bell.mjs
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const PG_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const TAG = "OWNERBELL";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const GM = { email: "abena.gm@gomina360.com", pw: "GoMina@User2" };
const BM = { email: "emmanuel@gomina360.com", pw: "GoMina@User3" };
const BIZ1 = 1;

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
const today = () => new Date().toISOString().slice(0, 10);

// `opts.body` is handed to fetch as-is — callers pass JSON.stringify themselves.
async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json().catch(() => ({}));
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return { status: res.status, json, cookie };
}
const apiFor =
  (cookie) =>
  async (path, opts = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: { "content-type": "application/json", cookie, ...(opts.headers || {}) },
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

const pg = new Client({ connectionString: PG_URL });

(async () => {
  await pg.connect();
  const ownerLogin = await login(OWNER.email, OWNER.pw);
  ok("the Owner signs in", ownerLogin.status === 200 && !!ownerLogin.cookie);
  const owner = apiFor(ownerLogin.cookie);
  const ownerId = Number(ownerLogin.json.user.id);
  const gmLogin = await login(GM.email, GM.pw);
  const gm = apiFor(gmLogin.cookie);
  const bmLogin = await login(BM.email, BM.pw);
  const bm = apiFor(bmLogin.cookie);

  const fx = { users: [], items: [], tasks: [], txns: [] };
  // Shared fixture: a worker on the Owner's unit, used as the Action Center
  // assignee by every transition case.
  const [worker] = (
    await pg.query("SELECT id, email FROM users WHERE role='WORKER' AND assigned_business_id=$1 AND is_active IS NOT FALSE ORDER BY id LIMIT 1", [BIZ1])
  ).rows;
  const moneyRef = (biz, kind = "SALE") => `money-day:${biz}:${kind}:${today()}`;
  const clearMoney = (uid) =>
    pg.query("DELETE FROM notifications WHERE user_id=$1 AND record_ref LIKE 'money-day:%'", [uid]);
  // A previous run that crashed mid-suite leaves fixtures behind (the sku has a
  // unique constraint per business, so a stale disposable item aborts the next
  // run before a single assertion executes). Clear this suite's own footprint
  // first, so it is always safe to re-run.
  await pg.query("DELETE FROM notifications WHERE record_ref LIKE 'task:%' AND record_id IN (SELECT id FROM action_tasks WHERE title LIKE $1)", [`%${TAG}%`]);
  await pg.query("DELETE FROM notifications WHERE title LIKE $1 OR body LIKE $1", [`%${TAG}%`]);
  await pg.query("DELETE FROM action_tasks WHERE title LIKE $1", [`%${TAG}%`]);
  await pg.query("DELETE FROM inventory_items WHERE sku LIKE $1 OR name LIKE $1", [`${TAG}%`]);
  await pg.query("DELETE FROM record_deletion_logs WHERE reason LIKE $1", [`%${TAG}%`]);
  await pg.query("DELETE FROM transactions WHERE description LIKE $1", [`%${TAG}%`]);
  for (const t of ["user_sessions", "notifications", "user_business_access", "organization_members"]) {
    await pg.query(`DELETE FROM ${t} WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`ownerbell.%`]);
  }
  await pg.query("DELETE FROM users WHERE email LIKE $1", ["ownerbell.%"]);

  const bellRows = (uid, ref) =>
    pg
      .query("SELECT title FROM notifications WHERE user_id=$1 AND record_ref=$2 ORDER BY id DESC LIMIT 1", [uid, ref])
      .then((r) => r.rows[0] || null);

  /* ══ A · the Owner's OWN actions reach the Owner's bell ═══════════════════ */
  section("A · the Owner's own money activity reaches the Owner's bell");
  {
    await clearMoney(ownerId);
    const sale = await owner("/api/transactions", {
      method: "POST",
      body: JSON.stringify({
        businessId: BIZ1, type: "INCOME", category: "Direct Receipt",
        amountGhs: 101, paymentMethod: "CASH", description: `${TAG} owner-self sale`,
      }),
    });
    ok("A0 the Owner's own sale is booked", sale.status === 200 && sale.json?.success, sale.json?.error || "");
    if (sale.json?.item?.id) fx.txns.push(Number(sale.json.item.id));
    await sleep(1300);
    const row = await bellRows(ownerId, moneyRef(BIZ1));
    ok("A1 SALE — the Owner's bell carries a sale they recorded themselves", !!row, row ? `"${row.title}"` : "no row");
    ok("A2 …and it carries the real figure, not an amount-free stub",
      !!row && /101/.test(row.title || ""), row?.title || "");

    await clearMoney(ownerId);
    const exp = await owner("/api/transactions", {
      method: "POST",
      body: JSON.stringify({
        businessId: BIZ1, type: "EXPENSE", category: "General",
        amountGhs: 55, paymentMethod: "CASH", description: `${TAG} owner-self expense`,
      }),
    });
    ok("A3 the Owner's own expense is booked", exp.status === 200 && exp.json?.success, exp.json?.error || "");
    if (exp.json?.item?.id) fx.txns.push(Number(exp.json.item.id));
    await sleep(1300);
    const xrow = await bellRows(ownerId, moneyRef(BIZ1, "EXPENSE"));
    ok("A4 EXPENSE — the Owner's bell carries an expense they recorded themselves", !!xrow,
      xrow ? `"${xrow.title}"` : "no row");
  }

  /* ══ B · control — somebody else's activity ═══════════════════════════════ */
  section("B · CONTROL — other users' activity still reaches the Owner");
  {
    await clearMoney(ownerId);
    const r = await bm("/api/transactions", {
      method: "POST",
      body: JSON.stringify({
        businessId: BIZ1, type: "INCOME", category: "Direct Receipt",
        amountGhs: 202, paymentMethod: "CASH", description: `${TAG} manager sale`,
      }),
    });
    if (r.json?.item?.id) fx.txns.push(Number(r.json.item.id));
    await sleep(1300);
    const row = await bellRows(ownerId, moneyRef(BIZ1));
    ok("B1 a manager's sale reaches the Owner", !!row, row ? `"${row.title}"` : "no row");
  }

  /* ══ C · manage-delegation is workspace access, bell included ═════════════ */
  section("C · manage-delegated manager — money AND stock families");
  {
    const [pwRow] = (await pg.query("SELECT password_hash FROM users WHERE email=$1", [BM.email])).rows;
    const email = `ownerbell.delegated.${Date.now().toString(36)}@gomina360.test`;
    const ins = await pg.query(
      `INSERT INTO users (name, email, role, assigned_business_id, phone, password_hash,
                          can_record_sales, can_view_finance, can_manage_records, can_manage_stock,
                          business_manage_ids, primary_org_id)
       VALUES ($1, $2, 'GENERAL_MANAGER', 2, '+233550000011', $3,
               true, true, true, true, '[1]'::jsonb, 1) RETURNING id`,
      [`${TAG} Delegated Manager`, email, pwRow.password_hash],
    );
    const dmId = Number(ins.rows[0].id);
    fx.users.push(dmId);
    await pg.query("INSERT INTO organization_members (organization_id, user_id, role_in_org) VALUES (1, $1, 'MEMBER')", [dmId]);
    const dmLogin = await login(email, BM.pw);
    ok("C0 the delegated manager signs in", dmLogin.status === 200 && !!dmLogin.cookie, dmLogin.json?.error || "");
    const dm = apiFor(dmLogin.cookie);

    // The app already lets them open unit 1 — prove it, so the bell gap is
    // unambiguous rather than assumed.
    const scope = await dm("/api/init");
    const bizIds = (scope.json?.businesses || []).map((b) => Number(b.id));
    ok("C1 the unit is inside their My Workspace (manage ⇒ access)", bizIds.includes(BIZ1), `units ${bizIds.join(",")}`);

    await clearMoney(dmId);
    const r = await owner("/api/transactions", {
      method: "POST",
      body: JSON.stringify({
        businessId: BIZ1, type: "INCOME", category: "Direct Receipt",
        amountGhs: 303, paymentMethod: "CASH", description: `${TAG} delegated-unit sale`,
      }),
    });
    if (r.json?.item?.id) fx.txns.push(Number(r.json.item.id));
    await sleep(1300);
    const row = await bellRows(dmId, moneyRef(BIZ1));
    ok("C2 they are told about money on the unit they can open", !!row, row ? `"${row.title}"` : "no row");

    // The STOCK family is routed by a different producer (orderNotificationRecipients),
    // which is exactly where the manage-delegation blind spot used to hide.
    const bizRow = (await pg.query("SELECT code FROM businesses WHERE id=$1", [BIZ1])).rows[0];
    const [item] = (await pg.query(
      `INSERT INTO inventory_items (business_id, name, sku, category, unit, quantity, min_stock_threshold,
                                    status, selling_price_ghs, cost_price_ghs, branch_code)
       VALUES ($1, $2, $3, 'Probe', 'unit', 20, 5, 'IN_STOCK', 10, 6, $4) RETURNING id`,
      [BIZ1, `${TAG} Stock Item`, `${TAG}-SKU`, bizRow?.code || null],
    )).rows;
    fx.items.push(Number(item.id));
    const beforeMax = (
      await pg.query("SELECT COALESCE(MAX(id),0) m FROM notifications WHERE user_id=$1", [dmId])
    ).rows[0].m;
    const sale = await owner("/api/sales", {
      method: "POST",
      body: JSON.stringify({
        businessId: BIZ1, customerName: `${TAG} Buyer`, paymentMethod: "CASH",
        cartItems: [{ inventoryId: Number(item.id), quantity: 18, sellingPrice: 10 }],
      }),
    });
    ok("C3 a sale crosses the reorder point on that unit", sale.status === 200 && sale.json?.success,
      sale.json?.error || String(sale.status));
    if (sale.json?.transaction?.id) fx.txns.push(Number(sale.json.transaction.id));
    await sleep(1400);
    const stockRows = await pg.query(
      `SELECT title FROM notifications WHERE user_id=$1 AND id > $2 AND type IN ('STOCK_LOW','STOCK_OUT')`,
      [dmId, beforeMax],
    );
    ok("C4 …and the STOCK alert reaches them too", stockRows.rowCount > 0,
      stockRows.rows[0]?.title || "no row — the stock producer ignored manage-delegation");
  }

  /* ══ D · a platform Super Admin's workspace is platform-wide ══════════════ */
  section("D · Super Admin outside the tenant's membership");
  {
    const [pwRow] = (await pg.query("SELECT password_hash FROM users WHERE email=$1", [GM.email])).rows;
    const email = `ownerbell.superadmin.${Date.now().toString(36)}@gomina360.test`;
    const ins = await pg.query(
      `INSERT INTO users (name, email, role, assigned_business_id, phone, password_hash,
                          is_super_admin, can_view_finance, can_record_sales)
       VALUES ($1, $2, 'OWNER', NULL, '+233550000022', $3, true, true, true) RETURNING id`,
      [`${TAG} Platform Super Admin`, email, pwRow.password_hash],
    );
    const saId = Number(ins.rows[0].id);
    fx.users.push(saId);
    // deliberately NO organization_members row — a platform account
    const saLogin = await login(email, GM.pw);
    ok("D0 the platform Super Admin signs in", saLogin.status === 200 && !!saLogin.cookie, saLogin.json?.error || "");
    const sa = apiFor(saLogin.cookie);
    const scope = await sa("/api/init");
    const n = (scope.json?.businesses || []).length;
    ok("D1 their My Workspace is platform-wide", n >= 2, `${n} businesses visible`);

    await clearMoney(saId);
    const r = await owner("/api/transactions", {
      method: "POST",
      body: JSON.stringify({
        businessId: BIZ1, type: "INCOME", category: "Direct Receipt",
        amountGhs: 404, paymentMethod: "CASH", description: `${TAG} superadmin-visible sale`,
      }),
    });
    if (r.json?.item?.id) fx.txns.push(Number(r.json.item.id));
    await sleep(1300);
    const row = await bellRows(saId, moneyRef(BIZ1));
    ok("D2 their bell carries the activity", !!row, row ? `"${row.title}"` : "no row — platform-wide scope, silent bell");
  }

  /* ══ E · Action Center ═══════════════════════════════════════════════════ */
  section("E · Action Center reaches the Owner's workspace");
  {
    await pg.query("DELETE FROM notifications WHERE type LIKE 'TASK_%' AND record_ref LIKE $1 AND user_id=ANY($2::int[])", ["task:%", [ownerId, worker.id]]);
    const task = await owner("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: `${TAG} owner-raised action`, assignedUserId: worker.id,
        businessId: BIZ1, priority: "HIGH", dueDate: "2026-10-01",
      }),
    });
    ok("E0 the Owner raises an action on their own unit", task.status === 200 && task.json?.success,
      task.json?.error || String(task.status));
    const taskId = Number(task.json?.task?.id || task.json?.id);
    const taskNo = String(task.json?.task?.taskNumber || "");
    if (taskId) fx.tasks.push(taskId);
    await sleep(1300);

    const w = await pg.query(
      "SELECT title FROM notifications WHERE user_id=$1 AND record_ref=$2 AND type='TASK_ASSIGNED'", [worker.id, `task:${taskId}:raised`]);
    const o = await pg.query(
      "SELECT title FROM notifications WHERE user_id=$1 AND record_ref=$2 AND type='TASK_ASSIGNED'", [ownerId, `task:${taskId}:raised`]);
    ok("E1 the ASSIGNEE is told", w.rowCount === 1, w.rows[0]?.title || "no row");
    ok("E2 the OWNER whose workspace it is is told", o.rowCount === 1, o.rows[0]?.title || "no row");

    // …and the loop closes when it is finished.
    const wLogin = await login(
      (await pg.query("SELECT email FROM users WHERE id=$1", [worker.id])).rows[0].email,
      process.env.GOMINA_WORKER_PW || "GoMina@User10",
    );
    if (wLogin.status === 200) {
      const wApi = apiFor(wLogin.cookie);
      const done = await wApi("/api/tasks", {
        method: "PATCH",
        body: JSON.stringify({ id: taskId, status: "DONE" }),
      });
      ok("E3 the assignee can complete it", done.status === 200 && done.json?.success,
        done.json?.error || String(done.status));
      await sleep(1300);
      const d = await pg.query(
        "SELECT title FROM notifications WHERE user_id=$1 AND record_ref=$2 AND type='TASK_COMPLETED'", [ownerId, `task:${taskId}:done`]);
      ok("E4 the OWNER is told the work closed", d.rowCount === 1, d.rows[0]?.title || "no row");
    } else {
      ok("E3/E4 the assignee could sign in to complete it", false, `login ${wLogin.status}`);
    }
  }

  /* ══ E2 · every Action Center transition reaches its declared audience ════ */
  section("E2 · Action Center transitions — cancel, reopen, overdue, no-assignee");
  {
    const mk = async (extra) => {
      const r = await owner("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ businessId: BIZ1, priority: "HIGH", dueDate: "2026-12-01", ...extra }),
      });
      const t = r.json?.task || {};
      if (t.id) fx.tasks.push(Number(t.id));
      return { id: Number(t.id), no: String(t.taskNumber || "") };
    };
    const rowAt = (uid, ref) =>
      pg.query("SELECT id,title,type FROM notifications WHERE user_id=$1 AND record_ref=$2", [uid, ref]);

    // ── raised with NO explicit assignee (the assignee defaults to the creator).
    //    Two "don't tell them about their own work" subtractions used to cancel
    //    out here and produced ZERO bell rows for anybody.
    await pg.query("DELETE FROM notifications WHERE record_ref LIKE 'task:%' AND user_id=$1", [ownerId]);
    const selfTask = await mk({ title: `${TAG} self-assigned action` });
    await sleep(1300);
    const selfRows = await rowAt(ownerId, `task:${selfTask.id}:raised`);
    ok("E2a a task raised with no assignee still reaches the Owner", selfRows.rowCount === 1,
      selfRows.rows[0]?.title || "no row — the two self-exclusions cancelled out");

    // ── cancelled: the assignee must learn the work they hold was cancelled.
    const cancelTask = await mk({ title: `${TAG} cancel-me`, assignedUserId: worker.id });
    await sleep(900);
    await pg.query("DELETE FROM notifications WHERE record_ref LIKE $1", [`task:${cancelTask.id}:%`]);
    const cw = await owner("/api/tasks", { method: "PATCH", body: JSON.stringify({ id: cancelTask.id, status: "CANCELLED" }) });
    ok("E2b the action can be cancelled", cw.status === 200 && cw.json?.success, `status=${cw.status}`);
    await sleep(1300);
    const cAssignee = await rowAt(worker.id, `task:${cancelTask.id}:cancelled`);
    const cOwner = await rowAt(ownerId, `task:${cancelTask.id}:cancelled`);
    ok("E2c the ASSIGNEE is told it was cancelled", cAssignee.rowCount === 1,
      cAssignee.rows[0]?.title || "no row");
    ok("E2d the OWNER is told it was cancelled", cOwner.rowCount === 1, cOwner.rows[0]?.title || "no row");

    // ── reopened: work silently coming back was the other silent transition.
    const reopenTask = await mk({ title: `${TAG} reopen-me`, assignedUserId: worker.id });
    await owner("/api/tasks", { method: "PATCH", body: JSON.stringify({ id: reopenTask.id, status: "DONE" }) });
    await sleep(900);
    await pg.query("DELETE FROM notifications WHERE record_ref LIKE $1", [`task:${reopenTask.id}:%`]);
    const ro = await owner("/api/tasks", { method: "PATCH", body: JSON.stringify({ id: reopenTask.id, status: "OPEN" }) });
    ok("E2e a completed action can be reopened", ro.status === 200 && ro.json?.success, `status=${ro.status}`);
    await sleep(1300);
    const rAssignee = await rowAt(worker.id, `task:${reopenTask.id}:reopened`);
    const rOwner = await rowAt(ownerId, `task:${reopenTask.id}:reopened`);
    ok("E2f the ASSIGNEE is told it is back on the plate", rAssignee.rowCount === 1,
      rAssignee.rows[0]?.title || "no row");
    ok("E2g the OWNER is told it is back on the plate", rOwner.rowCount === 1, rOwner.rows[0]?.title || "no row");

    // ── overdue: one EVENT, one recordRef. The old code gave the assignee
    //    `task-overdue:<id>:<step>` and every other watcher `…:watch`, so an
    //    Owner who assigned an overdue action to themselves got two rows.
    const od = await mk({ title: `${TAG} self-overdue`, assignedUserId: ownerId, priority: "CRITICAL", dueDate: "2000-01-01" });
    await pg.query("DELETE FROM notifications WHERE record_ref LIKE $1", [`task:${od.id}:%`]);
    await owner("/api/cron/daily?force=1");
    await sleep(1800);
    const odRows = await pg.query(
      "SELECT id,record_ref FROM notifications WHERE user_id=$1 AND type='TASK_OVERDUE' AND record_ref LIKE $2",
      [ownerId, `task:${od.id}:overdue:%`]);
    ok("E2h the Owner is told about their OWN overdue action", odRows.rowCount >= 1, `${odRows.rowCount} row(s)`);
    ok("E2i …exactly once (no :watch twin for the same event)", odRows.rowCount === 1,
      odRows.rows.map((r) => r.record_ref).join(" | "));

    // ── deep link: every task row must carry the task id so the bell can focus it.
    const link = await pg.query(
      "SELECT count(*)::int c FROM notifications WHERE record_ref LIKE $1 AND record_id IS NULL", [`task:${od.id}:%`]);
    ok("E2j task rows carry recordId so the bell can focus the action", link.rows[0].c === 0,
      `${link.rows[0].c} row(s) without a recordId`);
  }

  /* ══ F · the boundary — non-principals are still not pinged ══════════════ */
  section("F · non-principals are still spared their own actions");
  {
    const [pwRow] = (await pg.query("SELECT password_hash FROM users WHERE email=$1", [BM.email])).rows;
    const email = `ownerbell.staff.${Date.now().toString(36)}@gomina360.test`;
    const ins = await pg.query(
      `INSERT INTO users (name, email, role, assigned_business_id, phone, password_hash, can_record_sales)
       VALUES ($1, $2, 'BRANCH_MANAGER', $3, '+233550000033', $4, true) RETURNING id`,
      [`${TAG} Staff Manager`, email, BIZ1, pwRow.password_hash],
    );
    const stId = Number(ins.rows[0].id);
    fx.users.push(stId);
    await pg.query("INSERT INTO organization_members (organization_id, user_id, role_in_org) VALUES (1, $1, 'MEMBER')", [stId]);
    await pg.query("UPDATE users SET can_view_finance = true WHERE id=$1", [stId]);
    const sLogin = await login(email, BM.pw);
    const sApi = apiFor(sLogin.cookie);
    await clearMoney(stId);
    const r = await sApi("/api/transactions", {
      method: "POST",
      body: JSON.stringify({
        businessId: BIZ1, type: "INCOME", category: "Direct Receipt",
        amountGhs: 909, paymentMethod: "CASH", description: `${TAG} staff-self sale`,
      }),
    });
    ok("F0 the staff manager books their own sale", r.status === 200 && r.json?.success, r.json?.error || String(r.status));
    if (r.json?.item?.id) fx.txns.push(Number(r.json.item.id));
    await sleep(1300);
    const row = await bellRows(stId, moneyRef(BIZ1));
    ok("F1 …but gets NO self-notification (the bell is not an echo)", !row, row ? `unexpected "${row.title}"` : "silent, as intended");
    // …while the Owner, who did not do it, still hears about it.
    const ownerRow = await bellRows(ownerId, moneyRef(BIZ1));
    ok("F2 the Owner is still told about it", !!ownerRow, ownerRow ? `"${ownerRow.title}"` : "no row");
  }

  /* ══ G · the audit cap is never silent ═══════════════════════════════════ */
  section("G · a capped Owner is told what they were NOT told");
  {
    // AUDIT_EVENT is rate-capped per recipient per 24 h so a bulk delete cannot
    // storm the bell. Silently dropping the overflow would mean an Owner can
    // lose sight of a deletion with no trace in the bell at all — so the cap
    // must summarise what it held back rather than swallow it.
    const CAP = 12;
    await pg.query("DELETE FROM notifications WHERE user_id=$1 AND type='AUDIT_EVENT'", [ownerId]);
    const FIRE = CAP + 3;
    const codes = [];
    for (let i = 0; i < FIRE; i++) {
      const mk = await owner("/api/transactions", {
        method: "POST",
        body: JSON.stringify({
          businessId: BIZ1, type: "INCOME", category: "Direct Receipt",
          amountGhs: 7, paymentMethod: "CASH", description: `${TAG} cap-${i}`,
        }),
      });
      const tid = Number(mk.json?.transaction?.id);
      if (tid) { fx.txns.push(tid); codes.push(tid); }
    }
    for (const tid of codes) {
      await owner("/api/transactions", {
        method: "DELETE",
        body: JSON.stringify({ id: tid, reason: `${TAG} cap probe deletion` }),
      });
    }
    await sleep(1600);
    const detail = await pg.query(
      "SELECT count(*)::int c FROM notifications WHERE user_id=$1 AND type='AUDIT_EVENT' AND record_ref LIKE 'audit-event:DELETE:%'",
      [ownerId],
    );
    const capRows = await pg.query(
      "SELECT body FROM notifications WHERE user_id=$1 AND type='AUDIT_EVENT' AND record_ref LIKE 'audit-event:cap:%'",
      [ownerId],
    );
    ok(`G1 the cap holds the Owner to ${CAP} itemised rows`, detail.rows[0].c === CAP,
      `${detail.rows[0].c} itemised of ${FIRE} fired`);
    ok("G2 the held-back rows are SUMMARISED, not silently dropped",
      capRows.rowCount === 1 && /further audited changes were not itemised/.test(String(capRows.rows[0]?.body || "")),
      capRows.rows[0]?.body || "no summary row — the cap swallowed them silently");
    const held = Number(String(capRows.rows[0]?.body || "").split(" ")[0]) || 0;
    ok("G3 the summary accounts for exactly what was held back", held === FIRE - CAP, `held=${held}, expected=${FIRE - CAP}`);
    await pg.query("DELETE FROM notifications WHERE user_id=$1 AND type='AUDIT_EVENT'", [ownerId]);
  }

  /* ══ E3 · transport reaches the canonical workspace ══════════════════════ */
  section("E3 · transport reaches the whole workspace, including platform Super Admins");
  {
    // F-01: notifyTransport used to derive its audience from organization
    // membership, so a platform Super Admin outside the tenant — whose My
    // Workspace is every business — was blind to geofence / unauthorized-movement
    // events, as were the unit's own workers. The probe is self-contained: it
    // mints its own Super Admin, asserts, and removes everything it created.
    const { execFileSync } = await import("node:child_process");
    let out = "";
    let code = 1;
    try {
      out = execFileSync("npx", ["tsx", "--tsconfig", "tsconfig.json", "dev-tooling/probe-transport-audience.mts"],
        { cwd: "/home/user/gomina360_app_V1.1", encoding: "utf8", timeout: 240000,
          env: { ...process.env, DATABASE_URL: PG_URL } });
      code = 0;
    } catch (e) {
      out = String(e.stdout || "") + String(e.message || "");
    }
    const line = String(out).split("\n").find((l) => l.startsWith("inserted=")) || "";
    ok("E3a a platform Super Admin outside the tenant IS told about a transport violation",
      code === 0 && /RESULT: PASS/.test(String(out)),
      line.trim() || String(out).split("\n").slice(-2).join(" ").slice(0, 160));
  }

  /* ══ H · isolation ═══════════════════════════════════════════════════════ */
  section("H · tenant isolation is intact");
  {
    const leaks = await pg.query(`
      SELECT count(*)::int c FROM notifications n
        JOIN businesses b ON b.id = n.business_id
        JOIN organizations o ON o.id = b.owner_id
        JOIN users u ON u.id = n.user_id
       WHERE NOT (u.is_super_admin = true
                  OR o.owner_user_id = n.user_id
                  OR EXISTS (SELECT 1 FROM organization_members m
                              WHERE m.user_id = n.user_id AND m.organization_id = b.owner_id))`);
    ok("H1 no bell row was delivered outside the business's organization", leaks.rows[0].c === 0,
      `${leaks.rows[0].c} unauthorised row(s)`);

    const dupes = await pg.query(
      "SELECT user_id, type, record_ref, count(*)::int c FROM notifications WHERE record_ref LIKE 'money-day:%' GROUP BY 1,2,3 HAVING count(*) > 1");
    ok("H2 still exactly one roll-up row per (user, type, day, unit)", dupes.rowCount === 0,
      dupes.rows.map((r) => `${r.user_id}/${r.type}/${r.record_ref}×${r.c}`).join(", "));
  }

  /* ══ cleanup ═════════════════════════════════════════════════════════════ */
  section("Z · Cleanup");
  for (const id of fx.tasks) {
    await pg.query("DELETE FROM notifications WHERE record_ref LIKE $1", [`task:${id}:%`]).catch(() => {});
    await pg.query("DELETE FROM action_tasks WHERE id=$1", [id]).catch(() => {});
  }
  await pg.query("DELETE FROM notifications WHERE title LIKE $1", [`%${TAG}%`]).catch(() => {});
  await pg.query("DELETE FROM notifications WHERE record_ref LIKE $1", [`%${TAG}%`]).catch(() => {});
  for (const id of fx.txns) await pg.query("DELETE FROM transactions WHERE id=$1", [id]).catch(() => {});
  await pg.query("DELETE FROM transactions WHERE description LIKE $1", [`%${TAG}%`]).catch(() => {});
  await pg.query("DELETE FROM record_deletion_logs WHERE reason LIKE $1 OR record_label LIKE $1", [`%${TAG}%`]).catch(() => {});
  for (const id of fx.items) {
    await pg.query("DELETE FROM inventory_items WHERE id=$1", [id]).catch(() => {});
    await pg.query("DELETE FROM notifications WHERE record_id=$1 AND record_type='inventory_items'", [id]).catch(() => {});
  }
  for (const uid of fx.users) {
    for (const t of ["user_sessions", "notifications", "user_business_access", "organization_members"]) {
      await pg.query(`DELETE FROM ${t} WHERE user_id=$1`, [uid]).catch(() => {});
    }
    await pg.query("DELETE FROM users WHERE id=$1", [uid]).catch(() => {});
  }
  await pg.query("DELETE FROM notifications WHERE record_ref LIKE 'money-day:%' AND user_id=$1", [ownerId]);
  const left = await pg.query("SELECT count(*)::int c FROM transactions WHERE description LIKE $1", [`%${TAG}%`]);
  ok("Z1 every probe ledger row is gone", left.rows[0].c === 0, `${left.rows[0].c} left`);
  const leftUsers = await pg.query("SELECT count(*)::int c FROM users WHERE email LIKE $1", [`%${TAG}%`]);
  ok("Z2 every probe user is gone", leftUsers.rows[0].c === 0, `${leftUsers.rows[0].c} left`);
  const leftLogs = await pg.query("SELECT count(*)::int c FROM record_deletion_logs WHERE reason LIKE $1", [`%${TAG}%`]);
  ok("Z3 no deletion-log rows left behind", leftLogs.rows[0].c === 0, `${leftLogs.rows[0].c} left`);
  const leftAudit = await pg.query("SELECT count(*)::int c FROM notifications WHERE record_ref LIKE 'audit-event:cap:%'");
  ok("Z4 no audit-cap summary rows left behind", leftAudit.rows[0].c === 0, `${leftAudit.rows[0].c} left`);

  await pg.end();
  console.log(`\n${pass} pass / ${fail} fail`);
  if (fail) console.log("FAILED:\n - " + failures.join("\n - "));
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("suite error:", e);
  try { await pg.end(); } catch {}
  process.exit(1);
});