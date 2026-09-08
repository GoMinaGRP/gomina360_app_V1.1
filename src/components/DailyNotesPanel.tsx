"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Brain,
  ChevronDown,
  ChevronUp,
  Flame,
  History,
  NotebookPen,
  Send,
  Sparkles,
  Trash2,
  TrendingUp,
} from "lucide-react";

/**
 * DailyNotesPanel — the Daily Notes section that lives UNDER the Daily
 * Checklist of every business module. Workers record free-form end-of-day
 * notes (activities, observations, problems, notices); GoMina AI analyses
 * every note on the spot — flagging issues, scoring severity, spotting
 * recurring trends, writing a concise daily summary — and keeps the unit's
 * living business history & insights up to date.
 */

type Severity = "INFO" | "WATCH" | "URGENT";

const SEV: Record<Severity, { chip: string; dot: string; label: string }> = {
  INFO: { chip: "bg-emerald-500/15 border-emerald-500/40 text-emerald-300", dot: "bg-emerald-400", label: "Normal" },
  WATCH: { chip: "bg-amber-500/15 border-amber-500/40 text-amber-300", dot: "bg-amber-400", label: "Watch" },
  URGENT: { chip: "bg-rose-500/15 border-rose-500/40 text-rose-300", dot: "bg-rose-400", label: "Urgent" },
};

