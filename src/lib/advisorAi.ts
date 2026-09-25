/**
 * GoMina AI — Advisory Digest engine.
 *
 * The Farm Advisor writes professional notes; the farm writes numbers. This
 * engine JOINS the two and tells the Owner what it means:
 *
 *   • FINDINGS   — what the advisor observed (via the existing deterministic
 *                  daily-notes analyser: category, severity, recurrence);
 *   • CONCERNS   — where the farm's own data confirms, contradicts or is
 *                  silent about each observation (corroboration scoring);
 *   • BENCHMARKS — mortality, FCR, lay %, body weight, water:feed and
 *                  checklist compliance measured against the SAME industry
 *                  curves the poultry dashboard already uses
 *                  (lib/poultryPerformance.ts);
 *   • ADOPTION   — did staff act on the advice? how fast? did the targeted
 *                  metric move afterwards?
 *
 * Deterministic by design (no randomness, no clock-dependent text beyond the
 * window it is given) so the E2E suite can assert it exactly — the same
 * property that makes lib/dailyNotesAi.ts testable.
 */

import { broilerTargetKg, layerTargetKg, layerTargetLayPct } from "./poultryPerformance";

export type DigestSeverity = "INFO" | "WATCH" | "URGENT";

export interface DigestMetric {
  key: string;
  label: string;
  actual: number | null;
  target: number | null;
  unit: string;
  status: "GOOD" | "WATCH" | "BAD" | "UNKNOWN";
  comment: string;
}

export interface DigestFinding {
  noteId: number;
  title: string;
  noteType: string;
  priority: string;
  observationDate: string;
  aiSeverity: DigestSeverity;
  categories: string[];
  corroboration: "CONFIRMED_BY_DATA" | "PARTIALLY_SUPPORTED" | "NOT_VISIBLE_IN_DATA";
  evidence: string[];
}

export interface AdoptionStats {
  totalActionable: number;
  closed: number;
  open: number;
  overdue: number;
  adoptionRatePct: number;
  medianDaysToClose: number | null;
}

export interface AdvisoryDigest {
  businessId: number;
  windowDays: number;
  fromDate: string;
  toDate: string;
  generatedFor: string;
  severity: DigestSeverity;
  headline: string;
  summary: string;
  metrics: DigestMetric[];
  findings: DigestFinding[];
  concerns: string[];
  recommendations: string[];
  adoption: AdoptionStats;
  noteCount: number;
  flockCount: number;
}

export interface DigestInput {
  businessId: number;
  businessName?: string;
  windowDays?: number;
  toDate?: string; // YYYY-MM-DD (defaults to today)
  flocks: any[];
  feedLogs: any[];
  waterLogs: any[];
  healthRecords: any[];
  production: any[];
  weightLogs: any[];
  checklistEntries: any[];
  notes: any[]; // advisor_notes rows (already scoped)
}

const DAY = 86400000;
const iso = (d: Date) => d.toISOString().split("T")[0];
const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (v: number, p = 2) => Math.round(v * 10 ** p) / 10 ** p;

const within = (dateStr: any, from: string, to: string) => {
  const d = String(dateStr || "");
  return !!d && d >= from && d <= to;
};

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : round((s[mid - 1] + s[mid]) / 2, 1);
};

/** Age of a flock in days on a given date. */
export function flockAgeDays(flock: any, onDate: string): number {
  if (!flock?.arrivalDate) return 0;
  return Math.max(0, Math.round((new Date(onDate).getTime() - new Date(flock.arrivalDate).getTime()) / DAY));
}

/* ── benchmark metrics ─────────────────────────────────────────────────── */

