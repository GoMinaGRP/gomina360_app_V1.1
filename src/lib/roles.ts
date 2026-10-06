/**
 * THE SINGLE SOURCE OF TRUTH FOR ROLES AND CAPABILITIES.
 *
 * Before this file the role vocabulary was re-declared in 53 arrays, 244 literal
 * comparisons and 5 label maps across 89 files — which is why the two
 * user-creation screens drifted apart (Farm Advisor appeared in one, Accountant
 * and Supervisor only in the other) and why `POST /api/users` accepted any role
 * string at all.
 *
 * Rules for this file:
 *   • Pure and client-safe — NO database or server imports, so React components
 *     and API routes read the same definitions (same contract as permissions.ts).
 *   • Adding a role means editing ONE place. Everything else derives from here:
 *     pickers, labels, presets, rank, navigation category, validation.
 *   • Nothing in here grants access on its own: the server still enforces every
 *     gate. These are the *definitions* the gates are written against.
 *
 * See docs/ROLES-AND-PERMISSIONS-AUDIT.md §7.
 */

/* ─────────────────────────────── roles ─────────────────────────────────── */

export type RoleKey =
  | "OWNER"
  | "CO_OWNER"
  | "GENERAL_MANAGER"
  | "BRANCH_MANAGER"
  | "SUPERVISOR"
  | "ACCOUNTANT"
  | "WORKER"
  | "FARM_ADVISOR";

/**
 * Who the account is, organisationally. Navigation eligibility and the many
 * per-module role arrays are written against this instead of repeated role
 * literals, so a new role lands in exactly one category and inherits a
 * consistent workspace.
 */
export type RoleCategory =
  | "ORG_EXEC" /* commands the whole organisation */
  | "UNIT_LEAD" /* runs one business unit */
  | "UNIT_SPECIALIST" /* reviews/attends inside one unit */
  | "SHOP_FLOOR" /* operates a till inside one unit */
  | "EXTERNAL"; /* outside advisor, read-only, grant-based */

/** What the role's access is derived from (see auth.accessibleBusinessIds). */
export type ScopeKind =
  | "ORG" /* every unit of the organization(s) */
  | "ORG_OR_UNITS" /* org-wide, or pinned to units */
  | "UNIT" /* primary unit ∪ extra grants ∪ managed units */
  | "ADVISOR_GRANT"; /* only active advisor_assignments */

/** Who may mint this role. `NEVER` ⇒ the first OWNER comes from provisioning. */
export type AssignableBy = "NEVER" | "OWNER" | "OWNER_OR_DELEGATE";

/** Capability columns on `users` that a role preset / access console writes. */
export type CapabilityKey =
  | "canRecordSales"
  | "canRecordExpenses"
  | "canManageStock"
  | "canExportData"
  | "canManageRecords"
  | "canDeleteInventory"
  | "canManageExpenses"
  | "canManageCctv"
  | "canManageAuditors"
  | "canManageOnline"
  | "canCreateBusiness"
  | "canViewFinance"
  | "canManageSupport"
  | "canManageUsers";

export interface RoleDef {
  key: RoleKey;
  /** The ONE user-facing name for this role, everywhere in the app. */
  label: string;
  /** Short form for chips/badges where the full label is too long. */
  shortLabel: string;
  /** One line describing the role, shown next to the picker. */
  blurb: string;
  /** 4 = owner, 3 = org executive, 2 = unit lead/specialist, 1 = shop floor, 0 = external. */
  rank: 0 | 1 | 2 | 3 | 4;
  category: RoleCategory;
  scope: ScopeKind;
  /** The account cannot function without a primary unit (server returns 400 without). */
  requiresUnit: boolean;
  /** Farm Advisor accounts must NOT carry a primary unit (server returns 400 with one). */
  forbidsUnit?: boolean;
  assignableBy: AssignableBy;
  /** Grouping used by the role pickers (external advisors never look like staff). */
  section: "STAFF" | "EXTERNAL";
  /**
   * Capabilities switched ON when an account is created with this role (or moved
   * onto it). Everything not listed is OFF. The OWNER sees these applied in the
   * form and can override any single toggle before saving — the preset is a
   * starting point that makes the role name meaningful, never a hidden grant.
   */
  preset: Partial<Record<CapabilityKey, boolean>>;
}

