/**
 * iAqualink Pool Proxy — Cloudflare Worker
 *
 * Routes:
 *   POST /auth/login              — Login to iAqualink, returns session info
 *   GET  /pool/home               — Pool status (temps, pumps, heaters)
 *   GET  /pool/devices            — All auxiliary devices
 *   GET  /pool/onetouch           — OneTouch button states
 *   POST /pool/command            — Send a command (set_pool_pump, set_light, etc.)
 *   GET  /pool/schedules          — Get stored schedules from KV
 *   POST /pool/schedules          — Save a schedule to KV
 *   DELETE /pool/schedules/:id    — Delete a schedule from KV
 *
 * Cron trigger runs every minute to check & execute scheduled commands.
 *
 * Secrets:
 *   IAQUALINK_EMAIL    — iAqualink account email
 *   IAQUALINK_PASSWORD — iAqualink account password
 *
 * KV Namespace:
 *   POOL_KV — stores schedules and cached session
 */

const IAQUALINK_API_KEY = 'EOOEMOW4YR6QNB07';
const ZODIAC_LOGIN_URL = 'https://prod.zodiac-io.com/users/v1/login';
const DEVICES_URL = 'https://r-api.iaqualink.net/devices.json';
const SESSION_URL = 'https://p-api.iaqualink.net/v1/mobile/session.json';

