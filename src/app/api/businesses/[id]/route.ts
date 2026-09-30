import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  businesses,
  businessMetrics,
  customers,
  customerInteractions,
  customerTrackings,
  employees,
  employeeDocuments,
  employeeHistory,
  assets,
  assetAuditLogs,
  inventoryItems,
  universalExports,
  transactions,
  expenseCategories,
  budgets,
  salesDocuments,
  creditSales,
  creditPayments,
  fulfillmentMethods,
  fulfillmentOptions,
  orderPayments,
  goodsReceipts,
  purchaseRequisitions,
  supplierOrders,
  supplierQuotes,
  supplierInvoices,
  supplierPayments,
  poultryLogs,
  poultryFlocks,
  poultryFeedLogs,
  poultryWaterLogs,
  poultryHealthRecords,
  poultryProduction,
  poultryChecklists,
  poultryProducts,
  poultryWeightLogs,
  poultryBenchmarkProfiles,
  poultryFeedFormulations,
  poultryFeedFormulationItems,
  poultryFeedBatches,
  poultryFeedBatchInputs,
  poultryFeedQcChecks,
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
  aquacultureLogs,
  aquaculturePonds,
  aquacultureBatches,
  aquacultureFeedLogs,
  aquacultureWaterQualityLogs,
  aquacultureHarvests,
  aquacultureWeightLogs,
  aquacultureBenchmarkProfiles,
  aquacultureChecklists,
  fishFeedFormulations,
  fishFeedFormulationItems,
  fishFeedBatches,
  fishFeedBatchInputs,
  fishFeedQcChecks,
  livestockLogs,
  restaurantLogs,
  restaurantOrders,
  restaurantMenuItems,
  restaurantWaste,
  restaurantPurchases,
  electronicsLogs,
  electronicsOrders,
  electronicsSerials,
  electronicsWarranties,
  electronicsPurchases,
  carWashLogs,
  carWashServices,
  carWashBookings,
  carWashWashes,
  carWashActivities,
  telecomLines,
  telecomTxns,
  telecomWifiPackages,
  telecomVouchers,
  telecomActivities,
  hardwareLogs,
  hardwareOrders,
  hardwarePurchases,
  hardwareDeliveries,
  cctvCameras,
  payrollRuns,
  payrollEntries,
  payrollAttendance,
  attendanceLogs,
  auditAssignments,
  auditReviews,
  auditIssueUpdates,
  actionTasks,
  notifications,
  auditTrail,
  checklistTemplates,
  checklistEntries,
  checklistPlanTemplates,
  checklistFlockPlans,
  dailyNotes,
  businessInsights,
  advisorAssignments,
  advisorNotes,
  advisorNoteUpdates,
  transportVehicles,
  transportTrips,
  transportBookings,
  transportFuelLogs,
  transportMaintenance,
  transportVehicleChecklists,
  transportGeofences,
  transportTrackerViolations,
  approvalPolicies,
  approvalRequests,
  businessDocuments,
  userBusinessAccess,
  aiInsights,
  scenarioSimulations,
  serviceAreas,
  pickupLocations,
  users,
} from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import {
  CATEGORY_ICON,
  reprovisionForTypeChange,
  provisionBusiness,
} from "@/lib/businessProvisioning";
import { requireOwner, getSessionInfo, canAccessBusiness, FORBIDDEN } from "@/lib/auth";
import { businessTypeAllowed } from "@/lib/businessTypes";
import { ttlInvalidate } from "@/lib/ttlCache";
import { managesBusiness } from "@/lib/permissions";
import { recordDeletedBusiness } from "@/lib/systemMarkers";
import { apiError } from "@/lib/apiError";

/** Online-ordering, service-area, pickup & customer-contact fields. These are
 *  the ONLY business fields a non-OWNER may change — and only staff carrying
 *  the OWNER-granted canManageOnline permission, on a business they actually
 *  have access to. Everything else stays OWNER-only. */
const ONLINE_ORDERING_FIELDS = [
  "onlineOrderingEnabled",
  "pickupEnabled",
  "deliveryEnabled",
  "serviceRadiusKm",
  "serviceNote",
  "customerHelpPhone",
  "momoNumber",
  "momoName",
  "gpsLat",
  "gpsLng",
  "watermarkEnabled",
  "watermarkMode",
] as const;

const VALID_CATEGORIES = [
  "Poultry Farm",
  "Block Factory",
  "Aquaculture",
  "Livestock",
  "Restaurant & Food",
  "Electronic Shop",
  "Car Wash",
  "Hardware Store",
];

const VALID_STATUSES = ["ACTIVE", "EXPANDING", "MAINTENANCE", "INACTIVE"];

async function loadBusiness(id: number) {
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, id));
  return biz;
}

/**
 * Resolves the caller's control level over one business unit, DB-resolved from
 * the session (client-supplied roles/flags are never trusted):
 *   • "OWNER"       — the group owner (full control over every unit).
 *   • "UNIT_MANAGER" — a user the OWNER granted "Manage Unit" for THIS unit
 *                      (`users.businessManageIds`). Owner-equivalent for edit,
 *                      business-type, online-ordering/service settings and
 *                      reset — but NEVER deactivate/delete (those stay OWNER).
 *   • null          — no structural control (other grants may still allow the
 *                      narrower online-ordering / service-area scope).
 */
