"use client";

import React, { useMemo } from "react";
import {
  watermarkLabel,
  watermarkRender,
  watermarkTileUri,
  type WatermarkSpec,
} from "@/lib/watermark";

/**
 * Display-time watermark layer — absolutely positioned ABOVE an image (its
 * parent must already be `relative`). Render-once pure CSS/SVG:
 *   • no DOM event handlers (`pointer-events: none`),
 *   • no raster re-encoding — image quality untouched,
 *   • `overflow: hidden` + inset-expanded tile so edges never cut text,
 *   • sizes track the container (%-anchored), so cards, thumbnails and the
 *     full-screen zoomed lightbox all carry the identical faint treatment.
 *
 * `compact` (for ~44px thumbnails): skip the diagonal text (unreadable at
 * that scale) and show only the corner chip/monogrammed letter — still
 * distinct but noise-free.
 */
export default function WatermarkOverlay({
  spec,
  compact = false,
  className = "",
}: {
  spec: WatermarkSpec | null | undefined;
  compact?: boolean;
  className?: string;
}) {
  const r = useMemo(() => watermarkRender(spec), [spec?.enabled, spec?.mode, spec?.logo, spec?.name]);
  const tile = useMemo(() => (r.showText ? watermarkTileUri(r.text) : ""), [r.text, r.showText]);
  if (!r.active) return null;

  return (
    <div
      aria-hidden="true"
      data-testid="wm-overlay"
      data-compact={compact ? "1" : "0"}
      className={`absolute inset-0 z-[5] pointer-events-none select-none overflow-hidden ${className}`}
      style={{ borderRadius: "inherit" }}
    >
      {/* Diagonal tiled business name — the resilient, uncroppable layer. */}
      {r.showText && !compact && (
        <div
          data-testid="wm-tile"
          className="absolute"
          style={{
            inset: "-12%",
            backgroundImage: `url("${tile}")`,
            backgroundRepeat: "repeat",
          }}
        />
      )}
      {/* Corner logo chip — greyscale, fixed low opacity, % of the short side
          (uses container width as proxy, capped for giant images). */}
      {r.showLogo && r.logo && (
        <img
          data-testid="wm-logo"
          src={r.logo}
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            // top-right — the bottom corners belong to gallery controls
            // (zoom pill, zoom-in badge, counters).
            right: compact ? "6%" : "4%",
            top: compact ? "6%" : "4%",
            width: compact ? "30%" : "16%",
            minWidth: compact ? 10 : 20,
            maxWidth: compact ? 26 : 96,
            opacity: 0.17,
            filter: "grayscale(1) drop-shadow(0 1px 1px rgba(15,23,42,0.35))",
            borderRadius: 6,
          }}
        />
      )}
      {/* Compact+name mode: a single tiny monogram chip (first letter of the
          business) bottom-right, instead of an unreadable text scatter. */}
      {compact && r.showText && !r.showLogo && (
        <span
          data-testid="wm-mono"
          style={{
            position: "absolute",
            right: "6%",
            bottom: "6%",
            width: "42%",
            maxWidth: 20,
            aspectRatio: "1 / 1",
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 9,
            fontWeight: 800,
            color: "rgba(15,23,42,0.10)",
            background: "rgba(255,255,255,0.35)",
          }}
        >
          {watermarkLabel(r.text).charAt(0).toUpperCase() || "G"}
        </span>
      )}
    </div>
  );
}
