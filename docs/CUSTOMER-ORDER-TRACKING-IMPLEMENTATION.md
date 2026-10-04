# Customer Order & Tracking — product-first implementation report

**Programme:** implement the recommended product-first Order + Tracking experience
(the recommendations of `docs/CUSTOMER-ORDER-TRACKING-AUDIT.md`).
**Phases:** P1 spine · P2 product enquiry · P3 tracking parity · P4 consistency & polish.
Each phase was built, tested against the live app, fixed where it failed, committed and pushed
before the next one started.

---

## 1. What the customer sees now

**`/order` (default, no filters)**

```
[dark customer header]  brand · SEARCH · HELP · Track order → · Cart
                        + category strip (one scrollable row)
[one-line intro]        17 products from 8 shops — live stock, one page …
[filter bar]            Delivery · Use my location · Drop a pin ·
                        Delivering to me (8) · All shops (8) · Clear      ← one row
[shop strip]            All shops · shop · shop · shop …                  ← ONE row, scrolls
[catalogue]             grouped BY CATEGORY, every shop side by side
                        each card: photo · name · "Sold by <Shop>" · Call · Ask · Directions
                                   category/subcategory/unit/brand tags · price · Add to Cart
[sticky cart]           items · Clear · <Shop name> · total · Proceed to Checkout ▼
```

Focus mode (shop chip, “Sold by <Shop>”, `?biz=`): the same page narrowed to one shop, plus a
slim `oo-shop-strip` naming the seller with its own phone, WhatsApp, directions and address.

**`/track?code=…`**

Same dark customer header, light storefront body: lookup card → status card (ARIA live region) →
maps → order receipt (each line linked to its product) → **“From \<Shop\>”** seller card
(call · WhatsApp about this order · directions · shop this store again) → payment, credit,
pre-order, help & MoMo, timeline.

---

## 2. Phase by phase

### P1 — Order page spine
* **Category-first catalogue** — `catGroups` memo groups the visible shops' products by
  category (richest shelf first), cross-shop in one section; `renderProduct(p, biz, showShop)`
  renders the per-card attribution.
* **Shop dimension demoted to a filter** — the 8-row/472 px chip wall became one horizontally
  scrollable row (`oo-bizrow`) with `All shops` + per-shop chips (products count, distance,
  service area, “pickup only here”), plus an optional “Find a shop…” box when >8 shops.
* **Filter bar** — GPS / drop-a-pin / `Delivering to me (n)` / `All shops (n)` / `Clear` on one
  row; the old welcome card became a one-line intro.
* **Search upgrade** — `productHaystack()` spans name · category · subcategory · brand · model ·
  SKU · unit · description · shop name/code/branch and matches **word prefixes**
  (“ceme” → Cement; “cement” no longer matches “Steel & Reinfor**cement**”), with a result bar
  (`N products · M shops · clear ×`) and category suggestions on zero matches.
* **Cart names its shop** (`oo-cart-shop`) — the single-shop rule stays, so the customer always
  knows which shop the order belongs to.
* Files: `src/app/order/page.tsx`, `src/app/globals.css` (one-line rule for both strips).

**Measured (390×844):** first product **1659 px → 496 px** (inside the first viewport), shop
strip **472 px / 8 rows → 50 px / 1 row**, page height 8881 → 8003 px, no horizontal scroll.
At 768 px and 1440 px the strip is also one row (previously the desktop row overflowed by ~40 %).

### P2 — Product ↔ selling shop enquiry (no server change)
* New shared helper `src/lib/shopContact.ts`: `shopPhone` (customerHelpPhone → contactPhone),
  `telHref`, `waDigits`/`waHref` (Ghana `0…` → `233…`), `shopAddress`, `shopDirectionsUrl`
  (shop pin → pickup-point pin → address text), `shopAskText`, `productShareUrl`.
* Cards: `Call` / `Ask` (WhatsApp) / `Directions` chips, each built from **that card's own
  shop**, with the message naming shop + product + SKU.
* Lightbox: “From \<Shop\>” seller panel (`oo-lightbox-seller`) + a primary **“Ask \<Shop\> about
  this item”** button (`oo-ask-<id>`) whose WhatsApp message carries the item's storefront link
  (origin resolved after mount, so SSR/hydration stays identical).
* Focus mode: the slim seller strip above the catalogue.

### P3 — Tracking page parity
* **Shared header** — new `src/components/CustomerHeader.tsx`; both pages render the same dark
  band (brand + slots + optional departments strip), so they cannot drift apart again.
* **Light storefront look** on `/track` (white cards on `bg-slate-100`), desktop **2-column
  receipt** at ≥1024 px, no horizontal scroll at 390 px.
* **Item linkage** — `track-item-<n>` rows carry `track-item-link-<n>` →
  `/order?biz=<businessId>&p=<productId>` and `track-item-sku-<n>`; a line without a product
  identity degrades to the shop's own links (never a dead end).
* **Seller card** `track-seller` — “From \<Shop\>”, the shop's phone (`tel:` showing the number),
  a WhatsApp enquiry quoting this order's code **and** its tracking link, directions, and
  “Shop this store again”.
* **`/api/track` — strictly additive**: top-level `businessId`, `items[].productId` +
  `items[].sku`, and `seller` shaped exactly like a public `/api/menu` business row. Existing
  `help`/`momo` fields untouched; only the order's own shop is ever exposed.

### P4 — Consistency, polish, a11y
* **Vocabulary sweep** to “Shop” on both customer pages (HELP/HOWTO steps, error/confirm copy,
  `/track` labels “Shop”/“Location”, cancelled/credit/pre-order copy).
