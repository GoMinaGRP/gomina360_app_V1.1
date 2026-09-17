"use client";

import React, { useState } from "react";
import {
  BookOpen,
  CalendarClock,
  Factory,
  Route as RouteIcon,
} from "lucide-react";
import PreorderSetupView from "./PreorderSetupView";
import ProcurementPanel from "./ProcurementPanel";

type Hub = "SETUP" | "PROCUREMENT" | "GUIDE";

/**
 * Pre-Orders hub — the single prominent entry for authorized Owners and
 * Manage-Unit grantees:
 *   SETUP      — per-unit enable switch, fulfilment methods, product options
 *   PROCUREMENT— supplier purchase pipeline + goods receipts
 *   GUIDE      — the step-by-step walkthrough (owner → publish → customer)
 */
export default function PreordersHubView({
  currentUser,
  businesses,
}: {
  currentUser: any;
  businesses: any[];
}) {
  const [hub, setHub] = useState<Hub>("SETUP");

  return (
    <div className="space-y-4" data-testid="ph-root">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl">
        <div>
          <h2 className="text-base font-extrabold text-white flex items-center gap-2">
            <CalendarClock className="w-5 h-5 text-indigo-400" /> Pre-Orders
          </h2>
          <p className="text-[11px] text-slate-400 mt-0.5 max-w-2xl">
            Sell goods before they land in branch stock. Enable the capability per unit, define fulfilment
            options (price · ETA window · shipping method · deposit), publish to the storefront, then run the
            supplier pipeline — customer tracking follows every step automatically.
          </p>
        </div>
        <div className="flex items-center gap-1 bg-slate-900/70 border border-slate-700 rounded-xl p-1 w-fit" data-testid="ph-tabs">
          <button
            onClick={() => setHub("SETUP")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition ${hub === "SETUP" ? "bg-indigo-600 text-white shadow" : "text-slate-300 hover:text-white"}`}
            data-testid="ph-tab-setup"
          >
            <RouteIcon className="w-3.5 h-3.5" /> Setup
          </button>
          <button
            onClick={() => setHub("PROCUREMENT")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition ${hub === "PROCUREMENT" ? "bg-amber-600 text-white shadow" : "text-slate-300 hover:text-white"}`}
            data-testid="ph-tab-procurement"
          >
            <Factory className="w-3.5 h-3.5" /> Procurement
          </button>
          <button
            onClick={() => setHub("GUIDE")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition ${hub === "GUIDE" ? "bg-emerald-600 text-white shadow" : "text-slate-300 hover:text-white"}`}
            data-testid="ph-tab-guide"
          >
            <BookOpen className="w-3.5 h-3.5" /> Guide
          </button>
        </div>
      </div>

      {hub === "SETUP" && (
        <PreorderSetupView
          currentUser={currentUser}
          businesses={businesses}
          scopedBusinesses={businesses}
        />
      )}

      {hub === "PROCUREMENT" && (
        <ProcurementPanel scopedBusinesses={businesses} />
      )}

      {hub === "GUIDE" && <GuidePane />}
    </div>
  );
}

function GuidePane() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="ph-guide">
      {/* Owner journey */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
          <span className="w-6 h-6 rounded-full bg-indigo-600 text-white text-[10px] font-black flex items-center justify-center">A</span>
          Owner — enable & publish pre-orders (5 steps)
        </h3>
        <ol className="space-y-3 text-[12px] text-slate-300">
          <Step n={1} title="Enable Pre-Orders for the unit">
            Open <b>Setup</b> (this hub), pick the business/branch from the unit selector, then flip the
            <b>&nbsp;Pre-Orders Enabled</b> switch. The same switch lives in <b>Manage Businesses</b>.
            Only Owner or Manage-Unit grantees can flip it — it controls whether this unit can sell goods
            not yet in stock.
          </Step>
          <Step n={2} title="Confirm the storefront is on">
            In <b>Manage Businesses → Online</b> keep <b>Online Ordering</b> enabled — pre-orders travel
            through the same customer storefront.
          </Step>
          <Step n={3} title="Seed fulfilment methods (once per organization)">
            If the Methods list is empty, click <b>Seed standard methods</b> — this creates Air / Sea Freight /
            Road / Local Delivery / Pickup with default lead windows. Add your own methods any time.
          </Step>
          <Step n={4} title="Add a pre-order option to a product">
            Click <b>Offer</b> → pick the <b>Product</b> (from that unit's stock catalogue) and a{" "}
            <b>Fulfilment method</b> → set the <b>price</b>, <b>lead-time min/max days</b>,{" "}
            <b>deposit</b> (none / % / fixed) and <b>balance timing</b> (on arrival vs. when ready), plus
            an optional <b>preferred supplier</b>, <b>capacity cap</b> and <b>delivery-address rule</b>.
            Save — the option goes live immediately. Methods can be edited or disabled later from their rows.
          </Step>
          <Step n={5} title="It publishes instantly">
            The product card on <b>/order</b> now shows the option (indigo card: method · days · price ·
            deposit). Turning the unit's <b>Pre-Orders Enabled</b> switch OFF hides all its options from the
            storefront and blocks new pre-orders — existing orders keep flowing to completion.
          </Step>
        </ol>
      </div>

      {/* Customer journey + pipeline */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
          <span className="w-6 h-6 rounded-full bg-emerald-600 text-white text-[10px] font-black flex items-center justify-center">B</span>
          How a customer finds & places the pre-order
        </h3>
        <ol className="space-y-3 text-[12px] text-slate-300">
          <Step n={1} title="Browse the storefront">
            The customer opens <b>/order</b> from the link you share (WhatsApp, QR code at the counter, the
            app's share buttons…).
          </Step>
          <Step n={2} title="Spot pre-order cards">
            Products with an active option show <b>Pre-order only</b> (if out-of-stock) or an{" "}
            <b>indigo card</b> below the price: method, lead window, price and deposit terms.
          </Step>
          <Step n={3} title="Choose an option & quantity">
            They tap <b>Pre-order</b> on the option card (separate from the in-stock line — a product that
            supports both leads to separate cart lines). The checkout banner explains deposit and balance
            timing; if a deposit is due, the payment choice is forced to MTN MoMo.
          </Step>
          <Step n={4} title="Place & track">
            After placing, they get a tracking page showing the <b>9-stage journey</b>: Received → Confirmed
            → Supplier Procurement → Shipped → In Transit → Arrived → Received into Stock → Ready → Done.
            Pre-order stages render in indigo; deposit/balance status live-updates.
          </Step>
        </ol>

        <div className="mt-2 pt-3 border-t border-slate-700/60 text-[11px] text-slate-400 space-y-1.5" data-testid="ph-guide-ops">
          <p className="font-bold text-slate-300 uppercase tracking-wider text-[10px]">Your side of the chain</p>
          <ul className="list-disc pl-4 space-y-1">
            <li><b>Deposit first</b> — confirm it on the order row (amber button) before raising the PO; the ledger never double-books.</li>
            <li><b>Procurement tab</b> — raise a supplier PO for the waiting pre-orders (quantities auto-aggregated by product).</li>
            <li><b>Advance the PO</b> one stage at a time — the customer's tracking page follows automatically.</li>
            <li><b>Post goods receipt on Arrive</b> — only this physically lands stock; pre-order lines become committed for the customer, never counted as free branch stock.</li>
            <li><b>Balance & handover</b> — confirm balance, move the order to Ready → Delivered/Completed as usual.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="shrink-0 w-5 h-5 rounded-full bg-slate-700 text-slate-200 text-[10px] font-black flex items-center justify-center mt-0.5">
        {n}
      </span>
      <div>
        <p className="font-bold text-slate-100">{title}</p>
        <p className="text-slate-400 mt-0.5 leading-relaxed">{children}</p>
      </div>
    </li>
  );
}
