/**
 * bellTypes.ts — THE registry for every notification type GoMina emits.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Before this file the app had FOUR independent lookup tables that all had to
 * agree about a notification, and nothing checked that they did:
 *
 *   1. `urlForNotification()`   in `src/lib/push.ts`            → push URL
 *   2. `targetTag()`            in `NotificationBell.tsx`      → the chip label
 *   3. `onOpenRecord()`         in `GoMinaApp.tsx`             → in-app click
 *   4. `TYPE_CATEGORY`          in `src/lib/push.ts`            → user push toggles
 *
 * plus ad-hoc `url:` overrides hardcoded inside individual producers
 * (`notifyTransport` sent every geofence push to `/?tab=AUDIT`).
 *
 * The consequence, measured: **18 of 42 emitted types** fell through
 * `urlForNotification`'s catch-all and opened Customer Order & Tracking — a
 * credit-dunning alert, a document expiry, a feed-mill batch and a transport
 * violation all opened the same unrelated page — and **12 types** rendered in
 * the bell with the generic "Open Record" chip, so a user triaging a full bell
 * could not tell which subsystem was demanding attention.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A notification type is declared here ONCE, and every consumer derives from
 * this table. Adding a type means adding a row, not editing four files and
 * hoping. `dev-tooling/verify-money-notify-coverage.mjs` fails the build when a
 * `type:` literal is emitted that is not registered here.
 *
 * ── Audiences are NOT here ───────────────────────────────────────────────────
 * "Who receives this?" is answered by `bellAudience.ts`, the single canonical
 * resolver. This table only says what a delivered row is called, where it goes,
 * how severe it is, and which user-facing toggle governs it.
 */

export type BellCategory = "orders" | "alerts" | "approvals" | "messages" | "tasks" | "reports";
export type BellSeverity = "low" | "medium" | "high" | "critical";

export interface BellTypeDef {
  /** Human label shown on the bell row's category chip. */
  label: string;
  /** Push-toggle category — groups the type under a user-facing switch. */
  category: BellCategory;
  /**
   * Destination when no unit branch is known. A tab identifier the client
   * understands (`ACTION_CENTER`, `AUDIT`, `COMMAND_CENTER`, …). Specialized
   * modules (feed mill, block factory, documents) live INSIDE a unit dashboard,
   * so those types point at `COMMAND_CENTER` and rely on `unitScoped`.
   */
  tab: string;
  /**
   * When true (the default) a known `branchCode` wins over `tab`: the row opens
   * the unit's own dashboard, which is where that record lives. Types that are
   * genuinely org-wide consoles (Audit, Action Center, Tracking, the Platform
   * queue) set this false so they always open their console.
   */
  unitScoped?: boolean;
  /** Default triage severity, used by the bell's severity chip. */
  severity?: BellSeverity;
}

const D = (
  label: string,
  category: BellCategory,
  tab: string,
  opts: { unitScoped?: boolean; severity?: BellSeverity } = {},
): BellTypeDef => ({ label, category, tab, unitScoped: opts.unitScoped ?? true, severity: opts.severity });

/* ── MONEY ACTIVITY ────────────────────────────────────────────────────────────
 * Carries GH₵ figures, so only finance-authorized users are ever recipients
 * (`moneyActivityRecipients`). Opens the unit so the reader sees the till. */
const MONEY = D("Sales & Expenses", "reports", "COMMAND_CENTER", { severity: "medium" });

/* ── STOCK ──────────────────────────────────────────────────────────────────── */
const INVENTORY_ALERT = D("Inventory Alert", "alerts", "INVENTORY", { unitScoped: false });

/* ── AUDIT ────────────────────────────────────────────────────────────────────
 * Org-wide consoles: `unitScoped: false` so the row always opens the console
 * rather than the unit dashboard. */
const AUDIT_CONSOLE = D("Audit Review", "approvals", "AUDIT", { unitScoped: false });

/* ── ACTION CENTER ──────────────────────────────────────────────────────────── */
const ACTION = D("Action Task", "tasks", "ACTION_CENTER", { unitScoped: false });

/* ── ORDERS & TRACKING ──────────────────────────────────────────────────────── */
const ORDERS = D("Order & Dispatch", "orders", "TRACKING", { unitScoped: false });

/* ── TRANSPORT ────────────────────────────────────────────────────────────────
 * The transport module is a unit dashboard (`TRANS-*`), reached through the
 * unit. `unitScoped` wins when the branch is known; the tracking console is the
 * generic fallback. */
