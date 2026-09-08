import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  employees,
  employeeDocuments,
  employeeHistory,
  businesses,
  payrollEntries,
  payrollAttendance,
} from "@/db/schema";
import { eq, inArray, desc, sql } from "drizzle-orm";
import {
  getSessionInfo,
  accessibleBusinessIds,
  canAccessBusiness,
  FORBIDDEN,
  UNAUTHENTICATED,
} from "@/lib/auth";
import { canManageSharedRecords } from "@/lib/recordPermissions";

/**
 * Employee Registration — complete HR records:
 * personal information (incl. photo upload/camera), work & attendance
 * profile, identity & compliance fields, documents (contracts, certificates,
 * qualifications, work permits) and an immutable record history.
 *
 * Permission model matches the rest of the app: the OWNER does everything;
 * other roles need the OWNER-granted canManageRecords flag AND business
 * access. Read is scope-filtered the same way as payroll.
 */

const DOC_TYPES = ["ID_COPY", "EMPLOYMENT_CONTRACT", "CERTIFICATE", "QUALIFICATION", "WORK_PERMIT", "OTHER"];

// Fields tracked by the record history (label = human-readable, for the trail)
const TRACKED: [string, string][] = [
  ["name", "Full name"],
  ["role", "Role / position"],
  ["salaryGhs", "Monthly salary (GH₵)"],
  ["status", "Status"],
  ["phone", "Phone"],
  ["email", "Email"],
  ["dateOfBirth", "Date of birth"],
  ["gender", "Gender"],
  ["address", "Address"],
  ["emergencyContactName", "Emergency contact name"],
  ["emergencyContactPhone", "Emergency contact phone"],
  ["workSchedule", "Work schedule"],
  ["shift", "Shift"],
  ["dailyHours", "Working hours/day"],
  ["workDays", "Assigned days"],
  ["leaveEntitlementDays", "Leave entitlement (days/yr)"],
  ["idType", "ID type"],
  ["idNumber", "ID number"],
  ["workPermitNo", "Work permit no."],
  ["hireDate", "Hire date"],
  ["businessId", "Business"],
  ["branch", "Branch"],
  ["region", "Region"],
  ["district", "District"],
  ["town", "Town"],
  ["notes", "Notes"],
];

const empNo = (n: number) => `EMP-${String(n).padStart(4, "0")}`;

async function nextEmployeeNo(): Promise<string> {
  const rows = await db
    .select({ v: sql<string>`max(nullif(regexp_replace(coalesce(${employees.employeeNo}, ''), '\\D', '', 'g'), '')::int)` })
    .from(employees);
  const max = Number(rows[0]?.v) || 0;
  return empNo(max + 1);
}

async function assertEmployeeAccess(user: any, businessId: number) {
  if (user.role === "OWNER") return null;
  if (!canManageSharedRecords(user)) {
    return FORBIDDEN("Only the OWNER (or a manager the OWNER has granted record-management permission) can manage employee records.");
  }
  if (!(await canAccessBusiness(user, businessId))) {
    return FORBIDDEN("That employee belongs to a business you cannot access.");
  }
  return null;
}

