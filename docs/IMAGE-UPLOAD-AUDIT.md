# Image Upload Audit — GoMina 360

**Date:** 2026-10-03 · **Status:** findings + recommended strategy, **for approval (not implemented)**
**Method:** source review of every upload path, DB schema of every image column, route-level guard
inventory, and a browser benchmark that reproduces the shipped encoder exactly and measures bytes,
DPI and PSNR per preset (`dev-tooling/image-audit-bench.mjs`, read-only).

---

## 1. How images work today (one paragraph)

Every image in GoMina 360 is a **base64 data URL stored in Postgres** and shipped inside JSON.
Uploads are optimized **client-side before they leave the device** by one shared pipeline
(`src/lib/imageOptimize.ts`): decode (`createImageBitmap`, EXIF rotation applied) → downscale
(canvas, `imageSmoothingQuality: "high"`) → encode (JPEG, or WebP/PNG when real transparency) →
optionally a display thumbnail (products). 16 of the 16 image inputs in the app use it; the 17th
file input is the business-backup `.zip`. Logos and menu photos have dedicated *serving* endpoints
with ETag + `Cache-Control` (`/api/branding` 7-day private, `/api/menu/photo` 1-hour public + a
`size=thumb` variant); everything else is inlined as base64 in API payloads.

**That architecture is coherent and, with the fixes below, the right one to keep** — it makes
backup/restore, tenant isolation, exports and the desktop/mobile clients work with no object-store,
no CDN and no extra service.

---

## 2. Inventory — every upload surface

| # | Surface | Component | Preset | Multi | Source guard at pick | Stored in | Thumb | Server-side guard |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **Inventory / Products** (storefront photos) | `SharedEnterpriseModule` | `product` | ✅ | 20 MB | `inventory_items.photo / photos / photo_thumb / photos_thumb` | ✅ 400 px WebP | ❌ none |
| 2 | **Assets** (registration photos) | `AssetRegistrationModal` | `asset` | ✅ | 20 MB | `assets.asset_images[]` | ❌ | ❌ none |
| 3 | **Expense receipts** | `ExpenseEntryForm` (+ camera) | `receipt` | ✅ | 20 MB | `transactions.receipt_image(s)` | ❌ | ❌ none |
| 4 | **Approval-inbox receipts** | `ApprovalInbox` | `receipt` | ✅ | 20 MB (silently drops) | approvals → `transactions` | ❌ | ❌ none |
| 5 | **Audit evidence** (centre) | `AuditCommandCenter` | `evidence` | ❌ | ❌ none | `audit_reviews.evidence_photo` | ❌ | ❌ none |
| 6 | **Audit issue evidence** | `MyAuditIssues` | `evidence` | ❌ | ❌ none | `audit_issue_updates.photo` | ❌ | ❌ none |
| 7 | **Block-factory QC photo** | `BlockQcCenter` | `evidence` | ❌ | ❌ none | `block_qc_checks.photo` | ❌ | ❌ none |
| 8 | **Employee photo** | `EmployeeCenter` (+ camera) | `employeePhoto` | ❌ | ❌ none | `employees.photo` | ❌ | ✅ 1.8 M chars |
| 9 | **Employee documents** (ID, permit) | `EmployeeCenter` | `document` (images) / raw PDF | ❌ | PDF ≤ 2.5 MB | `employee_documents.file_data` | ❌ | ✅ 3.5 M chars |
| 10 | **Profile photo** | `ProfilePhotoModal` (+ camera, crop) | `avatar` | ❌ | ❌ none | `users.avatar_url` | ❌ | ✅ 700 K chars |
| 11 | **Company / Business / Branch logos** | `ManageBusinessesModal` (3 inputs) | `logo` | ❌ | ❌ none | `company_settings.company_logo`, `businesses.logo / branch_logos` | ❌ | ✅ 1.8 M chars |
| 12 | **Document vault** | `DocumentVaultPanel` | `document` (+ PDF) | ❌ | 20 MB img / 2.5 MB pdf | `business_documents.file_data` | ❌ | ✅ 2.5 MB + MIME allow-list |
| 13 | Business backup `.zip` | `NewBusinessModal` | — | ❌ | — | restore path | — | ✅ |

**Columns reachable only through the API (no UI picker)** — transport vehicle photos, fuel-log
receipts, advisor-note photos, poultry/fish feed-QC photos, audit response photos: these are written
straight from JSON bodies and **never touch the optimizer at all**.

### What the pipeline actually produces (12 MP phone photo, 4032×3024, source JPEG 4.3 MB)

