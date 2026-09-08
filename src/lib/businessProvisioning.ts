import { db } from "@/db";
import {
  businessMetrics,
  carWashServices,
  telecomLines,
  telecomWifiPackages,
  checklistTemplates,
  inventoryItems,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { computeStockStatus } from "@/lib/stock";
import { tasksForBusiness } from "@/lib/checklistDefaults";

/**
 * New-business auto-provisioning.
 *
 * Every business created through “New Branch / Unit” gets a MINIMAL,
 * completely clean operating workspace (owner directive 2026-08-27 — a new
 * unit must start with zero sample, test or unrelated data):
 *   • zero-based live financial metrics (they grow from real activity)
 *   • the full specialized daily-checklist template set for its type
 *     (operational configuration, not business records)
 * …and NOTHING else: no starter inventory, no sample services, no sample
 * tills/packages. The sample catalogue below (starter kits, wash services,
 * telecom lines) is reserved for the DEMO/RECOVERY seed (seed.ts opts in
 * via { starterKit: true }) to preserve the original flagship units.
 */

export const CATEGORY_PREFIX: Record<string, string> = {
  "Poultry Farm": "POULTRY",
  "Block Factory": "BLOCK",
  Aquaculture: "AQUA",
  Livestock: "LIVESTOCK",
  "Restaurant & Food": "FOOD",
  "Electronic Shop": "TECH",
  "Car Wash": "WASH",
  "Hardware Store": "HARDWARE",
  "Telecom & Digital Services": "TELECOM",
};

export const CATEGORY_ICON: Record<string, string> = {
  "Poultry Farm": "Egg",
  "Block Factory": "Boxes",
  Aquaculture: "Fish",
  Livestock: "Beef",
  "Restaurant & Food": "Utensils",
  "Electronic Shop": "Cpu",
  "Car Wash": "Droplets",
  "Hardware Store": "HardHat",
  "Telecom & Digital Services": "Wifi",
};

export interface StarterItem {
  name: string;
  skuSuffix: string;
  category: string;
  quantity: number;
  unit: string;
  costPriceGhs: number;
  sellingPriceGhs: number;
  minStockThreshold: number;
}

const KITS: Record<string, StarterItem[]> = {
  "Poultry Farm": [
    { name: "Layer Feed 50kg Bag", skuSuffix: "FEED-50KG", category: "Feed & Consumables", quantity: 40, unit: "Bags", costPriceGhs: 320, sellingPriceGhs: 360, minStockThreshold: 10 },
    { name: "Grade A Egg Trays (30 Eggs/Tray)", skuSuffix: "EGG-TRAY", category: "Poultry Products", quantity: 120, unit: "Trays", costPriceGhs: 38, sellingPriceGhs: 55, minStockThreshold: 40 },
    { name: "Vitamins & Poultry Supplements", skuSuffix: "VIT-PACK", category: "Feed & Consumables", quantity: 15, unit: "Packs", costPriceGhs: 85, sellingPriceGhs: 110, minStockThreshold: 5 },
  ],
  "Block Factory": [
    { name: "Portland Cement 50kg Bag", skuSuffix: "CEMENT-50KG", category: "Raw Materials", quantity: 100, unit: "Bags", costPriceGhs: 105, sellingPriceGhs: 118, minStockThreshold: 30 },
    { name: "6-Inch Solid Blocks (Grade A)", skuSuffix: "BLK-6IN", category: "Concrete Blocks", quantity: 2000, unit: "Units", costPriceGhs: 9.5, sellingPriceGhs: 14.5, minStockThreshold: 800 },
    { name: "Fine River Sand (Cubic Metre)", skuSuffix: "SAND-M3", category: "Raw Materials", quantity: 30, unit: "m³", costPriceGhs: 180, sellingPriceGhs: 220, minStockThreshold: 8 },
  ],
  Aquaculture: [
    { name: "Floating Fish Feed 25kg Bag", skuSuffix: "FEED-25KG", category: "Feed & Consumables", quantity: 35, unit: "Bags", costPriceGhs: 410, sellingPriceGhs: 460, minStockThreshold: 10 },
    { name: "Fresh Harvested Tilapia (Avg 800g)", skuSuffix: "TILAPIA-KG", category: "Fresh Aquaculture", quantity: 400, unit: "Kg", costPriceGhs: 38, sellingPriceGhs: 62, minStockThreshold: 100 },
    { name: "Aerator Spare Parts Kit", skuSuffix: "AERATOR-KIT", category: "Equipment Supplies", quantity: 5, unit: "Kits", costPriceGhs: 650, sellingPriceGhs: 780, minStockThreshold: 2 },
  ],
  Livestock: [
    { name: "Cattle Concentrate Feed 50kg", skuSuffix: "CATTLE-FEED", category: "Feed & Consumables", quantity: 25, unit: "Bags", costPriceGhs: 290, sellingPriceGhs: 340, minStockThreshold: 8 },
    { name: "Fresh Beef (Dressed, per Kg)", skuSuffix: "BEEF-KG", category: "Meat & Livestock Products", quantity: 150, unit: "Kg", costPriceGhs: 58, sellingPriceGhs: 85, minStockThreshold: 40 },
    { name: "Goat (Live Weight, per Kg)", skuSuffix: "GOAT-KG", category: "Meat & Livestock Products", quantity: 80, unit: "Kg", costPriceGhs: 45, sellingPriceGhs: 68, minStockThreshold: 25 },
  ],
  "Restaurant & Food": [
    { name: "Jollof Rice (Standard Plate)", skuSuffix: "JOLLOF-PLT", category: "Cooked Meals", quantity: 60, unit: "Plates", costPriceGhs: 22, sellingPriceGhs: 45, minStockThreshold: 20 },
    { name: "Grilled Tilapia with Banku", skuSuffix: "TILAPIA-BANKU", category: "Cooked Meals", quantity: 40, unit: "Plates", costPriceGhs: 38, sellingPriceGhs: 75, minStockThreshold: 15 },
    { name: "Cooking Oil 5L Bottle", skuSuffix: "OIL-5L", category: "Kitchen Ingredients", quantity: 20, unit: "Bottles", costPriceGhs: 165, sellingPriceGhs: 190, minStockThreshold: 6 },
    { name: "Rice Bag 25kg (Jasmine)", skuSuffix: "RICE-25KG", category: "Kitchen Ingredients", quantity: 12, unit: "Bags", costPriceGhs: 380, sellingPriceGhs: 430, minStockThreshold: 4 },
  ],
  "Electronic Shop": [
    { name: "Smartphone (Mid-Range 4G)", skuSuffix: "PHONE-4G", category: "Phones & Devices", quantity: 8, unit: "Units", costPriceGhs: 1450, sellingPriceGhs: 1950, minStockThreshold: 3 },
    { name: "Bluetooth Earbuds", skuSuffix: "EARBUDS", category: "Accessories", quantity: 20, unit: "Units", costPriceGhs: 90, sellingPriceGhs: 160, minStockThreshold: 6 },
    { name: "Phone Charging Cable (Type-C)", skuSuffix: "CABLE-USBC", category: "Accessories", quantity: 35, unit: "Units", costPriceGhs: 18, sellingPriceGhs: 40, minStockThreshold: 10 },
  ],
  "Car Wash": [
    { name: "Executive Wash & Wax", skuSuffix: "WASH-EXEC", category: "Wash Services", quantity: 999, unit: "Jobs", costPriceGhs: 8, sellingPriceGhs: 40, minStockThreshold: 50 },
    { name: "Interior Detailing Package", skuSuffix: "DETAIL-INT", category: "Wash Services", quantity: 999, unit: "Jobs", costPriceGhs: 15, sellingPriceGhs: 70, minStockThreshold: 50 },
    { name: "Car Wash Shampoo 25L Drum", skuSuffix: "SHAMPOO-25L", category: "Chemicals & Supplies", quantity: 4, unit: "Drums", costPriceGhs: 320, sellingPriceGhs: 380, minStockThreshold: 2 },
  ],
  "Hardware Store": [
    { name: "Ghacem 42.5R Portland Cement 50kg", skuSuffix: "CEMENT-50KG", category: "Cement & Mortar", quantity: 200, unit: "Bags", costPriceGhs: 105, sellingPriceGhs: 118, minStockThreshold: 50 },
    { name: "High-Tensile Iron Rods 12mm", skuSuffix: "ROD-12MM", category: "Steel & Reinforcement", quantity: 500, unit: "Lengths", costPriceGhs: 42, sellingPriceGhs: 55, minStockThreshold: 120 },
    { name: "Common Wire Nails 3in (25kg Box)", skuSuffix: "NAILS-3IN", category: "Fasteners & Fixings", quantity: 40, unit: "Boxes", costPriceGhs: 380, sellingPriceGhs: 460, minStockThreshold: 12 },
    { name: "Alu-Zinc Roofing Sheets 0.5mm", skuSuffix: "ROOF-ALZINC", category: "Roofing & Cladding", quantity: 150, unit: "Sheets", costPriceGhs: 95, sellingPriceGhs: 125, minStockThreshold: 40 },
    { name: "Emulsion Paint 20L Bucket", skuSuffix: "PAINT-20L", category: "Paints & Finishing", quantity: 30, unit: "Buckets", costPriceGhs: 340, sellingPriceGhs: 420, minStockThreshold: 10 },
    { name: "uPVC Pipe 110mm (4m Length)", skuSuffix: "UPVC-110MM", category: "Plumbing & Drainage", quantity: 80, unit: "Lengths", costPriceGhs: 65, sellingPriceGhs: 85, minStockThreshold: 20 },
  ],
  "Telecom & Digital Services": [
    { name: "MTN Airtime Top-Up (per GH₵)", skuSuffix: "AIR-MTN", category: "Airtime", quantity: 2000, unit: "GH₵", costPriceGhs: 0.96, sellingPriceGhs: 1, minStockThreshold: 200 },
    { name: "Telecel Airtime Top-Up (per GH₵)", skuSuffix: "AIR-TEL", category: "Airtime", quantity: 1000, unit: "GH₵", costPriceGhs: 0.96, sellingPriceGhs: 1, minStockThreshold: 100 },
    { name: "AT Airtime Top-Up (per GH₵)", skuSuffix: "AIR-AT", category: "Airtime", quantity: 800, unit: "GH₵", costPriceGhs: 0.96, sellingPriceGhs: 1, minStockThreshold: 100 },
    { name: "MTN Data Bundle 5GB (1 Month)", skuSuffix: "DATA-5GB", category: "Data Bundles", quantity: 60, unit: "Bundles", costPriceGhs: 28, sellingPriceGhs: 35, minStockThreshold: 15 },
    { name: "MTN Data Bundle 10GB (1 Month)", skuSuffix: "DATA-10GB", category: "Data Bundles", quantity: 40, unit: "Bundles", costPriceGhs: 55, sellingPriceGhs: 68, minStockThreshold: 10 },
    { name: "Wi-Fi Access Voucher (1 Hour)", skuSuffix: "WIFI-1HR", category: "Wi-Fi Vouchers", quantity: 999, unit: "Vouchers", costPriceGhs: 0.4, sellingPriceGhs: 2, minStockThreshold: 50 },
  ],
};

const GENERIC_KIT: StarterItem[] = [
  { name: "General Retail Stock", skuSuffix: "GEN-STOCK", category: "General Stock", quantity: 50, unit: "Units", costPriceGhs: 20, sellingPriceGhs: 35, minStockThreshold: 15 },
  { name: "Consumable Supplies", skuSuffix: "GEN-SUPPLY", category: "Consumables", quantity: 20, unit: "Units", costPriceGhs: 45, sellingPriceGhs: 65, minStockThreshold: 8 },
];

// ─── Auto Car Wash default service catalogue ─────────────────────────────
export interface WashServiceSeed {
  name: string;
  category: string; // WASH_PACKAGE, DETAILING, WAXING, POLISHING, INTERIOR_CLEANING, EXTERIOR_CLEANING
  description: string;
  priceGhs: number;
  durationMinutes: number;
  includesItems: string;
  supplyUsageLiters: number; // shampoo/chemical drawn from the branch drum per job
}

export const CAR_WASH_SERVICES_DEFAULTS: WashServiceSeed[] = [
  { name: "Express Exterior Wash", category: "EXTERIOR_CLEANING", description: "Quick drive-through quality exterior wash with rinse and air dry.", priceGhs: 15, durationMinutes: 20, includesItems: "Foam shampoo wash, high-pressure rinse", supplyUsageLiters: 1.5 },
  { name: "Interior Deep Clean & Vacuum", category: "INTERIOR_CLEANING", description: "Thorough cabin refresh: full vacuum, seats & mats shampooed, plastics dressed, glass polished inside.", priceGhs: 45, durationMinutes: 60, includesItems: "Vacuum, seat & carpet shampoo, dashboard polish, interior glass cleaner", supplyUsageLiters: 2.5 },
  { name: "Executive Wash & Wax", category: "WASH_PACKAGE", description: "Signature in-and-out package: foam wash, hand dry, dashboard wipe and wax finish.", priceGhs: 40, durationMinutes: 45, includesItems: "Foam shampoo, wax coat, tyre shine, dashboard wipe-down", supplyUsageLiters: 3 },
  { name: "Interior Detailing Package", category: "DETAILING", description: "Deep interior clean: vacuum, upholstery shampoo, dashboard & trim dressing, odour neutraliser.", priceGhs: 70, durationMinutes: 90, includesItems: "Upholstery shampoo, dashboard polish, vacuum, air freshener", supplyUsageLiters: 4 },
  { name: "Full Detailing (In & Out)", category: "DETAILING", description: "Complete showroom reset: exterior foam bath, clay bar, interior detail, engine bay touch-up.", priceGhs: 120, durationMinutes: 150, includesItems: "Foam shampoo, clay bar, upholstery shampoo, trim dressing, engine degreaser", supplyUsageLiters: 6 },
  { name: "Waxing & Paint Sealant", category: "WAXING", description: "Hand-applied premium wax coat and paint sealant for deep gloss and protection.", priceGhs: 50, durationMinutes: 60, includesItems: "Carnauba wax, paint sealant, microfiber finish", supplyUsageLiters: 2 },
  { name: "Machine Polishing & Buffing", category: "POLISHING", description: "Dual-action machine polish to remove swirl marks, oxidation and light scratches.", priceGhs: 60, durationMinutes: 75, includesItems: "Cutting compound, finishing polish, wax top-coat", supplyUsageLiters: 2.5 },
  { name: "Engine Bay Cleaning", category: "CUSTOM", description: "Careful engine-bay degrease, steam clean and dressing.", priceGhs: 35, durationMinutes: 40, includesItems: "Engine degreaser, steam, plastic dressing", supplyUsageLiters: 1.5 },
];

/**
 * Ensure a Car Wash unit has the default service catalogue, with chemical
 * consumption auto-linked to the branch's shampoo/chemical stock item when
 * one exists. Idempotent: any unit that already has services is left alone.
 */
export async function ensureCarWashServiceCatalogue(biz: {
  id: number;
  code: string;
  category: string;
}): Promise<number> {
  if (biz.category !== "Car Wash") return 0;
  const existing = await db
    .select()
    .from(carWashServices)
    .where(eq(carWashServices.businessId, biz.id));
  const stock = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.businessId, biz.id));
  const chem =
    stock.find((i) => /SHAMPOO|CHEM/i.test(i.sku || "") || /SHAMPOO|CHEM/i.test(i.name || "")) || null;

  // Units WITH a catalogue never have it replaced — but if a core service
  // category is completely absent, top up just the missing-category defaults
  // (keeps the menu complete without resurrecting individually-tuned offers).
  if (existing.length > 0) {
    const have = new Set(existing.map((s) => s.category));
    let toppedUp = 0;
    for (const s of CAR_WASH_SERVICES_DEFAULTS) {
      if (have.has(s.category)) continue;
      if (existing.some((e) => e.name === s.name)) continue;
      await db.insert(carWashServices).values({
        businessId: biz.id,
        branchCode: biz.code,
        name: s.name,
        category: s.category,
        description: s.description,
        priceGhs: s.priceGhs,
        durationMinutes: s.durationMinutes,
        includesItems: s.includesItems,
        supplyInventoryId: chem ? chem.id : null,
        supplyUsageLiters: s.supplyUsageLiters,
        active: true,
      });
      have.add(s.category);
      toppedUp++;
    }
    return toppedUp;
  }

  for (const s of CAR_WASH_SERVICES_DEFAULTS) {
    await db.insert(carWashServices).values({
      businessId: biz.id,
      branchCode: biz.code,
      name: s.name,
      category: s.category,
      description: s.description,
      priceGhs: s.priceGhs,
      durationMinutes: s.durationMinutes,
      includesItems: s.includesItems,
      supplyInventoryId: chem ? chem.id : null,
      supplyUsageLiters: s.supplyUsageLiters,
      active: true,
    });
  }
  return CAR_WASH_SERVICES_DEFAULTS.length;
}

