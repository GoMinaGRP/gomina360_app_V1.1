"use client";

import React, { useMemo, useState } from "react";
import {
  Beef,
  LayoutDashboard,
  Landmark,
  TrendingUp,
  Activity,
  ClipboardCheck,
  ClipboardList,
  Package,
  ArrowRight,
  AlertTriangle,
} from "lucide-react";
import AiSectionGuide from "./AiSectionGuide";
import SpecializedBusinessView from "./SpecializedBusinessView";
import FinancialReportSection from "./FinancialReportSection";
import DailyChecklistPanel from "./DailyChecklistPanel";
import ExpenseEntryForm from "./ExpenseEntryForm";
import { CurrencyCode, formatMoney } from "@/lib/currency";

/**
 * LivestockModule — the Cattle & Small Ruminants unit gets the same tabbed
 * dashboard structure as every other business module:
 *
 *   OVERVIEW — headline KPIs, herd-log snapshot, low-stock alerts
 *   HERD & GRAZING — the full daily-operations workspace (logs, checklist)
 *   FINANCE — the complete Financial Report tab (revenue → trends → ledger)
 *
 * Tab names render beside every icon at every breakpoint, like the other
 * module tab bars.
 */

type Tab = "OVERVIEW" | "HERD" | "FINANCE" | "CHECKLIST";
const TABS: { key: Tab; label: string; icon: any }[] = [
  { key: "OVERVIEW", label: "Overview", icon: LayoutDashboard },
  { key: "HERD", label: "Herd & Grazing", icon: Beef },
  { key: "FINANCE", label: "Finance", icon: Landmark },
  { key: "CHECKLIST", label: "Daily Checklist", icon: ClipboardCheck },
];

interface LivestockModuleProps {
  businessCode: string;
  businessInfo: any;
  businessMetrics: any;
  specializedLogs: any[];
  currentCurrency: CurrencyCode;
  isOnline: boolean;
  onRefreshLogs: () => void;
  currentUser?: any;
  onRefreshData?: () => void;
  employees?: any[];
  transactions?: any[];
  inventory?: any[];
  customers?: any[];
}

