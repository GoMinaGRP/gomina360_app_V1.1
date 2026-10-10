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
import { getTableColumns, getTableName } from "drizzle-orm";
import { and, desc, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import { db, getPool } from "@/db";
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
  poultryFeedLogs,
  poultryProduction,
  poultryHealthRecords,
  poultryFeedFormulations,
  poultryFeedBatches,
  poultryFeedQcChecks,
  fishFeedFormulations,
  fishFeedBatches,
  fishFeedQcChecks,
  blockMixFormulations,
  blockMixBatches,
  checklistEntries,
  transportVehicles,
  transportTrips,
  transportBookings,
  transportMaintenance,
  transportTrackerViolations,
  recordDeletionLogs,
  employeeHistory,
  assetAuditLogs,
  advisorNotes,
  auditAssignments,
  auditReviews,
  auditIssueUpdates,
  auditTrail,
  notifications,
  organizationMembers,
  organizations,
  AUDIT_MODULES,
} from "@/db/schema";
import { getSessionInfo, accessibleBusinessIds, sharesOrganization, FORBIDDEN, UNAUTHENTICATED } from "@/lib/auth";
import { canSeeFinancials } from "@/lib/permissions";
import { auditEscalationRecipients, ownerOrgOfBusiness } from "@/lib/notify";
import { businessManageIdsOf } from "@/lib/permissions";
import { pushAfterBell } from "@/lib/push";
import { apiError } from "@/lib/apiError";
import { mapRawRows } from "@/lib/rawRowMapper";
import { validateOptionalImage } from "@/lib/mediaValidation";
import { cachedJson } from "@/lib/httpCache";

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
/** Default and ceiling for the audit record payload. The default fits a full
 *  portfolio; the ceiling bounds what a client can ask for. */
/** A currency figure inside a stored label: keeps the text, drops the number. */
const LABEL_FIGURE_RE = /(GH₵|GHS|₵)\s*[\d,]+(?:\.\d+)?/g;

const DEFAULT_RECORDS = 2000;
const MAX_RECORDS = 10000;

const normStatus = (s: string | null | undefined) => (s === "OPEN" ? "FLAGGED" : s || "INFO");
const isIssue = (r: any) => ISSUE_ACTIONS.includes(r.action);
const isOpenIssue = (r: any) => isIssue(r) && OPEN_STATUSES.includes(normStatus(r.status));

/** Notifies a user's dashboard (bell) about issue workflow events — and
 *  mirrors the event as an OS-level push so it lands even outside the app. */
async function notify(userId: number | null | undefined, n: { type: string; title: string; body?: string | null; issueId?: number | null; recordType?: string | null; recordId?: number | null; recordRef?: string | null; businessId?: number | null; branchCode?: string | null; actorName?: string | null; priority?: string | null }) {
  if (!userId) return;
  const nOwnerId = n.businessId != null ? await ownerOrgOfBusiness(Number(n.businessId)) : null;
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
    // M1: carry the auditor's severity onto the bell row — the bell renders a
    // colour-coded severity chip from this, and HIGH/CRITICAL escalate triage.
    priority: n.priority ?? null,
    ownerId: nOwnerId,
  });
  pushAfterBell([Number(userId)], {
    type: n.type,
    title: n.title.slice(0, 240),
    body: (n.body || "").slice(0, 600),
    url: "/?tab=AUDIT",
  });
}

/** An issue transition supercedes every bell item that pointed to it — mark
 *  ALL earlier notifications for the issue read (assigned user, watchers,
 *  reviewer), so bells always reflect the CURRENT state of the issue. The
 *  fresh notification for the new state is inserted afterwards and stays
 *  unread for its recipient. */
async function autoReadIssue(issueId: number) {
  await db.update(notifications).set({ isRead: true }).where(eq(notifications.issueId, Number(issueId)));
}

