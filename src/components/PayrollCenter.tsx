"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Landmark,
  RefreshCw,
  Plus,
  X,
  Users,
  Wallet,
  Clock,
  MinusCircle,
  CheckCircle,
  FileText,
  Printer,
  ChevronDown,
  ChevronUp,
  CalendarClock,
  BarChart3,
  LayoutDashboard,
  PlayCircle,
  Eye,
  ThumbsUp,
  Banknote,
  Trash2,
  FileSpreadsheet,
  Settings2,
  Download,
  Pencil,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import AiSectionGuide from "./AiSectionGuide";
import AttendanceReviewPanel from "./AttendanceReviewPanel";
import { resolveLogo, getCompanyLogo } from "@/lib/logos";

/**
 * Payroll Command Center — the complete payroll management system behind the
 * "Employees & Payroll" dashboard. Employees, salaries, allowances, overtime
 * and deductions roll into runs (DRAFT → REVIEWED → APPROVED → PAID); paying
 * posts real EXPENSE transactions, linking Employee → Business → Branch →
 * Finance → Reports automatically. Includes attendance/leave/overtime
 * tracking, payslips (printable) and payroll reports & charts.
 */

const fmt = (n: number) =>
  "GH₵ " + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const roundOff = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

const METHODS: [string, string][] = [
  ["CASH", "Cash"],
  ["MTN_MOMO", "MTN MoMo"],
  ["BANK_TRANSFER", "Bank Transfer"],
  ["OTHER", "Other"],
];

const RUN_STYLE: Record<string, string> = {
  DRAFT: "bg-slate-600/40 text-slate-300 border-slate-500/40",
  REVIEWED: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  APPROVED: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  PAID: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
};

const ATT_STYLE: Record<string, string> = {
  PRESENT: "text-emerald-300",
  HALF_DAY: "text-amber-300",
  ABSENT: "text-rose-400",
  LEAVE: "text-cyan-300",
  OFF_DAY: "text-slate-400",
};

const TABS: [string, string, any][] = [
  ["OVERVIEW", "Overview", LayoutDashboard],
  ["RUNS", "Payroll Runs", Banknote],
  ["ATTENDANCE", "Attendance & OT", CalendarClock],
  ["REPORTS", "Reports & Charts", BarChart3],
  ["SETTINGS", "Statutory Settings", Settings2],
];

const MONTH_NAME = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const periodLabel = (p: string) => {
  const [y, m] = p.split("-");
  return `${MONTH_NAME[Number(m)] || m} ${y}`;
};

interface Props {
  currentUser: any;
  businesses: any[];
  employees: any[];
  onChanged: () => void;
  onClose: () => void;
}