* **Empty & edge states** — no-match search → category chips; no shop delivers → show all /
  pickup; cancelled order → “contact the shop” with a call link when the shop has a number.
* **A11y** — `aria-pressed` on category and shop chips, `aria-label` on the cart remove button,
  `role="status" aria-live="polite"` on the tracking status card, labels on refresh/copy.
* **Docs** — `docs/CUSTOMER-ORDER-TRACKING-AUDIT.md` §8 marks the plan implemented (with the
  testid deltas), §12 records the resolved decisions.

---

## 3. Acceptance criteria — measured results

Verified by `dev-tooling/verify-customer-order-tracking.mjs` (**25/25**), which prints its
metrics inline.

| # | Criterion | Result |
| --- | --- | --- |
| 1 | First product inside one 390×844 viewport | ✅ **496 px** (was 1659 px) |
| 2 | Category-first default, same category across shops, per-card attribution | ✅ 8 sections; “Building Materials” = 2 shops / 6 cards; 17/17 cards attributed |
| 3 | Shop control one row at every width, no horizontal page scroll | ✅ 1 row at 390 / 768 / 1440 px; `scrollWidth ≤ innerWidth` |
| 4 | Search spans name · category · subcategory · brand · SKU · shop · description + result bar + suggestions | ✅ “cement”, “POUL-EGG-L01”, “reinforcement”, “Building”, “Poultry” all hit; every hit shows “N products · M shops”; “zzzzz” → suggestions + clear |
| 5 | Card **and** lightbox show the selling shop with Call / WhatsApp / Directions | ✅ 17/17 cards + lightbox seller panel with `tel:`, `wa.me`, Maps directions |
| 6 | `/track` “From \<Shop\>” with a working contact action | ✅ seller card with the shop's own number + WhatsApp quoting the order code |
| 7 | Every `/track` line links to its product; degrades gracefully | ✅ links `= /order?biz=1&p=…`; the free-text line keeps the shop links |
| 8 | One header, one theme, one vocabulary, one contact model | ✅ shared `CustomerHeader`, light theme, “Shop” vocabulary, same `shopContact` chain |
| 9 | Deep links & isolation unchanged | ✅ `?biz=`, `?p=`, `/track?code=` all work; public payload carries only the order's own shop; unknown code → 404 |
| 10 | Existing suites stay green | ✅ see §4 |

---

## 4. Tests run (all against the live app, prod build)

| Suite | Result |
| --- | --- |
| `verify-customer-order-tracking.mjs` *(new — AC1–AC9)* | **25/25** |
| `verify-tracking.mjs` *(+ P3a–P3f)* | **57/57** |
| `verify-order-page-regression.mjs` *(+ ENQ1–ENQ6)* | **40/40** |
| `verify-finance-allproducts-fresh.mjs` *(S1–S5 re-encoded)* | **49/49** |
| `verify-storefront-help.mjs` *(C8c re-encoded)* | **47/47** |
| `verify-storefront-areas.mjs` | **53/53** |
| `verify-permissions-storefront.mjs` | **48/48** |
| `verify-online-ordering.mjs` | **34/34** |
| `verify-online-mgmt.mjs` | **81/81** |
| `verify-orders-maps.mjs` | **51/51** |
| `verify-product-share.mjs` *(B1 re-encoded)* | **34/34** |
| `verify-categories.mjs` | **30/30** |
| `verify-customer-360.mjs` | **40/40** |
| `verify-customer-ui.mjs` | **12/12** |
| `verify-az-app-audit.mjs` | **41/41** |
| `verify-responsive.mjs` (57 page views + 114 module tabs) | ✅ 0 offenders |
| `verify-category-notes.mjs` C1–C10 (storefront catalogue) | ✅ |

Also verified by hand: zero page errors on both pages, no horizontal overflow at 390/768/1440,
and the share/QR deep link (`?p=`) still focuses + highlights the shared product.

---

## 5. Remaining issues / notes

1. **`verify-category-notes` B10/B13 — pre-existing, not this work.** Those two checks click
   “Daily Checklist” by text on a brand-new unit's dashboard, which no longer opens from that
   interaction after the earlier navigation work. Confirmed failing identically on the **pre-P1
   build** (changes stashed, rebuilt, re-run); the storefront part of that suite (C1–C10) passes.
   The suite needs updating to the current nav interaction — tracked as dev-tooling debt.
2. **`/api/menu`'s 10-second TTL cache** can make a *fixture-creating* suite followed immediately
   by an ordering suite see a stale product. The order endpoint correctly refuses with
   “One of the products is no longer sold by this branch — please refresh the menu.”; re-running
   the order suite after a short pause passes 51/51. Run order-related suites first, or pause
   ~10 s between suites that add/remove catalogue rows.
3. **Map tiles in this sandbox**: `server.arcgisonline.com` has no outbound route here, so basemap
   tiles log `ERR_CONNECTION_CLOSED`. Suite assertions ignore third-party tiles; the map iframes
   themselves render (verified in production-shaped screenshots).
4. **Cross-shop cart guard is still `window.confirm`.** The audit suggested a translated choice
   sheet (“Keep \<Shop A\> items” / “Start a new order from \<Shop B\>”). Behaviour is unchanged
   and the single-shop rule is enforced server-side; the visual upgrade is deferred.
5. **`oo-bizsec-*` (per-shop sections) is gone by design** — three suites were re-encoded
   (finance S1–S5, storefront-help C8c, product-share B1) to assert the new IA instead
   (category sections + strip + per-card attribution), keeping the same coverage intent.
6. **No permission or data-model changes.** Public payloads stay read-only and per-code; only the
   order's own shop is exposed. `seller` / `businessId` / `items[].productId|sku` are additive.
