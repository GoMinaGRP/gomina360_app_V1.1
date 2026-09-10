"use client";

import React, { useState } from "react";
import AiSectionGuide from "./AiSectionGuide";
import {
  TrendingUp,
  DollarSign,
  PieChart,
  ShieldCheck,
  ArrowUpRight,
  ArrowDownRight,
  Building2,
  Sliders,
  Sparkles,
  AlertTriangle,
  LifeBuoy,
  ExternalLink,
  Zap,
  CheckCircle,
  ClipboardCheck,
  Plus,
  Settings2,
  Users,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  AreaChart,
  Area,
} from "recharts";
import { CurrencyCode, formatMoney, convertGhs } from "@/lib/currency";
import { ActiveTab } from "./Sidebar";
import FinancialReportSection from "./FinancialReportSection";

interface CommandCenterDashboardProps {
  businesses: any[];
  metrics: any[];
  transactions: any[];
  inventory: any[];
  currentCurrency: CurrencyCode;
  onSelectTab: (tab: ActiveTab) => void;
  onOpenNewBusinessModal: () => void;
  onOpenManageBusinesses?: () => void;
  onOpenUserAccess?: () => void;
  /** Opens the Customer Support (storefront HELP) editor. */
  onOpenSupportInfo?: () => void;
  /** OWNER or staff carrying the OWNER-granted canManageSupport permission. */
  canManageSupportInfo?: boolean;
  canManageBusinesses?: boolean;
  /** OWNER or any user the OWNER granted "Manage Unit" (businessManageIds) —
   *  opens the Manage Businesses & Branches console for their granted units. */
  canOpenManageUnits?: boolean;
  /** OWNER or staff carrying the OWNER-granted "New Branch/Unit" permission —
   *  may open the New Branch / Unit creation modal (UI affordance for the
   *  POST /api/businesses gate). */
  canCreateBusiness?: boolean;
  /** OWNER/GM/BM/record-manager — may open Manage Units for the online-ordering
   *  & service-area panel (destructive actions stay OWNER-only inside). */
  canManageOnline?: boolean;
  // OWNER or an OWNER-delegated manager (Users & Access console access).
  canManageUsersConsole?: boolean;
  checklists?: { templates: any[]; entries: any[] };
}

