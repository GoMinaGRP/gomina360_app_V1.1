"use client";

/**
 * CommandPalette — the "Search or jump to…" surface for the whole shell.
 *
 * Opened from the left rail's search row, from the phone bottom bar, or with
 * ⌘K / Ctrl-K / "/" anywhere in the app (the global listener lives here so the
 * whole product has exactly one quick-jump). It indexes every destination the
 * signed-in user is actually allowed to open — role-gated rows are never
 * teased — plus the business units they can reach, and ranks recents first.
 *
 * Keyboard: ↑/↓ move, Enter opens, Esc closes, Tab cycles; focus is trapped in
 * the dialog and returned to the trigger on close. Fully usable on a phone
 * (full-screen sheet) and with a screen reader (combobox/listbox semantics).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, CornerDownLeft, X, Clock, Star, Building2 } from "lucide-react";
import {
  NavCtx,
  NavEntry,
  businessIcon,
  canOpenBusiness,
  groupByKey,
  navEntriesFor,
  scoreEntry,
} from "@/lib/navManifest";
import { loadNavPrefs } from "@/lib/navPrefs";

interface PaletteTarget {
  id: string;
  label: string;
  sub: string;
  Icon: any;
  /** Navigation payload. */
  run: () => void;
  starred?: boolean;
  recent?: boolean;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  ctx: NavCtx;
  businesses: any[];
  accessibleBusinessIds?: number[] | null;
  currentUser: any;
  onSelectTab: (tab: any, bizId?: number | null) => void;
  onRunAction?: (action: "support" | "manageUnits" | "onlineOrdering") => void;
  onToggleFavTab?: (id: string) => void;
}