export default function DailyNotesPanel({
  businessId,
  businessName,
  currentUser,
  date,
  onChanged,
}: {
  businessId: number | undefined;
  businessName?: string;
  currentUser?: any;
  date?: string; // the checklist date currently viewed (notes shown for it)
  onChanged?: () => void;
}) {
  const today = new Date().toISOString().split("T")[0];
  const viewDate = date || today;
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [notes, setNotes] = useState<any[]>([]);
  const [daySummary, setDaySummary] = useState<any>(null);
  const [insights, setInsights] = useState<any>(null);
  const [lastAnalysis, setLastAnalysis] = useState<any>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const canNoteDate = viewDate === today || viewDate === new Date(Date.now() - 86400000).toISOString().split("T")[0];

  const load = useCallback(async () => {
    if (!businessId) return;
    try {
      const res = await fetch(`/api/daily-notes?businessId=${businessId}&date=${viewDate}`);
      const d = await res.json();
      if (d.success) {
        setNotes(d.notes || []);
        setDaySummary(d.daySummary || null);
        setInsights(d.insights || null);
      } else {
        setError(d.error || "Failed to load daily notes");
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [businessId, viewDate]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (text.trim().length < 10 || busy) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/daily-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, content: text.trim(), noteDate: viewDate }),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || "Could not save the note");
      setLastAnalysis(d.analysis || null);
      setText("");
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (id: number) => {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/daily-notes?id=${id}`, { method: "DELETE" });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || "Could not withdraw the note");
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const myRole = String(currentUser?.role || "").toUpperCase();
  const canModerate = ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"].includes(myRole);
  const sortedNotes = [...notes].sort((a, b) => (a.id < b.id ? 1 : -1));

  return (
    <section className="mt-5 rounded-2xl border border-slate-700 bg-slate-900/60 overflow-hidden" data-testid="dn-section">
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-slate-700/70 bg-slate-800/70">
        <NotebookPen className="w-4 h-4 text-violet-300" />
        <h4 className="text-[13px] font-extrabold text-white">Daily Notes{businessName ? ` — ${businessName}` : ""}</h4>
        <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider ml-auto flex items-center gap-1">
          <Brain className="w-3 h-3 text-violet-300" /> GoMina AI analyses every note
        </span>
      </div>

      <div className="p-4 space-y-4">
        {/* ── Write a note ── */}
        {canNoteDate ? (
          <div className="space-y-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 2000))}
              rows={3}
              placeholder={`How was ${viewDate === today ? "today" : "yesterday"}? Summarise the activities done, anything you observed, problems that came up and notices the next shift must know…`}
              className="w-full px-3 py-2.5 bg-slate-950/70 border border-slate-700 focus:border-violet-500/50 rounded-xl text-[13px] text-slate-100 outline-none resize-y min-h-[76px]"
              data-testid="dn-input"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-slate-500">{2000 - text.length} characters left</span>
              <button
                onClick={save}
                disabled={busy || text.trim().length < 10}
                className="px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-xs font-bold flex items-center gap-1.5 shadow"
                data-testid="dn-save"
              >
                <Send className="w-3.5 h-3.5" />{busy ? "Analysing…" : "Save Daily Note"}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-slate-500 bg-slate-900/70 border border-slate-800 rounded-xl px-3 py-2.5">
            You are viewing {viewDate}. New notes can only be filed for today or yesterday — switch the checklist date to write one.
          </p>
        )}
        {error && <p className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2" data-testid="dn-error">{error}</p>}

        {/* ── AI read on the note just filed ── */}
        {lastAnalysis && (
          <div className="rounded-xl border border-violet-500/30 bg-violet-500/10 px-3.5 py-3 space-y-1.5" data-testid="dn-last-analysis">
            <p className="text-[10px] font-black uppercase tracking-wider text-violet-300 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" /> GoMina AI read your note
            </p>
            <p className="text-[12px] text-slate-100">{lastAnalysis.summary}</p>
            <div className="flex flex-wrap gap-1.5">
              <span className={`text-[9px] font-black px-1.5 py-0.5 rounded border ${SEV[(lastAnalysis.severity || "INFO") as Severity].chip}`}>
                {(lastAnalysis.severity || "INFO").toUpperCase()}
              </span>
              {(lastAnalysis.flags || []).map((f: string, i: number) => (
                <span key={i} className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300" data-testid={`dn-flag-${i}`}>{f}</span>
              ))}
            </div>
          </div>
        )}

        {/* ── AI Daily Summary ── */}
        {(daySummary?.summary || notes.length > 0) && (
          <div className="rounded-xl border border-slate-700 bg-slate-800/70 px-3.5 py-3" data-testid="dn-day-summary">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 flex items-center gap-1.5 mb-1.5">
              <Brain className="w-3.5 h-3.5 text-violet-300" /> AI daily summary — {viewDate}
              {daySummary?.severity && (
                <span className={`ml-auto text-[9px] font-black px-1.5 py-0.5 rounded border ${SEV[daySummary.severity as Severity].chip}`}>
                  {SEV[daySummary.severity as Severity].label}
                </span>
              )}
            </p>
            {daySummary?.summary && <p className="text-[12px] text-slate-200">{daySummary.summary}</p>}
            {(daySummary?.flags || []).length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {daySummary.flags.map((f: string, i: number) => (
                  <span key={i} className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-amber-200">{f}</span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Notes of the day ── */}
        {loading ? (
          <p className="text-[11px] text-slate-500">Loading daily notes…</p>
        ) : sortedNotes.length === 0 ? (
          <p className="text-[11px] text-slate-500" data-testid="dn-empty">No notes yet for {viewDate} — the first daily note starts this unit's AI history.</p>
        ) : (
          <div className="space-y-2" data-testid="dn-notes">
            {sortedNotes.map((n) => {
              const sev = (n.aiSeverity || "INFO") as Severity;
              const mine = n.userId != null && Number(n.userId) === Number(currentUser?.id);
              return (
                <article key={n.id} className="rounded-xl border border-slate-800 bg-slate-900/70 px-3.5 py-2.5" data-testid={`dn-note-${n.id}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`w-2 h-2 rounded-full ${SEV[sev].dot}`} title={sev} />
                    <span className="text-[11px] font-extrabold text-white">{n.userName}</span>
                    <span className="text-[9px] font-bold text-slate-500">{n.userRole} · {n.createdAt ? new Date(n.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                    {(mine || canModerate) && (
                      <button
                        onClick={() => withdraw(n.id)}
                        disabled={busy}
                        className="ml-auto p-1 rounded text-slate-500 hover:text-rose-300"
                        title={mine ? "Withdraw my note" : "Withdraw note"}
                        data-testid={`dn-del-${n.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <p className="text-[12px] text-slate-200 mt-1 whitespace-pre-wrap">{n.content}</p>
                  {(n.aiFlags || []).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {sev !== "INFO" && (
                        <span className={`text-[9px] font-black px-1.5 py-0.5 rounded border ${SEV[sev].chip}`}>{sev}</span>
                      )}
                      {(n.aiFlags as string[]).map((f, i) => (
                        <span key={i} className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400">{f}</span>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}

        {/* ── AI Business Insights (living history) ── */}
        {insights && insights.notesAnalyzed > 0 && (
          <div className="rounded-xl border border-slate-700 bg-slate-900/80 overflow-hidden" data-testid="dn-insights">
            <div className="px-3.5 py-2.5 flex items-center gap-2 border-b border-slate-800">
              <TrendingUp className="w-3.5 h-3.5 text-cyan-300" />
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">AI business insights</p>
              <span className="ml-auto text-[9px] text-slate-500 font-bold">
                {insights.notesAnalyzed} note{insights.notesAnalyzed === 1 ? "" : "s"} · {(insights.history || []).length} day{(insights.history || []).length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="px-3.5 py-2.5 space-y-2.5">
              {insights.rollingSummary && (
                <p className="text-[12px] text-slate-200 leading-relaxed" data-testid="dn-rolling">{insights.rollingSummary}</p>
              )}
              {(insights.issueRegister || []).length > 0 && (
                <div className="flex flex-wrap gap-1.5" data-testid="dn-register">
                  {insights.issueRegister.slice(0, 6).map((r: any) => (
                    <span
                      key={r.category}
                      className={`inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border ${r.count >= 3 ? "bg-rose-500/10 border-rose-500/40 text-rose-300" : "bg-slate-800 border-slate-700 text-slate-300"}`}
                      title={`${r.label} — first ${r.firstDate}, latest ${r.lastDate}`}
                      data-testid={`dn-reg-${r.category}`}
                    >
                      {r.count >= 3 && <Flame className="w-2.5 h-2.5" />}
                      {r.category.toLowerCase()} {r.count}×{r.count >= 3 ? " recurring" : ""}
                    </span>
                  ))}
                </div>
              )}
              <button
                onClick={() => setHistoryOpen((v) => !v)}
                className="flex items-center gap-1 text-[10px] font-bold text-cyan-300 hover:text-cyan-200"
                data-testid="dn-history-toggle"
              >
                <History className="w-3 h-3" /> Business history ({(insights.history || []).length})
                {historyOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
              {historyOpen && (
                <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1" data-testid="dn-history">
                  {(insights.history || []).map((h: any) => (
                    <div key={h.date} className="flex items-start gap-2 text-[11px] rounded-lg bg-slate-950/60 border border-slate-800 px-2.5 py-2" data-testid={`dn-history-item-${h.date}`}>
                      <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${SEV[(h.severity || "INFO") as Severity].dot}`} />
                      <div className="min-w-0">
                        <p className="font-extrabold text-slate-300">{h.date}{h.noteCount > 1 ? ` · ${h.noteCount} notes` : ""}</p>
                        <p className="text-slate-400">{h.summary}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {insights && insights.notesAnalyzed === 0 && !loading && (
          <p className="text-[10px] text-slate-600 flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3" /> The AI history for this unit starts with its first daily note — every note afterwards sharpens it.
          </p>
        )}
      </div>
    </section>
  );
}