// ─── Telecom & Digital Services default network setup ────────────────────
export interface TelecomLineSeed {
  network: string;
  kind: string;
  label: string;
}
export interface WifiPackageSeed {
  name: string;
  durationHours: number;
  dataCapMb: number | null;
  priceGhs: number;
  routerLabel: string;
}

export const TELECOM_LINE_DEFAULTS: TelecomLineSeed[] = [
  { network: "MTN", kind: "MOMO_AGENT", label: "MTN MoMo Agent Till" },
  { network: "TELECEL", kind: "MOMO_AGENT", label: "Telecel Cash Agent Till" },
  { network: "AT", kind: "MOMO_AGENT", label: "AT Money Agent Till" },
  { network: "MTN", kind: "AIRTIME_WALLET", label: "MTN Airtime/Data Wallet" },
];

export const WIFI_PACKAGE_DEFAULTS: WifiPackageSeed[] = [
  { name: "1-Hour Quick Surf", durationHours: 1, dataCapMb: 512, priceGhs: 2, routerLabel: "Wi-Fi Zone A" },
  { name: "1-Day Unlimited", durationHours: 24, dataCapMb: null, priceGhs: 10, routerLabel: "Wi-Fi Zone A" },
  { name: "1-Week Unlimited", durationHours: 168, dataCapMb: null, priceGhs: 45, routerLabel: "Wi-Fi Zone A" },
  { name: "5GB Night Bundle (7 Days)", durationHours: 168, dataCapMb: 5120, priceGhs: 20, routerLabel: "Wi-Fi Zone A" },
];

