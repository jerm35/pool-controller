/**
 * Pool Panel Proxy — Cloud Run Service
 *
 * Maintains a persistent connection to iAqualink WebTouch and relays
 * panel display updates + commands over WebSocket to the browser.
 *
 * Flow:
 *   1. Browser connects via WebSocket to /ws
 *   2. Server authenticates with iAqualink, gets WebTouch session
 *   3. Server opens persistent HTTP stream to WebTouch serverConnection
 *   4. Panel display updates (printNL) are parsed and sent to browser
 *   5. Browser sends commands (nav, key, enter) which server forwards to WebTouch
 *
 * Environment:
 *   IAQUALINK_EMAIL    — iAqualink account email
 *   IAQUALINK_PASSWORD — iAqualink account password
 *   PORT               — HTTP port (default 8080)
 */

const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;
const IAQUALINK_API_KEY = 'EOOEMOW4YR6QNB07';
const ZODIAC_LOGIN_URL = 'https://prod.zodiac-io.com/users/v1/login';
const DEVICES_URL = 'https://r-api.iaqualink.net/devices.json';

const ALLOWED_ORIGINS = [
  'https://jerm35.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
];

// --- iAqualink Auth ---

let cachedSession = null;

async function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/json',
        ...options.headers,
      },
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function getSession() {
  if (cachedSession && cachedSession.expiry > Date.now()) {
    return cachedSession;
  }

  console.log('[auth] Logging in to iAqualink...');
  const loginData = await fetchJSON(ZODIAC_LOGIN_URL, {
    method: 'POST',
    body: JSON.stringify({
      api_key: IAQUALINK_API_KEY,
      email: process.env.IAQUALINK_EMAIL,
      password: process.env.IAQUALINK_PASSWORD,
    }),
  });

  const session = {
    sessionId: loginData.session_id || loginData.authentication_token,
    authToken: loginData.authentication_token,
    userId: loginData.id || loginData.user_id,
    idToken: loginData.userPoolOAuth?.IdToken || null,
    expiry: Date.now() + 3500 * 1000,
  };

  // Get device info
  const devUrl = `${DEVICES_URL}?api_key=${IAQUALINK_API_KEY}&authentication_token=${session.authToken}&user_id=${session.userId}`;
  const devices = await fetchJSON(devUrl);
  if (devices && devices.length > 0) {
    session.serial = devices[0].serial_number;
    session.deviceId = devices[0].id;
    session.name = devices[0].name;
  }

  cachedSession = session;
  console.log('[auth] Logged in as', session.name, session.serial);
  return session;
}

async function getWebTouchSession(session) {
  // Step 1: Get v2 session user ID
  const v2Headers = {
    'User-Agent': 'Mozilla/5.0',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (session.idToken) {
    v2Headers['Authorization'] = 'Bearer ' + session.idToken;
  }

  const userIdData = await fetchJSON('https://prm.iaqualink.net/v2/userId', {
    headers: v2Headers,
  });
  const v2SessionId = userIdData.session_user_id || userIdData.sessionId;
  if (!v2SessionId) throw new Error('Failed to get v2 session ID');

  // Step 2: Get locations with touchLink
  const locData = await fetchJSON(
    `https://prm.iaqualink.net/v2/users/${v2SessionId}/locations`,
    { headers: v2Headers }
  );

  let touchLink = null;
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
  if (!touchLink) throw new Error('No touchLink found');

  // Step 3: Init WebTouch
  const initUrl = `https://prm.iaqualink.net/v2/webtouch/init?actionID=${touchLink}&idToken=${session.idToken}`;
  const wtData = await fetchJSON(initUrl, {
    headers: { ...v2Headers, 'Authorization': 'Bearer ' + session.idToken },
  });

  if (!wtData.actionIdMasterId) throw new Error('WebTouch init failed');

  // Step 4: Fire start command
  const startUrl = `https://webtouch.iaqualink.net/?actionID=${wtData.actionIdMasterStart}&command=1`;
  await fetchJSON(startUrl, { headers: v2Headers });

  return {
    masterId: wtData.actionIdMasterId,
    masterStart: wtData.actionIdMasterStart,
    serverConnection: wtData.serverConnection,
    label: wtData.label,
    idToken: session.idToken,
    touchLink,
  };
}

// --- WebTouch Stream Reader ---

function connectToStream(streamUrl, onData, onEnd) {
  console.log('[stream] Connecting to', streamUrl.substring(0, 60) + '...');

  const parsed = new URL(streamUrl);
  const req = https.request({
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }, (res) => {
    let buffer = '';

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      // Extract printNL calls
      const regex = /parent\.printNL\(([^)]*)\)/g;
      let match;
      while ((match = regex.exec(buffer)) !== null) {
        onData(match[1]);
      }
      // Keep only the last partial chunk
      const lastScript = buffer.lastIndexOf('<script');
      if (lastScript > 0) {
        buffer = buffer.substring(lastScript);
      }
    });

    res.on('end', () => {
      console.log('[stream] Connection ended');
      onEnd();
    });

    res.on('error', (e) => {
      console.error('[stream] Error:', e.message);
      onEnd();
    });
  });

  req.on('error', (e) => {
    console.error('[stream] Request error:', e.message);
    onEnd();
  });

  req.end();
  return req;
}

