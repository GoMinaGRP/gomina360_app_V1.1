"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  UserCheck,
  X,
  Camera,
  Upload,
  FileText,
  Trash2,
  Download,
  Pencil,
  History,
  IdCard,
  CalendarClock,
  Briefcase,
  Plus,
  RefreshCw,
  Link2,
  Wallet,
  Landmark,
  ShieldCheck,
} from "lucide-react";

/**
 * Employee Registration & Records — the complete HR desk:
 *  • EmployeeRegistration: sectioned form (Personal + photo upload OR live
 *    camera capture • Work & Attendance • Identity & compliance).
 *  • EmployeeProfile: per-employee profile with Overview (incl. the
 *    Business → Branch → Payroll → Attendance → Permissions → Reports
 *    linkage chips), Documents vault and the immutable record History.
 */

const fmt = (n: number) =>
  "GH₵ " + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const inputCls =
  "w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-teal-500";
const labelCls = "block text-[11px] font-semibold text-slate-400 mb-1";
const sectionCls = "text-[11px] font-bold text-teal-300 uppercase tracking-wider flex items-center gap-2";

const ID_TYPES: [string, string][] = [
  ["GHANA_CARD", "Ghana Card"],
  ["PASSPORT", "Passport"],
  ["VOTER_ID", "Voter ID"],
  ["DRIVERS_LICENSE", "Driver's License"],
  ["OTHER", "Other ID"],
];

const DOC_TYPES: [string, string][] = [
  ["EMPLOYMENT_CONTRACT", "Employment contract"],
  ["CERTIFICATE", "Certificate"],
  ["QUALIFICATION", "Qualification"],
  ["WORK_PERMIT", "Work permit"],
  ["ID_COPY", "ID copy"],
  ["OTHER", "Other document"],
];

const DAY_OPTIONS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

/** Downscale an image file / data URL to a manageable base64 (max 480px). */
async function imageToDataUrl(file: File | Blob, max = 480): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale) || 1;
      const h = Math.round(img.height * scale) || 1;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d")!.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => resolve(dataUrl); // keep original if undecodable
    img.src = dataUrl;
  });
}

/** Live camera capture modal (getUserMedia → canvas snapshot). */
function CameraCapture({ onShot, onClose }: { onShot: (dataUrl: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 } }, audio: false });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
      } catch (e: any) {
        setErr(e?.message || "Camera unavailable — use the photo upload instead.");
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const shoot = () => {
    const v = videoRef.current;
    if (!v) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth || 640;
    c.height = v.videoHeight || 480;
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    onShot(c.toDataURL("image/jpeg", 0.85));
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4 w-full max-w-md space-y-3" data-testid="ereg-cam">
        <div className="flex items-center justify-between">
          <h5 className="text-sm font-bold text-white flex items-center gap-2"><Camera className="w-4 h-4 text-teal-400" /> Capture employee photo</h5>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-400" data-testid="ereg-cam-cancel"><X className="w-4 h-4" /></button>
        </div>
        {err ? (
          <div className="text-rose-300 text-xs bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2" data-testid="ereg-cam-error">{err}</div>
        ) : (
          <video ref={videoRef} className="w-full rounded-xl bg-black aspect-[4/3]" data-testid="ereg-cam-video" muted playsInline />
        )}
        {!err && (
          <button onClick={shoot} className="w-full py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white font-bold text-sm" data-testid="ereg-cam-shoot">
            Capture photo
          </button>
        )}
      </div>
    </div>
  );
}

const emptyForm = ( businesses: any[]) => ({
  name: "", role: "", businessId: businesses[0]?.id || "", branch: businesses[0]?.code || "",
  salaryGhs: "", phone: "", email: "", hireDate: new Date().toISOString().slice(0, 10),
  employeeNo: "", dateOfBirth: "", gender: "", address: "",
  emergencyContactName: "", emergencyContactPhone: "",
  workSchedule: "FULL_TIME", shift: "DAY", dailyHours: "8",
  workDays: ["MON", "TUE", "WED", "THU", "FRI"] as string[],
  leaveEntitlementDays: "15",
  idType: "", idNumber: "", workPermitNo: "", notes: "",
  photo: null as string | null,
});

