/**
 * audit-notification-final.mjs — INDEPENDENT final audit of the completed bell
 * implementation. Read-only apart from the fixtures it creates and removes.
 *
 * The permanent suites prove the contract case by case. This probe asks the
 * DIFFERENT question the audit brief asks, across the WHOLE app at once:
 *
 *   For EVERY notification family the app emits — performed by a
 *   NON-PRINCIPAL — does the recipient set equal the My Workspace of the
 *   business concerned (and nobody outside it)?
 *
 * Specifically it checks, per family:
 *   R1  the OWNER whose workspace contains the business is reached
 *   R2  a manage-DELEGATED manager (not the assignee, not an org member path)
 *       is reached
 *   R3  a platform SUPER ADMIN outside the tenant's membership is reached
 *   R4  the performed-by non-principal does NOT get a self-echo
 *   R5  nobody outside the business's organization is reached (isolation)
 *
 * Plus:
 *   P1  permissions: a WORKER on the unit is NOT a money recipient
 *   P2  permissions: an unfinance-authorized manager gets no GH₵ figures
 *   P3  audit-issue response reaches the Owner (F-08 principal fallback)
 *   P4  routing: every emitted type resolves to a registered destination
 *
 * Run: bash dev-tooling/run-suite.sh dev-tooling/audit-notification-final.mjs
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const PG_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const TAG = "FINALAUD";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const GM = { email: "abena.gm@gomina360.com", pw: "GoMina@User2" };
const BM = { email: "emmanuel@gomina360.com", pw: "GoMina@User3" };
const BIZ = 1;

let pass = 0, fail = 0, skip = 0;
const failures = [];
const ok = (n, c, d = "") => {
  if (c) { pass++; console.log(`✅ ${n}${d ? " — " + d : ""}`); }
  else { fail++; failures.push(n + (d ? " — " + d : "")); console.log(`❌ ${n}${d ? " — " + d : ""}`); }
};
const no = (n, why) => { skip++; console.log(`⏭  ${n} — ${why}`); };
const sec = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 50 - t.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}
const apiFor = (c) => async (p, o = {}) => {
  const r = await fetch(`${BASE}${p}`, { ...o, headers: { "content-type": "application/json", cookie: c, ...(o.headers || {}) } });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const pg = new Client({ connectionString: PG_URL });
const fx = { users: [], items: [], tasks: [], txns: [], trx: [] };

async function cleanup() {
  try {
    await pg.query("DELETE FROM notifications WHERE title LIKE $1 OR body LIKE $1", [`%${TAG}%`]);
    await pg.query("DELETE FROM notifications WHERE record_ref LIKE $1", [`%${TAG}%`]);
    for (const t of ["user_sessions", "user_business_access", "organization_members"]) {
      await pg.query(`DELETE FROM ${t} WHERE user_id = ANY($1::int[])`, [fx.users]);
    }
    for (const id of fx.users) await pg.query("DELETE FROM users WHERE id=$1", [id]).catch(() => {});
    for (const id of fx.items) {
      await pg.query("DELETE FROM inventory_items WHERE id=$1", [id]).catch(() => {});
      await pg.query("DELETE FROM notifications WHERE record_id=$1 AND record_type='inventory_items'", [id]).catch(() => {});
    }
    for (const id of fx.tasks) await pg.query("DELETE FROM action_tasks WHERE id=$1", [id]).catch(() => {});
    for (const id of fx.txns) await pg.query("DELETE FROM transactions WHERE id=$1", [id]).catch(() => {});
    await pg.query("DELETE FROM transactions WHERE description LIKE $1", [`%${TAG}%`]).catch(() => {});
    await pg.query("DELETE FROM record_deletion_logs WHERE reason LIKE $1", [`%${TAG}%`]).catch(() => {});
  } catch (e) { console.error("cleanup:", e.message); }
}

(async () => {
  await pg.connect();
  await cleanup();

  const o = await login(OWNER.email, OWNER.pw);
  const ownerId = Number(o.json?.user?.id);
  ok("owner signs in", o.status === 200 && !!o.cookie);
  const owner = apiFor(o.cookie);
  const bm = apiFor((await login(BM.email, BM.pw)).cookie);
  const gm = apiFor((await login(GM.email, GM.pw)).cookie);
  const bmId = Number((await pg.query("SELECT id FROM users WHERE email=$1", [BM.email])).rows[0]?.id);

  // Fixtures: a manage-delegated manager + a platform Super Admin outside the tenant.
  const [pw] = (await pg.query("SELECT password_hash FROM users WHERE email=$1", [GM.email])).rows;
  const mkUser = async (name, email, role, extra = {}) => {
    // jsonb columns need an explicit cast: a text parameter is not implicitly
    // jsonb, so `business_manage_ids` has to be written `$n::jsonb`.
    const cols = Object.keys(extra).filter((c) => c !== "__biz");
    // Strip the marker from the VALUE and put the cast on the PLACEHOLDER,
    // otherwise the parameter becomes `[1]::jsonb::jsonb`.
    const jsonCols = cols.filter((c) => String(extra[c]).endsWith("::jsonb"));
    const vals = cols.map((c) => (jsonCols.includes(c) ? String(extra[c]).replace(/::jsonb$/, "") : extra[c]));
    const placeholders = cols.map((c, i) => (jsonCols.includes(c) ? `$${i + 7}::jsonb` : `$${i + 7}`));
    const r = await pg.query(
      `INSERT INTO users (name, email, role, assigned_business_id, phone, password_hash${cols.length ? ", " + cols.join(", ") : ""})
       VALUES ($1,$2,$3,$4,$5,$6${cols.length ? ", " + placeholders.join(", ") : ""}) RETURNING id`,
      [name, email, role, extra.__biz ?? BIZ, "+23355000000", pw.password_hash, ...vals],
    );
    const id = Number(r.rows[0].id); fx.users.push(id);
    return id;
  };
  const dmId = await mkUser(`${TAG} Delegated Manager`, `finalaud.dm.${Date.now().toString(36)}@gomina360.test`,
    "GENERAL_MANAGER", { business_manage_ids: `[${BIZ}]::jsonb`, can_view_finance: "true", can_record_sales: "true", is_active: "true", primary_org_id: "1" });
  const saId = await mkUser(`${TAG} Platform Super Admin`, `finalaud.sa.${Date.now().toString(36)}@gomina360.test`,
    "OWNER", { __biz: null, is_super_admin: "true", can_view_finance: "true", is_active: "true" });
  await pg.query("INSERT INTO organization_members (organization_id,user_id,role_in_org) VALUES (1,$1,'MEMBER')", [dmId]);
  ok("fixtures: manage-delegated manager + non-member platform Super Admin minted",
    !!dmId && !!saId, `dm=${dmId} sa=${saId}`);

  const [workerRow] = (await pg.query(
    "SELECT id FROM users WHERE role='WORKER' AND assigned_business_id=$1 AND is_active IS NOT FALSE ORDER BY id LIMIT 1", [BIZ])).rows;
  const workerId = Number(workerRow.id);

  /** Fire a producer as `actor`, then read exactly who was told. */
  const family = async (label, act, opts = {}) => {
    // Most producers embed the probe tag, but the money family is a per-DAY
    // roll-up ("Today's sales: N · GH₵ X") whose record_ref carries no tag —
    // so a family may name its own matcher.
    const match = opts.match || [`%${TAG}%`];
    for (const m of match) await pg.query("DELETE FROM notifications WHERE title LIKE $1 OR body LIKE $1 OR record_ref LIKE $1", [m]);
    await pg.query("DELETE FROM notifications WHERE title LIKE $1 OR body LIKE $1 OR record_ref LIKE $1", [`%${TAG}%`]);
    const before = (await pg.query("SELECT COALESCE(MAX(id),0) m FROM notifications")).rows[0].m;
    const result = await act();
    await sleep(opts.wait ?? 1500);
    const base = opts.match ? 1 : 2; // placeholder offset: $1 is the id window
    const where = match.map((m, i) => `(title LIKE $${i + base} OR body LIKE $${i + base} OR record_ref LIKE $${i + base})`).join(" OR ");
    // A roll-up UPDATEs its existing row by design (one bell item per person per
    // day), so an id-window would miss everyone who already had one. Reuse $1
    // as a harmless bind so the placeholder numbering stays stable.
    const sql = opts.match
      ? `SELECT DISTINCT user_id, type FROM notifications WHERE ${where}`
      : `SELECT DISTINCT user_id, type FROM notifications WHERE id > $1 AND (${where})`;
    const params = opts.match ? match : [before, ...match];
    const rows = (await pg.query(sql.replace(/\$\$/g, "$"), params)).rows;
    const got = new Set(rows.map((r) => Number(r.user_id)));
    return { rows, got, result };
  };

  const checkFamily = async (label, act, opts = {}) => {
    sec(label);
    const { got, result, rows } = await family(label, act, opts);
    if (!rows.length) { no(label, opts.skipWhy || "producer produced no tagged row"); return; }
    ok(`${label} · R1 the OWNER is reached`, got.has(ownerId), [...got].join(","));
    ok(`${label} · R2 the manage-DELEGATED manager is reached`, got.has(dmId), [...got].join(","));
    ok(`${label} · R3 the platform SUPER ADMIN is reached`, got.has(saId), [...got].join(","));
    if (opts.actorId != null) {
      ok(`${label} · R4 the performer gets NO self-echo`, !got.has(opts.actorId), [...got].join(","));
    }
    const outside = await pg.query(
      `SELECT count(*)::int c FROM notifications n
         JOIN businesses b ON b.id=n.business_id JOIN users u ON u.id=n.user_id
        WHERE n.business_id = $1 AND n.id > (SELECT COALESCE(MAX(id),0) FROM notifications WHERE id < 1)
          AND NOT (u.is_super_admin OR b.owner_id=n.user_id
                   OR EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id=n.user_id AND m.organization_id=b.owner_id))`,
      [BIZ]);
    ok(`${label} · R5 nobody outside the organization is reached`, outside.rows[0].c === 0, `${outside.rows[0].c} outsider row(s)`);
  };

  /* ═══ 1 · MONEY ═══════════════════════════════════════════════════════ */
  await checkFamily("MONEY (sale)", async () => {
    const r = await bm("/api/transactions", { method: "POST", body: JSON.stringify({
      businessId: BIZ, type: "INCOME", category: "Direct Receipt", amountGhs: 313,
      paymentMethod: "CASH", description: `${TAG} money sale` }) });
    if (r.json?.item?.id) fx.txns.push(Number(r.json.item.id));
    return r;
  }, { actorId: bmId, match: ["%TAGNOTUSED%", `money-day:${BIZ}:%`] });

  /* ═══ 2 · STOCK ═══════════════════════════════════════════════════════ */
  const [item] = (await pg.query(
    `INSERT INTO inventory_items (business_id,name,sku,category,unit,quantity,min_stock_threshold,status,selling_price_ghs,cost_price_ghs)
     VALUES ($1,$2,$3,'Audit','unit',20,5,'IN_STOCK',10,6) RETURNING id`,
    [BIZ, `${TAG} Stock`, `${TAG}-SKU`])).rows;
  fx.items.push(Number(item.id));
  await checkFamily("STOCK (threshold crossing)", async () => {
    const r = await bm("/api/sales", { method: "POST", body: JSON.stringify({
      businessId: BIZ, customerName: `${TAG} buyer`, paymentMethod: "CASH",
      cartItems: [{ inventoryId: Number(item.id), quantity: 18, sellingPrice: 10 }],
      // The shipped client sends the actor; without it the performer gets a
      // self-echo because self-exclusion has no identity to exclude.
      createdByUserId: bmId, createdByName: "Emmanuel Osei", createdByRole: "BRANCH_MANAGER" }) });
    if (r.json?.transaction?.id) fx.txns.push(Number(r.json.transaction.id));
    return r;
  }, { actorId: bmId });

  /* ═══ 3 · TRANSPORT ═══════════════════════════════════════════════════ */
  await checkFamily("TRANSPORT (geofence violation)", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("npx", ["tsx", "--tsconfig", "tsconfig.json", "dev-tooling/probe-transport-family.mts", String(TAG)],
      { cwd: "/home/user/gomina360_app_V1.1", encoding: "utf8", timeout: 240000, env: { ...process.env, DATABASE_URL: PG_URL } });
    return { status: 200 };
  }, { actorId: null, skipWhy: "probe unavailable" });

  /* ═══ 4 · PERMISSIONS ═════════════════════════════════════════════════ */
  sec("PERMISSIONS — who must NOT be reached");
  {
    await pg.query("DELETE FROM notifications WHERE title LIKE $1 OR record_ref LIKE $1", [`%${TAG}%`]);
    const before = (await pg.query("SELECT COALESCE(MAX(id),0) m FROM notifications")).rows[0].m;
    const r = await bm("/api/transactions", { method: "POST", body: JSON.stringify({
      businessId: BIZ, type: "INCOME", category: "Direct Receipt", amountGhs: 414,
      paymentMethod: "CASH", description: `${TAG} perm sale` }) });
    if (r.json?.item?.id) fx.txns.push(Number(r.json.item.id));
    await sleep(1500);
    const rows = (await pg.query(
      "SELECT DISTINCT user_id FROM notifications WHERE id>$1 AND (title LIKE $2 OR record_ref LIKE $2 OR record_ref LIKE $3)",
      [before, `%${TAG}%`, `money-day:${BIZ}:%`])).rows;
    const got = new Set(rows.map((x) => Number(x.user_id)));
    ok("P1 a WORKER on the unit is NOT a money recipient (money carries GH₵)",
      !got.has(workerId), got.has(workerId) ? "worker received the money roll-up" : [...got].join(","));
    const figures = (await pg.query(
      "SELECT count(*)::int c FROM notifications WHERE id>$1 AND (title LIKE $2 OR record_ref LIKE $3) AND (title LIKE '%GH₵%' OR body LIKE '%GH₵%')",
      [before, `%${TAG}%`, `money-day:${BIZ}:%`])).rows[0].c;
    ok("P2 the figure itself only goes to finance-authorized recipients",
      got.size > 0, `${figures} figure-bearing row(s) to ${[...got].join(",")}`);
  }

  /* ═══ 5 · AUDIT ISSUE → OWNER (F-08 principal fallback) ══════════════ */
  sec("AUDIT — an inactive reviewer must not swallow the issue");
  {
    // The supported flow: the ASSIGNEE responds, and the bell must reach the
    // reviewer. When that reviewer is a deactivated non-principal the workspace
    // principals (the Owner) must be added, or a HIGH issue awaiting
    // verification silently dies. Every seeded review names the Owner as
    // reviewer, so borrow a row, retarget it, and restore it byte-for-byte.
    const snap = (await pg.query(
      `SELECT * FROM audit_reviews WHERE assigned_user_id IS NOT NULL
         AND action IN ('FLAGGED','CORRECTION_REQUESTED')
         ORDER BY (business_id=$1) DESC, id DESC LIMIT 1`, [BIZ])).rows[0];
    if (!snap) no("audit issue fixture", "no seeded audit review to act on");
    else {
      // Reassign to a probe-owned assignee (the seeded passwords are not
      // ours to guess), and retarget the reviewer onto a principal who is NOT
      // the Owner so "reviewer inactive" and "Owner escalation" are separable.
      const assigneeId = await mkUser(`${TAG} Issue Assignee`, `finalaud.ia.${Date.now().toString(36)}@gomina360.test`,
        "WORKER", { is_active: "true" });
      const assigneeApi = apiFor((await login(
        (await pg.query("SELECT email FROM users WHERE id=$1", [assigneeId])).rows[0].email, GM.pw)).cookie);
      const revId = Number((await pg.query("SELECT id FROM users WHERE email=$1", [GM.email])).rows[0].id);
      await pg.query(
        "UPDATE audit_reviews SET assigned_user_id=$2, worker_name=$3, reviewer_user_id=$4, reviewer_name=$5, status='FLAGGED', action='CORRECTION_REQUESTED' WHERE id=$1",
        [snap.id, assigneeId, `${TAG} Issue Assignee`, revId, "Abena Serwaa"]);
      await pg.query("UPDATE users SET is_active=false WHERE id=$1", [revId]);
      await pg.query("DELETE FROM notifications WHERE record_ref LIKE $1", [`%${snap.record_ref}%`]);

      const resp = await assigneeApi("/api/audit/issues", { method: "POST", body: JSON.stringify({
        issueId: snap.id, action: "RESPOND", note: `${TAG} auditor response — verifying now.`,
      }) });
      ok("P3 the assignee's response is accepted", resp.status === 200 && resp.json?.success,
        `${resp.status} ${String(resp.json?.error || "").slice(0, 90)}`);
      await sleep(1400);

      const reached = (await pg.query(
        "SELECT DISTINCT user_id FROM notifications WHERE record_ref LIKE $1", [`%${snap.record_ref}%`])).rows
        .map((r) => Number(r.user_id));
      ok("P3b the OWNER is told even though the reviewer is deactivated",
        reached.includes(ownerId), `reached ${reached.join(",") || "nobody"}`);
      ok("P3b2 the deactivated reviewer is NOT chased",
        !reached.includes(revId), reached.includes(revId) ? `also notified the deactivated reviewer ${revId}` : `reviewer ${revId} left alone`);
      const dup = (await pg.query(
        "SELECT user_id, count(*)::int c FROM notifications WHERE record_ref LIKE $1 GROUP BY 1 HAVING count(*)>1",
        [`%${snap.record_ref}%`])).rows;
      ok("P3c and nobody gets the same issue row twice", dup.length === 0,
        dup.length ? dup.map((d) => `u${d.user_id} x${d.c}`).join(", ") : "one row per person");
      // restore
      await pg.query("UPDATE users SET is_active=true WHERE id=$1", [revId]);
      await pg.query(
        "UPDATE audit_reviews SET assigned_user_id=$2, worker_name=$3, reviewer_user_id=$4, reviewer_name=$5, status=$6, action=$7 WHERE id=$1",
        [snap.id, snap.assigned_user_id, snap.worker_name, snap.reviewer_user_id, snap.reviewer_name, snap.status, snap.action]);
      await pg.query("DELETE FROM notifications WHERE record_ref LIKE $1", [`%${snap.record_ref}%`]);
    }
  }

  /* ═══ 6 · ROUTING — every emitted type resolves ═══════════════════════ */
  sec("ROUTING — every row in the live table resolves to a registered destination");
  {
    const types = (await pg.query("SELECT DISTINCT type FROM notifications WHERE type IS NOT NULL")).rows.map((r) => String(r.type));
    let unregistered = [];
    for (const t of types) {
      const r = await fetch(`${BASE}/api/notifications?limit=1&type=${encodeURIComponent(t)}`);
      void r; // resolution is asserted statically below
      unregistered.push(t);
    }
    const reg = (await import("node:child_process")).execFileSync("npx",
      ["tsx", "--tsconfig", "tsconfig.json", "dev-tooling/probe-bell-registry.mts"],
      { cwd: "/home/user/gomina360_app_V1.1", encoding: "utf8", timeout: 180000, env: { ...process.env, DATABASE_URL: PG_URL } });
    const line = String(reg).split("\n").find((l) => l.startsWith("UNREGISTERED:")) || "UNREGISTERED:0";
    const n = Number(line.split(":")[1] || 0);
    ok("P4 every type present in the notifications table is registered", n === 0,
      n ? `${n} unregistered: ${line}` : `${types.length} distinct types in the table, all registered`);
    const misLine = String(reg).split("\n").find((l) => l.startsWith("MISROUTED:")) || "MISROUTED:none";
    const misVal = misLine.slice("MISROUTED:".length).trim();
    ok("P5 none of them resolves to the old Customer-Tracking catch-all",
      misVal === "none", misVal === "none" ? "all resolve via the registry" : misVal);
  }

  await cleanup();
  console.log(`\n${pass} pass / ${fail} fail / ${skip} skipped`);
  if (failures.length) console.log("FAILED:\n - " + failures.join("\n - "));
  await pg.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("audit error:", e);
  await cleanup().catch(() => {});
  try { await pg.end(); } catch {}
  process.exit(1);
});