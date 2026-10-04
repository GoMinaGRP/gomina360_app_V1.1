"use client";

import React from "react";
import { Check, X } from "lucide-react";
import { colorHex } from "@/lib/boutiqueSizes";

/**
 * ProductVariantPicker — the shared SIZE / COLOUR chooser used by the public
 * Customer Order Page and the staff Boutique POS.
 *
 * It renders the variant matrix that /api/menu and /api/boutique already
 * project (`product.variantOptions`), disables every combination that has
 * zero stock, and reports the chosen (size, colour) pair upwards. The chosen
 * pair resolves to a concrete `variantId`, which is what actually travels
 * with orders, sales and receipts — and what stock is deducted from.
 */

export type VariantOption = {
  id: number;
  size: string | null;
  color: string | null;
  sizeSystem?: string | null;
  sku?: string | null;
  available: number;
  inStock: boolean;
};

export type VariantSelection = { size: string | null; color: string | null } | null;

export type VariantOptions = {
  sizes: { value: string; system?: string | null; available: number; inStock: boolean }[];
  colors: { value: string; available: number; inStock: boolean }[];
  variants: VariantOption[];
  totalAvailable?: number;
};

export function variantOptionsOf(product: any): VariantOptions | null {
  const vo = product?.variantOptions;
  if (!vo || !Array.isArray(vo.variants) || vo.variants.length === 0) return null;
  const variants: VariantOption[] = vo.variants;
  // Callers may hand over only the raw matrix (staff POS, inventory editors).
  // Derive the size/colour axes from it so the picker works everywhere.
  const sizes =
    Array.isArray(vo.sizes) && vo.sizes.length > 0
      ? vo.sizes
      : deriveAxis(variants, "size");
  const colors =
    Array.isArray(vo.colors) && vo.colors.length > 0
      ? vo.colors
      : deriveAxis(variants, "color");
  return {
    sizes,
    colors,
    variants,
    totalAvailable:
      vo.totalAvailable != null
        ? vo.totalAvailable
        : variants.reduce((sum, v) => sum + (Number(v.available) || 0), 0),
  };
}

/** Build a size/colour axis (with availability) from a raw variant matrix. */
function deriveAxis(variants: VariantOption[], axis: "size" | "color") {
  const map = new Map<string, { value: string; system?: string | null; available: number; inStock: boolean }>();
  for (const v of variants) {
    const value = (axis === "size" ? v.size : v.color) || "";
    if (!value) continue;
    const hit = map.get(value) || { value, system: axis === "size" ? v.sizeSystem ?? null : null, available: 0, inStock: false };
    hit.available += Number(v.available) || 0;
    hit.inStock = hit.inStock || !!v.inStock;
    map.set(value, hit);
  }
  return [...map.values()];
}

/** Is this product sold in sizes/colours? */
export function hasVariants(product: any): boolean {
  return variantOptionsOf(product) != null;
}

/** Resolve the concrete variant row for a (size, colour) pair (null if none). */
export function variantFor(product: any, sel: VariantSelection): VariantOption | null {
  const vo = variantOptionsOf(product);
  if (!vo || !sel) return null;
  const size = sel.size || "";
  const color = sel.color || "";
  return vo.variants.find((v) => (v.size || "") === size && (v.color || "") === color) || null;
}

/** Is the pair a complete, in-stock choice for this product? */
export function isPickComplete(product: any, sel: VariantSelection): boolean {
  const v = variantFor(product, sel);
  return !!v && v.inStock;
}

/** Maximum sellable quantity for the current choice (1 when picking is not
 *  required — callers fall back to the product's own availability). */
export function maxQtyFor(product: any, sel: VariantSelection): number | null {
  const vo = variantOptionsOf(product);
  if (!vo) return null;
  const v = variantFor(product, sel);
  return v ? Math.max(0, v.available) : 0;
}

/** The default pick when a matrix has only one in-stock combination. */
export function defaultPick(product: any): VariantSelection {
  const vo = variantOptionsOf(product);
  if (!vo) return null;
  const inStock = vo.variants.filter((v) => v.inStock);
  if (inStock.length === 1) return { size: inStock[0].size || null, color: inStock[0].color || null };
  return null;
}

function Swatch({ name, tone }: { name: string; tone: "light" | "dark" }) {
  const hex = colorHex(name);
  return (
    <span
      aria-hidden
      className={`inline-block w-3 h-3 rounded-full border ${tone === "dark" ? "border-slate-500" : "border-slate-300"}`}
      style={{ background: hex || (tone === "dark" ? "#334155" : "#e2e8f0") }}
    />
  );
}