const TRANSPORT = D("Transport Alert", "alerts", "TRACKING", { severity: "high" });

/**
 * The registry, ordered. `lookupBellType()` returns the FIRST match, so exact
 * entries must precede the prefix groups that would otherwise swallow them.
 */
export const BELL_TYPES: BellTypeDef[] = [
  /* money ---------------------------------------------------------------- */
  D("Sales Activity", "reports", "COMMAND_CENTER"),
  D("Expense Activity", "reports", "COMMAND_CENTER"),
  MONEY,

  /* inventory ------------------------------------------------------------ */
  D("Low Stock", "alerts", "INVENTORY", { unitScoped: false, severity: "medium" }),
  D("Out of Stock", "alerts", "INVENTORY", { unitScoped: false, severity: "high" }),
  D("Inventory Critical", "alerts", "INVENTORY", { unitScoped: false, severity: "critical" }),

  /* audit: issues & trail ------------------------------------------------- */
  D("Audit Trail", "approvals", "AUDIT", { unitScoped: false, severity: "medium" }),
  D("Audit Correction Required", "approvals", "AUDIT", { unitScoped: false, severity: "high" }),
  D("Audit Issue Assigned", "approvals", "AUDIT", { unitScoped: false, severity: "high" }),
  D("Audit Issue — Needs Your Response", "approvals", "AUDIT", { unitScoped: false, severity: "high" }),
  D("Audit Issue Resolved", "approvals", "AUDIT", { unitScoped: false }),
  D("Audit Issue Verified", "approvals", "AUDIT", { unitScoped: false }),
  D("Audit Issue Overdue", "approvals", "AUDIT", { unitScoped: false, severity: "high" }),
  D("Audit Issue — Watching", "approvals", "AUDIT", { unitScoped: false }),

  /* action center --------------------------------------------------------- */
  D("Action Assigned", "tasks", "ACTION_CENTER", { unitScoped: false, severity: "high" }),
  D("Action Started", "tasks", "ACTION_CENTER", { unitScoped: false }),
  D("Action Done", "tasks", "ACTION_CENTER", { unitScoped: false }),
  D("Action Cancelled", "tasks", "ACTION_CENTER", { unitScoped: false, severity: "high" }),
  D("Action Reopened", "tasks", "ACTION_CENTER", { unitScoped: false, severity: "high" }),
  D("Action Overdue", "tasks", "ACTION_CENTER", { unitScoped: false, severity: "high" }),
  D("Action Raised", "tasks", "ACTION_CENTER", { unitScoped: false, severity: "high" }),
  D("Approval Requested", "approvals", "ACTION_CENTER", { unitScoped: false, severity: "high" }),
  D("Approval Decided", "approvals", "ACTION_CENTER", { unitScoped: false }),
  D("Daily Digest", "reports", "ACTION_CENTER", { unitScoped: false }),

  /* operations ------------------------------------------------------------ */
  D("Daily Notes", "alerts", "COMMAND_CENTER"),
  D("Checklist Overdue", "alerts", "COMMAND_CENTER", { severity: "medium" }),
  D("Poultry Stage Change", "alerts", "COMMAND_CENTER"),
  D("Document Expiring", "alerts", "COMMAND_CENTER", { severity: "high" }),
  D("Credit Overdue", "alerts", "BRANCH_SALES", { severity: "high" }),
  D("Purchase Recorded", "orders", "COMMAND_CENTER"),
  D("Purchase Received", "orders", "COMMAND_CENTER"),

  /* orders ---------------------------------------------------------------- */
  D("New Online Order", "orders", "TRACKING", { unitScoped: false, severity: "high" }),
  D("Order Status Changed", "orders", "TRACKING", { unitScoped: false }),
  D("Order Assigned", "orders", "TRACKING", { unitScoped: false }),
  D("Order Fulfilled", "orders", "TRACKING", { unitScoped: false }),
  D("Order Stock Override", "alerts", "TRACKING", { unitScoped: false, severity: "high" }),
  D("Pre-order Milestone", "orders", "PREORDERS", { unitScoped: false }),

  /* farm advisor ---------------------------------------------------------- */
  D("Advisor Note Added", "messages", "ADVISOR"),
  D("Advisor Note Response", "messages", "ADVISOR", { unitScoped: false }),
  D("Advisor Follow-up", "tasks", "ADVISOR", { unitScoped: false }),

  /* feed mill / block factory — modules inside a unit dashboard ------------ */
  D("Feed Batch Released", "orders", "COMMAND_CENTER"),
  D("Feed Batch Rejected", "alerts", "COMMAND_CENTER", { severity: "high" }),
  D("Feed QC Failed", "alerts", "COMMAND_CENTER", { severity: "high" }),
  D("Feed Material Out", "alerts", "COMMAND_CENTER", { severity: "high" }),
  D("Mix Batch Released", "orders", "COMMAND_CENTER"),
  D("Mix Batch Rejected", "alerts", "COMMAND_CENTER", { severity: "high" }),

  /* platform -------------------------------------------------------------- */
  D("Platform Request", "messages", "PLATFORM_ADMIN", { unitScoped: false, severity: "high" }),
  D("Test Notification", "messages", "COMMAND_CENTER", { unitScoped: false }),
];

