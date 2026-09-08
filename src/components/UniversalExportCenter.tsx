"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Download,
  FileSpreadsheet,
  FileText,
  FileType,
  History,
  ShieldCheck,
  X,
  CheckCircle,
  XCircle,
  Clock,
  Filter,
  Loader2,
} from "lucide-react";
import {
  generateUniversalExport,
  generateUniversalExportId,
  triggerUniversalDownload,
  UniversalExportFormat,
  UniversalExportMeta,
  UniversalExportType,
} from "@/lib/universalExport";
import { resolveLogo } from "@/lib/logos";

interface Props {
  activeModule: string;
  currentUser: any;
  businesses: any[];
  data: {
    metrics: any[];
    users: any[];
    customers: any[];
    suppliers: any[];
    employees: any[];
    assets: any[];
    inventory: any[];
    transactions: any[];
    aiInsights: any[];
    scenarios: any[];
    integrations: any[];
    specializedLogs: Record<string, any[]>;
  };
}

const MODULE_LABELS: Record<string, string> = {
  COMMAND_CENTER: "Enterprise Command Center",
  SALES_CENTER: "Enterprise Sales & Payments",
  BRANCH_SALES: "Branch Sales & Payments",
  WORKER_DASHBOARD: "Worker Sales Workspace",
  CUSTOMERS: "Customers & CRM",
  SUPPLIERS: "Suppliers & Vendors",
  EMPLOYEES: "Employees & Payroll",
  ASSETS: "Assets & Equipment",
  BRANCH_ASSETS: "Branch Assets & Equipment",
  INVENTORY: "Inventory & Stock",
  TRANSACTIONS: "Enterprise Financial Transactions",
  USERS_MANAGE: "Enterprise Users & Assignments",
  WORKERS_MANAGE: "Branch Workers",
  AI_ADVISOR: "AI Strategic Advisor",
  SCENARIO_PLANNER: "Scenario Planning",
  INTEGRATIONS: "Integrations Hub",
  "POULTRY-01": "Poultry Farm Management",
  "BLOCK-01": "Block Factory Management",
  "AQUA-01": "Aquaculture Management",
  "LIVESTOCK-01": "Livestock Management",
  "FOOD-01": "Restaurant & Food Management",
  "TECH-01": "Electronics Shop Management",
  "WASH-01": "Car Wash Management",
  "TELECOM-01": "Telecom & Digital Services Management",
};

const BUSINESS_MODULES = new Set([
  "POULTRY-01",
  "BLOCK-01",
  "AQUA-01",
  "LIVESTOCK-01",
  "FOOD-01",
  "TECH-01",
  "WASH-01",
  "TELECOM-01",
]);

function addSection(section: string, rows: any[]) {
  return rows.map((row) => ({ section, ...row }));
}

function getRecordDate(row: any): string | null {
  const value =
    row.recordedDate ||
    row.date ||
    row.createdAt ||
    row.checklistDate ||
    row.deliveryDate ||
    row.arrivalDate ||
    row.requestedAt;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toISOString().slice(0, 10);
}

function dashboardSummary(records: any[]) {
  const groups: Record<string, any[]> = {};
  records.forEach((row) => {
    const key = row.section || "Records";
    (groups[key] ||= []).push(row);
  });
  return Object.entries(groups).map(([section, rows]) => {
    let amount = 0;
    let quantity = 0;
    rows.forEach((r) => {
      Object.entries(r).forEach(([k, v]) => {
        if (typeof v !== "number") return;
        if (/amount|revenue|expense|profit|totalghs|currentvalue|costghs/i.test(k)) amount += v;
        if (/quantity|count|blocks|birds|eggs|stock/i.test(k)) quantity += v;
      });
    });
    return {
      section,
      recordCount: rows.length,
      summarizedAmount: Number(amount.toFixed(2)),
      summarizedQuantity: Number(quantity.toFixed(2)),
    };
  });
}

