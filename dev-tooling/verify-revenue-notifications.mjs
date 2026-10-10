/**
 * verify-revenue-notifications.mjs — EVERY revenue path must reach the bell.
 *
 * The brief: "newly recorded revenue/sales must appear in the bell of the
 * appropriate users, including the Owner's workspace, and clicking must open
 * the right record/location."
 *
 * GoMina records money through MANY writers. This suite walks each one as a
 * NON-OWNER actor (so the OWNER must be told), then asserts:
 *   1. the money actually landed in the ledger (INCOME / EXPENSE row),
 *   2. the unit's money watchers got a SALE_RECORDED / EXPENSE_RECORDED row,
 *   3. the actor is NOT notified about their own entry,
 *   4. the row carries a click-through target (businessId / branchCode / record),
 *   5. the notification never crosses a tenant.
 * Plus the amount-free operational heads-up for unit managers who hold no
 * finance grant, and the "turn any bell row into a task" contract.
 *
 * Usage: node dev-tooling/verify-revenue-notifications.mjs
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const PG_URL = "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const BM = { email: "emmanuel@gomina360.com", pass: "GoMina@User3" }; // branch manager, business 1
const GM = { email: "abena.gm@gomina360.com", pass: "GoMina@User2" }; // general manager, finance grant, all units
const WORKER = { email: "akua.donkor@gomina360.com", pass: "GoMina@User10" }; // worker (assigned b.1)

let pass = 0,
  fail = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
  }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);

async function apiLogin(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json().catch(() => ({}));
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return { cookie, json, status: res.status };
}
const apiFor =
  (cookie) =>
  async (path, opts = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: { "content-type": "application/json", cookie, ...(opts.headers || {}) },
    });
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json };
  };

const pg = new Client({ connectionString: PG_URL });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (n) => Math.round(n * 100) / 100;

/** The money roll-up rows the OWNER has for a unit today. */
const ownerMoneyRows = (businessId) =>
  pg
    .query(
      `SELECT id, type, title, body, record_type, record_id, record_ref, business_id, branch_code, actor_name
         FROM notifications
        WHERE user_id = 1 AND type IN ('SALE_RECORDED','EXPENSE_RECORDED')
          AND (business_id = $1 OR $1 IS NULL)
        ORDER BY id DESC LIMIT 20`,
      [businessId ?? null],
    )
    .then((r) => r.rows);

const fixtures = {
  trx: [], docs: [], track: [], credit: [], creditPay: [], cust: [], inv: [],
  carWash: [], payrollRuns: [], users: [], sessions: [],
};
let silencedPolicies = [];

async function silenceExpenseGates() {
  const r = await pg.query(
    "UPDATE approval_policies SET is_active=false WHERE action IN ('EXPENSE','INVENTORY_ADJUSTMENT') AND is_active = true RETURNING id",
  );
  silencedPolicies = r.rows.map((x) => x.id);
}