/**
 * Ensure a Telecom & Digital Services unit has its default agent lines
 * (MTN/Telecel/AT MoMo tills + airtime wallet) and default Wi-Fi packages.
 * Idempotent: units that already have lines/packages are left alone.
 */
export async function ensureTelecomDefaults(biz: {
  id: number;
  code: string;
  category: string;
}): Promise<{ lines: number; packages: number }> {
  if (biz.category !== "Telecom & Digital Services") return { lines: 0, packages: 0 };
  let lines = 0;
  let packages = 0;
  const existingLines = await db.select().from(telecomLines).where(eq(telecomLines.businessId, biz.id));
  if (existingLines.length === 0) {
    for (const l of TELECOM_LINE_DEFAULTS) {
      await db.insert(telecomLines).values({
        businessId: biz.id,
        branchCode: biz.code,
        network: l.network,
        kind: l.kind,
        label: l.label,
        floatGhs: 0,
        cashGhs: 0,
        active: true,
      });
      lines++;
    }
  }
  const existingPkgs = await db.select().from(telecomWifiPackages).where(eq(telecomWifiPackages.businessId, biz.id));
  if (existingPkgs.length === 0) {
    for (const p of WIFI_PACKAGE_DEFAULTS) {
      await db.insert(telecomWifiPackages).values({
        businessId: biz.id,
        branchCode: biz.code,
        name: p.name,
        durationHours: p.durationHours,
        dataCapMb: p.dataCapMb,
        priceGhs: p.priceGhs,
        routerLabel: p.routerLabel,
        active: true,
      });
      packages++;
    }
  }
  return { lines, packages };
}

