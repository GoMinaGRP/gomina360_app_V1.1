# Customer Order & Tracking Pages — Structure Audit & Recommendation

**Status: audit + recommendation only — nothing implemented.**
Directive: make **products, categories, search, ordering and tracking** the primary
customer experience instead of a long list of businesses; business browsing must not
dominate; each product and order stays linked to its selling business with that
business's own contact/enquiry path; one consistent experience across Order and
Tracking on desktop and mobile.

---

## 1. Method & evidence

Live inspection of the running production build (`/order`, `/track`, `/api/menu`,
`/api/track`) at three viewports, plus a read of the source that drives both pages.

| Evidence | Value |
| --- | --- |
| `/api/menu` payload (today's data) | **17 sellable products across 8 shops**, 24.6 KB, served in ~40 ms |
| Shop chip row at 390×844 | wraps to **472 px tall** (up to 8 stacked chip lines); the row is *not* horizontally scrollable |
| First product at 390×844 | **y = 1,659 px ≈ 1.97 viewports** below the top (welcome strip 185 px + serve card 105 px + chip wall 472 px + shop banners) |
| First product at 768×1024 | y = 1,167 px ≈ 1.14 viewports |
| First product at 1440×900 | y = 972 px ≈ 1.08 viewports, but the chip row is **2,097 px wide inside a 1,248 px container** → 40 % of shops sit behind a scrollbar |
| Page height (17 products) | **10.5 viewports on a phone**, 7 on desktop |
| `/track` live order | status card → delivery map → order details → payment → timeline. **Zero `tel:` / `wa.me` links rendered** — the "Help & payment" card is conditional and the shop has no `customerHelpPhone` set |
| Search behaviour | `oo-search` matches **product name only**; "block" → 1 shop section; "zzzz" → bare "No products match." with no result count, no suggestions, no clear-button |

Source read: `src/app/order/page.tsx` (2,180 lines), `src/app/track/page.tsx` (759),
`src/app/api/menu/route.ts`, `src/app/api/track/route.ts`, `src/lib/tracking.ts`,
`src/components/ProductLightbox.tsx`, `src/db/schema.ts`.

---

## 2. What exists today (information architecture)

**`/order`** — light "Amazon-style" marketplace
```
[header] logo · search(name-only) · HELP · Track order → · Cart
[category strip] All departments · Poultry & Eggs · Building Materials …   (scrolls)
[welcome strip]  "Everything from all our businesses — live stock, one page" (185 px on phone)
[serve card]     "Branches serving your location" · Use my location · Drop a pin
[shop chip row]  🛍️ All businesses (17) + one card per shop (+ areas · distance · pre-order badge)
[catalog]        grouped SHOP → category sections → product cards
[checkout]       one form (name, phone, pickup/delivery + map pin, payment, note)
[sticky cart]    lines, total, Proceed to Checkout
[help modal]     group-wide support info + 9-step guide
[success card]   GM-* code, pickup/delivery map, shop help/MoMo if configured, track link
```

**`/track`** — dark, single narrow column (`max-w-2xl`)
```
[header] 360 · "Order Tracking" · Order online →            (no search, no cart, no HELP)
[lookup] tracking code
[status] code · Notify me · Refresh · stage stepper · current status
[map]    live courier location (while dispatched)
[order]  Business · Branch · Customer · Fulfilment + item table (description, qty, amount)
[pre-order facts] [payment status] [credit-sale card] [help & payment — conditional]
[timeline] status-update feed
[share]  copy tracking link + QR
```

**The structural fact that explains the design:** the cart is **single-shop**
(stock, tracking, payment, delivery areas and service fees are all per branch), so
every shop is a separate ordering destination. The current page resolves that by
showing *all* shops as a row of cards — the shop dimension became the page's
primary axis. That is exactly the inversion the directive asks to fix.

---

## 3. Findings

| # | Finding | Evidence | Severity |
| --- | --- | --- | --- |
| **F1** | **Business browsing dominates, especially on mobile.** 472 px of shop chips plus two intro blocks; the first product is two full screens down on a phone. | measurements above; screenshots | High |
| **F2** | **Products are grouped by shop, not by category**, so comparison shopping is impossible: "Building Materials" appears under two shops in separate sections. | "Build. Materials" chip → `oo-bizsec-2` + `oo-bizsec-8` | High |
| **F3** | **Search is name-only.** Category, subcategory, brand, SKU, shop name and description are not searchable; no result count, no "did you mean", no suggestions, no clear button. | `products`/`allGroups` memos filter on `p.name` only; probe: "zzzz" → bare empty state | High |
| **F4** | **Search results are invisible in the chrome.** Nothing tells the customer how many products matched or which shops they came from; the header still says "Search all products across every shop…". | probe of `oo-search` | Medium |
| **F5** | **No product enquiry path to the selling business.** `businesses.contact_phone` is **already published** in the public `/api/menu` payload but is never rendered anywhere on `/order` or `/track`. The product lightbox has no seller block; cards have no "ask the shop". | `grep contactPhone` on both pages → 0 hits | High |
| **F6** | **The per-order contact card can be empty.** `/track` renders "Help & payment for this order" only when `customerHelpPhone` **or** `momoNumber` is set — all 8 shops currently have neither, so a live order page shows **no way to contact the shop at all**. | live probe: `tel/wa links: []`; `t.help || t.momo` guard | High |
| **F7** | **Order lines don't link back to products.** `/track` prints `description` ("Dressed Broiler Chicken (SKU)") as plain text — no image, no link to the product, no "ask about this item". | `publicTrackingPayload` maps only description/qty/unit/price/total | Medium |
| **F8** | **The two pages are visibly different products.** `/order` = light Amazon-style (`#131921` header, `max-w-7xl`); `/track` = dark slate (`max-w-2xl`). Different header, different vocabulary ("All businesses" vs "Business/Branch"), different contact model (group HELP vs per-order card). | screenshots; source | Medium |
| **F9** | **The chip wall is an accidental CSS outcome, not a design.** A global rule (`main .flex:has(> button + button) { flex-wrap: wrap }` at ≤1279 px) overrides the row's intended horizontal scroll, so it wraps into a block on phones/tablets while staying a scroller on desktop. | `src/app/globals.css` + measured `flex-wrap: wrap`, `overflow-x: auto` | Medium |
| **F10** | **Two intro blocks cost the first screen.** The 185 px welcome paragraph and the serve card sit above the catalogue; both are "explain the shop" content, not "show me products". | measurement | Medium |
| **F11** | **Deep links and focus mode already exist and work** (`?biz=`, `?p=`, "Focus →", per-product share, QR). Any redesign must keep them — they are the cheapest way to make a business linkable without an owner-first page. | source + probe: `?p=` focuses the owning shop | (constraint) |
| **F12** | **Platform-wide scaling risk.** The one-page grid renders every shop's every product; at 17 products it is already 10.5 phone-viewports. There is no pagination, lazy loading or category landing. | payload/height figures | High (future) |

Additional smaller issues worth folding into the work: the item table on `/track`
shows no product images; `/order` has no "continue shopping from this shop" on the
track page or vice versa; and the phone header hides the "GoMina 360" wordmark
(`hidden xs:block`) leaving only the 360 badge.

---

## 4. Recommendation (primary option)

**Keep one marketplace page, but change its spine: category-first, search-first,
with the selling shop carried on every product and a single shop filter.**

### 4.1 `/order` — target structure

```
[header, sticky]  logo · SEARCH (full width, live) · HELP · Track order → · Cart
                  ↓ search shows a results bar: "12 products · 4 shops · Clear"
[filter bar]      [Category ▾ / chips]   [Shop ▾ All shops (8)]   [Delivering to me (5)]
[grid]            products from all shops, grouped BY CATEGORY
                  each card: photo · name · category chip · price · availability
                             "Sold by <Shop> · <branch>"  ·  ⓘ details · Share
[catalog footer]  "New: shop all products from <next category>" (progressive browse)
[checkout]        unchanged (one order = one shop)
[sticky cart]     always names its shop: "Cart — Mina Akuafo Poultry Farm · 3 items · GH₵160"
```

- **Default (no filter):** every product, grouped by **category**, newest/most-stocked
  first inside each group — the shopper sees chicken, eggs, blocks, tilapia, phones
  immediately instead of eight shop headers.
- **Shop filter:** one control in the filter bar — `All shops (8)` / `<Shop> (<n> products)` —
  a native select on mobile (≤ ~12 shops) that upgrades to a searchable popover with
  counts and the near-me marker beyond that. It replaces the chip wall entirely.
- **Focus mode stays** (choosing a shop in the filter, tapping "Sold by <Shop>" on a
  card, or opening `?biz=`): the page narrows to that shop, its service areas /
  pickup points / pre-order note appear as **one slim shop strip**, and categories
  become that shop's categories only (today's focused behaviour, minus the wall).
