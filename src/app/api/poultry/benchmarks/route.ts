import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import {
  poultryBenchmarkProfiles,
  poultryFlocks,
  poultryFeedLogs,
  poultryHealthRecords,
  poultryProduction,
  poultryWeightLogs,
} from "@/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { apiError } from "@/lib/apiError";
import { auditLog } from "@/lib/audit";
import { ownerOrgOfBusiness } from "@/lib/notify";
import {
  BENCHMARK_TEMPLATES,
  deriveCurvesFromFlock,
  validateCurves,
  type BenchmarkCurves,
} from "@/lib/poultryBenchmarking";

/**
 * FLOCK PERFORMANCE BENCHMARKING — sub-module of the Poultry Farm.
 *
 * GET    /api/poultry/benchmarks?businessId=1
 *        → profiles (with flock usage) + the built-in copyable templates.
 * POST   { entity: "PROFILE", data: { businessId, name, birdType, breed,
 *          source?, isDefault?, toleranceWarnPct?, toleranceCritPct?,
 *          curves?, notes?, deriveFromFlockId?, createdByName?, createdByRole? } }
 *        Create a profile. `deriveFromFlockId` builds the curves from a real
 *        (usually finished) flock's logged performance (FARM_HISTORY source).
 * PATCH  { entity: "PROFILE", id, data: {…} }
 *        Update header/curves; setting isDefault clears other defaults of the
 *        same bird type. ARCHIVED profiles never auto-match.
 * DELETE { entityType/… convention: body { entity: "PROFILE", id } }
 *        Blocked while any flock still references the profile.
 *
 * Mutations require OWNER / GENERAL_MANAGER / canManageRecords — the same
 * gate the Feed Mill uses. Curves are validated server-side
 * (poultryBenchmarking.validateCurves) before any write.
 */

const mayManage = (me: any) =>
  me.role === "OWNER" || me.role === "GENERAL_MANAGER" || me.canManageRecords === true;

