/**
 * poultryStageTasks — the versioned poultry stage-plan task library.
 *
 * The SYSTEM layer of the poultry daily checklist. Every task declares:
 *
 *   birdType   null = bird-type-agnostic core routine (applies to any
 *              poultry flock, incl. cockerels/turkeys), else BROILERS/LAYERS.
 *   stageKeys  null = every stage of that bird type, else the stages the
 *              task applies to.
 *   frequency  DAILY (every day in-stage) · WEEKLY (due after 6 quiet days)
 *              · MONTHLY (due after 29 quiet days) · STAGE_ONCE (once per
 *              flock per stage window).
 *   priority   ROUTINE · CRITICAL (critical tasks drive the overdue sweep,
 *              notifications and audit logging).
 *   houseScoped  true → materialized once per business+date (footbath,
 *              lock-up…), not once per flock.
 *   linksTo    the existing data surface the task points at — the
 *              no-duplication contract: checklist rows only record
 *              completion, never values. Values live in the poultry
 *              module's feed / water / production / health records.
 *   helpText   short why/how hint shown under the label.
 *
 * The ESSENTIAL DAILY ROUTINE (shared core, both bird types, every stage)
 * comes first and is always present; stage tasks are additions, never
 * replacements. Owner customization happens on the template rows this
 * library seeds (origin STAGE_PLAN): labels, categories, assignments,
 * activation and scope are all editable per business; custom items
 * (origin CUSTOM) sit alongside and are never touched by system updates.
 */

export type StageTaskFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "STAGE_ONCE";
export type StageTaskPriority = "ROUTINE" | "CRITICAL";
export type StageTaskLinksTo =
  | "FEED_LOG"
  | "WATER_LOG"
  | "PRODUCTION_EGGS"
  | "WEIGHT"
  | "HEALTH_RECORD"
  | "MORTALITY"
  | "LIGHT_PROGRAM";

export interface StageTaskSeed {
  taskKey: string;
  taskLabel: string;
  category: string;
  birdType: "BROILERS" | "LAYERS" | null;
  stageKeys: string[] | null;
  frequency: StageTaskFrequency;
  priority: StageTaskPriority;
  houseScoped?: boolean;
  linksTo?: StageTaskLinksTo;
  helpText?: string;
}

/** linksTo → where the data lives (deep-link hint chips in the UI). */
export const LINKS_TO_LABEL: Record<StageTaskLinksTo, string> = {
  FEED_LOG: "Feed log",
  WATER_LOG: "Water log",
  PRODUCTION_EGGS: "Egg production log",
  WEIGHT: "Production / weight log",
  HEALTH_RECORD: "Health records",
  MORTALITY: "Health records (mortality)",
  LIGHT_PROGRAM: "Light program",
};

