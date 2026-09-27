/**
 * Generated identifier helpers shared by the write routes.
 *
 * Transaction references (`TRX-YYYY-NNNNNN`) historically derived their
 * number segment from `Date.now()`'s trailing digits. The transactions table
 * enforces GLOBAL uniqueness on transaction_number, and a pure time-stamp
 * segment can repeat (same-millisecond inserts; the 5/6-digit windows wrap
 * every ~100 s / ~16.7 min), which surfaces as a rare 23505 unique-violation
 * failure for a legitimate sale. The fix mirrors the credit-sales precedent:
 * keep the readable time-stamp but append a random 2-digit suffix, taking the
 * collision odds from "repeat of the clock" to ~1/90 per same-millisecond
 * pair (and same-millisecond pairs are themselves rare).
 *
 * Format checks elsewhere are prefix-based (`/^TRX-/`); no consumer asserts
 * an exact digit count.
 */

/** Next transaction reference: TRX-<year>-<time-stamp><random 2 digits>. */
export function nextTrxNumber(now: Date = new Date()): string {
  return `TRX-${now.getFullYear()}-${now.getTime().toString().slice(-6)}${Math.floor(10 + Math.random() * 90)}`;
}
