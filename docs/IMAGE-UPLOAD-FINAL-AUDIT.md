# Image Upload & Optimization — Final Verification Audit

**Scope (as requested):** verify the completed image implementation end-to-end — (a) security and actual
image validation, (b) WebP/JPEG compatibility across **all** consumers, (c) backup/export → restore,
(d) existing legacy images, (e) that no remaining API or page loads unnecessarily large image data,
(f) that the new thumbnail fields and optimized images restore correctly, (g) no database / compatibility /
performance regressions.

**Method:** code-level trace of every image column, writer, reader and `<img>` consumer; live measurement
against the running app + Postgres (`q.mjs`, `curl`, headless Chromium probes); and full regression suites.
Professional judgment applied to fix what the audit found — nothing else was touched.

**Commits**

| SHA | Contents |
| --- | --- |
| `a47df44` | Final-audit fixes: wire-policy hardening, serving lockdown, legacy-safe photo edits, +20 wire-budget checks, orders-maps Z4 harness fix |
| `ad89de4` | Preceding tip (implementation report + expense-ui rail fix) |
| `29cf5c2` | Image implementation (`bed2c29` = the implementation report) |

**Verdict: sound.** Nine real issues were found and fixed; everything else re-verified clean. Final state:
`tsc --noEmit` clean, production build clean, 26 suites green (see §8).

---

## 1. What was found and fixed

| # | Finding | Impact | Fix |
| --- | --- | --- | --- |
| 1 | **Unused image bytes on four list endpoints.** `/api/transport`, `/api/block-factory`, `/api/poultry/feed-mill`, `/api/aquaculture/feed-mill` each shipped one ≤400 px thumbnail per stock row, but **no consumer of those payloads paints an image** (0 `<img>`, 0 `photo` references in `TransportModule`, `BlockFactoryModule`, `BlockMixing`, `PoultryFeedMill`, `AquaFeedMill`, `UniversalExportCenter`; `BlockQcCenter` only needs `hasPhoto`). | Up to ~23 KB × N rows per poll for nothing — still a "large image data" load, just bounded. | `slimInventoryRows(rows, { keepImage: false })` → rows carry `photoCount`/`hasPhoto`, zero bytes. New suite section E fails if an image reappears. |
| 2 | **Serving lockdown CSP was ineffective.** `/api/menu/photo` and `/api/branding` set `Content-Security-Policy: default-src 'none'; sandbox; img-src 'none'`, but the app-wide CSP in `next.config.ts` (`/:path*`) **overwrote it** — measured live, only the app CSP was on the wire. | A stored legacy `image/svg+xml` opened directly could load subresources/run inline script in the app origin (nosniff + `attachment` still prevented the worst). | Enforced at the config level (`next.config.ts`): narrower rules for `/api/menu/photo` and `/api/branding` set the lockdown CSP and win. Route-level headers kept as a second layer. Verified by curl (below). |
| 3 | **`/api/branding` only hardened on the 304 branch.** | The gzip/plain 200 JSON branches (the common case) had no lockdown headers. | CSP + nosniff added to all three branches. |
| 4 | **Legacy-edit bricking.** Editing an existing employee/asset re-sent the *stored* legacy photo, which the new byte budget rejects → PATCH 400. | Users could not edit old records that carry a pre-optimizer image. | Client: `EmployeeCenter` sends `photo` only when the user changed it (`photoDirty`). Server: `employees`/`assets` PATCH accept a byte-identical unchanged value. Both halves kept. |
| 5 | **Empty/whitespace "valid" images.** Base64 validation accepted whitespace and 0-byte payloads. | Stored rows that no browser can render. | `mediaValidation.ts`: strict `^data:image/<type>;base64,[A-Za-z0-9+/]+={0,2}$` + reject < 4 decoded bytes. |
| 6 | **Receipts shipped on every ledger list** (`/api/transactions` ×3 paths). | Large payloads for evidence nothing on those screens paints. | `stripReceipts` → `receiptCount`; the Records drawer fetches the full record on demand. |
| 7 | **Vehicle / fuel / checklist / QC evidence photos shipped to screens that never paint them.** | Same class as #1. | `stripPhotos` → `hasPhoto` (indicators keep working, `BlockQcCenter` reads it). |
| 8 | **Silent pass-through of un-decodable images.** SVG/GIF ≤1.5 MB were stored as-is with no user feedback. | Users assumed the "optimization" ran. | `imageOptimize` returns an explicit note: "…stored as-is — they may not display on every device." |
| 9 | **`verify-orders-maps` Z4 asserted a bare `gps_lat === null`** while its own cleanup restores the pre-suite pin. | Every live branch legitimately carries a pin → spurious failure on a healthy database. | Z4 now asserts "matches the pre-suite state" + counts unchanged. |

## 2. (a) Security and actual image validation

**Validation (server-side, non-bypassable):**