const BIRD_TYPES = ["LAYERS", "BROILERS", "COCKERELS", "TURKEYS", "GUINEA_FOWL"];

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const bizId = Number(searchParams.get("businessId"));
    if (!bizId) {
      return NextResponse.json({ success: false, error: "businessId is required" }, { status: 400 });
    }
    if (!(await canAccessBusiness(session.user, bizId))) {
      return FORBIDDEN("You do not have access to that business.");
    }

    const profiles = await db
      .select()
      .from(poultryBenchmarkProfiles)
      .where(eq(poultryBenchmarkProfiles.businessId, bizId))
      .orderBy(desc(poultryBenchmarkProfiles.isDefault), desc(poultryBenchmarkProfiles.id));

    const flocks = await db
      .select({ id: poultryFlocks.id, batchNumber: poultryFlocks.batchNumber, benchmarkProfileId: poultryFlocks.benchmarkProfileId })
      .from(poultryFlocks)
      .where(eq(poultryFlocks.businessId, bizId));

    const usage = new Map<number, string[]>();
    for (const f of flocks) {
      if (f.benchmarkProfileId != null) {
        usage.set(Number(f.benchmarkProfileId), [...(usage.get(Number(f.benchmarkProfileId)) || []), f.batchNumber]);
      }
    }

    return NextResponse.json({
      success: true,
      profiles: profiles.map((p: any) => ({ ...p, usedByFlocks: usage.get(p.id) || [] })),
      templates: BENCHMARK_TEMPLATES,
    });
  } catch (error: any) {
    console.error("GET /api/poultry/benchmarks error:", error);
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { entity, data } = body;
    if (entity !== "PROFILE" || !data) {
      return NextResponse.json({ success: false, error: "entity PROFILE and data are required" }, { status: 400 });
    }
    const businessId = Number(data.businessId);
    if (!businessId) {
      return NextResponse.json({ success: false, error: "businessId is required" }, { status: 400 });
    }
    const session = await getSessionInfo(request);
    ttlInvalidate("init");
    if (!session) return UNAUTHENTICATED();
    if (!(await canAccessBusiness(session.user, businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }
    if (!mayManage(session.user)) {
      return FORBIDDEN("Only the OWNER, a General Manager or a records-authorized manager can manage benchmark profiles.");
    }

    // Derive-from-flock FIRST (it fills name/birdType/curves when omitted).
    let curvesRaw = data.curves;
    let source = String(data.source || "MANUAL").toUpperCase();
    if (data.deriveFromFlockId) {
      const [flock] = await db
        .select()
        .from(poultryFlocks)
        .where(and(eq(poultryFlocks.id, Number(data.deriveFromFlockId)), eq(poultryFlocks.businessId, businessId)));
      if (!flock) {
        return NextResponse.json({ success: false, error: "Flock to derive from was not found for this business." }, { status: 404 });
      }
      const [feedLogs, healthRecords, production, weightLogs] = await Promise.all([
        db.select().from(poultryFeedLogs).where(eq(poultryFeedLogs.businessId, businessId)),
        db.select().from(poultryHealthRecords).where(eq(poultryHealthRecords.businessId, businessId)),
        db.select().from(poultryProduction).where(eq(poultryProduction.businessId, businessId)),
        db.select().from(poultryWeightLogs).where(eq(poultryWeightLogs.businessId, businessId)),
      ]);
      const derived = deriveCurvesFromFlock(flock, { flocks: [flock], feedLogs, healthRecords, production, weightLogs });
      if (!Object.keys(derived).some((k) => k !== "_meta")) {
        return NextResponse.json(
          { success: false, error: "That flock has too little data to derive curves from (needs weight/feed/production logs)." },
          { status: 400 },
        );
      }
      // explicit curves win over derived ones when both are supplied
      curvesRaw = { ...derived, ...(curvesRaw || {}) };
      source = "FARM_HISTORY";
      if (!data.name) data.name = `${flock.batchNumber} performance`;
      if (!data.birdType) data.birdType = flock.birdType;
    }

    const birdType = String(data.birdType || "").toUpperCase();
    if (!BIRD_TYPES.includes(birdType)) {
      return NextResponse.json({ success: false, error: `birdType must be one of ${BIRD_TYPES.join(", ")}` }, { status: 400 });
    }

    const name = String(data.name || "").trim();
    if (!name) {
      return NextResponse.json({ success: false, error: "name is required" }, { status: 400 });
    }

    const { curves, error: curveError } = validateCurves(curvesRaw);
    if (curveError) {
      return NextResponse.json({ success: false, error: `Invalid curves: ${curveError}` }, { status: 400 });
    }

    const isDefault = data.isDefault === true;
    if (isDefault) {
      await db
        .update(poultryBenchmarkProfiles)
        .set({ isDefault: false })
        .where(and(eq(poultryBenchmarkProfiles.businessId, businessId), eq(poultryBenchmarkProfiles.birdType, birdType)));
    }

    const [row] = await db
      .insert(poultryBenchmarkProfiles)
      .values({
        businessId,
        branchCode: data.branchCode || null,
        ownerId: (await ownerOrgOfBusiness(businessId).catch(() => null)) ?? null,
        name,
        birdType,
        breed: data.breed || null,
        source: ["MANUAL", "TEMPLATE", "FARM_HISTORY"].includes(source) ? source : "MANUAL",
        status: "ACTIVE",
        isDefault,
        toleranceWarnPct: numOrNull(data.toleranceWarnPct, 5) ?? 5,
        toleranceCritPct: numOrNull(data.toleranceCritPct, 10) ?? 10,
        curves: curves as BenchmarkCurves,
        notes: data.notes || null,
        createdByName: data.createdByName || session.user?.name || "Farm Staff",
        createdByRole: data.createdByRole || session.user?.role || null,
        createdByUserId: session.user?.id ?? null,
        updatedAt: new Date(),
      })
      .returning();

    await auditLog(
      session.user, "POULTRY_BENCHMARK_CREATE", "RECORD",
      `Benchmark profile "${row.name}" created (${row.birdType}${row.breed ? ` · ${row.breed}` : ""})`,
      "OPERATION_LOG", row.id, businessId, data.branchCode || null,
      `${Object.keys(curves).filter((k) => k !== "_meta").length} curve(s)${isDefault ? " · set as default" : ""}`,
      (await ownerOrgOfBusiness(businessId).catch(() => null)) ?? null,
    ).catch((e: any) => console.error("[benchmarks] audit failed:", e));

    return NextResponse.json({ success: true, item: row });
  } catch (error: any) {
    console.error("POST /api/poultry/benchmarks error:", error);
    return apiError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    ttlInvalidate("init");
    if (!session) return UNAUTHENTICATED();
    const body = await request.json();
    const { entity, id, data } = body;
    if (entity !== "PROFILE" || !id) {
      return NextResponse.json({ success: false, error: "entity PROFILE and id are required" }, { status: 400 });
    }
    const [existing] = await db
      .select()
      .from(poultryBenchmarkProfiles)
      .where(eq(poultryBenchmarkProfiles.id, Number(id)));
    if (!existing) {
      return NextResponse.json({ success: false, error: "Benchmark profile not found" }, { status: 404 });
    }
    if (!(await canAccessBusiness(session.user, existing.businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }
    if (!mayManage(session.user)) {
      return FORBIDDEN("Only the OWNER, a General Manager or a records-authorized manager can manage benchmark profiles.");
    }

    let curves = existing.curves as BenchmarkCurves;
    if (data?.curves !== undefined) {
      const { curves: validated, error: curveError } = validateCurves(data.curves);
      if (curveError) {
        return NextResponse.json({ success: false, error: `Invalid curves: ${curveError}` }, { status: 400 });
      }
      curves = validated;
    }

    const isDefault = data?.isDefault === undefined ? existing.isDefault : data.isDefault === true;
    if (isDefault && !existing.isDefault) {
      await db
        .update(poultryBenchmarkProfiles)
        .set({ isDefault: false })
        .where(
          and(
            eq(poultryBenchmarkProfiles.businessId, existing.businessId),
            eq(poultryBenchmarkProfiles.birdType, data?.birdType || existing.birdType),
          ),
        );
    }

    const [row] = await db
      .update(poultryBenchmarkProfiles)
      .set({
        name: data?.name !== undefined ? String(data.name).trim() || existing.name : existing.name,
        birdType: data?.birdType ? String(data.birdType).toUpperCase() : existing.birdType,
        breed: data?.breed !== undefined ? data.breed || null : existing.breed,
        status: data?.status !== undefined ? (data.status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE") : existing.status,
        isDefault,
        toleranceWarnPct: data?.toleranceWarnPct !== undefined ? numOrNull(data.toleranceWarnPct, existing.toleranceWarnPct) ?? 5 : existing.toleranceWarnPct,
        toleranceCritPct: data?.toleranceCritPct !== undefined ? numOrNull(data.toleranceCritPct, existing.toleranceCritPct) ?? 10 : existing.toleranceCritPct,
        curves,
        notes: data?.notes !== undefined ? data.notes || null : existing.notes,
        updatedAt: new Date(),
      })
      .where(eq(poultryBenchmarkProfiles.id, Number(id)))
      .returning();

    await auditLog(
      session.user, "POULTRY_BENCHMARK_UPDATE", "RECORD",
      `Benchmark profile "${row.name}" updated`,
      "OPERATION_LOG", row.id, existing.businessId, existing.branchCode || null,
      [
        data?.curves !== undefined ? `curves → ${Object.keys(curves).filter((k) => k !== "_meta").length} metric(s)` : null,
        isDefault && !existing.isDefault ? "set as default" : null,
        data?.status ? `status → ${data.status}` : null,
      ].filter(Boolean).join(" · ") || "profile details updated",
      (await ownerOrgOfBusiness(existing.businessId).catch(() => null)) ?? null,
    ).catch((e: any) => console.error("[benchmarks] audit failed:", e));

    return NextResponse.json({ success: true, item: row });
  } catch (error: any) {
    console.error("PATCH /api/poultry/benchmarks error:", error);
    return apiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    ttlInvalidate("init");
    if (!session) return UNAUTHENTICATED();
    const body = await request.json();
    const { entity, id } = body;
    if (entity !== "PROFILE" || !id) {
      return NextResponse.json({ success: false, error: "entity PROFILE and id are required" }, { status: 400 });
    }
    const [existing] = await db
      .select()
      .from(poultryBenchmarkProfiles)
      .where(eq(poultryBenchmarkProfiles.id, Number(id)));
    if (!existing) {
      return NextResponse.json({ success: false, error: "Benchmark profile not found" }, { status: 404 });
    }
    if (!(await canAccessBusiness(session.user, existing.businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }
    if (!mayManage(session.user)) {
      return FORBIDDEN("Only the OWNER, a General Manager or a records-authorized manager can manage benchmark profiles.");
    }

    const users = await db
      .select({ batchNumber: poultryFlocks.batchNumber })
      .from(poultryFlocks)
      .where(and(eq(poultryFlocks.businessId, existing.businessId), eq(poultryFlocks.benchmarkProfileId, Number(id))));
    if (users.length) {
      return NextResponse.json(
        {
          success: false,
          error: `Profile is still assigned to ${users.length} flock(s): ${users.map((u) => u.batchNumber).join(", ")}. Reassign or clear those flocks first (or archive the profile instead).`,
        },
        { status: 409 },
      );
    }

    await db.delete(poultryBenchmarkProfiles).where(eq(poultryBenchmarkProfiles.id, Number(id)));
    await auditLog(
      session.user, "POULTRY_BENCHMARK_DELETE", "RECORD",
      `Benchmark profile "${existing.name}" deleted`,
      "OPERATION_LOG", existing.id, existing.businessId, existing.branchCode || null,
      null,
      (await ownerOrgOfBusiness(existing.businessId).catch(() => null)) ?? null,
    ).catch((e: any) => console.error("[benchmarks] audit failed:", e));

    return NextResponse.json({ success: true, removed: { id: existing.id, name: existing.name } });
  } catch (error: any) {
    console.error("DELETE /api/poultry/benchmarks error:", error);
    return apiError(error);
  }
}

function numOrNull(v: any, fallback: number | null = null): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
