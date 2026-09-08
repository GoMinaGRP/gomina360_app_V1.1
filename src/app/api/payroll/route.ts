import { NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/db";
import {
  payrollRuns,
  payrollEntries,
  payrollAttendance,
  payrollStatutoryConfig,
  employees,
  businesses,
  transactions,
} from "@/db/schema";
import { eq, inArray, desc } from "drizzle-orm";
import {
  computeStatutory,
  cfgFromRow,
  type StatutoryConfig,
} from "@/lib/payrollCalc";
import {
  getSessionInfo,
  accessibleBusinessIds,
  canAccessBusiness,
  FORBIDDEN,
  UNAUTHENTICATED,
} from "@/lib/auth";
import { canManageSharedRecords } from "@/lib/recordPermissions";

/**
 * Enterprise Payroll — Employee → Business → Branch → Finance → Reports.
 *
 * Lifecycle: CREATE_RUN (drafts from active employees + attendance overtime)
 * → REVIEW → APPROVE → PAY (posts a real EXPENSE transaction per entry, so
 * payroll flows into transactions, dashboards and financial reports) → run
 * flips to PAID. Outstanding payroll = PENDING entry balances.
 *
 * Permissions (the app's existing shared-record model): the OWNER does
 * everything; other roles need the OWNER-granted canManageRecords flag AND
 * business access; every decision is resolved server-side from the session.
 */

const OT_DIVISOR = 208; // 26 working days × 8 hours (Ghana standard month)
const OT_MULTIPLIER = 1.5; // statutory overtime loading

const round2 = (n: number) => Math.round(n * 100) / 100;
export const otPayFor = (salary: number, hours: number) =>
  round2((Number(salary) / OT_DIVISOR) * Number(hours) * OT_MULTIPLIER);

async function assertManage(user: any, businessId: number) {
  if (user.role === "OWNER") return null;
  if (!canManageSharedRecords(user)) {
    return FORBIDDEN(
      "Only the OWNER (or a manager the OWNER has granted record-management permission) can run payroll."
    );
  }
  if (!(await canAccessBusiness(user, businessId))) {
    return FORBIDDEN("That payroll belongs to a business you cannot access.");
  }
  return null;
}

/** Load the live statutory configuration (single row id=1); falls back to
 *  Ghana defaults if the row has never been saved. */
async function loadStatutory(): Promise<{ cfg: StatutoryConfig; row: any | null }> {
  const [row] = await db.select().from(payrollStatutoryConfig).where(eq(payrollStatutoryConfig.id, 1));
  return { cfg: cfgFromRow(row), row: row || null };
}

/** Persist the statutory snapshot of computeStatutory() onto an entry row. */
function statutoryColumnValues(b: ReturnType<typeof computeStatutory>, applyStatutory: boolean) {
  return {
    applyStatutory,
    grossPayGhs: b.gross,
    ssnitEmployeeGhs: b.ssnitEmployee,
    ssnitEmployerGhs: b.ssnitEmployer,
    tier2Ghs: b.tier2,
    tier2Bearer: b.tier2Bearer,
    taxableIncomeGhs: b.taxableIncome,
    payeGhs: b.paye,
    customDeductions: b.custom,
    totalEmployeeDeductionsGhs: b.totalEmployeeDeductions,
    employerContributionsGhs: b.employerContributions,
    employerCostGhs: b.employerCost,
  };
}

async function runWithEntries(runId: number) {
  const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
  if (!run) return null;
  const entries = await db
    .select()
    .from(payrollEntries)
    .where(eq(payrollEntries.runId, runId))
    .orderBy(payrollEntries.id);
  return { ...run, entries, totals: totalsFor(entries) };
}

function totalsFor(entries: any[]) {
  const t = {
    headcount: entries.length,
    base: 0,
    allowances: 0,
    overtimePay: 0,
    overtimeHours: 0,
    deductions: 0,
    net: 0,
    paid: 0,
    outstanding: 0,
    paidCount: 0,
    // Statutory aggregates (0 for legacy pre-statutory entries)
    gross: 0,
    ssnitEmployee: 0,
    ssnitEmployer: 0,
    tier2: 0,
    paye: 0,
    employeeDeductions: 0,
    employerContributions: 0,
    employerCost: 0,
  };
  for (const e of entries) {
    t.base += e.baseSalaryGhs || 0;
    t.allowances += e.allowancesGhs || 0;
    t.overtimePay += e.overtimePayGhs || 0;
    t.overtimeHours += e.overtimeHours || 0;
    t.deductions += e.deductionsGhs || 0;
    t.net += e.netPayGhs || 0;
    t.gross += e.grossPayGhs || 0;
    t.ssnitEmployee += e.ssnitEmployeeGhs || 0;
    t.ssnitEmployer += e.ssnitEmployerGhs || 0;
    t.tier2 += e.tier2Ghs || 0;
    t.paye += e.payeGhs || 0;
    t.employeeDeductions += e.totalEmployeeDeductionsGhs || 0;
    t.employerContributions += e.employerContributionsGhs || 0;
    t.employerCost += e.employerCostGhs || 0;
    if (e.status === "PAID") {
      t.paid += e.netPayGhs || 0;
      t.paidCount++;
    } else {
      t.outstanding += e.netPayGhs || 0;
    }
  }
  for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] = round2(t[k] as number) as never;
  return t;
}

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const url = new URL(request.url);
    const businessId = url.searchParams.get("businessId");
    const period = url.searchParams.get("period");

    const allowed = await accessibleBusinessIds(user); // null ⇒ OWNER
    const inScope = (bid: number) => allowed === null || allowed.includes(bid);

    let runs = await db.select().from(payrollRuns).orderBy(desc(payrollRuns.id));
    runs = runs.filter((r) => inScope(r.businessId));
    if (businessId) runs = runs.filter((r) => r.businessId === Number(businessId));
    if (period) runs = runs.filter((r) => r.period === period);

    const allEntries = runs.length
      ? await db
          .select()
          .from(payrollEntries)
          .where(inArray(payrollEntries.runId, runs.map((r) => r.id)))
          .orderBy(payrollEntries.id)
      : [];

    let attendance = await db
      .select()
      .from(payrollAttendance)
      .orderBy(desc(payrollAttendance.date), desc(payrollAttendance.id));
    attendance = attendance.filter((a) => inScope(a.businessId));
    if (businessId) attendance = attendance.filter((a) => a.businessId === Number(businessId));
    attendance = attendance.slice(0, 300);

    const runsFull = runs.map((r) => {
      const entries = allEntries.filter((e) => e.runId === r.id);
      return { ...r, entries, totals: totalsFor(entries) };
    });

    // Report aggregation across the scoped entries
    const byMonth = new Map<string, any>();
    const byBiz = new Map<number, any>();
    const bizRows = await db.select().from(businesses);
    const bizName = (id: number) => bizRows.find((b) => b.id === id)?.name || `Business #${id}`;
    const comp = { base: 0, allowances: 0, overtime: 0, deductions: 0 };
    for (const e of allEntries) {
      const run = runs.find((r) => r.id === e.runId)!;
      const m = byMonth.get(run.period) || {
        period: run.period, base: 0, allowances: 0, overtime: 0, deductions: 0,
        net: 0, paid: 0, outstanding: 0, headcount: 0,
      };
      m.base += e.baseSalaryGhs; m.allowances += e.allowancesGhs;
      m.overtime += e.overtimePayGhs; m.deductions += e.deductionsGhs; m.net += e.netPayGhs;
      if (e.status === "PAID") m.paid += e.netPayGhs; else m.outstanding += e.netPayGhs;
      m.headcount++;
      byMonth.set(run.period, m);

      const b = byBiz.get(e.businessId) || {
        businessId: e.businessId, name: bizName(e.businessId), net: 0, paid: 0, outstanding: 0, headcount: 0,
      };
      b.net += e.netPayGhs;
      if (e.status === "PAID") b.paid += e.netPayGhs; else b.outstanding += e.netPayGhs;
      b.headcount++;
      byBiz.set(e.businessId, b);

      comp.base += e.baseSalaryGhs; comp.allowances += e.allowancesGhs;
      comp.overtime += e.overtimePayGhs; comp.deductions += e.deductionsGhs;
    }
    const report = {
      byMonth: [...byMonth.values()].sort((a, b) => a.period.localeCompare(b.period)).map((m) => {
        for (const k of ["base", "allowances", "overtime", "deductions", "net", "paid", "outstanding"]) m[k] = round2(m[k]);
        return m;
      }),
      byBusiness: [...byBiz.values()].sort((a, b) => b.net - a.net).map((b) => {
        for (const k of ["net", "paid", "outstanding"]) b[k] = round2(b[k]);
        return b;
      }),
      composition: Object.fromEntries(Object.entries(comp).map(([k, v]) => [k, round2(v)])),
    };

    const { cfg, row: cfgRow } = await loadStatutory();

    return NextResponse.json({
      success: true,
      runs: runsFull,
      attendance,
      report,
      statutory: {
        config: cfg,
        note: cfgRow?.note || null,
        updatedByName: cfgRow?.updatedByName || null,
        updatedByRole: cfgRow?.updatedByRole || null,
        updatedAt: cfgRow?.updatedAt || null,
      },
      scope: {
        isOwner: user.role === "OWNER",
        canManage: canManageSharedRecords(user),
        businessIds: allowed,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const body = await request.json();

    // ── Record attendance / leave / overtime ────────────────────────────
    if (body.action === "ADD_ATTENDANCE") {
      const d = body.data || {};
      const empId = Number(d.employeeId);
      const [emp] = await db.select().from(employees).where(eq(employees.id, empId));
      if (!emp) return NextResponse.json({ success: false, error: "Employee not found" }, { status: 404 });
      const denial = await assertManage(user, emp.businessId);
      if (denial) return denial;
      const status = ["PRESENT", "HALF_DAY", "ABSENT", "LEAVE", "OFF_DAY"].includes(d.status) ? d.status : "PRESENT";
      const [biz] = await db.select().from(businesses).where(eq(businesses.id, emp.businessId));
      const [row] = await db
        .insert(payrollAttendance)
        .values({
          employeeId: emp.id,
          employeeName: emp.name,
          businessId: emp.businessId,
          branchCode: (d.branchCode || biz?.code || "").toUpperCase(),
          date: String(d.date || new Date().toISOString().slice(0, 10)),
          status,
          hoursWorked: Number(d.hoursWorked) || 0,
          overtimeHours: Number(d.overtimeHours) || 0,
          leaveType: status === "LEAVE" ? d.leaveType || "ANNUAL" : null,
          note: d.note || null,
          recordedByUserId: user.id,
          recordedByName: user.name,
        })
        .returning();
      return NextResponse.json({ success: true, attendance: row });
    }

    // ── Save statutory rates & configuration (authorized users only) ────
    if (body.action === "SAVE_STATUTORY") {
      // Statutory configuration is enterprise-wide: the OWNER, or a manager
      // the OWNER granted record-management permission, may change it.
      if (user.role !== "OWNER" && !canManageSharedRecords(user)) {
        return FORBIDDEN(
          "Only the OWNER (or a manager the OWNER has granted record-management permission) can change statutory rates."
        );
      }
      const d = body.data || {};
      const pct = (v: any, fallback: number) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
      };
      const { row: existing } = await loadStatutory();
      const cur = cfgFromRow(existing);

      const bandsRaw = Array.isArray(d.payeBands) ? d.payeBands : cur.payeBands;
      const payeBands = bandsRaw
        .map((b: any) => ({
          upto: b?.upto === null || b?.upto === undefined || b?.upto === "" ? null : Number(b.upto),
          ratePct: Number(b?.ratePct),
        }))
        .filter((b: any) => (b.upto === null || (Number.isFinite(b.upto) && b.upto > 0)) && Number.isFinite(b.ratePct) && b.ratePct >= 0 && b.ratePct <= 100);
      if (!payeBands.length || payeBands[payeBands.length - 1].upto !== null) {
        return NextResponse.json(
          { success: false, error: "PAYE bands must be valid and end with an open (unlimited) top band." },
          { status: 400 }
        );
      }

      const itemsRaw = Array.isArray(d.customItems) ? d.customItems : cur.customItems;
      const customItems = itemsRaw
        .map((c: any) => ({
          name: String(c?.name || "").trim().slice(0, 60),
          pct: Number(c?.pct),
          bearer: c?.bearer === "EMPLOYEE" ? "EMPLOYEE" : "EMPLOYER",
          base: c?.base === "GROSS" ? "GROSS" : "BASIC",
          active: c?.active !== false,
        }))
        .filter((c: any) => c.name && Number.isFinite(c.pct) && c.pct >= 0 && c.pct <= 100);

      const values = {
        ssnitEmployeePct: pct(d.ssnitEmployeePct, cur.ssnitEmployeePct),
        ssnitEmployerPct: pct(d.ssnitEmployerPct, cur.ssnitEmployerPct),
        tier2Pct: pct(d.tier2Pct, cur.tier2Pct),
        tier2Bearer: d.tier2Bearer === "EMPLOYEE" ? "EMPLOYEE" : "EMPLOYER",
        payeBands: payeBands as any,
        customItems: customItems as any,
        note: d.note !== undefined ? String(d.note || "").slice(0, 300) : existing?.note || null,
        updatedByUserId: user.id,
        updatedByName: user.name,
        updatedByRole: user.role,
        updatedAt: new Date(),
      };

      let row;
      if (existing) {
        [row] = await db.update(payrollStatutoryConfig).set(values).where(eq(payrollStatutoryConfig.id, 1)).returning();
      } else {
        [row] = await db.insert(payrollStatutoryConfig).values({ id: 1, ...values }).returning();
      }
      return NextResponse.json({
        success: true,
        statutory: { config: cfgFromRow(row), note: row.note, updatedByName: row.updatedByName, updatedByRole: row.updatedByRole, updatedAt: row.updatedAt },
      });
    }

    // ── Create a payroll run (draft entries from active employees) ──────
    const d = body.data || body;
    const businessId = Number(d.businessId);
    const period = String(d.period || "").trim(); // "2026-08"
    if (!businessId || !/^\d{4}-\d{2}$/.test(period)) {
      return NextResponse.json(
        { success: false, error: "businessId and period (YYYY-MM) are required" },
        { status: 400 }
      );
    }
    const denial = await assertManage(user, businessId);
    if (denial) return denial;

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    if (!biz) return NextResponse.json({ success: false, error: "Business not found" }, { status: 404 });
    const branchCode = String(d.branchCode || biz.code).trim().toUpperCase();

    const dupe = await db
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(eq(payrollRuns.businessId, businessId));
    if (dupe.length) {
      const same = await db.select().from(payrollRuns).where(inArray(payrollRuns.id, dupe.map((x) => x.id)));
      if (same.some((r) => r.period === period)) {
        return NextResponse.json(
          { success: false, error: `A payroll run for ${biz.name} in ${period} already exists.` },
          { status: 409 }
        );
      }
    }

    const staff = (await db.select().from(employees).where(eq(employees.businessId, businessId)))
      .filter((e) => (e.status || "ACTIVE") === "ACTIVE");
    if (!staff.length) {
      return NextResponse.json(
        { success: false, error: "No ACTIVE employees in this business to pay." },
        { status: 400 }
      );
    }

    // Pull the month's overtime per employee from attendance.
    const att = await db.select().from(payrollAttendance).where(eq(payrollAttendance.businessId, businessId));
    const otByEmp = new Map<number, number>();
    for (const a of att) {
      if (!a.date?.startsWith(period)) continue;
      otByEmp.set(a.employeeId, (otByEmp.get(a.employeeId) || 0) + (a.overtimeHours || 0));
    }

    const { cfg } = await loadStatutory();

    const [run] = await db
      .insert(payrollRuns)
      .values({
        period,
        businessId,
        branchCode,
        branchName: d.branchName || biz.name,
        status: "DRAFT",
        notes: d.notes || null,
        createdByUserId: user.id,
        createdByName: user.name,
      })
      .returning();

    for (const emp of staff) {
      const otHours = round2(otByEmp.get(emp.id) || 0);
      const otPay = otPayFor(emp.salaryGhs, otHours);
      const b = computeStatutory(
        { basic: emp.salaryGhs, allowances: 0, overtimePay: otPay, manualDeductions: 0, applyStatutory: true },
        cfg
      );
      await db.insert(payrollEntries).values({
        runId: run.id,
        employeeId: emp.id,
        employeeName: emp.name,
        employeeRole: emp.role,
        businessId,
        branchCode,
        baseSalaryGhs: emp.salaryGhs,
        allowancesGhs: 0,
        overtimeHours: otHours,
        overtimePayGhs: otPay,
        deductionsGhs: 0,
        netPayGhs: b.net,
        ...statutoryColumnValues(b, true),
      });
    }

    return NextResponse.json({ success: true, run: await runWithEntries(run.id) });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/** Record the payroll expense in the central ledger (keeps Finance, Reports
 *  and every business dashboard in sync automatically). */
async function postPayrollTransaction(user: any, entry: any, run: any, method: string) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const trxNum = `TRX-${now.getFullYear()}-${crypto.randomInt(100000, 999999)}`;
  // Statutory-era entries carry the full gross→deductions→net breakdown in
  // the ledger description; legacy (pre-statutory) entries keep the old one.
  const description = entry.grossPayGhs != null
    ? `Payroll ${run.period} — ${entry.employeeName} (${entry.employeeRole || "Staff"}) · gross ${entry.grossPayGhs} − SSNIT ${entry.ssnitEmployeeGhs || 0} − PAYE ${entry.payeGhs || 0} − other ${round2((entry.totalEmployeeDeductionsGhs || 0) - (entry.ssnitEmployeeGhs || 0) - (entry.payeGhs || 0))} = net ${entry.netPayGhs}`
    : `Payroll ${run.period} — ${entry.employeeName} (${entry.employeeRole || "Staff"}) · base ${entry.baseSalaryGhs} + allow ${entry.allowancesGhs} + OT ${entry.overtimePayGhs} − ded ${entry.deductionsGhs}`;
  const [trx] = await db
    .insert(transactions)
    .values({
      transactionNumber: trxNum,
      businessId: entry.businessId,
      branchCode: entry.branchCode,
      branchName: run.branchName || entry.branchCode,
      type: "EXPENSE",
      category: "Staff Payroll",
      amountGhs: entry.netPayGhs,
      paymentMethod: method,
      description,
      date: dateStr,
      createdAt: now,
      status: "COMPLETED",
      recordedBy: user.name,
      recordedByRole: user.role,
      recordedByUserId: user.id,
    })
    .returning();
  return trx;
}

export async function PATCH(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const body = await request.json();
    const action = String(body.action || "").toUpperCase();

    // ── Edit a draft entry (allowances / deductions / overtime hours) ───
    if (action === "UPDATE_ENTRY") {
      const entryId = Number(body.entryId);
      const [entry] = await db.select().from(payrollEntries).where(eq(payrollEntries.id, entryId));
      if (!entry) return NextResponse.json({ success: false, error: "Entry not found" }, { status: 404 });
      const denial = await assertManage(user, entry.businessId);
      if (denial) return denial;
      if (entry.status === "PAID") {
        return NextResponse.json({ success: false, error: "A paid entry cannot be edited." }, { status: 400 });
      }
      const baseSalary = body.baseSalaryGhs !== undefined ? round2(Number(body.baseSalaryGhs) || 0) : entry.baseSalaryGhs;
      const allowances = body.allowancesGhs !== undefined ? round2(Number(body.allowancesGhs) || 0) : entry.allowancesGhs;
      const deductions = body.deductionsGhs !== undefined ? round2(Number(body.deductionsGhs) || 0) : entry.deductionsGhs;
      const otHours = body.overtimeHours !== undefined ? round2(Number(body.overtimeHours) || 0) : entry.overtimeHours;
      const otPay = body.overtimeHours !== undefined || body.baseSalaryGhs !== undefined ? otPayFor(baseSalary, otHours) : entry.overtimePayGhs;
      const applyStatutory = body.applyStatutory !== undefined ? !!body.applyStatutory : entry.applyStatutory !== false;
      const { cfg } = await loadStatutory();
      const b = computeStatutory(
        { basic: baseSalary, allowances, overtimePay: otPay, manualDeductions: deductions, applyStatutory },
        cfg
      );
      const [updated] = await db
        .update(payrollEntries)
        .set({
          baseSalaryGhs: baseSalary,
          allowancesGhs: allowances,
          allowanceNote: body.allowanceNote !== undefined ? body.allowanceNote || null : entry.allowanceNote,
          deductionsGhs: deductions,
          deductionNote: body.deductionNote !== undefined ? body.deductionNote || null : entry.deductionNote,
          overtimeHours: otHours,
          overtimePayGhs: otPay,
          netPayGhs: b.net,
          ...statutoryColumnValues(b, applyStatutory),
        })
        .where(eq(payrollEntries.id, entryId))
        .returning();
      return NextResponse.json({ success: true, entry: updated });
    }

    // ── Recalculate all unpaid entries of a run with the current config ─
    if (action === "RECALC_RUN") {
      const runId = Number(body.runId);
      const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
      if (!run) return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
      const denial = await assertManage(user, run.businessId);
      if (denial) return denial;
      if (run.status === "PAID") {
        return NextResponse.json({ success: false, error: "A paid run is locked on the audit trail." }, { status: 400 });
      }
      const { cfg } = await loadStatutory();
      const entries = await db.select().from(payrollEntries).where(eq(payrollEntries.runId, runId));
      let recalculated = 0;
      for (const entry of entries) {
        if (entry.status === "PAID") continue; // paid amounts never change
        const applyStatutory = entry.applyStatutory !== false;
        const b = computeStatutory(
          {
            basic: entry.baseSalaryGhs,
            allowances: entry.allowancesGhs,
            overtimePay: entry.overtimePayGhs,
            manualDeductions: entry.deductionsGhs,
            applyStatutory,
          },
          cfg
        );
        await db
          .update(payrollEntries)
          .set({ netPayGhs: b.net, ...statutoryColumnValues(b, applyStatutory) })
          .where(eq(payrollEntries.id, entry.id));
        recalculated++;
      }
      return NextResponse.json({ success: true, recalculated, run: await runWithEntries(runId) });
    }

    // ── Pay one entry: posts the expense transaction, marks PAID ────────
    if (action === "PAY_ENTRY") {
      const entryId = Number(body.entryId);
      const method = String(body.method || "CASH").toUpperCase();
      if (!["CASH", "MTN_MOMO", "BANK_TRANSFER", "OTHER"].includes(method)) {
        return NextResponse.json({ success: false, error: "Unknown payment method" }, { status: 400 });
      }
      const [entry] = await db.select().from(payrollEntries).where(eq(payrollEntries.id, entryId));
      if (!entry) return NextResponse.json({ success: false, error: "Entry not found" }, { status: 404 });
      const denial = await assertManage(user, entry.businessId);
      if (denial) return denial;
      const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, entry.runId));
      if (run.status !== "APPROVED" && run.status !== "PAID") {
        return NextResponse.json(
          { success: false, error: "The run must be APPROVED before payments can be made." },
          { status: 400 }
        );
      }
      if (entry.status === "PAID") {
        return NextResponse.json({ success: false, error: "This entry is already paid." }, { status: 409 });
      }
      const trx = await postPayrollTransaction(user, entry, run, method);
      const [updated] = await db
        .update(payrollEntries)
        .set({ status: "PAID", paymentMethod: method, paidAt: new Date(), paidByName: user.name, transactionId: trx.id })
        .where(eq(payrollEntries.id, entryId))
        .returning();
      // Flip the run to PAID when everything is settled
      const siblings = await db.select().from(payrollEntries).where(eq(payrollEntries.runId, run.id));
      if (siblings.every((s) => s.id === entryId || s.status === "PAID")) {
        await db.update(payrollRuns).set({ status: "PAID", paidAt: new Date(), updatedAt: new Date() }).where(eq(payrollRuns.id, run.id));
      }
      return NextResponse.json({ success: true, entry: updated, transaction: trx, run: await runWithEntries(run.id) });
    }

    // ── Pay the whole run at once ───────────────────────────────────────
    if (action === "PAY_RUN") {
      const runId = Number(body.runId);
      const method = String(body.method || "CASH").toUpperCase();
      const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
      if (!run) return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
      const denial = await assertManage(user, run.businessId);
      if (denial) return denial;
      if (run.status !== "APPROVED") {
        return NextResponse.json(
          { success: false, error: "Only an APPROVED run can be paid." },
          { status: 400 }
        );
      }
      const pending = (await db.select().from(payrollEntries).where(eq(payrollEntries.runId, runId)))
        .filter((e) => e.status !== "PAID");
      let trxFirst: any = null;
      for (const entry of pending) {
        const trx = await postPayrollTransaction(user, entry, run, method);
        if (!trxFirst) trxFirst = trx;
        await db
          .update(payrollEntries)
          .set({ status: "PAID", paymentMethod: method, paidAt: new Date(), paidByName: user.name, transactionId: trx.id })
          .where(eq(payrollEntries.id, entry.id));
      }
      await db.update(payrollRuns).set({ status: "PAID", paidAt: new Date(), updatedAt: new Date() }).where(eq(payrollRuns.id, runId));
      return NextResponse.json({ success: true, paidCount: pending.length, run: await runWithEntries(runId) });
    }

    // ── Workflow transitions REVIEW / APPROVE / REVERT ──────────────────
    const runId = Number(body.runId);
    const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
    if (!run) return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
    const denial = await assertManage(user, run.businessId);
    if (denial) return denial;

    const set: any = { updatedAt: new Date() };
    if (action === "REVIEW" && run.status === "DRAFT") {
      set.status = "REVIEWED"; set.reviewedByName = user.name; set.reviewedAt = new Date();
    } else if (action === "APPROVE" && run.status === "REVIEWED") {
      set.status = "APPROVED"; set.approvedByName = user.name; set.approvedAt = new Date();
    } else if (action === "REVERT" && run.status === "REVIEWED") {
      set.status = "DRAFT"; set.reviewedByName = null; set.reviewedAt = null;
    } else {
      return NextResponse.json(
        { success: false, error: `Cannot ${action} a run in status ${run.status}.` },
        { status: 400 }
      );
    }
    await db.update(payrollRuns).set(set).where(eq(payrollRuns.id, runId));
    return NextResponse.json({ success: true, run: await runWithEntries(runId) });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const body = await request.json();

    if (body.attendanceId) {
      const [row] = await db.select().from(payrollAttendance).where(eq(payrollAttendance.id, Number(body.attendanceId)));
      if (!row) return NextResponse.json({ success: false, error: "Attendance row not found" }, { status: 404 });
      const denial = await assertManage(user, row.businessId);
      if (denial) return denial;
      await db.delete(payrollAttendance).where(eq(payrollAttendance.id, row.id));
      return NextResponse.json({ success: true, removed: row.id });
    }

    const runId = Number(body.runId);
    const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
    if (!run) return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
    const denial = await assertManage(user, run.businessId);
    if (denial) return denial;
    if (run.status !== "DRAFT") {
      return NextResponse.json(
        { success: false, error: "Only DRAFT runs can be discarded — reviewed/approved/paid runs stay on the audit trail." },
        { status: 400 }
      );
    }
    await db.delete(payrollEntries).where(eq(payrollEntries.runId, runId));
    await db.delete(payrollRuns).where(eq(payrollRuns.id, runId));
    return NextResponse.json({ success: true, removed: run.period });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
