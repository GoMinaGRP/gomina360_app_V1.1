"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import AiSectionGuide from "./AiSectionGuide";
import FishGrowthAnalytics from "./FishGrowthAnalytics";
import {
  Fish, Droplets, HeartPulse, Activity, Egg as EggIcon, Boxes,
  Wallet, ClipboardCheck, Plus, X, Loader2, Building2,
  TrendingUp, TrendingDown, AlertTriangle, CalendarCheck,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, CartesianGrid, Legend,
} from "recharts";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import { analyzeAquaculture, AQUA_ALERT_STYLES, AQUA_METRIC_COLORS } from "@/lib/aquacultureAnalytics";
import DailyChecklistPanel from "./DailyChecklistPanel";
import FinancialReportSection from "./FinancialReportSection";
import ExpenseEntryForm from "./ExpenseEntryForm";
import ConfirmActionModal from "./ConfirmActionModal";
import { classifyEntry, confirmMeta } from "@/lib/entryConfirm";

interface Props {
  currentUser: any;
  businessInfo: any;
  businessMetrics: any;
  inventory: any[];
  transactions: any[];
  assets: any[];
  employees: any[];
  currentCurrency: CurrencyCode;
  onRefreshData: () => void;
}

type AquaTab = "DASHBOARD" | "STOCK" | "PONDS" | "FEED" | "WATER" | "HEALTH" | "HARVEST" | "FINANCE";

const TABS: { key: AquaTab; label: string; icon: any }[] = [
  { key: "DASHBOARD", label: "Dashboard", icon: Activity },
  { key: "STOCK", label: "Fish Stock & Batches", icon: Fish },
  { key: "PONDS", label: "Ponds / Tanks", icon: Droplets },
  { key: "FEED", label: "Feed Management", icon: Boxes },
  { key: "WATER", label: "Water Quality", icon: HeartPulse },
  { key: "HEALTH", label: "Tasks & Activities", icon: ClipboardCheck },
  { key: "HARVEST", label: "Harvest Status", icon: TrendingDown },
  { key: "FINANCE", label: "Finance", icon: Wallet },
];

