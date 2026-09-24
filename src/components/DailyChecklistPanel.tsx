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
  AlertTriangle,
  Layers,
  Database,
  Egg,
} from "lucide-react";
import DailyNotesPanel from "./DailyNotesPanel";
import { STAGE_PLAN_TASKS, LINKS_TO_LABEL, type StageTaskLinksTo } from "@/lib/poultryStageTasks";

/**
 * DailyChecklistPanel — the unified daily checklist used by every GoMina 360
 * business module. Backed by the shared /api/checklists engine:
 *  - OWNER / managers create the daily checklist and manage item templates
 *    (add, edit, activate, deactivate, delete, assign to users/workers).
 *  - Tasks are business + branch specific; completion stamps user, role, date & time.
 *  - Results feed the module dashboards, the Command Center compliance card
 *    and /api/init analytics.
 *
 * POULTRY STAGE MODE (supportsStages): for poultry businesses the panel
 * renders the age/stage-aware checklist — farm-wide routine & custom items
 * first, then one section per flock with its production stage (broilers by
 * day, layers by week), stage compliance history, CRITICAL/WEEKLY chips and
 * links to the data surface each task feeds (feed log, egg production…).
 * Owners can enable/disable the system stage plan per business.
 */

const CATEGORIES = [
  "GENERAL", "PRODUCTION", "FEEDING", "WATER", "HEALTH", "CLEANING", "SECURITY",
  "ENVIRONMENT", "MACHINERY", "MATERIALS", "DELIVERIES", "QUALITY", "STOCK", "FINANCE", "SALES",
  "HYGIENE", "ADMIN",
];

const MANAGE_ROLES = ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"];

const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "STAGE_ONCE"];

const STAGE_OPTIONS: Record<string, { key: string; label: string }[]> = {
  BROILERS: [
    { key: "PREP", label: "Pre-Placement Prep" },
    { key: "BROODING", label: "Brooding (D1–7)" },
    { key: "STARTER", label: "Starter (D8–14)" },
    { key: "GROWER", label: "Grower (D15–28)" },
    { key: "FINISHER", label: "Finisher (D29→)" },
    { key: "MARKET", label: "Market Week" },
    { key: "CLOSEOUT", label: "Closeout" },
  ],
  LAYERS: [
    { key: "PREP", label: "Pre-Placement Prep" },
    { key: "CHICK_BROODING", label: "Chick Brooding (Wk 0–6)" },
    { key: "GROWING", label: "Growing (Wk 7–12)" },
    { key: "DEVELOPING", label: "Developing (Wk 13–17)" },
    { key: "PRE_LAY", label: "Pre-Lay (Wk 18–19)" },
    { key: "EARLY_LAY", label: "Early Lay (Wk 20–25)" },
    { key: "PEAK", label: "Peak Lay (Wk 26–38)" },
    { key: "MID_LAY", label: "Mid Lay (Wk 39–60)" },
    { key: "LATE_LAY", label: "Late Lay (Wk 61–80)" },
    { key: "CLOSEOUT", label: "Spent / Closeout" },
  ],
};

const PHASE_COLORS: Record<string, string> = {
  PRE_PLACEMENT: "bg-slate-600/30 text-slate-200 border-slate-500/50",
  REARING: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  PRODUCTION: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  MARKET: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  CLOSEOUT: "bg-rose-500/15 text-rose-300 border-rose-500/40",
};
const PHASE_OF_STAGE: Record<string, string> = {
  PREP: "PRE_PLACEMENT", BROODING: "REARING", STARTER: "REARING", GROWER: "REARING", FINISHER: "REARING",
  MARKET: "MARKET", CLOSEOUT: "CLOSEOUT", CHICK_BROODING: "REARING", GROWING: "REARING", DEVELOPING: "REARING",
  PRE_LAY: "REARING", EARLY_LAY: "PRODUCTION", PEAK: "PRODUCTION", MID_LAY: "PRODUCTION", LATE_LAY: "PRODUCTION",
};

