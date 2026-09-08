import { formatMoney, CurrencyCode } from './currency';
import QRCode from 'qrcode';

export interface InventoryDownloadFilters {
  businessName?: string;
  branchCode?: string;
  branchName?: string;
  region?: string;
  district?: string;
  inventoryType?: string;
}

export interface InventoryDownloadData {
  downloadId: string;
  format: 'EXCEL' | 'PDF' | 'CSV';
  inventory: any[];
  businesses: any[];
  downloaderName: string;
  downloaderRole: string;
  downloaderBusinessId?: number;
  downloaderBranchCode?: string;
  downloaderBranchName?: string;
  currency: CurrencyCode;
  filters?: InventoryDownloadFilters;
  logo?: string | null; // resolved business/company logo for the report header
}

export interface InventoryDownloadResult {
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
    filters: Record<string, string | undefined>;
  };
  fileData: Blob | string;
  fileName: string;
}

/**
 * Generate a unique download ID prefix for inventory
 */
export function generateInventoryDownloadId(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const timestamp = now.getTime();
  return `DL-INV-${year}${month}-${timestamp}`;
}

/**
 * Generate QR code as base64 data URL
 */
async function generateQRCode(payload: any): Promise<string> {
  const qrString = JSON.stringify(payload);
  return QRCode.toDataURL(qrString, {
    width: 300,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' }
  });
}

/**
 * Map inventory business IDs to branch locations for reporting
 */
function getBranchInfo(businessId: number | null, businesses: any[]) {
  if (!businessId) return { branchCode: '', branchName: '', region: '', district: '', town: '' };
  const biz = businesses.find(b => b.id === businessId);
  return {
    branchCode: biz?.code || '',
    branchName: biz?.name || '',
    region: biz?.region || '',
    district: biz?.district || '',
    town: biz?.town || ''
  };
}

/**
 * Generate CSV from inventory
 */
function generateCSV(
  inventory: any[],
  currency: CurrencyCode,
  businesses: any[]
): string {
  const headers = [
    'SKU',
    'Item Name',
    'Category',
    'Business',
    'Branch Code',
    'Branch Name',
    'Region',
    'District',
    'Town',
    'Quantity',
    'Unit',
    'Cost Price',
    'Selling Price',
    'Min Stock Threshold',
    'Stock Status',
    'Stock Value (Cost)',
    'Margin %'
  ];

  const rows = inventory.map(item => {
    const branch = getBranchInfo(item.businessId, businesses);
    const margin =
      item.costPriceGhs > 0
        ? ((item.sellingPriceGhs - item.costPriceGhs) / item.costPriceGhs * 100).toFixed(1)
        : '0';

    return [
      item.sku || '',
      item.name || '',
      item.category || '',
      branch.branchName,
      branch.branchCode,
      branch.branchName,
      branch.region,
      branch.district,
      branch.town,
      String(item.quantity || 0),
      item.unit || '',
      formatMoney(item.costPriceGhs || 0, currency),
      formatMoney(item.sellingPriceGhs || 0, currency),
      String(item.minStockThreshold || 0),
      item.status || '',
      formatMoney((item.costPriceGhs || 0) * (item.quantity || 0), currency),
      `+${margin}%`
    ];
  });

  const csvContent = [
    headers.join(','),
    ...rows.map(row =>
      row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
    )
  ].join('\n');

  return '\uFEFF' + csvContent;
}

/**
 * Generate Excel from inventory
 */
