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
import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
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
/** Businesses whose stage plan was already reconciled with this build in this
 *  process (the scan is a no-op after the first pass unless the build changes,
 *  and a deploy always starts new processes). */
const stagePlanSyncedAt = new Map<number, number>();
const STAGE_PLAN_SYNC_TTL_MS = 5 * 60 * 1000;

export async function ensureStagePlanTemplates(
  businessId: number,
  branchCode: string | null,
  opts?: { reactivate?: boolean }
) {
  const syncedAt = stagePlanSyncedAt.get(businessId);
  if (!opts?.reactivate && syncedAt !== undefined && Date.now() - syncedAt < STAGE_PLAN_SYNC_TTL_MS) {
    // Already reconciled in this process — one read instead of a hit-per-task
    // scan (and avoid the writes entirely, see the change-driven guards below).
    return db.select().from(checklistTemplates).where(eq(checklistTemplates.businessId, businessId));
  }
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
        // CHANGE-DRIVEN: a row whose metadata already matches this build is
        // NOT written. (The old code issued one UPDATE per task on every read —
        // ~30 round trips per checklist screen against a remote database.)
        const alreadyCurrent =
          found.birdType === t.birdType &&
          JSON.stringify(found.stageKeys ?? null) === JSON.stringify(t.stageKeys ?? null) &&
          (found.frequency ?? null) === (t.frequency ?? null) &&
          (found.priority ?? null) === (t.priority ?? null) &&
          !!found.houseScoped === !!t.houseScoped &&
          (!opts?.reactivate || found.isActive !== false);
        if (alreadyCurrent) {
          rows.push(found);
          continue;
        }
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
        const adoptedAlready =
          found.origin === "STAGE_PLAN" &&
          found.birdType === t.birdType &&
          JSON.stringify(found.stageKeys ?? null) === JSON.stringify(t.stageKeys ?? null) &&
          (found.frequency ?? null) === (t.frequency ?? null) &&
          (found.priority ?? null) === (t.priority ?? null) &&
          !!found.houseScoped === !!t.houseScoped &&
          (!opts?.reactivate || found.isActive !== false);
        if (adoptedAlready) {
          rows.push(found);
          continue;
        }
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
  stagePlanSyncedAt.set(businessId, Date.now());
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
/**
 * PROCESS-LEVEL MEMO: "this business's checklist for this date has already been
 * generated in this process".
 *
 * generateEntriesForDate() is idempotent but not free — an advisory lock plus
 * template and entry reads on EVERY call, and the checklist panel asks for
 * today's plan on every open. Against a remote database those round trips are
 * the whole cost of the screen (measured: /api/checklists ≈ 1 s at 40 ms RTT).
 *
 * The memo can never hide data: it only skips work that has already run
 * successfully in this process, it expires after 60 s, and every template
 * mutation invalidates it explicitly (invalidateChecklistGeneration), so a
 * newly added item still materialises immediately.
 */
const GENERATED_TTL_MS = 60_000;
const generatedAt = new Map<string, number>();

export function invalidateChecklistGeneration(businessId?: number): void {
  if (businessId === undefined) {
    generatedAt.clear();
    stagePlanSyncedAt.clear();
    return;
  }
  const prefix = `${businessId}:`;
  for (const k of [...generatedAt.keys()]) if (k.startsWith(prefix)) generatedAt.delete(k);
  stagePlanSyncedAt.delete(businessId);
}

function generationKey(businessId: number, branchCode: string | null, date: string): string {
  return `${businessId}:${branchCode || "-"}:${date}`;
}

export async function generateEntriesForDate(
  businessId: number,
  branchCode: string | null,
  date: string,
  bizCode?: string | null,
  bizCategory?: string | null
) {
  const genKey = generationKey(businessId, branchCode, date);
  const lastGenerated = generatedAt.get(genKey);
  if (lastGenerated !== undefined && Date.now() - lastGenerated < GENERATED_TTL_MS) {
    // Already generated in this process: skip the advisory lock, the template
    // read and the insert pass, and just hand back the rows for this date
    // (ONE round trip instead of five) — same return contract for callers.
    return db
      .select()
      .from(checklistEntries)
      .where(and(eq(checklistEntries.businessId, businessId), eq(checklistEntries.checklistDate, date)));
  }

  await ensureTemplates(businessId, branchCode, bizCode ?? null, bizCategory ?? null);

  const lockKey = genLockKey(businessId, date);

  // ── Concurrency + production-pooler safety (final audit) ────────────────
  // The whole critical section runs in ONE transaction guarded by a
  // TRANSACTION-scoped advisory lock:
  //   • `pg_advisory_xact_lock` is released automatically at COMMIT/ROLLBACK,
  //     so a crashed or timed-out request can never leave the lock held.
  //   • It is the ONLY advisory-lock flavour that is safe behind a
  //     transaction-mode connection pooler (Neon `-pooler` hosts, PgBouncer
  //     `?pgbouncer=true`): session-level `pg_advisory_lock()` /
  //     `pg_advisory_unlock()` can execute on DIFFERENT backend connections
  //     there, which orphaned the lock forever and hung every later
  //     generation for the same business+date (the checklist route then
  //     blocked until the function timed out).
  //   • Every read and insert below shares that single connection, so the
  //     "already materialized" check and the inserts are atomic — two app
  //     instances generating the same day concurrently can no longer
  //     duplicate tasks.
  // Side effects (push delivery, audit rows) are collected and fired AFTER
  // the commit: they must never hold the lock open or borrow a second
  // connection mid-transaction (that is what deadlocks a small pool).
  const pendingEffects: (() => Promise<unknown>)[] = [];
  const generated = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${lockKey})`);
    const templates = (
      await tx.select().from(checklistTemplates).where(eq(checklistTemplates.businessId, businessId))
    )
      .filter((t: any) => t.isActive !== false)
      .sort((a: any, b: any) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.id || 0) - (b.id || 0));

    const existing = await tx
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
      const flockRows = await tx
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
        // Runs on the transaction's connection (tx) — a raw pool query here
        // would borrow a SECOND connection while the lock transaction is
        // still open, which starves a small pool under load.
        const stageRows = await tx
          .selectDistinctOn([checklistEntries.flockId], {
            flockId: checklistEntries.flockId,
            stageKey: checklistEntries.stageKey,
            checklistDate: checklistEntries.checklistDate,
          })
          .from(checklistEntries)
          .where(
            and(
              eq(checklistEntries.businessId, businessId),
              inArray(checklistEntries.flockId, flockIds),
              isNotNull(checklistEntries.stageKey),
              ne(checklistEntries.checklistDate, date)
            )
          )
          .orderBy(checklistEntries.flockId, desc(checklistEntries.checklistDate), desc(checklistEntries.id));
        latestStage = stageRows.map((r: any) => ({
          flockId: Number(r.flockId),
          stageKey: String(r.stageKey),
          checklistDate: String(r.checklistDate),
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
        const profileRows = await tx
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
              // DEFERRED past the commit (see the transaction note at the top of
              // this function): push delivery + the audit row use their own DB
              // connection/network IO and must not run while the advisory-lock
              // transaction is open.
              const transition = {
                flock: { id: flockId, batchNumber: flock.batchNumber, birdType: flock.birdType },
                stage,
                businessId,
                branchCode: branchCode || flock.branchCode || null,
              };
              const transitionNote = `${flock.batchNumber} (${flock.birdType}) entered ${stage.label} at ${ageTxt} of age.${etaTxt} ${stage.transitionNote}`.trim();
              const transitionLabel = `${flock.batchNumber} → ${stage.label}`;
              pendingEffects.push(async () => {
                try {
                  await notifyPoultryStageTransition(transition as any);
                } catch (e: any) {
                  console.error("[checklistGen] stage transition notify failed:", e?.message || e);
                }
                auditLog(
                  { id: 0, name: "Checklist Engine", role: "SYSTEM" },
                  "POULTRY_STAGE_TRANSITION",
                  "Flock",
                  transitionLabel,
                  "OPERATION_LOG",
                  flockId,
                  businessId,
                  branchCode || flock.branchCode || null,
                  transitionNote,
                  (await ownerOrgOfBusiness(businessId).catch(() => null)) ?? null
                ).catch(() => {});
              });
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
      const [r] = await tx.insert(checklistEntries).values(row).returning();
      inserted.push(r);
    }
    return [...existing, ...inserted];
  }); // COMMIT here — the advisory lock is released by the server immediately.

  generatedAt.set(genKey, Date.now()); // success → skip the lock + reads for the next 60 s
  for (const effect of pendingEffects) {
    try {
      await effect();
    } catch (e: any) {
      console.error("[checklistGen] deferred post-commit effect failed:", e?.message || e);
    }
  }
  return generated;
}

// In-process guard so a single server run never re-announces the same
// (flock, date, stage) transition when generateEntriesForDate re-runs.
const STAGE_TRANSITION_ANNOUNCED = new Set<string>();
const verifiedTodayBiz = new Set<string>();

/**
 * ensureTodayFor — the /api/init hook: guarantee every scoped business has
 * its daily checklist for `today` (plus template defaults). Called BEFORE the
 * big parallel select so the same response already carries the fresh rows.
 * In-process memoization skips the query completely after the first pass of the day.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function ensureTodayFor(businessIds: number[] | null, today: string) {
  if (typeof today !== "string" || !DATE_RE.test(today)) return; // never interpolate anything else
  if (businessIds !== null && businessIds.length > 0 && businessIds.every((id) => verifiedTodayBiz.has(`${today}:${id}`))) {
    return;
  }
  // One round trip for the whole convergence check: the scoped business list
  // AND the set of businesses that already have entries for today, in a single
  // multi-statement query.
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
    const bid = Number(b.id);
    if (!have.has(bid)) {
      await generateEntriesForDate(bid, b?.code || null, today, b?.code, b?.category);
    }
    verifiedTodayBiz.add(`${today}:${bid}`);
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
  // A flock's own template rows change what today's plan must contain →
  // never let the 60 s generation memo hand back the pre-mutation result.
  invalidateChecklistGeneration(businessId);
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
  invalidateChecklistGeneration(businessId); // see forkFlockPlan
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
  invalidateChecklistGeneration(businessId); // see forkFlockPlan
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

/**
 * Materialise an explicit task list into the canonical daily-checklist store.
 *
 * Poultry / aquaculture / block-factory each had their own checklist table and
 * a route handler writing to it. Those tables are retired (P3): the modules'
 * legacy-compatible checklist endpoints now write HERE, into the same
 * `checklist_entries` the shared engine reads and the audit trail is built on.
 *
 * Idempotent per (businessId, checklistDate): when the day already has entries
 * they are returned untouched with `alreadyExists: true` — the contract the
 * legacy endpoints always advertised.
 */
export async function insertDailyEntries(opts: {
  businessId: number;
  branchCode?: string | null;
  date: string;
  tasks: { taskKey: string; taskLabel: string; category?: string | null }[];
}): Promise<{ items: any[]; alreadyExists: boolean }> {
  const { businessId, date } = opts;
  const branchCode = opts.branchCode ?? null;
  const existing = await db
    .select()
    .from(checklistEntries)
    .where(and(eq(checklistEntries.businessId, businessId), eq(checklistEntries.checklistDate, date)));
  if (existing.length > 0) {
    return { items: existing.sort((a: any, b: any) => (a.id || 0) - (b.id || 0)), alreadyExists: true };
  }
  const rows: any[] = [];
  for (const t of opts.tasks || []) {
    const [row] = await db
      .insert(checklistEntries)
      .values({
        businessId,
        branchCode,
        checklistDate: date,
        taskKey: t.taskKey,
        taskLabel: t.taskLabel,
        category: t.category || "GENERAL",
        isCompleted: false,
      })
      .returning();
    rows.push(row);
  }
  return { items: rows, alreadyExists: false };
}

/**
 * Toggle one canonical checklist entry (shared by the legacy-compatible module
 * endpoints). Returns null when the row does not exist.
 */
export async function toggleChecklistEntry(
  id: number,
  actor: { name?: string | null; role?: string | null } = {},
): Promise<any | null> {
  const [existing] = await db.select().from(checklistEntries).where(eq(checklistEntries.id, Number(id)));
  if (!existing) return null;
  const nowCompleted = !existing.isCompleted;
  const [row] = await db
    .update(checklistEntries)
    .set({
      isCompleted: nowCompleted,
      completedByName: nowCompleted ? actor.name || "Staff" : null,
      completedByRole: nowCompleted ? actor.role || null : null,
      completedAt: nowCompleted ? new Date() : null,
    })
    .where(eq(checklistEntries.id, Number(id)))
    .returning();
  return row;
}
