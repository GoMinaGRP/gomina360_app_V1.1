import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  poultryLogs,
  blockFactoryLogs,
  aquacultureLogs,
  livestockLogs,
  restaurantLogs,
  electronicsLogs,
  carWashLogs,
  hardwareLogs,
  inventoryItems,
  businesses,
  transactions,
} from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { stockOut, computeStockStatus } from "@/lib/stock";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ businessCode: string }> }
) {
  try {
    const { businessCode } = await params;
    const upperCode = businessCode.toUpperCase();

    // Resolve the requesting unit first: every branch (original or newly
    // created, e.g. WASH-02) reads ONLY its own operations logs — never the
    // shared table of another same-type unit.
    const [biz] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.code, upperCode));

    if (!biz) {
      return NextResponse.json(
        { success: false, error: `Unknown business code: ${upperCode}` },
        { status: 404 }
      );
    }

    if (upperCode.startsWith("POULTRY")) {
      const rows = await db.select().from(poultryLogs).where(eq(poultryLogs.businessId, biz.id)).orderBy(desc(poultryLogs.id));
      return NextResponse.json({ success: true, businessId: biz.id, logs: rows });
    }
    if (upperCode.startsWith("BLOCK")) {
      const rows = await db.select().from(blockFactoryLogs).where(eq(blockFactoryLogs.businessId, biz.id)).orderBy(desc(blockFactoryLogs.id));
      return NextResponse.json({ success: true, businessId: biz.id, logs: rows });
    }
    if (upperCode.startsWith("AQUA")) {
      const rows = await db.select().from(aquacultureLogs).where(eq(aquacultureLogs.businessId, biz.id)).orderBy(desc(aquacultureLogs.id));
      return NextResponse.json({ success: true, businessId: biz.id, logs: rows });
    }
    if (upperCode.startsWith("LIVESTOCK")) {
      const rows = await db.select().from(livestockLogs).where(eq(livestockLogs.businessId, biz.id)).orderBy(desc(livestockLogs.id));
      return NextResponse.json({ success: true, businessId: biz.id, logs: rows });
    }
    if (upperCode.startsWith("FOOD")) {
      const rows = await db.select().from(restaurantLogs).where(eq(restaurantLogs.businessId, biz.id)).orderBy(desc(restaurantLogs.id));
      return NextResponse.json({ success: true, businessId: biz.id, logs: rows });
    }
    if (upperCode.startsWith("TECH")) {
      const rows = await db.select().from(electronicsLogs).where(eq(electronicsLogs.businessId, biz.id)).orderBy(desc(electronicsLogs.id));
      return NextResponse.json({ success: true, businessId: biz.id, logs: rows });
    }
    if (upperCode.startsWith("WASH")) {
      const rows = await db.select().from(carWashLogs).where(eq(carWashLogs.businessId, biz.id)).orderBy(desc(carWashLogs.id));
      return NextResponse.json({ success: true, businessId: biz.id, logs: rows });
    }
    if (upperCode.startsWith("HARDWARE")) {
      const rows = await db.select().from(hardwareLogs).where(eq(hardwareLogs.businessId, biz.id)).orderBy(desc(hardwareLogs.id));
      return NextResponse.json({ success: true, businessId: biz.id, logs: rows });
    }

    return NextResponse.json(
      { success: false, error: `Unknown business code: ${upperCode}` },
      { status: 404 }
    );
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ businessCode: string }> }
) {
  try {
    const { businessCode } = await params;
    const upperCode = businessCode.toUpperCase();
    const body = await request.json();

    const [biz] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.code, upperCode));

    if (!biz) {
      return NextResponse.json(
        { success: false, error: "Business not found" },
        { status: 404 }
      );
    }

    const today = new Date().toISOString().split("T")[0];

    if (upperCode.startsWith("POULTRY")) {
      const [inserted] = await db
        .insert(poultryLogs)
        .values({
          businessId: biz.id,
          batchNumber: body.batchNumber || `BATCH-${new Date().getFullYear()}-${Math.floor(100 + Math.random() * 900)}`,
          birdType: body.birdType || "LAYERS",
          totalBirds: Number(body.totalBirds) || 3000,
          dailyEggsTrays: Number(body.dailyEggsTrays) || 100,
          feedConsumedKg: Number(body.feedConsumedKg) || 350,
          mortalityCount: Number(body.mortalityCount) || 0,
          healthStatus: body.healthStatus || "HEALTHY",
          recordedDate: today,
        })
        .returning();
      return NextResponse.json({ success: true, log: inserted });
    }

    if (upperCode.startsWith("BLOCK")) {
      const [inserted] = await db
        .insert(blockFactoryLogs)
        .values({
          businessId: biz.id,
          batchId: body.batchId || `BLK-PROD-${Math.floor(100 + Math.random() * 900)}`,
          blockType: body.blockType || "6-INCH-SOLID",
          bagsCementUsed: Number(body.bagsCementUsed) || 50,
          blocksMolded: Number(body.blocksMolded) || 1500,
          blocksBroken: Number(body.blocksBroken) || 8,
          qualityGrade: body.qualityGrade || "GRADE_A_STANDARD",
          recordedDate: today,
        })
        .returning();
      return NextResponse.json({ success: true, log: inserted });
    }

    if (upperCode.startsWith("AQUA")) {
      const [inserted] = await db
        .insert(aquacultureLogs)
        .values({
          businessId: biz.id,
          pondId: body.pondId || `CAGE-${Math.floor(10 + Math.random() * 90)}`,
          species: body.species || "VOLTA_TILAPIA",
          stockCount: Number(body.stockCount) || 5000,
          averageWeightGrams: Number(body.averageWeightGrams) || 750,
          phLevel: Number(body.phLevel) || 7.2,
          dissolvedOxygen: Number(body.dissolvedOxygen) || 6.5,
          fcr: Number(body.fcr) || 1.32,
          recordedDate: today,
        })
        .returning();
      return NextResponse.json({ success: true, log: inserted });
    }

    if (upperCode.startsWith("LIVESTOCK")) {
      const [inserted] = await db
        .insert(livestockLogs)
        .values({
          businessId: biz.id,
          tagNumber: body.tagNumber || `GH-TAG-${Math.floor(100 + Math.random() * 900)}`,
          animalType: body.animalType || "CATTLE",
          breed: body.breed || "SANGA",
          weightKg: Number(body.weightKg) || 380,
          vaccinationStatus: body.vaccinationStatus || "UP_TO_DATE",
          pregnantStatus: Boolean(body.pregnantStatus),
          recordedDate: today,
        })
        .returning();
      return NextResponse.json({ success: true, log: inserted });
    }

    if (upperCode.startsWith("FOOD")) {
      const [inserted] = await db
        .insert(restaurantLogs)
        .values({
          businessId: biz.id,
          shiftDate: today,
          totalOrders: Number(body.totalOrders) || 120,
          mostPopularDish: body.mostPopularDish || "Jollof Rice with Tilapia",
          foodCostPercent: Number(body.foodCostPercent) || 27.5,
          wastePercent: Number(body.wastePercent) || 2.5,
          momoReceiptsGhs: Number(body.momoReceiptsGhs) || 4500,
          cashReceiptsGhs: Number(body.cashReceiptsGhs) || 2100,
        })
        .returning();
      return NextResponse.json({ success: true, log: inserted });
    }

    if (upperCode.startsWith("TECH")) {
      const [inserted] = await db
        .insert(electronicsLogs)
        .values({
          businessId: biz.id,
          serialNumber: body.serialNumber || `SN-ELC-${Math.floor(10000 + Math.random() * 90000)}`,
          productName: body.productName || "5kVA Solar Hybrid Inverter",
          brand: body.brand || "Felicity Solar",
          warrantyMonths: Number(body.warrantyMonths) || 24,
          inStock: Boolean(body.inStock ?? true),
          retailPriceGhs: Number(body.retailPriceGhs) || 9500,
          lastCheckedDate: today,
        })
        .returning();
      return NextResponse.json({ success: true, log: inserted });
    }

    if (upperCode.startsWith("WASH")) {
      const [inserted] = await db
        .insert(carWashLogs)
        .values({
          businessId: biz.id,
          shiftDate: today,
          vehiclesWashed: Number(body.vehiclesWashed) || 40,
          chemicalUsedLiters: Number(body.chemicalUsedLiters) || 12.0,
          totalRevenueGhs: Number(body.totalRevenueGhs) || 2200,
          waterPressurePsi: Number(body.waterPressurePsi) || 3200,
          recordedDate: today,
        })
        .returning();

      // ── Finance linkage: wash revenue flows into Transactions so the
      // branch's revenue / profit / dashboards update immediately ──
      if ((inserted.totalRevenueGhs || 0) > 0) {
        await db.insert(transactions).values({
          transactionNumber: `TRX-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`,
          businessId: biz.id,
          branchCode: biz.code,
          branchName: biz.name,
          type: "INCOME",
          category: "CAR_WASH_REVENUE",
          amountGhs: inserted.totalRevenueGhs,
          paymentMethod: body.paymentMethod || "CASH",
          description: `Auto Wash shift ${inserted.shiftDate}: ${inserted.vehiclesWashed} vehicles washed`,
          date: today,
          createdAt: new Date(),
          status: "COMPLETED",
          recordedBy: body.recordedBy || body.createdByName || "Auto Wash Supervisor",
          recordedByRole: body.recordedByRole || body.createdByRole || null,
          recordedByUserId: body.recordedByUserId ? Number(body.recordedByUserId) : null,
        }).catch((e) => console.error("wash revenue txn warning:", e));
      }

      // ── Stock linkage: shampoo / chemical consumption deducts stock ──
      // Targets the seeded 50L chemical drum (liters ÷ 50 = drums); falls
      // back to a liters-priced shampoo product if the branch stocks one.
      if ((inserted.chemicalUsedLiters || 0) > 0) {
        try {
          let out = await stockOut({
            businessId: biz.id,
            sku: "WASH-CHEM-50L",
            quantity: Number((inserted.chemicalUsedLiters / 50).toFixed(2)),
          });
          if (!out.deducted) {
            out = await stockOut({
              businessId: biz.id,
              name: "Car Wash Shampoo (Liters)",
              quantity: inserted.chemicalUsedLiters,
            });
          }
        } catch (e) {
          console.error("wash chemical stock warning:", e);
        }
      }

      return NextResponse.json({ success: true, log: inserted });
    }

    if (upperCode.startsWith("HARDWARE")) {
      // Goods-Received Note: the yard intake ledger. Every logged receipt
      // tops up (or creates) the matching inventory item, and the landed
      // cost books straight to Finance — Stock → Inventory, Purchases →
      // Finance stay in lock-step with the physical yard.
      const qty = Math.max(0, Number(body.quantityReceived) || 0);
      const unitCost = Number(body.unitCostGhs) || 0;
      const stampNote = Date.now().toString().slice(-6);
      const [inserted] = await db
        .insert(hardwareLogs)
        .values({
          businessId: biz.id,
          receiveNoteNumber: body.receiveNoteNumber || `GRN-HW-${new Date().getFullYear()}-${stampNote}`,
          supplierName: body.supplierName || "Supplier",
          itemName: body.itemName || "Building Material",
          quantityReceived: qty,
          unit: body.unit || "Units",
          unitCostGhs: unitCost,
          condition: ["GOOD", "PARTIAL", "DAMAGED"].includes(body.condition) ? body.condition : "GOOD",
          receivedBy: body.receivedBy || body.createdByName || null,
          recordedDate: today,
        })
        .returning();

      // ── Stock linkage: received goods flow into Inventory ──
      if (qty > 0) {
        try {
          const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.businessId, biz.id));
          const key = String(inserted.itemName || "").toUpperCase().slice(0, 12);
          const target = inv.find(
            (i: any) =>
              i.name?.toUpperCase().includes(key) ||
              key.includes(String(i.name || "").toUpperCase().slice(0, 12))
          );
          if (target) {
            const newQty = (target.quantity || 0) + qty;
            await db
              .update(inventoryItems)
              .set({
                quantity: newQty,
                costPriceGhs: unitCost || target.costPriceGhs,
                status: computeStockStatus(newQty, target.minStockThreshold || 0),
              })
              .where(eq(inventoryItems.id, target.id));
          } else {
            const taken = new Set(
              (await db.select({ sku: inventoryItems.sku }).from(inventoryItems)).map((r: any) => r.sku)
            );
            let sku = `HW-${String(inserted.itemName || "ITEM").toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 18)}`;
            let n = 2;
            while (taken.has(sku)) sku = `${sku.slice(0, 20)}-${n++}`;
            await db.insert(inventoryItems).values({
              name: inserted.itemName,
              sku,
              businessId: biz.id,
              category: "Building Materials",
              quantity: qty,
              unit: inserted.unit || "Units",
              costPriceGhs: unitCost,
              sellingPriceGhs: Math.round(unitCost * 1.25 * 100) / 100,
              minStockThreshold: 10,
              status: computeStockStatus(qty, 10),
            });
          }
        } catch (e) {
          console.error("hardware receipt stock warning:", e);
        }
      }

      // ── Finance linkage: landed cost books as an EXPENSE ──
      if (qty > 0 && unitCost > 0 && body.recordExpense !== false) {
        await db.insert(transactions).values({
          transactionNumber: `TRX-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`,
          businessId: biz.id,
          branchCode: biz.code,
          branchName: biz.name,
          type: "EXPENSE",
          category: "HARDWARE_STOCK_RECEIPT",
          amountGhs: qty * unitCost,
          paymentMethod: body.paymentMethod || "BANK_TRANSFER",
          description: `GRN ${inserted.receiveNoteNumber}: ${qty} ${inserted.unit} ${inserted.itemName} from ${inserted.supplierName}`,
          date: today,
          createdAt: new Date(),
          status: "COMPLETED",
          recordedBy: body.receivedBy || body.createdByName || "Hardware Depot",
          recordedByRole: body.recordedByRole || body.createdByRole || null,
          recordedByUserId: body.recordedByUserId ? Number(body.recordedByUserId) : null,
        }).catch((e) => console.error("hardware receipt txn warning:", e));
      }

      return NextResponse.json({ success: true, log: inserted });
    }

    return NextResponse.json(
      { success: false, error: "Unsupported business log category" },
      { status: 400 }
    );
  } catch (error: any) {
    console.error("POST log error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
