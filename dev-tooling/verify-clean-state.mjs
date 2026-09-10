#!/usr/bin/env node
/**
 * Clean-state acceptance audit (API + DB).
 *
 * Owner directive: every newly created business and every reset business must
 * start with ZERO sample / test data, and all dashboards & sections must read
 * from live (empty) data with correct empty states — across every business
 * type and branch.
 *
 * This suite verifies, against the running app + Postgres:
 *   S1. New-business provisioning — for ALL 9 business types, every business-
 *       scoped table is empty except the zero-based metrics row and the
 *       type's daily-checklist template scaffold (operational config, not
 *       business records). No starter inventory / sample service catalogues.
 *   S2. Module GET routes serve EMPTY master lists for brand-new units
 *       (Restaurant menu, Poultry master product list, Block Factory block
 *       types, Car Wash service catalogue, Telecom lines + Wi-Fi packages).
 *   S3. Business reset (POST /api/businesses/[id], resetMasterLists=true)
 *       wipes every seeded record and re-seeds the exact factory-fresh
 *       workspace — nothing sample remains.
 *
 * Run with: node dev-tooling/verify-clean-state.mjs
 * (requires the app running on http://localhost:3000)
 */

const BASE = "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const DB = "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const client = new pg.Client(DB);
await client.connect();
const q = (s, p = []) => client.query(s, p);
const q1 = async (s, p = []) => (await client.query(s, p)).rows[0];

async function apiLogin(cred) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: cred.email, password: cred.pw }),
  });
  const j = await r.json();
  if (!r.ok || !j.success) throw new Error(`api login failed ${cred.email}: ${JSON.stringify(j)}`);
  return j.sessionToken;
}

const H = (token) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
});

