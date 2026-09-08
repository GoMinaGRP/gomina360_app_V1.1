"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Boxes,
  Building2,
  CalendarRange,
  CreditCard,
  FileWarning,
  Landmark,
  Link2,
  Receipt,
  RefreshCw,
  Scale,
  ShoppingCart,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Truck,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import AiSectionGuide from "./AiSectionGuide";
import {
  FinanceGranularity,
  computeFinancialReport,
  defaultGranularity,
  financePeriods,
  FinancePeriodDef,
  getFinancePeriod,
  isPurchaseLikeExpense,
  recoverBaseline,
} from "@/lib/financeReport";

/**
 * FinancialReportSection — the ONE complete Financial Report shared by every
 * business dashboard (and the enterprise Command Center).
 *
 *   revenue • sales • expenses • profit • payments • outstanding • trends
 *   filters: days / months / years + business / branch scope
 *   live-linked to sales, purchases, inventory, production, orders, expenses
 *   and payments — the numbers move the instant any of them change.
 */

export interface FinanceOpsLink {
  label: string;
  value: string;
  note?: string;
  tone?: "emerald" | "rose" | "cyan" | "amber" | "violet" | "sky" | "slate" | "teal" | "orange";
}

interface Props {
  mode: "business" | "enterprise";
  /** business mode: the unit this dashboard belongs to. */
  businessInfo?: any;
  /** business mode: live metric row (carries baselineTxId from GoMinaApp). */
  businessMetric?: any;
  /** enterprise mode: every accessible business (for the picker + per-branch table). */
  businesses?: any[];
  /** enterprise mode: live metric rows (same provenance as businessMetric). */
  metrics?: any[];
  transactions: any[];
  inventory?: any[];
  customers?: any[];
  currentCurrency: CurrencyCode;
  /** Module-specific real-time links (orders, production, washes, harvests…). */
  opsLinks?: FinanceOpsLink[];
  salesDocuments?: any[];
  title?: string;
  subtitle?: string;
  accent?: string;
  testid?: string;
  aiModuleKey?: string;
}

const TONE_CLS: Record<string, string> = {
  emerald: "text-emerald-400",
  rose: "text-rose-400",
  cyan: "text-cyan-400",
  amber: "text-amber-400",
  violet: "text-violet-400",
  sky: "text-sky-400",
  slate: "text-slate-300",
  teal: "text-teal-400",
  orange: "text-orange-400",
};

/** Report-type picker: tailors which panels the report shows. */
const REPORT_TYPES: { key: string; label: string }[] = [
  { key: "FULL", label: "Full Report" },
  { key: "SALES_REVENUE", label: "Sales & Revenue" },
  { key: "EXPENSES_PURCHASES", label: "Expenses & Purchases" },
  { key: "PAYMENTS", label: "Payments" },
  { key: "OUTSTANDING", label: "Outstanding" },
  { key: "INVENTORY", label: "Inventory Value" },
];
/** Panels kept visible per report type (FULL shows everything). */
const TYPE_SECTIONS: Record<string, Set<string>> = {
  SALES_REVENUE: new Set(["trend", "chart-sales", "chart-revcats", "chart-profit", "income-cats", "scope", "ledger", "links"]),
  EXPENSES_PURCHASES: new Set(["trend", "chart-expcats", "chart-profit", "expense-cats", "scope", "ledger", "links"]),
  PAYMENTS: new Set(["trend", "chart-payments", "chart-profit", "payments", "scope", "ledger", "links"]),
  OUTSTANDING: new Set(["outstanding", "scope", "ledger", "links"]),
  INVENTORY: new Set(["scope", "ledger", "links"]),
};

const EMERALD_SHADES = ["#10b981", "#34d399", "#6ee7b7", "#a7f3d0", "#059669", "#047857", "#065f46", "#022c22"];
const ROSE_SHADES = ["#f43f5e", "#fb7185", "#fda4af", "#e11d48", "#be123c", "#9f1239", "#881337", "#fecdd3"];

const AXIS_TICK = { fontSize: 10, fill: "#94a3b8" } as const;
const TOOLTIP_STYLE = { background: "#0f172a", border: "1px solid #334155", fontSize: 11 } as const;

// Static Tailwind maps (JIT-safe: never interpolate class names).
const ACCENT_BTN: Record<string, string> = {
  emerald: "bg-emerald-600 text-white shadow",
  cyan: "bg-cyan-600 text-white shadow",
  amber: "bg-amber-600 text-white shadow",
  teal: "bg-teal-600 text-white shadow",
  sky: "bg-sky-600 text-white shadow",
  violet: "bg-violet-600 text-white shadow",
  rose: "bg-rose-600 text-white shadow",
  indigo: "bg-indigo-600 text-white shadow",
  orange: "bg-orange-600 text-white shadow",
};
const ACCENT_ICONBOX: Record<string, string> = {
  emerald: "bg-emerald-500/15 border-emerald-500/30",
  cyan: "bg-cyan-500/15 border-cyan-500/30",
  amber: "bg-amber-500/15 border-amber-500/30",
  teal: "bg-teal-500/15 border-teal-500/30",
  sky: "bg-sky-500/15 border-sky-500/30",
  violet: "bg-violet-500/15 border-violet-500/30",
  rose: "bg-rose-500/15 border-rose-500/30",
  indigo: "bg-indigo-500/15 border-indigo-500/30",
  orange: "bg-orange-500/15 border-orange-500/30",
};
const CHIP_CLS: Record<string, string> = {
  emerald: "bg-emerald-500/10 border-emerald-500/30 text-emerald-200",
  rose: "bg-rose-500/10 border-rose-500/30 text-rose-200",
  cyan: "bg-cyan-500/10 border-cyan-500/30 text-cyan-200",
  amber: "bg-amber-500/10 border-amber-500/30 text-amber-200",
  violet: "bg-violet-500/10 border-violet-500/30 text-violet-200",
  sky: "bg-sky-500/10 border-sky-500/30 text-sky-200",
  slate: "bg-slate-500/10 border-slate-500/30 text-slate-200",
  teal: "bg-teal-500/10 border-teal-500/30 text-teal-200",
  orange: "bg-orange-500/10 border-orange-500/30 text-orange-200",
};

