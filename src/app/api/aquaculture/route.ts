import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import {
  aquaculturePonds,
  aquacultureBatches,
  aquacultureFeedLogs,
  aquacultureWaterQualityLogs,
  aquacultureHarvests,
  aquacultureChecklists,
  aquacultureWeightLogs,
  aquacultureBenchmarkProfiles,
  transactions,
  businesses,
} from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { stockIn, stockOut } from "@/lib/stock";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { advisorSectionsForBusiness } from "@/lib/auth";
import { canViewSection } from "@/lib/advisorSections";
import { apiError } from "@/lib/apiError";
import { auditLog } from "@/lib/audit";
import { ownerOrgOfBusiness } from "@/lib/notify";
import { nextTrxNumber } from "@/lib/idNumbers";

// Species → canonical sellable product in Inventory (sold by the Kg).
const AQUA_PRODUCTS: Record<string, { sku: string; name: string; unit: string; costPriceGhs: number; sellingPriceGhs: number; minStockThreshold: number }> = {
  // seeded product SKU — harvests top up the existing Fresh Volta Tilapia item
  VOLTA_TILAPIA: { sku: "AQUA-TILAP-800G", name: "Fresh Harvested Volta Tilapia (Average 800g)", unit: "Kg", costPriceGhs: 38, sellingPriceGhs: 62, minStockThreshold: 300 },
  RED_TILAPIA: { sku: "AQUA-RED-TILAPIA-KG", name: "Fresh Red Tilapia (Whole, per Kg)", unit: "Kg", costPriceGhs: 38, sellingPriceGhs: 60, minStockThreshold: 30 },
  HYBRID_TILAPIA: { sku: "AQUA-HYBRID-TILAPIA-KG", name: "Fresh Hybrid Tilapia (Whole, per Kg)", unit: "Kg", costPriceGhs: 38, sellingPriceGhs: 62, minStockThreshold: 30 },
  AFRICAN_CATFISH: { sku: "AQUA-CATFISH-KG", name: "Fresh Catfish (Whole, per Kg)", unit: "Kg", costPriceGhs: 32, sellingPriceGhs: 52, minStockThreshold: 30 },
  CATFISH: { sku: "AQUA-CATFISH-KG", name: "Fresh Catfish (Whole, per Kg)", unit: "Kg", costPriceGhs: 32, sellingPriceGhs: 52, minStockThreshold: 30 },
};
const aquaProductFor = (species: string) =>
  AQUA_PRODUCTS[species] || { sku: `AQUA-${(species || "FISH").toUpperCase()}-KG`, name: `Fresh ${(species || "fish").replace(/_/g, " ").toLowerCase()} (per Kg)`, unit: "Kg", costPriceGhs: 38, sellingPriceGhs: 60, minStockThreshold: 30 };

/** Benchmark profile id → id, only when it belongs to this business. */
async function resolveProfileId(raw: any, businessId: number): Promise<number | null> {
  const id = Number(raw);
  if (!id) return null;
  const [profile] = await db
    .select({ id: aquacultureBenchmarkProfiles.id })
    .from(aquacultureBenchmarkProfiles)
    .where(and(eq(aquacultureBenchmarkProfiles.id, id), eq(aquacultureBenchmarkProfiles.businessId, businessId)));
  return profile ? profile.id : null;
}

