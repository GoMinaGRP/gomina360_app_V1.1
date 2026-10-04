"use client";

/**
 * BusinessScopeBar — the ONE scope control (Owner → Unit → Type + search).
 *
 * Replaces the per-screen business <select> soup: every affected screen renders
 * this instead, so the default ("My Workspace"), the grouping (units by Owner),
 * the per-group counts, the type list (derived from the CURRENT owner scope —
 * never a stale global list) and the search behaviour are identical everywhere.
 *
 * The Owner control is only rendered when the caller may see more than one
 * owner (Super Admin). For normal owners, managers, workers and auditors the
 * bar collapses to the unit + type pickers over their own permitted units —
 * exactly the list they had before, just grouped, counted and searchable.
 *
 * The unit list opens in a PORTAL (same reason as AddressAutocomplete): the
 * surrounding cards use overflow-hidden, which would clip an inline dropdown.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Building2, ChevronDown, Search, X } from "lucide-react";
import {
  ScopeOwner,
  ScopeSelection,
  ScopeType,
  ScopeUnit,
  matchesUnit,
  scopeLabel,
  unitsInScope,
} from "@/lib/businessScope";

type Props = {
  units: ScopeUnit[];
  owners: ScopeOwner[];
  types: ScopeType[];
  selection: ScopeSelection;
  onChange: (next: ScopeSelection) => void;
  /** Show the Owner picker (Super Admin / multi-owner callers only). */
  showOwner?: boolean;
  /** data-testid prefix, e.g. "aud" → aud-scope-owner / -unit / -type / -search. */
  testid?: string;
  /** Search box appears from this many candidate units onward (default 8). */
  searchFrom?: number;
  className?: string;
  /** Locked to a single unit (branch-manager style screens) — renders a chip. */
  lockedToUnit?: boolean;
  /** Extra explanation under the Owner control (e.g. "also moves the app lens"). */
  ownerHint?: string;
};

const selectCls =
  "w-full px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 text-[11px] font-semibold focus:outline-none focus:border-teal-500/70";
const labelCls = "block text-[9px] font-bold uppercase tracking-wider text-slate-500 mb-1";

