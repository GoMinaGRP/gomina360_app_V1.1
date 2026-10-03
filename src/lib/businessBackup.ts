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
 *   reads/summary.txt    — human-readable overview
 *   README.txt           — plain-text description
 *
 * The import routine remaps every primary key / foreign key to
 * preserve relationships without colliding with existing data.
 *
 * ---------------------------------------------------------------------------
 * ISOLATION CONTRACT (audited)
 * ---------------------------------------------------------------------------
 * EXPORT carries the business row plus every row of every business-scoped
 * table (businessId / downloaderBusinessId / scopeBusinessId = this business),
 * the child rows that hang off them (feed formulation items, batch inputs,
 * advisor note updates, asset audit logs, credit payments, payroll entries)
 * and ONLY the vendors those rows reference.
 *
 * EXPORT deliberately excludes:
 *   • other businesses' rows — verified per row, never by "same tenant";
 *   • accounts and access: users (only id+name+role of actors that appear on
 *     an exported row), organizations, organization_members,
 *     user_business_access, advisor_assignments, users_sessions, push
 *     subscriptions/config and every other device/credential record;
 *   • notifications (per-user inbox, meaningless in another tenant);
 *   • platform/tenant configuration: company_settings, system_markers,
 *     integrations, payroll_statutory_config, customer_support_info,
 *     record_deletion_logs, and approval policies with no business scope.
 *
 * IMPORT (always creates a NEW business, never overwrites):
 *   • every restored row is stamped with the IMPORTING organization
 *     (owner_id) — the source tenant's owner id never crosses over;
 *   • user references are never copied: nullable actor columns become NULL
 *     (the *_name / *_role text snapshot keeps history readable) and NOT NULL
 *     ones are attached to the account performing the restore;
 *   • customers are re-created per business (no shared CRM row), vendors are
 *     reused only inside the importing organization, otherwise re-created;
 *   • globally-unique business codes that still exist in the source database
 *     get the new unit's code appended instead of colliding;
 *   • the whole restore is one DB transaction with per-row savepoints, so a
 *     failure cannot leave a half-created business behind.
 */

