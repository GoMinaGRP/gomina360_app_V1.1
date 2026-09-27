import { db } from "@/db";
import { sql } from "drizzle-orm";

/**
 * Persistent system markers + business-deletion tombstones.
 *
 * Backed by the `system_markers` table (see src/db/schema.ts). Two jobs:
 *
 *  1. ONE-TIME SEED/REPAIR FLAGS — the boot seeder marks migrations that
 *     must never re-run after their first pass (e.g. the HARDWARE-01
 *     flagship provisioning). Without the marker, every cold start would
 *     "repair" the database back to seeded state — resurrecting a unit the
 *     OWNER had deliberately deleted from Manage Units.
 *
 *  2. DELETION TOMBSTONES — permanently deleting a business records
 *     `deleted_business:<CODE>` here, so no auto-provisioning path can ever
 *     re-create that unit. Deletion is final.
 *
 * EVERY helper is failure-tolerant by design: on a database that has not
 * yet been migrated (table absent) reads report "no marker" and writes are
 * silent no-ops. A missing marker table must never block a business
 * deletion or crash the boot seeder.
 */

const DELETED_BIZ_PREFIX = "deleted_business:";

/** True when the table physically exists (cheap probe, cached per process). */
let tableExists: boolean | null = null;
async function ensureTable(): Promise<boolean> {
  if (tableExists !== null) return tableExists;
  try {
    await db.execute(
      sql`CREATE TABLE IF NOT EXISTS system_markers (
            id serial primary key,
            key text not null unique,
            value text,
            created_at timestamp DEFAULT now()
          )`
    );
    tableExists = true;
  } catch {
    tableExists = false;
  }
  return tableExists;
}

/** Read a marker's value (null = not set / table unavailable). */
export async function getSystemMarker(key: string): Promise<string | null> {
  try {
    if (!(await ensureTable())) return null;
    const res = await db.execute(sql`SELECT value FROM system_markers WHERE key = ${key} LIMIT 1`);
    const rows = (res as any).rows ?? res;
    const first = Array.isArray(rows) ? rows[0] : null;
    return first ? (first.value ?? "") : null;
  } catch {
    return null;
  }
}

/** Set a marker once (idempotent insert — an existing value is never overwritten). */
export async function setSystemMarker(key: string, value = "1"): Promise<void> {
  try {
    if (!(await ensureTable())) return;
    await db.execute(
      sql`INSERT INTO system_markers (key, value) VALUES (${key}, ${value})
          ON CONFLICT (key) DO NOTHING`
    );
  } catch {
    /* marker bookkeeping is best-effort — never break the caller */
  }
}

/** Record a permanently deleted business code so no seeder resurrects it. */
export async function recordDeletedBusiness(code: string): Promise<void> {
  if (!code) return;
  await setSystemMarker(`${DELETED_BIZ_PREFIX}${code.toUpperCase()}`, new Date().toISOString());
}

/** True when a business with this code was permanently deleted by the OWNER. */
export async function isDeletedBusiness(code: string): Promise<boolean> {
  if (!code) return false;
  return (await getSystemMarker(`${DELETED_BIZ_PREFIX}${code.toUpperCase()}`)) !== null;
}
