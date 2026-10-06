"use client";

/**
 * Sidebar — the single left navigation rail.
 *
 * Rewritten (sidebar audit, docs/SIDEBAR-NAV-AUDIT.md) to render *from the
 * manifest* (src/lib/navManifest.ts) instead of hard-coding each section. What
 * that buys the product:
 *
 *  · One destination = one row. The old rail rendered "Customer Order &
 *    Tracking" twice and "Finance & Reports" twice for a manage-grantee, with
 *    duplicate test-ids; eligibility now lives in exactly one place.
 *  · Sections are real, collapsible groups with a live count. A group is
 *    ≤6 rows, so the rail cannot grow into a 30-row wall again.
 *  · "My Businesses" is bounded: the unit list scrolls inside its own box,
 *    picks up a type-to-filter box past 8 units, and puts favourites first —
 *    with EVERY unit still rendered (nothing is hidden behind a click).
 *  · Quick access: recents + favourites, so the 3-4 screens an owner uses
 *    daily are always one click away.
 *  · Search: a "Search or jump to…" row opens the command palette (⌘K).
 *  · Phones: the rail is an off-canvas drawer opened from the navbar, with a
 *    4-slot bottom bar for the everyday actions — instead of a 48px strip of
 *    unlabelled icons.
 *
 * Everything that worked before still works: same test-ids, same chips
 * (GRANTED / MANAGE / MONITOR / INACTIVE), same Organization Lens, same
 * role gating (re-checked server-side by /api/init and every API route).
 */

import React, { useEffect, useMemo, useState } from "react";
import { groupBusinessesByOrg } from "@/lib/orgGrouping";
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Search,
  X,
  Settings2,
  Building2,
  Clock,
  LayoutDashboard,
  ListTodo,
  Stethoscope,
  ShoppingCart,
} from "lucide-react";
import { businessManageIdsOf } from "@/lib/permissions";
import {
  NavEntry,
  businessIcon,
  entryById,
  groupByKey,
  navCtx,
  navEntriesFor,
  navSectionsFor,
} from "@/lib/navManifest";
import {
  NAV_PREFS_EVENT,
  loadNavPrefs,
  saveNavPrefs,
  isSectionOpen,
  pushRecent,
  quickAccessIds,
} from "@/lib/navPrefs";
import { isOrgexecRole, normaliseRole, roleCategory } from "@/lib/roles";

export type ActiveTab =
  | "COMMAND_CENTER"
  | "ACTION_CENTER"
  | "ADVISOR"
  | "POULTRY-01"
  | "BLOCK-01"
  | "AQUA-01"
  | "LIVESTOCK-01"
  | "FOOD-01"
  | "TECH-01"
  | "WASH-01"
  | "CUSTOMERS"
  | "SUPPLIERS"
  | "EMPLOYEES"
  | "ASSETS"
  | "INVENTORY"
  | "TRANSACTIONS"
  | "DOCUMENTS"
  | "BI_ASSISTANT"
  | "FINANCE"
  | "AI_ADVISOR"
  | "SCENARIO_PLANNER"
  | "INTEGRATIONS"
  | "WORKERS_MANAGE"
  | "BRANCH_SALES"
  | "USERS_MANAGE"
  | "SALES_CENTER"
  | "BRANCH_ASSETS"
  // Allows any dynamically created business code (new branch units)
  | (string & {});

interface SidebarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  businesses: any[];
  currentUser: any;
  auditEligible?: boolean;
  /** Opens the Customer Support (storefront HELP) editor — OWNER always,
   *  plus any user the OWNER granted canManageSupport. */
  onOpenSupportInfo?: () => void;
  /** Server-vetted access scope from /api/init (null ⇒ OWNER, unrestricted). */
  accessibleBusinessIds?: number[] | null;
  /** Opens Manage Businesses & Branches — shown to "Manage Unit" grantees. */
  onOpenManageBusinesses?: () => void;
  /** Opens Manage Units → Online Ordering & service areas. */
  onOpenOnlineOrdering?: () => void;
  /** How many FARM_ADVISOR accounts exist (undefined ⇒ unknown ⇒ show the row). */
  hasFarmAdvisors?: boolean;
  /** SUPER ADMIN ONLY — Organization Lens context + org directory. */
  organizations?: { id: number; name: string; slug: string; status: string }[];
  orgLens?: string; // "MY" | "ALL" | "<orgId>"
  onLensChange?: (lens: string) => void;
  /** Opens the command palette (also bound to ⌘K / "/" globally). */
  onOpenPalette?: () => void;
  /** The shared navigation context computed by GoMinaApp (one truth for the
   *  rail, the palette and the right rail). Falls back to a local computation. */
  navContext?: import("@/lib/navManifest").NavCtx;
  /** Off-canvas drawer state (phones & tablets). */
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
  onOpenMobile?: () => void;
}