- **Near-me becomes a filter toggle**, not a card: `Delivering to me (5)` with the
  GPS/"drop a pin" affordance moved into the popover. (The serving evaluation itself
  is already implemented in `businessServesLocation()` — pure reuse.)
- **Welcome strip shrinks to one line** (or moves into the HELP panel), so products
  start inside the first viewport.
- **Search upgrade:** match **name · category · subcategory · brand · SKU · shop name
  · description**, show `N products · M shops`, a clear (×) button, and — on no
  matches — suggest the nearest categories instead of a bare "No products match."
- **Single-shop cart stays** (see §7) but becomes visible: the cart bar names the
  shop; the cross-shop guard (`window.confirm`) becomes a real, translated choice:
  *Keep <Shop A> items* / *Start a new order from <Shop B>*.

### 4.2 `/track` — target structure

```
[header, sticky]  same light chrome, logo · Search products · HELP · Order online → · Cart
[lookup]          tracking code (unchanged)
[status]          code · notify · stepper · status            (unchanged)
[map]             live courier (unchanged)
[order]           items WITH image + name (link → /order?biz=<id>&p=<id|sku>) + qty + amount
                  "Ask about this item" on each line (prefilled)
[seller block]    "From <Shop>" · branch/location · Call · WhatsApp · Directions · MoMo
                  contact resolution chain (never empty — see §5)
[pre-order / payment / credit]  (unchanged content, restyled)
[timeline]        (unchanged)
[share]           copy link + QR (unchanged)
[footer strip]    "Order again from <Shop>"  ·  "Browse all products"
```

