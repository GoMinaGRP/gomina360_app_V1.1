import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { budgets, businesses, expenseCategories, transactions } from "@/db/schema";
import { getSessionInfo, accessibleBusinessIds, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { businessManageIdsOf } from "@/lib/permissions";

/**
 * Budgets & budget-vs-actual (P4, part 1).
 *
 *  GET   ?businessId=<id|all>&period=YYYY-MM — budget lines for the scope
 *        with LIVE actuals computed from transactions (the seeded Q1-2026
 *        baseline rows are excluded — a budget is a forward-looking control,
 *        not a restated account), variance, %-used and status; plus the
 *        category picker data and the periods that have budgets.
 *  POST  — upsert one budget line (owner/GM/unit-manager only, business
 *        re-verified) — one row per (business, period, branch, kind,
 *        category), amount replaced on edit.
 *  DELETE ?id= — remove a line (same gate).
 *
 * Tenant isolation: budgets are read/written only inside the caller's
 * accessible businesses; the ownerId tenant column mirrors the business's
 * organization exactly like supplier orders and goods receipts.
 */

const EXEC_ROLES = ["OWNER", "GENERAL_MANAGER"];
const isExec = (u: any) => !!u && (EXEC_ROLES.includes(String(u.role).toUpperCase()) || !!u.isSuperAdmin);
const isSeededBaseline = (t: any) => /^TRX-\d{4}-100[1-6]$/.test(String(t?.transactionNumber || ""));

function normPeriod(p: unknown): string | null {
  const v = String(p || "").trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : null;
}

function normKind(k: unknown): string | null {
  const v = String(k || "").toUpperCase();
  return v === "EXPENSE" || v === "REVENUE" ? v : null;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user;
    const { searchParams } = new URL(request.url);
    const allowed = await accessibleBusinessIds(user);
    const scopeParam = String(searchParams.get("businessId") || "all").toLowerCase();
    const period = normPeriod(searchParams.get("period")) || new Date().toISOString().slice(0, 7);
    const role = String(user.role || "").toUpperCase();
    if (role === "WORKER") return FORBIDDEN("Budgets are a management view.");

    let bizIds: number[];
    if (scopeParam === "all" || scopeParam === "0") {
      bizIds = allowed === null
        ? (await db.select({ id: businesses.id }).from(businesses)).map((b) => Number(b.id))
        : allowed;
    } else {
      const id = Number(scopeParam);
      if (!id) return NextResponse.json({ success: false, error: "bad businessId" }, { status: 400 });
      if (allowed !== null && !allowed.includes(id)) return FORBIDDEN("That business is outside your scope.");
      bizIds = [id];
    }
    if (!bizIds.length) {
      return NextResponse.json({ success: true, period, consolidated: scopeParam === "all", lines: [], totals: { expenseBudget: 0, expenseActual: 0, revenueBudget: 0, revenueActual: 0 }, categories: [], periods: [] });
    }

    // Budget lines in scope.
    const rows = await db
      .select()
      .from(budgets)
      .where(and(inArray(budgets.businessId, bizIds), eq(budgets.period, period)));
    const bizRows = await db.select({ id: businesses.id, name: businesses.name, code: businesses.code }).from(businesses).where(inArray(businesses.id, bizIds));
    const bizById = new Map(bizRows.map((b) => [Number(b.id), b]));

    // Live actuals per (business, kind, category) — branch-agnostic unless a
    // line is branch-scoped. Baseline rows excluded.
    const txnRows = await db
      .select({
        businessId: transactions.businessId,
        branchCode: transactions.branchCode,
        type: transactions.type,
        category: transactions.category,
        amountGhs: transactions.amountGhs,
        transactionNumber: transactions.transactionNumber,
        status: transactions.status,
      })
      .from(transactions)
      .where(and(inArray(transactions.businessId, bizIds), like(transactions.date, `${period}-%`)))
      .limit(4000);
    const live = txnRows.filter((t) => !isSeededBaseline(t) && (!t.status || t.status === "COMPLETED"));

    const lines = rows.map((b) => {
      const branchKey = (b.branchCode || "").toUpperCase();
      const isTotalLine = b.category === "TOTAL";
      // Actuals are computed by filtering the live month rows directly: a
      // business-wide line (branchCode "") sums EVERY branch of that
      // business; a branch-scoped line only its own register. The seeded
      // Q1-2026 baseline rows are already excluded from `live`.
      const actual = live
        .filter((t) => Number(t.businessId) === Number(b.businessId) && (t.type === "EXPENSE") === (b.kind === "EXPENSE"))
        .filter((t) => (branchKey ? String(t.branchCode || "").toUpperCase() === branchKey : true))
        .filter((t) => (isTotalLine ? true : t.category === b.category))
        .reduce((s, t) => s + Number(t.amountGhs || 0), 0);
      const budget = Number(b.amountGhs || 0);
      const variance = budget - actual;
      const pct = budget > 0 ? Math.round((actual / budget) * 1000) / 10 : actual > 0 ? null : 0;
      return {
        id: b.id,
        businessId: b.businessId,
        businessName: bizById.get(Number(b.businessId))?.name ?? null,
        businessCode: bizById.get(Number(b.businessId))?.code ?? null,
        branchCode: b.branchCode || null,
        period: b.period,
        kind: b.kind,
        category: b.category,
        budgetGhs: budget,
        actualGhs: Math.round(actual * 100) / 100,
        varianceGhs: Math.round(variance * 100) / 100,
        pctUsed: pct,
        status: budget <= 0 ? "NONE" : actual > budget ? "OVER" : pct != null && pct >= 85 ? "WATCH" : "OK",
        notes: b.notes,
        updatedByName: b.updatedByName || b.createdByName,
        updatedAt: b.updatedAt,
      };
    });
    lines.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "EXPENSE" ? 1 : -1) : a.category === "TOTAL" ? -1 : b.category === "TOTAL" ? 1 : a.category.localeCompare(b.category),
    );

    const totals = {
      expenseBudget: 0,
      expenseActual: 0,
      revenueBudget: 0,
      revenueActual: 0,
    };
    // Totals from the TOTAL lines when present, else the sum of categories.
    for (const kind of ["EXPENSE", "REVENUE"] as const) {
      const kindLines = lines.filter((l) => l.kind === kind);
      const totalLine = kindLines.find((l) => l.category === "TOTAL");
      const sum = kindLines.filter((l) => l.category !== "TOTAL").reduce((s, l) => s + l.budgetGhs, 0);
      const actualSum = live
        .filter((t) => (t.type === "EXPENSE") === (kind === "EXPENSE"))
        .reduce((s, t) => s + Number(t.amountGhs || 0), 0);
      if (kind === "EXPENSE") {
        totals.expenseBudget = totalLine ? totalLine.budgetGhs : sum;
        totals.expenseActual = Math.round(actualSum * 100) / 100;
      } else {
        totals.revenueBudget = totalLine ? totalLine.budgetGhs : sum;
        totals.revenueActual = Math.round(actualSum * 100) / 100;
      }
    }

    // Category picker: live categories this period + custom registers.
    const liveCats = new Set<string>();
    for (const t of live) liveCats.add(t.category);
    const custom = await db
      .select({ name: expenseCategories.name })
      .from(expenseCategories)
      .where(inArray(expenseCategories.businessId, bizIds))
      .limit(200);
    for (const c of custom) liveCats.add(c.name);

    const periodRows = await db
      .selectDistinct({ period: budgets.period })
      .from(budgets)
      .where(inArray(budgets.businessId, bizIds));

    return NextResponse.json({
      success: true,
      period,
      consolidated: scopeParam === "all" || scopeParam === "0",
      businesses: bizRows.map((b) => ({ id: Number(b.id), name: b.name, code: b.code })),
      lines,
      totals,
      categories: Array.from(liveCats).sort(),
      periods: periodRows.map((p) => p.period).sort().reverse(),
    });
  } catch (e) {
    console.error("[api/budgets GET]", e);
    return NextResponse.json({ success: false, error: "Could not load budgets." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user;
    const body = await request.json().catch(() => ({}));
    const businessId = Number(body.businessId);
    const period = normPeriod(body.period);
    const kind = normKind(body.kind);
    const category = String(body.category || "").trim().slice(0, 120);
    const amount = Number(body.amountGhs);
    if (!businessId || !period || !kind || !category) {
      return NextResponse.json({ success: false, error: "businessId, period (YYYY-MM), kind and category are required." }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount < 0) {
      return NextResponse.json({ success: false, error: "Amount must be zero or more." }, { status: 400 });
    }
    if (kind === "REVENUE" && category !== "TOTAL" && !/^(INCOME|REVENUE)/i.test(category)) {
      // allow any income category name — no further restriction
    }
    const role = String(user.role || "").toUpperCase();
    const manageOk =
      isExec(user) ||
      (role === "BRANCH_MANAGER" && (await canAccessBusiness(user, businessId))) ||
      businessManageIdsOf(user).includes(businessId);
    if (!manageOk) return FORBIDDEN("Only the owner, a general manager or that unit's manager can set budgets.");
    if (!(await canAccessBusiness(user, businessId))) return FORBIDDEN("That business is outside your scope.");

    const orgRes = await db.execute(sql`select owner_id from businesses where id = ${businessId} limit 1`);
    const orgRow = ((orgRes as any).rows ?? orgRes)[0];
    const ownerId = orgRow ? Number(orgRow.owner_id) : 0;
    const branchCode = body.branchCode ? String(body.branchCode).slice(0, 40) : "";

    const [line] = await db
      .insert(budgets)
      .values({
        ownerId,
        businessId,
        branchCode,
        period,
        kind,
        category,
        amountGhs: amount,
        notes: body.notes ? String(body.notes).slice(0, 500) : null,
        createdByUserId: Number(user.id),
        createdByName: user.name,
        updatedByName: user.name,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [budgets.businessId, budgets.period, budgets.branchCode, budgets.kind, budgets.category],
        set: {
          amountGhs: amount,
          notes: body.notes ? String(body.notes).slice(0, 500) : null,
          updatedByName: user.name,
          updatedAt: new Date(),
        },
      })
      .returning();
    return NextResponse.json({ success: true, line });
  } catch (e) {
    console.error("[api/budgets POST]", e);
    return NextResponse.json({ success: false, error: "Could not save the budget line." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user;
    const id = Number(new URL(request.url).searchParams.get("id"));
    if (!id) return NextResponse.json({ success: false, error: "id required" }, { status: 400 });
    const [line] = await db.select().from(budgets).where(eq(budgets.id, id)).limit(1);
    if (!line) return NextResponse.json({ success: false, error: "Budget line not found." }, { status: 404 });
    const role = String(user.role || "").toUpperCase();
    const manageOk =
      isExec(user) ||
      businessManageIdsOf(user).includes(Number(line.businessId)) ||
      (role === "BRANCH_MANAGER" && (await canAccessBusiness(user, Number(line.businessId))));
    if (!manageOk) return FORBIDDEN("Only the owner, a general manager or that unit's manager can change budgets.");
    await db.delete(budgets).where(eq(budgets.id, id));
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[api/budgets DELETE]", e);
    return NextResponse.json({ success: false, error: "Could not delete the budget line." }, { status: 500 });
  }
}
