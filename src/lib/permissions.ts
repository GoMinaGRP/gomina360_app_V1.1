/**
 * Pure, client-safe permission helpers — NO database or server imports, so
 * both React components and API routes can use them.
 *
 * "Business manager" (OWNER-delegated) semantics:
 *   • The OWNER always has owner-equivalent power over every unit.
 *   • Any other user holds owner-equivalent power over a unit ONLY while the
 *     OWNER has granted that unit via `users.businessManageIds`.
 *   • Every other business/branch stays out of reach.
 */

import { ROLE_GROUPS, normaliseRole } from "@/lib/roles";
/** The business ids a user may manage with owner-equivalent power (OWNER ⇒ []). */
export function businessManageIdsOf(user: any): number[] {
  if (!user) return [];
  const ids = user?.businessManageIds;
  if (!Array.isArray(ids)) return [];
  return ids.map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

/** True when the user is the group OWNER. */
export function isOwner(user: any): boolean {
  return normaliseRole(user?.role) === "OWNER";
}

/** True when the user may manage `businessId` with owner-equivalent power. */
export function managesBusiness(user: any, businessId: number | null | undefined): boolean {
  if (!user) return false;
  if (normaliseRole(user.role) === "OWNER") return true;
  if (businessId == null) return false;
  return businessManageIdsOf(user).includes(Number(businessId));
}

/** Alias — owner-equivalent power over a specific unit. */
export function isOwnerOfBusiness(user: any, businessId: number | null | undefined): boolean {
  return managesBusiness(user, businessId);
}

/* ────────────────────────────────────────────────────────────────────────────
 * SENSITIVE SURFACES — Owner authority, delegated explicitly.
 *
 * Two surfaces are NEVER implied by a role alone (a General Manager is not an
 * owner): the ENTERPRISE USERS directory and every FINANCIAL / performance
 * figure. Both open only to the OWNER, the platform Super Admin, or somebody
 * the OWNER has explicitly authorised through the access console
 * (`users.canManageUsers` / `users.canViewFinance`). Role alone never grants
 * them, so a newly created account starts with neither.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Roles that command the organisation operationally (no money implication). */
export const EXECUTIVE_ROLES = ROLE_GROUPS.EXECUTIVE;

/** True when the account is an organisation executive (owner or their GM/co-owner). */
export function isExecutiveRole(user: any): boolean {
  return !!user && (EXECUTIVE_ROLES as readonly string[]).includes(String(user.role || "").toUpperCase());
}

/**
 * SENSITIVE SURFACE 1 — Enterprise Users (staff directory + access console).
 * OWNER, platform Super Admin, or an explicit `canManageUsers` grant only.
 */
export function canSeeEnterpriseUsers(user: any): boolean {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  if (normaliseRole(user.role) === "OWNER") return true;
  return user.canManageUsers === true;
}

/**
 * SENSITIVE SURFACE 2 — money & performance figures: the Central Financial
 * Report, Command Center P&L, budgets, cash-flow forecasts, payroll and
 * exports. OWNER, platform Super Admin, or an explicit `canViewFinance`
 * grant only.
 */
export function canSeeFinancials(user: any): boolean {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  if (normaliseRole(user.role) === "OWNER") return true;
  return user.canViewFinance === true;
}

/**
 * True when a user may be granted sensitive powers at all — the OWNER (or the
 * platform Super Admin acting on the OWNER's behalf). Used to keep the
 * authorisation switches in the Owner's hands.
 */
export function canGrantSensitiveAccess(user: any): boolean {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  return normaliseRole(user.role) === "OWNER";
}

/* ────────────────────────────────────────────────────────────────────────────
 * EXPORT MODULES — what may leave the building.
 *
 * Two helpers, one source of truth for BOTH the API route (/api/exports) and
 * the Export Center UI: an ability to export at all (`canExportData`) never
 * decided WHICH module may be exported. These classify the sensitive modules
 * and return the denial message (or null when permitted).
 *
 *   • FINANCE   — the Command Center P&L, the enterprise Sales & Payments and
 *                 Financial Transactions ledgers, and any payroll / budget /
 *                 cash-flow / expense / credit module. Enterprise-wide export
 *                 needs `canSeeFinancials`; without it a user may export ONE
 *                 unit the OWNER has delegated to them (their own books).
 *   • DIRECTORY — "Enterprise Users & Assignments" is the staff directory:
 *                 `canSeeEnterpriseUsers` only (a Branch Manager exports its
 *                 own workers through WORKERS_MANAGE, which stays available).
 * ──────────────────────────────────────────────────────────────────────────── */
const FINANCE_EXPORT_MODULES = new Set(["COMMAND_CENTER", "SALES_CENTER", "TRANSACTIONS"]);
const FINANCE_MODULE_PATTERN = /(PAYROLL|BUDGET|CASHFLOW|CASH_FLOW|FINANCE|FINANCIAL|CREDIT_SALE|EXPENSE|SALARY|PROFIT|REVENUE)/;
const DIRECTORY_EXPORT_MODULES = new Set(["USERS_MANAGE", "ENTERPRISE_USERS", "USER_MANAGEMENT"]);

const normalizeModuleKey = (key: unknown) => String(key || "").trim().toUpperCase();

/** True when exporting `moduleKey` would carry money / performance figures. */
export function isFinanceExportModule(moduleKey: unknown): boolean {
  const key = normalizeModuleKey(moduleKey);
  return FINANCE_EXPORT_MODULES.has(key) || FINANCE_MODULE_PATTERN.test(key);
}

/** True when `moduleKey` is the staff directory / access console export. */
export function isDirectoryExportModule(moduleKey: unknown): boolean {
  return DIRECTORY_EXPORT_MODULES.has(normalizeModuleKey(moduleKey));
}

/**
 * Authorisation for exporting `moduleKey` at `scopedBusinessId` (null = every
 * unit in the workspace). Returns null when allowed, else the reason to show.
 */
export function exportModuleDenial(
  user: any,
  moduleKey: unknown,
  scopedBusinessId: number | null | undefined,
): string | null {
  if (!user) return "Not authenticated";
  if (isDirectoryExportModule(moduleKey)) {
    if (canSeeEnterpriseUsers(user)) return null;
    return "The Enterprise Users directory can only be exported by the OWNER and the users the OWNER authorises for Enterprise Users.";
  }
  if (isFinanceExportModule(moduleKey) && !canSeeFinancials(user)) {
    // A delegated unit manager may still export that one unit's money records
    // (their own books) — never the enterprise-wide report.
    if (scopedBusinessId != null && managesBusiness(user, Number(scopedBusinessId))) return null;
    return "Financial exports (Command Center, Sales & Payments, Financial Transactions, payroll, budgets) are restricted to the OWNER and the users the OWNER authorises for Finance & Reports.";
  }
  return null;
}
