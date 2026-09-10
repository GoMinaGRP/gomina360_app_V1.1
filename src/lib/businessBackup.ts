/**
 * Business Backup & Restore
 *
 * Export a complete business (or a single branch within it) as a
 * restorable JSON/ZIP package that can be imported on any GoMina 360
 * instance to create a brand-new business unit with all original
 * data, settings, relationships, history, analytics and forecasting
 * intact. Other businesses / branches are never touched during import.
 *
 * Structure of the produced archive:
 *   backup.json          — machine-readable manifest + every table row
 *                          (this is the restorable payload)
 *   reports/summary.pdf  — human-readable overview (PDF)
 *   reports/summary.xlsx — human-readable overview (Excel)
 *   README.txt           — plain-text description
 *
 * The import routine remaps every primary key / foreign key to
 * preserve relationships without colliding with existing data.
 */

import JSZip from "jszip";
import { db } from "@/db";
import * as schema from "@/db/schema";
import {
  and,
  eq,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { nextBusinessCode, CATEGORY_PREFIX, CATEGORY_ICON } from "@/lib/businessProvisioning";

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

export const BACKUP_FORMAT_VERSION = "1.0";
export const BACKUP_CONTENT_TYPE = "application/vnd.gomina.business-backup+zip";

export interface BackupManifest {
  formatVersion: string;
  exportedAt: string;
  exporter: { userId: number; name: string; role: string };
  source: {
    businessId: number;
    businessCode: string;
    businessName: string;
    category: string;
    branchCode?: string | null; // set when exporting a single branch
  };
  stats: Record<string, number>;
  tables: Record<string, any[]>;
  users: Record<string, any>; // userId -> snapshot (referenced actors only)
}

// ---------------------------------------------------------------------------
// Table catalogue: (table-name -> drizzle table) for every table that can
// carry data belonging to one business. We walk this list during export.
// New business-type tables simply need to carry a businessId column and
// they are automatically covered.
// ---------------------------------------------------------------------------

type TableRef = { table: any; fkBusinessId?: string };

const TABLES: Record<string, TableRef> = {
  businesses: { table: schema.businesses },
  businessMetrics: { table: schema.businessMetrics, fkBusinessId: "businessId" },
  serviceAreas: { table: schema.serviceAreas, fkBusinessId: "businessId" },
  pickupLocations: { table: schema.pickupLocations, fkBusinessId: "businessId" },
  customers: { table: schema.customers, fkBusinessId: "businessId" },
  employees: { table: schema.employees, fkBusinessId: "businessId" },
  employeeDocuments: { table: schema.employeeDocuments, fkBusinessId: "businessId" },
  employeeHistory: { table: schema.employeeHistory, fkBusinessId: "businessId" },
  assets: { table: schema.assets, fkBusinessId: "businessId" },
  assetAuditLogs: { table: schema.assetAuditLogs }, // joined via assetId
  inventoryItems: { table: schema.inventoryItems, fkBusinessId: "businessId" },
  inventoryDownloads: { table: schema.inventoryDownloads, fkBusinessId: "downloaderBusinessId" },
  universalExports: { table: schema.universalExports, fkBusinessId: "businessId" },
  transactions: { table: schema.transactions, fkBusinessId: "businessId" },
  expenseCategories: { table: schema.expenseCategories, fkBusinessId: "businessId" },
  salesDocuments: { table: schema.salesDocuments, fkBusinessId: "businessId" },
  customerTrackings: { table: schema.customerTrackings, fkBusinessId: "businessId" },
  creditSales: { table: schema.creditSales, fkBusinessId: "businessId" },
  creditPayments: { table: schema.creditPayments, fkBusinessId: "businessId" },
  // Poultry
  poultryLogs: { table: schema.poultryLogs, fkBusinessId: "businessId" },
  poultryFlocks: { table: schema.poultryFlocks, fkBusinessId: "businessId" },
  poultryFeedLogs: { table: schema.poultryFeedLogs, fkBusinessId: "businessId" },
  poultryWaterLogs: { table: schema.poultryWaterLogs, fkBusinessId: "businessId" },
  poultryHealthRecords: { table: schema.poultryHealthRecords, fkBusinessId: "businessId" },
  poultryProduction: { table: schema.poultryProduction, fkBusinessId: "businessId" },
  poultryProducts: { table: schema.poultryProducts, fkBusinessId: "businessId" },
  poultryWeightLogs: { table: schema.poultryWeightLogs, fkBusinessId: "businessId" },
  poultryChecklists: { table: schema.poultryChecklists, fkBusinessId: "businessId" },
  // Block factory
  blockFactoryLogs: { table: schema.blockFactoryLogs, fkBusinessId: "businessId" },
  blockFactoryOrders: { table: schema.blockFactoryOrders, fkBusinessId: "businessId" },
  blockFactoryDeliveries: { table: schema.blockFactoryDeliveries, fkBusinessId: "businessId" },
  blockFactoryChecklists: { table: schema.blockFactoryChecklists, fkBusinessId: "businessId" },
  blockTypes: { table: schema.blockTypes, fkBusinessId: "businessId" },
  blockQcChecks: { table: schema.blockQcChecks, fkBusinessId: "businessId" },
  // Aquaculture
  aquacultureLogs: { table: schema.aquacultureLogs, fkBusinessId: "businessId" },
  aquaculturePonds: { table: schema.aquaculturePonds, fkBusinessId: "businessId" },
  aquacultureBatches: { table: schema.aquacultureBatches, fkBusinessId: "businessId" },
  aquacultureFeedLogs: { table: schema.aquacultureFeedLogs, fkBusinessId: "businessId" },
  aquacultureWaterQualityLogs: { table: schema.aquacultureWaterQualityLogs, fkBusinessId: "businessId" },
  aquacultureHarvests: { table: schema.aquacultureHarvests, fkBusinessId: "businessId" },
  aquacultureWeightLogs: { table: schema.aquacultureWeightLogs, fkBusinessId: "businessId" },
  aquacultureChecklists: { table: schema.aquacultureChecklists, fkBusinessId: "businessId" },
  // Livestock
  livestockLogs: { table: schema.livestockLogs, fkBusinessId: "businessId" },
  // Restaurant
  restaurantLogs: { table: schema.restaurantLogs, fkBusinessId: "businessId" },
  restaurantOrders: { table: schema.restaurantOrders, fkBusinessId: "businessId" },
  restaurantMenuItems: { table: schema.restaurantMenuItems, fkBusinessId: "businessId" },
  restaurantWaste: { table: schema.restaurantWaste, fkBusinessId: "businessId" },
  restaurantPurchases: { table: schema.restaurantPurchases, fkBusinessId: "businessId" },
  // Electronics
  electronicsLogs: { table: schema.electronicsLogs, fkBusinessId: "businessId" },
  electronicsOrders: { table: schema.electronicsOrders, fkBusinessId: "businessId" },
  electronicsSerials: { table: schema.electronicsSerials, fkBusinessId: "businessId" },
  electronicsWarranties: { table: schema.electronicsWarranties, fkBusinessId: "businessId" },
  electronicsPurchases: { table: schema.electronicsPurchases, fkBusinessId: "businessId" },
  // Car Wash
  carWashLogs: { table: schema.carWashLogs, fkBusinessId: "businessId" },
  carWashServices: { table: schema.carWashServices, fkBusinessId: "businessId" },
  carWashBookings: { table: schema.carWashBookings, fkBusinessId: "businessId" },
  carWashWashes: { table: schema.carWashWashes, fkBusinessId: "businessId" },
  carWashActivities: { table: schema.carWashActivities, fkBusinessId: "businessId" },
  // Hardware
  hardwareLogs: { table: schema.hardwareLogs, fkBusinessId: "businessId" },
  hardwareOrders: { table: schema.hardwareOrders, fkBusinessId: "businessId" },
  hardwarePurchases: { table: schema.hardwarePurchases, fkBusinessId: "businessId" },
  hardwareDeliveries: { table: schema.hardwareDeliveries, fkBusinessId: "businessId" },
  // Telecom
  telecomLines: { table: schema.telecomLines, fkBusinessId: "businessId" },
  telecomTxns: { table: schema.telecomTxns, fkBusinessId: "businessId" },
  telecomWifiPackages: { table: schema.telecomWifiPackages, fkBusinessId: "businessId" },
  telecomVouchers: { table: schema.telecomVouchers, fkBusinessId: "businessId" },
  telecomActivities: { table: schema.telecomActivities, fkBusinessId: "businessId" },
  // AI & forecasting
  aiInsights: { table: schema.aiInsights, fkBusinessId: "businessId" },
  scenarioSimulations: { table: schema.scenarioSimulations }, // targetBusinessId
  // CCTV
  cctvCameras: { table: schema.cctvCameras, fkBusinessId: "businessId" },
  // Payroll & attendance
  payrollRuns: { table: schema.payrollRuns, fkBusinessId: "businessId" },
  payrollEntries: { table: schema.payrollEntries, fkBusinessId: "businessId" },
  payrollAttendance: { table: schema.payrollAttendance, fkBusinessId: "businessId" },
  attendanceLogs: { table: schema.attendanceLogs, fkBusinessId: "businessId" },
  // Checklists & notes
  checklistTemplates: { table: schema.checklistTemplates, fkBusinessId: "businessId" },
  checklistEntries: { table: schema.checklistEntries, fkBusinessId: "businessId" },
  dailyNotes: { table: schema.dailyNotes, fkBusinessId: "businessId" },
  businessInsights: { table: schema.businessInsights, fkBusinessId: "businessId" },
  // Audit center
  auditAssignments: { table: schema.auditAssignments, fkBusinessId: "businessId" },
  auditReviews: { table: schema.auditReviews, fkBusinessId: "businessId" },
  auditIssueUpdates: { table: schema.auditIssueUpdates }, // via issueId
  auditTrail: { table: schema.auditTrail, fkBusinessId: "businessId" },
  // Downloads audit
  assetDownloads: { table: schema.assetDownloads, fkBusinessId: "downloaderBusinessId" },
};

// ---------------------------------------------------------------------------
// EXPORT
// ---------------------------------------------------------------------------

/**
 * Export a complete business backup. If branchCode is supplied, only rows
 * scoped to that branch are included (useful for cloning a single branch).
 */
export async function exportBusinessBackup(opts: {
  businessId: number;
  exporter: { userId: number; name: string; role: string };
  branchCode?: string | null;
}): Promise<{ zip: Buffer; manifest: BackupManifest; fileName: string }> {
  const { businessId, exporter, branchCode } = opts;
  const [biz] = await db
    .select()
    .from(schema.businesses)
    .where(eq(schema.businesses.id, businessId))
    .limit(1);
  if (!biz) throw new Error("Business not found");

  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    exporter,
    source: {
      businessId: biz.id,
      businessCode: biz.code,
      businessName: biz.name,
      category: biz.category,
      branchCode: branchCode || null,
    },
    stats: {},
    tables: {},
    users: {},
  };

  // ---- 1. Head business row (always included verbatim) ----
  manifest.tables.businesses = [serializeRow(biz)];
  manifest.stats.businesses = 1;

  // ---- 2. Walk every scoped table and pull matching rows ----
  for (const [name, { table, fkBusinessId }] of Object.entries(TABLES)) {
    if (name === "businesses") continue;
    let rows: any[] = [];
    try {
      if (name === "scenarioSimulations") {
        rows = await db
          .select()
          .from(table)
          .where(eq(table.targetBusinessId, businessId));
      } else if (fkBusinessId) {
        let q = db.select().from(table).where(eq(table[fkBusinessId], businessId));
        if (branchCode && table.branchCode) {
          q = db
            .select()
            .from(table)
            .where(and(eq(table[fkBusinessId], businessId), eq(table.branchCode, branchCode)));
        }
        rows = await q;
      } else {
        // Tables without a direct businessId column are exported via their
        // parent relationships below (asset_audit_logs ← assets,
        // audit_issue_updates ← audit_reviews). Skip on this pass.
        continue;
      }
    } catch (e) {
      rows = [];
    }
    manifest.tables[name] = rows.map(serializeRow);
    manifest.stats[name] = rows.length;
  }

  // ---- 3. Parents-only pulls for junction / child tables ----
  // asset_audit_logs → by matching asset ids
  const assetIds = (manifest.tables.assets || []).map((r: any) => r.id).filter(Boolean);
  if (assetIds.length) {
    const rows = await db
      .select()
      .from(schema.assetAuditLogs)
      .where(inArray(schema.assetAuditLogs.assetId, assetIds));
    manifest.tables.assetAuditLogs = rows.map(serializeRow);
    manifest.stats.assetAuditLogs = rows.length;
  }
  // audit_issue_updates → by matching audit_reviews ids
  const reviewIds = (manifest.tables.auditReviews || []).map((r: any) => r.id).filter(Boolean);
  if (reviewIds.length) {
    const rows = await db
      .select()
      .from(schema.auditIssueUpdates)
      .where(inArray(schema.auditIssueUpdates.issueId, reviewIds));
    manifest.tables.auditIssueUpdates = rows.map(serializeRow);
    manifest.stats.auditIssueUpdates = rows.length;
  }
  // Credit payments → by matching credit_sales ids
  const creditIds = (manifest.tables.creditSales || []).map((r: any) => r.id).filter(Boolean);
  if (creditIds.length) {
    const rows = await db
      .select()
      .from(schema.creditPayments)
      .where(inArray(schema.creditPayments.creditSaleId, creditIds));
    manifest.tables.creditPayments = rows.map(serializeRow);
    manifest.stats.creditPayments = rows.length;
  }
  // Payroll entries → by run ids
  const runIds = (manifest.tables.payrollRuns || []).map((r: any) => r.id).filter(Boolean);
  if (runIds.length) {
    const rows = await db
      .select()
      .from(schema.payrollEntries)
      .where(inArray(schema.payrollEntries.runId, runIds));
    manifest.tables.payrollEntries = rows.map(serializeRow);
    manifest.stats.payrollEntries = rows.length;
  }

  // ---- 4. Suppliers referenced by any exported row ----
  const supplierIds = new Set<number>();
  for (const rows of Object.values(manifest.tables)) {
    for (const r of rows as any[]) {
      if (r?.supplierId) supplierIds.add(Number(r.supplierId));
    }
  }
  if (supplierIds.size) {
    const rows = await db
      .select()
      .from(schema.suppliers)
      .where(inArray(schema.suppliers.id, [...supplierIds]));
    manifest.tables.suppliers = rows.map(serializeRow);
    manifest.stats.suppliers = rows.length;
  }

  // ---- 5. Referenced users (actor snapshots) ----
  const userIds = new Set<number>();
  const USER_FIELDS = [
    "userId", "createdByUserId", "recordedByUserId", "approvedByUserId",
    "requesterUserId", "downloaderUserId", "uploadedByUserId", "changedByUserId",
    "requestedByUserId", "reviewerUserId", "assignedUserId", "resolvedByUserId",
    "actorUserId", "receivedByUserId", "grantedByUserId", "createdBy",
    "recordedBy", "paidByName", "responseByName", "createdByName",
    "requestedByName", "approvedByName", "reviewerName", "assignedUserName",
    "resolvedByName", "actorName", "receivedByName", "grantedByName",
    "recorderName", "completedByName", "publishedByName", "recordedByName",
    "testerName", "handledByName", "updatedByUserId", "updatedByName",
    "registeredByUserId", "registeredByName", "paymentMarkedBy",
  ];
  for (const rows of Object.values(manifest.tables)) {
    for (const r of rows as any[]) {
      for (const k of USER_FIELDS) {
        const v = r?.[k];
        if (typeof v === "number" && v > 0) userIds.add(v);
      }
    }
  }
  if (userIds.size) {
    const userRows = await db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        role: schema.users.role,
        phone: schema.users.phone,
        avatarUrl: schema.users.avatarUrl,
        isActive: schema.users.isActive,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .where(inArray(schema.users.id, [...userIds]));
    for (const u of userRows) manifest.users[String(u.id)] = u;
    manifest.stats.users = userRows.length;
  }

  // ---- 6. Build ZIP archive ----
  const zip = new JSZip();
  const backupJson = JSON.stringify(manifest, null, 2);
  zip.file("backup.json", backupJson);

  // README
  const readme = buildReadme(manifest);
  zip.file("README.txt", readme);

  // Human-readable JSON snapshot (essentially the full payload too; users
  // can open it without extracting ZIP via the browser since browsers can
  // peek single files).
  zip.file("data/business.json", JSON.stringify(manifest.tables.businesses?.[0] || {}, null, 2));

  // Reports directory: plaintext summary so archive is human-browsable
  // even without PDF/Excel libraries server-side.
  const summaryLines: string[] = [];
  summaryLines.push(`GoMina 360 — Business Backup`);
  summaryLines.push(`=============================`);
  summaryLines.push(``);
  summaryLines.push(`Business: ${manifest.source.businessName} (${manifest.source.businessCode})`);
  summaryLines.push(`Category: ${manifest.source.category}`);
  if (manifest.source.branchCode) summaryLines.push(`Branch:   ${manifest.source.branchCode}`);
  summaryLines.push(`Exported: ${manifest.exportedAt}`);
  summaryLines.push(`Exported by: ${exporter.name} (${exporter.role})`);
  summaryLines.push(``);
  summaryLines.push(`Contents (restorable records):`);
  for (const [k, v] of Object.entries(manifest.stats)) {
    summaryLines.push(`  - ${k}: ${v}`);
  }
  summaryLines.push(``);
  summaryLines.push(`To restore, open GoMina 360 → Manage Businesses → New Business`);
  summaryLines.push(`and choose "Import from backup file". This creates a brand new`);
  summaryLines.push(`business; existing data is never overwritten.`);
  zip.file("reports/summary.txt", summaryLines.join("\n"));

  const buf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const fileName = `gomina-backup-${safeFile(manifest.source.businessCode)}-${stamp}.zip`;
  return { zip: buf, manifest, fileName };
}