export default function UniversalExportCenter({ activeModule, currentUser, businesses, data }: Props) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"CREATE" | "AUDIT">("CREATE");
  const [format, setFormat] = useState<UniversalExportFormat>("PDF");
  const [exportType, setExportType] = useState<UniversalExportType>("REPORT");
  const [scopeBusinessId, setScopeBusinessId] = useState<string>("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [history, setHistory] = useState<any[]>([]);

  const role = currentUser?.role || "WORKER";
  const isExecutive = role === "OWNER" || role === "GENERAL_MANAGER";
  const isWorker = role === "WORKER";
  const isBranchManager = role === "BRANCH_MANAGER";

  // Export permission model:
  // - OWNER / GM: always allowed
  // - BRANCH_MANAGER: allowed IF canExportData is true (direct download)
  // - WORKER: allowed IF canExportData is true, but always creates a PENDING request
  const hasExportPermission = isExecutive || currentUser?.canExportData === true;

  const effectiveModule = isWorker ? "WORKER_DASHBOARD" : activeModule;
  const moduleLabel = MODULE_LABELS[effectiveModule] || effectiveModule.replace(/_/g, " ");
  const activeBusiness = businesses.find((b) => b.code === effectiveModule);

  useEffect(() => {
    if (activeBusiness) setScopeBusinessId(String(activeBusiness.id));
    else if (isBranchManager || isWorker) setScopeBusinessId(String(currentUser?.assignedBusinessId || ""));
    else setScopeBusinessId("ALL");
  }, [effectiveModule, activeBusiness?.id, currentUser?.assignedBusinessId, isBranchManager, isWorker]);

  const scopeBusiness = businesses.find((b) => String(b.id) === scopeBusinessId);
  const branchLocked = !!activeBusiness || isBranchManager || isWorker;

  const filters = useMemo(
    () => ({ dateFrom: dateFrom || undefined, dateTo: dateTo || undefined }),
    [dateFrom, dateTo]
  );

  const loadAudit = async () => {
    if (!currentUser?.id) return;
    const res = await fetch(`/api/exports?userId=${currentUser.id}`);
    const payload = await res.json();
    if (payload.success) setHistory(payload.exports || []);
  };

  useEffect(() => {
    if (open) loadAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function loadRecords(
    moduleKey: string,
    businessId: number | null,
    savedFilters = filters,
    requestedExportType: UniversalExportType = exportType
  ) {
    let records: any[] = [];
    const scoped = (rows: any[]) =>
      businessId ? rows.filter((r) => r.businessId === businessId || r.assignedBusinessId === businessId) : rows;

    // Business-type dispatch: any unit of a type (original OR created later,
    // e.g. POULTRY-02 / BLOCK-02 / WASH-02) exports through the EXACT same
    // report builder as the original business of that type.
    const moduleBusiness = businesses.find((b) => b.code === moduleKey);
    const bizPrefix = moduleBusiness
      ? String(moduleBusiness.code || "").split("-")[0]?.toUpperCase()
      : "";

    if (moduleKey === "COMMAND_CENTER") {
      records = data.metrics
        .filter((metric) => !businessId || metric.businessId === businessId)
        .map((metric) => {
          const business = businesses.find((b) => b.id === metric.businessId);
          return {
            section: "Business Performance",
            businessId: business?.id,
            business: business?.name,
            branchCode: business?.code,
            region: business?.region,
            district: business?.district,
            town: business?.town,
            ...metric,
            salesTransactions: data.transactions.filter((t) => t.businessId === metric.businessId && t.type === "INCOME").length,
            inventoryItems: data.inventory.filter((i) => i.businessId === metric.businessId).length,
            assets: data.assets.filter((a) => a.businessId === metric.businessId).length,
          };
        });
    } else if (moduleBusiness && bizPrefix === "POULTRY") {
      const res = await fetch(`/api/poultry?businessId=${businessId || activeBusiness?.id}`);
      const p = await res.json();
      const clRes = await fetch(`/api/checklists?businessId=${businessId || activeBusiness?.id}`);
      const cl = await clRes.json();
      records = [
        ...addSection("Flocks", p.flocks || []),
        ...addSection("Feed", p.feedLogs || []),
        ...addSection("Water", p.waterLogs || []),
        ...addSection("Health & Vaccination", p.healthRecords || []),
        ...addSection("Production", p.production || []),
        ...addSection("Daily Checklist", cl.entries || []),
        ...addSection("Inventory", scoped(data.inventory)),
        ...addSection("Finance", scoped(data.transactions)),
      ];
    } else if (moduleBusiness && bizPrefix === "BLOCK") {
      const res = await fetch(`/api/block-factory?businessId=${businessId || activeBusiness?.id}`);
      const p = await res.json();
      const clRes = await fetch(`/api/checklists?businessId=${businessId || activeBusiness?.id}`);
      const cl = await clRes.json();
      records = [
        ...addSection("Production", p.production || []),
        ...addSection("Orders", p.orders || []),
        ...addSection("Deliveries", p.deliveries || []),
        ...addSection("Daily Checklist", cl.entries || []),
        ...addSection("Inventory", p.inventory || []),
        ...addSection("Finance", scoped(data.transactions)),
        ...addSection("Assets", scoped(data.assets)),
      ];
    } else if (moduleBusiness && bizPrefix === "TECH") {
      const res = await fetch(`/api/electronics?businessId=${businessId || activeBusiness?.id}`);
      const p = await res.json();
      const clRes = await fetch(`/api/checklists?businessId=${businessId || activeBusiness?.id}`);
      const cl = await clRes.json();
      records = [
        ...addSection("Orders", p.orders || []),
        ...addSection("Supplier Purchases", p.purchases || []),
        ...addSection("Warranty & Returns", p.warranties || []),
        ...addSection("Serial Number Registry", p.serials || []),
        ...addSection("Daily Checklist", cl.entries || []),
        ...addSection("Inventory", scoped(data.inventory)),
        ...addSection("Finance", scoped(data.transactions)),
        ...addSection("Assets", scoped(data.assets)),
        ...addSection("Employees", scoped(data.employees)),
      ];
    } else if (moduleBusiness && bizPrefix === "FOOD") {
      const res = await fetch(`/api/restaurant?businessId=${businessId || activeBusiness?.id}`);
      const p = await res.json();
      const clRes = await fetch(`/api/checklists?businessId=${businessId || activeBusiness?.id}`);
      const cl = await clRes.json();
      records = [
        ...addSection("Orders", p.orders || []),
        ...addSection("Menu", p.menu || []),
        ...addSection("Food Waste", p.waste || []),
        ...addSection("Supplier Purchases", p.purchases || []),
        ...addSection("Daily Checklist", cl.entries || []),
        ...addSection("Inventory", scoped(data.inventory)),
        ...addSection("Finance", scoped(data.transactions)),
        ...addSection("Customers", scoped(data.customers)),
        ...addSection("Employees", scoped(data.employees)),
      ];
    } else if (moduleBusiness && ["AQUA", "LIVESTOCK", "WASH"].includes(bizPrefix)) {
      const logMap: Record<string, string> = {
        AQUA: "aquaculture",
        LIVESTOCK: "livestock",
        WASH: "carWash",
      };
      // Only this unit's own operations logs — the type bucket is shared
      // across units of the same type (e.g. WASH-01 and WASH-02).
      const scopeId = businessId || moduleBusiness.id;
      const logs = (data.specializedLogs[logMap[bizPrefix]] || []).filter(
        (l: any) => !l.businessId || l.businessId === scopeId
      );
      const clRes = await fetch(`/api/checklists?businessId=${businessId || activeBusiness?.id}`);
      const cl = await clRes.json();
      records = [
        ...addSection("Operations", logs),
        ...addSection("Daily Checklist", cl.entries || []),
        ...addSection("Inventory", scoped(data.inventory)),
        ...addSection("Sales & Expenses", scoped(data.transactions)),
        ...addSection("Assets", scoped(data.assets)),
        ...addSection("Employees", scoped(data.employees)),
      ];
    } else if (["SALES_CENTER", "BRANCH_SALES", "WORKER_DASHBOARD"].includes(moduleKey)) {
      let docs: any[] = [];
      try {
        const query = businessId ? `?businessId=${businessId}` : "";
        const res = await fetch(`/api/sales-documents${query}`);
        const p = await res.json();
        docs = p.documents || [];
      } catch {}
      records = [
        ...addSection("Sales Documents", docs),
        ...addSection("Transactions", scoped(data.transactions)),
        ...addSection("Inventory", scoped(data.inventory)),
        ...addSection("Customers", scoped(data.customers)),
      ];
      if (moduleKey === "WORKER_DASHBOARD") {
        records = records.filter((r) =>
          r.section !== "Transactions" || r.recordedByUserId === currentUser?.id || r.recordedBy === currentUser?.name
        );
      }
    } else {
      const map: Record<string, any[]> = {
        CUSTOMERS: data.customers,
        SUPPLIERS: data.suppliers,
        EMPLOYEES: data.employees,
        ASSETS: data.assets,
        BRANCH_ASSETS: data.assets,
        INVENTORY: data.inventory,
        TRANSACTIONS: data.transactions,
        USERS_MANAGE: data.users,
        WORKERS_MANAGE: data.users.filter((u) => u.role === "WORKER"),
        AI_ADVISOR: data.aiInsights,
        SCENARIO_PLANNER: data.scenarios,
        INTEGRATIONS: data.integrations,
      };
      if (moduleKey in map) {
        records = addSection(moduleLabel, scoped(map[moduleKey]));
      } else if (businesses.find((b) => b.code === moduleKey)) {
        const moduleBusiness = businesses.find((b) => b.code === moduleKey)!;
        // Any auto-provisioned business unit (dynamic code): export its full
        // branch report — performance, stock, ledger and CRM — so reports are
        // never empty for newly created units.
        records = [
          ...addSection("Business Performance", data.metrics.filter((m) => m.businessId === moduleBusiness.id).map((m) => ({ ...m, business: moduleBusiness.name, branchCode: moduleBusiness.code }))),
          ...addSection("Inventory", scoped(data.inventory)),
          ...addSection("Transactions", scoped(data.transactions)),
          ...addSection("Customers", scoped(data.customers)),
        ];
      }
    }

    records = records.filter((r) => {
      const d = getRecordDate(r);
      if (savedFilters.dateFrom && d && d < savedFilters.dateFrom) return false;
      if (savedFilters.dateTo && d && d > savedFilters.dateTo) return false;
      return true;
    });
    return requestedExportType === "DASHBOARD" ? dashboardSummary(records) : records;
  }

  const buildMeta = (
    exportId: string,
    moduleKey: string,
    label: string,
    exportFormat: UniversalExportFormat,
    type: UniversalExportType,
    business: any,
    recordCount: number,
    exportFilters: any
  ): UniversalExportMeta => ({
    exportId,
    moduleKey,
    moduleLabel: label,
    exportType: type,
    format: exportFormat,
    exportedAt: new Date().toISOString(),
    userId: currentUser.id,
    userName: currentUser.name,
    userRole: currentUser.role,
    businessId: business?.id || null,
    businessName: business?.name || null,
    branchCode: business?.code || null,
    branchName: business?.name || null,
    logo: resolveLogo(business, business?.code || null),
    filters: exportFilters,
    recordCount,
  });

  async function directExport() {
    setBusy(true);
    setMessage("");
    try {
      const businessId = scopeBusinessId === "ALL" ? null : Number(scopeBusinessId);
      const records = await loadRecords(effectiveModule, businessId);
      const exportId = generateUniversalExportId(effectiveModule);
      const meta = buildMeta(exportId, effectiveModule, moduleLabel, format, exportType, scopeBusiness, records.length, filters);
      const result = await generateUniversalExport(records, meta);

      const auditRes = await fetch("/api/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...meta,
          requesterUserId: currentUser.id,
          filtersJson: filters,
          qrCodeData: result.qrCodeData,
          qrCodePayload: result.qrPayload,
          status: "COMPLETED",
        }),
      });
      const audit = await auditRes.json();
      if (!audit.success) throw new Error(audit.error || "Could not record export audit");
      triggerUniversalDownload(result.blob, result.fileName);
      setMessage(`Export completed: ${exportId}`);
      await loadAudit();
      // Close the audit window and return to the originating module after success.
      setOpen(false);
      setPanel("CREATE");
      setToast(`${format} export completed successfully — ${exportId}`);
      window.setTimeout(() => setToast(""), 5000);
    } catch (error: any) {
      setMessage(error.message || "Export failed");
    } finally {
      setBusy(false);
    }
  }

  async function requestWorkerExport() {
    setBusy(true);
    setMessage("");
    try {
      const businessId = Number(currentUser.assignedBusinessId);
      const records = await loadRecords(effectiveModule, businessId);
      const exportId = generateUniversalExportId(effectiveModule);
      const business = businesses.find((b) => b.id === businessId);
      const meta = buildMeta(exportId, effectiveModule, moduleLabel, format, exportType, business, records.length, filters);
      const res = await fetch("/api/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...meta,
          requesterUserId: currentUser.id,
          filtersJson: filters,
          status: "PENDING",
        }),
      });
      const p = await res.json();
      if (!p.success) throw new Error(p.error || "Could not request approval");
      setMessage(`Approval requested: ${exportId}`);
      setPanel("AUDIT");
      await loadAudit();
    } catch (error: any) {
      setMessage(error.message || "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function decision(row: any, action: "APPROVE" | "REJECT") {
    setBusy(true);
    const res = await fetch("/api/exports", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: row.id, action, actorUserId: currentUser.id }),
    });
    const p = await res.json();
    setMessage(p.success ? `${row.exportId} ${action.toLowerCase()}d` : p.error);
    await loadAudit();
    setBusy(false);
  }

  async function downloadApproved(row: any) {
    setBusy(true);
    setMessage("");
    try {
      const rowFilters = row.filtersJson || {};
      const records = await loadRecords(
        row.moduleKey,
        row.businessId,
        rowFilters,
        row.exportType as UniversalExportType
      );
      const business = businesses.find((b) => b.id === row.businessId);
      const meta = buildMeta(
        row.exportId,
        row.moduleKey,
        row.moduleLabel,
        row.format,
        row.exportType,
        business,
        records.length,
        rowFilters
      );
      const result = await generateUniversalExport(records, meta);
      const res = await fetch("/api/exports", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: row.id,
          action: "COMPLETE",
          actorUserId: currentUser.id,
          qrCodeData: result.qrCodeData,
          qrCodePayload: result.qrPayload,
          recordCount: records.length,
        }),
      });
      const p = await res.json();
      if (!p.success) throw new Error(p.error);
      triggerUniversalDownload(result.blob, result.fileName);
      setMessage(`Approved export downloaded: ${row.exportId}`);
      await loadAudit();
      setOpen(false);
      setPanel("CREATE");
      setToast(`${row.format} export downloaded successfully — ${row.exportId}`);
      window.setTimeout(() => setToast(""), 5000);
    } catch (error: any) {
      setMessage(error.message || "Download failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => { setMessage(""); setOpen(true); }}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-bold text-slate-200 shadow-lg transition"
        title={`Export ${moduleLabel}`}
      >
        <Download className="w-4 h-4 text-emerald-400" />
        <span>Export / Audit</span>
      </button>

      {toast && (
        <div className="fixed right-5 top-20 z-[100] max-w-sm rounded-xl border border-emerald-500/40 bg-slate-900/95 px-4 py-3 text-xs font-semibold text-emerald-300 shadow-2xl backdrop-blur animate-in fade-in slide-in-from-right-3">
          <CheckCircle className="mr-2 inline h-4 w-4" />
          {toast}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-[80] bg-black/75 backdrop-blur-sm p-4 flex items-center justify-center">
          <div className="w-full max-w-4xl max-h-[92vh] overflow-hidden bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col">
            <div className="p-5 border-b border-slate-800 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-white">Universal Export & Audit Center</h2>
                <p className="text-xs text-slate-400 mt-0.5">{moduleLabel} • PDF, Excel and CSV • QR verified</p>
              </div>
              <button onClick={() => setOpen(false)} className="p-1 rounded hover:bg-slate-800 text-slate-400"><X className="w-5 h-5" /></button>
            </div>

            <div className="px-5 pt-3 flex items-center gap-1">
              <button onClick={() => setPanel("CREATE")} className={`px-3 py-2 rounded-lg text-xs font-bold ${panel === "CREATE" ? "bg-emerald-600 text-white" : "text-slate-400 hover:bg-slate-800"}`}>
                <Download className="w-3.5 h-3.5 inline mr-1" />Create Export
              </button>
              <button onClick={() => { setPanel("AUDIT"); loadAudit(); }} className={`px-3 py-2 rounded-lg text-xs font-bold ${panel === "AUDIT" ? "bg-emerald-600 text-white" : "text-slate-400 hover:bg-slate-800"}`}>
                <History className="w-3.5 h-3.5 inline mr-1" />Audit / Approvals
                {isExecutive && history.filter((h) => h.status === "PENDING").length > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full bg-rose-500 text-white text-[9px]">{history.filter((h) => h.status === "PENDING").length}</span>
                )}
              </button>
            </div>

            <div className="p-5 overflow-y-auto flex-1">
              {message && (
                <div className={`mb-4 p-3 rounded-lg text-xs border ${/failed|error|reject|not/i.test(message) ? "bg-rose-500/10 border-rose-500/30 text-rose-300" : "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"}`}>
                  {message}
                </div>
              )}

              {panel === "CREATE" ? (
                <div className="space-y-5">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-400 mb-1">Module</label>
                      <div className="px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white">{moduleLabel}</div>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-400 mb-1">Business / Branch Scope</label>
                      <select
                        value={scopeBusinessId}
                        disabled={branchLocked}
                        onChange={(e) => setScopeBusinessId(e.target.value)}
                        className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white disabled:opacity-60"
                      >
                        {isExecutive && !activeBusiness && <option value="ALL">All Businesses & Branches</option>}
                        {businesses
                          .filter((b) => isExecutive || b.id === currentUser?.assignedBusinessId)
                          .map((b) => <option key={b.id} value={b.id}>{b.name} ({b.code})</option>)}
                      </select>
                      {branchLocked && <p className="text-[10px] text-slate-500 mt-1">Scope is locked to the selected or assigned branch.</p>}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-400 mb-2">Export Content</label>
                      <div className="grid grid-cols-2 gap-2">
                        {(["DASHBOARD", "REPORT"] as UniversalExportType[]).map((type) => (
                          <button key={type} onClick={() => setExportType(type)} className={`p-3 rounded-xl border text-left ${exportType === type ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300" : "bg-slate-800 border-slate-700 text-slate-300"}`}>
                            <div className="font-bold text-xs">{type === "DASHBOARD" ? "Dashboard Summary" : "Detailed Report"}</div>
                            <div className="text-[10px] opacity-70 mt-1">{type === "DASHBOARD" ? "KPIs and section totals" : "Full underlying records"}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-400 mb-2">File Format</label>
                      <div className="grid grid-cols-3 gap-2">
                        {([
                          ["PDF", FileText],
                          ["EXCEL", FileSpreadsheet],
                          ["CSV", FileType],
                        ] as any[]).map(([value, Icon]) => (
                          <button key={value} onClick={() => setFormat(value)} className={`p-3 rounded-xl border text-center ${format === value ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-300" : "bg-slate-800 border-slate-700 text-slate-300"}`}>
                            <Icon className="w-5 h-5 mx-auto" />
                            <div className="text-[10px] font-bold mt-1">{value}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400 mb-2"><Filter className="w-3.5 h-3.5" />Optional Date Filter</label>
                    <div className="grid grid-cols-2 gap-3">
                      <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white" />
                      <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white" />
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-800/70 border border-slate-700 text-[11px] text-slate-400 space-y-1">
                    <div><strong className="text-slate-200">Export identity:</strong> automatic unique Export ID</div>
                    <div><strong className="text-slate-200">Audit metadata:</strong> {currentUser?.name} ({role}), business, branch, date and time</div>
                    <div><strong className="text-slate-200">QR verification:</strong> embedded image in PDF/Excel and embedded SVG/data in CSV</div>
                    {isWorker && <div className="text-amber-300"><Clock className="w-3 h-3 inline mr-1" />Worker exports are submitted for approval before download.</div>}
                    {isBranchManager && <div className="text-cyan-300"><ShieldCheck className="w-3 h-3 inline mr-1" />Branch Manager export is automatically restricted to the assigned branch.</div>}
                  </div>

                  {!hasExportPermission ? (
                    <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
                      <ShieldCheck className="w-4 h-4 inline mr-1" />
                      You do not have export permission. {isWorker ? "Ask your Branch Manager to enable export access for your account." : "Please contact the Owner or General Manager to grant export access."}
                    </div>
                  ) : (
                    <div className="flex justify-end">
                      <button
                        onClick={isWorker ? requestWorkerExport : directExport}
                        disabled={busy}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : isWorker ? <Clock className="w-4 h-4" /> : <Download className="w-4 h-4" />}
                        {isWorker ? "Request Export Approval" : "Generate & Download"}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {history.length ? history.map((row) => (
                    <div key={row.id} className="p-3 rounded-xl bg-slate-800/70 border border-slate-700 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-[10px] text-emerald-300">{row.exportId}</span>
                          <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${row.status === "COMPLETED" ? "bg-emerald-500/20 text-emerald-300" : row.status === "APPROVED" ? "bg-cyan-500/20 text-cyan-300" : row.status === "REJECTED" ? "bg-rose-500/20 text-rose-300" : "bg-amber-500/20 text-amber-300"}`}>{row.status}</span>
                          <span className="px-2 py-0.5 rounded bg-slate-700 text-[9px] font-bold text-slate-300">{row.format}</span>
                        </div>
                        <div className="text-xs font-bold text-white mt-1">{row.moduleLabel} — {row.exportType}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {row.requesterName} ({row.requesterRole}) • {row.branchName || row.businessName || "Enterprise-wide"} • {new Date(row.requestedAt).toLocaleString()}
                        </div>
                        {row.approvedByName && <div className="text-[10px] text-cyan-400">Decision by {row.approvedByName}</div>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {isExecutive && row.status === "PENDING" && (
                          <>
                            <button onClick={() => decision(row, "REJECT")} disabled={busy} className="px-3 py-1.5 rounded-lg bg-rose-500/15 text-rose-300 hover:bg-rose-500 hover:text-white text-[10px] font-bold"><XCircle className="w-3 h-3 inline mr-1" />Reject</button>
                            <button onClick={() => decision(row, "APPROVE")} disabled={busy} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 text-[10px] font-bold"><CheckCircle className="w-3 h-3 inline mr-1" />Approve</button>
                          </>
                        )}
                        {isWorker && row.status === "APPROVED" && (
                          <button onClick={() => downloadApproved(row)} disabled={busy} className="px-3 py-1.5 rounded-lg bg-cyan-600 text-white hover:bg-cyan-500 text-[10px] font-bold"><Download className="w-3 h-3 inline mr-1" />Download Approved</button>
                        )}
                        {row.qrCodeData && <img src={row.qrCodeData} alt="Export QR" className="w-12 h-12 rounded border border-slate-600 bg-white" />}
                      </div>
                    </div>
                  )) : (
                    <div className="text-center py-12 text-sm text-slate-400">No export audit records for your permitted scope.</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
