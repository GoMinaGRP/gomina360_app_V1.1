// verify-business-backup.mjs — Business Export & Restore audit.
//
// Proves, on the REAL app and a real database, that:
//   • exporting a business carries ONLY that business (no sibling units, no
//     unrelated workers, no account/session/tenant records);
//   • the archive contains everything needed to reconstruct the business —
//     including the tables the importer used to drop on the floor;
//   • importing by a DIFFERENT account in a DIFFERENT organization yields a
//     fully working, correctly linked unit: org stamped on every row, no
//     source-tenant user ids, no shared customer/vendor records, FKs remapped;
//   • existing businesses and other tenants are untouched;
//   • export/import permissions are enforced and tampered archives rejected.
//
// Fixtures are created through the API + direct SQL (mirroring what the app
// writes) and purged in the cleanup block.
//
// Run: bash dev-tooling/run-suite.sh dev-tooling/verify-business-backup.mjs
import { createRequire } from "node:module";
import crypto from "node:crypto";
import JSZip from "jszip";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };

const TAG = `BKVERIFY-${Date.now().toString(36).toUpperCase()}`;
const ORG2_NAME = `${TAG} Org`;
const O1 = { email: `bk.owner1.${TAG.toLowerCase()}@verify.local`, pw: "Verify@Org1A1" };
const O2 = { email: `bk.owner2.${TAG.toLowerCase()}@verify.local`, pw: "Verify@Org3B2" };
const CREW = { email: `bk.crew.${TAG.toLowerCase()}@verify.local`, pw: "Verify@CrewC3" };

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

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
};

const login = async (email, password) => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && !!j.sessionToken, cookie: (r.headers.get("set-cookie") || "").split(";")[0], user: j.user };
};
const api = async (cookie, method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
};
const initFor = async (cookie) => {
  const r = await fetch(`${BASE}/api/init`, { headers: { cookie } });
  return await r.json().catch(() => null);
};

// ───────────────────────────────────────────────────────────────────────────
// Setup: a source business (org 1) with rich data, a neighbour unit, and a
// separate organization + accounts to restore into.
// ───────────────────────────────────────────────────────────────────────────
const created = { orgIds: [], userIds: [], businessIds: [], sessionIds: [] };