export default function BusinessScopeBar({
  units,
  owners,
  types,
  selection,
  onChange,
  showOwner = false,
  testid = "scope",
  searchFrom = 8,
  className = "",
  lockedToUnit = false,
  ownerHint,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mounted, setMounted] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({ position: "fixed", top: 0, left: 0, visibility: "hidden" });
  useEffect(() => setMounted(true), []);

  const ownerScoped = useMemo(() => unitsInScope(units, { ownerId: selection.ownerId, typeKey: "ALL" }), [units, selection.ownerId]);
  const typeScoped = useMemo(
    () => unitsInScope(units, { ownerId: selection.ownerId, typeKey: selection.typeKey }),
    [units, selection.ownerId, selection.typeKey],
  );
  const candidates = useMemo(() => typeScoped.filter((u) => matchesUnit(u, query)), [typeScoped, query]);
  const showSearch = typeScoped.length >= searchFrom || query.length > 0;
  const multiOwner = owners.length > 1;
  const selectedUnit = selection.unitId === "ALL" ? null : units.find((u) => u.id === Number(selection.unitId)) || null;

  // Portal panel geometry (anchor under the button; flip up when there's no room).
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const place = () => {
      const r = btnRef.current!.getBoundingClientRect();
      const width = Math.min(Math.max(r.width, 260), Math.max(260, window.innerWidth - 24));
      const maxH = 320;
      const below = window.innerHeight - r.bottom;
      const top = below < maxH + 16 && r.top > below ? Math.max(8, r.top - maxH - 6) : r.bottom + 6;
      const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - width - 8));
      setPanelStyle({ position: "fixed", top, left, width, maxHeight: maxH, visibility: "visible", zIndex: 9999 });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const groupsFor = (rows: ScopeUnit[]) => {
    if (!multiOwner) return [{ owner: null as ScopeOwner | null, rows }];
    const byOwner = new Map<number, ScopeUnit[]>();
    for (const u of rows) {
      if (!byOwner.has(u.ownerId)) byOwner.set(u.ownerId, []);
      byOwner.get(u.ownerId)!.push(u);
    }
    const order = owners.map((o) => o.id).filter((id) => byOwner.has(id));
    for (const id of byOwner.keys()) if (!order.includes(id)) order.push(id);
    return order.map((id) => ({
      owner: owners.find((o) => o.id === id) || { id, name: byOwner.get(id)![0].ownerName, units: byOwner.get(id)!.length, isMine: false },
      rows: byOwner.get(id)!,
    }));
  };

  const pick = (next: Partial<ScopeSelection>) => onChange({ ...selection, ...next });

  if (lockedToUnit) {
    return (
      <div className={`text-[10px] text-slate-400 ${className}`} data-testid={`${testid}-scope-chip`}>
        Scope locked to <span className="font-bold text-slate-200">{selectedUnit?.name || "the assigned unit"}</span>
      </div>
    );
  }

  return (
    <div className={`flex flex-wrap items-end gap-2 ${className}`} data-testid={`${testid}-scope`}>
      {showOwner && multiOwner && (
        <div className="min-w-[150px] flex-1 sm:flex-none">
          <label className={labelCls} htmlFor={`${testid}-scope-owner`}>Owner / Organization</label>
          <select
            id={`${testid}-scope-owner`}
            data-testid={`${testid}-scope-owner`}
            className={selectCls}
            value={String(selection.ownerId)}
            onChange={(e) => {
              const v = e.target.value;
              const ownerId = v === "MY" || v === "ALL" ? (v as "MY" | "ALL") : Number(v);
              onChange({ ownerId, unitId: "ALL", typeKey: "ALL" });
              setQuery("");
            }}
          >
            {owners.some((o) => o.isMine) && <option value="MY">My Workspace ({owners.find((o) => o.isMine)?.units ?? 0})</option>}
            <option value="ALL">All owners ({units.length})</option>
            {owners.filter((o) => !o.isMine).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} ({o.units}){o.status && o.status !== "ACTIVE" ? ` · ${o.status}` : ""}
              </option>
            ))}
          </select>
          {ownerHint && <p className="mt-0.5 text-[9px] text-slate-500 leading-tight">{ownerHint}</p>}
        </div>
      )}

      <div className="min-w-[190px] flex-1">
        <label className={labelCls}>Business / Unit</label>
        <button
          ref={btnRef}
          type="button"
          data-testid={`${testid}-scope-unit`}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`${selectCls} flex items-center gap-2 text-left`}
        >
          <Building2 className="w-3.5 h-3.5 text-teal-400 shrink-0" />
          <span className="truncate">
            {selectedUnit ? (
              <>
                {selectedUnit.name}
                <span className="text-slate-400 font-normal"> · {selectedUnit.code || selectedUnit.typeLabel}</span>
              </>
            ) : (
              <>All units <span className="text-slate-400 font-normal">({typeScoped.length})</span></>
            )}
          </span>
          <ChevronDown className={`w-3.5 h-3.5 ml-auto shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {types.length > 1 && (
        <div className="min-w-[130px] flex-1 sm:flex-none">
          <label className={labelCls} htmlFor={`${testid}-scope-type`}>Business type</label>
          <select
            id={`${testid}-scope-type`}
            data-testid={`${testid}-scope-type`}
            className={selectCls}
            value={selection.typeKey}
            onChange={(e) => onChange({ ...selection, typeKey: e.target.value, unitId: "ALL" })}
          >
            <option value="ALL">All types ({ownerScoped.length})</option>
            {types.map((t) => (
              <option key={t.key} value={t.key}>{t.label} ({t.count})</option>
            ))}
          </select>
        </div>
      )}

      <div className="basis-full sm:basis-auto text-[10px] text-slate-400 sm:pb-1.5" data-testid={`${testid}-scope-chip`}>
        {scopeLabel(selection, units)}
      </div>

      {open && mounted &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            data-testid={`${testid}-scope-panel`}
            style={panelStyle}
            className="rounded-xl border border-slate-600 bg-slate-900 shadow-2xl shadow-black/60 overflow-hidden flex flex-col"
          >
            {showSearch && (
              <div className="p-2 border-b border-slate-700/70 shrink-0">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search units by name, code, type…"
                    data-testid={`${testid}-scope-search`}
                    className="w-full pl-8 pr-7 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-[11px] text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-teal-500/70"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="overflow-y-auto py-1">
              <button
                type="button"
                data-testid={`${testid}-scope-unit-all`}
                onClick={() => {
                  pick({ unitId: "ALL" });
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 text-[11px] hover:bg-slate-800 ${selection.unitId === "ALL" ? "text-teal-300 font-bold" : "text-slate-200"}`}
              >
                All units in this scope <span className="text-slate-500">({typeScoped.length})</span>
              </button>
              {groupsFor(candidates).map(({ owner, rows }) => (
                <div key={owner ? owner.id : "single"}>
                  {owner && (
                    <div className="px-3 pt-2 pb-1 text-[9px] font-black uppercase tracking-wider text-slate-500">
                      {owner.isMine ? "My Workspace" : owner.name}
                      <span className="text-slate-600"> · {rows.length}</span>
                    </div>
                  )}
                  {rows.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      role="option"
                      aria-selected={Number(selection.unitId) === u.id}
                      data-testid={`${testid}-scope-unit-${u.id}`}
                      onClick={() => {
                        pick({ unitId: u.id });
                        setOpen(false);
                        setQuery("");
                      }}
                      className={`w-full text-left px-3 py-2 hover:bg-slate-800 ${Number(selection.unitId) === u.id ? "bg-slate-800/70" : ""}`}
                    >
                      <div className={`text-[11px] font-semibold truncate ${Number(selection.unitId) === u.id ? "text-teal-300" : "text-slate-100"}`}>
                        {u.name}
                      </div>
                      <div className="text-[9px] text-slate-500 truncate">
                        {u.code || "—"} · {u.typeLabel}
                        {multiOwner && selection.ownerId === "ALL" ? ` · ${u.ownerName}` : ""}
                      </div>
                    </button>
                  ))}
                </div>
              ))}
              {candidates.length === 0 && (
                <div className="px-3 py-4 text-center text-[11px] text-slate-500">
                  No units match “{query}” in this scope.
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
