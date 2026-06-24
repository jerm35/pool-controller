# CLAUDE.md

Guidance for working in this repo. **Read [CONTEXT.md](CONTEXT.md) for full detail** — the
architecture, the reverse-engineered iAqualink API, heater field mapping, smart commands, and
the deferred VSP research all live there. This file is just the must-not-forget conventions.

## What this is

Custom iAqualink pool dashboard for a Jandy AqualinkRS (pool-only). Vanilla JS frontend (no
framework) on GitHub Pages, a Cloudflare Worker (API proxy + KV + cron scheduler), and a Cloud
Run panel proxy. See CONTEXT.md → "Architecture Overview".

## Three deploy targets — they deploy DIFFERENTLY

| Part | Files | How it deploys |
|------|-------|----------------|
| Frontend | `index.html`, `app.js`, `style.css` | **Auto** — push to `main` → GitHub Actions → Pages |
| Worker | `worker/worker.js` | **Manual** — `cd worker && wrangler deploy` |
| Panel proxy | `panel-proxy/server.js` | **Manual** — `gcloud run deploy` (see README) |

**If you change `worker/worker.js`, a `git push` is NOT enough — you must `wrangler deploy`
separately**, or the live behavior won't match the code. This is the easiest mistake to make.

## On every frontend change (required ritual)

1. Bump `APP_VERSION` in `app.js` (e.g. `v27` → `v28`).
2. Bump the `?v=TIMESTAMP` on BOTH the `style.css` and `app.js` tags in `index.html` (use `date +%s`).
3. The header badge shows the version (e.g. "Pool v28") — that's how the user confirms the live
   app updated. iOS home-screen webapp caches separately from Safari; a full close/reopen (or
   delete + re-add the icon) may be needed to bust it.

## Smart commands (worker) — everything in the iAqualink API is a TOGGLE

There are no explicit on/off commands upstream. The worker wraps them with state-aware commands
(`pump_high`, `pump_low`, `pool_pump_on/off`, `pool_heater_on/off`, `pool_light_off`) that read
live state first so a toggle never lands wrong. **The cron handler (`handleScheduledEvent`)
duplicates this routing** — if you add a smart command usable in schedules, add a branch there
too, not just in `handleCommand`. See CONTEXT.md → "Critical: Everything Is a Toggle".

## Keep docs in sync

When behavior changes, update **README.md** (user-facing features + smart-command table) and
**CONTEXT.md** (the deep reference). The user expects changes committed, pushed, worker deployed,
and docs current.

## Don't redo

The VSP direct-RPM research is settled — every Worker-reachable path is IAM-blocked. Don't retry
it; `pump_high`/`pump_low` are the canonical pump-speed mechanism. Details in CONTEXT.md →
"Future Work".
