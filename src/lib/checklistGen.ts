import { db } from "@/db";
import { checklistTemplates, checklistEntries, businesses } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { tasksForBusiness, type TaskSeed } from "./checklistDefaults";

/**
 * checklistGen — shared daily-checklist seeding (A–Z audit M6).
 *
 * Previously /api/checklists seeded TEMPLATE defaults lazily, but a business's
 * TODAY checklist only appeared when a manager manually clicked "Generate" —
 * so a fresh install showed "Enterprise 0/0 tasks · No checklist yet" on the
 * Command Center forever. This module gives every caller the same two
 * idempotent primitives so provisioning, the checklists route, and /api/init
 * all converge on the same behaviour: a business ALWAYS has default templates
 * and today's checklist.
 */

/** Seed the template master list for a business exactly once. */
export async function ensureTemplates(businessId: number, branchCode: string | null, bizCode?: string | null, bizCategory?: string | null) {
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

/** Build the checklist for one date from ACTIVE templates (idempotent). */
export async function generateEntriesForDate(businessId: number, branchCode: string | null, date: string, bizCode?: string | null, bizCategory?: string | null) {
  await ensureTemplates(businessId, branchCode, bizCode ?? null, bizCategory ?? null);
  const existing = await db
    .select()
    .from(checklistEntries)
    .where(and(eq(checklistEntries.businessId, businessId), eq(checklistEntries.checklistDate, date)));
  if (existing.length > 0) return existing;
  const active = (await db.select().from(checklistTemplates).where(eq(checklistTemplates.businessId, businessId)))
    .filter((t: any) => t.isActive !== false)
    .sort((a: any, b: any) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.id || 0) - (b.id || 0));
  const rows = [];
  for (const t of active) {
    const [row] = await db
      .insert(checklistEntries)
      .values({
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
      })
      .returning();
    rows.push(row);
  }
  return rows;
}

/**
 * ensureTodayFor — the /api/init hook: guarantee every scoped business has
 * its daily checklist for `today` (plus template defaults). Called BEFORE the
 * big parallel select so the same response already carries the fresh rows.
 * One tiny aggregate probe decides whether any work is needed, so steady-state
 * cost is ~1 query (generates only on the first init of the day per business).
 */
export async function ensureTodayFor(businessIds: number[] | null, today: string) {
  const missing: number[] = [];
  const bizRows = await db
    .select({ id: businesses.id, code: businesses.code, category: businesses.category })
    .from(businesses);
  // null scope ⇒ Super Admin ⇒ every business; empty array ⇒ nothing scoped.
  const scoped = businessIds === null ? bizRows : bizRows.filter((b) => businessIds.includes(Number(b.id)));
  if (!scoped.length) return;
  for (const b of scoped) {
    const existing = await db
      .select({ id: checklistEntries.id })
      .from(checklistEntries)
      .where(and(eq(checklistEntries.businessId, Number(b.id)), eq(checklistEntries.checklistDate, today)))
      .limit(1);
    if (existing.length === 0) missing.push(Number(b.id));
  }
  for (const id of missing) {
    const b = scoped.find((x) => Number(x.id) === id);
    await generateEntriesForDate(id, b?.code || null, today, b?.code, b?.category);
  }
}