export const ROLES: readonly RoleDef[] = [
  {
    key: "OWNER",
    label: "Owner",
    shortLabel: "Owner",
    blurb: "Full control of the organisation, its units and its accounts.",
    rank: 4,
    category: "ORG_EXEC",
    scope: "ORG",
    requiresUnit: false,
    assignableBy: "NEVER", // only organization provisioning creates the first OWNER
    section: "STAFF",
    preset: {},
  },
  {
    key: "CO_OWNER",
    label: "Co-Owner",
    shortLabel: "Co-Owner",
    blurb: "Org executive with owner-level operations; money and user management stay OWNER-granted.",
    rank: 3,
    category: "ORG_EXEC",
    scope: "ORG_OR_UNITS",
    requiresUnit: false,
    assignableBy: "OWNER",
    section: "STAFF",
    // Operational recording + the surfaces an org executive actually runs.
    // RULE: a preset never auto-grants a DESTRUCTIVE owner-only record power
    // (`canManageRecords`, `canDeleteInventory`, `canManageExpenses`,
    // `canManageUsers`, `canManageCctv`) — those stay explicit OWNER grants the
    // OWNER sees as toggles in the shared editor. The approved executive
    // surfaces (storefront, units, support info, auditor delegation, Finance)
    // remain part of the preset; `canRecordExpenses` is included so the
    // executive bench can actually record the day-to-day money it oversees.
    // NOTE: Finance & Reports is deliberately NOT in this preset. The standing
    // rule (src/lib/permissions.ts) is that role alone never opens the money
    // surfaces — even a General Manager is authorised explicitly by the OWNER,
    // who sees the Finance toggle in the shared editor on the same screen.
    preset: {
      canRecordExpenses: true,
      canExportData: true,
      canManageOnline: true,
      canCreateBusiness: true,
      canManageSupport: true,
      canManageAuditors: true,
    },
  },
  {
    key: "GENERAL_MANAGER",
    label: "General Manager",
    shortLabel: "General Manager",
    blurb: "Runs day-to-day operations across units; approvals, budgets and staffing.",
    rank: 3,
    category: "ORG_EXEC",
    scope: "ORG_OR_UNITS",
    requiresUnit: false,
    assignableBy: "OWNER",
    section: "STAFF",
    // Operational recording + the surfaces an org executive actually runs.
    // RULE: a preset never auto-grants a DESTRUCTIVE owner-only record power
    // (`canManageRecords`, `canDeleteInventory`, `canManageExpenses`,
    // `canManageUsers`, `canManageCctv`) — those stay explicit OWNER grants the
    // OWNER sees as toggles in the shared editor. The approved executive
    // surfaces (storefront, units, support info, auditor delegation, Finance)
    // remain part of the preset; `canRecordExpenses` is included so the
    // executive bench can actually record the day-to-day money it oversees.
    // NOTE: Finance & Reports is deliberately NOT in this preset. The standing
    // rule (src/lib/permissions.ts) is that role alone never opens the money
    // surfaces — even a General Manager is authorised explicitly by the OWNER,
    // who sees the Finance toggle in the shared editor on the same screen.
    preset: {
      canRecordExpenses: true,
      canExportData: true,
      canManageOnline: true,
      canCreateBusiness: true,
      canManageSupport: true,
      canManageAuditors: true,
    },
  },
  {
    key: "BRANCH_MANAGER",
    label: "Branch Manager",
    shortLabel: "Branch Manager",
    blurb: "Runs one business unit: its sales, stock, assets and staff.",
    rank: 2,
    category: "UNIT_LEAD",
    scope: "UNIT",
    requiresUnit: true,
    assignableBy: "OWNER_OR_DELEGATE",
    section: "STAFF",
    preset: {
      canRecordExpenses: true,
      canExportData: true,
      canManageStock: true,
    },
  },
  {
    key: "SUPERVISOR",
    label: "Supervisor",
    shortLabel: "Supervisor",
    blurb: "Oversees work inside one unit and reviews attendance; no money surfaces.",
    rank: 2,
    category: "UNIT_SPECIALIST",
    scope: "UNIT",
    requiresUnit: true,
    assignableBy: "OWNER",
    section: "STAFF",
    preset: {
      canRecordExpenses: true,
      canManageStock: true,
    },
  },
  {
    key: "ACCOUNTANT",
    label: "Accountant",
    shortLabel: "Accountant",
    blurb: "Keeps the unit's books: expenses and the Finance & Reports surface, scoped to their units.",
    rank: 2,
    category: "UNIT_SPECIALIST",
    scope: "UNIT",
    requiresUnit: true,
    assignableBy: "OWNER",
    section: "STAFF",
    preset: {
      canRecordExpenses: true,
      canExportData: true,
      canViewFinance: true, // D3 — OWNER-revocable
    },
  },
  {
    key: "WORKER",
    label: "Worker (Sales Person)",
    shortLabel: "Worker",
    blurb: "Records sales and serves customers inside one unit.",
    rank: 1,
    category: "SHOP_FLOOR",
    scope: "UNIT",
    requiresUnit: true,
    assignableBy: "OWNER_OR_DELEGATE",
    section: "STAFF",
    preset: {
      canRecordSales: true,
    },
  },
  {
    key: "FARM_ADVISOR",
    label: "Farm Advisor (external, read-only)",
    shortLabel: "Farm Advisor",
    blurb: "Outside advisor: read-only, no unit assignment — access comes from expiring farm-unit grants.",
    rank: 0,
    category: "EXTERNAL",
    scope: "ADVISOR_GRANT",
    requiresUnit: false,
    forbidsUnit: true,
    assignableBy: "OWNER",
    section: "EXTERNAL",
    preset: {}, // the API forces every capability off for advisors
  },
] as const;

