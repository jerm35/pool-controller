# Pool Control — Project Context

> This document provides full context for an AI assistant to understand, modify, and extend this project.

## What This Is

A custom web dashboard for controlling a home swimming pool via the **Jandy iAqualink** cloud API. It replaces the clunky stock iAqualink interface with a mobile-first dark-themed UI.

**Live URL:** https://jerm35.github.io/pool-controller  
**Repo:** https://github.com/jerm35/pool-controller

## The Physical System

- **Controller:** Jandy AqualinkRS (model RS-4, pool only — no spa)
- **Pump:** Variable speed pump controlled via OneTouch presets (not direct RPM)
- **Light:** Jandy LED WaterColors (1 pool light, color type, subtype 4, 14 effects)
- **Heater:** Jandy JXi 400NK gas heater in Remote TSTAT mode, two switchable setpoints (Temp 1 / Temp 2). Single-heater system — only one channel can fire at a time.
- **Auxiliaries:** aux_1 (Pool Light), aux_2 (Heater), aux_3, aux_EA (Extra Aux) — plus many unused aux slots
- **Location:** Vancouver, WA — Pacific timezone (America/Los_Angeles)

## Architecture Overview

Three services work together:

```
┌──────────────────────────────────────┐
│  Frontend (GitHub Pages)             │
│  jerm35.github.io/pool-controller    │
│  HTML + CSS + vanilla JS             │
└────────────┬─────────────┬───────────┘
             │             │
     fetch() │             │ fetch()
             ▼             ▼
┌─────────────────────┐  ┌──────────────────────────┐
│  Cloudflare Worker   │  │  GCP Cloud Run            │
│  pool-controller     │  │  pool-panel-proxy          │
│  .jburnett-589       │  │  us-west1                  │
│  .workers.dev        │  │  .run.app                  │
│                      │  │                            │
│  • API proxy         │  │  • WebTouch auth           │
│  • Smart commands    │  │  • Returns authenticated   │
│  • KV storage        │  │    panel URL               │
│  • Cron scheduler    │  │  • WebSocket (experimental)│
│    (every minute PT) │  │                            │
└──────────┬───────────┘  └────────────┬───────────────┘
           │                           │
           ▼                           ▼
┌──────────────────────────────────────────┐
│  iAqualink Cloud API (Zodiac/Jandy)      │
│                                          │
│  prod.zodiac-io.com     — login          │
│  r-api.iaqualink.net    — device list    │
│  p-api.iaqualink.net    — session cmds   │
│  prm.iaqualink.net/v2   — WebTouch       │
│  webtouch.iaqualink.net — panel stream   │
└──────────────────────────────────────────┘
```

## File Structure

```
pool-controller/
├── index.html                 # Single-page app — 5 tabs: Status, Lights, Speed, Schedule, Panel
├── style.css                  # Dark aquatic theme (CSS variables, mobile-first)
├── app.js                     # All frontend logic (vanilla JS, no framework)
├── worker/
│   ├── worker.js              # Cloudflare Worker — API proxy + scheduler
│   └── wrangler.toml          # Worker config (KV namespace, cron trigger)
├── panel-proxy/
│   ├── server.js              # Cloud Run Node.js service — WebTouch auth proxy
│   ├── Dockerfile             # Container build
│   └── package.json           # Dependencies: ws (WebSocket)
├── .github/workflows/
│   └── deploy.yml             # Auto-deploy to GitHub Pages on push to main
├── README.md                  # Setup docs
└── CONTEXT.md                 # This file
```

## iAqualink API Details

The iAqualink API is **undocumented** and **reverse-engineered** from the Angular app at site.iaqualink.net and community projects.

### Authentication Flow

```
1. POST https://prod.zodiac-io.com/users/v1/login
   Body: { api_key: "EOOEMOW4YR6QNB07", email, password }
   Returns: session_id, authentication_token, userPoolOAuth.IdToken (JWT)

2. GET https://r-api.iaqualink.net/devices.json
      ?api_key=EOOEMOW4YR6QNB07&authentication_token=TOKEN&user_id=ID
   Returns: [{ id, serial_number, name, device_type }]

3. Session commands via:
   GET https://p-api.iaqualink.net/v1/mobile/session.json
       ?actionID=command&command=CMD&serial=SERIAL&sessionID=SESSION
```

