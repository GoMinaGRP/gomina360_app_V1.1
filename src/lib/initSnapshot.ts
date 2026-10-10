import { getTableColumns, getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { getPool } from "@/db";
import { mapRawRows } from "@/lib/rawRowMapper";
import { normalizeInventoryItem } from "@/lib/inventoryCategories";
import {
  users,
  businesses,
  businessMetrics,
  customers,
  suppliers,
  employees,
  assets,
  inventoryItems,
  transactions,
  creditSales,
  poultryLogs,
  blockFactoryLogs,
  aquacultureLogs,
  livestockLogs,
  restaurantLogs,
  electronicsLogs,
  carWashLogs,
  hardwareLogs,
  aiInsights,
  scenarioSimulations,
  integrations,
  checklistTemplates,
  checklistEntries,
} from "@/db/schema";
import { createHash } from "node:crypto";

/**
 * ONE-ROUND-TRIP bootstrap reads for /api/init.
 *
 * The dashboard used to issue 24 PARALLEL selects + 4 sequential follow-ups.
 * On a remote (deployed) database with a small pool (Vercel ⇒ PG_POOL_MAX=2)
 * that fan-out serialises into 12+ latency waves — a cache-miss cost of
 * 1.5-2+ s with a ~50 ms DB round trip. Here every read is concatenated into
 * ONE multi-statement simple-protocol query: Postgres executes the whole batch
 * on a single connection and node-postgres returns an array of result sets.
 * One network round trip, one pool slot, same rows.
 *
 * SAFETY: the ONLY values interpolated into the statement text are integer
 * id lists that came from the database itself (business/org/user ids) and are
 * re-validated below — no user input ever reaches the string. Session tokens
 * are resolved through parameterised queries elsewhere (lib/auth).
 *
 * Row shapes: mapRawRows() rebuilds each row with the exact camelCase field names
 * from the Drizzle schema, so the JSON payload is compatible with the previous
 * per-table drizzle selects (verified by a structural golden-master diff).
 * Column types in these tables are text/int/double/bool/timestamp/jsonb only —
 * node-postgres returns the same JS values for those as Drizzle does.
 */

export interface InitReadScope {
  /** Accessible business ids; null ⇒ Super Admin (whole platform). */
  bids: number[] | null;
  /** Caller's org ids for owner-stamped (shared) tables; null ⇒ Super Admin. */
  orgScope: number[] | null;
  /** The caller's own user id (always visible in the user directory). */
  selfUserId: number;
  /** Executive (OWNER/GM) non-super-admin ⇒ narrow users to own-org members. */
  execMemberOrgs: number[] | null;
  /** Org whose settings/context ship in the payload (null ⇒ orphan user). */
  orgIdForSettings: number | null;
  /** Super Admin also gets the platform organization directory. */
  isSuperAdmin: boolean;
  /** ISO date (YYYY-MM-DD) the transaction window starts at; null ⇒ full history. */
  ledgerFrom?: string | null;
}

const ints = (ids: number[]): string =>
  ids.map((n) => Math.trunc(Number(n))).filter((n) => Number.isFinite).join(",") || "-1";

/** `WHERE col IN (...)` — null scope ⇒ no predicate (whole table). */
const whereIn = (col: string, ids: number[] | null): string =>
  ids === null ? "" : ` WHERE ${col} IN (${ints(ids)})`;
/** `... OR col IN (...)` continuation — null scope ⇒ nothing. */
const orIn = (col: string, ids: number[] | null): string =>
  ids === null ? "" : ` OR ${col} IN (${ints(ids)})`;
const intLit = (n: number): number => Math.trunc(Number(n)) || 0;

/**
 * TRANSACTION HISTORY WINDOW (bootstrap only).
 *
 * `/api/init` ships the newest `LEDGER_WINDOW_DAYS` of the operational ledger
 * (by business date). Older rows are NOT removed from the product: the client
 * fetches the complete ledger from `/api/init/ledger` in the background whenever
 * `ledger.complete` is false, so every all-time total is still computed from the
 * full history. The first paint therefore scales with one year of activity,
 * not with the platform's whole life.
 *
 * Seeded notification-baseline rows (TRX-YYYY-1001..1006) are always inside the
 * window, so the client watermark (`isSeededBaselineTxn`) is identical whether
 * the array is windowed or complete. The regex MUST match `isSeededBaselineTxn`
 * in src/lib/financeReport.ts.
 */
export const LEDGER_WINDOW_DAYS = 370;

export function ledgerWindowStart(now: Date = new Date()): string {
  return new Date(now.getTime() - LEDGER_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
}

const SEEDED_BASELINE_TXN_SQL = `"transaction_number" ~ '^TRX-[0-9]{4}-100[1-6]$'`;

/** Live ledger predicate: completed (or legacy NULL-status) rows in scope. */
function ledgerScopeSql(bids: number[] | null): string {
  const conds: string[] = [];
  if (bids !== null) conds.push(`"business_id" IN (${ints(bids)})`);
  conds.push(`("status" = 'COMPLETED' OR "status" IS NULL)`);
  return conds.join(" AND ");
}

function ledgerWindowSql(ledgerFrom: string): string {
  return `("date" >= '${ledgerFrom}' OR ${SEEDED_BASELINE_TXN_SQL})`;
}

/** Strips receipt images (kept as a count). Shared by every ledger reader. */
export function toLedgerTransaction(t: any): any {
  const { receiptImage, receiptImages, ...rest } = t;
  const count = Array.isArray(receiptImages) && receiptImages.length > 0
    ? receiptImages.length
    : receiptImage
      ? 1
      : 0;
  return { ...rest, receiptCount: count };
}

/**
 * Complete (un-windowed) live ledger for a business scope (null ⇒ all).
 * Same scope and status rules as the bootstrap; used by /api/init/ledger.
 */
export async function readFullLedgerTransactions(bids: number[] | null): Promise<any[]> {
  const result: any = await getPool().query(
    `SELECT ${selectList(transactions)} FROM "transactions" WHERE ${ledgerScopeSql(bids)}${NEWEST_FIRST}`
  );
  return mapRawRows(transactions, result.rows);
}

function selectList(table: PgTable, opts: { exclude?: string[]; extra?: string[] } = {}): string {
  const cols = getTableColumns(table as any) as Record<string, { name: string }>;
  const names = Object.values(cols)
    .map((c) => `"${c.name}"`)
    .filter((n) => !(opts.exclude || []).some((e) => `"${e}"` === n));
  return [...names, ...(opts.extra || [])].join(", ");
}

/**
 * RECORD ORDERING — newest first, everywhere.
 *
 * Postgres returns unordered rows in physical order, which drifts as a table is
 * updated (an UPDATE relocates the tuple). Every list the app paints straight
 * from the bootstrap payload — transaction ledgers, credit sales, customers,
 * assets, inventory, employees, AI insights, scenarios, integrations and the
 * eight specialized operation logs — therefore carries an explicit
 * `ORDER BY "id" DESC` here. `id` is a monotonic sequence, so "id DESC" is
 * exactly "most recently recorded first", and it is stable across databases.
 * Identity lists (businesses, users, organizations) keep ASC so their order is
 * a stable, predictable unit/staff directory order.
 */
const NEWEST_FIRST = ` ORDER BY "id" DESC`;

/**
 * Row cap for the eight per-module OPERATIONS LOG feeds in the bootstrap
 * payload (poultry, block factory, aquaculture, livestock, restaurant,
 * electronics, car wash, hardware).
 *
 * These are "recent activity" lists — each module's own screen fetches its
 * complete data from its own route (/api/poultry, /api/block-factory, …), so
 * the bootstrap copy only needs the newest rows to paint immediately. Without
 * a cap these tables made the dashboard payload grow without bound as a busy
 * unit recorded logs (docs/PERFORMANCE-AUDIT.md §3 B1). 500 newest rows per
 * table per viewer is far more than any list shows and keeps the payload flat.
 *
 * Deliberately NOT applied to transactions, inventory, customers, employees or
 * credit sales: screens compute money totals from those arrays on the client,
 * so capping them would silently change reported figures. Bounding them needs
 * server-side aggregates first — see the follow-up list in the audit doc.
 */
const LOG_FEED_LIMIT = 500;

const LOG_TABLES = [
  poultryLogs,
  blockFactoryLogs,
  aquacultureLogs,
  livestockLogs,
  restaurantLogs,
  electronicsLogs,
  carWashLogs,
  hardwareLogs,
] as const;

export interface InitReadResult {
  businesses: any[];
  /** md5(logo || branch_logos) per business id — branding version input. */
  businessLogoHashes: Map<number, string>;
  metrics: any[];
  users: any[];
  customers: any[];
  suppliers: any[];
  employees: any[];
  assets: any[];
  inventory: any[];
  transactions: any[];
  /** Completeness of `transactions` (windowed vs. full history). */
  ledger: { windowFrom: string | null; transactionsTotal: number; transactionsLoaded: number; complete: boolean };
  creditSales: any[];
  aiInsights: any[];
  scenarios: any[];
  integrations: any[];
  checklistTemplates: any[];
  checklistEntries: any[];
  specializedLogs: { [k: string]: any[] };
  /** Executive org member ids (empty when not applicable). */
  execMemberIds: number[];
  /** organizations.business_types_restricted for the settings org. */
  bizTypesRestricted: boolean | null;
  /** organization_business_types keys for the settings org. */
  bizTypeKeys: string[];
  myOrgRow: any | null;
  orgDirectory: any[];
  /** md5 of the company logo (branding version input; "" when unset). */
  companyLogoHash: string;
}

export async function readInitSnapshot(scope: InitReadScope): Promise<InitReadResult> {
  const { bids, orgScope, selfUserId, orgIdForSettings, isSuperAdmin } = scope;
  const stmts: string[] = [];

  // 0 — businesses. Logos stay server-side: only their md5 crosses the wire.
  // The payload carries a brandingVersion instead; /api/branding serves the
  // blobs themselves with browser caching.
  stmts.push(
    `SELECT ${selectList(businesses, {
      exclude: ["logo", "branch_logos"],
      extra: [`md5(coalesce(logo, '') || coalesce(branch_logos::text, '')) AS "__brandingHash"`],
    })} FROM "businesses"${whereIn("id", bids)} ORDER BY "id" ASC`
  );
  // 1 — business metrics
  stmts.push(`SELECT ${selectList(businessMetrics)} FROM "business_metrics"${whereIn("business_id", bids)}`);
  // 2 — user directory. SQL-narrowed to exactly what the JS visibility filter
  // keeps afterwards: Super Admin ⇒ everyone (D4); org executives ⇒ self +
  // own-org members; everyone else ⇒ self + accounts assigned to an
  // accessible business.
  {
    let where = "";
    if (!isSuperAdmin) {
      if (scope.execMemberOrgs) {
        where = ` WHERE ("id" = ${intLit(selfUserId)} OR "id" IN (SELECT "user_id" FROM "organization_members" WHERE "organization_id" IN (${ints(scope.execMemberOrgs)})))`;
      } else if (bids !== null) {
        where = ` WHERE ("id" = ${intLit(selfUserId)} OR "assigned_business_id" IN (${ints(bids)}))`;
      }
    }
    stmts.push(`SELECT ${selectList(users)} FROM "users"${where} ORDER BY "id" ASC`);
  }
  // 3 — customers: business-stamped rows follow business scope; untyped rows
  // follow the owner's org (mirrors the drizzle or(...) pre-scoping).
  stmts.push(
    `SELECT ${selectList(customers)} FROM "customers"${whereIn("business_id", bids)}${orIn("owner_id", orgScope)}${NEWEST_FIRST}`
  );
  // 4 — suppliers (per-organization directory)
  stmts.push(`SELECT ${selectList(suppliers)} FROM "suppliers"${whereIn("owner_id", orgScope)}${NEWEST_FIRST}`);
  // 5-9 — business-stamped tables
  stmts.push(`SELECT ${selectList(employees)} FROM "employees"${whereIn("business_id", bids)}${NEWEST_FIRST}`);
  stmts.push(`SELECT ${selectList(assets)} FROM "assets"${whereIn("business_id", bids)}${NEWEST_FIRST}`);
  stmts.push(
    `SELECT ${selectList(inventoryItems, {
      // `photos` (N × base64 data URLs) and its thumbnail array never leave
      // the server on bootstrap — the ONE image the lists actually paint is
      // `photoThumb` (falling back to `photo` for legacy rows, applied in
      // /api/init), plus the raw `photo` for records that predate thumbnails.
      exclude: ["photos", "photosThumb"],
      extra: [`coalesce(jsonb_array_length(case when jsonb_typeof(photos) = 'array' then photos else '[]'::jsonb end), 0) AS "photoCount"`],
    })} FROM "inventory_items"${whereIn("business_id", bids)}${NEWEST_FIRST}`
  );
  const ledgerFrom = scope.ledgerFrom && /^\d{4}-\d{2}-\d{2}$/.test(scope.ledgerFrom) ? scope.ledgerFrom : null;
  {
    const windowCond = ledgerFrom ? ` AND ${ledgerWindowSql(ledgerFrom)}` : "";
    stmts.push(
      `SELECT ${selectList(transactions)} FROM "transactions" WHERE ${ledgerScopeSql(bids)}${windowCond}${NEWEST_FIRST}`
    );
  }
  stmts.push(`SELECT ${selectList(creditSales)} FROM "credit_sales"${whereIn("business_id", bids)}${NEWEST_FIRST}`);
  // 10 — ai insights
  stmts.push(`SELECT ${selectList(aiInsights)} FROM "ai_insights"${whereIn("business_id", bids)}${orIn("owner_id", orgScope)}${NEWEST_FIRST}`);
  // 11 — scenario simulations (business-targeted or org-owned)
  stmts.push(
    `SELECT ${selectList(scenarioSimulations)} FROM "scenario_simulations"${whereIn("target_business_id", bids)}${orIn("owner_id", orgScope)}${NEWEST_FIRST}`
  );
  // 12 — integrations
  stmts.push(`SELECT ${selectList(integrations)} FROM "integrations"${whereIn("owner_id", orgScope)}${NEWEST_FIRST}`);
  // 13-14 — checklists. Entries are generated DAILY per business (~8 rows ×
  // N businesses every day — the one table that grows automatically), and the
  // only bootstrap consumer (Command Center compliance) reads TODAY's rows;
  // every other view (module panels, exports) self-fetches full history from
  // /api/checklists. The bootstrap therefore ships a 14-day window (ample
  // margin around any client/server timezone skew), keeping the payload
  // bounded as the platform ages.
  stmts.push(`SELECT ${selectList(checklistTemplates)} FROM "checklist_templates"${whereIn("business_id", bids)}`);
  {
    const since = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
    const dateFilter = `"checklist_date" >= '${since}'`;
    const scope = whereIn("business_id", bids);
    stmts.push(
      `SELECT ${selectList(checklistEntries)} FROM "checklist_entries"${scope ? `${scope} AND ${dateFilter}` : ` WHERE ${dateFilter}`}`
    );
  }
  // 15-22 — specialized logs
  for (const t of LOG_TABLES) {
    stmts.push(
      `SELECT ${selectList(t)} FROM "${getTableName(t as any)}"${whereIn("business_id", bids)}${NEWEST_FIRST} LIMIT ${LOG_FEED_LIMIT}`
    );
  }
  // 23 — executive org member ids
  stmts.push(
    scope.execMemberOrgs
      ? `SELECT "user_id" FROM "organization_members" WHERE "organization_id" IN (${ints(scope.execMemberOrgs)})`
      : `SELECT NULL AS "user_id" WHERE FALSE`
  );
  // 24 — org business-type restriction flag
  stmts.push(
    orgIdForSettings != null
      ? `SELECT "business_types_restricted" FROM "organizations" WHERE "id" = ${intLit(orgIdForSettings)} LIMIT 1`
      : `SELECT NULL AS "business_types_restricted" WHERE FALSE`
  );
  // 25 — org allowed business type keys
  stmts.push(
    orgIdForSettings != null
      ? `SELECT "business_type_key" FROM "organization_business_types" WHERE "organization_id" = ${intLit(orgIdForSettings)}`
      : `SELECT NULL AS "business_type_key" WHERE FALSE`
  );
  // 26 — my org row (UI org context)
  stmts.push(
    orgIdForSettings != null
      ? `SELECT "id", "name", "slug", "status" FROM "organizations" WHERE "id" = ${intLit(orgIdForSettings)}`
      : `SELECT NULL AS "id" WHERE FALSE`
  );
  // 27 — Super Admin org directory
  stmts.push(
    isSuperAdmin
      ? `SELECT "id", "name", "slug", "status", "created_at" FROM "organizations" ORDER BY "id" ASC`
      : `SELECT NULL AS "id" WHERE FALSE`
  );
  // 28 — company logo hash (branding version input; blob never leaves PG here)
  stmts.push(
    orgIdForSettings != null
      ? `SELECT md5(coalesce(company_logo, '')) AS "logoHash" FROM "company_settings" WHERE "organization_id" = ${intLit(orgIdForSettings)} LIMIT 1`
      : `SELECT NULL AS "logoHash" WHERE FALSE`
  );

  // Ledger completeness: live rows in total vs. rows inside the window.
  stmts.push(
    `SELECT count(*)::int AS "total", count(*) FILTER (WHERE ${ledgerFrom ? ledgerWindowSql(ledgerFrom) : "TRUE"})::int AS "windowed" FROM "transactions" WHERE ${ledgerScopeSql(bids)}`
  );

  const results = (await getPool().query(stmts.join(";\n") + ";")) as unknown as any[];

  const [
    bizRows, metricRows, userRows, customerRows, supplierRows, employeeRows, assetRows,
    inventoryRows, txnRows, creditRows, insightRows, scenarioRows, integrationRows,
    templateRows, entryRows, poultryRows, blockRows, aquaRows, liveRows, restRows,
    elecRows, washRows, hwRows, memberRows, restrictedRows, bizTypeKeyRows, orgRows,
    directoryRows, logoHashRows, ledgerCountRows,
  ] = results;
  const ledgerCounts = (ledgerCountRows.rows as any[])[0] || { total: 0, windowed: 0 };
  const ledgerTotal = Number(ledgerCounts.total) || 0;
  const ledgerWindowed = Number(ledgerCounts.windowed) || 0;

  const businessLogoHashes = new Map<number, string>();
  for (const r of bizRows.rows as any[]) {
    if (r.__brandingHash) businessLogoHashes.set(Number(r.id), String(r.__brandingHash));
  }

  return {
    businesses: mapRawRows(businesses, bizRows.rows).map((b: any) => ({
      ...b,
      // Logos ship via /api/branding (browser-cached), not on every bootstrap.
      logo: null,
      branchLogos: null,
    })),
    businessLogoHashes,
    metrics: mapRawRows(businessMetrics, metricRows.rows),
    users: mapRawRows(users, userRows.rows),
    customers: mapRawRows(customers, customerRows.rows),
    suppliers: mapRawRows(suppliers, supplierRows.rows),
    employees: mapRawRows(employees, employeeRows.rows),
    assets: mapRawRows(assets, assetRows.rows),
    // Read-time guard: legacy/free-text categories are reported under the
    // shared standard taxonomy (the specific wording stays as `subcategory`),
    // so every list, filter and picker is consistent even before the
    // one-time data backfill has run.
    inventory: mapRawRows(inventoryItems, inventoryRows.rows).map((i: any) => normalizeInventoryItem(i)),
    transactions: mapRawRows(transactions, txnRows.rows),
    ledger: {
      windowFrom: ledgerFrom,
      transactionsTotal: ledgerTotal,
      transactionsLoaded: ledgerWindowed,
      complete: ledgerWindowed >= ledgerTotal,
    },
    creditSales: mapRawRows(creditSales, creditRows.rows),
    aiInsights: mapRawRows(aiInsights, insightRows.rows),
    scenarios: mapRawRows(scenarioSimulations, scenarioRows.rows),
    integrations: mapRawRows(integrations, integrationRows.rows),
    checklistTemplates: mapRawRows(checklistTemplates, templateRows.rows),
    checklistEntries: mapRawRows(checklistEntries, entryRows.rows),
    specializedLogs: {
      poultry: mapRawRows(poultryLogs, poultryRows.rows),
      blockFactory: mapRawRows(blockFactoryLogs, blockRows.rows),
      aquaculture: mapRawRows(aquacultureLogs, aquaRows.rows),
      livestock: mapRawRows(livestockLogs, liveRows.rows),
      restaurant: mapRawRows(restaurantLogs, restRows.rows),
      electronics: mapRawRows(electronicsLogs, elecRows.rows),
      carWash: mapRawRows(carWashLogs, washRows.rows),
      hardware: mapRawRows(hardwareLogs, hwRows.rows),
    },
    execMemberIds: (memberRows.rows as any[]).map((m) => Number(m.user_id)).filter(Number.isFinite),
    bizTypesRestricted: (restrictedRows.rows as any[])[0]?.business_types_restricted ?? null,
    bizTypeKeys: (bizTypeKeyRows.rows as any[]).map((r) => String(r.business_type_key)),
    myOrgRow: (orgRows.rows as any[])[0] ?? null,
    orgDirectory: directoryRows.rows as any[],
    companyLogoHash: String((logoHashRows.rows as any[])[0]?.logoHash ?? ""),
  };
}

/** Stable branding version: sha1 over company + per-business logo hashes. */
export function brandingVersionOf(r: InitReadResult): string {
  const parts = [r.companyLogoHash];
  for (const id of [...r.businessLogoHashes.keys()].sort((a, b) => a - b)) {
    parts.push(`${id}:${r.businessLogoHashes.get(id)}`);
  }
  return createHash("sha1").update(parts.join("|")).digest("hex");
}
