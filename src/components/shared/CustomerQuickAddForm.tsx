"use client";

import React, { useState } from "react";

/**
 * One quick "add a customer" form for the field surfaces (Sales & Payments
 * branch workspace and the Worker Dashboard).
 *
 * Both used to carry their own copy of the same four inputs, the same
 * `@client.gh` e-mail fallback and the same POST — a second writer beside the
 * canonical Customers & CRM form. They now render this component, so the
 * payload contract (`/api/enterprise`, entityType "customer", business-scoped)
 * can only be changed in one place.
 */
export interface CustomerQuickAddFormProps {
  /** Owning unit — the customer is visible only on this business. */
  businessId?: number | string | null;
  onCreated?: () => void;
  /** Optional flash message hook (worker dashboard shows a saved notice). */
  onSaved?: (message: string) => void;
  defaultType?: string;
  showEmail?: boolean;
  submitLabel?: string;
  /** Container class of the <form>; defaults to a compact stacked layout. */
  className?: string;
  testidPrefix?: string;
}

const TYPES = [
  { v: "RETAIL", l: "Retail" },
  { v: "WHOLESALE", l: "Wholesale" },
  { v: "CORPORATE", l: "Corporate" },
];

export default function CustomerQuickAddForm({
  businessId,
  onCreated,
  onSaved,
  defaultType = "RETAIL",
  showEmail = true,
  submitLabel = "Create Customer",
  className = "mt-4 space-y-3",
  testidPrefix = "custq",
}: CustomerQuickAddFormProps) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("+233 24 ");
  const [email, setEmail] = useState("");
  const [type, setType] = useState(defaultType);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/enterprise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "customer",
          data: {
            name,
            type,
            phone,
            email: email || `${name.toLowerCase().replace(/\s/g, ".")}@client.gh`,
            businessId,
          },
        }),
      });
      if (res.ok) {
        setName("");
        setPhone("+233 24 ");
        setEmail("");
        setType(defaultType);
        onSaved?.("✓ Customer added — form cleared for the next one.");
        onCreated?.();
      }
    } catch (err) {
      console.error("Customer creation error:", err);
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-emerald-500";
  const labelClass = "block text-xs font-semibold text-slate-400 mb-1";

  return (
    <form onSubmit={submit} className={className}>
      <div>
        <label className={labelClass}>Full Name *</label>
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Customer full name"
          data-testid={`${testidPrefix}-name`}
          className={inputClass}
        />
      </div>
      <div className={showEmail ? "grid grid-cols-2 gap-3" : "grid grid-cols-2 gap-3"}>
        <div>
          <label className={labelClass}>Phone Number</label>
          <input
            type="text"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            data-testid={`${testidPrefix}-phone`}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Customer Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            data-testid={`${testidPrefix}-type`}
            className={inputClass}
          >
            {TYPES.map((t) => (
              <option key={t.v} value={t.v}>
                {t.l}
              </option>
            ))}
          </select>
        </div>
      </div>
      {showEmail && (
        <div>
          <label className={labelClass}>Email (optional)</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="customer@email.com"
            data-testid={`${testidPrefix}-email`}
            className={inputClass}
          />
        </div>
      )}
      <button
        type="submit"
        disabled={busy}
        data-testid={`${testidPrefix}-submit`}
        className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-lg transition disabled:opacity-50"
      >
        {busy ? "Creating..." : submitLabel}
      </button>
    </form>
  );
}