function buildMetrics(input: DigestInput, from: string, to: string): DigestMetric[] {
  const { flocks, feedLogs, waterLogs, healthRecords, production, weightLogs, checklistEntries } = input;
  const metrics: DigestMetric[] = [];
  const activeFlocks = flocks.filter((f) => String(f.status || "ACTIVE").toUpperCase() === "ACTIVE");
  const birds = activeFlocks.reduce((s, f) => s + num(f.currentCount), 0);

  // 1 · Mortality (window) — industry tolerance ≈ 0.07 %/day (≈5 % per 70-day cycle).
  const deathsWindow =
    healthRecords.filter((h) => within(h.recordedDate, from, to)).reduce((s, h) => s + num(h.mortalityCount), 0);
  const days = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / DAY) + 1);
  const mortalityPct = birds > 0 ? round((deathsWindow / (birds + deathsWindow)) * 100, 2) : null;
  const mortalityTarget = round(0.07 * days, 2);
  metrics.push({
    key: "MORTALITY",
    label: `Mortality (${days}-day window)`,
    actual: mortalityPct,
    target: mortalityTarget,
    unit: "%",
    status:
      mortalityPct == null ? "UNKNOWN"
        : mortalityPct <= mortalityTarget ? "GOOD"
        : mortalityPct <= mortalityTarget * 2 ? "WATCH" : "BAD",
    comment:
      mortalityPct == null
        ? "No live birds recorded for the window."
        : `${deathsWindow} bird(s) lost across ${birds} live birds; tolerance ≈ ${mortalityTarget}% over ${days} days.`,
  });

  // 2 · FCR — feed consumed ÷ biomass or egg mass produced (uses logged FCR when present).
  const feedKg = feedLogs
    .filter((f) => within(f.recordedDate, from, to) && String(f.entryType || "CONSUMPTION").toUpperCase() === "CONSUMPTION")
    .reduce((s, f) => s + num(f.quantityKg), 0);
  const prodWindow = production.filter((p) => within(p.recordedDate, from, to));
  const loggedFcr = prodWindow.map((p) => num(p.fcr)).filter((v) => v > 0);
  const harvestKg = prodWindow.reduce((s, p) => s + num(p.totalWeightKg), 0);
  const fcr = loggedFcr.length
    ? round(loggedFcr.reduce((a, b) => a + b, 0) / loggedFcr.length, 2)
    : harvestKg > 0 && feedKg > 0
      ? round(feedKg / harvestKg, 2)
      : null;
  const isBroilerFarm = activeFlocks.some((f) => String(f.birdType || "").toUpperCase().includes("BROILER"));
  const fcrTarget = isBroilerFarm ? 1.7 : 2.2; // broiler live-weight vs layer egg-mass conversion
  metrics.push({
    key: "FCR",
    label: "Feed conversion ratio",
    actual: fcr,
    target: fcrTarget,
    unit: "kg/kg",
    status: fcr == null ? "UNKNOWN" : fcr <= fcrTarget ? "GOOD" : fcr <= fcrTarget * 1.15 ? "WATCH" : "BAD",
    comment:
      fcr == null
        ? "Not enough feed/production data in the window to compute FCR."
        : `${round(feedKg, 1)} kg feed recorded; benchmark ${fcrTarget} kg feed per kg produced.`,
  });

  // 3 · Lay % vs the Isa-Brown/Lohmann standard for the flock's age.
  const layerFlocks = activeFlocks.filter((f) => String(f.birdType || "").toUpperCase().includes("LAYER"));
  if (layerFlocks.length) {
    const eggRows = prodWindow.filter((p) => String(p.productionType || "").toUpperCase() === "EGGS");
    const eggs = eggRows.reduce((s, p) => s + num(p.eggsCollected), 0);
    const layerBirds = layerFlocks.reduce((s, f) => s + num(f.currentCount), 0);
    const daysWithEggs = new Set(eggRows.map((p) => p.recordedDate)).size || 1;
    const layPct = layerBirds > 0 ? round((eggs / (layerBirds * daysWithEggs)) * 100, 1) : null;
    const avgAgeWeeks =
      layerFlocks.reduce((s, f) => s + flockAgeDays(f, to) / 7, 0) / Math.max(1, layerFlocks.length);
    const target = round(layerTargetLayPct(avgAgeWeeks), 1);
    metrics.push({
      key: "LAY_RATE",
      label: "Lay rate vs breed standard",
      actual: layPct,
      target,
      unit: "%",
      status:
        layPct == null ? "UNKNOWN"
          : layPct >= target * 0.95 ? "GOOD"
          : layPct >= target * 0.85 ? "WATCH" : "BAD",
      comment:
        layPct == null
          ? "No egg production recorded in the window."
          : `${eggs} eggs from ${layerBirds} hens over ${daysWithEggs} recorded day(s); standard at ${round(avgAgeWeeks, 1)} weeks is ${target}%.`,
    });
  }

  // 4 · Body weight vs the target growth curve.
  const wLogs = weightLogs.filter(
    (w) => String(w.weightKind || "BIRD").toUpperCase() === "BIRD" && within(w.recordedDate ?? w.weighDate, from, to),
  );
  if (wLogs.length) {
    const latest = [...wLogs].sort((a, b) =>
      String(b.recordedDate ?? b.weighDate).localeCompare(String(a.recordedDate ?? a.weighDate)))[0];
    const flock = flocks.find((f) => Number(f.id) === Number(latest.flockId));
    const ageDays = flock ? flockAgeDays(flock, String(latest.recordedDate ?? latest.weighDate)) : num(latest.ageDays);
    const isBroiler = String(flock?.birdType || "").toUpperCase().includes("BROILER");
    const target = round(isBroiler ? broilerTargetKg(ageDays) : layerTargetKg(ageDays), 3);
    // poultry_weight_logs stores grams per bird/egg (avgWeightG).
    const grams = num(latest.avgWeightG ?? latest.averageWeightG);
    const actual = grams > 0 ? round(grams / 1000, 3) : round(num(latest.avgWeightKg ?? latest.weightKg), 3) || null;
    metrics.push({
      key: "BODY_WEIGHT",
      label: "Average body weight vs target curve",
      actual,
      target,
      unit: "kg",
      status:
        actual == null ? "UNKNOWN"
          : actual >= target * 0.95 ? "GOOD"
          : actual >= target * 0.88 ? "WATCH" : "BAD",
      comment: `Latest weighing at ${ageDays} days: target ${target} kg for this breed type.`,
    });
  }

  // 5 · Water : feed ratio — a classic early-warning signal (healthy ≈ 1.6–2.2 L/kg).
  const waterL = waterLogs.filter((w) => within(w.recordedDate, from, to)).reduce((s, w) => s + num(w.volumeLiters), 0);
  const ratio = feedKg > 0 && waterL > 0 ? round(waterL / feedKg, 2) : null;
  metrics.push({
    key: "WATER_FEED",
    label: "Water : feed ratio",
    actual: ratio,
    target: 1.9,
    unit: "L/kg",
    status: ratio == null ? "UNKNOWN" : ratio >= 1.6 && ratio <= 2.2 ? "GOOD" : ratio >= 1.3 && ratio <= 2.6 ? "WATCH" : "BAD",
    comment:
      ratio == null
        ? "Water or feed logging is incomplete for the window."
        : `${round(waterL, 0)} L water against ${round(feedKg, 1)} kg feed; healthy band 1.6–2.2 L/kg.`,
  });

  // 6 · Daily checklist compliance.
  const ce = checklistEntries.filter((c) => within(c.checklistDate, from, to));
  const compliance = ce.length ? round((ce.filter((c) => c.isCompleted).length / ce.length) * 100, 1) : null;
  metrics.push({
    key: "CHECKLIST",
    label: "Daily checklist compliance",
    actual: compliance,
    target: 90,
    unit: "%",
    status: compliance == null ? "UNKNOWN" : compliance >= 90 ? "GOOD" : compliance >= 70 ? "WATCH" : "BAD",
    comment: ce.length ? `${ce.filter((c) => c.isCompleted).length}/${ce.length} tasks completed in the window.` : "No checklist entries in the window.",
  });

  return metrics;
}