export default function LivestockModule(props: LivestockModuleProps) {
  const {
    businessInfo,
    businessMetrics,
    specializedLogs,
    currentCurrency,
    transactions = [],
    inventory = [],
  } = props;
  const [showExpense, setShowExpense] = useState(false);
  const [tab, setTab] = useState<Tab>("OVERVIEW");

  const revenue = businessMetrics?.revenueGhs || 0;
  const expenses = businessMetrics?.expensesGhs || 0;
  const profit = businessMetrics?.netProfitGhs ?? revenue - expenses;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  const bizInventory = useMemo(
    () => (inventory || []).filter((i: any) => i.businessId === businessInfo?.id),
    [inventory, businessInfo?.id]
  );
  const lowStock = useMemo(
    () =>
      bizInventory.filter(
        (i: any) =>
          (i.quantity ?? 0) <= (i.minStockThreshold ?? 0) ||
          i.status === "LOW_STOCK" ||
          i.status === "OUT_OF_STOCK"
      ),
    [bizInventory]
  );
  const recentLogs = useMemo(
    () =>
      [...(specializedLogs || [])]
        .sort((a: any, b: any) => (b.id || 0) - (a.id || 0))
        .slice(0, 4),
    [specializedLogs]
  );
  const todayIso = new Date(
    Date.now() - new Date().getTimezoneOffset() * 60000
  ).toISOString().slice(0, 10);
  const logsToday = (specializedLogs || []).filter(
    (l: any) => String(l.logDate || l.createdAt || "").startsWith(todayIso)
  ).length;

  const stat = (
    label: string,
    value: string,
    sub: string,
    icon: any,
    tone: string,
    testid: string
  ) => (
    <div
      className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow"
      data-testid={testid}
    >
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
          {label}
        </p>
        {React.createElement(icon, { className: `w-4 h-4 ${tone}` })}
      </div>
      <p className="text-xl sm:text-2xl font-extrabold text-white mt-1">{value}</p>
      <p className="text-[10px] text-slate-400 mt-1 font-semibold">{sub}</p>
    </div>
  );

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-[1500px] mx-auto text-slate-100" data-testid="lk-module">
      {/* Header (module pattern) */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 rounded-2xl border border-slate-700/80 p-5 shadow-2xl flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-start space-x-4">
          <div className="w-14 h-14 rounded-2xl bg-orange-500/15 border border-orange-500/30 flex items-center justify-center shadow-lg shrink-0">
            <Beef className="w-7 h-7 text-orange-400" />
          </div>
          <div>
            <span className="px-2.5 py-0.5 rounded-full bg-orange-500/20 text-orange-300 text-xs font-bold border border-orange-500/30">
              LIVESTOCK UNIT
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 text-white">
              {businessInfo?.name || "Livestock"}
            </h2>
            <p className="text-xs sm:text-sm text-slate-300 mt-1">
              Cattle & small ruminants — herd diary, grazing and health logging,
              inventory and a complete live Financial Report.
            </p>
          </div>
        </div>
        <span
          className={`self-start md:self-center px-3 py-1.5 rounded-full text-[10px] font-bold border inline-flex items-center gap-1.5 ${
            props.isOnline
              ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
              : "bg-amber-500/15 border-amber-500/40 text-amber-300"
          }`}
        >
          <Activity className="w-3 h-3" />
          {props.isOnline ? "Live data" : "Offline — queued"}
        </span>
      </div>

      {/* Tab bar — label below/beside every icon, always visible */}
      <div className="flex items-center gap-1.5 flex-wrap bg-slate-800/70 border border-slate-700/60 rounded-xl p-1.5 w-fit" data-testid="lk-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            data-testid={`lk-tab-${t.key}`}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition ${
              tab === t.key ? "bg-orange-600 text-white" : "text-slate-400 hover:text-white"
            }`}
          >
            <t.icon className="w-3.5 h-3.5" />
            <span>{t.label}</span>
          </button>
        ))}
        <button
          data-testid="lk-open-expense"
          onClick={() => setShowExpense(true)}
          className="ml-auto flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold"
        >
          <Landmark className="w-3.5 h-3.5" />Record Expense
        </button>
        <AiSectionGuide moduleKey="LIVESTOCK" section={tab === "FINANCE" ? "FINANCE_REPORT" : tab === "HERD" ? "OPERATIONS" : "DEFAULT"} businessInfo={businessInfo} />
      </div>

      {/* ═══ OVERVIEW ═══ */}
      {tab === "OVERVIEW" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {stat("Revenue (live)", formatMoney(revenue, currentCurrency, true), "baseline + live sales", TrendingUp, "text-emerald-400", "lk-stat-revenue")}
            {stat("Net Profit", formatMoney(profit, currentCurrency, true), `${margin.toFixed(1)}% margin`, Activity, profit >= 0 ? "text-emerald-400" : "text-rose-400", "lk-stat-profit")}
            {stat("Operations Logged", String((specializedLogs || []).length), `${logsToday} entr${logsToday === 1 ? "y" : "ies"} today`, ClipboardList, "text-orange-400", "lk-stat-logs")}
            {stat("Stock Items", String(bizInventory.length), lowStock.length ? `${lowStock.length} low — reorder now` : "stock healthy", Package, lowStock.length ? "text-amber-400" : "text-cyan-400", "lk-stat-stock")}
          </div>

          {lowStock.length > 0 && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-1" data-testid="lk-alerts">
              {lowStock.slice(0, 4).map((i: any) => (
                <div key={i.id} className="flex items-center gap-2 text-xs text-amber-200">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  {i.name} — {i.quantity} {i.unit} left (threshold {i.minStockThreshold})
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow">
              <h3 className="text-sm font-bold text-white flex items-center gap-2 mb-3">
                <Beef className="w-4 h-4 text-orange-400" /> Latest Herd Activity
              </h3>
              {recentLogs.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No herd records yet — open Herd &amp; Grazing and log the first animal entry.
                </p>
              ) : (
                <div className="space-y-2">
                  {recentLogs.map((l: any) => (
                    <div key={l.id} className="flex items-center justify-between gap-3 bg-slate-900/60 border border-slate-700/50 rounded-lg px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-slate-200 truncate">
                          {l.animalType || "Animal"} {l.tagNumber ? `· ${l.tagNumber}` : ""} {l.breed ? `· ${l.breed}` : ""}
                        </p>
                        <p className="text-[10px] text-slate-500">
                          {l.logDate || (l.createdAt ? String(l.createdAt).slice(0, 10) : "")}
                          {l.weightKg ? ` · ${l.weightKg} kg` : ""}
                          {l.vaccinationStatus ? ` · ${l.vaccinationStatus}` : ""}
                        </p>
                      </div>
                      {l.pregnant ? (
                        <span className="px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/30 text-rose-300 text-[9px] font-bold shrink-0">PREGNANT</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
              <button
                onClick={() => setTab("HERD")}
                data-testid="lk-open-herd"
                className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-bold text-orange-300 hover:text-orange-200"
              >
                Open Herd &amp; Grazing workspace <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow">
              <h3 className="text-sm font-bold text-white flex items-center gap-2 mb-3">
                <Landmark className="w-4 h-4 text-orange-400" /> Finance Snapshot
              </h3>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between"><span className="text-slate-400">Revenue</span><span className="font-bold text-emerald-300">{formatMoney(revenue, currentCurrency)}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Expenses</span><span className="font-bold text-rose-300">{formatMoney(expenses, currentCurrency)}</span></div>
                <div className="flex justify-between border-t border-slate-700/60 pt-2"><span className="text-slate-300 font-semibold">Net Profit</span><span className={`font-extrabold ${profit >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{formatMoney(profit, currentCurrency)}</span></div>
                <p className="text-[10px] text-slate-500 pt-1">
                  Full P&amp;L, payments, outstanding balances and day/month/year trends live in the Finance tab — updated the moment a sale or expense posts anywhere in this unit.
                </p>
              </div>
              <button
                onClick={() => setTab("FINANCE")}
                data-testid="lk-open-finance"
                className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-bold text-orange-300 hover:text-orange-200"
              >
                Open the full Financial Report <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ HERD & GRAZING — the full specialized ops workspace ═══ */}
      {tab === "HERD" && (
        <SpecializedBusinessView
          businessCode={props.businessCode}
          businessInfo={businessInfo}
          businessMetrics={businessMetrics}
          specializedLogs={specializedLogs}
          currentCurrency={currentCurrency}
          isOnline={props.isOnline}
          onRefreshLogs={props.onRefreshLogs}
          currentUser={props.currentUser}
          employees={props.employees}
          transactions={transactions}
          inventory={inventory}
          customers={props.customers}
          hideFinanceReport
        />
      )}

      {/* ═══ FINANCE — complete live Financial Report tab ═══ */}
      {tab === "FINANCE" && (
        <FinancialReportSection
          mode="business"
          businessInfo={businessInfo}
          businessMetric={businessMetrics}
          transactions={transactions}
          inventory={inventory}
          customers={props.customers || []}
          currentCurrency={currentCurrency}
          accent="orange"
          testid="fin-report-livestock"
          aiModuleKey="LIVESTOCK"
          opsLinks={[
            {
              label: "Operations logged",
              value: String((specializedLogs || []).length),
              note: "Daily herd/milking/grazing log entries for this unit",
              tone: "amber",
            },
          ]}
        />
      )}

      {/* ═══ DAILY CHECKLIST + DAILY NOTES (AI-analysed) ═══ */}
      {tab === "CHECKLIST" && (
        <DailyChecklistPanel
          businessId={businessInfo?.id}
          branchCode={props.businessCode}
          businessName={businessInfo?.name}
          employees={props.employees || []}
          currentUser={props.currentUser}
          accent="orange"
          onChanged={props.onRefreshLogs}
        />
      )}

      <ExpenseEntryForm
        isOpen={showExpense}
        onClose={() => setShowExpense(false)}
        onSaved={() => { setShowExpense(false); props.onRefreshData?.(); props.onRefreshLogs(); }}
        businessId={businessInfo?.id}
        branchCode={props.businessCode}
        branchName={businessInfo?.name}
        businessName={businessInfo?.name}
        currentUser={props.currentUser}
        title="Record Expense — Livestock"
        contextLabel="Livestock"
        vendorPlaceholder="e.g. fodder / feed supplier"
        defaultCategory="Feed & Fodder"
        defaultCategories={[
          { value: "Feed & Fodder", label: "Feed & Fodder" },
          { value: "Veterinary", label: "Veterinary" },
          { value: "Vaccination", label: "Vaccination" },
          { value: "Water", label: "Water" },
          { value: "Labor", label: "Labor" },
          { value: "Transport", label: "Transport" },
          { value: "Fencing & Repair", label: "Fencing & Repair" },
          { value: "Miscellaneous", label: "Miscellaneous" },
        ]}
        testid="lk-expense"
      />
    </div>
  );
}