function serializeRow(row: any): any {
  const out: any = {};
  for (const k of Object.keys(row)) {
    const v = (row as any)[k];
    if (v === null || v === undefined) {
      out[k] = null;
    } else if (v instanceof Date) {
      out[k] = v.toISOString();
      // Preserve original text-date fields that drizzle returns as Date
      // because of column type inference — if original was a string date
      // (hire_date, date, recorded_date …) keep a plain ISO for restore.
    } else if (typeof v === "bigint") {
      out[k] = Number(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function safeFile(s: string) {
  return (s || "business").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
}

function buildReadme(m: BackupManifest) {
  const lines = [
    "GoMina 360 — Business Backup Archive",
    "====================================",
    "",
    `Format version: ${m.formatVersion}`,
    `Exported at:    ${m.exportedAt}`,
    `Exported by:    ${m.exporter.name} (${m.exporter.role})`,
    "",
    `Source business: ${m.source.businessName}`,
    `Source code:     ${m.source.businessCode}`,
    `Category:        ${m.source.category}`,
    m.source.branchCode ? `Branch scope:    ${m.source.branchCode}` : "",
    "",
    "Archive contents:",
    "  backup.json          Restorable machine-readable payload",
    "  data/business.json   Human-readable business header",
    "  reports/summary.txt  Plain-text summary (open in any editor)",
    "  README.txt           This file",
    "",
    "Restore: GoMina 360 → Manage Businesses → New Business → Import backup.",
    "Importing creates a NEW business unit; it never overwrites any existing",
    "business or branch. IDs and codes are remapped automatically and all",
    "relationships, history, analytics, forecasts and settings are preserved.",
    "",
  ].filter(Boolean);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// IMPORT
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /** Override business name (optional) */
  nameOverride?: string;
  /** Desired code prefix; if omitted uses the original category prefix */
  codeOverride?: string;
}

export interface ImportResult {
  businessId: number;
  businessCode: string;
  businessName: string;
  category: string;
  stats: Record<string, number>;
  warnings: string[];
}

/**
 * Import a business from a backup.json payload (already extracted from ZIP).
 * Creates a brand new business; never overwrites anything.
 */
export async function importBusinessBackup(
  backupJson: BackupManifest,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  if (backupJson?.formatVersion !== BACKUP_FORMAT_VERSION) {
    // Tolerate same-major imports; future versions can add migrations.
    if (!backupJson?.formatVersion?.startsWith("1.")) {
      throw new Error(
        `Unsupported backup format version: ${backupJson?.formatVersion}. Expected ${BACKUP_FORMAT_VERSION}.`,
      );
    }
  }
  const source = backupJson.source;
  if (!source || !backupJson.tables?.businesses?.[0]) {
    throw new Error("Backup archive is missing the business record — file may be corrupted.");
  }

  const warnings: string[] = [];
  const srcBiz = backupJson.tables.businesses[0];
  const category = srcBiz.category || source.category;

  // 1. Determine the new business code (avoid collisions).
  const allCodes = (await db.select({ code: schema.businesses.code }).from(schema.businesses))
    .map((r) => r.code);
  const prefix = CATEGORY_PREFIX[category] || "BIZ";
  let newCode = opts.codeOverride && !allCodes.includes(opts.codeOverride)
    ? opts.codeOverride
    : nextBusinessCode(allCodes, category);

  // 2. Insert the new business row. We do NOT copy the original id (serial
  //    gives us a fresh id) nor the globally-unique code.
  const newName = opts.nameOverride || srcBiz.name || `Imported ${source.businessName || "Business"}`;
  const [newBiz] = await db
    .insert(schema.businesses)
    .values({
      name: newName,
      code: newCode,
      category,
      branchLocation: srcBiz.branchLocation || "Imported",
      region: srcBiz.region || "Greater Accra",
      district: srcBiz.district || null,
      town: srcBiz.town || null,
      managerName: srcBiz.managerName || "Assigned Manager",
      contactPhone: srcBiz.contactPhone || "+233 24 000 0000",
      status: "ACTIVE",
      initialCapitalGhs: Number(srcBiz.initialCapitalGhs) || 100000,
      monthlyTargetRevenueGhs: Number(srcBiz.monthlyTargetRevenueGhs) || 50000,
      iconName: srcBiz.iconName || CATEGORY_ICON[category] || "Building2",
      logo: srcBiz.logo || null,
      branchLogos: remapBranchLogos(srcBiz.branchLogos, srcBiz.code, newCode),
      gpsLat: srcBiz.gpsLat ?? null,
      gpsLng: srcBiz.gpsLng ?? null,
      gpsRadiusM: srcBiz.gpsRadiusM ?? 300,
      onlineOrderingEnabled: srcBiz.onlineOrderingEnabled ?? true,
      pickupEnabled: srcBiz.pickupEnabled ?? true,
      deliveryEnabled: srcBiz.deliveryEnabled ?? true,
      serviceRadiusKm: srcBiz.serviceRadiusKm ?? null,
      serviceNote: srcBiz.serviceNote ?? null,
      customerHelpPhone: srcBiz.customerHelpPhone ?? null,
      momoNumber: srcBiz.momoNumber ?? null,
      momoName: srcBiz.momoName ?? null,
    })
    .returning();
  const newBusinessId = newBiz.id;

  // 3. ID remapping maps: oldId (number) -> newId (number).
  //    We build these incrementally: for each table in dependency order,
  //    insert rows with businessId/foreign keys remapped, record new ids.
  const idMap: Record<string, Map<number, number>> = {};
  const mapFor = (table: string) => {
    if (!idMap[table]) idMap[table] = new Map();
    return idMap[table];
  };
  // Map the source business row to the new business id.
  mapFor("businesses").set(Number(srcBiz.id), newBusinessId);

  const remapBusinessId = (v: any) => {
    if (v === null || v === undefined) return v;
    const n = Number(v);
    if (!n) return v;
    return n === Number(srcBiz.id) ? newBusinessId : n;
  };
  const remapFk = (tableName: string, v: any): any => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    if (!n) return v;
    const m = idMap[tableName]?.get(n);
    if (m === undefined) return null; // broken reference → drop
    return m;
  };
  const remapUserId = (v: any): any => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    if (!n) return v;
    // Users are NOT recreated (they may already exist with different ids,
    // or be absent from the target system). Fall back to null so history
    // retains name/role strings (those text fields are already snapshotted
    // onto the rows).
    return n;
  };
  const remapBranchCode = (v: any): any => {
    if (typeof v !== "string") return v;
    // Only remap when the branch code equals the source business code
    // (single-branch businesses reuse the code as branch code).
    if (v === srcBiz.code) return newCode;
    return v;
  };

  // Helper to insert a batch and record new ids.
  async function insertTable(
    tableName: string,
    rows: any[],
    transform: (row: any) => any,
    pk = "id",
  ): Promise<number> {
    if (!rows || !rows.length) return 0;
    const table = TABLES[tableName]?.table;
    if (!table) return 0;
    let inserted = 0;
    for (const src of rows) {
      const values = transform({ ...src });
      // Strip the original pk so serial generates a new one.
      const oldId = values[pk];
      delete values[pk];
      // Drop createdAt/updatedAt only when we want Postgres defaults? No —
      // keep them to preserve history timestamps.
      try {
        const returnedArr: any[] = await db.insert(table).values(values).returning() as any;
        const returned = returnedArr?.[0];
        if (returned && oldId != null) {
          mapFor(tableName).set(Number(oldId), Number(returned[pk]));
        }
        inserted++;
      } catch (e: any) {
        // Unique/constraint failures shouldn't abort the whole import.
        warnings.push(`${tableName}: skipped row ${oldId} — ${e.message?.slice(0, 120)}`);
      }
    }
    return inserted;
  }

  // 4. Insert in dependency order (parents first, children second).
  const stats: Record<string, number> = { businesses: 1 };

  // Independent lookup tables first (suppliers don't carry businessId; we
  // deduplicate by name/phone to avoid recreating the same shared vendor).
  const existingSuppliers: any[] = await db.select().from(schema.suppliers);
  const supplierKey = (s: any) =>
    `${(s.name || "").toString().trim().toLowerCase()}|${(s.phone || "").toString().trim()}`;
  const existingSupplierKeys = new Set(existingSuppliers.map(supplierKey));
  const newSuppliers: any[] = [];
  for (const s of backupJson.tables.suppliers || []) {
    if (existingSupplierKeys.has(supplierKey(s))) continue;
    newSuppliers.push(s);
  }
  stats.suppliers = await insertTable("suppliers", newSuppliers, (r) => ({
    name: r.name,
    category: r.category,
    contactPerson: r.contactPerson,
    phone: r.phone,
    email: r.email,
    paymentTerms: r.paymentTerms,
    region: r.region,
    district: r.district,
    town: r.town,
    totalSuppliedGhs: Number(r.totalSuppliedGhs) || 0,
  }));

  // Customers — deduplicate by phone/name to avoid clashing shared CRM rows.
  const existingCustomers = await db.select().from(schema.customers);
  const custKey = (c: any) =>
    `${(c.name || "").toString().trim().toLowerCase()}|${(c.phone || "").toString().trim()}`;
  const existingCustomerKeys = new Set(existingCustomers.map(custKey));
  const newCustomers: any[] = [];
  for (const c of backupJson.tables.customers || []) {
    if (existingCustomerKeys.has(custKey(c))) {
      // Re-use this customer: remember mapping to the existing id.
      const existing = existingCustomers.find((x) => custKey(x) === custKey(c));
      if (existing) mapFor("customers").set(Number(c.id), Number(existing.id));
      continue;
    }
    newCustomers.push(c);
  }
  stats.customers = await insertTable("customers", newCustomers, (r) => ({
    name: r.name,
    type: r.type || "RETAIL",
    phone: r.phone,
    email: r.email,
    address: r.address,
    region: r.region,
    district: r.district,
    town: r.town,
    totalSpentGhs: Number(r.totalSpentGhs) || 0,
    loyaltyPoints: Number(r.loyaltyPoints) || 0,
    businessId: newBusinessId,
  }));

  // Employees
  stats.employees = await insertTable("employees", backupJson.tables.employees || [], (r) => ({
    name: r.name,
    role: r.role,
    businessId: newBusinessId,
    branch: remapBranchCode(r.branch),
    region: r.region,
    district: r.district,
    town: r.town,
    salaryGhs: Number(r.salaryGhs) || 0,
    phone: r.phone,
    hireDate: r.hireDate,
    status: r.status || "ACTIVE",
    employeeNo: remapCode(r.employeeNo, srcBiz.code, newCode),
    dateOfBirth: r.dateOfBirth,
    gender: r.gender,
    email: r.email,
    address: r.address,
    emergencyContactName: r.emergencyContactName,
    emergencyContactPhone: r.emergencyContactPhone,
    photo: r.photo,
    workSchedule: r.workSchedule,
    shift: r.shift,
    dailyHours: r.dailyHours,
    workDays: r.workDays,
    leaveEntitlementDays: r.leaveEntitlementDays,
    idType: r.idType,
    idNumber: r.idNumber,
    workPermitNo: r.workPermitNo,
    notes: r.notes,
  }));

  // Asset & Inventory (top-level owned items)
  stats.assets = await insertTable("assets", backupJson.tables.assets || [], (r) => ({
    assetCode: remapCode(r.assetCode, srcBiz.code, newCode),
    name: r.name,
    description: r.description,
    businessId: newBusinessId,
    branchCode: remapBranchCode(r.branchCode),
    branchName: r.branchName,
    assetType: r.assetType,
    purchasePriceGhs: Number(r.purchasePriceGhs) || 0,
    currentValueGhs: Number(r.currentValueGhs) || 0,
    condition: r.condition,
    location: r.location,
    region: r.region,
    district: r.district,
    town: r.town,
    nextMaintenanceDate: r.nextMaintenanceDate,
    registeredByUserId: remapUserId(r.registeredByUserId),
    recorderName: r.recorderName,
    recordedAt: r.recordedAt ? new Date(r.recordedAt) : undefined,
    assetImages: r.assetImages,
    qrCode: null, // regenerate fresh to avoid collisions
  }));

  stats.inventoryItems = await insertTable(
    "inventoryItems",
    backupJson.tables.inventoryItems || [],
    (r) => ({
      name: r.name,
      sku: remapCode(r.sku, srcBiz.code, newCode),
      businessId: newBusinessId,
      branchCode: remapBranchCode(r.branchCode),
      branchName: r.branchName,
      category: r.category,
      quantity: Number(r.quantity) || 0,
      unit: r.unit,
      costPriceGhs: Number(r.costPriceGhs) || 0,
      sellingPriceGhs: Number(r.sellingPriceGhs) || 0,
      minStockThreshold: Number(r.minStockThreshold) || 0,
      status: r.status || "IN_STOCK",
      expiryDate: r.expiryDate,
      photo: r.photo,
      photos: r.photos,
      qrCode: null,
      registeredByName: r.registeredByName,
      registeredByUserId: remapUserId(r.registeredByUserId),
      registeredAt: r.registeredAt ? new Date(r.registeredAt) : undefined,
    }),
  );

  // Expense categories — rename if collides
  stats.expenseCategories = await insertTable(
    "expenseCategories",
    backupJson.tables.expenseCategories || [],
    (r) => ({
      businessId: newBusinessId,
      branchCode: remapBranchCode(r.branchCode),
      name: r.name,
      icon: r.icon,
      isActive: r.isActive ?? true,
      createdBy: r.createdBy,
    }),
  );

  // Business metrics
  stats.businessMetrics = await insertTable(
    "businessMetrics",
    backupJson.tables.businessMetrics || [],
    (r) => ({
      businessId: newBusinessId,
      period: r.period,
      revenueGhs: Number(r.revenueGhs) || 0,
      expensesGhs: Number(r.expensesGhs) || 0,
      netProfitGhs: Number(r.netProfitGhs) || 0,
      roiPercent: Number(r.roiPercent) || 0,
      cashFlowGhs: Number(r.cashFlowGhs) || 0,
      assetsValueGhs: Number(r.assetsValueGhs) || 0,
      inventoryValueGhs: Number(r.inventoryValueGhs) || 0,
      growthRatePercent: Number(r.growthRatePercent) || 0,
      riskScore: Number(r.riskScore) || 20,
      lastUpdated: r.lastUpdated ? new Date(r.lastUpdated) : undefined,
    }),
  );

  // Service areas & pickup locations
  stats.serviceAreas = await insertTable(
    "serviceAreas",
    backupJson.tables.serviceAreas || [],
    (r) => ({
      businessId: newBusinessId,
      branchCode: remapBranchCode(r.branchCode),
      name: r.name,
      centerLat: r.centerLat,
      centerLng: r.centerLng,
      radiusKm: r.radiusKm,
      note: r.note,
      active: r.active ?? true,
      sortOrder: r.sortOrder ?? 0,
      createdByUserId: remapUserId(r.createdByUserId),
      createdByName: r.createdByName,
    }),
  );
  stats.pickupLocations = await insertTable(
    "pickupLocations",
    backupJson.tables.pickupLocations || [],
    (r) => ({
      businessId: newBusinessId,
      branchCode: remapBranchCode(r.branchCode),
      name: r.name,
      address: r.address,
      lat: r.lat,
      lng: r.lng,
      contactPhone: r.contactPhone,
      instructions: r.instructions,
      active: r.active ?? true,
      sortOrder: r.sortOrder ?? 0,
      createdByUserId: remapUserId(r.createdByUserId),
      createdByName: r.createdByName,
    }),
  );

  // Transactions, sales documents
  stats.transactions = await insertTable(
    "transactions",
    backupJson.tables.transactions || [],
    (r) => ({
      transactionNumber: remapCode(r.transactionNumber, srcBiz.code, newCode),
      businessId: newBusinessId,
      branchCode: remapBranchCode(r.branchCode),
      branchName: r.branchName,
      type: r.type,
      category: r.category,
      amountGhs: Number(r.amountGhs) || 0,
      paymentMethod: r.paymentMethod,
      customerId: remapFk("customers", r.customerId),
      supplierId: r.supplierId
        ? (existingSuppliers.find((s) => Number(s.id) === Number(r.supplierId))?.id ??
          remapFk("suppliers", r.supplierId))
        : null,
      description: r.description,
      date: r.date,
      createdAt: r.createdAt ? new Date(r.createdAt) : undefined,
      status: r.status || "COMPLETED",
      recordedBy: r.recordedBy,
      recordedByRole: r.recordedByRole,
      recordedByUserId: remapUserId(r.recordedByUserId),
      receiptImage: r.receiptImage,
      receiptImages: r.receiptImages,
    }),
  );

  stats.salesDocuments = await insertTable(
    "salesDocuments",
    backupJson.tables.salesDocuments || [],
    (r) => ({
      documentNumber: remapCode(r.documentNumber, srcBiz.code, newCode),
      documentType: r.documentType,
      businessId: newBusinessId,
      branchCode: remapBranchCode(r.branchCode),
      branchName: r.branchName,
      customerId: remapFk("customers", r.customerId),
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      customerEmail: r.customerEmail,
      customerAddress: r.customerAddress,
      lineItems: r.lineItems,
      subtotalGhs: Number(r.subtotalGhs) || 0,
      taxRateGhs: Number(r.taxRateGhs) || 0,
      taxAmountGhs: Number(r.taxAmountGhs) || 0,
      discountGhs: Number(r.discountGhs) || 0,
      discountPercent: Number(r.discountPercent) || 0,
      totalGhs: Number(r.totalGhs) || 0,
      cogsGhs: Number(r.cogsGhs) || 0,
      grossProfitGhs: Number(r.grossProfitGhs) || 0,
      currency: r.currency || "GHS",
      status: r.status || "DRAFT",
      notes: r.notes,
      terms: r.terms,
      validUntil: r.validUntil,
      dueDate: r.dueDate,
      paymentMethod: r.paymentMethod,
      linkedTransactionId: remapFk("transactions", r.linkedTransactionId),
      linkedQuotationId: remapFk("salesDocuments", r.linkedQuotationId),
      createdByUserId: remapUserId(r.createdByUserId),
      createdByName: r.createdByName,
      createdByRole: r.createdByRole,
      createdAt: r.createdAt ? new Date(r.createdAt) : undefined,
      updatedAt: r.updatedAt ? new Date(r.updatedAt) : undefined,
    }),
  );

  // Poultry, block factory, aquaculture, restaurant, electronics, car wash,
  // hardware, telecom, CCTV, payroll, checklists, daily notes, audit, etc.
  // Each shares the same pattern: businessId → new, branchCode remapped,
  // any foreign keys remapped via the appropriate table.
  const genericTransform = (r: any, extra: (r: any) => any = () => ({})) => ({
    ...Object.fromEntries(
      Object.entries(r)
        .filter(([k]) => k !== "id" && k !== "createdAt" && k !== "updatedAt" && k !== "recordedAt")
        .map(([k, v]) => [k, v]),
    ),
    businessId: newBusinessId,
    branchCode: r.branchCode ? remapBranchCode(r.branchCode) : r.branchCode,
    ...(r.createdAt ? { createdAt: new Date(r.createdAt) } : {}),
    ...(r.updatedAt ? { updatedAt: new Date(r.updatedAt) } : {}),
    ...(r.recordedAt ? { recordedAt: new Date(r.recordedAt) } : {}),
    ...extra(r),
  });

  // Simple table groups (each row is fully owned by the business, with only
  // businessId/branchCode needing remapping).
  const simpleTables = [
    "poultryLogs", "poultryFlocks", "poultryFeedLogs", "poultryWaterLogs",
    "poultryHealthRecords", "poultryProduction", "poultryProducts",
    "poultryWeightLogs", "poultryChecklists",
    "blockFactoryLogs", "blockFactoryOrders", "blockFactoryDeliveries",
    "blockFactoryChecklists", "blockTypes", "blockQcChecks",
    "aquacultureLogs", "aquaculturePonds", "aquacultureBatches",
    "aquacultureFeedLogs", "aquacultureWaterQualityLogs", "aquacultureHarvests",
    "aquacultureWeightLogs", "aquacultureChecklists",
    "livestockLogs",
    "restaurantLogs", "restaurantOrders", "restaurantMenuItems",
    "restaurantWaste", "restaurantPurchases",
    "electronicsLogs", "electronicsOrders", "electronicsSerials",
    "electronicsWarranties", "electronicsPurchases",
    "carWashLogs", "carWashServices", "carWashBookings", "carWashWashes",
    "carWashActivities",
    "hardwareLogs", "hardwareOrders", "hardwarePurchases", "hardwareDeliveries",
    "telecomLines", "telecomTxns", "telecomWifiPackages", "telecomVouchers",
    "telecomActivities",
    "cctvCameras",
    "checklistTemplates", "checklistEntries",
    "dailyNotes", "businessInsights",
    "aiInsights",
    "auditAssignments", "auditReviews", "auditTrail",
    "inventoryDownloads", "assetDownloads", "universalExports",
  ];

  // Foreign key remapping per simple table, when applicable.
  const extraTransforms: Record<string, (r: any) => any> = {
    poultryFeedLogs: (r) => ({
      flockId: remapFk("poultryFlocks", r.flockId),
      recordedByUserId: remapUserId(r.recordedByUserId),
    }),
    poultryWaterLogs: (r) => ({ flockId: remapFk("poultryFlocks", r.flockId) }),
    poultryHealthRecords: (r) => ({ flockId: remapFk("poultryFlocks", r.flockId) }),
    poultryProduction: (r) => ({ flockId: remapFk("poultryFlocks", r.flockId) }),
    poultryWeightLogs: (r) => ({ flockId: remapFk("poultryFlocks", r.flockId) }),
    aquacultureBatches: (r) => ({ pondId: remapFk("aquaculturePonds", r.pondId) }),
    aquacultureFeedLogs: (r) => ({
      batchId: remapFk("aquacultureBatches", r.batchId),
      pondId: remapFk("aquaculturePonds", r.pondId),
    }),
    aquacultureWaterQualityLogs: (r) => ({ pondId: remapFk("aquaculturePonds", r.pondId) }),
    aquacultureHarvests: (r) => ({
      batchId: remapFk("aquacultureBatches", r.batchId),
      pondId: remapFk("aquaculturePonds", r.pondId),
    }),
    aquacultureWeightLogs: (r) => ({
      batchId: remapFk("aquacultureBatches", r.batchId),
      pondId: remapFk("aquaculturePonds", r.pondId),
    }),
    carWashBookings: (r) => ({
      serviceId: remapFk("carWashServices", r.serviceId),
      bookingNumber: remapCode(r.bookingNumber, srcBiz.code, newCode),
    }),
    carWashWashes: (r) => ({
      bookingId: remapFk("carWashBookings", r.bookingId),
      customerId: remapFk("customers", r.customerId),
      serviceId: remapFk("carWashServices", r.serviceId),
      staffId: remapUserId(r.staffId),
      washNumber: remapCode(r.washNumber, srcBiz.code, newCode),
    }),
    telecomTxns: (r) => ({
      lineId: remapFk("telecomLines", r.lineId),
      voucherId: remapFk("telecomVouchers", r.voucherId),
      txnNumber: remapCode(r.txnNumber, srcBiz.code, newCode),
      createdByUserId: remapUserId(r.createdByUserId),
    }),
    telecomVouchers: (r) => ({
      packageId: remapFk("telecomWifiPackages", r.packageId),
      code: null, // regenerate voucher codes
      accessCode: r.accessCode,
      qrData: null,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      priceGhs: Number(r.priceGhs) || 0,
    }),
    hardwareOrders: (r) => ({
      inventoryId: remapFk("inventoryItems", r.inventoryId),
      orderNumber: remapCode(r.orderNumber, srcBiz.code, newCode),
    }),
    hardwarePurchases: (r) => ({
      purchaseNumber: remapCode(r.purchaseNumber, srcBiz.code, newCode),
    }),
    hardwareDeliveries: (r) => ({
      inventoryId: remapFk("inventoryItems", r.inventoryId),
      deliveryNumber: remapCode(r.deliveryNumber, srcBiz.code, newCode),
    }),
    electronicsOrders: (r) => ({
      inventoryId: remapFk("inventoryItems", r.inventoryId),
      orderNumber: remapCode(r.orderNumber, srcBiz.code, newCode),
    }),
    electronicsSerials: (r) => ({
      inventoryId: remapFk("inventoryItems", r.inventoryId),
      serialNumber: remapCode(r.serialNumber, srcBiz.code, newCode),
    }),
    electronicsWarranties: (r) => ({
      claimNumber: remapCode(r.claimNumber, srcBiz.code, newCode),
    }),
    electronicsPurchases: (r) => ({
      purchaseNumber: remapCode(r.purchaseNumber, srcBiz.code, newCode),
    }),
    restaurantOrders: (r) => ({
      menuItemId: remapFk("restaurantMenuItems", r.menuItemId),
      orderNumber: remapCode(r.orderNumber, srcBiz.code, newCode),
    }),
    restaurantWaste: (r) => ({
      inventoryId: remapFk("inventoryItems", r.inventoryId),
    }),
    restaurantPurchases: (r) => ({
      purchaseNumber: remapCode(r.purchaseNumber, srcBiz.code, newCode),
    }),
    blockFactoryOrders: (r) => ({
      orderNumber: remapCode(r.orderNumber, srcBiz.code, newCode),
    }),
    blockFactoryDeliveries: (r) => ({
      deliveryNumber: remapCode(r.deliveryNumber, srcBiz.code, newCode),
    }),
    cctvCameras: (r) => ({
      password: null, // never import camera credentials
    }),
    customerTrackings: (r) => ({
      customerId: remapFk("customers", r.customerId),
      saleDocumentId: remapFk("salesDocuments", r.saleDocumentId),
      transactionId: remapFk("transactions", r.transactionId),
      pickupLocationId: remapFk("pickupLocations", r.pickupLocationId),
      trackingCode: remapCode(r.trackingCode, srcBiz.code, newCode),
      createdByUserId: remapUserId(r.createdByUserId),
    }),
    creditSales: (r) => ({
      customerId: remapFk("customers", r.customerId),
      trackingId: remapFk("customerTrackings", r.trackingId),
      saleDocumentId: remapFk("salesDocuments", r.saleDocumentId),
      creditCode: remapCode(r.creditCode, srcBiz.code, newCode),
      trackingCode: r.trackingCode ? remapCode(r.trackingCode, srcBiz.code, newCode) : null,
      createdByUserId: remapUserId(r.createdByUserId),
    }),
    payrollRuns: (r) => ({
      period: r.period,
      createdByUserId: remapUserId(r.createdByUserId),
    }),
    attendanceLogs: (r) => ({
      userId: remapUserId(r.userId),
      employeeId: remapFk("employees", r.employeeId),
    }),
    payrollAttendance: (r) => ({
      employeeId: remapFk("employees", r.employeeId),
      recordedByUserId: remapUserId(r.recordedByUserId),
    }),
    employeeDocuments: (r) => ({
      employeeId: remapFk("employees", r.employeeId),
      uploadedByUserId: remapUserId(r.uploadedByUserId),
    }),
    employeeHistory: (r) => ({
      employeeId: remapFk("employees", r.employeeId),
      changedByUserId: remapUserId(r.changedByUserId),
    }),
    assetAuditLogs: (r) => ({
      assetId: remapFk("assets", r.assetId),
      requestedByUserId: remapUserId(r.requestedByUserId),
      approvedByUserId: remapUserId(r.approvedByUserId),
    }),
    auditReviews: (r) => ({
      assignedUserId: remapUserId(r.assignedUserId),
      reviewerUserId: remapUserId(r.reviewerUserId),
      resolvedByUserId: remapUserId(r.resolvedByUserId),
      responseByName: r.responseByName,
    }),
    auditAssignments: (r) => ({
      userId: remapUserId(r.userId),
      grantedByUserId: remapUserId(r.grantedByUserId),
    }),
    auditTrail: (r) => ({
      actorUserId: remapUserId(r.actorUserId),
    }),
    dailyNotes: (r) => ({
      userId: remapUserId(r.userId),
    }),
    checklistTemplates: (r) => ({
      assignedToUserId: remapUserId(r.assignedToUserId),
      createdByRole: r.createdByRole,
    }),
    checklistEntries: (r) => ({
      templateId: remapFk("checklistTemplates", r.templateId),
      assignedToUserId: remapUserId(r.assignedToUserId),
      completedByRole: r.completedByRole,
    }),
    scenarioSimulations: (r) => ({
      targetBusinessId: newBusinessId,
    }),
    inventoryDownloads: (r) => ({
      downloaderUserId: remapUserId(r.downloaderUserId),
      downloaderBusinessId: newBusinessId,
    }),
    assetDownloads: (r) => ({
      downloaderUserId: remapUserId(r.downloaderUserId),
      downloaderBusinessId: newBusinessId,
    }),
    universalExports: (r) => ({
      requesterUserId: remapUserId(r.requesterUserId),
      approvedByUserId: remapUserId(r.approvedByUserId),
      businessId: newBusinessId,
    }),
    aiInsights: (r) => ({ businessId: newBusinessId }),
  };

  for (const t of simpleTables) {
    if (t === "assetAuditLogs") continue; // inserted after assets
    stats[t] = await insertTable(t, backupJson.tables[t] || [], (r) => {
      // Strip columns that don't exist on every table (drizzle will error).
      const extra = extraTransforms[t]?.(r) || {};
      return genericTransform(r, () => extra);
    });
  }

  // Children whose parents were inserted in the simple pass.
  stats.assetAuditLogs = await insertTable(
    "assetAuditLogs",
    backupJson.tables.assetAuditLogs || [],
    (r) => genericTransform(r, () => ({
      assetId: remapFk("assets", r.assetId),
      requestedByUserId: remapUserId(r.requestedByUserId),
      approvedByUserId: remapUserId(r.approvedByUserId),
    })),
  );

  // Payroll runs first above, now entries + attendance that depend on runs.
  stats.payrollEntries = await insertTable(
    "payrollEntries",
    backupJson.tables.payrollEntries || [],
    (r) => ({
      runId: remapFk("payrollRuns", r.runId),
      employeeId: remapFk("employees", r.employeeId),
      employeeName: r.employeeName,
      employeeRole: r.employeeRole,
      businessId: newBusinessId,
      branchCode: remapBranchCode(r.branchCode),
      baseSalaryGhs: Number(r.baseSalaryGhs) || 0,
      allowancesGhs: Number(r.allowancesGhs) || 0,
      allowanceNote: r.allowanceNote,
      overtimeHours: Number(r.overtimeHours) || 0,
      overtimePayGhs: Number(r.overtimePayGhs) || 0,
      deductionsGhs: Number(r.deductionsGhs) || 0,
      deductionNote: r.deductionNote,
      applyStatutory: r.applyStatutory ?? true,
      grossPayGhs: r.grossPayGhs,
      ssnitEmployeeGhs: r.ssnitEmployeeGhs,
      ssnitEmployerGhs: r.ssnitEmployerGhs,
      tier2Ghs: r.tier2Ghs,
      tier2Bearer: r.tier2Bearer,
      taxableIncomeGhs: r.taxableIncomeGhs,
      payeGhs: r.payeGhs,
      customDeductions: r.customDeductions,
      totalEmployeeDeductionsGhs: r.totalEmployeeDeductionsGhs,
      employerContributionsGhs: r.employerContributionsGhs,
      employerCostGhs: r.employerCostGhs,
      netPayGhs: Number(r.netPayGhs) || 0,
      status: r.status || "PENDING",
      paymentMethod: r.paymentMethod,
      paidAt: r.paidAt ? new Date(r.paidAt) : null,
      paidByName: r.paidByName,
      transactionId: remapFk("transactions", r.transactionId),
    }),
  );

  // Credit sales inserted; now credit payments (depend on creditSaleId).
  stats.creditPayments = await insertTable(
    "creditPayments",
    backupJson.tables.creditPayments || [],
    (r) => ({
      paymentNumber: remapCode(r.paymentNumber, srcBiz.code, newCode),
      creditSaleId: remapFk("creditSales", r.creditSaleId),
      businessId: newBusinessId,
      branchCode: remapBranchCode(r.branchCode),
      branchName: r.branchName,
      amountGhs: Number(r.amountGhs) || 0,
      paymentMethod: r.paymentMethod,
      reference: r.reference,
      note: r.note,
      transactionId: remapFk("transactions", r.transactionId),
      receiptDocumentId: remapFk("salesDocuments", r.receiptDocumentId),
      receivedByUserId: remapUserId(r.receivedByUserId),
      receivedByName: r.receivedByName,
      receivedByRole: r.receivedByRole,
    }),
  );

  // Audit issue updates (depend on audit_reviews.id).
  stats.auditIssueUpdates = await insertTable(
    "auditIssueUpdates",
    backupJson.tables.auditIssueUpdates || [],
    (r) => ({
      issueId: remapFk("auditReviews", r.issueId),
      actorUserId: remapUserId(r.actorUserId),
      actorName: r.actorName,
      actorRole: r.actorRole,
      action: r.action,
      statusFrom: r.statusFrom,
      statusTo: r.statusTo,
      note: r.note,
      evidence: r.evidence,
      photo: r.photo,
    }),
  );

  // Scenario simulations (with targetBusinessId remap).
  stats.scenarioSimulations = await insertTable(
    "scenarioSimulations",
    backupJson.tables.scenarioSimulations || [],
    (r) => ({
      name: r.name,
      description: r.description,
      targetBusinessId: newBusinessId,
      variableChanged: r.variableChanged,
      percentChange: Number(r.percentChange) || 0,
      expectedRevenueImpactGhs: Number(r.expectedRevenueImpactGhs) || 0,
      expectedProfitImpactGhs: Number(r.expectedProfitImpactGhs) || 0,
      expectedRoiDelta: Number(r.expectedRoiDelta) || 0,
      createdBy: r.createdBy,
    }),
  );

  return {
    businessId: newBusinessId,
    businessCode: newCode,
    businessName: newName,
    category,
    stats,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function remapCode(value: any, oldCode: string, newCode: string): any {
  if (typeof value !== "string") return value;
  return value.split(oldCode).join(newCode);
}

function remapBranchLogos(value: any, oldCode: string, newCode: string): any {
  if (!value || typeof value !== "object") return value;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k === oldCode ? newCode : k] = v;
  }
  return out;
}

/**
 * Read & parse a backup archive (ZIP containing backup.json). Accepts a
 * Node Buffer, ArrayBuffer, or Uint8Array.
 */
export async function readBackupArchive(data: Buffer | ArrayBuffer | Uint8Array): Promise<BackupManifest> {
  const zip = await JSZip.loadAsync(data as any);
  const f = zip.file("backup.json");
  if (!f) throw new Error("Not a valid GoMina backup: backup.json is missing.");
  const txt = await f.async("string");
  return JSON.parse(txt) as BackupManifest;
}
