"use client";

import React, { useMemo, useState } from "react";
import AiSectionGuide from "./AiSectionGuide";
import {
  AlertTriangle, BadgeDollarSign, Boxes, Building2, CheckCircle, ClipboardCheck,
  Cpu, Droplets, Egg, Fish, LayoutDashboard, Loader2, MapPin, Package, PackagePlus,
  Phone, Plus, ShoppingCart, TrendingDown, TrendingUp, Users, Utensils, Wallet,
  Activity, X, Beef, BarChart3, ExternalLink, Sparkles, HardHat,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, PieChart, Pie, Cell,
} from "recharts";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import DailyChecklistPanel from "./DailyChecklistPanel";
import FinancialReportSection from "./FinancialReportSection";

interface Props {
  currentUser: any;
  businessInfo: any;
  businessMetrics: any;
  inventory: any[];
  transactions: any[];
  assets: any[];
  employees: any[];
  customers: any[];
  businesses: any[];
  currentCurrency: CurrencyCode;
  onRefreshData: () => void;
  onSelectTab?: (tab: string) => void;
}

type Tab = "DASHBOARD" | "INVENTORY" | "FINANCE" | "CHECKLIST";
type FormType = "SALE" | "RESTOCK" | "EXPENSE" | "ITEM" | "OPS" | null;

// ─── Category operating profiles ─────────────────────────────────────
// Static Tailwind class strings (no dynamic interpolation → always compiled).
const CATEGORY_CFG: Record<string, any> = {
  "Poultry Farm": {
    accent: "amber", icon: Egg,
    badgeCls: "bg-amber-500/20 text-amber-300 border-amber-500/30",
    iconCls: "bg-amber-500/20 border-amber-400/30 text-amber-400",
    gradCls: "from-slate-900 via-amber-950/40 to-slate-900",
    saleBtn: "bg-amber-600 hover:bg-amber-500",
    tabActive: "bg-amber-600",
    opsLabel: "Egg Collection / Production Log",
    opsUnit: "crates", opsQtyLabel: "Crates collected",
    opsHint: "Log egg collections, feed issues, mortality checks and daily farm work.",
    productRe: /egg|poultry|bird|broiler|layer|chicken|feed/i,
  },
  "Block Factory": {
    accent: "cyan", icon: Boxes,
    badgeCls: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
    iconCls: "bg-cyan-500/20 border-cyan-400/30 text-cyan-400",
    gradCls: "from-slate-900 via-cyan-950/40 to-slate-900",
    saleBtn: "bg-cyan-600 hover:bg-cyan-500",
    tabActive: "bg-cyan-600",
    opsLabel: "Block Production Log",
    opsUnit: "blocks", opsQtyLabel: "Blocks molded",
    opsHint: "Log molding batches, machine checks, curing and yard work.",
    productRe: /block|brick|paving|cement|sand|quarry/i,
  },
  Aquaculture: {
    accent: "sky", icon: Fish,
    badgeCls: "bg-sky-500/20 text-sky-300 border-sky-500/30",
    iconCls: "bg-sky-500/20 border-sky-400/30 text-sky-400",
    gradCls: "from-slate-900 via-sky-950/40 to-slate-900",
    saleBtn: "bg-sky-600 hover:bg-sky-500",
    tabActive: "bg-sky-600",
    opsLabel: "Feeding / Harvest Log",
    opsUnit: "kg", opsQtyLabel: "Quantity (kg)",
    opsHint: "Log feeding rounds, water checks, pond maintenance and harvests.",
    productRe: /fish|tilapia|catfish|fingerling|aqua|feed/i,
  },
  Livestock: {
    accent: "orange", icon: Beef,
    badgeCls: "bg-orange-500/20 text-orange-300 border-orange-500/30",
    iconCls: "bg-orange-500/20 border-orange-400/30 text-orange-400",
    gradCls: "from-slate-900 via-orange-950/40 to-slate-900",
    saleBtn: "bg-orange-600 hover:bg-orange-500",
    tabActive: "bg-orange-600",
    opsLabel: "Herd / Milking Activity Log",
    opsUnit: "animals", opsQtyLabel: "Animals handled",
    opsHint: "Log herd counts, milking, grazing moves, health checks and vaccinations.",
    productRe: /cattle|beef|goat|sheep|milk|livestock|feed/i,
  },
  "Restaurant & Food": {
    accent: "rose", icon: Utensils,
    badgeCls: "bg-rose-500/20 text-rose-300 border-rose-500/30",
    iconCls: "bg-rose-500/20 border-rose-400/30 text-rose-400",
    gradCls: "from-slate-900 via-rose-950/40 to-slate-900",
    saleBtn: "bg-rose-600 hover:bg-rose-500",
    tabActive: "bg-rose-600",
    opsLabel: "Kitchen Prep / Service Log",
    opsUnit: "plates", opsQtyLabel: "Plates prepared",
    opsHint: "Log prep batches, service rushes, stock usage and hygiene work.",
    productRe: /rice|jollof|banku|meal|plate|food|oil|chicken|tilapia|kitchen/i,
  },
  "Electronic Shop": {
    accent: "violet", icon: Cpu,
    badgeCls: "bg-violet-500/20 text-violet-300 border-violet-500/30",
    iconCls: "bg-violet-500/20 border-violet-400/30 text-violet-400",
    gradCls: "from-slate-900 via-violet-950/40 to-slate-900",
    saleBtn: "bg-violet-600 hover:bg-violet-500",
    tabActive: "bg-violet-600",
    opsLabel: "Repair / Service Job Log",
    opsUnit: "jobs", opsQtyLabel: "Jobs completed",
    opsHint: "Log repairs, diagnostics, unlocks and customer service work.",
    productRe: /phone|laptop|solar|inverter|battery|cable|earbud|tech|electronic/i,
  },
  "Car Wash": {
    accent: "teal", icon: Droplets,
    badgeCls: "bg-teal-500/20 text-teal-300 border-teal-500/30",
    iconCls: "bg-teal-500/20 border-teal-400/30 text-teal-400",
    gradCls: "from-slate-900 via-teal-950/40 to-slate-900",
    saleBtn: "bg-teal-600 hover:bg-teal-500",
    tabActive: "bg-teal-600",
    opsLabel: "Wash Job Log",
    opsUnit: "vehicles", opsQtyLabel: "Vehicles serviced",
    opsHint: "Log washes, detailing, waxing and bay maintenance work.",
    productRe: /wash|wax|shampoo|detail|car/i,
  },
  "Hardware Store": {
    accent: "amber", icon: HardHat,
    badgeCls: "bg-amber-500/20 text-amber-300 border-amber-500/30",
    iconCls: "bg-amber-500/20 border-amber-400/30 text-amber-400",
    gradCls: "from-slate-900 via-amber-950/40 to-slate-900",
    saleBtn: "bg-amber-600 hover:bg-amber-500",
    tabActive: "bg-amber-600",
    opsLabel: "Goods Received Log",
    opsUnit: "units", opsQtyLabel: "Units received",
    opsHint: "Log supplier receipts, stock-takes and yard dispatch work.",
    productRe: /cement|rod|iron|steel|nail|paint|roof|pipe|sand|aggregate|timber|board|block|wire|hardware|tool|drill|mixer|built|construct/i,
  },
  _default: {
    accent: "emerald", icon: Building2,
    badgeCls: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    iconCls: "bg-emerald-500/20 border-emerald-400/30 text-emerald-400",
    gradCls: "from-slate-900 via-emerald-950/40 to-slate-900",
    saleBtn: "bg-emerald-600 hover:bg-emerald-500",
    tabActive: "bg-emerald-600",
    opsLabel: "Daily Activity Log",
    opsUnit: "units", opsQtyLabel: "Quantity",
    opsHint: "Log your daily operational work and milestones.",
    productRe: /.*/,
  },
};

