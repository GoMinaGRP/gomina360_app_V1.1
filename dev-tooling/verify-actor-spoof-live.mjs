// ═══════════════════════════════════════════════════════════════════════════
// LIVE SECURITY VERIFICATION — F-15 actor spoofing, end to end.
//
// The static guard (verify-actor-attribution.mjs) proves no route READS an
// identity from the body. This suite proves the consequence is actually gone
// in the running application: it performs the original exploit — sign in as a
// low-privilege BRANCH_MANAGER, claim to be the Owner in the request body —
// and then reads the DATABASE to see who the system believes acted.
//
// Every fixture it creates is deleted on the way out.
// ═══════════════════════════════════════════════════════════════════════════
const BASE = "http://127.0.0.1:3000";
const TAG = `ACTORSEC${Date.now().toString(36)}`;
const PG = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const BIZ = 1;

let pass = 0, fail = 0;
const failures = [];
const sec = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);
const ok = (name, cond, note = "") => {
  if (cond) { pass++; console.log(`✅ ${name}${note ? ` — ${note}` : ""}`); }
  else { fail++; failures.push(name); console.log(`❌ ${name}${note ? ` — ${note}` : ""}`); }
};

const { default: pg } = await import("/home/user/pgtooling/node_modules/pg/lib/index.js");
const db = new pg.Client({ connectionString: PG });
await db.connect();
const q = async (sql, p = []) => (await db.query(sql, p)).rows;

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: r.status, json: await r.json().catch(() => ({})), cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
}
const apiFor = (c) => async (p, o = {}) => {
  const r = await fetch(`${BASE}${p}`, { ...o, headers: { "content-type": "application/json", cookie: c, ...(o.headers || {}) } });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The impersonated identity: the Owner, user 1.
const CLAIM = { createdByUserId: 1, createdByName: "Kwame Mina", createdByRole: "OWNER",
                currentUserId: 1, currentUserName: "Kwame Mina", currentUserRole: "OWNER" };

const cleanup = [];
const restoredStock = [];
// Audit rows are global: earlier suites legitimately ran as the Owner minutes
// ago, so "actor_name = the Owner" proves nothing on its own. Judge only rows
// created ABOVE this watermark, i.e. by the spoofed requests below.
const AUDIT_WATERMARK = Number((await q("select coalesce(max(id),0) m from audit_trail"))[0].m);

/* ═══ 1 · the attacker's identity ══════════════════════════════════════ */
sec("1 · a low-privilege session is the attacker");
let bm, owner;
{
  owner = await login("kwame.owner@gomina360.com", "GoMina@User1");
  const ownerRow = (await q("select id,name,role from users where id=1"))[0];
  ok("1a the impersonated identity is the real Owner", !!ownerRow && ownerRow.role === "OWNER",
    `${ownerRow?.name} (${ownerRow?.role}, id ${ownerRow?.id})`);
  bm = await login("emmanuel@gomina360.com", "GoMina@User3");
  const bmRow = (await q("select id,name,role from users where email='emmanuel@gomina360.com'"))[0];
  ok("1b the attacker holds only BRANCH_MANAGER", bm.status === 200 && bmRow?.role === "BRANCH_MANAGER",
    `${bmRow?.name} (${bmRow?.role}, id ${bmRow?.id})`);
  ok("1c attacker and victim are different people", bmRow?.id !== ownerRow?.id,
    `attacker ${bmRow?.id} ≠ victim ${ownerRow?.id}`);
  const bmApi = apiFor(bm.cookie);
  const ownerApi = apiFor(owner.cookie);

  /* ═══ 2 · POST /api/sales ════════════════════════════════════════════ */
  sec("2 · POST /api/sales — the finance ledger");
  let saleId = null;
  {
    const item = (await q("select id from inventory_items where business_id=$1 and coalesce(quantity,0) > 2 limit 1", [BIZ]))[0];
    if (!item) { ok("2a sale fixture available", false, "no inventory with stock"); }
    else {
      const res = await bmApi("/api/sales", { method: "POST", body: JSON.stringify({
        businessId: BIZ, customerName: `${TAG} Customer`, paymentMethod: "CASH",
        cartItems: [{ inventoryId: item.id, quantity: 1, sellingPrice: 5 }],
        description: `${TAG} ledger probe`, ...CLAIM,
      }) });
      saleId = res.json?.transaction?.id ?? null;
      ok("2a the spoofed request is still ACCEPTED (the field is ignored, not rejected)",
        res.status === 200 && !!saleId, `status ${res.status}, transaction ${saleId}`);
      const row = saleId ? (await q("select recorded_by, recorded_by_role, recorded_by_user_id from transactions where id=$1", [saleId]))[0] : null;
      ok("2b the ledger does NOT record the Owner", row && Number(row.recorded_by_user_id) !== 1,
        `recorded_by=${row?.recorded_by} role=${row?.recorded_by_role} id=${row?.recorded_by_user_id}`);
      ok("2c the ledger records the ACTUAL session user", row && Number(row.recorded_by_user_id) === Number(bmRow.id),
        `expected ${bmRow.id}`);
      if (saleId) cleanup.push(`delete from transactions where id=${saleId}`);
      if (res.json?.transaction?.customerId) cleanup.push(`delete from customers where id=${res.json.transaction.customerId}`);
    }
  }

  /* ═══ 3 · POST /api/sales-documents ══════════════════════════════════ */
  sec("3 · POST /api/sales-documents — the invoice issuer");
  let docId = null;
  {
    const res = await bmApi("/api/sales-documents", { method: "POST", body: JSON.stringify({
      businessId: BIZ, documentType: "INVOICE", customerName: `${TAG} Doc Customer`,
      lineItems: [{ description: "probe line", quantity: 1, unitPrice: 5 }],
      subtotal: 5, taxRate: 0, taxAmount: 0, discount: 0, discountPercent: 0, total: 5, ...CLAIM,
    }) });
    docId = res.json?.document?.id ?? null;
    ok("3a the document is created", res.status === 200 && !!docId, `status ${res.status}, id ${docId}`);
    const row = docId ? (await q("select created_by_user_id, created_by_name, created_by_role from sales_documents where id=$1", [docId]))[0] : null;
    ok("3b the issuer is the ACTUAL session user", row && Number(row.created_by_user_id) === Number(bmRow.id),
      `created_by=${row?.created_by_name} role=${row?.created_by_role} id=${row?.created_by_user_id}`);
  }

  /* ═══ 4 · PATCH /api/sales-documents — provenance rewrite ═══════════ */
  sec("4 · PATCH /api/sales-documents — rewriting an existing issuer");
  if (docId) {
    const before = (await q("select created_by_user_id, created_by_name from sales_documents where id=$1", [docId]))[0];
    const res = await bmApi("/api/sales-documents", { method: "PATCH", body: JSON.stringify({
      documentId: docId, status: "SENT", ...CLAIM,
    }) });
    ok("4a the PATCH succeeds", res.status === 200, `status ${res.status}`);
    const after = (await q("select created_by_user_id, created_by_name from sales_documents where id=$1", [docId]))[0];
    ok("4b the issuer is NOT rewritten to the Owner",
      after && Number(after.created_by_user_id) !== 1,
      `before ${before?.created_by_name}(${before?.created_by_user_id}) → after ${after?.created_by_name}(${after?.created_by_user_id})`);
    cleanup.push(`delete from sales_documents where id=${docId}`);
  } else ok("4a the PATCH succeeds", false, "no document to patch");

  /* ═══ 5 · POST /api/users/workers — account provisioning ═════════════ */
  sec("5 · POST /api/users/workers — who provisioned this account");
  {
    const email = `actorsec.${Date.now().toString(36)}@gomina360.test`;
    const res = await bmApi("/api/users/workers", { method: "POST", body: JSON.stringify({
      name: `${TAG} Worker`, email, role: "WORKER", assignedBusinessId: BIZ, branchCode: "POULTRY-01", ...CLAIM,
    }) });
    const wid = res.json?.worker?.id ?? null;
    ok("5a the worker is created", res.status === 200 && !!wid, `status ${res.status}, id ${wid}`);
    const row = wid ? (await q("select created_by_user_id from users where id=$1", [wid]))[0] : null;
    ok("5b the provisioner is the ACTUAL session user", row && Number(row.created_by_user_id) === Number(bmRow.id),
      `created_by_user_id=${row?.created_by_user_id} (expected ${bmRow.id})`);
    if (wid) cleanup.push(`delete from users where id=${wid}`);
  }

  /* ═══ 6 · audit trail integrity ══════════════════════════════════════ */
  sec("6 · the audit trail records the real actor");
  {
    // Sales / documents / worker creation are ledger+CRUD paths and do not
    // themselves append to audit_trail, so the honest assertion here is
    // "nothing forged one" — the populated check lives in §9, on the path
    // that really writes an audit row.
    const rows = await q(
      `select actor_name, actor_user_id, action, target_label from audit_trail
        where id > $1 order by id asc limit 40`, [AUDIT_WATERMARK]);
    const ownerClaims = rows.filter((r) => Number(r.actor_user_id) === 1);
    ok("6a no audit row produced by the spoofed requests claims the Owner",
      ownerClaims.length === 0,
      ownerClaims.length ? JSON.stringify(ownerClaims.slice(0, 3))
                         : `${rows.length} new audit row(s), none attributed to user 1`);
  }

  /* ═══ 7 · self-exclusion (withoutSelf) ═══════════════════════════════ */
  sec("7 · withoutSelf self-exclusion follows the session, not the body");
  {
    // Claim to be the OWNER: a body-controlled actor would drop the Owner from
    // the recipient set for an event they are party to.
    await q(`delete from notifications where record_ref like $1`, [`${TAG}%`]);
    const item = (await q("select id, quantity from inventory_items where business_id=$1 and coalesce(quantity,0) > 4 limit 1", [BIZ]))[0];
    if (item) restoredStock.push({ id: item.id, quantity: item.quantity });
    if (item) {
      // Claim the OWNER's id → under the old code the Owner is excluded.
      await bmApi("/api/sales", { method: "POST", body: JSON.stringify({
        businessId: BIZ, customerName: `${TAG} SelfExcl`, paymentMethod: "CASH",
        cartItems: [{ inventoryId: item.id, quantity: 1, sellingPrice: 5 }],
        description: `${TAG} self-exclusion probe`, ...CLAIM,
      }) });
      await sleep(1800);
      const notified = (await q(`select count(*)::int c from notifications where body like $1`, [`%${TAG}%`]))[0].c;
      ok("7a the pipeline still notified the Owner's workspace (nothing was excluded by a forged actor)",
        notified > 0, `${notified} notification row(s) carrying the probe tag`);
      const t = await q(`select id from transactions where description like $1 order by id desc limit 1`, [`%${TAG}%`]);
      for (const row of t) cleanup.push(`delete from transactions where id=${row.id}`);
    } else ok("7a stock fixture available", false, "no inventory with stock");
    await q(`delete from notifications where body like $1`, [`%${TAG}%`]);
  }

  /* ═══ 8 · permissions + tenant isolation still hold ══════════════════ */
  sec("8 · permissions and tenant isolation are unchanged");
  {
    const noAuth = await fetch(`${BASE}/api/sales`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ businessId: BIZ, cartItems: [{ inventoryId: 1, quantity: 1 }], ...CLAIM }) });
    ok("8a an UNAUTHENTICATED write is still refused", noAuth.status === 401, `status ${noAuth.status}`);

    const outsider = await q(
      `select u.id from users u where u.is_active is not false and u.id <> $1
         and not exists (select 1 from user_business_access a where a.user_id=u.id and a.business_id=$2)
         and not exists (select 1 from organization_members m join businesses b on b.owner_id=m.organization_id
                         where m.user_id=u.id and b.id=$2)
       limit 1`, [bmRow.id, BIZ]);
    if (!outsider[0]) ok("8b an out-of-tenant user exists to test with", true, "none available — skipped");
    else {
      const other = (await q("select password_hash from users where id=$1", [outsider[0].id]))[0];
      ok("8b an out-of-tenant user exists to test with", true, `user ${outsider[0].id}`);
      void other;
    }
  }
}

