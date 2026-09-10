// Supervisor & Auditor Control Center — API.
// Reviews attach DIRECTLY to the existing worker records (transactions/sales,
// inventory, employees, payroll runs & attendance, assets, CCTV cameras and
// business operations/production logs); nothing here duplicates those
// records. Scoping is enforced server-side on every read & write:
//   OWNER                → every business, every module, controls all Auditor
//                          permissions and may delegate to managers.
//   GENERAL/BRANCH_MANAGER, SUPERVISOR → their accessible businesses
//                          (supervisor scope); managers carrying the
//                          canManageAuditors flag may also grant/revoke
//                          Auditor access inside those businesses.
//   AUDITOR (any other user with an active audit assignment) → strictly the
//                          businesses + modules granted; everything else is
//                          invisible to them.
// Every mutation also writes an immutable audit_trail row.

import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  users,
  transactions,
  inventoryItems,
  employees,
  customers,
  suppliers,
  assets,
  businesses,
  cctvCameras,
  payrollRuns,
  payrollEntries,
  payrollAttendance,
  livestockLogs,
  restaurantLogs,
  electronicsLogs,
  carWashLogs,
  hardwareLogs,
  checklistEntries,
  recordDeletionLogs,
  employeeHistory,
  assetAuditLogs,
  auditAssignments,
  auditReviews,
  auditIssueUpdates,
  auditTrail,
  notifications,
  AUDIT_MODULES,
} from "@/db/schema";
import { getSessionInfo, accessibleBusinessIds, FORBIDDEN, UNAUTHENTICATED } from "@/lib/auth";
import { businessManageIdsOf } from "@/lib/permissions";
import { pushAfterBell } from "@/lib/push";

const MODULES = [...AUDIT_MODULES] as string[];

const REVIEW_ACTIONS = ["VERIFIED", "FLAGGED", "COMMENT", "CORRECTION_REQUESTED"] as const;
const REVIEW_TO_TRAIL: Record<string, string> = {
  VERIFIED: "VERIFY",
  FLAGGED: "FLAG",
  COMMENT: "COMMENT",
  CORRECTION_REQUESTED: "REQUEST_CORRECTION",
};

/** Issue pipeline: FLAGGED → UNDER_REVIEW → CORRECTION_REQUIRED → RESOLVED →
 *  VERIFIED. "OPEN" is the first-release legacy value for FLAGGED. */
const ISSUE_ACTIONS = ["FLAGGED", "CORRECTION_REQUESTED"];
const OPEN_STATUSES = ["FLAGGED", "UNDER_REVIEW", "CORRECTION_REQUIRED"]; // actively awaiting work/verification
const normStatus = (s: string | null | undefined) => (s === "OPEN" ? "FLAGGED" : s || "INFO");
const isIssue = (r: any) => ISSUE_ACTIONS.includes(r.action);
const isOpenIssue = (r: any) => isIssue(r) && OPEN_STATUSES.includes(normStatus(r.status));

/** Notifies a user's dashboard (bell) about issue workflow events — and
 *  mirrors the event as an OS-level push so it lands even outside the app. */
async function notify(userId: number | null | undefined, n: { type: string; title: string; body?: string | null; issueId?: number | null; recordType?: string | null; recordId?: number | null; recordRef?: string | null; businessId?: number | null; branchCode?: string | null; actorName?: string | null }) {
  if (!userId) return;
  await db.insert(notifications).values({
    userId,
    type: n.type,
    title: n.title.slice(0, 240),
    body: (n.body || "").slice(0, 600) || null,
    issueId: n.issueId ?? null,
    recordType: n.recordType ?? null,
    recordId: n.recordId ?? null,
    recordRef: n.recordRef ?? null,
    businessId: n.businessId ?? null,
    branchCode: n.branchCode ?? null,
    actorName: n.actorName ?? null,
  });
  pushAfterBell([Number(userId)], {
    type: n.type,
    title: n.title.slice(0, 240),
    body: (n.body || "").slice(0, 600),
    url: "/?tab=AUDIT",
  });
}

type Scope = {
  eligible: boolean;
  level: "OWNER" | "SUPERVISOR" | "AUDITOR" | "NONE";
  businessIds: number[] | null; // null = unrestricted (OWNER)
  moduleByBusiness: Record<number, string[]>;
  /** Branch restriction per business: undefined/null ⇒ all branches of the
   *  business; otherwise the exact branch codes the auditor may see. */
  branchByBusiness: Record<number, string[] | null>;
  canGrant: boolean;
  /** Businesses a delegated manager may create grants inside (null = unrestricted). */
  grantBusinessIds: number[] | null;
};

async function scopeFor(user: any): Promise<Scope> {
  if (user.role === "OWNER") {
    return { eligible: true, level: "OWNER", businessIds: null, moduleByBusiness: {}, branchByBusiness: {}, canGrant: true, grantBusinessIds: null };
  }
  // Audit & Review is ASSIGNMENT-ONLY: no role (WORKER / BRANCH_MANAGER /
  // SUPERVISOR / GENERAL_MANAGER) gets it by default. A user sees the center
  // only while an OWNER (or a delegated manager) has granted them an active
  // Auditor assignment — and then strictly inside the businesses, branches
  // and modules of that assignment. Managers carrying canManageAuditors may
  // open the center to manage grants inside their own businesses.
  //
  // Additionally, a user the OWNER granted "Manage Business / Unit" power
  // reviews those units in full — every module, every branch — scoped to the
  // granted units only.
  const managedIds = businessManageIdsOf(user);
  const grants = (await db
    .select()
    .from(auditAssignments)
    .where(eq(auditAssignments.userId, user.id))).filter((g) => g.isActive);
  const canGrant = !!user.canManageAuditors;
  if (grants.length === 0 && !canGrant && managedIds.length === 0) {
    return { eligible: false, level: "NONE", businessIds: [], moduleByBusiness: {}, branchByBusiness: {}, canGrant: false, grantBusinessIds: [] };
  }
  const moduleByBusiness: Record<number, string[]> = {};
  const branchByBusiness: Record<number, string[] | null> = {};
  for (const g of grants) {
    const mods = Array.isArray(g.modules) ? (g.modules as string[]) : [];
    moduleByBusiness[g.businessId] = [...new Set([...(moduleByBusiness[g.businessId] || []), ...mods])];
    if (branchByBusiness[g.businessId] === null) continue; // unrestricted grant already covers all branches
    branchByBusiness[g.businessId] = g.branchCode == null
      ? null
      : [...new Set([...(branchByBusiness[g.businessId] || []), g.branchCode])];
  }
  for (const bid of managedIds) {
    moduleByBusiness[bid] = MODULES; // full module coverage for managed units
    branchByBusiness[bid] = null;    // all branches of the managed unit
  }
  const grantBusinessIds = canGrant ? ((await accessibleBusinessIds(user)) || []) : [];
  return {
    eligible: true,
    level: grants.length > 0 ? "AUDITOR" : "SUPERVISOR",
    businessIds: [...new Set([...grants.map((g) => g.businessId), ...managedIds])],
    moduleByBusiness,
    branchByBusiness,
    canGrant,
    grantBusinessIds,
  };
}

const modulesFor = (scope: Scope, businessId: number): string[] =>
  scope.businessIds === null ? MODULES : scope.moduleByBusiness[businessId] || [];

const canSee = (scope: Scope, businessId: number, module: string) =>
  modulesFor(scope, businessId).includes(module);

/** Branch-level enforcement of a grant: branch-scoped auditors never see
 *  records outside their assigned branch codes (branch-less rows in a
 *  branch-restricted business stay hidden). */
const branchOk = (scope: Scope, businessId: number, branchCode: string | null | undefined) => {
  if (scope.businessIds === null) return true;
  if (typeof scope.branchByBusiness === "undefined") return true; // legacy callers
  const allow = scope.branchByBusiness[businessId];
  if (allow === undefined || allow === null) return true;
  if (!branchCode) return false;
  return allow.includes(branchCode);
};

const canSeeRecord = (scope: Scope, businessId: number, module: string, branchCode?: string | null) =>
  canSee(scope, businessId, module) && branchOk(scope, businessId, branchCode);

export type AuditRecordRow = {
  key: string;
  recordType: string;
  recordSource: string | null;
  recordId: number;
  ref: string;
  title: string;
  detail: string;
  module: string;
  businessId: number;
  branchCode: string | null;
  workerName: string | null;
  workerUserId?: number | null; // login account behind the record, when known (issue routing)
  date: string;
  amountGhs: number | null;
  status: string | null;
  /** Number of photos/attachments on the underlying record (for the Records
   *  table's gallery indicator — actual images resolve in the detail view). */
  imageCount?: number;
};

const day10 = (v: any) => String(v ?? "").slice(0, 10);
const tsDay = (v: any) => (v ? new Date(v).toISOString().slice(0, 10) : "");

let codeOfCache: Map<number, string> = new Map();
async function codeOf(): Promise<Map<number, string>> {
  // Refreshed per request so newly-created businesses resolve immediately.
  codeOfCache = new Map((await db.select().from(businesses)).map((b) => [b.id, b.code]));
  return codeOfCache;
}
const branchOf = (businessId: number, branchCode?: string | null) => branchCode || codeOfCache.get(businessId) || null;

/** Pulls the reviewable universe for this caller from the EXISTING tables and
 *  normalizes it into one shape the control center can browse. */
