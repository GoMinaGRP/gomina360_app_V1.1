import { db, getPool } from "@/db";
import {
  checklistTemplates,
  checklistEntries,
  checklistFlockPlans,
  checklistPlanTemplates,
  businesses,
  poultryFlocks,
  poultryBenchmarkProfiles,
  notifications,
} from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { tasksForBusiness, type TaskSeed } from "./checklistDefaults";
import { STAGE_PLAN_TASKS } from "./poultryStageTasks";
import { stageOfFlock, isStagePlanBirdType, effectivePlanItemsForFlock, type FlockStage } from "./poultryStages";
import { resolveProfile, BENCHMARK_TEMPLATES } from "./poultryBenchmarking";
import { notifyPoultryStageTransition, notifyChecklistOverdue, ownerOrgOfBusiness } from "./notify";
import { auditLog } from "./audit";
import { getSystemMarker } from "./systemMarkers";

/**
 * checklistGen — shared daily-checklist seeding (A–Z audit M6).
 *
 * Three idempotent primitives so provisioning, the checklists route and
 * /api/init all converge on the same behaviour: a business ALWAYS has
 * default templates and today's checklist.
 *
 * POULTRY STAGE PLAN (age/stage-aware layer): when a poultry business has
 * STAGE_PLAN templates (default for newly created poultry businesses, or
 * enabled explicitly by the Owner), generation becomes flock-scoped:
 *
 *   • every ACTIVE flock gets its stage resolved from arrivalDate (via the
 *     benchmark profiles) and materializes the essential daily routine plus
 *     the tasks its bird type + stage call for;
 *   • DAILY tasks come every day in-stage, WEEKLY after 6 quiet days,
 *     MONTHLY after 29 quiet days, STAGE_ONCE once per flock per stage
 *     window (skipped ones don't re-appear inside the same stage);
 *   • house-scoped tasks (footbath, lock-up) materialize once per
 *     business+date, never once per flock;
 *   • Owner-custom items keep materializing at business level exactly as
 *     before (and can optionally be scoped to a bird type / stage);
 *   • stage changes are detected on generation and announced to managers
 *     (notification) and the audit trail;
 *   • CRITICAL tasks left incomplete past the cutoff (default 18:00) are
 *     swept into overdue notifications by /api/init or a manual SWEEP.
 *
 * Everything is additive: businesses without the stage plan (every
 * non-poultry business, and poultry businesses that never enabled it) get
 * byte-compatible behaviour with the previous engine.
 */

/** Poultry businesses default to the stage plan when first provisioned. */
export function isPoultryCategory(category?: string | null): boolean {
  return String(category || "").trim().toLowerCase() === "poultry farm";
}

/** Seed the template master list for a business exactly once. */
export async function ensureTemplates(
  businessId: number,
  branchCode: string | null,
  bizCode?: string | null,
  bizCategory?: string | null
) {
  const existing = await db
    .select()
    .from(checklistTemplates)
    .where(eq(checklistTemplates.businessId, businessId));
  if (existing.length > 0) return existing;

  // New poultry businesses start on the age/stage-aware plan.
  if (isPoultryCategory(bizCategory)) {
    return ensureStagePlanTemplates(businessId, branchCode);
  }

  const seeds: TaskSeed[] = tasksForBusiness(bizCode, bizCategory);
  const rows = [];
  for (let i = 0; i < seeds.length; i++) {
    const t = seeds[i];
    const [row] = await db
      .insert(checklistTemplates)
      .values({
        businessId,
        branchCode,
        taskKey: t.taskKey,
        taskLabel: t.taskLabel,
        category: t.category,
        sortOrder: i + 1,
        isActive: true,
      })
      .returning();
    rows.push(row);
  }
  return rows;
}

/**
 * Ensure the system poultry stage-plan template rows exist for a business.
 * Never touches rows the Owner customized: only inserts missing task keys
 * and (opt-in, via the STAGE_PLAN enable action) re-activates stage-plan
 * rows the Owner deactivated… no — deactivation is a deliberate Owner
 * choice, so re-activation happens ONLY on an explicit enable action.
 */