### Session Commands

| Command | Parameters | Notes |
|---------|-----------|-------|
| `get_home` | — | Returns pool_pump, pool_temp, air_temp, heater states, setpoints |
| `get_devices` | — | Returns aux devices with state, label, type, subtype |
| `get_onetouch` | — | Returns 6 OneTouch buttons with state and label |
| `set_pool_pump` | — | **Toggle** (not on/off) |
| `set_pool_heater` | — | **Cycles**: Off → Temp1 → Temp2 → Off |
| `set_temps` | temp1, temp2 | Set temperature setpoints |
| `set_light` | aux, light, subtype | Set light brightness or color effect |
| `set_aux_N` | — | Toggle auxiliary device N |
| `set_onetouch_N` | — | **Toggle** OneTouch preset N |

### Critical: Everything Is a Toggle

The iAqualink API has **no explicit on/off commands**. Every command toggles the current state. This caused major issues with scheduling — firing `set_onetouch_3` (PUMPHIGH) when it's already active **turns it off**.

**Solution:** The worker implements smart commands that check state before toggling:

| Smart Command | Behavior |
|--------------|----------|
| `pump_high` | Check pump on → turn on if needed → if PUMPLOW active, deactivate first (2.5s wait) → fire PUMPHIGH OneTouch |
| `pump_low` | Check pump on → turn on if needed → if PUMPHIGH active, deactivate first (2.5s wait) → fire PUMPLOW OneTouch |
| `pool_pump_on` | Check state → only toggle if pump is off |
| `pool_pump_off` | Check state → only toggle if pump is on |
| `pool_heater_on` | Check state → only toggle if heater is off |
| `pool_heater_off` | Check state → only toggle if heater is on |

**The mutual-exclusion fix (critical):** When a speed preset (like PUMPLOW state=1) is active and you fire the *other* speed preset (`set_onetouch_3` for PUMPHIGH), the AqualinkRS ends up with **both** in state=1 and resolves the conflict by reverting to the lower speed. The smart commands now read live OneTouch state via `get_onetouch`, deactivate the conflicting preset first, wait 2.5 seconds, then activate the desired preset. Applies to both manual commands and the cron scheduler.

### WebTouch (Panel) Authentication

The WebTouch panel at webtouch.iaqualink.net is a full GUI panel emulator. Authentication requires a multi-step flow:

```
1. Login (same as above) → get IdToken (JWT)
2. GET https://prm.iaqualink.net/v2/userId
   Header: Authorization: Bearer {IdToken}
   Returns: { session_user_id }

3. GET https://prm.iaqualink.net/v2/users/{session_user_id}/locations
   Header: Authorization: Bearer {IdToken}
   Returns: locations array with device.touchLink

4. GET https://prm.iaqualink.net/v2/webtouch/init?actionID={touchLink}&idToken={jwt}
   Returns: { actionIdMasterId, serverConnection, systemType, ... }
```

The WebTouch protocol uses a complex 3000+ line GUI rendering system with numeric command codes — not simple text. We open it as a popup window rather than trying to reimplement the renderer.

### API Response Formats

**get_home** returns an array of single-key objects:
```json
{ "home_screen": [{"status":"Online"}, {"pool_pump":"1"}, {"pool_temp":"62"}, ...] }
```

**get_devices** returns nested arrays:
```json
{ "devices_screen": [{status}, {response}, {group},
  {"aux_1": [{"state":"0"}, {"label":"Pool Light"}, {"type":"2"}, {"subtype":"4"}]}, ...] }
```

**get_onetouch** returns similar nested structure with state/label per button.

### Heater Behavior (Pool-Only System with Single Heater)

The API uses legacy `spa_*` / `pool_*` field names but iAqualink's UI labels them **opposite** of what the field names suggest. Verified via direct comparison with the official iAqualink mobile app:

| iAqualink UI label | API setpoint field | API heater state field | Toggle command |
|--------------------|--------------------|--------------------------|-----------------|
| **Temp 1** | `spa_set_point` | `spa_heater` | `set_spa_heater` |
| **Temp 2** | `pool_set_point` | `pool_heater` | `set_pool_heater` |

**`set_temps` parameter mapping:** `temp1` param writes `spa_set_point`, `temp2` param writes `pool_set_point` (consistent with the UI labels).

