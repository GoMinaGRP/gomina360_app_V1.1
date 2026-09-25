/**
 * External Farm Advisor / Resource Person — access control core.
 *
 * PHASE-0 SECURITY CONTRACT
 * ─────────────────────────
 * An ADVISOR is an outside professional invited by the Owner. The role is
 * READ-ONLY everywhere in the platform, and that must be impossible to bypass
 * through the API — not merely hidden in the UI. Three layers enforce it:
 *
 *  1. IDENTITY GATE (authoritative, central).  `getSessionInfo()` in lib/auth.ts
 *     calls `assertRequestAllowedForActor()` on EVERY authenticated request.
 *     Any non-GET/HEAD request from a read-only actor to a path outside the
 *     advisor's own allowlist throws `ReadOnlyActorError` → 403. This covers
 *     every route that exists today AND every route written in the future,
 *     because every route resolves its session through that one function.
 *  2. SCOPE GATE.  `canMutateBusiness()` / `assertWritable()` are available for
 *     routes that want an explicit, well-worded 403, and `advisorGrantFor()`
 *     answers "may this advisor see THIS business/branch/flock/scope?".
 *  3. DATA MINIMISATION.  `projectInitForAdvisor()` strips the bootstrap
 *     payload down to farm operations only: no finance, no payroll, no
 *     employees, no customers, no suppliers, no user directory — and no money
 *     fields at all unless the grant explicitly enables COSTS.
 *
 * This module never imports lib/auth.ts (auth imports it) and holds no React.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { advisorAssignments, ADVISOR_SCOPES, type AdvisorScope } from "@/db/schema";

export const ADVISOR_ROLE = "ADVISOR";

/** Roles that may never write anything, anywhere (outside their own notes). */
const READ_ONLY_ROLES = new Set([ADVISOR_ROLE]);

/** Thrown by the session resolver when a read-only actor attempts a write.
 *  Carries an HTTP status so `apiError()` renders a proper 403. */
export class ReadOnlyActorError extends Error {
  status = 403;
  constructor(message = "Advisor access is read-only. You can add advisory notes, but you cannot create, change or delete farm records.") {
    super(message);
    this.name = "ReadOnlyActorError";
  }
}

export function isAdvisor(user: any): boolean {
  return String(user?.role || "").toUpperCase() === ADVISOR_ROLE;
}

/** True when the actor may never mutate platform records. */
export function isReadOnlyActor(user: any): boolean {
  if (!user) return false;
  if (user.isSuperAdmin) return false;
  return READ_ONLY_ROLES.has(String(user.role || "").toUpperCase());
}

/* ── 1 · identity gate ─────────────────────────────────────────────────── */

/** Paths a read-only actor MAY POST/PATCH/DELETE to. Everything else is
 *  refused before the route handler ever runs. Kept deliberately tiny. */
const ADVISOR_WRITE_ALLOWLIST: RegExp[] = [
  /^\/api\/advisor\/notes$/,      // file / edit / withdraw their own advisory notes
  /^\/api\/advisor\/visits$/,     // log their own visits
  /^\/api\/advisor\/digest$/,     // generate an advisory digest (analysis only)
  /^\/api\/auth\/login$/,
  /^\/api\/auth\/logout$/,
  /^\/api\/auth\/change-password$/,
  /^\/api\/session\/heartbeat$/,
  /^\/api\/profile(\/.*)?$/,      // own name/photo/password
  /^\/api\/push(\/.*)?$/,         // own push subscription
  /^\/api\/notifications$/,       // mark own bell items read
];

/** Paths a read-only actor MAY READ. Fail-closed allowlist: an advisor's whole
 *  world is /api/advisor* (already grant-scoped and money-stripped), the
 *  bootstrap payload (projected), and self-service. Finance, payroll, HR, CRM,
 *  procurement, CCTV, exports and every other module are refused outright —
 *  reads included — so nothing sensitive can be pulled by hand-crafted calls. */
