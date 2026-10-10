import { db } from "@/db";
import { systemMarkers } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

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
    const [row] = await db.select().from(systemMarkers).where(eq(systemMarkers.key, key)).limit(1);
    return row ? (row.value ?? "") : null;
  } catch {
    return null;
  }
}

/** Set a marker once (idempotent insert — an existing value is never overwritten). */
export async function setSystemMarker(key: string, value = "1"): Promise<void> {
  try {
    if (!(await ensureTable())) return;
    await db.insert(systemMarkers).values({ key, value }).onConflictDoNothing();
  } catch {
    /* marker bookkeeping is best-effort — never break the caller */
  }
}

/** Record a permanently deleted business code so no seeder resurrects it. */
export async function recordDeletedBusiness(code: string): Promise<void> {
  if (!code) return;
  await setSystemMarker(`${DELETED_BIZ_PREFIX}${code.toUpperCase()}`, new Date().toISOString());
}

/** Clear a deletion tombstone when a business is intentionally created/re-created. */
export async function clearDeletedBusiness(code: string): Promise<void> {
  if (!code) return;
  try {
    if (!(await ensureTable())) return;
    await db.delete(systemMarkers).where(eq(systemMarkers.key, `${DELETED_BIZ_PREFIX}${code.toUpperCase()}`));
  } catch {
    /* marker bookkeeping is best-effort — never break the caller */
  }
}

/** True when a business with this code was permanently deleted by the OWNER. */
export async function isDeletedBusiness(code: string): Promise<boolean> {
  if (!code) return false;
  return (await getSystemMarker(`${DELETED_BIZ_PREFIX}${code.toUpperCase()}`)) !== null;
}

/** The most recently SET marker whose key starts with `prefix`, newest first.
 *
 *  F-14: a daily-ops marker is written only when the whole sweep SUCCEEDS,
 *  so "the newest `daily-ops:` marker" is precisely "the last time overdue
 *  activities were actually processed". `setSystemMarker` never overwrites an
 *  existing row, but each day uses a DIFFERENT key (`daily-ops:<date>`), so
 *  one row is created per successful sweep and its `created_at` is that
 *  sweep's timestamp.
 *
 *  Returns [] when the table is unavailable or nothing has ever run — the
 *  caller decides whether that is an error or simply "never yet". */
export async function latestMarkerWithPrefix(
  prefix: string,
  limit = 1
): Promise<{ key: string; value: string | null; createdAt: Date | null }[]> {
  try {
    if (!(await ensureTable())) return [];
    return await db
      .select({
        key: systemMarkers.key,
        value: systemMarkers.value,
        createdAt: systemMarkers.createdAt,
      })
      .from(systemMarkers)
      .where(sql`${systemMarkers.key} LIKE ${prefix + "%"}`)
      .orderBy(sql`${systemMarkers.createdAt} DESC NULLS LAST, ${systemMarkers.id} DESC`)
      .limit(limit);
  } catch {
    return [];
  }
}
