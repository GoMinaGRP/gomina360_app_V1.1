#!/usr/bin/env node
/**
 * Idempotent watermark-demo fixture: org-2's unit (business id 12, "Unrelated
 * Biz 056394") carries NO logo, which makes it the NAME-mode watermark demo
 * used by dev-tooling/watermarks-audit.mjs (text-tile overlay, no logo chip).
 * Creates a demo catalog row with a photo when missing.
 */
import pg from "pg";
const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await c.connect();

const SVG = (bg, fg, label) => `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${bg}"/><text x="200" y="160" font-size="36" font-family="sans-serif" font-weight="bold" fill="${fg}" text-anchor="middle">${label}</text></svg>`,
).toString("base64")}`;

await c.query(`update businesses set watermark_enabled = true, watermark_mode = 'NAME' where id = 12`);

const have = await c.query(`select id from inventory_items where business_id = 12 limit 1`);
if (!have.rowCount) {
  const photo = SVG("#334155", "#e2e8f0", "ORG-2 Demo Item");
  await c.query(
    `insert into inventory_items
       (name, sku, business_id, category, unit, cost_price_ghs, selling_price_ghs, quantity,
        min_stock_threshold, status, photo, photos, branch_code)
     values
       ('Org-2 Watermark Demo Item', 'UNR-WM-DEMO-01', 12, 'GENERAL', 'pcs', 5, 12.5, 25,
        3, 'IN_STOCK', $1, $2, 'UNR-056394')`,
    [photo, JSON.stringify([photo])],
  );
  console.log("inserted demo catalog row for biz 12");
} else {
  console.log("biz 12 catalog row present (id", have.rows[0].id + ")");
}
// ensure the demo row has a photo (it may exist without one)
await c.query(
  `update inventory_items set photo = $1, photos = $2
   where business_id = 12 and (photo is null or photo = '')`,
  [SVG("#334155", "#e2e8f0", "ORG-2 Demo Item"), JSON.stringify([SVG("#475569", "#e2e8f0", "ORG-2")])],
);
console.log("✓ watermark demo fixture ready (biz 12: NAME-mode, no logo)");
await c.end();
