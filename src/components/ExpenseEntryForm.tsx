"use client";

import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { addToOfflineQueue } from "@/lib/offlineSync";

export interface ExpenseCategoryOption {
  value: string;
  label: string;
}

const CATEGORY_ICONS = [
  "📋", "🔧", "⛽", "💡", "📞", "🧪", "🪵", "🚚", "🧹", "📦",
  "🛡️", "📢", "💊", "🧑‍🌾", "🏗️", "📊", "🧯", "💰",
];

/**
 * ExpenseEntryForm — the shared "Record Expense Information" dialog used by
 * every business module and branch. It reproduces the Poultry Farm expense
 * form feature-for-feature:
 *
 *   • Expense category dropdown with an "+ Add New" shortcut and an inline
 *     "create new category" input when the sentinel option is chosen.
 *   • Amount, payment method, date, vendor/payee and description fields.
 *   • Receipt upload (file picker) AND take-photo (camera capture) options
 *     with thumbnails and per-image removal.
 *   • An "Automatic tracking" info box (business, branch, recorded-by,
 *     server timestamp, receipt count).
 *   • Offline-queue fallback and a Worker expense-permission gate.
 *
 * The category list is shared per business/branch via /api/expense-categories;
 * each business supplies its own fallback `defaultCategories` so the dropdown
 * stays relevant when no custom categories have been saved yet.
 */
