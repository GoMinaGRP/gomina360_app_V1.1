import type { NextConfig } from "next";

/**
 * HTTP security headers (P1 of the A–Z audit).
 *
 * frame-ancestors instead of legacy X-Frame-Options so KNOWN embedding hosts
 * keep working:
 *   - 'self'                    → same-origin dashboards/exports
 *   - https://*.e2b.app         → Arena/e2b sandbox live-preview iframes
 *   - https://*.vercel.app      → Vercel preview deployments
 * Anything else embedding the app is refused by modern browsers
 * (clickjacking defence for the financial dashboards + checkout).
 *
 * A full content-security-policy (script/style/img/connect sources) needs a
 * measured rollout against the map-tile CDNs, data-URL photos and inline
 * styles — deliberately NOT shipped here; tracked as follow-up work.
 */
const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'self' https://*.e2b.app https://*.vercel.app" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The app legitimately uses GPS (attendance, delivery pins) and the camera
  // (photo capture) — allow both for same origin; disable everything else.
  { key: "Permissions-Policy", value: "camera=(self), geolocation=(self), microphone=(), payment=(), usb=()" },
  // Ignored over plain HTTP (local dev); enforced wherever HTTPS terminates.
  { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "*.e2b.app",
    "127.0.0.1",
    "localhost",
  ],
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