const ADVISOR_READ_ALLOWLIST: RegExp[] = [
  /^\/api\/init$/,
  /^\/api\/advisor(\/.*)?$/,
  /^\/api\/auth\/(login|logout|me|change-password)$/,
  /^\/api\/session(\/.*)?$/,
  /^\/api\/profile(\/.*)?$/,
  /^\/api\/push(\/.*)?$/,
  /^\/api\/notifications$/,
  /^\/api\/health$/,
  /^\/api\/logos(\/.*)?$/,
  /^\/api\/poultry$/,            // re-scoped to the grant inside the route
];

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Central write gate. Called for every authenticated request.
 * Throws `ReadOnlyActorError` when a read-only actor attempts a mutation on a
 * path that is not on their allowlist. Fail-closed: an unparsable URL denies.
 */
export function assertRequestAllowedForActor(user: any, request: Request): void {
  if (!isReadOnlyActor(user)) return;
  const method = String((request as any)?.method || "GET").toUpperCase();
  let pathname = "";
  try {
    pathname = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    throw new ReadOnlyActorError();
  }
  if (SAFE_METHODS.has(method)) {
    if (ADVISOR_READ_ALLOWLIST.some((re) => re.test(pathname))) return;
    throw new ReadOnlyActorError(
      "Advisory access covers farm operations only. That area (finance, HR, customers and other business records) is not part of an advisor's remit.",
    );
  }
  if (ADVISOR_WRITE_ALLOWLIST.some((re) => re.test(pathname))) return;
  throw new ReadOnlyActorError();
}

/* ── 2 · scope gate ────────────────────────────────────────────────────── */

export interface AdvisorGrant {
  id: number;
  userId: number;
  businessId: number;
  branchCode: string | null;
  scopes: string[];
  flockIds: number[] | null;
  showCosts: boolean;
  canExport: boolean;
  startsOn: string | null;
  endsOn: string | null;
}

const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local

/** Is the grant live today? (isActive + engagement window). */
export function grantInWindow(row: any, onDate = today()): boolean {
  if (!row || row.isActive === false) return false;
  if (row.startsOn && String(row.startsOn) > onDate) return false;
  if (row.endsOn && String(row.endsOn) < onDate) return false;
  return true;
}

function toGrant(row: any): AdvisorGrant {
  const scopes = Array.isArray(row.scopes) ? row.scopes.map(String) : [];
  const flockIds = Array.isArray(row.flockIds)
    ? row.flockIds.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
    : null;
  return {
    id: Number(row.id),
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    branchCode: row.branchCode ?? null,
    scopes,
    flockIds: flockIds && flockIds.length ? flockIds : null,
    showCosts: row.showCosts === true,
    canExport: row.canExport === true,
    startsOn: row.startsOn ?? null,
    endsOn: row.endsOn ?? null,
  };
}

/** Every LIVE grant of an advisor (empty for non-advisors). */
export async function resolveAdvisorGrants(user: any): Promise<AdvisorGrant[]> {
  if (!isAdvisor(user) || !user?.id) return [];
  const rows = await db
    .select()
    .from(advisorAssignments)
    .where(eq(advisorAssignments.userId, Number(user.id)));
  return rows.filter((r) => grantInWindow(r)).map(toGrant);
}

/** All grants (live or not) — for the Owner console and expiry reporting. */
export async function listAdvisorGrants(businessIds: number[] | null): Promise<any[]> {
  if (businessIds && businessIds.length === 0) return [];
  const rows = businessIds
    ? await db.select().from(advisorAssignments).where(inArray(advisorAssignments.businessId, businessIds))
    : await db.select().from(advisorAssignments);
  return rows.map((r) => ({ ...r, live: grantInWindow(r) }));
}

/** Business ids an advisor may currently read. */
export async function advisorBusinessIds(user: any): Promise<number[]> {
  const grants = await resolveAdvisorGrants(user);
  return [...new Set(grants.map((g) => g.businessId))];
}

/** The live grant covering a business (null when none). */
export async function advisorGrantFor(user: any, businessId: number | null | undefined): Promise<AdvisorGrant | null> {
  if (businessId == null) return null;
  const grants = await resolveAdvisorGrants(user);
  return grants.find((g) => g.businessId === Number(businessId)) || null;
}