// --- Send WebTouch Command ---

function sendWtCommand(masterId, command, idToken) {
  const cmdUrl = `https://webtouch.iaqualink.net/?actionID=${masterId}&command=${command}`;
  const parsed = new URL(cmdUrl);
  const req = https.request({
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Authorization': 'Bearer ' + idToken,
    },
  }, (res) => {
    res.resume(); // drain response
  });
  req.on('error', () => {});
  req.end();
}

// --- WebSocket Handler ---

function handleWebSocket(ws, req) {
  const origin = req.headers.origin || '';
  if (!ALLOWED_ORIGINS.includes(origin)) {
    console.log('[ws] Rejected origin:', origin);
    ws.close(4003, 'Forbidden');
    return;
  }

  console.log('[ws] Client connected from', origin);
  let wtSession = null;
  let streamReq = null;
  let reconnecting = false;

  async function startSession() {
    try {
      ws.send(JSON.stringify({ type: 'status', message: 'Authenticating...' }));
      const session = await getSession();

      ws.send(JSON.stringify({ type: 'status', message: 'Connecting to panel...' }));
      wtSession = await getWebTouchSession(session);

      ws.send(JSON.stringify({ type: 'connected', label: wtSession.label }));

      // Start stream
      connectStream();
    } catch (e) {
      console.error('[ws] Init error:', e.message);
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  }

  function connectStream() {
    if (!wtSession) return;

    streamReq = connectToStream(
      wtSession.serverConnection,
      // onData — parse and send display lines
      (printNLArgs) => {
        const parts = [];
        const strRegex = /'([^']*)'/g;
        let m;
        while ((m = strRegex.exec(printNLArgs)) !== null) {
          parts.push(m[1]);
        }
        if (parts.length > 0) {
          ws.send(JSON.stringify({ type: 'display', lines: parts }));
        }
      },
      // onEnd — reconnect stream
      () => {
        if (ws.readyState === ws.OPEN && !reconnecting) {
          reconnecting = true;
          console.log('[stream] Reconnecting in 2s...');
          setTimeout(() => {
            reconnecting = false;
            if (ws.readyState === ws.OPEN) connectStream();
          }, 2000);
        }
      }
    );
  }

  // Handle commands from browser
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (!wtSession) return;

      let command;
      if (msg.type === 'nav') {
        command = msg.value; // 1-6
      } else if (msg.type === 'key') {
        command = `add_to_telephone&value=${msg.value}`;
      } else if (msg.type === 'enter') {
        command = 'enter';
      } else if (msg.type === 'back') {
        command = '5';
      }

      if (command) {
        sendWtCommand(wtSession.masterId, command, wtSession.idToken);
      }
    } catch (e) {
      console.error('[ws] Message error:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[ws] Client disconnected');
    if (streamReq) {
      streamReq.destroy();
      streamReq = null;
    }
  });

  startSession();
}

// --- HTTP Server ---

const server = http.createServer(async (req, res) => {
  // CORS headers
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Proxy the WebTouch page — serves it from our origin so no X-Frame-Options block
  if (req.url === '/panel') {
    try {
      const session = await getSession();
      const wt = await getWebTouchSession(session);
      const wtUrl = `https://webtouch.iaqualink.net/?actionID=${wt.touchLink}&idToken=${session.idToken}`;
      // Redirect to the WebTouch URL (for popup use)
      res.writeHead(302, { Location: wtUrl });
      res.end();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Get a panel URL for iframe embedding — returns the authenticated URL
  if (req.url === '/panel-url') {
    try {
      const session = await getSession();
      const wt = await getWebTouchSession(session);
      const wtUrl = `https://webtouch.iaqualink.net/?actionID=${wt.touchLink}&idToken=${session.idToken}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: wtUrl }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// WebSocket server — handle upgrade manually for Cloud Run compatibility
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', handleWebSocket);

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[server] Pool Panel Proxy listening on port ${PORT}`);
});
