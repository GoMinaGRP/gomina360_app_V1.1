import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  blockFactoryLogs,
  blockFactoryOrders,
  blockFactoryDeliveries,
  blockFactoryChecklists,
  blockTypes,
  blockQcChecks,
  inventoryItems,
  transactions,
  businesses,
} from "@/db/schema";
import { deriveDensityKgm3 } from "@/lib/blockQc";
import { and, eq } from "drizzle-orm";
import { computeStockStatus, ensureInventoryItem } from "@/lib/stock";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

// Original factory block types — master list seeds with exactly these keys so
// all existing production records, orders and filters stay unchanged.
const DEFAULT_BLOCK_TYPES = [
  { typeKey: "6-INCH-SOLID", name: "6-Inch Solid Blocks", dimensions: "6in x 9in x 18in", style: "SOLID" },
  { typeKey: "6-INCH-HOLLOW", name: "6-Inch Hollow Blocks", dimensions: "6in x 8in x 16in", style: "HOLLOW" },
  { typeKey: "5-INCH-SOLID", name: "5-Inch Solid Blocks", dimensions: "5in x 6in x 16in", style: "SOLID" },
  { typeKey: "PAVING-BRICKS", name: "Paving Bricks", dimensions: "4in x 8in pavers", style: "PAVING" },
];

// Fallback selling prices for the factory's original types — used only when a
// master type carries no price of its own and a stock item must be created.
const LEGACY_PRICE_HINTS: Record<string, number> = {
  "6-INCH-SOLID": 14.5,
  "6-INCH-HOLLOW": 12.0,
  "5-INCH-SOLID": 11.0,
  "PAVING-BRICKS": 6.0,
  "5-INCH-HOLLOW": 10.0,
  "4-INCH-SOLID": 9.0,
};

/**
 * Canonical Production/Restock → Stock link.
 *
 * Every block type in the production master list maps to exactly ONE
 * finished-goods inventory item, resolved in strict priority:
 *   1. the SKU stored on the master type row (authoritative link), else
 *   2. an item whose SKU follows the BLK-{typeKey} convention, else
 *   3. a word-exact token match on the master type's name
 *      (links e.g. the seeded "6-Inch Solid Construction Blocks (Grade A)"
 *      item to 6-INCH-SOLID while NEVER mixing solid/hollow/paving stock —
 *      the old prefix heuristic credited hollow production to solid stock).
 *
 * When `autoCreate` is on and nothing matches, the finished-goods item is
 * created on the spot so produced/restocked stock can never be lost. The
 * resolved SKU is written back onto the master type row, making the
 * Production → Stock → Sales link permanent and visible across the app.
 */
async function resolveBlockTypeItem(
  businessId: number,
  blockType: string,
  opts: { autoCreate?: boolean; masterTypeRow?: any } = {},
) {
  const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.businessId, businessId));
  let masterType = opts.masterTypeRow;
  if (!masterType) {
    const [row] = await db
      .select()
      .from(blockTypes)
      .where(and(eq(blockTypes.businessId, businessId), eq(blockTypes.typeKey, blockType)))
      .limit(1);
    masterType = row;
  }

  const upperKey = String(blockType).toUpperCase();
  let item: any =
    (masterType?.sku
      ? inv.find((i: any) => (i.sku || "").toUpperCase() === String(masterType.sku).toUpperCase())
      : undefined) ||
    inv.find((i: any) => (i.sku || "").toUpperCase() === `BLK-${upperKey}`) ||
    null;

  if (!item && masterType?.name) {
    // Word-exact token match: every token of the type name must appear as a
    // whole word in the item name (never a substring → no cross-type leaks).
    const tokens = String(masterType.name)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, " ")
      .split(" ")
      .filter(Boolean);
    item =
      inv.find((i: any) => {
        const words = String(i.name || "")
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, " ")
          .split(" ")
          .filter(Boolean);
        return tokens.length > 0 && tokens.every((t) => words.includes(t));
      }) || null;
  }

  if (!item && opts.autoCreate) {
    const label =
      masterType?.name ||
      String(blockType)
        .split("-")
        .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
        .join(" ") + " Blocks";
    const price = Number(masterType?.defaultUnitPriceGhs) || LEGACY_PRICE_HINTS[upperKey] || 0;
    item = await ensureInventoryItem({
      businessId,
      sku: `BLK-${upperKey}`,
      name: label,
      category: "Concrete Blocks",
      unit: "Units",
      costPriceGhs: price ? Math.round(price * 0.66 * 100) / 100 : 0,
      sellingPriceGhs: price,
      minStockThreshold: 100,
    });
  }

  // Persist the resolved link on the master type (self-healing).
  if (item && masterType && String(masterType.sku || "") !== String(item.sku)) {
    await db.update(blockTypes).set({ sku: item.sku }).where(eq(blockTypes.id, masterType.id));
    masterType.sku = item.sku;
  }

  return { item, masterType };
}