const CHART_COLORS = ["#10b981", "#06b6d4", "#f59e0b", "#8b5cf6", "#f43f5e", "#84cc16"];

export default function BusinessDashboardModule({
  currentUser, businessInfo, businessMetrics, inventory, transactions, assets,
  employees, customers, businesses, currentCurrency, onRefreshData, onSelectTab,
}: Props) {
  const cfg = CATEGORY_CFG[businessInfo?.category] || CATEGORY_CFG._default;
  const Icon = cfg.icon;
  const bizId = businessInfo?.id;
  const today = new Date().toISOString().split("T")[0];
  const thisMonth = today.slice(0, 7);

  const [tab, setTab] = useState<Tab>("DASHBOARD");
  const [showForm, setShowForm] = useState<FormType>(null);
  const [restockItemId, setRestockItemId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [gettingStartedOpen, setGettingStartedOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem(`gomina-unit-ready-${bizId}`) !== "done";
  });

  // ── Scoped data — everything for THIS branch only ──
  const branchInventory = useMemo(() => inventory.filter((i) => i.businessId === bizId), [inventory, bizId]);
  const branchTx = useMemo(() => transactions.filter((t) => t.businessId === bizId), [transactions, bizId]);
  const branchAssets = useMemo(() => assets.filter((a) => a.businessId === bizId), [assets, bizId]);
  const branchEmployees = useMemo(() => employees.filter((e) => e.businessId === bizId), [employees, bizId]);

  const income = branchTx.filter((t) => t.type === "INCOME");
  const expenses = branchTx.filter((t) => t.type === "EXPENSE");
  const opsLogs = branchTx.filter((t) => t.type === "OPS_LOG").sort((a, b) => (b.id || 0) - (a.id || 0));
  const revenue = income.reduce((s, t) => s + (t.amountGhs || 0), 0);
  const expenseTotal = expenses.reduce((s, t) => s + (t.amountGhs || 0), 0);
  const revenueToday = income.filter((t) => t.date === today).reduce((s, t) => s + (t.amountGhs || 0), 0);
  const expensesToday = expenses.filter((t) => t.date === today).reduce((s, t) => s + (t.amountGhs || 0), 0);
  const mtdRevenue = income.filter((t) => String(t.date || "").startsWith(thisMonth)).reduce((s, t) => s + (t.amountGhs || 0), 0);
  const opsToday = opsLogs.filter((t) => t.date === today).reduce((s, t) => {
    const m = /—\s*([\d.,]+)/.exec(t.description || "");
    return s + (m ? parseFloat(m[1].replace(/,/g, "")) || 0 : 0);
  }, 0);

  const stockUnits = branchInventory.reduce((s, i) => s + (i.quantity || 0), 0);
  const stockCostValue = branchInventory.reduce((s, i) => s + (i.quantity || 0) * (i.costPriceGhs || 0), 0);
  const stockRetailValue = branchInventory.reduce((s, i) => s + (i.quantity || 0) * (i.sellingPriceGhs || 0), 0);
  const lowStock = branchInventory.filter((i) => i.status !== "IN_STOCK" || (i.quantity || 0) <= (i.minStockThreshold || 0));
  const products = branchInventory.filter((i) => cfg.productRe.test(`${i.name} ${i.category}`));
  const starterKitActive = branchTx.filter((t) => t.type !== "OPS_LOG").length === 0;

  const alerts = [
    ...lowStock.map((i) => ({
      level: i.status === "OUT_OF_STOCK" || (i.quantity || 0) <= 0 ? "critical" : "warning",
      msg: `${i.name} — ${(i.quantity || 0) <= 0 ? "out of stock" : "low stock"} (${i.quantity} ${i.unit}, threshold ${i.minStockThreshold})`,
    })),
    ...(businessMetrics && businessMetrics.monthlyTargetRevenueGhs > 0 && mtdRevenue < businessMetrics.monthlyTargetRevenueGhs * 0.25 && new Date().getDate() > 20
      ? [{ level: "warning", msg: `Month-to-date revenue ${formatMoney(mtdRevenue, currentCurrency, true)} is behind target pace` }]
      : []),
  ] as { level: string; msg: string }[];

  // Charts (last 14 active days)
  const chart = useMemo(() => {
    const inc: Record<string, number> = {};
    const exp: Record<string, number> = {};
    income.forEach((t) => { inc[t.date] = (inc[t.date] || 0) + (t.amountGhs || 0); });
    expenses.forEach((t) => { exp[t.date] = (exp[t.date] || 0) + (t.amountGhs || 0); });
    const dates = Array.from(new Set([...Object.keys(inc), ...Object.keys(exp)])).sort().slice(-14);
    return dates.map((d) => ({ date: d.slice(5), Revenue: inc[d] || 0, Expenses: exp[d] || 0 }));
  }, [income, expenses]);

  const stockByCategory = useMemo(() => {
    const map: Record<string, number> = {};
    branchInventory.forEach((i) => { map[i.category || "General"] = (map[i.category || "General"] || 0) + (i.quantity || 0) * (i.costPriceGhs || 0); });
    return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [branchInventory]);

  const recentActivity = useMemo(
    () => [...branchTx].sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 10),
    [branchTx]
  );

  const submit = async (entity: FormType, f: any) => {
    setBusy(true); setError(""); setNotice("");
    const meta = {
      businessId: bizId,
      branchCode: businessInfo?.code,
      branchName: businessInfo?.name,
      recordedBy: currentUser?.name,
      recordedByRole: currentUser?.role,
      recordedByUserId: currentUser?.id,
    };
    try {
      let url = "/api/branch-unit";
      // Form types map to API entities: OPS (the modal) logs as OPS_LOG
      let body: any = { entity: entity === "OPS" ? "OPS_LOG" : entity, data: { ...f, ...meta } };
      if (entity === "SALE") {
        url = "/api/sales";
        body = {
          businessId: bizId,
          branchCode: businessInfo?.code,
          customerName: f.customerName,
          customerPhone: f.customerPhone,
          paymentMethod: f.paymentMethod,
          notes: f.notes,
          discount: Number(f.discount) || 0,
          discountPercent: f.discountPct ? Number(f.discountPct) : undefined,
          cartItems: [{
            inventoryId: Number(f.inventoryId),
            quantity: Number(f.quantity),
            sellingPrice: f.sellingPrice ? Number(f.sellingPrice) : undefined,
            originalPrice: f.sellingPrice ? Number(f.sellingPrice) : undefined,
            customPriceReason: f.customPriceReason,
          }],
          createdByUserId: currentUser?.id,
          createdByName: currentUser?.name,
          createdByRole: currentUser?.role,
        };
      } else if (entity === "ITEM") {
        url = "/api/enterprise";
        body = { entityType: "inventory", data: { ...f, businessId: bizId } };
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || "Failed to save");
      setNotice(
        entity === "SALE" ? `Sale recorded — stock deducted, revenue posted to Finance.` :
        entity === "RESTOCK" ? `Stock received${d.expense ? " and expense booked" : ""} — inventory updated.` :
        entity === "EXPENSE" ? "Expense posted to Finance." :
        entity === "OPS" ? `${cfg.opsLabel} saved to today's activities.` :
        "Inventory item created."
      );
      setShowForm(null);
      setRestockItemId(null);
      await onRefreshData();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const TABS: { key: Tab; label: string; icon: any }[] = [
    { key: "DASHBOARD", label: "Dashboard", icon: LayoutDashboard },
    { key: "INVENTORY", label: "Inventory", icon: Boxes },
    { key: "FINANCE", label: "Finance", icon: Wallet },
    { key: "CHECKLIST", label: "Daily Checklist", icon: ClipboardCheck },
  ];

  const Stat = ({ label, value, sub, tone = "text-emerald-400", icon: StatIcon }: any) => (
    <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4">
      <div className="flex items-center justify-between text-[10px] uppercase font-bold text-slate-400">
        <span>{label}</span>{StatIcon && <StatIcon className="w-4 h-4 text-slate-500" />}
      </div>
      <div className={`text-xl font-black mt-1 ${tone}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );

  const Card = ({ title, icon: CardIcon, children, action }: any) => (
    <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl">
      <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">{CardIcon && <CardIcon className="w-5 h-5 text-emerald-400" />}<h3 className="text-base font-bold text-white">{title}</h3></div>
        {action}
      </div>
      {children}
    </div>
  );

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-[1600px] mx-auto text-slate-100">
      {/* ── Header ── */}
      <div className={`bg-gradient-to-r ${cfg.gradCls} p-5 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4`}>
        <div className="flex items-start gap-3">
          <div className={`w-12 h-12 rounded-xl border flex items-center justify-center shrink-0 ${cfg.iconCls}`}>
            <Icon className="w-6 h-6" />
          </div>
          <div>
            <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold border ${cfg.badgeCls}`}>
              {(businessInfo?.category || "BUSINESS").toUpperCase()} • AUTO-PROVISIONED UNIT
            </span>
            <h2 className="text-xl sm:text-2xl font-extrabold text-white mt-1">{businessInfo?.name}</h2>
            <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5">
              <Building2 className="w-3 h-3" />{businessInfo?.code}
              <span className="inline-flex items-center gap-1 ml-2"><MapPin className="w-3 h-3" />{[businessInfo?.town, businessInfo?.district, businessInfo?.region].filter(Boolean).join(", ")}</span>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setShowForm("SALE")} className={`px-3 py-2 rounded-lg ${cfg.saleBtn} text-white text-xs font-bold flex items-center gap-1`}><BadgeDollarSign className="w-3.5 h-3.5" />Sale</button>
          <button onClick={() => setShowForm("OPS")} className="px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold flex items-center gap-1"><Activity className="w-3.5 h-3.5" />{cfg.opsLabel.split(" ")[0]} Log</button>
          <button onClick={() => setShowForm("RESTOCK")} className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><PackagePlus className="w-3.5 h-3.5" />Restock</button>
          <button onClick={() => setShowForm("EXPENSE")} className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold flex items-center gap-1"><Wallet className="w-3.5 h-3.5" />Expense</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-1 bg-slate-800/90 border border-slate-700/80 p-1.5 rounded-xl">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition ${
              tab === t.key ? `${cfg.tabActive} text-white shadow` : "text-slate-300 hover:bg-slate-700/70"}`}>
            <t.icon className="w-4 h-4" />
            <span className="text-[10px] leading-none lg:leading-normal lg:text-xs">{t.label}</span>
          </button>
        ))}
        <div className="ml-auto hidden md:flex items-center gap-2 px-2">
          {onSelectTab && (
            <>
              <button onClick={() => onSelectTab("COMMAND_CENTER")} className="text-[10px] text-slate-400 hover:text-emerald-300 flex items-center gap-1"><ExternalLink className="w-3 h-3" />Command Center</button>
              <button onClick={() => onSelectTab("INVENTORY")} className="text-[10px] text-slate-400 hover:text-emerald-300 flex items-center gap-1"><ExternalLink className="w-3 h-3" />Enterprise Inventory</button>
              <button onClick={() => onSelectTab("TRANSACTIONS")} className="text-[10px] text-slate-400 hover:text-emerald-300 flex items-center gap-1"><ExternalLink className="w-3 h-3" />Transactions</button>
              <button onClick={() => onSelectTab("SALES_CENTER")} className="text-[10px] text-slate-400 hover:text-emerald-300 flex items-center gap-1"><ExternalLink className="w-3 h-3" />Sales &amp; Payments</button>
            </>
          )}
        </div>
      </div>

      {error && <div className="px-4 py-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs"><AlertTriangle className="w-4 h-4 inline mr-1" />{error}</div>}
      {notice && <div className="px-4 py-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs"><CheckCircle className="w-4 h-4 inline mr-1" />{notice}</div>}

      {/* ══════════════ DASHBOARD ══════════════ */}
      {tab === "DASHBOARD" && (
        <div className="space-y-5">
          {/* Getting-started banner (dismissible) — proves the unit was auto-provisioned */}
          {gettingStartedOpen && (
            <div className="bg-gradient-to-r from-emerald-500/10 via-slate-800 to-slate-800 border border-emerald-500/30 rounded-2xl p-4 flex flex-col md:flex-row md:items-center gap-3">
              <Sparkles className="w-6 h-6 text-emerald-400 shrink-0" />
              <div className="flex-1">
                <div className="text-sm font-bold text-emerald-300">Your {businessInfo?.category} workspace was auto-provisioned — nothing is blank here.</div>
                <p className="text-xs text-slate-400 mt-0.5">
                  Starter stock kit loaded ({branchInventory.length} items worth {formatMoney(stockCostValue, currentCurrency, true)} at cost) • {cfg.opsLabel} ready • specialized daily checklist installed • live finance, alerts &amp; reports connected.
                  Try it: record a <button className="text-emerald-300 underline font-semibold" onClick={() => setShowForm("SALE")}>Sale</button>, receive <button className="text-emerald-300 underline font-semibold" onClick={() => setShowForm("RESTOCK")}>Stock</button>, or post an <button className="text-emerald-300 underline font-semibold" onClick={() => setShowForm("EXPENSE")}>Expense</button>.
                </p>
              </div>
              <button onClick={() => { localStorage.setItem(`gomina-unit-ready-${bizId}`, "done"); setGettingStartedOpen(false); }} className="self-start md:self-center text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
          )}

          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <Stat label="Revenue (all-time)" value={formatMoney(revenue, currentCurrency, true)} sub={`${income.length} sales`} tone="text-emerald-400" icon={TrendingUp} />
            <Stat label="Expenses (all-time)" value={formatMoney(expenseTotal, currentCurrency, true)} sub={`${expenses.length} postings`} tone="text-rose-400" icon={TrendingDown} />
            <Stat label="Net Position" value={formatMoney(revenue - expenseTotal, currentCurrency, true)} sub={revenue - expenseTotal >= 0 ? "in profit" : "in deficit"} tone={revenue - expenseTotal >= 0 ? "text-emerald-400" : "text-rose-400"} icon={Wallet} />
            <Stat label="Units on Hand" value={stockUnits.toLocaleString()} sub={`${branchInventory.length} SKUs`} tone="text-cyan-400" icon={Package} />
            <Stat label="Stock Value (cost)" value={formatMoney(stockCostValue, currentCurrency, true)} sub={`${formatMoney(stockRetailValue, currentCurrency, true)} retail`} tone="text-amber-400" icon={BarChart3} />
            <Stat label="Low / Out of Stock" value={lowStock.length} sub={lowStock.length ? "restock required" : "all healthy"} tone={lowStock.length ? "text-rose-400" : "text-emerald-400"} icon={AlertTriangle} />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Today — Revenue" value={formatMoney(revenueToday, currentCurrency, true)} tone="text-emerald-400" />
            <Stat label="Today — Expenses" value={formatMoney(expensesToday, currentCurrency, true)} tone="text-rose-400" />
            <Stat label={`Today — ${cfg.opsUnit}`} value={opsToday.toLocaleString()} sub={cfg.opsLabel} tone="text-sky-400" icon={Activity} />
            <Stat label="Month vs Target" value={`${businessMetrics?.monthlyTargetRevenueGhs ? Math.min(999, Math.round((mtdRevenue / businessMetrics.monthlyTargetRevenueGhs) * 100)) : 0}%`} sub={`${formatMoney(mtdRevenue, currentCurrency, true)} of ${formatMoney(businessMetrics?.monthlyTargetRevenueGhs || 0, currentCurrency, true)}`} tone="text-violet-400" />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            {/* Operations panel — business-type production/ops window */}
            <Card title={cfg.opsLabel} icon={Activity}
              action={<button onClick={() => setShowForm("OPS")} className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-bold flex items-center gap-1"><Plus className="w-3 h-3" />Log</button>}>
              <div className="p-4 space-y-2 max-h-64 overflow-y-auto">
                <p className="text-[10px] text-slate-500">{cfg.opsHint}</p>
                {opsLogs.slice(0, 8).map((o) => (
                  <div key={o.id} className="p-2.5 rounded-lg bg-slate-900/70 border border-slate-700 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-sky-300 font-bold">{o.category}</span>
                      <span className="text-[10px] text-slate-500">{o.date}</span>
                    </div>
                    <div className="text-slate-300 mt-0.5">{o.description}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">by {o.recordedBy}</div>
                  </div>
                ))}
                {opsLogs.length === 0 && (
                  <div className="p-4 text-center">
                    <p className="text-xs text-slate-400 mb-2">No {cfg.opsUnit} logged yet today — start your first entry.</p>
                    <button onClick={() => setShowForm("OPS")} className="px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold">Log first activity</button>
                  </div>
                )}
              </div>
            </Card>

            {/* Live stock position */}
            <Card title="Stock Position" icon={Package}
              action={<button onClick={() => setTab("INVENTORY")} className="text-[11px] text-indigo-300 hover:text-indigo-200 font-semibold">Manage →</button>}>
              <div className="p-4 space-y-2 max-h-64 overflow-y-auto">
                {branchInventory.map((i) => {
                  const warn = i.status !== "IN_STOCK" || (i.quantity || 0) <= (i.minStockThreshold || 0);
                  return (
                    <div key={i.id} className="flex items-center justify-between text-xs p-2 rounded-lg bg-slate-900/70 border border-slate-700">
                      <div className="min-w-0">
                        <div className="text-slate-200 font-semibold truncate">{i.name}</div>
                        <div className="text-[10px] text-slate-500">{i.sku} • {i.category}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className={`font-black ${warn ? "text-amber-300" : "text-cyan-300"}`}>{Number(i.quantity).toLocaleString()} <span className="text-[10px] font-normal text-slate-500">{i.unit}</span></div>
                        <div className={`text-[10px] font-bold ${warn ? "text-amber-400" : "text-emerald-400"}`}>{i.status}</div>
                      </div>
                    </div>
                  );
                })}
                {branchInventory.length === 0 && <p className="text-xs text-slate-500 p-2">No stock items at this branch yet — add one or receive stock.</p>}
              </div>
            </Card>

            {/* Alerts */}
            <Card title="Alerts & Signals" icon={AlertTriangle}>
              <div className="p-4 space-y-2 max-h-64 overflow-y-auto">
                {alerts.length > 0 ? alerts.map((a, i) => (
                  <div key={i} className={`p-3 rounded-lg border text-xs ${a.level === "critical" ? "bg-rose-500/15 border-rose-500/40 text-rose-200" : "bg-amber-500/15 border-amber-500/40 text-amber-200"}`}>
                    <AlertTriangle className="w-4 h-4 inline mr-1" />{a.msg}
                  </div>
                )) : (
                  <div className="p-4 text-center text-emerald-400 text-sm"><CheckCircle className="w-5 h-5 inline mr-2" />All systems normal — stock healthy</div>
                )}
              </div>
            </Card>
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Revenue vs Expenses" icon={TrendingUp}>
              <div className="p-4">
                {chart.length ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={chart}>
                      <XAxis dataKey="date" stroke="#94a3b8" style={{ fontSize: 10 }} />
                      <YAxis stroke="#94a3b8" style={{ fontSize: 10 }} />
                      <Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }} formatter={(v: any) => formatMoney(Number(v), currentCurrency)} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="Revenue" fill="#10b981" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="Expenses" fill="#f43f5e" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[220px] flex flex-col items-center justify-center text-slate-500 text-xs gap-2">
                    <p>No financial activity yet — post a sale or expense and this chart comes alive.</p>
                    <div className="flex gap-2">
                      <button onClick={() => setShowForm("SALE")} className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold">Record Sale</button>
                      <button onClick={() => setShowForm("EXPENSE")} className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold">Record Expense</button>
                    </div>
                  </div>
                )}
              </div>
            </Card>
            <Card title="Stock Value by Category" icon={Boxes}>
              <div className="p-4">
                {stockByCategory.length ? (
                  <div className="flex items-center gap-2">
                    <ResponsiveContainer width="55%" height={220}>
                      <PieChart>
                        <Pie data={stockByCategory} dataKey="value" nameKey="name" outerRadius={80} stroke="#0f172a" strokeWidth={2}>
                          {stockByCategory.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                        </Pie>
                        <Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }} formatter={(v: any) => formatMoney(Number(v), currentCurrency)} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="space-y-1.5 text-xs">
                      {stockByCategory.map((c, i) => (
                        <div key={c.name} className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
                          <span className="text-slate-300">{c.name}</span>
                          <span className="text-slate-500">{formatMoney(c.value, currentCurrency, true)}</span>
                        </div>
                      ))}
        <AiSectionGuide moduleKey="GENERIC" section={tab} businessInfo={businessInfo} />
                    </div>
                  </div>
                ) : (
                  <div className="h-[220px] flex items-center justify-center text-slate-500 text-xs">No stock held yet.</div>
                )}
              </div>
            </Card>
          </div>

          {/* Activities + Branch & Staff + Reports */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <Card title="Recent Activities" icon={Activity}>
              <div className="p-4 space-y-2 max-h-72 overflow-y-auto">
                {recentActivity.length ? recentActivity.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-slate-900/70 border border-slate-700 text-xs">
                    <div className="min-w-0">
                      <div className="text-slate-200 truncate">{t.description}</div>
                      <div className="text-[10px] text-slate-500">{t.date} • {t.category} • {t.recordedBy}</div>
                    </div>
                    <span className={`shrink-0 font-bold ${t.type === "INCOME" ? "text-emerald-300" : t.type === "EXPENSE" ? "text-rose-300" : "text-sky-300"}`}>
                      {t.type === "OPS_LOG" ? "LOG" : `${t.type === "INCOME" ? "+" : "−"}${formatMoney(t.amountGhs, currentCurrency, true)}`}
                    </span>
                  </div>
                )) : (
                  <p className="text-xs text-slate-500 p-2">No activity yet — sales, expenses and {cfg.opsLabel.toLowerCase()} entries appear here instantly.</p>
                )}
              </div>
            </Card>

            <Card title="Branch & Staff" icon={MapPin}>
              <div className="p-4 space-y-2.5 text-xs">
                <Row k="Branch code" v={businessInfo?.code} />
                <Row k="Location" v={[businessInfo?.town, businessInfo?.district].filter(Boolean).join(", ")} />
                <Row k="Region" v={businessInfo?.region} />
                <Row k="Manager" v={businessInfo?.managerName} />
                <Row k="Contact" v={<span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" />{businessInfo?.contactPhone}</span>} />
                <Row k="Status" v={<span className="text-emerald-300 font-bold">{businessInfo?.status}</span>} />
                <Row k="Staff registered" v={<span className="inline-flex items-center gap-1"><Users className="w-3 h-3" />{branchEmployees.length} at branch</span>} />
                <Row k="Assets registered" v={`${branchAssets.length} (${formatMoney(branchAssets.reduce((s, a) => s + (a.currentValueGhs || 0), 0), currentCurrency, true)})`} />
                <Row k="Initial capital" v={formatMoney(businessInfo?.initialCapitalGhs || 0, currentCurrency)} />
                <Row k="Monthly revenue target" v={formatMoney(businessInfo?.monthlyTargetRevenueGhs || 0, currentCurrency)} />
                <Row k="CRM customers (enterprise)" v={`${customers.length}`} />
              </div>
            </Card>

            <Card title="Reports & Enterprise Links" icon={BarChart3}>
              <div className="p-4 space-y-2">
                <p className="text-[10px] text-slate-500">This unit is fully wired into the enterprise — open any consolidated view to see it.</p>
                {[
                  { k: "COMMAND_CENTER", l: "Command Center — enterprise overview", d: "Compare this unit against the whole group" },
                  { k: "SALES_CENTER", l: "Sales & Payments", d: "Receipts, COGS & profit for this branch" },
                  { k: "INVENTORY", l: "Inventory & Stock", d: "Cross-branch stock position" },
                  { k: "TRANSACTIONS", l: "Transactions & MoMo", d: "Full financial ledger" },
                  { k: "CUSTOMERS", l: "Customers & CRM", d: "Buyers captured at this branch" },
                  { k: "AI_ADVISOR", l: "AI Strategic Advisor", d: "Forecasting & recommendations" },
                ].map((r) => (
                  <button key={r.k} onClick={() => onSelectTab?.(r.k)} disabled={!onSelectTab}
                    className="w-full text-left p-2.5 rounded-lg bg-slate-900/70 border border-slate-700 hover:border-emerald-500/40 transition group">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-200 group-hover:text-emerald-300">{r.l}</span>
                      <ExternalLink className="w-3.5 h-3.5 text-slate-500 group-hover:text-emerald-400" />
                    </div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{r.d}</div>
                  </button>
                ))}
                <p className="text-[10px] text-slate-500 pt-1">Export / Audit button (top-right of the app) generates PDF/Excel reports for this branch on demand.</p>
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ══════════════ INVENTORY ══════════════ */}
      {tab === "INVENTORY" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Stock Items" value={branchInventory.length} sub="SKUs at this branch" tone="text-cyan-400" icon={Boxes} />
            <Stat label="Units on Hand" value={stockUnits.toLocaleString()} sub="all items" tone="text-emerald-400" icon={Package} />
            <Stat label="Stock Value (cost)" value={formatMoney(stockCostValue, currentCurrency, true)} sub={`${formatMoney(stockRetailValue, currentCurrency, true)} at retail`} tone="text-amber-400" icon={Wallet} />
            <Stat label="Low / Out of Stock" value={lowStock.length} sub={lowStock.length ? "restock required" : "all healthy"} tone={lowStock.length ? "text-rose-400" : "text-emerald-400"} icon={AlertTriangle} />
          </div>
          {starterKitActive && branchInventory.length > 0 && (
            <div className="px-4 py-3 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-200">
              <Sparkles className="w-4 h-4 inline mr-1" />
              This is your auto-provisioned <b>{businessInfo?.category} starter kit</b> — {formatMoney(stockCostValue, currentCurrency, true)} of opening stock funded from the unit’s initial capital. It becomes live sellable stock immediately.
            </div>
          )}
          <Card title="Inventory & Stock" icon={Boxes}
            action={<div className="flex gap-2">
              <button onClick={() => { setRestockItemId(null); setShowForm("RESTOCK"); }} className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><PackagePlus className="w-3.5 h-3.5" />Receive Stock</button>
              <button onClick={() => setShowForm("ITEM")} className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />New Item</button>
            </div>}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900/90 text-slate-400 uppercase text-[10px]">
                  <tr>{["Product", "SKU", "Category", "Qty", "Unit", "Cost", "Price", "Stock Value", "Status", ""].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-slate-700/60">
                  {branchInventory.length === 0 && (
                    <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-400">No inventory items at this branch yet — use “New Item”.</td></tr>
                  )}
                  {branchInventory.map((i) => {
                    const warn = i.status !== "IN_STOCK" || (i.quantity || 0) <= (i.minStockThreshold || 0);
                    return (
                      <tr key={i.id} className="hover:bg-slate-700/40">
                        <td className="px-4 py-3 text-white font-semibold">{i.name}</td>
                        <td className="px-4 py-3 text-slate-400">{i.sku}</td>
                        <td className="px-4 py-3 text-slate-300">{i.category}</td>
                        <td className="px-4 py-3"><span className={`font-black ${warn ? "text-amber-300" : "text-cyan-300"}`}>{Number(i.quantity).toLocaleString()}</span><span className="text-slate-500"> / {i.minStockThreshold}</span></td>
                        <td className="px-4 py-3 text-slate-300">{i.unit}</td>
                        <td className="px-4 py-3 text-slate-300">{formatMoney(i.costPriceGhs, currentCurrency, true)}</td>
                        <td className="px-4 py-3 text-slate-300">{formatMoney(i.sellingPriceGhs, currentCurrency, true)}</td>
                        <td className="px-4 py-3 text-emerald-300 font-semibold">{formatMoney((i.quantity || 0) * (i.costPriceGhs || 0), currentCurrency, true)}</td>
                        <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${i.status === "OUT_OF_STOCK" ? "bg-rose-500/15 text-rose-300 border-rose-500/40" : warn ? "bg-amber-500/15 text-amber-300 border-amber-500/40" : "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"}`}>{i.status}</span></td>
                        <td className="px-4 py-3"><button onClick={() => { setRestockItemId(i.id); setShowForm("RESTOCK"); }} className="px-2 py-1 rounded-md bg-indigo-600/80 hover:bg-indigo-500 text-white text-[10px] font-bold">Restock</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="px-4 pb-4 pt-2 text-[10px] text-slate-500">Fully interconnected: sales deduct stock automatically, restocks top it up and can book the purchase expense to Finance in one step, low/out-of-stock items raise alerts here and in the Command Center.</p>
          </Card>
        </div>
      )}

      {/* ══════════════ FINANCE — complete Financial Report ══════════════ */}
      {tab === "FINANCE" && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setShowForm("SALE")} className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold flex items-center gap-1"><BadgeDollarSign className="w-3.5 h-3.5" />Record Sale / Payment</button>
            <button onClick={() => setShowForm("EXPENSE")} className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold flex items-center gap-1"><Wallet className="w-3.5 h-3.5" />Record Expense</button>
            <button onClick={() => { setRestockItemId(null); setShowForm("RESTOCK"); }} className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><PackagePlus className="w-3.5 h-3.5" />Purchase Stock</button>
          </div>
          {starterKitActive && stockCostValue > 0 && (
            <div className="px-4 py-3 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-200">
              The opening <b>starter kit ({formatMoney(stockCostValue, currentCurrency, true)} at cost)</b> was funded from the unit’s initial capital during auto-provisioning — it is reflected in the Command Center metrics for this unit.
            </div>
          )}
          <FinancialReportSection
            mode="business"
            businessInfo={businessInfo}
            businessMetric={businessMetrics}
            transactions={transactions}
            inventory={inventory}
            customers={customers}
            currentCurrency={currentCurrency}
            accent={cfg.accent}
            testid="fin-report-unit"
            aiModuleKey="GENERIC"
            opsLinks={[{
              label: cfg.opsLabel.replace(/ Log$/, " entries"),
              value: String(opsLogs.length),
              note: "Operational log entries feeding this unit’s activities",
              tone: "sky",
            }]}
          />
        </div>
      )}

      {/* ══════════════ DAILY CHECKLIST ══════════════ */}
      {tab === "CHECKLIST" && (
        <DailyChecklistPanel
          businessId={bizId}
          branchCode={businessInfo?.code}
          businessName={businessInfo?.name}
          employees={employees}
          currentUser={currentUser}
          accent={cfg.accent === "rose" ? "red" : cfg.accent}
          onChanged={() => onRefreshData?.()}
        />
      )}

      {showForm && (
        <UnitForm
          type={showForm} busy={busy} cfg={cfg} inventory={branchInventory}
          preselectItemId={restockItemId}
          onClose={() => { setShowForm(null); setError(""); setRestockItemId(null); }}
          onSubmit={submit}
        />
      )}
    </div>
  );
}

