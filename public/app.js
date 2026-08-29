const socket = io({
  auth: {
    guestMode: location.pathname === '/guest' ? true : false
  }
});

const connBadge = document.getElementById('conn-status');
const clockEl = document.getElementById('clock');
const containersBody = document.getElementById('containers-body');
const containerCountEl = document.getElementById('container-count');
const searchInput = document.getElementById('search-input');
const statusFilters = document.getElementById('status-filters');
const sortableHeaders = document.querySelectorAll('th[data-sort]');
const eventsWrap = document.getElementById('events');
const alertsToggleBtn = document.getElementById('alerts-toggle');
const thresholdPctInput = document.getElementById('threshold-pct');
const thresholdSecInput = document.getElementById('threshold-sec');
const mainEl = document.querySelector('main');
const topbarRightEl = document.querySelector('.topbar-right');
const titlebarEl = document.querySelector('.titlebar');
const footerEl = document.querySelector('footer');
const guestBannerEl = document.getElementById('guest-banner');
const logoutBtn = document.getElementById('logout-btn');

// ---------- Guest page detection ----------
const isGuestPage = location.pathname === '/guest';
let guestMode = isGuestPage;
let isAuthenticated = !guestMode;

// ---------- Init: apply guest mode UI classes if on /guest page ----------
if (isGuestPage) {
  mainEl.classList.add('guest-mode');
  topbarRightEl.classList.add('topbar-guest');
  titlebarEl.classList.add('titlebar-guest');
  footerEl.classList.add('footer-guest');
  // Hide admin conn-badge on guest page
  if (connBadge) connBadge.style.display = 'none';
  guestBannerEl.classList.remove('hidden');
  document.querySelectorAll('.guest-overview-panel, .guest-cards-panel, .guest-resources-panel, #guest-live-indicator, #guest-last-update').forEach(el => el.classList.remove('hidden'));
} else {
  // Admin page: ensure guest banner stays hidden
  guestBannerEl.classList.add('hidden');
}

// ---------- Guest mode UI ----------
function enterGuestMode() {
  mainEl.classList.add('guest-mode');
  topbarRightEl.classList.add('topbar-guest');
  titlebarEl.classList.add('titlebar-guest');
  footerEl.classList.add('footer-guest');
  // Hide admin conn-badge when entering guest mode
  if (connBadge) connBadge.style.display = 'none';
  guestBannerEl.classList.remove('hidden');
  // Show guest-only elements
  document.querySelectorAll('.guest-overview-panel, .guest-cards-panel, .guest-resources-panel, #guest-live-indicator, #guest-last-update').forEach(el => el.classList.remove('hidden'));
  // Reconnect socket with guest auth
  if (socket.io?.connected) {
    socket.io.auth.guestMode = true;
    socket.connect();
  }
}

function exitGuestMode() {
  if (!guestMode) return;
  guestMode = false;
  mainEl.classList.remove('guest-mode');
  topbarRightEl.classList.remove('topbar-guest');
  titlebarEl.classList.remove('titlebar-guest');
  footerEl.classList.remove('footer-guest');
  guestBannerEl.classList.add('hidden');
  // Hide guest-only elements
  document.querySelectorAll('.guest-overview-panel, .guest-cards-panel, .guest-resources-panel, #guest-live-indicator, #guest-last-update').forEach(el => el.classList.add('hidden'));
}

// ---------- Auth status (admin session) ----------

// Logout handler
logoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {}
  window.location.href = '/login.html';
});

// ---------- Container visibility state (admin feature) ----------
let visibilityConfig = { visibleIds: [] };
const visibilityToggleBtns = new Map(); // id -> button element

// ---------- Container table state ----------
let latestContainers = [];
const previousStatusById = new Map();
const expandedIds = new Set();
const detailCache = new Map(); // id -> detail object
let searchQuery = '';
let statusFilter = 'all';
let sortKey = 'cpu';
let sortDir = 'desc'; // 'asc' | 'desc'

// ---------- Visibility filtering for guests (defense-in-depth) ----------
// Server already filters; this is a second line of defense.
// Guard: skip filtering until visibilityConfig is populated (server will have already
// filtered by then, so we don't accidentally remove everything).
function filterByVisibility(containers) {
  if (!guestMode) return containers;
  if (!visibilityConfig || !visibilityConfig.visibleIds || !visibilityConfig.visibleIds.length) return containers;
  const visible = new Set(visibilityConfig.visibleIds);
  return containers.filter((c) => visible.has(c.id));
}

// ---------- Alerts state (Phase 3) ----------
let alertsEnabled = false;
let thresholdPct = 80;
let thresholdSec = 15;
const sustainedSince = new Map(); // id -> { cpu: ts|null, mem: ts|null }

