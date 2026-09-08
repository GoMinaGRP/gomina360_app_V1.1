"use client";

import React, { useMemo } from "react";
import {
  Landmark,
  TrendingUp,
  TrendingDown,
  Minus,
  Wallet,
  Trophy,
  Banknote,
  RefreshCw,
} from "lucide-react";
import AiSectionGuide from "./AiSectionGuide";
import FinancialReportSection from "./FinancialReportSection";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import {
  computeFinancialReport,
  getFinancePeriod,
  recoverBaseline,
} from "@/lib/financeReport";

/**
 * EnterpriseFinanceView — the detailed CENTRAL Financial Report, surfaced as
 * its own module under “Shared Enterprise Modules” (Owner / GM only).
 *
 * On top of the shared report engine it adds a Group Pulse strip — this
 * month's revenue with last-month delta, cash collected, group net profit &
 * margin, and the best-performing unit — all recomputed live from the same
 * ledger (sales, purchases, inventory, production, orders, expenses,
 * payments) that feeds every unit dashboard.
 */

interface EnterpriseFinanceViewProps {
  businesses: any[];
  /** liveMetrics rows from GoMinaApp (carry baselineTxId for baseline recovery). */
  metrics: any[];
  transactions: any[];
  inventory?: any[];
  customers?: any[];
  currentCurrency: CurrencyCode;
  isOnline: boolean;
  onRefreshData: () => void;
  currentUser?: any;
}

