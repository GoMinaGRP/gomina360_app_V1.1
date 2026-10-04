# Image Upload & Optimization — Implementation Report

**Scope:** the approved strategy in [`IMAGE-UPLOAD-AUDIT.md`](./IMAGE-UPLOAD-AUDIT.md) (commit `bce3280`).
**Status:** implemented, tested, committed and pushed as **`29cf5c2`** (follow-ups in this commit).
**Architecture:** unchanged — base64 data URLs in Postgres. **The Phase-2 `media_assets` table is deferred**
(not needed: the enforcement + slimming below remove the pressure that would justify it).

---

## 1. What changed

### 1.1 Limits — three layers, enforced on both sides

| Layer | Rule | Where |
| --- | --- | --- |
| Source file | 20 MB memory guard (as before) **plus** a hard rule for what cannot be re-encoded: SVG/animated GIF ≤ 1.5 MB, other un-decodable formats ≤ 3.2 MB | `imageOptimize.ts` (`MAX_SOURCE_IMAGE_BYTES`, `MAX_PASS_THROUGH_BYTES`, `MAX_UNDECODABLE_BYTES`) + `prepareImages()` |
| Stored bytes per purpose | product 500 KB · asset 400 KB · receipt 700 KB · evidence 300 KB · avatar 300 KB · employee 120 KB · logo 700 KB · document 2 MB · thumbnails 60 KB | `IMAGE_BYTE_BUDGETS` (client) **and** `mediaValidation.ts` (server) — one source of truth |
| Per-record count | product 6 · asset 6 · receipt 3 · evidence 1 · avatar/employee/logo/document 1 | `PHOTO_LIMITS` (client) + `validateImageArray()` (server) |

Two ceilings came from measurement, not guesswork: **avatars keep alpha → PNG** (89 KB for a
worst-case 320px photo), and **logos keep alpha → PNG at 512px** (165 KB), which is why their budgets
are 300 KB / 700 KB rather than the 80 KB / 150 KB first sketched — the alternative (WebP for alpha)
would put a format jsPDF cannot reliably embed into every invoice.

### 1.2 Resizing, compression, formats

| Purpose | Before | Now | Why |
| --- | --- | --- | --- |
| **receipt** | 1800px q0.82 JPEG | **2400px q0.85 WebP** (JPEG fallback) | 154 → **205 DPI** on A4 and *smaller*: measured 275 KB / 44.3 dB vs 375 KB / 42.0 dB for the old 2000px JPEG — resolution, not JPEG quality, is what makes small print legible |
| **document** (vault, HR) | 2000px q0.88 JPEG | **2800px q0.85 WebP** (JPEG fallback) | 171 → **240 DPI**, ~335 KB — "print it for the accountant" quality, far under the 2.5 MB vault rule |
| **evidence** | 1400px q0.78 JPEG | 1400px q0.78 **WebP** | QC/audit proof is never embedded in a PDF — WebP is 30–40 % smaller |
| product / asset / avatar / employeePhoto / logo | — | unchanged sizes, **asset now also generates a 400px thumbnail** | proven presets; assets gained the thumbnail their grids need |
| thumbnails | WebP (products) | WebP (products **+ assets**) | ~20 KB per tile instead of ~260 KB |
| **logos** | SVG/GIF stored untouched | **rasterised at ≤512px** (alpha → PNG) | jsPDF cannot embed SVG: an SVG crest uploaded fine and then vanished from every invoice |
| HEIC | passed through at any size | **refused when this browser cannot decode it**, with a camera-setting hint | a file the uploader's own browser cannot display must not be stored |

Everything else is unchanged: never upscale, never store a larger file than the user picked, keep
already-small sources byte-identical, EXIF rotation applied, EXIF/GPS metadata dropped on re-encode.

### 1.3 Server-side validation (the security fix)

`src/lib/mediaValidation.ts` is now the single gate:

* **shape** — must be `data:image/<subtype>;base64,…` (PDFs additionally allowed for HR/vault documents);
* **size** — decoded bytes against the purpose budget, with a plain-English refusal;
* **count** — list caps, identical to the client's;
* **tolerance** — the MIME subtype is deliberately *not* allow-listed; the app's documented promise is
  "any image format" (SVG, GIF, HEIC, BMP, AVIF…), and shape + size are what actually protect the database.

Wired into **every** image write path — 14 routes, asserted by the test suite:

