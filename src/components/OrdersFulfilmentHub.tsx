"use client";

/**
 * OrdersFulfilmentHub — one page, two tabs.
 *
 * The sidebar audit (docs/SIDEBAR-NAV-AUDIT.md, §2.2) found Pre-Orders and
 * Customer Order & Tracking were two front doors onto the same object graph
 * (they even mounted the same ProcurementPanel — see the P6 register RA-11).
 * They are now one destination with two tabs: "Live Orders" is the existing
 * tracking register, "Pre-Orders & Procurement" is the existing PreordersHubView.
 *
 * Both original screens are mounted EXACTLY as before (same props, same
 * test-ids, same server scoping) — only the wrapper is new, so nothing about
 * ordering, procurement or tracking behaviour changes. Deep links keep working:
 * TRACKING and PREORDERS remain real destinations, reachable from the sidebar
 * rows, the command palette, the bell and the right rail.
 */

import React from "react";
import { Truck, CalendarClock } from "lucide-react";

interface OrdersFulfilmentHubProps {
  activeTab: string;
  onSelectTab: (tab: string) => void;
  /** Live Orders — the customer order & tracking register. */
  live: React.ReactNode;
  /** Pre-Orders & Procurement — setup, offers, procurement chain, guide. */
  preorders: React.ReactNode;
}

export default function OrdersFulfilmentHub({
  activeTab,
  onSelectTab,
  live,
  preorders,
}: OrdersFulfilmentHubProps) {
  const tabs = [
    {
      id: "TRACKING",
      label: "Live Orders",
      hint: "Customer Order & Tracking register",
      Icon: Truck,
    },
    {
      id: "PREORDERS",
      label: "Pre-Orders & Procurement",
      hint: "Setup, offers, purchase chain & guide",
      Icon: CalendarClock,
    },
  ];

  return (
    <div data-testid="ofs-hub" className="min-w-0">
      <div
        className="sticky top-0 z-20 bg-slate-950/95 backdrop-blur border-b border-slate-800/80 px-3 sm:px-6 pt-3"
        data-printchrome="true"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-black uppercase tracking-wider text-slate-500 mr-1">
            Orders &amp; Fulfilment
          </span>
          <div className="flex items-center gap-1" role="tablist" aria-label="Orders & Fulfilment views">
            {tabs.map((t) => {
              const active = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={active}
                  title={t.hint}
                  data-testid={`ofs-tab-${t.id}`}
                  onClick={() => onSelectTab(t.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-xs font-semibold border-b-2 transition ${
                    active
                      ? "border-emerald-400 text-emerald-300 bg-emerald-500/10"
                      : "border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
                  }`}
                >
                  <t.Icon className="w-3.5 h-3.5" />
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Only the active tab mounts, exactly like the old per-tab dispatch —
          so fetching, focus handling and server scoping are unchanged. */}
      {activeTab === "PREORDERS" ? preorders : live}
    </div>
  );
}
