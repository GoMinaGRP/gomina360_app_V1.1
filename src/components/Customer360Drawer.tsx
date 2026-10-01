"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  CreditCard,
  Download,
  Phone,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { convertGhs, CurrencyCode, formatMoney } from "@/lib/currency";

/**
 * Customer 360 drawer (R3) — one customer's whole relationship in one slide-over:
 * RFM segment + spend overview, the interaction timeline (calls, visits,
 * complaints, follow-ups), credit balances with overdue flags, preferences
 * editor and a downloadable statement of account (PDF via jsPDF).
 */
const SEGMENT_STYLE: Record<string, string> = {
  CHAMPION: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  LOYAL: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  AT_RISK: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  DORMANT: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  NEW: "bg-slate-600/40 text-slate-300 border-slate-500/40",
};

const TYPE_STYLE: Record<string, string> = {
  CALL: "bg-blue-500/15 text-blue-300",
  VISIT: "bg-violet-500/15 text-violet-300",
  MESSAGE: "bg-cyan-500/15 text-cyan-300",
  COMPLAINT: "bg-rose-500/15 text-rose-300",
  FOLLOW_UP: "bg-amber-500/15 text-amber-300",
  NOTE: "bg-slate-600/40 text-slate-300",
};

const money = (n: any, currency: CurrencyCode) => formatMoney(Number(n || 0), currency);
const today = () => new Date().toLocaleDateString("en-CA");

