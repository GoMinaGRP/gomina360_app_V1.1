"use client";

import React from "react";
import { FormField, FormSelect } from "@/components/shared/ModuleFormFields";

/**
 * SaleFields — the shared "Record Sale" field group (P1.1).
 *
 * Five enterprise modules (BusinessDashboard, BlockFactory, Electronics,
 * Hardware, Restaurant) hand-rolled the same sale form — customer, product
 * from live stock, quantity × unit price, payment method, discounts and a
 * running total — with only labels and presentation drifting apart. This
 * primitive renders that field group ONCE, in the two shapes the modules
 * actually shipped:
 *
 *   variant="counter" — customer-first layout with a compact
 *                        "Name (N in stock)" product list and a plain total
 *                        line (Electronics / Hardware / Restaurant).
 *   variant="stock"   — product-first layout, sellable items sorted first,
 *                        out-of-stock options disabled, quantity capped at
 *                        stock and a rich "Total due … Stock after sale"
 *                        box (BusinessDashboard / BlockFactory).
 *
 * The field keys written into the form state (customerName, inventoryId,
 * quantity, sellingPrice, paymentMethod, discountPct, discount,
 * customPriceReason, notes) are IDENTICAL to the legacy forms, so module
 * submit handlers are unchanged. Suites that drive these forms by label
 * text ("Quantity", "Save") keep working unchanged.
 */

export interface SaleTotals {
  qty: number;
  total: number;
  pct: number;
  net: number;
}

/** One place for the qty × price − discount% math every module re-derived. */
export function computeSaleTotals(f: any, selectedItem: any): SaleTotals {
  const qty = Number(f.quantity) || 0;
  const price = f.sellingPrice ? Number(f.sellingPrice) : selectedItem?.sellingPriceGhs || 0;
  const total = qty * price;
  const pct = Math.max(0, Math.min(100, Number(f.discountPct) || 0));
  const net = Math.round(total * (1 - pct / 100) * 100) / 100;
  return { qty, total, pct, net };
}

/** Option row shared by both variants when no custom list is supplied. */
export interface SaleProductOption {
  v: any;
  l: string;
  disabled?: boolean;
}

export function stockDetailOptions(inventory: any[], sortKey?: (a: any, b: any) => number): SaleProductOption[] {
  const list = [...(inventory || [])];
  if (sortKey) list.sort(sortKey);
  return list.map((i: any) => {
    const out = (i.quantity || 0) <= 0 || i.status === "OUT_OF_STOCK";
    return {
      v: i.id,
      disabled: out,
      l: `${i.name} • ${out ? "OUT OF STOCK" : `${Number(i.quantity).toLocaleString()} ${i.unit} available`} • ${i.sellingPriceGhs} GH₵`,
    };
  });
}

// The pair itself lives in src/components/shared/ModuleFormFields.tsx — this
// file only supplies the sale-specific layout around it.
const Field = (p: any) => <FormField {...p} />;

function Select({ f, set, label, k, opts, ...rest }: any) {
  return (
    <div {...rest}>
      <FormSelect f={f} set={set} label={label} k={k} opts={opts} />
    </div>
  );
}

const PAYMENT_METHODS = ["CASH", "MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER", "POS_CARD"];

export interface SaleFieldsProps {
  f: any;
  set: (k: string, v: any) => void;
  inventory: any[];
  selectedItem?: any;
  /** "counter" (Electronics/Hardware/Restaurant) | "stock" (BusinessDashboard/BlockFactory) */
  variant?: "counter" | "stock";
  /** Counter variant: label above the product select. */
  productLabel?: string;
  /** Counter variant: text of the empty option. */
  productEmptyLabel?: string;
  /** Counter variant: how each in-stock item reads. Default "Name (N in stock)". */
  productOptionText?: (item: any) => string;
  /** Stock variant: fully-built option list (sorted, out-of-stock disabled). */
  productOptions?: SaleProductOption[];
  /** Stock variant: label above the product select. */
  productSelectLabel?: string;
  requireCustomer?: boolean;
  /** Counter variant: include the flat "Discount (GH₵)" field. */
  discountFlat?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  showNotes?: boolean;
  /** Counter variant: render the total line. */
  showTotal?: boolean;
  totalTestId?: string;
  totalTone?: string;
  /** Stock variant: tone of the total-due box (module accent). */
  stockTone?: "emerald" | "amber";
  formatMoney?: (n: any, c?: any, compact?: boolean) => string;
  currency?: string;
}

