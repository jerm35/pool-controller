/**
 * Pool Control — iAqualink Dashboard
 * Communicates through Cloudflare Worker proxy
 */

// ---- Configuration ----
const API_BASE = 'https://pool-controller.jburnett-589.workers.dev';

// Light effect maps by subtype
const LIGHT_EFFECTS = {
  // subtype 1: Jandy Colors
  1: {
    name: 'Jandy Colors',
    effects: [
      { id: 1, name: 'Alpine White' },
      { id: 2, name: 'Sky Blue' },
      { id: 3, name: 'Cobalt Blue' },
      { id: 4, name: 'Caribbean Blue' },
      { id: 5, name: 'Spring Green' },
      { id: 6, name: 'Emerald Green' },
      { id: 7, name: 'Emerald Rose' },
      { id: 8, name: 'Magenta' },
      { id: 9, name: 'Garnet Red' },
      { id: 10, name: 'Violet' },
      { id: 11, name: 'Color Splash' },
      { id: 12, name: 'Color Roll' },
    ],
  },
  // subtype 2: Pentair SAm/SAL
  2: {
    name: 'Pentair SAm/SAL',
    effects: [
      { id: 1, name: 'White' },
      { id: 2, name: 'Light Green' },
      { id: 3, name: 'Green' },
      { id: 4, name: 'Cyan' },
      { id: 5, name: 'Blue' },
      { id: 6, name: 'Lavender' },
      { id: 7, name: 'Magenta' },
      { id: 8, name: 'Light Magenta' },
      { id: 9, name: 'Color Splash' },
    ],
  },
  // subtype 3: Pentair ColorLogic
  3: {
    name: 'Pentair ColorLogic',
    effects: [
      { id: 1, name: 'Voodoo Lounge' },
      { id: 2, name: 'Deep Blue Sea' },
      { id: 3, name: 'Afternoon Skies' },
      { id: 4, name: 'Emerald' },
      { id: 5, name: 'Sangria' },
      { id: 6, name: 'Cloud White' },
      { id: 7, name: 'Twilight' },
      { id: 8, name: 'Tranquility' },
      { id: 9, name: 'Gemstone' },
      { id: 10, name: 'USA' },
      { id: 11, name: 'Mardi Gras' },
      { id: 12, name: 'Cool Cabaret' },
    ],
  },
  // subtype 4: Jandy LED WaterColors
  4: {
    name: 'Jandy LED WaterColors',
    effects: [
      { id: 1, name: 'Alpine White' },
      { id: 2, name: 'Sky Blue' },
      { id: 3, name: 'Cobalt Blue' },
      { id: 4, name: 'Caribbean Blue' },
      { id: 5, name: 'Spring Green' },
      { id: 6, name: 'Emerald Green' },
      { id: 7, name: 'Emerald Rose' },
      { id: 8, name: 'Magenta' },
      { id: 9, name: 'Garnet Red' },
      { id: 10, name: 'Violet' },
      { id: 11, name: 'Color Splash' },
      { id: 12, name: 'Color Roll' },
      { id: 13, name: 'Glimmer' },
      { id: 14, name: 'Party Mode' },
    ],
  },
  // subtype 5: Pentair Intellibrite
  5: {
    name: 'Pentair Intellibrite',
    effects: [
      { id: 1, name: 'SAm' },
      { id: 2, name: 'Party' },
      { id: 3, name: 'Romance' },
      { id: 4, name: 'Caribbean' },
      { id: 5, name: 'American' },
      { id: 6, name: 'Cal Sunset' },
      { id: 7, name: 'Royal' },
      { id: 8, name: 'Blue' },
      { id: 9, name: 'Green' },
      { id: 10, name: 'Red' },
      { id: 11, name: 'White' },
      { id: 12, name: 'Magenta' },
    ],
  },
  // subtype 6: Hayward Universal
  6: {
    name: 'Hayward Universal',
    effects: [
      { id: 1, name: 'Voodoo Lounge' },
      { id: 2, name: 'Deep Blue Sea' },
      { id: 3, name: 'Afternoon Skies' },
      { id: 4, name: 'Emerald' },
      { id: 5, name: 'Sangria' },
      { id: 6, name: 'Cloud White' },
      { id: 7, name: 'Twilight' },
      { id: 8, name: 'Tranquility' },
      { id: 9, name: 'Gemstone' },
      { id: 10, name: 'USA' },
      { id: 11, name: 'Mardi Gras' },
      { id: 12, name: 'Cool Cabaret' },
    ],
  },
};

