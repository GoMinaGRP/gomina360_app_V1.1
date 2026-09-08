"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import AiSectionGuide from "./AiSectionGuide";
import {
  Droplets, Car, CalendarClock, Sparkles, Wallet, Activity, Boxes,
  Users, FileText, LayoutDashboard, ClipboardList, UserCog, X, Plus,
  CheckCircle2, AlertTriangle, TrendingUp, Wrench, ClipboardCheck,
  Gauge, CircleDollarSign, BarChart3, RefreshCw,
} from "lucide-react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis,
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

type Tab = "DASHBOARD" | "SERVICES" | "BOOKINGS" | "WASHES" | "STOCK" | "STAFF" | "REPORTS" | "CHECKLIST";
type FormType = null | "WASH" | "BOOKING" | "SERVICE" | "EXPENSE";

const TABS: { key: Tab; label: string; icon: any }[] = [
  { key: "DASHBOARD", label: "Dashboard", icon: LayoutDashboard },
  { key: "SERVICES", label: "Services & Pricing", icon: Sparkles },
  { key: "BOOKINGS", label: "Bookings", icon: CalendarClock },
  { key: "WASHES", label: "Active Washes", icon: Car },
  { key: "STOCK", label: "Stock & Supplies", icon: Boxes },
  { key: "STAFF", label: "Staff", icon: UserCog },
  { key: "REPORTS", label: "Finance & Reports", icon: BarChart3 },
  { key: "CHECKLIST", label: "Daily Checklist", icon: ClipboardList },
];

