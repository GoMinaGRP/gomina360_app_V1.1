# GoMina 360 — Sandbox Recovery Kit

The Arena sandbox can be reset by the platform; when that happens the local
Postgres database and running processes vanish. **All code lives in git**, so
nothing is ever lost permanently. To bring the full live app back:

```bash
git fetch origin arena/01a07f36-gomina360-app-v1-1 && git reset FETCH_HEAD
printf 'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db\n' > .env
bash dev-tooling/recover.sh
```

The branch above is this repo's current session branch. Arena names one branch
per session, so if this document outlives the session it was written in, replace
it with the session branch that holds the newest commit
(`git ls-remote --heads origin` lists them all).

Earlier revisions of this section said `arena/01a00bff-gomina360-app-v1`. That
branch belongs to the previous `GoMinaGRP/gomina360_app_V1` repository, which is
superseded by this one (`gomina360_app_V1.1`); it does not exist on this remote,
so fetching it here fails.

Then verify everything (real headless-browser E2E, cleans up after itself):

```bash
LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-live.mjs
```

## What each piece does

| File | Purpose |
|---|---|
| `start-pg.mjs` | Workspace-local PostgreSQL 18 on 127.0.0.1:5432 (data in `/home/user/pgtooling/pgdata`) |
| `q.mjs` | `node dev-tooling/q.mjs "<sql>"` — ad-hoc SQL / forensics |
| `extract-chromium.mjs` | Unpacks headless Chromium to `/tmp/al2023` for browser tests |
| `restore-userdata.mjs` | Replays the owner's Payroll & Audit activity (4 paid runs incl. OT/allowance composition, finance transactions, Emmanuel's auditor grant) through the app's own APIs. Idempotent. |
| `verify-live.mjs` | Full issue-workflow E2E (checklist review → flag+photo → dashboard routing → 5-stage pipeline → verify/close) + restored-state regression + TEST-data purge + DB forensics |
| `verify-audit-history.mjs` | Audit & Review → Records declutter E2E: today-only default view, collapsible History section, search/filters governing both, load-more paging through the 250-record API cap, phone + desktop layouts |
| `verify-responsive-deep.mjs` | Deep mobile/tablet sweep: every nav surface × every in-page tab at 375px/768px — no document overflow, no clipped interactive controls (env: `VIEWPORTS`, `ROLES`) |
| `verify-responsive-modals.mjs` | Modal sweep at 375px/768px: opens every modal/drawer on every surface, checks fit + clipped controls + that it closes again (env: `VIEWPORTS`, `ROLES`) |
| `recover.sh` | The orchestrator above |

Credentials used by the scripts are the seeded demo accounts
(`kwame.owner@gomina360.com`, password via `GOMINA_OWNER_PW`, default
`Owner@GoMina26`).
