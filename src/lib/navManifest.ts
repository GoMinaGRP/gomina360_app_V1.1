/**
 * NAV MANIFEST — the single source of truth for the left navigation.
 *
 * Why this file exists (sidebar audit, docs/SIDEBAR-NAV-AUDIT.md): eligibility,
 * label, group, icon and order used to be re-derived inline in BOTH
 * Sidebar.tsx and ContextNavigator.tsx. The two copies had already drifted —
 * two destinations rendered twice for the same role, one destination had three
 * different names, and the right rail was missing seven destinations entirely.
 * Everything now reads from here, so a destination physically cannot render
 * twice, cannot be named differently in two places, and cannot be missing from
 * the "you are here" rail.
 *
 * Adding a destination = one entry below. No other file needs to know about it.
 */

import {
  LayoutDashboard,
  ListTodo,
  Stethoscope,
  ShoppingCart,
  Truck,
  CalendarClock,
  Package,
  Users,
  UserCheck,
  Wrench,
  CreditCard,
  Landmark,
  BrainCircuit,
  Sparkles,
  Sliders,
  ShieldCheck,
  FolderLock,
  Share2,
  Settings2,
  LifeBuoy,
  Building2,
  Globe,
  Egg,
  Boxes,
  Fish,
  Beef,
  Utensils,
  Cpu,
  Droplets,
  HardHat,
  Wifi,
  Shirt,
} from "lucide-react";

/* ───────────────────────── groups ───────────────────────── */

export type NavGroupKey =
  | "PINNED"
  | "MY_BUSINESSES"
  | "SELL"
  | "MONEY"
  | "RECORDS"
  | "BRANCH"
  | "INSIGHTS"
  | "GOVERNANCE"
  | "SETTINGS"
  | "WORKSPACE";

export interface NavGroup {
  key: NavGroupKey;
  /** Left-rail heading. Empty ⇒ the group renders with no heading (pinned rows). */
  label: string;
  /** Right-rail "Section" value — keeps the breadcrumb wording the user sees. */
  rail: string;
  /** Short blurb for the command palette. */
  hint?: string;
  /** Governance rule from the audit: a section may not exceed this many rows. */
  cap?: number;
}

export const NAV_GROUPS: NavGroup[] = [
  { key: "PINNED", label: "", rail: "Workspace" },
  { key: "MY_BUSINESSES", label: "My Businesses", rail: "Ghana Businesses" },
  {
    key: "SELL",
    label: "Sell & Fulfil",
    rail: "Shared Enterprise Modules",
    hint: "Sales, orders, pre-orders, customers",
    cap: 6,
  },
  { key: "MONEY", label: "Money", rail: "Shared Enterprise Modules", hint: "Finance, reports, ledger", cap: 6 },
  {
    key: "RECORDS",
    label: "Records",
    rail: "Shared Enterprise Modules",
    hint: "Inventory, suppliers, people, assets",
    cap: 6,
  },
  { key: "BRANCH", label: "Branch Management", rail: "Branch Workspace", cap: 6 },
  {
    key: "INSIGHTS",
    label: "Insights & Decisions",
    rail: "Decision Support & Hub",
    hint: "BI, strategy, scenario planning",
    cap: 6,
  },
  {
    key: "GOVERNANCE",
    label: "Governance & Compliance",
    rail: "Oversight & Assurance",
    hint: "Audit, documents, access, platform",
    cap: 6,
  },
  {
    key: "SETTINGS",
    label: "Settings & Storefront",
    rail: "Settings & Storefront",
    hint: "Storefront, integrations, units",
    cap: 6,
  },
  { key: "WORKSPACE", label: "My Sales Workspace", rail: "My Sales Workspace" },
];

export const groupByKey = (key: NavGroupKey): NavGroup =>
  NAV_GROUPS.find((g) => g.key === key) || NAV_GROUPS[0];

/* ─────────────────────── eligibility context ─────────────────────── */

