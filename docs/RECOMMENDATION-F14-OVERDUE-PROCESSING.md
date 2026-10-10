# F‑14 — Assessment & Recommendation: processing overdue Action Center activities automatically

**Status: ASSESSMENT ONLY — nothing implemented.** The request was to evaluate F‑14 and recommend an approach.
**Date:** 2026-10-09

---

## 1 · What F‑14 is

From `docs/AUDIT-BELL-NOTIFICATIONS.md` (severity recorded as **INFO**, "known characteristic"):

> `escalateOverdueTasks` is reached only through `runDailyOps`, triggered by `/api/init`'s daily TTL or
> `/api/cron/daily`. No one opens the app → no escalation. Reasonable for this architecture, but it means "overdue" is
> a function of app traffic, not of the calendar.

F‑14 is therefore **not a bug**. The escalation code is correct, the dedupe is correct, and the bell rows it produces
are correct. The only issue is **when the sweep runs**.

---

## 2 · Current state — the infrastructure already exists

This is the single most important fact for the decision, and it was not obvious from the audit:

| Component | State | File |
|---|---|---|
| Cron entry | ✅ **already present** — `{"path":"/api/cron/daily","schedule":"0 6 * * *"}` | `vercel.json` |
| Cron route | ✅ `GET` + `POST`, `export const dynamic = "force-dynamic"` | `src/app/api/cron/daily/route.ts` |
| Auth | ✅ `Authorization: Bearer $CRON_SECRET`, **or** an OWNER/GM/Super-Admin session (manual "run it now") | same |
| Fail-closed | ✅ a previous spoofable `x-vercel-cron` header path was **removed**; unauthenticated callers get 401 with an actionable hint naming `CRON_SECRET` when unset on Vercel | same |
| Idempotency | ✅ DB marker `daily-ops:<date>` checked before the run, set after all 18 steps | `src/lib/dailyOps.ts:262,358` |
| Per-step idempotency | ✅ low-stock per item, dunning per sale+stage, escalation per `task:<id>:overdue:<step>` and `issue-overdue:<id>:<step>` | `src/lib/actionCenter.ts`, `src/lib/dailyOps.ts` |
| Response hygiene | ✅ counts only, never per-user identifiers | `src/app/api/cron/daily/route.ts` |
| Fallback | ⚠️ `/api/init` fires the same pipeline **un-awaited** on the first authenticated request of the day | `src/app/api/init/route.ts:176-183` |

So the escalation machinery is complete and production-shaped. **The only open questions are operational, not
architectural.**

### 2.1 Two things that are not yet true

**(a) `CRON_SECRET` may not be set on the Vercel project.** This is an environment fact, not a code fact — it cannot
be read from the repository, and the Vercel CLI is not linked here. If it is unset, Vercel Cron sends no
`Authorization` header, the route's bearer branch is skipped, the session branch does not apply to a machine request,
and **the 06:00 UTC fire returns 401**. The app would silently keep working *only* because `/api/init` still pulls —
so the failure is invisible until you look for it. This is the highest-value thing to check, and it is a 60-second
check in the Vercel dashboard → Project → Settings → Environment Variables.

**(b) The `/api/init` fallback is unreliable on serverless.** It calls `runDailyOps` without `await`:

```ts
import("@/lib/dailyOps").then((m) => m.runDailyOps({ source: "init" })).catch(…)
```

On Vercel the function returns as soon as the response is sent, and an in-flight promise may be frozen or discarded.
The result is that the fallback is *probabilistic* — it usually appears to work, which is exactly what makes it a bad
safety net. It should not be relied on as the primary guarantee.

---

## 3 · Constraints imposed by the actual deployment

| Constraint | Consequence |
|---|---|
| Vercel Cron fires **only on production deployments**, never previews | the sweep cannot be exercised by opening a preview URL |
| Vercel Cron issues a **`GET`**, with `x-vercel-cron-schedule` and a `vercel-cron/1.0` UA | the route already exports `GET` ✅ |
| **`CRON_SECRET`** is sent automatically as `Authorization: Bearer <secret>` once the env var exists; ≥16 random chars recommended | the route's primary branch is the documented pattern ✅ |
| **Cron duration = function `maxDuration`.** No `maxDuration` is exported anywhere in this repo | the plan default applies (60s on Pro, 10–60s elsewhere). 18 sequential steps, each doing DB work, must fit inside it |
| **No retries.** Vercel will not re-invoke a failed cron | one failure = one missed day. The `daily-ops:<date>` marker makes a manual re-run safe, but nothing does it automatically |
| **Hobby: 2 cron jobs/project, once per day, fire time is somewhere inside the scheduled hour.** Pro: 40 (100 on current pricing), any cron expression | at `0 6 * * *` the true fire time is between 06:00:00 and 06:59:59 **UTC** on Hobby. 06:00 UTC = 06:00 Ghana (GMT, no DST), so this is the right hour — but not the right *minute* |
| Region is pinned to **`fra1`** (Frankfurt) | ~5–8 ms to Neon `eu-central`/`eu-west`, fine. If the Neon project is in `us-east`, every step pays ~140 ms — see §5 |
| Neon pooling | `src/db/index.ts` already detects pooled endpoints (`-pooler`, port 6543, `pgbouncer=`, `channel_binding=require`) and sizes the client pool accordingly; the pool is lazy and process-global. **The DB layer needs no change for a cron sweep.** |

