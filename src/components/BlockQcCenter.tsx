"use client";

import React, { useMemo, useRef, useState } from "react";
import {
  ShieldCheck, AlertTriangle, Camera, RotateCcw, X, Save, Scale, Ruler,
  Gauge, Layers, TrendingUp, CheckCircle2, XCircle, Activity, Boxes, Truck,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  LineChart, Line, ComposedChart, Area, CartesianGrid, ReferenceLine,
} from "recharts";
import {
  computeBlockQc, filterQcChecks, QC_STAGES, QC_STAGE_LABELS,
  STRENGTH_STANDARD_MPA, suggestVerdict, type QcFilters,
} from "@/lib/blockQc";

interface Props {
  businessId: number;
  businessCode?: string | null;
  production: any[];
  orders: any[];
  deliveries: any[];
  inventory: any[];
  blockTypes: any[];
  qcChecks: any[];
  currentUserName?: string;
  currentUserRole?: string;
  onRefresh?: () => void;
}

const TT = { backgroundColor: "#1e293b", border: "1px solid #334155", fontSize: 11 };
const AMBER = "text-amber-400";

function Empty({ tid, children }: { tid: string; children: React.ReactNode }) {
  return (
    <p data-testid={tid} className="text-xs text-slate-500 text-center py-10">
      {children}
    </p>
  );
}