export async function GET(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const businessId = Number(searchParams.get("businessId"));
    if (!businessId) {
      return NextResponse.json({ success: false, error: "businessId required" }, { status: 400 });
    }

    const [production, orders, deliveries, inventory, checklists, existingTypes, qcChecks] = await Promise.all([
      db.select().from(blockFactoryLogs).where(eq(blockFactoryLogs.businessId, businessId)),
      db.select().from(blockFactoryOrders).where(eq(blockFactoryOrders.businessId, businessId)),
      db.select().from(blockFactoryDeliveries).where(eq(blockFactoryDeliveries.businessId, businessId)),
      db.select().from(inventoryItems).where(eq(inventoryItems.businessId, businessId)),
      db.select().from(blockFactoryChecklists).where(eq(blockFactoryChecklists.businessId, businessId)),
      db.select().from(blockTypes).where(eq(blockTypes.businessId, businessId)),
      db.select().from(blockQcChecks).where(eq(blockQcChecks.businessId, businessId)),
    ]);

    // Seed the block type master list once with the factory's original types
    let types = existingTypes;
    if (types.length === 0) {
      for (const t of DEFAULT_BLOCK_TYPES) {
        const [row] = await db.insert(blockTypes).values({ businessId, ...t }).returning();
        types.push(row);
      }
    }

    // Self-heal master-list → inventory SKU links so Production, Restock and
    // Sales always credit one canonical stock row per block type.
    for (const t of types) {
      if (!t.sku) {
        await resolveBlockTypeItem(businessId, t.typeKey, { masterTypeRow: t });
      }
    }

    return NextResponse.json({
      success: true,
      production: production.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)),
      orders: orders.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)),
      deliveries: deliveries.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)),
      inventory,
      checklists: checklists.sort((a: any, b: any) => (a.id || 0) - (b.id || 0)),
      blockTypes: types.sort((a: any, b: any) => (a.id || 0) - (b.id || 0)),
      qcChecks: qcChecks.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)),
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
      return NextResponse.json({ success: false, error: "entity and businessId required" }, { status: 400 });
    }

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    const branchCode = data.branchCode || biz?.code || null;
    const branchName = data.branchName || biz?.name || null;
    const today = new Date().toISOString().split("T")[0];

    // ── BLOCK_TYPE (extend the block production master list) ──────────
    if (entity === "BLOCK_TYPE") {
      const rawName = String(data.name || data.typeKey || "").trim();
      if (!rawName) {
        return NextResponse.json({ success: false, error: "Block type name is required" }, { status: 400 });
      }
      const typeKey = String(data.typeKey || rawName)
        .toUpperCase()
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^A-Z0-9&-]/g, "");
      if (!typeKey) {
        return NextResponse.json({ success: false, error: "Enter a valid block type name" }, { status: 400 });
      }

      // Make sure the master list exists (seeded) before duplicate-checking
      let existing = await db.select().from(blockTypes).where(eq(blockTypes.businessId, businessId));
      if (existing.length === 0) {
        for (const t of DEFAULT_BLOCK_TYPES) {
          const [seeded] = await db.insert(blockTypes).values({ businessId, ...t }).returning();
          existing.push(seeded);
        }
      }
      if (existing.some((t: any) => String(t.typeKey).toUpperCase() === typeKey)) {
        return NextResponse.json(
          { success: false, error: `"${typeKey}" is already in the block type master list` },
          { status: 409 },
        );
      }

      const upper = (rawName + " " + (data.style || "")).toUpperCase();
      const style = ["SOLID", "HOLLOW", "PAVING", "INTERLOCKING", "OTHER"].includes(String(data.style || "").toUpperCase())
        ? String(data.style).toUpperCase()
        : upper.includes("HOLLOW") ? "HOLLOW"
        : upper.includes("PAV") ? "PAVING"
        : upper.includes("INTERLOCK") ? "INTERLOCKING"
        : upper.includes("SOLID") ? "SOLID"
        : "OTHER";

      const unitPrice = Number(data.defaultUnitPriceGhs) || 0;

      // Optionally register (or reuse) a finished-goods inventory item so the
      // new type is tracked in stock, sellable in Sales, and visible in
      // reports. If a matching item already exists it is linked, never
      // duplicated.
      let linkedSku: string | null = null;
      if (data.createInventoryItem !== false) {
        const item = await ensureInventoryItem({
          businessId,
          sku: `BLK-${typeKey}`,
          name: rawName,
          category: "Concrete Blocks",
          unit: "Units",
          costPriceGhs: unitPrice ? Math.round(unitPrice * 0.66 * 100) / 100 : 0,
          sellingPriceGhs: unitPrice,
          minStockThreshold: 100,
        });
        linkedSku = item.sku;
      }

      const [row] = await db.insert(blockTypes).values({
        businessId,
        branchCode,
        typeKey,
        name: rawName,
        dimensions: data.dimensions || null,
        style,
        defaultUnitPriceGhs: unitPrice || null,
        sku: linkedSku,
        isActive: true,
        createdByName: data.createdByName || null,
        createdByRole: data.createdByRole || null,
      }).returning();
      return NextResponse.json({ success: true, item: row });
    }

    if (entity === "PRODUCTION") {
      const blocksMolded = Number(data.blocksMolded) || 0;
      const blocksBroken = Number(data.blocksBroken) || 0;
      const goodBlocks = Math.max(0, blocksMolded - blocksBroken);
      const blockType = data.blockType || "6-INCH-SOLID";
      const [row] = await db.insert(blockFactoryLogs).values({
        businessId,
        batchId: data.batchId || `BLK-PROD-${Date.now().toString().slice(-5)}`,
        blockType,
        bagsCementUsed: Number(data.bagsCementUsed) || 0,
        blocksMolded,
        blocksBroken,
        qualityGrade: data.qualityGrade || "GRADE_A_STANDARD",
        recordedDate: data.recordedDate || today,
      }).returning();

      // Production → Stock: ALWAYS credit the canonical finished-goods item
      // for this exact block type (auto-created on first use), so every good
      // block lands in stock and instantly appears in Sales, low-stock
      // alerts, dashboards and valuation reports.
      let stock: any = null;
      if (goodBlocks > 0) {
        const { item } = await resolveBlockTypeItem(businessId, blockType, { autoCreate: true });
        const newQty = (item.quantity || 0) + goodBlocks;
        const [updated] = await db
          .update(inventoryItems)
          .set({ quantity: newQty, status: computeStockStatus(newQty, item.minStockThreshold || 0) })
          .where(eq(inventoryItems.id, item.id))
          .returning();
        stock = {
          sku: updated.sku,
          name: updated.name,
          added: goodBlocks,
          quantity: updated.quantity,
          status: updated.status,
        };
      }

      return NextResponse.json({ success: true, item: row, stock });
    }

    if (entity === "ORDER") {
      const qty = Number(data.quantity) || 0;
      const price = Number(data.unitPriceGhs) || 0;
      const [row] = await db.insert(blockFactoryOrders).values({
        businessId, branchCode,
        orderNumber: data.orderNumber || `ORD-BLK-${new Date().getFullYear()}-${Date.now().toString().slice(-5)}`,
        customerName: data.customerName || "Walk-in Customer",
        customerPhone: data.customerPhone || null,
        blockType: data.blockType || "6-INCH-SOLID",
        quantity: qty,
        unitPriceGhs: price,
        totalGhs: qty * price,
        status: data.status || "PENDING",
        dueDate: data.dueDate || null,
        notes: data.notes || null,
        createdByName: data.createdByName || "Block Factory User",
        createdByRole: data.createdByRole || null,
      }).returning();
      return NextResponse.json({ success: true, item: row });
    }

    if (entity === "DELIVERY") {
      const [row] = await db.insert(blockFactoryDeliveries).values({
        businessId, branchCode,
        deliveryNumber: data.deliveryNumber || `DLV-BLK-${new Date().getFullYear()}-${Date.now().toString().slice(-5)}`,
        orderNumber: data.orderNumber || null,
        customerName: data.customerName || "Customer",
        blockType: data.blockType || null,
        quantity: Number(data.quantity) || 0,
        vehicleNumber: data.vehicleNumber || null,
        driverName: data.driverName || null,
        status: data.status || "SCHEDULED",
        deliveryDate: data.deliveryDate || today,
        notes: data.notes || null,
        createdByName: data.createdByName || "Block Factory User",
      }).returning();
      return NextResponse.json({ success: true, item: row });
    }

    if (entity === "EXPENSE") {
      const trxNum = `TRX-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
      const [row] = await db.insert(transactions).values({
        transactionNumber: trxNum,
        businessId,
        branchCode,
        branchName,
        type: "EXPENSE",
        category: data.category || "BLOCK_FACTORY_EXPENSE",
        amountGhs: Number(data.amountGhs) || 0,
        paymentMethod: data.paymentMethod || "CASH",
        description: data.description || "Block factory expense",
        date: data.date || today,
        createdAt: new Date(),
        status: "COMPLETED",
        recordedBy: data.recordedBy || "Block Factory User",
        recordedByRole: data.recordedByRole || null,
        recordedByUserId: data.recordedByUserId ? Number(data.recordedByUserId) : null,
      }).returning();
      return NextResponse.json({ success: true, item: row });
    }

    // ── CHECKLIST (create a day's task list; idempotent per business+branch+date) ──
    if (entity === "CHECKLIST") {
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      const targetDate = data.checklistDate || today;
      const existing = await db
        .select()
        .from(blockFactoryChecklists)
        .where(
          and(
            eq(blockFactoryChecklists.businessId, businessId),
            eq(blockFactoryChecklists.branchCode, branchCode),
            eq(blockFactoryChecklists.checklistDate, targetDate),
          ),
        );
      if (existing.length > 0) {
        return NextResponse.json({ success: true, items: existing, alreadyExists: true });
      }
      const rows = [];
      for (const t of tasks) {
        const [row] = await db
          .insert(blockFactoryChecklists)
          .values({
            businessId,
            branchCode,
            checklistDate: data.checklistDate || today,
            taskKey: t.taskKey,
            taskLabel: t.taskLabel,
            category: t.category || "GENERAL",
            isCompleted: false,
            notes: t.notes || null,
          })
          .returning();
        rows.push(row);
      }
      return NextResponse.json({ success: true, items: rows });
    }

    // ── QC_CHECK (Quality Control at any pipeline stage) ─────────────────
    // Pure quality evidence — never mutates stock or transactions. Links the
    // check to its production batch (auto-filling block type + branch), derives
    // density from weight × dimensions, and stamps tester + recorder identity.
    if (entity === "QC_CHECK") {
      const stages = ["RAW_MATERIAL", "MIXING", "PRODUCTION", "CURING", "FINISHED_BLOCK"];
      const stage = String(data.stage || "").toUpperCase();
      if (!stages.includes(stage)) {
        return NextResponse.json(
          { success: false, error: "stage must be one of " + stages.join(", ") },
          { status: 400 },
        );
      }
      const testName = String(data.testName || "").trim();
      if (!testName) {
        return NextResponse.json({ success: false, error: "testName is required" }, { status: 400 });
      }
      const passFail = String(data.passFail || "").toUpperCase() === "FAIL" ? "FAIL" : "PASS";

      // Batch link: the batch must belong to THIS business (404 otherwise).
      let batchRow: any = null;
      const batchId = data.batchId ? String(data.batchId).trim() : null;
      if (batchId) {
        const [found] = await db
          .select()
          .from(blockFactoryLogs)
          .where(and(eq(blockFactoryLogs.businessId, businessId), eq(blockFactoryLogs.batchId, batchId)))
          .limit(1);
        if (!found) {
          return NextResponse.json(
            { success: false, error: `Batch ${batchId} not found for this business` },
            { status: 404 },
          );
        }
        batchRow = found;
      }

      const num = (v: any) => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? null : Number(v));
      const densityKgm3 = deriveDensityKgm3({
        weightKg: num(data.weightKg),
        lengthMm: num(data.lengthMm),
        widthMm: num(data.widthMm),
        heightMm: num(data.heightMm),
        densityKgm3: num(data.densityKgm3),
      });

      const [row] = await db.insert(blockQcChecks).values({
        businessId,
        branchCode: data.branchCode || batchRow?.branchCode || branchCode,
        stage,
        batchId: batchId || null,
        batchNumber: batchId || null,
        blockType: batchRow?.blockType || data.blockType || null,
        sampleRef: data.sampleRef || null,
        testName,
        requiredStandard: data.requiredStandard || null,
        testResult: data.testResult || null,
        resultValue: num(data.resultValue),
        resultUnit: data.resultUnit || null,
        passFail,
        weightKg: num(data.weightKg),
        lengthMm: num(data.lengthMm),
        widthMm: num(data.widthMm),
        heightMm: num(data.heightMm),
        densityKgm3,
        compressiveStrengthMpa: num(data.compressiveStrengthMpa),
        cracksCount: num(data.cracksCount) === null ? null : Math.round(num(data.cracksCount)!),
        surfaceQuality: data.surfaceQuality ? String(data.surfaceQuality).toUpperCase() : null,
        defectsCount: num(data.defectsCount) === null ? null : Math.round(num(data.defectsCount)!),
        curingDays: num(data.curingDays) === null ? null : Math.round(num(data.curingDays)!),
        rejectedBlocks: Math.max(0, Math.round(num(data.rejectedBlocks) || 0)),
        notes: data.notes || null,
        photo: data.photo || null,
        testedAt: data.testedAt ? new Date(data.testedAt) : new Date(),
        testerName: data.testerName || __authSession.user?.name || null,
        testerRole: data.testerRole || __authSession.user?.role || null,
        recordedByName: data.recordedByName || __authSession.user?.name || null,
        recordedByRole: data.recordedByRole || __authSession.user?.role || null,
      }).returning();
      return NextResponse.json({ success: true, item: row });
    }

    // ── RESTOCK (receive purchased materials/finished goods) ───────
    // Accepts EITHER a blockType from the production master list (resolving —
    // and when needed auto-creating — its finished-goods stock item) OR a
    // direct inventoryId for raw materials/supplies. Increments stock,
    // refreshes status + cost price, and — when a cost is provided — books
    // the purchase as an EXPENSE transaction so Finance, dashboards and
    // reports all update automatically.
    if (entity === "RESTOCK") {
      const qty = Number(data.quantity) || 0;
      if (qty <= 0) {
        return NextResponse.json({ success: false, error: "quantity must be greater than 0" }, { status: 400 });
      }

      let item: any = null;
      let blockTypeUsed: string | null = null;
      if (data.blockType) {
        blockTypeUsed = String(data.blockType);
        const resolved = await resolveBlockTypeItem(businessId, blockTypeUsed, { autoCreate: true });
        item = resolved.item;
      } else {
        const inventoryId = Number(data.inventoryId);
        if (!inventoryId) {
          return NextResponse.json(
            { success: false, error: "Select a block type from the master list or an inventory item" },
            { status: 400 },
          );
        }
        const [found] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, inventoryId));
        if (!found || found.businessId !== businessId) {
          return NextResponse.json({ success: false, error: "Inventory item not found for this branch" }, { status: 404 });
        }
        item = found;
      }

      const unitCost = Number(data.unitCostGhs) || 0;
      const newQty = (item.quantity || 0) + qty;
      const set: any = {
        quantity: newQty,
        status: computeStockStatus(newQty, item.minStockThreshold || 0),
      };
      if (unitCost > 0) set.costPriceGhs = unitCost;
      const [updated] = await db
        .update(inventoryItems)
        .set(set)
        .where(eq(inventoryItems.id, item.id))
        .returning();

      let expenseRow = null;
      const totalCost = Number(data.totalCostGhs) || (unitCost > 0 ? qty * unitCost : 0);
      if (data.recordExpense && totalCost > 0) {
        const trxNum = `TRX-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
        [expenseRow] = await db
          .insert(transactions)
          .values({
            transactionNumber: trxNum,
            businessId,
            branchCode,
            branchName,
            type: "EXPENSE",
            category: data.category || (blockTypeUsed ? "Stock Purchase (Blocks)" : "Stock Purchase"),
            amountGhs: totalCost,
            paymentMethod: data.paymentMethod || "CASH",
            description:
              data.description ||
              `Restock: ${qty}× ${item.name} (${item.sku})${blockTypeUsed ? ` — master list type ${blockTypeUsed}` : ""}`,
            date: data.date || today,
            createdAt: new Date(),
            status: "COMPLETED",
            recordedBy: data.recordedBy || "Block Factory User",
            recordedByRole: data.recordedByRole || null,
            recordedByUserId: data.recordedByUserId ? Number(data.recordedByUserId) : null,
          })
          .returning();
      }

      return NextResponse.json({ success: true, item: updated, expense: expenseRow, blockType: blockTypeUsed });
    }

    return NextResponse.json({ success: false, error: "Unknown entity" }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/**
 * PATCH /api/block-factory
 * Toggle a daily checklist task completed/uncompleted.
 */
export async function PATCH(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { entity, id, data } = body;

    if (entity === "CHECKLIST" && id) {
      const [existing] = await db
        .select()
        .from(blockFactoryChecklists)
        .where(eq(blockFactoryChecklists.id, Number(id)));
      if (!existing) {
        return NextResponse.json({ success: false, error: "Checklist task not found" }, { status: 404 });
      }
      const nowCompleted = !existing.isCompleted;
      const [row] = await db
        .update(blockFactoryChecklists)
        .set({
          isCompleted: nowCompleted,
          completedByName: nowCompleted ? data?.completedByName || "Staff" : null,
          completedByRole: nowCompleted ? data?.completedByRole || null : null,
          completedAt: nowCompleted ? new Date() : null,
        })
        .where(eq(blockFactoryChecklists.id, Number(id)))
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    return NextResponse.json({ success: false, error: "Unknown entity" }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