---

## 4 · Recommendation

### Adopt the Vercel Cron path that is already wired — and close the two gaps. Do not add a second scheduler.

**This is the safest and most efficient option, and it is also the smallest.** Adding an external scheduler
(Cronitor, GitHub Actions, Upstash QStash, a pg_cron-style addon) would introduce a new credential, a new failure
domain, and a new network path to Neon, to solve a problem that one environment variable and one `export` already
solve. The route, the auth model, the fail-closed behaviour, the idempotency marker and the per-step idempotency are
all done and verified.

#### Step 1 — Set `CRON_SECRET` (blocking, ~2 minutes)

Vercel → Project → Settings → Environment Variables → add `CRON_SECRET`, a random string ≥16 chars, **Production**
scope. Redeploy. Until this exists the cron fire returns 401 and nothing tells you.

#### Step 2 — Export an explicit `maxDuration` on the cron route

```ts
// src/app/api/cron/daily/route.ts
export const maxDuration = 60;   // or 300 on Pro, matched to the plan
```

Do not leave this implicit. The sweep has 18 sequential steps and a cold start; if it overruns, Vercel kills it
mid-run. Because the marker is only written on success, a killed run is *safe* (it re-runs next day) but it *does*
lose that day.

#### Step 3 — Make the schedule decision explicit

| Plan | Recommendation |
|---|---|
| **Pro** | Keep `0 6 * * *`, or move to `0 6,18 * * *` if a second daily sweep is wanted. Minute-accurate. |
| **Hobby** | Keep `0 6 * * *` — one daily sweep is exactly what the cap allows. Expect the fire anywhere in 06:00–06:59 UTC. Do not try to schedule sub-daily; deployment will be rejected. |

Daily cadence is genuinely the right frequency here: every escalation tier in `runDailyOps` is **step-based**
(`d1` within 7 days, then `w<n>` per week; `issue-overdue:<id>:<step>`). Nothing in the pipeline is
sub-day-sensitive, so paying Pro for hourly crons would buy nothing.

#### Step 4 — Keep `/api/init` as a *fallback*, but stop relying on it as one

Leave the call in place — it is harmless and it keeps non-Vercel deployments working — but either `await` it or
accept explicitly that it is best-effort. The architecture should not have two paths that both look primary.

#### Step 5 — Add an observability signal (recommended, not required)

Vercel does not retry and does not alert. The cheapest reliable signal, given no external service is wanted:

- write a `system_markers` row per run (`daily-ops:<date>` already does this — it stores `<source>@<iso>`), and
- surface "last successful sweep" on `/api/health`, so an operator sees a stale date without opening logs.

This turns an invisible failure into a visible one, which is the real gap in the current design.

---

## 5 · Alternatives considered and rejected

| Option | Why not |
|---|---|
| **External scheduler** (Cronitor / GitHub Actions / QStash) | New credential + new failure domain + a second path into Neon, to replace a cron entry that already exists and works. Only justified if the plan cap or the missing retry semantics became a real constraint. |
| **pg_cron on Neon** | Neon does not run `pg_cron`. Would need an external trigger anyway — i.e. the external-scheduler option with extra steps. |
| **Neon scheduled queries / triggers** | Correct tool for *reactive* work (escalate the instant a row goes overdue). Here the work is inherently calendar-based — sweep what is overdue *today* — so it would need a trigger per overdue-row transition and would still miss anything that happened while nothing was connected. Higher complexity, worse fit. |
| **Client-side `setInterval`** | Only runs while a browser tab is open — strictly worse than the current pull model. |
| **Keep `/api/init` only** | The status quo. It is exactly what F‑14 describes: overdue is a function of traffic. It is also *un-awaited*, so it is not even reliably a function of traffic. |
| **Increase cron frequency (hourly)** | Buys nothing — escalation steps are day/week granular — and on Hobby it is a deploy-time rejection. |

---

## 6 · If the plan is Pro and scale grows

Only when the daily sweep stops fitting in one invocation: split by step family into separate routes
(`/api/cron/stock`, `/api/cron/escalation`, `/api/cron/dunning`), each with its own marker, so a timeout in one does
not take the others down with it. The marker architecture already supports this — it is per-`markerKey`, not
per-pipeline. Do not do this pre-emptively.

---

## 7 · Bottom line

> **F‑14 is ~90% already solved.** A Vercel Cron is configured, the route is written, it authenticates by the
> documented mechanism, it fails closed, and the pipeline is idempotent under re-run. The remaining work is
> **setting `CRON_SECRET`**, **exporting an explicit `maxDuration`**, and **making the sweep date observable**.
> Do not build a new scheduler.

**Nothing in this document has been implemented**, per the instruction to assess and recommend only.