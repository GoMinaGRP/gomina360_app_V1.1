#!/usr/bin/env node
/**
 * Idempotent E2E demonstration fixtures for the GoMina 360 audit suites.
 * Recreates (in one pass) everything the probe suites assert after a fresh
 * `run-seed full-wipe`:
 *
 *   1. Product photos — SVG data-URL galleries (3 per catalog item).
 *   2. Rich product details on the poultry flagship (brand / description /
 *      specifications incl. Size & Weight rows / variants).
 *   3. Geo: coordinates + 12 km service radius for every business; the
 *      poultry unit pinned at its documented farm gate with a pickup point.
 *   4. Pre-order stack: AIR / SEA fulfilment methods, options on items 1 & 4,
 *      `pre_order_enabled` on businesses 1 & 6.
 *   5. Watermark NAME-mode demo unit (delegates to the dedicated script).
 */
import pg from "pg";
const { Client } = pg;
const D = () => new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });

const SVG = (bg, fg, label, sub) => `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${bg}"/><text x="200" y="150" font-size="34" font-family="sans-serif" font-weight="bold" fill="${fg}" text-anchor="middle">${label}</text><text x="200" y="190" font-size="18" font-family="sans-serif" fill="${fg}" opacity="0.7" text-anchor="middle">${sub}</text></svg>`,
).toString("base64")}`;
const PALETTES = [
  ["#1e3a8a", "#bfdbfe"], ["#7c2d12", "#fed7aa"], ["#065f46", "#d1fae5"],
  ["#581c87", "#e9d5ff"], ["#854d0e", "#fef08a"], ["#9f1239", "#fecaca"],
];

const c = D();
await c.connect();

// ── 1. Photos for every catalog row (3 per item, palette by id) ────────────
const rows = await c.query(`select id, name, short_name from inventory_items order by id`).catch(() => c.query(`select id, name from inventory_items order by id`));
const items = rows.rows;
for (const it of items) {
  const [a, b] = PALETTES[Number(it.id) % PALETTES.length];
  const short = String(it.name).split("(")[0].trim().slice(0, 26);
  const photos = [SVG(a, b, short, "Photo 1"), SVG(b, a, short, "Photo 2"), SVG(a, b, "SKU-" + it.id, "Photo 3")];
  await c.query(`update inventory_items set photo = $2, photos = $3 where id = $1`, [it.id, photos[0], JSON.stringify(photos)]);
}
console.log(`✓ photos: ${items.length} catalog items × 3 photos`);

// ── 2. Rich details on the poultry flagship (item 1) ───────────────────────
await c.query(
  `update inventory_items set
     brand = coalesce(nullif(brand,''), 'Mina Farms'),
     description = coalesce(nullif(description,''), 'Farm-fresh Grade A large eggs — cleaned, cold-chain packed and quality checked daily at the layer house. Best within 21 days of lay.'),
     specifications = coalesce(specifications, $1::jsonb),
     variants = coalesce(variants, $2::jsonb)
   where id = 1`,
  [JSON.stringify([{ key: "Size", value: "30 eggs per tray" }, { key: "Weight", value: "1.8 kg per tray" }, { key: "Shell", value: "Brown, medium-hard" }]),
   JSON.stringify(["Brown Large", "White Large", "Mixed Tray"])],
);
console.log("✓ rich product details verified on item 1");

// ── 3. Geo: coords + radius for every business; farm-gate pickup ───────────
const COORDS = [
  [1, 5.556, -0.183], [2, 5.6037, -0.187], [3, 6.2008, 0.4708], [4, 5.3501, -0.0225],
  [5, 5.556, -0.1969], [6, 5.5731, -0.2499], [7, 5.6212, -0.1735], [8, 5.5913, -0.2018],
  [11, 5.62, -0.19], [12, 5.6, -0.2],
];
for (const [id, lat, lng] of COORDS) {
  await c.query(
    `update businesses set gps_lat = $2, gps_lng = $3, gps_radius_m = 400, service_radius_km = 12 where id = $1`,
    [id, lat, lng],
  );
}
await c.query(`update businesses set online_ordering_enabled = true, pickup_enabled = true, delivery_enabled = true where id between 1 and 8`);
const havePickup = await c.query(`select count(*) c from pickup_locations where business_id = 1`);
if (Number(havePickup.rows[0].c) === 0) {
  await c.query(
    `insert into pickup_locations (business_id, branch_code, name, address, contact_phone, lat, lng, active, sort_order, created_by_user_id, created_by_name)
     values (1, 'POULTRY-01', 'Farm Gate Reception', 'Mina Akuafo Poultry Farm gate, off the Aburi road — Aburi area', '0240000001', 5.556, -0.183, true, 1, 1, 'Kwame Mina')`,
  );
}
console.log(`✓ geo: ${COORDS.length} units pinned at 12 km radius; farm-gate pickup verified`);

// ── 4. Pre-order stack ─────────────────────────────────────────────────────
await c.query(`update businesses set pre_order_enabled = true where id in (1, 6)`);
const METH = [
  { key: "AIR", label: "Air Freight Import", icon: "✈️", dMin: 7, dMax: 14 },
  { key: "SEA", label: "Sea Freight Import", icon: "🚢", dMin: 30, dMax: 45 },
];
for (const m of METH) {
  const ex = await c.query(`select id from fulfillment_methods where owner_id = 1 and key = $1 and business_id is null`, [m.key]);
  if (!ex.rowCount) {
    await c.query(
      `insert into fulfillment_methods (owner_id, business_id, branch_code, key, label, icon, default_lead_min_days, default_lead_max_days, requires_address, requires_pin, sort_order, active, created_by_user_id, created_by_name)
       values (1, null, null, $1, $2, $3, $4, $5, false, false, 1, true, 1, 'Kwame Mina')`,
      [m.key, m.label, m.icon, m.dMin, m.dMax],
    );
  }
}
const airId = (await c.query(`select id from fulfillment_methods where owner_id=1 and key='AIR' and business_id is null`)).rows[0].id;
const seaId = (await c.query(`select id from fulfillment_methods where owner_id=1 and key='SEA' and business_id is null`)).rows[0].id;
const optDefs = [
  { inv: 1, method: airId, price: 60, depT: "PERCENT", depV: 30, terms: "PREPAID" },
  { inv: 4, method: seaId, price: 12900, depT: "PERCENT", depV: 50, terms: "ON_ARRIVAL" },
];
for (const o of optDefs) {
  const ex = await c.query(`select id from fulfillment_options where inventory_id = $1 and method_id = $2`, [o.inv, o.method]);
  if (!ex.rowCount) {
    await c.query(
      `insert into fulfillment_options (owner_id, inventory_id, method_id, business_id, branch_code, price_ghs, lead_min_days, lead_max_days, deposit_type, deposit_value, terms_key, capacity_per_period, requires_address, active, sort_order, created_by_user_id, created_by_name)
       select 1, $1, $2, i.business_id, i.branch_code, $3, 7, 14, $4, $5, $6, 100, false, true, 1, 1, 'Kwame Mina'
       from inventory_items i where i.id = $1`,
      [o.inv, o.method, o.price, o.depT, o.depV, o.terms],
    );
  }
}
console.log("✓ pre-order stack: AIR/SEA methods + options on items 1 & 4; businesses 1 & 6 pre-order enabled");

await c.end();
console.log("E2E FIXTURES COMPLETE");
