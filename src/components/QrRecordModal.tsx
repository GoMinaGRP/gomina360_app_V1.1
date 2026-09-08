"use client";

import React, { useEffect, useMemo, useState } from "react";
import { QrCode, Printer, X, Package, Wrench } from "lucide-react";
import { qrDataUrl, printQrLabel } from "@/lib/qrRegistry";

/**
 * QrRecordModal — the canonical "open the existing record" surface for QR
 * lookups, and the "here is your printable QR label" finish after a new
 * registration. Works for inventory items and assets alike.
 */
interface QrRecordModalProps {
  open: boolean;
  onClose: () => void;
  kind: "inventory" | "asset";
  record: any;
  businesses: any[];
  /** True right after a fresh registration (shows a welcome tag). */
  justRegistered?: boolean;
}

export default function QrRecordModal({
  open,
  onClose,
  kind,
  record,
  businesses,
  justRegistered = false,
}: QrRecordModalProps) {
  const [img, setImg] = useState("");

  const qrValue = record?.qrCode || "";
  useEffect(() => {
    let on = true;
    if (open && qrValue) qrDataUrl(qrValue, 220).then((d) => on && setImg(d)).catch(() => {});
    else setImg("");
    return () => { on = false; };
  }, [open, qrValue]);

  const norm = useMemo(() => {
    if (!record) return null;
    const biz = businesses.find((b) => b.id === record.businessId);
    const isInv = kind === "inventory";
    const code = isInv ? record.sku : record.assetCode;
    const photo =
      (isInv ? record.photo : (Array.isArray(record.assetImages) ? record.assetImages[0] : null)) || null;
    const rawDate = record.registeredAt || record.recordedAt || record.createdAt || null;
    const date = rawDate ? new Date(rawDate).toLocaleString() : "—";
    const by = record.registeredByName || record.recorderName || "—";
    return {
      name: record.name || "—",
      code: code || "—",
      photo,
      business: biz?.name || `Business #${record.businessId}`,
      branch: record.branchName || record.branchCode || biz?.name || "—",
      branchCode: record.branchCode || biz?.code || "",
      date,
      by,
    };
  }, [record, businesses, kind]);

  if (!open || !record || !norm) return null;

  const doPrint = () => {
    if (!qrValue) return;
    printQrLabel({
      title: norm.name,
      codeLabel: kind === "inventory" ? "Item Code" : "Asset Code",
      code: norm.code,
      qrValue,
      business: norm.business,
      branch: norm.branch,
      date: norm.date,
      registeredBy: norm.by,
    });
  };

  const Icon = kind === "inventory" ? Package : Wrench;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" data-testid="qr-record">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-700/80 flex items-center justify-between">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <Icon className="w-5 h-5 text-cyan-400" />
            <span data-testid="qr-record-title">{norm.name}</span>
            {justRegistered && (
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-[10px] font-bold">
                REGISTERED ✓
              </span>
            )}
          </h3>
          <button onClick={onClose} data-testid="qr-record-close" className="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-slate-400 hover:text-white transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 flex gap-5">
          {/* Photo + QR visual */}
          <div className="flex flex-col items-center gap-3 shrink-0">
            {norm.photo ? (
              <img src={norm.photo} alt={norm.name} className="w-28 h-28 object-cover rounded-xl border border-slate-700" data-testid="qr-record-photo" />
            ) : (
              <div className="w-28 h-28 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center" data-testid="qr-record-photo-empty">
                <Icon className="w-8 h-8 text-slate-600" />
              </div>
            )}
            {img ? (
              <img src={img} alt="QR code" width={112} height={112} className="rounded-lg border border-slate-600 bg-white p-1" data-testid="qr-record-img" />
            ) : (
              <div className="w-28 h-28 rounded-lg bg-slate-800/60 border border-dashed border-slate-600 flex items-center justify-center" data-testid="qr-record-noimg">
                <QrCode className="w-6 h-6 text-slate-600" />
              </div>
            )}
          </div>

          {/* Stored registry fields */}
          <div className="flex-1 min-w-0 space-y-2 text-sm">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{kind === "inventory" ? "Item Code" : "Asset Code"}</p>
              <p className="font-mono text-cyan-300 text-xs" data-testid="qr-record-code">{norm.code}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Business → Branch</p>
              <p className="text-slate-200 text-xs" data-testid="qr-record-business">{norm.business}</p>
              <p className="text-slate-400 text-[11px]" data-testid="qr-record-branch">{norm.branch}{norm.branchCode ? ` (${norm.branchCode})` : ""}</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Registered</p>
                <p className="text-slate-300 text-[11px]" data-testid="qr-record-date">{norm.date}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Registered By</p>
                <p className="text-slate-300 text-[11px]" data-testid="qr-record-by">{norm.by}</p>
              </div>
            </div>
            {qrValue && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">QR Content</p>
                <p className="font-mono text-[10px] text-slate-400 break-all" data-testid="qr-record-value">{qrValue}</p>
              </div>
            )}
          </div>
        </div>

        <div className="px-5 pb-5 flex justify-end gap-2">
          <button
            onClick={doPrint}
            disabled={!qrValue}
            data-testid="qr-record-print"
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-xs font-bold transition"
          >
            <Printer className="w-3.5 h-3.5" /> Print QR Label
          </button>
        </div>
      </div>
    </div>
  );
}