const ISSUE_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const normPriority = (v: any) => (ISSUE_PRIORITIES.includes(String(v || "").toUpperCase() as any) ? String(v).toUpperCase() : "MEDIUM");
// L2: text-only labels — emoji flag glyphs render as tofu (□) in fonts
// without emoji coverage (kiosk/headless), corrupting the bell titles.
const PRIORITY_LABEL: Record<string, string> = { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH", CRITICAL: "CRITICAL" };

/** Business + branch naming for notification text (resolved per flag — the
 *  record row snapshots survive later edits). */
async function bizLabels(businessId: number, branchCode: string | null | undefined) {
  const [b] = await db.select({ name: businesses.name, code: businesses.code }).from(businesses).where(eq(businesses.id, Number(businessId)));
  return { businessName: b?.name || `Business #${businessId}`, branchLabel: branchCode || b?.code || "—" };
}

type Scope = {
  eligible: boolean;
  level: "OWNER" | "SUPERVISOR" | "AUDITOR" | "NONE";
  businessIds: number[] | null; // null = unrestricted (Super Admin)
  /** Caller organizations — used to scope platform-level (businessId=null) rows. */
  ownerIds: number[];
  moduleByBusiness: Record<number, string[]>;
  /** Branch restriction per business: undefined/null ⇒ all branches of the
   *  business; otherwise the exact branch codes the auditor may see. */
  branchByBusiness: Record<number, string[] | null>;
  canGrant: boolean;
  /** Businesses a delegated manager may create grants inside (null = unrestricted). */
  grantBusinessIds: number[] | null;
};

async function scopeFor(user: any): Promise<Scope> {
  if (user.isSuperAdmin) {
    return { eligible: true, level: "OWNER", businessIds: null, ownerIds: [], moduleByBusiness: {}, branchByBusiness: {}, canGrant: true, grantBusinessIds: null };
  }
  if (user.role === "OWNER") {
    // Org OWNER: full audit control of their OWN organization's units only.
    const orgBiz = ((await accessibleBusinessIds(user)) || []).map(Number);
    const moduleByBusiness: Record<number, string[]> = {};
    const branchByBusiness: Record<number, string[] | null> = {};
    for (const bid of orgBiz) { moduleByBusiness[bid] = MODULES; branchByBusiness[bid] = null; }
    return { eligible: true, level: "OWNER", businessIds: orgBiz, ownerIds: user.organizationIds || [], moduleByBusiness, branchByBusiness, canGrant: true, grantBusinessIds: orgBiz };
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
    return { eligible: false, level: "NONE", businessIds: [], ownerIds: [], moduleByBusiness: {}, branchByBusiness: {}, canGrant: false, grantBusinessIds: [] };
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
    ownerIds: user.organizationIds || [],
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
  /** Owning organization, carried only by records that name NO business (access
   *  grants, delegations). Used by the owner-narrowing fallback so those events
   *  stay reachable for their owner; never rendered to the client. */
  ownerId?: number | null;
  branchCode: string | null;
  workerName: string | null;
  workerUserId?: number | null; // login account behind the record, when known (issue routing)
  date: string;
  /** Exact event timestamp (ISO) when the source row carries one that falls
   *  on the SAME calendar day as `date` — powers the within-day
   *  newest-first ordering and the HH:MM stamp on every record. Empty for
   *  date-only sources (hire dates, ops logs without a timestamp) and for
   *  backdated rows whose creation time belongs to another day, so no
   *  misleading time is ever shown. */
  at?: string | null;
  amountGhs: number | null;
  status: string | null;
  /** Number of photos/attachments on the underlying record (for the Records
   *  table's gallery indicator — actual images resolve in the detail view). */
  imageCount?: number;
};

const day10 = (v: any) => String(v ?? "").slice(0, 10);
const tsDay = (v: any) => (v ? new Date(v).toISOString().slice(0, 10) : "");
/** Best-effort ISO timestamp of a row's creation/event time ("" when absent). */
const tsIso = (v: any): string => {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? "" : d.toISOString();
};
/** `at` for an audit row: the event timestamp, but only when it falls on the
 *  record's own business day (see AuditRecordRow.at). */
const atOf = (date: string, ts: any): string => {
  const iso = tsIso(ts);
  return iso && day10(date) === iso.slice(0, 10) ? iso : "";
};

let codeOfCache: Map<number, string> = new Map();
async function codeOf(): Promise<Map<number, string>> {
  // Refreshed per request so newly-created businesses resolve immediately.
  // (The audit request already batched the business list — see loadAuditData —
  // so this only queries on the record-detail path.)
  if (codeOfCache.size === 0) {
    codeOfCache = new Map((await db.select().from(businesses)).map((b) => [b.id, b.code]));
  }
  return codeOfCache;
}
const branchOf = (businessId: number, branchCode?: string | null) => branchCode || codeOfCache.get(businessId) || null;

/** Pulls the reviewable universe for this caller from the EXISTING tables and
 *  normalizes it into one shape the control center can browse. */
/**
 * ── ONE-ROUND-TRIP AUDIT READS ──────────────────────────────────────────────
 *
 * The Audit & Review centre used to issue ~126 SEQUENTIAL queries per request
 * (each `await db.select()` = one network round trip). Against a remote
 * database that is pure latency: measured 1 875 ms at 40 ms RTT, and ~12 s on a
 * cross-region link — for data that is a few thousand rows.
 *
 * Every read is now concatenated into ONE multi-statement simple-protocol
 * query (the same technique /api/init uses), and the big record tables are
 * filtered in SQL by the caller's business scope instead of reading every
 * tenant's rows and discarding them in JavaScript.
 *
 * SAFETY
 *  • Scope is a SUPERSET filter: `canSeeRecord()` (business + module + branch)
 *    still runs in JavaScript afterwards — defence in depth, unchanged.
 *    Super Admin (scope.businessIds === null) gets exactly the previous rows.
 *  • The only interpolated values are integer business ids that came from the
 *    database (never user input); identical to initSnapshot's guarantee.
 *  • If the batch fails (e.g. an older schema missing a table), we fall back to
 *    the original per-read drizzle selects, so behaviour can never regress.
 */
type AuditReadSpec = {
  key: string;
  table: any;
  limit: number | null;
  order: boolean;
  where: string | null;
  /** Business filter for the batched SQL: "business" (default when the table
   *  has a business_id column) or "none" (reads that must keep their original
   *  global shape — the audit trail's platform rows carry a NULL business_id
   *  and payroll entries are joined to scoped runs afterwards). */
  scope?: "business" | "none";
  whereField?: string;
  whereValue?: string;
};
type AuditData = Record<string, any[]>;

const AUDIT_READS: ReadonlyArray<AuditReadSpec> = [
  { key: 'businesses|all|none|', table: businesses, limit: null, order: false, where: null, scope: 'none' },
  { key: 'organizations|all|none|', table: organizations, limit: null, order: false, where: null, scope: 'none' },
  { key: 'organizationMembers|all|none|', table: organizationMembers, limit: null, order: false, where: null, scope: 'none' },
  { key: 'auditAssignments|all|id|', table: auditAssignments, limit: null, order: true, where: null, scope: 'none' },
  { key: 'auditIssueUpdates|800|id|', table: auditIssueUpdates, limit: 800, order: true, where: null, scope: 'none' },
  { key: 'auditTrail|300|id|', table: auditTrail, limit: 300, order: true, where: null, scope: 'none' },
  { key: 'auditTrail|120|id|USER', table: auditTrail, limit: 120, order: true, where: `"target_type" = 'USER'`, whereField: "targetType", whereValue: "USER", scope: 'none' },
  { key: 'auditTrail|120|id|GRANT', table: auditTrail, limit: 120, order: true, where: `"target_type" = 'GRANT'`, whereField: "targetType", whereValue: "GRANT", scope: 'none' },
  { key: 'users|all|id|', table: users, limit: null, order: false, where: null, scope: 'none' },
  { key: 'auditReviews|500|id|', table: auditReviews, limit: 500, order: true, where: null },
  { key: 'transactions|240|id|', table: transactions, limit: 240, order: true, where: null },
  { key: 'inventoryItems|200|id|', table: inventoryItems, limit: 200, order: true, where: null },
  { key: 'employees|200|id|', table: employees, limit: 200, order: true, where: null },
  { key: 'payrollRuns|120|id|', table: payrollRuns, limit: 120, order: true, where: null },
  { key: 'payrollEntries|600|none|', table: payrollEntries, limit: 600, order: false, where: null, scope: 'none' },
  { key: 'payrollAttendance|300|id|', table: payrollAttendance, limit: 300, order: true, where: null },
  { key: 'assets|120|id|', table: assets, limit: 120, order: true, where: null },
  { key: 'cctvCameras|120|id|', table: cctvCameras, limit: 120, order: true, where: null },
  { key: 'livestockLogs|120|id|', table: livestockLogs, limit: 120, order: true, where: null },
  { key: 'restaurantLogs|120|id|', table: restaurantLogs, limit: 120, order: true, where: null },
  { key: 'electronicsLogs|120|id|', table: electronicsLogs, limit: 120, order: true, where: null },
  { key: 'carWashLogs|120|id|', table: carWashLogs, limit: 120, order: true, where: null },
  { key: 'hardwareLogs|120|id|', table: hardwareLogs, limit: 120, order: true, where: null },
  { key: 'poultryFeedLogs|120|id|', table: poultryFeedLogs, limit: 120, order: true, where: null },
  { key: 'poultryProduction|120|id|', table: poultryProduction, limit: 120, order: true, where: null },
  { key: 'poultryHealthRecords|120|id|', table: poultryHealthRecords, limit: 120, order: true, where: null },
  { key: 'poultryFeedFormulations|80|id|', table: poultryFeedFormulations, limit: 80, order: true, where: null },
  { key: 'poultryFeedBatches|120|id|', table: poultryFeedBatches, limit: 120, order: true, where: null },
  { key: 'poultryFeedQcChecks|120|id|', table: poultryFeedQcChecks, limit: 120, order: true, where: null },
  { key: 'fishFeedFormulations|80|id|', table: fishFeedFormulations, limit: 80, order: true, where: null },
  { key: 'fishFeedBatches|120|id|', table: fishFeedBatches, limit: 120, order: true, where: null },
  { key: 'fishFeedQcChecks|120|id|', table: fishFeedQcChecks, limit: 120, order: true, where: null },
  { key: 'blockMixFormulations|80|id|', table: blockMixFormulations, limit: 80, order: true, where: null },
  { key: 'blockMixBatches|120|id|', table: blockMixBatches, limit: 120, order: true, where: null },
  { key: 'assets|all|none|', table: assets, limit: null, order: false, where: null },
  { key: 'assetAuditLogs|200|id|', table: assetAuditLogs, limit: 200, order: true, where: null },
  { key: 'employeeHistory|200|id|', table: employeeHistory, limit: 200, order: true, where: null },
  { key: 'recordDeletionLogs|200|id|', table: recordDeletionLogs, limit: 200, order: true, where: null },
  { key: 'auditTrail|all|none|', table: auditTrail, limit: null, order: false, where: null },
];

const intList = (ids: number[]) => (ids.length ? ids.map((n) => Math.trunc(Number(n)) || 0).join(",") : "-1");

async function loadAuditData(scope: Scope): Promise<AuditData> {
  const scopedIds = scope.businessIds; // null ⇒ Super Admin ⇒ no filter (previous behaviour)
  const buildSql = (spec: AuditReadSpec, scoped: boolean): string => {
    const cols = getTableColumns(spec.table) as Record<string, { name: string }>;
    const tableName = getTableName(spec.table);
    const clauses: string[] = [];
    if (spec.where) clauses.push(spec.where);
    const businessScoped = spec.scope !== "none" && !!cols.businessId;
    if (scoped && scopedIds && businessScoped) clauses.push(`"${cols.businessId.name}" IN (${intList(scopedIds)})`);
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const order = spec.order ? ` ORDER BY "id" DESC` : "";
    const limit = spec.limit ? ` LIMIT ${spec.limit}` : "";
    return `SELECT * FROM "${tableName}"${where}${order}${limit}`;
  };

  try {
    // Assets carry no cap in the original code (lookup map), so they are read
    // in full for Super Admin and by scope for everyone else.
    const sqls = AUDIT_READS.map((spec) => buildSql(spec, true));
    const results = (await getPool().query(sqls.join(";\n") + ";")) as unknown as Array<{ rows: Record<string, any>[] }>;
    const data: AuditData = {};
    AUDIT_READS.forEach((spec, i) => {
      data[spec.key] = mapRawRows(spec.table, results?.[i]?.rows ?? []);
    });
    // Keeps branchOf() (and the record-detail path) working without its own query.
    codeOfCache = new Map((data["businesses|all|none|"] ?? []).map((b: any) => [b.id, b.code]));
    return data;
  } catch (batchError) {
    // Schema-drift safety net: same reads, one query each (the original path).
    console.warn("[audit] batched reads failed, falling back to per-read queries:", (batchError as any)?.message || batchError);
    const data: AuditData = {};
    for (const spec of AUDIT_READS) {
      const cols = getTableColumns(spec.table) as Record<string, any>;
      let q: any = db.select().from(spec.table);
      if (spec.whereField && spec.whereValue !== undefined) q = q.where(eq((spec.table as any)[spec.whereField], spec.whereValue));
      if (spec.order) q = q.orderBy(desc(spec.table.id));
      if (spec.limit) q = q.limit(spec.limit);
      let rows: any[] = await q;
      if (scopedIds && spec.scope !== "none" && cols.businessId) {
        rows = rows.filter((r: any) => r.businessId == null || scopedIds.includes(Number(r.businessId)));
      }
      data[spec.key] = rows;
    }
    codeOfCache = new Map((data["businesses|all|none|"] ?? []).map((b: any) => [b.id, b.code]));
    return data;
  }
}

async function collectRecords(scope: Scope, AUD: AuditData, financialsAuthorized: boolean): Promise<AuditRecordRow[]> {
  const codeMap = await codeOf();
  const keep = (businessId: number, module: string, branchCode?: string | null) => scope.businessIds === null || canSeeRecord(scope, businessId, module, branchCode);
  const rows: AuditRecordRow[] = [];
  const push = (r: AuditRecordRow) => { if (keep(r.businessId, r.module, r.branchCode)) rows.push(r); };

  // FINANCE — transactions & MoMo (INCOME = sales, EXPENSE/INVESTMENT/TRANSFER)
  const txns = AUD["transactions|240|id|"];
  for (const t of txns) {
    const receipts = Array.isArray(t.receiptImages) ? t.receiptImages.length : t.receiptImage ? 1 : 0;
    push({
      key: `TRANSACTION:transactions:${t.id}`, recordType: "TRANSACTION", recordSource: "transactions", recordId: t.id,
      ref: t.transactionNumber, title: `${t.type} · ${t.category} — GH₵ ${Number(t.amountGhs).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
      detail: `${t.paymentMethod} · ${t.date} · ${t.description}${t.recordedBy ? ` · by ${t.recordedBy}` : ""}`,
      module: "FINANCE", businessId: t.businessId, branchCode: branchOf(t.businessId, t.branchCode),
      workerName: t.recordedBy, date: day10(t.date) || tsDay(t.createdAt), at: atOf(day10(t.date) || tsDay(t.createdAt), t.createdAt), amountGhs: t.amountGhs, status: t.status || "COMPLETED",
      imageCount: receipts,
    });
  }

  // INVENTORY — stock items (full detail: quantities, prices, dates, photos)
  const items = AUD["inventoryItems|200|id|"];
  for (const i of items) {
    const photoCount = Array.isArray(i.photos) ? i.photos.length : i.photo ? 1 : 0;
    push({
      key: `INVENTORY_ITEM:inventory_items:${i.id}`, recordType: "INVENTORY_ITEM", recordSource: "inventory_items", recordId: i.id,
      ref: i.sku, title: `${i.name} — ${i.quantity} ${i.unit}`,
      detail: `${i.category} · ${i.quantity} ${i.unit} in stock · cost GH₵ ${Number(i.costPriceGhs).toLocaleString("en-US", { minimumFractionDigits: 2 })} · sell GH₵ ${Number(i.sellingPriceGhs).toLocaleString("en-US", { minimumFractionDigits: 2 })} · min ${i.minStockThreshold} ${i.unit}${i.expiryDate ? ` · expires ${i.expiryDate}` : ""}${photoCount > 0 ? ` · ${photoCount} photo(s)` : ""}${i.registeredByName ? ` · registered by ${i.registeredByName}` : ""}`,
      module: "INVENTORY", businessId: i.businessId, branchCode: branchOf(i.businessId, i.branchCode),
      workerName: i.registeredByName, date: tsDay(i.registeredAt), at: tsIso(i.registeredAt), amountGhs: i.sellingPriceGhs, status: i.status || "IN_STOCK",
      imageCount: photoCount,
    });
  }

  // EMPLOYEES
  const emps = AUD["employees|200|id|"];
  for (const e of emps) {
    push({
      key: `EMPLOYEE:employees:${e.id}`, recordType: "EMPLOYEE", recordSource: "employees", recordId: e.id,
      ref: `EMP-${e.id}`, title: `${e.name} — ${e.role}`,
      // A salary is money: the audit timeline is reachable by any OWNER-granted
      // auditor, who is NOT automatically granted financial access. Without this
      // redaction the timeline printed every employee's monthly salary to a
      // viewer the policy deliberately withholds it from.
      detail: financialsAuthorized
        ? `Salary GH₵ ${Number(e.salaryGhs).toLocaleString("en-US", { minimumFractionDigits: 2 })} · hired ${e.hireDate} · ${e.branch}`
        : `Salary withheld · hired ${e.hireDate} · ${e.branch}`,
      module: "EMPLOYEES", businessId: e.businessId, branchCode: codeMap.get(e.businessId) || null,
      workerName: e.name, date: day10(e.hireDate), at: "",
      amountGhs: financialsAuthorized ? e.salaryGhs : null, status: e.status || "ACTIVE",
      imageCount: e.photo ? 1 : 0,
    });
  }

  // PAYROLL — runs (entries folded in for totals)
  const runs = AUD["payrollRuns|120|id|"];
  const entries = AUD["payrollEntries|600|none|"];
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
      ref: `PR-${r.id} · ${r.period}`,
      title: financialsAuthorized
        ? `Payroll ${r.period} — ${agg.count} employee(s), net GH₵ ${agg.net.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
        : `Payroll ${r.period} — ${agg.count} employee(s), net withheld`,
      detail: r.notes || `Created by ${r.createdByName}`,
      module: "PAYROLL", businessId: r.businessId, branchCode: branchOf(r.businessId, r.branchCode),
      workerName: r.createdByName, date: day10(r.createdAt ? (r.createdAt as any).toISOString?.() ?? r.createdAt : r.period + "-01"),
      at: r.createdAt ? tsIso(r.createdAt) : "",
      amountGhs: financialsAuthorized ? agg.net : null, status: r.status,
    });
  }

  // ATTENDANCE
  const att = AUD["payrollAttendance|300|id|"];
  for (const a of att) {
    push({
      key: `PAYROLL_ATTENDANCE:payroll_attendance:${a.id}`, recordType: "PAYROLL_ATTENDANCE", recordSource: "payroll_attendance", recordId: a.id,
      ref: `ATT-${a.id}`, title: `${a.employeeName} · ${a.date} · ${a.status}${a.leaveType ? ` (${a.leaveType})` : ""}`,
      detail: `${a.hoursWorked}h worked · ${a.overtimeHours}h OT${a.note ? ` · ${a.note}` : ""}`,
      module: "ATTENDANCE", businessId: a.businessId, branchCode: branchOf(a.businessId, a.branchCode),
      workerName: a.employeeName, date: day10(a.date), at: atOf(day10(a.date), (a as any).createdAt), amountGhs: null, status: a.status,
    });
  }

  // ASSETS
  const assetRows = AUD["assets|120|id|"];
  for (const a of assetRows) {
    push({
      key: `ASSET:assets:${a.id}`, recordType: "ASSET", recordSource: "assets", recordId: a.id,
      ref: a.assetCode || `AST-${a.id}`, title: `${a.name} — ${a.assetType} · ${a.condition}`,
      // `/api/init` already treats purchase/current value as capex data and
      // drops it for a viewer the policy does not authorise for asset valuation.
      // The audit timeline rendered it anyway, so the same figure was hidden in
      // one surface and published in another. Same rule here, for consistency.
      detail: `${financialsAuthorized ? `Purchased GH₵ ${Number(a.purchasePriceGhs || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })} · value GH₵ ${Number(a.currentValueGhs || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })} · ` : "Valuation restricted · "}${a.location} · next maintenance ${a.nextMaintenanceDate}${a.description ? ` · ${a.description}` : ""}${Array.isArray(a.assetImages) && a.assetImages.length ? ` · ${a.assetImages.length} image(s)` : ""}`,
      module: "ASSETS", businessId: a.businessId, branchCode: branchOf(a.businessId, a.branchCode),
      workerName: a.recorderName, date: tsDay(a.recordedAt), at: tsIso(a.recordedAt), amountGhs: financialsAuthorized ? a.currentValueGhs : null, status: a.condition,
      imageCount: Array.isArray(a.assetImages) ? a.assetImages.length : 0,
    });
  }

  // CCTV
  const cams = AUD["cctvCameras|120|id|"];
  for (const c of cams) {
    push({
      key: `CCTV_CAMERA:cctv_cameras:${c.id}`, recordType: "CCTV_CAMERA", recordSource: "cctv_cameras", recordId: c.id,
      ref: `CAM-${c.id}`, title: `${c.name} — ${c.brand} · ${c.cameraType}`,
      detail: `${c.location} · ${c.connectionType}${c.lastTestResult ? ` · last test: ${c.lastTestResult}` : ""}`,
      module: "CCTV", businessId: c.businessId, branchCode: branchOf(c.businessId, c.branchCode),
      workerName: c.createdByName, date: tsDay(c.createdAt), at: tsIso(c.createdAt), amountGhs: null, status: c.status,
    });
  }

  // OPERATIONS — daily operations / production logs per business line
  const opsPush = (src: string, id: number, businessId: number, ref: string, title: string, detail: string, worker: string | null, date: string, at: string = "") =>
    push({
      key: `OPERATION_LOG:${src}:${id}`, recordType: "OPERATION_LOG", recordSource: src, recordId: id,
      ref, title, detail, module: "OPERATIONS", businessId, branchCode: branchOf(businessId, null),
      workerName: worker, date: day10(date), at: atOf(day10(date), at), amountGhs: null, status: "LOGGED",
    });
  for (const l of AUD["livestockLogs|120|id|"])
    opsPush("livestock_logs", l.id, l.businessId, l.tagNumber, `${l.animalType} ${l.tagNumber} — ${l.weightKg}kg`, `Breed ${l.breed} · vaccination ${l.vaccinationStatus}${l.pregnantStatus ? " · pregnant" : ""}`, null, l.recordedDate);
  for (const l of AUD["restaurantLogs|120|id|"])
    opsPush("restaurant_logs", l.id, l.businessId, `SHIFT-${l.shiftDate}-${l.id}`, `Kitchen shift ${l.shiftDate} — ${l.totalOrders} orders`, `Popular: ${l.mostPopularDish} · waste ${l.wastePercent}% · MoMo GH₵ ${l.momoReceiptsGhs} / cash GH₵ ${l.cashReceiptsGhs}`, null, l.shiftDate);
  for (const l of AUD["electronicsLogs|120|id|"])
    opsPush("electronics_logs", l.id, l.businessId, l.serialNumber, `${l.productName} — ${l.brand}`, `Warranty ${l.warrantyMonths}mo · retail GH₵ ${l.retailPriceGhs} · ${l.inStock ? "in stock" : "sold out"}`, null, l.lastCheckedDate);
  for (const l of AUD["carWashLogs|120|id|"])
    opsPush("car_wash_logs", l.id, l.businessId, `SHIFT-${l.shiftDate}-${l.id}`, `Car wash shift ${l.shiftDate} — ${l.vehiclesWashed} vehicles`, `Revenue GH₵ ${l.totalRevenueGhs} · chemicals ${l.chemicalUsedLiters}L`, null, l.recordedDate || l.shiftDate);
  for (const l of AUD["hardwareLogs|120|id|"])
    opsPush("hardware_logs", l.id, l.businessId, l.receiveNoteNumber, `${l.itemName} × ${l.quantityReceived} ${l.unit}`, `Supplier ${l.supplierName} · condition ${l.condition}`, l.receivedBy, l.recordedDate, tsIso((l as any).createdAt));
  // POULTRY — closes the "poultry records flagged ✅" hole: feeding,
  // production, health, and the full feed-mill chain (formulas → batches →
  // QC) are auditable records like every other operations log.
  for (const l of AUD["poultryFeedLogs|120|id|"])
    opsPush("poultry_feed_logs", l.id, l.businessId, `FDL-${l.id}`, `Poultry feeding — ${l.feedType} × ${l.quantityKg} kg`, `Source ${l.sourceType || "PURCHASED"}${l.batchNumber ? ` · from batch ${l.batchNumber}` : ""}`, l.recordedByName || null, l.recordedDate, tsIso((l as any).createdAt));
  for (const l of AUD["poultryProduction|120|id|"])
    opsPush("poultry_production", l.id, l.businessId, `PP-${l.id}`, `Poultry production — ${l.productionType}${l.eggsCollected ? ` · ${l.eggsCollected} eggs` : ""}${l.birdsHarvested ? ` · ${l.birdsHarvested} birds` : ""}`, `Flock ${l.batchNumber || l.flockId || "—"}${l.layPercentage ? ` · lay ${l.layPercentage}%` : ""}${l.fcr ? ` · FCR ${l.fcr}` : ""}`, l.recordedByName || null, l.recordedDate, tsIso((l as any).createdAt));
  for (const l of AUD["poultryHealthRecords|120|id|"])
    opsPush("poultry_health_records", l.id, l.businessId, `PHR-${l.id}`, `Poultry health — ${l.recordType}${l.diseaseOrCondition ? ` · ${l.diseaseOrCondition}` : ""}${l.mortalityCount ? ` · ${l.mortalityCount} dead` : ""}`, `Flock ${l.batchNumber || l.flockId || "—"}${l.vaccineOrDrug ? ` · ${l.vaccineOrDrug}` : ""}${l.nextDueDate ? ` · next due ${l.nextDueDate}` : ""}`, l.recordedByName || null, l.recordedDate, tsIso((l as any).createdAt));
  for (const f of AUD["poultryFeedFormulations|80|id|"])
    opsPush("poultry_feed_formulations", f.id, f.businessId, f.formulationNo, `Feed formula — ${f.name} (${f.feedType}) v${f.version || 1}`, `Batch size ${f.batchSizeKg} kg${f.cpPctTarget ? ` · CP ${f.cpPctTarget}%` : ""}${f.active === false ? " · INACTIVE" : ""}`, f.createdByName || null, tsDay(f.createdAt) || "", tsIso(f.createdAt));
  for (const b of AUD["poultryFeedBatches|120|id|"])
    opsPush("poultry_feed_batches", b.id, b.businessId, b.batchNumber, `Feed batch — ${b.formulationName || "formulation"} · ${b.actualInputKg} kg → ${b.actualOutputKg ?? "—"} kg`, `Status ${b.status}${b.yieldPct ? ` · yield ${b.yieldPct}%` : ""}${b.ingredientCostGhs ? ` · cost GH₵ ${Number(b.ingredientCostGhs).toLocaleString("en-US", { minimumFractionDigits: 2 })} (${(b.costPerKgGhs ?? 0).toFixed(2)}/kg)` : ""}`, b.recordedByName || b.operatorName || null, tsDay(b.createdAt) || b.productionDate || "", tsIso(b.createdAt));
  for (const q of AUD["poultryFeedQcChecks|120|id|"])
    opsPush("poultry_feed_qc_checks", q.id, q.businessId, q.batchNumber || `QC-${q.id}`, `Feed QC — ${q.testName} → ${q.passFail}`, `Stage ${q.stage}${q.batchId ? ` · batch ${q.batchNumber || q.batchId}` : ""}${q.testResult ? ` · ${q.testResult}` : ""}`, q.testerName || q.recordedByName || null, tsDay(q.testedAt) || "", tsIso(q.testedAt));
  // FISH FEED MILL — same chain for the aquaculture mill (formulas → batches → QC).
  for (const f of AUD["fishFeedFormulations|80|id|"])
    opsPush("fish_feed_formulations", f.id, f.businessId, f.formulationNo, `Fish feed formula — ${f.name} (${f.species} · ${f.feedClass} ${f.feedStage}) v${f.version || 1}`, `Batch size ${f.batchSizeKg} kg${f.cpPctTarget ? ` · CP ${f.cpPctTarget}%` : ""}${f.active === false ? " · INACTIVE" : ""}`, f.createdByName || null, tsDay(f.createdAt) || "", tsIso(f.createdAt));
  for (const b of AUD["fishFeedBatches|120|id|"])
    opsPush("fish_feed_batches", b.id, b.businessId, b.batchNumber, `Fish feed batch — ${b.formulationName || "formulation"} · ${b.actualInputKg} kg → ${b.actualOutputKg ?? "—"} kg`, `Status ${b.status}${b.yieldPct ? ` · yield ${b.yieldPct}%` : ""}${b.ingredientCostGhs ? ` · cost GH₵ ${Number(b.ingredientCostGhs).toLocaleString("en-US", { minimumFractionDigits: 2 })} (${(b.costPerKgGhs ?? 0).toFixed(2)}/kg)` : ""}`, b.recordedByName || b.operatorName || null, tsDay(b.createdAt) || b.productionDate || "", tsIso(b.createdAt));
  for (const q of AUD["fishFeedQcChecks|120|id|"])
    opsPush("fish_feed_qc_checks", q.id, q.businessId, q.batchNumber || `QC-${q.id}`, `Fish feed QC — ${q.testName} → ${q.passFail}`, `Stage ${q.stage}${q.floatPct != null ? ` · ${q.floatPct}% float` : ""}${q.testResult ? ` · ${q.testResult}` : ""}`, q.testerName || q.recordedByName || null, tsDay(q.testedAt) || "", tsIso(q.testedAt));
  // BLOCK FACTORY — MIXING chain (recipes → mixer batches).
  for (const f of AUD["blockMixFormulations|80|id|"])
    opsPush("block_mix_formulations", f.id, f.businessId, f.formulationNo, `Mix recipe — ${f.name} (${f.blockType}) v${f.version || 1}`, `Batch ${f.batchSizeKg} kg${f.waterCementRatio ? ` · w/c ${f.waterCementRatio}` : ""}${f.active === false ? " · INACTIVE" : ""}`, f.createdByName || null, tsDay(f.createdAt) || "", tsIso(f.createdAt));
  for (const b of AUD["blockMixBatches|120|id|"])
    opsPush("block_mix_batches", b.id, b.businessId, b.mixBatchNumber, `Mix batch — ${b.formulationName || "recipe"} · ${b.actualInputKg} kg → ${b.actualOutputKg ?? "—"} kg`, `Status ${b.status}${b.slumpMm != null ? ` · slump ${b.slumpMm} mm` : ""}${b.costPerKgGhs ? ` · GH₵ ${(b.costPerKgGhs).toFixed(2)}/kg` : ""}`, b.recordedByName || b.operatorName || null, tsDay(b.createdAt) || b.productionDate || "", tsIso(b.createdAt));

  // OPERATIONS — daily checklist tasks: one auditable row per dated task
  // completion (or pending/incomplete task), linked to the assigned worker's
  // login so flagged issues route straight to their dashboard.
  // M1 note: /api/init now auto-generates today's checklist rows for every
  // unit. Those untouched auto copies are schedule noise, not staff actions —
  // the audit trail keeps them ONLY once real activity lands (a completion, a
  // note, or an explicit re-assignment), so this module can't flood the record
  // universe and hide transactions/payroll/etc. behind "pending" rows.
  // Only entries with audit-relevant activity belong in the feed — filter
  // in SQL BEFORE the limit: a burst of freshly generated PENDING entries
  // (e.g. stage-plan checklists across many units) would otherwise push all
  // acted-on history out of the newest-240 window and blank the CHECKLIST
  // record type from the audit trail entirely.
  const chk = await db
    .select()
    .from(checklistEntries)
    .where(
      or(
        eq(checklistEntries.isCompleted, true),
        isNotNull(checklistEntries.notes),
        isNotNull(checklistEntries.completedByName),
      ),
    )
    .orderBy(desc(checklistEntries.id))
    .limit(240);
  for (const c of chk) {
    const hasActivity = !!c.isCompleted || !!c.notes || !!c.completedByName;
    if (!hasActivity) continue;
    const stagePrefix = (c as any).batchNumber
      ? `Flock ${c.batchNumber}${(c as any).stageLabel ? ` · ${(c as any).stageLabel}` : ""}${(c as any).ageDays != null ? ` · day ${c.ageDays}` : ""} · `
      : "";
    push({
      key: `CHECKLIST:checklist_entries:${c.id}`, recordType: "CHECKLIST", recordSource: "checklist_entries", recordId: c.id,
      ref: `CHK-${c.checklistDate}-${c.id}`,
      title: `${c.taskLabel} — ${c.checklistDate}${c.isCompleted ? "" : " · INCOMPLETE"}${String((c as any).priority || "").toUpperCase() === "CRITICAL" ? " · CRITICAL" : ""}`,
      detail: `${stagePrefix}${c.category || "GENERAL"} · assigned to ${c.assignedToName || "unassigned"}${c.isCompleted ? ` · done by ${c.completedByName || "staff"}${c.completedAt ? ` at ${new Date(c.completedAt as any).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}` : " · pending completion"}${c.notes ? ` · ${c.notes}` : ""}`,
      module: "OPERATIONS", businessId: c.businessId, branchCode: branchOf(c.businessId, c.branchCode),
      workerName: c.completedByName || c.assignedToName, workerUserId: c.assignedToUserId ?? null,
      date: day10(c.checklistDate), at: atOf(day10(c.checklistDate), c.completedAt), amountGhs: null, status: c.isCompleted ? "COMPLETED" : "PENDING",
    });
  }

  // ASSETS — the immutable activity/approval log (add, edit, transfer, delete,
  // approve, reject) is itself reviewable, and links to the live asset record.
  const assetById = new Map((AUD["assets|all|none|"]).map((a) => [a.id, a]));
  const assetActs = AUD["assetAuditLogs|200|id|"];
  for (const act of assetActs) {
    const ast = assetById.get(act.assetId);
    if (!ast) continue; // orphan log (asset hard-deleted) — skip
    push({
      key: `ASSET_ACTIVITY:asset_audit_logs:${act.id}`, recordType: "ASSET_ACTIVITY", recordSource: "asset_audit_logs", recordId: act.id,
      ref: act.assetCode || `AST-${act.assetId}`, title: `Asset ${act.assetCode || `AST-${act.assetId}`} — ${act.action}`,
      detail: `${act.status}${act.requestedByName ? ` · requested by ${act.requestedByName}` : ""}${act.approvedByName ? ` · approved by ${act.approvedByName}` : ""}${act.resolvedAt ? ` · resolved ${tsDay(act.resolvedAt)}` : ""}`,
      module: "ASSETS", businessId: ast.businessId, branchCode: branchOf(ast.businessId, ast.branchCode),
      workerName: act.requestedByName, date: tsDay(act.createdAt), at: tsIso(act.createdAt), amountGhs: ast.currentValueGhs, status: act.status,
    });
  }

  // EMPLOYEES — the HR history log (created, updated, photo/document changes).
  const empHist = AUD["employeeHistory|200|id|"];
  for (const h of empHist) {
    push({
      key: `EMPLOYEE_HISTORY:employee_history:${h.id}`, recordType: "EMPLOYEE_HISTORY", recordSource: "employee_history", recordId: h.id,
      ref: `EMP-${h.employeeId}`, title: `${h.summary}`,
      detail: `${h.field ? `${h.field}: ` : ""}${h.oldValue ? `${h.oldValue} → ` : ""}${h.newValue || ""}${h.changedByName ? ` · by ${h.changedByName}` : ""}`,
      module: "EMPLOYEES", businessId: h.businessId, branchCode: codeMap.get(h.businessId) || null,
      workerName: h.changedByName, date: tsDay(h.createdAt), at: tsIso(h.createdAt), amountGhs: null, status: h.action,
    });
  }

  // DELETION — the immutable record-deletion log (full snapshot preserved).
  // Supplier deletions carry no business context (suppliers are a global
  // directory), so they surface for the unrestricted OWNER only.
  const DELETION_MODULE: Record<string, string> = { TRANSACTIONS: "FINANCE", INVENTORY: "INVENTORY", EMPLOYEES: "EMPLOYEES" };
  // Businesses that still exist. A deletion trail outlives the unit it deleted
  // from — that is the point of a trail — so a log row can name a business id
  // that no longer resolves. Publishing that dangling id is actively harmful:
  // the client cannot look it up, and a consumer that resolves owners from the
  // business table reads "unknown business" as "belongs to nobody", which reads
  // as a tenant leak. Such rows are reported as unattached (businessId 0) and
  // carry their own `ownerId`, so the tenant that owns the trail stays explicit.
  const liveBusinessIds = new Set<number>(
    (AUD["businesses|all|none|"] ?? []).map((b: any) => Number(b.id)),
  );
  const delRows = AUD["recordDeletionLogs|200|id|"];
  for (const d of delRows) {
    const mod = DELETION_MODULE[d.module];
    if (!mod) continue;
    const snap: any = d.recordSnapshot || {};
    // The deletion trail is admissible evidence, so it stays complete for an
    // authorised viewer. For everyone else the record stays NAMED — the label a
    // money-module deletion stores carries its amount — while the figure itself
    // is withheld, exactly as it is in the module's own deletion panel.
    const delMoney = financialsAuthorized;
    push({
      key: `DELETION:record_deletion_logs:${d.id}`, recordType: "DELETION", recordSource: "record_deletion_logs", recordId: d.id,
      ref: `DEL-${d.id}`,
      title: `${delMoney ? d.recordLabel : String(d.recordLabel || "").replace(LABEL_FIGURE_RE, "$1 •••••")} — deleted`,
      detail: `Deleted by ${d.deletedByName} (${d.deletedByRole}) · reason: ${d.reason}`,
      module: mod,
      businessId: liveBusinessIds.has(Number(snap.businessId)) ? Number(snap.businessId) : 0,
      ownerId: d.ownerId ?? null,
      branchCode: liveBusinessIds.has(Number(snap.businessId)) ? branchOf(Number(snap.businessId), snap.branchCode) : null,
      workerName: d.deletedByName, date: tsDay(d.createdAt), at: tsIso(d.createdAt), amountGhs: delMoney ? (snap.amountGhs ?? null) : null, status: "DELETED",
      imageCount: Array.isArray(snap.photos) ? snap.photos.length : snap.photo ? 1 : Array.isArray(snap.assetImages) ? snap.assetImages.length : 0,
    });
  }

  // USERS — access-management activities (grant/revoke auditor access,
  // delegate/revoke auditor-management) linked into the Records section.
  const userActs = AUD["auditTrail|120|id|USER"];
  const grantActs = AUD["auditTrail|120|id|GRANT"];
  const accessActs = [...userActs, ...grantActs].sort((a, b) => b.id - a.id);
  for (const t of accessActs) {
    push({
      key: `USER_ACTIVITY:audit_trail:${t.id}`, recordType: "USER_ACTIVITY", recordSource: "audit_trail", recordId: t.id,
      ref: `ACT-${t.id}`, title: `${t.action} — ${t.targetLabel}`,
      detail: `${t.actorName} (${t.actorRole})${t.reason ? ` · ${t.reason}` : ""}${t.detail ? ` · ${t.detail}` : ""}`,
      module: "USERS", businessId: t.businessId ?? 0, ownerId: t.ownerId ?? null, branchCode: t.branchCode || (t.businessId ? codeMap.get(t.businessId) || null : null),
      workerName: t.actorName, date: tsDay(t.createdAt), at: tsIso(t.createdAt), amountGhs: null, status: "LOGGED",
    });
  }

  return rows;
}

/** Loads reviews visible to this caller (business + module scoped). */
function scopedReviews(scope: Scope, AUD: AuditData) {
  const all: any[] = AUD["auditReviews|500|id|"] ?? [];
  if (scope.businessIds === null) return all;
  const ids = scope.businessIds;
  return all.filter((r) => r.businessId != null && ids.includes(r.businessId) && canSee(scope, r.businessId, r.module) && branchOk(scope, r.businessId, (r as any).branchCode));
}

function scopedTrail(scope: Scope, AUD: AuditData) {
  const all: any[] = AUD["auditTrail|300|id|"] ?? [];
  if (scope.businessIds === null) return all;
  const ids = scope.businessIds;
  const orgs = new Set(scope.ownerIds);
  return all.filter((t) => {
    if (t.businessId == null) {
      // Platform-level trail rows (grants, delegations) are tenant data too:
      // visible only inside the organization they were recorded for.
      return t.ownerId != null && orgs.has(Number(t.ownerId));
    }
    return ids.includes(t.businessId) && (!t.branchCode || branchOk(scope, t.businessId, t.branchCode));
  });
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
        // Vendor/customer directories are PER-ORGANIZATION: an auditor may
        // inspect a party detail only when that party belongs to one of the
        // organizations they belong to (Super Admin sees all).
        const detail = await loadFullRecord(rt, rs, rid);
        if (!detail) return NextResponse.json({ success: false, error: "Record not found" }, { status: 404 });
        if (!user.isSuperAdmin) {
          const myOrgs = new Set(user.organizationIds || []);
          const partyOrg = ((detail as any)?.record?.ownerId ?? (detail as any)?.ownerId) != null
            ? Number((detail as any)?.record?.ownerId ?? (detail as any)?.ownerId)
            : null;
          const match = partyOrg == null ? (myOrgs.size === 0 || myOrgs.has(1)) : myOrgs.has(partyOrg);
          if (!match) {
            return FORBIDDEN("This record belongs to another organization.");
          }
        }
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
    // Owner/Organization and multi-unit narrowing (Super Admin views). BOTH are
    // NARROWING ONLY: they intersect with `scope.businessIds`, so a client can
    // never widen what the server already decided this caller may see.
    const fOwnerId = Number(url.searchParams.get("ownerId") || 0) || null;
    const fBusinessIds = (url.searchParams.get("businessIds") || "")
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v) && v > 0);
    const fModule = (url.searchParams.get("module") || "").toUpperCase();
    const fType = (url.searchParams.get("recordType") || "").toUpperCase();
    const fBranch = (url.searchParams.get("branchCode") || "").toLowerCase();
    const fWorker = (url.searchParams.get("worker") || "").toLowerCase();
    const fStatus = (url.searchParams.get("status") || "").toUpperCase();
    const fq = (url.searchParams.get("q") || "").toLowerCase();
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";

    const AUD = await loadAuditData(scope);
    let records = await collectRecords(scope, AUD, canSeeFinancials(user));
    let reviews = scopedReviews(scope, AUD).map((r) => ({ ...r, status: normStatus(r.status) }));
    let log = scopedTrail(scope, AUD);

    // Owner / unit-set narrowing. `ownerId` groups by businesses.owner_id; the
    // two filters intersect with each other and with the caller's own scope.
    const scopedIds = (id: number) => scope.businessIds === null || scope.businessIds.includes(id);
    let narrowed: Set<number> | null = null;
    // Organizations whose unit-less (organization-level) audit events this
    // narrowed view may still show. Derived from the same `chosen` units as
    // `narrowed`, then INTERSECTED with the caller's own organizations so the
    // fallback can never reach a tenant the caller could not already see.
    let orgScopeIds: Set<number> = new Set();
    // business id → owning organization, for records whose business cannot be
    // resolved by id alone (below).
    let bizOwnerById: Map<number, number> = new Map();
    if (fOwnerId !== null || fBusinessIds.length > 0) {
      const ownerBiz = (AUD["businesses|all|none|"] ?? []).map((b: any) => ({ id: b.id, ownerId: b.ownerId }));
      bizOwnerById = new Map(ownerBiz.map((b: any) => [Number(b.id), Number(b.ownerId ?? 1)]));
      const byOwner = fOwnerId !== null ? ownerBiz.filter((b) => Number(b.ownerId ?? 1) === fOwnerId) : ownerBiz;
      const chosen = fBusinessIds.length > 0 ? byOwner.filter((b) => fBusinessIds.includes(Number(b.id))) : byOwner;
      const chosenScoped = chosen.filter((b) => scopedIds(Number(b.id)));
      orgScopeIds = new Set(chosenScoped.map((b) => Number(b.ownerId ?? 1)));
      if (scope.businessIds !== null) {
        const mine = new Set((scope.ownerIds || []).map(Number));
        orgScopeIds = new Set([...orgScopeIds].filter((o) => mine.has(o)));
      }
      narrowed = new Set(chosenScoped.map((b) => Number(b.id)));
      if (narrowed.size === 0) {
        // Nothing in scope — an empty result is the honest answer (never fall
        // back to "everything", which would silently widen the view).
        records = [];
        reviews = [];
        log = [];
      }
    }
    if (narrowed) {
      // A record that names NO business (organization-level events — access
      // grants, delegations) cannot be matched by business id, so narrowing by
      // owner silently DROPPED it from every owner-scoped view: it was visible
      // in the Super Admin "everything" list and in nobody else's. Those rows
      // carry their own `ownerId`, which scopedTrail() already trusts for the
      // same records, so fall back to it — keeping the filter an INTERSECTION
      // with the caller's own scope, never a widening.
      // An explicit `businessIds` list is the caller naming specific units, so
      // it is honoured literally — matched on unit and nothing else. The
      // fallback below exists only to make an OWNER-wide view complete, and
      // applying it here would smuggle in records for units that were never
      // asked for, which is exactly the scope widening this filter exists to
      // prevent.
      if (fBusinessIds.length > 0) {
        records = records.filter((r) => r.businessId != null && narrowed!.has(Number(r.businessId)));
      } else {
        const ownerKept = (r: any) => {
          const bizId = r.businessId == null ? 0 : Number(r.businessId);
          if (bizId !== 0) {
            // A record that names a REAL unit is scoped by that unit, full
            // stop. If it is not in the narrowed set it belongs to a different
            // organization, and its own ownerId must never override that.
            if (bizOwnerById.has(bizId)) return narrowed!.has(bizId);
            // …but the unit it names no longer exists — the normal end-state
            // of a deletion trail, which outlives the unit by design. Fall back
            // to the tenant the trail itself was stamped with (the same
            // `owner_id` /api/enterprise already trusts for these rows).
            // Previously such a record appeared in the Super Admin's
            // "everything" list and in NO owner's, which is how the partition
            // could not be reconciled by anyone.
          }
          if (r.ownerId == null) return false;
          return orgScopeIds.has(Number(r.ownerId));
        };
        records = records.filter(ownerKept);
      }
      reviews = reviews.filter((r) => r.businessId != null && narrowed!.has(Number(r.businessId)));
      log = log.filter((t) => t.businessId == null || narrowed!.has(Number(t.businessId)));
    }

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
    recordsOut.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.at || "").localeCompare(a.at || "") || b.recordId - a.recordId);
    // ── Payload bound ──────────────────────────────────────────────────────
    // This used to be a hard `.slice(0, 250)` applied AFTER the scope filters,
    // which quietly broke the partition the Audit & Review screen depends on:
    // "every owner" returned fewer records than the sum of "my units" plus
    // "each other owner", so a Super Admin reviewing the whole platform could
    // silently miss rows. An audit surface that drops rows without saying so is
    // the wrong failure mode — it looks like compliance coverage it cannot prove.
    //
    // The bound is now (a) generous enough that a real portfolio fits, (b)
    // caller-adjustable, and (c) REPORTED, so a truncated response is visible
    // as such instead of masquerading as the complete set.
    const requestedLimit = Number(url.searchParams.get("limit") || "");
    const recordLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.trunc(requestedLimit), MAX_RECORDS)
      : DEFAULT_RECORDS;
    const totalRecords = recordsOut.length;
    recordsOut = recordsOut.slice(0, recordLimit);
    const truncated = totalRecords > recordsOut.length;

    let grants: any[] = [];
    let grantUsers: any[] = [];
    if (scope.canGrant) {
      const g = AUD["auditAssignments|all|id|"] ?? [];
      grants = scope.grantBusinessIds === null ? g : g.filter((x) => scope.grantBusinessIds!.includes(x.businessId));
      const all = AUD["users|all|id|"] ?? [];
      // Auditor candidates are strictly members of the caller's own
      // organization(s) — the platform Super Admin sees everyone.
      const orgsForCandidates = new Set(user.organizationIds?.length ? user.organizationIds : [-1]);
      const memberUserIds = user.isSuperAdmin
        ? null
        : new Set(
            (AUD["organizationMembers|all|none|"] ?? [])
              .filter((m: any) => orgsForCandidates.has(Number(m.organizationId)))
              .map((m: any) => Number(m.userId)),
          );
      grantUsers = all
        .filter((u) => u.role !== "OWNER" && u.isActive)
        .filter((u) => memberUserIds === null || memberUserIds.has(Number(u.id)))
        .filter((u) => scope.grantBusinessIds === null || ["GENERAL_MANAGER"].includes(u.role) || u.assignedBusinessId == null || scope.grantBusinessIds!.includes(u.assignedBusinessId))
        .map((u) => ({ id: u.id, name: u.name, role: u.role, email: u.email, assignedBusinessId: u.assignedBusinessId, canManageAuditors: !!u.canManageAuditors }));
    }

    // Businesses the caller may see (auditors can be granted businesses that
    // are NOT in their day-job scope, so send the names too).
    // `ownerId` travels with every row so the client can group units by Owner
    // without guessing; the owner's NAME is only published to a Super Admin
    // (a normal owner's units are all their own organization).
    const orgNames = new Map(
      (AUD["organizations|all|none|"] ?? []).map((o: any) => [Number(o.id), o.name]),
    );
    const bizAll = (AUD["businesses|all|none|"] ?? []).map((b: any) => ({ id: b.id, name: b.name, code: b.code, ownerId: b.ownerId }));
    let bizList = scope.businessIds === null ? bizAll : bizAll.filter((b) => scope.businessIds!.includes(b.id));
    if (narrowed) bizList = bizList.filter((b) => narrowed!.has(Number(b.id)));
    const publishOwnerNames = !!user.isSuperAdmin;
    const bizOut = bizList.map((b) => {
      const ownerId = Number(b.ownerId ?? 1);
      return {
        id: b.id,
        name: b.name,
        code: b.code,
        ownerId,
        // Owner names go ONLY to the platform Super Admin: a normal owner's
        // units all belong to their own organization, and an auditor granted a
        // unit elsewhere must not learn the other owner's name.
        ...(publishOwnerNames ? { ownerName: orgNames.get(ownerId) || `Owner #${ownerId}` } : {}),
      };
    });

    // Per-issue conversation threads for the issues in view (chronological).
    const issueIds = new Set(reviews.filter(isIssue).map((r) => r.id));
    const threads: Record<number, any[]> = {};
    if (issueIds.size > 0) {
      const upd = AUD["auditIssueUpdates|800|id|"] ?? [];
      for (const u of upd) {
        if (!issueIds.has(u.issueId)) continue;
        (threads[u.issueId] ||= []).push(u);
      }
      for (const k of Object.keys(threads)) threads[Number(k)].reverse();
    }

    const report = buildReport(records, reviews);
    return cachedJson(request, { success: true, scope: { eligible: true, level: scope.level, canGrant: scope.canGrant, businessIds: scope.businessIds, moduleByBusiness: scope.moduleByBusiness, branchByBusiness: scope.branchByBusiness, grantBusinessIds: scope.grantBusinessIds }, bizList: bizOut, records: recordsOut, totalRecords, truncated, reviews, threads, log, grants, grantUsers, report });
  } catch (error: any) {
    return apiError(error);
  }
}