export default function SaleFields({
  f,
  set,
  inventory,
  selectedItem,
  variant = "counter",
  productLabel = "Product",
  productEmptyLabel = "— select product —",
  productOptionText,
  productOptions,
  productSelectLabel = "Product (from live stock — sellable items first)",
  requireCustomer = true,
  discountFlat = true,
  reasonLabel = "Custom price reason (if discounted)",
  reasonPlaceholder,
  showNotes = true,
  showTotal = true,
  totalTestId,
  totalTone = "text-cyan-300",
  stockTone = "emerald",
  formatMoney,
  currency = "GH₵",
}: SaleFieldsProps) {
  const totals = computeSaleTotals(f, selectedItem);
  const money = formatMoney || ((n: number) => `${currency} ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  const counterOptions: SaleProductOption[] =
    productOptions ||
    [
      { v: "", l: productEmptyLabel },
      ...(inventory || []).map((i: any) => ({
        v: i.id,
        l: productOptionText ? productOptionText(i) : `${i.name} (${i.quantity} in stock)`,
      })),
    ];

  if (variant === "stock") {
    const tone =
      stockTone === "amber"
        ? "bg-amber-500/10 border-amber-500/30 text-amber-200"
        : "bg-emerald-500/10 border-emerald-500/30 text-emerald-200";
    return (
      <>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="block text-[10px] text-slate-400 font-semibold mb-1">{productSelectLabel}</label>
            <select
              required
              value={f.inventoryId ?? ""}
              onChange={(e) => set("inventoryId", e.target.value)}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs"
            >
              <option value="" disabled>— Select product —</option>
              {(productOptions || []).map((o) => (
                <option key={String(o.v)} value={o.v} disabled={!!o.disabled}>{o.l}</option>
              ))}
            </select>
          </div>
          <Field f={f} set={set} label="Quantity" k="quantity" t="number" required min={1} max={selectedItem?.quantity} />
          <Field
            f={f}
            set={set}
            label={`Unit Price (GH₵)${selectedItem ? ` — default ${selectedItem.sellingPriceGhs}` : ""}`}
            k="sellingPrice"
            t="number"
            step="0.01"
            placeholder={selectedItem ? String(selectedItem.sellingPriceGhs) : ""}
          />
          <Field f={f} set={set} label="Customer Name" k="customerName" placeholder="Walk-in Customer" />
          <Field f={f} set={set} label="Customer Phone" k="customerPhone" />
          <Select f={f} set={set} label="Payment" k="paymentMethod" opts={PAYMENT_METHODS.map((p) => ({ v: p, l: p }))} />
          <Field f={f} set={set} label="Discount %" k="discountPct" t="number" step="0.5" min={0} max={100} placeholder="auto-calculates" />
          <Field f={f} set={set} label={reasonLabel} k="customPriceReason" placeholder={reasonPlaceholder || "only if price changed"} />
        </div>
        {selectedItem && (
          <div className={`p-3 rounded-lg border text-xs ${tone}`}>
            Total due: <span className="font-black">{money(totals.net)}</span>
            {totals.pct > 0 && (
              <span className="ml-1">
                ({totals.pct}% discount{stockTone === "emerald" ? ` − ${currency} ${(totals.total - totals.net).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ""})
              </span>
            )}
            {" "}— sells {totals.qty} {selectedItem.unit} of “{selectedItem.name}”. Stock after sale:{" "}
            {Math.max(0, (selectedItem.quantity || 0) - totals.qty).toLocaleString()}.
          </div>
        )}
        {showNotes && <Field f={f} set={set} label="Notes" k="notes" />}
      </>
    );
  }

  // ── counter variant ────────────────────────────────────────────────────
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field f={f} set={set} label="Customer Name" k="customerName" required={requireCustomer} />
        <Field f={f} set={set} label="Customer Phone" k="customerPhone" />
      </div>
      <Select f={f} set={set} label={productLabel} k="inventoryId" opts={counterOptions} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field f={f} set={set} label="Quantity" k="quantity" t="number" required min={1} />
        <Field
          f={f}
          set={set}
          label={`Unit Price (${currency})`}
          k="sellingPrice"
          t="number"
          step="0.01"
          placeholder={selectedItem ? String(selectedItem.sellingPriceGhs) : "auto"}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Select f={f} set={set} label="Payment" k="paymentMethod" opts={PAYMENT_METHODS.map((p) => ({ v: p, l: p }))} />
        <Field f={f} set={set} label="Discount %" k="discountPct" t="number" step="0.5" min={0} max={100} placeholder="auto" />
        {discountFlat && <Field f={f} set={set} label={`Discount (${currency})`} k="discount" t="number" step="0.01" min={0} />}
      </div>
      <Field f={f} set={set} label={reasonLabel} k="customPriceReason" placeholder={reasonPlaceholder} />
      {showNotes && <Field f={f} set={set} label="Notes" k="notes" />}
      {showTotal && totals.total > 0 && (
        <div className={`text-xs font-bold ${totalTone}`} data-testid={totalTestId}>
          Total: {formatMoney ? formatMoney(totals.total, currency) : `${currency} ${totals.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
        </div>
      )}
    </>
  );
}