export interface NavCtx {
  role?: string;
  isExecutive: boolean;
  isWorker: boolean;
  isFarmAdvisor: boolean;
  isBranchManager: boolean;
  isSuperAdmin: boolean;
  /** Owner-delegated "Manage Business/Unit" manager (businessManageIds). */
  isUnitManager: boolean;
  canViewFinance: boolean;
  canManageSupport: boolean;
  canManageCctv: boolean;
  canManageAuditors: boolean;
  auditEligible: boolean;
  /** Handlers present ⇒ the row can actually do something. */
  hasSupportEditor: boolean;
  hasManageBusinesses: boolean;
  hasOnlineOrdering: boolean;
}

export function navCtx(currentUser: any, extra: Partial<NavCtx> = {}): NavCtx {
  const role = currentUser?.role || "OWNER";
  return {
    role,
    isExecutive: role === "OWNER" || role === "GENERAL_MANAGER",
    isWorker: role === "WORKER",
    isFarmAdvisor: role === "FARM_ADVISOR",
    isBranchManager: role === "BRANCH_MANAGER",
    isSuperAdmin: !!currentUser?.isSuperAdmin,
    isUnitManager: !!extra.isUnitManager,
    canViewFinance: !!currentUser?.canViewFinance,
    canManageSupport: !!currentUser?.canManageSupport,
    canManageCctv: !!currentUser?.canManageCctv,
    canManageAuditors: !!currentUser?.canManageAuditors,
    auditEligible: !!extra.auditEligible,
    hasSupportEditor: !!extra.hasSupportEditor,
    hasManageBusinesses: !!extra.hasManageBusinesses,
    hasOnlineOrdering: !!extra.hasOnlineOrdering,
  };
}

/* ───────────────────────── entries ───────────────────────── */

export interface NavEntry {
  /** ActiveTab this row opens. */
  id: string;
  label: string;
  /** Icon-rail tooltip + palette short name. */
  short: string;
  group: NavGroupKey;
  order: number;
  Icon: any;
  keywords: string[];
  testid?: string;
  chip?: string;
  /** Tailwind classes used when this row is the active destination. */
  active?: string;
  /** Small colour class for the icon. */
  ink?: string;
  /** Rows that an uploaded handler performs instead of switching tab. */
  action?: "support" | "manageUnits" | "onlineOrdering";
  eligible: (c: NavCtx) => boolean;
  /** Destination is part of a hub: the hub heading is rendered once. */
  hub?: { key: string; label: string; Icon: any };
  /** Wording overrides for the right rail's breadcrumb / "Section" row. */
  rail?: { label?: string; section?: string };
}

const execOrUnitManager = (c: NavCtx) => c.isExecutive || c.isUnitManager;