/** Resolves the record the review targets DIRECTLY from the source table —
 *  business, branch, module, ref, title and worker are derived server-side so
 *  review records always stay linked to the real worker record. */
/** Operations-log source registry — shared by the summary resolver and the
 * full-record drawer so every module's daily logs (incl. the poultry feed
 * mill chain) open identically in the Audit & Review UI. */
const OP_LOG_SOURCES: Record<string, { table: any; ref: (r: any) => string; worker: (r: any) => string }> = {
  livestock_logs: { table: livestockLogs, ref: (r) => r.tagNumber, worker: (r) => r.receivedBy || "" },
  restaurant_logs: { table: restaurantLogs, ref: (r) => `SHIFT-${r.shiftDate}-${r.id}`, worker: (r) => r.receivedBy || "" },
  electronics_logs: { table: electronicsLogs, ref: (r) => r.serialNumber, worker: (r) => r.receivedBy || "" },
  car_wash_logs: { table: carWashLogs, ref: (r) => `SHIFT-${r.shiftDate}-${r.id}`, worker: (r) => r.receivedBy || "" },
  hardware_logs: { table: hardwareLogs, ref: (r) => r.receiveNoteNumber, worker: (r) => r.receivedBy || "" },
  poultry_feed_logs: { table: poultryFeedLogs, ref: (r) => `FDL-${r.id}`, worker: (r) => r.recordedByName || "" },
  poultry_production: { table: poultryProduction, ref: (r) => `PP-${r.id}`, worker: (r) => r.recordedByName || "" },
  poultry_health_records: { table: poultryHealthRecords, ref: (r) => `PHR-${r.id}`, worker: (r) => r.recordedByName || "" },
  poultry_feed_formulations: { table: poultryFeedFormulations, ref: (r) => r.formulationNo, worker: (r) => r.createdByName || "" },
  poultry_feed_batches: { table: poultryFeedBatches, ref: (r) => r.batchNumber, worker: (r) => r.recordedByName || r.operatorName || "" },
  poultry_feed_qc_checks: { table: poultryFeedQcChecks, ref: (r) => r.batchNumber || `QC-${r.id}`, worker: (r) => r.testerName || r.recordedByName || "" },
  fish_feed_formulations: { table: fishFeedFormulations, ref: (r) => r.formulationNo, worker: (r) => r.createdByName || "" },
  fish_feed_batches: { table: fishFeedBatches, ref: (r) => r.batchNumber, worker: (r) => r.recordedByName || r.operatorName || "" },
  fish_feed_qc_checks: { table: fishFeedQcChecks, ref: (r) => r.batchNumber || `QC-${r.id}`, worker: (r) => r.testerName || r.recordedByName || "" },
  block_mix_formulations: { table: blockMixFormulations, ref: (r) => r.formulationNo, worker: (r) => r.createdByName || "" },
  block_mix_batches: { table: blockMixBatches, ref: (r) => r.mixBatchNumber, worker: (r) => r.recordedByName || r.operatorName || "" },
};

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
      const meta = OP_LOG_SOURCES[recordSource || ""];
      if (!meta) return null;
      const r = await first(await db.select().from(meta.table).where(eq(meta.table.id, recordId)));
      if (!r) return null;
      const ref = meta.ref(r) || `${recordSource}-${r.id}`;
      return { businessId: r.businessId, branchCode: null, module: "OPERATIONS", ref, title: `Operations log ${ref}`, workerName: meta.worker(r) || null };
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
    // Transportation module records
    case "TRANSPORT_VEHICLE": {
      const r = await first(await db.select().from(transportVehicles).where(eq(transportVehicles.id, recordId)));
      return r && { businessId: r.businessId, branchCode: r.branchCode || null, module: "TRANSPORT", ref: `TRP-V${r.assetId || r.id} · ${r.licensePlate}`, title: `${r.name} (${r.licensePlate}) — ${r.vehicleType} · ${r.status}`, workerName: r.createdByName };
    }
    case "TRANSPORT_TRIP": {
      const r = await first(await db.select().from(transportTrips).where(eq(transportTrips.id, recordId)));
      return r && { businessId: r.businessId, branchCode: r.branchCode || null, module: "TRANSPORT", ref: `TRP-T${r.tripRef || r.id}`, title: `Trip ${r.source || "?"} → ${r.destination || "?"} — ${r.status}${r.actualKm ? ` · ${r.actualKm} km` : ""}`, workerName: r.driverName };
    }
    case "TRANSPORT_BOOKING": {
      const r = await first(await db.select().from(transportBookings).where(eq(transportBookings.id, recordId)));
      return r && { businessId: r.businessId, branchCode: r.branchCode || null, module: "TRANSPORT", ref: `BKG-${r.reference}`, title: `Booking ${r.reference} — ${r.customerName || "walk-in"} · GH₵ ${ghc(r.finalPriceGhs ?? r.quotedPriceGhs)} · ${r.status}`, workerName: r.createdByName };
    }
    case "TRANSPORT_MAINTENANCE": {
      const r = await first(await db.select().from(transportMaintenance).where(eq(transportMaintenance.id, recordId)));
      return r && { businessId: r.businessId, branchCode: r.branchCode || null, module: "TRANSPORT", ref: `MNT-${(r.dueDate || "").slice(0, 7).replaceAll("-", "") || "WK"}-${r.id}`, title: `${r.title} — ${r.category} · GH₵ ${ghc(r.actualCostGhs ?? r.estimatedCostGhs)} · ${r.status}`, workerName: r.createdByName };
    }
    case "TRANSPORT_VIOLATION": {
      const r = await first(await db.select().from(transportTrackerViolations).where(eq(transportTrackerViolations.id, recordId)));
      return r && { businessId: r.businessId, branchCode: r.branchCode || null, module: "TRANSPORT", ref: `VIO-${r.kind}-${r.id}`, title: `${r.vehiclePlate || "Vehicle"} — ${r.kind} · ${r.severity} · ${r.status}`, workerName: r.createdByName };
    }
    case "ADVISOR_NOTE": {
      // Farm Advisor notes are reviewable like every other record — the
      // audit trail rows they generate resolve back to the note itself.
      const r = await first(await db.select().from(advisorNotes).where(eq(advisorNotes.id, recordId)));
      if (!r) return null;
      return {
        businessId: r.businessId, branchCode: r.branchCode, module: "OPERATIONS",
        ref: `ADV-${r.id}`,
        title: `${r.title} — ${r.category} · ${r.priority} · follow-up ${r.followUpStatus}`,
        workerName: r.authorName,
      };
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
    // ── Transportation module records (detail drawer + related links) ─────
    case "TRANSPORT_VEHICLE": {
      const r = await first(await db.select().from(transportVehicles).where(eq(transportVehicles.id, recordId)));
      if (!r) return null;
      const rel: RelatedRow[] = [];
      const trips = await db.select().from(transportTrips).where(eq(transportTrips.vehicleId, recordId)).limit(10);
      for (const t of trips) rel.push({ key: `TRANSPORT_TRIP:transport_trips:${t.id}`, recordType: "TRANSPORT_TRIP", recordSource: "transport_trips", recordId: t.id, ref: `TRP-T${t.id}`, title: `Trip ${t.source || "?"} → ${t.destination || "?"} — ${t.status}`, detail: `${t.actualKm ?? t.expectedKm ?? "?"} km${t.startTs ? ` · ${tsDay(t.startTs)}` : ""}`, module: "TRANSPORT", businessId: t.businessId, branchCode: t.branchCode, date: tsDay(t.startTs), amountGhs: t.fareGhs, status: t.status, imageCount: 0 });
      if (r.assetId) {
        const a = await first(await db.select().from(assets).where(eq(assets.id, Number(r.assetId))));
        if (a) rel.push({ key: `ASSET:assets:${a.id}`, recordType: "ASSET", recordSource: "assets", recordId: a.id, ref: a.assetCode || `AST-${a.id}`, title: `${a.name} — ${a.assetType} · ${a.condition}`, detail: `value GH₵ ${ghc(a.currentValueGhs)} · ${a.location}`, module: "ASSETS", businessId: a.businessId, branchCode: branchOf(a.businessId, a.branchCode), date: tsDay(a.recordedAt), amountGhs: a.currentValueGhs, status: a.condition, imageCount: Array.isArray(a.assetImages) ? a.assetImages.length : 0 });
      }
      const viols = await db.select().from(transportTrackerViolations).where(eq(transportTrackerViolations.vehicleId, recordId)).limit(8);
      for (const v of viols) rel.push({ key: `TRANSPORT_VIOLATION:transport_tracker_violations:${v.id}`, recordType: "TRANSPORT_VIOLATION", recordSource: "transport_tracker_violations", recordId: v.id, ref: `VIO-${v.kind}-${v.id}`, title: `${v.kind} — ${v.severity}`, detail: v.detail || "", module: "TRANSPORT", businessId: v.businessId, branchCode: v.branchCode, date: tsDay(v.createdAt), amountGhs: null, status: v.status, imageCount: 0 });
      return { record: r, photos: photoList(r as any), related: related(rel) };
    }
    case "TRANSPORT_TRIP": {
      const r = await first(await db.select().from(transportTrips).where(eq(transportTrips.id, recordId)));
      if (!r) return null;
      const rel: RelatedRow[] = [];
      if (r.vehicleId) {
        const v = await first(await db.select().from(transportVehicles).where(eq(transportVehicles.id, Number(r.vehicleId))));
        if (v) rel.push({ key: `TRANSPORT_VEHICLE:transport_vehicles:${v.id}`, recordType: "TRANSPORT_VEHICLE", recordSource: "transport_vehicles", recordId: v.id, ref: `TRP-V${v.assetId || v.id} · ${v.licensePlate}`, title: `${v.name} (${v.licensePlate}) — ${v.vehicleType} · ${v.status}`, detail: `odo ${v.odometerKm} km`, module: "TRANSPORT", businessId: v.businessId, branchCode: v.branchCode, date: tsDay(v.createdAt), amountGhs: null, status: v.status, imageCount: 0 });
      }
      if (r.bookingId) {
        const b = await first(await db.select().from(transportBookings).where(eq(transportBookings.id, Number(r.bookingId))));
        if (b) rel.push({ key: `TRANSPORT_BOOKING:transport_bookings:${b.id}`, recordType: "TRANSPORT_BOOKING", recordSource: "transport_bookings", recordId: b.id, ref: `BKG-${b.id}`, title: `Booking — ${b.customerName} · GH₵ ${ghc(b.fareGhs)} · ${b.status}`, detail: `${b.origin || "?"} → ${b.destination || "?"}`, module: "TRANSPORT", businessId: b.businessId, branchCode: b.branchCode, date: tsDay(b.scheduledFor), amountGhs: b.fareGhs, status: b.status, imageCount: 0 });
      }
      if (r.customerId) {
        const c = await first(await db.select().from(customers).where(eq(customers.id, Number(r.customerId))));
        if (c) rel.push({ key: `CUSTOMER:customers:${c.id}`, recordType: "CUSTOMER", recordSource: "customers", recordId: c.id, ref: `CUS-${c.id}`, title: `${c.name} — ${c.type}`, detail: c.phone, module: "FINANCE", businessId: r.businessId, branchCode: branchOf(r.businessId, r.branchCode), date: tsDay(c.createdAt), amountGhs: c.totalSpentGhs, status: null, imageCount: 0 });
      }
      return { record: r, photos: [], related: related(rel) };
    }
    case "TRANSPORT_BOOKING": {
      const r = await first(await db.select().from(transportBookings).where(eq(transportBookings.id, recordId)));
      if (!r) return null;
      const rel: RelatedRow[] = [];
      if (r.customerId) {
        const c = await first(await db.select().from(customers).where(eq(customers.id, Number(r.customerId))));
        if (c) rel.push({ key: `CUSTOMER:customers:${c.id}`, recordType: "CUSTOMER", recordSource: "customers", recordId: c.id, ref: `CUS-${c.id}`, title: `${c.name} — ${c.type}`, detail: c.phone, module: "FINANCE", businessId: r.businessId, branchCode: branchOf(r.businessId, r.branchCode), date: tsDay(c.createdAt), amountGhs: c.totalSpentGhs, status: null, imageCount: 0 });
      }
      if (r.tripId) {
        const t = await first(await db.select().from(transportTrips).where(eq(transportTrips.id, Number(r.tripId))));
        if (t) rel.push({ key: `TRANSPORT_TRIP:transport_trips:${t.id}`, recordType: "TRANSPORT_TRIP", recordSource: "transport_trips", recordId: t.id, ref: `TRP-T${t.id}`, title: `Trip ${t.source || "?"} → ${t.destination || "?"} — ${t.status}`, detail: `${t.actualKm ?? t.expectedKm ?? "?"} km`, module: "TRANSPORT", businessId: t.businessId, branchCode: t.branchCode, date: tsDay(t.startTs), amountGhs: t.fareGhs, status: t.status, imageCount: 0 });
      }
      return { record: r, photos: [], related: related(rel) };
    }
    case "TRANSPORT_MAINTENANCE": {
      const r = await first(await db.select().from(transportMaintenance).where(eq(transportMaintenance.id, recordId)));
      if (!r) return null;
      const rel: RelatedRow[] = [];
      if (r.vehicleId) {
        const v = await first(await db.select().from(transportVehicles).where(eq(transportVehicles.id, Number(r.vehicleId))));
        if (v) rel.push({ key: `TRANSPORT_VEHICLE:transport_vehicles:${v.id}`, recordType: "TRANSPORT_VEHICLE", recordSource: "transport_vehicles", recordId: v.id, ref: `TRP-V${v.assetId || v.id} · ${v.licensePlate}`, title: `${v.name} (${v.licensePlate}) — ${v.vehicleType} · ${v.status}`, detail: `odo ${v.odometerKm} km`, module: "TRANSPORT", businessId: v.businessId, branchCode: v.branchCode, date: tsDay(v.createdAt), amountGhs: null, status: v.status, imageCount: 0 });
      }
      return { record: r, photos: [], related: related(rel) };
    }
    case "TRANSPORT_VIOLATION": {
      const r = await first(await db.select().from(transportTrackerViolations).where(eq(transportTrackerViolations.id, recordId)));
      if (!r) return null;
      const rel: RelatedRow[] = [];
      if (r.vehicleId) {
        const v = await first(await db.select().from(transportVehicles).where(eq(transportVehicles.id, Number(r.vehicleId))));
        if (v) rel.push({ key: `TRANSPORT_VEHICLE:transport_vehicles:${v.id}`, recordType: "TRANSPORT_VEHICLE", recordSource: "transport_vehicles", recordId: v.id, ref: `TRP-V${v.assetId || v.id} · ${v.licensePlate}`, title: `${v.name} (${v.licensePlate})`, detail: `odo ${v.odometerKm} km`, module: "TRANSPORT", businessId: v.businessId, branchCode: v.branchCode, date: tsDay(v.createdAt), amountGhs: null, status: v.status, imageCount: 0 });
      }
      return { record: r, photos: [], related: related(rel) };
    }
    case "OPERATION_LOG": {
      // Daily operations / production logs — incl. the poultry feed-mill
      // chain (formulations, batches, QC checks, feed logs) added under the
      // same registry as the summary resolver.
      const meta = OP_LOG_SOURCES[recordSource || ""];
      if (!meta) return null;
      const r = await first(await db.select().from(meta.table).where(eq(meta.table.id, recordId)));
      if (!r) return null;
      const rel: RelatedRow[] = [];
      // Feed-mill chain links: batch ← its QC checks; QC check → its batch.
      if (recordSource === "poultry_feed_batches") {
        const qcs = await db.select().from(poultryFeedQcChecks).where(eq(poultryFeedQcChecks.batchId, r.id)).limit(10);
        for (const x of qcs) rel.push({ key: `OPERATION_LOG:poultry_feed_qc_checks:${x.id}`, recordType: "OPERATION_LOG", recordSource: "poultry_feed_qc_checks", recordId: x.id, ref: x.batchNumber || `QC-${x.id}`, title: `QC — ${x.testName} → ${x.passFail}`, detail: `${x.stage} · ${x.testResult || "—"}`, module: "OPERATIONS", businessId: x.businessId, branchCode: null, date: tsDay(x.testedAt), amountGhs: null, status: x.passFail, imageCount: 0 });
      }
      if (recordSource === "poultry_feed_qc_checks" && r.batchId) {
        const b = await first(await db.select().from(poultryFeedBatches).where(eq(poultryFeedBatches.id, Number(r.batchId))));
        if (b) rel.push({ key: `OPERATION_LOG:poultry_feed_batches:${b.id}`, recordType: "OPERATION_LOG", recordSource: "poultry_feed_batches", recordId: b.id, ref: b.batchNumber, title: `${b.formulationName} — ${b.actualOutputKg} kg`, detail: `Status ${b.status}`, module: "OPERATIONS", businessId: b.businessId, branchCode: null, date: tsDay(b.createdAt), amountGhs: null, status: b.status, imageCount: 0 });
      }
      return { record: r, photos: (r as any).photo ? [String((r as any).photo)] : [], related: related(rel) };
    }
    case "CHECKLIST": {
      // Daily checklist entries are first-class auditable records (they are
      // what gets flagged most) — the drawer shows the complete entry and
      // links the assignee's other tasks from the same day for context.
      const r = await first(await db.select().from(checklistEntries).where(eq(checklistEntries.id, recordId)));
      if (!r) return null;
      const rel: RelatedRow[] = [];
      if (r.assignedToUserId != null || r.assignedToName) {
        const sameDay = r.assignedToUserId != null
          ? await db.select().from(checklistEntries).where(and(eq(checklistEntries.checklistDate, r.checklistDate), eq(checklistEntries.assignedToUserId, r.assignedToUserId), ne(checklistEntries.id, r.id))).limit(8)
          : await db.select().from(checklistEntries).where(and(eq(checklistEntries.checklistDate, r.checklistDate), eq(checklistEntries.assignedToName, r.assignedToName), ne(checklistEntries.id, r.id))).limit(8);
        for (const x of sameDay) rel.push({
          key: `CHECKLIST:checklist_entries:${x.id}`, recordType: "CHECKLIST", recordSource: "checklist_entries", recordId: x.id,
          ref: `CHK-${x.checklistDate}-${x.id}`, title: `${x.taskLabel} — ${x.checklistDate}${x.isCompleted ? "" : " · INCOMPLETE"}`,
          detail: `${x.category || "GENERAL"} · ${x.isCompleted ? `done by ${x.completedByName || "staff"}` : "pending completion"}`,
          module: "OPERATIONS", businessId: x.businessId, branchCode: branchOf(x.businessId, x.branchCode),
          date: day10(x.checklistDate), amountGhs: null, status: x.isCompleted ? "COMPLETED" : "PENDING", imageCount: 0,
        });
      }
      return { record: r, photos: [], related: related(rel) };
    }
    case "CCTV_CAMERA": {
      // Camera config is auditable (status/maintenance history) but device
      // credentials NEVER leave the server — password redacted and any
      // user:pass pair embedded in the stream URL masked, matching the GET
      // API's redaction rule.
      const r = await first(await db.select().from(cctvCameras).where(eq(cctvCameras.id, recordId)));
      if (!r) return null;
      const record: any = { ...r, password: "[redacted]" };
      if (typeof record.streamUrl === "string" && record.streamUrl) {
        record.streamUrl = record.streamUrl.replace(/(:\/\/[^:/@\s]+):([^@/\s]+)@/, "$1:[redacted]@");
      }
      return { record, photos: [], related: [] };
    }
    default:
      return null;
  }
}

