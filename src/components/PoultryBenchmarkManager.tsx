"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  X, Plus, Copy, History as HistoryIcon, Star, Archive, Trash2, Save,
  ChevronLeft, FileSpreadsheet, ShieldCheck,
} from "lucide-react";
import {
  BENCHMARK_METRIC_META,
  BENCHMARK_TEMPLATES,
  type BenchmarkCurveDef,
  type BenchmarkCurves,
  type BenchmarkMetricKey,
} from "@/lib/poultryBenchmarking";

interface Props {
  businessId: number;
  flocks: any[];
  currentUserName?: string;
  currentUserRole?: string;
  canManage: boolean;
  onClose: () => void;
  /** Refetch the module's poultry datasets (profiles list changed). */
  onRefresh: () => void;
}

interface DraftProfile {
  id?: number;
  name: string;
  birdType: string;
  breed: string;
  isDefault: boolean;
  toleranceWarnPct: string;
  toleranceCritPct: string;
  notes: string;
  marketAgeDays: string;
  livePricePerKgGhs: string;
  source?: string;
  curves: Partial<Record<BenchmarkMetricKey, { by: "ageDays" | "ageWeeks"; points: [number, number][] }>>;
}

const METRIC_LABEL: Record<string, { label: string; unit: string }> = Object.fromEntries(
  Object.entries(BENCHMARK_METRIC_META).map(([k, v]) => [k, { label: v.label, unit: v.unit }]),
);

const BIRD_TYPES = ["LAYERS", "BROILERS", "COCKERELS", "TURKEYS", "GUINEA_FOWL"];

const emptyDraft = (): DraftProfile => ({
  name: "", birdType: "BROILERS", breed: "", isDefault: false,
  toleranceWarnPct: "5", toleranceCritPct: "10", notes: "",
  marketAgeDays: "", livePricePerKgGhs: "", curves: {},
});

const curvesToDraft = (curves: BenchmarkCurves | null | undefined): DraftProfile["curves"] => {
  const out: DraftProfile["curves"] = {};
  for (const [key, def] of Object.entries(curves || {})) {
    if (key === "_meta" || !def) continue;
    (out as any)[key] = { by: (def as BenchmarkCurveDef).by || "ageDays", points: (def as BenchmarkCurveDef).points || [] };
  }
  return out;
};

const draftToCurves = (d: DraftProfile): BenchmarkCurves => {
  const out: BenchmarkCurves = {};
  for (const [key, c] of Object.entries(d.curves)) {
    if (!c || !c.points.length) continue;
    (out as any)[key] = { by: c.by, points: c.points };
  }
  out._meta = {
    marketAgeDays: Number(d.marketAgeDays) > 0 ? Number(d.marketAgeDays) : undefined,
    livePricePerKgGhs: Number(d.livePricePerKgGhs) > 0 ? Number(d.livePricePerKgGhs) : undefined,
  };
  return out;
};

/**
 * Benchmark Profile manager (drawer): create / copy-from-template /
 * derive-from-flock / edit curves in a spreadsheet-style grid / set defaults /
 * archive / delete. Backed by /api/poultry/benchmarks.
 */
