"use client";

/**
 * VariantStockEditor — ONE editor for a product's option matrix, shared by
 * every surface that manages stock (Inventory & Stock → Add Stock Item, the
 * record view, and the Boutique module's Sizes & Stock tab).
 *
 * The business model is deliberate and small:
 *   • TWO named axes (usually Size × Colour, but the labels are free: Size,
 *     Shoe size, Capacity, Style, Model, Colour, Pack size, …) so a boutique,
 *     a shoe shop, an electronics shop and a hardware store all use the SAME
 *     editor and the SAME storage.
 *   • Every combination carries its own quantity and reorder point.
 *   • Products with no options never open this editor — the plain quantity
 *     field stays exactly as it was.
 *
 * Storage mapping (typed by @/lib/boutiqueSizes):
 *   axis 1 → inventory_variants.size      axis 2 → inventory_variants.color
 * A colour-only product (axis 1 = "Colour", no second axis) maps to `color`
 * so the storefront reads it as a colour rather than a size.
 */
import React from "react";
import { COLOR_PRESETS, MAX_VARIANTS_PER_ITEM, SIZE_SYSTEMS, cleanVariantValue } from "@/lib/boutiqueSizes";

export interface VariantDraftRow {
  size: string;
  color: string;
  quantity: number;
  minStockThreshold: number;
}

export interface VariantDraft {
  axis1Label: string;
  axis2Label: string;
  sizeSystem: string;
  axis1Values: string[];
  axis2Values: string[];
  rows: VariantDraftRow[];
}

/** Axis labels a business can pick from (free text is allowed too). */
export const AXIS_LABEL_PRESETS = [
  "Size",
  "Shoe size",
  "Capacity",
  "Style",
  "Model",
  "Colour",
  "Pack size",
  "Portion",
  "Variant",
];

/** Labels that describe a SIZE-like axis (so a size system applies). */
const SIZE_LIKE = /size|capacity|pack|portion/i;
const COLOUR_LIKE = /colou?r|finish/i;

export function isSizeLikeAxis(label: string): boolean {
  return SIZE_LIKE.test(String(label || ""));
}

export function isColourLikeAxis(label: string): boolean {
  return COLOUR_LIKE.test(String(label || ""));
}

/**
 * Sensible defaults per business category, so the common case needs no setup:
 * boutique → Size × Colour, shoes → Shoe size × Colour, electronics →
 * Capacity × Colour, hardware → Size × Colour, food → Pack size × Variant.
 */
export function presetAxesFor(category?: string | null): {
  axis1Label: string;
  axis2Label: string;
  sizeSystem: string;
} {
  const c = String(category || "").toLowerCase();
  if (/boutique|fashion|apparel|cloth|tailor/.test(c)) return { axis1Label: "Size", axis2Label: "Colour", sizeSystem: "LETTER" };
  if (/shoe|footwear|sneaker|boot/.test(c)) return { axis1Label: "Shoe size", axis2Label: "Colour", sizeSystem: "SHOE_UK" };
  if (/electronic|tech|phone|computer|gadget|appliance/.test(c))
    return { axis1Label: "Capacity", axis2Label: "Colour", sizeSystem: "FREE" };
  if (/hardware|building|construct/.test(c)) return { axis1Label: "Size", axis2Label: "Colour", sizeSystem: "FREE" };
  if (/restaurant|food|grocer|market|pharm|provision/.test(c))
    return { axis1Label: "Pack size", axis2Label: "Variant", sizeSystem: "FREE" };
  return { axis1Label: "Size", axis2Label: "Colour", sizeSystem: "FREE" };
}

export function emptyDraft(preset?: { axis1Label?: string; axis2Label?: string; sizeSystem?: string }): VariantDraft {
  return {
    axis1Label: preset?.axis1Label || "Size",
    axis2Label: preset?.axis2Label || "Colour",
    sizeSystem: preset?.sizeSystem || "FREE",
    axis1Values: [],
    axis2Values: [],
    rows: [],
  };
}

