/**
 * fixture-purge — one idempotent purger for all suite/demo fixtures (H3).
 *
 * Suites that create fixture orgs/businesses/users (multiowner-verify MW-*,
 * audit-notify-verify AU @demo.local, verify-finance-allproducts-fresh TEST
 * units, misc "TEST %"-named rows) used to leave them behind whenever a run
 * crashed or skipped cleanup, polluting the live demo tenant.
 *
 * This library purges by explicit id or by known-safe fixture MATCH patterns.
 * Patterns are deliberately narrow (suite-only naming domains) so real
 * user/business data can never match:
 *   businesses: name/code LIKE 'MW-%' | 'TEST%' | 'Unrelated Biz %' | 'kkkkk'
 *   organizations: name LIKE 'MW-%' | 'AU Unrelated Org %' | 'TEST%'
 *   users: name 'TEST %' | email 'test.%' | '%@demo.local' | '%@mw-test.local'
 *   customers: name LIKE 'TEST %'
 *   notifications: actor/title/body carrying fixture tokens
 * Never matches: the intentional watermark demo ("WM … Org 2", "AU WM …").
 *
 * Callers: dev-tooling/purge-test-rows.mjs (CLI + bootstrap hook), and the
 * suites themselves in a finally-cleanup (self-cleaning by default; suites
 * can opt out with KEEP=1 for forensics).
 */

export const BIZ_TABLES = [
  "universal_exports","inventory_downloads","ai_insights","asset_audit_logs","asset_downloads",
  "audit_assignments","audit_reviews","audit_trail",
  "block_factory_checklists","block_factory_deliveries","block_factory_logs","block_factory_orders",
  "block_qc_checks","block_types","business_insights","business_metrics",
  "checklist_entries","checklist_templates","credit_payments","credit_sales","customer_trackings",
  "daily_notes","fulfillment_methods","fulfillment_options","goods_receipts","notifications",
  "order_payments","payroll_attendance","payroll_entries","payroll_runs","pickup_locations",
  "record_deletion_logs","scenario_simulations","service_areas","supplier_orders",
  "transport_bookings","transport_fuel_logs","transport_geofences","transport_maintenance",
  "transport_tracker_violations","transport_trips","transport_vehicle_checklists","transport_vehicles",
  "user_business_access",
  "aquaculture_batches","aquaculture_checklists","aquaculture_feed_logs","aquaculture_harvests",
  "aquaculture_logs","aquaculture_ponds","aquaculture_water_quality_logs","aquaculture_weight_logs",
  "assets","attendance_logs",
  "car_wash_activities","car_wash_bookings","car_wash_logs","car_wash_services","car_wash_washes",
  "cctv_cameras",
  "electronics_logs","electronics_orders","electronics_purchases","electronics_serials","electronics_warranties",
  "employee_documents","employee_history","employees","expense_categories",
  "hardware_deliveries","hardware_logs","hardware_orders","hardware_purchases","inventory_items","livestock_logs",
  "poultry_checklists","poultry_feed_logs","poultry_flocks","poultry_health_records","poultry_logs",
  "poultry_production","poultry_products","poultry_water_logs","poultry_weight_logs",
  "restaurant_logs","restaurant_menu_items","restaurant_orders","restaurant_purchases","restaurant_waste",
  "sales_documents",
  "telecom_activities","telecom_lines","telecom_txns","telecom_vouchers","telecom_wifi_packages",
  "transactions",
];

export const BIZ_NAME_PATTERNS = ["MW-%", "TEST%", "TEST %", "Unrelated Biz %", "kkkkk"];
export const ORG_NAME_PATTERNS = ["MW-%", "AU Unrelated Org %", "TEST%", "TEST %"];
export const USER_EMAIL_PATTERNS = ["%@demo.local", "%@mw-test.local", "test.%"];
export const USER_NAME_PATTERNS = ["TEST %", "TEST%", "Auditor One %", "Assignee Worker %", "Shared Worker %", "Unrelated Owner %"];

// Inline ONLY trouble-free values (ints + our own constant patterns) into
// simple-protocol statements: on PGlite's socket multiplexer an extended-
// protocol error response later desyncs the connection (the purge touches
// tables whose columns may not exist — swallowed below). Identical SQL on
// real Postgres; impossible to inject since no value is user-supplied here.
function inlineParams(sql, params = []) {
  let out = sql;
  for (let i = params.length; i >= 1; i--) {
    const v = params[i - 1];
    const lit = typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
    out = out.replace(new RegExp(`\\$${i}\\b`, "g"), lit);
  }
  return out;
}
async function del(pg, sql, params) {
  try { return (await pg.query(inlineParams(sql, params))).rowCount || 0; } catch { return 0; }
}