const COMMAND_LABELS = {
  pool_pump_on: 'Pump On',
  pool_pump_off: 'Pump Off',
  pool_heater_on: 'Heater On',
  pool_heater_off: 'Heater Off',
  set_onetouch_2: 'OneTouch 2',
  set_onetouch_3: 'OneTouch 3',
  set_onetouch_4: 'OneTouch 4',
  set_onetouch_5: 'OneTouch 5',
  set_onetouch_6: 'OneTouch 6',
};

const DAY_NAMES = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

// ---- State ----
let state = {
  home: {},
  devices: [],
  onetouch: [],
  schedules: [],
  temp1: 85,
  temp2: 40,
  selectedLight: null,
};

// ---- API Helpers ----
async function api(path, options = {}) {
  const resp = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    mode: 'cors',
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`API ${resp.status}: ${text || resp.statusText}`);
  }
  return resp.json();
}

function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ---- Connection ----
async function connect() {
  const overlay = document.getElementById('connect-overlay');
  const dashboard = document.getElementById('dashboard');
  const errorEl = document.getElementById('connect-error');
  const retryBtn = document.getElementById('retry-btn');

  errorEl.hidden = true;
  retryBtn.hidden = true;

  try {
    const loginResp = await api('/auth/login', { method: 'POST' });
    if (!loginResp.ok) throw new Error(loginResp.error || 'Login failed');

    document.getElementById('system-name').textContent = loginResp.name || loginResp.serial;

    // Load all data — don't let individual failures block the dashboard
    const results = await Promise.allSettled([loadHome(), loadDevices(), loadOneTouch(), loadSchedules()]);
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.warn(`Load ${i} failed:`, r.reason);
    });

    overlay.hidden = true;
    dashboard.hidden = false;
  } catch (e) {
    console.error('Connect error:', e);
    errorEl.textContent = e.message;
    errorEl.hidden = false;
    retryBtn.hidden = false;
    document.querySelector('.loader').style.display = 'none';
  }
}

// ---- Data Loading ----
async function loadHome() {
  const resp = await api('/pool/home');
  if (resp.ok) {
    state.home = resp.data;
    renderStatus();
  }
}

async function loadDevices() {
  const resp = await api('/pool/devices');
  if (resp.ok) {
    state.devices = resp.devices;
    renderDevices();
    renderLights();
    renderAuxDevices();
  }
}

async function loadOneTouch() {
  const resp = await api('/pool/onetouch');
  if (resp.ok) {
    state.onetouch = resp.data || [];
    renderOneTouch();
  }
}

async function loadSchedules() {
  const resp = await api('/pool/schedules');
  if (resp.ok) {
    state.schedules = resp.schedules;
    renderSchedules();
  }
}

async function refreshAll() {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  try {
    await Promise.all([loadHome(), loadDevices(), loadOneTouch()]);
    toast('Refreshed', 'success');
  } catch (e) {
    toast('Refresh failed', 'error');
  }
  btn.classList.remove('spinning');
}

// ---- Command Sending ----
async function sendCommand(command, params = {}) {
  try {
    const resp = await api('/pool/command', {
      method: 'POST',
      body: JSON.stringify({ command, params }),
    });
    if (!resp.ok) throw new Error(resp.error);
    // Refresh after brief delay to let controller update
    setTimeout(() => Promise.all([loadHome(), loadDevices(), loadOneTouch()]), 2000);
    setTimeout(() => Promise.all([loadHome(), loadDevices(), loadOneTouch()]), 5000);
    return resp;
  } catch (e) {
    toast(`Command failed: ${e.message}`, 'error');
    throw e;
  }
}