export function grantHasScope(grant: AdvisorGrant | null, scope: AdvisorScope | string): boolean {
  if (!grant) return false;
  return grant.scopes.includes(String(scope));
}

/** Does the grant cover this branch code? (null branchCode = all branches). */
export function grantCoversBranch(grant: AdvisorGrant | null, branchCode: string | null | undefined): boolean {
  if (!grant) return false;
  if (!grant.branchCode) return true;
  if (!branchCode) return false;
  return String(grant.branchCode).toUpperCase() === String(branchCode).toUpperCase();
}

/** Does the grant cover this flock? (null flockIds = all flocks). */
export function grantCoversFlock(grant: AdvisorGrant | null, flockId: number | null | undefined): boolean {
  if (!grant) return false;
  if (!grant.flockIds) return true;
  if (flockId == null) return true; // unit-level note, not flock-specific
  return grant.flockIds.includes(Number(flockId));
}

export function sanitizeScopes(input: any): string[] {
  const allowed = new Set<string>(ADVISOR_SCOPES as readonly string[]);
  const list = Array.isArray(input) ? input.map((s) => String(s).toUpperCase()) : [];
  return [...new Set(list.filter((s) => allowed.has(s)))];
}

/**
 * Explicit mutation gate for route handlers that want a clear 403 message.
 * Read-only actors are always refused; everyone else keeps their existing
 * behaviour (business access is still checked by the caller).
 */
export function canMutate(user: any): boolean {
  return !isReadOnlyActor(user);
}

/** Throws `ReadOnlyActorError` when the actor may not write. */
export function assertWritable(user: any): void {
  if (isReadOnlyActor(user)) throw new ReadOnlyActorError();
}

/* ── 3 · data minimisation ─────────────────────────────────────────────── */

/** Money-bearing field names stripped from every row served to a cost-blind
 *  advisor. Matching is by exact key OR by the "…Ghs" suffix convention used
 *  throughout the schema. */
const MONEY_KEYS = new Set([
  "revenue", "profit", "cost", "price", "amount", "salary", "wage", "balance",
  "unitPrice", "sellingPrice", "costPrice", "totalValue", "value",
  "monthlyRevenue", "monthlyProfit", "monthlyExpenses", "dailyRevenue",
]);

const isMoneyKey = (k: string) =>
  MONEY_KEYS.has(k) || /Ghs$/.test(k) || /^(cost|price|revenue|profit|amount)[A-Z]/.test(k);

export function stripMoney<T extends Record<string, any>>(row: T): T {
  if (!row || typeof row !== "object") return row;
  const out: any = {};
  for (const [k, v] of Object.entries(row)) {
    if (isMoneyKey(k)) continue;
    out[k] = v;
  }
  return out as T;
}

export const stripMoneyRows = <T extends Record<string, any>>(rows: T[]): T[] =>
  (Array.isArray(rows) ? rows : []).map(stripMoney);

/**
 * Reduce the /api/init bootstrap payload to what an advisor may legitimately
 * see. This is the single most important data-exposure control in the feature:
 * finance, HR and commercial collections are REMOVED here on the server, so
 * they never travel over the wire regardless of what the client asks for.
 */
