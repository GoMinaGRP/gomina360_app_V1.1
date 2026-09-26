"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Mail, MessageCircle, MoreHorizontal, Share2 } from "lucide-react";

/**
 * ProductShareMenu — the per-product Share affordance on the Customer Order
 * storefront. Builds a STABLE deep link to the exact product
 * (`/order?biz=<businessId>&p=<productId>`) and hands it to the channels
 * customers actually use:
 *
 *   • WhatsApp (wa.me), Telegram, Facebook, X — direct share intents
 *   • Email (mailto)
 *   • Copy Link (clipboard API with execCommand fallback for old browsers)
 *   • "More apps" — the native Web Share sheet (navigator.share), which on
 *     phones lists every installed messaging/social app; hidden where the
 *     API is unavailable (most desktops)
 *
 * The URL is built from window.location.origin at share time, so links are
 * correct in every deployment (preview, staging, production domain) and keep
 * working after re-deploys — the ids in the query string are stable database
 * keys, not row positions.
 */
export default function ProductShareMenu({
  product,
  biz,
  priceLabel,
}: {
  /** Menu product row (needs id; sku is used as a resilient fallback key). */
  product: { id: number; sku?: string | null; name: string };
  /** The product's menu business row (businessId + name). */
  biz: { businessId: number; businessName: string } | null | undefined;
  /** Preformatted price string (e.g. "GH₵ 25") — keeps the component dumb. */
  priceLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // On phones the 228 px panel is wider than a product card — keep it fully
  // inside the viewport by shifting it horizontally after it opens.
  const [shiftX, setShiftX] = useState(0);
  useEffect(() => {
    if (!open) return;
    setShiftX(0);
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    let dx = 0;
    if (r.left < pad) dx = pad - r.left;
    else if (r.right > window.innerWidth - pad) dx = window.innerWidth - pad - r.right;
    if (dx) setShiftX(dx);
  }, [open]);

  // The shareable deep link — stable ids only, built against the current
  // origin so it is correct wherever the storefront is deployed.
  const url = useMemo(
    () =>
      typeof window === "undefined"
        ? ""
        : `${window.location.origin}/order?biz=${biz?.businessId ?? ""}&p=${product.id}`,
    [biz?.businessId, product.id],
  );
  const shareText = `${product.name}${priceLabel ? ` — ${priceLabel}` : ""}${
    biz?.businessName ? ` from ${biz.businessName}` : ""
  }`;
  const fullMessage = `${shareText}. Order here: ${url}`;

  const close = useCallback(() => {
    setOpen(false);
    setCopied(false);
  }, []);

  // Outside click / Esc closes the panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("touchstart", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("touchstart", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const copyLink = useCallback(async () => {
    const legacyCopy = () => {
      // Legacy fallback (non-secure contexts / old mobile browsers / the
      // async API rejecting without user-activation in embedded webviews).
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      document.body.removeChild(ta);
      return ok;
    };
    let copiedOk = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        copiedOk = true;
      } else {
        copiedOk = legacyCopy();
      }
    } catch {
      copiedOk = legacyCopy();
    }
    if (copiedOk) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
    /* On total failure the panel stays open with the URL visible in full —
       the customer can still long-press / select it. */
  }, [url]);

  const nativeShare = useCallback(async () => {
    if (!navigator.share) return;
    try {
      await navigator.share({ title: product.name, text: shareText, url });
    } catch {
      /* user dismissed the sheet — nothing to do */
    }
  }, [product.name, shareText, url]);

  const enc = encodeURIComponent;
  const targets = [
    {
      key: "whatsapp",
      label: "WhatsApp",
      icon: <MessageCircle className="w-3.5 h-3.5 text-emerald-500" />,
      href: `https://wa.me/?text=${enc(fullMessage)}`,
    },
    {
      key: "telegram",
      label: "Telegram",
      icon: <SendIcon />,
      href: `https://t.me/share/url?url=${enc(url)}&text=${enc(shareText)}`,
    },
    {
      key: "facebook",
      label: "Facebook",
      icon: <span className="w-3.5 h-3.5 flex items-center justify-center text-[13px] font-black text-[#1877F2] leading-none">f</span>,
      href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`,
    },
    {
      key: "x",
      label: "X",
      icon: <span className="w-3.5 h-3.5 flex items-center justify-center text-[11px] font-black text-slate-800 leading-none">𝕏</span>,
      href: `https://twitter.com/intent/tweet?url=${enc(url)}&text=${enc(shareText)}`,
    },
    {
      key: "email",
      label: "Email",
      icon: <Mail className="w-3.5 h-3.5 text-sky-600" />,
      href: `mailto:?subject=${enc(shareText)}&body=${enc(fullMessage)}`,
    },
  ];

  return (
    <div className="relative" ref={wrapRef} data-testid={`oo-share-wrap-${product.id}`}>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label={`Share ${product.name}`}
        title="Share this product"
        className="flex items-center gap-1 px-2 py-1 rounded-full border border-slate-200 bg-white hover:border-amber-400 hover:bg-amber-50 text-slate-600 text-[10px] font-bold transition"
        data-testid={`oo-share-${product.id}`}
      >
        <Share2 className="w-3.5 h-3.5" /> Share
      </button>

      {open && (
        <div
          ref={panelRef}
          style={shiftX ? { transform: `translateX(${shiftX}px)` } : undefined}
          className="absolute right-0 top-full mt-1.5 z-30 w-[228px] rounded-xl border border-slate-200 bg-white shadow-xl p-2"
          role="menu"
          aria-label="Share this product"
          data-testid={`oo-share-menu-${product.id}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-1 pb-1.5 text-[9px] font-black uppercase tracking-wider text-slate-400">
            Share this product
          </div>
          <div className="grid grid-cols-2 gap-1">
            {targets.map((t) => (
              <a
                key={t.key}
                href={t.href}
                target="_blank"
                rel="noreferrer"
                role="menuitem"
                className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-slate-100 bg-slate-50 hover:bg-amber-50 hover:border-amber-300 text-[11px] font-bold text-slate-700 transition"
                data-testid={`oo-share-${t.key}-${product.id}`}
              >
                {t.icon} {t.label}
              </a>
            ))}
          </div>
          <div className="my-1.5 border-t border-slate-100" />
          <button
            type="button"
            role="menuitem"
            onClick={copyLink}
            className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-slate-100 bg-slate-50 hover:bg-amber-50 hover:border-amber-300 text-[11px] font-bold text-slate-700 transition"
            data-testid={`oo-share-copy-${product.id}`}
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-slate-500" />}
            {copied ? "Link copied!" : "Copy link"}
          </button>
          {typeof navigator !== "undefined" && !!(navigator as unknown as { share?: unknown }).share && (
            <button
              type="button"
              role="menuitem"
              onClick={nativeShare}
              className="mt-1 w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-amber-50 hover:border-amber-300 text-[11px] font-bold text-slate-700 transition"
              data-testid={`oo-share-more-${product.id}`}
            >
              <MoreHorizontal className="w-3.5 h-3.5 text-slate-500" /> More apps…
            </button>
          )}
          <div
            className="mt-1.5 px-1.5 py-1 rounded-md bg-slate-50 border border-slate-100 text-[9px] font-mono text-slate-400 break-all leading-snug"
            data-testid={`oo-share-url-${product.id}`}
          >
            {url}
          </div>
        </div>
      )}
    </div>
  );
}

/** Telegram's paper-plane, in lucide's stroke style. */
function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-sky-500">
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}