| Preset | Stored | Thumbnail | Notes |
| --- | --- | --- | --- |
| `product` | 1600×1200 JPEG **279 KB** | 400×300 WebP **23 KB** | best-covered path |
| `asset` | 1600×1200 JPEG 258 KB | — | lists paint the full 258 KB |
| `receipt` | 1800×1350 JPEG 352 KB | — | **154 DPI** on A4 — low for OCR/print |
| `evidence` | 1400×1050 JPEG 195 KB | — | |
| `avatar` | 320×240 JPEG 24 KB | — | |
| `employeePhoto` | 480×360 JPEG 45 KB | — | |
| `logo` | 512×384 JPEG 61 KB | — | alpha preserved for transparent logos |
| `document` | 2000×1500 JPEG 593 KB | — | **171 DPI** on A4 |

### Document/receipt legibility experiment (3024×4032 synthetic text scan, 1.7 MB PNG)

| Variant | Stored | A4 DPI | PSNR vs ideal render | Crop |
| --- | --- | --- | --- | --- |
| current `document` (2000 px, JPEG q0.88) | 375 KB | 171 | 42.0 dB | `audit-crop-document.png` |
| 2000 px JPEG q0.92 | 424 KB | 171 | 44.4 dB | — |
| 2400 px JPEG q0.88 | 493 KB | 205 | 42.5 dB | — |
| **2400 px WebP q0.85** | **275 KB** | **205** | **44.3 dB** | `audit-crop-doc2400webp.png` |
| 2800 px WebP q0.85 | 334 KB | 240 | 44.5 dB | — |
| current `receipt` (1800 px, JPEG q0.82) | 277 KB | 154 | — | `audit-crop-receipt.png` |
| receipt @ q0.92 | 341 KB | 154 | — | `audit-crop-receiptQ92.png` |

**Conclusion:** resolution, not JPEG quality, is what makes scans readable — and **WebP buys both**:
at 2400 px the WebP is 27 % *smaller* than today's 2000 px JPEG while scoring 2.3 dB better and
lifting A4 resolution from 171 → 205 DPI. Crops confirm visibly crisper digits.

---

## 3. Findings

### Strengths (keep)

1. **One pipeline, per-purpose presets** — no component reads files itself any more
   (`verify-image-optimization` asserts 16/16 wired, 0 raw `FileReader` on images).
2. **Correct safety rails:** never upscale, never store a *larger* file than the user picked, keep
   already-small sources byte-identical, EXIF rotation applied, EXIF/GPS metadata dropped on re-encode.
3. **Thumbnails for the heaviest surface** (products) plus `photoThumb || photo` legacy fallback and a
   positional-parity rule that survives missing thumbs.
4. **Payload discipline exists where it matters most:** `/api/init` strips `photos[]`/`photosThumb[]`
   and ships `photoThumb` only; logos travel as an md5 + a cached `/api/branding` fetch.
5. **Format tolerance:** SVG and GIF are passed through untouched; HEIC works on Safari (which can
   decode it); all inputs are `accept="image/*"`.

### Gaps and risks (ranked)

| # | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| G1 | **High** | **Only 4 of ~13 write paths validate image size/type server-side.** `enterprise` (inventory + assets), `audit`, `audit/issues`, `advisor-notes`, `transport`, `block-factory`, `poultry/feed-mill`, `aquaculture/feed-mill`, `menu`, `staff-access` store whatever base64 arrives. A buggy client, a script, or a compromised session can put an unbounded blob into a JSON column and into every later payload that reads it. | route guard scan: `size-guards=0` on all of those; only `employees` (1.8 M/3.5 M chars), `profile` (700 K), `logos` (1.8 M), `documents` (2.5 MB + MIME allow-list) check. |
| G2 | **High** | **SVG/GIF (and un-decodable HEIC) are stored at original size — up to 20 MB → ~27 MB base64 in one row.** The pass-through protection has no byte ceiling. | `imageOptimize.ts` returns `untouched()` for `image/svg+xml`/`image/gif` and on decode failure; the 20 MB guard is a *decode* guard. |
| G3 | **High** | **Receipts are the one heavy family that still ships in full on bootstrap.** `/api/init` carries `transactions` verbatim (`receipt_image`, `receipt_images[]`). A workspace with 300 photographed receipts at today's 352 KB pays ~100 MB of base64 on every login/dashboard load. | `initSnapshot.ts` excludes `photos` for inventory only; `/api/init` maps inventory, passes transactions through. |
| G4 | **High** | **Client-only caps collide with the platform's 4.5 MB request ceiling.** If optimization fails (unsupported codec, canvas error), the fallback stores the *original* — which can be 20 MB — and the POST to `/api/enterprise`, `/api/audit`, `/api/documents`… will be rejected by the host before the app can explain why. | `MAX_SOURCE_IMAGE_BYTES = 20 MB`; `optimizeImage` returns originals on failure; `vercel.json` has no body-size handling. |
| G5 | **Medium** | **No photo-count budget.** Products, assets and receipts accept unlimited multi-select; each extra photo is another full base64 in a `jsonb` column, so one record can grow into megabytes and inflate every list/exchange that carries it. | `multiple` inputs at `SharedEnterpriseModule:3103`, `AssetRegistrationModal:715`, `ExpenseEntryForm:573`; no `.length` cap anywhere. |
| G6 | **Medium** | **Thumbnails exist only for products.** Asset grids, employee lists, receipt strips and QC evidence paint full images (258–593 KB each) in tables and cards. | 1 thumbnail field family in `schema.ts` vs 20+ image columns. |
| G7 | **Medium** | **Receipt/scan resolution is below the 200–300 DPI norm** for OCR, accountant review and print: 1800 px = 154 DPI (receipt), 2000 px = 171 DPI (document) on A4. | benchmark table §2. |
| G8 | **Medium** | **SVG logos upload cleanly but silently disappear from every PDF/Excel** (jsPDF cannot embed SVG without a plugin); logo embedding is `try/catch`-guarded so documents ship *without* the crest instead of failing. | `salesDocument.ts:119`, `universalExport.ts:115` — caught silently. |
| G9 | **Medium** | **APIs without any UI picker write images that bypass the optimizer entirely** (transport vehicle/fuel, advisor notes, poultry/fish QC, audit response). Their stored size is whatever the caller sends. | §2 last paragraph. |
| G10 | **Low** | Inconsistent pick-time rejection copy and behaviour: three sites abort the whole selection if *one* file is oversized, one silently drops the big ones, three have no check at all. | `ApprovalInbox:133` (drops), `AssetRegistrationModal:242` / `ExpenseEntryForm:154` (abort), `AuditCommandCenter:400` / `MyAuditIssues:87` / `BlockQcCenter` (none). |
| G11 | **Low** | No drag-and-drop or paste support anywhere, no per-file progress, and camera capture exists on only 2 of 16 inputs — even though most GoMina users are phone-first. | `grep onDrop\|onPaste` → 0 hits; `capture=` → 2 hits. |
| G12 | **Low** | On-screen-only SVG/HEIC assets that later fail to render show as a broken image with no explanation (HEIC on Chrome/Windows is the realistic case). | `imageOptimize` fallback + `<img>` sources. |

Non-issues verified: no EXIF orientation bug (rotation applied), no transparency-flattening bug any
more (the old "always JPEG" black-background logo bug is fixed), and thumbnails are positionally
parallel so a missing thumb never shifts its neighbours.

---

## 4. Recommended strategy (for approval)

### A. Size limits — three layers, one set of numbers

| Layer | Rule | Why |
| --- | --- | --- |
| 1. Pick guard (source file) | 20 MB as today, **plus**: when the browser *cannot* decode/re-encode, accept only ≤ 3.5 MB — otherwise reject with "convert this to JPEG" | a rejected upload is a better experience than a doomed one after the platform 413 (G4) |
| 2. Stored budget (per purpose) | product 500 KB · asset 400 KB · receipt 700 KB · evidence 300 KB · avatar 80 KB · employeePhoto 120 KB · logo 150 KB · document 2 MB · thumbnails 60 KB | all above today's real output (§2) with headroom; enforced **again server-side** by a shared validator (G1) |
| 3. Row/request budget | photos per record: products **6**, assets **6**, receipts **3**, evidence **1**, employee docs **5**; hard request-body ceiling ~4 MB | stops a single record from ballooning (G5) and keeps uploads inside the host limit (G4) |

### B. Resizing — keep the per-purpose model, fix the two legibility shortfalls

| Purpose | Today | Recommended | Rationale |
| --- | --- | --- | --- |
| product | 1600 px q0.82 + 400 px thumb | **unchanged** | zoomable detail, storefront-proven |
| asset | 1600 px q0.80 | unchanged | inspection detail |
| **receipt** | 1800 px q0.82 (154 DPI) | **2400 px WebP q0.85** (205 DPI) | smaller *and* sharper (measured) |
| **document** | 2000 px q0.88 (171 DPI) | **2800 px WebP q0.85** (240 DPI, 334 KB) or 2400 px (275 KB) | accountant/OCR legibility |
| evidence | 1400 px q0.78 | unchanged | displayed ≤ 300 px |
| avatar / employeePhoto | 320 / 480 px | unchanged | tiny UI |
| logo | 512 px q0.88, alpha-aware | unchanged | must stay JPEG/PNG (PDF embedding) |

