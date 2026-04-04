# Pool Control

Custom iAqualink pool management dashboard. Connects to Jandy AqualinkRS pool controllers via the iAqualink cloud API through a Cloudflare Worker proxy.

## Features

- Real-time pool/spa/air temperature monitoring
- Equipment toggles (pumps, heaters, freeze protection)
- Light control with brightness and color effects
- OneTouch quick-action buttons (pump speed presets)
- Visual scheduler with Cloudflare Worker cron execution
- Mobile-first dark theme

## Architecture

```
Browser (jerm35.github.io/pool-controller)
    ↓ fetch()
Cloudflare Worker (pool-controller.jburnett-589.workers.dev)
    ├── /auth/login     → Zodiac login API
    ├── /pool/home      → iAqualink session API (get_home)
    ├── /pool/devices   → iAqualink session API (get_devices)
    ├── /pool/onetouch  → iAqualink session API (get_onetouch)
    ├── /pool/command   → iAqualink session API (set_*)
    ├── /pool/schedules → Cloudflare KV storage
    └── Cron trigger    → executes scheduled commands every minute
```

## Setup

### Cloudflare Worker

1. Create a KV namespace: `wrangler kv namespace create POOL_KV`
2. Update `worker/wrangler.toml` with the KV namespace ID
3. Set secrets:
   ```bash
   cd worker
   wrangler secret put IAQUALINK_EMAIL
   wrangler secret put IAQUALINK_PASSWORD
   ```
4. Deploy: `wrangler deploy`

### Frontend

Deployed automatically via GitHub Pages on push to `main`.