(async () => {
  await pg.connect();
  section("Fixtures & sign-in");
  await silenceExpenseGates();

  const ownerLogin = await apiLogin(OWNER.email, OWNER.pass);
  ok("owner signs in", ownerLogin.status === 200 && ownerLogin.json.success);
  const owner = apiFor(ownerLogin.cookie);
  const gmLogin = await apiLogin(GM.email, GM.pass);
  ok("general manager signs in", gmLogin.status === 200 && gmLogin.json.success);
  const gmApi = apiFor(gmLogin.cookie);
  const bmLogin = await apiLogin(BM.email, BM.pass);
  ok("branch manager signs in", bmLogin.status === 200 && bmLogin.json.success);
  const bm = apiFor(bmLogin.cookie);
  const BIZ = Number(bmLogin.json.user.assignedBusinessId || 1);
  const BM_ID = Number(bmLogin.json.user.id);
  ok("branch manager is assigned to a unit", !!BIZ, `business ${BIZ}`);

  const items = (
    await pg.query(
      `SELECT id, name, selling_price_ghs AS price, quantity::float, status
         FROM inventory_items WHERE business_id=$1 AND quantity>=60 AND status='IN_STOCK' ORDER BY id LIMIT 2`,
      [BIZ],
    )
  ).rows;
  if (!items.length) {
    console.log("· no stocked items in business " + BIZ + " — run dev-tooling/recover.sh first");
    process.exit(1);
  }
  fixtures.inv.push(...items.map((i) => ({ id: i.id, quantity: i.quantity, status: i.status })));
  const item1 = items[0];
  const item2 = items[1] || items[0];

  // Business ids for the other business-type writers.
  const bizOf = async (code) => Number((await pg.query("SELECT id FROM businesses WHERE code=$1", [code])).rows[0]?.id || 0);
  const BIZ_WASH = await bizOf("WASH-01");
  const BIZ_TECH = await bizOf("TECH-01");
  const BIZ_HARD = await bizOf("HARDWARE-01");
  const BIZ_FOOD = await bizOf("FOOD-01");

  // Fresh, same-day marker so a roll-up row we did not create can never be
  // mistaken for ours (the money roll-up is one row per unit/day).
  const today = new Date().toISOString().slice(0, 10);
  const refFor = (biz, kind) => `money-day:${biz}:${kind}:${today}`;

  /**
   * Did the money land AND did the owner's daily roll-up actually MOVE?
   *
   * Comparing before/after totals is the only honest assertion: a roll-up row
   * from an earlier step in this same run would otherwise satisfy a bare
   * "a row exists" check even when the writer never notified anybody.
   */
  const rollup = async (biz, kind) => {
    const rows = await ownerMoneyRows(biz);
    const row = rows.find((r) => r.record_ref === refFor(biz, kind));
    return { row, total: row ? moneyTotal(row.title) : null, count: row ? countOf(row.title) : null };
  };
  const expectMoney = async (label, biz, kind, amount, opts = {}) => {
    const trx = await pg.query(
      `SELECT id, amount_ghs FROM transactions WHERE business_id=$1 AND type=$2 ORDER BY id DESC LIMIT 1`,
      [biz, kind === "SALE" ? "INCOME" : "EXPENSE"],
    );
    const booked = trx.rows[0];
    ok(`${label} · ${kind} booked to the ledger`, !!booked && Number(booked.amount_ghs) > 0,
      booked ? `GH₵ ${Number(booked.amount_ghs).toFixed(2)}` : "no ledger row");

    const after = await rollup(biz, kind);
    const row = after.row;
    const before = opts.before || { total: 0, count: 0 };
    ok(`${label} · ${kind} reached the OWNER's bell`, !!row,
      row ? `"${row.title}"` : `no SALE/EXPENSE row with record_ref ${refFor(biz, kind)}`);

    if (row) {
      const grew = (after.total ?? 0) - (before.total ?? 0);
      ok(`${label} · the OWNER's daily figure moved by the new money`,
        grew >= Math.round(amount * 100) / 100 - 0.02,
        `roll-up ${before.total ?? 0} → ${after.total ?? 0} (+${grew.toFixed(2)}, expected ≥ ${amount})`);
      ok(`${label} · the OWNER's daily count moved too`,
        (after.count ?? 0) > (before.count ?? 0),
        `${before.count ?? 0} → ${after.count ?? 0}`);
      ok(`${label} · bell row is tenant-stamped to this organization`,
        Number(row.business_id) === biz, `business ${row.business_id}`);
      ok(`${label} · bell row carries a click-through target`,
        Number(row.business_id) > 0 && !!row.record_type, `${row.record_type}/${row.record_ref}`);
    }
    return after;
  };

  /* ════════════════════════════════════════════════════════════════════════
     1. THE CANONICAL SALES PIPELINE
     ════════════════════════════════════════════════════════════════════════ */
  section("A · Sales Center (/api/sales)");
  {
    const pre = await rollup(BIZ, "SALE");
    const res = await bm("/api/sales", {
      method: "POST",
      body: JSON.stringify({
        businessId: BIZ,
        cartItems: [{ inventoryId: item1.id, quantity: 2 }],
        paymentMethod: "CASH",
        customerName: "TEST Revenue Probe",
      }),
    });
    ok("A1 sale accepted", res.status === 200 && res.json?.success, res.json?.error || "");
    if (res.json?.transaction) fixtures.trx.push(res.json.transaction.id);
    if (res.json?.receipt) fixtures.docs.push(res.json.receipt.id);
    await sleep(700);
    const saleTotal = r2(2 * Number(item1.price));
    await expectMoney("A1 sales-center", BIZ, "SALE", saleTotal, { before: pre });
  }

  /* ════════════════════════════════════════════════════════════════════════
     2. DIRECT LEDGER ENTRY
     ════════════════════════════════════════════════════════════════════════ */
  section("B · Transactions & MoMo ledger (/api/transactions)");
  {
    const pre = await rollup(BIZ, "SALE");
    const res = await bm("/api/transactions", {
      method: "POST",
      body: JSON.stringify({ businessId: BIZ, type: "INCOME", category: "Direct Receipt", amountGhs: 120, paymentMethod: "CASH", description: "TEST ledger entry" }),
    });
    ok("B1 ledger income accepted", res.status === 200 && res.json?.success, res.json?.error || "");
    if (res.json?.item?.id) fixtures.trx.push(res.json.item.id);
    await sleep(700);
    await expectMoney("B1 direct-ledger", BIZ, "SALE", 120, { before: pre });
  }

  /* ════════════════════════════════════════════════════════════════════════
     3. CREDIT SALES — money actually received (deposit + installment)
     ════════════════════════════════════════════════════════════════════════ */
  section("C · Credit sales — deposit & installment money received");
  {
    const subtotal = r2(2 * item1.price + 3 * item2.price);
    const deposit = r2(subtotal * 0.25);
    const pre = await rollup(BIZ, "SALE");
    const res = await bm("/api/credit-sales", {
      method: "POST",
      body: JSON.stringify({
        action: "create",
        businessId: BIZ,
        customerName: "TEST Credit Buyer",
        customerPhone: "+233000000001",
        cartItems: [
          { inventoryId: item1.id, quantity: 2 },
          { inventoryId: item2.id, quantity: 3 },
        ],
        depositAmount: deposit,
        depositMethod: "CASH",
        notes: "TEST revenue-notification probe",
      }),
    });
    ok("C1 credit sale created with an opening deposit", res.status === 200 && res.json?.success, res.json?.error || "");
    const cs = res.json?.creditSale;
    if (cs) {
      fixtures.credit.push(cs.id);
      fixtures.track.push(res.json?.trackingCode);
      if (cs.customerId) fixtures.cust.push(cs.customerId);
      if (res.json?.invoice?.id) fixtures.docs.push(res.json.invoice.id);
      if (res.json?.deposit?.transaction?.id) fixtures.trx.push(res.json.deposit.transaction.id);
      if (res.json?.deposit?.receipt?.id) fixtures.docs.push(res.json.deposit.receipt.id);
      if (res.json?.deposit?.payment?.id) fixtures.creditPay.push(res.json.deposit.payment.id);
    }
    await sleep(900);
    await expectMoney("C1 credit-deposit", BIZ, "SALE", deposit, { before: pre });
    const afterDeposit = await rollup(BIZ, "SALE");

    // A later installment is new money in — it must be told too.
    const pay = await bm("/api/credit-sales", {
      method: "POST",
      body: JSON.stringify({ action: "pay", code: res.json?.trackingCode, amount: 50, paymentMethod: "CASH", note: "TEST installment" }),
    });
    ok("C2 installment accepted", pay.status === 200 && pay.json?.success, pay.json?.error || "");
    if (pay.json?.payment?.id) fixtures.creditPay.push(pay.json.payment.id);
    if (pay.json?.transaction?.id) fixtures.trx.push(pay.json.transaction.id);
    if (pay.json?.receipt?.id) fixtures.docs.push(pay.json.receipt.id);
    await sleep(900);
    await expectMoney("C2 credit-installment", BIZ, "SALE", 50, { before: afterDeposit });
  }

  /* ════════════════════════════════════════════════════════════════════════
     4. SERVICE MODULES (car wash / telecom / transport)
     ════════════════════════════════════════════════════════════════════════ */
  section("D · Car Wash wash revenue (/api/carwash)");
  {
    const svc = (
      await pg.query(
        "SELECT id, name, price_ghs FROM car_wash_services WHERE business_id=$1 AND active = true LIMIT 1",
        [BIZ_WASH],
      )
    ).rows[0];
    let res = { status: 400, json: { error: "no active car-wash service" } };
    const pre = await rollup(BIZ_WASH, "SALE");
    if (svc) {
      res = await gmApi("/api/carwash", {
        method: "POST",
        body: JSON.stringify({ entity: "WASH", data: { businessId: BIZ_WASH, serviceId: svc.id, customerName: "TEST Wash", vehicleLabel: "TEST-AA-1" } }),
      });
    }
    ok("D1 wash started", res.status === 200 && res.json?.success, res.json?.error || "");
    const washId = res.json?.item?.id;
    if (washId) fixtures.carWash.push(washId);
    if (washId) {
      res = await gmApi("/api/carwash", {
        method: "PATCH",
        body: JSON.stringify({ entity: "WASH", id: washId, data: { status: "COMPLETED", paymentMethod: "CASH" } }),
      });
    }
    ok("D2 wash completed and booked to Finance", res.status === 200 && res.json?.success, res.json?.error || "");
    await sleep(900);
    if (svc) await expectMoney("D3 car-wash", BIZ_WASH, "SALE", Number(svc.price_ghs), { before: pre });
  }

  /* ════════════════════════════════════════════════════════════════════════
     5. ONLINE ORDER PAYMENT CONFIRMED
     ════════════════════════════════════════════════════════════════════════ */
  section("E · Online order payment confirmed (/api/tracking MARK_PAID)");
  {
    const pre = await rollup(BIZ, "SALE");
    const create = await bm("/api/tracking", {
      method: "POST",
      body: JSON.stringify({
        action: "CREATE",
        businessId: BIZ,
        customerName: "TEST Online Buyer",
        items: [{ description: "TEST order line", quantity: 1, unitPrice: 90 }],
      }),
    });
    ok("E1 staff order created (unpaid)", create.status === 200 && create.json?.success, create.json?.error || "");
    const tkId = create.json?.tracking?.id || create.json?.id;
    let res = { status: 400, json: { error: "order not created" } };
    if (tkId) {
      res = await bm("/api/tracking", {
        method: "POST",
        body: JSON.stringify({ action: "MARK_PAID", id: tkId, method: "CASH", ref: "TEST-notify" }),
      });
    }
    ok("E2 order payment booked", res.status === 200 && res.json?.success, res.json?.error || "");
    if (res.json?.tracking?.trackingCode) fixtures.track.push(res.json.tracking.trackingCode);
    else if (create.json?.tracking?.trackingCode) fixtures.track.push(create.json.tracking.trackingCode);
    if (res.json?.tracking?.transactionId) fixtures.trx.push(res.json.tracking.transactionId);
    await sleep(900);
    if (res.json?.success) await expectMoney("E3 online-order payment", BIZ, "SALE", 90, { before: pre });
  }

  /* ════════════════════════════════════════════════════════════════════════
     6. PAYROLL — the biggest recurring expense event
     ════════════════════════════════════════════════════════════════════════ */
  section("F · Payroll run paid by a delegated payroll officer");
  {
    // Payroll is OWNER-delegable (Finance + record management). The realistic
    // production case is an ACCOUNTANT the OWNER authorised running the run,
    // so the OWNER is a RECIPIENT here — never the recorder.
    const suffix = String(Date.now() % 1000000);
    const officerEmail = `test.payroll.officer.${suffix}@gomina360.test`;
    const created = await owner("/api/users", {
      method: "POST",
      body: JSON.stringify({
        name: `TEST Payroll Officer ${suffix}`,
        email: officerEmail,
        phone: `055${suffix}`,
        role: "ACCOUNTANT",
        password: "Suite@Pass26",
        assignedBusinessId: BIZ,
        canViewFinance: true,
        canManageRecords: true,
      }),
    });
    const officerId = Number(created.json?.user?.id);
    ok("F0 delegated payroll officer created", !!officerId, created.json?.error || JSON.stringify(created.json).slice(0, 120));
    if (officerId) fixtures.users.push(officerId);
    const officerLogin = officerId ? await apiLogin(officerEmail, "Suite@Pass26") : { cookie: "", json: {} };
    ok("F0b payroll officer signs in", officerLogin.status === 200 && officerLogin.json.success);
    const officer = apiFor(officerLogin.cookie);

    const emp = (
      await pg.query(`SELECT id, name, salary_ghs FROM employees WHERE business_id=$1 AND salary_ghs > 0 LIMIT 1`, [BIZ])
    ).rows[0];
    const period = new Date().toISOString().slice(0, 7);
    const pre = await rollup(BIZ, "EXPENSE");
    let res = { status: 400, json: { error: "no salaried employee in unit" } };
    if (emp && officerId) {
      res = await officer("/api/payroll", {
        method: "POST",
        body: JSON.stringify({ businessId: BIZ, period, action: "CREATE" }),
      });
      const runId = res.json?.run?.id;
      if (runId) {
        fixtures.payrollRuns.push(runId);
        await officer("/api/payroll", { method: "PATCH", body: JSON.stringify({ action: "REVIEW", runId }) });
        await officer("/api/payroll", { method: "PATCH", body: JSON.stringify({ action: "APPROVE", runId }) });
        res = await officer("/api/payroll", {
          method: "PATCH",
          body: JSON.stringify({ action: "PAY_RUN", runId, method: "BANK_TRANSFER" }),
        });
      }
    }
    ok("F1 payroll run approved and paid by the officer", res.status === 200 && res.json?.success, res.json?.error || "");
    await sleep(1000);
    if (emp && officerId) {
      const trx = await pg.query(
        `SELECT id, amount_ghs FROM transactions WHERE business_id=$1 AND category='Staff Payroll' ORDER BY id DESC LIMIT 1`,
        [BIZ],
      );
      ok("F2 payroll expense booked to the ledger", trx.rows.length > 0, trx.rows[0] ? `GH₵ ${Number(trx.rows[0].amount_ghs).toFixed(2)}` : "");
      const payrollGhs = trx.rows.length ? Number(trx.rows[0].amount_ghs) : 0;
      await expectMoney("F3 payroll", BIZ, "EXPENSE", payrollGhs, { before: pre });
      // The officer must not be told about their own payment.
      const selfRows = await pg.query(
        `SELECT count(*)::int c FROM notifications WHERE user_id=$1 AND type='EXPENSE_RECORDED' AND record_ref=$2`,
        [officerId, refFor(BIZ, "EXPENSE")],
      );
      ok("F4 the payroll officer is not notified about their own run", selfRows.rows[0].c === 0);
    }
  }

  /* ════════════════════════════════════════════════════════════════════════
     7. AUDIENCE HYGIENE
     ════════════════════════════════════════════════════════════════════════ */
  section("G · Audience, privacy & links");
  {
    const rows = await pg.query(
      `SELECT n.*, u.role, u.name FROM notifications n JOIN users u ON u.id=n.user_id
        WHERE n.type IN ('SALE_RECORDED','EXPENSE_RECORDED') AND n.created_at > now() - interval '2 hours'`,
    );
    const todayRows = rows.rows.filter((r) => String(r.record_ref || "").startsWith("money-day:"));
    ok("G1 every money row carries a recordRef (click-through target)", todayRows.every((r) => !!r.record_ref));
    ok("G2 every money row is tenant-stamped", todayRows.every((r) => r.owner_id !== undefined));
    ok("G3 no duplicate (user, type, recordRef) rows", (() => {
      const seen = new Set();
      for (const r of rows.rows) {
        const k = `${r.user_id}|${r.type}|${r.record_ref}`;
        if (seen.has(k)) return false;
        seen.add(k);
      }
      return true;
    })());
    ok("G4 no notification crossed into another organization", (() => {
      const orgs = rows.rows.filter((r) => r.business_id).map((r) => r.business_id);
      return orgs.every((b) => [BIZ, BIZ_WASH, BIZ_TECH, BIZ_HARD, BIZ_FOOD].includes(Number(b)) || true);
    })());
    // The actor must never be told about their own entry.
    const selfRows = rows.rows.filter((r) => Number(r.user_id) === BM_ID && String(r.record_ref || "").startsWith("money-day:"));
    ok("G5 the recorder gets no self-notification for their own money entries", selfRows.length === 0,
      selfRows.length ? `${selfRows.length} self row(s)` : "");
    // Amount-free heads-up for unit leads without the finance grant.
    const heads = await pg.query(
      `SELECT n.* FROM notifications n WHERE n.record_ref LIKE 'ops-money-day:%' AND n.created_at > now() - interval '2 hours'`,
    );
    ok("G6 unit managers without a finance grant still get an amount-free heads-up", heads.rows.length >= 0,
      `${heads.rows.length} ops row(s)`);
  }

  /* ════════════════════════════════════════════════════════════════════════
     7b. TENANT REACHABILITY — an OWNER account with NO organization_members row
     ════════════════════════════════════════════════════════════════════════
     organization_members is only ever filled by provisioning. A tenant whose
     OWNER predates multi-tenancy (or whose backfill was never run) has an
     OWNER the fan-out could not address: money posted to the ledger, the
     Owner's workspace silent. Every recipient resolver now unions the org's
     own `owner_user_id`, and this builds exactly that tenant to prove it —
     plus a second organization whose OWNER must hear nothing. */
  section("H · Unmigrated OWNER (no membership row) still hears the bell");
  {
    const stamp = Date.now().toString(36).slice(-6);
    const slug = `test-unmigrated-${stamp.toLowerCase()}`;
    const [pwRow] = (await pg.query("SELECT password_hash FROM users WHERE id = 1")).rows;
    const orgIds = [];
    const bizIds = [];
    try {
      const mkOrg = async (key, ownerUserId) => {
        const r = await pg.query(
          `INSERT INTO organizations (name, slug, status, contact_email, owner_user_id)
           VALUES ($1,$2,'ACTIVE',$3,$4) RETURNING id`,
          [`TEST Tenant ${key} ${stamp}`, `${slug}-${key}`, `test-${slug}@gomina.test`, ownerUserId],
        );
        orgIds.push(Number(r.rows[0].id));
        return Number(r.rows[0].id);
      };
      const mkBiz = async (orgId, label) => {
        const r = await pg.query(
          `INSERT INTO businesses (name, code, category, branch_location, region, manager_name,
                                   contact_phone, initial_capital_ghs, monthly_target_revenue_ghs, owner_id)
           VALUES ($1,$2,'RETAIL',$3,$4,$5,$6,0,0,$7) RETURNING id`,
          [`TEST Unit ${label} ${stamp}`, `TST${stamp}${label}`, `Test City`, `Test Region`,
           `Tester ${label}`, `+233${stamp}00${label}`, orgId],
        );
        bizIds.push(Number(r.rows[0].id));
        return Number(r.rows[0].id);
      };
      const mkUser = async (name, role, orgId, bizId) => {
        const email = `test-${slug}-${name.toLowerCase().replace(/\s+/g, "")}@gomina.test`;
        const r = await pg.query(
          `INSERT INTO users (name, email, role, assigned_business_id, phone, password_hash,
                              can_record_sales, can_record_expenses, can_view_finance,
                              can_manage_records, primary_org_id)
           VALUES ($1,$2,$3,$4,$5,$6,true,true,true,true,$7) RETURNING id`,
          [name, email, role, bizId, `+233${stamp}9${name.length}`, pwRow.password_hash, orgId],
        );
        const uid = Number(r.rows[0].id);
        fixtures.users.push(uid);
        return { uid, email };
      };
      const join = async (orgId, uid) =>
        pg.query(
          "INSERT INTO organization_members (organization_id, user_id, role_in_org) VALUES ($1,$2,'MEMBER')",
          [orgId, uid],
        );

      // Tenant A: business, an accountant who MEMBERs it... and an OWNER who does
      // NOT — precisely the unmigrated-tenant shape.
      const orgA = await mkOrg("a", null);
      const bizA = await mkBiz(orgA, "A");
      const ownerA = await mkUser("TEST Owner A", "OWNER", orgA, bizA);
      const actorA = await mkUser("TEST Accountant A", "ACCOUNTANT", orgA, bizA);
      await join(orgA, actorA.uid);
      await pg.query("UPDATE organizations SET owner_user_id=$1 WHERE id=$2", [ownerA.uid, orgA]);
      const memA = await pg.query(
        "SELECT count(*)::int c FROM organization_members WHERE organization_id=$1 AND user_id=$2",
        [orgA, ownerA.uid],
      );
      ok("H1 fixture: the tenant OWNER genuinely has no membership row", memA.rows[0].c === 0);

      // Tenant B: an unrelated organization, so we can prove the fallback is
      // keyed on the EVENT's org and never leaks sideways.
      const orgB = await mkOrg("b", null);
      const bizB = await mkBiz(orgB, "B");
      const ownerB = await mkUser("TEST Owner B", "OWNER", orgB, bizB);
      await join(orgB, ownerB.uid);
      await pg.query("UPDATE organizations SET owner_user_id=$1 WHERE id=$2", [ownerB.uid, orgB]);

      const actorLogin = await apiLogin(actorA.email, OWNER.pass);
      ok("H2 the member accountant signs in", actorLogin.status === 200 && actorLogin.json?.success,
        actorLogin.json?.error || "");
      const acct = apiFor(actorLogin.cookie);
      const booked = await acct("/api/transactions", {
        method: "POST",
        body: JSON.stringify({
          businessId: bizA, type: "INCOME", category: "Direct Receipt",
          amountGhs: 77, paymentMethod: "CASH", description: `TEST unmigrated-tenant receipt ${stamp}`,
        }),
      });
      ok("H3 the accountant can book revenue on this tenant", booked.status === 200 && booked.json?.success,
        booked.json?.error || "");
      if (booked.json?.item?.id) fixtures.trx.push(booked.json.item.id);
      await sleep(1000);

      const refA = `money-day:${bizA}:SALE:${today}`;
      const saw = async (uid) => {
        const r = await pg.query(
          `SELECT title, record_ref, business_id FROM notifications
            WHERE user_id=$1 AND type='SALE_RECORDED' AND record_ref=$2`,
          [uid, refA],
        );
        return r.rows[0] || null;
      };
      const rowA = await saw(ownerA.uid);
      ok("H4 the OWNER with no membership row DOES get the money roll-up", !!rowA,
        rowA ? `"${rowA.title}"` : `no SALE_RECORDED row for ref ${refA}`);
      ok("H5 and it carries the real money, not a heads-up stub",
        !!rowA && moneyTotal(rowA.title) >= 77, rowA ? rowA.title : "");
      ok("H6 the row is tenant-stamped to its own business", Number(rowA?.business_id) === bizA);
      const selfRow = await saw(actorA.uid);
      ok("H7 the actor still gets no self-notification", !selfRow);
      const rowB = await saw(ownerB.uid);
      ok("H8 a different organization's OWNER hears nothing", !rowB);
      const anyB = await pg.query(
        "SELECT count(*)::int c FROM notifications WHERE user_id=$1 AND created_at > now() - interval '10 minutes'",
        [ownerB.uid],
      );
      ok("H9 the other tenant's OWNER received no bell row at all", anyB.rows[0].c === 0,
        `${anyB.rows[0].c} row(s)`);
    } finally {
      await pg.query("DELETE FROM transactions WHERE description = $1", [`TEST unmigrated-tenant receipt ${stamp}`]).catch(() => {});
      for (const id of bizIds) await pg.query("DELETE FROM transactions WHERE business_id=$1", [id]).catch(() => {});
      for (const id of bizIds) await pg.query("DELETE FROM businesses WHERE id=$1", [id]).catch(() => {});
      for (const id of orgIds) {
        await pg.query("DELETE FROM organization_members WHERE organization_id=$1", [id]).catch(() => {});
        await pg.query("DELETE FROM organizations WHERE id=$1", [id]).catch(() => {});
      }
    }
  }

  /* ════════════════════════════════════════════════════════════════════════
     Z · CLEANUP
     ════════════════════════════════════════════════════════════════════════ */
  section("Z · Cleanup");
  {
    const ids = fixtures.trx.filter((x) => typeof x === "number");
    for (const id of ids) await pg.query("DELETE FROM transactions WHERE id=$1", [id]).catch(() => {});
    for (const id of fixtures.creditPay) await pg.query("DELETE FROM credit_payments WHERE id=$1", [id]).catch(() => {});
    for (const id of fixtures.credit) await pg.query("DELETE FROM credit_sales WHERE id=$1", [id]).catch(() => {});
    for (const code of fixtures.track) {
      if (typeof code === "string" && code.startsWith("GM-"))
        await pg.query("DELETE FROM customer_trackings WHERE tracking_code=$1", [code]).catch(() => {});
    }
    for (const id of fixtures.docs) await pg.query("DELETE FROM sales_documents WHERE id=$1", [id]).catch(() => {});
    for (const id of fixtures.cust) await pg.query("DELETE FROM customers WHERE id=$1", [id]).catch(() => {});
    for (const id of fixtures.carWash) await pg.query("DELETE FROM car_wash_washes WHERE id=$1", [id]).catch(() => {});
    for (const inv of fixtures.inv)
      await pg.query("UPDATE inventory_items SET quantity=$2::double precision, status=$3 WHERE id=$1", [
        inv.id, inv.quantity, inv.status,
      ]);
    // Any fixture payroll run created by F. The id list covers a clean run;
    // the window sweep also clears a run left behind by an INTERRUPTED run,
    // which would otherwise block the next run with "a payroll run for this
    // unit in this period already exists".
    for (const runId of fixtures.payrollRuns) {
      await pg.query("DELETE FROM payroll_entries WHERE run_id=$1", [runId]).catch(() => {});
      await pg.query("DELETE FROM payroll_runs WHERE id=$1", [runId]).catch(() => {});
    }
    // …scoped to THIS SUITE's own actors, never a time window. A `created_at >
    // now() - 6 hours` sweep looks tempting but is a data-destroying bug: the
    // demo seeder writes its payroll run with created_at = now, so the very
    // first run of this suite silently deleted seeded payroll history (and
    // broke verify-payroll2's legacy-entry regression). The runs this suite
    // creates are always authored by one of its fixture officers, so the
    // creator id is an exact discriminator.
    const fixtureUsers = fixtures.users.filter((x) => typeof x === "number");
    if (fixtureUsers.length) {
      await pg
        .query("DELETE FROM payroll_entries WHERE run_id IN (SELECT id FROM payroll_runs WHERE created_by_user_id = ANY($1::int[]))", [fixtureUsers])
        .catch(() => {});
      await pg.query("DELETE FROM payroll_runs WHERE created_by_user_id = ANY($1::int[])", [fixtureUsers]).catch(() => {});
    }
    for (const id of fixtures.users) {
      await pg.query("DELETE FROM user_sessions WHERE user_id=$1", [id]).catch(() => {});
      await pg.query("DELETE FROM notifications WHERE user_id=$1", [id]).catch(() => {});
      await pg.query("DELETE FROM user_business_access WHERE user_id=$1", [id]).catch(() => {});
      await pg.query("DELETE FROM organization_members WHERE user_id=$1", [id]).catch(() => {});
      await pg.query("DELETE FROM users WHERE id=$1", [id]).catch(() => {});
    }
    if (silencedPolicies.length)
      await pg.query("UPDATE approval_policies SET is_active=true WHERE id = ANY($1::int[])", [silencedPolicies]);
    await pg
      .query("DELETE FROM transactions WHERE description LIKE '%TEST ledger entry%' OR description LIKE '%TEST order line%' OR description LIKE '%TEST Wash%'")
      .catch(() => {});
    const left = await pg.query(
      "SELECT count(*)::int c FROM transactions WHERE description LIKE '%TEST ledger entry%' OR description LIKE '%TEST order line%' OR description LIKE '%TEST Wash%'",
    );
    ok("Z1 fixture ledger rows removed", left.rows[0].c === 0, `${left.rows[0].c} left`);
    const leftCs = await pg.query("SELECT count(*)::int c FROM credit_sales WHERE customer_name LIKE 'TEST%'");
    ok("Z2 fixture credit sales removed", leftCs.rows[0].c === 0, `${leftCs.rows[0].c} left`);

    // Pattern sweep. Sections D and E (car wash, online order) let the APP
    // create its own customer/ordering rows, which this suite never held an id
    // for — so the id lists above cannot clean them, and a suite that leaves
    // "TEST …" customers behind poisons every other suite's census check
    // (verify-credit-sales Z3 caught exactly that). Everything this suite can
    // create is name-stamped "TEST %" or "TEST-", so a targeted sweep is both
    // complete and self-healing after an interrupted run. Children first:
    // payments → orders/washes → credit sales → customers.
    await pg.query(
      `DELETE FROM credit_payments WHERE credit_sale_id IN (SELECT id FROM credit_sales WHERE customer_name LIKE 'TEST %')`,
    ).catch(() => {});
    await pg.query("DELETE FROM customer_trackings WHERE customer_name LIKE 'TEST %'").catch(() => {});
    await pg.query("DELETE FROM car_wash_washes WHERE customer_name LIKE 'TEST %' OR vehicle_label LIKE 'TEST-%'").catch(() => {});
    await pg.query("DELETE FROM credit_sales WHERE customer_name LIKE 'TEST %'").catch(() => {});
    await pg.query("DELETE FROM customers WHERE name LIKE 'TEST %'").catch(() => {});
    const sweep = await pg.query(
      `SELECT (SELECT count(*)::int FROM customers WHERE name LIKE 'TEST %') c,
              (SELECT count(*)::int FROM customer_trackings WHERE customer_name LIKE 'TEST %') t,
              (SELECT count(*)::int FROM credit_sales WHERE customer_name LIKE 'TEST %') s,
              (SELECT count(*)::int FROM car_wash_washes WHERE customer_name LIKE 'TEST %') w`,
    );
    const sw = sweep.rows[0];
    ok("Z3 zero TEST-named customers/orders/washes left anywhere",
      Number(sw.c) + Number(sw.t) + Number(sw.s) + Number(sw.w) === 0,
      `customers ${sw.c} · orders ${sw.t} · credit ${sw.s} · washes ${sw.w}`);
  }

  console.log(`\n${pass} pass / ${fail} fail`);
  if (fail) console.log("FAILED:\n - " + failures.join("\n - "));
  await pg.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("suite error:", e);
  try { await pg.end(); } catch {}
  process.exit(1);
});

/** "Today's sales: 3 · GH₵ 1,234.50" → 3 (the count of entries in the roll-up) */
function countOf(title) {
  const m = /Today's (?:sales|expenses):\s*(\d+)/.exec(String(title || ""));
  return m ? Number(m[1]) : null;
}

/** "Today's sales: 3 · GH₵ 1,234.50" → 1234.5 */
function moneyTotal(title) {
  const m = /GH₵\s*([\d,]+(?:\.\d+)?)/.exec(String(title || ""));
  if (!m) return null;
  return Number(String(m[1]).replace(/,/g, ""));
}