export const NAV_ENTRIES: NavEntry[] = [
  /* ── pinned ─────────────────────────────────────────────── */
  {
    id: "COMMAND_CENTER",
    label: "Command Center",
    short: "Command Center",
    group: "PINNED",
    order: 10,
    Icon: LayoutDashboard,
    keywords: ["hq", "home", "dashboard", "executive", "overview"],
    chip: "360° HQ",
    active: "bg-gradient-to-r from-emerald-600 to-teal-700 text-white shadow-lg shadow-emerald-900/30 font-bold",
    // Kept from the original rail wording so "where am I?" still says HQ.
    rail: { label: "Enterprise Command Center", section: "Executive HQ" },
    eligible: (c) => c.isExecutive,
  },
  {
    id: "ADVISOR",
    label: "Advisor Console",
    short: "Advisor Console",
    group: "PINNED",
    order: 5,
    Icon: Stethoscope,
    keywords: ["advisor", "farm", "monitor", "follow-ups"],
    testid: "advisor-console-tab",
    chip: "MONITOR",
    ink: "text-teal-400",
    active: "bg-gradient-to-r from-teal-600 to-emerald-700 text-white shadow-lg shadow-teal-900/30 font-bold",
    eligible: (c) => c.isFarmAdvisor,
  },
  {
    id: "ACTION_CENTER",
    label: "Action Center",
    short: "Action Center",
    group: "PINNED",
    order: 20,
    Icon: ListTodo,
    keywords: ["todo", "tasks", "actions", "approvals", "checklist", "queue"],
    testid: "sidebar-tab-actions",
    chip: "ALL ACTIONS",
    ink: "text-amber-400",
    active: "bg-gradient-to-r from-amber-600 to-orange-600 text-white shadow-lg shadow-amber-900/30 font-bold",
    eligible: (c) => !c.isFarmAdvisor,
  },

  /* ── Sell & Fulfil ──────────────────────────────────────── */
  {
    id: "SALES_CENTER",
    label: "Sales & Payments",
    short: "Sales",
    group: "SELL",
    order: 10,
    Icon: ShoppingCart,
    keywords: ["sales", "till", "pos", "payments", "invoices", "receipts"],
    testid: "sidebar-tab-sales",
    chip: "ALL",
    ink: "text-cyan-400",
    eligible: execOrUnitManager,
  },
  {
    id: "TRACKING",
    label: "Customer Order & Tracking",
    short: "Live Orders",
    group: "SELL",
    order: 20,
    Icon: Truck,
    keywords: ["orders", "tracking", "delivery", "fulfilment", "live", "dispatch", "gm-"],
    testid: "sidebar-tab-tracking",
    chip: "LIVE",
    ink: "text-cyan-400/90",
    hub: { key: "ORDERS", label: "Orders & Fulfilment", Icon: Truck },
    eligible: (c) => execOrUnitManager(c) || c.isBranchManager,
  },
  {
    id: "PREORDERS",
    label: "Pre-Orders & Procurement",
    short: "Pre-Orders",
    group: "SELL",
    order: 30,
    Icon: CalendarClock,
    keywords: ["pre-orders", "preorders", "procurement", "suppliers", "setup", "offers"],
    testid: "sidebar-tab-preorders",
    chip: "SETUP",
    ink: "text-indigo-400/90",
    hub: { key: "ORDERS", label: "Orders & Fulfilment", Icon: Truck },
    eligible: execOrUnitManager,
  },
  {
    id: "CUSTOMERS",
    label: "Customers & CRM",
    short: "Customers",
    group: "SELL",
    order: 40,
    Icon: Users,
    keywords: ["customers", "crm", "contacts", "client", "phone"],
    ink: "text-emerald-400/80",
    eligible: execOrUnitManager,
  },

  /* ── Money ──────────────────────────────────────────────── */
  {
    id: "FINANCE",
    label: "Finance & Reports",
    short: "Finance",
    group: "MONEY",
    order: 10,
    Icon: Landmark,
    keywords: ["finance", "reports", "p&l", "cashflow", "budget", "profit", "margin"],
    testid: "sidebar-tab-finance",
    chip: "ALL",
    ink: "text-cyan-400",
    eligible: (c) => execOrUnitManager(c) || c.canViewFinance,
  },
  {
    id: "TRANSACTIONS",
    label: "Transactions & MoMo",
    short: "Transactions",
    group: "MONEY",
    order: 20,
    Icon: CreditCard,
    keywords: ["transactions", "momo", "mobile money", "ledger", "income", "expense", "payments"],
    ink: "text-emerald-400/80",
    eligible: execOrUnitManager,
  },

  /* ── Records ────────────────────────────────────────────── */
  {
    id: "INVENTORY",
    label: "Inventory & Stock",
    short: "Inventory",
    group: "RECORDS",
    order: 10,
    Icon: Package,
    keywords: ["inventory", "stock", "items", "sku", "warehouse", "movements"],
    ink: "text-emerald-400/80",
    eligible: execOrUnitManager,
  },
  {
    id: "SUPPLIERS",
    label: "Suppliers & Vendors",
    short: "Suppliers",
    group: "RECORDS",
    order: 20,
    Icon: Truck,
    keywords: ["suppliers", "vendors", "purchasing", "procurement", "payables"],
    ink: "text-emerald-400/80",
    eligible: execOrUnitManager,
  },
  {
    id: "EMPLOYEES",
    label: "Employees & Payroll",
    short: "Employees",
    group: "RECORDS",
    order: 30,
    Icon: UserCheck,
    keywords: ["employees", "staff", "payroll", "hr", "wages", "attendance"],
    ink: "text-emerald-400/80",
    eligible: execOrUnitManager,
  },
  {
    id: "ASSETS",
    label: "Assets & Equipment",
    short: "Assets",
    group: "RECORDS",
    order: 40,
    Icon: Wrench,
    keywords: ["assets", "equipment", "machines", "maintenance", "depreciation"],
    ink: "text-emerald-400/80",
    eligible: execOrUnitManager,
  },

  /* ── Branch Management (BRANCH_MANAGER) ─────────────────── */
  {
    id: "BRANCH_SALES",
    label: "Sales & Payments",
    short: "Branch Sales",
    group: "BRANCH",
    order: 10,
    Icon: ShoppingCart,
    keywords: ["branch sales", "till", "payments", "pos"],
    chip: "SALES",
    ink: "text-cyan-400",
    eligible: (c) => c.isBranchManager,
  },
  {
    id: "BRANCH_ASSETS",
    label: "Branch Assets",
    short: "Branch Assets",
    group: "BRANCH",
    order: 20,
    Icon: Wrench,
    keywords: ["assets", "equipment", "branch", "maintenance"],
    ink: "text-purple-400",
    eligible: (c) => c.isBranchManager,
  },
  {
    id: "WORKERS_MANAGE",
    label: "Manage Sales Persons",
    short: "Sales Persons",
    group: "BRANCH",
    order: 30,
    Icon: ShieldCheck,
    keywords: ["workers", "sales persons", "staff", "team", "attendance"],
    ink: "text-cyan-400",
    eligible: (c) => c.isBranchManager,
  },

  /* ── Insights & Decisions ───────────────────────────────── */
  {
    id: "BI_ASSISTANT",
    label: "BI Assistant",
    short: "BI Assistant",
    group: "INSIGHTS",
    order: 10,
    Icon: BrainCircuit,
    keywords: ["bi", "assistant", "ask", "questions", "insights", "analytics"],
    testid: "sidebar-tab-assistant",
    chip: "ASK",
    ink: "text-cyan-400/90",
    eligible: execOrUnitManager,
  },
  {
    id: "AI_ADVISOR",
    label: "AI Strategic Advisor",
    short: "AI Advisor",
    group: "INSIGHTS",
    order: 20,
    Icon: Sparkles,
    keywords: ["ai", "strategy", "advice", "recommendations", "growth"],
    chip: "AI",
    ink: "text-amber-400",
    eligible: (c) => c.isExecutive,
  },
  {
    id: "SCENARIO_PLANNER",
    label: "Scenario Planning",
    short: "Scenarios",
    group: "INSIGHTS",
    order: 30,
    Icon: Sliders,
    keywords: ["scenario", "planner", "what-if", "simulation", "forecast", "planning"],
    ink: "text-teal-400",
    eligible: (c) => c.isExecutive,
  },

  /* ── Governance & Compliance ────────────────────────────── */
  {
    id: "AUDIT",
    label: "Audit & Review",
    short: "Audit",
    group: "GOVERNANCE",
    order: 10,
    Icon: ShieldCheck,
    keywords: ["audit", "review", "compliance", "qa", "issues", "findings"],
    testid: "audit-tab",
    chip: "QA",
    ink: "text-teal-400",
    active: "bg-gradient-to-r from-teal-500/20 to-cyan-500/20 text-teal-300 font-bold border-l-2 border-teal-400",
    eligible: (c) => c.role === "OWNER" || c.canManageAuditors || c.auditEligible,
  },
  {
    id: "DOCUMENTS",
    label: "Document Vault",
    short: "Documents",
    group: "GOVERNANCE",
    order: 20,
    Icon: FolderLock,
    keywords: ["documents", "vault", "files", "uploads", "certificates", "vet reports"],
    testid: "sidebar-tab-documents",
    chip: "NEW",
    ink: "text-teal-400/90",
    eligible: execOrUnitManager,
  },
  {
    id: "ADVISOR_MANAGE",
    label: "Farm Advisors",
    short: "Farm Advisors",
    group: "GOVERNANCE",
    order: 30,
    // Shares the ADVISOR tab with the advisor's own console, but the OWNER
    // reaches it as an ACCESS console — hence the distinct id + testid.
    Icon: Stethoscope,
    keywords: ["farm advisors", "access", "grants", "monitoring", "permissions"],
    testid: "sidebar-advisor-manage",
    chip: "ACCESS",
    ink: "text-teal-400",
    active: "bg-teal-500/15 text-teal-300 font-bold border-l-2 border-teal-400",
    eligible: (c) => c.isExecutive,
  },
  {
    id: "USERS_MANAGE",
    label: "Enterprise Users",
    short: "Users & Access",
    group: "GOVERNANCE",
    order: 40,
    Icon: UserCheck,
    keywords: ["users", "access", "roles", "permissions", "assignments", "staff accounts"],
    chip: "HQ",
    ink: "text-cyan-400",
    eligible: (c) => c.isExecutive,
  },
  {
    id: "PLATFORM_ADMIN",
    label: "Platform Owners",
    short: "Platform Owners",
    group: "GOVERNANCE",
    order: 50,
    Icon: Building2,
    keywords: ["platform", "organizations", "owners", "super admin", "lifecycle"],
    chip: "PLATFORM",
    ink: "text-fuchsia-300",
    active: "bg-fuchsia-500/15 text-fuchsia-300 font-bold border-l-2 border-fuchsia-400",
    eligible: (c) => c.isSuperAdmin,
  },

  /* ── Settings & Storefront ──────────────────────────────── */
  {
    id: "SUPPORT",
    label: "Support — Storefront HELP",
    short: "Storefront HELP",
    group: "SETTINGS",
    order: 10,
    Icon: LifeBuoy,
    keywords: ["storefront", "help", "support", "contact", "customer service", "faq"],
    testid: "sidebar-support-info",
    ink: "text-amber-400",
    action: "support",
    eligible: (c) => c.hasSupportEditor && (c.role === "OWNER" || c.canManageSupport),
  },
  {
    id: "INTEGRATIONS",
    label: "Integrations Hub",
    short: "Integrations",
    group: "SETTINGS",
    order: 20,
    Icon: Share2,
    keywords: ["integrations", "cctv", "cameras", "momo", "mobile money", "api", "devices"],
    chip: "CCTV/MoMo",
    ink: "text-cyan-400",
    eligible: (c) => c.isExecutive || c.canManageCctv,
  },
  {
    id: "ONLINE_ORDERING",
    label: "Online Ordering",
    short: "Online Ordering",
    group: "SETTINGS",
    order: 30,
    Icon: Globe,
    keywords: ["online", "storefront", "delivery areas", "order page", "service areas"],
    testid: "sidebar-online-ordering",
    ink: "text-cyan-400",
    action: "onlineOrdering",
    // The handler itself is only handed in for OWNER / canManageOnline users,
    // so its presence is the permission.
    eligible: (c) => c.hasOnlineOrdering,
  },
  {
    id: "MANAGE_UNITS",
    label: "Manage Units",
    short: "Manage Units",
    group: "SETTINGS",
    order: 40,
    Icon: Settings2,
    keywords: ["units", "branches", "businesses", "add unit", "archive", "settings"],
    testid: "sidebar-manage-units",
    chip: "GRANTED",
    ink: "text-indigo-400",
    action: "manageUnits",
    eligible: (c) => !c.isExecutive && c.isUnitManager && c.hasManageBusinesses,
  },
];