const STATUS_STYLE: Record<string, string> = {
  IN_PROGRESS: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  COMPLETED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  CANCELLED: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  BOOKED: "bg-indigo-500/15 text-indigo-300 border-indigo-500/40",
  CHECKED_IN: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  ACTIVE: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  INACTIVE: "bg-slate-600/30 text-slate-400 border-slate-500/40",
  IN_STOCK: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  LOW_STOCK: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  OUT_OF_STOCK: "bg-rose-500/15 text-rose-300 border-rose-500/40",
};
const Badge = ({ s }: { s: string }) => (
  <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${STATUS_STYLE[s] || "bg-slate-700/40 text-slate-300 border-slate-600"}`}>{s}</span>
);

export const SERVICE_CATEGORIES: { v: string; l: string }[] = [
  { v: "WASH_PACKAGE", l: "Wash Package" },
  { v: "DETAILING", l: "Detailing" },
  { v: "WAXING", l: "Waxing" },
  { v: "POLISHING", l: "Polishing" },
  { v: "INTERIOR_CLEANING", l: "Interior Cleaning" },
  { v: "EXTERIOR_CLEANING", l: "Exterior Cleaning" },
  { v: "CUSTOM", l: "Custom Service" },
];

function litersPerUnit(name?: string | null): number {
  const m = /\((\d+(?:\.\d+)?)\s*L\)/i.exec(name || "");
  return m ? Number(m[1]) : 50;
}

export default function CarWashModule({
  currentUser, businessInfo, businessMetrics, inventory, customers,
  transactions, assets, employees, currentCurrency, onRefreshData,
}: Props) {
  const bizId = businessInfo?.id;
  const bizCode = businessInfo?.code || "WASH-01";
  const today = new Date().toISOString().split("T")[0];

  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("DASHBOARD");
  const [services, setServices] = useState<any[]>([]);
  const [bookings, setBookings] = useState<any[]>([]);
  const [washes, setWashes] = useState<any[]>([]);
  const [activities, setActivities] = useState<any[]>([]);
  const [showForm, setShowForm] = useState<FormType>(null);
  const [editService, setEditService] = useState<any>(null);
  const [payChoice, setPayChoice] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!bizId) return;
    try {
      const res = await fetch(`/api/carwash?businessId=${bizId}`);
      const d = await res.json();
      if (d.success) {
        setServices(d.services || []);
        setBookings(d.bookings || []);
        setWashes(d.washes || []);
        setActivities(d.activities || []);
      }
    } finally {
      setLoading(false);
    }
  }, [bizId]);

  useEffect(() => { refresh(); }, [refresh]);

  // ── Branch-scoped shared enterprise data ──────────────────────────────
  const branchInventory = useMemo(() => inventory.filter((i) => i.businessId === bizId), [inventory, bizId]);
  const branchEmployees = useMemo(() => employees.filter((e) => e.businessId === bizId), [employees, bizId]);
  const branchCustomers = useMemo(() => customers.filter((c) => c.businessId === bizId), [customers, bizId]);
  const branchTx = useMemo(() => transactions.filter((t) => t.businessId === bizId), [transactions, bizId]);

  const income = useMemo(() => branchTx.filter((t) => t.type === "INCOME"), [branchTx]);
  const expenses = useMemo(() => branchTx.filter((t) => t.type === "EXPENSE"), [branchTx]);
  const revenue = income.reduce((s, t) => s + (t.amountGhs || 0), 0);
  const expenseTotal = expenses.reduce((s, t) => s + (t.amountGhs || 0), 0);
  const profit = revenue - expenseTotal;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  const todayIncome = income.filter((t) => t.date === today);
  const todayExpenses = expenses.filter((t) => t.date === today);
  const dailySales = todayIncome.reduce((s, t) => s + (t.amountGhs || 0), 0);
  const dailyExpenseTotal = todayExpenses.reduce((s, t) => s + (t.amountGhs || 0), 0);
  const dailyProfit = dailySales - dailyExpenseTotal;

  const completedWashes = useMemo(() => washes.filter((w) => w.status === "COMPLETED"), [washes]);
  const activeWashes = useMemo(() => washes.filter((w) => w.status === "IN_PROGRESS"), [washes]);
  const todayWashes = completedWashes.filter((w) => w.doneAt === today);
  const todayVehicles = todayWashes.length;
  const upcomingBookings = bookings.filter((b) => b.status === "BOOKED");
  const todayBookings = bookings.filter((b) => b.bookingDate === today && b.status !== "CANCELLED");
  const activeServices = services.filter((s) => s.active);

  // Payment mix (from income transactions)
  const paymentMix = useMemo(() => {
    const m: Record<string, { count: number; total: number }> = {};
    income.forEach((t) => {
      const k = t.paymentMethod || "OTHER";
      if (!m[k]) m[k] = { count: 0, total: 0 };
      m[k].count++;
      m[k].total += t.amountGhs || 0;
    });
    return Object.entries(m).map(([method, v]) => ({ method, ...v })).sort((a, b) => b.total - a.total);
  }, [income]);
  const cashTotal = paymentMix.filter((p) => p.method === "CASH").reduce((s, p) => s + p.total, 0);
  const momoTotal = paymentMix.filter((p) => p.method.includes("MOMO")).reduce((s, p) => s + p.total, 0);
  const cardTotal = paymentMix.filter((p) => p.method.includes("CARD") || p.method.includes("POS")).reduce((s, p) => s + p.total, 0);

  // 7-day revenue / expense trend
  const trend = useMemo(() => {
    const days: { date: string; label: string; revenue: number; expenses: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400e3);
      const key = d.toISOString().split("T")[0];
      days.push({
        date: key,
        label: d.toLocaleDateString("en-GB", { weekday: "short" }),
        revenue: income.filter((t) => t.date === key).reduce((s, t) => s + (t.amountGhs || 0), 0),
        expenses: expenses.filter((t) => t.date === key).reduce((s, t) => s + (t.amountGhs || 0), 0),
      });
    }
    return days;
  }, [income, expenses]);

  // Service performance
  const serviceStats = useMemo(() => {
    const m: Record<string, { count: number; revenue: number }> = {};
    completedWashes.forEach((w) => {
      const k = w.serviceName || "Other";
      if (!m[k]) m[k] = { count: 0, revenue: 0 };
      m[k].count++;
      m[k].revenue += w.priceGhs || 0;
    });
    return Object.entries(m).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.revenue - a.revenue);
  }, [completedWashes]);

  // Staff performance
  const staffStats = useMemo(() => {
    const m: Record<string, { count: number; revenue: number }> = {};
    completedWashes.forEach((w) => {
      const k = w.staffName || "Unassigned";
      if (!m[k]) m[k] = { count: 0, revenue: 0 };
      m[k].count++;
      m[k].revenue += w.priceGhs || 0;
    });
    return m;
  }, [completedWashes]);

  // Alerts
  const alerts = useMemo(() => {
    const list: { color: string; text: string }[] = [];
    branchInventory.filter((i) => i.status !== "IN_STOCK").forEach((i) =>
      list.push({ color: i.status === "OUT_OF_STOCK" ? "rose" : "amber", text: `${i.name} is ${i.status.replace("_", " ")} (${i.quantity} ${i.unit || ""} left ≤ min ${i.minStockThreshold})` })
    );
    bookings.filter((b) => b.status === "BOOKED" && b.bookingDate < today).forEach((b) =>
      list.push({ color: "amber", text: `Booking ${b.bookingNumber} overdue (${b.customerName}, was ${b.bookingDate})` })
    );
    washes.filter((w) => w.status === "IN_PROGRESS" && w.startedAt < today).forEach((w) =>
      list.push({ color: "amber", text: `Wash ${w.washNumber} still in progress since ${w.startedAt} — check the bay` })
    );
    return list;
  }, [branchInventory, bookings, washes, today]);

  const topCustomers = useMemo(
    () => [...branchCustomers].sort((a, b) => (b.totalSpentGhs || 0) - (a.totalSpentGhs || 0)).slice(0, 8),
    [branchCustomers]
  );

  const submit = async (type: FormType, data: any) => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/carwash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity: type,
          data: {
            ...data,
            businessId: bizId,
            createdByName: currentUser?.name,
            createdByRole: currentUser?.role,
            createdByUserId: currentUser?.id,
          },
        }),
      });
      const d = await res.json();
      if (!d.success) {
        setError(d.error || "Save failed");
        return;
      }
      setShowForm(null);
      setEditService(null);
      await refresh();
      onRefreshData();
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
      const res = await fetch("/api/carwash", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity,
          id,
          data: { ...data, actorName: currentUser?.name, actorRole: currentUser?.role, actorUserId: currentUser?.id },
        }),
      });
      const d = await res.json();
      if (!d.success) setError(d.error || "Update failed");
      await refresh();
      onRefreshData();
    } catch (e: any) {
      setError(e.message || "Network error");
    } finally {
      setBusy(false);
    }
  };

  const startWashFromBooking = (bookingId: number) =>
    submit("WASH", { businessId: bizId, bookingId });

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
            <tr key={i} className="hover:bg-slate-700/40">{r.map((c, j) => <td key={j} className="px-4 py-3 text-slate-300">{c}</td>)}</tr>
          )) : <tr><td colSpan={headers.length} className="px-4 py-8 text-center text-slate-400">No records</td></tr>}
        </tbody>
      </table>
    </div>
  );

  const PIE_COLORS = ["#22d3ee", "#34d399", "#fbbf24", "#f472b6", "#818cf8", "#fb923c", "#e879f9", "#94a3b8"];

  if (loading) {
    return <div className="p-10 text-center text-slate-400 text-sm">Loading Auto Car Wash workspace…</div>;
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto text-slate-100" data-testid="carwash-module">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-sky-950/40 to-slate-900 p-6 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-slate-800 border border-cyan-500/40 flex items-center justify-center shadow-lg shrink-0">
            <Droplets className="w-7 h-7 text-cyan-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 text-xs font-bold border border-cyan-500/30">AUTO CAR WASH &amp; DETAILING</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 text-white">{businessInfo?.name || "Auto Car Wash"}</h2>
            <p className="text-xs text-slate-400 mt-1">{bizCode} • {businessInfo?.branchLocation || "Ghana"} • Manager: <strong className="text-cyan-300">{businessInfo?.managerName || "Wash Supervisor"}</strong></p>
          </div>
        </div>
        {error && <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/40 rounded-lg px-3 py-2" data-testid="cw-error">{error}<button className="ml-2 text-rose-200" onClick={() => setError("")}>✕</button></div>}
        <div className="flex flex-wrap gap-2">
          <button data-testid="cw-open-wash" onClick={() => setShowForm("WASH")} className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center gap-1"><Car className="w-3.5 h-3.5" />New Wash</button>
          <button data-testid="cw-open-booking" onClick={() => setShowForm("BOOKING")} className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><CalendarClock className="w-3.5 h-3.5" />Booking</button>
          <button data-testid="cw-open-service" onClick={() => { setEditService(null); setShowForm("SERVICE"); }} className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1"><Sparkles className="w-3.5 h-3.5" />Service</button>
          <button data-testid="cw-open-expense" onClick={() => setShowForm("EXPENSE")} className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold flex items-center gap-1"><Wallet className="w-3.5 h-3.5" />Expense</button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex flex-wrap gap-1 bg-slate-800/60 border border-slate-700 rounded-xl p-1">
        {TABS.map((t) => (
          <button key={t.key} data-testid={`cw-tab-${t.key}`} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition ${tab === t.key ? "bg-cyan-600 text-white" : "text-slate-400 hover:text-white"}`}>
            <t.icon className="w-3.5 h-3.5" />{t.label}
          </button>
        ))}
        <AiSectionGuide moduleKey="WASH" section={tab} businessInfo={businessInfo} />
      </div>

      {alerts.length > 0 && tab === "DASHBOARD" && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-1" data-testid="cw-alerts">
          {alerts.slice(0, 6).map((a, i) => (
            <div key={i} className={`flex items-center gap-2 text-xs ${a.color === "rose" ? "text-rose-200" : "text-amber-200"}`}><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{a.text}</div>
          ))}
        </div>
      )}

      {/* ══════════════ DASHBOARD ══════════════ */}
      {tab === "DASHBOARD" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat testid="cw-stat-daily-sales" label="Daily Sales" value={formatMoney(dailySales, currentCurrency, true)} sub={`${todayIncome.length} receipts today`} color="emerald" icon={TrendingUp} />
            <Stat testid="cw-stat-vehicles" label="Vehicles Today" value={todayVehicles} sub={`${completedWashes.length} all time`} color="cyan" icon={Car} />
            <Stat testid="cw-stat-active" label="Active Washes" value={activeWashes.length} sub="in the bays now" color="blue" icon={Gauge} />
            <Stat testid="cw-stat-bookings" label="Bookings" value={todayBookings.length} sub={`${upcomingBookings.length} upcoming total`} color="purple" icon={CalendarClock} />
            <Stat testid="cw-stat-profit-today" label="Profit Today" value={formatMoney(dailyProfit, currentCurrency, true)} sub={`spent ${formatMoney(dailyExpenseTotal, currentCurrency, true)}`} color={dailyProfit >= 0 ? "amber" : "rose"} icon={Activity} />
            <Stat testid="cw-stat-customers" label="Customers" value={branchCustomers.length} sub={`${new Set(completedWashes.map((w) => w.vehicleLabel)).size} vehicles served`} color="orange" icon={Users} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card title="Cash & Payment Summary" icon={Wallet} testid="cw-card-payments">
              <div className="p-4 space-y-3">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="p-2 rounded-lg bg-slate-900/70 border border-slate-700"><div className="text-[10px] uppercase text-slate-500 font-bold">Cash</div><div className="text-sm font-black text-emerald-300">{formatMoney(cashTotal, currentCurrency, true)}</div></div>
                  <div className="p-2 rounded-lg bg-slate-900/70 border border-slate-700"><div className="text-[10px] uppercase text-slate-500 font-bold">MoMo</div><div className="text-sm font-black text-amber-300">{formatMoney(momoTotal, currentCurrency, true)}</div></div>
                  <div className="p-2 rounded-lg bg-slate-900/70 border border-slate-700"><div className="text-[10px] uppercase text-slate-500 font-bold">Card/POS</div><div className="text-sm font-black text-sky-300">{formatMoney(cardTotal, currentCurrency, true)}</div></div>
                </div>
                {paymentMix.length ? (
                  <ResponsiveContainer width="100%" height={150}>
                    <PieChart>
                      <Pie data={paymentMix} dataKey="total" nameKey="method" innerRadius={32} outerRadius={55} paddingAngle={2}>
                        {paymentMix.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={(v: any) => formatMoney(Number(v), currentCurrency)} contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : <p className="text-[11px] text-slate-500 text-center py-6">Payments mix appears here as soon as the first job is charged.</p>}
              </div>
            </Card>

            <Card title="This Week — Sales vs Expenses" icon={BarChart3} testid="cw-card-trend">
              <div className="p-3">
                <ResponsiveContainer width="100%" height={210}>
                  <AreaChart data={trend} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                    <defs>
                      <linearGradient id="cwRev" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22d3ee" stopOpacity={0.5} /><stop offset="100%" stopColor="#22d3ee" stopOpacity={0} /></linearGradient>
                      <linearGradient id="cwExp" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#fb7185" stopOpacity={0.4} /><stop offset="100%" stopColor="#fb7185" stopOpacity={0} /></linearGradient>
                    </defs>
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                    <Tooltip formatter={(v: any) => formatMoney(Number(v), currentCurrency)} contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }} />
                    <Area type="monotone" dataKey="revenue" stroke="#22d3ee" fill="url(#cwRev)" strokeWidth={2} name="Sales" />
                    <Area type="monotone" dataKey="expenses" stroke="#fb7185" fill="url(#cwExp)" strokeWidth={2} name="Expenses" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card title="Recent Activity" icon={Activity} testid="cw-card-activity">
              <div className="p-3 space-y-1.5 max-h-[240px] overflow-y-auto">
                {activities.length ? activities.slice(0, 12).map((a) => (
                  <div key={a.id} className="text-[11px] p-2 rounded-lg bg-slate-900/70 border border-slate-700/70">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-cyan-300">{a.action.replaceAll("_", " ")}</span>
                      <span className="text-[9px] text-slate-500 whitespace-nowrap">{a.recordedAt ? new Date(a.recordedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}</span>
                    </div>
                    <p className="text-slate-400 mt-0.5">{a.detail}</p>
                    {a.actorName && <p className="text-[9px] text-slate-600 mt-0.5">by {a.actorName}{a.actorRole ? ` (${a.actorRole})` : ""}</p>}
                  </div>
                )) : <p className="text-[11px] text-slate-500 text-center py-6">Every booking, wash, service change and expense lands here automatically.</p>}
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card title="Wash Queue — In Progress" icon={Gauge} testid="cw-dash-queue"
              action={<span className="text-[10px] text-slate-500">{activeWashes.length} in bay{activeWashes.length === 1 ? "" : "s"}</span>}>
              <div className="p-3 space-y-2">
                {activeWashes.length ? activeWashes.slice(0, 5).map((w) => (
                  <div key={w.id} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-900/70 border border-slate-700">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-slate-100 truncate">{w.vehicleLabel}</p>
                      <p className="text-[10px] text-slate-500 truncate">{w.serviceName} • {w.customerName}{w.staffName ? ` • ${w.staffName}` : ""}</p>
                    </div>
                    <span className="text-[10px] font-bold text-cyan-300 whitespace-nowrap">{formatMoney(w.priceGhs, currentCurrency, true)}</span>
                  </div>
                )) : <p className="text-[11px] text-slate-500 text-center py-4">Bays are free — start a wash or check in a booking.</p>}
                {activeWashes.length > 0 && <button data-testid="cw-goto-queue" onClick={() => setTab("WASHES")} className="w-full mt-1 py-1.5 rounded-lg bg-cyan-600/20 border border-cyan-500/40 text-cyan-300 text-[11px] font-bold hover:bg-cyan-600/30">Manage the queue →</button>}
              </div>
            </Card>

            <Card title="Upcoming Bookings" icon={CalendarClock} testid="cw-dash-bookings"
              action={<button onClick={() => setShowForm("BOOKING")} className="text-[10px] font-bold text-indigo-300 hover:text-indigo-200">+ New</button>}>
              <div className="p-3 space-y-2">
                {upcomingBookings.length ? upcomingBookings.slice(0, 5).map((b) => (
                  <div key={b.id} className="p-2 rounded-lg bg-slate-900/70 border border-slate-700">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-bold text-slate-100 truncate">{b.customerName}</p>
                      <span className="text-[10px] font-bold text-indigo-300 whitespace-nowrap">{b.bookingDate}{b.timeSlot ? ` ${b.timeSlot}` : ""}</span>
                    </div>
                    <p className="text-[10px] text-slate-500 truncate">{b.serviceName}{b.vehicleLabel ? ` • ${b.vehicleLabel}` : ""}</p>
                  </div>
                )) : <p className="text-[11px] text-slate-500 text-center py-4">No bookings yet — take one over the phone and log it here.</p>}
              </div>
            </Card>

            <Card title="Top Services" icon={Sparkles} testid="cw-dash-services">
              <div className="p-3 space-y-2">
                {serviceStats.length ? serviceStats.slice(0, 5).map((s) => (
                  <div key={s.name} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-900/70 border border-slate-700">
                    <div className="min-w-0"><p className="text-xs font-bold text-slate-100 truncate">{s.name}</p><p className="text-[10px] text-slate-500">{s.count} job{s.count === 1 ? "" : "s"} done</p></div>
                    <span className="text-[11px] font-bold text-emerald-300 whitespace-nowrap">{formatMoney(s.revenue, currentCurrency, true)}</span>
                  </div>
                )) : <p className="text-[11px] text-slate-500 text-center py-4">Service performance builds up as jobs complete.</p>}
              </div>
            </Card>
          </div>

          <Card title="Low Stock / Supply Alerts" icon={AlertTriangle} testid="cw-dash-lowstock">
            <div className="p-4 space-y-1.5">
              {branchInventory.filter((i) => i.status !== "IN_STOCK").length ? branchInventory.filter((i) => i.status !== "IN_STOCK").map((i) => (
                <div key={i.id} className={`flex items-center gap-2 text-xs ${i.status === "OUT_OF_STOCK" ? "text-rose-300" : "text-amber-200"}`}>
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />{i.name} — {i.status.replace("_", " ")} ({i.quantity} {i.unit || ""} left, reorder level {i.minStockThreshold})
                </div>
              )) : <p className="text-[11px] text-slate-500">All supplies are above their reorder levels.</p>}
            </div>
          </Card>
        </div>
      )}

      {/* ══════════════ SERVICES & PRICING ══════════════ */}
      {tab === "SERVICES" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Services on Menu" value={services.length} sub={`${activeServices.length} bookable`} color="cyan" icon={Sparkles} />
            <Stat label="From Price" value={services.length ? formatMoney(Math.min(...services.map((s) => s.priceGhs)), currentCurrency, true) : "—"} sub="cheapest offer" color="emerald" icon={CircleDollarSign} />
            <Stat label="Premium Service" value={services.length ? formatMoney(Math.max(...services.map((s) => s.priceGhs)), currentCurrency, true) : "—"} sub="top offer" color="purple" icon={TrendingUp} />
            <Stat label="Jobs Completed" value={completedWashes.length} sub={`${formatMoney(serviceStats.reduce((s, x) => s + x.revenue, 0), currentCurrency, true)} earned`} color="amber" icon={CheckCircle2} />
          </div>
          <Card title="Service Menu — Wash Packages, Detailing, Waxing, Polishing & Custom" icon={Sparkles} testid="cw-services-card"
            action={<button data-testid="cw-new-service" onClick={() => { setEditService(null); setShowForm("SERVICE"); }} className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />New Service</button>}>
            <DataTable headers={["Service", "Category", "Includes (items in the offer)", "Duration", "Price", "Chemical Use", "Jobs", "Status", ""]}
              rows={services.map((s) => {
                const supply = s.supplyInventoryId ? branchInventory.find((i) => i.id === s.supplyInventoryId) : null;
                const perf = serviceStats.find((x) => x.name === s.name);
                return [
                  <span key="n" className="font-semibold text-slate-100">{s.name}{s.description ? <span className="block text-[10px] text-slate-500 font-normal">{s.description}</span> : null}</span>,
                  <Badge key="c" s={s.category} />,
                  <span key="i" className="text-[11px] text-slate-400">{s.includesItems || "—"}</span>,
                  `${s.durationMinutes || 45} min`,
                  <span key="p" className="font-bold text-cyan-300">{formatMoney(s.priceGhs, currentCurrency, true)}</span>,
                  supply ? <span key="s" className="text-[11px] text-slate-400">{s.supplyUsageLiters}L • {supply.name}</span> : <span key="s" className="text-[11px] text-slate-600">—</span>,
                  <span key="j">{perf ? `${perf.count} (${formatMoney(perf.revenue, currentCurrency, true)})` : "0"}</span>,
                  <Badge key="a" s={s.active ? "ACTIVE" : "INACTIVE"} />,
                  <span key="x" className="flex items-center gap-1.5 justify-end">
                    <button data-testid={`cw-svc-edit-${s.id}`} onClick={() => { setEditService(s); setShowForm("SERVICE"); }} className="px-2 py-1 rounded bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-[10px] font-bold hover:bg-cyan-500/30">Edit</button>
                    <button data-testid={`cw-svc-toggle-${s.id}`} onClick={() => patchEntity("SERVICE", s.id, { active: !s.active })} className="px-2 py-1 rounded bg-slate-600/30 border border-slate-500/40 text-slate-300 text-[10px] font-bold hover:bg-slate-600/50">{s.active ? "Deactivate" : "Activate"}</button>
                  </span>,
                ];
              })} />
            <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Each service carries its own price, duration, the items included in the offer, and the exact chemical quantity drawn from stock when a job completes — so sales and inventory stay in lock-step.</p>
          </Card>
        </div>
      )}

      {/* ══════════════ BOOKINGS ══════════════ */}
      {tab === "BOOKINGS" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Upcoming" value={upcomingBookings.length} sub="awaiting check-in" color="purple" icon={CalendarClock} />
            <Stat label="Checked In" value={bookings.filter((b) => b.status === "CHECKED_IN").length} sub="in the wash queue" color="cyan" icon={Gauge} />
            <Stat label="Fulfilled" value={bookings.filter((b) => b.status === "COMPLETED").length} sub="jobs done" color="emerald" icon={CheckCircle2} />
            <Stat label="Cancelled" value={bookings.filter((b) => b.status === "CANCELLED").length} sub="no-shows / void" color="rose" icon={AlertTriangle} />
          </div>
          <Card title="Bookings" icon={CalendarClock} testid="cw-bookings-card"
            action={<button data-testid="cw-new-booking" onClick={() => setShowForm("BOOKING")} className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />New Booking</button>}>
            <DataTable headers={["Booking #", "Customer", "Vehicle", "Service", "Date & Slot", "Staff", "Price", "Status", ""]}
              rows={bookings.map((b) => [
                <span key="n" className="font-mono text-[11px]">{b.bookingNumber}</span>,
                <span key="c">{b.customerName}{b.customerPhone ? <span className="block text-[10px] text-slate-500">{b.customerPhone}</span> : null}</span>,
                b.vehicleLabel || "—",
                b.serviceName,
                `${b.bookingDate}${b.timeSlot ? ` ${b.timeSlot}` : ""}`,
                b.assignedStaffName || "—",
                <span key="p" className="font-bold text-indigo-300">{formatMoney(b.priceGhs, currentCurrency, true)}</span>,
                <Badge key="s" s={b.status} />,
                <span key="a" className="flex items-center gap-1.5 justify-end">
                  {b.status === "BOOKED" && (
                    <button data-testid={`cw-booking-checkin-${b.id}`} onClick={() => startWashFromBooking(b.id)} className="px-2 py-1 rounded bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-[10px] font-bold hover:bg-cyan-500/30">Check In → Wash</button>
                  )}
                  {(b.status === "BOOKED" || b.status === "CHECKED_IN") && (
                    <button data-testid={`cw-booking-cancel-${b.id}`} onClick={() => patchEntity("BOOKING", b.id, { status: "CANCELLED" })} className="px-2 py-1 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 text-[10px] font-bold hover:bg-rose-500/25">Cancel</button>
                  )}
                  {b.status === "COMPLETED" && <span key="k" className="text-[10px] text-emerald-400 font-bold">Done {b.completedAt || ""}</span>}
                </span>,
              ])} />
            <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Checking a booking in moves it straight into the Active Washes queue; when the job completes, the customer, payment, stock and reports all update automatically.</p>
          </Card>
        </div>
      )}

      {/* ══════════════ ACTIVE WASHES ══════════════ */}
      {tab === "WASHES" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="In Progress" value={activeWashes.length} sub="in the bays now" color="blue" icon={Gauge} />
            <Stat testid="cw-stat-completed-today" label="Completed Today" value={todayWashes.length} sub={`${formatMoney(todayWashes.reduce((s, w) => s + (w.priceGhs || 0), 0), currentCurrency, true)} today`} color="emerald" icon={CheckCircle2} />
            <Stat label="All Time Jobs" value={completedWashes.length} sub="completed washes" color="cyan" icon={Car} />
            <Stat label="Avg Ticket" value={completedWashes.length ? formatMoney(completedWashes.reduce((s, w) => s + (w.priceGhs || 0), 0) / completedWashes.length, currentCurrency, true) : "—"} sub="per completed job" color="amber" icon={CircleDollarSign} />
          </div>

          <Card title="Active Washes" icon={Car} testid="cw-queue-card"
            action={<button data-testid="cw-new-wash" onClick={() => setShowForm("WASH")} className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />Start Wash</button>}>
            <DataTable headers={["Wash #", "Customer", "Vehicle", "Service", "Staff", "Started", "Price", "Payment", ""]}
              rows={activeWashes.map((w) => [
                <span key="n" className="font-mono text-[11px]">{w.washNumber}</span>,
                <span key="c">{w.customerName}{w.customerPhone ? <span className="block text-[10px] text-slate-500">{w.customerPhone}</span> : null}</span>,
                w.vehicleLabel,
                w.serviceName,
                w.staffName || "—",
                w.startedAt,
                <span key="p" className="font-bold text-cyan-300">{formatMoney(w.priceGhs, currentCurrency, true)}</span>,
                <select key="pay" data-testid={`cw-wash-pay-${w.id}`} value={payChoice[w.id] || "CASH"} onChange={(e) => setPayChoice((m) => ({ ...m, [w.id]: e.target.value }))} className="px-2 py-1 bg-slate-800 border border-slate-700 rounded text-[10px] text-slate-200">
                  {["CASH", "MTN_MOMO", "TELECEL_CASH", "POS_CARD", "BANK_TRANSFER"].map((m) => <option key={m} value={m}>{m.replaceAll("_", " ")}</option>)}
                </select>,
                <span key="a" className="flex items-center gap-1.5 justify-end">
                  <button data-testid={`cw-wash-done-${w.id}`} onClick={() => patchEntity("WASH", w.id, { status: "COMPLETED", paymentMethod: payChoice[w.id] || "CASH" })} className="px-2 py-1 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[10px] font-bold hover:bg-emerald-500/30">✓ Complete & Charge</button>
                  <button data-testid={`cw-wash-cancel-${w.id}`} onClick={() => patchEntity("WASH", w.id, { status: "CANCELLED" })} className="px-2 py-1 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 text-[10px] font-bold hover:bg-rose-500/25">Void</button>
                </span>,
              ])} />
            <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Completing a job charges the customer (books the payment under the chosen method), draws the service's chemicals from stock, credits the vehicle's owner in Customers, and closes any linked booking — all in one step.</p>
          </Card>

          <Card title="Wash History" icon={FileText} testid="cw-history-card">
            <DataTable headers={["Wash #", "Customer", "Vehicle", "Service", "Staff", "Started", "Done", "Price", "Status"]}
              rows={washes.filter((w) => w.status !== "IN_PROGRESS").map((w) => [
                <span key="n" className="font-mono text-[11px]">{w.washNumber}</span>,
                w.customerName,
                w.vehicleLabel,
                w.serviceName,
                w.staffName || "—",
                w.startedAt,
                w.doneAt || "—",
                <span key="p" className="font-bold text-emerald-300">{formatMoney(w.priceGhs, currentCurrency, true)}</span>,
                <Badge key="s" s={w.status} />,
              ])} />
          </Card>
        </div>
      )}

      {/* ══════════════ STOCK & SUPPLIES ══════════════ */}
      {tab === "STOCK" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Stock Items" value={branchInventory.length} sub="branch supplies" color="blue" icon={Boxes} />
            <Stat label="Linked to Services" value={new Set(services.map((s) => s.supplyInventoryId).filter(Boolean)).size} sub="auto-consumed items" color="cyan" icon={Sparkles} />
            <Stat label="Low Stock" value={branchInventory.filter((i) => i.status === "LOW_STOCK").length} sub="at reorder level" color="amber" icon={AlertTriangle} />
            <Stat label="Out of Stock" value={branchInventory.filter((i) => i.status === "OUT_OF_STOCK").length} sub="must reorder now" color="rose" icon={AlertTriangle} />
          </div>
          <Card title="Stock & Consumables" icon={Boxes} testid="cw-stock-card">
            <DataTable headers={["Item", "SKU", "In Stock", "≈ Usable Volume", "Cost", "Sell", "Used By Services", "Status"]}
              rows={branchInventory.map((i) => {
                const users = services.filter((s) => s.supplyInventoryId === i.id);
                const lpu = litersPerUnit(i.name);
                return [
                  <span key="n" className="font-semibold text-slate-100">{i.name}</span>,
                  <span key="sk" className="font-mono text-[11px]">{i.sku}</span>,
                  `${i.quantity} ${i.unit || ""}`.trim(),
                  /\(\d+L\)/i.test(i.name || "") ? <span key="v" className="text-cyan-300 font-bold">≈ {Math.round(i.quantity * lpu)}L</span> : "—",
                  formatMoney(i.costPriceGhs, currentCurrency, true),
                  formatMoney(i.sellingPriceGhs, currentCurrency, true),
                  users.length ? <span key="u" className="text-[11px] text-slate-400">{users.map((u) => `${u.name} (${u.supplyUsageLiters}L)`).join(", ")}</span> : <span key="u" className="text-[11px] text-slate-600">—</span>,
                  <Badge key="s" s={i.status || "IN_STOCK"} />,
                ];
              })} />
            <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">When a wash completes, its service automatically draws the configured liters from the linked item — the listing above shows exactly which services consume which supply.</p>
          </Card>
        </div>
      )}

      {/* ══════════════ STAFF ══════════════ */}
      {tab === "STAFF" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Branch Staff" value={branchEmployees.length} sub={`${branchEmployees.filter((e) => e.status === "ACTIVE").length} active`} color="cyan" icon={UserCog} />
            <Stat label="With Jobs Done" value={Object.keys(staffStats).filter((k) => k !== "Unassigned").length} sub="on the board" color="emerald" icon={CheckCircle2} />
            <Stat label="Busiest Hands" value={(() => { const t = Object.entries(staffStats).filter(([k]) => k !== "Unassigned").sort((a, b) => b[1].count - a[1].count)[0]; return t ? t[0] : "—"; })()} sub="most completed jobs" color="amber" icon={Sparkles} />
            <Stat label="Access Managed By" value="Owner" sub="user accounts & roles" color="purple" icon={Users} />
          </div>
          <Card title="Staff & Performance" icon={UserCog} testid="cw-staff-card">
            <DataTable headers={["Name", "Role", "Phone", "Salary", "Jobs Done", "Revenue Handled", "Status"]}
              rows={branchEmployees.map((e) => {
                const s = staffStats[e.name];
                return [
                  <span key="n" className="font-semibold text-slate-100">{e.name}</span>,
                  e.role,
                  e.phone || "—",
                  formatMoney(e.salaryGhs, currentCurrency, true),
                  s ? s.count : 0,
                  <span key="r" className="font-bold text-emerald-300">{formatMoney(s?.revenue || 0, currentCurrency, true)}</span>,
                  <Badge key="s" s={e.status || "ACTIVE"} />,
                ];
              })} />
            <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Assign staff on bookings and washes to build this board. User accounts, roles and branch access are managed by the OWNER from the user directory — nothing in this module bypasses that control.</p>
          </Card>
          <Card title="Vehicles & Customers Served" icon={Users} testid="cw-customers-card">
            <DataTable headers={["Customer", "Phone", "Total Spent", "Loyalty Points", "Type"]}
              rows={topCustomers.map((c) => [
                <span key="n" className="font-semibold text-slate-100">{c.name}</span>,
                c.phone || "—",
                <span key="t" className="font-bold text-emerald-300">{formatMoney(c.totalSpentGhs || 0, currentCurrency, true)}</span>,
                <span key="l" className="text-amber-300 font-bold">{c.loyaltyPoints || 0}</span>,
                c.type || "RETAIL",
              ])} />
            <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Customer records build themselves: completing a job finds-or-creates the customer and accrues spend + loyalty points automatically.</p>
          </Card>
        </div>
      )}

      {/* ══════════════ FINANCE & REPORTS — complete Financial Report ══════════════ */}
      {tab === "REPORTS" && (
        <div className="space-y-5">
          <FinancialReportSection
            mode="business"
            businessInfo={businessInfo}
            businessMetric={businessMetrics}
            transactions={transactions}
            inventory={inventory}
            customers={customers}
            currentCurrency={currentCurrency}
            accent="teal"
            testid="fin-report-wash"
            aiModuleKey="WASH"
            opsLinks={[
              {
                label: "Washes completed",
                value: `${completedWashes.length} · ${formatMoney(completedWashes.reduce((s: number, w: any) => s + (w.priceGhs || 0), 0), currentCurrency, true)}`,
                note: "Every completed wash posts revenue + consumes chemical stock automatically",
                tone: "emerald",
              },
              {
                label: "Bookings",
                value: `${bookings.length} (${bookings.filter((b: any) => b.status === "BOOKED").length} open)`,
                tone: "teal",
              },
              {
                label: "Active services",
                value: String(services.filter((s: any) => s.active !== false).length),
                tone: "sky",
              },
            ]}
          />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat testid="cw-stat-revenue" label="Revenue" value={formatMoney(revenue, currentCurrency, true)} sub={`${income.length} receipts`} color="emerald" icon={TrendingUp} />
            <Stat testid="cw-stat-expenses" label="Expenses" value={formatMoney(expenseTotal, currentCurrency, true)} sub={`${expenses.length} entries`} color="rose" icon={Wallet} />
            <Stat testid="cw-stat-profit" label="Net Profit" value={formatMoney(profit, currentCurrency, true)} sub={`${margin.toFixed(1)}% margin`} color={profit >= 0 ? "cyan" : "rose"} icon={Activity} />
            <Stat label="Average Ticket" value={completedWashes.length ? formatMoney(completedWashes.reduce((s, w) => s + (w.priceGhs || 0), 0) / completedWashes.length, currentCurrency, true) : "—"} sub="per job" color="amber" icon={CircleDollarSign} />
            <Stat label="Revenue Target" value={bizFormattedTarget(businessInfo)} sub="monthly goal" color="purple" icon={Gauge} />
            <Stat label="Payment Methods" value={paymentMix.length} sub="in use" color="blue" icon={Wallet} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Revenue vs Expenses — 7 Days" icon={BarChart3} testid="cw-rep-trend">
              <div className="p-3">
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={trend} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                    <Tooltip formatter={(v: any) => formatMoney(Number(v), currentCurrency)} contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }} />
                    <Bar dataKey="revenue" fill="#22d3ee" radius={[3, 3, 0, 0]} name="Sales" />
                    <Bar dataKey="expenses" fill="#fb7185" radius={[3, 3, 0, 0]} name="Expenses" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title="Service Performance Report" icon={Sparkles} testid="cw-rep-services">
              <DataTable headers={["Service", "Jobs", "Revenue", "Avg Price"]}
                rows={serviceStats.map((s) => [
                  s.name,
                  s.count,
                  <span key="r" className="font-bold text-emerald-300">{formatMoney(s.revenue, currentCurrency, true)}</span>,
                  formatMoney(s.count ? s.revenue / s.count : 0, currentCurrency, true),
                ])} />
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Income (Sales & Payments)" icon={TrendingUp} testid="cw-rep-income">
              <DataTable headers={["Date", "Description", "Method", "Amount"]}
                rows={income.slice(0, 12).map((t) => [
                  t.date,
                  <span key="d" className="text-[11px]">{t.description || t.category}</span>,
                  <span key="m" className="text-[10px] font-bold text-slate-400">{(t.paymentMethod || "").replaceAll("_", " ")}</span>,
                  <span key="a" className="font-bold text-emerald-300">{formatMoney(t.amountGhs, currentCurrency, true)}</span>,
                ])} />
            </Card>
            <Card title="Expenses" icon={Wallet} testid="cw-rep-expenses"
              action={<button onClick={() => setShowForm("EXPENSE")} className="text-[10px] font-bold text-rose-300 hover:text-rose-200">+ Log expense</button>}>
              <DataTable headers={["Date", "Category", "Description", "Amount"]}
                rows={expenses.slice(0, 12).map((t) => [
                  t.date,
                  <Badge key="c" s={(t.category || "").replace(/^CAR_WASH_/, "")} />,
                  <span key="d" className="text-[11px]">{t.description || "—"}</span>,
                  <span key="a" className="font-bold text-rose-300">{formatMoney(t.amountGhs, currentCurrency, true)}</span>,
                ])} />
            </Card>
          </div>

          <Card title="Full Activity Log" icon={Activity} testid="cw-rep-activities">
            <DataTable headers={["Time", "Action", "Detail", "By"]}
              rows={activities.map((a) => [
                <span key="t" className="text-[10px] text-slate-500 whitespace-nowrap">{a.recordedAt ? new Date(a.recordedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}</span>,
                <Badge key="a" s={a.action} />,
                <span key="d" className="text-[11px]">{a.detail}</span>,
                <span key="b" className="text-[10px] text-slate-500">{a.actorName || "—"}{a.actorRole ? ` (${a.actorRole})` : ""}</span>,
              ])} />
            <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Everything in this module — bookings, check-ins, completions, service changes, expenses — is written here for audit, and the full finance trail is exportable from the shared Export Center.</p>
          </Card>
        </div>
      )}

      {/* ══════════════ DAILY CHECKLIST ══════════════ */}
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
        <CarWashForm
          type={showForm}
          busy={busy}
          onClose={() => { setShowForm(null); setEditService(null); setError(""); }}
          onSubmit={submit}
          onPatch={patchEntity}
          services={services}
          inventory={branchInventory}
          employees={branchEmployees}
          currency={currentCurrency}
          editService={editService}
          today={today}
        />
      )}
    </div>
  );
}

