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

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (!isOpen) return;
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
    loadCategories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

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
    };

    try {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
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
      setBusy(false);
      onSaved?.();
    } catch (err: any) {
      setError(err.message || "Failed to record expense.");
      setBusy(false);
    }
  };

  const shownCategories =
    categories.length > 0
      ? categories.map((c: any) => ({ value: c.name, label: `${c.icon || "📋"} ${c.name}` }))
      : defaultCategories;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4" data-testid={`${testid}-modal`}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-xl shadow-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-slate-800 p-5 shrink-0">
          <div>
            <h3 className="text-lg font-bold text-white">{title}</h3>
            <p className="text-[11px] text-slate-400">
              {subtitle || `Linked to ${businessName || "this business"} (${branchCode || "—"}) • Categories are shared with GoMina finance`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
            data-testid={`${testid}-close`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="overflow-y-auto p-5 space-y-4 flex-1" data-testid={`${testid}-form`}>
          {error && (
            <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-3 rounded-lg text-xs" data-testid={`${testid}-error`}>
              {error}
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
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs"
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
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs"
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
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs font-bold"
              data-testid={`${testid}-amount`}
            />
          </div>

          {/* Payment + Date */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-semibold text-slate-400 mb-1">Payment Method</label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs"
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
              <label className="block text-[10px] font-semibold text-slate-400 mb-1">Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs"
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
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs"
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
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs resize-none"
              data-testid={`${testid}-description`}
            />
          </div>

          {/* Receipt Photos */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] font-semibold text-slate-400">Receipt Photos (optional)</label>
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
            <div className="flex gap-2">
              <label className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-800 border border-slate-700 border-dashed rounded-lg text-xs text-slate-400 hover:text-emerald-400 hover:border-emerald-500/50 cursor-pointer transition">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                Upload Receipt
                <input type="file" accept="image/*" multiple onChange={handleReceiptUpload} className="hidden" data-testid={`${testid}-receipt-upload`} />
              </label>
              <label className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-800 border border-slate-700 border-dashed rounded-lg text-xs text-slate-400 hover:text-emerald-400 hover:border-emerald-500/50 cursor-pointer transition">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><circle cx="12" cy="13" r="3" /></svg>
                Take Photo
                <input type="file" accept="image/*" capture="environment" onChange={handleReceiptUpload} className="hidden" data-testid={`${testid}-receipt-photo`} />
              </label>
            </div>
          </div>

          {/* Auto-tracking info */}
          <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-3 text-[10px] text-slate-400">
            <div className="font-bold text-slate-300 mb-1">Automatic tracking</div>
            <div>Business: <span className="text-slate-200">{businessName || "—"}</span></div>
            <div>Branch: <span className="text-slate-200">{branchCode || "—"}</span></div>
            <div>Recorded by: <span className="text-slate-200">{currentUser?.name || "—"}</span> ({currentUser?.role || "—"})</div>
            <div>Server timestamp: generated on submit</div>
            {receiptImages.length > 0 && <div className="mt-1 text-emerald-400">📷 {receiptImages.length} receipt photo(s) attached</div>}
          </div>

          <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold" data-testid={`${testid}-cancel`}>
              Cancel
            </button>
            <button type="submit" disabled={busy} className={`px-5 py-2 rounded-lg text-white text-xs font-bold disabled:opacity-50 ${submitBtn}`} data-testid={`${testid}-submit`}>
              {busy ? "Recording…" : submitLabel}
            </button>
          </div>
        </form>
      </div>

      {/* ─── Add Category Modal ─── */}
      {showAddCategory && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-sm shadow-2xl p-5 space-y-4" data-testid={`${testid}-cat-modal`}>
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
