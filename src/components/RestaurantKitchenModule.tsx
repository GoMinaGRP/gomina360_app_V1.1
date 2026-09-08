"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import AiSectionGuide from "./AiSectionGuide";
import {
  UtensilsCrossed, ChefHat, Package, AlertTriangle, TrendingUp, TrendingDown, Wallet, Activity,
  Users, Truck, FileText, Trash2, LayoutDashboard, ListOrdered, ShoppingBasket, Boxes,
  UserCog, X, Plus, ShieldCheck, Sparkles, ClipboardCheck, ReceiptText, BookOpenText,
} from "lucide-react";
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

type Tab = "DASHBOARD" | "MENU" | "STOCK" | "ORDERS" | "PURCHASES" | "FINANCE" | "STAFF";
type FormType = "SALE" | "EXPENSE" | "ITEM" | "ORDER" | "MENU_ITEM" | "WASTE" | "PURCHASE" | "SHIFT_LOG" | null;

const TABS: { key: Tab; label: string; icon: any }[] = [
  { key: "DASHBOARD", label: "Dashboard", icon: LayoutDashboard },
  { key: "MENU", label: "Menu Performance", icon: BookOpenText },
  { key: "STOCK", label: "Stock, Cost & Waste", icon: ShoppingBasket },
  { key: "ORDERS", label: "Sales & Orders", icon: ListOrdered },
  { key: "PURCHASES", label: "Purchases & Suppliers", icon: Truck },
  { key: "FINANCE", label: "Finance & Reports", icon: Wallet },
  { key: "STAFF", label: "Staff & Checklist", icon: UserCog },
];