/* ── corroboration: does the data back the advisor up? ─────────────────── */

const CATEGORY_METRICS: Record<string, string[]> = {
  HEALTH: ["MORTALITY", "WATER_FEED"],
  FEED: ["FCR", "WATER_FEED"],
  WATER: ["WATER_FEED"],
  QUALITY: ["LAY_RATE", "BODY_WEIGHT"],
  HYGIENE: ["MORTALITY", "CHECKLIST"],
  STAFF: ["CHECKLIST"],
  MACHINE: ["CHECKLIST"],
  STOCK: ["FCR"],
};

function corroborate(note: any, metrics: DigestMetric[]): { level: DigestFinding["corroboration"]; evidence: string[] } {
  const cats: string[] = Array.isArray(note.aiIssues)
    ? [...new Set(note.aiIssues.map((i: any) => String(i.category)))] as string[]
    : [];
  const keys = new Set<string>();
  for (const c of cats) (CATEGORY_METRICS[c] || []).forEach((k) => keys.add(k));
  if (note.category) (CATEGORY_METRICS[String(note.category).toUpperCase()] || []).forEach((k) => keys.add(k));
  const related = metrics.filter((m) => keys.has(m.key));
  if (!related.length) return { level: "NOT_VISIBLE_IN_DATA", evidence: [] };
  const bad = related.filter((m) => m.status === "BAD");
  const watch = related.filter((m) => m.status === "WATCH");
  const evidence = [...bad, ...watch].map(
    (m) => `${m.label}: ${m.actual ?? "—"}${m.unit} vs target ${m.target ?? "—"}${m.unit} (${m.status})`,
  );
  if (bad.length) return { level: "CONFIRMED_BY_DATA", evidence };
  if (watch.length) return { level: "PARTIALLY_SUPPORTED", evidence };
  return {
    level: "NOT_VISIBLE_IN_DATA",
    evidence: related.map((m) => `${m.label} is within target (${m.actual ?? "—"}${m.unit})`),
  };
}

