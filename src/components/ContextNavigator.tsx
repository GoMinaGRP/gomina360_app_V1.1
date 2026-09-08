"use client";

import React, { useState } from "react";
import {
  Compass,
  MapPin,
  Building2,
  Layers,
  FileText,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  X,
  LayoutDashboard,
  ShoppingCart,
  Landmark,
  Users,
  Truck,
  UserCheck,
  Wrench,
  Package,
  CreditCard,
  ShieldCheck,
  Sparkles,
  Sliders,
  Share2,
  ShieldAlert,
  Egg,
  Boxes,
  Fish,
  Beef,
  Utensils,
  Cpu,
  Droplets,
  HardHat,
  Wifi,
  CornerUpLeft,
} from "lucide-react";
import type { ActiveTab } from "./Sidebar";

const SHARED = "Shared Enterprise Modules";

/**
 * Human-readable metadata for every top-level destination (mirrors the left
 * Sidebar grouping exactly, so the right panel always agrees with the menu).
 */
const PAGE_INFO: Record<string, { label: string; section: string; Icon: any }> = {
  COMMAND_CENTER: { label: "Enterprise Command Center", section: "Executive HQ", Icon: LayoutDashboard },
  SALES_CENTER: { label: "Sales & Payments", section: SHARED, Icon: ShoppingCart },
  FINANCE: { label: "Finance & Reports", section: SHARED, Icon: Landmark },
  CUSTOMERS: { label: "Customers & CRM", section: SHARED, Icon: Users },
  SUPPLIERS: { label: "Suppliers & Vendors", section: SHARED, Icon: Truck },
  EMPLOYEES: { label: "Employees & Payroll", section: SHARED, Icon: UserCheck },
  ASSETS: { label: "Assets & Equipment", section: SHARED, Icon: Wrench },
  INVENTORY: { label: "Inventory & Stock", section: SHARED, Icon: Package },
  TRANSACTIONS: { label: "Transactions & MoMo", section: SHARED, Icon: CreditCard },
  AUDIT: { label: "Audit & Review", section: "Oversight & Assurance", Icon: ShieldCheck },
  AI_ADVISOR: { label: "AI Strategic Advisor", section: "Decision Support & Hub", Icon: Sparkles },
  SCENARIO_PLANNER: { label: "Scenario Planner", section: "Decision Support & Hub", Icon: Sliders },
  INTEGRATIONS: { label: "Integrations Hub", section: "Decision Support & Hub", Icon: Share2 },
  BRANCH_SALES: { label: "Branch Sales & Payments", section: "Branch Workspace", Icon: ShoppingCart },
  BRANCH_ASSETS: { label: "Branch Assets", section: "Branch Workspace", Icon: Wrench },
  WORKERS_MANAGE: { label: "Manage Sales Persons", section: "Branch Workspace", Icon: ShieldAlert },
  USERS_MANAGE: { label: "Users & Access", section: "Administration", Icon: Users },
};

const CATEGORY_ICONS: Record<string, any> = {
  "Poultry Farm": Egg,
  "Block Factory": Boxes,
  Aquaculture: Fish,
  Livestock: Beef,
  "Restaurant & Food": Utensils,
  "Electronic Shop": Cpu,
  "Car Wash": Droplets,
  "Hardware Store": HardHat,
  "Telecom & Digital Services": Wifi,
};

interface Loc {
  section: string;
  page: string;
  PageIcon: any;
  bizName: string;
  bizCode?: string;
  bizNote?: string;
  branch: string;
  scoped: boolean;
  biz: any | null;
}

const locLine = (biz: any | undefined | null): string => {
  if (!biz) return "—";
  const parts = [biz.branchLocation || biz.branch_location, biz.region].filter(Boolean);
  return parts.join(" · ") || "—";
};

const bizNameOf = (biz: any | undefined | null): string => biz?.name || "—";

/**
 * Resolves "where am I?" for the given tab — mirroring GoMinaApp's own
 * view-resolution precedence (Audit first, then WORKER / BRANCH_MANAGER
 * interception, then business pages, then the static page registry), so the
 * panel always describes the screen the user is ACTUALLY looking at.
 */
