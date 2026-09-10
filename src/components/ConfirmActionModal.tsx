"use client";

import { AlertTriangle, X } from "lucide-react";

export interface ConfirmDetail {
  label: string;
  value: string;
}

interface ConfirmActionModalProps {
  open: boolean;
  title: string;
  message: string;
  details?: ConfirmDetail[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "rose" | "emerald" | "cyan" | "amber" | "indigo" | "purple";
  onConfirm: () => void;
  onCancel: () => void;
  testid?: string;
}

const TONE: Record<string, { ring: string; btn: string; icon: string }> = {
  rose: { ring: "bg-rose-500/15 border-rose-500/40", btn: "bg-rose-600 hover:bg-rose-500", icon: "text-rose-400" },
  emerald: { ring: "bg-emerald-500/15 border-emerald-500/40", btn: "bg-emerald-600 hover:bg-emerald-500", icon: "text-emerald-400" },
  cyan: { ring: "bg-cyan-500/15 border-cyan-500/40", btn: "bg-cyan-600 hover:bg-cyan-500", icon: "text-cyan-400" },
  amber: { ring: "bg-amber-500/15 border-amber-500/40", btn: "bg-amber-600 hover:bg-amber-500", icon: "text-amber-400" },
  indigo: { ring: "bg-indigo-500/15 border-indigo-500/40", btn: "bg-indigo-600 hover:bg-indigo-500", icon: "text-indigo-400" },
  purple: { ring: "bg-purple-500/15 border-purple-500/40", btn: "bg-purple-600 hover:bg-purple-500", icon: "text-purple-400" },
};

/**
 * ConfirmActionModal — a shared "are you sure?" gate shown before a Sale,
 * Inventory or Asset entry is finally executed (recorded / edited / saved).
 *
 * Every entry form opens this prompt on its final submit; the actual POST to
 * the backend only fires once the user confirms. Keeps one consistent,
 * testable confirmation UX across every business module and branch.
 */
export default function ConfirmActionModal({
  open,
  title,
  message,
  details = [],
  confirmLabel = "Confirm & Save",
  cancelLabel = "Go Back",
  tone = "rose",
  onConfirm,
  onCancel,
  testid = "confirm-action",
}: ConfirmActionModalProps) {
  if (!open) return null;

  const t = TONE[tone] || TONE.rose;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      data-testid={`${testid}-overlay`}
    >
      <div
        className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl p-5 space-y-4"
        data-testid={`${testid}-modal`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl ${t.ring} flex items-center justify-center shrink-0`}>
              <AlertTriangle className={`w-5 h-5 ${t.icon}`} />
            </div>
            <h3 className="text-base font-bold text-white">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
            data-testid={`${testid}-close`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-xs text-slate-300 leading-relaxed">{message}</p>

        {details.length > 0 && (
          <div className="rounded-xl border border-slate-700/70 bg-slate-800/50 p-3 space-y-1.5">
            {details.map((d, i) => (
              <div key={i} className="flex items-center justify-between gap-3 text-[11px]">
                <span className="text-slate-400 font-semibold">{d.label}</span>
                <span className="text-slate-100 text-right break-words max-w-[60%]">{d.value || "—"}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold"
            data-testid={`${testid}-cancel`}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`px-5 py-2 rounded-lg text-white text-xs font-bold shadow-md transition ${t.btn}`}
            data-testid={`${testid}-confirm`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