export function projectInitForAdvisor(payload: any, grants: AdvisorGrant[], meId: number): any {
  const byBusiness = new Map(grants.map((g) => [g.businessId, g]));
  const allowedIds = [...byBusiness.keys()];
  const showCosts = grants.some((g) => g.showCosts);
  const hasScope = (businessId: any, scope: AdvisorScope) =>
    grantHasScope(byBusiness.get(Number(businessId)) || null, scope);

  const inScope = (rows: any[], scope?: AdvisorScope) =>
    (Array.isArray(rows) ? rows : []).filter(
      (r: any) =>
        r &&
        r.businessId != null &&
        byBusiness.has(Number(r.businessId)) &&
        grantCoversBranch(byBusiness.get(Number(r.businessId))!, r.branchCode) &&
        (!scope || hasScope(r.businessId, scope)),
    );

  const money = (rows: any[]) => (showCosts ? rows : stripMoneyRows(rows));

  const businesses = (payload.businesses || [])
    .filter((b: any) => byBusiness.has(Number(b.id)))
    .map((b: any) => {
      const base = showCosts ? b : stripMoney(b);
      // Storefront/payment/contact settings are operational noise for an
      // advisor and carry commercial data — drop the heaviest of them.
      const { momoNumbers, momoNumber, paymentInstructions, ...rest } = base as any;
      return rest;
    });

  return {
    ...payload,
    accessibleBusinessIds: allowedIds,
    advisor: {
      isAdvisor: true,
      grants: grants.map((g) => ({
        businessId: g.businessId,
        branchCode: g.branchCode,
        scopes: g.scopes,
        flockIds: g.flockIds,
        showCosts: g.showCosts,
        canExport: g.canExport,
        startsOn: g.startsOn,
        endsOn: g.endsOn,
      })),
      showCosts,
    },
    businesses,
    // ── Removed entirely: finance, HR, commercial and platform surfaces ──
    customers: [],
    creditSales: [],
    suppliers: [],
    employees: [],
    transactions: [],
    assets: [],
    scenarios: [],
    integrations: [],
    aiInsights: [],
    organizations: [],
    // Own account only — no staff directory for an outsider.
    users: (payload.users || []).filter((u: any) => Number(u.id) === Number(meId)),
    metrics: money(inScope(payload.metrics || [], "DASHBOARD")),
    inventory: hasScopeAny(grants, "INVENTORY_LEVELS")
      ? money(inScope(payload.inventory || [], "INVENTORY_LEVELS"))
      : [],
    checklists: {
      templates: inScope(payload.checklists?.templates || [], "DAILY_OPS"),
      entries: inScope(payload.checklists?.entries || [], "DAILY_OPS"),
    },
    specializedLogs: Object.fromEntries(
      Object.entries(payload.specializedLogs || {}).map(([k, v]) => [k, money(inScope(v as any[], "DASHBOARD"))]),
    ),
  };
}

const hasScopeAny = (grants: AdvisorGrant[], scope: AdvisorScope) =>
  grants.some((g) => g.scopes.includes(scope));

/** Permission flags an ADVISOR account can never hold — clamped server-side
 *  on every create/update so a crafted request body cannot elevate them. */
export const ADVISOR_FORCED_FLAGS = {
  canRecordSales: false,
  canRecordExpenses: false,
  canManageStock: false,
  canExportData: false,
  canManageRecords: false,
  canDeleteInventory: false,
  canManageExpenses: false,
  canManageUsers: false,
  canManageCctv: false,
  canManageAuditors: false,
  canManageOnline: false,
  canCreateBusiness: false,
  canViewFinance: false,
  canManageSupport: false,
  canManageAdvisors: false,
  businessManageIds: [] as number[],
} as const;

/** May this actor grant / scope / revoke Advisor access? OWNER always; a
 *  manager only while the OWNER granted `canManageAdvisors` (and then only
 *  inside their own accessible businesses — enforced by the caller). */
export function canManageAdvisors(user: any): boolean {
  if (!user) return false;
  if (user.role === "OWNER") return true;
  return user.canManageAdvisors === true && ["GENERAL_MANAGER", "BRANCH_MANAGER"].includes(String(user.role));
}

/** Advisor-visible flock filter for a single business. */
export function filterFlocksForGrant<T extends { id?: number; branchCode?: string | null }>(
  rows: T[],
  grant: AdvisorGrant | null,
): T[] {
  if (!grant) return [];
  return (rows || []).filter((f) => grantCoversBranch(grant, f.branchCode) && grantCoversFlock(grant, f.id ?? null));
}

/** Rows (feed/water/health/production/weights) narrowed to a grant. */
export function filterFlockRowsForGrant<T extends { branchCode?: string | null; flockId?: number | null }>(
  rows: T[],
  grant: AdvisorGrant | null,
): T[] {
  if (!grant) return [];
  return (rows || []).filter((r) => grantCoversBranch(grant, r.branchCode) && grantCoversFlock(grant, r.flockId ?? null));
}

export async function advisorAssignmentRowsForUser(userId: number) {
  return db.select().from(advisorAssignments).where(and(eq(advisorAssignments.userId, Number(userId))));
}