async function api(method, path, token, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: H(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

// Every business-scoped table in src/db/schema.ts (businessId present).
const BUSINESS_SCOPED = [
  "ai_insights", "aquaculture_batches", "aquaculture_checklists",
  "aquaculture_feed_logs", "aquaculture_harvests", "aquaculture_logs",
  "aquaculture_ponds", "aquaculture_water_quality_logs", "aquaculture_weight_logs",
  "assets", "attendance_logs", "audit_assignments", "audit_reviews", "audit_trail",
  "block_factory_checklists", "block_factory_deliveries", "block_factory_logs",
  "block_factory_orders", "block_qc_checks", "block_types", "business_insights",
  "business_metrics", "car_wash_activities", "car_wash_bookings", "car_wash_logs",
  "car_wash_services", "car_wash_washes", "cctv_cameras", "checklist_entries",
  "checklist_templates", "credit_payments", "credit_sales", "customer_trackings",
  "customers", "daily_notes", "electronics_logs", "electronics_orders",
  "electronics_purchases", "electronics_serials", "electronics_warranties",
  "employee_documents", "employee_history", "employees", "expense_categories",
  "hardware_deliveries", "hardware_logs", "hardware_orders", "hardware_purchases",
  "inventory_items", "livestock_logs", "notifications", "payroll_attendance",
  "payroll_entries", "payroll_runs", "pickup_locations", "poultry_checklists",
  "poultry_feed_logs", "poultry_flocks", "poultry_health_records", "poultry_logs",
  "poultry_production", "poultry_products", "poultry_water_logs", "poultry_weight_logs",
  "restaurant_logs", "restaurant_menu_items", "restaurant_orders",
  "restaurant_purchases", "restaurant_waste", "sales_documents", "service_areas",
  "telecom_activities", "telecom_lines", "telecom_txns", "telecom_vouchers",
  "telecom_wifi_packages", "transactions", "universal_exports", "user_business_access",
];

// These are deliberately NOT empty on a fresh business: the zero-based metrics
// row and the type's daily-checklist template scaffold (operational config,
// not sample/test data). user_business_access stays empty for OWNER-created
// units (the OWNER always sees everything).
const SCAFFOLD = new Set(["business_metrics", "checklist_templates", "user_business_access"]);

/** Assert a business's business-scoped tables are clean. Returns list of dirty tables. */
async function assertClean(businessId, label) {
  const dirty = [];
  for (const table of BUSINESS_SCOPED) {
    if (SCAFFOLD.has(table)) continue;
    const r = await q(`SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`, [businessId]);
    if (r.rows[0].n !== 0) dirty.push(`${table}=${r.rows[0].n}`);
  }
  ok(`${label}: all ${BUSINESS_SCOPED.length - SCAFFOLD.size} business tables empty`, dirty.length === 0,
    dirty.slice(0, 12).join(", ") + (dirty.length > 12 ? ` …+${dirty.length - 12}` : ""));
  return dirty;
}

/** Assert the single zero-based metrics row. */
async function assertZeroMetrics(businessId, label) {
  const rows = (await q(`SELECT * FROM business_metrics WHERE business_id = $1`, [businessId])).rows;
  const one = rows.length === 1;
  const zero = one &&
    Number(rows[0].revenue_ghs) === 0 &&
    Number(rows[0].expenses_ghs) === 0 &&
    Number(rows[0].net_profit_ghs) === 0 &&
    Number(rows[0].cash_flow_ghs) === 0 &&
    Number(rows[0].inventory_value_ghs) === 0 &&
    Number(rows[0].growth_rate_percent) === 0;
  ok(`${label}: exactly 1 zero-based metrics row`, one && zero,
    one ? JSON.stringify({ rev: rows[0].revenue_ghs, exp: rows[0].expenses_ghs, inv: rows[0].inventory_value_ghs }) : `rows=${rows.length}`);
}

async function assertChecklistTemplates(businessId, label) {
  const r = await q(`SELECT count(*)::int AS n FROM checklist_templates WHERE business_id = $1`, [businessId]);
  ok(`${label}: daily-checklist template scaffold present (>0)`, r.rows[0].n > 0, `n=${r.rows[0].n}`);
}

const BUSINESS_TYPES = [
  "Poultry Farm",
  "Block Factory",
  "Aquaculture",
  "Livestock",
  "Restaurant & Food",
  "Electronic Shop",
  "Car Wash",
  "Hardware Store",
  "Telecom & Digital Services",
];

async function createBusiness(token, category, name, code) {
  const res = await api("POST", "/api/businesses", token, {
    name,
    code,
    category,
    region: "Greater Accra",
    district: "Accra Metropolitan",
    town: "Accra",
    managerName: "Audit Manager",
    contactPhone: "+233 24 000 0000",
    initialCapitalGhs: 50000,
    monthlyTargetRevenueGhs: 20000,
  });
  return res;
}

async function deleteBusiness(token, id, code) {
  return api("DELETE", `/api/businesses/${id}`, token, { confirmCode: code });
}

const created = []; // { id, code } for cleanup

async function main() {
  const token = await apiLogin(OWNER);
  const tag = Date.now().toString().slice(-6);

  // ── S1. New business → completely clean, every type ───────────────────
  console.log("\n── S1. New business provisioning (all 9 types) ──");
  for (const type of BUSINESS_TYPES) {
    const code = `AUD-${type.replace(/[^A-Za-z]/g, "").slice(0, 6).toUpperCase()}-${tag}`;
    const res = await createBusiness(token, type, `Clean Audit ${type}`, code);
    const biz = res.json?.business;
    const prov = res.json?.provisioned;
    ok(`S1 [${type}]: created (${res.status})`, res.status === 200 && !!biz, JSON.stringify(res.json?.error || "").slice(0, 120));
    if (!biz) continue;
    created.push({ id: biz.id, code: biz.code, type });

    // Provisioning must not have seeded any samples.
    ok(`S1 [${type}]: no starter inventory seeded`, (prov?.starterItems ?? -1) === 0, `starterItems=${prov?.starterItems}`);
    ok(`S1 [${type}]: no starter-kit cost booked`, (prov?.starterKitCostGhs ?? -1) === 0, `cost=${prov?.starterKitCostGhs}`);
    ok(`S1 [${type}]: no sample Car Wash services`, (prov?.carWashServices ?? -1) === 0, `carWashServices=${prov?.carWashServices}`);
    ok(`S1 [${type}]: no sample Telecom lines`, (prov?.telecomLines ?? -1) === 0, `telecomLines=${prov?.telecomLines}`);
    ok(`S1 [${type}]: no sample Wi-Fi packages`, (prov?.telecomWifiPackages ?? -1) === 0, `packages=${prov?.telecomWifiPackages}`);

    await assertClean(biz.id, `S1 [${type}]`);
    await assertZeroMetrics(biz.id, `S1 [${type}]`);
    await assertChecklistTemplates(biz.id, `S1 [${type}]`);
  }

  // ── S2. Module GET routes serve EMPTY master lists for new units ─────
  console.log("\n── S2. Module GET routes — empty master lists for new units ──");
  const needBiz = async (type) => {
    let b = created.find((c) => c.type === type);
    if (!b) {
      const res = await createBusiness(token, type, `Clean Audit ${type}`, `AUD-MOD-${type.replace(/[^A-Za-z]/g, "").slice(0, 6).toUpperCase()}-${tag}`);
      const biz = res.json?.business;
      b = { id: biz.id, code: biz.code, type };
      created.push(b);
    }
    return b;
  };

  const poultry = await needBiz("Poultry Farm");
  let r = await api("GET", `/api/poultry?businessId=${poultry.id}`, token);
  ok("S2 [Poultry]: master product list empty", r.json?.success && (r.json?.products || []).length === 0,
    `products=${r.json?.products?.length ?? JSON.stringify(r.json?.error)}`);

  const block = await needBiz("Block Factory");
  r = await api("GET", `/api/block-factory?businessId=${block.id}`, token);
  ok("S2 [Block Factory]: block type master list empty", r.json?.success && (r.json?.blockTypes || []).length === 0,
    `blockTypes=${r.json?.blockTypes?.length ?? JSON.stringify(r.json?.error)}`);

  const restaurant = await needBiz("Restaurant & Food");
  r = await api("GET", `/api/restaurant?businessId=${restaurant.id}`, token);
  ok("S2 [Restaurant]: menu empty", r.json?.success && (r.json?.menu || []).length === 0,
    `menu=${r.json?.menu?.length ?? JSON.stringify(r.json?.error)}`);

  const wash = await needBiz("Car Wash");
  r = await api("GET", `/api/carwash?businessId=${wash.id}`, token);
  ok("S2 [Car Wash]: service catalogue empty", r.json?.success && (r.json?.services || []).length === 0,
    `services=${r.json?.services?.length ?? JSON.stringify(r.json?.error)}`);

  const telecom = await needBiz("Telecom & Digital Services");
  r = await api("GET", `/api/telecom?businessId=${telecom.id}`, token);
  ok("S2 [Telecom]: agent lines empty", r.json?.success && (r.json?.lines || []).length === 0,
    `lines=${r.json?.lines?.length ?? JSON.stringify(r.json?.error)}`);
  ok("S2 [Telecom]: Wi-Fi packages empty", r.json?.success && (r.json?.packages || []).length === 0,
    `packages=${r.json?.packages?.length ?? JSON.stringify(r.json?.error)}`);

  // ── S3. Reset → factory-fresh clean state ─────────────────────────────
  console.log("\n── S3. Reset wipes everything and re-seeds a clean workspace ──");
  // Seed sample data into three typed units, then reset each.
  const seedCases = [
    { type: "Poultry Farm", label: "Poultry" },
    { type: "Block Factory", label: "Block" },
    { type: "Restaurant & Food", label: "Restaurant" },
  ];
  for (const sc of seedCases) {
    const b = await needBiz(sc.type);
    // Seed real records through the public APIs.
    const exp = await api("POST", "/api/transactions", token, {
      businessId: b.id, type: "EXPENSE", category: `Sample audit expense (${tag})`,
      amountGhs: 150, paymentMethod: "CASH", description: `Sample expense ${tag}`,
    });
    ok(`S3 [${sc.label}]: seeded expense`, exp.json?.success === true, JSON.stringify(exp.json?.error || "").slice(0, 100));

    if (sc.type === "Poultry Farm") {
      await api("POST", "/api/poultry", token, { entity: "PRODUCT", data: { name: `Sample Eggs ${tag}`, unit: "Trays", category: "Poultry Products", businessId: b.id } });
    } else if (sc.type === "Block Factory") {
      await api("POST", "/api/block-factory", token, { entity: "BLOCK_TYPE", data: { name: `Sample Block ${tag}`, defaultUnitPriceGhs: 12, createInventoryItem: false, businessId: b.id } });
    } else {
      await api("POST", "/api/restaurant", token, { entity: "MENU_ITEM", data: { name: `Sample Dish ${tag}`, category: "MAIN", priceGhs: 45, businessId: b.id } });
    }

    const before = await q1(`SELECT count(*)::int AS n FROM transactions WHERE business_id = $1`, [b.id]);
    ok(`S3 [${sc.label}]: data present before reset`, Number(before.n) >= 1, `transactions=${before.n}`);

    const reset = await api("POST", `/api/businesses/${b.id}`, token, { confirmCode: b.code, resetMasterLists: true });
    ok(`S3 [${sc.label}]: reset accepted`, reset.json?.success === true, JSON.stringify(reset.json?.error || "").slice(0, 120));

    await assertClean(b.id, `S3 [${sc.label}] after reset`);
    await assertZeroMetrics(b.id, `S3 [${sc.label}] after reset`);
    await assertChecklistTemplates(b.id, `S3 [${sc.label}] after reset`);

    // Master lists specifically wiped.
    const masterChecks = {
      "Poultry Farm": ["poultry_products"],
      "Block Factory": ["block_types"],
      "Restaurant & Food": ["restaurant_menu_items"],
    }[sc.type];
    for (const t of masterChecks) {
      const c = await q1(`SELECT count(*)::int AS n FROM ${t} WHERE business_id = $1`, [b.id]);
      ok(`S3 [${sc.label}]: ${t} wiped`, Number(c.n) === 0, `n=${c.n}`);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────
  console.log("\n── Cleanup ──");
  for (const b of created) {
    const d = await deleteBusiness(token, b.id, b.code);
    if (d.json?.success !== true) console.error(`⚠️ cleanup failed for ${b.code}:`, d.json?.error);
  }
  const leftovers = [];
  for (const b of created) {
    const row = await q1(`SELECT id FROM businesses WHERE id = $1`, [b.id]);
    if (row) leftovers.push(b.code);
  }
  ok("cleanup: all audit businesses deleted", leftovers.length === 0, leftovers.join(","));

  console.log(`\n${passed} passed, ${failed} failed`);
  await client.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  try { await client.end(); } catch {}
  process.exit(1);
});