import JSZip from "jszip";
import { db } from "@/db";
import { normalizeInventoryCategory, deriveInventorySubcategory } from "@/lib/inventoryCategories";
import * as schema from "@/db/schema";
import {
  and,
  eq,
  getTableColumns,
  getTableName,
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
  // Vendors are tenant-scoped (owner_id) with no businessId: exported
  // separately (only the rows the business references) and restored by the
  // dedicated supplier pass in the importer.
  suppliers: { table: schema.suppliers },
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
  // Boutique size × colour stock — rows hang off inventory items and are
  // remapped on import so a restored unit keeps its per-size stock.
  inventoryVariants: { table: schema.inventoryVariants, fkBusinessId: "businessId" },
  // P5 stock audit trail — hangs off inventory items, remapped on import so a
  // restored unit keeps the full "why did stock move" history.
  stockMovements: { table: schema.stockMovements, fkBusinessId: "businessId" },
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
  // Block factory
  blockFactoryLogs: { table: schema.blockFactoryLogs, fkBusinessId: "businessId" },
  blockFactoryOrders: { table: schema.blockFactoryOrders, fkBusinessId: "businessId" },
  blockFactoryDeliveries: { table: schema.blockFactoryDeliveries, fkBusinessId: "businessId" },
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
  checklistPlanTemplates: { table: schema.checklistPlanTemplates, fkBusinessId: "businessId" },
  checklistFlockPlans: { table: schema.checklistFlockPlans, fkBusinessId: "businessId" },
  dailyNotes: { table: schema.dailyNotes, fkBusinessId: "businessId" },
  businessInsights: { table: schema.businessInsights, fkBusinessId: "businessId" },
  // Audit center
  auditAssignments: { table: schema.auditAssignments, fkBusinessId: "businessId" },
  auditReviews: { table: schema.auditReviews, fkBusinessId: "businessId" },
  auditIssueUpdates: { table: schema.auditIssueUpdates }, // via issueId
  auditTrail: { table: schema.auditTrail, fkBusinessId: "businessId" },
  // Downloads audit
  assetDownloads: { table: schema.assetDownloads, fkBusinessId: "downloaderBusinessId" },
  // ---------------------------------------------------------------------------
  // Business-scoped tables added after the original catalogue was written.
  // Anything carrying its own businessId belongs in the backup, otherwise a
  // restored unit would silently lose the records below.
  // ---------------------------------------------------------------------------
  // Budgets & procurement
  budgets: { table: schema.budgets, fkBusinessId: "businessId" },
  supplierOrders: { table: schema.supplierOrders, fkBusinessId: "businessId" },
  supplierQuotes: { table: schema.supplierQuotes, fkBusinessId: "businessId" },
  supplierInvoices: { table: schema.supplierInvoices, fkBusinessId: "businessId" },
  supplierPayments: { table: schema.supplierPayments, fkBusinessId: "businessId" },
  goodsReceipts: { table: schema.goodsReceipts, fkBusinessId: "businessId" },
  purchaseRequisitions: { table: schema.purchaseRequisitions, fkBusinessId: "businessId" },
  orderPayments: { table: schema.orderPayments, fkBusinessId: "businessId" },
  // Approval workflow — only policies scoped to THIS business (platform-wide
  // policies with a NULL scope are tenant configuration, not business data).
  approvalPolicies: { table: schema.approvalPolicies, fkBusinessId: "scopeBusinessId" },
  approvalRequests: { table: schema.approvalRequests, fkBusinessId: "businessId" },
  // Operations & CRM
  actionTasks: { table: schema.actionTasks, fkBusinessId: "businessId" },
  businessDocuments: { table: schema.businessDocuments, fkBusinessId: "businessId" },
  customerInteractions: { table: schema.customerInteractions, fkBusinessId: "businessId" },
  // Online-order fulfilment configuration
  fulfillmentMethods: { table: schema.fulfillmentMethods, fkBusinessId: "businessId" },
  fulfillmentOptions: { table: schema.fulfillmentOptions, fkBusinessId: "businessId" },
  // Transport & logistics
  transportVehicles: { table: schema.transportVehicles, fkBusinessId: "businessId" },
  transportTrips: { table: schema.transportTrips, fkBusinessId: "businessId" },
  transportBookings: { table: schema.transportBookings, fkBusinessId: "businessId" },
  transportFuelLogs: { table: schema.transportFuelLogs, fkBusinessId: "businessId" },
  transportMaintenance: { table: schema.transportMaintenance, fkBusinessId: "businessId" },
  transportVehicleChecklists: { table: schema.transportVehicleChecklists, fkBusinessId: "businessId" },
  transportGeofences: { table: schema.transportGeofences, fkBusinessId: "businessId" },
  transportTrackerViolations: { table: schema.transportTrackerViolations, fkBusinessId: "businessId" },
  // Feed / block-mix production (parents; child rows are pulled by parent id)
  poultryBenchmarkProfiles: { table: schema.poultryBenchmarkProfiles, fkBusinessId: "businessId" },
  poultryFeedFormulations: { table: schema.poultryFeedFormulations, fkBusinessId: "businessId" },
  poultryFeedBatches: { table: schema.poultryFeedBatches, fkBusinessId: "businessId" },
  poultryFeedQcChecks: { table: schema.poultryFeedQcChecks, fkBusinessId: "businessId" },
  fishFeedFormulations: { table: schema.fishFeedFormulations, fkBusinessId: "businessId" },
  fishFeedBatches: { table: schema.fishFeedBatches, fkBusinessId: "businessId" },
  fishFeedQcChecks: { table: schema.fishFeedQcChecks, fkBusinessId: "businessId" },
  blockMixFormulations: { table: schema.blockMixFormulations, fkBusinessId: "businessId" },
  blockMixBatches: { table: schema.blockMixBatches, fkBusinessId: "businessId" },
  aquacultureBenchmarkProfiles: { table: schema.aquacultureBenchmarkProfiles, fkBusinessId: "businessId" },
  // Advisor content authored for this business (access GRANTS are deliberately
  // not exported — see the note in the header comment).
  advisorNotes: { table: schema.advisorNotes, fkBusinessId: "businessId" },
};

/**
 * Child tables that carry no businessId of their own: they are exported by
 * pulling the rows whose parent FK points at an exported parent row.
 * `parent` is the TABLES key that owns them.
 */
const CHILD_TABLES: { name: string; table: any; parent: string; fk: string }[] = [
  { name: "poultryFeedFormulationItems", table: schema.poultryFeedFormulationItems, parent: "poultryFeedFormulations", fk: "formulationId" },
  { name: "poultryFeedBatchInputs", table: schema.poultryFeedBatchInputs, parent: "poultryFeedBatches", fk: "batchId" },
  { name: "fishFeedFormulationItems", table: schema.fishFeedFormulationItems, parent: "fishFeedFormulations", fk: "formulationId" },
  { name: "fishFeedBatchInputs", table: schema.fishFeedBatchInputs, parent: "fishFeedBatches", fk: "batchId" },
  { name: "blockMixFormulationItems", table: schema.blockMixFormulationItems, parent: "blockMixFormulations", fk: "formulationId" },
  { name: "blockMixBatchInputs", table: schema.blockMixBatchInputs, parent: "blockMixBatches", fk: "mixBatchId" },
  { name: "advisorNoteUpdates", table: schema.advisorNoteUpdates, parent: "advisorNotes", fk: "noteId" },
];

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
  // Feed / mix factory child rows → by parent ids (declared in CHILD_TABLES).
  for (const child of CHILD_TABLES) {
    const parentIds = (manifest.tables[child.parent] || []).map((r: any) => r.id).filter(Boolean);
    if (!parentIds.length) continue;
    const rows = await db
      .select()
      .from(child.table)
      .where(inArray(child.table[child.fk], parentIds));
    manifest.tables[child.name] = rows.map(serializeRow);
    manifest.stats[child.name] = rows.length;
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
  // Only the DISPLAY IDENTITY of accounts that actually appear on an exported
  // row travels with the backup: id + name + role, never email/phone/avatar,
  // sessions, flags or any other account data. Import never recreates users;
  // the name/role text is what keeps the restored history readable, and the
  // numeric ids are dropped on restore (see remapUserId in the importer).
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
        role: schema.users.role,
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
  /** Target organization (tenant) for the imported unit — codes number and
   *  uniqueness-check within this org (per-org sequential numbering). Every
   *  restored row is stamped with this org. */
  ownerId?: number | null;
  /** Account performing the restore. Only used where a restored row REQUIRES
   *  a live user reference (e.g. open action tasks): the account that ran the
   *  import is the one account known to have access to the new unit. */
  actorUserId?: number | null;
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
  // The whole restore runs in ONE transaction: a failure half-way through can
  // never leave a partially-populated business behind. Per-row constraint
  // failures are isolated with nested savepoints inside insertTable, so a
  // single unimportable row degrades to a warning instead of aborting.
  return db.transaction(async (tx) => importBusinessBackupTx(tx, backupJson, opts));
}

