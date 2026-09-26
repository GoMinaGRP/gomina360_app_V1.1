"use client";

import React from "react";
import { sectionCatalog, farmModuleOfBusiness } from "@/lib/advisorSections";

/**
 * AdvisorSectionPicker — the ONE Owner-side control for per-section advisor
 * visibility. Used by Register New Account (advisor flow), the Users & Access
 * advisor modal and the Farm Advisors console; every surface writes through
 * the same /api/advisor grants API (sections / sectionsByBusiness).
 *
 * `value` semantics: null = ALL sections (default), [] = none selected,
 * otherwise the exact allowed keys. Toggling the "All sections" chip resets
 * to null; unchecking everything keeps [] (explicitly nothing).
 */

interface Props {
  /** The farm unit being scoped (needs category / code for the catalog). */
  business: { id?: any; name?: string; code?: string; category?: string } | null | undefined;
  /** Current selection (null = all). */
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  /** Compact rendering for dense modals. */
  compact?: boolean;
  testidPrefix?: string;
}

export default function AdvisorSectionPicker({ business, value, onChange, compact = false, testidPrefix = "adv-sec" }: Props) {
  const moduleKey = farmModuleOfBusiness(business || null);
  const catalog = sectionCatalog(moduleKey);
  if (!catalog.length) return null; // non-farm unit — no section catalog

  const all = value === null || value === undefined;
  const allowed = new Set(all ? catalog.map((s) => s.key) : value || []);

  const toggle = (key: string) => {
    if (all) {
      // First customization starts from the full set minus the toggled key.
      onChange(catalog.map((s) => s.key).filter((k) => k !== key));
    } else {
      const next = (value || []).includes(key)
        ? (value || []).filter((k) => k !== key)
        : [...(value || []), key];
      onChange(next);
    }
  };

  return (
    <div className={compact ? "space-y-1.5" : "space-y-2"} data-testid={`${testidPrefix}-picker-${business?.code || business?.id || "x"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
          {business?.name || business?.code || "Unit"} · visible sections
        </span>
        <button
          type="button"
          onClick={() => onChange(null)}
          data-testid={`${testidPrefix}-all-${business?.code || business?.id}`}
          className={`px-2 py-0.5 rounded-full text-[9px] font-black border transition ${
            all
              ? "bg-teal-500/20 border-teal-400/60 text-teal-200"
              : "bg-slate-800 border-slate-600 text-slate-400 hover:border-teal-500/50"
          }`}
        >
          ALL SECTIONS{all ? " ✓" : ""}
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {catalog.map((s) => {
          const on = allowed.has(s.key);
          return (
            <button
              key={s.key}
              type="button"
              title={s.hint}
              onClick={() => toggle(s.key)}
              data-testid={`${testidPrefix}-${business?.code || business?.id}-${s.key}`}
              className={`px-2 py-1 rounded-lg border text-[10px] font-semibold transition ${
                on
                  ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-200"
                  : "bg-slate-800/70 border-slate-700 text-slate-500 hover:border-slate-500"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>
      {!all && (value || []).length === 0 && (
        <p className="text-[9px] text-amber-300/90">No section selected — the advisor will see a locked notice on this unit.</p>
      )}
    </div>
  );
}
