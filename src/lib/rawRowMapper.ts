import { getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

/**
 * Rebuild a raw (snake_case column keys) row from a plain-text SQL query or
 * to_jsonb() blob into the exact camelCase field shape Drizzle's query builder
 * returns — so raw-SQL fast paths (initSnapshot, session resolution, login)
 * produce payloads identical to the drizzle access path they replaced.
 *
 * Column types in play (text/int/double/bool/timestamp/jsonb) are parsed by
 * node-postgres into the same JS values Drizzle yields. `to_jsonb()` renders
 * timestamps as ISO strings, which is exactly what JSON.stringify() produces
 * for Drizzle's Date objects — no client-visible difference.
 */
export function mapRawRow(table: PgTable, row: Record<string, any> | null | undefined): any | null {
  if (row == null) return null;
  const cols = getTableColumns(table as any) as Record<string, { name: string }>;
  const o: Record<string, any> = {};
  for (const [field, col] of Object.entries(cols)) o[field] = row[col.name];
  return o;
}

export function mapRawRows(table: PgTable, rows: Record<string, any>[]): any[] {
  return rows.map((r) => mapRawRow(table, r));
}