export async function ensureStagePlanTemplates(
  businessId: number,
  branchCode: string | null,
  opts?: { reactivate?: boolean }
) {
  const existing = await db
    .select()
    .from(checklistTemplates)
    .where(eq(checklistTemplates.businessId, businessId));
  const byKey = new Map(existing.map((t: any) => [t.taskKey, t]));
  let maxSort = Math.max(0, ...existing.map((t: any) => t.sortOrder || 0));

  const rows: any[] = [];
  let adopted = 0;
  for (const t of STAGE_PLAN_TASKS) {
    const found = byKey.get(t.taskKey);
    if (found) {
      if (found.origin === "STAGE_PLAN") {
        // Refresh ONLY system-owned rows, and only metadata the Owner hasn't
        // deliberately changed (activation stays untouched unless reactivate).
        await db
          .update(checklistTemplates)
          .set({
            birdType: t.birdType,
            stageKeys: t.stageKeys,
            frequency: t.frequency,
            priority: t.priority,
            houseScoped: !!t.houseScoped,
            ...(opts?.reactivate ? { isActive: true } : {}),
            updatedAt: new Date(),
          })
          .where(eq(checklistTemplates.id, found.id));
      } else {
        // ADOPTION — the Owner already had an item with this taskKey (e.g.
        // the demo's custom "Mortality sweep"). The Owner's wording, category,
        // assignment and activation always survive; the row gains the system
        // scope metadata (bird type / stage / frequency / priority) so the
        // flock-level plan stays complete instead of silently missing
        // critical tasks. Origin becomes STAGE_PLAN so future refreshes keep
        // its metadata in sync — the label stays the Owner's forever.
        await db
          .update(checklistTemplates)
          .set({
            origin: "STAGE_PLAN",
            birdType: t.birdType,
            stageKeys: t.stageKeys,
            frequency: t.frequency,
            priority: t.priority,
            houseScoped: !!t.houseScoped,
            ...(opts?.reactivate ? { isActive: true } : {}),
            updatedAt: new Date(),
          })
          .where(eq(checklistTemplates.id, found.id));
        adopted++;
        // keep the returned row in sync with what is now in the database
        Object.assign(found, {
          origin: "STAGE_PLAN",
          birdType: t.birdType,
          stageKeys: t.stageKeys,
          frequency: t.frequency,
          priority: t.priority,
          houseScoped: !!t.houseScoped,
          ...(opts?.reactivate ? { isActive: true } : {}),
        });
      }
      rows.push(found);
      continue;
    }
    maxSort += 1;
    const [row] = await db
      .insert(checklistTemplates)
      .values({
        businessId,
        branchCode,
        taskKey: t.taskKey,
        taskLabel: t.taskLabel,
        category: t.category,
        sortOrder: maxSort,
        isActive: true,
        origin: "STAGE_PLAN",
        birdType: t.birdType,
        stageKeys: t.stageKeys,
        frequency: t.frequency,
        priority: t.priority,
        houseScoped: !!t.houseScoped,
        createdByName: "GoMina Stage Plan",
        createdByRole: "SYSTEM",
      })
      .returning();
    rows.push(row);
  }
  if (adopted > 0) {
    console.log(`[checklistGen] stage plan: adopted ${adopted} existing item(s) whose task keys match system stage tasks (Owner labels/assignments kept)`);
  }
  return rows;
}

/** Deactivate every system stage-plan row (explicit Owner opt-out).
 *  History (dated entries) is preserved; CUSTOM items stay untouched. */
export async function disableStagePlanTemplates(businessId: number) {
  const rows = await db
    .update(checklistTemplates)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(checklistTemplates.businessId, businessId),
        eq(checklistTemplates.origin, "STAGE_PLAN")
      )
    )
    .returning();
  return rows.length;
}

// ─── Stage-plan generation helpers ────────────────────────────────────────

const dateShift = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

interface HistoryRow {
  flockId: number | null;
  taskKey: string;
  checklistDate: string;
  stageKey: string | null;
}