const TASK_META = new Map(STAGE_PLAN_TASKS.map((t) => [t.taskKey, t]));

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
  supportsStages = false,
  onChanged,
}: {
  businessId: number | undefined;
  branchCode?: string;
  businessName?: string;
  employees?: any[];
  currentUser?: any;
  accent?: "cyan" | "emerald" | "amber" | "orange";
  supportsStages?: boolean;
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
  const [stageBusy, setStageBusy] = useState(false);

  const role = String(currentUser?.role || "").toUpperCase();
  const canManage = MANAGE_ROLES.includes(role);

  const staff = useMemo(
    () => (employees || []).filter((e: any) => !businessId || e.businessId === businessId),
    [employees, businessId],
  );

  const stagePlanActive = useMemo(
    () => templates.some((t) => t.origin === "STAGE_PLAN" && t.isActive !== false),
    [templates],
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

  // ── Stage grouping: farm-wide items first, then one section per flock ──
  const { farmEntries, flockSections } = useMemo(() => {
    const farm: any[] = [];
    const byFlock = new Map<number, any>();
    for (const e of dayEntries) {
      if (e.flockId == null) {
        farm.push(e);
        continue;
      }
      const fid = Number(e.flockId);
      if (!byFlock.has(fid)) {
        byFlock.set(fid, { flockId: fid, batchNumber: e.batchNumber, birdType: e.birdType, stageKey: e.stageKey, stageLabel: e.stageLabel, ageDays: e.ageDays, entries: [] });
      }
      byFlock.get(fid).entries.push(e);
    }
    return { farmEntries: farm, flockSections: [...byFlock.values()] };
  }, [dayEntries]);

  // Stage compliance history (all dates): completion % per stage of this farm.
  const stageCompliance = useMemo(() => {
    const byStage = new Map<string, { label: string; done: number; total: number }>();
    for (const e of entries) {
      if (!e.stageKey || !e.stageLabel) continue;
      if (!byStage.has(e.stageKey)) byStage.set(e.stageKey, { label: e.stageLabel, done: 0, total: 0 });
      const s = byStage.get(e.stageKey)!;
      s.total += 1;
      if (e.isCompleted) s.done += 1;
    }
    return [...byStage.entries()].map(([key, v]) => ({ key, ...v }));
  }, [entries]);

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

  const toggleStagePlan = async (action: "enable" | "disable") => {
    setStageBusy(true); setError("");
    try {
      const res = await fetch("/api/checklists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: "STAGE_PLAN", data: { businessId, branchCode, action } }),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || "Failed to update the stage plan");
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setStageBusy(false);
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
            ...(supportsStages && newItem.birdType
              ? {
                  birdType: newItem.birdType,
                  stageKeys: newItem.stageKey ? [newItem.stageKey] : null,
                  frequency: newItem.frequency || "DAILY",
                  priority: newItem.priority || "ROUTINE",
                }
              : {}),
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

  const renderTask = (task: any) => {
    const meta = TASK_META.get(task.taskKey);
    const isCritical = String(task.priority || "").toUpperCase() === "CRITICAL";
    const freq = String(task.frequency || "DAILY").toUpperCase();
    return (
      <button key={task.id} onClick={() => toggle(task)}
        className={`w-full text-left p-3 rounded-xl border text-xs flex items-center gap-3 transition ${
          task.isCompleted ? A.doneWrap : isCritical
            ? "bg-rose-500/5 border-rose-500/40 text-slate-200 hover:border-rose-400/70"
            : "bg-slate-900/70 border-slate-700 text-slate-200 hover:border-cyan-500/40"
        }`}>
        {task.isCompleted
          ? <CheckCircle2 className={`w-5 h-5 ${A.doneIcon} shrink-0`} />
          : <CircleDot className={`w-5 h-5 shrink-0 ${isCritical ? "text-rose-400" : "text-slate-500"}`} />}
        <div className="flex-1">
          <div className={`font-semibold ${task.isCompleted ? "line-through opacity-70" : ""}`}>{task.taskLabel}</div>
          {(meta?.helpText || task.linksToHint) && !task.isCompleted && (
            <div className="text-[10px] text-slate-500 mt-0.5">{meta?.helpText}</div>
          )}
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
        <div className="flex flex-wrap items-center gap-1 justify-end shrink-0">
          {isCritical && !task.isCompleted && (
            <span className="px-1.5 py-0.5 rounded-full bg-rose-500/15 border border-rose-500/40 text-rose-300 text-[9px] font-black tracking-wide flex items-center gap-1">
              <AlertTriangle className="w-2.5 h-2.5" />CRITICAL
            </span>
          )}
          {freq !== "DAILY" && (
            <span className="px-1.5 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/40 text-amber-300 text-[9px] font-black tracking-wide">
              {freq === "STAGE_ONCE" ? "ONCE/STAGE" : freq}
            </span>
          )}
          {meta?.linksTo && !task.isCompleted && (
            <span className="px-1.5 py-0.5 rounded-full bg-slate-800 border border-slate-600 text-slate-400 text-[9px] font-bold flex items-center gap-1"
              title={`Data lives in the Poultry module — ${LINKS_TO_LABEL[meta.linksTo as StageTaskLinksTo]}`}>
              <Database className="w-2.5 h-2.5" />{LINKS_TO_LABEL[meta.linksTo as StageTaskLinksTo]}
            </span>
          )}
          <span className="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-600 text-[10px] font-bold text-slate-300">{task.category || "GENERAL"}</span>
        </div>
      </button>
    );
  };

  const sectionHeader = (title: string, sub: string, chipColor: string, doneN: number, totalN: number) => (
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`px-2 py-0.5 rounded-full border text-[10px] font-black tracking-wide ${chipColor}`}>{title}</span>
        <span className="text-[10px] text-slate-500">{sub}</span>
      </div>
      <span className={`text-[10px] font-bold ${doneN === totalN && totalN > 0 ? "text-emerald-300" : "text-slate-400"}`}>
        {doneN}/{totalN}
      </span>
    </div>
  );

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/60 overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 border-b border-slate-700/70 bg-slate-800/80">
        <div className="flex items-center gap-2 flex-wrap">
          <ClipboardCheck className={`w-4.5 h-4.5 ${A.textAccent}`} />
          <h3 className="text-sm font-bold text-white">Daily Activity Checklist{businessName ? ` — ${businessName}` : ""}</h3>
          {supportsStages && stagePlanActive && (
            <span className={`px-2 py-0.5 rounded-full border text-[10px] font-black tracking-wide flex items-center gap-1 ${PHASE_COLORS.REARING}`}>
              <Egg className="w-3 h-3" />STAGE PLAN ON
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={selCls} />
          {canManage && dayEntries.length === 0 && (
            <button onClick={generate} disabled={busy}
              className={`px-3 py-1.5 rounded-lg ${A.btn} text-white text-xs font-bold flex items-center gap-1 disabled:opacity-50`}>
              <Plus className="w-3.5 h-3.5" />{busy ? "Creating…" : `Create Checklist (${date})`}
            </button>
          )}
          {canManage && supportsStages && (
            <button onClick={() => toggleStagePlan(stagePlanActive ? "disable" : "enable")} disabled={stageBusy}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 border disabled:opacity-50 ${
                stagePlanActive
                  ? "bg-slate-800 border-slate-600 text-slate-300 hover:text-white"
                  : "bg-emerald-600 border-emerald-500 text-white hover:bg-emerald-500"
              }`}>
              <Layers className="w-3.5 h-3.5" />
              {stageBusy ? "Working…" : stagePlanActive ? "Disable Stage Plan" : "Enable Stage Plan"}
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

      {/* Stage compliance history (poultry stage mode) */}
      {supportsStages && stageCompliance.length > 0 && (
        <div className="px-5 pt-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold mb-1">Stage compliance (all recorded days)</div>
          <div className="flex flex-wrap gap-1.5">
            {stageCompliance.map((s) => {
              const sp = s.total ? Math.round((s.done / s.total) * 100) : 0;
              return (
                <span key={s.key} title={`${s.done}/${s.total} tasks completed`}
                  className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${PHASE_COLORS[PHASE_OF_STAGE[s.key] || "REARING"]}`}>
                  {s.label}: <span className={sp >= 90 ? "text-emerald-200" : sp >= 60 ? "text-amber-200" : "text-rose-300"}>{sp}%</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {error && <p className="mx-5 mt-3 text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{error}</p>}

      {/* Task rows */}
      <div className="p-4 space-y-4">
        {dayEntries.length === 0 && (
          <div className="p-6 text-center text-slate-400 text-sm">
            No checklist for {date} yet.{canManage ? " Click \"Create Checklist\" when the day starts." : " A manager creates the daily checklist."}
            {existingDates.length > 0 && (
              <span className="block text-[11px] mt-1 text-slate-500">Existing checklists: {existingDates.slice(0, 5).join(", ")}</span>
            )}
          </div>
        )}

        {farmEntries.length > 0 && (
          <div className="space-y-2">
            {sectionHeader("FARM ROUTINE & CUSTOM", "House-wide tasks and Owner-added items", "bg-slate-600/30 text-slate-200 border-slate-500/50",
              farmEntries.filter((e) => e.isCompleted).length, farmEntries.length)}
            {farmEntries.map(renderTask)}
          </div>
        )}

        {flockSections.map((sec: any) => {
          const secDone = sec.entries.filter((e: any) => e.isCompleted).length;
          const phase = PHASE_OF_STAGE[sec.stageKey] || "REARING";
          const ageTxt = sec.birdType === "LAYERS"
            ? `Wk ${Math.floor(Number(sec.ageDays ?? 0) / 7)}`
            : `Day ${sec.ageDays ?? "—"}`;
          return (
            <div key={sec.flockId} className="space-y-2">
              {sectionHeader(
                `${sec.batchNumber || `Flock #${sec.flockId}`} · ${sec.stageLabel || sec.birdType}`,
                `${sec.birdType || ""} · ${ageTxt}`,
                PHASE_COLORS[phase] || PHASE_COLORS.REARING,
                secDone, sec.entries.length,
              )}
              {sec.entries.map(renderTask)}
            </div>
          );
        })}
      </div>

      {/* Template management (owners & managers) */}
      {canManage && manageOpen && (
        <div className="border-t border-slate-700/70 bg-slate-900/40 p-4 space-y-2">
          <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wide">Checklist Items (master list)</div>
          {supportsStages && (
            <p className="text-[10px] text-slate-500">
              System stage-plan items (STAGE PLAN) are versioned by GoMina — edit labels, priorities, frequency, scope or assignments freely; your changes stay.
              CUSTOM items are yours alone. Deactivate any item to remove it from future daily checklists.
            </p>
          )}
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
                  {supportsStages && (
                    <>
                      <select value={editDraft.priority ?? t.priority ?? "ROUTINE"} onChange={(e) => setEditDraft({ ...editDraft, priority: e.target.value })} className={selCls} title="Priority">
                        <option value="ROUTINE">Routine</option>
                        <option value="CRITICAL">Critical</option>
                      </select>
                      <select value={editDraft.frequency ?? t.frequency ?? "DAILY"} onChange={(e) => setEditDraft({ ...editDraft, frequency: e.target.value })} className={selCls} title="Frequency">
                        {FREQUENCIES.map((f) => <option key={f} value={f}>{f.replace("_", " ")}</option>)}
                      </select>
                      <select value={editDraft.birdType ?? t.birdType ?? ""} onChange={(e) => setEditDraft({ ...editDraft, birdType: e.target.value, stageKey: "" })} className={selCls} title="Bird type scope">
                        <option value="">Any bird type</option>
                        <option value="BROILERS">Broilers</option>
                        <option value="LAYERS">Layers</option>
                      </select>
                      {(editDraft.birdType ?? t.birdType) && (
                        <select value={editDraft.stageKey ?? (t.stageKeys?.length === 1 ? t.stageKeys[0] : "") ?? ""} onChange={(e) => setEditDraft({ ...editDraft, stageKey: e.target.value })} className={selCls} title="Stage scope">
                          <option value="">All stages</option>
                          {STAGE_OPTIONS[(editDraft.birdType ?? t.birdType)].map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                      )}
                    </>
                  )}
                  <button onClick={() => {
                    const assignee = staff.find((s: any) => String(s.id) === String(editDraft.assignedToUserId ?? t.assignedToUserId ?? ""));
                    saveTemplate(t.id, {
                      taskLabel: editDraft.taskLabel ?? t.taskLabel,
                      category: editDraft.category ?? t.category,
                      assignedToUserId: editDraft.assignedToUserId ?? t.assignedToUserId ?? null,
                      assignedToName: assignee?.name || null,
                      assignedToRole: assignee?.role || null,
                      ...(supportsStages
                        ? {
                            priority: editDraft.priority ?? t.priority,
                            frequency: editDraft.frequency ?? t.frequency,
                            birdType: (editDraft.birdType !== undefined ? editDraft.birdType : t.birdType) || null,
                            stageKeys: editDraft.stageKey !== undefined
                              ? (editDraft.stageKey ? [editDraft.stageKey] : null)
                              : (t.stageKeys || null),
                          }
                        : {}),
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
                  {t.origin === "STAGE_PLAN" && (
                    <span className="px-1.5 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-[9px] font-black">STAGE PLAN</span>
                  )}
                  {t.birdType && <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-600 text-slate-400 text-[9px] font-bold">{t.birdType}{t.stageKeys?.length ? ` · ${t.stageKeys.length} stage${t.stageKeys.length > 1 ? "s" : ""}` : " · all stages"}</span>}
                  {t.frequency && t.frequency !== "DAILY" && <span className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/40 text-amber-300 text-[9px] font-bold">{t.frequency.replace("_", " ")}</span>}
                  {String(t.priority || "").toUpperCase() === "CRITICAL" && <span className="px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 text-[9px] font-black">CRITICAL</span>}
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px] font-bold">{t.category || "GENERAL"}</span>
                  <span className="text-[10px] text-slate-500">{t.assignedToName ? `→ ${t.assignedToName}` : ""}</span>
                  <button onClick={() => { setEditId(t.id); setEditDraft({}); }} className="p-1.5 rounded bg-slate-800 text-slate-300 hover:text-white" title="Edit"><Pencil className="w-3 h-3" /></button>
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
            {supportsStages && (
              <>
                <select value={newItem.birdType || ""} onChange={(e) => setNewItem({ ...newItem, birdType: e.target.value, stageKey: "" })} className={selCls} title="Scope to a bird type">
                  <option value="">All birds</option>
                  <option value="BROILERS">Broilers</option>
                  <option value="LAYERS">Layers</option>
                </select>
                {newItem.birdType && (
                  <select value={newItem.stageKey || ""} onChange={(e) => setNewItem({ ...newItem, stageKey: e.target.value })} className={selCls} title="Scope to a stage">
                    <option value="">All stages</option>
                    {STAGE_OPTIONS[newItem.birdType].map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                )}
                <select value={newItem.frequency || "DAILY"} onChange={(e) => setNewItem({ ...newItem, frequency: e.target.value })} className={selCls} title="Frequency">
                  {FREQUENCIES.map((f) => <option key={f} value={f}>{f.replace("_", " ")}</option>)}
                </select>
                <select value={newItem.priority || "ROUTINE"} onChange={(e) => setNewItem({ ...newItem, priority: e.target.value })} className={selCls} title="Priority">
                  <option value="ROUTINE">Routine</option>
                  <option value="CRITICAL">Critical</option>
                </select>
              </>
            )}
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
