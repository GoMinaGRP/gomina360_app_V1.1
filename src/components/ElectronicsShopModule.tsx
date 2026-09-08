"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import AiSectionGuide from "./AiSectionGuide";
import {
  ShoppingCart, Package, AlertTriangle, TrendingUp, TrendingDown, Wallet, Activity,
  Wrench, Users, Truck, FileText, Barcode, Award, RefreshCw, LayoutDashboard,
  ClipboardList, UserCog, X, Plus, CheckCircle2, ClipboardCheck, Sparkles, Boxes,
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

type Tab = "DASHBOARD" | "PRODUCTS" | "ORDERS" | "FINANCE" | "SERVICE" | "STAFF" | "CHECKLIST";
type FormType = "SALE" | "EXPENSE" | "ITEM" | "ORDER" | "PURCHASE" | "SERIAL" | "WARRANTY" | "LOG" | null;

const TABS: { key: Tab; label: string; icon: any }[] = [
  { key: "DASHBOARD", label: "Dashboard", icon: LayoutDashboard },
  { key: "PRODUCTS", label: "Products & Stock", icon: Boxes },
  { key: "ORDERS", label: "Orders & Purchases", icon: ClipboardList },
  { key: "FINANCE", label: "Finance & Reports", icon: Wallet },
  { key: "SERVICE", label: "Warranty & Serials", icon: Wrench },
  { key: "STAFF", label: "Staff & Ops", icon: UserCog },
  { key: "CHECKLIST", label: "Daily Checklist", icon: ClipboardCheck },
];

const PAY_COLORS = ["#06b6d4", "#10b981", "#f59e0b", "#a855f7", "#ec4899", "#3b82f6"];

const STATUS_STYLE: Record<string, string> = {
  PENDING: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  READY: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  DELIVERED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  CANCELLED: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  ORDERED: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  RECEIVED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  OPEN: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  IN_PROGRESS: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  RESOLVED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  IN_STOCK: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  LOW_STOCK: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  OUT_OF_STOCK: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  SOLD: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  RESERVED: "bg-purple-500/15 text-purple-300 border-purple-500/40",
  RETURNED: "bg-orange-500/15 text-orange-300 border-orange-500/40",
  UNDER_REPAIR: "bg-yellow-500/15 text-yellow-300 border-yellow-500/40",
};
const Badge = ({ s }: { s: string }) => (
  <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${STATUS_STYLE[s] || "bg-slate-700/40 text-slate-300 border-slate-600"}`}>{s}</span>
);

export default function ElectronicsShopModule({
  currentUser, businessInfo, businessMetrics, inventory, customers, suppliers,
  transactions, assets, employees, currentCurrency, onRefreshData,
}: Props) {
  const bizId = businessInfo?.id;
  const today = new Date().toISOString().split("T")[0];

  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("DASHBOARD");
  const [orders, setOrders] = useState<any[]>([]);
  const [serials, setSerials] = useState<any[]>([]);
  const [warranties, setWarranties] = useState<any[]>([]);
  const [purchases, setPurchases] = useState<any[]>([]);
  const [opsLogs, setOpsLogs] = useState<any[]>([]);
  const [showForm, setShowForm] = useState<FormType>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!bizId) return;
    try {
      const [eRes, lRes] = await Promise.all([
        fetch(`/api/electronics?businessId=${bizId}`),
        fetch(`/api/logs/${businessInfo?.code || "TECH-01"}`),
      ]);
      const eD = await eRes.json();
      const lD = await lRes.json();
      if (eD.success) {
        setOrders(eD.orders || []);
        setSerials(eD.serials || []);
        setWarranties(eD.warranties || []);
        setPurchases(eD.purchases || []);
      }
      if (lD.success) setOpsLogs((lD.logs || []).filter((l: any) => l.businessId === bizId));
    } finally {
      setLoading(false);
    }
  }, [bizId]);

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

  // ── Cash & Payment Summary ────────────────────────────────────────────
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

  // ── Sales & Orders Summary ────────────────────────────────────────────
  const openOrders = orders.filter((o) => ["PENDING", "READY"].includes(o.status));
  const deliveredOrders = orders.filter((o) => o.status === "DELIVERED");
  const orderPipelineValue = openOrders.reduce((s, o) => s + (o.totalGhs || 0), 0);
  const unitsSold = deliveredOrders.reduce((s, o) => s + (o.quantity || 0), 0) + serials.filter((s) => s.status === "SOLD").length;

  // ── Top-Selling Products (orders + sold serials) ──────────────────────
  const productSales = useMemo(() => {
    const m: Record<string, { name: string; qty: number; revenue: number }> = {};
    const bump = (name: string, qty: number, rev: number) => {
      if (!name) return;
      if (!m[name]) m[name] = { name, qty: 0, revenue: 0 };
      m[name].qty += qty;
      m[name].revenue += rev;
    };
    orders.filter((o) => o.status !== "CANCELLED").forEach((o) => bump(o.itemName, o.quantity || 0, o.totalGhs || 0));
    serials.filter((s) => s.status === "SOLD").forEach((s) => bump(s.productName, 1, s.priceGhs || 0));
    return Object.values(m).sort((a, b) => b.revenue - a.revenue);
  }, [orders, serials]);
  const topProducts = productSales.slice(0, 5);
  const bestSeller = topProducts[0];
  const bestSellerShare = bestSeller && productSales.reduce((s, p) => s + p.revenue, 0) > 0
    ? Math.round((bestSeller.revenue / productSales.reduce((s, p) => s + p.revenue, 0)) * 100) : 0;

  // ── Product Performance (per inventory SKU) ───────────────────────────
  const productPerformance = useMemo(() => branchInventory.map((i) => {
    const soldOrders = deliveredOrders.filter((o) => o.inventoryId === i.id).reduce((s, o) => s + (o.quantity || 0), 0);
    const soldSerials = serials.filter((s) => s.inventoryId === i.id && s.status === "SOLD").length;
    const soldQty = soldOrders + soldSerials;
    const estRevenue = soldOrders > 0
      ? deliveredOrders.filter((o) => o.inventoryId === i.id).reduce((s, o) => s + (o.totalGhs || 0), 0)
      : soldSerials * (i.sellingPriceGhs || 0);
    const marginPct = i.sellingPriceGhs > 0 ? Math.round(((i.sellingPriceGhs - (i.costPriceGhs || 0)) / i.sellingPriceGhs) * 100) : 0;
    return { ...i, soldQty, estRevenue, marginPct, stockValue: (i.quantity || 0) * (i.costPriceGhs || 0) };
  }).sort((a, b) => b.estRevenue - a.estRevenue), [branchInventory, deliveredOrders, serials]);

  // ── Suppliers & Purchases ─────────────────────────────────────────────
  const techSuppliers = useMemo(() => suppliers.filter((s) => /electron|solar|tech|gadget/i.test(s.category || "") || purchases.some((p) => p.supplierName === s.name)), [suppliers, purchases]);
  const supplierSpend = useMemo(() => {
    const m: Record<string, number> = {};
    purchases.filter((p) => p.status !== "CANCELLED").forEach((p) => { m[p.supplierName] = (m[p.supplierName] || 0) + (p.totalGhs || 0); });
    return m;
  }, [purchases]);
  const openPurchaseValue = purchases.filter((p) => p.status === "ORDERED").reduce((s, p) => s + (p.totalGhs || 0), 0);
  const receivedSpend = purchases.filter((p) => p.status === "RECEIVED").reduce((s, p) => s + (p.totalGhs || 0), 0);

  // ── Warranty & Serial Tracking ────────────────────────────────────────
  const openClaims = warranties.filter((w) => ["OPEN", "IN_PROGRESS"].includes(w.status));
  const oldClaims = openClaims.filter((w) => w.loggedDate && (Date.now() - new Date(w.loggedDate).getTime()) > 7 * 86400e3);
  const claimCost = warranties.reduce((s, w) => s + (w.costGhs || 0), 0);
  const serialStatus = useMemo(() => {
    const m: Record<string, number> = {};
    serials.forEach((s) => { m[s.status] = (m[s.status] || 0) + 1; });
    return m;
  }, [serials]);
  const expiringWarranties = serials.filter((s) => {
    if (!s.warrantyEnd || s.status !== "SOLD") return false;
    const days = (new Date(s.warrantyEnd).getTime() - Date.now()) / 86400e3;
    return days > 0 && days <= 60;
  });

  // ── Staff Performance ─────────────────────────────────────────────────
  const staffPerformance = useMemo(() => {
    const m: Record<string, { name: string; sales: number; salesAmt: number; expenses: number; claims: number }> = {};
    branchTx.forEach((t) => {
      const k = t.recordedBy || "Unknown";
      if (!m[k]) m[k] = { name: k, sales: 0, salesAmt: 0, expenses: 0, claims: 0 };
      if (t.type === "INCOME") { m[k].sales++; m[k].salesAmt += t.amountGhs || 0; }
      if (t.type === "EXPENSE") { m[k].expenses++; }
    });
    warranties.forEach((w) => {
      const k = w.handledByName || "Unknown";
      if (!m[k]) m[k] = { name: k, sales: 0, salesAmt: 0, expenses: 0, claims: 0 };
      m[k].claims++;
    });
    const rows = Object.values(m).sort((a, b) => b.salesAmt - a.salesAmt);
    branchEmployees.forEach((e) => { if (!m[e.name]) rows.push({ name: e.name, sales: 0, salesAmt: 0, expenses: 0, claims: 0 }); });
    return rows;
  }, [branchTx, warranties, branchEmployees]);

  // ── AI Business Insights (rule-based decision support) ────────────────
  const insights = useMemo(() => {
    const out: { level: "POSITIVE" | "WARNING" | "CRITICAL" | "INFO"; title: string; detail: string }[] = [];
    if (bestSeller && bestSellerShare > 40) out.push({
      level: "WARNING", title: "Revenue concentration risk",
      detail: `${bestSeller.name} drives ${bestSellerShare}% of tracked product revenue — diversify the product mix or secure deeper supplier terms.`,
    });
    const lowStock = branchInventory.filter((i) => i.status === "LOW_STOCK" || i.status === "OUT_OF_STOCK");
    lowStock.forEach((i) => out.push({
      level: i.status === "OUT_OF_STOCK" ? "CRITICAL" : "WARNING", title: `${i.name} — ${i.status.replace("_", " ")}`,
      detail: `${i.quantity} units left (minimum ${i.minStockThreshold}). Raise a supplier purchase before demand is lost.`,
    }));
    if (oldClaims.length > 0) out.push({
      level: "CRITICAL", title: `${oldClaims.length} warranty claim(s) open > 7 days`,
      detail: "Slow service erodes trust and repeat sales — push these to IN_PROGRESS/RESOLVED and update customers.",
    });
    if (expiringWarranties.length > 0) out.push({
      level: "INFO", title: `${expiringWarranties.length} sold unit(s) near warranty expiry`,
      detail: "Offer inspection or extended-warranty upsells before coverage lapses.",
    });
    if (orderPipelineValue > 0) out.push({
      level: "INFO", title: `${formatMoney(orderPipelineValue, currentCurrency, true)} in open orders`,
      detail: `${openOrders.length} order(s) awaiting fulfilment — confirm stock allocation and delivery dates.`,
    });
    if (revenue > 0 && cashTotal === 0 && momoTotal === 0) out.push({
      level: "INFO", title: "All receipts are non-cash",
      detail: "Current sales are fully bank/digital — keep float discipline for walk-in retail peak hours.",
    });
    if (margin < 25 && revenue > 0) out.push({
      level: "WARNING", title: `Margin at ${margin.toFixed(1)}%`,
      detail: "Review selling prices vs landed cost; electronics retail typically targets 25–35%.",
    });
    if (out.length === 0) out.push({ level: "POSITIVE", title: "Operations look healthy", detail: "No critical stock, service or cash exposure detected today." });
    return out;
  }, [bestSeller, bestSellerShare, branchInventory, oldClaims.length, expiringWarranties.length, orderPipelineValue, openOrders.length, revenue, cashTotal, momoTotal, margin, currentCurrency]);

  // Recent transactions & daily sales chart
  const recentTx = useMemo(() => branchTx.slice().sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 10), [branchTx]);
  const salesByDate = useMemo(() => {
    const m: Record<string, number> = {};
    income.forEach((t) => { m[t.date] = (m[t.date] || 0) + (t.amountGhs || 0); });
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])).slice(-14).map(([date, value]) => ({ date: date.slice(5), value }));
  }, [income]);

  // ── Alerts ────────────────────────────────────────────────────────────
  const alerts = useMemo(() => {
    const list: { color: string; text: string }[] = [];
    branchInventory.filter((i) => i.status !== "IN_STOCK").forEach((i) => list.push({ color: "rose", text: `${i.name} is ${i.status.replace("_", " ")} (${i.quantity} left ≤ min ${i.minStockThreshold})` }));
    oldClaims.forEach((w) => list.push({ color: "amber", text: `Warranty claim ${w.claimNumber} open since ${w.loggedDate}` }));
    orders.filter((o) => o.status === "PENDING" && o.dueDate && o.dueDate < today).forEach((o) => list.push({ color: "amber", text: `Order ${o.orderNumber} overdue (due ${o.dueDate})` }));
    if (profit < 0) list.push({ color: "rose", text: "Branch is loss-making on recorded transactions" });
    return list;
  }, [branchInventory, oldClaims, orders, profit, today]);

  // ── Submit router ─────────────────────────────────────────────────────
  const submit = async (entity: FormType, data: any) => {
    setBusy(true); setError("");
    try {
      let d: any;
      if (entity === "SALE") {
        const res = await fetch("/api/sales", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessId: bizId, branchCode: businessInfo?.code,
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
            businessId: bizId, branchCode: businessInfo?.code, branchName: businessInfo?.name,
            type: "EXPENSE", category: data.category, amountGhs: Number(data.amountGhs) || 0,
            paymentMethod: data.paymentMethod || "CASH", description: data.description || data.category,
            date: data.date || today,
            recordedBy: currentUser?.name || "Staff", recordedByRole: currentUser?.role || "STAFF", recordedByUserId: currentUser?.id || null,
            status: "COMPLETED",
          }),
        });
        d = await res.json();
      } else if (entity === "LOG") {
        // Existing electronics ops log (serial registry) — preserved from the shared view
        const res = await fetch(`/api/logs/${businessInfo?.code || "TECH-01"}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serialNumber: data.serialNumber, productName: data.productName, brand: data.brand,
            warrantyMonths: Number(data.warrantyMonths) || 24, inStock: !(data.inStock === false || data.inStock === "false"),
            retailPriceGhs: Number(data.retailPriceGhs) || 0,
          }),
        });
        d = await res.json();
      } else {
        const res = await fetch("/api/electronics", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entity,
            data: {
              ...data, businessId: bizId, branchCode: businessInfo?.code,
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
      const res = await fetch("/api/electronics", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity, id, data }),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error);
      await refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const Stat = ({ label, value, sub, color = "cyan", icon: Icon }: any) => {
    const C: Record<string, string> = {
      emerald: "text-emerald-400", cyan: "text-cyan-400", rose: "text-rose-400",
      amber: "text-amber-400", purple: "text-purple-400", blue: "text-blue-400",
    };
    return (
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4">
        <div className="flex items-center justify-between text-[10px] uppercase font-bold text-slate-400">
          <span>{label}</span>{Icon && <Icon className={`w-4 h-4 ${C[color]}`} />}
        </div>
        <div className={`text-xl font-black ${C[color]} mt-1`}>{value}</div>
        {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
      </div>
    );
  };

  const Card = ({ title, icon: Icon, children, action }: any) => (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/60 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-700/70 bg-slate-800/80">
        <div className="flex items-center gap-2">{Icon && <Icon className="w-4 h-4 text-cyan-400" />}<h3 className="text-sm font-bold text-white">{title}</h3></div>
        {action}
      </div>
      {children}
    </div>
  );

  const DataTable = ({ headers, rows }: any) => (
    <div className="overflow-x-auto">
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
  const nextClaimStatus: Record<string, string> = { OPEN: "IN_PROGRESS", IN_PROGRESS: "RESOLVED" };

  if (loading) {
    return <div className="p-10 text-center text-slate-400 text-sm">Loading Mina Tech &amp; Electronics Hub…</div>;
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto text-slate-100">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-6 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center shadow-lg shrink-0">
            <ShoppingCart className="w-7 h-7 text-cyan-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 text-xs font-bold border border-cyan-500/30">ELECTRONICS SHOP MANAGEMENT</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 text-white">{businessInfo?.name || "Mina Tech & Electronics Hub"}</h2>
            <p className="text-xs text-slate-400 mt-1">{businessInfo?.code || "TECH-01"} • {businessInfo?.branchLocation || "Ghana"} • Manager: <strong className="text-cyan-300">{businessInfo?.managerName || "Richmond Addo"}</strong></p>
          </div>
        </div>
        {error && <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/40 rounded-lg px-3 py-2">{error}<button className="ml-2 text-rose-200" onClick={() => setError("")}>✕</button></div>}
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setShowForm("SALE")} className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold flex items-center gap-1"><TrendingUp className="w-3.5 h-3.5" />Sale</button>
          <button onClick={() => setShowForm("ORDER")} className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1"><ShoppingCart className="w-3.5 h-3.5" />Order</button>
          <button onClick={() => setShowForm("PURCHASE")} className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><Truck className="w-3.5 h-3.5" />Purchase</button>
          <button onClick={() => setShowForm("SERIAL")} className="px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold flex items-center gap-1"><Barcode className="w-3.5 h-3.5" />Serial</button>
          <button onClick={() => setShowForm("WARRANTY")} className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center gap-1"><Award className="w-3.5 h-3.5" />Claim</button>
          <button onClick={() => setShowForm("EXPENSE")} className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold flex items-center gap-1"><Wallet className="w-3.5 h-3.5" />Expense</button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex flex-wrap gap-1 bg-slate-800/60 border border-slate-700 rounded-xl p-1">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition ${tab === t.key ? "bg-cyan-600 text-white" : "text-slate-400 hover:text-white"}`}>
            <t.icon className="w-3.5 h-3.5" />{t.label}
          </button>
        ))}
        <AiSectionGuide moduleKey="TECH" section={tab} businessInfo={businessInfo} />
      </div>

      {alerts.length > 0 && tab === "DASHBOARD" && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-1">
          {alerts.slice(0, 5).map((a, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-amber-200"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{a.text}</div>
          ))}
        </div>
      )}

      {/* ══════════════ DASHBOARD ══════════════ */}
      {tab === "DASHBOARD" && (
        <div className="space-y-5">
          {/* Sales & Orders Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat label="Revenue" value={formatMoney(revenue, currentCurrency, true)} sub={`${income.length} receipts`} color="emerald" icon={TrendingUp} />
            <Stat label="Net Profit" value={formatMoney(profit, currentCurrency, true)} sub={`${margin.toFixed(1)}% margin`} color={profit >= 0 ? "cyan" : "rose"} icon={Activity} />
            <Stat label="Orders" value={orders.length} sub={`${openOrders.length} open • ${formatMoney(orderPipelineValue, currentCurrency, true)} pipeline`} color="amber" icon={ShoppingCart} />
            <Stat label="Units Sold" value={unitsSold} sub="delivered + serialized sales" color="purple" icon={Package} />
            <Stat label="SKU Stock" value={branchInventory.reduce((s, i) => s + (i.quantity || 0), 0)} sub={`${branchInventory.length} products`} color="blue" icon={Boxes} />
            <Stat label="Open Claims" value={openClaims.length} sub={`${formatMoney(claimCost, currentCurrency, true)} service cost`} color="rose" icon={Wrench} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Cash & Payment Summary */}
            <Card title="Cash & Payment Summary" icon={Wallet}>
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
                <div className="space-y-1">
                  {paymentMix.map((p, i) => (
                    <div key={p.method} className="flex justify-between text-[11px]"><span className="flex items-center gap-1.5 text-slate-400"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: PAY_COLORS[i % PAY_COLORS.length] }} />{p.method.replaceAll("_", " ")} • {p.count}</span><span className="font-bold text-slate-200">{formatMoney(p.total, currentCurrency, true)}</span></div>
                  ))}
                </div>
              </div>
            </Card>

            {/* Top-Selling Products */}
            <Card title="Top-Selling Products" icon={TrendingUp}>
              <div className="p-4 space-y-2">
                {topProducts.length === 0 && <p className="text-xs text-slate-500 text-center py-4">Record a sale, order or serialized sale to rank products.</p>}
                {topProducts.map((p, i) => {
                  const max = topProducts[0]?.revenue || 1;
                  return (
                    <div key={p.name} className="p-2.5 rounded-lg bg-slate-900/70 border border-slate-700">
                      <div className="flex justify-between text-xs gap-2">
                        <span className="font-semibold text-slate-200 truncate"><span className="text-cyan-400 font-black mr-1">#{i + 1}</span>{p.name}</span>
                        <span className="font-bold text-emerald-300 shrink-0">{formatMoney(p.revenue, currentCurrency, true)}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <div className="flex-1 h-1.5 rounded-full bg-slate-700 overflow-hidden"><div className="h-full bg-cyan-500 rounded-full" style={{ width: `${Math.max(4, (p.revenue / max) * 100)}%` }} /></div>
                        <span className="text-[10px] text-slate-500">{p.qty} unit{p.qty === 1 ? "" : "s"}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* AI Business Insights */}
            <Card title="AI Business Insights" icon={Sparkles}>
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

          {/* Sales trend + Product performance */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Receipts Trend (last 14 days with sales)" icon={Activity}>
              <div className="p-4">
                {salesByDate.length > 0 ? (
                  <ResponsiveContainer width="100%" height={210}>
                    <AreaChart data={salesByDate}><XAxis dataKey="date" stroke="#94a3b8" style={{ fontSize: 10 }} /><YAxis stroke="#94a3b8" style={{ fontSize: 10 }} /><Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }} formatter={(v: any) => formatMoney(Number(v), currentCurrency)} /><Area type="monotone" dataKey="value" stroke="#06b6d4" fill="#06b6d4" fillOpacity={0.25} /></AreaChart>
                  </ResponsiveContainer>
                ) : <p className="text-xs text-slate-500 text-center py-10">No receipts recorded yet.</p>}
              </div>
            </Card>
            <Card title="Product Performance" icon={BarChart as any}>
              <DataTable headers={["Product", "Stock", "Sold", "Est. Revenue", "Margin", "Status"]}
                rows={productPerformance.slice(0, 6).map((p) => [
                  <span key="n" className="font-semibold text-slate-200">{p.name}</span>,
                  `${p.quantity} / min ${p.minStockThreshold}`,
                  p.soldQty,
                  formatMoney(p.estRevenue, currentCurrency, true),
                  `${p.marginPct}%`,
                  <Badge key="s" s={p.status || "IN_STOCK"} />,
                ])} />
            </Card>
          </div>

          {/* Recent Transactions */}
          <Card title="Recent Transactions" icon={FileText}>
            <DataTable headers={["Date", "Reference", "Type", "Category", "Method", "Amount", "Recorded By"]}
              rows={recentTx.map((t) => [
                t.date, t.transactionNumber,
                <Badge key="t" s={t.type === "INCOME" ? "RECEIVED" : t.type === "EXPENSE" ? "OPEN" : "PENDING"} />,
                t.category, (t.paymentMethod || "").replaceAll("_", " "),
                <span key="a" className={t.type === "INCOME" ? "text-emerald-300 font-bold" : "text-rose-300 font-bold"}>{formatMoney(t.amountGhs, currentCurrency, true)}</span>,
                t.recordedBy,
              ])} />
          </Card>
        </div>
      )}

      {/* ══════════════ PRODUCTS & STOCK ══════════════ */}
      {tab === "PRODUCTS" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Products" value={branchInventory.length} sub="SKUs at this branch" color="cyan" icon={Boxes} />
            <Stat label="Units On Hand" value={branchInventory.reduce((s, i) => s + (i.quantity || 0), 0)} sub="all products" color="blue" icon={Package} />
            <Stat label="Stock Cost Value" value={formatMoney(branchInventory.reduce((s, i) => s + (i.quantity || 0) * (i.costPriceGhs || 0), 0), currentCurrency, true)} sub="at cost price" color="amber" icon={Wallet} />
            <Stat label="Low / Out of Stock" value={branchInventory.filter((i) => i.status !== "IN_STOCK").length} sub="need reorder" color="rose" icon={AlertTriangle} />
          </div>
          <Card title="Product Performance & Stock" icon={Package}
            action={<div className="flex gap-2">
              <button onClick={() => setShowForm("ITEM")} className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />New Product</button>
              <button onClick={() => setShowForm("PURCHASE")} className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><Truck className="w-3.5 h-3.5" />Restock (Purchase)</button>
            </div>}>
            <DataTable headers={["Product", "SKU", "Qty", "Cost", "Price", "Sold", "Est. Revenue", "Margin", "Status", ""]}
              rows={productPerformance.map((p) => [
                <span key="n" className="font-semibold text-slate-200">{p.name}</span>,
                p.sku, p.quantity,
                formatMoney(p.costPriceGhs, currentCurrency, true),
                formatMoney(p.sellingPriceGhs, currentCurrency, true),
                p.soldQty,
                formatMoney(p.estRevenue, currentCurrency, true),
                `${p.marginPct}%`,
                <Badge key="s" s={p.status || "IN_STOCK"} />,
                <button key="b" onClick={() => setShowForm("PURCHASE")} className="px-2 py-1 rounded bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 text-[10px] font-bold">Restock</button>,
              ])} />
            <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Sales deduct stock automatically; supplier purchases received add stock back and can book the expense to Finance in one step.</p>
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
              <Card title="Customer Orders" icon={ShoppingCart}
                action={<button onClick={() => setShowForm("ORDER")} className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />New Order</button>}>
                <DataTable headers={["Order #", "Customer", "Item", "Qty", "Total", "Due", "Status", ""]}
                  rows={orders.map((o) => [
                    o.orderNumber, o.customerName, o.itemName, o.quantity,
                    formatMoney(o.totalGhs, currentCurrency, true), o.dueDate || "—",
                    <Badge key="s" s={o.status} />,
                    nextOrderStatus[o.status]
                      ? <button key="a" onClick={() => patchEntity("ORDER", o.id, { status: nextOrderStatus[o.status] })} className="px-2 py-1 rounded bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-[10px] font-bold">→ {nextOrderStatus[o.status]}</button>
                      : "—",
                  ])} />
              </Card>
              <Card title="Supplier Purchases" icon={Truck}
                action={<button onClick={() => setShowForm("PURCHASE")} className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />Record Purchase</button>}>
                <DataTable headers={["PO #", "Supplier", "Item", "Qty", "Total", "Ordered", "Status"]}
                  rows={purchases.map((p) => [
                    p.purchaseNumber, p.supplierName, p.itemName, p.quantity,
                    formatMoney(p.totalGhs, currentCurrency, true), p.orderDate,
                    <Badge key="s" s={p.status} />,
                  ])} />
              </Card>
            </div>
            <Card title="Suppliers" icon={Users}>
              <div className="p-4 space-y-2">
                {(techSuppliers.length ? techSuppliers : suppliers).map((s) => (
                  <div key={s.id} className="p-2.5 rounded-lg bg-slate-900/70 border border-slate-700 text-xs">
                    <div className="flex justify-between gap-2"><span className="font-semibold text-slate-200">{s.name}</span><span className="text-[10px] text-slate-500">{s.paymentTerms?.replaceAll("_", " ")}</span></div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{s.category}</div>
                    <div className="text-[10px] text-purple-300 mt-0.5 font-bold">Purchases here: {formatMoney(supplierSpend[s.name] || 0, currentCurrency, true)} • lifetime supplied {formatMoney(s.totalSuppliedGhs || 0, currentCurrency, true)}</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ══════════════ WARRANTY & SERIALS ══════════════ */}
      {tab === "SERVICE" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Stat label="Serials Tracked" value={serials.length} sub="individual units" color="purple" icon={Barcode} />
            <Stat label="Units In Stock (SN)" value={serialStatus["IN_STOCK"] || 0} sub="serialized stock" color="emerald" icon={Package} />
            <Stat label="Units Sold (SN)" value={serialStatus["SOLD"] || 0} sub="with warranty records" color="blue" icon={TrendingUp} />
            <Stat label="Open Claims" value={openClaims.length} sub={`${oldClaims.length} over 7 days`} color="rose" icon={Wrench} />
            <Stat label="Warranty Expiring" value={expiringWarranties.length} sub="within 60 days" color="amber" icon={Award} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Warranty & Returns" icon={Wrench}
              action={<button onClick={() => setShowForm("WARRANTY")} className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />Log Claim</button>}>
              <DataTable headers={["Claim #", "Product", "Customer", "Type", "Logged", "Cost", "Status", ""]}
                rows={warranties.map((w) => [
                  w.claimNumber, w.productName, w.customerName, w.issueType.replaceAll("_", " "),
                  w.loggedDate, formatMoney(w.costGhs || 0, currentCurrency, true),
                  <Badge key="s" s={w.status} />,
                  nextClaimStatus[w.status]
                    ? <button key="a" onClick={() => patchEntity("WARRANTY", w.id, { status: nextClaimStatus[w.status] })} className="px-2 py-1 rounded bg-blue-500/20 border border-blue-500/40 text-blue-300 text-[10px] font-bold">→ {nextClaimStatus[w.status].replace("_", " ")}</button>
                    : "—",
                ])} />
            </Card>
            <Card title="Serial Number Tracking" icon={Barcode}
              action={<button onClick={() => setShowForm("SERIAL")} className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />Register Serial</button>}>
              <DataTable headers={["Serial Number", "Product", "Brand", "Customer", "Warranty Ends", "Status"]}
                rows={serials.map((s) => [
                  <span key="sn" className="font-mono text-[11px] text-purple-300">{s.serialNumber}</span>,
                  s.productName, s.brand || "—", s.customerName || "—", s.warrantyEnd || "—",
                  <Badge key="st" s={s.status} />,
                ])} />
              <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Logging a warranty claim for a tracked serial automatically marks the unit UNDER_REPAIR / RETURNED; restoring it happens on resolve.</p>
            </Card>
          </div>
        </div>
      )}

      {/* ══════════════ STAFF & OPS ══════════════ */}
      {tab === "STAFF" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Branch Staff" value={branchEmployees.length} sub={`${branchEmployees.filter((e) => e.status === "ACTIVE").length} active`} color="cyan" icon={UserCog} />
            <Stat label="Assets" value={branchAssets.length} sub={`${formatMoney(branchAssets.reduce((s, a) => s + (a.valueGhs || a.purchaseCostGhs || 0), 0), currentCurrency, true)} value`} color="blue" icon={Package} />
            <Stat label="Branch Customers" value={branchCustomers.length} sub={`${customers.filter((c) => !c.businessId).length} shared enterprise-wide`} color="emerald" icon={Users} />
            <Stat label="Ops Log Entries" value={opsLogs.length} sub="serial/unit registry" color="purple" icon={FileText} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Staff Performance" icon={UserCog}>
              <DataTable headers={["Staff", "Sales Made", "Sales Value", "Claims Handled", "Expenses Logged"]}
                rows={staffPerformance.map((s) => [
                  <span key="n" className="font-semibold text-slate-200">{s.name}</span>,
                  s.sales, formatMoney(s.salesAmt, currentCurrency, true), s.claims, s.expenses,
                ])} />
              <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Sales & expenses are attributed from each transaction's recorded-by stamp, handled claims from service records.</p>
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
          <Card title="Electronics Ops Log (Unit & Warranty Registry)" icon={FileText}
            action={<button onClick={() => setShowForm("LOG")} className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />Log Unit Check</button>}>
            <DataTable headers={["Last Checked", "Serial #", "Product", "Brand", "Warranty", "Retail Price", "In Stock"]}
              rows={opsLogs.map((l) => [
                l.lastCheckedDate, <span key="s" className="font-mono text-[11px]">{l.serialNumber}</span>, l.productName, l.brand,
                `${l.warrantyMonths} mo`, formatMoney(l.retailPriceGhs || 0, currentCurrency, true),
                l.inStock ? "YES" : "NO",
              ])} />
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
            accent="violet"
            testid="fin-report-tech"
            aiModuleKey="TECH"
            opsLinks={[
              {
                label: "Orders delivered",
                value: `${orders.filter((o: any) => o.status === "DELIVERED").length} of ${orders.length}`,
                note: "Fulfilled orders deduct stock and post revenue automatically",
                tone: "emerald",
              },
              {
                label: "Supplier purchases received",
                value: formatMoney(
                  purchases.filter((p: any) => p.status === "RECEIVED").reduce((s: number, p: any) => s + (p.totalGhs || 0), 0),
                  currentCurrency,
                  true
                ),
                tone: "violet",
              },
              {
                label: "Units sold (serials)",
                value: String(serials.filter((s: any) => s.status === "SOLD").length),
                tone: "sky",
              },
            ]}
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
          accent="cyan"
          onChanged={() => { refresh(); onRefreshData?.(); }}
        />
      )}

      {showForm && <ElectronicsForm type={showForm} busy={busy} onClose={() => { setShowForm(null); setError(""); }} onSubmit={submit} inventory={branchInventory} serials={serials} suppliers={suppliers} currency={currentCurrency} />}
    </div>
  );
}

function ElectronicsForm({ type, busy, onClose, onSubmit, inventory, serials, suppliers, currency }: any) {
  const todayStr = new Date().toISOString().split("T")[0];
  const [f, setF] = useState<any>({
    paymentMethod: "CASH",
    status: type === "SERIAL" ? "IN_STOCK" : type === "PURCHASE" ? "ORDERED" : type === "WARRANTY" ? "OPEN" : "PENDING",
    issueType: "WARRANTY_CLAIM", date: todayStr, orderDate: todayStr, loggedDate: todayStr, recordExpense: true, inStock: "true",
  });
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const I = ({ label, k, t = "text", ...rest }: any) => <div><label className="block text-[10px] text-slate-400 font-semibold mb-1">{label}</label><input type={t} value={f[k] ?? ""} onChange={(e) => set(k, t === "number" ? Number(e.target.value) : e.target.value)} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs" {...rest} /></div>;
  const S = ({ label, k, opts }: any) => <div><label className="block text-[10px] text-slate-400 font-semibold mb-1">{label}</label><select value={f[k] ?? ""} onChange={(e) => set(k, e.target.value)} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs">{opts.map((o: any) => <option key={o.v ?? o} value={o.v ?? o}>{o.l ?? o}</option>)}</select></div>;
  const title =
    type === "SALE" ? "Record Sale / Payment" :
    type === "EXPENSE" ? "Record Expense" :
    type === "ITEM" ? "Add Inventory Product" :
    type === "ORDER" ? "Create Customer Order" :
    type === "PURCHASE" ? "Record Supplier Purchase" :
    type === "SERIAL" ? "Register Unit Serial" :
    type === "WARRANTY" ? "Log Warranty / Return / Repair" :
    "Log Unit Check (Ops Log)";

  const selectedItem = (inventory || []).find((i: any) => String(i.id) === String(f.inventoryId));
  const saleTotal = (Number(f.quantity) || 0) * (f.sellingPrice ? Number(f.sellingPrice) : selectedItem?.sellingPriceGhs || 0);

  const handle = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(type, { ...f });
  };

  const purchaseStatusOpts = [{ v: "ORDERED", l: "Ordered (on the way)" }, { v: "RECEIVED", l: "Received (stock-in + expense booked)" }];

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"><div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto"><div className="flex items-center justify-between p-5 border-b border-slate-800 sticky top-0 bg-slate-900 z-10"><h3 className="text-lg font-bold text-white">{title}</h3><button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button></div><form onSubmit={handle} className="p-5 space-y-3">
    {type === "SALE" && <>
      <div className="grid grid-cols-2 gap-3"><I label="Customer Name" k="customerName" required /><I label="Customer Phone" k="customerPhone" /></div>
      <S label="Product" k="inventoryId" opts={[{ v: "", l: "— select product —" }, ...(inventory || []).map((i: any) => ({ v: i.id, l: `${i.name} (${i.quantity} in stock)` }))]} />
      <div className="grid grid-cols-2 gap-3"><I label="Quantity" k="quantity" t="number" required min={1} /><I label="Unit Price (GH₵)" k="sellingPrice" t="number" step="0.01" placeholder={selectedItem ? String(selectedItem.sellingPriceGhs) : "auto"} /></div>
      <div className="grid grid-cols-2 gap-3"><S label="Payment" k="paymentMethod" opts={["CASH", "MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER", "POS_CARD"]} /><I label="Discount %" k="discountPct" t="number" step="0.5" min={0} max={100} placeholder="auto" /><I label="Discount (GH₵)" k="discount" t="number" step="0.01" min={0} /></div>
      <I label="Custom price reason (if discounted)" k="customPriceReason" /><I label="Notes" k="notes" />
      {saleTotal > 0 && <div className="text-xs text-cyan-300 font-bold">Total: {formatMoney(saleTotal, currency)}</div>}
    </>}
    {type === "EXPENSE" && <><div className="grid grid-cols-2 gap-3"><I label="Category" k="category" placeholder="Rent, Fuel, Utilities, Repair..." required /><I label="Amount (GH₵)" k="amountGhs" t="number" step="0.01" required /><S label="Payment" k="paymentMethod" opts={["CASH", "MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER", "POS_CARD"]} /><I label="Date" k="date" t="date" /></div><I label="Description" k="description" /></>}
    {type === "ITEM" && <><div className="grid grid-cols-2 gap-3"><I label="Product Name" k="name" required /><I label="SKU" k="sku" placeholder="auto if blank" /></div><div className="grid grid-cols-2 gap-3"><I label="Category" k="category" placeholder="Electronics & Solar" list="tec-item-cats" /><I label="Unit" k="unit" placeholder="Units" /></div><div className="grid grid-cols-2 gap-3"><I label="Opening Qty" k="quantity" t="number" min={0} /><I label="Min Stock Alert" k="minStockThreshold" t="number" min={0} /></div><div className="grid grid-cols-2 gap-3"><I label="Cost Price (GH₵)" k="costPriceGhs" t="number" step="0.01" /><I label="Selling Price (GH₵)" k="sellingPriceGhs" t="number" step="0.01" /></div><datalist id="tec-item-cats">{["Electronics & Solar", "Phones & Accessories", "Computers", "Home Appliances", "TV & Audio"].map((c) => <option key={c} value={c} />)}</datalist></>}
    {type === "ORDER" && <><div className="grid grid-cols-2 gap-3"><I label="Customer Name" k="customerName" required /><I label="Customer Phone" k="customerPhone" /></div><S label="Product (from stock)" k="inventoryId" opts={[{ v: "", l: "— custom / not in stock list —" }, ...(inventory || []).map((i: any) => ({ v: i.id, l: `${i.name} (${i.quantity} in stock)` }))]} /><I label="Item Name (if custom)" k="itemName" placeholder={selectedItem?.name || "e.g. 65-inch 4K QLED Smart TV"} />{selectedItem && !f.itemName && <p className="text-[10px] text-cyan-300 -mt-2">Will use: {selectedItem.name}</p>}<div className="grid grid-cols-3 gap-3"><I label="Qty" k="quantity" t="number" required min={1} /><I label="Unit Price (GH₵)" k="unitPriceGhs" t="number" step="0.01" required placeholder={selectedItem ? String(selectedItem.sellingPriceGhs) : ""} /><I label="Due Date" k="dueDate" t="date" /></div><S label="Status" k="status" opts={["PENDING", "READY", "DELIVERED", "CANCELLED"]} /><I label="Notes" k="notes" /></>}
    {type === "PURCHASE" && <>
      <div className="grid grid-cols-2 gap-3"><S label="Supplier" k="supplierName" opts={(suppliers || []).map((s: any) => s.name)} /><I label="Item / Product" k="itemName" placeholder={selectedItem?.name || "e.g. 65-inch 4K QLED Smart TV"} required /></div>
      <S label="Match stock item (optional)" k="inventoryId" opts={[{ v: "", l: "— auto-match by name —" }, ...(inventory || []).map((i: any) => ({ v: i.id, l: `${i.name} (${i.quantity} in stock)` }))]} />
      <div className="grid grid-cols-3 gap-3"><I label="Qty" k="quantity" t="number" required min={1} /><I label="Unit Cost (GH₵)" k="unitCostGhs" t="number" step="0.01" required /><I label="Sell Price (GH₵)" k="sellingPriceGhs" t="number" step="0.01" placeholder="new items" /></div>
      <div className="grid grid-cols-2 gap-3"><S label="Status" k="status" opts={purchaseStatusOpts} /><I label="Order Date" k="orderDate" t="date" /></div>
      <S label="Payment (if received)" k="paymentMethod" opts={["BANK_TRANSFER", "MTN_MOMO", "CASH", "POS_CARD", "TELECEL_CASH"]} />
      <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer"><input type="checkbox" checked={f.recordExpense !== false} onChange={(e) => set("recordExpense", e.target.checked)} className="accent-indigo-500 w-3.5 h-3.5" />Book expense to Finance when received (Recommended)</label>
      <I label="Notes" k="notes" />
    </>}
    {type === "SERIAL" && <><div className="grid grid-cols-2 gap-3"><I label="Serial Number" k="serialNumber" placeholder="SN-… auto if blank" /><I label="Brand" k="brand" placeholder="Samsung, LG, Felicity…" /></div><I label="Product Name" k="productName" required placeholder="e.g. 65-inch 4K QLED Smart TV" /><S label="Match stock item (optional)" k="inventoryId" opts={[{ v: "", l: "— none —" }, ...(inventory || []).map((i: any) => ({ v: i.id, l: i.name }))]} /><div className="grid grid-cols-3 gap-3"><S label="Status" k="status" opts={["IN_STOCK", "SOLD", "RESERVED"]} /><I label="Price (GH₵)" k="priceGhs" t="number" step="0.01" /><I label="Warranty (months)" k="warrantyMonths" t="number" min={0} placeholder="12" /></div><div className="grid grid-cols-2 gap-3"><I label="Customer (if sold)" k="customerName" /><I label="Sale Date" k="saleDate" t="date" /></div></>}
    {type === "WARRANTY" && <>
      <S label="Tracked serial (optional)" k="serialNumber" opts={[{ v: "", l: "— not tracked / walk-in —" }, ...(serials || []).map((s: any) => ({ v: s.serialNumber, l: `${s.serialNumber} • ${s.productName}` }))]} />
      <div className="grid grid-cols-2 gap-3"><I label="Product" k="productName" required /><I label="Serial # (if not tracked)" k="serialText" placeholder="optional" onBlur={(e: any) => { if (!f.serialNumber) set("serialNumber", e.target.value); }} /></div>
      <div className="grid grid-cols-2 gap-3"><I label="Customer" k="customerName" required /><I label="Phone" k="customerPhone" /></div>
      <div className="grid grid-cols-3 gap-3"><S label="Type" k="issueType" opts={["WARRANTY_CLAIM", "RETURN", "REPAIR"]} /><I label="Service Cost (GH₵)" k="costGhs" t="number" step="0.01" min={0} /><I label="Logged Date" k="loggedDate" t="date" /></div>
      <I label="Issue description" k="description" placeholder="Fault, symptoms, accessories returned…" />
    </>}
    {type === "LOG" && <><div className="grid grid-cols-2 gap-3"><I label="Serial Number" k="serialNumber" placeholder="SN-… auto if blank" /><I label="Brand" k="brand" placeholder="Felicity Solar" /></div><I label="Product Name" k="productName" required placeholder="5kVA Solar Hybrid Inverter + Smart BMS" /><div className="grid grid-cols-3 gap-3"><I label="Warranty (months)" k="warrantyMonths" t="number" min={0} placeholder="24" /><I label="Retail Price (GH₵)" k="retailPriceGhs" t="number" step="0.01" /><S label="In Stock" k="inStock" opts={[{ v: "true", l: "Yes" }, { v: "false", l: "No" }]} /></div><p className="text-[10px] text-slate-500">This is the legacy electronics ops log — unit registry with warranty terms and stock check date.</p></>}
    <div className="flex justify-end gap-3 pt-3 border-t border-slate-800"><button type="button" onClick={onClose} className="px-4 py-2 bg-slate-800 rounded-lg text-xs text-slate-300">Cancel</button><button disabled={busy} className="px-5 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-xs font-bold text-white disabled:opacity-50">{busy ? "Saving..." : "Save"}</button></div>
  </form></div></div>;
}