export async function GET(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const businessId = Number(searchParams.get("businessId"));
    if (!businessId) {
      return NextResponse.json({ success: false, error: "businessId is required" }, { status: 400 });
    }
    // Scope gate: ponds, batches, feed, water quality and harvest data stay
    // inside the caller's accessible businesses.
    if (!(await canAccessBusiness(__authSession.user, businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }

    const scope = (table: any) =>
      db.select().from(table).where(eq(table.businessId, businessId));

    const [ponds, batches, feedLogs, waterLogs, harvests, checklists, weightLogs, benchmarkProfiles] =
      await Promise.all([
        scope(aquaculturePonds),
        scope(aquacultureBatches),
        scope(aquacultureFeedLogs),
        scope(aquacultureWaterQualityLogs),
        scope(aquacultureHarvests),
        scope(aquacultureChecklists),
        scope(aquacultureWeightLogs),
        scope(aquacultureBenchmarkProfiles),
      ]);

    // ── Farm Advisor section visibility (OWNER-controlled per unit) ───────
    // Denied datasets are stripped server-side — hidden tabs can never be
    // reconstructed from the payload. null sections = all (legacy default).
    const advisorSecs = await advisorSectionsForBusiness(__authSession.user, businessId);
    const view = (key: string) => canViewSection(advisorSecs, key);

    return NextResponse.json({
      success: true,
      ponds: view("PONDS") ? ponds.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)) : [],
      batches: view("STOCK") ? batches.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)) : [],
      feedLogs: view("FEED") ? feedLogs.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)) : [],
      waterLogs: view("WATER") ? waterLogs.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)) : [],
      harvests: view("HARVEST") ? harvests.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)) : [],
      checklists: view("HEALTH") ? checklists.sort((a: any, b: any) => (a.id || 0) - (b.id || 0)) : [],
      weightLogs: view("GROWTH") ? weightLogs.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)) : [],
      benchmarkProfiles: view("BENCHMARK")
        ? benchmarkProfiles.sort(
            (a: any, b: any) => Number(!!b.isDefault) - Number(!!a.isDefault) || (b.id || 0) - (a.id || 0),
          )
        : [],
      // Echo the resolved section list for the read-only UI's tab filter.
      advisorSections: advisorSecs,
    });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { entity, data } = body;
    const businessId = Number(data?.businessId);

    if (!entity || !businessId) {
      return NextResponse.json({ success: false, error: "entity and businessId are required" }, { status: 400 });
    }
    if (!(await canAccessBusiness(__authSession.user, businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    const branchCode = data.branchCode || biz?.code || null;
    const branchName = data.branchName || biz?.name || null;
    const today = new Date().toISOString().split("T")[0];
    const now = new Date();
    const me = __authSession.user;
    const orgId = await ownerOrgOfBusiness(businessId).catch(() => null);

    // Shared ownership check: ponds/batches referenced by id must belong to
    // this business — otherwise a caller could link (or mutate) another
    // tenant's assets through the core aquaculture entities.
    const ownPond = async (pondId: any) => {
      if (pondId === null || pondId === undefined || pondId === "") return { ok: true as const, pond: null };
      const id = Number(pondId);
      if (!id) return { ok: false as const, error: "Invalid pondId" };
      const [pond] = await db.select().from(aquaculturePonds)
        .where(and(eq(aquaculturePonds.id, id), eq(aquaculturePonds.businessId, businessId)));
      return pond ? { ok: true as const, pond } : { ok: false as const, error: "Pond not found for this business." };
    };
    const ownBatch = async (batchId: any) => {
      if (batchId === null || batchId === undefined || batchId === "") return { ok: true as const, batch: null };
      const id = Number(batchId);
      if (!id) return { ok: false as const, error: "Invalid batchId" };
      const [batch] = await db.select().from(aquacultureBatches)
        .where(and(eq(aquacultureBatches.id, id), eq(aquacultureBatches.businessId, businessId)));
      return batch ? { ok: true as const, batch } : { ok: false as const, error: "Batch not found for this business." };
    };

    // ─────────────────────────────────────────────────────────────────
    //  POND / CAGE / TANK
    // ─────────────────────────────────────────────────────────────────
    if (entity === "POND") {
      const capacityLiters = Number(data.capacityLiters) || 0;
      const currentBiomassKg = Number(data.currentBiomassKg) || 0;
      if (capacityLiters < 0) return NextResponse.json({ success: false, error: "capacityLiters cannot be negative" }, { status: 400 });
      if (currentBiomassKg < 0) return NextResponse.json({ success: false, error: "currentBiomassKg cannot be negative" }, { status: 400 });
      const [row] = await db.insert(aquaculturePonds).values({
        businessId, branchCode,
        pondId: data.pondId || `CAGE-${Math.floor(100 + Math.random() * 900)}`,
        name: data.name || "New Pond",
        type: data.type || "CAGE",
        capacityLiters: Number(data.capacityLiters) || 0,
        currentBiomassKg: Number(data.currentBiomassKg) || 0,
        status: data.status || "ACTIVE",
        notes: data.notes || null,
        createdByName: data.createdByName || "Aquaculture User",
      }).returning();
      await auditLog(me, "AQUA_POND_CREATE", "RECORD", `Pond ${row.name} (${row.pondId})`,
        "OPERATION_LOG", row.id, businessId, branchCode,
        `${row.type} · capacity ${(capacityLiters || 0).toLocaleString()} L`,
        orgId ?? null).catch((e: any) => console.error("[aqua] audit failed:", e));
      return NextResponse.json({ success: true, item: row });
    }

    // ─────────────────────────────────────────────────────────────────
    //  BATCH / FINGERLING STOCKING
    // ─────────────────────────────────────────────────────────────────
    if (entity === "BATCH") {
      const initialCount = Number(data.initialCount) || 0;
      if (initialCount <= 0) {
        return NextResponse.json({ success: false, error: "initialCount (fish stocked) must be greater than 0" }, { status: 400 });
      }
      if ((Number(data.currentCount) || initialCount) < 0 || (Number(data.mortalityTotal) || 0) < 0 || (Number(data.avgWeightGrams) || 0) < 0) {
        return NextResponse.json({ success: false, error: "counts and weights cannot be negative" }, { status: 400 });
      }
      const pondCheck = await ownPond(data.pondId);
      if (!pondCheck.ok) return NextResponse.json({ success: false, error: pondCheck.error }, { status: 404 });
      // Optional benchmark profile pin (must belong to this business).
      let benchmarkProfileId: number | null = null;
      if (data.benchmarkProfileId != null && data.benchmarkProfileId !== "") {
        benchmarkProfileId = await resolveProfileId(data.benchmarkProfileId, businessId);
        if (!benchmarkProfileId) {
          return NextResponse.json({ success: false, error: "Benchmark profile not found for this business." }, { status: 404 });
        }
      }
      const costPerFingerlingGhs = Number(data.costPerFingerlingGhs) || 0;
      if (costPerFingerlingGhs < 0) {
        return NextResponse.json({ success: false, error: "costPerFingerlingGhs cannot be negative" }, { status: 400 });
      }
      const [row] = await db.insert(aquacultureBatches).values({
        businessId, branchCode,
        batchNumber: data.batchNumber || `BATCH-${new Date().getFullYear()}-${Date.now().toString().slice(-5)}`,
        pondId: data.pondId ? Number(data.pondId) : null,
        species: data.species || "VOLTA_TILAPIA",
        strainGenetics: data.strainGenetics || null,
        hatchDate: data.hatchDate || today,
        initialCount,
        currentCount: Number(data.currentCount) || initialCount,
        mortalityTotal: Number(data.mortalityTotal) || 0,
        avgWeightGrams: Number(data.avgWeightGrams) || 0,
        targetHarvestDate: data.targetHarvestDate || null,
        status: data.status || "GROWING",
        benchmarkProfileId,
        costPerFingerlingGhs,
        notes: data.notes || null,
        createdByName: data.createdByName || "Aquaculture User",
      }).returning();

      // Update pond biomass (pond already ownership-validated above)
      if (row.pondId && pondCheck.pond) {
        const fishWeightKg = (initialCount * (Number(data.avgWeightGrams) || 0)) / 1000;
        await db.update(aquaculturePonds).set({
          currentBiomassKg: (pondCheck.pond.currentBiomassKg || 0) + fishWeightKg,
        }).where(eq(aquaculturePonds.id, pondCheck.pond.id));
      }

      await auditLog(me, "AQUA_BATCH_STOCKED", "RECORD", `Fish batch ${row.batchNumber} stocked`,
        "OPERATION_LOG", row.id, businessId, branchCode,
        `${initialCount.toLocaleString()} ${row.species} fingerlings stocked${pondCheck.pond ? ` into ${pondCheck.pond.name}` : ""} · avg ${(Number(data.avgWeightGrams) || 0)}g`,
        orgId ?? null).catch((e: any) => console.error("[aqua] audit failed:", e));

      return NextResponse.json({ success: true, item: row });
    }

    // ─────────────────────────────────────────────────────────────────
    //  FEED
    // ─────────────────────────────────────────────────────────────────
    if (entity === "FEED") {
      const qty = Number(data.quantityKg) || 0;
      const costPerKg = Number(data.costPerKgGhs) || 0;
      const totalCost = Number(data.totalCostGhs) || qty * costPerKg;
      if (qty <= 0) {
        return NextResponse.json({ success: false, error: "quantityKg must be greater than 0" }, { status: 400 });
      }
      if (costPerKg < 0 || totalCost < 0) {
        return NextResponse.json({ success: false, error: "feed costs cannot be negative" }, { status: 400 });
      }
      const feedPond = await ownPond(data.pondId);
      if (!feedPond.ok) return NextResponse.json({ success: false, error: feedPond.error }, { status: 404 });
      const feedBatch = await ownBatch(data.batchId);
      if (!feedBatch.ok) return NextResponse.json({ success: false, error: feedBatch.error }, { status: 404 });
      const [row] = await db.insert(aquacultureFeedLogs).values({
        businessId, branchCode,
        batchId: data.batchId ? Number(data.batchId) : null,
        pondId: data.pondId ? Number(data.pondId) : null,
        feedType: data.feedType || "FLOATING",
        brandSupplier: data.brandSupplier || null,
        quantityKg: qty,
        costPerKgGhs: costPerKg,
        totalCostGhs: totalCost,
        entryType: data.entryType || "CONSUMPTION",
        recordedDate: data.recordedDate || today,
        recordedByName: data.recordedByName || "Farm Operator",
      }).returning();

      // Expense for PURCHASE entries
      if ((data.entryType || "CONSUMPTION") === "PURCHASE" && totalCost > 0) {
        const trxNum = nextTrxNumber();
        await db.insert(transactions).values({
          transactionNumber: trxNum,
          businessId, branchCode, branchName: data.branchName || null,
          type: "EXPENSE",
          category: "AQUA_FEED_PURCHASE",
          amountGhs: totalCost,
          paymentMethod: data.paymentMethod || "CASH",
          description: `Fish feed: ${row.feedType} — ${qty}kg | ${row.brandSupplier || "No supplier"}`,
          date: data.recordedDate || today,
          createdAt: now,
          status: "COMPLETED",
          recordedBy: data.recordedByName || "Aquaculture User",
          recordedByRole: data.recordedByRole || null,
          recordedByUserId: data.recordedByUserId ? Number(data.recordedByUserId) : null,
        });
        await auditLog(me, "AQUA_FEED_PURCHASE", "RECORD", `Fish feed purchase ${qty} kg ${row.feedType}`,
          "OPERATION_LOG", row.id, businessId, branchCode,
          `${qty} kg @ GH₵ ${costPerKg.toFixed(2)}/kg = GH₵ ${totalCost.toFixed(2)} · ${row.brandSupplier || "no supplier"} — expense ${trxNum}`,
          orgId ?? null).catch((e: any) => console.error("[aqua] audit failed:", e));
      }

      return NextResponse.json({ success: true, item: row });
    }

    // ─────────────────────────────────────────────────────────────────
    //  WATER QUALITY
    // ─────────────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────
    //  WEIGHT — daily fish sampling/weighing by batch + pond + species.
    //  Batch, pond, species and branch are auto-filled from the selected
    //  batch; saving also refreshes the batch's live avgWeightGrams so the
    //  Stock view and growth analytics stay in sync. Pure measurement —
    //  never creates transactions or inventory movement.
    // ─────────────────────────────────────────────────────────────────
    if (entity === "WEIGHT") {
      const batchId = Number(data.batchId) || 0;
      const avgWeightG = Number(data.avgWeightG);
      const sampleSize = Math.max(1, Number(data.sampleSize) || 1);
      if (!batchId) return NextResponse.json({ success: false, error: "batchId is required" }, { status: 400 });
      if (!(avgWeightG > 0)) return NextResponse.json({ success: false, error: "avgWeightG (grams) must be > 0" }, { status: 400 });
      const [batch] = await db
        .select()
        .from(aquacultureBatches)
        .where(and(eq(aquacultureBatches.id, batchId), eq(aquacultureBatches.businessId, businessId)));
      if (!batch) return NextResponse.json({ success: false, error: "Batch not found for this business." }, { status: 404 });
      const [row] = await db.insert(aquacultureWeightLogs).values({
        businessId,
        branchCode: batch.branchCode || branchCode,
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        pondId: data.pondId ? Number(data.pondId) : batch.pondId || null,
        species: data.species || batch.species,
        sampleSize,
        avgWeightG,
        recordedDate: data.recordedDate || today,
        notes: data.notes || null,
        recordedByName: data.recordedByName || __authSession.user?.name || "Aquaculture User",
      }).returning();
      // Auto-connection: keep the batch's current average weight live.
      await db.update(aquacultureBatches)
        .set({ avgWeightGrams: avgWeightG })
        .where(eq(aquacultureBatches.id, batch.id));
      return NextResponse.json({ success: true, item: row });
    }

    if (entity === "WATER") {
      // pH / dissolved oxygen are REQUIRED real measurements — the previous
      // ||7.0 / ||6.0 fallbacks silently fabricated ideal readings into the
      // water log and poisoned the water-quality analytics.
      const phLevel = Number(data.phLevel);
      const dissolvedOxygenMgL = Number(data.dissolvedOxygenMgL);
      if (!(phLevel >= 0 && phLevel <= 14)) {
        return NextResponse.json({ success: false, error: "phLevel is required (0–14)" }, { status: 400 });
      }
      if (!(dissolvedOxygenMgL >= 0 && dissolvedOxygenMgL <= 30)) {
        return NextResponse.json({ success: false, error: "dissolvedOxygenMgL is required (0–30 mg/L)" }, { status: 400 });
      }
      // pondId stays optional, but is never invented (no phantom "pond 1"
      // writes) and must belong to this business when supplied.
      const waterPond = await ownPond(data.pondId);
      if (!waterPond.ok) return NextResponse.json({ success: false, error: waterPond.error }, { status: 404 });
      const [row] = await db.insert(aquacultureWaterQualityLogs).values({
        businessId, branchCode,
        pondId: waterPond.pond ? waterPond.pond.id : null,
        sampleDate: data.sampleDate || today,
        waterLiters: Number(data.waterLiters) || 0,
        phLevel,
        dissolvedOxygenMgL,
        temperatureC: Number(data.temperatureC) || null,
        ammoniaMgL: Number(data.ammoniaMgL) || 0,
        turbidity: data.turbidity || "CLEAR",
        nitrateMgL: Number(data.nitrateMgL) || 0,
        treatmentUsed: data.treatmentUsed || null,
        publishedByName: data.publishedByName || data.recordedByName || "Water Technician",
      }).returning();
      return NextResponse.json({ success: true, item: row });
    }

    // ─────────────────────────────────────────────────────────────────
    //  HARVEST
    // ─────────────────────────────────────────────────────────────────
    // ── HARVEST: completed production stocks fresh fish into Inventory;
    //    a farm-gate sale recorded with the harvest deducts it again ──
    if (entity === "HARVEST") {
      const harvested = Number(data.harvestedCount) || 0;
      const totalWt = Number(data.totalWeightKg) || 0;
      const revenue = Number(data.revenueGhs) || 0;
      if (harvested <= 0) {
        return NextResponse.json({ success: false, error: "harvestedCount must be greater than 0" }, { status: 400 });
      }
      if (totalWt < 0 || revenue < 0) {
        return NextResponse.json({ success: false, error: "totalWeightKg and revenueGhs cannot be negative" }, { status: 400 });
      }
      // A completed harvest always comes from a specific pond (schema column
      // is NOT NULL) — refuse cleanly instead of inventing "pond 1".
      if (data.pondId === null || data.pondId === undefined || data.pondId === "") {
        return NextResponse.json({ success: false, error: "pondId is required for a harvest" }, { status: 400 });
      }
      const harvestPond = await ownPond(data.pondId);
      if (!harvestPond.ok) return NextResponse.json({ success: false, error: harvestPond.error }, { status: 404 });
      // Batch must belong to this business before we touch its live counts.
      const harvestBatch = await ownBatch(data.batchId);
      if (!harvestBatch.ok) return NextResponse.json({ success: false, error: harvestBatch.error }, { status: 404 });
      const [row] = await db.insert(aquacultureHarvests).values({
        businessId, branchCode,
        batchId: harvestBatch.batch ? harvestBatch.batch.id : null,
        pondId: harvestPond.pond!.id,
        species: data.species || "VOLTA_TILAPIA",
        harvestedCount: harvested,
        totalWeightKg: totalWt,
        avgWeightKg: totalWt > 0 ? Number((totalWt / Math.max(harvested, 1)).toFixed(3)) : 0,
        revenueGhs: revenue,
        saleDate: data.saleDate || today,
        buyerName: data.buyerName || null,
        recordedByName: data.recordedByName || "Farm Operator",
      }).returning();

      // ── Stock linkage: harvest stocks fresh fish (Kg) into Inventory; a
      // farm-gate sale booked with the harvest deducts the sold weight ──
      const product = aquaProductFor(row.species);
      let stockNote = "";
      if (totalWt > 0) {
        await stockIn({ businessId, category: "Fresh Fish", ...product, quantity: totalWt });
        stockNote += ` | +${totalWt}kg to stock`;
      }
      if (revenue > 0 && totalWt > 0) {
        const out = await stockOut({ businessId, sku: product.sku, quantity: totalWt });
        stockNote += ` | −${out.deducted}kg sold from stock`;
      }

      // Auto-create income transaction for fish sales
      if (revenue > 0) {
        const trxNum = nextTrxNumber();
        await db.insert(transactions).values({
          transactionNumber: trxNum,
          businessId, branchCode, branchName: data.branchName || null,
          type: "INCOME",
          category: "AQUA_HARVEST_SALE",
          amountGhs: revenue,
          paymentMethod: data.paymentMethod || "CASH",
          description: `Harvest: ${row.species} — ${harvested} fish, ${totalWt}kg | Buyer: ${data.buyerName || "Unknown"}${stockNote}`,
          date: data.saleDate || today,
          createdAt: now,
          status: "COMPLETED",
          recordedBy: data.recordedByName || "Aquaculture User",
          recordedByRole: data.recordedByRole || null,
          recordedByUserId: data.recordedByUserId ? Number(data.recordedByUserId) : null,
        });
      }

      // Count the harvest against the batch's live fish count. Partial
      // harvests (the norm for tilapia cropping) only subtract — the batch
      // is marked HARVESTED solely when nothing remains. Previously every
      // harvest zeroed the batch, corrupting partial-harvest operations.
      if (harvestBatch.batch) {
        const remaining = Math.max(0, (harvestBatch.batch.currentCount || 0) - harvested);
        await db.update(aquacultureBatches).set({
          status: remaining === 0 ? "HARVESTED" : harvestBatch.batch.status,
          currentCount: remaining,
        }).where(eq(aquacultureBatches.id, harvestBatch.batch.id));
        if (remaining === 0) stockNote += ` | batch ${harvestBatch.batch.batchNumber} fully harvested`;
      }

      await auditLog(me, "AQUA_HARVEST", "RECORD", `Harvest ${harvested.toLocaleString()} ${row.species}`,
        "OPERATION_LOG", row.id, businessId, branchCode,
        `${harvested.toLocaleString()} fish · ${totalWt} kg${revenue > 0 ? ` · sold GH₵ ${revenue.toFixed(2)} to ${data.buyerName || "unknown buyer"}` : ""}${stockNote}`,
        orgId ?? null).catch((e: any) => console.error("[aqua] audit failed:", e));

      return NextResponse.json({ success: true, item: row, stockNote });
    }

    // ─────────────────────────────────────────────────────────────────
    //  CHECKLIST (create today
    // ─────────────────────────────────────────────────────────────────
    if (entity === "CHECKLIST") {
      const tasks = [
        { key: "AERATION_CHECK", label: "Check aerators and oxygen meters", category: "WATER" },
        { key: "DO_PH_TEST", label: "Test DO/pH in all ponds and cages", category: "WATER" },
        { key: "FEED_MORNING", label: "Morning feeding (all ponds and cages)", category: "FEEDING" },
        { key: "MORTALITY_CHECK", label: "Count and log mortalities", category: "HEALTH" },
        { key: "FILTER_CLEAN", label: "Clean water filters", category: "CLEANING" },
        { key: "SECURITY_CHECK", label: "Inspect moorings and biosecurity", category: "SECURITY" },
      ];
      const targetDate = data.checklistDate || today;
      // Idempotent per day: re-generating today's checklist returns the
      // existing rows instead of duplicating them (Block Factory contract).
      const existing = await db
        .select()
        .from(aquacultureChecklists)
        .where(
          and(
            eq(aquacultureChecklists.businessId, businessId),
            eq(aquacultureChecklists.checklistDate, targetDate),
          )
        );
      if (existing.length > 0) {
        return NextResponse.json({ success: true, items: existing.sort((a: any, b: any) => (a.id || 0) - (b.id || 0)), alreadyExists: true });
      }
      const rows = [];
      for (const t of tasks) {
        const [row] = await db.insert(aquacultureChecklists).values({
          businessId, branchCode,
          checklistDate: targetDate,
          taskKey: t.key,
          taskLabel: t.label,
          category: t.category,
          isCompleted: false,
        }).returning();
        rows.push(row);
      }
      return NextResponse.json({ success: true, items: rows });
    }

    return NextResponse.json({ success: false, error: `Unknown entity: ${entity}` }, { status: 400 });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { entity, id, data } = body;

    if (entity === "CHECKLIST" && id) {
      const [existing] = await db.select().from(aquacultureChecklists).where(eq(aquacultureChecklists.id, Number(id)));
      if (!existing) {
        return NextResponse.json({ success: false, error: "Checklist item not found" }, { status: 404 });
      }
      if (!(await canAccessBusiness(__authSession.user, existing.businessId))) {
        return FORBIDDEN("You do not have access to that business.");
      }
      const [row] = await db
        .update(aquacultureChecklists)
        .set({
          isCompleted: !existing.isCompleted,
          completedByName: !existing.isCompleted ? data?.completedByName || "Staff" : null,
          completedByRole: !existing.isCompleted ? data?.completedByRole || null : null,
          completedAt: !existing.isCompleted ? new Date() : null,
        })
        .where(eq(aquacultureChecklists.id, Number(id)))
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    // BATCH — benchmark profile pin/unpin + stocking-cost basis updates
    // (used by the Fish Benchmark panel's "pin profile" action and the batch
    // form's fingerling cost field).
    if (entity === "BATCH" && id) {
      const [existing] = await db.select().from(aquacultureBatches).where(eq(aquacultureBatches.id, Number(id)));
      if (!existing) {
        return NextResponse.json({ success: false, error: "Batch not found" }, { status: 404 });
      }
      if (!(await canAccessBusiness(__authSession.user, existing.businessId))) {
        return FORBIDDEN("You do not have access to that business.");
      }
      let benchmarkProfileId: number | null | undefined = undefined;
      if (data?.benchmarkProfileId !== undefined) {
        benchmarkProfileId = data.benchmarkProfileId === null || data.benchmarkProfileId === ""
          ? null
          : await resolveProfileId(data.benchmarkProfileId, existing.businessId);
        if (data.benchmarkProfileId != null && data.benchmarkProfileId !== "" && !benchmarkProfileId) {
          return NextResponse.json({ success: false, error: "Benchmark profile not found for this business." }, { status: 404 });
        }
      }
      let costPerFingerlingGhs: number | undefined = undefined;
      if (data?.costPerFingerlingGhs !== undefined) {
        const n = Number(data.costPerFingerlingGhs);
        if (!Number.isFinite(n) || n < 0) {
          return NextResponse.json({ success: false, error: "costPerFingerlingGhs must be 0 or more" }, { status: 400 });
        }
        costPerFingerlingGhs = n;
      }
      if (benchmarkProfileId === undefined && costPerFingerlingGhs === undefined) {
        return NextResponse.json({ success: false, error: "Nothing to update (benchmarkProfileId or costPerFingerlingGhs)" }, { status: 400 });
      }
      const [row] = await db
        .update(aquacultureBatches)
        .set({
          ...(benchmarkProfileId !== undefined ? { benchmarkProfileId } : {}),
          ...(costPerFingerlingGhs !== undefined ? { costPerFingerlingGhs } : {}),
        })
        .where(eq(aquacultureBatches.id, Number(id)))
        .returning();
      await auditLog(__authSession.user, "AQUA_BATCH_UPDATE", "RECORD", `Fish batch ${row.batchNumber} updated`,
        "OPERATION_LOG", row.id, existing.businessId, existing.branchCode || null,
        [
          benchmarkProfileId === null ? "benchmark profile unpinned" : benchmarkProfileId ? `benchmark profile pinned (#${benchmarkProfileId})` : null,
          costPerFingerlingGhs !== undefined ? `fingerling cost GH₵${costPerFingerlingGhs}` : null,
        ].filter(Boolean).join(" · "),
        (await ownerOrgOfBusiness(existing.businessId).catch(() => null)) ?? null,
      ).catch((e: any) => console.error("[aqua] audit failed:", e));
      return NextResponse.json({ success: true, item: row });
    }

    return NextResponse.json({ success: false, error: "Unsupported patch operation" }, { status: 400 });
  } catch (error: any) {
    return apiError(error);
  }
}
