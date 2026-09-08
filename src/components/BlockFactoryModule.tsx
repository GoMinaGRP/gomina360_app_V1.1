"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import AiSectionGuide from "./AiSectionGuide";
import BlockQcCenter from "./BlockQcCenter";
import {
  Boxes, Package, Truck, Wallet, AlertTriangle, CheckCircle, Settings,
  Users, Plus, X, Calendar, Filter, TrendingUp, TrendingDown, Loader2,
  Building2, Wrench, Activity, ShoppingCart, LayoutDashboard, ClipboardCheck,
  BadgeDollarSign, PackagePlus, CircleDot, CheckCircle2, ShieldCheck,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  LineChart, Line, AreaChart, Area,
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
  currentCurrency: CurrencyCode;
  onRefreshData: () => void;
}

type FormType = "PRODUCTION" | "ORDER" | "DELIVERY" | "EXPENSE" | "SALE" | "RESTOCK" | "ITEM" | null;
type Tab = "DASHBOARD" | "INVENTORY" | "FINANCE" | "QC" | "CHECKLIST";

const TABS: { key: Tab; label: string; icon: any }[] = [
  { key: "DASHBOARD", label: "Dashboard", icon: LayoutDashboard },
  { key: "INVENTORY", label: "Inventory", icon: Boxes },
  { key: "FINANCE", label: "Finance", icon: Wallet },
  { key: "QC", label: "Quality Control", icon: ShieldCheck },
  { key: "CHECKLIST", label: "Daily Checklist", icon: ClipboardCheck },
];

// Original factory types — always present as the baseline; the persisted master
// list (block_types table) extends this with any user-created types.
const BLOCK_TYPES = ["6-INCH-SOLID", "6-INCH-HOLLOW", "5-INCH-SOLID", "PAVING-BRICKS"];
const ADD_NEW_TYPE = "__ADD_NEW_BLOCK_TYPE__";


