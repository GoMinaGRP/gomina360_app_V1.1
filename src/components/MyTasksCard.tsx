"use client";

// My Tasks — the worker's compact slice of the unified Action Center (P1).
// Self-fetching and self-contained: mounts at the top of the Sales Workspace,
// shows the worker's open actions with one-tap completion, and can deep-link
// into the full Action Center when the dashboard wires onOpenActions.

import React, { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ChevronRight, CircleDashed, ListTodo, Loader2 } from "lucide-react";

export default function MyTasksCard({ onOpenActions }: { onOpenActions?: () => void }) {
  const [data, setData] = useState<any>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?status=ACTIVE");
      const body = await res.json();
      if (res.ok && body.success) setData(body);
    } catch {
      /* transient — remount/refresh recovers */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-slate-700/70 bg-slate-800/50 px-4 py-3 text-xs text-slate-400">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading your actions…
      </div>
    );
  }

  const today: string = data.today || new Date().toLocaleDateString("en-CA");
  // Server already scopes a worker's /api/tasks response to their own
  // assignments — filter only by lifecycle state.
  const mine: any[] = data.tasks || [];
  const open = mine.filter((t) => ["OPEN", "IN_PROGRESS"].includes(t.status));
  const overdue = open.filter((t) => t.dueDate && String(t.dueDate) < today);
  const dueToday = open.filter((t) => String(t.dueDate || "") === today);

  const complete = async (id: number) => {
    setBusyId(id);
    try {
      await fetch("/api/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: "DONE" }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className={`rounded-2xl border p-4 shadow-sm ${overdue.length ? "border-rose-500/40 bg-rose-950/20" : "border-slate-700/70 bg-slate-800/60"}`}
      data-testid="my-tasks-card"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-black text-slate-100 flex items-center gap-1.5">
          <ListTodo className="w-4 h-4 text-amber-400" /> My actions
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">{open.length}</span>
          {overdue.length > 0 && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40">{overdue.length} overdue</span>
          )}
          {dueToday.length > 0 && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">{dueToday.length} today</span>
          )}
        </p>
        {onOpenActions && (
          <button
            onClick={onOpenActions}
            className="flex items-center gap-0.5 text-[10px] font-bold text-amber-300 hover:text-amber-200"
            data-testid="my-tasks-open-all"
          >
            All actions <ChevronRight className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open.length === 0 ? (
        <div className="flex items-center gap-2 mt-2.5 text-[11px] text-slate-400">
          <CheckCircle2 className="w-4 h-4 text-emerald-400/70" /> No open actions assigned to you — all clear.
        </div>
      ) : (
        <div className="mt-2.5 space-y-1.5">
          {open.slice(0, 5).map((t) => {
            const isOverdue = t.dueDate && String(t.dueDate) < today;
            const isToday = String(t.dueDate || "") === today;
            return (
              <div key={t.id} className="flex items-center gap-2 rounded-xl bg-slate-900/60 border border-slate-700/60 px-2.5 py-1.5">
                <CircleDashed className={`w-3.5 h-3.5 shrink-0 ${t.status === "IN_PROGRESS" ? "text-cyan-400" : "text-slate-500"}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-bold text-slate-100 truncate">{t.title}</p>
                  <p className="text-[9px] text-slate-400">
                    {t.businessCode ? `${t.businessCode} · ` : ""}
                    {t.dueDate ? (isOverdue ? <span className="text-rose-300 font-bold">overdue — was {t.dueDate}</span> : isToday ? <span className="text-cyan-300 font-bold">due today</span> : `due ${t.dueDate}`) : "no deadline"}
                    {t.sourceType && t.sourceType !== "MANUAL" ? ` · from ${String(t.sourceType).toLowerCase().replaceAll("_", " ")}` : ""}
                  </p>
                </div>
                <button
                  onClick={() => complete(t.id)}
                  disabled={busyId === t.id}
                  className="shrink-0 px-2 py-1 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 text-white text-[10px] font-bold disabled:opacity-50"
                  data-testid={`my-tasks-done-${t.id}`}
                >
                  {busyId === t.id ? <Loader2 className="w-3 h-3 animate-spin" /> : "Done"}
                </button>
              </div>
            );
          })}
          {open.length > 5 && (
            <p className="text-[10px] text-slate-500 text-right">{open.length - 5} more — {onOpenActions ? "open All actions" : "check the Action Center"}.</p>
          )}
        </div>
      )}
    </div>
  );
}