async function businessControlLevel(
  request: Request,
  businessId: number
): Promise<"OWNER" | "UNIT_MANAGER" | null> {
  const session = await getSessionInfo(request);
  const user = session?.user as any;
  if (!user) return null;
  if (user.isSuperAdmin) return "OWNER";
  // Org OWNER ⇒ owner-level control strictly of their own organization's units.
  if (user.role === "OWNER" && (await canAccessBusiness(user, businessId))) return "OWNER";
  if (managesBusiness(user, businessId) && (await canAccessBusiness(user, businessId))) return "UNIT_MANAGER";
  return null;
}

/** Count every operational record owned by the business — used by the Owner
 *  console to preview exactly what a deletion will remove. */
async function relatedCounts(businessId: number) {
  const count = async (table: any, col: any) => {
    try {
      const rows = await db.select({ id: table.id }).from(table).where(eq(col, businessId));
      return rows.length;
    } catch {
      return 0;
    }
  };

  const groups: Record<string, number> = {
    inventoryItems: await count(inventoryItems, inventoryItems.businessId),
    employees: await count(employees, employees.businessId),
    customers: await count(customers, customers.businessId),
    assets: await count(assets, assets.businessId),
    transactions: await count(transactions, transactions.businessId),
    salesDocuments:
      (await count(salesDocuments, salesDocuments.businessId)) +
      (await count(blockFactoryOrders, blockFactoryOrders.businessId)) +
      (await count(blockFactoryDeliveries, blockFactoryDeliveries.businessId)) +
      (await count(electronicsOrders, electronicsOrders.businessId)) +
      (await count(electronicsSerials, electronicsSerials.businessId)) +
      (await count(electronicsWarranties, electronicsWarranties.businessId)) +
      (await count(electronicsPurchases, electronicsPurchases.businessId)) +
      (await count(restaurantOrders, restaurantOrders.businessId)) +
      (await count(hardwareOrders, hardwareOrders.businessId)) +
      (await count(hardwarePurchases, hardwarePurchases.businessId)) +
      (await count(hardwareDeliveries, hardwareDeliveries.businessId)) +
      (await count(carWashServices, carWashServices.businessId)) +
      (await count(carWashBookings, carWashBookings.businessId)) +
      (await count(carWashWashes, carWashWashes.businessId)) +
      (await count(telecomTxns, telecomTxns.businessId)) +
      (await count(telecomVouchers, telecomVouchers.businessId)),
    procurementAndPayables:
      (await count(goodsReceipts, goodsReceipts.businessId)) +
      (await count(supplierInvoices, supplierInvoices.businessId)) +
      (await count(supplierPayments, supplierPayments.businessId)) +
      (await count(supplierOrders, supplierOrders.businessId)) +
      (await count(supplierQuotes, supplierQuotes.businessId)) +
      (await count(purchaseRequisitions, purchaseRequisitions.businessId)),
    creditAndReceivables:
      (await count(creditSales, creditSales.businessId)) +
      (await count(creditPayments, creditPayments.businessId)),
    payrollAndHr:
      (await count(payrollRuns, payrollRuns.businessId)) +
      (await count(payrollEntries, payrollEntries.businessId)) +
      (await count(payrollAttendance, payrollAttendance.businessId)) +
      (await count(attendanceLogs, attendanceLogs.businessId)) +
      (await count(employeeDocuments, employeeDocuments.businessId)) +
      (await count(employeeHistory, employeeHistory.businessId)),
    productionAndOps:
      (await count(poultryLogs, poultryLogs.businessId)) +
      (await count(poultryFlocks, poultryFlocks.businessId)) +
      (await count(poultryFeedLogs, poultryFeedLogs.businessId)) +
      (await count(poultryWaterLogs, poultryWaterLogs.businessId)) +
      (await count(poultryHealthRecords, poultryHealthRecords.businessId)) +
      (await count(poultryProduction, poultryProduction.businessId)) +
      (await count(poultryWeightLogs, poultryWeightLogs.businessId)) +
      (await count(poultryChecklists, poultryChecklists.businessId)) +
      (await count(poultryProducts, poultryProducts.businessId)) +
      (await count(poultryFeedFormulations, poultryFeedFormulations.businessId)) +
      (await count(poultryFeedBatches, poultryFeedBatches.businessId)) +
      (await count(poultryFeedQcChecks, poultryFeedQcChecks.businessId)) +
      (await count(blockFactoryLogs, blockFactoryLogs.businessId)) +
      (await count(blockFactoryChecklists, blockFactoryChecklists.businessId)) +
      (await count(blockTypes, blockTypes.businessId)) +
      (await count(blockMixFormulations, blockMixFormulations.businessId)) +
      (await count(blockMixBatches, blockMixBatches.businessId)) +
      (await count(blockQcChecks, blockQcChecks.businessId)) +
      (await count(aquacultureLogs, aquacultureLogs.businessId)) +
      (await count(aquaculturePonds, aquaculturePonds.businessId)) +
      (await count(aquacultureBatches, aquacultureBatches.businessId)) +
      (await count(aquacultureFeedLogs, aquacultureFeedLogs.businessId)) +
      (await count(aquacultureWaterQualityLogs, aquacultureWaterQualityLogs.businessId)) +
      (await count(aquacultureHarvests, aquacultureHarvests.businessId)) +
      (await count(aquacultureWeightLogs, aquacultureWeightLogs.businessId)) +
      (await count(aquacultureChecklists, aquacultureChecklists.businessId)) +
      (await count(fishFeedFormulations, fishFeedFormulations.businessId)) +
      (await count(fishFeedBatches, fishFeedBatches.businessId)) +
      (await count(fishFeedQcChecks, fishFeedQcChecks.businessId)) +
      (await count(livestockLogs, livestockLogs.businessId)) +
      (await count(restaurantLogs, restaurantLogs.businessId)) +
      (await count(restaurantMenuItems, restaurantMenuItems.businessId)) +
      (await count(restaurantWaste, restaurantWaste.businessId)) +
      (await count(restaurantPurchases, restaurantPurchases.businessId)) +
      (await count(electronicsLogs, electronicsLogs.businessId)) +
      (await count(carWashLogs, carWashLogs.businessId)) +
      (await count(carWashActivities, carWashActivities.businessId)) +
      (await count(hardwareLogs, hardwareLogs.businessId)) +
      (await count(telecomLines, telecomLines.businessId)) +
      (await count(telecomWifiPackages, telecomWifiPackages.businessId)) +
      (await count(telecomActivities, telecomActivities.businessId)),
    auditsAndGovernance:
      (await count(auditReviews, auditReviews.businessId)) +
      (await count(auditAssignments, auditAssignments.businessId)) +
      (await count(auditTrail, auditTrail.businessId)) +
      (await count(actionTasks, actionTasks.businessId)) +
      (await count(advisorNotes, advisorNotes.businessId)) +
      (await count(advisorAssignments, advisorAssignments.businessId)) +
      (await count(approvalRequests, approvalRequests.businessId)) +
      (await count(approvalPolicies, approvalPolicies.scopeBusinessId)),
    transportAndFleet:
      (await count(transportVehicles, transportVehicles.businessId)) +
      (await count(transportTrips, transportTrips.businessId)) +
      (await count(transportBookings, transportBookings.businessId)) +
      (await count(transportFuelLogs, transportFuelLogs.businessId)) +
      (await count(transportMaintenance, transportMaintenance.businessId)) +
      (await count(transportVehicleChecklists, transportVehicleChecklists.businessId)) +
      (await count(transportGeofences, transportGeofences.businessId)) +
      (await count(transportTrackerViolations, transportTrackerViolations.businessId)),
    checklists:
      (await count(checklistTemplates, checklistTemplates.businessId)) +
      (await count(checklistEntries, checklistEntries.businessId)) +
      (await count(checklistPlanTemplates, checklistPlanTemplates.businessId)) +
      (await count(checklistFlockPlans, checklistFlockPlans.businessId)),
    metrics: await count(businessMetrics, businessMetrics.businessId),
    expenseCategories: await count(expenseCategories, expenseCategories.businessId),
    exports: await count(universalExports, universalExports.businessId),
    userAccessGrants: await count(userBusinessAccess, userBusinessAccess.businessId),
  };
  const totalRecords = Object.values(groups).reduce((a, b) => a + b, 0);
  return { groups, totalRecords };
}

