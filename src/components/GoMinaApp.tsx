"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Navbar from "./Navbar";
import LoginScreen from "./LoginScreen";
import Sidebar, { ActiveTab } from "./Sidebar";
import CommandPalette from "./nav/CommandPalette";
import OrdersFulfilmentHub from "./OrdersFulfilmentHub";
import { navCtx, defaultTabFor } from "@/lib/navManifest";
import ContextNavigator, { ContextBar } from "./ContextNavigator";
import NotificationBell from "./NotificationBell";
import PushNotifications from "./PushNotifications";
import IdleLogout from "./IdleLogout";
import {
  applyCurrencyRates,
  cacheCurrencyRates,
  CurrencyCode,
  normalizeCurrencyCode,
  readCachedCurrencyRates,
  readStoredCurrencyCode,
  storeCurrencyCode,
} from "@/lib/currency";
import { isSeededBaselineTxn } from "@/lib/financeReport";
import { getOfflineQueue } from "@/lib/offlineSync";
import { installSessionBridge, setSessionToken, clearSessionToken } from "@/lib/sessionBridge";
import { businessManageIdsOf, canSeeEnterpriseUsers, canSeeFinancials } from "@/lib/permissions";
import { lookupBellType, FALLBACK_TAB } from "@/lib/bellTypes";
import { Loader2 } from "lucide-react";
import { setCompanyLogo } from "@/lib/logos";
import { readCachedBranding, fetchBranding, withBranding } from "@/lib/brandingCache";
import dynamic from "next/dynamic";

const NewBusinessModal = dynamic(() => import("./NewBusinessModal"), { ssr: false });
const ManageBusinessesModal = dynamic(() => import("./ManageBusinessesModal"), { ssr: false });
const UserAccessConsole = dynamic(() => import("./UserAccessConsole"), { ssr: false });
const CustomerSupportModal = dynamic(() => import("./CustomerSupportModal"), { ssr: false });
const ChangePasswordModal = dynamic(() => import("./ChangePasswordModal"), { ssr: false });
const ProfilePhotoModal = dynamic(() => import("./ProfilePhotoModal"), { ssr: false });
const NotificationSettingsModal = dynamic(() => import("./NotificationSettingsModal"), { ssr: false });

/** Lazy module shells — the nine business modules and the heavy post-login
 *  views are code-split so the login page + Command Center paint without
 *  downloading every module's charts/tables up front. Each chunk loads on
 *  first use and is cached by the browser afterwards. */
function ModuleLoading() {
  return (
    <div className="flex items-center justify-center py-16 text-slate-400" data-testid="module-loading">
      <Loader2 className="w-5 h-5 animate-spin mr-2" />
      <span className="text-xs font-semibold">Loading module…</span>
    </div>
  );
}
const lazyMod = (loader: () => Promise<{ default: React.ComponentType<any> }>) =>
  dynamic(loader, { ssr: false, loading: () => <ModuleLoading /> });

const CommandCenterDashboard = lazyMod(() => import("./CommandCenterDashboard"));
const LivestockModule = lazyMod(() => import("./LivestockModule"));
const SharedEnterpriseModule = lazyMod(() => import("./SharedEnterpriseModule"));
const CustomerTrackingPanel = lazyMod(() => import("./CustomerTrackingPanel"));
const PreordersHubView = lazyMod(() => import("./PreordersHubView"));
const DocumentVaultPanel = lazyMod(() => import("./DocumentVaultPanel"));
const BiAssistantPanel = lazyMod(() => import("./BiAssistantPanel"));
const AiAdvisorView = lazyMod(() => import("./AiAdvisorView"));
const ScenarioPlannerView = lazyMod(() => import("./ScenarioPlannerView"));
const IntegrationsHubView = lazyMod(() => import("./IntegrationsHubView"));
const WorkerDashboard = lazyMod(() => import("./WorkerDashboard"));
const BranchManagerWorkerPanel = lazyMod(() => import("./BranchManagerWorkerPanel"));
const BranchManagerSalesView = lazyMod(() => import("./BranchManagerSalesView"));
const EnterpriseUserPanel = lazyMod(() => import("./EnterpriseUserPanel"));
const PlatformAdminPanel = lazyMod(() => import("./PlatformAdminPanel"));
const EnterpriseFinanceView = lazyMod(() => import("./EnterpriseFinanceView"));
const AuditCommandCenter = lazyMod(() => import("./AuditCommandCenter"));
const AdvisorConsole = lazyMod(() => import("./AdvisorConsole"));
const ActionCenter = lazyMod(() => import("./ActionCenter"));
const MyAuditIssues = lazyMod(() => import("./MyAuditIssues"));
const PoultryFarmModule = lazyMod(() => import("./PoultryFarmModule"));
const BlockFactoryModule = lazyMod(() => import("./BlockFactoryModule"));
const AquacultureModule = lazyMod(() => import("./AquacultureModule"));
const ElectronicsShopModule = lazyMod(() => import("./ElectronicsShopModule"));
const RestaurantKitchenModule = lazyMod(() => import("./RestaurantKitchenModule"));
const HardwareStoreModule = lazyMod(() => import("./HardwareStoreModule"));
const CarWashModule = lazyMod(() => import("./CarWashModule"));
const TelecomServicesModule = lazyMod(() => import("./TelecomServicesModule"));
const TransportModule = lazyMod(() => import("./TransportModule"));
const BoutiqueModule = lazyMod(() => import("./BoutiqueModule"));
const BusinessDashboardModule = lazyMod(() => import("./BusinessDashboardModule"));
const UniversalExportCenter = lazyMod(() => import("./UniversalExportCenter"));
import { OrgDirectoryProvider } from "@/components/OrgDirectoryContext";
import { myOrgIdOf } from "@/lib/businessScope";
import { isOrgexecRole, roleCategory } from "@/lib/roles";

/**
 * `loginRegistrationInvite` is resolved on the SERVER (`src/app/page.tsx`) from
 * the platform owner's login-page switch and passed straight through to the
 * sign-in gate. It is a plain boolean — the login page never fetches it, so the
 * gate keeps its static prerender and makes no extra request. Defaults to
 * hidden, so every other mount (`<GoMinaApp />` in tests/tools) is unaffected.
 */
