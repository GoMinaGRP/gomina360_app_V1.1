import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import {
  aquacultureBenchmarkProfiles,
  aquacultureBatches,
  aquacultureFeedLogs,
  aquacultureHarvests,
  aquacultureWeightLogs,
  aquaculturePonds,
} from "@/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { apiError } from "@/lib/apiError";
import { auditLog } from "@/lib/audit";
import { ownerOrgOfBusiness } from "@/lib/notify";
import {
  FISH_BENCHMARK_TEMPLATES,
  deriveFishCurvesFromBatch,
  validateFishCurves,
  type FishBenchmarkCurves,
} from "@/lib/fishBenchmarking";

/**
 * FISH BATCH PERFORMANCE BENCHMARKING — sub-module of the Aquaculture Farm
 * (the aquatic mirror of /api/poultry/benchmarks).
 *
 * GET    /api/aquaculture/benchmarks?businessId=3
 *        → profiles (with batch usage) + the built-in copyable templates.
 * POST   { entity: "PROFILE", data: { businessId, name, species, strain?,
 *          source?, isDefault?, toleranceWarnPct?, toleranceCritPct?,
 *          curves?, notes?, deriveFromBatchId?, createdByName?, createdByRole? } }
 *        Create a profile. `deriveFromBatchId` builds the curves from a real
 *        (usually finished) batch's logged performance (FARM_HISTORY source).
 * PATCH  { entity: "PROFILE", id, data: {…} }
 *        Update header/curves; setting isDefault clears other defaults of the
 *        same species. ARCHIVED profiles never auto-match.
 * DELETE { body { entity: "PROFILE", id } }
 *        Blocked while any batch still references the profile.
 *
 * Mutations require OWNER / GENERAL_MANAGER / canManageRecords — the same
 * gate the Feed Mill uses. Curves are validated server-side
 * (fishBenchmarking.validateFishCurves) before any write.
 */

const mayManage = (me: any) =>
  me.role === "OWNER" || me.role === "GENERAL_MANAGER" || me.canManageRecords === true;

/** Known species (batch creation accepts others, but profiles keep this
 *  whitelist so a typo can't silently split the profile auto-matching). */