/**
 * Cascade-purge all records belonging to a business across every domain in the
 * exact foreign-key order:
 *  1. Grandchild tables (referencing assets, inventory, employees, credit sales, formulations, audits, notes).
 *  2. Direct child tables scoped by business_id.
 *  3. Master lists (optional).
 *  4. User assignment cleanup & scenarios.
 */
async function purgeBusinessAllRecords(
  businessId: number,
  options: { deleteMasterLists?: boolean; unassignUsers?: boolean } = {}
) {
  // ── Step 1: Child tables referencing Asset, Inventory, Formulation, Batch, Employee, Credit, Audit, Note IDs ──

  // 1a. Asset child tables
  const assetRows = await db.select({ id: assets.id }).from(assets).where(eq(assets.businessId, businessId));
  const assetIds = assetRows.map((a) => a.id);
  if (assetIds.length > 0) {
    await db.delete(assetAuditLogs).where(inArray(assetAuditLogs.assetId, assetIds));
  }

  // 1b. Inventory child tables
  const invRows = await db.select({ id: inventoryItems.id }).from(inventoryItems).where(eq(inventoryItems.businessId, businessId));
  const invIds = invRows.map((i) => i.id);
  if (invIds.length > 0) {
    await db.delete(fulfillmentOptions).where(inArray(fulfillmentOptions.inventoryId, invIds));
  }

  // 1c. Poultry Feed Mill formulation items & batch inputs
  const poultryFormRows = await db.select({ id: poultryFeedFormulations.id }).from(poultryFeedFormulations).where(eq(poultryFeedFormulations.businessId, businessId));
  const poultryFormIds = poultryFormRows.map((f) => f.id);
  if (poultryFormIds.length > 0) {
    await db.delete(poultryFeedFormulationItems).where(inArray(poultryFeedFormulationItems.formulationId, poultryFormIds));
  }
  const poultryBatchRows = await db.select({ id: poultryFeedBatches.id }).from(poultryFeedBatches).where(eq(poultryFeedBatches.businessId, businessId));
  const poultryBatchIds = poultryBatchRows.map((b) => b.id);
  if (poultryBatchIds.length > 0) {
    await db.delete(poultryFeedBatchInputs).where(inArray(poultryFeedBatchInputs.batchId, poultryBatchIds));
  }

  // 1d. Fish Feed formulation items & batch inputs
  const fishFormRows = await db.select({ id: fishFeedFormulations.id }).from(fishFeedFormulations).where(eq(fishFeedFormulations.businessId, businessId));
  const fishFormIds = fishFormRows.map((f) => f.id);
  if (fishFormIds.length > 0) {
    await db.delete(fishFeedFormulationItems).where(inArray(fishFeedFormulationItems.formulationId, fishFormIds));
  }
  const fishBatchRows = await db.select({ id: fishFeedBatches.id }).from(fishFeedBatches).where(eq(fishFeedBatches.businessId, businessId));
  const fishBatchIds = fishBatchRows.map((b) => b.id);
  if (fishBatchIds.length > 0) {
    await db.delete(fishFeedBatchInputs).where(inArray(fishFeedBatchInputs.batchId, fishBatchIds));
  }

  // 1e. Block Mix formulation items & batch inputs
  const blockFormRows = await db.select({ id: blockMixFormulations.id }).from(blockMixFormulations).where(eq(blockMixFormulations.businessId, businessId));
  const blockFormIds = blockFormRows.map((f) => f.id);
  if (blockFormIds.length > 0) {
    await db.delete(blockMixFormulationItems).where(inArray(blockMixFormulationItems.formulationId, blockFormIds));
  }
  const blockBatchRows = await db.select({ id: blockMixBatches.id }).from(blockMixBatches).where(eq(blockMixBatches.businessId, businessId));
  const blockBatchIds = blockBatchRows.map((b) => b.id);
  if (blockBatchIds.length > 0) {
    await db.delete(blockMixBatchInputs).where(inArray(blockMixBatchInputs.mixBatchId, blockBatchIds));
  }

  // 1f. Employee child tables
  const empRows = await db.select({ id: employees.id }).from(employees).where(eq(employees.businessId, businessId));
  const empIds = empRows.map((e) => e.id);
  if (empIds.length > 0) {
    await db.delete(employeeDocuments).where(inArray(employeeDocuments.employeeId, empIds));
    await db.delete(employeeHistory).where(inArray(employeeHistory.employeeId, empIds));
    await db.delete(payrollAttendance).where(inArray(payrollAttendance.employeeId, empIds));
    await db.delete(payrollEntries).where(inArray(payrollEntries.employeeId, empIds));
    await db.delete(attendanceLogs).where(inArray(attendanceLogs.employeeId, empIds));
  }

  // 1g. Credit sales & credit payments
  const creditRows = await db.select({ id: creditSales.id }).from(creditSales).where(eq(creditSales.businessId, businessId));
  const creditIds = creditRows.map((c) => c.id);
  if (creditIds.length > 0) {
    await db.delete(creditPayments).where(inArray(creditPayments.creditSaleId, creditIds));
  }

  // 1h. Audit reviews & issue updates
  const reviewRows = await db.select({ id: auditReviews.id }).from(auditReviews).where(eq(auditReviews.businessId, businessId));
  const reviewIds = reviewRows.map((r) => r.id);
  if (reviewIds.length > 0) {
    await db.delete(auditIssueUpdates).where(inArray(auditIssueUpdates.issueId, reviewIds));
  }

  // 1i. Advisor notes & note updates
  const noteRows = await db.select({ id: advisorNotes.id }).from(advisorNotes).where(eq(advisorNotes.businessId, businessId));
  const noteIds = noteRows.map((n) => n.id);
  if (noteIds.length > 0) {
    await db.delete(advisorNoteUpdates).where(inArray(advisorNoteUpdates.noteId, noteIds));
  }

  // 1j. Customer interactions
  const custRows = await db.select({ id: customers.id }).from(customers).where(eq(customers.businessId, businessId));
  const custIds = custRows.map((c) => c.id);
  if (custIds.length > 0) {
    await db.delete(customerInteractions).where(inArray(customerInteractions.customerId, custIds));
  }
  await db.delete(customerInteractions).where(eq(customerInteractions.businessId, businessId));

  // ── Step 2: Delete direct business-scoped tables in FK dependency order ──
  const scopedTables: Array<[any, any]> = [
    // 2a. Procurement & supplier transactions
    [goodsReceipts, goodsReceipts.businessId],
    [supplierInvoices, supplierInvoices.businessId],
    [supplierPayments, supplierPayments.businessId],
    [supplierOrders, supplierOrders.businessId],
    [supplierQuotes, supplierQuotes.businessId],
    [purchaseRequisitions, purchaseRequisitions.businessId],

    // 2b. Credit sales & customer operations
    [creditPayments, creditPayments.businessId],
    [creditSales, creditSales.businessId],
    [customerTrackings, customerTrackings.businessId],
    [orderPayments, orderPayments.businessId],
    [fulfillmentMethods, fulfillmentMethods.businessId],

    // 2c. Financial & inventory
    [transactions, transactions.businessId],
    [salesDocuments, salesDocuments.businessId],
    [expenseCategories, expenseCategories.businessId],
    [budgets, budgets.businessId],
    [universalExports, universalExports.businessId],
    [inventoryItems, inventoryItems.businessId],
    [customers, customers.businessId],
    [employees, employees.businessId],
    [assets, assets.businessId],

    // 2d. Payroll & HR
    [payrollAttendance, payrollAttendance.businessId],
    [payrollEntries, payrollEntries.businessId],
    [attendanceLogs, attendanceLogs.businessId],
    [payrollRuns, payrollRuns.businessId],
    [employeeDocuments, employeeDocuments.businessId],
    [employeeHistory, employeeHistory.businessId],

    // 2e. Audits, tasks & approvals
    [actionTasks, actionTasks.businessId],
    [auditReviews, auditReviews.businessId],
    [auditAssignments, auditAssignments.businessId],
    [auditTrail, auditTrail.businessId],
    [advisorNotes, advisorNotes.businessId],
    [advisorAssignments, advisorAssignments.businessId],
    [approvalRequests, approvalRequests.businessId],
    [approvalPolicies, approvalPolicies.scopeBusinessId],
    [notifications, notifications.businessId],
    [dailyNotes, dailyNotes.businessId],
    [businessDocuments, businessDocuments.businessId],
    [businessInsights, businessInsights.businessId],
    [cctvCameras, cctvCameras.businessId],

    // 2f. Formulation batches & QC checks
    [poultryFeedQcChecks, poultryFeedQcChecks.businessId],
    [poultryFeedBatches, poultryFeedBatches.businessId],
    [poultryFeedFormulations, poultryFeedFormulations.businessId],
    [poultryBenchmarkProfiles, poultryBenchmarkProfiles.businessId],

    [fishFeedQcChecks, fishFeedQcChecks.businessId],
    [fishFeedBatches, fishFeedBatches.businessId],
    [fishFeedFormulations, fishFeedFormulations.businessId],
    [aquacultureBenchmarkProfiles, aquacultureBenchmarkProfiles.businessId],

    [blockQcChecks, blockQcChecks.businessId],
    [blockMixBatches, blockMixBatches.businessId],
    [blockMixFormulations, blockMixFormulations.businessId],

    // 2g. Hardware store operations
    [hardwareLogs, hardwareLogs.businessId],
    [hardwareOrders, hardwareOrders.businessId],
    [hardwarePurchases, hardwarePurchases.businessId],
    [hardwareDeliveries, hardwareDeliveries.businessId],

    // 2h. Block Factory operations
    [blockFactoryLogs, blockFactoryLogs.businessId],
    [blockFactoryOrders, blockFactoryOrders.businessId],
    [blockFactoryDeliveries, blockFactoryDeliveries.businessId],
    [blockFactoryChecklists, blockFactoryChecklists.businessId],

    // 2i. Poultry operations
    [poultryLogs, poultryLogs.businessId],
    [poultryFlocks, poultryFlocks.businessId],
    [poultryFeedLogs, poultryFeedLogs.businessId],
    [poultryWaterLogs, poultryWaterLogs.businessId],
    [poultryHealthRecords, poultryHealthRecords.businessId],
    [poultryProduction, poultryProduction.businessId],
    [poultryWeightLogs, poultryWeightLogs.businessId],
    [poultryChecklists, poultryChecklists.businessId],

    // 2j. Aquaculture operations
    [aquacultureLogs, aquacultureLogs.businessId],
    [aquaculturePonds, aquaculturePonds.businessId],
    [aquacultureBatches, aquacultureBatches.businessId],
    [aquacultureFeedLogs, aquacultureFeedLogs.businessId],
    [aquacultureWaterQualityLogs, aquacultureWaterQualityLogs.businessId],
    [aquacultureHarvests, aquacultureHarvests.businessId],
    [aquacultureWeightLogs, aquacultureWeightLogs.businessId],
    [aquacultureChecklists, aquacultureChecklists.businessId],

    // 2k. Livestock operations
    [livestockLogs, livestockLogs.businessId],

    // 2l. Restaurant operations
    [restaurantLogs, restaurantLogs.businessId],
    [restaurantOrders, restaurantOrders.businessId],
    [restaurantWaste, restaurantWaste.businessId],
    [restaurantPurchases, restaurantPurchases.businessId],

    // 2m. Electronics operations
    [electronicsLogs, electronicsLogs.businessId],
    [electronicsOrders, electronicsOrders.businessId],
    [electronicsSerials, electronicsSerials.businessId],
    [electronicsWarranties, electronicsWarranties.businessId],
    [electronicsPurchases, electronicsPurchases.businessId],

    // 2n. Car Wash operations
    [carWashLogs, carWashLogs.businessId],
    [carWashServices, carWashServices.businessId],
    [carWashBookings, carWashBookings.businessId],
    [carWashWashes, carWashWashes.businessId],
    [carWashActivities, carWashActivities.businessId],

    // 2o. Telecom operations
    [telecomLines, telecomLines.businessId],
    [telecomTxns, telecomTxns.businessId],
    [telecomWifiPackages, telecomWifiPackages.businessId],
    [telecomVouchers, telecomVouchers.businessId],
    [telecomActivities, telecomActivities.businessId],

    // 2p. Transport & Fleet operations
    [transportTrackerViolations, transportTrackerViolations.businessId],
    [transportVehicleChecklists, transportVehicleChecklists.businessId],
    [transportMaintenance, transportMaintenance.businessId],
    [transportFuelLogs, transportFuelLogs.businessId],
    [transportBookings, transportBookings.businessId],
    [transportTrips, transportTrips.businessId],
    [transportVehicles, transportVehicles.businessId],
    [transportGeofences, transportGeofences.businessId],

    // 2q. Checklists & locations
    [serviceAreas, serviceAreas.businessId],
    [pickupLocations, pickupLocations.businessId],
    [checklistEntries, checklistEntries.businessId],
    [checklistFlockPlans, checklistFlockPlans.businessId],
    [checklistPlanTemplates, checklistPlanTemplates.businessId],

    // 2r. Executive & metrics
    [businessMetrics, businessMetrics.businessId],
    [aiInsights, aiInsights.businessId],
  ];

  for (const [table, col] of scopedTables) {
    await db.delete(table).where(eq(col, businessId));
  }

  // ── Step 3: Master lists (if requested or deleting) ──
  if (options.deleteMasterLists) {
    const masters: Array<[any, any]> = [
      [poultryProducts, poultryProducts.businessId],
      [blockTypes, blockTypes.businessId],
      [restaurantMenuItems, restaurantMenuItems.businessId],
      [checklistTemplates, checklistTemplates.businessId],
    ];
    for (const [table, col] of masters) {
      await db.delete(table).where(eq(col, businessId));
    }
  }

  // ── Step 4: User assignments ──
  if (options.unassignUsers) {
    await db
      .update(users)
      .set({ assignedBusinessId: null })
      .where(eq(users.assignedBusinessId, businessId));

    const usersWithManage = await db.select({ id: users.id, businessManageIds: users.businessManageIds }).from(users);
    for (const u of usersWithManage) {
      if (Array.isArray(u.businessManageIds) && u.businessManageIds.includes(businessId)) {
        const nextIds = u.businessManageIds.filter((id) => id !== businessId);
        await db.update(users).set({ businessManageIds: nextIds }).where(eq(users.id, u.id));
      }
    }
  }

  // ── Step 5: Scenarios targeting this unit ──
  await db.delete(scenarioSimulations).where(eq(scenarioSimulations.targetBusinessId, businessId));
}