- Every upload path validates the **stored** value: 14 routes + `/api/init` call
  `validateImageDataUrl` / `validateOptionalImage` / `validateImageArray(purpose, {max, label, allowNulls})`
  (`src/lib/mediaValidation.ts`). Declared MIME must be `image/*`, base64 must be strict, payload must be
  non-empty, and decoded bytes must sit inside the per-purpose budget (`IMAGE_BYTE_BUDGETS`).
- Per-record photo caps: 6 products / 6 assets / 3 receipts (1 logo, 1 avatar, 1 employee photo).
- HEIC is refused; un-decodable formats above 3.2 MB are refused; pass-through (SVG/GIF) is bounded at 1.5 MB.
- Verified by suite: an oversized receipt → 400, a 4th receipt → 400, `data:text/plain` → 400, a 7th
  product photo → 400, an oversized product photo → 400, and **no refused payload reached the database**.
- The three "unguarded" write sites from the earlier investigation turned out to be **read** projections
  (`menu/route.ts` ships `/api/menu/photo?…` URLs, not bytes; `staff-access` ships `photoUrl`), so no
  unvalidated write path exists.

**Serving:**

- `/api/menu/photo` (full + `?size=thumb`) and `/api/branding` now return:
  `Content-Security-Policy: default-src 'none'; sandbox; img-src 'none'`, `X-Content-Type-Options: nosniff`,
  and `Content-Disposition: attachment` for SVG. Measured live:

  ```
  /api/menu/photo?item=1&index=0        → CSP: default-src 'none'; sandbox; img-src 'none' · nosniff · attachment; filename="…svg"
  /api/menu/photo?item=1&index=0&size=thumb → same
  /api/branding?businessId=1            → same (all branches)
  ```

- Stored blobs are never parsed as HTML: **no `dangerouslySetInnerHTML` anywhere in the app**, and image
  strings are only ever assigned to `<img src>` / CSS backgrounds. Verified by repo-wide grep.
- `<img src>` rendering is unaffected by the lockdown CSP (a CSP on an image response does not constrain the
  document that embeds it) — confirmed by the storefront/order/boutique suites.

## 3. (b) WebP/JPEG compatibility across all consumers

Every consumer of every image class was traced:

| Consumer | Format handled | Evidence |
| --- | --- | --- |
| `<img>` tiles, grids, lightbox, avatars, logos, evidence previews | WebP, JPEG, PNG (all current browsers) | `verify-photo-formats` 11/11 · storefront/order/boutique suites green |
| Storefront product images | WebP + JPEG fallback via `/api/menu/photo`, thumb + full | `verify-storefront-areas` 53/53, `verify-order-page-regression` 34/34 |
| PNG (alpha) — logos, avatars | WebP never used for logos; `keepAlpha` → PNG | `verify-logos` 35/35, `verify-image-optimization` transparency checks |
| PDF export (jspdf 4.2.1) | Bundles `processWEBP` + `SMask` → WebP decodes; logos are rasterized PNG anyway | code-level check (previous audit) |
| Excel / backup archives | Base64 data-URL strings are carried verbatim, no decoding | `verify-business-backup` 54/54 |

No consumer requires a format the pipeline can emit (HEIC is refused at upload, so it can never be stored).

## 4. (c) Backup / export → restore

- `businessBackup.ts` carries `assets.asset_images_thumb` alongside `asset_images` (positional, null-safe),
  plus every other image column unchanged.
- `verify-business-backup`: **54/54** checks — archive completeness, tenant isolation, "no password hashes,
  session tokens or credentials", and restore fidelity including the thumbnail array.
- Restore is byte-preserving by construction: the optimization pipeline only runs on *new uploads*; the
  backup path never re-encodes.

## 5. (d) Existing legacy images

Measured against the live database:

| Column | Worst case found | Treatment |
| --- | --- | --- |
| `company_settings.company_logo` | 52,591 chars (≈39 KB legacy PNG) | served as-is; rasterized only on new uploads |
| `inventory_items.photo` | 554 chars (≈0.4 KB) | **kept as the list fallback** when a row has no thumbnail (dropping it would blank the tile) |
| `transactions.receipt_image` | 0 rows | n/a (was shipped on lists regardless → now `receiptCount`) |
| `assets.asset_images` | 0 rows | thumbnails created on next upload; reader falls back to the first image |

Legacy behaviour verified:

- Legacy rows without thumbnails keep working everywhere (`/api/init`, storefront, QR record modal) via the
  documented `thumb || photo` fallback.
