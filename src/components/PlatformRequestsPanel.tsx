"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  Inbox,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Eye,
  Archive,
  Rocket,
  Phone,
  Mail,
  MapPin,
  Building2,
  Tag,
  MessageSquare,
} from "lucide-react";

/**
 * PlatformRequestsPanel — SUPER ADMIN ONLY review queue for requests submitted
 * from the storefront's Help/Contact panel and the public /join page ("Join /
 * Register on the Platform", demo, partnership, pricing, support…).
 *
 * Rendered inside PlatformAdminPanel, which is itself only reachable when
 * `currentUser.isSuperAdmin` — and every request it makes is independently
 * gated server-side by requireSuperAdmin(), so hiding the UI is never the
 * security boundary.
 *
 * Approval is deliberately TWO-STEP:
 *   Approve  → marks the request APPROVED (a decision, reversible in words).
 *   Provision → creates the organization + Owner login (a real action).
 * Keeping them apart means an account is never created by a stray click on a
 * queue row, and the one-time password is surfaced to a human who can hand it
 * over securely.
 */

type Row = {
  id: number;
  reference: string;
  purpose: string;
  purposeLabel?: string;
  status: string;
  businessName: string | null;
  contactName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  businessType: string | null;
  /** Server-rendered human label for the business type key. */
  businessTypeLabel?: string;
  location: string | null;
  message: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  createdOrganizationId: number | null;
  createdAt: string | null;
};

const STATUS_STYLE: Record<string, string> = {
  PENDING: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  IN_REVIEW: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  NEEDS_INFO: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  APPROVED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  REJECTED: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  CLOSED: "bg-slate-500/15 text-slate-400 border-slate-500/40",
};

const OPEN_STATUSES = ["PENDING", "IN_REVIEW", "NEEDS_INFO"];

const FILTERS: { key: string; label: string }[] = [
  { key: "OPEN", label: "Needs attention" },
  { key: "PENDING", label: "Pending" },
  { key: "IN_REVIEW", label: "In review" },
  { key: "NEEDS_INFO", label: "Needs info" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
  { key: "CLOSED", label: "Closed" },
  { key: "ALL", label: "All" },
];

const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleString() : "—");

