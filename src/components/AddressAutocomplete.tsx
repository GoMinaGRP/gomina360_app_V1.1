"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MapPin, PencilLine, Search, X } from "lucide-react";

export interface AddressSuggestion {
  place_id: number | string;
  label: string;
  lat: number;
  lng: number;
  bbox?: [number, number, number, number]; // [s,w,n,e]
}

interface Props {
  value: string;
  onChange: (s: string) => void;
  /** Bias suggestions to this lat/lng (branch pin or customer's current fix). */
  bias?: { lat: number; lng: number } | null;
  /** Fired when the user picks or edits a suggestion — parents can fly the
   *  map to the chosen coordinate. */
  onPick?: (s: AddressSuggestion) => void;
  /** Fired when the user clears the field via the ✕ — parent usually clears
   *  the delivery pin together with the address. */
  onClear?: () => void;
  /** Placeholder text. */
  placeholder?: string;
  /** Test id prefix. */
  prefix?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Amazon-style address autocomplete:
 *   • type → debounced server-side geocode (/api/geocode);
 *   • dropdown shows 3–8 matches, weighted to the nearby branch;
 *   • ENTER / CLICK picks → field becomes the full formatted label, onPick
 *     fires with coordinates so the map flies there;
 *   • customer can freely edit the field after picking (e.g. add apartment,
 *     landmark, "near blue gate" etc.) without losing the pin;
 *   • ✕ clears;
 *   • Escape dismisses; ↑/↓ navigate.
 */
export default function AddressAutocomplete({
  value,
  onChange,
  bias,
  onPick,
  onClear,
  placeholder = "Delivery address (area / landmark / house no.)",
  prefix = "addr",
  disabled,
  className = "",
}: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [active, setActive] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const pickedLabelRef = useRef<string>("");
  const ignoreNextBlur = useRef(false);

  const fetchSuggestions = useCallback(
    (query: string) => {
      if (query.trim().length < 3) {
        setSuggestions([]);
        setLoading(false);
        setOpen(false);
        return;
      }
      const myId = ++reqIdRef.current;
      setLoading(true);
      const params = new URLSearchParams({ q: query.trim() });
      if (bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lng)) {
        params.set("ll", `${bias.lat},${bias.lng}`);
      }
      fetch(`/api/geocode?${params.toString()}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((data) => {
          if (myId !== reqIdRef.current) return; // stale
          const results: AddressSuggestion[] = Array.isArray(data?.results) ? data.results : [];
          setSuggestions(results);
          setActive(results.length ? 0 : -1);
          setOpen(results.length > 0);
        })
        .catch(() => {
          if (myId !== reqIdRef.current) return;
          setSuggestions([]);
          setOpen(false);
        })
        .finally(() => {
          if (myId === reqIdRef.current) setLoading(false);
        });
    },
    [bias?.lat, bias?.lng],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Only fire autocomplete while the customer is typing freely (not after
    // they just picked or cleared) — avoids thrashing the dropdown after a
    // click-select.
    const trimmed = value.trim();
    if (pickedLabelRef.current && trimmed === pickedLabelRef.current.trim()) {
      return;
    }
    debounceRef.current = setTimeout(() => fetchSuggestions(trimmed), 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, fetchSuggestions]);

  const choose = (s: AddressSuggestion) => {
    pickedLabelRef.current = s.label;
    onChange(s.label);
    setOpen(false);
    setSuggestions([]);
    setActive(-1);
    onPick?.(s);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) {
      if (e.key === "Escape") {
        setOpen(false);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0 && suggestions[active]) choose(suggestions[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  useEffect(() => {
    // scroll the active option into view
    const item = listRef.current?.querySelector<HTMLLIElement>(`[data-idx="${active}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const handleBlur = () => {
    if (ignoreNextBlur.current) { ignoreNextBlur.current = false; return; }
    // Delay so the click-on-option registers before we hide the list.
    setTimeout(() => setOpen(false), 120);
  };

  return (
    <div className={`relative ${className}`} data-testid={`${prefix}-root`}>
      <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
      <input
        ref={inputRef}
        type="text"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          pickedLabelRef.current = ""; // invalidate "picked" marker so autocomplete re-fires
          onChange(e.target.value);
        }}
        onFocus={() => { if (suggestions.length) setOpen(true); }}
        onBlur={handleBlur}
        onKeyDown={handleKey}
        placeholder={placeholder}
        className="w-full pl-9 pr-16 py-2.5 bg-white border border-slate-300 focus:border-amber-500 focus:ring-1 focus:ring-amber-400 rounded-xl text-sm text-slate-900 placeholder-slate-400 outline-none disabled:opacity-60"
        data-testid={`${prefix}-input`}
      />
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
        {value ? (
          <button
            type="button"
            onMouseDown={() => { ignoreNextBlur.current = true; }}
            onClick={() => {
              onChange("");
              pickedLabelRef.current = "";
              setSuggestions([]);
              setOpen(false);
              onClear?.();
              inputRef.current?.focus();
            }}
            className="w-6 h-6 flex items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            title="Clear address"
            aria-label="Clear address"
            data-testid={`${prefix}-clear`}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : (
          <PencilLine className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
        )}
      </div>

      {open && suggestions.length > 0 && (
        <ul
          ref={listRef}
          className="absolute z-50 mt-1 w-full max-h-72 overflow-auto rounded-xl border border-slate-200 bg-white shadow-xl py-1 text-[13px] text-slate-800"
          data-testid={`${prefix}-list`}
          role="listbox"
        >
          <li className="px-3 py-1 text-[10px] uppercase tracking-wider text-slate-400 flex items-center gap-1">
            <MapPin className="w-3 h-3" /> Suggested addresses
          </li>
          {suggestions.map((s, i) => (
            <li
              key={s.place_id}
              data-idx={i}
              role="option"
              aria-selected={i === active}
              onMouseDown={() => { ignoreNextBlur.current = true; }}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(s)}
              className={`cursor-pointer px-3 py-2 flex items-start gap-2 ${i === active ? "bg-amber-50" : "hover:bg-slate-50"}`}
              data-testid={`${prefix}-opt-${i}`}
            >
              <MapPin className={`w-4 h-4 mt-0.5 shrink-0 ${i === 0 && bias ? "text-emerald-600" : "text-slate-400"}`} />
              <span className="min-w-0 flex-1 break-words">{s.label}</span>
            </li>
          ))}
          <li className="px-3 py-1.5 text-[10px] text-slate-500 border-t border-slate-100">
            Can&apos;t find it? Type any landmark or house number — you can edit this after picking.
          </li>
        </ul>
      )}
    </div>
  );
}