function rowKey(size: string, color: string): string {
  return `${String(size || "").trim().toLowerCase()}||${String(color || "").trim().toLowerCase()}`;
}

/**
 * Regenerate the combination rows for the current axis values, PRESERVING the
 * quantities/reorder points already typed for combinations that still exist.
 */
export function rebuildDraftRows(draft: VariantDraft): VariantDraft {
  const keep = new Map((draft.rows || []).map((r) => [rowKey(r.size, r.color), r]));
  const v1 = draft.axis1Values.filter(Boolean);
  const v2 = draft.axis2Values.filter(Boolean);
  const rows: VariantDraftRow[] = [];
  if (v1.length === 0 && v2.length === 0) return { ...draft, rows: [] };
  const combos: { size: string; color: string }[] = [];
  const colourFirst = isColourLikeAxis(draft.axis1Label) && v2.length === 0;
  if (v2.length === 0) {
    for (const a of v1) combos.push(colourFirst ? { size: "", color: a } : { size: a, color: "" });
  } else {
    for (const a of v1) for (const b of v2) combos.push({ size: a, color: b });
  }
  for (const c of combos.slice(0, MAX_VARIANTS_PER_ITEM)) {
    const prev = keep.get(rowKey(c.size, c.color));
    rows.push({
      size: c.size,
      color: c.color,
      quantity: prev ? Number(prev.quantity) || 0 : 0,
      minStockThreshold: prev ? Number(prev.minStockThreshold) || 0 : 0,
    });
  }
  return { ...draft, rows };
}

export function draftTotal(draft: VariantDraft): number {
  return (draft.rows || []).reduce((s, r) => s + (Number(r.quantity) || 0), 0);
}

export function draftCombinationCount(draft: VariantDraft): number {
  return (draft.rows || []).length;
}

/** The payload `inventory_variants` expects (axis labels travel separately). */
export function draftToMatrix(draft: VariantDraft): {
  size: string;
  color: string;
  sizeSystem: string;
  quantity: number;
  minStockThreshold: number;
}[] {
  return (draft.rows || [])
    .filter((r) => r.size || r.color)
    .map((r) => ({
      size: cleanVariantValue(r.size, 24),
      color: cleanVariantValue(r.color, 24),
      sizeSystem: draft.sizeSystem || "FREE",
      quantity: Math.max(0, Number(r.quantity) || 0),
      minStockThreshold: Math.max(0, Number(r.minStockThreshold) || 0),
    }));
}

/** Load an existing matrix back into the editor. */
export function draftFromMatrix(
  rows: { size?: string | null; color?: string | null; quantity?: number | null; minStockThreshold?: number | null; sizeSystem?: string | null }[],
  preset?: { axis1Label?: string; axis2Label?: string; sizeSystem?: string },
): VariantDraft {
  const axis1 = preset?.axis1Label || "Size";
  const axis2 = preset?.axis2Label || "Colour";
  const colourFirst = isColourLikeAxis(axis1) && !rows.some((r) => String(r.color || "").trim());
  const axis1Values: string[] = [];
  const axis2Values: string[] = [];
  const draftRows: VariantDraftRow[] = [];
  for (const r of rows) {
    const a = colourFirst ? String(r.color || "").trim() : String(r.size || "").trim();
    const b = colourFirst ? "" : String(r.color || "").trim();
    if (a && !axis1Values.includes(a)) axis1Values.push(a);
    if (b && !axis2Values.includes(b)) axis2Values.push(b);
    draftRows.push({
      size: String(r.size || ""),
      color: String(r.color || ""),
      quantity: Number(r.quantity) || 0,
      minStockThreshold: Number(r.minStockThreshold) || 0,
    });
  }
  return {
    axis1Label: axis1,
    axis2Label: axis2,
    sizeSystem: preset?.sizeSystem || rows.find((r) => r.sizeSystem)?.sizeSystem || "FREE",
    axis1Values,
    axis2Values: colourFirst ? [] : axis2Values,
    rows: draftRows,
  };
}

