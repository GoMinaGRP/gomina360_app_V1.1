/**
 * poultryStages — the poultry production-stage model.
 *
 * Pure functions, no database access. The single source of truth for
 * "what stage is this flock in today":
 *
 *   • BROILERS are staged by DAY / age from placement to market
 *     (PREP → BROODING → STARTER → GROWER → FINISHER → MARKET → CLOSEOUT),
 *     with the market age resolved from the flock's benchmark profile
 *     (`curves._meta.marketAgeDays`, default 42 days).
 *   • LAYERS are staged by WEEK / age through rearing and the lay cycle
 *     (CHICK_BROODING → GROWING → DEVELOPING → PRE_LAY → EARLY_LAY → PEAK
 *     → MID_LAY → LATE_LAY → CLOSEOUT).
 *
 * Age is ALWAYS derived from `arrivalDate` (day 0 = placement day) via the
 * benchmarking library's `ageDaysOf` — never from the manually-maintained
 * `ageWeeks` column, which can drift.
 *
 * Stage boundaries are constants so the checklist engine, the poultry
 * module UI and the notifications all agree; they can tighten per flock
 * through the resolved benchmark profile's marketAgeDays.
 */

import { ageDaysOf } from "./poultryBenchmarking";

export type StagePhase = "PRE_PLACEMENT" | "REARING" | "PRODUCTION" | "MARKET" | "CLOSEOUT";

export interface StageDef {
  key: string;
  label: string;
  birdType: "BROILERS" | "LAYERS";
  phase: StagePhase;
  /** Inclusive start (age in days). */
  startAgeDays: number;
  /** Inclusive end (age in days); null = open-ended. */
  endAgeDays: number | null;
  /** What the manager should hear when a flock enters this stage. */
  transitionNote: string;
}

export interface FlockStage {
  stageKey: string;
  label: string;
  birdType: string;
  phase: StagePhase;
  ageDays: number;
  ageWeeks: number;
  windowStartAgeDays: number;
  windowEndAgeDays: number | null;
  /** Broilers: days until the profile's market age (0 when reached). */
  marketEtaDays: number | null;
  nextStageKey: string | null;
  /** Days until the next stage boundary (negative = overdue past it). */
  daysToNextStage: number | null;
  transitionNote: string;
}

export const DEFAULT_BROILER_MARKET_AGE_DAYS = 42;

/** Broiler stages — organized by DAY / age + production stage. Window ends
 *  are computed against the flock's market age (M) by stageOfFlock:
 *  FINISHER ends M-3, MARKET spans M-2 … M+7 (a grace window for ACTIVE
 *  flocks whose sale slips a few days), CLOSEOUT runs from M+8. */
type BroilerStageDef = Omit<StageDef, "endAgeDays">;
const BROILER_STAGES: BroilerStageDef[] = [
  {
    key: "PREP",
    label: "Pre-Placement Prep",
    birdType: "BROILERS",
    phase: "PRE_PLACEMENT",
    startAgeDays: -14,
    transitionNote: "House prep window — wash, disinfect, litter and brooder test before chicks arrive.",
  },
  {
    key: "BROODING",
    label: "Brooding (Days 1–7)",
    birdType: "BROILERS",
    phase: "REARING",
    startAgeDays: 0,
    transitionNote: "Brooding week — brooder temperature 33→30°C, crop-fill check and paper feeding are critical.",
  },
  {
    key: "STARTER",
    label: "Starter (Days 8–14)",
    birdType: "BROILERS",
    phase: "REARING",
    startAgeDays: 7,
    transitionNote: "Starter phase — step temperature down, sample-weigh against the day-7 target and order grower feed.",
  },
  {
    key: "GROWER",
    label: "Grower (Days 15–28)",
    birdType: "BROILERS",
    phase: "REARING",
    startAgeDays: 14,
    transitionNote: "Grower phase — transition to grower feed, weekly sample weighing and density checks.",
  },
  {
    key: "FINISHER",
    label: "Finisher (Day 29 → market)",
    birdType: "BROILERS",
    phase: "REARING",
    startAgeDays: 28,
    transitionNote: "Finisher phase — transition to finisher feed, weekly weighing and medication withdrawal review before market.",
  },
  {
    key: "MARKET",
    label: "Market Week",
    birdType: "BROILERS",
    phase: "MARKET",
    startAgeDays: -2, // resolved to M-2 at runtime
    transitionNote: "Market week — feed withdrawal, withdrawal compliance, catch crew and load-out supervision are critical.",
  },
  {
    key: "CLOSEOUT",
    label: "Closeout",
    birdType: "BROILERS",
    phase: "CLOSEOUT",
    startAgeDays: -8, // resolved to M+8 at runtime
    transitionNote: "Closeout — finalize FCR, mortality and economics vs benchmark, close the batch and reset the house.",
  },
];

/** Layer stages — organized by WEEK / age + production stage. Week windows
 *  are expressed in days (wk N starts at N*7 days). Lay-cycle anchors match
 *  the layer benchmark curves: first eggs ~wk 19, peak plateau wk 26–38. */
