import { formatMoney } from './currency';
import { CurrencyCode } from './currency';
import QRCode from 'qrcode';

export interface AssetDownloadFilters {
  businessName?: string;
  branchCode?: string;
  branchName?: string;
  region?: string;
  district?: string;
  town?: string;
  assetType?: string;
}

export interface AssetDownloadData {
  downloadId: string;
  format: 'EXCEL' | 'PDF' | 'CSV';
  assets: any[];
  downloaderName: string;
  downloaderRole: string;
  downloaderBusinessId?: number;
  downloaderBranchCode?: string;
  downloaderBranchName?: string;
  currency: CurrencyCode;
  filters?: AssetDownloadFilters;
  logo?: string | null; // resolved business/company logo for the report header
}

export interface AssetDownloadResult {
  downloadId: string;
  qrCodeData: string;
  qrCodePayload: {
    downloadId: string;
    format: string;
    downloaderName: string;
    downloaderRole: string;
    timestamp: string;
    businessId?: number;
    branchCode?: string;
    branchName?: string;
    recordCount: number;
  };
  fileData: Blob | string;
  fileName: string;
}

/**
 * Generate a unique download ID
 */
export function generateDownloadId(): string {
  const now = new Date();
  const year = now.getFullYear();
  const timestamp = now.getTime();
  return `DL-${year}-AST-${timestamp}`;
}

/**
 * Generate QR code as base64 data URL
 */