export default function PoultryBenchmarkManager({
  businessId, flocks, currentUserName, currentUserRole, canManage, onClose, onRefresh,
}: Props) {
  const [profiles, setProfiles] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>(BENCHMARK_TEMPLATES);
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
      const res = await fetch(`/api/poultry/benchmarks?businessId=${businessId}`);
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
      const res = await fetch("/api/poultry/benchmarks", {
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
      birdType: draft.birdType,
      breed: draft.breed.trim() || null,
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

  const deriveFrom = async (flockId: number) => {
    const ok = await post("POST", {
      entity: "PROFILE",
      data: { businessId, deriveFromFlockId: flockId, createdByName: currentUserName, createdByRole: currentUserRole },
    });
    if (ok) {
      setMode("list");
      setMsg("Profile derived from flock performance — open it to fine-tune the curves.");
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
      id: p.id, name: p.name, birdType: p.birdType, breed: p.breed || "",
      isDefault: !!p.isDefault,
      toleranceWarnPct: String(p.toleranceWarnPct ?? 5),
      toleranceCritPct: String(p.toleranceCritPct ?? 10),
      notes: p.notes || "",
      marketAgeDays: meta.marketAgeDays ? String(meta.marketAgeDays) : "",
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
      birdType: t.birdType,
      curves,
      marketAgeDays: meta.marketAgeDays ? String(meta.marketAgeDays) : "",
      source: "TEMPLATE",
    });
    setMode("list"); setErr(""); setMsg("");
  };

  // ── curve-grid helpers ──
  const setPoint = (key: string, idx: number, field: 0 | 1, val: string) => {
    if (!draft) return;
    const c = draft.curves[key as BenchmarkMetricKey];
    if (!c) return;
    const pts = c.points.map((p, i) => (i === idx ? ([field === 0 ? Number(val) || 0 : p[0], field === 1 ? Number(val) || 0 : p[1]] as [number, number]) : p));
    setDraft({ ...draft, curves: { ...draft.curves, [key]: { ...c, points: pts } } });
  };
  const addPoint = (key: string) => {
    if (!draft) return;
    const c = draft.curves[key as BenchmarkMetricKey];
    if (!c) return;
    const lastAge = c.points.length ? c.points[c.points.length - 1][0] : 0;
    setDraft({ ...draft, curves: { ...draft.curves, [key]: { ...c, points: [...c.points, [lastAge + 7, 0]] } } });
  };
  const removePoint = (key: string, idx: number) => {
    if (!draft) return;
    const c = draft.curves[key as BenchmarkMetricKey];
    if (!c) return;
    setDraft({ ...draft, curves: { ...draft.curves, [key]: { ...c, points: c.points.filter((_, i) => i !== idx) } } });
  };
  const addMetric = (key: string) => {
    if (!draft || !key || draft.curves[key as BenchmarkMetricKey]) return;
    const by: "ageDays" | "ageWeeks" = key === "LAY_PCT" || key === "EGG_WEIGHT_G" ? "ageWeeks" : "ageDays";
    setDraft({ ...draft, curves: { ...draft.curves, [key]: { by, points: [[by === "ageWeeks" ? 1 : 7, 0], [by === "ageWeeks" ? 2 : 14, 0]] } } });
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
    const by: "ageDays" | "ageWeeks" = key === "LAY_PCT" || key === "EGG_WEIGHT_G" ? "ageWeeks" : "ageDays";
    setDraft({ ...draft, curves: { ...draft.curves, [key]: { by, points: pts } } });
    setCsvOpenFor(null); setCsvText(""); setErr("");
  };

  const metricsInUse = useMemo(
    () => Object.keys(draft?.curves || {}).filter((k) => (draft!.curves as any)[k]?.points?.length),
    [draft],
  );
  const addableMetrics = useMemo(
    () => Object.keys(METRIC_LABEL).filter((k) => !metricsInUse.includes(k) && BENCHMARK_METRIC_META[k as BenchmarkMetricKey].appliesTo(draft?.birdType || "BROILERS")),
    [metricsInUse, draft],
  );

  const input = "w-full px-2.5 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-cyan-500";

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm" data-testid="pobm-root">
      <div className="bg-slate-900 border-l border-slate-700 w-full max-w-2xl h-full flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div className="flex items-center gap-2">
            {draft && (
              <button onClick={() => { setDraft(null); setErr(""); }} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white" data-testid="pobm-back">
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            <h3 className="text-base font-bold text-white">Benchmark Profiles</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white" data-testid="pobm-close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {err && <div className="mx-5 mt-3 bg-rose-500/10 border border-rose-500/30 text-rose-300 p-2.5 rounded-lg text-xs">{err}</div>}
        {msg && <div className="mx-5 mt-3 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 p-2.5 rounded-lg text-xs">{msg}</div>}
        {!canManage && (
          <div className="mx-5 mt-3 bg-slate-800 border border-slate-700 text-slate-400 p-2.5 rounded-lg text-xs flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" /> View-only — only the OWNER, a General Manager or a records-authorized manager can edit profiles.
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* ── LIST VIEW ── */}
          {!draft && mode === "list" && (
            <>
              {canManage && (
                <div className="flex flex-wrap gap-2" data-testid="pobm-actions">
                  <button
                    onClick={() => { setDraft(emptyDraft()); setErr(""); setMsg(""); }}
                    data-testid="pobm-new"
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold"
                  >
                    <Plus className="w-3.5 h-3.5" /> New Profile
                  </button>
                  <button
                    onClick={() => { setMode("new-template"); setErr(""); setMsg(""); }}
                    data-testid="pobm-template"
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold"
                  >
                    <Copy className="w-3.5 h-3.5" /> Copy Breed Template
                  </button>
                  <button
                    onClick={() => { setMode("derive"); setErr(""); setMsg(""); }}
                    data-testid="pobm-derive"
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold"
                  >
                    <HistoryIcon className="w-3.5 h-3.5" /> Derive from Flock
                  </button>
                </div>
              )}

              {loading ? (
                <p className="text-xs text-slate-500 py-6 text-center">Loading profiles…</p>
              ) : profiles.length === 0 ? (
                <div className="text-center py-10 text-xs text-slate-500" data-testid="pobm-empty">
                  No benchmark profiles yet. Start from a breed-standard template, derive one from a
                  finished flock's real performance, or build curves by hand.
                </div>
              ) : (
                <div className="space-y-2" data-testid="pobm-list">
                  {profiles.map((p: any) => (
                    <div key={p.id} data-testid={`pobm-profile-${p.id}`} className="bg-slate-800/70 border border-slate-700/70 rounded-xl p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-xs font-bold text-white truncate">{p.name}</span>
                            {p.isDefault && <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[9px] font-bold flex items-center gap-0.5"><Star className="w-2.5 h-2.5" /> default</span>}
                            {p.source !== "MANUAL" && <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 text-[9px] font-bold">{String(p.source).toLowerCase()}</span>}
                            {p.status === "ARCHIVED" && <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 text-[9px] font-bold">archived</span>}
                          </div>
                          <div className="text-[10px] text-slate-400 mt-0.5">
                            {p.birdType}{p.breed ? ` · ${p.breed}` : ""} · {Object.keys(p.curves || {}).filter((k) => k !== "_meta").length} curve(s) · ±{p.toleranceWarnPct}%/{p.toleranceCritPct}%
                            {p.usedByFlocks?.length ? ` · used by ${p.usedByFlocks.join(", ")}` : ""}
                          </div>
                        </div>
                        {canManage && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => editExisting(p)} data-testid={`pobm-edit-${p.id}`} className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-[10px] font-bold text-white">Edit</button>
                            <button onClick={() => toggleDefault(p)} title="Toggle default for this bird type" className="px-1.5 py-1 rounded hover:bg-slate-700 text-amber-300"><Star className="w-3.5 h-3.5" /></button>
                            <button onClick={() => archive(p)} title={p.status === "ARCHIVED" ? "Restore" : "Archive"} className="px-1.5 py-1 rounded hover:bg-slate-700 text-slate-400"><Archive className="w-3.5 h-3.5" /></button>
                            <button onClick={() => setConfirmDelete(p)} data-testid={`pobm-delete-${p.id}`} className="px-1.5 py-1 rounded hover:bg-slate-700 text-rose-400"><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        )}
                      </div>
                      {confirmDelete?.id === p.id && (
                        <div className="mt-2 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2 flex items-center justify-between gap-2" data-testid="pobm-delete-confirm">
                          <span className="text-[10px] text-rose-300">Delete “{p.name}”? Flocks using it must be reassigned first.</span>
                          <div className="flex gap-1">
                            <button onClick={() => setConfirmDelete(null)} className="px-2 py-1 rounded bg-slate-700 text-[10px] text-white">Cancel</button>
                            <button onClick={() => remove(p)} disabled={busy} className="px-2 py-1 rounded bg-rose-600 text-[10px] font-bold text-white">Delete</button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <p className="text-[10px] text-slate-500 leading-relaxed pt-2">
                A <b>default</b> profile auto-matches every flock of its bird type (exact breed match wins).
                Flocks can also pin a specific profile from the Flock form. ARCHIVED profiles never auto-match.
              </p>
            </>
          )}

          {/* ── TEMPLATE PICKER ── */}
          {mode === "new-template" && !draft && (
            <div className="space-y-2" data-testid="pobm-templates">
              <p className="text-xs text-slate-400">Copy a breed-standard template, then adjust the curves to your farm's reality.</p>
              {templates.map((t: any, i: number) => (
                <button
                  key={i}
                  onClick={() => startFromTemplate(t)}
                  data-testid={`pobm-use-template-${i}`}
                  className="w-full text-left bg-slate-800/70 border border-slate-700/70 hover:border-cyan-500/60 rounded-xl p-3"
                >
                  <div className="text-xs font-bold text-white">{t.name}</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    {t.birdType} · {Object.keys(t.curves || {}).filter((k) => k !== "_meta").join(", ")}
                  </div>
                </button>
              ))}
              <button onClick={() => setMode("list")} className="text-[10px] text-slate-400 hover:text-white">← back</button>
            </div>
          )}

          {/* ── DERIVE PICKER ── */}
          {mode === "derive" && !draft && (
            <div className="space-y-2" data-testid="pobm-derive-list">
              <p className="text-xs text-slate-400">
                Turn a real flock's logged performance into a profile — “what our own flock achieved at each age”.
                Best with a finished flock that has weight, feed and production logs.
              </p>
              {flocks.length === 0 && <p className="text-xs text-slate-500 py-4 text-center">No flocks yet.</p>}
              {flocks.map((f: any) => (
                <button
                  key={f.id}
                  onClick={() => deriveFrom(f.id)}
                  disabled={busy}
                  data-testid={`pobm-derive-${f.id}`}
                  className="w-full text-left bg-slate-800/70 border border-slate-700/70 hover:border-cyan-500/60 rounded-xl p-3 disabled:opacity-50"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white font-mono">{f.batchNumber}</span>
                    <span className="text-[9px] text-slate-400">{f.birdType} · {String(f.status || "ACTIVE")}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    {f.breed || "—"} · placed {f.arrivalDate} · {f.initialCount?.toLocaleString()} birds
                  </div>
                </button>
              ))}
              <button onClick={() => setMode("list")} className="text-[10px] text-slate-400 hover:text-white">← back</button>
            </div>
          )}

          {/* ── EDITOR ── */}
          {draft && (
            <div className="space-y-4" data-testid="pobm-editor">
              <div className="grid grid-cols-2 gap-3">
                <label className="col-span-2 block">
                  <span className="block text-[10px] text-slate-500 mb-1">Profile name *</span>
                  <input data-testid="pobm-name" className={input} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Cobb 500 — Nsawam 2026 target" />
                </label>
                <label className="block">
                  <span className="block text-[10px] text-slate-500 mb-1">Bird type</span>
                  <select data-testid="pobm-birdtype" className={input} value={draft.birdType} onChange={(e) => setDraft({ ...draft, birdType: e.target.value })} disabled={!!draft.id}>
                    {BIRD_TYPES.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-[10px] text-slate-500 mb-1">Breed (optional narrowing)</span>
                  <input data-testid="pobm-breed" className={input} value={draft.breed} onChange={(e) => setDraft({ ...draft, breed: e.target.value })} placeholder="e.g. Cobb 500" />
                </label>
                <label className="block">
                  <span className="block text-[10px] text-slate-500 mb-1">WATCH tolerance %</span>
                  <input data-testid="pobm-warn" type="number" min="0.5" step="0.5" className={input} value={draft.toleranceWarnPct} onChange={(e) => setDraft({ ...draft, toleranceWarnPct: e.target.value })} />
                </label>
                <label className="block">
                  <span className="block text-[10px] text-slate-500 mb-1">OFF-TRACK tolerance %</span>
                  <input data-testid="pobm-crit" type="number" min="1" step="0.5" className={input} value={draft.toleranceCritPct} onChange={(e) => setDraft({ ...draft, toleranceCritPct: e.target.value })} />
                </label>
                <label className="block">
                  <span className="block text-[10px] text-slate-500 mb-1">Market age (days) — projection</span>
                  <input data-testid="pobm-marketage" type="number" min="21" step="1" className={input} value={draft.marketAgeDays} onChange={(e) => setDraft({ ...draft, marketAgeDays: e.target.value })} placeholder="e.g. 42" />
                </label>
                <label className="block">
                  <span className="block text-[10px] text-slate-500 mb-1">Live price / kg (default)</span>
                  <input data-testid="pobm-liveprice" type="number" min="0" step="0.5" className={input} value={draft.livePricePerKgGhs} onChange={(e) => setDraft({ ...draft, livePricePerKgGhs: e.target.value })} placeholder="e.g. 45" />
                </label>
                <label className="col-span-2 flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" data-testid="pobm-default" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} className="accent-amber-500" />
                  Default profile for this bird type (auto-matches flocks)
                </label>
                <label className="col-span-2 block">
                  <span className="block text-[10px] text-slate-500 mb-1">Notes</span>
                  <textarea data-testid="pobm-notes" className={`${input} h-16 resize-none`} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Where the numbers came from, who to ask…" />
                </label>
              </div>

              {/* Curve grids */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white">Target curves</span>
                  <div className="flex items-center gap-2">
                    <select
                      data-testid="pobm-add-metric"
                      className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-[10px]"
                      value=""
                      onChange={(e) => addMetric(e.target.value)}
                      disabled={!canManage}
                    >
                      <option value="">+ add metric…</option>
                      {addableMetrics.map((k) => (
                        <option key={k} value={k}>{METRIC_LABEL[k]?.label || k}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {metricsInUse.length === 0 && (
                  <p className="text-[11px] text-slate-500 bg-slate-800/50 border border-slate-700/60 rounded-lg p-3">
                    No curves yet — add a metric above and enter age/value points (e.g. age 7 → 0.19 kg).
                    A profile without curves only drives the tolerances and projection settings.
                  </p>
                )}

                {metricsInUse.map((key) => {
                  const c = (draft.curves as any)[key];
                  const meta = METRIC_LABEL[key] || { label: key, unit: "" };
                  return (
                    <div key={key} className="bg-slate-800/50 border border-slate-700/60 rounded-xl p-3" data-testid={`pobm-curve-${key}`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] font-bold text-slate-200">
                          {meta.label}
                          <span className="text-slate-500 font-normal"> · by {c.by === "ageWeeks" ? "age (weeks)" : "age (days)"}{meta.unit ? ` · ${meta.unit}` : ""}</span>
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => { setCsvOpenFor(csvOpenFor === key ? null : key); setCsvText(""); }}
                            title="Paste age,value lines"
                            className="px-1.5 py-1 rounded hover:bg-slate-700 text-cyan-300"
                            data-testid={`pobm-csv-${key}`}
                          >
                            <FileSpreadsheet className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => removeMetric(key)} className="px-1.5 py-1 rounded hover:bg-slate-700 text-rose-400" title="Remove curve">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      {csvOpenFor === key && (
                        <div className="mb-2">
                          <textarea
                            data-testid={`pobm-csv-input-${key}`}
                            className={`${input} h-20 font-mono text-[10px]`}
                            placeholder={"7,0.19\n14,0.47\n21,0.85"}
                            value={csvText}
                            onChange={(e) => setCsvText(e.target.value)}
                          />
                          <button onClick={() => applyCsv(key)} className="mt-1 px-2 py-1 rounded bg-cyan-600 text-[10px] font-bold text-white" data-testid={`pobm-csv-apply-${key}`}>
                            Apply CSV
                          </button>
                        </div>
                      )}
                      <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5 items-center">
                        <span className="text-[9px] uppercase text-slate-500 font-bold">{c.by === "ageWeeks" ? "Week" : "Day"}</span>
                        <span className="text-[9px] uppercase text-slate-500 font-bold">Target</span>
                        <span />
                        {c.points.map((p: [number, number], i: number) => (
                          <React.Fragment key={i}>
                            <input
                              type="number" min="0" step={c.by === "ageWeeks" ? 1 : 7}
                              className="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-white text-[11px] w-full"
                              value={p[0]}
                              onChange={(e) => setPoint(key, i, 0, e.target.value)}
                              data-testid={`pobm-pt-${key}-${i}-age`}
                            />
                            <input
                              type="number" step="0.01"
                              className="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-white text-[11px] w-full"
                              value={p[1]}
                              onChange={(e) => setPoint(key, i, 1, e.target.value)}
                              data-testid={`pobm-pt-${key}-${i}-val`}
                            />
                            <button onClick={() => removePoint(key, i)} className="p-1 rounded hover:bg-slate-700 text-slate-500 hover:text-rose-400" title="Remove point">
                              <X className="w-3 h-3" />
                            </button>
                          </React.Fragment>
                        ))}
                      </div>
                      <button onClick={() => addPoint(key)} className="mt-1.5 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-[10px] font-bold text-white" data-testid={`pobm-addpt-${key}`}>
                        + point
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {draft && canManage && (
          <div className="border-t border-slate-800 px-5 py-4 flex items-center justify-between gap-2">
            <span className="text-[10px] text-slate-500">Curves are validated on save (≥2 points, ages ≥ 0).</span>
            <div className="flex gap-2">
              <button onClick={() => { setDraft(null); setErr(""); }} className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-bold text-white" data-testid="pobm-cancel">
                Cancel
              </button>
              <button onClick={saveDraft} disabled={busy} className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white disabled:opacity-50" data-testid="pobm-save">
                <Save className="w-3.5 h-3.5" /> {draft.id ? "Save changes" : "Create profile"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