const LAYER_STAGES: StageDef[] = [
  {
    key: "PREP",
    label: "Pre-Placement Prep",
    birdType: "LAYERS",
    phase: "PRE_PLACEMENT",
    startAgeDays: -14,
    endAgeDays: -1,
    transitionNote: "Brooding prep — wash, disinfect and pre-heat the rearing house before pullet chicks arrive.",
  },
  {
    key: "CHICK_BROODING",
    label: "Chick Brooding (Wk 0–6)",
    birdType: "LAYERS",
    phase: "REARING",
    startAgeDays: 0,
    endAgeDays: 48,
    transitionNote: "Chick brooding — temperature step-down, crop-fill check and weekly chick weighing start now.",
  },
  {
    key: "GROWING",
    label: "Growing (Wk 7–12)",
    birdType: "LAYERS",
    phase: "REARING",
    startAgeDays: 49,
    endAgeDays: 90,
    transitionNote: "Growing phase — controlled feeding to keep body weight on the standard curve; watch uniformity.",
  },
  {
    key: "DEVELOPING",
    label: "Developing (Wk 13–17)",
    birdType: "LAYERS",
    phase: "REARING",
    startAgeDays: 91,
    endAgeDays: 125,
    transitionNote: "Developing phase — full uniformity sample and lay-house transfer preparation.",
  },
  {
    key: "PRE_LAY",
    label: "Pre-Lay (Wk 18–19)",
    birdType: "LAYERS",
    phase: "REARING",
    startAgeDays: 126,
    endAgeDays: 139,
    transitionNote: "Pre-lay — start the light stimulation step-up, transition to layer mash/calcium and transfer to the lay house.",
  },
  {
    key: "EARLY_LAY",
    label: "Early Lay (Wk 20–25)",
    birdType: "LAYERS",
    phase: "PRODUCTION",
    startAgeDays: 140,
    endAgeDays: 181,
    transitionNote: "Early lay — production ramps to peak; track lay % against the benchmark curve daily.",
  },
  {
    key: "PEAK",
    label: "Peak Lay (Wk 26–38)",
    birdType: "LAYERS",
    phase: "PRODUCTION",
    startAgeDays: 182,
    endAgeDays: 272,
    transitionNote: "Peak lay — hold ~92% production; water/feed vigilance and stress minimization are critical.",
  },
  {
    key: "MID_LAY",
    label: "Mid Lay (Wk 39–60)",
    birdType: "LAYERS",
    phase: "PRODUCTION",
    startAgeDays: 273,
    endAgeDays: 426,
    transitionNote: "Mid lay — monthly uniformity and egg-weight tracking against the curve.",
  },
  {
    key: "LATE_LAY",
    label: "Late Lay (Wk 61–80)",
    birdType: "LAYERS",
    phase: "PRODUCTION",
    startAgeDays: 427,
    endAgeDays: 566,
    transitionNote: "Late lay — shell quality and egg size tracking; evaluate molt vs replacement economics.",
  },
  {
    key: "CLOSEOUT",
    label: "Spent / Closeout (Wk 81+)",
    birdType: "LAYERS",
    phase: "CLOSEOUT",
    startAgeDays: 567,
    endAgeDays: null,
    transitionNote: "Spent flock — plan spent-hen sale, close out lifetime economics and reset the house.",
  },
];

export const POULTRY_STAGE_PLAN_TYPES = ["BROILERS", "LAYERS"] as const;

/** Bird types the stage plan covers. Cockerels / turkeys / guinea fowl fall
 *  back to the bird-type-agnostic daily core routine (no stage tasks). */
export function isStagePlanBirdType(birdType: string | null | undefined): boolean {
  return POULTRY_STAGE_PLAN_TYPES.includes(String(birdType || "").toUpperCase() as any);
}

/** Every stage key a bird type can be in (for UI pickers + validation). */
export function stageKeysOfBirdType(birdType: string): string[] {
  const bt = String(birdType || "").toUpperCase();
  if (bt === "BROILERS") return BROILER_STAGES.map((s) => s.key);
  if (bt === "LAYERS") return LAYER_STAGES.map((s) => s.key);
  return [];
}

export function stageDefOf(birdType: string, stageKey: string): StageDef | null {
  const bt = String(birdType || "").toUpperCase();
  if (bt === "BROILERS") {
    const s = BROILER_STAGES.find((x) => x.key === stageKey);
    if (!s) return null;
    return { ...s, endAgeDays: null }; // broiler windows are resolved at runtime per market age
  }
  if (bt === "LAYERS") return LAYER_STAGES.find((x) => x.key === stageKey) || null;
  return null;
}

/** Ordered stage catalogue for a bird type, with resolved day windows for
 *  display (broiler market windows use the default market age unless given). */