export default function AquacultureModule({
  currentUser, businessInfo, businessMetrics, inventory, transactions,
  assets, employees, currentCurrency, onRefreshData,
}: Props) {
  const [tab, setTab] = useState<AquaTab>("DASHBOARD");
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState<null | "POND" | "BATCH" | "FEED" | "WATER" | "HARVEST" | "CHECKLIST" | "SALE">(null);
  const [showExpense, setShowExpense] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmEntry, setConfirmEntry] = useState<{ entity: string; data: any } | null>(null);

  const [ponds, setPonds] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  const [feedLogs, setFeedLogs] = useState<any[]>([]);
  const [waterLogs, setWaterLogs] = useState<any[]>([]);
  const [harvests, setHarvests] = useState<any[]>([]);
  const [checklists, setChecklists] = useState<any[]>([]);
  // Daily fish weight-sampling logs (growth & biomass analysis)
  const [weightLogs, setWeightLogs] = useState<any[]>([]);

  const today = new Date().toISOString().split("T")[0];
  const bizId = businessInfo?.id;

  const branchInventory = inventory.filter((i) => i.businessId === bizId);
  const branchEmployees = employees.filter((e) => e.businessId === bizId);
  const branchTrx = transactions.filter((t) => t.businessId === bizId);
  const branchAssets = assets.filter((a) => a.businessId === bizId);

  const refresh = useCallback(async () => {
    if (!bizId) return;
    try {
      const res = await fetch(`/api/aquaculture?businessId=${bizId}`);
      const d = await res.json();
      if (d.success) {
        setPonds(d.ponds || []);
        setBatches(d.batches || []);
        setFeedLogs(d.feedLogs || []);
        setWaterLogs(d.waterLogs || []);
        setHarvests(d.harvests || []);
        setChecklists(d.checklists || []);
        setWeightLogs(d.weightLogs || []);
      }
    } finally {
      setLoading(false);
    }
  }, [bizId]);

  useEffect(() => { refresh(); }, [refresh]);

  // ─── Submit handler (with Sale/Inventory/Asset confirmation gate) ───
  const performSubmit = async (entity: string, data: any) => {
    setBusy(true); setErr("");
    try {
      // Stock-linked sale through the shared pipeline: validates
      // available stock, deducts, records revenue + receipt.
      if (entity === "SALE") {
        const res = await fetch("/api/sales", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessId: bizId,
            branchCode: businessInfo?.code,
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            paymentMethod: data.paymentMethod,
            notes: data.notes,
            cartItems: [{
              inventoryId: Number(data.inventoryId),
              quantity: Number(data.quantity),
              sellingPrice: data.sellingPrice ? Number(data.sellingPrice) : undefined,
              customPriceReason: data.customPriceReason,
            }],
            createdByUserId: currentUser?.id,
            createdByName: currentUser?.name,
            createdByRole: currentUser?.role,
          }),
        });
        const d = await res.json();
        if (d.success) { setShowForm(null); await refresh(); onRefreshData(); }
        else setErr(d.error || "Sale failed.");
        return;
      }
      const res = await fetch("/api/aquaculture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity,
          data: {
            ...data,
            businessId: bizId,
            branchCode: businessInfo?.code,
            branchName: businessInfo?.name,
            createdByName: currentUser?.name,
            createdByRole: currentUser?.role,
            recordedByName: currentUser?.name,
            recordedByRole: currentUser?.role,
            recordedByUserId: currentUser?.id,
          },
        }),
      });
      const d = await res.json();
      if (d.success) {
        setShowForm(null);
        await refresh();
        // For harvest, reload ponds/batches from db
        if (entity === "HARVEST") onRefreshData();
      } else setErr(d.error || "Failed to save");
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const submit = (entity: string, data: any) => {
    if (classifyEntry(entity)) {
      setConfirmEntry({ entity, data });
    } else {
      performSubmit(entity, data);
    }
  };


  // ─── KPI calculations ────────────────────────────────────────────
  const activePonds = ponds.filter((p) => p.status !== "EMPTY" && p.status !== "PREPARE_NEXT_CYCLE");
  const growingBatches = batches.filter((b) => b.status === "GROWING");
  const totalFish = growingBatches.reduce((s, b) => s + (b.currentCount || 0), 0);
  const totalPlaced = batches.reduce((s, b) => s + (b.initialCount || 0), 0);
  const totalMortality = batches.reduce((s, b) => s + (b.mortalityTotal || 0), 0);
  const mortalityRate = totalPlaced > 0 ? (totalMortality / totalPlaced) * 100 : 0;

  const feedToday = feedLogs.filter((f) => f.entryType === "CONSUMPTION" && f.recordedDate === today).reduce((s, f) => s + (f.quantityKg || 0), 0);
  const feedIncrementWeek = feedLogs.filter((f) => f.recordedDate === today).reduce((s, f) => s + (f.quantityKg || 0), 0);
  const biomassGained30d = harvests.length > 0 ? harvests.reduce((s, h) => s + (h.totalWeightKg || 0), 0) : 0;
  const feedConsumed30d = feedLogs.reduce((s, f) => s + (f.quantityKg || 0), 0);
  const fcrEstimate = biomassGained30d > 0 && feedConsumed30d > 0 ? feedConsumed30d / biomassGained30d : 0;

  const waterToday = waterLogs.filter((w) => w.sampleDate === today);
  const avgPhToday = waterToday.length > 0 ? waterToday.reduce((s, w) => s + (w.phLevel || 7), 0) / waterToday.length : 7.0;
  const lowestDoToday = waterToday.length > 0 ? Math.min(...waterToday.map((w) => w.dissolvedOxygenMgL ?? 0)) : 0;

  const harvestsToday = harvests.filter((h) => h.saleDate === today).reduce((s, h) => s + (h.totalWeightKg || 0), 0);
  const revenueToday = branchTrx.filter((tr) => tr.type === "INCOME" && tr.date === today).reduce((s, tr) => s + (tr.amountGhs || 0), 0);
  const expensesToday = branchTrx.filter((tr) => tr.type === "EXPENSE" && tr.date === today).reduce((s, tr) => s + (tr.amountGhs || 0), 0);
  const netProfit = revenueToday - expensesToday;

  const todayTasks = checklists.filter((c) => c.checklistDate === today);
  const tasksDone = todayTasks.filter((c) => c.isCompleted).length;
  const taskPct = todayTasks.length > 0 ? Math.round((tasksDone / todayTasks.length) * 100) : 100;

  // ─── Chart data ───────────────────────────────────────────────────
  const harvestTrend = useMemo(() => {
    const map: Record<string, { weight: number; revenue: number }> = {};
    harvests.forEach((h) => {
      const d = h.saleDate || "unknown";
      map[d] ||= { weight: 0, revenue: 0 };
      map[d].weight += h.totalWeightKg || 0;
      map[d].revenue += h.revenueGhs || 0;
    });
    return Object.entries(map).map(([date, data]) => ({ date, ...data })).sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  }, [harvests]);

  const waterTrend = useMemo(() => {
    return waterLogs.map((w) => ({
      date: w.sampleDate,
      do: w.dissolvedOxygenMgL,
      ph: w.phLevel,
      ammonia: w.ammoniaMgL,
      pond: w.pondId,
    })).sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  }, [waterLogs]);

  const feedTrend = useMemo(() => {
    const map: Record<string, number> = {};
    feedLogs.filter((f) => f.entryType === "CONSUMPTION").forEach((f) => {
      map[f.recordedDate] = (map[f.recordedDate] || 0) + (f.quantityKg || 0);
    });
    return Object.entries(map).map(([date, kg]) => ({ date, kg })).sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  }, [feedLogs]);

  // ─── Analytics & AI Alerts ─────────────────────────────────────────
  const analysis = useMemo(() => analyzeAquaculture({
    ponds, batches, feedLogs, waterLogs, harvests, checklists,
    transactions: branchTrx, currentCurrency,
  }), [ponds, batches, feedLogs, waterLogs, harvests, checklists, branchTrx, currentCurrency]);

  const { alerts, metrics, healthScore, statusColor } = analysis;
  // A brand-new farm (no ponds/batches/logs/harvests) shows a neutral
  // ready-to-start state instead of a misleading score + noise alerts.
  const hasFarmData =
    (ponds?.length || 0) + (batches?.length || 0) + (feedLogs?.length || 0) +
    (waterLogs?.length || 0) + (harvests?.length || 0) > 0;

  const Stat = ({ label, value, sub, color = "emerald", icon: Icon }: any) => (
    <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4">
      <div className="flex items-center justify-between text-[10px] uppercase font-bold text-slate-400">
        <span>{label}</span>{Icon && <Icon className={`w-4 h-4 text-${color}-400`} />}
      </div>
      <div className={`text-xl font-black text-${color}-400 mt-1`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );

  const Card = ({ title, icon: Icon, children, action }: any) => (
    <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl">
      <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">{Icon && <Icon className="w-5 h-5 text-cyan-400" />}<h3 className="text-base font-bold text-white">{title}</h3></div>
        {action}
      </div>
      {children}
    </div>
  );

  const imageBtnCls = "h-24 w-full object-cover rounded-lg border border-slate-700";

  const addBtn = (onClick: () => void, label: string, color = "emerald") => (
    <button onClick={onClick} className={`flex items-center gap-1 px-3 py-1.5 rounded-lg bg-${color}-600 hover:bg-${color}-500 text-white text-xs font-bold`}>
      <Plus className="w-3.5 h-3.5" /> {label}
    </button>
  );

  if (loading) {
    return <div className="flex items-center justify-center min-h-[50vh]"><Loader2 className="w-8 h-8 animate-spin text-cyan-400" /></div>;
  }

  const scoreBarColor = statusColor === "red" ? "bg-rose-500" : statusColor === "yellow" ? "bg-amber-500" : "bg-emerald-500";
  const scoreTextColor = statusColor === "red" ? "text-rose-400" : statusColor === "yellow" ? "text-amber-400" : "text-emerald-400";

  const confirmKind = confirmEntry ? classifyEntry(confirmEntry.entity) : null;
  const confirmView = confirmKind ? confirmMeta(confirmKind, confirmEntry?.data) : null;

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-[1600px] mx-auto text-slate-100">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-5 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 rounded-xl bg-cyan-500/20 border border-cyan-400/30 flex items-center justify-center shrink-0">
            <Fish className="w-6 h-6 text-cyan-400" />
          </div>
          <div>
            <span className="px-2.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 text-xs font-bold border border-cyan-500/30">AQUACULTURE FARM MANAGEMENT</span>
            <h2 className="text-xl sm:text-2xl font-extrabold text-white mt-1">{businessInfo?.name}</h2>
            <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5"><Building2 className="w-3 h-3" />{businessInfo?.code} • {[businessInfo?.town, businessInfo?.district, businessInfo?.region].filter(Boolean).join(", ")}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-center"><div className="text-slate-400 text-[10px]">Live Fish</div><div className="text-sm font-extrabold text-cyan-400">{totalFish.toLocaleString()}</div></div>
            <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-center"><div className="text-slate-400 text-[10px]">Feed Today</div><div className="text-sm font-extrabold text-amber-400">{feedToday.toFixed(0)} kg</div></div>
            <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-center"><div className="text-slate-400 text-[10px]">Avg pH</div><div className="text-sm font-extrabold text-lime-400">{avgPhToday.toFixed(2)}</div></div>
            <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-center"><div className="text-slate-400 text-[10px]">Net Profit</div><div className={`text-sm font-extrabold ${netProfit >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{formatMoney(netProfit, currentCurrency, true)}</div></div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-1 bg-slate-800/90 border border-slate-700/80 p-1.5 rounded-xl">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition ${tab === t.key ? "bg-cyan-600 text-white shadow" : "text-slate-300 hover:bg-slate-700/70"}`}>
            <t.icon className="w-4 h-4" />
            <span className="text-[10px] leading-none lg:leading-normal lg:text-xs">{t.label}</span>
          </button>
        ))}
        <button
          data-testid="aqua-open-expense"
          onClick={() => setShowExpense(true)}
          className="ml-auto flex items-center gap-1.5 px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold"
        >
          <Wallet className="w-4 h-4" />Record Expense
        </button>
        <AiSectionGuide moduleKey="AQUA" section={tab} businessInfo={businessInfo} />
      </div>

      {err && <div className="px-4 py-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs"><AlertTriangle className="w-4 h-4 inline mr-1" />{err}</div>}

      {/* ══════════ DASHBOARD ══════════ */}
      {tab === "DASHBOARD" && (
        <div className="space-y-5">
          {/* Health & Performance Score — neutral ready-to-start card on a
              brand-new farm (no ponds/batches/logs yet) */}
          {!hasFarmData ? (
            <div className="rounded-2xl border border-slate-700 bg-slate-800/60 p-5 grid grid-cols-1 md:grid-cols-3 gap-4" data-testid="aqua-health-empty">
              <div>
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-300"><Activity className="w-4 h-4" /> Farm Health & Performance Score</div>
                <div className="flex items-end gap-2 mt-1"><span className="text-5xl font-black text-slate-500">—</span><span className="text-xs text-slate-500 mb-1">/ 100</span></div>
                <div className="w-full max-w-xs h-2.5 bg-slate-800 rounded-full overflow-hidden mt-2"><div className="h-full bg-slate-700" style={{ width: "0%" }} /></div>
                <p className="text-[10px] text-slate-500 mt-2">Scores appear once your first records are in.</p>
              </div>
              <div className="md:col-span-2 flex items-center">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-cyan-500/15 border border-cyan-500/40 flex items-center justify-center shrink-0"><Fish className="w-5 h-5 text-cyan-300" /></div>
                  <div>
                    <div className="text-sm font-bold text-white">This farm is ready to go</div>
                    <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                      Brand-new unit — no ponds, batches or logs yet. Register your first pond and stock a batch,
                      then capture daily feed & water-quality logs: the health score, smart alerts and trends
                      switch on automatically from real data.
                    </p>
                    <p className="text-[11px] text-slate-500 mt-2">1 · Ponds tab — add the pond &nbsp;→&nbsp; 2 · Stock the first batch &nbsp;→&nbsp; 3 · Log feed, water & health daily</p>
                  </div>
                </div>
              </div>
            </div>
          ) : (<>
          <div className={`rounded-2xl border p-5 grid grid-cols-1 md:grid-cols-3 gap-4 ${statusColor === "red" ? "bg-rose-500/10 border-rose-500/30" : statusColor === "yellow" ? "bg-amber-500/10 border-amber-500/30" : "bg-emerald-500/10 border-emerald-500/30"}`}>
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-300"><Activity className="w-4 h-4" /> Farm Health & Performance Score</div>
              <div className="flex items-end gap-2 mt-1"><span className={`text-5xl font-black ${scoreTextColor}`}>{healthScore}</span><span className="text-xs text-slate-400 mb-1">/ 100</span></div>
              <div className="w-full max-w-xs h-2.5 bg-slate-800 rounded-full overflow-hidden mt-2"><div className={`h-full ${scoreBarColor} transition-all`} style={{ width: `${healthScore}%` }} /></div>
            </div>
            <div className="md:col-span-2 flex items-center justify-around gap-3">
              <div className="text-center"><div className="w-10 h-10 mx-auto rounded-full bg-rose-500/20 border border-rose-500/40 flex items-center justify-center"><AlertTriangle className="w-5 h-5 text-rose-400" /></div><div className="mt-1 text-2xl font-black text-rose-400">{analysis.alerts.filter((a: any) => a.level === "critical").length}</div><div className="text-[10px] text-slate-400">Critical</div></div>
              <div className="text-center"><div className="w-10 h-10 mx-auto rounded-full bg-amber-500/20 border border-amber-500/40 flex items-center justify-center"><AlertTriangle className="w-5 h-5 text-amber-400" /></div><div className="mt-1 text-2xl font-black text-amber-400">{analysis.alerts.filter((a: any) => a.level === "warning").length}</div><div className="text-[10px] text-slate-400">Warning</div></div>
              <div className="text-center"><div className="w-10 h-10 mx-auto rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center"><CalendarCheck className="w-5 h-5 text-emerald-400" /></div><div className="mt-1 text-2xl font-black text-emerald-400">{analysis.alerts.filter((a: any) => a.level === "normal").length}</div><div className="text-[10px] text-slate-400">Normal</div></div>
              <div className="text-center"><div className="w-10 h-10 mx-auto rounded-full bg-slate-700 border border-slate-600 flex items-center justify-center"><Fish className="w-5 h-5 text-slate-300" /></div><div className="mt-1 text-2xl font-black text-slate-200">{analysis.alerts.length}</div><div className="text-[10px] text-slate-400">Total</div></div>
            </div>
          </div>

          {/* AI Alerts Grid */}
          <div>
            <div className="flex items-center space-x-2 mb-3"><AlertTriangle className="w-4 h-4 text-amber-400" /><h3 className="text-sm font-bold text-white">AI Smart Alerts & Recommended Actions</h3></div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-96 overflow-y-auto pr-1">
              {alerts.map((a: any) => (
                <div key={a.id} className={`rounded-xl border p-3 ${AQUA_ALERT_STYLES[a.level as keyof typeof AQUA_ALERT_STYLES]}`}>
                  <div className="flex items-start justify-between gap-2"><div><div className="flex items-center gap-1.5 flex-wrap"><span className="text-[10px] font-bold uppercase opacity-70 tracking-wider">{a.category}</span><span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${a.level === "critical" ? "bg-rose-500/30 text-rose-200" : a.level === "warning" ? "bg-amber-500/30 text-amber-200" : "bg-emerald-500/30 text-emerald-200"}`}>{a.level}</span></div><div className="text-[13px] font-bold mt-1">{a.title}</div></div></div>
                  <p className="text-[11px] leading-snug mt-1.5 opacity-90">{a.message}</p>
                  <div className="flex items-center justify-between mt-2 text-[10px] opacity-70"><span>{a.value && `${a.value} | ${a.threshold}`}</span></div>
                  <div className="mt-2 text-[11px] bg-slate-900/40 rounded-lg p-2 leading-snug"><span className="font-bold text-cyan-300">💡 Action: </span><span className="text-slate-200">{a.recommendation}</span></div>
                </div>
              ))}
            </div>
          </div>
          </>)}

          {/* KPI section */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <Stat label="Live Fish" value={totalFish.toLocaleString()} sub={`${totalPlaced.toLocaleString()} placed`} icon={Fish} color="cyan" />
            <Stat label="Ponds Active" value={activePonds.length} sub={`${ponds.length} total`} icon={Droplets} color="blue" />
            <Stat label="Mortality Rate" value={`${mortalityRate.toFixed(1)}%`} sub={`${totalMortality.toLocaleString()} total`} color={mortalityRate > 8 ? "rose" : "emerald"} icon={TrendingDown} />
            <Stat label="Feed Today" value={`${feedToday.toFixed(0)} kg`} sub={`${feedIncrementWeek.toFixed(0)} kg wk`} color="amber" icon={Boxes} />
            <Stat label="pH Level" value={avgPhToday.toFixed(2)} sub={`${waterToday.length} tests today`} color="lime" icon={HeartPulse} />
            <Stat label="Net Profit" value={formatMoney(netProfit, currentCurrency, true)} sub={`Rev ${formatMoney(revenueToday, currentCurrency, true)}`} color={netProfit >= 0 ? "emerald" : "rose"} icon={Wallet} />
          </div>

          {/* Trends charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Harvest & Revenue Trend" icon={TrendingUp}>
              <div className="p-4"><ResponsiveContainer width="100%" height={220}>
                <BarChart data={harvestTrend}><XAxis dataKey="date" stroke="#94a3b8" style={{ fontSize: 10 }} /><YAxis yAxisId="left" orientation="left" stroke="#10b981" style={{ fontSize: 10 }} /><YAxis yAxisId="right" orientation="right" stroke="#06b6d4" style={{ fontSize: 10 }} /><Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }} /><Bar yAxisId="left" dataKey="weight" name="Weight (kg)" fill="#06b6d4" radius={[3, 3, 0, 0]} /><Bar yAxisId="right" dataKey="revenue" name="Revenue (GH₵)" fill="#10b981" radius={[3, 3, 0, 0]} /></BarChart>
              </ResponsiveContainer></div>
            </Card>
            <Card title="Water Quality Trends" icon={HeartPulse}>
              <div className="p-4"><ResponsiveContainer width="100%" height={220}>
                <LineChart data={waterTrend}><CartesianGrid strokeDasharray="3 3" stroke="#334155" /><XAxis dataKey="date" stroke="#94a3b8" style={{ fontSize: 10 }} /><YAxis stroke="#94a3b8" style={{ fontSize: 10 }} /><Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }} /><Line type="monotone" dataKey="do" name="DO (mg/L)" stroke="#06b6d4" strokeWidth={2} dot={{ r: 3 }} /><Line type="monotone" dataKey="ph" name="pH" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} /><Line type="monotone" dataKey="ammonia" name="Ammonia (mg/L)" stroke="#f43f5e" strokeWidth={2} dot={{ r: 3 }} /></LineChart>
              </ResponsiveContainer></div>
            </Card>
            <Card title="Feed Consumption Trend" icon={Boxes}>
              <div className="p-4"><ResponsiveContainer width="100%" height={200}>
                <LineChart data={feedTrend}><CartesianGrid strokeDasharray="3 3" stroke="#334155" /><XAxis dataKey="date" stroke="#94a3b8" style={{ fontSize: 10 }} /><YAxis stroke="#94a3b8" style={{ fontSize: 10 }} /><Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }} /><Line type="monotone" dataKey="kg" name="Feed (kg)" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} /></LineChart>
              </ResponsiveContainer></div>
            </Card>
            <Card title="Batch Stock Composition" icon={Fish}>
              <div className="p-4">{(() => { const comp = growingBatches.filter((b: any) => b.species).reduce((acc: Record<string, number>, b: any) => { acc[b.species] = (acc[b.species] || 0) + (b.currentCount || 0); return acc; }, {}); return Object.entries(comp).length ? <ResponsiveContainer width="100%" height={200}><PieChart><Pie data={Object.entries(comp).map(([name, value]) => ({ name, value }))} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={65} label={(e: any) => e.name}>{Object.entries(comp).map((_, i) => <Cell key={i} fill={["#06b6d4", "#3b82f6", "#a855f7", "#ec4899"][i % 4]} />)}</Pie><Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }} /></PieChart></ResponsiveContainer> : <p className="text-xs text-slate-400 text-center py-6">No active batches.</p>; })()}</div>
            </Card>
          </div>

          {/* Fish Growth & Production Analytics — daily weight sampling vs
              species standard, weight by age, feed, FCR, survival/mortality,
              harvests and biomass, scoped by pond/batch/species/branch/date */}
          <FishGrowthAnalytics
            businessId={bizId}
            ponds={ponds}
            batches={batches}
            feedLogs={feedLogs}
            harvests={harvests}
            weightLogs={weightLogs}
            currentUserName={currentUser?.name}
            currentUserRole={currentUser?.role}
            onRefresh={refresh}
          />

          {/* Performance metrics cards */}
          <div>
            <div className="flex items-center space-x-2 mb-2.5"><TrendingUp className="w-4 h-4 text-emerald-400" /><h3 className="text-sm font-bold text-white">Performance Indicators</h3></div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              {metrics.map((m: any) => (
                <div key={m.label} className={`rounded-xl border bg-slate-900/60 p-3 ${AQUA_METRIC_COLORS[m.color]}`}>
                  <div className="text-[10px] uppercase font-bold opacity-70">{m.label}</div>
                  <div className="text-lg font-black mt-1">{m.current}</div>
                  <div className="text-[10px] opacity-70 mt-1">Prev: {m.previous}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══════════ STOCK & BATCHES ══════════ */}
      {tab === "STOCK" && (
        <Card title="Fish Stock & Batch Management" icon={Fish}
          action={addBtn(() => setShowForm("BATCH"), "Register New Batch")}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
                <tr><th className="px-4 py-3">Batch</th><th className="px-4 py-3">Species / Category</th><th className="px-4 py-3">Pond/Tank/Cage</th><th className="px-4 py-3 text-right">Placed</th><th className="px-4 py-3 text-right">Live</th><th className="px-4 py-3 text-right">Mortality</th><th className="px-4 py-3 text-right">Avg Wt (g)</th><th className="px-4 py-3 text-center">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {batches.map((b: any) => {
                  const mRate = b.initialCount > 0 ? ((b.mortalityTotal || 0) / b.initialCount * 100) : 0;
                  const ownerPond = ponds.find((p: any) => p.id === b.pondId);
                  return (
                    <tr key={b.id} className="hover:bg-slate-700/40">
                      <td className="px-4 py-3 font-mono font-bold text-cyan-400">{b.batchNumber}</td>
                      <td className="px-4 py-3"><div className="font-bold text-slate-200">{b.species}</div><div className="text-[10px] text-slate-400">{b.strainGenetics || "—"}</div></td>
                      <td className="px-4 py-3 text-slate-300">{ownerPond?.name || `Pond #${b.pondId}`}</td>
                      <td className="px-4 py-3 text-right text-slate-300">{b.initialCount?.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right font-bold text-white">{b.currentCount?.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={mRate > 8 ? "text-rose-400 font-bold" : "text-slate-400"}>
                          {b.mortalityTotal?.toLocaleString()} ({mRate.toFixed(1)}%)
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-300">{b.avgWeightGrams || "—"}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          b.status === "GROWING"
                            ? "bg-emerald-500/20 text-emerald-300"
                            : b.status === "HARVESTED"
                            ? "bg-cyan-500/20 text-cyan-300"
                            : "bg-slate-700 text-slate-300"
                        }`}>{b.status}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ══════════ PONDS/TANKS ══════════ */}
      {tab === "PONDS" && (
        <div className="space-y-4">
          <Card title="Pond / Tank / Cage Management" icon={Droplets}
            action={addBtn(() => setShowForm("POND"), "Add New Pond")}>
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {ponds.map((pond: any) => {
                const utilization = (pond.currentBiomassKg || 0) / Math.max(pond.capacityLiters || 1, 1) * 100;
                const utilColor = utilization > 80 ? "text-rose-400" : utilization > 60 ? "text-amber-400" : "text-emerald-400";
                const statusColor = pond.status === "STOCKED" ? "bg-emerald-500/20 text-emerald-300" : pond.status === "ACTIVE" ? "bg-blue-500/20 text-blue-300" : "bg-slate-700 text-slate-300";
                return (
                  <div key={pond.id} className="p-4 rounded-xl bg-slate-900/60 border border-slate-700 space-y-2.5">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="text-sm font-bold text-white">{pond.name}</div>
                        <div className="text-[10px] text-slate-400 font-mono mt-0.5">{pond.pondId}</div>
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${statusColor}`}>{pond.status}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="bg-slate-800/70 p-2 rounded-lg"><div className="text-[9px] text-slate-500">Capacity</div><div className="text-xs font-bold text-white">{pond.capacityLiters?.toLocaleString()} L</div></div>
                      <div className="bg-slate-800/70 p-2 rounded-lg"><div className="text-[9px] text-slate-500">Biomass</div><div className="text-xs font-bold text-cyan-400">{pond.currentBiomassKg?.toLocaleString()} kg</div></div>
                      <div className="bg-slate-800/70 p-2 rounded-lg"><div className="text-[9px] text-slate-500">Density</div><div className={`text-xs font-bold ${utilColor}`}>{utilization.toFixed(0)}%</div></div>
                    </div>
                    <div className="text-[10px] text-slate-500">{pond.type} • Targets: DO {pond.doTargetMinMgL}–{pond.doTargetMaxMgL} mg/L, pH {pond.phTargetMin}–{pond.phTargetMax}</div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}

      {/* ══════════ FEED ══════════ */}
      {tab === "FEED" && (
        <Card title="Feed Management" icon={Boxes}
          action={addBtn(() => setShowForm("FEED"), "Log Feed")}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
                <tr><th className="px-4 py-3">Date</th><th className="px-4 py-3">Feed Type</th><th className="px-4 py-3">Supplier</th><th className="px-4 py-3 text-right">Qty (kg)</th><th className="px-4 py-3 text-right">Cost/kg</th><th className="px-4 py-3 text-right">Total Cost</th><th className="px-4 py-3 text-center">Type</th><th className="px-4 py-3">By</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {feedLogs.map((l: any) => (
                  <tr key={l.id} className="hover:bg-slate-700/40">
                    <td className="px-4 py-3 text-slate-400">{l.recordedDate}</td>
                    <td className="px-4 py-3 text-slate-200 font-semibold">{l.feedType}</td>
                    <td className="px-4 py-3 text-slate-400">{l.brandSupplier || "—"}</td>
                    <td className="px-4 py-3 text-right text-slate-200">{l.quantityKg?.toLocaleString()} kg</td>
                    <td className="px-4 py-3 text-right text-slate-400">{l.costPerKgGhs ? formatMoney(l.costPerKgGhs, currentCurrency) : "—"}</td>
                    <td className="px-4 py-3 text-right font-bold text-emerald-400">{formatMoney(l.totalCostGhs, currentCurrency)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${l.entryType === "PURCHASE" ? "bg-amber-500/20 text-amber-300" : "bg-slate-700 text-slate-300"}`}>
                        {l.entryType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-400">{l.recordedByName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ══════════ WATER QUALITY ══════════ */}
      {tab === "WATER" && (
        <Card title="Water Quality Monitoring" icon={HeartPulse}
          action={addBtn(() => setShowForm("WATER"), "Sample Water")}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
                <tr><th className="px-4 py-3">Date</th><th className="px-4 py-3">Pond/Cage</th><th className="px-4 py-3 text-right">Liters</th><th className="px-4 py-3 text-right">pH</th><th className="px-4 py-3 text-right">DO (mg/L)</th><th className="px-4 py-3 text-right">Ammonia</th><th className="px-4 py-3">Turbidity</th><th className="px-4 py-3">Treatment</th><th className="px-4 py-3">By</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {waterLogs.map((w: any) => {
                  const pondName = ponds.find((p: any) => p.id === w.pondId)?.name || `Pond #${w.pondId}`;
                  const doGood = (w.dissolvedOxygenMgL || 0) >= 6;
                  const phGood = (w.phLevel || 0) >= 6.5 && (w.phLevel || 0) <= 8.5;
                  const ammoniaGood = (w.ammoniaMgL || 0) <= 0.2;
                  return (
                    <tr key={w.id} className="hover:bg-slate-700/40">
                      <td className="px-4 py-3 text-slate-400">{w.sampleDate}</td>
                      <td className="px-4 py-3 text-slate-200 font-semibold">{pondName}</td>
                      <td className="px-4 py-3 text-right text-slate-300">{w.waterLiters?.toLocaleString()} L</td>
                      <td className={`px-4 py-3 text-right font-bold ${phGood ? "text-emerald-400" : "text-amber-400"}`}>{w.phLevel}</td>
                      <td className={`px-4 py-3 text-right font-bold ${doGood ? "text-emerald-400" : "text-amber-400"}`}>{w.dissolvedOxygenMgL}</td>
                      <td className={`px-4 py-3 text-right font-bold ${ammoniaGood ? "text-emerald-400" : "text-rose-400"}`}>{w.ammoniaMgL} mg/L</td>
                      <td className="px-4 py-3 text-slate-300">{w.turbidity || "—"}</td>
                      <td className="px-4 py-3 text-slate-400">{w.treatmentUsed || "—"}</td>
                      <td className="px-4 py-3 text-slate-400">{w.publishedByName}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ══════════ TASKS ══════════ */}
      {tab === "HEALTH" && (
        <DailyChecklistPanel
          businessId={bizId}
          branchCode={businessInfo?.code}
          businessName={businessInfo?.name}
          employees={employees}
          currentUser={currentUser}
          accent="cyan"
          onChanged={() => { refresh(); onRefreshData?.(); }}
        />
      )}

      {/* ══════════ HARVEST ══════════ */}
      {tab === "HARVEST" && (
        <Card title="Harvest Records & Sales" icon={TrendingDown}
          action={
            <div className="flex items-center gap-2">
              <button onClick={() => setShowForm("SALE")} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow">
                + Record Sale
              </button>
              {addBtn(() => setShowForm("HARVEST"), "Record Harvest")}
            </div>
          }>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
                <tr><th className="px-4 py-3">Sack Date</th><th className="px-4 py-3">Species</th><th className="px-4 py-3 text-right">Fish Count</th><th className="px-4 py-3 text-right">Total Weight</th><th className="px-4 py-3 text-right">Avg Wt (kg)</th><th className="px-4 py-3 text-right">Revenue</th><th className="px-4 py-3">Buyer</th><th className="px-4 py-3">By</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {harvests.map((h: any) => (
                  <tr key={h.id} className="hover:bg-slate-700/40">
                    <td className="px-4 py-3 text-slate-400">{h.saleDate}</td>
                    <td className="px-4 py-3 text-slate-200 font-semibold">{h.species}</td>
                    <td className="px-4 py-3 text-right text-slate-300">{h.harvestedCount?.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right font-bold text-white">{h.totalWeightKg?.toLocaleString()} kg</td>
                    <td className="px-4 py-3 text-right text-slate-300">{(h.avgWeightKg || 0).toFixed(2)}</td>
                    <td className="px-4 py-3 text-right font-extrabold text-emerald-400">{formatMoney(h.revenueGhs, currentCurrency)}</td>
                    <td className="px-4 py-3 text-slate-400">{h.buyerName || "—"}</td>
                    <td className="px-4 py-3 text-slate-400">{h.recordedByName}</td>
                  </tr>
                ))}
                {harvests.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">No harvests recorded yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ══════════ FINANCE — complete Financial Report ══════════ */}
      {tab === "FINANCE" && (
        <div className="space-y-4">
          <FinancialReportSection
            mode="business"
            businessInfo={businessInfo}
            businessMetric={businessMetrics}
            transactions={transactions}
            inventory={inventory}
            currentCurrency={currentCurrency}
            accent="sky"
            testid="fin-report-aqua"
            aiModuleKey="AQUA"
            opsLinks={[
              {
                label: "Harvests",
                value: `${harvests.length} (${harvests.reduce((s: number, h: any) => s + (h.totalWeightKg || 0), 0).toLocaleString()} kg)`,
                note: "Each harvest sale posts revenue here automatically",
                tone: "emerald",
              },
              {
                label: "Growing batches",
                value: String(growingBatches.length),
                tone: "sky",
              },
              {
                label: "Feed spend",
                value: formatMoney(feedLogs.reduce((s: number, f: any) => s + (f.totalCostGhs || 0), 0), currentCurrency, true),
                note: "Logged feed cost across all ponds",
                tone: "amber",
              },
            ]}
          />
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat label="Revenue Today" value={formatMoney(revenueToday, currentCurrency, true)} icon={TrendingUp} />
            <Stat label="Expenses Today" value={formatMoney(expensesToday, currentCurrency, true)} color="rose" icon={TrendingDown} />
            <Stat label="Net Profit" value={formatMoney(netProfit, currentCurrency, true)} color={netProfit >= 0 ? "emerald" : "rose"} icon={Wallet} />
            <Stat label="Feed Cost" value={formatMoney(feedLogs.reduce((s: any, f: any) => s + (f.totalCostGhs || 0), 0), currentCurrency, true)} color="amber" icon={Boxes} />
            <Stat label="Assets" value={formatMoney(branchAssets.reduce((s: any, a: any) => s + (a.currentValueGhs || 0), 0), currentCurrency, true)} color="purple" icon={Activity} />
            <Stat label="Staff" value={branchEmployees.length} sub="on this branch" color="blue" icon={Activity} />
          </div>
          <Card title="Branch Financial Transactions — Linked to GoMina Finance" icon={Wallet}>
            <div className="overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px] sticky top-0">
                  <tr>
                    <th className="px-4 py-3">Trx # / Date</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Recorded By</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/60">
                  {branchTrx.slice(0, 20).map((t: any) => (
                    <tr key={t.id} className="hover:bg-slate-700/40">
                      <td className="px-4 py-3"><div className="font-mono text-[10px] text-emerald-400">{t.transactionNumber}</div><div className="text-[10px] text-slate-500">{t.createdAt ? new Date(t.createdAt).toLocaleString() : t.date}</div></td>
                      <td className="px-4 py-3 text-slate-200">{t.category}</td>
                      <td className="px-4 py-3 text-slate-400">{t.recordedBy} {t.recordedByRole && <span className="text-[9px] text-cyan-400">({t.recordedByRole})</span>}</td>
                      <td className={`px-4 py-3 text-right font-extrabold ${t.type === "INCOME" ? "text-emerald-400" : "text-rose-400"}`}>
                        {t.type === "INCOME" ? "+" : "-"}{" "}
                        {formatMoney(t.amountGhs, currentCurrency)}
                      </td>
                    </tr>
                  ))}
                  {branchTrx.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-400">No transactions on this branch yet.</td></tr>}\n                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* ══════════ FORMS ══════════ */}
      {showForm && (
        <AquacultureForm type={showForm} busy={busy} error={err} ponds={ponds} batches={batches} inventory={branchInventory}
          onClose={() => { setShowForm(null); setErr(""); }}
          onSubmit={submit}
        />
      )}

      <ExpenseEntryForm
        isOpen={showExpense}
        onClose={() => setShowExpense(false)}
        onSaved={() => { setShowExpense(false); refresh(); onRefreshData(); }}
        businessId={bizId}
        branchCode={businessInfo?.code}
        branchName={businessInfo?.name}
        businessName={businessInfo?.name}
        currentUser={currentUser}
        title="Record Expense — Aquaculture"
        contextLabel="Aquaculture"
        vendorPlaceholder="e.g. fish feed supplier"
        defaultCategory="Feed Purchase"
        defaultCategories={[
          { value: "Feed Purchase", label: "🌾 Feed Purchase" },
          { value: "Fingerlings & Seed", label: "🐟 Fingerlings & Seed" },
          { value: "Water Treatment", label: "💧 Water Treatment" },
          { value: "Electricity", label: "⚡ Electricity" },
          { value: "Fuel", label: "⛽ Fuel" },
          { value: "Labor", label: "👷 Labor" },
          { value: "Transport", label: "🚛 Transport" },
          { value: "Net & Cage Repair", label: "🔧 Net & Cage Repair" },
          { value: "Miscellaneous", label: "📋 Miscellaneous" },
        ]}
        testid="aqua-expense"
      />

      <ConfirmActionModal
        open={!!confirmEntry && !!confirmView}
        title={confirmView?.title || ""}
        message={confirmView?.message || ""}
        details={confirmView?.details || []}
        tone={confirmView?.tone || "rose"}
        confirmLabel={confirmView?.confirmLabel}
        onCancel={() => setConfirmEntry(null)}
        onConfirm={() => {
          const c = confirmEntry;
          setConfirmEntry(null);
          if (c) performSubmit(c.entity, c.data);
        }}
        testid="aqua-confirm-entry"
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
//  Form component
// ────────────────────────────────────────────────────────────────────────────
function FormField({ f, set, label, k, t = "text", ...rest }: any) {
  return (
    <div>
      <label className="block text-[10px] font-semibold text-slate-400 mb-1">{label}</label>
      <input type={t} value={f[k] ?? ""} onChange={(e) => set(k, t === "number" ? Number(e.target.value) : e.target.value)}
        className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs" {...rest} />
    </div>
  );
}
function FormSelect({ f, set, label, k, opts }: any) {
  return (
    <div>
      <label className="block text-[10px] font-semibold text-slate-400 mb-1">{label}</label>
      <select value={f[k] ?? ""} onChange={(e) => set(k, e.target.value)}
        className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs">
        {opts.map((o: any) => <option key={o.v ?? o} value={o.v ?? o}>{o.l ?? o}</option>)}
      </select>
    </div>
  );
}

function PondSelect({ ponds, f, set }: any) {
  return (
    <FormSelect f={f} set={set} label="Pond / Tank / Cage" k="pondId"
      opts={[
        { v: "", l: "— Select pond —" },
        ...ponds.map((p: any) => ({ v: p.id, l: `${p.name} (${p.pondId})` })),
      ]}
    />
  );
}

function BatchSelect({ batches, f, set }: any) {
  return (
    <FormSelect f={f} set={set} label="Batch / Stock" k="batchId"
      opts={[
        { v: "", l: "— Select batch —" },
        ...batches.map((b: any) => ({ v: b.id, l: `${b.batchNumber} (${b.species})` })),
      ]}
    />
  );
}

function AquacultureForm({ type, ponds, batches, inventory = [], busy, error, onClose, onSubmit }: any) {
  const [f, setF] = useState<any>({
    type: "CAGE",
    status: "ACTIVE",
    species: "VOLTA_TILAPIA",
    strainGenetics: "",
    entryType: "CONSUMPTION",
    turbidity: "CLEAR",
    buyerName: "",
    paymentMethod: "CASH",
    saleDate: new Date().toISOString().split("T")[0],
  });
  const set = (k: string, v: any) => setF({ ...f, [k]: v });

  const titles: Record<string, string> = {
    POND: "Create New Pond / Cage / Tank",
    BATCH: "Register Fish Batch",
    FEED: "Log Feed Entry",
    WATER: "Record Water Sample",
    HARVEST: "Record Fish Harvest",
    CHECKLIST: "Generate Checklist",
    SALE: "Record Sale — Fresh Fish Stock",
  };
  const entities: Record<string, string> = {
    POND: "POND",
    BATCH: "BATCH",
    FEED: "FEED",
    WATER: "WATER",
    HARVEST: "HARVEST",
    CHECKLIST: "CHECKLIST",
    SALE: "SALE",
  };
  const sellable = (inventory || []).filter((i: any) => (i.quantity || 0) > 0);



  const handle = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(entities[type], f);
  };

  const today = new Date().toISOString().split("T")[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-slate-800 p-5">
          <h3 className="text-lg font-bold text-white">{titles[type]}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handle} className="overflow-y-auto p-5 space-y-4 flex-1">
          {error && <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-3 rounded-lg text-xs">{error}</div>}

          {type === "POND" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <FormField f={f} set={set} label="Name" k="name" placeholder="e.g. Akosombo Cage 5" required />
                <FormField f={f} set={set} label="Pond ID" k="pondId" placeholder="Auto if blank" />
                <FormSelect f={f} set={set} label="Type" k="type" opts={["CAGE", "POND", "TANK", "BIOFLOC", "EARTH_POND"]} />
                <FormField f={f} set={set} label="Capacity (Liters)" k="capacityLiters" t="number" required min={100} />
                <FormField f={f} set={set} label="Initial Biomass (kg)" k="currentBiomassKg" t="number" min={0} />
              </div>
              <FormField f={f} set={set} label="Notes" k="notes" placeholder="Optional notes" />
            </>
          )}

          {type === "BATCH" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <FormField f={f} set={set} label="Batch Number" k="batchNumber" placeholder="Auto if blank" />
                <FormSelect f={f} set={set} label="Species" k="species" opts={["VOLTA_TILAPIA", "AFRICAN_CATFISH", "RED_TILAPIA", "HYBRID_TILAPIA"]} />
                <FormField f={f} set={set} label="Strain / Genetics" k="strainGenetics" placeholder="e.g. Local Strain" />
                <FormField f={f} set={set} label="Hatch Date" k="hatchDate" t="date" />
                <FormField f={f} set={set} label="Initial Count *" k="initialCount" t="number" required min={1} />
                <FormField f={f} set={set} label="Avg Weight (g)" k="avgWeightGrams" t="number" min={0} />
              </div>
              <PondSelect ponds={ponds} f={f} set={set} />
              <div className="grid grid-cols-2 gap-3">
                <FormField f={f} set={set} label="Target Harvest Date" k="targetHarvestDate" t="date" />
                <FormField f={f} set={set} label="Current Count" k="currentCount" t="number" min={0} placeholder="Defaults to initial" />
              </div>
            </>
          )}

          {type === "FEED" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <FormSelect f={f} set={set} label="Entry Type" k="entryType" opts={[{ v: "CONSUMPTION", l: "Consumed (used)" }, { v: "PURCHASE", l: "Purchase (stock in)" }]} />
                <FormSelect f={f} set={set} label="Feed Type" k="feedType" opts={["FLOATING", "SINKING", "STARTER", "GROWER", "FINISHER"]} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormField f={f} set={set} label="Quantity (kg) *" k="quantityKg" t="number" step="0.1" required min={0.1} />
                <FormField f={f} set={set} label="Cost per kg (GH₵)" k="costPerKgGhs" t="number" step="0.01" />
              </div>
              <PondSelect ponds={ponds} f={f} set={set} />
              <BatchSelect batches={batches} f={f} set={set} />
              <div className="grid grid-cols-2 gap-3">
                <FormField f={f} set={set} label="Supplier / Brand" k="brandSupplier" placeholder="e.g. Akosombo Feeds" />
                <FormField f={f} set={set} label="Date" k="recordedDate" t="date" defaultValue={today} />
              </div>
            </>
          )}

          {type === "WATER" && (
            <>
              <PondSelect ponds={ponds} f={f} set={set} />
              <div className="grid grid-cols-2 gap-3">
                <FormField f={f} set={set} label="Date" k="sampleDate" t="date" defaultValue={today} />
                <FormField f={f} set={set} label="Volume (L)" k="waterLiters" t="number" min={0} />
                <FormField f={f} set={set} label="pH *" k="phLevel" t="number" step="0.1" required min={3} max={11} />
                <FormField f={f} set={set} label="Dissolved O₂ (mg/L) *" k="dissolvedOxygenMgL" t="number" step="0.1" required min={0} max={20} />
                <FormField f={f} set={set} label="Temperature (°C)" k="temperatureC" t="number" step="0.1" />
                <FormField f={f} set={set} label="Ammonia (mg/L)" k="ammoniaMgL" t="number" step="0.01" min={0} />
                <FormSelect f={f} set={set} label="Turbidity" k="turbidity" opts={["CLEAR", "MODERATE", "HIGH"]} />
                <FormField f={f} set={set} label="Nitrate (mg/L)" k="nitrateMgL" t="number" step="0.1" min={0} />
              </div>
              <FormField f={f} set={set} label="Treatment Used" k="treatmentUsed" placeholder="e.g. Chlorine + Probiotic" />
            </>
          )}

          {type === "HARVEST" && (
            <>
              <PondSelect ponds={ponds} f={f} set={set} />
              <BatchSelect batches={batches} f={f} set={set} />
              <div className="grid grid-cols-2 gap-3">
                <FormField f={f} set={set} label="Harvest Date" k="saleDate" t="date" defaultValue={today} />
                <FormSelect f={f} set={set} label="Species" k="species" opts={["VOLTA_TILAPIA", "AFRICAN_CATFISH", "RED_TILAPIA", "HYBRID_TILAPIA"]} />
                <FormField f={f} set={set} label="Fish Count *" k="harvestedCount" t="number" required min={1} />
                <FormField f={f} set={set} label="Total Weight (kg) *" k="totalWeightKg" t="number" step="0.1" required min={0.1} />
                <FormField f={f} set={set} label="Revenue (GH₵)" k="revenueGhs" t="number" step="0.01" min={0} />
                <FormField f={f} set={set} label="Buyer Name" k="buyerName" placeholder="e.g. Labadi Hotel" />
              </div>
              <FormField f={f} set={set} label="Notes" k="notes" placeholder="Optional notes" />
            </>
          )}

          {type === "SALE" && (
            <>
              {(() => {
                const sel = sellable.find((i: any) => String(i.id) === String(f.inventoryId));
                return (<>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1">Product (from available stock) *</label>
                    <select required value={f.inventoryId ?? ""} onChange={(e) => {
                      const it = sellable.find((x: any) => String(x.id) === e.target.value);
                      setF((prev: any) => ({ ...prev, inventoryId: e.target.value, sellingPrice: it ? it.sellingPriceGhs : prev.sellingPrice }));
                    }} className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs">
                      <option value="">{sellable.length ? "— select product —" : "— no stock available: record a harvest first —"}</option>
                      {sellable.map((i: any) => (
                        <option key={i.id} value={i.id}>{i.name} — {i.quantity} {i.unit} available @ GH₵{i.sellingPriceGhs}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-400 mb-1">Quantity * {sel ? <span className="text-slate-500">(max {sel.quantity} {sel.unit})</span> : null}</label>
                      <input type="number" required min={0.01} step="any" max={sel?.quantity || undefined} value={f.quantity ?? ""} onChange={(e) => set("quantity", Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs" />
                    </div>
                    <FormField f={f} set={set} label="Unit Price (GH₵)" k="sellingPrice" t="number" step="0.01" placeholder={sel ? String(sel.sellingPriceGhs) : "Auto from stock"} />
                  </div>
                  {sel && f.quantity ? (
                    <div className="text-[11px] text-cyan-300 bg-cyan-500/10 border border-cyan-500/30 rounded-lg px-3 py-2">
                      Total: <b>GH₵ {(((Number(f.sellingPrice) || sel.sellingPriceGhs) || 0) * Number(f.quantity)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>
                      {" "}— stock will drop to {(sel.quantity - Number(f.quantity)).toLocaleString()} {sel.unit}; revenue & profit update instantly.
                    </div>
                  ) : null}
                  <div className="grid grid-cols-2 gap-3">
                    <FormField f={f} set={set} label="Customer Name" k="customerName" placeholder="Walk-in Customer" />
                    <FormField f={f} set={set} label="Customer Phone" k="customerPhone" placeholder="024…" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <FormSelect f={f} set={set} label="Payment Method" k="paymentMethod" opts={["CASH", "MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER", "CARD"]} />
                    <FormField f={f} set={set} label="Price Override Reason" k="customPriceReason" placeholder="Only if price changed" />
                  </div>
                  <FormField f={f} set={set} label="Notes" k="notes" placeholder="Optional" />
                </>);
              })()}
            </>
          )}

          <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold">Cancel</button>
            <button type="submit" disabled={busy} className="px-5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold disabled:opacity-50">
              {busy ? "Saving..." : "Save Record"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Fix unused variables
const CheckCircle = ({ className }: any) => <svg className={className} fill="currentColor" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" /></svg>;
const Circle = ({ className }: any) => <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /></svg>;

const Activity2 = Activity;