export function resolveLocation(
  activeTab: string,
  businesses: any[],
  currentUser: any,
): Loc {
  const role = currentUser?.role || "OWNER";
  const isExecutive = role === "OWNER" || role === "GENERAL_MANAGER";
  const isWorker = role === "WORKER";
  const isBranchManager = role === "BRANCH_MANAGER";
  const assignedBiz = businesses.find((b) => b.id === currentUser?.assignedBusinessId);
  const biz = businesses.find((b) => b.code === activeTab) || null;

  // 1) Audit & Review takes precedence for every role (granted auditors too).
  if (activeTab === "AUDIT") {
    return {
      section: "Oversight & Assurance",
      page: "Audit & Review",
      PageIcon: ShieldCheck,
      bizName: isExecutive ? "Group-wide (all businesses)" : "Your authorized scope",
      bizNote: isExecutive ? "Full control" : "Scoped by auditor grant",
      branch: isExecutive ? "All branches" : "Granted businesses only",
      scoped: !isExecutive,
      biz: null,
    };
  }

  // 2) WORKER — self-contained sales workspace, always scoped to their unit.
  if (isWorker) {
    return {
      section: "My Sales Workspace",
      page: "Sales Workspace",
      PageIcon: ShoppingCart,
      bizName: bizNameOf(assignedBiz),
      bizCode: assignedBiz?.code,
      bizNote: "Your assigned unit",
      branch: locLine(assignedBiz),
      scoped: true,
      biz: assignedBiz || null,
    };
  }

  // 3) BRANCH_MANAGER — unauthorized tabs fall back to their Branch Sales view.
  if (isBranchManager) {
    const allowed = new Set<string>(["BRANCH_SALES", "WORKERS_MANAGE", "BRANCH_ASSETS"]);
    if (currentUser?.canManageCctv) allowed.add("INTEGRATIONS");
    if (assignedBiz?.code) allowed.add(assignedBiz.code);
    const effective = allowed.has(activeTab) ? activeTab : "BRANCH_SALES";
    if (assignedBiz && effective === assignedBiz.code) {
      // falls through to the business-page branch below (same shape as exec)
    } else {
      const info = PAGE_INFO[effective] || { label: effective, section: "Branch Workspace", Icon: ShoppingCart };
      return {
        section: info.section,
        page: info.label,
        PageIcon: info.Icon,
        bizName: bizNameOf(assignedBiz),
        bizCode: assignedBiz?.code,
        bizNote: "Your branch",
        branch: locLine(assignedBiz),
        scoped: true,
        biz: assignedBiz || null,
      };
    }
  }

  // 4) A concrete business page (executive view of any unit, or a branch
  //    manager viewing their own unit page).
  if (biz) {
    return {
      section: "Ghana Businesses",
      page: "Management Dashboard",
      PageIcon: CATEGORY_ICONS[biz.category] || Building2,
      bizName: biz.name,
      bizCode: biz.code,
      bizNote: biz.category,
      branch: locLine(biz),
      scoped: !!isBranchManager,
      biz,
    };
  }

  // 5) Static page registry (HQ, shared modules, decision support…).
  const info = PAGE_INFO[activeTab] || { label: activeTab, section: "Workspace", Icon: FileText };
  const inShared = info.section === SHARED;
  return {
    section: info.section,
    page: info.label,
    PageIcon: info.Icon,
    bizName: inShared || info.section === "Executive HQ" ? "Group-wide (all businesses)" : "—",
    bizNote: inShared ? "Consolidated across every unit" : undefined,
    branch: inShared ? "All branches (consolidated)" : info.section === "Executive HQ" ? "Enterprise HQ" : "—",
    scoped: false,
    biz: null,
  };
}

const crumbList = (loc: Loc): string[] => {
  const c = ["GoMina 360", loc.section];
  if (loc.biz) c.push(loc.bizName);
  c.push(loc.page);
  return c;
};

function Row({
  Icon,
  label,
  value,
  sub,
  accent,
  tid,
}: {
  Icon: any;
  label: string;
  value: string;
  sub?: string;
  accent: string;
  tid: string;
}) {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-xl bg-slate-800/50 border border-slate-700/50">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${accent}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</div>
        <div className="text-xs font-semibold text-slate-100 truncate" data-testid={tid} title={value}>
          {value}
        </div>
        {sub && <div className="text-[10px] text-slate-400 truncate" title={sub}>{sub}</div>}
      </div>
    </div>
  );
}

