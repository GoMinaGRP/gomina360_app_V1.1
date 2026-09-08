"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";

/**
 * useClampedDropdown — positions a navbar dropdown panel with `fixed`
 * coordinates derived from its trigger element and CLAMPS the result so the
 * panel can never render outside the viewport.
 *
 * Why: the page enforces `overflow-x: clip`, so any navbar content or panel
 * that extends past the screen edge is cut off with no way to scroll to it
 * (this made the Staff/Account menu unreachable on phones AND on 768px
 * tablets). Dropdowns open leftward from buttons near the right edge, so a
 * mid-row trigger (attendance clock, currency) on a narrow screen would
 * otherwise push its panel off the LEFT edge of the screen.
 *
 * Two details keep the anchor exact (menu opens DIRECTLY BELOW its button):
 *  1. The panel is ALWAYS position:fixed (initially visibility:hidden until
 *     measured). If it ever rendered statically — even for a single frame —
 *     it would inflate the wrapper, the wrapper would then be measured with
 *     the panel inside, and the menu would be anchored far below the button
 *     (this exact bug put the account menu ~250px low: 52 + 249 + 8 = 309px).
 *  2. Measuring happens in useLayoutEffect (same frame as the DOM mutation),
 *     so there is no stale-position paint and no flicker.
 *
 * The panel recalculates on window resize/scroll while open so it stays
 * attached to its trigger and always fully visible.
 *
 * Usage:
 *   const { rootRef, panelStyle } = useClampedDropdown(open, 288);
 *   <div className="relative" ref={rootRef}> …trigger…
 *     {open && <div style={panelStyle} className="…panel classes…">…}
 *   </div>
 *
 * `rootRef` wraps BOTH trigger and panel, so existing outside-click handlers
 * (`rootRef.current.contains(e.target)`) keep working even though the panel
 * is visually `fixed`-positioned (DOM containment is unchanged).
 */
export function useClampedDropdown(open: boolean, panelWidth: number): {
  rootRef: RefObject<HTMLDivElement | null>;
  panelStyle: CSSProperties;
} {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Start fixed + invisible: never statically inflate the anchor, never flash.
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({
    position: "fixed",
    visibility: "hidden",
    top: 0,
    left: 0,
  });

  const update = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const r = root.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Never wider than the viewport (leave an 8px margin on each side).
    const width = Math.min(panelWidth, Math.max(208, vw - 16));
    // Prefer the panel's right edge aligned with the trigger's right edge
    // (classic navbar menu), but clamp so the panel stays inside [8, vw-8].
    const left = Math.max(8, Math.min(r.right - width, vw - width - 8));
    // Drop down directly beneath the trigger; on very short screens, pull the
    // panel up so a usable slice always fits.
    const top = Math.max(8, Math.min(r.bottom + 8, Math.max(8, vh - 140)));
    const maxHeight = Math.max(128, vh - top - 12);
    setPanelStyle({ position: "fixed", visibility: "visible", top, left, width, maxHeight });
  }, [panelWidth]);

  // Layout effect: measure in the SAME frame the panel mounts — the panel is
  // still visibility:hidden here, and being position:fixed it can't distort
  // the anchor measurement, so the first visible paint is already exact.
  useLayoutEffect(() => {
    if (!open) {
      setPanelStyle((s) => (s.visibility === "hidden" ? s : { ...s, visibility: "hidden" }));
      return;
    }
    update();
    const on = () => update();
    window.addEventListener("resize", on);
    window.addEventListener("scroll", on, true);
    return () => {
      window.removeEventListener("resize", on);
      window.removeEventListener("scroll", on, true);
    };
  }, [open, update]);

  return { rootRef, panelStyle };
}