export default function Sidebar({
  activeTab,
  onSelectTab,
  businesses,
  currentUser,
  auditEligible,
  organizations = [],
  orgLens = "MY",
  onLensChange,
  onOpenSupportInfo,
  accessibleBusinessIds,
  onOpenManageBusinesses,
  onOpenOnlineOrdering,
  onOpenPalette,
  navContext,
  mobileOpen = false,
  onCloseMobile,
  onOpenMobile,
  hasFarmAdvisors,
}: SidebarProps) {
  // One registry (src/lib/roles.ts) decides these, so the rail agrees with the
  // nav context it renders. The hand-written pair below used to omit CO_OWNER,
  // so a Co-Owner's rail treated them as a non-executive (audit finding F4/F5).
  const isBusinessManager = normaliseRole(currentUser?.role) === "BRANCH_MANAGER";
  const isWorker = roleCategory(currentUser?.role) === "SHOP_FLOOR";
  const isFarmAdvisor = roleCategory(currentUser?.role) === "EXTERNAL";
  const isExecutive = isOrgexecRole(currentUser?.role);
  const isSuperAdmin = !!currentUser?.isSuperAdmin;
  const myOrgName = organizations.find((o) => Number(o.id) === 1)?.name || "GoMina Group";

  const managedBizIds = useMemo(() => new Set(businessManageIdsOf(currentUser)), [currentUser]);
  const isUnitManager = managedBizIds.size > 0;
  const assignedBusinessId = currentUser?.assignedBusinessId;
  const grantScope = Array.isArray(accessibleBusinessIds)
    ? accessibleBusinessIds.map((n) => Number(n))
    : null;

  /** One navigation context for the whole rail (and handed to the palette by
   *  GoMinaApp), so no two surfaces can disagree about who sees what. */
  const ctx = useMemo(
    () =>
      navCtx(currentUser, {
        isUnitManager,
        auditEligible,
        hasSupportEditor: !!onOpenSupportInfo,
        hasManageBusinesses: !!onOpenManageBusinesses,
        hasOnlineOrdering: !!onOpenOnlineOrdering,
        advisorCount: hasFarmAdvisors === undefined ? null : hasFarmAdvisors ? 1 : 0,
      }),
    [currentUser, isUnitManager, isBusinessManager, auditEligible, onOpenSupportInfo, onOpenManageBusinesses, onOpenOnlineOrdering, hasFarmAdvisors],
  );

  const sharedCtx = navContext ?? ctx;
  const entries = useMemo(() => navEntriesFor(sharedCtx), [sharedCtx]);
  const pinned = useMemo(() => entries.filter((e) => e.group === "PINNED"), [entries]);
  const sections = useMemo(() => navSectionsFor(sharedCtx), [sharedCtx]);

  /* ── icon-rail (desktop preference, unchanged key for continuity) ── */
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem("gomina.sidebarCollapsed") === "1");
    } catch {}
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem("gomina.sidebarCollapsed", next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  /* ── per-user preferences: collapsed sections, recents, favourites ── */
  const [prefs, setPrefs] = useState(() => loadNavPrefs());
  useEffect(() => {
    const sync = () => setPrefs(loadNavPrefs());
    window.addEventListener(NAV_PREFS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(NAV_PREFS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  /**
   * Open state = user's stored choice → the group's `defaultCollapsed` → open.
   * `forceOpen` (below) is the "you are here" override.
   */
  const sectionOpen = (key: string) =>
    isSectionOpen(prefs, key, !!groupByKey(key as any)?.defaultCollapsed);
  const toggleSection = (key: string) => {
    const open = sectionOpen(key);
    setPrefs(saveNavPrefs({ sections: { ...prefs.sections, [key]: !open } }));
  };

  /**
   * Auto-reveal: the section holding the destination you are actually on is
   * always rendered open, even when it is default-collapsed or you collapsed
   * it earlier. This is what makes default-collapsing safe — a collapsed
   * section can never hide "where am I" (and it never overwrites the stored
   * choice, so collapsing it again still works once you navigate away).
   */
  const activeEntry = entryById(String(activeTab));
  const forceOpen = (key: string) =>
    (!!activeEntry && activeEntry.group === key) ||
    (key === "MY_BUSINESSES" && businesses.some((b) => b?.code === activeTab));

  /* ── recents: remember where the user actually went ── */
  useEffect(() => {
    if (!activeTab) return;
    pushRecent(String(activeTab));
  }, [activeTab]);

  /* ── drawer behaviour: close on navigate / Escape, lock the page ── */
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseMobile?.();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [mobileOpen, onCloseMobile]);

  const selectTab = (tab: ActiveTab) => {
    onSelectTab(tab);
    if (mobileOpen) onCloseMobile?.();
  };

  /* ── My Businesses: archived units leave the rail for execs (their own
        assigned unit never disappears for a manager), SA groups by owner ── */
  const navBusinesses = useMemo(
    () =>
      isExecutive || isSuperAdmin
        ? businesses.filter((b) => !b?.isArchived || b.code === activeTab)
        : businesses,
    [businesses, isExecutive, isSuperAdmin, activeTab],
  );
  const businessGroups = useMemo(
    () => (isSuperAdmin ? groupBusinessesByOrg(businesses, organizations) : []),
    [isSuperAdmin, businesses, organizations],
  );
  const navBusinessGroups = useMemo(
    () =>
      isSuperAdmin
        ? businessGroups
            .map((g) => ({
              ...g,
              businesses: g.businesses.filter((b) => !b?.isArchived || b.code === activeTab),
            }))
            .filter((g) => g.businesses.length > 0)
        : [],
    [businessGroups, isSuperAdmin, activeTab],
  );

  const [bizFilter, setBizFilter] = useState("");
  /**
   * The unit list used to be a fixed-height scroll box nested inside the
   * (already scrolling) rail — two scrollbars, and on a phone it cost ~400px
   * of drawer height on every visit. It now renders the first 5 units inline
   * and reveals the rest on demand: one scroll container, nothing truncated
   * away, and the filter still narrows the whole list at any length.
   */
  const UNIT_PREVIEW = 5;
  const [showAllUnits, setShowAllUnits] = useState(false);
  const [bizFilterOpen, setBizFilterOpen] = useState(false);
  const matchesFilter = (biz: any) => {
    const q = bizFilter.trim().toLowerCase();
    if (!q) return true;
    return `${biz.name} ${biz.code} ${biz.category || ""} ${biz.branchLocation || ""}`
      .toLowerCase()
      .includes(q);
  };
  const favUnitIndex = (biz: any) => {
    const i = prefs.favUnits.indexOf(biz.code);
    return i === -1 ? 999 : i;
  };
  const sortUnits = (list: any[]) =>
    [...list].sort((a, b) => favUnitIndex(a) - favUnitIndex(b));
  /**
   * First N for the inline preview; the filter and "Show all" bypass the cap.
   * The unit you are actually on is always pinned into the preview: a unit you
   * just created (which navigates you straight into it) or arrived at by any
   * other route must never be hidden behind the cap.
   */
  const capUnits = (list: any[]) => {
    if (showAllUnits || bizFilter.trim()) return list;
    const preview = list.slice(0, UNIT_PREVIEW);
    const activeIdx = list.findIndex((b) => b?.code === activeTab);
    if (activeIdx >= UNIT_PREVIEW) preview[UNIT_PREVIEW - 1] = list[activeIdx];
    return preview;
  };

  const isAccessible = (biz: any) => {
    if (isWorker || isBusinessManager) {
      if (assignedBusinessId && Number(biz.id) === Number(assignedBusinessId)) return true;
      if (grantScope) return grantScope.includes(Number(biz.id));
      return false;
    }
    return true; // Owner / GM / Super Admin
  };
  const isPrimary = (biz: any) =>
    assignedBusinessId != null && Number(biz.id) === Number(assignedBusinessId);

  /** One business/branch chip — identical for Owners and super admins. */
  const renderBizButton = (biz: any) => {
    const IconComp = businessIcon(biz);
    const accessible = isAccessible(biz);
    return (
      <button
        key={biz.code}
        data-biz-code={biz.code}
        data-testid={`sidebar-biz-${biz.code}`}
        onClick={() => {
          if (accessible) selectTab(biz.code as ActiveTab);
        }}
        disabled={!accessible}
        aria-label={biz.name}
        className={`w-full flex items-center justify-between px-2 sm:px-3 py-2 rounded-lg text-xs font-medium transition ${
          activeTab === biz.code
            ? "bg-emerald-500/15 text-emerald-400 font-bold border-l-2 border-emerald-400"
            : accessible
              ? "hover:bg-slate-800/70 text-slate-300"
              : "opacity-40 cursor-not-allowed text-slate-500"
        }`}
        title={
          accessible
            ? isPrimary(biz) || isExecutive
              ? `${biz.name} (${biz.branchLocation})`
              : `${biz.name} (${biz.branchLocation}) — granted by the OWNER`
            : "Restricted to assigned branch manager"
        }
      >
        <div className="flex items-center space-x-1.5 sm:space-x-2.5 truncate">
          {biz.logo ? (
            <img
              src={biz.logo}
              alt=""
              data-testid={`sidebar-biz-logo-${biz.code}`}
              className="w-4 h-4 rounded object-cover border border-slate-600 bg-slate-800 shrink-0"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <IconComp
              className={`w-4 h-4 ${activeTab === biz.code ? "text-emerald-400" : "text-slate-400"}`}
            />
          )}
          <span className="truncate">{biz.name}</span>
          {!isExecutive && isBusinessManager && accessible && !isPrimary(biz) && (
            <span
              className="text-[8px] font-black text-emerald-300 bg-emerald-500/15 border border-emerald-500/40 px-1 py-0.5 rounded shrink-0"
              data-testid={`sidebar-chip-granted-${biz.code}`}
            >
              GRANTED
            </span>
          )}
          {isFarmAdvisor && accessible && (
            <span
              className="text-[8px] font-black text-teal-300 bg-teal-500/15 border border-teal-500/40 px-1 py-0.5 rounded shrink-0"
              title="Read-only monitoring granted by the OWNER"
              data-testid={`sidebar-chip-advisor-${biz.code}`}
            >
              MONITOR
            </span>
          )}
          {!isExecutive && isUnitManager && managedBizIds.has(Number(biz.id)) && (
            <span
              className="text-[8px] font-black text-amber-300 bg-amber-500/15 border border-amber-500/40 px-1 py-0.5 rounded shrink-0"
              data-testid={`sidebar-chip-manage-${biz.code}`}
              title="Owner-equivalent management of this unit"
            >
              MANAGE
            </span>
          )}
          {(biz.status || "").toUpperCase() === "INACTIVE" && (
            <span className="text-[9px] font-black text-rose-300 bg-rose-500/15 border border-rose-500/40 px-1 py-0.5 rounded shrink-0">
              INACTIVE
            </span>
          )}
        </div>
        <ChevronRight className="w-3.5 h-3.5 opacity-50 hidden sm:block shrink-0" />
      </button>
    );
  };

  /* ── manifest rows ─────────────────────────────────────────────── */
  const isRowActive = (e: NavEntry) => {
    if (e.id === "ADVISOR_MANAGE") return activeTab === "ADVISOR" && isExecutive;
    if (e.id === "ADVISOR") return activeTab === "ADVISOR" && !isExecutive;
    return activeTab === e.id;
  };

  const runRow = (e: NavEntry) => {
    if (e.action === "support") return onOpenSupportInfo?.();
    if (e.action === "manageUnits") return onOpenManageBusinesses?.();
    if (e.action === "onlineOrdering") return onOpenOnlineOrdering?.();
    // The OWNER's "Farm Advisors" access console shares the ADVISOR screen
    // with the advisor's own read-only console.
    if (e.id === "ADVISOR_MANAGE") return selectTab("ADVISOR");
    selectTab(e.id as ActiveTab);
  };

  const chipFor = (e: NavEntry) => {
    if (e.id === "FINANCE" && !isExecutive && !isUnitManager) return "GRANTED";
    // Workers only ever see their own queue — the chip says so (as before).
    if (e.id === "ACTION_CENTER") return isWorker ? "MY TASKS" : "ALL ACTIONS";
    return e.chip;
  };

  const renderRow = (e: NavEntry, opts: { indented?: boolean; testid?: string } = {}) => {
    const active = isRowActive(e);
    const chip = chipFor(e);
    const activeCls =
      e.active ||
      "bg-cyan-500/15 text-cyan-400 font-bold border-l-2 border-cyan-400";
    return (
      <button
        key={e.id}
        onClick={() => runRow(e)}
        data-testid={opts.testid || e.testid || `sidebar-item-${e.id}`}
        aria-current={active ? "page" : undefined}
        aria-label={e.label}
        title={collapsed ? `${e.label} — ${groupByKey(e.group).label || "Workspace"}` : e.label}
        className={`w-full flex items-center ${opts.indented ? "justify-between pl-3" : "justify-between"} pr-2 sm:pr-3 py-2 rounded-lg text-xs font-medium transition ${
          active ? activeCls : "hover:bg-slate-800/70 text-slate-300"
        }`}
      >
        {collapsed ? (
          <e.Icon className={`w-4 h-4 mx-auto ${active ? "text-white" : e.ink || "text-slate-400"}`} />
        ) : (
          <>
            <span className="flex items-center space-x-1.5 sm:space-x-2.5 truncate">
              <e.Icon className={`w-4 h-4 shrink-0 ${e.ink || "text-slate-400"}`} />
              <span className="truncate">{e.label}</span>
            </span>
            {chip && (
              <span
                className={`hidden sm:inline text-[9px] px-1 py-0.5 rounded font-bold border shrink-0 ${
                  chip === "GRANTED"
                    ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                    : chip === "PLATFORM"
                      ? "bg-fuchsia-500/20 text-fuchsia-200 border-fuchsia-500/30"
                      : "bg-cyan-500/20 text-cyan-300 border-cyan-500/30"
                }`}
              >
                {chip}
              </span>
            )}
          </>
        )}
      </button>
    );
  };

  /* ── quick access: favourites + recents (never the current page) ── */
  const quickEntries = useMemo(() => {
    if (collapsed) return [];
    const ids = quickAccessIds(prefs, String(activeTab), 4);
    return ids
      .map((id) => entries.find((e) => e.id === id))
      .filter((e): e is NavEntry => !!e && !e.action);
  }, [collapsed, prefs, activeTab, entries]);

  /* ── bottom bar (phones & tablets): the four everyday actions ── */
  const homeTab: ActiveTab = isFarmAdvisor
    ? "ADVISOR"
    : isExecutive
      ? "COMMAND_CENTER"
      : isBusinessManager || isWorker
        ? ((businesses.find((b) => Number(b.id) === Number(assignedBusinessId))?.code ||
            (isBusinessManager ? "BRANCH_SALES" : "COMMAND_CENTER")) as ActiveTab)
        : ("COMMAND_CENTER" as ActiveTab);
  /**
   * The bottom bar is FIVE STABLE SLOTS on every role (Home · Actions · Sell ·
   * Search · Menu) — the reassessment audit rejected adding Records / unit
   * switching / Finance here. What changes per role is where the slots *point*,
   * and each slot now reports whether it is the one you are on.
   *
   * Worker "Sell" used to be a dead slot: for a worker `homeTab` *is* the
   * workspace, so "Sell" and "Home" rendered the identical screen (verified by
   * screenshot hash). It now opens the workspace's Record Sale tab via the same
   * window event the rail uses elsewhere — no new prop drilling, no navigation
   * change for anyone else.
   */
  const [workerSubTab, setWorkerSubTab] = useState<string>("SALES");
  useEffect(() => {
    if (!isWorker) return;
    const onSub = (ev: Event) => {
      const d = (ev as CustomEvent).detail;
      if (typeof d === "string") setWorkerSubTab(d);
    };
    window.addEventListener("gomina:worker-subtab-changed", onSub);
    return () => window.removeEventListener("gomina:worker-subtab-changed", onSub);
  }, [isWorker]);

  const openWorkerSale = () => {
    selectTab(homeTab);
    try {
      window.dispatchEvent(new CustomEvent("gomina:worker-subtab", { detail: "SALES" }));
    } catch {
      /* non-browser / blocked — the workspace simply stays on Home */
    }
  };
  const bottomItems = [
    {
      id: "nb-home",
      label: "Home",
      Icon: LayoutDashboard,
      run: () => selectTab(homeTab),
      // A worker only ever has two reachable places (Action Center + their own
      // workspace), so "Home" is simply "the workspace, on any tab other than
      // Record Sale" — Record Sale itself belongs to "Sell".
      active: isWorker
        ? activeTab !== "ACTION_CENTER" && workerSubTab !== "SALES"
        : activeTab === homeTab,
    },
    isFarmAdvisor
      ? {
          id: "nb-console",
          label: "Console",
          Icon: Stethoscope,
          run: () => selectTab("ADVISOR" as ActiveTab),
          active: activeTab === "ADVISOR",
        }
      : {
          id: "nb-actions",
          label: "Actions",
          Icon: ListTodo,
          run: () => selectTab("ACTION_CENTER"),
          active: activeTab === "ACTION_CENTER",
        },
    {
      id: "nb-sell",
      label: "Sell",
      Icon: ShoppingCart,
      run: () =>
        isWorker
          ? openWorkerSale()
          : selectTab(
              (isBusinessManager ? "BRANCH_SALES" : isExecutive || isUnitManager ? "SALES_CENTER" : homeTab) as ActiveTab,
            ),
      active: isWorker
        ? activeTab !== "ACTION_CENTER" && workerSubTab === "SALES"
        : activeTab === "SALES_CENTER" || activeTab === "BRANCH_SALES",
    },
    { id: "nb-search", label: "Search", Icon: Search, run: () => onOpenPalette?.(), active: false },
    { id: "nb-menu", label: "Menu", Icon: ChevronsRight, run: () => onOpenMobile?.(), active: mobileOpen },
  ] as { id: string; label: string; Icon: any; run: () => void; active: boolean }[];

  const bottomBar = (
    <nav
      data-testid="nav-bottom-bar"
      data-printchrome="true"
      className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-slate-900/95 backdrop-blur border-t border-slate-800 flex items-stretch"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {bottomItems.map((b) => (
        <button
          key={b.id}
          data-testid={b.id}
          onClick={b.run}
          aria-label={b.label}
          aria-current={b.active ? "page" : undefined}
          className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 transition ${
            b.active ? "text-emerald-300 bg-slate-800/70" : "text-slate-300 hover:text-white hover:bg-slate-800/70"
          }`}
        >
          <b.Icon className="w-4 h-4" />
          <span className="text-[10px] font-semibold">{b.label}</span>
        </button>
      ))}
    </nav>
  );

  /* ───────────────────────────── render ───────────────────────────── */
  return (
    <>
      {mobileOpen && (
        <div
          data-testid="nav-sidebar-backdrop"
          aria-hidden="true"
          onClick={() => onCloseMobile?.()}
          className="lg:hidden fixed inset-0 z-[55] bg-slate-950/60 backdrop-blur-sm"
        />
      )}
      <aside
        data-testid="nav-sidebar"
        data-printchrome="true"
        data-collapsed={collapsed}
        data-mobile-open={mobileOpen}
        aria-label="Primary navigation"
        className={`shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col text-slate-300 overflow-y-auto overflow-x-hidden select-none
          max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-[60] max-lg:w-72 max-lg:shadow-2xl max-lg:transition-transform max-lg:duration-200
          ${mobileOpen ? "max-lg:translate-x-0" : "max-lg:-translate-x-full"}
          lg:sticky lg:top-0 lg:self-start lg:h-screen lg:translate-x-0 lg:transition-[width] lg:duration-200
          ${collapsed ? "lg:w-14" : "lg:w-64"}`}
      >
        {/* Header row — drawer close on phones, icon-rail toggle on desktop */}
        <div
          className={`flex items-center px-1.5 py-1.5 border-b border-slate-800/60 ${
            collapsed ? "lg:justify-center" : "justify-between"
          }`}
        >
          <span className="lg:hidden flex items-center gap-2 px-1 truncate">
            <span className="w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white font-black text-[9px] flex items-center justify-center border border-emerald-400/30">
              360
            </span>
            <span className="text-xs font-bold text-slate-200">Navigation</span>
          </span>
          <button
            onClick={toggleCollapsed}
            data-testid="sidebar-collapse-toggle"
            aria-label={collapsed ? "Expand navigation menu" : "Collapse navigation menu"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand menu" : "Collapse menu"}
            className="hidden lg:inline-flex p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition"
          >
            {collapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
          </button>
          <button
            onClick={() => onCloseMobile?.()}
            data-testid="sidebar-drawer-close"
            aria-label="Close navigation menu"
            className="lg:hidden p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Command palette trigger — the rail's own search row */}
        {!collapsed && onOpenPalette && (
          <div className="px-2 sm:px-3 pt-2">
            <button
              onClick={() => onOpenPalette()}
              data-testid="sidebar-search-trigger"
              aria-label="Search or jump to a destination"
              className="w-full flex items-center gap-2 px-2 sm:px-3 py-2 rounded-lg bg-slate-800/70 hover:bg-slate-800 border border-slate-700/70 text-slate-400 hover:text-slate-200 transition"
            >
              <Search className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="text-[11px] truncate">Search or jump to…</span>
              <kbd className="ml-auto hidden sm:inline text-[9px] px-1 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-500">
                ⌘K
              </kbd>
            </button>
          </div>
        )}

        {/* Pinned destinations: HQ / console, then the action queue */}
        <div className="space-y-1 p-2 sm:p-3 border-b border-slate-800/70">
          {pinned.map((e) => (
            <button
              key={e.id}
              onClick={() => runRow(e)}
              data-testid={e.testid}
              aria-current={isRowActive(e) ? "page" : undefined}
              aria-label={e.label}
              title={collapsed ? e.label : undefined}
              className={`w-full flex items-center ${
                collapsed ? "justify-center" : "justify-between"
              } px-2 sm:px-3.5 py-2.5 rounded-xl font-semibold text-xs sm:text-sm transition ${
                isRowActive(e) ? e.active : "hover:bg-slate-800/80 text-slate-200"
              }`}
            >
              {collapsed ? (
                <e.Icon className={`w-4 h-4 ${e.ink || "text-slate-400"}`} />
              ) : (
                <>
                  <span className="flex items-center space-x-1.5 sm:space-x-2.5 truncate">
                    <e.Icon
                      className={`w-4 h-4 shrink-0 ${
                        isRowActive(e) ? "text-white" : e.ink || "text-slate-400"
                      }`}
                    />
                    <span className="truncate">{e.label}</span>
                  </span>
                  {e.chip && (
                    <span className="hidden sm:inline text-[10px] bg-slate-800/80 text-slate-300 px-1.5 py-0.5 rounded font-bold border border-slate-700 shrink-0">
                      {e.chip}
                    </span>
                  )}
                </>
              )}
            </button>
          ))}
        </div>

        {/* Quick access — recents, then favourites */}
        {quickEntries.length > 1 && (
          <div className="px-2 sm:px-3 py-2 border-b border-slate-800/70" data-testid="nav-quick-access">
            <div className="flex items-center gap-1.5 px-1 sm:px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <Clock className="w-3 h-3" />
              <span>Quick access</span>
            </div>
            <div className="space-y-1 mt-1">
              {quickEntries.map((e) => renderRow(e, { testid: `nav-quick-${e.id}` }))}
            </div>
          </div>
        )}

        {/* ── MY BUSINESSES ─────────────────────────────────────────── */}
        {!isWorker && (
          <div className="px-2 sm:px-3 py-2 border-b border-slate-800/70">
            <div className="flex items-center">
              <button
                onClick={() => toggleSection("MY_BUSINESSES")}
                data-testid="nav-section-MY_BUSINESSES"
                aria-expanded={sectionOpen("MY_BUSINESSES")}
                aria-controls="nav-body-MY_BUSINESSES"
                className="flex-1 flex items-center gap-1.5 px-1 sm:px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-200 transition min-w-0"
              >
                <ChevronDown
                  className={`w-3 h-3 shrink-0 transition-transform ${
                    sectionOpen("MY_BUSINESSES") ? "" : "-rotate-90"
                  }`}
                />
                <span className={`truncate ${collapsed ? "hidden" : ""}`}>
                  {isSuperAdmin
                    ? orgLens === "MY"
                      ? `My Businesses (${businesses.length})`
                      : orgLens === "ALL"
                        ? `Platform Businesses (${businesses.length} · ${businessGroups.length} owners)`
                        : `Owned by ${
                            organizations.find((o) => String(o.id) === orgLens)?.name || "this Owner"
                          } (${businesses.length})`
                    : isExecutive
                      ? `${businesses.length} Ghana Businesses`
                      : isFarmAdvisor
                        ? `My Farm Units (${navBusinesses.filter(isAccessible).length})`
                        : businesses.filter(isAccessible).length > 1
                          ? `My Branches (${navBusinesses.filter(isAccessible).length})`
                          : "My Branch"}
                </span>
              </button>
              {onOpenManageBusinesses && (isExecutive || isUnitManager) && (
                <button
                  onClick={() => onOpenManageBusinesses()}
                  data-testid="sidebar-manage-businesses"
                  title="Add, edit, archive or restore units"
                  aria-label="Manage units"
                  className="shrink-0 p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-indigo-300 transition"
                >
                  <Settings2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div
              id="nav-body-MY_BUSINESSES"
              className={
                sectionOpen("MY_BUSINESSES") || forceOpen("MY_BUSINESSES")
                  ? "transition-all duration-200"
                  : "max-h-0 opacity-0 pointer-events-none overflow-hidden transition-all duration-200"
              }
            >
              {/* SUPER ADMIN: Organization Lens */}
              {isSuperAdmin && (
                <div className="mt-1 rounded-lg border border-fuchsia-500/30 bg-fuchsia-900/10 px-1.5 py-2">
                  <div className="px-1 py-0.5 text-[10px] font-black uppercase tracking-wider text-fuchsia-300">
                    Organization Lens
                  </div>
                  <select
                    data-testid="org-lens-select"
                    value={orgLens}
                    onChange={(e) => onLensChange?.(e.target.value)}
                    title="Choose whose workspace you are looking at right now"
                    className="w-full px-2 py-1.5 rounded-lg bg-slate-800 border border-fuchsia-500/40 text-fuchsia-100 text-[11px] font-bold focus:outline-none"
                  >
                    <option value="MY">My Workspace — {myOrgName}</option>
                    <option value="ALL">All Organizations (platform oversight)</option>
                    {organizations
                      .filter((o) => Number(o.id) !== 1)
                      .map((o) => (
                        <option key={o.id} value={String(o.id)}>
                          {o.name}
                          {o.status && o.status !== "ACTIVE" ? ` (${o.status})` : ""}
                        </option>
                      ))}
                  </select>
                  <p className="px-1 pt-1 text-[9px] leading-snug text-slate-500">
                    {orgLens === "MY"
                      ? "Operating view — just your own businesses, like any Owner sees."
                      : orgLens === "ALL"
                        ? "Oversight view — every Owner grouped below."
                        : `Focused view — ${
                            organizations.find((o) => String(o.id) === orgLens)?.name || "one Owner"
                          } only.`}
                  </p>
                </div>
              )}

              {/* Type-to-filter once the list is long enough to need it */}
              {!collapsed && (navBusinesses.length > 8 || bizFilterOpen) && (
                <div className="relative mt-1">
                  <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    value={bizFilter}
                    onChange={(ev) => setBizFilter(ev.target.value)}
                    data-testid="sidebar-biz-filter"
                    aria-label="Filter units"
                    placeholder={`Filter ${navBusinesses.length} units…`}
                    className="w-full pl-6 pr-2 py-1.5 rounded-lg bg-slate-800/70 border border-slate-700/70 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/60"
                  />
                </div>
              )}

              {/* The list is BOUNDED (its own scroll box) but never truncated:
                  every unit stays rendered and reachable — no unit disappears
                  behind a "show more". */}
              {/* One scroll container (no nested scrollbar) and never
                  truncated: 5 units inline, then one tap reveals the rest. */}
              <div className="space-y-1 mt-1 pr-0.5" data-testid="nav-biz-list">
                {isSuperAdmin ? (
                  <>
                    {navBusinessGroups.map((group) => (
                      <div key={group.orgId} className="space-y-1">
                        <div
                          data-testid={`sidebar-org-group-${group.orgId}`}
                          className={`flex items-center gap-1.5 px-1.5 pt-2 pb-1 text-[9px] font-black tracking-wider ${
                            group.isMain ? "text-violet-300" : "text-sky-300"
                          }`}
                        >
                          {group.orgLogo ? (
                            <img
                              src={group.orgLogo}
                              alt=""
                              data-testid={`sidebar-org-logo-${group.orgId}`}
                              className="w-4 h-4 rounded object-cover border border-slate-600 bg-slate-800 shrink-0"
                              loading="lazy"
                              decoding="async"
                            />
                          ) : (
                            <span
                              className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                                group.isMain ? "bg-violet-400" : "bg-sky-400"
                              }`}
                            />
                          )}
                          <span className="truncate">
                            {group.isMain
                              ? `YOUR BUSINESSES — ${group.orgName.toUpperCase()} (MAIN OWNER)`
                              : `OWNED BY ${group.orgName.toUpperCase()}`}
                          </span>
                          {group.orgStatus !== "ACTIVE" && (
                            <span className="text-[8px] font-black px-1 py-0.5 rounded border bg-slate-500/15 text-slate-400 border-slate-500/40 shrink-0">
                              {group.orgStatus}
                            </span>
                          )}
                          <span className="ml-auto text-slate-500 shrink-0">{group.businesses.length}</span>
                        </div>
                        {capUnits(sortUnits(group.businesses.filter(matchesFilter))).map((biz) =>
                          renderBizButton(biz),
                        )}
                      </div>
                    ))}
                    {businesses.length === 0 && (
                      <p className="px-1 sm:px-3 py-2 text-[10px] text-slate-500">
                        No businesses in this view yet.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    {capUnits(sortUnits(navBusinesses.filter(matchesFilter))).map((biz) =>
                      renderBizButton(biz),
                    )}
                    {!collapsed && navBusinesses.filter(matchesFilter).length === 0 && (
                      <p className="px-1 py-2 text-[10px] text-slate-500">
                        No unit matches “{bizFilter}”.
                      </p>
                    )}
                  </>
                )}
              </div>
              {!collapsed && navBusinesses.length > UNIT_PREVIEW && !bizFilter.trim() && (
                <div className="mt-1 flex items-center gap-2">
                  <button
                    onClick={() => setShowAllUnits((v) => !v)}
                    data-testid="nav-biz-show-all"
                    aria-expanded={showAllUnits}
                    className="flex items-center gap-1 px-1 py-1 text-[10px] font-bold text-emerald-300 hover:text-emerald-200 rounded"
                  >
                    <Building2 className="w-3 h-3 shrink-0" />
                    {showAllUnits ? "Show fewer" : `Show all ${navBusinesses.length} units`}
                  </button>
                  {!bizFilterOpen && navBusinesses.length <= 8 && (
                    <button
                      onClick={() => setBizFilterOpen(true)}
                      data-testid="nav-biz-filter-open"
                      className="ml-auto px-1 py-1 text-[10px] text-slate-400 hover:text-slate-200 rounded"
                    >
                      Filter
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* WORKER workspace note — all tools live in the Sales Workspace tabs */}
        {isWorker && (
          <div className="px-2 sm:px-3 py-2 border-b border-slate-800/70">
            <div className="px-1 sm:px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              My Sales Workspace
            </div>
            <div className="space-y-1 mt-1">
              <div className="px-2 sm:px-3 py-2 rounded-lg bg-slate-800/60 border border-slate-700/50 text-[11px] text-slate-400 leading-relaxed">
                Use the workspace tabs to record sales, receive payments, add customers, view branch
                inventory, and track your activity.
              </div>
            </div>
          </div>
        )}

        {/* ── SECTIONED DESTINATIONS (manifest-driven) ──────────────── */}
        {sections.map(({ group, entries: rows }) => {
          const open = sectionOpen(group.key) || forceOpen(group.key);
          let hubKey: string | null = null;
          return (
            <div key={group.key} className="px-2 sm:px-3 py-2 border-b border-slate-800/70">
              <button
                onClick={() => toggleSection(group.key)}
                data-testid={`nav-section-${group.key}`}
                aria-expanded={open}
                aria-controls={`nav-body-${group.key}`}
                title={group.hint}
                className="w-full flex items-center gap-1.5 px-1 sm:px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-200 transition"
              >
                <ChevronDown
                  className={`w-3 h-3 shrink-0 transition-transform ${open ? "" : "-rotate-90"} ${
                    collapsed ? "mx-auto" : ""
                  }`}
                />
                {!collapsed && <span className="truncate">{group.label}</span>}
                {!collapsed && (
                  <span className="ml-auto text-[9px] font-bold text-slate-500 shrink-0">
                    {rows.length}
                  </span>
                )}
              </button>
              <div
                id={`nav-body-${group.key}`}
                className={
                  open
                    ? "space-y-1 mt-1 transition-all duration-200"
                    : "max-h-0 opacity-0 pointer-events-none overflow-hidden transition-all duration-200"
                }
              >
                {rows.map((e) => {
                  const nodes: React.ReactNode[] = [];
                  if (e.hub && hubKey !== e.hub.key) {
                    hubKey = e.hub.key;
                    const hubFirst = rows.find((r) => r.hub?.key === e.hub!.key);
                    // The heading is a real shortcut to the hub's first tab —
                    // it used to be an inert label over two destinations, so
                    // tapping "Orders & Fulfilment" did nothing.
                    nodes.push(
                      <button
                        key={`hub-${e.hub.key}`}
                        onClick={() => hubFirst && runRow(hubFirst)}
                        data-testid={`nav-hub-${e.hub.key}`}
                        aria-label={e.hub.label}
                        title={e.hub.label}
                        className="w-full flex items-center gap-1.5 px-1 sm:px-3 pt-1.5 pb-0.5 text-[10px] font-black tracking-wide text-slate-500 hover:text-slate-300 transition"
                      >
                        <e.hub.Icon className="w-3 h-3 shrink-0" />
                        <span className="truncate">{collapsed ? "" : e.hub.label}</span>
                      </button>,
                    );
                  }
                  nodes.push(renderRow(e, { indented: !!e.hub }));
                  return <React.Fragment key={e.id}>{nodes}</React.Fragment>;
                })}
              </div>
            </div>
          );
        })}

        {/* Footer — one compact status line (was two lines + a duplicate row) */}
        <div className="mt-auto p-2 sm:p-3 border-t border-slate-800/80 bg-slate-950/60">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
            <span className="text-slate-300 font-medium truncate">Command Center Active</span>
            {!collapsed && (
              <span className="ml-auto text-slate-500 shrink-0 hidden sm:inline">GH₵ · multi-branch</span>
            )}
          </div>
        </div>
      </aside>

      {/* Phone/tablet bottom bar — Home · Actions · Sell · Search · Menu.
          (Kept out of the aside so the rail itself never has to be open.) */}
      {bottomBar}
    </>
  );
}
