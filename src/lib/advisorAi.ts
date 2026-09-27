/**
 * GoMina AI — Farm Advisor note analysis & data corroboration.
 *
 * Reuses the deterministic Daily Notes engine (lib/dailyNotesAi) verbatim —
 * no second AI system — and adds two advisor-specific layers:
 *
 *   1. ADVISOR PRIORS: the advisor's own category + priority are folded into
 *      the analysis as floor constraints (a CRITICAL health note can never be
 *      scored "INFO"; a GROWTH note always surfaces a growth issue entry even
 *      if the wording alone would not have matched the lexicon).
 *   2. DATA CORROBORATION: at note time the linked flock/batch's benchmark
 *      KPIs (weight vs target, FCR, mortality, survival, feed rate, water
 *      quality) are pulled through the SAME benchmarking engines the farm
 *      dashboards use (lib/poultryBenchmarking, lib/fishBenchmarking) and
 *      cross-checked against what the note claims — "slow growth" becomes
 *      "weight −8.2% vs target at day 35 — corroborated", or is contradicted
 *      with the numbers, or is flagged NO_DATA when the farm hasn't logged
 *      enough to verify it. Deterministic, no LLM, same honesty guarantees.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  aquacultureBatches,
  aquacultureBenchmarkProfiles,
  aquacultureFeedLogs,
  aquacultureHarvests,
  aquaculturePonds,
  aquacultureWaterQualityLogs,
  aquacultureWeightLogs,
  poultryBenchmarkProfiles,
  poultryFeedLogs,
  poultryFlocks,
  poultryHealthRecords,
  poultryProduction,
  poultryWeightLogs,
} from "@/db/schema";
import {
  analyzeNote,
  type HistoryEntry,
  type IssueCategory,
  type NoteAnalysis,
  type Severity,
} from "@/lib/dailyNotesAi";
import {
  computeBenchmarks,
  type BenchmarkKpi,
  type BenchmarkResult,
} from "@/lib/poultryBenchmarking";
import {
  computeFishBenchmarks,
  type FishBenchmarkKpi,
  type FishBenchmarkResult,
} from "@/lib/fishBenchmarking";

/* ─── advisor categories → daily-notes taxonomy ─────────────────────── */

export const ADVISOR_CATEGORY_TO_BASE: Record<string, IssueCategory> = {
  GROWTH: "STOCK", // weight/gain performance (no direct lexicon twin)
  FEED_NUTRITION: "FEED",
  HEALTH_DISEASE: "HEALTH",
  MORTALITY: "HEALTH",
  WATER_QUALITY: "WATER",
  BIOSECURITY: "SECURITY",
  STOCKING: "STOCK",
  ENVIRONMENT: "HYGIENE",
  MANAGEMENT: "STAFF",
  MARKET_TIMING: "SALES",
  GENERAL: "STOCK",
};

const CATEGORY_ISSUE_LABEL: Record<string, string> = {
  GROWTH: "Growth below expectation (advisor)",
  FEED_NUTRITION: "Feed / nutrition concern (advisor)",
  HEALTH_DISEASE: "Health / disease concern (advisor)",
  MORTALITY: "Mortality concern (advisor)",
  WATER_QUALITY: "Water quality concern (advisor)",
  BIOSECURITY: "Biosecurity concern (advisor)",
  STOCKING: "Stocking / density concern (advisor)",
  ENVIRONMENT: "Environment / housing concern (advisor)",
  MANAGEMENT: "Management practice concern (advisor)",
  MARKET_TIMING: "Market timing concern (advisor)",
  GENERAL: "Advisor observation",
};

/** Priority → minimum severity the analysis may not score below. */
const PRIORITY_SEVERITY_FLOOR: Record<string, Severity> = {
  LOW: "INFO",
  MEDIUM: "WATCH",
  HIGH: "WATCH",
  CRITICAL: "URGENT",
};

const sevRank = (s: Severity) => (s === "URGENT" ? 3 : s === "WATCH" ? 2 : 1);
const maxSev = (a: Severity, b: Severity): Severity => (sevRank(a) >= sevRank(b) ? a : b);