/** GET /api/businesses/[id] — single business + related-record counts. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const businessId = parseInt(id, 10);
    if (!Number.isFinite(businessId)) {
      return NextResponse.json({ success: false, error: "Invalid business id." }, { status: 400 });
    }
    // Impact preview reveals internal record counts — OWNER, or a user granted
    // "Manage Unit" for this exact business (they see the same reset preview).
    const level = await businessControlLevel(request, businessId);
    if (!level) {
      return FORBIDDEN(
        "Only the OWNER — or a user granted “Manage Unit” for this business — can inspect business record counts.",
      );
    }
    const biz = await loadBusiness(businessId);
    if (!biz) {
      return NextResponse.json({ success: false, error: "Business not found." }, { status: 404 });
    }
    const counts = await relatedCounts(businessId);
    return NextResponse.json({ success: true, business: biz, counts });
  } catch (error: any) {
    return apiError(error);
  }
}

/**
 * PATCH /api/businesses/[id] — OWNER edit: rename, change location, change
 * business type, change manager/phone, adjust capital & targets, activate /
 * deactivate (status). A category change automatically re-provisions the
 * unit (starter stock kit + checklist templates for the new type) so every
 * dashboard, inventory, finance and report view stays correct.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  ttlInvalidate("menu");
  ttlInvalidate("init");
  ttlInvalidate("businesses");
  try {
    const { id } = await params;
    const businessId = parseInt(id, 10);
    if (!Number.isFinite(businessId)) {
      return NextResponse.json({ success: false, error: "Invalid business id." }, { status: 400 });
    }
    const biz = await loadBusiness(businessId);
    if (!biz) {
      return NextResponse.json({ success: false, error: "Business not found." }, { status: 404 });
    }

    const body = await request.json();

    // Session-verified gate (secure login cookie — no spoofing):
    //   • OWNER — every field.
    //   • "Manage Unit" grantee — every field EXCEPT `status` (deactivate /
    //     re-activate stays OWNER-only), strictly on their granted unit.
    //   • canManageOnline staff (Users & Access → Permissions) — ONLY the
    //     online-ordering / service-area / customer-contact fields, and only
    //     on a business they can access.
    const level = await businessControlLevel(request, businessId);
    if (!level) {
      const session = await getSessionInfo(request);
      const user = session?.user;
      if (!user || !user.canManageOnline) {
        return FORBIDDEN(
          "Only the OWNER — or a user granted “Manage Unit” for this business — can update it. Staff granted “Online Storefront & Delivery Areas” may manage those settings only.",
        );
      }
      const allowed = await canAccessBusiness(user, businessId);
      if (!allowed) return FORBIDDEN("You do not have access to this business.");
      const touched = Object.keys(body || {}).filter((k) => !["actorUserId", "id"].includes(k));
      const outsideScope = touched.filter(
        (k) => !(ONLINE_ORDERING_FIELDS as readonly string[]).includes(k),
      );
      if (outsideScope.length > 0) {
        return FORBIDDEN(
          `Only the OWNER can change: ${outsideScope.join(", ")}. Granted staff may manage online ordering, service areas & customer contacts only.`,
        );
      }
    }
    if (level === "UNIT_MANAGER") {
      const touched = Object.keys(body || {}).filter((k) => !["actorUserId", "id"].includes(k));
      const outsideScope = touched.filter((k) => k === "status" || k === "isArchived");
      if (outsideScope.length > 0) {
        return FORBIDDEN(
          "Deactivating / re-activating or archiving a unit stays with the OWNER. As a “Manage Unit” grantee you can edit, change business type, manage online ordering & service settings, and reset this unit.",
        );
      }
    }

    const updates: Record<string, any> = {};

    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) {
        return NextResponse.json({ success: false, error: "Business name cannot be empty." }, { status: 400 });
      }
      if (name !== biz.name) {
        const clash = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.name, name));
        if (clash.some((r) => r.id !== businessId)) {
          return NextResponse.json(
            { success: false, error: `Another unit is already named "${name}".` },
            { status: 409 }
          );
        }
      }
      updates.name = name;
    }

    let categoryChanged = false;
    if (typeof body.category === "string" && body.category !== biz.category) {
      const category = body.category.trim();
      if (!VALID_CATEGORIES.includes(category)) {
        return NextResponse.json(
          { success: false, error: `Unknown business type "${category}".` },
          { status: 400 }
        );
      }
      // Re-typing an existing unit is bound by the same Allowed Business
      // Types gate as creating one — otherwise a category flip would bypass
      // the per-Owner grant control. Existing (already-owned) units stay
      // fully manageable: only re-typing into a non-granted type is refused.
      {
        const session = await getSessionInfo(request);
        const typeVerdict = await businessTypeAllowed(
          session?.orgId ?? null,
          category,
          !!session?.user?.isSuperAdmin,
        );
        if (!typeVerdict.allowed) {
          return FORBIDDEN(
            `Your organization is not authorized to operate "${category}" businesses. Ask the platform Super Admin to grant this business type.`,
          );
        }
      }
      updates.category = category;
      categoryChanged = true;
      if (!body.iconName) {
        updates.iconName = CATEGORY_ICON[category] || "Building2";
      }
    }

    if (typeof body.status === "string") {
      const status = body.status.toUpperCase();
      if (!VALID_STATUSES.includes(status)) {
        return NextResponse.json(
          { success: false, error: `Invalid status "${body.status}". Use ACTIVE, EXPANDING, MAINTENANCE or INACTIVE.` },
          { status: 400 }
        );
      }
      updates.status = status;
    }

    if (typeof body.branchLocation === "string") updates.branchLocation = body.branchLocation.trim();
    if (typeof body.region === "string") updates.region = body.region.trim();
    if (typeof body.district === "string") updates.district = body.district.trim();
    if (typeof body.town === "string") updates.town = body.town.trim();
    if (typeof body.managerName === "string") updates.managerName = body.managerName.trim();
    if (typeof body.contactPhone === "string") updates.contactPhone = body.contactPhone.trim();
    if (typeof body.iconName === "string") updates.iconName = body.iconName.trim();

    if (body.initialCapitalGhs !== undefined) {
      const num = Number(body.initialCapitalGhs);
      if (Number.isFinite(num) && num >= 0) updates.initialCapitalGhs = num;
    }
    if (body.monthlyTargetRevenueGhs !== undefined) {
      const num = Number(body.monthlyTargetRevenueGhs);
      if (Number.isFinite(num) && num >= 0) updates.monthlyTargetRevenueGhs = num;
    }

    // Online Ordering & Service Settings
    if (body.onlineOrderingEnabled !== undefined) updates.onlineOrderingEnabled = Boolean(body.onlineOrderingEnabled);
    if (body.pickupEnabled !== undefined) updates.pickupEnabled = Boolean(body.pickupEnabled);
    if (body.deliveryEnabled !== undefined) updates.deliveryEnabled = Boolean(body.deliveryEnabled);
    if (body.serviceRadiusKm !== undefined) {
      const num = Number(body.serviceRadiusKm);
      if (Number.isFinite(num) && num >= 0) updates.serviceRadiusKm = num;
    }
    if (body.serviceNote !== undefined) updates.serviceNote = body.serviceNote ? String(body.serviceNote).trim() : null;
    if (body.customerHelpPhone !== undefined) updates.customerHelpPhone = body.customerHelpPhone ? String(body.customerHelpPhone).trim() : null;
    if (body.momoNumber !== undefined) updates.momoNumber = body.momoNumber ? String(body.momoNumber).trim() : null;
    if (body.momoName !== undefined) updates.momoName = body.momoName ? String(body.momoName).trim() : null;
    if (body.gpsLat !== undefined) {
      const num = Number(body.gpsLat);
      updates.gpsLat = Number.isFinite(num) ? num : null;
    }
    if (body.gpsLng !== undefined) {
      const num = Number(body.gpsLng);
      updates.gpsLng = Number.isFinite(num) ? num : null;
    }
    if (body.watermarkEnabled !== undefined) updates.watermarkEnabled = Boolean(body.watermarkEnabled);
    if (body.watermarkMode !== undefined && ["LIGHT", "BOLD", "SUBTLE"].includes(body.watermarkMode)) {
      updates.watermarkMode = body.watermarkMode;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ success: false, error: "No valid fields to update." }, { status: 400 });
    }

    const [updatedBiz] = await db
      .update(businesses)
      .set(updates)
      .where(eq(businesses.id, businessId))
      .returning();

    // Re-provision if category changed
    let reprovisioned: any = null;
    if (categoryChanged) {
      reprovisioned = await reprovisionForTypeChange({
        id: updatedBiz.id,
        code: updatedBiz.code,
        name: updatedBiz.name,
        category: updatedBiz.category,
      });
    }

    return NextResponse.json({
      success: true,
      business: updatedBiz,
      categoryChanged,
      reprovisioned,
    });
  } catch (error: any) {
    return apiError(error);
  }
}

/**
 * DELETE /api/businesses/[id] — permanent OWNER deletion with full cascade
 * across all relational tables.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  ttlInvalidate("menu");
  ttlInvalidate("init");
  ttlInvalidate("businesses");
  try {
    const { id } = await params;
    const businessId = parseInt(id, 10);
    if (!Number.isFinite(businessId)) {
      return NextResponse.json({ success: false, error: "Invalid business id." }, { status: 400 });
    }
    const biz = await loadBusiness(businessId);
    if (!biz) {
      return NextResponse.json({ success: false, error: "Business not found." }, { status: 404 });
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    // Session-verified OWNER gate (secure login cookie — no spoofing).
    const actor = await requireOwner(request);
    if (!actor) return FORBIDDEN("Only the OWNER can delete businesses.");
    // Tenant boundary FIRST: a non-platform Owner can only ever delete a unit
    // of their own organization (cross-org deletions are refused outright).
    if (!actor.isSuperAdmin && !(await canAccessBusiness(actor, businessId))) {
      return FORBIDDEN("You do not have access to this business.");
    }
    // Mandatory confirmation gate — the caller must echo the exact unit code.
    if (body.confirmCode !== biz.code) {
      return NextResponse.json(
        { success: false, error: `Deletion requires confirmation: send confirmCode "${biz.code}".` },
        { status: 400 }
      );
    }

    const counts = await relatedCounts(businessId);

    // 1. Cascade-purge all records across every domain in safe dependency order
    await purgeBusinessAllRecords(businessId, {
      deleteMasterLists: true,
      unassignUsers: true,
    });

    // 2. Remove user business access grants
    await db.delete(userBusinessAccess).where(eq(userBusinessAccess.businessId, businessId));

    // 3. Finally remove the unit itself
    await db.delete(businesses).where(eq(businesses.id, businessId));

    // 4. Deletion tombstone: the unit code is recorded in system_markers so
    //    NO auto-provisioning path can ever resurrect this unit.
    await recordDeletedBusiness(biz.code);

    ttlInvalidate("menu");
    ttlInvalidate("init");
    ttlInvalidate("businesses");

    return NextResponse.json({
      success: true,
      deleted: { id: biz.id, code: biz.code, name: biz.name },
      removedRecords: counts.totalRecords,
    });
  } catch (error: any) {
    return apiError(error);
  }
}

/**
 * POST /api/businesses/[id] — OWNER "Reset to New Business State".
 *
 * Wipes every OPERATIONAL record of the unit (sales, transactions/expenses,
 * stock & inventory, production & activity logs, orders, deliveries, payroll
 * records, customers, assets, checklist history, metrics, AI insights, export
 * manifests, procurement, credit sales, customer tracking, user access grants)
 * and then re-seeds the exact factory-fresh workspace a brand-new unit gets
 * (zero-based metrics + default checklist templates).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  ttlInvalidate("menu");
  ttlInvalidate("init");
  ttlInvalidate("businesses");
  try {
    const { id } = await params;
    const businessId = parseInt(id, 10);
    if (!Number.isFinite(businessId)) {
      return NextResponse.json({ success: false, error: "Invalid business id." }, { status: 400 });
    }
    const biz = await loadBusiness(businessId);
    if (!biz) {
      return NextResponse.json({ success: false, error: "Business not found." }, { status: 404 });
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const level = await businessControlLevel(request, businessId);
    if (!level) {
      return FORBIDDEN(
        "Only the OWNER — or a user granted “Manage Unit” for this business — can reset a business.",
      );
    }

    // Mandatory confirmation gate — the caller must echo the exact unit code.
    if (body.confirmCode !== biz.code) {
      return NextResponse.json(
        { success: false, error: `Reset requires confirmation: send confirmCode "${biz.code}".` },
        { status: 400 }
      );
    }

    const resetMasterLists = body.resetMasterLists === true;
    const resetUsersFlag = level === "OWNER" && body.resetUsers === true;

    const counts = await relatedCounts(businessId);

    // ── Phase 1: Wipe all operational and relational records ──
    await purgeBusinessAllRecords(businessId, {
      deleteMasterLists: resetMasterLists,
      unassignUsers: resetUsersFlag,
    });

    if (resetUsersFlag) {
      await db.delete(userBusinessAccess).where(eq(userBusinessAccess.businessId, businessId));
    }

    let masterListsReset: string[] = [];
    if (resetMasterLists) {
      masterListsReset = ["poultry_products", "block_types", "restaurant_menu_items", "checklist_templates"];
    }

    // ── Phase 2: Re-seed the factory-fresh workspace ──
    const seeded = await provisionBusiness({
      id: biz.id,
      code: biz.code,
      name: biz.name,
      category: biz.category,
      initialCapitalGhs: biz.initialCapitalGhs,
    });

    ttlInvalidate("menu");
    ttlInvalidate("init");
    ttlInvalidate("businesses");

    return NextResponse.json({
      success: true,
      reset: {
        id: biz.id,
        code: biz.code,
        name: biz.name,
        category: biz.category,
        status: biz.status,
      },
      removedRecords: counts.totalRecords,
      masterListsReset,
      usersUnassigned: resetUsersFlag,
      reseeded: seeded,
      kept: {
        businessSetup: true,
        suppliersShared: true,
        usersAssigned: !resetUsersFlag,
        masterLists: !resetMasterLists,
      },
    });
  } catch (error: any) {
    return apiError(error);
  }
}
