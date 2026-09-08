import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  businesses,
  customers,
  transactions,
  telecomLines,
  telecomTxns,
  telecomWifiPackages,
  telecomVouchers,
  telecomActivities,
} from "@/db/schema";
import { eq, and, inArray, lt, desc } from "drizzle-orm";
import QRCode from "qrcode";
import crypto from "node:crypto";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

/**
 * Telecom & Digital Services API — MoMo, airtime, data bundles & Wi-Fi.
 *
 * Interlinks (same contract as every other specialized module):
 *   • Successful MoMo txn      → line float/cash movement + commission booked
 *                                as INCOME (TELECOM_COMMISSION) on the ledger
 *   • Airtime / data sale      → float pays the wholesale cost (EXPENSE
 *                                TELECOM_STOCK_COST), customer payment booked
 *                                as INCOME (TELECOM_SALE) → profit = margin
 *   • FAILED txn               → recorded with reason, NO float/cash/ledger
 *                                movement — tracked for review & re-attempts
 *   • Wi-Fi voucher sale       → voucher marked SOLD + activated with expiry
 *                                (activation + package duration), INCOME
 *                                (TELECOM_WIFI) booked, txn row linked
 *   • Branch expense           → EXPENSE transaction feeding Profit/Reports
 *   • Customers                → find-or-create + spend/loyalty accrual
 *   • Everything               → telecom_activities audit feed row
 */

const TXN_TYPES = ["MOMO_DEPOSIT", "MOMO_WITHDRAWAL", "MOMO_TRANSFER", "AIRTIME", "DATA", "WIFI_VOUCHER"];
const NETWORKS = ["MTN", "TELECEL", "AT", "WIFI"];
const LINE_KINDS = ["MOMO_AGENT", "AIRTIME_WALLET", "DATA_WALLET", "WIFI_HOTSPOT"];

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
    .insert(telecomActivities)
    .values({ businessId, branchCode, action, detail, actorName: actorName || null, actorRole: actorRole || null, refNumber: refNumber || null })
    .catch((e) => console.error("telecom activity warning:", e));
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
    transactionNumber: `TRX-${now.getFullYear()}-${now.getTime().toString().slice(-6)}-${crypto.randomInt(10, 99)}`,
    businessId: biz.id,
    branchCode: biz.code,
    branchName: biz.name,
    type,
    category,
    amountGhs: Math.round(amount * 100) / 100,
    paymentMethod: paymentMethod || "CASH",
    description,
    date: now.toISOString().split("T")[0],
    createdAt: now,
    status: "COMPLETED",
    recordedBy: actorName || "Telecom Desk",
    recordedByRole: actorRole || null,
    recordedByUserId: actorUserId ? Number(actorUserId) : null,
  });
}