// ---------- Trend history for sparklines (Phase 4) ----------
const HISTORY_LEN = 60; // 2 minutes at 2s poll interval
const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const history = new Map(); // id -> { cpu: number[], mem: number[], netRate: number[], lastNet: {rx,tx,ts}|null }

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}GB`;
  if (mb >= 1) return `${mb.toFixed(1)}MB`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function formatRate(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0.0MB/s';
  const mb = bytesPerSec / (1024 * 1024);
  return `${mb.toFixed(1)}MB/s`;
}

function asciiBar(percent, width = 8) {
  const pct = Math.max(0, Math.min(100, percent || 0));
  const filled = Math.round((pct / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `[${bar}] ${pct.toFixed(0)}%`;
}

// ---------- SVG Sparklines ----------
function sparklineSvg(values, maxVal, color, height = 24, width = 120) {
  if (!values || !values.length) return '';
  const effectiveMax = maxVal > 0 ? maxVal : Math.max(...values, 1);
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - (Math.max(0, Math.min(1, v / effectiveMax)) * height);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="spark-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>
  </svg>`;
}

function sparkline(values, maxVal) {
  if (!values || !values.length) return '';
  const effectiveMax = maxVal > 0 ? maxVal : Math.max(...values, 1);
  return values.map((v) => {
    const norm = Math.max(0, Math.min(1, v / effectiveMax));
    const idx = Math.min(SPARK_CHARS.length - 1, Math.floor(norm * SPARK_CHARS.length));
    return SPARK_CHARS[idx];
  }).join('');
}

// ---------- History update ----------
function updateHistory(containers) {
  const now = Date.now();
  containers.forEach((c) => {
    let h = history.get(c.id);
    if (!h) {
      h = { cpu: [], mem: [], netRate: [], lastNet: null };
      history.set(c.id, h);
    }
    h.cpu.push(c.cpu || 0);
    if (h.cpu.length > HISTORY_LEN) h.cpu.shift();
    h.mem.push(c.mem || 0);
    if (h.mem.length > HISTORY_LEN) h.mem.shift();

    let rate = 0;
    if (h.lastNet) {
      const dtSec = (now - h.lastNet.ts) / 1000;
      if (dtSec > 0) {
        const dRx = Math.max(0, c.netRx - h.lastNet.rx);
        const dTx = Math.max(0, c.netTx - h.lastNet.tx);
        rate = (dRx + dTx) / dtSec;
      }
    }
    h.netRate.push(rate);
    if (h.netRate.length > HISTORY_LEN) h.netRate.shift();
    h.lastNet = { rx: c.netRx, tx: c.netTx, ts: now };
  });

  const currentIds = new Set(containers.map((c) => c.id));
  [...history.keys()].forEach((id) => {
    if (!currentIds.has(id)) history.delete(id);
  });
}

function tickClock() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', { hour12: false });
  if (guestMode) {
    clockEl.textContent = timeStr;
    document.getElementById('guest-last-update').textContent = `UPDATED ${timeStr}`;
  } else {
    clockEl.textContent = timeStr;
  }
}
setInterval(tickClock, 1000);
tickClock();

// ---------- Connection status + guest live indicator ----------
function setTableStatus(msg, isError) {
  const existing = containersBody.querySelector('.empty');
  if (existing) {
    existing.textContent = msg;
    existing.classList.toggle('error', !!isError);
  }
}

socket.on('connect', () => {
  if (guestMode) {
    // Guest page uses the dedicated live indicator, not the admin conn-badge
    const gi = document.getElementById('guest-live-indicator');
    if (gi) gi.classList.remove('hidden');
    setTableStatus('live — awaiting first update…');
  } else {
    connBadge.textContent = '● CONNECTED';
    connBadge.className = 'badge connected';
    setTableStatus('connected — awaiting first container update…');
    socket.emit('get_visibility_config');
  }
});

socket.on('connect_error', () => {
  if (!guestMode) {
    connBadge.textContent = '● DISCONNECTED';
    connBadge.className = 'badge disconnected';
  }
  setTableStatus('cannot reach server — retrying…', true);
});

socket.on('disconnect', () => {
  if (guestMode) {
    const gi = document.getElementById('guest-live-indicator');
    if (gi) gi.classList.add('hidden');
    setTableStatus('connection lost — retrying…', true);
  } else {
    connBadge.textContent = '● DISCONNECTED';
    connBadge.className = 'badge disconnected';
    setTableStatus('connection lost — retrying…', true);
  }
});

// ---------- Visibility config from server ----------
socket.on('visibility_config', (config) => {
  visibilityConfig = config;
  // Re-render if we have containers loaded
  if (latestContainers.length) {
    renderVisibilityToggles(latestContainers);
    renderContainers();
  }
});

socket.on('visibility_updated', (config) => {
  visibilityConfig = config;
  if (latestContainers.length) {
    renderVisibilityToggles(latestContainers);
    renderContainers();
  }
});