/* ───────────────────────── selectors ───────────────────────── */

const byOrder = (a: NavEntry, b: NavEntry) => a.order - b.order || a.label.localeCompare(b.label);

/** Every destination this user may open, in rail order. */
export function navEntriesFor(ctx: NavCtx): NavEntry[] {
  return NAV_ENTRIES.filter((e) => {
    try {
      return e.eligible(ctx);
    } catch {
      return false;
    }
  }).sort(byOrder);
}

/** Destinations grouped by section, in section order. Empty sections dropped. */
export function navSectionsFor(ctx: NavCtx): { group: NavGroup; entries: NavEntry[] }[] {
  const entries = navEntriesFor(ctx);
  return NAV_GROUPS.filter((g) => g.key !== "MY_BUSINESSES" && g.key !== "PINNED")
    .map((group) => ({ group, entries: entries.filter((e) => e.group === group.key).sort(byOrder) }))
    .filter((s) => s.entries.length > 0);
}

export function pinnedFor(ctx: NavCtx): NavEntry[] {
  return NAV_ENTRIES.filter((e) => e.group === "PINNED" && e.eligible(ctx)).sort(byOrder);
}

export function entryById(id: string): NavEntry | undefined {
  return NAV_ENTRIES.find((e) => e.id === id);
}

