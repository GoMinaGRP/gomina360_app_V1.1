# GoMina 360 — Sandbox Recovery Kit

The Arena sandbox can be reset by the platform; when that happens the local
Postgres database and running processes vanish. **All code lives in git**, so
nothing is ever lost permanently. To bring the full live app back:

```bash
git fetch origin arena/01a00bff-gomina360-app-v1 && git reset FETCH_HEAD
printf 'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db\n' > .env
bash dev-tooling/recover.sh
```

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
| `recover.sh` | The orchestrator above |

Credentials used by the scripts are the seeded demo accounts
(`kwame.owner@gomina360.com`, password via `GOMINA_OWNER_PW`, default
`Owner@GoMina26`).