/** Is a task due for a flock on this date, given its materialization history? */
function isDue(
  t: { taskKey: string; frequency: string | null },
  flockId: number,
  stageKey: string,
  date: string,
  history: HistoryRow[]
): boolean {
  const freq = t.frequency || "DAILY";
  if (freq === "DAILY") return true;
  if (freq === "STAGE_ONCE") {
    return !history.some(
      (h) => h.flockId === flockId && h.taskKey === t.taskKey && h.stageKey === stageKey
    );
  }
  const windowDays = freq === "MONTHLY" ? 29 : 6; // WEEKLY
  const from = dateShift(date, -windowDays);
  return !history.some(
    (h) =>
      h.flockId === flockId &&
      h.taskKey === t.taskKey &&
      h.checklistDate >= from &&
      h.checklistDate <= date
  );
}

/**
 * A flock's EFFECTIVE plan: its own rows (per-flock lifecycle plan) replace
 * the system stage plan for that flock only; farm-wide custom scoped items
 * still apply on top (plan rows win on task-key collisions). One flock's
 * customization can never alter another flock or the business templates.
 */
/** Effective per-flock plan — delegates to the pure, client-shared helper
 *  in poultryStages.ts (single source of truth for plan semantics). */
export const effectivePlanForFlock = effectivePlanItemsForFlock;

/** advisory-lock key unique per (business, date) so concurrent init/module
 *  loads can't double-materialize a day. */
function genLockKey(businessId: number, date: string): number {
  const d = Number(date.replace(/-/g, "")) % 100000;
  return businessId * 100000 + d;
}

/** Build the checklist for one date (idempotent, incremental).
 *
 *  Past behavior is preserved: business-level templates materialize once per
 *  business+date. With the stage plan enabled, flock-scoped rows are added
 *  per ACTIVE flock at its current production stage, and re-runs only add
 *  what's missing (a flock registered mid-day still gets today's tasks). */