// ─── ESSENTIAL DAILY ROUTINE — shared core, every poultry flock ──────────
// (birdType null ⇒ also covers cockerels/turkeys/guinea fowl)
const CORE_ROUTINE: StageTaskSeed[] = [
  {
    taskKey: "MORNING_WALK", taskLabel: "Morning house walk — behaviour & alertness check",
    category: "HEALTH", birdType: null, stageKeys: null, frequency: "DAILY", priority: "ROUTINE",
    helpText: "Watch for huddling, panting, lameness or lethargy — early disease signals.",
  },
  {
    taskKey: "FEED_CHECK", taskLabel: "Verify feed in feeders & top up (current stage feed)",
    category: "FEEDING", birdType: null, stageKeys: null, frequency: "DAILY", priority: "ROUTINE",
    linksTo: "FEED_LOG", helpText: "Log quantities in the Poultry module → Feed.",
  },
  {
    taskKey: "WATER_CHECK", taskLabel: "Check & refill drinkers; flush lines if needed",
    category: "WATER", birdType: null, stageKeys: null, frequency: "DAILY", priority: "ROUTINE",
    linksTo: "WATER_LOG", helpText: "Birds drink ~2× what they eat — never let drinkers run dry.",
  },
  {
    taskKey: "TEMP_VENT_CHECK", taskLabel: "Check house temperature & ventilation",
    category: "ENVIRONMENT", birdType: null, stageKeys: null, frequency: "DAILY", priority: "ROUTINE",
    helpText: "Match the stage temperature curve; watch ammonia and dust.",
  },
  {
    taskKey: "MORTALITY_SWEEP", taskLabel: "Mortality sweep — remove, count & record",
    category: "HEALTH", birdType: null, stageKeys: null, frequency: "DAILY", priority: "CRITICAL",
    linksTo: "MORTALITY", helpText: "Record every bird in Health records with likely cause.",
  },
  {
    taskKey: "DATA_LOG_REMINDER", taskLabel: "Record today's feed, water & production data",
    category: "ADMIN", birdType: null, stageKeys: null, frequency: "DAILY", priority: "ROUTINE",
    linksTo: "FEED_LOG", helpText: "Feeds FCR, growth analytics, egg trends and benchmarks.",
  },
  {
    taskKey: "BIOSECURITY", taskLabel: "Footbath refresh & gate biosecurity check",
    category: "SECURITY", birdType: null, stageKeys: null, frequency: "DAILY", priority: "ROUTINE",
    houseScoped: true, helpText: "One visit per farm — disinfect, log visitors, keep wild birds out.",
  },
  {
    taskKey: "HOUSE_SECURE", taskLabel: "End-of-day house check & lock-up",
    category: "SECURITY", birdType: null, stageKeys: null, frequency: "DAILY", priority: "ROUTINE",
    houseScoped: true,
  },
];

