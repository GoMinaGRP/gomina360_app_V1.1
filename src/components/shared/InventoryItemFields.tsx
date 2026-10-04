"use client";

import { FormField, FormSelect, type FieldTone, type NumberMode } from "@/components/shared/ModuleFormFields";

/**
 * The one "new stock item" field grid.
 *
 * Five modules used to re-declare the same eight fields (name, SKU, category,
 * unit, opening quantity, alert threshold, cost, selling price — plus the
 * restaurant's expiry date) with their own wording and their own datalist. The
 * wording stays business-specific via props; the contract (which keys are
 * posted to the shared inventory API) is defined once, here.
 */

export interface InventoryItemFieldsProps {
  f: Record<string, any>;
  set: (k: string, v: any) => void;
  testidPrefix?: string;
  tone?: FieldTone;
  nameLabel?: string;
  namePlaceholder?: string;
  /** Render the name field across both columns (block factory). */
  nameFull?: boolean;
  categoryPlaceholder?: string;
  categoryListId?: string;
  categoryOptions?: readonly string[];
  quantityLabel?: string;
  minLabel?: string;
  qtyStep?: number;
  minStep?: number;
  unit:
    | { mode: "select"; options: readonly string[] }
    | { mode?: "text"; placeholder?: string };
  showCost?: boolean;
  costLabel?: string;
  showSellingPrice?: boolean;
  showExpiry?: boolean;
  expiryHint?: string;
  /** Empty-number handling of the hosting form (default 0). */
  numberMode?: NumberMode;
}

export default function InventoryItemFields({
  f,
  set,
  testidPrefix,
  tone,
  nameLabel = "Item Name",
  namePlaceholder,
  nameFull = false,
  categoryPlaceholder,
  categoryListId,
  categoryOptions,
  quantityLabel = "Opening Quantity",
  minLabel = "Low-Stock Threshold",
  qtyStep,
  minStep,
  unit,
  showCost = true,
  costLabel = "Cost Price (GH₵)",
  showSellingPrice = true,
  showExpiry = false,
  expiryHint,
  numberMode,
}: InventoryItemFieldsProps) {
  const nameField = (
    <FormField
      f={f}
      set={set}
      testidPrefix={testidPrefix}
      tone={tone}
      label={nameLabel}
      k="name"
      required
      placeholder={namePlaceholder}
    />
  );
  return (
    <>
      <div className="grid grid-cols-2 gap-3" data-testid="inv-item-fields">
        {nameFull ? <div className="col-span-2">{nameField}</div> : nameField}
        <FormField f={f} set={set} testidPrefix={testidPrefix} tone={tone} label="SKU" k="sku" placeholder="auto if blank" />
        <FormField
          f={f}
          set={set}
          testidPrefix={testidPrefix}
          tone={tone}
          label="Category"
          k="category"
          placeholder={categoryPlaceholder}
          list={categoryListId}
        />
        {unit.mode === "select" ? (
          <FormSelect f={f} set={set} testidPrefix={testidPrefix} tone={tone} label="Unit" k="unit" opts={unit.options as any} />
        ) : (
          <FormField f={f} set={set} testidPrefix={testidPrefix} tone={tone} label="Unit" k="unit" placeholder={unit.placeholder} />
        )}
        <FormField f={f} set={set} testidPrefix={testidPrefix} tone={tone} numberMode={numberMode} label={quantityLabel} k="quantity" t="number" min={0} step={qtyStep} />
        <FormField f={f} set={set} testidPrefix={testidPrefix} tone={tone} numberMode={numberMode} label={minLabel} k="minStockThreshold" t="number" min={0} step={minStep} />
        {showCost && (
          <FormField f={f} set={set} testidPrefix={testidPrefix} tone={tone} numberMode={numberMode} label={costLabel} k="costPriceGhs" t="number" step="0.01" />
        )}
        {showSellingPrice && (
          <FormField f={f} set={set} testidPrefix={testidPrefix} tone={tone} numberMode={numberMode} label="Selling Price (GH₵)" k="sellingPriceGhs" t="number" step="0.01" />
        )}
        {showExpiry && <FormField f={f} set={set} testidPrefix={testidPrefix} tone={tone} label="Expiry Date" k="expiryDate" t="date" />}
      </div>
      {categoryListId && categoryOptions && (
        <datalist id={categoryListId}>
          {categoryOptions.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      )}
      {showExpiry && expiryHint && <p className="text-[10px] text-slate-500">{expiryHint}</p>}
    </>
  );
}