/** Next sequential code for a category: BLOCK-02, BLOCK-03, … (race-tolerant). */
export function nextBusinessCode(existingCodes: string[], category: string): string {
  const prefix = CATEGORY_PREFIX[category] || "BIZ";
  let max = 0;
  for (const code of existingCodes) {
    const m = /^([A-Z]+)-(\d+)$/.exec(code || "");
    if (m && m[1] === prefix) max = Math.max(max, parseInt(m[2], 10));
  }
  return `${prefix}-${String(max + 1).padStart(2, "0")}`;
}

/**
 * Provision a freshly-created business. Idempotent per area: skips whatever
 * already exists (so it can also repair a unit whose setup went missing).
 *
 * opts.starterKit — DEMO/RECOVERY ONLY. When true, additionally seeds the
 * category starter inventory kit (booked as an opening expense against the
 * unit's capital) plus the Car Wash service catalogue / Telecom lines +
 * Wi-Fi packages. Real units created from the app NEVER pass this: they
 * start completely clean.
 */
export async function provisionBusiness(
  biz: {
    id: number;
    code: string;
    name: string;
    category: string;
    initialCapitalGhs?: number | null;
  },
  opts?: { starterKit?: boolean },
) {
  const withSamples = opts?.starterKit === true;
  const businessId = biz.id;

  // 1. Zero-based Q1 metrics — grow purely from real recorded activity.
  //    (Created first so the starter-kit value can be folded straight in.)
  const existingMetrics = await db
    .select()
    .from(businessMetrics)
    .where(eq(businessMetrics.businessId, businessId));
  if (existingMetrics.length === 0) {
    await db.insert(businessMetrics).values({
      businessId,
      period: "2026-Q1",
      revenueGhs: 0,
      expensesGhs: 0,
      netProfitGhs: 0,
      roiPercent: 0,
      cashFlowGhs: 0,
      assetsValueGhs: Number(biz.initialCapitalGhs) || 100000,
      inventoryValueGhs: 0,
      growthRatePercent: 0,
      riskScore: 20,
    });
  }

  // 2. Category starter inventory kit — SAMPLE data, seeded ONLY for
  //    demo/recovery units (opts.starterKit). Its cost value is folded into
  //    the metrics row (expenses / inventory value) — NOT booked as a
  //    transaction — so live layering never double-counts it.
  const existingInv = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.businessId, businessId));
  let kitCost = 0;
  const createdItems: any[] = [];
  if (withSamples && existingInv.length === 0) {
    const kit = KITS[biz.category] || GENERIC_KIT;
    for (const item of kit) {
      const qty = Number(item.quantity) || 0;
      const [row] = await db
        .insert(inventoryItems)
        .values({
          name: item.name,
          sku: `${biz.code}-${item.skuSuffix}`,
          businessId,
          category: item.category,
          quantity: qty,
          unit: item.unit,
          costPriceGhs: item.costPriceGhs,
          sellingPriceGhs: item.sellingPriceGhs,
          minStockThreshold: item.minStockThreshold,
          status: computeStockStatus(qty, item.minStockThreshold),
        })
        .returning();
      kitCost += qty * (Number(item.costPriceGhs) || 0);
      createdItems.push(row);
    }
    if (kitCost > 0) {
      const [metric] = await db
        .select()
        .from(businessMetrics)
        .where(eq(businessMetrics.businessId, businessId));
      if (metric) {
        await db
          .update(businessMetrics)
          .set({
            expensesGhs: Math.round(kitCost * 100) / 100,
            netProfitGhs: Math.round(-kitCost * 100) / 100,
            cashFlowGhs: Math.round(-kitCost * 100) / 100,
            inventoryValueGhs: Math.round(kitCost * 100) / 100,
          })
          .where(eq(businessMetrics.id, metric.id));
      }
    }
  }

  // 3. Full specialized daily-checklist template set for the business type.
  const existingTpl = await db
    .select()
    .from(checklistTemplates)
    .where(eq(checklistTemplates.businessId, businessId));
  let templateCount = 0;
  if (existingTpl.length === 0) {
    const seeds = tasksForBusiness(biz.code, biz.category);
    for (let i = 0; i < seeds.length; i++) {
      const t = seeds[i];
      await db.insert(checklistTemplates).values({
        businessId,
        branchCode: biz.code,
        taskKey: t.taskKey,
        taskLabel: t.taskLabel,
        category: t.category,
        sortOrder: i + 1,
        isActive: true,
      });
    }
    templateCount = seeds.length;
  }

  // 4. SAMPLE service catalogues (demo/recovery units only): Auto Car Wash
  //    units get the default service catalogue (chemical consumption
  //    auto-linked to the branch's drum when present), and Telecom units get
  //    their default MoMo agent lines + Wi-Fi packages. Never seeded into
  //    real app-created units — they start clean.
  let servicesCreated = 0;
  let telecomCreated = { lines: 0, packages: 0 };
  if (withSamples) {
    servicesCreated = await ensureCarWashServiceCatalogue({
      id: businessId,
      code: biz.code,
      category: biz.category,
    });
    telecomCreated = await ensureTelecomDefaults({
      id: businessId,
      code: biz.code,
      category: biz.category,
    });
  }

  return {
    metricsCreated: existingMetrics.length === 0,
    starterItems: createdItems.length,
    starterKitCostGhs: Math.round(kitCost * 100) / 100,
    checklistTemplates: templateCount,
    carWashServices: servicesCreated,
    telecomLines: telecomCreated.lines,
    telecomWifiPackages: telecomCreated.packages,
  };
}

