"use client";

// ─── Unified Action Center (roadmap P1) ────────────────────────────────────
// The one cross-module "who owes what by when" view:
//  • NATIVE TASKS — created here, converted from bell notifications, or
//    mirrored from a linked item; full lifecycle (start / done / cancel /
//    reopen) with completion notes.
//  • LINKED OPEN ITEMS — live, read-only rows from the systems that already
//    track actions (Audit issues, advisor follow-ups, today's checklists).
//    Nothing is duplicated: "Track as task" mirrors an item with a personal
//    deadline, and the daily sweep auto-completes the mirror when the source
//    is resolved.
// Role-aware by design: executives see every task in their scope, managers
// see their units, workers see their own assignments — the API enforces the
// same scoping server-side.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import ApprovalInbox from "@/components/ApprovalInbox";
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  ClipboardList,
  ListTodo,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Stethoscope,
  X,
} from "lucide-react";

type Task = any;
type LinkedItem = any;

const PRIORITY_STYLES: Record<string, string> = {
  CRITICAL: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  HIGH: "bg-orange-500/15 text-orange-300 border-orange-500/40",
  MEDIUM: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  LOW: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
};

const SOURCE_LABELS: Record<string, string> = {
  MANUAL: "Task",
  NOTIFICATION: "From notification",
  AUDIT_ISSUE: "Audit issue",
  ADVISOR_FOLLOW_UP: "Advisor follow-up",
  LOW_STOCK: "Stock alert",
  BUDGET_BREACH: "Budget breach",
  AI_INSIGHT: "AI insight",
};

function daysUntil(dateIso: string | null | undefined, today: string): number | null {
  if (!dateIso) return null;
  const d = Math.round((Date.parse(String(dateIso)) - Date.parse(today)) / 86400000);
  return Number.isFinite(d) ? d : null;
}

