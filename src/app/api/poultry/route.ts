import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  poultryFlocks,
  poultryFeedLogs,
  poultryWaterLogs,
  poultryHealthRecords,
  poultryProduction,
  poultryChecklists,
  poultryProducts,
  poultryWeightLogs,
  businesses,
  transactions,
} from "@/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { stockIn, stockOut, ensureInventoryItem } from "@/lib/stock";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";

// Canonical sellable products for the poultry branch — production stocks these
// in, sales deduct them, and they appear in every stock picker automatically.
export const POULTRY_PRODUCTS = {
  EGGS: {
    // matches the seeded product SKU so production tops up the existing item
    sku: "POUL-EGG-L01",
    name: "Grade A Large Egg Trays (30 Eggs/Tray)",
    category: "Poultry Products",
    unit: "Trays",
    costPriceGhs: 38,
    sellingPriceGhs: 55,
    minStockThreshold: 150,
  },
  BROILER: {
    sku: "PGH-BROILER-DRESSED",
    name: "Dressed Broiler Chicken (Whole)",
    category: "Poultry Meat",
    unit: "Birds",
    costPriceGhs: 65,
    sellingPriceGhs: 90,
    minStockThreshold: 10,
  },
} as const;

// System seeds for the Master Product List (same SKUs as POULTRY_PRODUCTS so
// everything keeps pointing at the same canonical stock rows).
const SYSTEM_PRODUCT_SEEDS = [
  { productKey: "EGGS", ...POULTRY_PRODUCTS.EGGS },
  { productKey: "BROILER_WEIGHT", ...POULTRY_PRODUCTS.BROILER },
];

/** "Duck Egg Crates" → "DUCK_EGG_CRATES" (stable master-product key fragment) */
function slugify(name: string): string {
  return (
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "PRODUCT"
  );
}

