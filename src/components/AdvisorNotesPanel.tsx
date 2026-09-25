"use client";

/**
 * Advisor Notes & Guidance — the farm-facing panel (mounted on the Poultry /
 * Aquaculture dashboards) and the advisor's writing surface.
 *
 *  - Lists every advisor note for the unit with priority / category chips,
 *    the AI severity + data-corroboration verdict, follow-up status & due
 *    date, flock/batch and record links.
 *  - Expands into the immutable response thread (advisor ↔ staff).
 *  - Authorized users (advisor + records-authorized staff) compose new notes
 *    through the shared AdvisorNoteComposer; staff respond and advance the
 *    follow-up lifecycle (OPEN → IN_PROGRESS → ADDRESSED → CLOSED).
 *
 * The API enforces all of this server-side; this panel only mirrors it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpenCheck,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  Eye,
  MessageSquare,
  Plus,
  Send,
  X,
} from "lucide-react";

const PRI_STYLE: Record<string, string> = {
  CRITICAL: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  HIGH: "bg-orange-500/15 text-orange-300 border-orange-500/40",
  MEDIUM: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  LOW: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
};
const STATUS_STYLE: Record<string, string> = {
  OPEN: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  IN_PROGRESS: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  ADDRESSED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  CLOSED: "bg-slate-500/15 text-slate-300 border-slate-500/40",
};
const VERDICT_STYLE: Record<string, string> = {
  CORROBORATED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  PARTIALLY_CORROBORATED: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  CONTRADICTED: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  NO_DATA: "bg-slate-500/15 text-slate-300 border-slate-500/40",
  NOT_APPLICABLE: "bg-slate-500/10 text-slate-400 border-slate-500/30",
};
const CATEGORIES = [
  "GROWTH", "FEED_NUTRITION", "HEALTH_DISEASE", "MORTALITY", "WATER_QUALITY",
  "BIOSECURITY", "STOCKING", "ENVIRONMENT", "MANAGEMENT", "MARKET_TIMING", "GENERAL",
];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const catLabel = (c: string) => String(c || "").toLowerCase().replace(/_/g, " ");

export function AdvisorNoteComposer({
  businessId,
  currentUser,
  flocks = [],
  batches = [],
  initial,
  onClose,
  onSaved,
}: {
  businessId: number;
  currentUser: any;
  flocks?: any[];
  batches?: any[];
  /** Pre-filled context (quick-add from a flock row / variance chip). */
  initial?: { flockId?: number | null; batchId?: number | null; recordType?: string; recordId?: number; recordRef?: string; title?: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [noteDate, setNoteDate] = useState(today);
  const [flockId, setFlockId] = useState<string>(initial?.flockId ? String(initial.flockId) : "");
  const [batchId, setBatchId] = useState<string>(initial?.batchId ? String(initial.batchId) : "");
  const [category, setCategory] = useState("GENERAL");
  const [priority, setPriority] = useState("MEDIUM");
  const [title, setTitle] = useState(initial?.title || "");
  const [body, setBody] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/advisor-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          noteDate,
          flockId: flockId ? Number(flockId) : null,
          batchId: batchId ? Number(batchId) : null,
          recordType: initial?.recordType || null,
          recordId: initial?.recordId || null,
          category,
          priority,
          title,
          body,
          followUpDueDate: dueDate || null,
        }),
      });
      const d = await res.json();
      if (!res.ok || !d.success) {
        setErr(d.error || "Could not save the note.");
        return;
      }
      onSaved();
    } catch {
      setErr("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-6 bg-slate-950/70 backdrop-blur-sm" data-testid="advisor-note-composer">
      <div className="w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl border border-teal-500/30 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 sticky top-0 bg-slate-900 rounded-t-2xl">
          <div className="flex items-center gap-2">
            <BookOpenCheck className="w-4 h-4 text-teal-400" />
            <h3 className="text-sm font-bold text-white">Advisor Note — observation &amp; recommendation</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400" aria-label="Close composer">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Farm date</label>
              <input type="date" value={noteDate} max={today} onChange={(e) => setNoteDate(e.target.value)}
                className="w-full px-2.5 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs focus:outline-none" />
            </div>
            {flocks.length > 0 && (
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Flock</label>
                <select value={flockId} onChange={(e) => setFlockId(e.target.value)}
                  className="w-full px-2.5 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs focus:outline-none">
                  <option value="">— whole farm —</option>
                  {flocks.map((f: any) => (
                    <option key={f.id} value={f.id}>{f.batchNumber} ({f.birdType})</option>
                  ))}
                </select>
              </div>
            )}
            {batches.length > 0 && (
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Batch</label>
                <select value={batchId} onChange={(e) => setBatchId(e.target.value)}
                  className="w-full px-2.5 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs focus:outline-none">
                  <option value="">— whole farm —</option>
                  {batches.map((b: any) => (
                    <option key={b.id} value={b.id}>{b.batchNumber} ({b.species})</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Follow-up due</label>
              <input type="date" value={dueDate} min={today} onChange={(e) => setDueDate(e.target.value)}
                className="w-full px-2.5 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs focus:outline-none" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)}
                className="w-full px-2.5 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs focus:outline-none">
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{catLabel(c)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Priority</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value)}
                className="w-full px-2.5 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs focus:outline-none">
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          </div>
          {initial?.recordRef && (
            <div className="text-[10px] text-teal-300 bg-teal-500/10 border border-teal-500/30 rounded-lg px-3 py-2">
              Linked record: {initial.recordRef}
            </div>
          )}
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Title *</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Weight gain below target in House 2"
              data-testid="advisor-note-title-input"
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none" />
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Observation &amp; recommendation *</label>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5}
              placeholder="What you saw, what the data should confirm, and what you recommend…"
              data-testid="advisor-note-body-input"
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none" />
            <p className="text-[10px] text-slate-500 mt-1">
              GoMina AI analyzes the note on save and cross-checks it against the flock/batch benchmark KPIs.
            </p>
          </div>
          {err && (
            <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{err}</div>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold">
              Cancel
            </button>
            <button onClick={submit} disabled={busy || title.trim().length < 3 || body.trim().length < 10}
              data-testid="advisor-note-save"
              className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white text-xs font-bold flex items-center gap-1.5">
              <Send className="w-3.5 h-3.5" /> {busy ? "Analyzing…" : "Save note"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AdvisorNotesPanel({
  businessId,
  businessName,
  currentUser,
  flocks = [],
  batches = [],
}: {
  businessId: number;
  businessName?: string | null;
  currentUser: any;
  flocks?: any[];
  batches?: any[];
}) {
  const [notes, setNotes] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [threads, setThreads] = useState<Record<number, any[]>>({});
  const [respondText, setRespondText] = useState<Record<number, string>>({});
  const [composing, setComposing] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const role = String(currentUser?.role || "").toUpperCase();
  const isAdvisor = role === "FARM_ADVISOR";
  const canCompose = isAdvisor || ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"].includes(role) || currentUser?.canManageRecords === true;
  const canWorkFollowUps = canCompose;

  const load = useCallback(async () => {
    if (!businessId) return;
    try {
      const res = await fetch(`/api/advisor-notes?businessId=${businessId}`);
      const d = await res.json();
      if (res.ok && d.success) {
        setNotes(d.notes || []);
        setStats(d.stats || null);
      }
    } catch {
      /* transient */
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    load();
  }, [load]);

  const openThread = async (id: number) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!threads[id]) {
      try {
        const res = await fetch(`/api/advisor-notes?noteId=${id}`);
        const d = await res.json();
        if (res.ok && d.success) setThreads((t) => ({ ...t, [id]: d.updates || [] }));
      } catch {
        /* transient */
      }
    }
  };

  const respond = async (id: number) => {
    const text = (respondText[id] || "").trim();
    if (!text) return;
    setBusyId(id);
    try {
      const res = await fetch("/api/advisor-notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "RESPOND", note: text }),
      });
      const d = await res.json();
      if (res.ok && d.success) {
        setRespondText((r) => ({ ...r, [id]: "" }));
        const t = await fetch(`/api/advisor-notes?noteId=${id}`).then((x) => x.json());
        if (t.success) setThreads((th) => ({ ...th, [id]: t.updates || [] }));
        await load();
      }
    } finally {
      setBusyId(null);
    }
  };

  const setStatus = async (id: number, status: string) => {
    setBusyId(id);
    try {
      await fetch("/api/advisor-notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "STATUS", status }),
      });
      const t = await fetch(`/api/advisor-notes?noteId=${id}`).then((x) => x.json());
      if (t.success) setThreads((th) => ({ ...th, [id]: t.updates || [] }));
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const today = new Date().toISOString().slice(0, 10);
  const openFollowUps = useMemo(
    () => notes.filter((n) => ["OPEN", "IN_PROGRESS"].includes(String(n.followUpStatus))),
    [notes],
  );

  return (
    <div className="rounded-2xl border border-teal-500/25 bg-slate-900/70 p-4 sm:p-5" data-testid="advisor-notes-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="w-4 h-4 text-teal-400" />
          <h3 className="text-sm font-bold text-white">Advisor Notes &amp; Guidance</h3>
          {stats && (
            <span className="text-[9px] font-black text-teal-300 bg-teal-500/15 border border-teal-500/30 px-1.5 py-0.5 rounded">
              {stats.open + stats.inProgress} OPEN{stats.overdue ? ` · ${stats.overdue} OVERDUE` : ""}
            </span>
          )}
        </div>
        {canCompose && (
          <button
            onClick={() => setComposing(true)}
            data-testid="advisor-note-add-btn"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold shadow"
          >
            <Plus className="w-3.5 h-3.5" /> {isAdvisor ? "New Note" : "Add Guidance Note"}
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-xs text-slate-400 py-4">Loading advisor notes…</p>
      ) : notes.length === 0 ? (
        <p className="text-xs text-slate-400 py-4">
          No advisor notes yet{businessName ? ` for ${businessName}` : ""} — observations, recommendations and follow-ups from the farm advisor appear here.
        </p>
      ) : (
        <div className="space-y-2">
          {notes.slice(0, 12).map((n) => {
            const overdue = ["OPEN", "IN_PROGRESS"].includes(String(n.followUpStatus)) && n.followUpDueDate && String(n.followUpDueDate) < today;
            const isOpen = expanded === n.id;
            return (
              <div key={n.id} className="rounded-xl border border-slate-700/70 bg-slate-800/50 overflow-hidden" data-testid={`advisor-note-item-${n.id}`}>
                <button onClick={() => openThread(n.id)} className="w-full text-left px-3.5 py-3 hover:bg-slate-800/80 transition">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`text-[8px] font-black px-1.5 py-0.5 rounded border ${PRI_STYLE[n.priority] || PRI_STYLE.MEDIUM}`}>
                          {n.priority}
                        </span>
                        <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-slate-700/70 text-slate-300 border border-slate-600/60">
                          {catLabel(n.category)}
                        </span>
                        <span className={`text-[8px] font-black px-1.5 py-0.5 rounded border ${STATUS_STYLE[n.followUpStatus] || ""}`}>
                          {String(n.followUpStatus).replace("_", " ")}
                        </span>
                        {overdue && (
                          <span className="text-[8px] font-black px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/40" data-testid={`advisor-note-overdue-${n.id}`}>
                            OVERDUE
                          </span>
                        )}
                        {n.aiSeverity === "URGENT" && (
                          <span className="text-[8px] font-black px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/40">AI: URGENT</span>
                        )}
                        {n.aiCorroboration?.verdict && n.aiCorroboration.verdict !== "NOT_APPLICABLE" && (
                          <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded border ${VERDICT_STYLE[n.aiCorroboration.verdict] || ""}`} title={(n.aiCorroboration.lines || []).join(" ")}>
                            DATA: {String(n.aiCorroboration.verdict).replace(/_/g, " ")}
                          </span>
                        )}
                      </div>
                      <div className="text-xs font-bold text-slate-100 mt-1.5 truncate">{n.title}</div>
                      <div className="text-[10px] text-slate-400 mt-0.5">
                        {n.noteDate} · {n.authorName}
                        {n.flockLabel ? ` · ${n.flockLabel}` : ""}
                        {n.batchLabel ? ` · ${n.batchLabel}` : ""}
                        {n.recordRef ? ` · ${n.recordRef}` : ""}
                        {n.followUpDueDate ? ` · due ${n.followUpDueDate}` : ""}
                      </div>
                    </div>
                    {isOpen ? <ChevronUp className="w-4 h-4 text-slate-500 shrink-0" /> : <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />}
                  </div>
                </button>

                {isOpen && (
                  <div className="px-3.5 pb-3.5 border-t border-slate-700/60 pt-3 space-y-3">
                    <p className="text-xs text-slate-300 whitespace-pre-wrap leading-relaxed">{n.body}</p>
                    {n.photo && <img src={n.photo} alt="note evidence" className="max-h-48 rounded-lg border border-slate-700" />}
                    {n.aiSummary && (
                      <div className="rounded-lg bg-slate-900/80 border border-slate-700/60 px-3 py-2">
                        <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-teal-300 mb-1">
                          <Eye className="w-3 h-3" /> GoMina AI analysis
                        </div>
                        <p className="text-[11px] text-slate-300">{n.aiSummary}</p>
                        {Array.isArray(n.aiFlags) && n.aiFlags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {n.aiFlags.slice(0, 6).map((f: string, i: number) => (
                              <span key={i} className="text-[9px] bg-slate-800 border border-slate-600/60 text-slate-300 px-1.5 py-0.5 rounded">{f}</span>
                            ))}
                          </div>
                        )}
                        {n.aiCorroboration?.lines?.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-slate-700/60 space-y-1">
                            <div className="text-[10px] font-bold text-slate-400">Farm-data cross-check{n.aiCorroboration.subject ? ` — ${n.aiCorroboration.subject}` : ""}:</div>
                            {n.aiCorroboration.lines.map((l: string, i: number) => (
                              <p key={i} className="text-[10px] text-slate-400">• {l}</p>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Immutable thread */}
                    <div className="space-y-1.5">
                      {(threads[n.id] || []).map((u: any) => (
                        <div key={u.id} className="text-[11px] rounded-lg bg-slate-900/60 border border-slate-700/50 px-3 py-2">
                          <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
                            <MessageSquare className="w-3 h-3" />
                            <span className="font-bold text-slate-300">{u.actorName}</span>
                            <span className="text-slate-500">{u.action.replace(/_/g, " ").toLowerCase()}{u.statusTo && u.action === "STATUS_CHANGE" ? ` → ${u.statusTo}` : ""}</span>
                          </div>
                          {u.note && <p className="text-slate-300 mt-1 whitespace-pre-wrap">{u.note}</p>}
                        </div>
                      ))}
                      {(threads[n.id] || []).length === 0 && <p className="text-[10px] text-slate-500">No responses yet.</p>}
                    </div>

                    {/* Respond + lifecycle */}
                    {canWorkFollowUps && (
                      <div className="space-y-2">
                        <div className="flex gap-2">
                          <input
                            value={respondText[n.id] || ""}
                            onChange={(e) => setRespondText((r) => ({ ...r, [n.id]: e.target.value }))}
                            placeholder="Respond to the advisor…"
                            data-testid={`advisor-note-respond-input-${n.id}`}
                            className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs focus:outline-none"
                          />
                          <button
                            onClick={() => respond(n.id)}
                            disabled={busyId === n.id || !(respondText[n.id] || "").trim()}
                            data-testid={`advisor-note-respond-send-${n.id}`}
                            className="px-3 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white text-xs font-bold flex items-center gap-1"
                          >
                            <Send className="w-3 h-3" /> Send
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {["OPEN", "IN_PROGRESS", "ADDRESSED", "CLOSED"]
                            .filter((s) => s !== n.followUpStatus)
                            .map((s) => (
                              <button
                                key={s}
                                onClick={() => setStatus(n.id, s)}
                                disabled={busyId === n.id}
                                data-testid={`advisor-note-status-${n.id}-${s}`}
                                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600/60 text-slate-300 text-[10px] font-bold disabled:opacity-40"
                              >
                                Mark {s.replace("_", " ")}
                              </button>
                            ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {notes.length > 12 && (
            <p className="text-[10px] text-slate-500 text-center pt-1">
              + {notes.length - 12} earlier note{notes.length - 12 === 1 ? "" : "s"} — full history in the Advisor console.
            </p>
          )}
        </div>
      )}

      {composing && (
        <AdvisorNoteComposer
          businessId={businessId}
          currentUser={currentUser}
          flocks={flocks}
          batches={batches}
          onClose={() => setComposing(false)}
          onSaved={() => {
            setComposing(false);
            load();
          }}
        />
      )}
    </div>
  );
}
