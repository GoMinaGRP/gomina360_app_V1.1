/**
 * Employee number + record creation — ONE writer for the staff roster.
 *
 * Two intake paths existed: the full Employee Registration form
 * (`/api/employees`) and the QR/quick-add flow in `/api/enterprise`. Both
 * generate the staff number and write the row, so the sequence logic lived in
 * two places (one of them a hand-rolled regexp MAX query) and the two paths
 * could drift in numbering or history. Everything now goes through this
 * module: numbers are PER BUSINESS (each unit numbers its own roster from
 * EMP-0001 — never a continuation of another unit's or organization's
 * sequence), and every insert records its `employeeHistory` CREATED row.
 */
import { db } from "@/db";
import { employees, employeeHistory } from "@/db/schema";
import { eq } from "drizzle-orm";

const empNo = (n: number) => `EMP-${String(n).padStart(4, "0")}`;

/** Next staff number for a unit — EMP-0001… numbered PER BUSINESS. */
export async function nextEmployeeNo(businessId: number): Promise<string> {
  const rows = await db
    .select({ employeeNo: employees.employeeNo })
    .from(employees)
    .where(eq(employees.businessId, Number(businessId)));
  let max = 0;
  for (const r of rows) {
    const m = /^EMP-(\d+)$/.exec(String(r.employeeNo || "").trim().toUpperCase());
    if (m) max = Math.max(max, Number(m[1]) || 0);
  }
  return empNo(max + 1);
}

export interface EmployeeHistoryActor {
  id?: number | null;
  name?: string | null;
  role?: string | null;
}

/** Append an employee-history row (shared by create and the edit routes). */
export async function recordEmployeeHistory(input: {
  employeeId: number;
  businessId: number;
  action: string;
  summary: string;
  field?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  actor: EmployeeHistoryActor;
}) {
  await db.insert(employeeHistory).values({
    employeeId: input.employeeId,
    businessId: input.businessId,
    action: input.action,
    field: input.field || null,
    oldValue: input.oldValue === undefined || input.oldValue === null ? null : String(input.oldValue),
    newValue: input.newValue === undefined || input.newValue === null ? null : String(input.newValue),
    summary: input.summary,
    changedByUserId: input.actor.id ?? null,
    changedByName: input.actor.name ?? null,
    changedByRole: input.actor.role ?? null,
  });
}

export interface CreateEmployeeInput {
  businessId: number;
  name: string;
  role: string;
  branch?: string | null;
  region?: string | null;
  district?: string | null;
  town?: string | null;
  salaryGhs?: number | null;
  phone?: string | null;
  email?: string | null;
  hireDate?: string | null;
  status?: string | null;
  /** Explicit staff number (validated free by the caller); auto-generated when absent. */
  employeeNo?: string | null;
  photo?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  address?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  workSchedule?: string | null;
  shift?: string | null;
  dailyHours?: number | string | null;
  workDays?: string | null;
  leaveEntitlementDays?: number | string | null;
  idType?: string | null;
  idNumber?: string | null;
  workPermitNo?: string | null;
  notes?: string | null;
  /** Human wording for the CREATED history summary. A function receives the
   *  created row, so the summary can quote the AUTO-GENERATED staff number. */
  historySummary?: string | ((row: any) => string);
  actor: EmployeeHistoryActor;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const str = (v: unknown) => String(v ?? "").trim();

/**
 * Create one employee + its CREATED history entry. Callers keep their own
 * validation/permission checks; this owns the roster write itself.
 */
export async function createEmployeeRecord(input: CreateEmployeeInput) {
  const businessId = Number(input.businessId);
  const employeeNo =
    str(input.employeeNo).toUpperCase() || (await nextEmployeeNo(businessId));

  const [row] = await db
    .insert(employees)
    .values({
      name: str(input.name) || "New Employee",
      role: str(input.role) || "Staff",
      businessId,
      branch: str(input.branch) || "",
      region: input.region || null,
      district: input.district || null,
      town: input.town || null,
      salaryGhs: num(input.salaryGhs),
      phone: str(input.phone) || "—",
      email: input.email ? str(input.email) : null,
      hireDate: input.hireDate || new Date().toISOString().slice(0, 10),
      status: input.status || "ACTIVE",
      employeeNo,
      photo: input.photo || null,
      dateOfBirth: input.dateOfBirth || null,
      gender: input.gender || null,
      address: input.address || null,
      emergencyContactName: input.emergencyContactName || null,
      emergencyContactPhone: input.emergencyContactPhone || null,
      workSchedule: input.workSchedule || "FULL_TIME",
      shift: input.shift || "DAY",
      dailyHours: input.dailyHours !== undefined && input.dailyHours !== "" ? num(input.dailyHours) : 8,
      workDays: input.workDays || "MON,TUE,WED,THU,FRI",
      leaveEntitlementDays:
        input.leaveEntitlementDays !== undefined && input.leaveEntitlementDays !== ""
          ? num(input.leaveEntitlementDays)
          : 15,
      idType: input.idType || null,
      idNumber: input.idNumber || null,
      workPermitNo: input.workPermitNo || null,
      notes: input.notes || null,
    })
    .returning();

  await recordEmployeeHistory({
    employeeId: row.id,
    businessId: row.businessId,
    action: "CREATED",
    summary:
      typeof input.historySummary === "function"
        ? input.historySummary(row)
        : input.historySummary ||
          `Registered ${row.name} (${row.employeeNo}) — ${row.role}, GH₵ ${num(row.salaryGhs).toLocaleString()}/month`,
    actor: input.actor,
  });

  return row;
}

export { empNo };