function Row({ k, v }: any) {
  return (
    <div className="flex items-center justify-between gap-3 p-2 rounded-lg bg-slate-900/70 border border-slate-700">
      <span className="text-slate-400">{k}</span>
      <span className="text-slate-200 font-semibold text-right">{v || "—"}</span>
    </div>
  );
}

function UnitForm({ type, busy, cfg, inventory, preselectItemId, onClose, onSubmit }: any) {
  const todayStr = new Date().toISOString().split("T")[0];
  const [f, setF] = useState<any>({
    paymentMethod: "CASH", date: todayStr, recordExpense: true,
    inventoryId: preselectItemId ? String(preselectItemId) : "",
    category: type === "OPS" ? "Production" : "",
  });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const title =
    type === "SALE" ? "Record Sale / Payment" :
    type === "RESTOCK" ? "Receive Stock (Purchase)" :
    type === "EXPENSE" ? "Record Expense" :
    type === "ITEM" ? "Add Inventory Item" :
    cfg.opsLabel;

  const selectedItem = inventory.find((i: any) => String(i.id) === String(f.inventoryId));
  const qty = Number(f.quantity) || 0;
  const price = f.sellingPrice ? Number(f.sellingPrice) : selectedItem?.sellingPriceGhs || 0;
  const saleTotal = qty * price;
  const salePct = Math.max(0, Math.min(100, Number(f.discountPct) || 0));
  const saleNet = Math.round(saleTotal * (1 - salePct / 100) * 100) / 100;
  const restockCost = Number(f.unitCostGhs) || 0;
  const restockTotal = qty * restockCost;

  const I = ({ label, k, t = "text", ...rest }: any) => (
    <div>
      <label className="block text-[10px] text-slate-400 font-semibold mb-1">{label}</label>
      <input type={t} value={f[k] ?? ""} onChange={(e) => set(k, t === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs" {...rest} />
    </div>
  );
  const S = ({ label, k, opts }: any) => (
    <div>
      <label className="block text-[10px] text-slate-400 font-semibold mb-1">{label}</label>
      <select value={f[k] ?? ""} onChange={(e) => set(k, e.target.value)}
        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs">
        {opts.map((o: any) => <option key={o.v ?? o} value={o.v ?? o}>{o.l ?? o}</option>)}
      </select>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-slate-800 sticky top-0 bg-slate-900 z-10">
          <h3 className="text-lg font-bold text-white">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); onSubmit(type, type === "RESTOCK" ? { ...f, totalCostGhs: restockTotal } : f); }} className="p-5 space-y-3">
          {type === "SALE" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-[10px] text-slate-400 font-semibold mb-1">Product (from live stock — sellable items first)</label>
                  <select required value={f.inventoryId ?? ""} onChange={(e) => set("inventoryId", e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs">
                    <option value="" disabled>— Select product —</option>
                    {[...inventory]
                      .sort((a: any, b: any) => (cfg.productRe.test(`${b.name} ${b.category}`) ? 1 : 0) - (cfg.productRe.test(`${a.name} ${a.category}`) ? 1 : 0) || String(a.name).localeCompare(String(b.name)))
                      .map((i: any) => {
                        const out = (i.quantity || 0) <= 0 || i.status === "OUT_OF_STOCK";
                        return <option key={i.id} value={i.id} disabled={out}>{i.name} • {out ? "OUT OF STOCK" : `${Number(i.quantity).toLocaleString()} ${i.unit} available`} • {i.sellingPriceGhs} GH₵</option>;
                      })}
                  </select>
                </div>
                <I label="Quantity" k="quantity" t="number" required min={1} max={selectedItem?.quantity} />
                <I label={`Unit Price (GH₵)${selectedItem ? ` — default ${selectedItem.sellingPriceGhs}` : ""}`} k="sellingPrice" t="number" step="0.01" placeholder={selectedItem ? String(selectedItem.sellingPriceGhs) : ""} />
                <I label="Customer Name" k="customerName" placeholder="Walk-in Customer" />
                <I label="Customer Phone" k="customerPhone" />
                <S label="Payment" k="paymentMethod" opts={["CASH", "MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER", "POS_CARD"]} />
                <I label="Discount %" k="discountPct" t="number" step="0.5" min={0} max={100} placeholder="auto-calculates" />
                <I label="Price Override Reason" k="customPriceReason" placeholder="only if price changed" />
              </div>
              {selectedItem && (
                <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200">
                  Total due: <span className="font-black">GH₵ {saleNet.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>{salePct > 0 && <span className="ml-1 text-emerald-300">({salePct}% discount − GH₵ {(saleTotal - saleNet).toLocaleString(undefined, { maximumFractionDigits: 2 })})</span>} — sells {qty} {selectedItem.unit} of “{selectedItem.name}”. Stock after sale: {Math.max(0, (selectedItem.quantity || 0) - qty).toLocaleString()}.
                </div>
              )}
              <I label="Notes" k="notes" />
            </>
          )}
          {type === "RESTOCK" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-[10px] text-slate-400 font-semibold mb-1">Inventory Item</label>
                  <select required value={f.inventoryId ?? ""} onChange={(e) => {
                    const it = inventory.find((x: any) => String(x.id) === e.target.value);
                    setF((p: any) => ({ ...p, inventoryId: e.target.value, unitCostGhs: it?.costPriceGhs ?? p.unitCostGhs }));
                  }} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs">
                    <option value="" disabled>— Select item —</option>
                    {inventory.map((i: any) => <option key={i.id} value={i.id}>{i.name} ({i.sku}) • {i.quantity} {i.unit} on hand</option>)}
                  </select>
                </div>
                <I label="Quantity Received" k="quantity" t="number" required min={1} />
                <I label="Unit Cost (GH₵)" k="unitCostGhs" t="number" step="0.01" />
                <I label="Date" k="date" t="date" />
                <S label="Payment" k="paymentMethod" opts={["CASH", "MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER", "POS_CARD"]} />
              </div>
              {selectedItem && qty > 0 && (
                <div className="p-3 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-200">
                  Stock update: +{qty.toLocaleString()} → “{selectedItem.name}”: {Number(selectedItem.quantity || 0).toLocaleString()} → {(Number(selectedItem.quantity || 0) + qty).toLocaleString()} {selectedItem.unit}
                </div>
              )}
              <div className="flex items-center gap-2 p-3 rounded-lg bg-slate-800/70 border border-slate-700 text-xs">
                <input id="unit-record-expense" type="checkbox" checked={!!f.recordExpense} onChange={(e) => set("recordExpense", e.target.checked)} className="w-4 h-4 accent-indigo-500" />
                <label htmlFor="unit-record-expense" className="text-slate-300">Book purchase as expense ({restockTotal > 0 ? `GH₵ ${restockTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "no cost set"}) in Finance</label>
              </div>
              <I label="Description / Supplier note" k="description" />
            </>
          )}
          {type === "EXPENSE" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <I label="Category" k="category" required placeholder="Fuel, Payroll, Rent..." list="unit-exp-cats" />
                <I label="Amount (GH₵)" k="amountGhs" t="number" step="0.01" required min={0.01} />
                <S label="Payment" k="paymentMethod" opts={["CASH", "MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER", "POS_CARD"]} />
                <I label="Date" k="date" t="date" />
              </div>
              <I label="Description" k="description" />
              <datalist id="unit-exp-cats">{["Stock Purchase", "Fuel & Transport", "Payroll", "Rent", "Utilities", "Equipment Repair", "Packaging", "Marketing", "Miscellaneous"].map((c) => <option key={c} value={c} />)}</datalist>
            </>
          )}
          {type === "ITEM" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2"><I label="Item Name" k="name" required /></div>
                <I label="SKU" k="sku" placeholder="auto if blank" />
                <I label="Category" k="category" placeholder="e.g. Finished Goods" />
                <I label="Opening Quantity" k="quantity" t="number" min={0} />
                <S label="Unit" k="unit" opts={["Units", "Kg", "Plates", "Bags", "Litres", "Crates", "Jobs", "Drums", "m³"]} />
                <I label="Cost Price (GH₵)" k="costPriceGhs" t="number" step="0.01" />
                <I label="Selling Price (GH₵)" k="sellingPriceGhs" t="number" step="0.01" />
                <I label="Low-Stock Threshold" k="minStockThreshold" t="number" min={0} />
              </div>
            </>
          )}
          {type === "OPS" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <S label="Activity Type" k="category" opts={["Production", "Feeding", "Harvest", "Quality Check", "Machine Work", "Service Job", "Cleaning & Maintenance", "Other"]} />
                <I label={cfg.opsQtyLabel} k="quantity" t="number" min={0} />
                <I label="Date" k="date" t="date" />
                <I label="Unit Cost (GH₵, optional)" k="amountGhs" t="number" min={0} step="0.01" placeholder="0 = activity only" />
              </div>
              <I label="Notes / Details" k="description" placeholder={`e.g. Morning ${cfg.opsUnit} from the first shift`} />
              <p className="text-[10px] text-slate-500">Saved to today’s Activities feed and the enterprise transaction ledger as an operational log entry.</p>
            </>
          )}
          <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
            <button type="button" onClick={onClose} className="px-4 py-2 bg-slate-800 rounded-lg text-xs text-slate-300">Cancel</button>
            <button disabled={busy} className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-bold text-white disabled:opacity-50">{busy ? "Saving..." : "Save"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
