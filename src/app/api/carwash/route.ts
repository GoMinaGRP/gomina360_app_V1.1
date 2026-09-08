import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  carWashServices,
  carWashBookings,
  carWashWashes,
  carWashActivities,
  inventoryItems,
  transactions,
  businesses,
  customers,
} from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { computeStockStatus } from "@/lib/stock";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

/**
 * Auto Car Wash module API.
 *
 * Linkage contract (same "exactly once" discipline as the other modules):
 *   • WASH started            → work-queue entry (booking, if any, flips to CHECKED_IN)
 *   • WASH completed          → INCOME transaction (Sale/Payment) + chemical
 *                               stock OUT from the service's linked drum +
 *                               customer record upsert (spend + loyalty) +
 *                               linked booking flips to COMPLETED
 *   • SERVICE saved           → service catalogue (priced offers, with
 *                               consumable supply + included items shown)
 *   • EXPENSE logged          → EXPENSE transaction feeding Profit & Reports
 *   • Everything              → writes a car_wash_activities row (audit feed)
 *
 * All endpoints require a valid session (same access control as every other
 * module route). The OWNER manages who can sign in to the unit via the
 * standard user/access tooling — nothing here bypasses that.
 */

const SERVICE_CATEGORIES = [
  "WASH_PACKAGE",
  "DETAILING",
  "WAXING",
  "POLISHING",
  "INTERIOR_CLEANING",
  "EXTERIOR_CLEANING",
  "CUSTOM",
];

async function logActivity(
  businessId: number,
  branchCode: string | null,
  action: string,
  detail: string,
  actorName?: string | null,
  actorRole?: string | null,
  refNumber?: string | null
) {
  await db
    .insert(carWashActivities)
    .values({
      businessId,
      branchCode,
      action,
      detail,
      actorName: actorName || null,
      actorRole: actorRole || null,
      refNumber: refNumber || null,
    })
    .catch((e) => console.error("wash activity warning:", e));
}

async function bookTransaction(
  biz: { id: number; code: string | null; name: string | null },
  type: "INCOME" | "EXPENSE",
  amount: number,
  category: string,
  description: string,
  paymentMethod: string,
  actorName?: string | null,
  actorRole?: string | null,
  actorUserId?: number | null
) {
  const now = new Date();
  await db.insert(transactions).values({
    transactionNumber: `TRX-${now.getFullYear()}-${now.getTime().toString().slice(-6)}`,
    businessId: biz.id,
    branchCode: biz.code,
    branchName: biz.name,
    type,
    category,
    amountGhs: amount,
    paymentMethod: paymentMethod || "CASH",
    description,
    date: now.toISOString().split("T")[0],
    createdAt: now,
    status: "COMPLETED",
    recordedBy: actorName || "Auto Wash",
    recordedByRole: actorRole || null,
    recordedByUserId: actorUserId ? Number(actorUserId) : null,
  });
}

/**
 * Draw `liters` of chemical from a stock item. The drum-style items used by
 * wash branches are sold per drum but consumed per liter — the liters each
 * unit holds come from the item name ("…(50L)") with a 50L fallback.
 */
async function stockOutLiters(inventoryId: number, liters: number) {
  const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, inventoryId));
  if (!inv || liters <= 0) return;
  const m = /\((\d+(?:\.\d+)?)\s*L\)/i.exec(inv.name || "");
  const litersPerUnit = m ? Number(m[1]) : 50;
  const qty = liters / litersPerUnit;
  const newQty = Math.max(0, Number(((inv.quantity || 0) - qty).toFixed(4)));
  await db
    .update(inventoryItems)
    .set({ quantity: newQty, status: computeStockStatus(newQty, inv.minStockThreshold || 0) })
    .where(eq(inventoryItems.id, inv.id));
}

