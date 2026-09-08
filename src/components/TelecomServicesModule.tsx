"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import AiSectionGuide from "./AiSectionGuide";
import {
  Wifi, Smartphone, Phone, Database, Wallet, Activity, Users,
  FileText, LayoutDashboard, ClipboardList, X, Plus, QrCode,
  CheckCircle2, AlertTriangle, TrendingUp, CircleDollarSign,
  BarChart3, RefreshCw, Signal, Ticket, Banknote, Gauge, BanknoteArrowDown,
} from "lucide-react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, XAxis, YAxis,
  AreaChart, Area,
} from "recharts";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import DailyChecklistPanel from "./DailyChecklistPanel";
import FinancialReportSection from "./FinancialReportSection";

type Props = {
  currentUser: any;
  businessInfo: any;
  businessMetrics: any;
  inventory: any[];
  customers: any[];
  transactions: any[];
  assets: any[];
  employees: any[];
  currentCurrency: CurrencyCode;
  onRefreshData: () => void;
};

type Tab = "DASHBOARD" | "MOMO" | "AIRDATA" | "WIFI" | "SALES" | "FINANCE" | "CUSTOMERS" | "REPORTS" | "CHECKLIST";
type FormType = null | "LINE" | "MOMO_TXN" | "AIRDATA_TXN" | "PACKAGE" | "VOUCHER_BATCH" | "VOUCHER_SELL" | "FLOAT" | "EXPENSE";

const TABS: { key: Tab; label: string; icon: any }[] = [
  { key: "DASHBOARD", label: "Dashboard", icon: LayoutDashboard },
  { key: "MOMO", label: "MoMo & Float", icon: Smartphone },
  { key: "AIRDATA", label: "Airtime & Data", icon: Signal },
  { key: "WIFI", label: "Wi-Fi & Vouchers", icon: Wifi },
  { key: "SALES", label: "Sales", icon: TrendingUp },
  { key: "FINANCE", label: "Finance", icon: CircleDollarSign },
  { key: "CUSTOMERS", label: "Customers", icon: Users },
  { key: "REPORTS", label: "Reports", icon: BarChart3 },
  { key: "CHECKLIST", label: "Daily Checklist", icon: ClipboardList },
];

