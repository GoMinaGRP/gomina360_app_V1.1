"use client";

import { useMemo, useState } from "react";
import {
  X,
  Check,
  Pencil,
  Trash,
  Plus,
  Copy,
  RotateCcw,
  Save,
  Layers,
  FileDown,
  Egg,
  AlertTriangle,
  UserCheck,
} from "lucide-react";
import { stagesOfBirdType, isStagePlanBirdType, displayDayOf, displayWeekOf } from "@/lib/poultryStages";

/**
 * FlockPlanEditor — per-flock lifecycle checklist plan editor (poultry).
 *
 * Copy-on-write model:
 *  - A flock with NO own rows follows the recommended GoMina system stage
 *    plan (source SYSTEM).
 *  - "Customize" forks the system plan into the flock's own rows (source
 *    CUSTOM) — other flocks and the system plan itself are never touched.
 *  - A saved reusable template can be applied instead (source TEMPLATE).
 *  - "Reset" deletes the flock's own rows and returns to the recommended
 *    system plan. Completed history is always preserved.
 *
 * Only OWNER / GENERAL_MANAGER / BRANCH_MANAGER may open this editor (the
 * parent gates the trigger); the API re-checks the role on every call.
 */

const CATEGORIES = [
  "GENERAL", "PRODUCTION", "FEEDING", "WATER", "HEALTH", "CLEANING", "SECURITY",
  "ENVIRONMENT", "MACHINERY", "MATERIALS", "DELIVERIES", "QUALITY", "STOCK", "FINANCE", "SALES",
  "HYGIENE", "ADMIN",
];
const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "STAGE_ONCE"];

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  SYSTEM: { label: "RECOMMENDED PLAN", cls: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40" },
  TEMPLATE: { label: "SAVED TEMPLATE", cls: "bg-purple-500/15 text-purple-300 border-purple-500/40" },
  CUSTOM: { label: "CUSTOMIZED", cls: "bg-amber-500/15 text-amber-300 border-amber-500/40" },
};