const BY_KEY: Record<string, RoleDef> = Object.fromEntries(ROLES.map((r) => [r.key, r]));

/* ─────────────────────────── role helpers ──────────────────────────────── */

/** Type guard used by every create/edit endpoint (closes the "BANANA" hole). */
export function isRoleKey(value: unknown): value is RoleKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BY_KEY, value);
}

/** Normalise a stored role: trims and upper-cases, then validates. */
export function normaliseRole(value: unknown): RoleKey | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toUpperCase();
  return isRoleKey(key) ? key : null;
}

export function roleDef(role: unknown): RoleDef | null {
  const key = normaliseRole(role);
  return key ? BY_KEY[key] : null;
}

/** The ONE label for a role. Falls back to the raw string only for legacy rows. */
export function roleLabel(role: unknown): string {
  return roleDef(role)?.label ?? String(role ?? "Unknown");
}

export function roleShortLabel(role: unknown): string {
  return roleDef(role)?.shortLabel ?? String(role ?? "Unknown");
}

export function roleRank(role: unknown): number {
  return roleDef(role)?.rank ?? -1; // unknown roles rank below everyone
}

export function roleCategory(role: unknown): RoleCategory | null {
  return roleDef(role)?.category ?? null;
}

export function isExternalRole(role: unknown): boolean {
  return roleCategory(role) === "EXTERNAL";
}

/** True for the roles that command the whole organisation. */
export function isOrgexecRole(role: unknown): boolean {
  return roleCategory(role) === "ORG_EXEC";
}

/**
 * Rank enforcement: may `actor` administer (edit / deactivate / reset / re-role)
 * `target`? Equal rank is allowed so an OWNER can manage a peer OWNER and a GM
 * can manage a GM, but nobody may touch a higher rank. Unknown (legacy) roles
 * rank -1, so they can be managed but can never manage anybody.
 *
 * This is a *ranking* rule only — the per-surface guards (OWNER-only grants,
 * tenant isolation via canAdministerUser) still apply on top.
 */
export function canActOnRole(actorRole: unknown, targetRole: unknown): boolean {
  return roleRank(actorRole) >= roleRank(targetRole);
}

/* ───────────────────── assignability (creation surfaces) ───────────────── */

export function canAssignRole(actor: any, role: unknown): boolean {
  const key = normaliseRole(role);
  if (!key) return false;
  const def = BY_KEY[key];
  const isOwner = String(actor?.role || "").toUpperCase() === "OWNER";
  switch (def.assignableBy) {
    case "NEVER":
      return false;
    case "OWNER":
      return isOwner;
    case "OWNER_OR_DELEGATE":
      return isOwner || isDelegateUserManager(actor);
    default:
      return false;
  }
}