const STATUS_STYLE: Record<string, string> = {
  QUEUED: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  COOKING: "bg-orange-500/15 text-orange-300 border-orange-500/40",
  READY: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  SERVED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  CANCELLED: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  ORDERED: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  RECEIVED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  IN_STOCK: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  LOW_STOCK: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  OUT_OF_STOCK: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  ACTIVE: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  OFF: "bg-slate-700/40 text-slate-400 border-slate-600",
};
const Badge = ({ s }: { s: string }) => (
  <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${STATUS_STYLE[s] || "bg-slate-700/40 text-slate-300 border-slate-600"}`}>{s}</span>
);

const WASTE_REASONS = ["SPOILAGE", "EXPIRED", "OVERCOOKED", "PREP_LOSS", "CUSTOMER_RETURN"];
const NEXT_ORDER: Record<string, string> = { QUEUED: "COOKING", COOKING: "READY", READY: "SERVED" };

export default function RestaurantKitchenModule({
  currentUser, businessInfo, businessMetrics, inventory, customers, suppliers,
  transactions, assets, employees, currentCurrency, onRefreshData,
}: Props) {
  const bizId = businessInfo?.id;
  const today = new Date().toISOString().split("T")[0];

  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("DASHBOARD");
  const [menu, setMenu] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [waste, setWaste] = useState<any[]>([]);
  const [purchases, setPurchases] = useState<any[]>([]);
  const [shiftLogs, setShiftLogs] = useState<any[]>([]);
  const [checklists, setChecklists] = useState<any[]>([]);
  const [showForm, setShowForm] = useState<FormType>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!bizId) return;
    try {
      const [rRes, lRes, cRes] = await Promise.all([
        fetch(`/api/restaurant?businessId=${bizId}`),
        fetch(`/api/logs/${businessInfo?.code || "FOOD-01"}`),
        fetch(`/api/checklists?businessId=${bizId}`),
      ]);
      const rD = await rRes.json();
      const lD = await lRes.json();
      const cD = await cRes.json();
      if (rD.success) {
        setMenu(rD.menu || []);
        setOrders(rD.orders || []);
        setWaste(rD.waste || []);
        setPurchases(rD.purchases || []);
      }
      if (lD.success) setShiftLogs((lD.logs || []).filter((l: any) => l.businessId === bizId));
      if (cD.success) setChecklists(cD.entries || []);
    } finally {
      setLoading(false);
    }
  }, [bizId]);

  useEffect(() => { refresh(); }, [refresh]);

  // ── Scoped shared data ────────────────────────────────────────────────
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

  // ── Sales & Orders / Kitchen status ───────────────────────────────────
  const activeTickets = orders.filter((o) => ["QUEUED", "COOKING", "READY"].includes(o.status));
  const queuedCount = activeTickets.filter((o) => o.status === "QUEUED").length;
  const cookingCount = activeTickets.filter((o) => o.status === "COOKING").length;
  const readyCount = activeTickets.filter((o) => o.status === "READY").length;
  const servedToday = orders.filter((o) => o.status === "SERVED" && o.orderedDate === today).length;
  const orderRevenue = orders.filter((o) => o.status !== "CANCELLED").reduce((s, o) => s + (o.totalGhs || 0), 0);
  const todayRevenue = income.filter((t) => t.date === today).reduce((s, t) => s + (t.amountGhs || 0), 0)
    + orders.filter((o) => o.status !== "CANCELLED" && o.orderedDate === today).reduce((s, o) => s + (o.totalGhs || 0), 0);

  // ── Menu Performance ──────────────────────────────────────────────────
  const menuPerf = useMemo(() => {
    const m: Record<string, { name: string; qty: number; revenue: number; cost: number; cat: string; active: boolean }> = {};
    menu.forEach((mi) => { m[mi.name] = { name: mi.name, qty: 0, revenue: 0, cost: 0, cat: mi.category || "MAIN", active: mi.isActive !== false }; });
    orders.filter((o) => o.status !== "CANCELLED").forEach((o) => {
      const mi = menu.find((x) => x.id === o.menuItemId) || menu.find((x) => x.name === o.itemName);
      const key = mi ? mi.name : o.itemName;
      if (!m[key]) m[key] = { name: key, qty: 0, revenue: 0, cost: 0, cat: mi?.category || "MAIN", active: mi ? mi.isActive !== false : true };
      m[key].qty += o.quantity || 0;
      m[key].revenue += o.totalGhs || 0;
      m[key].cost += (mi?.costGhs || 0) * (o.quantity || 0);
    });
    return Object.values(m).sort((a, b) => b.revenue - a.revenue);
  }, [menu, orders]);
  const topDish = menuPerf.find((p) => p.revenue > 0);

  // ── Food Cost & Waste ─────────────────────────────────────────────────
  const orderFoodCost = menuPerf.reduce((s, p) => s + p.cost, 0);
  const wasteCost = waste.reduce((s, w) => s + (w.costGhs || 0), 0);
  const receivedStockCost = purchases.filter((p) => p.status === "RECEIVED").reduce((s, p) => s + (p.totalGhs || 0), 0);
  const totalSalesBase = revenue + orderRevenue;
  const foodCostPct = totalSalesBase > 0 ? ((orderFoodCost + wasteCost) / totalSalesBase) * 100 : 0;
  const wasteByReason = useMemo(() => {
    const m: Record<string, { qty: number; cost: number }> = {};
    waste.forEach((w) => {
      if (!m[w.reason]) m[w.reason] = { qty: 0, cost: 0 };
      m[w.reason].qty += w.quantity || 0;
      m[w.reason].cost += w.costGhs || 0;
    });
    return Object.entries(m).map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.cost - a.cost);
  }, [waste]);

  // ── Food Safety & Expiry ──────────────────────────────────────────────
  const expiryAlerts = useMemo(() => branchInventory.filter((i) => {
    if (!i.expiryDate) return false;
    const days = (new Date(i.expiryDate).getTime() - Date.now()) / 86400e3;
    return days <= 14; // expired or expiring within 14 days
  }).map((i) => ({ ...i, daysLeft: Math.round((new Date(i.expiryDate).getTime() - Date.now()) / 86400e3) }))
    .sort((a, b) => a.daysLeft - b.daysLeft), [branchInventory]);
  const lowStock = branchInventory.filter((i) => i.status !== "IN_STOCK");
  const fridgeTaskToday = checklists.find((c) => c.checklistDate === today && c.taskKey === "FRIDGE_TEMPS");

  // ── Suppliers & Purchases ─────────────────────────────────────────────
  const kitchenSuppliers = useMemo(() => {
    const rel = suppliers.filter((s) => /food|market|fish|meat|veget|ingredient|poultry|beverage|drink/i.test(s.category || "") || purchases.some((p) => p.supplierName === s.name));
    return rel.length ? rel : suppliers;
  }, [suppliers, purchases]);
  const openPurchaseValue = purchases.filter((p) => p.status === "ORDERED").reduce((s, p) => s + (p.totalGhs || 0), 0);

  // ── Staff Performance ─────────────────────────────────────────────────
  const staffPerf = useMemo(() => {
    const m: Record<string, { name: string; sales: number; salesAmt: number; ordersTaken: number; wasteLogged: number }> = {};
    branchTx.forEach((t) => {
      const k = t.recordedBy || "Unknown";
      if (!m[k]) m[k] = { name: k, sales: 0, salesAmt: 0, ordersTaken: 0, wasteLogged: 0 };
      if (t.type === "INCOME") { m[k].sales++; m[k].salesAmt += t.amountGhs || 0; }
    });
    orders.forEach((o) => { const k = o.createdByName || "Unknown"; if (!m[k]) m[k] = { name: k, sales: 0, salesAmt: 0, ordersTaken: 0, wasteLogged: 0 }; m[k].ordersTaken++; });
    waste.forEach((w) => { const k = w.recordedByName || "Unknown"; if (!m[k]) m[k] = { name: k, sales: 0, salesAmt: 0, ordersTaken: 0, wasteLogged: 0 }; m[k].wasteLogged++; });
    const rows = Object.values(m).sort((a, b) => b.salesAmt - a.salesAmt);
    branchEmployees.forEach((e) => { if (!m[e.name]) rows.push({ name: e.name, sales: 0, salesAmt: 0, ordersTaken: 0, wasteLogged: 0 }); });
    return rows;
  }, [branchTx, orders, waste, branchEmployees]);

  // ── Recent Activities (merged feed) ───────────────────────────────────
  const activities = useMemo(() => {
    const feed: { at: string; kind: string; text: string; amount?: number }[] = [];
    branchTx.forEach((t) => feed.push({ at: t.createdAt || t.date, kind: t.type === "INCOME" ? "SALE" : "EXPENSE", text: `${t.category} — ${t.description || ""}`, amount: t.amountGhs }));
    orders.forEach((o) => feed.push({ at: o.createdAt || o.orderedDate, kind: "ORDER", text: `${o.orderNumber} • ${o.customerName} • ${o.quantity}× ${o.itemName} (${o.status})`, amount: o.totalGhs }));
    waste.forEach((w) => feed.push({ at: w.createdAt || w.loggedDate, kind: "WASTE", text: `${w.quantity} ${w.unit} ${w.itemName} wasted (${w.reason})`, amount: w.costGhs }));
    purchases.forEach((p) => feed.push({ at: p.createdAt || p.orderDate, kind: "PURCHASE", text: `${p.purchaseNumber} • ${p.quantity} ${p.unit} ${p.itemName} from ${p.supplierName} (${p.status})`, amount: p.totalGhs }));
    return feed.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 12);
  }, [branchTx, orders, waste, purchases]);

  // ── AI Alerts & Business Insights ─────────────────────────────────────
  const insights = useMemo(() => {
    const out: { level: "POSITIVE" | "WARNING" | "CRITICAL" | "INFO"; title: string; detail: string }[] = [];
    if (foodCostPct > 35 && totalSalesBase > 0) out.push({ level: "CRITICAL", title: `Food cost at ${foodCostPct.toFixed(1)}%`, detail: "Above the 30–35% kitchen target — review recipe costs, supplier prices and portion sizes." });
    else if (foodCostPct > 0) out.push({ level: "POSITIVE", title: `Food cost healthy at ${foodCostPct.toFixed(1)}%`, detail: `Kitchen is within the 30–35% target band (latest shift log: ${shiftLogs[0]?.foodCostPercent ?? "—"}%).` });
    const wastePct = totalSalesBase > 0 ? (wasteCost / totalSalesBase) * 100 : 0;
    if (wastePct > 3) out.push({ level: "WARNING", title: `Food waste at ${wastePct.toFixed(1)}% of sales`, detail: "Tighten prep batching and first-expire-first-out rotation in the cold room." });
    if (expiryAlerts.length > 0) out.push({ level: expiryAlerts.some((a) => a.daysLeft <= 0) ? "CRITICAL" : "WARNING", title: `${expiryAlerts.length} stock item(s) expiring ≤ 14 days`, detail: `Use or write off: ${expiryAlerts.slice(0, 3).map((a) => `${a.name}${a.daysLeft <= 0 ? " (EXPIRED)" : ` (${a.daysLeft}d)`}`).join(", ")}` });
    if (!fridgeTaskToday) out.push({ level: "INFO", title: "No fridge-temperature log today", detail: "The daily checklist includes the FRIDGE_TEMPS task — a manager should create today's checklist." });
    else if (!fridgeTaskToday.isCompleted) out.push({ level: "WARNING", title: "Fridge temperature check pending", detail: "Food safety task FRIDGE_TEMPS is on today's checklist but not yet completed." });
    if (topDish) out.push({ level: "INFO", title: `Best seller: ${topDish.name}`, detail: `${topDish.qty} plates • ${formatMoney(topDish.revenue, currentCurrency, true)} tracked. Keep its ingredients ahead of demand.` });
    lowStock.forEach((i) => out.push({ level: i.status === "OUT_OF_STOCK" ? "CRITICAL" : "WARNING", title: `${i.name} — ${i.status.replace("_", " ")}`, detail: `${i.quantity} ${i.unit} left (min ${i.minStockThreshold}). Raise a supplier purchase.`.slice(0, 300) }));
    if (cookingCount > 5) out.push({ level: "WARNING", title: `${cookingCount} tickets cooking at once`, detail: "Kitchen load is high — watch ticket times to protect table turn rates." });
    if (out.length === 0) out.push({ level: "POSITIVE", title: "Kitchen operations healthy", detail: "No cost, safety or service risks detected right now." });
    return out;
  }, [foodCostPct, totalSalesBase, wasteCost, expiryAlerts, fridgeTaskToday, topDish, lowStock, cookingCount, shiftLogs, currentCurrency]);

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
            paymentMethod: data.paymentMethod, notes: data.notes, discount: Number(data.discount) || 0,
            discountPercent: data.discountPct ? Number(data.discountPct) : undefined,
            cartItems: [{ inventoryId: Number(data.inventoryId), quantity: Number(data.quantity), sellingPrice: data.sellingPrice ? Number(data.sellingPrice) : undefined, originalPrice: data.sellingPrice ? Number(data.sellingPrice) : undefined, customPriceReason: data.customPriceReason }],
            createdByUserId: currentUser?.id, createdByName: currentUser?.name, createdByRole: currentUser?.role,
          }),
        });
        d = await res.json();
      } else if (entity === "ITEM") {
        const res = await fetch("/api/enterprise", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entityType: "inventory", data: { ...data, businessId: bizId, category: data.category || "Food & Ingredients" } }),
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
      } else if (entity === "SHIFT_LOG") {
        const res = await fetch(`/api/logs/${businessInfo?.code || "FOOD-01"}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            totalOrders: Number(data.totalOrders) || 0,
            mostPopularDish: data.mostPopularDish || topDish?.name,
            foodCostPercent: Number(data.foodCostPercent) || 0,
            wastePercent: Number(data.wastePercent) || 0,
            momoReceiptsGhs: Number(data.momoReceiptsGhs) || 0,
            cashReceiptsGhs: Number(data.cashReceiptsGhs) || 0,
          }),
        });
        d = await res.json();
      } else {
        const res = await fetch("/api/restaurant", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entity, data: { ...data, businessId: bizId, branchCode: businessInfo?.code, createdByName: currentUser?.name, createdByRole: currentUser?.role, createdByUserId: currentUser?.id } }),
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
      const res = await fetch("/api/restaurant", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity, id, data: { ...data, createdByName: currentUser?.name, createdByRole: currentUser?.role, createdByUserId: currentUser?.id } }),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error);
      await refresh();
      if (entity === "PURCHASE") onRefreshData();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const Stat = ({ label, value, sub, color = "cyan", icon: Icon }: any) => {
    const C: Record<string, string> = { emerald: "text-emerald-400", cyan: "text-cyan-400", rose: "text-rose-400", amber: "text-amber-400", purple: "text-purple-400", blue: "text-blue-400", orange: "text-orange-400" };
    return (
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4">
        <div className="flex items-center justify-between text-[10px] uppercase font-bold text-slate-400"><span>{label}</span>{Icon && <Icon className={`w-4 h-4 ${C[color]}`} />}</div>
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
        <thead className="bg-slate-900/90 text-slate-400 uppercase text-[10px]"><tr>{headers.map((h: string) => <th key={h} className="px-4 py-3">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-700/60">
          {rows.length ? rows.map((r: any[], i: number) => <tr key={i} className="hover:bg-slate-700/40">{r.map((c, j) => <td key={j} className="px-4 py-3 text-slate-300">{c}</td>)}</tr>)
            : <tr><td colSpan={headers.length} className="px-4 py-8 text-center text-slate-400">No records</td></tr>}
        </tbody>
      </table>
    </div>
  );

  if (loading) return <div className="p-10 text-center text-slate-400 text-sm">Loading Mina Heritage Kitchen…</div>;

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto text-slate-100">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-6 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center shadow-lg shrink-0">
            <UtensilsCrossed className="w-7 h-7 text-orange-400" />
          </div>
          <div>
            <div className="flex items-center gap-2"><span className="px-2.5 py-0.5 rounded-full bg-orange-500/20 text-orange-300 text-xs font-bold border border-orange-500/30">RESTAURANT &amp; KITCHEN MANAGEMENT</span></div>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 text-white">{businessInfo?.name || "Mina Heritage Kitchen"}</h2>
            <p className="text-xs text-slate-400 mt-1">{businessInfo?.code || "FOOD-01"} • {businessInfo?.branchLocation || "Ghana"} • Manager: <strong className="text-orange-300">{businessInfo?.managerName || "Chef Esi Mensah"}</strong></p>
          </div>
        </div>
        {error && <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/40 rounded-lg px-3 py-2">{error}<button className="ml-2 text-rose-200" onClick={() => setError("")}>✕</button></div>}
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setShowForm("SALE")} className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold flex items-center gap-1"><TrendingUp className="w-3.5 h-3.5" />Sale</button>
          <button onClick={() => setShowForm("ORDER")} className="px-3 py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-bold flex items-center gap-1"><ChefHat className="w-3.5 h-3.5" />Order</button>
          <button onClick={() => setShowForm("MENU_ITEM")} className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1"><BookOpenText className="w-3.5 h-3.5" />Dish</button>
          <button onClick={() => setShowForm("PURCHASE")} className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><Truck className="w-3.5 h-3.5" />Purchase</button>
          <button onClick={() => setShowForm("WASTE")} className="px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" />Waste</button>
          <button onClick={() => setShowForm("EXPENSE")} className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold flex items-center gap-1"><Wallet className="w-3.5 h-3.5" />Expense</button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex flex-wrap gap-1 bg-slate-800/60 border border-slate-700 rounded-xl p-1">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition ${tab === t.key ? "bg-orange-600 text-white" : "text-slate-400 hover:text-white"}`}>
            <t.icon className="w-3.5 h-3.5" />{t.label}
          </button>
        ))}
        <AiSectionGuide moduleKey="FOOD" section={tab} businessInfo={businessInfo} />
      </div>

      {/* ══════════════ DASHBOARD ══════════════ */}
      {tab === "DASHBOARD" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat label="Revenue (ledger)" value={formatMoney(revenue, currentCurrency, true)} sub={`+ ${formatMoney(orderRevenue, currentCurrency, true)} order tickets`} color="emerald" icon={TrendingUp} />
            <Stat label="Today" value={formatMoney(todayRevenue, currentCurrency, true)} sub={`${servedToday} plates served`} color="cyan" icon={Activity} />
            <Stat label="Active Tickets" value={activeTickets.length} sub={`${queuedCount} queued • ${cookingCount} cooking • ${readyCount} ready`} color="orange" icon={ChefHat} />
            <Stat label="Food Cost" value={totalSalesBase > 0 ? `${foodCostPct.toFixed(1)}%` : "—"} sub={`waste ${formatMoney(wasteCost, currentCurrency, true)}`} color={foodCostPct > 35 ? "rose" : "purple"} icon={ShoppingBasket} />
            <Stat label="Net Profit" value={formatMoney(profit, currentCurrency, true)} sub={`${margin.toFixed(1)}% of ledger revenue`} color={profit >= 0 ? "blue" : "rose"} icon={Wallet} />
            <Stat label="Expiry Alerts" value={expiryAlerts.length} sub={`${lowStock.length} low/out of stock`} color={expiryAlerts.length ? "rose" : "emerald"} icon={ShieldCheck} />
          </div>

          {/* Kitchen Order Status */}
          <Card title="Kitchen Order Status — live ticket rail" icon={ChefHat}
            action={<button onClick={() => setShowForm("ORDER")} className="px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />New Ticket</button>}>
            <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
              {(["QUEUED", "COOKING", "READY"] as const).map((st) => (
                <div key={st} className="rounded-xl border border-slate-700 bg-slate-900/60 p-3 space-y-2">
                  <div className="flex items-center justify-between"><Badge s={st} /><span className="text-[10px] text-slate-500">{activeTickets.filter((o) => o.status === st).length} ticket(s)</span></div>
                  {activeTickets.filter((o) => o.status === st).length === 0 && <p className="text-[11px] text-slate-600 py-2 text-center">none</p>}
                  {activeTickets.filter((o) => o.status === st).slice(0, 5).map((o) => (
                    <div key={o.id} className="p-2 rounded-lg bg-slate-800 border border-slate-700 text-xs">
                      <div className="flex justify-between gap-2"><span className="font-semibold text-slate-200 truncate">{o.quantity}× {o.itemName}</span><span className="text-[10px] text-orange-300 font-bold shrink-0">{o.orderType.replaceAll("_", "-")}</span></div>
                      <div className="text-[10px] text-slate-500 mt-0.5">{o.orderNumber} • {o.customerName}</div>
                      {NEXT_ORDER[st] && <button onClick={() => patchEntity("ORDER", o.id, { status: NEXT_ORDER[st] })} className="mt-1.5 px-2 py-1 rounded bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-[10px] font-bold">→ {NEXT_ORDER[st]}</button>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Food Safety & Expiry Alerts */}
            <Card title="Food Safety & Expiry Alerts" icon={ShieldCheck}>
              <div className="p-4 space-y-2">
                <div className={`p-2.5 rounded-lg border text-xs flex items-center gap-2 ${fridgeTaskToday?.isCompleted ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-amber-500/40 bg-amber-500/10 text-amber-200"}`}>
                  <ShieldCheck className="w-4 h-4 shrink-0" />
                  {fridgeTaskToday?.isCompleted
                    ? `Fridge & freezer temperatures logged today ✓ (checklist FRIDGE_TEMPS by ${fridgeTaskToday.completedByName || "staff"})`
                    : "Fridge & freezer temperature check NOT completed today — see Daily Checklist (FRIDGE_TEMPS)."}
                </div>
                {expiryAlerts.length === 0 && <p className="text-xs text-slate-500 text-center py-2">No stock expiring within 14 days.</p>}
                {expiryAlerts.map((a) => (
                  <div key={a.id} className={`p-2.5 rounded-lg border text-xs flex items-center justify-between gap-2 ${a.daysLeft <= 0 ? "border-rose-500/40 bg-rose-500/10 text-rose-200" : "border-amber-500/40 bg-amber-500/10 text-amber-200"}`}>
                    <span className="font-semibold">{a.name}</span>
                    <span className="font-black shrink-0">{a.daysLeft <= 0 ? "EXPIRED" : `${a.daysLeft}d left`} • {a.quantity} {a.unit}</span>
                  </div>
                ))}
                <p className="text-[10px] text-slate-500">Expiry dates are set when stock is added or received; use FEFO rotation for expiring lots.</p>
              </div>
            </Card>

            {/* AI Alerts & Business Insights */}
            <Card title="AI Alerts & Business Insights" icon={Sparkles}>
              <div className="p-4 space-y-2 max-h-80 overflow-y-auto">
                {insights.map((ins, i) => {
                  const S: Record<string, string> = {
                    CRITICAL: "border-rose-500/40 bg-rose-500/10 text-rose-200",
                    WARNING: "border-amber-500/40 bg-amber-500/10 text-amber-200",
                    INFO: "border-cyan-500/40 bg-cyan-500/10 text-cyan-200",
                    POSITIVE: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
                  };
                  return <div key={i} className={`p-2.5 rounded-lg border text-xs ${S[ins.level]}`}><div className="font-bold">{ins.title}</div><div className="text-[11px] opacity-85 mt-0.5">{ins.detail}</div></div>;
                })}
              </div>
            </Card>
          </div>

          {/* Recent Activities */}
          <Card title="Recent Activities" icon={Activity}>
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-2">
              {activities.length === 0 && <p className="text-xs text-slate-500 p-4">No activity yet — sales, orders, waste and purchases appear here.</p>}
              {activities.map((a, i) => {
                const ICONS: Record<string, string> = { SALE: "text-emerald-400", EXPENSE: "text-rose-400", ORDER: "text-orange-400", WASTE: "text-purple-400", PURCHASE: "text-indigo-400" };
                return (
                  <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg bg-slate-900/70 border border-slate-700 text-xs">
                    <span className={`px-2 py-0.5 rounded border border-slate-600 bg-slate-800 text-[10px] font-black ${ICONS[a.kind]}`}>{a.kind}</span>
                    <span className="flex-1 text-slate-300 truncate">{a.text}</span>
                    {a.amount != null && <span className="font-bold text-slate-200 shrink-0">{formatMoney(a.amount, currentCurrency, true)}</span>}
                    <span className="text-[10px] text-slate-500 shrink-0">{new Date(a.at).toLocaleDateString()}</span>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}

      {/* ══════════════ MENU ══════════════ */}
      {tab === "MENU" && (
        <Card title="Menu Performance — sales, cost & margin per dish" icon={BookOpenText}
          action={<button onClick={() => setShowForm("MENU_ITEM")} className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />New Dish</button>}>
          <DataTable headers={["Dish", "Category", "Price", "Plate Cost", "Plates Sold", "Revenue", "Food Cost %", "Margin", "Status", ""]}
            rows={menuPerf.map((p) => [
              <span key="n" className="font-semibold text-slate-200">{p.name}</span>,
              p.cat,
              formatMoney(menu.find((m) => m.name === p.name)?.priceGhs || 0, currentCurrency, true),
              formatMoney(menu.find((m) => m.name === p.name)?.costGhs || 0, currentCurrency, true),
              p.qty,
              formatMoney(p.revenue, currentCurrency, true),
              p.revenue > 0 ? `${((p.cost / p.revenue) * 100).toFixed(1)}%` : "—",
              (() => { const mi = menu.find((m) => m.name === p.name); return mi && mi.priceGhs > 0 ? `${Math.round(((mi.priceGhs - (mi.costGhs || 0)) / mi.priceGhs) * 100)}%` : "—"; })(),
              <Badge key="s" s={p.active ? "ACTIVE" : "OFF"} />,
              (() => { const mi = menu.find((m) => m.name === p.name); return mi ? <button key="b" onClick={() => patchEntity("MENU_ITEM", mi.id, { isActive: mi.isActive === false })} className="px-2 py-1 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[10px] font-bold">{mi.isActive !== false ? "Take off menu" : "Restore"}</button> : null; })(),
            ])} />
          <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Orders (excluding cancelled) rank dishes by revenue; plate cost is the recipe cost from the menu master and drives food-cost analytics.</p>
        </Card>
      )}

      {/* ══════════════ STOCK, COST & WASTE ══════════════ */}
      {tab === "STOCK" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Ingredients" value={branchInventory.length} sub="stocked items" color="cyan" icon={Boxes} />
            <Stat label="Stock Cost Value" value={formatMoney(branchInventory.reduce((s, i) => s + (i.quantity || 0) * (i.costPriceGhs || 0), 0), currentCurrency, true)} sub="at cost price" color="amber" icon={Wallet} />
            <Stat label="Purchases Received" value={formatMoney(receivedStockCost, currentCurrency, true)} sub="supplier stock-ins" color="purple" icon={Truck} />
            <Stat label="Waste Cost" value={formatMoney(wasteCost, currentCurrency, true)} sub={`${waste.length} waste log(s)`} color="rose" icon={Trash2} />
          </div>
          <Card title="Food Inventory" icon={ShoppingBasket}
            action={<div className="flex gap-2">
              <button onClick={() => setShowForm("ITEM")} className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />New Item</button>
              <button onClick={() => setShowForm("PURCHASE")} className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><Truck className="w-3.5 h-3.5" />Restock (Purchase)</button>
            </div>}>
            <DataTable headers={["Item", "SKU", "Qty", "Unit", "Cost", "Stock Value", "Expiry", "Status"]}
              rows={branchInventory.map((i) => {
                const days = i.expiryDate ? Math.round((new Date(i.expiryDate).getTime() - Date.now()) / 86400e3) : null;
                return [
                  <span key="n" className="font-semibold text-slate-200">{i.name}</span>,
                  i.sku, i.quantity, i.unit,
                  formatMoney(i.costPriceGhs, currentCurrency, true),
                  formatMoney((i.quantity || 0) * (i.costPriceGhs || 0), currentCurrency, true),
                  days === null ? "—" : <span key="e" className={days <= 0 ? "text-rose-300 font-bold" : days <= 14 ? "text-amber-300 font-bold" : "text-slate-300"}>{i.expiryDate}{days <= 14 ? (days <= 0 ? " (EXPIRED)" : ` (${days}d)`) : ""}</span>,
                  <Badge key="s" s={i.status || "IN_STOCK"} />,
                ];
              })} />
            <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Sales deduct stock; received purchases add it back (with optional expense booking); waste logs decrement stock too.</p>
          </Card>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Food Cost Breakdown" icon={ShoppingBasket}>
              <div className="p-4 space-y-2 text-xs">
                {[
                  ["Recipe cost of dishes sold", orderFoodCost],
                  ["Food waste written off", wasteCost],
                  ["Received stock purchases", receivedStockCost],
                ].map(([l, v]: any) => (
                  <div key={l} className="flex justify-between p-2 rounded-lg bg-slate-900/70 border border-slate-700"><span className="text-slate-400">{l}</span><span className="font-bold text-slate-200">{formatMoney(v, currentCurrency, true)}</span></div>
                ))}
                <div className="flex justify-between p-2 rounded-lg bg-slate-800 border border-slate-600"><span className="text-slate-300 font-bold">Food cost vs sales</span><span className={`font-black ${foodCostPct > 35 ? "text-rose-300" : "text-emerald-300"}`}>{totalSalesBase > 0 ? `${foodCostPct.toFixed(1)}%` : "—"}</span></div>
                <p className="text-[10px] text-slate-500">Target band 30–35%. Shift-log benchmarks: {shiftLogs[0] ? `${shiftLogs[0].foodCostPercent}% cost / ${shiftLogs[0].wastePercent}% waste on ${shiftLogs[0].shiftDate}` : "none yet"}</p>
              </div>
            </Card>
            <Card title="Food Waste Log" icon={Trash2}
              action={<button onClick={() => setShowForm("WASTE")} className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />Log Waste</button>}>
              <div className="p-4 space-y-1.5">
                {wasteByReason.map((w) => (
                  <div key={w.reason} className="flex justify-between text-xs p-2 rounded-lg bg-slate-900/70 border border-slate-700"><span className="text-slate-300 font-bold">{w.reason.replaceAll("_", " ")}</span><span className="text-slate-400">{w.qty} units • <span className="text-rose-300 font-bold">{formatMoney(w.cost, currentCurrency, true)}</span></span></div>
                ))}
              </div>
              <DataTable headers={["Date", "Item", "Qty", "Reason", "Cost", "Logged By"]}
                rows={waste.slice(0, 8).map((w) => [w.loggedDate, w.itemName, `${w.quantity} ${w.unit}`, w.reason.replaceAll("_", " "), formatMoney(w.costGhs || 0, currentCurrency, true), w.recordedByName || "—"])} />
            </Card>
          </div>
        </div>
      )}

      {/* ══════════════ SALES & ORDERS ══════════════ */}
      {tab === "ORDERS" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Sales (ledger)" value={formatMoney(revenue, currentCurrency, true)} sub={`${income.length} receipts`} color="emerald" icon={TrendingUp} />
            <Stat label="Order Tickets" value={orders.length} sub={`${formatMoney(orderRevenue, currentCurrency, true)} gross`} color="orange" icon={ChefHat} />
            <Stat label="Served Today" value={servedToday} sub={`today ${formatMoney(todayRevenue, currentCurrency, true)}`} color="cyan" icon={CheckIcon} />
            <Stat label="Active Tickets" value={activeTickets.length} sub={`${queuedCount}/${cookingCount}/${readyCount} Q/C/R`} color="amber" icon={Activity} />
          </div>
          <Card title="Orders — kitchen pipeline" icon={ListOrdered}
            action={<button onClick={() => setShowForm("ORDER")} className="px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />New Order</button>}>
            <DataTable headers={["Order #", "Customer", "Dish", "Qty", "Type", "Total", "Date", "Status", ""]}
              rows={orders.map((o) => [
                o.orderNumber, o.customerName, o.itemName, o.quantity, o.orderType.replaceAll("_", "-"),
                formatMoney(o.totalGhs, currentCurrency, true), o.orderedDate,
                <Badge key="s" s={o.status} />,
                NEXT_ORDER[o.status]
                  ? <button key="a" onClick={() => patchEntity("ORDER", o.id, { status: NEXT_ORDER[o.status] })} className="px-2 py-1 rounded bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-[10px] font-bold">→ {NEXT_ORDER[o.status]}</button>
                  : "—",
              ])} />
          </Card>
          <Card title="Sales Ledger (this branch)" icon={ReceiptText}>
            <DataTable headers={["Date", "Reference", "Category", "Method", "Amount", "Recorded By"]}
              rows={income.slice(0, 10).map((t) => [t.date, t.transactionNumber, t.category, (t.paymentMethod || "").replaceAll("_", " "), formatMoney(t.amountGhs, currentCurrency, true), t.recordedBy])} />
          </Card>
        </div>
      )}

      {/* ══════════════ PURCHASES & SUPPLIERS ══════════════ */}
      {tab === "PURCHASES" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Purchases" value={purchases.length} sub="all time" color="purple" icon={Truck} />
            <Stat label="On Order" value={purchases.filter((p) => p.status === "ORDERED").length} sub={`${formatMoney(openPurchaseValue, currentCurrency, true)} inbound`} color="amber" icon={Activity} />
            <Stat label="Received Value" value={formatMoney(receivedStockCost, currentCurrency, true)} sub="stocked-in" color="emerald" icon={CheckIcon} />
            <Stat label="Suppliers" value={kitchenSuppliers.length} sub="food-related vendors" color="cyan" icon={Users} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <Card title="Purchase Orders" icon={Truck}
                action={<button onClick={() => setShowForm("PURCHASE")} className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />Record Purchase</button>}>
                <DataTable headers={["PO #", "Supplier", "Item", "Qty", "Cost", "Total", "Ordered", "Status", ""]}
                  rows={purchases.map((p) => [
                    p.purchaseNumber, p.supplierName, p.itemName, `${p.quantity} ${p.unit}`,
                    formatMoney(p.unitCostGhs, currentCurrency, true), formatMoney(p.totalGhs, currentCurrency, true), p.orderDate,
                    <Badge key="s" s={p.status} />,
                    p.status === "ORDERED"
                      ? <button key="a" onClick={() => patchEntity("PURCHASE", p.id, { status: "RECEIVED" })} className="px-2 py-1 rounded bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 text-[10px] font-bold">→ Receive</button>
                      : "—",
                  ])} />
                <p className="px-4 pb-3 pt-1 text-[10px] text-slate-500">Receiving a purchase stocks the ingredient into Inventory (new items are created automatically) and books the expense into Finance.</p>
              </Card>
            </div>
            <Card title="Suppliers" icon={Users}>
              <div className="p-4 space-y-2">
                {kitchenSuppliers.map((s) => {
                  const spend = purchases.filter((p) => p.supplierName === s.name && p.status !== "CANCELLED").reduce((sum, p) => sum + (p.totalGhs || 0), 0);
                  return (
                    <div key={s.id} className="p-2.5 rounded-lg bg-slate-900/70 border border-slate-700 text-xs">
                      <div className="flex justify-between gap-2"><span className="font-semibold text-slate-200">{s.name}</span><span className="text-[10px] text-slate-500">{s.paymentTerms?.replaceAll("_", " ")}</span></div>
                      <div className="text-[10px] text-slate-500 mt-0.5">{s.category}</div>
                      <div className="text-[10px] text-indigo-300 mt-0.5 font-bold">Orders here: {formatMoney(spend, currentCurrency, true)} • lifetime {formatMoney(s.totalSuppliedGhs || 0, currentCurrency, true)}</div>
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
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
            accent="rose"
            testid="fin-report-food"
            aiModuleKey="FOOD"
            opsLinks={[
              {
                label: "Orders served",
                value: `${orders.filter((o: any) => o.status === "SERVED").length} of ${orders.length}`,
                note: "Served orders post revenue to this report automatically",
                tone: "emerald",
              },
              {
                label: "Purchases received",
                value: formatMoney(
                  purchases.filter((p: any) => p.status === "RECEIVED").reduce((s: number, p: any) => s + (p.totalGhs || 0), 0),
                  currentCurrency,
                  true
                ),
                tone: "rose",
              },
              {
                label: "Food waste cost",
                value: formatMoney(
                  waste.reduce((s: number, w: any) => s + (w.costGhs || 0), 0),
                  currentCurrency,
                  true
                ),
                note: "Logged waste feeds cost analytics",
                tone: "amber",
              },
            ]}
          />
        </div>
      )}

      {/* ══════════════ STAFF & CHECKLIST ══════════════ */}
      {tab === "STAFF" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Kitchen Staff" value={branchEmployees.length} sub={`${branchEmployees.filter((e) => e.status === "ACTIVE").length} active`} color="cyan" icon={UserCog} />
            <Stat label="Customers" value={branchCustomers.length} sub={`${customers.filter((c) => !c.businessId).length} shared enterprise-wide`} color="emerald" icon={Users} />
            <Stat label="Shift Logs" value={shiftLogs.length} sub="daily ops reports" color="purple" icon={FileText} />
            <Stat label="Assets" value={branchAssets.length} sub="kitchen equipment" color="blue" icon={Package} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Staff Performance" icon={UserCog}>
              <DataTable headers={["Staff", "Sales Made", "Sales Value", "Orders Taken", "Waste Logged"]}
                rows={staffPerf.map((s) => [<span key="n" className="font-semibold text-slate-200">{s.name}</span>, s.sales, formatMoney(s.salesAmt, currentCurrency, true), s.ordersTaken, s.wasteLogged])} />
            </Card>
            <Card title="Customers" icon={Users}>
              <div className="p-4 space-y-2">
                {(branchCustomers.length ? branchCustomers : customers).slice(0, 6).map((c) => (
                  <div key={c.id} className="flex justify-between text-xs p-2.5 rounded-lg bg-slate-900/70 border border-slate-700"><span className="text-slate-200 font-semibold">{c.name}</span><span className="text-slate-400">{c.type} • {formatMoney(c.totalSpentGhs || 0, currentCurrency, true)}</span></div>
                ))}
              </div>
            </Card>
          </div>
          <Card title="Daily Shift Logs (legacy ops reports)" icon={FileText}
            action={<button onClick={() => setShowForm("SHIFT_LOG")} className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" />Log Shift</button>}>
            <DataTable headers={["Shift Date", "Orders", "Most Popular Dish", "Food Cost %", "Waste %", "MoMo", "Cash"]}
              rows={shiftLogs.map((l) => [l.shiftDate, l.totalOrders, l.mostPopularDish, `${l.foodCostPercent}%`, `${l.wastePercent}%`, formatMoney(l.momoReceiptsGhs || 0, currentCurrency, true), formatMoney(l.cashReceiptsGhs || 0, currentCurrency, true)])} />
          </Card>
          <DailyChecklistPanel
            businessId={bizId}
            branchCode={businessInfo?.code}
            businessName={businessInfo?.name}
            employees={employees}
            currentUser={currentUser}
            accent="emerald"
            onChanged={() => { refresh(); onRefreshData?.(); }}
          />
        </div>
      )}

      {showForm && <KitchenForm type={showForm} busy={busy} onClose={() => { setShowForm(null); setError(""); }} onSubmit={submit} inventory={branchInventory} menu={menu} suppliers={suppliers} currency={currentCurrency} />}
    </div>
  );
}

// little helper used as an icon stand-in
function CheckIcon(props: any) {
  return <ShieldCheck {...props} />;
}

function KitchenForm({ type, busy, onClose, onSubmit, inventory, menu, suppliers, currency }: any) {
  const todayStr = new Date().toISOString().split("T")[0];
  const [f, setF] = useState<any>({
    paymentMethod: "CASH",
    status: type === "PURCHASE" ? "ORDERED" : "QUEUED",
    orderType: "DINE_IN", reason: "SPOILAGE", category: "MAIN",
    date: todayStr, orderDate: todayStr, orderedDate: todayStr, loggedDate: todayStr,
    recordExpense: true,
  });
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const I = ({ label, k, t = "text", ...rest }: any) => <div><label className="block text-[10px] text-slate-400 font-semibold mb-1">{label}</label><input type={t} value={f[k] ?? ""} onChange={(e) => set(k, t === "number" ? Number(e.target.value) : e.target.value)} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs" {...rest} /></div>;
  const S = ({ label, k, opts }: any) => <div><label className="block text-[10px] text-slate-400 font-semibold mb-1">{label}</label><select value={f[k] ?? ""} onChange={(e) => set(k, e.target.value)} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs">{opts.map((o: any) => <option key={o.v ?? o} value={o.v ?? o}>{o.l ?? o}</option>)}</select></div>;
  const title =
    type === "SALE" ? "Record Sale / Payment" :
    type === "EXPENSE" ? "Record Expense" :
    type === "ITEM" ? "Add Stock Item (Ingredient)" :
    type === "ORDER" ? "New Kitchen Order (Ticket)" :
    type === "MENU_ITEM" ? "Add Menu Dish" :
    type === "WASTE" ? "Log Food Waste" :
    type === "PURCHASE" ? "Record Supplier Purchase" :
    "Log Daily Shift";

  const selectedItem = (inventory || []).find((i: any) => String(i.id) === String(f.inventoryId));
  const selectedDish = (menu || []).find((m: any) => String(m.id) === String(f.menuItemId));

  const handle = (e: React.FormEvent) => {
    e.preventDefault();
    const payload = { ...f };
    if (type === "ORDER" && selectedDish && !payload.itemName) payload.itemName = selectedDish.name;
    if (type === "ORDER" && selectedDish && !payload.unitPriceGhs) payload.unitPriceGhs = selectedDish.priceGhs;
    onSubmit(type, payload);
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"><div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto"><div className="flex items-center justify-between p-5 border-b border-slate-800 sticky top-0 bg-slate-900 z-10"><h3 className="text-lg font-bold text-white">{title}</h3><button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button></div><form onSubmit={handle} className="p-5 space-y-3">
    {type === "SALE" && <>
      <div className="grid grid-cols-2 gap-3"><I label="Customer Name" k="customerName" required /><I label="Customer Phone" k="customerPhone" /></div>
      <S label="Stock Item" k="inventoryId" opts={[{ v: "", l: inventory.length ? "— select item —" : "— add stock items first —" }, ...(inventory || []).map((i: any) => ({ v: i.id, l: `${i.name} (${i.quantity} ${i.unit} left)` }))]} />
      <div className="grid grid-cols-2 gap-3"><I label="Quantity" k="quantity" t="number" required min={1} /><I label="Unit Price (GH₵)" k="sellingPrice" t="number" step="0.01" placeholder={selectedItem ? String(selectedItem.sellingPriceGhs) : "auto"} /></div>
      <div className="grid grid-cols-2 gap-3"><S label="Payment" k="paymentMethod" opts={["CASH", "MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER", "POS_CARD"]} /><I label="Discount %" k="discountPct" t="number" step="0.5" min={0} max={100} placeholder="auto" /><I label="Discount (GH₵)" k="discount" t="number" step="0.01" min={0} /></div>
      <I label="Custom price reason (optional)" k="customPriceReason" /><I label="Notes" k="notes" />
    </>}
    {type === "EXPENSE" && <><div className="grid grid-cols-2 gap-3"><I label="Category" k="category" placeholder="Gas, Utilities, Payroll, Rent..." required list="kit-exp" /><I label="Amount (GH₵)" k="amountGhs" t="number" step="0.01" required /><S label="Payment" k="paymentMethod" opts={["CASH", "MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER", "POS_CARD"]} /><I label="Date" k="date" t="date" /></div><I label="Description" k="description" /><datalist id="kit-exp">{["Gas & Fuel", "Utilities", "Payroll", "Rent", "Equipment Repair", "Cleaning Supplies", "Packaging"].map((c) => <option key={c} value={c} />)}</datalist></>}
    {type === "ITEM" && <><div className="grid grid-cols-2 gap-3"><I label="Item Name" k="name" required placeholder="e.g. Long Grain Rice 25kg" /><I label="SKU" k="sku" placeholder="auto if blank" /></div><div className="grid grid-cols-2 gap-3"><I label="Category" k="category" placeholder="Food & Ingredients" /><I label="Unit" k="unit" placeholder="Kg / Litres / Crates" /></div><div className="grid grid-cols-2 gap-3"><I label="Opening Qty" k="quantity" t="number" min={0} step="0.01" /><I label="Min Stock Alert" k="minStockThreshold" t="number" min={0} step="0.01" /></div><div className="grid grid-cols-2 gap-3"><I label="Cost Price (GH₵/unit)" k="costPriceGhs" t="number" step="0.01" /><I label="Expiry Date" k="expiryDate" t="date" /></div><p className="text-[10px] text-slate-500">Expiry dates power the Food Safety & Expiry Alerts card.</p></>}
    {type === "ORDER" && <>
      <div className="grid grid-cols-2 gap-3"><I label="Customer / Table" k="customerName" required placeholder="Table 4 / Walk-in Guest" /><S label="Order Type" k="orderType" opts={["DINE_IN", "TAKEAWAY", "DELIVERY"]} /></div>
      <S label="Dish (from menu)" k="menuItemId" opts={[{ v: "", l: "— custom dish —" }, ...(menu || []).filter((m: any) => m.isActive !== false).map((m: any) => ({ v: m.id, l: `${m.name} — ${formatMoney(m.priceGhs, currency, true)}` }))]} />
      <I label="Dish Name (if custom)" k="itemName" placeholder={selectedDish?.name || "e.g. Jollof Rice with Grilled Tilapia"} />
      <div className="grid grid-cols-2 gap-3"><I label="Plates / Qty" k="quantity" t="number" required min={1} /><I label="Price per Plate (GH₵)" k="unitPriceGhs" t="number" step="0.01" placeholder={selectedDish ? String(selectedDish.priceGhs) : ""} /></div>
      <I label="Notes (allergies, spice level…)" k="notes" />
    </>}
    {type === "MENU_ITEM" && <><I label="Dish Name" k="name" required placeholder="e.g. Red Red with Plantain" /><div className="grid grid-cols-2 gap-3"><S label="Category" k="category" opts={["STARTER", "MAIN", "SIDE", "DRINK", "DESSERT"]} /><I label="Description" k="description" placeholder="optional" /></div><div className="grid grid-cols-2 gap-3"><I label="Selling Price (GH₵)" k="priceGhs" t="number" step="0.01" required /><I label="Recipe Cost / Plate (GH₵)" k="costGhs" t="number" step="0.01" /></div><p className="text-[10px] text-slate-500">Recipe cost per plate drives the food-cost analytics on the Dashboard.</p></>}
    {type === "WASTE" && <>
      <S label="Stock item (optional)" k="inventoryId" opts={[{ v: "", l: "— custom item —" }, ...(inventory || []).map((i: any) => ({ v: i.id, l: `${i.name} (${i.quantity} ${i.unit} left)` }))]} />
      <I label="Item Name" k="itemName" required placeholder={selectedItem?.name || "e.g. Fresh Tilapia"} />
      <div className="grid grid-cols-3 gap-3"><I label="Qty" k="quantity" t="number" step="0.01" required min={0.01} /><I label="Unit" k="unit" placeholder="Kg / Plates" /><I label="Est. Cost (GH₵)" k="costGhs" t="number" step="0.01" placeholder={selectedItem ? String(selectedItem.costPriceGhs) : ""} /></div>
      <div className="grid grid-cols-2 gap-3"><S label="Reason" k="reason" opts={WASTE_REASONS} /><I label="Date" k="loggedDate" t="date" /></div>
      <I label="Notes" k="notes" />
      <p className="text-[10px] text-slate-500">Wasted stock is deducted from Food Inventory automatically.</p>
    </>}
    {type === "PURCHASE" && <>
      <S label="Supplier" k="supplierName" opts={(suppliers || []).map((s: any) => s.name)} />
      <I label="Item / Ingredient" k="itemName" required placeholder="e.g. Fresh Tilapia" />
      <S label="Match stock item (optional)" k="inventoryId" opts={[{ v: "", l: "— create / auto-match —" }, ...(inventory || []).map((i: any) => ({ v: i.id, l: `${i.name} (${i.quantity} ${i.unit} left)` }))]} />
      <div className="grid grid-cols-3 gap-3"><I label="Qty" k="quantity" t="number" step="0.01" required min={0.01} /><I label="Unit" k="unit" placeholder="Kg" /><I label="Unit Cost (GH₵)" k="unitCostGhs" t="number" step="0.01" required /></div>
      <div className="grid grid-cols-2 gap-3"><S label="Status" k="status" opts={[{ v: "ORDERED", l: "Ordered (on the way)" }, { v: "RECEIVED", l: "Received (stock-in + expense)" }]} /><I label="Expiry Date (batch)" k="expiryDate" t="date" /></div>
      <div className="grid grid-cols-2 gap-3"><I label="Order Date" k="orderDate" t="date" /><S label="Payment (if received)" k="paymentMethod" opts={["CASH", "MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER", "POS_CARD"]} /></div>
      <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer"><input type="checkbox" checked={f.recordExpense !== false} onChange={(e) => set("recordExpense", e.target.checked)} className="accent-indigo-500 w-3.5 h-3.5" />Book expense to Finance when received (Recommended)</label>
      <I label="Notes" k="notes" />
    </>}
    {type === "SHIFT_LOG" && <><div className="grid grid-cols-2 gap-3"><I label="Total Orders" k="totalOrders" t="number" min={0} required /><I label="Most Popular Dish" k="mostPopularDish" placeholder="auto: top dish" /></div><div className="grid grid-cols-2 gap-3"><I label="Food Cost %" k="foodCostPercent" t="number" step="0.1" required /><I label="Waste %" k="wastePercent" t="number" step="0.1" required /></div><div className="grid grid-cols-2 gap-3"><I label="MoMo Receipts (GH₵)" k="momoReceiptsGhs" t="number" step="0.01" required /><I label="Cash Receipts (GH₵)" k="cashReceiptsGhs" t="number" step="0.01" required /></div><p className="text-[10px] text-slate-500">Legacy daily ops report — kept identical to the original shared view.</p></>}
    <div className="flex justify-end gap-3 pt-3 border-t border-slate-800"><button type="button" onClick={onClose} className="px-4 py-2 bg-slate-800 rounded-lg text-xs text-slate-300">Cancel</button><button disabled={busy} className="px-5 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-xs font-bold text-white disabled:opacity-50">{busy ? "Saving..." : "Save"}</button></div>
  </form></div></div>;
}
