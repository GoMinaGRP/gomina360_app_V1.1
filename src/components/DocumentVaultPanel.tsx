"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Download,
  Eye,
  FileText,
  FolderLock,
  Plus,
  RefreshCw,
  Stethoscope,
  Trash2,
  Truck,
  Upload,
  X,
} from "lucide-react";

/**
 * Document Vault (R4) — one registry for every business document: uploaded
 * licences, permits, contracts and insurance (image/PDF ≤ 2.5 MB) plus
 * GENERATED vet reports (from the poultry health log) and delivery notes
 * (from delivered orders). Expiring documents surface at 30/7/0 days via
 * the daily sweep; everything is tenant-scoped server-side.
 */
const DOC_TYPES = [
  "INVOICE", "RECEIPT", "QUOTATION", "VET_REPORT", "DELIVERY_NOTE", "CONTRACT",
  "CERTIFICATE", "LICENCE_PERMIT", "INSURANCE", "VEHICLE_DOCUMENT", "SUPPLIER_INVOICE", "OTHER",
];

const TYPE_STYLE: Record<string, string> = {
  VET_REPORT: "bg-teal-500/15 text-teal-300 border-teal-500/30",
  DELIVERY_NOTE: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  LICENCE_PERMIT: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  INSURANCE: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  CONTRACT: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  CERTIFICATE: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
};

const today = () => new Date().toLocaleDateString("en-CA");
const daysTo = (d: string) => Math.ceil((new Date(d).getTime() - new Date(today()).getTime()) / 86400000);