**Heater state values:**
- `"0"` = off / disabled
- `"1"` = enabled and **actively calling for heat** (heater firing)
- `"3"` = enabled but in standby (not currently calling)

**Single-heater system constraint (this system):**
The Jandy JXi 400NK is a single physical heater. Only **one** of `spa_heater` / `pool_heater` can be actively calling for heat at a time. The controller treats them as alternative targets, not simultaneous. Our app implements this as **mutually exclusive toggles** — tapping one auto-disables the other.

**Heater hardware (Jandy JXi specifics):**
- Must be in "REMOTE TSTAT ENABLED" mode for the controller to drive it
- The heater has its own local setpoint that acts as a ceiling — if the controller calls for heat to 90°F but the heater's local setpoint is 85°F, the heater stops at 85°F
- Set the heater's local setpoint **higher than** any controller setpoint you plan to use

**Common gotcha:** Our app showing the 🔥 flame indicator means the controller is calling for heat (state=`1`). It does **not** guarantee the physical heater is actually firing — that depends on the heater's mode, local setpoint, and wiring.

### Pump Speed

The API does **not** return pump RPM or speed. Speed is inferred from which OneTouch button is active:
- `onetouch_3` (PUMPHIGH) state=1 → "High"
- `onetouch_4` (PUMPLOW) state=1 → "Low"
- Neither active → speed unknown

## Cloudflare Worker Details

- **Name:** pool-controller
- **Account:** jburnett-589
- **KV Namespace:** POOL_KV (ID: 2136abf5520f4e30a81ff914ee736f1e)
- **Cron:** `* * * * *` (every minute)
- **Timezone:** America/Los_Angeles (Pacific)
- **Secrets:** IAQUALINK_EMAIL, IAQUALINK_PASSWORD

### KV Storage

| Key | Type | Purpose |
|-----|------|---------|
| `session` | JSON | Cached iAqualink login session (TTL: 1 hour) |
| `schedules` | JSON array | User-created schedules |
| `light_effect` | JSON | Active light color {id, name} — synced across devices |
| `webtouch_session` | JSON | Cached WebTouch session info |

### Schedule Format

```json
{
  "id": "uuid",
  "label": "Pump High",
  "time": "08:00",        // 24-hour format, Pacific time
  "command": "pump_high",  // Smart command name
  "days": ["mon","tue","wed","thu","fri","sat","sun"],
  "enabled": true
}
```

## Cloud Run Details

- **Service:** pool-panel-proxy
- **Project:** ctl-repair-data
- **Region:** us-west1
- **URL:** https://pool-panel-proxy-45970316610.us-west1.run.app
- **Runtime:** Node.js 20
- **Memory:** 256Mi
- **Timeout:** 3600s (1 hour, for WebSocket)
- **Secrets:** IAQUALINK_EMAIL, IAQUALINK_PASSWORD (via GCP Secret Manager)
- **HTTP/2:** Disabled (required for WebSocket upgrade)

## Frontend Details

### Tabs

