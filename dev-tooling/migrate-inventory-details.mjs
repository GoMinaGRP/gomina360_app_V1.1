#!/usr/bin/env node
/**
 * migrate-inventory-details.mjs — idempotent, additive-only migration for the
 * rich product-details catalogue fields on inventory_items:
 *
 *   • description      TEXT      — free-form storefront description
 *   • brand            TEXT      — e.g. "Kumasi Blocks", "Akufo Farms"
 *   • model            TEXT      — model / product line
 *   • specifications   JSONB     — [{key:"Size"|"Weight"|"Voltage"|…, value:"…"}]
 *   • variants         JSONB     — [{name, note?}] display-only options
 *
 * All defaults null — existing rows keep working unchanged (storefront hides
 * the details section when nothing is registered).
 **/
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
  throw new Error("DATABASE_URL not found in env or .env.local");
}

const STATEMENTS = [
  `alter table public.inventory_items add column if not exists description text`,
  `alter table public.inventory_items add column if not exists brand text`,
  `alter table public.inventory_items add column if not exists model text`,
  `alter table public.inventory_items add column if not exists specifications jsonb`,
  `alter table public.inventory_items add column if not exists variants jsonb`,
];

const client = new Client({ connectionString: loadDatabaseUrl() });
await client.connect();
try {
  for (const sql of STATEMENTS) {
    await client.query(sql);
    console.log("ok:", sql.slice(0, 84));
  }
  console.log("✓ inventory product-details columns present (additive, idempotent)");
} finally {
  await client.end();
}