const NETWORK_STYLE: Record<string, string> = {
  MTN: "bg-yellow-500/15 text-yellow-300 border-yellow-500/40",
  TELECEL: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  AT: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  WIFI: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
};
const TXN_STATUS_STYLE: Record<string, string> = {
  SUCCESS: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  FAILED: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  PENDING: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  AVAILABLE: "bg-slate-600/30 text-slate-300 border-slate-500/40",
  SOLD: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  USED: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  EXPIRED: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  REVOKED: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  ACTIVE: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  INACTIVE: "bg-slate-600/30 text-slate-400 border-slate-500/40",
};
const Badge = ({ s }: { s: string }) => (
  <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${TXN_STATUS_STYLE[s] || "bg-slate-700/40 text-slate-300 border-slate-600"}`}>{s}</span>
);
const NetBadge = ({ s }: { s: string | null }) =>
  s ? <span className={`px-1.5 py-0.5 rounded border text-[9px] font-black ${NETWORK_STYLE[s] || "bg-slate-700/40 text-slate-300 border-slate-600"}`}>{s}</span> : null;

const TYPE_LABEL: Record<string, string> = {
  MOMO_DEPOSIT: "MoMo Deposit",
  MOMO_WITHDRAWAL: "MoMo Withdrawal",
  MOMO_TRANSFER: "MoMo Transfer",
  AIRTIME: "Airtime",
  DATA: "Data Bundle",
  WIFI_VOUCHER: "Wi-Fi Voucher",
};
const PAYMENT_METHODS = ["CASH", "MTN_MOMO", "TELECEL_CASH", "AT_MONEY", "BANK_TRANSFER", "CARD"];

const money = (v: number, c: CurrencyCode) => formatMoney(v || 0, c, true);
const fmtDT = (d: any) => (d ? new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

export default function TelecomServicesModule({
  currentUser, businessInfo, businessMetrics, inventory, customers,
  transactions, assets, employees, currentCurrency, onRefreshData,
}: Props) {
  const bizId = businessInfo?.id;
  const bizCode = businessInfo?.code || "TELECOM-01";
  const today = new Date().toISOString().split("T")[0];

  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("DASHBOARD");
  const [lines, setLines] = useState<any[]>([]);
  const [txns, setTxns] = useState<any[]>([]);
  const [packages, setPackages] = useState<any[]>([]);
  const [vouchers, setVouchers] = useState<any[]>([]);
  const [activities, setActivities] = useState<any[]>([]);
  const [showForm, setShowForm] = useState<FormType>(null);
  const [formCtx, setFormCtx] = useState<any>(null); // preselected line/voucher/package
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [voucherFilter, setVoucherFilter] = useState<string>("ALL");

  const refresh = useCallback(async () => {
    if (!bizId) return;
    try {
      const res = await fetch(`/api/telecom?businessId=${bizId}`);
      const d = await res.json();
      if (d.success) {
        setLines(d.lines || []);
        setTxns(d.txns || []);
        setPackages(d.packages || []);
        setVouchers(d.vouchers || []);
        setActivities(d.activities || []);
      } else setError(d.error || "Failed to load the telecom workspace.");
    } finally {
      setLoading(false);
    }
  }, [bizId]);

  useEffect(() => { setLoading(true); refresh(); }, [refresh]);

  const submit = async (type: FormType, data: any) => {
    setBusy(true);
    setError("");
    const entityMap: Record<string, string> = {
      LINE: "LINE", MOMO_TXN: "TXN", AIRDATA_TXN: "TXN", PACKAGE: "PACKAGE",
      VOUCHER_BATCH: "VOUCHER_BATCH", VOUCHER_SELL: "VOUCHER_SALE", EXPENSE: "EXPENSE",
    };
    try {
      const res = await fetch("/api/telecom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity: entityMap[String(type)],
          data: { ...data, businessId: bizId, createdByName: currentUser?.name, createdByRole: currentUser?.role, createdByUserId: currentUser?.id },
        }),
      });
      const d = await res.json();
      if (d.success) {
        setShowForm(null);
        setFormCtx(null);
        await refresh();
        onRefreshData();
      } else setError(d.error || "Save failed");
    } catch (e: any) {
      setError(e.message || "Network error");
    } finally {
      setBusy(false);
    }
  };

  const patchEntity = async (entity: string, id: number | string, data: any) => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/telecom", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity, id,
          data: { ...data, actorName: currentUser?.name, actorRole: currentUser?.role, actorUserId: currentUser?.id },
        }),
      });
      const d = await res.json();
      if (!d.success) setError(d.error || "Update failed");
      else { setShowForm(null); setFormCtx(null); }
      await refresh();
      onRefreshData();
    } catch (e: any) {
      setError(e.message || "Network error");
    } finally {
      setBusy(false);
    }
  };

  // ── Derived data ────────────────────────────────────────────────────────
  const successTxns = useMemo(() => txns.filter((t) => t.status === "SUCCESS"), [txns]);
  const failedTxns = useMemo(() => txns.filter((t) => t.status === "FAILED"), [txns]);
  const todayTxns = useMemo(() => successTxns.filter((t) => t.txnDate === today), [successTxns, today]);
  const todayFailed = useMemo(() => failedTxns.filter((t) => t.txnDate === today), [failedTxns, today]);
  const momoTxns = useMemo(() => txns.filter((t) => t.type.startsWith("MOMO")), [txns]);
  const airdataTxns = useMemo(() => txns.filter((t) => t.type === "AIRTIME" || t.type === "DATA"), [txns]);

  const todayTurnover = todayTxns.reduce((s, t) => s + (t.amountGhs || 0) + (t.chargeGhs || 0), 0);
  const totalCommissions = successTxns.reduce((s, t) => s + (t.commissionGhs || 0), 0);
  const todayCommissions = todayTxns.reduce((s, t) => s + (t.commissionGhs || 0), 0);
  const totalFloat = lines.filter((l) => l.active).reduce((s, l) => s + (l.floatGhs || 0), 0);
  const totalCash = lines.filter((l) => l.active).reduce((s, l) => s + (l.cashGhs || 0), 0);

  // Shared Finance ledger rows for this business (income/expenses posted by
  // this module + any other branch activity) — profit = income − expenses.
  const branchLedger = useMemo(() => (transactions || []).filter((t: any) => t.businessId === bizId), [transactions, bizId]);
  const ledgerIncome = branchLedger.filter((t: any) => t.type === "INCOME").reduce((s: number, t: any) => s + (t.amountGhs || 0), 0);
  const ledgerExpense = branchLedger.filter((t: any) => t.type === "EXPENSE").reduce((s: number, t: any) => s + (t.amountGhs || 0), 0);
  const netProfit = ledgerIncome - ledgerExpense;

  const vouchersAvail = vouchers.filter((v) => v.status === "AVAILABLE");
  const wifiUsers = vouchers.filter((v) => v.status === "SOLD" || v.status === "USED");
  const expiringSoon = wifiUsers.filter((v) => v.expiresAt && new Date(v.expiresAt).getTime() - Date.now() < 24 * 3600 * 1000 && new Date(v.expiresAt).getTime() > Date.now());

  const salesByType = useMemo(() => {
    const map: Record<string, number> = {};
    successTxns.forEach((t) => { const k = TYPE_LABEL[t.type] || t.type; map[k] = (map[k] || 0) + (t.amountGhs || 0) + (t.chargeGhs || 0); });
    return Object.entries(map).map(([name, total]) => ({ name, total }));
  }, [successTxns]);

  const trend = useMemo(() => {
    const days: { label: string; revenue: number; commissions: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().split("T")[0];
      const rows = successTxns.filter((t) => t.txnDate === key);
      days.push({
        label: d.toLocaleDateString("en-GB", { weekday: "short" }),
        revenue: Math.round(rows.reduce((s, t) => s + (t.amountGhs || 0) + (t.chargeGhs || 0), 0) * 100) / 100,
        commissions: Math.round(rows.reduce((s, t) => s + (t.commissionGhs || 0), 0) * 100) / 100,
      });
    }
    return days;
  }, [successTxns]);

  const alerts = useMemo(() => {
    const a: { text: string; color: string }[] = [];
    lines.filter((l) => l.active && l.kind === "MOMO_AGENT" && (l.floatGhs || 0) < 500)
      .forEach((l) => a.push({ text: `Low float on ${l.label} (${l.network}) — GH₵${(l.floatGhs || 0).toFixed(2)} left. Top up before deposits start failing.`, color: "amber" }));
    if (todayFailed.length) a.push({ text: `${todayFailed.length} failed transaction${todayFailed.length === 1 ? "" : "s"} today — review reasons in MoMo / Airtime & Data tabs and re-attempt.`, color: "rose" });
    packages.filter((p) => p.active && !vouchers.some((v) => v.packageId === p.id && v.status === "AVAILABLE"))
      .forEach((p) => a.push({ text: `No available vouchers for ${p.name} — generate a fresh batch so sales never stall.`, color: "amber" }));
    if (expiringSoon.length) a.push({ text: `${expiringSoon.length} Wi-Fi user${expiringSoon.length === 1 ? "" : "s"} expire within 24 hours.`, color: "amber" });
    return a;
  }, [lines, todayFailed, packages, vouchers, expiringSoon]);

  const branchCustomers = useMemo(() => (customers || []).filter((c: any) => c.businessId === bizId), [customers, bizId]);
  const momoLines = lines.filter((l) => l.kind === "MOMO_AGENT");
  const walletLines = lines.filter((l) => l.kind === "AIRTIME_WALLET" || l.kind === "DATA_WALLET");

  // ── Small shared render helpers ────────────────────────────────────────
  const Stat = ({ label, value, sub, color = "cyan", icon: Icon, testid }: any) => {
    const ring: Record<string, string> = {
      cyan: "text-cyan-300", emerald: "text-emerald-300", amber: "text-amber-300",
      rose: "text-rose-300", blue: "text-blue-300", purple: "text-purple-300",
      orange: "text-orange-300", slate: "text-slate-300",
    };
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-3.5" data-testid={testid}>
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase font-bold text-slate-400">{label}</span>
          {Icon && <Icon className={`w-4 h-4 ${ring[color]}`} />}
        </div>
        <div className="text-xl font-black text-white mt-1" data-testid={testid ? `${testid}-value` : undefined}>{value}</div>
        {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
      </div>
    );
  };
  const Card = ({ title, icon: Icon, children, action, testid }: any) => (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/60 overflow-hidden" data-testid={testid}>
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-700/70 bg-slate-800/80">
        <div className="flex items-center gap-2">{Icon && <Icon className="w-4 h-4 text-cyan-400" />}<h3 className="text-sm font-bold text-white">{title}</h3></div>
        {action}
      </div>
      {children}
    </div>
  );
  const DataTable = ({ headers, rows, testid }: any) => (
    <div className="overflow-x-auto" data-testid={testid}>
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-900/90 text-slate-400 uppercase text-[10px]">
          <tr>{headers.map((h: string) => <th key={h} className="px-4 py-3">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-700/60">
          {rows.length ? rows.map((r: any[], i: number) => (
            <tr key={i} className={`hover:bg-slate-700/40 ${r[0] === "__FAILED__" ? "bg-rose-500/5" : ""}`}>{r.filter((_, j) => !(j === 0 && r[0] === "__FAILED__")).map((c, j) => <td key={j} className="px-4 py-3 text-slate-300">{c}</td>)}</tr>
          )) : <tr><td colSpan={headers.length} className="px-4 py-8 text-center text-slate-400">No records yet</td></tr>}
        </tbody>
      </table>
    </div>
  );

  const PIE_COLORS = ["#22d3ee", "#facc15", "#f472b6", "#34d399", "#818cf8", "#fb923c"];
  const txnRow = (t: any) => [
    ...(t.status === "FAILED" ? ["__FAILED__"] : []),
    <span className="font-mono text-[10px]">{t.txnNumber}</span>,
    t.txnDate,
    TYPE_LABEL[t.type] || t.type,
    <NetBadge s={t.network} />,
    t.customerName || "—",
    money(t.amountGhs, currentCurrency),
    t.chargeGhs ? money(t.chargeGhs, currentCurrency) : "—",
    <span className="text-emerald-300 font-bold">{t.commissionGhs ? money(t.commissionGhs, currentCurrency) : "—"}</span>,
    t.status === "FAILED"
      ? <span className="text-rose-300"><Badge s="FAILED" /><span className="ml-1 text-[10px]">{t.failReason}</span></span>
      : <Badge s={t.status} />,
    t.reference || "—",
  ];

  if (loading) {
    return <div className="p-10 text-center text-slate-400 text-sm">Loading Telecom &amp; Digital Services workspace…</div>;
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto text-slate-100" data-testid="telecom-module">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-cyan-950/40 to-slate-900 p-6 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-slate-800 border border-cyan-500/40 flex items-center justify-center shadow-lg shrink-0">
            <Wifi className="w-7 h-7 text-cyan-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 text-xs font-bold border border-cyan-500/30">TELECOM &amp; DIGITAL SERVICES</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 text-white">{businessInfo?.name || "Telecom & Digital Services"}</h2>
            <p className="text-xs text-slate-400 mt-1">{bizCode} • {businessInfo?.branchLocation || "Ghana"} • Manager: <strong className="text-cyan-300">{businessInfo?.managerName || "Desk Supervisor"}</strong> • MoMo • Airtime • Data • Wi-Fi</p>
          </div>
        </div>
        {error && <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/40 rounded-lg px-3 py-2" data-testid="tel-error">{error}<button className="ml-2 text-rose-200" onClick={() => setError("")}>✕</button></div>}
        <div className="flex flex-wrap gap-2">
          <button data-testid="tel-open-momo" onClick={() => { setFormCtx(null); setShowForm("MOMO_TXN"); }} className="px-3 py-2 rounded-lg bg-yellow-600 hover:bg-yellow-500 text-white text-xs font-bold flex items-center gap-1"><Smartphone className="w-3.5 h-3.5" />MoMo Txn</button>
          <button data-testid="tel-open-airdata" onClick={() => { setFormCtx(null); setShowForm("AIRDATA_TXN"); }} className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center gap-1"><Signal className="w-3.5 h-3.5" />Airtime/Data</button>
          <button data-testid="tel-open-package" onClick={() => { setFormCtx(null); setShowForm("PACKAGE"); }} className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><Ticket className="w-3.5 h-3.5" />Wi-Fi Package</button>
          <button data-testid="tel-open-line" onClick={() => { setFormCtx(null); setShowForm("LINE"); }} className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />Agent Line</button>
          <button data-testid="tel-open-expense" onClick={() => { setFormCtx(null); setShowForm("EXPENSE"); }} className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold flex items-center gap-1"><Wallet className="w-3.5 h-3.5" />Expense</button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex flex-wrap gap-1 bg-slate-800/60 border border-slate-700 rounded-xl p-1">
        {TABS.map((t) => (
          <button key={t.key} data-testid={`tel-tab-${t.key}`} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition ${tab === t.key ? "bg-cyan-600 text-white" : "text-slate-400 hover:text-white"}`}>
            <t.icon className="w-3.5 h-3.5" />{t.label}
          </button>
        ))}
        <AiSectionGuide moduleKey="TELECOM" section={tab} businessInfo={businessInfo} />
      </div>

      {alerts.length > 0 && tab === "DASHBOARD" && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-1" data-testid="tel-alerts">
          {alerts.slice(0, 6).map((a, i) => (
            <div key={i} className={`flex items-center gap-2 text-xs ${a.color === "rose" ? "text-rose-200" : "text-amber-200"}`}><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{a.text}</div>
          ))}
        </div>
      )}

      {/* ══════════════ DASHBOARD ══════════════ */}
      {tab === "DASHBOARD" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat testid="tel-stat-turnover" label="Turnover Today" value={money(todayTurnover, currentCurrency)} sub={`${todayTxns.length} successful txns`} color="emerald" icon={TrendingUp} />
            <Stat testid="tel-stat-commissions" label="Commissions Today" value={money(todayCommissions, currentCurrency)} sub={`${money(totalCommissions, currentCurrency)} all time`} color="cyan" icon={CircleDollarSign} />
            <Stat testid="tel-stat-profit" label="Net Profit (Ledger)" value={money(netProfit, currentCurrency)} sub={`income ${money(ledgerIncome, currentCurrency)} − exp ${money(ledgerExpense, currentCurrency)}`} color={netProfit >= 0 ? "amber" : "rose"} icon={Activity} />
            <Stat testid="tel-stat-float" label="Total Float" value={money(totalFloat, currentCurrency)} sub={`${momoLines.length} MoMo lines`} color="purple" icon={Gauge} />
            <Stat testid="tel-stat-cash" label="Cash on Hand" value={money(totalCash, currentCurrency)} sub="across all tills" color="orange" icon={Banknote} />
            <Stat testid="tel-stat-failed" label="Failed Txns Today" value={todayFailed.length} sub={`${failedTxns.length} all time`} color={todayFailed.length ? "rose" : "slate"} icon={AlertTriangle} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card title="Sales by Service" icon={BarChart3} testid="tel-card-mix">
              <div className="p-4">
                {salesByType.length ? (
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart>
                      <Pie data={salesByType} dataKey="total" nameKey="name" innerRadius={36} outerRadius={62} paddingAngle={2}>
                        {salesByType.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={(v: any) => formatMoney(Number(v), currentCurrency)} contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : <p className="text-[11px] text-slate-500 text-center py-6">MoMo, airtime, data and Wi-Fi sales appear here as they happen.</p>}
                {salesByType.length > 0 && (
                  <div className="grid grid-cols-2 gap-1 mt-1">
                    {salesByType.map((s, i) => (
                      <div key={s.name} className="flex items-center gap-1.5 text-[10px] text-slate-400">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                        {s.name} <span className="ml-auto font-bold text-slate-300">{money(s.total, currentCurrency)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>

            <Card title="This Week — Turnover vs Commissions" icon={BarChart3} testid="tel-card-trend">
              <div className="p-3">
                <ResponsiveContainer width="100%" height={210}>
                  <AreaChart data={trend} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                    <defs>
                      <linearGradient id="telRev" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22d3ee" stopOpacity={0.5} /><stop offset="100%" stopColor="#22d3ee" stopOpacity={0} /></linearGradient>
                      <linearGradient id="telCom" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#facc15" stopOpacity={0.4} /><stop offset="100%" stopColor="#facc15" stopOpacity={0} /></linearGradient>
                    </defs>
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                    <Tooltip formatter={(v: any) => formatMoney(Number(v), currentCurrency)} contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }} />
                    <Area type="monotone" dataKey="revenue" stroke="#22d3ee" fill="url(#telRev)" strokeWidth={2} name="Turnover" />
                    <Area type="monotone" dataKey="commissions" stroke="#facc15" fill="url(#telCom)" strokeWidth={2} name="Commissions" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card title="Recent Activity" icon={Activity} testid="tel-card-activity">
              <div className="p-3 space-y-1.5 max-h-[240px] overflow-y-auto">
                {activities.length ? activities.slice(0, 12).map((a) => (
                  <div key={a.id} className="text-[11px] p-2 rounded-lg bg-slate-900/70 border border-slate-700/70">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`font-bold ${a.action.includes("FAILED") || a.action.includes("EXPIRED") ? "text-rose-300" : "text-cyan-300"}`}>{a.action.replaceAll("_", " ")}</span>
                      <span className="text-[9px] text-slate-500 whitespace-nowrap">{fmtDT(a.recordedAt)}</span>
                    </div>
                    <p className="text-slate-400 mt-0.5">{a.detail}</p>
                    {a.actorName && <p className="text-[9px] text-slate-600 mt-0.5">by {a.actorName}{a.actorRole ? ` (${a.actorRole})` : ""}</p>}
                  </div>
                )) : <p className="text-[11px] text-slate-500 text-center py-6">Every transaction, float movement, voucher sale and expiry lands here automatically.</p>}
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Agent Lines — Float & Cash" icon={Gauge} testid="tel-dash-lines"
              action={<button data-testid="tel-open-line-2" onClick={() => setShowForm("LINE")} className="text-[10px] font-bold text-cyan-300 hover:text-cyan-200">+ New line</button>}>
              <div className="p-3 space-y-2" data-testid="tel-dash-lines-list">
                {lines.length ? lines.map((l) => (
                  <div key={l.id} className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-slate-900/70 border border-slate-700/70" data-testid={`tel-line-${l.id}`}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white truncate">{l.label}</span>
                        <NetBadge s={l.network} />
                        {!l.active && <Badge s="INACTIVE" />}
                      </div>
                      <p className="text-[10px] text-slate-500">{l.kind.replaceAll("_", " ")}{l.msisdn ? ` • ${l.msisdn}` : ""}</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="text-right"><div className="text-[9px] uppercase text-slate-500 font-bold">Float</div><div className="text-xs font-black text-purple-300" data-testid={`tel-line-float-${l.id}`}>{money(l.floatGhs, currentCurrency)}</div></div>
                      <div className="text-right"><div className="text-[9px] uppercase text-slate-500 font-bold">Cash</div><div className="text-xs font-black text-orange-300" data-testid={`tel-line-cash-${l.id}`}>{money(l.cashGhs, currentCurrency)}</div></div>
                      <button data-testid={`tel-line-topup-${l.id}`} onClick={() => { setFormCtx({ line: l }); setShowForm("FLOAT"); }} className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-cyan-600/30 border border-slate-700 text-[10px] font-bold text-cyan-300">Top-up</button>
                    </div>
                  </div>
                )) : <p className="text-[11px] text-slate-500 text-center py-6">Agent lines (MoMo tills, airtime wallets) are created automatically for new Telecom units — add more any time.</p>}
              </div>
            </Card>

            <Card title="Wi-Fi Service" icon={Wifi} testid="tel-dash-wifi"
              action={<button onClick={() => setTab("WIFI")} className="text-[10px] font-bold text-cyan-300 hover:text-cyan-200">Manage →</button>}>
              <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                <div className="p-2.5 rounded-lg bg-slate-900/70 border border-slate-700"><div className="text-[10px] uppercase text-slate-500 font-bold">Packages</div><div className="text-lg font-black text-white" data-testid="tel-dash-pkg-count">{packages.length}</div></div>
                <div className="p-2.5 rounded-lg bg-slate-900/70 border border-slate-700"><div className="text-[10px] uppercase text-slate-500 font-bold">Vouchers Ready</div><div className="text-lg font-black text-emerald-300" data-testid="tel-dash-vc-avail">{vouchersAvail.length}</div></div>
                <div className="p-2.5 rounded-lg bg-slate-900/70 border border-slate-700"><div className="text-[10px] uppercase text-slate-500 font-bold">Active Users</div><div className="text-lg font-black text-cyan-300" data-testid="tel-dash-wifi-users">{wifiUsers.length}</div></div>
                <div className="p-2.5 rounded-lg bg-slate-900/70 border border-slate-700"><div className="text-[10px] uppercase text-slate-500 font-bold">Expiring 24h</div><div className="text-lg font-black text-amber-300">{expiringSoon.length}</div></div>
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ══════════════ MOMO & FLOAT ══════════════ */}
      {tab === "MOMO" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat testid="tel-momo-float" label="MoMo Float Total" value={money(momoLines.reduce((s, l) => s + (l.floatGhs || 0), 0), currentCurrency)} sub={`${momoLines.length} agent lines`} color="purple" icon={Gauge} />
            <Stat testid="tel-momo-cash" label="MoMo Till Cash" value={money(momoLines.reduce((s, l) => s + (l.cashGhs || 0), 0), currentCurrency)} sub="physical cash across tills" color="orange" icon={Banknote} />
            <Stat testid="tel-momo-comm" label="MoMo Commissions" value={money(momoTxns.filter((t) => t.status === "SUCCESS").reduce((s, t) => s + (t.commissionGhs || 0), 0), currentCurrency)} sub="posted to Finance as income" color="emerald" icon={CircleDollarSign} />
            <Stat testid="tel-momo-failed" label="Failed MoMo Txns" value={momoTxns.filter((t) => t.status === "FAILED").length} sub="tracked with reasons" color="rose" icon={AlertTriangle} />
          </div>
          <Card title="MoMo Transactions" icon={Smartphone} testid="tel-card-momo"
            action={<button data-testid="tel-open-momo-2" onClick={() => setShowForm("MOMO_TXN")} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-yellow-600 hover:bg-yellow-500 text-white text-[10px] font-bold"><Plus className="w-3 h-3" />New MoMo Txn</button>}>
            <DataTable testid="tel-momo-table" headers={["Txn #", "Date", "Type", "Network", "Customer", "Amount", "Fee", "Commission", "Status", "Network Ref"]}
              rows={momoTxns.map(txnRow)} />
          </Card>
          <p className="text-[10px] text-slate-500">Deposits move customer cash into the till and e-money out of float (with commission earned); withdrawals do the reverse. Insufficient float/cash blocks the txn before it fails at the network. Failed transactions move nothing and never touch Finance.</p>
        </div>
      )}

      {/* ══════════════ AIRTIME & DATA ══════════════ */}
      {tab === "AIRDATA" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat testid="tel-ad-count" label="Top-Ups Sold" value={airdataTxns.filter((t) => t.status === "SUCCESS").length} sub="airtime + data bundles" color="cyan" icon={Signal} />
            <Stat testid="tel-ad-turnover" label="Retail Value" value={money(airdataTxns.filter((t) => t.status === "SUCCESS").reduce((s, t) => s + (t.amountGhs || 0) + (t.chargeGhs || 0), 0), currentCurrency)} sub="what customers paid" color="emerald" icon={TrendingUp} />
            <Stat testid="tel-ad-margin" label="Margin Earned" value={money(airdataTxns.filter((t) => t.status === "SUCCESS").reduce((s, t) => s + (t.commissionGhs || 0), 0), currentCurrency)} sub="retail − wholesale + fees" color="amber" icon={CircleDollarSign} />
            <Stat testid="tel-ad-failed" label="Failed Top-Ups" value={airdataTxns.filter((t) => t.status === "FAILED").length} sub="with reasons logged" color="rose" icon={AlertTriangle} />
          </div>
          <Card title="Airtime & Data Sales" icon={Signal} testid="tel-card-airdata"
            action={<button data-testid="tel-open-airdata-2" onClick={() => setShowForm("AIRDATA_TXN")} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-[10px] font-bold"><Plus className="w-3 h-3" />Sell Airtime / Data</button>}>
            <DataTable testid="tel-airdata-table" headers={["Txn #", "Date", "Type", "Network", "Customer", "Amount", "Fee", "Margin", "Status", "Network Ref"]}
              rows={airdataTxns.map(txnRow)} />
          </Card>
          <p className="text-[10px] text-slate-500">Each sale pays the wholesale cost from the wallet's float (booked to Finance as stock cost) and books the customer's payment as income — profit is the margin, tracked per transaction.</p>
        </div>
      )}

      {/* ══════════════ WI-FI & VOUCHERS ══════════════ */}
      {tab === "WIFI" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat testid="tel-wifi-pkgs" label="Active Packages" value={packages.filter((p) => p.active).length} sub={`${packages.length} total`} color="cyan" icon={Ticket} />
            <Stat testid="tel-wifi-avail" label="Vouchers Ready" value={vouchersAvail.length} sub="unsold stock on hand" color="emerald" icon={QrCode} />
            <Stat testid="tel-wifi-users" label="Wi-Fi Users" value={wifiUsers.length} sub={`${expiringSoon.length} expiring within 24h`} color="purple" icon={Users} />
            <Stat testid="tel-wifi-sales" label="Wi-Fi Revenue" value={money(successTxns.filter((t) => t.type === "WIFI_VOUCHER").reduce((s, t) => s + (t.amountGhs || 0), 0), currentCurrency)} sub="full margin — no wholesale cost" color="amber" icon={CircleDollarSign} />
          </div>

          <Card title="Wi-Fi Packages" icon={Ticket} testid="tel-card-packages"
            action={<button data-testid="tel-open-package-2" onClick={() => setShowForm("PACKAGE")} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold"><Plus className="w-3 h-3" />New Package</button>}>
            <div className="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" data-testid="tel-pkg-list">
              {packages.length ? packages.map((p) => {
                const avail = vouchers.filter((v) => v.packageId === p.id && v.status === "AVAILABLE").length;
                const sold = vouchers.filter((v) => v.packageId === p.id && (v.status === "SOLD" || v.status === "USED")).length;
                return (
                  <div key={p.id} className={`rounded-xl border p-3.5 ${p.active ? "border-slate-700 bg-slate-900/60" : "border-slate-800 bg-slate-900/30 opacity-60"}`} data-testid={`tel-pkg-${p.id}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-bold text-white">{p.name}</p>
                        <p className="text-[10px] text-slate-500">{p.durationHours}h validity • {p.dataCapMb ? `${(p.dataCapMb / 1024) >= 1 ? `${Math.round(p.dataCapMb / 1024)}GB` : `${p.dataCapMb}MB`} cap` : "unlimited"} {p.routerLabel ? `• ${p.routerLabel}` : ""}</p>
                      </div>
                      <span className="text-sm font-black text-cyan-300">{money(p.priceGhs, currentCurrency)}</span>
                    </div>
                    <div className="flex items-center justify-between mt-2.5 text-[10px] text-slate-400">
                      <span><b className="text-emerald-300">{avail}</b> ready • <b className="text-cyan-300">{sold}</b> in use</span>
                      <div className="flex gap-1">
                        <button data-testid={`tel-pkg-gen-${p.id}`} onClick={() => { setFormCtx({ pkg: p }); setShowForm("VOUCHER_BATCH"); }} className="px-2 py-1 rounded-lg bg-cyan-600/20 hover:bg-cyan-600/40 border border-cyan-500/30 text-cyan-300 font-bold">+ Vouchers</button>
                        <button data-testid={`tel-pkg-toggle-${p.id}`} onClick={() => patchEntity("PACKAGE", p.id, { active: !p.active })} className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 font-bold">{p.active ? "Hide" : "Show"}</button>
                      </div>
                    </div>
                  </div>
                );
              }) : <p className="text-[11px] text-slate-500 py-4 col-span-3 text-center">Default packages (1-Hour, 1-Day, 1-Week…) are provisioned automatically for new Telecom units.</p>}
            </div>
          </Card>

          <Card title="Vouchers — Codes, Access PINs, QR & Expiry" icon={QrCode} testid="tel-card-vouchers"
            action={
              <div className="flex gap-1">
                {["ALL", "AVAILABLE", "SOLD", "USED", "EXPIRED", "REVOKED"].map((f) => (
                  <button key={f} data-testid={`tel-vc-filter-${f}`} onClick={() => setVoucherFilter(f)}
                    className={`px-2 py-1 rounded-lg text-[9px] font-black border ${voucherFilter === f ? "bg-cyan-600 text-white border-cyan-500" : "bg-slate-800 text-slate-400 border-slate-700"}`}>{f}</button>
                ))}
              </div>
            }>
            <div className="p-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 max-h-[520px] overflow-y-auto" data-testid="tel-vc-list">
              {vouchers.filter((v) => voucherFilter === "ALL" || v.status === voucherFilter).length ? vouchers.filter((v) => voucherFilter === "ALL" || v.status === voucherFilter).map((v) => (
                <div key={v.id} className="rounded-xl border border-slate-700 bg-slate-900/60 p-3 flex gap-3" data-testid={`tel-vc-${v.code}`}>
                  {v.qrData && <img src={v.qrData} alt={`QR ${v.code}`} className="w-16 h-16 rounded-lg bg-white p-1 shrink-0" data-testid={`tel-vc-qr-${v.code}`} />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-black text-white">{v.code}</span>
                      <Badge s={v.status} />
                    </div>
                    <p className="text-[10px] text-slate-400 mt-0.5">{v.packageName} • {money(v.priceGhs, currentCurrency)}</p>
                    <p className="text-[10px] text-slate-500">PIN <span className="font-mono font-bold text-slate-300">{v.accessCode}</span></p>
                    {v.customerName && <p className="text-[10px] text-slate-400 mt-0.5">User: <b className="text-slate-200">{v.customerName}</b>{v.customerPhone ? ` • ${v.customerPhone}` : ""}</p>}
                    {v.expiresAt && <p className="text-[10px] text-amber-300/90">Expires {fmtDT(v.expiresAt)}</p>}
                    <div className="flex gap-1 mt-1.5">
                      {v.status === "AVAILABLE" && (
                        <button data-testid={`tel-vc-sell-${v.id}`} onClick={() => { setFormCtx({ voucher: v }); setShowForm("VOUCHER_SELL"); }} className="px-2 py-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/40 border border-emerald-500/30 text-emerald-300 text-[10px] font-bold">Sell & Activate</button>
                      )}
                      {v.status === "SOLD" && (
                        <button data-testid={`tel-vc-used-${v.id}`} onClick={() => patchEntity("VOUCHER", v.id, { status: "USED" })} className="px-2 py-1 rounded-lg bg-sky-600/20 hover:bg-sky-600/40 border border-sky-500/30 text-sky-300 text-[10px] font-bold">Mark Used</button>
                      )}
                      {["AVAILABLE", "SOLD"].includes(v.status) && (
                        <button data-testid={`tel-vc-revoke-${v.id}`} onClick={() => patchEntity("VOUCHER", v.id, { status: "REVOKED" })} className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-rose-600/30 border border-slate-700 text-slate-400 hover:text-rose-300 text-[10px] font-bold">Revoke</button>
                      )}
                    </div>
                  </div>
                </div>
              )) : <p className="text-[11px] text-slate-500 py-6 col-span-3 text-center">No {voucherFilter === "ALL" ? "" : voucherFilter.toLowerCase()} vouchers — use “+ Vouchers” on a package to print a batch with codes, PINs and QR scan cards.</p>}
            </div>
          </Card>
        </div>
      )}

      {/* ══════════════ SALES ══════════════ */}
      {tab === "SALES" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat testid="tel-sales-count" label="Successful Sales" value={successTxns.length} sub="all services combined" color="emerald" icon={CheckCircle2} />
            <Stat testid="tel-sales-turnover" label="Total Turnover" value={money(successTxns.reduce((s, t) => s + (t.amountGhs || 0) + (t.chargeGhs || 0), 0), currentCurrency)} sub="customer money handled" color="cyan" icon={TrendingUp} />
            <Stat testid="tel-sales-earned" label="Commissions & Margins" value={money(totalCommissions, currentCurrency)} sub="the desk's earnings" color="amber" icon={CircleDollarSign} />
            <Stat testid="tel-sales-failed" label="Failed Transactions" value={failedTxns.length} sub="recorded for follow-up" color="rose" icon={AlertTriangle} />
          </div>
          <Card title="Sales Ledger — All Services" icon={FileText} testid="tel-card-sales">
            <DataTable testid="tel-sales-table" headers={["Txn #", "Date", "Service", "Network", "Customer", "Amount", "Fee", "Earned", "Status", "Ref"]}
              rows={txns.map(txnRow)} />
          </Card>
          <p className="text-[10px] text-slate-500">Every successful sale already posts to Finance, updates float/cash and accrues the customer's record — this is the unified view across MoMo, airtime, data and Wi-Fi.</p>
        </div>
      )}

      {/* ══════════════ FINANCE ══════════════ */}
      {tab === "FINANCE" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat testid="tel-fin-income" label="Income (Ledger)" value={money(ledgerIncome, currentCurrency)} sub="sales + commissions + fees" color="emerald" icon={TrendingUp} />
            <Stat testid="tel-fin-expense" label="Expenses (Ledger)" value={money(ledgerExpense, currentCurrency)} sub="wholesale costs + branch expenses" color="rose" icon={Wallet} />
            <Stat testid="tel-fin-profit" label="Net Profit" value={money(netProfit, currentCurrency)} sub="income − expenses" color={netProfit >= 0 ? "amber" : "rose"} icon={Activity} />
            <Stat testid="tel-fin-working" label="Working Capital" value={money(totalFloat + totalCash, currentCurrency)} sub={`float ${money(totalFloat, currentCurrency)} + cash ${money(totalCash, currentCurrency)}`} color="purple" icon={Gauge} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Float & Cash Reconciliation per Line" icon={Gauge} testid="tel-fin-lines">
              <DataTable testid="tel-fin-lines-table" headers={["Line", "Network", "Type", "Float", "Cash", "Total", "Status"]}
                rows={lines.map((l) => [
                  <span className="font-bold text-white">{l.label}</span>,
                  <NetBadge s={l.network} />,
                  l.kind.replaceAll("_", " "),
                  <span className="text-purple-300 font-bold">{money(l.floatGhs, currentCurrency)}</span>,
                  <span className="text-orange-300 font-bold">{money(l.cashGhs, currentCurrency)}</span>,
                  <span className="font-black text-white">{money((l.floatGhs || 0) + (l.cashGhs || 0), currentCurrency)}</span>,
                  <Badge s={l.active ? "ACTIVE" : "INACTIVE"} />,
                ])} />
            </Card>
            <Card title="Branch Finance Ledger (shared)" icon={FileText} testid="tel-fin-ledger">
              <div className="max-h-[320px] overflow-y-auto">
                <DataTable testid="tel-fin-ledger-table" headers={["Date", "Type", "Category", "Amount", "Description"]}
                  rows={branchLedger.slice(0, 40).map((t: any) => [
                    t.date,
                    <span className={t.type === "INCOME" ? "text-emerald-300 font-bold" : "text-rose-300 font-bold"}>{t.type}</span>,
                    t.category,
                    money(t.amountGhs, currentCurrency),
                    <span className="text-slate-400">{t.description}</span>,
                  ])} />
              </div>
            </Card>
          </div>
          <p className="text-[10px] text-slate-500">Income = customer payments (airtime/data sales, Wi-Fi vouchers) + MoMo commissions + service fees. Expenses = wholesale airtime/data costs (paid from float) + logged branch expenses. Float top-ups move money between the business and the tills — they are tracked per line, never double-counted as profit.</p>
        </div>
      )}

      {/* ══════════════ CUSTOMERS ══════════════ */}
      {tab === "CUSTOMERS" && (
        <div className="space-y-4">
          <Card title={`Customers of ${businessInfo?.name || "this unit"}`} icon={Users} testid="tel-card-customers">
            <DataTable testid="tel-cust-table" headers={["Customer", "Phone", "Total Spent", "Loyalty Pts", "Telecom Txns", "Last Service"]}
              rows={branchCustomers.map((c) => {
                const mine = successTxns.filter((t) => t.customerName === c.name || (c.phone !== "—" && t.customerPhone === c.phone));
                return [
                  <span className="font-bold text-white">{c.name}</span>,
                  c.phone || "—",
                  money(c.totalSpentGhs, currentCurrency),
                  c.loyaltyPoints ?? 0,
                  mine.length,
                  mine.length ? (TYPE_LABEL[mine[0].type] || mine[0].type) : "—",
                ];
              })} />
          </Card>
          <p className="text-[10px] text-slate-500">Customers are created automatically the first time they buy (MoMo, airtime, data or a Wi-Fi voucher) and their spend + loyalty accrues on every successful transaction — shared with the enterprise Customers directory.</p>
        </div>
      )}

      {/* ══════════════ REPORTS ══════════════ */}
      {tab === "REPORTS" && (
        <div className="space-y-4">
          <FinancialReportSection
            mode="business"
            businessInfo={businessInfo}
            businessMetric={businessMetrics}
            transactions={transactions}
            inventory={inventory}
            customers={customers}
            currentCurrency={currentCurrency}
            accent="cyan"
            testid="fin-report-tel"
            aiModuleKey="TELECOM"
            opsLinks={[
              {
                label: "MoMo transactions",
                value: `${momoTxns.filter((t) => t.status === "SUCCESS").length} · ${money(momoTxns.filter((t) => t.status === "SUCCESS").reduce((s, t) => s + (t.commissionGhs || 0), 0), currentCurrency)} commissions`,
                note: "Every commission posts to Finance as TELECOM_COMMISSION income automatically",
              },
              {
                label: "Airtime & data margin",
                value: money(airdataTxns.filter((t) => t.status === "SUCCESS").reduce((s, t) => s + (t.commissionGhs || 0), 0), currentCurrency),
                note: "Retail income minus wholesale cost (paid from float) per sale",
              },
              {
                label: "Wi-Fi vouchers",
                value: `${wifiUsers.length} sold · ${vouchersAvail.length} ready`,
                note: "Voucher sales post to Finance; expiry is automatic after the package duration",
              },
            ]}
          />
        </div>
      )}

      {/* ══════════════ CHECKLIST ══════════════ */}
      {tab === "CHECKLIST" && (
        <DailyChecklistPanel
          businessId={bizId}
          branchCode={bizCode}
          businessName={businessInfo?.name}
          employees={employees}
          currentUser={currentUser}
          accent="cyan"
          onChanged={() => { refresh(); onRefreshData?.(); }}
        />
      )}

      {showForm && (
        <TelecomForm
          type={showForm}
          ctx={formCtx}
          busy={busy}
          onClose={() => { setShowForm(null); setFormCtx(null); setError(""); }}
          onSubmit={submit}
          onPatch={patchEntity}
          lines={lines}
          packages={packages}
          currency={currentCurrency}
        />
      )}
    </div>
  );
}

// ─── Modal forms: line / MoMo txn / airtime-data sale / package / vouchers / float / expense ───
function TelecomForm({
  type, ctx, busy, onClose, onSubmit, onPatch, lines, packages, currency,
}: {
  type: Exclude<FormType, null>;
  ctx: any;
  busy: boolean;
  onClose: () => void;
  onSubmit: (t: FormType, d: any) => void;
  onPatch: (entity: string, id: number | string, d: any) => void;
  lines: any[];
  packages: any[];
  currency: CurrencyCode;
}) {
  const momoLines = lines.filter((l) => l.active && l.kind === "MOMO_AGENT");
  const walletLines = lines.filter((l) => l.active && (l.kind === "AIRTIME_WALLET" || l.kind === "DATA_WALLET"));
  const [f, setF] = useState<any>(() => ({
    type: type === "AIRDATA_TXN" ? "AIRTIME" : "MOMO_DEPOSIT",
    network: "MTN",
    kind: "MOMO_AGENT",
    status: "SUCCESS",
    paymentMethod: "CASH",
    target: "FLOAT",
    direction: "IN",
    lineId: ctx?.line?.id ?? (type === "AIRDATA_TXN" ? walletLines[0]?.id : momoLines[0]?.id) ?? "",
    packageId: ctx?.pkg?.id ?? packages.find((p) => p.active)?.id ?? "",
    count: 10,
  }));
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));

  const handle = (e: React.FormEvent) => {
    e.preventDefault();
    if (type === "FLOAT") {
      onPatch("LINE", ctx.line.id, { target: f.target, direction: f.direction, amountGhs: f.amountGhs });
      return;
    }
    if (type === "VOUCHER_SELL") {
      onSubmit(type, { ...f, voucherId: ctx?.voucher?.id });
      return;
    }
    if (type === "AIRDATA_TXN") {
      const margin = Math.round(((Number(f.amountGhs) || 0) - (Number(f.costGhs) || 0) + (Number(f.chargeGhs) || 0)) * 100) / 100;
      onSubmit(type, { ...f, commissionGhs: Math.max(0, margin) });
      return;
    }
    onSubmit(type, { ...f });
  };

  const I = ({ label, k, t = "text", ...rest }: any) => (
    <div>
      <label className="block text-[10px] text-slate-400 font-semibold mb-1">{label}</label>
      <input data-testid={`telf-${k}`} type={t} value={f[k] ?? ""} onChange={(e) => set(k, t === "number" ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value)} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs" {...rest} />
    </div>
  );
  const S = ({ label, k, opts, testid }: any) => (
    <div>
      <label className="block text-[10px] text-slate-400 font-semibold mb-1">{label}</label>
      <select data-testid={testid || `telf-${k}`} value={f[k] ?? ""} onChange={(e) => set(k, e.target.value)} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs">
        {opts.map((o: any) => <option key={o.v ?? o} value={o.v ?? o}>{o.l ?? o}</option>)}
      </select>
    </div>
  );

  const TITLES: Record<string, string> = {
    LINE: "New Agent Line",
    MOMO_TXN: "New MoMo Transaction",
    AIRDATA_TXN: "Sell Airtime / Data Bundle",
    PACKAGE: "New Wi-Fi Package",
    VOUCHER_BATCH: `Generate Vouchers — ${ctx?.pkg?.name || ""}`,
    VOUCHER_SELL: `Sell Voucher ${ctx?.voucher?.code || ""} (${ctx?.voucher?.packageName || ""})`,
    FLOAT: `Float / Cash Top-up — ${ctx?.line?.label || ""}`,
    EXPENSE: "Log Branch Expense",
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <form data-testid="telf-form" onClick={(e) => e.stopPropagation()} onSubmit={handle}
        className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 bg-slate-800/70">
          <h3 className="text-sm font-bold text-white">{TITLES[type]}</h3>
          <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white" data-testid="telf-close"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          {type === "LINE" && (
            <>
              <I label="Line name *" k="label" required placeholder="e.g. MTN MoMo Agent Till 2" />
              <div className="grid grid-cols-2 gap-3">
                <S label="Network" k="network" opts={["MTN", "TELECEL", "AT", "WIFI"]} />
                <S label="Line type" k="kind" opts={[{ v: "MOMO_AGENT", l: "MoMo Agent Till" }, { v: "AIRTIME_WALLET", l: "Airtime Wallet" }, { v: "DATA_WALLET", l: "Data Wallet" }, { v: "WIFI_HOTSPOT", l: "Wi-Fi Hotspot" }]} />
              </div>
              <I label="Agent number / SIM (MSISDN)" k="msisdn" placeholder="e.g. 0244 123 456" />
              <div className="grid grid-cols-2 gap-3">
                <I label="Opening float (GH₵)" k="floatGhs" t="number" min="0" step="0.01" />
                <I label="Opening cash (GH₵)" k="cashGhs" t="number" min="0" step="0.01" />
              </div>
            </>
          )}

          {(type === "MOMO_TXN" || type === "AIRDATA_TXN") && (
            <>
              <div className="grid grid-cols-2 gap-3">
                {type === "MOMO_TXN" ? (
                  <S label="MoMo type" k="type" testid="telf-type" opts={[{ v: "MOMO_DEPOSIT", l: "Deposit (cash in)" }, { v: "MOMO_WITHDRAWAL", l: "Withdrawal (cash out)" }, { v: "MOMO_TRANSFER", l: "Transfer / Send" }]} />
                ) : (
                  <S label="Product" k="type" testid="telf-type" opts={[{ v: "AIRTIME", l: "Airtime top-up" }, { v: "DATA", l: "Data bundle" }]} />
                )}
                <S label="Network" k="network" testid="telf-network" opts={["MTN", "TELECEL", "AT"]} />
              </div>
              <S label={type === "MOMO_TXN" ? "Agent line (till)" : "Wallet the cost is paid from"} k="lineId" testid="telf-line"
                opts={(type === "MOMO_TXN" ? momoLines : walletLines).map((l: any) => ({ v: l.id, l: `${l.label} — float ${formatMoney(l.floatGhs || 0, currency, true)} / cash ${formatMoney(l.cashGhs || 0, currency, true)}` }))} />
              <div className="grid grid-cols-2 gap-3">
                <I label="Customer name" k="customerName" placeholder="Walk-in customer" />
                <I label="Customer phone" k="customerPhone" placeholder="05…" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <I label={type === "MOMO_TXN" ? "Amount (GH₵) *" : "Face value (GH₵) *"} k="amountGhs" t="number" min="0.01" step="0.01" required />
                <I label="Service fee charged (GH₵)" k="chargeGhs" t="number" min="0" step="0.01" />
              </div>
              {type === "MOMO_TXN" ? (
                <div className="grid grid-cols-2 gap-3">
                  <I label="Commission earned (GH₵)" k="commissionGhs" t="number" min="0" step="0.01" />
                  <I label="Network reference" k="reference" placeholder="SMS txn id" />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <I label="Wholesale cost (GH₵) *" k="costGhs" t="number" min="0" step="0.01" required />
                  <I label="Network reference" k="reference" placeholder="SMS txn id" />
                </div>
              )}
              {type === "AIRDATA_TXN" && Number(f.amountGhs) > 0 && Number(f.costGhs) >= 0 && (
                <p className="text-[10px] text-emerald-300/90" data-testid="telf-margin-preview">
                  Margin on this sale: {formatMoney(Math.max(0, (Number(f.amountGhs) || 0) - (Number(f.costGhs) || 0) + (Number(f.chargeGhs) || 0)), currency, true)}
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <S label="Outcome" k="status" testid="telf-status" opts={[{ v: "SUCCESS", l: "Successful" }, { v: "FAILED", l: "Failed — record & follow up" }]} />
                <S label="Payment method" k="paymentMethod" testid="telf-paymethod" opts={PAYMENT_METHODS} />
              </div>
              {f.status === "FAILED" && (
                <I label="Failure reason *" k="failReason" required placeholder="e.g. Network timeout / wrong number / float rejected" />
              )}
              <I label="Notes" k="notes" placeholder="Optional" />
            </>
          )}

          {type === "PACKAGE" && (
            <>
              <I label="Package name *" k="name" required placeholder="e.g. 3-Day Unlimited" />
              <div className="grid grid-cols-3 gap-3">
                <I label="Validity (hours) *" k="durationHours" t="number" min="1" required />
                <I label="Data cap (MB)" k="dataCapMb" t="number" min="0" placeholder="blank = unlimited" />
                <I label="Price (GH₵) *" k="priceGhs" t="number" min="0.01" step="0.01" required />
              </div>
              <I label="Hotspot / router" k="routerLabel" placeholder="e.g. Wi-Fi Zone A" />
            </>
          )}

          {type === "VOUCHER_BATCH" && (
            <>
              <S label="Package" k="packageId" testid="telf-package" opts={packages.filter((p) => p.active).map((p: any) => ({ v: p.id, l: `${p.name} — ${formatMoney(p.priceGhs, currency, true)}` }))} />
              <I label="How many vouchers (1–100) *" k="count" t="number" min="1" max="100" required />
              <p className="text-[10px] text-slate-500">Each voucher gets a unique login code, a 6-digit access PIN and a scannable QR card. Expiry starts counting only when the voucher is sold &amp; activated.</p>
            </>
          )}

          {type === "VOUCHER_SELL" && (
            <>
              <I label="User name *" k="customerName" required placeholder="Who is buying access" />
              <div className="grid grid-cols-2 gap-3">
                <I label="User phone" k="customerPhone" placeholder="05…" />
                <S label="Payment method" k="paymentMethod" testid="telf-paymethod" opts={PAYMENT_METHODS} />
              </div>
              <p className="text-[10px] text-slate-500">Selling activates the voucher immediately — it stays valid for {ctx?.voucher ? `${ctx.voucher.packageName}` : "the package duration"}, then expires automatically. The sale posts to Finance and the sales ledger.</p>
            </>
          )}

          {type === "FLOAT" && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <S label="Target" k="target" testid="telf-target" opts={[{ v: "FLOAT", l: "Float (e-money)" }, { v: "CASH", l: "Cash (till)" }]} />
                <S label="Direction" k="direction" testid="telf-direction" opts={[{ v: "IN", l: "Top up (add)" }, { v: "OUT", l: "Draw down (remove)" }]} />
                <I label="Amount (GH₵) *" k="amountGhs" t="number" min="0.01" step="0.01" required />
              </div>
              <p className="text-[10px] text-slate-500">Current: float {formatMoney(ctx?.line?.floatGhs || 0, currency, true)} / cash {formatMoney(ctx?.line?.cashGhs || 0, currency, true)}. Top-ups &amp; drawdowns are tracked per line and logged — they never distort profit.</p>
            </>
          )}

          {type === "EXPENSE" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <I label="Category *" k="category" required placeholder="Float purchase, Router data, Rent, Power…" />
                <I label="Amount (GH₵) *" k="amountGhs" t="number" min="0.01" step="0.01" required />
              </div>
              <I label="Description" k="description" placeholder="Optional detail" />
              <S label="Payment method" k="paymentMethod" testid="telf-paymethod" opts={PAYMENT_METHODS} />
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-slate-800 bg-slate-800/50">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold">Cancel</button>
          <button type="submit" disabled={busy} data-testid="telf-submit" className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-bold flex items-center gap-1">
            {busy && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}{type === "VOUCHER_BATCH" ? "Generate" : type === "VOUCHER_SELL" ? "Sell & Activate" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
