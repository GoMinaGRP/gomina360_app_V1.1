"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import AiSectionGuide from "./AiSectionGuide";
import {
  HardHat, Package, AlertTriangle, TrendingUp, Wallet, Activity, Boxes,
  Users, Truck, FileText, RefreshCw, LayoutDashboard, ClipboardList,
  UserCog, X, Plus, CheckCircle2, ClipboardCheck, Sparkles, ShoppingCart,
  Hammer, MapPin,
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
  suppliers: any[];
  transactions: any[];
  assets: any[];
  employees: any[];
  currentCurrency: CurrencyCode;
  onRefreshData: () => void;
};

type Tab = "DASHBOARD" | "STOCK" | "ORDERS" | "DELIVERIES" | "FINANCE" | "YARD_OPS" | "CHECKLIST";
type FormType = "SALE" | "EXPENSE" | "ITEM" | "ORDER" | "PURCHASE" | "DELIVERY" | "GRN" | null;

const TABS: { key: Tab; label: string; icon: any }[] = [
  { key: "DASHBOARD", label: "Dashboard", icon: LayoutDashboard },
  { key: "STOCK", label: "Stock & Materials", icon: Boxes },
  { key: "ORDERS", label: "Orders & Purchases", icon: ClipboardList },
  { key: "DELIVERIES", label: "Site Deliveries", icon: Truck },
  { key: "FINANCE", label: "Finance & Reports", icon: Wallet },
  { key: "YARD_OPS", label: "Staff & Yard Ops", icon: UserCog },
  { key: "CHECKLIST", label: "Daily Checklist", icon: ClipboardCheck },
];

const PAY_COLORS = ["#f59e0b", "#10b981", "#06b6d4", "#a855f7", "#ec4899", "#3b82f6"];

