import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
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
  poultryBenchmarkProfiles,
  businesses,
  transactions,
} from "@/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { stockIn, stockOut, ensureInventoryItem } from "@/lib/stock";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { advisorSectionsForBusiness } from "@/lib/auth";
import { canViewSection } from "@/lib/advisorSections";
import { apiError } from "@/lib/apiError";
import { auditLog } from "@/lib/audit";
import { ownerOrgOfBusiness } from "@/lib/notify";
import { nextTrxNumber } from "@/lib/idNumbers";
import { stageOfFlock } from "@/lib/poultryStages";
import {
  isPoultryCategory,
  forkFlockPlan,
  applyPlanTemplateToFlock,
  generateEntriesForDate,
} from "@/lib/checklistGen";
import { checklistPlanTemplates } from "@/db/schema";
import { resolveProfile, BENCHMARK_TEMPLATES } from "@/lib/poultryBenchmarking";

// Canonical sellable products for the poultry branch — production stocks these
// in, sales deduct them, and they appear in every stock picker automatically.
const POULTRY_PRODUCTS = {
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

/** Benchmark profile reference for a flock: null/"" → auto-match (null).
 *  Returns the profile id when it belongs to the business, else null. */
async function resolveProfileId(raw: any, businessId: number): Promise<number | null> {
  const id = Number(raw);
  if (!id) return null;
  const [profile] = await db
    .select({ id: poultryBenchmarkProfiles.id })
    .from(poultryBenchmarkProfiles)
    .where(and(eq(poultryBenchmarkProfiles.id, id), eq(poultryBenchmarkProfiles.businessId, businessId)));
  return profile ? profile.id : null;
}

/**
 * GET /api/poultry?businessId=1
 * Returns every dataset for the Poultry Farm Management module,
 * scoped to the selected Business → Branch.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
  ttlInvalidate("init");
    if (!session) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const businessIdParam = searchParams.get("businessId");
    const bizId = businessIdParam ? Number(businessIdParam) : null;

    // Tenant isolation: without a businessId the route previously returned
    // EVERY tenant's poultry data, and with one it skipped the access gate —
    // any authenticated user could read any farm. Match the block-factory /
    // aquaculture contract: businessId required + caller must have access.
    if (!bizId) {
      return NextResponse.json({ success: false, error: "businessId is required" }, { status: 400 });
    }
    if (!(await canAccessBusiness(session.user, bizId))) {
      return FORBIDDEN("You do not have access to that business.");
    }

    const scope = <T extends { businessId: any }>(table: any) =>
      db.select().from(table).where(eq(table.businessId, bizId));

    const [flocks, feedLogs, waterLogs, healthRecords, production, checklists, weightLogs, benchmarkProfiles] =
      await Promise.all([
        scope(poultryFlocks),
        scope(poultryFeedLogs),
        scope(poultryWaterLogs),
        scope(poultryHealthRecords),
        scope(poultryProduction),
        scope(poultryChecklists),
        scope(poultryWeightLogs),
        scope(poultryBenchmarkProfiles),
      ]);

    // Master Product List — every production type lives here. It starts EMPTY
    // for every business (owner directive: new / reset units begin with zero
    // sample, test or unrelated data); users add their own types from the
    // Log Production form. The demo flagship POULTRY-01 receives its two
    // system products (Eggs, Broiler) from the seed (seed.ts) only.
    let products: any[] = [];
    products = await db
      .select()
      .from(poultryProducts)
      .where(eq(poultryProducts.businessId, bizId));

    const sortByIdDesc = (a: any, b: any) => (b.id || 0) - (a.id || 0);

    // ── Farm Advisor section visibility (OWNER-controlled per unit) ───────
    // Denied datasets are stripped HERE — a hidden tab can never be
    // reconstructed from the API payload. null sections = all (legacy).
    const advisorSecs = await advisorSectionsForBusiness(session.user, bizId);
    const view = (key: string) => canViewSection(advisorSecs, key);

    // Attach each flock's production stage (derived from arrivalDate + the
    // resolved benchmark profile) so the module can show stage chips and the
    // daily checklist can be reviewed flock by flock. Response-only — nothing
    // is persisted on the flock row.
    const todayLocal = new Date().toLocaleDateString("en-CA");
    const profilePool = [...(benchmarkProfiles as any[]), ...BENCHMARK_TEMPLATES];
    const flocksOut = (flocks as any[]).map((f) => {
      const { profile } = resolveProfile(f, profilePool);
      const stage = stageOfFlock(f, todayLocal, profile);
      return { ...f, stage };
    });

    return NextResponse.json({
      success: true,
      flocks: view("FLOCKS") ? flocksOut.sort(sortByIdDesc) : [],
      feedLogs: view("FEED") ? feedLogs.sort(sortByIdDesc) : [],
      waterLogs: view("WATER") ? waterLogs.sort(sortByIdDesc) : [],
      healthRecords: view("HEALTH") ? healthRecords.sort(sortByIdDesc) : [],
      production: view("PRODUCTION") ? production.sort(sortByIdDesc) : [],
      weightLogs: view("GROWTH") ? weightLogs.sort(sortByIdDesc) : [],
      checklists: view("CHECKLIST") ? checklists.sort((a: any, b: any) => (a.id || 0) - (b.id || 0)) : [],
      products: view("INVENTORY") ? products.sort((a: any, b: any) => (a.id || 0) - (a.id || 0)) : [],
      benchmarkProfiles: view("BENCHMARK")
        ? benchmarkProfiles.sort((a: any, b: any) =>
            Number(!!b.isDefault) - Number(!!a.isDefault) || (b.id || 0) - (a.id || 0))
        : [],
      // Echo the resolved section list so the read-only UI can filter tabs
      // without a second round-trip (non-advisors get null = unrestricted).
      advisorSections: advisorSecs,
    });
  } catch (error: any) {
    console.error("GET /api/poultry error:", error);
    return apiError(error);
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
  ttlInvalidate("init");
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
      if (initialCount <= 0) {
        return NextResponse.json(
          { success: false, error: "initialCount (birds stocked) must be greater than 0" },
          { status: 400 }
        );
      }
      if ((Number(data.currentCount) || initialCount) < 0 || (Number(data.mortalityTotal) || 0) < 0 || (Number(data.costPerBirdGhs) || 0) < 0) {
        return NextResponse.json(
          { success: false, error: "counts and costs cannot be negative" },
          { status: 400 }
        );
      }
      const benchmarkProfileId = data.benchmarkProfileId != null && data.benchmarkProfileId !== ""
        ? await resolveProfileId(data.benchmarkProfileId, businessId)
        : null;
      if (data.benchmarkProfileId != null && data.benchmarkProfileId !== "" && !benchmarkProfileId) {
        return NextResponse.json(
          { success: false, error: "Benchmark profile not found for this business." },
          { status: 404 },
        );
      }
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
          benchmarkProfileId,
          notes: data.notes || null,
          createdByName: data.createdByName || "Farm Staff",
          createdByRole: data.createdByRole || null,
        })
        .returning();
      await auditLog(session.user, "POULTRY_FLOCK_CREATE", "RECORD", `Flock ${row.flockName || row.batchNumber} stocked`,
        "OPERATION_LOG", row.id, businessId, branchCode,
        `${initialCount.toLocaleString()} ${row.birdType}${row.breed ? ` (${row.breed})` : ""} arrived${row.houseName ? ` into ${row.houseName}` : ""}`,
        (await ownerOrgOfBusiness(businessId).catch(() => null)) ?? null
      ).catch((e: any) => console.error("[poultry] audit failed:", e));

      // ── Lifecycle checklist plan selection (Owner/manager only) ─────
      // On create/start the Owner picks: recommended system plan (default,
      // no action needed), a saved custom template, or forks the
      // recommended plan for immediate per-flock customization.
      const role = String(session.user.role || "").toUpperCase();
      const planMode = String(data.checklistPlan?.mode || "").toUpperCase();
      const MANAGE = ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"];
      let checklistPlanApplied: string | null = null;
      if (
        isPoultryCategory(biz?.category) &&
        MANAGE.includes(role) &&
        (planMode === "TEMPLATE" || planMode === "CUSTOMIZE")
      ) {
        const actor = { id: (session.user as any).id, name: (session.user as any).name || null, role };
        try {
          if (planMode === "TEMPLATE") {
            const planTemplateId = Number(data.checklistPlan.planTemplateId);
            const [tpl] = planTemplateId
              ? await db.select().from(checklistPlanTemplates).where(eq(checklistPlanTemplates.id, planTemplateId))
              : [];
            if (tpl && Number(tpl.businessId) === businessId) {
              await applyPlanTemplateToFlock(
                businessId,
                branchCode,
                row,
                { id: Number(tpl.id), name: String(tpl.name), items: (tpl.items as any[]) || [] },
                actor
              );
              checklistPlanApplied = `template:${tpl.name}`;
              await auditLog(session.user, "POULTRY_FLOCK_PLAN_APPLIED", "Flock Checklist Plan",
                `${row.batchNumber} → ${tpl.name}`, "POULTRY_FLOCK", row.id, businessId, branchCode,
                `Flock ${row.batchNumber} started with saved plan template "${tpl.name}" by ${actor.name || "manager"}`,
                (await ownerOrgOfBusiness(businessId).catch(() => null)) ?? null
              ).catch(() => {});
            }
          } else {
            const res = await forkFlockPlan(businessId, branchCode, row, actor);
            checklistPlanApplied = `customize:${res.created}`;
            await auditLog(session.user, "POULTRY_FLOCK_PLAN_FORKED", "Flock Checklist Plan",
              `${row.batchNumber} (${row.birdType})`, "POULTRY_FLOCK", row.id, businessId, branchCode,
              `Flock ${row.batchNumber} started with a customized copy of the recommended plan (${res.created} items) by ${actor.name || "manager"}`,
              (await ownerOrgOfBusiness(businessId).catch(() => null)) ?? null
            ).catch(() => {});
          }
          // Materialize today's entries for the new flock right away.
          const todayLocal = new Date().toLocaleDateString("en-CA");
          await generateEntriesForDate(businessId, branchCode, todayLocal, biz?.code, biz?.category);
        } catch (e: any) {
          console.error("[poultry] checklist plan apply failed:", e);
        }
      }
      return NextResponse.json({ success: true, item: row, checklistPlanApplied });
    }

    // ── FEED ───────────────────────────────────────────────────────
    if (entity === "FEED") {
      const qty = Number(data.quantityKg) || 0;
      const costPerKg = Number(data.costPerKgGhs) || 0;
      const totalCost = Number(data.totalCostGhs) || qty * costPerKg;
      if (qty <= 0) {
        return NextResponse.json(
          { success: false, error: "quantityKg must be greater than 0" },
          { status: 400 }
        );
      }
      if (costPerKg < 0 || totalCost < 0) {
        return NextResponse.json(
          { success: false, error: "feed costs cannot be negative" },
          { status: 400 }
        );
      }
      // Flock references must stay inside this business.
      if (data.flockId) {
        const [flockOk] = await db
          .select({ id: poultryFlocks.id })
          .from(poultryFlocks)
          .where(and(eq(poultryFlocks.id, Number(data.flockId)), eq(poultryFlocks.businessId, businessId)));
        if (!flockOk) {
          return NextResponse.json(
            { success: false, error: "Flock not found for this business." },
            { status: 404 }
          );
        }
      }
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
        const trxNum = nextTrxNumber();
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
          // Book the expense on the feed log's own date so back-dated entries
          // land on the right ledger day (aquaculture already does this).
          date: data.recordedDate || today,
          createdAt: new Date(),
          status: "COMPLETED",
          recordedBy: data.recordedByName || "Poultry Farm User",
          recordedByRole: data.recordedByRole || null,
          recordedByUserId: data.recordedByUserId ? Number(data.recordedByUserId) : null,
        });
        await auditLog(session.user, "POULTRY_FEED_PURCHASE", "RECORD", `Feed purchase ${qty} kg ${row.feedType}`,
          "OPERATION_LOG", row.id, businessId, branchCode,
          `${qty} kg @ GH₵ ${costPerKg.toFixed(2)}/kg = GH₵ ${totalCost.toFixed(2)} · ${row.brandSupplier || "no supplier"} — expense ${trxNum}`,
          (await ownerOrgOfBusiness(businessId).catch(() => null)) ?? null
        ).catch((e: any) => console.error("[poultry] audit failed:", e));
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
      if (healthCost < 0 || (Number(data.mortalityCount) || 0) < 0 || (Number(data.birdsAffected) || 0) < 0) {
        return NextResponse.json(
          { success: false, error: "bird counts and costs cannot be negative" },
          { status: 400 }
        );
      }
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
        const trxNum = nextTrxNumber();
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
          date: data.recordedDate || today,
          createdAt: new Date(),
          status: "COMPLETED",
          recordedBy: data.recordedByName || "Poultry Farm User",
          recordedByRole: data.recordedByRole || null,
          recordedByUserId: data.recordedByUserId ? Number(data.recordedByUserId) : null,
        });
      }

      // Mortalities reduce the flock's live bird count — flock resolved
      // INSIDE this business so a mortality write can never drain another
      // tenant's flock.
      const mortality = Number(data.mortalityCount) || 0;
      if (mortality > 0 && data.flockId) {
        const [flock] = await db
          .select()
          .from(poultryFlocks)
          .where(and(eq(poultryFlocks.id, Number(data.flockId)), eq(poultryFlocks.businessId, businessId)));
        if (!flock) {
          return NextResponse.json(
            { success: false, error: "Flock not found for this business." },
            { status: 404 }
          );
        }
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
      if (eggs < 0 || soldEggs < 0 || revenue < 0 || broilersSold < 0 ||
          (Number(data.crackedEggs) || 0) < 0 || (Number(data.birdsHarvested) || 0) < 0 ||
          (Number(data.traysProduced) || 0) < 0) {
        return NextResponse.json(
          { success: false, error: "production counts and revenue cannot be negative" },
          { status: 400 }
        );
      }
      if (soldEggs > eggs) {
        return NextResponse.json(
          { success: false, error: "eggsSold cannot exceed eggsCollected on the same record" },
          { status: 400 }
        );
      }
      if ((Number(data.crackedEggs) || 0) > eggs) {
        return NextResponse.json(
          { success: false, error: "crackedEggs cannot exceed eggsCollected" },
          { status: 400 }
        );
      }

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
          const trxNum = nextTrxNumber();
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
            date: data.recordedDate || today,
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
          // Cracked eggs can never fill a tray — the auto default divides
          // the GOOD eggs only (stock-in does the same below).
          traysProduced: Number(data.traysProduced) > 0
            ? Number(Number(data.traysProduced).toFixed(2))
            : Number((Math.max(0, eggs - (Number(data.crackedEggs) || 0)) / 30).toFixed(2)),
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
        // Operator-precedence fix: `a || b > 0 ? x : 0` parsed as
        // `(a || (b > 0)) ? x : 0`, silently discarding the operator's
        // explicit tray count whenever cracked eggs were logged. An explicit
        // traysProduced entry wins; otherwise derive from good eggs.
        const cratesIn = Number(data.traysProduced) > 0
          ? Number(Number(data.traysProduced).toFixed(2))
          : (eggs > 0 ? Number((goodEggs / 30).toFixed(2)) : 0);
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
        const trxNum = nextTrxNumber();
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
          date: data.recordedDate || today,
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
      const targetDate = data.checklistDate || today;
      // Idempotent per day: re-generating today's checklist returns the
      // existing rows instead of duplicating them (same contract the
      // Block Factory checklist already uses).
      const existing = await db
        .select()
        .from(poultryChecklists)
        .where(
          and(
            eq(poultryChecklists.businessId, businessId),
            eq(poultryChecklists.checklistDate, targetDate),
          )
        );
      if (existing.length > 0) {
        return NextResponse.json({ success: true, items: existing.sort((a: any, b: any) => (a.id || 0) - (b.id || 0)), alreadyExists: true });
      }
      const rows = [];
      for (const t of tasks) {
        const [row] = await db
          .insert(poultryChecklists)
          .values({
            businessId,
            branchCode,
            checklistDate: targetDate,
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
    return apiError(error);
  }
}

/**
 * PATCH /api/poultry
 * Toggle a checklist task, or update a flock.
 */
export async function PATCH(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
  ttlInvalidate("init");
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
      // Tenant gate: the row's business must be one the caller can access —
      // previously any authenticated user could toggle any tenant's tasks.
      if (!(await canAccessBusiness(session.user, existing.businessId))) {
        return FORBIDDEN("You do not have access to that business.");
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
      // Tenant gate: resolve the flock first and verify the caller may touch
      // its business — previously any authenticated user could rewrite any
      // flock's head-count/status cross-tenant.
      const [existingFlock] = await db
        .select()
        .from(poultryFlocks)
        .where(eq(poultryFlocks.id, Number(id)));
      if (!existingFlock) {
        return NextResponse.json(
          { success: false, error: "Flock not found" },
          { status: 404 }
        );
      }
      if (!(await canAccessBusiness(session.user, existingFlock.businessId))) {
        return FORBIDDEN("You do not have access to that business.");
      }
      if (data?.currentCount !== undefined && Number(data.currentCount) < 0) {
        return NextResponse.json(
          { success: false, error: "currentCount cannot be negative" },
          { status: 400 }
        );
      }
      let benchmarkProfileId: number | null | undefined = undefined;
      if (data?.benchmarkProfileId !== undefined) {
        benchmarkProfileId = data.benchmarkProfileId === null || data.benchmarkProfileId === ""
          ? null
          : await resolveProfileId(data.benchmarkProfileId, existingFlock.businessId);
        if (data.benchmarkProfileId != null && data.benchmarkProfileId !== "" && !benchmarkProfileId) {
          return NextResponse.json(
            { success: false, error: "Benchmark profile not found for this business." },
            { status: 404 },
          );
        }
      }
      const [row] = await db
        .update(poultryFlocks)
        .set({
          currentCount:
            data?.currentCount !== undefined ? Number(data.currentCount) : undefined,
          ageWeeks: data?.ageWeeks !== undefined ? Number(data.ageWeeks) : undefined,
          status: data?.status || undefined,
          benchmarkProfileId,
          notes: data?.notes ?? undefined,
        })
        .where(eq(poultryFlocks.id, Number(id)))
        .returning();
      await auditLog(session.user, "POULTRY_FLOCK_UPDATE", "RECORD", `Flock ${row.flockName || row.batchNumber || row.id} updated`,
        "OPERATION_LOG", row.id, existingFlock.businessId, existingFlock.branchCode || null,
        [
          data?.currentCount !== undefined ? `count ${existingFlock.currentCount} → ${row.currentCount}` : null,
          data?.status ? `status ${existingFlock.status} → ${row.status}` : null,
          data?.ageWeeks !== undefined ? `age → ${row.ageWeeks} wk` : null,
        ].filter(Boolean).join(" · ") || "flock details updated",
        (await ownerOrgOfBusiness(existingFlock.businessId).catch(() => null)) ?? null
      ).catch((e: any) => console.error("[poultry] audit failed:", e));
      return NextResponse.json({ success: true, item: row });
    }

    return NextResponse.json(
      { success: false, error: "Unsupported patch operation" },
      { status: 400 }
    );
  } catch (error: any) {
    return apiError(error);
  }
}
