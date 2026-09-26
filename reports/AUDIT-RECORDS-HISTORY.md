# Audit & Review → Records: Today / History split

**Date:** 2026-09-26 · **Component:** `src/components/AuditCommandCenter.tsx` ·
**Verification:** `dev-tooling/verify-audit-history.mjs` (21/21 green, phone + desktop)

## The problem

The Records tab loaded the newest 250 records of the whole audit universe and
rendered them in one flat list. On a day-to-day basis an auditor only needs
**today's** activity, but months of older records drowned it out.

## The behavior now

| Section | What it shows | Default |
|---|---|---|
| **Today's activities** (📅 CalendarClock header) | Every record whose `date` is the current local day, newest first | **Always visible — the default view** |
| **History / Previous records** (collapsible, History icon chevron) | Everything older, in the same card/table layout as before | **Collapsed** — one tap to open, one to hide |

* **Nothing is deleted and nothing is hidden from reach.** The History toggle
  shows a live count (`N records`) of everything older that matches the current
  filters; opening it renders every one of them with the full audit action set.
* **The search box and every filter above the list govern BOTH sections** —
  e.g. searching an old transaction's number finds it inside History while
  Today correctly shows "no records".
* **Load older records** — the API caps each `/api/audit` response at 250
  records. With History open, a "Load older records (previous 250)" button
  appears whenever more history exists for the current filters; it pages
  backwards through time (each request passes `to=<oldest date loaded>`, which
  the API applies inclusively) until an "End of history for these filters"
  note appears. Before this change, records beyond the first 250 were simply
  unreachable from the UI.
* Changing any filter/resetting the list resets the incremental paging state
  so History always reflects the active filter set.
* Both layouts (wide table at `lg+`, cards below) render inside BOTH sections,
  so phone, tablet and desktop all get the split.

## Implementation notes

* `todaysRecords` / `historyRecords` are derived from the same payload
  (`r.date.slice(0,10)` vs the browser's local day via
  `toLocaleDateString("en-CA")`), deduped by record key.
* `loadOlderRecords()` re-fetches `/api/audit` with the current filters plus
  `to=<oldest history date>` and appends the non-today batch; a batch shorter
  than 250 marks the end (`olderDone`).
* New testids: `aud-today-section`, `aud-today-count`, `aud-history-section`,
  `aud-history-toggle`, `aud-history-count`, `aud-history-body`,
  `aud-history-load-more`, `aud-history-end`. All pre-existing testids
  (`aud-rec-row-*`, `aud-f-*`, …) are unchanged.

## Verification — `verify-audit-history.mjs` (21 checks)

Seeds a today-dated transaction, ones dated 3 and 40 days back, plus a
260-row older batch, then on phone 375px and desktop 1440px:

H1–H3 today section renders, count, all rows dated today · H4–H6 History
collapsed by default with a live count, old fixtures absent while collapsed ·
H7–H9 opening History reveals old fixtures, no today records inside, no
duplicates · H10–H11 search narrows History and empties Today · H12 type
filter applies to both sections · H13–H14 load-more pages through the
250-cap until the end-of-history note (all 260+ old rows reachable) · H15–H16
collapse hides rows again, no overflow · H17–H20 desktop: classic tables in
both sections · H21 zero page errors. Every seeded row is purged afterwards.

**Known API characteristic (pre-existing, unchanged):** each source table is
fetched with its own id-window (e.g. newest 240 transactions) as a performance
guard; the audit universe the API exposes is fully reachable through the new
paging.
