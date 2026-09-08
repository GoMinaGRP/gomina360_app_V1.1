"use client";

import React, { useState } from "react";
import AiSectionGuide from "./AiSectionGuide";
import {
  ShoppingCart,
  CreditCard,
  UserPlus,
  Package,
  DollarSign,
  ClipboardList,
  CheckCircle,
  WifiOff,
  Receipt,
  ArrowUpRight,
  Search,
  X,
  AlertTriangle,
  Truck,
} from "lucide-react";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import { addToOfflineQueue } from "@/lib/offlineSync";
import CustomerTrackingPanel from "./CustomerTrackingPanel";

interface WorkerDashboardProps {
  currentUser: any;
  businessInfo: any;
  businessMetrics: any;
  specializedLogs: any[];
  inventory: any[];
  customers: any[];
  transactions: any[];
  currentCurrency: CurrencyCode;
  isOnline: boolean;
  onRefreshData: () => void;
}

export default function WorkerDashboard({
  currentUser,
  businessInfo,
  businessMetrics,
  specializedLogs,
  inventory,
  customers,
  transactions,
  currentCurrency,
  isOnline,
  onRefreshData,
}: WorkerDashboardProps) {
  const [activeSubTab, setActiveSubTab] = useState<"SALES" | "CUSTOMERS" | "INVENTORY" | "MY_ACTIVITY" | "TRACKING">("SALES");

  // Inventory-linked sale (cart)
  interface CartItem {
    inventoryId: number;
    sku: string;
    name: string;
    category: string;
    unit: string;
    availableQty: number;
    quantity: number;
    originalPrice: number;
    sellingPrice: number;
    customPriceReason: string;
    isCustomPrice: boolean;
  }
  const [cart, setCart] = useState<CartItem[]>([]);
  const [salePaymentMethod, setSalePaymentMethod] = useState("MTN_MOMO");
  const [saleCustomerName, setSaleCustomerName] = useState("Walk-in Customer");
  const [saleCustomerPhone, setSaleCustomerPhone] = useState("");
  const [saleDiscount, setSaleDiscount] = useState<number>(0);
  const [saleNotes, setSaleNotes] = useState("");
  const [inventorySearch, setInventorySearch] = useState("");
  const [inventoryCatFilter, setInventoryCatFilter] = useState("ALL");
  const [isSubmittingSale, setIsSubmittingSale] = useState(false);
  const [saleSuccess, setSaleSuccess] = useState(false);
  const [saleTrackingCode, setSaleTrackingCode] = useState("");
  const [saleError, setSaleError] = useState("");

  // Customer form
  const [newCustName, setNewCustName] = useState("");
  const [newCustPhone, setNewCustPhone] = useState("+233 24 ");
  const [newCustEmail, setNewCustEmail] = useState("");
  const [newCustType, setNewCustType] = useState("RETAIL");
  const [isCreatingCustomer, setIsCreatingCustomer] = useState(false);

  // Expense form (if permitted)
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseCategory, setExpenseCategory] = useState("Daily Operations");
  const [expenseDescription, setExpenseDescription] = useState("");
  const [isSubmittingExpense, setIsSubmittingExpense] = useState(false);

  // Completion flash for the inline quick forms (customer / expense) — after
  // a completed save the form is cleared AND the worker gets an unmistakable
  // receipt instead of the form sitting there ambiguously.
  const [formFlash, setFormFlash] = useState("");
  const flashSaved = (msg: string) => {
    setFormFlash(msg);
    setTimeout(() => setFormFlash((f) => (f === msg ? "" : f)), 4500);
  };

  const canRecordSales = currentUser?.canRecordSales !== false;
  const canRecordExpenses = currentUser?.canRecordExpenses === true;
  const canManageStock = currentUser?.canManageStock === true;
  const isWorkerEnabled = currentUser?.isWorkerEnabled !== false;

  // Filter to only show this worker's transactions
  const myTransactions = transactions.filter(
    (t) => t.recordedBy === currentUser?.name
  );
  const branchInventory = inventory.filter(
    (inv) => inv.businessId === businessInfo?.id
  );
  const branchCustomers = customers.filter(
    (c) => c.businessId === businessInfo?.id || c.businessId === null
  );

  // ─── Cart helpers ───
  const inStockInventory = branchInventory.filter(
    (inv: any) => inv.status !== "OUT_OF_STOCK" && inv.quantity > 0
  );
  const inventoryCategories = Array.from(
    new Set(branchInventory.map((i: any) => i.category).filter(Boolean))
  ).sort() as string[];
  const filteredProducts = inStockInventory.filter((inv: any) => {
    if (inventoryCatFilter !== "ALL" && inv.category !== inventoryCatFilter) return false;
    if (inventorySearch.trim()) {
      const q = inventorySearch.toLowerCase();
      return [inv.name, inv.sku, inv.category]
        .filter(Boolean)
        .some((f: string) => f.toLowerCase().includes(q));
    }
    return true;
  });

  const addToCart = (inv: any) => {
    const existing = cart.find((c) => c.inventoryId === inv.id);
    if (existing) {
      if (existing.quantity >= inv.quantity) return;
      setCart(cart.map((c) => c.inventoryId === inv.id ? { ...c, quantity: c.quantity + 1 } : c));
    } else {
      setCart([...cart, {
        inventoryId: inv.id, sku: inv.sku, name: inv.name, category: inv.category,
        unit: inv.unit, availableQty: inv.quantity, quantity: 1,
        originalPrice: inv.sellingPriceGhs, sellingPrice: inv.sellingPriceGhs,
        customPriceReason: "", isCustomPrice: false,
      }]);
    }
  };
  const updateCartQty = (id: number, qty: number) => {
    setCart(cart.map((c) => c.inventoryId === id ? { ...c, quantity: Math.max(1, Math.min(qty, c.availableQty)) } : c));
  };
  const updateCartPrice = (id: number, price: number) => {
    setCart(cart.map((c) => c.inventoryId === id ? { ...c, sellingPrice: price, isCustomPrice: price !== c.originalPrice } : c));
  };
  const updateCartPriceReason = (id: number, reason: string) => {
    setCart(cart.map((c) => c.inventoryId === id ? { ...c, customPriceReason: reason } : c));
  };
  const removeFromCart = (id: number) => setCart(cart.filter((c) => c.inventoryId !== id));

  const cartSubtotal = cart.reduce((s, c) => s + c.sellingPrice * c.quantity, 0);
  const cartTotal = cartSubtotal - saleDiscount;
  // Workers can NEVER override prices
  const canOverridePrice = false;

  const handleRecordSale = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cart.length === 0) return;
    setSaleError("");
    setIsSubmittingSale(true);

    try {
      const res = await fetch("/api/sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: businessInfo?.id,
          branchCode: businessInfo?.code,
          customerName: saleCustomerName || "Walk-in Customer",
          customerPhone: saleCustomerPhone,
          paymentMethod: salePaymentMethod,
          cartItems: cart.map((c) => ({
            inventoryId: c.inventoryId, sku: c.sku, name: c.name,
            quantity: c.quantity, originalPrice: c.originalPrice,
            sellingPrice: c.sellingPrice,
            customPriceReason: c.isCustomPrice ? c.customPriceReason : undefined,
          })),
          notes: saleNotes,
          discount: saleDiscount,
          createdByUserId: currentUser?.id,
          createdByName: currentUser?.name,
          createdByRole: currentUser?.role,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSaleSuccess(true);
        setSaleTrackingCode(data.trackingCode || "");
        setCart([]);
        setSaleCustomerName("Walk-in Customer");
        setSaleCustomerPhone("");
        setSaleDiscount(0);
        setSaleNotes("");
        setTimeout(() => { setSaleSuccess(false); setSaleTrackingCode(""); }, 12000);
        onRefreshData();
      } else {
        setSaleError(data.error || "Sale failed.");
      }
    } catch (err: any) {
      setSaleError(err.message || "Network error.");
    } finally {
      setIsSubmittingSale(false);
    }
  };

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCustName.trim()) return;
    setIsCreatingCustomer(true);

    try {
      const res = await fetch("/api/enterprise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "customer",
          data: {
            name: newCustName,
            type: newCustType,
            phone: newCustPhone,
            email: newCustEmail || `${newCustName.toLowerCase().replace(/\s/g, ".")}@client.gh`,
            businessId: businessInfo?.id,
          },
        }),
      });
      if (res.ok) {
        setNewCustName("");
        setNewCustPhone("+233 24 ");
        setNewCustEmail("");
        setNewCustType("RETAIL");
        flashSaved("✓ Customer added — form cleared for the next one.");
        onRefreshData();
      }
    } catch (err) {
      console.error("Error creating customer:", err);
    } finally {
      setIsCreatingCustomer(false);
    }
  };

  const handleRecordExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!expenseAmount || Number(expenseAmount) <= 0) return;
    setIsSubmittingExpense(true);

    const payload = {
      businessId: businessInfo?.id,
      type: "EXPENSE",
      category: expenseCategory,
      amountGhs: Number(expenseAmount),
      paymentMethod: "CASH",
      description: expenseDescription || expenseCategory,
      recordedBy: currentUser?.name || "Sales Person",
    };

    if (!isOnline) {
      addToOfflineQueue("TRANSACTION", payload);
      setIsSubmittingExpense(false);
      setExpenseAmount("");
      setExpenseDescription("");
      flashSaved("✓ Expense queued offline — it posts automatically when you're back online.");
      onRefreshData();
      return;
    }

    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setExpenseAmount("");
        setExpenseDescription("");
        flashSaved("✓ Expense recorded — form cleared for the next one.");
        onRefreshData();
      }
    } catch (err) {
      console.error("Expense recording error:", err);
    } finally {
      setIsSubmittingExpense(false);
    }
  };

  if (!isWorkerEnabled) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] p-8">
        <div className="bg-amber-900/30 border border-amber-500/30 rounded-2xl p-10 max-w-md text-center space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-amber-500/20 flex items-center justify-center mx-auto">
            <ClipboardList className="w-8 h-8 text-amber-400" />
          </div>
          <h2 className="text-xl font-bold text-amber-300">Account Disabled</h2>
          <p className="text-sm text-slate-300">
            Your Sales Person account has been disabled by your Branch Manager.
            Please contact your manager to restore access.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1400px] mx-auto text-slate-100">
      {/* Top bar: worker identity & branch */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-5 rounded-2xl border border-slate-700/80 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-start space-x-3">
          <div className="w-12 h-12 rounded-xl bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center text-emerald-300 font-black text-lg shrink-0">
            {currentUser?.name?.charAt(0) || "S"}
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-xs font-bold border border-emerald-500/30">
                SALES PERSON
              </span>
              <span className="text-xs text-slate-400">
                {businessInfo?.code || "BRANCH"}
              </span>
            </div>
            <h2 className="text-xl font-bold text-white mt-0.5">
              {currentUser?.name || "Worker"}
            </h2>
            <p className="text-xs text-slate-400">
              {businessInfo?.name} • {businessInfo?.branchLocation}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <AiSectionGuide moduleKey="WORKER" section="WORKER" businessInfo={businessInfo} variant="header" />
          {canRecordSales && (
            <span className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-semibold">
              <CheckCircle className="w-3.5 h-3.5" />
              <span>Can Record Sales</span>
            </span>
          )}
          {canRecordExpenses && (
            <span className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-amber-500/15 text-amber-400 border border-amber-500/30 font-semibold">
              <CheckCircle className="w-3.5 h-3.5" />
              <span>Can Record Expenses</span>
            </span>
          )}
          {canManageStock && (
            <span className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 font-semibold">
              <CheckCircle className="w-3.5 h-3.5" />
              <span>Can Manage Stock</span>
            </span>
          )}
        </div>
      </div>

      {/* Sub-navigation tabs */}
      <div className="flex items-center space-x-1 bg-slate-800/90 border border-slate-700/80 p-1 rounded-xl w-fit">
        {[
          { key: "SALES" as const, label: "Record Sale", icon: ShoppingCart },
          { key: "CUSTOMERS" as const, label: "Customers", icon: UserPlus },
          { key: "INVENTORY" as const, label: "Inventory", icon: Package },
          { key: "TRACKING" as const, label: "Order & Tracking", icon: Truck },
          { key: "MY_ACTIVITY" as const, label: "My Activity", icon: ClipboardList },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveSubTab(tab.key)}
            className={`flex items-center space-x-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition ${
              activeSubTab === tab.key
                ? "bg-emerald-600 text-white shadow"
                : "text-slate-300 hover:bg-slate-700/70"
            }`}
          >
            <tab.icon className="w-4 h-4" />
            <span className="text-[10px] leading-none sm:leading-normal sm:text-xs">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Completion flash — above every tab so customer/expense completions
          confirm no matter which workspace the worker is in. */}
      {formFlash && (
        <div
          className="px-4 py-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-sm font-semibold flex items-center space-x-2"
          data-testid="wk-form-flash"
          role="status"
        >
          <CheckCircle className="w-4 h-4 shrink-0" />
          <span>{formFlash}</span>
        </div>
      )}

      {/* Quick stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl">
          <div className="text-xs text-slate-400">My Sales Today</div>
          <div className="text-lg font-black text-emerald-400 mt-1">
            {formatMoney(
              myTransactions
                .filter((t) => t.type === "INCOME" && t.date === new Date().toISOString().split("T")[0])
                .reduce((acc: number, t: any) => acc + (t.amountGhs || 0), 0),
              currentCurrency
            )}
          </div>
        </div>
        <div className="bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl">
          <div className="text-xs text-slate-400">Total Transactions</div>
          <div className="text-lg font-black text-white mt-1">{myTransactions.length}</div>
        </div>
        <div className="bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl">
          <div className="text-xs text-slate-400">Branch Inventory Items</div>
          <div className="text-lg font-black text-cyan-300 mt-1">{branchInventory.length}</div>
        </div>
        <div className="bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl">
          <div className="text-xs text-slate-400">Branch Customers</div>
          <div className="text-lg font-black text-amber-300 mt-1">{branchCustomers.length}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* MAIN: Sales recording form */}
          {activeSubTab === "SALES" && (
          <div className="lg:col-span-2 space-y-4">
            {/* Banners */}
            {saleSuccess && (
              <div className="px-4 py-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-sm font-semibold flex items-center space-x-2" data-testid="sale-success-banner">
                <CheckCircle className="w-4 h-4 shrink-0" />
                <span>
                  Sale completed! Inventory updated automatically.
                  {saleTrackingCode && (
                    <>
                      {" "}Customer tracking code:{" "}
                      <span className="font-mono font-black text-emerald-300" data-testid="sale-tracking-code">{saleTrackingCode}</span>
                      {" "}— follow it at /track or share it with the customer.
                    </>
                  )}
                </span>
              </div>
            )}
            {saleError && (
              <div className="px-4 py-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs flex items-center space-x-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{saleError}</span>
              </div>
            )}

            {/* ── Product Picker ── */}
            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow-xl">
              <div className="flex items-center justify-between pb-3 border-b border-slate-700/70 mb-3">
                <div className="flex items-center gap-2">
                  <Package className="w-5 h-5 text-cyan-400" />
                  <h3 className="text-sm font-bold text-white">Branch Products</h3>
                  <span className="text-[10px] text-slate-400">{inStockInventory.length} in stock</span>
                </div>
                <div className="flex items-center gap-2">
                  <select value={inventoryCatFilter} onChange={(e) => setInventoryCatFilter(e.target.value)} className="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-[10px] text-white">
                    <option value="ALL">All Types</option>
                    {inventoryCategories.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input type="text" value={inventorySearch} onChange={(e) => setInventorySearch(e.target.value)} placeholder="Search…" className="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-[10px] text-white w-28" />
                </div>
              </div>

              {filteredProducts.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                  {filteredProducts.map((inv: any) => {
                    const inCart = cart.find((c) => c.inventoryId === inv.id);
                    return (
                      <button key={inv.id} type="button" onClick={() => addToCart(inv)} disabled={inv.quantity <= 0}
                        className={`flex items-center justify-between p-2 rounded-lg border text-left transition text-xs ${inCart ? "bg-emerald-500/10 border-emerald-500/40" : "bg-slate-900/60 border-slate-700 hover:border-slate-500"} disabled:opacity-40`}>
                        <div className="min-w-0 flex-1 mr-2">
                          <div className="font-bold text-slate-100 truncate">{inv.name}</div>
                          <div className="text-[10px] text-slate-400 flex items-center gap-1 mt-0.5">
                            <span className="font-mono text-cyan-400">{inv.sku}</span>
                            <span>•</span>
                            <span>{inv.category}</span>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-bold text-emerald-400">{formatMoney(inv.sellingPriceGhs, currentCurrency)}</div>
                          <div className="text-[10px] text-slate-400">{inv.quantity} {inv.unit}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-6 text-xs text-slate-400">
                  {branchInventory.length === 0 ? "No inventory for this branch." : "No products match — or all out of stock."}
                </div>
              )}
            </div>

            {/* ── Cart ── */}
            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow-xl">
              <div className="flex items-center gap-2 pb-3 border-b border-slate-700/70 mb-3">
                <ShoppingCart className="w-5 h-5 text-emerald-400" />
                <h3 className="text-sm font-bold text-white">Order Cart</h3>
                <span className="text-[10px] text-slate-400">{cart.length} items</span>
              </div>

              {cart.length > 0 ? (
                <div className="space-y-2">
                  {cart.map((item) => (
                    <div key={item.inventoryId} className="p-2.5 rounded-lg border border-slate-700 bg-slate-900/60 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="min-w-0 flex-1 mr-2">
                          <div className="text-xs font-bold text-slate-100 truncate">{item.name}</div>
                          <div className="text-[10px] text-slate-400">{item.sku} • {item.availableQty} {item.unit} avail</div>
                        </div>
                        <button type="button" onClick={() => removeFromCart(item.inventoryId)} className="p-1 rounded hover:bg-rose-500/20 text-rose-400 shrink-0">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="block text-[10px] text-slate-500 mb-0.5">Qty (max {item.availableQty})</label>
                          <input type="number" min={1} max={item.availableQty} value={item.quantity} onChange={(e) => updateCartQty(item.inventoryId, Number(e.target.value))} className="w-full px-2 py-1 bg-slate-800 border border-slate-700 rounded text-white text-xs text-center" />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-500 mb-0.5">
                            Price {item.isCustomPrice && <span className="text-amber-400">*</span>}
                          </label>
                          <input type="number" min={0} step="0.01" value={item.sellingPrice} disabled
                            className="w-full px-2 py-1 bg-slate-800 border border-slate-700 rounded text-white text-xs text-right opacity-70 cursor-not-allowed"
                            title="Workers cannot modify product prices"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-500 mb-0.5">Total</label>
                          <div className="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-emerald-400 text-xs font-bold text-right">
                            {formatMoney(item.sellingPrice * item.quantity, currentCurrency)}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-4 text-xs text-slate-400">
                  Tap a product above to add it to the cart.
                </div>
              )}
            </div>

            {/* ── Sale Checkout ── */}
            {cart.length > 0 && (
              <form onSubmit={handleRecordSale} className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow-xl space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1">Customer</label>
                    <input type="text" value={saleCustomerName} onChange={(e) => setSaleCustomerName(e.target.value)} className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs" />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1">Payment</label>
                    <select value={salePaymentMethod} onChange={(e) => setSalePaymentMethod(e.target.value)} className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs">
                      <option value="MTN_MOMO">MTN MoMo</option>
                      <option value="TELECEL_CASH">Telecel Cash</option>
                      <option value="CASH">Cash</option>
                      <option value="BANK_TRANSFER">Bank Transfer</option>
                      <option value="POS_CARD">POS Card</option>
                    </select>
                  </div>
                </div>

                {/* Live totals */}
                <div className="bg-slate-900 rounded-xl p-3 space-y-1 text-xs border border-slate-700">
                  <div className="flex justify-between text-slate-400">
                    <span>Subtotal ({cart.length} items):</span>
                    <span>{formatMoney(cartSubtotal, currentCurrency)}</span>
                  </div>
                  <div className="flex justify-between text-lg font-bold text-emerald-400 pt-2 border-t border-slate-700">
                    <span>Total:</span>
                    <span>{formatMoney(cartTotal, currentCurrency)}</span>
                  </div>
                </div>

                <button type="submit" disabled={isSubmittingSale || cart.length === 0}
                  className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-lg transition disabled:opacity-50 flex items-center justify-center gap-2">
                  <CreditCard className="w-4 h-4" />
                  <span>{isSubmittingSale ? "Processing…" : `Complete Sale — ${formatMoney(cartTotal, currentCurrency)}`}</span>
                </button>
              </form>
            )}

            {/* Daily Expense form (if permitted) */}
            {canRecordExpenses && (
              <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl">
                <div className="flex items-center space-x-2 pb-4 border-b border-slate-700/70">
                  <ArrowUpRight className="w-5 h-5 text-amber-400" />
                  <h3 className="text-base font-bold text-white">Record Daily Expense</h3>
                </div>

                <form onSubmit={handleRecordExpense} className="mt-4 space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Amount ({currentCurrency})
                      </label>
                      <input
                        type="number"
                        required
                        step="0.01"
                        min="0.01"
                        placeholder="0.00"
                        value={expenseAmount}
                        onChange={(e) => setExpenseAmount(e.target.value)}
                        className="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm font-bold focus:outline-none focus:border-amber-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Category
                      </label>
                      <input
                        type="text"
                        value={expenseCategory}
                        onChange={(e) => setExpenseCategory(e.target.value)}
                        className="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-amber-500"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Description
                    </label>
                    <textarea
                      rows={2}
                      value={expenseDescription}
                      onChange={(e) => setExpenseDescription(e.target.value)}
                      placeholder="e.g. Bought cleaning supplies for the shop"
                      className="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-amber-500 resize-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isSubmittingExpense}
                    className="w-full py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-white font-bold text-sm shadow transition disabled:opacity-50"
                  >
                    {isSubmittingExpense ? "Recording..." : "Submit Expense"}
                  </button>
                </form>
              </div>
            )}
          </div>
        )}

        {/* Create Customer form */}
        {activeSubTab === "CUSTOMERS" && (
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl">
              <div className="flex items-center space-x-2 pb-4 border-b border-slate-700/70">
                <UserPlus className="w-5 h-5 text-amber-400" />
                <h3 className="text-base font-bold text-white">Add New Customer</h3>
              </div>

              <form onSubmit={handleCreateCustomer} className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    Full Name
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="Customer full name"
                    value={newCustName}
                    onChange={(e) => setNewCustName(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Phone Number
                    </label>
                    <input
                      type="text"
                      value={newCustPhone}
                      onChange={(e) => setNewCustPhone(e.target.value)}
                      className="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Customer Type
                    </label>
                    <select
                      value={newCustType}
                      onChange={(e) => setNewCustType(e.target.value)}
                      className="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm"
                    >
                      <option value="RETAIL">Retail</option>
                      <option value="WHOLESALE">Wholesale</option>
                      <option value="CORPORATE">Corporate</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    Email (optional)
                  </label>
                  <input
                    type="email"
                    placeholder="customer@email.com"
                    value={newCustEmail}
                    onChange={(e) => setNewCustEmail(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isCreatingCustomer}
                  className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-lg transition disabled:opacity-50"
                >
                  {isCreatingCustomer ? "Creating..." : "Create Customer"}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Inventory view */}
        {activeSubTab === "INVENTORY" && (
          <div className="lg:col-span-2">
            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl">
              <div className="px-5 py-4 border-b border-slate-700 flex items-center space-x-2">
                <Package className="w-5 h-5 text-cyan-400" />
                <h3 className="text-base font-bold text-white">Branch Inventory</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm">
                  <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[11px] tracking-wider">
                    <tr>
                      <th className="px-4 py-3">Item / SKU</th>
                      <th className="px-4 py-3">Category</th>
                      <th className="px-4 py-3 text-right">Quantity</th>
                      <th className="px-4 py-3 text-right">Selling Price</th>
                      <th className="px-4 py-3 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/60">
                    {branchInventory.map((item: any) => (
                      <tr key={item.id} className="hover:bg-slate-700/40">
                        <td className="px-4 py-3.5">
                          <div className="font-bold text-slate-100">{item.name}</div>
                          <div className="text-[11px] font-mono text-cyan-400">{item.sku}</div>
                        </td>
                        <td className="px-4 py-3.5 text-slate-300">{item.category}</td>
                        <td className="px-4 py-3.5 text-right font-bold text-white">
                          {item.quantity?.toLocaleString()} {item.unit}
                        </td>
                        <td className="px-4 py-3.5 text-right font-extrabold text-emerald-400">
                          {formatMoney(item.sellingPriceGhs, currentCurrency)}
                        </td>
                        <td className="px-4 py-3.5 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            item.status === "IN_STOCK"
                              ? "bg-emerald-500/20 text-emerald-400"
                              : item.status === "LOW_STOCK"
                              ? "bg-amber-500/20 text-amber-400"
                              : "bg-rose-500/20 text-rose-400"
                          }`}>
                            {item.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* My Activity log */}
        {activeSubTab === "MY_ACTIVITY" && (
          <div className="lg:col-span-2">
            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl">
              <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <ClipboardList className="w-5 h-5 text-emerald-400" />
                  <h3 className="text-base font-bold text-white">My Sales Activity</h3>
                </div>
                <span className="text-xs text-slate-400">
                  {myTransactions.length} records
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm">
                  <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[11px] tracking-wider">
                    <tr>
                      <th className="px-4 py-3">Transaction #</th>
                      <th className="px-4 py-3">Category</th>
                      <th className="px-4 py-3">Description</th>
                      <th className="px-4 py-3">Payment</th>
                      <th className="px-4 py-3 text-right">Amount</th>
                      <th className="px-4 py-3">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/60">
                    {myTransactions.map((t: any) => (
                      <tr key={t.id} className="hover:bg-slate-700/40">
                        <td className="px-4 py-3.5 font-mono text-xs text-emerald-400">
                          {t.transactionNumber}
                        </td>
                        <td className="px-4 py-3.5 text-slate-300">{t.category}</td>
                        <td className="px-4 py-3.5 text-slate-300 max-w-[200px] truncate">
                          {t.description}
                        </td>
                        <td className="px-4 py-3.5">
                          <span className="px-2 py-0.5 rounded bg-slate-700 text-slate-200 text-[10px] font-bold">
                            {t.paymentMethod}
                          </span>
                        </td>
                        <td className={`px-4 py-3.5 text-right font-extrabold ${
                          t.type === "INCOME" ? "text-emerald-400" : "text-rose-400"
                        }`}>
                          {t.type === "INCOME" ? "+" : "-"}{" "}
                          {formatMoney(t.amountGhs, currentCurrency)}
                        </td>
                        <td className="px-4 py-3.5 text-slate-400 text-xs">{t.date}</td>
                      </tr>
                    ))}
                    {myTransactions.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-slate-400 text-sm">
                          No transactions recorded yet. Start by recording a sale!
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Customer order tracking console — scoped to this branch by the server */}
        {activeSubTab === "TRACKING" && (
          <div className="lg:col-span-3" data-testid="worker-tracking-tab">
            <CustomerTrackingPanel
              currentUser={currentUser}
              businesses={businessInfo ? [businessInfo] : []}
              currentCurrency={currentCurrency}
              lockedBusiness={businessInfo || null}
            />
          </div>
        )}

        {/* Side panel: Recent transactions summary */}
        {activeSubTab !== "TRACKING" && (
        <div className="space-y-4">
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl">
            <h4 className="text-xs font-bold uppercase text-slate-400 mb-3">Quick Stats</h4>
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Total Sales Value</span>
                <span className="font-extrabold text-emerald-400">
                  {formatMoney(
                    myTransactions
                      .filter((t: any) => t.type === "INCOME")
                      .reduce((acc: number, t: any) => acc + (t.amountGhs || 0), 0),
                    currentCurrency
                  )}
                </span>
              </div>
              {canRecordExpenses && (
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Total Expenses</span>
                  <span className="font-extrabold text-rose-400">
                    {formatMoney(
                      myTransactions
                        .filter((t: any) => t.type === "EXPENSE")
                        .reduce((acc: number, t: any) => acc + (t.amountGhs || 0), 0),
                      currentCurrency
                    )}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Avg Sale Value</span>
                <span className="font-bold text-white">
                  {formatMoney(
                    myTransactions.filter((t: any) => t.type === "INCOME").length > 0
                      ? myTransactions
                          .filter((t: any) => t.type === "INCOME")
                          .reduce((acc: number, t: any) => acc + (t.amountGhs || 0), 0) /
                          myTransactions.filter((t: any) => t.type === "INCOME").length
                      : 0,
                    currentCurrency
                  )}
                </span>
              </div>
            </div>
          </div>

          {/* Recent transactions mini-list */}
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl">
            <h4 className="text-xs font-bold uppercase text-slate-400 mb-3">
              Recent Sales (Last 5)
            </h4>
            <div className="space-y-2.5">
              {myTransactions.slice(0, 5).map((t: any) => (
                <div key={t.id} className="flex items-center justify-between text-xs border-b border-slate-700/40 pb-2">
                  <div className="truncate flex-1 mr-2">
                    <div className="text-slate-200 font-medium truncate">{t.description}</div>
                    <div className="text-[10px] text-slate-400">{t.date} • {t.paymentMethod}</div>
                  </div>
                  <span className={`font-bold shrink-0 ${t.type === "INCOME" ? "text-emerald-400" : "text-rose-400"}`}>
                    {t.type === "INCOME" ? "+" : "-"}{formatMoney(t.amountGhs, currentCurrency)}
                  </span>
                </div>
              ))}
              {myTransactions.length === 0 && (
                <p className="text-xs text-slate-400 text-center py-4">No activity yet</p>
              )}
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
