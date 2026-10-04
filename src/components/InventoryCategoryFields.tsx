"use client";

import React, { useMemo, useState } from "react";
import { Tag, Layers } from "lucide-react";
import {
  INVENTORY_CATEGORIES,
  DEFAULT_INVENTORY_CATEGORY,
  subcategoriesOf,
} from "@/lib/inventoryCategories";

/**
 * Standardized Category / Type + optional Subcategory picker.
 *
 * The umbrella category is ALWAYS one of the GoMina 360 standard categories
 * (src/lib/inventoryCategories.ts) so the customer marketplace can group
 * similar products from every business together. The subcategory keeps the
 * specific wording (Men's Shirts, Cement & Mortar, Fresh Fish…).
 *
 * A pre-existing free-text subcategory keeps its exact value as a selectable
 * option, so opening an old record never rewrites or loses it.
 */
export default function InventoryCategoryFields({
  category,
  subcategory,
  onChange,
  testidPrefix = "inv",
  hint = true,
}: {
  category: string;
  subcategory?: string | null;
  onChange: (next: { category: string; subcategory: string | null }) => void;
  testidPrefix?: string;
  hint?: boolean;
}) {
  const cat = category || DEFAULT_INVENTORY_CATEGORY;
  const sub = (subcategory || "").trim();
  const suggestions = useMemo(() => subcategoriesOf(cat), [cat]);
  const customExisting = sub && !suggestions.includes(sub);
  const [otherMode, setOtherMode] = useState(customExisting);

  const subValue = otherMode ? "__OTHER__" : sub || "__NONE__";

  const changeCategory = (nextCategory: string) => {
    const options = subcategoriesOf(nextCategory);
    const keep = options.includes(sub) ? sub : "";
    setOtherMode(false);
    onChange({ category: nextCategory, subcategory: keep || null });
  };

  return (
    <>
      <div>
        <label className="block text-xs font-semibold text-slate-400 mb-1">
          <span className="inline-flex items-center gap-1.5">
            <Tag className="w-3.5 h-3.5 text-emerald-400" /> Category / Type
          </span>
        </label>
        <select
          value={cat}
          onChange={(e) => changeCategory(e.target.value)}
          data-testid={`${testidPrefix}-category`}
          className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
        >
          {INVENTORY_CATEGORIES.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-400 mb-1">
          <span className="inline-flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-sky-400" /> Subcategory{" "}
            <span className="text-slate-500 font-normal">(optional)</span>
          </span>
        </label>
        <select
          value={subValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__OTHER__") {
              setOtherMode(true);
              onChange({ category: cat, subcategory: sub || null });
              return;
            }
            if (v === "__NONE__") {
              setOtherMode(false);
              onChange({ category: cat, subcategory: null });
              return;
            }
            setOtherMode(false);
            onChange({ category: cat, subcategory: v });
          }}
          data-testid={`${testidPrefix}-subcategory`}
          className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
        >
          <option value="__NONE__">— None —</option>
          {customExisting && <option value={sub}>{sub}</option>}
          {suggestions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
          <option value="__OTHER__">Other (type below)…</option>
        </select>
        {otherMode && (
          <input
            type="text"
            value={sub}
            placeholder="e.g. Ankara Print Dresses"
            onChange={(e) => onChange({ category: cat, subcategory: e.target.value || null })}
            data-testid={`${testidPrefix}-subcategory-custom`}
            className="mt-2 w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
          />
        )}
        {hint && (
          <p className="text-[10px] text-slate-500 mt-1">
            The standard category keeps your products grouped with similar products from every GoMina
            business on the customer marketplace.
          </p>
        )}
      </div>
    </>
  );
}