export default function Customer360Drawer({
  customer,
  businesses,
  currentCurrency = "GHS",
  onClose,
  onUpdated,
}: {
  customer: any;
  businesses: any[];
  currentCurrency?: CurrencyCode;
  onClose: () => void;
  onUpdated?: () => void;
}) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [tab, setTab] = useState<"OVERVIEW" | "TIMELINE" | "CREDIT" | "STATEMENT">("OVERVIEW");
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState<any>({ type: "CALL", summary: "", detail: "", followUpOn: "", occurredAt: today() });
  const [prefDraft, setPrefDraft] = useState<{ key: string; value: string }[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/customer-interactions?customerId=${customer.id}&include360=1`, { credentials: "include" });
      const d = await res.json();
      if (d?.success) {
        setData(d.customer360);
        setPrefDraft(Object.entries(d.customer360?.profile?.preferences || {}).map(([key, value]) => ({ key: String(key), value: String(value) })));
        setError("");
      } else setError(d?.error || "Could not load the customer's 360 view.");
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }, [customer.id]);

  useEffect(() => { load(); }, [load]);

  const api = async (method: string, path: string, body?: any) => {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok || !d?.success) throw new Error(d?.error || "Action failed.");
    return d;
  };

  const addInteraction = async () => {
    setBusy(true); setError("");
    try {
      await api("POST", "/api/customer-interactions", { customerId: customer.id, ...draft });
      setShowAdd(false);
      setDraft({ type: "CALL", summary: "", detail: "", followUpOn: "", occurredAt: today() });
      setFlash("Interaction logged.");
      await load();
      onUpdated?.();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const deleteInteraction = async (row: any) => {
    if (!window.confirm("Delete this interaction?")) return;
    setBusy(true); setError("");
    try {
      await api("DELETE", `/api/customer-interactions?id=${row.id}`);
      setFlash("Interaction deleted.");
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const savePreferences = async () => {
    setBusy(true); setError("");
    try {
      const preferences: Record<string, string> = {};
      for (const p of prefDraft) {
        const k = p.key.trim();
        if (k) preferences[k] = p.value.trim();
      }
      await api("PATCH", "/api/enterprise", { entityType: "CUSTOMERS", id: customer.id, data: { preferences } });
      setFlash("Preferences saved.");
      await load();
      onUpdated?.();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const downloadStatement = async () => {
    if (!data) return;
    const { jsPDF } = await import("jspdf");
    const autoTable = (await import("jspdf-autotable")).default;
    const doc = new jsPDF();
    const biz = data.profile.businessId != null ? businesses.find((b) => Number(b.id) === Number(data.profile.businessId)) : null;
    doc.setFontSize(16);
    doc.text("Statement of Account", 14, 18);
    doc.setFontSize(10);
    doc.text(`${biz?.name || "GoMina 360"}`, 14, 25);
    doc.text(`Customer: ${data.profile.name} (${data.profile.type})`, 14, 31);
    doc.text(`Phone: ${data.profile.phone || "—"}`, 14, 37);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 43);
    autoTable(doc, {
      startY: 49,
      head: [["Date", "Reference", "Description", `Debit (${currentCurrency})`, `Credit (${currentCurrency})`, `Balance (${currentCurrency})`]],
      body: (data.statement || []).map((l: any) => [
        l.date || "",
        l.reference || "",
        l.description || "",
        l.debitGhs ? convertGhs(Number(l.debitGhs), currentCurrency).toFixed(2) : "",
        l.creditGhs ? convertGhs(Number(l.creditGhs), currentCurrency).toFixed(2) : "",
        convertGhs(Number(l.balanceGhs || 0), currentCurrency).toFixed(2),
      ]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [15, 23, 42] },
    });
    const finalY = (doc as any).lastAutoTable?.finalY || 60;
    doc.setFontSize(11);
    doc.text(`Closing balance: ${money(data.statementBalanceGhs, currentCurrency)}`, 14, finalY + 8);
    doc.save(`statement-${String(data.profile.name || "customer").replace(/\W+/g, "-").toLowerCase()}.pdf`);
  };

  // Escape key listener
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showAdd) setShowAdd(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [showAdd, onClose]);

  const p = data?.profile || customer;
  const insights = data?.insights || {};
  const bizName = p.businessId != null ? businesses.find((b) => Number(b.id) === Number(p.businessId))?.name || `Unit #${p.businessId}` : "Shared — all units";
  const overdueCredits = (data?.creditSales || []).filter((s: any) => s.status !== "PAID" && s.dueDate && String(s.dueDate) < today());

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm"
      data-testid="c360-root"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-slate-900 border-l border-slate-700 w-full max-w-2xl h-full overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur border-b border-slate-700/80 px-5 py-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-extrabold text-white flex items-center gap-2">
              {p.name}
              <span className={`text-[10px] font-bold px-2 py-1 rounded-full border ${SEGMENT_STYLE[insights.segment] || SEGMENT_STYLE.NEW}`} data-testid="c360-segment">
                {insights.segment || "NEW"}
              </span>
            </h3>
            <p className="text-[11px] text-slate-400 mt-0.5">
              {p.type} · {bizName}{p.town ? ` · ${p.town}` : ""}
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-700/70 text-slate-300" data-testid="c360-close"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4">
          {flash && <p className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2" data-testid="c360-flash">{flash}</p>}
          {error && <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2" data-testid="c360-error">{error}</p>}

          {/* KPI strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="bg-slate-800/80 border border-slate-700/70 rounded-xl p-3">
              <p className="text-[10px] uppercase font-bold text-slate-500">Lifetime spend</p>
              <p className="text-sm font-black text-emerald-300">{money(insights.monetaryGhs, currentCurrency)}</p>
            </div>
            <div className="bg-slate-800/80 border border-slate-700/70 rounded-xl p-3">
              <p className="text-[10px] uppercase font-bold text-slate-500">Orders</p>
              <p className="text-sm font-black text-white">{insights.frequency ?? 0}</p>
            </div>
            <div className="bg-slate-800/80 border border-slate-700/70 rounded-xl p-3">
              <p className="text-[10px] uppercase font-bold text-slate-500">Last order</p>
              <p className="text-sm font-black text-white">{insights.recencyDays != null ? `${insights.recencyDays}d ago` : "—"}</p>
            </div>
            <div className="bg-slate-800/80 border border-slate-700/70 rounded-xl p-3">
              <p className="text-[10px] uppercase font-bold text-slate-500">Open credit</p>
              <p className={`text-sm font-black ${Number(insights.openCreditGhs) > 0 ? "text-amber-300" : "text-white"}`}>{money(insights.openCreditGhs, currentCurrency)}</p>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex flex-wrap gap-1.5" data-testid="c360-tabs">
            {([["OVERVIEW", "Overview"], ["TIMELINE", `Timeline${(data?.interactions || []).length ? ` (${data.interactions.length})` : ""}`], ["CREDIT", `Credit${(data?.creditSales || []).length ? ` (${data.creditSales.length})` : ""}`], ["STATEMENT", "Statement"]] as const).map(([id, label]) => (
              <button key={id} onClick={() => setTab(id as any)} className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${tab === id ? "bg-emerald-600 text-white border-emerald-500" : "bg-slate-800/70 text-slate-300 border-slate-700 hover:bg-slate-700/60"}`} data-testid={`c360-tab-${id}`}>
                {label}
              </button>
            ))}
          </div>

          {loading && <p className="text-xs text-slate-500 flex items-center gap-2"><RefreshCw className="w-3 h-3 animate-spin" /> Loading the 360 view…</p>}

          {/* ── OVERVIEW ── */}
          {tab === "OVERVIEW" && !loading && (
            <div className="space-y-4">
              <div className="bg-slate-800/70 border border-slate-700/70 rounded-xl p-4 space-y-1.5">
                <p className="text-[10px] uppercase font-bold text-slate-500 mb-1">Contact</p>
                <p className="text-xs text-slate-200 flex items-center gap-2"><Phone className="w-3 h-3 text-slate-500" /> {p.phone || "—"}</p>
                <p className="text-xs text-slate-300">{p.email || "—"}</p>
                <p className="text-xs text-slate-300">{[p.town, p.district, p.region].filter(Boolean).join(" · ") || "—"}</p>
                <p className="text-xs text-amber-300 flex items-center gap-1.5"><Star className="w-3 h-3" /> {p.loyaltyPoints ?? 0} loyalty points</p>
              </div>
              <div className="bg-slate-800/70 border border-slate-700/70 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] uppercase font-bold text-slate-500">Preferences</p>
                  <button onClick={() => setPrefDraft([...prefDraft, { key: "", value: "" }])} className="text-[11px] font-bold text-emerald-300 hover:text-emerald-200 flex items-center gap-1"><Plus className="w-3 h-3" /> Add</button>
                </div>
                <div className="space-y-2">
                  {prefDraft.map((row, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <input value={row.key} onChange={(e) => { const rows = [...prefDraft]; rows[idx] = { ...row, key: e.target.value }; setPrefDraft(rows); }} placeholder="Key (e.g. paymentTerms)" className="w-40 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200" />
                      <input value={row.value} onChange={(e) => { const rows = [...prefDraft]; rows[idx] = { ...row, value: e.target.value }; setPrefDraft(rows); }} placeholder="Value (e.g. NET_30)" className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200" />
                      <button onClick={() => setPrefDraft(prefDraft.filter((_, j) => j !== idx))} className="text-rose-400 hover:text-rose-300 text-xs font-bold">✕</button>
                    </div>
                  ))}
                  {prefDraft.length === 0 && <p className="text-[11px] text-slate-500">No preferences recorded — add payment terms, preferred channel, delivery notes…</p>}
                </div>
                <button onClick={savePreferences} disabled={busy} className="mt-3 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold disabled:opacity-50" data-testid="c360-prefs-save">Save preferences</button>
              </div>
            </div>
          )}

          {/* ── TIMELINE ── */}
          {tab === "TIMELINE" && !loading && (
            <div className="space-y-3">
              <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold" data-testid="c360-add-interaction">
                <Plus className="w-3.5 h-3.5" /> Log interaction
              </button>
              <div className="space-y-2" data-testid="c360-timeline">
                {(data?.interactions || []).map((row: any) => (
                  <div key={row.id} className="bg-slate-800/70 border border-slate-700/70 rounded-xl p-3" data-testid={`c360-int-${row.id}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${TYPE_STYLE[row.type] || TYPE_STYLE.NOTE}`}>{row.type}</span>
                      <span className="text-[10px] text-slate-500">{row.occurredAt || String(row.createdAt || "").slice(0, 10)} · {row.actorName}</span>
                      {row.followUpOn && <span className="text-[10px] font-bold text-amber-300 flex items-center gap-1"><CalendarClock className="w-3 h-3" /> follow up {row.followUpOn}</span>}
                      <button onClick={() => deleteInteraction(row)} disabled={busy} className="ml-auto text-rose-400 hover:text-rose-300 disabled:opacity-50" data-testid={`c360-int-del-${row.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                    <p className="text-xs text-slate-100 font-semibold mt-1">{row.summary}</p>
                    {row.detail && <p className="text-[11px] text-slate-400 mt-0.5 whitespace-pre-wrap">{row.detail}</p>}
                  </div>
                ))}
                {(data?.interactions || []).length === 0 && <p className="text-xs text-slate-500">No interactions yet — log calls, visits and complaints to build the relationship history.</p>}
              </div>
            </div>
          )}

          {/* ── CREDIT ── */}
          {tab === "CREDIT" && !loading && (
            <div className="space-y-2" data-testid="c360-credit">
              {(data?.creditSales || []).map((s: any) => {
                const overdue = s.status !== "PAID" && s.dueDate && String(s.dueDate) < today();
                return (
                  <div key={s.id} className="bg-slate-800/70 border border-slate-700/70 rounded-xl p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-xs font-bold text-white font-mono flex-1">{s.creditCode}</p>
                      <span className={`text-[10px] font-bold px-2 py-1 rounded-full border ${s.status === "PAID" ? "bg-green-500/15 text-green-300 border-green-500/30" : overdue ? "bg-rose-500/15 text-rose-300 border-rose-500/30" : "bg-amber-500/15 text-amber-300 border-amber-500/30"}`}>
                        {s.status === "PAID" ? "Settled" : overdue ? "OVERDUE" : "Active"}
                      </span>
                      <span className="text-xs font-black text-amber-300">{money(s.balanceGhs, currentCurrency)} owed</span>
                    </div>
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      Total {money(s.totalGhs, currentCurrency)} · paid {money(s.amountPaidGhs, currentCurrency)}{s.dueDate ? ` · due ${s.dueDate}` : ""}
                    </p>
                    {(s.items || []).length > 0 && (
                      <div className="mt-1.5 space-y-0.5">
                        {s.items.map((li: any, i: number) => (
                          <p key={i} className="text-[11px] text-slate-400">{li.description} × {li.quantity}</p>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {(data?.creditSales || []).length === 0 && <p className="text-xs text-slate-500">No credit sales for this customer.</p>}
              {overdueCredits.length > 0 && (
                <p className="text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
                  {overdueCredits.length} overdue credit sale{overdueCredits.length === 1 ? "" : "s"} — the daily dunning sweep chases these automatically (T+1 reminder, T+7 firm, T+30 final).
                </p>
              )}
            </div>
          )}

          {/* ── STATEMENT ── */}
          {tab === "STATEMENT" && !loading && (
            <div className="space-y-3">
              <button onClick={downloadStatement} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold" data-testid="c360-statement-pdf">
                <Download className="w-3.5 h-3.5" /> Download PDF statement
              </button>
              <div className="bg-slate-800/70 border border-slate-700/70 rounded-xl overflow-hidden" data-testid="c360-statement">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-slate-900/90 text-slate-400 uppercase text-[10px]">
                    <tr>
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Reference</th>
                      <th className="px-3 py-2">Description</th>
                      <th className="px-3 py-2 text-right">Debit</th>
                      <th className="px-3 py-2 text-right">Credit</th>
                      <th className="px-3 py-2 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/50">
                    {(data?.statement || []).map((l: any, i: number) => (
                      <tr key={i}>
                        <td className="px-3 py-1.5 text-slate-400">{l.date}</td>
                        <td className="px-3 py-1.5 font-mono text-slate-300">{l.reference}</td>
                        <td className="px-3 py-1.5 text-slate-300">{l.description}</td>
                        <td className="px-3 py-1.5 text-right text-slate-300">{l.debitGhs ? money(l.debitGhs, currentCurrency) : ""}</td>
                        <td className="px-3 py-1.5 text-right text-emerald-300">{l.creditGhs ? money(l.creditGhs, currentCurrency) : ""}</td>
                        <td className="px-3 py-1.5 text-right font-bold text-white">{money(l.balanceGhs, currentCurrency)}</td>
                      </tr>
                    ))}
                    {(data?.statement || []).length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-4 text-slate-500">No account activity yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-slate-300">
                Closing balance: <b className="text-white">{money(data?.statementBalanceGhs, currentCurrency)}</b>
              </p>
            </div>
          )}
        </div>

        {/* ── Add-interaction modal ── */}
        {showAdd && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 overflow-y-auto"
            data-testid="c360-add-modal"
            onClick={(e) => { if (e.target === e.currentTarget) setShowAdd(false); }}
          >
            <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4 sm:p-5 w-full max-w-md space-y-3 max-h-[calc(100dvh-2rem)] overflow-y-auto my-auto">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-extrabold text-white">Log interaction</h4>
                <button onClick={() => setShowAdd(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">Type</label>
                  <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="c360-add-type">
                    {["CALL", "VISIT", "MESSAGE", "COMPLAINT", "FOLLOW_UP", "NOTE"].map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">Date</label>
                  <input type="date" value={draft.occurredAt} onChange={(e) => setDraft({ ...draft, occurredAt: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Summary</label>
                <input value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} placeholder="What happened?" className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="c360-add-summary" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Detail (optional)</label>
                <textarea value={draft.detail} onChange={(e) => setDraft({ ...draft, detail: e.target.value })} rows={3} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Follow up on (optional)</label>
                <input type="date" value={draft.followUpOn} onChange={(e) => setDraft({ ...draft, followUpOn: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setShowAdd(false)} className="px-3 py-2 rounded-lg bg-slate-700 text-white text-xs font-bold">Cancel</button>
                <button onClick={addInteraction} disabled={busy || !draft.summary.trim()} className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50" data-testid="c360-add-save">Save</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
