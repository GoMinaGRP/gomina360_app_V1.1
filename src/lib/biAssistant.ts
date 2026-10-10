/**
 * R5 — Unified BI Assistant (CAPABILITY-AUDIT-REPORT §8).
 *
 * U1 — buildAssistantFeed: one cross-module operating picture (finance,
 *      stock, orders, credit, approvals, tasks, documents) for the caller's
 *      scope, newest/most-urgent first. Powers the assistant home panel.
 * U2 — answerQuestion: deterministic, keyword-scored Q&A over the same
 *      grounded data — finance summary, top customers (R3 RFM), stock
 *      status, overdue credit, budget variance, cash forecast and pending
 *      actions. No hallucination surface: every number comes from a query,
 *      and unknown questions get an honest fallback with suggestions.
 *
 * Scope: `businessIds: null` means platform-wide (super admin); otherwise the
 * caller's accessible units — every query is filtered through it.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  approvalRequests,
  budgets,
  businessDocuments,
  creditSales,
  customerTrackings,
  inventoryItems,
  supplierInvoices,
  actionTasks,
  transactions,
} from "@/db/schema";
import { lowStockItemsForBusiness } from "@/lib/lowStock";
import { customerInsights } from "@/lib/customerInsights";

export interface AssistantScope {
  businessIds: number[] | null;
  /**
   * Whether the OWNER has authorised this viewer for financial data.
   *
   * The Assistant is reachable by every UNIT_ADMIN (Owner, General Manager,
   * Branch Manager) on ROLE alone, but it answers questions straight off the
   * real books — "how is this month's finance?" returned income, expenses and
   * net to a manager the policy withholds those figures from. Role is not a
   * financial authorisation, so every money-bearing answer and feed signal now
   * asks this flag instead. Defaults to DENIED when a caller forgets it.
   */
  financialsAuthorized?: boolean;
}

/** Money-bearing intents; refused outright without the finance grant. */
const FINANCIAL_INTENTS = new Set(["FINANCE_SUMMARY", "BUDGET_VARIANCE", "CASH_FORECAST", "TOP_CUSTOMERS", "OVERDUE_ITEMS"]);
const DENIED_ANSWER =
  "That question is about money, and financial figures are restricted to the OWNER " +
  "and the users the OWNER has authorised. Operational signals — stock levels, " +
  "orders, approvals, checklists and documents — stay available to you.";

