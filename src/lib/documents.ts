/**
 * R4 — Document Vault (CAPABILITY-AUDIT-REPORT §3).
 *
 * One registry (business_documents) for every business-level document:
 * uploaded licences/permits/contracts (image or PDF, ≤ 2.5 MB) plus
 * GENERATED report documents — vet reports from poultry health records and
 * delivery notes from delivered customer orders — produced as real PDFs by
 * a tiny dependency-free writer (uncompressed Helvetica text, A4 pages).
 *
 * Also home of the expiry sweep: documents carrying expiresOn warn the unit
 * at 30 / 7 / 0 days out (each window fires exactly once, marker-gated).
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { businessDocuments, businesses, customerTrackings, poultryFlocks, poultryHealthRecords } from "@/db/schema";
import { getSystemMarker, setSystemMarker } from "@/lib/systemMarkers";
import { orderNotificationRecipients, ownerOrgOfBusiness } from "@/lib/notify";

export const MAX_DOC_BYTES = 2.5 * 1024 * 1024; // 2.5 MB of base64 payload

/** Validate an upload: data URL, image/* or application/pdf, ≤ 2.5 MB. */
export function validateDocUpload(fileData: string): { ok: boolean; error?: string; mime?: string; bytes?: number } {
  const m = /^data:([^;,]+);base64,(.+)$/i.exec(String(fileData || "").trim());
  if (!m) return { ok: false, error: "fileData must be a base64 data URL." };
  const mime = m[1].toLowerCase();
  if (!/^image\/(png|jpe?g|webp|gif|heic|heif)$/.test(mime) && mime !== "application/pdf") {
    return { ok: false, error: "Only images (png/jpg/webp/gif/heic) and PDF files are accepted." };
  }
  const bytes = Math.floor((m[2].length * 3) / 4);
  if (bytes > MAX_DOC_BYTES) return { ok: false, error: `File is too large — the vault accepts up to 2.5 MB (this is ~${(bytes / 1024 / 1024).toFixed(1)} MB).` };
  return { ok: true, mime, bytes };
}

/* ────────────────────────────────────────────────────────────────────────
 * Minimal PDF writer — single-font text pages, no dependencies.
 * ──────────────────────────────────────────────────────────────────────── */

const esc = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

interface PdfLine {
  text: string;
  size: number;
  bold?: boolean;
  gapAfter?: number;
}

