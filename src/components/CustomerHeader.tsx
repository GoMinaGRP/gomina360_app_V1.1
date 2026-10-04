"use client";

import React from "react";
import Link from "next/link";

/**
 * CustomerHeader — the ONE storefront header used by both customer-facing
 * pages (`/order` and `/track`). Same dark Amazon-style band, same brand
 * block, same place for a departments strip; each page fills the middle slot
 * with its own controls (search + HELP + cart on /order, the page title and
 * "Order online" link on /track).
 *
 * Keeping it in one component is what stops the two pages drifting apart
 * again (the audit that preceded this work found the tracking page was a
 * different product visually).
 */
export default function CustomerHeader({
  children,
  strip,
  subtitle = "Official store · live stock",
  title,
  showLogo = true,
  testid = "oo-header",
}: {
  /** Middle/right controls — laid out inside the header's flex row. */
  children?: React.ReactNode;
  /** Optional second row (the departments strip on /order). */
  strip?: React.ReactNode;
  subtitle?: string;
  /** Optional page name shown next to the brand (used by /track). */
  title?: string;
  showLogo?: boolean;
  testid?: string;
}) {
  return (
    <header className="bg-[#131921] text-white sticky top-0 z-40 shadow-lg" data-testid={testid}>
      <div className="max-w-7xl mx-auto px-3 sm:px-4 pt-2.5 pb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        {showLogo && (
          <Link
            href="/"
            className="flex items-center gap-2 shrink-0"
            data-testid="oo-logo"
            aria-label="GoMina 360 — go to the Login page"
            title="Go to the GoMina 360 Login page"
          >
            <span className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center font-black text-white text-sm shadow">
              360
            </span>
            <span className="leading-tight hidden xs:block sm:block">
              <span className="block text-sm font-black">{title || "GoMina 360"}</span>
              <span className="block text-[9px] text-emerald-300">{subtitle}</span>
            </span>
          </Link>
        )}
        {children}
      </div>
      {strip}
    </header>
  );
}