const ghs = (n: number) => `GH₵ ${Number(n || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const r2 = (n: number) => Math.round(Number(n || 0) * 100) / 100;
const today = () => new Date().toLocaleDateString("en-CA");
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toLocaleDateString("en-CA");
const thisMonth = () => new Date().toISOString().slice(0, 7);

const inScope = (scope: AssistantScope, bizId: any) =>
  scope.businessIds === null || bizId == null || scope.businessIds.map(Number).includes(Number(bizId));

/* ── shared grounded queries ──────────────────────────────────────────── */

async function financeSnapshot(scope: AssistantScope) {
  const rows = (await db.select().from(transactions)).filter((t: any) => inScope(scope, t.businessId) && (!t.status || t.status === "COMPLETED"));
  const month = thisMonth();
  const sum = (list: any[], type: string, when: (t: any) => boolean) =>
    r2(list.filter((t) => String(t.type) === type && when(t)).reduce((s, t) => s + (Number(t.amountGhs) || 0), 0));
  const monthRows = rows.filter((t: any) => String(t.date || "").startsWith(month));
  const last30 = rows.filter((t: any) => String(t.date || "") >= daysAgo(30));
  const income30 = sum(last30, "INCOME", () => true);
  const expense30 = sum(last30, "EXPENSE", () => true);
  return {
    monthIncomeGhs: sum(monthRows, "INCOME", () => true),
    monthExpenseGhs: sum(monthRows, "EXPENSE", () => true),
    monthNetGhs: r2(sum(monthRows, "INCOME", () => true) - sum(monthRows, "EXPENSE", () => true)),
    last30IncomeGhs: income30,
    last30ExpenseGhs: expense30,
    last30NetGhs: r2(income30 - expense30),
    allTimeIncomeGhs: sum(rows, "INCOME", () => true),
    allTimeExpenseGhs: sum(rows, "EXPENSE", () => true),
    transactionCount: rows.length,
    topExpenseCategories: Object.entries(
      rows
        .filter((t: any) => String(t.type) === "EXPENSE" && String(t.date || "") >= daysAgo(30))
        .reduce((acc: Record<string, number>, t: any) => {
          acc[String(t.category || "Other")] = r2((acc[String(t.category || "Other")] || 0) + (Number(t.amountGhs) || 0));
          return acc;
        }, {}),
    )
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .slice(0, 5)
      .map(([category, amountGhs]) => ({ category, amountGhs: amountGhs as number })),
  };
}

async function stockSnapshot(scope: AssistantScope) {
  const rows = (await db.select().from(inventoryItems)).filter((i: any) => inScope(scope, i.businessId));
  const low: any[] = [];
  for (const bizId of scope.businessIds === null ? [...new Set(rows.map((r: any) => Number(r.businessId)))] : scope.businessIds.map(Number)) {
    try {
      const items = await lowStockItemsForBusiness(bizId);
      for (const li of items) low.push({ businessId: bizId, ...li });
    } catch {}
  }
  const value = r2(rows.reduce((s, i: any) => s + (Number(i.quantity) || 0) * (Number(i.costPriceGhs) || 0), 0));
  return {
    itemCount: rows.length,
    stockValueGhs: value,
    lowCount: low.filter((l) => l.severity === "LOW").length,
    outCount: low.filter((l) => l.severity === "OUT").length,
    lowItems: low.slice(0, 15),
  };
}

async function creditSnapshot(scope: AssistantScope) {
  const rows = (await db.select().from(creditSales)).filter((s: any) => inScope(scope, s.businessId));
  const t = today();
  const active = rows.filter((s: any) => String(s.status) !== "PAID");
  const overdue = active.filter((s: any) => s.dueDate && String(s.dueDate) < t);
  return {
    activeCount: active.length,
    activeBalanceGhs: r2(active.reduce((s, x: any) => s + (Number(x.balanceGhs) || 0), 0)),
    overdueCount: overdue.length,
    overdueBalanceGhs: r2(overdue.reduce((s, x: any) => s + (Number(x.balanceGhs) || 0), 0)),
    overdue: overdue
      .sort((a: any, b: any) => (String(a.dueDate) < String(b.dueDate) ? -1 : 1))
      .slice(0, 10)
      .map((s: any) => ({
        creditCode: s.creditCode,
        customerName: s.customerName,
        businessId: s.businessId,
        balanceGhs: r2(Number(s.balanceGhs) || 0),
        dueDate: s.dueDate,
        daysOverdue: Math.max(0, Math.round((new Date(t).getTime() - new Date(String(s.dueDate)).getTime()) / 86400000)),
      })),
  };
}

async function approvalsSnapshot(scope: AssistantScope) {
  const rows = (await db.select().from(approvalRequests)).filter((a: any) => inScope(scope, a.businessId));
  const pending = rows.filter((a: any) => String(a.status) === "PENDING");
  return {
    pendingCount: pending.length,
    pending: pending
      .sort((a: any, b: any) => Number(b.id) - Number(a.id))
      .slice(0, 10)
      .map((a: any) => ({ id: a.id, action: a.action, targetLabel: a.targetLabel, amountGhs: a.amountGhs, requestedByName: a.requestedByName, createdAt: a.createdAt })),
  };
}

async function documentsSnapshot(scope: AssistantScope) {
  const rows = (await db.select().from(businessDocuments)).filter((d: any) => inScope(scope, d.businessId));
  const t = today();
  const in30 = new Date(Date.now() + 30 * 86400000).toLocaleDateString("en-CA");
  const expiring = rows.filter((d: any) => d.expiresOn && String(d.expiresOn) <= in30);
  return {
    documentCount: rows.length,
    expiringCount: expiring.length,
    expiredCount: rows.filter((d: any) => d.expiresOn && String(d.expiresOn) < t).length,
    expiring: expiring.slice(0, 10).map((d: any) => ({ id: d.id, title: d.title, docType: d.docType, businessId: d.businessId, expiresOn: d.expiresOn })),
  };
}

async function ordersSnapshot(scope: AssistantScope) {
  const rows = (await db.select().from(customerTrackings)).filter((o: any) => inScope(scope, o.businessId));
  const open = rows.filter((o: any) => !["DELIVERED", "CANCELLED", "RECEIVED"].includes(String(o.status)));
  return {
    total: rows.length,
    openCount: open.length,
    openValueGhs: r2(open.reduce((s, o: any) => s + (Number(o.totalGhs) || 0), 0)),
    recent: rows
      .sort((a: any, b: any) => Number(b.id) - Number(a.id))
      .slice(0, 5)
      .map((o: any) => ({ id: o.id, trackingCode: o.trackingCode, customerName: o.customerName, status: o.status, totalGhs: o.totalGhs, createdAt: o.createdAt })),
  };
}

async function tasksSnapshot(scope: AssistantScope) {
  const rows = (await db.select().from(actionTasks)).filter((t: any) => inScope(scope, t.businessId));
  const open = rows.filter((t: any) => !["COMPLETED", "CANCELLED"].includes(String(t.status || "OPEN")));
  return { openTaskCount: open.length, overdueTaskCount: open.filter((t: any) => t.dueDate && String(t.dueDate) < today()).length };
}

/* ── U1: the unified feed ─────────────────────────────────────────────── */

export interface FeedItem {
  module: "FINANCE" | "STOCK" | "CREDIT" | "ORDERS" | "APPROVALS" | "DOCUMENTS" | "TASKS";
  kind: string;
  title: string;
  detail: string;
  severity?: "INFO" | "WARN" | "URGENT";
  amountGhs?: number;
  at?: string | null;
}

export async function buildAssistantFeed(scope: AssistantScope): Promise<FeedItem[]> {
  const [fin, stock, credit, appr, docs, orders, tasksSnap] = await Promise.all([
    financeSnapshot(scope),
    stockSnapshot(scope),
    creditSnapshot(scope),
    approvalsSnapshot(scope),
    documentsSnapshot(scope),
    ordersSnapshot(scope),
    tasksSnapshot(scope),
  ]);
  const items: FeedItem[] = [];

  const financialsAuthorized = scope.financialsAuthorized === true;
  if (financialsAuthorized) {
    items.push({
      module: "FINANCE",
      kind: "MONTH_SUMMARY",
      title: `This month: ${ghs(fin.monthIncomeGhs)} in · ${ghs(fin.monthExpenseGhs)} out (net ${ghs(fin.monthNetGhs)})`,
      detail: fin.topExpenseCategories.length
        ? `Biggest expense lines (30d): ${fin.topExpenseCategories.map((c) => `${c.category} ${ghs(c.amountGhs)}`).join(", ")}`
        : "No expenses recorded in the last 30 days.",
      severity: fin.monthNetGhs < 0 ? "WARN" : "INFO",
      amountGhs: fin.monthNetGhs,
    });
    items.push({
      module: "FINANCE",
      kind: "ROLLING_30",
      title: `Rolling 30 days: ${ghs(fin.last30NetGhs)} net (${ghs(fin.last30IncomeGhs)} in / ${ghs(fin.last30ExpenseGhs)} out)`,
      detail: `${fin.transactionCount} transactions on record.`,
      severity: "INFO",
      amountGhs: fin.last30NetGhs,
    });
  } else {
    // Keep the SIGNALS (there were expenses, the month is running negative)
    // but not the figures behind them — the same masking contract the Command
    // Center uses, so an unauthorised viewer learns nothing numeric.
    items.push({
      module: "FINANCE",
      kind: "MONTH_SUMMARY_RESTRICTED",
      title: `This month: ${fin.transactionCount} transaction${fin.transactionCount === 1 ? "" : "s"} recorded · figures restricted`,
      detail: "Revenue, expenses and net are restricted to the OWNER and authorised users.",
      severity: "INFO",
    });
    items.push({
      module: "FINANCE",
      kind: "ROLLING_30_RESTRICTED",
      title: `Rolling 30 days: ${fin.transactionCount} transaction${fin.transactionCount === 1 ? "" : "s"} on record · figures restricted`,
      detail: "Income, expenses and net are restricted to the OWNER and authorised users.",
      severity: "INFO",
    });
  }

  if (stock.outCount > 0) {
    items.push({ module: "STOCK", kind: "OUT_OF_STOCK", title: `${stock.outCount} item${stock.outCount === 1 ? "" : "s"} out of stock`, detail: stock.lowItems.filter((l) => l.severity === "OUT").slice(0, 5).map((l) => l.name).join(", "), severity: "URGENT" });
  }
  if (stock.lowCount > 0) {
    items.push({
      module: "STOCK",
      kind: "LOW_STOCK",
      title: `${stock.lowCount} item${stock.lowCount === 1 ? "" : "s"} below reorder point`,
      detail: `${stock.lowItems.filter((l) => l.severity === "LOW").slice(0, 5).map((l) => `${l.name} (${l.quantity} left, reorder at ${l.minStockThreshold})`).join(", ")}. The daily sweep drafts purchase requisitions automatically.`,
      severity: "WARN",
    });
  }

  if (credit.overdueCount > 0) {
    // The COUNTS and the dunning detail stay operational — a manager still has
    // to chase these. The BALANCE roll-up is a money figure and is masked.
    items.push({ module: "CREDIT", kind: "OVERDUE", title: `${credit.overdueCount} overdue credit sale${credit.overdueCount === 1 ? "" : "s"}${financialsAuthorized ? ` — ${ghs(credit.overdueBalanceGhs)} outstanding` : " — balance restricted"}`, detail: credit.overdue.slice(0, 5).map((o) => `${o.creditCode} (${o.customerName}, ${o.daysOverdue}d)`).join(", "), severity: credit.overdue.some((o) => o.daysOverdue >= 30) ? "URGENT" : "WARN", amountGhs: financialsAuthorized ? credit.overdueBalanceGhs : undefined });
  }
  if (credit.activeCount > 0) {
    items.push({ module: "CREDIT", kind: "ACTIVE_CREDIT", title: `${credit.activeCount} active credit sale${credit.activeCount === 1 ? "" : "s"}${financialsAuthorized ? ` — ${ghs(credit.activeBalanceGhs)} receivable` : " — balance restricted"}`, detail: "Dunning reminders fire at T+1 / T+7 / T+30 past due.", severity: "INFO", amountGhs: financialsAuthorized ? credit.activeBalanceGhs : undefined });
  }

  if (appr.pendingCount > 0) {
    items.push({ module: "APPROVALS", kind: "PENDING", title: `${appr.pendingCount} approval${appr.pendingCount === 1 ? "" : "s"} waiting on a decision`, detail: appr.pending.slice(0, 5).map((a) => `${a.action}${a.amountGhs && financialsAuthorized ? ` (${ghs(Number(a.amountGhs))})` : ""} — ${a.targetLabel || ""}`).join("; "), severity: "WARN" });
  }

  if (docs.expiringCount > 0) {
    items.push({ module: "DOCUMENTS", kind: "EXPIRING", title: `${docs.expiringCount} document${docs.expiringCount === 1 ? "" : "s"} expiring within 30 days`, detail: docs.expiring.slice(0, 5).map((d) => `${d.title} (${d.expiresOn})`).join(", "), severity: docs.expiredCount > 0 ? "URGENT" : "WARN" });
  }

  // Per-order VALUES stay out of the feed entirely (only codes and statuses are
// listed below); the "worth GH₵ X" total is the roll-up, so it follows the grant.
  items.push({ module: "ORDERS", kind: "OPEN_ORDERS", title: `${orders.openCount} open customer order${orders.openCount === 1 ? "" : "s"}${financialsAuthorized ? ` worth ${ghs(orders.openValueGhs)}` : ""}`, detail: orders.recent.map((o) => `${o.trackingCode} — ${o.customerName} (${o.status})`).join("; "), severity: "INFO", amountGhs: financialsAuthorized ? orders.openValueGhs : undefined });
  if (tasksSnap.overdueTaskCount > 0) {
    items.push({ module: "TASKS", kind: "OVERDUE", title: `${tasksSnap.overdueTaskCount} overdue task${tasksSnap.overdueTaskCount === 1 ? "" : "s"}`, detail: `${tasksSnap.openTaskCount} open tasks in total.`, severity: "WARN" });
  }

  const rank = { URGENT: 0, WARN: 1, INFO: 2 };
  return items.sort((a, b) => rank[a.severity || "INFO"] - rank[b.severity || "INFO"]);
}

/* ── U2: deterministic Q&A ────────────────────────────────────────────── */

export interface AssistantAnswer {
  intent: string;
  question: string;
  answer: string;
  data: any;
  suggestions: string[];
}

const KEYWORDS: Record<string, string[]> = {
  FINANCE_SUMMARY: ["finance", "financial", "revenue", "income", "expense", "expenses", "profit", "loss", "how much did we make", "how much did we spend", "money", "sales summary", "p&l", "performance"],
  TOP_CUSTOMERS: ["top customer", "best customer", "top clients", "biggest customer", "who buys", "loyal", "champion", "valuable customer", "customer insight"],
  STOCK_STATUS: ["stock", "inventory", "low stock", "out of stock", "reorder", "restock", "items", "goods"],
  OVERDUE_ITEMS: ["overdue", "credit", "owes", "owe", "debt", "debtor", "receivable", "dunning", "past due", "balance"],
  BUDGET_VARIANCE: ["budget", "variance", "over budget", "under budget", "plan vs"],
  CASH_FORECAST: ["forecast", "cash flow", "cashflow", "projection", "next month", "coming weeks", "liquidity", "payables"],
  ACTIONS: ["approval", "approvals", "pending", "waiting", "to do", "todo", "action item", "action items", "my tasks", "decisions"],
};

function detectIntent(question: string): string {
  const q = ` ${String(question || "").toLowerCase().trim()} `;
  let best = "FALLBACK";
  let bestScore = 0;
  for (const [intent, words] of Object.entries(KEYWORDS)) {
    let score = 0;
    for (const w of words) if (q.includes(w)) score += w.length > 6 ? 2 : 1;
    if (score > bestScore) {
      bestScore = score;
      best = intent;
    }
  }
  return best;
}

export async function answerQuestion(question: string, scope: AssistantScope): Promise<AssistantAnswer> {
  const intent = detectIntent(question);
  const suggestions = ["How is this month's finance?", "Who are my top customers?", "What's low in stock?", "What credit is overdue?", "Am I over budget?", "Show pending approvals"];

  // Refuse before computing anything, so no snapshot of the books is built for
  // a viewer who is not allowed to see it.
  if (scope.financialsAuthorized !== true && FINANCIAL_INTENTS.has(intent)) {
    return {
      intent,
      question,
      answer: DENIED_ANSWER,
      data: null,
      suggestions: ["What's low in stock?", "Show pending approvals"],
    };
  }

  if (intent === "FINANCE_SUMMARY") {
    const fin = await financeSnapshot(scope);
    return {
      intent,
      question,
      answer:
        `This month so far: ${ghs(fin.monthIncomeGhs)} income and ${ghs(fin.monthExpenseGhs)} expenses — a net of ${ghs(fin.monthNetGhs)}.\n` +
        `Rolling 30 days: ${ghs(fin.last30NetGhs)} net (${ghs(fin.last30IncomeGhs)} in, ${ghs(fin.last30ExpenseGhs)} out).` +
        (fin.topExpenseCategories.length ? `\nLargest expense lines (30d): ${fin.topExpenseCategories.map((c) => `${c.category} at ${ghs(c.amountGhs)}`).join(", ")}.` : ""),
      data: fin,
      suggestions,
    };
  }

  if (intent === "TOP_CUSTOMERS") {
    const insights = await customerInsights({ businessIds: scope.businessIds });
    const top = insights.slice(0, 5);
    return {
      intent,
      question,
      answer: top.length
        ? `Your top customers by lifetime spend:\n${top.map((c, i) => `${i + 1}. ${c.name} — ${ghs(c.monetaryGhs)} across ${c.frequency} order${c.frequency === 1 ? "" : "s"} (${c.segment}${c.recencyDays != null ? `, last order ${c.recencyDays}d ago` : ""})`).join("\n")}` +
          (top.some((c) => c.openCreditGhs > 0) ? `\nHeads up: ${top.filter((c) => c.openCreditGhs > 0).map((c) => `${c.name} (${ghs(c.openCreditGhs)} open credit)`).join(", ")}.` : "")
        : "No customer activity in your scope yet — once orders flow in, the RFM segments will rank your best buyers.",
      data: { topCustomers: top },
      suggestions,
    };
  }

  if (intent === "STOCK_STATUS") {
    const stock = await stockSnapshot(scope);
    return {
      intent,
      question,
      answer:
        // Inventory VALUATION is a financial figure per the policy table, so it
        // follows the grant; the counts, names and reorder points stay
        // operational — a stock sweep needs them and none of them is money.
        `Stock position: ${stock.itemCount} items${scope.financialsAuthorized === true ? ` worth ${ghs(stock.stockValueGhs)} at cost` : ""}. ` +
        (stock.outCount > 0 ? `${stock.outCount} OUT of stock and ` : "") +
        (stock.lowCount > 0
          ? `${stock.lowCount} below their reorder point${stock.lowItems.length ? `:\n${stock.lowItems.slice(0, 8).map((l) => `• ${l.name} — ${l.quantity} left (reorder at ${l.minStockThreshold})`).join("\n")}` : "."} The daily sweep auto-drafts purchase requisitions for these.`
          : "everything is above its reorder point."),
      data: stock,
      suggestions,
    };
  }

  if (intent === "OVERDUE_ITEMS") {
    const credit = await creditSnapshot(scope);
    return {
      intent,
      question,
      answer: credit.overdueCount
        ? `${credit.overdueCount} overdue credit sale${credit.overdueCount === 1 ? "" : "s"} totalling ${ghs(credit.overdueBalanceGhs)} (of ${ghs(credit.activeBalanceGhs)} active receivables):\n${credit.overdue.map((o) => `• ${o.creditCode} — ${o.customerName}: ${ghs(o.balanceGhs)}, ${o.daysOverdue} day${o.daysOverdue === 1 ? "" : "s"} past due`).join("\n")}\nDunning reminders fire automatically at T+1, T+7 and T+30.`
        : `No overdue credit sales — ${ghs(credit.activeBalanceGhs)} is outstanding on ${credit.activeCount} active sale${credit.activeCount === 1 ? "" : "s"}, all within their terms.`,
      data: credit,
      suggestions,
    };
  }

  if (intent === "BUDGET_VARIANCE") {
    const month = thisMonth();
    const budgetRows = (await db.select().from(budgets)).filter((b: any) => inScope(scope, b.businessId) && String(b.period) === month);
    const fin = await financeSnapshot(scope);
    if (!budgetRows.length) {
      return {
        intent,
        question,
        answer: `No budgets are set for ${month} in your scope, so there is nothing to compare against. This month's actuals: ${ghs(fin.monthIncomeGhs)} income, ${ghs(fin.monthExpenseGhs)} expenses. Set budgets in Finance & Reports to start tracking variance.`,
        data: { month, budgets: [], actuals: fin },
        suggestions,
      };
    }
    const actualByCategory: Record<string, number> = {};
    for (const t of (await db.select().from(transactions)).filter((t: any) => inScope(scope, t.businessId) && (!t.status || t.status === "COMPLETED") && String(t.date || "").startsWith(month))) {
      const key = String(t.category || "Other");
      actualByCategory[key] = r2((actualByCategory[key] || 0) + (String(t.type) === "EXPENSE" ? Number(t.amountGhs) || 0 : 0));
    }
    const lines = budgetRows.map((b: any) => {
      const budgeted = Number(b.amountGhs) || 0;
      const actual = b.category === "TOTAL" ? fin.monthExpenseGhs : actualByCategory[b.category] || 0;
      const variance = r2(budgeted - actual);
      return { businessId: b.businessId, category: b.category, kind: b.kind, budgetedGhs: budgeted, actualGhs: actual, varianceGhs: variance, pctUsed: budgeted > 0 ? Math.round((actual / budgeted) * 100) : null };
    });
    const overs = lines.filter((l) => l.varianceGhs < 0);
    return {
      intent,
      question,
      answer:
        `Budget vs actual for ${month}:\n${lines.slice(0, 10).map((l) => `• ${l.category}: budgeted ${ghs(l.budgetedGhs)}, spent ${ghs(l.actualGhs)}${l.pctUsed != null ? ` (${l.pctUsed}%)` : ""} — ${l.varianceGhs >= 0 ? `${ghs(l.varianceGhs)} left` : `${ghs(Math.abs(l.varianceGhs))} OVER`}`).join("\n")}` +
        (overs.length ? `\n⚠ ${overs.length} line${overs.length === 1 ? "" : "s"} over budget.` : "\nAll lines are within budget."),
      data: { month, lines },
      suggestions,
    };
  }

  if (intent === "CASH_FORECAST") {
    const [credit, fin] = await Promise.all([creditSnapshot(scope), financeSnapshot(scope)]);
    const invoices = (await db.select().from(supplierInvoices)).filter((i: any) => inScope(scope, i.businessId) && !["PAID", "CANCELLED"].includes(String(i.status)));
    const payables = r2(invoices.reduce((s, i: any) => s + Math.max(0, (Number(i.amountGhs) || 0) - (Number(i.amountPaidGhs) || 0)), 0));
    const dailyNet = fin.last30NetGhs / 30;
    const projected30 = r2(fin.last30NetGhs + credit.activeBalanceGhs * 0.6 - payables);
    return {
      intent,
      question,
      answer:
        `Simple 30-day cash projection, grounded in your last 30 days:\n` +
        `• Rolling net cash flow: ${ghs(fin.last30NetGhs)} (~${ghs(dailyNet)}/day).\n` +
        `• Expected inflows: up to ${ghs(credit.activeBalanceGhs)} from active credit sales (assume ~60% collects in 30 days → ${ghs(credit.activeBalanceGhs * 0.6)}).\n` +
        `• Known outflows: ${ghs(payables)} in unpaid supplier invoices${credit.overdueCount ? `; dunning is already chasing ${ghs(credit.overdueBalanceGhs)} overdue receivables` : ""}.\n` +
        `Net projection for the next 30 days: ${ghs(projected30)}. This is a straight-line estimate, not a promise — collections and seasonality will move it.`,
      data: { rolling30NetGhs: fin.last30NetGhs, receivablesGhs: credit.activeBalanceGhs, payablesGhs: payables, projected30NetGhs: projected30 },
      suggestions,
    };
  }

  if (intent === "ACTIONS") {
    const [appr, docs, tasksSnap, credit] = await Promise.all([approvalsSnapshot(scope), documentsSnapshot(scope), tasksSnapshot(scope), creditSnapshot(scope)]);
    const lines: string[] = [];
    if (appr.pendingCount) lines.push(`• ${appr.pendingCount} approval${appr.pendingCount === 1 ? "" : "s"} awaiting a decision (Action Center inbox).`);
    if (credit.overdueCount) lines.push(`• ${credit.overdueCount} overdue credit sale${credit.overdueCount === 1 ? "" : "s"} to chase${scope.financialsAuthorized === true ? ` (${ghs(credit.overdueBalanceGhs)})` : ""}.`);
    if (docs.expiringCount) lines.push(`• ${docs.expiringCount} document${docs.expiringCount === 1 ? "" : "s"} expiring within 30 days.`);
    if (tasksSnap.overdueTaskCount) lines.push(`• ${tasksSnap.overdueTaskCount} overdue task${tasksSnap.overdueTaskCount === 1 ? "" : "s"}.`);
    return {
      intent,
      question,
      answer: lines.length ? `Needs your attention:\n${lines.join("\n")}` : "Nothing is waiting on you — no pending approvals, overdue credit, expiring documents or overdue tasks in your scope.",
      data: { approvals: appr, documents: docs, tasks: tasksSnap, credit: { overdueCount: credit.overdueCount, overdueBalanceGhs: credit.overdueBalanceGhs } },
      suggestions,
    };
  }

  return {
    intent: "FALLBACK",
    question,
    answer:
      "I can answer questions about your money, customers, stock, credit, budgets and pending actions — with real numbers from your businesses. Try one of these:",
    data: {},
    suggestions,
  };
}