export default function GoMinaApp({ loginRegistrationInvite = false }: { loginRegistrationInvite?: boolean } = {}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Application Data State
  const [businesses, setBusinesses] = useState<any[]>([]);
  const [accessibleIds, setAccessibleIds] = useState<number[] | null>(null);
  const [metrics, setMetrics] = useState<any[]>([]);
  const [usersList, setUsersList] = useState<any[]>([]);
  const [currentUser, setCurrentUser] = useState<any>(null);
  // Whether the signed-in user holds Supervisor / Auditor access (server
  // decides via /api/audit?meta=1 — OWNER always; managers per role; other
  // users only when an active Auditor grant exists).
  const [auditEligible, setAuditEligible] = useState(false);
  // Issue-workflow dashboards: the global bell summary (drives the
  // "issues need you" strip), the assignee inbox modal, and deep-link
  // focus targets for both workspaces.
  const [auditBell, setAuditBell] = useState({ unread: 0, openAssigned: 0 });
  const [myIssuesOpen, setMyIssuesOpen] = useState(false);
  const [myIssueFocus, setMyIssueFocus] = useState<number | null>(null);
  const [auditFocusIssue, setAuditFocusIssue] = useState<number | null>(null);
  // Deep-linking focus targets for notifications (approvals, tasks, orders, trackings)
  const [actionCenterFocusApprovalId, setActionCenterFocusApprovalId] = useState<number | null>(null);
  const [actionCenterFocusTaskId, setActionCenterFocusTaskId] = useState<number | null>(null);
  /** Platform request reference the review console must open + highlight. */
  const [platformRequestFocus, setPlatformRequestFocus] = useState<string | null>(null);
  const [trackingFocusCode, setTrackingFocusCode] = useState<string | null>(null);
  const [trackingFocusId, setTrackingFocusId] = useState<number | null>(null);
  const [customers, setCustomers] = useState<any[]>([]);
  const [creditSales, setCreditSales] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const [assets, setAssets] = useState<any[]>([]);
  const [inventory, setInventory] = useState<any[]>([]);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [aiInsights, setAiInsights] = useState<any[]>([]);
  const [scenarios, setScenarios] = useState<any[]>([]);
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [checklistData, setChecklistData] = useState<{ templates: any[]; entries: any[] }>({ templates: [], entries: [] });
  // Farm Advisor per-section visibility: businessId → section list (null =
  // all). Present only in advisor sessions (stripped from everyone else's
  // /api/init payload); drives the read-only modules' tab/panel filtering.
  const [advisorSections, setAdvisorSections] = useState<Record<string, string[] | null>>({});
  const [specializedLogs, setSpecializedLogs] = useState<Record<string, any[]>>({
    poultry: [],
    blockFactory: [],
    aquaculture: [],
    livestock: [],
    restaurant: [],
    electronics: [],
    carWash: [],
    hardware: [],
  });

  // UI States
  const [activeTab, setActiveTab] = useState<ActiveTab>("COMMAND_CENTER");

  // Unit codes are unique PER ORGANIZATION, not globally — a super admin
  // spanning two organizations can see two POULTRY-01 units. Remember which
  // business a card click actually opened so code-keyed tab lookups prefer
  // it over the first same-code match.
  const lastOpenedBizIdRef = useRef<number | null>(null);
  const handleSelectTab = (tab: ActiveTab, bizId?: number | null) => {
    if (bizId) lastOpenedBizIdRef.current = Number(bizId);
    setActiveTab(tab);
  };
  const [currentCurrency, setCurrentCurrencyState] = useState<CurrencyCode>("GHS");
  const [, setCurrencyRatesVersion] = useState(0);
  const setCurrentCurrency = useCallback((code: CurrencyCode) => {
    const normalized = normalizeCurrencyCode(code);
    setCurrentCurrencyState(normalized);
    storeCurrencyCode(normalized);
  }, []);
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [offlineQueueCount, setOfflineQueueCount] = useState<number>(0);
  const [isNewBusinessModalOpen, setIsNewBusinessModalOpen] = useState(false);
  const [isManageBizOpen, setIsManageBizOpen] = useState(false);
  // Deep-link target when opened from the navbar "Online storefront & delivery
  // areas" entry (branch managers land straight on their own unit's panel).
  const [manageBizOnlineId, setManageBizOnlineId] = useState<number | null>(null);
  // Right-side navigation & "you are here" panel — drawer below xl.
  const [contextNavOpen, setContextNavOpen] = useState(false);
  // Left navigation: off-canvas drawer below lg + command palette (⌘K).
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [isUserAccessOpen, setIsUserAccessOpen] = useState(false);
  const [isSupportOpen, setIsSupportOpen] = useState(false);
  // Bell → gear opens phone/laptop (Web Push) notification settings.
  const [isNotifSettingsOpen, setIsNotifSettingsOpen] = useState(false);
  // Self-service password change (account menu → Change Password).
  const [isChangePwOpen, setIsChangePwOpen] = useState(false);
  // Self-service profile photo (account menu → My Profile Photo).
  const [isProfilePhotoOpen, setIsProfilePhotoOpen] = useState(false);
  // Allowed Business Types of the caller's organization (Super-Admin-managed
  // in the platform console): the create-modal and the category editor only
  // ever offer these. restricted=false ⇒ every (current & future) type.
  const [bizTypeAccess, setBizTypeAccess] = useState<{
    restricted: boolean;
    types: { key: string; label: string }[];
  } | null>(null);
  // Super Admin platform org directory ({id,name,slug,status}) — labels &
  // filters for the cross-owner "Manage Businesses & Branches" view.
  const [orgDirectory, setOrgDirectory] = useState<
    { id: number; name: string; slug: string; status: string }[]
  >([]);
  // ── Organization Lens (SUPER ADMIN ONLY) ─────────────────────────────
  // The intentional "whose data am I looking at" context:
  //   "MY"   → the Main Owner's own workspace (org 1) — the NORMAL
  //             operational view (default; looks exactly like any Owner's).
  //   "ALL"  → platform-wide oversight: every org fused, with per-org
  //             rollups & grouped business lists.
  //   "<id>" → a single Owner/Organization.
  // Normal Owners never see the lens and their views are byte-identical.
  const [orgLens, setOrgLens] = useState<string>("MY");
  const isSuperAdminUser = !!currentUser?.isSuperAdmin;
  const lensOrgId: number | null = !isSuperAdminUser
    ? null
    : orgLens === "ALL"
      ? null
      : orgLens === "MY"
        ? 1
        : Number(orgLens);
  // Everything is scoped client-side over the already-loaded payload (the
  // server contract — Super Admin ⇒ full payload — never changes).
  const bizOwnerOf = useMemo(
    () => new Map(businesses.map((b: any) => [Number(b.id), Number(b?.ownerId ?? 1)])),
    [businesses]
  );
  const lensScope = useMemo(
    () => (rows: any[]) => {
      if (lensOrgId == null) return rows;
      return rows.filter((r: any) => {
        if (r?.ownerId != null) return Number(r.ownerId) === lensOrgId;
        if (r?.businessId != null) return (bizOwnerOf.get(Number(r.businessId)) ?? 1) === lensOrgId;
        return true; // org-agnostic row (settings etc.)
      });
    },
    [lensOrgId, bizOwnerOf]
  );
  // FINANCIAL SURFACE (component scope): money may only be DERIVED for the
  // OWNER, the platform Super Admin or an OWNER-authorised viewer. The flag is
  // read by liveMetrics (which otherwise re-derives revenue from the ledger and
  // would defeat the server-side trimming) and by the render gates below.
  const financialsAuthorized = canSeeFinancials(currentUser);
  const scopedBusinesses = useMemo(() => lensScope(businesses), [lensScope, businesses]);
  const scopedMetrics = useMemo(() => lensScope(metrics), [lensScope, metrics]);
  const scopedCustomers = useMemo(() => lensScope(customers), [lensScope, customers]);
  const scopedCreditSales = useMemo(() => lensScope(creditSales), [lensScope, creditSales]);
  const scopedSuppliers = useMemo(() => lensScope(suppliers), [lensScope, suppliers]);
  const scopedEmployees = useMemo(() => lensScope(employees), [lensScope, employees]);
  const scopedAssets = useMemo(() => lensScope(assets), [lensScope, assets]);
  const scopedInventory = useMemo(() => lensScope(inventory), [lensScope, inventory]);
  const scopedTransactions = useMemo(() => lensScope(transactions), [lensScope, transactions]);
  const scopedAiInsights = useMemo(() => lensScope(aiInsights), [lensScope, aiInsights]);
  const scopedScenarios = useMemo(() => lensScope(scenarios), [lensScope, scenarios]);
  const scopedIntegrations = useMemo(() => lensScope(integrations), [lensScope, integrations]);
  const scopedUsers = useMemo(
    () =>
      lensOrgId == null
        ? usersList
        : usersList.filter(
            (u: any) =>
              Number(u?.primaryOrgId ?? 1) === lensOrgId ||
              (Array.isArray(u?.organizationIds) && u.organizationIds.map(Number).includes(lensOrgId))
          ),
    [usersList, lensOrgId]
  );
  const scopedChecklistData = useMemo(
    () => ({ templates: lensScope(checklistData.templates || []), entries: lensScope(checklistData.entries || []) }),
    [lensScope, checklistData]
  );
  const scopedSpecializedLogs = useMemo(
    () => Object.fromEntries(Object.entries(specializedLogs).map(([k, v]) => [k, lensScope(v as any[])])),
    [lensScope, specializedLogs]
  );
  const activeLensOrgName =
    orgLens === "MY"
      ? orgDirectory.find((o) => Number(o.id) === 1)?.name || "GoMina Group"
      : orgLens === "ALL"
        ? "All Organizations"
        : orgDirectory.find((o) => Number(o.id) === Number(orgLens))?.name || `Organization #${orgLens}`;
  // Switching the lens while a now-hidden business dashboard is open:
  // return to the Command Center of the new scope. KEY: only a BUSINESS
  // dashboard tab (its code was visible under the previous scope and is
  // hidden now) may be reset — shared enterprise views (EMPLOYEES, FINANCE,
  // CUSTOMERS, …) and platform views must NEVER be bounced out by a routine
  // data refresh, which re-creates the scopedBusinesses array identity on
  // every /api/init fetch and used to kick the user back to Command Center
  // mid-work (e.g. right after registering an employee).
  const scopedCodesKey = useMemo(
    () => scopedBusinesses.map((b: any) => b?.code).filter(Boolean).join("|"),
    [scopedBusinesses]
  );
  const prevScopedCodesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const codes = new Set(scopedCodesKey ? scopedCodesKey.split("|") : []);
    if (
      isSuperAdminUser &&
      activeTab !== "COMMAND_CENTER" &&
      prevScopedCodesRef.current.has(activeTab) &&
      !codes.has(activeTab)
    ) {
      setActiveTab("COMMAND_CENTER");
    }
    prevScopedCodesRef.current = codes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lensOrgId, scopedCodesKey, isSuperAdminUser]);
  // Secure-session state (declared with the other UI state so the data
  // refresh callback below can safely bounce a dead session to sign-in).
  const [signedIn, setSignedIn] = useState(false);
  // One-line explanation shown on the sign-in screen when a login POST
  // succeeded but the browser refused to keep the session cookie.
  const [loginNotice, setLoginNotice] = useState("");

  // Seeded ledger watermark: the highest id among the TRX-<year>-1001..1006
  // rows the Q1-2026 quarterly metrics ALREADY contain (see financeReport's
  // isSeededBaselineTxn). Every transaction above it is real live activity and
  // must layer onto the seeded quarter — across sessions, not only in-session.
  const baselineMaxTxnId = useRef<number | null>(null);

  // In-flight refresh dedupe: multiple components calling onChanged ->
  // refreshAllData in one burst used to fan out N identical /api/init
  // requests. Everyone shares the single in-flight refresh instead.
  const refreshInFlight = useRef<Promise<"ok" | "unauthorized" | "error"> | null>(null);

  const refreshAllData = useCallback(async (): Promise<"ok" | "unauthorized" | "error"> => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const run = (async (): Promise<"ok" | "unauthorized" | "error"> => {
    try {
      const res = await fetch("/api/init");
      // Session gone (expired, revoked by the OWNER, or the server/database
      // was redeployed): NEVER strand the user on a dead-end "Connection
      // Notice — Sign in required" panel. Bounce straight back to the
      // sign-in screen so they can re-authenticate cleanly.
      if (res.status === 401) {
        setSignedIn(false);
        setCurrentUser(null);
        setError(null);
        return "unauthorized";
      }
      const data = await res.json();
      if (data.success) {
        setSignedIn(true);
        // A healthy response must clear any previously displayed error —
        // otherwise a stale notice would keep covering the working app.
        setError(null);
        // Branding (company crest + business logos) rides its own versioned
        // channel: the payload carries a content hash, /api/branding serves
        // the blobs with ETag + browser caching, and this localStorage mirror
        // makes the common path (logos unchanged) ZERO extra network. A
        // version mismatch (logo uploaded) triggers exactly one fetch.
        const brandingVersion = typeof data.brandingVersion === "string" ? data.brandingVersion : null;
        const cachedBranding = readCachedBranding(brandingVersion);
        setBusinesses((data.businesses || []).map((b: any) => withBranding(b, cachedBranding)));
        // Server-vetted access scope (null ⇒ OWNER/unrestricted) — drives the
        // sidebar's granted-branch dashboard chips.
        setAccessibleIds(Array.isArray(data.accessibleBusinessIds) ? data.accessibleBusinessIds : null);
        setCompanyLogo(cachedBranding?.companyLogo || null);
        if (brandingVersion && !cachedBranding) {
          fetchBranding().then((b) => {
            if (!b) return;
            setCompanyLogo(b.companyLogo || null);
            setBusinesses((prev: any[]) => prev.map((x: any) => withBranding(x, b)));
          });
        }
        setMetrics(data.metrics || []);
        setUsersList(data.users || []);
        // Keep the signed-in user object in sync with freshly fetched rows
        // (permission changes apply instantly). /api/init also carries the
        // server-resolved currentUser so returning users no longer need a
        // separate /api/auth/me round trip before the dashboard bootstrap.
        setCurrentUser((prev: any) => {
          const identity = prev || data.currentUser;
          if (!identity) return prev;
          const fresh = (data.users || []).find((u: any) => u.id === identity.id) || data.currentUser;
          return fresh ? { ...fresh } : prev;
        });
        setCustomers(data.customers || []);
        setCreditSales(data.creditSales || []);
        // Per-Owner Allowed Business Types + (Super Admin) org directory.
        setBizTypeAccess(data.allowedBusinessTypes || null);
        setOrgDirectory(Array.isArray(data.organizations) ? data.organizations : []);
        setSuppliers(data.suppliers || []);
        setEmployees(data.employees || []);
        setAssets(data.assets || []);
        setInventory(data.inventory || []);
        const txns = data.transactions || [];
        if (baselineMaxTxnId.current === null) {
          // Watermark = last seeded ledger row (already inside the quarterly
          // metrics). Everything above it is live activity and always counts.
          baselineMaxTxnId.current = txns.reduce(
            (mx: number, t: any) =>
              isSeededBaselineTxn(t) ? Math.max(mx, t.id || 0) : mx,
            0
          );
        }
        setTransactions(txns);
        setAiInsights(data.aiInsights || []);
        setScenarios(data.scenarios || []);
        setIntegrations(data.integrations || []);
        setChecklistData(data.checklists || { templates: [], entries: [] });
        setAdvisorSections(data.advisorSections || {});
        setSpecializedLogs(
          data.specializedLogs || {
            poultry: [],
            blockFactory: [],
            aquaculture: [],
            livestock: [],
            restaurant: [],
            electronics: [],
            carWash: [],
            hardware: [],
          }
        );
        return "ok";
      } else {
        setError(data.error || "Failed to load enterprise data.");
      }
    } catch (err: any) {
      setError(err.message || "Failed to connect to Command Center.");
    } finally {
      setLoading(false);
      setOfflineQueueCount(getOfflineQueue().length);
    }
    return "error";
    })();
    refreshInFlight.current = run;
    const result = await run;
    refreshInFlight.current = null;
    return result;
  }, []);

  // Attach the bearer-token channel to every /api fetch before ANY fetch can
  // fire (the cookie stays primary; the header saves embedded contexts whose
  // browsers block third-party cookie storage).
  useEffect(() => { installSessionBridge(); }, []);
  // Operating-currency rates: financial records remain stored in GHS.  Local
  // cache is applied immediately on page load; the network refresh waits until
  // a signed-in dashboard actually needs it so the public login/storefront path
  // does not cold-start the currency API unnecessarily.
  useEffect(() => {
    const storedCode = readStoredCurrencyCode();
    if (storedCode) setCurrentCurrencyState(storedCode);

    const cached = readCachedCurrencyRates();
    if (cached?.rates && applyCurrencyRates(cached.rates)) {
      setCurrencyRatesVersion((v) => v + 1);
    }
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    const controller = new AbortController();
    fetch("/api/currency/rates", { cache: "no-store", signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((payload) => {
        if (!payload?.rates) return;
        cacheCurrencyRates(payload);
        if (applyCurrencyRates(payload.rates)) setCurrencyRatesVersion((v) => v + 1);
      })
      .catch(() => {
        // Non-blocking: fallback rates remain active.
      });
    return () => controller.abort();
  }, [signedIn]);

  // Presence heartbeat — powers the live ONLINE chip in Signed-In Staff.
  // Beat "active" on sign-in/page-show/visibility-return; park the session
  // (without ending it) when the page is hidden/unloaded — sendBeacon keeps
  // the beat reliable even as the tab is closing. Any later real request
  // automatically un-parks server-side, so presence can never get stuck.
  useEffect(() => {
    if (!currentUser?.id || !signedIn) return;
    const beat = (active: boolean) => {
      try {
        const payload = JSON.stringify({ active });
        if (!active && typeof navigator !== "undefined" && navigator.sendBeacon) {
          navigator.sendBeacon("/api/session/heartbeat", new Blob([payload], { type: "application/json" }));
        } else {
          fetch("/api/session/heartbeat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
            keepalive: true,
          }).catch(() => {});
        }
      } catch { /* presence is best-effort */ }
    };
    beat(true);
    const onShow = () => beat(true);
    const onHide = () => { if (document.visibilityState === "hidden") beat(false); };
    const onPageHide = () => beat(false);
    window.addEventListener("pageshow", onShow);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pageshow", onShow);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [currentUser?.id, signedIn]);

  // ── Secure login bootstrap ──────────────────────────────────────────────
  // Identity comes from the server session (httpOnly cookie). No session →
  // the app renders the sign-in screen and fetches NOTHING else.
  useEffect(() => {
    (async () => {
      const status = await refreshAllData();
      if (status === "ok") {
        setSignedIn(true);
      } else {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLoginSuccess = async (user: any, sessionToken?: string) => {
    setError(null);
    setLoginNotice("");
    if (sessionToken) setSessionToken(sessionToken);
    setLoading(true);
    setCurrentUser(user);
    setSignedIn(true);
    baselineMaxTxnId.current = null;
    const status = await refreshAllData();
    if (status === "unauthorized") {
      // The login POST succeeded but the very next authenticated call came
      // back 401: the browser refused to store/send the session cookie
      // (third-party-cookie policy on an embedded/iframe preview). Do NOT
      // just blink back to a silent sign-in — explain precisely what to do.
      setSignedIn(false);
      setCurrentUser(null);
      setLoginNotice(
        "Signed in, but your browser would not keep the session cookie, so the session ended immediately. Allow cookies for this site (including third-party cookies when the app is embedded) — or open the app in its own browser tab — then sign in again."
      );
    }
  };

  // ── Deep links & idle auto-logout ────────────────────────────────────────
  // Push-notification clicks land on /?tab=… . The click may arrive while
  // signed out (login wall), so we park the requested workspace and jump as
  // soon as the session is confirmed.
  const pendingTabRef = useRef<string | null>(null);
  const pendingPlatformRequestRef = useRef<string | null>(null);
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const t = params.get("tab");
      if (t) pendingTabRef.current = t;
      // A push-notification click carries the platform request reference so the
      // console opens with THAT request expanded, not an unfiltered queue.
      const req = params.get("request");
      if (req) pendingPlatformRequestRef.current = req;
    } catch { /* non-browser env */ }
  }, []);
  // The pending tab is consumed by the role-landing effect below (the single
  // place that decides the landing workspace whenever the user loads).

  // 24 hours without any real user interaction (mouse/keyboard/touch/
  // scroll) ends the session exactly like a manual sign-out, with a clear
  // explanation on the sign-in screen.
  const handleIdleLogout = useCallback(async () => {
    try {
      await fetch("/api/session/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
        keepalive: true,
      });
    } catch { /* best effort */ }
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch { /* best effort */ }
    clearSessionToken();
    setSignedIn(false);
    setCurrentUser(null);
    setActiveTab("COMMAND_CENTER");
    setLoginNotice("You were signed out automatically after 24 hours of inactivity. Sign in again to continue.");
  }, []);

  const handleLogout = async () => {
    // Park the presence beat FIRST (session still valid), so the Signed-In
    // Staff board flips offline deterministically; the logout POST then
    // soft-ends the session row — that end time becomes "last logout".
    try {
      await fetch("/api/session/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
        keepalive: true,
      });
    } catch { /* best effort */ }
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch { /* best effort */ }
    clearSessionToken();
    setSignedIn(false);
    setCurrentUser(null);
    setLoginNotice("");
    setActiveTab("COMMAND_CENTER");
  };

  // Live metrics: seeded quarter-to-date baseline + ALL live ledger rows
  // (sales, expenses, stock-ins — from every session and device) + the live
  // sum of registered asset values per business. Keeps every dashboard
  // accurate and automatically in sync whenever activity is recorded.
  const liveMetrics = useMemo(() => {
    const baseId = baselineMaxTxnId.current ?? 0;

    // Sum current asset value grouped by businessId
    const assetValueByBiz: Record<number, number> = {};
    for (const a of scopedAssets) {
      const bid = a.businessId;
      if (bid === undefined || bid === null) continue;
      assetValueByBiz[bid] = (assetValueByBiz[bid] || 0) + (a.currentValueGhs || 0);
    }

    // Units created after the quarterly close have no business_metrics row:
    // synthesise an honest zero baseline so their live transactions still
    // layer onto dashboards like every other unit.
    const metricRows: any[] = scopedMetrics.slice();
    for (const b of scopedBusinesses || []) {
      if (b?.id == null) continue;
      if (!metricRows.some((m) => m.businessId === b.id)) {
        metricRows.push({
          businessId: b.id,
          period: "LIVE",
          revenueGhs: 0,
          expensesGhs: 0,
          netProfitGhs: 0,
          roiPercent: 0,
          cashFlowGhs: 0,
          assetsValueGhs: 0,
          inventoryValueGhs: 0,
          growthRatePercent: 0,
          riskScore: 0,
        });
      }
    }

    return metricRows.map((m) => {
      // Unauthorised viewer: the server already withheld every monetary figure
      // in business_metrics. Do NOT re-derive them from the operational ledger
      // (assets/transactions) here — that would rebuild the exact P&L this
      // surface is meant to withhold.
      if (!financialsAuthorized) {
        return {
          ...m,
          revenueGhs: 0,
          expensesGhs: 0,
          netProfitGhs: 0,
          cashFlowGhs: 0,
          roiPercent: 0,
          assetsValueGhs: 0,
          inventoryValueGhs: 0,
          growthRatePercent: 0,
          financialsRestricted: true,
          baselineTxId: baseId,
        };
      }

      // Live asset value: prefer the sum of registered assets when available;
      // fall back to the seeded metric so the number is never blank.
      const liveAssetsValue = assetValueByBiz[m.businessId] || m.assetsValueGhs;

      // Overlay = every live transaction (id above the seeded watermark),
      // not only the ones recorded inside this browser session.
      const newTx = scopedTransactions.filter(
        (t) => t.businessId === m.businessId && (t.id || 0) > baseId && !isSeededBaselineTxn(t)
      );
      const income = newTx
        .filter((t) => t.type === "INCOME")
        .reduce((a, t) => a + (t.amountGhs || 0), 0);
      const expense = newTx
        .filter((t) => t.type === "EXPENSE")
        .reduce((a, t) => a + (t.amountGhs || 0), 0);

      const revenueGhs = m.revenueGhs + income;
      const expensesGhs = m.expensesGhs + expense;
      const netProfitGhs = revenueGhs - expensesGhs;
      const cashFlowGhs = m.cashFlowGhs + income - expense;
      const roiPercent =
        liveAssetsValue > 0
          ? Number(((netProfitGhs / liveAssetsValue) * 100).toFixed(1))
          : m.roiPercent;
      return {
        ...m,
        assetsValueGhs: liveAssetsValue,
        revenueGhs,
        expensesGhs,
        netProfitGhs,
        cashFlowGhs,
        roiPercent,
        // Lets the shared Financial Report recover the seeded Q1-2026 baseline
        // hidden inside this blended row (baselineTxId = highest txn id present
        // at session load, i.e. everything seeded/prior-session).
        baselineTxId: baseId,
      };
    });
  }, [scopedMetrics, scopedTransactions, scopedAssets, scopedBusinesses, financialsAuthorized]);

  // Reset to a role-appropriate landing tab whenever the active user changes.
  // Prevents a lower-privilege user from inheriting an executive tab (data leak).
  // A pending deep link (push-notification click: /?tab=…) takes precedence —
  // it is the exact workspace the user asked to open.
  useEffect(() => {
    if (!currentUser) return;
    if (pendingPlatformRequestRef.current) {
      // Park the request BEFORE switching tabs: the console reads the focus
      // value as soon as it mounts, so it must already be set.
      setPlatformRequestFocus(pendingPlatformRequestRef.current);
      pendingPlatformRequestRef.current = null;
    }
    if (pendingTabRef.current) {
      setActiveTab(pendingTabRef.current as ActiveTab);
      pendingTabRef.current = null;
      return;
    }
    // Registry-owned landing tab (src/lib/navManifest.ts defaultTabFor): unit
    // leads/specialists open their unit register, the advisor opens the
    // console, executives open HQ, shop floor renders its own dashboard.
    setActiveTab(defaultTabFor(currentUser) as ActiveTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id]);

  // Supervisor & Auditor eligibility — the server decides (OWNER always;
  // supervisor roles inside their business scope; everyone else only while an
  // active Auditor grant exists). Recomputed whenever the signed-in user changes.
  useEffect(() => {
    setAuditEligible(false);
    if (!currentUser?.id) return;
    fetch("/api/audit?meta=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAuditEligible(!!d?.eligible))
      .catch(() => setAuditEligible(false));
  }, [currentUser?.id]);

  const handleRefreshLogsForBusiness = async (businessCode: string) => {
    try {
      const res = await fetch(`/api/logs/${businessCode}`);
      const data = await res.json();
      if (data.success) {
        const upper = businessCode.toUpperCase();
        // Merge by businessId: replace ONLY the refreshed unit's rows inside
        // its type bucket, leaving every other same-type unit's logs intact
        // (buckets are shared per type, e.g. WASH-01 and WASH-02 → carWash).
        const bucket = upper.startsWith("POULTRY")
          ? "poultry"
          : upper.startsWith("BLOCK")
          ? "blockFactory"
          : upper.startsWith("AQUA")
          ? "aquaculture"
          : upper.startsWith("LIVESTOCK")
          ? "livestock"
          : upper.startsWith("FOOD")
          ? "restaurant"
          : upper.startsWith("TECH")
          ? "electronics"
          : upper.startsWith("WASH")
          ? "carWash"
          : upper.startsWith("HARDWARE")
          ? "hardware"
          : null;
        setSpecializedLogs((prev) => {
          if (!bucket) return prev;
          return {
            ...prev,
            [bucket]: [
              ...(prev[bucket] || []).filter((r: any) => r.businessId !== data.businessId),
              ...(data.logs || []),
            ],
          };
        });
      }
      setOfflineQueueCount(getOfflineQueue().length);
    } catch (err) {
      console.error("Error refreshing logs:", err);
    }
  };

  // One handler for "Online Storefront & Delivery Areas" — used by the navbar
  // account menu, the left rail's Settings section and the command palette.
  const openOnlineOrdering = useCallback(() => {
    if (!(currentUser?.role === "OWNER" || !!currentUser?.canManageOnline)) return;
    const preset =
      currentUser?.role === "BRANCH_MANAGER"
        ? currentUser?.assignedBusinessId ?? null
        : businesses.length === 1
          ? scopedBusinesses[0]?.id ?? null
          : null;
    setManageBizOnlineId(preset);
    setIsManageBizOpen(true);
  }, [currentUser, businesses.length, scopedBusinesses]);

  // ONE navigation context for the rail, the palette and the right rail —
  // eligibility can never drift between surfaces again.
  const navContext = useMemo(
    () =>
      navCtx(currentUser, {
        isUnitManager: businessManageIdsOf(currentUser).length > 0,
        auditEligible,
        hasSupportEditor: true,
        hasManageBusinesses: true,
        hasOnlineOrdering: currentUser?.role === "OWNER" || !!currentUser?.canManageOnline,
        advisorCount: usersList.some((u: any) => u?.role === "FARM_ADVISOR") ? 1 : 0,
      }),
    [currentUser, auditEligible, usersList],
  );

  // ⌘K / Ctrl-K (and "/" outside a text field) opens the command palette.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if ((ev.key === "k" || ev.key === "K") && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (ev.key === "/" && !typing && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        ev.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const runPaletteAction = (action: "support" | "manageUnits" | "onlineOrdering") => {
    if (action === "support") setIsSupportOpen(true);
    else if (action === "manageUnits") {
      setManageBizOnlineId(null);
      setIsManageBizOpen(true);
    } else if (action === "onlineOrdering") openOnlineOrdering();
  };

  const renderActiveView = () => {
    // Registry-owned: a Co-Owner/GM is an executive by definition, and no other
    // role can be (audit finding F4: hand-written role triples).
    const isExecutive = isOrgexecRole(currentUser?.role);
    // Sensitive surfaces — never implied by role. OWNER/Super Admin, or the
    // OWNER's explicit grant. See src/lib/permissions.ts.
    const maySeeEnterpriseUsers = canSeeEnterpriseUsers(currentUser);
    const maySeeFinancials = financialsAuthorized;
    // Deep links from the branch workspace into the canonical enterprise modules
    // (Customers & CRM / Inventory & Stock) are offered whenever the module guard
    // below would let that user open them.
    const canOpenEnterpriseModules = isExecutive || businessManageIdsOf(currentUser).length > 0;
    const isBranchManager = currentUser?.role === "BRANCH_MANAGER";
    // Registry category — Supervisor & Accountant work one unit, same as a BM.
    const unitSpecialist = roleCategory(currentUser?.role) === "UNIT_SPECIALIST";

    // ── Farm Advisor workspace ─────────────────────────────────────────
    // The external advisor sees exactly two things: their Advisor Console
    // and the farm units the OWNER granted them (rendered by the SAME
    // module dispatch as everyone else, in read-only advisor mode). Any
    // other tab — including deep links to executive surfaces — falls back
    // to the console, so the advisor's workspace is a closed sandbox.
    if (currentUser?.role === "FARM_ADVISOR") {
      const unitTab = scopedBusinesses.some((b: any) => b?.code === activeTab);
      if (activeTab === "ADVISOR" || !unitTab) {
        return (
          <AdvisorConsole
            mode="advisor"
            currentUser={currentUser}
            businesses={scopedBusinesses}
            onSelectTab={(code: string) => handleSelectTab(code as ActiveTab)}
          />
        );
      }
      // unit tab → fall through to the shared module dispatch below
    } else if (activeTab === "ADVISOR") {
      // OWNER / GENERAL_MANAGER: the Farm Advisor access & guidance console.
      // (Delegated managers reach it only with the canManageUsers grant —
      // the API enforces that; other roles see the restricted notice.)
      return (
        <AdvisorConsole
          mode={isExecutive || currentUser?.canManageUsers ? "manage" : "advisor"}
          currentUser={currentUser}
          businesses={scopedBusinesses}
          onSelectTab={(code: string) => handleSelectTab(code as ActiveTab)}
        />
      );
    }

    // Supervisor & Auditor Control Center — ASSIGNMENT-ONLY: takes precedence
    // over the WORKER / BRANCH_MANAGER workspace interception, because ANY
    // role may hold an Auditor grant (server-verified eligibility). No role
    // gets it by default — the OWNER or a delegated manager must assign it.
    // The API itself enforces exactly which businesses, branches and modules
    // each auditor may see.
    if (activeTab === "AUDIT") {
      const canAudit =
        auditEligible ||
        currentUser?.role === "OWNER" ||
        !!currentUser?.canManageAuditors;
      if (!canAudit) {
        return (
          <div className="flex items-center justify-center min-h-[60vh] p-8">
            <div className="bg-amber-900/20 border border-amber-500/30 rounded-2xl p-8 max-w-md text-center space-y-3">
              <h2 className="text-lg font-bold text-amber-300">Access Restricted</h2>
              <p className="text-sm text-slate-300">
                The Audit &amp; Review center is only available when the OWNER (or an authorized manager) assigns it to you — for the specific businesses, branches and modules in that assignment.
              </p>
            </div>
          </div>
        );
      }
      return (
        <AuditCommandCenter
          currentUser={currentUser}
          // The FULL accessible list (not lens-filtered): the Audit center's own
          // Owner control IS the Organization Lens for a Super Admin, so it must
          // be able to offer every owner — while starting on "My Workspace".
          businesses={businesses}
          organizations={orgDirectory}
          orgLens={orgLens}
          onLensChange={setOrgLens}
          currentCurrency={currentCurrency}
          focusIssueId={auditFocusIssue}
          onFocusHandled={() => setAuditFocusIssue(null)}
        />
      );
    }


    // ── Unified Action Center (P1) — available to EVERY role, rendered before
    // the worker/branch-manager workspace interception so workers and managers
    // can open their action list from the sidebar or a push notification.
    // The API scopes reads/writes per role (workers see their own assignments;
    // managers their units; executives their whole organization).
    if (activeTab === "ACTION_CENTER") {
      return (
        <ActionCenter
          currentUser={currentUser}
          businesses={scopedBusinesses}
          currentCurrency={currentCurrency}
          focusApprovalId={actionCenterFocusApprovalId}
          focusTaskId={actionCenterFocusTaskId}
          onFocusHandled={() => {
            setActionCenterFocusApprovalId(null);
            setActionCenterFocusTaskId(null);
          }}
          onSelectTab={(tab: string, opts?: { platformRequestRef?: string | null }) => {
            if (opts?.platformRequestRef) setPlatformRequestFocus(opts.platformRequestRef);
            handleSelectTab(tab as ActiveTab);
          }}
        />
      );
    }

    // WORKER role: self-contained workspace. All tools (record sale, create
    // customer, view branch inventory, my activity) live inside WorkerDashboard,
    // which is strictly scoped to the worker's own branch — no enterprise data.
    if (currentUser?.role === "WORKER") {
      const bizCode = scopedBusinesses.find((b) => b.id === currentUser?.assignedBusinessId)?.code;
      const bizInfo = scopedBusinesses.find((b) => b.id === currentUser?.assignedBusinessId);
      const bizMetric = liveMetrics.find((m) => m.businessId === bizInfo?.id);

      // Operations logs of the worker's OWN branch only — prefix-based so any
      // unit of the same type (original or created later) resolves correctly.
      const ownLogs = (bucket: any[]) =>
        bucket.filter((l: any) => !l.businessId || l.businessId === bizInfo?.id);
      const upperBiz = (bizCode || "").toUpperCase();
      let logs: any[] = [];
      if (upperBiz.startsWith("POULTRY")) logs = ownLogs(specializedLogs.poultry || []);
      else if (upperBiz.startsWith("BLOCK")) logs = ownLogs(specializedLogs.blockFactory || []);
      else if (upperBiz.startsWith("AQUA")) logs = ownLogs(specializedLogs.aquaculture || []);
      else if (upperBiz.startsWith("LIVESTOCK")) logs = ownLogs(specializedLogs.livestock || []);
      else if (upperBiz.startsWith("FOOD")) logs = ownLogs(specializedLogs.restaurant || []);
      else if (upperBiz.startsWith("TECH")) logs = ownLogs(specializedLogs.electronics || []);
      else if (upperBiz.startsWith("WASH")) logs = ownLogs(specializedLogs.carWash || []);
      else if (upperBiz.startsWith("HARDWARE")) logs = ownLogs(specializedLogs.hardware || []);

      return (
        <WorkerDashboard
          currentUser={currentUser}
          businessInfo={bizInfo}
          businessMetrics={bizMetric}
          specializedLogs={logs}
          inventory={scopedInventory}
          customers={scopedCustomers}
          transactions={scopedTransactions}
          currentCurrency={currentCurrency}
          isOnline={isOnline}
          onRefreshData={refreshAllData}
          onOpenActions={() => handleSelectTab("ACTION_CENTER")}
        />
      );
    }

    // BRANCH_MANAGER: strictly scoped to their own branch. Any attempt to reach an
    // executive/enterprise tab falls back to their branch Sales & Payments center.
    if (isBranchManager) {
      const ownBranch = scopedBusinesses.find((b) => b.id === currentUser?.assignedBusinessId);
      const allowed = new Set<string>([
        "BRANCH_SALES",
        "WORKERS_MANAGE",
        "BRANCH_ASSETS",
        "TRACKING", // Customer Order & Tracking register (scoped server-side to own branch)
      ]);
      // Pre-Orders hub: branch managers the OWNER granted "Manage Unit" power
      // get the same pre-order console (flag + offers stay server-scoped).
      if (businessManageIdsOf(currentUser).length > 0) allowed.add("PREORDERS");
      // Unified Action Center (P1): every branch manager tracks their own
      // assignments and their units' actions.
      allowed.add("ACTION_CENTER");
      // Managers the OWNER trusted with CCTV may open the Integrations Hub,
      // where the CCTV Command Center stays scoped to their authorised branches.
      if (currentUser?.canManageCctv) allowed.add("INTEGRATIONS");
      if (ownBranch?.code) allowed.add(ownBranch.code);
      // OWNER-granted branch dashboards ("Extra business access"): every code
      // inside the server-scoped business list is a dashboard this manager may
      // open — the data itself stays scoped to those same branches.
      for (const b of scopedBusinesses) if (b?.code) allowed.add(b.code);
      if (!allowed.has(activeTab)) {
        const bizMetric = liveMetrics.find((m) => m.businessId === ownBranch?.id);
        return (
          <BranchManagerSalesView
            currentUser={currentUser}
            businessInfo={ownBranch}
            businessMetrics={bizMetric}
            inventory={scopedInventory}
            customers={scopedCustomers}
            transactions={scopedTransactions}
            businesses={scopedBusinesses}
            metrics={liveMetrics}
            currentCurrency={currentCurrency}
            isOnline={isOnline}

            onNavigate={canOpenEnterpriseModules ? setActiveTab : undefined}
            onRefreshData={refreshAllData}
          />
        );
      }
    }

    // UNIT SPECIALISTS (SUPERVISOR / ACCOUNTANT): the same strictly-scoped unit
    // workspace a Branch Manager gets — their unit's register, assets, roster
    // (attendance review), order tracking, action center and the dashboards the
    // OWNER granted. Everything else falls back to the unit register, so a deep
    // link can never open an enterprise module (audit finding F7).
    if (unitSpecialist) {
      const ownSpecialistUnit = scopedBusinesses.find((b: any) => b.id === currentUser?.assignedBusinessId);
      const allowedSpecialist = new Set<string>([
        "BRANCH_SALES",
        "BRANCH_ASSETS",
        "WORKERS_MANAGE",
        "TRACKING",
        "ACTION_CENTER",
      ]);
      if (currentUser?.canViewFinance) allowedSpecialist.add("TRANSACTIONS");
      for (const b of scopedBusinesses) if (b?.code) allowedSpecialist.add(b.code);
      if (!allowedSpecialist.has(activeTab)) {
        const bizMetric = liveMetrics.find((m) => m.businessId === ownSpecialistUnit?.id);
        return (
          <BranchManagerSalesView
            currentUser={currentUser}
            businessInfo={ownSpecialistUnit}
            businessMetrics={bizMetric}
            inventory={scopedInventory}
            customers={scopedCustomers}
            transactions={scopedTransactions}
            businesses={scopedBusinesses}
            metrics={liveMetrics}
            currentCurrency={currentCurrency}
            isOnline={isOnline}
            onRefreshData={refreshAllData}
          />
        );
      }
    }

    // EXECUTIVE (Owner / General Manager): unified Sales Center across all branches.
    if (isExecutive && activeTab === "SALES_CENTER") {
      return (
        <BranchManagerSalesView
          currentUser={currentUser}
          businessInfo={scopedBusinesses[0]}
          businessMetrics={undefined}
          inventory={scopedInventory}
          customers={scopedCustomers}
          creditSales={scopedCreditSales}
          transactions={scopedTransactions}
          businesses={scopedBusinesses}
          metrics={liveMetrics}
          currentCurrency={currentCurrency}
          isOnline={isOnline}

          onNavigate={canOpenEnterpriseModules ? setActiveTab : undefined}
          onRefreshData={refreshAllData}
          isExecutive
        />
      );
    }

    // Executive-only tabs guard: block non-executives from enterprise surfaces.
    const executiveOnlyTabs: ActiveTab[] = [
      "COMMAND_CENTER",
      "SUPPLIERS",
      "EMPLOYEES",
      "ASSETS",
      "TRANSACTIONS",
      "CUSTOMERS",
      "INVENTORY",
      "FINANCE",
      "AI_ADVISOR",
      "SCENARIO_PLANNER",
      "INTEGRATIONS",
      "USERS_MANAGE",
    ];
    // CCTV-granted managers reach ONLY the Integrations Hub (their CCTV scope);
    // every other executive module stays locked.
    const cctvManagerEntry = !isExecutive && !!currentUser?.canManageCctv && activeTab === "INTEGRATIONS";
    // OWNER-granted Finance & Reports viewers reach ONLY the enterprise Finance
    // & Reports tab — every other executive module stays locked. Data is
    // scope-safe: /api/init already filters every entity to the businesses the
    // user can access, and financial figures ship only to authorised viewers.
    const financeGranteeEntry =
      !isExecutive &&
      maySeeFinancials &&
      // FINANCE: the OWNER-granted viewer's own surface. TRANSACTIONS: a
      // unit-scoped finance holder (Accountant preset) reconciles their unit's
      // ledger — the list stays scoped to the units they can reach.
      (activeTab === "FINANCE" || (unitSpecialist && activeTab === "TRANSACTIONS"));
    // OWNER-granted Enterprise Users administrators reach ONLY the staff
    // directory — the same surface the OWNER holds, delegated explicitly.
    const usersGranteeEntry = !isExecutive && maySeeEnterpriseUsers && activeTab === "USERS_MANAGE";
    // OWNER-delegated "Manage Business / Unit" managers may open the
    // business-scoped enterprise modules — every list is server-scoped to the
    // units they can reach — but never the global HQ or money surfaces
    // (Command Center, Users & Access, Finance & Reports, AI Advisor, Scenario
    // Planning, Integrations Hub). Opening Finance requires the OWNER's
    // dedicated `canViewFinance` grant, handled above.
    const isUnitManager = businessManageIdsOf(currentUser).length > 0;
    const unitManagerEntry =
      !isExecutive &&
      isUnitManager &&
      ["INVENTORY", "TRANSACTIONS", "ASSETS", "CUSTOMERS", "SUPPLIERS", "EMPLOYEES"].includes(activeTab);
    if (
      !isExecutive &&
      executiveOnlyTabs.includes(activeTab) &&
      !cctvManagerEntry &&
      !financeGranteeEntry &&
      !usersGranteeEntry &&
      !unitManagerEntry
    ) {
      return (
        <div className="flex items-center justify-center min-h-[60vh] p-8">
          <div className="bg-amber-900/20 border border-amber-500/30 rounded-2xl p-8 max-w-md text-center space-y-3">
            <h2 className="text-lg font-bold text-amber-300">Access Restricted</h2>
            <p className="text-sm text-slate-300">
              This module is restricted. Ask the OWNER to authorise your access from
              the Enterprise Users console.
            </p>
          </div>
        </div>
      );
    }

    // BRANCH_MANAGER: Branch Asset Register (scoped to their own branch)
    if (activeTab === "BRANCH_ASSETS") {
      return (
        <SharedEnterpriseModule
          moduleType="ASSETS"
          customers={scopedCustomers}
          suppliers={scopedSuppliers}
          employees={scopedEmployees}
          assets={scopedAssets}
          inventory={scopedInventory}
          transactions={scopedTransactions}
          businesses={scopedBusinesses}
          currentCurrency={currentCurrency}
          isOnline={isOnline}
          onRefreshData={refreshAllData}
          currentUser={currentUser}
          lockedBusinessId={currentUser?.assignedBusinessId ?? null}
        />
      );
    }

    // BRANCH_MANAGER: Worker Management panel. Delegated managers also get the
    // entry point to the full Users & Access console from here.
    if (activeTab === "WORKERS_MANAGE") {
      const bizInfo = scopedBusinesses.find((b) => b.id === currentUser?.assignedBusinessId);
      return (
        <BranchManagerWorkerPanel
          currentUser={currentUser}
          businessInfo={bizInfo}
          onRefreshData={refreshAllData}
          onOpenUserAccess={() => setIsUserAccessOpen(true)}
        />
      );
    }

    // BRANCH_MANAGER: Sales & Payments Center
    if (activeTab === "BRANCH_SALES") {
      const bizInfo = scopedBusinesses.find((b) => b.id === currentUser?.assignedBusinessId);
      const bizMetric = liveMetrics.find((m) => m.businessId === bizInfo?.id);
      return (
        <BranchManagerSalesView
          currentUser={currentUser}
          businessInfo={bizInfo}
          businessMetrics={bizMetric}
          inventory={scopedInventory}
          customers={scopedCustomers}
          creditSales={scopedCreditSales}
          transactions={scopedTransactions}
          businesses={scopedBusinesses}
          metrics={liveMetrics}
          currentCurrency={currentCurrency}
          isOnline={isOnline}

          onNavigate={canOpenEnterpriseModules ? setActiveTab : undefined}
          onRefreshData={refreshAllData}
        />
      );
    }

    // OWNER & GENERAL_MANAGER: Enterprise User Directory & Transfer Hub
    if (activeTab === "USERS_MANAGE" && maySeeEnterpriseUsers) {
      return (
        <EnterpriseUserPanel
          currentUser={currentUser}
          usersList={scopedUsers}
          businesses={scopedBusinesses}
          onRefreshData={refreshAllData}
          onOpenFarmAdvisors={() => setActiveTab("ADVISOR")}
        />
      );
    }

    // SUPER ADMIN ONLY: Platform Owners & Organizations console
    if (activeTab === "PLATFORM_ADMIN") {
      return (
        <PlatformAdminPanel
          currentUser={currentUser}
          focusRequestRef={platformRequestFocus}
          onFocusRequestHandled={() => setPlatformRequestFocus(null)}
        />
      );
    }

    if (activeTab === "COMMAND_CENTER") {
      return (
        <CommandCenterDashboard
          businesses={scopedBusinesses}
          metrics={liveMetrics}
          transactions={scopedTransactions}
          inventory={scopedInventory}
          currentCurrency={currentCurrency}
          currentUser={currentUser}
          // FINANCIAL SURFACE: revenue/profit/cash-flow/ROI render only for the
          // OWNER or an OWNER-authorised viewer; everybody else sees locked
          // placeholders and an explicit "ask the OWNER" notice.
          financialsAuthorized={maySeeFinancials}
          organizations={orgDirectory}
          orgLens={orgLens}
          lensOrgName={activeLensOrgName}
          onSelectTab={handleSelectTab}
          onOpenNewBusinessModal={() => setIsNewBusinessModalOpen(true)}
          onOpenManageBusinesses={() => { setManageBizOnlineId(null); setIsManageBizOpen(true); }}
          onOpenUserAccess={() => setIsUserAccessOpen(true)}
          canManageBusinesses={currentUser?.role === "OWNER"}
          canOpenManageUnits={currentUser?.role === "OWNER" || isUnitManager}
          // Owner-controlled permission (Users & Access → Permissions →
          // "New Branch/Unit"): the OWNER or any executive staff member
          // carrying the canCreateBusiness grant may open the New Branch /
          // Unit modal. Manage Units / Users & Access stay on their own
          // grants — this permission unlocks creation only.
          canCreateBusiness={currentUser?.role === "OWNER" || currentUser?.canCreateBusiness === true}
          // Owner-controlled permission (Users & Access → Permissions):
          // only the OWNER or staff carrying the canManageOnline grant may
          // open the Online Storefront & Delivery Areas management.
          canManageOnline={currentUser?.role === "OWNER" || !!currentUser?.canManageOnline}
          // ENTERPRISE USERS SURFACE — the console button follows the same
          // resolution as the sidebar row: OWNER / Super Admin / OWNER-granted.
          canManageUsersConsole={maySeeEnterpriseUsers}
          // Customer Support (storefront HELP) editor — the OWNER always;
          // any user carrying the OWNER's canManageSupport grant.
          onOpenSupportInfo={() => setIsSupportOpen(true)}
          canManageSupportInfo={currentUser?.role === "OWNER" || !!currentUser?.canManageSupport}
          checklists={scopedChecklistData}
        />
      );
    }

    // Specialized Business Views — EVERY business unit mounts the EXACT same
    // complete module as the original business of its type. Dispatch is driven
    // by the business category (code prefix as fallback), so a unit created
    // later via "New Branch / Unit" (POULTRY-02, BLOCK-02, WASH-02, …) renders
    // the identical flagship dashboard and features as POULTRY-01 / BLOCK-01 /
    // WASH-01 — wired entirely into its own scoped data.
    const MODULE_BY_CATEGORY: Record<string, string> = {
      "Poultry Farm": "POULTRY",
      "Block Factory": "BLOCK",
      "Electronic Shop": "TECH",
      "Restaurant & Food": "FOOD",
      Aquaculture: "AQUA",
      Livestock: "LIVESTOCK",
      "Car Wash": "WASH",
      "Hardware Store": "HARDWARE",
      "Telecom & Digital Services": "TELECOM",
      Transportation: "TRANSPORT",
      "Transport & Logistics": "TRANSPORT",
      Logistics: "TRANSPORT",
      Boutique: "BOUTIQUE",
      "Boutique & Fashion": "BOUTIQUE",
      "Fashion & Apparel": "BOUTIQUE",
    };
    const KNOWN_PREFIXES = ["POULTRY", "BLOCK", "TECH", "FOOD", "AQUA", "LIVESTOCK", "WASH", "HARDWARE", "TELECOM", "TRANSPORT", "BOUTIQUE"];
    const tabCandidates = scopedBusinesses.filter((b) => b.code === activeTab);
    const tabBiz = tabCandidates.find((b) => b.id === lastOpenedBizIdRef.current) ?? tabCandidates[0];
    if (tabBiz) {
      const bizInfo = tabBiz;
      const bizMetric = liveMetrics.find((m) => m.businessId === bizInfo?.id);
      const codePrefix = String(bizInfo.code || "").split("-")[0]?.toUpperCase();
      const moduleKey: string =
        MODULE_BY_CATEGORY[bizInfo.category] ||
        (KNOWN_PREFIXES.includes(codePrefix) ? codePrefix : "GENERIC");

      // Poultry Farm gets a full dedicated management module
      if (moduleKey === "POULTRY") {
        return (
          <PoultryFarmModule
            currentUser={currentUser}
            businessInfo={bizInfo}
            businessMetrics={bizMetric}
            inventory={scopedInventory}
            customers={scopedCustomers}
            transactions={scopedTransactions}
            assets={scopedAssets}
            employees={scopedEmployees}
            businesses={scopedBusinesses}
            currentCurrency={currentCurrency}
            onRefreshData={refreshAllData}
            isAdvisorView={currentUser?.role === "FARM_ADVISOR"}
            advisorSections={
              currentUser?.role === "FARM_ADVISOR"
                ? (advisorSections[String(bizInfo.id)] ?? null)
                : undefined
            }
          />
        );
      }

      // Block Factory gets a full dedicated real-time management dashboard
      if (moduleKey === "BLOCK") {
        return (
          <BlockFactoryModule
            currentUser={currentUser}
            businessInfo={bizInfo}
            businessMetrics={bizMetric}
            inventory={scopedInventory}
            transactions={scopedTransactions}
            assets={scopedAssets}
            employees={scopedEmployees}
            currentCurrency={currentCurrency}
            onRefreshData={refreshAllData}
          />
        );
      }

      // Electronics shop gets its dedicated management dashboard
      if (moduleKey === "TECH") {
        return (
          <ElectronicsShopModule
            currentUser={currentUser}
            businessInfo={bizInfo}
            businessMetrics={bizMetric}
            inventory={scopedInventory}
            customers={scopedCustomers}
            suppliers={scopedSuppliers}
            transactions={scopedTransactions}
            assets={scopedAssets}
            employees={scopedEmployees}
            currentCurrency={currentCurrency}
            onRefreshData={refreshAllData}
          />
        );
      }

      // Restaurant & Kitchen gets its dedicated management dashboard
      if (moduleKey === "FOOD") {
        return (
          <RestaurantKitchenModule
            currentUser={currentUser}
            businessInfo={bizInfo}
            businessMetrics={bizMetric}
            inventory={scopedInventory}
            customers={scopedCustomers}
            suppliers={scopedSuppliers}
            transactions={scopedTransactions}
            assets={scopedAssets}
            employees={scopedEmployees}
            currentCurrency={currentCurrency}
            onRefreshData={refreshAllData}
          />
        );
      }

      // Aquaculture / Fish Farm gets a dedicated real-time management dashboard
      if (moduleKey === "AQUA") {
        return (
          <AquacultureModule
            currentUser={currentUser}
            businessInfo={bizInfo}
            businessMetrics={bizMetric}
            inventory={scopedInventory}
            transactions={scopedTransactions}
            assets={scopedAssets}
            employees={scopedEmployees}
            currentCurrency={currentCurrency}
            onRefreshData={refreshAllData}
            isAdvisorView={currentUser?.role === "FARM_ADVISOR"}
            advisorSections={
              currentUser?.role === "FARM_ADVISOR"
                ? (advisorSections[String(bizInfo.id)] ?? null)
                : undefined
            }
          />
        );
      }

      // Hardware & Building Materials store gets its dedicated management
      // dashboard (Inventory → Stock → Sales → Finance → Dashboard, with
      // orders, supplier purchases, site deliveries and goods-received logs).
      if (moduleKey === "HARDWARE") {
        return (
          <HardwareStoreModule
            currentUser={currentUser}
            businessInfo={bizInfo}
            businessMetrics={bizMetric}
            inventory={scopedInventory}
            customers={scopedCustomers}
            suppliers={scopedSuppliers}
            transactions={scopedTransactions}
            assets={scopedAssets}
            employees={scopedEmployees}
            currentCurrency={currentCurrency}
            onRefreshData={refreshAllData}
          />
        );
      }

      // Car Wash units get the full integrated Auto Wash module — daily
      // sales, services & pricing, bookings, active washes, staff, payments,
      // stock usage, expenses, profit, reports, alerts and activities, with
      // Customer → Vehicle → Service → Staff → Sale/Payment → Inventory →
      // Expenses → Profit → Reports all linked automatically.
      if (moduleKey === "WASH") {
        return (
          <CarWashModule
            currentUser={currentUser}
            businessInfo={bizInfo}
            businessMetrics={bizMetric}
            inventory={scopedInventory}
            customers={scopedCustomers}
            transactions={scopedTransactions}
            assets={scopedAssets}
            employees={scopedEmployees}
            currentCurrency={currentCurrency}
            onRefreshData={refreshAllData}
          />
        );
      }

      // Telecom & Digital Services units get the full integrated module —
      // MoMo float & cash tills, airtime/data sales, Wi-Fi packages &
      // vouchers (codes, PINs, QR, expiry), sales, finance, customers and
      // reports, all interlinked with the shared ledger and customer base.
      if (moduleKey === "TELECOM") {
        return (
          <TelecomServicesModule
            currentUser={currentUser}
            businessInfo={bizInfo}
            businessMetrics={bizMetric}
            inventory={scopedInventory}
            customers={scopedCustomers}
            transactions={scopedTransactions}
            assets={scopedAssets}
            employees={scopedEmployees}
            currentCurrency={currentCurrency}
            onRefreshData={refreshAllData}
          />
        );
      }

      // Livestock units get the full tabbed dashboard (Overview / Herd / Finance).
      if (moduleKey === "LIVESTOCK") {
        const bucket = specializedLogs.livestock || [];
        // Only THIS unit's operations logs (bucket is shared per type).
        const logs = bucket.filter(
          (l: any) => !l.businessId || l.businessId === bizInfo.id
        );
        return (
          <LivestockModule
            businessCode={bizInfo.code}
            businessInfo={bizInfo}
            businessMetrics={bizMetric}
            specializedLogs={logs}
            currentCurrency={currentCurrency}
            isOnline={isOnline}
            onRefreshLogs={() => handleRefreshLogsForBusiness(bizInfo.code)}
            onRefreshData={refreshAllData}
            currentUser={currentUser}
            employees={scopedEmployees}
            transactions={scopedTransactions}
            inventory={scopedInventory}
            customers={scopedCustomers}
            isAdvisorView={currentUser?.role === "FARM_ADVISOR"}
            advisorSections={
              currentUser?.role === "FARM_ADVISOR"
                ? (advisorSections[String(bizInfo.id)] ?? null)
                : undefined
            }
          />
        );
      }

      // Boutique (fashion / clothing / apparel) units get the dedicated
      // boutique dashboard: size × colour stock, boutique POS, customer
      // orders, low stock and best-selling products/sizes/colours — all on
      // the shared Inventory, Sales, Finance, Orders, Reports and Audit
      // backbone.
      if (moduleKey === "BOUTIQUE") {
        return (
          <BoutiqueModule
            currentUser={currentUser}
            businessInfo={bizInfo}
            businessMetrics={bizMetric}
            inventory={scopedInventory}
            customers={scopedCustomers}
            suppliers={scopedSuppliers}
            transactions={scopedTransactions}
            assets={scopedAssets}
            employees={scopedEmployees}
            currentCurrency={currentCurrency}
            onRefreshData={refreshAllData}
          />
        );
      }

      // Transportation / fleet units get the full fleet module (trips, GPS…).
      if (moduleKey === "TRANSPORT") {
        return (
          <TransportModule
            currentUser={currentUser}
            businessInfo={bizInfo}
            businessMetrics={bizMetric}
            inventory={scopedInventory}
            customers={scopedCustomers}
            transactions={scopedTransactions}
            assets={scopedAssets}
            employees={scopedEmployees}
            currentCurrency={currentCurrency}
            onRefreshData={refreshAllData}
          />
        );
      }

      // Any other category: complete auto-provisioned enterprise dashboard —
      // wired into sales, inventory, finance, activities, alerts, checklists
      // and reports; never a blank or plain view.
      return (
        <BusinessDashboardModule
          currentUser={currentUser}
          businessInfo={bizInfo}
          businessMetrics={{ ...bizMetric, monthlyTargetRevenueGhs: bizInfo.monthlyTargetRevenueGhs }}
          inventory={scopedInventory}
          transactions={scopedTransactions}
          assets={scopedAssets}
          employees={scopedEmployees}
          customers={scopedCustomers}
          businesses={scopedBusinesses}
          currentCurrency={currentCurrency}
          onRefreshData={refreshAllData}
          onSelectTab={handleSelectTab}
        />
      );
    }

    // Shared Enterprise Module — Central Financial Report (Owner / GM only)
    if (activeTab === "FINANCE" && maySeeFinancials) {
      return (
        <EnterpriseFinanceView
          businesses={scopedBusinesses}
          metrics={liveMetrics}
          transactions={scopedTransactions}
          inventory={scopedInventory}
          customers={scopedCustomers}
          currentCurrency={currentCurrency}
          isOnline={isOnline}
          onRefreshData={refreshAllData}
          currentUser={currentUser}
        />
      );
    }

    // Customer Order & Tracking console — Owner/GM (all businesses) and Branch
    // Managers (their branch) via the sidebar. Server enforces the same
    // Business/Branch access scoping as the rest of the platform. Workers
    // get the same console embedded as a tab inside their sales workspace.
    // Pre-Orders hub (Setup + Procurement + Guide) — executives see every
    // business; Manage-Unit grantees stay scoped to their server-vetted units.

    // R5 — Unified BI Assistant: deterministic Q&A + the cross-module feed
    // (OWNER / GM / BM — the API enforces the same gate).
    if (activeTab === "BI_ASSISTANT") {
      return <BiAssistantPanel />;
    }

    // R4 — Document Vault: every business document in one registry (uploads
    // + generated vet reports & delivery notes), scoped like the rest.
    if (activeTab === "DOCUMENTS") {
      return <DocumentVaultPanel currentUser={currentUser} businesses={scopedBusinesses} />;
    }

    // Orders & Fulfilment — ONE hub, two tabs (Live Orders + Pre-Orders &
    // Procurement). Both screens mount exactly as they did before; only the
    // wrapper that owns the tab strip is new.
    if (activeTab === "TRACKING" || activeTab === "PREORDERS") {
      return (
        <OrdersFulfilmentHub
          activeTab={activeTab}
          onSelectTab={(t) => handleSelectTab(t as ActiveTab)}
          live={
            <CustomerTrackingPanel
              currentUser={currentUser}
              businesses={scopedBusinesses}
              currentCurrency={currentCurrency}
              focusTrackingCode={trackingFocusCode}
              focusTrackingId={trackingFocusId}
              onFocusHandled={() => {
                setTrackingFocusCode(null);
                setTrackingFocusId(null);
              }}
            />
          }
          preorders={<PreordersHubView currentUser={currentUser} businesses={scopedBusinesses} />}
        />
      );
    }

    // Shared Enterprise Modules
    const sharedModules: Record<
      string,
      "CUSTOMERS" | "SUPPLIERS" | "EMPLOYEES" | "ASSETS" | "INVENTORY" | "TRANSACTIONS"
    > = {
      CUSTOMERS: "CUSTOMERS",
      SUPPLIERS: "SUPPLIERS",
      EMPLOYEES: "EMPLOYEES",
      ASSETS: "ASSETS",
      INVENTORY: "INVENTORY",
      TRANSACTIONS: "TRANSACTIONS",
    };
    if (sharedModules[activeTab]) {
      return (
        <SharedEnterpriseModule
          moduleType={sharedModules[activeTab]}
          customers={scopedCustomers}
          suppliers={scopedSuppliers}
          employees={scopedEmployees}
          assets={scopedAssets}
          inventory={scopedInventory}
          transactions={scopedTransactions}
          businesses={scopedBusinesses}
          currentCurrency={currentCurrency}
          isOnline={isOnline}
          onRefreshData={refreshAllData}
          currentUser={currentUser}
        />
      );
    }

    // Strategic Decision Support & Hub
    if (activeTab === "AI_ADVISOR") {
      return (
        <AiAdvisorView
          insights={scopedAiInsights}
          myOrgId={myOrgIdOf(currentUser)}
          businesses={scopedBusinesses}
          currentCurrency={currentCurrency}
          onRefreshInsights={refreshAllData}
        />
      );
    }

    if (activeTab === "SCENARIO_PLANNER") {
      return (
        <ScenarioPlannerView
          scenarios={scopedScenarios}
          myOrgId={myOrgIdOf(currentUser)}
          businesses={scopedBusinesses}
          currentCurrency={currentCurrency}
          onRefreshScenarios={refreshAllData}
          currentUser={currentUser}
        />
      );
    }

    if (activeTab === "INTEGRATIONS") {
      return (
        <IntegrationsHubView
          integrations={scopedIntegrations}
          onRefreshIntegrations={refreshAllData}
          currentUser={currentUser}
          businesses={scopedBusinesses}
        />
      );
    }

    // Every known business code was already dispatched above (each unit mounts
    // the full module of its type, or the complete generic dashboard).
    return null;
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 text-white space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-700 flex items-center justify-center shadow-xl border border-emerald-400/30 animate-pulse">
          <span className="text-2xl font-black">360</span>
        </div>
        <div className="flex items-center space-x-2 text-slate-300 font-semibold">
          <Loader2 className="w-5 h-5 animate-spin text-emerald-400" />
          <span>Initializing GoMina 360 Command Center...</span>
        </div>
        <p className="text-xs text-slate-500 max-w-sm text-center">
          Securely loading your workspace — businesses, finance and operations data…
        </p>
      </div>
    );
  }

  // No valid session → render ONLY the sign-in screen (no data is fetched).
  if (!signedIn || !currentUser) {
    return (
      <LoginScreen
        onSuccess={handleLoginSuccess}
        notice={loginNotice}
        showRegistrationInvite={loginRegistrationInvite}
      />
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 text-white p-6">
        <div className="bg-rose-900/30 border border-rose-500/40 rounded-2xl p-6 max-w-md text-center space-y-3">
          <h2 className="text-xl font-bold text-rose-400">Connection Notice</h2>
          <p className="text-sm text-slate-300">{error}</p>
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={refreshAllData}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-md transition"
            >
              Retry Connection
            </button>
            <button
              onClick={() => { setError(null); setSignedIn(false); setCurrentUser(null); }}
              data-testid="back-to-signin"
              className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 font-bold text-xs shadow-md transition"
            >
              Back to Sign In
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100 font-sans">
      <Navbar
        currentCurrency={currentCurrency}
        onCurrencyChange={setCurrentCurrency}
        isOnline={isOnline}
        onToggleOnline={() => {
          const goingOnline = !isOnline;
          setIsOnline(goingOnline);
          // Reconnecting after offline mode: revalidate the session and data.
          // A dead session now bounces to the sign-in screen automatically
          // instead of dying on a dead-end "Connection Notice".
          if (goingOnline) refreshAllData();
        }}
        offlineQueueCount={offlineQueueCount}
        onSyncComplete={refreshAllData}
        currentUser={currentUser}
        usersList={scopedUsers}
        onUserSelect={setCurrentUser}
        onLogout={handleLogout}
        onOpenChangePassword={() => setIsChangePwOpen(true)}
        onOpenProfilePhoto={() => setIsProfilePhotoOpen(true)}
        onOpenManageUnits={
          currentUser?.role !== "OWNER" && businessManageIdsOf(currentUser).length > 0
            ? () => {
                setManageBizOnlineId(null);
                setIsManageBizOpen(true);
              }
            : undefined
        }
        onOpenOnlineOrdering={
          currentUser?.role === "OWNER" || !!currentUser?.canManageOnline
            ? openOnlineOrdering
            : undefined
        }
        onOpenMobileNav={() => setMobileNavOpen(true)}
        bellSlot={
          <NotificationBell
            currentUser={currentUser}
            onSummary={setAuditBell}
            onOpenSettings={() => setIsNotifSettingsOpen(true)}
            onOpenRecord={(n) => {
              if (!n) return;
              const t = String(n?.type || "").toUpperCase();
              const recType = String(n?.recordType || "").toLowerCase();
              const recRef = String(n?.recordRef || "");
              const recId = n?.recordId != null ? Number(n.recordId) : null;

              // 0. Platform registration requests: the Super Admin's own review
              //    queue. `platform-request:<REF>` carries the exact request, so
              //    the click opens it expanded rather than the whole console.
              if (t.startsWith("PLATFORM_REQUEST")) {
                const ref = recRef.startsWith("platform-request:")
                  ? recRef.slice("platform-request:".length)
                  : null;
                setPlatformRequestFocus(ref);
                setActiveTab("PLATFORM_ADMIN");
                return;
              }

              // 0b. Activity notifications (money, stock crossings, flagged
              //     notes): open the unit's workspace they belong to. Money rows
              //     carry the accounting figures — the OWNER's Finance console is
              //     the right destination when the account may see it.
              if (t === "SALE_RECORDED" || t === "EXPENSE_RECORDED") {
                if (n?.branchCode && businesses.some((b: any) => b?.code === n.branchCode)) {
                  handleSelectTab(n.branchCode as ActiveTab, n.businessId);
                  return;
                }
                setActiveTab(financialsAuthorized ? "FINANCE" : "COMMAND_CENTER");
                return;
              }
              if (t === "STOCK_LOW" || t === "STOCK_OUT") {
                if (n?.branchCode && businesses.some((b: any) => b?.code === n.branchCode)) {
                  handleSelectTab(n.branchCode as ActiveTab, n.businessId);
                  return;
                }
                setActiveTab("INVENTORY");
                return;
              }
              if (t === "OPS_NOTE_FLAGGED") {
                if (n?.branchCode && businesses.some((b: any) => b?.code === n.branchCode)) {
                  handleSelectTab(n.branchCode as ActiveTab, n.businessId);
                  return;
                }
                setActiveTab("COMMAND_CENTER");
                return;
              }

              // 1. Audit-trail events are NOT audit issues: they link to the
              //    record's workspace (below), not to an issue inbox.
              if (t === "AUDIT_EVENT") {
                if (n?.branchCode && businesses.some((b: any) => b?.code === n.branchCode)) {
                  handleSelectTab(n.branchCode as ActiveTab, n.businessId);
                  return;
                }
                setActiveTab("COMMAND_CENTER");
                return;
              }

              // 1b. Audit issues & reviews: Direct deep link to Issue / Audit Command Center
              if (t.startsWith("AUDIT") || recType.startsWith("audit") || n?.issueId) {
                const reviewerSide = t === "AUDIT_ISSUE_RESPONSE" || t === "AUDIT_ISSUE_RESOLVED";
              if (reviewerSide && (auditEligible || currentUser?.role === "OWNER" || !!currentUser?.canManageAuditors)) {
                setAuditFocusIssue(n.issueId || n.recordId || null);
                setActiveTab("AUDIT");
              } else {
                setMyIssueFocus(n.issueId || n.recordId || null);
                setMyIssuesOpen(true);
              }
                return;
              }

              // 2. Approvals, Expense requests, Requisitions, PO approvals
              if (
                t.startsWith("APPROVAL") ||
                t.includes("EXPENSE") ||
                recType === "approval_requests" ||
                recRef.startsWith("approval:")
              ) {
                const reqId = recId || (recRef.startsWith("approval:") ? Number(recRef.split(":")[1]) : null);
                setActionCenterFocusApprovalId(reqId);
                setActiveTab("ACTION_CENTER");
                return;
              }

              // 3. Action Tasks & Follow-ups
              if (t.startsWith("TASK_") || recType === "action_tasks" || recRef.startsWith("task:")) {
                const taskId = recId || (recRef.startsWith("task:") ? Number(recRef.split(":")[1]) : null);
                setActionCenterFocusTaskId(taskId);
                setActiveTab("ACTION_CENTER");
                return;
              }

              // 4. Farm Advisor notes & recommendations
              if (t.startsWith("ADVISOR") || recType === "advisor_notes") {
                if (currentUser?.role === "FARM_ADVISOR") {
                  setActiveTab("ADVISOR");
                  return;
                }
                if (n?.branchCode && businesses.some((b: any) => b?.code === n.branchCode)) {
                  handleSelectTab(n.branchCode as ActiveTab, n.businessId);
                  return;
                }
                setActiveTab("ADVISOR");
                return;
              }

              // 5. Orders, Online orders, Dispatch & Live Tracking
              if (
                t === "ONLINE_ORDER_RECEIVED" ||
                t === "ORDER_TRACKING_STATUS" ||
                t === "ORDER_ASSIGNED" ||
                t === "ORDER_FULFILLED" ||
                recType === "customer_trackings" ||
                recType === "orders" ||
                recRef.startsWith("TRK-") ||
                recRef.startsWith("ORD-")
              ) {
                const code = recRef || (recId ? String(recId) : null);
                setTrackingFocusCode(code);
                setTrackingFocusId(recId);
                setActiveTab("TRACKING");
                return;
              }

              // 6. Pre-orders hub
              if (t.startsWith("PREORDER") || recType === "preorders" || recRef.startsWith("preorder:")) {
                setActiveTab("PREORDERS");
                return;
              }

              // 7. Transport Module (Maintenance, Violations, Bookings)
              if (t.startsWith("TRANSPORT") || recType === "transport_vehicles" || recRef.startsWith("transport:")) {
                const transBiz = businesses.find((b: any) => String(b.code || "").toUpperCase().startsWith("TRANS"));
                if (transBiz) {
                  handleSelectTab(transBiz.code as ActiveTab, transBiz.id);
                  return;
                }
                setActiveTab("TRACKING");
                return;
              }

              // 8. Low Stock & Inventory alerts
              if (t === "LOW_STOCK" || t === "INVENTORY_CRITICAL" || recType === "inventory_items") {
                if (n?.branchCode && businesses.some((b: any) => b?.code === n.branchCode)) {
                  handleSelectTab(n.branchCode as ActiveTab, n.businessId);
                  return;
                }
                if (currentUser?.role === "OWNER" || currentUser?.role === "GENERAL_MANAGER") {
                  setActiveTab("INVENTORY");
                  return;
                }
              }

              // 9. Checklists & Stage plans
              if (t.includes("CHECKLIST") || t.includes("STAGE") || recType === "checklists") {
                if (n?.branchCode && businesses.some((b: any) => b?.code === n.branchCode)) {
                  handleSelectTab(n.branchCode as ActiveTab, n.businessId);
                  return;
                }
              }

              // 10. Credit sales & Dunning
              if (t.includes("CREDIT") || t.includes("DUNNING") || recType === "credit_sales" || recRef.startsWith("dunning:")) {
                if (n?.branchCode && businesses.some((b: any) => b?.code === n.branchCode)) {
                  handleSelectTab(n.branchCode as ActiveTab, n.businessId);
                  return;
                }
                if (currentUser?.role === "OWNER" || currentUser?.role === "GENERAL_MANAGER") {
                  setActiveTab("BRANCH_SALES");
                  return;
                }
              }

              // 11. Purchases / Supplier Orders
              if (t.includes("PURCHASE") || recType === "purchases" || recType === "supplier_orders") {
                if (n?.branchCode && businesses.some((b: any) => b?.code === n.branchCode)) {
                  handleSelectTab(n.branchCode as ActiveTab, n.businessId);
                  return;
                }
              }

              // 12. Registry fallback. Every type the app emits is declared in
              // `bellTypes.ts` (label, category, destination, whether the unit
              // dashboard wins). The branches above are an ENRICHMENT layer —
              // they add focus/selection state for consoles that need it — but
              // the destination for anything they do not handle comes from the
              // registry. Previously anything unhandled fell through to the
              // Command Center regardless of what the type was about, and the
              // push URL for the same rows opened Customer Order & Tracking.
              const bellDef = lookupBellType(t);
              if (bellDef) {
                if (n?.branchCode && bellDef.unitScoped && businesses.some((b: any) => b?.code === n.branchCode)) {
                  handleSelectTab(n.branchCode as ActiveTab, n.businessId);
                  return;
                }
                setActiveTab(bellDef.tab as ActiveTab);
                return;
              }

              setActiveTab(FALLBACK_TAB as ActiveTab);
            }}
            onOpenIssue={(n) => {
              // Responses / resolutions go to the reviewer's Audit Center;
              // flags, corrections & closures open the assignee's own inbox.
              const reviewerSide = n.type === "AUDIT_ISSUE_RESPONSE" || n.type === "AUDIT_ISSUE_RESOLVED";
              if (reviewerSide && (auditEligible || currentUser?.role === "OWNER" || !!currentUser?.canManageAuditors)) {
                setAuditFocusIssue(n.issueId || n.recordId || null);
                setActiveTab("AUDIT");
              } else {
                setMyIssueFocus(n.issueId || n.recordId || null);
                setMyIssuesOpen(true);
              }
            }}
          />
        }
      />

      {/* Flagged issues & corrections routed to this user's dashboard */}
      {auditBell.openAssigned > 0 && (
        <div className="flex items-center justify-center gap-3 px-4 py-1.5 bg-gradient-to-r from-rose-950/90 via-rose-900/60 to-rose-950/90 border-b border-rose-500/30" data-testid="my-issues-strip">
          <span className="text-[11px] text-rose-200 font-semibold">
            ⚑ {auditBell.openAssigned} audit issue{auditBell.openAssigned > 1 ? "s" : ""} {auditBell.openAssigned > 1 ? "need" : "needs"} your response
          </span>
          <button
            onClick={() => { setMyIssueFocus(null); setMyIssuesOpen(true); }}
            className="px-2.5 py-0.5 rounded-lg bg-rose-500/25 hover:bg-rose-500/40 border border-rose-400/40 text-rose-100 text-[10px] font-bold transition"
            data-testid="my-issues-open-btn"
          >
            Review & respond
          </button>
        </div>
      )}

      {myIssuesOpen && (
        <MyAuditIssues
          currentUser={currentUser}
          focusIssueId={myIssueFocus}
          onClose={() => { setMyIssuesOpen(false); setMyIssueFocus(null); setTimeout(() => window.dispatchEvent(new Event("focus")), 150); }}
        />
      )}

      {/*
        overflow-x-CLIP (not hidden): still clips any stray horizontal bleed,
        but — unlike `hidden` — it does not create a scroll container, so the
        sidebar's `position: sticky` keeps working against the page scroller.
        Before this, the rail simply scrolled away with the page (measured:
        top = -635px after a 700px scroll), putting the last nav rows ~1700px
        below the fold on every laptop size.
      */}
      <div className="flex flex-1 overflow-x-clip">
        <Sidebar
          activeTab={activeTab}
          onSelectTab={handleSelectTab}
          businesses={scopedBusinesses}
          currentUser={currentUser}
          auditEligible={auditEligible}
          organizations={orgDirectory}
          orgLens={orgLens}
          onLensChange={setOrgLens}
          onOpenSupportInfo={() => setIsSupportOpen(true)}
          accessibleBusinessIds={accessibleIds}
          onOpenManageBusinesses={() => { setManageBizOnlineId(null); setIsManageBizOpen(true); }}
          navContext={navContext}
          mobileOpen={mobileNavOpen}
          onCloseMobile={() => setMobileNavOpen(false)}
          onOpenMobile={() => setMobileNavOpen(true)}
          onOpenPalette={() => setPaletteOpen(true)}
          /* Fail-open: only a positively-known empty advisor list hides the
             Farm Advisors row (they are created in Users & Access). */
          hasFarmAdvisors={usersList.some((u: any) => u?.role === "FARM_ADVISOR")}
          onOpenOnlineOrdering={
            currentUser?.role === "OWNER" || !!currentUser?.canManageOnline
              ? openOnlineOrdering
              : undefined
          }
        />

        <OrgDirectoryProvider value={orgDirectory}>
        <main className="flex-1 min-w-0 overflow-y-auto bg-slate-950/95 pb-12 max-lg:pb-24">
          <div data-printchrome="true" className="sticky top-0 z-30 flex items-center justify-between xl:justify-end gap-2 px-4 sm:px-6 py-2 bg-slate-950/90 backdrop-blur border-b border-slate-800/80">
            {/* Compact "you are here" bar — phones/tablets/small laptops
                (the full right rail takes over at xl and wider). */}
            <div className="xl:hidden min-w-0 flex-1 flex">
              <ContextBar
                activeTab={activeTab}
                businesses={scopedBusinesses}
                currentUser={currentUser}
                onOpen={() => setContextNavOpen(true)}
              />
            </div>
            <UniversalExportCenter
              activeModule={activeTab}
              currentUser={currentUser}
              businesses={scopedBusinesses}
              organizations={orgDirectory}
              lensLabel={activeLensOrgName}
              data={{
                metrics: liveMetrics,
                users: scopedUsers,
                customers: scopedCustomers,
                suppliers: scopedSuppliers,
                employees: scopedEmployees,
                assets: scopedAssets,
                inventory: scopedInventory,
                transactions: scopedTransactions,
                aiInsights: scopedAiInsights,
                scenarios: scopedScenarios,
                integrations: scopedIntegrations,
                specializedLogs: scopedSpecializedLogs,
              }}
            />
          </div>
          {/* Super Admin lens: when a business dashboard is open, the owning
              Owner/Organization is announced on the dashboard itself. */}
          {isSuperAdminUser && activeTab !== "COMMAND_CENTER" &&
            (() => {
              const openCandidates = scopedBusinesses.filter((b: any) => b.code === activeTab);
              const openBiz = openCandidates.find((b: any) => b.id === lastOpenedBizIdRef.current) ?? openCandidates[0];
              if (!openBiz) return null;
              const oId = Number(openBiz.ownerId ?? 1);
              const org = orgDirectory.find((o) => Number(o.id) === oId);
              const orgName = org?.name || (oId === 1 ? "GoMina Group" : `Organization #${oId}`);
              const mine = oId === 1;
              return (
                <div
                  data-testid={`org-identity-banner-${openBiz.code}`}
                  className={`mx-4 sm:mx-6 mt-3 flex flex-wrap items-center gap-2.5 rounded-xl border px-3.5 py-2.5 ${
                    mine
                      ? "bg-violet-500/10 border-violet-500/40"
                      : "bg-sky-500/10 border-sky-500/40"
                  }`}
                >
                  {openBiz.logo && (
                    <img src={openBiz.logo} alt="" className="w-8 h-8 rounded-lg object-cover border border-slate-600 bg-slate-800" loading="lazy" decoding="async" />
                  )}
                  <div className="min-w-0">
                    <div className="text-[11px] font-black tracking-wide text-white leading-snug break-words">
                      {mine ? "YOUR BUSINESS" : "OWNED BY ANOTHER OWNER"} · {orgName}
                    </div>
                    <div className={`text-[10px] ${mine ? "text-violet-300" : "text-sky-300"}`}>
                      Organization: {orgName}
                      {org?.status && org.status !== "ACTIVE" ? ` · ${org.status}` : ""}
                      {" — Super Admin cross-owner view. Switch the Organization Lens in the sidebar to focus one Owner."}
                    </div>
                  </div>
                  <span
                    className={`ml-auto shrink-0 text-[10px] font-black px-2 py-1 rounded-full border ${
                      mine
                        ? "bg-violet-500/20 text-violet-200 border-violet-500/50"
                        : "bg-sky-500/20 text-sky-200 border-sky-500/50"
                    }`}
                  >
                    {mine ? "MAIN OWNER" : orgName.toUpperCase()}
                  </span>
                </div>
              );
            })()}
          {renderActiveView()}
        </main>
        </OrgDirectoryProvider>

        {/* Right-side navigation & location panel (persistent rail ≥xl,
            slide-in drawer on smaller screens) — shows current Business,
            Branch, Section & Page everywhere in the app. */}
        <ContextNavigator
          activeTab={activeTab}
          onSelectTab={(t, bizId) => {
            handleSelectTab(t, bizId);
            setContextNavOpen(false);
          }}
          businesses={scopedBusinesses}
          currentUser={currentUser}
          open={contextNavOpen}
          onClose={() => setContextNavOpen(false)}
        />
      </div>

      <NewBusinessModal
        isOpen={isNewBusinessModalOpen}
        onClose={() => setIsNewBusinessModalOpen(false)}
        actorUserId={currentUser?.id ?? null}
        allowedTypes={bizTypeAccess}
        onBusinessCreated={async (biz?: any) => {
          await refreshAllData();
          if (biz?.code) setActiveTab(biz.code as ActiveTab);
        }}
      />

      {/* OWNER business management console — add / edit / rename / relocate /
          change type / deactivate / permanently delete any branch. */}
      <UserAccessConsole
        isOpen={isUserAccessOpen}
        onClose={() => setIsUserAccessOpen(false)}
        businesses={businesses}
        currentUser={currentUser}
        onChanged={refreshAllData}
      />

      {/* Customer Support (storefront HELP) editor — OWNER or granted user. */}
      <CustomerSupportModal
        isOpen={isSupportOpen}
        onClose={() => setIsSupportOpen(false)}
        currentUser={currentUser}
      />

      {/* Phone/laptop notification (Web Push) settings — per device toggles,
          per-category switches, live test notification. */}
      <NotificationSettingsModal
        isOpen={isNotifSettingsOpen}
        onClose={() => setIsNotifSettingsOpen(false)}
        currentUser={currentUser}
      />

      {/* Service-worker registration + subscription re-sync (no UI). */}
      <PushNotifications currentUser={currentUser} />

      {/* 24-hour inactivity auto-logout (no UI). */}
      <IdleLogout active={signedIn && !!currentUser} onIdle={handleIdleLogout} />

      {/* Self-service password change for the signed-in user (any role). */}
      <ChangePasswordModal
        isOpen={isChangePwOpen}
        onClose={() => setIsChangePwOpen(false)}
        currentUser={currentUser}
      />

      <ProfilePhotoModal
        isOpen={isProfilePhotoOpen}
        onClose={() => setIsProfilePhotoOpen(false)}
        currentUser={currentUser}
        onSaved={refreshAllData}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        ctx={navContext}
        businesses={scopedBusinesses}
        accessibleBusinessIds={accessibleIds}
        currentUser={currentUser}
        onSelectTab={(tab, bizId) => {
          handleSelectTab(tab, bizId);
          setPaletteOpen(false);
        }}
        onRunAction={runPaletteAction}
      />

      <ManageBusinessesModal
        isOpen={isManageBizOpen}
        onClose={() => setIsManageBizOpen(false)}
        businesses={businesses}
        currentUser={currentUser}
        allowedTypes={bizTypeAccess}
        organizations={orgDirectory}
        initialOnlineBizId={manageBizOnlineId}
        onChanged={refreshAllData}
        onAddNew={() => setIsNewBusinessModalOpen(true)}
        onDeleted={(code) => {
          if (activeTab === code) setActiveTab("COMMAND_CENTER");
        }}
      />
    </div>
  );
}