const ALLOWED_ORIGINS = [
  'https://jerm35.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, origin, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

// --- iAqualink Auth ---

async function getSession(env) {
  // Check KV cache first
  const cached = await env.POOL_KV.get('session', { type: 'json' });
  if (cached && cached.expiry > Date.now()) {
    return cached;
  }

  // Login fresh
  const resp = await fetch(ZODIAC_LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: IAQUALINK_API_KEY,
      email: env.IAQUALINK_EMAIL,
      password: env.IAQUALINK_PASSWORD,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Login failed: ${resp.status}`);
  }

  const data = await resp.json();
  const session = {
    sessionId: data.session_id || data.authentication_token,
    authToken: data.authentication_token,
    userId: data.id || data.user_id,
    expiry: Date.now() + 3500 * 1000, // ~58 min
  };

  // Get serial number for the pool system
  const devResp = await fetch(
    `${DEVICES_URL}?api_key=${IAQUALINK_API_KEY}&authentication_token=${session.authToken}&user_id=${session.userId}`,
    { headers: { 'User-Agent': 'okhttp/3.14.7' } }
  );
  const devices = await devResp.json();
  if (devices && devices.length > 0) {
    session.serial = devices[0].serial_number;
    session.deviceId = devices[0].id;
    session.name = devices[0].name;
  }

  await env.POOL_KV.put('session', JSON.stringify(session), { expirationTtl: 3600 });
  return session;
}

async function sendCommand(env, command, extraParams = {}) {
  const session = await getSession(env);
  const params = new URLSearchParams({
    actionID: 'command',
    command,
    serial: session.serial,
    sessionID: session.sessionId,
    ...extraParams,
  });
  const resp = await fetch(`${SESSION_URL}?${params}`, {
    headers: { 'User-Agent': 'okhttp/3.14.7' },
  });
  return resp.json();
}

// --- Route Handlers ---

async function handleLogin(env, origin) {
  try {
    const session = await getSession(env);
    return jsonResponse({
      ok: true,
      name: session.name,
      serial: session.serial,
    }, origin);
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, origin, 401);
  }
}

async function handleHome(env, origin) {
  const data = await sendCommand(env, 'get_home');
  // Flatten the array-of-objects response
  const home = {};
  if (data.home_screen) {
    for (const item of data.home_screen) {
      Object.assign(home, item);
    }
  }
  return jsonResponse({ ok: true, data: home }, origin);
}

async function handleDevices(env, origin) {
  const data = await sendCommand(env, 'get_devices');
  // Parse devices_screen into usable format
  const devices = [];
  if (data.devices_screen) {
    for (const item of data.devices_screen.slice(3)) {
      const key = Object.keys(item)[0];
      if (key && Array.isArray(item[key])) {
        const dev = { id: key };
        for (const prop of item[key]) {
          Object.assign(dev, prop);
        }
        devices.push(dev);
      }
    }
  }
  return jsonResponse({ ok: true, devices }, origin);
}

async function handleOneTouch(env, origin) {
  const data = await sendCommand(env, 'get_onetouch');
  return jsonResponse({ ok: true, data: data.onetouch_screen || data }, origin);
}

async function handleCommand(env, origin, request) {
  const body = await request.json();
  const { command, params = {} } = body;

  if (!command) {
    return jsonResponse({ ok: false, error: 'Missing command' }, origin, 400);
  }

  // Whitelist allowed commands
  const allowed = [
    'set_pool_pump', 'set_spa_pump',
    'set_pool_heater', 'set_spa_heater', 'set_solar_heater',
    'set_temps', 'set_light',
    /^set_aux_/,  /^set_onetouch_/,
  ];
  const isAllowed = allowed.some(a =>
    a instanceof RegExp ? a.test(command) : a === command
  );
  if (!isAllowed) {
    return jsonResponse({ ok: false, error: 'Command not allowed' }, origin, 403);
  }

  const data = await sendCommand(env, command, params);
  return jsonResponse({ ok: true, data }, origin);
}

// --- Schedule Management ---

async function getSchedules(env) {
  const data = await env.POOL_KV.get('schedules', { type: 'json' });
  return data || [];
}

async function handleGetSchedules(env, origin) {
  const schedules = await getSchedules(env);
  return jsonResponse({ ok: true, schedules }, origin);
}

async function handleSaveSchedule(env, origin, request) {
  const schedule = await request.json();
  if (!schedule.time || !schedule.command) {
    return jsonResponse({ ok: false, error: 'Missing time or command' }, origin, 400);
  }
  schedule.id = schedule.id || crypto.randomUUID();
  schedule.enabled = schedule.enabled !== false;

  const schedules = await getSchedules(env);
  const idx = schedules.findIndex(s => s.id === schedule.id);
  if (idx >= 0) {
    schedules[idx] = schedule;
  } else {
    schedules.push(schedule);
  }
  await env.POOL_KV.put('schedules', JSON.stringify(schedules));
  return jsonResponse({ ok: true, schedule }, origin);
}

async function handleDeleteSchedule(env, origin, id) {
  const schedules = await getSchedules(env);
  const filtered = schedules.filter(s => s.id !== id);
  await env.POOL_KV.put('schedules', JSON.stringify(filtered));
  return jsonResponse({ ok: true }, origin);
}

// --- Cron: Execute Scheduled Commands ---

async function handleScheduledEvent(env) {
  const schedules = await getSchedules(env);
  const now = new Date();
  const currentTime = now.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Chicago', // Central time — adjust if needed
  });
  const currentDay = now.toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'America/Chicago',
  }).toLowerCase();

  for (const sched of schedules) {
    if (!sched.enabled) continue;
    if (sched.time !== currentTime) continue;
    if (sched.days && sched.days.length > 0 && !sched.days.includes(currentDay)) continue;

    try {
      await sendCommand(env, sched.command, sched.params || {});
      console.log(`Executed schedule: ${sched.label || sched.command} at ${currentTime}`);
    } catch (e) {
      console.error(`Schedule failed: ${sched.id}`, e.message);
    }
  }
}

// --- Main Handler ---

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const validOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(validOrigin) });
    }

    // Origin check (skip for cron/internal)
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const path = url.pathname;

      if (path === '/auth/login' && request.method === 'POST') {
        return handleLogin(env, validOrigin);
      }
      if (path === '/pool/home') {
        return handleHome(env, validOrigin);
      }
      if (path === '/pool/devices') {
        return handleDevices(env, validOrigin);
      }
      if (path === '/pool/onetouch') {
        return handleOneTouch(env, validOrigin);
      }
      if (path === '/pool/command' && request.method === 'POST') {
        return handleCommand(env, validOrigin, request);
      }
      if (path === '/pool/schedules' && request.method === 'GET') {
        return handleGetSchedules(env, validOrigin);
      }
      if (path === '/pool/schedules' && request.method === 'POST') {
        return handleSaveSchedule(env, validOrigin, request);
      }
      if (path.startsWith('/pool/schedules/') && request.method === 'DELETE') {
        const id = path.split('/').pop();
        return handleDeleteSchedule(env, validOrigin, id);
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders(validOrigin) });
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, validOrigin, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledEvent(env));
  },
};