export default function ExpenseEntryForm({
  isOpen,
  onClose,
  onSaved,
  businessId,
  branchCode,
  branchName,
  businessName,
  currentUser,
  title = "Record Expense",
  subtitle,
  defaultCategories = [],
  defaultCategory = "",
  vendorLabel = "Vendor / Payee",
  vendorPlaceholder = "e.g. supplier name",
  descriptionPlaceholder = "What was purchased? Add receipt details.",
  contextLabel = "Business",
  currencyLabel = "GH₵",
  submitLabel = "Record Expense",
  accent = "rose",
  testid = "expense",
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: () => void;
  businessId?: number | null;
  branchCode?: string | null;
  branchName?: string | null;
  businessName?: string;
  currentUser: any;
  title?: string;
  subtitle?: string;
  defaultCategories?: ExpenseCategoryOption[];
  defaultCategory?: string;
  vendorLabel?: string;
  vendorPlaceholder?: string;
  descriptionPlaceholder?: string;
  contextLabel?: string;
  currencyLabel?: string;
  submitLabel?: string;
  accent?: "rose" | "emerald" | "cyan" | "amber" | "indigo";
  testid?: string;
}) {
  const [category, setCategory] = useState(defaultCategory);
  const [customCategory, setCustomCategory] = useState("");
  const [amountGhs, setAmountGhs] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [date, setDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [vendor, setVendor] = useState("");
  const [description, setDescription] = useState("");
  const [receiptImages, setReceiptImages] = useState<string[]>([]);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryIcon, setNewCategoryIcon] = useState("📋");
  const [categories, setCategories] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<"RECORD" | "REQUEST">("REQUEST");

  const accentClass: Record<string, string> = {
    rose: "bg-rose-600 hover:bg-rose-500",
    emerald: "bg-emerald-600 hover:bg-emerald-500",
    cyan: "bg-cyan-600 hover:bg-cyan-500",
    amber: "bg-amber-600 hover:bg-amber-500",
    indigo: "bg-indigo-600 hover:bg-indigo-500",
  };
  const accentText: Record<string, string> = {
    rose: "text-rose-300 hover:text-rose-200",
    emerald: "text-emerald-300 hover:text-emerald-200",
    cyan: "text-cyan-300 hover:text-cyan-200",
    amber: "text-amber-300 hover:text-amber-200",
    indigo: "text-indigo-300 hover:text-indigo-200",
  };
  const submitBtn = accentClass[accent] || accentClass.rose;

  const loadCategories = async () => {
    if (!businessId) return;
    try {
      const res = await fetch(
        `/api/expense-categories?businessId=${businessId}&branchCode=${encodeURIComponent(branchCode || "")}`
      );
      const data = await res.json();
      if (data.success) setCategories(data.categories || []);
    } catch {
      /* categories are optional — fall back to defaults */
    }
  };

  // Reset the form each time the dialog opens — defaults to REQUEST mode
  useEffect(() => {
    if (!isOpen) return;
    setMode("REQUEST");
    setCategory(defaultCategory);
    setCustomCategory("");
    setAmountGhs("");
    setPaymentMethod("CASH");
    setDate(new Date().toISOString().split("T")[0]);
    setVendor("");
    setDescription("");
    setReceiptImages([]);
    setShowAddCategory(false);
    setNewCategoryName("");
    setNewCategoryIcon("📋");
    setBusy(false);
    setError("");
    setNotice(null);
    loadCategories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleReceiptUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    Array.from(files).forEach((file) => {
      if (file.size > 5 * 1024 * 1024) {
        setError("Image must be under 5MB.");
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

  const removeReceiptImage = (index: number) =>
    setReceiptImages((prev) => prev.filter((_, i) => i !== index));

  const handleAddCategory = async () => {
    const name = newCategoryName.trim();
    if (!name || !businessId) return;
    try {
      const res = await fetch("/api/expense-categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          branchCode: branchCode || null,
          name,
          icon: newCategoryIcon,
          createdBy: currentUser?.name,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setCategories((prev) => [...prev, data.category]);
        setCategory(data.category.name);
        setNewCategoryName("");
        setShowAddCategory(false);
      } else if (data.error && data.error.includes("already exists")) {
        setCategories((prev) => [...prev, { name, icon: newCategoryIcon }]);
        setCategory(name);
        setNewCategoryName("");
        setShowAddCategory(false);
      } else {
        setError(data.error || "Failed to create category.");
      }
    } catch (e: any) {
      setError(e.message || "Failed to create category.");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const amount = Number(amountGhs);
    let finalCategory = category;

    if (category === "---NEW---") {
      const customName = customCategory.trim();
      if (!customName) {
        setError("Enter a category name or select an existing category.");
        return;
      }
      if (businessId) {
        try {
          const catRes = await fetch("/api/expense-categories", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              businessId,
              branchCode: branchCode || null,
              name: customName,
              icon: "📋",
              createdBy: currentUser?.name,
            }),
          });
          const catData = await catRes.json();
          if (catData.success) {
            finalCategory = catData.category.name;
            setCategories((prev) => [...prev, catData.category]);
          } else if (catData.error && catData.error.includes("already exists")) {
            finalCategory = customName;
          } else {
            setError(catData.error || "Failed to create category.");
            return;
          }
        } catch (err: any) {
          setError(err.message || "Failed to create category.");
          return;
        }
      } else {
        finalCategory = customName;
      }
    }

    if (!amount || amount <= 0) {
      setError("Enter a valid expense amount.");
      return;
    }
    if (currentUser?.role === "WORKER" && currentUser?.canRecordExpenses !== true) {
      setError("Your Worker account is not permitted to record expenses. Ask your Branch Manager.");
      return;
    }

    setBusy(true);
    const vendorText = vendor.trim() ? ` | Vendor: ${vendor.trim()}` : "";
    const context = contextLabel || businessName || "Business";
    const fullDescription = `${description.trim() || finalCategory.replace(/_/g, " ")}${vendorText} | ${context} branch: ${branchCode || "—"}`;
    const payload = {
      businessId: businessId ? Number(businessId) : undefined,
      branchCode: branchCode || null,
      branchName: branchName || businessName || null,
      type: "EXPENSE",
      category: finalCategory,
      amountGhs: amount,
      paymentMethod,
      description: fullDescription,
      date,
      recordedBy: currentUser?.name || "GoMina User",
      recordedByRole: currentUser?.role || "STAFF",
      recordedByUserId: currentUser?.id || null,
      status: "COMPLETED",
      receiptImages: receiptImages.length > 0 ? receiptImages : null,
      expenseMode: mode,
      isPreApproval: mode === "REQUEST",
    };

    try {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        addToOfflineQueue("TRANSACTION", payload);
        setBusy(false);
        onSaved?.();
      } else {
        const res = await fetch("/api/transactions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Failed to record expense.");
        if (data.pendingApproval) {
          setNotice(data.message || "Expense submitted for approval — the approvers have been notified.");
          setTimeout(() => {
            setBusy(false);
            onSaved?.();
          }, 1400);
          return;
        }
        setBusy(false);
        onSaved?.();
      }
    } catch (err: any) {
      setError(err.message || "Failed to record expense.");
      setBusy(false);
    }
  };

  // Escape key listener
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showAddCategory) setShowAddCategory(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, showAddCategory, onClose]);

  const shownCategories =
    categories.length > 0
      ? categories.map((c: any) => ({ value: c.name, label: `${c.icon || "📋"} ${c.name}` }))
      : defaultCategories;

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-4 overflow-y-auto"
      data-testid={`${testid}-modal`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-xl shadow-2xl max-h-[calc(100dvh-1rem)] sm:max-h-[92vh] flex flex-col my-auto overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 p-3.5 sm:p-5 shrink-0 bg-slate-900">
          <div className="min-w-0 flex-1 pr-2">
            <h3 className="text-sm sm:text-lg font-bold text-white truncate">
              {mode === "REQUEST" ? (title || "Request Expense Pre-Approval") : (title || "Record Incurred Expense")}
            </h3>
            <p className="text-[11px] text-slate-400 line-clamp-1">
              {subtitle || `Linked to ${businessName || "this business"} (${branchCode || "—"}) • GoMina Approval & Finance Workflow`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition shrink-0"
            data-testid={`${testid}-close`}
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Form Body */}
        <form
          id={`${testid}-form-element`}
          onSubmit={handleSubmit}
          className="overflow-y-auto p-3.5 sm:p-5 space-y-3.5 sm:space-y-4 flex-1 overscroll-contain"
          data-testid={`${testid}-form`}
        >
>>>>>>> c22348e (audit: complete comprehensive A-Z audit fixes, performance optimizations, and verification suite reconciliation)
          {error && (
            <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-3 rounded-lg text-xs" data-testid={`${testid}-error`}>
              {error}
            </div>
          )}

          {notice && (
            <div className="bg-amber-500/15 border border-amber-500/40 text-amber-300 p-3 rounded-lg text-xs flex items-center gap-2" data-testid={`${testid}-notice`}>
              <span className="text-base">⏳</span>
              <span>{notice}</span>
            </div>
          )}

          {/* Mode Selector: Request Expense (Default) vs Record Expense */}
          <div className="bg-slate-950/90 p-1.5 rounded-xl border border-slate-800 flex flex-col xs:flex-row gap-1.5" data-testid={`${testid}-mode-selector`}>
            <button
              type="button"
              onClick={() => setMode("REQUEST")}
              data-testid={`${testid}-mode-request`}
              className={`flex-1 py-2.5 px-3 min-h-[42px] rounded-lg text-xs font-bold transition flex items-center justify-center gap-2 ${
                mode === "REQUEST"
                  ? "bg-indigo-600 text-white shadow-md border border-indigo-400"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <span>⏳</span>
              <span className="truncate">Request Expense (Pre-Approval)</span>
            </button>
            <button
              type="button"
              onClick={() => setMode("RECORD")}
              data-testid={`${testid}-mode-record`}
              className={`flex-1 py-2.5 px-3 min-h-[42px] rounded-lg text-xs font-bold transition flex items-center justify-center gap-2 ${
                mode === "RECORD"
                  ? "bg-slate-800 text-white shadow-md border border-slate-600"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <span>💳</span>
              <span className="truncate">Record Expense (Incurred)</span>
            </button>
          </div>

          {/* Mode Explanatory Banner */}
          {mode === "REQUEST" ? (
            <div className="text-[11px] text-indigo-200 bg-indigo-950/40 border border-indigo-700/50 rounded-lg p-2.5 flex items-start gap-2">
              <span className="text-amber-400 font-bold text-sm leading-none shrink-0">●</span>
              <span><b>Default Workflow — Planned / Upcoming Spend:</b> Submits a requisition or quote for approval. Once approved, you can disburse funds and attach final receipts.</span>
            </div>
          ) : (
            <div className="text-[11px] text-slate-300 bg-slate-800/40 border border-slate-700/60 rounded-lg p-2.5 flex items-start gap-2">
              <span className="text-emerald-400 font-bold text-sm leading-none shrink-0">●</span>
              <span><b>Expense already incurred / spent:</b> Records payment & receipt into Finance ledger. Gated automatically if an organization approval policy applies.</span>
            </div>
          )}

          {/* Category select with add new */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] font-semibold text-slate-400">Expense Category *</label>
              <button
                type="button"
                onClick={() => setShowAddCategory(true)}
                className={`text-[10px] font-semibold ${accentText[accent] || "text-emerald-400"}`}
                data-testid={`${testid}-add-category`}
              >
                + Add New
              </button>
            </div>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs sm:text-sm"
              data-testid={`${testid}-category`}
            >
              {shownCategories.length > 0 ? (
                <>
                  {shownCategories.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                  <option value="---NEW---">+ Create new category…</option>
                </>
              ) : (
                <option value="---NEW---">+ Create new category…</option>
              )}
            </select>
            {category === "---NEW---" && (
              <div className="mt-2 p-3 bg-slate-800/80 border border-slate-700 rounded-lg space-y-2">
                <input
                  type="text"
                  required
                  value={customCategory}
                  onChange={(e) => setCustomCategory(e.target.value)}
                  placeholder="New category name"
                  className="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs sm:text-sm"
                  data-testid={`${testid}-custom-category`}
                />
                <p className="text-[10px] text-slate-500">This category will be saved for future use.</p>
              </div>
            )}
          </div>

          {/* Amount */}
          <div>
            <label className="block text-[10px] font-semibold text-slate-400 mb-1">Amount ({currencyLabel}) *</label>
            <input
              type="number"
              min="0.01"
              step="0.01"
              required
              value={amountGhs}
              onChange={(e) => setAmountGhs(e.target.value)}
              placeholder="0.00"
              className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs sm:text-sm font-bold"
              data-testid={`${testid}-amount`}
            />
          </div>

          {/* Payment + Date */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                {mode === "REQUEST" ? "Proposed Payment Method" : "Payment Method"}
              </label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs sm:text-sm"
                data-testid={`${testid}-payment`}
              >
                <option value="CASH">Cash</option>
                <option value="MTN_MOMO">MTN MoMo</option>
                <option value="TELECEL_CASH">Telecel Cash</option>
                <option value="BANK_TRANSFER">Bank Transfer</option>
                <option value="POS_CARD">POS Card</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                {mode === "REQUEST" ? "Estimated Expense Date" : "Date Incurred *"}
              </label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs sm:text-sm"
                data-testid={`${testid}-date`}
              />
            </div>
          </div>

          {/* Vendor */}
          <div>
            <label className="block text-[10px] font-semibold text-slate-400 mb-1">{vendorLabel}</label>
            <input
              type="text"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder={vendorPlaceholder}
              className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs sm:text-sm"
              data-testid={`${testid}-vendor`}
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-[10px] font-semibold text-slate-400 mb-1">Description</label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={descriptionPlaceholder}
              className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs sm:text-sm resize-none"
              data-testid={`${testid}-description`}
            />
          </div>

          {/* Receipt / Document Photos */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] font-semibold text-slate-400">
                {mode === "REQUEST" ? "Quote / Proforma / Bill Photos (optional)" : "Receipt Photos (optional)"}
              </label>
              <span className="text-[10px] text-slate-500">{receiptImages.length} attached</span>
            </div>
            {receiptImages.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {receiptImages.map((img, idx) => (
                  <div key={idx} className="relative group w-20 h-20">
                    <img src={img} alt={`Receipt ${idx + 1}`} className="w-full h-full object-cover rounded-lg border border-slate-700" />
                    <button
                      type="button"
                      onClick={() => removeReceiptImage(idx)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-rose-600 text-white rounded-full text-xs flex items-center justify-center opacity-80 hover:opacity-100"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="flex items-center justify-center gap-2 px-3 py-2.5 min-h-[44px] bg-slate-800 border border-slate-700 border-dashed rounded-lg text-xs text-slate-300 hover:text-emerald-400 hover:border-emerald-500/50 cursor-pointer transition">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                <span className="truncate">{mode === "REQUEST" ? "Upload Quote / Doc" : "Upload Receipt"}</span>
                <input type="file" accept="image/*" multiple onChange={handleReceiptUpload} className="hidden" data-testid={`${testid}-receipt-upload`} />
              </label>
              <label className="flex items-center justify-center gap-2 px-3 py-2.5 min-h-[44px] bg-slate-800 border border-slate-700 border-dashed rounded-lg text-xs text-slate-300 hover:text-emerald-400 hover:border-emerald-500/50 cursor-pointer transition">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><circle cx="12" cy="13" r="3" /></svg>
                <span>Take Photo</span>
                <input type="file" accept="image/*" capture="environment" onChange={handleReceiptUpload} className="hidden" data-testid={`${testid}-receipt-photo`} />
              </label>
            </div>
          </div>

          {/* Auto-tracking info */}
          <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-3 text-[10px] text-slate-400 space-y-0.5">
            <div className="font-bold text-slate-300 mb-1">Automatic tracking</div>
            <div className="truncate">Business: <span className="text-slate-200">{businessName || "—"}</span></div>
            <div className="truncate">Branch: <span className="text-slate-200">{branchCode || "—"}</span></div>
            <div className="truncate">Recorded by: <span className="text-slate-200">{currentUser?.name || "—"}</span> ({currentUser?.role || "—"})</div>
            <div>Workflow: <span className="text-slate-200 font-semibold">{mode === "REQUEST" ? "Pre-approval Request" : "Incurred Expense"}</span></div>
            {receiptImages.length > 0 && <div className="mt-1 text-emerald-400">📷 {receiptImages.length} photo(s) attached</div>}
          </div>
        </form>

        {/* Fixed Footer */}
        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 p-3.5 sm:p-4 bg-slate-900/95 border-t border-slate-800 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="w-full sm:w-auto px-4 py-2.5 min-h-[42px] rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition flex items-center justify-center"
            data-testid={`${testid}-cancel`}
          >
            Cancel
          </button>
          <button
            type="submit"
            form={`${testid}-form-element`}
            disabled={busy}
            className={`w-full sm:w-auto px-5 py-2.5 min-h-[42px] rounded-xl text-white text-xs font-black shadow-lg transition flex items-center justify-center gap-1.5 disabled:opacity-50 ${
              mode === "REQUEST" ? "bg-indigo-600 hover:bg-indigo-500" : submitBtn
            }`}
            data-testid={`${testid}-submit`}
          >
            {busy
              ? mode === "REQUEST"
                ? "Submitting request…"
                : "Recording…"
              : mode === "REQUEST"
              ? "Submit Expense Request"
              : submitLabel || "Record Expense"}
          </button>
        </div>
      </div>

      {/* ─── Add Category Modal ─── */}
      {showAddCategory && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto"
          onClick={(e) => { if (e.target === e.currentTarget) setShowAddCategory(false); }}
        >
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-sm shadow-2xl p-4 sm:p-5 space-y-4 max-h-[calc(100dvh-2rem)] overflow-y-auto my-auto" data-testid={`${testid}-cat-modal`}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white">Add New Expense Category</h3>
              <button type="button" onClick={() => setShowAddCategory(false)} className="p-1 rounded hover:bg-slate-800 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] font-semibold text-slate-400 mb-1">Category Name</label>
                <input
                  type="text"
                  required
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  placeholder="e.g. Generator Servicing"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs"
                  data-testid={`${testid}-cat-name`}
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-slate-400 mb-1">Icon</label>
                <div className="flex flex-wrap gap-1.5">
                  {CATEGORY_ICONS.map((icon) => (
                    <button
                      key={icon}
                      type="button"
                      onClick={() => setNewCategoryIcon(icon)}
                      className={`w-8 h-8 rounded-lg text-lg flex items-center justify-center border transition ${newCategoryIcon === icon ? "bg-emerald-500/20 border-emerald-500/50" : "bg-slate-800 border-slate-700 hover:border-slate-500"}`}
                    >
                      {icon}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowAddCategory(false)} className="px-3 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold">
                  Cancel
                </button>
                <button type="button" onClick={handleAddCategory} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold" data-testid={`${testid}-cat-save`}>
                  Save Category
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
