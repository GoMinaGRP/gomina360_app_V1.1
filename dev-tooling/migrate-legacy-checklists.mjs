#!/usr/bin/env node
/**
 * migrate-legacy-checklists.mjs — one-time, idempotent, non-destructive fold of
 * the three retired module-local checklist tables into the canonical checklist
 * engine (`checklist_entries`, driven by `checklist_templates`):
 *
 *   • poultry_checklists        → checklist_entries
 *   • block_factory_checklists  → checklist_entries
 *   • aquaculture_checklists    → checklist_entries
 *
 * Phase 3 (retire legacy) stopped writing to the legacy tables — module routes
 * POST/PATCH through the shared `checklistGen` helpers instead — and removed
 * them from the schema, the business-delete cascade and the backup catalogue.
 * Rows written before that switch still exist in production databases, so this
 * script copies them across once. A legacy row is copied only when no canonical
 * entry already exists for the same
 * (business_id, checklist_date, branch_code, task_key, category) — the same
 * "one task per day" identity the modules used — which makes re-runs no-ops.
 * `category` is part of the key because the module vocabularies overlap (e.g.
 * FEED_MORNING exists in both poultry and aquaculture) while the canonical
 * table carries no module column.
 *
 * The legacy tables are left in place (no DROP): retirement is a code-level
 * decision, and `migrate-production-schema.mjs` is additive-only by contract.
 *
 * Usage:  node dev-tooling/migrate-legacy-checklists.mjs
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
  return "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
}

const LEGACY_TABLES = ["poultry_checklists", "block_factory_checklists", "aquaculture_checklists"];

const insertSql = (legacy) => `
  INSERT INTO checklist_entries
    (business_id, branch_code, checklist_date, template_id, task_key, task_label,
     category, is_completed, completed_by_name, completed_by_role, completed_at, notes, created_at)
  SELECT l.business_id, l.branch_code, l.checklist_date, NULL, l.task_key, l.task_label,
         COALESCE(l.category, 'GENERAL'), COALESCE(l.is_completed, false),
         l.completed_by_name, l.completed_by_role, l.completed_at, l.notes,
         COALESCE(l.created_at, now())
  FROM ${legacy} l
  WHERE NOT EXISTS (
    SELECT 1 FROM checklist_entries e
    WHERE e.business_id = l.business_id
      AND e.checklist_date = l.checklist_date
      AND e.task_key = l.task_key
      AND COALESCE(e.branch_code, '') = COALESCE(l.branch_code, '')
      AND COALESCE(e.category, 'GENERAL') = COALESCE(l.category, 'GENERAL')
  )`;

async function main() {
  const client = new Client({ connectionString: loadDatabaseUrl() });
  await client.connect();
  let copied = 0;
  try {
    await client.query("BEGIN");
    for (const table of LEGACY_TABLES) {
      const { rows } = await client.query(
        `SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${table}`],
      );
      if (!rows[0].present) {
        console.log(`–  ${table}: absent (skipped)`);
        continue;
      }
      const res = await client.query(insertSql(table));
      copied += res.rowCount;
      console.log(`✓  ${table}: ${res.rowCount} row(s) folded into checklist_entries`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("✗  legacy checklist migration failed:", err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
  if (!process.exitCode) console.log(`migrate-legacy-checklists: ${copied} row(s) copied (idempotent).`);
}

main();