`enterprise` (inventory photos + thumbnails, asset images + thumbnails) · `transactions` (receipts) ·
`audit` (evidence + correction photos) · `audit/issues` · `advisor-notes` · `block-factory` ·
`transport` (checklist photo) · `poultry/feed-mill` · `aquaculture/feed-mill` · `employees`
(photo + HR documents) · `profile` · `logos` · `users` · `assets` (PATCH).

Two behaviour fixes fell out of this: `advisor-notes` used to **silently truncate** a photo at 1.5 M
characters (storing an unreadable data URL); oversized images now return a reason instead.

### 1.4 Storage & page performance

* **`/api/init` slimming** — receipt photos no longer ship in the bootstrap (counts only: no bootstrap
  screen paints them, and the audit/approval endpoints read the full images server-side), and each
  asset ships **one thumbnail-sized image** plus `assetImageCount`. Measured on the demo workspace:
  **ledger + assets bootstrap = 27 KB**, and a workspace with 300 photographed receipts no longer
  pays ~80–100 MB of base64 per login.
* **`assets.asset_images_thumb`** (new `jsonb`, positional like the inventory thumbnails, with
  read-fallback for legacy rows) — created by `drizzle-kit push`; business export/restore carries it.

### 1.5 User experience

* **One picker policy everywhere** via `prepareImages(files, purpose, {max, existing})`: source guard,
  per-file refusal reasons (`describeRejection`), hints for pass-through formats, and the record cap.
  Used by inventory, assets, expense receipts and the approval-inbox disburse flow.
* Single-file sites (audit evidence, block QC, employee photo/HR doc, vault, logos, avatar) surface the
  reason through their existing error slots; **QC and asset pickers gained camera capture**
  (`capture="environment"`) for phone-first use, matching inventory and receipts.
* Uploads still report "Optimized for the storefront — 4.1 MB → 280 KB (15× smaller)".

---

## 2. Test results

| Suite | Result |
| --- | --- |
| `verify-image-optimization` (extended **62 → 90 checks**) | **90 / 90** ✅ |
| `verify-photo-formats` | 11 / 11 ✅ |
| `verify-logos` | 35 / 35 ✅ |
| `verify-employees` | 46 / 46 ✅ |
| `verify-documents` | 40 / 40 ✅ |
| `verify-business-backup` | 54 / 54 ✅ |
| `verify-audit-records` | 29 / 29 ✅ |
| `verify-block-qc` | 51 / 51 ✅ |
| `verify-feed-mill` | 100 / 100 ✅ |
| `verify-fish-feed-mill` | 85 / 85 ✅ |
| `verify-transport` / `verify-transport-ui` | 120 / 0 and 26 / 0 ✅ |
| `verify-expense-ui` | 39 / 39 ✅ |
| `verify-p4-writers` / `verify-p5-stock` / `verify-single-writer` | 23, 19, 35 — all green ✅ |
| `verify-clean-state` | 121 / 121 ✅ |
| `verify-orders-maps` | 51 / 51 ✅ |
| `verify-tracking` / `verify-online-ordering` / `verify-credit-sales` | 51 / 34 / 39 — all green ✅ |
| `verify-storefront-areas` / `verify-nav` / `verify-shared-ui` | 53 / 69 / 30 — all green ✅ |
| `verify-boutique` / `verify-inventory-permissions` | 74 / 38 — all green ✅ |

Full sweep driver: `dev-tooling/sweep-image-impl.sh` (25 suites, log `/tmp/img-sweep.txt`).
Everything re-ran green after the final production rebuild.

**Two sweep flakes found and fixed (test-side, no app impact):**

1. `verify-orders-maps` aborted in Z4 because a *previous* suite had left a GPS pin on business #1 that
   Z4 asserts is cleared. The suite now clears the anchor at baseline and restores whatever it found —
   it is self-healing in a sweep and still exact when run alone (`f0696f3`).
2. `verify-expense-ui` could not find its unit in the rail (the 5-unit preview from the navigation
   work) and timed out before any expense check ran. It now expands the list like a user via
   `dev-tooling/rail-util.mjs` — 39/39 after the fix (same class of fix as the navigation sweep).

### New coverage (what the 28 extra checks prove)

**Static (A-section):** presets are exactly 2400/2800 & q0.85; the four ceilings exist with the right
values; `IMAGE_BYTE_BUDGETS` + `PHOTO_LIMITS` exported; caps 6/6/3; receipts prefer WebP while
**logos never do**; logos rasterise vectors; the shared validator enforces the same budgets as the
client; **all 14 image write routes import it**; the asset thumbnail column, its writer, its positional
client array and its presence in backup/restore.

