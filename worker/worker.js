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
 * WebTouch (panel emulator) routes:
 *   GET  /webtouch/init           — Start a WebTouch session, returns panel state
 *   POST /webtouch/command        — Send navigation/keypad command
 *   GET  /webtouch/poll           — Poll for display updates
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
const WEBTOUCH_URL = 'https://prm.iaqualink.net/webtouch';

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
    idToken: data.userPoolOAuth?.IdToken || null,
    expiry: Date.now() + 3500 * 1000, // ~58 min
  };

  // Get serial number and device action IDs for the pool system
  const devResp = await fetch(
    `${DEVICES_URL}?api_key=${IAQUALINK_API_KEY}&authentication_token=${session.authToken}&user_id=${session.userId}`,
    { headers: { 'User-Agent': 'okhttp/3.14.7' } }
  );
  const devices = await devResp.json();
  if (devices && devices.length > 0) {
    const dev = devices[0];
    session.serial = dev.serial_number;
    session.deviceId = dev.id;
    session.name = dev.name;
    // Store full device info for WebTouch
    session.device = dev;
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

  // Handle on/off meta-commands
  const onOffMap = {
    pool_pump_on:    { apiCmd: 'set_pool_pump',   key: 'pool_pump',   wantOn: true },
    pool_pump_off:   { apiCmd: 'set_pool_pump',   key: 'pool_pump',   wantOn: false },
    pool_heater_on:  { apiCmd: 'set_pool_heater', key: 'pool_heater', wantOn: true },
    pool_heater_off: { apiCmd: 'set_pool_heater', key: 'pool_heater', wantOn: false },
  };

  // Handle compound speed commands: ensure pump on, then set speed
  const speedMap = { pump_high: 'set_onetouch_3', pump_low: 'set_onetouch_4' };
  if (speedMap[command]) {
    const homeData = await sendCommand(env, 'get_home');
    const home = {};
    if (homeData.home_screen) {
      for (const item of homeData.home_screen) Object.assign(home, item);
    }
    const pumpOn = home.pool_pump === '1' || home.pool_pump === '3';
    if (!pumpOn) {
      await sendCommand(env, 'set_pool_pump', {});
      await new Promise(r => setTimeout(r, 5000));
    }
    // Always fire the speed command — let the controller handle it
    const data = await sendCommand(env, speedMap[command], params);
    return jsonResponse({ ok: true, data }, origin);
  }

  if (onOffMap[command]) {
    const mapped = onOffMap[command];
    const homeData = await sendCommand(env, 'get_home');
    const home = {};
    if (homeData.home_screen) {
      for (const item of homeData.home_screen) Object.assign(home, item);
    }
    const isOn = home[mapped.key] === '1' || home[mapped.key] === '3';
    if (isOn !== mapped.wantOn) {
      const data = await sendCommand(env, mapped.apiCmd, params);
      // Clear speed when pump turns off
      if (command === 'pool_pump_off') {
        await env.POOL_KV.delete('pump_speed');
      }
      return jsonResponse({ ok: true, data, toggled: true }, origin);
    }
    return jsonResponse({ ok: true, data: null, toggled: false, alreadyCorrect: true }, origin);
  }

  // Whitelist allowed commands
  const allowed = [
    'set_pool_pump', 'set_pool_heater',
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

// --- WebTouch Panel Emulator ---

async function handleWebTouchInit(env, origin) {
  try {
  const session = await getSession(env);

  // Clear any existing webtouch session to start fresh
  await env.POOL_KV.delete('webtouch_session');

  // Step 1: Get the v2 session user ID via /userId endpoint
  const v2Headers = {
    'User-Agent': 'Mozilla/5.0',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (session.idToken) {
    v2Headers['Authorization'] = 'Bearer ' + session.idToken;
  }

  const userIdResp = await fetch('https://prm.iaqualink.net/v2/userId', {
    headers: v2Headers,
  });

  let v2SessionId;
  const userIdBody = await userIdResp.text();
  if (userIdResp.ok) {
    try {
      const userIdData = JSON.parse(userIdBody);
      v2SessionId = userIdData.session_user_id || userIdData.sessionId;
    } catch (_) {}
  }

  if (!v2SessionId) {
    return jsonResponse({
      ok: false,
      error: 'Failed to get v2 session user ID',
      debug: { status: userIdResp.status, body: userIdBody.substring(0, 1000) },
    }, origin, 500);
  }

  // Step 2: Get locations with touchLink
  const locResp = await fetch(
    `https://prm.iaqualink.net/v2/users/${v2SessionId}/locations`,
    { headers: v2Headers }
  );

  const locBody = await locResp.text();
  let touchLink = null;
  let locData = null;

  if (locResp.ok) {
    try {
      locData = JSON.parse(locBody);
      // Find our device in the locations array
      const locations = locData.locations || locData;
      if (Array.isArray(locations)) {
        for (const loc of locations) {
          const devices = loc.devices || [];
          for (const dev of devices) {
            if (dev.serial_number === session.serial || dev.id == session.deviceId) {
              touchLink = dev.touchLink || dev.touch_link;
            }
          }
          if (!touchLink && loc.touchLink) touchLink = loc.touchLink;
        }
      }
      if (!touchLink && locData.touchLink) touchLink = locData.touchLink;
    } catch (_) {}
  }

  if (!touchLink) {
    return jsonResponse({
      ok: false,
      error: 'Could not find touchLink in locations API',
      debug: {
        v2SessionId,
        locStatus: locResp.status,
        locBody: locBody.substring(0, 3000),
      },
    }, origin, 500);
  }

  // Step 2: Init WebTouch with the touchLink as actionID
  // Prefer v2 (idToken) auth if available, fallback to v1 (sessionID)
  let initUrl;
  let initHeaders = { 'User-Agent': 'Mozilla/5.0' };
  if (session.idToken) {
    initUrl = `https://prm.iaqualink.net/v2/webtouch/init?actionID=${touchLink}&idToken=${session.idToken}`;
    initHeaders['Authorization'] = session.idToken;
  } else {
    initUrl = `${WEBTOUCH_URL}/init?actionID=${touchLink}&sessionID=${session.sessionId}`;
  }
  const resp = await fetch(initUrl, {
    headers: initHeaders,
    redirect: 'follow',
  });

  const text = await resp.text();

  // Parse the init response — v2 returns JSON
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    // Fallback: try regex for HTML/JS response (v1)
    parsed = {};
    const patterns = {
      systemType: /systemType\s*=\s*['"]?(-?\d+)['"]?/,
      actionIdMasterId: /actionIdMasterId\s*=\s*['"]([^'"]+)['"]/,
      actionIdMasterStart: /actionIdMasterStart\s*=\s*['"]([^'"]+)['"]/,
      actionIdMasterSTB: /actionIdMasterSTB\s*=\s*['"]([^'"]+)['"]/,
      actionIdMasteReset: /actionIdMasteReset\s*=\s*['"]([^'"]+)['"]/,
      serverConnection: /serverConnection\s*=\s*['"]([^'"]+)['"]/,
      deviceLabel: /deviceLabel\s*=\s*['"]([^'"]+)['"]/,
    };
    for (const [key, regex] of Object.entries(patterns)) {
      const m = text.match(regex);
      if (m) parsed[key] = m[1];
    }
  }

  if (!parsed.serverConnection && !parsed.actionIdMasterId) {
    return jsonResponse({
      ok: false,
      error: 'Failed to parse WebTouch init',
      debug: { status: resp.status, body: text.substring(0, 2000) },
    }, origin, 500);
  }

  // Store WebTouch session info for subsequent commands
  const wtSession = {
    masterId: parsed.actionIdMasterId,
    masterStart: parsed.actionIdMasterStart,
    masterSTB: parsed.actionIdMasterSTB,
    masterReset: parsed.actionIdMasteReset,
    serverConnection: parsed.serverConnection,
    systemType: parsed.systemType || 0,
    deviceLabel: parsed.label || parsed.deviceLabel,
    touchLink,
    idToken: session.idToken,
    expiry: Date.now() + 3500 * 1000,
  };

  await env.POOL_KV.put('webtouch_session', JSON.stringify(wtSession), { expirationTtl: 3600 });

  // Fire the "start" command to wake up the panel connection
  // The original WebTouch JS does: ioLinkNL(baseURL + masterStart + '&command=1') after 2.5s delay
  const startUrl = `https://webtouch.iaqualink.net/?actionID=${wtSession.masterStart}&command=1`;
  const startHeaders = { 'User-Agent': 'Mozilla/5.0' };
  if (session.idToken) startHeaders['Authorization'] = 'Bearer ' + session.idToken;

  // Must await — CF Workers cancel pending fetches when response is returned
  try {
    const startResp = await fetch(startUrl, { headers: startHeaders });
    wtSession.startStatus = startResp.status;
  } catch (e) {
    wtSession.startError = e.message;
  }

  return jsonResponse({ ok: true, webtouch: wtSession }, origin);
  } catch (e) {
    return jsonResponse({ ok: false, error: 'WebTouch init failed: ' + e.message, stack: e.stack }, origin, 500);
  }
}

async function getWebTouchSession(env) {
  const cached = await env.POOL_KV.get('webtouch_session', { type: 'json' });
  if (cached && cached.expiry > Date.now()) return cached;
  return null;
}

async function handleWebTouchCommand(env, origin, request) {
  const wt = await getWebTouchSession(env);
  if (!wt) {
    return jsonResponse({ ok: false, error: 'No WebTouch session — call /webtouch/init first' }, origin, 400);
  }

  const body = await request.json();
  const { type, value } = body;
  // type: 'nav' (1-6), 'key' (digit), 'enter', 'back', 'action' (custom actionID)

  // Commands go to the webtouch base with the masterId
  const wtBase = 'https://webtouch.iaqualink.net/';
  let cmdUrl;
  if (type === 'nav') {
    // Navigation: home=1, menu=2, onetouch=3, help=4, back=5, status=6
    cmdUrl = `${wtBase}?actionID=${wt.masterId}&command=${value}`;
  } else if (type === 'key') {
    cmdUrl = `${wtBase}?actionID=${wt.masterId}&command=add_to_telephone&value=${value}`;
  } else if (type === 'enter') {
    cmdUrl = `${wtBase}?actionID=${wt.masterId}&command=enter`;
  } else if (type === 'back') {
    cmdUrl = `${wtBase}?actionID=${wt.masterId}&command=5`;
  } else if (type === 'select') {
    cmdUrl = `${wtBase}?actionID=${wt.masterId}&command=select_${value}`;
  } else {
    return jsonResponse({ ok: false, error: 'Unknown command type' }, origin, 400);
  }

  const cmdHeaders = { 'User-Agent': 'Mozilla/5.0' };
  if (wt.idToken) cmdHeaders['Authorization'] = 'Bearer ' + wt.idToken;

  const resp = await fetch(cmdUrl, {
    headers: cmdHeaders,
    redirect: 'follow',
  });

  const text = await resp.text();
  return jsonResponse({ ok: true, raw: text.substring(0, 5000) }, origin);
}

async function handleWebTouchPoll(env, origin) {
  const wt = await getWebTouchSession(env);
  if (!wt) {
    return jsonResponse({ ok: false, error: 'No WebTouch session — call /webtouch/init first' }, origin, 400);
  }

  if (!wt.serverConnection) {
    return jsonResponse({ ok: false, error: 'No streaming URL in WebTouch session' }, origin, 400);
  }

  // The streaming endpoint is a long-polling chunked response.
  // We fetch it and read the body as a stream, collecting printNL data
  // for up to 25 seconds (within CF Worker's 30s limit).
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 25000);

  try {
    const resp = await fetch(wt.serverConnection, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const lines = [];
    const startTime = Date.now();

    while (true) {
      // Stop after 20s or if we have data and it's been 3s since last chunk
      if (Date.now() - startTime > 20000) break;

      const { done, value } = await Promise.race([
        reader.read(),
        new Promise(resolve => setTimeout(() => resolve({ done: true, value: null, timeout: true }), 5000)),
      ]);

      if (done) break;
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        // Extract printNL calls
        const regex = /parent\.printNL\(([^)]*)\)/g;
        let match;
        while ((match = regex.exec(buffer)) !== null) {
          lines.push(match[1]);
        }
        // If we got printNL data (not just OFFLINE), we can return early
        if (lines.length > 0 && !lines.every(l => l.includes('OFFLINE'))) break;
      }
    }

    clearTimeout(deadline);
    reader.cancel().catch(() => {});

    return jsonResponse({ ok: true, lines }, origin);
  } catch (e) {
    clearTimeout(deadline);
    if (e.name === 'AbortError') {
      return jsonResponse({ ok: true, lines: [] }, origin);
    }
    return jsonResponse({ ok: false, error: e.message }, origin, 500);
  }
}

// --- Cron: Execute Scheduled Commands ---

async function handleScheduledEvent(env) {
  const schedules = await getSchedules(env);
  const now = new Date();
  const currentTime = now.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles', // Central time — adjust if needed
  });
  const currentDay = now.toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'America/Los_Angeles',
  }).toLowerCase();

  for (const sched of schedules) {
    if (!sched.enabled) continue;
    if (sched.time !== currentTime) continue;
    if (sched.days && sched.days.length > 0 && !sched.days.includes(currentDay)) continue;

    try {
      // Handle on/off commands by checking current state first
      const onOffMap = {
        pool_pump_on:    { apiCmd: 'set_pool_pump',   key: 'pool_pump',   wantOn: true },
        pool_pump_off:   { apiCmd: 'set_pool_pump',   key: 'pool_pump',   wantOn: false },
        pool_heater_on:  { apiCmd: 'set_pool_heater', key: 'pool_heater', wantOn: true },
        pool_heater_off: { apiCmd: 'set_pool_heater', key: 'pool_heater', wantOn: false },
      };

      // Compound commands: pump_high / pump_low — ensure pump on, then set speed
      const speedMap = {
        pump_high: 'set_onetouch_3',  // PUMPHIGH
        pump_low:  'set_onetouch_4',  // PUMPLOW
      };

      const speedCmd = speedMap[sched.command];
      if (speedCmd) {
        // Get current state
        const homeData = await sendCommand(env, 'get_home');
        const home = {};
        if (homeData.home_screen) {
          for (const item of homeData.home_screen) Object.assign(home, item);
        }
        const pumpOn = home.pool_pump === '1' || home.pool_pump === '3';

        // If pump is off, turn it on first and wait
        if (!pumpOn) {
          await sendCommand(env, 'set_pool_pump');
          console.log(`[schedule] Pump was off, turning on first...`);
          // Wait for controller to process
          await new Promise(r => setTimeout(r, 5000));
        }

        // Check if the desired speed is already active via OneTouch state
        const otData = await sendCommand(env, 'get_onetouch');
        let alreadyActive = false;
        if (otData.onetouch_screen) {
          for (const item of otData.onetouch_screen) {
            // speedCmd is 'set_onetouch_3' or 'set_onetouch_4'
            const otKey = speedCmd.replace('set_', '');  // 'onetouch_3' or 'onetouch_4'
            if (item[otKey]) {
              const props = {};
              for (const p of item[otKey]) Object.assign(props, p);
              if (props.state === '1') alreadyActive = true;
            }
          }
        }

        if (alreadyActive) {
          console.log(`[schedule] ${speedCmd} already active, skipping`);
        } else {
          await sendCommand(env, speedCmd);
          console.log(`[schedule] Set speed via ${speedCmd}`);
        }

      } else {
        const mapped = onOffMap[sched.command];
        if (mapped) {
          const homeData = await sendCommand(env, 'get_home');
          const home = {};
          if (homeData.home_screen) {
            for (const item of homeData.home_screen) Object.assign(home, item);
          }
          const isOn = home[mapped.key] === '1' || home[mapped.key] === '3';
          if (isOn !== mapped.wantOn) {
            await sendCommand(env, mapped.apiCmd, sched.params || {});
          }
        } else {
          await sendCommand(env, sched.command, sched.params || {});
        }
      }
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
      if (path === '/pool/pump-speed' && request.method === 'GET') {
        const speed = await env.POOL_KV.get('pump_speed');
        return jsonResponse({ ok: true, speed }, validOrigin);
      }
      if (path === '/pool/pump-speed' && request.method === 'POST') {
        const body = await request.json();
        if (body.speed) {
          await env.POOL_KV.put('pump_speed', body.speed);
        } else {
          await env.POOL_KV.delete('pump_speed');
        }
        return jsonResponse({ ok: true }, validOrigin);
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

      // Light effect state (synced across devices)
      if (path === '/pool/light-effect' && request.method === 'GET') {
        const effect = await env.POOL_KV.get('light_effect', { type: 'json' });
        return jsonResponse({ ok: true, effect }, validOrigin);
      }
      if (path === '/pool/light-effect' && request.method === 'POST') {
        const body = await request.json();
        if (body.effect) {
          await env.POOL_KV.put('light_effect', JSON.stringify(body.effect));
        } else {
          await env.POOL_KV.delete('light_effect');
        }
        return jsonResponse({ ok: true }, validOrigin);
      }

      // WebTouch routes
      if (path === '/webtouch/init') {
        return handleWebTouchInit(env, validOrigin);
      }
      if (path === '/webtouch/command' && request.method === 'POST') {
        return handleWebTouchCommand(env, validOrigin, request);
      }
      if (path === '/webtouch/poll') {
        return handleWebTouchPoll(env, validOrigin);
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