/**
 * GET /api/poultry?businessId=1
 * Returns every dataset for the Poultry Farm Management module,
 * scoped to the selected Business → Branch.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const businessIdParam = searchParams.get("businessId");
    const bizId = businessIdParam ? Number(businessIdParam) : null;

    const scope = <T extends { businessId: any }>(table: any) =>
      bizId
        ? db.select().from(table).where(eq(table.businessId, bizId))
        : db.select().from(table);

    const [flocks, feedLogs, waterLogs, healthRecords, production, checklists, weightLogs] =
      await Promise.all([
        scope(poultryFlocks),
        scope(poultryFeedLogs),
        scope(poultryWaterLogs),
        scope(poultryHealthRecords),
        scope(poultryProduction),
        scope(poultryChecklists),
        scope(poultryWeightLogs),
      ]);

    // Master Product List — self-seed the two system products the first time a
    // poultry unit is opened (their SKUs match the seeded inventory items, so
    // production keeps topping up the original stock rows).
    let products: any[] = [];
    if (bizId) {
      products = await db
        .select()
        .from(poultryProducts)
        .where(eq(poultryProducts.businessId, bizId));
      if (products.length === 0) {
        const [biz] = await db
          .select()
          .from(businesses)
          .where(eq(businesses.id, bizId));
        const code = biz?.code || "POULTRY";
        for (const sys of SYSTEM_PRODUCT_SEEDS) {
          await db.insert(poultryProducts).values({
            businessId: bizId,
            branchCode: code,
            productKey: sys.productKey,
            name: sys.name,
            category: sys.category,
            unit: sys.unit,
            sku: sys.sku,
            costPriceGhs: sys.costPriceGhs,
            sellingPriceGhs: sys.sellingPriceGhs,
            minStockThreshold: sys.minStockThreshold,
            isSystem: true,
            isActive: true,
          });
        }
        products = await db
          .select()
          .from(poultryProducts)
          .where(eq(poultryProducts.businessId, bizId));
      }
    } else {
      products = await db.select().from(poultryProducts);
    }

    const sortByIdDesc = (a: any, b: any) => (b.id || 0) - (a.id || 0);

    return NextResponse.json({
      success: true,
      flocks: flocks.sort(sortByIdDesc),
      feedLogs: feedLogs.sort(sortByIdDesc),
      waterLogs: waterLogs.sort(sortByIdDesc),
      healthRecords: healthRecords.sort(sortByIdDesc),
      production: production.sort(sortByIdDesc),
      weightLogs: weightLogs.sort(sortByIdDesc),
      checklists: checklists.sort((a: any, b: any) => (a.id || 0) - (b.id || 0)),
      products: products.sort((a: any, b: any) => (a.id || 0) - (b.id || 0)),
    });
  } catch (error: any) {
    console.error("GET /api/poultry error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

/**
 * POST /api/poultry
 * Body: { entity: 'FLOCK'|'FEED'|'WATER'|'WEIGHT'|'HEALTH'|'PRODUCTION'|'PRODUCT'|'CHECKLIST', data: {...} }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { entity, data } = body;

    if (!entity || !data) {
      return NextResponse.json(
        { success: false, error: "entity and data are required" },
        { status: 400 }
      );
    }

    const businessId = Number(data.businessId);
    if (!businessId) {
      return NextResponse.json(
        { success: false, error: "businessId is required" },
        { status: 400 }
      );
    }

    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    if (!(await canAccessBusiness(session.user, businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }

    // Resolve branch details from the business record
    const [biz] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, businessId));
    const branchCode = data.branchCode || biz?.code || null;
    const branchName = data.branchName || biz?.name || null;
    const today = new Date().toISOString().split("T")[0];

    // ── FLOCK ──────────────────────────────────────────────────────
    if (entity === "FLOCK") {
      const initialCount = Number(data.initialCount) || 0;
      const [row] = await db
        .insert(poultryFlocks)
        .values({
          businessId,
          branchCode,
          branchName,
          batchNumber:
            data.batchNumber ||
            `BATCH-${new Date().getFullYear()}-${Date.now().toString().slice(-5)}`,
          flockName: data.flockName || null,
          birdType: data.birdType || "LAYERS",
          breed: data.breed || null,
          genetics: data.genetics || null,
          supplier: data.supplier || null,
          houseName: data.houseName || null,
          initialCount,
          currentCount: Number(data.currentCount) || initialCount,
          mortalityTotal: Number(data.mortalityTotal) || 0,
          arrivalDate: data.arrivalDate || today,
          ageWeeks: Number(data.ageWeeks) || 0,
          sourceHatchery: data.sourceHatchery || null,
          costPerBirdGhs: Number(data.costPerBirdGhs) || 0,
          status: data.status || "ACTIVE",
          notes: data.notes || null,
          createdByName: data.createdByName || "Farm Staff",
          createdByRole: data.createdByRole || null,
        })
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    // ── FEED ───────────────────────────────────────────────────────
    if (entity === "FEED") {
      const qty = Number(data.quantityKg) || 0;
      const costPerKg = Number(data.costPerKgGhs) || 0;
      const totalCost = Number(data.totalCostGhs) || qty * costPerKg;
      const [row] = await db
        .insert(poultryFeedLogs)
        .values({
          businessId,
          branchCode,
          flockId: data.flockId ? Number(data.flockId) : null,
          batchNumber: data.batchNumber || null,
          feedType: data.feedType || "LAYER_MASH",
          brandSupplier: data.brandSupplier || null,
          quantityKg: qty,
          costPerKgGhs: costPerKg,
          totalCostGhs: totalCost,
          entryType: data.entryType || "CONSUMPTION",
          recordedDate: data.recordedDate || today,
          recordedByName: data.recordedByName || "Farm Staff",
          recordedByRole: data.recordedByRole || null,
        })
        .returning();

      // Auto-create expense transaction for feed PURCHASE
      if ((data.entryType || "CONSUMPTION") === "PURCHASE" && totalCost > 0) {
        const trxNum = `TRX-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
        await db.insert(transactions).values({
          transactionNumber: trxNum,
          businessId,
          branchCode,
          branchName: data.branchName || null,
          type: "EXPENSE",
          category: "POULTRY_FEED_PURCHASE",
          amountGhs: totalCost,
          paymentMethod: data.paymentMethod || "CASH",
          description: `Feed: ${row.feedType.replace(/_/g, " ")} — ${qty}kg | ${row.brandSupplier || "No supplier"}`,
          date: today,
          createdAt: new Date(),
          status: "COMPLETED",
          recordedBy: data.recordedByName || "Poultry Farm User",
          recordedByRole: data.recordedByRole || null,
          recordedByUserId: data.recordedByUserId ? Number(data.recordedByUserId) : null,
        });
      }

      return NextResponse.json({ success: true, item: row });
    }

    // ── WATER ──────────────────────────────────────────────────────
    if (entity === "WATER") {
      const [row] = await db
        .insert(poultryWaterLogs)
        .values({
          businessId,
          branchCode,
          flockId: data.flockId ? Number(data.flockId) : null,
          batchNumber: data.batchNumber || null,
          volumeLiters: Number(data.volumeLiters) || 0,
          sourceType: data.sourceType || "BOREHOLE",
          phLevel: data.phLevel ? Number(data.phLevel) : null,
          isTreated: Boolean(data.isTreated),
          treatmentUsed: data.treatmentUsed || null,
          recordedDate: data.recordedDate || today,
          recordedByName: data.recordedByName || "Farm Staff",
        })
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    // ── WEIGHT (daily bird/egg weighing) ──────────────────────────
    // One weighing event: a sample of birds (BIRD, broilers or layers) or
    // eggs (EGG, layer flocks only) from ONE flock. Batch + branch are
    // auto-filled from the flock so the growth analytics can join the row to
    // feed, mortality and production by (batch, date). Pure measurement —
    // never creates transactions or inventory movement.
    if (entity === "WEIGHT") {
      const flockId = Number(data.flockId) || 0;
      const weightKind = String(data.weightKind || "BIRD").toUpperCase();
      const avgWeightG = Number(data.avgWeightG);
      const sampleSize = Math.max(1, Number(data.sampleSize) || 1);
      if (!flockId) return NextResponse.json({ success: false, error: "flockId is required" }, { status: 400 });
      if (!["BIRD", "EGG"].includes(weightKind)) return NextResponse.json({ success: false, error: "weightKind must be BIRD or EGG" }, { status: 400 });
      if (!(avgWeightG > 0)) return NextResponse.json({ success: false, error: "avgWeightG (grams) must be > 0" }, { status: 400 });
      const [flock] = await db
        .select()
        .from(poultryFlocks)
        .where(and(eq(poultryFlocks.id, flockId), eq(poultryFlocks.businessId, businessId)));
      if (!flock) return NextResponse.json({ success: false, error: "Flock not found for this business." }, { status: 404 });
      if (weightKind === "EGG" && flock.birdType !== "LAYERS") {
        return NextResponse.json({ success: false, error: "Egg weight can only be recorded for a LAYERS flock." }, { status: 400 });
      }
      const [row] = await db
        .insert(poultryWeightLogs)
        .values({
          businessId,
          branchCode: flock.branchCode || branchCode,
          flockId: flock.id,
          batchNumber: flock.batchNumber,
          weightKind,
          sampleSize,
          avgWeightG,
          recordedDate: data.recordedDate || today,
          notes: data.notes || null,
          recordedByName: data.recordedByName || session.user?.name || "Farm Staff",
          recordedByRole: data.recordedByRole || session.user?.role || "WORKER",
        })
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    // ── HEALTH ─────────────────────────────────────────────────────
    if (entity === "HEALTH") {
      const healthCost = Number(data.costGhs) || 0;
      const [row] = await db
        .insert(poultryHealthRecords)
        .values({
          businessId,
          branchCode,
          flockId: data.flockId ? Number(data.flockId) : null,
          batchNumber: data.batchNumber || null,
          recordType: data.recordType || "INSPECTION",
          vaccineOrDrug: data.vaccineOrDrug || null,
          diseaseOrCondition: data.diseaseOrCondition || null,
          dosage: data.dosage || null,
          administeredBy: data.administeredBy || null,
          birdsAffected: Number(data.birdsAffected) || 0,
          mortalityCount: Number(data.mortalityCount) || 0,
          costGhs: healthCost,
          nextDueDate: data.nextDueDate || null,
          outcome: data.outcome || "MONITORING",
          notes: data.notes || null,
          recordedDate: data.recordedDate || today,
          recordedByName: data.recordedByName || "Farm Staff",
        })
        .returning();

      // Auto-create expense transaction for health costs
      if (healthCost > 0) {
        const trxNum = `TRX-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
        await db.insert(transactions).values({
          transactionNumber: trxNum,
          businessId,
          branchCode,
          branchName: data.branchName || null,
          type: "EXPENSE",
          category: row.recordType === "VACCINATION" ? "POULTRY_VACCINATION" : "POULTRY_HEALTH",
          amountGhs: healthCost,
          paymentMethod: data.paymentMethod || "CASH",
          description: `Health: ${row.recordType} — ${row.vaccineOrDrug || row.diseaseOrCondition || "Routine"}${row.administeredBy ? ` | Admin: ${row.administeredBy}` : ""}`,
          date: today,
          createdAt: new Date(),
          status: "COMPLETED",
          recordedBy: data.recordedByName || "Poultry Farm User",
          recordedByRole: data.recordedByRole || null,
          recordedByUserId: data.recordedByUserId ? Number(data.recordedByUserId) : null,
        });
      }

      // Mortalities reduce the flock's live bird count
      const mortality = Number(data.mortalityCount) || 0;
      if (mortality > 0 && data.flockId) {
        const [flock] = await db
          .select()
          .from(poultryFlocks)
          .where(eq(poultryFlocks.id, Number(data.flockId)));
        if (flock) {
          await db
            .update(poultryFlocks)
            .set({
              currentCount: Math.max(0, flock.currentCount - mortality),
              mortalityTotal: (flock.mortalityTotal || 0) + mortality,
            })
            .where(eq(poultryFlocks.id, flock.id));
        }
      }

      return NextResponse.json({ success: true, item: row });
    }

    // ── MASTER PRODUCT (add a new production type / sellable product) ──
    // Saved to the Poultry Farm Master Product List and immediately linked
    // into Inventory (SKU row at zero stock), so every future production
    // record, stock view, sale picker and report knows the product.
    if (entity === "PRODUCT") {
      const name = String(data.name || "").trim();
      if (!name) {
        return NextResponse.json(
          { success: false, error: "Product name is required." },
          { status: 400 }
        );
      }
      const unit = String(data.unit || "Units").trim() || "Units";
      const category = String(data.category || "Poultry Products").trim() || "Poultry Products";
      const costPriceGhs = Number(data.costPriceGhs) || 0;
      const sellingPriceGhs = Number(data.sellingPriceGhs) || 0;
      const minStockThreshold = Number(data.minStockThreshold) || 0;

      const slug = slugify(name);
      const productKey = `CUSTOM_${slug}`;
      const sku = `${branchCode}-${slug.replace(/_/g, "-")}`;

      const existing = await db
        .select()
        .from(poultryProducts)
        .where(eq(poultryProducts.businessId, businessId));
      if (
        existing.some(
          (p) =>
            p.productKey === productKey ||
            p.name.trim().toLowerCase() === name.toLowerCase()
        )
      ) {
        return NextResponse.json(
          { success: false, error: `"${name}" already exists in the Master Product List.` },
          { status: 409 }
        );
      }

      let row;
      try {
        [row] = await db
          .insert(poultryProducts)
          .values({
            businessId,
            branchCode,
            productKey,
            name,
            category,
            unit,
            sku,
            costPriceGhs,
            sellingPriceGhs,
            minStockThreshold,
            isSystem: false,
            isActive: true,
          })
          .returning();
      } catch (e: any) {
        if (String(e?.message || "").includes("poultry_products_business_key_unique")) {
          return NextResponse.json(
            { success: false, error: `"${name}" already exists in the Master Product List.` },
            { status: 409 }
          );
        }
        throw e;
      }

      // Link into Inventory immediately (zero stock until first production
      // record is logged) so the product is visible in stock views & reports.
      await ensureInventoryItem({
        businessId,
        sku,
        name,
        category,
        unit,
        costPriceGhs,
        sellingPriceGhs,
        minStockThreshold,
      });

      return NextResponse.json({ success: true, item: row });
    }

    // ── PRODUCTION ─────────────────────────────────────────────────
    if (entity === "PRODUCTION") {
      const eggs = Number(data.eggsCollected) || 0;
      const soldEggs = Number(data.eggsSold) || 0;
      const revenue = Number(data.revenueGhs) || 0;
      const broilersSold = Number(data.broilersSold) || 0;

      // Custom Master-Product production types: productionType carries the
      // poultry_products.product_key (CUSTOM_*). Quantity is recorded in the
      // product's own unit and stocked straight into its linked inventory SKU.
      if (data.productionType && !["EGGS", "BROILER_WEIGHT"].includes(data.productionType)) {
        const products = await db
          .select()
          .from(poultryProducts)
          .where(eq(poultryProducts.businessId, businessId));
        const product = products.find((p) => p.productKey === data.productionType);
        if (!product || !product.isActive) {
          return NextResponse.json(
            { success: false, error: "Unknown or inactive product type. Pick one from the Master Product List." },
            { status: 400 }
          );
        }
        const qty = Number(data.quantityProduced ?? data.quantity) || 0;
        const qtySold = Number(data.quantitySold) || 0;
        const [row] = await db
          .insert(poultryProduction)
          .values({
            businessId,
            branchCode,
            flockId: data.flockId ? Number(data.flockId) : null,
            batchNumber: data.batchNumber || null,
            productionType: product.productKey,
            quantityProduced: qty,
            productName: product.name,
            unit: product.unit,
            revenueGhs: revenue,
            recordedDate: data.recordedDate || today,
            recordedByName: data.recordedByName || "Farm Staff",
          })
          .returning();

        // Production → Stock linkage (same pipeline as eggs/broilers).
        let stockNote = "";
        if (qty > 0) {
          await stockIn({
            businessId,
            sku: product.sku,
            name: product.name,
            category: product.category,
            unit: product.unit,
            costPriceGhs: product.costPriceGhs ?? undefined,
            sellingPriceGhs: product.sellingPriceGhs ?? undefined,
            minStockThreshold: product.minStockThreshold ?? undefined,
            quantity: qty,
          });
          stockNote += ` | +${qty} ${product.unit} to stock`;
        }
        if (qtySold > 0) {
          const out = await stockOut({ businessId, sku: product.sku, quantity: qtySold });
          stockNote += ` | −${out.deducted} ${product.unit} sold from stock`;
        }

        // Production → Finance linkage.
        if (revenue > 0) {
          const trxNum = `TRX-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
          await db.insert(transactions).values({
            transactionNumber: trxNum,
            businessId,
            branchCode,
            branchName: data.branchName || null,
            type: "INCOME",
            category: "POULTRY_PRODUCT_SALE",
            amountGhs: revenue,
            paymentMethod: data.paymentMethod || "CASH",
            description: `Poultry production — ${qty} ${product.unit} ${product.name}${
              qtySold > 0 ? `, ${qtySold} sold` : ""
            }${stockNote}`,
            date: today,
            createdAt: new Date(),
            status: "COMPLETED",
            recordedBy: data.recordedByName || "Poultry Farm User",
            recordedByRole: data.recordedByRole || null,
            recordedByUserId: data.recordedByUserId ? Number(data.recordedByUserId) : null,
          });
        }

        return NextResponse.json({ success: true, item: row, stockNote, product });
      }

      const [row] = await db
        .insert(poultryProduction)
        .values({
          businessId,
          branchCode,
          flockId: data.flockId ? Number(data.flockId) : null,
          batchNumber: data.batchNumber || null,
          productionType: data.productionType || "EGGS",
          eggsCollected: eggs,
          traysProduced: Number(data.traysProduced) || Number((eggs / 30).toFixed(2)),
          crackedEggs: Number(data.crackedEggs) || 0,
          gradeA: Number(data.gradeA) || 0,
          gradeB: Number(data.gradeB) || 0,
          birdsHarvested: Number(data.birdsHarvested) || 0,
          totalWeightKg: Number(data.totalWeightKg) || 0,
          avgWeightKg: Number(data.avgWeightKg) || 0,
          layPercentage: Number(data.layPercentage) || 0,
          fcr: Number(data.fcr) || 0,
          revenueGhs: revenue,
          recordedDate: data.recordedDate || today,
          recordedByName: data.recordedByName || "Farm Staff",
        })
        .returning();

      // ── Stock linkage: completed production adds products to Inventory ──
      // Eggs collected become sellable crates; harvested broilers become
      // sellable dressed birds. Farm-gate quantities sold in the same entry
      // are deducted again so stock always reflects what is on hand.
      let stockNote = "";
      if (row.productionType === "EGGS") {
        const goodEggs = Math.max(0, eggs - (Number(data.crackedEggs) || 0));
        const cratesIn = Number(data.traysProduced) || eggs > 0 ? Number((goodEggs / 30).toFixed(2)) : 0;
        if (cratesIn > 0) {
          await stockIn({ businessId, ...POULTRY_PRODUCTS.EGGS, quantity: cratesIn });
          stockNote += ` | +${cratesIn} crates to stock`;
        }
        if (soldEggs > 0) {
          const cratesOut = Number((soldEggs / 30).toFixed(2));
          const out = await stockOut({ businessId, sku: POULTRY_PRODUCTS.EGGS.sku, quantity: cratesOut });
          stockNote += ` | −${out.deducted} crates sold from stock`;
        }
      } else {
        const harvested = Number(data.birdsHarvested) || 0;
        if (harvested > 0) {
          await stockIn({ businessId, ...POULTRY_PRODUCTS.BROILER, quantity: harvested });
          stockNote += ` | +${harvested} dressed birds to stock`;
        }
        if (broilersSold > 0) {
          const out = await stockOut({ businessId, sku: POULTRY_PRODUCTS.BROILER.sku, quantity: broilersSold });
          stockNote += ` | −${out.deducted} birds sold from stock`;
        }
      }

      // Auto-create revenue transaction when production includes sales revenue
      if (revenue > 0) {
        const trxNum = `TRX-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
        let desc = "Poultry production";
        if (eggs > 0) desc += ` — ${eggs} eggs collected`;
        if (soldEggs > 0) desc += `, ${soldEggs} sold`;
        if (broilersSold > 0) desc += `, ${broilersSold} broilers sold`;
        if (data.revenueSource) desc += ` | ${data.revenueSource}`;
        if (stockNote) desc += stockNote;

        await db.insert(transactions).values({
          transactionNumber: trxNum,
          businessId,
          branchCode,
          branchName: data.branchName || null,
          type: "INCOME",
          category: row.productionType === "BROILER_WEIGHT" ? "POULTRY_BROILER_SALE" : "POULTRY_EGG_SALE",
          amountGhs: revenue,
          paymentMethod: data.paymentMethod || "CASH",
          description: desc,
          date: today,
          createdAt: new Date(),
          status: "COMPLETED",
          recordedBy: data.recordedByName || "Poultry Farm User",
          recordedByRole: data.recordedByRole || null,
          recordedByUserId: data.recordedByUserId ? Number(data.recordedByUserId) : null,
        });
      }

      return NextResponse.json({ success: true, item: row, stockNote });
    }

    // ── CHECKLIST (create today's list) ────────────────────────────
    if (entity === "CHECKLIST") {
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      const rows = [];
      for (const t of tasks) {
        const [row] = await db
          .insert(poultryChecklists)
          .values({
            businessId,
            branchCode,
            checklistDate: data.checklistDate || today,
            taskKey: t.taskKey,
            taskLabel: t.taskLabel,
            category: t.category || "GENERAL",
            isCompleted: false,
          })
          .returning();
        rows.push(row);
      }
      return NextResponse.json({ success: true, items: rows });
    }

    return NextResponse.json(
      { success: false, error: `Unknown entity: ${entity}` },
      { status: 400 }
    );
  } catch (error: any) {
    console.error("POST /api/poultry error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/poultry
 * Toggle a checklist task, or update a flock.
 */