async function hist(
  employeeId: number,
  businessId: number,
  action: string,
  summary: string,
  user: any,
  field?: string | null,
  oldValue?: any,
  newValue?: any
) {
  await db.insert(employeeHistory).values({
    employeeId,
    businessId,
    action,
    field: field || null,
    oldValue: oldValue === undefined || oldValue === null ? null : String(oldValue),
    newValue: newValue === undefined || newValue === null ? null : String(newValue),
    summary,
    changedByUserId: user.id,
    changedByName: user.name,
    changedByRole: user.role,
  });
}

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const url = new URL(request.url);
    const businessId = url.searchParams.get("businessId");
    const employeeId = url.searchParams.get("employeeId");

    const allowed = await accessibleBusinessIds(user); // null ⇒ OWNER
    const inScope = (bid: number) => allowed === null || allowed.includes(bid);

    let rows = await db.select().from(employees).orderBy(employees.id);
    rows = rows.filter((e) => inScope(e.businessId));
    if (businessId) rows = rows.filter((e) => e.businessId === Number(businessId));
    if (employeeId) rows = rows.filter((e) => e.id === Number(employeeId));

    // ── Linkage aggregates: Payroll / Attendance per employee ────────────
    const ids = rows.map((e) => e.id);
    const links: Record<number, any> = {};
    if (ids.length) {
      const payRows = await db
        .select({
          employeeId: payrollEntries.employeeId,
          cnt: sql<number>`count(*)::int`,
          net: sql<number>`coalesce(sum(${payrollEntries.netPayGhs}),0)::float8`,
        })
        .from(payrollEntries)
        .where(inArray(payrollEntries.employeeId, ids))
        .groupBy(payrollEntries.employeeId);
      const attRows = await db
        .select({
          employeeId: payrollAttendance.employeeId,
          cnt: sql<number>`count(*)::int`,
          ot: sql<number>`coalesce(sum(${payrollAttendance.overtimeHours}),0)::float8`,
          leaveDays: sql<number>`count(*) filter (where ${payrollAttendance.status} = 'LEAVE')::int`,
        })
        .from(payrollAttendance)
        .where(inArray(payrollAttendance.employeeId, ids))
        .groupBy(payrollAttendance.employeeId);
      for (const id of ids) {
        const p = payRows.find((r) => r.employeeId === id);
        const a = attRows.find((r) => r.employeeId === id);
        links[id] = {
          payrollEntries: p?.cnt || 0,
          payrollNet: Math.round((p?.net || 0) * 100) / 100,
          attendanceRows: a?.cnt || 0,
          overtimeHours: Math.round((a?.ot || 0) * 100) / 100,
          leaveDaysTaken: a?.leaveDays || 0,
        };
      }
    }

    // Documents: metadata always; the file payload only when one employee
    // is requested (keeps the list endpoint lean).
    let docs = ids.length
      ? await db
          .select()
          .from(employeeDocuments)
          .where(inArray(employeeDocuments.employeeId, ids))
          .orderBy(desc(employeeDocuments.id))
      : [];
    docs = docs.filter((d) => inScope(d.businessId));
    const metas = docs.map((d) => ({
      id: d.id, employeeId: d.employeeId, businessId: d.businessId, docType: d.docType,
      title: d.title, fileName: d.fileName, issuedOn: d.issuedOn, expiresOn: d.expiresOn,
      note: d.note, uploadedByName: d.uploadedByName, createdAt: d.createdAt,
      hasFile: !!d.fileData,
    }));

    let history: any[] = [];
    if (employeeId) {
      history = await db
        .select()
        .from(employeeHistory)
        .where(eq(employeeHistory.employeeId, Number(employeeId)))
        .orderBy(desc(employeeHistory.id))
        .limit(200);
    } else {
      const hcounts = ids.length
        ? await db
            .select({ employeeId: employeeHistory.employeeId, cnt: sql<number>`count(*)::int` })
            .from(employeeHistory)
            .where(inArray(employeeHistory.employeeId, ids))
            .groupBy(employeeHistory.employeeId)
        : [];
      for (const h of hcounts) (links[h.employeeId] ||= {}).historyCount = h.cnt;
    }

    return NextResponse.json({
      success: true,
      employees: rows,
      documents: metas,
      documentFiles: employeeId ? docs.filter((d) => d.employeeId === Number(employeeId)).map((d) => ({ id: d.id, fileData: d.fileData })) : [],
      history,
      links,
      scope: {
        canManage: canManageSharedRecords(user),
        isOwner: user.role === "OWNER",
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

    // ── Upload a document ────────────────────────────────────────────────
    if (body.action === "ADD_DOCUMENT") {
      const d = body.data || {};
      const empId = Number(d.employeeId);
      const [emp] = await db.select().from(employees).where(eq(employees.id, empId));
      if (!emp) return NextResponse.json({ success: false, error: "Employee not found" }, { status: 404 });
      const denial = await assertEmployeeAccess(user, emp.businessId);
      if (denial) return denial;
      const docType = DOC_TYPES.includes(d.docType) ? d.docType : "OTHER";
      const title = String(d.title || "").trim();
      if (!title) return NextResponse.json({ success: false, error: "Document title is required" }, { status: 400 });
      const fileData = d.fileData ? String(d.fileData) : null;
      if (fileData && !/^(data:image\/|data:application\/pdf)/.test(fileData)) {
        return NextResponse.json({ success: false, error: "Only images or PDF files are accepted." }, { status: 400 });
      }
      if (fileData && fileData.length > 3_500_000) {
        return NextResponse.json({ success: false, error: "File too large — keep it under about 2.5MB." }, { status: 400 });
      }
      const [row] = await db
        .insert(employeeDocuments)
        .values({
          employeeId: emp.id,
          businessId: emp.businessId,
          docType,
          title: title.slice(0, 120),
          fileName: d.fileName ? String(d.fileName).slice(0, 160) : null,
          fileData,
          issuedOn: d.issuedOn || null,
          expiresOn: d.expiresOn || null,
          note: d.note ? String(d.note).slice(0, 300) : null,
          uploadedByUserId: user.id,
          uploadedByName: user.name,
        })
        .returning();
      await hist(emp.id, emp.businessId, "DOCUMENT_ADDED", `Document added: ${title} (${docType.replaceAll("_", " ").toLowerCase()})`, user);
      const { fileData: _omit, ...meta } = row as any;
      return NextResponse.json({ success: true, document: meta });
    }

    // ── Register a new employee ──────────────────────────────────────────
    const d = body.data || body;
    const businessId = Number(d.businessId);
    const name = String(d.name || "").trim();
    const role = String(d.role || "").trim();
    const salaryGhs = Number(d.salaryGhs);
    if (!name || !role || !businessId || !Number.isFinite(salaryGhs) || salaryGhs < 0) {
      return NextResponse.json(
        { success: false, error: "Name, role, business and a valid monthly salary are required." },
        { status: 400 }
      );
    }
    const denial = await assertEmployeeAccess(user, businessId);
    if (denial) return denial;
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    if (!biz) return NextResponse.json({ success: false, error: "Business not found" }, { status: 404 });

    const photo = d.photo ? String(d.photo) : null;
    if (photo && (!photo.startsWith("data:image/") || photo.length > 1_800_000)) {
      return NextResponse.json({ success: false, error: "Photo must be an image under about 1.5MB." }, { status: 400 });
    }

    // Employee number: use the given one if free, else auto-generate.
    let employeeNo = String(d.employeeNo || "").trim().toUpperCase();
    if (employeeNo) {
      const dupe = await db.select({ id: employees.id }).from(employees).where(eq(employees.employeeNo, employeeNo));
      if (dupe.length) {
        return NextResponse.json({ success: false, error: `Employee ID ${employeeNo} is already in use.` }, { status: 409 });
      }
    } else {
      employeeNo = await nextEmployeeNo();
    }

    const [row] = await db
      .insert(employees)
      .values({
        name,
        role,
        businessId,
        branch: String(d.branch || biz.code || "").trim() || biz.code,
        region: d.region || null,
        district: d.district || null,
        town: d.town || null,
        salaryGhs,
        phone: String(d.phone || "").trim() || "—",
        hireDate: d.hireDate || new Date().toISOString().slice(0, 10),
        status: "ACTIVE",
        employeeNo,
        dateOfBirth: d.dateOfBirth || null,
        gender: d.gender || null,
        email: d.email ? String(d.email).trim() : null,
        address: d.address || null,
        emergencyContactName: d.emergencyContactName || null,
        emergencyContactPhone: d.emergencyContactPhone || null,
        photo,
        workSchedule: d.workSchedule || "FULL_TIME",
        shift: d.shift || "DAY",
        dailyHours: d.dailyHours !== undefined && d.dailyHours !== "" ? Number(d.dailyHours) : 8,
        workDays: d.workDays || "MON,TUE,WED,THU,FRI",
        leaveEntitlementDays: d.leaveEntitlementDays !== undefined && d.leaveEntitlementDays !== "" ? Number(d.leaveEntitlementDays) : 15,
        idType: d.idType || null,
        idNumber: d.idNumber || null,
        workPermitNo: d.workPermitNo || null,
        notes: d.notes || null,
      })
      .returning();
    await hist(
      row.id,
      row.businessId,
      "CREATED",
      `Registered ${row.name} (${row.employeeNo}) — ${row.role}, ${biz.name}, GH₵ ${salaryGhs.toLocaleString()}/month${photo ? ", photo captured" : ""}`,
      user
    );
    return NextResponse.json({ success: true, employee: row });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const body = await request.json();
    const id = Number(body.id);
    const [existing] = await db.select().from(employees).where(eq(employees.id, id));
    if (!existing) return NextResponse.json({ success: false, error: "Employee not found" }, { status: 404 });
    const newBusinessId = body.data?.businessId !== undefined ? Number(body.data.businessId) : existing.businessId;
    const denial = await assertEmployeeAccess(user, existing.businessId);
    if (denial) return denial;
    if (newBusinessId !== existing.businessId) {
      const denial2 = await assertEmployeeAccess(user, newBusinessId);
      if (denial2) return denial2;
    }

    const d = body.data || {};
    const updates: Record<string, any> = {};
    const changes: { field: string; label: string; oldV: any; newV: any }[] = [];
    for (const [key, label] of TRACKED) {
      if (d[key] === undefined) continue;
      let newV: any = d[key];
      if (["salaryGhs", "dailyHours"].includes(key)) newV = Number(newV) || 0;
      if (key === "leaveEntitlementDays") newV = Math.max(0, Math.round(Number(newV) || 0));
      if (typeof newV === "string") newV = newV.trim() || null;
      const oldV = (existing as any)[key];
      if (String(oldV ?? "") === String(newV ?? "")) continue;
      updates[key] = newV;
      changes.push({ field: key, label, oldV, newV });
    }
    // Employee ID change needs a uniqueness check
    if (d.employeeNo !== undefined) {
      const no = String(d.employeeNo || "").trim().toUpperCase();
      if (no && no !== existing.employeeNo) {
        const dupe = await db.select({ id: employees.id }).from(employees).where(eq(employees.employeeNo, no));
        if (dupe.length) return NextResponse.json({ success: false, error: `Employee ID ${no} is already in use.` }, { status: 409 });
        updates.employeeNo = no;
        changes.push({ field: "employeeNo", label: "Employee ID", oldV: existing.employeeNo, newV: no });
      }
    }
    // Photo update (upload or camera capture)
    let photoChanged = false;
    if (d.photo !== undefined) {
      const photo = d.photo ? String(d.photo) : null;
      if (photo && (!photo.startsWith("data:image/") || photo.length > 1_800_000)) {
        return NextResponse.json({ success: false, error: "Photo must be an image under about 1.5MB." }, { status: 400 });
      }
      updates.photo = photo;
      photoChanged = true;
    }

    if (!Object.keys(updates).length) {
      return NextResponse.json({ success: false, error: "Nothing changed to update." }, { status: 400 });
    }
    const [updated] = await db.update(employees).set(updates).where(eq(employees.id, id)).returning();

    // Record the history — one row per important change.
    for (const c of changes) {
      await hist(id, updated.businessId, "UPDATED", `${c.label} changed: ${c.oldV ?? "—"} → ${c.newV ?? "—"}`, user, c.field, c.oldV, c.newV);
    }
    if (photoChanged) {
      await hist(id, updated.businessId, "PHOTO_UPDATED", updated.photo ? "Profile photo updated" : "Profile photo removed", user);
    }
    return NextResponse.json({ success: true, employee: updated, changes: changes.length + (photoChanged ? 1 : 0) });
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

    // Remove a document (the removal itself is recorded in the history)
    const docId = Number(body.documentId);
    if (!docId) return NextResponse.json({ success: false, error: "documentId is required" }, { status: 400 });
    const [doc] = await db.select().from(employeeDocuments).where(eq(employeeDocuments.id, docId));
    if (!doc) return NextResponse.json({ success: false, error: "Document not found" }, { status: 404 });
    const denial = await assertEmployeeAccess(user, doc.businessId);
    if (denial) return denial;
    await db.delete(employeeDocuments).where(eq(employeeDocuments.id, docId));
    await hist(doc.employeeId, doc.businessId, "DOCUMENT_REMOVED", `Document removed: ${doc.title} (${doc.docType.replaceAll("_", " ").toLowerCase()})`, user);
    return NextResponse.json({ success: true, removed: docId });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