/** Purge one business by id — every soft-referenced table, then the row. */
export async function purgeBusinessId(pg, id) {
  let n = 0;
  for (const t of BIZ_TABLES) n += await del(pg, `DELETE FROM ${t} WHERE business_id=$1`, [id]);
  // Some of the paired tables also carry owner_id = business-owner org id —
  // resolved from the biz row before deletion below (nothing to do here).
  n += await del(pg, `DELETE FROM businesses WHERE id=$1`, [id]);
  return n;
}

/** Purge one organization by id — members/types first (hard FKs), then row. */
export async function purgeOrganizationId(pg, id) {
  // users that exist ONLY in this org get purged with it
  const onlyHere = (await pg.query(
    `SELECT user_id FROM organization_members WHERE organization_id=$1
       AND user_id NOT IN (SELECT user_id FROM organization_members WHERE organization_id<>$1)`,
    [id])).rows.map((r) => r.user_id);
  await del(pg, `DELETE FROM organization_members WHERE organization_id=$1`, [id]);
  await del(pg, `DELETE FROM organization_business_types WHERE organization_id=$1`, [id]);
  // Org-keyed app tables (organization_id has a UNIQUE/soft contract in each)
  // — leaving these behind breaks re-provisioning on the reused ids.
  await del(pg, `DELETE FROM company_settings WHERE organization_id=$1 AND organization_id<>1`, [id]);
  await del(pg, `DELETE FROM customer_support_info WHERE organization_id=$1 AND organization_id<>1`, [id]);
  await del(pg, `DELETE FROM payroll_statutory_config WHERE organization_id=$1 AND organization_id<>1`, [id]);
  await del(pg, `DELETE FROM organizations WHERE id=$1`, [id]);
  for (const uid of onlyHere) await purgeUserId(pg, uid);
}

/** Purge one user by id — every user-linked table, then the row. */
export async function purgeUserId(pg, id) {
  const tables = [
    ["organization_members", "user_id"], ["user_business_access", "user_id"],
    ["user_sessions", "user_id"], ["notifications", "user_id"],
    ["push_subscriptions", "user_id"], ["audit_trail", "actor_user_id"],
    ["audit_reviews", "reviewer_user_id"], ["audit_reviews", "assigned_user_id"],
    ["audit_issue_updates", "actor_user_id"],
  ];
  let n = 0;
  // assigned_user_id / reviewer_user_id are references to users; nullify
  // reviews pinned to others (keep the paper trail, drop the fixture link).
  for (const [t, col] of tables) {
    if (t === "audit_reviews") { try { await pg.query(`UPDATE audit_reviews SET ${col}=NULL WHERE ${col}=$1`, [id]); } catch {} continue; }
    n += await del(pg, `DELETE FROM ${t} WHERE ${col}=$1`, [id]);
  }
  n += await del(pg, `DELETE FROM users WHERE id=$1`, [id]);
  return n;
}

/**
 * Purge every row matching the known-safe fixture patterns (+ optional
 * extras for a specific suite run, e.g. its tag). Returns a summary tally.
 */
export async function purgeByPatterns(pg, extra = {}) {
  const out = { businesses: 0, organizations: 0, users: 0, customers: 0, notifications: 0 };
  const bizPats = [...BIZ_NAME_PATTERNS, ...(extra.biz || [])];
  const { rows: biz } = await pg.query(
    `SELECT id FROM businesses WHERE ${bizPats.map((_, i) => `name ILIKE $${i * 2 + 1} OR code ILIKE $${i * 2 + 2}`).join(" OR ")}`,
    bizPats.flatMap((p) => [p, p]),
  );
  for (const b of biz) { await purgeBusinessId(pg, b.id); out.businesses++; }

  const orgPats = [...ORG_NAME_PATTERNS, ...(extra.org || [])];
  const { rows: orgs } = await pg.query(
    `SELECT id FROM organizations WHERE ${orgPats.map((_, i) => `name ILIKE $${i + 1}`).join(" OR ")}`,
    orgPats,
  );
  for (const o of orgs) { await purgeOrganizationId(pg, o.id); out.organizations++; }

  const userPats = [...USER_EMAIL_PATTERNS, ...(extra.userEmail || [])];
  const namePats = [...USER_NAME_PATTERNS, ...(extra.userName || [])];
  const { rows: us } = await pg.query(
    `SELECT id FROM users WHERE ${[
      ...userPats.map((_, i) => `email ILIKE $${i + 1}`),
      ...namePats.map((_, i) => `name ILIKE $${userPats.length + i + 1}`),
    ].join(" OR ")}`,
    [...userPats, ...namePats],
  );
  for (const u of us) { await purgeUserId(pg, u.id); out.users++; }

  out.customers += await del(pg, `DELETE FROM customers WHERE name ILIKE 'TEST %'`, []);
  out.notifications += await del(
    pg,
    `DELETE FROM notifications WHERE actor_name ILIKE 'Auditor One %'
       OR title ILIKE 'TEST%' OR body ILIKE 'TEST%' OR title ILIKE '%MW-%' OR body ILIKE '%MW-%'`,
    [],
  );
  return out;
}
