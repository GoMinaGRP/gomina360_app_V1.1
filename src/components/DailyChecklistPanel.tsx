"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClipboardCheck,
  CheckCircle2,
  CircleDot,
  Plus,
  Settings2,
  Pencil,
  Trash,
  UserCheck,
  X,
  Check,
} from "lucide-react";
import DailyNotesPanel from "./DailyNotesPanel";

/**
 * DailyChecklistPanel — the unified daily checklist used by every GoMina 360
 * business module. Backed by the shared /api/checklists engine:
 *  - OWNER / managers create the daily checklist and manage item templates
 *    (add, edit, activate, deactivate, delete, assign to users/workers).
 *  - Tasks are business + branch specific; completion stamps user, role, date & time.
 *  - Results feed the module dashboards, the Command Center compliance card
 *    and /api/init analytics.
 */

const CATEGORIES = [
  "GENERAL", "PRODUCTION", "FEEDING", "WATER", "HEALTH", "CLEANING", "SECURITY",
  "MACHINERY", "MATERIALS", "DELIVERIES", "QUALITY", "STOCK", "FINANCE", "SALES",
  "HYGIENE", "ADMIN",
];

const MANAGE_ROLES = ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"];

const ACCENTS: Record<string, { btn: string; bar: string; doneWrap: string; doneIcon: string; textAccent: string }> = {
  cyan: {
    btn: "bg-cyan-600 hover:bg-cyan-500",
    bar: "bg-cyan-500",
    doneWrap: "bg-emerald-500/10 border-emerald-500/40 text-emerald-200",
    doneIcon: "text-emerald-400",
    textAccent: "text-cyan-300",
  },
  emerald: {
    btn: "bg-emerald-600 hover:bg-emerald-500",
    bar: "bg-emerald-500",
    doneWrap: "bg-emerald-500/10 border-emerald-500/40 text-emerald-200",
    doneIcon: "text-emerald-400",
    textAccent: "text-emerald-300",
  },
  amber: {
    btn: "bg-amber-600 hover:bg-amber-500",
    bar: "bg-amber-500",
    doneWrap: "bg-emerald-500/10 border-emerald-500/40 text-emerald-200",
    doneIcon: "text-emerald-400",
    textAccent: "text-amber-300",
  },
  orange: {
    btn: "bg-orange-600 hover:bg-orange-500",
    bar: "bg-orange-500",
    doneWrap: "bg-emerald-500/10 border-emerald-500/40 text-emerald-200",
    doneIcon: "text-emerald-400",
    textAccent: "text-orange-300",
  },
};

