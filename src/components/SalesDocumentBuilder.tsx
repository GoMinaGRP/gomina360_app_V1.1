"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  X,
  Plus,
  Trash2,
  FileText,
  ClipboardEdit,
  CheckCircle,
  User,
  Building2,
} from "lucide-react";
import { CurrencyCode, formatMoney } from "@/lib/currency";

interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (doc: any) => void;
  documentType: "INVOICE" | "QUOTATION";
  currentUser: any;
  activeBiz: any;
  customers: any[];
  inventory: any[];
  currency: CurrencyCode;
}

export default function SalesDocumentBuilder({
  isOpen,
  onClose,
  onSaved,
  documentType,
  currentUser,
  activeBiz,
  customers,
  inventory,
  currency,
}: Props) {
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("WALKIN");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [lineItems, setLineItems] = useState<LineItem[]>([
    { description: "", quantity: 1, unitPrice: 0 },
  ]);
  const [taxRate, setTaxRate] = useState<number>(0);
  const [discount, setDiscount] = useState<number>(0);
  const [discountPct, setDiscountPct] = useState<number>(0); // % drives the amount automatically
  const [notes, setNotes] = useState("");
  const [terms, setTerms] = useState(
    documentType === "INVOICE"
      ? "Payment due within 30 days. Late payments attract a 2% monthly interest."
      : "This quotation is valid for 30 days from date of issue."
  );
  const [validUntil, setValidUntil] = useState(
    new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0]
  );
  const [dueDate, setDueDate] = useState(
    new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0]
  );
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  const branchInventory = useMemo(
    () => inventory.filter((i: any) => i.businessId === activeBiz?.id),
    [inventory, activeBiz?.id]
  );

  const branchCustomers = useMemo(
    () =>
      // Business-isolated CRM — a branch only ever picks from its OWN
      // customers (owner directive; group-shared legacy rows live in the
      // group Customers register, not in a branch's sales flow).
      customers.filter((c: any) => c.businessId === activeBiz?.id),
    [customers, activeBiz?.id]
  );

  // Reset each time modal opens
  useEffect(() => {
    if (isOpen) {
      setSelectedCustomerId("WALKIN");
      setCustomerName("");
      setCustomerPhone("");
      setCustomerEmail("");
      setCustomerAddress("");
      setLineItems([{ description: "", quantity: 1, unitPrice: 0 }]);
      setTaxRate(0);
      setDiscount(0);
      setDiscountPct(0);
      setNotes("");
      setTerms(
        documentType === "INVOICE"
          ? "Payment due within 30 days. Late payments attract a 2% monthly interest."
          : "This quotation is valid for 30 days from date of issue."
      );
      setValidUntil(new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0]);
      setDueDate(new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0]);
      setErrorMsg("");
      setSuccessMsg("");
    }
  }, [isOpen, documentType]);

  // When customer is selected, autofill their details
  useEffect(() => {
    if (selectedCustomerId === "WALKIN") return;
    const c = branchCustomers.find((x: any) => String(x.id) === selectedCustomerId);
    if (c) {
      setCustomerName(c.name || "");
      setCustomerPhone(c.phone || "");
      setCustomerEmail(c.email || "");
      setCustomerAddress(c.address || "");
    }
  }, [selectedCustomerId, branchCustomers]);

  const addLineItem = () => setLineItems([...lineItems, { description: "", quantity: 1, unitPrice: 0 }]);

  const updateLineItem = (index: number, field: keyof LineItem, value: string | number) => {
    const copy = [...lineItems];
    (copy[index] as any)[field] =
      field === "description" ? String(value) : Number(value);
    setLineItems(copy);
  };

  const removeLineItem = (index: number) => {
    if (lineItems.length === 1) return;
    setLineItems(lineItems.filter((_, i) => i !== index));
  };

  const useInventoryItem = (inv: any) => {
    // Append to line items or fill the last empty
    const last = lineItems[lineItems.length - 1];
    const newItem = {
      description: `${inv.name} (${inv.sku})`,
      quantity: 1,
      unitPrice: Number(inv.sellingPriceGhs) || 0,
    };
    if (!last.description && last.unitPrice === 0) {
      const copy = [...lineItems];
      copy[copy.length - 1] = newItem;
      setLineItems(copy);
    } else {
      setLineItems([...lineItems, newItem]);
    }
  };

  const subtotal = lineItems.reduce(
    (sum, i) => sum + Number(i.quantity || 0) * Number(i.unitPrice || 0),
    0
  );
  const taxAmount = (subtotal * taxRate) / 100;
  // Percentage discount auto-calculates the amount (and vice versa).
  const discountAmount = discountPct > 0 ? Math.round(((subtotal * discountPct) / 100) * 100) / 100 : discount;
  const total = subtotal + taxAmount - discountAmount;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    setSuccessMsg("");

    if (!customerName.trim()) {
      setErrorMsg("Please enter a customer name.");
      return;
    }
    const validItems = lineItems.filter(
      (i) => i.description.trim() && Number(i.quantity) > 0 && Number(i.unitPrice) >= 0
    );
    if (validItems.length === 0) {
      setErrorMsg("Please add at least one line item.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/sales-documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentType,
          businessId: activeBiz?.id,
          branchCode: activeBiz?.code,
          branchName: activeBiz?.name,
          customerId: selectedCustomerId === "WALKIN" ? null : Number(selectedCustomerId),
          customerName: customerName.trim(),
          customerPhone,
          customerEmail,
          customerAddress,
          lineItems: validItems,
          taxRateGhs: taxRate,
          discountGhs: discountPct > 0 ? undefined : discount,
          discountPercent: discountPct > 0 ? discountPct : undefined,
          currency,
          notes,
          terms,
          validUntil: documentType === "QUOTATION" ? validUntil : null,
          dueDate: documentType === "INVOICE" ? dueDate : null,
          createdByUserId: currentUser?.id,
          createdByName: currentUser?.name || "Sales Team",
          createdByRole: currentUser?.role || "Staff",
        }),
      });

      const data = await res.json();
      if (data.success) {
        setSuccessMsg(`✓ ${documentType === "INVOICE" ? "Invoice" : "Quotation"} ${data.document.documentNumber} created!`);
        onSaved(data.document);
        setTimeout(onClose, 1000);
      } else {
        setErrorMsg(data.error || "Failed to create document.");
      }
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const isInvoice = documentType === "INVOICE";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl shadow-2xl max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 p-5">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
              isInvoice ? "bg-emerald-500/20 text-emerald-400" : "bg-blue-500/20 text-blue-400"
            }`}>
              {isInvoice ? <FileText className="w-5 h-5" /> : <ClipboardEdit className="w-5 h-5" />}
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">
                Create {isInvoice ? "Invoice" : "Quotation"}
              </h3>
              <p className="text-[11px] text-slate-400">
                {activeBiz?.name} ({activeBiz?.code})
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto p-5 space-y-5">
          {errorMsg && (
            <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-3 rounded-lg text-xs">
              {errorMsg}
            </div>
          )}
          {successMsg && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 p-3 rounded-lg text-xs flex items-center gap-2">
              <CheckCircle className="w-4 h-4" />
              {successMsg}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Customer section */}
            <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4 space-y-3">
              <label className="flex items-center gap-2 text-xs font-bold text-slate-300 uppercase">
                <User className="w-4 h-4 text-cyan-400" />
                Customer Information
              </label>

              <select
                value={selectedCustomerId}
                onChange={(e) => setSelectedCustomerId(e.target.value)}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm"
              >
                <option value="WALKIN">Walk-in customer (enter details below)</option>
                {branchCustomers.map((c: any) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.phone}
                  </option>
                ))}
              </select>

              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text"
                  required
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Customer Name *"
                  className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm"
                />
                <input
                  type="text"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder="Phone"
                  className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm"
                />
                <input
                  type="email"
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                  placeholder="Email"
                  className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm"
                />
                <input
                  type="text"
                  value={customerAddress}
                  onChange={(e) => setCustomerAddress(e.target.value)}
                  placeholder="Address"
                  className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm"
                />
              </div>
            </div>

            {/* Line items */}
            <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-300 uppercase">
                  <Building2 className="w-4 h-4 text-emerald-400" />
                  Line Items
                </label>
                <button
                  type="button"
                  onClick={addLineItem}
                  className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold"
                >
                  <Plus className="w-3 h-3" />
                  Add Item
                </button>
              </div>

              {branchInventory.length > 0 && (
                <div className="pb-2 border-b border-slate-700">
                  <div className="text-[10px] text-slate-500 mb-1">Quick-add from branch inventory:</div>
                  <div className="flex flex-wrap gap-1">
                    {branchInventory.slice(0, 6).map((inv: any) => (
                      <button
                        key={inv.id}
                        type="button"
                        onClick={() => useInventoryItem(inv)}
                        className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-[10px] text-cyan-300 hover:bg-cyan-900/40"
                        title={`${formatMoney(inv.sellingPriceGhs, currency)} per ${inv.unit}`}
                      >
                        {inv.name.substring(0, 26)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {lineItems.map((item, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                    <input
                      type="text"
                      value={item.description}
                      onChange={(e) => updateLineItem(idx, "description", e.target.value)}
                      placeholder="Description"
                      className="col-span-6 px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs"
                    />
                    <input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(e) => updateLineItem(idx, "quantity", e.target.value)}
                      placeholder="Qty"
                      className="col-span-2 px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs text-right"
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.unitPrice}
                      onChange={(e) => updateLineItem(idx, "unitPrice", e.target.value)}
                      placeholder="Unit Price"
                      className="col-span-3 px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs text-right"
                    />
                    <button
                      type="button"
                      onClick={() => removeLineItem(idx)}
                      disabled={lineItems.length === 1}
                      className="col-span-1 p-1 rounded hover:bg-rose-500/20 text-rose-400 disabled:opacity-30"
                    >
                      <Trash2 className="w-4 h-4 mx-auto" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Totals adjustments */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  Tax Rate (%)
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={taxRate}
                  onChange={(e) => setTaxRate(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  Discount % (auto-calculates)
                </label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  value={discountPct}
                  data-testid="sdb-discount-pct"
                  onChange={(e) => {
                    const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                    setDiscountPct(pct);
                    if (pct > 0) setDiscount(Math.round(((subtotal * pct) / 100) * 100) / 100);
                  }}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  Discount ({currency})
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={discountAmount}
                  data-testid="sdb-discount-amt"
                  onChange={(e) => {
                    const amt = Math.max(0, Number(e.target.value) || 0);
                    setDiscount(amt);
                    setDiscountPct(subtotal > 0 ? Math.round((amt / subtotal) * 10000) / 100 : 0);
                  }}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                />
              </div>
            </div>

            {/* Date fields */}
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                {isInvoice ? "Due Date" : "Valid Until"}
              </label>
              <input
                type="date"
                value={isInvoice ? dueDate : validUntil}
                onChange={(e) =>
                  isInvoice ? setDueDate(e.target.value) : setValidUntil(e.target.value)
                }
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
              />
            </div>

            {/* Notes & Terms */}
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">Notes</label>
              <textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Additional notes for the customer"
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm resize-none"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Terms & Conditions
              </label>
              <textarea
                rows={2}
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm resize-none"
              />
            </div>

            {/* Live totals */}
            <div className="rounded-xl bg-slate-800 border border-slate-700 p-4 space-y-1 text-sm">
              <div className="flex justify-between text-slate-400">
                <span>Subtotal:</span>
                <span>{formatMoney(subtotal, currency)}</span>
              </div>
              {discountAmount > 0 && (
                <div className="flex justify-between text-rose-300" data-testid="sdb-discount-line">
                  <span>Discount{discountPct > 0 ? ` (${discountPct}%)` : ""}:</span>
                  <span>- {formatMoney(discountAmount, currency)}</span>
                </div>
              )}
              {taxRate > 0 && (
                <div className="flex justify-between text-slate-400">
                  <span>Tax ({taxRate}%):</span>
                  <span>{formatMoney(taxAmount, currency)}</span>
                </div>
              )}
              <div className={`flex justify-between text-lg font-bold pt-2 border-t border-slate-700 ${
                isInvoice ? "text-emerald-400" : "text-blue-400"
              }`}>
                <span>Total:</span>
                <span>{formatMoney(total, currency)}</span>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className={`px-6 py-2 rounded-lg text-white text-xs font-bold shadow-md transition disabled:opacity-50 ${
                  isInvoice
                    ? "bg-emerald-600 hover:bg-emerald-500"
                    : "bg-blue-600 hover:bg-blue-500"
                }`}
              >
                {submitting ? "Creating..." : `Create ${isInvoice ? "Invoice" : "Quotation"}`}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