export default function PlatformRequestsPanel({
  focusReference = null,
  onFocusHandled,
}: {
  /** Request reference to open + highlight — set by a notification click or by
   *  the Action Center, so the operator lands ON the request, not near it. */
  focusReference?: string | null;
  onFocusHandled?: () => void;
} = {}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [openCount, setOpenCount] = useState(0);
  const [filter, setFilter] = useState("OPEN");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<number | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [provisioned, setProvisioned] = useState<{ email: string; password: string; org: string; recovered?: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/platform-requests", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setRows(data.requests || []);
      setCounts(data.counts || {});
      setOpenCount(Number(data.openCount) || 0);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Deep-link focus. A notification/action-center click hands us a reference;
   * we expand that row, make sure the active filter cannot hide it, scroll it
   * into view and flash a ring so the eye lands on it immediately.
   */
  useEffect(() => {
    if (!focusReference) return;
    const target = rows.find((r) => r.reference === focusReference);
    if (!target) {
      // Loaded, but this filter hides it (a decided request under "Needs
      // attention"): fall back to the unfiltered view, which is guaranteed to
      // contain every request the caller may see.
      if (!loading && rows.length > 0 && filter !== "ALL") setFilter("ALL");
      return;
    }
    setDetailFor(target.id);
    setHighlightId(target.id);
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-testid="platform-request-${target.id}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("ring-2", "ring-fuchsia-500", "shadow-fuchsia-500/30");
        setTimeout(() => el.classList.remove("ring-2", "ring-fuchsia-500", "shadow-fuchsia-500/30"), 4000);
      }
      onFocusHandled?.();
    }, 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReference, rows, filter, loading]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = rows.filter((r) => {
    if (filter === "ALL") return true;
    if (filter === "OPEN") return OPEN_STATUSES.includes(r.status);
    return r.status === filter;
  });

  const act = async (row: Row, action: string, extra?: Record<string, any>) => {
    setBusyId(row.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/platform-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, action, reason: reason || undefined, ...(extra || {}) }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      if (action === "PROVISION") {
        setProvisioned({
          email: data.owner?.email || "",
          password: data.initialPassword || "",
          org: data.organization?.name || "",
          recovered: !!data.recovered,
        });
        setNotice(
          data.recovered
            ? `This request had already created "${data.organization?.name}" on an earlier attempt — the workspace was recovered and linked to the request.`
            : `Owner workspace "${data.organization?.name}" created.`,
        );
      } else {
        setNotice(
          action === "APPROVE"
            ? `${row.reference} approved — use “Provision workspace” when you are ready to create the Owner login.`
            : `${row.reference} → ${data.request?.status}.`,
        );
      }
      setReason("");
      setDetailFor(null);
      await load();
      // The server rewrote this request's bell rows (title, body, read state).
      // Nudge the bell so the badge/row reflect the decision immediately rather
      // than on its next 30-second poll.
      try {
        window.dispatchEvent(new CustomEvent("gomina:notifications-refresh"));
      } catch { /* non-browser */ }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const btn =
    "inline-flex items-center gap-1 text-[11px] font-bold disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <section className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-3" data-testid="platform-requests">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
            <Inbox className="w-4 h-4 text-amber-300" /> Platform requests
            {openCount > 0 && (
              <span
                className="text-[10px] font-black px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40"
                data-testid="platform-requests-open-badge"
              >
                {openCount}
              </span>
            )}
          </h2>
          <p className="text-xs text-slate-400 mt-0.5 max-w-2xl">
            Requests submitted by the public through the storefront Help/Contact panel and the sign-up page. Only you
            (the platform Super Admin) can see this list — no business or organization can access it.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 disabled:opacity-50"
          data-testid="platform-requests-refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            data-testid={`platform-requests-filter-${f.key}`}
            aria-pressed={filter === f.key}
            className={`text-[11px] font-bold px-2.5 py-1 rounded-lg border transition ${
              filter === f.key
                ? "bg-amber-400 text-slate-950 border-amber-400"
                : "bg-slate-800/60 text-slate-300 border-slate-700 hover:bg-slate-800"
            }`}
          >
            {f.label}
            {counts[f.key] != null && <span className="ml-1 opacity-70">{counts[f.key]}</span>}
            {f.key === "OPEN" && <span className="ml-1 opacity-70">{openCount}</span>}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-rose-900/20 border border-rose-500/40 rounded-xl px-4 py-3 text-sm text-rose-300" data-testid="platform-requests-error">
          {error}
        </div>
      )}
      {notice && (
        <div className="bg-emerald-900/20 border border-emerald-500/40 rounded-xl px-4 py-3 text-sm text-emerald-200" data-testid="platform-requests-notice">
          {notice}
        </div>
      )}
      {provisioned && (
        <div className="bg-emerald-900/20 border border-emerald-500/40 rounded-xl px-4 py-3 text-sm text-emerald-200 space-y-1" data-testid="platform-requests-provisioned">
          <p className="font-bold">
            {provisioned.recovered
              ? "Workspace recovered — it already existed from an earlier attempt."
              : "Owner workspace created — hand these over securely."}
          </p>
          <p>
            Sign-in email: <span className="font-mono">{provisioned.email}</span>
          </p>
          {provisioned.password ? (
            <p>
              One-time password: <span className="font-mono" data-testid="platform-requests-otp">{provisioned.password}</span>
            </p>
          ) : (
            <p className="text-xs text-emerald-200/90">
              No new password was issued — the account keeps the one set by the original attempt. Reset it from
              Enterprise Users if the Owner never received it.
            </p>
          )}
          <p className="text-xs text-emerald-300/80">
            Shown once for {provisioned.org}. It is not stored anywhere and is never sent by notification.
          </p>
          <button onClick={() => setProvisioned(null)} className="text-xs underline text-emerald-300">
            Dismiss
          </button>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <p className="text-xs text-slate-500 py-4 text-center">Loading requests…</p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-slate-500 py-6 text-center" data-testid="platform-requests-empty">
          {filter === "OPEN" ? "No requests need your attention right now." : "No requests in this view."}
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((r) => {
            const open = detailFor === r.id;
            return (
              <li
                key={r.id}
                className={`border rounded-xl overflow-hidden transition ${
                  highlightId === r.id ? "border-fuchsia-500/60 bg-fuchsia-500/5" : "border-slate-800"
                }`}
                data-testid={`platform-request-${r.id}`}
              >
                <div className="flex items-start gap-3 px-3 py-2.5 flex-wrap">
                  <span className={`text-[10px] font-bold px-2 py-1 rounded border shrink-0 ${STATUS_STYLE[r.status] || ""}`}>
                    {r.status}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-slate-100 font-semibold truncate">
                      {r.purposeLabel || r.purpose}
                      {r.businessName ? ` — ${r.businessName}` : ""}
                    </p>
                    <p className="text-[11px] text-slate-400 truncate">
                      <span className="font-mono text-slate-300">{r.reference}</span> · {r.contactName}
                      {r.contactPhone ? ` · ${r.contactPhone}` : ""}
                      {r.contactEmail ? ` · ${r.contactEmail}` : ""}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[10px] text-slate-500">{fmtDate(r.createdAt)}</p>
                    <button
                      onClick={() => setDetailFor(open ? null : r.id)}
                      className="text-[11px] font-bold text-fuchsia-300 hover:text-fuchsia-200 inline-flex items-center gap-1"
                      data-testid={`platform-request-toggle-${r.id}`}
                      aria-expanded={open}
                    >
                      {open ? (
                        <>
                          Hide <ChevronUp className="w-3.5 h-3.5" />
                        </>
                      ) : (
                        <>
                          Review <ChevronDown className="w-3.5 h-3.5" />
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {open && (
                  <div className="border-t border-slate-800 bg-slate-950/40 px-3 py-3 space-y-3">
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
                      <Detail icon={<Building2 className="w-3 h-3" />} label="Business" value={r.businessName} />
                      <Detail icon={<Tag className="w-3 h-3" />} label="Type" value={r.businessTypeLabel || r.businessType} />
                      <Detail icon={<Phone className="w-3 h-3" />} label="Phone" value={r.contactPhone} />
                      <Detail icon={<Mail className="w-3 h-3" />} label="Email" value={r.contactEmail} />
                      <Detail icon={<MapPin className="w-3 h-3" />} label="Location" value={r.location} />
                      <Detail icon={<Inbox className="w-3 h-3" />} label="Received" value={fmtDate(r.createdAt)} />
                    </dl>

                    {r.message && (
                      <div className="rounded-lg bg-slate-900 border border-slate-800 px-3 py-2">
                        <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 flex items-center gap-1">
                          <MessageSquare className="w-3 h-3" /> Message
                        </p>
                        <p className="text-[12px] text-slate-300 whitespace-pre-line mt-0.5">{r.message}</p>
                      </div>
                    )}

                    {(r.decidedByName || r.decisionReason) && (
                      <p className="text-[11px] text-slate-400">
                        {r.decidedByName ? `Last action by ${r.decidedByName}` : "Last action"}
                        {r.decidedAt ? ` · ${fmtDate(r.decidedAt)}` : ""}
                        {r.decisionReason ? ` — ${r.decisionReason}` : ""}
                      </p>
                    )}

                    {r.createdOrganizationId && (
                      <p className="text-[11px] text-emerald-300 flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Provisioned as organization #{r.createdOrganizationId} — it is
                        in the directory below.
                      </p>
                    )}

                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Note / reason (required to reject)"
                      className="w-full bg-slate-800/70 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-fuchsia-500/60"
                      data-testid={`platform-request-reason-${r.id}`}
                    />

                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        onClick={() => act(r, "START_REVIEW")}
                        disabled={busyId === r.id || r.status === "IN_REVIEW"}
                        className={`${btn} text-sky-300 hover:text-sky-200`}
                        data-testid={`platform-request-review-${r.id}`}
                      >
                        <Eye className="w-3.5 h-3.5" /> Start review
                      </button>
                      <button
                        onClick={() => act(r, "NEEDS_INFO")}
                        disabled={busyId === r.id}
                        className={`${btn} text-violet-300 hover:text-violet-200`}
                        data-testid={`platform-request-needsinfo-${r.id}`}
                      >
                        <HelpCircle className="w-3.5 h-3.5" /> Needs info
                      </button>
                      <button
                        onClick={() => act(r, "APPROVE")}
                        disabled={busyId === r.id || r.status === "APPROVED" || !!r.createdOrganizationId}
                        className={`${btn} text-emerald-300 hover:text-emerald-200`}
                        data-testid={`platform-request-approve-${r.id}`}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                      </button>
                      <button
                        onClick={() => act(r, "REJECT")}
                        disabled={busyId === r.id}
                        className={`${btn} text-rose-300 hover:text-rose-200`}
                        data-testid={`platform-request-reject-${r.id}`}
                      >
                        <XCircle className="w-3.5 h-3.5" /> Reject
                      </button>
                      <button
                        onClick={() => act(r, "CLOSE")}
                        disabled={busyId === r.id}
                        className={`${btn} text-slate-400 hover:text-slate-200`}
                        data-testid={`platform-request-close-${r.id}`}
                      >
                        <Archive className="w-3.5 h-3.5" /> Close
                      </button>
                      <button
                        onClick={() =>
                          act(r, "PROVISION", {
                            name: r.businessName || `${r.contactName} (GoMina 360)`,
                            ownerName: r.contactName,
                          })
                        }
                        disabled={busyId === r.id || r.status !== "APPROVED" || !!r.createdOrganizationId}
                        title={
                          r.status !== "APPROVED"
                            ? "Approve this request first"
                            : "Create the organization and the Owner's login"
                        }
                        className={`${btn} text-fuchsia-300 hover:text-fuchsia-200`}
                        data-testid={`platform-request-provision-${r.id}`}
                      >
                        <Rocket className="w-3.5 h-3.5" /> Provision workspace
                      </button>
                    </div>
                    <p className="text-[10px] text-slate-500">
                      Approving records a decision. “Provision workspace” then creates the organization and the Owner&apos;s
                      login, and shows the one-time password once.
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Detail({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | null }) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="text-slate-500 mt-0.5">{icon}</span>
      <dt className="text-slate-500">{label}:</dt>
      <dd className="text-slate-200 break-words min-w-0">{value || "—"}</dd>
    </div>
  );
}
