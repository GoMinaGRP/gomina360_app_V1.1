/**
 * businessScope.ts — the single "whose data am I looking at, and which units?"
 * model shared by every screen that asks the user to pick an owner, a business
 * or a business type.
 *
 * WHY
 * ---
 * Every filter panel used to hand-roll its own business <select> with its own
 * default, its own label ("All businesses" / "All units" / "All my
 * businesses") and no owner dimension — so a Super Admin's default view fused
 * every owner's units, while a normal Owner never got a type filter. This
 * module is the ONE place that decides the default scope, groups units by
 * owner, derives the type list, and narrows by search — pure functions, so the
 * sidebar, the panels and the tests can all agree.
 *
 * MODEL
 * -----
 *   Owner  → "MY" (the caller's own workspace — the default) | "ALL" | an org id
 *   Unit   → one business id | "ALL"
 *   Type   → one business-type key | "ALL"
 *
 * DEFAULT RULE (see docs/BUSINESS-FILTERING-AUDIT.md §4.1)
 * --------------------------------------------------------
 *   - The caller's own workspace is the default for every role.
 *   - The Owner control is only offered when the caller may see more than one
 *     owner (Super Admin); for everyone else it is not rendered at all.
 *   - Narrowing is presentation only: the server's scope (accessible businesses,
 *     auditor grants, branch/module limits) always remains the authority, and a
 *     client-supplied owner/unit/type can only intersect with it.
 */

import { businessTypeKeyOf, businessTypeLabelOf } from "@/lib/businessTypeKeys";

/** The Main Owner's organization — the platform's "My Workspace". */
export const MAIN_ORG_ID = 1;

/**
 * The caller's own organization id — what "My Workspace" means to THEM.
 * A Super Admin always means org 1 (the Main Owner's workspace, the same
 * definition the Organization Lens and the sidebar use); everyone else means
 * their own organization, so an Org-2 owner's default view is their own units,
 * never an empty list.
 */
export function myOrgIdOf(user: any): number {
  if (!user) return MAIN_ORG_ID;
  if (user.isSuperAdmin) return MAIN_ORG_ID;
  const ids = Array.isArray(user.organizationIds) ? user.organizationIds.map(Number).filter(Number.isFinite) : [];
  if (ids.length > 0) return Math.min(...ids);
  const primary = Number(user.primaryOrgId);
  return Number.isFinite(primary) && primary > 0 ? primary : MAIN_ORG_ID;
}

export type OwnerScopeId = "MY" | "ALL" | number;

export type ScopeSelection = {
  /** Whose units are in view. "MY" = the caller's own workspace (default). */
  ownerId: OwnerScopeId;
  /** One unit, or "ALL" inside the chosen owner scope. */
  unitId: number | "ALL";
  /** One business type, or "ALL". */
  typeKey: string;
};

export const DEFAULT_SELECTION: ScopeSelection = { ownerId: "MY", unitId: "ALL", typeKey: "ALL" };

export type ScopeUnit = {
  id: number;
  name: string;
  code: string | null;
  typeKey: string;
  typeLabel: string;
  ownerId: number;
  ownerName: string;
  isMine: boolean;
  /** Free-text haystack (name + code + type + owner) for the search box. */
  haystack: string;
};

export type ScopeOwner = {
  id: number;
  name: string;
  units: number;
  isMine: boolean;
  /** Organization status when the directory carries one (ACTIVE/SUSPENDED…). */
  status?: string;
};

export type ScopeType = { key: string; label: string; count: number };

type OrgLite = { id: number; name?: string | null; status?: string | null };

/** Business type vocabulary — the same helpers the creation gate uses. */
export const typeKeyOf = (biz: { category?: string | null; subcategory?: string | null } | null | undefined): string =>
  businessTypeKeyOf((biz?.category || "Other") as string);
export const typeLabelOf = (biz: { category?: string | null } | null | undefined): string =>
  businessTypeLabelOf((biz?.category || "Other") as string);

/**
 * Build the owner-aware unit catalogue. `organizations` is the Super Admin's
 * org directory (empty for normal users — then every unit resolves to the
 * caller's own workspace, which is exactly right for them).
 */
export function scopeUnits(
  businesses: any[] | null | undefined,
  organizations: OrgLite[] | null | undefined = [],
  myOrgId: number = MAIN_ORG_ID,
): ScopeUnit[] {
  const rows = Array.isArray(businesses) ? businesses : [];
  const dir = new Map((organizations || []).map((o) => [Number(o.id), o]));
  const nameOf = (id: number) =>
    dir.get(id)?.name || (id === myOrgId ? "My Workspace" : `Owner #${id}`);
  return rows
    .filter((b) => b && b.id != null)
    .map((b) => {
      const ownerId = Number(b.ownerId ?? myOrgId);
      const typeKey = typeKeyOf(b);
      const typeLabel = typeLabelOf(b);
      const ownerName = nameOf(ownerId);
      const code = b.code ? String(b.code) : null;
      return {
        id: Number(b.id),
        name: String(b.name || `Unit #${b.id}`),
        code,
        typeKey,
        typeLabel,
        ownerId,
        ownerName,
        isMine: ownerId === myOrgId,
        haystack: `${b.name || ""} ${code || ""} ${typeLabel} ${ownerName} ${b.branchLocation || ""}`
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim(),
      } as ScopeUnit;
    })
    .sort((a, b) => (a.isMine !== b.isMine ? (a.isMine ? -1 : 1) : a.name.localeCompare(b.name) || a.id - b.id));
}