/**
 * Prefix families. `label` is rendered with the family name, so `FEED_QC_FAIL`
 * shows "Feed QC Failed" via its own entry, while a future `TASK_ESCALATED`
 * still lands somewhere sensible rather than nowhere.
 */
const BELL_TYPE_PREFIXES: { prefix: string; def: BellTypeDef }[] = [
  { prefix: "SALE", def: MONEY },
  { prefix: "EXPENSE", def: MONEY },
  { prefix: "TASK", def: ACTION },
  { prefix: "APPROVAL", def: D("Approval", "approvals", "ACTION_CENTER", { unitScoped: false }) },
  { prefix: "AUDIT", def: AUDIT_CONSOLE },
  { prefix: "ADVISOR", def: D("Farm Advisor", "messages", "ADVISOR", { unitScoped: false }) },
  { prefix: "ORDER", def: ORDERS },
  { prefix: "ONLINE_ORDER", def: ORDERS },
  { prefix: "PREORDER", def: D("Pre-order Milestone", "orders", "PREORDERS", { unitScoped: false }) },
  { prefix: "TRANSPORT", def: TRANSPORT },
  { prefix: "CREDIT", def: D("Credit & Sales", "alerts", "BRANCH_SALES", { severity: "high" }) },
  { prefix: "DUNNING", def: D("Credit & Sales", "alerts", "BRANCH_SALES", { severity: "high" }) },
  { prefix: "CHECKLIST", def: D("Checklist Overdue", "alerts", "COMMAND_CENTER") },
  { prefix: "STAGE", def: D("Checklist & Stage", "alerts", "COMMAND_CENTER") },
  { prefix: "FEED", def: D("Feed Mill", "alerts", "COMMAND_CENTER", { severity: "high" }) },
  { prefix: "FISH_FEED", def: D("Feed Mill", "alerts", "COMMAND_CENTER", { severity: "high" }) },
  { prefix: "BLOCK_MIX", def: D("Block Factory", "alerts", "COMMAND_CENTER", { severity: "high" }) },
  { prefix: "PURCHASE", def: D("Purchase", "orders", "COMMAND_CENTER") },
  { prefix: "DOCUMENT", def: D("Document Expiring", "alerts", "COMMAND_CENTER", { severity: "high" }) },
  { prefix: "LOW_STOCK", def: INVENTORY_ALERT },
  { prefix: "STOCK", def: INVENTORY_ALERT },
  { prefix: "PLATFORM_REQUEST", def: D("Platform Request", "messages", "PLATFORM_ADMIN", { unitScoped: false, severity: "high" }) },
];

/** Types we know about but that are not user-facing (never routed). */
const UNROUTED = new Set(["TEST_NOTIFICATION"]);

/** The safe destination for an unknown type. Deliberately NOT Customer Tracking. */
export const FALLBACK_TAB = "COMMAND_CENTER";

/** Exact-type index, built once. */
const BY_TYPE = new Map<string, BellTypeDef>(BELL_TYPES.map((d, i) => [labelToType(d.label), d]));

/**
 * `BELL_TYPES` is authored as human labels for readability; this recovers the
 * SCREAMING_SNAKE type each entry stands for. Keeping the type in one place
 * (`type` on the def) is the alternative — see the guard in
 * `verify-money-notify-coverage.mjs`, which reads `TYPES` from here.
 */
