"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  X, Plus, Trash2, FileSpreadsheet, Settings2, History, Sparkles, Loader2, Star, Archive,
} from "lucide-react";
import {
  FISH_BENCHMARK_TEMPLATES,
  FISH_BENCHMARK_METRIC_META,
  type FishBenchmarkCurveDef,
  type FishBenchmarkCurves,
  type FishBenchmarkMetricKey,
} from "@/lib/fishBenchmarking";

interface Props {
  businessId: number;
  batches: any[];
  currentUserName?: string;
  currentUserRole?: string;
  canManage: boolean;
  onClose: () => void;
  onRefresh: () => void;
}

interface DraftProfile {
  id?: number;
  name: string;
  species: string;
  strain: string;
  isDefault: boolean;
  toleranceWarnPct: string;
  toleranceCritPct: string;
  notes: string;
  harvestAgeDays: string;
  livePricePerKgGhs: string;
  source?: string;
  curves: Partial<Record<FishBenchmarkMetricKey, { by: "ageDays" | "ageWeeks"; points: [number, number][] }>>;
}

const METRIC_LABEL: Record<string, { label: string; unit: string }> = Object.fromEntries(
  Object.entries(FISH_BENCHMARK_METRIC_META).map(([k, v]) => [k, { label: v.label, unit: v.unit }]),
);

const SPECIES = ["VOLTA_TILAPIA", "RED_TILAPIA", "NILE_TILAPIA", "AFRICAN_CATFISH", "HETEROTIS", "CARP"];

const emptyDraft = (): DraftProfile => ({
  name: "", species: "VOLTA_TILAPIA", strain: "", isDefault: false,
  toleranceWarnPct: "5", toleranceCritPct: "10", notes: "",
  harvestAgeDays: "", livePricePerKgGhs: "", curves: {},
});

const curvesToDraft = (curves: FishBenchmarkCurves | null | undefined): DraftProfile["curves"] => {
  const out: DraftProfile["curves"] = {};
  for (const [key, def] of Object.entries(curves || {})) {
    if (key === "_meta" || !def) continue;
    (out as any)[key] = { by: (def as FishBenchmarkCurveDef).by || "ageDays", points: (def as FishBenchmarkCurveDef).points || [] };
  }
  return out;
};

const draftToCurves = (d: DraftProfile): FishBenchmarkCurves => {
  const out: FishBenchmarkCurves = {};
  for (const [key, c] of Object.entries(d.curves)) {
    if (!c || !c.points.length) continue;
    (out as any)[key] = { by: c.by, points: c.points };
  }
  out._meta = {
    harvestAgeDays: Number(d.harvestAgeDays) > 0 ? Number(d.harvestAgeDays) : undefined,
    livePricePerKgGhs: Number(d.livePricePerKgGhs) > 0 ? Number(d.livePricePerKgGhs) : undefined,
  };
  return out;
};

/**
 * Fish Benchmark Profile manager (drawer): create / copy-from-template /
 * derive-from-batch / edit curves in a spreadsheet-style grid / set defaults /
 * archive / delete. Backed by /api/aquaculture/benchmarks.
 */
