"use client";

// ─── Budgets & Cash-Flow Forecast (roadmap P4) ─────────────────────────────
// Two management panels that extend the Central Financial Report:
//  • BUDGETS — monthly envelopes per business & category with live
//    budget-vs-actual variance (actuals computed from transactions at read
//    time; the seeded Q1-2026 baseline is excluded — budgets are
//    forward-looking controls, not restated history).
//  • CASH FLOW — a 13-week projection that starts from the Command Center's
//    liquid-surplus figure and layers committed money (credit receivables,
//    open POs, next payroll) plus run-rate estimates, clearly labelled.
// Self-fetching: no prop plumbing beyond the business list + current user.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Banknote,
  CalendarRange,
  Landmark,
  Loader2,
  PiggyBank,
  Plus,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Trash2,
  Wallet,
} from "lucide-react";
import { CurrencyCode, formatMoney } from "@/lib/currency";

function monthLabel(period: string): string {
  const [y, m] = period.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(m) - 1] || m} ${y}`;
}

function periodOptions(): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = -6; i <= 3; i++) {
    const p = new Date(d.getFullYear(), d.getMonth() + i, 1);
    out.push(`${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, "0")}`);
  }
  return out.reverse();
}

export default function BudgetsAndCashflowSection({
  currentUser,
  businesses,
  currentCurrency = "GHS",
}: {
  currentUser: any;
  businesses: any[];
  currentCurrency?: CurrencyCode;
}) {
  const [tab, setTab] = useState<"BUDGETS" | "CASHFLOW">("BUDGETS");
  return (
    <div className="space-y-4" data-testid="budgets-cashflow">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-black text-slate-100 flex items-center gap-2">
          <PiggyBank className="w-5 h-5 text-amber-400" /> Budgets &amp; Cash-Flow Forecast
        </h3>
        <div className="flex rounded-xl overflow-hidden border border-slate-700">
          {([
            { k: "BUDGETS", label: "Budget vs actual", icon: <Landmark className="w-3.5 h-3.5" /> },
            { k: "CASHFLOW", label: "13-week cash flow", icon: <CalendarRange className="w-3.5 h-3.5" /> },
          ] as const).map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold transition ${tab === t.k ? "bg-amber-500/20 text-amber-300" : "bg-slate-800 text-slate-400 hover:bg-slate-700"}`}
              data-testid={`bcf-tab-${t.k}`}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      </div>
      {tab === "BUDGETS" ? <BudgetsPanel currentUser={currentUser} businesses={businesses} currentCurrency={currentCurrency} /> : <CashflowPanel currentUser={currentUser} businesses={businesses} currentCurrency={currentCurrency} />}
    </div>
  );
}

// ─── Budgets ───────────────────────────────────────────────────────────────

