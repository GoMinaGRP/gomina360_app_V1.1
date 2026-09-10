import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { managesBusiness } from "./permissions";

/**
 * Shared-record access control for Transactions & MoMo, Suppliers & Vendors
 * and Employees & Payroll.
 *
 * Rules:
 *  • The OWNER can ALWAYS add, edit and delete records.
 *  • Any other user (GENERAL_MANAGER / BRANCH_MANAGER / …) may only manage or
 *    delete when the OWNER has granted the `canManageRecords` flag on their
 *    account.
 *
 * The actor is ALWAYS resolved from the database by id — client-supplied role
 * or permission flags are never trusted.
 */
export async function resolveRecordActor(actorUserId: number | null | undefined) {
  const id = Number(actorUserId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user || null;
}

export function canManageSharedRecords(user: any): boolean {
  if (!user) return false;
  return user.role === "OWNER" || user.canManageRecords === true;
}

/**
 * Inventory & Stock deletion gate. The OWNER can ALWAYS manage, edit and
 * delete inventory entries; every other user only while the OWNER has granted
 * the `canDeleteInventory` flag on their account. The flag is resolved from
 * the database-loaded user row — client-supplied role/permission values are
 * never trusted.
 */
export function canDeleteInventory(user: any): boolean {
  if (!user) return false;
  return user.role === "OWNER" || user.canDeleteInventory === true;
}

/**
 * Expense deletion/edit gate. Expenses are `transactions` rows with
 * `type === "EXPENSE"`. The OWNER can ALWAYS edit and delete expenses; every
 * other user only while the OWNER has granted the `canManageExpenses` flag on
 * their account. The flag is resolved from the database-loaded user row —
 * client-supplied role/permission values are never trusted.
 */
export function canManageExpenses(user: any): boolean {
  if (!user) return false;
  return user.role === "OWNER" || user.canManageExpenses === true;
}

/**
 * OWNER-delegated "Manage Business / Unit" power: the user acts with
 * owner-equivalent authority — but ONLY for the business/unit the OWNER
 * granted (`users.businessManageIds`). The OWNER implicitly manages all.
 * Every other unit stays out of reach.
 */
export function canManageBusinessUnit(user: any, businessId?: number | null): boolean {
  if (!user) return false;
  return managesBusiness(user, businessId ?? null);
}

/**
 * DB-resolved OWNER gate. Server routes that mutate enterprise structure
 * (business units) call this with a client-supplied user id; the database —
 * never the request body — decides whether the caller is really the OWNER.
 * Returns the OWNER user row, or null.
 */
export async function resolveOwnerActor(actorUserId: number | null | undefined) {
  const user = await resolveRecordActor(actorUserId);
  if (!user || user.role !== "OWNER") return null;
  return user;
}