function PanelBody({
  loc,
  activeTab,
  businesses,
  currentUser,
  onSelectTab,
}: {
  loc: Loc;
  activeTab: string;
  businesses: any[];
  currentUser: any;
  onSelectTab: (tab: ActiveTab) => void;
}) {
  const role = currentUser?.role || "OWNER";
  const isExecutive = role === "OWNER" || role === "GENERAL_MANAGER";
  const isWorker = role === "WORKER";
  const isBranchManager = role === "BRANCH_MANAGER";
  const crumbs = crumbList(loc);

  // Sibling units of the same business family (e.g. POULTRY-01 ↔ POULTRY-02).
  const siblings = loc.biz
    ? businesses.filter((b) => b.category === loc.biz.category)
    : [];

  // Quick navigation = the pages of the section you are currently in.
  let quick: { tid: string; label: string; Icon: any }[] = [];
  if (loc.section === "Ghana Businesses") {
    quick = businesses
      .filter((b) => {
        if ((isWorker || isBranchManager) && currentUser?.assignedBusinessId)
          return b.id === currentUser.assignedBusinessId;
        return true;
      })
      .map((b) => ({ tid: b.code, label: b.name, Icon: CATEGORY_ICONS[b.category] || Building2 }));
  } else if (loc.section === SHARED && isExecutive) {
    quick = Object.entries(PAGE_INFO)
      .filter(([, v]) => v.section === SHARED)
      .map(([k, v]) => ({ tid: k, label: v.label, Icon: v.Icon }));
  } else if (loc.section === "Branch Workspace" && isBranchManager) {
    quick = ["BRANCH_SALES", "WORKERS_MANAGE", "BRANCH_ASSETS"]
      .map((k) => ({ tid: k, label: PAGE_INFO[k].label, Icon: PAGE_INFO[k].Icon }));
    if (currentUser?.canManageCctv) quick.push({ tid: "INTEGRATIONS", label: "Integrations Hub", Icon: Share2 });
  }

  const showHome = isExecutive && activeTab !== "COMMAND_CENTER";

  return (
    <div className="p-3 space-y-2.5">
      {/* Breadcrumb path */}
      <nav
        data-testid="ctx-crumbs"
        className="flex items-center flex-wrap gap-x-1 gap-y-0.5 px-1 pb-1 text-[11px] text-slate-400"
      >
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <ChevronRight className="w-3 h-3 text-slate-600" />}
            <span className={i === crumbs.length - 1 ? "font-bold text-emerald-300" : ""}>{c}</span>
          </React.Fragment>
        ))}
      </nav>

      {/* Where-you-are rows */}
      <Row Icon={Layers} label="Section" value={loc.section} accent="bg-indigo-500/15 text-indigo-300 border-indigo-500/30" tid="ctx-section" />
      <Row
        Icon={loc.biz ? CATEGORY_ICONS[loc.biz.category] || Building2 : Building2}
        label="Business"
        value={loc.bizCode ? `${loc.bizName} (${loc.bizCode})` : loc.bizName}
        sub={loc.scoped ? loc.bizNote || "Scoped access" : loc.bizNote}
        accent="bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
        tid="ctx-business"
      />
      <Row Icon={MapPin} label="Branch" value={loc.branch} accent="bg-teal-500/15 text-teal-300 border-teal-500/30" tid="ctx-branch" />
      <Row Icon={FileText} label="Page" value={loc.page} accent="bg-cyan-500/15 text-cyan-300 border-cyan-500/30" tid="ctx-page" />

      {/* Units of the same business family */}
      {siblings.length > 1 && (
        <div className="pt-1">
          <div className="px-1 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Units in this family
          </div>
          <div className="flex flex-wrap gap-1.5" data-testid="ctx-units">
            {siblings.map((s) => (
              <button
                key={s.code}
                onClick={() => onSelectTab(s.code)}
                data-testid={`ctx-unit-${s.code}`}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition ${
                  s.code === activeTab
                    ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                    : "bg-slate-800/70 text-slate-300 border-slate-700 hover:border-emerald-500/40 hover:text-emerald-300"
                }`}
              >
                {s.code}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Quick navigation within the current section */}
      {quick.length > 0 && (
        <div className="pt-1">
          <div className="px-1 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Quick Navigation
          </div>
          <div className="space-y-1 max-h-64 overflow-y-auto pr-0.5">
            {quick.map((q) => (
              <button
                key={q.tid}
                onClick={() => onSelectTab(q.tid as ActiveTab)}
                data-testid={`ctx-quick-${q.tid}`}
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition ${
                  q.tid === activeTab
                    ? "bg-emerald-500/15 text-emerald-300 font-bold border-l-2 border-emerald-400"
                    : "hover:bg-slate-800/70 text-slate-300"
                }`}
              >
                <q.Icon className="w-3.5 h-3.5 shrink-0 opacity-80" />
                <span className="truncate">{q.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Back to HQ */}
      {showHome && (
        <button
          onClick={() => onSelectTab("COMMAND_CENTER")}
          data-testid="ctx-quick-COMMAND_CENTER"
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] font-semibold text-amber-300 bg-amber-500/10 border border-amber-500/25 hover:bg-amber-500/20 transition"
        >
          <CornerUpLeft className="w-3.5 h-3.5" />
          <span>Back to Command Center</span>
        </button>
      )}
    </div>
  );
}

interface NavProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  businesses: any[];
  currentUser: any;
  /** Drawer visibility below xl + close handler. */
  open?: boolean;
  onClose?: () => void;
}

