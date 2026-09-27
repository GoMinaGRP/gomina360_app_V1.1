# Audit & Review → Records: 7-day day-grouping + History

**Date:** 2026-09-26 · **Components:** `src/components/AuditCommandCenter.tsx`,
`src/app/api/audit/route.ts` · **Verification:** `dev-tooling/verify-audit-history.mjs`
(38/38 green — phone + desktop + emulated non-UTC viewer, production build)

## The behavior

| Zone | What it shows | Default |
|---|---|---|
| **Today** | Today's records, **newest activity first**, each with a **date + time stamp** (`2026-09-26 · 15:40`) | **Expanded** |
| **Yesterday + each previous date** (up to 7 days) | One collapsible group per day (`Wed 23 Sep 2026`), newest day first, newest activity first within the day, time stamp on every record | **Collapsed** — each day toggles independently |
| **History / Previous records** (collapsible) | Everything older than 7 days, same card/table layouts, full audit action set | **Collapsed** — one tap to open |

* **Nothing is deleted and nothing is hidden from reach.** The History toggle
  shows a live count of every older record matching the current filters;
  opening it renders them all.
* **Search + every filter govern both zones** — searching an old record's
  number surfaces it inside History while the day groups correctly show
  "no activities in the last 7 days".
* **Load older records** — the API caps each `/api/audit` response at 250
  records; with History open, "Load older records (previous 250)" pages
  backwards (each request passes `to=<oldest date loaded>`, inclusive) until
  "End of history for these filters" appears.
* Both layouts (wide table at `lg+`, cards below) render inside every day
  group and History, so phone, tablet and desktop all get the grouping.

## Collapsible day groups (2026-09-26, third pass)

Only **Today** starts expanded. **Yesterday and every other previous date**
are collapsible headers (CalendarClock icon + day label + live record count
+ Show/Hide) and each toggles **independently** — collapsing Today leaves
Yesterday open, and a day's choice survives filter changes. Ordering is
untouched: newest day first, newest activity first within each day, date +
time stamps on every record, and all filters/search still govern every
group plus History.

## Time stamps — where the time comes from

The Records list previously only had a day per record. `/api/audit` now
returns `at` — the exact event timestamp (ISO) — for every source that has
one: transactions (`created_at`), inventory (`registered_at`), assets
(`recorded_at`), CCTV, payroll runs, attendance, checklists (`completed_at`),
feed-mill/QC batches (`created_at` / `tested_at`), asset activities, employee
history, deletions and access activities.

**Honesty rule:** `at` is only set when the timestamp falls on the *same
calendar day* as the record's business date — a backdated transaction created
today never shows a misleading time; date-only sources (hire dates, livestock/
restaurant/electronics/car-wash shift logs without a timestamp column) show
the bare date. Sorting inside a day: `at` descending, then record id.

## Verification — `verify-audit-history.mjs` (28 checks)

Seeds transactions with **exact clock times** (today 09:15 + 15:40,
yesterday 11:22, 3 days ago 08:05, 8 days ago, 40 days ago) plus a 260-row
older batch, then on phone 390px and desktop 1440px:

G1–G4 Today / Yesterday / 3-days-ago groups render; no group for 8-days-ago ·
G5 within Today the 15:40 record renders above the 09:15 one · G6 day groups
ordered newest day first · G7–G10 stamps show `HH:MM` on the fixtures and on
every transaction row in the day groups · G11–G15 History collapsed by
default with a live count, 8-day fixture absent from the day groups,
revealed on open, no 7-day records inside · G16–G17 search finds the 40-day
fixture in History and empties the day groups · G18 type filter applies to
both zones · G19–G20 load-more pages through the 250-cap to the end ·
G21–G22 collapse + no phone overflow · G23–G27 desktop: classic tables in
the day groups and History, time stamp in the table row, 40-day fixture
reachable via load-more · G28 zero page errors. All seeded rows are purged.

**Known API characteristic (pre-existing, unchanged):** each source table is
fetched with its own id-window (e.g. newest 240 transactions) as a
performance guard; everything the API exposes is reachable through the
paging.

## Cross-check follow-up (2026-09-26, second pass)

**Reported:** only "Today" and "Older than 7 Days" were visible. **Finding:**
the grouping logic was correct, but the freshly recovered demo database had
records ONLY for today (everything is created at recovery time) — zero rows
dated 1–6 days ago, so those day groups correctly rendered as nothing. Two
fixes landed:

1. **Viewer-timezone coherence (real bug, edge hours).** Day grouping used
   the records' date strings, which are UTC-derived for timestamp-backed
   sources — so a viewer far from UTC could see records group under the
   wrong day near midnight. Records that carry an exact event timestamp
   (`at`) now group by the **viewer's local day** of that timestamp, and the
   stamps show local day + local time; business-date records (plain text
   dates) keep their date. Verified with a new America/Regina (UTC-6)
   emulated section: fixtures group by the local day, stamps read 03:15 /
   09:40, every record's stamp date matches its group, and no record leaks
   between the 7-day zone and History.
2. **Demo data gap.** `dev-tooling/seed-recent-demo.mjs` (idempotent, wired
   into `recover.sh`) now populates each of the last 7 days with realistic
   activity — 3 finance records + 2 completed checklist tasks per day with
   varied clock times — so Today, Yesterday and every previous date show
   content on a freshly recovered database.

`verify-audit-history.mjs` grew to **38 checks** (G1–G28 + C1–C4 collapse checks + T0–T4 timezone checks + G24b).

## Recovery hardening (found while re-verifying)

A full sandbox rebuild (fresh DB reseed) left `suppliers.owner_id` NULL,
which made the per-organization supplier/customer detail check in
`/api/audit` 403 for scoped auditors (`verify-audit-records` S7). Fixed by
running the idempotent `dev-tooling/migrate-multiowner.mjs` tenant backfill
after reseed — and `dev-tooling/recover.sh` now runs it automatically as
part of recovery.