// ─── BROILERS — day/age-based stages, placement → market ─────────────────
const BROILER_TASKS: StageTaskSeed[] = [
  // every stage
  {
    taskKey: "LITTER_CHECK", taskLabel: "Check litter condition — cake removal / top-up",
    category: "CLEANING", birdType: "BROILERS", stageKeys: null, frequency: "DAILY", priority: "ROUTINE",
    helpText: "Wet/caked litter drives breast blisters and coccidiosis.",
  },
  // PREP (before placement)
  {
    taskKey: "HOUSE_DISINFECT", taskLabel: "Wash, disinfect & rest the house",
    category: "CLEANING", birdType: "BROILERS", stageKeys: ["PREP"], frequency: "STAGE_ONCE", priority: "ROUTINE",
  },
  {
    taskKey: "LITTER_SPREAD", taskLabel: "Spread fresh litter & set chick guards",
    category: "CLEANING", birdType: "BROILERS", stageKeys: ["PREP"], frequency: "STAGE_ONCE", priority: "ROUTINE",
  },
  {
    taskKey: "BROODER_TEST", taskLabel: "Test brooders & pre-heat house to 33°C",
    category: "ENVIRONMENT", birdType: "BROILERS", stageKeys: ["PREP"], frequency: "STAGE_ONCE", priority: "CRITICAL",
    helpText: "House must be at temperature 24h before chicks arrive.",
  },
  {
    taskKey: "CHICK_SUPPLIES", taskLabel: "Chick starter feed, drinkers & supplements on hand",
    category: "STOCK", birdType: "BROILERS", stageKeys: ["PREP"], frequency: "STAGE_ONCE", priority: "ROUTINE",
  },
  // BROODING (days 1–7)
  {
    taskKey: "BROODER_TEMP_3X", taskLabel: "Brooder temperature check — 33→30°C (3× today)",
    category: "ENVIRONMENT", birdType: "BROILERS", stageKeys: ["BROODING"], frequency: "DAILY", priority: "CRITICAL",
    helpText: "Check at dawn, midday and dusk; watch chick distribution, not just the thermometer.",
  },
  {
    taskKey: "CROP_FILL_CHECK", taskLabel: "Crop-fill check — ≥95% of chicks by 24h",
    category: "HEALTH", birdType: "BROILERS", stageKeys: ["BROODING"], frequency: "STAGE_ONCE", priority: "CRITICAL",
    linksTo: "HEALTH_RECORD", helpText: "Sample ~30 chicks; empty crops at 24h mean feed/water access failure.",
  },
  {
    taskKey: "PAPER_FEED_REFRESH", taskLabel: "Refresh paper feed trays & chick access",
    category: "FEEDING", birdType: "BROILERS", stageKeys: ["BROODING"], frequency: "DAILY", priority: "ROUTINE",
  },
  {
    taskKey: "NIGHT_ROUND", taskLabel: "Night round — check huddling & pasting-up",
    category: "HEALTH", birdType: "BROILERS", stageKeys: ["BROODING"], frequency: "DAILY", priority: "ROUTINE",
  },
  // STARTER (days 8–14)
  {
    taskKey: "TEMP_STEPDOWN", taskLabel: "Step house temperature down ~1°C every 2–3 days",
    category: "ENVIRONMENT", birdType: "BROILERS", stageKeys: ["STARTER"], frequency: "DAILY", priority: "ROUTINE",
  },
  {
    taskKey: "SAMPLE_WEIGH_W1", taskLabel: "Sample-weigh ~1% of birds vs day-7 target",
    category: "PRODUCTION", birdType: "BROILERS", stageKeys: ["STARTER"], frequency: "STAGE_ONCE", priority: "ROUTINE",
    linksTo: "WEIGHT", helpText: "Benchmark target ≈ 190g at day 7.",
  },
  {
    taskKey: "GROWER_FEED_ORDER", taskLabel: "Order/confirm grower feed for the day-14 transition",
    category: "STOCK", birdType: "BROILERS", stageKeys: ["STARTER"], frequency: "STAGE_ONCE", priority: "ROUTINE",
  },
  // GROWER (days 15–28)
  {
    taskKey: "GROWER_TRANSITION", taskLabel: "Transition starter → grower feed (record in feed log)",
    category: "FEEDING", birdType: "BROILERS", stageKeys: ["GROWER"], frequency: "STAGE_ONCE", priority: "ROUTINE",
    linksTo: "FEED_LOG",
  },
  {
    taskKey: "WEEKLY_WEIGH", taskLabel: "Sample-weigh birds vs benchmark weight curve",
    category: "PRODUCTION", birdType: "BROILERS", stageKeys: ["GROWER", "FINISHER"], frequency: "WEEKLY", priority: "ROUTINE",
    linksTo: "WEIGHT", helpText: "~1% sample or ≥30 birds; compare against the flock's benchmark profile.",
  },
  {
    taskKey: "DENSITY_CHECK", taskLabel: "Check stocking density & space per bird",
    category: "PRODUCTION", birdType: "BROILERS", stageKeys: ["GROWER", "FINISHER"], frequency: "WEEKLY", priority: "ROUTINE",
  },
  {
    taskKey: "FEEDER_DRINKER_HEIGHT", taskLabel: "Adjust feeder & drinker heights to bird size",
    category: "MACHINERY", birdType: "BROILERS", stageKeys: ["GROWER", "FINISHER"], frequency: "WEEKLY", priority: "ROUTINE",
  },
  // FINISHER (day 29 → market)
  {
    taskKey: "FINISHER_TRANSITION", taskLabel: "Transition grower → finisher feed (record in feed log)",
    category: "FEEDING", birdType: "BROILERS", stageKeys: ["FINISHER"], frequency: "STAGE_ONCE", priority: "ROUTINE",
    linksTo: "FEED_LOG",
  },
  {
    taskKey: "WITHDRAWAL_REVIEW", taskLabel: "Review medications — confirm withdrawal periods for market",
    category: "HEALTH", birdType: "BROILERS", stageKeys: ["FINISHER", "MARKET"], frequency: "STAGE_ONCE", priority: "CRITICAL",
    linksTo: "HEALTH_RECORD", helpText: "No drug residues at slaughter — check every treatment given.",
  },
  // MARKET (final days)
  {
    taskKey: "FEED_WITHDRAWAL", taskLabel: "Withdraw feed 8–12h before catch & load-out",
    category: "FEEDING", birdType: "BROILERS", stageKeys: ["MARKET"], frequency: "STAGE_ONCE", priority: "CRITICAL",
    helpText: "Water stays on; empty guts reduce contamination at processing.",
  },
  {
    taskKey: "WITHDRAWAL_COMPLIANCE", taskLabel: "Certify withdrawal compliance for today's load-out",
    category: "HEALTH", birdType: "BROILERS", stageKeys: ["MARKET"], frequency: "DAILY", priority: "CRITICAL",
    linksTo: "HEALTH_RECORD",
  },
  {
    taskKey: "CATCH_CREW_PREP", taskLabel: "Confirm catch crew, crates & scale for load-out",
    category: "ADMIN", birdType: "BROILERS", stageKeys: ["MARKET"], frequency: "STAGE_ONCE", priority: "ROUTINE",
  },
  {
    taskKey: "LOADOUT_SUPERVISE", taskLabel: "Supervise weighing, crating & load-out",
    category: "PRODUCTION", birdType: "BROILERS", stageKeys: ["MARKET"], frequency: "DAILY", priority: "CRITICAL",
    linksTo: "WEIGHT",
  },
  {
    taskKey: "MARKET_DATA_LOG", taskLabel: "Record birds sold, weights & price in production log",
    category: "PRODUCTION", birdType: "BROILERS", stageKeys: ["MARKET"], frequency: "STAGE_ONCE", priority: "ROUTINE",
    linksTo: "WEIGHT",
  },
  // CLOSEOUT
  {
    taskKey: "CLOSEOUT_ECONOMICS", taskLabel: "Close batch — final FCR, mortality & economics vs benchmark",
    category: "FINANCE", birdType: "BROILERS", stageKeys: ["CLOSEOUT"], frequency: "STAGE_ONCE", priority: "ROUTINE",
    helpText: "Use the Benchmark panel's closeout projection for this flock.",
  },
  {
    taskKey: "BATCH_RECORDS_CLOSE", taskLabel: "Close batch records & mark the flock SOLD/CLOSED",
    category: "ADMIN", birdType: "BROILERS", stageKeys: ["CLOSEOUT"], frequency: "STAGE_ONCE", priority: "ROUTINE",
  },
  {
    taskKey: "HOUSE_RESET", taskLabel: "Wash & disinfect house; prep for the next placement",
    category: "CLEANING", birdType: "BROILERS", stageKeys: ["CLOSEOUT"], frequency: "STAGE_ONCE", priority: "ROUTINE",
  },
];