/** Lay out labeled report content as PDF lines (A4, ~52 lines/page). */
export function buildTextPdf(headerTitle: string, subtitle: string, lines: PdfLine[]): string {
  const pageW = 595, pageH = 842, marginX = 50, topY = 792, lineLead = 15;
  const pages: PdfLine[][] = [];
  let current: PdfLine[] = [
    { text: headerTitle, size: 16, bold: true, gapAfter: 6 },
    { text: subtitle, size: 9, gapAfter: 14 },
  ];
  let y = topY;
  const heightOf = (l: PdfLine) => l.size + (l.gapAfter || 0) + 4;
  for (const l of lines) {
    if (y - heightOf(l) < marginX) {
      pages.push(current);
      current = [];
      y = topY;
    }
    current.push(l);
    y -= heightOf(l);
  }
  pages.push(current);

  const objects: string[] = [];
  const pageObjIds = pages.map((_, i) => 3 + i * 2); // page + content pairs after catalog(1)/pages(2)/fonts
  const fontRegularId = 3 + pages.length * 2;
  const fontBoldId = fontRegularId + 1;

  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects.push(`<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  pages.forEach((pageLines, i) => {
    const contentId = pageObjIds[i] + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    let stream = "BT\n";
    let y2 = topY;
    for (const l of pageLines) {
      stream += `/F${l.bold ? 2 : 1} ${l.size} Tf\n1 0 0 1 ${marginX} ${y2} Tm\n(${esc(l.text)}) Tj\n`;
      y2 -= l.size + (l.gapAfter || 0) + 4;
    }
    stream += "ET";
    objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  });
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, idx) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return pdf;
}

export const pdfDataUrl = (pdf: string) => `data:application/pdf;base64,${Buffer.from(pdf, "latin1").toString("base64")}`;

/* ────────────────────────────────────────────────────────────────────────
 * Generated documents — vet reports & delivery notes.
 * ──────────────────────────────────────────────────────────────────────── */

const ghs = (n: any) => `GHS ${Number(n || 0).toFixed(2)}`;

/** Vet report PDF from a poultry health record (vaccination / treatment /
 *  inspection / biosecurity). Returns { fileData, title, fileName }. */
export async function generateVetReport(healthRecordId: number, actor: { id?: number; name?: string; role?: string }) {
  const [rec] = await db.select().from(poultryHealthRecords).where(eq(poultryHealthRecords.id, Number(healthRecordId)));
  if (!rec) return null;
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, Number(rec.businessId)));
  let flock: any = null;
  if (rec.flockId != null) {
    [flock] = await db.select().from(poultryFlocks).where(eq(poultryFlocks.id, Number(rec.flockId)));
  }
  const L = (k: string, v: any) => [{ text: `${k}: ${v == null || v === "" ? "—" : v}`, size: 10, gapAfter: 2 }];
  const pdf = buildTextPdf(
    "Veterinary Report",
    `${biz?.name || "GoMina 360"} · ${biz?.code || ""} · generated ${new Date().toLocaleString("en-GB")}`,
    [
      { text: `Record #${rec.id} — ${String(rec.recordType || "HEALTH")}`, size: 12, bold: true, gapAfter: 8 },
      ...L("Flock / batch", flock ? `${flock.batchNumber || flock.name || `Flock #${flock.id}`}` : rec.batchNumber || "—"),
      ...L("Vaccine / drug", rec.vaccineOrDrug),
      ...L("Disease / condition", rec.diseaseOrCondition),
      ...L("Dosage", rec.dosage),
      ...L("Administered by", rec.administeredBy),
      ...L("Birds affected", rec.birdsAffected),
      ...L("Mortality", rec.mortalityCount),
      ...L("Cost", rec.costGhs != null ? ghs(rec.costGhs) : "—"),
      ...L("Outcome", rec.outcome),
      ...L("Next due date", rec.nextDueDate),
      ...L("Recorded date", rec.recordedDate),
      ...L("Recorded by", rec.recordedByName),
      { text: "Notes", size: 11, bold: true, gapAfter: 4 },
      { text: String(rec.notes || "—").slice(0, 1200), size: 10 },
      { text: "", size: 10, gapAfter: 10 },
      { text: `Signature: ______________________    Stamp: ______________`, size: 10, gapAfter: 6 },
      { text: `Report generated by ${actor.name || "Staff"} (${actor.role || "STAFF"}) from the poultry health log.`, size: 8 },
    ],
  );
  return {
    fileData: pdfDataUrl(pdf),
    title: `Vet report — ${flock?.batchNumber || rec.batchNumber || `record #${rec.id}`} (${String(rec.recordType || "HEALTH").toLowerCase()})`,
    fileName: `vet-report-${rec.id}.pdf`,
    docType: "VET_REPORT",
    relatedType: "FLOCK",
    relatedId: rec.flockId != null ? Number(rec.flockId) : null,
    issuedOn: String(rec.recordedDate || "").slice(0, 10) || null,
  };
}

