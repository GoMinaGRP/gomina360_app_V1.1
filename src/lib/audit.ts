import { db } from "@/db";
import { auditTrail } from "@/db/schema";

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
  try {
    await db.insert(auditTrail).values({
      actorUserId: Number(actor.id) || 0,
      actorName: actor.name || "Staff",
      actorRole: actor.role || "WORKER",
      action,
      targetType,
      targetLabel,
      recordType,
      recordId,
      businessId,
      branchCode,
      reason: null,
      detail,
      ownerId,
    });
  } catch (e) {
    console.error("auditLog warning:", e);
  }
}
