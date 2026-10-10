/**
 * bellAudience.ts — THE audience rule for every bell notification.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * GoMina already has exactly one definition of "which businesses can this user
 * open?" — `accessibleBusinessIds()` in `src/lib/auth.ts`, which the sidebar,
 * the dashboards, the export button, every API scope gate and the navigation
 * rail all obey. It is the app's definition of **My Workspace**.
 *
 * The bell did NOT use it. Each producer hand-rolled its own copy of "who is
 * this business for?", and the copies disagreed with each other and with the
 * app:
 *
 *   • `orderNotificationRecipients` knew about assignment and grants but NOT
 *     manage-delegation — so a manager the Owner had delegated a unit could
 *     OPEN that unit in the sidebar and get no purchase, order, checklist,
 *     stock or dunning bell for it. Their workspace and their bell disagreed.
 *   • every copy required `organization_members` membership, so a platform
 *     **Super Admin** — whose My Workspace is, by definition, every business —
 *     had a platform-wide scope and a platform-silent bell.
 *   • `auditEscalationRecipients` repeated the manage-delegation blind spot.
 *
 * And all of `notifyActivity` then removed the **actor** from its audience, so
 * when the OWNER recorded the sale themselves, the Owner's own bell — whose
 * entire job is to be the complete record of their workspace — stayed silent
 * for exactly the one row they most wanted to see.
 *
 * ── The rule this file enforces ─────────────────────────────────────────────
 * A notification about business B belongs to **every user whose My Workspace
 * contains B** — computed the same way the rest of the app computes it — and
 * to nobody else. Per-type policy (does this person need the finance grant? are
 * they a checklist manager?) is layered on top by each producer, but the
 * *reachability* question is answered here and only here.
 *
 * ── Self-execution ──────────────────────────────────────────────────────────
 * `withoutSelf()` drops the actor so people are not pinged for their own
 * keystrokes — **except** the OWNER / Super Admin, whose bell is a ledger of
 * their workspace rather than a peer feed. Telling the Owner "you did not see
 * this because you were the one who did it" is precisely the gap this fixes.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  advisorAssignments,
  businesses,
  organizations,
  organizationMembers,
  userBusinessAccess,
  users,
} from "@/db/schema";
import { businessManageIdsOf } from "./permissions";

export interface BellRecipient {
  id: number;
  name: string | null;
  role: string | null;
  isSuperAdmin: boolean;
  canViewFinance: boolean;
  canManageRecords: boolean;
  assignedBusinessId: number | null;
  businessManageIds: number[];
}

/**
 * THE user ids a tenant's bell fan-out may address.
 *
 * `organization_members` is authoritative, but it is a TABLE that only
 * organization provisioning fills. A deployment can easily hold an
 * organization whose recorded OWNER has no membership row — the OWNER account
 * predates multi-tenant provisioning, the org was created by the seed, or the
 * membership backfill was never run. Every helper below resolves its audience
 * through this function, so such a gap silently silenced that organization's
 * OWNER entirely: money, orders, purchases and audit events all posted, and
 * nobody — least of all the Owner's own workspace — was ever told.
 *
 * `organizations.owner_user_id` is the tenant's own record of who owns it, so
 * unioning it in is a safe, tenant-preserving repair: it can only ever ADD
 * that organization's OWNER, never a stranger. Callers select the resulting
 * ids from `users`, so an id that no longer exists (deleted account) simply
 * drops out, and the `isActive === false` filter still applies.
 */
export async function orgRecipientUserIds(orgId: number | null): Promise<Set<number>> {
  const org = Number(orgId);
  const ids = new Set<number>();
  if (!org) return ids;
  const [memberRows, orgRow] = await Promise.all([
    db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, org)),
    db
      .select({ ownerUserId: organizations.ownerUserId })
      .from(organizations)
      .where(eq(organizations.id, org))
      .limit(1),
  ]);
  for (const m of memberRows) ids.add(Number(m.userId));
  if (orgRow?.[0]?.ownerUserId != null) ids.add(Number(orgRow[0].ownerUserId));
  return ids;
}

/** True for the principals whose bell is the complete record of their scope:
 *  the tenant's OWNER, a co-owner, and any platform Super Admin. */
export function isWorkspacePrincipal(u: {
  role?: string | null;
  isSuperAdmin?: boolean | null;
}): boolean {
  const role = String(u?.role || "").toUpperCase();
  return role === "OWNER" || role === "CO_OWNER" || u?.isSuperAdmin === true;
}

/**
 * Drop the actor from an audience — but keep them when they are a workspace
 * principal. Every producer routes its self-exclusion through this so the rule
 * is written down exactly once.
 */
export function withoutSelf<T extends { id: number; role?: string | null; isSuperAdmin?: boolean | null }>(
  rows: T[],
  actorUserId: number | null | number[] | undefined,
): T[] {
  if (actorUserId == null) return rows;
  const actor = Number(actorUserId);
  if (!Number.isFinite(actor)) return rows;
  return rows.filter((r) => Number(r.id) !== actor || isWorkspacePrincipal(r));
}

/**
 * Everyone whose My Workspace contains `businessId`.
 *
 * Mirrors `accessibleBusinessIds()` rule for rule — Super Admin ⇒ platform
 * wide, OWNER ⇒ every unit of their organization, FARM_ADVISOR ⇒ only through
 * a live advisor assignment (an advisor must never inherit an org-wide bell),
 * everyone else ⇒ assignment ∪ manage-delegation ∪ grants, intersected with
 * their own organizations so a grant can never reach a sibling tenant.
 *
 * Computed in bulk (4 queries regardless of tenant size) because it runs inline
 * with a sale, a purchase or a task creation.
 */