/** Delivery note PDF from a delivered customer order (tracking). */
export async function generateDeliveryNote(trackingId: number, actor: { id?: number; name?: string; role?: string }) {
  const [t] = await db.select().from(customerTrackings).where(eq(customerTrackings.id, Number(trackingId)));
  if (!t) return null;
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, Number(t.businessId)));
  const items = Array.isArray(t.items) ? (t.items as any[]) : [];
  const lines: PdfLine[] = [
    { text: `Order ${t.trackingCode}`, size: 12, bold: true, gapAfter: 8 },
    { text: `Customer: ${t.customerName}${t.customerPhone ? ` · ${t.customerPhone}` : ""}`, size: 10, gapAfter: 2 },
    { text: `Deliver to: ${t.destinationAddress || "—"}`, size: 10, gapAfter: 8 },
    { text: "Items", size: 11, bold: true, gapAfter: 4 },
  ];
  for (const li of items.slice(0, 30)) {
    lines.push({
      text: `  ${li.description || li.name || "Item"} x ${li.quantity || 1} — ${ghs(li.total ?? (Number(li.quantity) || 1) * (Number(li.unitPrice) || 0))}`,
      size: 10,
      gapAfter: 1,
    });
  }
  if (!items.length) lines.push({ text: "  (no itemised lines recorded)", size: 10, gapAfter: 4 });
  lines.push(
    { text: `Total: ${ghs(t.totalGhs)}`, size: 11, bold: true, gapAfter: 8 },
    { text: `Fulfilment: ${String(t.fulfillmentType || "PICKUP")}${t.driverName ? ` · driver ${t.driverName}` : ""}${t.vehicleNote ? ` · ${t.vehicleNote}` : ""}`, size: 10, gapAfter: 2 },
    { text: `Status: ${t.status}`, size: 10, gapAfter: 10 },
    { text: `Received by (name): ______________________   Signature: ______________   Date: ____________`, size: 10, gapAfter: 6 },
    { text: `Delivery note generated by ${actor.name || "Staff"} (${actor.role || "STAFF"}) on ${new Date().toLocaleString("en-GB")}.`, size: 8 },
  );
  const pdf = buildTextPdf(
    "Delivery Note",
    `${biz?.name || "GoMina 360"} · ${biz?.code || t.branchCode || ""}`,
    lines,
  );
  return {
    fileData: pdfDataUrl(pdf),
    title: `Delivery note — ${t.trackingCode} (${t.customerName})`,
    fileName: `delivery-note-${t.trackingCode}.pdf`,
    docType: "DELIVERY_NOTE",
    relatedType: "SALE_DOCUMENT",
    relatedId: t.saleDocumentId != null ? Number(t.saleDocumentId) : null,
    issuedOn: new Date().toLocaleDateString("en-CA"),
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Expiry sweep — 30 / 7 / 0-day warnings, each window fires once.
 * ──────────────────────────────────────────────────────────────────────── */

export interface DocExpiryHit {
  documentId: number;
  title: string;
  daysLeft: number;
  window: "30" | "7" | "0";
  notified: number;
}

async function notifyDocExpiry(doc: any, daysLeft: number, window: "30" | "7" | "0") {
  const { notifications } = await import("@/db/schema");
  const { and } = await import("drizzle-orm");
  const recipients = await orderNotificationRecipients(Number(doc.businessId));
  const urgent = window === "0";
  const titles: Record<string, string> = {
    "30": `"${doc.title}" expires in about a month`,
    "7": `"${doc.title}" expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
    "0": `"${doc.title}" expires TODAY`,
  };
  for (const u of recipients) {
    // Per-user, per-window dedupe: even if the global marker is missing
    // (e.g. a crash mid-sweep), nobody's bell gets the same warning twice.
    const dupes = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, Number(u.id)), eq(notifications.recordRef, `doc-expiry:${doc.id}:${window}`)))
      .limit(1);
    if (dupes.length) continue;
    await db.insert(notifications).values({
      userId: Number(u.id),
      type: "DOCUMENT_EXPIRY",
      title: titles[window],
      body: urgent
        ? `The document "${doc.title}" (${doc.docType}) expires today (${doc.expiresOn}). Renew it now or the unit falls out of compliance.`
        : `The document "${doc.title}" (${doc.docType}) expires on ${doc.expiresOn} — ${daysLeft} day${daysLeft === 1 ? "" : "s"} left. Start the renewal.`,
      recordType: "documents",
      recordId: Number(doc.id),
      recordRef: `doc-expiry:${doc.id}:${window}`,
      businessId: Number(doc.businessId),
      branchCode: doc.branchCode ?? null,
      actorName: "Document expiry sweep",
      priority: urgent ? "URGENT" : null,
      ownerId: (await ownerOrgOfBusiness(Number(doc.businessId))) ?? null,
    });
  }
}

export async function sweepDocumentExpiry(opts?: { today?: string }): Promise<DocExpiryHit[]> {
  const today = opts?.today || new Date().toLocaleDateString("en-CA");
  const rows = await db.select().from(businessDocuments);
  const hits: DocExpiryHit[] = [];
  const todayMs = new Date(today).getTime();
  for (const doc of rows) {
    if (!doc.expiresOn) continue;
    const daysLeft = Math.ceil((new Date(String(doc.expiresOn)).getTime() - todayMs) / 86400000);
    const window: "30" | "7" | "0" | null = daysLeft <= 0 ? "0" : daysLeft <= 7 ? "7" : daysLeft <= 30 ? "30" : null;
    if (!window) continue;
    const markerKey = `doc-expiry:${doc.id}:${window}`;
    if ((await getSystemMarker(markerKey)) != null) continue;
    await notifyDocExpiry(doc, Math.max(0, daysLeft), window);
    await setSystemMarker(markerKey, `${window}@${today}`);
    hits.push({ documentId: Number(doc.id), title: String(doc.title), daysLeft: Math.max(0, daysLeft), window, notified: 1 });
  }
  return hits;
}
