"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Boxes,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  LayoutDashboard,
  Package,
  Plus,
  RefreshCw,
  Shirt,
  ShoppingCart,
  TrendingUp,
  Users,
  Wallet,
  X,
  Truck,
} from "lucide-react";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import AiSectionGuide from "./AiSectionGuide";
import DailyChecklistPanel from "./DailyChecklistPanel";
import FinancialReportSection from "./FinancialReportSection";
import ExpenseEntryForm from "./ExpenseEntryForm";
import ProductVariantPicker, { type VariantSelection } from "./ProductVariantPicker";
import { COLOR_PRESETS, SIZE_SYSTEMS, cleanVariantValue, variantLabel } from "@/lib/boutiqueSizes";

/**
 * BoutiqueModule — the dedicated dashboard for Boutique (fashion / clothing /
 * apparel) business units.
 *
 * REUSE, not duplication (owner directive): a Boutique unit runs on the SAME
 * shared backbones as every other unit —
 *   • Inventory  → `inventory_items` (this module adds only the size × colour
 *                  sub-layer through /api/boutique)
 *   • Sales      → /api/sales (stock + receipt + CRM + ledger, variant-aware)
 *   • Expenses   → the shared ExpenseEntryForm / /api/transactions
 *   • Finance    → the shared FinancialReportSection
 *   • Customers / Suppliers → the shared CRM rows passed in as props
 *   • Customer Orders → /api/tracking (the public /order storefront feeds it)
 *   • Reports / Audit → shared report + audit centers (untouched)
 */

type Props = {
  currentUser: any;
  businessInfo: any;
  businessMetrics: any;
  inventory: any[];
  customers: any[];
  suppliers: any[];
  transactions: any[];
  assets?: any[];
  employees: any[];
  currentCurrency: CurrencyCode;
  onRefreshData: () => void;
};

type Tab = "DASHBOARD" | "PRODUCTS" | "SALES" | "ORDERS" | "FINANCE" | "CUSTOMERS" | "CHECKLIST";

const TABS: { key: Tab; label: string; icon: any }[] = [
  { key: "DASHBOARD", label: "Dashboard", icon: LayoutDashboard },
  { key: "PRODUCTS", label: "Sizes & Stock", icon: Shirt },
  { key: "SALES", label: "Sales", icon: ShoppingCart },
  { key: "ORDERS", label: "Customer Orders", icon: ClipboardList },
  { key: "FINANCE", label: "Finance & Reports", icon: Wallet },
  { key: "CUSTOMERS", label: "Customers & Suppliers", icon: Users },
  { key: "CHECKLIST", label: "Daily Checklist", icon: ClipboardCheck },
];

const STATUS_STYLE: Record<string, string> = {
  IN_STOCK: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  LOW_STOCK: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  OUT_OF_STOCK: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  RECEIVED: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  CONFIRMED: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  PREPARING: "bg-indigo-500/15 text-indigo-300 border-indigo-500/40",
  READY: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  DISPATCHED: "bg-violet-500/15 text-violet-300 border-violet-500/40",
  DELIVERED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  COMPLETED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  CANCELLED: "bg-rose-500/15 text-rose-300 border-rose-500/40",
};