// ---- Rendering: Status Panel ----
function renderStatus() {
  const h = state.home;

  // Temperatures
  const poolTemp = h.pool_temp || '--';
  const airTemp = h.air_temp || '--';

  document.getElementById('pool-temp').textContent = poolTemp;
  document.getElementById('air-temp').textContent = airTemp;

  // Temperature ring (40-100°F range)
  setRing('pool-ring', parseInt(poolTemp) || 0, 40, 100);

  // Equipment toggles — only show equipment that exists (non-empty values)
  const equipGrid = document.getElementById('equip-grid');
  const equipment = [
    { key: 'pool_pump', label: 'Pool Pump', cmd: 'set_pool_pump' },
    { key: 'pool_heater', label: 'Pool Heat', cmd: 'set_pool_heater' },
    { key: 'freeze_protection', label: 'Freeze Protect', cmd: null },
  ].filter(eq => h[eq.key] !== undefined && h[eq.key] !== '');

  equipGrid.innerHTML = equipment.map(eq => {
    const isOn = h[eq.key] === '1' || h[eq.key] === '3';
    return `
      <button class="equip-btn ${isOn ? 'on' : ''}"
              ${eq.cmd ? `data-cmd="${eq.cmd}"` : 'disabled'}
              title="${eq.label}">
        <div class="equip-dot"></div>
        <span class="equip-label">${eq.label}</span>
      </button>
    `;
  }).join('');

  // Setpoints from API — temp1 = spa_set_point, temp2 = pool_set_point (API naming)
  if (h.spa_set_point) state.temp1 = parseInt(h.spa_set_point);
  if (h.pool_set_point) state.temp2 = parseInt(h.pool_set_point);
  document.getElementById('temp1-setpoint').textContent = state.temp1;
  document.getElementById('temp2-setpoint').textContent = state.temp2;
}

function setRing(id, value, min, max) {
  const el = document.getElementById(id);
  if (!el) return;
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const circumference = 2 * Math.PI * 52;
  el.style.strokeDashoffset = circumference * (1 - pct);
}

// ---- Rendering: Devices / Lights ----
function renderDevices() {
  // Equipment toggles are rendered in renderStatus via home data
}

function renderLights() {
  const light = state.devices.find(d => d.type === '1' || d.type === '2');
  const statusEl = document.getElementById('light-status');
  const offBtn = document.getElementById('light-off-btn');
  const grid = document.getElementById('effects-grid');

  if (!light) {
    statusEl.innerHTML = 'No light detected';
    grid.innerHTML = '';
    return;
  }

  state.selectedLight = light;
  const isOn = light.state === '1' || light.state === '3';
  const activeEffect = localStorage.getItem('pool_light_effect');
  const activeEffectName = localStorage.getItem('pool_light_effect_name');

  statusEl.innerHTML = isOn
    ? `<span class="on-label">● On</span>${activeEffectName ? ' — ' + activeEffectName : ' — Jandy LED WaterColors'}`
    : '<span class="off-label">● Off</span> — Tap a color to turn on';

  offBtn.style.display = isOn ? '' : 'none';

  // Render color effect buttons with active state persisted
  const effects = LIGHT_EFFECTS[light.subtype]?.effects || [];
  grid.innerHTML = effects.map(eff => `
    <button class="effect-btn ${isOn && activeEffect === String(eff.id) ? 'active' : ''}" data-effect="${eff.id}" data-subtype="${light.subtype}">
      ${eff.name}
    </button>
  `).join('');
}

function renderAuxDevices() {
  const auxGrid = document.getElementById('aux-grid');
  // Only show devices that are on or have a real label (not generic "Aux V*" names)
  const auxDevices = state.devices
    .filter(d => d.type === '0')
    .filter(d => {
      const isOn = d.state === '1' || d.state === '3';
      const hasCustomLabel = d.label && !/^Aux V?\d+$/i.test(d.label);
      return isOn || hasCustomLabel;
    })
    // Sort: put Extra Aux right after Aux3
    .sort((a, b) => {
      const order = id => {
        if (id === 'aux_EA') return 3.5; // After aux_3
        const num = id.replace('aux_', '');
        return parseInt(num) || 100;
      };
      return order(a.id) - order(b.id);
    });

  auxGrid.innerHTML = auxDevices.map(dev => {
    const isOn = dev.state === '1' || dev.state === '3';
    const auxNum = dev.id.replace('aux_', '');
    return `
      <button class="equip-btn ${isOn ? 'on' : ''}" data-cmd="set_aux_${auxNum}">
        <div class="equip-dot"></div>
        <span class="equip-label">${dev.label || dev.id}</span>
      </button>
    `;
  }).join('');
}