**Runtime (new C/D sections) — every payload the UI would never send:**

| Probe | Result |
| --- | --- |
| 900 KB receipt (> 700 KB budget) | **400** "…limit after optimisation is 700 KB" |
| 4 receipts (cap 3) | **400** "A record can hold at most 3 images — 4 were sent." |
| `data:text/plain;base64,…` in a receipt field | **400** |
| 7 product photos (cap 6) | **400** |
| 600 KB product photo (> 500 KB budget) | **400** |
| none of the above rows reached the database | ✅ 0 txns, 0 items |
| `/api/init` ledger: no receipt images, `receiptCount` present | ✅ 49 rows, 0 with images |
| `/api/init` assets: ≤ 1 image per row | ✅ |
| ledger + assets bootstrap size | ✅ 27 KB |
| existing images byte-identical after the whole suite | ✅ (pre-existing check, still green) |

### Live end-to-end smoke (shipped build, owner session)

| Signal | Result |
| --- | --- |
| `/api/init` raw payload | 34.4 KB · ledger 27 KB · assets 3 KB |
| ledger rows with receipt images in the bootstrap | **0 / 55** (all 55 carry `receiptCount`) |
| assets with more than one image in the bootstrap | **0 / 6** |
| asset modal pickers | gallery (`asset-photo-file`, `accept="image/*"`) + camera (`asset-photo-camera`, `capture="environment"`) |
| page errors during the whole flow | **0** |

Screenshot: `/home/user/img-smoke-assets.png` (asset register on the shipped build).

### Manual/visual verification

Benchmark crops from the audit remain the visual evidence of the resolution change:
`/home/user/audit-crop-receipt.png` (old policy) vs `/home/user/audit-crop-doc2400webp.png`
(new WebP at 2400px) — visibly crisper digits at 27 % fewer bytes.
`dev-tooling/image-audit-bench.mjs` re-runs the comparison at any time (read-only).

---

## 3. Deliberate deviations from the audit sketch

1. **No receipts thumbnail column.** The audit suggested a 400px receipt strip; investigation showed
   *no bootstrap screen paints receipt images at all*, so the slimmer and simpler fix is to ship
   `receiptCount` only. A thumbnail would have added a column, a writer and a reader for no visible gain.
2. **Budget numbers raised where the encoder requires it** — avatar 300 KB and logo 700 KB instead of
   80 KB / 150 KB (alpha PNG sizes, measured). Every other value is as proposed.
3. **Phase-2 `media_assets` table deferred** — as recommended; with budgets, caps and bootstrap
   slimming in place, current storage behaviour is linear and small (~50–500 KB per record).
4. **Logos keep PNG for alpha rather than WebP** — jsPDF embeds PNG alpha reliably; a transparent
   WebP logo is not a guaranteed PDF path, and a crest is exactly the image that must never break.

## 4. Remaining items (non-blocking)

* **PDF/Excel exports of WebP receipts** — not applicable today: no export embeds receipts/documents
  (the only embedded images are the logo and the QR PNG). If a future document template embeds a
  receipt, it must re-encode to JPEG first — noted here so it is not discovered the hard way.
* **`business_documents` vault MIME list** still excludes BMP/AVIF/SVG (pre-existing rule, unchanged);
  vault images are now WebP at 2800px, which the list already allows.
* **Employee HR documents**: PDFs keep the 2.5 MB rule; images use the shared 2 MB document budget.
* **Legacy rows** (photos stored before these budgets) are untouched — readers keep falling back to the
  full image where no thumbnail exists.

## 5. Final verification audit (2026-10-04)

The implementation above was re-audited end-to-end against the live stack — security/validation,
WebP+JPEG compatibility across every consumer, backup→restore, legacy rows, remaining oversized
image loads, thumbnail restore fidelity and regressions. Nine issues were found and fixed in
`a47df44` (unused thumbnails on four list endpoints, an ineffective serving-lockdown CSP that the
app-wide CSP was overwriting, unhardened `/api/branding` 200 responses, legacy-edit bricking on
employees/assets, whitespace/empty base64 acceptance, receipts on list payloads, evidence photos on
screens that never paint them, silent pass-through, and one inconsistent test assertion).

Full results, measurements and the per-suite evidence table: **`docs/IMAGE-UPLOAD-FINAL-AUDIT.md`**.
Verdict: sound — `tsc` clean, production build clean, 28 suites green, existing image rows
byte-identical, no schema or data changes.