export default function DocumentVaultPanel({
  currentUser,
  businesses,
}: {
  currentUser: any;
  businesses: any[];
}) {
  const [bizId, setBizId] = useState<string>(businesses[0] ? String(businesses[0].id) : "");
  const [docs, setDocs] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [expiringOnly, setExpiringOnly] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadDraft, setUploadDraft] = useState<any>({ docType: "LICENCE_PERMIT", title: "", issuedOn: "", expiresOn: "", notes: "" });
  const [fileErr, setFileErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [genOpen, setGenOpen] = useState<"VET" | "DELIVERY" | null>(null);
  const [genSource, setGenSource] = useState<any>({ healthRecordId: "", trackingId: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (bizId) params.set("businessId", bizId);
      if (typeFilter) params.set("docType", typeFilter);
      if (expiringOnly) params.set("expiring", "1");
      const res = await fetch(`/api/documents?${params.toString()}`, { credentials: "include" });
      const d = await res.json();
      if (d?.success) {
        setDocs(d.documents || []);
        setSummary(d.summary || null);
        setError("");
      } else setError(d?.error || "Could not load the document vault.");
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }, [bizId, typeFilter, expiringOnly]);

  useEffect(() => { load(); }, [load]);

  const api = async (method: string, path: string, body?: any) => {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok || !d?.success) throw new Error(d?.error || "Action failed.");
    return d;
  };

  const pickFile = () => fileRef.current?.click();

  const onFile = (f: File | null) => {
    setFileErr("");
    if (!f) return;
    if (f.size > 2.5 * 1024 * 1024) {
      setFileErr(`That file is ${(f.size / 1024 / 1024).toFixed(1)} MB — the vault accepts up to 2.5 MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setUploadDraft((d: any) => ({ ...d, fileData: reader.result, fileName: f.name }));
    reader.readAsDataURL(f);
  };

  const saveUpload = async () => {
    setBusy(true); setError("");
    try {
      await api("POST", "/api/documents", { action: "UPLOAD", businessId: Number(bizId), ...uploadDraft });
      setShowUpload(false);
      setUploadDraft({ docType: "LICENCE_PERMIT", title: "", issuedOn: "", expiresOn: "", notes: "" });
      if (fileRef.current) fileRef.current.value = "";
      setFlash("Document filed in the vault.");
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const viewDoc = async (doc: any) => {
    try {
      const d = await api("GET", `/api/documents?id=${doc.id}`);
      const url = d.document?.fileData;
      if (!url) throw new Error("The document has no file attached.");
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.fileName || `${doc.title}.pdf`;
      a.target = "_blank";
      a.click();
    } catch (e: any) { setError(e.message); }
  };

  const delDoc = async (doc: any) => {
    if (!window.confirm(`Delete "${doc.title}" from the vault?`)) return;
    setBusy(true); setError("");
    try {
      await api("DELETE", `/api/documents?id=${doc.id}`);
      setFlash("Document deleted.");
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const generate = async (kind: "VET" | "DELIVERY") => {
    setBusy(true); setError("");
    try {
      if (kind === "VET") {
        await api("POST", "/api/documents", { action: "GENERATE_VET_REPORT", healthRecordId: Number(genSource.healthRecordId) });
      } else {
        await api("POST", "/api/documents", { action: "GENERATE_DELIVERY_NOTE", trackingId: Number(genSource.trackingId) });
      }
      setGenOpen(null);
      setFlash(kind === "VET" ? "Vet report generated into the vault." : "Delivery note generated into the vault.");
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const visible = useMemo(() => docs, [docs]);

  return (
    <div className="space-y-4" data-testid="vault-root">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl">
        <div>
          <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
            <FolderLock className="w-4 h-4 text-teal-400" /> Document Vault
          </h3>
          <p className="text-[11px] text-slate-400 mt-0.5 max-w-2xl">
            One registry for every unit document — licences, permits, contracts, insurance (image/PDF ≤ 2.5 MB) plus
            generated vet reports and delivery notes. Expiring documents warn the team at 30 / 7 / 0 days.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={bizId} onChange={(e) => setBizId(e.target.value)} className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200" data-testid="vault-biz">
            <option value="">All units</option>
            {businesses.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button onClick={load} className="p-2 rounded-lg hover:bg-slate-700/70 text-slate-300" data-testid="vault-refresh"><RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} /></button>
          <button onClick={() => setGenOpen("VET")} disabled={!bizId} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold disabled:opacity-50" data-testid="vault-gen-vet">
            <Stethoscope className="w-3.5 h-3.5" /> Vet report
          </button>
          <button onClick={() => setGenOpen("DELIVERY")} disabled={!bizId} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold disabled:opacity-50" data-testid="vault-gen-delivery">
            <Truck className="w-3.5 h-3.5" /> Delivery note
          </button>
          <button onClick={() => setShowUpload(true)} disabled={!bizId} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50" data-testid="vault-upload">
            <Upload className="w-3.5 h-3.5" /> File document
          </button>
        </div>
      </div>

      {flash && <p className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2" data-testid="vault-flash">{flash}</p>}
      {error && <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2" data-testid="vault-error">{error}</p>}

      {/* Summary + filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3 text-[11px] text-slate-400">
          <span className="font-bold text-white">{summary?.total ?? visible.length}</span> documents
          {summary?.expiringSoon ? <span className="text-amber-300 font-bold flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {summary.expiringSoon} expiring ≤30d</span> : null}
          {summary?.expired ? <span className="text-rose-300 font-bold flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {summary.expired} expired</span> : null}
        </div>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200" data-testid="vault-type-filter">
          <option value="">All types</option>
          {DOC_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
          <input type="checkbox" checked={expiringOnly} onChange={(e) => setExpiringOnly(e.target.checked)} className="accent-amber-500" data-testid="vault-expiring-toggle" />
          Expiring ≤ 30 days
        </label>
      </div>

      <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl overflow-hidden">
        <div className="divide-y divide-slate-700/40" data-testid="vault-list">
          {visible.map((doc) => {
            const dLeft = doc.expiresOn ? daysTo(String(doc.expiresOn)) : null;
            return (
              <div key={doc.id} data-testid={`vault-doc-${doc.id}`} className="px-4 py-3 flex flex-wrap items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-slate-900/80 border border-slate-700 flex items-center justify-center shrink-0">
                  <FileText className="w-4 h-4 text-slate-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-white flex items-center gap-2 flex-wrap">
                    {doc.title}
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${TYPE_STYLE[doc.docType] || "bg-slate-600/40 text-slate-300 border-slate-500/40"}`}>
                      {String(doc.docType || "").replace(/_/g, " ")}
                    </span>
                    {dLeft != null && dLeft < 0 && <span className="text-[10px] font-bold text-rose-300">expired {Math.abs(dLeft)}d ago</span>}
                    {dLeft != null && dLeft >= 0 && dLeft <= 30 && <span className="text-[10px] font-bold text-amber-300">expires in {dLeft}d</span>}
                  </p>
                  <p className="text-[10px] text-slate-500 mt-0.5">
                    {businesses.find((b) => Number(b.id) === Number(doc.businessId))?.name || `Unit #${doc.businessId}`}
                    {doc.issuedOn ? ` · issued ${doc.issuedOn}` : ""}{doc.expiresOn ? ` · expires ${doc.expiresOn}` : ""}
                    {` · filed by ${doc.uploadedByName || "staff"} ${new Date(doc.createdAt).toLocaleDateString()}`}
                    {doc.relatedType ? ` · linked to ${doc.relatedType}#${doc.relatedId}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => viewDoc(doc)} className="p-2 rounded-lg hover:bg-slate-700/70 text-slate-300" title="View / download" data-testid={`vault-view-${doc.id}`}><Eye className="w-3.5 h-3.5" /></button>
                  <button onClick={() => delDoc(doc)} disabled={busy} className="p-2 rounded-lg hover:bg-rose-500/15 text-rose-400 disabled:opacity-50" title="Delete" data-testid={`vault-del-${doc.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            );
          })}
          {visible.length === 0 && !loading && (
            <p className="px-4 py-6 text-xs text-slate-500">No documents yet. File licences, permits and contracts, or generate vet reports and delivery notes.</p>
          )}
          {loading && <p className="px-4 py-6 text-xs text-slate-500">Loading the vault…</p>}
        </div>
      </div>

      {/* ── Upload modal ── */}
      {showUpload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto" data-testid="vault-upload-modal">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-5 w-full max-w-lg space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-extrabold text-white">File a document</h4>
              <button onClick={() => setShowUpload(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Type</label>
                <select value={uploadDraft.docType} onChange={(e) => setUploadDraft({ ...uploadDraft, docType: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="vault-up-type">
                  {DOC_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Title</label>
                <input value={uploadDraft.title} onChange={(e) => setUploadDraft({ ...uploadDraft, title: e.target.value })} placeholder="e.g. Business operating licence" className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="vault-up-title" />
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">File (image or PDF, ≤ 2.5 MB)</label>
              <div className="flex items-center gap-2">
                <button onClick={pickFile} className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold flex items-center gap-1.5" data-testid="vault-up-pick">
                  <Plus className="w-3 h-3" /> Choose file
                </button>
                <span className="text-[11px] text-slate-400 truncate">{uploadDraft.fileName || "no file chosen"}</span>
              </div>
              <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => onFile(e.target.files?.[0] || null)} />
              {fileErr && <p className="text-[11px] text-rose-300 mt-1">{fileErr}</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Issued on</label>
                <input type="date" value={uploadDraft.issuedOn} onChange={(e) => setUploadDraft({ ...uploadDraft, issuedOn: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Expires on (drives the 30/7/0-day alerts)</label>
                <input type="date" value={uploadDraft.expiresOn} onChange={(e) => setUploadDraft({ ...uploadDraft, expiresOn: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="vault-up-expires" />
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">Notes (optional)</label>
              <input value={uploadDraft.notes} onChange={(e) => setUploadDraft({ ...uploadDraft, notes: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowUpload(false)} className="px-3 py-2 rounded-lg bg-slate-700 text-white text-xs font-bold">Cancel</button>
              <button onClick={saveUpload} disabled={busy || !uploadDraft.title.trim() || !uploadDraft.fileData} className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50" data-testid="vault-up-save">File in vault</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Generate modals ── */}
      {genOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" data-testid="vault-gen-modal">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-5 w-full max-w-md space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-extrabold text-white">{genOpen === "VET" ? "Generate vet report" : "Generate delivery note"}</h4>
              <button onClick={() => setGenOpen(null)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-[11px] text-slate-400">
              {genOpen === "VET"
                ? "Pick a poultry health record (vaccination, treatment, inspection…) — a signed-off PDF report is generated into the vault."
                : "Pick a customer order — a PDF delivery note with the items, address and a receive-by signature block is generated into the vault."}
            </p>
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">{genOpen === "VET" ? "Health record ID" : "Order / tracking ID"}</label>
              <input
                type="number"
                value={genOpen === "VET" ? genSource.healthRecordId : genSource.trackingId}
                onChange={(e) => setGenSource({ ...genSource, [genOpen === "VET" ? "healthRecordId" : "trackingId"]: e.target.value })}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                data-testid="vault-gen-id"
              />
              <p className="text-[10px] text-slate-500 mt-1">Find the ID in the Poultry health log / Orders console of this unit.</p>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setGenOpen(null)} className="px-3 py-2 rounded-lg bg-slate-700 text-white text-xs font-bold">Cancel</button>
              <button onClick={() => generate(genOpen)} disabled={busy || !(genOpen === "VET" ? Number(genSource.healthRecordId) : Number(genSource.trackingId))} className="px-3 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold disabled:opacity-50" data-testid="vault-gen-save">Generate PDF</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