export default function CommandPalette({
  open,
  onClose,
  ctx,
  businesses,
  accessibleBusinessIds,
  currentUser,
  onSelectTab,
  onRunAction,
  onToggleFavTab,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const entries = useMemo(() => navEntriesFor(ctx), [ctx]);
  const { recents, favTabs } = useMemo(() => {
    const p = loadNavPrefs();
    return { recents: p.recents, favTabs: p.favTabs };
  }, [open]);

  const unitTargets = useMemo<PaletteTarget[]>(() => {
    if (!businesses?.length) return [];
    const reachable = businesses.filter((b) =>
      canOpenBusiness(b, { currentUser, accessibleBusinessIds }),
    );
    return reachable.map((b) => ({
      id: `BIZ:${b.code}`,
      label: b.name,
      sub: `${b.code} · ${b.category || "Unit"}${b.branchLocation ? ` · ${b.branchLocation}` : ""}`,
      Icon: businessIcon(b),
      run: () => onSelectTab(b.code, b.id),
    }));
  }, [businesses, accessibleBusinessIds, currentUser, onSelectTab]);

  const navTargets = useMemo<PaletteTarget[]>(
    () =>
      entries.map((e: NavEntry) => ({
        id: e.id,
        label: e.label,
        sub: groupByKey(e.group).label || "Workspace",
        Icon: e.Icon,
        starred: favTabs.includes(e.id),
        recent: recents.includes(e.id),
        run: () => (e.action && onRunAction ? onRunAction(e.action) : onSelectTab(e.id as any)),
      })),
    [entries, favTabs, recents, onRunAction, onSelectTab],
  );

  const results = useMemo<PaletteTarget[]>(() => {
    const q = query.trim();
    if (!q) {
      // Empty query: quick access first (recents, then favourites), then the
      // rail order — the palette doubles as a "recently used" list.
      const recentFirst = navTargets.filter((t) => t.recent || t.starred);
      const rest = navTargets.filter((t) => !t.recent && !t.starred);
      return [...recentFirst, ...rest, ...unitTargets].slice(0, 24);
    }
    const scored: { t: PaletteTarget; s: number }[] = [];
    entries.forEach((e) => {
      const s = scoreEntry(e, q);
      if (s > 0) {
        const t = navTargets.find((x) => x.id === e.id)!;
        scored.push({ t, s: s + (recents.includes(e.id) ? 4 : 0) + (favTabs.includes(e.id) ? 2 : 0) });
      }
    });
    unitTargets.forEach((t) => {
      const hay = `${t.label} ${t.sub}`.toLowerCase();
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.every((w) => hay.includes(w))) scored.push({ t, s: 6 + (words[0] && hay.startsWith(words[0]) ? 4 : 0) });
    });
    return scored
      .sort((a, b) => b.s - a.s || a.t.label.localeCompare(b.t.label))
      .map((x) => x.t)
      .slice(0, 24);
  }, [query, entries, navTargets, unitTargets, recents, favTabs]);

  /* focus in/out */
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = (document.activeElement as HTMLElement) || null;
    setQuery("");
    setCursor(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open]);

  const close = () => {
    onClose();
    // Return focus to whatever opened the palette (rail row, bottom bar, ⌘K).
    window.setTimeout(() => returnFocusRef.current?.focus?.(), 20);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "Tab") {
        // Simple trap: the dialog only has the input, the close button and the
        // active row, so keeping focus inside means staying on the panel.
        const panel = panelRef.current;
        if (!panel) return;
        const focusables = panel.querySelectorAll<HTMLElement>(
          'input, button, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;

  const choose = (t: PaletteTarget) => {
    t.run();
    close();
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const t = results[cursor];
      if (t) choose(t);
    }
  };

  const q = query.trim().toLowerCase();
  const unitHit = (t: PaletteTarget) => t.id.startsWith("BIZ:");

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-slate-950/70 backdrop-blur-sm p-0 sm:p-6 sm:pt-[10vh]"
      data-testid="cmd-palette"
      role="dialog"
      aria-modal="true"
      aria-label="Search or jump to"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        className="w-full sm:max-w-2xl h-full sm:h-auto bg-slate-900 border border-slate-700 sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3 sm:px-4 py-3 border-b border-slate-700/70">
          <Search className="w-4 h-4 text-emerald-400 shrink-0" />
          <input
            ref={inputRef}
            data-testid="cmd-palette-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onInputKey}
            placeholder="Search destinations, units, “momo”, “stock”, “payroll”…"
            className="flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmd-palette-list"
            aria-autocomplete="list"
          />
          <button
            onClick={close}
            data-testid="cmd-palette-close"
            aria-label="Close search"
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <ul
          id="cmd-palette-list"
          role="listbox"
          className="flex-1 overflow-y-auto py-1.5"
          data-testid="cmd-palette-list"
        >
          {results.length === 0 && (
            <li className="px-4 py-6 text-xs text-slate-400" data-testid="cmd-empty">
              Nothing matches “{query}”. Try “orders”, “stock”, “payroll”, “audit” or a unit name.
            </li>
          )}
          {results.map((t, i) => (
            <li key={t.id} role="none">
              <button
                data-testid={`cmd-item-${t.id}`}
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(t)}
                className={`w-full flex items-center gap-3 px-3 sm:px-4 py-2.5 text-left transition ${
                  i === cursor ? "bg-emerald-500/15 text-white" : "text-slate-200 hover:bg-slate-800/70"
                }`}
              >
                <span
                  className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border ${
                    unitHit(t)
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                      : "bg-slate-800 border-slate-700 text-slate-300"
                  }`}
                >
                  <t.Icon className="w-3.5 h-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold truncate">{t.label}</span>
                  <span className="block text-[10px] text-slate-400 truncate">{t.sub}</span>
                </span>
                {t.recent && !q && (
                  <span title="Recently used" aria-label="Recently used" className="shrink-0">
                    <Clock className="w-3.5 h-3.5 text-slate-500" />
                  </span>
                )}
                {t.starred && <Star className="w-3.5 h-3.5 text-amber-400 shrink-0" fill="currentColor" />}
                {onToggleFavTab && !t.id.startsWith("BIZ:") && (
                  <span
                    role="button"
                    tabIndex={-1}
                    title={t.starred ? "Remove from favourites" : "Add to favourites"}
                    aria-label={t.starred ? "Remove from favourites" : "Add to favourites"}
                    data-testid={`cmd-fav-${t.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleFavTab(t.id);
                    }}
                    className="p-1 rounded hover:bg-slate-700/60 shrink-0"
                  >
                    <Star
                      className={`w-3.5 h-3.5 ${t.starred ? "text-amber-400" : "text-slate-500"}`}
                      fill={t.starred ? "currentColor" : "none"}
                    />
                  </span>
                )}
                <CornerDownLeft
                  className={`w-3.5 h-3.5 shrink-0 ${i === cursor ? "text-emerald-300" : "text-transparent"}`}
                />
              </button>
            </li>
          ))}
        </ul>

        <div className="hidden sm:flex items-center gap-3 px-4 py-2 border-t border-slate-700/70 text-[10px] text-slate-500">
          <span className="flex items-center gap-1">
            <Building2 className="w-3 h-3" /> units and pages in one list
          </span>
          <span className="ml-auto">↑ ↓ navigate · Enter open · Esc close</span>
        </div>
      </div>
    </div>
  );
}
