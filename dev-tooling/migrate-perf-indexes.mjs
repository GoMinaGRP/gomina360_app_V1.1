#!/usr/bin/env node
/**
 * migrate-perf-indexes.mjs — idempotent, additive-only hot-path indexes for
 * the performance audit:
 *
 *   • user_sessions(token_hash)              — session resolution (EVERY API call)
 *   • customer_trackings(business_id)        — per-branch order boards
 *   • fulfillment_options(inventory_id)      — menu JOIN / pre-order exposure
 *   • service_areas(business_id, active)     — menu + checkout service gates
 *   • pickup_locations(business_id, active)  — storefront pickup points
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = new URL(".", import.meta.url).pathname;
const rootDir = resolve(here, "..");

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const f of [".env.local", ".env"]) {
    try {
      const txt = readFileSync(resolve(rootDir, f), "utf8");
      const m = txt.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    } catch {}
  }
  return "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
}

const STATEMENTS = [
  `create index if not exists user_sessions_token_hash_idx on public.user_sessions (token_hash)`,
  `create index if not exists customer_trackings_business_id_idx on public.customer_trackings (business_id)`,
  `create index if not exists fulfillment_options_inventory_id_idx on public.fulfillment_options (inventory_id)`,
  `create index if not exists service_areas_business_id_active_idx on public.service_areas (business_id, active)`,
  `create index if not exists pickup_locations_business_id_active_idx on public.pickup_locations (business_id, active)`,
];

const client = new Client({ connectionString: loadDatabaseUrl() });
await client.connect();
try {
  for (const sql of STATEMENTS) {
    await client.query(sql);
    console.log("ok:", sql.split(" on ")[0]);
  }
  console.log("✓ hot-path indexes present (additive, idempotent)");
} finally {
  await client.end();
}