async function importBusinessBackupTx(
  cx: any,
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

  // Tenant the restored unit belongs to, and the account performing the
  // restore. Every restored row is stamped with this org, so a backup can
  // never drag its source tenant's owner_id (or any other tenant's rows) into
  // the target database.
  const targetOrgId = opts.ownerId ?? null;
  const actorUserId = Number(opts.actorUserId) || null;
  const srcBusinessId = Number(srcBiz.id);

  // The export guarantees rows belong to the source business. Enforce it on
  // import as well: a hand-edited archive cannot smuggle rows of another
  // business into the restore.
  for (const [tableName, rows] of Object.entries(backupJson.tables || {})) {
    if (tableName === "businesses") continue;
    for (const r of ((rows as any[]) || []) as any[]) {
      const bid = r?.businessId ?? r?.downloaderBusinessId ?? r?.targetBusinessId ?? r?.scopeBusinessId;
      if (bid != null && Number(bid) !== srcBusinessId) {
        throw new Error(
          `Backup rejected: table "${tableName}" contains a row belonging to business ${bid}, not the exported business ${srcBusinessId}.`,
        );
      }
    }
  }

  // 1. Determine the new business code. Numbering and collision checks are
  //    scoped to the TARGET organization: sequential codes restart per org
  //    (a second org's first Poultry unit is POULTRY-01 too); DB uniqueness
  //    is (owner_id, code).
  const orgCodeRows = opts.ownerId != null
    ? await cx.select({ code: schema.businesses.code }).from(schema.businesses).where(eq(schema.businesses.ownerId, opts.ownerId))
    : await cx.select({ code: schema.businesses.code }).from(schema.businesses).where(isNull(schema.businesses.ownerId));
  const orgCodes = orgCodeRows.map((r: any) => r.code);
  const prefix = CATEGORY_PREFIX[category] || "BIZ";
  let newCode = opts.codeOverride && !orgCodes.includes(opts.codeOverride)
    ? opts.codeOverride
    : nextBusinessCode(orgCodes, category);

  // 2. Insert the new business row. We do NOT copy the original id (serial
  //    gives us a fresh id) nor the globally-unique code.
  const newName = opts.nameOverride || srcBiz.name || `Imported ${source.businessName || "Business"}`;
  const [newBiz] = await cx
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
      preOrderEnabled: srcBiz.preOrderEnabled ?? false,
      pickupEnabled: srcBiz.pickupEnabled ?? true,
      deliveryEnabled: srcBiz.deliveryEnabled ?? true,
      serviceRadiusKm: srcBiz.serviceRadiusKm ?? null,
      serviceNote: srcBiz.serviceNote ?? null,
      customerHelpPhone: srcBiz.customerHelpPhone ?? null,
      momoNumber: srcBiz.momoNumber ?? null,
      momoName: srcBiz.momoName ?? null,
      // Storefront settings travel with the unit (watermark branding etc.);
      // the archive flag does not — a restored unit is always live.
      watermarkEnabled: srcBiz.watermarkEnabled ?? false,
      watermarkMode: srcBiz.watermarkMode ?? "NAME",
      ownerId: targetOrgId,
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
  /**
   * User ids are NEVER carried across: the same numeric id in the target
   * database is a different person (or nobody). Restored rows therefore keep
   * their human-readable `*_name` / `*_role` snapshots and lose the account
   * link, so no restored record can point at another tenant's worker.
   * Columns that REQUIRE a user (open task assignments, advisor note threads)
   * are attached to the account performing the restore — the one account we
   * know is allowed to hold them.
   */
  const remapUserId = (v: any, opts?: { required?: boolean }): any => {
    if (opts?.required) return actorUserId ?? null;
    if (v === null || v === undefined) return null;
    const n = Number(v);
    if (!n) return v;
    return null;
  };
  const remapBranchCode = (v: any): any => {
    if (typeof v !== "string") return v;
    // Only remap when the branch code equals the source business code
    // (single-branch businesses reuse the code as branch code).
    if (v === srcBiz.code) return newCode;
    return v;
  };

  // Per-import registry of existing globally-unique values (never shared
  // between imports: a long-lived server process must not remember a stale
  // snapshot of the target database).
  const uniqueRegistry: UniqueRegistry = new Map();

  // Helper to insert a batch and record new ids.
  async function insertTable(
    tableName: string,
    rows: any[],
    transform: (row: any) => any,
    pk = "id",
  ): Promise<number> {
    if (!rows || !rows.length) return 0;
    const table = TABLES[tableName]?.table || CHILD_TABLES.find((c) => c.name === tableName)?.table;
    if (!table) {
      // A missing catalogue entry used to make the whole table disappear
      // silently on restore (exactly what happened to vendors). Never again.
      warnings.push(`${tableName}: table is not in the import catalogue — ${rows.length} row(s) not restored`);
      return 0;
    }
    // Column metadata drives two tenant guarantees, so a table added to the
    // catalogue in the future is covered without touching the importer:
    //   • owner_id is ALWAYS the target organization (never the source's);
    //   • a NOT NULL user reference falls back to the restoring account
    //     when the transform could not attribute it.
    const cols = tableColumns(table);
    // NOTE: `tableName` is the catalogue KEY (camelCase); the unique-index
    // lookup needs the real SQL table name.
    const uniques = await uniqueValueSets(cx, uniqueRegistry, getTableName(table), cols);
    let inserted = 0;
    for (const src of rows) {
      const values = transform({ ...src });
      // The original pk is used to build the old→new id map, so REMAP THE ID
      // FROM THE SOURCE ROW: several transforms (employees, customers,
      // assets …) build a fresh object and never copy `id`, and reading it
      // back from `values` silently produced an empty map — every FK that
      // pointed at those rows (customer links, employee links) was dropped.
      const oldId = (src as any)?.[pk] ?? values[pk];
      delete values[pk];
      if (cols.has("ownerId")) values.ownerId = targetOrgId;
      for (const [prop, meta] of cols) {
        // JSON archives carry timestamps as ISO strings; Drizzle's timestamp
        // columns (mode "date") expect Date objects. Without this every table
        // with a timestamp column other than created/updated/recorded_at
        // (attendance clock-ins, receipt dates, QC test times …) failed to
        // restore. `PgTimestampString` columns keep their string form.
        const v = values[prop];
        if (typeof v === "string" && /Timestamp/i.test(String(meta.columnType)) && !/TimestampString/i.test(String(meta.columnType))) {
          const d = new Date(v);
          if (!Number.isNaN(d.getTime())) values[prop] = d;
        }
      }
      for (const [prop, meta] of cols) {
        if (!/^[a-z0-9]*UserId$/.test(prop) && prop !== "userId") continue;
        // A source user id must never survive the trip (target ids belong to
        // other people). Nullable columns lose the link; NOT NULL columns are
        // attached to the account performing the restore.
        if (typeof values[prop] === "number" && values[prop] > 0) values[prop] = null;
        if (values[prop] === undefined || values[prop] === null) {
          if (!meta.notNull) continue;
          if (!actorUserId) continue; // row will be reported by the constraint
          values[prop] = actorUserId;
        }
      }
      // Business codes/numbers that carry a GLOBAL unique index (tracking
      // codes, credit codes, purchase/quote/invoice numbers, task numbers …)
      // still exist in the source database after a restore. Keep the original
      // value when it is free, otherwise make it unique with the new unit's
      // code — never by touching the existing row.
      for (const [prop, set] of uniques) {
        const meta = cols.get(prop);
        const v = values[prop];
        if (v === undefined || v === null || meta?.dataType !== "string") continue;
        const s = String(v);
        if (!set.has(s)) {
          set.add(s);
          continue;
        }
        let candidate = `${s}-${newCode}`;
        let n = 2;
        while (set.has(candidate)) candidate = `${s}-${newCode}-${n++}`;
        values[prop] = candidate;
        set.add(candidate);
      }
      try {
        // Nested transaction = SAVEPOINT: a unique/constraint failure rolls
        // back ONLY this row, leaving the outer restore transaction usable.
        const returned = await cx.transaction(async (sp: any) => {
          const arr: any[] = await sp.insert(table).values(values).returning();
          return arr?.[0];
        });
        if (returned && oldId != null) {
          mapFor(tableName).set(Number(oldId), Number(returned[pk]));
        }
        inserted++;
      } catch (e: any) {
        // Unique/constraint failures shouldn't abort the whole import.
        const why = e?.cause?.message || e?.message || "unknown error";
        warnings.push(`${tableName}: skipped row ${oldId ?? "?"} — ${String(why).slice(0, 160)}`);
      }
    }
    return inserted;
  }

  // 4. Insert in dependency order (parents first, children second).
  const stats: Record<string, number> = { businesses: 1 };

  // Independent lookup tables first. Suppliers have no businessId — they are
  // scoped by owner_id — so dedupe is limited to the TARGET ORGANIZATION:
  // venders already known to this tenant are reused, while a venders row of
  // any other tenant is never linked (a restored business must not share a
  // mutable party record across tenants).
  const existingSuppliers: any[] = targetOrgId != null
    ? await cx.select().from(schema.suppliers).where(eq(schema.suppliers.ownerId, targetOrgId))
    : [];
  const supplierKey = (s: any) =>
    `${(s.name || "").toString().trim().toLowerCase()}|${(s.phone || "").toString().trim()}`;
  const existingSupplierKeys = new Set(existingSuppliers.map(supplierKey));
  const newSuppliers: any[] = [];
  for (const s of backupJson.tables.suppliers || []) {
    const existing = existingSuppliers.find((x) => supplierKey(x) === supplierKey(s));
    if (existing) {
      // Same tenant → safe to point the restored rows at the known vendor.
      mapFor("suppliers").set(Number(s.id), Number(existing.id));
      continue;
    }
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

  // Customers are ALWAYS re-created for the restored business. The previous
  // implementation reused any existing customer row with the same name+phone
  // — including a row owned by another business or another tenant — which
  // silently shared one mutable CRM record between two units (balances,
  // loyalty points and credit history leaked both ways). A restored unit gets
  // its own copies; nothing existing is touched.
  stats.customers = await insertTable("customers", backupJson.tables.customers || [], (r) => ({
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
    ownerId: targetOrgId,
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
      // Restored stock keeps the shared taxonomy: umbrella category + the
      // unit's own wording preserved as the subcategory.
      category: normalizeInventoryCategory(r.category),
      subcategory: deriveInventorySubcategory(r.category, r.subcategory),
      quantity: Number(r.quantity) || 0,
      unit: r.unit,
      costPriceGhs: Number(r.costPriceGhs) || 0,
      sellingPriceGhs: Number(r.sellingPriceGhs) || 0,
      minStockThreshold: Number(r.minStockThreshold) || 0,
      status: r.status || "IN_STOCK",
      expiryDate: r.expiryDate,
      photo: r.photo,
      photos: r.photos,
      // Display thumbnails travel with the photos so a restored business keeps
      // serving light list/menu images instead of falling back to full size.
      photoThumb: r.photoThumb,
      photosThumb: r.photosThumb,
      qrCode: null,
      tracksVariants: r.tracksVariants === true,
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
      // Supplier references go through the import map only: matching a source
      // supplier id against a target row by NUMBER would silently attach the
      // restored expense to an unrelated vendor that happens to share the id.
      supplierId: r.supplierId ? remapFk("suppliers", r.supplierId) : null,
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
    "blockFactoryLogs", "blockFactoryOrders", "blockFactoryDeliveries",
    "aquacultureLogs", "aquaculturePonds", "aquacultureBatches",
    "aquacultureFeedLogs", "aquacultureWaterQualityLogs", "aquacultureHarvests",
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
    "checklistTemplates", "checklistEntries", "checklistPlanTemplates", "checklistFlockPlans",
    "dailyNotes", "businessInsights",
    "aiInsights",
    "auditAssignments", "auditReviews", "auditTrail",
    "inventoryVariants", "stockMovements",
    "inventoryDownloads", "assetDownloads", "universalExports",
    // ── Tables that were exported but never restored before ──────────────
    // (online-order tracking, credit sales, payroll runs/attendance and the
    // employee document/history trail were silently dropped on import.)
    "employeeDocuments", "employeeHistory",
    "customerTrackings", "creditSales",
    "payrollRuns", "payrollAttendance", "attendanceLogs",
    // ── Business-scoped tables added after the original catalogue ────────
    // Ordering matters: parents are inserted before children. Circular
    // references (supplierOrders ⇄ purchaseRequisitions,
    // transportTrips ⇄ transportBookings) are patched after both exist.
    "approvalPolicies", "approvalRequests",
    "supplierOrders", "purchaseRequisitions",
    "supplierQuotes", "supplierInvoices", "supplierPayments", "goodsReceipts",
    "orderPayments",
    "budgets", "actionTasks", "businessDocuments", "customerInteractions",
    "fulfillmentMethods", "fulfillmentOptions",
    "transportVehicles", "transportGeofences", "transportTrips", "transportBookings",
    "transportFuelLogs", "transportMaintenance", "transportVehicleChecklists",
    "transportTrackerViolations",
    "poultryBenchmarkProfiles", "poultryFeedFormulations", "poultryFeedBatches",
    "poultryFeedQcChecks",
    "fishFeedFormulations", "fishFeedBatches", "fishFeedQcChecks",
    "blockMixFormulations", "blockMixBatches",
    "aquacultureBenchmarkProfiles",
    "advisorNotes",
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
      flockId: remapFk("poultryFlocks", r.flockId),
    }),
    checklistFlockPlans: (r) => ({
      flockId: remapFk("poultryFlocks", r.flockId),
      planTemplateId: remapFk("checklistPlanTemplates", r.planTemplateId),
    }),
    scenarioSimulations: (r) => ({
      targetBusinessId: newBusinessId,
    }),
    stockMovements: (r) => ({
      inventoryId: remapFk("inventoryItems", r.inventoryId),
      branchCode: null,
      actorUserId: remapUserId(r.actorUserId),
    }),
    inventoryVariants: (r) => ({
      inventoryId: remapFk("inventoryItems", r.inventoryId),
      // Variant SKUs are derived from the parent SKU; regenerate to avoid
      // collisions with the imported item's new code.
      sku: null,
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

    // ── HR history (exported but previously never restored) ──────────────
    employeeDocuments: (r) => ({
      employeeId: remapFk("employees", r.employeeId),
      uploadedByUserId: remapUserId(r.uploadedByUserId),
    }),
    employeeHistory: (r) => ({
      employeeId: remapFk("employees", r.employeeId),
      changedByUserId: remapUserId(r.changedByUserId),
    }),

    // ── Orders & credit ──────────────────────────────────────────────────
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

    // ── Payroll attendance ───────────────────────────────────────────────
    payrollRuns: (r) => ({ createdByUserId: remapUserId(r.createdByUserId) }),
    payrollAttendance: (r) => ({
      employeeId: remapFk("employees", r.employeeId),
      recordedByUserId: remapUserId(r.recordedByUserId),
    }),
    attendanceLogs: (r) => ({
      employeeId: remapFk("employees", r.employeeId),
    }),

    // ── Procurement & approvals ──────────────────────────────────────────
    approvalPolicies: (r) => ({
      scopeBusinessId: newBusinessId,
      approverUserId: remapUserId(r.approverUserId),
    }),
    approvalRequests: (r) => ({
      requestedByUserId: remapUserId(r.requestedByUserId),
      decidedByUserId: remapUserId(r.decidedByUserId),
    }),
    supplierOrders: (r) => ({
      supplierId: remapFk("suppliers", r.supplierId),
      // requisitionId is patched after purchase_requisitions exist (circular).
      requisitionId: null,
      createdByUserId: remapUserId(r.createdByUserId),
    }),
    purchaseRequisitions: (r) => ({
      // supplierOrderId is patched after supplier_orders exist (circular).
      supplierOrderId: null,
      approvalRequestId: remapFk("approvalRequests", r.approvalRequestId),
      requestedByUserId: remapUserId(r.requestedByUserId),
    }),
    supplierQuotes: (r) => ({
      requisitionId: remapFk("purchaseRequisitions", r.requisitionId),
      supplierId: remapFk("suppliers", r.supplierId),
      supplierOrderId: remapFk("supplierOrders", r.supplierOrderId),
    }),
    supplierInvoices: (r) => ({
      supplierOrderId: remapFk("supplierOrders", r.supplierOrderId),
      supplierId: remapFk("suppliers", r.supplierId),
      attachmentDocumentId: remapFk("businessDocuments", r.attachmentDocumentId),
    }),
    supplierPayments: (r) => ({
      invoiceId: remapFk("supplierInvoices", r.invoiceId),
      supplierOrderId: remapFk("supplierOrders", r.supplierOrderId),
      transactionId: remapFk("transactions", r.transactionId),
      recordedByUserId: remapUserId(r.recordedByUserId),
    }),
    goodsReceipts: (r) => ({
      supplierOrderId: remapFk("supplierOrders", r.supplierOrderId),
      receivedByUserId: remapUserId(r.receivedByUserId),
    }),
    orderPayments: (r) => ({
      trackingId: remapFk("customerTrackings", r.trackingId),
      transactionId: remapFk("transactions", r.transactionId),
      markedByUserId: remapUserId(r.markedByUserId),
    }),

    // ── Budgets, tasks, documents, CRM, fulfilment ───────────────────────
    budgets: (r) => ({ createdByUserId: remapUserId(r.createdByUserId) }),
    actionTasks: (r) => ({
      // source_id is a polymorphic reference to another exported table; the
      // label/ref text is preserved so the task stays readable.
      assignedUserId: remapUserId(r.assignedUserId, { required: true }),
      createdByUserId: remapUserId(r.createdByUserId),
    }),
    businessDocuments: (r) => ({
      uploadedByUserId: remapUserId(r.uploadedByUserId),
      // Related records keep their label; idem for polymorphic related_id.
      relatedId: null,
    }),
    customerInteractions: (r) => ({
      customerId: remapFk("customers", r.customerId),
      actorUserId: remapUserId(r.actorUserId),
    }),
    fulfillmentMethods: (r) => ({ createdByUserId: remapUserId(r.createdByUserId) }),
    fulfillmentOptions: (r) => ({
      inventoryId: remapFk("inventoryItems", r.inventoryId),
      methodId: remapFk("fulfillmentMethods", r.methodId),
      supplierId: remapFk("suppliers", r.supplierId),
      createdByUserId: remapUserId(r.createdByUserId),
    }),

    // ── Transport & logistics ────────────────────────────────────────────
    transportVehicles: (r) => ({
      assetId: remapFk("assets", r.assetId),
      assignedEmployeeId: remapFk("employees", r.assignedEmployeeId),
      createdByUserId: remapUserId(r.createdByUserId),
    }),
    transportTrips: (r) => ({
      vehicleId: remapFk("transportVehicles", r.vehicleId),
      driverEmployeeId: remapFk("employees", r.driverEmployeeId),
      customerId: remapFk("customers", r.customerId),
      // bookingId is patched after transport_bookings exist (circular).
      bookingId: null,
      createdByUserId: remapUserId(r.createdByUserId),
    }),
    transportBookings: (r) => ({
      customerId: remapFk("customers", r.customerId),
      vehicleId: remapFk("transportVehicles", r.vehicleId),
      tripId: remapFk("transportTrips", r.tripId),
      createdByUserId: remapUserId(r.createdByUserId),
    }),
    transportFuelLogs: (r) => ({
      vehicleId: remapFk("transportVehicles", r.vehicleId),
      driverEmployeeId: remapFk("employees", r.driverEmployeeId),
    }),
    transportMaintenance: (r) => ({
      vehicleId: remapFk("transportVehicles", r.vehicleId),
      assignedToEmployeeId: remapFk("employees", r.assignedToEmployeeId),
    }),
    transportVehicleChecklists: (r) => ({
      vehicleId: remapFk("transportVehicles", r.vehicleId),
      tripId: remapFk("transportTrips", r.tripId),
      employeeId: remapFk("employees", r.employeeId),
    }),
    transportTrackerViolations: (r) => ({
      vehicleId: remapFk("transportVehicles", r.vehicleId),
      tripId: remapFk("transportTrips", r.tripId),
    }),

    // ── Feed / block-mix production ──────────────────────────────────────
    poultryBenchmarkProfiles: (r) => ({ createdByUserId: remapUserId(r.createdByUserId) }),
    poultryFeedBatches: (r) => ({
      formulationId: remapFk("poultryFeedFormulations", r.formulationId),
      finishedInventoryId: remapFk("inventoryItems", r.finishedInventoryId),
      recordedByUserId: remapUserId(r.recordedByUserId),
    }),
    poultryFeedQcChecks: (r) => ({ batchId: remapFk("poultryFeedBatches", r.batchId) }),
    fishFeedBatches: (r) => ({
      formulationId: remapFk("fishFeedFormulations", r.formulationId),
      finishedInventoryId: remapFk("inventoryItems", r.finishedInventoryId),
      recordedByUserId: remapUserId(r.recordedByUserId),
    }),
    fishFeedQcChecks: (r) => ({ batchId: remapFk("fishFeedBatches", r.batchId) }),
    blockMixBatches: (r) => ({
      formulationId: remapFk("blockMixFormulations", r.formulationId),
      consumedProductionLogId: remapFk("blockFactoryLogs", r.consumedProductionLogId),
      recordedByUserId: remapUserId(r.recordedByUserId),
    }),
    aquacultureBenchmarkProfiles: (r) => ({ createdByUserId: remapUserId(r.createdByUserId) }),

    // ── Advisor content (flock/batch links, thread updates handled below) ─
    advisorNotes: (r) => ({
      flockId: remapFk("poultryFlocks", r.flockId),
      batchId: remapFk("aquacultureBatches", r.batchId),
      authorUserId: remapUserId(r.authorUserId),
    }),
  };

  for (const t of simpleTables) {
    if (t === "assetAuditLogs") continue; // inserted after assets
    stats[t] = await insertTable(t, backupJson.tables[t] || [], (r) => {
      // Strip columns that don't exist on every table (drizzle will error).
      const extra = extraTransforms[t]?.(r) || {};
      return genericTransform(r, () => extra);
    });
  }

  // ── Circular references between tables that were both inserted above ──
  // (patched now that both sides have real ids; the columns stay NULL when
  // the counterpart row could not be restored).
  const patchRefs: { table: string; column: string; from: string; source: any[] }[] = [
    { table: "supplierOrders", column: "requisitionId", from: "purchaseRequisitions", source: backupJson.tables.supplierOrders || [] },
    { table: "purchaseRequisitions", column: "supplierOrderId", from: "supplierOrders", source: backupJson.tables.purchaseRequisitions || [] },
    { table: "transportTrips", column: "bookingId", from: "transportBookings", source: backupJson.tables.transportTrips || [] },
  ];
  for (const p of patchRefs) {
    const table = TABLES[p.table]?.table;
    if (!table) continue;
    for (const src of p.source) {
      const newId = idMap[p.table]?.get(Number(src.id));
      const oldRef = Number(src[p.column] ?? 0);
      const newRef = oldRef ? idMap[p.from]?.get(oldRef) : null;
      if (!newId || !newRef) continue;
      try {
        await cx.update(table).set({ [p.column]: newRef }).where(eq(table.id, newId));
      } catch (e: any) {
        warnings.push(`${p.table}.${p.column} patch skipped — ${e.message?.slice(0, 80)}`);
      }
    }
  }

  // Children whose parents live in the feed/mix factory tables (no businessId
  // of their own — they follow their parent, which is already business-scoped).
  stats.poultryFeedFormulationItems = await insertTable(
    "poultryFeedFormulationItems",
    backupJson.tables.poultryFeedFormulationItems || [],
    (r) => genericTransform(r, () => ({
      formulationId: remapFk("poultryFeedFormulations", r.formulationId),
      inventoryId: remapFk("inventoryItems", r.inventoryId),
    })),
  );
  stats.poultryFeedBatchInputs = await insertTable(
    "poultryFeedBatchInputs",
    backupJson.tables.poultryFeedBatchInputs || [],
    (r) => genericTransform(r, () => ({
      batchId: remapFk("poultryFeedBatches", r.batchId),
      inventoryId: remapFk("inventoryItems", r.inventoryId),
    })),
  );
  stats.fishFeedFormulationItems = await insertTable(
    "fishFeedFormulationItems",
    backupJson.tables.fishFeedFormulationItems || [],
    (r) => genericTransform(r, () => ({
      formulationId: remapFk("fishFeedFormulations", r.formulationId),
      inventoryId: remapFk("inventoryItems", r.inventoryId),
    })),
  );
  stats.fishFeedBatchInputs = await insertTable(
    "fishFeedBatchInputs",
    backupJson.tables.fishFeedBatchInputs || [],
    (r) => genericTransform(r, () => ({
      batchId: remapFk("fishFeedBatches", r.batchId),
      inventoryId: remapFk("inventoryItems", r.inventoryId),
    })),
  );
  stats.blockMixFormulationItems = await insertTable(
    "blockMixFormulationItems",
    backupJson.tables.blockMixFormulationItems || [],
    (r) => genericTransform(r, () => ({
      formulationId: remapFk("blockMixFormulations", r.formulationId),
      inventoryId: remapFk("inventoryItems", r.inventoryId),
    })),
  );
  stats.blockMixBatchInputs = await insertTable(
    "blockMixBatchInputs",
    backupJson.tables.blockMixBatchInputs || [],
    (r) => genericTransform(r, () => ({
      mixBatchId: remapFk("blockMixBatches", r.mixBatchId),
      inventoryId: remapFk("inventoryItems", r.inventoryId),
    })),
  );
  stats.advisorNoteUpdates = await insertTable(
    "advisorNoteUpdates",
    backupJson.tables.advisorNoteUpdates || [],
    (r) => genericTransform(r, () => ({
      noteId: remapFk("advisorNotes", r.noteId),
      actorUserId: remapUserId(r.actorUserId, { required: true }),
    })),
  );

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

/**
 * Existing values of every SINGLE-COLUMN unique index on a table, keyed by
 * the drizzle property. Used on restore to keep globally-unique business
 * codes (tracking/credit/purchase numbers …) from colliding with the rows
 * that still live in the source database — the restored copy gets the new
 * unit's code appended, the original row is never modified.
 */
type UniqueRegistry = Map<string, Map<string, Set<string>>>;
async function uniqueValueSets(
  cx: any,
  registry: UniqueRegistry,
  tableName: string,
  cols: Map<string, any>,
): Promise<Map<string, Set<string>>> {
  const cached = registry.get(tableName);
  if (cached) return cached;
  const out = new Map<string, Set<string>>();
  try {
    const res = await cx.execute(sql`
      select a.attname as column
        from pg_index i
        join pg_class c on c.oid = i.indrelid
        join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
       where c.relname = ${tableName}
         and i.indisunique
         and not i.indisprimary
         and array_length(i.indkey, 1) = 1
         and c.relnamespace = 'public'::regnamespace
    `);
    const rows = (res as any)?.rows ?? res ?? [];
    for (const r of rows) {
      const column = String(r.column);
      const prop = [...cols.entries()].find(([, meta]) => meta?.name === column)?.[0];
      if (!prop || cols.get(prop)?.dataType !== "string") continue;
      const vals = await cx.execute(sql.raw(`select "${column}" as v from "${tableName}" where "${column}" is not null`));
      const list = (vals as any)?.rows ?? vals ?? [];
      out.set(prop, new Set(list.map((x: any) => String(x.v))));
    }
  } catch {
    // Metadata unavailable → skip uniqueness handling (row inserts still run).
  }
  registry.set(tableName, out);
  return out;
}

/** propertyName → column metadata for a drizzle table (cached per table). */
const COLUMN_CACHE = new WeakMap<any, Map<string, any>>();
function tableColumns(table: any): Map<string, any> {
  let cached = COLUMN_CACHE.get(table);
  if (!cached) {
    const cols = getTableColumns(table) as Record<string, any>;
    cached = new Map(Object.entries(cols).map(([prop, col]) => [prop, col]));
    COLUMN_CACHE.set(table, cached);
  }
  return cached;
}

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
