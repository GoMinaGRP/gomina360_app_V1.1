// seed-notes-history — TEST-history helper for the daily-notes E2E suite.
// Files ONE backdated daily note through the exact production analysis/fold
// path (analyzeNote → insert → foldNoteIntoInsights → upsert) so multi-day
// trend assertions can be made deterministically. Never used by the app.
//
//   npx tsx dev-tooling/seed-notes-history.mts <businessId> <YYYY-MM-DD> "<content>" <userId> <userName> <userRole>
import { db } from "@/db";
import { businessInsights, businesses, dailyNotes } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { analyzeNote, foldNoteIntoInsights, EMPTY_INSIGHTS } from "@/lib/dailyNotesAi";

const [businessIdStr, noteDate, content, userIdStr, userName, userRole] = process.argv.slice(2);
if (!businessIdStr || !noteDate || !content) {
  console.error("usage: seed-notes-history.mts <businessId> <date> <content> [userId] [userName] [userRole]");
  process.exit(1);
}
const businessId = Number(businessIdStr);

const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
if (!biz) throw new Error("business not found");

const [insightRow] = await db.select().from(businessInsights).where(eq(businessInsights.businessId, businessId));
const prior = insightRow
  ? {
      notesAnalyzed: insightRow.notesAnalyzed || 0,
      lastNoteDate: insightRow.lastNoteDate ?? null,
      rollingSummary: insightRow.rollingSummary ?? null,
      issueRegister: (insightRow.issueRegister as any[]) || [],
      categoryTrends: (insightRow.categoryTrends as any) || {},
      history: (insightRow.history as any[]) || [],
    }
  : JSON.parse(JSON.stringify(EMPTY_INSIGHTS));

const analysis = analyzeNote(content, prior.history as any);
const [note] = await db
  .insert(dailyNotes)
  .values({
    businessId,
    branchCode: biz.code || null,
    noteDate,
    userId: userIdStr ? Number(userIdStr) : null,
    userName: userName || "TEST History Seed",
    userRole: userRole || "WORKER",
    content,
    wordCount: content.split(/\s+/).filter(Boolean).length,
    aiSummary: analysis.summary,
    aiIssues: analysis.issues,
    aiSeverity: analysis.severity,
    aiFlags: analysis.flags,
  })
  .returning();

const next = foldNoteIntoInsights(prior, { noteDate, analysis });
if (insightRow) {
  await db
    .update(businessInsights)
    .set({
      notesAnalyzed: next.notesAnalyzed,
      lastNoteDate: next.lastNoteDate,
      rollingSummary: next.rollingSummary,
      issueRegister: next.issueRegister,
      categoryTrends: next.categoryTrends,
      history: next.history,
      updatedAt: new Date(),
    })
    .where(eq(businessInsights.id, insightRow.id));
} else {
  await db.insert(businessInsights).values({
    businessId,
    notesAnalyzed: next.notesAnalyzed,
    lastNoteDate: next.lastNoteDate,
    rollingSummary: next.rollingSummary,
    issueRegister: next.issueRegister,
    categoryTrends: next.categoryTrends,
    history: next.history,
  });
}
console.log(JSON.stringify({ ok: true, noteId: note.id, severity: analysis.severity, flags: analysis.flags }));
process.exit(0);
