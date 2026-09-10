"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Navbar from "./Navbar";
import LoginScreen from "./LoginScreen";
import Sidebar, { ActiveTab } from "./Sidebar";
import ContextNavigator, { ContextBar } from "./ContextNavigator";
import CommandCenterDashboard from "./CommandCenterDashboard";
import LivestockModule from "./LivestockModule";
import SharedEnterpriseModule from "./SharedEnterpriseModule";
import CustomerTrackingPanel from "./CustomerTrackingPanel";
import AiAdvisorView from "./AiAdvisorView";
import ScenarioPlannerView from "./ScenarioPlannerView";
import IntegrationsHubView from "./IntegrationsHubView";
import NewBusinessModal from "./NewBusinessModal";
import ManageBusinessesModal from "./ManageBusinessesModal";
import UserAccessConsole from "./UserAccessConsole";
import CustomerSupportModal from "./CustomerSupportModal";
import ChangePasswordModal from "./ChangePasswordModal";
import ProfilePhotoModal from "./ProfilePhotoModal";
import WorkerDashboard from "./WorkerDashboard";
import BranchManagerWorkerPanel from "./BranchManagerWorkerPanel";
import BranchManagerSalesView from "./BranchManagerSalesView";
import EnterpriseUserPanel from "./EnterpriseUserPanel";
import EnterpriseFinanceView from "./EnterpriseFinanceView";
import AuditCommandCenter from "./AuditCommandCenter";
import NotificationBell from "./NotificationBell";
import NotificationSettingsModal from "./NotificationSettingsModal";
import PushNotifications from "./PushNotifications";
import IdleLogout from "./IdleLogout";
import MyAuditIssues from "./MyAuditIssues";
import PoultryFarmModule from "./PoultryFarmModule";
import BlockFactoryModule from "./BlockFactoryModule";
import AquacultureModule from "./AquacultureModule";
import ElectronicsShopModule from "./ElectronicsShopModule";
import RestaurantKitchenModule from "./RestaurantKitchenModule";
import HardwareStoreModule from "./HardwareStoreModule";
import CarWashModule from "./CarWashModule";
import TelecomServicesModule from "./TelecomServicesModule";
import BusinessDashboardModule from "./BusinessDashboardModule";
import UniversalExportCenter from "./UniversalExportCenter";
import { CurrencyCode } from "@/lib/currency";
import { isSeededBaselineTxn } from "@/lib/financeReport";
import { getOfflineQueue } from "@/lib/offlineSync";
import { installSessionBridge, setSessionToken, clearSessionToken } from "@/lib/sessionBridge";
import { businessManageIdsOf } from "@/lib/permissions";
import { Loader2 } from "lucide-react";
import { setCompanyLogo } from "@/lib/logos";

