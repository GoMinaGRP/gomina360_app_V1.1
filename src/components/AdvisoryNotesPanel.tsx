"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Brain,
  Camera,
  CheckCircle2,
  ClipboardList,
  Clock,
  Loader2,
  MessageSquare,
  NotebookPen,
  Send,
  ShieldCheck,
  Stethoscope,
  X,
} from "lucide-react";

/**
 * AdvisoryNotesPanel — the shared advisory conversation.
 *
 * ONE component serves both sides:
 *  • the external Farm Advisor (canWrite) files observations, recommendations,
 *    follow-ups, visit reports and risks — with photos, a linked flock/record,
 *    a priority and an optional assignment that enters the audit pipeline;
 *  • the Owner / managers acknowledge, start, complete, close and reply.
 *
 * Every note shows its GoMina AI analysis (summary, severity, flags) — the
 * same engine that analyses staff daily notes.
 */

const SEV: Record<string, { chip: string; label: string }> = {
  INFO: { chip: "bg-emerald-500/15 border-emerald-500/40 text-emerald-300", label: "Normal" },
  WATCH: { chip: "bg-amber-500/15 border-amber-500/40 text-amber-300", label: "Watch" },
  URGENT: { chip: "bg-rose-500/15 border-rose-500/40 text-rose-300", label: "Urgent" },
};

const PRIO: Record<string, string> = {
  LOW: "bg-slate-700 text-slate-300",
  MEDIUM: "bg-sky-500/20 text-sky-300 border border-sky-500/40",
  HIGH: "bg-amber-500/20 text-amber-300 border border-amber-500/40",
  CRITICAL: "bg-rose-500/20 text-rose-300 border border-rose-500/40",
};

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: "Submitted",
  ACKNOWLEDGED: "Acknowledged",
  IN_PROGRESS: "In progress",
  DONE: "Done",
  CLOSED: "Closed",
};

const NOTE_TYPES = [
  { key: "OBSERVATION", label: "Observation" },
  { key: "RECOMMENDATION", label: "Recommendation" },
  { key: "FOLLOW_UP", label: "Follow-up" },
  { key: "VISIT_REPORT", label: "Visit report" },
  { key: "RISK", label: "Risk" },
];

