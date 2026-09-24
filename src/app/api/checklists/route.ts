import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import {
  checklistTemplates,
  checklistEntries,
  businesses,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import {
  ensureTemplates,
  generateEntriesForDate,
  ensureStagePlanTemplates,
  disableStagePlanTemplates,
  sweepOverdueCritical,
  overdueCutoffHourFor,
  isPoultryCategory,
} from "@/lib/checklistGen";
import { stageKeysOfBirdType, isStagePlanBirdType } from "@/lib/poultryStages";
import { setSystemMarker } from "@/lib/systemMarkers";
import { auditLog } from "@/lib/audit";
import { ownerOrgOfBusiness } from "@/lib/notify";
import { apiError } from "@/lib/apiError";

// Roles allowed to manage checklist templates and generate daily checklists.
const MANAGE_ROLES = ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"];

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

    return NextResponse.json({
      success: true,
      templates: templates
        .slice()
        .sort((a: any, b: any) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.id || 0) - (b.id || 0)),
      entries: entries.slice().sort((a: any, b: any) => (a.id || 0) - (b.id || 0)),
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

    const needsManage = entity === "TEMPLATE" || entity === "GENERATE";
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
      if (templates.some((t: any) => t.taskKey === taskKey)) {
        return NextResponse.json({ success: false, error: `"${taskKey}" already exists in this checklist` }, { status: 409 });
      }
      // Optional stage-plan scoping for custom items (poultry businesses):
      // birdType + stageKeys + frequency + priority make the item materialize
      // per flock instead of once per business.
      const birdType = isStagePlanBirdType(data.birdType) ? String(data.birdType).toUpperCase() : null;
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
      return NextResponse.json({ success: true, stagePlan: "disabled", deactivated });
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
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return apiError(error);
  }
}
