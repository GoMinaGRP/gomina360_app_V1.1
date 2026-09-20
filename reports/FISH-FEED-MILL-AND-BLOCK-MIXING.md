# Fish Feed Mill (Aquaculture) + Block Mixing (Block Factory) — Implementation & Verification Report

**Date:** 2026-09-19 · **Branch:** `arena/01a0a375-gomina360-app-v1-1` · **Status:** ✅ both implemented, fully verified

---

## 1. Scope (what was asked)

> Review the existing Aquaculture/Fish Farm and Block Factory modules and implement recommended improvements: (a) fish feed production inspired by the existing Poultry Feed Mill, with aquaculture-specific needs; (b) integrate Mixing into the Block Factory's existing Production system (materials, formulations, inventory, production, QC, finance) **without duplicating existing functionality**; preserve all existing data/features; fully test both; report with clear access/use instructions.

**Assessment findings that shaped the work:**
- **Aquaculture:** full pond/batch/feed-log/mortality/weight infrastructure existed, but no in-house feed production — feed remained a pure expense line and FCR analytics had no mill linkage.
- **Block Factory:** production ran "wet mix" ad hoc inside each production log (bagsOfCement guessed per run) — no formulation discipline, no material draw per batch, no mix-stage QC. The existing **QC stages** already had a `MIXING` stage enum that was never usable for actual mixer batches.
- **Poultry Feed Mill:** mature, proven pattern (formulations → BOM → raw intake → batches → QC gate → release → feed-out + supplier ledger + audit + finance discipline). Adopted as the reference architecture for both features, **adapted** to each domain rather than copied blind.

---

## 2. Aquaculture — Fish Feed Mill (NEW)

### 2.1 What was built

| Layer | Implementation |
|---|---|
| **Data model** (`src/db/schema.ts`) | 4 new tables: `fish_feed_formulations` (species, **feedClass FLOATING/SINKING**, feedStage STARTER/GROWER/FINISHER, **pelletMm**, batchSizeKg, cpPctTarget, version), `fish_feed_formulation_items` (BOM with sharePct), `fish_feed_batches` (planned/actual kg, costs, status QC_HOLD→RELEASED/REJECTED→EXHAUSTED, yield%, operator, cost/kg), `fish_feed_qc_checks` (stage incl. **FLOATING**, **floatPct**, **waterStabilityMinutes**), `fish_feed_consumptions` (batch+pond+fishBatch links). |
| **API** (`src/app/api/aquaculture/feed-mill/route.ts`) | `GET` (full mill payload) + `POST` entities INTAKE / FORMULATION / BATCH / QC / **RELEASE** / CONSUMPTION. Supplier intake uses org Suppliers ledger (`suppliers`, category "Poultry & Livestock Inputs" naming kept — feed inputs). |
| **UI** (`src/components/AquaFeedMill.tsx`, mounted in `AquacultureModule.tsx`) | New **Feed Mill** tab inside Aquaculture unit with 5 subtabs: **Mill Overview · Formulations · Batches & QC · Raw Stock & Intake · Feed Out**; full release gate UX, QC entry incl. float test + water stability, pond-linked feed-out. |
| **Audit** | `FISH_FEED_*` actions + audit-panel registry entries (fish feed formulations/batches record-scoped). |

### 2.2 Aquaculture-specific design (differences from poultry mill)