export async function workspaceAudience(businessId: number): Promise<BellRecipient[]> {
  const bizId = Number(businessId);
  if (!bizId) return [];

  const [biz] = await db
    .select({ id: businesses.id, ownerId: businesses.ownerId })
    .from(businesses)
    .where(eq(businesses.id, bizId));
  if (!biz) return [];
  const orgId = biz.ownerId != null ? Number(biz.ownerId) : null;

  // Candidate pool: active users who are either a member of this tenant
  // (including the tenant's recorded owner, whose membership row may be
  // missing on an unmigrated deployment) or a platform Super Admin.
  const memberIdSet = new Set<number>();
  if (orgId != null) {
    const [members, org] = await Promise.all([
      db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, orgId)),
      db
        .select({ ownerUserId: organizations.ownerUserId })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1),
    ]);
    for (const m of members) memberIdSet.add(Number(m.userId));
    const recordedOwner = org?.[0]?.ownerUserId;
    if (recordedOwner != null) memberIdSet.add(Number(recordedOwner));
  }

  const staff = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      isSuperAdmin: users.isSuperAdmin,
      canViewFinance: users.canViewFinance,
      canManageRecords: users.canManageRecords,
      assignedBusinessId: users.assignedBusinessId,
      businessManageIds: users.businessManageIds,
    })
    .from(users);
  const candidates = staff.filter((u) => u.isActive !== false && (u.isSuperAdmin === true || memberIdSet.has(Number(u.id))));
  if (!candidates.length) return [];

  const ids = candidates.map((u) => Number(u.id));
  const today = new Date().toISOString().slice(0, 10);
  const [grants, advisorGrants, orgBizRows] = await Promise.all([
    db
      .select({ userId: userBusinessAccess.userId, businessId: userBusinessAccess.businessId })
      .from(userBusinessAccess)
      .where(inArray(userBusinessAccess.userId, ids)),
    db
      .select({
        userId: advisorAssignments.userId,
        businessId: advisorAssignments.businessId,
        isActive: advisorAssignments.isActive,
        validUntil: advisorAssignments.validUntil,
      })
      .from(advisorAssignments)
      .where(inArray(advisorAssignments.userId, ids)),
    orgId != null
      ? db
          .select({ id: businesses.id })
          .from(businesses)
          .where(eq(businesses.ownerId, orgId))
      : Promise.resolve([] as { id: number }[]),
  ]);
  const orgBizIds = new Set(orgBizRows.map((b) => Number(b.id)));
  const grantedTo = new Map<number, Set<number>>();
  for (const g of grants) {
    if (!grantedTo.has(Number(g.userId))) grantedTo.set(Number(g.userId), new Set());
    grantedTo.get(Number(g.userId))!.add(Number(g.businessId));
  }
  const advisorTo = new Map<number, Set<number>>();
  for (const a of advisorGrants) {
    if (a.isActive === false) continue;
    if (a.validUntil && String(a.validUntil) < today) continue; // expired == revoked
    if (!advisorTo.has(Number(a.userId))) advisorTo.set(Number(a.userId), new Set());
    advisorTo.get(Number(a.userId))!.add(Number(a.businessId));
  }

  return candidates
    .filter((u) => {
      const role = String(u.role || "").toUpperCase();
      // Platform-wide by definition — mirrors accessibleBusinessIds() === null.
      if (u.isSuperAdmin === true) return true;
      // FARM_ADVISOR reaches a unit ONLY through a live advisor grant. Never
      // through org membership: an advisor is an external party and must not
      // inherit the tenant's internal bell.
      if (role === "FARM_ADVISOR") return advisorTo.get(Number(u.id))?.has(bizId) === true;
      // Every unit of the tenant's own organization.
      if (role === "OWNER" || role === "CO_OWNER") return orgBizIds.has(bizId);
      // Assignment ∪ manage-delegation ∪ grants — intersected with the user's
      // own organizations, so a stray grant can never reach a sibling tenant.
      if (orgId == null) return false;
      if (!orgBizIds.has(bizId)) return false;
      const mine = new Set<number>();
      if (u.assignedBusinessId != null) mine.add(Number(u.assignedBusinessId));
      for (const m of businessManageIdsOf(u as any)) mine.add(Number(m));
      for (const g of grantedTo.get(Number(u.id)) || []) mine.add(g);
      return mine.has(bizId);
    })
    .map((u) => ({
      id: Number(u.id),
      name: u.name,
      role: u.role,
      isSuperAdmin: u.isSuperAdmin === true,
      canViewFinance: u.canViewFinance === true,
      canManageRecords: u.canManageRecords === true,
      assignedBusinessId: u.assignedBusinessId != null ? Number(u.assignedBusinessId) : null,
      businessManageIds: Array.isArray(u.businessManageIds) ? u.businessManageIds.map(Number) : [],
    }));
}

/** The principals whose workspace this business belongs to — the recipients the
 *  Owner brief calls out by name ("Owner/Super Admin"). */
export async function workspacePrincipals(businessId: number): Promise<BellRecipient[]> {
  return (await workspaceAudience(businessId)).filter(isWorkspacePrincipal);
}

/** Narrow an audience to one role group (used by checklist/poultry producers). */
export function inGroup<T extends { role?: string | null }>(
  rows: T[],
  group: string,
  groupTest: (role: string, group: string) => boolean,
): T[] {
  return rows.filter((r) => groupTest(String(r.role || "").toUpperCase(), group));
}