export default function BlockFactoryModule({
  currentUser, businessInfo, businessMetrics, inventory, transactions, assets,
  employees, currentCurrency, onRefreshData,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("DASHBOARD");
  const [production, setProduction] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [checklists, setChecklists] = useState<any[]>([]);
  const [blockTypesList, setBlockTypesList] = useState<any[]>([]);
  const [qcChecks, setQcChecks] = useState<any[]>([]);
  const [checklistDate, setChecklistDate] = useState<string>(new Date().toISOString().split("T")[0]);
  const [showForm, setShowForm] = useState<FormType>(null);
  const [restockItemId, setRestockItemId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [dateFilter, setDateFilter] = useState("ALL");
  const [blockTypeFilter, setBlockTypeFilter] = useState("ALL");

  const bizId = businessInfo?.id;
  const today = new Date().toISOString().split("T")[0];

  const refresh = useCallback(async () => {
    if (!bizId) return;
    try {
      const res = await fetch(`/api/block-factory?businessId=${bizId}`);
      const d = await res.json();
      if (d.success) {
        setProduction(d.production || []);
        setOrders(d.orders || []);
        setDeliveries(d.deliveries || []);
        setBlockTypesList(d.blockTypes || []);
        setQcChecks(d.qcChecks || []);
      }
    } finally {
      setLoading(false);
    }
  }, [bizId]);

  // Master list of block types: original factory types + any saved custom types
  // + any type already referenced by historical records (so filters never hide data).
  const blockTypeOptions = useMemo(() => {
    const fromMaster = blockTypesList.filter((t) => t.isActive !== false).map((t) => t.typeKey);
    const fromData = [...production, ...orders, ...deliveries].map((x: any) => x.blockType);
    return Array.from(new Set([...BLOCK_TYPES, ...fromMaster, ...fromData].filter(Boolean))) as string[];
  }, [blockTypesList, production, orders, deliveries]);

  useEffect(() => { refresh(); }, [refresh]);

  const branchInventory = inventory.filter((i) => i.businessId === bizId);
  const branchAssets = assets.filter((a) => a.businessId === bizId);
  const branchEmployees = employees.filter((e) => e.businessId === bizId);
  const branchTransactions = transactions.filter((t) => t.businessId === bizId);

  const filterByDate = (date?: string) => {
    if (!dateFilter || dateFilter === "ALL") return true;
    return date === dateFilter;
  };

  const filteredProduction = production.filter((p) =>
    filterByDate(p.recordedDate) && (blockTypeFilter === "ALL" || p.blockType === blockTypeFilter)
  );
  const filteredTransactions = branchTransactions.filter((t) =>
    filterByDate(t.date) && (blockTypeFilter === "ALL" || (t.description || "").includes(blockTypeFilter))
  );

  // KPI calculations
  const blocksToday = production
    .filter((p) => p.recordedDate === today)
    .reduce((s, p) => s + (p.blocksMolded || 0) - (p.blocksBroken || 0), 0);
  const blockStock = branchInventory
    .filter((i) => /block|brick|paving/i.test(`${i.name} ${i.category}`))
    .reduce((s, i) => s + (i.quantity || 0), 0);
  const salesToday = branchTransactions.filter((t) => t.type === "INCOME" && t.date === today);
  const revenueToday = salesToday.reduce((s, t) => s + (t.amountGhs || 0), 0);
  const expensesToday = branchTransactions
    .filter((t) => t.type === "EXPENSE" && t.date === today)
    .reduce((s, t) => s + (t.amountGhs || 0), 0);
  const netProfit = revenueToday - expensesToday;
  const pendingOrders = orders.filter((o) => ["PENDING", "IN_PROGRESS"].includes(o.status)).length;
  const activeDeliveries = deliveries.filter((d) => ["SCHEDULED", "IN_TRANSIT"].includes(d.status)).length;
  const workersPresent = branchEmployees.filter((e) => e.status === "ACTIVE").length;

  const rawMaterials = {
    cement: branchInventory.find((i) => /cement/i.test(`${i.name} ${i.category}`)),
    sand: branchInventory.find((i) => /sand/i.test(`${i.name} ${i.category}`)),
    quarry: branchInventory.find((i) => /quarry/i.test(`${i.name} ${i.category}`)),
    water: branchInventory.find((i) => /water/i.test(`${i.name} ${i.category}`)),
  };

  const machines = branchAssets.filter((a) => /MACHINERY|GENERATOR|TECH/i.test(a.assetType || ""));
  const machinesOk = machines.filter((m) => ["EXCELLENT", "GOOD"].includes(m.condition)).length;
  const maintenanceDue = machines.filter((m) =>
    m.condition === "NEEDS_MAINTENANCE" || (m.nextMaintenanceDate && m.nextMaintenanceDate <= today)
  );
  const machinesUnderRepair = machines.filter((m) => m.condition === "UNDER_REPAIR");

  const lowStock = branchInventory.filter((i) => i.status !== "IN_STOCK" || i.quantity <= i.minStockThreshold);
  const breakageRate = filteredProduction.reduce((s, p) => s + (p.blocksMolded || 0), 0) > 0
    ? filteredProduction.reduce((s, p) => s + (p.blocksBroken || 0), 0) /
      filteredProduction.reduce((s, p) => s + (p.blocksMolded || 0), 0) * 100
    : 0;

  // Overdue operational items (orders past due date, deliveries past delivery date)
  const overdueOrders = orders.filter(
    (o) => o.dueDate && o.dueDate < today && ["PENDING", "IN_PROGRESS"].includes(o.status)
  );
  const lateDeliveries = deliveries.filter(
    (d) => d.deliveryDate && d.deliveryDate < today && ["SCHEDULED", "IN_TRANSIT"].includes(d.status)
  );

  const alerts = [
    ...lowStock.map((i) => ({ level: i.status === "OUT_OF_STOCK" ? "critical" : "warning", msg: `${i.name} is ${i.status} (${i.quantity} ${i.unit})` })),
    ...maintenanceDue.map((m) => ({ level: "warning", msg: `Maintenance due: ${m.name}` })),
    ...machinesUnderRepair.map((m) => ({ level: "critical", msg: `Machine under repair: ${m.name}` })),
    ...(breakageRate > 2 ? [{ level: "critical", msg: `High block breakage rate: ${breakageRate.toFixed(1)}%` }] : []),
    ...(pendingOrders > 3 ? [{ level: "warning", msg: `${pendingOrders} pending orders need scheduling` }] : []),
    ...overdueOrders.map((o) => ({ level: "warning", msg: `Overdue order: ${o.orderNumber} • ${o.customerName} (due ${o.dueDate})` })),
    ...lateDeliveries.map((d) => ({ level: "warning", msg: `Delayed delivery: ${d.deliveryNumber} • ${d.customerName} (${d.deliveryDate})` })),
    ...(netProfit < 0 ? [{ level: "critical", msg: `Today is loss-making: ${formatMoney(netProfit, currentCurrency)}` }] : []),
  ];

  // Production & sales summary for the current filter scope
  const summary = useMemo(() => {
    const goodBlocks = filteredProduction.reduce((s, p) => s + (p.blocksMolded || 0) - (p.blocksBroken || 0), 0);
    const molded = filteredProduction.reduce((s, p) => s + (p.blocksMolded || 0), 0);
    const broken = filteredProduction.reduce((s, p) => s + (p.blocksBroken || 0), 0);
    const cementBags = filteredProduction.reduce((s, p) => s + (p.bagsCementUsed || 0), 0);
    const income = filteredTransactions.filter((t) => t.type === "INCOME");
    const expense = filteredTransactions.filter((t) => t.type === "EXPENSE");
    const revenue = income.reduce((s, t) => s + (t.amountGhs || 0), 0);
    const expenses = expense.reduce((s, t) => s + (t.amountGhs || 0), 0);
    const orderQty = orders.reduce((s, o) => s + (o.quantity || 0), 0);
    const orderValue = orders.reduce((s, o) => s + (o.totalGhs || 0), 0);
    return {
      goodBlocks, molded, broken, cementBags,
      salesCount: income.length, revenue,
      expenseCount: expense.length, expenses,
      profit: revenue - expenses,
      orderQty, orderValue,
      avgOrderPrice: orderQty > 0 ? orderValue / orderQty : 0,
    };
  }, [filteredProduction, filteredTransactions, orders]);

  // Finance tab aggregates (respect the same filters → always in sync with dashboard)
  const finance = useMemo(() => {
    const income = filteredTransactions.filter((t) => t.type === "INCOME");
    const expense = filteredTransactions.filter((t) => t.type === "EXPENSE");
    const revenue = income.reduce((s, t) => s + (t.amountGhs || 0), 0);
    const expenses = expense.reduce((s, t) => s + (t.amountGhs || 0), 0);
    const profit = revenue - expenses;
    const group = (rows: any[]) => {
      const map: Record<string, number> = {};
      rows.forEach((t) => { const k = t.category || "Uncategorised"; map[k] = (map[k] || 0) + (t.amountGhs || 0); });
      return Object.entries(map).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
    };
    const payMap: Record<string, number> = {};
    filteredTransactions.forEach((t) => { const k = t.paymentMethod || "CASH"; payMap[k] = (payMap[k] || 0) + (t.amountGhs || 0); });
    return {
      revenue, expenses, profit,
      margin: revenue > 0 ? (profit / revenue) * 100 : 0,
      incomeByCategory: group(income),
      expenseByCategory: group(expense),
      byPaymentMethod: Object.entries(payMap).map(([method, total]) => ({ method, total })).sort((a, b) => b.total - a.total),
      recent: [...filteredTransactions].sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 12),
    };
  }, [filteredTransactions]);

  const byDate = (rows: any[], getVal: (r: any) => number, dateKey = "recordedDate") => {
    const map: Record<string, number> = {};
    rows.forEach((r) => { const d = r[dateKey] || r.date; map[d] = (map[d] || 0) + getVal(r); });
    return Object.entries(map).map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  };

  const productionChart = byDate(filteredProduction, (p) => (p.blocksMolded || 0) - (p.blocksBroken || 0));
  const salesChart = byDate(filteredTransactions.filter((t) => t.type === "INCOME"), (t) => t.amountGhs || 0, "date");
  const expenseChart = byDate(filteredTransactions.filter((t) => t.type === "EXPENSE"), (t) => t.amountGhs || 0, "date");
  const profitChart = (() => {
    const allDates = new Set([...salesChart.map((d) => d.date), ...expenseChart.map((d) => d.date)]);
    return Array.from(allDates).sort().map((date) => ({
      date,
      value: (salesChart.find((x) => x.date === date)?.value || 0) - (expenseChart.find((x) => x.date === date)?.value || 0),
    })).slice(-14);
  })();

  const submit = async (entity: FormType, data: any) => {
    setBusy(true); setError("");
    try {
      let d: any;
      if (entity === "SALE") {
        // Shared sales pipeline: validates & decrements inventory, creates the
        // INCOME transaction + receipt — every module updates from it.
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
            discount: Number(data.discount) || 0,
            discountPercent: data.discountPct ? Number(data.discountPct) : undefined,
            cartItems: [
              {
                inventoryId: Number(data.inventoryId),
                quantity: Number(data.quantity),
                sellingPrice: data.sellingPrice ? Number(data.sellingPrice) : undefined,
                originalPrice: data.sellingPrice ? Number(data.sellingPrice) : undefined,
                customPriceReason: data.customPriceReason,
              },
            ],
            createdByUserId: currentUser?.id,
            createdByName: currentUser?.name,
            createdByRole: currentUser?.role,
          }),
        });
        d = await res.json();
      } else if (entity === "ITEM") {
        // Shared enterprise entity route → appears in the global Inventory module too
        const res = await fetch("/api/enterprise", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entityType: "inventory", data: { ...data, businessId: bizId } }),
        });
        d = await res.json();
      } else {
        // "Add New Block Type" flow (from the production OR restock forms):
        // persist the new type to the master list first — with its linked
        // finished-goods stock item — then carry on against the new typeKey.
        if ((entity === "PRODUCTION" || entity === "RESTOCK") && data.__newBlock) {
          const tRes = await fetch("/api/block-factory", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              entity: "BLOCK_TYPE",
              data: {
                ...data.__newBlock,
                businessId: bizId,
                branchCode: businessInfo?.code,
                createdByName: currentUser?.name,
                createdByRole: currentUser?.role,
              },
            }),
          });
          const tD = await tRes.json();
          if (!tD.success) throw new Error(tD.error || "Failed to save new block type");
          data = { ...data, blockType: tD.item.typeKey };
          delete data.__newBlock;
        }
        const res = await fetch("/api/block-factory", {
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
              recordedBy: currentUser?.name,
              recordedByRole: currentUser?.role,
              recordedByUserId: currentUser?.id,
            },
          }),
        });
        d = await res.json();
      }
      if (!d.success) throw new Error(d.error || "Failed to save");
      setShowForm(null);
      await refresh();
      onRefreshData();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

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

  if (loading) return <div className="flex items-center justify-center min-h-[50vh]"><Loader2 className="w-8 h-8 animate-spin text-cyan-400" /></div>;

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-[1600px] mx-auto text-slate-100">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-5 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 rounded-xl bg-cyan-500/20 border border-cyan-400/30 flex items-center justify-center shrink-0">
            <Boxes className="w-6 h-6 text-cyan-400" />
          </div>
          <div>
            <span className="px-2.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 text-xs font-bold border border-cyan-500/30">BLOCK FACTORY MANAGEMENT</span>
            <h2 className="text-xl sm:text-2xl font-extrabold text-white mt-1">{businessInfo?.name}</h2>
            <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5"><Building2 className="w-3 h-3" />{businessInfo?.code} • {[businessInfo?.town, businessInfo?.district, businessInfo?.region].filter(Boolean).join(", ")}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setShowForm("PRODUCTION")} className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />Production</button>
          <button onClick={() => setShowForm("SALE")} className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold flex items-center gap-1"><BadgeDollarSign className="w-3.5 h-3.5" />Sale</button>
          <button onClick={() => { setRestockItemId(null); setShowForm("RESTOCK"); }} className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><PackagePlus className="w-3.5 h-3.5" />Restock</button>
          <button onClick={() => setShowForm("ORDER")} className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1"><ShoppingCart className="w-3.5 h-3.5" />Order</button>
          <button onClick={() => setShowForm("DELIVERY")} className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center gap-1"><Truck className="w-3.5 h-3.5" />Delivery</button>
          <button onClick={() => setShowForm("EXPENSE")} className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold flex items-center gap-1"><Wallet className="w-3.5 h-3.5" />Expense</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-1 bg-slate-800/90 border border-slate-700/80 p-1.5 rounded-xl">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition ${
              tab === t.key ? "bg-cyan-600 text-white shadow" : "text-slate-300 hover:bg-slate-700/70"}`}>
            <t.icon className="w-4 h-4" />
            <span className="text-[10px] leading-none lg:leading-normal lg:text-xs">{t.label}</span>
          </button>
        ))}
        <AiSectionGuide moduleKey="BLOCK" section={tab} businessInfo={businessInfo} />
      </div>

      {error && <div className="px-4 py-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs"><AlertTriangle className="w-4 h-4 inline mr-1" />{error}</div>}

      {/* Filters */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 text-xs text-slate-300"><Filter className="w-4 h-4 text-cyan-400" /><span className="font-bold">Filters</span></div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-1">Date</label>
          <input type="date" value={dateFilter === "ALL" ? "" : dateFilter} onChange={(e) => setDateFilter(e.target.value || "ALL")} className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs" />
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-1">Block Type</label>
          <select value={blockTypeFilter} onChange={(e) => setBlockTypeFilter(e.target.value)} className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs">
            <option value="ALL">All Block Types</option>{blockTypeOptions.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        {(dateFilter !== "ALL" || blockTypeFilter !== "ALL") && <button onClick={() => { setDateFilter("ALL"); setBlockTypeFilter("ALL"); }} className="self-end px-3 py-2 rounded-lg bg-slate-700 text-xs font-semibold">Clear</button>}
      </div>

      {/* ══════════════ DASHBOARD ══════════════ */}
      {tab === "DASHBOARD" && (
        <div className="space-y-5">
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <Stat label="Blocks Produced Today" value={blocksToday.toLocaleString()} sub="good blocks" color="cyan" icon={Boxes} />
            <Stat label="Blocks in Stock" value={blockStock.toLocaleString()} sub="finished goods" color="emerald" icon={Package} />
            <Stat label="Sales Today" value={salesToday.length} sub={`${formatMoney(revenueToday, currentCurrency, true)} revenue`} color="emerald" icon={TrendingUp} />
            <Stat label="Revenue Today" value={formatMoney(revenueToday, currentCurrency, true)} color="emerald" icon={Wallet} />
            <Stat label="Expenses Today" value={formatMoney(expensesToday, currentCurrency, true)} color="rose" icon={TrendingDown} />
            <Stat label="Net Profit" value={formatMoney(netProfit, currentCurrency, true)} color={netProfit >= 0 ? "emerald" : "rose"} icon={Activity} />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Pending Orders" value={pendingOrders} sub={`${orders.length} total orders`} color="amber" icon={ShoppingCart} />
            <Stat label="Deliveries" value={activeDeliveries} sub={`${deliveries.length} total`} color="blue" icon={Truck} />
            <Stat label="Machine Status" value={`${machinesOk}/${machines.length}`} sub={maintenanceDue.length ? `${maintenanceDue.length} due` : "all good"} color={maintenanceDue.length ? "amber" : "emerald"} icon={Wrench} />
            <Stat label="Workers Present" value={workersPresent} sub="active staff" color="purple" icon={Users} />
          </div>

          {/* Production & Sales Summary (current filter scope) */}
          <Card title="Production & Sales Summary" icon={Activity}
            action={<span className="text-[10px] text-slate-400">{dateFilter === "ALL" ? "All recorded history" : `Date: ${dateFilter}`} • {blockTypeFilter === "ALL" ? "all block types" : blockTypeFilter}</span>}>
            <div className="p-4 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
              <MiniStat label="Good Blocks Produced" value={summary.goodBlocks.toLocaleString()} sub={`${summary.molded.toLocaleString()} molded • ${summary.broken.toLocaleString()} broken`} color="cyan" />
              <MiniStat label="Cement Used" value={`${summary.cementBags.toLocaleString()} bags`} sub={summary.molded > 0 ? `${(summary.cementBags / summary.molded * 1000).toFixed(0)} blocks/bag…` : "no production"} color="amber" />
              <MiniStat label="Breakage Rate" value={`${breakageRate.toFixed(2)}%`} sub={breakageRate > 2 ? "above 2% target" : "within target"} color={breakageRate > 2 ? "rose" : "emerald"} />
              <MiniStat label="Sales" value={summary.salesCount.toLocaleString()} sub={`${formatMoney(summary.revenue, currentCurrency, true)} revenue`} color="emerald" />
              <MiniStat label="Expenses" value={summary.expenseCount.toLocaleString()} sub={`${formatMoney(summary.expenses, currentCurrency, true)} spent`} color="rose" />
              <MiniStat label="Profit" value={formatMoney(summary.profit, currentCurrency, true)} sub={summary.revenue > 0 ? `${((summary.profit / summary.revenue) * 100).toFixed(1)}% margin` : "—"} color={summary.profit >= 0 ? "emerald" : "rose"} />
            </div>
            <div className="px-4 pb-4 grid grid-cols-2 md:grid-cols-4 gap-3 border-t border-slate-700/60 pt-3">
              <div className="text-xs text-slate-400">Order pipeline: <span className="text-white font-bold">{orders.length}</span> orders • <span className="text-cyan-300 font-bold">{summary.orderQty.toLocaleString()}</span> blocks • <span className="text-emerald-300 font-bold">{formatMoney(summary.orderValue, currentCurrency, true)}</span> value</div>
              <div className="text-xs text-slate-400">Avg order price: <span className="text-white font-bold">{formatMoney(summary.avgOrderPrice, currentCurrency, true)}</span>/block</div>
              <div className="text-xs text-slate-400">Quarter balance: <span className="text-emerald-300 font-bold">{formatMoney(businessMetrics?.netProfitGhs ?? 0, currentCurrency)}</span> net profit (Q1 baseline)</div>
              <div className="text-xs text-slate-400">Month target: <span className="text-white font-bold">{formatMoney(businessInfo?.monthlyTargetRevenueGhs ?? 0, currentCurrency)}</span></div>
            </div>
          </Card>

          {/* Raw materials + alerts */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <Card title="Raw Material Stock" icon={Package}>
              <div className="p-4 grid grid-cols-2 gap-3">
                {[
                  { key: "cement", label: "Cement", data: rawMaterials.cement, unit: "bags" },
                  { key: "sand", label: "Sand", data: rawMaterials.sand, unit: "m³" },
                  { key: "quarry", label: "Quarry Dust", data: rawMaterials.quarry, unit: "m³" },
                  { key: "water", label: "Water", data: rawMaterials.water, unit: "L" },
                ].map((m) => {
                  const warn = m.data && m.data.quantity <= m.data.minStockThreshold;
                  return <div key={m.key} className={`p-3 rounded-xl border bg-slate-900/70 ${warn ? "border-amber-500/40" : "border-slate-700"}`}>
                    <div className="text-[10px] text-slate-400 uppercase font-bold">{m.label}</div>
                    <div className={`text-xl font-black ${warn ? "text-amber-400" : "text-cyan-400"}`}>{m.data ? Number(m.data.quantity).toLocaleString() : "—"}</div>
                    <div className="text-[10px] text-slate-500">{m.data?.unit || m.unit}</div>
                  </div>;
                })}
              </div>
            </Card>
            <div className="xl:col-span-2">
              <Card title="Low Stock & Operational Alerts" icon={AlertTriangle}>
                <div className="p-4 space-y-2 max-h-64 overflow-y-auto">
                  {alerts.length > 0 ? alerts.map((a, i) => <div key={i} className={`p-3 rounded-lg border text-xs ${a.level === "critical" ? "bg-rose-500/15 border-rose-500/40 text-rose-200" : "bg-amber-500/15 border-amber-500/40 text-amber-200"}`}>
                    <AlertTriangle className="w-4 h-4 inline mr-1" />{a.msg}
                  </div>) : <div className="p-4 text-center text-emerald-400 text-sm"><CheckCircle className="w-5 h-5 inline mr-2" />All systems normal</div>}
                </div>
              </Card>
            </div>
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Production Trend" icon={Boxes}><ChartBar data={productionChart} color="#06b6d4" currency={currentCurrency} /></Card>
            <Card title="Sales Trend" icon={TrendingUp}><ChartBar data={salesChart} color="#10b981" currency={currentCurrency} money /></Card>
            <Card title="Expenses Trend" icon={TrendingDown}><ChartArea data={expenseChart} color="#f43f5e" currency={currentCurrency} /></Card>
            <Card title="Profit Trend" icon={Wallet}><ChartLine data={profitChart} color={netProfit >= 0 ? "#10b981" : "#f43f5e"} currency={currentCurrency} /></Card>
          </div>

          {/* Operational tables */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <Card title="Recent Production Batches" icon={Boxes}>
              <DataTable headers={["Date", "Batch", "Type", "Molded", "Broken", "Good", "Quality"]} rows={production.slice(0, 8).map((p) => [p.recordedDate, p.batchId, p.blockType, p.blocksMolded, p.blocksBroken, (p.blocksMolded || 0) - (p.blocksBroken || 0), p.qualityGrade])} />
            </Card>
            <Card title="Orders & Deliveries" icon={Truck}>
              <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
                <MiniList title="Pending Orders" items={orders.filter((o) => ["PENDING", "IN_PROGRESS"].includes(o.status)).slice(0, 5)} render={(o: any) => `${o.orderNumber} • ${o.customerName} • ${o.quantity.toLocaleString()} ${o.blockType}`} />
                <MiniList title="Deliveries" items={deliveries.slice(0, 5)} render={(d: any) => `${d.deliveryNumber} • ${d.status} • ${d.quantity.toLocaleString()} blocks`} />
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ══════════════ INVENTORY ══════════════ */}
      {tab === "INVENTORY" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Stock Items" value={branchInventory.length} sub="SKUs at this branch" color="cyan" icon={Boxes} />
            <Stat label="Units on Hand" value={branchInventory.reduce((s, i) => s + (i.quantity || 0), 0).toLocaleString()} sub="all materials & goods" color="emerald" icon={Package} />
            <Stat label="Stock Cost Value" value={formatMoney(branchInventory.reduce((s, i) => s + (i.quantity || 0) * (i.costPriceGhs || 0), 0), currentCurrency, true)} sub="at cost price" color="amber" icon={Wallet} />
            <Stat label="Low / Out of Stock" value={lowStock.length} sub={lowStock.length ? "restock required" : "all healthy"} color={lowStock.length ? "rose" : "emerald"} icon={AlertTriangle} />
          </div>

          <Card title="Inventory & Stock" icon={Boxes}
            action={<div className="flex gap-2">
              <button onClick={() => { setRestockItemId(null); setShowForm("RESTOCK"); }} className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><PackagePlus className="w-3.5 h-3.5" />Receive Stock</button>
              <button onClick={() => setShowForm("ITEM")} className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />New Item</button>
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
                    const warn = i.status !== "IN_STOCK" || i.quantity <= i.minStockThreshold;
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
            <p className="px-4 pb-4 pt-2 text-[10px] text-slate-500">Fully interconnected: completed production adds good blocks to each type’s stock item automatically • restocks work straight from the Block Production Master List (or add a new type) and can book the expense to Finance in one step • sales deduct stock, post revenue and refresh dashboards &amp; low-stock alerts instantly.</p>
          </Card>
        </div>
      )}

      {/* ══════════════ FINANCE — complete Financial Report ══════════════ */}
      {tab === "FINANCE" && (
        <div className="space-y-5">
          <FinancialReportSection
            mode="business"
            businessInfo={businessInfo}
            businessMetric={businessMetrics}
            transactions={transactions}
            inventory={inventory}
            currentCurrency={currentCurrency}
            accent="cyan"
            testid="fin-report-block"
            aiModuleKey="BLOCK"
            opsLinks={[
              {
                label: "Production batches",
                value: String(production.length),
                note: "Molding runs — each batch stocks good blocks into Inventory",
                tone: "cyan",
              },
              {
                label: "Customer orders",
                value: `${orders.length} (${orders.filter((o: any) => o.status === "COMPLETED").length} completed)`,
                tone: "emerald",
              },
              {
                label: "Deliveries",
                value: `${deliveries.length} (${deliveries.filter((d: any) => d.status === "DELIVERED").length} delivered)`,
                tone: "sky",
              },
            ]}
          />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Revenue" value={formatMoney(finance.revenue, currentCurrency, true)} sub={`${finance.incomeByCategory.reduce((s, c) => s + 1, 0)} categories`} color="emerald" icon={TrendingUp} />
            <Stat label="Expenses" value={formatMoney(finance.expenses, currentCurrency, true)} sub={`${finance.expenseByCategory.reduce((s, c) => s + 1, 0)} categories`} color="rose" icon={TrendingDown} />
            <Stat label="Net Profit" value={formatMoney(finance.profit, currentCurrency, true)} color={finance.profit >= 0 ? "emerald" : "rose"} icon={Wallet} />
            <Stat label="Profit Margin" value={`${finance.margin.toFixed(1)}%`} sub="of revenue" color={finance.margin >= 0 ? "cyan" : "rose"} icon={Activity} />
          </div>

          <div className="flex flex-wrap gap-2">
            <button onClick={() => setShowForm("SALE")} className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold flex items-center gap-1"><BadgeDollarSign className="w-3.5 h-3.5" />Record Sale / Payment</button>
            <button onClick={() => setShowForm("EXPENSE")} className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold flex items-center gap-1"><Wallet className="w-3.5 h-3.5" />Record Expense</button>
            <button onClick={() => { setRestockItemId(null); setShowForm("RESTOCK"); }} className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><PackagePlus className="w-3.5 h-3.5" />Purchase Stock</button>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <Card title="Income by Category" icon={TrendingUp}>
              <div className="p-4 space-y-2">
                {finance.incomeByCategory.length === 0 && <p className="text-xs text-slate-500">No income recorded in this scope.</p>}
                {finance.incomeByCategory.map((c) => (
                  <div key={c.category} className="flex items-center justify-between text-xs p-2 rounded-lg bg-slate-900/70 border border-slate-700">
                    <span className="text-slate-300">{c.category}</span>
                    <span className="text-emerald-300 font-bold">{formatMoney(c.total, currentCurrency, true)}</span>
                  </div>
                ))}
              </div>
            </Card>
            <Card title="Expenses by Category" icon={TrendingDown}>
              <div className="p-4 space-y-2">
                {finance.expenseByCategory.length === 0 && <p className="text-xs text-slate-500">No expenses recorded in this scope.</p>}
                {finance.expenseByCategory.map((c) => (
                  <div key={c.category} className="flex items-center justify-between text-xs p-2 rounded-lg bg-slate-900/70 border border-slate-700">
                    <span className="text-slate-300">{c.category}</span>
                    <span className="text-rose-300 font-bold">{formatMoney(c.total, currentCurrency, true)}</span>
                  </div>
                ))}
              </div>
            </Card>
            <Card title="Payment Methods" icon={Wallet}>
              <div className="p-4 space-y-2">
                {finance.byPaymentMethod.length === 0 && <p className="text-xs text-slate-500">No transactions yet.</p>}
                {finance.byPaymentMethod.map((p) => (
                  <div key={p.method} className="flex items-center justify-between text-xs p-2 rounded-lg bg-slate-900/70 border border-slate-700">
                    <span className="text-slate-300">{p.method.replace(/_/g, " ")}</span>
                    <span className="text-cyan-300 font-bold">{formatMoney(p.total, currentCurrency, true)}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <Card title="Branch Transactions" icon={Activity}>
            <DataTable
              headers={["Date", "Reference", "Type", "Category", "Method", "Amount", "Recorded By"]}
              rows={finance.recent.map((t) => [
                t.date,
                t.transactionNumber,
                <span key={`t${t.id}`} className={`font-bold ${t.type === "INCOME" ? "text-emerald-300" : "text-rose-300"}`}>{t.type}</span>,
                t.category,
                (t.paymentMethod || "").replace(/_/g, " "),
                <span key={`a${t.id}`} className={t.type === "INCOME" ? "text-emerald-300 font-semibold" : "text-rose-300 font-semibold"}>{formatMoney(t.amountGhs, currentCurrency, true)}</span>,
                t.recordedBy,
              ])}
            />
          </Card>
        </div>
      )}

            {/* ══════════════ QUALITY CONTROL ══════════════ */}
      {tab === "QC" && (
        <BlockQcCenter
          businessId={bizId}
          businessCode={businessInfo?.code}
          production={production}
          orders={orders}
          deliveries={deliveries}
          inventory={branchInventory}
          blockTypes={blockTypesList}
          qcChecks={qcChecks}
          currentUserName={currentUser?.name}
          currentUserRole={currentUser?.role}
          onRefresh={refresh}
        />
      )}

      {/* ══════════════ DAILY CHECKLIST ══════════════ */}
      {tab === "CHECKLIST" && (
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

      {showForm && <BlockFactoryForm type={showForm} busy={busy} onClose={() => { setShowForm(null); setError(""); setRestockItemId(null); }} onSubmit={submit} orders={orders} inventory={branchInventory} blockTypeOptions={blockTypeOptions} blockTypes={blockTypesList} initialRestockItemId={restockItemId} />}
    </div>
  );
}

function MiniStat({ label, value, sub, color = "cyan" }: any) {
  return (
    <div className="p-3 rounded-xl bg-slate-900/70 border border-slate-700">
      <div className="text-[10px] uppercase text-slate-500 font-bold">{label}</div>
      <div className={`text-lg font-black text-${color}-300 mt-0.5`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function ChartBar({ data, color, currency, money }: any) {
  return <div className="p-4"><ResponsiveContainer width="100%" height={220}><BarChart data={data}><XAxis dataKey="date" stroke="#94a3b8" style={{ fontSize: 10 }} /><YAxis stroke="#94a3b8" style={{ fontSize: 10 }} /><Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }} formatter={(v: any) => money ? formatMoney(Number(v), currency) : Number(v).toLocaleString()} /><Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div>;
}
function ChartArea({ data, color, currency }: any) {
  return <div className="p-4"><ResponsiveContainer width="100%" height={220}><AreaChart data={data}><XAxis dataKey="date" stroke="#94a3b8" style={{ fontSize: 10 }} /><YAxis stroke="#94a3b8" style={{ fontSize: 10 }} /><Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }} formatter={(v: any) => formatMoney(Number(v), currency)} /><Area type="monotone" dataKey="value" stroke={color} fill={color} fillOpacity={0.25} /></AreaChart></ResponsiveContainer></div>;
}
function ChartLine({ data, color, currency }: any) {
  return <div className="p-4"><ResponsiveContainer width="100%" height={220}><LineChart data={data}><XAxis dataKey="date" stroke="#94a3b8" style={{ fontSize: 10 }} /><YAxis stroke="#94a3b8" style={{ fontSize: 10 }} /><Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }} formatter={(v: any) => formatMoney(Number(v), currency)} /><Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={{ r: 3 }} /></LineChart></ResponsiveContainer></div>;
}
function DataTable({ headers, rows }: any) {
  return <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="bg-slate-900/90 text-slate-400 uppercase text-[10px]"><tr>{headers.map((h: string) => <th key={h} className="px-4 py-3">{h}</th>)}</tr></thead><tbody className="divide-y divide-slate-700/60">{rows.length ? rows.map((r: any[], i: number) => <tr key={i} className="hover:bg-slate-700/40">{r.map((c, j) => <td key={j} className="px-4 py-3 text-slate-300">{c}</td>)}</tr>) : <tr><td colSpan={headers.length} className="px-4 py-8 text-center text-slate-400">No records</td></tr>}</tbody></table></div>;
}
function MiniList({ title, items, render }: any) {
  return <div><div className="text-[10px] uppercase text-slate-500 font-bold mb-2">{title}</div><div className="space-y-2">{items.length ? items.map((item: any) => <div key={item.id} className="p-2 rounded-lg bg-slate-900/70 border border-slate-700 text-xs text-slate-300">{render(item)}</div>) : <p className="text-xs text-slate-500">No records</p>}</div></div>;
}

function BlockFactoryForm({ type, busy, onClose, onSubmit, orders, inventory, blockTypeOptions, blockTypes = [], initialRestockItemId = null }: any) {
  const todayStr = new Date().toISOString().split("T")[0];
  const [f, setF] = useState<any>({
    blockType: "6-INCH-SOLID", qualityGrade: "GRADE_A_STANDARD", status: "PENDING",
    paymentMethod: "CASH", deliveryDate: todayStr, date: todayStr, recordExpense: true,
    restockTarget: initialRestockItemId ? `ITEM:${initialRestockItemId}` : "",
  });
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const I = ({ label, k, t = "text", ...rest }: any) => <div><label className="block text-[10px] text-slate-400 font-semibold mb-1">{label}</label><input type={t} value={f[k] ?? ""} onChange={(e) => set(k, t === "number" ? Number(e.target.value) : e.target.value)} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs" {...rest} /></div>;
  const S = ({ label, k, opts }: any) => <div><label className="block text-[10px] text-slate-400 font-semibold mb-1">{label}</label><select value={f[k] ?? ""} onChange={(e) => set(k, e.target.value)} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs">{opts.map((o: any) => <option key={o.v ?? o} value={o.v ?? o}>{o.l ?? o}</option>)}</select></div>;
  const title =
    type === "PRODUCTION" ? "Record Block Production" :
    type === "ORDER" ? "Create Customer Order" :
    type === "DELIVERY" ? "Record Delivery" :
    type === "SALE" ? "Record Sale / Payment" :
    type === "RESTOCK" ? "Receive Stock (Purchase)" :
    type === "ITEM" ? "Add Inventory Item" :
    "Record Expense";

  const selectedItem = (inventory || []).find((i: any) => String(i.id) === String(f.inventoryId));
  const saleQty = Number(f.quantity) || 0;
  const salePrice = f.sellingPrice ? Number(f.sellingPrice) : selectedItem?.sellingPriceGhs || 0;
  const saleTotal = saleQty * salePrice;
  const salePct = Math.max(0, Math.min(100, Number(f.discountPct) || 0));
  const saleNet = Math.round(saleTotal * (1 - salePct / 100) * 100) / 100;
  const restockCost = Number(f.unitCostGhs) || 0;
  const restockTotal = (Number(f.quantity) || 0) * restockCost;

  // Restock target resolution: master-list block type OR direct inventory item
  const restockTypeKey = String(f.restockTarget || "").startsWith("TYPE:") ? String(f.restockTarget).slice(5) : null;
  const restockTypeRow = restockTypeKey ? (blockTypes || []).find((t: any) => t.typeKey === restockTypeKey) : null;
  const restockTypeItem = restockTypeRow?.sku ? (inventory || []).find((i: any) => i.sku === restockTypeRow.sku) : null;
  const restockDirectItem = String(f.restockTarget || "").startsWith("ITEM:")
    ? (inventory || []).find((i: any) => String(i.id) === String(f.restockTarget).slice(5))
    : null;
  const restockItem = restockDirectItem || restockTypeItem || null;
  const restockIsNewType = f.restockTarget === ADD_NEW_TYPE;
  const restockQty = Number(f.quantity) || 0;

  const buildNewBlock = (payload: any) => {
    payload.__newBlock = {
      name: String(payload.newTypeName || "").trim(),
      dimensions: payload.newTypeDims,
      style: payload.newTypeStyle,
      defaultUnitPriceGhs: payload.newTypePrice,
      createInventoryItem: payload.newTypeInventory !== false,
    };
    delete payload.newTypeName;
    delete payload.newTypeDims;
    delete payload.newTypeStyle;
    delete payload.newTypePrice;
    delete payload.newTypeInventory;
  };

  const handle = (e: React.FormEvent) => {
    e.preventDefault();
    const payload = { ...f };
    if (type === "RESTOCK") {
      payload.totalCostGhs = restockTotal;
      const target = String(payload.restockTarget || "");
      delete payload.restockTarget;
      if (target === ADD_NEW_TYPE) {
        buildNewBlock(payload);            // parent saves the type, then sets payload.blockType
        delete payload.inventoryId;
      } else if (target.startsWith("TYPE:")) {
        payload.blockType = target.slice(5);
        delete payload.inventoryId;
      } else if (target.startsWith("ITEM:")) {
        payload.inventoryId = Number(target.slice(5));
        delete payload.blockType;
      }
    }
    if (type === "PRODUCTION" && payload.blockType === ADD_NEW_TYPE) {
      buildNewBlock(payload);
    }
    onSubmit(type, payload);
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"><div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto"><div className="flex items-center justify-between p-5 border-b border-slate-800 sticky top-0 bg-slate-900 z-10"><h3 className="text-lg font-bold text-white">{title}</h3><button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button></div><form onSubmit={handle} className="p-5 space-y-3">
    {type === "PRODUCTION" && <><div className="grid grid-cols-2 gap-3"><I label="Batch ID" k="batchId" placeholder="auto if blank" /><S label="Block Type" k="blockType" opts={[...blockTypeOptions, { v: ADD_NEW_TYPE, l: "➕ Add New Block Type…" }]} /><I label="Bags Cement Used" k="bagsCementUsed" t="number" required min={1} /><I label="Blocks Molded" k="blocksMolded" t="number" required min={1} /><I label="Blocks Broken" k="blocksBroken" t="number" min={0} /><S label="Quality" k="qualityGrade" opts={["GRADE_A_STANDARD", "GRADE_B_MINOR_DEFECT", "REJECTED"]} /><I label="Date" k="recordedDate" t="date" /></div>
    {f.blockType !== ADD_NEW_TYPE && (() => {
      const bt = (blockTypes || []).find((t: any) => t.typeKey === f.blockType);
      const it = bt?.sku ? (inventory || []).find((x: any) => x.sku === bt.sku) : null;
      const good = Math.max(0, (Number(f.blocksMolded) || 0) - (Number(f.blocksBroken) || 0));
      if (!good) return null;
      return (
        <div className="p-3 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-xs text-cyan-200">
          Production → Stock: +{good.toLocaleString()} good {f.blockType} blocks {it
            ? <>→ “{it.name}” ({it.sku}): {Number(it.quantity || 0).toLocaleString()} → {(Number(it.quantity || 0) + good).toLocaleString()} {it.unit}</>
            : <>→ a finished-goods stock item will be auto-created for this type</>}
        </div>
      );
    })()}
    {f.blockType === ADD_NEW_TYPE && <NewBlockTypePanel f={f} set={set} />}</>}
    {type === "ORDER" && <><div className="grid grid-cols-2 gap-3"><I label="Customer Name" k="customerName" required /><I label="Customer Phone" k="customerPhone" /><S label="Block Type" k="blockType" opts={blockTypeOptions} /><I label="Quantity" k="quantity" t="number" required min={1} /><I label="Unit Price (GH₵)" k="unitPriceGhs" t="number" step="0.01" required /><S label="Status" k="status" opts={["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"]} /><I label="Due Date" k="dueDate" t="date" /></div><I label="Notes" k="notes" /></>}
    {type === "DELIVERY" && <><div className="grid grid-cols-2 gap-3"><S label="Order" k="orderNumber" opts={[{ v: "", l: "— No linked order —" }, ...orders.map((o: any) => ({ v: o.orderNumber, l: `${o.orderNumber} • ${o.customerName}` }))]} /><I label="Customer" k="customerName" required /><S label="Block Type" k="blockType" opts={blockTypeOptions} /><I label="Quantity" k="quantity" t="number" required min={1} /><I label="Vehicle #" k="vehicleNumber" /><I label="Driver" k="driverName" /><S label="Status" k="status" opts={["SCHEDULED", "IN_TRANSIT", "DELIVERED", "CANCELLED"]} /><I label="Delivery Date" k="deliveryDate" t="date" /></div><I label="Notes" k="notes" /></>}
    {type === "EXPENSE" && <><div className="grid grid-cols-2 gap-3"><I label="Category" k="category" placeholder="Fuel, Cement, Payroll..." required list="blk-exp-cats" /><I label="Amount (GH₵)" k="amountGhs" t="number" step="0.01" required /><S label="Payment" k="paymentMethod" opts={["CASH", "MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER", "POS_CARD"]} /><I label="Date" k="date" t="date" /></div><I label="Description" k="description" /><datalist id="blk-exp-cats">{["Fuel & Diesel", "Cement Purchase", "Sand & Aggregates", "Payroll", "Machine Repair", "Transport", "Utilities", "Pallets", "Rent", "Miscellaneous"].map((c) => <option key={c} value={c} />)}</datalist></>}
    {type === "SALE" && <>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><label className="block text-[10px] text-slate-400 font-semibold mb-1">Product (from live stock — finished blocks first)</label>
          <select required value={f.inventoryId ?? ""} onChange={(e) => set("inventoryId", e.target.value)} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs">
            <option value="" disabled>— Select product —</option>
            {[...(inventory || [])]
              .sort((a: any, b: any) => {
                const blk = (x: any) => (/block|brick|paving/i.test(`${x.name} ${x.category}`) ? 0 : 1);
                return blk(a) - blk(b) || String(a.name).localeCompare(String(b.name));
              })
              .map((i: any) => {
                const out = (i.quantity || 0) <= 0 || i.status === "OUT_OF_STOCK";
                return (
                  <option key={i.id} value={i.id} disabled={out}>
                    {i.name} • {out ? "OUT OF STOCK" : `${Number(i.quantity).toLocaleString()} ${i.unit} available`} • {i.sellingPriceGhs} GH₵
                  </option>
                );
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
      {selectedItem && <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">Total due: <span className="font-black">GH₵ {saleNet.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>{salePct > 0 && <span> ({salePct}% discount)</span>} — sells {saleQty} {selectedItem.unit} of “{selectedItem.name}”. Stock after sale: {Math.max(0, (selectedItem.quantity || 0) - saleQty).toLocaleString()}.</div>}
      <I label="Notes" k="notes" />
    </>}
    {type === "RESTOCK" && <>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><label className="block text-[10px] text-slate-400 font-semibold mb-1">Stock To Receive — Block Production Master List</label>
          <select required value={f.restockTarget ?? ""} onChange={(e) => {
            const v = e.target.value;
            let cost: any = "";
            if (v.startsWith("TYPE:")) {
              const row = (blockTypes || []).find((t: any) => t.typeKey === v.slice(5));
              const it = row?.sku ? (inventory || []).find((x: any) => x.sku === row.sku) : null;
              cost = it?.costPriceGhs ?? "";
            } else if (v.startsWith("ITEM:")) {
              const it = (inventory || []).find((x: any) => String(x.id) === v.slice(5));
              cost = it?.costPriceGhs ?? "";
            }
            setF((prev: any) => ({ ...prev, restockTarget: v, unitCostGhs: cost }));
          }} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs">
            <option value="" disabled>— Select block type or inventory item —</option>
            <optgroup label="Block Types (Production Master List)">
              {(blockTypes || []).filter((t: any) => t.isActive !== false).map((t: any) => {
                const it = t.sku ? (inventory || []).find((x: any) => x.sku === t.sku) : null;
                return <option key={`T${t.id ?? t.typeKey}`} value={`TYPE:${t.typeKey}`}>{t.name} ({t.typeKey}) • {it ? `${Number(it.quantity).toLocaleString()} in stock` : "stock item auto-creates"}</option>;
              })}
            </optgroup>
            <optgroup label="Raw Materials & Other Inventory Items">
              {(inventory || []).map((i: any) => <option key={`I${i.id}`} value={`ITEM:${i.id}`}>{i.name} ({i.sku}) • {i.quantity} {i.unit} on hand</option>)}
            </optgroup>
            <option value={ADD_NEW_TYPE}>➕ Add New Block Type…</option>
          </select>
        </div>
        <I label="Quantity Received" k="quantity" t="number" required min={1} />
        <I label="Unit Cost (GH₵)" k="unitCostGhs" t="number" step="0.01" />
        <I label="Date" k="date" t="date" />
        <S label="Payment" k="paymentMethod" opts={["CASH", "MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER", "POS_CARD"]} />
      </div>
      {restockIsNewType && <NewBlockTypePanel f={f} set={set} />}
      {restockItem && restockQty > 0 && (
        <div className="p-3 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-200">
          Stock update: +{restockQty.toLocaleString()} → “{restockItem.name}” ({restockItem.sku}): {Number(restockItem.quantity || 0).toLocaleString()} → {(Number(restockItem.quantity || 0) + restockQty).toLocaleString()} {restockItem.unit}
        </div>
      )}
      {restockTypeKey && !restockTypeItem && (
        <div className="p-3 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-200">
          A finished-goods stock item will be auto-created for “{restockTypeRow?.name || restockTypeKey}” and topped up by {restockQty.toLocaleString() || "the received"} units — then available in Inventory, Sales and alerts.
        </div>
      )}
      <div className="flex items-center gap-2 p-3 rounded-lg bg-slate-800/70 border border-slate-700 text-xs">
        <input id="recordExpense" type="checkbox" checked={!!f.recordExpense} onChange={(e) => set("recordExpense", e.target.checked)} className="w-4 h-4 accent-indigo-500" />
        <label htmlFor="recordExpense" className="text-slate-300">Book purchase as expense ({restockTotal > 0 ? `GH₵ ${restockTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "no cost set"}) in Finance</label>
      </div>
      <I label="Description / Supplier note" k="description" placeholder="e.g. 200 bags Ghacem cement from Tema depot" />
    </>}
    {type === "ITEM" && <>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><I label="Item Name" k="name" required placeholder="e.g. Ghacem Cement 50kg Bag" /></div>
        <I label="SKU" k="sku" placeholder="auto if blank" />
        <I label="Category" k="category" placeholder="Raw Material / Concrete Blocks" list="blk-item-cats" />
        <I label="Opening Quantity" k="quantity" t="number" min={0} />
        <S label="Unit" k="unit" opts={["Units", "Bags", "Tons", "Kg", "Drums", "Litres", "m³"]} />
        <I label="Cost Price (GH₵)" k="costPriceGhs" t="number" step="0.01" />
        <I label="Selling Price (GH₵)" k="sellingPriceGhs" t="number" step="0.01" />
        <I label="Low-Stock Threshold" k="minStockThreshold" t="number" min={0} />
      </div>
      <datalist id="blk-item-cats">{["Raw Materials", "Concrete Blocks", "Paving & Bricks", "Spare Parts", "Consumables", "Finished Goods"].map((c) => <option key={c} value={c} />)}</datalist>
    </>}
    <div className="flex justify-end gap-3 pt-3 border-t border-slate-800"><button type="button" onClick={onClose} className="px-4 py-2 bg-slate-800 rounded-lg text-xs text-slate-300">Cancel</button><button disabled={busy} className="px-5 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-xs font-bold text-white disabled:opacity-50">{busy ? "Saving..." : "Save"}</button></div>
  </form></div></div>;
}

