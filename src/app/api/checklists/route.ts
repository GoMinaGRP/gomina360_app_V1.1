import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  checklistTemplates,
  checklistEntries,
  businesses,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { tasksForBusiness, type TaskSeed } from "@/lib/checklistDefaults";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

// Roles allowed to manage checklist templates and generate daily checklists.
const MANAGE_ROLES = ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"];

// Seed the template master list for a business exactly once.
async function ensureTemplates(businessId: number, branchCode: string | null, bizCode: string | undefined, bizCategory?: string | null) {
  const existing = await db
    .select()
    .from(checklistTemplates)
    .where(eq(checklistTemplates.businessId, businessId));
  if (existing.length > 0) return existing;
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

export async function GET(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const businessId = Number(searchParams.get("businessId"));
    if (!businessId) {
      return NextResponse.json({ success: false, error: "businessId required" }, { status: 400 });
    }
    const branchCode = searchParams.get("branchCode");
    const date = searchParams.get("date");

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    const templates = await ensureTemplates(businessId, branchCode || biz?.code || null, biz?.code, biz?.category);

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
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
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
    const role = String(data?.createdByRole || data?.role || "").toUpperCase();
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
          assignedToUserId: data.assignedToUserId ? Number(data.assignedToUserId) : null,
          assignedToName: data.assignedToName || null,
          assignedToRole: data.assignedToRole || null,
          createdByName: data.createdByName || null,
          createdByRole: data.createdByRole || null,
        })
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    // ── GENERATE: build the checklist for a date from ACTIVE templates ─
    if (entity === "GENERATE") {
      const targetDate = data.checklistDate || today;
      await ensureTemplates(businessId, branchCode, biz?.code, biz?.category);
      const existing = await db
        .select()
        .from(checklistEntries)
        .where(
          and(
            eq(checklistEntries.businessId, businessId),
            eq(checklistEntries.checklistDate, targetDate),
          ),
        );
      if (existing.length > 0) {
        return NextResponse.json({ success: true, items: existing, alreadyExists: true });
      }
      const active = (
        await db.select().from(checklistTemplates).where(eq(checklistTemplates.businessId, businessId))
      )
        .filter((t: any) => t.isActive !== false)
        .sort((a: any, b: any) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.id || 0) - (b.id || 0));
      const rows = [];
      for (const t of active) {
        const [row] = await db
          .insert(checklistEntries)
          .values({
            businessId,
            branchCode,
            checklistDate: targetDate,
            templateId: t.id,
            taskKey: t.taskKey,
            taskLabel: t.taskLabel,
            category: t.category || "GENERAL",
            assignedToUserId: t.assignedToUserId || null,
            assignedToName: t.assignedToName || null,
            assignedToRole: t.assignedToRole || null,
            isCompleted: false,
          })
          .returning();
        rows.push(row);
      }
      return NextResponse.json({ success: true, items: rows });
    }

    return NextResponse.json({ success: false, error: `Unknown entity: ${entity}` }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
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
      return NextResponse.json({ success: true, item: row });
    }

    // ── TEMPLATE: edit label/category/assignment or activate/deactivate ─
    if (entity === "TEMPLATE") {
      const role = String(data?.role || data?.updatedByRole || "").toUpperCase();
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
          updatedAt: new Date(),
        })
        .where(eq(checklistTemplates.id, Number(id)))
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    return NextResponse.json({ success: false, error: `Unknown entity: ${entity}` }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const id = Number(searchParams.get("id"));
    const role = String(searchParams.get("role") || "").toUpperCase();
    if (!id) {
      return NextResponse.json({ success: false, error: "id required" }, { status: 400 });
    }
    if (!MANAGE_ROLES.includes(role)) {
      return NextResponse.json(
        { success: false, error: "Only the Owner or an authorized manager can remove checklist items" },
        { status: 403 },
      );
    }
    await db.delete(checklistTemplates).where(eq(checklistTemplates.id, id));
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