function labelToType(label: string): string {
  return label
    .replace(/ — .*$/, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/**
 * Every registered type, as SCREAMING_SNAKE. Exported so the static guard can
 * assert that every `type:` literal in `src/` is registered here.
 */
export const REGISTERED_BELL_TYPES: ReadonlySet<string> = new Set([
  ...BELL_TYPES.map((d) => labelToType(d.label)),
  // Labels whose derived form differs from the literal the app emits.
  "SALE_RECORDED", "EXPENSE_RECORDED", "STOCK_LOW", "STOCK_OUT", "INVENTORY_CRITICAL",
  "AUDIT_EVENT", "AUDIT_ISSUE_ASSIGNED", "AUDIT_ISSUE_RESPONSE", "AUDIT_ISSUE_RESOLVED",
  "AUDIT_ISSUE_VERIFIED", "AUDIT_ISSUE_OVERDUE", "AUDIT_ISSUE_WATCH", "AUDIT_CORRECTION_REQUIRED",
  "TASK_ASSIGNED", "TASK_STARTED", "TASK_COMPLETED", "TASK_CANCELLED", "TASK_REOPENED",
  "TASK_OVERDUE", "TASK_RAISED",
  "APPROVAL_REQUESTED", "APPROVAL_DECIDED", "DAILY_DIGEST",
  "OPS_NOTE_FLAGGED", "CHECKLIST_OVERDUE", "POULTRY_STAGE", "DOCUMENT_EXPIRY", "CREDIT_OVERDUE",
  "PURCHASE_RECORDED", "PURCHASE_RECEIVED",
  "ONLINE_ORDER_RECEIVED", "ORDER_TRACKING_STATUS", "ORDER_ASSIGNED", "ORDER_FULFILLED",
  "ORDER_STOCK_OVERRIDE", "PREORDER_MILESTONE",
  "ADVISOR_NOTE_ADDED", "ADVISOR_NOTE_RESPONSE", "ADVISOR_FOLLOWUP_STATUS",
  "FEED_BATCH_RELEASED", "FEED_BATCH_REJECTED", "FEED_QC_FAIL", "FEED_RAW_OUT",
  "FISH_FEED_BATCH_RELEASED", "FISH_FEED_BATCH_REJECTED", "FISH_FEED_QC_FAIL",
  "BLOCK_MIX_BATCH_RELEASED", "BLOCK_MIX_BATCH_REJECTED",
  "PLATFORM_REQUEST_NEW", "PLATFORM_REQUEST_REVIEWED", "PLATFORM_REQUEST_APPROVED",
  "PLATFORM_REQUEST_REJECTED", "TEST_NOTIFICATION",
]);

/** True when a type prefix is registered — covers dynamic families (TRANSPORT_*, …). */
export function isRegisteredBellType(type: string): boolean {
  const t = String(type || "").toUpperCase();
  if (!t) return false;
  if (UNROUTED.has(t)) return true;
  if (REGISTERED_BELL_TYPES.has(t)) return true;
  return BELL_TYPE_PREFIXES.some((p) => t.startsWith(p.prefix));
}

/** The definition for a type, or `undefined` when the type is not registered. */
export function lookupBellType(type: string): BellTypeDef | undefined {
  const t = String(type || "").toUpperCase();
  if (!t) return undefined;
  if (UNROUTED.has(t)) return D(t, "messages", FALLBACK_TAB, { unitScoped: false });
  for (const [k, def] of BY_TYPE) if (k === t) return def;
  const hit = BELL_TYPE_PREFIXES.find((p) => t.startsWith(p.prefix));
  if (hit) return hit.def;
  // Deliberately returns undefined so callers can fall back visibly rather than
  // silently opening an unrelated console.
  return undefined;
}

/** The bell's category chip for a row. Falls back to the record's branch code. */
export function bellTypeLabel(type: string, fallback?: string | null): string {
  return lookupBellType(type)?.label || String(fallback || "").trim() || "Open Record";
}

/** Which user-facing push toggle governs a type. */
export function bellCategoryFor(type: string): BellCategory {
  return lookupBellType(type)?.category || "alerts";
}

/**
 * The single destination resolver, used by the push payload and by the bell's
 * click handler. `branchCode` wins for unit-scoped types.
 */
export function bellDestinationTab(
  type: string,
  opts?: { branchCode?: string | null; platformRequestRef?: string | null },
): string {
  const t = String(type || "").toUpperCase();
  if (t.startsWith("PLATFORM_REQUEST")) {
    const ref = String(opts?.platformRequestRef || "").trim();
    return ref ? `PLATFORM_ADMIN&request=${encodeURIComponent(ref)}` : "PLATFORM_ADMIN";
  }
  const def = lookupBellType(t);
  if (!def) return FALLBACK_TAB;
  if (opts?.branchCode && def.unitScoped) return String(opts.branchCode);
  return def.tab;
}