export interface AdvisorAnalysis extends NoteAnalysis {
  /** The advisor's chosen category, echoed for the UI. */
  advisorCategory: string;
  advisorPriority: string;
}

/** Analyze an advisor note: shared engine + advisor priors. */
export function analyzeAdvisorNote(
  input: { title: string; body: string; category: string; priority: string },
  history: HistoryEntry[],
): AdvisorAnalysis {
  const category = String(input.category || "GENERAL").toUpperCase();
  const priority = String(input.priority || "MEDIUM").toUpperCase();
  const base = analyzeNote(`${input.title}. ${input.body}`, history);

  // Fold the advisor's own category in as a floor-constrained issue entry —
  // the professional's judgement is evidence, not just wording.
  const mapped = ADVISOR_CATEGORY_TO_BASE[category] || "STOCK";
  const floor = PRIORITY_SEVERITY_FLOOR[priority] || "WATCH";
  const issues = [...base.issues];
  const existing = issues.find((i) => i.category === mapped);
  if (existing) {
    existing.severity = maxSev(existing.severity, floor);
    existing.label = CATEGORY_ISSUE_LABEL[category] || existing.label;
  } else {
    issues.unshift({
      category: mapped,
      label: CATEGORY_ISSUE_LABEL[category] || "Advisor observation",
      severity: maxSev("WATCH", floor === "INFO" ? "WATCH" : floor),
      matches: [],
      recurring: false,
      historyCount: 0,
    });
  }
  issues.sort((a, b) => sevRank(b.severity) - sevRank(a.severity));

  const severity: Severity = issues.some((i) => i.severity === "URGENT")
    ? "URGENT"
    : issues.length > 0
      ? maxSev("WATCH", floor === "INFO" ? "WATCH" : floor)
      : "INFO";

  const flags = [
    `Advisor note (${category.toLowerCase().replace(/_/g, " ")}, ${priority.toLowerCase()} priority)`,
    ...base.flags.map((f) => `Advisor: ${f}`),
  ];

  const label = CATEGORY_ISSUE_LABEL[category] || "Advisor observation";
  const summary =
    severity === "URGENT"
      ? `URGENT advisor finding (${priority}) — ${input.title}. ${base.summary}`
      : `Advisor ${category.toLowerCase().replace(/_/g, " ")} note (${priority}) — ${input.title}. ${base.summary}`;

  return { summary: summary.slice(0, 500), issues, severity, flags, advisorCategory: category, advisorPriority: priority };
}

/* ─── deterministic data corroboration ──────────────────────────────── */

export interface CorroborationKpi {
  key: string;
  label: string;
  actual: number | null;
  target: number | null;
  unit: string;
  status: string;
  variancePct: number | null;
}

export interface AdvisorCorroboration {
  verdict: "CORROBORATED" | "PARTIALLY_CORROBORATED" | "CONTRADICTED" | "NO_DATA" | "NOT_APPLICABLE";
  lines: string[];
  kpis: CorroborationKpi[];
  subject: string | null;
  checkedAt: string;
}

const NO_SUBJECT: AdvisorCorroboration = {
  verdict: "NOT_APPLICABLE",
  lines: ["No flock/batch linked to this note — farm-data cross-check skipped."],
  kpis: [],
  subject: null,
  checkedAt: new Date().toISOString(),
};

/** Which concerns does the note text raise, by keyword family? */
function triggersOf(text: string): { growth: boolean; feed: boolean; mortality: boolean; water: boolean } {
  const t = ` ${text.toLowerCase()} `;
  return {
    growth: /growth|weight|gaining|gain|size|stunt|slow|adg|sgr/.test(t),
    feed: /\bfcr\b|feed conversion|conversion ratio|feed efficien|feed intake|feeding rate|feed rate|feed cost/.test(t),
    mortality: /mortal|death|dying|died|dead|survival|loss/.test(t),
    water: /water|oxygen|dissolved|ammonia|ph\b|quality|temperature/.test(t),
  };
}

function kpiOf(kpis: BenchmarkKpi[] | FishBenchmarkKpi[], key: string): CorroborationKpi | null {
  const k: any = (kpis as any[]).find((x) => x.key === key);
  if (!k) return null;
  return {
    key: String(k.key),
    label: String(k.label || k.key),
    actual: k.actual ?? null,
    target: k.target ?? null,
    unit: String(k.unit || ""),
    status: String(k.status || "NO_DATA"),
    variancePct: k.variancePct ?? null,
  };
}