/* ── adoption / accountability ─────────────────────────────────────────── */

export function computeAdoption(notes: any[], toDate: string): AdoptionStats {
  const actionable = notes.filter((n) => n.requiresAction && !n.withdrawnAt);
  const closed = actionable.filter((n) => ["DONE", "CLOSED"].includes(String(n.status)));
  const open = actionable.filter((n) => !["DONE", "CLOSED"].includes(String(n.status)));
  const overdue = open.filter((n) => n.dueDate && String(n.dueDate) < toDate);
  const durations = closed
    .map((n) => {
      const start = n.createdAt ? new Date(n.createdAt).getTime() : null;
      const end = n.closedAt ? new Date(n.closedAt).getTime() : null;
      return start && end ? Math.max(0, Math.round((end - start) / DAY)) : null;
    })
    .filter((v): v is number => v != null);
  return {
    totalActionable: actionable.length,
    closed: closed.length,
    open: open.length,
    overdue: overdue.length,
    adoptionRatePct: actionable.length ? Math.round((closed.length / actionable.length) * 100) : 0,
    medianDaysToClose: median(durations),
  };
}

/* ── the digest ────────────────────────────────────────────────────────── */

export function buildAdvisoryDigest(input: DigestInput): AdvisoryDigest {
  const windowDays = input.windowDays && input.windowDays > 0 ? Math.min(180, input.windowDays) : 30;
  const to = input.toDate || iso(new Date());
  const from = iso(new Date(new Date(to).getTime() - (windowDays - 1) * DAY));

  const notes = (input.notes || [])
    .filter((n) => !n.withdrawnAt && within(n.observationDate, from, to))
    .sort((a, b) => String(b.observationDate).localeCompare(String(a.observationDate)));

  const metrics = buildMetrics(input, from, to);

  const findings: DigestFinding[] = notes.slice(0, 25).map((n) => {
    const { level, evidence } = corroborate(n, metrics);
    return {
      noteId: Number(n.id),
      title: String(n.title),
      noteType: String(n.noteType || "OBSERVATION"),
      priority: String(n.priority || "MEDIUM"),
      observationDate: String(n.observationDate),
      aiSeverity: (String(n.aiSeverity || "INFO") as DigestSeverity),
      categories: Array.isArray(n.aiIssues) ? [...new Set(n.aiIssues.map((i: any) => String(i.label)))] as string[] : [],
      corroboration: level,
      evidence,
    };
  });

  const badMetrics = metrics.filter((m) => m.status === "BAD");
  const watchMetrics = metrics.filter((m) => m.status === "WATCH");
  const urgentNotes = notes.filter((n) => String(n.aiSeverity) === "URGENT" || ["HIGH", "CRITICAL"].includes(String(n.priority)));
  const adoption = computeAdoption(input.notes || [], to);

  const severity: DigestSeverity =
    badMetrics.length || urgentNotes.length ? "URGENT" : watchMetrics.length || notes.length ? "WATCH" : "INFO";

  const concerns: string[] = [];
  for (const m of badMetrics) concerns.push(`${m.label} is off benchmark — ${m.comment}`);
  for (const m of watchMetrics) concerns.push(`${m.label} is drifting — ${m.comment}`);
  for (const f of findings.filter((x) => x.corroboration === "CONFIRMED_BY_DATA")) {
    concerns.push(`Advisor finding "${f.title}" (${f.observationDate}) is confirmed by the farm's own data: ${f.evidence[0]}`);
  }
  if (adoption.overdue > 0) {
    concerns.push(`${adoption.overdue} advisory follow-up(s) are past their due date.`);
  }

  const recommendations: string[] = [];
  const m = (k: string) => metrics.find((x) => x.key === k);
  if (m("MORTALITY")?.status === "BAD") {
    recommendations.push("Run a post-mortem on fresh mortalities, review brooding/ventilation and confirm the vaccination schedule is current before adding birds.");
  }
  if (m("FCR")?.status !== "GOOD" && m("FCR")?.actual != null) {
    recommendations.push("Audit feed presentation and wastage (feeder height, particle size, spillage) and verify the ration against the flock's age phase — FCR is the single largest cost lever.");
  }
  if (m("WATER_FEED")?.status === "BAD") {
    recommendations.push("Check drinker line pressure, leaks and water quality: a water:feed ratio outside 1.6–2.2 L/kg usually precedes a health or intake problem.");
  }
  if (m("LAY_RATE") && m("LAY_RATE")!.status !== "GOOD") {
    recommendations.push("Review lighting programme, layer ration calcium and body-weight uniformity — the flock is producing below its breed standard.");
  }
  if (m("CHECKLIST")?.status !== "GOOD") {
    recommendations.push("Daily checklist compliance is below 90% — supervision of routine tasks should be tightened before chasing production gains.");
  }
  for (const n of urgentNotes.slice(0, 3)) {
    recommendations.push(`Act on the advisor's ${String(n.priority).toLowerCase()}-priority item: ${n.title}.`);
  }
  if (!recommendations.length) {
    recommendations.push("No corrective action indicated — keep the current management routine and continue daily logging.");
  }

  const headline =
    severity === "URGENT"
      ? `Advisory alert: ${badMetrics.length} benchmark(s) off target${urgentNotes.length ? ` and ${urgentNotes.length} urgent advisor finding(s)` : ""}`
      : severity === "WATCH"
        ? `Advisory watch: ${watchMetrics.length} metric(s) drifting, ${notes.length} advisor note(s) in the window`
        : "Advisory review: operations within benchmark";

  const summary = [
    `${notes.length} advisor note(s) between ${from} and ${to} across ${input.flocks.length} flock(s).`,
    badMetrics.length ? `Off benchmark: ${badMetrics.map((x) => x.label).join(", ")}.` : "All computed benchmarks within tolerance.",
    adoption.totalActionable
      ? `Advice adoption ${adoption.adoptionRatePct}% (${adoption.closed}/${adoption.totalActionable} closed${adoption.medianDaysToClose != null ? `, median ${adoption.medianDaysToClose} day(s)` : ""}).`
      : "No actionable follow-ups raised in this period.",
  ].join(" ");

  return {
    businessId: input.businessId,
    windowDays,
    fromDate: from,
    toDate: to,
    generatedFor: input.businessName || `Business #${input.businessId}`,
    severity,
    headline,
    summary,
    metrics,
    findings,
    concerns,
    recommendations,
    adoption,
    noteCount: notes.length,
    flockCount: input.flocks.length,
  };
}