- Legacy blobs are **never re-validated when unchanged** (#4), so old records stay editable.
- The suite asserts every pre-existing image row is byte-identical before/after (`D. existing images
  untouched` + a content-hash fingerprint over every image column).
- Legacy SVGs are still rendered (they are tiny, and `<img>` renders SVG fine) but can no longer act as a
  scriptable document when opened directly (#2).

## 6. (e) No API or page loads unnecessarily large image data

Policy (`src/lib/imagePayload.ts`), applied per consumer:

| Endpoint / page | Screen paints | Ships |
| --- | --- | --- |
| `/api/init` (bootstrap) | thumb-sized tiles, employee avatars | one image per asset (`thumb \|\| first`), `assetImageCount`; receipts → `receiptCount` |
| `/api/menu` (storefront) | product grid → lightbox | **URL references only**; bytes come from `/api/menu/photo` (`?size=thumb` for tiles) |
| `/api/enterprise` inventory | product tiles/QR modal | one ≤400 px thumbnail (`photoThumb`) + counts; arrays dropped |
| `/api/transactions` ×3 | ledger lists | `receiptCount`, no bytes |
| `/api/transport` | fleet/trips/fuel/checklists/ledger | `hasPhoto` flags; ledger `receiptCount`; stock `photoCount` — **zero bytes** |
| `/api/block-factory` | production/QC/mix tables | QC `hasPhoto`; stock `photoCount` — **zero bytes** |
| `/api/poultry/feed-mill`, `/api/aquaculture/feed-mill` | mill tables | QC + stock indicators only — **zero bytes** |
| `/api/assets`, `/api/logs/[businessCode]`, boutique/budgets/cashflow/tracking | text or explicit columns | no image columns selected |

Measured live after the fix (owner session): `transactions` 12 KB · `transport` 19.7 KB (biz 17) · `block-factory`
42 KB (biz 1) · `poultry/feed-mill` 3.3 KB · `aquaculture/feed-mill` 0.2 KB — and the new suite section asserts
`data:image` never appears in any of the five payloads while `photoCount`/`hasPhoto` stay truthful (14 stock rows
checked; a row known to have images reports `hasPhoto=true`).

## 7. (f) Thumbnail fields & optimized images restore correctly

- `assets.asset_images_thumb` (jsonb, positional): written by the registration wizard, read by
  `/api/init`, carried by backup/restore, and null-safe for legacy rows — 54/54 backup checks.
- Inventory `photos_thumb` stays parallel to `photos` (asserted, 1:1) and is dropped from list payloads in
  favour of a single `photo` + `photoCount`.
- Optimization results survive the round trip: product 279 KB (+ 23 KB thumb) from a 12 MP source; document
  593 KB; receipt 352 KB (WebP) — all inside the stored byte budgets, all re-measured in the suite.

## 8. (g) Regression evidence

Environment: production build of `a47df44`, Postgres live, headless Chromium. `npx tsc --noEmit` clean;
`npm run build` clean.

| Suite | Result |
| --- | --- |
| verify-image-optimization | **110/110** (90 original + 20 new wire-budget checks) |
| verify-photo-formats | 11/11 |
| verify-logos | 35/35 |
| verify-employees | 46/46 |
| verify-documents | 40/40 |
| verify-business-backup | 54/54 |
| verify-audit-records | 29/29 |
| verify-block-qc | 51/51 |
| verify-feed-mill | 100/100 |
| verify-fish-feed-mill | 85/85 |
| verify-transport | 119 pass · 0 fail (1 creation check legitimately skipped — the fixture business already exists) |
| verify-transport-ui | 26/26, 0 console errors |
| verify-block-mixing | 75/75 |
| verify-expense-ui | 39/39 |
| verify-p4-writers | 23/23 |
| verify-p5-stock | 19/19 |
| verify-single-writer | 35/35 |
| verify-clean-state | 121/121 |
| verify-orders-maps | 51/51 (after the Z4 harness fix) |
| verify-tracking | 51/51 |
| verify-online-ordering | 34/34 |
| verify-order-page-regression | 34/34 |
| verify-credit-sales | 39/39 |
| verify-storefront-areas | 53/53 |
| verify-nav | 69/69 |
| verify-shared-ui | 30/30 |
| verify-boutique | 74/74 |
| verify-inventory-permissions | 37/37 (E-loop count tracks the number of businesses — expected variance) |

Sweep log: `dev-tooling/sweep-image-impl.sh` → `/tmp/img-sweep.txt` (24/25 in-sweep; the one red was the
orders-maps flake fixed in #9 and re-run solo to 51/51).

**Database:** no schema change, no migration, no data rewrite in this audit. Existing image rows are
byte-identical (hash fingerprint). Row counts unchanged.
**Performance:** list payloads strictly smaller; storefront images still served with ETag +
`max-age=3600, stale-while-revalidate=86400`; no new queries.
**Compatibility:** no API field consumed by the UI was removed — only unused image columns were replaced by
`photoCount`/`hasPhoto`/`receiptCount`, and the indicators they feed were verified in the UI suites.

## 9. Known issues / accepted, documented risks

1. **Legacy fallback keeps its original bytes.** A row with a photo but no thumbnail still ships that photo on
   the storefront/list fallback (current worst case 554 chars). Deliberate: dropping it would blank the tile.
2. **SVG pass-through** stores SVG verbatim (≤1.5 MB) with a user-facing note; it renders in `<img>` and is
   served as an attachment under a lockdown CSP. Converting it would lose the vector's quality.
3. **Phase-2 media table** (files outside Postgres) remains deferred — approved decision; the wire-shaping layer
   is the mitigation.
4. **Harness variance, not failures:** `verify-transport` runs one fewer check when the fixture transport
   business already exists; `verify-inventory-permissions` has one check per business in the org. Both suites
   report 0 failures.