Layout: keep the single receipt column (`max-w-2xl` → `max-w-3xl`) but at ≥ lg use a
2-column grid — status/map/items on the left, timeline + help on the right — so a
desktop doesn't show a 672 px ribbon with 60 % empty page.

### 4.3 Alternatives considered and why they were rejected

| Option | Verdict |
| --- | --- |
| **A. Per-shop storefront pages** (`/shop/<slug>`, category-first landings) | Best SEO and the cleanest "business as a destination", but the product decision is a single shared marketplace and orders already deep-link by `?biz=`. Bigger surface, more routing and a second navigation model. Keep as a later option if the catalogue grows past a few hundred SKUs. |
| **B. Keep business-grouped default, just collapse the chip wall** | Cheap, but leaves F2 (no cross-shop comparison) and F12 (page grows linearly with shops) untouched — it fixes the symptom, not the structure. |
| **C. Multi-shop cart (one checkout, split into per-shop orders)** | Would remove the reason the shop dimension dominates… but stock deduction, tracking codes, delivery areas, service fees and payment all key off one branch today. Large, risky change to ordering/payment semantics. **Out of scope** — recommended as a separate future decision, not part of this redesign. |
| **D. Business-first landing with a "marketplace" secondary tab** | Inverts the directive (business would still be the entry point) and adds a mode toggle customers must learn. |