export async function PATCH(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const body = await request.json();
    const { entity, id, data } = body;

    if (entity === "CHECKLIST" && id) {
      const [existing] = await db
        .select()
        .from(poultryChecklists)
        .where(eq(poultryChecklists.id, Number(id)));
      if (!existing) {
        return NextResponse.json(
          { success: false, error: "Checklist task not found" },
          { status: 404 }
        );
      }
      const nowCompleted = !existing.isCompleted;
      const [row] = await db
        .update(poultryChecklists)
        .set({
          isCompleted: nowCompleted,
          completedByName: nowCompleted ? data?.completedByName || "Staff" : null,
          completedByRole: nowCompleted ? data?.completedByRole || null : null,
          completedAt: nowCompleted ? new Date() : null,
        })
        .where(eq(poultryChecklists.id, Number(id)))
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    if (entity === "FLOCK" && id) {
      const [row] = await db
        .update(poultryFlocks)
        .set({
          currentCount:
            data?.currentCount !== undefined ? Number(data.currentCount) : undefined,
          ageWeeks: data?.ageWeeks !== undefined ? Number(data.ageWeeks) : undefined,
          status: data?.status || undefined,
          notes: data?.notes ?? undefined,
        })
        .where(eq(poultryFlocks.id, Number(id)))
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    return NextResponse.json(
      { success: false, error: "Unsupported patch operation" },
      { status: 400 }
    );
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