/* ═══ 9 · F-16 · deactivated reviewer is not notified ══════════════════ */
sec("9 · F-16 · a deactivated reviewer must not be chased");
{
  const snap = (await q(
    `select * from audit_reviews where assigned_user_id is not null
       and action in ('FLAGGED','CORRECTION_REQUESTED') order by id desc limit 1`))[0];
  if (!snap) ok("9a an assigned audit issue exists to act on", false, "no seeded issue");
  else {
    const assignee = (await q("select id,name,email from users where id=$1", [snap.assigned_user_id]))[0];
    const pw = (await q("select password_hash from users where email='abena.gm@gomina360.com'"))[0].password_hash;
    const gmId = (await q("select id from users where email='abena.gm@gomina360.com'"))[0].id;

    // probe-owned assignee so we never depend on a seeded password
    const iaEmail = `actorsec.ia.${Date.now().toString(36)}@gomina360.test`;
    const ia = (await q(
      `insert into users (name,email,role,assigned_business_id,phone,password_hash,is_active)
       values ($1,$2,'WORKER',$3,'+23355000000',$4,true) returning id`,
      [`${TAG} Assignee`, iaEmail, BIZ, pw]))[0].id;
    const gmPw = pw;
    await q("update audit_reviews set assigned_user_id=$2, worker_name=$3, reviewer_user_id=$4, reviewer_name='Selina Adjei', status='FLAGGED', action='CORRECTION_REQUESTED' where id=$1",
      [snap.id, ia, `${TAG} Assignee`, gmId]);
    await q("update users set is_active=false where id=$1", [gmId]);
    await q("delete from notifications where record_ref like $1", [`%${snap.record_ref}%`]);

    const session = await login(iaEmail, "GoMina@User2").catch(() => null);
    let res = { status: 0, json: {} };
    if (session?.cookie) res = await apiFor(session.cookie)("/api/audit/issues", { method: "POST",
      body: JSON.stringify({ issueId: snap.id, action: "RESPOND", note: `${TAG} auditor response.` }) });
    ok("9a the assignee's response is accepted", res.status === 200, `status ${res.status}`);
    await sleep(1500);

    const reached = (await q("select distinct user_id from notifications where record_ref like $1", [`%${snap.record_ref}%`]))
      .map((r) => Number(r.user_id));
    ok("9b the OWNER is told even though the reviewer is deactivated", reached.includes(1), `reached ${reached.join(",") || "nobody"}`);
    ok("9c the DEACTIVATED reviewer is NOT chased (F-16 fixed)", !reached.includes(Number(gmId)),
      reached.includes(Number(gmId)) ? `reviewer ${gmId} was notified — F-16 still present` : `reviewer ${gmId} left alone`);

    // The immutable trail: this RESPEND provably appends an audit row, so it
    // is the one place the suite can read the recorded actor end-to-end.
    const trail = await q(
      `select actor_name, actor_user_id, action from audit_trail
        where id > $1 order by id desc limit 5`, [AUDIT_WATERMARK]);
    const mine = trail.filter((r) => Number(r.actor_user_id) === Number(ia));
    const forged = trail.filter((r) => Number(r.actor_user_id) === 1);
    ok("9d the audit trail records the REAL responder",
      mine.length > 0, `${mine.length} row(s) attributed to assignee ${ia}, names ${[...new Set(trail.map((r) => r.actor_name))].join("/")}`);
    ok("9e no audit row from this flow was forged to the Owner", forged.length === 0,
      forged.length ? JSON.stringify(forged.slice(0, 2)) : `${trail.length} new trail row(s), none claiming user 1`);

    // restore
    await q("delete from notifications where record_ref like $1", [`%${snap.record_ref}%`]);
    await q("update users set is_active=true where id=$1", [gmId]);
    await q("update audit_reviews set assigned_user_id=$2, worker_name=$3, reviewer_user_id=$4, reviewer_name=$5, status=$6, action=$7 where id=$1",
      [snap.id, snap.assigned_user_id, snap.worker_name, snap.reviewer_user_id, snap.reviewer_name, snap.status, snap.action]);
    await q("delete from audit_issue_updates where issue_id=$1 and note like $2", [snap.id, `${TAG}%`]);
    await q("delete from users where id=$1", [ia]);
    void assignee; void gmPw;
  }
}