---

## 5. The selling-business link and the enquiry model (F5, F6, F7)

Two levels, both using data that already exists:

**Level 1 — before ordering (product enquiry).**
On the card context menu and inside the product lightbox, a compact **"Sold by <Shop>"**
block: shop name · branch/location · *Call* (`tel:`) · *WhatsApp* (`wa.me`, labelled
"Call / WhatsApp") · *Directions* (existing `googleMapsLink`). Plus **"Ask about this
item"**, which opens WhatsApp/tel prefilled with the product name, SKU and the
`/order?biz=…&p=…` deep link, so the shop knows exactly what the customer saw.
No new endpoint is required for v1 — the menu payload already carries
`contactPhone`, `customerHelpPhone`, `momoNumber`, `gpsLat/Lng`, `branchLocation`.

**Level 2 — after ordering (order enquiry).**
The `/track` "From <Shop>" block, resolved server-side as a **fallback chain**:
`customerHelpPhone` (the shop's deliberate customer line) → `contactPhone` (the unit's
registered public line, already published in `/api/menu`) → the organization's
support row (`/api/support-info?org=`). The block renders whenever *any* of the three
exists, so an order page can no longer be contact-less (today's F6).

**Privacy guardrails (unchanged rules, restated for the implementation):**
- The public tracking payload already exposes exactly one order and only that order's
  shop; the seller block must use the **order's own** business id, never the id from
  a query string (today `/api/track` looks the business up from the tracking row — keep it that way).
- Expose the product **SKU** (already printed on receipts and required for the deep
  link) but never `inventoryId`, other shops' phones, customer phone, or staff data.
- A product deep link resolves against the **current public catalogue**; if the item
  is gone/sold out the storefront degrades to normal browsing and the enquiry
  action remains the fallback.

---

## 6. One consistent experience across Order & Tracking

| Dimension | Rule |
| --- | --- |
| Visual language | One customer theme for both pages (recommend the light storefront palette behind a **shared customer header component**); the tracking page keeps its "receipt" density, not its separate dark identity. |
| Header | logo · product search · HELP · Track/Order cross-link · cart (cart shows 0/disabled on `/track`). |
| Vocabulary | Customer-facing word for a business unit = **"Shop"** (with the unit's real name and branch shown); "Business/Branch/Organization" stays staff-side. *(If you prefer strict internal parity, use "Business" everywhere — but pick one and apply it to both pages, HELP text, HOWTO steps and the empty states.)* |
| Contact | Same three actions (Call · WhatsApp · Directions) and the same fallback chain in both places. |
| Money | Both pages already pin GH₵ — keep. |
| Empty/edge states | Same wording pattern: what happened, why, and the next action (search no-match → categories; no shop delivers → show all shops / pickup; cancelled order → contact the shop). |
| Mobile first | Design at 390×844 first; every control must fit one row or become a sheet; no horizontal page scroll at any width. |

---

## 7. Desktop & mobile behaviour

| Viewport | `/order` | `/track` |
| --- | --- | --- |
| Phone (≤ 640) | sticky search; category chips scroll horizontally (one row, 40 px); shop filter = native select / bottom sheet; grid 2-up; card shows "Sold by" one-liner; sticky cart names the shop; lightbox gets a sticky Call/WhatsApp footer | single column; items table becomes stacked rows with thumbnail + link; seller block directly under the status card |
| Tablet (641–1023) | 3-up grid; filter bar wraps into at most 2 rows | single column, wider paddings |
| Desktop (≥ 1024) | 4–5-up grid; filter bar one row; shop filter popover with search | 2-column receipt layout (details left, timeline/help right) |

---

## 8. Phased implementation plan — ✅ IMPLEMENTED (P1–P4)

> **Status (see `docs/CUSTOMER-ORDER-TRACKING-IMPLEMENTATION.md`):** all four
> phases below are implemented, tested and pushed. The plan is kept as the
> record of what was promised; the implementation report carries the measured
> results.
>
> **Testid deltas agreed during implementation** (the old shape encoded the
> pre-product-first IA):
> · `oo-bizsec-*` (one wrapper per shop containing its category sections) is
>   **superseded** by `oo-catsec-*` (one section per category, every selling
>   shop inside it) + `oo-sold-by-shop-<productId>` (per-card attribution) +
>   the `oo-bizrow` shop strip. `verify-finance-allproducts-fresh` S1–S5 and
>   `verify-storefront-help` C8c were re-encoded accordingly.
> · `oo-focus-<id>` still exists — it is now the label inside each `oo-biz-<id>`
>   shop chip (clicking it bubbles to the chip and focuses that shop).
> · New: `oo-search-summary`, `oo-search-clear`, `oo-suggest-<category>`,
>   `oo-sold-by-<productId>`, `oo-contact-<productId>`, `oo-call-<productId>`,
>   `oo-wa-<productId>`, `oo-dir-<productId>`, `oo-shop-strip` (+`-name`,
>   `-branch`, `-call`, `-wa`, `-dir`, `-address`, `-all`), `oo-cart-shop`,
>   `oo-lightbox-seller`, `oo-lightbox-shop`, `oo-lightbox-call`,
>   `oo-lightbox-dir`, `oo-ask-<productId>`, `track-seller` (+`-call`, `-wa`,
>   `-dir`, `-order`), `track-item-<n>`, `track-item-link-<n>`,
>   `track-item-sku-<n>`.

## 8·plan (as written before implementation)

| Phase | Scope | Risk |
| --- | --- | --- |
| **P1 — Order page spine** | Search upgrade (fields + result bar + clear + suggestions); category-first default grouping; shop filter control replacing the chip wall; shrink welcome/serve blocks into the filter bar; keep focus mode, `?biz=`, `?p=`, share, QR, cart, checkout and all existing testids. | Medium — the biggest visual change; the catalogue/testids are covered by `verify-orders-maps`, `verify-storefront-areas`, `verify-online-mgmt`, `verify-finance-allproducts-fresh`. |
| **P2 — Product enquiry (pre-order)** | "Sold by <Shop>" block in card + lightbox with Call/WhatsApp/Directions and "Ask about this item"; no server change. | Low. |
| **P3 — Tracking page parity** | Shared customer header + light theme; item rows linked to products; "From <Shop>" seller block with the contact fallback chain; `/api/track` payload additions (`sku`, product href, resolved shop contact) — strictly the order's own shop. | Medium — touches a public endpoint; extend `verify-tracking`, `verify-orders-maps`. |
| **P4 — Consistency & polish** | Vocabulary sweep (customer copy), empty states, mobile sheets, desktop track layout, responsive + a11y pass, extend the regression suites with the new acceptance criteria. | Low. |

**Regression consumers to keep green** (existing testids must survive where possible):
`oo-search`, `oo-cat-*`, `oo-bizrow`, `oo-biz-all`, `oo-biz-<id>`, `oo-focus-<id>`,
`oo-bizsec-*`, `oo-catsec-*`, `oo-add-*`, `oo-plus/minus/qty-*`, `oo-cart*`,
`oo-proceed-checkout`, `oo-place`, `oo-code`, `oo-track-my-order`, `oo-help*`,
`oo-howto*`, `track-*` (input, submit, result, stepper, items, contacts, timeline, qr).
New: `oo-shop-filter`, `oo-search-summary`, `oo-sold-by-<productId>`, `oo-ask-<productId>`, `track-seller`, `track-item-<n>`, `track-item-link-<n>`.

---

## 9. Acceptance criteria (measurable)

1. On a 390×844 phone the **first product is visible within one viewport** (today: 1.97).
2. The catalogue is grouped **by category by default**; the same category from different
   shops appears in one section with per-card shop attribution.
3. The shop control occupies **one row** at every width; the page never scrolls
   horizontally (today the chip row wraps to 472 px and the desktop row overflows by 40 %).
4. Search matches name, category, subcategory, brand, SKU, shop and description, and
   reports `N products · M shops`; a no-match query names at least one available category.
5. Every product card **and** the product lightbox show their selling shop and offer
   Call / WhatsApp / Directions.
6. Every `/track` order shows a **"From <Shop>"** block with at least one working contact
   action whenever the shop has `customerHelpPhone` or `contactPhone` (today: none for
   any of the 8 shops).
7. Every `/track` item links to its product page; when the product is no longer
   available the link degrades to the shop's product list / enquiry action.
8. Both pages share one header, one theme, one vocabulary and one contact model;
   the customer journey is unbroken in both directions.
9. All existing deep links (`?biz=`, `?p=`, `/track?code=`, share links, QR codes)
   keep working, and no permission/tenant-isolation rule changes (public payloads stay
   public-read-only; only the order's own shop is ever exposed).
10. Existing suites stay green: `verify-orders-maps`, `verify-storefront-areas`,
    `verify-online-mgmt`, `verify-tracking`, `verify-customer-360`, plus `verify-responsive`
    (no new horizontal overflow anywhere) — extended with checks 1–8.

---

## 10. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Category-first grouping changes a familiar layout and several testids (`oo-bizsec-*`) | Keep the testids where the DOM still exists; add aliases where it doesn't; update `verify-orders-maps`/`verify-storefront-areas` in the same commit; focused (per-shop) view keeps its current structure. |
| Repeating "Sold by <Shop>" on 100 cards adds noise | One muted line + shop logo only when the shop has one; shop name is a link to focus mode. |
| Removing the chip wall hides "who is selling" | Shop filter with counts + per-card attribution + "Focus shop" in the card menu + group header retained in the focused view. |
| WhatsApp deep links need a WA-capable number | Label "Call / WhatsApp" and always pair the `wa.me` link with `tel:`; the fallback chain guarantees the primary action works. |
| First-paint performance at scale (F12) | Out of scope for P1–P4 but design for it: category sections are independent → later add lazy section rendering / "load more" without changing the structure. |
| Tracking page restyle breaks the existing dark-mode expectations/tests | Restyle in P3 behind visual-regression shots; keep every `track-*` testid and the payload keys unchanged (only additive fields). |

## 11. Deliberately out of scope

- Multi-shop cart / split checkout (option C above).
- Per-shop public storefront URLs and SEO landing pages (option A).
- A real enquiry inbox (a persisted enquiry routed to the shop's Action Center) —
  worth a separate decision; v1 uses tel/WhatsApp/mailto deep links, which need no
  new tables, permissions or notifications.
- Any change to pricing, stock, payment, tracking statuses or permissions.

## 12. Open questions — RESOLVED (implemented per the defaults)

1. **Customer noun** — **"Shop"** on both customer pages (HELP/HOWTO copy, empty
   states, `/track` labels); "Business/Branch/Organization" stays staff-side.
2. **Category-first default** — **implemented**: the all-shops catalogue is grouped by
   category, with every selling shop side by side and per-card "Sold by <Shop>".
3. **Near-me** — **folded into the filter bar** as `Delivering to me (n)` / `All shops (n)`
   / `Clear`, with the GPS + drop-a-pin affordances on the same row.
4. **Tracking page theme** — **unified on the light storefront look** behind the shared
   `CustomerHeader` component (both pages render the same header now).
5. **Programme scope** — **P1–P4 delivered in one programme**, each phase tested before
   the next.