function BudgetsPanel({ currentUser, businesses, currentCurrency }: { currentUser: any; businesses: any[]; currentCurrency: CurrencyCode }) {
  const money = useCallback((n: number | null | undefined) => formatMoney(Number(n || 0), currentCurrency, true), [currentCurrency]);
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const [scope, setScope] = useState("all");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/budgets?businessId=${scope}&period=${period}`);
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || "load failed");
      setData(body);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [scope, period]);

  useEffect(() => {
    load();
  }, [load]);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2600);
  };

  const saveLine = async (payload: any) => {
    setBusy(true);
    try {
      const res = await fetch("/api/budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, period, businessId: payload.businessId === "all" ? undefined : Number(payload.businessId) }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || "save failed");
      flash("Budget line saved.");
      setShowAdd(false);
      await load();
    } catch (e: any) {
      flash(e?.message || "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  const removeLine = async (id: number) => {
    setBusy(true);
    try {
      await fetch(`/api/budgets?id=${id}`, { method: "DELETE" });
      flash("Budget line removed.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const lines: any[] = data?.lines || [];
  const totals = data?.totals || { expenseBudget: 0, expenseActual: 0, revenueBudget: 0, revenueActual: 0 };
  const periods: string[] = useMemo(() => {
    const set = new Set<string>([...periodOptions(), ...((data?.periods as string[]) || [])]);
    return Array.from(set).sort().reverse();
  }, [data?.periods]);

  return (
    <div className="rounded-2xl border border-slate-700/70 bg-slate-900/60 p-4 sm:p-5 space-y-4" data-testid="budgets-panel">
      <div className="flex flex-wrap items-center gap-2">
        <select value={period} onChange={(e) => setPeriod(e.target.value)} className="px-2.5 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-xs font-bold text-slate-200" data-testid="budget-period">
          {periods.map((p) => (
            <option key={p} value={p}>{monthLabel(p)}</option>
          ))}
        </select>
        <select value={scope} onChange={(e) => setScope(e.target.value)} className="px-2.5 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-xs font-bold text-slate-200" data-testid="budget-scope">
          <option value="all">All businesses (consolidated)</option>
          {(businesses || []).map((b: any) => (
            <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
          ))}
        </select>
        <button onClick={() => load()} className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700" title="Refresh">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setShowAdd((s) => !s)}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold"
          data-testid="budget-add"
        >
          <Plus className="w-3.5 h-3.5" /> {showAdd ? "Close" : "Set budget line"}
        </button>
      </div>

      {/* Headline: revenue target vs actual + expense envelope vs actual */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="budget-totals">
        <HeadlineStat label="Revenue target" value={money(totals.revenueBudget)} sub={`actual ${money(totals.revenueActual)}`} icon={<TrendingUp className="w-4 h-4 text-cyan-400" />} tone={totals.revenueActual >= totals.revenueBudget ? "good" : totals.revenueBudget > 0 ? "warn" : "flat"} />
        <HeadlineStat label="Revenue actual" value={money(totals.revenueActual)} sub={totals.revenueBudget > 0 ? `${Math.round((totals.revenueActual / totals.revenueBudget) * 100)}% of target` : "no target set"} icon={<Banknote className="w-4 h-4 text-cyan-400" />} tone="flat" />
        <HeadlineStat label="Expense envelope" value={money(totals.expenseBudget)} sub={`actual ${money(totals.expenseActual)}`} icon={<Wallet className="w-4 h-4 text-amber-400" />} tone={totals.expenseActual > totals.expenseBudget && totals.expenseBudget > 0 ? "bad" : "good"} />
        <HeadlineStat label="Expense actual" value={money(totals.expenseActual)} sub={totals.expenseBudget > 0 ? `${Math.round((totals.expenseActual / totals.expenseBudget) * 100)}% of envelope` : "no envelope set"} icon={<TrendingDown className="w-4 h-4 text-rose-400" />} tone={totals.expenseBudget > 0 && totals.expenseActual > totals.expenseBudget ? "bad" : "flat"} />
      </div>

      {showAdd && (
        <AddBudgetLine
          businesses={businesses}
          categories={data?.categories || []}
          busy={busy}
          onSave={saveLine}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {loading ? (
        <div className="flex justify-center py-8 text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : lines.length === 0 ? (
        <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-6 text-center text-xs text-slate-400" data-testid="budget-empty">
          No budget lines for {monthLabel(period)} yet. Set envelopes per category — or one all-in “TOTAL” envelope — and GoMina tracks the variance live.
        </div>
      ) : (
        <div className="overflow-x-auto -mx-1" data-testid="budget-table">
          <table className="w-full text-xs min-w-[640px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-700/70">
                <th className="px-2 py-2">Kind</th>
                {scope === "all" && <th className="px-2 py-2">Business</th>}
                <th className="px-2 py-2">Category</th>
                <th className="px-2 py-2 text-right">Budget</th>
                <th className="px-2 py-2 text-right">Actual</th>
                <th className="px-2 py-2 text-right">Variance</th>
                <th className="px-2 py-2">Used</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className={`border-b border-slate-800/60 ${l.status === "OVER" ? "bg-rose-950/20" : l.status === "WATCH" ? "bg-amber-950/10" : ""}`}>
                  <td className="px-2 py-2">
                    <span className={`text-[9px] font-black px-1.5 py-0.5 rounded border ${l.kind === "EXPENSE" ? "bg-rose-500/15 text-rose-300 border-rose-500/40" : "bg-cyan-500/15 text-cyan-300 border-cyan-500/40"}`}>
                      {l.kind}
                    </span>
                  </td>
                  {scope === "all" && <td className="px-2 py-2 text-slate-300 whitespace-nowrap">{l.businessCode || "—"}</td>}
                  <td className="px-2 py-2 font-bold text-slate-200">
                    {l.category === "TOTAL" ? <span className="text-amber-300">▣ All-in envelope</span> : l.category}
                    {l.branchCode ? <span className="text-[9px] text-slate-500"> · {l.branchCode}</span> : null}
                  </td>
                  <td className="px-2 py-2 text-right font-bold text-slate-200">{money(l.budgetGhs)}</td>
                  <td className="px-2 py-2 text-right text-slate-300">{money(l.actualGhs)}</td>
                  <td className={`px-2 py-2 text-right font-bold ${l.varianceGhs < 0 ? "text-rose-300" : "text-emerald-300"}`}>
                    {l.varianceGhs >= 0 ? "+" : ""}{money(l.varianceGhs)}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-1.5">
                      <div className="w-16 h-1.5 rounded-full bg-slate-700 overflow-hidden">
                        <div
                          className={`h-full ${l.status === "OVER" ? "bg-rose-400" : l.status === "WATCH" ? "bg-amber-400" : "bg-emerald-400"}`}
                          style={{ width: `${Math.min(100, Math.max(0, l.pctUsed ?? 0))}%` }}
                        />
                      </div>
                      <span className={`text-[10px] font-bold ${l.status === "OVER" ? "text-rose-300" : l.status === "WATCH" ? "text-amber-300" : "text-slate-400"}`}>
                        {l.pctUsed == null ? "—" : `${l.pctUsed}%`}
                      </span>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button onClick={() => removeLine(l.id)} disabled={busy} className="p-1 rounded-lg text-slate-500 hover:text-rose-300 hover:bg-slate-800" title="Remove this budget line" data-testid={`budget-del-${l.id}`}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[10px] text-slate-500 leading-relaxed">
        Actuals are computed live from this month&apos;s transactions (the seeded Q1-2026 baseline is excluded). A budget line is unique per
        business · month · category — saving again updates the amount. “TOTAL” is the all-in envelope against every category of that kind.
      </p>
      {toast && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl bg-slate-800 border border-amber-500/40 shadow-2xl text-xs font-semibold text-amber-200" data-testid="budget-toast">{toast}</div>}
    </div>
  );
}

function HeadlineStat({ label, value, sub, icon, tone }: { label: string; value: string; sub: string; icon: React.ReactNode; tone: "good" | "bad" | "warn" | "flat" }) {
  const toneCls =
    tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : tone === "warn" ? "text-amber-300" : "text-slate-200";
  return (
    <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-3.5 shadow">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</p>
        {icon}
      </div>
      <p className={`text-lg font-extrabold mt-1 ${toneCls}`}>{value}</p>
      <p className="text-[10px] text-slate-500 mt-0.5 font-semibold">{sub}</p>
    </div>
  );
}

function AddBudgetLine({
  businesses,
  categories,
  busy,
  onSave,
  onCancel,
}: {
  businesses: any[];
  categories: string[];
  busy: boolean;
  onSave: (payload: any) => void;
  onCancel: () => void;
}) {
  const [businessId, setBusinessId] = useState(String(businesses?.[0]?.id ?? ""));
  const [kind, setKind] = useState("EXPENSE");
  const [category, setCategory] = useState("TOTAL");
  const [amount, setAmount] = useState("");
  const [customCategory, setCustomCategory] = useState("");

  const submit = () => {
    const a = Number(amount);
    if (!businessId || !Number.isFinite(a) || a < 0) return;
    const cat = category === "__CUSTOM__" ? customCategory.trim() : category;
    if (!cat) return;
    onSave({ businessId, kind, category: cat, amountGhs: a });
  };

  return (
    <div className="rounded-2xl border border-amber-500/30 bg-slate-900/80 p-4 grid sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end" data-testid="budget-add-form">
      <div>
        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">Business</label>
        <select value={businessId} onChange={(e) => setBusinessId(e.target.value)} className="mt-1 w-full px-2.5 py-2 rounded-xl bg-slate-800 border border-slate-700 text-xs text-slate-100">
          {(businesses || []).map((b: any) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">Kind</label>
        <select value={kind} onChange={(e) => { setKind(e.target.value); setCategory(e.target.value === "REVENUE" ? "TOTAL" : "TOTAL"); }} className="mt-1 w-full px-2.5 py-2 rounded-xl bg-slate-800 border border-slate-700 text-xs text-slate-100">
          <option value="EXPENSE">Expense envelope</option>
          <option value="REVENUE">Revenue target</option>
        </select>
      </div>
      <div>
        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">Category</label>
        {category === "__CUSTOM__" ? (
          <input value={customCategory} onChange={(e) => setCustomCategory(e.target.value)} placeholder="Category name…" className="mt-1 w-full px-2.5 py-2 rounded-xl bg-slate-800 border border-slate-700 text-xs text-slate-100" autoFocus />
        ) : (
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 w-full px-2.5 py-2 rounded-xl bg-slate-800 border border-slate-700 text-xs text-slate-100">
            <option value="TOTAL">▣ All-in (TOTAL)</option>
            {categories.filter((c) => c !== "TOTAL").map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
            <option value="__CUSTOM__">+ Type a new category…</option>
          </select>
        )}
      </div>
      <div>
        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">Amount (GH₵)</label>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min="0" placeholder="e.g. 5000" className="mt-1 w-full px-2.5 py-2 rounded-xl bg-slate-800 border border-slate-700 text-xs text-slate-100" data-testid="budget-amount" />
      </div>
      <div className="flex gap-2">
        <button onClick={submit} disabled={busy || !amount} className="flex-1 px-3 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50" data-testid="budget-save">
          {busy ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Save"}
        </button>
        <button onClick={onCancel} className="px-3 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold">Close</button>
      </div>
    </div>
  );
}

// ─── Cash-flow forecast ────────────────────────────────────────────────────

function CashflowPanel({ currentUser, businesses, currentCurrency }: { currentUser: any; businesses: any[]; currentCurrency: CurrencyCode }) {
  const money = useCallback((n: number | null | undefined) => formatMoney(Number(n || 0), currentCurrency, true), [currentCurrency]);
  const [scope, setScope] = useState("all");
  const [weeks, setWeeks] = useState(13);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/cashflow/forecast?businessId=${scope}&weeks=${weeks}`);
      const body = await res.json();
      if (res.ok && body.success) setData(body);
      else setData(null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [scope, weeks]);

  useEffect(() => {
    load();
  }, [load]);

  const buckets: any[] = data?.buckets || [];
  const maxAbs = Math.max(1, ...buckets.map((b) => Math.abs(b.cumulativeCashGhs)));
  const negWeek = data?.firstNegativeWeek ?? null;

  return (
    <div className="rounded-2xl border border-slate-700/70 bg-slate-900/60 p-4 sm:p-5 space-y-4" data-testid="cashflow-panel">
      <div className="flex flex-wrap items-center gap-2">
        <select value={scope} onChange={(e) => setScope(e.target.value)} className="px-2.5 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-xs font-bold text-slate-200" data-testid="cashflow-scope">
          <option value="all">All businesses (consolidated)</option>
          {(businesses || []).map((b: any) => (
            <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
          ))}
        </select>
        <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} className="px-2.5 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-xs font-bold text-slate-200">
          {[8, 13, 26].map((w) => (
            <option key={w} value={w}>{w}-week horizon</option>
          ))}
        </select>
        <button onClick={() => load()} className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700" title="Refresh">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-8 text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : !data ? (
        <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-6 text-center text-xs text-slate-400">Forecast unavailable.</div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="cashflow-totals">
            <HeadlineStat label="Cash today (liquid surplus)" value={money(data.startingCashGhs)} sub="same figure as the Command Center" icon={<Wallet className="w-4 h-4 text-cyan-400" />} tone={data.startingCashGhs < 0 ? "bad" : "good"} />
            <HeadlineStat label={`Projected in ${data.weeks} weeks`} value={money(data.projectedEndCashGhs)} sub={negWeek ? `first shortfall: week ${negWeek}` : "no shortfall projected"} icon={<CalendarRange className="w-4 h-4 text-amber-400" />} tone={data.projectedEndCashGhs < 0 || negWeek ? "bad" : "good"} />
            <HeadlineStat label="Receivable (credit sales)" value={money(data.outstandingCreditGhs)} sub={`${data.creditCount} active credit sale(s)`} icon={<TrendingUp className="w-4 h-4 text-emerald-400" />} tone="flat" />
            <HeadlineStat label="Committed purchases" value={money(data.openPurchaseOrdersGhs)} sub={`${data.openPoCount} open PO(s) · payroll ${money(data.monthlyPayrollGhs)}/mo`} icon={<TrendingDown className="w-4 h-4 text-rose-400" />} tone="flat" />
          </div>

          {(negWeek || data.projectedEndCashGhs < 0) && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-200" data-testid="cashflow-warning">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                <strong>Cash squeeze projected.</strong>{" "}
                {negWeek ? `Week ${negWeek} is the first week the projection goes negative.` : `The projection ends below zero.`} Collect receivables earlier, re-time purchase orders, or trim the expense run-rate (currently {money(data.dailyExpenseRunRateGhs)}/day).
              </span>
            </div>
          )}

          {/* Cumulative cash bars */}
          <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-3">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-2">Projected cumulative cash</p>
            <div className="flex items-end gap-1 h-32 overflow-x-auto" data-testid="cashflow-chart">
              {buckets.map((b) => {
                const h = Math.max(2, Math.round((Math.abs(b.cumulativeCashGhs) / maxAbs) * 100));
                const neg = b.cumulativeCashGhs < 0;
                return (
                  <div key={b.week} className="flex-1 min-w-[14px] flex flex-col items-center gap-1 group relative" title={`Week ${b.week} (${b.from} → ${b.to}): ${money(b.cumulativeCashGhs)} · in ${money(b.certainInflowGhs + b.estimatedInflowGhs)} · out ${money(b.certainOutflowGhs + b.estimatedOutflowGhs)}`}>
                    <div className={`w-full rounded-t ${neg ? "bg-rose-400/80" : "bg-cyan-400/80"} group-hover:opacity-100 opacity-80`} style={{ height: `${h}%` }} />
                    <span className="text-[8px] text-slate-500">{b.week}</span>
                  </div>
                );
              })}
            </div>
            <p className="text-[9px] text-slate-500 mt-1.5">Hover a bar for the weekly breakdown · weeks are numbered from today ({data.today}).</p>
          </div>

          {/* Weekly table */}
          <div className="overflow-x-auto -mx-1" data-testid="cashflow-table">
            <table className="w-full text-xs min-w-[720px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-700/70">
                  <th className="px-2 py-2">Week</th>
                  <th className="px-2 py-2">Dates</th>
                  <th className="px-2 py-2 text-right">In — committed</th>
                  <th className="px-2 py-2 text-right">In — run-rate est.</th>
                  <th className="px-2 py-2 text-right">Out — committed</th>
                  <th className="px-2 py-2 text-right">Out — run-rate est.</th>
                  <th className="px-2 py-2 text-right">Net</th>
                  <th className="px-2 py-2 text-right">Cumulative cash</th>
                </tr>
              </thead>
              <tbody>
                {buckets.map((b) => (
                  <tr key={b.week} className={`border-b border-slate-800/60 ${b.cumulativeCashGhs < 0 ? "bg-rose-950/20" : ""}`}>
                    <td className="px-2 py-2 font-bold text-slate-300">W{b.week}</td>
                    <td className="px-2 py-2 text-slate-400 whitespace-nowrap">{b.from} → {b.to}</td>
                    <td className="px-2 py-2 text-right text-emerald-300">{money(b.certainInflowGhs)}</td>
                    <td className="px-2 py-2 text-right text-emerald-300/60">{money(b.estimatedInflowGhs)}</td>
                    <td className="px-2 py-2 text-right text-rose-300">{money(b.certainOutflowGhs)}</td>
                    <td className="px-2 py-2 text-right text-rose-300/60">{money(b.estimatedOutflowGhs)}</td>
                    <td className={`px-2 py-2 text-right font-bold ${b.netGhs < 0 ? "text-rose-300" : "text-emerald-300"}`}>{b.netGhs >= 0 ? "+" : ""}{money(b.netGhs)}</td>
                    <td className={`px-2 py-2 text-right font-black ${b.cumulativeCashGhs < 0 ? "text-rose-300" : "text-cyan-300"}`}>{money(b.cumulativeCashGhs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details className="text-[10px] text-slate-500">
            <summary className="cursor-pointer font-bold text-slate-400">How this projection is built ({(data.assumptions || []).length} assumptions)</summary>
            <ul className="list-disc pl-5 mt-1.5 space-y-1">
              {(data.assumptions || []).map((a: string, i: number) => (
                <li key={i}>{a}</li>
              ))}
              <li>Income run-rate ≈ {money(data.dailyIncomeRunRateGhs)}/day · expense run-rate ≈ {money(data.dailyExpenseRunRateGhs)}/day (live last-30-day averages).</li>
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
