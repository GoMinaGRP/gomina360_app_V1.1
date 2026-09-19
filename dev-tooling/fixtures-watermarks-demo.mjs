#!/usr/bin/env node
/**
 * Idempotent watermark-demo fixture. Creates (when missing) a SECOND
 * organization with one unit that carries NO business logo — that unit is
 * the NAME-mode watermark demo asserted by dev-tooling/watermarks-audit.mjs
 * (text-tile overlay, no logo chip), and gives tenant-isolation suites a
 * stable foreign tenant to point at.
 *
 * The demo unit's id is printed (and persisted into the org's own row), so
 * the audit suite resolves it dynamically — never hard-codes a serial id.
 */
import pg from "pg";
const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await c.connect();

const ORG_NAME = "AU WM Demo Org";
const ORG_SLUG = "au-wm-demo";
const BIZ_NAME = "WM Demo Unit (Org 2)";
const BIZ_CODE = "WM-DEMO-02";

const SVG = (bg, fg, label) => `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${bg}"/><text x="200" y="160" font-size="36" font-family="sans-serif" font-weight="bold" fill="${fg}" text-anchor="middle">${label}</text></svg>`,
).toString("base64")}`;

// ── org ────────────────────────────────────────────────────────────────────
let orgId = (await c.query(`select id from organizations where slug = $1`, [ORG_SLUG])).rows[0]?.id;
if (!orgId) {
  const ins = await c.query(
    `insert into organizations (name, slug, status, owner_user_id, created_by_user_id, business_types_restricted)
     values ($1, $2, 'ACTIVE', 1, 1, false) returning id`,
    [ORG_NAME, ORG_SLUG],
  );
  orgId = ins.rows[0].id;
  console.log("created demo org", orgId);
}

// ── unit (no logo, NAME-mode watermark) ────────────────────────────────────
let bizId = (await c.query(`select id from businesses where code = $1`, [BIZ_CODE])).rows[0]?.id;
if (!bizId) {
  const ins = await c.query(
    `insert into businesses
       (name, code, category, branch_location, region, district, town, manager_name,
        contact_phone, status, initial_capital_ghs, monthly_target_revenue_ghs,
        online_ordering_enabled, pickup_enabled, delivery_enabled, owner_id)
     values
       ($1, $2, 'GENERAL', 'Demo City', 'Greater Accra', 'Demo', 'Demo',
        'Demo Manager', '0240000000', 'ACTIVE', 1000, 500, true, true, true, $3)
     returning id`,
    [BIZ_NAME, BIZ_CODE, orgId],
  );
  bizId = ins.rows[0].id;
  console.log("created demo unit", bizId);
}
await c.query(
  `update businesses set watermark_enabled = true, watermark_mode = 'NAME', logo = null where id = $1`,
  [bizId],
);

// ── one sellable demo product with a photo (all-mode/photo assertions) ─────
const have = await c.query(`select id from inventory_items where business_id = $1 limit 1`, [bizId]);
let photo = SVG("#334155", "#e2e8f0", "ORG-2 Demo Item");
if (!have.rowCount) {
  await c.query(
    `insert into inventory_items
       (name, sku, business_id, category, unit, cost_price_ghs, selling_price_ghs, quantity,
        min_stock_threshold, status, photo, photos, branch_code)
     values
       ('Org-2 Watermark Demo Item', $2, $1, 'GENERAL', 'pcs', 5, 12.5, 25,
        3, 'IN_STOCK', $3, $4, $5)`,
    [bizId, `${BIZ_CODE}-SKU1`, photo, JSON.stringify([photo]), BIZ_CODE],
  );
  console.log("inserted demo catalog row");
} else {
  await c.query(
    `update inventory_items set photo = $2, photos = $3
     where business_id = $1 and (photo is null or photo = '')`,
    [bizId, photo, JSON.stringify([photo])],
  );
}

console.log(`✓ watermark demo fixture ready: org=${orgId} unit=${bizId} (NAME-mode, no logo)`);
console.log(`WM_DEMO_BIZ_ID=${bizId}`);
await c.end();
