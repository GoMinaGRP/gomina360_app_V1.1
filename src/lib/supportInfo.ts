/**
 * supportInfo — SERVER-ONLY helpers for the storefront HELP / platform
 * Help-Contact row (`customer_support_info`).
 *
 * SCOPE MODEL
 * -----------
 * The public storefront (`/order`) is a centralized marketplace that sells
 * every ACTIVE organization's stock, so the HELP panel on it is the PLATFORM
 * helpdesk. Exactly one row is flagged `isPlatform = true`; that row is:
 *   • what every shopper sees when they tap HELP,
 *   • what the Super Admin edits,
 *   • where the public "Join GoMina 360" CTA configuration lives.
 *
 * Tenant rows (organizationId set, is_platform false) remain for future
 * per-owner storefronts and are read back with `?org=<id>`.
 *
 * LEGACY FALLBACK — an existing deployment may already have a support row for
 * organisation #1 (the canonical platform organisation) and no flagged row.
 * `getPlatformSupportRow()` therefore prefers the flagged row and falls back
 * to org #1's row, so an upgrade never loses the published helpdesk text. The
 * first Super-Admin save promotes that row (sets is_platform = true).
 *
 * NO DB imports leak to the client: this module is only imported by API
 * routes. Client components talk to `/api/support-info`.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customerSupportInfo } from "@/db/schema";

/**
 * The canonical platform organisation. Historically the storefront's support
 * row was "organisation #1" by convention; `customer_support_info.is_platform`
 * now states that intent explicitly, and this constant only seeds the
 * platform organisation for a brand-new database.
 */
export const PLATFORM_ORG_ID = 1;

export type SupportRow = typeof customerSupportInfo.$inferSelect;

/** The user-facing/public projection of a support row (no internal ids). */
export function publicSupportInfo(row: SupportRow | null | undefined) {
  if (!row) return null;
  return {
    contactName: row.contactName,
    phone: row.phone,
    whatsapp: row.whatsapp,
    email: row.email,
    address: row.address,
    openingHours: row.openingHours,
    extraInfo: row.extraInfo,
    registrationEnabled: row.registrationEnabled !== false,
    registrationHeadline: row.registrationHeadline,
    registrationNote: row.registrationNote,
    // The login-page switch travels with the same public projection so the
    // Super Admin's editor can read its own saved value back.
    loginRegistrationEnabled: row.loginRegistrationEnabled === true,
    updatedByName: row.updatedByName,
    updatedAt: row.updatedAt,
  };
}

/**
 * THE LOGIN-PAGE SWITCH, resolved for the sign-in gate.
 *
 * Read by `src/app/page.tsx` at build / background-revalidation time (ISR) and
 * handed to the client as a plain boolean, so the login page never fetches it.
 *
 * FAIL-CLOSED: no platform row, a NULL column or any read error all mean
 * "hidden" — the one default the platform owner can then opt into. This is
 * also what makes the login page unbreakable: a database hiccup can only
 * remove a marketing line, never the sign-in form.
 */
export async function loginRegistrationInviteEnabled(): Promise<boolean> {
  try {
    const row = await getPlatformSupportRow();
    return row?.loginRegistrationEnabled === true;
  } catch (e) {
    console.error("loginRegistrationInviteEnabled warning:", e);
    return false;
  }
}

/** The row shoppers see: the flagged platform row, else org #1's (legacy). */
export async function getPlatformSupportRow(): Promise<SupportRow | null> {
  const [flagged] = await db
    .select()
    .from(customerSupportInfo)
    .where(eq(customerSupportInfo.isPlatform, true))
    .limit(1);
  if (flagged) return flagged;
  const [legacy] = await db
    .select()
    .from(customerSupportInfo)
    .where(eq(customerSupportInfo.organizationId, PLATFORM_ORG_ID))
    .limit(1);
  return legacy ?? null;
}

/** A specific organisation's own support row (future per-owner storefronts). */
export async function getSupportRowForOrg(orgId: number): Promise<SupportRow | null> {
  const [row] = await db
    .select()
    .from(customerSupportInfo)
    .where(eq(customerSupportInfo.organizationId, Number(orgId)))
    .limit(1);
  return row ?? null;
}

/** Every organisation id a session belongs to (membership rows are authoritative). */
export function orgIdsOf(session: { orgId?: number | null; orgIds?: number[] }): number[] {
  const ids = new Set<number>();
  for (const raw of session.orgIds || []) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) ids.add(n);
  }
  const primary = Number(session.orgId);
  if (Number.isFinite(primary) && primary > 0) ids.add(primary);
  return Array.from(ids);
}

export type SupportScope = "PLATFORM" | "ORGANIZATION";

/**
 * Which row this session writes. The Super Admin always edits the PLATFORM row
 * (regardless of which organisation lens they are viewing); members of the
 * platform organisation do too — they ARE the platform's staff. Everyone else
 * edits their own organisation's row.
 *
 * This is what removes the old read/write asymmetry: the editor is handed the
 * very row its Save will write (`edit.row` from GET /api/support-info).
 */
export function supportScopeFor(session: {
  isSuperAdmin?: boolean;
  orgId?: number | null;
  orgIds?: number[];
}): SupportScope {
  if (session.isSuperAdmin) return "PLATFORM";
  return orgIdsOf(session).includes(PLATFORM_ORG_ID) ? "PLATFORM" : "ORGANIZATION";
}

/**
 * May this user edit the storefront HELP information at all?
 *  • PLATFORM scope  → Super Admin, or the platform org's OWNER, or a user the
 *    OWNER granted `canManageSupport` (the existing, tested delegation).
 *  • ORGANIZATION    → that organisation's OWNER, or a granted user.
 *
 * `canManageSupport` controls the *published contact details* only. The
 * registration CTA is gated separately — see `canEditRegistration`.
 */
export function canEditSupport(user: any, _scope: SupportScope): boolean {
  if (!user) return false;
  // `role === "OWNER"` here means an OWNER of the organisation whose row is
  // being written — the platform org's OWNER for PLATFORM scope, the tenant's
  // OWNER for ORGANIZATION scope. Staff need the explicit grant.
  return !!(user.isSuperAdmin || user.role === "OWNER" || user.canManageSupport);
}

/**
 * The "Join / Register on the Platform" CTA is platform marketing config, so
 * it is deliberately STRICTER than the contact details: Super Admin only.
 * A tenant-scoped `canManageSupport` grant must never be able to open or close
 * public recruitment for the whole platform.
 */
export function canEditRegistration(user: any): boolean {
  return !!user?.isSuperAdmin;
}

/**
 * The single source of truth for the public error text, so API and UI agree.
 * (Kept here rather than in the route so the wording is testable.)
 */
export const SUPPORT_FORBIDDEN_MESSAGE =
  "Only the OWNER — or a user the OWNER granted Customer Support access — can edit the storefront HELP information.";