export function EmployeeRegistration({
  currentUser,
  businesses,
  initial,
  onSaved,
  onClose,
}: {
  currentUser: any;
  businesses: any[];
  initial?: any | null; // employee to edit (null = register new)
  onSaved: (emp: any) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<any>(() => {
    if (!initial) return emptyForm(businesses);
    return {
      ...emptyForm(businesses),
      name: initial.name || "", role: initial.role || "", businessId: initial.businessId, branch: initial.branch || "",
      salaryGhs: String(initial.salaryGhs ?? ""), phone: initial.phone || "", email: initial.email || "",
      hireDate: initial.hireDate || "", employeeNo: initial.employeeNo || "",
      dateOfBirth: initial.dateOfBirth || "", gender: initial.gender || "", address: initial.address || "",
      emergencyContactName: initial.emergencyContactName || "", emergencyContactPhone: initial.emergencyContactPhone || "",
      workSchedule: initial.workSchedule || "FULL_TIME", shift: initial.shift || "DAY",
      dailyHours: String(initial.dailyHours ?? 8),
      workDays: (initial.workDays || "MON,TUE,WED,THU,FRI").split(",").filter(Boolean),
      leaveEntitlementDays: String(initial.leaveEntitlementDays ?? 15),
      idType: initial.idType || "", idNumber: initial.idNumber || "", workPermitNo: initial.workPermitNo || "",
      notes: initial.notes || "", photo: initial.photo || null,
    };
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [camOpen, setCamOpen] = useState(false);
  const editing = !!initial?.id;

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const toggleDay = (d: string) =>
    setForm((f: any) => ({ ...f, workDays: f.workDays.includes(d) ? f.workDays.filter((x: string) => x !== d) : [...f.workDays, d] }));

  const pickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return setErr("Please choose an image file.");
    setErr("");
    set("photo", await imageToDataUrl(file));
  };

  const bizPicked = (id: string) => {
    const biz = businesses.find((b) => String(b.id) === String(id));
    setForm((f: any) => ({ ...f, businessId: id, branch: biz?.code || f.branch }));
  };

  const save = async () => {
    setBusy(true); setErr("");
    try {
      const payload: any = {
        name: form.name, role: form.role, businessId: Number(form.businessId), branch: form.branch || undefined,
        salaryGhs: Number(form.salaryGhs), phone: form.phone, email: form.email, hireDate: form.hireDate,
        dateOfBirth: form.dateOfBirth || undefined, gender: form.gender || undefined,
        address: form.address || undefined, emergencyContactName: form.emergencyContactName || undefined,
        emergencyContactPhone: form.emergencyContactPhone || undefined,
        workSchedule: form.workSchedule, shift: form.shift,
        dailyHours: Number(form.dailyHours) || 0, workDays: form.workDays.join(","),
        leaveEntitlementDays: form.leaveEntitlementDays === "" ? undefined : Number(form.leaveEntitlementDays),
        idType: form.idType || undefined, idNumber: form.idNumber || undefined,
        workPermitNo: form.workPermitNo || undefined, notes: form.notes || undefined,
      };
      if (form.photo) payload.photo = form.photo;
      if (form.employeeNo) payload.employeeNo = form.employeeNo;
      const r = await fetch("/api/employees", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { id: initial.id, data: payload } : { data: payload }),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.success) {
        onSaved(j.employee);
      } else setErr(j?.error || "Save failed.");
    } catch (e: any) {
      setErr(e?.message || "Network error.");
    } finally {
      setBusy(false);
    }
  };

  const valid = form.name.trim() && form.role.trim() && form.businessId && Number(form.salaryGhs) >= 0 && form.salaryGhs !== "";

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm p-3 sm:p-5">
      <div className="bg-slate-950 border border-slate-700 rounded-2xl w-full max-w-3xl shadow-2xl flex flex-col max-h-[94vh] overflow-hidden" data-testid="ereg-root">
        <div className="px-5 py-4 border-b border-slate-800 bg-slate-900/80 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-teal-500 to-emerald-700 flex items-center justify-center text-white shadow-lg shrink-0">
            <UserCheck className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-white">{editing ? `Edit — ${initial.name}` : "Employee Registration"}</h3>
            <p className="text-[11px] text-slate-400">Complete staff record: personal, work & attendance, identity & documents</p>
          </div>
          <button onClick={onClose} className="ml-auto p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300" data-testid="ereg-cancel"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {err && <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-2.5 rounded-lg text-xs" data-testid="ereg-error">{err}</div>}

          {/* ── Personal information ─────────────────────────────── */}
          <div className="space-y-3">
            <div className={sectionCls}><IdCard className="w-4 h-4" /> Personal information</div>
            <div className="flex gap-4 flex-wrap">
              {/* Photo */}
              <div className="w-32 shrink-0 space-y-2">
                <div className="w-32 h-32 rounded-xl bg-slate-800 border border-slate-700 overflow-hidden flex items-center justify-center" data-testid="ereg-photo-preview">
                  {form.photo ? (
                    <img src={form.photo} alt="employee" className="w-full h-full object-cover" />
                  ) : (
                    <UserCheck className="w-10 h-10 text-slate-600" />
                  )}
                </div>
                <label className="block text-center px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-bold cursor-pointer" data-testid="ereg-photo-upload">
                  <Upload className="w-3 h-3 inline mr-1" /> Upload photo
                  <input type="file" accept="image/*" className="hidden" onChange={pickPhoto} />
                </label>
                <button type="button" onClick={() => setCamOpen(true)} className="w-full px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-bold" data-testid="ereg-photo-camera">
                  <Camera className="w-3 h-3 inline mr-1" /> Use camera
                </button>
              </div>
              <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-3 min-w-[240px]">
                <div className="sm:col-span-2">
                  <label className={labelCls}>Full name <span className="text-rose-400">*</span></label>
                  <input className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} data-testid="ereg-name" />
                </div>
                <div>
                  <label className={labelCls}>Employee ID {editing ? "" : "(auto if blank)"}</label>
                  <input className={`${inputCls} font-mono`} value={form.employeeNo} onChange={(e) => set("employeeNo", e.target.value.toUpperCase())} placeholder="EMP-0008" data-testid="ereg-empno" />
                </div>
                <div>
                  <label className={labelCls}>Date of birth</label>
                  <input type="date" className={inputCls} value={form.dateOfBirth} onChange={(e) => set("dateOfBirth", e.target.value)} data-testid="ereg-dob" />
                </div>
                <div>
                  <label className={labelCls}>Gender</label>
                  <select className={inputCls} value={form.gender} onChange={(e) => set("gender", e.target.value)} data-testid="ereg-gender">
                    <option value="">Select…</option><option value="MALE">Male</option><option value="FEMALE">Female</option><option value="OTHER">Other</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Phone <span className="text-rose-400">*</span></label>
                  <input className={inputCls} value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="024 000 0000" data-testid="ereg-phone" />
                </div>
                <div>
                  <label className={labelCls}>Email</label>
                  <input type="email" className={inputCls} value={form.email} onChange={(e) => set("email", e.target.value)} data-testid="ereg-email" />
                </div>
                <div className="sm:col-span-2">
                  <label className={labelCls}>Residential address</label>
                  <input className={inputCls} value={form.address} onChange={(e) => set("address", e.target.value)} data-testid="ereg-address" />
                </div>
                <div>
                  <label className={labelCls}>Emergency contact — name</label>
                  <input className={inputCls} value={form.emergencyContactName} onChange={(e) => set("emergencyContactName", e.target.value)} data-testid="ereg-ec-name" />
                </div>
                <div>
                  <label className={labelCls}>Emergency contact — phone</label>
                  <input className={inputCls} value={form.emergencyContactPhone} onChange={(e) => set("emergencyContactPhone", e.target.value)} data-testid="ereg-ec-phone" />
                </div>
              </div>
            </div>
          </div>

          {/* ── Employment ───────────────────────────────────────── */}
          <div className="space-y-3">
            <div className={sectionCls}><Briefcase className="w-4 h-4" /> Employment — Business → Branch</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>Business <span className="text-rose-400">*</span></label>
                <select className={inputCls} value={form.businessId} onChange={(e) => bizPicked(e.target.value)} data-testid="ereg-business">
                  {businesses.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.code})</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Branch / register</label>
                <input className={`${inputCls} font-mono`} value={form.branch} onChange={(e) => set("branch", e.target.value.toUpperCase())} data-testid="ereg-branch" />
              </div>
              <div>
                <label className={labelCls}>Hire date</label>
                <input type="date" className={inputCls} value={form.hireDate} onChange={(e) => set("hireDate", e.target.value)} data-testid="ereg-hiredate" />
              </div>
              <div>
                <label className={labelCls}>Role / position <span className="text-rose-400">*</span></label>
                <input className={inputCls} value={form.role} onChange={(e) => set("role", e.target.value)} data-testid="ereg-role" />
              </div>
              <div>
                <label className={labelCls}>Basic monthly salary (GH₵) <span className="text-rose-400">*</span></label>
                <input type="number" step="0.01" className={inputCls} value={form.salaryGhs} onChange={(e) => set("salaryGhs", e.target.value)} data-testid="ereg-salary" />
              </div>
              <div>
                <label className={labelCls}>Notes</label>
                <input className={inputCls} value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="optional" data-testid="ereg-notes" />
              </div>
            </div>
          </div>

          {/* ── Work & attendance ────────────────────────────────── */}
          <div className="space-y-3">
            <div className={sectionCls}><CalendarClock className="w-4 h-4" /> Work schedule & attendance</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>Work schedule</label>
                <select className={inputCls} value={form.workSchedule} onChange={(e) => set("workSchedule", e.target.value)} data-testid="ereg-schedule">
                  <option value="FULL_TIME">Full time</option><option value="PART_TIME">Part time</option><option value="CONTRACT">Contract</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Shift</label>
                <select className={inputCls} value={form.shift} onChange={(e) => set("shift", e.target.value)} data-testid="ereg-shift">
                  <option value="DAY">Day shift</option><option value="NIGHT">Night shift</option><option value="ROTATING">Rotating</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Working hours per day</label>
                <input type="number" step="0.5" className={inputCls} value={form.dailyHours} onChange={(e) => set("dailyHours", e.target.value)} data-testid="ereg-hours" />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Assigned working days</label>
                <div className="flex gap-1.5 flex-wrap" data-testid="ereg-days">
                  {DAY_OPTIONS.map((d) => (
                    <button type="button" key={d} onClick={() => toggleDay(d)}
                      className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold border ${form.workDays.includes(d) ? "bg-teal-600 border-teal-500 text-white" : "bg-slate-800 border-slate-700 text-slate-400"}`}
                      data-testid={`ereg-day-${d}`}>
                      {d}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className={labelCls}>Annual leave entitlement (days)</label>
                <input type="number" className={inputCls} value={form.leaveEntitlementDays} onChange={(e) => set("leaveEntitlementDays", e.target.value)} data-testid="ereg-leave" />
              </div>
            </div>
          </div>

          {/* ── Identity & compliance ────────────────────────────── */}
          <div className="space-y-3">
            <div className={sectionCls}><ShieldCheck className="w-4 h-4" /> Identity & compliance</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>ID type</label>
                <select className={inputCls} value={form.idType} onChange={(e) => set("idType", e.target.value)} data-testid="ereg-idtype">
                  <option value="">Select…</option>
                  {ID_TYPES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>ID number</label>
                <input className={`${inputCls} font-mono`} value={form.idNumber} onChange={(e) => set("idNumber", e.target.value)} data-testid="ereg-idnumber" />
              </div>
              <div>
                <label className={labelCls}>Work permit no. (if applicable)</label>
                <input className={inputCls} value={form.workPermitNo} onChange={(e) => set("workPermitNo", e.target.value)} data-testid="ereg-permit" />
              </div>
            </div>
            <p className="text-[10px] text-slate-500">Contracts, certificates, qualifications and permit scans are filed afterwards on the employee's profile → Documents tab. Every change here is written to the employee's record history.</p>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-slate-800 bg-slate-900/60">
          <button onClick={save} disabled={busy || !valid} className="w-full py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white font-bold text-sm shadow disabled:opacity-50" data-testid="ereg-save">
            {busy ? "Saving…" : editing ? "Save changes (recorded to history)" : "Register employee"}
          </button>
        </div>
      </div>
      {camOpen && <CameraCapture onShot={(d) => { set("photo", d); setCamOpen(false); }} onClose={() => setCamOpen(false)} />}
    </div>
  );
}

/** ─── Employee profile: Overview / Documents / History ──────────────── */
export function EmployeeProfile({
  currentUser,
  businesses,
  employee: seedEmp,
  onClose,
  onEdit,
  onChanged,
}: {
  currentUser: any;
  businesses: any[];
  employee: any;
  onClose: () => void;
  onEdit: (emp: any) => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState("OVERVIEW");
  const [busy, setBusy] = useState(false);
  const [docForm, setDocForm] = useState<any>({ docType: "EMPLOYMENT_CONTRACT", title: "", note: "", expiresOn: "" });
  const [docFile, setDocFile] = useState<{ name: string; data: string } | null>(null);
  const [docErr, setDocErr] = useState("");
  const emp = data?.employees?.[0] || seedEmp;
  const links = data?.links?.[emp.id] || { payrollEntries: 0, payrollNet: 0, attendanceRows: 0, overtimeHours: 0, leaveDaysTaken: 0 };
  const canManage = data?.scope?.canManage || data?.scope?.isOwner;
  const biz = businesses.find((b) => b.id === emp.businessId);

  const load = async () => {
    const r = await fetch(`/api/employees?employeeId=${emp.id}`);
    const j = await r.json().catch(() => null);
    if (j?.success) setData(j);
  };
  useEffect(() => { load(); }, [emp.id]);

  const docs = data?.documents || [];
  const files = Object.fromEntries((data?.documentFiles || []).map((f: any) => [f.id, f.fileData]));
  const history = data?.history || [];

  const pickDoc = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 2_500_000) return setDocErr("File too large — keep it under 2.5MB.");
    setDocErr("");
    if (f.type.startsWith("image/")) setDocFile({ name: f.name, data: await imageToDataUrl(f, 1400) });
    else if (f.type === "application/pdf") {
      const r = new FileReader();
      r.onload = () => setDocFile({ name: f.name, data: String(r.result) });
      r.readAsDataURL(f);
    } else setDocErr("Only images or PDF files are accepted.");
  };

  const addDoc = async () => {
    if (!docForm.title.trim()) return setDocErr("Give the document a title.");
    setBusy(true); setDocErr("");
    try {
      const r = await fetch("/api/employees", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ADD_DOCUMENT", data: { employeeId: emp.id, ...docForm, fileName: docFile?.name, fileData: docFile?.data } }),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.success) { setDocForm({ docType: "EMPLOYMENT_CONTRACT", title: "", note: "", expiresOn: "" }); setDocFile(null); await load(); }
      else setDocErr(j?.error || "Upload failed.");
    } finally { setBusy(false); }
  };

  const delDoc = async (id: number) => {
    await fetch("/api/employees", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId: id }) });
    await load();
  };

  const dlDoc = (d: any) => {
    const a = document.createElement("a");
    a.href = files[d.id] || "";
    a.download = d.fileName || `${d.docType}-${d.id}.png`;
    a.click();
  };

  const Field = ({ label, value, tid }: any) => (
    <div className="bg-slate-900/80 border border-slate-800 rounded-lg px-3 py-2">
      <div className="text-[9px] uppercase tracking-wider text-slate-500 font-bold">{label}</div>
      <div className="text-xs text-slate-100 font-semibold mt-0.5" data-testid={tid}>{value || "—"}</div>
    </div>
  );

  const HIST_STYLE: Record<string, string> = {
    CREATED: "bg-emerald-500/20 text-emerald-300",
    UPDATED: "bg-cyan-500/20 text-cyan-300",
    PHOTO_UPDATED: "bg-violet-500/20 text-violet-300",
    DOCUMENT_ADDED: "bg-sky-500/20 text-sky-300",
    DOCUMENT_REMOVED: "bg-amber-500/20 text-amber-300",
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm p-3 sm:p-5">
      <div className="bg-slate-950 border border-slate-700 rounded-2xl w-full max-w-4xl shadow-2xl flex flex-col max-h-[94vh] overflow-hidden" data-testid="epr-root">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 bg-slate-900/80 flex items-center gap-4">
          <div className="w-14 h-14 rounded-xl bg-slate-800 border border-slate-700 overflow-hidden flex items-center justify-center shrink-0" data-testid="epr-photo">
            {emp.photo ? <img src={emp.photo} alt={emp.name} className="w-full h-full object-cover" /> : <UserCheck className="w-6 h-6 text-slate-600" />}
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-white flex items-center gap-2 flex-wrap">
              {emp.name}
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">{emp.status}</span>
            </h3>
            <p className="text-[11px] text-slate-400">
              <span className="font-mono text-teal-300" data-testid="epr-empno">{emp.employeeNo || "—"}</span> · {emp.role} · {biz?.name || `Business #${emp.businessId}`} · <span className="font-mono">{emp.branch}</span>
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={load} className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300" title="Refresh" data-testid="epr-refresh"><RefreshCw className="w-4 h-4" /></button>
            {canManage && (
              <button onClick={() => onEdit(emp)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold" data-testid="epr-edit">
                <Pencil className="w-3.5 h-3.5" /> Edit record
              </button>
            )}
            <button onClick={onClose} className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300" data-testid="epr-close"><X className="w-4 h-4" /></button>
          </div>
        </div>

        {/* Linkage strip */}
        <div className="px-5 py-2.5 border-b border-slate-800 bg-slate-950 flex items-center gap-4 flex-wrap text-[10px]" data-testid="epr-links">
          <span className="text-slate-500 font-bold uppercase tracking-wider flex items-center gap-1"><Link2 className="w-3 h-3" /> Linked records</span>
          <span className="text-slate-300">Business <b className="text-white" data-testid="epr-link-business">{biz?.name || `#${emp.businessId}`}</b></span>
          <span className="text-slate-300">Branch <b className="font-mono text-cyan-300" data-testid="epr-link-branch">{emp.branch}</b></span>
          <span className="text-slate-300">Payroll <b className="text-emerald-300" data-testid="epr-link-payroll">{links.payrollEntries} entr{links.payrollEntries === 1 ? "y" : "ies"} · {fmt(links.payrollNet)}</b></span>
          <span className="text-slate-300">Attendance <b className="text-sky-300" data-testid="epr-link-attendance">{links.attendanceRows} rows · OT {links.overtimeHours}h</b></span>
          <span className="text-slate-300">Leave <b className="text-amber-300" data-testid="epr-link-leave">{links.leaveDaysTaken}/{emp.leaveEntitlementDays ?? "—"} days used</b></span>
          <span className="text-slate-300">Permissions <b className="text-slate-200" data-testid="epr-link-perms">{canManage ? "manageable by you" : "read-only"}</b></span>
          <span className="text-slate-300">History <b className="text-violet-300" data-testid="epr-link-history">{history.length || links.historyCount || 0} entries</b></span>
        </div>

        {/* Tabs */}
        <div className="px-5 pt-3 flex items-center gap-1.5">
          {[["OVERVIEW", "Overview", UserCheck], ["DOCUMENTS", `Documents (${docs.length})`, FileText], ["HISTORY", "Record history", History]].map(([k, label, Icon]: any) => (
            <button key={k} onClick={() => setTab(k)}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition ${tab === k ? "bg-teal-600 text-white shadow" : "bg-slate-800/70 text-slate-300 hover:bg-slate-700"}`}
              data-testid={`epr-tab-${k}`}>
              <Icon className="w-4 h-4" /><span>{label}</span>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {tab === "OVERVIEW" && (
            <div className="space-y-4" data-testid="epr-overview">
              <div>
                <div className={sectionCls}><IdCard className="w-4 h-4" /> Personal</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
                  <Field label="Date of birth" value={emp.dateOfBirth} tid="epr-f-dob" />
                  <Field label="Gender" value={emp.gender} tid="epr-f-gender" />
                  <Field label="Phone" value={emp.phone} tid="epr-f-phone" />
                  <Field label="Email" value={emp.email} tid="epr-f-email" />
                  <div className="col-span-2"><Field label="Address" value={emp.address} tid="epr-f-address" /></div>
                  <Field label="Emergency contact" value={emp.emergencyContactName} tid="epr-f-ecname" />
                  <Field label="Emergency phone" value={emp.emergencyContactPhone} tid="epr-f-ecphone" />
                </div>
              </div>
              <div>
                <div className={sectionCls}><CalendarClock className="w-4 h-4" /> Work & attendance</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
                  <Field label="Schedule" value={emp.workSchedule?.replaceAll("_", " ")} tid="epr-f-schedule" />
                  <Field label="Shift" value={emp.shift} tid="epr-f-shift" />
                  <Field label="Hours / day" value={emp.dailyHours != null ? `${emp.dailyHours}h` : null} tid="epr-f-hours" />
                  <Field label="Assigned days" value={emp.workDays} tid="epr-f-days" />
                  <Field label="Leave entitlement" value={emp.leaveEntitlementDays != null ? `${emp.leaveEntitlementDays} days/yr` : null} tid="epr-f-leave" />
                  <Field label="Hire date" value={emp.hireDate} tid="epr-f-hiredate" />
                  <Field label="Basic salary" value={fmt(emp.salaryGhs)} tid="epr-f-salary" />
                  <Field label="Status" value={emp.status} tid="epr-f-status" />
                </div>
              </div>
              <div>
                <div className={sectionCls}><ShieldCheck className="w-4 h-4" /> Identity & compliance</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
                  <Field label="ID type" value={ID_TYPES.find(([k]) => k === emp.idType)?.[1]} tid="epr-f-idtype" />
                  <Field label="ID number" value={emp.idNumber} tid="epr-f-idnumber" />
                  <Field label="Work permit" value={emp.workPermitNo} tid="epr-f-permit" />
                  <Field label="Documents on file" value={`${docs.length}`} tid="epr-f-doccount" />
                </div>
              </div>
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 text-[10px] text-slate-500 flex items-center gap-2">
                <Landmark className="w-4 h-4 text-teal-400 shrink-0" />
                Payroll runs pick up this employee automatically (ACTIVE status, basic salary, business & branch) — attendance & overtime recorded in the Payroll Center appears under Linked records above, and in Payroll reports.
              </div>
            </div>
          )}

          {tab === "DOCUMENTS" && (
            <div className="space-y-4" data-testid="epr-documents">
              {canManage && (
                <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-4 space-y-3">
                  <div className={sectionCls}><Plus className="w-4 h-4" /> File a document</div>
                  {docErr && <div className="text-rose-300 text-xs bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2" data-testid="epr-doc-error">{docErr}</div>}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
                    <div>
                      <label className={labelCls}>Type</label>
                      <select className={inputCls} value={docForm.docType} onChange={(e) => setDocForm({ ...docForm, docType: e.target.value })} data-testid="epr-doc-type">
                        {DOC_TYPES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className={labelCls}>Title <span className="text-rose-400">*</span></label>
                      <input className={inputCls} value={docForm.title} onChange={(e) => setDocForm({ ...docForm, title: e.target.value })} placeholder="e.g. BSc Agriculture certificate" data-testid="epr-doc-title" />
                    </div>
                    <div>
                      <label className={labelCls}>Expires (optional)</label>
                      <input type="date" className={inputCls} value={docForm.expiresOn} onChange={(e) => setDocForm({ ...docForm, expiresOn: e.target.value })} data-testid="epr-doc-expires" />
                    </div>
                    <div className="col-span-2">
                      <label className={labelCls}>Note</label>
                      <input className={inputCls} value={docForm.note} onChange={(e) => setDocForm({ ...docForm, note: e.target.value })} placeholder="optional" data-testid="epr-doc-note" />
                    </div>
                    <div>
                      <label className="block text-center px-2 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-bold cursor-pointer" data-testid="epr-doc-file">
                        <Upload className="w-3 h-3 inline mr-1" /> {docFile ? "Replace file" : "Attach scan"}
                        <input type="file" accept="image/*,application/pdf" className="hidden" onChange={pickDoc} />
                      </label>
                    </div>
                    <button onClick={addDoc} disabled={busy} className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold h-fit" data-testid="epr-doc-save">
                      {busy ? "Saving…" : "Save document"}
                    </button>
                  </div>
                  {docFile && <div className="text-[10px] text-teal-300 font-mono" data-testid="epr-doc-picked">attached: {docFile.name}</div>}
                </div>
              )}
              <div className="space-y-2" data-testid="epr-doc-list">
                {docs.map((d: any) => (
                  <div key={d.id} className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 flex items-center gap-3" data-testid={`epr-doc-${d.id}`}>
                    <FileText className="w-5 h-5 text-sky-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-slate-100">{d.title}</div>
                      <div className="text-[10px] text-slate-500">
                        {DOC_TYPES.find(([k]) => k === d.docType)?.[1] || d.docType}
                        {d.expiresOn ? ` · expires ${d.expiresOn}` : ""}
                        {d.note ? ` · ${d.note}` : ""} · by {d.uploadedByName}
                      </div>
                    </div>
                    {d.hasFile && (
                      <button onClick={() => dlDoc(d)} className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300" title="Download" data-testid={`epr-doc-dl-${d.id}`}>
                        <Download className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {canManage && (
                      <button onClick={() => delDoc(d.id)} className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-500/20 text-slate-500 hover:text-rose-300" title="Remove" data-testid={`epr-doc-del-${d.id}`}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
                {!docs.length && <div className="text-center text-slate-500 text-xs py-8">No documents filed yet — contracts, certificates, qualifications, work permits and ID scans live here.</div>}
              </div>
            </div>
          )}

          {tab === "HISTORY" && (
            <div className="space-y-1.5" data-testid="epr-hist">
              {history.map((h: any) => (
                <div key={h.id} className="flex items-start gap-3 bg-slate-900/70 border border-slate-800 rounded-lg px-3 py-2.5" data-testid={`epr-hist-${h.id}`}>
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-black shrink-0 mt-0.5 ${HIST_STYLE[h.action] || "bg-slate-700 text-slate-300"}`}>{h.action.replaceAll("_", " ")}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-slate-200">{h.summary}</div>
                    <div className="text-[10px] text-slate-500">{h.changedByName} ({h.changedByRole}) · {h.createdAt ? new Date(h.createdAt).toLocaleString() : ""}</div>
                  </div>
                </div>
              ))}
              {!history.length && <div className="text-center text-slate-500 text-xs py-8">No history yet — every change to this record is written here automatically, with who made it and when.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
