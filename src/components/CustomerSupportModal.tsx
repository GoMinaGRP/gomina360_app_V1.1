"use client";

import React, { useEffect, useState } from "react";
import {
  X,
  LifeBuoy,
  User as UserIcon,
  Phone,
  MessageCircle,
  Mail,
  MapPin,
  Clock,
  Info,
  Save,
  ShieldCheck,
  Megaphone,
  ExternalLink,
} from "lucide-react";

/**
 * Customer Support (storefront HELP) editor.
 *
 * The OWNER — or a user the OWNER granted the "Customer Support — storefront
 * HELP" permission (can_manage_support) — adds & edits the group-wide support
 * information shoppers see when they tap HELP on the public customer order
 * page: contact name, phone, WhatsApp, email, business address/location,
 * opening hours and any other important support notes.
 *
 * SCOPE: the form edits the row the server says this caller actually writes
 * (`edit.row`). For the Super Admin and the platform organisation's staff that
 * is the PLATFORM row — the published storefront helpdesk. For any other
 * organisation's OWNER it is that organisation's own row. This is what fixes
 * the old asymmetry where the editor LOADED organisation #1's row but SAVED
 * the caller's own.
 *
 * The "Join GoMina 360" registration CTA (Super Admin only) is edited here
 * too: it is platform recruitment policy, so a tenant-scoped canManageSupport
 * grant cannot open or close public registration.
 */