const STATUS_STYLE: Record<string, string> = {
  PENDING: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  READY: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  DELIVERED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  CANCELLED: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  ORDERED: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  RECEIVED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  SCHEDULED: "bg-blue-500/15 text-blue-300 border-blue-500/40",
  EN_ROUTE: "bg-purple-500/15 text-purple-300 border-purple-500/40",
  IN_STOCK: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  LOW_STOCK: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  OUT_OF_STOCK: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  GOOD: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  PARTIAL: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  DAMAGED: "bg-rose-500/15 text-rose-300 border-rose-500/40",
};
const Badge = ({ s }: { s: string }) => (
  <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${STATUS_STYLE[s] || "bg-slate-700/40 text-slate-300 border-slate-600"}`}>{s}</span>
);

export default function HardwareStoreModule({
  currentUser, businessInfo, businessMetrics, inventory, customers, suppliers,
  transactions, assets, employees, currentCurrency, onRefreshData,
}: Props) {
  const bizId = businessInfo?.id;
  const bizCode = businessInfo?.code || "HARDWARE-01";
  const today = new Date().toISOString().split("T")[0];

  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("DASHBOARD");
  const [orders, setOrders] = useState<any[]>([]);
  const [purchases, setPurchases] = useState<any[]>([]);
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [opsLogs, setOpsLogs] = useState<any[]>([]);
  const [showForm, setShowForm] = useState<FormType>(null);
  const [trackItem, setTrackItem] = useState<{ type: "ORDER" | "DELIVERY"; row: any } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!bizId) return;
    try {
      const [hRes, lRes] = await Promise.all([
        fetch(`/api/hardware?businessId=${bizId}`),
        fetch(`/api/logs/${bizCode}`),
      ]);
      const hD = await hRes.json();
      const lD = await lRes.json();
      if (hD.success) {
        setOrders(hD.orders || []);
        setPurchases(hD.purchases || []);
        setDeliveries(hD.deliveries || []);
      }
      if (lD.success) setOpsLogs((lD.logs || []).filter((l: any) => l.businessId === bizId));
    } finally {
      setLoading(false);
    }
  }, [bizId, bizCode]);

  useEffect(() => { refresh(); }, [refresh]);

  // ── Shared enterprise data scoped to this branch ─────────────────────
  const branchInventory = useMemo(() => inventory.filter((i) => i.businessId === bizId), [inventory, bizId]);
  const branchAssets = useMemo(() => assets.filter((a) => a.businessId === bizId), [assets, bizId]);
  const branchEmployees = useMemo(() => employees.filter((e) => e.businessId === bizId), [employees, bizId]);
  const branchCustomers = useMemo(() => customers.filter((c) => c.businessId === bizId), [customers, bizId]);
  const branchTx = useMemo(() => transactions.filter((t) => t.businessId === bizId), [transactions, bizId]);

  const income = useMemo(() => branchTx.filter((t) => t.type === "INCOME"), [branchTx]);
  const expenses = useMemo(() => branchTx.filter((t) => t.type === "EXPENSE"), [branchTx]);
  const revenue = income.reduce((s, t) => s + (t.amountGhs || 0), 0);
  const expenseTotal = expenses.reduce((s, t) => s + (t.amountGhs || 0), 0);
  const profit = revenue - expenseTotal;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  // Cash & payment mix
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

  // Orders pipeline
  const openOrders = orders.filter((o) => ["PENDING", "READY"].includes(o.status));
  const deliveredOrders = orders.filter((o) => o.status === "DELIVERED");
  const orderPipelineValue = openOrders.reduce((s, o) => s + (o.totalGhs || 0), 0);
  const unitsSold = deliveredOrders.reduce((s, o) => s + (o.quantity || 0), 0);

  // Deliveries
  const activeDeliveries = deliveries.filter((d) => ["SCHEDULED", "EN_ROUTE"].includes(d.status));
  const completedDeliveries = deliveries.filter((d) => d.status === "DELIVERED");
  const enRouteAging = activeDeliveries.filter((d) => d.status === "EN_ROUTE" && d.dispatchDate && (Date.now() - new Date(d.dispatchDate).getTime()) > 2 * 86400e3);

  // Purchases
  const openPurchaseValue = purchases.filter((p) => p.status === "ORDERED").reduce((s, p) => s + (p.totalGhs || 0), 0);
  const receivedSpend = purchases.filter((p) => p.status === "RECEIVED").reduce((s, p) => s + (p.totalGhs || 0), 0);
  const hardwareSuppliers = useMemo(
    () => suppliers.filter((s) => /cement|steel|hardware|build|construct|timber|paint|roof|aggregate|plumb|electrical/i.test(s.category || "") || purchases.some((p) => p.supplierName === s.name)),
    [suppliers, purchases]
  );

  // Top-selling materials
  const productSales = useMemo(() => {
    const m: Record<string, { name: string; qty: number; revenue: number }> = {};
    orders.filter((o) => o.status !== "CANCELLED").forEach((o) => {
      if (!m[o.itemName]) m[o.itemName] = { name: o.itemName, qty: 0, revenue: 0 };
      m[o.itemName].qty += o.quantity || 0;
      m[o.itemName].revenue += o.totalGhs || 0;
    });
    // Direct counter sales (via Record Sale) also rank products
    income.filter((t) => /hardware_sale|SALE/i.test(t.category || "")).forEach((t) => {
      const key = "Counter sales (till)";
      if (!m[key]) m[key] = { name: key, qty: 0, revenue: 0 };
      m[key].revenue += t.amountGhs || 0;
    });
    return Object.values(m).sort((a, b) => b.revenue - a.revenue);
  }, [orders, income]);
  const topProducts = productSales.slice(0, 5);
  const bestSeller = topProducts[0];
  const totalProductRevenue = productSales.reduce((s, p) => s + p.revenue, 0);
  const bestSellerShare = bestSeller && totalProductRevenue > 0 ? Math.round((bestSeller.revenue / totalProductRevenue) * 100) : 0;

  // Per-SKU performance
  const productPerformance = useMemo(() => branchInventory.map((i) => {
    const soldOrders = deliveredOrders.filter((o) => o.inventoryId === i.id);
    const soldQty = soldOrders.reduce((s, o) => s + (o.quantity || 0), 0);
    const estRevenue = soldOrders.reduce((s, o) => s + (o.totalGhs || 0), 0);
    const received = opsLogs.filter((l) => {
      const key = String(l.itemName || "").toUpperCase().slice(0, 12);
      return i.name?.toUpperCase().includes(key) || key.includes(String(i.name || "").toUpperCase().slice(0, 12));
    }).reduce((s, l) => s + (l.quantityReceived || 0), 0);
    const marginPct = i.sellingPriceGhs > 0 ? Math.round(((i.sellingPriceGhs - (i.costPriceGhs || 0)) / i.sellingPriceGhs) * 100) : 0;
    return { ...i, soldQty, estRevenue, received, marginPct, stockValue: (i.quantity || 0) * (i.costPriceGhs || 0) };
  }).sort((a, b) => b.estRevenue - a.estRevenue), [branchInventory, deliveredOrders, opsLogs]);

  // Staff performance
  const staffPerformance = useMemo(() => {
    const m: Record<string, { name: string; sales: number; salesAmt: number; expenses: number; receipts: number }> = {};
    branchTx.forEach((t) => {
      const k = t.recordedBy || "Unknown";
      if (!m[k]) m[k] = { name: k, sales: 0, salesAmt: 0, expenses: 0, receipts: 0 };
      if (t.type === "INCOME") { m[k].sales++; m[k].salesAmt += t.amountGhs || 0; }
      if (t.type === "EXPENSE") m[k].expenses++;
    });
    opsLogs.forEach((l) => {
      const k = l.receivedBy || "Unknown";
      if (!m[k]) m[k] = { name: k, sales: 0, salesAmt: 0, expenses: 0, receipts: 0 };
      m[k].receipts++;
    });
    const rows = Object.values(m).sort((a, b) => b.salesAmt - a.salesAmt);
    branchEmployees.forEach((e) => { if (!m[e.name]) rows.push({ name: e.name, sales: 0, salesAmt: 0, expenses: 0, receipts: 0 }); });
    return rows;
  }, [branchTx, opsLogs, branchEmployees]);

  // AI Business Insights (rule-based decision support) — hardware-flavoured
  const recentDamaged = opsLogs.filter((l) => l.condition === "DAMAGED" && l.recordedDate && (Date.now() - new Date(l.recordedDate).getTime()) <= 30 * 86400e3);
  const insights = useMemo(() => {
    const out: { level: "POSITIVE" | "WARNING" | "CRITICAL" | "INFO"; title: string; detail: string }[] = [];
    const lowStock = branchInventory.filter((i) => i.status === "LOW_STOCK" || i.status === "OUT_OF_STOCK");
    const fastMoversLow = lowStock.filter((i) => /cement|rod|iron|nail|roof|sand|paint/i.test(i.name || ""));
    fastMoversLow.forEach((i) => out.push({
      level: i.status === "OUT_OF_STOCK" ? "CRITICAL" : "WARNING",
      title: `${i.name} — ${i.status.replace("_", " ")}`,
      detail: `${i.quantity} ${i.unit || "units"} left (minimum ${i.minStockThreshold}). Fast-moving building material — raise a supplier purchase before contractors are turned away.`,
    }));
    if (bestSeller && bestSellerShare > 45) out.push({
      level: "WARNING", title: "Revenue concentration risk",
      detail: `${bestSeller.name} drives ${bestSellerShare}% of tracked material revenue — keep alternate stock lines strong so one supplier issue cannot stall the yard.`,
    });
    if (enRouteAging.length > 0) out.push({
      level: "WARNING", title: `${enRouteAging.length} site delivery(ies) en route > 2 days`,
      detail: "Confirm driver/logistics status and update the customer — late material drops stall site work and damage repeat business.",
    });
    if (recentDamaged.length > 0) out.push({
      level: "WARNING", title: `${recentDamaged.length} damaged receipt(s) in 30 days`,
      detail: "Escalate with the supplier and photograph future GRNs before acceptance — repeated damage erodes already thin hardware margins.",
    });
    if (orderPipelineValue > 0) out.push({
      level: "INFO", title: `${formatMoney(orderPipelineValue, currentCurrency, true)} in open orders`,
      detail: `${openOrders.length} order(s) awaiting fulfilment — reserve the stock and confirm delivery windows.`,
    });
    if (margin < 18 && revenue > 0) out.push({
      level: "WARNING", title: `Margin at ${margin.toFixed(1)}%`,
      detail: "Hardware retail typically targets 18–28% — review selling prices against landed cost and delivery expenses.",
    });
    if (revenue > 0 && cashTotal === 0 && momoTotal === 0) out.push({
      level: "INFO", title: "All receipts are non-cash",
      detail: "Keep a till/MoMo float ready for walk-in yard customers at peak morning hours.",
    });
    if (out.length === 0) out.push({ level: "POSITIVE", title: "Yard operations look healthy", detail: "No critical stock, delivery or cash exposure detected today." });
    return out;
  }, [branchInventory, bestSeller, bestSellerShare, enRouteAging.length, recentDamaged.length, orderPipelineValue, openOrders.length, margin, revenue, cashTotal, momoTotal, currentCurrency]);

  // Charts
  const recentTx = useMemo(() => branchTx.slice().sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 10), [branchTx]);
  const salesByDate = useMemo(() => {
    const m: Record<string, number> = {};
    income.forEach((t) => { m[t.date] = (m[t.date] || 0) + (t.amountGhs || 0); });
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])).slice(-14).map(([date, value]) => ({ date: date.slice(5), value }));
  }, [income]);

  // Alerts strip
  const alerts = useMemo(() => {
    const list: { color: string; text: string }[] = [];
    branchInventory.filter((i) => i.status !== "IN_STOCK").forEach((i) => list.push({ color: "rose", text: `${i.name} is ${i.status.replace("_", " ")} (${i.quantity} left ≤ min ${i.minStockThreshold})` }));
    orders.filter((o) => o.status === "PENDING" && o.dueDate && o.dueDate < today).forEach((o) => list.push({ color: "amber", text: `Order ${o.orderNumber} overdue (due ${o.dueDate})` }));
    enRouteAging.forEach((d) => list.push({ color: "amber", text: `Delivery ${d.deliveryNumber} en route since ${d.dispatchDate}` }));
    if (profit < 0) list.push({ color: "rose", text: "Branch is loss-making on recorded transactions" });
    return list;
  }, [branchInventory, orders, enRouteAging, profit, today]);

  // ── Submit router ─────────────────────────────────────────────────────
  const submit = async (entity: FormType, data: any) => {
    setBusy(true); setError("");
    try {
      let d: any;
      if (entity === "SALE") {
        const res = await fetch("/api/sales", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessId: bizId, branchCode: bizCode,
            customerName: data.customerName, customerPhone: data.customerPhone,
            paymentMethod: data.paymentMethod, notes: data.notes,
            discount: Number(data.discount) || 0,
            discountPercent: data.discountPct ? Number(data.discountPct) : undefined,
            cartItems: [{ inventoryId: Number(data.inventoryId), quantity: Number(data.quantity), sellingPrice: data.sellingPrice ? Number(data.sellingPrice) : undefined, originalPrice: data.sellingPrice ? Number(data.sellingPrice) : undefined, customPriceReason: data.customPriceReason }],
            createdByUserId: currentUser?.id, createdByName: currentUser?.name, createdByRole: currentUser?.role,
          }),
        });
        d = await res.json();
      } else if (entity === "ITEM") {
        const res = await fetch("/api/enterprise", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entityType: "inventory", data: { ...data, businessId: bizId } }),
        });
        d = await res.json();
      } else if (entity === "EXPENSE") {
        const res = await fetch("/api/transactions", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessId: bizId, branchCode: bizCode, branchName: businessInfo?.name,
            type: "EXPENSE", category: data.category, amountGhs: Number(data.amountGhs) || 0,
            paymentMethod: data.paymentMethod || "CASH", description: data.description || data.category,
            date: data.date || today,
            recordedBy: currentUser?.name || "Staff", recordedByRole: currentUser?.role || "STAFF", recordedByUserId: currentUser?.id || null,
            status: "COMPLETED",
          }),
        });
        d = await res.json();
      } else if (entity === "GRN") {
        // Goods Received Note → yard ops log with stock-in + expense linkage
        const res = await fetch(`/api/logs/${bizCode}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            supplierName: data.supplierName, itemName: data.itemName,
            quantityReceived: Number(data.quantityReceived) || 0,
            unit: data.unit || "Units",
            unitCostGhs: Number(data.unitCostGhs) || 0,
            condition: data.condition || "GOOD",
            receivedBy: data.receivedBy || currentUser?.name,
            recordedByRole: currentUser?.role, recordedByUserId: currentUser?.id,
            paymentMethod: data.paymentMethod || "BANK_TRANSFER",
            recordExpense: data.recordExpense !== false,
          }),
        });
        d = await res.json();
      } else {
        const res = await fetch("/api/hardware", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entity,
            data: {
              ...data, businessId: bizId, branchCode: bizCode,
              createdByName: currentUser?.name, createdByRole: currentUser?.role, createdByUserId: currentUser?.id,
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

  const patchEntity = async (entity: string, id: number, data: any) => {
    try {
      const res = await fetch("/api/hardware", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity, id, data: { ...data, actorName: currentUser?.name, actorRole: currentUser?.role } }),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error);
      await refresh();
      onRefreshData();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const Stat = ({ label, value, sub, color = "amber", icon: Icon, testid }: any) => {
    const C: Record<string, string> = {
      emerald: "text-emerald-400", cyan: "text-cyan-400", rose: "text-rose-400",
      amber: "text-amber-400", purple: "text-purple-400", blue: "text-blue-400",
      orange: "text-orange-400",
    };
    return (
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4" data-testid={testid}>
        <div className="flex items-center justify-between text-[10px] uppercase font-bold text-slate-400">
          <span>{label}</span>{Icon && <Icon className={`w-4 h-4 ${C[color]}`} />}
        </div>
        <div className={`text-xl font-black ${C[color]} mt-1`} data-testid={testid ? `${testid}-value` : undefined}>{value}</div>
        {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
      </div>
    );
  };

  const Card = ({ title, icon: Icon, children, action, testid }: any) => (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/60 overflow-hidden" data-testid={testid}>
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-700/70 bg-slate-800/80">
        <div className="flex items-center gap-2">{Icon && <Icon className="w-4 h-4 text-amber-400" />}<h3 className="text-sm font-bold text-white">{title}</h3></div>
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

  const nextOrderStatus: Record<string, string> = { PENDING: "READY", READY: "DELIVERED" };
  const nextPurchaseStatus: Record<string, string> = { ORDERED: "RECEIVED" };
  const nextDeliveryStatus: Record<string, string> = { SCHEDULED: "EN_ROUTE", EN_ROUTE: "DELIVERED" };

  if (loading) {
    return <div className="p-10 text-center text-slate-400 text-sm">Loading Hardware &amp; Building Materials workspace…</div>;
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto text-slate-100" data-testid="hardware-module">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-amber-950/30 to-slate-900 p-6 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-slate-800 border border-amber-500/40 flex items-center justify-center shadow-lg shrink-0">
            <HardHat className="w-7 h-7 text-amber-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 text-xs font-bold border border-amber-500/30">HARDWARE &amp; BUILDING MATERIALS</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 text-white">{businessInfo?.name || "Hardware & Building Materials Depot"}</h2>
            <p className="text-xs text-slate-400 mt-1">{bizCode} • {businessInfo?.branchLocation || "Ghana"} • Manager: <strong className="text-amber-300">{businessInfo?.managerName || "Depot Manager"}</strong></p>
          </div>
        </div>
        {error && <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/40 rounded-lg px-3 py-2" data-testid="hw-error">{error}<button className="ml-2 text-rose-200" onClick={() => setError("")}>✕</button></div>}
        <div className="flex flex-wrap gap-2">
          <button data-testid="hw-open-sale" onClick={() => setShowForm("SALE")} className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold flex items-center gap-1"><TrendingUp className="w-3.5 h-3.5" />Sale</button>
          <button data-testid="hw-open-order" onClick={() => setShowForm("ORDER")} className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1"><ShoppingCart className="w-3.5 h-3.5" />Order</button>
          <button data-testid="hw-open-purchase" onClick={() => setShowForm("PURCHASE")} className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><Truck className="w-3.5 h-3.5" />Purchase</button>
          <button data-testid="hw-open-delivery" onClick={() => setShowForm("DELIVERY")} className="px-3 py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-bold flex items-center gap-1"><HardHat className="w-3.5 h-3.5" />Delivery</button>
          <button data-testid="hw-open-grn" onClick={() => setShowForm("GRN")} className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center gap-1"><ClipboardCheck className="w-3.5 h-3.5" />GRN</button>
          <button data-testid="hw-open-expense" onClick={() => setShowForm("EXPENSE")} className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold flex items-center gap-1"><Wallet className="w-3.5 h-3.5" />Expense</button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex flex-wrap gap-1 bg-slate-800/60 border border-slate-700 rounded-xl p-1">
        {TABS.map((t) => (
          <button key={t.key} data-testid={`hw-tab-${t.key}`} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition ${tab === t.key ? "bg-amber-600 text-white" : "text-slate-400 hover:text-white"}`}>
            <t.icon className="w-3.5 h-3.5" />{t.label}
          </button>
        ))}
        <AiSectionGuide moduleKey="HARDWARE" section={tab} businessInfo={businessInfo} />
      </div>

      {alerts.length > 0 && tab === "DASHBOARD" && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-1" data-testid="hw-alerts">
          {alerts.slice(0, 5).map((a, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-amber-200"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{a.text}</div>
          ))}
        </div>
      )}

      {/* ══════════════ DASHBOARD ══════════════ */}
      {tab === "DASHBOARD" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat testid="hw-stat-revenue" label="Revenue" value={formatMoney(revenue, currentCurrency, true)} sub={`${income.length} receipts`} color="emerald" icon={TrendingUp} />
            <Stat testid="hw-stat-profit" label="Net Profit" value={formatMoney(profit, currentCurrency, true)} sub={`${margin.toFixed(1)}% margin`} color={profit >= 0 ? "amber" : "rose"} icon={Activity} />
            <Stat testid="hw-stat-orders" label="Orders" value={orders.length} sub={`${openOrders.length} open • ${formatMoney(orderPipelineValue, currentCurrency, true)} pipeline`} color="amber" icon={ShoppingCart} />
            <Stat testid="hw-stat-units" label="Units Sold" value={unitsSold} sub="delivered orders" color="purple" icon={Package} />
            <Stat testid="hw-stat-stock" label="SKU Stock" value={branchInventory.reduce((s, i) => s + (i.quantity || 0), 0)} sub={`${branchInventory.length} materials`} color="blue" icon={Boxes} />
            <Stat testid="hw-stat-deliveries" label="Deliveries Out" value={activeDeliveries.length} sub={`${completedDeliveries.length} completed`} color="orange" icon={Truck} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card title="Cash & Payment Summary" icon={Wallet} testid="hw-card-payments">
              <div className="p-4 space-y-3">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="p-2 rounded-lg bg-slate-900/70 border border-slate-700"><div className="text-[10px] uppercase text-slate-500 font-bold">Cash</div><div className="text-sm font-black text-emerald-300">{formatMoney(cashTotal, currentCurrency, true)}</div></div>
                  <div className="p-2 rounded-lg bg-slate-900/70 border border-slate-700"><div className="text-[10px] uppercase text-slate-500 font-bold">MoMo</div><div className="text-sm font-black text-amber-300">{formatMoney(momoTotal, currentCurrency, true)}</div></div>
                  <div className="p-2 rounded-lg bg-slate-900/70 border border-slate-700"><div className="text-[10px] uppercase text-slate-500 font-bold">Expenses</div><div className="text-sm font-black text-rose-300">{formatMoney(expenseTotal, currentCurrency, true)}</div></div>
                </div>
                {paymentMix.length > 0 ? (
                  <div className="h-36">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart><Pie data={paymentMix} dataKey="total" nameKey="method" innerRadius={35} outerRadius={55} paddingAngle={2}>
                        {paymentMix.map((p, i) => <Cell key={p.method} fill={PAY_COLORS[i % PAY_COLORS.length]} />)}
                      </Pie><Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }} formatter={(v: any) => formatMoney(Number(v), currentCurrency)} /></PieChart>
                    </ResponsiveContainer>
                  </div>
                ) : <p className="text-xs text-slate-500 text-center py-4">No receipts yet today.</p>}
              </div>
            </Card>

            <Card title="Top-Selling Materials" icon={TrendingUp} testid="hw-card-top">
              <div className="p-4 space-y-2">
                {topProducts.length === 0 && <p className="text-xs text-slate-500 text-center py-4">Record a sale or customer order to rank materials.</p>}
                {topProducts.map((p, i) => {
                  const max = topProducts[0]?.revenue || 1;
                  return (
                    <div key={p.name} className="p-2.5 rounded-lg bg-slate-900/70 border border-slate-700">
                      <div className="flex justify-between text-xs gap-2">
                        <span className="font-semibold text-slate-200 truncate"><span className="text-amber-400 font-black mr-1">#{i + 1}</span>{p.name}</span>
                        <span className="font-bold text-emerald-300 shrink-0">{formatMoney(p.revenue, currentCurrency, true)}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <div className="flex-1 h-1.5 rounded-full bg-slate-700 overflow-hidden"><div className="h-full bg-amber-500 rounded-full" style={{ width: `${Math.max(4, (p.revenue / max) * 100)}%` }} /></div>
                        <span className="text-[10px] text-slate-500">{p.qty} sold</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            <Card title="AI Business Insights" icon={Sparkles} testid="hw-ai-insights">
              <div className="p-4 space-y-2 max-h-80 overflow-y-auto">
                {insights.map((ins, i) => {
                  const S: Record<string, string> = {
                    CRITICAL: "border-rose-500/40 bg-rose-500/10 text-rose-200",
                    WARNING: "border-amber-500/40 bg-amber-500/10 text-amber-200",
                    INFO: "border-cyan-500/40 bg-cyan-500/10 text-cyan-200",
                    POSITIVE: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
                  };
                  return (
                    <div key={i} className={`p-2.5 rounded-lg border text-xs ${S[ins.level]}`}>
                      <div className="font-bold">{ins.title}</div>
                      <div className="text-[11px] opacity-85 mt-0.5">{ins.detail}</div>
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Receipts Trend (last 14 days with sales)" icon={Activity}>
              <div className="p-4">
                {salesByDate.length > 0 ? (
                  <ResponsiveContainer width="100%" height={210}>
                    <AreaChart data={salesByDate}><XAxis dataKey="date" stroke="#94a3b8" style={{ fontSize: 10 }} /><YAxis stroke="#94a3b8" style={{ fontSize: 10 }} /><Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }} formatter={(v: any) => formatMoney(Number(v), currentCurrency)} /><Area type="monotone" dataKey="value" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.25} /></AreaChart>
                  </ResponsiveContainer>
                ) : <p className="text-xs text-slate-500 text-center py-10">No receipts recorded yet.</p>}
              </div>
            </Card>
            <Card title="Material Performance" icon={BarChart as any}>
              <DataTable headers={["Material", "Stock", "Sold", "Received", "Est. Revenue", "Margin", "Status"]}
                rows={productPerformance.slice(0, 6).map((p) => [
                  <span key="n" className="font-semibold text-slate-200">{p.name}</span>,
                  `${p.quantity} / min ${p.minStockThreshold}`,
                  p.soldQty,
                  p.received,
                  formatMoney(p.estRevenue, currentCurrency, true),
                  `${p.marginPct}%`,
                  <Badge key="s" s={p.status || "IN_STOCK"} />,
                ])} />
            </Card>
          </div>

          <Card title="Recent Transactions" icon={FileText} testid="hw-recent-tx">
            <DataTable headers={["Date", "Reference", "Type", "Category", "Method", "Amount", "Recorded By"]}
              rows={recentTx.map((t) => [
                t.date, t.transactionNumber,
                <Badge key="t" s={t.type === "INCOME" ? "RECEIVED" : t.type === "EXPENSE" ? "PARTIAL" : "PENDING"} />,
                t.category, (t.paymentMethod || "").replaceAll("_", " "),
                <span key="a" className={t.type === "INCOME" ? "text-emerald-300 font-bold" : "text-rose-300 font-bold"}>{formatMoney(t.amountGhs, currentCurrency, true)}</span>,
                t.recordedBy,
              ])} />
          </Card>
        </div>
      )}

      {/* ══════════════ STOCK & MATERIALS ══════════════ */}
      {tab === "STOCK" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Materials" value={branchInventory.length} sub="SKUs at this yard" color="amber" icon={Boxes} />
            <Stat label="Units On Hand" value={branchInventory.reduce((s, i) => s + (i.quantity || 0), 0)} sub="all materials" color="blue" icon={Package} />
            <Stat label="Stock Cost Value" value={formatMoney(branchInventory.reduce((s, i) => s + (i.quantity || 0) * (i.costPriceGhs || 0), 0), currentCurrency, true)} sub="at cost price" color="emerald" icon={Wallet} />
            <Stat label="Low / Out of Stock" value={branchInventory.filter((i) => i.status !== "IN_STOCK").length} sub="need reorder" color="rose" icon={AlertTriangle} />
          </div>
          <Card title="Materials, Stock Levels & Movement" icon={Package} testid="hw-stock-card"
            action={<div className="flex gap-2">
              <button data-testid="hw-stock-new-item" onClick={() => setShowForm("ITEM")} className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />New Material</button>
              <button onClick={() => setShowForm("PURCHASE")} className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><Truck className="w-3.5 h-3.5" />Restock (Purchase)</button>
            </div>}>
            <DataTable headers={["Material", "SKU", "Qty", "Cost", "Price", "Sold", "Received", "Margin", "Status"]}
              rows={productPerformance.map((p) => [
                <span key="n" className="font-semibold text-slate-200">{p.name}</span>,
                p.sku, p.quantity,
                formatMoney(p.costPriceGhs, currentCurrency, true),
                formatMoney(p.sellingPriceGhs, currentCurrency, true),
                p.soldQty, p.received,
                `${p.marginPct}%`,
                <Badge key="s" s={p.status || "IN_STOCK"} />,
              ])} />
            <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Sales and outgoing site deliveries deduct stock automatically; supplier purchases and Goods-Received Notes add it back and book the expense to Finance in one step.</p>
          </Card>
        </div>
      )}

      {/* ══════════════ ORDERS & PURCHASES ══════════════ */}
      {tab === "ORDERS" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Open Orders" value={openOrders.length} sub={`${formatMoney(orderPipelineValue, currentCurrency, true)} pipeline`} color="amber" icon={ShoppingCart} />
            <Stat label="Delivered Orders" value={deliveredOrders.length} sub={`${unitsSold} units fulfilled`} color="emerald" icon={CheckCircle2} />
            <Stat label="Purchases Received" value={purchases.filter((p) => p.status === "RECEIVED").length} sub={`${formatMoney(receivedSpend, currentCurrency, true)} supplier spend`} color="purple" icon={Truck} />
            <Stat label="On Order" value={purchases.filter((p) => p.status === "ORDERED").length} sub={`${formatMoney(openPurchaseValue, currentCurrency, true)} inbound`} color="blue" icon={RefreshCw} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 space-y-4">
              <Card title="Customer Orders" icon={ShoppingCart} testid="hw-orders-card"
                action={<button onClick={() => setShowForm("ORDER")} className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />New Order</button>}>
                <DataTable headers={["Order #", "Customer", "Material", "Qty", "Total", "Due", "Site", "Status", ""]}
                  rows={orders.map((o) => [
                    o.orderNumber, o.customerName, o.itemName, o.quantity,
                    formatMoney(o.totalGhs, currentCurrency, true), o.dueDate || "—", o.deliverySite || "—",
                    <Badge key="s" s={o.status} />,
                    <span key="a" className="flex items-center gap-1.5 justify-end">
                      <button data-testid={`hw-order-track-${o.id}`} onClick={() => setTrackItem({ type: "ORDER", row: o })} className="px-2 py-1 rounded bg-sky-500/20 border border-sky-500/40 text-sky-300 text-[10px] font-bold flex items-center gap-1 hover:bg-sky-500/30"><MapPin className="w-3 h-3" />Track</button>
                      {nextOrderStatus[o.status]
                        ? <button data-testid={`hw-order-adv-${o.id}`} onClick={() => patchEntity("ORDER", o.id, { status: nextOrderStatus[o.status] })} className="px-2 py-1 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[10px] font-bold">→ {nextOrderStatus[o.status]}</button>
                        : null}
                    </span>,
                  ])} />
                <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Fulfilling (delivering) an order deducts the stock and books the revenue to Finance automatically.</p>
              </Card>
              <Card title="Supplier Purchases" icon={Truck} testid="hw-purchases-card"
                action={<button data-testid="hw-new-purchase" onClick={() => setShowForm("PURCHASE")} className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />Record Purchase</button>}>
                <DataTable headers={["PO #", "Supplier", "Material", "Qty", "Total", "Ordered", "Status", ""]}
                  rows={purchases.map((p) => [
                    p.purchaseNumber, p.supplierName, p.itemName, p.quantity,
                    formatMoney(p.totalGhs, currentCurrency, true), p.orderDate,
                    <Badge key="s" s={p.status} />,
                    nextPurchaseStatus[p.status]
                      ? <button key="a" data-testid={`hw-purchase-adv-${p.id}`} onClick={() => patchEntity("PURCHASE", p.id, { status: nextPurchaseStatus[p.status], recordExpense: true })} className="px-2 py-1 rounded bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 text-[10px] font-bold">→ {nextPurchaseStatus[p.status]}</button>
                      : "—",
                  ])} />
              </Card>
            </div>
            <Card title="Suppliers" icon={Users}>
              <div className="p-4 space-y-2">
                {(hardwareSuppliers.length ? hardwareSuppliers : suppliers).map((s) => (
                  <div key={s.id} className="p-2.5 rounded-lg bg-slate-900/70 border border-slate-700 text-xs">
                    <div className="flex justify-between gap-2"><span className="font-semibold text-slate-200">{s.name}</span><span className="text-[10px] text-slate-500">{s.paymentTerms?.replaceAll("_", " ")}</span></div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{s.category}</div>
                    <div className="text-[10px] text-purple-300 mt-0.5 font-bold">Purchases here: {formatMoney(purchases.filter((p) => p.supplierName === s.name && p.status !== "CANCELLED").reduce((t, p) => t + (p.totalGhs || 0), 0), currentCurrency, true)} • lifetime supplied {formatMoney(s.totalSuppliedGhs || 0, currentCurrency, true)}</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ══════════════ SITE DELIVERIES ══════════════ */}
      {tab === "DELIVERIES" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Scheduled" value={deliveries.filter((d) => d.status === "SCHEDULED").length} sub="awaiting dispatch" color="blue" icon={ClipboardList} />
            <Stat label="En Route" value={deliveries.filter((d) => d.status === "EN_ROUTE").length} sub={`${enRouteAging.length} over 2 days`} color="purple" icon={Truck} />
            <Stat label="Delivered" value={completedDeliveries.length} sub="completed drops" color="emerald" icon={CheckCircle2} />
            <Stat label="Cancelled" value={deliveries.filter((d) => d.status === "CANCELLED").length} sub="returned / void" color="rose" icon={AlertTriangle} />
          </div>
          <Card title="Site Delivery Dispatch Board" icon={Truck} testid="hw-deliveries-card"
            action={<button data-testid="hw-new-delivery" onClick={() => setShowForm("DELIVERY")} className="px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />Schedule Delivery</button>}>
            <DataTable headers={["Delivery #", "Customer / Site", "Material", "Qty", "Driver / Vehicle", "Dispatch", "Status", ""]}
              rows={deliveries.map((d) => [
                d.deliveryNumber,
                <span key="c">{d.customerName}{d.siteAddress ? <span className="block text-[10px] text-slate-500">{d.siteAddress}</span> : null}</span>,
                d.itemName, `${d.quantity} ${d.unit || ""}`.trim(),
                d.driverName ? `${d.driverName}${d.vehicleNumber ? ` • ${d.vehicleNumber}` : ""}` : "—",
                d.dispatchDate,
                <Badge key="s" s={d.status} />,
                <span key="a" className="flex items-center gap-1.5 justify-end">
                  <button data-testid={`hw-delivery-track-${d.id}`} onClick={() => setTrackItem({ type: "DELIVERY", row: d })} className="px-2 py-1 rounded bg-sky-500/20 border border-sky-500/40 text-sky-300 text-[10px] font-bold flex items-center gap-1 hover:bg-sky-500/30"><MapPin className="w-3 h-3" />Track</button>
                  {nextDeliveryStatus[d.status]
                    ? <button data-testid={`hw-delivery-adv-${d.id}`} onClick={() => patchEntity("DELIVERY", d.id, { status: nextDeliveryStatus[d.status] })} className="px-2 py-1 rounded bg-orange-500/20 border border-orange-500/40 text-orange-300 text-[10px] font-bold">→ {nextDeliveryStatus[d.status].replace("_", " ")}</button>
                    : null}
                </span>,
              ])} />
            <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Completing a standalone delivery deducts the dispatched quantity from stock. Deliveries linked to an order inherit the order's own fulfilment so stock is never deducted twice.</p>
          </Card>
        </div>
      )}

      {/* ══════════════ STAFF & YARD OPS ══════════════ */}
      {tab === "YARD_OPS" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Branch Staff" value={branchEmployees.length} sub={`${branchEmployees.filter((e) => e.status === "ACTIVE").length} active`} color="amber" icon={UserCog} />
            <Stat label="Assets" value={branchAssets.length} sub={`${formatMoney(branchAssets.reduce((s, a) => s + (a.valueGhs || a.purchaseCostGhs || 0), 0), currentCurrency, true)} value`} color="blue" icon={Hammer} />
            <Stat label="Branch Customers" value={branchCustomers.length} sub={`${customers.filter((c) => !c.businessId).length} shared enterprise-wide`} color="emerald" icon={Users} />
            <Stat label="Goods Received Notes" value={opsLogs.length} sub="yard intake ledger" color="purple" icon={FileText} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Staff Performance" icon={UserCog}>
              <DataTable headers={["Staff", "Sales Made", "Sales Value", "Receipts Handled", "Expenses Logged"]}
                rows={staffPerformance.map((s) => [
                  <span key="n" className="font-semibold text-slate-200">{s.name}</span>,
                  s.sales, formatMoney(s.salesAmt, currentCurrency, true), s.receipts, s.expenses,
                ])} />
              <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Sales & expenses attribute from each transaction's recorded-by stamp; goods receipts from GRN handling.</p>
            </Card>
            <Card title="Assets & Top Customers" icon={Users}>
              <div className="p-4 space-y-3">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Branch Assets</div>
                {branchAssets.length === 0 && <p className="text-xs text-slate-500">No assets registered for this branch.</p>}
                {branchAssets.map((a) => (
                  <div key={a.id} className="flex justify-between text-xs p-2 rounded-lg bg-slate-900/70 border border-slate-700"><span className="text-slate-200">{a.name}</span><span className="text-slate-400">{a.status || "ACTIVE"}</span></div>
                ))}
                <div className="text-[10px] uppercase text-slate-500 font-bold pt-2">Customers</div>
                {(branchCustomers.length ? branchCustomers : customers).slice(0, 5).map((c) => (
                  <div key={c.id} className="flex justify-between text-xs p-2 rounded-lg bg-slate-900/70 border border-slate-700">
                    <span className="text-slate-200">{c.name}</span>
                    <span className="text-slate-400">{c.type} • {formatMoney(c.totalSpentGhs || 0, currentCurrency, true)}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
          <Card title="Goods Received Log (Yard Intake Ledger)" icon={FileText} testid="hw-grn-log"
            action={<button onClick={() => setShowForm("GRN")} className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />Log Goods Receipt</button>}>
            <DataTable headers={["Received", "GRN #", "Supplier", "Material", "Qty", "Unit Cost", "Condition", "Received By"]}
              rows={opsLogs.map((l) => [
                l.recordedDate, <span key="g" className="font-mono text-[11px]">{l.receiveNoteNumber}</span>, l.supplierName, l.itemName,
                `${l.quantityReceived} ${l.unit || ""}`.trim(),
                formatMoney(l.unitCostGhs || 0, currentCurrency, true),
                <Badge key="c" s={l.condition || "GOOD"} />,
                l.receivedBy || "—",
              ])} />
            <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Every logged receipt tops up the matching stock item (or creates it) and books the landed cost to Finance — the yard log IS the stock-intake ledger.</p>
          </Card>
        </div>
      )}

      {/* ══════════════ FINANCE — complete Financial Report ══════════════ */}
      {tab === "FINANCE" && (
        <div className="space-y-4">
          <FinancialReportSection
            mode="business"
            businessInfo={businessInfo}
            businessMetric={businessMetrics}
            transactions={transactions}
            inventory={inventory}
            customers={customers}
            currentCurrency={currentCurrency}
            accent="amber"
            testid="fin-report-hardware"
            aiModuleKey="HARDWARE"
            opsLinks={[
              {
                label: "Orders delivered",
                value: `${orders.filter((o: any) => o.status === "DELIVERED").length} of ${orders.length}`,
                note: "Fulfilled orders deduct stock and post revenue automatically",
                tone: "emerald",
              },
              {
                label: "Site deliveries completed",
                value: String(deliveries.filter((d: any) => d.status === "DELIVERED").length),
                tone: "amber",
              },
              {
                label: "Purchases received",
                value: formatMoney(
                  purchases.filter((p: any) => p.status === "RECEIVED").reduce((s: number, p: any) => s + (p.totalGhs || 0), 0),
                  currentCurrency,
                  true
                ),
                tone: "violet",
              },
            ]}
          />
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
          accent="amber"
          onChanged={() => { refresh(); onRefreshData?.(); }}
        />
      )}

      {showForm && <HardwareForm type={showForm} busy={busy} onClose={() => { setShowForm(null); setError(""); }} onSubmit={submit} inventory={branchInventory} suppliers={suppliers} orders={orders} currency={currentCurrency} />}
      {trackItem && <HardwareTrackModal track={trackItem} currency={currentCurrency} onClose={() => setTrackItem(null)} />}
    </div>
  );
}

function HardwareForm({ type, busy, onClose, onSubmit, inventory, suppliers, orders, currency }: any) {
  const todayStr = new Date().toISOString().split("T")[0];
  const [f, setF] = useState<any>({
    paymentMethod: "CASH",
    status: type === "PURCHASE" ? "ORDERED" : type === "DELIVERY" ? "SCHEDULED" : "PENDING",
    date: todayStr, orderDate: todayStr, dispatchDate: todayStr, recordExpense: true,
    unit: "Units", condition: "GOOD",
  });
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const I = ({ label, k, t = "text", ...rest }: any) => <div><label className="block text-[10px] text-slate-400 font-semibold mb-1">{label}</label><input data-testid={`hwf-${k}`} type={t} value={f[k] ?? ""} onChange={(e) => set(k, t === "number" ? Number(e.target.value) : e.target.value)} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs" {...rest} /></div>;
  const S = ({ label, k, opts }: any) => <div><label className="block text-[10px] text-slate-400 font-semibold mb-1">{label}</label><select data-testid={`hwf-${k}`} value={f[k] ?? ""} onChange={(e) => set(k, e.target.value)} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs">{opts.map((o: any) => <option key={o.v ?? o} value={o.v ?? o}>{o.l ?? o}</option>)}</select></div>;
  const title =
    type === "SALE" ? "Record Sale / Payment" :
    type === "EXPENSE" ? "Record Expense" :
    type === "ITEM" ? "Add Stock Material" :
    type === "ORDER" ? "Create Customer Order" :
    type === "PURCHASE" ? "Record Supplier Purchase" :
    type === "DELIVERY" ? "Schedule Site Delivery" :
    "Log Goods Receipt (GRN)";

  const selectedItem = (inventory || []).find((i: any) => String(i.id) === String(f.inventoryId));
  const saleTotal = (Number(f.quantity) || 0) * (f.sellingPrice ? Number(f.sellingPrice) : selectedItem?.sellingPriceGhs || 0);
  const MATERIAL_CATS = ["Cement & Mortar", "Steel & Reinforcement", "Fasteners & Fixings", "Roofing & Cladding", "Paints & Finishing", "Plumbing & Drainage", "Electrical & Lighting", "Timber & Boards", "Tools & Equipment", "Aggregates & Sand"];

  const handle = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(type, { ...f });
  };

  const purchaseStatusOpts = [{ v: "ORDERED", l: "Ordered (on the way)" }, { v: "RECEIVED", l: "Received (stock-in + expense booked)" }];

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4" data-testid="hw-form"><div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto"><div className="flex items-center justify-between p-5 border-b border-slate-800 sticky top-0 bg-slate-900 z-10"><h3 className="text-lg font-bold text-white">{title}</h3><button data-testid="hwf-close" onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button></div><form onSubmit={handle} className="p-5 space-y-3">
    {type === "SALE" && <>
      <div className="grid grid-cols-2 gap-3"><I label="Customer Name" k="customerName" required /><I label="Customer Phone" k="customerPhone" /></div>
      <S label="Material (in stock)" k="inventoryId" opts={[{ v: "", l: "— select material —" }, ...(inventory || []).map((i: any) => ({ v: i.id, l: `${i.name} (${i.quantity} in stock)` }))]} />
      <div className="grid grid-cols-2 gap-3"><I label="Quantity" k="quantity" t="number" required min={1} /><I label="Unit Price (GH₵)" k="sellingPrice" t="number" step="0.01" placeholder={selectedItem ? String(selectedItem.sellingPriceGhs) : "auto"} /></div>
      <div className="grid grid-cols-2 gap-3"><S label="Payment" k="paymentMethod" opts={["CASH", "MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER", "POS_CARD"]} /><I label="Discount %" k="discountPct" t="number" step="0.5" min={0} max={100} placeholder="auto" /><I label="Discount (GH₵)" k="discount" t="number" step="0.01" min={0} /></div>
      <I label="Custom price reason (if discounted)" k="customPriceReason" /><I label="Notes" k="notes" />
      {saleTotal > 0 && <div className="text-xs text-amber-300 font-bold" data-testid="hwf-sale-total">Total: {formatMoney(saleTotal, currency)}</div>}
    </>}
    {type === "EXPENSE" && <><div className="grid grid-cols-2 gap-3"><I label="Category" k="category" placeholder="Forklift Fuel, Yard Rent, Utilities..." required /><I label="Amount (GH₵)" k="amountGhs" t="number" step="0.01" required /><S label="Payment" k="paymentMethod" opts={["CASH", "MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER", "POS_CARD"]} /><I label="Date" k="date" t="date" /></div><I label="Description" k="description" /></>}
    {type === "ITEM" && <><div className="grid grid-cols-2 gap-3"><I label="Material Name" k="name" required /><I label="SKU" k="sku" placeholder="auto if blank" /></div><div className="grid grid-cols-2 gap-3"><I label="Category" k="category" placeholder="Cement & Mortar" list="hw-item-cats" /><I label="Unit" k="unit" placeholder="Bags, Lengths, Sheets…" /></div><div className="grid grid-cols-2 gap-3"><I label="Opening Qty" k="quantity" t="number" min={0} /><I label="Min Stock Alert" k="minStockThreshold" t="number" min={0} /></div><div className="grid grid-cols-2 gap-3"><I label="Cost Price (GH₵)" k="costPriceGhs" t="number" step="0.01" /><I label="Selling Price (GH₵)" k="sellingPriceGhs" t="number" step="0.01" /></div><datalist id="hw-item-cats">{MATERIAL_CATS.map((c) => <option key={c} value={c} />)}</datalist></>}
    {type === "ORDER" && <><div className="grid grid-cols-2 gap-3"><I label="Customer Name" k="customerName" required /><I label="Customer Phone" k="customerPhone" /></div><S label="Material (from stock)" k="inventoryId" opts={[{ v: "", l: "— custom / not in stock list —" }, ...(inventory || []).map((i: any) => ({ v: i.id, l: `${i.name} (${i.quantity} in stock)` }))]} /><I label="Material Name (if custom)" k="itemName" placeholder={selectedItem?.name || "e.g. Torkor Blocks 6in Hollow"} />{selectedItem && !f.itemName && <p className="text-[10px] text-amber-300 -mt-2">Will use: {selectedItem.name}</p>}<div className="grid grid-cols-3 gap-3"><I label="Qty" k="quantity" t="number" required min={1} /><I label="Unit Price (GH₵)" k="unitPriceGhs" t="number" step="0.01" required placeholder={selectedItem ? String(selectedItem.sellingPriceGhs) : ""} /><I label="Due Date" k="dueDate" t="date" /></div><I label="Delivery Site" k="deliverySite" placeholder="e.g. East Legon Site, Plot 14" /><I label="Notes" k="notes" /></>}
    {type === "PURCHASE" && <>
      <div className="grid grid-cols-2 gap-3"><S label="Supplier" k="supplierName" opts={(suppliers || []).map((s: any) => s.name)} /><I label="Material / Product" k="itemName" placeholder={selectedItem?.name || "e.g. Ghacem 42.5R Cement 50kg"} required /></div>
      <S label="Match stock item (optional)" k="inventoryId" opts={[{ v: "", l: "— auto-match by name —" }, ...(inventory || []).map((i: any) => ({ v: i.id, l: `${i.name} (${i.quantity} in stock)` }))]} />
      <div className="grid grid-cols-3 gap-3"><I label="Qty" k="quantity" t="number" required min={1} /><I label="Unit Cost (GH₵)" k="unitCostGhs" t="number" step="0.01" required /><I label="Sell Price (GH₵)" k="sellingPriceGhs" t="number" step="0.01" placeholder="new items" /></div>
      <div className="grid grid-cols-2 gap-3"><S label="Status" k="status" opts={purchaseStatusOpts} /><I label="Order Date" k="orderDate" t="date" /></div>
      <S label="Payment (if received)" k="paymentMethod" opts={["BANK_TRANSFER", "MTN_MOMO", "CASH", "POS_CARD", "TELECEL_CASH"]} />
      <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer"><input data-testid="hwf-recordExpense" type="checkbox" checked={f.recordExpense !== false} onChange={(e) => set("recordExpense", e.target.checked)} className="accent-indigo-500 w-3.5 h-3.5" />Book expense to Finance when received (Recommended)</label>
      <I label="Notes" k="notes" />
    </>}
    {type === "DELIVERY" && <>
      <div className="grid grid-cols-2 gap-3"><I label="Customer" k="customerName" required /><S label="Linked order (optional)" k="orderNumber" opts={[{ v: "", l: "— standalone dispatch —" }, ...(orders || []).filter((o: any) => ["PENDING", "READY"].includes(o.status)).map((o: any) => ({ v: o.orderNumber, l: `${o.orderNumber} • ${o.itemName}` }))]} /></div>
      <I label="Site Address" k="siteAddress" placeholder="e.g. East Legon Site, Plot 14" />
      <S label="Material (from stock)" k="inventoryId" opts={[{ v: "", l: "— select material —" }, ...(inventory || []).map((i: any) => ({ v: i.id, l: `${i.name} (${i.quantity} in stock)` }))]} />
      <I label="Material Name (if not listed)" k="itemName" placeholder={selectedItem?.name || "auto from selection"} />
      <div className="grid grid-cols-2 gap-3"><I label="Quantity" k="quantity" t="number" required min={1} /><I label="Unit" k="unit" placeholder="Bags, Lengths…" /></div>
      <div className="grid grid-cols-2 gap-3"><I label="Driver" k="driverName" /><I label="Vehicle No." k="vehicleNumber" placeholder="GN-1234-26" /></div>
      <I label="Dispatch Date" k="dispatchDate" t="date" />
      <I label="Notes" k="notes" />
    </>}
    {type === "GRN" && <>
      <div className="grid grid-cols-2 gap-3"><I label="Supplier" k="supplierName" required /><I label="Material Received" k="itemName" placeholder="e.g. Ghacem 42.5R Cement 50kg" required /></div>
      <div className="grid grid-cols-3 gap-3"><I label="Qty Received" k="quantityReceived" t="number" min={0} step="0.1" required /><I label="Unit" k="unit" placeholder="Bags" /><I label="Unit Cost (GH₵)" k="unitCostGhs" t="number" step="0.01" min={0} /></div>
      <div className="grid grid-cols-2 gap-3"><S label="Condition" k="condition" opts={["GOOD", "PARTIAL", "DAMAGED"]} /><I label="Received By" k="receivedBy" /></div>
      <S label="Payment Method" k="paymentMethod" opts={["BANK_TRANSFER", "MTN_MOMO", "CASH", "POS_CARD", "TELECEL_CASH"]} />
      <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer"><input data-testid="hwf-grn-recordExpense" type="checkbox" checked={f.recordExpense !== false} onChange={(e) => set("recordExpense", e.target.checked)} className="accent-cyan-500 w-3.5 h-3.5" />Book landed cost to Finance (Recommended)</label>
      <p className="text-[10px] text-slate-500">Posting a GRN tops up the matching stock item (or creates it) — the yard log doubles as the stock-intake ledger.</p>
    </>}
    <div className="flex justify-end gap-3 pt-3 border-t border-slate-800"><button type="button" data-testid="hwf-cancel" onClick={onClose} className="px-4 py-2 bg-slate-800 rounded-lg text-xs text-slate-300">Cancel</button><button data-testid="hwf-submit" disabled={busy} className="px-5 py-2 bg-amber-600 hover:bg-amber-500 rounded-lg text-xs font-bold text-white disabled:opacity-50">{busy ? "Saving..." : "Save"}</button></div>
  </form></div></div>;
}

// ─── Order / Delivery Tracking Modal ─────────────────────────────────────────

function fmtTrackDate(v: any): string | null {
  if (!v) return null;
  const s = String(v);
  // Date-only strings ("2026-08-19") must parse as LOCAL midnight, not UTC —
  // otherwise they render a day early for users west of Greenwich.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) : new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function HardwareTrackModal({
  track, currency, onClose,
}: {
  track: { type: "ORDER" | "DELIVERY"; row: any };
  currency: CurrencyCode;
  onClose: () => void;
}) {
  const { type, row } = track;
  const isOrder = type === "ORDER";
  const cancelled = row.status === "CANCELLED";
  // Forward progress rank: 1 = first stage only, 2 = mid, 3 = fully complete
  const rank = cancelled ? 0
    : isOrder ? (row.status === "DELIVERED" ? 3 : row.status === "READY" ? 2 : 1)
    : (row.status === "DELIVERED" ? 3 : row.status === "EN_ROUTE" ? 2 : 1);
  const steps = isOrder
    ? [
        { label: "Order Placed", detail: `Recorded by ${row.createdByName || "staff"}${row.createdByRole ? ` (${row.createdByRole})` : ""}`, at: fmtTrackDate(row.createdAt) || "—" },
        { label: "Ready for Pickup / Dispatch", detail: "Material packed and staged in the yard", at: fmtTrackDate(row.readyAt) },
        { label: "Delivered to Customer", detail: row.deliverySite ? `Handed over at ${row.deliverySite}` : "Collected / handed over — sale booked to Finance", at: fmtTrackDate(row.fulfilledDate) },
      ]
    : [
        { label: "Delivery Scheduled", detail: `Dispatch planned for ${row.dispatchDate || "—"}`, at: fmtTrackDate(row.createdAt) || fmtTrackDate(row.dispatchDate) || "—" },
        { label: "En Route to Site", detail: row.driverName ? `${row.driverName}${row.vehicleNumber ? ` • ${row.vehicleNumber}` : ""}` : "Driver dispatched with materials", at: fmtTrackDate(row.enRouteAt) },
        { label: "Delivered to Site", detail: row.siteAddress ? `Dropped at ${row.siteAddress}` : "Site drop completed", at: fmtTrackDate(row.deliveredDate) },
      ];

  return (
    <div data-testid="hw-track-modal" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-sky-400">{isOrder ? "Customer Order Tracking" : "Site Delivery Tracking"}</p>
            <h3 data-testid="hw-track-title" className="text-lg font-extrabold text-white mt-0.5">{isOrder ? row.orderNumber : row.deliveryNumber}</h3>
          </div>
          <button data-testid="hw-track-close" onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Summary */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <div><p className="text-[10px] text-slate-500 uppercase font-bold">Customer</p><p data-testid="hw-track-customer" className="text-slate-200 font-semibold">{row.customerName}{row.customerPhone ? <span className="block text-[10px] text-slate-400 font-normal">{row.customerPhone}</span> : null}</p></div>
            <div><p className="text-[10px] text-slate-500 uppercase font-bold">Material</p><p className="text-slate-200 font-semibold">{row.quantity} × {row.itemName}</p></div>
            {isOrder && <div><p className="text-[10px] text-slate-500 uppercase font-bold">Order Total</p><p className="text-amber-300 font-bold">{formatMoney(row.totalGhs || 0, currency, true)}</p></div>}
            {isOrder && <div><p className="text-[10px] text-slate-500 uppercase font-bold">Due Date</p><p className="text-slate-200 font-semibold">{row.dueDate || "—"}</p></div>}
            {!isOrder && <div><p className="text-[10px] text-slate-500 uppercase font-bold">Linked Order</p><p className="text-slate-200 font-semibold">{row.orderNumber || "Standalone dispatch"}</p></div>}
            {!isOrder && <div><p className="text-[10px] text-slate-500 uppercase font-bold">Site</p><p className="text-slate-200 font-semibold">{row.siteAddress || "—"}</p></div>}
            <div><p className="text-[10px] text-slate-500 uppercase font-bold">Current Status</p><span data-testid="hw-track-status" className={`inline-block px-2 py-0.5 rounded-full border text-[10px] font-bold ${STATUS_STYLE[row.status] || ""}`}>{row.status}</span></div>
          </div>

          {cancelled && (
            <div data-testid="hw-track-cancelled" className="rounded-lg bg-rose-500/10 border border-rose-500/40 px-3 py-2 text-[11px] text-rose-300 font-semibold">
              This {isOrder ? "order" : "delivery"} was cancelled — tracking stopped at its last completed stage.
            </div>
          )}

          {/* Timeline */}
          <div className="relative">
            {steps.map((s, i) => {
              const n = i + 1;
              const done = rank >= n;
              const current = !cancelled && rank === n && rank < steps.length;
              const isLast = i === steps.length - 1;
              return (
                <div key={s.label} data-testid={`hw-track-step-${n}`} className="relative flex gap-3 pb-5 last:pb-0">
                  {!isLast && <span className={`absolute left-[9px] top-5 bottom-0 w-px ${rank > n ? "bg-emerald-500/60" : "bg-slate-700"}`} />}
                  <span className={`relative z-10 mt-0.5 w-[19px] h-[19px] shrink-0 rounded-full border-2 flex items-center justify-center ${done ? "bg-emerald-500/20 border-emerald-500 text-emerald-400" : current ? "bg-amber-500/10 border-amber-500 text-amber-400" : "bg-slate-800 border-slate-600 text-slate-600"}`}>
                    {done ? <CheckCircle2 className="w-3 h-3" /> : <span className="w-1.5 h-1.5 rounded-full bg-current" />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className={`text-xs font-bold ${done ? "text-slate-100" : "text-slate-500"}`}>{s.label}</p>
                      <span className={`text-[10px] font-semibold whitespace-nowrap ${done ? "text-emerald-400" : "text-slate-600"}`}>{s.at || "Pending"}</span>
                    </div>
                    <p className={`text-[10px] mt-0.5 ${done ? "text-slate-400" : "text-slate-600"}`}>{s.detail}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