/**
 * Re-provision a business after the OWNER changes its type (category).
 *
 * Keeps every existing row (history is never destroyed), then makes the unit
 * fully operational as the NEW type:
 *   • inserts any missing starter-kit SKUs for the new category (per-SKU
 *     idempotent — existing stock rows are never touched) and folds the added
 *     kit cost incrementally into the live metrics row (expenses / inventory
 *     value / net profit / cash flow)
 *   • re-points daily checklists at the new type: templates whose taskKey is
 *     not part of the new type's set are deactivated (kept in history), and
 *     missing new-type templates are created active with the unit's branch code
 */
export async function reprovisionForTypeChange(biz: {
  id: number;
  code: string;
  name: string;
  category: string; // NEW category
}) {
  const businessId = biz.id;

  // 1. NO starter stock is ever added on a type change (owner directive —
  //    units only ever hold stock a human actually entered).
  const addedItems: any[] = [];

  // 2. Checklist templates: point the unit at its new type's task set.
  const wanted = tasksForBusiness(undefined, biz.category);
  const wantedKeys = new Set(wanted.map((t) => t.taskKey));
  const existingTpls = await db
    .select()
    .from(checklistTemplates)
    .where(eq(checklistTemplates.businessId, businessId));
  const existingKeys = new Set(existingTpls.map((t) => t.taskKey));

  let deactivated = 0;
  for (const tpl of existingTpls) {
    if (!wantedKeys.has(tpl.taskKey) && tpl.isActive) {
      await db
        .update(checklistTemplates)
        .set({ isActive: false })
        .where(eq(checklistTemplates.id, tpl.id));
      deactivated++;
    } else if (wantedKeys.has(tpl.taskKey) && !tpl.isActive) {
      await db
        .update(checklistTemplates)
        .set({ isActive: true, branchCode: biz.code })
        .where(eq(checklistTemplates.id, tpl.id));
    }
  }

  let createdTpls = 0;
  for (let i = 0; i < wanted.length; i++) {
    const t = wanted[i];
    if (existingKeys.has(t.taskKey)) continue;
    await db.insert(checklistTemplates).values({
      businessId,
      branchCode: biz.code,
      taskKey: t.taskKey,
      taskLabel: t.taskLabel,
      category: t.category,
      sortOrder: i + 1,
      isActive: true,
    });
    createdTpls++;
  }

  // Re-pointed INTO a Car Wash / Telecom: make sure the catalogue / agent
  // lines + Wi-Fi packages exist too.
  const servicesCreated = await ensureCarWashServiceCatalogue({
    id: businessId,
    code: biz.code,
    category: biz.category,
  });
  await ensureTelecomDefaults({
    id: businessId,
    code: biz.code,
    category: biz.category,
  });

  return {
    kitItemsAdded: addedItems.length,
    kitCostAddedGhs: 0,
    checklistTemplatesCreated: createdTpls,
    checklistTemplatesDeactivated: deactivated,
    carWashServices: servicesCreated,
  };
}
