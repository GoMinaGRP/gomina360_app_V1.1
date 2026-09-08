"use client";

/**
 * Session bridge: keeps sign-in alive even in embedded/iframe previews where
 * the browser refuses to store third-party cookies.
 *
 * The login API returns the session token in its JSON body. We keep it in
 * sessionStorage (per-tab, origin-scoped, allowed even under third-party
 * storage partitioning) and install a thin window.fetch patch that attaches
 * it as an `x-gomina-session` header to every same-origin /api/* request.
 * The server accepts the header exactly like the httpOnly cookie, so ALL app
 * features keep working regardless of cookie policy — with zero changes to
 * the 20+ modules that call fetch directly.
 */

const TOKEN_KEY = "gomina_session_token";
let installed = false;

export function setSessionToken(token: string) {
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* storage disabled */ }
}

export function getSessionToken(): string | null {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function clearSessionToken() {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

export function installSessionBridge() {
  if (installed || typeof window === "undefined" || typeof window.fetch !== "function") return;
  installed = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: any, init?: RequestInit) => {
    try {
      const url = typeof input === "string" ? input : (input?.url ?? "");
      const token = getSessionToken();
      if (token && typeof url === "string" && url.startsWith("/api/")) {
        if (typeof Request !== "undefined" && input instanceof Request) {
          // Preserve method/body/etc. — clone with the added header.
          const req = new Request(input, init);
          req.headers.set("x-gomina-session", token);
          return originalFetch(req);
        }
        const headers = new Headers(init?.headers);
        headers.set("x-gomina-session", token);
        return originalFetch(url, { ...(init || {}), headers });
      }
    } catch { /* fall through to plain fetch */ }
    return originalFetch(input as any, init);
  }) as typeof window.fetch;
}
