import { db, getPool } from "@/db";
import { checklistTemplates, checklistEntries } from "@/db/schema";
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
