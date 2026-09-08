"use client";

import React, { useEffect, useState } from "react";
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
  FileText,
  RotateCcw,
  Search,
  Printer,
  TrendingUp,
  Users,
  Building2,
  ClipboardEdit,
  BarChart3,
  Landmark,
  HandCoins,
  Download,
  Eye,
  Repeat,
  Plus,
  X,
} from "lucide-react";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import { COMPANY_INFO } from "@/lib/companyInfo";
import { addToOfflineQueue } from "@/lib/offlineSync";
import SalesDocumentBuilder from "./SalesDocumentBuilder";
import FinancialReportSection from "./FinancialReportSection";
import { generateSalesDocumentPDF, printSalesDocument, downloadFile as downloadPDFFile } from "@/lib/salesDocument";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  PieChart,
  Pie,
  Cell,
} from "recharts";

interface BranchManagerSalesViewProps {
  currentUser: any;
  businessInfo: any;
  businessMetrics: any;
  /** All live metrics (indexed by businessId) so the header can retarget when the executive switches branches. */
  metrics?: any[];
  inventory: any[];
  customers: any[];
  /** Branch-isolated credit sales register (from /api/init) for the Credit tab. */
  creditSales?: any[];
  transactions: any[];
  businesses: any[];
  currentCurrency: CurrencyCode;
  isOnline: boolean;
  onRefreshData: () => void;
  /** Executives (Owner / General Manager) can sell across every branch. */
  isExecutive?: boolean;
}