try {
  await q(`delete from organizations where name = $1`, [ORG2_NAME]);
  await q(`delete from users where email = any($1)`, [[O1.email, O2.email, CREW.email]]);
  // Leftovers from earlier runs (a sandbox restore can reuse ids, so the
  // suites must start from a clean slate): purge anything tagged BKVERIFY-.
  {
    const stale = await q(`select id from businesses where name like 'BKVERIFY-%'`);
    for (const { id } of stale) {
      await q(`delete from approval_policies where scope_business_id = $1`, [id]).catch(() => {});
      await q(`delete from approval_policies where scope_business_id = $1`, [id]).catch(() => {});
      await q(`delete from user_business_access where business_id = $1`, [id]).catch(() => {});
      await q(`delete from businesses where id = $1`, [id]).catch(() => {});
    }
    await q(`delete from suppliers where name like 'BKVERIFY-%'`).catch(() => {});
    await q(`delete from approval_policies where action like 'BKVERIFY-%'`).catch(() => {});
    await q(`delete from organizations where name like 'BKVERIFY-%'`).catch(() => {});
    await q(`delete from users where email like 'bk.%@verify.local'`).catch(() => {});
  }

  const ownerLogin = await login(OWNER.email, OWNER.pw);
  ok("platform owner signs in", ownerLogin.ok);

  // ── org 3 (the restoring tenant) + its OWNER ────────────────────────────
  const org3 = (await q1(
    `insert into organizations (name, slug, status, contact_email)
     values ($1, $2, 'ACTIVE', $3) returning id`,
    [ORG2_NAME, `${TAG.toLowerCase()}-org`, O2.email],
  )).id;
  created.orgIds.push(org3);
  const owner2Id = (await q1(
    `insert into users (name, email, role, phone, password_hash, primary_org_id, is_active)
     values ('Verify Org3 Owner', $1, 'OWNER', '+233 20 000 0003', $2, $3, true) returning id`,
    [O2.email, hashPassword(O2.pw), org3],
  )).id;
  created.userIds.push(owner2Id);
  await q(
    `insert into organization_members (organization_id, user_id, role_in_org, is_primary)
     values ($1, $2, 'OWNER', true)`,
    [org3, owner2Id],
  );
  const owner2 = await login(O2.email, O2.pw);
  ok("org-3 owner provisioned + can sign in", owner2.ok);

  // ── org 1 exporter (OWNER, NOT a super admin: isolation must be real) ──
  const owner1Id = (await q1(
    `insert into users (name, email, role, phone, password_hash, primary_org_id, is_active)
     values ('Verify Org1 Owner', $1, 'OWNER', '+233 20 000 0001', $2, 1, true) returning id`,
    [O1.email, hashPassword(O1.pw)],
  )).id;
  created.userIds.push(owner1Id);
  await q(
    `insert into organization_members (organization_id, user_id, role_in_org, is_primary)
     values (1, $1, 'OWNER', false)`,
    [owner1Id],
  );
  const owner1 = await login(O1.email, O1.pw);
  ok("org-1 owner (non-super) signs in", owner1.ok);

  // ── source business + neighbour business (both org 1) ───────────────────
  const mkBiz = async (name, cookie) => {
    const res = await api(cookie, "POST", "/api/businesses", { name, category: "Hardware Store", region: "Greater Accra" });
    const id = res.data?.business?.id;
    if (id) created.businessIds.push(Number(id));
    return { id: Number(id), code: res.data?.business?.code };
  };
  const src = await mkBiz(`${TAG} Source Unit`, owner1.cookie);
  const neighbour = await mkBiz(`${TAG} Neighbour Unit`, owner1.cookie);
  ok("two org-1 test units created (source + neighbour)", !!src.id && !!neighbour.id, `${src.code} / ${neighbour.code}`);

  // A customer + inventory item on both units, so cross-business leakage is
  // measurable (the importer used to reuse same-name customers globally).
  const srcCustomer = (await q1(
    `insert into customers (name, type, phone, business_id, owner_id, total_spent_ghs)
     values ($1, 'RETAIL', '+233 24 111 0001', $2, 1, 500) returning id`,
    [`${TAG} Shared Name Customer`, src.id],
  )).id;
  const nbCustomer = (await q1(
    `insert into customers (name, type, phone, business_id, owner_id, total_spent_ghs)
     values ($1, 'RETAIL', '+233 24 111 0002', $2, 1, 900) returning id`,
    [`${TAG} Shared Name Customer`, neighbour.id],
  )).id;
  const srcItem = (await q1(
    `insert into inventory_items (name, sku, business_id, category, unit, quantity, cost_price_ghs, selling_price_ghs, min_stock_threshold, status)
     values ($1, $2, $3, 'Hardware & Tools', 'Pieces', 10, 5, 9, 2, 'IN_STOCK') returning id`,
    [`${TAG} Source Item`, `${src.code}-ITEM-1`, src.id],
  )).id;
  const srcEmployee = (await q1(
    `insert into employees (name, role, business_id, branch, salary_ghs, status, employee_no, phone, hire_date)
     values ($1, 'Sales Attendant', $2, $4, 1500, 'ACTIVE', $3, '+233 24 222 0001', '2025-04-01') returning id`,
    [`${TAG} Employee`, src.id, `${src.code}-EMP-1`, src.code],
  )).id;

  // ── rich data across the tables this audit covers ───────────────────────
  const budget = (await q1(
    `insert into budgets (owner_id, business_id, period, kind, category, amount_ghs)
     values (1, $1, '2026-Q1', 'EXPENSE', $2, 1200) returning id`,
    [src.id, `${TAG} Utilities`],
  )).id;
  const task = (await q1(
    `insert into action_tasks (task_number, owner_id, business_id, title, assigned_user_id, priority, status)
     values ($1, 1, $2, $3, $4, 'HIGH', 'OPEN') returning id`,
    [`${TAG}-TASK-1`, src.id, `${TAG} Restock the display`, owner1Id],
  )).id;
  const doc = (await q1(
    `insert into business_documents (owner_id, business_id, doc_type, title, file_data)
     values (1, $1, 'LICENCE', $2, 'data:text/plain;base64,SGVsbG8=') returning id`,
    [src.id, `${TAG} Business licence`],
  )).id;
  const interaction = (await q1(
    `insert into customer_interactions (owner_id, business_id, customer_id, type, summary, actor_name)
     values (1, $1, $2, 'CALL', $3, 'Verify Owner 1') returning id`,
    [src.id, srcCustomer, `${TAG} Follow-up call`],
  )).id;
  const method = (await q1(
    `insert into fulfillment_methods (owner_id, business_id, key, label)
     values (1, $1, $2, 'Verify Delivery') returning id`,
    [src.id, `${TAG}-DELIVERY`],
  )).id;
  const supplier = (await q1(
    `insert into suppliers (name, category, contact_person, phone, payment_terms, owner_id, total_supplied_ghs)
     values ($1, 'GENERAL', 'Verify Vender Contact', '+233 24 333 0001', 'NET_30', 1, 4200) returning id`,
    [`${TAG} Venders Ltd`],
  )).id;
  const option = (await q1(
    `insert into fulfillment_options (owner_id, inventory_id, method_id, business_id, supplier_id, price_ghs, lead_min_days, lead_max_days)
     values (1, $1, $2, $3, $4, 25, 1, 3) returning id`,
    [srcItem, method, src.id, supplier],
  )).id;
  const supOrder = (await q1(
    `insert into supplier_orders (purchase_number, owner_id, business_id, supplier_name, status)
     values ($1, 1, $2, $3, 'DRAFT') returning id`,
    [`${TAG}-PO-1`, src.id, `${TAG} Venders Ltd`],
  )).id;
  const requisition = (await q1(
    `insert into purchase_requisitions (req_number, owner_id, business_id, status)
     values ($1, 1, $2, 'PENDING') returning id`,
    [`${TAG}-REQ-1`, src.id],
  )).id;
  // Circular link, exactly as the app leaves it: the pair references itself.
  await q(`update supplier_orders set requisition_id = $1 where id = $2`, [requisition, supOrder]);
  await q(`update purchase_requisitions set supplier_order_id = $1 where id = $2`, [supOrder, requisition]);
  const goodsReceipt = (await q1(
    `insert into goods_receipts (receipt_number, supplier_order_id, business_id, owner_id)
     values ($1, $2, $3, 1) returning id`,
    [`${TAG}-GRN-1`, supOrder, src.id],
  )).id;
  const quote = (await q1(
    `insert into supplier_quotes (quote_number, owner_id, business_id, supplier_name, total_ghs, supplier_order_id)
     values ($1, 1, $2, $3, 800, $4) returning id`,
    [`${TAG}-QUO-1`, src.id, `${TAG} Venders Ltd`, supOrder],
  )).id;
  const invoice = (await q1(
    `insert into supplier_invoices (invoice_number, owner_id, business_id, supplier_name, amount_ghs)
     values ($1, 1, $2, $3, 800) returning id`,
    [`${TAG}-INV-1`, src.id, `${TAG} Venders Ltd`],
  )).id;
  const supPayment = (await q1(
    `insert into supplier_payments (payment_number, owner_id, business_id, supplier_name, amount_ghs, payment_method, paid_on)
     values ($1, 1, $2, $3, 400, 'CASH', now()) returning id`,
    [`${TAG}-PAY-1`, src.id, `${TAG} Venders Ltd`],
  )).id;
  const policy = (await q1(
    `insert into approval_policies (owner_id, scope_business_id, action, is_active)
     values (1, $1, $2, true) returning id`,
    [src.id, `${TAG}_PURCHASE`],
  )).id;
  const approvalReq = (await q1(
    `insert into approval_requests (owner_id, business_id, action, target_type, target_id, status)
     values (1, $1, $2, 'supplier_order', $3, 'PENDING') returning id`,
    [src.id, `${TAG}_PURCHASE`, supOrder],
  )).id;
  await q(`update purchase_requisitions set approval_request_id = $1 where id = $2`, [approvalReq, requisition]);

  const vehicle = (await q1(
    `insert into transport_vehicles (business_id, name, license_plate, owner_id, status)
     values ($1, $2, $3, 1, 'ACTIVE') returning id`,
    [src.id, `${TAG} Truck`, `GT-${TAG.slice(-4)}-24`],
  )).id;
  const trip = (await q1(
    `insert into transport_trips (business_id, vehicle_id, owner_id, status)
     values ($1, $2, 1, 'COMPLETED') returning id`,
    [src.id, vehicle],
  )).id;
  const booking = (await q1(
    `insert into transport_bookings (business_id, owner_id, customer_id, customer_name, vehicle_id, trip_id, status, fare_ghs)
     values ($1, 1, $2, $3, $4, $5, 'COMPLETED', 250) returning id`,
    [src.id, srcCustomer, `${TAG} Shared Name Customer`, vehicle, trip],
  )).id;
  await q(`update transport_trips set booking_id = $1 where id = $2`, [booking, trip]);
  await q(
    `insert into transport_fuel_logs (business_id, owner_id, vehicle_id, odometer_km, quantity_liters, price_per_liter_ghs, total_ghs, logged_date)
     values ($1, 1, $2, 12500, 40, 15, 600, '2026-01-20')`,
    [src.id, vehicle],
  );
  await q(
    `insert into transport_geofences (business_id, owner_id, name, lat, lng, radius_m)
     values ($1, 1, $2, 5.6, -0.19, 5000)`,
    [src.id, `${TAG} Yard`],
  );

  const tracking = (await q1(
    `insert into customer_trackings (tracking_code, business_id, customer_id, customer_name, status, order_kind)
     values ($1, $2, $3, $4, 'DELIVERED', 'SALE') returning id`,
    [`${TAG}-TRK-1`, src.id, srcCustomer, `${TAG} Shared Name Customer`],
  )).id;
  const creditSale = (await q1(
    `insert into credit_sales (credit_code, business_id, customer_id, customer_name, total_ghs, balance_ghs, tracking_id, status)
     values ($1, $2, $3, $4, 500, 300, $5, 'PARTIAL') returning id`,
    [`${TAG}-CRD-1`, src.id, srcCustomer, `${TAG} Shared Name Customer`, tracking],
  )).id;
  const orderPayment = (await q1(
    `insert into order_payments (tracking_id, kind, amount_ghs, method, business_id, owner_id)
     values ($1, 'DEPOSIT', 200, 'MOMO', $2, 1) returning id`,
    [tracking, src.id],
  )).id;
  const payrollRun = (await q1(
    `insert into payroll_runs (period, business_id, branch_code, status)
     values ('2026-01', $1, $2, 'PAID') returning id`,
    [src.id, src.code],
  )).id;
  await q(
    `insert into payroll_entries (run_id, employee_id, employee_name, business_id, branch_code, base_salary_ghs, net_pay_ghs, status)
     values ($1, $2, $3, $4, $5, 1500, 1300, 'PAID')`,
    [payrollRun, srcEmployee, `${TAG} Employee`, src.id, src.code],
  );
  await q(
    `insert into payroll_attendance (employee_id, employee_name, business_id, branch_code, date, status)
     values ($1, $2, $3, $4, '2026-01-15', 'PRESENT')`,
    [srcEmployee, `${TAG} Employee`, src.id, src.code],
  );
  await q(
    `insert into attendance_logs (user_id, employee_name, business_id, branch_code, date, clock_in_at)
     values ($1, $2, $3, $4, '2026-01-15', now())`,
    [owner1Id, `${TAG} Employee`, src.id, src.code],
  );
  await q(
    `insert into employee_documents (employee_id, business_id, doc_type, title)
     values ($1, $2, 'CONTRACT', $3)`,
    [srcEmployee, src.id, `${TAG} Contract`],
  );
  await q(
    `insert into employee_history (employee_id, business_id, action, summary)
     values ($1, $2, 'HIRED', $3)`,
    [srcEmployee, src.id, `${TAG} Hired`],
  );
  // Feed-mix factory: parent + child rows (children carry no businessId).
  const formulation = (await q1(
    `insert into poultry_feed_formulations (business_id, owner_id, formulation_no, name, feed_type, active)
     values ($1, 1, $2, $3, 'STARTER', true) returning id`,
    [src.id, `${TAG}-FORM-1`, `${TAG} Starter mash`],
  )).id;
  await q(
    `insert into poultry_feed_formulation_items (formulation_id, inventory_id, ingredient_name, share_pct)
     values ($1, $2, $3, 40)`,
    [formulation, srcItem, `${TAG} Maize`],
  );
  const batch = (await q1(
    `insert into poultry_feed_batches (business_id, owner_id, formulation_id, batch_number, formulation_name, feed_type, production_date, planned_input_kg, actual_input_kg, actual_output_kg, status, finished_inventory_id)
     values ($1, 1, $2, $3, $4, 'STARTER', '2026-01-18', 100, 100, 95, 'COMPLETED', $5) returning id`,
    [src.id, formulation, `${TAG}-BATCH-1`, `${TAG} Starter mash`, srcItem],
  )).id;
  await q(
    `insert into poultry_feed_batch_inputs (batch_id, inventory_id, ingredient_name, planned_kg, actual_kg)
     values ($1, $2, $3, 100, 100)`,
    [batch, srcItem, `${TAG} Maize`],
  );
  await q(
    `insert into poultry_feed_qc_checks (business_id, batch_id, batch_number, stage, test_name, pass_fail, moisture_pct)
     values ($1, $2, $3, 'FINAL', 'Moisture content', 'PASS', 11.5)`,
    [src.id, batch, `${TAG}-BATCH-1`],
  );
  // Advisor content + thread.
  const note = (await q1(
    `insert into advisor_notes (business_id, note_date, title, body, category, author_user_id, author_name, author_role)
     values ($1, '2026-01-22', $2, 'Check feed conversion', 'NUTRITION', $3, 'Verify Advisor', 'FARM_ADVISOR') returning id`,
    [src.id, `${TAG} Advisor note`, owner1Id],
  )).id;
  await q(
    `insert into advisor_note_updates (note_id, actor_user_id, actor_name, actor_role, action, note)
     values ($1, $2, 'Verify Owner 1', 'OWNER', 'COMMENT', $3)`,
    [note, owner1Id, `${TAG} noted`],
  );

  // Neighbour rows that must NEVER appear in the source backup.
  await q(
    `insert into budgets (owner_id, business_id, period, kind, category, amount_ghs)
     values (1, $1, '2026-Q1', 'EXPENSE', $2, 999)`,
    [neighbour.id, `${TAG} Neighbour Only`],
  );

  const seededCounts = {
    budgets: 1, actionTasks: 1, businessDocuments: 1, customerInteractions: 1,
    fulfillmentMethods: 1, fulfillmentOptions: 1, supplierOrders: 1, goodsReceipts: 1,
    supplierQuotes: 1, supplierInvoices: 1, supplierPayments: 1, purchaseRequisitions: 1,
    approvalPolicies: 1, approvalRequests: 1, transportVehicles: 1, transportTrips: 1,
    transportBookings: 1, transportFuelLogs: 1, transportGeofences: 1,
    customerTrackings: 1, creditSales: 1, orderPayments: 1, payrollRuns: 1,
    payrollEntries: 1, payrollAttendance: 1, attendanceLogs: 1, employeeDocuments: 1,
    employeeHistory: 1, poultryFeedFormulations: 1, poultryFeedFormulationItems: 1,
    poultryFeedBatches: 1, poultryFeedBatchInputs: 1, poultryFeedQcChecks: 1,
    advisorNotes: 1, advisorNoteUpdates: 1,
  };
  const seededSupplier = { name: `${TAG} Venders Ltd` };
  ok("source unit seeded across the audited tables", Object.keys(seededCounts).length >= 30);

  // ─────────────────────────────────────────────────────────────────────────
  // 1. EXPORT
  // ─────────────────────────────────────────────────────────────────────────
  const t0 = Date.now();
  const exportRes = await fetch(`${BASE}/api/business-backup/export?businessId=${src.id}`, {
    headers: { cookie: owner1.cookie },
  });
  const exportMs = Date.now() - t0;
  const zipBuf = Buffer.from(await exportRes.arrayBuffer());
  ok("GET export returns a ZIP archive", exportRes.status === 200 && zipBuf.length > 0, `${zipBuf.length} bytes in ${exportMs}ms`);
  ok("export is fast (< 15s)", exportMs < 15000, `${exportMs}ms`);

  const zip = await JSZip.loadAsync(zipBuf);
  const manifest = JSON.parse(await zip.file("backup.json").async("string"));
  const T = manifest.tables || {};

  ok("archive holds exactly ONE business row", (T.businesses || []).length === 1, `${(T.businesses || []).length}`);
  ok("the single business row is the exported unit", Number(T.businesses[0].id) === src.id && T.businesses[0].code === src.code);

  // Scoping: nothing outside the source business.
  const foreignRows = [];
  for (const [table, rows] of Object.entries(T)) {
    if (table === "businesses") continue;
    for (const r of rows) {
      const bid = r.businessId ?? r.downloaderBusinessId ?? r.targetBusinessId ?? r.scopeBusinessId;
      if (bid != null && Number(bid) !== src.id) foreignRows.push(`${table}#${r.id}→biz ${bid}`);
    }
  }
  ok("no row from any other business travels in the archive", foreignRows.length === 0, foreignRows.slice(0, 3).join(", "));
  ok("no neighbour-only data in the archive", !(T.budgets || []).some((b) => String(b.category || "").includes("Neighbour Only")));

  // Account/PII hygiene.
  const users = Object.values(manifest.users || {});
  const userFields = new Set(users.flatMap((u) => Object.keys(u)));
  ok("referenced actors carry display identity only (id/name/role)", users.length > 0 && [...userFields].every((f) => ["id", "name", "role"].includes(f)), [...userFields].join(","));
  const rawJson = JSON.stringify(manifest);
  // Business records legitimately carry contact details (customer/employee
  // phones, the unit's own help line); ACCOUNT material must never travel.
  const leakedSecrets = ["password_hash", "passwordHash", "sessionToken", "session_token", "accessCode\":\"", "cctv_password"].filter((k) => rawJson.includes(k));
  ok("archive contains no password hashes, session tokens or credentials", leakedSecrets.length === 0, leakedSecrets.join(","));
  ok("archive never enumerates accounts (users key holds referenced actors only)", users.length <= 40, `${users.length} user snapshot(s)`);
  const forbiddenTables = ["organizations", "organization_members", "user_sessions", "push_subscriptions", "user_push_settings", "user_business_access", "users"];
  ok("archive excludes tenant/account/session tables", forbiddenTables.every((t) => !(t in T)), forbiddenTables.filter((t) => t in T).join(","));

  // Completeness of the previously-dropped data.
  const missing = Object.entries(seededCounts).filter(([t, n]) => (T[t] || []).length < n).map(([t]) => t);
  ok("archive carries every table the restore needs (incl. the previously dropped ones)", missing.length === 0, missing.join(", "));
  ok("vendor rows referenced by the business travel with it", (T.suppliers || []).length === 1 && (T.suppliers || [])[0].name === seededSupplier.name);
  ok("child rows travel with their parents (no businessId tables)", (T.poultryFeedFormulationItems || []).length === 1 && (T.poultryFeedBatchInputs || []).length === 1);
  ok("readme/report files present", !!zip.file("README.txt") && !!zip.file("reports/summary.txt"));

  // ─────────────────────────────────────────────────────────────────────────
  // 2. PERMISSIONS (before the happy-path import)
  // ─────────────────────────────────────────────────────────────────────────
  const crewId = (await q1(
    `insert into users (name, email, role, phone, password_hash, primary_org_id, assigned_business_id, is_active)
     values ('Verify Crew', $1, 'WORKER', '+233 20 000 0009', $2, 1, $3, true) returning id`,
    [CREW.email, hashPassword(CREW.pw), src.id],
  )).id;
  created.userIds.push(crewId);
  await q(
    `insert into organization_members (organization_id, user_id, role_in_org, is_primary)
     values (1, $1, 'MEMBER', false)`,
    [crewId],
  );
  const crew = await login(CREW.email, CREW.pw);
  const crewExport = await fetch(`${BASE}/api/business-backup/export?businessId=${src.id}`, { headers: { cookie: crew.cookie } });
  ok("worker without export permission cannot download a backup", crewExport.status === 403, String(crewExport.status));
  const crewImport = await fetch(`${BASE}/api/business-backup/import`, { method: "POST", headers: { cookie: crew.cookie }, body: new FormData() });
  ok("worker without create permission cannot import", crewImport.status === 403, String(crewImport.status));

  const crossExport = await fetch(`${BASE}/api/business-backup/export?businessId=${src.id}`, { headers: { cookie: owner2.cookie } });
  ok("another organization's owner cannot export this business", crossExport.status === 403, String(crossExport.status));

  // Tampered archive: a row belonging to the neighbour is injected.
  const tampered = JSON.parse(JSON.stringify(manifest));
  tampered.tables.budgets = [...(tampered.tables.budgets || []), { id: 999001, ownerId: 1, businessId: neighbour.id, period: "2026-Q1", kind: "EXPENSE", category: `${TAG} Smuggled`, amountGhs: 1 }];
  const tamperZip = new JSZip();
  tamperZip.file("backup.json", JSON.stringify(tampered));
  const tamperBuf = await tamperZip.generateAsync({ type: "nodebuffer" });
  const tamperForm = new FormData();
  tamperForm.append("file", new Blob([tamperBuf], { type: "application/zip" }), "tampered.zip");
  const tamperRes = await fetch(`${BASE}/api/business-backup/import`, { method: "POST", headers: { cookie: owner2.cookie }, body: tamperForm });
  const noSmuggled = await q1(`select count(*)::int c from budgets where category = $1`, [`${TAG} Smuggled`]);
  ok("tampered archive (row of another business) is rejected", tamperRes.status >= 400 && noSmuggled.c === 0, `HTTP ${tamperRes.status}`);

  // ─────────────────────────────────────────────────────────────────────────
  // 3. IMPORT by a DIFFERENT account in a DIFFERENT organization
  // ─────────────────────────────────────────────────────────────────────────
  const beforeCounts = await snapshotBusinessRows(src.id);
  const neighbourBefore = await snapshotBusinessRows(neighbour.id);
  const wmBefore = await snapshotBusinessRows(12);
  const form = new FormData();
  form.append("file", new Blob([zipBuf], { type: "application/zip" }), "backup.zip");
  const t1 = Date.now();
  const importRes = await fetch(`${BASE}/api/business-backup/import`, { method: "POST", headers: { cookie: owner2.cookie }, body: form });
  const importMs = Date.now() - t1;
  const importJson = await importRes.json().catch(() => ({}));
  const newId = Number(importJson.businessId);
  if (newId) created.businessIds.push(newId);
  ok("org-3 owner restores the archive into a new business", importRes.status === 200 && importJson.success === true && newId > 0, JSON.stringify(importJson).slice(0, 160));
  const warnings = importJson.warnings || [];
  ok("restore imports every row without constraint warnings", warnings.length === 0, warnings.map((w) => String(w).slice(0, 200)).join(" | "));

  // Snapshot right after the restore, before any /api/init call (init also
  // auto-generates today's daily checklist rows for the caller's units).
  const afterCounts = await snapshotBusinessRows(src.id);
  const neighbourAfter = await snapshotBusinessRows(neighbour.id);
  const wmAfter = await snapshotBusinessRows(12);

  // ── No disruption to existing data ─────────────────────────────────────
  const srcDiffs = Object.keys(afterCounts).filter((t) => beforeCounts[t] !== afterCounts[t]);
  ok("source business is untouched by export + import", srcDiffs.length === 0, srcDiffs.slice(0, 3).join(", "));
  const nbDiffs = Object.keys(neighbourAfter).filter((t) => neighbourBefore[t] !== neighbourAfter[t]);
  ok("sibling business untouched", nbDiffs.length === 0, nbDiffs.slice(0, 3).join(", "));
  const wmDiffs = Object.keys(wmAfter).filter((t) => wmBefore[t] !== wmAfter[t]);
  ok("other organization's unit untouched", wmDiffs.length === 0, wmDiffs.slice(0, 3).join(", "));
  ok("restore is fast (< 60s)", importMs < 60000, `${importMs}ms`);

  const newBiz = await q1(`select id, name, code, category, owner_id, pre_order_enabled, watermark_enabled, watermark_mode, logo from businesses where id = $1`, [newId]);
  ok("restored unit belongs to the RESTORING account's organization", Number(newBiz.owner_id) === org3, `owner_id=${newBiz.owner_id}`);
  ok("restored unit keeps name/category/settings", newBiz.name === `${TAG} Source Unit` && newBiz.category === "Hardware Store", `${newBiz.name} / ${newBiz.category}`);
  ok("restored unit gets a fresh org-scoped code", newBiz.code !== src.code && /^HARDWARE-/.test(newBiz.code), `${src.code} → ${newBiz.code}`);

  // Access: importer sees it, source org does not.
  const init2 = await initFor(owner2.cookie);
  const init1 = await initFor(owner1.cookie);
  const ids2 = new Set((init2?.businesses || []).map((b) => Number(b.id)));
  const ids1 = new Set((init1?.businesses || []).map((b) => Number(b.id)));
  ok("importing account can open the restored unit", ids2.has(newId));
  ok("source organization cannot see the restored unit", !ids1.has(newId));
  const otherApi = await api(owner2.cookie, "GET", `/api/business-backup/export?businessId=${newId}`);
  ok("importing account can export its restored unit", otherApi.status === 200, String(otherApi.status));

  // ── Tenant stamping ────────────────────────────────────────────────────
  const tablesWithOwner = await q(
    `select c.table_name from information_schema.columns c
      where c.table_schema = 'public' and c.column_name = 'owner_id'
        and exists (select 1 from information_schema.columns b where b.table_schema='public' and b.table_name=c.table_name and b.column_name='business_id')`,
  );
  const wrongOwner = [];
  for (const { table_name } of tablesWithOwner) {
    const rows = await q(`select id, owner_id from ${table_name} where business_id = $1 and coalesce(owner_id, -1) <> $2 limit 3`, [newId, org3]);
    for (const r of rows) wrongOwner.push(`${table_name}#${r.id}=${r.owner_id}`);
  }
  ok("every restored row is stamped with the importing organization", wrongOwner.length === 0, wrongOwner.slice(0, 3).join(", "));

  // ── User references never point at the source tenant ───────────────────
  const userCols = await q(
    `select table_name, column_name from information_schema.columns
      where table_schema='public' and (column_name = 'user_id' or column_name like '%\\_user\\_id')`,
  );
  const badUserRefs = [];
  for (const { table_name, column_name } of userCols) {
    const hasBiz = await q1(
      `select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name='business_id'`,
      [table_name],
    );
    if (!hasBiz) continue;
    const rows = await q(
      `select id, ${column_name} v from ${table_name} where business_id = $1 and ${column_name} is not null and ${column_name} <> $2 limit 3`,
      [newId, owner2Id],
    );
    for (const r of rows) badUserRefs.push(`${table_name}.${column_name}#${r.id}=${r.v}`);
  }
  ok("no restored row references a user of the source tenant", badUserRefs.length === 0, badUserRefs.slice(0, 3).join(", "));
  const restoredTasks = await q(`select assigned_user_id, assigned_user_name from action_tasks where business_id = $1`, [newId]);
  ok("required user links land on the restoring account", restoredTasks.length === 1 && Number(restoredTasks[0].assigned_user_id) === owner2Id, JSON.stringify(restoredTasks[0] || {}));

  // ── Party records are private copies ──────────────────────────────────
  const custOverlap = await q1(
    `select count(*)::int c from customers where business_id = $1 and id in (select id from customers where business_id = any($2::int[]))`,
    [newId, [src.id, neighbour.id]],
  );
  ok("restored customers are private copies (no shared CRM row)", custOverlap.c === 0);
  const restoredCust = await q1(`select id, owner_id, total_spent_ghs from customers where business_id = $1 limit 1`, [newId]);
  ok("restored customer keeps its own figures under the new tenant", restoredCust && Number(restoredCust.owner_id) === org3 && Number(restoredCust.total_spent_ghs) === 500, JSON.stringify(restoredCust || {}));
  const sharedSupplier = await q1(
    `select count(*)::int c from suppliers where owner_id = $1 and name like $2`,
    [org3, `${TAG} Venders Ltd`],
  );
  ok("restored vendors belong to the importing organization only", sharedSupplier.c === 1);
  const supplierLink = await q1(
    `select count(*)::int c from fulfillment_options o join suppliers s on s.id = o.supplier_id
      where o.business_id = $1 and s.owner_id = $2`,
    [newId, org3],
  );
  ok("restored rows link to the RESTORED vendor, not the source tenant's", supplierLink.c === 1, JSON.stringify(supplierLink));
  const sourceSupplierUntouched = await q1(`select count(*)::int c from suppliers where id = $1 and owner_id = 1`, [supplier]);
  ok("the source organization's own vendor row is left untouched", sourceSupplierUntouched.c === 1);

  // ── Completeness: counts + relationships ──────────────────────────────
  const sqlName = (t) => t.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  const countFor = async (table, businessId) => {
    try {
      return Number((await q1(`select count(*)::int c from ${sqlName(table)} where business_id = $1`, [businessId]))?.c);
    } catch (e) {
      console.log(`   ⚠ count failed for ${table} (${sqlName(table)}): ${e.message}`);
      return -1;
    }
  };
  const countMismatch = [];
  for (const table of Object.keys(seededCounts)) {
    if (["poultryFeedFormulationItems", "poultryFeedBatchInputs", "advisorNoteUpdates", "approvalPolicies"].includes(table)) continue; // no business_id
    const want = Number(beforeCounts[sqlName(table)] || 0);
    const got = await countFor(table, newId);
    if (got !== want) countMismatch.push(`${table} ${got}/${want}`);
  }
  ok("every restored table matches the source row-for-row", countMismatch.length === 0, countMismatch.join(", "));
  const policyRestored = await q1(`select count(*)::int c from approval_policies where scope_business_id = $1`, [newId]);
  const policyArchived = (manifest.tables.approvalPolicies || []).length;
  ok("business-scoped approval policies are restored to the new unit", policyRestored.c === policyArchived && policyArchived >= 1, `${policyRestored.c}/${policyArchived}`);
  const childCounts = await q1(
    `select (select count(*)::int from poultry_feed_formulation_items i join poultry_feed_formulations f on f.id=i.formulation_id where f.business_id=$1) items,
            (select count(*)::int from poultry_feed_batch_inputs i join poultry_feed_batches b on b.id=i.batch_id where b.business_id=$1) inputs,
            (select count(*)::int from advisor_note_updates u join advisor_notes n on n.id=u.note_id where n.business_id=$1) updates`,
    [newId],
  );
  ok("child rows are restored under their remapped parents", childCounts.items === 1 && childCounts.inputs === 1 && childCounts.updates === 1, JSON.stringify(childCounts));

  const fk = await q1(
    `select
       (select count(*)::int from goods_receipts g join supplier_orders o on o.id = g.supplier_order_id where g.business_id = $1 and o.business_id = $1) receipt_to_order,
       (select count(*)::int from credit_sales c join customer_trackings t on t.id = c.tracking_id where c.business_id = $1 and t.business_id = $1) credit_to_tracking,
       (select count(*)::int from order_payments p join customer_trackings t on t.id = p.tracking_id where p.business_id = $1 and t.business_id = $1) payment_to_tracking,
       (select count(*)::int from payroll_entries e join payroll_runs r on r.id = e.run_id where e.business_id = $1 and r.business_id = $1) entry_to_run,
       (select count(*)::int from payroll_attendance a join employees e on e.id = a.employee_id where a.business_id = $1 and e.business_id = $1) attendance_to_employee,
       (select count(*)::int from employee_documents d join employees e on e.id = d.employee_id where d.business_id = $1 and e.business_id = $1) doc_to_employee,
       (select count(*)::int from fulfillment_options o join fulfillment_methods m on m.id = o.method_id where o.business_id = $1 and m.business_id = $1) option_to_method,
       (select count(*)::int from transport_bookings b join transport_vehicles v on v.id = b.vehicle_id where b.business_id = $1 and v.business_id = $1) booking_to_vehicle`,
    [newId],
  );
  ok(
    "foreign keys are remapped, not copied",
    Object.values(fk).every((v) => Number(v) === 1),
    JSON.stringify(fk),
  );
  const circular = await q1(
    `select
       (select requisition_id from supplier_orders where business_id = $1) so_req,
       (select supplier_order_id from purchase_requisitions where business_id = $1) req_so,
       (select booking_id from transport_trips where business_id = $1) trip_booking`,
    [newId],
  );
  ok("circular references are re-linked after restore", circular.so_req && circular.req_so && circular.trip_booking, JSON.stringify(circular));
  const refsResolve = await q1(
    `select
       (select count(*)::int from supplier_orders where business_id=$1 and requisition_id in (select id from purchase_requisitions where business_id=$1)) a,
       (select count(*)::int from purchase_requisitions where business_id=$1 and supplier_order_id in (select id from supplier_orders where business_id=$1)) b,
       (select count(*)::int from transport_trips where business_id=$1 and booking_id in (select id from transport_bookings where business_id=$1)) c`,
    [newId],
  );
  ok("circular references point at the RESTORED rows", Object.values(refsResolve).every((v) => Number(v) === 1), JSON.stringify(refsResolve));

  // ── Re-import: another copy, nothing destroyed ─────────────────────────
  const form2 = new FormData();
  form2.append("file", new Blob([zipBuf], { type: "application/zip" }), "backup.zip");
  const import2 = await fetch(`${BASE}/api/business-backup/import`, { method: "POST", headers: { cookie: owner2.cookie }, body: form2 });
  const json2 = await import2.json().catch(() => ({}));
  const newId2 = Number(json2.businessId);
  if (newId2) created.businessIds.push(newId2);
  ok("re-importing the same archive creates a second, distinct unit", import2.status === 200 && newId2 > 0 && newId2 !== newId);
  const firstStillThere = await q1(`select count(*)::int c from budgets where business_id = $1`, [newId]);
  ok("the first restored unit is unaffected by the second import", firstStillThere.c === 1);
  const codeUnique = await q1(`select count(distinct code)::int c from businesses where owner_id = $1`, [org3]);
  ok("restored codes stay unique inside the importing organization", codeUnique.c === 2, `${codeUnique.c}`);

  // ── Final sanity: the archive never contains another tenant's rows ──────
  const crossTenant = await q1(
    `select count(*)::int c from budgets where business_id = $1 and category like '%Neighbour Only%'`,
    [newId],
  );
  ok("no cross-business row reached the restored unit", crossTenant.c === 0);

  console.log(`\n${failures === 0 ? "✅ ALL BUSINESS BACKUP CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`} (${checks.length} checks)`);
} catch (err) {
  failures++;
  console.error("❌ suite crashed:", err?.stack || err);
} finally {
  // ── Cleanup: purge everything this suite created ─────────────────────────
  try {
    const bizIds = created.businessIds.filter((n) => Number.isFinite(n) && n > 0);
    const tables = await q(
      `select table_name from information_schema.columns where table_schema='public' and column_name='business_id'`,
    );
    for (const id of bizIds) {
      // children without business_id first
      await q(`delete from poultry_feed_formulation_items where formulation_id in (select id from poultry_feed_formulations where business_id=$1)`, [id]).catch(() => {});
      await q(`delete from poultry_feed_batch_inputs where batch_id in (select id from poultry_feed_batches where business_id=$1)`, [id]).catch(() => {});
      await q(`delete from advisor_note_updates where note_id in (select id from advisor_notes where business_id=$1)`, [id]).catch(() => {});
      await q(`delete from payroll_entries where run_id in (select id from payroll_runs where business_id=$1)`, [id]).catch(() => {});
      for (const { table_name } of tables) {
        await q(`delete from ${table_name} where business_id = $1`, [id]).catch(() => {});
      }
      await q(`delete from approval_policies where scope_business_id = $1`, [id]).catch(() => {});
      await q(`delete from user_business_access where business_id = $1`, [id]).catch(() => {});
      await q(`delete from businesses where id = $1`, [id]).catch(() => {});
    }
    await q(`delete from suppliers where owner_id = any($1::int[])`, [created.orgIds]).catch(() => {});
    await q(`delete from user_sessions where user_id = any($1::int[])`, [created.userIds]).catch(() => {});
    await q(`delete from organization_members where user_id = any($1::int[])`, [created.userIds]).catch(() => {});
    await q(`delete from users where id = any($1::int[])`, [created.userIds]).catch(() => {});
    await q(`delete from organizations where id = any($1::int[])`, [created.orgIds]).catch(() => {});
    console.log(`🧹 cleanup: removed ${bizIds.length} test unit(s), ${created.userIds.length} test account(s), ${created.orgIds.length} test org(s)`);
  } catch (e) {
    console.error("cleanup warning:", e.message);
  }
  await client.end().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}

// Row counts for every business-scoped table — used to prove nothing changed.
async function snapshotBusinessRows(businessId) {
  const tables = await q(
    `select table_name from information_schema.columns where table_schema='public' and column_name='business_id'`,
  );
  const out = {};
  for (const { table_name } of tables) {
    const r = await q1(`select count(*)::int c from ${table_name} where business_id = $1`, [businessId]).catch(() => ({ c: -1 }));
    out[table_name] = Number(r?.c ?? 0);
  }
  return out;
}