export default function CommandCenterDashboard({
  businesses,
  metrics,
  transactions,
  inventory,
  currentCurrency,
  onSelectTab,
  onOpenNewBusinessModal,
  onOpenManageBusinesses,
  onOpenUserAccess,
  onOpenSupportInfo,
  canManageSupportInfo = false,
  canManageBusinesses = false,
  canOpenManageUnits = false,
  canCreateBusiness = false,
  canManageOnline = false,
  canManageUsersConsole = false,
  checklists,
}: CommandCenterDashboardProps) {
  const [chartView, setChartView] = useState<
    "PROFIT_BAR" | "ROI_RADAR" | "CASH_AREA" | "SALES_BAR" | "ASSETS_BAR"
  >("PROFIT_BAR");
  // Which businesses to include in the comparison (default: all selected)
  const [selectedBizIds, setSelectedBizIds] = useState<number[]>(
    businesses.map((b) => b.id)
  );
  // Compare by individual Business, or roll up by Branch (region)
  const [groupBy, setGroupBy] = useState<"BUSINESS" | "BRANCH">("BUSINESS");

  // Keep selection in sync if the business list changes
  const allBizIds = businesses.map((b) => b.id);
  const effectiveSelected = selectedBizIds.filter((id) => allBizIds.includes(id));
  const selectedSet = effectiveSelected.length > 0 ? new Set(effectiveSelected) : new Set(allBizIds);

  // Live sales counts per business from transactions
  const salesCountByBiz = (bizId: number) =>
    transactions.filter((t) => t.businessId === bizId && t.type === "INCOME").length;
  const liveInventoryValueByBiz = (bizId: number) =>
    inventory
      .filter((i) => i.businessId === bizId)
      .reduce((acc, i) => acc + (i.quantity || 0) * (i.costPriceGhs || 0), 0);

  // Merge businesses with their metrics
  const comparisonData = businesses.map((biz) => {
    const bizMetrics =
      // No quarterly metric row (brand-new unit): honest ZEROS — never
      // invent GH₵50k/30k phantom figures for an empty business. Its live
      // activity layers in via liveMetrics from the first recorded entry.
      metrics.find((m) => m.businessId === biz.id) || {
        revenueGhs: 0,
        expensesGhs: 0,
        netProfitGhs: 0,
        roiPercent: 0,
        cashFlowGhs: 0,
        assetsValueGhs: 0,
        inventoryValueGhs: 0,
        growthRatePercent: 0,
        riskScore: 0,
      };

    return {
      id: biz.id,
      code: biz.code,
      name: biz.name,
      shortName: biz.name.replace("Mina ", "").replace(" & ", "/"),
      category: biz.category,
      branchLocation: biz.branchLocation,
      region: biz.region,
      district: biz.district,
      town: biz.town,
      managerName: biz.managerName,
      revenueGhs: bizMetrics.revenueGhs,
      expensesGhs: bizMetrics.expensesGhs,
      netProfitGhs: bizMetrics.netProfitGhs,
      roiPercent: bizMetrics.roiPercent,
      cashFlowGhs: bizMetrics.cashFlowGhs,
      assetsValueGhs: bizMetrics.assetsValueGhs,
      inventoryValueGhs: bizMetrics.inventoryValueGhs,
      growthRatePercent: bizMetrics.growthRatePercent,
      riskScore: bizMetrics.riskScore,
      salesCount: salesCountByBiz(biz.id),
      liveInventoryValueGhs: liveInventoryValueByBiz(biz.id),
    };
  });

  // Apply the selected-business filter
  const filteredData = comparisonData.filter((d) => selectedSet.has(d.id));

  // When grouping by Branch (region), aggregate the selected businesses by region
  const groupedData =
    groupBy === "BRANCH"
      ? Object.values(
          filteredData.reduce((acc: Record<string, any>, d) => {
            const key = d.region || "Unassigned";
            if (!acc[key]) {
              acc[key] = {
                name: key,
                shortName: key,
                region: key,
                units: 0,
                revenueGhs: 0,
                expensesGhs: 0,
                netProfitGhs: 0,
                cashFlowGhs: 0,
                assetsValueGhs: 0,
                inventoryValueGhs: 0,
                growthRatePercent: 0,
                riskScore: 0,
                salesCount: 0,
                liveInventoryValueGhs: 0,
                roiPercent: 0,
              };
            }
            const g = acc[key];
            g.units += 1;
            g.revenueGhs += d.revenueGhs;
            g.expensesGhs += d.expensesGhs;
            g.netProfitGhs += d.netProfitGhs;
            g.cashFlowGhs += d.cashFlowGhs;
            g.assetsValueGhs += d.assetsValueGhs;
            g.inventoryValueGhs += d.inventoryValueGhs;
            g.growthRatePercent += d.growthRatePercent;
            g.riskScore += d.riskScore;
            g.salesCount += d.salesCount;
            g.liveInventoryValueGhs += d.liveInventoryValueGhs;
            return acc;
          }, {})
        ).map((g: any) => ({
          ...g,
          growthRatePercent: Number((g.growthRatePercent / g.units).toFixed(1)),
          riskScore: Math.round(g.riskScore / g.units),
          roiPercent: g.assetsValueGhs
            ? Number(((g.netProfitGhs / g.assetsValueGhs) * 100).toFixed(1))
            : 0,
        }))
      : filteredData;

  // The dataset used by charts & tables
  const displayData = groupedData;

  // Calculate combined KPI totals across the SELECTED + grouped scope
  const totalRevenue = displayData.reduce((acc, b) => acc + b.revenueGhs, 0);
  const totalExpenses = displayData.reduce((acc, b) => acc + b.expensesGhs, 0);
  const totalNetProfit = displayData.reduce((acc, b) => acc + b.netProfitGhs, 0);
  const totalCashFlow = displayData.reduce((acc, b) => acc + b.cashFlowGhs, 0);
  const totalAssets = displayData.reduce((acc, b) => acc + b.assetsValueGhs, 0);
  const totalInventory = displayData.reduce(
    (acc, b) => acc + (b.inventoryValueGhs || 0),
    0
  );
  const totalSalesCount = displayData.reduce((acc, b) => acc + (b.salesCount || 0), 0);

  const avgRoi =
    displayData.length > 0
      ? Number(
          (displayData.reduce((acc, b) => acc + b.roiPercent, 0) / displayData.length).toFixed(1)
        )
      : 0;

  const avgGrowth =
    displayData.length > 0
      ? Number(
          (displayData.reduce((acc, b) => acc + b.growthRatePercent, 0) / displayData.length).toFixed(1)
        )
      : 0;

  const avgRisk =
    displayData.length > 0
      ? Math.round(displayData.reduce((acc, b) => acc + b.riskScore, 0) / displayData.length)
      : 0;

  // Chart dataset formatted in current currency
  const chartDataset = displayData.map((d) => ({
    name: d.shortName,
    Revenue: convertGhs(d.revenueGhs, currentCurrency),
    Expenses: convertGhs(d.expensesGhs, currentCurrency),
    Profit: convertGhs(d.netProfitGhs, currentCurrency),
    ROI: d.roiPercent,
    Risk: d.riskScore,
    CashFlow: convertGhs(d.cashFlowGhs, currentCurrency),
    Sales: d.salesCount,
    Assets: convertGhs(d.assetsValueGhs, currentCurrency),
    Inventory: convertGhs(d.inventoryValueGhs, currentCurrency),
  }));

  // Selection helpers
  const toggleBiz = (id: number) => {
    setSelectedBizIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };
  const selectAllBiz = () => setSelectedBizIds(allBizIds);
  const clearBiz = () => setSelectedBizIds([]);

  const todayStr = new Date().toISOString().split("T")[0];
  const clEntries = checklists?.entries || [];
  const checklistStats = (businesses || []).map((b) => {
    const rows = clEntries.filter((e) => e.businessId === b.id && e.checklistDate === todayStr);
    const done = rows.filter((e) => e.isCompleted).length;
    return {
      id: b.id,
      name: (b.name || "").replace("Mina ", ""),
      total: rows.length,
      done,
      pct: rows.length ? Math.round((done / rows.length) * 100) : 0,
    };
  });
  const checklistTotals = checklistStats.reduce<{ done: number; total: number }>(
    (acc, c) => ({ done: acc.done + c.done, total: acc.total + c.total }),
    { done: 0, total: 0 }
  );
  const checklistTotalsPct = checklistTotals.total ? Math.round((checklistTotals.done / checklistTotals.total) * 100) : 0;

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto text-slate-100" data-testid="command-center-root">
      {/* Top Welcome & Quick Actions */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-6 rounded-2xl border border-slate-700/80 shadow-2xl">
        <div>
          <div className="flex items-center space-x-2">
            <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-bold border border-emerald-500/30">
              EXECUTIVE COMMAND CENTER • 360° VIEW
            </span>
            <span className="text-xs text-slate-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
              Live Consolidated Operating Report • Q1 2026 + real-time activity
            </span>
          </div>
          <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 text-white">
            Enterprise Performance Overview
          </h2>
          <p className="text-sm text-slate-300 mt-1 max-w-2xl">
            Compare revenue, expenses, net profit, ROI %, cash flow, assets, inventory, growth, and risks across all 7 Ghanaian operating units.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={() => onSelectTab("AI_ADVISOR")}
            className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-yellow-600 hover:from-amber-400 hover:to-yellow-500 text-slate-950 font-bold text-xs sm:text-sm shadow-md transition"
          >
            <Sparkles className="w-4 h-4" />
            <span>AI Strategic Advisor</span>
          </button>

          <button
            onClick={() => onSelectTab("SCENARIO_PLANNER")}
            className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-teal-300 border border-teal-500/40 font-semibold text-xs sm:text-sm transition"
          >
            <Sliders className="w-4 h-4" />
            <span>Scenario Planner</span>
          </button>

          <AiSectionGuide moduleKey="COMMAND_CENTER" section="COMMAND_CENTER" variant="header" />
          {(canManageBusinesses || canOpenManageUnits || canManageOnline) && onOpenManageBusinesses && (
            <button
              onClick={onOpenManageBusinesses}
              data-testid="open-manage-businesses"
              className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs sm:text-sm shadow-lg transition"
            >
              <Settings2 className="w-4 h-4" />
              <span>Manage Units</span>
            </button>
          )}
          {canCreateBusiness && (
            <button
              onClick={onOpenNewBusinessModal}
              data-testid="open-new-business"
              className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs sm:text-sm shadow-lg transition"
            >
              <Plus className="w-4 h-4" />
              <span>New Branch / Unit</span>
            </button>
          )}
          {(canManageBusinesses || canManageUsersConsole) && onOpenUserAccess && (
            <button
              onClick={onOpenUserAccess}
              data-testid="open-user-access"
              className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-xs sm:text-sm shadow-lg transition"
            >
              <Users className="w-4 h-4" />
              <span>Users &amp; Access</span>
            </button>
          )}
          {canManageSupportInfo && onOpenSupportInfo && (
            <button
              onClick={onOpenSupportInfo}
              data-testid="open-support-info"
              title="Edit the customer support information shown in the storefront HELP panel"
              className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs sm:text-sm shadow-lg transition"
            >
              <LifeBuoy className="w-4 h-4" />
              <span>Storefront HELP</span>
            </button>
          )}
        </div>
      </div>

      {/* Enterprise Combined Executive KPI Scorecards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
        <div className="bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl shadow-lg">
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold">
            <span>Total Enterprise Revenue</span>
            <DollarSign className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-lg sm:text-xl font-black text-emerald-400 mt-1" data-testid="cc-kpi-revenue" data-value={totalRevenue}>
            {formatMoney(totalRevenue, currentCurrency, true)}
          </div>
          <div className="flex items-center text-[10px] text-emerald-400 mt-1 font-medium">
            <ArrowUpRight className="w-3 h-3 mr-0.5" />
            <span>+18.4% vs prev. quarter</span>
          </div>
        </div>

        <div className="bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl shadow-lg">
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold">
            <span>Combined Net Profit</span>
            <TrendingUp className="w-4 h-4 text-teal-400" />
          </div>
          <div className="text-lg sm:text-xl font-black text-teal-300 mt-1">
            {formatMoney(totalNetProfit, currentCurrency, true)}
          </div>
          <div className="flex items-center text-[10px] text-teal-400 mt-1 font-medium">
            <span>
              Margin: {((totalNetProfit / (totalRevenue || 1)) * 100).toFixed(1)}%
            </span>
          </div>
        </div>

        <div className="bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl shadow-lg">
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold">
            <span>Enterprise Average ROI</span>
            <Zap className="w-4 h-4 text-yellow-400" />
          </div>
          <div className="text-lg sm:text-xl font-black text-yellow-300 mt-1">
            {avgRoi}%
          </div>
          <div className="flex items-center text-[10px] text-yellow-400 mt-1 font-medium">
            <span>High return threshold (&gt;15%)</span>
          </div>
        </div>

        <div className="bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl shadow-lg">
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold">
            <span>Net Operating Cash Flow</span>
            <DollarSign className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="text-lg sm:text-xl font-black text-cyan-300 mt-1">
            {formatMoney(totalCashFlow, currentCurrency, true)}
          </div>
          <div className="flex items-center text-[10px] text-cyan-400 mt-1 font-medium">
            <span>Liquid surplus ready</span>
          </div>
        </div>

        <div className="bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl shadow-lg">
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold">
            <span>Total Assets Value</span>
            <Building2 className="w-4 h-4 text-purple-400" />
          </div>
          <div className="text-lg sm:text-xl font-black text-purple-300 mt-1">
            {formatMoney(totalAssets, currentCurrency, true)}
          </div>
          <div className="flex items-center text-[10px] text-purple-300 mt-1 font-medium">
            <span>Machinery, Land & Equip.</span>
          </div>
        </div>

        <div className="bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl shadow-lg">
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold">
            <span>Avg Risk Score (1-100)</span>
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-lg sm:text-xl font-black text-emerald-400 mt-1">
            {avgRisk} / 100
          </div>
          <div className="flex items-center text-[10px] text-emerald-400 mt-1 font-medium">
            <CheckCircle className="w-3 h-3 mr-0.5 inline" />
            <span>Low Enterprise Risk</span>
          </div>
        </div>
      </div>

      {/* Stock Alerts — low / out-of-stock products across every business */}
      {(() => {
        const low = inventory.filter((i) => i.status === "LOW_STOCK" || ((i.quantity || 0) > 0 && (i.quantity || 0) <= (i.minStockThreshold || 0)));
        const out = inventory.filter((i) => i.status === "OUT_OF_STOCK" || (i.quantity || 0) <= 0);
        if (low.length === 0 && out.length === 0) return null;
        const bizName = (id: number) => businesses.find((b) => b.id === id)?.name || "";
        return (
          <div className="bg-slate-800/90 border border-amber-500/30 rounded-2xl p-5 shadow-xl" data-testid="command-stock-alerts">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                Stock Alerts — Replenishment Required
              </h3>
              <button onClick={() => onSelectTab("INVENTORY")} className="text-[11px] font-bold text-amber-300 hover:text-amber-200">
                Open Inventory →
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {out.map((i) => (
                <div key={`out-${i.id}`} className="flex items-center justify-between p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30">
                  <div className="min-w-0">
                    <div className="text-[12px] font-bold text-rose-300 truncate">{i.name}</div>
                    <div className="text-[10px] text-slate-400 truncate">{bizName(i.businessId)} • {i.sku}</div>
                  </div>
                  <span className="ml-3 shrink-0 text-[10px] font-black uppercase text-rose-300 bg-rose-500/20 px-2 py-1 rounded-lg">Out of stock</span>
                </div>
              ))}
              {low.map((i) => (
                <div key={`low-${i.id}`} className="flex items-center justify-between p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30">
                  <div className="min-w-0">
                    <div className="text-[12px] font-bold text-amber-300 truncate">{i.name}</div>
                    <div className="text-[10px] text-slate-400 truncate">{bizName(i.businessId)} • {i.sku}</div>
                  </div>
                  <span className="ml-3 shrink-0 text-[10px] font-black uppercase text-amber-300 bg-amber-500/20 px-2 py-1 rounded-lg">
                    Low: {i.quantity} {i.unit}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Daily Checklist Compliance — unified across all business modules */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <ClipboardCheck className="w-4 h-4 text-teal-400" />
            Daily Checklist Compliance
            <span className="text-[10px] font-semibold text-slate-400">today • all businesses</span>
          </h3>
          <div className="text-xs text-slate-400">
            Enterprise: <span className="text-teal-300 font-black">{checklistTotals.done}/{checklistTotals.total}</span> tasks
            <span className={`ml-2 font-black ${checklistTotalsPct === 100 && checklistTotals.total > 0 ? "text-emerald-400" : "text-teal-300"}`}>{checklistTotalsPct}%</span>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
          {checklistStats.map((c) => (
            <div key={c.id} className="p-3 rounded-xl bg-slate-900/70 border border-slate-700">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold text-slate-200 truncate">{c.name}</span>
                <span className={`text-[11px] font-black ${c.total === 0 ? "text-slate-500" : c.pct === 100 ? "text-emerald-400" : "text-teal-300"}`}>
                  {c.total === 0 ? "—" : `${c.pct}%`}
                </span>
              </div>
              <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden mt-2">
                <div className={`h-1.5 rounded-full transition-all ${c.pct === 100 ? "bg-emerald-500" : "bg-teal-400"}`} style={{ width: `${c.total === 0 ? 0 : c.pct}%` }} />
              </div>
              <div className="text-[10px] text-slate-500 mt-1">
                {c.total === 0 ? "No checklist yet — manager creates it in the module" : `${c.done} of ${c.total} done`}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Business / Branch selection panel */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Sliders className="w-4 h-4 text-teal-400" />
              Comparison Scope
            </h3>
            <p className="text-xs text-slate-400">
              Select specific businesses and compare performance by business or by branch (region).
            </p>
          </div>
          <div className="flex items-center space-x-1.5 bg-slate-900 p-1 rounded-xl border border-slate-700 text-xs font-semibold">
            <button
              onClick={() => setGroupBy("BUSINESS")}
              className={`px-3 py-1.5 rounded-lg transition ${
                groupBy === "BUSINESS"
                  ? "bg-emerald-600 text-white shadow font-bold"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              By Business
            </button>
            <button
              onClick={() => setGroupBy("BRANCH")}
              className={`px-3 py-1.5 rounded-lg transition ${
                groupBy === "BRANCH"
                  ? "bg-emerald-600 text-white shadow font-bold"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              By Branch (Region)
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={selectAllBiz}
            className="px-3 py-1.5 rounded-lg bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 text-xs font-bold"
          >
            Select All
          </button>
          <button
            onClick={clearBiz}
            className="px-3 py-1.5 rounded-lg bg-slate-700/60 text-slate-300 border border-slate-700 text-xs font-semibold"
          >
            Clear
          </button>
          <span className="text-[11px] text-slate-400 self-center ml-1">
            {effectiveSelected.length} of {allBizIds.length} selected
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {businesses.map((biz) => {
            const active = selectedSet.has(biz.id);
            return (
              <button
                key={biz.id}
                onClick={() => toggleBiz(biz.id)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition text-left ${
                  active
                    ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                    : "bg-slate-900/60 border-slate-700 text-slate-400 hover:text-slate-200"
                }`}
              >
                <span
                  className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                    active ? "bg-emerald-500 border-emerald-500" : "border-slate-600"
                  }`}
                >
                  {active && <CheckCircle className="w-3 h-3 text-white" />}
                </span>
                <span className="truncate">{biz.name}</span>
                {(biz.status || "").toUpperCase() === "INACTIVE" && (
                  <span className="ml-auto text-[9px] font-black text-rose-300 bg-rose-500/15 border border-rose-500/40 px-1.5 py-0.5 rounded shrink-0">
                    INACTIVE
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Interactive Charts Suite */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-4 border-b border-slate-700">
          <div>
            <h3 className="text-lg font-bold text-white">
              Multi-Business Comparative Analytics
            </h3>
            <p className="text-xs text-slate-400">
              {groupBy === "BRANCH"
                ? "Comparing aggregated performance grouped by branch region"
                : "Comparing sales, revenue, expenses, profit, inventory and growth across selected businesses"}
            </p>
          </div>

          <div className="flex items-center space-x-1.5 bg-slate-900 p-1 rounded-xl border border-slate-700 text-xs font-semibold">
            <button
              onClick={() => setChartView("PROFIT_BAR")}
              className={`px-3 py-1.5 rounded-lg transition ${
                chartView === "PROFIT_BAR"
                  ? "bg-emerald-600 text-white shadow font-bold"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              Revenue vs Profit
            </button>
            <button
              onClick={() => setChartView("ROI_RADAR")}
              className={`px-3 py-1.5 rounded-lg transition ${
                chartView === "ROI_RADAR"
                  ? "bg-emerald-600 text-white shadow font-bold"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              ROI % & Risk Radar
            </button>
            <button
              onClick={() => setChartView("CASH_AREA")}
              className={`px-3 py-1.5 rounded-lg transition ${
                chartView === "CASH_AREA"
                  ? "bg-emerald-600 text-white shadow font-bold"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              Cash Flow Trend
            </button>
            <button
              onClick={() => setChartView("SALES_BAR")}
              className={`px-3 py-1.5 rounded-lg transition ${
                chartView === "SALES_BAR"
                  ? "bg-emerald-600 text-white shadow font-bold"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              Sales Volume
            </button>
            <button
              onClick={() => setChartView("ASSETS_BAR")}
              className={`px-3 py-1.5 rounded-lg transition ${
                chartView === "ASSETS_BAR"
                  ? "bg-emerald-600 text-white shadow font-bold"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              Asset Value
            </button>
          </div>
        </div>

        <div className="h-[360px] mt-4">
          {chartView === "PROFIT_BAR" && (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartDataset}
                margin={{ top: 10, right: 20, left: 10, bottom: 20 }}
              >
                <XAxis
                  dataKey="name"
                  stroke="#94a3b8"
                  fontSize={11}
                  tickLine={false}
                />
                <YAxis
                  stroke="#94a3b8"
                  fontSize={11}
                  tickLine={false}
                  tickFormatter={(val) => `${(val / 1000).toFixed(0)}k`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: "0.75rem",
                    color: "#f8fafc",
                    fontSize: "12px",
                  }}
                  formatter={(value: any) => [
                    `${formatMoney(value / (currentCurrency === "GHS" ? 1 : 1), currentCurrency)}`,
                  ]}
                />
                <Legend
                  wrapperStyle={{
                    paddingTop: "10px",
                    fontSize: "12px",
                    color: "#cbd5e1",
                  }}
                />
                <Bar
                  dataKey="Revenue"
                  fill="#10b981"
                  name={`Revenue (${currentCurrency})`}
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="Expenses"
                  fill="#f43f5e"
                  name={`Expenses (${currentCurrency})`}
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="Profit"
                  fill="#06b6d4"
                  name={`Net Profit (${currentCurrency})`}
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          )}

          {chartView === "ROI_RADAR" && (
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart cx="50%" cy="50%" outerRadius="80%" data={chartDataset}>
                <PolarGrid stroke="#334155" />
                <PolarAngleAxis
                  dataKey="name"
                  stroke="#e2e8f0"
                  fontSize={11}
                />
                <PolarRadiusAxis stroke="#64748b" />
                <Radar
                  name="ROI (%)"
                  dataKey="ROI"
                  stroke="#10b981"
                  fill="#10b981"
                  fillOpacity={0.5}
                />
                <Radar
                  name="Risk Score (1-100)"
                  dataKey="Risk"
                  stroke="#f59e0b"
                  fill="#f59e0b"
                  fillOpacity={0.3}
                />
                <Legend
                  wrapperStyle={{
                    paddingTop: "10px",
                    fontSize: "12px",
                    color: "#cbd5e1",
                  }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: "0.75rem",
                    color: "#f8fafc",
                    fontSize: "12px",
                  }}
                />
              </RadarChart>
            </ResponsiveContainer>
          )}

          {chartView === "CASH_AREA" && (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={chartDataset}
                margin={{ top: 10, right: 20, left: 10, bottom: 20 }}
              >
                <XAxis
                  dataKey="name"
                  stroke="#94a3b8"
                  fontSize={11}
                  tickLine={false}
                />
                <YAxis
                  stroke="#94a3b8"
                  fontSize={11}
                  tickLine={false}
                  tickFormatter={(val) => `${(val / 1000).toFixed(0)}k`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: "0.75rem",
                    color: "#f8fafc",
                    fontSize: "12px",
                  }}
                />
                <Legend
                  wrapperStyle={{
                    paddingTop: "10px",
                    fontSize: "12px",
                    color: "#cbd5e1",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="CashFlow"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.3}
                  name={`Net Operating Cash Flow (${currentCurrency})`}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}

          {chartView === "SALES_BAR" && (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartDataset}
                margin={{ top: 10, right: 20, left: 10, bottom: 20 }}
              >
                <XAxis dataKey="name" stroke="#94a3b8" fontSize={11} tickLine={false} />
                <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: "0.75rem",
                    color: "#f8fafc",
                    fontSize: "12px",
                  }}
                  formatter={(v: any) => [`${v} sales`, "Transactions"]}
                />
                <Bar dataKey="Sales" name="Sales Transactions" fill="#06b6d4" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}

          {chartView === "ASSETS_BAR" && (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartDataset}
                margin={{ top: 10, right: 20, left: 10, bottom: 20 }}
              >
                <XAxis dataKey="name" stroke="#94a3b8" fontSize={11} tickLine={false} />
                <YAxis
                  stroke="#94a3b8"
                  fontSize={11}
                  tickLine={false}
                  tickFormatter={(val) => `${(val / 1000).toFixed(0)}k`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: "0.75rem",
                    color: "#f8fafc",
                    fontSize: "12px",
                  }}
                />
                <Legend
                  wrapperStyle={{
                    paddingTop: "10px",
                    fontSize: "12px",
                    color: "#cbd5e1",
                  }}
                />
                <Bar
                  dataKey="Assets"
                  name={`Asset Value (${currentCurrency})`}
                  fill="#a855f7"
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="Inventory"
                  name={`Inventory Value (${currentCurrency})`}
                  fill="#22d3ee"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Complete Multi-Business Comparative Table */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-slate-700 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-white">
              {groupBy === "BRANCH"
                ? "Performance by Branch (Region)"
                : `${displayData.length} Selected ${displayData.length === 1 ? "Business" : "Businesses"} — Performance Matrix`}
            </h3>
            <p className="text-xs text-slate-400">
              Side-by-side comparison of sales, revenue, expenses, net profit, ROI %, cash flow, assets, inventory, growth, and operational risk.
            </p>
          </div>
          <div className="text-xs text-emerald-400 font-medium">
            Displayed in {currentCurrency} • {groupBy === "BRANCH" ? "Grouped by region" : "Click any business to open its module"}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs sm:text-sm">
            <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[11px] tracking-wider border-b border-slate-700">
              <tr>
                <th className="px-4 py-3">{groupBy === "BRANCH" ? "Branch (Region)" : "Business & Branch"}</th>
                <th className="px-4 py-3 text-right">Sales</th>
                <th className="px-4 py-3 text-right">Revenue</th>
                <th className="px-4 py-3 text-right">Expenses</th>
                <th className="px-4 py-3 text-right">Net Profit</th>
                <th className="px-4 py-3 text-right">ROI %</th>
                <th className="px-4 py-3 text-right">Cash Flow</th>
                <th className="px-4 py-3 text-right">Assets</th>
                <th className="px-4 py-3 text-right">Inventory</th>
                <th className="px-4 py-3 text-center">Growth</th>
                <th className="px-4 py-3 text-center">Risk Score</th>
                {groupBy === "BUSINESS" && <th className="px-4 py-3 text-right">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/60">
              {displayData.map((biz: any, idx: number) => {
                const marginPercent = ((biz.netProfitGhs / (biz.revenueGhs || 1)) * 100).toFixed(1);
                const isGroup = groupBy === "BRANCH";

                return (
                  <tr
                    key={biz.id ?? `g-${idx}`}
                    onClick={() => !isGroup && biz.code && onSelectTab(biz.code as ActiveTab)}
                    className={`hover:bg-slate-700/50 transition group ${
                      isGroup ? "cursor-default" : "cursor-pointer"
                    }`}
                  >
                    <td className="px-4 py-3.5">
                      <div className="font-bold text-slate-100 group-hover:text-emerald-400 transition">
                        {biz.name}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {isGroup
                          ? `${biz.units} ${biz.units === 1 ? "business unit" : "business units"} in region`
                          : `${[biz.town, biz.district].filter(Boolean).join(", ") || biz.branchLocation} • Mgr: ${biz.managerName}`}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-right font-semibold text-cyan-300">
                      {biz.salesCount}
                    </td>
                    <td className="px-4 py-3.5 text-right font-semibold text-slate-200" data-testid={`cc-bizrev-${biz.id}`} data-value={biz.revenueGhs}>
                      {formatMoney(biz.revenueGhs, currentCurrency)}
                    </td>
                    <td className="px-4 py-3.5 text-right text-rose-300">
                      {formatMoney(biz.expensesGhs, currentCurrency)}
                    </td>
                    <td className="px-4 py-3.5 text-right font-extrabold text-emerald-400">
                      {formatMoney(biz.netProfitGhs, currentCurrency)}
                      <div className="text-[10px] text-slate-400 font-normal">
                        ({marginPercent}% margin)
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 font-bold border border-emerald-500/30">
                        {biz.roiPercent}%
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-right font-semibold text-cyan-300">
                      {formatMoney(biz.cashFlowGhs, currentCurrency)}
                    </td>
                    <td className="px-4 py-3.5 text-right text-slate-300">
                      {formatMoney(biz.assetsValueGhs, currentCurrency, true)}
                    </td>
                    <td className="px-4 py-3.5 text-right text-slate-300">
                      {formatMoney(biz.inventoryValueGhs, currentCurrency, true)}
                    </td>
                    <td className="px-4 py-3.5 text-center font-bold text-emerald-400">
                      +{biz.growthRatePercent}%
                    </td>
                    <td className="px-4 py-3.5 text-center">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold ${
                          biz.riskScore < 25
                            ? "bg-emerald-500/20 text-emerald-400"
                            : biz.riskScore < 35
                            ? "bg-teal-500/20 text-teal-300"
                            : "bg-amber-500/20 text-amber-400"
                        }`}
                      >
                        {biz.riskScore} / 100
                      </span>
                    </td>
                    {!isGroup && (
                      <td className="px-4 py-3.5 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectTab(biz.code as ActiveTab);
                          }}
                          className="px-3 py-1.5 rounded-lg bg-emerald-600/30 hover:bg-emerald-600 text-emerald-300 hover:text-white text-xs font-semibold transition inline-flex items-center space-x-1"
                        >
                          <span>Open Module</span>
                          <ExternalLink className="w-3 h-3" />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ══════════ ENTERPRISE FINANCIAL REPORT — all businesses & branches ══════════ */}
      <FinancialReportSection
        mode="enterprise"
        businesses={businesses}
        metrics={metrics}
        transactions={transactions}
        inventory={inventory}
        currentCurrency={currentCurrency}
        accent="emerald"
        testid="fin-report-enterprise"
        aiModuleKey="COMMAND_CENTER"
      />
    </div>
  );
}