export default function FishBenchmarkManager({
  businessId, batches, currentUserName, currentUserRole, canManage, onClose, onRefresh,
}: Props) {
  const [profiles, setProfiles] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>(FISH_BENCHMARK_TEMPLATES);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [draft, setDraft] = useState<DraftProfile | null>(null);
  const [csvOpenFor, setCsvOpenFor] = useState<string | null>(null);
  const [csvText, setCsvText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<any | null>(null);
  const [mode, setMode] = useState<"list" | "new-template" | "derive">("list");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/aquaculture/benchmarks?businessId=${businessId}`);
      const d = await res.json();
      if (d.success) {
        setProfiles(d.profiles || []);
        if (d.templates) setTemplates(d.templates);
      } else setErr(d.error || "Could not load profiles.");
    } catch {
      setErr("Network error — could not load profiles.");
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => { reload(); }, [reload]);

  const post = async (method: "POST" | "PATCH" | "DELETE", body: any) => {
    setBusy(true); setErr(""); setMsg("");
    try {
      const res = await fetch("/api/aquaculture/benchmarks", {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!d.success) { setErr(d.error || "Operation failed."); return false; }
      return true;
    } catch (e: any) {
      setErr(e.message || "Network error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    if (!draft.name.trim()) { setErr("Profile name is required."); return; }
    const data: any = {
      businessId,
      name: draft.name.trim(),
      species: draft.species,
      strain: draft.strain.trim() || null,
      isDefault: draft.isDefault,
      toleranceWarnPct: Number(draft.toleranceWarnPct) || 5,
      toleranceCritPct: Number(draft.toleranceCritPct) || 10,
      notes: draft.notes.trim() || null,
      curves: draftToCurves(draft),
      createdByName: currentUserName,
      createdByRole: currentUserRole,
    };
    const ok = draft.id
      ? await post("PATCH", { entity: "PROFILE", id: draft.id, data })
      : await post("POST", { entity: "PROFILE", data });
    if (ok) {
      setMsg(draft.id ? "Profile updated." : "Profile created.");
      setDraft(null);
      await reload();
      onRefresh();
    }
  };

  const deriveFrom = async (batchId: number) => {
    const ok = await post("POST", {
      entity: "PROFILE",
      data: { businessId, deriveFromBatchId: batchId, createdByName: currentUserName, createdByRole: currentUserRole },
    });
    if (ok) {
      setMode("list");
      setMsg("Profile derived from batch performance — open it to fine-tune the curves.");
      await reload();
      onRefresh();
    }
  };

  const toggleDefault = async (p: any) => {
    const ok = await post("PATCH", { entity: "PROFILE", id: p.id, data: { isDefault: !p.isDefault } });
    if (ok) { await reload(); onRefresh(); }
  };

  const archive = async (p: any) => {
    const ok = await post("PATCH", { entity: "PROFILE", id: p.id, data: { status: p.status === "ARCHIVED" ? "ACTIVE" : "ARCHIVED" } });
    if (ok) { await reload(); onRefresh(); }
  };

  const remove = async (p: any) => {
    const ok = await post("DELETE", { entity: "PROFILE", id: p.id });
    if (ok) { setConfirmDelete(null); setMsg(`Profile "${p.name}" deleted.`); await reload(); onRefresh(); }
  };

  const editExisting = (p: any) => {
    const meta = (p.curves || {})._meta || {};
    setDraft({
      id: p.id, name: p.name, species: p.species, strain: p.strain || "",
      isDefault: !!p.isDefault,
      toleranceWarnPct: String(p.toleranceWarnPct ?? 5),
      toleranceCritPct: String(p.toleranceCritPct ?? 10),
      notes: p.notes || "",
      harvestAgeDays: meta.harvestAgeDays ? String(meta.harvestAgeDays) : "",
      livePricePerKgGhs: meta.livePricePerKgGhs ? String(meta.livePricePerKgGhs) : "",
      source: p.source, curves: curvesToDraft(p.curves),
    });
    setErr(""); setMsg("");
  };

  const startFromTemplate = (t: any) => {
    const curves = curvesToDraft(t.curves);
    const meta = (t.curves || {})._meta || {};
    setDraft({
      ...emptyDraft(),
      name: t.name.replace(/ — .*/, ""),
      species: t.species,
      curves,
      harvestAgeDays: meta.harvestAgeDays ? String(meta.harvestAgeDays) : "",
      livePricePerKgGhs: meta.livePricePerKgGhs ? String(meta.livePricePerKgGhs) : "",
      source: "TEMPLATE",
    });
    setMode("list"); setErr(""); setMsg("");
  };

  // ── curve-grid helpers ──
  const setPoint = (key: string, idx: number, field: 0 | 1, val: string) => {
    if (!draft) return;
    const c = draft.curves[key as FishBenchmarkMetricKey];
    if (!c) return;
    const pts = c.points.map((p, i) => (i === idx ? ([field === 0 ? Number(val) || 0 : p[0], field === 1 ? Number(val) || 0 : p[1]] as [number, number]) : p));
    setDraft({ ...draft, curves: { ...draft.curves, [key]: { ...c, points: pts } } });
  };
  const addPoint = (key: string) => {
    if (!draft) return;
    const c = draft.curves[key as FishBenchmarkMetricKey];
    if (!c) return;
    const lastAge = c.points.length ? c.points[c.points.length - 1][0] : 0;
    setDraft({ ...draft, curves: { ...draft.curves, [key]: { ...c, points: [...c.points, [lastAge + 28, 0]] } } });
  };
  const removePoint = (key: string, idx: number) => {
    if (!draft) return;
    const c = draft.curves[key as FishBenchmarkMetricKey];
    if (!c) return;
    setDraft({ ...draft, curves: { ...draft.curves, [key]: { ...c, points: c.points.filter((_, i) => i !== idx) } } });
  };
  const addMetric = (key: string) => {
    if (!draft || !key || draft.curves[key as FishBenchmarkMetricKey]) return;
    setDraft({ ...draft, curves: { ...draft.curves, [key]: { by: "ageDays", points: [[28, 0], [56, 0]] } } });
  };
  const removeMetric = (key: string) => {
    if (!draft) return;
    const next = { ...draft.curves };
    delete (next as any)[key];
    setDraft({ ...draft, curves: next });
  };
  const applyCsv = (key: string) => {
    if (!draft) return;
    const pts: [number, number][] = csvText
      .split(/\n+/)
      .map((l) => l.split(/[,\s;t]+/).filter(Boolean).map(Number))
      .filter((xs) => xs.length >= 2 && Number.isFinite(xs[0]) && Number.isFinite(xs[1]))
      .map((xs) => [xs[0], xs[1]] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    if (pts.length < 2) { setErr("CSV needs at least 2 lines of: age,value"); return; }
    setDraft({ ...draft, curves: { ...draft.curves, [key]: { by: "ageDays", points: pts } } });
    setCsvOpenFor(null); setCsvText(""); setErr("");
  };

  const metricsInUse = useMemo(
    () => Object.keys(draft?.curves || {}).filter((k) => (draft!.curves as any)[k]?.points?.length),
    [draft],
  );
  const addableMetrics = useMemo(
    () => Object.keys(METRIC_LABEL).filter((k) => !metricsInUse.includes(k)),
    [metricsInUse],
  );

  const input =
    "w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-cyan-500";

  const derivableBatches = (batches || []).filter(
    (b) => b.status === "HARVESTED" || b.status === "SOLD" || b.status === "CULLED" || b.status === "GROWING",
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm" data-testid="fibm-root">
      <div className="w-full max-w-2xl h-full bg-slate-900 border-l border-slate-700 flex flex-col shadow-2xl">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {(draft || mode !== "list") && (
              <button onClick={() => { setDraft(null); setMode("list"); setErr(""); }} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white" data-testid="fibm-back">
                <X className="w-4 h-4 rotate-180" />
              </button>
            )}
            <Settings2 className="w-5 h-5 text-cyan-400" />
            <div>
              <h3 className="text-base font-bold text-white">Fish Benchmark Profiles</h3>
              <p className="text-[10px] text-slate-400">
                {draft ? (draft.id ? "Edit profile" : "New profile") : mode === "new-template" ? "Copy from a species template" : mode === "derive" ? "Derive from a real batch" : `${profiles.length} profile(s) · targets the dashboard compares every batch against`}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white" data-testid="fibm-close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {err && <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-3 rounded-lg text-xs" data-testid="fibm-error">{err}</div>}
          {msg && <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 p-3 rounded-lg text-xs" data-testid="fibm-msg">{msg}</div>}
          {loading && <div className="flex items-center justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-cyan-400" /></div>}
          {!loading && canManage && (
            <>
              {/* ── LIST MODE ── */}
              {!draft && mode === "list" && (
                <>
                  <div className="flex flex-wrap gap-2" data-testid="fibm-actions">
                    <button onClick={() => { setDraft(emptyDraft()); setErr(""); setMsg(""); }} data-testid="fibm-new"
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold">
                      <Plus className="w-3.5 h-3.5" /> New profile
                    </button>
                    <button onClick={() => setMode("new-template")} data-testid="fibm-template"
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold">
                      <Sparkles className="w-3.5 h-3.5" /> Copy from template
                    </button>
                    <button onClick={() => setMode("derive")} data-testid="fibm-derive"
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold">
                      <History className="w-3.5 h-3.5" /> Derive from batch
                    </button>
                  </div>

                  {profiles.length === 0 && (
                    <div className="text-center py-10 text-xs text-slate-500" data-testid="fibm-empty">
                      No benchmark profiles yet. Start from a species template (tilapia / catfish standards), derive one from a finished batch, or build curves by hand.
                    </div>
                  )}

                  <div className="space-y-2" data-testid="fibm-list">
                    {profiles.map((p: any) => (
                      <div key={p.id} data-testid={`fibm-profile-${p.id}`} className="bg-slate-800/70 border border-slate-700/70 rounded-xl p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-xs font-bold text-white truncate">{p.name}</span>
                              {p.isDefault && <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[9px] font-bold" data-testid={`fibm-default-badge-${p.id}`}>DEFAULT</span>}
                              <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 text-[9px] font-bold">{p.species}</span>
                              {p.strain && <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 text-[9px]">{p.strain}</span>}
                              <span className="px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-400 text-[9px]">{p.source}</span>
                              {p.status === "ARCHIVED" && <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 text-[9px] font-bold">ARCHIVED</span>}
                            </div>
                            <div className="text-[10px] text-slate-500 mt-1">
                              {Object.keys(p.curves || {}).filter((k: string) => k !== "_meta").length} curve(s) · warn ±{p.toleranceWarnPct}% · crit ±{p.toleranceCritPct}%
                              {(p.usedByBatches || []).length > 0 && ` · used by ${p.usedByBatches.join(", ")}`}
                            </div>
                            {p.notes && <div className="text-[10px] text-slate-500 mt-0.5 italic truncate">{p.notes}</div>}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => editExisting(p)} data-testid={`fibm-edit-${p.id}`} className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-[10px] font-bold text-white">Edit</button>
                            <button onClick={() => toggleDefault(p)} data-testid={`fibm-default-${p.id}`} className="p-1 rounded hover:bg-slate-700" title={p.isDefault ? "Unset as default" : "Set as default for this species"}>
                              <Star className={`w-3.5 h-3.5 ${p.isDefault ? "text-amber-400 fill-amber-400" : "text-slate-500"}`} />
                            </button>
                            <button onClick={() => archive(p)} data-testid={`fibm-archive-${p.id}`} className="p-1 rounded hover:bg-slate-700" title={p.status === "ARCHIVED" ? "Restore" : "Archive"}>
                              <Archive className={`w-3.5 h-3.5 ${p.status === "ARCHIVED" ? "text-cyan-400" : "text-slate-500"}`} />
                            </button>
                            <button onClick={() => setConfirmDelete(p)} data-testid={`fibm-delete-${p.id}`} className="px-1.5 py-1 rounded hover:bg-slate-700 text-rose-400"><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        </div>
                        {confirmDelete?.id === p.id && (
                          <div className="mt-2 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2 flex items-center justify-between gap-2" data-testid="fibm-delete-confirm">
                            <span className="text-[10px] text-rose-200">
                              Delete &ldquo;{p.name}&rdquo;? {(p.usedByBatches || []).length ? `Blocked while used by ${p.usedByBatches.join(", ")}.` : "This cannot be undone."}
                            </span>
                            <div className="flex gap-1 shrink-0">
                              <button onClick={() => setConfirmDelete(null)} className="px-2 py-1 rounded bg-slate-700 text-[10px] text-white">Cancel</button>
                              <button onClick={() => remove(p)} disabled={busy} className="px-2 py-1 rounded bg-rose-600 text-[10px] font-bold text-white disabled:opacity-50">Delete</button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* ── TEMPLATE PICKER ── */}
              {!draft && mode === "new-template" && (
                <div className="space-y-2" data-testid="fibm-templates">
                  <p className="text-[11px] text-slate-400">
                    Copy a species-standard template as a starting point — every curve is editable afterwards.
                  </p>
                  {templates.map((t: any, i: number) => (
                    <button key={i} onClick={() => startFromTemplate(t)} data-testid={`fibm-use-template-${i}`}
                      className="w-full text-left bg-slate-800/70 border border-slate-700/70 hover:border-cyan-500/50 rounded-xl p-3">
                      <div className="text-xs font-bold text-white">{t.name}</div>
                      <div className="text-[10px] text-slate-500 mt-0.5">
                        {t.species} · {Object.keys(t.curves || {}).filter((k: string) => k !== "_meta").length} curves · {t.curves?._meta?.harvestAgeDays}d harvest · GH₵{t.curves?._meta?.livePricePerKgGhs}/kg
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* ── DERIVE PICKER ── */}
              {!draft && mode === "derive" && (
                <div className="space-y-2" data-testid="fibm-derive-list">
                  <p className="text-[11px] text-slate-400">
                    Build a profile from what a real batch actually achieved (FARM_HISTORY source). Best run on a finished batch with weight + feed logs.
                  </p>
                  {derivableBatches.length === 0 && (
                    <div className="text-center py-8 text-xs text-slate-500">No batches with enough history yet.</div>
                  )}
                  {derivableBatches.map((b: any) => (
                    <button key={b.id} onClick={() => deriveFrom(b.id)} data-testid={`fibm-derive-${b.id}`}
                      className="w-full text-left bg-slate-800/70 border border-slate-700/70 hover:border-cyan-500/50 rounded-xl p-3">
                      <div className="text-xs font-bold text-white">{b.batchNumber} <span className="text-slate-400 font-normal">· {b.species}</span></div>
                      <div className="text-[10px] text-slate-500 mt-0.5">
                        hatched {b.hatchDate} · {b.initialCount?.toLocaleString()} stocked · {b.status}
                        {b.harvestedKgNote ? "" : ""}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* ── EDITOR ── */}
              {draft && (
                <div className="space-y-4" data-testid="fibm-editor">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <label className="block text-[10px] text-slate-500 mb-1">Profile name *</label>
                      <input data-testid="fibm-name" className={input} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Volta Tilapia — Akosombo 2026 target" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1">Species *</label>
                      <select data-testid="fibm-species" className={input} value={draft.species} onChange={(e) => setDraft({ ...draft, species: e.target.value })} disabled={!!draft.id}>
                        {SPECIES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1">Strain (optional narrowing)</label>
                      <input data-testid="fibm-strain" className={input} value={draft.strain} onChange={(e) => setDraft({ ...draft, strain: e.target.value })} placeholder="e.g. Akosombo strain" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1">Warn tolerance ±%</label>
                      <input data-testid="fibm-warn" type="number" min="0.5" step="0.5" className={input} value={draft.toleranceWarnPct} onChange={(e) => setDraft({ ...draft, toleranceWarnPct: e.target.value })} />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1">Critical tolerance ±%</label>
                      <input data-testid="fibm-crit" type="number" min="1" step="0.5" className={input} value={draft.toleranceCritPct} onChange={(e) => setDraft({ ...draft, toleranceCritPct: e.target.value })} />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1">Harvest age (days)</label>
                      <input data-testid="fibm-harvestage" type="number" min="21" step="1" className={input} value={draft.harvestAgeDays} onChange={(e) => setDraft({ ...draft, harvestAgeDays: e.target.value })} placeholder="e.g. 196" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-500 mb-1">Live price (GH₵/kg)</label>
                      <input data-testid="fibm-liveprice" type="number" min="0" step="0.5" className={input} value={draft.livePricePerKgGhs} onChange={(e) => setDraft({ ...draft, livePricePerKgGhs: e.target.value })} placeholder="e.g. 62" />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-[11px] text-slate-300">
                    <input type="checkbox" data-testid="fibm-default" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} className="accent-amber-500" />
                    Default profile for this species (auto-matches batches with no explicit pin)
                  </label>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-1">Notes</label>
                    <textarea data-testid="fibm-notes" className={`${input} h-16 resize-none`} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Where the numbers came from, who to ask…" />
                  </div>

                  {/* Curve grid editor */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-bold text-slate-300">Target curves (age in days → value)</span>
                      <select
                        data-testid="fibm-add-metric"
                        value=""
                        onChange={(e) => addMetric(e.target.value)}
                        className="px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-white text-[10px]"
                      >
                        <option value="">+ add metric curve…</option>
                        {addableMetrics.map((k) => (
                          <option key={k} value={k}>{METRIC_LABEL[k].label}</option>
                        ))}
                      </select>
                    </div>
                    {metricsInUse.length === 0 && (
                      <p className="text-[10px] text-slate-500 bg-slate-800/50 rounded-lg p-2.5">
                        No curves yet — add a metric (start with Avg fish weight) or copy a template. A profile needs at least one curve to benchmark against.
                      </p>
                    )}
                    <div className="space-y-2">
                      {metricsInUse.map((key) => {
                        const c = (draft.curves as any)[key];
                        return (
                          <div key={key} className="bg-slate-800/50 border border-slate-700/60 rounded-xl p-3" data-testid={`fibm-curve-${key}`}>
                            <div className="flex items-center justify-between gap-2 mb-2">
                              <span className="text-[11px] font-bold text-slate-200">
                                {METRIC_LABEL[key]?.label || key}
                                {METRIC_LABEL[key]?.unit ? <span className="text-slate-500 font-normal"> ({METRIC_LABEL[key].unit})</span> : null}
                              </span>
                              <div className="flex items-center gap-1">
                                <button onClick={() => { setCsvOpenFor(csvOpenFor === key ? null : key); setCsvText(""); }} data-testid={`fibm-csv-${key}`}
                                  className="flex items-center gap-1 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-[10px] font-bold text-white">
                                  <FileSpreadsheet className="w-3 h-3" /> CSV
                                </button>
                                <button onClick={() => removeMetric(key)} data-testid={`fibm-remove-${key}`} className="px-1.5 py-1 rounded hover:bg-slate-700 text-rose-400"><Trash2 className="w-3 h-3" /></button>
                              </div>
                            </div>
                            {csvOpenFor === key && (
                              <div className="mb-2">
                                <textarea
                                  data-testid={`fibm-csv-input-${key}`}
                                  value={csvText}
                                  onChange={(e) => setCsvText(e.target.value)}
                                  placeholder={"ageDays,value\n28,15\n56,60\n84,140"}
                                  className="w-full h-20 px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-[10px] font-mono"
                                />
                                <button onClick={() => applyCsv(key)} className="mt-1 px-2 py-1 rounded bg-cyan-600 text-[10px] font-bold text-white" data-testid={`fibm-csv-apply-${key}`}>
                                  Apply CSV points
                                </button>
                              </div>
                            )}
                            <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5 items-center">
                              {c.points.map((p: [number, number], i: number) => (
                                <React.Fragment key={i}>
                                  <input
                                    data-testid={`fibm-pt-${key}-${i}-age`}
                                    type="number" min="0" value={p[0]}
                                    onChange={(e) => setPoint(key, i, 0, e.target.value)}
                                    className="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-white text-[10px] text-right"
                                    aria-label={`${key} point ${i} age`}
                                  />
                                  <input
                                    data-testid={`fibm-pt-${key}-${i}-val`}
                                    type="number" step="any" value={p[1]}
                                    onChange={(e) => setPoint(key, i, 1, e.target.value)}
                                    className="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-white text-[10px] text-right"
                                    aria-label={`${key} point ${i} value`}
                                  />
                                  <button onClick={() => removePoint(key, i)} className="p-1 rounded hover:bg-slate-700 text-slate-500 hover:text-rose-400" aria-label={`remove point ${i}`}>
                                    <X className="w-3 h-3" />
                                  </button>
                                </React.Fragment>
                              ))}
                            </div>
                            <button onClick={() => addPoint(key)} className="mt-1.5 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-[10px] font-bold text-white" data-testid={`fibm-addpt-${key}`}>
                              + point
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
          {!loading && !canManage && (
            <div className="text-center py-10 text-xs text-slate-500" data-testid="fibm-readonly">
              You don&apos;t have permission to manage benchmark profiles — view them on the dashboard.
            </div>
          )}
        </div>

        {/* Footer (editor save) */}
        {draft && canManage && (
          <div className="px-5 py-4 border-t border-slate-700 flex items-center justify-end gap-2">
            <button onClick={() => { setDraft(null); setErr(""); }} className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-bold text-white" data-testid="fibm-cancel">
              Cancel
            </button>
            <button onClick={saveDraft} disabled={busy} className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white disabled:opacity-50" data-testid="fibm-save">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} {draft.id ? "Save changes" : "Create profile"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