export default function GoMinaApp() {
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
  const [currentCurrency, setCurrentCurrency] = useState<CurrencyCode>("GHS");
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [offlineQueueCount, setOfflineQueueCount] = useState<number>(0);
  const [isNewBusinessModalOpen, setIsNewBusinessModalOpen] = useState(false);
  const [isManageBizOpen, setIsManageBizOpen] = useState(false);
  // Deep-link target when opened from the navbar "Online storefront & delivery
  // areas" entry (branch managers land straight on their own unit's panel).
  const [manageBizOnlineId, setManageBizOnlineId] = useState<number | null>(null);
  // Right-side navigation & "you are here" panel — drawer below xl.
  const [contextNavOpen, setContextNavOpen] = useState(false);
  const [isUserAccessOpen, setIsUserAccessOpen] = useState(false);
  const [isSupportOpen, setIsSupportOpen] = useState(false);
  // Bell → gear opens phone/laptop (Web Push) notification settings.
  const [isNotifSettingsOpen, setIsNotifSettingsOpen] = useState(false);
  // Self-service password change (account menu → Change Password).
  const [isChangePwOpen, setIsChangePwOpen] = useState(false);
  // Self-service profile photo (account menu → My Profile Photo).
  const [isProfilePhotoOpen, setIsProfilePhotoOpen] = useState(false);
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

  const refreshAllData = useCallback(async (): Promise<"ok" | "unauthorized" | "error"> => {
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
        // A healthy response must clear any previously displayed error —
        // otherwise a stale notice would keep covering the working app.
        setError(null);
        setBusinesses(data.businesses || []);
        // Server-vetted access scope (null ⇒ OWNER/unrestricted) — drives the
        // sidebar's granted-branch dashboard chips.
        setAccessibleIds(Array.isArray(data.accessibleBusinessIds) ? data.accessibleBusinessIds : null);
        setCompanyLogo(data.companyLogo || null);
        setMetrics(data.metrics || []);
        setUsersList(data.users || []);
        // Keep the signed-in user object in sync with freshly fetched rows
        // (permission changes apply instantly) — never auto-pick users[0]:
        // identity comes from the secure login session only.
        setCurrentUser((prev: any) => {
          if (!prev) return prev;
          const fresh = (data.users || []).find((u: any) => u.id === prev.id);
          return fresh ? { ...fresh } : prev;
        });
        setCustomers(data.customers || []);
        setCreditSales(data.creditSales || []);
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
  }, []);

  // Attach the bearer-token channel to every /api fetch before ANY fetch can
  // fire (the cookie stays primary; the header saves embedded contexts whose
  // browsers block third-party cookie storage).
  useEffect(() => { installSessionBridge(); }, []);

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
      try {
        const res = await fetch("/api/auth/me");
        const d = await res.json().catch(() => null);
        if (res.ok && d?.success) {
          setCurrentUser(d.user);
          setSignedIn(true);
          await refreshAllData();
        } else {
          setLoading(false);
        }
      } catch {
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
  useEffect(() => {
    try {
      const t = new URLSearchParams(window.location.search).get("tab");
      if (t) pendingTabRef.current = t;
    } catch { /* non-browser env */ }
  }, []);
  // The pending tab is consumed by the role-landing effect below (the single
  // place that decides the landing workspace whenever the user loads).

  // 10 minutes without any real user interaction (mouse/keyboard/touch/
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
    setLoginNotice("You were signed out automatically after 10 minutes of inactivity. Sign in again to continue.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    for (const a of assets) {
      const bid = a.businessId;
      if (bid === undefined || bid === null) continue;
      assetValueByBiz[bid] = (assetValueByBiz[bid] || 0) + (a.currentValueGhs || 0);
    }

    // Units created after the quarterly close have no business_metrics row:
    // synthesise an honest zero baseline so their live transactions still
    // layer onto dashboards like every other unit.
    const metricRows: any[] = metrics.slice();
    for (const b of businesses || []) {
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
      // Live asset value: prefer the sum of registered assets when available;
      // fall back to the seeded metric so the number is never blank.
      const liveAssetsValue = assetValueByBiz[m.businessId] || m.assetsValueGhs;

      // Overlay = every live transaction (id above the seeded watermark),
      // not only the ones recorded inside this browser session.
      const newTx = transactions.filter(
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
  }, [metrics, transactions, assets, businesses]);

  // Reset to a role-appropriate landing tab whenever the active user changes.
  // Prevents a lower-privilege user from inheriting an executive tab (data leak).
  // A pending deep link (push-notification click: /?tab=…) takes precedence —
  // it is the exact workspace the user asked to open.
  useEffect(() => {
    if (!currentUser) return;
    if (pendingTabRef.current) {
      setActiveTab(pendingTabRef.current as ActiveTab);
      pendingTabRef.current = null;
      return;
    }
    if (currentUser.role === "BRANCH_MANAGER") {
      setActiveTab("BRANCH_SALES");
    } else if (currentUser.role === "WORKER") {
      // Worker view is self-contained; render layer intercepts regardless of tab.
      setActiveTab("COMMAND_CENTER");
    } else {
      setActiveTab("COMMAND_CENTER");
    }
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

  const renderActiveView = () => {
    const isExecutive =
      currentUser?.role === "OWNER" || currentUser?.role === "GENERAL_MANAGER";
    const isBranchManager = currentUser?.role === "BRANCH_MANAGER";

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
          businesses={businesses}
          focusIssueId={auditFocusIssue}
          onFocusHandled={() => setAuditFocusIssue(null)}
        />
      );
    }


    // WORKER role: self-contained workspace. All tools (record sale, create
    // customer, view branch inventory, my activity) live inside WorkerDashboard,
    // which is strictly scoped to the worker's own branch — no enterprise data.
    if (currentUser?.role === "WORKER") {
      const bizCode = businesses.find((b) => b.id === currentUser?.assignedBusinessId)?.code;
      const bizInfo = businesses.find((b) => b.id === currentUser?.assignedBusinessId);
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
          inventory={inventory}
          customers={customers}
          transactions={transactions}
          currentCurrency={currentCurrency}
          isOnline={isOnline}
          onRefreshData={refreshAllData}
        />
      );
    }

    // BRANCH_MANAGER: strictly scoped to their own branch. Any attempt to reach an
    // executive/enterprise tab falls back to their branch Sales & Payments center.
    if (isBranchManager) {
      const ownBranch = businesses.find((b) => b.id === currentUser?.assignedBusinessId);
      const allowed = new Set<string>([
        "BRANCH_SALES",
        "WORKERS_MANAGE",
        "BRANCH_ASSETS",
        "TRACKING", // Customer Order & Tracking register (scoped server-side to own branch)
      ]);
      // Managers the OWNER trusted with CCTV may open the Integrations Hub,
      // where the CCTV Command Center stays scoped to their authorised branches.
      if (currentUser?.canManageCctv) allowed.add("INTEGRATIONS");
      if (ownBranch?.code) allowed.add(ownBranch.code);
      // OWNER-granted branch dashboards ("Extra business access"): every code
      // inside the server-scoped business list is a dashboard this manager may
      // open — the data itself stays scoped to those same branches.
      for (const b of businesses) if (b?.code) allowed.add(b.code);
      if (!allowed.has(activeTab)) {
        const bizMetric = liveMetrics.find((m) => m.businessId === ownBranch?.id);
        return (
          <BranchManagerSalesView
            currentUser={currentUser}
            businessInfo={ownBranch}
            businessMetrics={bizMetric}
            inventory={inventory}
            customers={customers}
            transactions={transactions}
            businesses={businesses}
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
          businessInfo={businesses[0]}
          businessMetrics={undefined}
          inventory={inventory}
          customers={customers}
          creditSales={creditSales}
          transactions={transactions}
          businesses={businesses}
          metrics={liveMetrics}
          currentCurrency={currentCurrency}
          isOnline={isOnline}
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
    // OWNER-granted Finance & Reports viewers (non-executives) reach ONLY the
    // enterprise Finance & Reports tab — every other executive module stays
    // locked. Data is scope-safe: /api/init already filters every entity to
    // the businesses the user can access.
    const financeGranteeEntry = !isExecutive && !!currentUser?.canViewFinance && activeTab === "FINANCE";
    // OWNER-delegated "Manage Business / Unit" managers may open the
    // business-scoped enterprise modules — every list is server-scoped to the
    // units they can reach — but never the global HQ surfaces (Command Center,
    // Users & Access, AI Advisor, Scenario Planning, Integrations Hub).
    const isUnitManager = businessManageIdsOf(currentUser).length > 0;
    const unitManagerEntry =
      !isExecutive &&
      isUnitManager &&
      ["INVENTORY", "TRANSACTIONS", "ASSETS", "CUSTOMERS", "SUPPLIERS", "EMPLOYEES", "FINANCE"].includes(activeTab);
    if (!isExecutive && executiveOnlyTabs.includes(activeTab) && !cctvManagerEntry && !financeGranteeEntry && !unitManagerEntry) {
      return (
        <div className="flex items-center justify-center min-h-[60vh] p-8">
          <div className="bg-amber-900/20 border border-amber-500/30 rounded-2xl p-8 max-w-md text-center space-y-3">
            <h2 className="text-lg font-bold text-amber-300">Access Restricted</h2>
            <p className="text-sm text-slate-300">
              This enterprise module is available to Owners and General Managers only.
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
          customers={customers}
          suppliers={suppliers}
          employees={employees}
          assets={assets}
          inventory={inventory}
          transactions={transactions}
          businesses={businesses}
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
      const bizInfo = businesses.find((b) => b.id === currentUser?.assignedBusinessId);
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
      const bizInfo = businesses.find((b) => b.id === currentUser?.assignedBusinessId);
      const bizMetric = liveMetrics.find((m) => m.businessId === bizInfo?.id);
      return (
        <BranchManagerSalesView
          currentUser={currentUser}
          businessInfo={bizInfo}
          businessMetrics={bizMetric}
          inventory={inventory}
          customers={customers}
          creditSales={creditSales}
          transactions={transactions}
          businesses={businesses}
          metrics={liveMetrics}
          currentCurrency={currentCurrency}
          isOnline={isOnline}
          onRefreshData={refreshAllData}
        />
      );
    }

    // OWNER & GENERAL_MANAGER: Enterprise User Directory & Transfer Hub
    if (activeTab === "USERS_MANAGE") {
      return (
        <EnterpriseUserPanel
          currentUser={currentUser}
          usersList={usersList}
          businesses={businesses}
          onRefreshData={refreshAllData}
        />
      );
    }

    if (activeTab === "COMMAND_CENTER") {
      return (
        <CommandCenterDashboard
          businesses={businesses}
          metrics={liveMetrics}
          transactions={transactions}
          inventory={inventory}
          currentCurrency={currentCurrency}
          onSelectTab={setActiveTab}
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
          canManageUsersConsole={currentUser?.role === "OWNER" || !!currentUser?.canManageUsers}
          // Customer Support (storefront HELP) editor — the OWNER always;
          // any user carrying the OWNER's canManageSupport grant.
          onOpenSupportInfo={() => setIsSupportOpen(true)}
          canManageSupportInfo={currentUser?.role === "OWNER" || !!currentUser?.canManageSupport}
          checklists={checklistData}
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
    };
    const KNOWN_PREFIXES = ["POULTRY", "BLOCK", "TECH", "FOOD", "AQUA", "LIVESTOCK", "WASH", "HARDWARE", "TELECOM"];
    const tabBiz = businesses.find((b) => b.code === activeTab);
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
            inventory={inventory}
            customers={customers}
            transactions={transactions}
            assets={assets}
            employees={employees}
            businesses={businesses}
            currentCurrency={currentCurrency}
            onRefreshData={refreshAllData}
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
            inventory={inventory}
            transactions={transactions}
            assets={assets}
            employees={employees}
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
            inventory={inventory}
            customers={customers}
            suppliers={suppliers}
            transactions={transactions}
            assets={assets}
            employees={employees}
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
            inventory={inventory}
            customers={customers}
            suppliers={suppliers}
            transactions={transactions}
            assets={assets}
            employees={employees}
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
            inventory={inventory}
            transactions={transactions}
            assets={assets}
            employees={employees}
            currentCurrency={currentCurrency}
            onRefreshData={refreshAllData}
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
            inventory={inventory}
            customers={customers}
            suppliers={suppliers}
            transactions={transactions}
            assets={assets}
            employees={employees}
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
            inventory={inventory}
            customers={customers}
            transactions={transactions}
            assets={assets}
            employees={employees}
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
            inventory={inventory}
            customers={customers}
            transactions={transactions}
            assets={assets}
            employees={employees}
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
            employees={employees}
            transactions={transactions}
            inventory={inventory}
            customers={customers}
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
          inventory={inventory}
          transactions={transactions}
          assets={assets}
          employees={employees}
          customers={customers}
          businesses={businesses}
          currentCurrency={currentCurrency}
          onRefreshData={refreshAllData}
          onSelectTab={setActiveTab}
        />
      );
    }

    // Shared Enterprise Module — Central Financial Report (Owner / GM only)
    if (activeTab === "FINANCE") {
      return (
        <EnterpriseFinanceView
          businesses={businesses}
          metrics={liveMetrics}
          transactions={transactions}
          inventory={inventory}
          customers={customers}
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
    if (activeTab === "TRACKING") {
      return (
        <CustomerTrackingPanel
          currentUser={currentUser}
          businesses={businesses}
          currentCurrency={currentCurrency}
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
          customers={customers}
          suppliers={suppliers}
          employees={employees}
          assets={assets}
          inventory={inventory}
          transactions={transactions}
          businesses={businesses}
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
          insights={aiInsights}
          businesses={businesses}
          currentCurrency={currentCurrency}
          onRefreshInsights={refreshAllData}
        />
      );
    }

    if (activeTab === "SCENARIO_PLANNER") {
      return (
        <ScenarioPlannerView
          scenarios={scenarios}
          businesses={businesses}
          currentCurrency={currentCurrency}
          onRefreshScenarios={refreshAllData}
        />
      );
    }

    if (activeTab === "INTEGRATIONS") {
      return (
        <IntegrationsHubView
          integrations={integrations}
          onRefreshIntegrations={refreshAllData}
          currentUser={currentUser}
          businesses={businesses}
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
          Loading consolidated Q1 financial records across 7 Ghanaian enterprise units...
        </p>
      </div>
    );
  }

  // No valid session → render ONLY the sign-in screen (no data is fetched).
  if (!signedIn || !currentUser) {
    return <LoginScreen onSuccess={handleLoginSuccess} notice={loginNotice} />;
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
        usersList={usersList}
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
            ? () => {
                // Branch managers land straight on their own unit's Online
                // panel; everyone else picks a unit from the list first.
                const preset =
                  currentUser?.role === "BRANCH_MANAGER"
                    ? currentUser?.assignedBusinessId ?? null
                    : businesses.length === 1
                    ? businesses[0].id
                    : null;
                setManageBizOnlineId(preset);
                setIsManageBizOpen(true);
              }
            : undefined
        }
        bellSlot={
          <NotificationBell
            currentUser={currentUser}
            onSummary={setAuditBell}
            onOpenSettings={() => setIsNotifSettingsOpen(true)}
            onOpenRecord={(n) => {
              // Order/purchase events open Customer Order & Tracking;
              // anything branch-scoped opens that unit's dashboard.
              const t = String(n?.type || "");
              if (t.startsWith("AUDIT")) { setActiveTab("AUDIT"); return; }
              if (
                t === "ONLINE_ORDER_RECEIVED" ||
                t === "ORDER_TRACKING_STATUS" ||
                t === "ORDER_ASSIGNED"
              ) {
                setActiveTab("TRACKING");
                return;
              }
              if (n?.branchCode && businesses.some((b: any) => b?.code === n.branchCode)) {
                setActiveTab(n.branchCode as ActiveTab);
                return;
              }
              setActiveTab("TRACKING");
            }}
            onOpenIssue={(n) => {
              // Responses / resolutions go to the reviewer's Audit Center;
              // flags, corrections & closures open the assignee's own inbox.
              const reviewerSide = n.type === "AUDIT_ISSUE_RESPONSE" || n.type === "AUDIT_ISSUE_RESOLVED";
              if (reviewerSide && (auditEligible || currentUser?.role === "OWNER" || !!currentUser?.canManageAuditors)) {
                setAuditFocusIssue(n.issueId);
                setActiveTab("AUDIT");
              } else {
                setMyIssueFocus(n.issueId ?? null);
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

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          businesses={businesses}
          currentUser={currentUser}
          auditEligible={auditEligible}
          onOpenSupportInfo={() => setIsSupportOpen(true)}
          accessibleBusinessIds={accessibleIds}
          onOpenManageBusinesses={() => { setManageBizOnlineId(null); setIsManageBizOpen(true); }}
        />

        <main className="flex-1 min-w-0 overflow-y-auto bg-slate-950/95 pb-12">
          <div className="sticky top-0 z-30 flex items-center justify-between xl:justify-end gap-2 px-4 sm:px-6 py-2 bg-slate-950/90 backdrop-blur border-b border-slate-800/80">
            {/* Compact "you are here" bar — phones/tablets/small laptops
                (the full right rail takes over at xl and wider). */}
            <div className="xl:hidden min-w-0 flex-1 flex">
              <ContextBar
                activeTab={activeTab}
                businesses={businesses}
                currentUser={currentUser}
                onOpen={() => setContextNavOpen(true)}
              />
            </div>
            <UniversalExportCenter
              activeModule={activeTab}
              currentUser={currentUser}
              businesses={businesses}
              data={{
                metrics: liveMetrics,
                users: usersList,
                customers,
                suppliers,
                employees,
                assets,
                inventory,
                transactions,
                aiInsights,
                scenarios,
                integrations,
                specializedLogs,
              }}
            />
          </div>
          {renderActiveView()}
        </main>

        {/* Right-side navigation & location panel (persistent rail ≥xl,
            slide-in drawer on smaller screens) — shows current Business,
            Branch, Section & Page everywhere in the app. */}
        <ContextNavigator
          activeTab={activeTab}
          onSelectTab={(t) => {
            setActiveTab(t);
            setContextNavOpen(false);
          }}
          businesses={businesses}
          currentUser={currentUser}
          open={contextNavOpen}
          onClose={() => setContextNavOpen(false)}
        />
      </div>

      <NewBusinessModal
        isOpen={isNewBusinessModalOpen}
        onClose={() => setIsNewBusinessModalOpen(false)}
        actorUserId={currentUser?.id ?? null}
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

      {/* 10-minute inactivity auto-logout (no UI). */}
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

      <ManageBusinessesModal
        isOpen={isManageBizOpen}
        onClose={() => setIsManageBizOpen(false)}
        businesses={businesses}
        currentUser={currentUser}
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
