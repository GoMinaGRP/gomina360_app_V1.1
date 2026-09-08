import { formatMoney, CurrencyCode } from './currency';
import { COMPANY_INFO, companyAddressBlock } from './companyInfo';
import { resolveLogo } from './logos';
import QRCode from 'qrcode';

export interface SalesDocumentData {
  document: any;
  businessInfo?: any;
  currency: CurrencyCode;
}

/**
 * Trigger browser download of file
 */
export function downloadFile(fileData: Blob, fileName: string) {
  const url = URL.createObjectURL(fileData);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Build the QR code payload that gets embedded on every document.
 */
function buildQRPayload(document: any, businessInfo?: any) {
  return {
    company: COMPANY_INFO.name,
    companyReg: COMPANY_INFO.registrationNumber,
    companyTIN: COMPANY_INFO.taxId,
    documentId: document.documentNumber,
    documentType: document.documentType, // INVOICE, QUOTATION, RECEIPT
    issuerName: document.createdByName || 'Unknown Issuer',
    issuerRole: document.createdByRole || 'Staff',
    business: document.branchName || businessInfo?.name || '',
    branch: document.branchCode || businessInfo?.code || '',
    issuedAt: document.createdAt
      ? new Date(document.createdAt).toISOString()
      : new Date().toISOString(),
    customer: document.customerName || '',
    total: document.totalGhs || 0,
    currency: document.currency || 'GHS',
    status: document.status || 'DRAFT',
    verifyUrl: `${COMPANY_INFO.website}/verify/${document.documentNumber}`,
  };
}

/**
 * Generate QR code as base64 data URL for embedding in PDFs.
 */
async function generateQRCode(payload: any): Promise<string> {
  return QRCode.toDataURL(JSON.stringify(payload), {
    width: 280,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
    errorCorrectionLevel: 'M',
  });
}

/**
 * Generate PDF for invoice / quotation / receipt.
 *
 * Includes:
 * - Company information header
 * - Business and branch details
 * - Issuer name and role
 * - Unique document ID
 * - Customer bill-to block
 * - Line items table
 * - Totals (subtotal, tax, discount, total)
 * - Embedded QR code for verification / audit
 * - Footer with company details on every page
 */
export async function generateSalesDocumentPDF(data: SalesDocumentData): Promise<Blob> {
  const { document, businessInfo, currency } = data;
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF();
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const now = new Date();

  // Document type styling
  const styleMap: Record<string, { color: [number, number, number]; label: string }> = {
    INVOICE: { color: [16, 185, 129], label: 'INVOICE' },
    QUOTATION: { color: [59, 130, 246], label: 'QUOTATION' },
    RECEIPT: { color: [168, 85, 247], label: 'RECEIPT' },
  };
  const style = styleMap[document.documentType] || styleMap.INVOICE;

  // ── Generate QR code ──
  const qrPayload = buildQRPayload(document, businessInfo);
  let qrBase64 = '';
  try {
    const qrDataUrl = await generateQRCode(qrPayload);
    qrBase64 = qrDataUrl.split(',')[1] || '';
  } catch { /* QR generation is best-effort */ }

  // ─────────────────────────────────────────────────────────────────
  //  PAGE 1 HEADER
  // ─────────────────────────────────────────────────────────────────

  // Top colored band
  doc.setFillColor(...style.color);
  doc.rect(0, 0, pageW, 8, 'F');

  // ── Logo: branch logo → business logo → company logo (automatic per
  //     the record's business + branch) ──
  let textX = 14;
  const logo = resolveLogo(businessInfo as any, document.branchCode);
  if (logo) {
    try {
      const props = doc.getImageProperties(logo);
      const boxW = 26, boxH = 18;
      const scale = Math.min(boxW / props.width, boxH / props.height);
      const w = props.width * scale;
      const h = props.height * scale;
      doc.addImage(logo, props.fileType || 'JPEG', 14, 11, w, h);
      textX = 14 + w + 5;
    } catch { /* a corrupt image never blocks document generation */ }
  }

  // ── Company information block ──
  let y = 14;
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text(COMPANY_INFO.name, textX, y);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);
  y += 5;
  doc.text(COMPANY_INFO.tagline, textX, y);
  y += 4;
  doc.text(`${COMPANY_INFO.address}, ${COMPANY_INFO.city}, ${COMPANY_INFO.region} — ${COMPANY_INFO.country}`, textX, y);
  y += 4;
  doc.text(`Tel: ${COMPANY_INFO.phone}  |  Email: ${COMPANY_INFO.email}  |  Web: ${COMPANY_INFO.website}`, textX, y);
  y += 4;
  doc.text(`Reg: ${COMPANY_INFO.registrationNumber}  |  TIN: ${COMPANY_INFO.taxId}`, textX, y);

  // ── Document type badge (top right) ──
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...style.color);
  doc.text(style.label, pageW - 14, 16, { align: 'right' });

  // Document number + date (right column)
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0, 0, 0);
  doc.text(`Document #: ${document.documentNumber}`, pageW - 14, 23, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  const createdDate = document.createdAt
    ? new Date(document.createdAt)
    : now;
  doc.text(`Date: ${createdDate.toLocaleDateString()} ${createdDate.toLocaleTimeString()}`, pageW - 14, 28, { align: 'right' });
  if (document.dueDate) {
    doc.text(`Due Date: ${document.dueDate}`, pageW - 14, 33, { align: 'right' });
  }
  if (document.validUntil) {
    doc.text(`Valid Until: ${document.validUntil}`, pageW - 14, 33, { align: 'right' });
  }
  doc.setFont('helvetica', 'bold');
  doc.text(`Status: ${document.status || 'DRAFT'}`, pageW - 14, 38, { align: 'right' });

  // ── Divider ──
  y += 3;
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.3);
  doc.line(14, y, pageW - 14, y);
  y += 4;

  // ── Business / Branch + Issuer ──
  doc.setFillColor(248, 250, 252); // slate-50
  doc.rect(14, y, pageW - 28, 20, 'F');
  doc.setDrawColor(226, 232, 240); // slate-200
  doc.rect(14, y, pageW - 28, 20, 'S');

  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0, 0, 0);
  doc.text('FROM / BUSINESS:', 18, y + 5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(document.branchName || businessInfo?.name || 'Business Branch', 18, y + 10);
  doc.setFontSize(8);
  const branchLine = [document.branchCode || businessInfo?.code || ''].filter(Boolean).join('');
  doc.text(branchLine, 18, y + 15);

  // Issuer info (right column of the box)
  const issuerX = pageW / 2 + 10;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text('ISSUED BY:', issuerX, y + 5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(document.createdByName || 'Staff', issuerX, y + 10);
  doc.setFontSize(8);
  doc.text(`Role: ${document.createdByRole || 'Staff'}`, issuerX, y + 15);

  y += 25;

  // ── Customer info box ──
  doc.setFillColor(241, 245, 249); // slate-100
  doc.rect(14, y, pageW - 28, 25, 'F');
  doc.setDrawColor(203, 213, 225);
  doc.rect(14, y, pageW - 28, 25, 'S');

  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text('BILL TO:', 18, y + 5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(document.customerName || 'Customer', 18, y + 11);
  doc.setFontSize(8);
  if (document.customerPhone) doc.text(document.customerPhone, 18, y + 16);
  if (document.customerEmail) doc.text(document.customerEmail, 18, y + 20);
  if (document.customerAddress) doc.text(String(document.customerAddress).substring(0, 70), 18, y + 24);

  y += 30;

  // ── Line items table ──
  const items = Array.isArray(document.lineItems) ? document.lineItems : [];
  const tableRows = items.map((item: any) => [
    item.description || '',
    String(item.quantity || 0),
    formatMoney(item.unitPrice || 0, currency),
    formatMoney(item.total || (item.quantity || 0) * (item.unitPrice || 0), currency),
  ]);

  autoTable(doc, {
    startY: y,
    head: [['Description', 'Qty', 'Unit Price', 'Amount']],
    body: tableRows,
    theme: 'striped',
    headStyles: { fillColor: style.color, fontStyle: 'bold', fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    styles: { cellPadding: 3 },
    columnStyles: {
      0: { cellWidth: 90 },
      1: { halign: 'center', cellWidth: 20 },
      2: { halign: 'right', cellWidth: 35 },
      3: { halign: 'right', cellWidth: 35 },
    },
    margin: { left: 14, right: 14 },
  });

  // ── Totals block ──
  const afterY = (doc as any).lastAutoTable?.finalY || y + 20;
  let totalsY = afterY + 5;
  const totalsX = pageW - 80;
  const rightX = pageW - 14;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0, 0, 0);
  doc.text('Subtotal:', totalsX, totalsY);
  doc.text(formatMoney(document.subtotalGhs || 0, currency), rightX, totalsY, { align: 'right' });

  if (document.discountGhs && document.discountGhs > 0) {
    totalsY += 5;
    doc.text('Discount:', totalsX, totalsY);
    doc.text(`- ${formatMoney(document.discountGhs, currency)}`, rightX, totalsY, { align: 'right' });
  }
  if (document.taxRateGhs && document.taxRateGhs > 0) {
    totalsY += 5;
    doc.text(`Tax (${document.taxRateGhs}%):`, totalsX, totalsY);
    doc.text(formatMoney(document.taxAmountGhs || 0, currency), rightX, totalsY, { align: 'right' });
  }
  totalsY += 3;
  doc.setDrawColor(...style.color);
  doc.setLineWidth(0.5);
  doc.line(totalsX, totalsY, rightX, totalsY);
  totalsY += 6;
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('TOTAL:', totalsX, totalsY);
  doc.text(formatMoney(document.totalGhs || 0, currency), rightX, totalsY, { align: 'right' });

  // ── Payment / Notes / Terms ──
  let infoY = totalsY + 12;

  if (document.paymentMethod) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text('Payment Method:', 14, infoY);
    doc.setFont('helvetica', 'normal');
    doc.text(String(document.paymentMethod).replace(/_/g, ' '), 45, infoY);
    infoY += 6;
  }

  if (document.notes) {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text('NOTES:', 14, infoY);
    doc.setFont('helvetica', 'normal');
    const noteLines = doc.splitTextToSize(document.notes, pageW / 2 - 14);
    doc.text(noteLines, 14, infoY + 4);
    infoY += 4 + noteLines.length * 4;
  }

  if (document.terms) {
    infoY += 2;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text('TERMS & CONDITIONS:', 14, infoY);
    doc.setFont('helvetica', 'normal');
    const termLines = doc.splitTextToSize(document.terms, pageW / 2 - 14);
    doc.text(termLines, 14, infoY + 4);
    infoY += 4 + termLines.length * 4;
  }

  // ─────────────────────────────────────────────────────────────────
  //  QR CODE — bottom-right of the content area, above the footer
  // ─────────────────────────────────────────────────────────────────
  const qrSize = 38;
  // Place QR near the totals / info block on the right side
  const qrX = pageW - 14 - qrSize;
  const qrY = Math.max(infoY - qrSize - 2, totalsY + 12);

  if (qrBase64) {
    try {
      doc.addImage(qrBase64, 'PNG', qrX, qrY, qrSize, qrSize);
    } catch { /* best effort */ }
  }

  // QR label
  doc.setFontSize(6);
  doc.setTextColor(130, 130, 130);
  doc.text('Scan QR for verification', qrX + qrSize / 2, qrY + qrSize + 3, { align: 'center' });

  // ── "Thank you" line ──
  const thankY = Math.max(qrY + qrSize + 8, infoY + 8);
  if (thankY < pageH - 30) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(100, 100, 100);
    doc.text('Thank you for your patronage!', pageW / 2, thankY, { align: 'center' });
  }

  // ─────────────────────────────────────────────────────────────────
  //  FOOTER — company details on every page
  // ─────────────────────────────────────────────────────────────────
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);

    // Footer divider
    doc.setDrawColor(200, 200, 200);
    doc.setLineWidth(0.2);
    doc.line(14, pageH - 18, pageW - 14, pageH - 18);

    doc.setTextColor(120, 120, 120);
    doc.setFontSize(6);
    doc.setFont('helvetica', 'normal');

    // Line 1: Company + reg
    doc.text(
      `${COMPANY_INFO.name}  |  Reg: ${COMPANY_INFO.registrationNumber}  |  TIN: ${COMPANY_INFO.taxId}`,
      14,
      pageH - 14,
    );
    // Line 2: Contact
    doc.text(
      `${COMPANY_INFO.address}, ${COMPANY_INFO.city}  |  Tel: ${COMPANY_INFO.phone}  |  ${COMPANY_INFO.email}  |  ${COMPANY_INFO.website}`,
      14,
      pageH - 10,
    );
    // Line 3: Document meta
    doc.text(
      `${style.label} ${document.documentNumber}  |  Issued by: ${document.createdByName || 'Staff'} (${document.createdByRole || 'Staff'})  |  Generated: ${now.toLocaleString()}`,
      14,
      pageH - 6,
    );
    // Page number
    doc.text(
      `Page ${i} of ${pageCount}`,
      pageW - 14,
      pageH - 6,
      { align: 'right' },
    );
  }

  return doc.output('blob');
}

/**
 * Print document via browser (opens print dialog)
 */
export async function printSalesDocument(data: SalesDocumentData) {
  const blob = await generateSalesDocumentPDF(data);
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank');
  if (w) {
    w.onload = () => {
      setTimeout(() => {
        w.print();
      }, 300);
    };
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