const SPECIES = ["VOLTA_TILAPIA", "RED_TILAPIA", "NILE_TILAPIA", "AFRICAN_CATFISH", "HETEROTIS", "CARP"];

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
      .from(aquacultureBenchmarkProfiles)
      .where(eq(aquacultureBenchmarkProfiles.businessId, bizId))
      .orderBy(desc(aquacultureBenchmarkProfiles.isDefault), desc(aquacultureBenchmarkProfiles.id));

    const batches = await db
      .select({
        id: aquacultureBatches.id,
        batchNumber: aquacultureBatches.batchNumber,
        benchmarkProfileId: aquacultureBatches.benchmarkProfileId,
      })
      .from(aquacultureBatches)
      .where(eq(aquacultureBatches.businessId, bizId));

    const usage = new Map<number, string[]>();
    for (const b of batches) {
      if (b.benchmarkProfileId != null) {
        usage.set(Number(b.benchmarkProfileId), [...(usage.get(Number(b.benchmarkProfileId)) || []), b.batchNumber]);
      }
    }

    return NextResponse.json({
      success: true,
      profiles: profiles.map((p: any) => ({ ...p, usedByBatches: usage.get(p.id) || [] })),
      templates: FISH_BENCHMARK_TEMPLATES,
    });
  } catch (error: any) {
    console.error("GET /api/aquaculture/benchmarks error:", error);
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

    // Derive-from-batch FIRST (it fills name/species/curves when omitted).
    let curvesRaw = data.curves;
    let source = String(data.source || "MANUAL").toUpperCase();
    if (data.deriveFromBatchId) {
      const [batch] = await db
        .select()
        .from(aquacultureBatches)
        .where(and(eq(aquacultureBatches.id, Number(data.deriveFromBatchId)), eq(aquacultureBatches.businessId, businessId)));
      if (!batch) {
        return NextResponse.json({ success: false, error: "Batch to derive from was not found for this business." }, { status: 404 });
      }
      const [feedLogs, harvests, weightLogs, ponds] = await Promise.all([
        db.select().from(aquacultureFeedLogs).where(eq(aquacultureFeedLogs.businessId, businessId)),
        db.select().from(aquacultureHarvests).where(eq(aquacultureHarvests.businessId, businessId)),
        db.select().from(aquacultureWeightLogs).where(eq(aquacultureWeightLogs.businessId, businessId)),
        db.select().from(aquaculturePonds).where(eq(aquaculturePonds.businessId, businessId)),
      ]);
      const derived = deriveFishCurvesFromBatch(batch, { batches: [batch], feedLogs, harvests, weightLogs, ponds });
      if (!Object.keys(derived).some((k) => k !== "_meta")) {
        return NextResponse.json(
          { success: false, error: "That batch has too little data to derive curves from (needs weight and feed logs)." },
          { status: 400 },
        );
      }
      // explicit curves win over derived ones when both are supplied
      curvesRaw = { ...derived, ...(curvesRaw || {}) };
      source = "FARM_HISTORY";
      if (!data.name) data.name = `${batch.batchNumber} performance`;
      if (!data.species) data.species = batch.species;
    }

    const species = String(data.species || "").toUpperCase();
    if (!SPECIES.includes(species)) {
      return NextResponse.json({ success: false, error: `species must be one of ${SPECIES.join(", ")}` }, { status: 400 });
    }

    const name = String(data.name || "").trim();
    if (!name) {
      return NextResponse.json({ success: false, error: "name is required" }, { status: 400 });
    }

    const { curves, error: curveError } = validateFishCurves(curvesRaw);
    if (curveError) {
      return NextResponse.json({ success: false, error: `Invalid curves: ${curveError}` }, { status: 400 });
    }

    const isDefault = data.isDefault === true;
    if (isDefault) {
      await db
        .update(aquacultureBenchmarkProfiles)
        .set({ isDefault: false })
        .where(and(eq(aquacultureBenchmarkProfiles.businessId, businessId), eq(aquacultureBenchmarkProfiles.species, species)));
    }

    const [row] = await db
      .insert(aquacultureBenchmarkProfiles)
      .values({
        businessId,
        branchCode: data.branchCode || null,
        ownerId: (await ownerOrgOfBusiness(businessId).catch(() => null)) ?? null,
        name,
        species,
        strain: data.strain || null,
        source: ["MANUAL", "TEMPLATE", "FARM_HISTORY"].includes(source) ? source : "MANUAL",
        status: "ACTIVE",
        isDefault,
        toleranceWarnPct: numOrNull(data.toleranceWarnPct, 5) ?? 5,
        toleranceCritPct: numOrNull(data.toleranceCritPct, 10) ?? 10,
        curves: curves as FishBenchmarkCurves,
        notes: data.notes || null,
        createdByName: data.createdByName || session.user?.name || "Farm Staff",
        createdByRole: data.createdByRole || session.user?.role || null,
        createdByUserId: session.user?.id ?? null,
        updatedAt: new Date(),
      })
      .returning();

    await auditLog(
      session.user, "AQUA_BENCHMARK_CREATE", "RECORD",
      `Fish benchmark profile "${row.name}" created (${row.species}${row.strain ? ` · ${row.strain}` : ""})`,
      "OPERATION_LOG", row.id, businessId, data.branchCode || null,
      `${Object.keys(curves).filter((k) => k !== "_meta").length} curve(s)${isDefault ? " · set as default" : ""}`,
      (await ownerOrgOfBusiness(businessId).catch(() => null)) ?? null,
    ).catch((e: any) => console.error("[aqua-benchmarks] audit failed:", e));

    return NextResponse.json({ success: true, item: row });
  } catch (error: any) {
    console.error("POST /api/aquaculture/benchmarks error:", error);
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
      .from(aquacultureBenchmarkProfiles)
      .where(eq(aquacultureBenchmarkProfiles.id, Number(id)));
    if (!existing) {
      return NextResponse.json({ success: false, error: "Benchmark profile not found" }, { status: 404 });
    }
    if (!(await canAccessBusiness(session.user, existing.businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }
    if (!mayManage(session.user)) {
      return FORBIDDEN("Only the OWNER, a General Manager or a records-authorized manager can manage benchmark profiles.");
    }

    let curves = existing.curves as FishBenchmarkCurves;
    if (data?.curves !== undefined) {
      const { curves: validated, error: curveError } = validateFishCurves(data.curves);
      if (curveError) {
        return NextResponse.json({ success: false, error: `Invalid curves: ${curveError}` }, { status: 400 });
      }
      curves = validated;
    }

    let species = existing.species;
    if (data?.species) {
      const s = String(data.species).toUpperCase();
      if (!SPECIES.includes(s)) {
        return NextResponse.json({ success: false, error: `species must be one of ${SPECIES.join(", ")}` }, { status: 400 });
      }
      species = s;
    }

    const isDefault = data?.isDefault === undefined ? existing.isDefault : data.isDefault === true;
    if (isDefault && !existing.isDefault) {
      await db
        .update(aquacultureBenchmarkProfiles)
        .set({ isDefault: false })
        .where(
          and(
            eq(aquacultureBenchmarkProfiles.businessId, existing.businessId),
            eq(aquacultureBenchmarkProfiles.species, species),
          ),
        );
    }

    const [row] = await db
      .update(aquacultureBenchmarkProfiles)
      .set({
        name: data?.name !== undefined ? String(data.name).trim() || existing.name : existing.name,
        species,
        strain: data?.strain !== undefined ? data.strain || null : existing.strain,
        status: data?.status !== undefined ? (data.status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE") : existing.status,
        isDefault,
        toleranceWarnPct: data?.toleranceWarnPct !== undefined ? numOrNull(data.toleranceWarnPct, existing.toleranceWarnPct) ?? 5 : existing.toleranceWarnPct,
        toleranceCritPct: data?.toleranceCritPct !== undefined ? numOrNull(data.toleranceCritPct, existing.toleranceCritPct) ?? 10 : existing.toleranceCritPct,
        curves,
        notes: data?.notes !== undefined ? data.notes || null : existing.notes,
        updatedAt: new Date(),
      })
      .where(eq(aquacultureBenchmarkProfiles.id, Number(id)))
      .returning();

    await auditLog(
      session.user, "AQUA_BENCHMARK_UPDATE", "RECORD",
      `Fish benchmark profile "${row.name}" updated`,
      "OPERATION_LOG", row.id, existing.businessId, existing.branchCode || null,
      [
        data?.curves !== undefined ? `curves → ${Object.keys(curves).filter((k) => k !== "_meta").length} metric(s)` : null,
        isDefault && !existing.isDefault ? "set as default" : null,
        data?.status ? `status → ${data.status}` : null,
      ].filter(Boolean).join(" · ") || "profile details updated",
      (await ownerOrgOfBusiness(existing.businessId).catch(() => null)) ?? null,
    ).catch((e: any) => console.error("[aqua-benchmarks] audit failed:", e));

    return NextResponse.json({ success: true, item: row });
  } catch (error: any) {
    console.error("PATCH /api/aquaculture/benchmarks error:", error);
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
      .from(aquacultureBenchmarkProfiles)
      .where(eq(aquacultureBenchmarkProfiles.id, Number(id)));
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
      .select({ batchNumber: aquacultureBatches.batchNumber })
      .from(aquacultureBatches)
      .where(and(eq(aquacultureBatches.businessId, existing.businessId), eq(aquacultureBatches.benchmarkProfileId, Number(id))));
    if (users.length) {
      return NextResponse.json(
        {
          success: false,
          error: `Profile is still assigned to ${users.length} batch(es): ${users.map((u) => u.batchNumber).join(", ")}. Reassign or clear those batches first (or archive the profile instead).`,
        },
        { status: 409 },
      );
    }

    await db.delete(aquacultureBenchmarkProfiles).where(eq(aquacultureBenchmarkProfiles.id, Number(id)));
    await auditLog(
      session.user, "AQUA_BENCHMARK_DELETE", "RECORD",
      `Fish benchmark profile "${existing.name}" deleted`,
      "OPERATION_LOG", existing.id, existing.businessId, existing.branchCode || null,
      null,
      (await ownerOrgOfBusiness(existing.businessId).catch(() => null)) ?? null,
    ).catch((e: any) => console.error("[aqua-benchmarks] audit failed:", e));

    return NextResponse.json({ success: true, removed: { id: existing.id, name: existing.name } });
  } catch (error: any) {
    console.error("DELETE /api/aquaculture/benchmarks error:", error);
    return apiError(error);
  }
}

function numOrNull(v: any, fallback: number | null = null): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
