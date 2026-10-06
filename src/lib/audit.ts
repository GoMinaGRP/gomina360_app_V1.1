import { db } from "@/db";
import { auditTrail } from "@/db/schema";

export interface AuditEventRow {
  actorUserId?: number;
  actorName?: string;
  actorRole?: string;
  action: string;
  targetType: string;
  targetLabel: string;
  recordType?: string | null;
  recordId?: number | null;
  businessId?: number | null;
  branchCode?: string | null;
  reason?: string | null;
  detail?: string | null;
  ownerId?: number | null;
}

/**
 * THE audit-event writer: appends the immutable trail row and, for the
 * high-signal actions (deletions, permission/credential changes, edits to
 * money records), rings the OWNER's bell through notifyActivity's allow-list.
 *
 * Routes that write the trail directly should call this instead of
 * `db.insert(auditTrail)` so no event class can silently go un-notified.
 * Never throws.
 */
export async function auditEvent(row: AuditEventRow): Promise<void> {
  try {
    await db.insert(auditTrail).values({
      actorUserId: Number(row.actorUserId) || 0,
      actorName: row.actorName || "Staff",
      actorRole: row.actorRole || "WORKER",
      action: row.action,
      targetType: row.targetType,
      targetLabel: row.targetLabel,
      recordType: row.recordType ?? null,
      recordId: row.recordId ?? null,
      businessId: row.businessId ?? null,
      branchCode: row.branchCode ?? null,
      reason: row.reason ?? null,
      detail: row.detail ?? null,
      ownerId: row.ownerId ?? null,
    });

    const { notifyAuditEvent } = await import("@/lib/notifyActivity");
    await notifyAuditEvent({
      actorName: row.actorName ?? null,
      actorUserId: row.actorUserId ?? null,
      action: row.action,
      targetType: row.targetType,
      targetLabel: row.targetLabel,
      recordType: row.recordType ?? null,
      recordId: row.recordId ?? null,
      businessId: row.businessId ?? null,
      branchCode: row.branchCode ?? null,
      detail: row.detail ?? null,
      ownerId: row.ownerId ?? null,
    });
  } catch (e) {
    console.error("auditEvent warning:", e);
  }
}

/** Append a row to the shared audit trail (never throws). */
export async function auditLog(
  actor: { id?: number; name?: string; role?: string },
  action: string,
  targetType: string,
  targetLabel: string,
  recordType: string | null,
  recordId: number | null,
  businessId: number | null,
  branchCode: string | null,
  detail: string | null,
  ownerId: number | null,
): Promise<void> {
  await auditEvent({
    actorUserId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    action,
    targetType,
    targetLabel,
    recordType,
    recordId,
    businessId,
    branchCode,
    detail,
    ownerId,
  });
}
