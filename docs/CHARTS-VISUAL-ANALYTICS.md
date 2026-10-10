# Charts & visual analytics — the global fix, and how to prove it

_One CSS rule was blanking every chart in the app. This is the root cause, the
fix, why the obvious "fixes" don't work, and the suites that stop it coming
back._

---

## 1 · The root cause (one rule, every surface)

GoMina 360 draws its analytics with **Recharts 3**. Recharts 3 measures the
**outer** box (`.recharts-responsive-container`) with a `ResizeObserver` and then
renders this structure:

```html
<div class="recharts-responsive-container" style="width:100%;height:260px">
  <div style="width:0;height:0;overflow:visible">   <!-- deliberate 0×0 -->
    <div class="recharts-wrapper" style="width:866px">
      <svg style="width:100%;height:100%"> … </svg>
```

That **zero-size, `overflow:visible` middle div** is deliberate — it is the
`AutoSizer` trick: the chart must not feed its own size back into the observer
that is measuring it, so it paints by *overflowing* that div.

A global media rule then did this:

```css
.recharts-wrapper { max-width: 100%; }
```

`100%` resolves against the **0-wide** middle div, so **every chart in the
application was clamped to 0 px wide.** The surface `<svg>` is `width:100%` of
the wrapper, so it collapsed with it.

**Why it looked like nothing was wrong:** the DOM was perfectly healthy. The
bars, axes, gridlines, legend and tooltip all still existed, and
`document.querySelectorAll(".recharts-bar-rectangle").length` returned real
numbers. Only the *painted pixels* were gone. That is why the bug read as
"charts aren't loading", "the data is empty", or "it's this one page" — and why
it survived so long: every content-based check passed.

## 2 · The fix

`src/app/globals.css`, chart layer:

```css
.recharts-responsive-container { min-width: 0 !important; max-width: 100%; }
.recharts-wrapper              { max-width: none; }
.recharts-responsive-container > div { max-width: none; }
```

- The **outer** container keeps its anti-spill clamp. Its containing block is a
  real box, so `100%` is the correct ceiling — the page still cannot scroll
  sideways — and `min-width: 0` lets a chart shrink inside a flex/grid cell.
- The **inner wrapper** is left at the pixel width Recharts measured from the
  container. It therefore can never exceed the container and needs no clamp.
- The auto-sizer div stays 0×0, and nothing is allowed to clip its overflow —
  that overflow is the only reason the chart is visible at all.

The rule is a **global** change in one stylesheet, not a per-page patch: no
component, chart or dashboard was edited.

### Why the plausible "fixes" are wrong

| Tempting fix | Why it fails |
|---|---|
| `.recharts-wrapper { width: 100% !important }` | Recharts already sets an explicit pixel width from the observer. Overriding it with `100%` makes the wrapper 100% of the 0-wide auto-sizer — back to zero. |
| Giving the auto-sizer div a height/width | It exists to be 0×0. Sizing it re-creates the ResizeObserver feedback loop that Recharts is avoiding, and charts then fight their container on every resize. |
| Adding `overflow: hidden` to the auto-sizer | Hides the very overflow the chart paints into — 0 px wide again. |
| Wrapping each chart in a new container | A per-page patch: 600+ surfaces to remember, and the next chart added re-inherits the rule. |

## 3 · Proving it

Two suites, deliberately different in kind.

### Geometry — does every chart get real pixels?

```bash
LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-charts.mjs
```

Walks **21 surfaces** (Command Center, Finance, Audit, Payroll, Transactions,
Tracking, Pre-orders, Procurement, Action Center, Employees, Inventory and every
business-type workspace — poultry, block, aqua, livestock, food, tech, car wash,
hardware, boutique), **every in-page sub-tab** it discovers, at **desktop
(1500×950) and mobile (375×780)**, as **four roles** (OWNER, GENERAL_MANAGER,
BRANCH_MANAGER, WORKER) in a separate browser context each.

For each `.recharts-responsive-container` it measures the wrapper's `<svg>` box
and fails on any surface with zero width or height, on any page that scrolls
sideways, and on any uncaught page error.

Two guards keep the result honest:

- a navigation timeout is a **failure**, never a silent skip — otherwise a role
  that never loaded would report "0 broken charts" and look healthy;
- a role measuring **0 charts** is reported alongside its page-load count, so
  "no charts here" can be distinguished from "nothing rendered at all".

> WORKER legitimately measures **0** charts: `WorkerDashboard` is a
> single-branch tool surface with no Recharts import at all. All 40 of its page
> loads still render a real workspace.

### Live data — do the charts actually reflect the numbers?

```bash
LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-charts-live-data.mjs
```

Geometry alone cannot catch a chart that draws the wrong value, so this suite
works backwards from fixtures it creates through the app's own APIs:

- **A · empty → full.** `AQUA-01` ships with no ponds, batches or logs, so its
  charts render bare axes. The suite creates ponds, stocks batches and records
  a dated weight/water series through `/api/aquaculture`, reloads, and asserts
  the charts gained real marks (0 → 29 marks, 0 → 4 bars, 0 → 66,024 px² of bar
  area) and that the screen shows the new ponds. Data unlocks extra analytics
  that were hidden behind the empty state (3 → 8 charts) — the chart *count* is
  allowed to grow; a chart collapsing or disappearing is not.
- **B · more money → bigger bars.** It records a GH₵ 543.21 sale and asserts
  the rendered bars actually change (27,707 → 30,811 px²), that the figure
  appears on the page to the penny, and that the ledger row behind the chart
  holds the same money.

Screenshots land in `reports/screenshots/charts-live/`.

### The static guard

```bash
node dev-tooling/verify-money-notify-coverage.mjs
```

Strips CSS comments, then **rejects any rule whose selector list mentions
`.recharts-wrapper` and carries a `max-width` other than `none`** — including
one added to a selector *group*, which is how this bug came back. (Comments
must be stripped first or the prose in this very rule-set reads as a rule.)
It also asserts the anti-spill clamp is still present, so the fix cannot be
"resolved" by simply deleting the constraint and letting charts spill sideways.

## 4 · Changing charts safely

- **Never add a `max-width`/`width` to `.recharts-wrapper`** or to
  `.recharts-responsive-container > div`.
- To constrain a chart, constrain its **container** (the grid cell or the card),
  not the wrapper.
- After adding a chart to a new screen, run `verify-charts.mjs`; the surface is
  picked up automatically if it is reachable from the sidebar or a tab.