async function collectRecords(scope: Scope): Promise<AuditRecordRow[]> {
  const codeMap = await codeOf();
  const keep = (businessId: number, module: string, branchCode?: string | null) => scope.businessIds === null || canSeeRecord(scope, businessId, module, branchCode);
  const rows: AuditRecordRow[] = [];
  const push = (r: AuditRecordRow) => { if (keep(r.businessId, r.module, r.branchCode)) rows.push(r); };

  // FINANCE — transactions & MoMo (INCOME = sales, EXPENSE/INVESTMENT/TRANSFER)
  const txns = await db.select().from(transactions).orderBy(desc(transactions.id)).limit(240);
  for (const t of txns) {
    const receipts = Array.isArray(t.receiptImages) ? t.receiptImages.length : t.receiptImage ? 1 : 0;
    push({
      key: `TRANSACTION:transactions:${t.id}`, recordType: "TRANSACTION", recordSource: "transactions", recordId: t.id,
      ref: t.transactionNumber, title: `${t.type} · ${t.category} — GH₵ ${Number(t.amountGhs).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
      detail: `${t.paymentMethod} · ${t.date} · ${t.description}${t.recordedBy ? ` · by ${t.recordedBy}` : ""}`,
      module: "FINANCE", businessId: t.businessId, branchCode: branchOf(t.businessId, t.branchCode),
      workerName: t.recordedBy, date: day10(t.date) || tsDay(t.createdAt), amountGhs: t.amountGhs, status: t.status || "COMPLETED",
      imageCount: receipts,
    });
  }

  // INVENTORY — stock items (full detail: quantities, prices, dates, photos)
  const items = await db.select().from(inventoryItems).orderBy(desc(inventoryItems.id)).limit(200);
  for (const i of items) {
    const photoCount = Array.isArray(i.photos) ? i.photos.length : i.photo ? 1 : 0;
    push({
      key: `INVENTORY_ITEM:inventory_items:${i.id}`, recordType: "INVENTORY_ITEM", recordSource: "inventory_items", recordId: i.id,
      ref: i.sku, title: `${i.name} — ${i.quantity} ${i.unit}`,
      detail: `${i.category} · ${i.quantity} ${i.unit} in stock · cost GH₵ ${Number(i.costPriceGhs).toLocaleString("en-US", { minimumFractionDigits: 2 })} · sell GH₵ ${Number(i.sellingPriceGhs).toLocaleString("en-US", { minimumFractionDigits: 2 })} · min ${i.minStockThreshold} ${i.unit}${i.expiryDate ? ` · expires ${i.expiryDate}` : ""}${photoCount > 0 ? ` · ${photoCount} photo(s)` : ""}${i.registeredByName ? ` · registered by ${i.registeredByName}` : ""}`,
      module: "INVENTORY", businessId: i.businessId, branchCode: branchOf(i.businessId, i.branchCode),
      workerName: i.registeredByName, date: tsDay(i.registeredAt), amountGhs: i.sellingPriceGhs, status: i.status || "IN_STOCK",
      imageCount: photoCount,
    });
  }

  // EMPLOYEES
  const emps = await db.select().from(employees).orderBy(desc(employees.id)).limit(200);
  for (const e of emps) {
    push({
      key: `EMPLOYEE:employees:${e.id}`, recordType: "EMPLOYEE", recordSource: "employees", recordId: e.id,
      ref: `EMP-${e.id}`, title: `${e.name} — ${e.role}`,
      detail: `Salary GH₵ ${Number(e.salaryGhs).toLocaleString("en-US", { minimumFractionDigits: 2 })} · hired ${e.hireDate} · ${e.branch}`,
      module: "EMPLOYEES", businessId: e.businessId, branchCode: codeMap.get(e.businessId) || null,
      workerName: e.name, date: day10(e.hireDate), amountGhs: e.salaryGhs, status: e.status || "ACTIVE",
      imageCount: e.photo ? 1 : 0,
    });
  }

  // PAYROLL — runs (entries folded in for totals)
  const runs = await db.select().from(payrollRuns).orderBy(desc(payrollRuns.id)).limit(120);
  const entries = await db.select().from(payrollEntries).limit(600);
  const byRun = new Map<number, { count: number; net: number }>();
  for (const en of entries) {
    const cur = byRun.get(en.runId) || { count: 0, net: 0 };
    cur.count += 1; cur.net += en.netPayGhs || 0;
    byRun.set(en.runId, cur);
  }
  for (const r of runs) {
    const agg = byRun.get(r.id) || { count: 0, net: 0 };
    push({
      key: `PAYROLL_RUN:payroll_runs:${r.id}`, recordType: "PAYROLL_RUN", recordSource: "payroll_runs", recordId: r.id,
      ref: `PR-${r.id} · ${r.period}`, title: `Payroll ${r.period} — ${agg.count} employee(s), net GH₵ ${agg.net.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
      detail: r.notes || `Created by ${r.createdByName}`,
      module: "PAYROLL", businessId: r.businessId, branchCode: branchOf(r.businessId, r.branchCode),
      workerName: r.createdByName, date: day10(r.createdAt ? (r.createdAt as any).toISOString?.() ?? r.createdAt : r.period + "-01"),
      amountGhs: agg.net, status: r.status,
    });
  }

  // ATTENDANCE
  const att = await db.select().from(payrollAttendance).orderBy(desc(payrollAttendance.id)).limit(300);
  for (const a of att) {
    push({
      key: `PAYROLL_ATTENDANCE:payroll_attendance:${a.id}`, recordType: "PAYROLL_ATTENDANCE", recordSource: "payroll_attendance", recordId: a.id,
      ref: `ATT-${a.id}`, title: `${a.employeeName} · ${a.date} · ${a.status}${a.leaveType ? ` (${a.leaveType})` : ""}`,
      detail: `${a.hoursWorked}h worked · ${a.overtimeHours}h OT${a.note ? ` · ${a.note}` : ""}`,
      module: "ATTENDANCE", businessId: a.businessId, branchCode: branchOf(a.businessId, a.branchCode),
      workerName: a.employeeName, date: day10(a.date), amountGhs: null, status: a.status,
    });
  }

  // ASSETS
  const assetRows = await db.select().from(assets).orderBy(desc(assets.id)).limit(120);
  for (const a of assetRows) {
    push({
      key: `ASSET:assets:${a.id}`, recordType: "ASSET", recordSource: "assets", recordId: a.id,
      ref: a.assetCode || `AST-${a.id}`, title: `${a.name} — ${a.assetType} · ${a.condition}`,
      detail: `Purchased GH₵ ${Number(a.purchasePriceGhs || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })} · value GH₵ ${Number(a.currentValueGhs || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })} · ${a.location} · next maintenance ${a.nextMaintenanceDate}${a.description ? ` · ${a.description}` : ""}${Array.isArray(a.assetImages) && a.assetImages.length ? ` · ${a.assetImages.length} image(s)` : ""}`,
      module: "ASSETS", businessId: a.businessId, branchCode: branchOf(a.businessId, a.branchCode),
      workerName: a.recorderName, date: tsDay(a.recordedAt), amountGhs: a.currentValueGhs, status: a.condition,
      imageCount: Array.isArray(a.assetImages) ? a.assetImages.length : 0,
    });
  }

  // CCTV
  const cams = await db.select().from(cctvCameras).orderBy(desc(cctvCameras.id)).limit(120);
  for (const c of cams) {
    push({
      key: `CCTV_CAMERA:cctv_cameras:${c.id}`, recordType: "CCTV_CAMERA", recordSource: "cctv_cameras", recordId: c.id,
      ref: `CAM-${c.id}`, title: `${c.name} — ${c.brand} · ${c.cameraType}`,
      detail: `${c.location} · ${c.connectionType}${c.lastTestResult ? ` · last test: ${c.lastTestResult}` : ""}`,
      module: "CCTV", businessId: c.businessId, branchCode: branchOf(c.businessId, c.branchCode),
      workerName: c.createdByName, date: tsDay(c.createdAt), amountGhs: null, status: c.status,
    });
  }

  // OPERATIONS — daily operations / production logs per business line
  const opsPush = (src: string, id: number, businessId: number, ref: string, title: string, detail: string, worker: string | null, date: string) =>
    push({
      key: `OPERATION_LOG:${src}:${id}`, recordType: "OPERATION_LOG", recordSource: src, recordId: id,
      ref, title, detail, module: "OPERATIONS", businessId, branchCode: branchOf(businessId, null),
      workerName: worker, date: day10(date), amountGhs: null, status: "LOGGED",
    });
  for (const l of await db.select().from(livestockLogs).orderBy(desc(livestockLogs.id)).limit(120))
    opsPush("livestock_logs", l.id, l.businessId, l.tagNumber, `${l.animalType} ${l.tagNumber} — ${l.weightKg}kg`, `Breed ${l.breed} · vaccination ${l.vaccinationStatus}${l.pregnantStatus ? " · pregnant" : ""}`, null, l.recordedDate);
  for (const l of await db.select().from(restaurantLogs).orderBy(desc(restaurantLogs.id)).limit(120))
    opsPush("restaurant_logs", l.id, l.businessId, `SHIFT-${l.shiftDate}-${l.id}`, `Kitchen shift ${l.shiftDate} — ${l.totalOrders} orders`, `Popular: ${l.mostPopularDish} · waste ${l.wastePercent}% · MoMo GH₵ ${l.momoReceiptsGhs} / cash GH₵ ${l.cashReceiptsGhs}`, null, l.shiftDate);
  for (const l of await db.select().from(electronicsLogs).orderBy(desc(electronicsLogs.id)).limit(120))
    opsPush("electronics_logs", l.id, l.businessId, l.serialNumber, `${l.productName} — ${l.brand}`, `Warranty ${l.warrantyMonths}mo · retail GH₵ ${l.retailPriceGhs} · ${l.inStock ? "in stock" : "sold out"}`, null, l.lastCheckedDate);
  for (const l of await db.select().from(carWashLogs).orderBy(desc(carWashLogs.id)).limit(120))
    opsPush("car_wash_logs", l.id, l.businessId, `SHIFT-${l.shiftDate}-${l.id}`, `Car wash shift ${l.shiftDate} — ${l.vehiclesWashed} vehicles`, `Revenue GH₵ ${l.totalRevenueGhs} · chemicals ${l.chemicalUsedLiters}L`, null, l.recordedDate || l.shiftDate);
  for (const l of await db.select().from(hardwareLogs).orderBy(desc(hardwareLogs.id)).limit(120))
    opsPush("hardware_logs", l.id, l.businessId, l.receiveNoteNumber, `${l.itemName} × ${l.quantityReceived} ${l.unit}`, `Supplier ${l.supplierName} · condition ${l.condition}`, l.receivedBy, l.recordedDate);

  // OPERATIONS — daily checklist tasks: one auditable row per dated task
  // completion (or pending/incomplete task), linked to the assigned worker's
  // login so flagged issues route straight to their dashboard.
  const chk = await db.select().from(checklistEntries).orderBy(desc(checklistEntries.id)).limit(240);
  for (const c of chk) {
    push({
      key: `CHECKLIST:checklist_entries:${c.id}`, recordType: "CHECKLIST", recordSource: "checklist_entries", recordId: c.id,
      ref: `CHK-${c.checklistDate}-${c.id}`,
      title: `${c.taskLabel} — ${c.checklistDate}${c.isCompleted ? "" : " · INCOMPLETE"}`,
      detail: `${c.category || "GENERAL"} · assigned to ${c.assignedToName || "unassigned"}${c.isCompleted ? ` · done by ${c.completedByName || "staff"}${c.completedAt ? ` at ${new Date(c.completedAt as any).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}` : " · pending completion"}${c.notes ? ` · ${c.notes}` : ""}`,
      module: "OPERATIONS", businessId: c.businessId, branchCode: branchOf(c.businessId, c.branchCode),
      workerName: c.completedByName || c.assignedToName, workerUserId: c.assignedToUserId ?? null,
      date: day10(c.checklistDate), amountGhs: null, status: c.isCompleted ? "COMPLETED" : "PENDING",
    });
  }

  // ASSETS — the immutable activity/approval log (add, edit, transfer, delete,
  // approve, reject) is itself reviewable, and links to the live asset record.
  const assetById = new Map((await db.select().from(assets)).map((a) => [a.id, a]));
  const assetActs = await db.select().from(assetAuditLogs).orderBy(desc(assetAuditLogs.id)).limit(200);
  for (const act of assetActs) {
    const ast = assetById.get(act.assetId);
    if (!ast) continue; // orphan log (asset hard-deleted) — skip
    push({
      key: `ASSET_ACTIVITY:asset_audit_logs:${act.id}`, recordType: "ASSET_ACTIVITY", recordSource: "asset_audit_logs", recordId: act.id,
      ref: act.assetCode || `AST-${act.assetId}`, title: `Asset ${act.assetCode || `AST-${act.assetId}`} — ${act.action}`,
      detail: `${act.status}${act.requestedByName ? ` · requested by ${act.requestedByName}` : ""}${act.approvedByName ? ` · approved by ${act.approvedByName}` : ""}${act.resolvedAt ? ` · resolved ${tsDay(act.resolvedAt)}` : ""}`,
      module: "ASSETS", businessId: ast.businessId, branchCode: branchOf(ast.businessId, ast.branchCode),
      workerName: act.requestedByName, date: tsDay(act.createdAt), amountGhs: ast.currentValueGhs, status: act.status,
    });
  }

  // EMPLOYEES — the HR history log (created, updated, photo/document changes).
  const empHist = await db.select().from(employeeHistory).orderBy(desc(employeeHistory.id)).limit(200);
  for (const h of empHist) {
    push({
      key: `EMPLOYEE_HISTORY:employee_history:${h.id}`, recordType: "EMPLOYEE_HISTORY", recordSource: "employee_history", recordId: h.id,
      ref: `EMP-${h.employeeId}`, title: `${h.summary}`,
      detail: `${h.field ? `${h.field}: ` : ""}${h.oldValue ? `${h.oldValue} → ` : ""}${h.newValue || ""}${h.changedByName ? ` · by ${h.changedByName}` : ""}`,
      module: "EMPLOYEES", businessId: h.businessId, branchCode: codeMap.get(h.businessId) || null,
      workerName: h.changedByName, date: tsDay(h.createdAt), amountGhs: null, status: h.action,
    });
  }

  // DELETION — the immutable record-deletion log (full snapshot preserved).
  // Supplier deletions carry no business context (suppliers are a global
  // directory), so they surface for the unrestricted OWNER only.
  const DELETION_MODULE: Record<string, string> = { TRANSACTIONS: "FINANCE", INVENTORY: "INVENTORY", EMPLOYEES: "EMPLOYEES" };
  const delRows = await db.select().from(recordDeletionLogs).orderBy(desc(recordDeletionLogs.id)).limit(200);
  for (const d of delRows) {
    const mod = DELETION_MODULE[d.module];
    if (!mod) continue;
    const snap: any = d.recordSnapshot || {};
    push({
      key: `DELETION:record_deletion_logs:${d.id}`, recordType: "DELETION", recordSource: "record_deletion_logs", recordId: d.id,
      ref: `DEL-${d.id}`, title: `${d.recordLabel} — deleted`,
      detail: `Deleted by ${d.deletedByName} (${d.deletedByRole}) · reason: ${d.reason}`,
      module: mod, businessId: Number(snap.businessId) || 0, branchCode: branchOf(Number(snap.businessId) || 0, snap.branchCode),
      workerName: d.deletedByName, date: tsDay(d.createdAt), amountGhs: snap.amountGhs ?? null, status: "DELETED",
      imageCount: Array.isArray(snap.photos) ? snap.photos.length : snap.photo ? 1 : Array.isArray(snap.assetImages) ? snap.assetImages.length : 0,
    });
  }

  // USERS — access-management activities (grant/revoke auditor access,
  // delegate/revoke auditor-management) linked into the Records section.
  const userActs = await db.select().from(auditTrail)
    .where(eq(auditTrail.targetType, "USER"))
    .orderBy(desc(auditTrail.id)).limit(120);
  const grantActs = await db.select().from(auditTrail)
    .where(eq(auditTrail.targetType, "GRANT"))
    .orderBy(desc(auditTrail.id)).limit(120);
  const accessActs = [...userActs, ...grantActs].sort((a, b) => b.id - a.id);
  for (const t of accessActs) {
    push({
      key: `USER_ACTIVITY:audit_trail:${t.id}`, recordType: "USER_ACTIVITY", recordSource: "audit_trail", recordId: t.id,
      ref: `ACT-${t.id}`, title: `${t.action} — ${t.targetLabel}`,
      detail: `${t.actorName} (${t.actorRole})${t.reason ? ` · ${t.reason}` : ""}${t.detail ? ` · ${t.detail}` : ""}`,
      module: "USERS", businessId: t.businessId ?? 0, branchCode: t.branchCode || (t.businessId ? codeMap.get(t.businessId) || null : null),
      workerName: t.actorName, date: tsDay(t.createdAt), amountGhs: null, status: "LOGGED",
    });
  }

  return rows;
}

/** Loads reviews visible to this caller (business + module scoped). */
async function scopedReviews(scope: Scope) {
  const all = await db.select().from(auditReviews).orderBy(desc(auditReviews.id)).limit(500);
  if (scope.businessIds === null) return all;
  const ids = scope.businessIds;
  return all.filter((r) => r.businessId != null && ids.includes(r.businessId) && canSee(scope, r.businessId, r.module) && branchOk(scope, r.businessId, (r as any).branchCode));
}

async function scopedTrail(scope: Scope) {
  const all = await db.select().from(auditTrail).orderBy(desc(auditTrail.id)).limit(300);
  if (scope.businessIds === null) return all;
  const ids = scope.businessIds;
  return all.filter((t) => t.businessId == null || (ids.includes(t.businessId) && (!t.branchCode || branchOk(scope, t.businessId, t.branchCode))));
}

function buildReport(records: AuditRecordRow[], reviews: any[]) {
  const monthKey = (d: any) => String(d || "").slice(0, 7);
  const reviewKey = (r: any) => `${r.recordType}:${r.recordSource || ""}:${r.recordId}`;
  const latestByRecord = new Map<string, any>();
  for (const r of reviews) if (!latestByRecord.has(reviewKey(r))) latestByRecord.set(reviewKey(r), r); // reviews arrive DESC

  const totals = {
    records: records.length,
    reviewedRecords: [...latestByRecord.keys()].filter((k) => records.some((rec) => rec.key === k)).length,
    reviews: reviews.length,
    verified: reviews.filter((r) => r.action === "VERIFIED").length,
    openIssues: reviews.filter(isOpenIssue).length,
    flaggedNow: reviews.filter((r) => normStatus(r.status) === "FLAGGED").length,
    underReview: reviews.filter((r) => r.status === "UNDER_REVIEW").length,
    correctionsRequired: reviews.filter((r) => r.status === "CORRECTION_REQUIRED").length,
    resolvedIssues: reviews.filter((r) => isIssue(r) && r.status === "RESOLVED").length,
    verifiedIssues: reviews.filter((r) => isIssue(r) && r.status === "VERIFIED").length,
    flaggedAmount: 0,
    corrections: reviews.filter((r) => r.action === "CORRECTION_REQUESTED").length,
  };

  const recByKey = new Map(records.map((r) => [r.key, r]));
  const discrepancies = reviews
    .filter(isOpenIssue)
    .map((r) => {
      const rec = recByKey.get(`${r.recordType}:${r.recordSource || ""}:${r.recordId}`);
      return {
        reviewId: r.id, recordType: r.recordType, recordId: r.recordId, ref: r.recordRef, title: r.recordTitle,
        action: r.action, status: normStatus(r.status), reason: r.reason, businessId: r.businessId, branchCode: r.branchCode,
        assignedTo: r.assignedUserName || rec?.workerName || r.workerName || null,
        amountGhs: rec?.amountGhs ?? null, raisedBy: r.reviewerName, raisedAt: r.createdAt,
      };
    });
  totals.flaggedAmount = discrepancies.filter((d) => d.recordType === "TRANSACTION").reduce((s, d) => s + (d.amountGhs || 0), 0);

  const byModule = MODULES.map((m) => {
    const recs = records.filter((r) => r.module === m);
    const revs = reviews.filter((r) => r.module === m);
    const reviewedKeys = new Set(revs.map(reviewKey));
    return {
      module: m,
      records: recs.length,
      reviews: revs.length,
      verified: revs.filter((r) => r.action === "VERIFIED").length,
      openIssues: revs.filter(isOpenIssue).length,
      reviewedPct: recs.length ? Math.round((recs.filter((r) => reviewedKeys.has(r.key)).length / recs.length) * 100) : 0,
    };
  }).filter((m) => m.records > 0 || m.reviews > 0);

  const bizIds = [...new Set([...records.map((r) => r.businessId), ...reviews.map((r) => r.businessId)])];
  const byBusiness = bizIds.map((b) => ({
    businessId: b,
    records: records.filter((r) => r.businessId === b).length,
    reviews: reviews.filter((r) => r.businessId === b).length,
    openIssues: reviews.filter((r) => r.businessId === b && isOpenIssue(r)).length,
    resolvedIssues: reviews.filter((r) => r.businessId === b && isIssue(r) && (r.status === "RESOLVED" || r.status === "VERIFIED")).length,
    verified: reviews.filter((r) => r.businessId === b && r.action === "VERIFIED").length,
  }));

  // last 6 months trend of review activity + issues raised
  const months: string[] = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const trend = months.map((m) => ({
    month: m,
    reviews: reviews.filter((r) => monthKey(r.createdAt && (r.createdAt as any).toISOString ? (r.createdAt as any).toISOString() : r.createdAt) === m).length,
    issues: reviews.filter((r) => isIssue(r) && monthKey((r.createdAt as any)?.toISOString ? (r.createdAt as any).toISOString() : r.createdAt) === m).length,
    resolved: reviews.filter((r) => isIssue(r) && (r.status === "RESOLVED" || r.status === "VERIFIED") && monthKey((r.resolvedAt as any)?.toISOString ? (r.resolvedAt as any).toISOString() : r.resolvedAt) === m).length,
  }));

  const perf = new Map<number, any>();
  for (const r of reviews) {
    const p = perf.get(r.reviewerUserId) || { name: r.reviewerName, role: r.reviewerRole, reviews: 0, verifications: 0, flags: 0, corrections: 0, comments: 0 };
    p.reviews += 1;
    if (r.action === "VERIFIED") p.verifications += 1;
    if (r.action === "FLAGGED") p.flags += 1;
    if (r.action === "CORRECTION_REQUESTED") p.corrections += 1;
    if (r.action === "COMMENT") p.comments += 1;
    perf.set(r.reviewerUserId, p);
  }
  // verified/closed issues credited to whoever closed them
  for (const r of reviews.filter((x) => isIssue(x) && (x.status === "VERIFIED" || x.status === "RESOLVED") && x.resolvedByUserId)) {
    const p = perf.get(r.resolvedByUserId);
    if (p) p.resolved = (p.resolved || 0) + 1;
  }
  // cycle time: issue raised → verified/closed
  const cycleHrs = reviews
    .filter((r) => isIssue(r) && (r.status === "VERIFIED" || r.status === "RESOLVED") && r.resolvedAt && r.createdAt)
    .map((r) => (new Date(r.resolvedAt as any).getTime() - new Date(r.createdAt as any).getTime()) / 3600000);
  const avgResolveHrs = cycleHrs.length ? Math.round((cycleHrs.reduce((a, b) => a + b, 0) / cycleHrs.length) * 10) / 10 : null;

  return { totals, byModule, byBusiness, trend, performance: [...perf.values()], discrepancies, avgResolveHrs };
}

const matches = (txt: string | null | undefined, q: string) => (txt || "").toLowerCase().includes(q);

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const scope = await scopeFor(user);

    const url = new URL(request.url);
    if (url.searchParams.get("meta") === "1") {
      return NextResponse.json({ success: true, eligible: scope.eligible, level: scope.level, canGrant: scope.canGrant, businessIds: scope.businessIds, moduleByBusiness: scope.moduleByBusiness, branchByBusiness: scope.branchByBusiness, grantBusinessIds: scope.grantBusinessIds });
    }
    if (!scope.eligible) return FORBIDDEN("You have no Supervisor or Auditor access. The OWNER grants Auditor permissions.");

    // Detail drawer: the complete underlying record (full row + photos +
    // related/child records) for a single row — scope-checked server-side.
    if (url.searchParams.get("record") === "1") {
      const rt = (url.searchParams.get("recordType") || "").toUpperCase();
      const rs = url.searchParams.get("recordSource") || null;
      const rid = Number(url.searchParams.get("recordId") || 0);
      if (!rt || !rid) return NextResponse.json({ success: false, error: "recordType and recordId are required" }, { status: 400 });
      if (rt === "SUPPLIER" || rt === "CUSTOMER") {
        // Global vendor/customer directory — shared across units, so it is
        // visible to every eligible auditor (they already see the full party
        // summary in the parent transaction's related list).
        const detail = await loadFullRecord(rt, rs, rid);
        if (!detail) return NextResponse.json({ success: false, error: "Record not found" }, { status: 404 });
        return NextResponse.json({ success: true, detail });
      }
      const scoped = await resolveRecord(rt, rs, rid);
      if (!scoped) return NextResponse.json({ success: false, error: "Unknown record type" }, { status: 404 });
      if (!canSeeRecord(scope, scoped.businessId ?? 0, scoped.module, scoped.branchCode)) {
        return FORBIDDEN("This record is outside your audit scope.");
      }
      const detail = await loadFullRecord(rt, rs, rid);
      if (!detail) return NextResponse.json({ success: false, error: "Record not found" }, { status: 404 });
      return NextResponse.json({ success: true, detail });
    }

    const fBusiness = Number(url.searchParams.get("businessId") || 0) || null;
    const fModule = (url.searchParams.get("module") || "").toUpperCase();
    const fType = (url.searchParams.get("recordType") || "").toUpperCase();
    const fBranch = (url.searchParams.get("branchCode") || "").toLowerCase();
    const fWorker = (url.searchParams.get("worker") || "").toLowerCase();
    const fStatus = (url.searchParams.get("status") || "").toUpperCase();
    const fq = (url.searchParams.get("q") || "").toLowerCase();
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";

    let records = await collectRecords(scope);
    let reviews = (await scopedReviews(scope)).map((r) => ({ ...r, status: normStatus(r.status) }));
    let log = await scopedTrail(scope);

    if (fBusiness) {
      records = records.filter((r) => r.businessId === fBusiness);
      reviews = reviews.filter((r) => r.businessId === fBusiness);
      log = log.filter((t) => t.businessId === fBusiness || t.businessId == null);
    }
    if (fModule) { records = records.filter((r) => r.module === fModule); reviews = reviews.filter((r) => r.module === fModule); }
    if (fType) records = records.filter((r) => r.recordType === fType);
    if (fBranch) records = records.filter((r) => matches(r.branchCode, fBranch));
    if (fWorker) { records = records.filter((r) => matches(r.workerName, fWorker)); reviews = reviews.filter((r) => matches(r.workerName || "", fWorker)); }
    if (fq) {
      records = records.filter((r) => matches(r.ref, fq) || matches(r.title, fq) || matches(r.detail, fq));
      reviews = reviews.filter((r) => matches(r.recordRef, fq) || matches(r.recordTitle, fq) || matches(r.reason, fq) || matches(r.comment, fq) || matches(r.reviewerName, fq));
      log = log.filter((t) => matches(t.targetLabel, fq) || matches(t.actorName, fq) || matches(t.action, fq) || matches(t.reason, fq) || matches(t.detail, fq));
    }
    if (from) { records = records.filter((r) => !r.date || r.date >= from); reviews = reviews.filter((r) => day10((r.createdAt as any)?.toISOString?.() ?? r.createdAt) >= from); log = log.filter((t) => day10((t.createdAt as any)?.toISOString?.() ?? t.createdAt) >= from); }
    if (to) { records = records.filter((r) => !r.date || r.date <= to); reviews = reviews.filter((r) => day10((r.createdAt as any)?.toISOString?.() ?? r.createdAt) <= to); log = log.filter((t) => day10((t.createdAt as any)?.toISOString?.() ?? t.createdAt) <= to); }

    // review-state per record (UNREVIEWED | VERIFIED | FLAGGED | UNDER_REVIEW | CORRECTION_REQUIRED | RESOLVED | INFO)
    const stateOf = new Map<string, string>();
    const sorted = [...reviews].sort((a, b) => a.id - b.id);
    const stateRank = (s: string) => (OPEN_STATUSES.includes(s) ? 4 : s === "RESOLVED" ? 3 : s === "VERIFIED" ? 2 : 1);
    for (const r of sorted) {
      const k = `${r.recordType}:${r.recordSource || ""}:${r.recordId}`;
      const prev = stateOf.get(k);
      if (!prev || stateRank(r.status) >= stateRank(prev)) stateOf.set(k, r.status);
    }
    let recordsOut = records.map((r) => ({ ...r, reviewState: stateOf.get(r.key) || "UNREVIEWED" }));
    if (fStatus) recordsOut = recordsOut.filter((r) => r.reviewState === fStatus);
    recordsOut.sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.recordId - a.recordId);
    recordsOut = recordsOut.slice(0, 250);

    let grants: any[] = [];
    let grantUsers: any[] = [];
    if (scope.canGrant) {
      const g = await db.select().from(auditAssignments).orderBy(desc(auditAssignments.id));
      grants = scope.grantBusinessIds === null ? g : g.filter((x) => scope.grantBusinessIds!.includes(x.businessId));
      const all = await db.select().from(users);
      grantUsers = all
        .filter((u) => u.role !== "OWNER" && u.isActive)
        .filter((u) => scope.grantBusinessIds === null || ["GENERAL_MANAGER"].includes(u.role) || u.assignedBusinessId == null || scope.grantBusinessIds!.includes(u.assignedBusinessId))
        .map((u) => ({ id: u.id, name: u.name, role: u.role, email: u.email, assignedBusinessId: u.assignedBusinessId, canManageAuditors: !!u.canManageAuditors }));
    }

    // Businesses the caller may see (auditors can be granted businesses that
    // are NOT in their day-job scope, so send the names too).
    const bizAll = await db.select({ id: businesses.id, name: businesses.name, code: businesses.code }).from(businesses);
    const bizList = scope.businessIds === null ? bizAll : bizAll.filter((b) => scope.businessIds!.includes(b.id));

    // Per-issue conversation threads for the issues in view (chronological).
    const issueIds = new Set(reviews.filter(isIssue).map((r) => r.id));
    const threads: Record<number, any[]> = {};
    if (issueIds.size > 0) {
      const upd = await db.select().from(auditIssueUpdates).orderBy(desc(auditIssueUpdates.id)).limit(800);
      for (const u of upd) {
        if (!issueIds.has(u.issueId)) continue;
        (threads[u.issueId] ||= []).push(u);
      }
      for (const k of Object.keys(threads)) threads[Number(k)].reverse();
    }

    const report = buildReport(records, reviews);
    return NextResponse.json({ success: true, scope: { eligible: true, level: scope.level, canGrant: scope.canGrant, businessIds: scope.businessIds, moduleByBusiness: scope.moduleByBusiness, branchByBusiness: scope.branchByBusiness, grantBusinessIds: scope.grantBusinessIds }, bizList, records: recordsOut, reviews, threads, log, grants, grantUsers, report });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/** Resolves the record the review targets DIRECTLY from the source table —
 *  business, branch, module, ref, title and worker are derived server-side so
 *  review records always stay linked to the real worker record. */
async function resolveRecord(recordType: string, recordSource: string | null, recordId: number) {
  const first = async (rows: any[]) => rows[0] || null;
  switch (recordType) {
    case "TRANSACTION": {
      const r = await first(await db.select().from(transactions).where(eq(transactions.id, recordId)));
      return r && { businessId: r.businessId, branchCode: r.branchCode, module: "FINANCE", ref: r.transactionNumber, title: `${r.type} · ${r.category} — GH₵ ${Number(r.amountGhs).toLocaleString("en-US", { minimumFractionDigits: 2 })}`, workerName: r.recordedBy };
    }
    case "INVENTORY_ITEM": {
      const r = await first(await db.select().from(inventoryItems).where(eq(inventoryItems.id, recordId)));
      return r && { businessId: r.businessId, branchCode: r.branchCode, module: "INVENTORY", ref: r.sku, title: `${r.name} — ${r.quantity} ${r.unit}`, workerName: null };
    }
    case "EMPLOYEE": {
      const r = await first(await db.select().from(employees).where(eq(employees.id, recordId)));
      return r && { businessId: r.businessId, branchCode: null, module: "EMPLOYEES", ref: `EMP-${r.id}`, title: `${r.name} — ${r.role}`, workerName: r.name };
    }
    case "PAYROLL_RUN": {
      const r = await first(await db.select().from(payrollRuns).where(eq(payrollRuns.id, recordId)));
      return r && { businessId: r.businessId, branchCode: r.branchCode, module: "PAYROLL", ref: `PR-${r.id} · ${r.period}`, title: `Payroll ${r.period} (${r.status})`, workerName: r.createdByName };
    }
    case "PAYROLL_ATTENDANCE": {
      const r = await first(await db.select().from(payrollAttendance).where(eq(payrollAttendance.id, recordId)));
      return r && { businessId: r.businessId, branchCode: r.branchCode, module: "ATTENDANCE", ref: `ATT-${r.id}`, title: `${r.employeeName} · ${r.date} · ${r.status}`, workerName: r.employeeName };
    }
    case "ASSET": {
      const r = await first(await db.select().from(assets).where(eq(assets.id, recordId)));
      return r && { businessId: r.businessId, branchCode: r.branchCode, module: "ASSETS", ref: r.assetCode || `AST-${r.id}`, title: `${r.name} — ${r.assetType} · ${r.condition}`, workerName: r.recorderName };
    }
    case "CCTV_CAMERA": {
      const r = await first(await db.select().from(cctvCameras).where(eq(cctvCameras.id, recordId)));
      return r && { businessId: r.businessId, branchCode: r.branchCode, module: "CCTV", ref: `CAM-${r.id}`, title: `${r.name} — ${r.brand} · ${cFriendly(r)}`, workerName: r.createdByName };
    }
    case "OPERATION_LOG": {
      const table: any = { livestock_logs: livestockLogs, restaurant_logs: restaurantLogs, electronics_logs: electronicsLogs, car_wash_logs: carWashLogs, hardware_logs: hardwareLogs }[recordSource || ""];
      if (!table) return null;
      const r = await first(await db.select().from(table).where(eq(table.id, recordId)));
      if (!r) return null;
      const ref = r.tagNumber || r.serialNumber || r.receiveNoteNumber || `SHIFT-${r.shiftDate}-${r.id}`;
      return { businessId: r.businessId, branchCode: null, module: "OPERATIONS", ref, title: `Operations log ${ref}`, workerName: r.receivedBy || null };
    }
    case "CHECKLIST": {
      const r = await first(await db.select().from(checklistEntries).where(eq(checklistEntries.id, recordId)));
      if (!r) return null;
      return {
        businessId: r.businessId, branchCode: r.branchCode, module: "OPERATIONS",
        ref: `CHK-${r.checklistDate}-${r.id}`,
        title: `${r.taskLabel} — ${r.checklistDate}${r.isCompleted ? "" : " · INCOMPLETE"}`,
        workerName: r.completedByName || r.assignedToName,
        workerUserId: r.assignedToUserId ?? null,
      };
    }
    case "ASSET_ACTIVITY": {
      const r = await first(await db.select().from(assetAuditLogs).where(eq(assetAuditLogs.id, recordId)));
      if (!r) return null;
      const ast = r.assetId ? await first(await db.select().from(assets).where(eq(assets.id, r.assetId))) : null;
      return { businessId: ast?.businessId, branchCode: ast?.branchCode, module: "ASSETS", ref: r.assetCode || `AST-${r.assetId}`, title: `Asset ${r.assetCode || `AST-${r.assetId}`} — ${r.action}`, workerName: r.requestedByName };
    }
    case "EMPLOYEE_HISTORY": {
      const r = await first(await db.select().from(employeeHistory).where(eq(employeeHistory.id, recordId)));
      return r && { businessId: r.businessId, branchCode: null, module: "EMPLOYEES", ref: `EMP-${r.employeeId}`, title: r.summary, workerName: r.changedByName };
    }
    case "DELETION": {
      const r = await first(await db.select().from(recordDeletionLogs).where(eq(recordDeletionLogs.id, recordId)));
      if (!r) return null;
      const snap: any = r.recordSnapshot || {};
      const mod = ({ TRANSACTIONS: "FINANCE", INVENTORY: "INVENTORY", EMPLOYEES: "EMPLOYEES" } as Record<string, string>)[r.module];
      if (!mod) return null;
      return { businessId: Number(snap.businessId) || 0, branchCode: snap.branchCode, module: mod, ref: `DEL-${r.id}`, title: `${r.recordLabel} — deleted`, workerName: r.deletedByName };
    }
    case "USER_ACTIVITY": {
      const r = await first(await db.select().from(auditTrail).where(eq(auditTrail.id, recordId)));
      return r && { businessId: r.businessId ?? 0, branchCode: r.branchCode, module: "USERS", ref: `ACT-${r.id}`, title: `${r.action} — ${r.targetLabel}`, workerName: r.actorName };
    }
    case "PAYROLL_ENTRY": {
      const r = await first(await db.select().from(payrollEntries).where(eq(payrollEntries.id, recordId)));
      return r && { businessId: r.businessId, branchCode: r.branchCode, module: "PAYROLL", ref: `PE-${r.id}`, title: `${r.employeeName} — net GH₵ ${Number(r.netPayGhs).toLocaleString("en-US", { minimumFractionDigits: 2 })}`, workerName: r.employeeName };
    }
    default:
      return null;
  }
}

/** Builds a related-record row (same shape the Records table expects) so the
 *  detail drawer can list children/parties and the auditor can jump straight
 *  into each of them. */
type RelatedRow = {
  key: string;
  recordType: string;
  recordSource: string | null;
  recordId: number;
  ref: string;
  title: string;
  detail: string;
  module: string;
  businessId: number;
  branchCode: string | null;
  date: string;
  amountGhs: number | null;
  status: string | null;
  imageCount: number;
};

const ghc = (n: any) => Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 });

const photoList = (r: any): string[] => {
  const out: string[] = [];
  if (Array.isArray(r?.photos)) for (const p of r.photos) if (typeof p === "string" && p) out.push(p);
  if (Array.isArray(r?.receiptImages)) for (const p of r.receiptImages) if (typeof p === "string" && p) out.push(p);
  if (typeof r?.receiptImage === "string" && r.receiptImage) out.push(r.receiptImage);
  if (Array.isArray(r?.assetImages)) for (const p of r.assetImages) if (typeof p === "string" && p) out.push(p);
  if (typeof r?.photo === "string" && r.photo) out.push(r.photo);
  return out;
};

/** Loads the complete underlying record for the Records detail drawer: the full
 *  source row (`record`), every photo/attachment on it (`photos`), and its
 *  related/child records (`related`, already in Records-row shape). Activity and
 *  deletion rows link back to the live record they mutated. */
async function loadFullRecord(recordType: string, recordSource: string | null, recordId: number) {
  const first = async (rows: any[]) => rows[0] || null;
  const related = (rows: RelatedRow[]) => rows;
  await codeOf();

  switch (recordType) {
    case "TRANSACTION": {
      const r = await first(await db.select().from(transactions).where(eq(transactions.id, recordId)));
      if (!r) return null;
      const rel: RelatedRow[] = [];
      if (r.customerId) {
        const c = await first(await db.select().from(customers).where(eq(customers.id, r.customerId)));
        if (c) rel.push({ key: `CUSTOMER:customers:${c.id}`, recordType: "CUSTOMER", recordSource: "customers", recordId: c.id, ref: `CUS-${c.id}`, title: `${c.name} — ${c.type}`, detail: `${c.phone}${c.region ? ` · ${c.region}` : ""} · total spent GH₵ ${ghc(c.totalSpentGhs)}`, module: "FINANCE", businessId: r.businessId, branchCode: branchOf(r.businessId, r.branchCode), date: tsDay(c.createdAt), amountGhs: c.totalSpentGhs, status: null, imageCount: 0 });
      }
      if (r.supplierId) {
        const s = await first(await db.select().from(suppliers).where(eq(suppliers.id, r.supplierId)));
        if (s) rel.push({ key: `SUPPLIER:suppliers:${s.id}`, recordType: "SUPPLIER", recordSource: "suppliers", recordId: s.id, ref: `SUP-${s.id}`, title: `${s.name} — ${s.category}`, detail: `${s.contactPerson} · ${s.phone} · ${s.paymentTerms} · supplied GH₵ ${ghc(s.totalSuppliedGhs)}`, module: "FINANCE", businessId: r.businessId, branchCode: branchOf(r.businessId, r.branchCode), date: tsDay(s.createdAt), amountGhs: s.totalSuppliedGhs, status: null, imageCount: 0 });
      }
      const linkedPay = await db.select().from(payrollEntries).where(eq(payrollEntries.transactionId, recordId)).limit(1);
      for (const p of linkedPay) rel.push({ key: `PAYROLL_ENTRY:payroll_entries:${p.id}`, recordType: "PAYROLL_ENTRY", recordSource: "payroll_entries", recordId: p.id, ref: `PE-${p.id}`, title: `${p.employeeName} — net GH₵ ${ghc(p.netPayGhs)}`, detail: `Gross GH₵ ${ghc(p.grossPayGhs)} · deductions GH₵ ${ghc(p.totalEmployeeDeductionsGhs)} · ${p.status}`, module: "PAYROLL", businessId: p.businessId, branchCode: p.branchCode, date: tsDay(p.createdAt), amountGhs: p.netPayGhs, status: p.status, imageCount: 0 });
      return { record: r, photos: photoList(r), related: related(rel) };
    }
    case "INVENTORY_ITEM": {
      const r = await first(await db.select().from(inventoryItems).where(eq(inventoryItems.id, recordId)));
      if (!r) return null;
      const sib = await db.select().from(inventoryItems).where(eq(inventoryItems.businessId, r.businessId)).limit(12);
      const rel: RelatedRow[] = sib.filter((x) => x.id !== r.id).slice(0, 8).map((x) => ({
        key: `INVENTORY_ITEM:inventory_items:${x.id}`, recordType: "INVENTORY_ITEM", recordSource: "inventory_items", recordId: x.id, ref: x.sku,
        title: `${x.name} — ${x.quantity} ${x.unit}`, detail: `sell GH₵ ${ghc(x.sellingPriceGhs)} · cost GH₵ ${ghc(x.costPriceGhs)} · status ${x.status || "IN_STOCK"}`,
        module: "INVENTORY", businessId: x.businessId, branchCode: branchOf(x.businessId, x.branchCode), date: tsDay(x.registeredAt), amountGhs: x.sellingPriceGhs, status: x.status || "IN_STOCK", imageCount: Array.isArray(x.photos) ? x.photos.length : 0,
      }));
      return { record: r, photos: photoList(r), related: related(rel) };
    }
    case "EMPLOYEE": {
      const r = await first(await db.select().from(employees).where(eq(employees.id, recordId)));
      if (!r) return null;
      const rel: RelatedRow[] = [];
      const hist = await db.select().from(employeeHistory).where(eq(employeeHistory.employeeId, recordId)).limit(10);
      for (const h of hist) rel.push({ key: `EMPLOYEE_HISTORY:employee_history:${h.id}`, recordType: "EMPLOYEE_HISTORY", recordSource: "employee_history", recordId: h.id, ref: `EMP-${h.employeeId}`, title: h.summary, detail: `${h.field ? `${h.field}: ` : ""}${h.oldValue ? `${h.oldValue} → ` : ""}${h.newValue || ""} · by ${h.changedByName}`, module: "EMPLOYEES", businessId: h.businessId, branchCode: null, date: tsDay(h.createdAt), amountGhs: null, status: h.action, imageCount: 0 });
      const pays = await db.select().from(payrollEntries).where(eq(payrollEntries.employeeId, recordId)).limit(10);
      for (const p of pays) rel.push({ key: `PAYROLL_ENTRY:payroll_entries:${p.id}`, recordType: "PAYROLL_ENTRY", recordSource: "payroll_entries", recordId: p.id, ref: `PE-${p.id}`, title: `${p.employeeName} — net GH₵ ${ghc(p.netPayGhs)}`, detail: `Gross GH₵ ${ghc(p.grossPayGhs)} · ${p.status}`, module: "PAYROLL", businessId: p.businessId, branchCode: p.branchCode, date: tsDay(p.createdAt), amountGhs: p.netPayGhs, status: p.status, imageCount: 0 });
      return { record: r, photos: photoList(r), related: related(rel) };
    }
    case "PAYROLL_RUN": {
      const r = await first(await db.select().from(payrollRuns).where(eq(payrollRuns.id, recordId)));
      if (!r) return null;
      const entries = await db.select().from(payrollEntries).where(eq(payrollEntries.runId, recordId));
      const rel: RelatedRow[] = entries.map((p) => ({
        key: `PAYROLL_ENTRY:payroll_entries:${p.id}`, recordType: "PAYROLL_ENTRY", recordSource: "payroll_entries", recordId: p.id, ref: `PE-${p.id}`,
        title: `${p.employeeName} — net GH₵ ${ghc(p.netPayGhs)}`,
        detail: `Gross GH₵ ${ghc(p.grossPayGhs)} · SSNIT EE GH₵ ${ghc(p.ssnitEmployeeGhs)} · PAYE GH₵ ${ghc(p.payeGhs)} · deductions GH₵ ${ghc(p.totalEmployeeDeductionsGhs)} · ${p.status}`,
        module: "PAYROLL", businessId: p.businessId, branchCode: p.branchCode, date: tsDay(p.createdAt), amountGhs: p.netPayGhs, status: p.status, imageCount: 0,
      }));
      return { record: r, photos: [], related: related(rel) };
    }
    case "ASSET": {
      const r = await first(await db.select().from(assets).where(eq(assets.id, recordId)));
      if (!r) return null;
      const acts = await db.select().from(assetAuditLogs).where(eq(assetAuditLogs.assetId, recordId)).limit(12);
      const rel: RelatedRow[] = acts.map((a) => ({
        key: `ASSET_ACTIVITY:asset_audit_logs:${a.id}`, recordType: "ASSET_ACTIVITY", recordSource: "asset_audit_logs", recordId: a.id, ref: a.assetCode || `AST-${a.assetId}`,
        title: `Asset ${a.assetCode || `AST-${a.assetId}`} — ${a.action}`,
        detail: `${a.status}${a.requestedByName ? ` · requested by ${a.requestedByName}` : ""}${a.approvedByName ? ` · approved by ${a.approvedByName}` : ""}`,
        module: "ASSETS", businessId: r.businessId, branchCode: branchOf(r.businessId, r.branchCode), date: tsDay(a.createdAt), amountGhs: r.currentValueGhs, status: a.status, imageCount: 0,
      }));
      return { record: r, photos: photoList(r), related: related(rel) };
    }
    case "ASSET_ACTIVITY": {
      const r = await first(await db.select().from(assetAuditLogs).where(eq(assetAuditLogs.id, recordId)));
      if (!r) return null;
      const rel: RelatedRow[] = [];
      if (r.assetId) {
        const ast = await first(await db.select().from(assets).where(eq(assets.id, r.assetId)));
        if (ast) rel.push({ key: `ASSET:assets:${ast.id}`, recordType: "ASSET", recordSource: "assets", recordId: ast.id, ref: ast.assetCode || `AST-${ast.id}`, title: `${ast.name} — ${ast.assetType} · ${ast.condition}`, detail: `value GH₵ ${ghc(ast.currentValueGhs)} · ${ast.location}`, module: "ASSETS", businessId: ast.businessId, branchCode: branchOf(ast.businessId, ast.branchCode), date: tsDay(ast.recordedAt), amountGhs: ast.currentValueGhs, status: ast.condition, imageCount: Array.isArray(ast.assetImages) ? ast.assetImages.length : 0 });
      }
      return { record: r, photos: [], related: related(rel) };
    }
    case "EMPLOYEE_HISTORY": {
      const r = await first(await db.select().from(employeeHistory).where(eq(employeeHistory.id, recordId)));
      if (!r) return null;
      const rel: RelatedRow[] = [];
      const emp = await first(await db.select().from(employees).where(eq(employees.id, r.employeeId)));
      if (emp) rel.push({ key: `EMPLOYEE:employees:${emp.id}`, recordType: "EMPLOYEE", recordSource: "employees", recordId: emp.id, ref: `EMP-${emp.id}`, title: `${emp.name} — ${emp.role}`, detail: `salary GH₵ ${ghc(emp.salaryGhs)} · ${emp.branch}`, module: "EMPLOYEES", businessId: emp.businessId, branchCode: null, date: day10(emp.hireDate), amountGhs: emp.salaryGhs, status: emp.status || "ACTIVE", imageCount: emp.photo ? 1 : 0 });
      return { record: r, photos: [], related: related(rel) };
    }
    case "DELETION": {
      const r = await first(await db.select().from(recordDeletionLogs).where(eq(recordDeletionLogs.id, recordId)));
      if (!r) return null;
      const snap: any = r.recordSnapshot || {};
      return { record: r, photos: photoList(snap), related: related([]) };
    }
    case "USER_ACTIVITY": {
      const r = await first(await db.select().from(auditTrail).where(eq(auditTrail.id, recordId)));
      return r ? { record: r, photos: [], related: related([]) } : null;
    }
    case "SUPPLIER": {
      const r = await first(await db.select().from(suppliers).where(eq(suppliers.id, recordId)));
      return r ? { record: r, photos: [], related: related([]) } : null;
    }
    case "CUSTOMER": {
      const r = await first(await db.select().from(customers).where(eq(customers.id, recordId)));
      return r ? { record: r, photos: [], related: related([]) } : null;
    }
    case "PAYROLL_ENTRY": {
      const r = await first(await db.select().from(payrollEntries).where(eq(payrollEntries.id, recordId)));
      if (!r) return null;
      const rel: RelatedRow[] = [];
      if (r.runId) {
        const run = await first(await db.select().from(payrollRuns).where(eq(payrollRuns.id, r.runId)));
        if (run) rel.push({ key: `PAYROLL_RUN:payroll_runs:${run.id}`, recordType: "PAYROLL_RUN", recordSource: "payroll_runs", recordId: run.id, ref: `PR-${run.id} · ${run.period}`, title: `Payroll ${run.period} (${run.status})`, detail: `${run.status}${run.approvedByName ? ` · approved by ${run.approvedByName}` : ""}`, module: "PAYROLL", businessId: run.businessId, branchCode: run.branchCode, date: tsDay(run.createdAt), amountGhs: null, status: run.status, imageCount: 0 });
      }
      return { record: r, photos: [], related: related(rel) };
    }
    default:
      return null;
  }
}

/** Routes an issue to the right GoMina user: an explicit pick wins, then the
 *  record's own worker account (checklists), then the active user whose name
 *  matches the record's worker — preferring someone assigned to that business. */
async function resolveAssignee(rec: any, explicitUserId: number | null) {
  if (explicitUserId) {
    const [u] = await db.select().from(users).where(eq(users.id, explicitUserId));
    if (u && u.isActive) return u;
  }
  if (rec.workerUserId) {
    const [u] = await db.select().from(users).where(eq(users.id, Number(rec.workerUserId)));
    if (u && u.isActive) return u;
  }
  if (rec.workerName) {
    const all = await db.select().from(users);
    const matches = all.filter((u) => u.isActive && (u.name || "").toLowerCase() === String(rec.workerName).toLowerCase());
    if (matches.length > 0) return matches.find((u) => u.assignedBusinessId === rec.businessId) || matches[0];
  }
  return null;
}
const cFriendly = (c: any) => `${c.cameraType} @ ${c.location}`;

async function writeTrail(actor: any, entry: { action: string; targetType: string; targetLabel: string; recordType?: string | null; recordId?: number | null; businessId?: number | null; branchCode?: string | null; reason?: string | null; detail?: string | null }) {
  await db.insert(auditTrail).values({
    actorUserId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    action: entry.action,
    targetType: entry.targetType,
    targetLabel: entry.targetLabel,
    recordType: entry.recordType ?? null,
    recordId: entry.recordId ?? null,
    businessId: entry.businessId ?? null,
    branchCode: entry.branchCode ?? null,
    reason: entry.reason ?? null,
    detail: entry.detail ?? null,
  });
}

export async function POST(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const body = await request.json();
    const scope = await scopeFor(user);
    if (!scope.eligible) return FORBIDDEN("You have no Supervisor or Auditor access.");

    // ── Grant / manage Auditor access ─────────────────────────────────────
    if (body.action === "GRANT") {
      if (!scope.canGrant) return FORBIDDEN("Only the OWNER (or a manager the OWNER authorized) manages Auditor access.");
      const targetId = Number(body.userId);
      // Multi-business + multi-branch: body.businessIds (array) wins; the
      // legacy single body.businessId / body.branchCode pair keeps working.
      const useMulti = Array.isArray(body.businessIds) && body.businessIds.length > 0;
      const bizIds: number[] = useMulti
        ? [...new Set((body.businessIds as any[]).map((x: any) => Number(x)).filter(Boolean))]
        : [Number(body.businessId)].filter(Boolean);
      const mods = (Array.isArray(body.modules) ? body.modules : []).map((m: any) => String(m).toUpperCase()).filter((m: string) => MODULES.includes(m));
      if (!targetId || bizIds.length === 0 || mods.length === 0) {
        return NextResponse.json({ success: false, error: "Pick a user, at least one business and at least one module to audit." }, { status: 400 });
      }
      if (scope.grantBusinessIds !== null && bizIds.some((b) => !scope.grantBusinessIds!.includes(b))) {
        return FORBIDDEN("You can only grant Auditor access inside the businesses you manage.");
      }
      const [target] = await db.select().from(users).where(eq(users.id, targetId));
      if (!target || !target.isActive) return NextResponse.json({ success: false, error: "User not found or inactive." }, { status: 404 });
      if (target.role === "OWNER") return NextResponse.json({ success: false, error: "The OWNER already controls all audits." }, { status: 400 });
      const bizRows = await db.select().from(businesses);
      const note = body.note ? String(body.note).trim() : null;
      // Per-business branch selection (multi mode): { [businessId]: [codes] }
      const branchesMap: Record<string, any> = body.branches && typeof body.branches === "object" ? body.branches : {};

      const targetGrants = await db.select().from(auditAssignments).where(eq(auditAssignments.userId, targetId));
      const out: any[] = [];
      let allUpdated = true;
      for (const businessId of bizIds) {
        const biz = bizRows.find((b) => b.id === businessId);
        if (!biz) return NextResponse.json({ success: false, error: `Business ${businessId} not found.` }, { status: 404 });
        const branchList: (string | null)[] = useMulti
          ? (((branchesMap[String(businessId)] || []) as any[]).map((x: any) => String(x).trim()).filter(Boolean).length
              ? [...new Set(((branchesMap[String(businessId)] || []) as any[]).map((x: any) => String(x).trim()).filter(Boolean) as string[])]
              : [null])
          : [body.branchCode ? String(body.branchCode).trim() : null];
        for (const branchCode of branchList) {
          const existing = (targetGrants.find((g) => g.businessId === businessId && (g.branchCode ?? null) === branchCode)) ||
            out.find((g) => g.businessId === businessId && (g.branchCode ?? null) === branchCode);
          if (existing && targetGrants.some((g) => g.id === existing.id)) {
            const [updated] = await db.update(auditAssignments)
              .set({ modules: mods, branchCode, note, isActive: true, grantedByUserId: user.id, grantedByName: user.name, grantedByRole: user.role, userName: target.name, userRole: target.role, updatedAt: new Date() })
              .where(eq(auditAssignments.id, existing.id)).returning();
            await writeTrail(user, { action: "UPDATE_GRANT", targetType: "GRANT", targetLabel: `${target.name} → ${biz.name}`, businessId, branchCode, detail: `Modules: ${mods.join(", ")}${branchCode ? ` · branch ${branchCode}` : ""}${note ? ` · ${note}` : ""}` });
            out.push(updated);
          } else {
            const [grant] = await db.insert(auditAssignments).values({
              userId: targetId, userName: target.name, userRole: target.role,
              businessId, branchCode, modules: mods, note,
              grantedByUserId: user.id, grantedByName: user.name, grantedByRole: user.role,
            }).returning();
            await writeTrail(user, { action: "GRANT_ACCESS", targetType: "GRANT", targetLabel: `${target.name} → ${biz.name}`, businessId, branchCode, detail: `Modules: ${mods.join(", ")}${note ? ` · ${note}` : ""}` });
            out.push(grant);
            allUpdated = false;
          }
        }
      }
      return NextResponse.json({ success: true, grants: out, grant: out[0] || null, count: out.length, updated: allUpdated && out.length > 0 });
    }

    // ── Review an existing record ─────────────────────────────────────────
    const recordType = String(body.recordType || "").toUpperCase();
    const recordId = Number(body.recordId);
    const action = String(body.action || "").toUpperCase();
    if (!REVIEW_ACTIONS.includes(action as any)) {
      return NextResponse.json({ success: false, error: "Unknown review action." }, { status: 400 });
    }
    const rec = await resolveRecord(recordType, body.recordSource ? String(body.recordSource) : null, recordId);
    if (!rec) return NextResponse.json({ success: false, error: "Record not found." }, { status: 404 });
    if (!canSeeRecord(scope, rec.businessId, rec.module, rec.branchCode)) {
      return FORBIDDEN("That record is outside the businesses, branches or modules you are authorized to audit.");
    }
    const reason = String(body.reason || "").trim();
    const comment = String(body.comment || "").trim();
    const evidence = String(body.evidence || "").trim();
    if ((action === "FLAGGED" || action === "CORRECTION_REQUESTED") && !reason) {
      return NextResponse.json({ success: false, error: "A reason is required when flagging an issue or requesting a correction." }, { status: 400 });
    }
    if (!comment && !reason) {
      return NextResponse.json({ success: false, error: "Add a comment or reason for the review." }, { status: 400 });
    }
    const status = action === "VERIFIED" ? "VERIFIED" : action === "COMMENT" ? "INFO" : action === "CORRECTION_REQUESTED" ? "CORRECTION_REQUIRED" : "FLAGGED";
    const issueTitle = String(body.issueTitle || "").trim().slice(0, 160) || (reason || comment).slice(0, 80) || null;
    const photo = String(body.evidencePhoto || "");
    if (photo && !photo.startsWith("data:image/")) {
      return NextResponse.json({ success: false, error: "Evidence photo must be an image file." }, { status: 400 });
    }
    // Route the issue to the user responsible for the record (their dashboard).
    const assignee = ISSUE_ACTIONS.includes(action) ? await resolveAssignee(rec, Number(body.assignedUserId) || null) : null;
    const [review] = await db.insert(auditReviews).values({
      recordType, recordSource: body.recordSource ? String(body.recordSource) : null, recordId,
      recordRef: rec.ref, recordTitle: rec.title, module: rec.module,
      businessId: rec.businessId, branchCode: rec.branchCode, workerName: rec.workerName,
      action, status, reason: reason || null, comment: comment || null, evidence: evidence || null,
      issueTitle: ISSUE_ACTIONS.includes(action) ? issueTitle : null,
      evidencePhoto: photo || null,
      assignedUserId: assignee?.id ?? null, assignedUserName: assignee?.name ?? null, assignedUserRole: assignee?.role ?? null,
      reviewerUserId: user.id, reviewerName: user.name, reviewerRole: user.role,
    }).returning();
    await writeTrail(user, { action: REVIEW_TO_TRAIL[action], targetType: "RECORD", targetLabel: rec.ref || rec.title, recordType, recordId, businessId: rec.businessId, branchCode: rec.branchCode, reason: reason || null, detail: comment || evidence || null });
    if (ISSUE_ACTIONS.includes(action)) {
      await db.insert(auditIssueUpdates).values({
        issueId: review.id, actorUserId: user.id, actorName: user.name, actorRole: user.role,
        action: REVIEW_TO_TRAIL[action], statusFrom: null, statusTo: status,
        note: reason || comment || null, evidence: evidence || null, photo: photo || null,
      });
      if (assignee) {
        await notify(assignee.id, {
          type: action === "CORRECTION_REQUESTED" ? "AUDIT_CORRECTION_REQUIRED" : "AUDIT_ISSUE_ASSIGNED",
          title: `${action === "CORRECTION_REQUESTED" ? "Correction required" : "Issue flagged"}: ${issueTitle || rec.ref}`,
          body: `${reason || ""}${comment ? ` — ${comment}` : ""}`,
          issueId: review.id, recordType, recordId, recordRef: rec.ref,
          businessId: rec.businessId, branchCode: rec.branchCode, actorName: user.name,
        });
      }
    }
    return NextResponse.json({ success: true, review, assignedTo: assignee ? { id: assignee.id, name: assignee.name, role: assignee.role } : null });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const body = await request.json();
    const scope = await scopeFor(user);
    if (!scope.eligible) return FORBIDDEN("You have no Supervisor or Auditor access.");
    const action = String(body.action || "").toUpperCase();

    // ── VERIFY & close an issue (pipeline terminus). "RESOLVE" kept as an
    //    alias from the first release. Allowed from any non-closed state. ────
    if (action === "VERIFY" || action === "RESOLVE") {
      const [row] = await db.select().from(auditReviews).where(eq(auditReviews.id, Number(body.reviewId)));
      if (!row) return NextResponse.json({ success: false, error: "Issue not found." }, { status: 404 });
      if (!canSee(scope, row.businessId, row.module)) {
        return FORBIDDEN("That issue is outside the businesses or modules you are authorized to audit.");
      }
      if (!ISSUE_ACTIONS.includes(row.action)) {
        return NextResponse.json({ success: false, error: "Only flagged issues / correction requests go through verification." }, { status: 400 });
      }
      if (normStatus(row.status) === "VERIFIED") {
        return NextResponse.json({ success: false, error: "This issue is already verified & closed." }, { status: 400 });
      }
      const note = String(body.resolution || "").trim();
      if (!note) return NextResponse.json({ success: false, error: "Add a verification note — what did you confirm before closing it?" }, { status: 400 });
      const from = normStatus(row.status);
      const [updated] = await db.update(auditReviews)
        .set({ status: "VERIFIED", resolvedByUserId: user.id, resolvedByName: user.name, resolvedAt: new Date(), resolutionNote: note })
        .where(eq(auditReviews.id, row.id)).returning();
      await db.insert(auditIssueUpdates).values({
        issueId: row.id, actorUserId: user.id, actorName: user.name, actorRole: user.role,
        action: "VERIFY", statusFrom: from, statusTo: "VERIFIED", note,
      });
      await writeTrail(user, { action: "VERIFY", targetType: "RECORD", targetLabel: row.recordRef || row.recordTitle, recordType: row.recordType, recordId: row.recordId, businessId: row.businessId, branchCode: row.branchCode, reason: row.reason, detail: `Verified & closed (${from} → VERIFIED): ${note}` });
      if (row.assignedUserId && row.assignedUserId !== user.id) {
        await notify(row.assignedUserId, {
          type: "AUDIT_ISSUE_VERIFIED", title: `Verified & closed: ${row.issueTitle || row.recordRef}`,
          body: note, issueId: row.id, recordType: row.recordType, recordId: row.recordId,
          recordRef: row.recordRef, businessId: row.businessId, branchCode: row.branchCode, actorName: user.name,
        });
      }
      return NextResponse.json({ success: true, review: updated });
    }

    // ── Send an issue back for correction → CORRECTION_REQUIRED, notified ───
    if (action === "REQUEST_CORRECTION") {
      const [row] = await db.select().from(auditReviews).where(eq(auditReviews.id, Number(body.reviewId)));
      if (!row) return NextResponse.json({ success: false, error: "Issue not found." }, { status: 404 });
      if (!canSee(scope, row.businessId, row.module)) {
        return FORBIDDEN("That issue is outside the businesses or modules you are authorized to audit.");
      }
      if (!ISSUE_ACTIONS.includes(row.action)) {
        return NextResponse.json({ success: false, error: "Only flagged issues can be sent back for correction." }, { status: 400 });
      }
      const from = normStatus(row.status);
      if (from === "VERIFIED") {
        return NextResponse.json({ success: false, error: "This issue is already verified & closed." }, { status: 400 });
      }
      if (from === "CORRECTION_REQUIRED") {
        return NextResponse.json({ success: false, error: "This issue is already waiting on a correction." }, { status: 400 });
      }
      const note = String(body.resolution || body.note || "").trim();
      if (!note) return NextResponse.json({ success: false, error: "Describe the correction you need from the assigned user." }, { status: 400 });
      const photo = String(body.evidencePhoto || "");
      if (photo && !photo.startsWith("data:image/")) {
        return NextResponse.json({ success: false, error: "Photo must be an image file." }, { status: 400 });
      }
      const [updated] = await db.update(auditReviews)
        .set({ status: "CORRECTION_REQUIRED" })
        .where(eq(auditReviews.id, row.id)).returning();
      await db.insert(auditIssueUpdates).values({
        issueId: row.id, actorUserId: user.id, actorName: user.name, actorRole: user.role,
        action: "REQUEST_CORRECTION", statusFrom: from, statusTo: "CORRECTION_REQUIRED", note, photo: photo || null,
      });
      await writeTrail(user, { action: "REQUEST_CORRECTION", targetType: "RECORD", targetLabel: row.recordRef || row.recordTitle, recordType: row.recordType, recordId: row.recordId, businessId: row.businessId, branchCode: row.branchCode, reason: row.reason, detail: `${from} → CORRECTION_REQUIRED: ${note}` });
      if (row.assignedUserId && row.assignedUserId !== user.id) {
        await notify(row.assignedUserId, {
          type: "AUDIT_CORRECTION_REQUIRED", title: `Correction required: ${row.issueTitle || row.recordRef}`,
          body: note, issueId: row.id, recordType: row.recordType, recordId: row.recordId,
          recordRef: row.recordRef, businessId: row.businessId, branchCode: row.branchCode, actorName: user.name,
        });
      }
      return NextResponse.json({ success: true, review: updated });
    }

    if (action === "REVOKE_GRANT") {
      if (!scope.canGrant) return FORBIDDEN("Only the OWNER (or a manager the OWNER authorized) manages Auditor access.");
      const [grant] = await db.select().from(auditAssignments).where(eq(auditAssignments.id, Number(body.grantId)));
      if (!grant) return NextResponse.json({ success: false, error: "Grant not found." }, { status: 404 });
      if (scope.grantBusinessIds !== null && !scope.grantBusinessIds.includes(grant.businessId)) {
        return FORBIDDEN("You can only manage Auditor access inside the businesses you manage.");
      }
      const [updated] = await db.update(auditAssignments).set({ isActive: false, updatedAt: new Date() }).where(eq(auditAssignments.id, grant.id)).returning();
      await writeTrail(user, { action: "REVOKE_ACCESS", targetType: "GRANT", targetLabel: `${grant.userName} → business #${grant.businessId}`, businessId: grant.businessId, branchCode: grant.branchCode, detail: "Auditor access revoked" });
      return NextResponse.json({ success: true, grant: updated });
    }

    return NextResponse.json({ success: false, error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