function ChartCard({ title, icon: Icon, tid, children }: { title: string; icon: any; tid: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900/60 border border-slate-700/70 rounded-xl overflow-hidden min-w-0" data-testid={tid}>
      <div className="px-4 py-2.5 border-b border-slate-700/60 flex items-center gap-2">
        <Icon className="w-4 h-4 text-amber-400" />
        <h4 className="text-xs font-bold text-white">{title}</h4>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

// Per-stage suggested tests + their required standards (tappable chips).
const STAGE_TESTS: Record<string, { test: string; standard: string; unit?: string }[]> = {
  RAW_MATERIAL: [
    { test: "Cement freshness", standard: "Fresh, lump-free cement (GS/EN 197)" },
    { test: "Sand silt content", standard: "Silt content ≤ 6%", unit: "%" },
    { test: "Sand grading", standard: "Well-graded sharp sand, free of clay lumps" },
    { test: "Water purity", standard: "Clean water — no oil, salts or organic matter" },
  ],
  MIXING: [
    { test: "Mix ratio", standard: "1:6 cement:sand (hollow) — 1:4.5 (solid/load-bearing)" },
    { test: "Mix uniformity", standard: "Uniform colour, ≥ 3 min mixing, no dry pockets" },
    { test: "Water-cement ratio", standard: "0.5 – 0.6 (ball holds together, not dripping)" },
  ],
  PRODUCTION: [
    { test: "Compaction check", standard: "Full compaction — no honeycombing" },
    { test: "Demould integrity", standard: "Sharp edges, no crumbling on demould" },
  ],
  CURING: [
    { test: "Daily curing check", standard: "Keep moist ≥ 7 days — sprinkle morning & evening" },
    { test: "Curing environment", standard: "Shaded from harsh sun and rain" },
  ],
  FINISHED_BLOCK: [
    { test: "Weight & dimensions", standard: "Within ±3 mm of mould size; type weight range" },
    { test: "Density", standard: "≥ 1800 kg/m³ (solid blocks)", unit: "kg/m3" },
    { test: "Cracks & surface", standard: "0 visible cracks; even texture, no chips" },
    { test: "Compressive strength", standard: `≥ ${STRENGTH_STANDARD_MPA} MPa (GS 1193 load-bearing)`, unit: "MPa" },
    { test: "Full inspection", standard: "All finished-block checks pass" },
  ],
};

const fmtWhen = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const dayOf = (t: any) => (t ? new Date(t).toISOString().slice(0, 10) : "-");
const timeOf = (t: any) => (t ? new Date(t).toISOString().slice(11, 16) : "");

/** Compress a picked image to a small JPEG data URL (photo evidence). */
function readPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 640;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Block Factory Quality Control centre: stage-wise QC recording (raw
 * materials → mixing → production → curing → finished blocks), Pass/Fail vs
 * required standards with photo evidence, batch pipeline linkage through
 * inventory and sales, KPIs, alerts and trend charts — filterable by branch,
 * batch, block type, date and tester.
 */
export default function BlockQcCenter({
  businessId, businessCode, production, orders, deliveries, inventory,
  blockTypes, qcChecks = [], currentUserName, currentUserRole, onRefresh,
}: Props) {
  const [fBranch, setFBranch] = useState("ALL");
  const [fBatch, setFBatch] = useState("ALL");
  const [fType, setFType] = useState("ALL");
  const [fDate, setFDate] = useState("ALL");
  const [fTester, setFTester] = useState("ALL");

  const filters: QcFilters = useMemo(
    () => ({ branchCode: fBranch, batchId: fBatch, blockType: fType, dateFilter: fDate, tester: fTester }),
    [fBranch, fBatch, fType, fDate, fTester],
  );
  const qc = useMemo(() => computeBlockQc(qcChecks, production, filters), [qcChecks, production, filters]);
  const k = qc.kpis;

  const batchOptions = useMemo(
    () => [...new Set(production.map((p) => p.batchId).filter(Boolean))].sort(),
    [production],
  );
  const typeOptions = useMemo(() => {
    const fromMaster = blockTypes.filter((t) => t.isActive !== false).map((t) => t.typeKey);
    const fromData = [...production, ...qcChecks].map((x) => x.blockType);
    return [...new Set([...fromMaster, ...fromData].filter(Boolean))].sort() as string[];
  }, [blockTypes, production, qcChecks]);
  const branchOptions = useMemo(
    () =>
      [...new Set(
        [...production, ...qcChecks, ...orders, ...deliveries]
          .map((x) => x.branchCode)
          .filter(Boolean)
          .concat(businessCode ? [businessCode] : []),
      )].sort() as string[],
    [production, qcChecks, orders, deliveries, businessCode],
  );
  const dateOptions = useMemo(
    () =>
      [...new Set(
        qcChecks.map((c) => dayOf(c.testedAt)).concat(production.map((p) => p.recordedDate)).filter((d) => d && d !== "-"),
      )].sort().reverse() as string[],
    [qcChecks, production],
  );
  const testerOptions = useMemo(
    () => [...new Set(qcChecks.map((c) => c.testerName).filter(Boolean))].sort() as string[],
    [qcChecks],
  );

  const hasCustom = fBranch !== "ALL" || fBatch !== "ALL" || fType !== "ALL" || fDate !== "ALL" || fTester !== "ALL";
  const sel =
    "w-full sm:w-auto min-w-0 max-w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-amber-500";
  const Lab = ({ children }: { children: React.ReactNode }) => (
    <label className="block text-[10px] text-slate-500 mb-1">{children}</label>
  );
  const Chip = ({ label, value, sub, tone = "amber", tid }: any) => (
    <div className="bg-slate-900/70 border border-slate-700/70 rounded-lg px-3 py-2" data-testid={tid}>
      <div className="text-[9px] uppercase font-bold text-slate-500">{label}</div>
      <div className={`text-sm font-extrabold text-${tone}-400`}>{value}</div>
      {sub && <div className="text-[9px] text-slate-500">{sub}</div>}
    </div>
  );

  // Inventory & sales linkage per block type (for the pipeline panel).
  const stockByType = useMemo(() => {
    const map: Record<string, { qty: number; status: string }> = {};
    for (const t of blockTypes) {
      const item =
        (t.sku && inventory.find((i) => (i.sku || "").toUpperCase() === String(t.sku).toUpperCase())) ||
        inventory.find((i) => (i.sku || "").toUpperCase() === `BLK-${String(t.typeKey).toUpperCase()}`);
      if (item) map[t.typeKey] = { qty: item.quantity || 0, status: item.status || "IN_STOCK" };
    }
    return map;
  }, [blockTypes, inventory]);
  const deliveredByType = useMemo(() => {
    const map: Record<string, number> = {};
    for (const d of deliveries) {
      if (d.status === "CANCELLED" || !d.blockType) continue;
      map[d.blockType] = (map[d.blockType] || 0) + (d.quantity || 0);
    }
    return map;
  }, [deliveries]);

  // ── Record QC Check modal ──────────────────────────────────────────────
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<string>("FINISHED_BLOCK");
  const [mBatch, setMBatch] = useState("");
  const [mType, setMType] = useState("");
  const [mTest, setMTest] = useState("");
  const [mStd, setMStd] = useState("");
  const [mSample, setMSample] = useState("");
  const [mResult, setMResult] = useState("");
  const [mWeight, setMWeight] = useState("");
  const [mLen, setMLen] = useState("");
  const [mWid, setMWid] = useState("");
  const [mHgt, setMHgt] = useState("");
  const [mStrength, setMStrength] = useState("");
  const [mCracks, setMCracks] = useState("");
  const [mSurface, setMSurface] = useState("");
  const [mDefects, setMDefects] = useState("");
  const [mCDay, setMCDay] = useState("");
  const [mRejected, setMRejected] = useState("");
  const [mPassFail, setMPassFail] = useState<"PASS" | "FAIL">("PASS");
  const [pfTouched, setPfTouched] = useState(false);
  const [mNotes, setMNotes] = useState("");
  const [mWhen, setMWhen] = useState(() => fmtWhen(new Date()));
  const [mTester, setMTester] = useState(currentUserName || "");
  const [mPhoto, setMPhoto] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const photoInput = useRef<HTMLInputElement | null>(null);

  const derivedDensity = useMemo(() => {
    const w = Number(mWeight), l = Number(mLen), wi = Number(mWid), h = Number(mHgt);
    return w > 0 && l > 0 && wi > 0 && h > 0
      ? Math.round((w / ((l / 1000) * (wi / 1000) * (h / 1000))) * 10) / 10
      : null;
  }, [mWeight, mLen, mWid, mHgt]);

  const suggested = useMemo(
    () =>
      suggestVerdict({
        compressiveStrengthMpa: mStrength || null,
        cracksCount: mCracks || null,
        defectsCount: mDefects || null,
        surfaceQuality: mSurface || null,
      }),
    [mStrength, mCracks, mDefects, mSurface],
  );
  const effectiveVerdict = pfTouched ? mPassFail : suggested || mPassFail;

  const pickedBatch = production.find((p) => p.batchId === mBatch);
  const openModal = () => {
    setStage("FINISHED_BLOCK");
    setMBatch(fBatch !== "ALL" ? fBatch : "");
    setMType(fType !== "ALL" ? fType : "");
    setMTest(""); setMStd(""); setMSample(""); setMResult("");
    setMWeight(""); setMLen(""); setMWid(""); setMHgt(""); setMStrength("");
    setMCracks(""); setMSurface(""); setMDefects(""); setMCDay(""); setMRejected("");
    setMPassFail("PASS"); setPfTouched(false);
    setMNotes(""); setMPhoto(""); setStatus("");
    setMWhen(fmtWhen(new Date()));
    setMTester(currentUserName || "");
    setOpen(true);
  };

  const save = async () => {
    if (!mTest.trim()) { setStatus("Pick or enter a test name."); return; }
    if (stage !== "RAW_MATERIAL" && !mBatch) { setStatus("Select the production batch this check belongs to."); return; }
    setBusy(true); setStatus("");
    try {
      const res = await fetch("/api/block-factory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity: "QC_CHECK",
          data: {
            businessId,
            batchId: mBatch || null,
            blockType: pickedBatch?.blockType || mType || null,
            stage,
            sampleRef: mSample || null,
            testName: mTest.trim(),
            requiredStandard: mStd || null,
            testResult: mResult || null,
            passFail: effectiveVerdict,
            weightKg: mWeight || null,
            lengthMm: mLen || null,
            widthMm: mWid || null,
            heightMm: mHgt || null,
            densityKgm3: derivedDensity,
            compressiveStrengthMpa: mStrength || null,
            cracksCount: mCracks || null,
            surfaceQuality: mSurface || null,
            defectsCount: mDefects || null,
            curingDays: mCDay || null,
            rejectedBlocks: mRejected || null,
            notes: mNotes || null,
            photo: mPhoto || null,
            testedAt: mWhen ? new Date(mWhen).toISOString() : undefined,
            testerName: mTester || null,
            testerRole: currentUserRole || null,
          },
        }),
      });
      const d = await res.json();
      if (d.success) {
        setStatus(`✔ ${effectiveVerdict} check saved — linked to ${d.item?.batchId || "raw materials"}`);
        onRefresh?.();
        setTimeout(() => setOpen(false), 900);
      } else {
        setStatus(d.error || "Save failed");
      }
    } finally {
      setBusy(false);
    }
  };

  const recent = useMemo(
    () => filterQcChecks(qcChecks, filters).sort((a, b) => +new Date(b.testedAt || 0) - +new Date(a.testedAt || 0)).slice(0, 12),
    [qcChecks, filters],
  );

  const showFinished = stage === "FINISHED_BLOCK";
  const showCuring = stage === "CURING";

  const input =
    "w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-amber-500";
  const MFLab = ({ children }: { children: React.ReactNode }) => (
    <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">{children}</label>
  );

  return (
    <section data-testid="bqc-root" className="space-y-4 min-w-0">
      {/* Header + actions */}
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="w-5 h-5 text-amber-400" />
        <div className="min-w-0">
          <h3 className="text-sm font-extrabold text-white">Quality Control</h3>
          <p className="text-[10px] text-slate-500">
            Raw materials → Mixing → Production → Curing → Finished blocks — Pass/Fail vs standards, photo evidence, batch linkage into stock &amp; sales
          </p>
        </div>
        <button
          data-testid="bqc-record"
          onClick={openModal}
          className="ml-auto px-3 py-2 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs rounded-lg flex items-center gap-1.5"
        >
          <ShieldCheck className="w-3.5 h-3.5" /> Record QC Check
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-end" data-testid="bqc-filters">
        <div><Lab>Branch</Lab>
          <select data-testid="bqc-filter-branch" value={fBranch} onChange={(e) => setFBranch(e.target.value)} className={sel}>
            <option value="ALL">All Branches</option>
            {branchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div><Lab>Batch</Lab>
          <select data-testid="bqc-filter-batch" value={fBatch} onChange={(e) => setFBatch(e.target.value)} className={sel}>
            <option value="ALL">All Batches</option>
            {batchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div><Lab>Block Type</Lab>
          <select data-testid="bqc-filter-btype" value={fType} onChange={(e) => setFType(e.target.value)} className={sel}>
            <option value="ALL">All Types</option>
            {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div><Lab>Date</Lab>
          <select data-testid="bqc-filter-date" value={fDate} onChange={(e) => setFDate(e.target.value)} className={sel}>
            <option value="ALL">All Time</option>
            {dateOptions.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div><Lab>Tester</Lab>
          <select data-testid="bqc-filter-tester" value={fTester} onChange={(e) => setFTester(e.target.value)} className={sel}>
            <option value="ALL">All Testers</option>
            {testerOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        {hasCustom && (
          <button
            data-testid="bqc-filter-reset"
            onClick={() => { setFBranch("ALL"); setFBatch("ALL"); setFType("ALL"); setFDate("ALL"); setFTester("ALL"); }}
            className="px-2.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg flex items-center gap-1"
          >
            <RotateCcw className="w-3 h-3" /> Reset
          </button>
        )}
      </div>

      {/* Alerts */}
      {qc.alerts.length > 0 && (
        <div data-testid="bqc-alerts" className="bg-red-950/40 border border-red-800/50 rounded-xl p-3 space-y-1.5">
          <div className="flex items-center gap-2 text-red-300 text-xs font-bold">
            <AlertTriangle className="w-3.5 h-3.5" /> QC Alerts ({qc.alerts.length})
          </div>
          {qc.alerts.slice(0, 5).map((a, i) => (
            <p key={i} className={`text-[11px] ${a.level === "critical" ? "text-red-300" : "text-amber-300"}`}>• {a.msg}</p>
          ))}
          {qc.alerts.length > 5 && <p className="text-[10px] text-slate-500">+{qc.alerts.length - 5} more…</p>}
        </div>
      )}

      {/* KPI chips */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        <Chip tid="bqc-kpi-checks" label="QC Checks" value={k.checksTotal} sub={`${k.passCount} pass · ${k.failCount} fail`} tone="amber" />
        <Chip tid="bqc-kpi-passrate" label="Pass Rate" value={`${k.passRatePct}%`} sub="of all checks" tone={k.passRatePct >= 80 ? "emerald" : k.passRatePct >= 50 ? "amber" : "red"} />
        <Chip tid="bqc-kpi-passed-batches" label="Batches Passed" value={k.passedBatches} sub={`${k.batchesAwaitingQc} awaiting QC`} tone="emerald" />
        <Chip tid="bqc-kpi-failed-batches" label="Batches Failed" value={k.failedBatches} sub="held from sales" tone={k.failedBatches > 0 ? "red" : "slate"} />
        <Chip tid="bqc-kpi-defectrate" label="Defect Rate" value={`${k.checkFailRatePct}%`} sub={`${k.defectsTotal + k.cracksTotal} defects+cracks`} tone={k.checkFailRatePct > 20 ? "red" : "amber"} />
        <Chip tid="bqc-kpi-rejected" label="Rejected Blocks" value={k.rejectedBlocks} sub={k.rejectedRatePct ? `${k.rejectedRatePct}% of molded` : "condemned"} tone={k.rejectedBlocks > 0 ? "red" : "slate"} />
        <Chip tid="bqc-kpi-strength" label="Avg Strength" value={k.avgStrengthMpa ? `${k.avgStrengthMpa} MPa` : "—"} sub={k.avgStrengthMpa ? (k.avgStrengthMpa >= STRENGTH_STANDARD_MPA ? `≥ ${STRENGTH_STANDARD_MPA} MPa ✓` : `below ${STRENGTH_STANDARD_MPA} MPa!`) : "no crush tests"} tone={k.avgStrengthMpa >= STRENGTH_STANDARD_MPA && k.avgStrengthMpa > 0 ? "emerald" : k.avgStrengthMpa > 0 ? "red" : "slate"} />
        <Chip tid="bqc-kpi-weightvar" label="Weight Variation" value={k.weightVariationPct ? `${k.weightVariationPct}%` : "—"} sub={k.avgWeightKg ? `avg ${k.avgWeightKg} kg` : "no weighings"} tone={k.weightVariationPct > 10 ? "red" : "cyan"} />
      </div>

      {/* Batch pipeline: Production → Curing → QC → Inventory → Sales */}
      <div className="bg-slate-900/60 border border-slate-700/70 rounded-xl overflow-hidden" data-testid="bqc-pipeline">
        <div className="px-4 py-2.5 border-b border-slate-700/60 flex items-center gap-2">
          <Layers className="w-4 h-4 text-amber-400" />
          <h4 className="text-xs font-bold text-white">Batch Pipeline — Production → Curing → QC → Inventory → Sales/Delivery</h4>
        </div>
        <div className="p-3 overflow-x-auto">
          {qc.batches.length === 0 ? (
            <Empty tid="bqc-empty-pipeline">No production batches in this scope yet.</Empty>
          ) : (
            <table className="w-full text-[11px] min-w-[760px]">
              <thead>
                <tr className="text-left text-slate-500 uppercase text-[9px]">
                  <th className="pb-2 pr-3">Batch</th>
                  <th className="pb-2 pr-3">Type</th>
                  <th className="pb-2 pr-3">Molded</th>
                  <th className="pb-2 pr-3">Curing</th>
                  <th className="pb-2 pr-3">QC Status</th>
                  <th className="pb-2 pr-3">Avg Strength</th>
                  <th className="pb-2 pr-3">Rejected</th>
                  <th className="pb-2 pr-3">Inventory</th>
                  <th className="pb-2">Sales/Delivery</th>
                </tr>
              </thead>
              <tbody>
                {qc.batches.map((b) => {
                  const stock = b.blockType ? stockByType[b.blockType] : undefined;
                  const delivered = b.blockType ? deliveredByType[b.blockType] || 0 : 0;
                  const st = b.status;
                  return (
                    <tr key={b.batchId} data-testid={`bqc-pipeline-${b.batchId}`} className="border-t border-slate-800 text-slate-300">
                      <td className="py-2 pr-3 font-bold text-white">{b.batchId}<div className="text-[9px] font-normal text-slate-500">{b.recordedDate || ""}</div></td>
                      <td className="py-2 pr-3">{b.blockType || "—"}</td>
                      <td className="py-2 pr-3">{b.molded ?? "—"}{b.molded != null && <span className="text-slate-500"> ({b.broken || 0} broken)</span>}</td>
                      <td className="py-2 pr-3">{b.cured ? <span className="text-emerald-400 font-bold">✓ moist</span> : <span className="text-slate-600">—</span>}</td>
                      <td className="py-2 pr-3">
                        <span data-testid={`bqc-status-${b.batchId}`} className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${
                          st === "PASSED" ? "bg-emerald-500/15 text-emerald-400" :
                          st === "FAILED" ? "bg-red-500/15 text-red-400" :
                          st === "IN_QC" ? "bg-amber-500/15 text-amber-400" : "bg-slate-700/40 text-slate-500"}`}>
                          {st === "IN_QC" ? "IN QC" : st.replace("_", " ")}
                        </span>
                        <div className="text-[9px] text-slate-500 mt-0.5">{b.checks} checks · {b.passed}P/{b.failed}F</div>
                      </td>
                      <td className="py-2 pr-3">{b.avgStrengthMpa != null ? `${b.avgStrengthMpa} MPa` : "—"}</td>
                      <td className="py-2 pr-3">{b.rejected > 0 ? <span className="text-red-400 font-bold">{b.rejected}</span> : "0"}</td>
                      <td className="py-2 pr-3">{stock ? `${stock.qty} in stock` : "—"}</td>
                      <td className="py-2">{delivered > 0 ? `${delivered} delivered` : <span className="text-slate-600">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Charts */}
      <div className="grid gap-3 md:grid-cols-2 min-w-0">
        <ChartCard tid="bqc-chart-passfail" icon={CheckCircle2} title="Pass / Fail by Stage">
          {qc.passFailByStage.every((s) => s.checks === 0) ? (
            <Empty tid="bqc-empty-passfail">No QC checks in this scope yet — record your first check.</Empty>
          ) : (
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={qc.passFailByStage} margin={{ top: 4, right: 6, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="stage" tick={{ fontSize: 9, fill: "#94a3b8" }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 9, fill: "#94a3b8" }} />
                <Tooltip contentStyle={TT} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar dataKey="pass" name="Pass" stackId="v" fill="#10b981" radius={[0, 0, 0, 0]} />
                <Bar dataKey="fail" name="Fail" stackId="v" fill="#ef4444" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard tid="bqc-chart-strength" icon={Gauge} title={`Compressive Strength (MPa) vs ${STRENGTH_STANDARD_MPA} MPa Standard`}>
          {qc.strengthDaily.length === 0 ? (
            <Empty tid="bqc-empty-strength">No strength tests yet — record a FINISHED BLOCK check with compressive strength.</Empty>
          ) : (
            <ResponsiveContainer width="100%" height={210}>
              <ComposedChart data={qc.strengthDaily} margin={{ top: 4, right: 6, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#94a3b8" }} />
                <YAxis tick={{ fontSize: 9, fill: "#94a3b8" }} />
                <Tooltip contentStyle={TT} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <ReferenceLine y={STRENGTH_STANDARD_MPA} stroke="#f59e0b" strokeDasharray="6 3" label={{ value: "standard", fontSize: 9, fill: "#f59e0b", position: "insideTopRight" }} />
                <Area dataKey="avgMpa" name="Avg strength" stroke="#10b981" fill="#10b98133" />
                <Line dataKey="minMpa" name="Weakest sample" stroke="#ef4444" dot={{ r: 2 }} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard tid="bqc-chart-weight" icon={Scale} title="Block Weight (kg) — avg / min / max">
          {qc.weightDaily.length === 0 ? (
            <Empty tid="bqc-empty-weight">No weighings in this scope — weigh blocks in a finished-block check.</Empty>
          ) : (
            <ResponsiveContainer width="100%" height={210}>
              <ComposedChart data={qc.weightDaily} margin={{ top: 4, right: 6, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#94a3b8" }} />
                <YAxis tick={{ fontSize: 9, fill: "#94a3b8" }} />
                <Tooltip contentStyle={TT} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Area dataKey="maxKg" name="Max" stroke="#64748b" fill="#64748b22" />
                <Area dataKey="avgKg" name="Avg" stroke="#f59e0b" fill="#f59e0b33" />
                <Line dataKey="minKg" name="Min" stroke="#06b6d4" dot={{ r: 2 }} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard tid="bqc-chart-defects" icon={XCircle} title="Failure Pareto — checks that failed, by test">
          {qc.defectBreakdown.length === 0 ? (
            <Empty tid="bqc-empty-defects">No failed checks in this scope — clean run.</Empty>
          ) : (
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={qc.defectBreakdown} layout="vertical" margin={{ top: 4, right: 10, left: 6, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 9, fill: "#94a3b8" }} />
                <YAxis type="category" dataKey="test" width={120} tick={{ fontSize: 9, fill: "#94a3b8" }} />
                <Tooltip contentStyle={TT} />
                <Bar dataKey="fails" name="Failed checks" fill="#ef4444" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard tid="bqc-chart-trend" icon={TrendingUp} title="Quality Trend — daily pass rate (%)">
          {qc.qualityTrendDaily.length === 0 ? (
            <Empty tid="bqc-empty-trend">Record checks on different days to see the trend.</Empty>
          ) : (
            <ResponsiveContainer width="100%" height={210}>
              <LineChart data={qc.qualityTrendDaily} margin={{ top: 4, right: 6, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#94a3b8" }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#94a3b8" }} />
                <Tooltip contentStyle={TT} formatter={(v: any, n: any) => (n === "Pass rate" ? [`${v}%`, n] : [v, n])} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Line dataKey="passRate" name="Pass rate" stroke="#f59e0b" dot={{ r: 3 }} strokeWidth={2} />
                <Line dataKey="checks" name="Checks done" stroke="#475569" dot={false} yAxisId={0} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>

      {/* Recent checks */}
      <div className="bg-slate-900/60 border border-slate-700/70 rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-700/60 flex items-center gap-2">
          <Activity className="w-4 h-4 text-amber-400" />
          <h4 className="text-xs font-bold text-white">Recent QC Checks</h4>
        </div>
        <div className="p-3 overflow-x-auto" data-testid="bqc-recent">
          {recent.length === 0 ? (
            <Empty tid="bqc-empty-recent">No QC checks recorded yet — tap “Record QC Check”.</Empty>
          ) : (
            <table className="w-full text-[11px] min-w-[860px]">
              <thead>
                <tr className="text-left text-slate-500 uppercase text-[9px]">
                  <th className="pb-2 pr-3">Date / Time</th>
                  <th className="pb-2 pr-3">Stage</th>
                  <th className="pb-2 pr-3">Batch</th>
                  <th className="pb-2 pr-3">Test</th>
                  <th className="pb-2 pr-3">Result vs Standard</th>
                  <th className="pb-2 pr-3">Verdict</th>
                  <th className="pb-2 pr-3">Tester</th>
                  <th className="pb-2">Photo</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((c) => (
                  <tr key={c.id} className="border-t border-slate-800 text-slate-300">
                    <td className="py-2 pr-3 whitespace-nowrap">{dayOf(c.testedAt)} <span className="text-slate-500">{timeOf(c.testedAt)}</span></td>
                    <td className="py-2 pr-3">{QC_STAGE_LABELS[c.stage] || c.stage}</td>
                    <td className="py-2 pr-3">{c.batchId || <span className="text-slate-600">raw</span>}</td>
                    <td className="py-2 pr-3 max-w-[180px]"><span className="block truncate" title={c.testName}>{c.testName}</span>{c.sampleRef && <span className="block text-[9px] text-slate-500 truncate" title={c.sampleRef}>{c.sampleRef}</span>}</td>
                    <td className="py-2 pr-3">
                      {c.testResult || (c.compressiveStrengthMpa != null ? `${c.compressiveStrengthMpa} MPa` : c.weightKg != null ? `${c.weightKg} kg` : "—")}
                      {c.requiredStandard && <span className="block text-[9px] text-slate-500 max-w-[220px] truncate" title={c.requiredStandard}>std: {c.requiredStandard}</span>}
                    </td>
                    <td className="py-2 pr-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${c.passFail === "PASS" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
                        {c.passFail}
                      </span>
                    </td>
                    <td className="py-2 pr-3">{c.testerName || "—"}</td>
                    <td className="py-2">{c.photo ? <Camera className="w-3.5 h-3.5 text-amber-400" /> : <span className="text-slate-700">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Record QC Check modal ── */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4" data-testid="bqcm-modal">
          <div className="w-full max-w-lg max-h-[92vh] overflow-y-auto bg-slate-950 border border-slate-700 rounded-t-2xl sm:rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-amber-400" /> Record QC Check
              </h3>
              <button data-testid="bqcm-close" onClick={() => setOpen(false)} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"><X className="w-4 h-4" /></button>
            </div>

            {/* Stage chips */}
            <div>
              <MFLab>QC Stage</MFLab>
              <div className="flex flex-wrap gap-1.5">
                {QC_STAGES.map((s) => (
                  <button
                    key={s}
                    data-testid={`bqcm-stage-${s}`}
                    onClick={() => setStage(s)}
                    className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold ${stage === s ? "bg-amber-500 text-slate-950" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
                  >
                    {QC_STAGE_LABELS[s]}
                  </button>
                ))}
              </div>
            </div>

            {/* Batch + type */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <MFLab>Production Batch {stage === "RAW_MATERIAL" ? "(optional)" : ""}</MFLab>
                <select data-testid="bqcm-batch" value={mBatch} onChange={(e) => { setMBatch(e.target.value); const b = production.find((p) => p.batchId === e.target.value); if (b) setMType(b.blockType); }} className={input}>
                  <option value="">— none / raw materials —</option>
                  {batchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              <div>
                <MFLab>Block Type</MFLab>
                <select data-testid="bqcm-btype" value={pickedBatch?.blockType || mType} onChange={(e) => setMType(e.target.value)} disabled={!!pickedBatch} className={input}>
                  <option value="">— unknown —</option>
                  {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>
            {pickedBatch && (
              <p data-testid="bqcm-info" className="text-[10px] text-amber-300/90 bg-amber-500/10 border border-amber-700/40 rounded-lg px-2.5 py-1.5">
                Linked to batch {pickedBatch.batchId} · {pickedBatch.blockType} · molded {pickedBatch.blocksMolded} on {pickedBatch.recordedDate}
              </p>
            )}

            {/* Test + standard */}
            <div>
              <MFLab>Test</MFLab>
              <input data-testid="bqcm-test" value={mTest} onChange={(e) => setMTest(e.target.value)} placeholder="e.g. Compressive strength" className={input} />
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {(STAGE_TESTS[stage] || []).map((t, i) => (
                  <button
                    key={t.test}
                    data-testid={`bqcm-suggest-${i}`}
                    onClick={() => { setMTest(t.test); setMStd(t.standard); }}
                    className="px-2 py-1 rounded-md text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
                    title={t.standard}
                  >
                    {t.test}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <MFLab>Required Standard</MFLab>
                <input data-testid="bqcm-std" value={mStd} onChange={(e) => setMStd(e.target.value)} placeholder={`e.g. ≥ ${STRENGTH_STANDARD_MPA} MPa (GS 1193)`} className={input} />
              </div>
              <div>
                <MFLab>Sample</MFLab>
                <input data-testid="bqcm-sample" value={mSample} onChange={(e) => setMSample(e.target.value)} placeholder="e.g. 3 blocks from east stack" className={input} />
              </div>
            </div>
            <div>
              <MFLab>Test Result</MFLab>
              <input data-testid="bqcm-result" value={mResult} onChange={(e) => setMResult(e.target.value)} placeholder="e.g. 4.2 MPa — uniform crush pattern" className={input} />
            </div>

            {/* Finished-block metric panel */}
            {showFinished && (
              <div className="border border-slate-700/80 rounded-xl p-3 space-y-2 bg-slate-900/40">
                <p className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1.5"><Ruler className="w-3 h-3" /> Measurements (optional — fill what you test)</p>
                <div className="grid grid-cols-3 gap-2">
                  <div><MFLab>Weight (kg)</MFLab><input data-testid="bqcm-weight" type="number" step="any" value={mWeight} onChange={(e) => setMWeight(e.target.value)} className={input} placeholder="18.1" /></div>
                  <div><MFLab>Length (mm)</MFLab><input data-testid="bqcm-length" type="number" step="any" value={mLen} onChange={(e) => setMLen(e.target.value)} className={input} placeholder="450" /></div>
                  <div><MFLab>Width (mm)</MFLab><input data-testid="bqcm-width" type="number" step="any" value={mWid} onChange={(e) => setMWid(e.target.value)} className={input} placeholder="225" /></div>
                  <div><MFLab>Height (mm)</MFLab><input data-testid="bqcm-height" type="number" step="any" value={mHgt} onChange={(e) => setMHgt(e.target.value)} className={input} placeholder="150" /></div>
                  <div>
                    <MFLab>Density (kg/m³)</MFLab>
                    <input data-testid="bqcm-density" value={derivedDensity != null ? String(derivedDensity) : ""} readOnly className={`${input} opacity-70`} placeholder="auto" />
                  </div>
                  <div><MFLab>Strength (MPa)</MFLab><input data-testid="bqcm-strength" type="number" step="any" value={mStrength} onChange={(e) => setMStrength(e.target.value)} className={input} placeholder="3.5+" /></div>
                  <div><MFLab>Cracks (count)</MFLab><input data-testid="bqcm-cracks" type="number" value={mCracks} onChange={(e) => setMCracks(e.target.value)} className={input} placeholder="0" /></div>
                  <div>
                    <MFLab>Surface</MFLab>
                    <select data-testid="bqcm-surface" value={mSurface} onChange={(e) => setMSurface(e.target.value)} className={input}>
                      <option value="">— rate —</option>
                      <option value="GOOD">Good</option>
                      <option value="FAIR">Fair</option>
                      <option value="POOR">Poor</option>
                    </select>
                  </div>
                  <div><MFLab>Defects (count)</MFLab><input data-testid="bqcm-defects" type="number" value={mDefects} onChange={(e) => setMDefects(e.target.value)} className={input} placeholder="0" /></div>
                  <div><MFLab>Rejected blocks</MFLab><input data-testid="bqcm-rejected" type="number" value={mRejected} onChange={(e) => setMRejected(e.target.value)} className={input} placeholder="0" /></div>
                </div>
              </div>
            )}
            {showCuring && (
              <div>
                <MFLab>Curing Day Number</MFLab>
                <input data-testid="bqcm-cday" type="number" value={mCDay} onChange={(e) => setMCDay(e.target.value)} className={input} placeholder="e.g. 4 (need ≥ 7 moist days)" />
              </div>
            )}
            {showFinished && (
              <div>
                <MFLab>Rejected Blocks</MFLab>
                <input data-testid="bqcm-rejected-top" type="number" value={mRejected} onChange={(e) => setMRejected(e.target.value)} className={input} placeholder="0" />
              </div>
            )}

            {/* Verdict */}
            <div>
              <MFLab>Pass / Fail {suggested && !pfTouched ? <span className="normal-case font-normal text-slate-500">(suggested: {suggested})</span> : null}</MFLab>
              <div className="flex gap-2">
                <button data-testid="bqcm-pass" onClick={() => { setMPassFail("PASS"); setPfTouched(true); }}
                  className={`flex-1 py-2 rounded-lg text-xs font-extrabold ${effectiveVerdict === "PASS" ? "bg-emerald-500 text-slate-950" : "bg-slate-800 text-slate-400 hover:bg-slate-700"}`}>
                  ✓ PASS
                </button>
                <button data-testid="bqcm-fail" onClick={() => { setMPassFail("FAIL"); setPfTouched(true); }}
                  className={`flex-1 py-2 rounded-lg text-xs font-extrabold ${effectiveVerdict === "FAIL" ? "bg-red-500 text-white" : "bg-slate-800 text-slate-400 hover:bg-slate-700"}`}>
                  ✗ FAIL
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <MFLab>Date &amp; Time</MFLab>
                <input data-testid="bqcm-when" type="datetime-local" value={mWhen} onChange={(e) => setMWhen(e.target.value)} className={input} />
              </div>
              <div>
                <MFLab>Tester</MFLab>
                <input data-testid="bqcm-tester" value={mTester} onChange={(e) => setMTester(e.target.value)} className={input} placeholder="Who performed the check" />
              </div>
            </div>
            <div>
              <MFLab>Notes</MFLab>
              <textarea data-testid="bqcm-notes" value={mNotes} onChange={(e) => setMNotes(e.target.value)} rows={2} className={input} placeholder="Observations, weather, machine used, follow-ups…" />
            </div>

            {/* Photo evidence */}
            <div>
              <MFLab>Photo Evidence</MFLab>
              <input ref={photoInput} data-testid="bqcm-photo" type="file" accept="image/*" className="hidden"
                onChange={async (e) => { const f = e.target.files?.[0]; if (f) setMPhoto(await readPhoto(f)); }} />
              {mPhoto ? (
                <div className="flex items-center gap-3">
                  <img data-testid="bqcm-photo-preview" src={mPhoto} alt="QC evidence" className="w-16 h-16 rounded-lg object-cover border border-amber-600/50" />
                  <button onClick={() => { setMPhoto(""); if (photoInput.current) photoInput.current.value = ""; }} className="text-[11px] text-red-400 hover:underline">remove</button>
                </div>
              ) : (
                <button data-testid="bqcm-photo-btn" onClick={() => photoInput.current?.click()}
                  className="w-full py-2.5 border border-dashed border-slate-600 rounded-lg text-slate-400 text-xs hover:border-amber-500 hover:text-amber-300 flex items-center justify-center gap-2">
                  <Camera className="w-3.5 h-3.5" /> Add photo of the sample / test
                </button>
              )}
            </div>

            {status && <p data-testid="bqcm-status" className="text-[11px] text-amber-300">{status}</p>}
            <button
              data-testid="bqcm-save"
              onClick={save}
              disabled={busy}
              className="w-full py-2.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-slate-950 font-extrabold text-sm rounded-lg flex items-center justify-center gap-2"
            >
              <Save className="w-4 h-4" /> {busy ? "Saving…" : "Save QC Check"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