// ---------- Filtering / sorting ----------
function applyFilters(containers) {
  let rows = containers;

  if (statusFilter === 'running') {
    rows = rows.filter((c) => c.status.toUpperCase() === 'RUNNING');
  } else if (statusFilter === 'stopped') {
    rows = rows.filter((c) => c.status.toUpperCase() !== 'RUNNING');
  }

  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    rows = rows.filter((c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
  }

  const dir = sortDir === 'asc' ? 1 : -1;
  rows = [...rows].sort((a, b) => {
    let av;
    let bv;
    switch (sortKey) {
      case 'id':
        av = a.id; bv = b.id; break;
      case 'name':
        av = a.name.toLowerCase(); bv = b.name.toLowerCase(); break;
      case 'status':
        av = a.status; bv = b.status; break;
      case 'net':
        av = a.netRx + a.netTx; bv = b.netRx + b.netTx; break;
      case 'uptime':
        av = a.uptime; bv = b.uptime; break;
      case 'health':
        av = a.health; bv = b.health; break;
      case 'mem':
        av = a.mem; bv = b.mem; break;
      case 'cpu':
      default:
        av = a.cpu; bv = b.cpu; break;
    }
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });

  return rows;
}

function updateSortHeaderStyles() {
  sortableHeaders.forEach((th) => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === sortKey) {
      th.classList.add(sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

// ---------- Sustained CPU/MEM threshold tracking ----------
function updateSustainedState(containers) {
  const now = Date.now();
  containers.forEach((c) => {
    const rec = sustainedSince.get(c.id) || { cpu: null, mem: null };
    rec.cpu = c.cpu >= thresholdPct ? (rec.cpu || now) : null;
    rec.mem = c.mem >= thresholdPct ? (rec.mem || now) : null;
    sustainedSince.set(c.id, rec);
  });
  // drop bookkeeping for containers that no longer exist
  const currentIds = new Set(containers.map((c) => c.id));
  [...sustainedSince.keys()].forEach((id) => {
    if (!currentIds.has(id)) sustainedSince.delete(id);
  });
}

function getAlertState(id) {
  const rec = sustainedSince.get(id);
  if (!rec) return null;
  const now = Date.now();
  const sustainedMs = thresholdSec * 1000;
  const cpuSustained = rec.cpu && now - rec.cpu >= sustainedMs;
  const memSustained = rec.mem && now - rec.mem >= sustainedMs;
  if (!cpuSustained && !memSustained) return null;
  const label = cpuSustained && memSustained ? '⚠ CPU+MEM' : cpuSustained ? '⚠ CPU' : '⚠ MEM';
  return { level: 'crit', label };
}

// ---------- Death detection -> notification + sound ----------
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioCtx = new AudioContextClass();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}
document.addEventListener('click', () => { getAudioContext(); }, { once: false });

function playBeep() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 420;
    gain.gain.value = 0.06;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
    }, 180);
  } catch {
    // audio not available in this context - ignore
  }
}

function notifyContainerDown(container) {
  if (!alertsEnabled) return;
  playBeep();
  if (window.Notification && Notification.permission === 'granted') {
    try {
      new Notification('Container down', {
        body: `${container.name} is now ${container.status}`,
      });
    } catch {
      // Notification constructor can throw in some contexts - ignore
    }
  }
}

function checkForDeaths(containers) {
  containers.forEach((c) => {
    const prev = previousStatusById.get(c.id);
    if (prev === 'RUNNING' && c.status !== 'RUNNING') {
      notifyContainerDown(c);
    }
  });
}

async function toggleAlerts() {
  if (!alertsEnabled) {
    if (window.Notification && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        // ignore
      }
    }
    alertsEnabled = true;
  } else {
    alertsEnabled = false;
  }
  alertsToggleBtn.textContent = alertsEnabled ? '🔔 ALERTS ON' : '🔕 ALERTS OFF';
  alertsToggleBtn.className = `badge ${alertsEnabled ? 'alerts-on' : 'alerts-off'}`;
}

alertsToggleBtn.addEventListener('click', toggleAlerts);

const crtCurveToggleBtn = document.getElementById('crt-curve-toggle');
const crtScreenEl = document.querySelector('.crt-screen');

if (crtCurveToggleBtn && crtScreenEl) {
  crtCurveToggleBtn.addEventListener('click', () => {
    const isCurved = crtScreenEl.classList.contains('crt-curved-active');
    if (isCurved) {
      crtScreenEl.classList.remove('crt-curved-active');
      crtCurveToggleBtn.textContent = '[CRT CURVE: OFF]';
    } else {
      crtScreenEl.classList.add('crt-curved-active');
      crtCurveToggleBtn.textContent = '[CRT CURVE: ON]';
    }
  });
}

