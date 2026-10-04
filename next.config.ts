import type { NextConfig } from "next";

/**
 * H1 (A–Z audit): HTTP security headers on every response.
 *
 * frame-ancestors / CSP: dashboards (financial data) and the checkout must
 * not be hijack-framed by arbitrary origins. The Arena/E2B live preview
 * legitimately embeds the app, so the preview host stays on the allowlist —
 * via FRAME_ANCESTORS env (comma-separated) or the defaults below.
 *
 * Script/style deliberately allow 'unsafe-inline' while the app's hydration
 * and inline-style attributes exist; tightening (nonces/hashes) is a
 * documented follow-up, NOT silently half-done.
 */
const extraFrameAncestors = (process.env.FRAME_ANCESTORS || "").split(",").map((s) => s.trim()).filter(Boolean);
const frameAncestors = ["'self'", "https://*.e2b.app", ...extraFrameAncestors].join(" ");

const isDev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  // Next.js dev mode uses React Refresh/webpack eval wrappers. Keep eval
  // disabled in production, but allow it locally so the Arena preview can
  // hydrate instead of sitting forever on the server-rendered "Initializing" shell.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  `connect-src 'self' data:${isDev ? " ws: wss:" : ""}`,
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // The public tracking page embeds the Google Maps viewer for live parcels —
  // keep frames scoped to Google map hosts only.
  "frame-src 'self' https://maps.google.com https://www.google.com",
  `frame-ancestors ${frameAncestors}`,
  "worker-src 'self' blob:",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(self), payment=()" },
  // HSTS only when explicitly serving real TLS in production (never break the
  // plain-HTTP sandbox): ENABLE_HSTS=1 turns it on.
  ...(process.env.ENABLE_HSTS === "1"
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
];

/**
 * Stored image bytes are DATA, not documents. `/api/menu/photo` and
 * `/api/branding` stream caller-supplied blobs (legacy rows can hold an
 * `image/svg+xml`, which is a scriptable document), so if a user opens one of
 * those URLs directly it must not be able to load subresources or run script
 * in the app's origin. These paths therefore carry the lockdown CSP instead of
 * the app CSP above. Embedding them via `<img src>` is unaffected — a CSP on an
 * image response does not constrain the page that paints it.
 */
const imageLockdownCsp = "default-src 'none'; sandbox; img-src 'none'";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "*.e2b.app",
    "127.0.0.1",
    "localhost",
  ],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Later, narrower rules win for the headers they set (the routes set the
      // same policy themselves as a second layer).
      { source: "/api/menu/photo", headers: [{ key: "Content-Security-Policy", value: imageLockdownCsp }] },
      { source: "/api/branding", headers: [{ key: "Content-Security-Policy", value: imageLockdownCsp }] },
    ];
  },
};

export default nextConfig;
