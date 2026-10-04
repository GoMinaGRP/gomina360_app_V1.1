/**
 * Shared CRM customer linking — the ONE find-or-create implementation.
 *
 * Every sale/order path in the system (Sales Center, credit sales, car wash,
 * telecom, transport, module order fulfilment) used to carry its own copy of
 * "match the buyer, then accrue spend + loyalty". The copies had drifted
 * (different match rules, different loyalty rates, different phone fallbacks),
 * which is exactly how one customer ends up duplicated across modules.
 *
 * This module keeps every path on one rule while preserving each caller's
 * documented behaviour through options:
 *   • matching is business-isolated — a unit only ever matches its own rows
 *     (plus, when `includeLegacyShared` is set, the historical rows with a null
 *     businessId written before CRM isolation existed);
 *   • `loyaltyPoints` lets a caller keep its own award rate
 *     (Sales Center: ⌊total/100⌋; service modules: 1 per job);
 *   • `phoneFallback` keeps the stored placeholder callers already used
 *     ("—" for service modules, "" where the column is NOT NULL and the sale
 *     simply had no number).
 *
 * Never throws: a CRM hiccup must not break the sale — it degrades to
 * `null` and logs, exactly like the previous inline implementations.
 */
import { db } from "@/db";
import { customers } from "@/db/schema";
import { eq } from "drizzle-orm";

export interface LinkCustomerOptions {
  businessId: number;
  name?: string | null;
  phone?: string | null;
  /** Amount to accrue onto totalSpentGhs. Default 0. */
  amount?: number;
  /** Loyalty points to add. Default ⌊amount/100⌋ (the Sales Center rule). */
  loyaltyPoints?: number;
  /** Stored when the customer has no phone. Default "—" (service modules). */
  phoneFallback?: string;
  /** Also match pre-isolation rows with a null businessId. */
  includeLegacyShared?: boolean;
  /** Tenant owner (organizations.id) stamped on newly created rows. */
  ownerId?: number | null;
  /** CRM client type for new rows. Default "RETAIL". */
  type?: string;
  /** Skip creation and only match an existing buyer. Default false. */
  matchOnly?: boolean;
  /**
   * Accrue straight onto this already-linked CRM customer (module orders link
   * the buyer when the order is created, then post the sale later — the spend
   * must land on that same record, not create a second one).
   */
  byId?: number | null;
}

export interface LinkedCustomer {
  id: number;
  created: boolean;
  row: any;
}

const norm = (s: any) => String(s || "").trim().toLowerCase();
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Placeholder names that must never become CRM records. */
const ANONYMOUS = new Set(["", "walk-in", "walk-in customer", "walk-in guest", "customer", "guest", "n/a", "-"]);

export function isAnonymousBuyer(name?: string | null): boolean {
  return ANONYMOUS.has(norm(name));
}

export async function linkOrCreateCustomer(opts: LinkCustomerOptions): Promise<LinkedCustomer | null> {
  const businessId = Number(opts.businessId);
  const name = String(opts.name || "").trim();
  const phone = String(opts.phone || "").trim();
  const amount = Math.max(0, Number(opts.amount) || 0);
  const loyalty = opts.loyaltyPoints === undefined ? Math.floor(amount / 100) : Math.floor(opts.loyaltyPoints);
  try {
    if (!businessId) return null;
    if (opts.byId != null) {
      const [row] = await db.select().from(customers).where(eq(customers.id, Number(opts.byId)));
      // Never leak across tenants: the linked row must belong to this business.
      if (!row || (row.businessId != null && Number(row.businessId) !== businessId)) return null;
      const [updated] = await db
        .update(customers)
        .set({
          totalSpentGhs: r2((row.totalSpentGhs || 0) + amount),
          loyaltyPoints: (row.loyaltyPoints || 0) + loyalty,
          phone: row.phone || phone || opts.phoneFallback || undefined,
        })
        .where(eq(customers.id, row.id))
        .returning();
      return { id: row.id, created: false, row: updated || row };
    }
    // Business-isolated scan (plus the legacy shared rows when asked).
    const rows = await db.select().from(customers).where(eq(customers.businessId, businessId));
    let legacy: any[] = [];
    if (opts.includeLegacyShared) {
      const all = await db.select().from(customers);
      legacy = all.filter((c: any) => c.businessId === null);
    }
    const pool = [...rows, ...legacy];
    const match =
      (phone && pool.find((c) => norm(c.phone) === norm(phone))) ||
      (name && !isAnonymousBuyer(name) && pool.find((c) => norm(c.name) === norm(name))) ||
      null;

    if (match) {
      const [updated] = await db
        .update(customers)
        .set({
          totalSpentGhs: r2((match.totalSpentGhs || 0) + amount),
          loyaltyPoints: (match.loyaltyPoints || 0) + loyalty,
          phone: match.phone || phone || opts.phoneFallback || undefined,
        })
        .where(eq(customers.id, match.id))
        .returning();
      return { id: match.id, created: false, row: updated || match };
    }

    if (opts.matchOnly) return null;
    if (isAnonymousBuyer(name) && !phone) return null;

    const [created] = await db
      .insert(customers)
      .values({
        name: name || phone,
        type: opts.type || "RETAIL",
        phone: phone || opts.phoneFallback || "",
        totalSpentGhs: amount,
        loyaltyPoints: loyalty,
        businessId,
        ...(opts.ownerId != null ? { ownerId: Number(opts.ownerId) } : {}),
      })
      .returning();
    return created ? { id: created.id, created: true, row: created } : null;
  } catch (e) {
    console.error("[customer-link] failed:", e);
    return null;
  }
}