export default function PayrollCenter({ currentUser, businesses, employees, onChanged, onClose }: Props) {
  const [tab, setTab] = useState("OVERVIEW");
  const [runs, setRuns] = useState<any[]>([]);
  const [attendance, setAttendance] = useState<any[]>([]);
  const [report, setReport] = useState<any>({ byMonth: [], byBusiness: [], composition: {} });
  const [scope, setScope] = useState<{ isOwner: boolean; canManage: boolean; businessIds: number[] | null }>({
    isOwner: false, canManage: false, businessIds: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [bizFilter, setBizFilter] = useState<string>("ALL");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [runFormOpen, setRunFormOpen] = useState(false);
  const [runForm, setRunForm] = useState({ businessId: "", period: new Date().toISOString().slice(0, 7), branchCode: "", notes: "" });
  const [runFormErr, setRunFormErr] = useState("");
  const [payTarget, setPayTarget] = useState<{ kind: "RUN" | "ENTRY"; id: number } | null>(null);
  const [slip, setSlip] = useState<any | null>(null); // {entry, run}
  const [attForm, setAttForm] = useState<any>({ employeeId: "", date: new Date().toISOString().slice(0, 10), status: "PRESENT", hoursWorked: "8", overtimeHours: "0", leaveType: "ANNUAL", note: "" });
  const [attErr, setAttErr] = useState("");
  const [confirmDelRun, setConfirmDelRun] = useState<number | null>(null);
  const [statutory, setStatutory] = useState<any>({ config: null, note: null, updatedByName: null, updatedByRole: null, updatedAt: null });
  const [setForm, setSetForm] = useState<any>(null); // {ssnitEmployeePct, ssnitEmployerPct, tier2Pct, tier2Bearer, payeBands[], customItems[], note}
  const [setErr, setSetErr] = useState("");
  const [editSlip, setEditSlip] = useState<any | null>(null); // {entry, run}
  const [editForm, setEditForm] = useState<any>({});
  const [editErr, setEditErr] = useState("");

  const load = async (bid = bizFilter) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/payroll${bid !== "ALL" ? `?businessId=${bid}` : ""}`);
      const d = await res.json();
      if (d?.success) {
        setRuns(d.runs || []);
        setAttendance(d.attendance || []);
        setReport(d.report || { byMonth: [], byBusiness: [], composition: {} });
        setScope(d.scope);
        setStatutory(d.statutory || { config: null });
      } else setError(d?.error || "Failed to load payroll.");
    } catch (e: any) {
      setError(e?.message || "Network error.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const canManageBiz = (bid: number) =>
    scope.isOwner || (scope.canManage && (scope.businessIds === null ? true : (scope.businessIds ?? []).includes(bid)));

  const scopedBusinesses = useMemo(() => {
    const list = scope.businessIds === null ? businesses : businesses.filter((b) => (scope.businessIds ?? []).includes(b.id));
    return [...list].sort((a, b) => a.id - b.id);
  }, [businesses, scope]);

  const scopedEmployees = useMemo(
    () => employees.filter((e) => (e.status || "ACTIVE") === "ACTIVE" && (scope.businessIds === null || (scope.businessIds ?? []).includes(e.businessId))),
    [employees, scope]
  );

  const kpis = useMemo(() => {
    const k = { net: 0, paid: 0, outstanding: 0, headcount: new Set<number>(), otHours: 0, deductions: 0, base: 0, allowances: 0 };
    for (const r of runs) for (const e of r.entries) {
      k.net += e.netPayGhs; k.base += e.baseSalaryGhs; k.allowances += e.allowancesGhs;
      k.deductions += e.deductionsGhs; k.otHours += e.overtimeHours; k.headcount.add(e.employeeId);
      if (e.status === "PAID") k.paid += e.netPayGhs; else k.outstanding += e.netPayGhs;
    }
    return k;
  }, [runs]);

  const api = async (method: string, body: any) => {
    const res = await fetch("/api/payroll", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const runAction = async (runId: number, action: string) => {
    setBusy(true); setNotice(""); setError("");
    try {
      const r = await api("PATCH", { runId, action });
      if (r.status === 200 && r.body?.success) {
        setNotice(`Run ${action === "REVIEW" ? "marked REVIEWED" : action === "APPROVE" ? "APPROVED" : "returned to DRAFT"}.`);
        await load(); onChanged();
      } else setError(r.body?.error || `Failed to ${action} the run.`);
    } catch (e: any) { setError(e?.message || "Network error."); }
    finally { setBusy(false); }
  };

  const doPay = async (method: string) => {
    if (!payTarget) return;
    setBusy(true); setNotice(""); setError("");
    try {
      const r = payTarget.kind === "RUN"
        ? await api("PATCH", { runId: payTarget.id, action: "PAY_RUN", method })
        : await api("PATCH", { entryId: payTarget.id, action: "PAY_ENTRY", method });
      if (r.status === 200 && r.body?.success) {
        setNotice(`Payroll paid via ${METHODS.find(([k]) => k === method)?.[1]} — recorded as EXPENSE in Transactions & Finance.`);
        setPayTarget(null);
        await load(); onChanged();
      } else setError(r.body?.error || "Payment failed.");
    } catch (e: any) { setError(e?.message || "Network error."); }
    finally { setBusy(false); }
  };

  const createRun = async () => {
    if (!runForm.businessId) return setRunFormErr("Choose the business to run payroll for.");
    setBusy(true); setRunFormErr("");
    try {
      const r = await api("POST", {
        data: { businessId: Number(runForm.businessId), period: runForm.period, branchCode: runForm.branchCode || undefined, notes: runForm.notes || undefined },
      });
      if (r.status === 200 && r.body?.success) {
        setNotice(`Draft payroll created for ${r.body.run.branchName || r.body.run.branchCode} — ${r.body.run.totals.headcount} employee(s), net ${fmt(r.body.run.totals.net)}. Review it under Payroll Runs.`);
        setRunFormOpen(false);
        setTab("RUNS");
        await load();
      } else setRunFormErr(r.body?.error || "Failed to create the run.");
    } catch (e: any) { setRunFormErr(e?.message || "Network error."); }
    finally { setBusy(false); }
  };

  const addAttendance = async () => {
    if (!attForm.employeeId) return setAttErr("Choose an employee.");
    setBusy(true); setAttErr("");
    try {
      const r = await api("POST", {
        action: "ADD_ATTENDANCE",
        data: {
          employeeId: Number(attForm.employeeId), date: attForm.date, status: attForm.status,
          hoursWorked: Number(attForm.hoursWorked) || 0, overtimeHours: Number(attForm.overtimeHours) || 0,
          leaveType: attForm.status === "LEAVE" ? attForm.leaveType : undefined, note: attForm.note || undefined,
        },
      });
      if (r.status === 200 && r.body?.success) {
        setNotice(`Attendance recorded for ${r.body.attendance.employeeName} (${r.body.attendance.date}). Overtime here flows into the next payroll run.`);
        setAttForm((f: any) => ({ ...f, overtimeHours: "0", note: "" }));
        await load();
      } else setAttErr(r.body?.error || "Failed to record attendance.");
    } catch (e: any) { setAttErr(e?.message || "Network error."); }
    finally { setBusy(false); }
  };

  const delAttendance = async (id: number) => {
    const r = await api("DELETE", { attendanceId: id });
    if (r.status === 200) { setNotice("Attendance row removed."); await load(); }
    else setError(r.body?.error || "Remove failed.");
  };

  const deleteRun = async (runId: number) => {
    const r = await api("DELETE", { runId });
    if (r.status === 200) { setNotice("Draft run discarded."); setConfirmDelRun(null); await load(); }
    else { setError(r.body?.error || "Discard failed."); setConfirmDelRun(null); }
  };

  // ── Statutory settings ─────────────────────────────────────────────
  useEffect(() => {
    if (!statutory?.config) return;
    const c = statutory.config;
    setSetForm({
      ssnitEmployeePct: String(c.ssnitEmployeePct),
      ssnitEmployerPct: String(c.ssnitEmployerPct),
      tier2Pct: String(c.tier2Pct),
      tier2Bearer: c.tier2Bearer || "EMPLOYER",
      payeBands: (c.payeBands || []).map((b: any) => ({ upto: b.upto === null ? "" : String(b.upto), ratePct: String(b.ratePct) })),
      customItems: (c.customItems || []).map((x: any) => ({ name: x.name, pct: String(x.pct), bearer: x.bearer || "EMPLOYER", base: x.base || "BASIC" })),
      note: statutory.note || "",
    });
  }, [statutory]);

  const saveSettings = async () => {
    setBusy(true); setSetErr(""); setError(""); setNotice("");
    try {
      const payload = {
        ssnitEmployeePct: Number(setForm.ssnitEmployeePct),
        ssnitEmployerPct: Number(setForm.ssnitEmployerPct),
        tier2Pct: Number(setForm.tier2Pct),
        tier2Bearer: setForm.tier2Bearer,
        payeBands: setForm.payeBands.map((b: any) => ({ upto: b.upto === "" ? null : Number(b.upto), ratePct: Number(b.ratePct) })),
        customItems: setForm.customItems.filter((x: any) => x.name.trim()).map((x: any) => ({ name: x.name.trim(), pct: Number(x.pct), bearer: x.bearer, base: x.base })),
        note: setForm.note,
      };
      const r = await api("POST", { action: "SAVE_STATUTORY", data: payload });
      if (r.status === 200 && r.body?.success) {
        setStatutory(r.body.statutory);
        setNotice("Statutory configuration saved — it applies to new runs and any entry you adjust or recalculate. Already-paid entries never change.");
      } else setSetErr(r.body?.error || "Failed to save the statutory configuration.");
    } catch (e: any) { setSetErr(e?.message || "Network error."); }
    finally { setBusy(false); }
  };

  const recalcRun = async (runId: number) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await api("PATCH", { runId, action: "RECALC_RUN" });
      if (r.status === 200 && r.body?.success) {
        setNotice(`Recalculated ${r.body.recalculated} unpaid entr${r.body.recalculated === 1 ? "y" : "ies"} with the current statutory rates.`);
        await load();
      } else setError(r.body?.error || "Recalculation failed.");
    } catch (e: any) { setError(e?.message || "Network error."); }
    finally { setBusy(false); }
  };

  // ── Manual entry adjustment (authorized) ────────────────────────────
  const openEntryEdit = (entry: any, run: any) => {
    setEditSlip({ entry, run });
    setEditForm({
      baseSalaryGhs: String(entry.baseSalaryGhs),
      allowancesGhs: String(entry.allowancesGhs),
      allowanceNote: entry.allowanceNote || "",
      deductionsGhs: String(entry.deductionsGhs),
      deductionNote: entry.deductionNote || "",
      overtimeHours: String(entry.overtimeHours),
      applyStatutory: entry.applyStatutory !== false,
    });
    setEditErr("");
  };

  const saveEntry = async () => {
    if (!editSlip) return;
    setBusy(true); setEditErr("");
    try {
      const r = await api("PATCH", {
        entryId: editSlip.entry.id,
        action: "UPDATE_ENTRY",
        baseSalaryGhs: Number(editForm.baseSalaryGhs),
        allowancesGhs: Number(editForm.allowancesGhs),
        allowanceNote: editForm.allowanceNote,
        deductionsGhs: Number(editForm.deductionsGhs),
        deductionNote: editForm.deductionNote,
        overtimeHours: Number(editForm.overtimeHours),
        applyStatutory: editForm.applyStatutory,
      });
      if (r.status === 200 && r.body?.success) {
        setNotice(`Recalculated ${r.body.entry.employeeName}: gross ${fmt(r.body.entry.grossPayGhs)} → net ${fmt(r.body.entry.netPayGhs)}.`);
        setEditSlip(null);
        await load();
      } else setEditErr(r.body?.error || "Failed to save the adjustment.");
    } catch (e: any) { setEditErr(e?.message || "Network error."); }
    finally { setBusy(false); }
  };

  // ── Downloads: CSV / PDF / XLSX — per run or combined ───────────────
  const reportRows = (list: any[]) =>
    list.flatMap((r) =>
      r.entries.map((e: any) => ({
        period: r.period, business: r.branchName || "", branch: r.branchCode,
        employee: e.employeeName, role: e.employeeRole || "",
        base: e.baseSalaryGhs, allowances: e.allowancesGhs, otHours: e.overtimeHours, otPay: e.overtimePayGhs,
        gross: e.grossPayGhs ?? null, ssnitEmp: e.ssnitEmployeeGhs ?? null, paye: e.payeGhs ?? null,
        manualDed: e.deductionsGhs, totalDed: e.totalEmployeeDeductionsGhs ?? null,
        ssnitEr: e.ssnitEmployerGhs ?? null, tier2: e.tier2Ghs ?? null,
        erContrib: e.employerContributionsGhs ?? null, erCost: e.employerCostGhs ?? null,
        net: e.netPayGhs, status: e.status, method: e.paymentMethod || "",
        paidAt: e.paidAt ? new Date(e.paidAt).toLocaleString() : "",
        ledger: e.transactionId ? `#${e.transactionId}` : "",
      }))
    );

  const CSV_HEAD = "Period,Business,Branch,Employee,Role,Base GH₵,Allowances GH₵,OT Hours,OT Pay GH₵,Gross GH₵,SSNIT 5.5% (EE),PAYE,Other Deductions,Total Deductions,Net Pay GH₵,SSNIT 13% (ER),Tier-2,Employer Contributions,Employer Cost,Status,Method,Paid At,Ledger";

  const downloadCsv = (list: any[] = runs, name?: string) => {
    const rows = reportRows(list).map((x) =>
      [x.period, x.business, x.branch, x.employee, x.role, x.base, x.allowances, x.otHours, x.otPay,
       x.gross ?? "legacy", x.ssnitEmp ?? "", x.paye ?? "", x.manualDed, x.totalDed ?? "",
       x.net, x.ssnitEr ?? "", x.tier2 ?? "", x.erContrib ?? "", x.erCost ?? "",
       x.status, x.method, x.paidAt, x.ledger]
        .map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")
    );
    const blob = new Blob([[CSV_HEAD, ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name || `payroll-report-${bizFilter === "ALL" ? "all" : bizFilter}.csv`;
    a.click();
  };

  const downloadPdf = async (list: any[] = runs, name?: string) => {
    const { jsPDF } = await import("jspdf");
    const autoTable = (await import("jspdf-autotable")).default;
    const doc = new jsPDF({ orientation: "landscape" });
    const rows = reportRows(list);
    // Logo: the run's business/branch (single-run downloads), the filtered
    // business, or the company logo for the combined report.
    let pdfLogo: string | null = null;
    if (list.length === 1) {
      pdfLogo = resolveLogo(businesses.find((b) => b.id === list[0].businessId), list[0].branchCode);
    } else if (bizFilter !== "ALL") {
      pdfLogo = resolveLogo(businesses.find((b) => String(b.id) === String(bizFilter)), null);
    } else {
      pdfLogo = getCompanyLogo();
    }
    let titleX = 14;
    if (pdfLogo) {
      try {
        const props = doc.getImageProperties(pdfLogo);
        const scale = Math.min(20 / props.width, 13 / props.height);
        const w = props.width * scale;
        const h = props.height * scale;
        doc.addImage(pdfLogo, props.fileType || "JPEG", 14, 4, w, h);
        titleX = 14 + w + 4;
      } catch { /* logo is best-effort */ }
    }
    doc.setFontSize(14);
    doc.text("GoMina 360 — Payroll Report", titleX, 12);
    doc.setFontSize(8);
    doc.text(`Generated ${new Date().toLocaleString()} · ${rows.length} entr${rows.length === 1 ? "y" : "ies"} · SSNIT T1 ${statutory?.config?.ssnitEmployeePct}%EE/${statutory?.config?.ssnitEmployerPct}%ER · Tier-2 ${statutory?.config?.tier2Pct}% (${statutory?.config?.tier2Bearer})`, titleX, 17);
    autoTable(doc, {
      startY: 21,
      styles: { fontSize: 6.5, cellPadding: 1 },
      headStyles: { fillColor: [15, 118, 110] },
      head: [["Period", "Business", "Employee", "Role", "Base", "Allow", "OT Pay", "Gross", "SSNIT EE", "PAYE", "Other Ded", "Total Ded", "Net", "SSNIT ER", "Tier-2", "ER Cost", "Status"]],
      body: rows.map((x) => [
        x.period, x.business, x.employee, x.role, x.base, x.allowances, x.otPay,
        x.gross ?? "legacy", x.ssnitEmp ?? "", x.paye ?? "", x.manualDed, x.totalDed ?? "",
        x.net, x.ssnitEr ?? "", x.tier2 ?? "", x.erCost ?? "", x.status,
      ]),
      foot: [[
        "TOTALS", "", "", "",
        rows.reduce((s, x) => s + x.base, 0).toFixed(2), rows.reduce((s, x) => s + x.allowances, 0).toFixed(2),
        rows.reduce((s, x) => s + x.otPay, 0).toFixed(2), rows.reduce((s, x) => s + (x.gross || 0), 0).toFixed(2),
        rows.reduce((s, x) => s + (x.ssnitEmp || 0), 0).toFixed(2), rows.reduce((s, x) => s + (x.paye || 0), 0).toFixed(2),
        rows.reduce((s, x) => s + x.manualDed, 0).toFixed(2), rows.reduce((s, x) => s + (x.totalDed || 0), 0).toFixed(2),
        rows.reduce((s, x) => s + x.net, 0).toFixed(2), rows.reduce((s, x) => s + (x.ssnitEr || 0), 0).toFixed(2),
        rows.reduce((s, x) => s + (x.tier2 || 0), 0).toFixed(2), rows.reduce((s, x) => s + (x.erCost || 0), 0).toFixed(2), "",
      ]],
    });
    doc.save(name || `payroll-report-${bizFilter === "ALL" ? "all" : bizFilter}.pdf`);
  };

  const downloadXlsx = async (list: any[] = runs, name?: string) => {
    const ExcelJS = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Payroll");
    ws.addRow(["Period", "Business", "Branch", "Employee", "Role", "Base GH₵", "Allowances GH₵", "OT Hours", "OT Pay GH₵", "Gross GH₵", "SSNIT (EE)", "PAYE", "Other Deductions", "Total Deductions", "Net Pay GH₵", "SSNIT (ER)", "Tier-2", "Employer Contributions", "Employer Cost", "Status", "Method", "Paid At", "Ledger"]);
    ws.getRow(1).font = { bold: true };
    for (const x of reportRows(list)) {
      ws.addRow([x.period, x.business, x.branch, x.employee, x.role, x.base, x.allowances, x.otHours, x.otPay, x.gross ?? "legacy", x.ssnitEmp ?? "", x.paye ?? "", x.manualDed, x.totalDed ?? "", x.net, x.ssnitEr ?? "", x.tier2 ?? "", x.erContrib ?? "", x.erCost ?? "", x.status, x.method, x.paidAt, x.ledger]);
    }
    ws.columns.forEach((c) => { c.width = 14; });
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name || `payroll-report-${bizFilter === "ALL" ? "all" : bizFilter}.xlsx`;
    a.click();
  };

  const printSlip = (run: any, e: any) => {
    const biz = businesses.find((b) => b.id === e.businessId);
    const slipLogo = resolveLogo(biz, e.branchCode);
    const html = `<!doctype html><html><head><title>Payslip — ${e.employeeName} — ${periodLabel(run.period)}</title>
      <style>body{font-family:Arial,sans-serif;color:#0f172a;padding:32px;max-width:640px;margin:auto}
      h1{font-size:20px;margin:0}h2{font-size:14px;color:#475569;margin:4px 0 16px}
      table{width:100%;border-collapse:collapse;margin-top:12px}td,th{border:1px solid #cbd5e1;padding:8px;font-size:13px;text-align:left}
      .num{text-align:right}.net{background:#ecfdf5;font-weight:bold}.muted{color:#64748b;font-size:12px}
      .badge{display:inline-block;padding:2px 10px;border:1px solid #0f172a;border-radius:999px;font-size:11px}</style></head><body>
      ${slipLogo ? `<img src="${slipLogo}" alt="logo" style="max-height:64px;max-width:170px;object-fit:contain;margin-bottom:8px"/>` : ""}
      <h1>GoMina 360 — Payslip</h1>
      <h2>${biz?.name || ""} · Branch ${e.branchCode} · ${periodLabel(run.period)}</h2>
      <p><b>${e.employeeName}</b> — ${e.employeeRole || "Staff"} <span class="badge">${e.status}</span></p>
      <table><tr><th>Earnings</th><th class="num">GH₵</th></tr>
      <tr><td>Base salary</td><td class="num">${fmt(e.baseSalaryGhs)}</td></tr>
      <tr><td>Allowances${e.allowanceNote ? ` (${e.allowanceNote})` : ""}</td><td class="num">${fmt(e.allowancesGhs)}</td></tr>
      <tr><td>Overtime (${e.overtimeHours} hrs)</td><td class="num">${fmt(e.overtimePayGhs)}</td></tr>
      ${e.grossPayGhs != null ? `<tr><td><b>GROSS PAY</b></td><td class="num"><b>${fmt(e.grossPayGhs)}</b></td></tr>
      <tr><th>Employee deductions</th><th class="num"></th></tr>
      <tr><td>SSNIT Tier-1 (employee)</td><td class="num">−${fmt(e.ssnitEmployeeGhs)}</td></tr>
      ${e.tier2Ghs > 0 && e.tier2Bearer === "EMPLOYEE" ? `<tr><td>Tier-2 pension</td><td class="num">−${fmt(e.tier2Ghs)}</td></tr>` : ""}
      ${(e.customDeductions || []).filter((c: any) => c.bearer === "EMPLOYEE").map((c: any) => `<tr><td>${c.name}</td><td class="num">−${fmt(c.amount)}</td></tr>`).join("")}
      <tr><td>PAYE tax (taxable ${fmt(e.taxableIncomeGhs)})</td><td class="num">−${fmt(e.payeGhs)}</td></tr>
      <tr><td>Other deductions${e.deductionNote ? ` (${e.deductionNote})` : ""}</td><td class="num">−${fmt(e.deductionsGhs)}</td></tr>
      <tr><td><b>Total employee deductions</b></td><td class="num"><b>−${fmt(e.totalEmployeeDeductionsGhs)}</b></td></tr>`
      : `<tr><th>Deductions</th><th class="num"></th></tr>
      <tr><td>Deductions${e.deductionNote ? ` (${e.deductionNote})` : ""}</td><td class="num">−${fmt(e.deductionsGhs)}</td></tr>`}
      <tr class="net"><td>NET PAY</td><td class="num">${fmt(e.netPayGhs)}</td></tr>
      ${e.grossPayGhs != null ? `<tr><th>Employer contributions (not deducted from pay)</th><th class="num"></th></tr>
      <tr><td>SSNIT Tier-1 (employer)</td><td class="num">${fmt(e.ssnitEmployerGhs)}</td></tr>
      ${e.tier2Ghs > 0 && e.tier2Bearer !== "EMPLOYEE" ? `<tr><td>Tier-2 pension (employer)</td><td class="num">${fmt(e.tier2Ghs)}</td></tr>` : ""}
      ${(e.customDeductions || []).filter((c: any) => c.bearer !== "EMPLOYEE").map((c: any) => `<tr><td>${c.name}</td><td class="num">${fmt(c.amount)}</td></tr>`).join("")}
      <tr><td><b>Total employer cost</b></td><td class="num"><b>${fmt(e.employerCostGhs)}</b></td></tr>` : ""}</table>
      <p class="muted">Payment: ${e.status === "PAID" ? `${METHODS.find(([k]) => k === e.paymentMethod)?.[1]} on ${new Date(e.paidAt).toLocaleString()} by ${e.paidByName}` : "PENDING"}${e.transactionId ? ` · Ledger ref #${e.transactionId}` : ""}</p>
      <p class="muted">Generated by GoMina 360 · ${new Date().toLocaleString()}</p></body></html>`;
    const w = window.open("", "_blank", "width=720,height=840");
    if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 300); }
    else {
      let area = document.getElementById("prl-print-area");
      if (!area) { area = document.createElement("div"); area.id = "prl-print-area"; document.body.appendChild(area); }
      area.innerHTML = html;
      const style = document.createElement("style");
      style.id = "prl-print-style";
      style.textContent = "@media print { body * { visibility: hidden; } #prl-print-area, #prl-print-area * { visibility: visible; } #prl-print-area { position: absolute; inset: 0; } }";
      document.head.appendChild(style);
      window.print();
    }
  };

  const inputCls = "w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-teal-500";
  const labelCls = "block text-[11px] font-semibold text-slate-400 mb-1";

  const Kpi = ({ label, value, sub, tint }: any) => (
    <div className="bg-slate-900/80 border border-slate-700/80 rounded-xl p-3.5">
      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`text-lg font-extrabold mt-0.5 ${tint || "text-white"}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-3 sm:p-5" data-testid="prl-root">
      <div className="bg-slate-950 border border-slate-700 rounded-2xl w-full max-w-7xl shadow-2xl flex flex-col max-h-[94vh] overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 bg-slate-900/80 flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-teal-500 to-emerald-700 flex items-center justify-center text-white shadow-lg shrink-0">
            <Landmark className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-white">Payroll Command Center</h3>
            <p className="text-[11px] text-slate-400">Employee → Business → Branch → Finance → Reports • salaries, allowances, overtime, deductions, net pay</p>
          </div>
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <select
              value={bizFilter}
              onChange={(e) => { setBizFilter(e.target.value); load(e.target.value); }}
              className="px-2.5 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs"
              data-testid="prl-biz-filter"
            >
              <option value="ALL">All businesses</option>
              {scopedBusinesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <AiSectionGuide moduleKey="PAYROLL" section="DEFAULT" variant="header" />
            <button onClick={() => load()} className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300" title="Refresh" data-testid="prl-refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            {(scope.isOwner || scope.canManage) && (
              <button
                onClick={() => { setRunForm({ ...runForm, businessId: bizFilter !== "ALL" ? bizFilter : scopedBusinesses[0]?.id || "" }); setRunFormErr(""); setRunFormOpen(true); }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold shadow"
                data-testid="prl-run-new"
              >
                <Plus className="w-4 h-4" /> New Payroll Run
              </button>
            )}
            <button onClick={onClose} className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white" aria-label="Close" data-testid="prl-close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {notice && <div className="mx-5 mt-3 px-3 py-2 rounded-lg text-xs bg-emerald-500/10 border border-emerald-500/30 text-emerald-300" data-testid="prl-notice">{notice}</div>}
        {error && <div className="mx-5 mt-3 px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300" data-testid="prl-error">{error}</div>}

        {/* KPI strip */}
        <div className="px-5 pt-3 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Kpi label="Total Net Pay" value={fmt(kpis.net)} sub={`${kpis.headcount.size} employee(s)`} />
          <Kpi label="Paid Out" value={fmt(kpis.paid)} tint="text-emerald-400" />
          <Kpi label="Outstanding Payroll" value={fmt(kpis.outstanding)} tint="text-rose-400" />
          <Kpi label="Base Salaries" value={fmt(kpis.base)} sub={`allowances ${fmt(kpis.allowances)}`} />
          <Kpi label="Overtime" value={`${Number(kpis.otHours.toFixed(1))} hrs`} tint="text-cyan-300" />
          <Kpi label="Deductions" value={fmt(kpis.deductions)} tint="text-amber-300" />
        </div>

        {/* Tabs */}
        <div className="px-5 pt-3 flex items-center gap-1.5 flex-wrap" data-testid="prl-tabs">
          {TABS.filter(([key]) => key !== "SETTINGS" || scope.isOwner || scope.canManage).map(([key, labelTxt, Icon]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition ${
                tab === key ? "bg-teal-600 text-white shadow" : "bg-slate-800/70 text-slate-300 hover:bg-slate-700"
              }`}
              data-testid={`prl-tab-${key}`}
            >
              <Icon className="w-4 h-4" />
              <span>{labelTxt}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* ── OVERVIEW ─────────────────────────────────────────── */}
          {tab === "OVERVIEW" && (
            <div className="space-y-4">
              {runs.length === 0 && !loading && (
                <div className="text-center py-14 space-y-3 bg-slate-900/60 border border-slate-800 rounded-2xl" data-testid="prl-empty">
                  <Wallet className="w-10 h-10 text-slate-600 mx-auto" />
                  <p className="text-slate-400 text-sm">No payroll runs yet in this scope.</p>
                  {(scope.isOwner || scope.canManage) && (
                    <button onClick={() => setRunFormOpen(true)} className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold">
                      <Plus className="w-3.5 h-3.5 inline mr-1" /> Create the first payroll run
                    </button>
                  )}
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="prl-overview-runs">
                {runs.slice(0, 6).map((r) => (
                  <button key={r.id} onClick={() => { setTab("RUNS"); setExpanded(r.id); }}
                    className="text-left bg-slate-900 border border-slate-700/80 rounded-xl p-4 hover:border-teal-500/50 transition space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-white text-sm">{r.branchName} — {periodLabel(r.period)}</span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${RUN_STYLE[r.status]}`}>{r.status}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div><div className="text-[10px] text-slate-500 uppercase">Net</div><div className="text-sm font-bold text-white">{fmt(r.totals.net)}</div></div>
                      <div><div className="text-[10px] text-slate-500 uppercase">Paid</div><div className="text-sm font-bold text-emerald-400">{fmt(r.totals.paid)}</div></div>
                      <div><div className="text-[10px] text-slate-500 uppercase">Outstanding</div><div className="text-sm font-bold text-rose-400">{fmt(r.totals.outstanding)}</div></div>
                    </div>
                    <div className="text-[11px] text-slate-500">{r.totals.headcount} employee(s) · OT {r.totals.overtimeHours} hrs · deductions {fmt(r.totals.deductions)}</div>
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-slate-500">Payments post EXPENSE transactions (category “Staff Payroll”) — Finance dashboards, the central Financial Report and business reports update the moment someone is paid.</p>
            </div>
          )}

          {/* ── RUNS ─────────────────────────────────────────────── */}
          {tab === "RUNS" && (
            <div className="space-y-3">
              {runs.map((r) => {
                const manageable = canManageBiz(r.businessId);
                const open = expanded === r.id;
                return (
                  <div key={r.id} className="bg-slate-900 border border-slate-700/80 rounded-xl overflow-hidden" data-testid={`prl-run-${r.id}`}>
                    <div className="p-4 flex flex-wrap items-center gap-3">
                      <button onClick={() => setExpanded(open ? null : r.id)} className="flex items-center gap-2 text-left min-w-0" data-testid={`prl-run-toggle-${r.id}`}>
                        {open ? <ChevronUp className="w-4 h-4 text-teal-400" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
                        <div>
                          <div className="font-bold text-white text-sm">{r.branchName} — {periodLabel(r.period)}</div>
                          <div className="text-[11px] text-slate-500">{r.totals.headcount} employees · net {fmt(r.totals.net)} · outstanding {fmt(r.totals.outstanding)}</div>
                        </div>
                      </button>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${RUN_STYLE[r.status]}`}>{r.status}</span>
                      <div className="ml-auto flex items-center gap-1.5 flex-wrap">
                        {manageable && r.status === "DRAFT" && (
                          <>
                            <button onClick={() => runAction(r.id, "REVIEW")} disabled={busy} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-cyan-600/20 hover:bg-cyan-600/40 text-cyan-300 border border-cyan-500/30 text-[11px] font-bold" data-testid={`prl-run-review-${r.id}`}>
                              <Eye className="w-3.5 h-3.5" /> Mark Reviewed
                            </button>
                            {confirmDelRun === r.id ? (
                              <>
                                <button onClick={() => deleteRun(r.id)} className="px-2.5 py-1.5 rounded-lg bg-rose-600 text-white text-[11px] font-bold" data-testid={`prl-run-del-confirm-${r.id}`}>Discard?</button>
                                <button onClick={() => setConfirmDelRun(null)} className="px-2 py-1.5 rounded-lg bg-slate-800 text-slate-400 text-[11px]">Keep</button>
                              </>
                            ) : (
                              <button onClick={() => setConfirmDelRun(r.id)} className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300" title="Discard draft" data-testid={`prl-run-delete-${r.id}`}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </>
                        )}
                        {manageable && r.status === "REVIEWED" && (
                          <>
                            <button onClick={() => runAction(r.id, "APPROVE")} disabled={busy} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/35 text-amber-300 border border-amber-500/40 text-[11px] font-bold" data-testid={`prl-run-approve-${r.id}`}>
                              <ThumbsUp className="w-3.5 h-3.5" /> Approve
                            </button>
                            <button onClick={() => runAction(r.id, "REVERT")} className="px-2.5 py-1.5 rounded-lg bg-slate-800 text-slate-400 text-[11px]">Back to Draft</button>
                          </>
                        )}
                        {manageable && r.status === "APPROVED" && (
                          <button onClick={() => setPayTarget({ kind: "RUN", id: r.id })} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold shadow" data-testid={`prl-run-pay-${r.id}`}>
                            <PlayCircle className="w-3.5 h-3.5" /> Pay All ({fmt(r.totals.outstanding)})
                          </button>
                        )}
                        {r.status === "PAID" && <span className="text-[11px] text-emerald-400 font-bold flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" /> Fully paid {r.paidAt ? `· ${new Date(r.paidAt).toLocaleDateString()}` : ""}</span>}
                      </div>
                    </div>
                    {payTarget?.kind === "RUN" && payTarget.id === r.id && (
                      <div className="px-4 pb-3 flex items-center gap-2 flex-wrap" data-testid={`prl-paymethods-${r.id}`}>
                        <span className="text-[11px] text-slate-400">Pay every pending entry via:</span>
                        {METHODS.map(([k, v]) => (
                          <button key={k} onClick={() => doPay(k)} disabled={busy} className="px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/50 text-emerald-300 border border-emerald-500/40 text-[11px] font-bold" data-testid={`prl-paymethod-${k}-${r.id}`}>{v}</button>
                        ))}
                        <button onClick={() => setPayTarget(null)} className="px-2 py-1.5 text-slate-500 text-[11px]">Cancel</button>
                      </div>
                    )}
                    {open && r.totals.gross > 0 && (
                      <div className="px-4 py-2.5 border-t border-slate-800 bg-slate-950/50 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px]" data-testid={`prl-run-statutory-${r.id}`}>
                        <span className="text-slate-500 font-bold uppercase tracking-wider">Breakdown</span>
                        <span className="text-slate-300">Gross <b className="text-white">{fmt(r.totals.gross)}</b></span>
                        <span className="text-rose-300">SSNIT EE <b>{fmt(r.totals.ssnitEmployee)}</b></span>
                        <span className="text-rose-300">PAYE <b>{fmt(r.totals.paye)}</b></span>
                        <span className="text-amber-300">Other ded. <b>{fmt(roundOff(r.totals.employeeDeductions - r.totals.ssnitEmployee - r.totals.paye))}</b></span>
                        <span className="text-emerald-300">Net <b>{fmt(r.totals.net)}</b></span>
                        <span className="text-slate-500">|</span>
                        <span className="text-sky-300">ER SSNIT <b>{fmt(r.totals.ssnitEmployer)}</b></span>
                        <span className="text-sky-300">Tier-2 <b>{fmt(r.totals.tier2)}</b></span>
                        <span className="text-violet-300">Employer cost <b>{fmt(r.totals.employerCost)}</b></span>
                      </div>
                    )}
                    {open && r.status !== "PAID" && manageable && r.totals.gross > 0 && (
                      <div className="px-4 pb-2 bg-slate-950/50 flex items-center gap-2">
                        <button onClick={() => recalcRun(r.id)} disabled={busy} className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold" data-testid={`prl-run-recalc-${r.id}`}>
                          Recalculate with current statutory rates
                        </button>
                      </div>
                    )}
                    {open && (
                      <table className="w-full text-left text-xs border-t border-slate-800">
                        <thead className="bg-slate-950/80 text-slate-400 uppercase text-[10px] tracking-wider">
                          <tr>
                            <th className="px-4 py-2">Employee</th><th className="px-3 py-2 text-right">Base</th><th className="px-3 py-2 text-right">Allowances</th>
                            <th className="px-3 py-2 text-right">Overtime</th><th className="px-3 py-2 text-right">Gross</th><th className="px-3 py-2 text-right">Deductions</th><th className="px-3 py-2 text-right">Net Pay</th>
                            <th className="px-3 py-2 text-center">Status</th><th className="px-3 py-2 text-center">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/70">
                          {r.entries.map((e: any) => (
                            <tr key={e.id} className="text-slate-300" data-testid={`prl-entry-${e.id}`}>
                              <td className="px-4 py-2.5"><div className="font-bold text-slate-100">{e.employeeName}</div><div className="text-[10px] text-slate-500">{e.employeeRole}</div></td>
                              <td className="px-3 py-2.5 text-right">{fmt(e.baseSalaryGhs)}</td>
                              <td className="px-3 py-2.5 text-right text-cyan-300">{fmt(e.allowancesGhs)}</td>
                              <td className="px-3 py-2.5 text-right text-cyan-300">{e.overtimeHours}h · {fmt(e.overtimePayGhs)}</td>
                              <td className="px-3 py-2.5 text-right font-semibold text-slate-100">{e.grossPayGhs != null ? fmt(e.grossPayGhs) : "—"}</td>
                              <td className="px-3 py-2.5 text-right text-amber-300" data-testid={`prl-entry-ded-${e.id}`}>
                                {e.grossPayGhs != null ? (
                                  <>
                                    <div>{fmt(e.totalEmployeeDeductionsGhs)}</div>
                                    <div className="text-[9px] text-slate-500">
                                      SSNIT {fmt(e.ssnitEmployeeGhs)} · PAYE {fmt(e.payeGhs)}
                                      {e.deductionsGhs > 0 ? ` · other ${fmt(e.deductionsGhs)}` : ""}
                                    </div>
                                  </>
                                ) : fmt(e.deductionsGhs)}
                              </td>
                              <td className="px-3 py-2.5 text-right font-extrabold text-white">{fmt(e.netPayGhs)}</td>
                              <td className="px-3 py-2.5 text-center">
                                <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold ${e.status === "PAID" ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"}`}>{e.status}</span>
                                {e.status === "PAID" && <div className="text-[9px] text-slate-500 mt-0.5">{METHODS.find(([k]) => k === e.paymentMethod)?.[1]}</div>}
                              </td>
                              <td className="px-3 py-2.5 text-center whitespace-nowrap">
                                <button onClick={() => setSlip({ entry: e, run: r })} className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 mr-1" title="Payslip" data-testid={`prl-entry-slip-${e.id}`}>
                                  <FileText className="w-3.5 h-3.5" />
                                </button>
                                {manageable && e.status !== "PAID" && r.status !== "PAID" && (
                                  <button onClick={() => openEntryEdit(e, r)} className="p-1 rounded bg-slate-800 hover:bg-teal-600/30 text-slate-300 hover:text-teal-300 mr-1" title="Manual adjustment (authorized)" data-testid={`prl-entry-edit-${e.id}`}>
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                {manageable && e.status !== "PAID" && r.status === "APPROVED" && (
                                  <button onClick={() => setPayTarget({ kind: "ENTRY", id: e.id })} className="p-1 rounded bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-300" title="Pay this employee" data-testid={`prl-entry-pay-${e.id}`}>
                                    <Wallet className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                {payTarget?.kind === "ENTRY" && payTarget.id === e.id && (
                                  <span className="inline-flex gap-1 ml-1">
                                    {METHODS.map(([k, v]) => (
                                      <button key={k} onClick={() => doPay(k)} disabled={busy} className="px-1.5 py-0.5 rounded bg-emerald-600/30 text-emerald-200 text-[9px] font-bold" data-testid={`prl-paymethod-${k}-e${e.id}`}>{v}</button>
                                    ))}
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── ATTENDANCE ───────────────────────────────────────── */}
          {tab === "ATTENDANCE" && (
            <div className="space-y-4">
              {/* Live clock-in/out log with GPS — manager/supervisor review;
                  hours + OT here flow into the register below and the next run. */}
              <AttendanceReviewPanel currentUser={currentUser} businesses={businesses} employees={employees} />
              {(scope.isOwner || scope.canManage) && (
                <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-4 space-y-3" data-testid="prl-att-form">
                  <div className="text-xs font-bold text-teal-300 uppercase tracking-wider flex items-center gap-2"><CalendarClock className="w-4 h-4" /> Record attendance, leave & overtime</div>
                  {attErr && <div className="text-rose-300 text-xs bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2" data-testid="prl-att-error">{attErr}</div>}
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 items-end">
                    <div className="col-span-2">
                      <label className={labelCls}>Employee</label>
                      <select className={inputCls} value={attForm.employeeId} onChange={(e) => setAttForm({ ...attForm, employeeId: e.target.value })} data-testid="prl-att-employee">
                        <option value="">Select employee…</option>
                        {scopedEmployees.map((emp) => (
                          <option key={emp.id} value={emp.id}>{emp.name} — {businesses.find((b) => b.id === emp.businessId)?.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>Date</label>
                      <input type="date" className={inputCls} value={attForm.date} onChange={(e) => setAttForm({ ...attForm, date: e.target.value })} data-testid="prl-att-date" />
                    </div>
                    <div>
                      <label className={labelCls}>Status</label>
                      <select className={inputCls} value={attForm.status} onChange={(e) => setAttForm({ ...attForm, status: e.target.value })} data-testid="prl-att-status">
                        <option value="PRESENT">Present</option><option value="HALF_DAY">Half day</option><option value="ABSENT">Absent</option><option value="LEAVE">Leave</option><option value="OFF_DAY">Off day</option>
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>Hours worked</label>
                      <input type="number" className={inputCls} value={attForm.hoursWorked} onChange={(e) => setAttForm({ ...attForm, hoursWorked: e.target.value })} data-testid="prl-att-hours" />
                    </div>
                    <div>
                      <label className={labelCls}>Overtime (hrs)</label>
                      <input type="number" className={inputCls} value={attForm.overtimeHours} onChange={(e) => setAttForm({ ...attForm, overtimeHours: e.target.value })} data-testid="prl-att-ot" />
                    </div>
                    {attForm.status === "LEAVE" && (
                      <div>
                        <label className={labelCls}>Leave type</label>
                        <select className={inputCls} value={attForm.leaveType} onChange={(e) => setAttForm({ ...attForm, leaveType: e.target.value })} data-testid="prl-att-leave">
                          <option value="ANNUAL">Annual</option><option value="SICK">Sick</option><option value="MATERNITY">Maternity</option><option value="UNPAID">Unpaid</option>
                        </select>
                      </div>
                    )}
                    <div className="col-span-2">
                      <label className={labelCls}>Note</label>
                      <input className={inputCls} value={attForm.note} onChange={(e) => setAttForm({ ...attForm, note: e.target.value })} placeholder="optional" data-testid="prl-att-note" />
                    </div>
                    <button onClick={addAttendance} disabled={busy} className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold h-fit" data-testid="prl-att-save">Save</button>
                  </div>
                </div>
              )}
              <div className="bg-slate-900 border border-slate-700/80 rounded-xl overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-950/80 text-slate-400 uppercase text-[10px] tracking-wider">
                    <tr>
                      <th className="px-4 py-2">Date</th><th className="px-3 py-2">Employee</th><th className="px-3 py-2">Business · Branch</th>
                      <th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Hours</th><th className="px-3 py-2 text-right">OT</th>
                      <th className="px-3 py-2">Leave</th><th className="px-3 py-2">Recorded by</th><th className="px-3 py-2 text-center"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70" data-testid="prl-att-rows">
                    {attendance.slice(0, 30).map((a) => (
                      <tr key={a.id} className="text-slate-300" data-testid={`prl-att-row-${a.id}`}>
                        <td className="px-4 py-2 font-mono">{a.date}</td>
                        <td className="px-3 py-2 font-semibold text-slate-100">{a.employeeName}{a.note ? <span className="block text-[10px] font-normal italic text-slate-500" data-testid={`prl-att-note-${a.id}`}>{a.note}</span> : null}</td>
                        <td className="px-3 py-2">{businesses.find((b) => b.id === a.businessId)?.name} · <span className="font-mono text-[10px] text-cyan-300">{a.branchCode}</span></td>
                        <td className={`px-3 py-2 font-bold ${ATT_STYLE[a.status] || ""}`}>{a.status}</td>
                        <td className="px-3 py-2 text-right">{a.hoursWorked}</td>
                        <td className="px-3 py-2 text-right text-cyan-300">{a.overtimeHours}</td>
                        <td className="px-3 py-2">{a.leaveType || "—"}</td>
                        <td className="px-3 py-2 text-slate-500">{a.recordedByName}</td>
                        <td className="px-3 py-2 text-center">
                          {canManageBiz(a.businessId) && (
                            <button onClick={() => delAttendance(a.id)} className="p-1 rounded bg-slate-800 hover:bg-rose-500/20 text-slate-500 hover:text-rose-300" data-testid={`prl-att-del-${a.id}`}>
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── REPORTS ──────────────────────────────────────────── */}
          {tab === "REPORTS" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h4 className="text-sm font-bold text-white flex items-center gap-2"><BarChart3 className="w-4 h-4 text-teal-400" /> Payroll cost, statutory remittances, deductions, overtime & trends</h4>
                <div className="flex items-center gap-1.5" data-testid="prl-dl-all">
                  <button onClick={() => downloadCsv()} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold" data-testid="prl-csv">
                    <FileSpreadsheet className="w-4 h-4 text-emerald-400" /> CSV
                  </button>
                  <button onClick={() => downloadPdf()} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold" data-testid="prl-dl-pdf-all">
                    <Download className="w-4 h-4 text-rose-400" /> PDF
                  </button>
                  <button onClick={() => downloadXlsx()} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold" data-testid="prl-dl-xlsx-all">
                    <FileSpreadsheet className="w-4 h-4 text-sky-400" /> Excel
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-4" data-testid="prl-chart-trend">
                  <div className="text-[11px] font-bold text-slate-400 uppercase mb-2">Monthly payroll trend (GH₵)</div>
                  <div className="h-60">
                    <ResponsiveContainer>
                      <BarChart data={report.byMonth}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis dataKey="period" stroke="#64748b" fontSize={10} />
                        <YAxis stroke="#64748b" fontSize={10} tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`} />
                        <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }} formatter={(v: any) => fmt(Number(v))} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Bar dataKey="base" name="Base salaries" stackId="a" fill="#0d9488" radius={[0, 0, 0, 0]} />
                        <Bar dataKey="allowances" name="Allowances" stackId="a" fill="#22d3ee" />
                        <Bar dataKey="overtime" name="Overtime" stackId="a" fill="#818cf8" radius={[3, 3, 0, 0]} />
                        <Bar dataKey="deductions" name="Deductions" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-4" data-testid="prl-chart-mix">
                  <div className="text-[11px] font-bold text-slate-400 uppercase mb-2">Cost composition (all-time, scoped)</div>
                  <div className="h-60">
                    <ResponsiveContainer>
                      <PieChart>
                        <Pie
                          data={[
                            { name: "Base salaries", value: report.composition.base || 0 },
                            { name: "Allowances", value: report.composition.allowances || 0 },
                            { name: "Overtime", value: report.composition.overtime || 0 },
                            { name: "Deductions", value: report.composition.deductions || 0 },
                          ]}
                          dataKey="value" nameKey="name" innerRadius={50} outerRadius={85} paddingAngle={2}
                        >
                          {["#0d9488", "#22d3ee", "#818cf8", "#f59e0b"].map((c) => <Cell key={c} fill={c} />)}
                        </Pie>
                        <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }} formatter={(v: any) => fmt(Number(v))} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-4 lg:col-span-2" data-testid="prl-chart-biz">
                  <div className="text-[11px] font-bold text-slate-400 uppercase mb-2">Payroll cost by business — paid vs outstanding (GH₵)</div>
                  <div className="h-56">
                    <ResponsiveContainer>
                      <BarChart data={report.byBusiness} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis type="number" stroke="#64748b" fontSize={10} tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`} />
                        <YAxis type="category" dataKey="name" stroke="#64748b" fontSize={10} width={150} />
                        <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }} formatter={(v: any) => fmt(Number(v))} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Bar dataKey="paid" name="Paid" fill="#10b981" radius={[0, 3, 3, 0]} />
                        <Bar dataKey="outstanding" name="Outstanding" fill="#f43f5e" radius={[0, 3, 3, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
              <div className="bg-slate-900 border border-slate-700/80 rounded-xl overflow-hidden" data-testid="prl-report-table">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-950/80 text-slate-400 uppercase text-[10px] tracking-wider">
                    <tr><th className="px-4 py-2">Business</th><th className="px-3 py-2 text-right">Employees paid</th><th className="px-3 py-2 text-right">Net payroll</th><th className="px-3 py-2 text-right">Paid</th><th className="px-3 py-2 text-right">Outstanding</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {report.byBusiness.map((b: any) => (
                      <tr key={b.businessId} className="text-slate-300">
                        <td className="px-4 py-2 font-semibold text-slate-100">{b.name}</td>
                        <td className="px-3 py-2 text-right">{b.headcount}</td>
                        <td className="px-3 py-2 text-right font-bold text-white">{fmt(b.net)}</td>
                        <td className="px-3 py-2 text-right text-emerald-400">{fmt(b.paid)}</td>
                        <td className="px-3 py-2 text-right text-rose-400">{fmt(b.outstanding)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Statutory remittance summary — what must be paid to SSNIT / GRA */}
              <div className="bg-slate-900 border border-slate-700/80 rounded-xl overflow-hidden" data-testid="prl-remit-panel">
                <div className="px-4 py-3 border-b border-slate-800 text-xs font-bold text-sky-300 uppercase tracking-wider">
                  Statutory remittance summary (per payroll month)
                </div>
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-950/80 text-slate-400 uppercase text-[10px] tracking-wider">
                    <tr>
                      <th className="px-4 py-2">Month</th>
                      <th className="px-3 py-2 text-right">SSNIT (EE)</th>
                      <th className="px-3 py-2 text-right">SSNIT (ER)</th>
                      <th className="px-3 py-2 text-right">SSNIT total</th>
                      <th className="px-3 py-2 text-right">Tier-2</th>
                      <th className="px-3 py-2 text-right">PAYE (GRA)</th>
                      <th className="px-3 py-2 text-right">Employer cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70" data-testid="prl-remit-rows">
                    {runs
                      .filter((r) => r.totals.gross > 0)
                      .map((r) => ({ r, t: r.totals }))
                      .sort((a, b) => a.r.period.localeCompare(b.r.period) || a.r.id - b.r.id)
                      .map(({ r, t }) => (
                        <tr key={r.id} className="text-slate-300" data-testid={`prl-remit-${r.id}`}>
                          <td className="px-4 py-2 font-semibold text-slate-100">{periodLabel(r.period)} — {r.branchName}</td>
                          <td className="px-3 py-2 text-right text-rose-300">{fmt(t.ssnitEmployee)}</td>
                          <td className="px-3 py-2 text-right text-sky-300">{fmt(t.ssnitEmployer)}</td>
                          <td className="px-3 py-2 text-right font-bold text-white">{fmt(roundOff(t.ssnitEmployee + t.ssnitEmployer))}</td>
                          <td className="px-3 py-2 text-right text-sky-300">{fmt(t.tier2)}</td>
                          <td className="px-3 py-2 text-right text-rose-300">{fmt(t.paye)}</td>
                          <td className="px-3 py-2 text-right text-violet-300">{fmt(t.employerCost)}</td>
                        </tr>
                      ))}
                    {!runs.some((r) => r.totals.gross > 0) && (
                      <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-500">No statutory-era payroll yet — new runs compute SSNIT, Tier-2 and PAYE automatically.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Per-run downloads */}
              <div className="bg-slate-900 border border-slate-700/80 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-800 text-xs font-bold text-teal-300 uppercase tracking-wider">
                  Download a payroll report per run (CSV · PDF · Excel)
                </div>
                <div className="divide-y divide-slate-800/70" data-testid="prl-dl-runs">
                  {runs.map((r) => (
                    <div key={r.id} className="px-4 py-2.5 flex items-center gap-3 flex-wrap" data-testid={`prl-dl-run-${r.id}`}>
                      <span className="text-xs font-semibold text-slate-200">{r.branchName} — {periodLabel(r.period)}</span>
                      <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold border ${RUN_STYLE[r.status]}`}>{r.status}</span>
                      <span className="text-[10px] text-slate-500">net {fmt(r.totals.net)}{r.totals.gross > 0 ? ` · PAYE ${fmt(r.totals.paye)} · SSNIT ${fmt(roundOff(r.totals.ssnitEmployee + r.totals.ssnitEmployer))}` : " · legacy (pre-statutory)"}</span>
                      <span className="ml-auto flex items-center gap-1">
                        <button onClick={() => downloadCsv([r], `payroll-${r.branchCode}-${r.period}.csv`)} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-bold" data-testid={`prl-dl-csv-${r.id}`}>CSV</button>
                        <button onClick={() => downloadPdf([r], `payroll-${r.branchCode}-${r.period}.pdf`)} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-bold" data-testid={`prl-dl-pdf-${r.id}`}>PDF</button>
                        <button onClick={() => downloadXlsx([r], `payroll-${r.branchCode}-${r.period}.xlsx`)} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-bold" data-testid={`prl-dl-xlsx-${r.id}`}>Excel</button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── SETTINGS (statutory configuration) ─────────────────── */}
          {tab === "SETTINGS" && (scope.isOwner || scope.canManage) && setForm && (
            <div className="space-y-4" data-testid="prl-settings">
              <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-4 space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <div className="text-xs font-bold text-teal-300 uppercase tracking-wider flex items-center gap-2"><Settings2 className="w-4 h-4" /> Ghana statutory rates & configuration</div>
                    <p className="text-[11px] text-slate-500 mt-1">These rates drive every new payroll run. Update them when regulations change — already-paid entries are never recomputed.</p>
                  </div>
                  <div className="text-[10px] text-slate-500" data-testid="prl-set-updatedby">
                    {statutory.updatedByName ? `Last saved by ${statutory.updatedByName} (${statutory.updatedByRole})${statutory.updatedAt ? ` · ${new Date(statutory.updatedAt).toLocaleString()}` : ""}` : "Using built-in Ghana defaults"}
                  </div>
                </div>
                {setErr && <div className="text-rose-300 text-xs bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2" data-testid="prl-set-error">{setErr}</div>}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
                  <div>
                    <label className={labelCls}>SSNIT Tier-1 — employee % (of basic)</label>
                    <input type="number" step="0.01" className={inputCls} value={setForm.ssnitEmployeePct} onChange={(e) => setSetForm({ ...setForm, ssnitEmployeePct: e.target.value })} data-testid="prl-set-ssnit-ee" />
                  </div>
                  <div>
                    <label className={labelCls}>SSNIT Tier-1 — employer % (of basic)</label>
                    <input type="number" step="0.01" className={inputCls} value={setForm.ssnitEmployerPct} onChange={(e) => setSetForm({ ...setForm, ssnitEmployerPct: e.target.value })} data-testid="prl-set-ssnit-er" />
                  </div>
                  <div>
                    <label className={labelCls}>Tier-2 pension % (of basic)</label>
                    <input type="number" step="0.01" className={inputCls} value={setForm.tier2Pct} onChange={(e) => setSetForm({ ...setForm, tier2Pct: e.target.value })} data-testid="prl-set-tier2" />
                  </div>
                  <div>
                    <label className={labelCls}>Tier-2 borne by</label>
                    <select className={inputCls} value={setForm.tier2Bearer} onChange={(e) => setSetForm({ ...setForm, tier2Bearer: e.target.value })} data-testid="prl-set-tier2bearer">
                      <option value="EMPLOYER">Employer (contribution)</option>
                      <option value="EMPLOYEE">Employee (deduction)</option>
                    </select>
                  </div>
                </div>

                {/* PAYE bands editor */}
                <div className="space-y-2" data-testid="prl-set-bands">
                  <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wider">PAYE monthly tax bands (progressive, cumulative ceiling → rate %)</div>
                  <div className="space-y-1.5">
                    {setForm.payeBands.map((b: any, i: number) => (
                      <div key={i} className="flex items-center gap-2 text-xs text-slate-400" data-testid={`prl-set-band-${i}`}>
                        <span className="w-20 text-right">{i === 0 ? "First" : "Up to"}</span>
                        <input type="number" step="0.01" className={`${inputCls} !w-32`} value={b.upto} placeholder="unlimited"
                          onChange={(e) => setSetForm({ ...setForm, payeBands: setForm.payeBands.map((x: any, j: number) => j === i ? { ...x, upto: e.target.value } : x) })}
                          data-testid={`prl-set-band-upto-${i}`} />
                        <span>GH₵ @</span>
                        <input type="number" step="0.01" className={`${inputCls} !w-20`} value={b.ratePct}
                          onChange={(e) => setSetForm({ ...setForm, payeBands: setForm.payeBands.map((x: any, j: number) => j === i ? { ...x, ratePct: e.target.value } : x) })}
                          data-testid={`prl-set-band-rate-${i}`} />
                        <span>%</span>
                        <button onClick={() => setSetForm({ ...setForm, payeBands: setForm.payeBands.filter((_: any, j: number) => j !== i) })}
                          className="p-1 rounded bg-slate-800 hover:bg-rose-500/20 text-slate-500 hover:text-rose-300" data-testid={`prl-set-band-del-${i}`}>
                          <Trash2 className="w-3 h-3" />
                        </button>
                        {b.upto === "" && <span className="text-[10px] text-slate-500">(open band — everything above)</span>}
                      </div>
                    ))}
                  </div>
                  <button onClick={() => setSetForm({ ...setForm, payeBands: [...setForm.payeBands, { upto: "", ratePct: "0" }] })}
                    className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold" data-testid="prl-set-band-add">
                    <Plus className="w-3 h-3 inline mr-1" /> Add band
                  </button>
                </div>

                {/* Custom statutory items */}
                <div className="space-y-2" data-testid="prl-set-items">
                  <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wider">Other statutory contributions / levies</div>
                  <div className="space-y-1.5">
                    {setForm.customItems.map((c: any, i: number) => (
                      <div key={i} className="flex items-center gap-2 flex-wrap" data-testid={`prl-set-item-${i}`}>
                        <input className={`${inputCls} !w-44`} value={c.name} placeholder="e.g. COVID levy"
                          onChange={(e) => setSetForm({ ...setForm, customItems: setForm.customItems.map((x: any, j: number) => j === i ? { ...x, name: e.target.value } : x) })}
                          data-testid={`prl-set-item-name-${i}`} />
                        <input type="number" step="0.01" className={`${inputCls} !w-20`} value={c.pct}
                          onChange={(e) => setSetForm({ ...setForm, customItems: setForm.customItems.map((x: any, j: number) => j === i ? { ...x, pct: e.target.value } : x) })}
                          data-testid={`prl-set-item-pct-${i}`} />
                        <span className="text-xs text-slate-400">% of</span>
                        <select className={`${inputCls} !w-24`} value={c.base}
                          onChange={(e) => setSetForm({ ...setForm, customItems: setForm.customItems.map((x: any, j: number) => j === i ? { ...x, base: e.target.value } : x) })}
                          data-testid={`prl-set-item-base-${i}`}>
                          <option value="BASIC">Basic</option>
                          <option value="GROSS">Gross</option>
                        </select>
                        <select className={`${inputCls} !w-40`} value={c.bearer}
                          onChange={(e) => setSetForm({ ...setForm, customItems: setForm.customItems.map((x: any, j: number) => j === i ? { ...x, bearer: e.target.value } : x) })}
                          data-testid={`prl-set-item-bearer-${i}`}>
                          <option value="EMPLOYEE">Employee deduction</option>
                          <option value="EMPLOYER">Employer contribution</option>
                        </select>
                        <button onClick={() => setSetForm({ ...setForm, customItems: setForm.customItems.filter((_: any, j: number) => j !== i) })}
                          className="p-1 rounded bg-slate-800 hover:bg-rose-500/20 text-slate-500 hover:text-rose-300" data-testid={`prl-set-item-del-${i}`}>
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => setSetForm({ ...setForm, customItems: [...setForm.customItems, { name: "", pct: "0", bearer: "EMPLOYER", base: "BASIC" }] })}
                    className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold" data-testid="prl-set-item-add">
                    <Plus className="w-3 h-3 inline mr-1" /> Add contribution
                  </button>
                </div>

                <div>
                  <label className={labelCls}>Configuration note</label>
                  <input className={inputCls} value={setForm.note} onChange={(e) => setSetForm({ ...setForm, note: e.target.value })} placeholder="e.g. GRA 2026 band update" data-testid="prl-set-note" />
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={saveSettings} disabled={busy} className="px-4 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white font-bold text-sm shadow disabled:opacity-50" data-testid="prl-set-save">
                    {busy ? "Saving…" : "Save statutory configuration"}
                  </button>
                  <span className="text-[10px] text-slate-500">Applies to new runs; use “Recalculate with current statutory rates” on any open run to apply it there.</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── New Run modal ─────────────────────────────────────────── */}
      {runFormOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-5 w-full max-w-md shadow-2xl space-y-4" data-testid="prl-run-form">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="text-base font-bold text-white flex items-center gap-2"><Banknote className="w-4 h-4 text-teal-400" /> New Payroll Run</h4>
              <button onClick={() => setRunFormOpen(false)} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white" data-testid="prl-run-cancel"><X className="w-4 h-4" /></button>
            </div>
            {runFormErr && <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-2.5 rounded-lg text-xs" data-testid="prl-run-error">{runFormErr}</div>}
            <div>
              <label className={labelCls}>Business <span className="text-rose-400">*</span></label>
              <select className={inputCls} value={runForm.businessId} onChange={(e) => {
                const biz = businesses.find((b) => b.id === Number(e.target.value));
                setRunForm({ ...runForm, businessId: e.target.value, branchCode: biz?.code || "" });
              }} data-testid="prl-run-business">
                <option value="">Select business…</option>
                {scopedBusinesses.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.code})</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Payroll month <span className="text-rose-400">*</span></label>
                <input type="month" className={inputCls} value={runForm.period} onChange={(e) => setRunForm({ ...runForm, period: e.target.value })} data-testid="prl-run-period" />
              </div>
              <div>
                <label className={labelCls}>Branch / register</label>
                <input className={`${inputCls} font-mono`} value={runForm.branchCode} onChange={(e) => setRunForm({ ...runForm, branchCode: e.target.value.toUpperCase() })} data-testid="prl-run-branch" />
              </div>
            </div>
            <div>
              <label className={labelCls}>Notes</label>
              <input className={inputCls} value={runForm.notes} onChange={(e) => setRunForm({ ...runForm, notes: e.target.value })} placeholder="e.g. August salary cycle" data-testid="prl-run-notes" />
            </div>
            <p className="text-[11px] text-slate-500">Drafts every ACTIVE employee of the business with their base salary and pulls this month's overtime hours from attendance automatically.</p>
            <button onClick={createRun} disabled={busy} className="w-full py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white font-bold text-sm shadow disabled:opacity-50" data-testid="prl-run-create">
              {busy ? "Creating…" : "Create Draft Run"}
            </button>
          </div>
        </div>
      )}

      {/* ── Manual entry adjustment modal ─────────────────────────── */}
      {editSlip && (
        <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-5 w-full max-w-lg shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto" data-testid="prl-edit">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="text-base font-bold text-white flex items-center gap-2"><Pencil className="w-4 h-4 text-teal-400" /> Adjust — {editSlip.entry.employeeName}</h4>
              <button onClick={() => setEditSlip(null)} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white" data-testid="prl-edit-cancel"><X className="w-4 h-4" /></button>
            </div>
            {editErr && <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-2.5 rounded-lg text-xs" data-testid="prl-edit-error">{editErr}</div>}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Basic salary (GH₵)</label>
                <input type="number" step="0.01" className={inputCls} value={editForm.baseSalaryGhs} onChange={(e) => setEditForm({ ...editForm, baseSalaryGhs: e.target.value })} data-testid="prl-edit-base" />
              </div>
              <div>
                <label className={labelCls}>Overtime hours</label>
                <input type="number" step="0.5" className={inputCls} value={editForm.overtimeHours} onChange={(e) => setEditForm({ ...editForm, overtimeHours: e.target.value })} data-testid="prl-edit-ot" />
              </div>
              <div>
                <label className={labelCls}>Allowances (GH₵)</label>
                <input type="number" step="0.01" className={inputCls} value={editForm.allowancesGhs} onChange={(e) => setEditForm({ ...editForm, allowancesGhs: e.target.value })} data-testid="prl-edit-allowances" />
              </div>
              <div>
                <label className={labelCls}>Allowance note</label>
                <input className={inputCls} value={editForm.allowanceNote} onChange={(e) => setEditForm({ ...editForm, allowanceNote: e.target.value })} data-testid="prl-edit-allowancenote" />
              </div>
              <div>
                <label className={labelCls}>Other deductions (GH₵)</label>
                <input type="number" step="0.01" className={inputCls} value={editForm.deductionsGhs} onChange={(e) => setEditForm({ ...editForm, deductionsGhs: e.target.value })} data-testid="prl-edit-deductions" />
              </div>
              <div>
                <label className={labelCls}>Deduction note</label>
                <input className={inputCls} value={editForm.deductionNote} onChange={(e) => setEditForm({ ...editForm, deductionNote: e.target.value })} data-testid="prl-edit-deductionnote" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input type="checkbox" checked={!!editForm.applyStatutory} onChange={(e) => setEditForm({ ...editForm, applyStatutory: e.target.checked })} className="w-4 h-4 accent-teal-500" data-testid="prl-edit-applystat" />
              Apply statutory deductions (SSNIT {statutory?.config?.ssnitEmployeePct}% EE · PAYE{statutory?.config?.tier2Bearer === "EMPLOYEE" ? ` · Tier-2 ${statutory?.config?.tier2Pct}%` : ""})
            </label>
            {/* Live statutory preview */}
            {(() => {
              const c = statutory?.config;
              const basic = Number(editForm.baseSalaryGhs) || 0;
              const allow = Number(editForm.allowancesGhs) || 0;
              const otPay = Math.round((basic / 208) * (Number(editForm.overtimeHours) || 0) * 1.5 * 100) / 100;
              const manual = Number(editForm.deductionsGhs) || 0;
              const gross = Math.round((basic + allow + otPay) * 100) / 100;
              const apply = !!editForm.applyStatutory && !!c;
              const ssnit = apply ? Math.round(basic * (c.ssnitEmployeePct / 100) * 100) / 100 : 0;
              const tier2ee = apply && c.tier2Bearer === "EMPLOYEE" ? Math.round(basic * (c.tier2Pct / 100) * 100) / 100 : 0;
              const custom = apply ? (c.customItems || []).filter((x: any) => x.name && x.pct > 0) : [];
              const custEe = custom.filter((x: any) => x.bearer === "EMPLOYEE").reduce((s: number, x: any) => s + Math.round(((x.base === "GROSS" ? gross : basic) * x.pct) / 100 * 100) / 100, 0);
              const custEr = custom.filter((x: any) => x.bearer !== "EMPLOYEE").reduce((s: number, x: any) => s + Math.round(((x.base === "GROSS" ? gross : basic) * x.pct) / 100 * 100) / 100, 0);
              const taxable = Math.max(0, Math.round((gross - ssnit - tier2ee - custEe) * 100) / 100);
              let paye = 0, floor = 0;
              if (apply) for (const b of c.payeBands || []) {
                if (taxable <= floor) break;
                const cap = b.upto === null ? Infinity : Number(b.upto);
                const slice = Math.min(taxable, cap) - floor;
                if (slice > 0) paye += (slice * Number(b.ratePct)) / 100;
                floor = cap;
              }
              paye = Math.round(paye * 100) / 100;
              const totDed = Math.round((ssnit + tier2ee + custEe + paye + manual) * 100) / 100;
              const net = Math.round((gross - totDed) * 100) / 100;
              const erContrib = apply ? Math.round((basic * (c.ssnitEmployerPct / 100) + (c.tier2Bearer !== "EMPLOYEE" ? basic * (c.tier2Pct / 100) : 0)) * 100) / 100 + custEr : 0;
              return (
                <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 grid grid-cols-3 gap-2 text-center text-[10px]" data-testid="prl-edit-preview">
                  <div><div className="text-slate-500 uppercase">Gross</div><div className="text-sm font-bold text-white" data-testid="prl-edit-pv-gross">{fmt(gross)}</div></div>
                  <div><div className="text-slate-500 uppercase">SSNIT EE</div><div className="text-sm font-bold text-rose-300" data-testid="prl-edit-pv-ssnit">{fmt(ssnit)}</div></div>
                  <div><div className="text-slate-500 uppercase">PAYE</div><div className="text-sm font-bold text-rose-300" data-testid="prl-edit-pv-paye">{fmt(paye)}</div></div>
                  <div><div className="text-slate-500 uppercase">Total deductions</div><div className="text-sm font-bold text-amber-300" data-testid="prl-edit-pv-totded">{fmt(totDed)}</div></div>
                  <div><div className="text-slate-500 uppercase">Net pay</div><div className="text-sm font-extrabold text-emerald-400" data-testid="prl-edit-pv-net">{fmt(net)}</div></div>
                  <div><div className="text-slate-500 uppercase">Employer cost</div><div className="text-sm font-bold text-violet-300">{fmt(Math.round((gross + erContrib) * 100) / 100)}</div></div>
                </div>
              );
            })()}
            <button onClick={saveEntry} disabled={busy} className="w-full py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white font-bold text-sm shadow disabled:opacity-50" data-testid="prl-edit-save">
              {busy ? "Saving…" : "Save adjustment & recalculate"}
            </button>
          </div>
        </div>
      )}

      {/* ── Payslip modal ─────────────────────────────────────────── */}
      {slip && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-white text-slate-900 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden" data-testid="prl-slip">
            <div className="bg-slate-900 text-white px-5 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                {(() => { const l = resolveLogo(businesses.find((b) => b.id === slip.entry.businessId), slip.entry.branchCode); return l ? <img src={l} alt="logo" className="h-10 w-10 rounded-lg object-contain bg-white p-0.5" data-testid="prl-slip-logo" /> : null; })()}
                <div>
                  <h4 className="font-bold">GoMina 360 — Payslip</h4>
                  <p className="text-[11px] text-slate-300">{businesses.find((b) => b.id === slip.entry.businessId)?.name} · {slip.entry.branchCode} · {periodLabel(slip.run.period)}</p>
                </div>
              </div>
              <button onClick={() => setSlip(null)} className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700" aria-label="Close" data-testid="prl-slip-close"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <div><div className="font-extrabold text-base">{slip.entry.employeeName}</div><div className="text-xs text-slate-500">{slip.entry.employeeRole}</div></div>
                <span className={`px-2.5 py-1 rounded-full text-[10px] font-black ${slip.entry.status === "PAID" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>{slip.entry.status}</span>
              </div>
              <table className="w-full text-xs border border-slate-200 rounded-lg overflow-hidden">
                <tbody>
                  <tr className="bg-slate-50 font-bold"><td className="px-3 py-2">Earnings</td><td className="px-3 py-2 text-right">GH₵</td></tr>
                  <tr><td className="px-3 py-2 border-t border-slate-200">Base salary</td><td className="px-3 py-2 border-t border-slate-200 text-right">{fmt(slip.entry.baseSalaryGhs)}</td></tr>
                  <tr><td className="px-3 py-2 border-t border-slate-200">Allowances{slip.entry.allowanceNote ? ` (${slip.entry.allowanceNote})` : ""}</td><td className="px-3 py-2 border-t border-slate-200 text-right">{fmt(slip.entry.allowancesGhs)}</td></tr>
                  <tr><td className="px-3 py-2 border-t border-slate-200">Overtime ({slip.entry.overtimeHours} hrs)</td><td className="px-3 py-2 border-t border-slate-200 text-right">{fmt(slip.entry.overtimePayGhs)}</td></tr>
                  {slip.entry.grossPayGhs != null && (
                    <tr className="bg-slate-100 font-bold"><td className="px-3 py-2 border-t border-slate-200">GROSS PAY</td><td className="px-3 py-2 border-t border-slate-200 text-right" data-testid="prl-slip-gross">{fmt(slip.entry.grossPayGhs)}</td></tr>
                  )}
                  {slip.entry.grossPayGhs != null ? (
                    <>
                      <tr className="bg-rose-50 font-bold text-rose-900"><td className="px-3 py-2">Employee deductions</td><td className="px-3 py-2 text-right"></td></tr>
                      <tr><td className="px-3 py-2 border-t border-slate-200">SSNIT Tier-1 ({statutory?.config?.ssnitEmployeePct ?? 5.5}% of basic)</td><td className="px-3 py-2 border-t border-slate-200 text-right" data-testid="prl-slip-ssnit">−{fmt(slip.entry.ssnitEmployeeGhs)}</td></tr>
                      {slip.entry.tier2Ghs > 0 && slip.entry.tier2Bearer === "EMPLOYEE" && (
                        <tr><td className="px-3 py-2 border-t border-slate-200">Tier-2 pension ({statutory?.config?.tier2Pct ?? 5}% of basic)</td><td className="px-3 py-2 border-t border-slate-200 text-right">−{fmt(slip.entry.tier2Ghs)}</td></tr>
                      )}
                      {(slip.entry.customDeductions || []).filter((c: any) => c.bearer === "EMPLOYEE").map((c: any) => (
                        <tr key={c.name}><td className="px-3 py-2 border-t border-slate-200">{c.name}</td><td className="px-3 py-2 border-t border-slate-200 text-right">−{fmt(c.amount)}</td></tr>
                      ))}
                      <tr><td className="px-3 py-2 border-t border-slate-200">PAYE tax (taxable {fmt(slip.entry.taxableIncomeGhs)})</td><td className="px-3 py-2 border-t border-slate-200 text-right" data-testid="prl-slip-paye">−{fmt(slip.entry.payeGhs)}</td></tr>
                      <tr><td className="px-3 py-2 border-t border-slate-200">Other deductions{slip.entry.deductionNote ? ` (${slip.entry.deductionNote})` : ""}</td><td className="px-3 py-2 border-t border-slate-200 text-right">−{fmt(slip.entry.deductionsGhs)}</td></tr>
                      <tr className="bg-rose-50 font-bold"><td className="px-3 py-2 border-t border-slate-200">Total employee deductions</td><td className="px-3 py-2 border-t border-slate-200 text-right" data-testid="prl-slip-totded">−{fmt(slip.entry.totalEmployeeDeductionsGhs)}</td></tr>
                    </>
                  ) : (
                    <>
                      <tr className="bg-slate-50 font-bold"><td className="px-3 py-2">Deductions</td><td></td></tr>
                      <tr><td className="px-3 py-2 border-t border-slate-200">Deductions{slip.entry.deductionNote ? ` (${slip.entry.deductionNote})` : ""}</td><td className="px-3 py-2 border-t border-slate-200 text-right">−{fmt(slip.entry.deductionsGhs)}</td></tr>
                    </>
                  )}
                  <tr className="bg-emerald-50 font-extrabold"><td className="px-3 py-2.5 border-t border-slate-200">NET PAY</td><td className="px-3 py-2.5 border-t border-slate-200 text-right" data-testid="prl-slip-net">{fmt(slip.entry.netPayGhs)}</td></tr>
                  {slip.entry.grossPayGhs != null && (
                    <>
                      <tr className="bg-sky-50 font-bold text-sky-900"><td className="px-3 py-2">Employer contributions (not deducted from pay)</td><td className="px-3 py-2 text-right"></td></tr>
                      <tr><td className="px-3 py-2 border-t border-slate-200">SSNIT Tier-1 ({statutory?.config?.ssnitEmployerPct ?? 13}% of basic)</td><td className="px-3 py-2 border-t border-slate-200 text-right" data-testid="prl-slip-er-ssnit">{fmt(slip.entry.ssnitEmployerGhs)}</td></tr>
                      {slip.entry.tier2Ghs > 0 && slip.entry.tier2Bearer !== "EMPLOYEE" && (
                        <tr><td className="px-3 py-2 border-t border-slate-200">Tier-2 pension ({statutory?.config?.tier2Pct ?? 5}% of basic)</td><td className="px-3 py-2 border-t border-slate-200 text-right" data-testid="prl-slip-tier2">{fmt(slip.entry.tier2Ghs)}</td></tr>
                      )}
                      {(slip.entry.customDeductions || []).filter((c: any) => c.bearer !== "EMPLOYEE").map((c: any) => (
                        <tr key={c.name}><td className="px-3 py-2 border-t border-slate-200">{c.name}</td><td className="px-3 py-2 border-t border-slate-200 text-right">{fmt(c.amount)}</td></tr>
                      ))}
                      <tr className="bg-sky-50 font-bold"><td className="px-3 py-2 border-t border-slate-200">Total employer cost (gross + contributions)</td><td className="px-3 py-2 border-t border-slate-200 text-right" data-testid="prl-slip-ercost">{fmt(slip.entry.employerCostGhs)}</td></tr>
                    </>
                  )}
                </tbody>
              </table>
              <p className="text-[11px] text-slate-500">
                {slip.entry.status === "PAID"
                  ? `Paid via ${METHODS.find(([k]) => k === slip.entry.paymentMethod)?.[1]} on ${new Date(slip.entry.paidAt).toLocaleString()} by ${slip.entry.paidByName}${slip.entry.transactionId ? ` · Ledger ref #${slip.entry.transactionId}` : ""}`
                  : "Payment pending."}
              </p>
              <button onClick={() => printSlip(slip.run, slip.entry)} className="w-full py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-sm flex items-center justify-center gap-2" data-testid="prl-slip-print">
                <Printer className="w-4 h-4" /> Print / Save as PDF
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