export default function BranchManagerSalesView({
  currentUser,
  businessInfo,
  businessMetrics,
  metrics,
  inventory,
  customers,
  creditSales = [],
  transactions,
  businesses,
  currentCurrency,
  isOnline,
  onRefreshData,
  isExecutive = false,
}: BranchManagerSalesViewProps) {
  type SalesTab = "NEW_SALE" | "CREDIT" | "INVOICES" | "QUOTATIONS" | "ANALYTICS" | "FIN_REPORT" | "PAYMENTS" | "RECEIPTS" | "RETURNS" | "CUSTOMERS" | "INVENTORY";
  const [activeSubTab, setActiveSubTab] = useState<SalesTab>("NEW_SALE");

  // Sales documents (invoices, quotations, receipts)
  const [salesDocuments, setSalesDocuments] = useState<any[]>([]);
  const [showBuilder, setShowBuilder] = useState<null | "INVOICE" | "QUOTATION">(null);
  const [viewDoc, setViewDoc] = useState<any>(null);
  const [docActionBusy, setDocActionBusy] = useState<number | null>(null);
  const [docSearchTerm, setDocSearchTerm] = useState("");

  // Executives pick which branch to operate on; branch managers are locked in.
  const [selectedBizId, setSelectedBizId] = useState<number | null>(
    businessInfo?.id ?? null
  );
  const activeBiz =
    isExecutive && businesses?.length > 0
      ? businesses.find((b) => b.id === selectedBizId) || businessInfo
      : businessInfo;

  // Metrics for the currently active branch — used to display live asset value
  // and other financial figures in the sales-center header.
  const activeBizMetrics =
    (metrics && metrics.find((m: any) => m.businessId === activeBiz?.id)) ||
    businessMetrics;

  // ─────── Credit sales: branch-isolated register + dashboard totals ───────
  // BRANCH ISOLATION: only credits belonging to the operating branch are
  // counted/shown here (an executive switching the branch selector re-slices
  // the totals to that branch).
  const branchCreditSales = (creditSales || []).filter(
    (cs: any) => cs.businessId === activeBiz?.id
  );
  const r2c = (n: number) => Math.round(n * 100) / 100;
  const creditTotals = {
    salesGhs: r2c(branchCreditSales.reduce((a: number, c: any) => a + (Number(c.totalGhs) || 0), 0)),
    paidGhs: r2c(branchCreditSales.reduce((a: number, c: any) => a + (Number(c.amountPaidGhs) || 0), 0)),
    outstandingGhs: r2c(branchCreditSales.reduce((a: number, c: any) => a + (Number(c.balanceGhs) || 0), 0)),
    activeCount: branchCreditSales.filter((c: any) => c.status === "ACTIVE").length,
    count: branchCreditSales.length,
  };

  // ─────── Credit sale form + installment modal state ───────
  const [saleOnCredit, setSaleOnCredit] = useState(false);
  const [creditDeposit, setCreditDeposit] = useState("");
  const [creditDepositMethod, setCreditDepositMethod] = useState("CASH");
  const [creditDueDate, setCreditDueDate] = useState("");
  const [creditSearch, setCreditSearch] = useState("");
  const [creditLookupCode, setCreditLookupCode] = useState("");
  const [creditModalSale, setCreditModalSale] = useState<any>(null);
  const [creditPayAmount, setCreditPayAmount] = useState("");
  const [creditPayMethod, setCreditPayMethod] = useState("MTN_MOMO");
  const [creditPayRef, setCreditPayRef] = useState("");
  const [creditPayNote, setCreditPayNote] = useState("");
  const [creditBusy, setCreditBusy] = useState(false);
  const [creditError, setCreditError] = useState("");
  const [creditFlash, setCreditFlash] = useState("");

  // ─────── Inventory-linked sale state ───────
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
  const [saleDiscountPct, setSaleDiscountPct] = useState<number>(0); // % auto-calculates the amount
  const [saleNotes, setSaleNotes] = useState("");
  const [inventorySearch, setInventorySearch] = useState("");
  const [inventoryCatFilter, setInventoryCatFilter] = useState("ALL");
  const [isSubmittingSale, setIsSubmittingSale] = useState(false);
  const [saleSuccess, setSaleSuccess] = useState(false);
  const [saleError, setSaleError] = useState("");
  const [lastSaleInfo, setLastSaleInfo] = useState<any>(null);
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);

  // ─────── Returns form state ───────
  const [returnTransactionId, setReturnTransactionId] = useState("");
  const [returnAmount, setReturnAmount] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const [isSubmittingReturn, setIsSubmittingReturn] = useState(false);
  const [returnSuccess, setReturnSuccess] = useState(false);

  // ─────── Customer form state ───────
  const [newCustName, setNewCustName] = useState("");
  const [newCustPhone, setNewCustPhone] = useState("+233 24 ");
  const [newCustEmail, setNewCustEmail] = useState("");
  const [newCustType, setNewCustType] = useState("RETAIL");
  const [isCreatingCustomer, setIsCreatingCustomer] = useState(false);

  // ─────── Derived data ───────
  const branchInventory = inventory.filter(
    (inv) => inv.businessId === activeBiz?.id
  );
  // Business-isolated CRM — the branch only ever sells to its OWN customers.
  const branchCustomers = customers.filter(
    (c) => c.businessId === activeBiz?.id
  );
  const branchTransactions = transactions.filter(
    (t) => t.businessId === activeBiz?.id
  ).sort((a: any, b: any) => (b.id || 0) - (a.id || 0));

  const todayIncome = branchTransactions
    .filter(
      (t: any) =>
        t.type === "INCOME" && t.date === new Date().toISOString().split("T")[0]
    )
    .reduce((acc: number, t: any) => acc + (t.amountGhs || 0), 0);

  const totalSales = branchTransactions
    .filter((t: any) => t.type === "INCOME")
    .reduce((acc: number, t: any) => acc + (t.amountGhs || 0), 0);

  const recentSales = branchTransactions
    .filter((t: any) => t.type === "INCOME")
    .slice(0, 8);

  // ─────── Sales documents load ───────
  const refreshSalesDocuments = async () => {
    try {
      const res = await fetch(`/api/sales-documents?businessId=${activeBiz?.id || ""}`);
      const data = await res.json();
      if (data.success) setSalesDocuments(data.documents || []);
    } catch (err) {
      console.error("Failed to load sales documents", err);
    }
  };

  useEffect(() => {
    if (activeBiz?.id) refreshSalesDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBiz?.id]);

  const branchInvoices = salesDocuments.filter((d) => d.documentType === "INVOICE");
  const branchQuotations = salesDocuments.filter((d) => d.documentType === "QUOTATION");
  const branchReceipts = salesDocuments.filter((d) => d.documentType === "RECEIPT");

  // Filtered doc list based on search term
  const filterDocs = (list: any[]) => {
    if (!docSearchTerm.trim()) return list;
    const q = docSearchTerm.toLowerCase();
    return list.filter((d: any) =>
      [d.documentNumber, d.customerName, d.customerPhone, d.status]
        .filter(Boolean)
        .some((f: string) => String(f).toLowerCase().includes(q))
    );
  };

  // ─────── Document actions ───────
  const handleViewDoc = (doc: any) => setViewDoc(doc);

  const handlePrintDoc = async (doc: any) => {
    await printSalesDocument({ document: doc, businessInfo: activeBiz, currency: currentCurrency });
  };

  const handleDownloadDoc = async (doc: any) => {
    const blob = await generateSalesDocumentPDF({ document: doc, businessInfo: activeBiz, currency: currentCurrency });
    const prefix = doc.documentType.toLowerCase();
    downloadPDFFile(blob, `${prefix}-${doc.documentNumber}.pdf`);
  };

  const handleConvertQuotation = async (doc: any) => {
    if (!window.confirm(`Convert quotation ${doc.documentNumber} to invoice?`)) return;
    setDocActionBusy(doc.id);
    try {
      const res = await fetch("/api/sales-documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: doc.id,
          convertToInvoice: true,
          currentUserId: currentUser?.id,
          currentUserName: currentUser?.name,
        }),
      });
      const data = await res.json();
      if (data.success) {
        await refreshSalesDocuments();
        alert(`✓ Converted to invoice ${data.document.documentNumber}`);
        setActiveSubTab("INVOICES");
      }
    } finally {
      setDocActionBusy(null);
    }
  };

  const handleMarkPaid = async (doc: any) => {
    const method = window.prompt(
      "Payment method (MTN_MOMO, TELECEL_CASH, BANK_TRANSFER, CASH, POS_CARD):",
      "MTN_MOMO"
    );
    if (!method) return;
    setDocActionBusy(doc.id);
    try {
      const res = await fetch("/api/sales-documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: doc.id,
          status: "PAID",
          paymentMethod: method.toUpperCase(),
        }),
      });
      if (res.ok) {
        await refreshSalesDocuments();
      }
    } finally {
      setDocActionBusy(null);
    }
  };

  // ─────── Analytics data ───────
  const analyticsPaymentMethods = (() => {
    const map: Record<string, number> = {};
    branchTransactions
      .filter((t: any) => t.type === "INCOME")
      .forEach((t: any) => {
        map[t.paymentMethod] = (map[t.paymentMethod] || 0) + (t.amountGhs || 0);
      });
    return Object.entries(map).map(([method, amount]) => ({ method, amount }));
  })();

  const analyticsDailySales = (() => {
    const map: Record<string, number> = {};
    branchTransactions
      .filter((t: any) => t.type === "INCOME")
      .slice(0, 30)
      .forEach((t: any) => {
        const d = t.date || "unknown";
        map[d] = (map[d] || 0) + (t.amountGhs || 0);
      });
    return Object.entries(map)
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => a.date.localeCompare(b.date));
  })();

  const analyticsDocStatus = (() => {
    const invByStatus: Record<string, number> = {};
    branchInvoices.forEach((d: any) => {
      invByStatus[d.status] = (invByStatus[d.status] || 0) + 1;
    });
    return Object.entries(invByStatus).map(([status, count]) => ({ status, count }));
  })();

  const analyticsTopCustomers = (() => {
    const map: Record<string, number> = {};
    branchInvoices.forEach((d: any) => {
      map[d.customerName] = (map[d.customerName] || 0) + (d.totalGhs || 0);
    });
    return Object.entries(map)
      .map(([customer, total]) => ({ customer, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
  })();

  // ─────── Cart helpers ───────
  const inStockInventory = branchInventory.filter(
    (inv: any) => inv.status !== "OUT_OF_STOCK" && inv.quantity > 0
  );
  const inventoryCategories = Array.from(
    new Set(branchInventory.map((i: any) => i.category).filter(Boolean))
  ).sort();
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
      if (existing.quantity >= inv.quantity) return; // can't exceed stock
      setCart(
        cart.map((c) =>
          c.inventoryId === inv.id ? { ...c, quantity: c.quantity + 1 } : c
        )
      );
    } else {
      setCart([
        ...cart,
        {
          inventoryId: inv.id,
          sku: inv.sku,
          name: inv.name,
          category: inv.category,
          unit: inv.unit,
          availableQty: inv.quantity,
          quantity: 1,
          originalPrice: inv.sellingPriceGhs,
          sellingPrice: inv.sellingPriceGhs,
          customPriceReason: "",
          isCustomPrice: false,
        },
      ]);
    }
  };

  const updateCartQty = (inventoryId: number, qty: number) => {
    setCart(
      cart.map((c) =>
        c.inventoryId === inventoryId
          ? { ...c, quantity: Math.max(1, Math.min(qty, c.availableQty)) }
          : c
      )
    );
  };

  const updateCartPrice = (inventoryId: number, price: number) => {
    setCart(
      cart.map((c) =>
        c.inventoryId === inventoryId
          ? { ...c, sellingPrice: price, isCustomPrice: price !== c.originalPrice }
          : c
      )
    );
  };

  const updateCartPriceReason = (inventoryId: number, reason: string) => {
    setCart(
      cart.map((c) =>
        c.inventoryId === inventoryId ? { ...c, customPriceReason: reason } : c
      )
    );
  };

  const removeFromCart = (inventoryId: number) => {
    setCart(cart.filter((c) => c.inventoryId !== inventoryId));
  };

  const cartSubtotal = cart.reduce(
    (sum, c) => sum + c.sellingPrice * c.quantity,
    0
  );
  const cartDiscountAmount =
    saleDiscountPct > 0 ? Math.round(((cartSubtotal * saleDiscountPct) / 100) * 100) / 100 : saleDiscount;
  const cartTotal = cartSubtotal - cartDiscountAmount;
  const cartHasCustomPrices = cart.some((c) => c.isCustomPrice);
  const canOverridePrice =
    currentUser?.role === "OWNER" || currentUser?.role === "GENERAL_MANAGER";

  // ─────── Handlers ───────
  const handleRecordSale = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cart.length === 0) return;
    setSaleError("");
    setIsSubmittingSale(true);

    // Check custom prices require permission
    if (cartHasCustomPrices && !canOverridePrice) {
      const missingReason = cart.filter(
        (c) => c.isCustomPrice && !c.customPriceReason.trim()
      );
      if (missingReason.length > 0) {
        setSaleError("Please provide a reason for each custom price.");
        setIsSubmittingSale(false);
        return;
      }
    }

    // Credit sales need an identifiable customer (server enforces this too).
    if (saleOnCredit && (!saleCustomerName.trim() || /^walk[- ]?in/i.test(saleCustomerName.trim()))) {
      setSaleError("A credit sale needs the customer's real name — no walk-in credit.");
      setIsSubmittingSale(false);
      return;
    }
    if (saleOnCredit && creditDeposit && Number(creditDeposit) > cartTotal) {
      setSaleError(`Deposit ${formatMoney(Number(creditDeposit), currentCurrency)} exceeds the credit total ${formatMoney(cartTotal, currentCurrency)}.`);
      setIsSubmittingSale(false);
      return;
    }

    const cartPayload = cart.map((c) => ({
      inventoryId: c.inventoryId,
      sku: c.sku,
      name: c.name,
      quantity: c.quantity,
      originalPrice: c.originalPrice,
      sellingPrice: c.sellingPrice,
      customPriceReason: c.isCustomPrice ? c.customPriceReason : undefined,
    }));

    try {
      const res = saleOnCredit
        ? await fetch("/api/credit-sales", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "create",
              businessId: activeBiz?.id,
              branchCode: activeBiz?.code,
              customerName: saleCustomerName.trim(),
              customerPhone: saleCustomerPhone,
              cartItems: cartPayload,
              notes: saleNotes,
              discount: saleDiscountPct > 0 ? undefined : saleDiscount,
              discountPercent: saleDiscountPct > 0 ? saleDiscountPct : undefined,
              depositAmount: creditDeposit ? Number(creditDeposit) : undefined,
              depositMethod: creditDepositMethod,
              dueDate: creditDueDate || undefined,
            }),
          })
        : await fetch("/api/sales", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              businessId: activeBiz?.id,
              branchCode: activeBiz?.code,
              customerName: saleCustomerName || "Walk-in Customer",
              customerPhone: saleCustomerPhone,
              paymentMethod: salePaymentMethod,
              cartItems: cartPayload,
              notes: saleNotes,
              discount: saleDiscountPct > 0 ? undefined : saleDiscount,
              discountPercent: saleDiscountPct > 0 ? saleDiscountPct : undefined,
              createdByUserId: currentUser?.id,
              createdByName: currentUser?.name,
              createdByRole: currentUser?.role,
            }),
          });

      const data = await res.json();
      if (data.success) {
        setSaleSuccess(true);
        setLastSaleInfo({
          invoiceNo: saleOnCredit
            ? data.invoice?.documentNumber
            : data.receipt?.documentNumber || data.transaction?.transactionNumber,
          amount: saleOnCredit ? data.creditSale?.totalGhs : data.receipt?.totalGhs || cartTotal,
          customer: saleCustomerName || "Walk-in Customer",
          paymentMethod: saleOnCredit ? "CREDIT" : salePaymentMethod,
          category: saleOnCredit ? "Credit Sale" : "Inventory Sale",
          date: new Date().toISOString().split("T")[0],
          creditCode: saleOnCredit ? data.creditSale?.creditCode : undefined,
          creditBalance: saleOnCredit ? data.creditSale?.balanceGhs : undefined,
          creditPaid: saleOnCredit ? data.creditSale?.amountPaidGhs : undefined,
          trackingCode: data.trackingCode || undefined,
        });
        setCart([]);
        setSaleCustomerName("Walk-in Customer");
        setSaleCustomerPhone("");
        setSaleDiscount(0);
        setSaleDiscountPct(0);
        setSaleNotes("");
        setSaleOnCredit(false);
        setCreditDeposit("");
        setCreditDepositMethod("CASH");
        setCreditDueDate("");
        setTimeout(() => setSaleSuccess(false), 4000);
        onRefreshData();
        refreshSalesDocuments();
      } else {
        setSaleError(data.error || "Sale failed.");
      }
    } catch (err: any) {
      setSaleError(err.message || "Network error during sale.");
    } finally {
      setIsSubmittingSale(false);
    }
  };

  // ─────── Credit installment handlers ───────
  /** Open the credit detail/payment modal — by sale row or by secure code
      (the customer's GM-* tracking code or the staff CRD-* credit code).
      Scoped to the operating branch so cross-branch codes can't be seen. */
  const openCreditSale = async (codeOrId: string | number) => {
    setCreditError("");
    setCreditFlash("");
    setCreditPayAmount("");
    setCreditPayRef("");
    setCreditPayNote("");
    setCreditBusy(true);
    try {
      const q =
        typeof codeOrId === "number"
          ? `businessId=${activeBiz?.id || ""}&includePayments=1`
          : `code=${encodeURIComponent(codeOrId)}&businessId=${activeBiz?.id || ""}&includePayments=1`;
      const res = await fetch(`/api/credit-sales?${q}`);
      const data = await res.json();
      let sale = (data.creditSales || [])[0] || null;
      if (typeof codeOrId === "number") {
        sale = (data.creditSales || []).find((c: any) => c.id === codeOrId) || null;
      }
      if (res.ok && data.success && sale) {
        setCreditModalSale(sale);
      } else {
        setCreditModalSale(null);
        setCreditError(
          data.error ||
            "No credit sale found for that code on this branch. Check the receipt/tracking code."
        );
      }
    } catch (err: any) {
      setCreditModalSale(null);
      setCreditError(err.message || "Lookup failed.");
    } finally {
      setCreditBusy(false);
    }
  };

  const submitCreditPayment = async () => {
    if (!creditModalSale) return;
    const amount = Math.round(Number(creditPayAmount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      setCreditError("Enter an installment amount greater than zero.");
      return;
    }
    if (amount - Number(creditModalSale.balanceGhs) > 0.005) {
      setCreditError(
        `Amount exceeds the outstanding balance of ${formatMoney(creditModalSale.balanceGhs, currentCurrency)}.`
      );
      return;
    }
    setCreditBusy(true);
    setCreditError("");
    try {
      const res = await fetch("/api/credit-sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "pay",
          creditSaleId: creditModalSale.id,
          amount,
          paymentMethod: creditPayMethod,
          reference: creditPayRef || undefined,
          note: creditPayNote || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        const flashMsg = data.settled
          ? `Fully paid! ${creditModalSale.creditCode} is settled.`
          : `Installment recorded · outstanding ${formatMoney(data.creditSale?.balanceGhs ?? 0, currentCurrency)}`;
        setCreditPayAmount("");
        setCreditPayRef("");
        setCreditPayNote("");
        await openCreditSale(creditModalSale.id); // refreshes the modal (clears flash)
        setCreditFlash(flashMsg); // …so set the flash after the refresh
        onRefreshData();
      } else {
        setCreditError(data.error || "Could not record the installment.");
      }
    } catch (err: any) {
      setCreditError(err.message || "Network error while recording payment.");
    } finally {
      setCreditBusy(false);
    }
  };

  const handleProcessReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnAmount || Number(returnAmount) <= 0) return;
    setIsSubmittingReturn(true);

    const payload = {
      businessId: activeBiz?.id,
      type: "EXPENSE",
      category: "Sales Return / Refund",
      amountGhs: Number(returnAmount),
      paymentMethod: "MTN_MOMO",
      description: `RETURN: ${returnReason || "Customer return"} — Original Trx: ${returnTransactionId || "N/A"}`,
      recordedBy: currentUser?.name || "Branch Manager",
    };

    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setReturnSuccess(true);
        setReturnAmount("");
        setReturnReason("");
        setReturnTransactionId("");
        setTimeout(() => setReturnSuccess(false), 3000);
        onRefreshData();
      }
    } catch (err) {
      console.error("Return error:", err);
    } finally {
      setIsSubmittingReturn(false);
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
            businessId: activeBiz?.id,
          },
        }),
      });
      if (res.ok) {
        setNewCustName("");
        setNewCustPhone("+233 24 ");
        setNewCustEmail("");
        setNewCustType("RETAIL");
        onRefreshData();
      }
    } catch (err) {
      console.error("Customer creation error:", err);
    } finally {
      setIsCreatingCustomer(false);
    }
  };

  const hasManyCustomers = branchCustomers.length > 0;

  // ─────── Tab config ───────
  const tabs: { key: SalesTab; label: string; icon: any }[] = [
    { key: "NEW_SALE", label: "New Sale", icon: ShoppingCart },
    { key: "CREDIT", label: "Credit", icon: HandCoins },
    { key: "INVOICES", label: "Invoices", icon: FileText },
    { key: "QUOTATIONS", label: "Quotations", icon: ClipboardEdit },
    { key: "RECEIPTS", label: "Receipts", icon: Receipt },
    { key: "ANALYTICS", label: "Analytics", icon: BarChart3 },
    { key: "FIN_REPORT", label: "Financial Report", icon: Landmark },
    { key: "PAYMENTS", label: "Payments", icon: CreditCard },
    { key: "RETURNS", label: "Returns", icon: RotateCcw },
    { key: "CUSTOMERS", label: "Customers", icon: Users },
    { key: "INVENTORY", label: "Inventory", icon: Package },
  ];

  // ─────── Quick Receipt Modal (Enhanced with company info + issuer) ───────
  const InvoiceModal = ({ info, onClose }: { info: any; onClose: () => void }) => {
    // Build a receipt document for print/download
    const receiptDoc = {
      documentNumber: info.invoiceNo,
      documentType: "RECEIPT",
      branchName: activeBiz?.name || "",
      branchCode: activeBiz?.code || "",
      customerName: info.customer,
      lineItems: [{ description: info.category, quantity: 1, unitPrice: info.amount, total: info.amount }],
      subtotalGhs: info.amount,
      totalGhs: info.amount,
      paymentMethod: info.paymentMethod,
      status: "PAID",
      createdByName: currentUser?.name || "Staff",
      createdByRole: currentUser?.role || "Staff",
      createdAt: new Date().toISOString(),
    };

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center space-x-2">
              <Receipt className="w-5 h-5 text-purple-400" />
              <h3 className="text-lg font-bold text-white">Sale Receipt</h3>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">
              ×
            </button>
          </div>

          <div className="space-y-3 text-sm">
            {/* Company header */}
            <div className="text-center pb-3 border-b border-slate-800">
              <div className="text-base font-extrabold text-white">{COMPANY_INFO.name}</div>
              <div className="text-[10px] text-slate-400">{COMPANY_INFO.tagline}</div>
              <div className="text-[10px] text-slate-500 mt-1">
                {COMPANY_INFO.address}, {COMPANY_INFO.city} | Tel: {COMPANY_INFO.phone}
              </div>
              <div className="text-[10px] text-slate-500">
                Reg: {COMPANY_INFO.registrationNumber} | TIN: {COMPANY_INFO.taxId}
              </div>
            </div>

            {/* Business / Branch */}
            <div className="bg-slate-800/70 rounded-lg p-2.5 text-xs">
              <div className="font-bold text-slate-200">{activeBiz?.name}</div>
              <div className="text-[10px] text-slate-400">{activeBiz?.code} • {activeBiz?.branchLocation}</div>
            </div>

            <div className="flex justify-between text-xs">
              <span className="text-slate-400">Receipt #:</span>
              <span className="font-bold text-purple-300 font-mono">{info.invoiceNo}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">Date & Time:</span>
              <span className="font-bold text-slate-200">{new Date().toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">Customer:</span>
              <span className="font-bold text-slate-200">{info.customer}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">Category:</span>
              <span className="text-slate-300">{info.category}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">Payment:</span>
              <span className="px-2 py-0.5 rounded bg-slate-700 text-slate-200 text-[10px] font-bold">
                {String(info.paymentMethod).replace(/_/g, " ")}
              </span>
            </div>

            <div className="pt-3 mt-2 border-t border-slate-800 flex justify-between text-base">
              <span className="text-slate-200 font-semibold">Total Paid:</span>
              <span className="font-extrabold text-emerald-400">
                {formatMoney(info.amount, currentCurrency)}
              </span>
            </div>

            {/* Issuer */}
            <div className="bg-slate-800/50 rounded-lg p-2.5 text-[11px]">
              <div className="text-slate-400">
                Issued by: <span className="font-bold text-slate-200">{currentUser?.name || "Staff"}</span>
                {" "}(<span className="text-cyan-400">{currentUser?.role || "Staff"}</span>)
              </div>
            </div>

            <p className="text-[10px] text-slate-500 text-center pt-1">
              Thank you for your patronage! <br /> {COMPANY_INFO.name} — {COMPANY_INFO.country}
            </p>
          </div>

          <div className="flex justify-end space-x-2 pt-2 border-t border-slate-800">
            <button
              onClick={() => printSalesDocument({ document: receiptDoc, businessInfo: activeBiz, currency: currentCurrency })}
              className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center space-x-1"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Print</span>
            </button>
            <button
              onClick={async () => {
                const blob = await generateSalesDocumentPDF({ document: receiptDoc, businessInfo: activeBiz, currency: currentCurrency });
                downloadPDFFile(blob, `receipt-${info.invoiceNo}.pdf`);
              }}
              className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center space-x-1"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download PDF</span>
            </button>
            <button
              onClick={onClose}
              className="px-3 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1400px] mx-auto text-slate-100">
      {/* ────── Header ────── */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-5 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-start space-x-3">
          <div className="w-12 h-12 rounded-xl bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center text-emerald-300 shrink-0">
            <TrendingUp className="w-6 h-6" />
          </div>
          <div>
            <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-xs font-bold border border-emerald-500/30">
              {isExecutive ? "EXECUTIVE • SALES CENTER" : "BRANCH MANAGER • SALES CENTER"}
            </span>
            <h2 className="text-xl font-bold text-white mt-0.5">
              {activeBiz?.name || "Branch"} — Sales Dashboard
            </h2>
            <p className="text-xs text-slate-400">
              {isExecutive
                ? "Record sales across any business & branch — all transactions tagged with user, business and location."
                : "Record sales, receive payments, issue invoices, process returns, manage customers & inventory"}
            </p>
          </div>
        </div>

        <div className="flex justify-end">
          <AiSectionGuide moduleKey="SALES_CENTER" section="SALES_CENTER" businessInfo={activeBiz} variant="header" />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-center">
            <div className="text-slate-400">Today's Sales</div>
            <div className="text-sm font-extrabold text-emerald-400">
              {formatMoney(todayIncome, currentCurrency)}
            </div>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-center">
            <div className="text-slate-400">Total Revenue</div>
            <div className="text-sm font-extrabold text-emerald-400">
              {formatMoney(totalSales, currentCurrency, true)}
            </div>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-center">
            <div className="text-slate-400">Transactions</div>
            <div className="text-sm font-extrabold text-white">
              {branchTransactions.filter((t: any) => t.type === "INCOME").length}
            </div>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-center">
            <div className="text-slate-400">Branch Assets</div>
            <div className="text-sm font-extrabold text-purple-300">
              {formatMoney(
                (activeBizMetrics?.assetsValueGhs ?? businessMetrics?.assetsValueGhs) || 0,
                currentCurrency,
                true
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ────── Executive branch selector ────── */}
      {isExecutive && (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <Building2 className="w-4 h-4 text-cyan-400" />
            <span className="font-semibold">Operating Branch:</span>
            <span className="text-slate-400">
              {activeBiz?.region ? `${activeBiz.region}` : ""}
              {activeBiz?.district ? ` · ${activeBiz.district}` : ""}
              {activeBiz?.town ? ` · ${activeBiz.town}` : ""}
            </span>
          </div>
          <select
            value={selectedBizId ?? ""}
            onChange={(e) => setSelectedBizId(Number(e.target.value))}
            data-testid="bm-branch-select"
            className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white focus:outline-none focus:border-emerald-500 max-w-xs"
          >
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.code})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* ────── Sub-navigation tabs ────── */}
      <div className="flex flex-wrap items-center gap-1 bg-slate-800/90 border border-slate-700/80 p-1.5 rounded-xl">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            data-testid={`bm-tab-${tab.key.toLowerCase()}`}
            onClick={() => setActiveSubTab(tab.key)}
            className={`flex items-center space-x-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition ${
              activeSubTab === tab.key
                ? "bg-emerald-600 text-white shadow"
                : "text-slate-300 hover:bg-slate-700/70"
            }`}
          >
            <tab.icon className="w-4 h-4" />
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* ────── Credit Sales dashboard — always-visible branch totals ────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" data-testid="bm-credit-summary">
        <div className="bg-slate-800/90 border border-cyan-500/30 rounded-2xl p-4 shadow-xl" data-testid="bm-credit-card-sales">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Credit Sales</span>
            <HandCoins className="w-4 h-4 text-cyan-300" />
          </div>
          <p className="mt-1 text-xl font-black text-white" data-testid="bm-credit-total-sales">
            {formatMoney(creditTotals.salesGhs, currentCurrency)}
          </p>
          <p className="text-[10px] text-slate-400">
            {creditTotals.count} credit sale{creditTotals.count === 1 ? "" : "s"} · {creditTotals.activeCount} active
          </p>
        </div>
        <div className="bg-slate-800/90 border border-emerald-500/30 rounded-2xl p-4 shadow-xl" data-testid="bm-credit-card-paid">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-300">Amount Paid</span>
            <CheckCircle className="w-4 h-4 text-emerald-300" />
          </div>
          <p className="mt-1 text-xl font-black text-emerald-300" data-testid="bm-credit-total-paid">
            {formatMoney(creditTotals.paidGhs, currentCurrency)}
          </p>
          <p className="text-[10px] text-slate-400">deposits + installments received</p>
        </div>
        <div className="bg-slate-800/90 border border-amber-500/30 rounded-2xl p-4 shadow-xl" data-testid="bm-credit-card-balance">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300">Outstanding Balance</span>
            <DollarSign className="w-4 h-4 text-amber-300" />
          </div>
          <p className="mt-1 text-xl font-black text-amber-300" data-testid="bm-credit-outstanding">
            {formatMoney(creditTotals.outstandingGhs, currentCurrency)}
          </p>
          <p className="text-[10px] text-slate-400">owed by credit customers</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ────── MAIN CONTENT AREA ────── */}
        <div className="lg:col-span-2 space-y-4">

          {/* ~~~~~~~~~~ NEW SALE ~~~~~~~~~~ */}
          {activeSubTab === "NEW_SALE" && (
            <div className="space-y-4">
              {/* Success / Error banners */}
              {saleSuccess && (
                <div className="px-4 py-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-sm font-semibold flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center space-x-2">
                    <CheckCircle className="w-4 h-4" />
                    <span>
                      Sale completed! Receipt #{lastSaleInfo?.invoiceNo || "—"} • Inventory updated
                    </span>
                  </div>
                  {lastSaleInfo?.creditCode && (
                    <span className="text-[11px] text-cyan-200" data-testid="bm-sale-credit-success">
                      Credit {lastSaleInfo.creditCode} · paid {formatMoney(lastSaleInfo.creditPaid || 0, currentCurrency)} · outstanding{" "}
                      {formatMoney(lastSaleInfo.creditBalance || 0, currentCurrency)}
                      {lastSaleInfo.trackingCode ? ` · customer code ${lastSaleInfo.trackingCode}` : ""}
                    </span>
                  )}
                  {lastSaleInfo && (
                    <button onClick={() => setShowInvoiceModal(true)} className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold">
                      View Receipt
                    </button>
                  )}
                </div>
              )}
              {saleError && (
                <div className="px-4 py-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs">
                  {saleError}
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
                      <option value="ALL">All Categories</option>
                      {inventoryCategories.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <input type="text" value={inventorySearch} onChange={(e) => setInventorySearch(e.target.value)} placeholder="Search products…" className="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-[10px] text-white w-32" />
                  </div>
                </div>

                {filteredProducts.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-52 overflow-y-auto pr-1">
                    {filteredProducts.map((inv: any) => {
                      const inCart = cart.find((c) => c.inventoryId === inv.id);
                      return (
                        <button
                          key={inv.id}
                          type="button"
                          onClick={() => addToCart(inv)}
                          disabled={inv.quantity <= 0}
                          className={`flex items-center justify-between p-2.5 rounded-lg border text-left transition text-xs ${
                            inCart ? "bg-emerald-500/10 border-emerald-500/40" : "bg-slate-900/60 border-slate-700 hover:border-slate-500"
                          } disabled:opacity-40`}
                        >
                          <div className="min-w-0 flex-1 mr-2">
                            <div className="font-bold text-slate-100 truncate">{inv.name}</div>
                            <div className="text-[10px] text-slate-400 flex items-center gap-2 mt-0.5">
                              <span className="font-mono text-cyan-400">{inv.sku}</span>
                              <span>•</span>
                              <span>{inv.category}</span>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="font-bold text-emerald-400">{formatMoney(inv.sellingPriceGhs, currentCurrency)}</div>
                            <div className="text-[10px] text-slate-400">{inv.quantity} {inv.unit} avail</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-center py-6 text-xs text-slate-400">
                    {branchInventory.length === 0 ? "No inventory registered for this branch." : "No products match your filter — or all items are out of stock."}
                  </div>
                )}
              </div>

              {/* ── Cart / Order ── */}
              <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow-xl">
                <div className="flex items-center gap-2 pb-3 border-b border-slate-700/70 mb-3">
                  <ShoppingCart className="w-5 h-5 text-emerald-400" />
                  <h3 className="text-sm font-bold text-white">Order Cart</h3>
                  <span className="text-[10px] text-slate-400">{cart.length} items</span>
                </div>

                {cart.length > 0 ? (
                  <div className="space-y-2">
                    {cart.map((item) => (
                      <div key={item.inventoryId} className="p-3 rounded-lg border border-slate-700 bg-slate-900/60 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="min-w-0 flex-1 mr-2">
                            <div className="text-xs font-bold text-slate-100 truncate">{item.name}</div>
                            <div className="text-[10px] text-slate-400">{item.sku} • {item.category} • {item.availableQty} {item.unit} in stock</div>
                          </div>
                          <button type="button" onClick={() => removeFromCart(item.inventoryId)} className="p-1 rounded hover:bg-rose-500/20 text-rose-400 shrink-0">
                            <X className="w-4 h-4" />
                          </button>
                        </div>

                        <div className="grid grid-cols-3 gap-2">
                          {/* Quantity */}
                          <div>
                            <label className="block text-[10px] text-slate-500 mb-0.5">Qty (max {item.availableQty})</label>
                            <input type="number" min={1} max={item.availableQty} value={item.quantity} onChange={(e) => updateCartQty(item.inventoryId, Number(e.target.value))} className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-white text-xs text-center" />
                          </div>
                          {/* Unit Price */}
                          <div>
                            <label className="block text-[10px] text-slate-500 mb-0.5">
                              Price (GH₵) {item.isCustomPrice && <span className="text-amber-400">*custom</span>}
                            </label>
                            <input
                              type="number" min={0} step="0.01"
                              value={item.sellingPrice}
                              onChange={(e) => {
                                if (!canOverridePrice && Number(e.target.value) !== item.originalPrice) {
                                  setSaleError("Only Owner or General Manager can override product prices.");
                                  return;
                                }
                                updateCartPrice(item.inventoryId, Number(e.target.value));
                              }}
                              className={`w-full px-2 py-1.5 bg-slate-800 border rounded text-white text-xs text-right ${
                                item.isCustomPrice ? "border-amber-500/60" : "border-slate-700"
                              }`}
                            />
                          </div>
                          {/* Line total */}
                          <div>
                            <label className="block text-[10px] text-slate-500 mb-0.5">Total</label>
                            <div className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-emerald-400 text-xs font-bold text-right">
                              {formatMoney(item.sellingPrice * item.quantity, currentCurrency)}
                            </div>
                          </div>
                        </div>

                        {/* Custom price reason (audit) */}
                        {item.isCustomPrice && (
                          <div>
                            <label className="block text-[10px] text-amber-300 mb-0.5">
                              Reason for price change (original: {formatMoney(item.originalPrice, currentCurrency)})
                            </label>
                            <input type="text" value={item.customPriceReason} onChange={(e) => updateCartPriceReason(item.inventoryId, e.target.value)} placeholder="e.g. Bulk discount approved by manager" className="w-full px-2 py-1 bg-slate-800 border border-amber-500/40 rounded text-white text-[11px]" />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-6 text-xs text-slate-400">
                    Click a product above to add it to the cart.
                  </div>
                )}
              </div>

              {/* ── Sale details + Submit ── */}
              {cart.length > 0 && (
                <form onSubmit={handleRecordSale} className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow-xl space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-400 mb-1">Customer Name</label>
                      <input type="text" value={saleCustomerName} onChange={(e) => setSaleCustomerName(e.target.value)} className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-400 mb-1">Customer Phone</label>
                      <input type="text" value={saleCustomerPhone} onChange={(e) => setSaleCustomerPhone(e.target.value)} placeholder="+233 24 …" className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs" />
                    </div>
                  </div>
                  {/* ── Settlement mode: paid in full vs Credit Sale ── */}
                  <div className="flex items-center gap-2" data-testid="bm-sale-settlement">
                    <span className="text-[10px] font-semibold text-slate-400">Settlement:</span>
                    <button
                      type="button"
                      onClick={() => setSaleOnCredit(false)}
                      data-testid="bm-sale-mode-paid"
                      className={`px-3 py-1.5 rounded-lg text-[11px] font-bold border transition ${
                        !saleOnCredit
                          ? "bg-emerald-600 border-emerald-500 text-white"
                          : "bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800"
                      }`}
                    >
                      Paid in full
                    </button>
                    <button
                      type="button"
                      onClick={() => setSaleOnCredit(true)}
                      data-testid="bm-sale-mode-credit"
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition ${
                        saleOnCredit
                          ? "bg-cyan-600 border-cyan-500 text-white"
                          : "bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800"
                      }`}
                    >
                      <HandCoins className="w-3.5 h-3.5" /> Credit Sale (installments)
                    </button>
                  </div>

                  {saleOnCredit && (
                    <div className="bg-cyan-500/5 border border-cyan-500/25 rounded-xl p-3 space-y-3" data-testid="bm-sale-credit-fields">
                      <p className="text-[10px] text-cyan-200/90 font-semibold">
                        Credit sale — the customer takes the goods now and pays in installments against their
                        secure order/tracking code until fully paid.
                      </p>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-400 mb-1">Deposit now (GH₵, optional)</label>
                          <input type="number" min={0} step="0.01" value={creditDeposit} onChange={(e) => setCreditDeposit(e.target.value)} data-testid="bm-credit-deposit" placeholder="0.00" className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs" />
                        </div>
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-400 mb-1">Deposit method</label>
                          <select value={creditDepositMethod} onChange={(e) => setCreditDepositMethod(e.target.value)} data-testid="bm-credit-deposit-method" className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs">
                            <option value="CASH">Cash</option>
                            <option value="MTN_MOMO">MTN Mobile Money</option>
                            <option value="TELECEL_CASH">Telecel Cash</option>
                            <option value="BANK_TRANSFER">Bank Transfer</option>
                            <option value="POS_CARD">POS Card</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-400 mb-1">Agreed due date (optional)</label>
                          <input type="date" value={creditDueDate} onChange={(e) => setCreditDueDate(e.target.value)} data-testid="bm-credit-duedate" className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs" />
                        </div>
                        <div className="flex items-end">
                          <p className="text-[10px] text-slate-400 pb-2" data-testid="bm-credit-preview">
                            {creditDeposit && Number(creditDeposit) > 0
                              ? `Balance after deposit: ${formatMoney(Math.max(0, cartTotal - (Number(creditDeposit) || 0)), currentCurrency)}`
                              : `Full ${formatMoney(cartTotal, currentCurrency)} goes on credit.`}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    {!saleOnCredit && (
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-400 mb-1">Payment Method</label>
                      <select value={salePaymentMethod} onChange={(e) => setSalePaymentMethod(e.target.value)} className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs">
                        <option value="MTN_MOMO">MTN Mobile Money</option>
                        <option value="TELECEL_CASH">Telecel Cash</option>
                        <option value="CASH">Cash</option>
                        <option value="BANK_TRANSFER">Bank Transfer</option>
                        <option value="POS_CARD">POS Card</option>
                      </select>
                    </div>
                    )}
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-400 mb-1">Discount %</label>
                      <input type="number" min={0} max={100} step="0.5" value={saleDiscountPct} data-testid="bm-sale-discount-pct" onChange={(e) => {
                        const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                        setSaleDiscountPct(pct);
                        if (pct > 0) setSaleDiscount(Math.round(((cartSubtotal * pct) / 100) * 100) / 100);
                      }} className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-400 mb-1">Discount (GH₵)</label>
                      <input type="number" min={0} step="0.01" value={cartDiscountAmount} data-testid="bm-sale-discount-amt" onChange={(e) => {
                        const amt = Math.max(0, Number(e.target.value) || 0);
                        setSaleDiscount(amt);
                        setSaleDiscountPct(cartSubtotal > 0 ? Math.round((amt / cartSubtotal) * 10000) / 100 : 0);
                      }} className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1">Notes</label>
                    <input type="text" value={saleNotes} onChange={(e) => setSaleNotes(e.target.value)} placeholder="Optional sale notes" className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs" />
                  </div>

                  {/* Live totals */}
                  <div className="bg-slate-900 rounded-xl p-3 space-y-1 text-xs border border-slate-700">
                    <div className="flex justify-between text-slate-400">
                      <span>Subtotal ({cart.length} items):</span>
                      <span>{formatMoney(cartSubtotal, currentCurrency)}</span>
                    </div>
                    {cartDiscountAmount > 0 && (
                      <div className="flex justify-between text-rose-300" data-testid="bm-sale-discount-line">
                        <span>Discount{saleDiscountPct > 0 ? ` (${saleDiscountPct}%)` : ""}:</span>
                        <span>- {formatMoney(cartDiscountAmount, currentCurrency)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-lg font-bold text-emerald-400 pt-2 border-t border-slate-700">
                      <span>Total:</span>
                      <span>{formatMoney(cartTotal, currentCurrency)}</span>
                    </div>
                  </div>

                  <button type="submit" data-testid="bm-sale-submit" disabled={isSubmittingSale || cart.length === 0} className={`w-full py-2.5 rounded-xl ${saleOnCredit ? "bg-cyan-600 hover:bg-cyan-500" : "bg-emerald-600 hover:bg-emerald-500"} text-white font-bold text-sm shadow-lg transition disabled:opacity-50 flex items-center justify-center gap-2`}>
                    {saleOnCredit ? <HandCoins className="w-4 h-4" /> : <CreditCard className="w-4 h-4" />}
                    <span>
                      {isSubmittingSale
                        ? saleOnCredit
                          ? "Opening credit sale…"
                          : "Processing sale…"
                        : saleOnCredit
                        ? `Create Credit Sale — ${formatMoney(cartTotal, currentCurrency)} on credit`
                        : `Complete Sale — ${formatMoney(cartTotal, currentCurrency)}`}
                    </span>
                  </button>
                </form>
              )}
            </div>
          )}

          {/* ~~~~~~~~~~ CREDIT SALES ~~~~~~~~~~ */}
          {activeSubTab === "CREDIT" && (
            <div className="space-y-4">
              <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl shadow-xl overflow-hidden" data-testid="bm-credit-register">
                <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-2">
                    <HandCoins className="w-5 h-5 text-cyan-400" />
                    <h3 className="text-sm font-bold text-white">Credit Sales Register</h3>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                      {creditTotals.activeCount} active · {creditTotals.count} total
                    </span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <input
                      type="text"
                      value={creditLookupCode}
                      onChange={(e) => setCreditLookupCode(e.target.value)}
                      placeholder="GM-… or CRD-… code"
                      data-testid="bm-credit-lookup"
                      className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-[11px] text-white w-40"
                      onKeyDown={(e) => { if (e.key === "Enter" && creditLookupCode.trim()) openCreditSale(creditLookupCode.trim()); }}
                    />
                    <button
                      type="button"
                      onClick={() => creditLookupCode.trim() && openCreditSale(creditLookupCode.trim())}
                      disabled={creditBusy}
                      data-testid="bm-credit-lookup-btn"
                      className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-bold disabled:opacity-50"
                    >
                      Find & collect
                    </button>
                    <input
                      type="text"
                      value={creditSearch}
                      onChange={(e) => setCreditSearch(e.target.value)}
                      placeholder="Search register…"
                      data-testid="bm-credit-search"
                      className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-[11px] text-white w-36"
                    />
                  </div>
                </div>

                {creditError && !creditModalSale && (
                  <div className="mx-5 mt-4 px-4 py-2.5 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs" data-testid="bm-credit-lookup-error">
                    {creditError}
                  </div>
                )}

                <div className="divide-y divide-slate-700/60">
                  {branchCreditSales.filter((cs: any) => {
                    const q = creditSearch.trim().toLowerCase();
                    if (!q) return true;
                    return (
                      cs.creditCode.toLowerCase().includes(q) ||
                      (cs.trackingCode || "").toLowerCase().includes(q) ||
                      (cs.customerName || "").toLowerCase().includes(q) ||
                      (cs.customerPhone || "").toLowerCase().includes(q)
                    );
                  }).length === 0 ? (
                    <p className="px-5 py-8 text-center text-xs text-slate-400" data-testid="bm-credit-empty">
                      {creditTotals.count === 0
                        ? "No credit sales yet on this branch — toggle “Credit Sale” in New Sale to open one."
                        : "Nothing matches that search on this branch."}
                    </p>
                  ) : (
                    branchCreditSales
                      .filter((cs: any) => {
                        const q = creditSearch.trim().toLowerCase();
                        if (!q) return true;
                        return (
                          cs.creditCode.toLowerCase().includes(q) ||
                          (cs.trackingCode || "").toLowerCase().includes(q) ||
                          (cs.customerName || "").toLowerCase().includes(q) ||
                          (cs.customerPhone || "").toLowerCase().includes(q)
                        );
                      })
                      .map((cs: any) => (
                        <div key={cs.id} className="px-5 py-3.5 flex items-center gap-3 flex-wrap" data-testid={`bm-credit-row-${cs.id}`}>
                          <span className={`text-[9px] font-black px-2 py-1 rounded border shrink-0 ${
                            cs.status === "PAID"
                              ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
                              : "bg-cyan-500/15 text-cyan-300 border-cyan-500/40"
                          }`}>
                            {cs.status === "PAID" ? "PAID" : "ACTIVE"}
                          </span>
                          <div className="min-w-[160px] flex-1">
                            <p className="text-xs font-bold text-white">{cs.customerName}</p>
                            <p className="text-[10px] text-slate-400 font-mono">
                              {cs.creditCode} · order {cs.trackingCode || "—"}
                            </p>
                          </div>
                          <div className="text-right text-[11px] leading-4">
                            <p className="text-slate-300">Total <span className="font-bold text-white">{formatMoney(cs.totalGhs, currentCurrency)}</span></p>
                            <p className="text-emerald-300">Paid {formatMoney(cs.amountPaidGhs, currentCurrency)}</p>
                            <p className="text-amber-300 font-bold" data-testid={`bm-credit-balance-${cs.id}`}>
                              Balance {formatMoney(cs.balanceGhs, currentCurrency)}
                            </p>
                          </div>
                          <div className="text-[10px] text-slate-500 text-right leading-4 hidden md:block">
                            <p>{cs.dueDate ? `Due ${cs.dueDate}` : "No due date"}</p>
                            <p>{cs.createdAt ? new Date(cs.createdAt).toLocaleDateString() : ""}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => openCreditSale(cs.id)}
                            data-testid={`bm-credit-pay-${cs.id}`}
                            className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-[10px] font-bold"
                          >
                            {cs.status === "PAID" ? "View" : "Collect"}
                          </button>
                        </div>
                      ))
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ~~~~~~~~~~ INVOICES ~~~~~~~~~~ */}
          {activeSubTab === "INVOICES" && (
            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl">
              <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center space-x-2">
                  <FileText className="w-5 h-5 text-emerald-400" />
                  <h3 className="text-base font-bold text-white">Invoices Management</h3>
                  <span className="ml-2 text-xs text-slate-400">{branchInvoices.length} total</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={docSearchTerm}
                    onChange={(e) => setDocSearchTerm(e.target.value)}
                    placeholder="Search invoices..."
                    className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white w-48"
                  />
                  <button
                    onClick={() => setShowBuilder("INVOICE")}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow"
                  >
                    <Plus className="w-3.5 h-3.5" /> New Invoice
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px] tracking-wider">
                    <tr>
                      <th className="px-4 py-3">Invoice #</th>
                      <th className="px-4 py-3">Customer</th>
                      <th className="px-4 py-3">Issued</th>
                      <th className="px-4 py-3">Due Date</th>
                      <th className="px-4 py-3 text-right">Total</th>
                      <th className="px-4 py-3 text-center">Status</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/60">
                    {filterDocs(branchInvoices).map((doc: any) => (
                      <tr key={doc.id} className="hover:bg-slate-700/40">
                        <td className="px-4 py-3 font-mono text-emerald-400 font-bold">
                          {doc.documentNumber}
                        </td>
                        <td className="px-4 py-3 text-slate-200">
                          <div>{doc.customerName}</div>
                          {doc.customerPhone && (
                            <div className="text-[10px] text-slate-500">{doc.customerPhone}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-400">
                          {new Date(doc.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-slate-400">{doc.dueDate || "—"}</td>
                        <td className="px-4 py-3 text-right font-extrabold text-emerald-400">
                          {formatMoney(doc.totalGhs, currentCurrency)}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              doc.status === "PAID"
                                ? "bg-emerald-500/20 text-emerald-300"
                                : doc.status === "SENT"
                                ? "bg-amber-500/20 text-amber-300"
                                : doc.status === "CANCELLED"
                                ? "bg-rose-500/20 text-rose-300"
                                : "bg-slate-700 text-slate-300"
                            }`}
                          >
                            {doc.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex justify-end gap-1">
                            <button
                              onClick={() => handleViewDoc(doc)}
                              className="p-1 rounded hover:bg-cyan-500/20 text-cyan-300"
                              title="View"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handlePrintDoc(doc)}
                              className="p-1 rounded hover:bg-blue-500/20 text-blue-300"
                              title="Print"
                            >
                              <Printer className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleDownloadDoc(doc)}
                              className="p-1 rounded hover:bg-emerald-500/20 text-emerald-300"
                              title="Download PDF"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </button>
                            {doc.status !== "PAID" && doc.status !== "CANCELLED" && (
                              <button
                                onClick={() => handleMarkPaid(doc)}
                                disabled={docActionBusy === doc.id}
                                className="p-1 rounded hover:bg-emerald-500/20 text-emerald-400"
                                title="Mark as Paid"
                              >
                                <CheckCircle className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filterDocs(branchInvoices).length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-10 text-center text-slate-400 text-sm">
                          No invoices yet. Click "New Invoice" to create one.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ~~~~~~~~~~ QUOTATIONS ~~~~~~~~~~ */}
          {activeSubTab === "QUOTATIONS" && (
            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl">
              <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center space-x-2">
                  <ClipboardEdit className="w-5 h-5 text-blue-400" />
                  <h3 className="text-base font-bold text-white">Quotations Management</h3>
                  <span className="ml-2 text-xs text-slate-400">{branchQuotations.length} total</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={docSearchTerm}
                    onChange={(e) => setDocSearchTerm(e.target.value)}
                    placeholder="Search quotations..."
                    className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white w-48"
                  />
                  <button
                    onClick={() => setShowBuilder("QUOTATION")}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold shadow"
                  >
                    <Plus className="w-3.5 h-3.5" /> New Quotation
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px] tracking-wider">
                    <tr>
                      <th className="px-4 py-3">Quotation #</th>
                      <th className="px-4 py-3">Customer</th>
                      <th className="px-4 py-3">Issued</th>
                      <th className="px-4 py-3">Valid Until</th>
                      <th className="px-4 py-3 text-right">Total</th>
                      <th className="px-4 py-3 text-center">Status</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/60">
                    {filterDocs(branchQuotations).map((doc: any) => (
                      <tr key={doc.id} className="hover:bg-slate-700/40">
                        <td className="px-4 py-3 font-mono text-blue-400 font-bold">
                          {doc.documentNumber}
                        </td>
                        <td className="px-4 py-3 text-slate-200">
                          <div>{doc.customerName}</div>
                          {doc.customerPhone && (
                            <div className="text-[10px] text-slate-500">{doc.customerPhone}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-400">
                          {new Date(doc.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-slate-400">{doc.validUntil || "—"}</td>
                        <td className="px-4 py-3 text-right font-extrabold text-blue-400">
                          {formatMoney(doc.totalGhs, currentCurrency)}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              doc.status === "ACCEPTED"
                                ? "bg-emerald-500/20 text-emerald-300"
                                : doc.status === "CONVERTED"
                                ? "bg-purple-500/20 text-purple-300"
                                : doc.status === "REJECTED" || doc.status === "EXPIRED"
                                ? "bg-rose-500/20 text-rose-300"
                                : "bg-amber-500/20 text-amber-300"
                            }`}
                          >
                            {doc.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex justify-end gap-1">
                            <button
                              onClick={() => handleViewDoc(doc)}
                              className="p-1 rounded hover:bg-cyan-500/20 text-cyan-300"
                              title="View"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handlePrintDoc(doc)}
                              className="p-1 rounded hover:bg-blue-500/20 text-blue-300"
                              title="Print"
                            >
                              <Printer className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleDownloadDoc(doc)}
                              className="p-1 rounded hover:bg-emerald-500/20 text-emerald-300"
                              title="Download PDF"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </button>
                            {doc.status !== "CONVERTED" && (
                              <button
                                onClick={() => handleConvertQuotation(doc)}
                                disabled={docActionBusy === doc.id}
                                className="p-1 rounded hover:bg-purple-500/20 text-purple-300"
                                title="Convert to Invoice"
                              >
                                <Repeat className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filterDocs(branchQuotations).length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-10 text-center text-slate-400 text-sm">
                          No quotations yet. Click "New Quotation" to create one.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ~~~~~~~~~~ ANALYTICS ~~~~~~~~~~ */}
          {activeSubTab === "ANALYTICS" && (
            <div className="space-y-5">
              {/* KPI cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl">
                  <div className="text-[10px] text-slate-400 uppercase font-semibold">Total Revenue</div>
                  <div className="text-lg font-black text-emerald-400 mt-1">
                    {formatMoney(totalSales, currentCurrency)}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1">
                    {branchTransactions.filter((t: any) => t.type === "INCOME").length} sales
                  </div>
                </div>
                <div className="bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl">
                  <div className="text-[10px] text-slate-400 uppercase font-semibold">Invoices Issued</div>
                  <div className="text-lg font-black text-white mt-1">{branchInvoices.length}</div>
                  <div className="text-[10px] text-slate-500 mt-1">
                    {branchInvoices.filter((i: any) => i.status === "PAID").length} paid
                  </div>
                </div>
                <div className="bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl">
                  <div className="text-[10px] text-slate-400 uppercase font-semibold">Quotations Sent</div>
                  <div className="text-lg font-black text-blue-400 mt-1">{branchQuotations.length}</div>
                  <div className="text-[10px] text-slate-500 mt-1">
                    {branchQuotations.filter((q: any) => q.status === "CONVERTED").length} converted
                  </div>
                </div>
                <div className="bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl">
                  <div className="text-[10px] text-slate-400 uppercase font-semibold">Outstanding</div>
                  <div className="text-lg font-black text-amber-400 mt-1">
                    {formatMoney(
                      branchInvoices
                        .filter((i: any) => i.status !== "PAID" && i.status !== "CANCELLED")
                        .reduce((a: number, i: any) => a + (i.totalGhs || 0), 0),
                      currentCurrency
                    )}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1">Pending invoices</div>
                </div>
              </div>

              {/* Daily sales chart */}
              <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5">
                <div className="flex items-center gap-2 mb-4">
                  <BarChart3 className="w-5 h-5 text-emerald-400" />
                  <h3 className="text-base font-bold text-white">Sales by Date</h3>
                </div>
                {analyticsDailySales.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={analyticsDailySales}>
                      <XAxis dataKey="date" stroke="#94a3b8" style={{ fontSize: 10 }} />
                      <YAxis stroke="#94a3b8" style={{ fontSize: 10 }} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }}
                        formatter={(v: any) => formatMoney(Number(v), currentCurrency)}
                      />
                      <Bar dataKey="amount" fill="#10b981" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-xs text-slate-400 text-center py-6">No sales data yet.</p>
                )}
              </div>

              {/* Payment breakdown + Top customers */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <CreditCard className="w-5 h-5 text-cyan-400" />
                    <h3 className="text-sm font-bold text-white">Payment Method Split</h3>
                  </div>
                  {analyticsPaymentMethods.length > 0 ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <PieChart>
                        <Pie
                          data={analyticsPaymentMethods}
                          dataKey="amount"
                          nameKey="method"
                          cx="50%"
                          cy="50%"
                          outerRadius={70}
                          label={(entry: any) => entry.method}
                        >
                          {analyticsPaymentMethods.map((_, i) => (
                            <Cell
                              key={i}
                              fill={
                                ["#10b981", "#3b82f6", "#f59e0b", "#a855f7", "#ec4899"][i % 5]
                              }
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155" }}
                          formatter={(v: any) => formatMoney(Number(v), currentCurrency)}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <p className="text-xs text-slate-400 text-center py-6">No payment data.</p>
                  )}
                </div>

                <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <Users className="w-5 h-5 text-amber-400" />
                    <h3 className="text-sm font-bold text-white">Top Customers by Invoice Value</h3>
                  </div>
                  {analyticsTopCustomers.length > 0 ? (
                    <div className="space-y-2">
                      {analyticsTopCustomers.map((c, i) => (
                        <div
                          key={c.customer}
                          className="flex items-center justify-between p-2 bg-slate-900/60 rounded-lg"
                        >
                          <div>
                            <div className="text-xs font-bold text-slate-200">
                              #{i + 1} {c.customer}
                            </div>
                          </div>
                          <div className="text-sm font-bold text-emerald-400">
                            {formatMoney(c.total, currentCurrency)}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400 text-center py-6">No customer invoices yet.</p>
                  )}
                </div>
              </div>

              {/* Invoice status distribution */}
              {analyticsDocStatus.length > 0 && (
                <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <FileText className="w-5 h-5 text-purple-400" />
                    <h3 className="text-sm font-bold text-white">Invoice Status Distribution</h3>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {analyticsDocStatus.map((s) => (
                      <div key={s.status} className="p-3 bg-slate-900/60 rounded-lg text-center">
                        <div className="text-2xl font-black text-white">{s.count}</div>
                        <div className="text-[10px] text-slate-400 uppercase">{s.status}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ~~~~~~~~~~ FINANCIAL REPORT (complete, live-linked) ~~~~~~~~~~ */}
          {activeSubTab === "FIN_REPORT" && (
            <FinancialReportSection
              mode="business"
              businessInfo={activeBiz}
              businessMetric={activeBizMetrics}
              transactions={transactions}
              inventory={inventory}
              customers={customers}
              salesDocuments={salesDocuments}
              currentCurrency={currentCurrency}
              accent="emerald"
              testid="fin-report-branch"
              aiModuleKey="SALES_CENTER"
              opsLinks={[
                {
                  label: "Invoices issued",
                  value: String(branchInvoices.length),
                  note: `${branchInvoices.filter((i: any) => i.status === "PAID").length} fully paid`,
                  tone: "emerald",
                },
                {
                  label: "Quotations open",
                  value: String(branchQuotations.filter((q: any) => !["CONVERTED", "REJECTED", "EXPIRED"].includes(q.status)).length),
                  tone: "sky",
                },
              ]}
            />
          )}

          {/* ~~~~~~~~~~ PAYMENTS ~~~~~~~~~~ */}
          {activeSubTab === "PAYMENTS" && (
            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl">
              <div className="flex items-center space-x-2 pb-4 border-b border-slate-700/70">
                <CreditCard className="w-5 h-5 text-emerald-400" />
                <h3 className="text-base font-bold text-white">Payment Method Breakdown</h3>
              </div>

              {(() => {
                const methods = ["MTN_MOMO", "TELECEL_CASH", "CASH", "BANK_TRANSFER", "POS_CARD"];
                const paymentData = methods.map((m) => ({
                  method: m,
                  total: branchTransactions
                    .filter((t: any) => t.type === "INCOME" && t.paymentMethod === m)
                    .reduce((acc: number, t: any) => acc + (t.amountGhs || 0), 0),
                  count: branchTransactions.filter(
                    (t: any) => t.type === "INCOME" && t.paymentMethod === m
                  ).length,
                })).filter((p) => p.count > 0);

                if (paymentData.length === 0) {
                  return <p className="text-sm text-slate-400 py-6 text-center">No payments recorded yet.</p>;
                }

                return (
                  <div className="space-y-3 mt-4">
                    {paymentData.map((p) => {
                      const pct = totalSales > 0 ? ((p.total / totalSales) * 100).toFixed(1) : "0";
                      return (
                        <div
                          key={p.method}
                          className="bg-slate-900/60 border border-slate-700/60 rounded-xl p-4"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <div>
                              <span className="px-2 py-0.5 rounded bg-slate-700 text-slate-200 text-[10px] font-bold">
                                {p.method}
                              </span>
                              <span className="text-xs text-slate-400 ml-2">
                                {p.count} transaction{p.count !== 1 ? "s" : ""}
                              </span>
                            </div>
                            <span className="text-sm font-extrabold text-emerald-400">
                              {formatMoney(p.total, currentCurrency)}
                            </span>
                          </div>
                          <div className="w-full bg-slate-700 rounded-full h-2 overflow-hidden">
                            <div
                              className="bg-emerald-500 h-2 rounded-full transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <div className="text-right text-[10px] text-slate-400 mt-1">
                            {pct}% of total sales
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          {/* ~~~~~~~~~~ RECEIPTS ~~~~~~~~~~ */}
          {activeSubTab === "RECEIPTS" && (
            <div className="space-y-4">
              {/* Profit summary — revenue vs cost of goods sold across stock sales */}
              {branchReceipts.length > 0 && (() => {
                const rev = branchReceipts.reduce((s: number, d: any) => s + (d.totalGhs || 0), 0);
                const cogs = branchReceipts.reduce((s: number, d: any) => s + (d.cogsGhs || 0), 0);
                const profit = branchReceipts.reduce((s: number, d: any) => s + (d.grossProfitGhs || 0), 0);
                const margin = rev > 0 ? (profit / rev) * 100 : 0;
                const Cell = ({ label, value, color }: any) => (
                  <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow-xl">
                    <div className="text-[10px] uppercase font-bold text-slate-400">{label}</div>
                    <div className={`text-xl font-black mt-1 ${color}`}>{value}</div>
                  </div>
                );
                return (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="sales-profit-summary">
                    <Cell label="Stock-Sale Revenue" value={formatMoney(rev, currentCurrency, true)} color="text-emerald-400" />
                    <Cell label="Cost of Goods (COGS)" value={formatMoney(cogs, currentCurrency, true)} color="text-amber-400" />
                    <Cell label="Gross Profit" value={formatMoney(profit, currentCurrency, true)} color="text-cyan-400" />
                    <Cell label="Avg Margin" value={`${margin.toFixed(1)}%`} color="text-purple-400" />
                  </div>
                );
              })()}
              {/* Saved receipt documents (from sales_documents table) */}
              {branchReceipts.length > 0 && (
                <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl">
                  <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <Receipt className="w-5 h-5 text-purple-400" />
                      <h3 className="text-base font-bold text-white">Saved Receipt Documents</h3>
                      <span className="ml-2 text-xs text-slate-400">{branchReceipts.length} total</span>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px] tracking-wider">
                        <tr>
                          <th className="px-4 py-3">Receipt #</th>
                          <th className="px-4 py-3">Customer</th>
                          <th className="px-4 py-3">Payment</th>
                          <th className="px-4 py-3 text-right">Total</th>
                          <th className="px-4 py-3">Date</th>
                          <th className="px-4 py-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-700/60">
                        {branchReceipts.map((doc: any) => (
                          <tr key={doc.id} className="hover:bg-slate-700/40">
                            <td className="px-4 py-3 font-mono text-purple-400 font-bold">
                              {doc.documentNumber}
                            </td>
                            <td className="px-4 py-3 text-slate-200">{doc.customerName}</td>
                            <td className="px-4 py-3">
                              <span className="px-2 py-0.5 rounded bg-slate-700 text-slate-200 text-[10px] font-bold">
                                {doc.paymentMethod || "N/A"}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right font-extrabold text-emerald-400">
                              {formatMoney(doc.totalGhs, currentCurrency)}
                            </td>
                            <td className="px-4 py-3 text-slate-400">
                              {new Date(doc.createdAt).toLocaleDateString()}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex justify-end gap-1">
                                <button
                                  onClick={() => handleViewDoc(doc)}
                                  className="p-1 rounded hover:bg-cyan-500/20 text-cyan-300"
                                  title="View"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handlePrintDoc(doc)}
                                  className="p-1 rounded hover:bg-blue-500/20 text-blue-300"
                                  title="Print"
                                >
                                  <Printer className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handleDownloadDoc(doc)}
                                  className="p-1 rounded hover:bg-emerald-500/20 text-emerald-300"
                                  title="Download PDF"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Sales transaction history */}
              <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl">
                <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <FileText className="w-5 h-5 text-emerald-400" />
                    <h3 className="text-base font-bold text-white">Sales Transaction History</h3>
                  </div>
                  <span className="text-xs text-slate-400">
                    Latest {recentSales.length} of{" "}
                    {branchTransactions.filter((t: any) => t.type === "INCOME").length}
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs sm:text-sm">
                    <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[11px] tracking-wider">
                      <tr>
                        <th className="px-4 py-3">Invoice / Trx #</th>
                        <th className="px-4 py-3">Category</th>
                        <th className="px-4 py-3">Customer / Description</th>
                        <th className="px-4 py-3">Payment</th>
                        <th className="px-4 py-3 text-right">Amount</th>
                        <th className="px-4 py-3">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/60">
                      {recentSales.map((t: any) => {
                        const invMatch = t.description?.match(/\[INV:([^\]]+)\]/);
                        const invDisplay = invMatch ? invMatch[1] : t.transactionNumber;
                        const descClean = t.description?.replace(/\[INV:[^\]]+\]\s*/, "") || t.description;

                        return (
                          <tr key={t.id} className="hover:bg-slate-700/40">
                            <td className="px-4 py-3.5 font-mono text-xs text-emerald-400">
                              {invDisplay}
                            </td>
                            <td className="px-4 py-3.5 text-slate-300 font-semibold">{t.category}</td>
                            <td className="px-4 py-3.5 text-slate-300 max-w-[200px] truncate">
                              {descClean}
                            </td>
                            <td className="px-4 py-3.5">
                              <span className="px-2 py-0.5 rounded bg-slate-700 text-slate-200 text-[10px] font-bold">
                                {t.paymentMethod}
                              </span>
                            </td>
                            <td className="px-4 py-3.5 text-right font-extrabold text-emerald-400">
                              {formatMoney(t.amountGhs, currentCurrency)}
                            </td>
                            <td className="px-4 py-3.5 text-slate-400 text-xs">{t.date}</td>
                          </tr>
                        );
                      })}

                      {recentSales.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                            <FileText className="w-8 h-8 text-slate-500 mx-auto mb-2" />
                            <p className="text-sm">No sales transactions yet.</p>
                            <p className="text-xs">Complete a sale to generate your first invoice.</p>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ~~~~~~~~~~ RETURNS & REFUNDS ~~~~~~~~~~ */}
          {activeSubTab === "RETURNS" && (
            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl space-y-4">
              <div className="flex items-center space-x-2 pb-3 border-b border-slate-700/70">
                <RotateCcw className="w-5 h-5 text-amber-400" />
                <h3 className="text-base font-bold text-white">Process Return / Refund</h3>
              </div>

              {returnSuccess && (
                <div className="px-4 py-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-sm font-semibold flex items-center space-x-2">
                  <CheckCircle className="w-4 h-4" />
                  <span>Return processed successfully!</span>
                </div>
              )}

              <form onSubmit={handleProcessReturn} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Refund Amount ({currentCurrency}) *
                    </label>
                    <input
                      type="number"
                      required
                      step="0.01"
                      min="0.01"
                      placeholder="0.00"
                      value={returnAmount}
                      onChange={(e) => setReturnAmount(e.target.value)}
                      className="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm font-bold focus:outline-none focus:border-amber-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Original Transaction #
                    </label>
                    <input
                      type="text"
                      value={returnTransactionId}
                      onChange={(e) => setReturnTransactionId(e.target.value)}
                      placeholder="e.g. INV-2026-4521"
                      className="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm font-mono text-xs focus:outline-none focus:border-amber-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    Reason for Return *
                  </label>
                  <select
                    value={returnReason}
                    onChange={(e) => setReturnReason(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-amber-500"
                  >
                    <option value="">Select a reason...</option>
                    <option value="Damaged Goods">Damaged Goods</option>
                    <option value="Wrong Item / Size">Wrong Item / Size</option>
                    <option value="Customer Changed Mind">Customer Changed Mind</option>
                    <option value="Quality Issue">Quality Issue</option>
                    <option value="Duplicate Order">Duplicate Order</option>
                    <option value="Other">Other Reason</option>
                  </select>
                </div>

                <button
                  type="submit"
                  disabled={isSubmittingReturn}
                  className="w-full py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold text-sm shadow-lg transition disabled:opacity-50 flex items-center justify-center space-x-2"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>{isSubmittingReturn ? "Processing..." : "Process Refund"}</span>
                </button>
              </form>
            </div>
          )}

          {/* ~~~~~~~~~~ CUSTOMERS ~~~~~~~~~~ */}
          {activeSubTab === "CUSTOMERS" && (
            <div className="space-y-4">
              <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl">
                <div className="flex items-center space-x-2 pb-4 border-b border-slate-700/70">
                  <UserPlus className="w-5 h-5 text-amber-400" />
                  <h3 className="text-base font-bold text-white">Add New Customer</h3>
                </div>
                <form onSubmit={handleCreateCustomer} className="mt-4 space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Full Name *
                    </label>
                    <input
                      type="text"
                      required
                      value={newCustName}
                      onChange={(e) => setNewCustName(e.target.value)}
                      placeholder="Customer full name"
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
                        Type
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
                  <button
                    type="submit"
                    disabled={isCreatingCustomer}
                    className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-lg transition disabled:opacity-50"
                  >
                    {isCreatingCustomer ? "Creating..." : "Create Customer"}
                  </button>
                </form>
              </div>

              {hasManyCustomers && (
                <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl">
                  <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
                    <h4 className="text-sm font-bold text-white">
                      Branch Customers ({branchCustomers.length})
                    </h4>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs sm:text-sm">
                      <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[11px] tracking-wider">
                        <tr>
                          <th className="px-4 py-3">Name</th>
                          <th className="px-4 py-3">Phone</th>
                          <th className="px-4 py-3">Type</th>
                          <th className="px-4 py-3 text-right">Total Spent</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-700/60">
                        {branchCustomers.slice(0, 20).map((c: any) => (
                          <tr key={c.id} className="hover:bg-slate-700/40">
                            <td className="px-4 py-3.5 font-bold text-slate-100">{c.name}</td>
                            <td className="px-4 py-3.5 text-slate-300">{c.phone}</td>
                            <td className="px-4 py-3.5">
                              <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">
                                {c.type}
                              </span>
                            </td>
                            <td className="px-4 py-3.5 text-right font-extrabold text-emerald-400">
                              {formatMoney(c.totalSpentGhs, currentCurrency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ~~~~~~~~~~ INVENTORY ~~~~~~~~~~ */}
          {activeSubTab === "INVENTORY" && (
            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl">
              <div className="px-5 py-4 border-b border-slate-700 flex items-center space-x-2">
                <Package className="w-5 h-5 text-cyan-400" />
                <h3 className="text-base font-bold text-white">Branch Inventory Oversight</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm">
                  <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[11px] tracking-wider">
                    <tr>
                      <th className="px-4 py-3">SKU / Item</th>
                      <th className="px-4 py-3">Category</th>
                      <th className="px-4 py-3 text-right">Qty</th>
                      <th className="px-4 py-3 text-right">Cost Price</th>
                      <th className="px-4 py-3 text-right">Selling Price</th>
                      <th className="px-4 py-3 text-right">Margin</th>
                      <th className="px-4 py-3 text-center">Stock Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/60">
                    {branchInventory.map((item: any) => {
                      const margin =
                        item.sellingPriceGhs && item.costPriceGhs
                          ? (
                              ((item.sellingPriceGhs - item.costPriceGhs) /
                                item.costPriceGhs) *
                              100
                            ).toFixed(1)
                          : "—";
                      return (
                        <tr key={item.id} className="hover:bg-slate-700/40">
                          <td className="px-4 py-3.5">
                            <div className="font-bold text-slate-100">{item.name}</div>
                            <div className="text-[11px] font-mono text-cyan-400">{item.sku}</div>
                          </td>
                          <td className="px-4 py-3.5 text-slate-300">{item.category}</td>
                          <td className="px-4 py-3.5 text-right font-bold text-white">
                            {item.quantity?.toLocaleString()} {item.unit}
                          </td>
                          <td className="px-4 py-3.5 text-right text-slate-400">
                            {formatMoney(item.costPriceGhs, currentCurrency)}
                          </td>
                          <td className="px-4 py-3.5 text-right font-extrabold text-emerald-400">
                            {formatMoney(item.sellingPriceGhs, currentCurrency)}
                          </td>
                          <td className="px-4 py-3.5 text-right font-semibold text-emerald-300">
                            +{margin}%
                          </td>
                          <td className="px-4 py-3.5 text-center">
                            <span
                              className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                                item.status === "IN_STOCK"
                                  ? "bg-emerald-500/20 text-emerald-400"
                                  : item.status === "LOW_STOCK"
                                  ? "bg-amber-500/20 text-amber-400"
                                  : "bg-rose-500/20 text-rose-400"
                              }`}
                            >
                              {item.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                    {branchInventory.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-10 text-center text-slate-400">
                          No inventory items registered for this branch.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

        </div>

        {/* ────── RIGHT SIDEBAR: quick info ────── */}
        <div className="space-y-4">
          {/* Recent Sales Mini-Feed */}
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl">
            <h4 className="text-xs font-bold uppercase text-slate-400 mb-3 flex items-center justify-between">
              <span>Recent Sales</span>
              <span className="text-emerald-400 text-[10px] font-normal">
                {recentSales.length} latest
              </span>
            </h4>
            <div className="space-y-2.5">
              {recentSales.slice(0, 5).map((t: any) => {
                const invMatch = t.description?.match(/\[INV:([^\]]+)\]/);
                const invDisplay = invMatch ? invMatch[1] : t.transactionNumber;
                return (
                  <div
                    key={t.id}
                    className="flex items-center justify-between text-xs border-b border-slate-700/40 pb-2"
                  >
                    <div className="flex-1 mr-2 min-w-0">
                      <div className="text-emerald-400 font-mono text-[10px] truncate">
                        {invDisplay}
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">
                        {t.category}
                      </div>
                    </div>
                    <span className="font-extrabold text-emerald-400 shrink-0">
                      {formatMoney(t.amountGhs, currentCurrency)}
                    </span>
                  </div>
                );
              })}
              {recentSales.length === 0 && (
                <p className="text-xs text-slate-400 text-center py-4">No sales yet</p>
              )}
            </div>
          </div>

          {/* Customer Quick-Count */}
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl">
            <h4 className="text-xs font-bold uppercase text-slate-400 mb-3">Branch Customers</h4>
            <div className="text-2xl font-black text-amber-300">{branchCustomers.length}</div>
            <p className="text-xs text-slate-400 mt-1">Total customer records</p>
            <div className="mt-3 pt-3 border-t border-slate-700/60">
              <button
                onClick={() => setActiveSubTab("CUSTOMERS")}
                className="w-full py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-200 transition"
              >
                Manage Customers
              </button>
            </div>
          </div>

          {/* Inventory Alert Summary */}
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl">
            <h4 className="text-xs font-bold uppercase text-slate-400 mb-3">Stock Alerts</h4>
            {branchInventory.filter((i: any) => i.status !== "IN_STOCK").length > 0 ? (
              <div className="space-y-2">
                {branchInventory
                  .filter((i: any) => i.status !== "IN_STOCK")
                  .slice(0, 4)
                  .map((i: any) => (
                    <div
                      key={i.id}
                      className="flex items-center justify-between text-xs bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2"
                    >
                      <span className="text-slate-200 truncate mr-2">{i.name}</span>
                      <span className="text-amber-400 font-bold shrink-0">
                        {i.quantity} {i.unit}
                      </span>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="text-xs text-emerald-400 flex items-center space-x-1">
                <CheckCircle className="w-3.5 h-3.5" />
                <span>All stock levels are healthy</span>
              </div>
            )}
            <div className="mt-3">
              <button
                onClick={() => setActiveSubTab("INVENTORY")}
                className="w-full py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-200 transition"
              >
                View Full Inventory
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ────── Invoice Modal ────── */}
      {/* ────── Credit sale detail & installment collection modal ────── */}
      {creditModalSale && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" data-testid="bm-credit-modal">
          <div className="bg-slate-900 border border-cyan-500/30 rounded-2xl max-w-lg w-full p-5 space-y-4 max-h-[92vh] overflow-y-auto shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <HandCoins className="w-5 h-5 text-cyan-400" />
                  <h3 className="text-base font-black text-white font-mono">{creditModalSale.creditCode}</h3>
                  <span className={`text-[9px] font-black px-2 py-0.5 rounded border ${
                    creditModalSale.status === "PAID"
                      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
                      : "bg-cyan-500/15 text-cyan-300 border-cyan-500/40"
                  }`} data-testid="bm-credit-modal-status">
                    {creditModalSale.status === "PAID" ? "FULLY PAID" : "ACTIVE"}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  {creditModalSale.customerName}
                  {creditModalSale.customerPhone ? ` · ${creditModalSale.customerPhone}` : ""} · customer code{" "}
                  <span className="font-mono text-cyan-200">{creditModalSale.trackingCode || "—"}</span>
                </p>
              </div>
              <button type="button" onClick={() => { setCreditModalSale(null); setCreditError(""); setCreditFlash(""); }} data-testid="bm-credit-close" className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* totals + progress */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-slate-800/80 rounded-xl p-2.5 border border-slate-700">
                <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Total</p>
                <p className="text-sm font-black text-white" data-testid="bm-credit-modal-total">{formatMoney(creditModalSale.totalGhs, currentCurrency)}</p>
              </div>
              <div className="bg-slate-800/80 rounded-xl p-2.5 border border-emerald-500/30">
                <p className="text-[9px] font-bold uppercase tracking-wider text-emerald-300">Paid</p>
                <p className="text-sm font-black text-emerald-300" data-testid="bm-credit-modal-paid">{formatMoney(creditModalSale.amountPaidGhs, currentCurrency)}</p>
              </div>
              <div className="bg-slate-800/80 rounded-xl p-2.5 border border-amber-500/30">
                <p className="text-[9px] font-bold uppercase tracking-wider text-amber-300">Outstanding</p>
                <p className="text-sm font-black text-amber-300" data-testid="bm-credit-modal-balance">{formatMoney(creditModalSale.balanceGhs, currentCurrency)}</p>
              </div>
            </div>
            <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden border border-slate-700" data-testid="bm-credit-progress">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${Math.min(100, (Number(creditModalSale.totalGhs) > 0 ? (Number(creditModalSale.amountPaidGhs) / Number(creditModalSale.totalGhs)) * 100 : 100)).toFixed(1)}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-slate-400">
              <span>{creditModalSale.dueDate ? `Due ${creditModalSale.dueDate}` : "No due date set"}</span>
              <span>Opened {creditModalSale.createdAt ? new Date(creditModalSale.createdAt).toLocaleDateString() : "—"}</span>
            </div>

            {/* installment history */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">Payment history</p>
              {(creditModalSale.payments || []).length === 0 ? (
                <p className="text-[11px] text-slate-500" data-testid="bm-credit-history-empty">No payments yet.</p>
              ) : (
                <div className="space-y-1 max-h-36 overflow-y-auto pr-1" data-testid="bm-credit-history">
                  {(creditModalSale.payments || []).map((p: any) => (
                    <div key={p.id} className="flex items-center justify-between text-[11px] bg-slate-800/60 border border-slate-700/60 rounded-lg px-2.5 py-1.5">
                      <span className="text-slate-400">{p.createdAt ? new Date(p.createdAt).toLocaleString() : "—"}</span>
                      <span className="font-bold text-emerald-300">{formatMoney(p.amountGhs, currentCurrency)}</span>
                      <span className="text-slate-300">{p.paymentMethod}</span>
                      <span className="text-slate-500 font-mono">{p.paymentNumber}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {creditFlash && (
              <p className="px-3 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[11px] font-semibold" data-testid="bm-credit-flash">
                {creditFlash}
              </p>
            )}
            {creditError && (
              <p className="px-3 py-2 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 text-[11px]" data-testid="bm-credit-error">
                {creditError}
              </p>
            )}

            {/* record installment */}
            {creditModalSale.status === "ACTIVE" ? (
              <div className="bg-cyan-500/5 border border-cyan-500/25 rounded-xl p-3 space-y-2.5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Record installment</p>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={creditPayAmount}
                    onChange={(e) => setCreditPayAmount(e.target.value)}
                    placeholder={`Amount (≤ ${formatMoney(creditModalSale.balanceGhs, currentCurrency)})`}
                    data-testid="bm-credit-pay-amount"
                    className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs"
                  />
                  <select value={creditPayMethod} onChange={(e) => setCreditPayMethod(e.target.value)} data-testid="bm-credit-pay-method" className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs">
                    <option value="MTN_MOMO">MTN Mobile Money</option>
                    <option value="TELECEL_CASH">Telecel Cash</option>
                    <option value="CASH">Cash</option>
                    <option value="BANK_TRANSFER">Bank Transfer</option>
                    <option value="POS_CARD">POS Card</option>
                  </select>
                  <input
                    type="text"
                    value={creditPayRef}
                    onChange={(e) => setCreditPayRef(e.target.value)}
                    placeholder="MoMo / bank reference (optional)"
                    data-testid="bm-credit-pay-ref"
                    className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs col-span-2"
                  />
                </div>
                <button
                  type="button"
                  onClick={submitCreditPayment}
                  disabled={creditBusy}
                  data-testid="bm-credit-pay-submit"
                  className="w-full py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold transition disabled:opacity-50"
                >
                  {creditBusy ? "Recording…" : "Record installment"}
                </button>
              </div>
            ) : (
              <p className="text-center text-[11px] text-emerald-300 font-bold" data-testid="bm-credit-settled-note">
                This credit sale is fully settled — thank you.
              </p>
            )}
          </div>
        </div>
      )}

      {showInvoiceModal && lastSaleInfo && (
        <InvoiceModal info={lastSaleInfo} onClose={() => setShowInvoiceModal(false)} />
      )}

      {/* ────── Sales Document Builder (Invoice / Quotation) ────── */}
      {showBuilder && (
        <SalesDocumentBuilder
          isOpen={!!showBuilder}
          onClose={() => setShowBuilder(null)}
          onSaved={() => {
            refreshSalesDocuments();
          }}
          documentType={showBuilder}
          currentUser={currentUser}
          activeBiz={activeBiz}
          customers={customers}
          inventory={inventory}
          currency={currentCurrency}
        />
      )}

      {/* ────── Document Preview Modal ────── */}
      {viewDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-800 p-5">
              <div>
                <h3 className="text-lg font-bold text-white">
                  {viewDoc.documentType} — {viewDoc.documentNumber}
                </h3>
                <p className="text-[11px] text-slate-400">
                  {viewDoc.branchName} • {viewDoc.customerName} • Created{" "}
                  {new Date(viewDoc.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handlePrintDoc(viewDoc)}
                  className="flex items-center gap-1 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold"
                >
                  <Printer className="w-3.5 h-3.5" /> Print
                </button>
                <button
                  onClick={() => handleDownloadDoc(viewDoc)}
                  className="flex items-center gap-1 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold"
                >
                  <Download className="w-3.5 h-3.5" /> Download PDF
                </button>
                <button
                  onClick={() => setViewDoc(null)}
                  className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="overflow-y-auto p-6 space-y-4">
              {/* Company information */}
              <div className="text-center pb-3 border-b border-slate-800">
                <div className="text-base font-extrabold text-white">{COMPANY_INFO.name}</div>
                <div className="text-[10px] text-slate-400">{COMPANY_INFO.tagline}</div>
                <div className="text-[10px] text-slate-500 mt-1">
                  {COMPANY_INFO.address}, {COMPANY_INFO.city} | Tel: {COMPANY_INFO.phone} | {COMPANY_INFO.email}
                </div>
                <div className="text-[10px] text-slate-500">
                  Reg: {COMPANY_INFO.registrationNumber} | TIN: {COMPANY_INFO.taxId}
                </div>
              </div>

              {/* Document ID + Business/Branch + Issuer */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="p-3 rounded-lg bg-slate-800/70 border border-slate-700">
                  <div className="text-[10px] uppercase font-bold text-slate-500">Business / Branch</div>
                  <div className="text-xs font-bold text-slate-200 mt-0.5">
                    {viewDoc.branchName || activeBiz?.name}
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono">
                    {viewDoc.branchCode || activeBiz?.code}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-800/70 border border-slate-700">
                  <div className="text-[10px] uppercase font-bold text-slate-500">Issued By</div>
                  <div className="text-xs font-bold text-slate-200 mt-0.5">
                    {viewDoc.createdByName || "Staff"}
                  </div>
                  <div className="text-[10px] text-cyan-400">
                    {viewDoc.createdByRole || "Staff"} • {viewDoc.createdAt ? new Date(viewDoc.createdAt).toLocaleString() : "—"}
                  </div>
                </div>
              </div>

              {/* Customer info */}
              <div className="p-4 rounded-lg bg-slate-800 border border-slate-700">
                <div className="text-[10px] uppercase font-bold text-slate-400">Bill To</div>
                <div className="text-sm font-bold text-slate-100 mt-1">{viewDoc.customerName}</div>
                {viewDoc.customerPhone && <div className="text-xs text-slate-300">{viewDoc.customerPhone}</div>}
                {viewDoc.customerEmail && <div className="text-xs text-slate-300">{viewDoc.customerEmail}</div>}
                {viewDoc.customerAddress && <div className="text-xs text-slate-400 mt-1">{viewDoc.customerAddress}</div>}
              </div>

              {/* Line items */}
              <div className="rounded-lg border border-slate-700 overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-slate-800 text-slate-400">
                    <tr>
                      <th className="text-left px-3 py-2">Description</th>
                      <th className="text-center px-3 py-2">Qty</th>
                      <th className="text-right px-3 py-2">Unit Price</th>
                      <th className="text-right px-3 py-2">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/60">
                    {(viewDoc.lineItems || []).map((item: any, i: number) => (
                      <tr key={i}>
                        <td className="px-3 py-2 text-slate-200">{item.description}</td>
                        <td className="px-3 py-2 text-center text-slate-300">{item.quantity}</td>
                        <td className="px-3 py-2 text-right text-slate-300">
                          {formatMoney(item.unitPrice, currentCurrency)}
                        </td>
                        <td className="px-3 py-2 text-right font-bold text-emerald-400">
                          {formatMoney(item.total, currentCurrency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="flex justify-end">
                <div className="w-64 space-y-1 text-sm">
                  <div className="flex justify-between text-slate-400">
                    <span>Subtotal:</span>
                    <span>{formatMoney(viewDoc.subtotalGhs, currentCurrency)}</span>
                  </div>
                  {viewDoc.discountGhs > 0 && (
                    <div className="flex justify-between text-rose-300" data-testid="bm-doc-discount-line">
                      <span>Discount{Number(viewDoc.discountPercent) > 0 ? ` (${Number(viewDoc.discountPercent)}%)` : ""}:</span>
                      <span>- {formatMoney(viewDoc.discountGhs, currentCurrency)}</span>
                    </div>
                  )}
                  {viewDoc.taxRateGhs > 0 && (
                    <div className="flex justify-between text-slate-400">
                      <span>Tax ({viewDoc.taxRateGhs}%):</span>
                      <span>{formatMoney(viewDoc.taxAmountGhs, currentCurrency)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-lg font-bold text-emerald-400 pt-2 border-t border-slate-700">
                    <span>Total:</span>
                    <span>{formatMoney(viewDoc.totalGhs, currentCurrency)}</span>
                  </div>
                </div>
              </div>

              {viewDoc.notes && (
                <div className="text-xs">
                  <div className="font-bold text-slate-400 mb-1">Notes:</div>
                  <div className="text-slate-300">{viewDoc.notes}</div>
                </div>
              )}
              {viewDoc.terms && (
                <div className="text-xs">
                  <div className="font-bold text-slate-400 mb-1">Terms:</div>
                  <div className="text-slate-300">{viewDoc.terms}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
