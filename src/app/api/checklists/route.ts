import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import {
  checklistTemplates,
  checklistEntries,
  checklistFlockPlans,
  checklistPlanTemplates,
  poultryFlocks,
  businesses,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { advisorSectionsForBusiness, isFarmAdvisor } from "@/lib/auth";
import { canViewSection, farmModuleOfBusiness } from "@/lib/advisorSections";
import {
  ensureTemplates,
  generateEntriesForDate,
  ensureStagePlanTemplates,
  disableStagePlanTemplates,
  sweepOverdueCritical,
  overdueCutoffHourFor,
  isPoultryCategory,
  forkFlockPlan,
  applyPlanTemplateToFlock,
  resetFlockPlan,
  saveFlockPlanAsTemplate,
  upsertPlanState,
} from "@/lib/checklistGen";
import { stageKeysOfBirdType, isStagePlanBirdType } from "@/lib/poultryStages";
import { setSystemMarker } from "@/lib/systemMarkers";
import { auditLog } from "@/lib/audit";
import { ownerOrgOfBusiness } from "@/lib/notify";
import { apiError } from "@/lib/apiError";

// Roles allowed to manage checklist templates and generate daily checklists.
const MANAGE_ROLES = ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"];

/** Resolve a flock that belongs to the given business (or null). */
async function flockForBusiness(businessId: number, flockId: number) {
  const [flock] = await db.select().from(poultryFlocks).where(eq(poultryFlocks.id, Number(flockId)));
  if (!flock || Number(flock.businessId) !== Number(businessId)) return null;
  return flock;
}

/** After a flock-plan change: drop today's INCOMPLETE entries for the flock
 *  (completed history is preserved) and re-materialize today from the new
 *  plan — same-day plan edits are WYSIWYG. */
async function regenerateTodayForFlock(
  businessId: number,
  branchCode: string | null,
  biz: any,
  flockId: number
) {
  const todayLocal = new Date().toLocaleDateString("en-CA");
  await db
    .delete(checklistEntries)
    .where(
      and(
        eq(checklistEntries.businessId, businessId),
        eq(checklistEntries.flockId, Number(flockId)),
        eq(checklistEntries.checklistDate, todayLocal),
        eq(checklistEntries.isCompleted, false)
      )
    );
  const entries = await generateEntriesForDate(businessId, branchCode, todayLocal, biz?.code, biz?.category);
  return (entries as any[]).filter((e) => Number(e.flockId) === Number(flockId)).length;
}

export async function GET(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const businessId = Number(searchParams.get("businessId"));
    if (!businessId) {
      return NextResponse.json({ success: false, error: "businessId required" }, { status: 400 });
    }
    // Scope gate: checklist templates & dated entries stay inside the
    // caller's accessible businesses.
    if (!(await canAccessBusiness(__authSession.user, businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }
    const branchCode = searchParams.get("branchCode");
    const date = searchParams.get("date");

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));

    // ── Farm Advisor section gate ────────────────────────────────────────
    // The checklist is a per-section surface: an advisor only receives it
    // when the OWNER allowed that unit's checklist section (Poultry →
    // CHECKLIST, Aquaculture → HEALTH (Tasks & Activities), Livestock →
    // OPERATIONS). Everything else 403s before a single row is read.
    if (isFarmAdvisor(__authSession.user)) {
      const moduleKey = farmModuleOfBusiness(biz || null);
      const sectionKey =
        moduleKey === "POULTRY" ? "CHECKLIST" : moduleKey === "AQUA" ? "HEALTH" : moduleKey === "LIVESTOCK" ? "OPERATIONS" : null;
      const secs = await advisorSectionsForBusiness(__authSession.user, businessId);
      if (!sectionKey || !canViewSection(secs, sectionKey)) {
        return FORBIDDEN("The farm owner has not given you access to this unit's checklist.");
      }
    }
    const templates = await ensureTemplates(businessId, branchCode || biz?.code || null, biz?.code, biz?.category);

    // A read about TODAY auto-provisions today's daily checklist (idempotent)
    // — any surface that looks at "today" (module panel, Command Center)
    // therefore always sees the live plan instead of an empty day. Past or
    // future dates are never fabricated.
    const todayLocal = new Date().toLocaleDateString("en-CA");
    if (!date || date === todayLocal) {
      await generateEntriesForDate(businessId, branchCode || biz?.code || null, todayLocal, biz?.code, biz?.category);
    }

    let entryQuery = db.select().from(checklistEntries).where(eq(checklistEntries.businessId, businessId));
    let entries = await entryQuery;
    if (date) entries = entries.filter((e: any) => e.checklistDate === date);

    // Per-flock lifecycle plan context (poultry only): flock plan states,
    // saved reusable plan templates, and the minimal flock list used by the
    // Bird Type / Flock filters.
    let flockPlans: any[] = [];
    let planTemplates: any[] = [];
    let poultryFlockList: any[] = [];
    if (isPoultryCategory(biz?.category)) {
      flockPlans = await db.select().from(checklistFlockPlans).where(eq(checklistFlockPlans.businessId, businessId));
      planTemplates = await db
        .select()
        .from(checklistPlanTemplates)
        .where(eq(checklistPlanTemplates.businessId, businessId));
      const flockRows = await db
        .select({
          id: poultryFlocks.id,
          batchNumber: poultryFlocks.batchNumber,
          flockName: poultryFlocks.flockName,
          birdType: poultryFlocks.birdType,
          breed: poultryFlocks.breed,
          status: poultryFlocks.status,
          arrivalDate: poultryFlocks.arrivalDate,
          houseName: poultryFlocks.houseName,
          initialCount: poultryFlocks.initialCount,
          currentCount: poultryFlocks.currentCount,
          branchCode: poultryFlocks.branchCode,
        })
        .from(poultryFlocks)
        .where(eq(poultryFlocks.businessId, businessId));
      poultryFlockList = (flockRows as any[])
        .slice()
        .sort((a, b) => String(a.arrivalDate || "").localeCompare(String(b.arrivalDate || "")) || a.id - b.id);
    }

    return NextResponse.json({
      success: true,
      templates: templates
        .slice()
        .sort((a: any, b: any) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.id || 0) - (b.id || 0)),
      entries: entries.slice().sort((a: any, b: any) => (a.id || 0) - (b.id || 0)),
      flockPlans,
      planTemplates: planTemplates
        .slice()
        .sort((a: any, b: any) => (a.id || 0) - (b.id || 0)),
      poultryFlocks: poultryFlockList,
      cutoffHour: await overdueCutoffHourFor(businessId),
    });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { entity, data } = body;
    const businessId = Number(data?.businessId);
    if (!entity || !businessId) {
      return NextResponse.json({ success: false, error: "entity and businessId required" }, { status: 400 });
    }
    if (!(await canAccessBusiness(__authSession.user, businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }
    // Authorization comes from the signed-in session — NEVER from a
    // client-supplied role field in the request body.
    const role = String(__authSession.user.role || "").toUpperCase();
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    const branchCode = data.branchCode || biz?.code || null;
    const today = new Date().toISOString().split("T")[0];

    const needsManage = entity === "TEMPLATE" || entity === "GENERATE" || entity === "FLOCK_PLAN";
    if (needsManage && !MANAGE_ROLES.includes(role)) {
      return NextResponse.json(
        { success: false, error: "Only the Owner or an authorized manager can create or change checklists" },
        { status: 403 },
      );
    }

    // ── TEMPLATE: add a new checklist item to the master list ─────────
    if (entity === "TEMPLATE") {
      const label = String(data.taskLabel || "").trim();
      if (!label) {
        return NextResponse.json({ success: false, error: "Task label is required" }, { status: 400 });
      }
      const templates = await ensureTemplates(businessId, branchCode, biz?.code, biz?.category);
      const taskKey =
        String(data.taskKey || label)
          .toUpperCase()
          .trim()
          .replace(/\s+/g, "_")
          .replace(/[^A-Z0-9_&-]/g, "") || `TASK_${Date.now()}`;
      // Optional flock scoping: the item lives in ONE flock's own plan
      // (per-flock customization). Auto-forks the flock's plan first so a
      // single added item never wipes the system stage plan for that flock.
      let flock: any = null;
      if (data.flockId != null && data.flockId !== "") {
        if (!isPoultryCategory(biz?.category)) {
          return NextResponse.json({ success: false, error: "Flock-scoped checklist items are only available for Poultry Farm businesses" }, { status: 400 });
        }
        flock = await flockForBusiness(businessId, Number(data.flockId));
        if (!flock) {
          return NextResponse.json({ success: false, error: "Flock not found in this business" }, { status: 404 });
        }
        const forked = await forkFlockPlan(businessId, branchCode, flock, {
          id: (__authSession.user as any).id,
          name: data.actorName || (__authSession.user as any).name,
          role,
        });
        const scope = forked.rows.map((t: any) => t.taskKey);
        if (scope.includes(taskKey)) {
          return NextResponse.json({ success: false, error: `"${taskKey}" already exists in this flock's plan` }, { status: 409 });
        }
      } else if (templates.some((t: any) => t.taskKey === taskKey)) {
        return NextResponse.json({ success: false, error: `"${taskKey}" already exists in this checklist` }, { status: 409 });
      }
      // Optional stage-plan scoping for custom items (poultry businesses):
      // birdType + stageKeys + frequency + priority make the item materialize
      // per flock instead of once per business.
      const birdType = isStagePlanBirdType(data.birdType)
        ? String(data.birdType).toUpperCase()
        : flock
          ? String(flock.birdType || "").toUpperCase()
          : null;
      let stageKeys: string[] | null = null;
      if (Array.isArray(data.stageKeys)) {
        const valid = birdType
          ? stageKeysOfBirdType(birdType)
          : [...stageKeysOfBirdType("BROILERS"), ...stageKeysOfBirdType("LAYERS")];
        stageKeys = data.stageKeys.map(String).filter((k: any) => valid.includes(k));
      }
      const frequency = ["DAILY", "WEEKLY", "MONTHLY", "STAGE_ONCE"].includes(String(data.frequency || "").toUpperCase())
        ? String(data.frequency).toUpperCase()
        : "DAILY";
      const priority = String(data.priority || "").toUpperCase() === "CRITICAL" ? "CRITICAL" : "ROUTINE";
      const maxSort = Math.max(0, ...templates.map((t: any) => t.sortOrder || 0));
      const [row] = await db
        .insert(checklistTemplates)
        .values({
          businessId,
          branchCode,
          flockId: flock ? Number(flock.id) : null,
          taskKey,
          taskLabel: label,
          category: data.category || "GENERAL",
          sortOrder: maxSort + 1,
          isActive: true,
          origin: "CUSTOM",
          birdType,
          stageKeys: stageKeys && stageKeys.length ? stageKeys : null,
          frequency,
          priority,
          houseScoped: birdType == null && stageKeys == null ? false : !!data.houseScoped,
          assignedToUserId: data.assignedToUserId ? Number(data.assignedToUserId) : null,
          assignedToName: data.assignedToName || null,
          assignedToRole: data.assignedToRole || null,
          createdByName: data.createdByName || null,
          createdByRole: data.createdByRole || null,
        })
        .returning();
      if (flock) {
        const n = await regenerateTodayForFlock(businessId, branchCode, biz, Number(flock.id));
        auditLog(
          __authSession.user,
          "CHECKLIST_ITEM_ADDED_FLOCK",
          "Flock Checklist Plan",
          `${flock.batchNumber}: ${label}`,
          "POULTRY_FLOCK",
          Number(flock.id),
          businessId,
          branchCode,
          `Checklist item "${label}" added to flock ${flock.batchNumber}'s plan by ${(__authSession.user as any).name || "manager"}; today regenerated (${n} entries)`,
          (await ownerOrgOfBusiness(businessId).catch(() => null)) ?? null
        ).catch(() => {});
      } else if (isPoultryCategory(biz?.category)) {
        auditLog(
          __authSession.user,
          "CHECKLIST_ITEM_ADDED",
          "Checklist Template",
          label,
          "CHECKLIST",
          row.id,
          businessId,
          branchCode,
          `Checklist item "${label}" added to the farm checklist by ${(__authSession.user as any).name || "manager"}`,
          (await ownerOrgOfBusiness(businessId).catch(() => null)) ?? null
        ).catch(() => {});
      }
      return NextResponse.json({ success: true, item: row });
    }

    // ── STAGE_PLAN: Owner opt-in / opt-out for the poultry age/stage plan ─
    if (entity === "STAGE_PLAN") {
      const action = String(data.action || "").toLowerCase();
      if (action !== "enable" && action !== "disable") {
        return NextResponse.json({ success: false, error: "action must be 'enable' or 'disable'" }, { status: 400 });
      }
      if (!isPoultryCategory(biz?.category)) {
        return NextResponse.json({ success: false, error: "The stage plan is only available for Poultry Farm businesses" }, { status: 400 });
      }
      if (action === "enable") {
        const rows = await ensureStagePlanTemplates(businessId, branchCode, { reactivate: true });
        auditLog(
          __authSession.user,
          "POULTRY_STAGE_PLAN_ENABLED",
          "Poultry Stage Plan",
          biz?.name || String(businessId),
          "CHECKLIST",
          null,
          businessId,
          branchCode,
          `Age/stage checklist plan enabled for ${biz?.name || `business #${businessId}`} (${rows.filter((t: any) => t.origin === "STAGE_PLAN").length} system items) by ${(__authSession.user as any).name || "manager"}`,
          (await ownerOrgOfBusiness(businessId).catch(() => null)) ?? null
        ).catch(() => {});
        if (data.cutoffHour !== undefined) {
          const h = Number(data.cutoffHour);
          if (Number.isFinite(h) && h >= 0 && h <= 23) {
            await setSystemMarker(`checklist:overdueCutoffHour:${businessId}`, String(Math.trunc(h)));
          }
        }
        // Materialize today immediately so the Owner sees the plan live.
        const todayLocal = new Date().toLocaleDateString("en-CA");
        const entries = await generateEntriesForDate(businessId, branchCode || biz?.code || null, todayLocal, biz?.code, biz?.category);
        return NextResponse.json({
          success: true,
          stagePlan: "enabled",
          templates: rows.filter((t: any) => t.origin === "STAGE_PLAN").length,
          entriesToday: entries.length,
          cutoffHour: await overdueCutoffHourFor(businessId),
        });
      }
      const deactivated = await disableStagePlanTemplates(businessId);
      auditLog(
        __authSession.user,
        "POULTRY_STAGE_PLAN_DISABLED",
        "Poultry Stage Plan",
        biz?.name || String(businessId),
        "CHECKLIST",
        null,
        businessId,
        branchCode,
        `Age/stage checklist plan disabled for ${biz?.name || `business #${businessId}`} (${deactivated} system items deactivated) by ${(__authSession.user as any).name || "manager"}`,
        (await ownerOrgOfBusiness(businessId).catch(() => null)) ?? null
      ).catch(() => {});
      return NextResponse.json({ success: true, stagePlan: "disabled", deactivated });
    }

    // ── FLOCK_PLAN: per-flock lifecycle plan lifecycle ─────────────────
    if (entity === "FLOCK_PLAN") {
      const action = String(data.action || "").toLowerCase();
      const flockId = Number(data.flockId);
      if (!["fork", "apply_template", "reset", "save_as_template"].includes(action)) {
        return NextResponse.json({ success: false, error: "action must be 'fork', 'apply_template', 'reset' or 'save_as_template'" }, { status: 400 });
      }
      if (!flockId) {
        return NextResponse.json({ success: false, error: "flockId required" }, { status: 400 });
      }
      if (!isPoultryCategory(biz?.category)) {
        return NextResponse.json({ success: false, error: "Flock plans are only available for Poultry Farm businesses" }, { status: 400 });
      }
      const flock = await flockForBusiness(businessId, flockId);
      if (!flock) {
        return NextResponse.json({ success: false, error: "Flock not found in this business" }, { status: 404 });
      }
      const actor = {
        id: (__authSession.user as any).id,
        name: data.actorName || (__authSession.user as any).name || null,
        role,
      };
      const orgId = (await ownerOrgOfBusiness(businessId).catch(() => null)) ?? null;

      if (action === "fork") {
        const res = await forkFlockPlan(businessId, branchCode, flock, actor);
        const entriesToday = await regenerateTodayForFlock(businessId, branchCode, biz, flockId);
        auditLog(
          __authSession.user,
          "POULTRY_FLOCK_PLAN_FORKED",
          "Flock Checklist Plan",
          `${flock.batchNumber} (${flock.birdType})`,
          "POULTRY_FLOCK",
          flockId,
          businessId,
          branchCode,
          `Flock ${flock.batchNumber}'s plan customized (${res.created} items copied from the recommended system plan) by ${actor.name || "manager"}; today regenerated (${entriesToday} entries)`,
          orgId
        ).catch(() => {});
        return NextResponse.json({ success: true, action: "fork", created: res.created, items: res.rows.length, entriesToday });
      }

      if (action === "apply_template") {
        const planTemplateId = Number(data.planTemplateId);
        if (!planTemplateId) {
          return NextResponse.json({ success: false, error: "planTemplateId required" }, { status: 400 });
        }
        const [tpl] = await db
          .select()
          .from(checklistPlanTemplates)
          .where(eq(checklistPlanTemplates.id, planTemplateId));
        if (!tpl || Number(tpl.businessId) !== businessId) {
          return NextResponse.json({ success: false, error: "Plan template not found in this business" }, { status: 404 });
        }
        const res = await applyPlanTemplateToFlock(
          businessId,
          branchCode,
          flock,
          { id: Number(tpl.id), name: String(tpl.name), items: (tpl.items as any[]) || [] },
          actor
        );
        const entriesToday = await regenerateTodayForFlock(businessId, branchCode, biz, flockId);
        auditLog(
          __authSession.user,
          "POULTRY_FLOCK_PLAN_APPLIED",
          "Flock Checklist Plan",
          `${flock.batchNumber} → ${tpl.name}`,
          "POULTRY_FLOCK",
          flockId,
          businessId,
          branchCode,
          `Saved plan template "${tpl.name}" (${res.created} items) applied to flock ${flock.batchNumber} by ${actor.name || "manager"}; today regenerated (${entriesToday} entries)`,
          orgId
        ).catch(() => {});
        return NextResponse.json({ success: true, action: "apply_template", applied: res.created, planTemplate: tpl.name, entriesToday });
      }

      if (action === "reset") {
        const removed = await resetFlockPlan(businessId, flock, actor);
        const entriesToday = await regenerateTodayForFlock(businessId, branchCode, biz, flockId);
        auditLog(
          __authSession.user,
          "POULTRY_FLOCK_PLAN_RESET",
          "Flock Checklist Plan",
          `${flock.batchNumber} (${flock.birdType})`,
          "POULTRY_FLOCK",
          flockId,
          businessId,
          branchCode,
          `Flock ${flock.batchNumber}'s customized plan reset to the recommended system plan (${removed} customized items removed) by ${actor.name || "manager"}; today regenerated (${entriesToday} entries)`,
          orgId
        ).catch(() => {});
        return NextResponse.json({ success: true, action: "reset", removed, entriesToday });
      }

      // save_as_template
      const name = String(data.name || "").trim();
      if (!name) {
        return NextResponse.json({ success: false, error: "Template name required" }, { status: 400 });
      }
      const tpl = await saveFlockPlanAsTemplate(businessId, branchCode, flock, name, actor);
      auditLog(
        __authSession.user,
        "POULTRY_FLOCK_PLAN_SAVED_TEMPLATE",
        "Flock Checklist Plan",
        `${flock.batchNumber} → ${name}`,
        "CHECKLIST_PLAN_TEMPLATE",
        tpl ? Number(tpl.id) : null,
        businessId,
        branchCode,
        `Flock ${flock.batchNumber}'s plan saved as reusable template "${name}" (${tpl?.items?.length || 0} items) by ${actor.name || "manager"}`,
        orgId
      ).catch(() => {});
      return NextResponse.json({ success: true, action: "save_as_template", planTemplate: tpl });
    }

    // ── SWEEP: manual overdue-critical run (same engine /api/init uses) ──
    if (entity === "SWEEP") {
      const cutoffHour = data.cutoffHour !== undefined ? Number(data.cutoffHour) : undefined;
      const res = await sweepOverdueCritical([businessId], Number.isFinite(cutoffHour as number) ? { cutoffHour: Math.trunc(cutoffHour as number) } : undefined);
      return NextResponse.json({ success: true, sweep: res });
    }

    // ── GENERATE: build the checklist for a date from ACTIVE templates ─
    if (entity === "GENERATE") {
      const targetDate = data.checklistDate || today;
      const before = await db
        .select({ id: checklistEntries.id })
        .from(checklistEntries)
        .where(and(eq(checklistEntries.businessId, businessId), eq(checklistEntries.checklistDate, targetDate)));
      const rows = await generateEntriesForDate(businessId, branchCode, targetDate, biz?.code, biz?.category);
      return NextResponse.json({ success: true, items: rows, alreadyExists: before.length > 0 });
    }

    return NextResponse.json({ success: false, error: `Unknown entity: ${entity}` }, { status: 400 });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { entity, id, data } = body;
    if (!entity || !id) {
      return NextResponse.json({ success: false, error: "entity and id required" }, { status: 400 });
    }

    // ── ENTRY: toggle task completion, stamping user / role / time ─────
    if (entity === "ENTRY") {
      const [existing] = await db
        .select()
        .from(checklistEntries)
        .where(eq(checklistEntries.id, Number(id)));
      if (!existing) {
        return NextResponse.json({ success: false, error: "Checklist task not found" }, { status: 404 });
      }
      if (!(await canAccessBusiness(__authSession.user, existing.businessId))) {
        return FORBIDDEN("You do not have access to that business.");
      }
      // Assignment-aware completion: non-managers may only complete (or
      // re-open) tasks that are unassigned or assigned to THEM. Managers
      // and the Owner can action any task.
      const entryRole = String(__authSession.user.role || "").toUpperCase();
      if (!MANAGE_ROLES.includes(entryRole)) {
        const assigned = existing.assignedToUserId != null ? Number(existing.assignedToUserId) : null;
        const me = Number((__authSession.user as any).id);
        if (assigned !== null && assigned !== me) {
          return NextResponse.json(
            { success: false, error: "This task is assigned to another user — only they or a manager can complete it" },
            { status: 403 },
          );
        }
      }
      const nowCompleted = !existing.isCompleted;
      const [row] = await db
        .update(checklistEntries)
        .set({
          isCompleted: nowCompleted,
          completedByName: nowCompleted ? data?.completedByName || "Staff" : null,
          completedByRole: nowCompleted ? data?.completedByRole || null : null,
          completedAt: nowCompleted ? new Date() : null,
          notes: data?.notes !== undefined ? data.notes : existing.notes,
        })
        .where(eq(checklistEntries.id, Number(id)))
        .returning();
      // Critical completions are audit-trail events (food-safety-grade tasks:
      // withdrawal compliance, temperature checks, mortality sweeps…).
      if (nowCompleted && String(existing.priority || "").toUpperCase() === "CRITICAL") {
        const stageTxt = existing.stageLabel
          ? ` · ${existing.stageLabel}${existing.ageDays != null ? ` (day ${existing.ageDays})` : ""}`
          : "";
        auditLog(
          __authSession.user,
          "CHECKLIST_CRITICAL_DONE",
          "Daily Checklist",
          existing.taskLabel,
          "CHECKLIST",
          existing.id,
          existing.businessId,
          existing.branchCode,
          `Critical task completed${existing.batchNumber ? ` for flock ${existing.batchNumber}` : ""}${stageTxt} by ${data?.completedByName || "Staff"}`,
          (await ownerOrgOfBusiness(existing.businessId).catch(() => null)) ?? null
        ).catch(() => {});
      }
      return NextResponse.json({ success: true, item: row });
    }

    // ── TEMPLATE: edit label/category/assignment or activate/deactivate ─
    if (entity === "TEMPLATE") {
      // Authorization comes from the signed-in session — NEVER from a
      // client-supplied role field in the request body.
      const role = String(__authSession.user.role || "").toUpperCase();
      if (!MANAGE_ROLES.includes(role)) {
        return NextResponse.json(
          { success: false, error: "Only the Owner or an authorized manager can edit checklist items" },
          { status: 403 },
        );
      }
      const [existing] = await db
        .select()
        .from(checklistTemplates)
        .where(eq(checklistTemplates.id, Number(id)));
      if (!existing) {
        return NextResponse.json({ success: false, error: "Checklist item not found" }, { status: 404 });
      }
      if (!(await canAccessBusiness(__authSession.user, existing.businessId))) {
        return FORBIDDEN("You do not have access to that business.");
      }
      const [row] = await db
        .update(checklistTemplates)
        .set({
          taskLabel: data.taskLabel !== undefined ? String(data.taskLabel).trim() || existing.taskLabel : existing.taskLabel,
          category: data.category !== undefined ? data.category : existing.category,
          sortOrder: data.sortOrder !== undefined ? Number(data.sortOrder) : existing.sortOrder,
          isActive: data.isActive !== undefined ? Boolean(data.isActive) : existing.isActive,
          assignedToUserId: data.assignedToUserId !== undefined ? (data.assignedToUserId ? Number(data.assignedToUserId) : null) : existing.assignedToUserId,
          assignedToName: data.assignedToName !== undefined ? data.assignedToName : existing.assignedToName,
          assignedToRole: data.assignedToRole !== undefined ? data.assignedToRole : existing.assignedToRole,
          // Stage-plan metadata is Owner-editable too (priority, frequency,
          // scope) — the template row IS the customization surface.
          priority: data.priority !== undefined
            ? (String(data.priority).toUpperCase() === "CRITICAL" ? "CRITICAL" : "ROUTINE")
            : existing.priority,
          frequency: data.frequency !== undefined
            ? (["DAILY", "WEEKLY", "MONTHLY", "STAGE_ONCE"].includes(String(data.frequency).toUpperCase())
                ? String(data.frequency).toUpperCase()
                : existing.frequency)
            : existing.frequency,
          stageKeys: data.stageKeys !== undefined
            ? (Array.isArray(data.stageKeys)
                ? (() => {
                    const bt = String(data.birdType ?? existing.birdType ?? "").toUpperCase();
                    const valid = bt === "BROILERS" || bt === "LAYERS"
                      ? stageKeysOfBirdType(bt)
                      : [...stageKeysOfBirdType("BROILERS"), ...stageKeysOfBirdType("LAYERS")];
                    const picked = data.stageKeys.map(String).filter((k: any) => valid.includes(k));
                    return picked.length ? picked : null;
                  })()
                : null)
            : existing.stageKeys,
          birdType: data.birdType !== undefined
            ? (isStagePlanBirdType(data.birdType) ? String(data.birdType).toUpperCase() : null)
            : existing.birdType,
          updatedAt: new Date(),
        })
        .where(eq(checklistTemplates.id, Number(id)))
        .returning();
      // Audit poultry checklist edits (incl. assignment changes — "who is
      // responsible for this task" is a food-safety-relevant fact).
      const [tplBiz] = await db.select().from(businesses).where(eq(businesses.id, Number(existing.businessId)));
      if (isPoultryCategory(tplBiz?.category)) {
        const scopeTxt = existing.flockId != null ? `flock plan item ${existing.taskKey}` : `checklist item "${existing.taskLabel}"`;
        const assignChanged =
          (data.assignedToUserId !== undefined && Number(data.assignedToUserId || 0) !== Number(existing.assignedToUserId || 0)) ||
          (data.assignedToName !== undefined && data.assignedToName !== existing.assignedToName);
        auditLog(
          __authSession.user,
          assignChanged ? "CHECKLIST_ASSIGNMENT_CHANGED" : "CHECKLIST_ITEM_UPDATED",
          "Checklist Template",
          existing.taskLabel,
          "CHECKLIST",
          Number(id),
          Number(existing.businessId),
          existing.branchCode,
          `${scopeTxt} updated by ${(__authSession.user as any).name || "manager"}` +
            (assignChanged
              ? ` — assignment: ${existing.assignedToName || "unassigned"} → ${data.assignedToName || (data.assignedToUserId ? `user #${data.assignedToUserId}` : "unassigned")}`
              : ` (label: "${existing.taskLabel}", active: ${row.isActive}, priority: ${row.priority}, frequency: ${row.frequency})`),
          (await ownerOrgOfBusiness(Number(existing.businessId)).catch(() => null)) ?? null
        ).catch(() => {});
      }
      if (existing.flockId != null) {
        // Same-day visibility for flock-plan edits.
        await regenerateTodayForFlock(Number(existing.businessId), existing.branchCode || tplBiz?.code || null, tplBiz, Number(existing.flockId));
      }
      return NextResponse.json({ success: true, item: row });
    }

    return NextResponse.json({ success: false, error: `Unknown entity: ${entity}` }, { status: 400 });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const id = Number(searchParams.get("id"));
    const entity = String(searchParams.get("entity") || "TEMPLATE").toUpperCase();
    // Authorization comes from the signed-in session — NEVER from a
    // client-supplied ?role= query parameter.
    const role = String(__authSession.user.role || "").toUpperCase();
    if (!id) {
      return NextResponse.json({ success: false, error: "id required" }, { status: 400 });
    }
    if (!MANAGE_ROLES.includes(role)) {
      return NextResponse.json(
        { success: false, error: "Only the Owner or an authorized manager can remove checklist items" },
        { status: 403 },
      );
    }

    // ── PLAN_TEMPLATE: delete a saved reusable flock plan template ──────
    if (entity === "PLAN_TEMPLATE") {
      const [tpl] = await db
        .select()
        .from(checklistPlanTemplates)
        .where(eq(checklistPlanTemplates.id, id));
      if (!tpl) {
        return NextResponse.json({ success: false, error: "Plan template not found" }, { status: 404 });
      }
      if (!(await canAccessBusiness(__authSession.user, Number(tpl.businessId)))) {
        return FORBIDDEN("You do not have access to that business.");
      }
      await db.delete(checklistPlanTemplates).where(eq(checklistPlanTemplates.id, id));
      auditLog(
        __authSession.user,
        "POULTRY_PLAN_TEMPLATE_DELETED",
        "Flock Plan Template",
        String(tpl.name),
        "CHECKLIST_PLAN_TEMPLATE",
        id,
        Number(tpl.businessId),
        tpl.branchCode || null,
        `Reusable flock plan template "${tpl.name}" (${(tpl.items as any[])?.length || 0} items) deleted by ${(__authSession.user as any).name || "manager"}`,
        (await ownerOrgOfBusiness(Number(tpl.businessId)).catch(() => null)) ?? null
      ).catch(() => {});
      return NextResponse.json({ success: true, deleted: "PLAN_TEMPLATE" });
    }

    const [existing] = await db
      .select()
      .from(checklistTemplates)
      .where(eq(checklistTemplates.id, id));
    if (!existing) {
      return NextResponse.json({ success: false, error: "Checklist item not found" }, { status: 404 });
    }
    if (!(await canAccessBusiness(__authSession.user, existing.businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }
    await db.delete(checklistTemplates).where(eq(checklistTemplates.id, id));
    const [delBiz] = await db.select().from(businesses).where(eq(businesses.id, Number(existing.businessId)));
    if (existing.flockId != null) {
      // If that was the flock's last own row, its plan is effectively the
      // system plan again — reflect that in the plan state.
      const remaining = await db
        .select({ id: checklistTemplates.id })
        .from(checklistTemplates)
        .where(and(eq(checklistTemplates.businessId, Number(existing.businessId)), eq(checklistTemplates.flockId, Number(existing.flockId))));
      if (!remaining.length) {
        const [flockRow] = await db.select().from(poultryFlocks).where(eq(poultryFlocks.id, Number(existing.flockId)));
        if (flockRow) {
          await upsertPlanState(
            Number(existing.businessId),
            flockRow.branchCode || null,
            { id: Number(flockRow.id), batchNumber: String(flockRow.batchNumber) },
            { source: "SYSTEM" },
            { id: (__authSession.user as any).id, name: (__authSession.user as any).name, role }
          );
        }
      }
      await regenerateTodayForFlock(Number(existing.businessId), existing.branchCode || delBiz?.code || null, delBiz, Number(existing.flockId));
    }
    if (isPoultryCategory(delBiz?.category)) {
      auditLog(
        __authSession.user,
        "CHECKLIST_ITEM_DELETED",
        "Checklist Template",
        existing.taskLabel,
        "CHECKLIST",
        id,
        Number(existing.businessId),
        existing.branchCode,
        `${existing.flockId != null ? `Flock plan item "${existing.taskLabel}" removed` : `Checklist item "${existing.taskLabel}" removed`} by ${(__authSession.user as any).name || "manager"}`,
        (await ownerOrgOfBusiness(Number(existing.businessId)).catch(() => null)) ?? null
      ).catch(() => {});
    }
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return apiError(error);
  }
}