function bizFormattedTarget(businessInfo: any): string {
  const v = Number(businessInfo?.monthlyTargetRevenueGhs);
  return v > 0 ? `GH₵ ${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}` : "—";
}

// ─── Modal form: start wash / booking / service / expense ────────────────
function CarWashForm({
  type, busy, onClose, onSubmit, onPatch, services, inventory, employees, currency, editService, today,
}: {
  type: FormType;
  busy: boolean;
  onClose: () => void;
  onSubmit: (t: FormType, d: any) => void;
  onPatch: (entity: string, id: number | string, d: any) => void;
  services: any[];
  inventory: any[];
  employees: any[];
  currency: CurrencyCode;
  editService?: any;
  today: string;
}) {
  const isEdit = type === "SERVICE" && !!editService;
  const [f, setF] = useState<any>(() =>
    isEdit
      ? { ...editService, supplyInventoryId: editService.supplyInventoryId ?? "" }
      : {
          priceGhs: undefined,
          amountGhs: undefined,
          quantity: undefined,
          bookingDate: today,
          category: type === "SERVICE" ? "CUSTOM" : "",
          active: true,
        }
  );
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));

  const activeServices = (services || []).filter((s) => s.active);
  const selectedService = (services || []).find((s: any) => String(s.id) === String(f.serviceId));
  const chemItems = (inventory || []).filter((i) => /SHAMPOO|CHEM|WAX|POLISH|DETERGENT/i.test(`${i.sku} ${i.name}`));

  const handle = (e: React.FormEvent) => {
    e.preventDefault();
    if (isEdit) {
      onPatch("SERVICE", editService.id, {
        name: f.name,
        category: f.category,
        description: f.description,
        priceGhs: f.priceGhs,
        durationMinutes: f.durationMinutes,
        includesItems: f.includesItems,
        supplyInventoryId: f.supplyInventoryId || null,
        supplyUsageLiters: f.supplyUsageLiters,
        active: f.active !== false && f.active !== "false",
      });
      return;
    }
    onSubmit(type, { ...f });
  };

  const I = ({ label, k, t = "text", ...rest }: any) => (
    <div>
      <label className="block text-[10px] text-slate-400 font-semibold mb-1">{label}</label>
      <input data-testid={`cwf-${k}`} type={t} value={f[k] ?? ""} onChange={(e) => set(k, t === "number" ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value)} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs" {...rest} />
    </div>
  );
  const S = ({ label, k, opts, testid }: any) => (
    <div>
      <label className="block text-[10px] text-slate-400 font-semibold mb-1">{label}</label>
      <select data-testid={testid || `cwf-${k}`} value={f[k] ?? ""} onChange={(e) => set(k, e.target.value)} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs">
        {opts.map((o: any) => <option key={o.v ?? o} value={o.v ?? o}>{o.l ?? o}</option>)}
      </select>
    </div>
  );

  const title =
    type === "WASH" ? "Start Wash (Drive-in)" :
    type === "BOOKING" ? "New Booking" :
    type === "SERVICE" ? (isEdit ? `Edit Service — ${editService.name}` : "Add Service") :
    "Log Expense";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4" data-testid="cw-form">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-slate-800 sticky top-0 bg-slate-900 z-10">
          <h3 className="text-lg font-bold text-white">{title}</h3>
          <button data-testid="cwf-close" onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handle} className="p-5 space-y-3">
          {type === "WASH" && <>
            <div className="grid grid-cols-2 gap-3"><I label="Customer Name" k="customerName" required /><I label="Customer Phone" k="customerPhone" /></div>
            <I label="Vehicle (make / plate)" k="vehicleLabel" placeholder="e.g. Toyota Corolla — GW-1234-24" required />
            <S label="Service" k="serviceId" opts={[{ v: "", l: "— select a service —" }, ...activeServices.map((s: any) => ({ v: s.id, l: `${s.name} (${formatMoney(s.priceGhs, currency, true)})` }))]} />
            {selectedService && (
              <p className="text-[10px] text-cyan-300 -mt-1">Includes: {selectedService.includesItems || selectedService.name}{selectedService.supplyUsageLiters ? ` • draws ${selectedService.supplyUsageLiters}L chemicals on completion` : ""}</p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <I label="Price (GH₵)" k="priceGhs" t="number" step="0.01" min={0} placeholder={selectedService ? String(selectedService.priceGhs) : "auto from service"} />
              <S label="Assign Staff" k="staffName" opts={[{ v: "", l: "— unassigned —" }, ...(employees || []).map((e: any) => ({ v: e.name, l: `${e.name} (${e.role})` }))]} />
            </div>
            <I label="Notes" k="notes" />
          </>}
          {type === "BOOKING" && <>
            <div className="grid grid-cols-2 gap-3"><I label="Customer Name" k="customerName" required /><I label="Customer Phone" k="customerPhone" /></div>
            <I label="Vehicle (make / plate)" k="vehicleLabel" placeholder="e.g. Kia Sportage — GE-8890-23" />
            <S label="Service" k="serviceId" opts={[{ v: "", l: "— select a service —" }, ...activeServices.map((s: any) => ({ v: s.id, l: `${s.name} (${formatMoney(s.priceGhs, currency, true)})` }))]} />
            <div className="grid grid-cols-2 gap-3"><I label="Booking Date" k="bookingDate" t="date" required /><I label="Time Slot" k="timeSlot" placeholder="e.g. 10:30" /></div>
            <S label="Preferred Staff" k="assignedStaffName" opts={[{ v: "", l: "— any —" }, ...(employees || []).map((e: any) => ({ v: e.name, l: `${e.name} (${e.role})` }))]} />
            <I label="Notes" k="notes" />
          </>}
          {type === "SERVICE" && <>
            <I label="Service Name" k="name" placeholder="e.g. Leather Seat Treatment" required />
            <div className="grid grid-cols-2 gap-3">
              <S label="Category" k="category" opts={SERVICE_CATEGORIES} />
              <I label="Price (GH₵)" k="priceGhs" t="number" step="0.01" min={0} required />
            </div>
            <I label="Description" k="description" placeholder="What the customer gets" />
            <div className="grid grid-cols-2 gap-3">
              <I label="Duration (minutes)" k="durationMinutes" t="number" min={0} />
              <I label="Includes items (offer contents)" k="includesItems" placeholder="Shampoo, wax, tyre shine…" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <S label="Chemical supply (from stock)" k="supplyInventoryId" opts={[{ v: "", l: "— none —" }, ...chemItems.map((i: any) => ({ v: i.id, l: `${i.name} (${i.quantity} ${i.unit || ""} left)` }))]} />
              <I label="Liters used per job" k="supplyUsageLiters" t="number" step="0.1" min={0} placeholder="e.g. 2" />
            </div>
            <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer"><input data-testid="cwf-active" type="checkbox" checked={f.active !== false && f.active !== "false"} onChange={(e) => set("active", e.target.checked)} className="accent-cyan-500 w-3.5 h-3.5" />Bookable (visible on the service menu)</label>
          </>}
          {type === "EXPENSE" && <>
            <div className="grid grid-cols-2 gap-3">
              <I label="Category" k="category" placeholder="Water Bill, Detergents, Wages…" required />
              <I label="Amount (GH₵)" k="amountGhs" t="number" step="0.01" min={0} required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <S label="Payment Method" k="paymentMethod" opts={["CASH", "MTN_MOMO", "TELECEL_CASH", "POS_CARD", "BANK_TRANSFER"]} />
              <I label="Description" k="description" />
            </div>
          </>}
          <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
            <button type="button" data-testid="cwf-cancel" onClick={onClose} className="px-4 py-2 bg-slate-800 rounded-lg text-xs text-slate-300">Cancel</button>
            <button data-testid="cwf-submit" disabled={busy} className="px-5 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-xs font-bold text-white disabled:opacity-50">{busy ? "Saving..." : isEdit ? "Save Changes" : "Save"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
