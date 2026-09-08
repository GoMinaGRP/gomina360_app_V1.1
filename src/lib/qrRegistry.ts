/**
 * qrRegistry — canonical QR identity for Inventory items & Assets.
 *
 * QR content format (pipe-delimited, self-describing when scanned anywhere):
 *   GM360-INV|<BUSINESS-CODE>|<ITEM CODE>     e.g. GM360-INV|WASH-01|WASH-SOAP-001
 *   GM360-AST|<BUSINESS-CODE>|<ASSET-CODE>    e.g. GM360-AST|POULTRY-01|POULTRY-01-AST-0003
 *
 * The stored qr_code is globally unique (DB unique index); the scanner looks
 * the value up across every accessible business/branch registry.
 */
import QRCode from "qrcode";

export const QR_PREFIX_INV = "GM360-INV";
export const QR_PREFIX_AST = "GM360-AST";

export function buildInventoryQr(businessCode: string, itemCode: string): string {
  return `${QR_PREFIX_INV}|${businessCode}|${itemCode}`;
}

export function buildAssetQr(businessCode: string, assetCode: string): string {
  return `${QR_PREFIX_AST}|${businessCode}|${assetCode}`;
}

/** Renders a QR code as a PNG data URL (label printing + on-screen preview). */
export async function qrDataUrl(value: string, size = 220): Promise<string> {
  return QRCode.toDataURL(value, {
    width: size,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#0f172a", light: "#ffffff" },
  });
}

export interface QrLabelInfo {
  title: string; // item / asset name
  codeLabel: string; // "Item Code" | "Asset Code"
  code: string;
  qrValue: string;
  business: string;
  branch: string;
  date: string;
  registeredBy: string;
}

/**
 * Prints a sticky-style QR label. Renders into a hidden print area and uses
 * the browser's own print pipeline (@media print shows only the label).
 */
export async function printQrLabel(info: QrLabelInfo): Promise<void> {
  const dataUrl = await qrDataUrl(info.qrValue, 300);
  const esc = (s: string) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `
    <div style="width:340px;border:2px dashed #94a3b8;border-radius:12px;padding:16px;font-family:ui-sans-serif,system-ui;page-break-inside:avoid">
      <div style="display:flex;align-items:center;gap:12px">
        <img src="${dataUrl}" width="110" height="110" alt="QR" />
        <div style="min-width:0">
          <div style="font-weight:800;font-size:14px;color:#0f172a">${esc(info.title)}</div>
          <div style="font-size:11px;color:#475569;margin-top:2px">${esc(info.codeLabel)}: <b>${esc(info.code)}</b></div>
          <div style="font-size:11px;color:#475569">${esc(info.business)} → ${esc(info.branch)}</div>
          <div style="font-size:10px;color:#64748b;margin-top:4px">Registered: ${esc(info.date)}<br/>By: ${esc(info.registeredBy)}</div>
        </div>
      </div>
      <div style="font-size:9px;color:#94a3b8;margin-top:10px;font-family:ui-monospace,monospace;word-break:break-all">${esc(info.qrValue)}</div>
    </div>`;

  const w = window.open("", "_blank", "width=420,height=420");
  if (w) {
    w.document.write(
      `<!doctype html><html><head><title>QR Label — ${esc(info.code)}</title></head><body style="margin:16px;background:#f8fafc">${html}<script>window.onload=function(){window.print();};<\/script></body></html>`
    );
    w.document.close();
    return;
  }
  // Popup blocked (or headless): fall back to an in-page print area.
  let style = document.getElementById("qr-print-style") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "qr-print-style";
    style.textContent =
      "@media print { body * { visibility: hidden !important; } #qr-print-area, #qr-print-area * { visibility: visible !important; } #qr-print-area { position: fixed; inset: 16px auto auto 16px; background:#fff; } }";
    document.head.appendChild(style);
  }
  let area = document.getElementById("qr-print-area");
  if (!area) {
    area = document.createElement("div");
    area.id = "qr-print-area";
    document.body.appendChild(area);
  }
  area.innerHTML = html;
  window.print();
}