/** Right-rail / breadcrumb metadata for a destination ("where am I?"). */
export function pageInfoFor(id: string): { label: string; section: string; Icon: any } | null {
  const e = NAV_ENTRIES.find((x) => x.id === id);
  if (!e) return null;
  return {
    label: e.rail?.label || e.label,
    section: e.rail?.section || groupByKey(e.group).rail,
    Icon: e.Icon,
  };
}

/**
 * The right rail's "Section" wording for a destination. Kept deliberately in
 * the pre-existing vocabulary ("Shared Enterprise Modules", "Oversight &
 * Assurance"…) so breadcrumbs users already rely on do not change meaning.
 */
export function railSectionOf(id: string): string {
  const e = NAV_ENTRIES.find((x) => x.id === id);
  if (!e) return "Workspace";
  return e.rail?.section || groupByKey(e.group).rail;
}

/**
 * Destinations the right rail offers as quick navigation: every page in the
 * same rail section (left-rail family), for the signed-in user's own scope.
 * The current page is included — the rail highlights it, exactly as before.
 */
export function sectionSiblingsFor(id: string, ctx: NavCtx): NavEntry[] {
  const section = railSectionOf(id);
  return navEntriesFor(ctx).filter((e) => railSectionOf(e.id) === section && !e.action);
}