// ---- Rendering: OneTouch ----
function renderOneTouch() {
  const grid = document.getElementById('onetouch-grid');
  const buttons = state.onetouch;

  if (!Array.isArray(buttons) || buttons.length === 0) {
    grid.innerHTML = '<div class="empty-state"><p>No OneTouch buttons found</p></div>';
    return;
  }

  // Parse the onetouch response - it's typically an array of objects
  const parsed = [];
  for (const item of buttons) {
    if (typeof item === 'object') {
      for (const [key, val] of Object.entries(item)) {
        if (key.startsWith('onetouch_')) {
          const num = key.replace('onetouch_', '');
          const props = {};
          if (Array.isArray(val)) {
            for (const p of val) Object.assign(props, p);
          } else {
            Object.assign(props, val);
          }
          parsed.push({ num, ...props });
        }
      }
    }
  }

  grid.innerHTML = parsed.map((btn, i) => {
    const isOn = btn.state === '1' || btn.state === '3';
    const isAllOff = i === 0;
    return `
      <button class="onetouch-btn ${isOn ? 'on' : ''} ${isAllOff ? 'alloff' : ''}"
              data-onetouch="${btn.num}">
        <span class="onetouch-label">${btn.label || btn.name || `Button ${btn.num}`}</span>
        <span class="onetouch-number">#${btn.num}</span>
      </button>
    `;
  }).join('');
}