/**
 * The restored right-side navigation / "you are here" panel:
 *  - xl and wider:  persistent right rail (collapsible to an icon strip)
 *  - below xl:      slide-in drawer from the right, opened from the compact
 *                   context bar rendered at the top of every page
 */
export default function ContextNavigator({
  activeTab,
  onSelectTab,
  businesses,
  currentUser,
  open = false,
  onClose,
}: NavProps) {
  const [collapsed, setCollapsed] = useState(false);
  const loc = resolveLocation(activeTab, businesses, currentUser);

  const body = (
    <PanelBody
      loc={loc}
      activeTab={activeTab}
      businesses={businesses}
      currentUser={currentUser}
      onSelectTab={onSelectTab}
    />
  );

  return (
    <>
      {/* Backdrop + drawer (phone / tablet / small laptop) */}
      <div
        data-testid="ctx-backdrop"
        onClick={onClose}
        className={`xl:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />
      <aside
        data-testid="ctx-drawer"
        className={`xl:hidden fixed top-0 right-0 z-50 h-screen w-72 max-w-[86vw] bg-slate-900 border-l border-slate-800 text-slate-300 overflow-y-auto
          transition-transform duration-200 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 sticky top-0 bg-slate-900 z-10">
          <span className="flex items-center gap-2 text-sm font-bold text-white">
            <Compass className="w-4 h-4 text-emerald-400" />
            Where You Are
          </span>
          <button
            onClick={onClose}
            data-testid="ctx-drawer-close"
            aria-label="Close location panel"
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {body}
      </aside>

      {/* Persistent right rail (xl+) — collapsible to a slim icon strip */}
      <aside
        data-testid="ctx-panel"
        className={`hidden xl:flex flex-col shrink-0 border-l border-slate-800 bg-slate-900 text-slate-300 overflow-y-auto transition-[width] duration-200 ${
          collapsed ? "w-14" : "w-72 2xl:w-80"
        }`}
      >
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-800 sticky top-0 bg-slate-900 z-10">
          {!collapsed && (
            <span className="flex items-center gap-2 text-xs font-bold text-white tracking-wide">
              <Compass className="w-4 h-4 text-emerald-400" />
              NAVIGATION &amp; LOCATION
            </span>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            data-testid="ctx-collapse"
            aria-label={collapsed ? "Expand location panel" : "Collapse location panel"}
            className={`p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white ${collapsed ? "mx-auto" : ""}`}
          >
            {collapsed ? <ChevronsLeft className="w-4 h-4" /> : <ChevronsRight className="w-4 h-4" />}
          </button>
        </div>
        {collapsed ? (
          <div className="flex flex-col items-center gap-2 py-3">
            <loc.PageIcon className="w-4 h-4 text-emerald-400" />
            {loc.biz && <Building2 className="w-3.5 h-3.5 text-slate-500" />}
            <MapPin className="w-3.5 h-3.5 text-slate-500" />
          </div>
        ) : (
          body
        )}
      </aside>
    </>
  );
}

/**
 * Compact location bar for the top strip on every page below xl: breadcrumb
 * + a button that opens the right-hand navigation drawer.
 */
export function ContextBar({
  activeTab,
  businesses,
  currentUser,
  onOpen,
}: {
  activeTab: ActiveTab;
  businesses: any[];
  currentUser: any;
  onOpen: () => void;
}) {
  const loc = resolveLocation(activeTab, businesses, currentUser);
  const crumbs = crumbList(loc);
  return (
    <div className="flex items-center min-w-0 flex-1 mr-2" data-testid="ctx-bar">
      <Compass className="w-4 h-4 text-emerald-400 mr-1.5 shrink-0" />
      <nav className="hidden sm:flex items-center min-w-0 text-[11px] text-slate-400 overflow-hidden whitespace-nowrap">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <ChevronRight className="w-3 h-3 mx-0.5 text-slate-600 shrink-0" />}
            <span className={`truncate ${i === crumbs.length - 1 ? "font-bold text-slate-100" : ""}`}>{c}</span>
          </React.Fragment>
        ))}
      </nav>
      <nav className="sm:hidden min-w-0 text-[11px] text-slate-300 font-semibold truncate">
        {crumbs[crumbs.length - 1]}
      </nav>
      <button
        onClick={onOpen}
        data-testid="ctx-open-btn"
        aria-label="Open location panel"
        className="ml-auto sm:ml-2 shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] font-semibold text-emerald-300 transition"
      >
        <span>Location</span>
        <ChevronsLeft className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