export default function AdvisoryNotesPanel({
  businessId,
  businessName,
  currentUser,
  flocks = [],
  staff = [],
  canWrite,
  onChanged,
  compact = false,
}: {
  businessId: number | null | undefined;
  businessName?: string;
  currentUser: any;
  flocks?: any[];
  staff?: any[];
  canWrite: boolean;
  onChanged?: () => void;
  compact?: boolean;
}) {
  const today = new Date().toLocaleDateString("en-CA");
  const [notes, setNotes] = useState<any[]>([]);
  const [replies, setReplies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [replyText, setReplyText] = useState("");
  const [filter, setFilter] = useState<"ALL" | "OPEN" | "ACTION">("ALL");

  // composer
  const [noteType, setNoteType] = useState("OBSERVATION");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [flockId, setFlockId] = useState<string>("");
  const [obsDate, setObsDate] = useState(today);
  const [priority, setPriority] = useState("MEDIUM");
  const [requiresAction, setRequiresAction] = useState(false);
  const [assignedUserId, setAssignedUserId] = useState<string>("");
  const [dueDate, setDueDate] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    if (!businessId) return;
    try {
      const res = await fetch(`/api/advisor/notes?businessId=${businessId}`);
      const d = await res.json();
      if (d.success) {
        setNotes(d.notes || []);
        setReplies(d.replies || []);
        setError("");
      } else setError(d.error || "Could not load advisory notes.");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const addPhoto = (file: File) => {
    if (!file || photos.length >= 4) return;
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result || "");
      if (data.startsWith("data:image/") && data.length < 900_000) setPhotos((p) => [...p, data].slice(0, 4));
      else setError("Photos must be images under ~650 KB.");
    };
    reader.readAsDataURL(file);
  };

  const submit = async () => {
    if (!businessId || busy) return;
    if (title.trim().length < 4 || body.trim().length < 10) {
      setError("Give the note a title and at least a sentence of detail.");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await fetch("/api/advisor/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          noteType,
          title: title.trim(),
          body: body.trim(),
          observationDate: obsDate,
          priority,
          flockId: flockId ? Number(flockId) : null,
          requiresAction,
          assignedUserId: requiresAction && assignedUserId ? Number(assignedUserId) : null,
          dueDate: requiresAction && dueDate ? dueDate : null,
          photos,
        }),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || "Could not file the note.");
      setTitle(""); setBody(""); setPhotos([]); setRequiresAction(false); setAssignedUserId(""); setDueDate("");
      setNotice(`Note filed · AI severity ${d.analysis?.severity || "INFO"}${d.note?.linkedIssueId ? " · follow-up raised" : ""}`);
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: number, action: string, extra: any = {}) => {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/advisor/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, ...extra }),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || "Action failed.");
      setReplyText("");
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const role = String(currentUser?.role || "").toUpperCase();
  const isStaffSide = ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER", "SUPERVISOR"].includes(role);
  const shown = useMemo(() => {
    let list = [...notes];
    if (filter === "OPEN") list = list.filter((n) => !["CLOSED", "DONE"].includes(n.status) && !n.withdrawnAt);
    if (filter === "ACTION") list = list.filter((n) => n.requiresAction && !["CLOSED", "DONE"].includes(n.status));
    return list;
  }, [notes, filter]);

  const flockLabel = (id: any) => {
    const f = flocks.find((x) => Number(x.id) === Number(id));
    return f ? `${f.flockName || f.batchNumber}` : null;
  };

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900/60 overflow-hidden" data-testid="adv-notes-panel">
      <div className="flex flex-wrap items-center gap-2 px-4 sm:px-5 py-3.5 border-b border-slate-700/70 bg-slate-800/70">
        <Stethoscope className="w-4 h-4 text-cyan-300" />
        <h4 className="text-[13px] font-extrabold text-white">
          Advisor Notes &amp; Recommendations{businessName ? ` — ${businessName}` : ""}
        </h4>
        <span className="ml-auto flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-slate-500">
          <Brain className="w-3 h-3 text-violet-300" /> GoMina AI analyses every note
        </span>
      </div>

      <div className="p-3 sm:p-4 space-y-4">
        {error && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200" data-testid="adv-notes-error">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200" data-testid="adv-notes-notice">
            {notice}
          </div>
        )}

        {/* ── Composer (advisors, and management recording advisory outcomes) ── */}
        {canWrite && (
          <div className="rounded-xl border border-slate-700 bg-slate-950/50 p-3 space-y-2.5" data-testid="adv-note-composer">
            <div className="flex flex-wrap gap-1.5">
              {NOTE_TYPES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setNoteType(t.key)}
                  className={`rounded-lg px-2.5 py-1.5 text-[10px] font-bold transition ${
                    noteType === t.key ? "bg-cyan-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  }`}
                  data-testid={`adv-note-type-${t.key}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 200))}
              placeholder="Title — e.g. Respiratory signs in House 2"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-[12px] text-white outline-none focus:border-cyan-500"
              data-testid="adv-note-title"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, 4000))}
              rows={4}
              placeholder="Observation, professional assessment and recommended action…"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-[12px] text-white outline-none focus:border-cyan-500"
              data-testid="adv-note-body"
            />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <select value={flockId} onChange={(e) => setFlockId(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-[11px] text-white" data-testid="adv-note-flock">
                <option value="">Whole farm</option>
                {flocks.map((f) => (
                  <option key={f.id} value={f.id}>{f.flockName || f.batchNumber}</option>
                ))}
              </select>
              <input type="date" max={today} value={obsDate} onChange={(e) => setObsDate(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-[11px] text-white" data-testid="adv-note-date" />
              <select value={priority} onChange={(e) => setPriority(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-[11px] text-white" data-testid="adv-note-priority">
                {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex items-center justify-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-[11px] font-bold text-slate-300 hover:bg-slate-800"
                data-testid="adv-note-photo-btn"
              >
                <Camera className="h-3.5 w-3.5" /> Photo {photos.length ? `(${photos.length})` : ""}
              </button>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && addPhoto(e.target.files[0])} data-testid="adv-note-photo-input" />
            </div>
            {photos.length > 0 && (
              <div className="flex gap-2">
                {photos.map((p, i) => (
                  <div key={i} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p} alt="" className="h-12 w-12 rounded-lg object-cover border border-slate-700" />
                    <button type="button" onClick={() => setPhotos((x) => x.filter((_, j) => j !== i))} className="absolute -right-1 -top-1 rounded-full bg-rose-600 p-0.5 text-white">
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <label className="flex items-center gap-2 text-[11px] font-bold text-slate-300">
              <input type="checkbox" checked={requiresAction} onChange={(e) => setRequiresAction(e.target.checked)} data-testid="adv-note-requires-action" />
              Requires action by farm staff (creates a tracked follow-up)
            </label>
            {requiresAction && (
              <div className="grid grid-cols-2 gap-2">
                <select value={assignedUserId} onChange={(e) => setAssignedUserId(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-[11px] text-white" data-testid="adv-note-assignee">
                  <option value="">Assign to… (optional)</option>
                  {staff.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.role}</option>)}
                </select>
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-[11px] text-white" data-testid="adv-note-due" />
              </div>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={submit}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-600 px-4 py-2.5 text-[12px] font-black text-white hover:bg-cyan-500 disabled:opacity-50"
              data-testid="adv-note-submit"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} File advisory note
            </button>
          </div>
        )}

        {/* ── Filters ── */}
        <div className="flex items-center gap-1.5">
          {(["ALL", "OPEN", "ACTION"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-lg px-2.5 py-1 text-[10px] font-bold ${filter === f ? "bg-slate-200 text-slate-900" : "bg-slate-800 text-slate-400"}`}
              data-testid={`adv-notes-filter-${f}`}
            >
              {f === "ALL" ? "All" : f === "OPEN" ? "Open" : "Needs action"}
            </button>
          ))}
          <span className="ml-auto text-[10px] font-bold text-slate-500" data-testid="adv-notes-count">{shown.length} note(s)</span>
        </div>

        {/* ── Notes ── */}
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-[12px] text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading advisory notes…</div>
        ) : shown.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-700 py-6 text-center text-[12px] text-slate-500" data-testid="adv-notes-empty">
            No advisory notes yet.
          </div>
        ) : (
          <div className="space-y-2.5">
            {shown.slice(0, compact ? 5 : 100).map((n) => {
              const sev = SEV[String(n.aiSeverity || "INFO")] || SEV.INFO;
              const thread = replies.filter((r) => Number(r.noteId) === Number(n.id));
              const open = openId === n.id;
              return (
                <article key={n.id} className={`rounded-xl border p-3 ${n.withdrawnAt ? "border-slate-800 bg-slate-950/40 opacity-60" : "border-slate-700 bg-slate-950/50"}`} data-testid={`adv-note-${n.id}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`rounded-md px-1.5 py-0.5 text-[9px] font-black ${PRIO[n.priority] || PRIO.MEDIUM}`}>{n.priority}</span>
                    <span className="rounded-md bg-slate-800 px-1.5 py-0.5 text-[9px] font-bold text-slate-300">{String(n.noteType).replace("_", " ")}</span>
                    <span className={`rounded-md border px-1.5 py-0.5 text-[9px] font-bold ${sev.chip}`} data-testid={`adv-note-sev-${n.id}`}>AI {sev.label}</span>
                    <span className="rounded-md bg-slate-800 px-1.5 py-0.5 text-[9px] font-bold text-cyan-300" data-testid={`adv-note-status-${n.id}`}>{STATUS_LABEL[n.status] || n.status}</span>
                    {n.requiresAction && <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-300">Action required</span>}
                    {n.linkedIssueId && <span className="rounded-md bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-bold text-violet-300">Issue #{n.linkedIssueId}</span>}
                    <span className="ml-auto text-[9px] font-bold text-slate-500">{n.observationDate}</span>
                  </div>
                  <h5 className="mt-1.5 text-[12.5px] font-extrabold text-white">{n.title}</h5>
                  <p className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed text-slate-300">{n.body}</p>
                  {n.flockId && <p className="mt-1 text-[10px] font-bold text-emerald-300">Flock: {flockLabel(n.flockId) || `#${n.flockId}`}</p>}
                  {Array.isArray(n.photos) && n.photos.length > 0 && (
                    <div className="mt-2 flex gap-2">
                      {n.photos.map((p: string, i: number) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={i} src={p} alt="" className="h-14 w-14 rounded-lg border border-slate-700 object-cover" />
                      ))}
                    </div>
                  )}
                  {n.aiSummary && (
                    <div className="mt-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-1.5 text-[10.5px] text-violet-200" data-testid={`adv-note-ai-${n.id}`}>
                      <Brain className="mr-1 inline h-3 w-3" /> {n.aiSummary}
                      {Array.isArray(n.aiFlags) && n.aiFlags.length > 0 && (
                        <span className="ml-1 text-violet-300/80">· {n.aiFlags.join(" · ")}</span>
                      )}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[9.5px] font-bold text-slate-500">By {n.authorName}{n.assignedUserName ? ` → ${n.assignedUserName}` : ""}{n.dueDate ? ` · due ${n.dueDate}` : ""}</span>
                    <button type="button" onClick={() => setOpenId(open ? null : n.id)} className="ml-auto flex items-center gap-1 rounded-lg bg-slate-800 px-2 py-1 text-[10px] font-bold text-slate-300 hover:bg-slate-700" data-testid={`adv-note-thread-${n.id}`}>
                      <MessageSquare className="h-3 w-3" /> {thread.length}
                    </button>
                  </div>

                  {open && (
                    <div className="mt-2 space-y-2 border-t border-slate-800 pt-2">
                      {thread.map((r) => (
                        <div key={r.id} className="rounded-lg bg-slate-900 px-2.5 py-1.5 text-[10.5px] text-slate-300">
                          <span className="font-bold text-slate-200">{r.actorName}</span>
                          <span className="text-slate-500"> · {r.action}{r.statusTo && r.statusTo !== r.statusFrom ? ` → ${r.statusTo}` : ""}</span>
                          {r.body && <p className="mt-0.5 whitespace-pre-wrap">{r.body}</p>}
                        </div>
                      ))}
                      <div className="flex gap-1.5">
                        <input
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          placeholder="Write a reply…"
                          className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-[11px] text-white outline-none focus:border-cyan-500"
                          data-testid={`adv-reply-input-${n.id}`}
                        />
                        <button type="button" disabled={busy || !replyText.trim()} onClick={() => act(n.id, "REPLY", { body: replyText })} className="rounded-lg bg-slate-700 px-2.5 py-1.5 text-[10px] font-bold text-white disabled:opacity-40" data-testid={`adv-reply-send-${n.id}`}>
                          Reply
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {isStaffSide && !n.withdrawnAt && n.status === "SUBMITTED" && (
                          <button type="button" disabled={busy} onClick={() => act(n.id, "ACKNOWLEDGE")} className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[10px] font-bold text-sky-300" data-testid={`adv-ack-${n.id}`}>
                            <CheckCircle2 className="mr-1 inline h-3 w-3" />Acknowledge
                          </button>
                        )}
                        {isStaffSide && !n.withdrawnAt && ["ACKNOWLEDGED", "SUBMITTED"].includes(n.status) && (
                          <button type="button" disabled={busy} onClick={() => act(n.id, "START")} className="rounded-lg border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-[10px] font-bold text-violet-300" data-testid={`adv-start-${n.id}`}>
                            Start work
                          </button>
                        )}
                        {isStaffSide && !n.withdrawnAt && ["IN_PROGRESS", "ACKNOWLEDGED"].includes(n.status) && (
                          <button type="button" disabled={busy} onClick={() => act(n.id, "DONE", { body: replyText || "Advice implemented." })} className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-300" data-testid={`adv-done-${n.id}`}>
                            Mark done
                          </button>
                        )}
                        {isStaffSide && !n.withdrawnAt && n.status !== "CLOSED" && (
                          <button type="button" disabled={busy} onClick={() => act(n.id, "CLOSE", { closureNote: replyText || "Closed by management." })} className="rounded-lg border border-slate-500/40 bg-slate-500/10 px-2 py-1 text-[10px] font-bold text-slate-300" data-testid={`adv-close-${n.id}`}>
                            Close
                          </button>
                        )}
                        {Number(n.authorUserId) === Number(currentUser?.id) && !n.withdrawnAt && (
                          <button type="button" disabled={busy} onClick={() => act(n.id, "WITHDRAW", { body: "Withdrawn by the advisor." })} className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[10px] font-bold text-rose-300" data-testid={`adv-withdraw-${n.id}`}>
                            Withdraw
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