/**
 * Turn legacy display-only chips ("Red", "10-pack") into real option values so
 * a business can adopt the variant engine without retyping. Quantities start
 * at 0 — the editor never invents stock.
 */
export function draftFromLegacyChips(
  chips: { name?: string | null; note?: string | null }[],
  preset?: { axis1Label?: string; axis2Label?: string; sizeSystem?: string },
): VariantDraft {
  const values = (chips || [])
    .map((c) => cleanVariantValue(String(c?.name || ""), 24))
    .filter(Boolean);
  const base = emptyDraft(preset);
  const d: VariantDraft = { ...base, axis1Values: values };
  return rebuildDraftRows(d);
}

/**
 * Pick the axis labels for an existing product: a shoe size system says "Shoe
 * size", otherwise the business category preset applies. Used when opening a
 * product that was registered before labels existed.
 */
export function axisLabelsFor(
  category: string | null | undefined,
  rows: { sizeSystem?: string | null }[],
): { axis1Label: string; axis2Label: string; sizeSystem: string } {
  const preset = presetAxesFor(category);
  const sys = rows.find((r) => r.sizeSystem)?.sizeSystem || null;
  if (sys && sys.startsWith("SHOE")) {
    return { axis1Label: "Shoe size", axis2Label: preset.axis2Label, sizeSystem: sys };
  }
  if (sys && sys !== "FREE" && sys !== "CUSTOM") return { ...preset, sizeSystem: sys };
  return preset;
}

interface Props {
  draft: VariantDraft;
  onChange: (draft: VariantDraft) => void;
  /** testids are prefixed per surface (inv- / edit- / boutique-). */
  testidPrefix: string;
  disabled?: boolean;
  /** Short helper line under the editor (surface-specific). */
  hint?: string;
}