### C. Formats

1. **Photographs → JPEG** (unchanged) — universal and PDF/Excel-safe.
2. **Receipts, documents, evidence → WebP q0.85 with automatic JPEG fallback** where the encoder
   supports it. Safe because these images only ever render in `<img>`/download — verified that no
   PDF/Excel path embeds them (the only embedded image in any export is the logo + QR PNG).
3. **Logos → JPEG/PNG (alpha) only**: reject SVG in the three logo slots (or rasterize it client-side
   first) so a crest can never silently vanish from an invoice (G8).
4. **SVG elsewhere, GIF, HEIC → keep pass-through**, but with the byte ceilings from A.2 and a
   visible "stored as-is, may not display in all browsers" hint for HEIC (G2, G12).
5. **Thumbnails → WebP** (unchanged), full images stay in the lightbox/detail view.

### D. Storage

**Keep base64-in-Postgres** — it is what makes business backup/export, tenant isolation and
offline-ish clients work today, and with budgets A.2 a typical record costs 50–500 KB. Two additions:

1. **Slim the bootstrap** (G3): extend the inventory policy in `initSnapshot.ts` to transactions
   (`receiptImages` → strip, keep 1 small thumb or `receiptCount`), employees (`photo` is already
   small — keep), assets (`assetImages` → strip + count), and any QC/vehicle photos.
2. **Optional Phase 2 (only if storage/egress pressure appears):** a content-addressed
   `media_assets(id, sha256, mime, bytes, data)` table with `GET /api/media/[hash]` (ETag +
   long cache, reusing the `/api/branding` + `/api/menu/photo` pattern). Dedupes the same logo or
   spec sheet across records and lets rows hold a short URL instead of a blob. Add write-through +
   read-fallback so no data migration is needed.

### E. Performance & UX

* Extend **thumbnails to the list surfaces** that need them (assets 400 px, receipts 400 px strip,
  QC evidence 200 px) and paint thumbs by default — mirrors the proven product behaviour (G6).
* Standardize the upload UX: an "Optimizing…" state, one message per rejected file with the reason,
  the existing "4.1 MB → 280 KB" summary everywhere, drag-and-drop + paste, and camera capture on
  the phone-first surfaces (inventory, assets, receipts already partial) (G10, G11).
* Keep never-upscale / never-inflate / keep-already-small rails exactly as they are.

### F. Enforcement & tests

* One shared server helper — `validateImageDataUrl(purpose, value)` (MIME allow-list + decoded-byte
  ceiling + data-URL shape) — called by **every** route that accepts an image (G1, G9).
* Extend the existing suites rather than adding new ones: `verify-image-optimization.mjs` (per-route
  oversize rejection, thumbnail parity, bootstrap-slimming assertions) and
  `verify-photo-formats.mjs` (format acceptance incl. SVG/GIF/HEIC ceilings), plus a mobile
  camera-capture smoke check.

---

## 5. What would NOT change (no-regression commitments)

* Every existing image keeps rendering — no reformatting, no re-encoding, no migration of stored bytes.
* Presets that already hit their targets (product/asset/evidence/avatar/employee/logo) keep today's
  numbers; only receipts/documents get **more** resolution.
* Excel/PDF exports keep working: logos stay JPEG/PNG, QR stays PNG, exports never depend on WebP.
* Backups/restores, tenant isolation and permissions are untouched by any of the above.
* The optimizer stays client-side (no new dependency, no server image processing, no object storage).

---

## 6. Open questions for approval

1. **Documents at 2800 px (240 DPI, 334 KB) or 2400 px (205 DPI, 275 KB)?** Recommendation: **2800 px**
   — the vault is where "print it for the accountant" happens, and both are far below the 2.5 MB rule.
2. **Receipts → WebP by default, or JPEG q0.9 at 2400 px** (341 KB vs 275 KB) for maximum
   compatibility with third-party viewers? Recommendation: **WebP with JPEG fallback**, since receipts
   render inside the app.
3. **Photo-count caps** — products/assets 6 and receipts 3 acceptable, or higher for your use cases?
4. **Phase 2 media table** — approve now, or defer until storage pressure is observed?
   Recommendation: **defer**; A–F alone cut typical payload weight by ~30–60 %.

Once approved, implementation is a contained change set: `imageOptimize.ts` presets + two guards, a
new shared server validator wired into the routes listed in G1, `initSnapshot.ts` slimming, thumbnail
fields for assets/receipts, and the UX polish — each step testable with the suites in §4.F.