export default function DailyChecklistPanel({
  businessId,
  branchCode,
  businessName,
  employees = [],
  currentUser,
  accent = "cyan",
  onChanged,
}: {
  businessId: number | undefined;
  branchCode?: string;
  businessName?: string;
  employees?: any[];
  currentUser?: any;
  accent?: "cyan" | "emerald" | "amber" | "orange";
  onChanged?: () => void;
}) {
  const A = ACCENTS[accent] || ACCENTS.cyan;
  const today = new Date().toISOString().split("T")[0];
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [templates, setTemplates] = useState<any[]>([]);
  const [entries, setEntries] = useState<any[]>([]);
  const [date, setDate] = useState(today);
  const [manageOpen, setManageOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<any>({});
  const [newItem, setNewItem] = useState<any>({ taskLabel: "", category: "GENERAL", assignedToUserId: "" });

  const role = String(currentUser?.role || "").toUpperCase();
  const canManage = MANAGE_ROLES.includes(role);

  const staff = useMemo(
    () => (employees || []).filter((e: any) => !businessId || e.businessId === businessId),
    [employees, businessId],
  );

  const load = useCallback(async () => {
    if (!businessId) return;
    try {
      const res = await fetch(`/api/checklists?businessId=${businessId}`);
      const d = await res.json();
      if (d.success) {
        setTemplates(d.templates || []);
        setEntries(d.entries || []);
      } else {
        setError(d.error || "Failed to load checklists");
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => { load(); }, [load]);

  const dayEntries = useMemo(
    () => entries.filter((e) => e.checklistDate === date),
    [entries, date],
  );
  const existingDates = useMemo(
    () => Array.from(new Set(entries.map((e) => e.checklistDate))).sort().reverse(),
    [entries],
  );
  const done = dayEntries.filter((e) => e.isCompleted).length;
  const pct = dayEntries.length ? Math.round((done / dayEntries.length) * 100) : 0;

  const generate = async () => {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/checklists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity: "GENERATE",
          data: { businessId, branchCode, checklistDate: date, createdByName: currentUser?.name, createdByRole: currentUser?.role },
        }),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || "Failed to create checklist");
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (task: any) => {
    setError("");
    try {
      const res = await fetch("/api/checklists", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity: "ENTRY",
          id: task.id,
          data: { completedByName: currentUser?.name, completedByRole: currentUser?.role },
        }),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || "Failed to update task");
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const saveTemplate = async (id: number, patch: any) => {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/checklists", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: "TEMPLATE", id, data: { ...patch, updatedByRole: currentUser?.role } }),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || "Failed to update item");
      setEditId(null);
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const addTemplate = async () => {
    if (!newItem.taskLabel.trim()) return;
    setBusy(true); setError("");
    try {
      const assignee = staff.find((s: any) => String(s.id) === String(newItem.assignedToUserId));
      const res = await fetch("/api/checklists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity: "TEMPLATE",
          data: {
            businessId,
            branchCode,
            taskLabel: newItem.taskLabel.trim(),
            category: newItem.category || "GENERAL",
            assignedToUserId: assignee?.id || null,
            assignedToName: assignee?.name || null,
            assignedToRole: assignee?.role || null,
            createdByName: currentUser?.name,
            createdByRole: currentUser?.role,
          },
        }),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || "Failed to add item");
      setNewItem({ taskLabel: "", category: "GENERAL", assignedToUserId: "" });
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const removeTemplate = async (id: number) => {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/checklists?id=${id}&role=${encodeURIComponent(currentUser?.role || "")}`, { method: "DELETE" });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || "Failed to delete item");
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <p className="text-xs text-slate-500 p-4">Loading checklists…</p>;
  }

  const inputCls = "px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs w-full";
  const selCls = "px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs";

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/60 overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 border-b border-slate-700/70 bg-slate-800/80">
        <div className="flex items-center gap-2">
          <ClipboardCheck className={`w-4.5 h-4.5 ${A.textAccent}`} />
          <h3 className="text-sm font-bold text-white">Daily Activity Checklist{businessName ? ` — ${businessName}` : ""}</h3>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={selCls} />
          {canManage && dayEntries.length === 0 && (
            <button onClick={generate} disabled={busy}
              className={`px-3 py-1.5 rounded-lg ${A.btn} text-white text-xs font-bold flex items-center gap-1 disabled:opacity-50`}>
              <Plus className="w-3.5 h-3.5" />{busy ? "Creating…" : `Create Checklist (${date})`}
            </button>
          )}
          {canManage && (
            <button onClick={() => setManageOpen((v) => !v)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 border ${manageOpen ? "bg-slate-700 border-slate-500 text-white" : "bg-slate-800 border-slate-600 text-slate-300 hover:text-white"}`}>
              <Settings2 className="w-3.5 h-3.5" />Manage Items
            </button>
          )}
        </div>
      </div>

      {/* Progress */}
      <div className="px-5 pt-4">
        <div className="flex items-center justify-between text-xs mb-1">
          <span className="text-slate-400 font-semibold">{done} of {dayEntries.length} tasks completed</span>
          <span className={`font-black ${pct === 100 ? "text-emerald-300" : A.textAccent}`}>{pct}%</span>
        </div>
        <div className="w-full h-2.5 rounded-full bg-slate-700 overflow-hidden">
          <div className={`h-full rounded-full transition-all ${pct === 100 ? "bg-emerald-500" : A.bar}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      {error && <p className="mx-5 mt-3 text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{error}</p>}

      {/* Task rows */}
      <div className="p-4 space-y-2">
        {dayEntries.length === 0 && (
          <div className="p-6 text-center text-slate-400 text-sm">
            No checklist for {date} yet.{canManage ? " Click \"Create Checklist\" when the day starts." : " A manager creates the daily checklist."}
            {existingDates.length > 0 && (
              <span className="block text-[11px] mt-1 text-slate-500">Existing checklists: {existingDates.slice(0, 5).join(", ")}</span>
            )}
          </div>
        )}
        {dayEntries.map((task) => (
          <button key={task.id} onClick={() => toggle(task)}
            className={`w-full text-left p-3 rounded-xl border text-xs flex items-center gap-3 transition ${
              task.isCompleted ? A.doneWrap : "bg-slate-900/70 border-slate-700 text-slate-200 hover:border-cyan-500/40"
            }`}>
            {task.isCompleted
              ? <CheckCircle2 className={`w-5 h-5 ${A.doneIcon} shrink-0`} />
              : <CircleDot className="w-5 h-5 text-slate-500 shrink-0" />}
            <div className="flex-1">
              <div className={`font-semibold ${task.isCompleted ? "line-through opacity-70" : ""}`}>{task.taskLabel}</div>
              {task.isCompleted ? (
                <div className="text-[10px] text-slate-500 mt-0.5">
                  Done by {task.completedByName || "Staff"}{task.completedByRole ? ` (${task.completedByRole})` : ""}
                  {task.completedAt ? ` • ${new Date(task.completedAt).toLocaleTimeString()}` : ""} • {task.checklistDate}
                </div>
              ) : task.assignedToName ? (
                <div className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-1">
                  <UserCheck className="w-3 h-3" />Assigned to {task.assignedToName}{task.assignedToRole ? ` • ${task.assignedToRole}` : ""}
                </div>
              ) : null}
            </div>
            <span className="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-600 text-[10px] font-bold text-slate-300">{task.category || "GENERAL"}</span>
          </button>
        ))}
      </div>

      {/* Template management (owners & managers) */}
      {canManage && manageOpen && (
        <div className="border-t border-slate-700/70 bg-slate-900/40 p-4 space-y-2">
          <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wide">Checklist Items (master list)</div>
          {templates.map((t) => (
            <div key={t.id} className={`flex flex-wrap items-center gap-2 p-2 rounded-lg border text-xs ${t.isActive !== false ? "border-slate-700 bg-slate-900/60" : "border-slate-800 bg-slate-900/30 opacity-60"}`}>
              {editId === t.id ? (
                <>
                  <input value={editDraft.taskLabel ?? t.taskLabel} onChange={(e) => setEditDraft({ ...editDraft, taskLabel: e.target.value })} className={`${inputCls} flex-1 min-w-[180px]`} />
                  <select value={editDraft.category ?? t.category ?? "GENERAL"} onChange={(e) => setEditDraft({ ...editDraft, category: e.target.value })} className={selCls}>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <select value={editDraft.assignedToUserId ?? t.assignedToUserId ?? ""} onChange={(e) => setEditDraft({ ...editDraft, assignedToUserId: e.target.value })} className={selCls}>
                    <option value="">— Unassigned —</option>
                    {staff.map((s: any) => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}
                  </select>
                  <button onClick={() => {
                    const assignee = staff.find((s: any) => String(s.id) === String(editDraft.assignedToUserId ?? t.assignedToUserId ?? ""));
                    saveTemplate(t.id, {
                      taskLabel: editDraft.taskLabel ?? t.taskLabel,
                      category: editDraft.category ?? t.category,
                      assignedToUserId: editDraft.assignedToUserId ?? t.assignedToUserId ?? null,
                      assignedToName: assignee?.name || null,
                      assignedToRole: assignee?.role || null,
                    });
                  }} disabled={busy} className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center gap-1 disabled:opacity-50"><Check className="w-3 h-3" />Save</button>
                  <button onClick={() => setEditId(null)} className="px-2 py-1 rounded bg-slate-700 text-slate-300 flex items-center gap-1"><X className="w-3 h-3" />Cancel</button>
                </>
              ) : (
                <>
                  <button onClick={() => saveTemplate(t.id, { isActive: t.isActive === false })}
                    title={t.isActive !== false ? "Deactivate" : "Activate"}
                    className={`px-2 py-1 rounded text-[10px] font-black border ${t.isActive !== false ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300" : "bg-slate-800 border-slate-600 text-slate-400"}`}>
                    {t.isActive !== false ? "ACTIVE" : "OFF"}
                  </button>
                  <span className={`flex-1 min-w-[160px] font-semibold ${t.isActive !== false ? "text-slate-200" : "text-slate-500 line-through"}`}>{t.taskLabel}</span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px] font-bold">{t.category || "GENERAL"}</span>
                  <span className="text-[10px] text-slate-500">{t.assignedToName ? `→ ${t.assignedToName}` : ""}</span>
                  <button onClick={() => { setEditId(t.id); setEditDraft({}); }} className="p-1.5 rounded bg-slate-800 text-slate-300 hover:text-white" title="Edit"><Pencil className="w-3 h-3" /></button>
                  <button onClick={() => saveTemplate(t.id, { isActive: !(t.isActive !== false) })}
                    className="px-2 py-1 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[10px] font-bold" title="Toggle active">
                    {t.isActive !== false ? "Deactivate" : "Activate"}
                  </button>
                  <button onClick={() => removeTemplate(t.id)} disabled={busy} className="p-1.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 hover:bg-rose-500/20 disabled:opacity-50" title="Delete item"><Trash className="w-3 h-3" /></button>
                </>
              )}
            </div>
          ))}
          {/* Add new item */}
          <div className="flex flex-wrap items-center gap-2 p-2 rounded-lg border border-dashed border-slate-600 bg-slate-900/40 text-xs">
            <Plus className="w-3.5 h-3.5 text-slate-400" />
            <input value={newItem.taskLabel} onChange={(e) => setNewItem({ ...newItem, taskLabel: e.target.value })}
              placeholder="New checklist item — e.g. Refill poultry grit bins" className={`${inputCls} flex-1 min-w-[200px]`} />
            <select value={newItem.category} onChange={(e) => setNewItem({ ...newItem, category: e.target.value })} className={selCls}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={newItem.assignedToUserId} onChange={(e) => setNewItem({ ...newItem, assignedToUserId: e.target.value })} className={selCls}>
              <option value="">— Unassigned —</option>
              {staff.map((s: any) => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}
            </select>
            <button onClick={addTemplate} disabled={busy || !newItem.taskLabel.trim()}
              className={`px-3 py-1.5 rounded-lg ${A.btn} text-white text-xs font-bold disabled:opacity-40`}>Add Item</button>
          </div>
          <p className="text-[10px] text-slate-500">Active items become daily tasks when a checklist is created. Deactivated or deleted items stay on past checklists for history.</p>
        </div>
      )}

      <p className="px-4 pb-4 text-[10px] text-slate-500">Completion records the user, role, date and time. Results feed dashboards, the Command Center compliance card and reports.</p>

      {/* Daily Notes — workers file the day in their own words; GoMina AI
          analyses every note (issues, severity, trends, summary) and keeps
          the unit's living business history & insights up to date. */}
      <DailyNotesPanel
        businessId={businessId}
        businessName={businessName}
        currentUser={currentUser}
        date={date}
        onChanged={onChanged}
      />
    </div>
  );
}
