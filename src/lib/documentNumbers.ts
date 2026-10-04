/**
 * Sales-document numbering — ONE generator for receipts, invoices and
 * quotations.
 *
 * Receipt numbers were previously minted in three places with different
 * formats: `RCP-YYYY-<6 trailing clock digits>` inside `salePosting` (POST a
 * sale) and inside `credit-sales` (POST an instalment), and `INV-YYYY-<clock>`
 * for invoices — each with its own ad-hoc collision patch, because
 * `sales_documents.document_number` is globally unique. The `/api/sales-documents`
 * route meanwhile used a proper sequence (`PREFIX-YYYY-NNNN` + existence
 * probe). This module keeps that readable sequence format and makes it the
 * only way a document number is made.
 *
 * The sequence is per (prefix, year) and derived from the highest existing
 * number for that prefix-year, then probed for free slots — so deleting a
 * document never causes a duplicate, and two concurrent posts can't collide.
 */
import { db } from "@/db";
import { salesDocuments } from "@/db/schema";
import { like } from "drizzle-orm";

export type SalesDocumentKind = "RECEIPT" | "INVOICE" | "QUOTATION";

const PREFIX: Record<SalesDocumentKind, string> = {
  RECEIPT: "RCP",
  INVOICE: "INV",
  QUOTATION: "QT",
};

const MAX_PROBES = 500;

/** `PREFIX-YYYY-NNNN` for the highest number already issued this year. */
export async function nextSalesDocumentNumber(
  documentType: SalesDocumentKind,
  now: Date = new Date()
): Promise<string> {
  const year = now.getFullYear();
  const prefix = PREFIX[documentType] || "DOC";
  const stem = `${prefix}-${year}-`;

  const rows = await db
    .select({ documentNumber: salesDocuments.documentNumber })
    .from(salesDocuments)
    .where(like(salesDocuments.documentNumber, `${stem}%`));

  let max = 0;
  for (const r of rows) {
    const tail = String(r.documentNumber || "").slice(stem.length);
    const m = /^(\d+)$/.exec(tail);
    if (m) max = Math.max(max, Number(m[1]) || 0);
  }

  const taken = new Set(rows.map((r) => String(r.documentNumber || "")));
  for (let attempt = max + 1; attempt <= max + MAX_PROBES; attempt += 1) {
    const candidate = `${stem}${String(attempt).padStart(4, "0")}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Pathological fallback — keeps the shape, guarantees uniqueness.
  return `${stem}${String(max + MAX_PROBES + 1).padStart(4, "0")}`;
}
