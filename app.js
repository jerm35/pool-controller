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
  set_pool_pump: 'Pool Pump',
  set_spa_pump: 'Spa Pump',
  set_pool_heater: 'Pool Heater',
  set_spa_heater: 'Spa Heater',
  set_solar_heater: 'Solar Heater',
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
  poolSetpoint: 80,
  spaSetpoint: 100,
  selectedLight: null,
};

// ---- API Helpers ----
async function api(path, options = {}) {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
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

    // Load all data in parallel
    await Promise.all([loadHome(), loadDevices(), loadOneTouch(), loadSchedules()]);

    overlay.hidden = true;
    dashboard.hidden = false;
  } catch (e) {
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
    setTimeout(() => Promise.all([loadHome(), loadDevices(), loadOneTouch()]), 1500);
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
  const spaTemp = h.spa_temp || '--';
  const airTemp = h.air_temp || '--';

  document.getElementById('pool-temp').textContent = poolTemp;
  document.getElementById('spa-temp').textContent = spaTemp;
  document.getElementById('air-temp').textContent = airTemp;

  // Temperature rings (0-110°F range)
  setRing('pool-ring', parseInt(poolTemp) || 0, 40, 100);
  setRing('spa-ring', parseInt(spaTemp) || 0, 60, 110);

  // Equipment toggles
  const equipGrid = document.getElementById('equip-grid');
  const equipment = [
    { key: 'pool_pump', label: 'Pool Pump', cmd: 'set_pool_pump' },
    { key: 'spa_pump', label: 'Spa Pump', cmd: 'set_spa_pump' },
    { key: 'pool_heater', label: 'Pool Heat', cmd: 'set_pool_heater' },
    { key: 'spa_heater', label: 'Spa Heat', cmd: 'set_spa_heater' },
    { key: 'solar_heater', label: 'Solar Heat', cmd: 'set_solar_heater' },
    { key: 'freeze_protection', label: 'Freeze Protect', cmd: null },
  ];

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

  // Setpoints (use stored values since API doesn't return them directly here)
  document.getElementById('pool-setpoint').textContent = state.poolSetpoint;
  document.getElementById('spa-setpoint').textContent = state.spaSetpoint;
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
  const lightsList = document.getElementById('lights-list');
  const lights = state.devices.filter(d => d.type === '1' || d.type === '2');

  if (lights.length === 0) {
    lightsList.innerHTML = `
      <div class="empty-state">
        <p>No light devices found</p>
        <p class="small">Lights will appear here when detected by your system</p>
      </div>
    `;
    return;
  }

  lightsList.innerHTML = lights.map(light => {
    const isOn = light.state === '1' || light.state === '3';
    const typeName = light.type === '1' ? 'Dimmable' :
      (LIGHT_EFFECTS[light.subtype]?.name || 'Color Light');
    return `
      <div class="light-card ${isOn ? 'on' : ''}" data-aux="${light.id}">
        <div class="light-preview"></div>
        <div class="light-info">
          <div class="light-name">${light.label || light.id}</div>
          <div class="light-type">${typeName}</div>
        </div>
        <div class="light-actions">
          <button class="btn-sm-light" data-toggle="${light.id}">
            ${isOn ? 'Off' : 'On'}
          </button>
          <button class="btn-sm-light" data-settings="${light.id}">
            Settings
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function renderAuxDevices() {
  const auxGrid = document.getElementById('aux-grid');
  const auxDevices = state.devices.filter(d => d.type === '0');

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

function openLightSettings(auxId) {
  const device = state.devices.find(d => d.id === auxId);
  if (!device) return;

  state.selectedLight = device;
  const panel = document.getElementById('color-panel');
  const title = document.getElementById('color-panel-title');
  const brightnessSection = document.getElementById('brightness-section');
  const effectsSection = document.getElementById('effects-section');

  title.textContent = device.label || device.id;
  panel.hidden = false;

  if (device.type === '1') {
    // Dimmable light
    brightnessSection.hidden = false;
    effectsSection.hidden = true;
  } else if (device.type === '2') {
    // Color light
    brightnessSection.hidden = true;
    effectsSection.hidden = false;
    renderEffects(device);
  }
}

function renderEffects(device) {
  const grid = document.getElementById('effects-grid');
  const effects = LIGHT_EFFECTS[device.subtype]?.effects || [];

  grid.innerHTML = effects.map(eff => `
    <button class="effect-btn" data-effect="${eff.id}" data-subtype="${device.subtype}">
      ${eff.name}
    </button>
  `).join('');
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
  const cards = state.schedules.map(sched => {
    const daysText = sched.days?.length === 7 ? 'Every day' :
      sched.days?.map(d => DAY_NAMES[d] || d).join(' ') || 'Every day';
    const cmdLabel = COMMAND_LABELS[sched.command] || sched.command;

    return `
      <div class="schedule-card ${sched.enabled ? '' : 'disabled'}" data-sched-id="${sched.id}">
        <div class="schedule-time">${formatTime(sched.time)}</div>
        <div class="schedule-info">
          <div class="schedule-label-text">${sched.label || cmdLabel}</div>
          <div class="schedule-days">${daysText} · ${cmdLabel}</div>
        </div>
        <div class="schedule-actions">
          <button class="schedule-toggle ${sched.enabled ? 'on' : ''}" data-toggle-sched="${sched.id}"></button>
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
      const which = btn.dataset.setpoint;
      const dir = parseInt(btn.dataset.dir);
      if (which === 'pool') state.poolSetpoint = Math.max(40, Math.min(104, state.poolSetpoint + dir));
      else state.spaSetpoint = Math.max(40, Math.min(104, state.spaSetpoint + dir));

      document.getElementById(`${which}-setpoint`).textContent =
        which === 'pool' ? state.poolSetpoint : state.spaSetpoint;

      // Debounce the API call
      clearTimeout(btn._debounce);
      btn._debounce = setTimeout(async () => {
        try {
          await sendCommand('set_temps', {
            temp1: String(state.spaSetpoint),
            temp2: String(state.poolSetpoint),
          });
          toast('Temperature updated', 'success');
        } catch (_) {}
      }, 800);
    });
  });

  // Light toggles & settings (delegated)
  document.getElementById('lights-list').addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('[data-toggle]');
    if (toggleBtn) {
      const auxId = toggleBtn.dataset.toggle;
      const auxNum = auxId.replace('aux_', '');
      sendCommand(`set_aux_${auxNum}`);
      toast('Light toggled', 'success');
      return;
    }

    const settingsBtn = e.target.closest('[data-settings]');
    if (settingsBtn) {
      openLightSettings(settingsBtn.dataset.settings);
    }
  });

  // Brightness slider
  document.getElementById('brightness-range').addEventListener('change', async (e) => {
    if (!state.selectedLight) return;
    const auxNum = state.selectedLight.id.replace('aux_', '');
    try {
      await sendCommand('set_light', {
        aux: auxNum,
        light: String(e.target.value),
        subtype: state.selectedLight.subtype || '0',
      });
      toast(`Brightness: ${e.target.value}%`, 'success');
    } catch (_) {}
  });

  // Color effects (delegated)
  document.getElementById('effects-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('.effect-btn');
    if (!btn || !state.selectedLight) return;

    document.querySelectorAll('.effect-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const auxNum = state.selectedLight.id.replace('aux_', '');
    try {
      await sendCommand('set_light', {
        aux: auxNum,
        light: btn.dataset.effect,
        subtype: btn.dataset.subtype,
      });
      toast(`Effect: ${btn.textContent.trim()}`, 'success');
    } catch (_) {}
  });

  // Close color panel
  document.getElementById('color-close').addEventListener('click', () => {
    document.getElementById('color-panel').hidden = true;
    state.selectedLight = null;
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

  // Schedule toggle & delete (delegated)
  document.getElementById('schedules-list').addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('[data-toggle-sched]');
    if (toggleBtn) {
      toggleSchedule(toggleBtn.dataset.toggleSched);
      return;
    }
    const deleteBtn = e.target.closest('[data-delete-sched]');
    if (deleteBtn) {
      deleteSchedule(deleteBtn.dataset.deleteSched);
    }
  });
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
  connect();
  startAutoRefresh();
});