export function stagesOfBirdType(birdType: string, marketAgeDays?: number | null): FlockStage[] {
  const bt = String(birdType || "").toUpperCase();
  if (bt === "BROILERS") {
    const m = Number(marketAgeDays) > 0 ? Number(marketAgeDays) : DEFAULT_BROILER_MARKET_AGE_DAYS;
    const windows: Record<string, [number, number | null]> = {
      PREP: [-14, -1],
      BROODING: [0, 6],
      STARTER: [7, 13],
      GROWER: [14, 27],
      FINISHER: [28, m - 3],
      MARKET: [m - 2, m + 7],
      CLOSEOUT: [m + 8, null],
    };
    return BROILER_STAGES.map((s) => ({
      stageKey: s.key,
      label: s.label,
      birdType: "BROILERS",
      phase: s.phase,
      ageDays: windows[s.key][0],
      ageWeeks: Math.floor(Math.max(0, windows[s.key][0]) / 7),
      windowStartAgeDays: windows[s.key][0],
      windowEndAgeDays: windows[s.key][1],
      marketEtaDays: Math.max(0, m - windows[s.key][0]),
      nextStageKey: null,
      daysToNextStage: null,
      transitionNote: s.transitionNote,
    }));
  }
  if (bt === "LAYERS") {
    return LAYER_STAGES.map((s) => ({
      stageKey: s.key,
      label: s.label,
      birdType: "LAYERS",
      phase: s.phase,
      ageDays: s.startAgeDays,
      ageWeeks: Math.floor(Math.max(0, s.startAgeDays) / 7),
      windowStartAgeDays: s.startAgeDays,
      windowEndAgeDays: s.endAgeDays,
      marketEtaDays: null,
      nextStageKey: null,
      daysToNextStage: null,
      transitionNote: s.transitionNote,
    }));
  }
  return [];
}

/**
 * Resolve a flock's production stage for a date.
 * Returns null for unsupported bird types or missing arrival dates — callers
 * then fall back to the bird-type-agnostic daily core routine.
 */
export function stageOfFlock(
  flock: any,
  date: string,
  profile?: { curves?: { _meta?: { marketAgeDays?: number | null } | null } | null } | null,
): FlockStage | null {
  if (!flock || !flock.arrivalDate || !isStagePlanBirdType(flock.birdType)) return null;
  const birdType = String(flock.birdType).toUpperCase() as "BROILERS" | "LAYERS";
  const ageDays = ageDaysOf(flock, date); // 0 on placement day; 0 (clamped) before arrival
  const beforeArrival = new Date(date).getTime() < new Date(flock.arrivalDate).getTime();

  if (birdType === "BROILERS") {
    const m =
      Number((profile as any)?.curves?._meta?.marketAgeDays) > 0
        ? Number((profile as any)?.curves?._meta?.marketAgeDays)
        : DEFAULT_BROILER_MARKET_AGE_DAYS;
    const windows: { key: string; start: number; end: number | null }[] = [
      { key: "PREP", start: -14, end: -1 },
      { key: "BROODING", start: 0, end: 6 },
      { key: "STARTER", start: 7, end: 13 },
      { key: "GROWER", start: 14, end: 27 },
      { key: "FINISHER", start: 28, end: m - 3 },
      { key: "MARKET", start: m - 2, end: m + 7 },
      { key: "CLOSEOUT", start: m + 8, end: null },
    ];
    const idx = beforeArrival
      ? 0
      : windows.findIndex((w) => ageDays >= w.start && (w.end == null || ageDays <= w.end));
    const i = idx === -1 ? windows.length - 1 : idx;
    const w = windows[i];
    const def = BROILER_STAGES[i];
    const next = windows[i + 1] || null;
    return {
      stageKey: w.key,
      label: def.label,
      birdType,
      phase: def.phase,
      ageDays: Math.max(0, ageDays),
      ageWeeks: Math.floor(Math.max(0, ageDays) / 7),
      windowStartAgeDays: w.start,
      windowEndAgeDays: w.end,
      marketEtaDays: Math.max(0, m - Math.max(0, ageDays)),
      nextStageKey: next ? next.key : null,
      daysToNextStage: next ? next.start - ageDays : null,
      transitionNote: def.transitionNote,
    };
  }

  // LAYERS — stage windows come straight from the week-based table
  const idx = beforeArrival
    ? 0
    : LAYER_STAGES.findIndex((s) => ageDays >= s.startAgeDays && (s.endAgeDays == null || ageDays <= s.endAgeDays));
  const i = idx === -1 ? LAYER_STAGES.length - 1 : idx;
  const def = LAYER_STAGES[i];
  const next = LAYER_STAGES[i + 1] || null;
  return {
    stageKey: def.key,
    label: def.label,
    birdType,
    phase: def.phase,
    ageDays: Math.max(0, ageDays),
    ageWeeks: Math.floor(Math.max(0, ageDays) / 7),
    windowStartAgeDays: def.startAgeDays,
    windowEndAgeDays: def.endAgeDays,
    marketEtaDays: null,
    nextStageKey: next ? next.key : null,
    daysToNextStage: next ? next.startAgeDays - ageDays : null,
    transitionNote: def.transitionNote,
  };
}

/** Human summary for chips/notifications, e.g. "BROILERS · Day 23 · Grower". */
export function describeStage(stage: FlockStage | null): string {
  if (!stage) return "No stage";
  const age = stage.birdType === "LAYERS" ? `Wk ${stage.ageWeeks}` : `Day ${stage.ageDays}`;
  return `${stage.birdType} · ${age} · ${stage.label}`;
}
