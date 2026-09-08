import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { attendanceLogs, businesses, employees, payrollAttendance } from "@/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getSessionInfo, accessibleBusinessIds, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";

/**
 * Staff Attendance — Clock In / Clock Out with GPS.
 *
 * Every clock event auto-records date, time, Business and Branch (from the
 * worker's assignment — never from client input for non-owners) plus the GPS
 * fix the browser provides. Events farther than the branch anchor radius are
 * flagged off-site. Reviews are visible to the OWNER always, and to
 * authorized Managers/Supervisors (canManageRecords or a manager/supervisor
 * role) restricted to their accessible businesses. Clock-out derives hours &
 * overtime and writes them into payroll_attendance so payroll runs + reports
 * pick them up automatically — a manager's manual register row for the same
 * employee/day always wins (never overwritten).
 */

const REVIEW_ROLES = ["GENERAL_MANAGER", "BRANCH_MANAGER", "SUPERVISOR", "ACCOUNTANT"];
const WORK_START_HOURS = 8; // standard shift — anything beyond counts as OT

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function reviewerScope(user: any, allowed: number[] | null) {
  const canReview = user.role === "OWNER" || !!user.canManageRecords || REVIEW_ROLES.includes(user.role);
  if (!canReview) return { canReview: false, businessIds: [] as number[] | null };
  return { canReview: true, businessIds: user.role === "OWNER" ? null : allowed };
}