export default function ProductVariantPicker({
  product,
  value,
  onChange,
  tone = "light",
  testidPrefix = "oo",
  compact = false,
}: {
  product: any;
  value: VariantSelection;
  onChange: (sel: VariantSelection) => void;
  tone?: "light" | "dark";
  testidPrefix?: string;
  compact?: boolean;
}) {
  const vo = variantOptionsOf(product);
  if (!vo) return null;

  const dark = tone === "dark";
  const sizeAxis = vo.sizes;
  const colorAxis = vo.colors;
  const pickedSize = value?.size ?? null;
  const pickedColor = value?.color ?? null;
  const pid = product?.id;

  // With only one axis present, complete the pair automatically (colourless
  // or sizeless products are still fully valid variant products).
  const pairComplete = (sel: VariantSelection) => {
    if (!sel) return false;
    if (sizeAxis.length > 0 && !sel.size) return false;
    if (colorAxis.length > 0 && !sel.color) return false;
    return true;
  };

  const commit = (next: VariantSelection) => {
    if (!pairComplete(next)) return onChange(next);
    onChange(next);
  };

  /**

   * A size is offered when at least one variant with that size has stock, or
   * when its already-selected colour has stock.
   */
  const sizeAvailable = (size: string) => {
    if (pickedColor) {
      const hit = vo.variants.find((v) => (v.size || "") === size && (v.color || "") === pickedColor);
      return !!hit && hit.inStock;
    }
    return vo.variants.some((v) => (v.size || "") === size && v.inStock);
  };
  const colorAvailable = (color: string) => {
    if (pickedSize) {
      const hit = vo.variants.find((v) => (v.color || "") === color && (v.size || "") === pickedSize);
      return !!hit && hit.inStock;
    }
    return vo.variants.some((v) => (v.color || "") === color && v.inStock);
  };

  const chipBase = (selected: boolean, disabled: boolean) => {
    if (selected) {
      return dark
        ? "border-amber-400 bg-amber-400/20 text-amber-200"
        : "border-amber-400 bg-amber-50 text-slate-900 ring-1 ring-amber-300";
    }
    if (disabled) {
      return dark
        ? "border-slate-700 bg-slate-900/40 text-slate-500 line-through"
        : "border-slate-200 bg-slate-50 text-slate-400 line-through";
    }
    return dark
      ? "border-slate-600 bg-slate-900/60 text-slate-200 hover:border-slate-400"
      : "border-slate-300 bg-white text-slate-700 hover:border-amber-300";
  };

  const labelCls = dark ? "text-[10px] font-bold text-slate-400" : "text-[10px] font-bold text-slate-500";

  return (
    <div className={compact ? "mt-1.5 space-y-1.5" : "mt-2 space-y-2"} data-testid={`${testidPrefix}-variants-${pid}`}>
      {sizeAxis.length > 0 && (
        <div>
          <div className="flex items-center justify-between">
            <span className={`${labelCls} uppercase tracking-wide`}>Size</span>
            {pickedSize && (
              <span className={dark ? "text-[10px] text-slate-400" : "text-[10px] text-slate-500"}>
                {sizeAxis.find((s) => s.value === pickedSize)?.available ?? 0} left
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {sizeAxis.map((s) => {
              const available = sizeAvailable(s.value);
              const selected = pickedSize === s.value;
              return (
                <button
                  key={s.value}
                  type="button"
                  disabled={!available}
                  title={available ? `Size ${s.value} — in stock` : `Size ${s.value} — out of stock`}
                  onClick={() => {
                    if (selected) return commit(colorAxis.length > 0 ? { size: null, color: pickedColor } : null);
                    commit({ size: s.value, color: pickedColor });
                  }}
                  className={`px-2 py-0.5 rounded-md border text-[11px] font-bold transition disabled:cursor-not-allowed ${chipBase(selected, !available)}`}
                  data-testid={`${testidPrefix}-size-${pid}-${s.value.replace(/\s+/g, "_")}`}
                >
                  {s.value}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {colorAxis.length > 0 && (
        <div>
          <span className={`${labelCls} uppercase tracking-wide`}>Colour</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {colorAxis.map((c) => {
              const available = colorAvailable(c.value);
              const selected = pickedColor === c.value;
              return (
                <button
                  key={c.value}
                  type="button"
                  disabled={!available}
                  title={available ? `${c.value} — in stock` : `${c.value} — out of stock`}
                  onClick={() => {
                    if (selected) return commit(sizeAxis.length > 0 ? { size: pickedSize, color: null } : null);
                    commit({ size: pickedSize, color: c.value });
                  }}
                  className={`px-2 py-0.5 rounded-md border text-[11px] font-bold transition flex items-center gap-1 disabled:cursor-not-allowed ${chipBase(selected, !available)}`}
                  data-testid={`${testidPrefix}-color-${pid}-${c.value.replace(/\s+/g, "_")}`}
                >
                  <Swatch name={c.value} tone={tone} />
                  {c.value}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {(() => {
        if (!pairComplete(value)) {
          const need = [
            sizeAxis.length > 0 && !pickedSize ? "a size" : null,
            colorAxis.length > 0 && !pickedColor ? "a colour" : null,
          ].filter(Boolean).join(" & ");
          return (
            <div
              className={`text-[10px] font-bold ${dark ? "text-amber-300" : "text-amber-700"}`}
              data-testid={`${testidPrefix}-variant-hint-${pid}`}
            >
              Choose {need} to continue
            </div>
          );
        }
        const v = variantFor(product, value);
        if (!v || !v.inStock) {
          return (
            <div className={`text-[10px] font-bold ${dark ? "text-rose-300" : "text-rose-600"}`} data-testid={`${testidPrefix}-variant-out-${pid}`}>
              <X className="inline w-3 h-3 mr-0.5" /> That combination is out of stock
            </div>
          );
        }
        return (
          <div className={dark ? "text-[10px] font-bold text-emerald-300" : "text-[10px] font-bold text-emerald-600"} data-testid={`${testidPrefix}-variant-ok-${pid}`}>
            <Check className="inline w-3 h-3 mr-0.5" />
            {[v.size ? `Size ${v.size}` : null, v.color || null].filter(Boolean).join(" · ")} · {v.available} left
          </div>
        );
      })()}
    </div>
  );
}
