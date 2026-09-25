"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bird,
  CalendarClock,
  ClipboardCheck,
  Droplets,
  Egg,
  HeartPulse,
  Loader2,
  LogOut,
  MapPin,
  NotebookPen,
  ShieldCheck,
  Stethoscope,
  Wheat,
} from "lucide-react";
import AdvisoryDigestCard from "./AdvisoryDigestCard";
import AdvisoryNotesPanel from "./AdvisoryNotesPanel";

/**
 * AdvisorWorkspace — the external Farm Advisor's entire application.
 *
 * READ-ONLY by construction: it renders farm data from /api/advisor/data,
 * which the server has already narrowed to the advisor's grant (farm, branch,
 * flocks, scopes) and stripped of money unless COSTS was granted. The only
 * write affordance on the whole screen is the advisory note composer (and the
 * visit log) — every other API route refuses this role centrally.
 */

type Tab = "OVERVIEW" | "FLOCKS" | "FEED_WATER" | "HEALTH" | "PRODUCTION" | "CHECKLIST" | "NOTES" | "VISITS";

const TABS: { key: Tab; label: string; icon: any; scope?: string }[] = [
  { key: "OVERVIEW", label: "Overview", icon: ShieldCheck },
  { key: "FLOCKS", label: "Flocks", icon: Bird, scope: "FLOCKS" },
  { key: "FEED_WATER", label: "Feed & Water", icon: Wheat, scope: "FEED_WATER" },
  { key: "HEALTH", label: "Health", icon: HeartPulse, scope: "MORTALITY_HEALTH" },
  { key: "PRODUCTION", label: "Production", icon: Egg, scope: "PRODUCTION" },
  { key: "CHECKLIST", label: "Daily ops", icon: ClipboardCheck, scope: "DAILY_OPS" },
  { key: "NOTES", label: "My notes", icon: NotebookPen },
  { key: "VISITS", label: "Visits", icon: CalendarClock },
];

