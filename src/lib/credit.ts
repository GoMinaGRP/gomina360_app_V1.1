/**
 * Credit Sales — shared domain logic.
 *
 * A credit sale lets a customer take goods now against a secure
 * order/customer code (their GM-* tracking code) and settle the bill in
 * installments. Staff run the whole lifecycle from Sales & Payments →
 * Credit: create the sale (deposit optional), then record each installment
 * against the credit/tracking code until the balance is zero.
 *
 * Money reflections (all automatic, all branch-stamped):
 *  - Sale created  → INVOICE sales document (status CREDIT) + GM-* order in
 *    Customer Tracking (payment status CREDIT) + stock deducted + CRM spend.
 *  - Every payment → credit_payments row + INCOME Finance transaction
 *    ("Credit Deposit" / "Credit Installment") + RECEIPT document.
 *  - Fully settled → credit status PAID, order payment status PAID, invoice
 *    flipped to PAID.
 */
import { randomCodePart } from "./tracking";

export const CREDIT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Paying in installments",
  PAID: "Fully paid",
};

/** CRD-<BIZWORD>-<6RANDOM>, e.g. CRD-POULTRY-4K7XQ2 (staff-facing). */
export function buildCreditCode(bizCode: string | null | undefined): string {
  const word =
    String(bizCode || "HQ")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, " ")
      .trim()
      .split(/\s+/)[0]
      .slice(0, 8) || "HQ";
  return `CRD-${word}-${randomCodePart(6)}`;
}

/** CRP-2026-123456 — per-installment payment number. */
export function buildCreditPaymentNumber(): string {
  return `CRP-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
}

/** 2-dp currency rounding used by every credit computation. */
export const r2 = (n: number) => Math.round(n * 100) / 100;

/** A balance smaller than half a pesewa counts as settled. */
export const SETTLED_EPSILON = 0.005;

export function normalizeCreditLookupCode(raw: string | null | undefined): string {
  return String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
}

/** True when the code looks like a credit ref (CRD-…) or an order code (GM-…). */
export function looksLikeCreditCode(s: string): boolean {
  return /^(CRD|GM)-[A-Z0-9]{1,8}-[A-Z0-9]{4,10}$/.test(s);
}

/**
 * Customer-safe credit summary for the public /track page — amounts, dates
 * and status only. Never staff identities, internal ids or MoMo references.
 */
export function publicCreditPayload(credit: any, payments: any[]) {
  if (!credit) return null;
  const total = Number(credit.totalGhs) || 0;
  const paid = Number(credit.amountPaidGhs) || 0;
  const balance = Number(credit.balanceGhs) || 0;
  return {
    creditCode: credit.creditCode,
    totalGhs: total,
    amountPaidGhs: paid,
    balanceGhs: balance,
    status: credit.status,
    statusLabel: CREDIT_STATUS_LABELS[credit.status] || credit.status,
    dueDate: credit.dueDate || null,
    paidAt: credit.paidAt ? new Date(credit.paidAt).toISOString() : null,
    progressPercent: total > 0 ? Math.min(100, Math.round((paid / total) * 1000) / 10) : 100,
    payments: (payments || []).map((p: any) => ({
      at: p.createdAt ? new Date(p.createdAt).toISOString() : null,
      amountGhs: Number(p.amountGhs) || 0,
      method: p.paymentMethod || null,
    })),
  };
}
