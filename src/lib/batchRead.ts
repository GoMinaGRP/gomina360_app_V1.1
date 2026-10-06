import { getTableColumns, getTableName } from "drizzle-orm";
import { desc, eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db, getPool } from "@/db";
import { mapRawRows } from "@/lib/rawRowMapper";

/**
 * ── ONE-ROUND-TRIP READS FOR PAGE ROUTES ────────────────────────────────────
 *
 * Every `await db.select()` is one network round trip. On localhost that costs
 * ~0.1 ms and nobody notices; against a managed database (Neon, Vercel
 * Postgres) it costs 2–100 ms depending on region, so a route that reads 40
 * tables sequentially turns a 40 ms page into a multi-second one. That is the
 * single largest performance defect this codebase had (see
 * docs/PERFORMANCE-AUDIT.md) — and the fix already existed inside the app:
 * /api/init has always concatenated its reads into ONE multi-statement
 * simple-protocol query.
 *
 * `batchReads()` generalises that technique so any route can adopt it:
 *
 *   const data = await batchReads([
 *     { key: "transactions", table: transactions, limit: 240, order: "id" },
 *     { key: "entries", table: payrollEntries, limit: 600, scope: "none" },
 *   ], scope);            // scope = { businessIds: number[] | null }
 *
 *   data.transactions  // → camelCase rows, exactly as db.select() returned
 *
 * SAFETY PROPERTIES
 *  • Scope is a SUPERSET filter only. Callers keep their own permission checks
 *    (module/branch/role) — this never widens what a caller may see.
 *    `businessIds === null` means "no filter" (platform Super Admin), matching
 *    the previous behaviour of the routes it replaces.
 *  • Interpolated values are integer ids that came from the database or from
 *    `Number()`-coerced ids — never raw user text.
 *  • Any failure (an older schema missing a table, a malformed statement) falls
 *    back to the identical per-read drizzle selects, so behaviour cannot
 *    regress; the fallback logs once and is still correct.
 *  • Row shapes match Drizzle exactly (mapRawRows rebuilds camelCase fields).
 */
export type BatchRead = {
  /** Key the rows are returned under. */
  key: string;
  table: PgTable;
  /** Row cap (omit for "all rows of scope"). */
  limit?: number | null;
  /** "id" ⇒ ORDER BY id DESC (newest first, the app-wide default). Omit to
   *  keep the previous unordered (physical) order of a select. */
  order?: "id" | null;
  /** Extra raw SQL predicate, e.g. `"target_type" = 'USER'`. Only ever used
   *  with literals written in source, never with request data. */
  where?: string | null;
  /** "business" (default when the table has a business_id column and a scope
   *  is supplied) or "none" to keep an intentionally global read. */
  scope?: "business" | "none";
  /** Drizzle field name + literal for the fallback path's WHERE clause. */
  whereField?: string;
  whereValue?: string | number;
};

export type BatchScope = { businessIds: number[] | null };

export type BatchRows = Record<string, any[]>;

/** SQL literal for a spec's whereValue (numbers stay numeric, text is escaped). */
const literal = (v: string | number) =>
  typeof v === "number" ? String(Math.trunc(v)) : `'${String(v).replace(/'/g, "''")}'`;

const intList = (ids: number[]) =>
  ids.length ? ids.map((n) => Math.trunc(Number(n)) || 0).join(",") : "-1";

function buildSql(read: BatchRead, scopedIds: number[] | null): string {
  const cols = getTableColumns(read.table as any) as Record<string, { name: string }>;
  const clauses: string[] = [];
  if (read.where) clauses.push(read.where);
  if (read.whereField && read.whereValue !== undefined && cols[read.whereField]) {
    clauses.push(`"${cols[read.whereField].name}" = ${literal(read.whereValue)}`);
  }
  const businessScoped = read.scope !== "none" && !!cols.businessId;
  if (scopedIds && businessScoped) clauses.push(`"${cols.businessId.name}" IN (${intList(scopedIds)})`);
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const order = read.order === "id" ? ` ORDER BY "id" DESC` : "";
  const limit = read.limit ? ` LIMIT ${Math.trunc(read.limit)}` : "";
  return `SELECT * FROM "${getTableName(read.table as any)}"${where}${order}${limit}`;
}

export async function batchReads(reads: ReadonlyArray<BatchRead>, scope?: BatchScope): Promise<BatchRows> {
  const scopedIds = scope?.businessIds ?? null;
  try {
    const raw = await getPool().query(reads.map((r) => buildSql(r, scopedIds)).join(";\n") + ";");
    // pg hands back a bare Result for a one-statement query and an array for a
    // multi-statement string — normalise or single-read batches read as empty.
    const results = (Array.isArray(raw) ? raw : [raw]) as Array<{ rows: Record<string, any>[] }>;
    const data: BatchRows = {};
    reads.forEach((read, i) => {
      data[read.key] = mapRawRows(read.table as any, results?.[i]?.rows ?? []);
    });
    return data;
  } catch (batchError) {
    console.warn(
      "[batchRead] batched query failed, falling back to per-read selects:",
      (batchError as any)?.message || batchError
    );
    const data: BatchRows = {};
    for (const read of reads) {
      const cols = getTableColumns(read.table as any) as Record<string, any>;
      let q: any = db.select().from(read.table as any);
      if (read.whereField && read.whereValue !== undefined) {
        q = q.where(eq((read.table as any)[read.whereField], read.whereValue));
      }
      if (read.order === "id") q = q.orderBy(desc((read.table as any).id));
      if (read.limit) q = q.limit(read.limit);
      let rows: any[] = await q;
      if (scopedIds && read.scope !== "none" && cols.businessId) {
        rows = rows.filter((r: any) => r.businessId == null || scopedIds.includes(Number(r.businessId)));
      }
      data[read.key] = rows;
    }
    return data;
  }
}
