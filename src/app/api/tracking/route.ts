import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { customerTrackings, businesses, notifications, transactions, salesDocuments, creditSales } from "@/db/schema";
import { desc, eq, inArray } from "drizzle-orm";
import {
  getSessionInfo,
  accessibleBusinessIds,
  canAccessBusiness,
  filterByAccess,
  UNAUTHENTICATED,
  FORBIDDEN,
} from "@/lib/auth";
import {
  buildTrackingCode,
  isValidTransition,
  nextStatuses,
  TRACK_STATUS_LABELS,
  type TrackStatus,
} from "@/lib/tracking";
import {
  uniqueTrackingCode,
  deductOrderStock,
  restoreOrderStock,
  bookOrderPayment,
  linkCrmCustomer,
  normalizeDeliveryPin,
} from "@/lib/trackingServer";
import { validatePhone } from "@/lib/phone";
import { pushAfterBell } from "@/lib/push";

/**
 * Staff console API — Customer Order Tracking.
 *
 * VISIBILITY: every signed-in staff member, strictly scoped with the same
 * Business/Branch access rules as the rest of GoMina 360 (OWNER: all;
 * managers/workers: their assigned + owner-granted businesses only —
 * enforced server-side by accessibleBusinessIds/filterByAccess).
 *
 * ACTIONS (POST):
 *   CREATE     { businessId, customerName, customerPhone?, items?, totalGhs?,
 *                fulfillmentType?, destinationAddress?, note?, customerId?,
 *                saleDocumentId?, transactionId? }
 *              → mints a unique GM-* tracking code, status RECEIVED.
 *   SET_STATUS { id, status, note? }
 *              → validates the flow RECEIVED → CONFIRMED → PROCESSING →
 *                READY|DISPATCHED → COMPLETED|DELIVERED (CANCELLED any time
 *                before terminal); appends an immutable history entry and
 *                notifies the order's creator in-app (bell).
 *   LOCATION   { id, lat, lng, driverName?, vehicleNote? }
 *              → live dispatch ping; only while status = DISPATCHED.
 */

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;

    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const statusFilter = (url.searchParams.get("status") || "").trim().toUpperCase();
    const bizFilter = Number(url.searchParams.get("businessId") || 0) || null;

    const allowed = await accessibleBusinessIds(me);
    const scoped = filterByAccess(await db.select().from(customerTrackings), allowed);

    const bizRows = await db.select().from(businesses);
    const bizName = (id: number) => bizRows.find((b) => b.id === id);

    let rows = scoped;
    if (bizFilter) rows = rows.filter((r) => r.businessId === bizFilter);
    if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
    if (q) {
      rows = rows.filter((r) => {
        const items = Array.isArray(r.items) ? r.items : [];
        return (
          r.trackingCode.toLowerCase().includes(q) ||
          (r.customerName || "").toLowerCase().includes(q) ||
          (r.customerPhone || "").toLowerCase().includes(q) ||
          items.some((li: any) => String(li?.description || "").toLowerCase().includes(q))
        );
      });
    }
    rows = [...rows].sort(
      (a, b) => new Date(b.updatedAt as any).getTime() - new Date(a.updatedAt as any).getTime(),
    );

    // Linked-system lookups for the Orders register: Sales documents and
    // Finance transactions referenced by the scoped orders.
    const trxIds = [...new Set(rows.map((r) => r.transactionId).filter(Boolean))] as number[];
    const docIds = [...new Set(rows.map((r) => r.saleDocumentId).filter(Boolean))] as number[];
    const [trxRows, docRows] = await Promise.all([
      trxIds.length
        ? db.select({ id: transactions.id, transactionNumber: transactions.transactionNumber, type: transactions.type, category: transactions.category })
            .from(transactions).where(inArray(transactions.id, trxIds))
        : [],
      docIds.length
        ? db.select({ id: salesDocuments.id, documentNumber: salesDocuments.documentNumber, documentType: salesDocuments.documentType })
            .from(salesDocuments).where(inArray(salesDocuments.id, docIds))
        : [],
    ]);
    const trxById = new Map(trxRows.map((t) => [t.id, t]));
    const docById = new Map(docRows.map((d) => [d.id, d]));

    // Credit sales riding on these orders — the Orders register shows the
    // live installment position (paid vs outstanding) right on each row.
    const trackingIds = rows.map((r) => r.id);
    const creditRows = trackingIds.length
      ? await db
          .select({
            trackingId: creditSales.trackingId,
            creditCode: creditSales.creditCode,
            status: creditSales.status,
            totalGhs: creditSales.totalGhs,
            amountPaidGhs: creditSales.amountPaidGhs,
            balanceGhs: creditSales.balanceGhs,
            dueDate: creditSales.dueDate,
          })
          .from(creditSales)
          .where(inArray(creditSales.trackingId, trackingIds))
      : [];
    const creditByTracking = new Map(creditRows.map((c) => [c.trackingId, c]));

    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const counts = {
      total: scoped.length,
      active: scoped.filter((r) => !["DELIVERED", "COMPLETED", "CANCELLED"].includes(r.status)).length,
      dispatched: scoped.filter((r) => r.status === "DISPATCHED").length,
      ready: scoped.filter((r) => r.status === "READY").length,
      doneThisWeek: scoped.filter(
        (r) => ["DELIVERED", "COMPLETED"].includes(r.status) && new Date(r.updatedAt as any).getTime() >= sevenDaysAgo,
      ).length,
    };

    return NextResponse.json({
      success: true,
      meta: {
        scope: allowed === null ? "ALL" : allowed,
        counts,
        statuses: Object.keys(TRACK_STATUS_LABELS),
      },
      trackings: rows.slice(0, 300).map((r) => {
        const biz = bizName(r.businessId);
        const trx = r.transactionId ? trxById.get(r.transactionId) : null;
        const doc = r.saleDocumentId ? docById.get(r.saleDocumentId) : null;
        return {
          ...r,
          // Human Order ID for the Orders register (stable, per-order).
          orderRef: `ORD-${String(r.id).padStart(5, "0")}`,
          businessName: biz?.name || `Business #${r.businessId}`,
          businessCode: biz?.code || r.branchCode || "",
          businessGps: biz && biz.gpsLat != null && biz.gpsLng != null ? { lat: biz.gpsLat, lng: biz.gpsLng } : null,
          // Business telephone customers call for payment assistance /
          // delivery support — set per unit by the OWNER/authorized staff.
          businessHelpPhone: biz?.customerHelpPhone || null,
          linkedTransaction: trx
            ? { id: trx.id, number: trx.transactionNumber, type: trx.type, category: trx.category }
            : null,
          linkedDocument: doc
            ? { id: doc.id, number: doc.documentNumber, type: doc.documentType }
            : null,
          // Installment position when this order is a credit sale (null otherwise).
          credit: creditByTracking.get(r.id) || null,
          allowedNext: nextStatuses(r.status, r.fulfillmentType).map((s) => ({
            status: s,
            label: TRACK_STATUS_LABELS[s as TrackStatus],
          })),
          trackUrl: `/track?code=${encodeURIComponent(r.trackingCode)}`,
        };
      }),
    });
  } catch (error: any) {
    console.error("GET /api/tracking error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;

    const body = await request.json();
    const action = body.action;

    if (action === "CREATE") {
      const businessId = Number(body.businessId);
      if (!businessId) {
        return NextResponse.json({ success: false, error: "businessId is required." }, { status: 400 });
      }
      if (!(await canAccessBusiness(me, businessId))) return FORBIDDEN();

      const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
      if (!biz) {
        return NextResponse.json({ success: false, error: "Business not found." }, { status: 404 });
      }

      const fulfillmentType = body.fulfillmentType === "DELIVERY" ? "DELIVERY" : "PICKUP";
      const items = Array.isArray(body.items)
        ? body.items
            .filter((li: any) => li && String(li.description || "").trim())
            .map((li: any) => ({
              description: String(li.description).trim(),
              sku: li.sku || null,
              quantity: Number(li.quantity) || 1,
              unit: li.unit || null,
              unitPrice: Number(li.unitPrice) || 0,
              total: (Number(li.quantity) || 1) * (Number(li.unitPrice) || 0),
            }))
        : [];
      const r2 = (n: number) => Math.round(n * 100) / 100;
      const subtotalGhs = items.reduce((acc: number, li: any) => acc + li.total, 0);
      // Percentage discount (staff register): amount is auto-calculated.
      let discountPct = 0;
      let discountGhs = 0;
      if (body.discountPercent !== undefined && body.discountPercent !== null && body.discountPercent !== "") {
        const pct = Number(body.discountPercent);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          return NextResponse.json(
            { success: false, error: "Discount percent must be between 0 and 100." },
            { status: 400 },
          );
        }
        discountPct = r2(pct);
        discountGhs = r2((subtotalGhs * discountPct) / 100);
      }
      const totalGhs =
        body.totalGhs != null && !Number.isNaN(Number(body.totalGhs))
          ? Number(body.totalGhs)
          : r2(subtotalGhs - discountGhs);
      const customerName = String(body.customerName || "").trim() || "Walk-in Customer";
      // Phone is optional on the staff register, but when given it must be a
      // real number (same rules as the customer storefront).
      let customerPhone: string | null = null;
      const rawPhone = String(body.customerPhone || "").trim();
      if (rawPhone) {
        const phoneVerdict = validatePhone(rawPhone.slice(0, 30));
        if (!phoneVerdict.ok) {
          return NextResponse.json({ success: false, error: phoneVerdict.error }, { status: 400 });
        }
        customerPhone = phoneVerdict.value.slice(0, 20);
      }

      // Optional Google-Maps delivery pin (staff may paste a shared map link
      // or exact coordinates when booking a delivery for a customer).
      let pin: ReturnType<typeof normalizeDeliveryPin> = null;
      if (fulfillmentType === "DELIVERY") {
        try {
          pin = normalizeDeliveryPin(body);
        } catch (e: any) {
          return NextResponse.json({ success: false, error: e.message }, { status: 400 });
        }
      }

      const code = await uniqueTrackingCode(biz.code);
      const now = new Date();
      const note = String(body.note || "").trim();
      const history = [
        {
          status: "RECEIVED",
          at: now.toISOString(),
          by: me.name || "Staff",
          byRole: me.role || "WORKER",
          note: note || "Order received and registered for tracking.",
        },
      ];

      const [row] = await db
        .insert(customerTrackings)
        .values({
          trackingCode: code,
          businessId,
          branchCode: body.branchCode || biz.code || null,
          branchName: body.branchName || biz.branchLocation || biz.name || null,
          customerId: body.customerId ? Number(body.customerId) : null,
          customerName,
          customerPhone,
          saleDocumentId: body.saleDocumentId ? Number(body.saleDocumentId) : null,
          transactionId: body.transactionId ? Number(body.transactionId) : null,
          items,
          discountPercent: discountPct,
          discountGhs,
          totalGhs,
          currency: "GHS",
          fulfillmentType,
          destinationAddress:
            fulfillmentType === "DELIVERY"
              ? String(body.destinationAddress || "").trim() || null
              : null,
          ...(pin || {}), // deliveryLat/Lng/accuracyM + mapLink + pinnedAt
          status: "RECEIVED",
          statusHistory: history,
          notes: note || null,
          createdByUserId: me.id,
          createdByName: me.name || "Staff",
          createdByRole: me.role || null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return NextResponse.json({
        success: true,
        tracking: { ...row, businessName: biz.name, businessCode: biz.code },
        trackUrl: `/track?code=${encodeURIComponent(code)}`,
      });
    }

    if (action === "SET_STATUS") {
      const id = Number(body.id);
      const target = String(body.status || "").toUpperCase();
      if (!id || !target) {
        return NextResponse.json({ success: false, error: "id and status are required." }, { status: 400 });
      }
      const [row] = await db.select().from(customerTrackings).where(eq(customerTrackings.id, id));
      if (!row) {
        return NextResponse.json({ success: false, error: "Tracking not found." }, { status: 404 });
      }
      if (!(await canAccessBusiness(me, row.businessId))) return FORBIDDEN();
      if (!isValidTransition(row.status, target, row.fulfillmentType)) {
        return NextResponse.json(
          {
            success: false,
            error: `Cannot move from ${TRACK_STATUS_LABELS[row.status as TrackStatus] || row.status} to ${
              TRACK_STATUS_LABELS[target as TrackStatus] || target
            }. Allowed next: ${
              nextStatuses(row.status, row.fulfillmentType)
                .map((s) => TRACK_STATUS_LABELS[s])
                .join(", ") || "none — order is closed"
            }.`,
          },
          { status: 400 },
        );
      }

      const note = String(body.note || "").trim();
      const now = new Date();

      // Online orders commit their reserved stock when staff CONFIRM them —
      // and get it back automatically if the order is later cancelled.
      let stockCommitted: boolean | undefined;
      if (
        target === "CONFIRMED" &&
        row.orderSource === "ONLINE" &&
        !row.stockCommitted &&
        ((row.items as any[]) || []).some((li: any) => li?.inventoryId)
      ) {
        const stock = await deductOrderStock(row.items as any[]);
        if (!stock.ok) {
          return NextResponse.json(
            { success: false, error: `Cannot confirm — stock problem: ${stock.problems.join(" ")}` },
            { status: 409 },
          );
        }
        stockCommitted = true;
      }
      if (target === "CANCELLED" && row.stockCommitted) {
        await restoreOrderStock(row.items as any[]);
        stockCommitted = false;
      }

      const history = [
        ...(Array.isArray(row.statusHistory) ? (row.statusHistory as any[]) : []),
        {
          status: target,
          at: now.toISOString(),
          by: me.name || "Staff",
          byRole: me.role || "WORKER",
          note:
            note ||
            (target === "CONFIRMED" && stockCommitted
              ? "Order confirmed — items reserved from branch stock."
              : target === "CANCELLED" && stockCommitted === false
              ? "Order cancelled — reserved stock returned to inventory."
              : null),
        },
      ];
      const [updated] = await db
        .update(customerTrackings)
        .set({
          status: target,
          statusHistory: history,
          updatedAt: now,
          ...(stockCommitted !== undefined ? { stockCommitted } : {}),
        })
        .where(eq(customerTrackings.id, id))
        .returning();

      // Staff notification (bell) for the order creator when someone else advanced it.
      try {
        if (row.createdByUserId && row.createdByUserId !== me.id) {
          const statusTitle = `Order ${row.trackingCode} → ${TRACK_STATUS_LABELS[target as TrackStatus]}`;
          const statusBody = `${me.name || "A colleague"} moved this order to ${
            TRACK_STATUS_LABELS[target as TrackStatus]
          }${note ? ` — "${note}"` : ""}. Customer can see it live at /track.`;
          await db.insert(notifications).values({
            userId: row.createdByUserId,
            type: "ORDER_TRACKING_STATUS",
            title: statusTitle,
            body: statusBody,
            recordType: "customer_trackings",
            recordId: row.id,
            recordRef: row.trackingCode,
            businessId: row.businessId,
            branchCode: row.branchCode,
            actorName: me.name || "Staff",
          });
          pushAfterBell([Number(row.createdByUserId)], {
            type: "ORDER_TRACKING_STATUS",
            title: statusTitle,
            body: statusBody,
            url: "/?tab=TRACKING",
          });
        }
      } catch (notifErr) {
        console.error("/api/tracking notify warning:", notifErr);
      }

      return NextResponse.json({ success: true, tracking: updated });
    }

    if (action === "LOCATION") {
      const id = Number(body.id);
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      if (!id || Number.isNaN(lat) || Number.isNaN(lng)) {
        return NextResponse.json({ success: false, error: "id, lat and lng are required." }, { status: 400 });
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return NextResponse.json({ success: false, error: "Coordinates out of range." }, { status: 400 });
      }
      const [row] = await db.select().from(customerTrackings).where(eq(customerTrackings.id, id));
      if (!row) {
        return NextResponse.json({ success: false, error: "Tracking not found." }, { status: 404 });
      }
      if (!(await canAccessBusiness(me, row.businessId))) return FORBIDDEN();
      if (row.status !== "DISPATCHED") {
        return NextResponse.json(
          { success: false, error: "Live location can only be shared while the order is DISPATCHED." },
          { status: 409 },
        );
      }
      const [updated] = await db
        .update(customerTrackings)
        .set({
          driverLat: lat,
          driverLng: lng,
          driverLocationAt: new Date(),
          driverName: String(body.driverName || "").trim() || row.driverName || me.name || null,
          vehicleNote: String(body.vehicleNote || "").trim() || row.vehicleNote,
          updatedAt: new Date(),
        })
        .where(eq(customerTrackings.id, id))
        .returning();
      return NextResponse.json({ success: true, tracking: updated });
    }

    if (action === "MARK_PAID") {
      const id = Number(body.id);
      const method = body.method === "MTN_MOMO" ? "MTN_MOMO" : body.method === "CASH" ? "CASH" : null;
      if (!id || !method) {
        return NextResponse.json(
          { success: false, error: "id and method (CASH or MTN_MOMO) are required." },
          { status: 400 },
        );
      }
      const [row] = await db.select().from(customerTrackings).where(eq(customerTrackings.id, id));
      if (!row) {
        return NextResponse.json({ success: false, error: "Tracking not found." }, { status: 404 });
      }
      if (!(await canAccessBusiness(me, row.businessId))) return FORBIDDEN();
      if (row.status === "CANCELLED") {
        return NextResponse.json({ success: false, error: "A cancelled order cannot be paid." }, { status: 409 });
      }
      if (row.paymentStatus === "PAID") {
        return NextResponse.json({ success: false, error: "This order is already marked as paid." }, { status: 409 });
      }

      const [biz] = await db.select().from(businesses).where(eq(businesses.id, row.businessId));
      const trxId = await bookOrderPayment({ tracking: row, method, staff: me, business: biz });
      // Spend now counts toward the shared CRM record too.
      await linkCrmCustomer({
        name: row.customerName,
        phone: row.customerPhone,
        businessId: row.businessId,
        spendGhs: row.totalGhs || 0,
      });

      const ref = String(body.ref || "").trim() || row.paymentRef || null;
      const now = new Date();
      const history = [
        ...(Array.isArray(row.statusHistory) ? (row.statusHistory as any[]) : []),
        {
          status: "PAYMENT",
          at: now.toISOString(),
          by: me.name || "Staff",
          byRole: me.role || "WORKER",
          note: `Payment confirmed (${method === "MTN_MOMO" ? "MTN MoMo" : "Cash"}) — GH₵ ${Number(
            row.totalGhs || 0,
          ).toFixed(2)} booked to revenue.`,
        },
      ];
      const [updated] = await db
        .update(customerTrackings)
        .set({
          paymentStatus: "PAID",
          paymentMethod: method,
          paymentRef: ref,
          paymentMarkedBy: me.name || "Staff",
          paymentMarkedAt: now,
          transactionId: row.transactionId || trxId,
          statusHistory: history,
          updatedAt: now,
        })
        .where(eq(customerTrackings.id, id))
        .returning();

      return NextResponse.json({ success: true, tracking: updated });
    }

    return NextResponse.json({ success: false, error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    console.error("POST /api/tracking error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