export default function EnterpriseFinanceView({
  businesses,
  metrics,
  transactions,
  inventory = [],
  customers = [],
  currentCurrency,
  isOnline,
  onRefreshData,
  currentUser,
}: EnterpriseFinanceViewProps) {
  const money = (ghs: number, compact = false) =>
    formatMoney(ghs, currentCurrency, compact);

  // ── Group Pulse: MTD vs last month + all-time per-unit ranking ──────────
  const mtdReport = useMemo(
    () =>
      computeFinancialReport({
        transactions,
        businessId: null,
        baseline: null, // Q1-2026 baselines sit in March — never inside a month window
        period: getFinancePeriod("THIS_MONTH"),
        granularity: "DAY",
      }),
    [transactions]
  );

  const unitRows = useMemo(
    () =>
      (businesses || []).map((b) => {
        const txns = (transactions || []).filter((t) => t.businessId === b.id);
        const metric = (metrics || []).find((m) => m.businessId === b.id);
        const baseline = metric ? recoverBaseline(metric, txns) : null;
        const rep = computeFinancialReport({
          transactions,
          businessId: b.id,
          baseline,
          period: getFinancePeriod("ALL_TIME"),
          granularity: "YEAR",
        });
        return { biz: b, revenue: rep.revenue, profit: rep.profit };
      }),
    [businesses, metrics, transactions]
  );

  const groupRevenue = unitRows.reduce((a, r) => a + r.revenue, 0);
  const groupProfit = unitRows.reduce((a, r) => a + r.profit, 0);
  const groupMargin = groupRevenue > 0 ? (groupProfit / groupRevenue) * 100 : 0;
  const topUnit =
    unitRows.length > 0
      ? [...unitRows].sort((a, b) => b.profit - a.profit)[0]
      : null;

  const deltaBadge = (pct: number | null) => {
    if (pct === null || !isFinite(pct))
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-400">
          <Minus className="w-3 h-3" /> no prior-month data
        </span>
      );
    const up = pct >= 0;
    return (
      <span
        className={`inline-flex items-center gap-1 text-[10px] font-bold ${
          up ? "text-emerald-300" : "text-rose-300"
        }`}
      >
        {up ? (
          <TrendingUp className="w-3 h-3" />
        ) : (
          <TrendingDown className="w-3 h-3" />
        )}
        {up ? "+" : ""}
        {pct.toFixed(1)}% vs last month
      </span>
    );
  };

  return (
    <div
      className="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto text-slate-100"
      data-testid="central-finance"
    >
      {/* Header banner (shared-module styling) */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-6 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-start space-x-4">
          <div className="w-14 h-14 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center shadow-lg shrink-0">
            <Landmark className="w-6 h-6 text-cyan-400" />
          </div>
          <div>
            <span className="px-2.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 text-xs font-bold border border-cyan-500/30">
              CENTRALIZED ENTERPRISE SYSTEM
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 text-white">
              Central Financial Report
            </h2>
            <p className="text-xs sm:text-sm text-slate-300 mt-1">
              Consolidated revenue, expenses, profit, payments and outstanding
              money across every business and register — live from sales,
              purchases, inventory, production, orders, expenses and payments.
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <AiSectionGuide moduleKey="SHARED" section="FINANCE" variant="header" />
          <button
            onClick={onRefreshData}
            data-testid="central-finance-refresh"
            title="Reload all live data"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold border border-slate-600 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/* ── Group Pulse — the executive headline numbers ── */}
      <div
        className="grid grid-cols-2 lg:grid-cols-4 gap-3"
        data-testid="central-finance-pulse"
      >
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              Revenue — This Month
            </p>
            <TrendingUp className="w-4 h-4 text-cyan-400" />
          </div>
          <p
            className="text-xl sm:text-2xl font-extrabold text-cyan-300 mt-1"
            data-testid="central-finance-pulse-mtd"
          >
            {money(mtdReport.revenue)}
          </p>
          <div className="mt-1">{deltaBadge(mtdReport.revenueDeltaPct)}</div>
        </div>

        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              Cash Collected — This Month
            </p>
            <Banknote className="w-4 h-4 text-emerald-400" />
          </div>
          <p
            className="text-xl sm:text-2xl font-extrabold text-emerald-300 mt-1"
            data-testid="central-finance-pulse-cash"
          >
            {money(mtdReport.cashCollected)}
          </p>
          <p className="text-[10px] text-slate-400 mt-1 font-semibold">
            {mtdReport.salesCount} receipt{mtdReport.salesCount === 1 ? "" : "s"}
            {" "}· expenses {money(mtdReport.expenses)}
          </p>
        </div>

        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              Net Profit — Group · All Time
            </p>
            <Wallet
              className={`w-4 h-4 ${
                groupProfit >= 0 ? "text-emerald-400" : "text-rose-400"
              }`}
            />
          </div>
          <p
            className={`text-xl sm:text-2xl font-extrabold mt-1 ${
              groupProfit >= 0 ? "text-emerald-300" : "text-rose-300"
            }`}
            data-testid="central-finance-pulse-profit"
          >
            {money(groupProfit)}
          </p>
          <p
            className="text-[10px] text-slate-400 mt-1 font-semibold"
            data-testid="central-finance-pulse-margin"
          >
            {groupMargin.toFixed(1)}% margin on {money(groupRevenue, true)}
          </p>
        </div>

        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              Top Performing Unit
            </p>
            <Trophy className="w-4 h-4 text-amber-400" />
          </div>
          <p
            className="text-base sm:text-lg font-extrabold text-amber-300 mt-1 truncate"
            title={topUnit?.biz?.name}
            data-testid="central-finance-pulse-top"
          >
            {topUnit ? topUnit.biz.name : "—"}
          </p>
          <p className="text-[10px] text-slate-400 mt-1 font-semibold">
            {topUnit ? `profit ${money(topUnit.profit)} · ` : ""}
            {unitRows.length} unit{unitRows.length === 1 ? "" : "s"} reporting
          </p>
        </div>
      </div>

      {/* ── The complete central report (all filters, trends, tables) ── */}
      <FinancialReportSection
        mode="enterprise"
        businesses={businesses}
        metrics={metrics}
        transactions={transactions}
        inventory={inventory}
        customers={customers}
        currentCurrency={currentCurrency}
        accent="cyan"
        testid="fin-report-central"
        aiModuleKey="SHARED"
        title="Consolidated Financial Report — All Businesses & Branches"
        subtitle="Revenue, sales, expenses, profit, payments, outstanding and trends — filtered by days, months and years, per business and per branch/register."
      />
    </div>
  );
}