export default function VariantStockEditor({ draft, onChange, testidPrefix, disabled = false, hint }: Props) {
  const system = SIZE_SYSTEMS.find((s) => s.key === draft.sizeSystem) || SIZE_SYSTEMS[SIZE_SYSTEMS.length - 1];
  const sizeLike = isSizeLikeAxis(draft.axis1Label);
  const colourAxis2 = isColourLikeAxis(draft.axis2Label);
  const preset1: string[] = sizeLike ? [...system.sizes] : [];
  const preset2: string[] = colourAxis2 ? COLOR_PRESETS.map((c) => c.name) : [];
  const total = draftTotal(draft);
  const overflow = draftCombinationCount(draft) > MAX_VARIANTS_PER_ITEM;

  const commit = (patch: Partial<VariantDraft>) => {
    if (disabled) return;
    onChange(rebuildDraftRows({ ...draft, ...patch }));
  };

  const toggleValue = (axis: 1 | 2, value: string) => {
    const key: "axis1Values" | "axis2Values" = axis === 1 ? "axis1Values" : "axis2Values";
    const list: string[] = draft[key];
    const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
    commit({ [key]: next } as Partial<VariantDraft>);
  };

  const addCustom = (axis: 1 | 2, raw: string) => {
    const v = cleanVariantValue(raw, 24);
    if (!v) return;
    const key: "axis1Values" | "axis2Values" = axis === 1 ? "axis1Values" : "axis2Values";
    const list: string[] = draft[key];
    if (!list.includes(v)) commit({ [key]: [...list, v] } as Partial<VariantDraft>);
  };

  const chipCls = (on: boolean) =>
    `px-2 py-1 rounded-lg border text-[11px] font-bold transition ${
      on ? "bg-amber-400 border-amber-400 text-slate-900" : "bg-slate-950 border-slate-700 text-slate-300 hover:border-slate-500"
    }`;

  const AxisValues = ({ axis }: { axis: 1 | 2 }) => {
    const label = axis === 1 ? draft.axis1Label : draft.axis2Label;
    const values = axis === 1 ? draft.axis1Values : draft.axis2Values;
    const presets = axis === 1 ? preset1 : preset2;
    const prefix = axis === 1 ? "a1" : "a2";
    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] uppercase tracking-wide font-bold text-slate-400">
            {label} values (tap to include)
          </span>
          {values.length > 0 && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => commit({ [axis === 1 ? "axis1Values" : "axis2Values"]: [] } as Partial<VariantDraft>)}
              className="text-[10px] text-slate-500 hover:text-rose-300 font-bold"
              data-testid={`${testidPrefix}-${prefix}-clear`}
            >
              clear
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5" data-testid={`${testidPrefix}-${prefix}-chips`}>
          {presets.map((v) => {
            const hex = axis === 2 && colourAxis2 ? COLOR_PRESETS.find((c) => c.name === v)?.hex : null;
            return (
              <button
                key={v}
                type="button"
                disabled={disabled}
                onClick={() => toggleValue(axis, v)}
                data-testid={`${testidPrefix}-${prefix}-chip-${String(v).replace(/\s+/g, "_")}`}
                className={`${chipCls(values.includes(v))} flex items-center gap-1.5`}
              >
                {hex ? <span className="w-3 h-3 rounded-full border border-slate-500" style={{ background: hex }} /> : null}
                {v}
              </button>
            );
          })}
          {values
            .filter((v) => !presets.includes(v))
            .map((v) => (
              <button
                key={v}
                type="button"
                disabled={disabled}
                onClick={() => toggleValue(axis, v)}
                data-testid={`${testidPrefix}-${prefix}-chip-${String(v).replace(/\s+/g, "_")}`}
                className={chipCls(true)}
                title="Custom value — tap to remove"
              >
                {v} ×
              </button>
            ))}
        </div>
        <input
          type="text"
          disabled={disabled}
          placeholder={`Custom ${label.toLowerCase()} — Enter to add${
            axis === 1 ? " (e.g. XL, 256GB, Made-to-measure)" : " (e.g. Navy, Matte Black)"
          }`}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            const el = e.currentTarget;
            addCustom(axis, el.value);
            el.value = "";
          }}
          data-testid={`${testidPrefix}-${prefix}-custom`}
          className="mt-1.5 w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-[11px] text-white disabled:opacity-60"
        />
      </div>
    );
  };

  return (
    <div className="space-y-3" data-testid={`${testidPrefix}-variant-editor`}>
      {/* Axis labels + size system */}
      <div className="grid grid-cols-2 sm:grid-cols-[1fr,1fr,auto] gap-2">
        <div>
          <label className="block text-[10px] uppercase tracking-wide font-bold text-slate-400 mb-1">Option 1</label>
          <input
            type="text"
            list={`${testidPrefix}-axis-labels`}
            disabled={disabled}
            value={draft.axis1Label}
            onChange={(e) => onChange({ ...draft, axis1Label: e.target.value })}
            data-testid={`${testidPrefix}-axis1-label`}
            className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-[11px] text-white"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide font-bold text-slate-400 mb-1">
            Option 2 (optional)
          </label>
          <input
            type="text"
            list={`${testidPrefix}-axis-labels`}
            disabled={disabled}
            value={draft.axis2Label}
            onChange={(e) => onChange({ ...draft, axis2Label: e.target.value })}
            data-testid={`${testidPrefix}-axis2-label`}
            className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-[11px] text-white"
          />
        </div>
        {sizeLike && (
          <div>
            <label className="block text-[10px] uppercase tracking-wide font-bold text-slate-400 mb-1">Size system</label>
            <select
              disabled={disabled}
              value={draft.sizeSystem}
              onChange={(e) => onChange({ ...draft, sizeSystem: e.target.value })}
              data-testid={`${testidPrefix}-size-system`}
              className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-[11px] text-white"
            >
              {SIZE_SYSTEMS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <datalist id={`${testidPrefix}-axis-labels`}>
          {AXIS_LABEL_PRESETS.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
      </div>

      <AxisValues axis={1} />
      <AxisValues axis={2} />

      {/* Combination matrix */}
      <div>
        <div className="flex items-center justify-between mb-1 gap-2">
          <span className="text-[10px] uppercase tracking-wide font-bold text-slate-400">
            Stock per combination ({draftCombinationCount(draft)})
          </span>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              defaultValue={5}
              disabled={disabled || draftCombinationCount(draft) === 0}
              data-testid={`${testidPrefix}-fill-qty`}
              className="w-16 px-2 py-1 bg-slate-950 border border-slate-700 rounded-lg text-[11px] text-white"
            />
            <button
              type="button"
              disabled={disabled || draftCombinationCount(draft) === 0}
              onClick={() => {
                const el = document.querySelector<HTMLInputElement>(`[data-testid="${testidPrefix}-fill-qty"]`);
                const qty = Math.max(0, Number(el?.value) || 0);
                onChange({ ...draft, rows: draft.rows.map((r) => ({ ...r, quantity: qty })) });
              }}
              data-testid={`${testidPrefix}-fill`}
              className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-[10px] font-bold text-slate-200 disabled:opacity-50"
            >
              Fill all
            </button>
          </div>
        </div>

        {draftCombinationCount(draft) === 0 ? (
          <p className="text-[11px] text-slate-500 py-2" data-testid={`${testidPrefix}-matrix-empty`}>
            Pick the values above — one row per combination appears here with its own quantity.
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-700/70" data-testid={`${testidPrefix}-matrix`}>
            <table className="w-full text-left text-[11px]">
              <thead className="bg-slate-900/80 text-slate-400 sticky top-0">
                <tr>
                  <th className="px-2.5 py-1.5">{draft.axis1Label}</th>
                  {draft.axis2Values.length > 0 && <th className="px-2.5 py-1.5">{draft.axis2Label}</th>}
                  <th className="px-2.5 py-1.5 w-24">Quantity</th>
                  <th className="px-2.5 py-1.5 w-24">Reorder at</th>
                </tr>
              </thead>
              <tbody>
                {draft.rows.map((r, i) => (
                  <tr key={`${r.size}|${r.color}|${i}`} className="border-t border-slate-700/60" data-testid={`${testidPrefix}-matrix-row-${i}`}>
                    <td className="px-2.5 py-1.5 text-slate-200 font-semibold">{r.size || (draft.axis2Values.length === 0 ? "" : "—")}</td>
                    {draft.axis2Values.length > 0 && <td className="px-2.5 py-1.5 text-slate-300">{r.color}</td>}
                    <td className="px-1.5 py-1">
                      <input
                        type="number"
                        min={0}
                        disabled={disabled}
                        value={r.quantity}
                        onChange={(e) =>
                          onChange({
                            ...draft,
                            rows: draft.rows.map((x, j) => (j === i ? { ...x, quantity: Math.max(0, Number(e.target.value) || 0) } : x)),
                          })
                        }
                        data-testid={`${testidPrefix}-matrix-qty-${i}`}
                        className="w-full px-2 py-1 bg-slate-950 border border-slate-700 rounded-md text-[11px] text-white"
                      />
                    </td>
                    <td className="px-1.5 py-1">
                      <input
                        type="number"
                        min={0}
                        disabled={disabled}
                        value={r.minStockThreshold}
                        onChange={(e) =>
                          onChange({
                            ...draft,
                            rows: draft.rows.map((x, j) =>
                              j === i ? { ...x, minStockThreshold: Math.max(0, Number(e.target.value) || 0) } : x,
                            ),
                          })
                        }
                        data-testid={`${testidPrefix}-matrix-min-${i}`}
                        className="w-full px-2 py-1 bg-slate-950 border border-slate-700 rounded-md text-[11px] text-white"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between mt-1.5">
          <p className="text-[10px] text-slate-500">
            {hint || "Each combination is stocked, sold and alerted on its own; the product total is their sum."}
          </p>
          <span className="text-[11px] font-black text-amber-300" data-testid={`${testidPrefix}-total`}>
            Total: {total}
          </span>
        </div>
        {overflow && (
          <p className="text-[10px] text-rose-400 font-semibold mt-1" data-testid={`${testidPrefix}-overflow`}>
            A product can have at most {MAX_VARIANTS_PER_ITEM} combinations — remove some values.
          </p>
        )}
      </div>
    </div>
  );
}
