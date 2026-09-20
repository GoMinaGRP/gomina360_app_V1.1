import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import {
  fishFeedFormulations,
  fishFeedFormulationItems,
  fishFeedBatches,
  fishFeedBatchInputs,
  fishFeedQcChecks,
  aquacultureFeedLogs,
  aquaculturePonds,
  aquacultureBatches,
  aquacultureWeightLogs,
  businesses,
  transactions,
  inventoryItems,
  notifications,
} from "@/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { ensureInventoryItem, stockIn, stockOut, computeStockStatus } from "@/lib/stock";
import { linkSupplier } from "@/lib/supplierLinks";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED } from "@/lib/auth";
import { apiError } from "@/lib/apiError";
import { auditLog } from "@/lib/audit";
import { feedToKg } from "@/lib/feedUnits";
import { ownerOrgOfBusiness, orderNotificationRecipients } from "@/lib/notify";
import { pushToUsers, urlForNotification } from "@/lib/push";

/**
 * FISH FEED PRODUCTION & MILLING — sub-module of Aquaculture (fish farm).
 * Mirror of the poultry feed-mill architecture with aquaculture specifics:
 * species & feeding stage, FLOATING/SINKING class, pellet size, float-test
 * and water-stability QC.
 * Entities (POST `entity`):
 *   FORMULATION  create recipe (+BOM, raw-material items auto-linked to stock)
 *   INTAKE       one-step raw-material intake → stock-in + optional EXPENSE
 *   BATCH        production run → ingredient draw (stock-out), cost engine,
 *                finished-feed stock-in (status QC_HOLD)
 *   QC           per-batch / per-stage QC check (FAIL alerts the bell)
 *   RELEASE      QC gate → batch becomes consumable (PASS FINISHED_FEED
 *                required; OWNER / canManageRecords may override with note)
 *   REJECT       terminal: reverses remaining stock-in (OWNER-granted power)
 *   CONSUMPTION  own-mill pond feeding → typed aquaculture_feed_logs row +
 *                stock-out (NO transaction — single-booking rule)
 * PATCH entity FORMULATION — edit header / replace BOM / activate-toggle.
 *
 * FINANCE INVARIANT: the only EXPENSE transactions ever written here are
 * (a) raw-material intake cost (optional, once) and (b) one
 * AQUA_FEED_MILL_OPS row per batch covering labour+overhead. Ingredient
 * draw costs are DERIVED snapshots; consumption NEVER books money.
 */

const RAW_CATEGORY = "Fish Feed Raw Materials";
const MILL_CATEGORY = "Fish Feed (Milled)";
const EXP_CAT_INTAKE = "AQUA_FEED_RAW_MATERIAL";
const EXP_CAT_OPS = "AQUA_FEED_MILL_OPS";