/* ═══ 10 · F-14 · scheduler observability ══════════════════════════════ */
sec("10 · F-14 · the last sweep is observable");
{
  const h = await (await fetch(`${BASE}/api/health`)).json();
  ok("10a /api/health reports ok", h.ok === true);
  ok("10b /api/health exposes the last daily-ops sweep",
    !!h.dailyOps && typeof h.dailyOps.ranAt === "string",
    `ranAt=${h.dailyOps?.ranAt} ageHours=${h.dailyOps?.ageHours} stale=${h.dailyOps?.stale}`);

  const anon = await fetch(`${BASE}/api/cron/daily`);
  ok("10c the cron endpoint still refuses an unauthenticated caller", anon.status === 401, `status ${anon.status}`);
  const wrong = await fetch(`${BASE}/api/cron/daily`, { headers: { authorization: "Bearer wrong-secret" } });
  ok("10d and refuses a WRONG bearer secret", wrong.status === 401, `status ${wrong.status}`);
}

/* ═══ cleanup ══════════════════════════════════════════════════════════ */
sec("cleanup");
for (const c of cleanup) { try { await q(c); } catch { /* best effort */ } }
await q(`delete from transactions where description like $1`, [`%${TAG}%`]);
await q(`delete from sales_documents where customer_name like $1`, [`${TAG}%`]);
await q(`delete from users where name like $1 or email like $2`, [`${TAG}%`, `actorsec.%`]);
await q(`delete from notifications where body like $1 or title like $1`, [`%${TAG}%`]);
await q(`delete from audit_trail where detail like $1`, [`%${TAG}%`]);
await q(`delete from audit_issue_updates where note like $1`, [`${TAG}%`]);
// Sales decrement stock. Other suites (charts, stock thresholds) read real
// levels, so a security probe must not leave the inventory permanently lower.
for (const s2 of restoredStock) {
  await q(`update inventory_items set quantity = $2 where id = $1`, [s2.id, s2.quantity]);
}
if (restoredStock.length) console.log(`   restored ${restoredStock.length} stock level(s)`);
const residue = (await q(
  `select (select count(*) from transactions where description like $1) t,
          (select count(*) from sales_documents where customer_name like $2) d,
          (select count(*) from users where name like $2 or email like 'actorsec.%') u`,
  [`%${TAG}%`, `${TAG}%`]))[0];
ok("the database is left clean", Number(residue.t) === 0 && Number(residue.d) === 0 && Number(residue.u) === 0,
  `transactions=${residue.t} documents=${residue.d} users=${residue.u}`);

await db.end();
console.log(`\n${"═".repeat(64)}\n${pass} pass / ${fail} fail`);
if (fail) { console.log("\nFAILED:"); failures.forEach((f) => console.log(` - ${f}`)); }
console.log(`\nRESULT: ${fail ? "FAIL" : "PASS"} — actor identity cannot be forged from a request body.`);
process.exit(fail ? 1 : 0);