export async function generateEntriesForDate(
  businessId: number,
  branchCode: string | null,
  date: string,
  bizCode?: string | null,
  bizCategory?: string | null
) {
  await ensureTemplates(businessId, branchCode, bizCode ?? null, bizCategory ?? null);

  const lockKey = genLockKey(businessId, date);
  await db.execute(sql`select pg_advisory_lock(${lockKey})`);
  try {
    const templates = (
      await db.select().from(checklistTemplates).where(eq(checklistTemplates.businessId, businessId))
    )
      .filter((t: any) => t.isActive !== false)
      .sort((a: any, b: any) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.id || 0) - (b.id || 0));

    const existing = await db
      .select()
      .from(checklistEntries)
      .where(and(eq(checklistEntries.businessId, businessId), eq(checklistEntries.checklistDate, date)));
    // (taskKey, flockId|null) → already materialized for this date
    const have = new Set(existing.map((e: any) => `${e.taskKey}::${e.flockId ?? null}`));

    const baseEntry = (t: any, extra: any = {}) => ({
      businessId,
      branchCode,
      checklistDate: date,
      templateId: t.id,
      taskKey: t.taskKey,
      taskLabel: t.taskLabel,
      category: t.category || "GENERAL",
      assignedToUserId: t.assignedToUserId || null,
      assignedToName: t.assignedToName || null,
      assignedToRole: t.assignedToRole || null,
      isCompleted: false,
      frequency: t.frequency || null,
      priority: t.priority || null,
      ...extra,
    });

    const toInsert: any[] = [];
    const stageTemplates = templates.filter((t: any) => t.origin === "STAGE_PLAN");
    const customTemplates = templates.filter((t: any) => t.origin !== "STAGE_PLAN");

    // ── 1. Business-level items — exactly the previous behaviour ──────────
    // (templates without flock scope: the classic master list)
    for (const t of customTemplates) {
      if (t.birdType != null || t.stageKeys != null || t.houseScoped) continue; // scoped/custom stage items handled below
      if (have.has(`${t.taskKey}::null`)) continue;
      toInsert.push(baseEntry(t));
    }

    // Custom items the Owner scoped to a bird type / stage behave like
    // stage items: they materialize per flock.
    const customScoped = customTemplates.filter(
      (t: any) => t.birdType != null || t.stageKeys != null
    );

    // ── 2. Stage-plan generation (poultry businesses with the plan on) ────
    if (stageTemplates.length > 0 || customScoped.length > 0) {
      const flockRows = await db
        .select()
        .from(poultryFlocks)
        .where(eq(poultryFlocks.businessId, businessId));
      const activeFlocks = flockRows.filter(
        (f: any) => f.status === "ACTIVE" && !!f.arrivalDate
      );

      // History for due decisions + stage transitions — restricted to the
      // non-daily task keys and this business' flocks, so it stays tiny.
      const scopeTemplates = [...stageTemplates, ...customScoped];
      const flockIds = activeFlocks.map((f: any) => Number(f.id));
      const nonDailyKeys = Array.from(
        new Set(
          templates
            .filter((t: any) => (t.frequency || "DAILY") !== "DAILY")
            .map((t: any) => t.taskKey)
        )
      );
      let history: HistoryRow[] = [];
      let latestStage: { flockId: number; stageKey: string; checklistDate: string }[] = [];
      if (flockIds.length) {
        const freqRows = nonDailyKeys.length
          ? await db
              .select({
                flockId: checklistEntries.flockId,
                taskKey: checklistEntries.taskKey,
                checklistDate: checklistEntries.checklistDate,
                stageKey: checklistEntries.stageKey,
              })
              .from(checklistEntries)
              .where(
                and(
                  eq(checklistEntries.businessId, businessId),
                  inArray(checklistEntries.flockId, flockIds),
                  inArray(checklistEntries.taskKey, nonDailyKeys)
                )
              )
          : [];
        history = freqRows as HistoryRow[];
        // Latest recorded stage per flock (excluding this date — a re-run of
        // today must not "transition" against itself).
        const stageRows = (await getPool().query(
          `SELECT DISTINCT ON (flock_id) flock_id, stage_key, checklist_date
             FROM checklist_entries
            WHERE business_id = $1 AND flock_id = ANY($2) AND stage_key IS NOT NULL
              AND checklist_date <> $3
            ORDER BY flock_id, checklist_date DESC, id DESC`,
          [businessId, flockIds, date]
        )) as unknown as { rows: any[] };
        latestStage = stageRows.rows.map((r: any) => ({
          flockId: Number(r.flock_id),
          stageKey: String(r.stage_key),
          checklistDate: String(r.checklist_date),
        }));
      }

      // House-scoped BUSINESS-level stage tasks: once per business+date.
      // (House-scoped rows inside a flock's own plan belong to that flock
      // and materialize with it below.)
      for (const t of scopeTemplates.filter((t: any) => t.houseScoped && t.flockId == null)) {
        if (have.has(`${t.taskKey}::null`)) continue;
        toInsert.push(baseEntry(t, { birdType: t.birdType || null }));
      }

      if (activeFlocks.length) {
        const profileRows = await db
          .select()
          .from(poultryBenchmarkProfiles)
          .where(eq(poultryBenchmarkProfiles.businessId, businessId));
        const profilePool = [...(profileRows as any[]), ...BENCHMARK_TEMPLATES];

        for (const flock of activeFlocks) {
          const { profile } = resolveProfile(flock as any, profilePool as any);
          const stage: FlockStage | null = stageOfFlock(flock as any, date, profile as any);
          const flockId = Number(flock.id);
          // per-flock lifecycle plan (own rows) or the system stage plan
          const planTemplates = effectivePlanForFlock(flock as any, templates);

          // Stage-transition detection (forward-moving generations only, so
          // backfills of old dates never re-announce history).
          if (stage) {
            const last = latestStage.find((l) => l.flockId === flockId);
            const transKey = `${flockId}:${date}:${stage.stageKey}`;
            if (
              last &&
              last.checklistDate <= date &&
              last.stageKey !== stage.stageKey &&
              !STAGE_TRANSITION_ANNOUNCED.has(transKey)
            ) {
              STAGE_TRANSITION_ANNOUNCED.add(transKey);
              const ageTxt = stage.birdType === "LAYERS" ? `week ${stage.ageWeeks}` : `day ${stage.ageDays}`;
              const etaTxt =
                stage.marketEtaDays != null && stage.marketEtaDays > 0 && stage.phase === "MARKET"
                  ? ` ${stage.marketEtaDays} day(s) to market age.`
                  : "";
              try {
                await notifyPoultryStageTransition({
                  flock: { id: flockId, batchNumber: flock.batchNumber, birdType: flock.birdType },
                  stage,
                  businessId,
                  branchCode: branchCode || flock.branchCode || null,
                });
              } catch (e: any) {
                console.error("[checklistGen] stage transition notify failed:", e?.message || e);
              }
              auditLog(
                { id: 0, name: "Checklist Engine", role: "SYSTEM" },
                "POULTRY_STAGE_TRANSITION",
                "Flock",
                `${flock.batchNumber} → ${stage.label}`,
                "OPERATION_LOG",
                flockId,
                businessId,
                branchCode || flock.branchCode || null,
                `${flock.batchNumber} (${flock.birdType}) entered ${stage.label} at ${ageTxt} of age.${etaTxt} ${stage.transitionNote}`.trim(),
                (await ownerOrgOfBusiness(businessId).catch(() => null)) ?? null
              ).catch(() => {});
            }
          }

          for (const t of planTemplates) {
            if (t.houseScoped && t.flockId == null) continue; // already materialized farm-wide above
            if (have.has(`${t.taskKey}::${flockId}`)) continue;
            if (t.birdType != null && String(t.birdType).toUpperCase() !== String(flock.birdType).toUpperCase())
              continue;

            if (!stage) {
              // Bird type without a stage plan (cockerels, turkeys, …):
              // bird-type-agnostic daily core routine only.
              if (t.birdType != null) continue;
              if ((t.stageKeys?.length ?? 0) > 0) continue;
              if ((t.frequency || "DAILY") !== "DAILY") continue;
              toInsert.push(
                baseEntry(t, {
                  flockId,
                  batchNumber: flock.batchNumber,
                  birdType: flock.birdType,
                })
              );
              continue;
            }

            if (t.stageKeys != null && t.stageKeys.length > 0 && !t.stageKeys.includes(stage.stageKey))
              continue;
            if (t.stageKeys != null && t.stageKeys.length === 0) continue; // defensive: empty scope = never
            if (!isDue(t, flockId, stage.stageKey, date, history)) continue;

            toInsert.push(
              baseEntry(t, {
                flockId,
                batchNumber: flock.batchNumber,
                birdType: flock.birdType,
                stageKey: stage.stageKey,
                stageLabel: stage.label,
                ageDays: stage.ageDays,
              })
            );
          }
        }
      } else {
        // Poultry business with no ACTIVE flocks: the bird-type-agnostic
        // daily core routine still materializes once, at business level.
        for (const t of stageTemplates) {
          if (t.birdType != null || t.houseScoped) continue;
          if ((t.stageKeys?.length ?? 0) > 0) continue;
          if ((t.frequency || "DAILY") !== "DAILY") continue;
          if (have.has(`${t.taskKey}::null`)) continue;
          toInsert.push(baseEntry(t, { birdType: null }));
        }
      }
    }

    const inserted: any[] = [];
    for (const row of toInsert) {
      const [r] = await db.insert(checklistEntries).values(row).returning();
      inserted.push(r);
    }
    return [...existing, ...inserted];
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${lockKey})`).catch(() => {});
  }
}

// In-process guard so a single server run never re-announces the same
// (flock, date, stage) transition when generateEntriesForDate re-runs.
const STAGE_TRANSITION_ANNOUNCED = new Set<string>();

/**
 * ensureTodayFor — the /api/init hook: guarantee every scoped business has
 * its daily checklist for `today` (plus template defaults). Called BEFORE the
 * big parallel select so the same response already carries the fresh rows.
 * One tiny aggregate probe decides whether any work is needed, so steady-state
 * cost is ~1 query (generates only on the first init of the day per business).
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function ensureTodayFor(businessIds: number[] | null, today: string) {
  if (typeof today !== "string" || !DATE_RE.test(today)) return; // never interpolate anything else
  // One round trip for the whole convergence check: the scoped business list
  // AND the set of businesses that already have entries for today, in a single
  // multi-statement query. (This used to be 1 + N sequential selects — with a
  // remote database that alone added ~1 s to every cold dashboard load.)
  const ids =
    businessIds === null
      ? ""
      : ` WHERE "id" IN (${businessIds.map((n) => Math.trunc(Number(n))).filter(Number.isFinite).join(",") || "-1"})`;
  const scopedFilter =
    businessIds === null
      ? ""
      : ` AND "business_id" IN (${businessIds.map((n) => Math.trunc(Number(n))).filter(Number.isFinite).join(",") || "-1"})`;
  const results = (await getPool().query(
    `SELECT "id", "code", "category" FROM "businesses"${ids};` +
      `SELECT DISTINCT "business_id" FROM "checklist_entries" WHERE "checklist_date" = '${today}'${scopedFilter};`
  )) as unknown as any[];
  const scoped = results[0].rows as any[];
  if (!scoped.length) return;
  const have = new Set<number>(
    (results[1].rows as any[]).map((r) => Number(r.business_id)).filter(Number.isFinite)
  );
  for (const b of scoped) {
    if (!have.has(Number(b.id))) {
      await generateEntriesForDate(Number(b.id), b?.code || null, today, b?.code, b?.category);
    }
  }
}

// ─── Per-flock lifecycle plans ─────────────────────────────────────────────

interface Actor {
  id?: number;
  name?: string;
  role?: string;
}

/** Plan-state row for a flock (created on first explicit plan action). */
export async function upsertPlanState(
  businessId: number,
  branchCode: string | null,
  flock: { id: number; batchNumber: string },
  patch: { source: string; planTemplateId?: number | null; planTemplateName?: string | null },
  actor: Actor
) {
  const existing = await db
    .select()
    .from(checklistFlockPlans)
    .where(eq(checklistFlockPlans.flockId, Number(flock.id)));
  const values = {
    source: patch.source,
    planTemplateId: patch.planTemplateId ?? null,
    planTemplateName: patch.planTemplateName ?? null,
    updatedByName: actor.name || null,
    updatedByRole: actor.role || null,
    updatedAt: new Date(),
  };
  if (existing.length) {
    await db.update(checklistFlockPlans).set(values).where(eq(checklistFlockPlans.flockId, Number(flock.id)));
  } else {
    await db.insert(checklistFlockPlans).values({
      businessId,
      branchCode,
      flockId: Number(flock.id),
      batchNumber: flock.batchNumber,
      startedByName: actor.name || null,
      startedByRole: actor.role || null,
      startedAt: new Date(),
      ...values,
    });
  }
}

/** Copy the system stage plan (bird-type matched) into the flock's own rows —
 *  copy-on-write customization. Farm-wide custom items keep applying
 *  dynamically on top; other flocks and the system plan are untouched. */
export async function forkFlockPlan(
  businessId: number,
  branchCode: string | null,
  flock: any,
  actor: Actor
) {
  const all = await db.select().from(checklistTemplates).where(eq(checklistTemplates.businessId, businessId));
  const flockRows = all.filter((t: any) => t.flockId != null && Number(t.flockId) === Number(flock.id));
  if (flockRows.length) return { created: 0, rows: flockRows }; // already custom
  const stageRows = all.filter(
    (t: any) => t.origin === "STAGE_PLAN" && t.flockId == null && t.isActive !== false &&
      (t.birdType == null || String(t.birdType).toUpperCase() === String(flock.birdType).toUpperCase())
  );
  let maxSort = Math.max(0, ...all.map((t: any) => t.sortOrder || 0));
  const rows: any[] = [];
  for (const t of stageRows) {
    maxSort += 1;
    const [row] = await db
      .insert(checklistTemplates)
      .values({
        businessId,
        branchCode,
        flockId: Number(flock.id),
        taskKey: t.taskKey,
        taskLabel: t.taskLabel,
        category: t.category,
        sortOrder: maxSort,
        isActive: true,
        origin: "CUSTOM",
        birdType: t.birdType ?? flock.birdType,
        stageKeys: t.stageKeys ?? null,
        frequency: t.frequency ?? "DAILY",
        priority: t.priority ?? "ROUTINE",
        houseScoped: !!t.houseScoped,
        createdByName: actor.name || null,
        createdByRole: actor.role || null,
      })
      .returning();
    rows.push(row);
  }
  await upsertPlanState(businessId, branchCode, flock, { source: "CUSTOM" }, actor);
  return { created: rows.length, rows };
}

/** Apply a saved reusable plan template to a flock (replaces its own rows). */
export async function applyPlanTemplateToFlock(
  businessId: number,
  branchCode: string | null,
  flock: any,
  template: { id: number; name: string; items: any[] },
  actor: Actor
) {
  await db
    .delete(checklistTemplates)
    .where(and(eq(checklistTemplates.businessId, businessId), eq(checklistTemplates.flockId, Number(flock.id))));
  const all = await db.select().from(checklistTemplates).where(eq(checklistTemplates.businessId, businessId));
  let maxSort = Math.max(0, ...all.map((t: any) => t.sortOrder || 0));
  const rows: any[] = [];
  for (const item of template.items || []) {
    if (!item?.taskKey || !item?.taskLabel) continue;
    maxSort += 1;
    const [row] = await db
      .insert(checklistTemplates)
      .values({
        businessId,
        branchCode,
        flockId: Number(flock.id),
        taskKey: String(item.taskKey),
        taskLabel: String(item.taskLabel),
        category: item.category || "GENERAL",
        sortOrder: maxSort,
        isActive: item.isActive !== false,
        origin: "CUSTOM",
        birdType: item.birdType ?? flock.birdType,
        stageKeys: Array.isArray(item.stageKeys) ? item.stageKeys : null,
        frequency: item.frequency || "DAILY",
        priority: item.priority || "ROUTINE",
        houseScoped: !!item.houseScoped,
        assignedToUserId: item.assignedToUserId ? Number(item.assignedToUserId) : null,
        assignedToName: item.assignedToName || null,
        assignedToRole: item.assignedToRole || null,
        createdByName: actor.name || null,
        createdByRole: actor.role || null,
      })
      .returning();
    rows.push(row);
  }
  await upsertPlanState(
    businessId,
    branchCode,
    flock,
    { source: "TEMPLATE", planTemplateId: template.id, planTemplateName: template.name },
    actor
  );
  return { created: rows.length, rows };
}

/** Reset a flock to the recommended system stage plan (its own rows are
 *  deleted; dated entries/history are preserved). */
export async function resetFlockPlan(businessId: number, flock: any, actor: Actor) {
  const removed = await db
    .delete(checklistTemplates)
    .where(and(eq(checklistTemplates.businessId, businessId), eq(checklistTemplates.flockId, Number(flock.id))))
    .returning();
  await upsertPlanState(businessId, flock.branchCode || null, flock, { source: "SYSTEM" }, actor);
  return removed.length;
}

/** Snapshot a flock's effective plan as a reusable template. */
export async function saveFlockPlanAsTemplate(
  businessId: number,
  branchCode: string | null,
  flock: any,
  name: string,
  actor: Actor
) {
  const all = (await db
    .select()
    .from(checklistTemplates)
    .where(eq(checklistTemplates.businessId, businessId))) as any[];
  // Snapshot what this flock actually runs: its effective plan filtered to
  // its bird type (the same rule the generator applies at materialization —
  // a layer flock's template must not carry broiler-only tasks).
  const plan = effectivePlanForFlock(flock, all.filter((t: any) => t.isActive !== false)).filter(
    (t: any) => t.birdType == null || String(t.birdType).toUpperCase() === String(flock.birdType).toUpperCase()
  );
  const items = plan.map((t: any) => ({
    taskKey: t.taskKey,
    taskLabel: t.taskLabel,
    category: t.category || "GENERAL",
    birdType: t.birdType ?? null,
    stageKeys: t.stageKeys ?? null,
    frequency: t.frequency || "DAILY",
    priority: t.priority || "ROUTINE",
    houseScoped: !!t.houseScoped,
    assignedToUserId: t.assignedToUserId ?? null,
    assignedToName: t.assignedToName ?? null,
    assignedToRole: t.assignedToRole ?? null,
  }));
  const [row] = await db
    .insert(checklistPlanTemplates)
    .values({
      businessId,
      branchCode,
      name,
      birdType: String(flock.birdType || "").toUpperCase(),
      items,
      createdByName: actor.name || null,
      createdByRole: actor.role || null,
    })
    .returning();
  return row;
}

// ─── Overdue-critical sweep ───────────────────────────────────────────────

export const DEFAULT_OVERDUE_CUTOFF_HOUR = 18;

/** Per-business overdue cutoff hour (Owner-configurable), via system marker. */
export async function overdueCutoffHourFor(businessId: number): Promise<number> {
  const raw = await getSystemMarker(`checklist:overdueCutoffHour:${businessId}`);
  // null/"" (marker absent) must fall back to the 18:00 default — Number(null)
  // is 0, which would silently move the sweep to midnight on fresh installs.
  const n = raw == null || String(raw).trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.trunc(n) : DEFAULT_OVERDUE_CUTOFF_HOUR;
}

/**
 * Sweep incomplete CRITICAL checklist tasks for today. Runs from /api/init
 * (fire-and-forget) and the manual SWEEP action. One notification per
 * business+date goes to the managers and the assigned staff — deduped by
 * recordRef so repeated sweeps never spam.
 */
export async function sweepOverdueCritical(
  businessIds: number[] | null,
  opts?: { cutoffHour?: number }
): Promise<{ swept: number; businesses: number }> {
  const today = new Date().toLocaleDateString("en-CA");
  const ids = (businessIds || []).map((n) => Math.trunc(Number(n))).filter(Number.isFinite);
  const rows = await db
    .select()
    .from(checklistEntries)
    .where(
      and(
        eq(checklistEntries.checklistDate, today),
        eq(checklistEntries.priority, "CRITICAL"),
        eq(checklistEntries.isCompleted, false),
        ...(ids.length ? [inArray(checklistEntries.businessId, ids)] : [])
      )
    );
  if (!rows.length) return { swept: 0, businesses: 0 };

  // Group per (business, flock) — flock-linked notifications, dedup per date.
  const byGroup = new Map<string, { bizId: number; flockId: number | null; entries: any[] }>();
  for (const r of rows as any[]) {
    const fid = r.flockId != null ? Number(r.flockId) : null;
    const k = `${Number(r.businessId)}:${fid ?? "farm"}`;
    if (!byGroup.has(k)) byGroup.set(k, { bizId: Number(r.businessId), flockId: fid, entries: [] });
    byGroup.get(k)!.entries.push(r);
  }

  const flocksById = new Map<number, any>();
  const flockIds = [...new Set([...byGroup.values()].map((g) => g.flockId).filter((n): n is number => !!n))];
  if (flockIds.length) {
    const fr = await db.select().from(poultryFlocks).where(inArray(poultryFlocks.id, flockIds));
    for (const f of fr as any[]) flocksById.set(Number(f.id), f);
  }

  let swept = 0;
  for (const { bizId, flockId, entries } of byGroup.values()) {
    const cutoff = opts?.cutoffHour ?? (await overdueCutoffHourFor(bizId));
    if (new Date().getHours() < cutoff) continue;
    const recordRef = `checklist-overdue:${bizId}:${flockId ?? "farm"}:${today}`;
    const legacyRef = `checklist-overdue:${bizId}:${today}`;
    const already = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.type, "CHECKLIST_OVERDUE"),
          inArray(notifications.recordRef, [recordRef, legacyRef])
        )
      )
      .limit(1);
    if (already.length) continue;
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, bizId));
    await notifyChecklistOverdue({
      businessId: bizId,
      branchCode: (entries[0] as any).branchCode || biz?.code || null,
      date: today,
      flock: flockId ? flocksById.get(flockId) || { id: flockId, batchNumber: `Flock #${flockId}` } : null,
      tasks: entries as any[],
    });
    swept += 1;
  }
  return { swept, businesses: new Set([...byGroup.values()].map((g) => g.bizId)).size };
}