/** An OWNER-authorised, non-owner user administrator (users.canManageUsers). */
export function isDelegateUserManager(actor: any): boolean {
  if (!actor) return false;
  const role = String(actor.role || "").toUpperCase();
  if (role === "OWNER") return false;
  if (!actor.canManageUsers) return false;
  // Members of the DELEGATE_ELIGIBLE group — defined once, right here.
  return (ROLE_GROUPS.DELEGATE_ELIGIBLE as readonly string[]).includes(role);
}

/**
 * The roles a given actor may pick on ANY creation surface. One answer for
 * Users & Access, Enterprise Users and the worker panel.
 */
export function roleOptionsFor(actor: any): RoleDef[] {
  return ROLES.filter((r) => r.assignableBy !== "NEVER" && canAssignRole(actor, r.key));
}

/* ───────────────────────── capability metadata ─────────────────────────── */

export interface CapabilityDef {
  key: CapabilityKey;
  label: string;
  hint?: string;
  /** Stable DOM test id — kept here so every surface emits the SAME hook and
   *  existing regression suites keep working after the editor was unified. */
  testid: string;
  /** Only the OWNER may grant/revoke (server enforces this too). */
  ownerOnly: boolean;
  /** Renders as a locked surface (money / staff directory). */
  sensitive?: boolean;
  /** Roles the capability is meaningful for; undefined ⇒ any role. */
  roles?: RoleKey[];
}

/** Order here is the order the access console and both pickers render. */
export const CAPABILITIES: readonly CapabilityDef[] = [
  {
    key: "canRecordSales",
    testid: "perm-sales",
    label: "Record sales",
    hint: "Create sales records for their unit.",
    ownerOnly: false,
  },
  {
    key: "canRecordExpenses",
    testid: "perm-expenses",
    label: "Record expenses",
    hint: "Record an expense against a sale or purchase.",
    ownerOnly: false,
  },
  {
    key: "canManageStock",
    testid: "perm-stock",
    label: "Manage stock",
    hint: "Adjust stock levels and variants.",
    ownerOnly: false,
  },
  {
    key: "canExportData",
    testid: "perm-export",
    label: "Export data",
    hint: "Download reports; without it an export becomes a pending request.",
    ownerOnly: false,
  },
  {
    key: "canManageRecords",
    testid: "perm-records",
    label: "Manage & delete shared records",
    hint: "Destructive: edit and delete records they did not create.",
    ownerOnly: true,
  },
  {
    key: "canDeleteInventory",
    testid: "perm-inventory",
    label: "Manage, edit & delete inventory entries",
    hint: "Destructive: remove inventory items.",
    ownerOnly: true,
  },
  {
    key: "canManageExpenses",
    testid: "perm-expense-manage",
    label: "Manage, edit & delete expenses",
    hint: "Correct and remove expense records.",
    ownerOnly: true,
  },
  {
    key: "canManageCctv",
    testid: "perm-cctv",
    label: "Manage CCTV cameras",
    hint: "Opens the Integrations Hub, scoped to their units.",
    ownerOnly: true,
  },
  {
    key: "canManageOnline",
    testid: "perm-online",
    label: "Online storefront & delivery areas",
    hint: "Switches, service areas, pickup points, help & MoMo.",
    ownerOnly: true,
  },
  {
    key: "canCreateBusiness",
    testid: "perm-create-business",
    label: "New Branch/Unit (create business units)",
    hint: "Add units to the organisation.",
    ownerOnly: true,
  },
  {
    key: "canViewFinance",
    testid: "perm-finance",
    label: "Finance & Reports — Central Financial Report",
    hint: "Revenue, profit, cash flow, ROI, budgets, forecasts & payroll, scoped to their units.",
    ownerOnly: true,
    sensitive: true,
  },
  {
    key: "canManageSupport",
    testid: "perm-support-info",
    label: "Customer Support — storefront HELP",
    hint: "Add/edit the support contact, hours & location.",
    ownerOnly: true,
  },
  {
    key: "canManageAuditors",
    testid: "perm-auditors",
    label: "Manage auditor access (Audit & Review)",
    hint: "Grant and revoke Audit & Review assignments inside their units.",
    ownerOnly: true,
    roles: ["CO_OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"],
  },
  {
    key: "canManageUsers",
    testid: "perm-delegate",
    label: "Enterprise Users — staff directory & access console",
    hint: "Destructive: open the staff directory and create accounts, scoped to their units.",
    ownerOnly: true,
    sensitive: true,
    roles: ["CO_OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"],
  },
] as const;