async function generateExcel(
  inventory: any[],
  currency: CurrencyCode,
  businesses: any[]
): Promise<Blob> {
  const XLSX = await import('xlsx');

  const headers = [
    'SKU',
    'Item Name',
    'Category',
    'Business',
    'Branch Code',
    'Branch Name',
    'Region',
    'District',
    'Town',
    'Quantity',
    'Unit',
    'Cost Price',
    'Selling Price',
    'Min Stock Threshold',
    'Stock Status',
    'Stock Value (Cost)',
    'Margin %'
  ];

  const rows = inventory.map(item => {
    const branch = getBranchInfo(item.businessId, businesses);
    const margin =
      item.costPriceGhs > 0
        ? ((item.sellingPriceGhs - item.costPriceGhs) / item.costPriceGhs * 100).toFixed(1)
        : '0';

    return [
      item.sku || '',
      item.name || '',
      item.category || '',
      branch.branchName,
      branch.branchCode,
      branch.branchName,
      branch.region,
      branch.district,
      branch.town,
      Number(item.quantity || 0),
      item.unit || '',
      formatMoney(item.costPriceGhs || 0, currency),
      formatMoney(item.sellingPriceGhs || 0, currency),
      Number(item.minStockThreshold || 0),
      item.status || '',
      formatMoney((item.costPriceGhs || 0) * (item.quantity || 0), currency),
      `+${margin}%`
    ];
  });

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Inventory');

  const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([excelBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}

/**
 * Generate PDF from inventory — includes Download ID, QR code, downloader info, and filters
 */
async function generatePDF(
  inventory: any[],
  currency: CurrencyCode,
  businesses: any[],
  downloadId: string,
  qrCodeData: string,
  downloaderInfo: {
    downloaderName: string;
    downloaderRole: string;
    downloaderBusinessId?: number;
    downloaderBranchCode?: string;
    downloaderBranchName?: string;
  },
  filters?: InventoryDownloadFilters,
  logo?: string | null
): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF();
  const now = new Date();
  const pageW = doc.internal.pageSize.getWidth();

  // ── Brand header band ──
  doc.setFillColor(6, 182, 212); // cyan-500
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
    doc.setFillColor(6, 182, 212);
  }
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('GoMina 360 — Enterprise Inventory & Stock Report', headX, 12);
  doc.setFontSize(9);
  doc.text('Confidential Business Document', pageW - 14, 12, { align: 'right' });

  // ── Embedded QR code image ──
  let yPos = 24;
  if (qrCodeData) {
    try {
      const base64 = qrCodeData.split(',')[1];
      if (base64) {
        doc.addImage(base64, 'PNG', 14, yPos, 28, 28);
      }
    } catch {
      doc.setFontSize(8);
      doc.text('[QR Code: scan for download verification]', 14, yPos + 14);
    }
  }

  // ── Download ID + Metadata ──
  const metaX = qrCodeData ? 48 : 14;
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('Download ID:', metaX, yPos + 4);
  doc.setFont('helvetica', 'normal');
  doc.text(downloadId, metaX + 25, yPos + 4);

  doc.setFont('helvetica', 'bold');
  doc.text('Generated:', metaX, yPos + 10);
  doc.setFont('helvetica', 'normal');
  doc.text(now.toLocaleString(), metaX + 20, yPos + 10);

  doc.setFont('helvetica', 'bold');
  doc.text('Item Count:', metaX, yPos + 16);
  doc.setFont('helvetica', 'normal');
  doc.text(String(inventory.length), metaX + 22, yPos + 16);

  doc.setFont('helvetica', 'bold');
  doc.text('Currency:', metaX, yPos + 22);
  doc.setFont('helvetica', 'normal');
  doc.text(currency, metaX + 19, yPos + 22);

  // ── Downloader Information ──
  yPos += 32;
  doc.setFillColor(235, 245, 255); // cyan-50
  doc.rect(14, yPos, pageW - 28, 25, 'F');
  doc.setDrawColor(165, 234, 223); // cyan-200
  doc.rect(14, yPos, pageW - 28, 25, 'S');

  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text('DOWNLOADER INFORMATION', 18, yPos + 6);

  doc.setFont('helvetica', 'normal');
  const dlY = yPos + 12;
  doc.text(`Name: ${downloaderInfo.downloaderName}`, 18, dlY);
  doc.text(`Role: ${downloaderInfo.downloaderRole}`, 18, dlY + 6);
  doc.text(
    `Business: ${downloaderInfo.downloaderBusinessId || 'Enterprise-wide'}`,
    90,
    dlY
  );
  doc.text(
    `Branch: ${downloaderInfo.downloaderBranchName || downloaderInfo.downloaderBranchCode || 'All Branches'}`,
    90,
    dlY + 6
  );

  yPos += 31;

  // ── Applied Filters ──
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
    if (filters.inventoryType && filters.inventoryType !== 'ALL') {
      activeFilters.push(`Inventory Type: ${filters.inventoryType}`);
    }
  }

  if (activeFilters.length > 0) {
    doc.setFillColor(255, 251, 235); // amber-50
    doc.rect(14, yPos, pageW - 28, 10 + Math.ceil(activeFilters.length / 2) * 5, 'F');
    doc.setDrawColor(252, 211, 77); // amber-300
    doc.rect(14, yPos, pageW - 28, 10 + Math.ceil(activeFilters.length / 2) * 5, 'S');

    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text('APPLIED FILTERS:', 18, yPos + 6);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    const perRow = 2;
    const boxX = pageW / 2 + 4;
    activeFilters.forEach((f, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const fx = col === 0 ? 18 : boxX;
      const fy = yPos + 12 + row * 5;
      doc.text(`• ${f}`, fx, fy);
    });

    yPos += 10 + Math.ceil(activeFilters.length / 2) * 5 + 4;
  }

  yPos += 4;

  // ── Inventory Data Table ──
  const tableData = inventory.map(item => {
    const branch = getBranchInfo(item.businessId, businesses);
    const margin =
      item.costPriceGhs > 0
        ? ((item.sellingPriceGhs - item.costPriceGhs) / item.costPriceGhs * 100).toFixed(1)
        : '0';

    return [
      item.sku || '',
      item.name || '',
      item.category || '',
      branch.branchName,
      branch.branchCode,
      `${Number(item.quantity || 0).toLocaleString()} ${item.unit || ''}`,
      formatMoney(item.costPriceGhs || 0, currency),
      formatMoney(item.sellingPriceGhs || 0, currency),
      `+${margin}%`,
      item.status || ''
    ];
  });

  const totalStockValue = inventory.reduce(
    (acc: number, item: any) => acc + (item.costPriceGhs || 0) * (item.quantity || 0),
    0
  );

  const totalItems = inventory.length;
  const inStockCount = inventory.filter((i: any) => i.status === 'IN_STOCK').length;
  const lowStockCount = inventory.filter((i: any) => i.status === 'LOW_STOCK').length;
  const outOfStockCount = inventory.filter((i: any) => i.status === 'OUT_OF_STOCK').length;

  autoTable(doc, {
    startY: yPos,
    head: [['SKU', 'Item', 'Category', 'Business', 'Branch', 'Qty', 'Cost Price', 'Selling Price', 'Margin', 'Status']],
    body: tableData,
    theme: 'striped',
    headStyles: { fillColor: [6, 182, 212], fontStyle: 'bold', fontSize: 7 },
    bodyStyles: { fontSize: 7 },
    styles: { cellPadding: 2 },
    margin: { left: 14, right: 14 }
  });

  // ── Summary row at bottom ──
  const afterTableY = (doc as any).lastAutoTable?.finalY || yPos + 10;
  doc.setFillColor(6, 182, 212);
  doc.rect(14, afterTableY + 2, pageW - 28, 8, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text(`TOTAL ITEMS: ${totalItems}`, 18, afterTableY + 7.5);
  doc.text(
    `STOCK VALUE: ${formatMoney(totalStockValue, currency)}  |  IN STOCK: ${inStockCount}  |  LOW: ${lowStockCount}  |  OUT: ${outOfStockCount}`,
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
 * Generate inventory download in specified format
 */
export async function generateInventoryDownload(data: InventoryDownloadData): Promise<InventoryDownloadResult> {
  const {
    downloadId,
    format,
    inventory,
    businesses,
    downloaderName,
    downloaderRole,
    downloaderBusinessId,
    downloaderBranchCode,
    downloaderBranchName,
    currency,
    filters
  } = data;

  // QR code payload with download details
  const qrCodePayload = {
    downloadId,
    format: String(format),
    downloaderName: String(downloaderName),
    downloaderRole: String(downloaderRole),
    timestamp: new Date().toISOString(),
    businessId: downloaderBusinessId as number | undefined,
    branchCode: downloaderBranchCode as string | undefined,
    branchName: downloaderBranchName as string | undefined,
    recordCount: inventory.length,
    filters: Object.fromEntries(
      Object.entries(filters || {}).filter(([, v]) => v !== undefined)
    ) as Record<string, string | undefined>
  };

  const qrCodeData = await generateQRCode(qrCodePayload);

  let fileData: Blob | string;
  let fileName: string;
  const timestamp = new Date().toISOString().split('T')[0];

  switch (format) {
    case 'CSV':
      fileData = generateCSV(inventory, currency, businesses);
      fileName = `inventory-${downloadId}-${timestamp}.csv`;
      break;
    case 'EXCEL':
      fileData = await generateExcel(inventory, currency, businesses);
      fileName = `inventory-${downloadId}-${timestamp}.xlsx`;
      break;
    case 'PDF':
      fileData = await generatePDF(
        inventory,
        currency,
        businesses,
        downloadId,
        qrCodeData,
        {
          downloaderName,
          downloaderRole,
          downloaderBusinessId,
          downloaderBranchCode,
          downloaderBranchName
        },
        filters,
        data.logo
      );
      fileName = `inventory-${downloadId}-${timestamp}.pdf`;
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