async function generateQRCode(payload: any): Promise<string> {
  try {
    const qrString = JSON.stringify(payload);
    const qrData = await QRCode.toDataURL(qrString, {
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
    return qrData;
  } catch (error) {
    console.error('QR code generation failed:', error);
    throw new Error('Failed to generate QR code');
  }
}

/**
 * Generate CSV file from assets
 */
function generateCSV(assets: any[], currency: CurrencyCode): string {
  const headers = [
    'Asset Code',
    'Name',
    'Description',
    'Type',
    'Business',
    'Branch Code',
    'Branch Name',
    'Region',
    'District',
    'Town',
    'Purchase Price',
    'Current Value',
    'Condition',
    'Location',
    'Next Maintenance',
    'Recorder Name',
    'Recorded At',
    'Image Count'
  ];

  const rows = assets.map(asset => [
    asset.assetCode || '',
    asset.name || '',
    asset.description || '',
    asset.assetType || '',
    asset.businessName || '',
    asset.branchCode || '',
    asset.branchName || '',
    asset.region || '',
    asset.district || '',
    asset.town || '',
    formatMoney(asset.purchasePriceGhs || 0, currency),
    formatMoney(asset.currentValueGhs || 0, currency),
    asset.condition || '',
    asset.location || '',
    asset.nextMaintenanceDate || '',
    asset.recorderName || '',
    asset.recordedAt ? new Date(asset.recordedAt).toLocaleString() : '',
    (asset.assetImages || []).length.toString()
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
  ].join('\n');

  return '\uFEFF' + csvContent; // Add BOM for UTF-8
}

/**
 * Generate Excel file from assets
 */
async function generateExcel(assets: any[], currency: CurrencyCode): Promise<Blob> {
  const XLSX = await import('xlsx');

  const headers = [
    'Asset Code',
    'Name',
    'Type',
    'Business',
    'Branch Code',
    'Branch Name',
    'Region',
    'District',
    'Town',
    'Purchase Price',
    'Current Value',
    'Condition',
    'Location',
    'Next Maintenance',
    'Recorder Name',
    'Recorded At',
    'Image Count'
  ];

  const rows = assets.map(asset => [
    asset.assetCode || '',
    asset.name || '',
    asset.description || '',
    asset.assetType || '',
    asset.businessName || '',
    asset.branchCode || '',
    asset.branchName || '',
    asset.region || '',
    asset.district || '',
    asset.town || '',
    formatMoney(asset.purchasePriceGhs || 0, currency),
    formatMoney(asset.currentValueGhs || 0, currency),
    asset.condition || '',
    asset.location || '',
    asset.nextMaintenanceDate || '',
    asset.recorderName || '',
    asset.recordedAt ? new Date(asset.recordedAt).toLocaleString() : '',
    (asset.assetImages || []).length
  ]);

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Assets');

  const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/**
 * Generate PDF file from assets — includes Download ID, QR code, and downloader details
 */
async function generatePDF(
  assets: any[],
  currency: CurrencyCode,
  downloadId: string,
  qrCodeData: string,
  downloaderInfo: {
    downloaderName: string;
    downloaderRole: string;
    downloaderBusinessId?: number;
    downloaderBranchCode?: string;
    downloaderBranchName?: string;
  },
  filters?: AssetDownloadFilters,
  logo?: string | null
): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF();
  const now = new Date();
  const pageW = doc.internal.pageSize.getWidth();

  // ── Brand header band ──
  doc.setFillColor(16, 185, 129); // emerald-500
  doc.rect(0, 0, pageW, 18, 'F');
  let headX = 14;
  if (logo) {
    try {
      const props = doc.getImageProperties(logo);
      const scale = Math.min(12 / props.width, 12 / props.height);
      const w = props.width * scale;
      const h = props.height * scale;
      doc.setFillColor(255, 255, 255);
      doc.roundedRect(13, 3, w + 2, h + 2, 1.2, 1.2, 'F');
      doc.addImage(logo, props.fileType || 'JPEG', 14, 4, w, h);
      headX = 14 + w + 6;
    } catch { /* logo is best-effort */ }
    doc.setFillColor(16, 185, 129); // restore band color for later use
  }
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('GoMina 360 — Enterprise Asset Register Report', headX, 12);
  doc.setFontSize(9);
  doc.text('Confidential Business Document', pageW - 14, 12, { align: 'right' });

  // ── Embedded QR code image ──
  let yPos = 24;
  if (qrCodeData) {
    try {
      // qrCodeData is a data URL like "data:image/png;base64,ABCD..."
      // Strip the prefix to get the raw base64
      const base64 = qrCodeData.split(',')[1];
      if (base64) {
        doc.addImage(base64, 'PNG', 14, yPos, 28, 28);
      }
    } catch {
      // If image embedding fails, render text placeholder
      doc.setFontSize(8);
      doc.text('[QR Code: scan for download verification]', 14, yPos + 14);
    }
  }

  // ── Download ID + Metadata column (right of QR) ──
  const metaX = qrCodeData ? 48 : 14;
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('Download ID:', metaX, yPos + 4);
  doc.setFont('helvetica', 'normal');
  doc.text(downloadId, metaX + 30, yPos + 4);

  doc.setFont('helvetica', 'bold');
  doc.text('Generated:', metaX, yPos + 10);
  doc.setFont('helvetica', 'normal');
  doc.text(now.toLocaleString(), metaX + 22, yPos + 10);

  doc.setFont('helvetica', 'bold');
  doc.text('Asset Count:', metaX, yPos + 16);
  doc.setFont('helvetica', 'normal');
  doc.text(String(assets.length), metaX + 24, yPos + 16);

  doc.setFont('helvetica', 'bold');
  doc.text('Currency:', metaX, yPos + 22);
  doc.setFont('helvetica', 'normal');
  doc.text(currency, metaX + 20, yPos + 22);

  // ── Downloader Information ──
  yPos += 32;
  doc.setFillColor(241, 245, 249); // slate-100
  doc.rect(14, yPos, pageW - 28, 24, 'F');
  doc.setDrawColor(203, 213, 225); // slate-300
  doc.rect(14, yPos, pageW - 28, 24, 'S');

  const dlY = yPos + 6;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text('DOWNLOADER INFORMATION', 18, dlY);

  doc.setFont('helvetica', 'normal');
  doc.text(`Name: ${downloaderInfo.downloaderName}`, 18, dlY + 6);
  doc.text(`Role: ${downloaderInfo.downloaderRole}`, 18, dlY + 12);
  doc.text(
    `Business: ${downloaderInfo.downloaderBusinessId || 'Enterprise-wide'}`,
    metaX + 30,
    dlY + 6
  );
  doc.text(
    `Branch: ${downloaderInfo.downloaderBranchName || downloaderInfo.downloaderBranchCode || 'All Branches'}`,
    metaX + 30,
    dlY + 12
  );

  yPos += 30;

  // ── Applied Filters (if any) ──
  const activeFilters: string[] = [];
  if (filters) {
    if (filters.businessName && filters.businessName !== 'All Businesses') {
      activeFilters.push(`Business: ${filters.businessName}`);
    }
    if (filters.branchCode && filters.branchCode !== 'ALL') {
      activeFilters.push(`Branch: ${filters.branchName || filters.branchCode}`);
    }
    if (filters.region && filters.region !== 'ALL') {
      activeFilters.push(`Region: ${filters.region}`);
    }
    if (filters.district) {
      activeFilters.push(`District/Town: ${filters.district}`);
    }
    if (filters.assetType && filters.assetType !== 'ALL') {
      activeFilters.push(`Asset Type: ${filters.assetType}`);
    }
  }

  if (activeFilters.length > 0) {
    doc.setFillColor(254, 243, 199); // amber-100
    doc.rect(14, yPos, pageW - 28, 10 + Math.ceil(activeFilters.length / 2) * 5, 'F');
    doc.setDrawColor(252, 211, 77); // amber-300
    doc.rect(14, yPos, pageW - 28, 10 + Math.ceil(activeFilters.length / 2) * 5, 'S');

    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text('APPLIED FILTERS:', 18, yPos + 6);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    const perRow = 2;
    activeFilters.forEach((f, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const fx = col === 0 ? 18 : pageW / 2 + 4;
      const fy = yPos + 12 + row * 5;
      doc.text(`• ${f}`, fx, fy);
    });

    yPos += 10 + Math.ceil(activeFilters.length / 2) * 5 + 4;
  }

  yPos += 4;

  // ── Asset Data Table ──
  const tableData = assets.map(asset => [
    asset.assetCode || '',
    asset.name || '',
    asset.description
      ? (asset.description.length > 40 ? asset.description.substring(0, 40) + '…' : asset.description)
      : '—',
    asset.assetType || '',
    asset.branchCode || '',
    formatMoney(asset.currentValueGhs || 0, currency),
    asset.condition || '',
    asset.recorderName || '',
    asset.recordedAt ? new Date(asset.recordedAt).toLocaleDateString() : ''
  ]);

  const totalValue = assets.reduce((acc: number, a: any) => acc + (a.currentValueGhs || 0), 0);

  autoTable(doc, {
    startY: yPos,
    head: [['Code', 'Name', 'Description', 'Type', 'Branch', 'Value', 'Condition', 'Recorder', 'Date']],
    body: tableData,
    theme: 'striped',
    headStyles: { fillColor: [16, 185, 129], fontStyle: 'bold', fontSize: 7 },
    bodyStyles: { fontSize: 7 },
    styles: { cellPadding: 2 },
    margin: { left: 14, right: 14 }
  });

  // ── Summary row at bottom of table ──
  const afterTableY = (doc as any).lastAutoTable?.finalY || yPos + 10;
  doc.setFillColor(16, 185, 129);
  doc.rect(14, afterTableY + 2, pageW - 28, 8, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text(`TOTAL ASSETS: ${assets.length}`, 18, afterTableY + 7.5);
  doc.text(
    `TOTAL CURRENT VALUE: ${formatMoney(totalValue, currency)}`,
    pageW - 18,
    afterTableY + 7.5,
    { align: 'right' }
  );

  // ── Footer ──
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setTextColor(120, 120, 120);
    doc.setFontSize(7);
    doc.text(
      `GoMina 360 Enterprise — Download ID: ${downloadId} — Page ${i} of ${pageCount}`,
      14,
      doc.internal.pageSize.height - 6
    );
    doc.text(
      `Downloader: ${downloaderInfo.downloaderName} (${downloaderInfo.downloaderRole})`,
      pageW - 14,
      doc.internal.pageSize.height - 6,
      { align: 'right' }
    );
  }

  const pdfBlob = doc.output('blob');
  return pdfBlob;
}

/**
 * Generate asset download in specified format
 */
export async function generateAssetDownload(data: AssetDownloadData): Promise<AssetDownloadResult> {
  const { downloadId, format, assets, downloaderName, downloaderRole, downloaderBusinessId, downloaderBranchCode, downloaderBranchName, currency } = data;

  // Create QR code payload including filter metadata
  const qrCodePayload = {
    downloadId,
    format,
    downloaderName,
    downloaderRole,
    timestamp: new Date().toISOString(),
    businessId: downloaderBusinessId,
    branchCode: downloaderBranchCode,
    branchName: downloaderBranchName,
    recordCount: assets.length,
    filters: data.filters || {},
  };

  // Generate QR code
  const qrCodeData = await generateQRCode(qrCodePayload);

  // Generate file based on format
  let fileData: Blob | string;
  let fileName: string;
  const timestamp = new Date().toISOString().split('T')[0];

  switch (format) {
    case 'CSV':
      fileData = generateCSV(assets, currency);
      fileName = `assets-${downloadId}-${timestamp}.csv`;
      break;
    case 'EXCEL':
      fileData = await generateExcel(assets, currency);
      fileName = `assets-${downloadId}-${timestamp}.xlsx`;
      break;
    case 'PDF':
      fileData = await generatePDF(
        assets,
        currency,
        downloadId,
        qrCodeData,
        {
          downloaderName,
          downloaderRole,
          downloaderBusinessId,
          downloaderBranchCode,
          downloaderBranchName,
        },
        data.filters,
        data.logo
      );
      fileName = `assets-${downloadId}-${timestamp}.pdf`;
      break;
    default:
      throw new Error(`Unsupported format: ${format}`);
  }

  return {
    downloadId,
    qrCodeData,
    qrCodePayload,
    fileData,
    fileName
  };
}

/**
 * Trigger browser download of file
 */
export function downloadFile(fileData: Blob | string, fileName: string) {
  const blob = typeof fileData === 'string' 
    ? new Blob([fileData], { type: 'text/csv;charset=utf-8;' })
    : fileData;
  
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
