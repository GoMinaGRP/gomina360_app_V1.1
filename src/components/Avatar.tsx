"use client";

import React, { useEffect, useState } from "react";

/**
 * Avatar — renders an uploaded/same-origin profile photo and otherwise falls
 * back to the initial-letter circle.  Legacy demo records used third-party
 * image URLs; loading them during dashboard bootstrap adds an unreliable
 * external network request to every login, so remote URLs are treated as
 * missing instead of being fetched.
 *
 * The img branch keeps `data-testid` so tests/tooling can assert a real
 * photo is being shown; the fallback carries no testid.
 */
export default function Avatar({
  name,
  url,
  imgClass,
  fallbackClass,
  testid,
  fallbackTestid,
}: {
  name?: string | null;
  url?: string | null;
  imgClass: string;
  fallbackClass: string;
  testid: string;
  /** Optional testid for the fallback circle (modals that assert "no photo"). */
  fallbackTestid?: string;
}) {
  const [broken, setBroken] = useState(false);
  const normalizedUrl = typeof url === "string" ? url.trim() : "";
  const isRenderableUrl =
    normalizedUrl.startsWith("data:image/") ||
    normalizedUrl.startsWith("blob:") ||
    normalizedUrl.startsWith("/");
  // A NEW url (fresh upload, different profile) always retries as an image.
  useEffect(() => { setBroken(false); }, [normalizedUrl]);
  if (normalizedUrl && isRenderableUrl && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={normalizedUrl}
        alt={name || "Staff"}
        className={imgClass}
        data-testid={testid}
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <div className={fallbackClass} {...(fallbackTestid ? { "data-testid": fallbackTestid } : {})}>
      {(name || "?").charAt(0).toUpperCase()}
    </div>
  );
}
