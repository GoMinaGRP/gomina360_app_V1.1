#!/usr/bin/env node
/**
 * restore-livedata.mjs — replay the live-data backup produced by
 * backup-livedata.mjs after a sandbox rebuild. Idempotent: every row is
 * inserted with ON CONFLICT (id) DO NOTHING, so rows already recreated by
 * seed/restore fixtures (same id) are left exactly as they are, and re-running
 * is always safe.
 *
 * Column values come from the backup file itself; only columns that STILL
 * exist in the live information_schema are inserted (forward-compatible with
 * schema evolution). Serial sequences are bumped past the max restored id so
 * new inserts never collide.
 */
import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const FILE = new URL("./backups/livedata-backup.json", import.meta.url).pathname;

if (!existsSync(FILE)) {
  console.log("restore-livedata: no backup file — skipping");
  process.exit(0);
}
const backup = JSON.parse(readFileSync(FILE, "utf8"));
const pg = new Client({ connectionString: DB });
await pg.connect();

for (const [table, rows] of Object.entries(backup.tables || {})) {
  if (!Array.isArray(rows) || rows.length === 0) continue;
  // Columns that exist NOW (schema may have evolved since the backup).
  const { rows: cols } = await pg.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name=$1`,
    [table],
  );
  const live = new Set(cols.map((c) => c.column_name));
  const wanted = Object.keys(rows[0]).filter((c) => live.has(c));
  if (wanted.length === 0) continue;
  let inserted = 0;
  for (const row of rows) {
    const cols = wanted.filter((c) => row[c] !== undefined);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const values = cols.map((c) => {
      const v = row[c];
      if (v === null || typeof v !== "object") return v;
      return JSON.stringify(v); // jsonb columns
    });
    const res = await pg.query(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      values,
    );
    inserted += res.rowCount;
  }
  // Keep the serial ahead of anything we restored.
  const { rows: seqRows } = await pg.query(
    `SELECT pg_get_serial_sequence($1, 'id') AS seq`,
    [table],
  );
  const seq = seqRows[0]?.seq;
  if (seq) {
    const { rows: maxRows } = await pg.query(`SELECT COALESCE(MAX(id),0)::bigint m FROM ${table}`);
    await pg.query(`SELECT setval($1, $2)`, [seq, maxRows[0].m]);
  }
  console.log(`✔ ${table}: ${inserted}/${rows.length} row(s) restored`);
}
await pg.end();
console.log(`RESTORE-LIVEDATA COMPLETE (backup from ${backup.capturedAt || "unknown"})`);