1. **Species/stage model** — formulations carry `species` (NILE_TILAPIA, AFRICAN_CATFISH, …), `feedStage` and physical `pelletMm` size instead of bird type; same BOM-share machinery (`Σ sharePct must equal 100`, server-enforced).
2. **Floating-vs-sinking bearates** — `feedClass FLOATING|SINKING`.
3. **Water-stability QC gate** — QC stage **FLOATING** with `waterStabilityMinutes` and **`floatPct` (10-min float test %)**. Server gate: a batch whose class is FLOATING can only be RELEASED if a passed FLOATING check has **floatPct ≥ 90** (tilapia floating-feed industry norm); SINKING class requires the same tests but judges water stability instead of float retention. Impossible by configuration: float test is still recorded for sinking feeds (crumbles can over-expand and float), but the threshold gate only applies to the FLOATING class.
4. **Pond-linked consumption** — feed-out writes a consumption row **and** an `aquaculture_feed_logs` row (existing pond analytics see own-mill feed, brand labeled "Own mill · FPB-…"), links `pondId` and/or `fishBatchId`, and **never** books another expense (cost was already recognized at intake). Batch auto-flips CONSUMED/EXHAUSTED; a release reversal restores finished-feed stock.
5. **Yield & cost Integrity** — impossible-yield guard (output > input×1.03 → 400 IMPOSSIBLE_YIELD), insufficient-stock 400 with prior draws rolled back, ONE `AQUA_FEED_MILL_OPS` ops txn only when labour+overhead > 0 (zero-ops demo runs book nothing).
6. **Finish-depleted multi-batch SKU** — finished feed is keyed `FISH-FM-AQUA-01-<formId>` (shared per formulation across production runs), same economics as poultry's finished item.

### 2.3 Role boundaries

Workers can create formulations/batches/QC and run feed-out; **RELEASE/REJECT/REVERSE and formulation deactivation are OWNER/canManageRecords only** (403 enforced server-side); QC FAIL fans out a HIGH-priority bell alert; releases/rejections write record-scoped `audit_trail` rows.

---

## 3. Block Factory — Mixing (NEW)

### 3.1 What was built

| Layer | Implementation |
|---|---|
| **Data model** (`src/db/schema.ts`) | 4 new tables: `block_mix_formulations` (name, **bound to master `blockTypes` entry** (by typeKey), designNote, **waterCementRatio**, batchSizeKg, active), `block_mix_formulation_items` (BOM sharePct, each line bound to an inventory item with sku `BLK-RM-*`), `block_mix_batches` (batch no `MXB-YYYY-XXXXXX`, planned/actual kg (default = materials + water mass), **blockType snapshot**, slump, w/c at run, costs, status QC_HOLD→RELEASED/REJECTED (recover/discarded)→CONSUMED with production-log link), `block_mix_batch_inputs` (per-run draw ledger). |
| **API** (`src/app/api/block-factory/route.ts`) | New entities `MIX_FORMULATION` (create/PATCH incl. BOM replace), `MIX` (run mixer), `MIX_RELEASE`, `MIX_REJECT`; extends **existing** `QC_CHECK` (stage `"MIXING"` now binds to mix batches via `batch_id`), **existing** `RESTOCK` (vendor auto-upserts org Suppliers ledger — new), **existing** `PRODUCTION` (optional `mixBatchId`: validates RELEASED + matching block type, then marks the mix CONSUMED 1:1 and links costs). `GET` returns mix payload. |
| **UI** (`src/components/BlockMixing.tsx`, mounted in `BlockFactoryModule.tsx`) | New **Mixing** tab between Inventory and Finance: recipe cards (BOM chips, w/c ratio, block type), run-mixer modal, per-batch rows with status pills + slump, release/reject (owner-only, override-with-note available + audited), QC-hold prompt pointing at QC Center. Production modal (existing view) gained a **"Mixing batch (optional)"** picker listing RELEASED mixes of the chosen block type. |
| **Audit** | `BLOCK_MIX_*` actions; registry lists `block_mix_formulations` / `block_mix_batches` tables. |

### 3.2 "No duplication" — how it integrates existing machinery