/** Routes an issue to the right GoMina user: an explicit pick wins, then the
 *  record's own worker account (checklists), then the active user whose name
 *  matches the record's worker — preferring someone assigned to that business. */
async function resolveAssignee(rec: any, explicitUserId: number | null) {
  // Tenant guard: an issue may only ever be routed to a member of the
  // record's own organization — never a same-named user in another Owner's
  // organization (explicit, linked, or fuzzy name path alike).
  const orgId = rec.businessId != null ? await ownerOrgOfBusiness(Number(rec.businessId)) : null;
  let memberIds: Set<number> | null = null;
  if (orgId != null) {
    const ms = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, Number(orgId)));
    memberIds = new Set(ms.map((m) => Number(m.userId)));
  }
  const inOrg = (u: any) => memberIds == null || memberIds.has(Number(u.id));
  if (explicitUserId) {
    const [u] = await db.select().from(users).where(eq(users.id, explicitUserId));
    if (u && u.isActive && inOrg(u)) return u;
  }
  if (rec.workerUserId) {
    const [u] = await db.select().from(users).where(eq(users.id, Number(rec.workerUserId)));
    if (u && u.isActive && inOrg(u)) return u;
  }
  if (rec.workerName) {
    const all = await db.select().from(users);
    const matches = all.filter((u) => u.isActive && inOrg(u) && (u.name || "").toLowerCase() === String(rec.workerName).toLowerCase());
    if (matches.length > 0) return matches.find((u) => u.assignedBusinessId === rec.businessId) || matches[0];
  }
  return null;
}
const cFriendly = (c: any) => `${c.cameraType} @ ${c.location}`;

