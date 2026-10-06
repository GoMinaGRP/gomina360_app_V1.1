"use client";

import React, { useEffect, useMemo, useState } from "react";
import CustomerHeader from "@/components/CustomerHeader";
import {
  Building2,
  LifeBuoy,
  Phone,
  MessageCircle,
  Mail,
  MapPin,
  ArrowLeft,
  Send,
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  ClipboardCopy,
} from "lucide-react";
import {
  PLATFORM_REQUEST_PURPOSES,
  PLATFORM_REQUEST_BUSINESS_TYPES,
  PLATFORM_REQUEST_LIMITS,
  PLATFORM_REQUEST_HONEYPOT,
} from "@/lib/platformRequests";

/**
 * /join — the PUBLIC "Join / Register on the Platform" page.
 *
 * Linked from the storefront HELP panel, the order-page footer and the login
 * screen. Anyone can submit a request; the platform Super Admin reviews it
 * privately in the Platform Owners console. The submitter receives ONLY an
 * opaque reference code — there is no public list and no status lookup.
 *
 * Content (headline, note, contact details) is served by the public
 * `GET /api/support-info`, so the platform owner edits it in ONE place
 * (Settings & Storefront → Support — Storefront HELP).
 */
export default function JoinPage() {
  const [info, setInfo] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  const [purpose, setPurpose] = useState<string>("JOIN_PLATFORM");
  const [businessName, setBusinessName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [location, setLocation] = useState("");
  const [message, setMessage] = useState("");
  // Honeypot — visually and programmatically hidden from humans.
  const [trap, setTrap] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reference, setReference] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/support-info", { cache: "no-store" });
        const d = await res.json();
        if (d?.success) setInfo(d.info || null);
      } catch {
        /* the form still works without the published blurb */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const registrationOpen = info ? info.registrationEnabled !== false : true;
  const activePurpose = useMemo(
    () => PLATFORM_REQUEST_PURPOSES.find((p) => p.key === purpose) || PLATFORM_REQUEST_PURPOSES[0],
    [purpose],
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/platform-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purpose,
          businessName,
          contactName,
          contactEmail,
          contactPhone,
          businessType: businessType || null,
          location,
          message,
          source: "join",
          [PLATFORM_REQUEST_HONEYPOT]: trap,
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.success) throw new Error(d?.error || "Could not send your request. Please try again.");
      setDuplicate(!!d.duplicate);
      setReference(d.reference || null);
    } catch (e2: any) {
      setError(e2.message);
    } finally {
      setBusy(false);
    }
  };

  const copyRef = async () => {
    if (!reference) return;
    try {
      await navigator.clipboard.writeText(reference);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  const field =
    "w-full pl-9 pr-3 py-2.5 rounded-xl bg-white border border-slate-300 text-slate-900 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20";

  return (
    <div className="min-h-screen bg-slate-100">
      <CustomerHeader subtitle="Join the platform" title="GoMina 360">
        <div className="order-3 sm:order-2 basis-full sm:basis-auto sm:flex-1 min-w-0" />
        <a
          href="/order"
          className="ml-auto flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-[12px] font-black shadow transition"
          data-testid="join-back-order"
        >
          <ArrowLeft className="w-4 h-4" /> Shop the store
        </a>
      </CustomerHeader>

      <main className="max-w-3xl mx-auto px-3 sm:px-4 py-6 space-y-4">
        {reference ? (
          /* ── Success ───────────────────────────────────────────────────── */
          <section
            className="bg-white border border-emerald-300 rounded-2xl p-6 text-center space-y-3"
            data-testid="join-success"
          >
            <CheckCircle2 className="w-12 h-12 text-emerald-600 mx-auto" />
            <h1 className="text-lg font-black text-slate-900">Request received</h1>
            <p className="text-sm text-slate-600">
              The GoMina 360 platform team has your request and will contact you on the details you gave.
            </p>
            {reference && (
              <div className="bg-emerald-50 border border-emerald-300 rounded-xl px-4 py-3 inline-block">
                <p className="text-[10px] font-black uppercase tracking-wider text-emerald-800">Your reference code</p>
                <p className="font-mono text-xl font-black text-emerald-900" data-testid="join-reference">
                  {reference}
                </p>
                <button
                  onClick={copyRef}
                  className="mt-1 inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 underline"
                  data-testid="join-copy-reference"
                >
                  <ClipboardCopy className="w-3 h-3" /> {copied ? "Copied" : "Copy code"}
                </button>
              </div>
            )}
            <p className="text-[11px] text-slate-500">
              Keep this code — quote it if you call or WhatsApp us about this request.
            </p>
            <div className="flex items-center justify-center gap-3 pt-1">
              <a href="/order" className="text-xs font-bold text-cyan-700 underline">
                Back to the store
              </a>
              <button
                onClick={() => {
                  setReference(null);
                  setDuplicate(false);
                  setBusinessName("");
                  setMessage("");
                }}
                className="text-xs font-bold text-slate-500 underline"
                data-testid="join-send-another"
              >
                Send another request
              </button>
            </div>
          </section>
        ) : (
          <>
            {/* ── Intro ───────────────────────────────────────────────────── */}
            <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-2">
              <span className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1">
                <Building2 className="w-3 h-3" /> Join GoMina 360
              </span>
              <h1 className="text-xl sm:text-2xl font-black text-slate-900" data-testid="join-headline">
                {info?.registrationHeadline || "Run your business on GoMina 360"}
              </h1>
              <p className="text-sm text-slate-600" data-testid="join-note">
                {info?.registrationNote ||
                  "Tell us about your business and the platform team will get back to you with the next steps."}
              </p>
              <p className="text-[11px] text-slate-500 flex items-start gap-1.5 pt-1">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                Your request goes privately to the GoMina 360 platform owner. No other business or customer can see it.
              </p>
            </section>

            {loading ? (
              <p className="text-center text-slate-500 text-sm py-6">Loading…</p>
            ) : !registrationOpen ? (
              /* ── Registration switched off by the platform owner ───────── */
              <section
                className="bg-white border border-amber-300 rounded-2xl p-6 text-center space-y-2"
                data-testid="join-closed"
              >
                <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto" />
                <h2 className="text-sm font-black text-slate-900">Registration is closed right now</h2>
                <p className="text-xs text-slate-600">
                  New sign-ups are paused. You can still reach the platform team directly:
                </p>
                <ContactLinks info={info} />
              </section>
            ) : (
              /* ── The form ──────────────────────────────────────────────── */
              <form
                onSubmit={submit}
                className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4"
                data-testid="join-form"
              >
                <div>
                  <label className="block text-[11px] font-black uppercase tracking-wider text-slate-700 mb-1.5">
                    What is this about?
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5" data-testid="join-purpose-options">
                    {PLATFORM_REQUEST_PURPOSES.map((p) => (
                      <label
                        key={p.key}
                        className={`flex items-start gap-2 rounded-xl border px-3 py-2 cursor-pointer transition ${
                          purpose === p.key
                            ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500/20"
                            : "border-slate-200 hover:bg-slate-50"
                        }`}
                        data-testid={`join-purpose-${p.key}`}
                      >
                        <input
                          type="radio"
                          name="purpose"
                          value={p.key}
                          checked={purpose === p.key}
                          onChange={() => setPurpose(p.key)}
                          className="mt-1 accent-emerald-600"
                        />
                        <span className="min-w-0">
                          <span className="block text-[12px] font-bold text-slate-900 leading-snug">{p.label}</span>
                          <span className="block text-[10px] text-slate-500 leading-snug">{p.hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="relative">
                    <Building2 className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      value={businessName}
                      onChange={(e) => setBusinessName(e.target.value.slice(0, PLATFORM_REQUEST_LIMITS.businessName))}
                      placeholder="Business name"
                      className={field}
                      data-testid="join-business"
                    />
                  </div>
                  <div className="relative">
                    <input
                      required
                      value={contactName}
                      onChange={(e) => setContactName(e.target.value.slice(0, PLATFORM_REQUEST_LIMITS.contactName))}
                      placeholder="Your name *"
                      className={`${field} pl-3`}
                      data-testid="join-name"
                    />
                  </div>
                  <div className="relative">
                    <Mail className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="email"
                      value={contactEmail}
                      onChange={(e) => setContactEmail(e.target.value.slice(0, PLATFORM_REQUEST_LIMITS.contactEmail))}
                      placeholder="Email address"
                      className={field}
                      data-testid="join-email"
                    />
                  </div>
                  <div className="relative">
                    <Phone className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      inputMode="tel"
                      value={contactPhone}
                      onChange={(e) => setContactPhone(e.target.value.slice(0, PLATFORM_REQUEST_LIMITS.contactPhone))}
                      placeholder="Phone (10 digits, e.g. 0551234567)"
                      className={field}
                      data-testid="join-phone"
                    />
                  </div>
                  <div className="relative">
                    <Building2 className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <select
                      value={businessType}
                      onChange={(e) => setBusinessType(e.target.value)}
                      className={`${field} appearance-none`}
                      data-testid="join-type"
                    >
                      <option value="">What kind of business? (optional)</option>
                      {PLATFORM_REQUEST_BUSINESS_TYPES.map((t) => (
                        <option key={t.key} value={t.key}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="relative">
                    <MapPin className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      value={location}
                      onChange={(e) => setLocation(e.target.value.slice(0, PLATFORM_REQUEST_LIMITS.location))}
                      placeholder="Town / city"
                      className={field}
                      data-testid="join-location"
                    />
                  </div>
                </div>

                <div className="relative">
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value.slice(0, PLATFORM_REQUEST_LIMITS.message))}
                    rows={4}
                    placeholder={
                      activePurpose.key === "JOIN_PLATFORM"
                        ? "Tell us what you sell or produce, and which modules you need."
                        : "Anything else we should know?"
                    }
                    className="w-full px-3 py-2.5 rounded-xl bg-white border border-slate-300 text-slate-900 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 resize-none"
                    data-testid="join-message"
                  />
                </div>

                {/* Honeypot — hidden from humans (and from assistive tech). */}
                <div className="hidden" aria-hidden="true">
                  <label>
                    Company website
                    <input
                      tabIndex={-1}
                      autoComplete="off"
                      value={trap}
                      onChange={(e) => setTrap(e.target.value)}
                      name={PLATFORM_REQUEST_HONEYPOT}
                      data-testid="join-honeypot"
                    />
                  </label>
                </div>

                {error && (
                  <div
                    className="px-3 py-2.5 rounded-xl bg-rose-50 border border-rose-300 text-rose-700 text-xs font-bold"
                    data-testid="join-error"
                  >
                    {error}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="submit"
                    disabled={busy || contactName.trim().length < 2}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-black shadow disabled:opacity-40 disabled:cursor-not-allowed"
                    data-testid="join-submit"
                  >
                    <Send className="w-3.5 h-3.5" /> {busy ? "Sending…" : "Send my request"}
                  </button>
                  <p className="text-[10px] text-slate-500">
                    We only use these details to contact you about this request.
                  </p>
                </div>

                <div className="border-t border-slate-200 pt-3">
                  <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1.5">
                    Prefer to talk to us?
                  </p>
                  <ContactLinks info={info} />
                </div>
              </form>
            )}
          </>
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white mt-6">
        <div className="max-w-3xl mx-auto px-4 py-5 text-center space-y-1">
          <p className="text-[11px] text-slate-600">
            GoMina 360 · Platform sign-up. Looking to buy something instead?{" "}
            <a href="/order" className="font-black text-cyan-700 underline">
              Visit the store
            </a>{" "}
            or{" "}
            <a href="/track" className="font-black text-cyan-700 underline">
              track an order
            </a>
            .
          </p>
        </div>
      </footer>
    </div>
  );
}

/** The platform's published contact channels (everything the owner has set). */
function ContactLinks({ info }: { info: any }) {
  if (!info) return <p className="text-[11px] text-slate-500">Contact details are being set up.</p>;
  const wa = info.whatsapp ? String(info.whatsapp).replace(/\D/g, "") : "";
  const has = info.phone || info.whatsapp || info.email || info.address;
  if (!has) return <p className="text-[11px] text-slate-500">Contact details are being set up.</p>;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[12px]">
      {info.phone && (
        <a href={`tel:${String(info.phone).replace(/\s+/g, "")}`} className="inline-flex items-center gap-1.5 text-slate-700 hover:text-emerald-700">
          <Phone className="w-3.5 h-3.5 text-emerald-600" /> <span className="font-bold">{info.phone}</span>
        </a>
      )}
      {info.whatsapp && (
        <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-slate-700 hover:text-green-700">
          <MessageCircle className="w-3.5 h-3.5 text-green-600" /> <span className="font-bold">{info.whatsapp}</span>
        </a>
      )}
      {info.email && (
        <a href={`mailto:${info.email}`} className="inline-flex items-center gap-1.5 text-slate-700 hover:text-sky-700">
          <Mail className="w-3.5 h-3.5 text-sky-600" /> <span className="font-bold">{info.email}</span>
        </a>
      )}
      {info.address && (
        <span className="inline-flex items-center gap-1.5 text-slate-700">
          <MapPin className="w-3.5 h-3.5 text-rose-500" /> <span className="font-bold whitespace-pre-line">{info.address}</span>
        </span>
      )}
      {info.openingHours && (
        <span className="inline-flex items-center gap-1.5 text-slate-700">
          <LifeBuoy className="w-3.5 h-3.5 text-violet-500" /> <span className="font-bold">{info.openingHours}</span>
        </span>
      )}
    </div>
  );
}