- **Formulations bind to the existing block-type master list** (`blockTypes`) — a recipe is a *mix for a block type*, so production consumption, inventory cat `Blocks`, and finished-goods crediting stay untouched.
- **Raw materials are ordinary inventory items** in the existing `inventory_items` table, auto-created in the existing **"Block Raw Materials"** category with `BLK-RM-*` skus on first use; the **existing RESTOCK intake** (with supplier + optional expense) is reused wholesale — the only change is one additive upsert of the vendor into the org-wide Suppliers ledger (same pattern the poultry mill landed earlier; helper shared via `src/lib/supplierLinks.ts`).
- **QC at the MIXING stage reuses the existing `QC_CHECK` entity + QC Center UI**: for mix batches the stage binds by `batch_id`; the QC Center's MIXING stage selector now offers real mixer batch numbers. Existing block QC behavior is untouched (suite-verified).
- **Consumption uses the existing PRODUCTION entity** — nothing new; a production run can now optionally say "this run consumed mixer batch MXB-2026-…". One production → one released mix (409 `MIX_ALREADY_CONSUMED`, 400 `MIX_TYPE_MISMATCH`, 409 `MIX_NOT_RELEASED` for hold).
- **Finance discipline follows the feed-mill pattern**: material draw recognized at intake (existing expense path), labour/overhead recognized **once per mix** as `BLOCK_MIX_OPS` txn only when non-zero; consumption books nothing.
- **Rejection recovery**: REJECT defaults to `recover materials` (dry draws returned byte-exact to raw stock), opt-out `DISCARDED` leaves stock as-is; terminal statuses immutable (rejected batches cannot be released).

---

## 4. Verification (all runs live: Next.js app + real DB + Chromium UI)

### 4.1 New suites

| Suite | Result | Coverage |
|---|---|---|
| `dev-tooling/verify-fish-feed-mill.mjs` (85 checks) | **85/85, repeated 5×** including after DEMO seed | Formula lifecycle + Σ=100/version guards (FMM- numbering), 4×BAG50 intake single-expense + supplier ledger upsert, shortage/impossible-yield draws-intact guards, exact BOM draws + ONE ops txn batch1 vs ZERO batch2, aquatic QC gate (FLOATING floatPct<90 → 400 QC_GATE; ≥90 released), owner/worker role gates, reject+release-reversal stock reversal (≈98 kg), pond-linked own-mill feed-out with **book-never-twice** money rule + BATCH_EXHAUSTED 409/400, GET determinism, record-scoped FISH_FEED_* audit rows, UI tab/formula-card/batch-card render, Z-forensics (inventory byte-exact + txn-count full-circle after scoped purge). |
| `dev-tooling/verify-block-mixing.mjs` (75 checks) | **75/75, repeated 4×** | Σ-share/type/existence guards, `MIX-` numbering, BOM auto-creates `BLK-RM-*` items, owner-only deactivate, RESTOCK supplier-ledger linkage ("Cement & Aggregates" category + accrual), shortage guard, byte-exact draws (510/90/…), default output = materials+water, impossible-yield guard, ONE BLOCK_MIX_OPS txn vs none-at-zero-ops, release gate (PRODUCTION 409 on QC_HOLD; release 400 without MIXING PASS; existing QC_CHECK binds mixer batch; owner override audited), consumption 1:1 → CONSUMED + production link + finished blocks credited (502) + dup/mismatch refused, REJECT recover-vs-discard exactness, audit registry+trail, UI render (new `bf-tab-MIXING`), Z-forensics byte-exact incl. logs/type counts. |

### 4.2 Real bugs found & fixed along the way (worth knowing)

1. **AquaFeedMill `refresh()` still fetched `/api/poultry/feed-mill`** (template-literal line missed by the source transform) → UI rendered "No formulations yet" while the API returned data. Fixed: all three poultry URLs → aquaculture; rebuilt.
2. **`dam_code` → `pond_id`** real column-name bug in the Feed-Out pond table cell + audit label text (both layers).
3. **`BlockMixing` component was authored but never mounted** in the BlockFactoryModule tab switch (TABS entry existed; `{tab === "MIXING" && …}` block missing) → tab click appeared to do nothing. Fixed; production modal mix-picker hint preserved.
4. **Tab-bar had no testids** → added `data-testid="bf-tab-<KEY>"` (additive, enables deterministic UI tests).

### 4.3 Regression suites (existing functionality — all green)