async function writeTrail(actor: any, entry: { action: string; targetType: string; targetLabel: string; recordType?: string | null; recordId?: number | null; businessId?: number | null; branchCode?: string | null; reason?: string | null; detail?: string | null }) {
  const tOwnerId = entry.businessId != null ? await ownerOrgOfBusiness(Number(entry.businessId)) : (actor.orgId ?? null);
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
    ownerId: tOwnerId,
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
      // Auditor assignments can never cross an organization boundary.
      if (!user.isSuperAdmin && !(await sharesOrganization(user, target))) {
        return FORBIDDEN("You can only grant Auditor access to users inside your own organization.");
      }
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
    const photoCheck = validateOptionalImage(body.evidencePhoto, "evidence", { label: "Evidence photo" });
    if (!photoCheck.ok) return NextResponse.json({ success: false, error: photoCheck.error }, { status: 400 });
    const photo = String(body.evidencePhoto || "");
    // Route the issue to the user responsible for the record (their dashboard).
    const assignee = ISSUE_ACTIONS.includes(action) ? await resolveAssignee(rec, Number(body.assignedUserId) || null) : null;
    const priority = normPriority(body.priority);
    // Optional corrective-action deadline (P1): feeds the Action Center's
    // due/overdue view and the daily SLA escalation sweep.
    const rawDue = String(body.dueDate || "").trim();
    const dueDate = ISSUE_ACTIONS.includes(action) && /^\d{4}-\d{2}-\d{2}$/.test(rawDue) ? rawDue : null;
    const [review] = await db.insert(auditReviews).values({
      recordType, recordSource: body.recordSource ? String(body.recordSource) : null, recordId,
      recordRef: rec.ref, recordTitle: rec.title, module: rec.module,
      businessId: rec.businessId, branchCode: rec.branchCode, workerName: rec.workerName,
      action, status, reason: reason || null, comment: comment || null, evidence: evidence || null,
      priority,
      issueTitle: ISSUE_ACTIONS.includes(action) ? issueTitle : null,
      evidencePhoto: photo || null,
      dueDate,
      assignedUserId: assignee?.id ?? null, assignedUserName: assignee?.name ?? null, assignedUserRole: assignee?.role ?? null,
      reviewerUserId: user.id, reviewerName: user.name, reviewerRole: user.role,
    }).returning();
    await writeTrail(user, { action: REVIEW_TO_TRAIL[action], targetType: "RECORD", targetLabel: rec.ref || rec.title, recordType, recordId, businessId: rec.businessId, branchCode: rec.branchCode, reason: reason || null, detail: `${comment || evidence || ""} [priority ${priority}]`.trim() });
    if (ISSUE_ACTIONS.includes(action)) {
      await db.insert(auditIssueUpdates).values({
        issueId: review.id, actorUserId: user.id, actorName: user.name, actorRole: user.role,
        action: REVIEW_TO_TRAIL[action], statusFrom: null, statusTo: status,
        note: reason || comment || null, evidence: evidence || null, photo: photo || null,
      });
      const { businessName, branchLabel } = await bizLabels(rec.businessId, rec.branchCode);
      const reasonLine = `${reason || ""}${comment ? ` — ${comment}` : ""}`;
      const whereLine = `Flagged by ${user.name} (${user.role}) · Business: ${businessName} · Branch: ${branchLabel} · Record: ${rec.ref}`;
      if (assignee) {
        await notify(assignee.id, {
          type: action === "CORRECTION_REQUESTED" ? "AUDIT_CORRECTION_REQUIRED" : "AUDIT_ISSUE_ASSIGNED",
          title: `${action === "CORRECTION_REQUESTED" ? "Correction required" : "Issue flagged"} [${PRIORITY_LABEL[priority]}]: ${issueTitle || rec.ref}`,
          body: `${reasonLine}\n${whereLine}${dueDate ? `\nCorrective action due: ${dueDate}.` : ""}\nRequired action: open My Audit Issues, respond with your fix/evidence, then mark it resolved.`,
          issueId: review.id, recordType, recordId, recordRef: rec.ref,
          businessId: rec.businessId, branchCode: rec.branchCode, actorName: user.name, priority,
        });
      }
      // Escalation watch: responsible managers always see flagged issues in
      // their businesses; the org OWNER is pulled in on HIGH/CRITICAL — and
      // always when the issue could not be assigned to a user account.
      const watchers = await auditEscalationRecipients(rec.businessId, priority, {
        unassigned: !assignee,
        excludeIds: [user.id, assignee?.id ?? null],
      });
      for (const w of watchers) {
        await notify(w.id, {
          type: "AUDIT_ISSUE_WATCH",
          title: `${action === "CORRECTION_REQUESTED" ? "Correction watch" : "Issue watch"} [${PRIORITY_LABEL[priority]}]: ${issueTitle || rec.ref}`,
          body: `${reasonLine}\n${whereLine}\n${assignee ? `Assigned to ${assignee.name} — you are notified as ${w.role === "OWNER" ? "the organization Owner" : "a responsible manager"}.` : "No user account is linked to this record — review and route it from the Audit Command Center."}`,
          issueId: review.id, recordType, recordId, recordRef: rec.ref,
          businessId: rec.businessId, branchCode: rec.branchCode, actorName: user.name, priority,
        });
      }
    }
    return NextResponse.json({ success: true, review, assignedTo: assignee ? { id: assignee.id, name: assignee.name, role: assignee.role } : null });
  } catch (error: any) {
    return apiError(error);
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
      await autoReadIssue(row.id); // closing the issue retires every earlier bell item for it
      const [updated] = await db.update(auditReviews)
        .set({ status: "VERIFIED", resolvedByUserId: user.id, resolvedByName: user.name, resolvedAt: new Date(), resolutionNote: note })
        .where(eq(auditReviews.id, row.id)).returning();
      await db.insert(auditIssueUpdates).values({
        issueId: row.id, actorUserId: user.id, actorName: user.name, actorRole: user.role,
        action: "VERIFY", statusFrom: from, statusTo: "VERIFIED", note,
      });
      await writeTrail(user, { action: "VERIFY", targetType: "RECORD", targetLabel: row.recordRef || row.recordTitle, recordType: row.recordType, recordId: row.recordId, businessId: row.businessId, branchCode: row.branchCode, reason: row.reason, detail: `Verified & closed (${from} → VERIFIED): ${note}` });
      try {
        const { completeLinkedTasksForSource } = await import("@/lib/actionCenter");
        await completeLinkedTasksForSource("AUDIT_ISSUE", row.id, user.name, note);
      } catch {}
      if (row.assignedUserId && row.assignedUserId !== user.id) {
        await notify(row.assignedUserId, {
          type: "AUDIT_ISSUE_VERIFIED", title: `Verified & closed [${PRIORITY_LABEL[normPriority(row.priority)]}]: ${row.issueTitle || row.recordRef}`,
          body: note, issueId: row.id, recordType: row.recordType, recordId: row.recordId,
          recordRef: row.recordRef, businessId: row.businessId, branchCode: row.branchCode, actorName: user.name, priority: normPriority(row.priority),
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
      const photoCheck = validateOptionalImage(body.evidencePhoto, "evidence", { label: "Photo" });
      if (!photoCheck.ok) return NextResponse.json({ success: false, error: photoCheck.error }, { status: 400 });
      const photo = String(body.evidencePhoto || "");
      const [updated] = await db.update(auditReviews)
        .set({ status: "CORRECTION_REQUIRED" })
        .where(eq(auditReviews.id, row.id)).returning();
      await autoReadIssue(row.id); // the fresh correction-required notice below replaces everything prior
      await db.insert(auditIssueUpdates).values({
        issueId: row.id, actorUserId: user.id, actorName: user.name, actorRole: user.role,
        action: "REQUEST_CORRECTION", statusFrom: from, statusTo: "CORRECTION_REQUIRED", note, photo: photo || null,
      });
      await writeTrail(user, { action: "REQUEST_CORRECTION", targetType: "RECORD", targetLabel: row.recordRef || row.recordTitle, recordType: row.recordType, recordId: row.recordId, businessId: row.businessId, branchCode: row.branchCode, reason: row.reason, detail: `${from} → CORRECTION_REQUIRED: ${note}` });
      if (row.assignedUserId && row.assignedUserId !== user.id) {
        await notify(row.assignedUserId, {
          type: "AUDIT_CORRECTION_REQUIRED", title: `Correction required [${PRIORITY_LABEL[normPriority(row.priority)]}]: ${row.issueTitle || row.recordRef}`,
          body: `${note}\nRequired action: fix the issue, respond with what you did, then mark it resolved in My Audit Issues.`,
          issueId: row.id, recordType: row.recordType, recordId: row.recordId,
          recordRef: row.recordRef, businessId: row.businessId, branchCode: row.branchCode, actorName: user.name, priority: normPriority(row.priority),
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
    return apiError(error);
  }
}
