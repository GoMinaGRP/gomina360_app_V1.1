// Daily Notes API — workers file end-of-day notes under the Daily Checklist;
// GoMina AI analyses each one (issues, severity, summary) and continuously
// updates the business' living history & insights.
//
//   GET    ?businessId=&date=YYYY-MM-DD — scoped notes (default today), the
//          AI daily summary for that date, and the rolling insights state.
//   POST   { businessId, content, noteDate? } — any active staff member with
//          access to the business. Runs the AI analysis and folds the result
//          into business_insights atomically.
//   DELETE { id } — author / manager / OWNER withdraws a note; the business
//          insights are rebuilt from the remaining notes so history stays true.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { businessInsights, businesses, dailyNotes } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { canAccessBusiness, getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";
import {
  analyzeNote,
  composeDaySummary,
  foldNoteIntoInsights,
  rebuildInsights,
  EMPTY_INSIGHTS,
  type HistoryEntry,
  type InsightsState,
  type NoteAnalysis,
} from "@/lib/dailyNotesAi";

const MANAGE_ROLES = ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"];
const MAX_LEN = 2000;

function toInsights(row: any): InsightsState {
  if (!row) return JSON.parse(JSON.stringify(EMPTY_INSIGHTS));
  return {
    notesAnalyzed: row.notesAnalyzed || 0,
    lastNoteDate: row.lastNoteDate ?? null,
    rollingSummary: row.rollingSummary ?? null,
    issueRegister: Array.isArray(row.issueRegister) ? row.issueRegister : [],
    categoryTrends: row.categoryTrends || {},
    history: Array.isArray(row.history) ? row.history : [],
  };
}

async function upsertInsights(businessId: number, state: InsightsState) {
  const [existing] = await db.select().from(businessInsights).where(eq(businessInsights.businessId, businessId));
  const payload = {
    notesAnalyzed: state.notesAnalyzed,
    lastNoteDate: state.lastNoteDate,
    rollingSummary: state.rollingSummary,
    issueRegister: state.issueRegister,
    categoryTrends: state.categoryTrends,
    history: state.history,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(businessInsights).set(payload).where(eq(businessInsights.id, existing.id));
  } else {
    await db.insert(businessInsights).values({ businessId, ...payload });
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const { searchParams } = new URL(request.url);
    const businessId = Number(searchParams.get("businessId"));
    if (!businessId) {
      return NextResponse.json({ success: false, error: "businessId required" }, { status: 400 });
    }
    if (!(await canAccessBusiness(user, businessId))) {
      return NextResponse.json({ success: false, error: "No access to this business." }, { status: 403 });
    }
    const date = searchParams.get("date") || new Date().toISOString().split("T")[0];

    const rows = await db
      .select()
      .from(dailyNotes)
      .where(eq(dailyNotes.businessId, businessId))
      .orderBy(asc(dailyNotes.id));
    const dayRows = rows.filter((r) => r.noteDate === date);
    const analyses = dayRows.map((r) => ({
      analysis: {
        summary: r.aiSummary || "",
        issues: (r.aiIssues as any[]) || [],
        severity: (r.aiSeverity as any) || "INFO",
        flags: (r.aiFlags as string[]) || [],
      } as NoteAnalysis,
    }));
    const daySummary = composeDaySummary(date, analyses);

    const [insightRow] = await db.select().from(businessInsights).where(eq(businessInsights.businessId, businessId));

    return NextResponse.json({
      success: true,
      date,
      notes: dayRows,
      daySummary,
      insights: toInsights(insightRow),
      totalNotes: rows.length,
      noteDates: Array.from(new Set(rows.map((r) => r.noteDate))).sort().reverse().slice(0, 30),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const body = await request.json();
    const businessId = Number(body?.businessId);
    if (!businessId) {
      return NextResponse.json({ success: false, error: "businessId required" }, { status: 400 });
    }
    if (!(await canAccessBusiness(user, businessId))) {
      return NextResponse.json({ success: false, error: "No access to this business." }, { status: 403 });
    }
    const content = String(body?.content || "").trim().slice(0, MAX_LEN);
    if (content.length < 10) {
      return NextResponse.json(
        { success: false, error: "Write at least a sentence (10+ characters) about the day — activities, observations, problems, notices." },
        { status: 400 },
      );
    }
    // Notes belong to real business days: today by default; yesterday allowed
    // for late-night filing. No future-dating, no deep back-dating.
    const today = new Date().toISOString().split("T")[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const noteDate = String(body?.noteDate || today).slice(0, 10);
    if (![today, yesterday].includes(noteDate)) {
      return NextResponse.json({ success: false, error: "Daily notes can only be filed for today or yesterday." }, { status: 400 });
    }

    // Branch context
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    if (!biz) return NextResponse.json({ success: false, error: "Business not found." }, { status: 404 });

    // Trend context = the unit's recorded history BEFORE this note.
    const [insightRow] = await db.select().from(businessInsights).where(eq(businessInsights.businessId, businessId));
    const prior = toInsights(insightRow);
    const analysis = analyzeNote(content, prior.history as HistoryEntry[]);

    const wordCount = content.split(/\s+/).filter(Boolean).length;
    const [note] = await db
      .insert(dailyNotes)
      .values({
        businessId,
        branchCode: biz.code || null,
        noteDate,
        userId: user.id ?? null,
        userName: user.name || "Staff",
        userRole: user.role || "WORKER",
        content,
        wordCount,
        aiSummary: analysis.summary,
        aiIssues: analysis.issues,
        aiSeverity: analysis.severity,
        aiFlags: analysis.flags,
      })
      .returning();

    // Continuous history update.
    const next = foldNoteIntoInsights(prior, { noteDate, analysis });
    await upsertInsights(businessId, next);

    return NextResponse.json({ success: true, note, analysis, insights: next });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const { searchParams } = new URL(request.url);
    const id = Number(searchParams.get("id"));
    if (!id) return NextResponse.json({ success: false, error: "id required" }, { status: 400 });

    const [note] = await db.select().from(dailyNotes).where(eq(dailyNotes.id, id));
    if (!note) return NextResponse.json({ success: false, error: "Note not found." }, { status: 404 });

    const mine = note.userId != null && Number(note.userId) === Number(user.id);
    const manager = MANAGE_ROLES.includes(String(user.role || "").toUpperCase());
    if (!mine && !manager) {
      return NextResponse.json({ success: false, error: "You can only withdraw your own notes." }, { status: 403 });
    }
    if (!(await canAccessBusiness(user, note.businessId))) {
      return NextResponse.json({ success: false, error: "No access to this business." }, { status: 403 });
    }

    await db.delete(dailyNotes).where(eq(dailyNotes.id, id));

    // Rebuild the insights register from the remaining notes so the running
    // history never carries a withdrawn day.
    const rest = await db
      .select()
      .from(dailyNotes)
      .where(eq(dailyNotes.businessId, note.businessId))
      .orderBy(asc(dailyNotes.id));
    const rebuilt = rebuildInsights(
      rest.map((r) => ({
        noteDate: r.noteDate,
        analysis: {
          summary: r.aiSummary || "",
          issues: (r.aiIssues as any[]) || [],
          severity: (r.aiSeverity as any) || "INFO",
          flags: (r.aiFlags as string[]) || [],
        } as NoteAnalysis,
      })),
    );
    if (rest.length === 0) {
      await db.delete(businessInsights).where(eq(businessInsights.businessId, note.businessId));
    } else {
      await upsertInsights(note.businessId, rebuilt);
    }
    return NextResponse.json({ success: true, deleted: true, insights: rebuilt });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