export default function ActionCenter({
  currentUser,
  businesses,
  onSelectTab,
}: {
  currentUser: any;
  businesses: any[];
  onSelectTab?: (tab: string) => void;
}) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"MINE" | "ALL">("MINE");
  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [bizFilter, setBizFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [completingId, setCompletingId] = useState<number | null>(null);
  const [completionNote, setCompletionNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const isWorker = String(currentUser?.role || "").toUpperCase() === "WORKER";
  const today = data?.today || new Date().toLocaleDateString("en-CA");

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (view === "MINE" && isWorker) params.set("status", statusFilter === "ACTIVE" ? "ACTIVE" : statusFilter);
      else params.set("status", statusFilter);
      if (priorityFilter) params.set("priority", priorityFilter);
      if (bizFilter) params.set("businessId", bizFilter);
      const res = await fetch(`/api/tasks?${params.toString()}`);
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || "Could not load");
      setData(body);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Could not load the Action Center.");
    } finally {
      setLoading(false);
    }
  }, [view, statusFilter, priorityFilter, bizFilter, isWorker]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  };

  const tasks: Task[] = useMemo(() => {
    if (!data?.tasks) return [];
    let rows = data.tasks;
    if (view === "MINE") rows = rows.filter((t: any) => ["OPEN", "IN_PROGRESS"].includes(t.status) && Number(t.assignedUserId) === Number(currentUser?.id));
    return rows;
  }, [data, view, currentUser?.id]);

  const linked = data?.linked || { auditIssues: [], advisorFollowUps: [], checklist: [] };
  const bizById = useMemo(() => new Map((businesses || []).map((b: any) => [Number(b.id), b])), [businesses]);

  // ── Task lifecycle ──
  const patchTask = async (id: number, payload: any, okMsg: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...payload }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || "Update failed");
      flash(okMsg);
      await load();
    } catch (e: any) {
      flash(e?.message || "Update failed");
    } finally {
      setBusy(false);
      setCompletingId(null);
      setCompletionNote("");
    }
  };

  const trackLinked = async (item: LinkedItem, sourceType: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: item.title,
          detail: item.detail,
          businessId: item.businessId,
          assignedUserId: Number(currentUser?.id),
          priority: item.priority,
          dueDate: item.dueDate || null,
          sourceType,
          sourceId: item.id,
          sourceRef: item.sourceRef || `${sourceType}:${item.id}`,
          sourceLabel: item.sourceLabel || SOURCE_LABELS[sourceType] || "Linked item",
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || "Could not create");
      flash(`Tracking “${String(item.title).slice(0, 40)}” as a task — it will auto-complete when the source is resolved.`);
      await load();
    } catch (e: any) {
      flash(e?.message || "Could not create the task");
    } finally {
      setBusy(false);
    }
  };

  const alreadyTracked = (sourceType: string, sourceId: number) =>
    (data?.tasks || []).some((t: any) => String(t.sourceType).toUpperCase() === sourceType && Number(t.sourceId) === Number(sourceId) && ["OPEN", "IN_PROGRESS"].includes(t.status));

  const stats = data?.stats || { open: 0, overdue: 0, dueToday: 0, noDate: 0, doneRecent: 0, mine: 0, mineOverdue: 0, mineDueToday: 0 };

  return (
    <div className="p-3 sm:p-6 space-y-5 max-w-[1400px] mx-auto text-slate-100" data-testid="action-center">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-5 sm:p-6 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="flex items-start space-x-4">
          <div className="w-14 h-14 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center shadow-lg shrink-0">
            <ListTodo className="w-6 h-6 text-amber-400" />
          </div>
          <div>
            <span className="px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 text-xs font-bold border border-amber-500/30">
              ONE LIST · EVERY MODULE
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 text-white">Action Center</h2>
            <p className="text-xs sm:text-sm text-slate-300 mt-1">
              Everything the team owes — tasks, audit corrections, advisor follow-ups and daily checklists —
              with owners, priorities and deadlines in one place.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => load()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold border border-slate-600 transition"
            data-testid="action-refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          <button
            onClick={() => setShowCreate((s) => !s)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold border border-amber-400/50 shadow transition"
            data-testid="action-new"
          >
            {showCreate ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            {showCreate ? "Close" : "New action"}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="action-stats">
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow">
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">My open actions</p>
          <p className="text-xl sm:text-2xl font-extrabold text-amber-300 mt-1" data-testid="stat-mine">{stats.mine}</p>
        </div>
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow">
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Overdue</p>
          <p className={`text-xl sm:text-2xl font-extrabold mt-1 ${stats.mineOverdue ? "text-rose-300" : "text-slate-400"}`} data-testid="stat-overdue">{stats.mineOverdue}</p>
        </div>
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow">
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Due today</p>
          <p className={`text-xl sm:text-2xl font-extrabold mt-1 ${stats.mineDueToday ? "text-cyan-300" : "text-slate-400"}`} data-testid="stat-due">{stats.mineDueToday}</p>
        </div>
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow">
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Completed · 7 days</p>
          <p className="text-xl sm:text-2xl font-extrabold text-emerald-300 mt-1" data-testid="stat-done">{stats.doneRecent}</p>
        </div>
      </div>

      {/* Create panel */}
      {showCreate && (
        <CreateTaskPanel
          currentUser={currentUser}
          businesses={businesses}
          assignableUsers={data?.assignableUsers || []}
          canManage={!!data?.canManage}
          busy={busy}
          onDone={async (payload) => {
            setBusy(true);
            try {
              const res = await fetch("/api/tasks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              });
              const body = await res.json();
              if (!res.ok || !body.success) throw new Error(body.error || "Could not create");
              flash(`Action ${body.task.taskNumber} created.`);
              setShowCreate(false);
              await load();
            } catch (e: any) {
              flash(e?.message || "Could not create the task");
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2" data-testid="action-filters">
        {!isWorker && (
          <div className="flex rounded-xl overflow-hidden border border-slate-700">
            {(["MINE", "ALL"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 text-xs font-bold transition ${view === v ? "bg-amber-500/20 text-amber-300" : "bg-slate-800 text-slate-400 hover:bg-slate-700"}`}
                data-testid={`filter-view-${v}`}
              >
                {v === "MINE" ? "My actions" : "All actions"}
              </button>
            ))}
          </div>
        )}
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-2.5 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-xs font-semibold text-slate-200"
          data-testid="filter-status"
        >
          <option value="ACTIVE">Open & in progress</option>
          <option value="OPEN">Open only</option>
          <option value="IN_PROGRESS">In progress</option>
          <option value="DONE">Completed</option>
          <option value="CANCELLED">Cancelled</option>
          <option value="">All statuses</option>
        </select>
        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          className="px-2.5 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-xs font-semibold text-slate-200"
        >
          <option value="">Any priority</option>
          {["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select
          value={bizFilter}
          onChange={(e) => setBizFilter(e.target.value)}
          className="px-2.5 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-xs font-semibold text-slate-200"
        >
          <option value="">All businesses</option>
          {(businesses || []).map((b: any) => (
            <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
          ))}
        </select>
        <span className="text-[10px] text-slate-500 ml-auto font-semibold">{tasks.length} shown · {today}</span>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-4 text-sm text-rose-300" data-testid="action-error">{error}</div>
      )}

      {/* Task list */}
      {loading && !data ? (
        <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : tasks.length === 0 ? (
        <div className="rounded-2xl border border-slate-700/70 bg-slate-800/50 p-10 text-center" data-testid="action-empty">
          <CheckCircle2 className="w-10 h-10 text-emerald-400/60 mx-auto mb-3" />
          <p className="text-sm font-bold text-slate-200">All clear — nothing matches this filter.</p>
          <p className="text-xs text-slate-500 mt-1">Create an action or check the linked items below.</p>
        </div>
      ) : (
        <div className="space-y-2.5" data-testid="action-list">
          {tasks.map((t) => {
            const dd = daysUntil(t.dueDate, today);
            const overdue = dd != null && dd < 0 && ["OPEN", "IN_PROGRESS"].includes(t.status);
            const dueToday = dd === 0 && ["OPEN", "IN_PROGRESS"].includes(t.status);
            const isMine = Number(t.assignedUserId) === Number(currentUser?.id);
            return (
              <div
                key={t.id}
                className={`rounded-2xl border p-3.5 sm:p-4 shadow transition ${
                  overdue ? "border-rose-500/40 bg-rose-950/20" : dueToday ? "border-amber-500/30 bg-amber-950/10" : "border-slate-700/70 bg-slate-800/60"
                } ${t.status === "DONE" ? "opacity-60" : ""}`}
                data-testid={`action-task-${t.id}`}
              >
                <div className="flex items-start gap-3">
                  <span className={`mt-0.5 shrink-0 ${t.status === "DONE" ? "text-emerald-400" : t.status === "IN_PROGRESS" ? "text-cyan-400" : "text-slate-500"}`}>
                    {t.status === "DONE" ? <CheckCircle2 className="w-5 h-5" /> : t.status === "IN_PROGRESS" ? <Loader2 className="w-5 h-5" /> : <CircleDashed className="w-5 h-5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className={`text-sm font-bold leading-snug ${t.status === "DONE" ? "line-through text-slate-400" : "text-slate-100"}`}>
                        {t.title}
                      </p>
                      <span className={`shrink-0 text-[8px] font-black px-1.5 py-0.5 rounded border ${PRIORITY_STYLES[t.priority] || PRIORITY_STYLES.MEDIUM}`}>
                        {t.priority}
                      </span>
                    </div>
                    {t.detail && <p className="text-xs text-slate-400 mt-1 line-clamp-2">{t.detail}</p>}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2 text-[10px] text-slate-400">
                      <span className="font-mono text-slate-500">{t.taskNumber}</span>
                      {t.businessCode ? (
                        <span className="px-1.5 py-0.5 rounded bg-slate-700/70 border border-slate-600/60 font-bold text-slate-300">{t.businessCode}</span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded bg-violet-500/15 border border-violet-500/30 font-bold text-violet-300">ORG-WIDE</span>
                      )}
                      {t.sourceType !== "MANUAL" && (
                        <span className="px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 font-bold text-sky-300">{SOURCE_LABELS[t.sourceType] || t.sourceType}</span>
                      )}
                      {t.dueDate && (
                        <span className={`px-1.5 py-0.5 rounded border font-bold ${overdue ? "bg-rose-500/15 text-rose-300 border-rose-500/40" : dueToday ? "bg-amber-500/15 text-amber-300 border-amber-500/40" : "bg-slate-700/60 text-slate-300 border-slate-600/60"}`}>
                          <CalendarClock className="w-2.5 h-2.5 inline mr-1 -mt-0.5" />
                          {overdue ? `Overdue ${Math.abs(dd!)}d — was ${t.dueDate}` : `Due ${t.dueDate}`}
                        </span>
                      )}
                      <span>{isMine ? "Assigned to you" : `→ ${t.assignedUserName || "staff"}`}</span>
                      {!isMine && t.createdByName && <span className="text-slate-500">by {t.createdByName}</span>}
                    </div>
                    {t.status === "DONE" && t.completedByName && (
                      <p className="text-[10px] text-emerald-400/80 mt-1.5">
                        ✓ Completed by {t.completedByName}
                        {t.completedAt ? ` · ${new Date(t.completedAt).toLocaleDateString("en-CA")}` : ""}
                        {t.completionNote ? ` — ${t.completionNote}` : ""}
                      </p>
                    )}
                    {completingId === t.id ? (
                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <input
                          value={completionNote}
                          onChange={(e) => setCompletionNote(e.target.value)}
                          placeholder="Optional completion note…"
                          className="flex-1 min-w-[180px] px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-600 text-xs text-slate-100"
                          data-testid={`complete-note-${t.id}`}
                        />
                        <button
                          onClick={() => patchTask(t.id, { status: "DONE", completionNote }, `Completed ${t.taskNumber}.`)}
                          disabled={busy}
                          className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50"
                          data-testid={`complete-confirm-${t.id}`}
                        >
                          Confirm done
                        </button>
                        <button onClick={() => { setCompletingId(null); setCompletionNote(""); }} className="px-2.5 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                        {t.status === "OPEN" && isMine && (
                          <button onClick={() => patchTask(t.id, { status: "IN_PROGRESS" }, "Marked in progress.")} disabled={busy} className="px-2.5 py-1 rounded-lg bg-cyan-600/80 hover:bg-cyan-500 text-white text-[11px] font-bold" data-testid={`start-${t.id}`}>
                            Start
                          </button>
                        )}
                        {["OPEN", "IN_PROGRESS"].includes(t.status) && isMine && (
                          <button onClick={() => { setCompletingId(t.id); setCompletionNote(""); }} disabled={busy} className="px-2.5 py-1 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 text-white text-[11px] font-bold" data-testid={`done-${t.id}`}>
                            Mark done
                          </button>
                        )}
                        {["OPEN", "IN_PROGRESS"].includes(t.status) && !isMine && (
                          <span className="text-[10px] text-slate-500 italic">Waiting on {t.assignedUserName || "the assignee"}</span>
                        )}
                        {["OPEN", "IN_PROGRESS"].includes(t.status) && (isMine || !!data?.canManage) && (
                          <button onClick={() => patchTask(t.id, { status: "CANCELLED", completionNote: "Cancelled" }, "Action cancelled.")} disabled={busy} className="px-2.5 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-[11px] font-bold">
                            Cancel
                          </button>
                        )}
                        {["DONE", "CANCELLED"].includes(t.status) && (isMine || !!data?.canManage) && (
                          <button onClick={() => patchTask(t.id, { status: "OPEN" }, "Reopened.")} disabled={busy} className="px-2.5 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-[11px] font-bold flex items-center gap-1" data-testid={`reopen-${t.id}`}>
                            <RotateCcw className="w-3 h-3" /> Reopen
                          </button>
                        )}
                        {["OPEN", "IN_PROGRESS"].includes(t.status) && (isMine || !!data?.canManage) && t.dueDate && (
                          <button
                            onClick={() => {
                              const d = new Date(Date.parse(String(t.dueDate)) + 86400000 * 3).toLocaleDateString("en-CA");
                              patchTask(t.id, { dueDate: d }, `Deadline moved to ${d}.`);
                            }}
                            disabled={busy}
                            className="px-2.5 py-1 rounded-lg bg-slate-700/70 hover:bg-slate-600 text-slate-300 text-[11px] font-bold"
                            title="Push the deadline by 3 days"
                          >
                            +3 days
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Linked open items */}
      {!isWorker && (linked.auditIssues?.length || linked.advisorFollowUps?.length || linked.checklist?.length) ? (
        <div className="rounded-2xl border border-slate-700/70 bg-slate-900/60 p-4 sm:p-5 space-y-4" data-testid="action-linked">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-black text-slate-200 flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-sky-400" /> Also on the plate — live from other modules
            </h3>
            <span className="text-[10px] text-slate-500">Nothing is copied: track an item to give yourself a deadline.</span>
          </div>

          {linked.auditIssues?.length > 0 && (
            <div>
              <p className="text-[10px] font-black uppercase tracking-wider text-teal-400 mb-1.5 flex items-center gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5" /> Open audit issues ({linked.auditIssues.length})
              </p>
              <div className="space-y-1.5">
                {linked.auditIssues.slice(0, 8).map((i: LinkedItem) => (
                  <LinkedRow
                    key={`ai-${i.id}`}
                    item={i}
                    icon={<ShieldAlert className="w-3.5 h-3.5 text-teal-400 shrink-0 mt-0.5" />}
                    tracked={alreadyTracked("AUDIT_ISSUE", i.id)}
                    busy={busy}
                    onTrack={() => trackLinked(i, "AUDIT_ISSUE")}
                    onOpen={() => onSelectTab?.("AUDIT")}
                    openLabel="Open Audit & Review"
                    today={today}
                  />
                ))}
              </div>
            </div>
          )}

          {linked.advisorFollowUps?.length > 0 && (
            <div>
              <p className="text-[10px] font-black uppercase tracking-wider text-indigo-400 mb-1.5 flex items-center gap-1.5">
                <Stethoscope className="w-3.5 h-3.5" /> Advisor follow-ups ({linked.advisorFollowUps.length})
              </p>
              <div className="space-y-1.5">
                {linked.advisorFollowUps.slice(0, 6).map((i: LinkedItem) => (
                  <LinkedRow
                    key={`af-${i.id}`}
                    item={i}
                    icon={<Stethoscope className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />}
                    tracked={alreadyTracked("ADVISOR_FOLLOW_UP", i.id)}
                    busy={busy}
                    onTrack={() => trackLinked(i, "ADVISOR_FOLLOW_UP")}
                    onOpen={() => onSelectTab?.("ADVISOR")}
                    openLabel="Open Advisor Console"
                    today={today}
                  />
                ))}
              </div>
            </div>
          )}

          {linked.checklist?.length > 0 && (
            <div>
              <p className="text-[10px] font-black uppercase tracking-wider text-emerald-400 mb-1.5">Today&apos;s incomplete checklists</p>
              <div className="flex flex-wrap gap-2">
                {linked.checklist.map((c: any) => {
                  const biz = bizById.get(Number(c.businessId));
                  // P0.1: an unknown business (deleted out-of-band) never
                  // renders — no "Business #NNN" chip, no dead-end click.
                  if (!biz) return null;
                  return (
                    <button
                      key={`cl-${c.businessId}`}
                      onClick={() => onSelectTab?.(String(biz?.code || c.businessId))}
                      className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 hover:border-emerald-500/50 text-left transition"
                      data-testid={`linked-checklist-${c.businessId}`}
                    >
                      <div>
                        <p className="text-xs font-bold text-slate-200">{biz?.name || "(deleted unit)"}</p>
                        <p className="text-[10px] text-slate-400">
                          {c.open} open{c.critical ? ` · ${c.critical} critical` : ""}
                        </p>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-500" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* R1 — approvals (gated records awaiting a decision, my requests,
          and the OWNER/GM policy manager) */}
      <ApprovalInbox currentUser={currentUser} businesses={businesses} onChanged={load} />

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl bg-slate-800 border border-amber-500/40 shadow-2xl text-xs font-semibold text-amber-200 max-w-[90vw]" data-testid="action-toast">
          {toast}
        </div>
      )}
    </div>
  );
}

function LinkedRow({
  item,
  icon,
  tracked,
  busy,
  onTrack,
  onOpen,
  openLabel,
  today,
}: {
  item: LinkedItem;
  icon: React.ReactNode;
  tracked: boolean;
  busy: boolean;
  onTrack: () => void;
  onOpen: () => void;
  openLabel: string;
  today: string;
}) {
  const dd = daysUntil(item.dueDate, today);
  const overdue = dd != null && dd < 0;
  return (
    <div className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 ${overdue ? "border-rose-500/40 bg-rose-950/20" : "border-slate-700/60 bg-slate-800/50"}`}>
      {icon}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold text-slate-100 truncate">{item.title}</p>
        <p className="text-[10px] text-slate-400 truncate">
          {item.detail}
          {item.dueDate ? ` · due ${item.dueDate}` : ""}
          {overdue ? ` · OVERDUE ${Math.abs(dd!)}d` : ""}
        </p>
      </div>
      {item.priority && (
        <span className={`shrink-0 text-[8px] font-black px-1.5 py-0.5 rounded border ${PRIORITY_STYLES[item.priority] || PRIORITY_STYLES.MEDIUM}`}>{item.priority}</span>
      )}
      <button
        onClick={onTrack}
        disabled={busy || tracked}
        title={tracked ? "Already tracked as a task" : "Mirror this item as a personal task with a deadline"}
        className={`shrink-0 px-2 py-1 rounded-lg text-[10px] font-bold border transition ${
          tracked ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" : "bg-amber-500/15 text-amber-300 border-amber-500/40 hover:bg-amber-500/25"
        } disabled:opacity-60`}
        data-testid={`track-${item.kind}-${item.id}`}
      >
        {tracked ? "✓ Tracked" : "Track as task"}
      </button>
      <button onClick={onOpen} className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-[10px] font-bold">
        {openLabel} <ArrowUpRight className="w-3 h-3" />
      </button>
    </div>
  );
}

function CreateTaskPanel({
  currentUser,
  businesses,
  assignableUsers,
  canManage,
  busy,
  onDone,
}: {
  currentUser: any;
  businesses: any[];
  assignableUsers: any[];
  canManage: boolean;
  busy: boolean;
  onDone: (payload: any) => void;
}) {
  const isWorker = String(currentUser?.role || "").toUpperCase() === "WORKER";
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [businessId, setBusinessId] = useState("");
  const [assignee, setAssignee] = useState(String(currentUser?.id));
  const [priority, setPriority] = useState("MEDIUM");
  const [dueDate, setDueDate] = useState(() => new Date(Date.now() + 2 * 86400000).toLocaleDateString("en-CA"));
  const options = canManage || !isWorker ? assignableUsers : [{ id: Number(currentUser?.id), name: currentUser?.name, role: currentUser?.role }];
  const effectiveOptions = options.length ? options : [{ id: Number(currentUser?.id), name: currentUser?.name || "Me", role: currentUser?.role }];

  const submit = () => {
    if (!title.trim()) return;
    onDone({
      title: title.trim(),
      detail: detail.trim() || null,
      businessId: businessId ? Number(businessId) : null,
      assignedUserId: Number(assignee) || Number(currentUser?.id),
      priority,
      dueDate: dueDate || null,
    });
  };

  return (
    <div className="rounded-2xl border border-amber-500/30 bg-slate-900/80 p-4 sm:p-5 space-y-3" data-testid="action-create">
      <p className="text-sm font-black text-amber-300 flex items-center gap-2">
        <Plus className="w-4 h-4" /> New action
      </p>
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">What needs to happen? *</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Count and reconcile layer house 2 stock"
            className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-sm text-slate-100"
            data-testid="create-title"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">Detail (optional)</label>
          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            rows={2}
            placeholder="Context, links, what 'done' looks like…"
            className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-sm text-slate-100"
          />
        </div>
        <div>
          <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">Business</label>
          <select value={businessId} onChange={(e) => setBusinessId(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-sm text-slate-100">
            <option value="">Organization-wide</option>
            {(businesses || []).map((b: any) => (
              <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">Assigned to</label>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-sm text-slate-100" data-testid="create-assignee">
            {effectiveOptions.map((u: any) => (
              <option key={u.id} value={u.id}>
                {u.name} {Number(u.id) === Number(currentUser?.id) ? "(me)" : `· ${String(u.role || "").toLowerCase().replaceAll("_", " ")}`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">Priority</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-sm text-slate-100">
            {["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">Due date</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-sm text-slate-100 [color-scheme:dark]"
            data-testid="create-due"
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] text-slate-500 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" /> The assignee gets a bell + phone notification instantly.
        </p>
        <button
          onClick={submit}
          disabled={busy || !title.trim()}
          className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50"
          data-testid="create-submit"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Assign action"}
        </button>
      </div>
    </div>
  );
}