| Suite | Result |
|---|---|
| `verify-feed-mill.mjs` (poultry) | **100/100** |
| `verify-block-qc.mjs` | **51/51** |
| `verify-fish-analytics.mjs` | **32/32** |
| `verify-poultry-analytics.mjs` | **32/32** |
| `verify-feed-mill-demo.mjs` | **13/13** (one flaky timing run observed; green on repeat) |
| `verify-notifications.mjs` | 39 pass / 4 fail — **pre-existing environment limitation** (OS push cannot reach devices from this sandbox: `attempted:1 sent:0`). Verified identical failures on the untouched baseline commit (`git stash` + rebuild + re-run on `320bffa`). In-app bell pipeline fully green. |

**No existing data was harmed**: every new sequence/table verified via Z-forensics (inventory byte-exact comparisons, transaction-count full-circle, purges scoped to suite markers only). All schema changes are additive (owned by `dev-tooling/migrate-production-schema.mjs` + `src/db/schema.ts`).

---

## 5. Demo data (planted, guarded, removable)

`dev-tooling/seed-fish-mixing-demo.mjs` seeded — **finance-transaction snapshot + existing-inventory byte forensics both PASS**; script is idempotent (`DEMO ·` prefix skip) and all intakes/restocks used `recordExpense:false` (no money booked):

- **AQUA-01 (Volta Cage Tilapia Farm)** — 2 DEMO formulations (Volta Tilapia Grower 32%CP Floating 4.5mm · Starter 38%CP Sinking 1.5mm), 7 DEMO raw ingredients with supplier ledger rows ("DEMO · Tema Fishing Harbour Suppliers" etc.), batch **FMB-… (300→291 kg) RELEASED** through a 5-stage aquatic QC incl. FLOATING 96% float/24 min stability, second batch on **QC_HOLD with a float FAIL (34%)** to demo the gate + bell, and one pond feed-out of **62 kg own-mill** linked to the active pond (no re-expense).
- **BLOCK-01 (Mina Concrete & Blocks)** — master type "DEMO 8in Sandcrete Test Blocks", recipe **DEMO · Lab 8in Sandcrete 1:9** (Σ=100, w/c 0.58), restocked raw materials (stock-only), mix **MXB-… RELEASED** (47 mm slump at MIXING QC, still un-consumed and available for a production run), second mix on **QC_HOLD with a 74 mm slump FAIL** to demo the gate.

