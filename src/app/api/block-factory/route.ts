import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import {
  blockFactoryLogs,
  blockFactoryOrders,
  blockFactoryDeliveries,
  blockFactoryChecklists,
  blockTypes,
  blockQcChecks,
  blockMixFormulations,
  blockMixFormulationItems,
  blockMixBatches,
  blockMixBatchInputs,
  inventoryItems,
  transactions,
  businesses,
  notifications,
} from "@/db/schema";
import { deriveDensityKgm3 } from "@/lib/blockQc";
import { and, eq } from "drizzle-orm";
import { computeStockStatus, ensureInventoryItem, stockIn, stockOut } from "@/lib/stock";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { apiError } from "@/lib/apiError";
import { auditLog } from "@/lib/audit";
import { linkSupplier } from "@/lib/supplierLinks";
import { ownerOrgOfBusiness, orderNotificationRecipients } from "@/lib/notify";
import { pushToUsers, urlForNotification } from "@/lib/push";
import { nextTrxNumber } from "@/lib/idNumbers";

// Original factory block types — master list seeds with exactly these keys so
// all existing production records, orders and filters stay unchanged.
// NOTE: the block production master list starts EMPTY for every business — no
// sample block types are auto-seeded (owner directive: new / reset units begin
// with zero sample, test or unrelated data). The demo flagship BLOCK-01
// receives its original types from the seed (seed.ts) only.

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

// ── MIXING (feed-mill pattern adapted to the block factory) ────────────────
const MIX_RAW_CATEGORY = "Block Raw Materials";
const MIX_OPS_CATEGORY = "BLOCK_MIX_OPS";
const MIX_SUPPLIER_CATEGORY = "Cement & Aggregates";
const mixTrxNum = () => nextTrxNumber();
const tr = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "ITEM";
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

async function postMixExpense(me: any, opts: {
  businessId: number; branchCode: string | null; branchName: string | null;
  category: string; amountGhs: number; paymentMethod: string; description: string; date: string;
}) {
  if (!(opts.amountGhs > 0)) return null;
  const [row] = await db.insert(transactions).values({
    transactionNumber: mixTrxNum(),
    businessId: opts.businessId,
    branchCode: opts.branchCode,
    branchName: opts.branchName,
    type: "EXPENSE",
    category: opts.category,
    amountGhs: opts.amountGhs,
    paymentMethod: opts.paymentMethod || "CASH",
    description: opts.description,
    date: opts.date,
    createdAt: new Date(),
    status: "COMPLETED",
    recordedBy: me.name || "Block Factory User",
    recordedByRole: me.role || null,
    recordedByUserId: Number(me.id) || null,
  }).returning();
  return row;
}

/** Bell + push fan-out for mixer events (never throws). */
async function mixBell({ businessId, branchCode, type, title, body, recordType, recordId, recordRef, priority = null as string | null }: {
  businessId: number; branchCode: string | null; type: string; title: string; body: string;
  recordType: string; recordId: number; recordRef: string; priority?: string | null;
}) {
  try {
    const recipients = await orderNotificationRecipients(businessId);
    const ownerOrg = await ownerOrgOfBusiness(businessId);
    const url = urlForNotification(type, { branchCode });
    const ids: number[] = [];
    for (const u of recipients || []) {
      const dupe = await db.select({ id: notifications.id }).from(notifications)
        .where(and(eq(notifications.userId, Number(u.id)), eq(notifications.type, type), eq(notifications.recordRef, recordRef))).limit(1);
      const [row] = dupe.length
        ? [{ id: dupe[0].id }]
        : await db.insert(notifications).values({
            userId: Number(u.id), type, title, body, recordType, recordId: recordId ?? null, recordRef,
            businessId, branchCode: branchCode ?? null, actorName: null, priority, ownerId: ownerOrg,
          }).returning();
      if (row?.id) ids.push(Number(u.id));
    }
    if (ids.length) {
      await pushToUsers(ids, { type, title, body, url }).catch(() => ({ attempted: 0, sent: 0, pruned: 0 } as any));
    }
  } catch (e) {
    console.error("[block-mix] bell failed:", e);
  }
}

