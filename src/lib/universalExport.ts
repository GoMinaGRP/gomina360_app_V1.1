import QRCode from "qrcode";
import { COMPANY_INFO } from "./companyInfo";

export type UniversalExportFormat = "PDF" | "EXCEL" | "CSV";
export type UniversalExportType = "DASHBOARD" | "REPORT";

export interface UniversalExportMeta {
  exportId: string;
  moduleKey: string;
  moduleLabel: string;
  exportType: UniversalExportType;
  format: UniversalExportFormat;
  exportedAt: string;
  userId: number;
  userName: string;
  userRole: string;
  businessId?: number | null;
  businessName?: string | null;
  branchCode?: string | null;
  branchName?: string | null;
  logo?: string | null; // resolved business/branch/company logo (data URL)
  filters?: Record<string, any>;
  recordCount: number;
}

export interface UniversalExportResult {
  blob: Blob;
  fileName: string;
  qrCodeData: string;
  qrCodeSvg: string;
  qrPayload: Record<string, any>;
}

export function generateUniversalExportId(moduleKey: string) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const token = `${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
  const mod = moduleKey.replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase() || "MODULE";
  return `EXP-${date}-${mod}-${token}`;
}

function printable(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function flattenRecord(record: any, prefix = "", result: Record<string, string> = {}) {
  Object.entries(record || {}).forEach(([key, value]) => {
    const outKey = prefix ? `${prefix}.${key}` : key;
    // Do not inject megabytes of base64 receipt/asset imagery into tabular rows.
    if (/image|qrCodeData/i.test(key) && typeof value === "string" && value.startsWith("data:")) {
      result[outKey] = "[1 attached image]";
    } else if (/images/i.test(key) && Array.isArray(value)) {
      result[outKey] = `[${value.length} attached image${value.length === 1 ? "" : "s"}]`;
    } else if (value === null || value === undefined) {
      result[outKey] = "";
    } else if (Array.isArray(value)) {
      result[outKey] = JSON.stringify(value);
    } else if (typeof value === "object" && !(value instanceof Date)) {
      flattenRecord(value, outKey, result);
    } else {
      result[outKey] = printable(value);
    }
  });
  return result;
}

function normalizedRows(records: any[]) {
  const flat = records.map((r) => flattenRecord(r));
  const headers = Array.from(new Set(flat.flatMap((r) => Object.keys(r))));
  return { headers, rows: flat.map((r) => headers.map((h) => r[h] || "")) };
}

function metaRows(meta: UniversalExportMeta) {
  const filters = Object.entries(meta.filters || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== "ALL")
    .map(([k, v]) => `${k}: ${printable(v)}`)
    .join("; ");
  return [
    ["Export ID", meta.exportId],
    ["Module", meta.moduleLabel],
    ["Export Type", meta.exportType],
    ["Format", meta.format],
    ["Export Date & Time", new Date(meta.exportedAt).toLocaleString()],
    ["Exported By", meta.userName],
    ["User Role", meta.userRole],
    ["Business", meta.businessName || "All permitted businesses"],
    ["Branch Code", meta.branchCode || "All permitted branches"],
    ["Branch", meta.branchName || "All permitted branches"],
    ["Filters", filters || "None"],
    ["Record Count", String(meta.recordCount)],
    ["Company", COMPANY_INFO.name],
    ["Company Registration", COMPANY_INFO.registrationNumber],
  ];
}

function safeFilePart(input: string) {
  return input.replace(/[^a-z0-9_-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

async function generatePdf(records: any[], meta: UniversalExportMeta, qrData: string) {
  const { default: jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageW, 22, "F");
  doc.setTextColor(255, 255, 255);
  let headX = 12;
  if (meta.logo) {
    try {
      const props = doc.getImageProperties(meta.logo);
      const scale = Math.min(15 / props.width, 15 / props.height);
      const w = props.width * scale;
      const h = props.height * scale;
      doc.setFillColor(255, 255, 255);
      doc.roundedRect(11, 3.5, w + 2, h + 2, 1.2, 1.2, "F");
      doc.addImage(meta.logo, props.fileType || "JPEG", 12, 4.5, w, h);
      headX = 12 + w + 6;
    } catch { /* logo is best-effort, never blocks the export */ }
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("GoMina 360", headX, 10);
  doc.setFontSize(11);
  doc.text(`${meta.moduleLabel} — ${meta.exportType === "DASHBOARD" ? "Dashboard Summary" : "Detailed Report"}`, headX, 17);
  doc.setFontSize(8);
  doc.text(`Export ID: ${meta.exportId}`, pageW - 12, 9, { align: "right" });
  doc.text(`Generated: ${new Date(meta.exportedAt).toLocaleString()}`, pageW - 12, 15, { align: "right" });

  try {
    doc.addImage(qrData, "PNG", pageW - 38, 25, 26, 26);
  } catch {}

  doc.setTextColor(15, 23, 42);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  const details = metaRows(meta).slice(0, 12);
  let y = 28;
  details.forEach(([label, value], index) => {
    if (index >= 8) return;
    const col = index >= 4 ? 1 : 0;
    const row = index % 4;
    const x = col === 0 ? 12 : 108;
    const yy = 28 + row * 5;
    doc.setFont("helvetica", "bold");
    doc.text(`${label}:`, x, yy);
    doc.setFont("helvetica", "normal");
    doc.text(String(value).slice(0, 70), x + 25, yy);
    y = Math.max(y, yy);
  });

  doc.setFontSize(6.5);
  doc.text("Scan QR to verify exporter, scope, module, date/time and Export ID.", pageW - 45, 55);

  const { headers, rows } = normalizedRows(records);
  const visibleHeaders = headers.slice(0, 12);
  const visibleRows = rows.map((row) => row.slice(0, 12));
  autoTable(doc, {
    startY: Math.max(58, y + 8),
    head: [visibleHeaders.length ? visibleHeaders : ["Message"]],
    body: visibleRows.length ? visibleRows : [["No records available for selected scope"]],
    theme: "striped",
    headStyles: { fillColor: [16, 185, 129], textColor: 255, fontSize: 6.5 },
    bodyStyles: { fontSize: 6, overflow: "linebreak" },
    styles: { cellPadding: 1.5 },
    margin: { left: 10, right: 10, bottom: 15 },
  });

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(203, 213, 225);
    doc.line(10, pageH - 11, pageW - 10, pageH - 11);
    doc.setTextColor(100, 116, 139);
    doc.setFontSize(6.5);
    doc.text(`${COMPANY_INFO.name} | ${COMPANY_INFO.registrationNumber} | ${meta.exportId}`, 10, pageH - 6);
    doc.text(`Exported by ${meta.userName} (${meta.userRole}) | Page ${i}/${pages}`, pageW - 10, pageH - 6, { align: "right" });
  }
  return doc.output("blob");
}

async function generateExcel(records: any[], meta: UniversalExportMeta, qrData: string, qrPayload: any) {
  const imported = await import("exceljs");
  const ExcelJS: any = (imported as any).default || imported;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "GoMina 360";
  workbook.created = new Date(meta.exportedAt);

  const dataSheet = workbook.addWorksheet(meta.exportType === "DASHBOARD" ? "Dashboard" : "Report");
  const { headers, rows } = normalizedRows(records);
  dataSheet.addRow(headers.length ? headers : ["Message"]);
  rows.forEach((r) => dataSheet.addRow(r));
  if (!rows.length) dataSheet.addRow(["No records available for selected scope"]);
  dataSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  dataSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF10B981" } };
  dataSheet.views = [{ state: "frozen", ySplit: 1 }];
  dataSheet.columns.forEach((c: any) => { c.width = 20; });

  const verification = workbook.addWorksheet("Export Verification");
  metaRows(meta).forEach((r) => verification.addRow(r));
  verification.addRow(["QR Payload", JSON.stringify(qrPayload)]);
  verification.addRow(["QR Code Data URL", qrData]);
  verification.getColumn(1).width = 28;
  verification.getColumn(2).width = 90;
  verification.getColumn(1).font = { bold: true };

  try {
    const imageId = workbook.addImage({ base64: qrData, extension: "png" });
    verification.addImage(imageId, { tl: { col: 3, row: 1 }, ext: { width: 220, height: 220 } });
  } catch {}

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

async function generateCsv(records: any[], meta: UniversalExportMeta, qrData: string, qrSvg: string, qrPayload: any) {
  const { headers, rows } = normalizedRows(records);
  const quote = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines: string[] = [];
  lines.push(quote("GOMINA 360 EXPORT METADATA") + "," + quote("VALUE"));
  metaRows(meta).forEach(([k, v]) => lines.push(`${quote(k)},${quote(v)}`));
  lines.push(`${quote("QR Payload")},${quote(JSON.stringify(qrPayload))}`);
  lines.push(`${quote("QR Code Data URL")},${quote(qrData)}`);
  lines.push(`${quote("QR Code SVG")},${quote(qrSvg)}`);
  lines.push("");
  lines.push(headers.map(quote).join(","));
  rows.forEach((r) => lines.push(r.map(quote).join(",")));
  return new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
}

export async function generateUniversalExport(records: any[], meta: UniversalExportMeta): Promise<UniversalExportResult> {
  const qrPayload = {
    company: COMPANY_INFO.name,
    companyRegistration: COMPANY_INFO.registrationNumber,
    exportId: meta.exportId,
    module: meta.moduleLabel,
    exportType: meta.exportType,
    format: meta.format,
    exportedAt: meta.exportedAt,
    user: { id: meta.userId, name: meta.userName, role: meta.userRole },
    business: { id: meta.businessId || null, name: meta.businessName || null },
    branch: { code: meta.branchCode || null, name: meta.branchName || null },
    filters: meta.filters || {},
    recordCount: meta.recordCount,
    verification: `${COMPANY_INFO.website}/verify-export/${meta.exportId}`,
  };
  const qrCodeData = await QRCode.toDataURL(JSON.stringify(qrPayload), {
    width: 320,
    margin: 2,
    errorCorrectionLevel: "M",
  });
  const qrCodeSvg = await QRCode.toString(JSON.stringify(qrPayload), { type: "svg", margin: 1 });

  const blob = meta.format === "PDF"
    ? await generatePdf(records, meta, qrCodeData)
    : meta.format === "EXCEL"
    ? await generateExcel(records, meta, qrCodeData, qrPayload)
    : await generateCsv(records, meta, qrCodeData, qrCodeSvg, qrPayload);

  const ext = meta.format === "EXCEL" ? "xlsx" : meta.format.toLowerCase();
  const fileName = `${safeFilePart(meta.moduleLabel)}-${meta.exportType.toLowerCase()}-${meta.exportId}.${ext}`;
  return { blob, fileName, qrCodeData, qrCodeSvg, qrPayload };
}

export function triggerUniversalDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
