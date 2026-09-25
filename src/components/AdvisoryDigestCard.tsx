"use client";

import React from "react";
import { Activity, Brain, CheckCircle2, Gauge, Loader2, Sparkles, TrendingUp, TriangleAlert } from "lucide-react";

/** Benchmark + digest read-out shared by the Advisor workspace and the Owner's
 *  Advisory view. Pure presentation of /api/advisor/data → digest. */

const STATUS_STYLE: Record<string, string> = {
  GOOD: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  WATCH: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  BAD: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  UNKNOWN: "border-slate-700 bg-slate-800/50 text-slate-400",
};

const SEV_STYLE: Record<string, string> = {
  INFO: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  WATCH: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  URGENT: "border-rose-500/40 bg-rose-500/10 text-rose-200",
};

export default function AdvisoryDigestCard({
  digest,
  loading,
  onGenerate,
  generating,
  canPublish,
}: {
  digest: any;
  loading?: boolean;
  onGenerate?: () => void;
  generating?: boolean;
  canPublish?: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-slate-700 bg-slate-900/60 p-5 text-[12px] text-slate-400" data-testid="adv-digest-loading">
        <Loader2 className="h-4 w-4 animate-spin" /> Building the advisory digest…
      </div>
    );
  }
  if (!digest) return null;

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900/60 overflow-hidden" data-testid="adv-digest">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-700/70 bg-slate-800/70 px-4 sm:px-5 py-3.5">
        <Brain className="h-4 w-4 text-violet-300" />
        <h4 className="text-[13px] font-extrabold text-white">GoMina AI — Advisory Digest</h4>
        <span className={`rounded-md border px-1.5 py-0.5 text-[9px] font-black ${SEV_STYLE[digest.severity] || SEV_STYLE.INFO}`} data-testid="adv-digest-severity">
          {digest.severity}
        </span>
        {canPublish && onGenerate && (
          <button
            type="button"
            onClick={onGenerate}
            disabled={generating}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-violet-600 px-2.5 py-1.5 text-[10px] font-black text-white hover:bg-violet-500 disabled:opacity-50"
            data-testid="adv-digest-generate"
          >
            {generating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Publish digest to Owner
          </button>
        )}
      </div>

      <div className="space-y-4 p-4">
        <div>
          <p className="text-[12.5px] font-extrabold text-white" data-testid="adv-digest-headline">{digest.headline}</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-slate-300" data-testid="adv-digest-summary">{digest.summary}</p>
          <p className="mt-1 text-[9.5px] font-bold uppercase tracking-wider text-slate-500">
            {digest.fromDate} → {digest.toDate} · {digest.noteCount} advisor note(s) · {digest.flockCount} flock(s)
          </p>
        </div>

        {/* Benchmarks */}
        <div>
          <h5 className="mb-1.5 flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-slate-400">
            <Gauge className="h-3 w-3" /> Benchmark performance
          </h5>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3" data-testid="adv-digest-metrics">
            {(digest.metrics || []).map((m: any) => (
              <div key={m.key} className={`rounded-xl border p-2.5 ${STATUS_STYLE[m.status] || STATUS_STYLE.UNKNOWN}`} data-testid={`adv-metric-${m.key}`}>
                <p className="text-[9.5px] font-bold uppercase tracking-wide opacity-80">{m.label}</p>
                <p className="mt-0.5 text-[15px] font-black">
                  {m.actual == null ? "—" : m.actual}
                  <span className="ml-0.5 text-[10px] font-bold opacity-70">{m.unit}</span>
                </p>
                <p className="text-[9.5px] opacity-80">target {m.target ?? "—"}{m.unit}</p>
                <p className="mt-1 text-[9px] leading-snug opacity-70">{m.comment}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Concerns */}
        {digest.concerns?.length > 0 && (
          <div>
            <h5 className="mb-1.5 flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-slate-400">
              <TriangleAlert className="h-3 w-3 text-amber-300" /> Concerns
            </h5>
            <ul className="space-y-1" data-testid="adv-digest-concerns">
              {digest.concerns.map((c: string, i: number) => (
                <li key={i} className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-100">{c}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Findings with corroboration */}
        {digest.findings?.length > 0 && (
          <div>
            <h5 className="mb-1.5 flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-slate-400">
              <Activity className="h-3 w-3 text-cyan-300" /> Advisor findings vs farm data
            </h5>
            <div className="space-y-1.5" data-testid="adv-digest-findings">
              {digest.findings.slice(0, 6).map((f: any) => (
                <div key={f.noteId} className="rounded-lg border border-slate-700 bg-slate-950/50 px-2.5 py-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-bold text-white">{f.title}</span>
                    <span className="text-[9px] font-bold text-slate-500">{f.observationDate}</span>
                    <span
                      className={`ml-auto rounded-md px-1.5 py-0.5 text-[9px] font-black ${
                        f.corroboration === "CONFIRMED_BY_DATA"
                          ? "bg-rose-500/20 text-rose-300"
                          : f.corroboration === "PARTIALLY_SUPPORTED"
                            ? "bg-amber-500/20 text-amber-300"
                            : "bg-slate-700 text-slate-300"
                      }`}
                      data-testid={`adv-finding-corr-${f.noteId}`}
                    >
                      {f.corroboration.replace(/_/g, " ").toLowerCase()}
                    </span>
                  </div>
                  {f.evidence?.length > 0 && <p className="mt-0.5 text-[10px] text-slate-400">{f.evidence[0]}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recommendations */}
        <div>
          <h5 className="mb-1.5 flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-slate-400">
            <TrendingUp className="h-3 w-3 text-emerald-300" /> What GoMina AI recommends
          </h5>
          <ul className="space-y-1" data-testid="adv-digest-recommendations">
            {(digest.recommendations || []).map((r: string, i: number) => (
              <li key={i} className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-1.5 text-[11px] text-emerald-100">{r}</li>
            ))}
          </ul>
        </div>

        {/* Adoption */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="adv-digest-adoption">
          {[
            { label: "Follow-ups", value: digest.adoption?.totalActionable ?? 0 },
            { label: "Closed", value: digest.adoption?.closed ?? 0 },
            { label: "Adoption", value: `${digest.adoption?.adoptionRatePct ?? 0}%` },
            { label: "Overdue", value: digest.adoption?.overdue ?? 0 },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-slate-700 bg-slate-950/50 p-2.5 text-center">
              <p className="text-[9.5px] font-bold uppercase tracking-wide text-slate-500">{s.label}</p>
              <p className="text-[15px] font-black text-white">{s.value}</p>
            </div>
          ))}
        </div>
        {digest.adoption?.medianDaysToClose != null && (
          <p className="flex items-center gap-1 text-[10px] font-bold text-slate-400">
            <CheckCircle2 className="h-3 w-3 text-emerald-300" /> Median time to close advice: {digest.adoption.medianDaysToClose} day(s)
          </p>
        )}
      </div>
    </section>
  );
}
