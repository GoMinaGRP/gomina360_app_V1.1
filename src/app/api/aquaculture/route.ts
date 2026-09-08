import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  aquaculturePonds,
  aquacultureBatches,
  aquacultureFeedLogs,
  aquacultureWaterQualityLogs,
  aquacultureHarvests,
  aquacultureChecklists,
  aquacultureWeightLogs,
  transactions,
  businesses,
} from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { stockIn, stockOut } from "@/lib/stock";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

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

export async function GET(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const businessId = Number(searchParams.get("businessId"));
    if (!businessId) {
      return NextResponse.json({ success: false, error: "businessId is required" }, { status: 400 });
    }

    const scope = (table: any) =>
      db.select().from(table).where(eq(table.businessId, businessId));

    const [ponds, batches, feedLogs, waterLogs, harvests, checklists, weightLogs] =
      await Promise.all([
        scope(aquaculturePonds),
        scope(aquacultureBatches),
        scope(aquacultureFeedLogs),
        scope(aquacultureWaterQualityLogs),
        scope(aquacultureHarvests),
        scope(aquacultureChecklists),
        scope(aquacultureWeightLogs),
      ]);

    return NextResponse.json({
      success: true,
      ponds: ponds.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)),
      batches: batches.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)),
      feedLogs: feedLogs.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)),
      waterLogs: waterLogs.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)),
      harvests: harvests.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)),
      checklists: checklists.sort((a: any, b: any) => (a.id || 0) - (b.id || 0)),
      weightLogs: weightLogs.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
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

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    const branchCode = data.branchCode || biz?.code || null;
    const branchName = data.branchName || biz?.name || null;
    const today = new Date().toISOString().split("T")[0];
    const now = new Date();

    // ─────────────────────────────────────────────────────────────────
    //  POND / CAGE / TANK
    // ─────────────────────────────────────────────────────────────────
    if (entity === "POND") {
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
      return NextResponse.json({ success: true, item: row });
    }

    // ─────────────────────────────────────────────────────────────────
    //  BATCH / FINGERLING STOCKING
    // ─────────────────────────────────────────────────────────────────
    if (entity === "BATCH") {
      const initialCount = Number(data.initialCount) || 0;
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
        notes: data.notes || null,
        createdByName: data.createdByName || "Aquaculture User",
      }).returning();

      // Update pond biomass
      if (row.pondId) {
        const [pond] = await db.select().from(aquaculturePonds).where(eq(aquaculturePonds.id, row.pondId));
        if (pond) {
          const fishWeightKg = (initialCount * (Number(data.avgWeightGrams) || 0)) / 1000;
          await db.update(aquaculturePonds).set({
            currentBiomassKg: (pond.currentBiomassKg || 0) + fishWeightKg,
          }).where(eq(aquaculturePonds.id, pond.id));
        }
      }

      return NextResponse.json({ success: true, item: row });
    }

    // ─────────────────────────────────────────────────────────────────
    //  FEED
    // ─────────────────────────────────────────────────────────────────
    if (entity === "FEED") {
      const qty = Number(data.quantityKg) || 0;
      const costPerKg = Number(data.costPerKgGhs) || 0;
      const totalCost = Number(data.totalCostGhs) || qty * costPerKg;
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
        const trxNum = `TRX-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
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
      const [row] = await db.insert(aquacultureWaterQualityLogs).values({
        businessId, branchCode,
        pondId: Number(data.pondId) || 1,
        sampleDate: data.sampleDate || today,
        waterLiters: Number(data.waterLiters) || 0,
        phLevel: Number(data.phLevel) || 7.0,
        dissolvedOxygenMgL: Number(data.dissolvedOxygenMgL) || 6.0,
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
      const [row] = await db.insert(aquacultureHarvests).values({
        businessId, branchCode,
        batchId: data.batchId ? Number(data.batchId) : null,
        pondId: Number(data.pondId) || 1,
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
        const trxNum = `TRX-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
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

      // Mark batch as harvested
      if (data.batchId) {
        await db.update(aquacultureBatches).set({
          status: "HARVESTED",
          currentCount: 0,
        }).where(eq(aquacultureBatches.id, Number(data.batchId)));
      }

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
      const rows = [];
      for (const t of tasks) {
        const [row] = await db.insert(aquacultureChecklists).values({
          businessId, branchCode,
          checklistDate: data.checklistDate || today,
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
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
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

    return NextResponse.json({ success: false, error: "Unsupported patch operation" }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