/** Resolve the employees row for a user inside a business (email first, then exact name). */
async function matchEmployee(user: any, businessId: number, staff?: any[]) {
  const rows = staff ?? (await db.select().from(employees).where(eq(employees.businessId, businessId)));
  const email = String(user.email || "").toLowerCase();
  const name = String(user.name || "").trim().toLowerCase();
  return (
    rows.find((e) => (e.email || "").toLowerCase() === email && email) ||
    rows.find((e) => (e.name || "").trim().toLowerCase() === name && name) ||
    null
  );
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user;
    const { searchParams } = new URL(request.url);
    const businessId = Number(searchParams.get("businessId")) || null;
    const employeeId = Number(searchParams.get("employeeId")) || null;
    const date = searchParams.get("date") || null;
    const offSiteOnly = searchParams.get("offSite") === "1";
    const mineOnly = searchParams.get("mine") === "1";

    const allowed = await accessibleBusinessIds(user);
    const scope = reviewerScope(user, allowed);

    const [allLogsCircle, bizRows] = await Promise.all([
      db.select().from(attendanceLogs).orderBy(desc(attendanceLogs.id)),
      db.select().from(businesses),
    ]);

    const inScope = (l: any) =>
      (allowed === null || allowed.includes(Number(l.businessId))) &&
      (businessId ? Number(l.businessId) === businessId : true);

    // Mine: everything the session user clocked (visibility is never gated).
    const myLogs = allLogsCircle
      .filter((l) => l.userId === user.id && (businessId ? Number(l.businessId) === businessId : true))
      .slice(0, 90);
    const openShift = myLogs.find((l) => !l.clockOutAt) || null;

    // Reviewer view (authorized managers/supervisors/owner, scoped).
    let logs: any[] = [];
    if (scope.canReview && !mineOnly) {
      logs = allLogsCircle.filter((l) => {
        if (scope.businessIds !== null && !scope.businessIds!.includes(Number(l.businessId))) return false;
        if (!inScope(l)) return false;
        if (employeeId && Number(l.employeeId) !== employeeId) return false;
        if (date && l.date !== date) return false;
        if (offSiteOnly && !(l.offSiteIn || l.offSiteOut)) return false;
        return true;
      }).slice(0, 300);
    }

    const anchors = bizRows
      .filter((b) => allowed === null || allowed.includes(b.id))
      .map((b) => ({
        id: b.id,
        code: b.code,
        name: b.name,
        branchLocation: b.branchLocation,
        gpsLat: b.gpsLat,
        gpsLng: b.gpsLng,
        gpsRadiusM: b.gpsRadiusM ?? 300,
        anchored: b.gpsLat != null && b.gpsLng != null,
      }));

    return NextResponse.json({
      success: true,
      myLogs,
      openShift,
      logs,
      anchors,
      meta: {
        canReview: scope.canReview,
        businessIds: scope.businessIds,
        canSetLocation: user.role === "OWNER" || !!user.canManageRecords,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user;
    const body = await request.json();
    const action = String(body.action || "");

    const allowed = await accessibleBusinessIds(user);
    const coord = (v: any) => {
      if (v === undefined || v === null || v === "") return null; // null stays null —
      const n = Number(v);                                          // Number(null)===0 would
      return Number.isFinite(n) ? n : null;                         // forge a (0,0) GPS fix
    };

    // ── CLOCK IN ──────────────────────────────────────────────────────────
    if (action === "CLOCK_IN") {
      // Business resolution: non-privileged roles are pinned to their
      // assignment; OWNER/GM pick the branch they are physically at.
      let businessId: number | null = null;
      if (["WORKER", "BRANCH_MANAGER", "SUPERVISOR", "ACCOUNTANT"].includes(user.role)) {
        businessId = user.assignedBusinessId ? Number(user.assignedBusinessId) : null;
        if (!businessId) {
          return NextResponse.json({ success: false, error: "Your account is not assigned to a business branch yet" }, { status: 400 });
        }
      } else {
        businessId = Number(body.businessId) || null;
        if (!businessId) {
          return NextResponse.json({ success: false, error: "Choose the business/branch you are at" }, { status: 400 });
        }
        if (!(await canAccessBusiness(user, businessId))) return FORBIDDEN();
      }
      const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
      if (!biz) {
        return NextResponse.json({ success: false, error: "Business not found" }, { status: 404 });
      }

      const [open] = await db
        .select()
        .from(attendanceLogs)
        .where(and(eq(attendanceLogs.userId, user.id), isNull(attendanceLogs.clockOutAt)))
        .orderBy(desc(attendanceLogs.id))
        .limit(1);
      if (open) {
        return NextResponse.json(
          { success: false, error: `Already clocked in since ${new Date(open.clockInAt).toISOString()} — clock out first`, open },
          { status: 409 },
        );
      }

      const lat = coord(body.lat);
      const lng = coord(body.lng);
      const accuracy = coord(body.accuracy);
      const hasFix = lat != null && lng != null;
      let distanceM: number | null = null;
      let offSite = false;
      if (hasFix && biz.gpsLat != null && biz.gpsLng != null) {
        distanceM = Math.round(haversineM(lat, lng, biz.gpsLat, biz.gpsLng) * 10) / 10;
        offSite = distanceM > (biz.gpsRadiusM ?? 300);
      }

      const employee = await matchEmployee(user, businessId);
      const now = new Date();
      const [row] = await db.insert(attendanceLogs).values({
        userId: user.id,
        employeeId: employee?.id ?? null,
        employeeName: employee?.name || user.name,
        businessId,
        branchCode: biz.code,
        branchName: biz.branchLocation || biz.name,
        date: now.toISOString().slice(0, 10),
        clockInAt: now,
        clockInLat: lat,
        clockInLng: lng,
        clockInAccuracyM: accuracy,
        clockInMethod: hasFix ? "GPS" : "MANUAL",
        clockInDistanceM: distanceM,
        offSiteIn: offSite,
        note: body.note ? String(body.note).slice(0, 500) : null,
      }).returning();
      return NextResponse.json({ success: true, item: row, offSite, distanceM });
    }

    // ── CLOCK OUT ─────────────────────────────────────────────────────────
    if (action === "CLOCK_OUT") {
      const [open] = await db
        .select()
        .from(attendanceLogs)
        .where(and(eq(attendanceLogs.userId, user.id), isNull(attendanceLogs.clockOutAt)))
        .orderBy(desc(attendanceLogs.id))
        .limit(1);
      if (!open) {
        return NextResponse.json({ success: false, error: "No open shift — clock in first" }, { status: 404 });
      }
      const [biz] = await db.select().from(businesses).where(eq(businesses.id, open.businessId)).limit(1);
      const lat = coord(body.lat);
      const lng = coord(body.lng);
      const accuracy = coord(body.accuracy);
      const hasFix = lat != null && lng != null;
      let distanceM: number | null = null;
      let offSite = false;
      if (hasFix && biz?.gpsLat != null && biz?.gpsLng != null) {
        distanceM = Math.round(haversineM(lat, lng, biz.gpsLat, biz.gpsLng) * 10) / 10;
        offSite = distanceM > (biz.gpsRadiusM ?? 300);
      }

      const now = new Date();
      const hours = Math.round((((now.getTime() - new Date(open.clockInAt).getTime()) / 3600000) * 100)) / 100;
      const ot = Math.max(0, Math.round((hours - WORK_START_HOURS) * 100) / 100);

      const [row] = await db
        .update(attendanceLogs)
        .set({
          clockOutAt: now,
          clockOutLat: lat,
          clockOutLng: lng,
          clockOutAccuracyM: accuracy,
          clockOutMethod: hasFix ? "GPS" : "MANUAL",
          clockOutDistanceM: distanceM,
          hoursWorked: hours,
          overtimeHours: ot,
          offSiteOut: offSite,
        })
        .where(eq(attendanceLogs.id, open.id))
        .returning();

      // ── Payroll link: shift hours + OT feed the register the payroll run
      // engine consumes. A manager's manual row for the same employee+day
      // is authoritative and never overwritten by the clock.
      let payrollLinked = false;
      if (open.employeeId) {
        const existing = await db
          .select()
          .from(payrollAttendance)
          .where(
            and(
              eq(payrollAttendance.employeeId, open.employeeId),
              eq(payrollAttendance.businessId, open.businessId),
              eq(payrollAttendance.date, open.date),
            ),
          )
          .limit(1);
        if (existing.length === 0) {
          await db.insert(payrollAttendance).values({
            employeeId: open.employeeId,
            employeeName: open.employeeName,
            businessId: open.businessId,
            branchCode: open.branchCode,
            date: open.date,
            status: "PRESENT",
            hoursWorked: Math.min(hours, WORK_START_HOURS) > 0 ? Math.round(Math.min(hours, WORK_START_HOURS) * 100) / 100 : 0,
            overtimeHours: ot,
            note: `Auto from clock-in/out (${now.toISOString().slice(11, 16)} out)`,
            recordedByUserId: user.id,
            recordedByName: "Attendance Clock",
          });
          payrollLinked = true;
        }
      }

      return NextResponse.json({ success: true, item: row, hoursWorked: hours, overtimeHours: ot, offSite, distanceM, payrollLinked });
    }

    // ── SET BUSINESS LOCATION (geofence anchor) ───────────────────────────
    if (action === "SET_BUSINESS_LOCATION") {
      if (!(user.role === "OWNER" || user.canManageRecords)) return FORBIDDEN();
      const businessId = Number(body.businessId) || 0;
      if (!businessId || !(await canAccessBusiness(user, businessId))) return FORBIDDEN();
      const lat = coord(body.lat);
      const lng = coord(body.lng);
      if (lat == null || lng == null) {
        return NextResponse.json({ success: false, error: "GPS coordinates required" }, { status: 400 });
      }
      const radiusM = Math.max(50, Math.min(5000, Number(body.radiusM) || 300));
      const [row] = await db
        .update(businesses)
        .set({ gpsLat: lat, gpsLng: lng, gpsRadiusM: radiusM })
        .where(eq(businesses.id, businessId))
        .returning();
      if (!row) return NextResponse.json({ success: false, error: "Business not found" }, { status: 404 });
      return NextResponse.json({ success: true, item: { id: row.id, code: row.code, gpsLat: row.gpsLat, gpsLng: row.gpsLng, gpsRadiusM: row.gpsRadiusM } });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