const fmt = (v: number | null | undefined, unit = "") =>
  v == null || !Number.isFinite(Number(v)) ? "—" : `${Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ""}`;

function verdictFrom(results: { corroborated: number; contradicted: number; noData: number }): AdvisorCorroboration["verdict"] {
  if (results.corroborated > 0 && results.contradicted === 0) return "CORROBORATED";
  if (results.corroborated > 0 && results.contradicted > 0) return "PARTIALLY_CORROBORATED";
  if (results.contradicted > 0 && results.corroborated === 0) return "CONTRADICTED";
  return "NO_DATA";
}

/** Poultry flock corroboration via the poultry benchmarking engine. */
async function corroboratePoultry(
  businessId: number,
  flockId: number,
  trig: ReturnType<typeof triggersOf>,
): Promise<AdvisorCorroboration> {
  const [flock] = await db
    .select()
    .from(poultryFlocks)
    .where(and(eq(poultryFlocks.id, flockId), eq(poultryFlocks.businessId, businessId)));
  if (!flock) return { ...NO_SUBJECT, lines: ["Linked flock no longer exists — cross-check skipped."] };

  const [feedLogs, healthRecords, production, weightLogs, profiles, allFlocks] = await Promise.all([
    db.select().from(poultryFeedLogs).where(eq(poultryFeedLogs.businessId, businessId)),
    db.select().from(poultryHealthRecords).where(eq(poultryHealthRecords.businessId, businessId)),
    db.select().from(poultryProduction).where(eq(poultryProduction.businessId, businessId)),
    db.select().from(poultryWeightLogs).where(eq(poultryWeightLogs.businessId, businessId)),
    db.select().from(poultryBenchmarkProfiles).where(eq(poultryBenchmarkProfiles.businessId, businessId)),
    db.select().from(poultryFlocks).where(eq(poultryFlocks.businessId, businessId)),
  ]);

  let res: BenchmarkResult | null = null;
  try {
    res = computeBenchmarks({
      flock,
      flocks: allFlocks,
      feedLogs,
      healthRecords,
      production,
      weightLogs,
      profiles: profiles.filter((p: any) => String(p.status || "ACTIVE") === "ACTIVE").map((p: any) => p as any),
    });
  } catch {
    res = null;
  }

  const kpis: CorroborationKpi[] = [];
  const lines: string[] = [];
  const results = { corroborated: 0, contradicted: 0, noData: 0 };
  const push = (key: string, claim: string) => {
    const k = kpiOf(res?.kpis || [], key);
    if (!k) return;
    kpis.push(k);
    if (k.status === "NO_DATA" || k.actual == null) {
      results.noData++;
      lines.push(`${k.label}: not enough logged data to verify (no samples).`);
      return;
    }
    const off = k.status === "OFF_TRACK";
    const on = k.status === "ON_TRACK";
    if (off) {
      results.corroborated++;
      lines.push(
        `${k.label}: ${fmt(k.actual, k.unit)} vs target ${fmt(k.target, k.unit)} (${k.variancePct != null ? `${k.variancePct > 0 ? "+" : ""}${k.variancePct.toFixed(1)}%` : "off track"}) — corroborates the ${claim} concern.`,
      );
    } else if (on) {
      results.contradicted++;
      lines.push(
        `${k.label}: ${fmt(k.actual, k.unit)} vs target ${fmt(k.target, k.unit)} — on track; no ${claim} deviation detected in the data.`,
      );
    } else {
      lines.push(`${k.label}: ${fmt(k.actual, k.unit)} vs target ${fmt(k.target, k.unit)} — drifting (watch band), ${claim} concern is plausible.`);
      results.corroborated++;
    }
  };

  if (trig.growth) push("BODY_WEIGHT_KG", "growth");
  if (trig.growth) push("ADG_G", "growth");
  if (trig.feed) push("FCR", "feed-efficiency");
  if (trig.feed) push("FEED_INTAKE_G_BIRD", "feed-intake");
  if (trig.mortality) push("MORTALITY_CUM_PCT", "mortality");

  if (!res?.hasAnyBenchmark) {
    return {
      verdict: "NO_DATA",
      lines: [
        `No benchmark profile matches ${flock.batchNumber} (${flock.birdType}) — KPI cross-check unavailable. Flock status: ${flock.currentCount}/${flock.initialCount} birds, cumulative mortality ${flock.mortalityTotal || 0}.`,
      ],
      kpis,
      subject: `${flock.batchNumber} (${flock.birdType})`,
      checkedAt: new Date().toISOString(),
    };
  }
  if (kpis.length === 0) {
    return {
      verdict: "NOT_APPLICABLE",
      lines: [`Note raises no growth/feed/mortality claims that farm data can cross-check for ${flock.batchNumber}.`],
      kpis,
      subject: `${flock.batchNumber} (${flock.birdType})`,
      checkedAt: new Date().toISOString(),
    };
  }
  return {
    verdict: verdictFrom(results),
    lines,
    kpis,
    subject: `${flock.batchNumber} (${flock.birdType})`,
    checkedAt: new Date().toISOString(),
  };
}