/** Inline "Add New Block Type" editor — shared by the Production and Restock
 *  forms. Saves to the block production master list (+ an optional linked
 *  finished-goods stock item) so the type is reusable in production,
 *  restocking, inventory, sales, filters and reports. */
function NewBlockTypePanel({ f, set }: any) {
  const inp = (k: string, opts: any = {}) => (
    <input
      type={opts.t || "text"}
      value={f[k] ?? ""}
      onChange={(e) => set(k, opts.t === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
      placeholder={opts.placeholder}
      required={opts.required}
      min={opts.min}
      step={opts.step}
      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs"
    />
  );
  return (
    <div className="p-3 rounded-xl border border-cyan-500/40 bg-cyan-500/5 space-y-3">
      <div className="text-[11px] font-bold text-cyan-300 uppercase tracking-wide">New Block Type — saved to master list</div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="block text-[10px] text-slate-400 font-semibold mb-1">Type / Name</label>{inp("newTypeName", { placeholder: "e.g. 8-Inch Hollow Blocks", required: true })}</div>
        <div><label className="block text-[10px] text-slate-400 font-semibold mb-1">Dimensions / Specs</label>{inp("newTypeDims", { placeholder: "8in x 8in x 16in" })}</div>
        <div><label className="block text-[10px] text-slate-400 font-semibold mb-1">Style</label>
          <select value={f.newTypeStyle ?? "SOLID"} onChange={(e) => set("newTypeStyle", e.target.value)} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs">
            {["SOLID", "HOLLOW", "PAVING", "INTERLOCKING", "OTHER"].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div><label className="block text-[10px] text-slate-400 font-semibold mb-1">Default Unit Price (GH₵)</label>{inp("newTypePrice", { t: "number", step: "0.01", min: 0, placeholder: "optional" })}</div>
      </div>
      <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
        <input type="checkbox" checked={f.newTypeInventory !== false} onChange={(e) => set("newTypeInventory", e.target.checked)} className="accent-cyan-500 w-3.5 h-3.5" />
        Also add to inventory &amp; sales catalog — production, restocking and sales then track stock for this type automatically
      </label>
      <p className="text-[10px] text-slate-500">The type is stored in the block production master list and becomes selectable in future production, restocking, orders, deliveries, filters and reports.</p>
    </div>
  );
}