const CAP_BY_KEY: Record<string, CapabilityDef> = Object.fromEntries(CAPABILITIES.map((c) => [c.key, c]));

/** Capabilities that make sense for a role (filters the two delegate flags). */
export function capabilitiesForRole(role: unknown): CapabilityDef[] {
  const key = normaliseRole(role);
  if (!key) return [...CAPABILITIES];
  return CAPABILITIES.filter((c) => !c.roles || c.roles.includes(key));
}

/**
 * The capability values a role starts with. Every capability is present (false
 * unless the preset turns it on) so callers can spread this straight into state
 * or an API payload.
 */
export function rolePreset(role: unknown): Record<CapabilityKey, boolean> {
  const def = roleDef(role);
  const out = {} as Record<CapabilityKey, boolean>;
  for (const c of CAPABILITIES) out[c.key] = def?.preset?.[c.key] === true;
  // Farm Advisors can never hold a management capability (mirrors the API).
  if (def?.key === "FARM_ADVISOR") for (const c of CAPABILITIES) out[c.key] = false;
  return out;
}

/** True when the capability differs from the role's preset (for the "modified" hint). */
export function isPresetModified(role: unknown, values: Partial<Record<CapabilityKey, boolean>>): boolean {
  const preset = rolePreset(role);
  return CAPABILITIES.some((c) => (values[c.key] === true) !== (preset[c.key] === true));
}

/* ──────────────────── named role groups (replace literals) ─────────────── */

/**
 * The named sets the rest of the app used to re-declare as inline arrays —
 * including the phantom strings `MANAGER`, `ADMIN` and `SUPER_ADMIN`, none of
 * which any account can hold.
 */
export const ROLE_GROUPS = {
  /** Org executives: command the organisation operatively. */
  EXECUTIVE: ["OWNER", "CO_OWNER", "GENERAL_MANAGER"],
  /** May hold / receive money & performance notifications. */
  MONEY_WATCHER: ["OWNER", "CO_OWNER", "GENERAL_MANAGER"],
  /** Lead work inside units (notifications about unit activity). */
  UNIT_LEAD: ["BRANCH_MANAGER", "SUPERVISOR", "GENERAL_MANAGER"],
  /**
   * Operational managers of the organisation and its units: they manage unit
   * records, notes, documents and daily operations (not money, not staff).
   */
  UNIT_ADMIN: ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"],
  /** Run checklist generation & compliance surfaces (an alias of UNIT_ADMIN —
   *  same members, so the two can never drift). */
  CHECKLIST_MANAGER: ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"],
  /** Approve budget/policy exceptions. */
  POLICY: ["OWNER", "GENERAL_MANAGER"],
  /** Review attendance (approve/reject). The OWNER and a Co-Owner are the top
   *  authority of the organisation and were previously special-cased by a
   *  literal `role === "OWNER"` in the attendance route — the group now says it
   *  once. */
  ATTENDANCE_REVIEW: ["OWNER", "CO_OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER", "SUPERVISOR", "ACCOUNTANT"],
  /** Clock in / clock out. */
  CLOCK_IN: ["WORKER", "BRANCH_MANAGER", "SUPERVISOR", "ACCOUNTANT"],
  /** May carry the OWNER-delegated user-administration flag. */
  DELEGATE_ELIGIBLE: ["CO_OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"],
} as const satisfies Record<string, readonly RoleKey[]>;

export type RoleGroupKey = keyof typeof ROLE_GROUPS;

/** Group members as a plain string list — what `.includes(role)` callers want. */
export function roleGroupMembers(group: RoleGroupKey): readonly string[] {
  return ROLE_GROUPS[group];
}

/** Membership test with normalisation — `inRoleGroup("MANAGER")` is simply false. */
export function inRoleGroup(group: RoleGroupKey, role: unknown): boolean {
  const key = normaliseRole(role);
  if (!key) return false;
  return (ROLE_GROUPS[group] as readonly string[]).includes(key);
}