/** Owners present in a unit catalogue, own workspace first, then alphabetical. */
export function scopeOwners(units: ScopeUnit[], myOrgId: number = MAIN_ORG_ID): ScopeOwner[] {
  const byId = new Map<number, ScopeOwner>();
  for (const u of units) {
    const row = byId.get(u.ownerId) || {
      id: u.ownerId,
      name: u.isMine ? "My Workspace" : u.ownerName,
      units: 0,
      isMine: u.ownerId === myOrgId,
    };
    row.units += 1;
    byId.set(u.ownerId, row);
  }
  return [...byId.values()].sort((a, b) => (a.isMine !== b.isMine ? (a.isMine ? -1 : 1) : a.name.localeCompare(b.name)));
}

/**
 * Units after applying the owner + type part of a selection. The search box is
 * applied separately (it narrows the PICKER, not the caller's data scope).
 */
export function unitsInScope(units: ScopeUnit[], sel: Pick<ScopeSelection, "ownerId" | "typeKey">, myOrgId: number = MAIN_ORG_ID): ScopeUnit[] {
  let rows = units;
  if (sel.ownerId === "MY") rows = rows.filter((u) => u.ownerId === myOrgId);
  else if (sel.ownerId !== "ALL") rows = rows.filter((u) => u.ownerId === Number(sel.ownerId));
  if (sel.typeKey !== "ALL") rows = rows.filter((u) => u.typeKey === sel.typeKey);
  return rows;
}

/** Types present in the CURRENT owner scope (never a stale global list). */
export function typesInScope(units: ScopeUnit[], sel: Pick<ScopeSelection, "ownerId">, myOrgId: number = MAIN_ORG_ID): ScopeType[] {
  const rows = unitsInScope(units, { ownerId: sel.ownerId, typeKey: "ALL" }, myOrgId);
  const byKey = new Map<string, ScopeType>();
  for (const u of rows) {
    const row = byKey.get(u.typeKey) || { key: u.typeKey, label: u.typeLabel, count: 0 };
    row.count += 1;
    byKey.set(u.typeKey, row);
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Free-text match against a unit (name / code / type / owner / location). */
export function matchesUnit(unit: ScopeUnit, query: string): boolean {
  const q = (query || "").trim().toLowerCase();
  if (!q) return true;
  return q.split(/\s+/).every((term) => unit.haystack.includes(term));
}

/** The business ids a selection resolves to (what an API call can narrow by). */
export function businessIdsOf(units: ScopeUnit[]): number[] {
  return [...new Set(units.map((u) => u.id))].sort((a, b) => a - b);
}

/**
 * Keep a selection valid against the units a caller may actually see: a unit or
 * type that fell out of scope resets to "ALL" instead of silently filtering to
 * nothing (the "stale empty option" bug this model exists to prevent).
 */
export function normalizeSelection(
  sel: ScopeSelection,
  units: ScopeUnit[],
  myOrgId: number = MAIN_ORG_ID,
): ScopeSelection {
  const ownerId: OwnerScopeId =
    sel.ownerId === "MY" || sel.ownerId === "ALL" || units.some((u) => u.ownerId === Number(sel.ownerId))
      ? sel.ownerId
      : "MY";
  const inOwner = unitsInScope(units, { ownerId, typeKey: "ALL" }, myOrgId);
  const typeKey = sel.typeKey === "ALL" || inOwner.some((u) => u.typeKey === sel.typeKey) ? sel.typeKey : "ALL";
  const inType = unitsInScope(units, { ownerId, typeKey }, myOrgId);
  const unitId = sel.unitId === "ALL" || inType.some((u) => u.id === Number(sel.unitId)) ? sel.unitId : "ALL";
  return { ownerId, unitId, typeKey };
}

/** Human label for the active scope, e.g. "My Workspace · 4 units". */
export function scopeLabel(
  sel: ScopeSelection,
  units: ScopeUnit[],
  myOrgId: number = MAIN_ORG_ID,
): string {
  const inOwner = unitsInScope(units, { ownerId: sel.ownerId, typeKey: "ALL" }, myOrgId);
  const shown = unitsInScope(units, sel, myOrgId);
  const ownerName =
    sel.ownerId === "MY"
      ? "My Workspace"
      : sel.ownerId === "ALL"
        ? "All owners"
        : inOwner[0]?.ownerName || `Owner #${sel.ownerId}`;
  const unit = sel.unitId === "ALL" ? null : shown.find((u) => u.id === Number(sel.unitId))?.name || null;
  const type = sel.typeKey === "ALL" ? null : shown[0]?.typeLabel || null;
  const head = unit || (type ? `${type} units` : `${shown.length} unit${shown.length === 1 ? "" : "s"}`);
  return `${ownerName} · ${head}`;
}
