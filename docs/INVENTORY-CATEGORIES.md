# Standard inventory categories — one taxonomy across every GoMina 360 business

_Implemented 2026-10-02 · branch `arena/01a0fecd-gomina360-app-v1-1`_

## Why

Each branch used to type its own Category / Type on stock-in (“Men’s Shirts”,
“Ladies’ Dresses”, “Concrete Blocks”, “Fresh Aquaculture”, “Solar & Energy”…).
On the customer marketplace those wordings became separate category chips, so
similar products from different businesses never appeared together.

Now **one standard umbrella category is stored for every inventory row** and the
branch’s own wording is kept beside it as an optional **subcategory**. On the
marketplace, selecting a category (e.g. *Fashion & Clothing*) shows every
product from **all eligible businesses** in that category.

Nothing is deleted or rewritten without a trace: the original wording is either
already the standard name or is stored verbatim in `inventory_items.subcategory`.

## Where the taxonomy lives

`src/lib/inventoryCategories.ts` — the single source of truth:

* `INVENTORY_CATEGORIES` — 19 umbrella categories, each with suggested
  subcategories:
  Computers & Electronics · Fashion & Clothing · Food & Beverages ·
  Poultry & Eggs · Fish & Seafood · Livestock & Meat · Building Materials ·
  Hardware & Tools · Automotive & Vehicle Care · Household & Home Appliances ·
  Beauty & Personal Care · Agriculture & Farm Supplies · Health & Pharmacy ·
  Baby, Kids & Toys · Sports, Leisure & Outdoors · Stationery & Office Supplies ·
  Industrial & Workshop Equipment · Pet Supplies · Other / General Merchandise
* `normalizeInventoryCategory(raw)` — maps any legacy/unknown wording to a
  standard category (exact name → known subcategory → alias → keyword →
  “Other / General Merchandise”). "Poultry Products" → *Poultry & Eggs*,
  "Solar & Energy" → *Computers & Electronics*, "Concrete Blocks" →
  *Building Materials*, "Ladies' Dresses" → *Fashion & Clothing*.
* `deriveInventorySubcategory(rawCategory, rawSubcategory)` — keeps the specific
  wording (existing subcategory first, then the alias, then the free text).
* `normalizeInventoryItem(row)` — read-path helper (category + subcategory).
* `subcategoriesOf(category)`, `STANDARD_INVENTORY_CATEGORIES`,
  `INVENTORY_CATEGORY_SUGGESTIONS` (flat list for the quick-add forms of the
  individual business modules).

## Where it is enforced

| Layer | File | What it does |
| --- | --- | --- |
| Add Stock Item / Edit modal | `src/components/InventoryCategoryFields.tsx` | Category is a **select of the standard list**; subcategory is a select of that category’s subcategories (or free text via “Other…”). An old free-text subcategory is offered as an option so opening a record never rewrites it. |
| Shared inventory API | `src/app/api/enterprise/route.ts` | POST + PATCH normalize `category` and preserve the wording as `subcategory`. |
| Every module stock-in | `src/lib/stock.ts` (`ensureInventoryItem`) | Normalizes at creation — poultry harvest, block production, feed mill, etc. |
| New business starter kits | `src/lib/businessProvisioning.ts` | Opening stock lands in the taxonomy from day one. |
| Business backup/restore | `src/lib/businessBackup.ts` | Restored stock is normalized and keeps its subcategory. |
| Marketplace | `src/app/api/menu/route.ts` | Reports the standard `category` + `subcategory` (cache key bumped to `init:menu:v2`). |
| App bootstrap | `src/lib/initSnapshot.ts` | Read-time guard so lists/filters are standard even before the backfill runs. |
| Module quick-add forms | Hardware, Electronics, Block Factory, Business dashboard | Category suggestions are the standard list (free text still allowed; the API normalizes it). |
| Storefront | `src/app/order/page.tsx` | Category chips are the standard categories (cross-business); the branch wording shows as a subcategory chip on the card. |
| Login page | `src/components/LoginScreen.tsx` | Tagline now reads “Enterprise Command Center”. |

## The one-time data migration

`dev-tooling/migrate-production-schema.mjs` (runs automatically on
`npm run build` → `npm run db:migrate`, before `next build`):

1. adds `inventory_items.subcategory` (`text`, nullable — additive, no rewrite);
2. for every row whose `category` is not standard, sets
   `category = normalizeInventoryCategory(category)` and
   `subcategory = deriveInventorySubcategory(category, subcategory)`
   (the original wording is preserved);
3. is idempotent — a second run reports 0 changes.

Fresh installs never need it: the seed (`src/db/seed.ts`, boutique + flagship
catalogue) writes standard categories and subcategories directly.

## Tests

`dev-tooling/verify-categories.mjs` — 30 checks, all passing:

```
bash dev-tooling/run-suite.sh dev-tooling/verify-categories.mjs
```

* every stored category is a standard category (no stragglers);
* no row lost its original wording (it is the category or the subcategory);
* legacy wording through the real POST/PATCH API → standard umbrella +
  preserved subcategory;
* two different businesses with different wording land in ONE umbrella;
* `/api/menu` serves only standard categories and shows products from ≥ 2
  businesses under *Fashion & Clothing*;
* the Add Stock Item form offers all 19 categories and the subcategory list
  follows the selected category;
* the storefront category chip filters the whole marketplace to that category,
  and shows the branch wording as a subcategory chip;
* login page shows “Enterprise Command Center” and no longer “Ghana …”;
* test rows purged; zero page errors.

Regression suites run after the change: `verify-boutique` (74/74),
`verify-boutique-ui` (40/40), `verify-inventory-ui`, `verify-order-page-regression`,
`verify-storefront-areas`, `verify-responsive` — see the task report.

## Notes / limits

* Keyword matching is deliberately conservative; anything unrecognised lands in
  *Other / General Merchandise* with the original text kept as its subcategory
  (never lost, and re-mappable later by extending the alias table).
* The navbar badge (“Ghana Enterprise Command Center”, shown only on very wide
  screens in the app header) was left unchanged — the request scoped the wording
  change to the login page.