1. **Status** — Pool temp, air temp (with animated ring), equipment row:
   - **Pool Pump** — shows current speed (High/Low). Tapping opens a **speed picker modal** with all configured OneTouch presets (All Off, CLEAN, PUMPHIGH, PUMPLOW). Active preset highlighted.
   - **Temp 1** and **Temp 2** — independent toggles for the two heat setpoints, **mutually exclusive** (turning one on auto-disables the other since the system has a single physical heater). Shows 🔥 when actively heating. `spa_set_point`/`spa_heater` drives Temp 1; `pool_set_point`/`pool_heater` drives Temp 2.
   - **Freeze Protect** — read-only indicator (no API command to set it; the controller manages this automatically based on air temp threshold)
   - Temperature setpoint +/- controls with 1.2s debounce and edit-lock (auto-refresh won't clobber pending edits while user is tapping +/-)
2. **Lights** — Shows all 14 Jandy WaterColors effects as always-visible grid. Tap to activate. Turn Off button. Active color synced to KV across devices. 3-second cooldown between color changes.
3. **Speed** — OneTouch buttons (All OFF, CLEAN, PUMPHIGH, PUMPLOW). Auxiliary device toggles (filtered to show only active or custom-labeled devices). All OneTouch buttons enforce 30s pump cooldown.
4. **Schedule** — CRUD for cron schedules. Sorted by time. Shows custom OneTouch names. Edit/delete/toggle per schedule. **Bulk button** (left of "+ Add") shows "All Off" when any are enabled, "All On" when all disabled — flips every schedule at once.
5. **Panel** — Opens authenticated WebTouch popup via Cloud Run. No login required.

### Pump Speed Cooldown (30 seconds)

Per Jandy ePump documentation, minimum 30 seconds between speed changes allows the motor to ramp and stabilize, and avoids AqualinkRS controller race conditions.

**Applies to all OneTouch buttons** (All Off, CLEAN, PUMPHIGH, PUMPLOW, etc.) and the Pool Pump button on Status:
- After any pump-related command, a 30s timer starts
- All affected buttons show a live countdown badge (`28s`) and are disabled
- Pump modal shows an orange banner with remaining seconds
- Tapping during cooldown shows a toast warning, no command is sent
- Heater toggles, lights, and aux devices are NOT gated by this cooldown

### Auto-Refresh Behavior

- Every 30 seconds: polls `get_home` for temperature/equipment updates
- After any command: refreshes all data at 2s and 5s delays
- Light effect and pump speed derived from live API data on every refresh
- During setpoint editing: an `edit-lock` prevents the auto-refresh from overwriting in-progress +/- changes

### Cache Busting

JS and CSS referenced with `?v=TIMESTAMP` query params bumped on every deploy. No-cache meta tag. Version indicator shown in header badge (e.g., "Pool v21"). On iOS, the home-screen webapp has its own cache separate from Safari — must remove the home-screen icon and re-add to fully bust.

## Known Limitations

1. **Pump RPM not available** from current API integration — speed shown as High/Low based on OneTouch state
2. **Controller's built-in schedule** not readable via cloud API — only editable through WebTouch panel popup
3. **WebTouch panel** opens as popup (X-Frame-Options blocks iframe embedding)
4. **Light color switching** has 3-second cooldown to prevent controller toggle issues
5. **All commands are toggles** — smart commands mitigate but edge cases may exist if state changes between check and toggle
6. **8 individual VSP speed presets** (Pool Low/High, Speed3-8) — exposed in iAqualink mobile's "Adjust Pump Speeds" but use AWS-signed v2 endpoints (NOT YET IMPLEMENTED — see Future Work below)

## Future Work

### VSP Direct Speed Control (researched but not built)

The user has 8 configured pump speed presets visible in the iAqualink mobile app's "Adjust Pump Speeds" menu. The new mobile app uses AWS-signed v2 endpoints (Cognito identity pool credentials → AWS Sig V4 → API Gateway). We've confirmed `/v2/devices/{serial}/*` endpoints reject Bearer JWT auth and require Sig V4.

**Login response contains everything needed:**
- `userPoolOAuth.IdToken` (JWT) — already used for /v2/users/* endpoints
- `credentials.{AccessKeyId, SecretKey, SessionToken, Expiration, IdentityId}` — temporary AWS credentials for Sig V4 (NOT YET USED)
- `cognitoPool.region` — AWS region for signing

**Recommended research order before going AWS Sig V4:**
1. Try `https://prod.zodiac-io.com/devices/v2/{serial}/{features|shadow|info|site}` with Bearer idToken — these are documented in tekkamanendless/iaqualink Go README and might work without Sig V4
2. Check the AWS IoT shadow approach — `POST /shadow` with `{state: {desired: {pump: {speed: "Pool High"}}}}`
3. As last resort: implement AWS Sig V4 manually in the Cloudflare Worker (no aws-sdk package — Workers don't support it)
4. Alternative path: AWS IoT MQTT via the existing pool-panel-proxy Cloud Run service (Workers can't hold persistent MQTT connections)

**Integration target:** Replace OneTouch-based speed picker modal with real preset buttons (Pool Low @ 1750 RPM, Pool High @ 2750 RPM, etc.). Add to schedule dropdown. Keep OneTouch as fallback.

**Don't break:** The current `pump_high`/`pump_low` smart commands with mutex fix work and should remain.

## Deployment

- **Frontend:** Push to `main` → GitHub Actions → GitHub Pages (auto)
- **Worker:** `cd worker && wrangler deploy`
- **Cloud Run:** `cd panel-proxy && gcloud run deploy pool-panel-proxy --source . ...`
