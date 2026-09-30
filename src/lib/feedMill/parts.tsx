"use client";

/**
 * Feed-mill shared presentational primitives (P1.2).
 *
 * The Poultry Feed Mill and the Fish Farm Feed Mill are deliberately
 * SEPARATE module components (different species vocabularies, insights and
 * consumption targets), but they render through the same building blocks.
 * These parts are the single source for those blocks — lifted verbatim from
 * the two hand-rolled copies that preceded this lib.
 */
import React, { useEffect } from "react";
import { AlertTriangle, CheckCircle2, X, XCircle } from "lucide-react";
import { FmAlert } from "@/lib/feedMillAnalytics";
import { FEED_UNITS } from "@/lib/feedUnits";

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="block text-[10px] font-semibold text-slate-400 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[9px] text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}

export const inputCls = "w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs focus:border-emerald-500/60 focus:outline-none";

export function Stat({ label, value, sub, color = "emerald", icon: Icon, testid }: any) {
  return (
    <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4" data-testid={testid}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase font-bold text-slate-400">{label}</span>
        {Icon && <Icon className={`w-4 h-4 text-${color}-400`} />}
      </div>
      <div className={`text-lg font-black text-${color}-400 mt-1`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

export function Alerts({ alerts, testid = "fm-alerts" }: { alerts: FmAlert[]; testid?: string }) {
  if (!alerts.length) return null;
  const styles: Record<string, string> = {
    critical: "border-rose-500/40 bg-rose-500/10",
    warning: "border-amber-500/40 bg-amber-500/10",
    normal: "border-emerald-500/40 bg-emerald-500/10",
  };
  const iconOf = (l: string) =>
    l === "critical" ? <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
    : l === "warning" ? <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
    : <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />;
  return (
    <div className="space-y-2" data-testid={testid}>
      {alerts.map((a) => (
        <div key={a.id} className={`rounded-xl border p-3 flex items-start gap-3 ${styles[a.level] || styles.normal}`}>
          {iconOf(a.level)}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[9px] uppercase font-black tracking-wider text-slate-400">{a.category}</span>
              <span className="text-xs font-bold text-white">{a.title}</span>
            </div>
            <p className="text-[11px] text-slate-300 mt-0.5">{a.message}</p>
            {a.recommendation && <p className="text-[10px] text-slate-400 mt-1 italic">→ {a.recommendation}</p>}
          </div>
          {a.value && (
            <div className="text-right shrink-0">
              <div className="text-sm font-black text-white">{a.value}</div>
              {a.threshold && <div className="text-[9px] text-slate-500">{a.threshold}</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ModalShell({ title, icon: Icon, onClose, children, wide }: any) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-2 sm:p-4 overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={`bg-slate-900 border border-slate-700 rounded-2xl w-full ${wide ? "max-w-2xl" : "max-w-lg"} shadow-2xl max-h-[calc(100dvh-1rem)] sm:max-h-[92vh] flex flex-col my-auto overflow-hidden`}>
        <div className="flex items-center justify-between border-b border-slate-800 p-4 sm:p-5 shrink-0 bg-slate-900">
          <h3 className="text-base font-bold text-white flex items-center gap-2">{Icon && <Icon className="w-4 h-4 text-emerald-400" />} {title}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition shrink-0"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto p-4 sm:p-5 flex-1">{children}</div>
      </div>
    </div>
  );
}

export function UnitPicker({ f, set, k = "unit" }: any) {
  return (
    <Field label="Unit">
      <select value={f[k]} onChange={(e) => set(k, e.target.value)} className={inputCls}>
        {FEED_UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
      </select>
    </Field>
  );
}

export function SubmitBar({ busy, label, testid }: any) {
  return (
    <button type="submit" disabled={busy} data-testid={testid}
      className="w-full mt-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-bold transition">
      {busy ? "Saving…" : label}
    </button>
  );
}

export const ErrBox = ({ error }: any) => error ? <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-2.5 rounded-lg text-xs mb-3">{error}</div> : null;

export const statusPill = (s: string) =>
  s === "RELEASED" ? "bg-emerald-500/20 text-emerald-300" :
  s === "QC_HOLD" ? "bg-amber-500/20 text-amber-300" :
  s === "REJECTED" ? "bg-rose-500/20 text-rose-300" : "bg-slate-700 text-slate-300";