function clampNumber(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

thresholdPctInput.addEventListener('change', (e) => {
  thresholdPct = clampNumber(e.target.value, 1, 100, 80);
  e.target.value = thresholdPct;
  renderContainers();
});

thresholdSecInput.addEventListener('change', (e) => {
  thresholdSec = clampNumber(e.target.value, 1, 600, 15);
  e.target.value = thresholdSec;
  renderContainers();
});

function healthBadge(health, restartCount) {
  const label = health === 'none' ? '—' : health;
  const restarts = restartCount > 0 ? `<span class="restart-count">↻${restartCount}</span>` : '';
  return `<span class="health-badge ${health}">${label}</span>${restarts}`;
}

function renderDetailPanel(id) {
  const detail = detailCache.get(id);
  if (!detail) {
    return `<div class="detail-panel"><div class="detail-loading">loading logs, env, and ports…</div></div>`;
  }
  if (detail.error) {
    return `<div class="detail-panel"><div class="detail-loading">error: ${escapeHtml(detail.error)}</div></div>`;
  }

  const portsHtml = detail.ports.length
    ? `<ul class="detail-list">${detail.ports.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
    : `<div class="detail-loading">no published ports</div>`;

  const envHtml = detail.env.length
    ? `<ul class="detail-list">${detail.env
        .map((e) => {
          const idx = e.indexOf('=');
          const key = idx >= 0 ? e.slice(0, idx) : e;
          const val = idx >= 0 ? e.slice(idx + 1) : '';
          return `<li><span class="env-key">${escapeHtml(key)}</span>=${escapeHtml(val)}</li>`;
        })
        .join('')}</ul>`
    : `<div class="detail-loading">no env vars</div>`;

  const logsHtml = detail.logs.length
    ? detail.logs.map((l) => `<div class="log-line">${escapeHtml(l)}</div>`).join('')
    : '(no recent logs)';

  const liveContainer = latestContainers.find((c) => c.id === id);
  const status = liveContainer ? liveContainer.status : 'UNKNOWN';
  const isRunning = status === 'RUNNING';
  const isPaused = status === 'PAUSED';

  let actionBtnsHtml = '';
  if (!guestMode) {
    if (isRunning) {
      actionBtnsHtml = `
        <button type="button" class="action-btn action-stop" data-action="stop" data-id="${escapeHtml(id)}">■ STOP</button>
        <button type="button" class="action-btn action-restart" data-action="restart" data-id="${escapeHtml(id)}">↻ RESTART</button>
        <button type="button" class="action-btn action-pause" data-action="pause" data-id="${escapeHtml(id)}">⏸ PAUSE</button>`;
    } else if (isPaused) {
      actionBtnsHtml = `
        <button type="button" class="action-btn action-unpause" data-action="unpause" data-id="${escapeHtml(id)}">▶ UNPAUSE</button>
        <button type="button" class="action-btn action-stop" data-action="stop" data-id="${escapeHtml(id)}">■ STOP</button>`;
    } else {
      actionBtnsHtml = `
        <button type="button" class="action-btn action-start" data-action="start" data-id="${escapeHtml(id)}">▶ START</button>`;
    }
  }

  return `
    <div class="detail-panel">
      <div class="detail-meta">
        <span>DISK (writable layer): <b>${formatBytes(detail.sizeRw)}</b></span>
        <span>ROOT FS: <b>${formatBytes(detail.sizeRootFs)}</b></span>
        <button type="button" class="refresh-btn" data-refresh="${escapeHtml(id)}">↻ refresh</button>
        ${actionBtnsHtml ? `<div class="action-btn-group">${actionBtnsHtml}</div>` : ''}
      </div>
      <div class="detail-section">
        <div class="detail-heading">PORTS</div>
        ${portsHtml}
      </div>
      <div class="detail-section">
        <div class="detail-heading">ENV</div>
        ${envHtml}
      </div>
      <div class="detail-heading detail-logs-heading" style="grid-column: 1 / span 2;">LOGS (last ${detail.logs.length} lines)</div>
      <div class="detail-logs">${logsHtml}</div>
    </div>`;
}

function requestDetail(id) {
  socket.emit('get_container_detail', id);
}

// ---------- Admin visibility toggle rendering ----------
function renderVisibilityToggles(containers) {
  // Remove old toggle buttons
  visibilityToggleBtns.forEach((btn) => btn.remove());
  visibilityToggleBtns.clear();

  if (guestMode) return;

  containers.forEach((c) => {
    // Find the row's VIS cell (the td with vis-toggle-col-cell class in the correct row)
    const row = document.querySelector(`#containers-table tbody tr[data-id="${c.id}"]`);
    if (!row) return;
    const visCell = row.querySelector('.vis-toggle-col-cell');
    if (!visCell) return;

    const visible = visibilityConfig.visibleIds.includes(c.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `vis-toggle-btn ${visible ? 'vis-on' : 'vis-off'}`;
    btn.dataset.id = c.id;
    btn.title = visible ? 'Click to hide from guest view' : 'Click to show in guest view';
    btn.innerHTML = visible ? '<span class="vis-icon">👁</span>' : '<span class="vis-icon">🚫</span>';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentVisible = visibilityConfig.visibleIds.includes(c.id);
      let newIds;
      if (currentVisible) {
        newIds = visibilityConfig.visibleIds.filter((id) => id !== c.id);
      } else {
        newIds = [...visibilityConfig.visibleIds, c.id];
      }
      socket.emit('set_container_visibility', newIds);
    });

    // Clear existing button in this cell, then add new one
    visCell.innerHTML = '';
    visCell.appendChild(btn);
    visibilityToggleBtns.set(c.id, btn);
  });
}