export default function CustomerSupportModal({
  isOpen,
  onClose,
  currentUser,
}: {
  isOpen: boolean;
  onClose: () => void;
  currentUser: any;
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [openingHours, setOpeningHours] = useState("");
  const [extraInfo, setExtraInfo] = useState("");
  const [meta, setMeta] = useState("");
  // Platform registration CTA (Super Admin only).
  const [canEditRegistration, setCanEditRegistration] = useState(false);
  const [regEnabled, setRegEnabled] = useState(true);
  const [regHeadline, setRegHeadline] = useState("");
  const [regNote, setRegNote] = useState("");
  // The LOGIN-PAGE switch — separate from the order-page invite above so the
  // two surfaces can never be changed by accident.
  const [regLoginEnabled, setRegLoginEnabled] = useState(false);

  const isOwner = currentUser?.role === "OWNER";
  const allowed = isOwner || !!currentUser?.canManageSupport;

  useEffect(() => {
    if (!isOpen) return;
    setError("");
    setSaved("");
    setLoading(true);
    (async () => {
      try {
        const res = await fetch("/api/support-info", { cache: "no-store" });
        const d = await res.json();
        // `edit.row` is the row THIS caller's Save will write — the platform
        // row for platform editors, their own organisation's row otherwise.
        // Falling back to `info` keeps the form usable against an older server.
        const i = d?.edit ? d.edit.row : d?.info;
        setCanEditRegistration(!!d?.edit?.canEditRegistration);
        setContactName(i?.contactName || "");
        setPhone(i?.phone || "");
        setWhatsapp(i?.whatsapp || "");
        setEmail(i?.email || "");
        setAddress(i?.address || "");
        setOpeningHours(i?.openingHours || "");
        setExtraInfo(i?.extraInfo || "");
        setRegEnabled(i?.registrationEnabled !== false);
        setRegHeadline(i?.registrationHeadline || "");
        setRegNote(i?.registrationNote || "");
        setRegLoginEnabled(i?.loginRegistrationEnabled === true);
        setMeta(
          i?.updatedByName
            ? `Last saved by ${i.updatedByName}${i.updatedAt ? ` · ${new Date(i.updatedAt).toLocaleString()}` : ""}`
            : "",
        );
      } catch {
        setError("Could not load the current support information.");
      } finally {
        setLoading(false);
      }
    })();
  }, [isOpen]);

  // Escape key listener
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  if (!allowed) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-sm text-center space-y-3 my-auto">
          <ShieldCheck className="w-8 h-8 text-rose-400 mx-auto" />
          <p className="text-sm text-slate-300">
            Only the OWNER — or a user the OWNER granted Customer Support access — can edit the storefront HELP information.
          </p>
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold">
            Close
          </button>
        </div>
      </div>
    );
  }

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved("");
    try {
      const res = await fetch("/api/support-info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactName, phone, whatsapp, email, address, openingHours, extraInfo,
          // Omitted entirely for non-Super-Admins: the server preserves the
          // published CTA untouched when this key is absent.
          ...(canEditRegistration
            ? {
                registration: {
                  enabled: regEnabled,
                  headline: regHeadline,
                  note: regNote,
                  // Only the sign-in gate. The order-page invite and /join keep
                  // reading `enabled` above and are unaffected either way.
                  loginEnabled: regLoginEnabled,
                },
              }
            : {}),
        }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        setSaved(
          d?.scope === "PLATFORM"
            ? "Saved — customers see this the moment they tap HELP on the order page."
            : "Saved — this is your organisation's own helpdesk information.",
        );
        setMeta(
          d.info?.updatedByName
            ? `Last saved by ${d.info.updatedByName}${d.info.updatedAt ? ` · ${new Date(d.info.updatedAt).toLocaleString()}` : ""}`
            : "",
        );
      } else {
        setError(d?.error || "Could not save. Please try again.");
      }
    } catch {
      setError("Network error — could not save.");
    } finally {
      setSaving(false);
    }
  };

  const field =
    "w-full pl-8 pr-3 py-2.5 bg-slate-800 border border-slate-700 focus:border-cyan-500/60 rounded-xl text-sm text-white outline-none";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto"
      data-testid="support-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Customer Support — storefront HELP editor"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden max-h-[calc(100dvh-2rem)] sm:max-h-[92vh] flex flex-col my-auto">
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-slate-800 shrink-0">
          <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shrink-0">
            <LifeBuoy className="w-5 h-5 text-slate-950" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-black text-white leading-tight">Customer Support — Storefront HELP</h2>
            <p className="text-[10px] text-slate-400 leading-tight">
              Shown to every customer inside the HELP panel on the public order page.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white shrink-0"
            aria-label="Close"
            data-testid="support-close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-3">
          {loading ? (
            <p className="text-center text-slate-400 text-xs py-6">Loading current support information…</p>
          ) : (
            <>
              <div className="relative">
                <UserIcon className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input value={contactName} onChange={(e) => setContactName(e.target.value)}
                  placeholder="Contact name (e.g. Ama Serwaa — Customer Care)" className={field} data-testid="support-name" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="relative">
                  <Phone className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input value={phone} onChange={(e) => setPhone(e.target.value)}
                    placeholder="Phone number (e.g. 055 123 4567)" inputMode="tel" className={field} data-testid="support-phone" />
                </div>
                <div className="relative">
                  <MessageCircle className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)}
                    placeholder="WhatsApp (e.g. 233551234567)" inputMode="tel" className={field} data-testid="support-whatsapp" />
                </div>
              </div>
              <div className="relative">
                <Mail className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email (e.g. support@gomina.com)" inputMode="email" className={field} data-testid="support-email" />
              </div>
              <div className="relative">
                <MapPin className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-3.5" />
                <textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={2}
                  placeholder="Business address / location (e.g. Plot 14, Spintex Road, Accra)" className={`${field} resize-none`} data-testid="support-address" />
              </div>
              <div className="relative">
                <Clock className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input value={openingHours} onChange={(e) => setOpeningHours(e.target.value)}
                  placeholder="Opening hours (e.g. Mon–Sat 7:00 AM – 7:00 PM)" className={field} data-testid="support-hours" />
              </div>
              <div className="relative">
                <Info className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-3.5" />
                <textarea value={extraInfo} onChange={(e) => setExtraInfo(e.target.value)} rows={3}
                  placeholder="Other important support information (delivery notes, MoMo guidance, after-hours contact…)" className={`${field} resize-none`} data-testid="support-extra" />
              </div>

              {/* ── Platform registration CTA — SUPER ADMIN ONLY ─────────────
                  This controls the public "Join GoMina 360" block inside the
                  storefront HELP panel, the order-page footer line and the
                  /join page. It is platform recruitment policy, so it is
                  deliberately NOT editable by a tenant-scoped
                  canManageSupport grant — only by the platform Super Admin. */}
              {canEditRegistration && (
                <div className="rounded-xl border border-fuchsia-500/40 bg-fuchsia-500/5 p-3 space-y-2.5" data-testid="support-registration-block">
                  <div className="flex items-start gap-2">
                    <Megaphone className="w-4 h-4 text-fuchsia-300 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-[11px] font-black text-fuchsia-200 uppercase tracking-wider">
                        Join GoMina 360 — registration
                      </p>
                      <p className="text-[10px] text-slate-400 leading-snug">
                        Order-page invite, public sign-up page, and the staff sign-in page.
                      </p>
                    </div>
                  </div>

                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={regEnabled}
                      onChange={(e) => setRegEnabled(e.target.checked)}
                      className="accent-fuchsia-500"
                      data-testid="support-registration-enabled"
                    />
                    Show the registration invite on the customer order page
                  </label>

                  {/* The SIGN-IN PAGE switch — deliberately separate: the
                      staff gate is an authentication surface, so this stays
                      hidden unless the platform owner asks for it. Toggling it
                      changes the Order page and /join in NO way. */}
                  <label className="flex items-start gap-2 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={regLoginEnabled}
                      onChange={(e) => setRegLoginEnabled(e.target.checked)}
                      className="accent-fuchsia-500 mt-0.5"
                      data-testid="support-registration-login-enabled"
                    />
                    <span>
                      Show the “Want your business on GoMina 360? Register it” link on the staff
                      sign-in page
                      <span className="block text-[10px] text-slate-500 leading-snug">
                        Sign-in page only — the order page invite above and the /join page are
                        unaffected. Off by default, so the sign-in page stays focused on
                        authentication.
                      </span>
                    </span>
                  </label>

                  <input
                    value={regHeadline}
                    onChange={(e) => setRegHeadline(e.target.value)}
                    placeholder="Headline (e.g. Run your business on GoMina 360)"
                    className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 focus:border-fuchsia-500/60 rounded-xl text-sm text-white outline-none"
                    data-testid="support-registration-headline"
                  />
                  <textarea
                    value={regNote}
                    onChange={(e) => setRegNote(e.target.value)}
                    rows={2}
                    placeholder="Short invitation (e.g. Tell us about your business and the team will call you back.)"
                    className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 focus:border-fuchsia-500/60 rounded-xl text-sm text-white outline-none resize-none"
                    data-testid="support-registration-note"
                  />
                  <a
                    href="/join"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-bold text-fuchsia-300 hover:text-fuchsia-200"
                  >
                    <ExternalLink className="w-3 h-3" /> Preview the public sign-up page
                  </a>
                </div>
              )}

              {error && (
                <div className="px-3 py-2.5 rounded-xl bg-rose-500/10 border border-rose-500/40 text-rose-300 text-xs" data-testid="support-error">
                  {error}
                </div>
              )}
              {saved && (
                <div className="px-3 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/40 text-emerald-300 text-xs" data-testid="support-saved">
                  {saved}
                </div>
              )}
              {meta && <p className="text-[10px] text-slate-500">{meta}</p>}
            </>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-slate-800 flex items-center justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs font-bold">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || loading}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-bold disabled:opacity-40"
            data-testid="support-save"
          >
            <Save className="w-3.5 h-3.5" /> {saving ? "Saving…" : "Save support info"}
          </button>
        </div>
      </div>
    </div>
  );
}