/** Find-or-create a branch customer and accrue spend + loyalty from a job. */
async function upsertWashCustomer(
  biz: { id: number; code: string | null },
  name: string,
  phone: string | null,
  amount: number
) {
  const existing = await db.select().from(customers).where(eq(customers.businessId, biz.id));
  const match =
    existing.find((c) => phone && c.phone === phone) ||
    existing.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (match) {
    await db
      .update(customers)
      .set({
        totalSpentGhs: Math.round(((match.totalSpentGhs || 0) + amount) * 100) / 100,
        loyaltyPoints: (match.loyaltyPoints || 0) + 1,
        phone: match.phone || phone || "—",
      })
      .where(eq(customers.id, match.id));
    return match.id;
  }
  const [created] = await db
    .insert(customers)
    .values({
      name,
      type: "RETAIL",
      phone: phone || "—",
      totalSpentGhs: Math.max(0, Math.round(amount * 100) / 100),
      loyaltyPoints: 1,
      businessId: biz.id,
    })
    .returning();
  return created?.id ?? null;
}

export async function GET(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const businessId = Number(searchParams.get("businessId"));
    if (!businessId) {
      return NextResponse.json({ success: false, error: "businessId required" }, { status: 400 });
    }
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    if (!biz) return NextResponse.json({ success: false, error: "Business not found" }, { status: 404 });

    const [services, bookings, washes, branches] = await Promise.all([
      db.select().from(carWashServices).where(eq(carWashServices.businessId, businessId)).orderBy(desc(carWashServices.id)),
      db.select().from(carWashBookings).where(eq(carWashBookings.businessId, businessId)).orderBy(desc(carWashBookings.id)),
      db.select().from(carWashWashes).where(eq(carWashWashes.businessId, businessId)).orderBy(desc(carWashWashes.id)),
      Promise.resolve(null),
    ]);
    const acts = await db
      .select()
      .from(carWashActivities)
      .where(eq(carWashActivities.businessId, businessId))
      .orderBy(desc(carWashActivities.id))
      .limit(150);

    return NextResponse.json({ success: true, services, bookings, washes, activities: acts, branches });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { entity, data } = body;
    if (!entity || !data?.businessId) {
      return NextResponse.json({ success: false, error: "entity and businessId required" }, { status: 400 });
    }
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, Number(data.businessId)));
    if (!biz) return NextResponse.json({ success: false, error: "Business not found" }, { status: 404 });

    const today = new Date().toISOString().split("T")[0];
    const stamp = Date.now().toString().slice(-5);
    const actor = { a: data.createdByName || null, r: data.createdByRole || null };

    // ── SERVICE: create a priced wash offer ─────────────────────────────
    if (entity === "SERVICE") {
      if (!data.name || Number(data.priceGhs) <= 0) {
        return NextResponse.json({ success: false, error: "Service name and a price are required" }, { status: 400 });
      }
      const [row] = await db
        .insert(carWashServices)
        .values({
          businessId: biz.id,
          branchCode: biz.code,
          name: String(data.name),
          category: SERVICE_CATEGORIES.includes(data.category) ? data.category : "CUSTOM",
          description: data.description || null,
          priceGhs: Number(data.priceGhs),
          durationMinutes: Number(data.durationMinutes) || 45,
          includesItems: data.includesItems || null,
          supplyInventoryId: data.supplyInventoryId ? Number(data.supplyInventoryId) : null,
          supplyUsageLiters: Number(data.supplyUsageLiters) || 0,
          active: data.active !== false,
        })
        .returning();
      await logActivity(biz.id, biz.code, "SERVICE_CREATED", `New service added to the menu: ${row.name} (${row.category}) at GH₵${row.priceGhs}`, actor.a, actor.r, null);
      return NextResponse.json({ success: true, item: row });
    }

    // ── BOOKING: schedule a future wash ─────────────────────────────────
    if (entity === "BOOKING") {
      if (!data.customerName || !data.serviceId) {
        return NextResponse.json({ success: false, error: "Customer and service are required" }, { status: 400 });
      }
      const [svc] = await db.select().from(carWashServices).where(eq(carWashServices.id, Number(data.serviceId)));
      if (!svc || svc.businessId !== biz.id) {
        return NextResponse.json({ success: false, error: "Service not found for this branch" }, { status: 400 });
      }
      const [row] = await db
        .insert(carWashBookings)
        .values({
          businessId: biz.id,
          branchCode: biz.code,
          bookingNumber: `BK-WASH-${new Date().getFullYear()}-${stamp}`,
          customerName: String(data.customerName),
          customerPhone: data.customerPhone || null,
          vehicleLabel: data.vehicleLabel || null,
          serviceId: svc.id,
          serviceName: svc.name,
          bookingDate: data.bookingDate || today,
          timeSlot: data.timeSlot || null,
          assignedStaffName: data.assignedStaffName || null,
          status: "BOOKED",
          priceGhs: Number(data.priceGhs ?? svc.priceGhs) || 0,
          notes: data.notes || null,
          createdByName: actor.a,
          createdByRole: actor.r,
        })
        .returning();
      await logActivity(biz.id, biz.code, "BOOKING_CREATED", `Booking ${row.bookingNumber}: ${row.customerName} — ${row.serviceName} on ${row.bookingDate}${row.timeSlot ? " at " + row.timeSlot : ""}${row.vehicleLabel ? ` (${row.vehicleLabel})` : ""}`, actor.a, actor.r, row.bookingNumber);
      return NextResponse.json({ success: true, item: row });
    }

    // ── WASH: start a job (drive-in, or checking in a BOOKED booking) ───
    if (entity === "WASH") {
      let booking: any = null;
      if (data.bookingId) {
        const [b] = await db.select().from(carWashBookings).where(eq(carWashBookings.id, Number(data.bookingId)));
        if (!b || b.businessId !== biz.id) {
          return NextResponse.json({ success: false, error: "Booking not found for this branch" }, { status: 400 });
        }
        if (b.status !== "BOOKED") {
          return NextResponse.json({ success: false, error: `Booking is ${b.status} — only BOOKED bookings can be checked in` }, { status: 400 });
        }
        booking = b;
      }
      const svcId = Number(data.serviceId ?? booking?.serviceId);
      const [svc] = svcId ? await db.select().from(carWashServices).where(eq(carWashServices.id, svcId)) : [null];
      if (!svc || svc.businessId !== biz.id) {
        return NextResponse.json({ success: false, error: "Service not found for this branch" }, { status: 400 });
      }
      const customerName = String(data.customerName ?? booking?.customerName ?? "").trim();
      const vehicleLabel = String(data.vehicleLabel ?? booking?.vehicleLabel ?? "").trim();
      if (!customerName || !vehicleLabel) {
        return NextResponse.json({ success: false, error: "Customer and vehicle are required" }, { status: 400 });
      }
      const [row] = await db
        .insert(carWashWashes)
        .values({
          businessId: biz.id,
          branchCode: biz.code,
          washNumber: `WSH-${new Date().getFullYear()}-${stamp}`,
          bookingId: booking?.id ?? null,
          customerName,
          customerPhone: data.customerPhone ?? booking?.customerPhone ?? null,
          vehicleLabel,
          serviceId: svc.id,
          serviceName: svc.name,
          staffId: data.staffId ? Number(data.staffId) : null,
          staffName: data.staffName || booking?.assignedStaffName || null,
          status: "IN_PROGRESS",
          priceGhs: Number(data.priceGhs ?? booking?.priceGhs ?? svc.priceGhs) || 0,
          startedAt: today,
          notes: data.notes || null,
          createdByName: actor.a,
          createdByRole: actor.r,
        })
        .returning();
      if (booking) {
        await db
          .update(carWashBookings)
          .set({ status: "CHECKED_IN", checkedInAt: today })
          .where(eq(carWashBookings.id, booking.id));
      }
      await logActivity(
        biz.id,
        biz.code,
        booking ? "CHECK_IN" : "WASH_STARTED",
        `${booking ? `Booking ${booking.bookingNumber} checked in` : `Drive-in job ${row.washNumber} started`}: ${vehicleLabel} — ${svc.name} for ${customerName}${row.staffName ? ` (staff: ${row.staffName})` : ""}`,
        actor.a,
        actor.r,
        row.washNumber
      );
      return NextResponse.json({ success: true, item: row });
    }

    // ── EXPENSE: branch spend — feeds Profit & Reports ──────────────────
    if (entity === "EXPENSE") {
      const amount = Number(data.amountGhs) || 0;
      if (!data.category || amount <= 0) {
        return NextResponse.json({ success: false, error: "Category and a positive amount are required" }, { status: 400 });
      }
      await bookTransaction(
        { id: biz.id, code: biz.code, name: biz.name },
        "EXPENSE",
        amount,
        `CAR_WASH_${String(data.category).toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 30)}`,
        `Auto Wash expense — ${data.category}${data.description ? `: ${data.description}` : ""}`,
        data.paymentMethod || "CASH",
        actor.a,
        actor.r,
        data.createdByUserId
      );
      await logActivity(biz.id, biz.code, "EXPENSE_LOGGED", `Expense recorded: ${data.category} — GH₵${amount}`, actor.a, actor.r, null);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: `Unknown entity: ${entity}` }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { entity, id, data } = body;
    if (!entity || !id) {
      return NextResponse.json({ success: false, error: "entity and id required" }, { status: 400 });
    }
    const today = new Date().toISOString().split("T")[0];

    // ── SERVICE: update the offer ───────────────────────────────────────
    if (entity === "SERVICE") {
      const [before] = await db.select().from(carWashServices).where(eq(carWashServices.id, Number(id)));
      if (!before) return NextResponse.json({ success: false, error: "Service not found" }, { status: 404 });
      const [row] = await db
        .update(carWashServices)
        .set({
          name: data?.name ?? undefined,
          category: data?.category && SERVICE_CATEGORIES.includes(data.category) ? data.category : undefined,
          description: data?.description !== undefined ? data.description : undefined,
          priceGhs: data?.priceGhs !== undefined ? Number(data.priceGhs) : undefined,
          durationMinutes: data?.durationMinutes !== undefined ? Number(data.durationMinutes) : undefined,
          includesItems: data?.includesItems !== undefined ? data.includesItems : undefined,
          supplyInventoryId: data?.supplyInventoryId !== undefined ? (data.supplyInventoryId ? Number(data.supplyInventoryId) : null) : undefined,
          supplyUsageLiters: data?.supplyUsageLiters !== undefined ? Number(data.supplyUsageLiters) : undefined,
          active: data?.active !== undefined ? !!data.active : undefined,
        })
        .where(eq(carWashServices.id, Number(id)))
        .returning();
      await logActivity(before.businessId, before.branchCode, "SERVICE_UPDATED", `Service updated: ${row.name} — GH₵${row.priceGhs}${row.active ? "" : " (deactivated)"}`, data?.actorName, data?.actorRole, null);
      return NextResponse.json({ success: true, item: row });
    }

    // ── BOOKING: BOOKED → CHECKED_IN / COMPLETED / CANCELLED ───────────
    if (entity === "BOOKING") {
      const [before] = await db.select().from(carWashBookings).where(eq(carWashBookings.id, Number(id)));
      if (!before) return NextResponse.json({ success: false, error: "Booking not found" }, { status: 404 });
      const next = ["BOOKED", "CHECKED_IN", "COMPLETED", "CANCELLED"].includes(data?.status) ? data.status : before.status;
      const [row] = await db
        .update(carWashBookings)
        .set({
          status: next,
          checkedInAt: next === "CHECKED_IN" && !before.checkedInAt ? today : undefined,
          completedAt: next === "COMPLETED" && !before.completedAt ? today : undefined,
          assignedStaffName: data?.assignedStaffName !== undefined ? data.assignedStaffName : undefined,
          timeSlot: data?.timeSlot !== undefined ? data.timeSlot : undefined,
          notes: data?.notes !== undefined ? data.notes : undefined,
        })
        .where(eq(carWashBookings.id, Number(id)))
        .returning();
      if (next !== before.status) {
        await logActivity(before.businessId, before.branchCode, "BOOKING_UPDATED", `Booking ${before.bookingNumber}: ${before.status} → ${next} (${before.customerName} — ${before.serviceName})`, data?.actorName, data?.actorRole, before.bookingNumber);
      }
      return NextResponse.json({ success: true, item: row });
    }

    // ── WASH: IN_PROGRESS → COMPLETED books the whole chain exactly once ─
    if (entity === "WASH") {
      const [before] = await db.select().from(carWashWashes).where(eq(carWashWashes.id, Number(id)));
      if (!before) return NextResponse.json({ success: false, error: "Wash not found" }, { status: 404 });
      const next = ["IN_PROGRESS", "COMPLETED", "CANCELLED"].includes(data?.status) ? data.status : before.status;
      if (before.status === "COMPLETED" && next !== "COMPLETED") {
        return NextResponse.json({ success: false, error: "A completed wash is final — it has already posted to Finance" }, { status: 400 });
      }
      const [row] = await db
        .update(carWashWashes)
        .set({
          status: next,
          doneAt: next === "COMPLETED" && before.status !== "COMPLETED" ? today : undefined,
          staffId: data?.staffId !== undefined ? (data.staffId ? Number(data.staffId) : null) : undefined,
          staffName: data?.staffName !== undefined ? data.staffName : undefined,
          notes: data?.notes !== undefined ? data.notes : undefined,
        })
        .where(eq(carWashWashes.id, Number(id)))
        .returning();

      if (row.status === "COMPLETED" && before.status !== "COMPLETED") {
        const [biz] = await db.select().from(businesses).where(eq(businesses.id, row.businessId));

        // 1. Sale/Payment → Finance (INCOME)
        await bookTransaction(
          { id: row.businessId, code: row.branchCode, name: biz?.name || null },
          "INCOME",
          row.priceGhs || 0,
          "CAR_WASH_SERVICE",
          `Wash ${row.washNumber}: ${row.serviceName} — ${row.vehicleLabel} (${row.customerName})`,
          data?.paymentMethod || "CASH",
          data?.actorName || row.createdByName,
          data?.actorRole || row.createdByRole,
          data?.actorUserId
        );

        // 2. Inventory usage: draw the service's chemical supply from stock
        const [svc] = row.serviceId
          ? await db.select().from(carWashServices).where(eq(carWashServices.id, row.serviceId))
          : [null];
        if (svc?.supplyInventoryId && (svc.supplyUsageLiters || 0) > 0) {
          await stockOutLiters(Number(svc.supplyInventoryId), Number(svc.supplyUsageLiters));
        }

        // 3. Customer record: accrue spend + loyalty (find-or-create)
        const custId = await upsertWashCustomer(
          { id: row.businessId, code: row.branchCode },
          row.customerName,
          row.customerPhone,
          row.priceGhs || 0
        );
        if (custId && !row.customerId) {
          await db.update(carWashWashes).set({ customerId: custId }).where(eq(carWashWashes.id, row.id));
          row.customerId = custId;
        }

        // 4. Linked booking completes with the job
        if (row.bookingId) {
          await db
            .update(carWashBookings)
            .set({ status: "COMPLETED", completedAt: today })
            .where(eq(carWashBookings.id, row.bookingId));
        }

        await logActivity(
          row.businessId,
          row.branchCode,
          "WASH_COMPLETED",
          `Wash ${row.washNumber} completed: ${row.vehicleLabel} — ${row.serviceName} for ${row.customerName} • GH₵${row.priceGhs}${svc?.supplyUsageLiters ? ` • ${svc.supplyUsageLiters}L chemicals used` : ""}`,
          data?.actorName || row.createdByName,
          data?.actorRole || row.createdByRole,
          row.washNumber
        );
      }
      if (row.status === "CANCELLED" && before.status !== "CANCELLED") {
        await logActivity(
          row.businessId,
          row.branchCode,
          "WASH_CANCELLED",
          `Wash ${row.washNumber} cancelled before completion: ${row.vehicleLabel} — ${row.serviceName} (no charge posted)`,
          data?.actorName || row.createdByName,
          data?.actorRole || row.createdByRole,
          row.washNumber
        );
      }
      return NextResponse.json({ success: true, item: row });
    }

    return NextResponse.json({ success: false, error: `Unknown entity: ${entity}` }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