// ---------- Guest card rendering ----------
function renderGuestCards(containers) {
  const grid = document.getElementById('guest-cards-grid');
  const countEl = document.getElementById('guest-cards-count');
  countEl.textContent = `${containers.length} service${containers.length !== 1 ? 's' : ''}`;

  if (!containers.length) {
    grid.innerHTML = '<div class="guest-empty-state">no services visible</div>';
    return;
  }

  grid.innerHTML = containers.map((c) => {
    const h = history.get(c.id) || { cpu: [], mem: [], netRate: [] };
    const statusClass = c.status.toLowerCase();
    const isRunning = c.status === 'RUNNING';
    const health = c.health === 'none' ? '—' : c.health;
    const healthClass = c.health === 'healthy' ? 'healthy' : c.health === 'unhealthy' ? 'unhealthy' : c.health === 'starting' ? 'starting' : 'none';
    const runtimeStr = c.uptime && c.uptime !== '-' ? c.uptime : 'n/a';

    // CPU gauge SVG
    const cpuPct = Math.max(0, Math.min(100, c.cpu || 0));
    const cpuColor = cpuPct >= 85 ? '#ff5c57' : cpuPct >= 65 ? '#ffd866' : '#3ddc84';
    const cpuAngle = (cpuPct / 100) * 180;
    const cpuGauge = `
      <svg class="guest-gauge" viewBox="0 0 60 34">
        <path class="gauge-track" d="M 5 28 A 25 25 0 0 1 55 28" />
        <path class="gauge-fill" d="M 5 28 A 25 25 0 0 1 55 28" stroke="${cpuColor}"
              stroke-dasharray="${Math.sin(Math.PI * cpuPct / 100) * 25} 999"
              stroke-dashoffset="${50 - Math.sin(Math.PI * cpuPct / 100) * 25}"
              stroke-linecap="round" />
        <text x="30" y="33" text-anchor="middle" class="gauge-label">${cpuPct.toFixed(0)}%</text>
      </svg>`;

    // MEM gauge SVG
    const memPct = Math.max(0, Math.min(100, c.mem || 0));
    const memColor = memPct >= 85 ? '#ff5c57' : memPct >= 65 ? '#ffd866' : '#3ddc84';
    const memAngle = (memPct / 100) * 180;
    const memGauge = `
      <svg class="guest-gauge" viewBox="0 0 60 34">
        <path class="gauge-track" d="M 5 28 A 25 25 0 0 1 55 28" />
        <path class="gauge-fill" d="M 5 28 A 25 25 0 0 1 55 28" stroke="${memColor}"
              stroke-dasharray="${Math.sin(Math.PI * memPct / 100) * 25} 999"
              stroke-dashoffset="${50 - Math.sin(Math.PI * memPct / 100) * 25}"
              stroke-linecap="round" />
        <text x="30" y="33" text-anchor="middle" class="gauge-label">${memPct.toFixed(0)}%</text>
      </svg>`;

    // CPU sparkline
    const cpuSpark = sparklineSvg(h.cpu, 100, '#3ddc84', 28, 160);
    // MEM sparkline
    const memSpark = sparklineSvg(h.mem, 100, '#3ddc84', 28, 160);

    // Network info
    const netRxRate = c.netRx ? formatRate(c.netRx / 2) : '0.0MB/s'; // rough rate estimate
    const netTxRate = c.netTx ? formatRate(c.netTx / 2) : '0.0MB/s';
    const netTotal = `${formatBytes(c.netRx)} ↓ / ${formatBytes(c.netTx)} ↑`;

    const alertState = getAlertState(c.id);
    const alertClass = alertState ? alertState.level : '';

    // Health dot color
    const healthDotColor = c.health === 'healthy' ? '#3ddc84' : c.health === 'unhealthy' ? '#ff5c57' : c.health === 'starting' ? '#ffd866' : '#5f7568';

    // Status indicator
    const statusDot = isRunning
      ? '<span class="status-dot running"></span>'
      : '<span class="status-dot stopped"></span>';

    return `
      <div class="guest-card ${alertClass}" data-id="${c.id}">
        <div class="guest-card-header">
          <div class="guest-card-name-row">
            ${statusDot}
            <span class="guest-card-name">${escapeHtml(c.name)}</span>
          </div>
          <div class="guest-card-status-row">
            <span class="guest-status-pill ${statusClass}">${isRunning ? '● ONLINE' : '○ OFFLINE'}</span>
            <span class="guest-health-badge ${healthClass}">${health}</span>
            ${c.restartCount > 0 ? `<span class="guest-restart-badge">↻${c.restartCount}</span>` : ''}
          </div>
        </div>
        <div class="guest-card-body">
          <div class="guest-metrics-row">
            <div class="guest-metric-block">
              <div class="guest-metric-label">CPU</div>
              <div class="guest-gauge-row">
                ${cpuGauge}
                <div class="guest-metric-spark">${cpuSpark}</div>
              </div>
            </div>
            <div class="guest-metric-block">
              <div class="guest-metric-label">MEM</div>
              <div class="guest-gauge-row">
                ${memGauge}
                <div class="guest-metric-spark">${memSpark}</div>
              </div>
            </div>
          </div>
          <div class="guest-info-row">
            <div class="guest-info-item">
              <span class="guest-info-label">UPTIME</span>
              <span class="guest-info-value">${runtimeStr}</span>
            </div>
            <div class="guest-info-item">
              <span class="guest-info-label">NETWORK</span>
              <span class="guest-info-value">${netTotal}</span>
            </div>
            <div class="guest-info-item">
              <span class="guest-info-label">RX RATE</span>
              <span class="guest-info-value">${netRxRate}</span>
            </div>
            <div class="guest-info-item">
              <span class="guest-info-label">TX RATE</span>
              <span class="guest-info-value">${netTxRate}</span>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ---------- Guest overview panel ----------
function renderGuestOverview(containers) {
  const total = containers.length;
  const online = containers.filter(c => c.status === 'RUNNING').length;
  const offline = total - online;
  const unhealthy = containers.filter(c => c.health === 'unhealthy').length;

  document.getElementById('guest-services-count').textContent = total;
  document.getElementById('guest-online-count').textContent = online;
  document.getElementById('guest-offline-count').textContent = offline;
  document.getElementById('guest-unhealthy-count').textContent = unhealthy;

  const statusEl = document.getElementById('guest-system-status');
  let statusText, statusColor;
  if (unhealthy > 0) {
    statusText = '● DEGRADED';
    statusColor = 'var(--yellow)';
  } else if (offline > 0) {
    statusText = '● PARTIAL';
    statusColor = 'var(--text-dim)';
  } else if (total === 0) {
    statusText = '○ NO SERVICES';
    statusColor = 'var(--text-dim)';
  } else {
    statusText = '● OK';
    statusColor = 'var(--green)';
  }
  statusEl.querySelector('.sys-status-label').textContent = statusText;
  statusEl.querySelector('.sys-status-dot').style.color = statusColor;
}

// ---------- Main render ----------
function renderContainers() {
  let containers = latestContainers;

  // Apply visibility filtering for guests (defense-in-depth — server already filters)
  containers = filterByVisibility(containers);

  // Admin: render table
  if (!guestMode) {
    renderAdminTable(containers, latestContainers);
  } else {
    // Guest: render cards + overview
    renderGuestCards(containers);
    renderGuestOverview(containers);
  }
}

function renderAdminTable(containers, allContainers) {
  const rows = applyFilters(containers);
  const totalShown = rows.length;
  const totalAvailable = allContainers.length;
  const visibleCount = visibilityConfig.visibleIds.length;

  containerCountEl.textContent = `${totalShown} / ${totalAvailable} shown  ·  ${visibleCount} visible to guests`;

  if (!allContainers.length) {
    containersBody.innerHTML = '<tr><td colspan="10" class="empty">waiting for data…</td></tr>';
    renderVisibilityToggles([]);
    return;
  }
  if (!rows.length) {
    containersBody.innerHTML = '<tr><td colspan="10" class="empty">no containers match filters</td></tr>';
    renderVisibilityToggles([]);
    return;
  }

  containersBody.innerHTML = rows
    .map((c) => {
      const statusClass = c.status.toLowerCase();
      const prevStatus = previousStatusById.get(c.id);
      const changed = prevStatus !== undefined && prevStatus !== c.status;
      const isOpen = expandedIds.has(c.id);
      const alert = getAlertState(c.id);
      const rowClasses = [changed ? 'flash-changed' : '', alert ? `row-${alert.level}` : '']
        .filter(Boolean)
        .join(' ');
      const alertBadge = alert ? `<span class="alert-badge ${alert.level}">${alert.label}</span>` : '';
      const h = history.get(c.id) || { cpu: [], mem: [], netRate: [] };
      const visible = visibilityConfig.visibleIds.includes(c.id);

      // Guest mode: hide toggle column and VIS column
      if (guestMode) {
        // Guest sees 8 columns (no toggle, no VIS)
        return `
          <tr data-id="${escapeHtml(c.id)}" class="${rowClasses}">
            <td class="container-id">${escapeHtml(c.id)}</td>
            <td class="container-name">${escapeHtml(c.name)}</td>
            <td><span class="status-pill ${statusClass}">[${escapeHtml(c.status)}]</span></td>
            <td>${healthBadge(c.health, c.restartCount)}</td>
            <td class="meter">
              <div>${asciiBar(c.cpu)}${alertBadge}</div>
              <div class="spark">${sparkline(h.cpu, 100)}</div>
            </td>
            <td class="meter">
              <div>${asciiBar(c.mem)}</div>
              <div class="spark">${sparkline(h.mem, 100)}</div>
            </td>
            <td>
              <div>${formatBytes(c.netRx)} IN / ${formatBytes(c.netTx)} OUT</div>
              <div class="spark">${sparkline(h.netRate)}</div>
            </td>
            <td>${escapeHtml(c.uptime)}</td>
          </tr>`;
      }

      // Admin view: 10 columns (VIS + toggle + 8 data)
      const toggleCol = `<td class="col-toggle"><button type="button" class="row-toggle ${isOpen ? 'open' : ''}" data-toggle="${escapeHtml(c.id)}">${isOpen ? '▾' : '▸'}</button></td>`;
      const visCol = `<td class="vis-toggle-col-cell"><span class="vis-indicator ${visible ? 'vis-on' : 'vis-off'}" title="${visible ? 'Visible to guests' : 'Hidden from guests'}"></span></td>`;

      const mainRow = `
        <tr data-id="${escapeHtml(c.id)}" class="${rowClasses}">
          ${visCol}
          ${toggleCol}
          <td class="container-id">${escapeHtml(c.id)}</td>
          <td class="container-name" data-toggle="${escapeHtml(c.id)}">${escapeHtml(c.name)}</td>
          <td><span class="status-pill ${statusClass}">[${escapeHtml(c.status)}]</span></td>
          <td>${healthBadge(c.health, c.restartCount)}</td>
          <td class="meter">
            <div>${asciiBar(c.cpu)}${alertBadge}</div>
            <div class="spark">${sparkline(h.cpu, 100)}</div>
          </td>
          <td class="meter">
            <div>${asciiBar(c.mem)}</div>
            <div class="spark">${sparkline(h.mem, 100)}</div>
          </td>
          <td>
            <div>${formatBytes(c.netRx)} IN / ${formatBytes(c.netTx)} OUT</div>
            <div class="spark">${sparkline(h.netRate)}</div>
          </td>
          <td>${escapeHtml(c.uptime)}</td>
        </tr>`;

      const detailRow = isOpen
        ? `<tr class="detail-row"><td colspan="10">${renderDetailPanel(c.id)}</td></tr>`
        : '';

      return mainRow + detailRow;
    })
    .join('');

  // Render visibility toggle buttons in the VIS column after the table is built
  renderVisibilityToggles(latestContainers);
}

searchInput.addEventListener('input', (e) => {
  if (guestMode) return;
  searchQuery = e.target.value;
  renderContainers();
});

statusFilters.addEventListener('click', (e) => {
  if (guestMode) return;
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  statusFilters.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  statusFilter = btn.dataset.filter;
  renderContainers();
});

sortableHeaders.forEach((th) => {
  th.addEventListener('click', () => {
    if (guestMode) return;
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = key;
      sortDir = 'desc';
    }
    updateSortHeaderStyles();
    renderContainers();
  });
});
updateSortHeaderStyles();

containersBody.addEventListener('click', (e) => {
  if (guestMode) return;
  const actionBtn = e.target.closest('[data-action]');
  if (actionBtn) {
    const id = actionBtn.dataset.id;
    const action = actionBtn.dataset.action;
    if (confirm(`Execute ${action.toUpperCase()} on container ${id}?`)) {
      actionBtn.disabled = true;
      actionBtn.textContent = 'EXECUTING...';
      socket.emit('container_action', { id, action });
    }
    return;
  }
  const refreshBtn = e.target.closest('[data-refresh]');
  if (refreshBtn) {
    const id = refreshBtn.dataset.refresh;
    detailCache.delete(id);
    renderContainers();
    requestDetail(id);
    return;
  }
  const toggle = e.target.closest('[data-toggle]');
  if (!toggle) return;
  const id = toggle.dataset.toggle;
  if (expandedIds.has(id)) {
    expandedIds.delete(id);
  } else {
    expandedIds.add(id);
    if (!detailCache.has(id)) requestDetail(id);
  }
  renderContainers();
});

socket.on('container_action_result', (res) => {
  if (guestMode) return;
  if (res.ok) {
    renderEvent({ time: new Date().toISOString(), line: `ACTION SUCCESS: ${res.message}` });
    detailCache.delete(res.id);
    requestDetail(res.id);
  } else {
    alert(`Action failed: ${res.error}`);
    renderEvent({ time: new Date().toISOString(), line: `ACTION ERROR: ${res.error}` });
  }
});

socket.on('container_detail', (detail) => {
  if (guestMode) return;
  detailCache.set(detail.id, detail);
  if (expandedIds.has(detail.id)) renderContainers();
});

socket.on('container_detail_error', ({ id, message }) => {
  if (guestMode) return;
  detailCache.set(id, { error: message });
  if (expandedIds.has(id)) renderContainers();
});

socket.on('containers', (containers) => {
  checkForDeaths(containers);
  updateSustainedState(containers);
  updateHistory(containers);
  latestContainers = containers;

  // Clean up detail state for containers no longer present
  const currentIds = new Set(containers.map((c) => c.id));
  [...expandedIds].forEach((id) => {
    if (!currentIds.has(id)) {
      expandedIds.delete(id);
      detailCache.delete(id);
    }
  });

  renderContainers();
  containers.forEach((c) => previousStatusById.set(c.id, c.status));
});

function setBar(barId, valId, percent, opts = {}) {
  const bar = document.getElementById(barId);
  const val = document.getElementById(valId);
  const pct = Math.max(0, Math.min(100, percent || 0));
  bar.style.setProperty('--pct', `${pct}%`);
  bar.classList.remove('warn', 'crit');
  if (pct >= 85) bar.classList.add('crit');
  else if (pct >= 65) bar.classList.add('warn');
  val.textContent = `${pct.toFixed(0)}%`;
}

// ---------- Guest resource bars ----------
function setGuestBar(barId, valId, percent, subId, formatFn) {
  const bar = document.getElementById(barId);
  const val = document.getElementById(valId);
  const sub = subId ? document.getElementById(subId) : null;
  const pct = Math.max(0, Math.min(100, percent || 0));
  bar.style.setProperty('--pct', `${pct}%`);
  bar.classList.remove('warn', 'crit');
  if (pct >= 85) bar.classList.add('crit');
  else if (pct >= 65) bar.classList.add('warn');
  val.textContent = `${pct.toFixed(0)}%`;
  if (sub && formatFn) sub.textContent = formatFn();
}

socket.on('system', (sys) => {
  if (!guestMode) {
    setBar('bar-cpu', 'val-cpu', sys.cpu.percent);
    setBar('bar-mem', 'val-mem', sys.mem.percent);
    document.getElementById('sub-mem').textContent =
      `${formatBytes(sys.mem.used)} / ${formatBytes(sys.mem.total)}`;
    setBar('bar-disk', 'val-disk', sys.disk.percent);
    setBar('bar-net', 'val-net', sys.network.percent);
    document.getElementById('sub-net').textContent =
      `${formatRate(sys.network.rxSec)} IN / ${formatRate(sys.network.txSec)} OUT`;
  } else {
    setGuestBar('guest-bar-cpu', 'guest-val-cpu', sys.cpu.percent);
    setGuestBar('guest-bar-mem', 'guest-val-mem', sys.mem.percent, 'guest-sub-mem',
      () => `${formatBytes(sys.mem.used)} / ${formatBytes(sys.mem.total)}`);
    setGuestBar('guest-bar-disk', 'guest-val-disk', sys.disk.percent);
    setGuestBar('guest-bar-net', 'guest-val-net', sys.network.percent, 'guest-sub-net',
      () => `${formatRate(sys.network.rxSec)} IN / ${formatRate(sys.network.txSec)} OUT`);
  }
});

function renderEvent(entry) {
  const time = new Date(entry.time).toLocaleTimeString('en-GB', { hour12: false });
  const div = document.createElement('div');
  div.className = 'event-line';
  div.innerHTML = `<span class="time">${time}</span>${escapeHtml(entry.line)}`;
  eventsWrap.prepend(div);
  while (eventsWrap.children.length > 200) {
    eventsWrap.removeChild(eventsWrap.lastChild);
  }
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

socket.on('events_snapshot', (entries) => {
  eventsWrap.innerHTML = '';
  entries.forEach(renderEvent);
});

socket.on('event', renderEvent);

socket.on('error', (err) => {
  renderEvent({ time: new Date().toISOString(), line: `ERROR: ${err.message}` });
});
