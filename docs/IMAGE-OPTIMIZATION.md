# Automatic image optimization — audit, design, verification

_Last verified: 2026-10-02 · branch `arena/01a0fecd-gomina360-app-v1-1`_

Scope: **every image that enters GoMina 360** — inventory/product photos, asset
photos, expense & QC receipts/evidence, audit evidence, HR & vault documents,
employee photos, profile avatars and business/branch/company logos — plus the
storefront that serves them.

Goal: a capture that leaves the phone is optimized **in the browser, before
upload**, so upload speed, storage and every later payload improve — while
existing images, readability and functionality stay exactly as they were.

## 1. Why browser-side

The app stores images as data URLs inside its own Postgres columns. There is no
image service and none is being added, so the only place with the original
pixels *and* no extra round trip is the browser that already holds the file.
`src/lib/imageOptimize.ts` is that one pipeline — every upload surface imports
it, so a policy change lands everywhere at once.

## 2. One pipeline, per-purpose presets

`IMAGE_PRESETS[purpose]` describes how an image will actually be used. A 12 MP
capture is never rendered above its preset's longest edge anywhere in the app,
so shipping the full capture only wastes bytes on every screen, payload and
repository read that touches it.

| Preset | Longest edge | Quality | Thumbnail | Keep original under | Alpha | Used by |
| --- | --- | --- | --- | --- | --- | --- |
| `product` | 1600 | 0.82 | 400 / 0.75 | 180 KB | flatten | Inventory registration + edit, boutique stock-in |
| `asset` | 1600 | 0.80 | — | 160 KB | flatten | Asset registration & audit |
| `receipt` | 1800 | 0.82 | — | 180 KB | flatten | Expense receipts, disbursement receipts |
| `evidence` | 1400 | 0.78 | — | 120 KB | flatten | Block-QC evidence, audit issue/response evidence |
| `avatar` | 320 | 0.80 | — | 40 KB | **preserve** | Profile photo (square centre-crop) |
| `employeePhoto` | 480 | 0.82 | — | 70 KB | flatten | Employee photo / camera capture |
| `logo` | 512 | 0.88 | — | 60 KB | **preserve** | Business, branch & company logos |
| `document` | 2000 | 0.88 | — | 400 KB | flatten | Vault documents, HR documents (scans keep text detail) |

Public API: `optimizeImage(file, purpose)`, `optimizeImages(files, purpose)`
(bounded concurrency), `optimizeCanvas(...)`, `optimizedDataUrl(file, purpose)`
(returns just the data URL) and `optimizationSummary(before, after)` for the
"Optimized — 16.2 MB → 96 KB (174× smaller)" notices the user sees.

## 3. Format policy

| Input | Stored as | Why |
| --- | --- | --- |
| Photograph (no transparency) | **JPEG** | Universally supported, and the PDF/Excel exporters in this app can embed it — WebP would break those documents. |
| Thumbnail | **WebP** when the browser can encode it, JPEG otherwise | 25–35 % smaller, only ever used inside `<img>`, and never a hard dependency. |
| Logo/avatar with real transparency | **WebP**, else **PNG** | The old logo path always re-encoded to JPEG, which flattened transparent logos onto **black** — broken on the dark sidebar and in document headers. Transparency is now preserved. |
| SVG (vector), animated GIF | **untouched** | Rasterizing them would destroy the very property that makes them good. |
| PDF and other non-image uploads | **untouched** | Vault/HR PDFs still stream through the original `FileReader` path; the server's format + size validator is unchanged. |

## 4. Safety rails

* **Never upscale, never inflate** — a source already within its preset's edge
  and byte budget is kept as the user's exact bytes (no generation loss).
* **Fallback = original.** If the browser cannot decode the file (HEIC outside
  Safari, BMP, …) or any encode step throws, the untouched data URL is stored —
  exactly the previous behaviour. The MIME gate only bails on a *known*
  non-image type, so Android captures that arrive with an empty MIME are still
  optimized.
* **EXIF orientation** is applied while decoding (`imageOrientation: "from-image"`),
  so portrait captures are never stored sideways.
* **Legacy rows stay valid** — thumbnails are always `NULL`-able; every reader
  falls back to the full image (`photoThumb || photo`, `/api/menu/photo`).
* **Canonical fields are preserved** — `photo`, `photos`, `assetImages`,
  `evidencePhoto`, `fileData` keep the same shape and stay the authoritative
  images; nothing downstream is asked to change.
* **Existing businesses/data are untouched** — the suite proves every
  pre-existing image row is byte-identical after a full run.

## 5. Display thumbnails

Product photos additionally get a ≤400 px display copy at upload time, stored in
parallel columns (`inventory_items.photo_thumb`, `photos_thumb`, shipped by
`dev-tooling/migrate-production-schema.mjs`):

* `/api/init` ships `photoThumb || photo` and still excludes the heavy photo
  arrays from the bootstrap payload;
