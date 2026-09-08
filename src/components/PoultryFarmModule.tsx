"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import AiSectionGuide from "./AiSectionGuide";
import {
  LayoutDashboard, Egg, Wheat, Droplets, HeartPulse, Boxes,
  Wallet, ClipboardCheck, BookOpen, Plus, X, CheckCircle, Circle,
  Search, TrendingUp, TrendingDown, AlertTriangle, Bird, Activity,
  Building2, Loader2, Filter, Package,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  LineChart, Line, PieChart, Pie, Cell,
} from "recharts";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import { addToOfflineQueue } from "@/lib/offlineSync";
import { analyzePoultry } from "@/lib/poultryAnalytics";
import PoultryAnalyticsAlerts from "./PoultryAnalyticsAlerts";
import PoultryGrowthAnalytics from "./PoultryGrowthAnalytics";
import DailyChecklistPanel from "./DailyChecklistPanel";
import FinancialReportSection from "./FinancialReportSection";

interface Props {
  currentUser: any;
  businessInfo: any;
  businessMetrics: any;
  inventory: any[];
  customers: any[];
  transactions: any[];
  assets: any[];
  employees: any[];
  businesses: any[];
  currentCurrency: CurrencyCode;
  onRefreshData: () => void;
}

type Tab =
  | "DASHBOARD" | "FLOCKS" | "FEED" | "WATER" | "HEALTH"
  | "PRODUCTION" | "INVENTORY" | "FINANCE" | "CHECKLIST" | "AI_KNOWLEDGE";

const TABS: { key: Tab; label: string; icon: any }[] = [
  { key: "DASHBOARD", label: "Dashboard", icon: LayoutDashboard },
  { key: "FLOCKS", label: "Flock & Batch", icon: Bird },
  { key: "FEED", label: "Feed", icon: Wheat },
  { key: "WATER", label: "Water", icon: Droplets },
  { key: "HEALTH", label: "Health & Vaccination", icon: HeartPulse },
  { key: "PRODUCTION", label: "Production", icon: Egg },
  { key: "INVENTORY", label: "Inventory", icon: Boxes },
  { key: "FINANCE", label: "Finance", icon: Wallet },
  { key: "CHECKLIST", label: "Daily Checklist", icon: ClipboardCheck },
  { key: "AI_KNOWLEDGE", label: "AI Knowledge", icon: BookOpen },
];

const DEFAULT_TASKS = [
  { taskKey: "FEED_MORNING", taskLabel: "Morning feeding (all houses)", category: "FEEDING" },
  { taskKey: "WATER_CHECK", taskLabel: "Check & refill drinkers", category: "WATER" },
  { taskKey: "EGG_COLLECT_AM", taskLabel: "Morning egg collection", category: "PRODUCTION" },
  { taskKey: "MORTALITY_CHECK", taskLabel: "Remove & record mortalities", category: "HEALTH" },
  { taskKey: "FEED_EVENING", taskLabel: "Evening feeding (all houses)", category: "FEEDING" },
  { taskKey: "EGG_COLLECT_PM", taskLabel: "Afternoon egg collection", category: "PRODUCTION" },
  { taskKey: "HOUSE_CLEAN", taskLabel: "Clean houses & remove litter", category: "CLEANING" },
  { taskKey: "BIOSECURITY", taskLabel: "Footbath refresh & gate check", category: "SECURITY" },
];