const Table = ({ head, rows, testid }: { head: string[]; rows: (string | number | null | undefined)[][]; testid: string }) => (
  <div className="overflow-x-auto rounded-xl border border-slate-700" data-testid={testid}>
    <table className="w-full min-w-[520px] text-left text-[11px]">
      <thead className="bg-slate-800/80 text-[9.5px] uppercase tracking-wide text-slate-400">
        <tr>{head.map((h) => <th key={h} className="px-2.5 py-2 font-black">{h}</th>)}</tr>
      </thead>
      <tbody className="divide-y divide-slate-800">
        {rows.length === 0 ? (
          <tr><td colSpan={head.length} className="px-2.5 py-4 text-center text-slate-500">No records in scope.</td></tr>
        ) : rows.map((r, i) => (
          <tr key={i} className="text-slate-300">
            {r.map((c, j) => <td key={j} className="px-2.5 py-1.5">{c ?? "—"}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export default function AdvisorWorkspace({
  currentUser,
  businesses,
  onLogout,
}: {
  currentUser: any;
  businesses: any[];
  onLogout?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("OVERVIEW");
  const [businessId, setBusinessId] = useState<number | null>(businesses?.[0]?.id ?? null);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [visits, setVisits] = useState<any[]>([]);
  const [visitSummary, setVisitSummary] = useState("");
  const [visitType, setVisitType] = useState("ON_SITE");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!businessId && businesses?.length) setBusinessId(businesses[0].id);
  }, [businesses, businessId]);

  const load = useCallback(async () => {
    if (!businessId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [d, v] = await Promise.all([
        fetch(`/api/advisor/data?businessId=${businessId}&windowDays=30`).then((r) => r.json()),
        fetch(`/api/advisor/visits?businessId=${businessId}`).then((r) => r.json()),
      ]);
      if (d.success) { setData(d); setError(""); } else setError(d.error || "Could not load farm data.");
      if (v.success) setVisits(v.visits || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => { load(); }, [load]);

  const grant = data?.grant;
  const hasScope = (s: string) => !grant || (grant.scopes || []).includes(s);
  const visibleTabs = TABS.filter((t) => !t.scope || hasScope(t.scope));

  const publishDigest = async () => {
    if (!businessId) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/advisor/digest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, windowDays: 30, publish: true }),
      });
      const d = await res.json();
      if (!d.success) setError(d.error || "Could not publish the digest.");
      else { setData((p: any) => ({ ...p, digest: d.digest })); setError(""); }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  };

  const logVisit = async (status: "PLANNED" | "COMPLETED") => {
    if (!businessId || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/advisor/visits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          visitType,
          status,
          actualDate: status === "COMPLETED" ? new Date().toLocaleDateString("en-CA") : null,
          plannedDate: status === "PLANNED" ? new Date().toLocaleDateString("en-CA") : null,
          summary: visitSummary,
        }),
      });
      const d = await res.json();
      if (!d.success) setError(d.error || "Could not log the visit.");
      else { setVisitSummary(""); await load(); }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const biz = data?.business;
  const flocks = useMemo(() => data?.flocks || [], [data]);
  const kpi = useMemo(() => {
    const m = (k: string) => (data?.digest?.metrics || []).find((x: any) => x.key === k);
    const birds = flocks.filter((f: any) => String(f.status || "ACTIVE") === "ACTIVE").reduce((s: number, f: any) => s + Number(f.currentCount || 0), 0);
    return [
      { label: "Birds on farm", value: birds.toLocaleString(), tone: "text-white" },
      { label: "Mortality", value: m("MORTALITY")?.actual != null ? `${m("MORTALITY").actual}%` : "—", tone: m("MORTALITY")?.status === "BAD" ? "text-rose-300" : "text-emerald-300" },
      { label: "FCR", value: m("FCR")?.actual ?? "—", tone: m("FCR")?.status === "BAD" ? "text-rose-300" : "text-emerald-300" },
      { label: "Health score", value: data?.healthScore != null ? `${data.healthScore}/100` : "—", tone: "text-cyan-300" },
    ];
  }, [data, flocks]);

  if (!businesses?.length) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center p-6" data-testid="advisor-no-access">
        <div className="max-w-md space-y-3 rounded-2xl border border-amber-500/30 bg-amber-900/20 p-8 text-center">
          <Stethoscope className="mx-auto h-8 w-8 text-amber-300" />
          <h2 className="text-lg font-bold text-amber-200">No active advisory access</h2>
          <p className="text-sm text-slate-300">
            Your Farm Advisor account has no live grant right now. The farm Owner controls which farms, branches and
            records you may review, and for how long. Ask them to grant or renew your access.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-3 sm:p-5" data-testid="advisor-workspace">
      {/* Header */}
      <header className="rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-slate-900 to-slate-950 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Stethoscope className="h-5 w-5 text-cyan-300" />
          <h1 className="text-[15px] font-black text-white">Farm Advisor workspace</h1>
          <span className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[9.5px] font-black uppercase tracking-wider text-cyan-300" data-testid="advisor-readonly-chip">
            Read-only access
          </span>
          {grant?.endsOn && (
            <span className="rounded-md bg-slate-800 px-2 py-0.5 text-[9.5px] font-bold text-slate-300" data-testid="advisor-window">
              Engagement until {grant.endsOn}
            </span>
          )}
          {onLogout && (
            <button type="button" onClick={onLogout} className="ml-auto flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-[10px] font-bold text-slate-300 hover:bg-slate-700" data-testid="advisor-logout">
              <LogOut className="h-3 w-3" /> Sign out
            </button>
          )}
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          {currentUser?.name} · advising {businesses.length} farm{businesses.length > 1 ? "s" : ""}
          {grant && !grant.showCosts ? " · financial data hidden by the Owner" : ""}
        </p>

        {/* Farm selector */}
        <div className="mt-3 flex flex-wrap gap-1.5" data-testid="advisor-farm-picker">
          {businesses.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setBusinessId(b.id)}
              className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition ${
                Number(businessId) === Number(b.id) ? "bg-cyan-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
              data-testid={`advisor-farm-${b.id}`}
            >
              <MapPin className="h-3 w-3" /> {b.name}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200" data-testid="advisor-error">{error}</div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="advisor-kpis">
        {kpi.map((k) => (
          <div key={k.label} className="rounded-2xl border border-slate-700 bg-slate-900/60 p-3">
            <p className="text-[9.5px] font-bold uppercase tracking-wide text-slate-500">{k.label}</p>
            <p className={`text-[18px] font-black ${k.tone}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1" data-testid="advisor-tabs">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-[11px] font-bold transition ${
              tab === t.key ? "bg-cyan-600 text-white shadow" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
            data-testid={`advisor-tab-${t.key}`}
          >
            <t.icon className="h-3.5 w-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-[12px] text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading farm records…</div>
      ) : (
        <>
          {tab === "OVERVIEW" && (
            <div className="space-y-4">
              <AdvisoryDigestCard digest={data?.digest} onGenerate={publishDigest} generating={generating} canPublish />
              {hasScope("ALERTS") && (
                <section className="rounded-2xl border border-slate-700 bg-slate-900/60 p-4" data-testid="advisor-alerts">
                  <h4 className="mb-2 flex items-center gap-1.5 text-[12px] font-extrabold text-white">
                    <AlertTriangle className="h-4 w-4 text-amber-300" /> Live farm alerts
                  </h4>
                  <div className="space-y-1.5">
                    {(data?.alerts || []).length === 0 ? (
                      <p className="text-[11px] text-slate-500">No alerts raised by the farm analytics engine.</p>
                    ) : (data?.alerts || []).slice(0, 8).map((a: any) => (
                      <div key={a.id} className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${a.level === "critical" ? "border-rose-500/40 bg-rose-500/10 text-rose-200" : a.level === "warning" ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-slate-700 bg-slate-800/50 text-slate-300"}`}>
                        <span className="font-bold">{a.title}</span> — {a.message}
                        {a.recommendation && <span className="block text-[10px] opacity-80">→ {a.recommendation}</span>}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {tab === "FLOCKS" && (
            <Table
              testid="advisor-flocks-table"
              head={["Batch", "Flock", "Type / breed", "Birds", "Mortality", "Arrival", "Age (wks)", "Status"]}
              rows={flocks.map((f: any) => [f.batchNumber, f.flockName, `${f.birdType}${f.breed ? ` · ${f.breed}` : ""}`, f.currentCount, f.mortalityTotal, f.arrivalDate, f.ageWeeks, f.status])}
            />
          )}

          {tab === "FEED_WATER" && (
            <div className="space-y-3">
              <Table
                testid="advisor-feed-table"
                head={["Date", "Batch", "Feed type", "Qty (kg)", "Entry"]}
                rows={(data?.feedLogs || []).slice(0, 60).map((f: any) => [f.recordedDate, f.batchNumber, f.feedType, f.quantityKg, f.entryType])}
              />
              <Table
                testid="advisor-water-table"
                head={["Date", "Batch", "Litres", "Source", "pH", "Treated"]}
                rows={(data?.waterLogs || []).slice(0, 60).map((w: any) => [w.recordedDate, w.batchNumber, w.volumeLiters, w.sourceType, w.phLevel, w.isTreated ? "Yes" : "No"])}
              />
            </div>
          )}

          {tab === "HEALTH" && (
            <Table
              testid="advisor-health-table"
              head={["Date", "Batch", "Type", "Vaccine / drug", "Condition", "Affected", "Deaths", "Outcome", "Next due"]}
              rows={(data?.healthRecords || []).slice(0, 80).map((h: any) => [h.recordedDate, h.batchNumber, h.recordType, h.vaccineOrDrug, h.diseaseOrCondition, h.birdsAffected, h.mortalityCount, h.outcome, h.nextDueDate])}
            />
          )}

          {tab === "PRODUCTION" && (
            <Table
              testid="advisor-production-table"
              head={["Date", "Batch", "Type", "Eggs", "Trays", "Lay %", "FCR", "Avg wt (kg)"]}
              rows={(data?.production || []).slice(0, 80).map((p: any) => [p.recordedDate, p.batchNumber, p.productionType, p.eggsCollected, p.traysProduced, p.layPercentage, p.fcr, p.avgWeightKg])}
            />
          )}

          {tab === "CHECKLIST" && (
            <div className="space-y-3">
              <Table
                testid="advisor-checklist-table"
                head={["Date", "Task", "Category", "Done", "By"]}
                rows={(data?.checklistEntries || []).slice(0, 80).map((c: any) => [c.checklistDate, c.taskLabel, c.category, c.isCompleted ? "✔" : "—", c.completedByName])}
              />
              {hasScope("DAILY_NOTES") && (
                <section className="rounded-2xl border border-slate-700 bg-slate-900/60 p-4" data-testid="advisor-daily-notes">
                  <h4 className="mb-2 text-[12px] font-extrabold text-white">Staff daily notes (read-only)</h4>
                  <div className="space-y-1.5">
                    {(data?.dailyNotes || []).slice(0, 10).map((n: any) => (
                      <div key={n.id} className="rounded-lg border border-slate-700 bg-slate-950/50 px-2.5 py-1.5 text-[11px] text-slate-300">
                        <span className="font-bold text-slate-200">{n.noteDate} · {n.userName}</span>
                        <p className="mt-0.5 whitespace-pre-wrap">{n.content}</p>
                      </div>
                    ))}
                    {(data?.dailyNotes || []).length === 0 && <p className="text-[11px] text-slate-500">No staff notes in scope.</p>}
                  </div>
                </section>
              )}
            </div>
          )}

          {tab === "NOTES" && (
            <AdvisoryNotesPanel
              businessId={businessId}
              businessName={biz?.name}
              currentUser={currentUser}
              flocks={flocks}
              canWrite
              onChanged={load}
            />
          )}

          {tab === "VISITS" && (
            <div className="space-y-3">
              <section className="rounded-2xl border border-slate-700 bg-slate-900/60 p-4" data-testid="advisor-visit-form">
                <h4 className="mb-2 flex items-center gap-1.5 text-[12px] font-extrabold text-white"><CalendarClock className="h-4 w-4 text-cyan-300" /> Log a visit</h4>
                <div className="flex flex-wrap gap-2">
                  <select value={visitType} onChange={(e) => setVisitType(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-[11px] text-white" data-testid="advisor-visit-type">
                    <option value="ON_SITE">On-site visit</option>
                    <option value="REMOTE">Remote review</option>
                  </select>
                  <input
                    value={visitSummary}
                    onChange={(e) => setVisitSummary(e.target.value)}
                    placeholder="Visit summary / report…"
                    className="min-w-[200px] flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-[11px] text-white outline-none focus:border-cyan-500"
                    data-testid="advisor-visit-summary"
                  />
                  <button type="button" disabled={busy} onClick={() => logVisit("COMPLETED")} className="rounded-lg bg-cyan-600 px-3 py-2 text-[11px] font-black text-white hover:bg-cyan-500 disabled:opacity-50" data-testid="advisor-visit-complete">
                    Log completed visit
                  </button>
                  <button type="button" disabled={busy} onClick={() => logVisit("PLANNED")} className="rounded-lg bg-slate-700 px-3 py-2 text-[11px] font-bold text-white disabled:opacity-50" data-testid="advisor-visit-plan">
                    Schedule
                  </button>
                </div>
              </section>
              <Table
                testid="advisor-visits-table"
                head={["Date", "Type", "Status", "Summary"]}
                rows={visits.map((v: any) => [v.actualDate || v.plannedDate, v.visitType, v.status, v.summary])}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