const slugify = (s: string) =>
  (s || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "ITEM";
const dash = (s: string) => slugify(s).replace(/_/g, "-");
const todayStr = () => new Date().toISOString().split("T")[0];
const trxNum = () => `TRX-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;

async function postExpense(me: any, opts: {
  businessId: number; branchCode: string | null; branchName: string | null;
  category: string; amountGhs: number; paymentMethod: string; description: string; date: string;
}) {
  if (!(opts.amountGhs > 0)) return null;
  const [row] = await db.insert(transactions).values({
    transactionNumber: trxNum(),
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
    recordedBy: me.name || "Feed Mill User",
    recordedByRole: me.role || null,
    recordedByUserId: Number(me.id) || null,
  }).returning();
  return row;
}

/** Bell + push fan-out for mill events (never blocks the write itself). */
async function millBell({ businessId, branchCode, type, title, body, recordType, recordId, recordRef, priority = null as string | null }: {
  businessId: number; branchCode: string | null; type: string; title: string; body: string;
  recordType: string; recordId: number; recordRef: string; priority?: string | null;
}) {
  try {
    const recipients = await orderNotificationRecipients(businessId);
    const ownerOrg = await ownerOrgOfBusiness(businessId);
    const url = urlForNotification(type, { branchCode });
    const ids: number[] = [];
    for (const u of recipients) {
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
    return ids.length;
  } catch (e) {
    console.error("[fish-mill] millBell failed:", e);
    return 0;
  }
}

/** Resolve (or auto-create) the raw-material inventory item for an ingredient. */
async function ensureRawMaterial(businessId: number, name: string) {
  const sku = `FISH-RM-${dash(name)}`;
  const existing = await db.select().from(inventoryItems).where(eq(inventoryItems.businessId, businessId));
  const hit =
    existing.find((i) => (i.sku || "").toUpperCase() === sku.toUpperCase()) ||
    existing.find((i) => (i.name || "").toLowerCase() === name.toLowerCase() && i.category === RAW_CATEGORY);
  if (hit) return hit;
  await ensureInventoryItem({
    businessId, sku, name, category: RAW_CATEGORY, unit: "Kg",
    costPriceGhs: 0, sellingPriceGhs: 0, minStockThreshold: 25,
  });
  return ensureRawMaterial(businessId, name); // re-read consistent row
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    ttlInvalidate("init");
    if (!session) return UNAUTHENTICATED();
    const bizId = Number(new URL(request.url).searchParams.get("businessId"));
    if (!bizId) return NextResponse.json({ success: false, error: "businessId is required" }, { status: 400 });
    if (!(await canAccessBusiness(session.user, bizId))) {
      return NextResponse.json({ success: false, error: "You do not have access to that business." }, { status: 403 });
    }

    const [forms, formItems, batches, inputs, qc, feedRows, invRows, ponds, fishBatches, weightRows] = await Promise.all([
      db.select().from(fishFeedFormulations).where(eq(fishFeedFormulations.businessId, bizId)),
      db.select().from(fishFeedFormulationItems),
      db.select().from(fishFeedBatches).where(eq(fishFeedBatches.businessId, bizId)).orderBy(desc(fishFeedBatches.id)),
      db.select().from(fishFeedBatchInputs),
      db.select().from(fishFeedQcChecks).where(eq(fishFeedQcChecks.businessId, bizId)).orderBy(desc(fishFeedQcChecks.id)),
      db.select().from(aquacultureFeedLogs).where(eq(aquacultureFeedLogs.businessId, bizId)).orderBy(desc(aquacultureFeedLogs.id)),
      db.select().from(inventoryItems).where(eq(inventoryItems.businessId, bizId)),
      db.select().from(aquaculturePonds).where(eq(aquaculturePonds.businessId, bizId)),
      db.select().from(aquacultureBatches).where(eq(aquacultureBatches.businessId, bizId)),
      // growth sampling feeds the FEEDOUT biomass/FCR insight client-side.
      db.select().from(aquacultureWeightLogs).where(eq(aquacultureWeightLogs.businessId, bizId)).orderBy(desc(aquacultureWeightLogs.id)),
    ]);

    const batchIds = new Set(batches.map((b) => b.id));
    const millInputs = inputs.filter((i) => batchIds.has(i.batchId));
    const formIds = new Set(forms.map((f) => f.id));
    const millFormItems = formItems.filter((i) => formIds.has(i.formulationId));
    const rawMaterials = invRows.filter((i) => i.category === RAW_CATEGORY);
    const finishedFeeds = invRows.filter((i) => i.category === MILL_CATEGORY);
    const consumption = feedRows.filter((f) => f.sourceType === "OWN_MILL");

    return NextResponse.json({
      success: true,
      formulations: forms.sort((a, b) => a.id - b.id),
      formulationItems: millFormItems,
      batches,
      batchInputs: millInputs,
      qcChecks: qc,
      rawMaterials,
      finishedFeeds,
      consumption,
      feedLogs: feedRows, // analytics (burn + purchase average) need purchases too
      ponds: ponds.filter((p) => p.status === "ACTIVE"),
      fishBatches: fishBatches.filter((b) => b.status === "ACTIVE"),
      weightLogs: weightRows.slice(0, 400), // FEEDOUT insight (biomass/FCR, client-side)
    });
  } catch (error: any) {
    console.error("GET /api/aquaculture/feed-mill error:", error);
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    ttlInvalidate("init");
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const body = await request.json();
    const entity = String(body.entity || "");
    const data = body.data || {};
    const businessId = Number(data.businessId);
    if (!businessId) return NextResponse.json({ success: false, error: "businessId is required" }, { status: 400 });
    if (!(await canAccessBusiness(me, businessId))) {
      return NextResponse.json({ success: false, error: "You do not have access to that business." }, { status: 403 });
    }
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    const branchCode = data.branchCode || biz?.code || null;
    const branchName = data.branchName || biz?.name || null;
    const orgId = await ownerOrgOfBusiness(businessId);
    const today = todayStr();

    // ── FORMULATION ──────────────────────────────────────────────────
    if (entity === "FORMULATION") {
      const name = String(data.name || "").trim().slice(0, 120);
      if (!name) return NextResponse.json({ success: false, error: "Formulation name is required." }, { status: 400 });
      const items: any[] = Array.isArray(data.items) ? data.items : [];
      if (!items.length) return NextResponse.json({ success: false, error: "Add at least one ingredient." }, { status: 400 });
      const normalized = items.map((it, i) => ({
        ingredientName: String(it.ingredientName || "").trim().slice(0, 120),
        sharePct: Number(it.sharePct) || 0,
        sequence: i,
        inventoryId: it.inventoryId != null ? Number(it.inventoryId) : null,
      }));
      if (normalized.some((it) => !it.ingredientName || it.sharePct <= 0)) {
        return NextResponse.json({ success: false, error: "Every ingredient needs a name and a positive share %." }, { status: 400 });
      }
      const sumShare = normalized.reduce((s, it) => s + it.sharePct, 0);
      if (Math.abs(sumShare - 100) > 0.5) {
        return NextResponse.json({ success: false, error: `Ingredients must total 100% (they add to ${sumShare.toFixed(1)}%).` }, { status: 400 });
      }
      const existing = await db.select().from(fishFeedFormulations).where(eq(fishFeedFormulations.businessId, businessId));
      if (existing.some((f) => f.name.trim().toLowerCase() === name.toLowerCase())) {
        return NextResponse.json({ success: false, error: `"${name}" already exists for this unit.` }, { status: 409 });
      }
      // Resolve each ingredient to a raw-material inventory item.
      const resolved: any[] = [];
      for (const it of normalized) {
        let inv: any = null;
        if (it.inventoryId != null) {
          const [found] = await db.select().from(inventoryItems).where(
            and(eq(inventoryItems.id, it.inventoryId), eq(inventoryItems.businessId, businessId)));
          if (!found) return NextResponse.json({ success: false, error: `Ingredient "${it.ingredientName}": inventory item not found in this unit.` }, { status: 400 });
          inv = found;
        } else {
          inv = await ensureRawMaterial(businessId, it.ingredientName);
        }
        resolved.push({ ...it, inventoryId: inv.id, sku: inv.sku });
      }
      const formulationNo = `FMM-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
      const [form] = await db.insert(fishFeedFormulations).values({
        businessId, branchCode, ownerId: orgId,
        formulationNo,
        name,
        species: ["TILAPIA","CATFISH","HETEROTIS","CARP","ALL"].includes(String(data.species||"").toUpperCase()) ? String(data.species).toUpperCase() : "TILAPIA",
        feedClass: String(data.feedClass||"").toUpperCase() === "SINKING" ? "SINKING" : "FLOATING",
        feedStage: ["FRY","STARTER","GROWER","FINISHER","BROODSTOCK"].includes(String(data.feedStage||"").toUpperCase()) ? String(data.feedStage).toUpperCase() : "GROWER",
        pelletMmTarget: data.pelletMmTarget != null && data.pelletMmTarget !== "" ? Number(data.pelletMmTarget) : null,
        batchSizeKg: Number(data.batchSizeKg) || 500,
        cpPctTarget: data.cpPctTarget != null && data.cpPctTarget !== "" ? Number(data.cpPctTarget) : null,
        commercialRefPriceGhs: data.commercialRefPriceGhs != null && data.commercialRefPriceGhs !== "" ? Number(data.commercialRefPriceGhs) : null,
        notes: data.notes || null,
        active: true,
        version: 1,
        createdByName: me.name || null,
        createdByRole: me.role || null,
      }).returning();
      for (const it of resolved.splice(0, 40)) {
        await db.insert(fishFeedFormulationItems).values({
          formulationId: form.id,
          inventoryId: it.inventoryId,
          ingredientName: it.ingredientName,
          sku: it.sku,
          sharePct: it.sharePct,
          sequence: it.sequence,
        });
      }
      await auditLog(me, "FISH_FEED_FORMULATION_CREATE", "RECORD", `Formulation ${form.formulationNo} (${form.name})`, "OPERATION_LOG", form.id,
        businessId, branchCode,
        `New fish-feed formulation "${form.name}" (${form.species} · ${form.feedClass} ${form.feedStage}${form.pelletMmTarget ? ` ${form.pelletMmTarget}mm` : ""}) · ${resolved.length} ingredients summing ${sumShare}% · batch size ${form.batchSizeKg} kg${form.commercialRefPriceGhs ? ` · commercial ref GH₵ ${form.commercialRefPriceGhs}/kg` : ""}.`,
        orgId);
      return NextResponse.json({ success: true, item: form });
    }

    // ── INTAKE (raw-material stock-in + optional expense — block-factory RESTOCK pattern)
    if (entity === "INTAKE") {
      const qtyKg = feedToKg(Number(data.qty) || 0, data.unit);
      if (!(qtyKg > 0)) return NextResponse.json({ success: false, error: "quantity must be greater than 0" }, { status: 400 });
      let item: any = null;
      if (data.inventoryId != null) {
        const [found] = await db.select().from(inventoryItems).where(
          and(eq(inventoryItems.id, Number(data.inventoryId)), eq(inventoryItems.businessId, businessId)));
        if (!found) return NextResponse.json({ success: false, error: "Inventory item not found for this branch" }, { status: 404 });
        item = found;
      } else {
        const itemName = String(data.itemName || "").trim().slice(0, 120);
        if (!itemName) return NextResponse.json({ success: false, error: "Select an ingredient or name a new one." }, { status: 400 });
        item = await ensureRawMaterial(businessId, itemName);
      }
      const unitCost = Number(data.unitCostGhs) || 0; // GH₵ per KG (convenience units convert on client)
      const totalCost = Number(data.totalCostGhs) || qtyKg * unitCost;
      const recordExpense = data.recordExpense !== false;
      // Permission gate BEFORE any mutation — a refused intake must leave no trace.
      if (recordExpense && !me.canRecordExpenses && me.role !== "OWNER" && me.role !== "GENERAL_MANAGER") {
        return NextResponse.json({ success: false, error: "This intake needs expense-booking permission. Untick 'book expense' or ask a manager to record it." }, { status: 403 });
      }
      const updated = await stockIn({
        businessId, sku: item.sku, name: item.name, category: item.category || RAW_CATEGORY, unit: "Kg",
        quantity: qtyKg,
        costPriceGhs: unitCost > 0 ? unitCost : undefined,
        minStockThreshold: data.minStockThreshold != null ? Number(data.minStockThreshold) : undefined,
      });
      let expense = null;
      if (recordExpense) {
        expense = await postExpense(me, {
          businessId, branchCode, branchName, category: EXP_CAT_INTAKE,
          amountGhs: totalCost,
          paymentMethod: data.paymentMethod || "CASH",
          description: data.description || `Fish-fish feed mill raw material intake: ${qtyKg} kg ${item.name} (${item.sku})${data.supplierName ? ` from ${data.supplierName}` : ""}`,
          date: data.date || today,
        });
      }
      // Supplier ledger integration: the intake vendor becomes/updates a
      // Suppliers record for this org (value of goods supplied accrues
      // whether or not the cash side is expensed here). Never blocks intake.
      const supName = String(data.supplierName || "").trim().slice(0, 120);
      const ownerId = orgId ?? (biz as any)?.ownerId ?? null;
      const { supplier } = supName
        ? await linkSupplier({
            ownerId, name: supName, category: "Fish Feed",
            suppliedGhs: totalCost, paymentMethod: data.paymentMethod, logTag: "[fish-mill]",
          })
        : { supplier: null };
      await auditLog(me, "FISH_FEED_RAW_INTAKE", "RECORD", `Raw intake ${item.name} × ${qtyKg} kg`, "OPERATION_LOG", updated?.id ?? item.id,
        businessId, branchCode,
        `Stocked ${qtyKg} kg of ${item.name} at GH₵ ${unitCost.toFixed(2)}/kg${expense ? ` · expensed once as ${EXP_CAT_INTAKE} GH₵ ${totalCost.toFixed(2)}` : " · stock-only (no expense booking)"}${supplier ? ` · supplier ledger: ${supName}` : ""}.`,
        orgId);
      return NextResponse.json({
        success: true, item: updated, expense, qtyKg, supplier,
        stockStatus: computeStockStatus(updated?.quantity || 0, updated?.minStockThreshold || 0),
      });
    }

    // ── BATCH (the production run)
    if (entity === "BATCH") {
      const formId = Number(data.formulationId) || 0;
      const [form] = await db.select().from(fishFeedFormulations).where(
        and(eq(fishFeedFormulations.id, formId), eq(fishFeedFormulations.businessId, businessId)));
      if (!form) return NextResponse.json({ success: false, error: "Choose a formulation to mix." }, { status: 400 });
      if (form.active === false) return NextResponse.json({ success: false, error: `Formulation "${form.name}" is deactivated — reactivate it to mix.` }, { status: 400 });
      const bom = await db.select().from(fishFeedFormulationItems).where(eq(fishFeedFormulationItems.formulationId, form.id));
      if (!bom.length) return NextResponse.json({ success: false, error: "That formulation has no ingredients. Edit it first." }, { status: 400 });

      const plannedInputKg = feedToKg(Number(data.plannedInputKg ?? form.batchSizeKg) || form.batchSizeKg, data.inputUnit);
      if (!(plannedInputKg > 0)) return NextResponse.json({ success: false, error: "planned input must be greater than 0" }, { status: 400 });
      const actualOutputKg = feedToKg(Number(data.actualOutputKg) || 0, data.outputUnit);
      if (!(actualOutputKg > 0)) return NextResponse.json({ success: false, error: "actual output kg is required (weigh the milled feed)." }, { status: 400 });
      const overrides = new Map<number, number>();
      if (Array.isArray(data.inputOverrides)) {
        for (const o of data.inputOverrides) {
          const lineId = Number(o.formulationItemId) || 0;
          const kg = feedToKg(Number(o.actualKg) || 0, o.unit);
          if (lineId && kg >= 0) overrides.set(lineId, kg);
        }
      }
      // Build draw plan with cost snapshots and validate stock.
      const invAll = await db.select().from(inventoryItems).where(eq(inventoryItems.businessId, businessId));
      const byId = new Map(invAll.map((i) => [i.id, i]));
      const plan: any[] = [];
      let actualInputKg = 0;
      let ingredientCost = 0;
      for (const line of bom) {
        const item = line.inventoryId != null ? byId.get(line.inventoryId) : null;
        if (!item) return NextResponse.json({ success: false, error: `Ingredient "${line.ingredientName}" is not linked to a stock item — fix the formulation.` }, { status: 400 });
        const plannedKg = Math.round(((line.sharePct || 0) / 100) * plannedInputKg * 1000) / 1000;
        const actualKg = overrides.has(line.id) ? overrides.get(line.id)! : plannedKg;
        if (!(actualKg > 0)) {
          // A zero-share draw line is allowed to be zero; block negative/NaN elsewhere.
          if (actualKg !== 0) return NextResponse.json({ success: false, error: `Invalid draw for ${line.ingredientName}.` }, { status: 400 });
        }
        if ((item.quantity || 0) + 1e-9 < actualKg) {
          return NextResponse.json({
            success: false,
            error: `Insufficient stock for ${line.ingredientName}: need ${actualKg} kg, have ${(item.quantity || 0).toFixed(1)} kg. Intake more first.`,
            code: "INSUFFICIENT_STOCK",
          }, { status: 400 });
        }
        const unitCost = Number(item.costPriceGhs) || 0;
        const lineCost = Math.round(actualKg * unitCost * 100) / 100;
        plan.push({ line, item, plannedKg, actualKg, unitCost, lineCost });
        actualInputKg += actualKg;
        ingredientCost += lineCost;
      }

      // Physical consistency FIRST — output can never exceed what went in
      // (2% tolerance covers scale rounding only, not magic mass). Refuse
      // before any stock moves, like every other guard above.
      if (actualInputKg > 0 && actualOutputKg > actualInputKg * 1.02) {
        return NextResponse.json({
          success: false,
          error: `Output (${actualOutputKg} kg) exceeds input (${actualInputKg.toFixed(1)} kg) — re-weigh; yield above 102% is physically impossible.`,
          code: "IMPOSSIBLE_YIELD",
        }, { status: 400 });
      }
      // Execute the draws (stock-out every ingredient).
      for (const p of plan) {
        await stockOut({ businessId, inventoryId: p.item.id, quantity: p.actualKg });
      }

      const totalCost = Math.round((ingredientCost + (Number(data.labourCostGhs) || 0) + (Number(data.overheadCostGhs) || 0)) * 100) / 100;
      const costPerKg = actualOutputKg > 0 ? Math.round((totalCost / actualOutputKg) * 1000) / 1000 : 0;
      const yieldPct = actualInputKg > 0 ? Math.round((actualOutputKg / actualInputKg) * 1000) / 10 : null;

      // Finished-feed stock-in.
      const finishedSku = `FISH-FM-${branchCode || "BIZ"}-${form.id}`;
      const finishedName = `${form.name} (Milled)`;
      const finished = await stockIn({
        businessId, sku: finishedSku, name: finishedName, category: MILL_CATEGORY, unit: "Kg",
        quantity: actualOutputKg,
        costPriceGhs: costPerKg > 0 ? costPerKg : undefined,
        sellingPriceGhs: (form.commercialRefPriceGhs || 0) > 0 ? form.commercialRefPriceGhs! : undefined,
        minStockThreshold: 50,
      });

      const batchNumber = `FPB-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
      const labour = Number(data.labourCostGhs) || 0;
      const overhead = Number(data.overheadCostGhs) || 0;
      const [batch] = await db.insert(fishFeedBatches).values({
        businessId, branchCode, ownerId: orgId,
        batchNumber,
        formulationId: form.id,
        formulationName: form.name,
        formulationSnapshot: { header: form, bom: bom.map((l) => ({ ...l })) },
        species: form.species, feedClass: form.feedClass, feedStage: form.feedStage,
        productionDate: data.productionDate || today,
        status: "QC_HOLD",
        plannedInputKg, actualInputKg: Math.round(actualInputKg * 1000) / 1000, actualOutputKg,
        yieldPct,
        ingredientCostGhs: Math.round(ingredientCost * 100) / 100,
        labourCostGhs: labour, overheadCostGhs: overhead,
        totalCostGhs: totalCost, costPerKgGhs: costPerKg,
        finishedInventoryId: finished?.id ?? null,
        finishedSku: finished?.sku ?? null,
        finishedName: finished?.name ?? null,
        stockedQtyKg: actualOutputKg,
        stockedAt: new Date(),
        operatorName: data.operatorName || null,
        notes: data.notes || null,
        recordedByName: me.name || null,
        recordedByRole: me.role || null,
        recordedByUserId: Number(me.id) || null,
      }).returning();
      for (const p of plan) {
        await db.insert(fishFeedBatchInputs).values({
          batchId: batch.id,
          inventoryId: p.item.id,
          ingredientName: p.line.ingredientName,
          sku: p.item.sku,
          plannedKg: p.plannedKg,
          actualKg: p.actualKg,
          unitCostGhs: p.unitCost,
          lineCostGhs: p.lineCost,
        });
      }

      // Mill ops expense (labour+overhead) — single-booked here; ingredients
      // were already expensed at intake and are NEVER booked here.
      let opsExpense = null;
      if (labour + overhead > 0) {
        opsExpense = await postExpense(me, {
          businessId, branchCode, branchName, category: EXP_CAT_OPS,
          amountGhs: labour + overhead,
          paymentMethod: data.paymentMethod || "CASH",
          description: `Fish feed batch ${batchNumber} operations (labour GH₵ ${labour.toFixed(2)} + overhead GH₵ ${overhead.toFixed(2)}) — ingredient cost derived from stock draw.`,
          date: data.productionDate || today,
        });
      }

      await db.update(fishFeedFormulations)
        .set({ lastCostPerKgGhs: costPerKg, lastProducedAt: new Date(), updatedAt: new Date() })
        .where(eq(fishFeedFormulations.id, form.id));
      await auditLog(me, "FISH_FEED_BATCH_PRODUCED", "RECORD", `Feed batch ${batchNumber}`, "FEED_BATCH", batch.id,
        businessId, branchCode,
        `Milled ${actualOutputKg} kg of "${form.name}" from ${plan.length} ingredient draws; cost GH₵ ${totalCost.toFixed(2)} (${costPerKg.toFixed(2)}/kg); batch on QC hold.`,
        orgId);

      // Raw exhaustion (same trigger the analytics banner detects): any draw
      // that consumed an ingredient's last kg fans out a critical bell so the
      // next production run is never silently blocked.
      const zeroed = plan.filter((p) => (p.item.quantity || 0) - p.actualKg <= 0.0001).map((p) => p.item.name);
      if (zeroed.length) {
        await millBell({
          businessId, branchCode, type: "FEED_RAW_OUT",
          title: `${zeroed.length} mill ingredient(s) out of stock`,
          body: `${zeroed.join(", ")} fully consumed by batch ${batchNumber}. Intake raw materials before the next run — the Raw Stock tab flags it too.`,
          recordType: "OPERATION_LOG", recordId: batch.id, recordRef: batchNumber, priority: "CRITICAL",
        });
      }

      const fullInputs = await db.select().from(fishFeedBatchInputs).where(eq(fishFeedBatchInputs.batchId, batch.id));
      return NextResponse.json({ success: true, item: batch, inputs: fullInputs, finished, opsExpense });
    }

    // ── QC (one check row; FAIL lights the bell)
    if (entity === "QC") {
      const batchId = Number(data.batchId) || null;
      let batch: any = null;
      if (batchId) {
        [batch] = await db.select().from(fishFeedBatches).where(
          and(eq(fishFeedBatches.id, batchId), eq(fishFeedBatches.businessId, businessId)));
        if (!batch) return NextResponse.json({ success: false, error: "Batch not found for this unit." }, { status: 404 });
      }
      const testName = String(data.testName || "").trim().slice(0, 120);
      if (!testName) return NextResponse.json({ success: false, error: "Test name is required." }, { status: 400 });
      const passFail = String(data.passFail || "PASS").toUpperCase();
      const [row] = await db.insert(fishFeedQcChecks).values({
        businessId, branchCode,
        batchId: batch?.id ?? null,
        batchNumber: batch?.batchNumber ?? (data.batchNumber || null),
        stage: data.stage || "RAW_MATERIAL",
        sampleRef: data.sampleRef || null,
        testName,
        requiredStandard: data.requiredStandard || null,
        testResult: data.testResult || null,
        resultValue: data.resultValue != null && data.resultValue !== "" ? Number(data.resultValue) : null,
        resultUnit: data.resultUnit || null,
        passFail: ["PASS", "FAIL"].includes(passFail) ? passFail : "PASS",
        moisturePct: data.moisturePct != null && data.moisturePct !== "" ? Number(data.moisturePct) : null,
        pelletMmObserved: data.pelletMmObserved != null && data.pelletMmObserved !== "" ? Number(data.pelletMmObserved) : null,
        floatPct: data.floatPct != null && data.floatPct !== "" ? Number(data.floatPct) : null,
        waterStabilityMin: data.waterStabilityMin != null && data.waterStabilityMin !== "" ? Number(data.waterStabilityMin) : null,
        contaminantsNote: data.contaminantsNote || null,
        notes: data.notes || null,
        photo: data.photo || null,
        testerName: data.testerName || me.name || null,
        testerRole: data.testerRole || me.role || null,
        recordedByName: me.name || null,
        recordedByRole: me.role || null,
      }).returning();
      if (row.passFail === "FAIL") {
        await millBell({
          businessId, branchCode,
          type: "FISH_FEED_QC_FAIL",
          title: `Feed QC FAIL: ${row.testName}`,
          body: `${me.name || "Tester"} failed the "${row.testName}" check (${row.stage})${batch ? ` on batch ${batch.batchNumber}` : ""}${row.testResult ? ` — ${row.testResult}` : ""}. Release stays blocked; reject or re-check.`,
          recordType: "FEED_QC_CHECK", recordId: row.id, recordRef: batch?.batchNumber || `QC-${row.id}`,
          priority: "HIGH",
        });
        await auditLog(me, "FISH_FEED_QC_FAIL", "RECORD", `QC FAIL ${row.testName}${batch ? ` · ${batch.batchNumber}` : ""}`,
          "FEED_QC_CHECK", row.id, businessId, branchCode,
          `Stage ${row.stage}: ${row.testResult || "failed against standard"}${row.requiredStandard ? ` (standard: ${row.requiredStandard})` : ""}.`,
          orgId);
      }
      return NextResponse.json({ success: true, item: row });
    }

    // ── RELEASE (QC gate)
    if (entity === "RELEASE") {
      const batchId = Number(data.batchId) || 0;
      const [batch] = await db.select().from(fishFeedBatches).where(
        and(eq(fishFeedBatches.id, batchId), eq(fishFeedBatches.businessId, businessId)));
      if (!batch) return NextResponse.json({ success: false, error: "Batch not found for this unit." }, { status: 404 });
      if (batch.status !== "QC_HOLD") {
        return NextResponse.json({ success: false, error: `Batch ${batch.batchNumber} is ${batch.status}, not on QC hold.` }, { status: 400 });
      }
      const checks = await db.select().from(fishFeedQcChecks)
        .where(and(eq(fishFeedQcChecks.batchId, batch.id), eq(fishFeedQcChecks.stage, "FINISHED_FEED")));
      // FLOATING feeds: the passing check must also prove float behaviour
      // (≥ 90% pellets floating after 10 min) — sinking feeds need only the
      // generic FINISHED_FEED PASS. Owner override still available.
      const floatOk = (c: any) => batch.feedClass !== "FLOATING" || (c.floatPct ?? 0) >= 90;
      const passed = checks.some((c) => c.passFail === "PASS" && floatOk(c));
      const anyFail = checks.some((c) => c.passFail === "FAIL");
      const floatBlocked = batch.feedClass === "FLOATING" && !passed && checks.some((c) => c.passFail === "PASS");
      const note = String(data.note || "").trim().slice(0, 300);
      const mayOverride = me.role === "OWNER" || me.canManageRecords === true;
      let releaseBasis: string;
      if (passed) {
        releaseBasis = note ? `Released on finished-feed QC pass. ${note}` : "Released on finished-feed QC pass.";
      } else if (mayOverride && note) {
        releaseBasis = `OWNER OVERRIDE RELEASE (no finished-feed PASS on record): ${note}`;
      } else {
        return NextResponse.json({
          success: false,
          error: floatBlocked
            ? `QC gate: batch ${batch.batchNumber} is a FLOATING feed but its float test is below 90% (10-min float) — re-extrude or have the OWNER / a records-authorized manager override with a written reason.`
            : `QC gate: batch ${batch.batchNumber} has no PASS finished-feed check${anyFail ? " and carries a FAILED check" : ""}. Run the finished-feed QC first — or have the OWNER / a records-authorized manager override with a written reason.`,
          code: "QC_GATE",
        }, { status: 400 });
      }
      const [released] = await db.update(fishFeedBatches).set({
        status: "RELEASED",
        releasedAt: new Date(),
        releasedByName: me.name || null,
        releaseNote: releaseBasis,
      }).where(eq(fishFeedBatches.id, batch.id)).returning();
      await auditLog(me, "FISH_FEED_BATCH_RELEASE", "RECORD", `Feed batch ${batch.batchNumber} released`,
        "FEED_BATCH", batch.id, businessId, branchCode, releaseBasis, orgId);
      await millBell({
        businessId, branchCode,
        type: "FISH_FEED_BATCH_RELEASED",
        title: `Feed batch ${batch.batchNumber} released`,
        body: `${batch.actualOutputKg.toFixed(0)} kg of "${batch.formulationName}" passed release and is now available for feeding${releaseBasis.startsWith("OWNER OVERRIDE") ? " — released by owner override" : ""}.`,
        recordType: "FEED_BATCH", recordId: batch.id, recordRef: batch.batchNumber,
      });
      return NextResponse.json({ success: true, item: released });
    }

    // ── REJECT (terminal; OWNER / records-authorized only)
    if (entity === "REJECT") {
      const mayReject = me.role === "OWNER" || me.canManageRecords === true;
      if (!mayReject) {
        return NextResponse.json({ success: false, error: "Only the OWNER (or a records-authorized manager) may reject a feed batch." }, { status: 403 });
      }
      const reason = String(data.reason || "").trim().slice(0, 300);
      if (!reason) return NextResponse.json({ success: false, error: "A rejection reason is required (it goes on the audit record)." }, { status: 400 });
      const batchId = Number(data.batchId) || 0;
      const [batch] = await db.select().from(fishFeedBatches).where(
        and(eq(fishFeedBatches.id, batchId), eq(fishFeedBatches.businessId, businessId)));
      if (!batch) return NextResponse.json({ success: false, error: "Batch not found for this unit." }, { status: 404 });
      if (batch.status !== "QC_HOLD") {
        return NextResponse.json({ success: false, error: `Only batches on QC hold can be rejected (${batch.batchNumber} is ${batch.status}).` }, { status: 400 });
      }
      // Reverse the remaining finished stock-in (nothing could be consumed while held).
      const out = await stockOut({ businessId, inventoryId: batch.finishedInventoryId ?? null, sku: batch.finishedSku ?? undefined, quantity: batch.stockedQtyKg || 0 });
      const [rejected] = await db.update(fishFeedBatches).set({
        status: "REJECTED",
        releaseNote: `REJECTED: ${reason} (reversed ${out.deducted.toFixed(1)} kg stock-in)`,
        releasedAt: new Date(),
        releasedByName: me.name || null,
      }).where(eq(fishFeedBatches.id, batch.id)).returning();
      await auditLog(me, "FISH_FEED_BATCH_REJECT", "RECORD", `Feed batch ${batch.batchNumber} rejected`,
        "FEED_BATCH", batch.id, businessId, branchCode,
        `${reason} — ${out.deducted.toFixed(1)} kg of ${batch.finishedName} removed from finished stock. Ingredient draw of ${batch.actualInputKg} kg stays consumed (audit trail intact).`,
        orgId);
      await millBell({
        businessId, branchCode,
        type: "FISH_FEED_BATCH_REJECTED",
        title: `Feed batch ${batch.batchNumber} rejected`,
        body: `${me.name || "Management"} rejected ${batch.actualOutputKg.toFixed(0)} kg of "${batch.formulationName}": ${reason}. Stock-in was reversed (${out.deducted.toFixed(1)} kg).`,
        recordType: "FEED_BATCH", recordId: batch.id, recordRef: batch.batchNumber,
        priority: "HIGH",
      });
      return NextResponse.json({ success: true, item: rejected, stockReversedKg: out.deducted });
    }

    // ── CONSUMPTION (own-mill feeding → typed feed log + stock-out; NO txn)
    if (entity === "CONSUMPTION") {
      const batchId = Number(data.batchId) || 0;
      const [batch] = await db.select().from(fishFeedBatches).where(
        and(eq(fishFeedBatches.id, batchId), eq(fishFeedBatches.businessId, businessId)));
      if (!batch) return NextResponse.json({ success: false, error: "Feed batch not found for this unit." }, { status: 404 });
      if (batch.status !== "RELEASED") {
        return NextResponse.json({
          success: false,
          error: batch.status === "QC_HOLD" || batch.status === "MIXING"
            ? `Batch ${batch.batchNumber} is still on QC hold — release it after passing finished-feed QC before feeding.`
            : `Batch ${batch.batchNumber} is ${batch.status} and cannot be fed.`,
          code: "NOT_RELEASED",
        }, { status: 409 });
      }
      const qtyKg = feedToKg(Number(data.qty) || 0, data.unit);
      if (!(qtyKg > 0)) return NextResponse.json({ success: false, error: "quantity must be greater than 0" }, { status: 400 });
      const consumedRows = await db.select().from(aquacultureFeedLogs).where(
        and(eq(aquacultureFeedLogs.feedBatchId, batch.id), eq(aquacultureFeedLogs.sourceType, "OWN_MILL")));
      const consumedSoFar = consumedRows.reduce((s, f) => s + (f.quantityKg || 0), 0);
      const remaining = Math.round(((batch.stockedQtyKg || 0) - consumedSoFar) * 1000) / 1000;
      if (qtyKg > remaining + 1e-9) {
        return NextResponse.json({
          success: false,
          error: `Batch ${batch.batchNumber} has only ${remaining.toFixed(1)} kg left (produced ${batch.stockedQtyKg}) — log ${remaining.toFixed(1)} kg or release another batch.`,
          code: "BATCH_EXHAUSTED",
        }, { status: 400 });
      }
      let pond: any = null;
      if (data.pondId != null) {
        [pond] = await db.select().from(aquaculturePonds).where(
          and(eq(aquaculturePonds.id, Number(data.pondId)), eq(aquaculturePonds.businessId, businessId)));
        if (!pond) return NextResponse.json({ success: false, error: "Pond not found for this business." }, { status: 404 });
      }
      let fishBatch: any = null;
      if (data.fishBatchId != null) {
        [fishBatch] = await db.select().from(aquacultureBatches).where(
          and(eq(aquacultureBatches.id, Number(data.fishBatchId)), eq(aquacultureBatches.businessId, businessId)));
        if (!fishBatch) return NextResponse.json({ success: false, error: "Fish batch not found for this business." }, { status: 404 });
      }
      const out = await stockOut({ businessId, inventoryId: batch.finishedInventoryId ?? null, sku: batch.finishedSku ?? undefined, quantity: qtyKg });
      if (out.deducted < qtyKg - 1e-9) {
        return NextResponse.json({ success: false, error: `Finished-feed stock low: only ${out.deducted.toFixed(1)} kg could be drawn.` }, { status: 400 });
      }
      const costPerKg = batch.costPerKgGhs || 0;
      const [row] = await db.insert(aquacultureFeedLogs).values({
        businessId, branchCode: data.branchCode || pond?.branchCode || branchCode,
        pondId: pond?.id ?? fishBatch?.pondId ?? null,
        batchId: fishBatch?.id ?? null,
        feedType: batch.feedClass === "SINKING" ? "SINKING" : "FLOATING", // same vocabulary as aqua feed logs
        brandSupplier: `Own mill · ${batch.batchNumber} (${batch.feedStage})`,
        quantityKg: qtyKg,
        costPerKgGhs: costPerKg,
        totalCostGhs: Math.round(qtyKg * costPerKg * 100) / 100,
        entryType: "CONSUMPTION",
        sourceType: "OWN_MILL",
        feedBatchId: batch.id,
        recordedDate: data.recordedDate || today,
        recordedByName: me.name || "Farm Staff",
      }).returning();
      await auditLog(me, "FISH_FEED_CONSUME", "RECORD", `Fed ${qtyKg} kg from ${batch.batchNumber}`, "OPERATION_LOG", row.id,
        businessId, branchCode,
        `${pond ? `Pond ${pond.pondId || pond.name || pond.id}` : ""}${fishBatch ? ` · batch ${fishBatch.batchNumber}` : ""} fed ${qtyKg} kg of ${batch.formulationName} (${batch.batchNumber}); derived value GH₵ ${(qtyKg * costPerKg).toFixed(2)} — not re-expensed (single-booking). Stock draw ${out.deducted.toFixed(1)} kg.`,
        orgId);
      return NextResponse.json({
        success: true, item: row, stockDeducted: out.deducted,
        batchRemainingKg: Math.round((remaining - out.deducted) * 1000) / 1000,
      });
    }

    return NextResponse.json({ success: false, error: `Unknown entity: ${entity}` }, { status: 400 });
  } catch (error: any) {
    console.error("POST /api/aquaculture/feed-mill error:", error);
    return apiError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    ttlInvalidate("init");
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const body = await request.json();
    const { entity, id, data = {} } = body;
    if (entity !== "FORMULATION" || !id) {
      return NextResponse.json({ success: false, error: "Unsupported patch operation" }, { status: 400 });
    }
    const businessId = Number(data.businessId);
    if (!businessId) return NextResponse.json({ success: false, error: "businessId is required" }, { status: 400 });
    if (!(await canAccessBusiness(me, businessId))) {
      return NextResponse.json({ success: false, error: "You do not have access to that business." }, { status: 403 });
    }
    const [form] = await db.select().from(fishFeedFormulations).where(
      and(eq(fishFeedFormulations.id, Number(id)), eq(fishFeedFormulations.businessId, businessId)));
    if (!form) return NextResponse.json({ success: false, error: "Formulation not found." }, { status: 404 });

    const set: any = { updatedAt: new Date() };
    if (data.name !== undefined && String(data.name).trim()) set.name = String(data.name).trim().slice(0, 120);
    if (data.species !== undefined) set.species = data.species;
    if (data.feedClass !== undefined) set.feedClass = data.feedClass;
    if (data.feedStage !== undefined) set.feedStage = data.feedStage;
    if (data.pelletMmTarget !== undefined) set.pelletMmTarget = data.pelletMmTarget === null || data.pelletMmTarget === "" ? null : Number(data.pelletMmTarget) || null;
    if (data.notes !== undefined) set.notes = data.notes || null;
    if (data.batchSizeKg !== undefined) set.batchSizeKg = Number(data.batchSizeKg) || form.batchSizeKg;
    if (data.cpPctTarget !== undefined) set.cpPctTarget = data.cpPctTarget === "" || data.cpPctTarget === null ? null : Number(data.cpPctTarget);
    if (data.commercialRefPriceGhs !== undefined) set.commercialRefPriceGhs = data.commercialRefPriceGhs === "" || data.commercialRefPriceGhs === null ? null : Number(data.commercialRefPriceGhs);
    if (data.active !== undefined) {
      if (data.active === false && !(me.role === "OWNER" || me.canManageRecords)) {
        return NextResponse.json({ success: false, error: "Only the OWNER (or a records-authorized manager) may deactivate a formulation." }, { status: 403 });
      }
      set.active = data.active === true;
    }

    const organizationForLog = form.ownerId ?? null;
    const [updated] = await db.update(fishFeedFormulations).set(set)
      .where(eq(fishFeedFormulations.id, form.id)).returning();

    // BOM replacement (optional): full new set replaces the old lines.
    if (Array.isArray(data.items)) {
      const items: any[] = data.items;
      if (!items.length) return NextResponse.json({ success: false, error: "Add at least one ingredient." }, { status: 400 });
      const normalized = items.map((it, i) => ({
        ingredientName: String(it.ingredientName || "").trim().slice(0, 120),
        sharePct: Number(it.sharePct) || 0,
        sequence: i,
        inventoryId: it.inventoryId != null ? Number(it.inventoryId) : null,
      }));
      const sumShare = normalized.reduce((s, it) => s + it.sharePct, 0);
      if (Math.abs(sumShare - 100) > 0.5) {
        return NextResponse.json({ success: false, error: `Ingredients must total 100% (they add to ${sumShare.toFixed(1)}%).` }, { status: 400 });
      }
      if (normalized.some((it) => !it.ingredientName || it.sharePct <= 0)) {
        return NextResponse.json({ success: false, error: "Every ingredient needs a name and a positive share %." }, { status: 400 });
      }
      // Resolve every ingredient FIRST — never delete the old BOM until all
      // new lines are valid (an error here must not empty the recipe).
      const resolvedItems: any[] = [];
      for (const it of normalized.slice(0, 40)) {
        let inv: any = null;
        if (it.inventoryId != null) {
          const [found] = await db.select().from(inventoryItems).where(
            and(eq(inventoryItems.id, Number(it.inventoryId)), eq(inventoryItems.businessId, businessId)));
          if (!found) return NextResponse.json({ success: false, error: `Ingredient "${it.ingredientName}": inventory item not found.` }, { status: 400 });
          inv = found;
        } else {
          inv = await ensureRawMaterial(businessId, it.ingredientName);
        }
        resolvedItems.push({ ...it, inventoryId: inv.id, sku: inv.sku });
      }
      await db.delete(fishFeedFormulationItems).where(eq(fishFeedFormulationItems.formulationId, form.id));
      for (const it of resolvedItems) {
        await db.insert(fishFeedFormulationItems).values({
          formulationId: form.id, inventoryId: it.inventoryId, ingredientName: it.ingredientName,
          sku: it.sku, sharePct: it.sharePct, sequence: it.sequence,
        });
      }
      await db.update(fishFeedFormulations).set({ version: (form.version || 1) + 1 })
        .where(eq(fishFeedFormulations.id, form.id));
    }

    await auditLog(me, "FISH_FEED_FORMULATION_UPDATE", "RECORD", `Formulation ${updated.name}`,
      "FEED_FORMULATION", form.id, businessId, form.branchCode ?? null,
      `Updated formulation ${updated.formulationNo} (${updated.name})${Array.isArray(data.items) ? ` incl. BOM replacement to v${(form.version || 1) + 1}` : ""}${data.active !== undefined ? `; active=${!!set.active}` : ""}.`,
      organizationForLog);
    return NextResponse.json({ success: true, item: updated });
  } catch (error: any) {
    console.error("PATCH /api/aquaculture/feed-mill error:", error);
    return apiError(error);
  }
}