// ─── LAYERS — week/age-based stages, rearing → closeout ──────────────────
const LAYER_TASKS: StageTaskSeed[] = [
  // every stage
  {
    taskKey: "EGG_COLLECTION_AM", taskLabel: "Morning egg collection & tally",
    category: "PRODUCTION", birdType: "LAYERS", stageKeys: null, frequency: "DAILY", priority: "ROUTINE",
    linksTo: "PRODUCTION_EGGS", helpText: "Record eggs collected in the production log.",
  },
  {
    taskKey: "EGG_COLLECTION_PM", taskLabel: "Afternoon egg collection & tally",
    category: "PRODUCTION", birdType: "LAYERS", stageKeys: null, frequency: "DAILY", priority: "ROUTINE",
    linksTo: "PRODUCTION_EGGS",
  },
  // CHICK_BROODING (wk 0–6)
  {
    taskKey: "BROODER_TEMP_LAYER", taskLabel: "Brooder temperature check — 33→30°C step-down",
    category: "ENVIRONMENT", birdType: "LAYERS", stageKeys: ["CHICK_BROODING"], frequency: "DAILY", priority: "CRITICAL",
  },
  {
    taskKey: "CROP_FILL_LAYER", taskLabel: "Crop-fill check — ≥95% of chicks by 24h",
    category: "HEALTH", birdType: "LAYERS", stageKeys: ["CHICK_BROODING"], frequency: "STAGE_ONCE", priority: "CRITICAL",
    linksTo: "HEALTH_RECORD",
  },
  {
    taskKey: "CHICK_WEIGH", taskLabel: "Weekly chick sample-weigh vs body-weight standard",
    category: "PRODUCTION", birdType: "LAYERS", stageKeys: ["CHICK_BROODING", "GROWING"], frequency: "WEEKLY", priority: "ROUTINE",
    linksTo: "WEIGHT",
  },
  {
    taskKey: "BEAK_CHECK", taskLabel: "Check beak condition & treatment status",
    category: "HEALTH", birdType: "LAYERS", stageKeys: ["CHICK_BROODING"], frequency: "WEEKLY", priority: "ROUTINE",
  },
  // GROWING (wk 7–12)
  {
    taskKey: "FEED_RESTRAINT", taskLabel: "Controlled feeding — keep body weight on the standard curve",
    category: "FEEDING", birdType: "LAYERS", stageKeys: ["GROWING", "DEVELOPING"], frequency: "DAILY", priority: "CRITICAL",
    linksTo: "FEED_LOG", helpText: "Overweight pullets lay early and burn out; underweight delay lay.",
  },
  {
    taskKey: "UNIFORMITY_SPOT", taskLabel: "Uniformity spot check — flag spread >10%",
    category: "QUALITY", birdType: "LAYERS", stageKeys: ["GROWING", "DEVELOPING"], frequency: "WEEKLY", priority: "ROUTINE",
  },
  // DEVELOPING (wk 13–17)
  {
    taskKey: "UNIFORMITY_SAMPLE", taskLabel: "Full uniformity sample — target ≥85% within ±10%",
    category: "QUALITY", birdType: "LAYERS", stageKeys: ["DEVELOPING"], frequency: "STAGE_ONCE", priority: "ROUTINE",
    linksTo: "WEIGHT",
  },
  {
    taskKey: "TRANSFER_PREP", taskLabel: "Prepare lay house — nest boxes, perches, feeders",
    category: "ADMIN", birdType: "LAYERS", stageKeys: ["DEVELOPING"], frequency: "STAGE_ONCE", priority: "ROUTINE",
  },
  {
    taskKey: "LAY_FEED_ORDER", taskLabel: "Order layer mash / pre-lay calcium feed",
    category: "STOCK", birdType: "LAYERS", stageKeys: ["DEVELOPING"], frequency: "STAGE_ONCE", priority: "ROUTINE",
  },
  // PRE_LAY (wk 18–19)
  {
    taskKey: "LIGHT_STEPUP", taskLabel: "Light stimulation — step day length up per program",
    category: "PRODUCTION", birdType: "LAYERS", stageKeys: ["PRE_LAY", "EARLY_LAY"], frequency: "DAILY", priority: "CRITICAL",
    linksTo: "LIGHT_PROGRAM", helpText: "Step up ~30–60 min/week from 12h toward 16h by peak.",
  },
  {
    taskKey: "CALCIUM_TRANSITION", taskLabel: "Transition to layer mash with calcium for shells",
    category: "FEEDING", birdType: "LAYERS", stageKeys: ["PRE_LAY"], frequency: "STAGE_ONCE", priority: "CRITICAL",
    linksTo: "FEED_LOG",
  },
  {
    taskKey: "LAY_HOUSE_TRANSFER", taskLabel: "Transfer birds to the lay house — minimise stress, count",
    category: "PRODUCTION", birdType: "LAYERS", stageKeys: ["PRE_LAY"], frequency: "STAGE_ONCE", priority: "CRITICAL",
  },
  {
    taskKey: "FIRST_EGG_WATCH", taskLabel: "Watch & record the first eggs",
    category: "PRODUCTION", birdType: "LAYERS", stageKeys: ["PRE_LAY", "EARLY_LAY"], frequency: "DAILY", priority: "ROUTINE",
    linksTo: "PRODUCTION_EGGS",
  },
  // EARLY_LAY (wk 20–25)
  {
    taskKey: "LAY_RAMP_TRACK", taskLabel: "Track lay % ramp vs the benchmark curve",
    category: "PRODUCTION", birdType: "LAYERS", stageKeys: ["EARLY_LAY"], frequency: "DAILY", priority: "ROUTINE",
    linksTo: "PRODUCTION_EGGS",
  },
  {
    taskKey: "MIDDAY_COLLECTION", taskLabel: "Midday egg collection",
    category: "PRODUCTION", birdType: "LAYERS", stageKeys: ["EARLY_LAY", "PEAK"], frequency: "DAILY", priority: "ROUTINE",
    linksTo: "PRODUCTION_EGGS", helpText: "3× collection protects shell quality when output is highest.",
  },
  // PEAK (wk 26–38)
  {
    taskKey: "PEAK_VIGILANCE", taskLabel: "Peak-period stress check — water/feed intake & behaviour",
    category: "HEALTH", birdType: "LAYERS", stageKeys: ["PEAK"], frequency: "DAILY", priority: "ROUTINE",
  },
  {
    taskKey: "LAY_TRACK", taskLabel: "Record lay % vs peak benchmark (~92%)",
    category: "PRODUCTION", birdType: "LAYERS", stageKeys: ["PEAK", "MID_LAY"], frequency: "DAILY", priority: "ROUTINE",
    linksTo: "PRODUCTION_EGGS",
  },
  // MID_LAY (wk 39–60)
  {
    taskKey: "UNIFORMITY_MONTHLY", taskLabel: "Weigh sample & re-check flock uniformity",
    category: "QUALITY", birdType: "LAYERS", stageKeys: ["MID_LAY"], frequency: "MONTHLY", priority: "ROUTINE",
    linksTo: "WEIGHT",
  },
  {
    taskKey: "EGG_WEIGHT_TRACK", taskLabel: "Track egg weight vs curve (~62–64g)",
    category: "PRODUCTION", birdType: "LAYERS", stageKeys: ["MID_LAY", "LATE_LAY"], frequency: "MONTHLY", priority: "ROUTINE",
    linksTo: "PRODUCTION_EGGS",
  },
  // LATE_LAY (wk 61–80)
  {
    taskKey: "SHELL_QUALITY", taskLabel: "Shell quality check — cracks & thin shells; adjust calcium",
    category: "QUALITY", birdType: "LAYERS", stageKeys: ["LATE_LAY"], frequency: "DAILY", priority: "ROUTINE",
    linksTo: "PRODUCTION_EGGS",
  },
  {
    taskKey: "MOLT_DECISION", taskLabel: "Evaluate molting vs replacement economics",
    category: "FINANCE", birdType: "LAYERS", stageKeys: ["LATE_LAY"], frequency: "STAGE_ONCE", priority: "ROUTINE",
  },
  // CLOSEOUT (wk 81+)
  {
    taskKey: "SPENT_HEN_PLAN", taskLabel: "Plan spent-hen sale & replacement pullets",
    category: "FINANCE", birdType: "LAYERS", stageKeys: ["CLOSEOUT"], frequency: "STAGE_ONCE", priority: "ROUTINE",
  },
  {
    taskKey: "CLOSEOUT_ECONOMICS_LAYER", taskLabel: "Close batch — lifetime eggs, feed cost/egg & economics vs benchmark",
    category: "FINANCE", birdType: "LAYERS", stageKeys: ["CLOSEOUT"], frequency: "STAGE_ONCE", priority: "ROUTINE",
  },
  {
    taskKey: "BATCH_RECORDS_CLOSE_LAYER", taskLabel: "Close batch records & mark the flock SOLD/CLOSED",
    category: "ADMIN", birdType: "LAYERS", stageKeys: ["CLOSEOUT"], frequency: "STAGE_ONCE", priority: "ROUTINE",
  },
  {
    taskKey: "HOUSE_RESET_LAYER", taskLabel: "Wash & disinfect house; prep for the next flock",
    category: "CLEANING", birdType: "LAYERS", stageKeys: ["CLOSEOUT"], frequency: "STAGE_ONCE", priority: "ROUTINE",
  },
];

/** The full system stage plan: core routine first, then broiler + layer
 *  stage tasks. Order = sortOrder order on the seeded template rows. */
export const STAGE_PLAN_TASKS: StageTaskSeed[] = [
  ...CORE_ROUTINE,
  ...BROILER_TASKS,
  ...LAYER_TASKS,
];

/** The bird-type-agnostic daily core (used for the no-flock fallback and for
 *  bird types without a stage plan). */
export const CORE_ROUTINE_TASKS = CORE_ROUTINE;

export const STAGE_PLAN_TASK_KEYS = new Set(STAGE_PLAN_TASKS.map((t) => t.taskKey));