/** Find-or-create a branch customer and accrue spend + loyalty (telecom buyers). */
async function upsertTelecomCustomer(
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

/** Mark any sold Wi-Fi voucher whose validity window has passed as EXPIRED. */
async function expireDueVouchers(businessId: number) {
  const due = await db
    .select()
    .from(telecomVouchers)
    .where(and(eq(telecomVouchers.businessId, businessId), inArray(telecomVouchers.status, ["SOLD", "USED"]), lt(telecomVouchers.expiresAt, new Date())));
  for (const v of due) {
    await db.update(telecomVouchers).set({ status: "EXPIRED" }).where(eq(telecomVouchers.id, v.id));
    await logActivity(businessId, v.branchCode, "VOUCHER_EXPIRED", `Voucher ${v.code} (${v.packageName}) expired${v.customerName ? ` — user ${v.customerName}` : ""}`, null, null, v.code);
  }
}

const newCode = () => `WF-${crypto.randomBytes(2).toString("hex").toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
const newPin = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

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

    await expireDueVouchers(businessId);

    const [lines, txns, packages, acts] = await Promise.all([
      db.select().from(telecomLines).where(eq(telecomLines.businessId, businessId)).orderBy(telecomLines.id),
      db.select().from(telecomTxns).where(eq(telecomTxns.businessId, businessId)).orderBy(desc(telecomTxns.id)).limit(400),
      db.select().from(telecomWifiPackages).where(eq(telecomWifiPackages.businessId, businessId)).orderBy(telecomWifiPackages.id),
      db.select().from(telecomActivities).where(eq(telecomActivities.businessId, businessId)).orderBy(desc(telecomActivities.id)).limit(150),
    ]);
    const vouchers = await db
      .select()
      .from(telecomVouchers)
      .where(eq(telecomVouchers.businessId, businessId))
      .orderBy(desc(telecomVouchers.id))
      .limit(500);

    return NextResponse.json({ success: true, lines, txns, packages, vouchers, activities: acts });
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
    const actor = { a: data.createdByName || null, r: data.createdByRole || null, u: data.createdByUserId ?? null };

    // ── LINE: open an agent line (MoMo SIM / airtime / data wallet / hotspot)
    if (entity === "LINE") {
      if (!data.label || !data.network || !LINE_KINDS.includes(data.kind)) {
        return NextResponse.json({ success: false, error: "Line name, network and type are required" }, { status: 400 });
      }
      const [row] = await db
        .insert(telecomLines)
        .values({
          businessId: biz.id,
          branchCode: biz.code,
          network: NETWORKS.includes(String(data.network).toUpperCase()) ? String(data.network).toUpperCase() : "MTN",
          kind: data.kind,
          label: String(data.label),
          msisdn: data.msisdn || null,
          floatGhs: Math.max(0, Number(data.floatGhs) || 0),
          cashGhs: Math.max(0, Number(data.cashGhs) || 0),
          active: true,
        })
        .returning();
      await logActivity(biz.id, biz.code, "LINE_CREATED", `New line: ${row.label} (${row.network} ${row.kind})${row.msisdn ? ` — ${row.msisdn}` : ""} · float GH₵${row.floatGhs} / cash GH₵${row.cashGhs}`, actor.a, actor.r, null);
      return NextResponse.json({ success: true, item: row });
    }

    // ── TXN: MoMo deposit/withdrawal/transfer, airtime or data sale ──────
    if (entity === "TXN") {
      const type = String(data.type || "").toUpperCase();
      if (!TXN_TYPES.includes(type) || type === "WIFI_VOUCHER") {
        return NextResponse.json({ success: false, error: `type must be one of ${TXN_TYPES.filter((t) => t !== "WIFI_VOUCHER").join(", ")}` }, { status: 400 });
      }
      const amount = Number(data.amountGhs) || 0;
      if (amount <= 0) return NextResponse.json({ success: false, error: "A positive amount is required" }, { status: 400 });
      const charge = Math.max(0, Number(data.chargeGhs) || 0);
      const commission = Math.max(0, Number(data.commissionGhs) || 0);
      const cost = Math.max(0, Number(data.costGhs) || 0);
      const status = data.status === "FAILED" ? "FAILED" : "SUCCESS";
      if (status === "FAILED" && !String(data.failReason || "").trim()) {
        return NextResponse.json({ success: false, error: "A failure reason is required for failed transactions" }, { status: 400 });
      }

      const [line] = data.lineId ? await db.select().from(telecomLines).where(eq(telecomLines.id, Number(data.lineId))) : [null];
      if (data.lineId && (!line || line.businessId !== biz.id)) {
        return NextResponse.json({ success: false, error: "Line not found for this branch" }, { status: 400 });
      }

      const txnNumber = `TEL-${new Date().getFullYear()}-${stamp}${crypto.randomInt(10, 99)}`;

      // Float/cash movement + ledger booking only for successful transactions.
      if (status === "SUCCESS") {
        if (type === "MOMO_DEPOSIT" || type === "MOMO_TRANSFER") {
          // Customer hands cash → agent sends e-money from float.
          if (line && (line.floatGhs || 0) < amount - 0.001) {
            return NextResponse.json({ success: false, error: `Insufficient float on ${line.label} (GH₵${(line.floatGhs || 0).toFixed(2)} available — top up the float first)` }, { status: 400 });
          }
          if (line) {
            await db.update(telecomLines).set({
              floatGhs: Math.round(((line.floatGhs || 0) - amount + commission) * 100) / 100,
              cashGhs: Math.round(((line.cashGhs || 0) + amount + charge) * 100) / 100,
            }).where(eq(telecomLines.id, line.id));
          }
        } else if (type === "MOMO_WITHDRAWAL") {
          // Customer sends e-money → agent pays out cash.
          if (line && (line.cashGhs || 0) < amount - 0.001) {
            return NextResponse.json({ success: false, error: `Insufficient cash on ${line.label} (GH₵${(line.cashGhs || 0).toFixed(2)} on hand — the customer pays out more cash than the till holds)` }, { status: 400 });
          }
          if (line) {
            await db.update(telecomLines).set({
              floatGhs: Math.round(((line.floatGhs || 0) + amount + commission) * 100) / 100,
              cashGhs: Math.round(((line.cashGhs || 0) - amount + charge) * 100) / 100,
            }).where(eq(telecomLines.id, line.id));
          }
        } else {
          // AIRTIME / DATA: float pays the wholesale cost; customer pays cash.
          if (line && (line.floatGhs || 0) < cost - 0.001) {
            return NextResponse.json({ success: false, error: `Insufficient float on ${line.label} (GH₵${(line.floatGhs || 0).toFixed(2)} available for a GH₵${cost.toFixed(2)} wholesale cost)` }, { status: 400 });
          }
          if (line) {
            await db.update(telecomLines).set({
              floatGhs: Math.round(((line.floatGhs || 0) - cost + commission) * 100) / 100,
              cashGhs: Math.round(((line.cashGhs || 0) + amount + charge) * 100) / 100,
            }).where(eq(telecomLines.id, line.id));
          }
        }

        // Finance ledger interlink.
        const label = ({ MOMO_DEPOSIT: "MoMo deposit", MOMO_WITHDRAWAL: "MoMo withdrawal", MOMO_TRANSFER: "MoMo transfer", AIRTIME: "Airtime sale", DATA: "Data bundle sale" } as Record<string, string>)[type] || "Sale";
        if (type.startsWith("MOMO")) {
          if (commission > 0) {
            await bookTransaction(biz, "INCOME", commission, "TELECOM_COMMISSION", `Telecom ${txnNumber}: ${label} commission — ${data.customerName || "walk-in"} (GH₵${amount}${charge ? ` + GH₵${charge} fee` : ""})`, data.paymentMethod || "CASH", actor.a, actor.r, actor.u);
          }
        } else {
          await bookTransaction(biz, "INCOME", amount + charge, "TELECOM_SALE", `Telecom ${txnNumber}: ${label} — ${data.customerName || data.customerPhone || "walk-in"}${data.network ? ` (${data.network})` : ""}`, data.paymentMethod || "CASH", actor.a, actor.r, actor.u);
          if (cost > 0) {
            await bookTransaction(biz, "EXPENSE", cost, "TELECOM_STOCK_COST", `Telecom ${txnNumber}: wholesale ${label.toLowerCase()} cost from float`, "MTN_MOMO", actor.a, actor.r, actor.u);
          }
        }
      }

      const [row] = await db
        .insert(telecomTxns)
        .values({
          businessId: biz.id,
          branchCode: biz.code,
          txnNumber,
          lineId: line?.id ?? null,
          network: data.network ? String(data.network).toUpperCase() : line?.network || null,
          type,
          customerName: data.customerName || null,
          customerPhone: data.customerPhone || null,
          amountGhs: amount,
          chargeGhs: charge,
          commissionGhs: commission,
          costGhs: type === "AIRTIME" || type === "DATA" ? cost : 0,
          status,
          failReason: status === "FAILED" ? String(data.failReason) : null,
          reference: data.reference || null,
          paymentMethod: data.paymentMethod || "CASH",
          txnDate: data.txnDate || today,
          notes: data.notes || null,
          createdByUserId: actor.u ? Number(actor.u) : null,
          createdByName: actor.a,
          createdByRole: actor.r,
        })
        .returning();

      if (status === "SUCCESS" && data.customerName) {
        await upsertTelecomCustomer(biz, String(data.customerName), data.customerPhone || null, amount + charge);
      }
      await logActivity(
        biz.id,
        biz.code,
        status === "SUCCESS" ? "TXN_SUCCESS" : "TXN_FAILED",
        `${row.txnNumber}: ${type.replace(/_/g, " ")} GH₵${amount}${charge ? ` + GH₵${charge} fee` : ""}${commission ? ` · commission GH₵${commission}` : ""}${row.customerName ? ` — ${row.customerName}` : ""}${status === "FAILED" ? ` · FAILED (${row.failReason})` : ""}`,
        actor.a,
        actor.r,
        row.txnNumber
      );
      return NextResponse.json({ success: true, item: row });
    }

    // ── PACKAGE: create a Wi-Fi package ──────────────────────────────────
    if (entity === "PACKAGE") {
      const durationHours = Number(data.durationHours) || 0;
      if (!data.name || durationHours <= 0 || Number(data.priceGhs) <= 0) {
        return NextResponse.json({ success: false, error: "Package name, validity (hours) and price are required" }, { status: 400 });
      }
      const [row] = await db
        .insert(telecomWifiPackages)
        .values({
          businessId: biz.id,
          branchCode: biz.code,
          name: String(data.name),
          durationHours,
          dataCapMb: data.dataCapMb ? Number(data.dataCapMb) : null,
          priceGhs: Number(data.priceGhs),
          routerLabel: data.routerLabel || null,
          active: true,
        })
        .returning();
      await logActivity(biz.id, biz.code, "PACKAGE_CREATED", `Wi-Fi package created: ${row.name} — ${row.durationHours}h${row.dataCapMb ? ` / ${row.dataCapMb}MB` : " unlimited"} at GH₵${row.priceGhs}${row.routerLabel ? ` (${row.routerLabel})` : ""}`, actor.a, actor.r, null);
      return NextResponse.json({ success: true, item: row });
    }

    // ── VOUCHER_BATCH: print-ready vouchers with codes, PINs & QR ───────
    if (entity === "VOUCHER_BATCH") {
      const [pkg] = await db.select().from(telecomWifiPackages).where(eq(telecomWifiPackages.id, Number(data.packageId)));
      if (!pkg || pkg.businessId !== biz.id) {
        return NextResponse.json({ success: false, error: "Package not found for this branch" }, { status: 400 });
      }
      const count = Math.min(100, Math.max(1, Number(data.count) || 1));
      const made: any[] = [];
      for (let i = 0; i < count; i++) {
        const code = newCode();
        const pin = newPin();
        const qrData = await QRCode.toDataURL(JSON.stringify({ wifi: pkg.routerLabel || biz.name, code, pin }), { margin: 1, width: 240 });
        const [v] = await db
          .insert(telecomVouchers)
          .values({
            businessId: biz.id,
            branchCode: biz.code,
            packageId: pkg.id,
            packageName: pkg.name,
            code,
            accessCode: pin,
            qrData,
            status: "AVAILABLE",
            priceGhs: pkg.priceGhs,
            createdByName: actor.a,
            createdByRole: actor.r,
          })
          .returning();
        made.push(v);
      }
      await logActivity(biz.id, biz.code, "VOUCHERS_GENERATED", `${count} Wi-Fi voucher(s) generated for ${pkg.name} (codes, access PINs & QR scan cards)`, actor.a, actor.r, null);
      return NextResponse.json({ success: true, count: made.length, first: made[0] });
    }

    // ── VOUCHER_SALE: sell & activate a voucher (expiry starts now) ──────
    if (entity === "VOUCHER_SALE") {
      const [v] = await db.select().from(telecomVouchers).where(eq(telecomVouchers.id, Number(data.voucherId)));
      if (!v || v.businessId !== biz.id) {
        return NextResponse.json({ success: false, error: "Voucher not found for this branch" }, { status: 400 });
      }
      if (v.status !== "AVAILABLE") {
        return NextResponse.json({ success: false, error: `Voucher ${v.code} is ${v.status} — only AVAILABLE vouchers can be sold` }, { status: 400 });
      }
      const [pkg] = await db.select().from(telecomWifiPackages).where(eq(telecomWifiPackages.id, v.packageId));
      const nowT = new Date();
      const expiresAt = new Date(nowT.getTime() + (pkg?.durationHours || 24) * 3600 * 1000);
      const [row] = await db
        .update(telecomVouchers)
        .set({
          status: "SOLD",
          customerName: data.customerName || "Wi-Fi User",
          customerPhone: data.customerPhone || null,
          soldAt: nowT,
          activatedAt: nowT,
          expiresAt,
        })
        .where(eq(telecomVouchers.id, v.id))
        .returning();

      const txnNumber = `TEL-${new Date().getFullYear()}-${stamp}${crypto.randomInt(10, 99)}`;
      const [txn] = await db
        .insert(telecomTxns)
        .values({
          businessId: biz.id,
          branchCode: biz.code,
          txnNumber,
          network: "WIFI",
          type: "WIFI_VOUCHER",
          customerName: row.customerName,
          customerPhone: row.customerPhone,
          amountGhs: row.priceGhs,
          chargeGhs: 0,
          commissionGhs: row.priceGhs, // no wholesale cost — full price is margin
          costGhs: 0,
          status: "SUCCESS",
          reference: row.code,
          paymentMethod: data.paymentMethod || "CASH",
          voucherId: row.id,
          txnDate: today,
          notes: `${row.packageName} — valid until ${expiresAt.toLocaleString()}`,
          createdByUserId: actor.u ? Number(actor.u) : null,
          createdByName: actor.a,
          createdByRole: actor.r,
        })
        .returning();
      await bookTransaction(biz, "INCOME", row.priceGhs, "TELECOM_WIFI", `Telecom ${txnNumber}: Wi-Fi voucher ${row.code} (${row.packageName}) — ${row.customerName}`, data.paymentMethod || "CASH", actor.a, actor.r, actor.u);
      if (data.customerName) {
        await upsertTelecomCustomer(biz, String(data.customerName), data.customerPhone || null, row.priceGhs);
      }
      await logActivity(biz.id, biz.code, "VOUCHER_SOLD", `Voucher ${row.code} (${row.packageName}) sold to ${row.customerName} — GH₵${row.priceGhs}; valid ${pkg?.durationHours || 24}h until ${expiresAt.toLocaleString()}`, actor.a, actor.r, row.code);
      return NextResponse.json({ success: true, item: row, txn });
    }

    // ── EXPENSE: branch spend — feeds Profit & Reports ──────────────────
    if (entity === "EXPENSE") {
      const amount = Number(data.amountGhs) || 0;
      if (!data.category || amount <= 0) {
        return NextResponse.json({ success: false, error: "Category and a positive amount are required" }, { status: 400 });
      }
      await bookTransaction(
        biz,
        "EXPENSE",
        amount,
        `TELECOM_${String(data.category).toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 30)}`,
        `Telecom expense — ${data.category}${data.description ? `: ${data.description}` : ""}`,
        data.paymentMethod || "CASH",
        actor.a,
        actor.r,
        actor.u
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

    // ── LINE: rename/adjust + float & cash top-up / drawdown ─────────────
    if (entity === "LINE") {
      const [before] = await db.select().from(telecomLines).where(eq(telecomLines.id, Number(id)));
      if (!before) return NextResponse.json({ success: false, error: "Line not found" }, { status: 404 });
      const set: any = {
        label: data?.label ?? undefined,
        msisdn: data?.msisdn !== undefined ? data.msisdn : undefined,
        active: data?.active !== undefined ? !!data.active : undefined,
      };
      const amount = Math.abs(Number(data?.amountGhs) || 0);
      if (amount > 0 && (data?.target === "FLOAT" || data?.target === "CASH") && (data?.direction === "IN" || data?.direction === "OUT")) {
        const field = data.target === "FLOAT" ? "floatGhs" : "cashGhs";
        const cur = Number((before as any)[field]) || 0;
        if (data.direction === "OUT" && cur < amount - 0.001) {
          return NextResponse.json({ success: false, error: `Only GH₵${cur.toFixed(2)} in ${data.target.toLowerCase()} — cannot draw GH₵${amount}` }, { status: 400 });
        }
        set[field] = Math.round((cur + (data.direction === "IN" ? amount : -amount)) * 100) / 100;
      }
      const [row] = await db.update(telecomLines).set(set).where(eq(telecomLines.id, before.id)).returning();
      if (amount > 0) {
        await logActivity(before.businessId, before.branchCode, "FLOAT_TOPUP", `${before.label}: ${data.direction === "IN" ? "topped up" : "drew down"} ${data.target.toLowerCase()} by GH₵${amount} — now float GH₵${row.floatGhs} / cash GH₵${row.cashGhs}`, data?.actorName, data?.actorRole, null);
      } else {
        await logActivity(before.businessId, before.branchCode, "LINE_UPDATED", `Line updated: ${row.label}${row.active ? "" : " (deactivated)"}`, data?.actorName, data?.actorRole, null);
      }
      return NextResponse.json({ success: true, item: row });
    }

    // ── PACKAGE: update / deactivate ──────────────────────────────────────
    if (entity === "PACKAGE") {
      const [before] = await db.select().from(telecomWifiPackages).where(eq(telecomWifiPackages.id, Number(id)));
      if (!before) return NextResponse.json({ success: false, error: "Package not found" }, { status: 404 });
      const [row] = await db
        .update(telecomWifiPackages)
        .set({
          name: data?.name ?? undefined,
          durationHours: data?.durationHours !== undefined ? Number(data.durationHours) : undefined,
          dataCapMb: data?.dataCapMb !== undefined ? (data.dataCapMb ? Number(data.dataCapMb) : null) : undefined,
          priceGhs: data?.priceGhs !== undefined ? Number(data.priceGhs) : undefined,
          routerLabel: data?.routerLabel !== undefined ? data.routerLabel : undefined,
          active: data?.active !== undefined ? !!data.active : undefined,
        })
        .where(eq(telecomWifiPackages.id, before.id))
        .returning();
      await logActivity(before.businessId, before.branchCode, "PACKAGE_UPDATED", `Wi-Fi package updated: ${row.name} — GH₵${row.priceGhs} / ${row.durationHours}h${row.active ? "" : " (deactivated)"}`, data?.actorName, data?.actorRole, null);
      return NextResponse.json({ success: true, item: row });
    }

    // ── VOUCHER: revoke, or mark USED when the user connects ──────────────
    if (entity === "VOUCHER") {
      const [before] = await db.select().from(telecomVouchers).where(eq(telecomVouchers.id, Number(id)));
      if (!before) return NextResponse.json({ success: false, error: "Voucher not found" }, { status: 404 });
      const next = ["AVAILABLE", "USED", "REVOKED"].includes(data?.status) ? data.status : null;
      if (!next) return NextResponse.json({ success: false, error: "status must be USED or REVOKED" }, { status: 400 });
      if (next === "USED" && before.status !== "SOLD") {
        return NextResponse.json({ success: false, error: `Only a SOLD voucher can be marked USED (this one is ${before.status})` }, { status: 400 });
      }
      if (next === "REVOKED" && before.status === "USED") {
        return NextResponse.json({ success: false, error: "A USED voucher cannot be revoked" }, { status: 400 });
      }
      const [row] = await db
        .update(telecomVouchers)
        .set({ status: next, customerName: data?.customerName !== undefined ? data.customerName : undefined, customerPhone: data?.customerPhone !== undefined ? data.customerPhone : undefined })
        .where(eq(telecomVouchers.id, before.id))
        .returning();
      await logActivity(before.businessId, before.branchCode, next === "REVOKED" ? "VOUCHER_REVOKED" : "VOUCHER_USED", `Voucher ${before.code} (${before.packageName}): ${before.status} → ${next}`, data?.actorName, data?.actorRole, before.code);
      return NextResponse.json({ success: true, item: row });
    }

    // ── TXN: annotate (notes/reference) — status is immutable for audit ──
    if (entity === "TXN") {
      const [before] = await db.select().from(telecomTxns).where(eq(telecomTxns.id, Number(id)));
      if (!before) return NextResponse.json({ success: false, error: "Transaction not found" }, { status: 404 });
      const [row] = await db
        .update(telecomTxns)
        .set({ notes: data?.notes !== undefined ? data.notes : undefined, reference: data?.reference !== undefined ? data.reference : undefined })
        .where(eq(telecomTxns.id, before.id))
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    return NextResponse.json({ success: false, error: `Unknown entity: ${entity}` }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