* `/api/menu` publishes `thumbs[]` index-aligned with `photos[]`;
* `/api/menu/photo?…&size=thumb` serves the aligned thumbnail with the full
  image as fallback (same ETag/302/404 semantics);
* the storefront grid + gallery strip paint thumbnails lazily; the lightbox,
  product-details view and zoom still open the full-resolution photo — the
  measured detail image is ~96 KB against the 1 KB grid thumbnail;
* the Business Export & Restore archive carries the thumbnail columns, so a
  restored unit keeps serving light images.

## 6. Measured results (real Chromium, real uploads)

| Surface | Before | After |
| --- | --- | --- |
| 3000×2000 product capture | 16.2 MB | **96 KB** (1600×1067, JPEG) — 174× smaller |
| Grid thumbnail | — | 400×267 WebP, **1 KB** |
| Storefront JSON body for that upload | 16.2 MB | **259 KB** |
| Expense receipt | 6 MB+ capture | **161 KB** (1800×1200 — small print readable) |
| Asset photo | — | **82 KB** |
| Employee photo | — | **3 KB** (480 px) |
| Profile avatar | — | **2 KB**, 320×320 centre-crop |
| Transparent logo | 1.4 MB PNG | **~10 KB WebP**, transparency intact |
| Vault/HR document scan | — | ≤400 KB at 2000 px, text detail preserved |

## 7. Verification

`dev-tooling/verify-image-optimization.mjs` — **55 checks**, real Chromium +
real handlers + real Postgres:

* **A · static** — every `<input type="file">` that accepts images is wired to
  the shared optimizer; the only raw `readAsDataURL` calls left are the
  deliberate PDF pass-throughs; the preset table keeps its documented ordering.
* **B · desktop (1440×900)** — multi-MB inventory upload (pipeline, cap,
  thumbnail, request-body size, submission), storefront grid/lightbox/details
  byte behaviour, `/api/init` payload, legacy row without thumbnails, profile
  avatar, business logo (transparency), expense receipt, asset image, employee
  photo.
* **C · mobile (390×844, DPR 3)** — the same upload pipeline and storefront
  rendering in a fresh browser context.
* **D · no-regression** — every pre-existing image row byte-identical
  before/after; mutated avatar and logo restored; all test rows purged.

Acceptance gates re-run green after the changes:

| Suite | Result |
| --- | --- |
| `verify-image-optimization` | 55/55 |
| `verify-photo-formats` (every uploader still accepts GIF/BMP/SVG/AVIF/WebP) | 11/11 |
| `verify-logos` | 35/35 |
| `verify-documents` | 40/40 |
| `verify-employees` | 46/46 |
| `verify-expense-ui` / `verify-inventory-ui` | 39/0 · 12/0 |
| `verify-block-qc` | 51/0 |
| `verify-audit-fixes` / `verify-audit-records` / `verify-live` | 51/0 · 29/0 · 27/27 |
| `verify-business-backup` (thumbnails travel) | 54/54 |
| `verify-boutique` / `verify-boutique-ui` | 74/74 · 40/40 |
| `verify-storefront-areas` / `verify-order-inventory-fixes` / `verify-orders-maps` / `verify-permissions-storefront` | 53/53 · 55/55 · 51/51 · 48/48 |
| `verify-responsive` / `verify-audit-responsive` | clean · 38/38 |
| `verify-categories` · `verify-manage-unit` · `verify-online-mgmt` | 30/30 · 24/0 · 81/81 |

Run everything with:

```bash
bash dev-tooling/run-suite.sh dev-tooling/verify-image-optimization.mjs
```

## 8. Coverage map (upload surfaces)

| Surface | Preset | Thumbnails |
| --- | --- | --- |
| Inventory add/edit (`SharedEnterpriseModule`), boutique stock-in | `product` | yes |
| Asset registration & audit (`AssetRegistrationModal`) | `asset` | no (list images are already ≤1600 px) |
| Expense receipts (`ExpenseEntryForm`), disbursement receipts (`ApprovalInbox`) | `receipt` | no |
| Block-QC evidence (`BlockQcCenter`) | `evidence` | no |
| Audit issue / response evidence (`AuditCommandCenter`, `MyAuditIssues`) | `evidence` | no |
| Vault documents (`DocumentVaultPanel`) | `document` | no |
| HR documents, employee photo & camera capture (`EmployeeCenter`) | `document` / `employeePhoto` | no |
| Profile avatar (`ProfilePhotoModal`) | `avatar` | no (square crop) |
| Business / branch / company logos (`ManageBusinessesModal`) | `logo` | no (transparency kept) |

## 9. Notes / limits

* Documents and PDFs deliberately keep their detail (2000 px / q 0.88 for
  images, PDF bytes untouched); only the *input* guard changed — an image up to
  20 MB is accepted and compressed, instead of being rejected at 2.5 MB.
* Nothing re-writes images that already exist; optimization happens on the way
  in. A backfill for legacy rows is possible later but was not required and is
  not part of this change.
* Optimization is best-effort by design: any failure path stores the original
  upload, so no upload can ever be blocked by the optimizer.