/** Aquaculture batch corroboration via the fish benchmarking engine + the
 *  latest water-quality reading vs the pond's targets. */
async function corroborateAquaculture(
  businessId: number,
  batchId: number,
  trig: ReturnType<typeof triggersOf>,
): Promise<AdvisorCorroboration> {
  const [batch] = await db
    .select()
    .from(aquacultureBatches)
    .where(and(eq(aquacultureBatches.id, batchId), eq(aquacultureBatches.businessId, businessId)));
  if (!batch) return { ...NO_SUBJECT, lines: ["Linked batch no longer exists — cross-check skipped."] };

  const [feedLogs, harvests, weightLogs, ponds, profiles, allBatches, waterLogs] = await Promise.all([
    db.select().from(aquacultureFeedLogs).where(eq(aquacultureFeedLogs.businessId, businessId)),
    db.select().from(aquacultureHarvests).where(eq(aquacultureHarvests.businessId, businessId)),
    db.select().from(aquacultureWeightLogs).where(eq(aquacultureWeightLogs.businessId, businessId)),
    db.select().from(aquaculturePonds).where(eq(aquaculturePonds.businessId, businessId)),
    db.select().from(aquacultureBenchmarkProfiles).where(eq(aquacultureBenchmarkProfiles.businessId, businessId)),
    db.select().from(aquacultureBatches).where(eq(aquacultureBatches.businessId, businessId)),
    db
      .select()
      .from(aquacultureWaterQualityLogs)
      .where(eq(aquacultureWaterQualityLogs.businessId, businessId))
      .orderBy(desc(aquacultureWaterQualityLogs.sampleDate))
      .limit(30),
  ]);

  let res: FishBenchmarkResult | null = null;
  try {
    res = computeFishBenchmarks({
      batch,
      batches: allBatches,
      feedLogs,
      harvests,
      weightLogs,
      ponds,
      profiles: profiles.filter((p: any) => String(p.status || "ACTIVE") === "ACTIVE").map((p: any) => p as any),
    });
  } catch {
    res = null;
  }

  const kpis: CorroborationKpi[] = [];
  const lines: string[] = [];
  const results = { corroborated: 0, contradicted: 0, noData: 0 };
  const push = (key: string, claim: string) => {
    const k = kpiOf(res?.kpis || [], key);
    if (!k) return;
    kpis.push(k);
    if (k.status === "NO_DATA" || k.actual == null) {
      results.noData++;
      lines.push(`${k.label}: not enough logged data to verify.`);
      return;
    }
    if (k.status === "OFF_TRACK") {
      results.corroborated++;
      lines.push(
        `${k.label}: ${fmt(k.actual, k.unit)} vs target ${fmt(k.target, k.unit)} (${k.variancePct != null ? `${k.variancePct > 0 ? "+" : ""}${k.variancePct.toFixed(1)}%` : "off track"}) — corroborates the ${claim} concern.`,
      );
    } else if (k.status === "ON_TRACK") {
      results.contradicted++;
      lines.push(`${k.label}: ${fmt(k.actual, k.unit)} vs target ${fmt(k.target, k.unit)} — on track; no ${claim} deviation detected.`);
    } else {
      results.corroborated++;
      lines.push(`${k.label}: ${fmt(k.actual, k.unit)} vs target ${fmt(k.target, k.unit)} — drifting (watch band), ${claim} concern is plausible.`);
    }
  };

  if (trig.growth) push("AVG_WEIGHT_G", "growth");
  if (trig.growth) push("SGR_PCT", "growth");
  if (trig.feed) push("FCR", "feed-efficiency");
  if (trig.feed) push("FEED_RATE_PCT_BIOMASS", "feed-rate");
  if (trig.mortality) push("SURVIVAL_PCT", "mortality");

  // Water quality: latest reading vs the batch's pond targets.
  if (trig.water) {
    const pond = ponds.find((p: any) => Number(p.id) === Number(batch.pondId));
    const latest = batch.pondId
      ? waterLogs.find((w: any) => Number(w.pondId) === Number(batch.pondId))
      : waterLogs[0];
    if (!latest) {
      results.noData++;
      lines.push("Water quality: no samples logged — cannot verify water claims.");
    } else {
      const doMin = pond?.doTargetMinMgL ?? 5.0;
      const doMax = pond?.doTargetMaxMgL ?? 8.0;
      const phMin = pond?.phTargetMin ?? 6.5;
      const phMax = pond?.phTargetMax ?? 8.5;
      const doBad = latest.dissolvedOxygenMgL < doMin || latest.dissolvedOxygenMgL > doMax;
      const phBad = latest.phLevel < phMin || latest.phLevel > phMax;
      const ammoBad = (latest.ammoniaMgL ?? 0) > 0.5;
      if (doBad || phBad || ammoBad) {
        results.corroborated++;
        const parts: string[] = [];
        if (doBad) parts.push(`DO ${fmt(latest.dissolvedOxygenMgL, "mg/L")} outside ${doMin}–${doMax}`);
        if (phBad) parts.push(`pH ${fmt(latest.phLevel)} outside ${phMin}–${phMax}`);
        if (ammoBad) parts.push(`ammonia ${fmt(latest.ammoniaMgL, "mg/L")} above 0.5`);
        lines.push(`Water quality (${latest.sampleDate}): ${parts.join("; ")} — corroborates the water-quality concern.`);
      } else {
        results.contradicted++;
        lines.push(
          `Water quality (${latest.sampleDate}): DO ${fmt(latest.dissolvedOxygenMgL, "mg/L")}, pH ${fmt(latest.phLevel)}, ammonia ${fmt(latest.ammoniaMgL, "mg/L")} — all within targets; no water deviation detected.`,
        );
      }
    }
  }

  if (!res?.hasAnyBenchmark && kpis.length === 0 && !trig.water) {
    return {
      verdict: "NO_DATA",
      lines: [`No benchmark profile matches ${batch.batchNumber} (${batch.species}) and no verifiable claims in the note.`],
      kpis,
      subject: `${batch.batchNumber} (${batch.species})`,
      checkedAt: new Date().toISOString(),
    };
  }
  if (kpis.length === 0 && !trig.water) {
    return {
      verdict: "NOT_APPLICABLE",
      lines: [`Note raises no growth/feed/mortality/water claims that farm data can cross-check for ${batch.batchNumber}.`],
      kpis,
      subject: `${batch.batchNumber} (${batch.species})`,
      checkedAt: new Date().toISOString(),
    };
  }
  return {
    verdict: verdictFrom(results),
    lines,
    kpis,
    subject: `${batch.batchNumber} (${batch.species})`,
    checkedAt: new Date().toISOString(),
  };
}

/** Cross-check an advisor note against the linked flock/batch's real KPIs. */
export async function corroborateAdvisorNote(input: {
  businessId: number;
  flockId?: number | null;
  batchId?: number | null;
  noteText: string;
}): Promise<AdvisorCorroboration> {
  const trig = triggersOf(input.noteText || "");
  if (input.flockId) return corroboratePoultry(Number(input.businessId), Number(input.flockId), trig);
  if (input.batchId) return corroborateAquaculture(Number(input.businessId), Number(input.batchId), trig);
  return NO_SUBJECT;
}
