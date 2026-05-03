# Pool Control

Custom iAqualink pool management dashboard for Jandy AqualinkRS controllers. Mobile-first dark theme with real-time status, light control, pump speed scheduling, and remote panel access.

**Live:** https://jerm35.github.io/pool-controller

## Features

- **Status** — Pool/air temperature, animated temperature ring, Pool Pump button (tap → speed picker modal with all OneTouch presets), Temp 1 and Temp 2 heater toggles (mutually exclusive — single-heater system), 🔥 indicator when heater is actively firing, freeze protection indicator, +/- temperature setpoint controls with edit-lock
- **Lights** — Jandy LED WaterColors with all 14 color effects, always-visible grid, tap to activate, active color synced across devices via KV, 3-second cooldown between color changes
- **Speed** — OneTouch quick-action buttons (PUMPHIGH, PUMPLOW, CLEAN, All OFF), auxiliary device toggles (filtered to active/labeled only). 30-second pump cooldown enforced.
- **Schedule** — Visual scheduler with Pump High/Low speed commands, Pump On/Off, Heater On/Off, OneTouch presets. Sorted by time. Bulk **All On / All Off** button. Custom OneTouch labels shown. Edit/delete/toggle per schedule. Runs on Cloudflare Worker cron (every minute, Pacific time)
- **Panel** — Opens the full AqualinkRS WebTouch remote panel via Cloud Run (auto-authenticated, no login required). View/edit controller schedules, individual pump speed presets (Pool Low/High, Speed3-8, etc.), OneTouch configuration, and diagnostics

## Smart Behaviors

- **Pump speed mutual exclusion** — When switching between PUMPHIGH and PUMPLOW, the worker deactivates the conflicting preset first (with 2.5s wait) before activating the new one. Prevents the AqualinkRS from reverting to the lower speed when both end up "active."
- **Heater mutual exclusion** — Single-heater systems can only fire one channel at a time, so toggling one Temp button auto-disables the other.
- **30-second pump cooldown** — Per Jandy ePump spec, prevents rapid speed changes that confuse the controller. All OneTouch buttons disable with live countdown badge.
- **Setpoint edit lock** — Auto-refresh skips temperature setpoint values for 8 seconds after user edits, so +/- taps aren't clobbered mid-edit.
- **Stateful commands** — `pump_high`, `pump_low`, `pool_pump_on/off`, `pool_heater_on/off` check current state via the API before sending toggles, avoiding "already correct → toggled off" issues.

## Architecture

```
Browser (jerm35.github.io/pool-controller)
    │
    ├── fetch() ──→ Cloudflare Worker (pool-controller.jburnett-589.workers.dev)
    │                 ├── /auth/login        → Zodiac login API (prod.zodiac-io.com)
    │                 ├── /pool/home         → iAqualink session API (get_home)
    │                 ├── /pool/devices      → iAqualink session API (get_devices)
    │                 ├── /pool/onetouch     → iAqualink session API (get_onetouch)
    │                 ├── /pool/command      → iAqualink session API (set_*)
    │                 ├── /pool/pump-speed   → KV read/write pump speed state
    │                 ├── /pool/light-effect → KV read/write active light color
    │                 ├── /pool/schedules    → KV CRUD for custom schedules
    │                 └── Cron (* * * * *)   → executes scheduled commands every minute (PT)
    │
    └── fetch() ──→ Cloud Run (pool-panel-proxy-45970316610.us-west1.run.app)
                      ├── /health            → health check
                      ├── /panel-url         → returns authenticated WebTouch URL
                      └── /ws               → WebSocket proxy for panel streaming (experimental)
```

## Smart Commands

The worker provides state-aware commands that prevent toggle issues:

| Command | Behavior |
|---------|----------|
| `pump_high` | Ensures pump is on, then fires PUMPHIGH OneTouch |
| `pump_low` | Ensures pump is on, then fires PUMPLOW OneTouch |
| `pool_pump_on` | Checks state, only toggles if pump is off |
| `pool_pump_off` | Checks state, only toggles if pump is on |
| `pool_heater_on` | Checks state, only toggles if heater is off |
| `pool_heater_off` | Checks state, only toggles if heater is on |

The cron scheduler checks live OneTouch API state before firing speed commands to avoid toggling off an already-active speed preset.

## iAqualink API Reference

### Authentication
1. `POST https://prod.zodiac-io.com/users/v1/login` — returns `session_id`, `authentication_token`, `userPoolOAuth.IdToken`
2. `GET https://r-api.iaqualink.net/devices.json` — returns device list with serial numbers
3. Session commands: `GET https://p-api.iaqualink.net/v1/mobile/session.json?actionID=command&command=CMD&serial=SN&sessionID=SID`

### WebTouch (Panel) Authentication
1. `GET https://prm.iaqualink.net/v2/userId` (Bearer idToken) — returns `session_user_id`
2. `GET https://prm.iaqualink.net/v2/users/{session_user_id}/locations` (Bearer idToken) — returns `touchLink`
3. `GET https://prm.iaqualink.net/v2/webtouch/init?actionID={touchLink}&idToken={jwt}` — returns streaming session

### API Key
- `EOOEMOW4YR6QNB07` (constant, used in all iAqualink API calls)

## Setup

### Cloudflare Worker

```bash
cd worker
wrangler kv namespace create POOL_KV
# Update worker/wrangler.toml with the KV namespace ID
wrangler secret put IAQUALINK_EMAIL
wrangler secret put IAQUALINK_PASSWORD
wrangler deploy
```

### Cloud Run (Panel Proxy)

```bash
cd panel-proxy
gcloud run deploy pool-panel-proxy \
  --source . \
  --region us-west1 \
  --allow-unauthenticated \
  --port 8080 \
  --min-instances 0 \
  --max-instances 2 \
  --memory 256Mi \
  --timeout 3600 \
  --session-affinity \
  --no-use-http2 \
  --update-secrets="IAQUALINK_EMAIL=IAQUALINK_EMAIL:latest,IAQUALINK_PASSWORD=IAQUALINK_PASSWORD:latest"
```

GCP secrets:
```bash
echo -n "your@email.com" | gcloud secrets versions add IAQUALINK_EMAIL --data-file=-
echo -n "yourpassword" | gcloud secrets versions add IAQUALINK_PASSWORD --data-file=-
```

### Frontend

Deployed automatically via GitHub Pages on push to `main`.

## Project Structure

```
pool-controller/
├── index.html              # Dashboard HTML
├── style.css               # Dark aquatic theme
├── app.js                  # Frontend logic
├── worker/
│   ├── worker.js           # Cloudflare Worker (API proxy + cron scheduler)
│   └── wrangler.toml       # Worker config
├── panel-proxy/
│   ├── server.js           # Cloud Run service (WebTouch auth + WebSocket)
│   ├── Dockerfile
│   └── package.json
└── .github/workflows/
    └── deploy.yml          # GitHub Pages deployment
```

## Pool System Details

- **Controller:** Jandy AqualinkRS (RS-4, pool only, no spa)
- **Pump:** Variable speed with PUMPHIGH and PUMPLOW OneTouch presets
- **Light:** Jandy LED WaterColors (subtype 4, 14 color effects)
- **Heater:** Pool heater with Temp 1 (85°F) and Temp 2 (40°F) setpoints
- **Timezone:** Pacific (America/Los_Angeles)