**Cleanup path:** re-run-removal is by `DELETE … WHERE name LIKE 'DEMO ·%'` on the new tables + joined children (same pattern as `seed-feed-mill-demo.mjs`'s footnote), or leave as permanent demo narrative.

---

## 6. How to access and use

**Login (GoMina demo org):** `kwame.owner@gomina360.com / Owner@GoMina26`, or any demo viewer.

### Fish Feed Mill
1. App → **Units** → **Volta Cage Tilapia Farm (AQUA-01)** → module opens at **Dashboard**; click the new **Feed Mill** tab (top tab bar).
2. **Mill Overview** — KPIs, mill alerts (low raw cover, batches on hold), recent batches.
3. **Formulations** → **"+ New Formula"** — pick **species** (tilapia/catfish…), **feed class (FLOATING/SINKING)**, **stage**, **pellet size (mm)**; add ingredient lines (shares auto-sum; **must equal 100%** to save — server enforces); rows auto-create stock items on first use.
4. **Raw Stock & Intake** → record intake (qty + unit cost + supplier; supplier names auto-link the org Suppliers ledger; untick *Record expense* for internal stock moves).
5. **Batches & QC** → run a batch (planned kg → actual output; yield/efficiency computed; optional labour+overhead become ONE ops expense). Status `QC_HOLD`. Add QC checks — at minimum **FLOATING** (float % + water-stability minutes) and **FINISHED_FEED**; a FAIL rings the owner's bell.
6. **Release** (owner/admin only; possible only when gate checks pass — FLOATING feed additionally needs **floatPct ≥ 90**). Reject restores finished stock.
7. **Feed Out** — choose pond (and fish batch), record kg; writes the aquaculture feed-log entry as "Own mill · FPB-…" — **no additional expense**. Watch the batch move to `CONSUMED`, then flip `EXHAUSTED` at zero.

### Block Mixing
1. App → **Units** → **Mina Concrete & Blocks (BLOCK-01)** → new **Mixing** tab (between Inventory and Finance).
2. **Recipes** card → **"+ New Recipe"** — pick the block type from the **existing master list** (+ Add New Block Type… mirrors production), set batch size (kg) and **water/cement ratio**, add ingredient share lines that **sum to 100%** (materials are auto-created as `BLK-RM-*` inventory items in the "Block Raw Materials" category on save).
3. **Raw materials**: stock them via the existing **Inventory → Restock** flow (vendor name links the org Suppliers ledger automatically).
4. **Batches**: **"+ Run Mixer"** — planned kg + actual water used; output defaults to materials+water mass (editable), slump optional. Labour+overhead > 0 books exactly one `BLOCK_MIX_OPS` expense.
5. **QC** (tab *Quality Control*, stage **MIXING**) — pick the `MXB-…` batch (now listed), record slump/uniformity PASS/FAIL. FAIL rings the bell; batch stays `QC_HOLD`.
6. **Release** (owner-only; QC-pass based, owner override-with-note available and audited). Rejected batches can **recover materials** (dry draws returned) or be discarded.
7. **Production tab** — the production log now has **"Mixing batch (optional)"**: pick one **RELEASED** mix of the same block type; the run consumes it 1:1 (mix flips `CONSUMED`, its cost links to the produced blocks).

**Demo narratives already staged:** the RELEASED tilapia-grower feed batch + the RELEASED 8in sandcrete mix are both one click away from their *consume* walkthroughs; the FAIL-left batches demo the gates and the notification bells.

---

## 7. Files

| Path | Change |
|---|---|
| `src/db/schema.ts` | +8 tables (fish feed mill 5, block mixing 4 incl. shared BOM/items) + indexes |
| `dev-tooling/migrate-production-schema.mjs` | additive DDL for all 8 tables (ran at deploy 2026-09-19) |
| `src/app/api/aquaculture/feed-mill/route.ts` | NEW mill API (INTAKE/FORMULATION/BATCH/QC/RELEASE/CONSUMPTION + GET) |
| `src/app/api/block-factory/route.ts` | +MIX_FORMULATION/MIX/MIX_RELEASE/MIX_REJECT; MIXING-stage binding in QC_CHECK; supplier upsert in RESTOCK; mixBatchId consumption in PRODUCTION; mix payload in GET |
| `src/components/AquaFeedMill.tsx` | NEW component (mill console, 5 sub-views) |
| `src/components/AquacultureModule.tsx` | mounts Feed Mill tab |
| `src/components/BlockMixing.tsx` | NEW component (recipes + mixer runs + status pills) |
| `src/components/BlockFactoryModule.tsx` | mounts Mixing tab + bf-tab-* testids + production-run mix picker |
| `src/components/BlockQcCenter.tsx` | MIXING stage lists mixer batches |
| `src/lib/supplierLinks.ts` | shared org-supplier upsert helper (also reused by poultry mill) |
| `src/lib/feedMillAnalytics.ts` | recognizes FISH_FEED_* actions for mill analytics windows |
| `src/app/api/audit/route.ts` | audit registry entries for the 8 new tables |
| `dev-tooling/verify-fish-feed-mill.mjs` · `dev-tooling/verify-block-mixing.mjs` | NEW full verification suites (85 + 75 checks) |
| `dev-tooling/seed-fish-mixing-demo.mjs` | NEW guarded DEMO seed (idempotent, finance/inventory forensics) |

**Run the suites:** `bash dev-tooling/run-suite.sh dev-tooling/verify-fish-feed-mill.mjs` · `bash dev-tooling/run-suite.sh dev-tooling/verify-block-mixing.mjs`