/* ───────────────────── palette search helpers ───────────────────── */

/**
 * Small, dependency-free fuzzy matcher: every query word must appear in the
 * entry's label or keyword list (prefix beats substring, label beats keyword).
 */
export function scoreEntry(entry: NavEntry, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const label = `${entry.label} ${entry.short}`.toLowerCase();
  const hay = `${label} ${entry.keywords.join(" ")} ${groupByKey(entry.group).label}`.toLowerCase();
  let score = 0;
  for (const word of q.split(/\s+/)) {
    if (!word) continue;
    if (hay.includes(word)) {
      score += label.includes(word) ? 10 : 4;
      if (label.startsWith(word)) score += 6;
      if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(label)) score += 3;
    } else if (word.length > 2 && fuzzyLetters(label, word)) {
      score += 2;
    } else {
      return 0;
    }
  }
  return score;
}

/** "ivnt" → "inventory": subsequence match, used as a last resort. */
function fuzzyLetters(hay: string, needle: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

/* ───────────────────────── business icons ───────────────────────── */

/** Category → icon, shared by the rail, the palette and the right rail. */
export const CATEGORY_ICONS: Record<string, any> = {
  "Poultry Farm": Egg,
  "Block Factory": Boxes,
  Aquaculture: Fish,
  Livestock: Beef,
  "Restaurant & Food": Utensils,
  "Electronic Shop": Cpu,
  "Car Wash": Droplets,
  "Hardware Store": HardHat,
  "Telecom & Digital Services": Wifi,
  Boutique: Shirt,
};

/** Well-known unit codes keep their icon even if the category was edited. */
export const BUSINESS_ICONS: Record<string, any> = {
  "POULTRY-01": Egg,
  "BLOCK-01": Boxes,
  "AQUA-01": Fish,
  "LIVESTOCK-01": Building2,
  "FOOD-01": Utensils,
  "TECH-01": Cpu,
  "WASH-01": Droplets,
};

export const businessIcon = (biz: any): any =>
  BUSINESS_ICONS[biz?.code] || CATEGORY_ICONS[biz?.category] || Building2;

/**
 * Can this user open this unit's dashboard? Mirrors the server rule exactly:
 * executives reach everything; a branch manager / worker reaches their primary
 * assignment plus each business the OWNER granted (user_business_access), which
 * arrives pre-scoped in `accessibleBusinessIds`. Kept here so the rail, the
 * palette and the right rail can never disagree.
 */
export function canOpenBusiness(
  biz: any,
  opts: { currentUser: any; accessibleBusinessIds?: number[] | null },
): boolean {
  const role = opts.currentUser?.role;
  if (role !== "BRANCH_MANAGER" && role !== "WORKER") return true;
  const assigned = opts.currentUser?.assignedBusinessId;
  if (assigned != null && Number(biz?.id) === Number(assigned)) return true;
  if (Array.isArray(opts.accessibleBusinessIds)) {
    return opts.accessibleBusinessIds.map(Number).includes(Number(biz?.id));
  }
  return false;
}