/** Resolve (or auto-create) the raw-material inventory item for a recipe line. */
async function ensureMixRawMaterial(businessId: number, name: string) {
  const sku = `BLK-RM-${tr(name).replace(/_/g, "-")}`;
  const existing = await db.select().from(inventoryItems).where(eq(inventoryItems.businessId, businessId));
  const hit =
    existing.find((i) => (i.sku || "").toUpperCase() === sku.toUpperCase()) ||
    existing.find((i) => (i.name || "").toLowerCase() === name.toLowerCase() && i.category === MIX_RAW_CATEGORY);
  if (hit) return hit;
  await ensureInventoryItem({
    businessId, sku, name, category: MIX_RAW_CATEGORY, unit: "Kg",
    costPriceGhs: 0, sellingPriceGhs: 0, minStockThreshold: 25,
  });
  return ensureMixRawMaterial(businessId, name);
}

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
    // Scope gate: production, orders, deliveries and stock stay inside the
    // caller's accessible businesses (OWNER ⇒ all; others ⇒ assignment+grants).
    if (!(await canAccessBusiness(__authSession.user, businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }

    const [production, orders, deliveries, inventory, checklists, existingTypes, qcChecks,
      mixFormulations, mixFormulationItems, mixBatches, mixBatchInputs] = await Promise.all([
      db.select().from(blockFactoryLogs).where(eq(blockFactoryLogs.businessId, businessId)),
      db.select().from(blockFactoryOrders).where(eq(blockFactoryOrders.businessId, businessId)),
      db.select().from(blockFactoryDeliveries).where(eq(blockFactoryDeliveries.businessId, businessId)),
      db.select().from(inventoryItems).where(eq(inventoryItems.businessId, businessId)),
      db.select().from(blockFactoryChecklists).where(eq(blockFactoryChecklists.businessId, businessId)),
      db.select().from(blockTypes).where(eq(blockTypes.businessId, businessId)),
      db.select().from(blockQcChecks).where(eq(blockQcChecks.businessId, businessId)),
      db.select().from(blockMixFormulations).where(eq(blockMixFormulations.businessId, businessId)),
      db.select().from(blockMixFormulationItems),
      db.select().from(blockMixBatches).where(eq(blockMixBatches.businessId, businessId)),
      db.select().from(blockMixBatchInputs),
    ]);

    // The master list stays exactly as the operator has defined it (starts
    // empty — no sample types). Self-heal SKU links only for what exists.
    const types = existingTypes;

    // Self-heal master-list → inventory SKU links so Production, Restock and
    // Sales always credit one canonical stock row per block type.
    for (const t of types) {
      if (!t.sku) {
        await resolveBlockTypeItem(businessId, t.typeKey, { masterTypeRow: t });
      }
    }

    // Mix payload scoped to this business.
    const mixFormIds = new Set(mixFormulations.map((f: any) => f.id));
    const mixBatchIds = new Set(mixBatches.map((b: any) => b.id));
    return NextResponse.json({
      success: true,
      production: production.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)),
      orders: orders.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)),
      deliveries: deliveries.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)),
      inventory,
      checklists: checklists.sort((a: any, b: any) => (a.id || 0) - (b.id || 0)),
      blockTypes: types.sort((a: any, b: any) => (a.id || 0) - (b.id || 0)),
      qcChecks: qcChecks.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)),
      mixFormulations: mixFormulations.sort((a: any, b: any) => (a.id || 0) - (b.id || 0)),
      mixFormulationItems: mixFormulationItems.filter((i: any) => mixFormIds.has(i.formulationId)),
      mixBatches: mixBatches.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)),
      mixBatchInputs: mixBatchInputs.filter((i: any) => mixBatchIds.has(i.mixBatchId)),
      mixRawMaterials: inventory.filter((i: any) => i.category === MIX_RAW_CATEGORY),
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
      return NextResponse.json({ success: false, error: "entity and businessId required" }, { status: 400 });
    }
    if (!(await canAccessBusiness(__authSession.user, businessId))) {
      return FORBIDDEN("You do not have access to that business.");
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

      // Duplicate-check against the operator's own master list (starts empty).
      const existing = await db.select().from(blockTypes).where(eq(blockTypes.businessId, businessId));
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
      // Optional: consume one RELEASED mixer batch for this run (Mixing tab).
      // Validates BEFORE any write; 1:1 — a consumed mixer batch can never be
      // re-used; block types must match (a 6in recipe cannot feed an 8in run).
      let consumedMix: any = null;
      const mixBatchId = Number(data.mixBatchId) || 0;
      if (mixBatchId > 0) {
        const [mix] = await db.select().from(blockMixBatches).where(
          and(eq(blockMixBatches.id, mixBatchId), eq(blockMixBatches.businessId, businessId)));
        if (!mix) {
          return NextResponse.json({ success: false, error: "Mixer batch not found for this branch." }, { status: 404 });
        }
        if (mix.status === "CONSUMED") {
          return NextResponse.json({
            success: false,
            error: `Mixer batch ${mix.mixBatchNumber} is already consumed${mix.consumedProductionBatch ? ` (production ${mix.consumedProductionBatch})` : ""}.`,
            code: "MIX_ALREADY_CONSUMED",
          }, { status: 409 });
        }
        if (mix.status !== "RELEASED") {
          return NextResponse.json({
            success: false,
            error: `Mixer batch ${mix.mixBatchNumber} is ${mix.status} — pass MIXING-stage QC and release it first.`,
            code: "MIX_NOT_RELEASED",
          }, { status: 409 });
        }
        if (mix.blockType !== blockType) {
          return NextResponse.json({
            success: false,
            error: `Mixer batch ${mix.mixBatchNumber} was mixed for ${mix.blockType}, not ${blockType} — block type must match.`,
            code: "MIX_TYPE_MISMATCH",
          }, { status: 400 });
        }
        consumedMix = mix;
      }
      const [row] = await db.insert(blockFactoryLogs).values({
        businessId,
        batchId: data.batchId || `BLK-PROD-${Date.now().toString().slice(-5)}`,
        blockType,
        bagsCementUsed: Number(data.bagsCementUsed) || 0,
        blocksMolded,
        blocksBroken,
        qualityGrade: data.qualityGrade || "GRADE_A_STANDARD",
        recordedDate: data.recordedDate || today,
        mixBatchId: consumedMix ? consumedMix.id : null,
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

      // Mark the consumed mixer batch + link economics + audit trail.
      if (consumedMix) {
        const me = __authSession.user;
        const [upd] = await db.update(blockMixBatches).set({
          status: "CONSUMED",
          consumedProductionLogId: row.id,
          consumedProductionBatch: row.batchId,
          consumedAt: new Date(),
        }).where(eq(blockMixBatches.id, consumedMix.id)).returning();
        const orgId = await ownerOrgOfBusiness(businessId).catch(() => null);
        await auditLog(me, "BLOCK_MIX_CONSUMED", "RECORD", `Mixer batch ${consumedMix.mixBatchNumber} → production ${row.batchId}`,
          "OPERATION_LOG", consumedMix.id, businessId, branchCode,
          `Production run ${row.batchId} (${goodBlocks.toLocaleString()} good ${blockType} blocks) consumed mixer batch ${consumedMix.mixBatchNumber} (${consumedMix.actualOutputKg} kg · GH₵ ${(consumedMix.totalCostGhs || 0).toFixed(2)}) — 1:1.`,
          orgId ?? null).catch((e: any) => console.error("[block-mix] audit failed:", e));
        consumedMix = upd || consumedMix;
      }

      return NextResponse.json({ success: true, item: row, stock, mix: consumedMix });
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
      const trxNum = nextTrxNumber();
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
      // MIXING-stage checks may bind EITHER a production log batch
      // (BLK-PROD-…) OR a mixer batch (MXB-…) — mixer batches were added with
      // the Mixing tab; the existing production behaviour is unchanged.
      let batchRow: any = null;
      let mixRow: any = null;
      const batchId = data.batchId ? String(data.batchId).trim() : null;
      if (batchId) {
        const [found] = await db
          .select()
          .from(blockFactoryLogs)
          .where(and(eq(blockFactoryLogs.businessId, businessId), eq(blockFactoryLogs.batchId, batchId)))
          .limit(1);
        if (!found) {
          if (stage === "MIXING") {
            const [mix] = await db
              .select()
              .from(blockMixBatches)
              .where(and(eq(blockMixBatches.businessId, businessId), eq(blockMixBatches.mixBatchNumber, batchId)))
              .limit(1);
            if (!mix) {
              return NextResponse.json(
                { success: false, error: `Batch ${batchId} not found for this business` },
                { status: 404 },
              );
            }
            mixRow = mix;
          } else {
            return NextResponse.json(
              { success: false, error: `Batch ${batchId} not found for this business` },
              { status: 404 },
            );
          }
        } else batchRow = found;
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
        branchCode: data.branchCode || batchRow?.branchCode || mixRow?.branchCode || branchCode,
        stage,
        batchId: batchId || null,
        batchNumber: batchId || null,
        blockType: batchRow?.blockType || mixRow?.blockType || data.blockType || null,
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
      // Supplier ledger link (feed-mill pattern, shared via supplierLinks):
      // naming a vendor on a restock creates/refreshes that supplier org-wide.
      const supName = String(data.supplierName || "").trim().slice(0, 120);
      if (supName) {
        const orgId = await ownerOrgOfBusiness(businessId).catch(() => null);
        await linkSupplier({
          ownerId: orgId ?? (biz as any)?.ownerId ?? null,
          name: supName, category: MIX_SUPPLIER_CATEGORY,
          suppliedGhs: totalCost, paymentMethod: data.paymentMethod, logTag: "[block-factory]",
        });
      }
      if (data.recordExpense && totalCost > 0) {
        const trxNum = nextTrxNumber();
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

    // ── MIX_FORMULATION (mix recipe bound to the block-type master list) ──
    if (entity === "MIX_FORMULATION") {
      const me = __authSession.user;
      const orgId = await ownerOrgOfBusiness(businessId).catch(() => null);
      const name = String(data.name || "").trim().slice(0, 120);
      if (!name) return NextResponse.json({ success: false, error: "Recipe name is required." }, { status: 400 });
      const blockType = String(data.blockType || "").trim();
      if (!blockType) return NextResponse.json({ success: false, error: "Choose the block type this recipe mixes for." }, { status: 400 });
      // Must be one of this business's master-list types (additive hooks into
      // the existing master list — never duplicates/blockTypes of its own).
      const [bt] = await db.select().from(blockTypes).where(
        and(eq(blockTypes.businessId, businessId), eq(blockTypes.typeKey, blockType))).limit(1);
      if (!bt) {
        return NextResponse.json({
          success: false,
          error: `Block type ${blockType} is not on this branch's master list — add it under Production first.`,
          code: "MIX_TYPE_UNKNOWN",
        }, { status: 400 });
      }
      const items: any[] = Array.isArray(data.items) ? data.items : [];
      if (!items.length) return NextResponse.json({ success: false, error: "Add at least one material line." }, { status: 400 });
      const normalized = items.map((it, i) => ({
        ingredientName: String(it.ingredientName || "").trim().slice(0, 120),
        sharePct: Number(it.sharePct) || 0,
        sequence: i,
        inventoryId: it.inventoryId != null ? Number(it.inventoryId) : null,
      }));
      if (normalized.some((it) => !it.ingredientName || it.sharePct <= 0)) {
        return NextResponse.json({ success: false, error: "Every material line needs a name and a positive share %." }, { status: 400 });
      }
      const sumShare = normalized.reduce((s, it) => s + it.sharePct, 0);
      if (Math.abs(sumShare - 100) > 0.5) {
        return NextResponse.json({ success: false, error: `Shares must total 100% (they add to ${sumShare.toFixed(1)}%).` }, { status: 400 });
      }
      const existing = await db.select().from(blockMixFormulations).where(eq(blockMixFormulations.businessId, businessId));
      if (existing.some((f) => f.name.trim().toLowerCase() === name.toLowerCase())) {
        return NextResponse.json({ success: false, error: `\"${name}\" already exists for this branch.` }, { status: 409 });
      }
      const resolved: any[] = [];
      for (const it of normalized) {
        let inv: any = null;
        if (it.inventoryId != null) {
          const [found] = await db.select().from(inventoryItems).where(
            and(eq(inventoryItems.id, it.inventoryId), eq(inventoryItems.businessId, businessId)));
          if (!found) return NextResponse.json({ success: false, error: `Material \"${it.ingredientName}\": inventory item not found in this branch.` }, { status: 400 });
          inv = found;
        } else {
          inv = await ensureMixRawMaterial(businessId, it.ingredientName);
        }
        resolved.push({ ...it, inventoryId: inv.id, sku: inv.sku });
      }
      const formulationNo = `MIX-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
      const [form] = await db.insert(blockMixFormulations).values({
        businessId, branchCode, ownerId: orgId ?? null,
        formulationNo,
        name,
        blockType,
        designNote: data.designNote != null ? String(data.designNote).slice(0, 200) : null,
        waterCementRatio: data.waterCementRatio != null && data.waterCementRatio !== "" ? Number(data.waterCementRatio) : null,
        batchSizeKg: Number(data.batchSizeKg) || 800,
        notes: data.notes || null,
        active: true,
        version: 1,
        createdByName: me.name || null,
        createdByRole: me.role || null,
      }).returning();
      for (const it of resolved.slice(0, 40)) {
        await db.insert(blockMixFormulationItems).values({
          formulationId: form.id,
          inventoryId: it.inventoryId,
          ingredientName: it.ingredientName,
          sku: it.sku,
          sharePct: it.sharePct,
          sequence: it.sequence,
        });
      }
      await auditLog(me, "BLOCK_MIX_FORMULATION_CREATE", "RECORD", `Mix recipe ${form.formulationNo} (${form.name})`, "OPERATION_LOG", form.id,
        businessId, branchCode,
        `New mix recipe \"${form.name}\" for ${form.blockType} · ${resolved.length} materials (Σ ${sumShare}%) · batch ${form.batchSizeKg} kg${form.waterCementRatio ? ` · w/c ${form.waterCementRatio}` : ""}.`,
        orgId ?? null).catch((e: any) => console.error("[block-mix] audit failed:", e));
      return NextResponse.json({ success: true, item: form });
    }

    // ── MIX (run the mixer: BOM draw + water → mixer batch on QC_HOLD) ──
    if (entity === "MIX") {
      const me = __authSession.user;
      const orgId = await ownerOrgOfBusiness(businessId).catch(() => null);
      const formId = Number(data.formulationId) || 0;
      const [form] = await db.select().from(blockMixFormulations).where(
        and(eq(blockMixFormulations.id, formId), eq(blockMixFormulations.businessId, businessId)));
      if (!form) return NextResponse.json({ success: false, error: "Choose a recipe to mix." }, { status: 400 });
      if (form.active === false) {
        return NextResponse.json({ success: false, error: `Recipe \"${form.name}\" is deactivated — reactivate it to mix.` }, { status: 400 });
      }
      const bom = await db.select().from(blockMixFormulationItems).where(eq(blockMixFormulationItems.formulationId, form.id));
      if (!bom.length) return NextResponse.json({ success: false, error: "That recipe has no material lines. Edit it first." }, { status: 400 });

      const plannedInputKg = Number(data.plannedInputKg ?? form.batchSizeKg) || form.batchSizeKg;
      if (!(plannedInputKg > 0)) return NextResponse.json({ success: false, error: "planned input must be greater than 0" }, { status: 400 });
      const waterLitres = data.waterLitresUsed != null && data.waterLitresUsed !== "" ? Number(data.waterLitresUsed) : null;

      // Draw plan with cost snapshots — validate ALL stock before any write.
      const invAll = await db.select().from(inventoryItems).where(eq(inventoryItems.businessId, businessId));
      const byId = new Map(invAll.map((i: any) => [i.id, i]));
      const plan: any[] = [];
      let actualInputKg = 0;
      let ingredientCost = 0;
      for (const line of bom) {
        const item: any = (line as any).inventoryId != null ? byId.get((line as any).inventoryId) : null;
        if (!item) {
          return NextResponse.json({ success: false, error: `Material \"${(line as any).ingredientName}\" is not linked to a stock item — fix the recipe.` }, { status: 400 });
        }
        const plannedKg = r3(((line as any).sharePct || 0) / 100 * plannedInputKg);
        const actualKg = plannedKg;
        if (plannedKg > 0 && (item.quantity || 0) + 1e-9 < actualKg) {
          return NextResponse.json({
            success: false,
            error: `Insufficient stock for ${(line as any).ingredientName}: need ${actualKg} kg, have ${(item.quantity || 0).toFixed(1)} kg. Restock first.`,
            code: "INSUFFICIENT_STOCK",
          }, { status: 400 });
        }
        const unitCost = Number(item.costPriceGhs) || 0;
        const lineCost = r2(actualKg * unitCost);
        plan.push({ line, item, plannedKg, actualKg, unitCost, lineCost });
        actualInputKg += actualKg;
        ingredientCost += lineCost;
      }

      // Output: wet mass = materials + water by default (1 L ≈ 1 kg); explicit
      // actualOutputKg may override (weighbridge reading).
      const defaultOutput = r3(actualInputKg + (waterLitres || 0));
      const actualOutputKg = data.actualOutputKg != null && data.actualOutputKg !== ""
        ? Number(data.actualOutputKg) || 0
        : defaultOutput;
      if (!(actualOutputKg > 0)) return NextResponse.json({ success: false, error: "actual output kg is required (or record water used)." }, { status: 400 });
      // Physical sanity first — output cannot exceed (materials + water) mass
      // beyond scale rounding. Refuse before any stock move.
      const upperBound = (actualInputKg + (waterLitres || 0)) * 1.02;
      if (actualOutputKg > upperBound) {
        return NextResponse.json({
          success: false,
          error: `Output (${actualOutputKg} kg) exceeds materials+water mass (${r2(actualInputKg + (waterLitres || 0))} kg) — re-check figures.`,
          code: "IMPOSSIBLE_YIELD",
        }, { status: 400 });
      }
      for (const p of plan) {
        if (p.actualKg > 0) await stockOut({ businessId, inventoryId: p.item.id, quantity: p.actualKg });
      }

      const labour = Number(data.labourCostGhs) || 0;
      const overhead = Number(data.overheadCostGhs) || 0;
      const totalCost = r2(ingredientCost + labour + overhead);
      const costPerKg = actualOutputKg > 0 ? Math.round((totalCost / actualOutputKg) * 1000) / 1000 : 0;
      const mixBatchNumber = `MXB-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
      const [batch] = await db.insert(blockMixBatches).values({
        businessId, branchCode, ownerId: orgId ?? null,
        mixBatchNumber,
        formulationId: form.id,
        formulationName: form.name,
        formulationSnapshot: { header: form, bom: bom.map((l: any) => ({ ...l })) },
        blockType: form.blockType,
        productionDate: data.productionDate || today,
        status: "QC_HOLD",
        plannedInputKg,
        actualInputKg: r3(actualInputKg),
        waterLitresUsed: waterLitres,
        actualOutputKg,
        slumpMm: data.slumpMm != null && data.slumpMm !== "" ? Number(data.slumpMm) : null,
        ingredientCostGhs: r2(ingredientCost),
        labourCostGhs: labour,
        overheadCostGhs: overhead,
        totalCostGhs: totalCost,
        costPerKgGhs: costPerKg,
        operatorName: data.operatorName || null,
        notes: data.notes || null,
        recordedByName: me.name || null,
        recordedByRole: me.role || null,
        recordedByUserId: Number(me.id) || null,
      }).returning();
      for (const p of plan) {
        if (!(p.actualKg > 0)) continue;
        await db.insert(blockMixBatchInputs).values({
          mixBatchId: batch.id,
          inventoryId: p.item.id,
          ingredientName: (p.line as any).ingredientName,
          sku: p.item.sku,
          plannedKg: p.plannedKg,
          actualKg: p.actualKg,
          unitCostGhs: p.unitCost,
          lineCostGhs: p.lineCost,
        });
      }
      let opsExpense = null;
      if (labour + overhead > 0) {
        opsExpense = await postMixExpense(me, {
          businessId, branchCode, branchName, category: MIX_OPS_CATEGORY,
          amountGhs: labour + overhead,
          paymentMethod: data.paymentMethod || "CASH",
          description: `Mixed batch ${mixBatchNumber} operations (labour GH₵ ${labour.toFixed(2)} + overhead GH₵ ${overhead.toFixed(2)}) — material cost derived from stock draw.`,
          date: data.productionDate || today,
        });
      }
      await db.update(blockMixFormulations)
        .set({ lastCostPerKgGhs: costPerKg, lastProducedAt: new Date(), updatedAt: new Date() })
        .where(eq(blockMixFormulations.id, form.id));
      await auditLog(me, "BLOCK_MIX_BATCH_PRODUCED", "RECORD", `Mixer batch ${mixBatchNumber}`, "OPERATION_LOG", batch.id,
        businessId, branchCode,
        `Mixed ${actualOutputKg} kg of \"${form.name}\" (${form.blockType}) from ${plan.filter((p) => p.actualKg > 0).length} materials${waterLitres != null ? ` + ${waterLitres} L water` : ""}; cost GH₵ ${totalCost.toFixed(2)} (${costPerKg.toFixed(2)}/kg); on QC hold.`,
        orgId ?? null).catch((e: any) => console.error("[block-mix] audit failed:", e));
      const fullInputs = await db.select().from(blockMixBatchInputs).where(eq(blockMixBatchInputs.mixBatchId, batch.id));
      return NextResponse.json({ success: true, item: batch, inputs: fullInputs, opsExpense });
    }

    // ── MIX_RELEASE (QC gate → consumable by production) ──
    if (entity === "MIX_RELEASE") {
      const me = __authSession.user;
      const orgId = await ownerOrgOfBusiness(businessId).catch(() => null);
      const mixBatchId = Number(data.mixBatchId) || 0;
      const [batch] = await db.select().from(blockMixBatches).where(
        and(eq(blockMixBatches.id, mixBatchId), eq(blockMixBatches.businessId, businessId)));
      if (!batch) return NextResponse.json({ success: false, error: "Mixer batch not found for this branch." }, { status: 404 });
      if (batch.status !== "QC_HOLD" && batch.status !== "MIXING") {
        return NextResponse.json({ success: false, error: `Mixer batch ${batch.mixBatchNumber} is ${batch.status}, not on QC hold.` }, { status: 400 });
      }
      // Gate: a PASS at the MIXING stage bound to THIS batch (batch_id), or an
      // OWNER / records-authorized override with a written note.
      const checks = await db.select().from(blockQcChecks).where(
        and(eq(blockQcChecks.businessId, businessId), eq(blockQcChecks.stage, "MIXING"), eq(blockQcChecks.batchId, batch.mixBatchNumber)));
      const passedQc = checks.some((c: any) => c.passFail === "PASS");
      const anyFail = checks.some((c: any) => c.passFail === "FAIL");
      const note = String(data.note || "").trim().slice(0, 300);
      const mayOverride = me.role === "OWNER" || me.canManageRecords === true;
      let basis: string;
      if (passedQc) {
        basis = note ? `Released on MIXING-stage QC pass. ${note}` : "Released on MIXING-stage QC pass.";
      } else if (mayOverride && note) {
        basis = `OWNER OVERRIDE RELEASE (no MIXING-stage PASS on record): ${note}`;
      } else {
        return NextResponse.json({
          success: false,
          error: `QC gate: mixer batch ${batch.mixBatchNumber} has no MIXING-stage PASS check${anyFail ? " and carries a FAILED check" : ""}. Record the MIXING QC first — or have the OWNER / a records-authorized manager override with a written reason.`,
          code: "QC_GATE",
        }, { status: 400 });
      }
      const [released] = await db.update(blockMixBatches).set({
        status: "RELEASED",
        releasedAt: new Date(),
        releasedByName: me.name || null,
        releaseNote: basis,
      }).where(eq(blockMixBatches.id, batch.id)).returning();
      await auditLog(me, "BLOCK_MIX_BATCH_RELEASE", "RECORD", `Mixer batch ${batch.mixBatchNumber} released`,
        "OPERATION_LOG", batch.id, businessId, branchCode, basis, orgId ?? null)
        .catch((e: any) => console.error("[block-mix] audit failed:", e));
      await mixBell({
        businessId, branchCode,
        type: "BLOCK_MIX_BATCH_RELEASED",
        title: `Mixer batch ${batch.mixBatchNumber} released`,
        body: `${batch.actualOutputKg} kg of \"${batch.formulationName}\" (${batch.blockType}) is now consumable by a production run${basis.startsWith("OWNER OVERRIDE") ? " — released by owner override" : ""}.`,
        recordType: "OPERATION_LOG", recordId: batch.id, recordRef: batch.mixBatchNumber,
      });
      return NextResponse.json({ success: true, item: released });
    }

    // ── MIX_REJECT (terminal; OWNER / records-authorized; optional recovery) ──
    if (entity === "MIX_REJECT") {
      const me = __authSession.user;
      const orgId = await ownerOrgOfBusiness(businessId).catch(() => null);
      const mayReject = me.role === "OWNER" || me.canManageRecords === true;
      if (!mayReject) {
        return NextResponse.json({ success: false, error: "Only the OWNER (or a records-authorized manager) may reject a mixer batch." }, { status: 403 });
      }
      const reason = String(data.reason || "").trim().slice(0, 300);
      if (!reason) return NextResponse.json({ success: false, error: "A rejection reason is required (it goes on the audit record)." }, { status: 400 });
      const mixBatchId = Number(data.mixBatchId) || 0;
      const [batch] = await db.select().from(blockMixBatches).where(
        and(eq(blockMixBatches.id, mixBatchId), eq(blockMixBatches.businessId, businessId)));
      if (!batch) return NextResponse.json({ success: false, error: "Mixer batch not found for this branch." }, { status: 404 });
      if (batch.status !== "QC_HOLD" && batch.status !== "MIXING") {
        return NextResponse.json({ success: false, error: `Only mixer batches on QC hold can be rejected (${batch.mixBatchNumber} is ${batch.status}).` }, { status: 400 });
      }
      // Dry-draw recovery (default): materials never cured → returned to raw
      // stock EXACTLY as drawn. recoverMaterials:false = spoiled wet mix
      // discarded — stock stays where it is.
      const recover = data.recoverMaterials !== false;
      let recoveredKg = 0;
      const draws = await db.select().from(blockMixBatchInputs).where(eq(blockMixBatchInputs.mixBatchId, batch.id));
      if (recover) {
        for (const d of draws) {
          if ((d as any).actualKg > 0) {
            const [item] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, (d as any).inventoryId));
            if (item) {
              const newQty = r3((item.quantity || 0) + (d as any).actualKg);
              await db.update(inventoryItems)
                .set({ quantity: newQty, status: computeStockStatus(newQty, item.minStockThreshold || 0) })
                .where(eq(inventoryItems.id, item.id));
              recoveredKg = r3(recoveredKg + (d as any).actualKg);
            }
          }
        }
      }
      const [rejected] = await db.update(blockMixBatches).set({
        status: "REJECTED",
        releasedAt: new Date(),
        releasedByName: me.name || null,
        releaseNote: `REJECTED: ${reason}${recover ? ` (recovered ${recoveredKg} kg of raw materials to stock)` : " (wet mix discarded — no stock recovery)"}`,
      }).where(eq(blockMixBatches.id, batch.id)).returning();
      await auditLog(me, "BLOCK_MIX_BATCH_REJECT", "RECORD", `Mixer batch ${batch.mixBatchNumber} rejected`,
        "OPERATION_LOG", batch.id, businessId, branchCode,
        `${reason} — ${recover ? `${recoveredKg} kg of raw materials recovered to stock` : "materials discarded"}.`,
        orgId ?? null).catch((e: any) => console.error("[block-mix] audit failed:", e));
      await mixBell({
        businessId, branchCode,
        type: "BLOCK_MIX_BATCH_REJECTED",
        title: `Mixer batch ${batch.mixBatchNumber} rejected`,
        body: `${me.name || "Management"} rejected ${batch.actualOutputKg} kg of \"${batch.formulationName}\": ${reason}.${recover ? ` ${recoveredKg} kg of materials recovered.` : ""}`,
        recordType: "OPERATION_LOG", recordId: batch.id, recordRef: batch.mixBatchNumber,
        priority: "HIGH",
      });
      return NextResponse.json({ success: true, item: rejected, recoveredKg });
    }


    return NextResponse.json({ success: false, error: "Unknown entity" }, { status: 400 });
  } catch (error: any) {
    return apiError(error);
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
      if (!(await canAccessBusiness(__authSession.user, existing.businessId))) {
        return FORBIDDEN("You do not have access to that business.");
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

    if (entity === "MIX_FORMULATION" && id) {
      const me = __authSession.user;
      const businessId = Number(data?.businessId);
      if (!businessId) return NextResponse.json({ success: false, error: "businessId required" }, { status: 400 });
      if (!(await canAccessBusiness(me, businessId))) {
        return FORBIDDEN("You do not have access to that business.");
      }
      const [form] = await db.select().from(blockMixFormulations).where(
        and(eq(blockMixFormulations.id, Number(id)), eq(blockMixFormulations.businessId, businessId)));
      if (!form) return NextResponse.json({ success: false, error: "Recipe not found." }, { status: 404 });

      const set: any = { updatedAt: new Date() };
      if (data.name !== undefined && String(data.name).trim()) set.name = String(data.name).trim().slice(0, 120);
      if (data.designNote !== undefined) set.designNote = data.designNote || null;
      if (data.notes !== undefined) set.notes = data.notes || null;
      if (data.batchSizeKg !== undefined) set.batchSizeKg = Number(data.batchSizeKg) || form.batchSizeKg;
      if (data.waterCementRatio !== undefined) set.waterCementRatio = data.waterCementRatio === "" || data.waterCementRatio === null ? null : Number(data.waterCementRatio);
      if (data.blockType !== undefined && String(data.blockType).trim()) {
        // Re-binding is allowed only to another type on the master list.
        const [bt] = await db.select().from(blockTypes).where(
          and(eq(blockTypes.businessId, businessId), eq(blockTypes.typeKey, String(data.blockType).trim()))).limit(1);
        if (!bt) return NextResponse.json({ success: false, error: `Block type ${data.blockType} is not on the master list.` }, { status: 400 });
        set.blockType = String(data.blockType).trim();
      }
      if (data.active !== undefined) {
        if (data.active === false && !(me.role === "OWNER" || (me as any).canManageRecords)) {
          return NextResponse.json({ success: false, error: "Only the OWNER (or a records-authorized manager) may deactivate a recipe." }, { status: 403 });
        }
        set.active = data.active === true;
      }
      const [updated] = await db.update(blockMixFormulations).set(set)
        .where(eq(blockMixFormulations.id, form.id)).returning();

      // BOM replacement (validate all lines BEFORE touching the old BOM).
      let bomReplaced = false;
      if (Array.isArray(data.items)) {
        const items: any[] = data.items;
        if (!items.length) return NextResponse.json({ success: false, error: "Add at least one material line." }, { status: 400 });
        const normalized = items.map((it, i) => ({
          ingredientName: String(it.ingredientName || "").trim().slice(0, 120),
          sharePct: Number(it.sharePct) || 0,
          sequence: i,
          inventoryId: it.inventoryId != null ? Number(it.inventoryId) : null,
        }));
        const sumShare = normalized.reduce((s, it) => s + it.sharePct, 0);
        if (Math.abs(sumShare - 100) > 0.5) {
          return NextResponse.json({ success: false, error: `Shares must total 100% (they add to ${sumShare.toFixed(1)}%).` }, { status: 400 });
        }
        if (normalized.some((it) => !it.ingredientName || it.sharePct <= 0)) {
          return NextResponse.json({ success: false, error: "Every material line needs a name and a positive share %." }, { status: 400 });
        }
        const resolved: any[] = [];
        for (const it of normalized.slice(0, 40)) {
          let inv: any = null;
          if (it.inventoryId != null) {
            const [found] = await db.select().from(inventoryItems).where(
              and(eq(inventoryItems.id, Number(it.inventoryId)), eq(inventoryItems.businessId, businessId)));
            if (!found) return NextResponse.json({ success: false, error: `Material "${it.ingredientName}": inventory item not found.` }, { status: 400 });
            inv = found;
          } else {
            inv = await ensureMixRawMaterial(businessId, it.ingredientName);
          }
          resolved.push({ ...it, inventoryId: inv.id, sku: inv.sku });
        }
        await db.delete(blockMixFormulationItems).where(eq(blockMixFormulationItems.formulationId, form.id));
        for (const it of resolved) {
          await db.insert(blockMixFormulationItems).values({
            formulationId: form.id, inventoryId: it.inventoryId, ingredientName: it.ingredientName,
            sku: it.sku, sharePct: it.sharePct, sequence: it.sequence,
          });
        }
        await db.update(blockMixFormulations).set({ version: (form.version || 1) + 1 })
          .where(eq(blockMixFormulations.id, form.id));
        bomReplaced = true;
      }

      const orgId = await ownerOrgOfBusiness(businessId).catch(() => null);
      await auditLog(me, "BLOCK_MIX_FORMULATION_UPDATE", "RECORD", `Mix recipe ${updated.name}`,
        "OPERATION_LOG", form.id, businessId, form.branchCode ?? null,
        `Updated mix recipe ${updated.formulationNo}${bomReplaced ? ` incl. BOM replacement to v${(form.version || 1) + 1}` : ""}${data.active !== undefined ? `; active=${!!set.active}` : ""}.`,
        orgId ?? form.ownerId ?? null).catch((e: any) => console.error("[block-mix] audit failed:", e));
      return NextResponse.json({ success: true, item: updated });
    }


    return NextResponse.json({ success: false, error: "Unknown entity" }, { status: 400 });
  } catch (error: any) {
    return apiError(error);
  }
}
