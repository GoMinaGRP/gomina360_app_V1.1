"use client";

import React, { useEffect, useState } from "react";

/**
 * Avatar — renders a user's profile photo (uploaded data URL or legacy
 * external URL) and, if the image is missing/unreachable (offline, dead
 * link), falls back automatically to the initial-letter circle so the UI
 * never shows a broken image.
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
  // A NEW url (fresh upload, different profile) always retries as an image.
  useEffect(() => { setBroken(false); }, [url]);
  if (url && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
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