export default function PoultryFarmModule({
  currentUser, businessInfo, businessMetrics, inventory, customers,
  transactions, assets, employees, businesses, currentCurrency, onRefreshData,
}: Props) {
  const [tab, setTab] = useState<Tab>("DASHBOARD");
  const [dashDateFilter, setDashDateFilter] = useState<string>("ALL"); // "ALL", "TODAY", "LAST_7", "LAST_30"
  const [dashProductFilter, setDashProductFilter] = useState<string>("ALL"); // "ALL", "EGGS", "BROILERS"
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState<null | Tab | "SALE">(null);
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [expenseBusy, setExpenseBusy] = useState(false);
  const [expenseError, setExpenseError] = useState("");
  const [expenseForm, setExpenseForm] = useState({
    category: "FEED_PURCHASE",
    customCategory: "",
    amountGhs: "",
    paymentMethod: "CASH",
    vendor: "",
    description: "",
    date: new Date().toISOString().split("T")[0],
  });
  const [receiptImages, setReceiptImages] = useState<string[]>([]);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryIcon, setNewCategoryIcon] = useState("📋");
  const [expCategories, setExpCategories] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  const loadExpenseCategories = async () => {
    try {
      const res = await fetch(`/api/expense-categories?businessId=${bizId}&branchCode=${businessInfo?.code}`);
      const data = await res.json();
      if (data.success) setExpCategories(data.categories || []);
    } catch (e) {
      console.error("Failed to load expense categories", e);
    }
  };

  const handleReceiptUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    Array.from(files).forEach((file) => {
      if (file.size > 5 * 1024 * 1024) {
        setExpenseError("Image must be under 5MB.");
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (ev.target?.result) {
          setReceiptImages((prev) => [...prev, ev.target!.result as string]);
        }
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  };

  const removeReceiptImage = (index: number) => {
    setReceiptImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleAddCategory = async () => {
    if (!newCategoryName.trim()) return;
    try {
      const res = await fetch("/api/expense-categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: bizId,
          branchCode: businessInfo?.code,
          name: newCategoryName.trim(),
          icon: newCategoryIcon,
          createdBy: currentUser?.name,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setExpCategories((prev) => [...prev, data.category]);
        setExpenseForm({ ...expenseForm, category: data.category.name });
        setNewCategoryName("");
        setShowAddCategory(false);
      } else {
        setExpenseError(data.error || "Failed to create category.");
      }
    } catch (e: any) {
      setExpenseError(e.message || "Failed to create category.");
    }
  };
  const [err, setErr] = useState("");

  // Poultry datasets
  const [flocks, setFlocks] = useState<any[]>([]);
  const [feedLogs, setFeedLogs] = useState<any[]>([]);
  const [waterLogs, setWaterLogs] = useState<any[]>([]);
  const [healthRecords, setHealthRecords] = useState<any[]>([]);
  const [production, setProduction] = useState<any[]>([]);
  // Daily bird/egg weighing logs (growth analysis)
  const [weightLogs, setWeightLogs] = useState<any[]>([]);
  const [checklists, setChecklists] = useState<any[]>([]);
  // Master Product List (poultry_products) — production types incl. user-added
  const [products, setProducts] = useState<any[]>([]);

  // AI Knowledge
  const [kbQuery, setKbQuery] = useState("");
  const [kbCategory, setKbCategory] = useState("ALL");
  const [kbArticles, setKbArticles] = useState<any[]>([]);
  const [kbCategories, setKbCategories] = useState<string[]>([]);
  const [kbOpen, setKbOpen] = useState<string | null>(null);
  const [kbLoading, setKbLoading] = useState(false);

  const bizId = businessInfo?.id;
  const today = new Date().toISOString().split("T")[0];

  const refresh = useCallback(async () => {
    if (!bizId) return;
    try {
      const res = await fetch(`/api/poultry?businessId=${bizId}`);
      const d = await res.json();
      if (d.success) {
        setFlocks(d.flocks || []);
        setFeedLogs(d.feedLogs || []);
        setWaterLogs(d.waterLogs || []);
        setHealthRecords(d.healthRecords || []);
        setProduction(d.production || []);
        setProducts(d.products || []);
        setWeightLogs(d.weightLogs || []);
      }
      // Daily checklists come from the unified enterprise checklist engine
      // (same row shape: checklistDate, isCompleted, completedByName/Role/At).
      const cRes = await fetch(`/api/checklists?businessId=${bizId}`);
      const cD = await cRes.json();
      if (cD.success) setChecklists(cD.entries || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [bizId]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    loadExpenseCategories();
  }, [bizId]);
  useEffect(() => {
    if (showExpenseForm) {
      loadExpenseCategories();
      setReceiptImages([]);
      setExpenseError("");
    }
  }, [showExpenseForm]);

  const searchKB = useCallback(async () => {
    setKbLoading(true);
    try {
      const res = await fetch(`/api/poultry/knowledge?q=${encodeURIComponent(kbQuery)}&category=${kbCategory}`);
      const d = await res.json();
      if (d.success) { setKbArticles(d.articles || []); setKbCategories(d.categories || []); }
    } catch (e) { console.error(e); }
    finally { setKbLoading(false); }
  }, [kbQuery, kbCategory]);

  useEffect(() => { if (tab === "AI_KNOWLEDGE") searchKB(); }, [tab, searchKB]);

  // ─── Filter functions ───
  const matchesDashDate = (dateStr?: string) => {
    if (!dateStr) return true;
    if (dashDateFilter === "ALL") return true;
    if (dashDateFilter === "TODAY") return dateStr === today;
    const dateVal = new Date(dateStr);
    const limit = new Date();
    if (dashDateFilter === "LAST_7") {
      limit.setDate(limit.getDate() - 7);
      return dateVal >= limit;
    }
    if (dashDateFilter === "LAST_30") {
      limit.setDate(limit.getDate() - 30);
      return dateVal >= limit;
    }
    return true;
  };

  const matchesDashProductFlock = (flockItem?: any) => {
    if (!flockItem) return true;
    if (dashProductFilter === "ALL") return true;
    if (dashProductFilter === "EGGS" && flockItem.birdType === "LAYERS") return true;
    if (dashProductFilter === "BROILERS" && flockItem.birdType === "BROILERS") return true;
    return false;
  };

  const matchesDashProductBatch = (batchNum?: string) => {
    if (!batchNum) return true;
    if (dashProductFilter === "ALL") return true;
    const flock = flocks.find((f) => f.batchNumber === batchNum);
    return matchesDashProductFlock(flock);
  };

  const matchesDashProductType = (prodType?: string) => {
    if (!prodType) return true;
    if (dashProductFilter === "ALL") return true;
    if (dashProductFilter === "EGGS" && prodType === "EGGS") return true;
    if (dashProductFilter === "BROILERS" && prodType === "BROILER_WEIGHT") return true;
    return false;
  };

  // ─── Filtered Lists for Dashboard calculation ───
  const filteredFlocks = useMemo(() => {
    return flocks.filter(f => matchesDashProductFlock(f));
  }, [flocks, dashProductFilter]);

  const filteredProduction = useMemo(() => {
    return production.filter(p => matchesDashDate(p.recordedDate) && matchesDashProductBatch(p.batchNumber) && matchesDashProductType(p.productionType));
  }, [production, dashDateFilter, dashProductFilter, flocks]);

  const filteredFeedLogs = useMemo(() => {
    return feedLogs.filter(f => matchesDashDate(f.recordedDate) && matchesDashProductBatch(f.batchNumber));
  }, [feedLogs, dashDateFilter, dashProductFilter, flocks]);

  const filteredWaterLogs = useMemo(() => {
    return waterLogs.filter(w => matchesDashDate(w.recordedDate) && matchesDashProductBatch(w.batchNumber));
  }, [waterLogs, dashDateFilter, dashProductFilter, flocks]);

  const filteredHealthRecords = useMemo(() => {
    return healthRecords.filter(h => matchesDashDate(h.recordedDate) && matchesDashProductBatch(h.batchNumber));
  }, [healthRecords, dashDateFilter, dashProductFilter, flocks]);

  const filteredTransactions = useMemo(() => {
    return transactions.filter(t => t.businessId === bizId && matchesDashDate(t.date));
  }, [transactions, bizId, dashDateFilter]);

  // ─── Derived analytics using filtered lists ───
  const activeFlocks = filteredFlocks.filter((f) => f.status === "ACTIVE");
  const totalBirds = activeFlocks.reduce((s, f) => s + (f.currentCount || 0), 0);
  const totalMortality = filteredFlocks.reduce((s, f) => s + (f.mortalityTotal || 0), 0);
  const totalPlaced = filteredFlocks.reduce((s, f) => s + (f.initialCount || 0), 0);
  const mortalityRate = totalPlaced > 0 ? ((totalMortality / totalPlaced) * 100) : 0;

  const eggProd = filteredProduction.filter((p) => p.productionType === "EGGS");
  const todayEggs = eggProd.filter((p) => p.recordedDate === today);
  const latestEggDate = eggProd.length > 0 ? eggProd[0].recordedDate : null;
  const latestEggs = eggProd.filter((p) => p.recordedDate === latestEggDate);
  const eggsToday = (todayEggs.length ? todayEggs : latestEggs)
    .reduce((s, p) => s + (p.eggsCollected || 0), 0);
  const traysToday = (todayEggs.length ? todayEggs : latestEggs)
    .reduce((s, p) => s + (p.traysProduced || 0), 0);
  const avgLayPct = latestEggs.length > 0
    ? latestEggs.reduce((s, p) => s + (p.layPercentage || 0), 0) / latestEggs.length : 0;

  const feedConsumed = filteredFeedLogs.filter((f) => f.entryType === "CONSUMPTION");
  const feedPurchases = filteredFeedLogs.filter((f) => f.entryType === "PURCHASE");
  const feedCostTotal = filteredFeedLogs.reduce((s, f) => s + (f.totalCostGhs || 0), 0);
  const feedPurchaseCost = feedPurchases.reduce((s, f) => s + (f.totalCostGhs || 0), 0);
  const feedStockKg = feedPurchases.reduce((s, f) => s + (f.quantityKg || 0), 0)
    - feedConsumed.reduce((s, f) => s + (f.quantityKg || 0), 0);

  const waterToday = filteredWaterLogs.filter((w) => w.recordedDate === today);
  const latestWaterDate = filteredWaterLogs.length > 0 ? filteredWaterLogs[0].recordedDate : null;
  const waterVolume = (waterToday.length ? waterToday : filteredWaterLogs.filter((w) => w.recordedDate === latestWaterDate))
    .reduce((s, w) => s + (w.volumeLiters || 0), 0);

  const healthCost = filteredHealthRecords.reduce((s, h) => s + (h.costGhs || 0), 0);
  const upcomingVax = filteredHealthRecords
    .filter((h) => h.nextDueDate && h.nextDueDate >= today)
    .sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));

  const todayChecklist = checklists.filter((c) => c.checklistDate === today);
  const checklistDone = todayChecklist.filter((c) => c.isCompleted).length;
  const checklistPct = todayChecklist.length > 0
    ? Math.round((checklistDone / todayChecklist.length) * 100) : 0;

  // Shared-module integration (scoped to this branch)
  const branchInventory = inventory.filter((i) => i.businessId === bizId);
  const branchAssets = assets.filter((a) => a.businessId === bizId);
  const branchEmployees = employees.filter((e) => e.businessId === bizId);
  const branchCustomers = customers.filter((c) => c.businessId === bizId || c.businessId === null);
  const branchTrx = filteredTransactions;
  const revenue = branchTrx.filter((t) => t.type === "INCOME").reduce((s, t) => s + (t.amountGhs || 0), 0);
  const expenses = branchTrx.filter((t) => t.type === "EXPENSE").reduce((s, t) => s + (t.amountGhs || 0), 0);
  const netProfit = revenue - expenses;
  const inventoryValue = branchInventory.reduce((s, i) => s + (i.quantity || 0) * (i.costPriceGhs || 0), 0);
  const assetValue = branchAssets.reduce((s, a) => s + (a.currentValueGhs || 0), 0);

  // Chart data
  const eggTrend = useMemo(() => {
    const map: Record<string, number> = {};
    eggProd.forEach((p) => { map[p.recordedDate] = (map[p.recordedDate] || 0) + (p.eggsCollected || 0); });
    return Object.entries(map).map(([date, eggs]) => ({ date, eggs })).sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  }, [eggProd]);

  const feedByType = useMemo(() => {
    const map: Record<string, number> = {};
    feedConsumed.forEach((f) => { map[f.feedType] = (map[f.feedType] || 0) + (f.quantityKg || 0); });
    return Object.entries(map).map(([type, kg]) => ({ type: type.replace(/_/g, " "), kg }));
  }, [feedConsumed]);

  const flockComposition = useMemo(
    () => activeFlocks.map((f) => ({ name: f.batchNumber, value: f.currentCount })),
    [activeFlocks]
  );

  // ─── Submit handler ───
  const submit = async (entity: string, data: any) => {
    setBusy(true); setErr("");
    try {
      // Stock-linked sale: shared pipeline validates available stock, deducts
      // quantities, records revenue + receipt and updates every dashboard.
      if (entity === "SALE") {
        const res = await fetch("/api/sales", {
          method: "POST", headers: { "Content-Type": "application/json" },
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
      // New product type chosen inside Log Production → save it to the Master
      // Product List FIRST, then record production under its key so the new
      // product is instantly linked across Production → Stock → Sales →
      // Inventory → Reports.
      if (entity === "PRODUCTION" && data.productionType === "__NEW__") {
        if (!data.npName || !String(data.npName).trim()) {
          setErr("Enter the new product name to add it to the Master Product List.");
          return;
        }
        const pRes = await fetch("/api/poultry", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entity: "PRODUCT",
            data: {
              name: String(data.npName).trim(),
              unit: data.npUnit || "Units",
              category: data.npCategory || "Poultry Products",
              costPriceGhs: data.npCost,
              sellingPriceGhs: data.npSelling,
              minStockThreshold: data.npThreshold,
              businessId: bizId,
              branchCode: businessInfo?.code,
            },
          }),
        });
        const pD = await pRes.json();
        if (!pD.success) {
          setErr(pD.error || "Failed to add the new product type.");
          return;
        }
        data = { ...data, productionType: pD.item.productKey };
      }
      const res = await fetch("/api/poultry", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity,
          data: {
            ...data, businessId: bizId,
            branchCode: businessInfo?.code, branchName: businessInfo?.name,
            createdByName: currentUser?.name, createdByRole: currentUser?.role,
            recordedByName: currentUser?.name, recordedByRole: currentUser?.role,
          },
        }),
      });
      const d = await res.json();
      if (d.success) { setShowForm(null); await refresh(); onRefreshData(); }
      else setErr(d.error || "Failed to save.");
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const recordDailyExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    setExpenseError("");
    const amount = Number(expenseForm.amountGhs);
    let category = expenseForm.category;

    // Handle "---NEW---" inline category creation
    if (category === "---NEW---") {
      const customName = expenseForm.customCategory.trim();
      if (!customName) {
        setExpenseError("Enter a category name or select an existing category.");
        return;
      }
      // Try to create the category
      try {
        const catRes = await fetch("/api/expense-categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessId: bizId, branchCode: businessInfo?.code,
            name: customName, icon: "📋", createdBy: currentUser?.name,
          }),
        });
        const catData = await catRes.json();
        if (catData.success) {
          category = catData.category.name;
          setExpCategories((prev) => [...prev, catData.category]);
        } else if (catData.error && catData.error.includes("already exists")) {
          category = customName;
        } else {
          setExpenseError(catData.error || "Failed to create category.");
          return;
        }
      } catch (err: any) {
        setExpenseError(err.message || "Failed to create category.");
        return;
      }
    } else if (category === "OTHER") {
      const customName = expenseForm.customCategory.trim();
      if (!customName) {
        setExpenseError("Enter a custom category name.");
        return;
      }
      category = customName;
    }

    if (!amount || amount <= 0) {
      setExpenseError("Enter a valid expense amount.");
      return;
    }
    if (currentUser?.role === "WORKER" && currentUser?.canRecordExpenses !== true) {
      setExpenseError("Your Worker account is not permitted to record expenses. Ask your Branch Manager.");
      return;
    }

    setExpenseBusy(true);
    const vendorText = expenseForm.vendor.trim() ? ` | Vendor: ${expenseForm.vendor.trim()}` : "";
    const description = `${expenseForm.description.trim() || category.replace(/_/g, " ")}${vendorText} | Poultry branch: ${businessInfo?.code || "POULTRY-01"}`;
    const payload = {
      businessId: bizId,
      branchCode: businessInfo?.code,
      branchName: businessInfo?.name,
      type: "EXPENSE",
      category,
      amountGhs: amount,
      paymentMethod: expenseForm.paymentMethod,
      description,
      date: expenseForm.date,
      recordedBy: currentUser?.name || "Poultry Farm User",
      recordedByRole: currentUser?.role || "STAFF",
      recordedByUserId: currentUser?.id || null,
      status: "COMPLETED",
      receiptImages: receiptImages.length > 0 ? receiptImages : null,
    };

    try {
      if (!navigator.onLine) {
        addToOfflineQueue("TRANSACTION", payload);
      } else {
        const res = await fetch("/api/transactions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Failed to record expense.");
      }
      setExpenseForm({
        category: "FEED_PURCHASE", customCategory: "", amountGhs: "",
        paymentMethod: "CASH", vendor: "", description: "",
        date: new Date().toISOString().split("T")[0],
      });
      setReceiptImages([]);
      setShowExpenseForm(false);
      await refresh();
      onRefreshData();
    } catch (error: any) {
      setExpenseError(error.message || "Failed to record expense.");
    } finally {
      setExpenseBusy(false);
    }
  };

  const toggleTask = async (id: number) => {
    await fetch("/api/poultry", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entity: "CHECKLIST", id,
        data: { completedByName: currentUser?.name, completedByRole: currentUser?.role },
      }),
    });
    refresh();
  };

  const generateChecklist = async () => {
    setBusy(true);
    await submit("CHECKLIST", { checklistDate: today, tasks: DEFAULT_TASKS });
    setBusy(false);
  };

  const COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#a855f7", "#ec4899", "#06b6d4"];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-400" />
      </div>
    );
  }

  const Stat = ({ label, value, sub, color = "emerald", icon: Icon }: any) => (
    <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase font-bold text-slate-400">{label}</span>
        {Icon && <Icon className={`w-4 h-4 text-${color}-400`} />}
      </div>
      <div className={`text-lg font-black text-${color}-400 mt-1`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );

  const Card = ({ title, icon: Icon, children, action }: any) => (
    <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl">
      <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-5 h-5 text-emerald-400" />}
          <h3 className="text-base font-bold text-white">{title}</h3>
        </div>
        {action}
      </div>
      {children}
    </div>
  );

  const AddBtn = ({ onClick, label }: any) => (
    <button onClick={onClick} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow">
      <Plus className="w-3.5 h-3.5" /> {label}
    </button>
  );

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-[1600px] mx-auto text-slate-100">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-5 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 rounded-xl bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center shrink-0">
            <Egg className="w-6 h-6 text-emerald-400" />
          </div>
          <div>
            <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-xs font-bold border border-emerald-500/30">
              POULTRY FARM MANAGEMENT
            </span>
            <h2 className="text-xl sm:text-2xl font-extrabold text-white mt-1">{businessInfo?.name}</h2>
            <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5">
              <Building2 className="w-3 h-3" />
              {businessInfo?.code} • {[businessInfo?.town, businessInfo?.district, businessInfo?.region].filter(Boolean).join(", ")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-center">
              <div className="text-slate-400 text-[10px]">Live Birds</div>
              <div className="text-sm font-extrabold text-emerald-400">{totalBirds.toLocaleString()}</div>
            </div>
            <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-center">
              <div className="text-slate-400 text-[10px]">Eggs (latest)</div>
              <div className="text-sm font-extrabold text-cyan-400">{eggsToday.toLocaleString()}</div>
            </div>
            <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-center">
              <div className="text-slate-400 text-[10px]">Lay %</div>
              <div className="text-sm font-extrabold text-amber-400">{avgLayPct.toFixed(1)}%</div>
            </div>
            <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-center">
              <div className="text-slate-400 text-[10px]">Checklist</div>
              <div className="text-sm font-extrabold text-purple-400">{checklistPct}%</div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-1 bg-slate-800/90 border border-slate-700/80 p-1.5 rounded-xl">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition ${
              tab === t.key ? "bg-emerald-600 text-white shadow" : "text-slate-300 hover:bg-slate-700/70"}`}>
            <t.icon className="w-4 h-4" />
            <span className="text-[10px] leading-none lg:leading-normal lg:text-xs">{t.label}</span>
          </button>
        ))}
        <AiSectionGuide moduleKey="POULTRY" section={tab} businessInfo={businessInfo} />
      </div>

      {err && (
        <div className="px-4 py-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {err}
        </div>
      )}

      {/* ══════════ DASHBOARD ══════════ */}
      {tab === "DASHBOARD" && (
        <div className="space-y-5">
          {/* Dashboard Quick Filters */}
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <Filter className="w-4 h-4 text-emerald-400" />
              <span className="font-bold">Dashboard Filters</span>
            </div>
            <div>
              <label className="block text-[10px] text-slate-500 mb-1">Date Range</label>
              <select
                value={dashDateFilter}
                onChange={(e) => setDashDateFilter(e.target.value)}
                data-testid="dash-date-filter"
                className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500"
              >
                <option value="ALL">All Time</option>
                <option value="TODAY">Today</option>
                <option value="LAST_7">Last 7 Days</option>
                <option value="LAST_30">Last 30 Days</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] text-slate-500 mb-1">Product Type</label>
              <select
                value={dashProductFilter}
                onChange={(e) => setDashProductFilter(e.target.value)}
                data-testid="dash-product-filter"
                className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500"
              >
                <option value="ALL">All Products (Layers & Broilers)</option>
                <option value="EGGS">Eggs / Layers</option>
                <option value="BROILERS">Broilers / Meat</option>
              </select>
            </div>
            {(dashDateFilter !== "ALL" || dashProductFilter !== "ALL") && (
              <button
                onClick={() => {
                  setDashDateFilter("ALL");
                  setDashProductFilter("ALL");
                }}
                className="self-end px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-semibold"
              >
                Reset Filters
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat label="Active Flocks" value={activeFlocks.length} sub={`${totalBirds.toLocaleString()} birds`} icon={Bird} />
            <Stat label="Mortality Rate" value={`${mortalityRate.toFixed(2)}%`} sub={`${totalMortality} total`} color="rose" icon={TrendingDown} />
            <Stat label="Feed Stock" value={`${feedStockKg.toFixed(0)} kg`} sub={`${formatMoney(feedPurchaseCost, currentCurrency, true)} purchased`} color="amber" icon={Wheat} />
            <Stat label="Water (latest)" value={`${waterVolume.toFixed(0)} L`} sub={`${waterLogs.length} logs`} color="cyan" icon={Droplets} />
            <Stat label="Health Cost" value={formatMoney(healthCost, currentCurrency, true)} sub={`${healthRecords.length} records`} color="purple" icon={HeartPulse} />
            <Stat label="Net Profit" value={formatMoney(netProfit, currentCurrency, true)} sub={`Rev ${formatMoney(revenue, currentCurrency, true)}`} color={netProfit >= 0 ? "emerald" : "rose"} icon={Wallet} />
          </div>

          {/* Smart Analytics & Alerts */}
          {(() => {
            const analysis = analyzePoultry({
              flocks: filteredFlocks,
              feedLogs: filteredFeedLogs,
              waterLogs: filteredWaterLogs,
              healthRecords: filteredHealthRecords,
              production: filteredProduction,
              checklists,
              inventory: branchInventory,
              transactions: branchTrx,
              currentCurrency,
            });
            const hasData =
              filteredFlocks.length + filteredFeedLogs.length + filteredWaterLogs.length +
              filteredHealthRecords.length + filteredProduction.length > 0;
            return (
              <PoultryAnalyticsAlerts
                alerts={analysis.alerts}
                metrics={analysis.metrics}
                healthScore={analysis.healthScore}
                statusColor={analysis.statusColor}
                currency={currentCurrency}
                hasData={hasData}
              />
            );
          })()}

          {/* Production & Growth Analytics — daily weight/growth vs target,
              feed, FCR, mortality, broiler output, lay targets & more, with
              Batch / Flock / Branch scoping on top of the dashboard filters */}
          <PoultryGrowthAnalytics
            businessId={bizId}
            flocks={flocks}
            feedLogs={feedLogs}
            healthRecords={healthRecords}
            production={production}
            weightLogs={weightLogs}
            currentUserName={currentUser?.name}
            currentUserRole={currentUser?.role}
            onRefresh={refresh}
            dateFilter={dashDateFilter}
            productFilter={dashProductFilter}
          />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Egg Production Trend" icon={Egg}>
              <div className="p-4">
                {eggTrend.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={eggTrend}>
                      <XAxis dataKey="date" stroke="#94a3b8" style={{ fontSize: 10 }} />
                      <YAxis stroke="#94a3b8" style={{ fontSize: 10 }} />
                      <Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }} />
                      <Line type="monotone" dataKey="eggs" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : <p className="text-xs text-slate-400 text-center py-8">No production data yet.</p>}
              </div>
            </Card>

            <Card title="Flock Composition" icon={Bird}>
              <div className="p-4">
                {flockComposition.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie data={flockComposition} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={75}
                        label={(e: any) => `${e.name}: ${e.value}`}>
                        {flockComposition.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : <p className="text-xs text-slate-400 text-center py-8">No active flocks.</p>}
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card title="Feed Usage by Type" icon={Wheat}>
              <div className="p-4">
                {feedByType.length > 0 ? (
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={feedByType}>
                      <XAxis dataKey="type" stroke="#94a3b8" style={{ fontSize: 9 }} />
                      <YAxis stroke="#94a3b8" style={{ fontSize: 9 }} />
                      <Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }} />
                      <Bar dataKey="kg" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : <p className="text-xs text-slate-400 text-center py-8">No feed data.</p>}
              </div>
            </Card>

            <Card title="Upcoming Vaccinations" icon={HeartPulse}>
              <div className="p-4 space-y-2 max-h-48 overflow-y-auto">
                {upcomingVax.length > 0 ? upcomingVax.slice(0, 6).map((h) => (
                  <div key={h.id} className="p-2 rounded-lg bg-slate-900/60 border border-slate-700 text-xs">
                    <div className="font-bold text-slate-200">{h.vaccineOrDrug || h.recordType}</div>
                    <div className="text-[10px] text-slate-400">{h.batchNumber} • Due {h.nextDueDate}</div>
                  </div>
                )) : <p className="text-xs text-slate-400 text-center py-6">No upcoming vaccinations.</p>}
              </div>
            </Card>

            <Card title="Today's Checklist" icon={ClipboardCheck}>
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-400">{checklistDone} of {todayChecklist.length} done</span>
                  <span className="text-lg font-black text-emerald-400">{checklistPct}%</span>
                </div>
                <div className="w-full bg-slate-700 rounded-full h-2 overflow-hidden mb-3">
                  <div className="bg-emerald-500 h-2 rounded-full transition-all" style={{ width: `${checklistPct}%` }} />
                </div>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {todayChecklist.slice(0, 5).map((c) => (
                    <div key={c.id} className="flex items-center gap-2 text-[11px]">
                      {c.isCompleted ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        : <Circle className="w-3.5 h-3.5 text-slate-600 shrink-0" />}
                      <span className={c.isCompleted ? "text-slate-500 line-through" : "text-slate-300"}>{c.taskLabel}</span>
                    </div>
                  ))}
                  {todayChecklist.length === 0 && <p className="text-xs text-slate-400 text-center py-3">No checklist for today.</p>}
                </div>
              </div>
            </Card>
          </div>

          {/* Shared module integration */}
          <Card title="Connected GoMina 360 Modules" icon={Activity}>
            <div className="p-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              {[
                { label: "Inventory Items", value: branchInventory.length, sub: formatMoney(inventoryValue, currentCurrency, true), color: "cyan" },
                { label: "Branch Assets", value: branchAssets.length, sub: formatMoney(assetValue, currentCurrency, true), color: "purple" },
                { label: "Employees", value: branchEmployees.length, sub: "on this branch", color: "blue" },
                { label: "Customers", value: branchCustomers.length, sub: "linked buyers", color: "amber" },
                { label: "Transactions", value: branchTrx.length, sub: formatMoney(revenue, currentCurrency, true), color: "emerald" },
              ].map((s) => (
                <div key={s.label} className="bg-slate-900/60 border border-slate-700 rounded-lg p-3 text-center">
                  <div className={`text-xl font-black text-${s.color}-400`}>{s.value}</div>
                  <div className="text-[10px] text-slate-300 font-semibold mt-0.5">{s.label}</div>
                  <div className="text-[9px] text-slate-500">{s.sub}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ══════════ FLOCKS ══════════ */}
      {tab === "FLOCKS" && (
        <Card title="Flock & Batch Management" icon={Bird} action={<AddBtn onClick={() => setShowForm("FLOCKS")} label="New Flock" />}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
                <tr>
                  <th className="px-4 py-3">Batch / Flock Name</th><th className="px-4 py-3">Type / Breed</th>
                  <th className="px-4 py-3">Genetics</th><th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3">House</th><th className="px-4 py-3 text-right">Placed</th>
                  <th className="px-4 py-3 text-right">Live</th><th className="px-4 py-3 text-right">Mortality</th>
                  <th className="px-4 py-3 text-right">Age</th><th className="px-4 py-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {flocks.map((f) => {
                  const mRate = f.initialCount > 0 ? ((f.mortalityTotal || 0) / f.initialCount * 100) : 0;
                  return (
                    <tr key={f.id} className="hover:bg-slate-700/40">
                      <td className="px-4 py-3">
                        <div className="font-mono font-bold text-emerald-400">{f.batchNumber}</div>
                        <div className="text-[10px] font-semibold text-slate-300">{f.flockName || "—"}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-bold text-slate-200">{f.birdType}</div>
                        <div className="text-[10px] text-slate-400">{f.breed || "—"}</div>
                      </td>
                      <td className="px-4 py-3 text-[10px] text-purple-300 max-w-[140px]">{f.genetics || "—"}</td>
                      <td className="px-4 py-3 text-[10px] text-cyan-300 max-w-[150px]">{f.supplier || "—"}</td>
                      <td className="px-4 py-3 text-slate-300">{f.houseName || "—"}</td>
                      <td className="px-4 py-3 text-right text-slate-300">{f.initialCount?.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right font-bold text-white">{f.currentCount?.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={mRate > 5 ? "text-rose-400 font-bold" : "text-slate-400"}>
                          {f.mortalityTotal} ({mRate.toFixed(1)}%)
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-300">{f.ageWeeks}w</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          f.status === "ACTIVE" ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-700 text-slate-300"}`}>
                          {f.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {flocks.length === 0 && <tr><td colSpan={10} className="px-4 py-10 text-center text-slate-400">No flocks registered yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ══════════ FEED ══════════ */}
      {tab === "FEED" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Feed in Stock" value={`${feedStockKg.toFixed(0)} kg`} color="amber" icon={Wheat} />
            <Stat label="Total Purchased" value={`${feedPurchases.reduce((s, f) => s + f.quantityKg, 0).toFixed(0)} kg`} sub={formatMoney(feedPurchaseCost, currentCurrency, true)} color="cyan" />
            <Stat label="Total Consumed" value={`${feedConsumed.reduce((s, f) => s + f.quantityKg, 0).toFixed(0)} kg`} color="emerald" />
            <Stat label="Feed Cost" value={formatMoney(feedCostTotal, currentCurrency, true)} color="rose" />
          </div>
          <Card title="Feed Records" icon={Wheat} action={<AddBtn onClick={() => setShowForm("FEED")} label="Log Feed" />}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
                  <tr>
                    <th className="px-4 py-3">Date</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Batch</th>
                    <th className="px-4 py-3">Supplier</th><th className="px-4 py-3 text-right">Qty (kg)</th>
                    <th className="px-4 py-3 text-right">Cost</th><th className="px-4 py-3 text-center">Entry</th>
                    <th className="px-4 py-3">Recorded By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/60">
                  {feedLogs.map((f) => (
                    <tr key={f.id} className="hover:bg-slate-700/40">
                      <td className="px-4 py-3 text-slate-400">{f.recordedDate}</td>
                      <td className="px-4 py-3 font-bold text-amber-300">{f.feedType?.replace(/_/g, " ")}</td>
                      <td className="px-4 py-3 font-mono text-[10px] text-slate-400">{f.batchNumber || "—"}</td>
                      <td className="px-4 py-3 text-slate-300">{f.brandSupplier || "—"}</td>
                      <td className="px-4 py-3 text-right font-bold text-white">{f.quantityKg?.toFixed(1)}</td>
                      <td className="px-4 py-3 text-right text-emerald-400 font-bold">{formatMoney(f.totalCostGhs, currentCurrency)}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${
                          f.entryType === "PURCHASE" ? "bg-cyan-500/20 text-cyan-300" : "bg-emerald-500/20 text-emerald-300"}`}>
                          {f.entryType}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-[10px] text-slate-400">{f.recordedByName}</td>
                    </tr>
                  ))}
                  {feedLogs.length === 0 && <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">No feed records.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* ══════════ WATER ══════════ */}
      {tab === "WATER" && (
        <Card title="Water Management" icon={Droplets} action={<AddBtn onClick={() => setShowForm("WATER")} label="Log Water" />}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
                <tr>
                  <th className="px-4 py-3">Date</th><th className="px-4 py-3">Batch</th>
                  <th className="px-4 py-3 text-right">Volume (L)</th><th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3 text-right">pH</th><th className="px-4 py-3 text-center">Treated</th>
                  <th className="px-4 py-3">Treatment</th><th className="px-4 py-3">Recorded By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {waterLogs.map((w) => (
                  <tr key={w.id} className="hover:bg-slate-700/40">
                    <td className="px-4 py-3 text-slate-400">{w.recordedDate}</td>
                    <td className="px-4 py-3 font-mono text-[10px] text-slate-400">{w.batchNumber || "—"}</td>
                    <td className="px-4 py-3 text-right font-bold text-cyan-400">{w.volumeLiters?.toFixed(0)}</td>
                    <td className="px-4 py-3 text-slate-300">{w.sourceType}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={w.phLevel && (w.phLevel < 6.5 || w.phLevel > 7.5) ? "text-amber-400 font-bold" : "text-slate-300"}>
                        {w.phLevel ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {w.isTreated ? <CheckCircle className="w-4 h-4 text-emerald-400 inline" /> : <X className="w-4 h-4 text-slate-600 inline" />}
                    </td>
                    <td className="px-4 py-3 text-[10px] text-slate-400">{w.treatmentUsed || "—"}</td>
                    <td className="px-4 py-3 text-[10px] text-slate-400">{w.recordedByName}</td>
                  </tr>
                ))}
                {waterLogs.length === 0 && <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">No water records.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ══════════ HEALTH ══════════ */}
      {tab === "HEALTH" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Total Records" value={healthRecords.length} icon={HeartPulse} color="purple" />
            <Stat label="Vaccinations" value={healthRecords.filter((h) => h.recordType === "VACCINATION").length} color="emerald" />
            <Stat label="Health Cost" value={formatMoney(healthCost, currentCurrency, true)} color="rose" />
            <Stat label="Upcoming Due" value={upcomingVax.length} sub="scheduled" color="amber" />
          </div>
          <Card title="Health & Vaccination Records" icon={HeartPulse} action={<AddBtn onClick={() => setShowForm("HEALTH")} label="Add Record" />}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
                  <tr>
                    <th className="px-4 py-3">Date</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Batch</th>
                    <th className="px-4 py-3">Vaccine / Drug</th><th className="px-4 py-3">Condition</th>
                    <th className="px-4 py-3 text-right">Birds</th><th className="px-4 py-3 text-right">Mortality</th>
                    <th className="px-4 py-3 text-right">Cost</th><th className="px-4 py-3">Next Due</th>
                    <th className="px-4 py-3 text-center">Outcome</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/60">
                  {healthRecords.map((h) => (
                    <tr key={h.id} className="hover:bg-slate-700/40">
                      <td className="px-4 py-3 text-slate-400">{h.recordedDate}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${
                          h.recordType === "VACCINATION" ? "bg-emerald-500/20 text-emerald-300"
                          : h.recordType === "TREATMENT" ? "bg-amber-500/20 text-amber-300"
                          : "bg-slate-700 text-slate-300"}`}>{h.recordType}</span>
                      </td>
                      <td className="px-4 py-3 font-mono text-[10px] text-slate-400">{h.batchNumber || "—"}</td>
                      <td className="px-4 py-3 text-slate-200 font-semibold">{h.vaccineOrDrug || "—"}</td>
                      <td className="px-4 py-3 text-slate-300 max-w-[150px] truncate">{h.diseaseOrCondition || "—"}</td>
                      <td className="px-4 py-3 text-right text-slate-300">{h.birdsAffected?.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right text-rose-400 font-bold">{h.mortalityCount || 0}</td>
                      <td className="px-4 py-3 text-right text-emerald-400">{formatMoney(h.costGhs, currentCurrency)}</td>
                      <td className="px-4 py-3 text-[10px] text-amber-300">{h.nextDueDate || "—"}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                          h.outcome === "RESOLVED" ? "bg-emerald-500/20 text-emerald-300"
                          : h.outcome === "ONGOING" ? "bg-rose-500/20 text-rose-300"
                          : "bg-slate-700 text-slate-300"}`}>{h.outcome}</span>
                      </td>
                    </tr>
                  ))}
                  {healthRecords.length === 0 && <tr><td colSpan={10} className="px-4 py-10 text-center text-slate-400">No health records.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* ══════════ PRODUCTION ══════════ */}
      {tab === "PRODUCTION" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Eggs (latest day)" value={eggsToday.toLocaleString()} sub={`${traysToday.toFixed(1)} trays`} icon={Egg} />
            <Stat label="Avg Lay %" value={`${avgLayPct.toFixed(1)}%`} color="amber" icon={TrendingUp} />
            <Stat label="Total Records" value={production.length} color="cyan" />
            <Stat label="Cracked (latest)" value={latestEggs.reduce((s, p) => s + (p.crackedEggs || 0), 0)} color="rose" />
          </div>

          {/* Master Product List — every production type lives here; products
              added from the production form auto-save into this list and are
              linked to Inventory (SKU), Stock, Sales pickers and Reports. */}
          <Card title="Master Product List — Production Types & Sellable Products" icon={Package}>
            <div className="p-4" data-testid="poultry-master-products">
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
                {products.map((p: any) => {
                  const stock = branchInventory.find((i: any) => (i.sku || "").toUpperCase() === (p.sku || "").toUpperCase());
                  return (
                    <div key={p.id} data-testid={`master-product-row-${p.productKey}`}
                      className="rounded-xl border border-slate-700 bg-slate-900/60 px-3.5 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-white truncate">{p.name}</div>
                          <div className="text-[10px] font-mono text-cyan-400 truncate">{p.sku}</div>
                        </div>
                        <span className={`shrink-0 text-[9px] font-black uppercase px-1.5 py-0.5 rounded border ${
                          p.isSystem
                            ? "bg-slate-700/70 text-slate-300 border-slate-600"
                            : "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"}`}>
                          {p.isSystem ? "System" : "Custom"}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-[10px] text-slate-400">
                        <span>Unit: <b className="text-slate-200">{p.unit}</b></span>
                        <span>Sell: <b className="text-emerald-300">{formatMoney(p.sellingPriceGhs || 0, currentCurrency)}</b></span>
                        <span>Stock: <b className={`${(stock?.quantity || 0) > 0 ? "text-cyan-300" : "text-rose-300"}`}>
                          {stock ? `${stock.quantity} ${stock.unit}` : `0 ${p.unit}`}
                        </b></span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-[10px] text-slate-500 mt-3">
                Pick “+ Add New Product Type…” inside <b>Log Production</b> — the product lands here
                automatically and becomes available for future production records, inventory, stock and sales.
              </p>
            </div>
          </Card>

          <Card title="Production Records" icon={Egg} action={
            <div className="flex items-center gap-2">
              <button onClick={() => setShowForm("SALE")} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold shadow">
                <Plus className="w-3.5 h-3.5" /> Record Sale
              </button>
              <AddBtn onClick={() => setShowForm("PRODUCTION")} label="Log Production" />
            </div>
          }>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
                  <tr>
                    <th className="px-4 py-3">Date</th><th className="px-4 py-3">Batch</th><th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3 text-right">Product Qty</th>
                    <th className="px-4 py-3 text-right">Eggs</th><th className="px-4 py-3 text-right">Trays</th>
                    <th className="px-4 py-3 text-right">Grade A/B</th><th className="px-4 py-3 text-right">Cracked</th>
                    <th className="px-4 py-3 text-right">Lay %</th><th className="px-4 py-3 text-right">FCR</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/60">
                  {production.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-700/40">
                      <td className="px-4 py-3 text-slate-400">{p.recordedDate}</td>
                      <td className="px-4 py-3 font-mono text-[10px] text-emerald-400">{p.batchNumber || "—"}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${
                          p.productionType === "EGGS" || p.productionType === "BROILER_WEIGHT"
                            ? "bg-slate-700 text-slate-200"
                            : "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"}`}>
                          {p.productionType === "EGGS" ? "EGGS"
                            : p.productionType === "BROILER_WEIGHT" ? "BROILER"
                            : (p.productName || products.find((x: any) => x.productKey === p.productionType)?.name || p.productionType)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-amber-300 font-bold">
                        {p.productionType === "BROILER_WEIGHT"
                          ? (p.birdsHarvested ? `${p.birdsHarvested.toLocaleString()} birds` : "—")
                          : p.productionType === "EGGS"
                          ? "—"
                          : `${(p.quantityProduced ?? 0).toLocaleString()} ${p.unit || ""}`}
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-white">{p.eggsCollected ? p.eggsCollected.toLocaleString() : "—"}</td>
                      <td className="px-4 py-3 text-right text-cyan-400 font-bold">{p.traysProduced ? p.traysProduced.toFixed(1) : "—"}</td>
                      <td className="px-4 py-3 text-right text-slate-300 text-[10px]">{p.gradeA || 0} / {p.gradeB || 0}</td>
                      <td className="px-4 py-3 text-right text-rose-400">{p.crackedEggs || 0}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={`font-bold ${(p.layPercentage || 0) >= 85 ? "text-emerald-400" : "text-amber-400"}`}>
                          {p.layPercentage ? `${p.layPercentage}%` : "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-300">{p.fcr || "—"}</td>
                    </tr>
                  ))}
                  {production.length === 0 && <tr><td colSpan={10} className="px-4 py-10 text-center text-slate-400">No production records.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* ══════════ INVENTORY (shared module) ══════════ */}
      {tab === "INVENTORY" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Inventory Items" value={branchInventory.length} icon={Boxes} color="cyan" />
            <Stat label="Stock Value" value={formatMoney(inventoryValue, currentCurrency, true)} color="emerald" />
            <Stat label="Low / Out of Stock" value={branchInventory.filter((i) => i.status !== "IN_STOCK").length} color="amber" />
            <Stat label="Feed Stock (kg)" value={feedStockKg.toFixed(0)} color="purple" icon={Wheat} />
          </div>
          <Card title="Branch Inventory — Linked to Shared Inventory Module" icon={Boxes}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
                  <tr>
                    <th className="px-4 py-3">SKU / Item</th><th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3 text-right">Qty</th><th className="px-4 py-3 text-right">Cost</th>
                    <th className="px-4 py-3 text-right">Selling</th><th className="px-4 py-3 text-right">Value</th>
                    <th className="px-4 py-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/60">
                  {branchInventory.map((i) => (
                    <tr key={i.id} className="hover:bg-slate-700/40">
                      <td className="px-4 py-3">
                        <div className="font-bold text-slate-100">{i.name}</div>
                        <div className="text-[10px] font-mono text-cyan-400">{i.sku}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-300">{i.category}</td>
                      <td className="px-4 py-3 text-right font-bold text-white">{i.quantity?.toLocaleString()} {i.unit}</td>
                      <td className="px-4 py-3 text-right text-slate-400">{formatMoney(i.costPriceGhs, currentCurrency)}</td>
                      <td className="px-4 py-3 text-right text-emerald-400 font-bold">{formatMoney(i.sellingPriceGhs, currentCurrency)}</td>
                      <td className="px-4 py-3 text-right text-cyan-400">{formatMoney((i.quantity || 0) * (i.costPriceGhs || 0), currentCurrency, true)}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                          i.status === "IN_STOCK" ? "bg-emerald-500/20 text-emerald-400"
                          : i.status === "LOW_STOCK" ? "bg-amber-500/20 text-amber-400"
                          : "bg-rose-500/20 text-rose-400"}`}>{i.status}</span>
                      </td>
                    </tr>
                  ))}
                  {branchInventory.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">No inventory for this branch.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
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
            customers={customers}
            currentCurrency={currentCurrency}
            accent="amber"
            testid="fin-report-poultry"
            aiModuleKey="POULTRY"
            opsLinks={[
              {
                label: "Production logs",
                value: String(production.length),
                note: "Egg/broiler production batches auto-stocked into Inventory",
                tone: "emerald",
              },
              {
                label: "Trays produced",
                value: production.reduce((s: number, p: any) => s + (p.traysProduced || 0), 0).toLocaleString(),
                note: "Lifetime trays across all production batches",
                tone: "amber",
              },
              {
                label: "Active flocks",
                value: String(flocks.filter((f: any) => f.status !== "DEPLETED").length),
                tone: "sky",
              },
            ]}
          />
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat label="Revenue" value={formatMoney(revenue, currentCurrency, true)} color="emerald" icon={TrendingUp} />
            <Stat label="Expenses" value={formatMoney(expenses, currentCurrency, true)} color="rose" icon={TrendingDown} />
            <Stat label="Net Profit" value={formatMoney(netProfit, currentCurrency, true)} color={netProfit >= 0 ? "emerald" : "rose"} />
            <Stat label="Feed Cost" value={formatMoney(feedCostTotal, currentCurrency, true)} color="amber" />
            <Stat label="Health Cost" value={formatMoney(healthCost, currentCurrency, true)} color="purple" />
            <Stat label="Asset Value" value={formatMoney(assetValue, currentCurrency, true)} color="cyan" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card title="Cost Breakdown" icon={Wallet}>
              <div className="p-4">
                {(() => {
                  const data = [
                    { name: "Feed", value: feedCostTotal },
                    { name: "Health", value: healthCost },
                    { name: "Other Expenses", value: Math.max(0, expenses - feedCostTotal - healthCost) },
                  ].filter((d) => d.value > 0);
                  return data.length > 0 ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <PieChart>
                        <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={(e: any) => e.name}>
                          {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                        </Pie>
                        <Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }}
                          formatter={(v: any) => formatMoney(Number(v), currentCurrency)} />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : <p className="text-xs text-slate-400 text-center py-8">No cost data.</p>;
                })()}
              </div>
            </Card>

            <div className="lg:col-span-2">
              <Card
                title="Farm Financial Records — Linked to Shared Finance Module"
                icon={Wallet}
                action={
                  <button
                    onClick={() => { setExpenseError(""); setShowExpenseForm(true); }}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold shadow"
                  >
                    <Plus className="w-3.5 h-3.5" /> Record Daily Expense
                  </button>
                }
              >
                <div className="overflow-x-auto max-h-80 overflow-y-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px] sticky top-0">
                      <tr>
                        <th className="px-4 py-3">Trx # / Date</th><th className="px-4 py-3">Category</th>
                        <th className="px-4 py-3">Recorded By</th><th className="px-4 py-3 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/60">
                      {branchTrx.slice(0, 20).map((t) => (
                        <tr key={t.id} className="hover:bg-slate-700/40">
                          <td className="px-4 py-3">
                            <div className="font-mono text-[10px] text-emerald-400">{t.transactionNumber}</div>
                            <div className="text-[9px] text-slate-500">{t.createdAt ? new Date(t.createdAt).toLocaleString() : t.date}</div>
                          </td>
                          <td className="px-4 py-3 text-slate-200 font-semibold">{t.category}</td>
                          <td className="px-4 py-3">
                            <div className="text-[10px] text-slate-300">{t.recordedBy}</div>
                            {t.recordedByRole && <div className="text-[9px] text-cyan-400">{t.recordedByRole}</div>}
                          </td>
                          <td className={`px-4 py-3 text-right font-extrabold ${t.type === "INCOME" ? "text-emerald-400" : "text-rose-400"}`}>
                            {t.type === "INCOME" ? "+" : "-"} {formatMoney(t.amountGhs, currentCurrency)}
                          </td>
                        </tr>
                      ))}
                      {branchTrx.length === 0 && <tr><td colSpan={4} className="px-4 py-10 text-center text-slate-400">No transactions.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          </div>
        </div>
      )}

      {/* ══════════ CHECKLIST ══════════ */}
      {tab === "CHECKLIST" && (
        <DailyChecklistPanel
          businessId={bizId}
          branchCode={businessInfo?.code}
          businessName={businessInfo?.name}
          employees={employees}
          currentUser={currentUser}
          accent="emerald"
          onChanged={() => { refresh(); onRefreshData?.(); }}
        />
      )}

      {/* ══════════ AI KNOWLEDGE ══════════ */}
      {tab === "AI_KNOWLEDGE" && (
        <div className="space-y-4">
          <Card title="Poultry AI Knowledge Base" icon={BookOpen}>
            <div className="p-5 space-y-4">
              <p className="text-xs text-slate-400">
                Search practical, Ghana-focused poultry farming guidance covering feed, health, housing, production, water and finance.
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input type="text" value={kbQuery} onChange={(e) => setKbQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && searchKB()}
                    placeholder="e.g. newcastle vaccine, feed formulation, heat stress, lay percentage…"
                    className="w-full pl-9 pr-4 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-emerald-500" />
                </div>
                <select value={kbCategory} onChange={(e) => setKbCategory(e.target.value)}
                  className="px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs">
                  <option value="ALL">All Topics</option>
                  {kbCategories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <button onClick={searchKB} disabled={kbLoading}
                  className="px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50">
                  {kbLoading ? "Searching…" : "Search"}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {["newcastle vaccine", "feed cost", "heat stress", "lay percentage", "coccidiosis", "brooding", "biosecurity", "profit"].map((s) => (
                  <button key={s} onClick={() => { setKbQuery(s); setTimeout(searchKB, 50); }}
                    className="px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-700 text-[10px] text-cyan-300 hover:bg-slate-700">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {kbArticles.map((a) => (
              <div key={a.id} className="bg-slate-800/90 border border-slate-700/80 rounded-xl overflow-hidden">
                <button onClick={() => setKbOpen(kbOpen === a.id ? null : a.id)}
                  className="w-full p-4 text-left hover:bg-slate-700/40 transition">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[9px] font-bold">{a.category}</span>
                      <h4 className="text-sm font-bold text-white mt-1.5">{a.title}</h4>
                      <p className="text-[11px] text-slate-400 mt-1">{a.summary}</p>
                    </div>
                    <span className="text-slate-500 text-lg shrink-0">{kbOpen === a.id ? "−" : "+"}</span>
                  </div>
                </button>
                {kbOpen === a.id && (
                  <div className="px-4 pb-4 border-t border-slate-700/60 pt-3 space-y-2">
                    {a.content.map((p: string, i: number) => (
                      <p key={i} className="text-xs text-slate-300 leading-relaxed flex gap-2">
                        <span className="text-emerald-400 shrink-0">•</span>
                        <span>{p}</span>
                      </p>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {kbArticles.length === 0 && !kbLoading && (
              <div className="lg:col-span-2 text-center py-10 text-sm text-slate-400">
                No articles found for "{kbQuery}". Try a different search term.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════ DAILY EXPENSE FORM ══════════ */}
      {showExpenseForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-xl shadow-2xl max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-800 p-5 shrink-0">
              <div>
                <h3 className="text-lg font-bold text-white">Record Daily Poultry Expense</h3>
                <p className="text-[11px] text-slate-400">
                  Linked to {businessInfo?.name} ({businessInfo?.code}) • Categories are shared with GoMina finance
                </p>
              </div>
              <button onClick={() => { setShowExpenseForm(false); setReceiptImages([]); setExpenseError(""); }} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={recordDailyExpense} className="overflow-y-auto p-5 space-y-4 flex-1">
              {expenseError && (
                <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-3 rounded-lg text-xs">
                  {expenseError}
                </div>
              )}

              {/* Category select with add new */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] font-semibold text-slate-400">Expense Category *</label>
                  <button type="button" onClick={() => setShowAddCategory(true)} className="text-[10px] text-emerald-400 font-semibold hover:text-emerald-300">+ Add New</button>
                </div>
                <select
                  value={expenseForm.category}
                  onChange={(e) => setExpenseForm({ ...expenseForm, category: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs"
                >
                  {expCategories.length > 0 ? (
                    <>
                      {expCategories.map((c: any) => (
                        <option key={c.id} value={c.name}>{c.icon || "📋"} {c.name}</option>
                      ))}
                      <option value="---NEW---">+ Create new category…</option>
                    </>
                  ) : (
                    <>
                      <option value="FEED_PURCHASE">🌾 Feed Purchase</option>
                      <option value="VACCINATION">💉 Vaccination</option>
                      <option value="VETERINARY">🏥 Veterinary</option>
                      <option value="WATER">💧 Water & Treatment</option>
                      <option value="ELECTRICITY">⚡ Electricity</option>
                      <option value="FUEL">⛽ Fuel & Generator</option>
                      <option value="LABOR">👷 Labor</option>
                      <option value="TRANSPORT">🚛 Transport</option>
                      <option value="LITTER">🌿 Litter & Bedding</option>
                      <option value="REPAIRS">🔧 Repairs</option>
                      <option value="BIOSECURITY">🛡️ Biosecurity & PPE</option>
                      <option value="PACKAGING">📦 Packaging</option>
                      <option value="MARKETING">📢 Marketing</option>
                      <option value="OTHER">📋 Other (custom)</option>
                    </>
                  )}
                </select>
                {expenseForm.category === "---NEW---" && (
                  <div className="mt-2 p-3 bg-slate-800/80 border border-slate-700 rounded-lg space-y-2">
                    <input
                      type="text" required
                      value={expenseForm.customCategory}
                      onChange={(e) => setExpenseForm({ ...expenseForm, customCategory: e.target.value })}
                      placeholder="New category name"
                      className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs"
                    />
                    <p className="text-[10px] text-slate-500">This category will be saved for future use.</p>
                  </div>
                )}
              </div>

              {/* Amount */}
              <div>
                <label className="block text-[10px] font-semibold text-slate-400 mb-1">Amount (GH₵) *</label>
                <input
                  type="number" min="0.01" step="0.01" required
                  value={expenseForm.amountGhs}
                  onChange={(e) => setExpenseForm({ ...expenseForm, amountGhs: e.target.value })}
                  placeholder="0.00"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs font-bold"
                />
              </div>

              {/* Payment + Date */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 mb-1">Payment Method</label>
                  <select
                    value={expenseForm.paymentMethod}
                    onChange={(e) => setExpenseForm({ ...expenseForm, paymentMethod: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs"
                  >
                    <option value="CASH">Cash</option>
                    <option value="MTN_MOMO">MTN MoMo</option>
                    <option value="TELECEL_CASH">Telecel Cash</option>
                    <option value="BANK_TRANSFER">Bank Transfer</option>
                    <option value="POS_CARD">POS Card</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 mb-1">Date</label>
                  <input
                    type="date"
                    value={expenseForm.date}
                    onChange={(e) => setExpenseForm({ ...expenseForm, date: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs"
                  />
                </div>
              </div>

              {/* Vendor */}
              <div>
                <label className="block text-[10px] font-semibold text-slate-400 mb-1">Vendor / Payee</label>
                <input
                  type="text"
                  value={expenseForm.vendor}
                  onChange={(e) => setExpenseForm({ ...expenseForm, vendor: e.target.value })}
                  placeholder="e.g. Ghafeed Poultry Mills Ltd"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-[10px] font-semibold text-slate-400 mb-1">Description</label>
                <textarea
                  rows={2}
                  value={expenseForm.description}
                  onChange={(e) => setExpenseForm({ ...expenseForm, description: e.target.value })}
                  placeholder="What was purchased? Add receipt details."
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs resize-none"
                />
              </div>

              {/* Receipt Photos */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] font-semibold text-slate-400">Receipt Photos (optional)</label>
                  <span className="text-[10px] text-slate-500">{receiptImages.length} attached</span>
                </div>
                {/* Preview thumbnails */}
                {receiptImages.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {receiptImages.map((img, idx) => (
                      <div key={idx} className="relative group w-20 h-20">
                        <img src={img} alt={`Receipt ${idx + 1}`} className="w-full h-full object-cover rounded-lg border border-slate-700" />
                        <button type="button" onClick={() => removeReceiptImage(idx)} className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-rose-600 text-white rounded-full text-xs flex items-center justify-center opacity-80 hover:opacity-100">×</button>
                      </div>
                    ))}
                  </div>
                )}
                {/* Upload buttons */}
                <div className="flex gap-2">
                  <label className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-800 border border-slate-700 border-dashed rounded-lg text-xs text-slate-400 hover:text-emerald-400 hover:border-emerald-500/50 cursor-pointer transition">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                    Upload Receipt
                    <input type="file" accept="image/*" multiple onChange={handleReceiptUpload} className="hidden" />
                  </label>
                  <label className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-800 border border-slate-700 border-dashed rounded-lg text-xs text-slate-400 hover:text-emerald-400 hover:border-emerald-500/50 cursor-pointer transition">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><circle cx="12" cy="13" r="3"/></svg>
                    Take Photo
                    <input type="file" accept="image/*" capture="environment" onChange={handleReceiptUpload} className="hidden" />
                  </label>
                </div>
              </div>

              {/* Auto-tracking info */}
              <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-3 text-[10px] text-slate-400">
                <div className="font-bold text-slate-300 mb-1">Automatic tracking</div>
                <div>Business: <span className="text-slate-200">{businessInfo?.name}</span></div>
                <div>Branch: <span className="text-slate-200">{businessInfo?.code}</span></div>
                <div>Recorded by: <span className="text-slate-200">{currentUser?.name}</span> ({currentUser?.role})</div>
                <div>Server timestamp: generated on submit</div>
                {receiptImages.length > 0 && <div className="mt-1 text-emerald-400">📷 {receiptImages.length} receipt photo(s) attached</div>}
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
                <button type="button" onClick={() => { setShowExpenseForm(false); setReceiptImages([]); setExpenseError(""); }} className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold">Cancel</button>
                <button type="submit" disabled={expenseBusy} className="px-5 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold disabled:opacity-50">
                  {expenseBusy ? "Recording…" : "Record Expense"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─── Add Category Modal ─── */}
      {showAddCategory && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-sm shadow-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white">Add New Expense Category</h3>
              <button onClick={() => setShowAddCategory(false)} className="p-1 rounded hover:bg-slate-800 text-slate-400"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] font-semibold text-slate-400 mb-1">Category Name</label>
                <input
                  type="text" required
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  placeholder="e.g. Generator Servicing"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-slate-400 mb-1">Icon</label>
                <div className="flex flex-wrap gap-1.5">
                  {["📋","🔧","⛽","💡","📞","🧪","🪵","🚚","🧹","📦","🛡️","📢","💊","🧑‍🌾","🏗️","📊","🧯","💰"].map(icon => (
                    <button key={icon} type="button" onClick={() => setNewCategoryIcon(icon)} className={`w-8 h-8 rounded-lg text-lg flex items-center justify-center border transition ${newCategoryIcon === icon ? "bg-emerald-500/20 border-emerald-500/50" : "bg-slate-800 border-slate-700 hover:border-slate-500"}`}>
                      {icon}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowAddCategory(false)} className="px-3 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold">Cancel</button>
                <button type="button" onClick={handleAddCategory} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold">Save Category</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════ FORMS ══════════ */}
      {showForm && (
        <PoultryForm
          type={showForm} flocks={flocks} inventory={branchInventory} products={products} busy={busy} error={err}
          onClose={() => { setShowForm(null); setErr(""); }}
          onSubmit={submit}
        />
      )}
    </div>
  );
}

// ─────────────────────────── FORM MODAL ───────────────────────────
function PoultryForm({ type, flocks, inventory = [], products = [], busy, error, onClose, onSubmit }: any) {
  const [f, setF] = useState<any>({
    birdType: "LAYERS", status: "ACTIVE", feedType: "LAYER_MASH", entryType: "CONSUMPTION",
    sourceType: "BOREHOLE", isTreated: false, recordType: "VACCINATION", outcome: "MONITORING",
    productionType: "EGGS", paymentMethod: "CASH", npUnit: "Trays", npCategory: "Poultry Products",
  });
  const set = (k: string, v: any) => setF({ ...f, [k]: v });

  const titles: Record<string, string> = {
    FLOCKS: "Register New Flock", FEED: "Log Feed Record", WATER: "Log Water Record",
    HEALTH: "Add Health / Vaccination Record", PRODUCTION: "Log Production Record",
    SALE: "Record Sale — Farm Products",
  };
  const entities: Record<string, string> = {
    FLOCKS: "FLOCK", FEED: "FEED", WATER: "WATER", HEALTH: "HEALTH", PRODUCTION: "PRODUCTION",
    SALE: "SALE",
  };
  const sellable = (inventory || []).filter((i: any) => (i.quantity || 0) > 0);

  const I = ({ label, k, t = "text", ...rest }: any) => (
    <div>
      <label className="block text-[10px] font-semibold text-slate-400 mb-1">{label}</label>
      <input type={t} value={f[k] ?? ""} onChange={(e) => set(k, t === "number" ? Number(e.target.value) : e.target.value)}
        className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs" {...rest} />
    </div>
  );
  const S = ({ label, k, opts }: any) => (
    <div>
      <label className="block text-[10px] font-semibold text-slate-400 mb-1">{label}</label>
      <select value={f[k] ?? ""} onChange={(e) => set(k, e.target.value)}
        className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs">
        {opts.map((o: any) => <option key={o.v ?? o} value={o.v ?? o}>{o.l ?? o}</option>)}
      </select>
    </div>
  );
  const BatchSelect = () => (
    <S label="Flock / Batch" k="batchNumber"
      opts={[{ v: "", l: "— Select batch —" }, ...flocks.map((x: any) => ({ v: x.batchNumber, l: `${x.batchNumber} (${x.birdType})` }))]} />
  );

  const handle = (e: React.FormEvent) => {
    e.preventDefault();
    const data = { ...f };
    if (data.batchNumber) {
      const flock = flocks.find((x: any) => x.batchNumber === data.batchNumber);
      if (flock) data.flockId = flock.id;
    }
    onSubmit(entities[type], data);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-slate-800 p-5">
          <h3 className="text-lg font-bold text-white">{titles[type]}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handle} className="overflow-y-auto p-5 space-y-3">
          {error && <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-2.5 rounded-lg text-xs">{error}</div>}

          {type === "FLOCKS" && (<>
            <div className="grid grid-cols-2 gap-3">
              <I label="Batch Number" k="batchNumber" placeholder="Auto-generated if blank" />
              <I label="Flock Name" k="flockName" placeholder="e.g. Nsawam Isa Brown Flock 01" />
              <S label="Bird Type" k="birdType" opts={["LAYERS", "BROILERS", "COCKERELS", "TURKEYS", "GUINEA_FOWL"]} />
              <I label="Breed" k="breed" placeholder="e.g. Isa Brown" />
              <I label="Genetics" k="genetics" placeholder="e.g. Isa Brown (Hy-Line Genetics)" />
              <I label="Supplier" k="supplier" placeholder="e.g. Akate Farms Hatchery Ltd" />
              <I label="House / Pen" k="houseName" placeholder="e.g. House A" />
              <I label="Initial Count *" k="initialCount" t="number" required min={1} />
              <I label="Age (weeks)" k="ageWeeks" t="number" step="0.5" />
              <I label="Arrival Date" k="arrivalDate" t="date" />
              <I label="Cost / Bird (GH₵)" k="costPerBirdGhs" t="number" step="0.01" />
            </div>
            <I label="Source Hatchery" k="sourceHatchery" placeholder="e.g. Akate Farms Hatchery" />
          </>)}

          {type === "FEED" && (<>
            <div className="grid grid-cols-2 gap-3">
              <S label="Entry Type" k="entryType" opts={[{ v: "CONSUMPTION", l: "Consumption (used)" }, { v: "PURCHASE", l: "Purchase (stock in)" }]} />
              <S label="Feed Type" k="feedType" opts={["STARTER", "GROWER", "FINISHER", "LAYER_MASH", "CONCENTRATE"]} />
            </div>
            <BatchSelect />
            <div className="grid grid-cols-2 gap-3">
              <I label="Quantity (kg) *" k="quantityKg" t="number" step="0.1" required min={0.1} />
              <I label="Cost per kg (GH₵)" k="costPerKgGhs" t="number" step="0.01" />
            </div>
            <I label="Brand / Supplier" k="brandSupplier" placeholder="e.g. Ghafeed Poultry Mills" />
            <I label="Date" k="recordedDate" t="date" />
          </>)}

          {type === "WATER" && (<>
            <BatchSelect />
            <div className="grid grid-cols-2 gap-3">
              <I label="Volume (Liters) *" k="volumeLiters" t="number" step="1" required min={1} />
              <S label="Source" k="sourceType" opts={["BOREHOLE", "PIPED", "TANKER", "RAINWATER"]} />
              <I label="pH Level" k="phLevel" t="number" step="0.1" placeholder="6.5 – 7.5" />
              <I label="Date" k="recordedDate" t="date" />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input type="checkbox" checked={!!f.isTreated} onChange={(e) => set("isTreated", e.target.checked)} className="accent-emerald-500" />
              Water was treated
            </label>
            {f.isTreated && <I label="Treatment Used" k="treatmentUsed" placeholder="e.g. Chlorine + Vitamin C" />}
          </>)}

          {type === "HEALTH" && (<>
            <div className="grid grid-cols-2 gap-3">
              <S label="Record Type" k="recordType" opts={["VACCINATION", "TREATMENT", "INSPECTION", "MORTALITY", "BIOSECURITY"]} />
              <S label="Outcome" k="outcome" opts={["MONITORING", "RESOLVED", "ONGOING"]} />
            </div>
            <BatchSelect />
            <div className="grid grid-cols-2 gap-3">
              <I label="Vaccine / Drug" k="vaccineOrDrug" placeholder="e.g. Lasota" />
              <I label="Disease / Condition" k="diseaseOrCondition" placeholder="e.g. Newcastle" />
              <I label="Dosage" k="dosage" placeholder="e.g. 1 dose/bird" />
              <I label="Administered By" k="administeredBy" placeholder="Vet or staff name" />
              <I label="Birds Affected" k="birdsAffected" t="number" />
              <I label="Mortality Count" k="mortalityCount" t="number" />
              <I label="Cost (GH₵)" k="costGhs" t="number" step="0.01" />
              <I label="Next Due Date" k="nextDueDate" t="date" />
            </div>
            <I label="Date" k="recordedDate" t="date" />
            <I label="Notes" k="notes" placeholder="Optional observations" />
          </>)}

          {type === "PRODUCTION" && (() => {
            // Production types = system products + every custom product in the
            // Master Product List, plus the option to add a brand-new type
            // right here (auto-saved & linked to Inventory/Stock/Sales).
            const customProducts = products.filter(
              (p: any) => p.isActive && !["EGGS", "BROILER_WEIGHT"].includes(p.productKey)
            );
            const selCustom = customProducts.find((p: any) => p.productKey === f.productionType);
            const isNew = f.productionType === "__NEW__";
            const newUnit = f.npUnit || "Units";
            return (<>
              <div data-testid="production-type-field">
                <S label="Production Type" k="productionType" opts={[
                  { v: "EGGS", l: "Eggs" },
                  { v: "BROILER_WEIGHT", l: "Broiler Harvest" },
                  ...customProducts.map((p: any) => ({ v: p.productKey, l: `${p.name} (${p.unit})` })),
                  { v: "__NEW__", l: "＋ Add New Product Type…" },
                ]} />
              </div>

              {isNew && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-3" data-testid="new-product-panel">
                  <div className="text-[11px] font-bold text-emerald-300">
                    New Product Type — saved to the Master Product List and linked into Inventory, Stock, Sales & Reports
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <I label="Product Name *" k="npName" placeholder="e.g. Duck Egg Crates" />
                    <S label="Unit" k="npUnit" opts={["Trays", "Birds", "Kg", "Pieces", "Crates", "Bags", "Units"]} />
                    <I label="Cost Price (GH₵)" k="npCost" t="number" step="0.01" />
                    <I label="Selling Price (GH₵)" k="npSelling" t="number" step="0.01" />
                    <I label="Min Stock Alert Qty" k="npThreshold" t="number" step="1" />
                    <I label="Category" k="npCategory" placeholder="Poultry Products" />
                  </div>
                </div>
              )}

              <BatchSelect />

              {f.productionType === "EGGS" ? (
                <div className="grid grid-cols-2 gap-3">
                  <I label="Eggs Collected *" k="eggsCollected" t="number" required min={0} />
                  <I label="Trays" k="traysProduced" t="number" step="0.1" placeholder="Auto (eggs÷30)" />
                  <I label="Grade A" k="gradeA" t="number" />
                  <I label="Grade B" k="gradeB" t="number" />
                  <I label="Cracked Eggs" k="crackedEggs" t="number" />
                  <I label="Lay %" k="layPercentage" t="number" step="0.1" />
                </div>
              ) : f.productionType === "BROILER_WEIGHT" ? (
                <div className="grid grid-cols-2 gap-3">
                  <I label="Birds Harvested" k="birdsHarvested" t="number" />
                  <I label="Total Weight (kg)" k="totalWeightKg" t="number" step="0.1" />
                  <I label="Avg Weight (kg)" k="avgWeightKg" t="number" step="0.01" />
                  <I label="FCR" k="fcr" t="number" step="0.01" />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <I
                    label={`Quantity Produced * (${isNew ? newUnit : selCustom?.unit || "Units"})`}
                    k="quantityProduced" t="number" step="0.01" required min={0.01}
                  />
                  <I label="Sold Immediately (qty, optional)" k="quantitySold" t="number" step="0.01" />
                  <I label="Revenue (GH₵, optional)" k="revenueGhs" t="number" step="0.01" />
                </div>
              )}
              <I label="Date" k="recordedDate" t="date" />
            </>);
          })()}

          {type === "SALE" && (<>
            {(() => {
              const sel = sellable.find((i: any) => String(i.id) === String(f.inventoryId));
              return (<>
                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 mb-1">Product (from available stock) *</label>
                  <select required value={f.inventoryId ?? ""} onChange={(e) => {
                    const it = sellable.find((x: any) => String(x.id) === e.target.value);
                    setF((prev: any) => ({ ...prev, inventoryId: e.target.value, sellingPrice: it ? it.sellingPriceGhs : prev.sellingPrice }));
                  }} className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs">
                    <option value="">{sellable.length ? "— select product —" : "— no stock available: log production first —"}</option>
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
                  <I label="Unit Price (GH₵)" k="sellingPrice" t="number" step="0.01" placeholder={sel ? String(sel.sellingPriceGhs) : "Auto from stock"} />
                </div>
                {sel && f.quantity ? (
                  <div className="text-[11px] text-cyan-300 bg-cyan-500/10 border border-cyan-500/30 rounded-lg px-3 py-2">
                    Total: <b>GH₵ {(((Number(f.sellingPrice) || sel.sellingPriceGhs) || 0) * Number(f.quantity)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>
                    {" "}— stock will drop to {(sel.quantity - Number(f.quantity)).toLocaleString()} {sel.unit}; revenue & profit update instantly.
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-3">
                  <I label="Customer Name" k="customerName" placeholder="Walk-in Customer" />
                  <I label="Customer Phone" k="customerPhone" placeholder="024…" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <S label="Payment Method" k="paymentMethod" opts={["CASH", "MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER", "CARD"]} />
                  <I label="Price Override Reason" k="customPriceReason" placeholder="Only if price changed" />
                </div>
                <I label="Notes" k="notes" placeholder="Optional" />
              </>);
            })()}
          </>)}

          <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold">Cancel</button>
            <button type="submit" disabled={busy} className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50">
              {busy ? "Saving…" : "Save Record"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