// ---- Rendering: Schedules ----
function renderSchedules() {
  const list = document.getElementById('schedules-list');
  const empty = document.getElementById('no-schedules');

  if (state.schedules.length === 0) {
    empty.hidden = false;
    // Remove any schedule cards but keep empty state
    list.querySelectorAll('.schedule-card').forEach(el => el.remove());
    return;
  }

  empty.hidden = true;

  // Build dynamic command labels using OneTouch names from API
  const dynamicLabels = { ...COMMAND_LABELS };
  if (state.onetouch && Array.isArray(state.onetouch)) {
    for (const item of state.onetouch) {
      if (typeof item === 'object') {
        for (const [key, val] of Object.entries(item)) {
          if (key.startsWith('onetouch_')) {
            const num = key.replace('onetouch_', '');
            const props = {};
            if (Array.isArray(val)) {
              for (const p of val) Object.assign(props, p);
            }
            const label = props.label || props.name;
            if (label && !/^ONETOUCH \d+$/i.test(label)) {
              dynamicLabels[`set_onetouch_${num}`] = label;
            }
          }
        }
      }
    }
  }

  const cards = state.schedules.map(sched => {
    const daysText = sched.days?.length === 7 ? 'Every day' :
      sched.days?.map(d => DAY_NAMES[d] || d).join(' ') || 'Every day';
    const cmdLabel = dynamicLabels[sched.command] || sched.command;

    return `
      <div class="schedule-card ${sched.enabled ? '' : 'disabled'}" data-sched-id="${sched.id}">
        <div class="schedule-time">${formatTime(sched.time)}</div>
        <div class="schedule-info">
          <div class="schedule-label-text">${sched.label || cmdLabel}</div>
          <div class="schedule-days">${daysText} · ${cmdLabel}</div>
        </div>
        <div class="schedule-actions">
          <button class="schedule-toggle ${sched.enabled ? 'on' : ''}" data-toggle-sched="${sched.id}"></button>
          <button class="btn-edit" data-edit-sched="${sched.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-delete" data-delete-sched="${sched.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Keep empty state element, replace schedule cards
  list.querySelectorAll('.schedule-card').forEach(el => el.remove());
  list.insertAdjacentHTML('beforeend', cards);
}

function formatTime(time24) {
  if (!time24) return '--:--';
  const [h, m] = time24.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// ---- Schedule Modal ----
let editingScheduleId = null;

function openScheduleModal(schedule = null) {
  const modal = document.getElementById('schedule-modal');
  const title = document.getElementById('modal-title');

  editingScheduleId = schedule?.id || null;
  title.textContent = schedule ? 'Edit Schedule' : 'New Schedule';

  // Update OneTouch option labels with custom names from API
  if (state.onetouch && Array.isArray(state.onetouch)) {
    for (const item of state.onetouch) {
      if (typeof item === 'object') {
        for (const [key, val] of Object.entries(item)) {
          if (key.startsWith('onetouch_')) {
            const num = key.replace('onetouch_', '');
            const props = {};
            if (Array.isArray(val)) {
              for (const p of val) Object.assign(props, p);
            }
            const label = props.label || props.name;
            if (label) {
              const opt = document.querySelector(`option[value="set_onetouch_${num}"]`);
              if (opt) opt.textContent = label;
            }
          }
        }
      }
    }
  }

  document.getElementById('sched-label').value = schedule?.label || '';
  document.getElementById('sched-time').value = schedule?.time || '';
  document.getElementById('sched-command').value = schedule?.command || '';

  // Reset day buttons
  const days = schedule?.days || ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.classList.toggle('active', days.includes(btn.dataset.day));
  });

  modal.hidden = false;
}

function closeScheduleModal() {
  document.getElementById('schedule-modal').hidden = true;
  editingScheduleId = null;
}

async function saveSchedule() {
  const label = document.getElementById('sched-label').value.trim();
  const time = document.getElementById('sched-time').value;
  const command = document.getElementById('sched-command').value;

  if (!time || !command) {
    toast('Please set time and action', 'error');
    return;
  }

  const days = Array.from(document.querySelectorAll('.day-btn.active'))
    .map(btn => btn.dataset.day);

  const schedule = {
    id: editingScheduleId || undefined,
    label: label || COMMAND_LABELS[command] || command,
    time,
    command,
    days,
    enabled: true,
  };

  try {
    const resp = await api('/pool/schedules', {
      method: 'POST',
      body: JSON.stringify(schedule),
    });
    if (resp.ok) {
      toast('Schedule saved', 'success');
      closeScheduleModal();
      await loadSchedules();
    }
  } catch (e) {
    toast('Failed to save schedule', 'error');
  }
}

async function toggleSchedule(id) {
  const sched = state.schedules.find(s => s.id === id);
  if (!sched) return;

  sched.enabled = !sched.enabled;
  try {
    await api('/pool/schedules', {
      method: 'POST',
      body: JSON.stringify(sched),
    });
    renderSchedules();
  } catch (e) {
    sched.enabled = !sched.enabled;
    toast('Failed to update', 'error');
  }
}

async function deleteSchedule(id) {
  try {
    await api(`/pool/schedules/${id}`, { method: 'DELETE' });
    state.schedules = state.schedules.filter(s => s.id !== id);
    renderSchedules();
    toast('Schedule deleted', 'success');
  } catch (e) {
    toast('Failed to delete', 'error');
  }
}

// ---- Event Handlers ----
function setupEvents() {
  // Tab navigation
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // Refresh
  document.getElementById('refresh-btn').addEventListener('click', refreshAll);

  // Retry connection
  document.getElementById('retry-btn').addEventListener('click', () => {
    document.querySelector('.loader').style.display = 'flex';
    connect();
  });

  // Equipment toggles (delegated)
  document.getElementById('equip-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn || btn.classList.contains('sending')) return;
    btn.classList.add('sending');
    try {
      await sendCommand(btn.dataset.cmd);
      toast(`${btn.querySelector('.equip-label').textContent} toggled`, 'success');
    } catch (_) {}
    btn.classList.remove('sending');
  });

  // Setpoint controls
  document.querySelectorAll('[data-setpoint]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const which = btn.dataset.setpoint; // 'temp1' or 'temp2'
      const dir = parseInt(btn.dataset.dir);
      state[which] = Math.max(40, Math.min(104, state[which] + dir));
      document.getElementById(`${which}-setpoint`).textContent = state[which];

      // Debounce the API call
      clearTimeout(btn._debounce);
      btn._debounce = setTimeout(async () => {
        try {
          await sendCommand('set_temps', {
            temp1: String(state.temp1),
            temp2: String(state.temp2),
          });
          toast('Temperature updated', 'success');
        } catch (_) {}
      }, 800);
    });
  });

  // Light Turn Off button
  document.getElementById('light-off-btn').addEventListener('click', async () => {
    if (!state.selectedLight) return;
    const auxNum = state.selectedLight.id.replace('aux_', '');
    try {
      await sendCommand(`set_aux_${auxNum}`);
      localStorage.removeItem('pool_light_effect');
      localStorage.removeItem('pool_light_effect_name');
      document.querySelectorAll('.effect-btn').forEach(b => b.classList.remove('active'));
      toast('Light turned off', 'success');
    } catch (_) {}
  });

  // Color effects — tap to turn on with that color (delegated)
  let lightCmdPending = false;
  document.getElementById('effects-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('.effect-btn');
    if (!btn || !state.selectedLight || lightCmdPending) return;
    lightCmdPending = true;

    document.querySelectorAll('.effect-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const effectId = btn.dataset.effect;
    const effectName = btn.textContent.trim();
    localStorage.setItem('pool_light_effect', effectId);
    localStorage.setItem('pool_light_effect_name', effectName);

    const auxNum = state.selectedLight.id.replace('aux_', '');

    try {
      // Just send set_light — the API handles turning on + setting color
      await sendCommand('set_light', {
        aux: auxNum,
        light: effectId,
        subtype: btn.dataset.subtype,
      });
      toast(effectName, 'success');
      // Wait before allowing another command — gives controller time to process
      await new Promise(r => setTimeout(r, 3000));
    } catch (_) {}
    lightCmdPending = false;
  });

  // OneTouch buttons (delegated)
  document.getElementById('onetouch-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-onetouch]');
    if (!btn) return;
    const num = btn.dataset.onetouch;
    try {
      await sendCommand(`set_onetouch_${num}`);
      toast(`OneTouch ${num} activated`, 'success');
    } catch (_) {}
  });

  // Aux device toggles (delegated)
  document.getElementById('aux-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn || btn.classList.contains('sending')) return;
    btn.classList.add('sending');
    try {
      await sendCommand(btn.dataset.cmd);
      toast('Device toggled', 'success');
    } catch (_) {}
    btn.classList.remove('sending');
  });

  // Schedule: add
  document.getElementById('add-schedule-btn').addEventListener('click', () => openScheduleModal());

  // Schedule: save / cancel
  document.getElementById('sched-save').addEventListener('click', saveSchedule);
  document.getElementById('sched-cancel').addEventListener('click', closeScheduleModal);

  // Schedule modal backdrop close
  document.querySelector('.modal-backdrop')?.addEventListener('click', closeScheduleModal);

  // Day picker
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('active'));
  });

  // Schedule toggle, edit & delete (delegated)
  document.getElementById('schedules-list').addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('[data-toggle-sched]');
    if (toggleBtn) {
      toggleSchedule(toggleBtn.dataset.toggleSched);
      return;
    }
    const editBtn = e.target.closest('[data-edit-sched]');
    if (editBtn) {
      const sched = state.schedules.find(s => s.id === editBtn.dataset.editSched);
      if (sched) openScheduleModal(sched);
      return;
    }
    const deleteBtn = e.target.closest('[data-delete-sched]');
    if (deleteBtn) {
      deleteSchedule(deleteBtn.dataset.deleteSched);
    }
  });
}

// ---- WebTouch Panel ----

let wtWindow = null;

async function wtLaunch() {
  const statusMsg = document.getElementById('panel-status-msg');
  const connectBtn = document.getElementById('panel-connect-btn');

  statusMsg.innerHTML = '<span>Connecting...</span>';
  connectBtn.disabled = true;

  try {
    const resp = await api('/webtouch/init');
    if (!resp.ok) throw new Error(resp.error);

    const wt = resp.webtouch;
    const wtUrl = `https://webtouch.iaqualink.net/?actionID=${wt.touchLink}&idToken=${wt.idToken}`;

    // Close existing window if open
    if (wtWindow && !wtWindow.closed) wtWindow.close();

    // Open in a popup window sized for the WebTouch interface
    wtWindow = window.open(wtUrl, 'AqualinkPanel', 'width=860,height=540,toolbar=no,menubar=no,scrollbars=no,status=no');

    if (!wtWindow) {
      throw new Error('Popup blocked — please allow popups for this site');
    }

    statusMsg.innerHTML = '<span style="color:var(--green)">Panel opened in new window</span>';
    connectBtn.textContent = 'Relaunch Panel';
    connectBtn.disabled = false;
  } catch (e) {
    statusMsg.innerHTML = '<span style="color:var(--red)">Error: ' + e.message + '</span>';
    connectBtn.disabled = false;
  }
}

function setupWebTouchEvents() {
  document.getElementById('panel-connect-btn').addEventListener('click', wtLaunch);
}

// ---- Auto-refresh ----
function startAutoRefresh() {
  setInterval(async () => {
    try {
      await loadHome();
    } catch (_) {
      document.getElementById('status-dot').classList.remove('online');
    }
  }, 30000); // every 30s
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  setupEvents();
  setupWebTouchEvents();
  connect();
  startAutoRefresh();
});