const Badge = ({ s }: { s: string }) => (
  <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${STATUS_STYLE[s] || "bg-slate-700/40 text-slate-300 border-slate-600"}`}>
    {s.replace(/_/g, " ")}
  </span>
);

const Card = ({ title, icon: Icon, children, action }: { title: string; icon: any; children: React.ReactNode; action?: React.ReactNode }) => (
  <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow-xl">
    <div className="flex items-center justify-between pb-2.5 border-b border-slate-700/70 mb-3">
      <h3 className="text-sm font-bold text-white flex items-center gap-2">
        <Icon className="w-4 h-4 text-amber-400" /> {title}
      </h3>
      {action}
    </div>
    {children}
  </div>
);

const Stat = ({ label, value, sub, tone = "emerald", icon: Icon }: { label: string; value: string; sub?: string; tone?: string; icon: any }) => (
  <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-3.5 shadow">
    <div className="flex items-center justify-between">
      <span className="text-[10px] uppercase tracking-wide font-bold text-slate-400">{label}</span>
      <Icon className={`w-4 h-4 text-${tone}-400`} />
    </div>
    <div className="mt-1 text-lg font-black text-white">{value}</div>
    {sub && <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>}
  </div>
);

export default function BoutiqueModule({
  currentUser,
  businessInfo,
  businessMetrics,
  inventory,
  customers,
  suppliers,
  transactions,
  employees,
  currentCurrency,
  onRefreshData,
}: Props) {
  const bizId = businessInfo?.id;
  const branchCode = businessInfo?.code;
  const [tab, setTab] = useState<Tab>("DASHBOARD");
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [trackings, setTrackings] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");
  const [expenseOpen, setExpenseOpen] = useState(false);

  // Variant editor (product → size × colour matrix)
  const [editorItem, setEditorItem] = useState<any | null>(null);
  const [editorRows, setEditorRows] = useState<{ size: string; color: string; quantity: number; minStockThreshold?: number }[]>([]);
  const [editorSizeSystem, setEditorSizeSystem] = useState<string>("LETTER");
  const [editorSizes, setEditorSizes] = useState<string[]>([]);
  const [editorColors, setEditorColors] = useState<string[]>([]);

  // Restock (variant)
  const [restockRow, setRestockRow] = useState<any | null>(null);
  const [restockQty, setRestockQty] = useState("");
  const [restockCost, setRestockCost] = useState("");
  const [restockExpense, setRestockExpense] = useState(true);

  // Boutique POS
  const [saleItemId, setSaleItemId] = useState<string>("");
  const [saleSel, setSaleSel] = useState<VariantSelection>(null);
  const [saleQty, setSaleQty] = useState(1);
  const [saleCustomer, setSaleCustomer] = useState("Walk-in Customer");
  const [salePhone, setSalePhone] = useState("");
  const [saleMethod, setSaleMethod] = useState("MTN_MOMO");
  const [saleReceipt, setSaleReceipt] = useState<any>(null);

  const branchInventory = useMemo(() => inventory.filter((i: any) => i.businessId === bizId), [inventory, bizId]);
  const branchCustomers = useMemo(() => customers.filter((c: any) => c.businessId === bizId), [customers, bizId]);
  const branchTx = useMemo(() => transactions.filter((t: any) => t.businessId === bizId), [transactions, bizId]);
  const branchEmployees = useMemo(() => employees.filter((e: any) => e.businessId === bizId), [employees, bizId]);

  const variantsByItem: Record<string, any[]> = data?.variants || {};
  const variantsOf = useCallback(
    (itemId: number): any[] => (variantsByItem[String(itemId)] || []).filter((v: any) => v.isActive !== false),
    [variantsByItem],
  );

  const refresh = useCallback(async () => {
    if (!bizId) return;
    try {
      const [bRes, tRes] = await Promise.all([
        fetch(`/api/boutique?businessId=${bizId}`),
        fetch(`/api/tracking?businessId=${bizId}`),
      ]);
      const bD = await bRes.json().catch(() => null);
      const tD = await tRes.json().catch(() => null);
      if (bD?.success) setData(bD);
      if (tD?.success) setTrackings(tD.trackings || []);
    } finally {
      setLoading(false);
    }
  }, [bizId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const flashSaved = (msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(""), 4000);
  };

  // ── Variant editor helpers ──────────────────────────────────────────
  const openEditor = (item: any) => {
    const existing = variantsOf(item.id).map((v: any) => ({
      size: v.size || "",
      color: v.color || "",
      quantity: Number(v.quantity) || 0,
      minStockThreshold: Number(v.minStockThreshold) || 0,
    }));
    const sizes = [...new Set(existing.map((r) => r.size).filter(Boolean))] as string[];
    const colors = [...new Set(existing.map((r) => r.color).filter(Boolean))] as string[];
    setEditorItem(item);
    setEditorRows(existing.length > 0 ? existing : [{ size: "", color: "", quantity: 0 }]);
    setEditorSizes(sizes);
    setEditorColors(colors);
    setEditorSizeSystem(variantsOf(item.id)[0]?.sizeSystem || "LETTER");
    setError("");
  };

  const rebuildRows = (sizes: string[], colors: string[]) => {
    // Size × colour grid, carrying over any quantities already typed.
    const prev = new Map(editorRows.map((r) => [`${r.size}||${r.color}`, r.quantity]));
    const next: { size: string; color: string; quantity: number }[] = [];
    if (sizes.length > 0 && colors.length > 0) {
      for (const s of sizes) for (const c of colors) next.push({ size: s, color: c, quantity: prev.get(`${s}||${c}`) ?? 0 });
    } else if (sizes.length > 0) {
      for (const s of sizes) next.push({ size: s, color: "", quantity: prev.get(`${s}||`) ?? 0 });
    } else if (colors.length > 0) {
      for (const c of colors) next.push({ size: "", color: c, quantity: prev.get(`||${c}`) ?? 0 });
    }
    setEditorRows(next.length > 0 ? next : [{ size: "", color: "", quantity: 0 }]);
  };

  const toggleSize = (s: string) => {
    const next = editorSizes.includes(s) ? editorSizes.filter((x) => x !== s) : [...editorSizes, s];
    setEditorSizes(next);
    rebuildRows(next, editorColors);
  };
  const toggleColor = (c: string) => {
    const next = editorColors.includes(c) ? editorColors.filter((x) => x !== c) : [...editorColors, c];
    setEditorColors(next);
    rebuildRows(editorSizes, next);
  };

  const saveVariants = async () => {
    if (!editorItem) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/boutique", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "SET_VARIANTS",
          businessId: bizId,
          inventoryId: editorItem.id,
          replace: true,
          variants: editorRows
            .filter((r) => r.size || r.color)
            .map((r) => ({
              size: cleanVariantValue(r.size),
              color: cleanVariantValue(r.color),
              sizeSystem: editorSizeSystem,
              quantity: Number(r.quantity) || 0,
              minStockThreshold: Number(r.minStockThreshold) || 0,
            })),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) throw new Error(body?.error || "Could not save sizes/colours.");
      flashSaved(`✓ Sizes & colours saved for ${editorItem.name}.`);
      setEditorItem(null);
      await refresh();
      onRefreshData();
    } catch (e: any) {
      setError(e.message || "Could not save sizes/colours.");
    } finally {
      setBusy(false);
    }
  };

  const doRestock = async () => {
    if (!restockRow) return;
    const qty = Number(restockQty);
    if (!qty || qty <= 0) return setError("Enter how many units were added.");
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/boutique", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ADJUST_STOCK",
          businessId: bizId,
          variantId: restockRow.id,
          delta: qty,
          unitCostGhs: Number(restockCost) || 0,
          recordExpense: restockExpense && Number(restockCost) > 0,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) throw new Error(body?.error || "Could not restock this variant.");
      flashSaved(
        `✓ Restocked ${variantLabel(restockRow.size, restockRow.color)} by ${qty} ` +
          (body.expensePosted ? "— expense booked to Finance." : "— stock updated."),
      );
      setRestockRow(null);
      setRestockQty("");
      setRestockCost("");
      await refresh();
      onRefreshData();
    } catch (e: any) {
      setError(e.message || "Could not restock this variant.");
    } finally {
      setBusy(false);
    }
  };

  // ── POS: record a variant-aware sale through the shared /api/sales ──
  const recordSale = async () => {
    const item = branchInventory.find((i: any) => String(i.id) === saleItemId);
    if (!item) return setError("Choose a product to sell.");
    const itemVariants = variantsOf(item.id);
    const picked = saleSel
      ? itemVariants.find((v: any) => (v.size || "") === (saleSel.size || "") && (v.color || "") === (saleSel.color || ""))
      : null;
    if (itemVariants.length > 0 && !picked) return setError("Choose an in-stock size/colour.");
    if (itemVariants.length > 0 && picked && !picked.inStock && Number(picked.quantity) <= 0)
      return setError("That size/colour is out of stock.");
    if (Number(saleQty) > Number(picked ? picked.quantity : item.quantity))
      return setError(`Only ${picked ? picked.quantity : item.quantity} ${item.unit} available for that choice.`);
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: bizId,
          branchCode,
          customerName: saleCustomer || "Walk-in Customer",
          customerPhone: salePhone || undefined,
          paymentMethod: saleMethod,
          cartItems: [
            {
              inventoryId: item.id,
              sku: item.sku,
              name: item.name,
              quantity: Number(saleQty),
              originalPrice: item.sellingPriceGhs,
              sellingPrice: item.sellingPriceGhs,
              ...(picked ? { variantId: picked.id } : {}),
            },
          ],
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) throw new Error(body?.error || "Sale failed.");
      setSaleReceipt({
        number: body.receipt?.documentNumber || body.transaction?.transactionNumber,
        total: body.receipt?.totalGhs,
        trackingCode: body.trackingCode,
        variant: picked ? variantLabel(picked.size, picked.color) : null,
      });
      setSaleQty(1);
      flashSaved("✓ Sale recorded — stock deducted, receipt & finance posted.");
      await refresh();
      onRefreshData();
    } catch (e: any) {
      setError(e.message || "Sale failed.");
    } finally {
      setBusy(false);
    }
  };

  const advanceOrder = async (order: any, status: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/tracking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "SET_STATUS", id: order.id, status }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) throw new Error(body?.error || "Could not update the order.");
      flashSaved(`✓ Order ${order.trackingCode} → ${status}.`);
      await refresh();
      onRefreshData();
    } catch (e: any) {
      setError(e.message || "Could not update the order.");
    } finally {
      setBusy(false);
    }
  };

  const dash = data || {};
  const sales = dash.sales || { today: 0, month: 0, total: 0 };
  const expenses = dash.expenses || { month: 0 };
  const profit = dash.profit || { month: 0 };
  const inv = dash.inventory || { itemCount: 0, unitsOnHand: 0, costValue: 0, retailValue: 0, lowStockItems: [], lowStockVariants: [] };
  const orders = dash.orders || { total: 0, open: 0, done: 0, cancelled: 0, pipelineValue: 0, recent: [] };
  const best = dash.bestSellers || { products: [], sizes: [], colors: [] };
  const variantSummary = dash.variantSummary || { total: 0, low: 0, out: 0 };
  const inStockInventory = useMemo(() => branchInventory.filter((i: any) => (Number(i.quantity) || 0) > 0), [branchInventory]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-400 text-sm">
        <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Loading boutique…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4 space-y-4" data-testid="boutique-module">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-amber-400 to-rose-500 flex items-center justify-center shadow-lg">
              <Shirt className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-black text-white" data-testid="boutique-title">{businessInfo?.name}</h1>
              <p className="text-[11px] text-slate-400">
                Boutique · {businessInfo?.branchLocation || businessInfo?.code || ""} · sizes &amp; colours on the shared Inventory, Sales, Finance, Orders &amp; Reports backbone
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setExpenseOpen(true)}
              className="px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold shadow"
              data-testid="boutique-expense"
            >
              + Record Expense
            </button>
            <button
              onClick={() => { setBusy(true); refresh().finally(() => setBusy(false)); }}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[11px] font-bold flex items-center gap-1.5"
              data-testid="boutique-refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} /> Refresh
            </button>
          </div>
        </div>

        {flash && (
          <div className="px-3 py-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-xs font-bold" data-testid="boutique-flash">
            {flash}
          </div>
        )}
        {error && (
          <div className="px-3 py-2.5 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-300 text-xs font-bold flex items-center justify-between" data-testid="boutique-error">
            <span>{error}</span>
            <button onClick={() => setError("")}><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        {/* Tabs */}
        <div className="flex flex-wrap gap-1.5" data-testid="boutique-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              data-testid={`boutique-tab-${t.key}`}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-[11px] font-bold transition ${
                tab === t.key
                  ? "bg-amber-400 border-amber-400 text-slate-900"
                  : "bg-slate-800/80 border-slate-700 text-slate-300 hover:border-slate-500"
              }`}
            >
              <t.icon className="w-3.5 h-3.5" /> {t.label}
            </button>
          ))}
        </div>

        <AiSectionGuide moduleKey="BOUTIQUE" section={tab} businessInfo={businessInfo} />

        {/* ══════════════ DASHBOARD ══════════════ */}
        {tab === "DASHBOARD" && (
          <div className="space-y-4" data-testid="boutique-dashboard">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Sales today" value={formatMoney(sales.today, currentCurrency, true)} sub={`${sales.transactions || 0} transactions this month`} tone="emerald" icon={TrendingUp} />
              <Stat label="Sales this month" value={formatMoney(sales.month, currentCurrency, true)} sub={`All-time ${formatMoney(sales.total, currentCurrency, true)}`} tone="cyan" icon={BarChart3} />
              <Stat label="Profit this month" value={formatMoney(profit.month, currentCurrency, true)} sub={`Expenses ${formatMoney(expenses.month, currentCurrency, true)}`} tone="violet" icon={Wallet} />
              <Stat label="Orders" value={`${orders.open} open`} sub={`${orders.done} done · pipeline ${formatMoney(orders.pipelineValue, currentCurrency, true)}`} tone="amber" icon={ClipboardList} />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Products" value={String(inv.itemCount || branchInventory.length)} sub={`${inv.variantItemCount ?? 0} with sizes/colours`} tone="emerald" icon={Package} />
              <Stat label="Units on hand" value={String(inv.unitsOnHand ?? 0)} sub={`Stock value ${formatMoney(inv.costValue || 0, currentCurrency, true)}`} tone="cyan" icon={Boxes} />
              <Stat label="Variant rows" value={String(variantSummary.total || 0)} sub={`${variantSummary.low || 0} low · ${variantSummary.out || 0} out`} tone="amber" icon={Shirt} />
              <Stat label="Retail value" value={formatMoney(inv.retailValue || 0, currentCurrency, true)} sub="at selling price" tone="violet" icon={TrendingUp} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card
                title="Low stock — sizes & colours to reorder"
                icon={AlertTriangle}
                action={<span className="text-[10px] text-slate-400">{(inv.lowStockVariants || []).length + (inv.lowStockItems || []).length} alerts</span>}
              >
                {(inv.lowStockVariants || []).length === 0 && (inv.lowStockItems || []).length === 0 ? (
                  <p className="text-xs text-slate-400 py-3">Everything is above its reorder point. 🎉</p>
                ) : (
                  <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1" data-testid="boutique-low-stock">
                    {(inv.lowStockVariants || []).slice(0, 12).map((v: any) => (
                      <div key={`v-${v.id}`} className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-slate-900/60 border border-slate-700/70">
                        <div className="min-w-0">
                          <div className="text-[11px] font-bold text-slate-100 leading-snug break-words">
                            {v.itemName || `Item #${v.inventoryId}`}
                            <span className="ml-1.5 text-amber-300">{variantLabel(v.size, v.color)}</span>
                          </div>
                          <div className="text-[10px] text-slate-400">{v.quantity} left · reorder at {v.minStockThreshold}</div>
                        </div>
                        <button
                          onClick={() => { setRestockRow(v); setRestockQty(String(Math.max(1, Number(v.minStockThreshold) - Number(v.quantity) + 5))); }}
                          className="px-2 py-1 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-900 text-[10px] font-black shrink-0"
                          data-testid={`boutique-restock-${v.id}`}
                        >
                          Restock
                        </button>
                      </div>
                    ))}
                    {(inv.lowStockItems || []).slice(0, 8).map((v: any) => (
                      <div key={`i-${v.id}`} className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-slate-900/60 border border-slate-700/70">
                        <div className="min-w-0">
                          <div className="text-[11px] font-bold text-slate-100 truncate">{v.name}</div>
                          <div className="text-[10px] text-slate-400">{v.quantity} {v.unit} left · reorder at {v.minStockThreshold}</div>
                        </div>
                        <span className="text-[10px] text-rose-300 font-bold shrink-0">{v.severity === "OUT" ? "OUT" : "LOW"}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card title="Best-selling products, sizes & colours" icon={TrendingUp}>
                <div className="space-y-3" data-testid="boutique-best-sellers">
                  {[
                    { label: "Products", rows: best.products || [] },
                    { label: "Sizes", rows: best.sizes || [] },
                    { label: "Colours", rows: best.colors || [] },
                  ].map((group) => (
                    <div key={group.label}>
                      <div className="text-[10px] uppercase tracking-wide font-bold text-slate-400 mb-1">{group.label}</div>
                      {group.rows.length === 0 ? (
                        <p className="text-[11px] text-slate-500">No sales yet.</p>
                      ) : (
                        <div className="space-y-1">
                          {group.rows.slice(0, 5).map((r: any) => {
                            const max = group.rows[0]?.revenue || 1;
                            return (
                              <div key={r.key} className="flex items-center gap-2">
                                <span className="w-28 truncate text-[11px] text-slate-200" title={r.label}>{r.label}</span>
                                <span className="flex-1 h-2 rounded-full bg-slate-900 overflow-hidden">
                                  <span className="block h-full rounded-full bg-gradient-to-r from-amber-400 to-rose-400" style={{ width: `${Math.max(6, Math.round((r.revenue / max) * 100))}%` }} />
                                </span>
                                <span className="w-20 text-right text-[10px] text-slate-400">{r.qty} sold · {formatMoney(r.revenue, currentCurrency, true)}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            <Card title="Recent customer orders" icon={ClipboardList}>
              {(orders.recent || []).length === 0 ? (
                <p className="text-xs text-slate-400 py-3">No customer orders yet — share your storefront from the Customers &amp; Orders console.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[11px]">
                    <thead className="text-slate-400">
                      <tr>
                        <th className="py-1.5 pr-3">Code</th>
                        <th className="py-1.5 pr-3">Customer</th>
                        <th className="py-1.5 pr-3">Items (size/colour)</th>
                        <th className="py-1.5 pr-3">Total</th>
                        <th className="py-1.5">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(orders.recent || []).slice(0, 8).map((o: any) => (
                        <tr key={o.id} className="border-t border-slate-700/60">
                          <td className="py-1.5 pr-3 font-mono text-amber-300">{o.trackingCode}</td>
                          <td className="py-1.5 pr-3">{o.customerName}</td>
                          <td className="py-1.5 pr-3 text-slate-400">
                            {(o.items || []).map((li: any, i: number) => (
                              <span key={i} className="block truncate max-w-[280px]">
                                {li.quantity}× {li.description}
                              </span>
                            ))}
                          </td>
                          <td className="py-1.5 pr-3 font-bold text-emerald-300">{formatMoney(o.totalGhs, currentCurrency, true)}</td>
                          <td className="py-1.5"><Badge s={o.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        )}

        {/* ══════════════ PRODUCTS — SIZES & STOCK ══════════════ */}
        {tab === "PRODUCTS" && (
          <div className="space-y-4" data-testid="boutique-products">
            <Card
              title="Products & size/colour stock"
              icon={Shirt}
              action={<span className="text-[10px] text-slate-400">Inventory stays the one stock register — variants are its size × colour layer</span>}
            >
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[11px]">
                  <thead className="text-slate-400">
                    <tr>
                      <th className="py-2 pr-3">Product</th>
                      <th className="py-2 pr-3">SKU</th>
                      <th className="py-2 pr-3">Price</th>
                      <th className="py-2 pr-3">Sizes / colours</th>
                      <th className="py-2 pr-3">Stock</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {branchInventory.map((item: any) => {
                      const rows = variantsOf(item.id);
                      const sizes = [...new Set(rows.map((v: any) => v.size).filter(Boolean))];
                      const colors = [...new Set(rows.map((v: any) => v.color).filter(Boolean))];
                      return (
                        <tr key={item.id} className="border-t border-slate-700/60" data-testid={`boutique-product-${item.id}`}>
                          <td className="py-2 pr-3 font-bold text-slate-100">{item.name}</td>
                          <td className="py-2 pr-3 font-mono text-cyan-300">{item.sku}</td>
                          <td className="py-2 pr-3">{formatMoney(item.sellingPriceGhs, currentCurrency, true)}</td>
                          <td className="py-2 pr-3 text-slate-300">
                            {rows.length === 0 ? (
                              <span className="text-slate-500">— not variant-tracked —</span>
                            ) : (
                              <span>
                                {sizes.length > 0 && <span className="mr-1">Sizes: <b className="text-amber-300">{sizes.join(", ")}</b></span>}
                                {colors.length > 0 && <span>Colours: <b className="text-amber-300">{colors.join(", ")}</b></span>}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3">{item.quantity} {item.unit}</td>
                          <td className="py-2 pr-3"><Badge s={item.status || "IN_STOCK"} /></td>
                          <td className="py-2">
                            <div className="flex flex-wrap gap-1.5">
                              <button
                                onClick={() => openEditor(item)}
                                className="px-2 py-1 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-900 text-[10px] font-black"
                                data-testid={`boutique-manage-${item.id}`}
                              >
                                Sizes &amp; colours
                              </button>
                              {rows.length > 0 && (
                                <button
                                  onClick={() => { setRestockRow(rows[0]); setRestockQty("5"); }}
                                  className="px-2 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 text-[10px] font-bold"
                                >
                                  Restock…
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {branchInventory.length === 0 && (
                      <tr>
                        <td colSpan={7} className="py-6 text-center text-slate-400">
                          No products yet — register stock in the shared Inventory module (the item appears here for sizes &amp; colours).
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Per-variant stock table */}
            {(inv.lowStockVariants || []).length > 0 && (
              <Card title="Variant rows below reorder point" icon={AlertTriangle}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {(inv.lowStockVariants || []).map((v: any) => (
                    <div key={v.id} className="flex items-center justify-between px-2.5 py-2 rounded-lg bg-slate-900/60 border border-slate-700/70">
                      <div className="text-[11px]">
                        <b className="text-slate-100">{v.itemName}</b>
                        <span className="ml-1.5 text-amber-300">{variantLabel(v.size, v.color)}</span>
                        <div className="text-[10px] text-slate-400">{v.quantity} left · reorder at {v.minStockThreshold}</div>
                      </div>
                      <button onClick={() => { setRestockRow(v); setRestockQty("5"); }} className="px-2 py-1 rounded-lg bg-amber-400 text-slate-900 text-[10px] font-black">Restock</button>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}

        {/* ══════════════ SALES ══════════════ */}
        {tab === "SALES" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="boutique-sales">
            <Card title="Record a sale (stock + receipt + finance)" icon={ShoppingCart}>
              <div className="space-y-3">
                <div>
                  <label className="block text-[10px] text-slate-400 font-bold mb-1">Product</label>
                  <select
                    value={saleItemId}
                    onChange={(e) => { setSaleItemId(e.target.value); setSaleSel(null); setSaleQty(1); }}
                    className="w-full px-2.5 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white"
                    data-testid="boutique-sale-product"
                  >
                    <option value="">— choose product —</option>
                    {branchInventory.map((i: any) => (
                      <option key={i.id} value={String(i.id)}>
                        {i.name} ({i.quantity} {i.unit}{variantsOf(i.id).length ? ", sizes/colours" : ""})
                      </option>
                    ))}
                  </select>
                </div>

                {saleItemId && (() => {
                  const item = branchInventory.find((i: any) => String(i.id) === saleItemId);
                  const rows = item ? variantsOf(item.id) : [];
                  if (!item) return null;
                  if (rows.length === 0) {
                    return <p className="text-[10px] text-slate-400">Plain product — {item.quantity} {item.unit} in stock.</p>;
                  }
                  return (
                    <ProductVariantPicker
                      product={{ id: item.id, variantOptions: { sizes: [], colors: [], variants: rows.map((v: any) => ({ id: Number(v.id), size: v.size || null, color: v.color || null, sizeSystem: v.sizeSystem || null, available: Number(v.quantity) || 0, inStock: (Number(v.quantity) || 0) > 0 })) } }}
                      value={saleSel}
                      onChange={setSaleSel}
                      tone="dark"
                      testidPrefix="boutique-sale"
                    />
                  );
                })()}

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-slate-400 font-bold mb-1">Quantity</label>
                    <input
                      type="number"
                      min={1}
                      value={saleQty}
                      onChange={(e) => setSaleQty(Math.max(1, Number(e.target.value) || 1))}
                      className="w-full px-2.5 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white"
                      data-testid="boutique-sale-qty"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 font-bold mb-1">Payment</label>
                    <select value={saleMethod} onChange={(e) => setSaleMethod(e.target.value)} className="w-full px-2.5 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white">
                      {["MTN_MOMO", "CASH", "TELECEL_CASH", "BANK_TRANSFER", "POS_CARD"].map((m) => (
                        <option key={m} value={m}>{m.replace(/_/g, " ")}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-slate-400 font-bold mb-1">Customer</label>
                    <input value={saleCustomer} onChange={(e) => setSaleCustomer(e.target.value)} className="w-full px-2.5 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white" data-testid="boutique-sale-customer" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 font-bold mb-1">Phone (optional)</label>
                    <input value={salePhone} onChange={(e) => setSalePhone(e.target.value)} className="w-full px-2.5 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white" />
                  </div>
                </div>

                <button
                  onClick={recordSale}
                  disabled={busy || !saleItemId}
                  className="w-full py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 text-white text-xs font-black"
                  data-testid="boutique-sale-submit"
                >
                  {busy ? "Recording…" : "Record Sale"}
                </button>

                {saleReceipt && (
                  <div className="px-3 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/40 text-[11px] text-emerald-200" data-testid="boutique-sale-receipt">
                    ✓ Receipt <b>{saleReceipt.number}</b> · {formatMoney(saleReceipt.total, currentCurrency, true)}
                    {saleReceipt.variant ? ` · ${saleReceipt.variant}` : ""}
                    {saleReceipt.trackingCode ? ` · customer code ${saleReceipt.trackingCode}` : ""}
                  </div>
                )}
              </div>
            </Card>

            <Card title="Recent sales (shared ledger)" icon={Wallet}>
              <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
                {branchTx
                  .filter((t: any) => t.type === "INCOME")
                  .slice(0, 25)
                  .map((t: any) => (
                    <div key={t.id} className="flex items-center justify-between px-2.5 py-2 rounded-lg bg-slate-900/60 border border-slate-700/70">
                      <div className="min-w-0">
                        <div className="text-[11px] font-bold text-slate-100 truncate">{t.description}</div>
                        <div className="text-[10px] text-slate-400">{t.date} · {t.paymentMethod}</div>
                      </div>
                      <span className="text-[11px] font-black text-emerald-300 shrink-0">{formatMoney(t.amountGhs, currentCurrency, true)}</span>
                    </div>
                  ))}
                {branchTx.filter((t: any) => t.type === "INCOME").length === 0 && (
                  <p className="text-xs text-slate-400 py-3">No sales yet.</p>
                )}
              </div>
            </Card>
          </div>
        )}

        {/* ══════════════ CUSTOMER ORDERS ══════════════ */}
        {tab === "ORDERS" && (
          <Card
            title="Customer orders (storefront /orders feed)"
            icon={ClipboardList}
            action={<span className="text-[10px] text-slate-400">Confirming an order deducts the exact size/colour from stock</span>}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px]" data-testid="boutique-orders">
                <thead className="text-slate-400">
                  <tr>
                    <th className="py-2 pr-3">Code</th>
                    <th className="py-2 pr-3">Customer</th>
                    <th className="py-2 pr-3">Items (size/colour)</th>
                    <th className="py-2 pr-3">Total</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2">Next step</th>
                  </tr>
                </thead>
                <tbody>
                  {trackings.slice(0, 40).map((o: any) => (
                    <tr key={o.id} className="border-t border-slate-700/60">
                      <td className="py-2 pr-3 font-mono text-amber-300">{o.trackingCode}</td>
                      <td className="py-2 pr-3">
                        {o.customerName}
                        {o.customerPhone && <div className="text-[10px] text-slate-500">{o.customerPhone}</div>}
                      </td>
                      <td className="py-2 pr-3 text-slate-300">
                        {(Array.isArray(o.items) ? o.items : []).map((li: any, i: number) => (
                          <span key={i} className="block truncate max-w-[320px]">
                            {li.quantity}× {li.description}
                            {li.size || li.color ? (
                              <b className="ml-1 text-amber-300">· {[li.size ? `Size ${li.size}` : null, li.color || null].filter(Boolean).join(" · ")}</b>
                            ) : null}
                          </span>
                        ))}
                      </td>
                      <td className="py-2 pr-3 font-bold text-emerald-300">{formatMoney(o.totalGhs, currentCurrency, true)}</td>
                      <td className="py-2 pr-3"><Badge s={o.status} /></td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-1.5">
                          {(o.allowedNext || []).slice(0, 2).map((n: any) => (
                            <button
                              key={n.status}
                              disabled={busy}
                              onClick={() => advanceOrder(o, n.status)}
                              className="px-2 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-[10px] font-bold"
                              data-testid={`boutique-order-${o.id}-${n.status}`}
                            >
                              {n.label || n.status}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {trackings.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-slate-400">
                        No customer orders yet — share the storefront link (/order) with your customers.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* ══════════════ FINANCE & REPORTS ══════════════ */}
        {tab === "FINANCE" && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Revenue (all time)" value={formatMoney(sales.total, currentCurrency, true)} tone="emerald" icon={TrendingUp} />
              <Stat label="Expenses (month)" value={formatMoney(expenses.month, currentCurrency, true)} tone="rose" icon={Wallet} />
              <Stat label="Profit (month)" value={formatMoney(profit.month, currentCurrency, true)} tone="cyan" icon={BarChart3} />
              <Stat label="Stock cost value" value={formatMoney(inv.costValue || 0, currentCurrency, true)} tone="amber" icon={Boxes} />
            </div>
            <div className="flex gap-2">
              <button onClick={() => setExpenseOpen(true)} className="px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold" data-testid="boutique-fin-expense">
                + Record Expense
              </button>
            </div>
            <FinancialReportSection
            currentUser={currentUser}
              mode="business"
              businessInfo={businessInfo}
              businessMetric={businessMetrics}
              transactions={transactions}
              inventory={inventory}
              customers={customers}
              currentCurrency={currentCurrency}
              accent="amber"
              testid="fin-report-boutique"
              aiModuleKey="BOUTIQUE"
              opsLinks={[
                { label: "Variant rows", value: String(variantSummary.total || 0), note: `${variantSummary.low || 0} low · ${variantSummary.out || 0} out of stock`, tone: "amber" },
                { label: "Customer orders", value: `${orders.open} open / ${orders.total}`, note: "Confirmed orders commit stock automatically", tone: "emerald" },
                { label: "Stock value", value: formatMoney(inv.costValue || 0, currentCurrency, true), tone: "violet" },
              ]}
            />
          </div>
        )}

        {/* ══════════════ CUSTOMERS & SUPPLIERS ══════════════ */}
        {tab === "CUSTOMERS" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title={`Customers (${branchCustomers.length})`} icon={Users}>
              <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
                {branchCustomers.map((c: any) => (
                  <div key={c.id} className="flex items-center justify-between px-2.5 py-2 rounded-lg bg-slate-900/60 border border-slate-700/70">
                    <div>
                      <div className="text-[11px] font-bold text-slate-100">{c.name}</div>
                      <div className="text-[10px] text-slate-400">{c.phone || "no phone"} · {c.type || "RETAIL"}</div>
                    </div>
                    <span className="text-[11px] font-black text-emerald-300">{formatMoney(c.totalSpentGhs || 0, currentCurrency, true)}</span>
                  </div>
                ))}
                {branchCustomers.length === 0 && <p className="text-xs text-slate-400 py-3">No customers recorded yet.</p>}
              </div>
            </Card>
            <Card title={`Suppliers (${suppliers.length})`} icon={Truck}>
              <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
                {suppliers.map((s: any) => (
                  <div key={s.id} className="flex items-center justify-between px-2.5 py-2 rounded-lg bg-slate-900/60 border border-slate-700/70">
                    <div>
                      <div className="text-[11px] font-bold text-slate-100">{s.name}</div>
                      <div className="text-[10px] text-slate-400">{s.category || "General"} · {s.phone || "no phone"}</div>
                    </div>
                    <span className="text-[10px] text-slate-400">{s.paymentTerms || "—"}</span>
                  </div>
                ))}
                {suppliers.length === 0 && <p className="text-xs text-slate-400 py-3">No suppliers recorded yet.</p>}
              </div>
            </Card>
          </div>
        )}

        {/* ══════════════ CHECKLIST ══════════════ */}
        {tab === "CHECKLIST" && (
          <DailyChecklistPanel
            businessId={bizId}
            branchCode={branchCode}
            businessName={businessInfo?.name}
            employees={branchEmployees}
            currentUser={currentUser}
            accent="amber"
            onChanged={() => { refresh(); onRefreshData?.(); }}
          />
        )}
      </div>

      {/* ── Variant editor modal ── */}
      {editorItem && (
        <div className="fixed inset-0 z-[90] bg-black/70 flex items-start justify-center p-3 sm:p-6 overflow-y-auto" data-testid="boutique-variant-editor">
          <div className="w-full max-w-2xl rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <div>
                <div className="text-sm font-bold text-white">Sizes &amp; colours — {editorItem.name}</div>
                <div className="text-[10px] text-slate-400">
                  Each row is its own stock line; the product total is their sum. Unavailable combos show as out of stock on the storefront.
                </div>
              </div>
              <button onClick={() => setEditorItem(null)} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"><X className="w-4 h-4" /></button>
            </div>

            <div className="p-4 space-y-4">
              {/* size system */}
              <div>
                <div className="text-[10px] uppercase tracking-wide font-bold text-slate-400 mb-1">Size system</div>
                <select
                  value={editorSizeSystem}
                  onChange={(e) => { setEditorSizeSystem(e.target.value); setEditorSizes([]); rebuildRows([], editorColors); }}
                  className="w-full px-2.5 py-2 bg-slate-950 border border-slate-700 rounded-lg text-xs text-white"
                  data-testid="boutique-size-system"
                >
                  {SIZE_SYSTEMS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>

              {/* sizes */}
              <div>
                <div className="text-[10px] uppercase tracking-wide font-bold text-slate-400 mb-1">Sizes (tap to include)</div>
                <div className="flex flex-wrap gap-1.5">
                  {(SIZE_SYSTEMS.find((s) => s.key === editorSizeSystem)?.sizes || []).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => toggleSize(s)}
                      className={`px-2 py-1 rounded-lg border text-[11px] font-bold ${editorSizes.includes(s) ? "bg-amber-400 border-amber-400 text-slate-900" : "bg-slate-950 border-slate-700 text-slate-300"}`}
                      data-testid={`boutique-size-chip-${s.replace(/\s+/g, "_")}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    placeholder="Custom size (e.g. 42L, 6.5, Made-to-measure) — Enter to add"
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      const v = cleanVariantValue((e.target as HTMLInputElement).value, 24);
                      if (!v) return;
                      (e.target as HTMLInputElement).value = "";
                      const next = editorSizes.includes(v) ? editorSizes : [...editorSizes, v];
                      setEditorSizes(next);
                      rebuildRows(next, editorColors);
                    }}
                    className="flex-1 px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-[11px] text-white"
                    data-testid="boutique-custom-size"
                  />
                </div>
              </div>

              {/* colours */}
              <div>
                <div className="text-[10px] uppercase tracking-wide font-bold text-slate-400 mb-1">Colours (tap to include)</div>
                <div className="flex flex-wrap gap-1.5">
                  {COLOR_PRESETS.map((c) => (
                    <button
                      key={c.name}
                      type="button"
                      onClick={() => toggleColor(c.name)}
                      className={`px-2 py-1 rounded-lg border text-[11px] font-bold flex items-center gap-1.5 ${editorColors.includes(c.name) ? "bg-amber-400 border-amber-400 text-slate-900" : "bg-slate-950 border-slate-700 text-slate-300"}`}
                      data-testid={`boutique-color-chip-${c.name.replace(/\s+/g, "_")}`}
                    >
                      <span className="w-3 h-3 rounded-full border border-slate-500" style={{ background: c.hex }} />
                      {c.name}
                    </button>
                  ))}
                </div>
                <input
                  placeholder="Custom colour — Enter to add"
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    const v = cleanVariantValue((e.target as HTMLInputElement).value, 24);
                    if (!v) return;
                    (e.target as HTMLInputElement).value = "";
                    const next = editorColors.includes(v) ? editorColors : [...editorColors, v];
                    setEditorColors(next);
                    rebuildRows(editorSizes, next);
                  }}
                  className="mt-2 w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-[11px] text-white"
                  data-testid="boutique-custom-color"
                />
              </div>

              {/* matrix */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-wide font-bold text-slate-400">Stock per combination</span>
                  <button
                    type="button"
                    onClick={() => {
                      const v = window.prompt("Set the same quantity for every row:", "5");
                      if (v == null) return;
                      const n = Math.max(0, Number(v) || 0);
                      setEditorRows((rows) => rows.map((r) => ({ ...r, quantity: n })));
                    }}
                    className="text-[10px] font-bold text-amber-300 hover:text-amber-200"
                  >
                    Fill all…
                  </button>
                </div>
                <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1" data-testid="boutique-variant-matrix">
                  {editorRows.map((r, i) => (
                    <div key={`${r.size}||${r.color}||${i}`} className="flex items-center gap-2">
                      <span className="flex-1 text-[11px] text-slate-200 truncate">
                        {variantLabel(r.size, r.color)}
                      </span>
                      <input
                        type="number"
                        min={0}
                        value={r.quantity}
                        onChange={(e) => {
                          const n = Math.max(0, Number(e.target.value) || 0);
                          setEditorRows((rows) => rows.map((x, j) => (j === i ? { ...x, quantity: n } : x)));
                        }}
                        className="w-20 px-2 py-1 bg-slate-950 border border-slate-700 rounded text-[11px] text-white text-right"
                        data-testid={`boutique-variant-qty-${i}`}
                      />
                      <input
                        type="number"
                        min={0}
                        value={r.minStockThreshold ?? 0}
                        onChange={(e) => {
                          const n = Math.max(0, Number(e.target.value) || 0);
                          setEditorRows((rows) => rows.map((x, j) => (j === i ? { ...x, minStockThreshold: n } : x)));
                        }}
                        placeholder="alert"
                        title="Reorder alert level"
                        className="w-16 px-2 py-1 bg-slate-950 border border-slate-700 rounded text-[10px] text-amber-200 text-right"
                      />
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-slate-500 mt-1">
                  Rows deleted here are deactivated (sales history is kept); their remaining stock stays on the product until re-placed.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 px-4 py-3 border-t border-slate-700">
              <button onClick={() => setEditorItem(null)} className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold">Cancel</button>
              <button onClick={saveVariants} disabled={busy} className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-40 text-slate-900 text-xs font-black" data-testid="boutique-save-variants">
                {busy ? "Saving…" : "Save sizes & colours"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Variant restock modal ── */}
      {restockRow && (
        <div className="fixed inset-0 z-[90] bg-black/70 flex items-center justify-center p-4" data-testid="boutique-restock-modal">
          <div className="w-full max-w-sm rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-4 space-y-3">
            <div className="text-sm font-bold text-white">Restock {variantLabel(restockRow.size, restockRow.color)}</div>
            <p className="text-[10px] text-slate-400">
              {restockRow.itemName || restockRow.name} — currently {restockRow.quantity} {(restockRow.unit || "units").toString()}.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-slate-400 font-bold mb-1">Units added</label>
                <input type="number" min={1} value={restockQty} onChange={(e) => setRestockQty(e.target.value)} className="w-full px-2.5 py-2 bg-slate-950 border border-slate-700 rounded-lg text-xs text-white" data-testid="boutique-restock-qty" />
              </div>
              <div>
                <label className="block text-[10px] text-slate-400 font-bold mb-1">Unit cost (GH₵)</label>
                <input type="number" min={0} step="0.01" value={restockCost} onChange={(e) => setRestockCost(e.target.value)} className="w-full px-2.5 py-2 bg-slate-950 border border-slate-700 rounded-lg text-xs text-white" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-[11px] text-slate-300">
              <input type="checkbox" checked={restockExpense} onChange={(e) => setRestockExpense(e.target.checked)} className="accent-amber-500" />
              Book the landed cost as an expense (recommended when a unit cost is given)
            </label>
            <div className="flex gap-2">
              <button onClick={() => setRestockRow(null)} className="flex-1 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold">Cancel</button>
              <button onClick={doRestock} disabled={busy} className="flex-1 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-40 text-slate-900 text-xs font-black" data-testid="boutique-restock-save">
                {busy ? "Saving…" : "Restock"}
              </button>
            </div>
          </div>
        </div>
      )}

      <ExpenseEntryForm
        isOpen={expenseOpen}
        onClose={() => setExpenseOpen(false)}
        onSaved={() => { flashSaved("✓ Expense recorded."); refresh(); onRefreshData(); }}
        businessId={bizId}
        branchCode={branchCode}
        branchName={businessInfo?.name}
        businessName={businessInfo?.name}
        currentUser={currentUser}
        testid="boutique-expense-form"
      />
    </div>
  );
}