export default function FlockPlanEditor({
  businessId,
  branchCode,
  flock,
  templates,
  planState,
  planTemplates,
  currentUser,
  employees = [],
  onClose,
  onChanged,
}: {
  businessId: number;
  branchCode?: string | null;
  flock: any;
  templates: any[];
  planState?: any;
  planTemplates: any[];
  currentUser?: any;
  employees?: any[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editId, setEditId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<any>({});
  const [newItem, setNewItem] = useState<any>({ taskLabel: "", category: "GENERAL", assignedToUserId: "", frequency: "DAILY", priority: "ROUTINE" });
  const [tplPick, setTplPick] = useState("");
  const [saveName, setSaveName] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);

  const birdType = String(flock?.birdType || "").toUpperCase();
  const isPlanType = isStagePlanBirdType(birdType);

  const flockRows = useMemo(
    () =>
      (templates || [])
        .filter((t) => t.flockId != null && Number(t.flockId) === Number(flock?.id))
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.id || 0) - (b.id || 0)),
    [templates, flock?.id],
  );
  const systemCount = useMemo(
    () =>
      (templates || []).filter(
        (t) =>
          t.origin === "STAGE_PLAN" &&
          t.flockId == null &&
          t.isActive !== false &&
          (t.birdType == null || String(t.birdType).toUpperCase() === birdType),
      ).length,
    [templates, birdType],
  );
  const usableTemplates = useMemo(
    () => (planTemplates || []).filter((t) => !t.birdType || t.birdType === birdType),
    [planTemplates, birdType],
  );
  const staff = useMemo(
    () => (employees || []).filter((e: any) => !businessId || e.businessId === businessId),
    [employees, businessId],
  );

  const source = flockRows.length
    ? "CUSTOM"
    : String(planState?.source || "SYSTEM").toUpperCase() === "TEMPLATE" && !flockRows.length
      ? "SYSTEM"
      : String(planState?.source || "SYSTEM").toUpperCase();
  const badge = SOURCE_BADGE[source] || SOURCE_BADGE.SYSTEM;

  const ageDays = useMemo(() => {
    if (!flock?.arrivalDate) return null;
    const d = Math.floor((Date.now() - new Date(String(flock.arrivalDate)).getTime()) / 86400000);
    return Number.isFinite(d) ? d : null;
  }, [flock?.arrivalDate]);

  const call = async (method: string, body: any) => {
    const res = await fetch("/api/checklists", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (!d.success) throw new Error(d.error || "Request failed");
    return d;
  };

  const run = async (fn: () => Promise<any>, okMsg: string) => {
    setBusy(true); setError(""); setNotice("");
    try {
      await fn();
      setNotice(okMsg);
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const fork = () =>
    run(
      () => call("POST", { entity: "FLOCK_PLAN", data: { businessId, branchCode, flockId: flock.id, action: "fork", actorName: currentUser?.name } }),
      `Customized — a private copy of the recommended plan now belongs to ${flock.batchNumber}.`,
    );

  const applyTemplate = () => {
    const tpl = usableTemplates.find((t) => String(t.id) === String(tplPick));
    if (!tpl) { setError("Choose a saved template to apply."); return; }
    if (!window.confirm(`Apply "${tpl.name}" to ${flock.batchNumber}? This replaces the flock's current plan (completed history is kept).`)) return;
    return run(
      () => call("POST", { entity: "FLOCK_PLAN", data: { businessId, branchCode, flockId: flock.id, action: "apply_template", planTemplateId: tpl.id, actorName: currentUser?.name } }),
      `Template "${tpl.name}" applied to ${flock.batchNumber}.`,
    );
  };

  const resetPlan = () =>
    run(
      () => call("POST", { entity: "FLOCK_PLAN", data: { businessId, branchCode, flockId: flock.id, action: "reset", actorName: currentUser?.name } }),
      `${flock.batchNumber} now follows the recommended system plan again.`,
    );

  const saveAsTemplate = () => {
    const name = saveName.trim();
    if (!name) { setError("Enter a name for the reusable template."); return; }
    return run(
      async () => {
        await call("POST", { entity: "FLOCK_PLAN", data: { businessId, branchCode, flockId: flock.id, action: "save_as_template", name, actorName: currentUser?.name } });
        setSaveName("");
      },
      `Saved "${name}" as a reusable plan template.`,
    );
  };

  const saveRow = (t: any) => {
    const assignee = staff.find((s: any) => String(s.id) === String(editDraft.assignedToUserId ?? t.assignedToUserId ?? ""));
    return run(
      () =>
        call("PATCH", {
          entity: "TEMPLATE",
          id: t.id,
          data: {
            taskLabel: editDraft.taskLabel ?? t.taskLabel,
            category: editDraft.category ?? t.category,
            priority: editDraft.priority ?? t.priority,
            frequency: editDraft.frequency ?? t.frequency,
            stageKeys: editDraft.stageKey !== undefined ? (editDraft.stageKey ? [editDraft.stageKey] : null) : (t.stageKeys || null),
            assignedToUserId: editDraft.assignedToUserId ?? t.assignedToUserId ?? null,
            assignedToName: assignee?.name || null,
            assignedToRole: assignee?.role || null,
            isActive: editDraft.isActive !== undefined ? editDraft.isActive : t.isActive !== false,
          },
        }),
      `Updated "${editDraft.taskLabel ?? t.taskLabel}".`,
    ).then(() => setEditId(null));
  };

  const addRow = () => {
    if (!newItem.taskLabel.trim()) { setError("Enter the task label."); return; }
    const assignee = staff.find((s: any) => String(s.id) === String(newItem.assignedToUserId));
    return run(
      async () => {
        await call("POST", {
          entity: "TEMPLATE",
          data: {
            businessId,
            branchCode,
            flockId: flock.id,
            taskLabel: newItem.taskLabel.trim(),
            category: newItem.category || "GENERAL",
            frequency: newItem.frequency || "DAILY",
            priority: newItem.priority || "ROUTINE",
            stageKeys: newItem.stageKey ? [newItem.stageKey] : null,
            assignedToUserId: assignee?.id || null,
            assignedToName: assignee?.name || null,
            assignedToRole: assignee?.role || null,
            createdByName: currentUser?.name,
            createdByRole: currentUser?.role,
          },
        });
        setNewItem({ taskLabel: "", category: "GENERAL", assignedToUserId: "", frequency: "DAILY", priority: "ROUTINE" });
      },
      `Added "${newItem.taskLabel.trim()}" to ${flock.batchNumber}'s plan.`,
    );
  };

  const removeRow = (t: any) => {
    if (!window.confirm(`Remove "${t.taskLabel}" from ${flock.batchNumber}'s plan?`)) return;
    return run(
      async () => {
        const res = await fetch(`/api/checklists?id=${t.id}`, { method: "DELETE" });
        const d = await res.json();
        if (!d.success) throw new Error(d.error || "Failed to remove item");
      },
      `Removed "${t.taskLabel}".`,
    );
  };

  const toggleActive = (t: any) =>
    run(
      () => call("PATCH", { entity: "TEMPLATE", id: t.id, data: { isActive: t.isActive === false } }),
      t.isActive === false ? `Re-activated "${t.taskLabel}".` : `Paused "${t.taskLabel}" (kept in the plan, skipped in daily checklists).`,
    );

  const deletePlanTemplate = (tpl: any) => {
    if (!window.confirm(`Delete the saved template "${tpl.name}"? Flocks already using it keep their plans.`)) return;
    return run(
      async () => {
        const res = await fetch(`/api/checklists?id=${tpl.id}&entity=PLAN_TEMPLATE`, { method: "DELETE" });
        const d = await res.json();
        if (!d.success) throw new Error(d.error || "Failed to delete template");
        if (String(tplPick) === String(tpl.id)) setTplPick("");
      },
      `Deleted template "${tpl.name}".`,
    );
  };

  const inputCls = "px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs w-full";
  const selCls = "px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs";
  const stageOptions = isPlanType ? stagesOfBirdType(birdType) : [];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 backdrop-blur-sm p-3 md:p-4" data-testid="flock-plan-editor">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl shadow-2xl max-h-[94vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-slate-800 p-4 md:p-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Layers className="w-4 h-4 text-cyan-300 shrink-0" />
              <h3 className="text-sm md:text-base font-bold text-white truncate">Checklist Plan — {flock.batchNumber}</h3>
              <span className={`px-2 py-0.5 rounded-full border text-[9px] font-black tracking-wide ${badge.cls}`}>{badge.label}</span>
            </div>
            <p className="text-[10px] text-slate-500 mt-0.5">
              {flock.birdType}{flock.breed ? ` · ${flock.breed}` : ""} · {flock.status}
              {ageDays != null && (
                <> · {birdType === "LAYERS" ? `Week ${displayWeekOf(ageDays)}` : `Day ${displayDayOf(ageDays)}`}</>
              )}
              {source === "TEMPLATE" && planState?.planTemplateName ? ` · from "${planState.planTemplateName}"` : ""}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white shrink-0" title="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto p-4 md:p-5 space-y-4">
          {error && <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-2.5 rounded-lg text-xs flex items-center gap-2"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{error}</div>}
          {notice && <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 p-2.5 rounded-lg text-xs flex items-center gap-2"><Check className="w-3.5 h-3.5 shrink-0" />{notice}</div>}

          {/* Not customized → recommended system plan */}
          {!flockRows.length && (
            <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-4 space-y-3" data-testid="flock-plan-system">
              <div className="flex items-start gap-2">
                <Egg className="w-4 h-4 text-cyan-300 mt-0.5 shrink-0" />
                <div>
                  <div className="text-xs font-bold text-cyan-200">
                    This flock follows the recommended GoMina {birdType.toLowerCase()} plan
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    {systemCount} age-matched tasks auto-schedule from Day/Week 1 through closeout — broilers by day, layers by week.
                    Customize for this flock alone, or start from a saved template. Other flocks are never affected.
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={fork} disabled={busy || !isPlanType}
                  className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50"
                  data-testid="flock-plan-customize-btn">
                  <Copy className="w-3.5 h-3.5" />Customize this plan
                </button>
                {usableTemplates.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <select value={tplPick} onChange={(e) => setTplPick(e.target.value)} className={selCls} data-testid="flock-plan-tpl-select">
                      <option value="">Saved template…</option>
                      {usableTemplates.map((t) => (
                        <option key={t.id} value={t.id}>{t.name} ({(t.items || []).length} tasks)</option>
                      ))}
                    </select>
                    <button onClick={applyTemplate} disabled={busy || !tplPick}
                      className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50">
                      <FileDown className="w-3.5 h-3.5" />Apply
                    </button>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-700/60">
                <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Save this plan as a reusable template named…"
                  className={`${inputCls} flex-1 min-w-[180px]`} data-testid="flock-plan-save-name" />
                <button onClick={saveAsTemplate} disabled={busy}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-slate-200 text-xs font-bold flex items-center gap-1.5 hover:text-white disabled:opacity-50">
                  <Save className="w-3.5 h-3.5" />Save as template
                </button>
              </div>
            </div>
          )}

          {/* Customized → editable rows */}
          {flockRows.length > 0 && (
            <>
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-[10px] text-slate-400">
                  <span className="font-bold text-amber-200">{flockRows.length} private task{flockRows.length > 1 ? "s" : ""}</span> for {flock.batchNumber} only —
                  the recommended system plan and every other flock are untouched.
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => { if (confirmReset) { resetPlan(); setConfirmReset(false); } else setConfirmReset(true); }}
                    disabled={busy}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 border disabled:opacity-50 ${confirmReset ? "bg-rose-600 border-rose-500 text-white" : "bg-slate-800 border-slate-600 text-slate-300 hover:text-white"}`}
                    data-testid="flock-plan-reset-btn">
                    <RotateCcw className="w-3.5 h-3.5" />{confirmReset ? "Confirm reset to recommended" : "Reset to recommended"}
                  </button>
                </div>
              </div>

              <div className="space-y-2" data-testid="flock-plan-rows">
                {flockRows.map((t) => (
                  <div key={t.id} className={`flex flex-wrap items-center gap-2 p-2 rounded-lg border text-xs ${t.isActive !== false ? "border-slate-700 bg-slate-900/60" : "border-slate-800 bg-slate-900/30 opacity-60"}`}>
                    {editId === t.id ? (
                      <>
                        <input value={editDraft.taskLabel ?? t.taskLabel} onChange={(e) => setEditDraft({ ...editDraft, taskLabel: e.target.value })} className={`${inputCls} flex-1 min-w-[160px]`} />
                        <select value={editDraft.category ?? t.category ?? "GENERAL"} onChange={(e) => setEditDraft({ ...editDraft, category: e.target.value })} className={selCls}>
                          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <select value={editDraft.priority ?? t.priority ?? "ROUTINE"} onChange={(e) => setEditDraft({ ...editDraft, priority: e.target.value })} className={selCls} title="Priority">
                          <option value="ROUTINE">Routine</option>
                          <option value="CRITICAL">Critical</option>
                        </select>
                        <select value={editDraft.frequency ?? t.frequency ?? "DAILY"} onChange={(e) => setEditDraft({ ...editDraft, frequency: e.target.value })} className={selCls} title="Frequency">
                          {FREQUENCIES.map((f) => <option key={f} value={f}>{f.replace("_", " ")}</option>)}
                        </select>
                        {isPlanType && (
                          <select value={editDraft.stageKey ?? (t.stageKeys?.length === 1 ? t.stageKeys[0] : "") ?? ""} onChange={(e) => setEditDraft({ ...editDraft, stageKey: e.target.value })} className={selCls} title="Stage scope">
                            <option value="">All stages</option>
                            {stageOptions.map((s) => <option key={s.stageKey} value={s.stageKey}>{s.label}</option>)}
                          </select>
                        )}
                        <select value={editDraft.assignedToUserId ?? t.assignedToUserId ?? ""} onChange={(e) => setEditDraft({ ...editDraft, assignedToUserId: e.target.value })} className={selCls}>
                          <option value="">— Unassigned —</option>
                          {staff.map((s: any) => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}
                        </select>
                        <button onClick={() => saveRow(t)} disabled={busy} className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center gap-1 disabled:opacity-50"><Check className="w-3 h-3" />Save</button>
                        <button onClick={() => setEditId(null)} className="px-2 py-1 rounded bg-slate-700 text-slate-300 flex items-center gap-1"><X className="w-3 h-3" />Cancel</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => toggleActive(t)}
                          title={t.isActive !== false ? "Pause (skip in daily checklists)" : "Re-activate"}
                          className={`px-2 py-1 rounded text-[10px] font-black border ${t.isActive !== false ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300" : "bg-slate-800 border-slate-600 text-slate-400"}`}>
                          {t.isActive !== false ? "ON" : "PAUSED"}
                        </button>
                        <span className={`flex-1 min-w-[150px] font-semibold ${t.isActive !== false ? "text-slate-200" : "text-slate-500 line-through"}`}>{t.taskLabel}</span>
                        {t.stageKeys?.length
                          ? <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-600 text-slate-400 text-[9px] font-bold">{t.stageKeys.length === 1 ? t.stageKeys[0].replace(/_/g, " ") : `${t.stageKeys.length} stages`}</span>
                          : <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-600 text-slate-500 text-[9px] font-bold">ALL STAGES</span>}
                        {t.frequency && t.frequency !== "DAILY" && <span className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/40 text-amber-300 text-[9px] font-bold">{t.frequency.replace("_", " ")}</span>}
                        {String(t.priority || "").toUpperCase() === "CRITICAL" && <span className="px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 text-[9px] font-black">CRITICAL</span>}
                        {t.assignedToName && (
                          <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-600 text-slate-400 text-[9px] font-bold flex items-center gap-1">
                            <UserCheck className="w-2.5 h-2.5" />{t.assignedToName}
                          </span>
                        )}
                        <button onClick={() => { setEditId(t.id); setEditDraft({}); }} className="p-1.5 rounded bg-slate-800 text-slate-300 hover:text-white" title="Edit"><Pencil className="w-3 h-3" /></button>
                        <button onClick={() => removeRow(t)} disabled={busy} className="p-1.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 hover:bg-rose-500/20 disabled:opacity-50" title="Remove from this flock's plan"><Trash className="w-3 h-3" /></button>
                      </>
                    )}
                  </div>
                ))}
              </div>

              {/* Add item to THIS flock */}
              <div className="flex flex-wrap items-center gap-2 p-2 rounded-lg border border-dashed border-slate-600 bg-slate-900/40 text-xs" data-testid="flock-plan-add-row">
                <Plus className="w-3.5 h-3.5 text-slate-400" />
                <input value={newItem.taskLabel} onChange={(e) => setNewItem({ ...newItem, taskLabel: e.target.value })}
                  placeholder={`New task for ${flock.batchNumber} only…`} className={`${inputCls} flex-1 min-w-[160px]`} data-testid="flock-plan-new-label" />
                <select value={newItem.frequency} onChange={(e) => setNewItem({ ...newItem, frequency: e.target.value })} className={selCls} title="Frequency">
                  {FREQUENCIES.map((f) => <option key={f} value={f}>{f.replace("_", " ")}</option>)}
                </select>
                {isPlanType && (
                  <select value={newItem.stageKey || ""} onChange={(e) => setNewItem({ ...newItem, stageKey: e.target.value })} className={selCls} title="Stage scope">
                    <option value="">All stages</option>
                    {stageOptions.map((s) => <option key={s.stageKey} value={s.stageKey}>{s.label}</option>)}
                  </select>
                )}
                <select value={newItem.priority} onChange={(e) => setNewItem({ ...newItem, priority: e.target.value })} className={selCls} title="Priority">
                  <option value="ROUTINE">Routine</option>
                  <option value="CRITICAL">Critical</option>
                </select>
                <select value={newItem.assignedToUserId} onChange={(e) => setNewItem({ ...newItem, assignedToUserId: e.target.value })} className={selCls}>
                  <option value="">— Unassigned —</option>
                  {staff.map((s: any) => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}
                </select>
                <button onClick={addRow} disabled={busy || !newItem.taskLabel.trim()}
                  className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold disabled:opacity-40" data-testid="flock-plan-add-btn">Add to flock</button>
              </div>

              {/* Save as template / apply template */}
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-3 space-y-2">
                  <div className="text-[10px] font-bold text-slate-300 uppercase tracking-wide">Save as reusable template</div>
                  <div className="flex gap-2">
                    <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="e.g. Kwahu Broiler Winter Plan"
                      className={inputCls} data-testid="flock-plan-save-name-2" />
                    <button onClick={saveAsTemplate} disabled={busy}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-slate-200 text-xs font-bold flex items-center gap-1.5 hover:text-white disabled:opacity-50 shrink-0">
                      <Save className="w-3.5 h-3.5" />Save
                    </button>
                  </div>
                  <p className="text-[9px] text-slate-500">Snapshot this flock&apos;s plan (including any farm-wide custom items it uses) for future flocks.</p>
                </div>
                <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-3 space-y-2">
                  <div className="text-[10px] font-bold text-slate-300 uppercase tracking-wide">Apply a saved template</div>
                  <div className="flex gap-2">
                    <select value={tplPick} onChange={(e) => setTplPick(e.target.value)} className={selCls + " flex-1"} data-testid="flock-plan-tpl-select-2">
                      <option value="">Saved template…</option>
                      {usableTemplates.map((t) => (
                        <option key={t.id} value={t.id}>{t.name} ({(t.items || []).length} tasks)</option>
                      ))}
                    </select>
                    <button onClick={applyTemplate} disabled={busy || !tplPick}
                      className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50 shrink-0">
                      <FileDown className="w-3.5 h-3.5" />Apply
                    </button>
                  </div>
                  {planTemplates.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {planTemplates.map((t) => (
                        <span key={t.id} className="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-600 text-slate-400 text-[9px] font-bold flex items-center gap-1">
                          {t.name}{t.birdType ? ` · ${t.birdType.slice(0, 1)}` : ""}
                          <button onClick={() => deletePlanTemplate(t)} disabled={busy} className="text-rose-300 hover:text-rose-200" title="Delete template">
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="border-t border-slate-800 p-3 flex items-center justify-between gap-2">
          <p className="text-[9px] text-slate-500">
            Plan changes apply from today forward — completed history is never rewritten. Every change is recorded in the Audit Trail.
          </p>
          <button onClick={onClose} className="px-4 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-slate-200 text-xs font-bold hover:text-white shrink-0">Done</button>
        </div>
      </div>
    </div>
  );
}