async function fetchSalesDocuments(businessId?: number | null): Promise<any[]> {
  try {
    const url = businessId ? `/api/sales-documents?businessId=${businessId}` : "/api/sales-documents";
    const res = await fetch(url);
    const d = await res.json().catch(() => null);
    if (res.ok && d?.success) return d.documents || [];
  } catch {
    /* offline / network — report works without document layer */
  }
  return [];
}

export default function FinancialReportSection({
  mode,
  businessInfo,
  businessMetric,
  businesses = [],
  metrics = [],
  transactions,
  inventory = [],
  customers = [],
  currentCurrency,
  opsLinks = [],
  salesDocuments,
  title,
  subtitle,
  accent = "emerald",
  testid = "fin-report",
  aiModuleKey,
}: Props) {
  const today = new Date();
  const periods = useMemo(() => financePeriods(today), []);
  const [periodKey, setPeriodKey] = useState<string>("ALL_TIME");
  const [reportType, setReportType] = useState<string>("FULL");
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");
  const [granularity, setGranularity] = useState<FinanceGranularity>("MONTH");
  const [scopeBizId, setScopeBizId] = useState<number | null>(businessInfo?.id ?? null);
  const [branchCode, setBranchCode] = useState<string | null>(null);
  const [docs, setDocs] = useState<any[] | null>(salesDocuments ?? null);

  const isEnterprise = mode === "enterprise";
  // Enterprise: null = "All businesses"; business mode: locked to own id.
  const activeBizId = isEnterprise ? scopeBizId : businessInfo?.id ?? null;
  const activeBiz = isEnterprise
    ? businesses.find((b) => b.id === activeBizId) || null
    : businessInfo;

  const period = useMemo(() => {
    if (periodKey === "CUSTOM") {
      const start = customFrom || null;
      const end = customTo || null;
      return {
        key: "CUSTOM",
        label: start || end ? `Custom ${start ?? "…"} → ${end ?? "…"}` : "Custom range",
        start,
        end,
      } as FinancePeriodDef;
    }
    return getFinancePeriod(periodKey, today);
  }, [periodKey, customFrom, customTo]);

  /** Panels visible for the chosen report type (FULL = everything). */
  const showSec = (sec: string) =>
    reportType === "FULL" || (TYPE_SECTIONS[reportType]?.has(sec) ?? false);

  // ── Sales documents (invoices) — self-maintained, refreshed with the ledger ──
  const txSignature = useMemo(() => {
    let max = 0;
    for (const t of transactions || []) if ((t.id || 0) > max) max = t.id || 0;
    return `${(transactions || []).length}:${max}`;
  }, [transactions]);

  useEffect(() => {
    if (salesDocuments) {
      setDocs(salesDocuments);
      return;
    }
    let on = true;
    // Enterprise fetches the full accessible set once and filters client-side,
    // so switching the business picker never re-hits the network.
    fetchSalesDocuments(isEnterprise ? null : activeBizId).then((d) => {
      if (on) setDocs(d);
    });
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEnterprise, isEnterprise ? null : activeBizId, txSignature, salesDocuments]);

  const scopedDocs = useMemo(() => {
    const list = docs || [];
    if (activeBizId == null) return list;
    return list.filter((d) => d.businessId === activeBizId);
  }, [docs, activeBizId]);

  // ── Baseline recovery (seeded quarterly close hidden in live metrics) ──
  const baseline = useMemo(() => {
    if (isEnterprise) {
      const rows = activeBizId == null ? metrics : metrics.filter((m) => m.businessId === activeBizId);
      if (!rows.length) return null;
      const parts = rows
        .map((m) => recoverBaseline(m, transactions || []))
        .filter(Boolean) as { revenueGhs: number; expensesGhs: number }[];
      if (!parts.length) return null;
      return {
        revenueGhs: parts.reduce((s, p) => s + p.revenueGhs, 0),
        expensesGhs: parts.reduce((s, p) => s + p.expensesGhs, 0),
        label: "Q1-2026 baseline (system records)",
      };
    }
    return recoverBaseline(businessMetric, transactions || []);
  }, [isEnterprise, metrics, businessMetric, transactions, activeBizId]);

  // Branch codes present in the active scope (business mode branch picker).
  const branchOptions = useMemo(() => {
    const codes = new Set<string>();
    for (const t of transactions || []) {
      if (activeBizId != null && t.businessId !== activeBizId) continue;
      if (t.branchCode) codes.add(String(t.branchCode));
    }
    return Array.from(codes).sort();
  }, [transactions, activeBizId]);

  const report = useMemo(
    () =>
      computeFinancialReport({
        transactions: transactions || [],
        businessId: activeBizId,
        branchCode: isEnterprise ? null : branchCode,
        baseline,
        period,
        granularity: period.key === "ALL_TIME" && granularity === "DAY" ? "MONTH" : granularity,
        today,
      }),
    [transactions, activeBizId, branchCode, isEnterprise, baseline, period, granularity]
  );

  // ── Chart datasets (payments in/out per channel, profit margin trend) ──
  const payChannelRows = useMemo(() => {
    const map = new Map<string, { name: string; moneyIn: number; moneyOut: number }>();
    for (const p of report.paymentsInByMethod) {
      map.set(p.name, { name: p.name, moneyIn: p.total, moneyOut: map.get(p.name)?.moneyOut || 0 });
    }
    for (const p of report.paymentsOutByMethod) {
      map.set(p.name, { name: p.name, moneyIn: map.get(p.name)?.moneyIn || 0, moneyOut: p.total });
    }
    return [...map.values()].sort((a, b) => b.moneyIn + b.moneyOut - (a.moneyIn + a.moneyOut)).slice(0, 8);
  }, [report]);

  const profitRows = useMemo(
    () =>
      report.trend.map((b) => ({
        ...b,
        margin: b.revenue > 0 ? Number(((b.profit / b.revenue) * 100).toFixed(1)) : 0,
      })),
    [report]
  );

  // ── Inventory linkage (real-time stock position for the scope) ──
  const invStats = useMemo(() => {
    const rows = activeBizId == null ? inventory || [] : (inventory || []).filter((i) => i.businessId === activeBizId);
    const costValue = rows.reduce((s, i) => s + (i.quantity || 0) * (i.costPriceGhs || 0), 0);
    const retailValue = rows.reduce((s, i) => s + (i.quantity || 0) * (i.sellingPriceGhs || 0), 0);
    const low = rows.filter((i) => i.status !== "IN_STOCK" || (i.quantity || 0) <= (i.minStockThreshold || 0)).length;
    return { items: rows.length, costValue, retailValue, low };
  }, [inventory, activeBizId]);

  // ── Outstanding / receivables ──
  const openInvoices = useMemo(
    () =>
      scopedDocs.filter(
        (d) => d.documentType === "INVOICE" && ["SENT", "PARTIAL", "OVERDUE"].includes(String(d.status || ""))
      ),
    [scopedDocs]
  );
  const invoiceOutstanding = openInvoices.reduce((s, d) => s + (d.totalGhs || 0), 0);
  const pendingCollections = report.pendingCollections.reduce((s, p) => s + p.amount, 0);
  const outstandingTotal = invoiceOutstanding + pendingCollections;

  // ── Sales / purchases linkage chips (derived straight from the ledger) ──
  const purchaseRows = report.ledger.filter(isPurchaseLikeExpense);
  const purchaseTotal = report.expenseByCategory
    .filter((c) => isPurchaseLikeExpense({ type: "EXPENSE", category: c.name, description: "" }))
    .reduce((s, c) => s + c.total, 0);

  const deltaChip = (pct: number | null) =>
    pct == null ? null : (
      <span
        className={`inline-flex items-center gap-0.5 text-[10px] font-bold ${
          pct >= 0 ? "text-emerald-400" : "text-rose-400"
        }`}
      >
        {pct >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
        {Math.abs(pct).toFixed(1)}%
      </span>
    );

  const cardTone = TONE_CLS[accent] || TONE_CLS.emerald;

  const Stat = ({ label, value, sub, icon: Icon, tone = "text-emerald-400", tid }: any) => (
    <div
      data-testid={tid}
      className="bg-slate-900/70 border border-slate-700/70 rounded-xl p-3.5 min-w-0"
    >
      <div className="flex items-center justify-between text-[10px] uppercase font-bold text-slate-400 tracking-wide">
        <span className="truncate pr-1">{label}</span>
        {Icon && <Icon className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
      </div>
      <div className={`text-lg font-black mt-1 truncate ${tone}`}>{value}</div>
      {sub != null && <div className="text-[10px] text-slate-500 mt-0.5 truncate">{sub}</div>}
    </div>
  );

  const Panel = ({ title: t, icon: Icon, children, action, tid }: any) => (
    <div
      data-testid={tid}
      className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl"
    >
      <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && <Icon className={`w-4 h-4 ${cardTone}`} />}
          <h4 className="text-sm font-bold text-white truncate">{t}</h4>
        </div>
        {action}
      </div>
      {children}
    </div>
  );

  const BreakdownList = ({ rows, tone, empty, money = true }: any) => (
    <div className="p-3.5 space-y-1.5 max-h-56 overflow-y-auto">
      {rows.length === 0 && <p className="text-xs text-slate-500 py-1">{empty}</p>}
      {rows.map((r: any) => (
        <div
          key={r.name}
          className="flex items-center justify-between gap-2 text-xs p-2 rounded-lg bg-slate-900/70 border border-slate-700/70"
        >
          <span className="text-slate-300 truncate">{r.name}</span>
          <span className="flex items-center gap-2 shrink-0">
            <span className="text-[10px] text-slate-500">{r.count}×</span>
            <span className={`font-bold ${tone}`}>
              {money ? formatMoney(r.total, currentCurrency, true) : r.total}
            </span>
          </span>
        </div>
      ))}
    </div>
  );

  const hdrTitle =
    title ||
    (isEnterprise
      ? "Enterprise Financial Report — All Businesses & Branches"
      : `Financial Report — ${activeBiz?.name || "This Business"}`);
  const hdrSub =
    subtitle ||
    (isEnterprise
      ? "Consolidated revenue, sales, expenses, profit, payments, outstanding balances and trends — filter by business, branch and period."
      : "Revenue, sales, expenses, profit, payments, outstanding balances and trends — live-linked to sales, purchases, inventory, production, orders and payments.");

  const typeBadge = (t: any) =>
    t.type === "INCOME"
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
      : t.type === "EXPENSE"
      ? "bg-rose-500/15 text-rose-300 border-rose-500/40"
      : "bg-sky-500/15 text-sky-300 border-sky-500/40";

  return (
    <div data-testid={testid} className="space-y-4">
      {/* ── Header ── */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${ACCENT_ICONBOX[accent] || ACCENT_ICONBOX.emerald}`}
          >
            <Landmark className={`w-5 h-5 ${cardTone}`} />
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-extrabold text-white flex items-center gap-2 flex-wrap">
              {hdrTitle}
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-[10px] font-bold">
                <RefreshCw className="w-3 h-3" /> LIVE
              </span>
            </h3>
            <p className="text-[11px] text-slate-400 mt-0.5">{hdrSub}</p>
          </div>
        </div>
        <AiSectionGuide
          moduleKey={aiModuleKey || (isEnterprise ? "COMMAND_CENTER" : "GENERIC")}
          section="FINANCE_REPORT"
          businessInfo={activeBiz}
          variant="header"
        />
      </div>

      {/* ── Filters: days / months / years · business & branch scope ── */}
      <div
        data-testid={`${testid}-filters`}
        className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-3 space-y-2.5"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-400 uppercase mr-1">
            <CalendarRange className="w-3.5 h-3.5" /> Period
          </span>
          {periods.map((p) => (
            <button
              key={p.key}
              data-testid={`${testid}-period-${p.key}`}
              onClick={() => {
                setPeriodKey(p.key);
                setGranularity(defaultGranularity(getFinancePeriod(p.key, today)));
              }}
              className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition ${
                periodKey === p.key
                  ? ACCENT_BTN[accent] || ACCENT_BTN.emerald
                  : "bg-slate-900/70 border border-slate-700 text-slate-300 hover:border-slate-500"
              }`}
            >
              {p.label}
            </button>
          ))}
          {/* Custom date range — pick any exact from/to dates */}
          <button
            data-testid={`${testid}-period-CUSTOM`}
            onClick={() => setPeriodKey("CUSTOM")}
            className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition inline-flex items-center gap-1 ${
              periodKey === "CUSTOM"
                ? ACCENT_BTN[accent] || ACCENT_BTN.emerald
                : "bg-slate-900/70 border border-dashed border-slate-600 text-slate-300 hover:border-slate-500"
            }`}
          >
            <CalendarRange className="w-3 h-3" /> Custom
          </button>
          {periodKey === "CUSTOM" && (
            <span className="inline-flex items-center gap-1.5" data-testid={`${testid}-custom-range`}>
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                data-testid={`${testid}-date-from`}
                className="px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-white text-[11px] font-semibold"
              />
              <span className="text-slate-500 text-[10px] font-bold">to</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                data-testid={`${testid}-date-to`}
                className="px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-white text-[11px] font-semibold"
              />
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold text-slate-400 uppercase">Trend by</span>
            {(["DAY", "MONTH", "YEAR"] as FinanceGranularity[]).map((g) => (
              <button
                key={g}
                data-testid={`${testid}-gran-${g}`}
                disabled={periodKey === "ALL_TIME" && g === "DAY"}
                onClick={() => setGranularity(g)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition disabled:opacity-30 ${
                  granularity === g
                    ? "bg-sky-600 text-white"
                    : "bg-slate-900/70 border border-slate-700 text-slate-300 hover:border-slate-500"
                }`}
              >
                {g === "DAY" ? "Days" : g === "MONTH" ? "Months" : "Years"}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-slate-400 uppercase inline-flex items-center gap-1">
              <Receipt className="w-3 h-3" /> Report Type
            </span>
            <select
              data-testid={`${testid}-report-type`}
              value={reportType}
              onChange={(e) => setReportType(e.target.value)}
              className="px-2.5 py-1 bg-slate-900 border border-slate-700 rounded-lg text-white text-[11px] font-semibold"
            >
              {REPORT_TYPES.map((rt) => (
                <option key={rt.key} value={rt.key}>
                  {rt.label}
                </option>
              ))}
            </select>
          </label>
          {isEnterprise ? (
            <label className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase inline-flex items-center gap-1">
                <Building2 className="w-3 h-3" /> Business / Branch
              </span>
              <select
                data-testid={`${testid}-business-select`}
                value={scopeBizId == null ? "ALL" : String(scopeBizId)}
                onChange={(e) => {
                  setScopeBizId(e.target.value === "ALL" ? null : Number(e.target.value));
                  setBranchCode(null);
                }}
                className="px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-[11px] font-semibold"
              >
                <option value="ALL">All Businesses (Consolidated)</option>
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} — {b.code}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Branch / Register</span>
              <select
                data-testid={`${testid}-branch-select`}
                value={branchCode ?? ""}
                onChange={(e) => setBranchCode(e.target.value || null)}
                className="px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-[11px] font-semibold"
              >
                <option value="">All registers ({branchOptions.length || 1})</option>
                {branchOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="ml-auto text-[10px] text-slate-500 font-semibold">
            Range: {report.rangeLabel}
          </span>
        </div>
      </div>

      {/* ── Seeded baseline strip ── */}
      {baseline && (baseline.revenueGhs > 0 || baseline.expensesGhs > 0) && (
        <div
          data-testid={`${testid}-baseline`}
          className="bg-indigo-500/10 border border-indigo-500/30 rounded-xl px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1.5"
        >
          <span className="text-[11px] font-bold text-indigo-300 inline-flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5" />
            Q1-2026 baseline (system records)
          </span>
          <span className="text-[11px] text-slate-300">
            Revenue <b className="text-emerald-300">{formatMoney(baseline.revenueGhs, currentCurrency, true)}</b>
          </span>
          <span className="text-[11px] text-slate-300">
            Expenses <b className="text-rose-300">{formatMoney(baseline.expensesGhs, currentCurrency, true)}</b>
          </span>
          <span className="text-[11px] text-slate-300">
            Profit{" "}
            <b className="text-cyan-300">
              {formatMoney(baseline.revenueGhs - baseline.expensesGhs, currentCurrency, true)}
            </b>
          </span>
          <span className="text-[10px] text-indigo-200/80">
            {report.baselineIncludedInTotals
              ? "Included in the All-Time totals below."
              : "Folded into the All-Time view — dated ranges show the live ledger only."}
          </span>
        </div>
      )}

      {/* ── KPI cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2.5">
        <Stat
          tid={`${testid}-kpi-revenue`}
          label="Revenue"
          value={formatMoney(report.revenue, currentCurrency, true)}
          icon={TrendingUp}
          tone="text-emerald-400"
          sub={
            <span className="inline-flex items-center gap-1.5">
              {report.salesCount} sales in range {deltaChip(report.revenueDeltaPct)}
            </span>
          }
        />
        <Stat
          tid={`${testid}-kpi-sales`}
          label="Sales"
          value={report.salesCount.toLocaleString()}
          icon={ShoppingCart}
          tone="text-sky-400"
          sub={`avg ticket ${formatMoney(report.avgTicket, currentCurrency, true)}`}
        />
        <Stat
          tid={`${testid}-kpi-expenses`}
          label="Expenses"
          value={formatMoney(report.expenses, currentCurrency, true)}
          icon={TrendingDown}
          tone="text-rose-400"
          sub={
            <span className="inline-flex items-center gap-1.5">
              {report.expenseCount} postings {deltaChip(report.expenseDeltaPct)}
            </span>
          }
        />
        <Stat
          tid={`${testid}-kpi-profit`}
          label="Net Profit"
          value={formatMoney(report.profit, currentCurrency, true)}
          icon={Scale}
          tone={report.profit >= 0 ? "text-emerald-400" : "text-rose-400"}
          sub={`${report.marginPct.toFixed(1)}% margin`}
        />
        <Stat
          tid={`${testid}-kpi-payments`}
          label="Payments Collected"
          value={formatMoney(report.cashCollected, currentCurrency, true)}
          icon={CreditCard}
          tone="text-cyan-400"
          sub={`${report.paymentsInByMethod.length} channel(s) • ${report.paymentsInByMethod
            .reduce((s, p) => s + p.count, 0)
            .toLocaleString()} receipts`}
        />
        <Stat
          tid={`${testid}-kpi-outstanding`}
          label="Outstanding"
          value={formatMoney(outstandingTotal, currentCurrency, true)}
          icon={FileWarning}
          tone={outstandingTotal > 0 ? "text-amber-400" : "text-emerald-400"}
          sub={`${openInvoices.length} open invoice(s) • ${report.pendingCollections.length} pending collection(s)`}
        />
        <Stat
          tid={`${testid}-kpi-purchases`}
          label="Purchases & Stock-in"
          value={formatMoney(purchaseTotal, currentCurrency, true)}
          icon={Truck}
          tone="text-violet-400"
          sub={`${purchaseRows.length} purchase-linked postings`}
        />
        <Stat
          tid={`${testid}-kpi-inventory`}
          label="Inventory Value"
          value={formatMoney(invStats.costValue, currentCurrency, true)}
          icon={Boxes}
          tone="text-amber-400"
          sub={`${invStats.items} item(s) • ${invStats.low} low/out • retail ${formatMoney(
            invStats.retailValue,
            currentCurrency,
            true
          )}`}
        />
      </div>

      {/* ── Trend chart ── */}
      {showSec("trend") && (
      <Panel
        tid={`${testid}-trend`}
        title={`Financial Trend — Revenue vs Expenses vs Profit (${
          report.trendGranularity === "DAY" ? "by day" : report.trendGranularity === "MONTH" ? "by month" : "by year"
        })`}
        icon={BarChart3}
        action={
          <span className="text-[10px] text-slate-500">
            {report.rangeLabel}
            {report.trend.some((b) => b.withBaseline) ? " • Q1 close folded in" : ""}
          </span>
        }
      >
        <div className="p-3">
          {report.trend.some((b) => b.revenue > 0 || b.expenses > 0) ? (
            <ResponsiveContainer width="100%" height={230}>
              <ComposedChart data={report.trend} margin={{ top: 8, right: 10, left: -14, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                <Tooltip
                  formatter={(v: any, name: any) => [formatMoney(Number(v), currentCurrency), name]}
                  contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }}
                  labelStyle={{ color: "#e2e8f0" }}
                />
                <Bar dataKey="revenue" name="Revenue" fill="#10b981" radius={[3, 3, 0, 0]} />
                <Bar dataKey="expenses" name="Expenses" fill="#f43f5e" radius={[3, 3, 0, 0]} />
                <Line
                  type="monotone"
                  dataKey="profit"
                  name="Net Profit"
                  stroke="#22d3ee"
                  strokeWidth={2.5}
                  dot={{ r: 3, fill: "#22d3ee" }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[180px] flex flex-col items-center justify-center text-slate-500 text-xs gap-1 px-6 text-center">
              <BarChart3 className="w-6 h-6 text-slate-600" />
              <p>No ledger activity inside this range yet.</p>
              {baseline && (baseline.revenueGhs > 0 || baseline.expensesGhs > 0) && period.key !== "ALL_TIME" ? (
                <p className="text-[10px] text-indigo-300/90">
                  The Q1-2026 baseline sits outside this range — switch to <b>All Time</b> to see it in the trend.
                </p>
              ) : (
                <p className="text-[10px]">Record a sale or expense from this dashboard and the trend updates instantly.</p>
              )}
            </div>
          )}
        </div>
      </Panel>
      )}

      {/* ── Interactive financial charts — sales, revenue, expenses, profit & payments ── */}
      {(showSec("chart-sales") || showSec("chart-revcats") || showSec("chart-expcats") || showSec("chart-payments") || showSec("chart-profit")) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3" data-testid={`${testid}-charts`}>
          {showSec("chart-sales") && (
            <Panel tid={`${testid}-chart-sales`} title="Sales Volume — receipts per period" icon={ShoppingCart}>
              <div className="p-3">
                {report.trend.some((b) => (b.receipts || 0) > 0) ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={report.trend} margin={{ top: 6, right: 10, left: -22, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                      <YAxis allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: "#e2e8f0" }} formatter={(v: any) => [v, "Receipts"]} />
                      <Bar dataKey="receipts" name="Receipts" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="h-[140px] flex items-center justify-center text-slate-500 text-xs">No receipts inside this range yet.</p>
                )}
              </div>
            </Panel>
          )}

          {showSec("chart-revcats") && (
            <Panel tid={`${testid}-chart-revcats`} title="Sales & Revenue Mix — by category" icon={TrendingUp}>
              <div className="p-3">
                {report.incomeByCategory.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie
                        data={report.incomeByCategory}
                        dataKey="total"
                        nameKey="name"
                        innerRadius={46}
                        outerRadius={76}
                        stroke="#0f172a"
                        strokeWidth={2}
                      >
                        {report.incomeByCategory.map((_, i) => (
                          <Cell key={i} fill={EMERALD_SHADES[i % EMERALD_SHADES.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: "#e2e8f0" }} formatter={(v: any, name: any) => [formatMoney(Number(v), currentCurrency), name]} />
                      <Legend iconSize={8} wrapperStyle={{ fontSize: 10, color: "#94a3b8" }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="h-[140px] flex items-center justify-center text-slate-500 text-xs">No income inside this range yet.</p>
                )}
              </div>
            </Panel>
          )}

          {showSec("chart-expcats") && (
            <Panel tid={`${testid}-chart-expcats`} title="Expense Mix — by category" icon={TrendingDown}>
              <div className="p-3">
                {report.expenseByCategory.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie
                        data={report.expenseByCategory}
                        dataKey="total"
                        nameKey="name"
                        innerRadius={46}
                        outerRadius={76}
                        stroke="#0f172a"
                        strokeWidth={2}
                      >
                        {report.expenseByCategory.map((_, i) => (
                          <Cell key={i} fill={ROSE_SHADES[i % ROSE_SHADES.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: "#e2e8f0" }} formatter={(v: any, name: any) => [formatMoney(Number(v), currentCurrency), name]} />
                      <Legend iconSize={8} wrapperStyle={{ fontSize: 10, color: "#94a3b8" }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="h-[140px] flex items-center justify-center text-slate-500 text-xs">No expenses inside this range yet.</p>
                )}
              </div>
            </Panel>
          )}

          {showSec("chart-payments") && (
            <Panel tid={`${testid}-chart-payments`} title="Payments — money in vs out by channel" icon={CreditCard}>
              <div className="p-3">
                {payChannelRows.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={payChannelRows} margin={{ top: 6, right: 10, left: -14, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                      <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: "#e2e8f0" }} formatter={(v: any, name: any) => [formatMoney(Number(v), currentCurrency), name]} />
                      <Legend iconSize={8} wrapperStyle={{ fontSize: 10, color: "#94a3b8" }} />
                      <Bar dataKey="moneyIn" name="Money In" fill="#10b981" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="moneyOut" name="Money Out" fill="#f43f5e" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="h-[140px] flex items-center justify-center text-slate-500 text-xs">No payment activity inside this range yet.</p>
                )}
              </div>
            </Panel>
          )}

          {showSec("chart-profit") && (
            <Panel tid={`${testid}-chart-profit`} title="Profitability — profit & margin trend" icon={Scale}>
              <div className="p-3">
                {report.trend.some((b) => b.revenue > 0 || b.expenses > 0) ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <ComposedChart data={profitRows} margin={{ top: 6, right: -4, left: -18, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                      <YAxis yAxisId="left" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                      <YAxis yAxisId="right" orientation="right" tick={AXIS_TICK} axisLine={false} tickLine={false} unit="%" />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        labelStyle={{ color: "#e2e8f0" }}
                        formatter={(v: any, name: any) => (name === "Margin" ? [`${v}%`, name] : [formatMoney(Number(v), currentCurrency), name])}
                      />
                      <Legend iconSize={8} wrapperStyle={{ fontSize: 10, color: "#94a3b8" }} />
                      <Line yAxisId="left" type="monotone" dataKey="profit" name="Net Profit" stroke="#22d3ee" strokeWidth={2.5} dot={{ r: 3, fill: "#22d3ee" }} />
                      <Line yAxisId="right" type="monotone" dataKey="margin" name="Margin" stroke="#f59e0b" strokeWidth={2} strokeDasharray="5 3" dot={{ r: 2.5, fill: "#f59e0b" }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="h-[140px] flex items-center justify-center text-slate-500 text-xs">No profit movement inside this range yet.</p>
                )}
              </div>
            </Panel>
          )}
        </div>
      )}

      {/* ── Category + payment breakdowns ── */}
      {(showSec("income-cats") || showSec("expense-cats") || showSec("payments")) && (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {showSec("income-cats") && (
        <Panel tid={`${testid}-income-cats`} title="Revenue by Category" icon={TrendingUp}>
          <BreakdownList rows={report.incomeByCategory} tone="text-emerald-300" empty="No income in this range." />
        </Panel>
        )}
        {showSec("expense-cats") && (
        <Panel tid={`${testid}-expense-cats`} title="Expenses by Category" icon={TrendingDown}>
          <BreakdownList rows={report.expenseByCategory} tone="text-rose-300" empty="No expenses in this range." />
        </Panel>
        )}
        {showSec("payments") && (
        <Panel tid={`${testid}-payments`} title="Payments — Channels" icon={CreditCard}>
          <div className="p-3.5 space-y-3 max-h-56 overflow-y-auto">
            <div>
              <div className="text-[10px] uppercase font-bold text-slate-500 mb-1.5">Money In</div>
              {report.paymentsInByMethod.length === 0 && (
                <p className="text-xs text-slate-500">No collections in this range.</p>
              )}
              {report.paymentsInByMethod.map((r) => (
                <div
                  key={r.name}
                  className="flex items-center justify-between text-xs py-1 border-b border-slate-700/50 last:border-0"
                >
                  <span className="text-slate-300">{r.name}</span>
                  <span className="text-cyan-300 font-bold">
                    {r.count}× · {formatMoney(r.total, currentCurrency, true)}
                  </span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-[10px] uppercase font-bold text-slate-500 mb-1.5">Money Out</div>
              {report.paymentsOutByMethod.length === 0 && (
                <p className="text-xs text-slate-500">No payouts in this range.</p>
              )}
              {report.paymentsOutByMethod.map((r) => (
                <div
                  key={r.name}
                  className="flex items-center justify-between text-xs py-1 border-b border-slate-700/50 last:border-0"
                >
                  <span className="text-slate-300">{r.name}</span>
                  <span className="text-rose-300 font-bold">
                    {r.count}× · {formatMoney(r.total, currentCurrency, true)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Panel>
        )}
      </div>
      )}

      {/* ── Outstanding + live linkage ── */}
      {(showSec("outstanding") || showSec("links")) && (
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {showSec("outstanding") && (
        <Panel
          tid={`${testid}-outstanding`}
          title="Outstanding & Receivables"
          icon={FileWarning}
          action={
            <span className={`text-sm font-black ${outstandingTotal > 0 ? "text-amber-300" : "text-emerald-300"}`}>
              {formatMoney(outstandingTotal, currentCurrency, true)}
            </span>
          }
        >
          <div className="p-3.5 space-y-2 max-h-60 overflow-y-auto">
            {openInvoices.length === 0 && report.pendingCollections.length === 0 && (
              <p className="text-xs text-slate-500">
                Nothing outstanding — every invoice is settled and no collections are pending verification.
              </p>
            )}
            {openInvoices.map((d) => (
              <div
                key={`doc-${d.id}`}
                className="flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-900/70 border border-amber-500/25 text-xs"
              >
                <div className="min-w-0">
                  <div className="text-slate-200 font-semibold truncate">
                    {d.documentNumber} — {d.customerName}
                  </div>
                  <div className="text-[10px] text-slate-500">
                    Invoice • {d.status}
                    {d.dueDate ? ` • due ${d.dueDate}` : ""}
                  </div>
                </div>
                <span className="text-amber-300 font-bold shrink-0">
                  {formatMoney(d.totalGhs, currentCurrency, true)}
                </span>
              </div>
            ))}
            {report.pendingCollections.map((p) => (
              <div
                key={`tx-${p.id}`}
                className="flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-900/70 border border-sky-500/25 text-xs"
              >
                <div className="min-w-0">
                  <div className="text-slate-200 truncate">{p.label}</div>
                  <div className="text-[10px] text-slate-500">
                    {p.status === "PENDING_MOMO_VERIFICATION" ? "MoMo awaiting verification" : p.status.replace(/_/g, " ")}
                    {p.method ? ` • ${p.method}` : ""} • {p.date}
                  </div>
                </div>
                <span className="text-sky-300 font-bold shrink-0">{formatMoney(p.amount, currentCurrency, true)}</span>
              </div>
            ))}
          </div>
        </Panel>
        )}

        {showSec("links") && (
        <Panel
          tid={`${testid}-links`}
          title="Real-Time Data Links"
          icon={Link2}
          action={<span className="text-[10px] text-emerald-300 font-bold">auto-synced</span>}
        >
          <div className="p-3.5 flex flex-wrap gap-2">
            <span className="px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-[11px] text-emerald-200 font-semibold">
              Sales: {report.salesCount} · {formatMoney(report.revenue - (report.baselineIncludedInTotals ? baseline?.revenueGhs || 0 : 0), currentCurrency, true)} in range
            </span>
            <span className="px-2.5 py-1.5 rounded-lg bg-violet-500/10 border border-violet-500/30 text-[11px] text-violet-200 font-semibold">
              Purchases: {purchaseRows.length} · {formatMoney(purchaseTotal, currentCurrency, true)}
            </span>
            <span className="px-2.5 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[11px] text-rose-200 font-semibold">
              Expenses: {report.expenseCount} · {formatMoney(report.expenses - (report.baselineIncludedInTotals ? baseline?.expensesGhs || 0 : 0), currentCurrency, true)}
            </span>
            <span className="px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-200 font-semibold">
              Inventory: {invStats.items} items · {formatMoney(invStats.costValue, currentCurrency, true)} at cost
            </span>
            {opsLinks.map((l) => (
              <span
                key={l.label}
                title={l.note || l.label}
                className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold ${CHIP_CLS[l.tone || "slate"] || CHIP_CLS.slate}`}
              >
                {l.label}: {l.value}
              </span>
            ))}
            <span className="px-2.5 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-[11px] text-cyan-200 font-semibold">
              Payments: {report.paymentsInByMethod.length} channels active
            </span>
            {customers.length > 0 && (
              <span className="px-2.5 py-1.5 rounded-lg bg-sky-500/10 border border-sky-500/30 text-[11px] text-sky-200 font-semibold">
                Customers: {customers.length} in CRM
              </span>
            )}
          </div>
          <p className="px-3.5 pb-3 text-[10px] text-slate-500">
            Sales, purchases, inventory, production, orders, expenses and payments post straight into this report the
            moment they happen — nothing here needs manual reconciliation.
          </p>
        </Panel>
        )}
      </div>
      )}

      {/* ── Per-branch / per-business split ── */}
      {showSec("scope") && isEnterprise && (
        <EnterpriseSplitTable
          tid={`${testid}-per-business`}
          businesses={businesses}
          metrics={metrics}
          transactions={transactions}
          period={period}
          currentCurrency={currentCurrency}
        />
      )}
      {showSec("scope") && !isEnterprise && report.branchesKey.length > 1 && (
        <Panel tid={`${testid}-per-branch`} title="Branch / Register Split" icon={Building2}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/90 text-slate-400 uppercase text-[10px]">
                <tr>
                  {["Branch", "Sales", "Revenue", "Expenses", "Profit"].map((h) => (
                    <th key={h} className="px-4 py-2.5">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {report.branchesKey.map((b) => (
                  <tr key={b.code} className="hover:bg-slate-700/40">
                    <td className="px-4 py-2.5 font-semibold text-slate-200">{b.code}</td>
                    <td className="px-4 py-2.5 text-slate-300">{b.sales}</td>
                    <td className="px-4 py-2.5 text-emerald-300 font-bold">
                      {formatMoney(b.revenue, currentCurrency, true)}
                    </td>
                    <td className="px-4 py-2.5 text-rose-300 font-bold">
                      {formatMoney(b.expenses, currentCurrency, true)}
                    </td>
                    <td
                      className={`px-4 py-2.5 font-bold ${b.profit >= 0 ? "text-cyan-300" : "text-rose-300"}`}
                    >
                      {formatMoney(b.profit, currentCurrency, true)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* ── Ledger ── */}
      {showSec("ledger") && (
      <Panel
        tid={`${testid}-ledger`}
        title="Financial Ledger — Sales, Purchases, Expenses & Payments"
        icon={Receipt}
        action={<span className="text-[10px] text-slate-500">{report.ledger.length} of {report.liveTxnCount} live entries shown</span>}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-900/90 text-slate-400 uppercase text-[10px]">
              <tr>
                {["Date", "Reference", "Type", "Category", "Method", "Status", "Amount", "Recorded By"].map((h) => (
                  <th key={h} className="px-4 py-2.5">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/60">
              {report.ledger.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                    No financial entries inside this range — record a sale, purchase, order fulfilment or expense and it
                    appears here instantly.
                  </td>
                </tr>
              )}
              {report.ledger.map((t) => (
                <tr key={t.id} className="hover:bg-slate-700/40">
                  <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap">{t.date}</td>
                  <td className="px-4 py-2.5 text-slate-400 font-mono text-[10px]">{t.transactionNumber}</td>
                  <td className="px-4 py-2.5">
                    <span className={`px-1.5 py-0.5 rounded-full border text-[10px] font-bold ${typeBadge(t)}`}>
                      {t.type}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-300 max-w-[220px] truncate" title={t.description || t.category}>
                    {t.category}
                  </td>
                  <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap">
                    {(t.paymentMethod || "").replace(/_/g, " ")}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`text-[10px] font-bold ${
                        t.status === "COMPLETED"
                          ? "text-emerald-400"
                          : t.status === "OFFLINE_QUEUED"
                          ? "text-sky-400"
                          : "text-amber-400"
                      }`}
                    >
                      {(t.status || "").replace(/_/g, " ")}
                    </span>
                  </td>
                  <td
                    className={`px-4 py-2.5 font-bold whitespace-nowrap ${
                      t.type === "INCOME" ? "text-emerald-300" : t.type === "EXPENSE" ? "text-rose-300" : "text-sky-300"
                    }`}
                  >
                    {t.type === "EXPENSE" ? "−" : "+"}
                    {formatMoney(t.amountGhs, currentCurrency, true)}
                  </td>
                  <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap">
                    {t.recordedBy}
                    {t.recordedByRole ? <span className="text-[9px] text-cyan-400"> · {t.recordedByRole}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">
          Full audit trail and PDF/Excel exports: use the Export / Audit button at the top-right of the app.
        </p>
      </Panel>
      )}
    </div>
  );
}

/** Enterprise consolidated per-branch table (Command Center). */
function EnterpriseSplitTable({
  tid,
  businesses,
  metrics,
  transactions,
  period,
  currentCurrency,
}: any) {
  const rows = useMemo(() => {
    const inRange = (d: string) => {
      const s = String(d || "").slice(0, 10);
      if (!s) return false;
      if (period.start && s < period.start) return false;
      if (period.end && s > period.end) return false;
      return true;
    };
    return (businesses || [])
      .map((b: any) => {
        const metric = (metrics || []).find((m: any) => m.businessId === b.id);
        const base = recoverBaseline(metric, transactions || []);
        const ledger = ((transactions || []) as any[]).filter(
          (t: any) => t.businessId === b.id && ["INCOME", "EXPENSE"].includes(t.type) && inRange(t.date) &&
            !/^TRX-\d{4}-100[1-6]$/.test(String(t.transactionNumber || ""))
        );
        const inc = ledger.filter((t: any) => t.type === "INCOME").reduce((s: number, t: any) => s + (t.amountGhs || 0), 0);
        const exp = ledger.filter((t: any) => t.type === "EXPENSE").reduce((s: number, t: any) => s + (t.amountGhs || 0), 0);
        const foldBase = period.key === "ALL_TIME" && base;
        const revenue = inc + (foldBase ? base!.revenueGhs : 0);
        const expenses = exp + (foldBase ? base!.expensesGhs : 0);
        return {
          id: b.id,
          code: b.code,
          name: b.name,
          branch: [b.town, b.region].filter(Boolean).join(", "),
          category: b.category,
          sales: ledger.filter((t: any) => t.type === "INCOME").length,
          revenue,
          expenses,
          profit: revenue - expenses,
        };
      })
      .sort((a: any, b: any) => b.revenue - a.revenue);
  }, [businesses, metrics, transactions, period]);

  return (
    <div data-testid={tid} className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl">
      <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Building2 className="w-4 h-4 text-emerald-400" />
          <h4 className="text-sm font-bold text-white">Financial Report by Business & Branch</h4>
        </div>
        <span className="text-[10px] text-slate-500">{period.label}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-900/90 text-slate-400 uppercase text-[10px]">
            <tr>
              {["Business / Branch", "Type", "Location", "Sales", "Revenue", "Expenses", "Net Profit", "Margin"].map(
                (h) => (
                  <th key={h} className="px-4 py-2.5">
                    {h}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/60">
            {rows.map((r: any) => (
              <tr key={r.id} className="hover:bg-slate-700/40">
                <td className="px-4 py-2.5">
                  <div className="font-semibold text-slate-200">{r.name}</div>
                  <div className="text-[10px] text-slate-500">{r.code}</div>
                </td>
                <td className="px-4 py-2.5 text-slate-400">{r.category}</td>
                <td className="px-4 py-2.5 text-slate-400">{r.branch || "—"}</td>
                <td className="px-4 py-2.5 text-slate-300">{r.sales}</td>
                <td className="px-4 py-2.5 text-emerald-300 font-bold">{formatMoney(r.revenue, currentCurrency, true)}</td>
                <td className="px-4 py-2.5 text-rose-300 font-bold">{formatMoney(r.expenses, currentCurrency, true)}</td>
                <td className={`px-4 py-2.5 font-bold ${r.profit >= 0 ? "text-cyan-300" : "text-rose-300"}`}>
                  {formatMoney(r.profit, currentCurrency, true)}
                </td>
                <td className="px-4 py-2.5 text-slate-300">
                  {r.revenue > 0 ? `${((r.profit / r.revenue) * 100).toFixed(1)}%` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
