"use client";

import React, { useId } from "react";
import { MapPin, Building2, Navigation } from "lucide-react";
import { REGION_NAMES, getDistricts, getRegionCapital } from "@/lib/ghanaLocations";

export interface LocationValue {
  region: string;
  district: string;
  town: string;
}

interface LocationSelectorProps {
  value: LocationValue;
  onChange: (next: LocationValue) => void;
  /** Compact = tighter paddings for use inside modals. */
  compact?: boolean;
  /** Show the section heading above the three fields. */
  showHeading?: boolean;
  headingLabel?: string;
  /** Marks Region as required in the UI. */
  required?: boolean;
  /** Optional accent colour class for focus rings. */
  accent?: "emerald" | "cyan" | "amber";
  disabled?: boolean;
}

/**
 * GoMina 360 standardized Ghana location picker.
 *
 * Region  → strict dropdown of all 16 official regions
 * District→ dropdown of that region's MMDAs, but also accepts free text
 * Town    → free text with suggestions (region capital hint)
 *
 * Changing the Region clears the District so the cascade stays valid.
 */
export default function LocationSelector({
  value,
  onChange,
  compact = false,
  showHeading = true,
  headingLabel = "Location (Ghana)",
  required = false,
  accent = "emerald",
  disabled = false,
}: LocationSelectorProps) {
  const uid = useId();
  const districtListId = `districts-${uid}`;
  const townListId = `towns-${uid}`;

  const districts = getDistricts(value.region);
  const capital = getRegionCapital(value.region);

  const focusRing =
    accent === "cyan"
      ? "focus:border-cyan-500"
      : accent === "amber"
      ? "focus:border-amber-500"
      : "focus:border-emerald-500";

  const fieldClass = `w-full ${
    compact ? "px-3 py-2" : "px-3 py-2.5"
  } bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none ${focusRing} disabled:opacity-50`;

  const handleRegion = (region: string) => {
    // Reset district when region changes so the cascade never holds a
    // district that does not belong to the selected region.
    onChange({ region, district: "", town: value.town });
  };

  return (
    <div className="space-y-3">
      {showHeading && (
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
            <MapPin className="w-3.5 h-3.5 text-emerald-400" />
            <span>{headingLabel}</span>
            {required && <span className="text-rose-400">*</span>}
          </label>
          <span className="text-[10px] text-slate-500">
            Region → District → Town
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* ── Region: strict dropdown (16 official regions) ── */}
        <div>
          <label className="block text-[11px] font-semibold text-slate-400 mb-1">
            Region {required && <span className="text-rose-400">*</span>}
          </label>
          <select
            value={value.region}
            required={required}
            disabled={disabled}
            onChange={(e) => handleRegion(e.target.value)}
            className={fieldClass}
          >
            <option value="">Select region…</option>
            {REGION_NAMES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        {/* ── District / MMDA: dropdown list + free text allowed ── */}
        <div>
          <label className="block text-[11px] font-semibold text-slate-400 mb-1">
            District / MMDA
          </label>
          <input
            type="text"
            list={districtListId}
            value={value.district}
            disabled={disabled || !value.region}
            placeholder={
              value.region ? "Select or type district…" : "Choose a region first"
            }
            onChange={(e) =>
              onChange({ ...value, district: e.target.value })
            }
            className={fieldClass}
            autoComplete="off"
          />
          <datalist id={districtListId}>
            {districts.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          {value.region && (
            <p className="text-[10px] text-slate-500 mt-1">
              {districts.length} MMDAs · or type your own
            </p>
          )}
        </div>

        {/* ── Town / Community: free text with hint suggestions ── */}
        <div>
          <label className="block text-[11px] font-semibold text-slate-400 mb-1">
            Town / Community
          </label>
          <input
            type="text"
            list={townListId}
            value={value.town}
            disabled={disabled}
            placeholder="Type town or community…"
            onChange={(e) => onChange({ ...value, town: e.target.value })}
            className={fieldClass}
            autoComplete="off"
          />
          <datalist id={townListId}>
            {capital && <option value={capital} />}
            {value.district && <option value={value.district} />}
          </datalist>
          <p className="text-[10px] text-slate-500 mt-1">Free text entry</p>
        </div>
      </div>
    </div>
  );
}

/** Small read-only badge for displaying a standardized location in tables. */
export function LocationBadge({
  region,
  district,
  town,
}: {
  region?: string | null;
  district?: string | null;
  town?: string | null;
}) {
  if (!region && !district && !town) {
    return <span className="text-slate-500 text-xs">—</span>;
  }
  return (
    <div className="flex items-start gap-1.5">
      <Navigation className="w-3 h-3 text-emerald-400 mt-0.5 shrink-0" />
      <div className="leading-tight">
        <div className="text-xs text-slate-200 font-medium">
          {town || district || region}
        </div>
        <div className="text-[10px] text-slate-400">
          {[district && district !== town ? district : null, region]
            .filter(Boolean)
            .join(" · ") || "—"}
        </div>
      </div>
    </div>
  );
}
