const socket = io({
  auth: {
    guestMode: new URLSearchParams(window.location.search).get('guest') ? true : false,
    guestToken: new URLSearchParams(window.location.search).get('guest') || ''
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
const generateGuestBtn = document.getElementById('generate-guest-btn');
const copyGuestUrlBtn = document.getElementById('copy-guest-url-btn');
const logoutBtn = document.getElementById('logout-btn');

// ---------- Guest mode ----------
function parseGuestToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get('guest') || '';
}

let guestMode = false;
let isAuthenticated = false;
const GUEST_TOKEN = parseGuestToken();

// Detect guest mode from URL or existing banner state
function detectGuestMode() {
  // URL parameter takes precedence
  if (GUEST_TOKEN) return true;
  // If the banner was already made visible by something else, we're in guest mode
  if (!guestBannerEl.classList.contains('hidden')) return true;
  return false;
}

function enterGuestMode() {
  if (guestMode) return;
  guestMode = true;
  mainEl.classList.add('guest-mode');
  topbarRightEl.classList.add('topbar-guest');
  titlebarEl.classList.add('titlebar-guest');
  footerEl.classList.add('footer-guest');
  guestBannerEl.classList.remove('hidden');
  document.getElementById('guest-token-display').textContent = GUEST_TOKEN;
  // Reconnect socket with guest auth
  if (socket.io?.connected) {
    socket.io.auth.guestMode = true;
    socket.io.auth.guestToken = GUEST_TOKEN;
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
}

// ---------- Token generation (admin feature) ----------
function generateGuestToken() {
  let token = '';
  for (let i = 0; i < 8; i++) {
    token += '0123456789abcdef' [Math.floor(Math.random() * 16)];
  }
  return token;
}

function buildGuestUrl(token) {
  const url = new URL(window.location);
  url.searchParams.set('guest', token);
  return url.toString();
}

generateGuestBtn.addEventListener('click', () => {
  const token = generateGuestToken();
  const guestUrl = buildGuestUrl(token);
  sessionStorage.setItem('pendingGuestUrl', guestUrl);
  copyGuestUrlBtn.dataset.guestUrl = guestUrl;
  copyGuestUrlBtn.style.display = '';
  copyGuestUrlBtn.classList.remove('hidden');
  copyGuestUrlBtn.textContent = 'Copy URL';
  updateGuestButtonVisibility();
});

copyGuestUrlBtn.addEventListener('click', () => {
  const url = copyGuestUrlBtn.dataset.guestUrl;
  if (!url) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      copyGuestUrlBtn.textContent = 'Copied!';
      setTimeout(() => { copyGuestUrlBtn.textContent = 'Copy URL'; }, 1500);
    }).catch(() => {
      fallbackCopy(url);
    });
  } else {
    fallbackCopy(url);
  }
});

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    copyGuestUrlBtn.textContent = 'Copied!';
    setTimeout(() => { copyGuestUrlBtn.textContent = 'Copy URL'; }, 1500);
  } catch {
    copyGuestUrlBtn.textContent = 'Failed';
    setTimeout(() => { copyGuestUrlBtn.textContent = 'Copy URL'; }, 1500);
  }
  document.body.removeChild(ta);
}

// ---------- Guest mode init ----------
if (detectGuestMode()) {
  enterGuestMode();
}

function updateGuestButtonVisibility() {
  const show = !guestMode && isAuthenticated;
  generateGuestBtn.style.display = show ? '' : 'none';
  copyGuestUrlBtn.style.display = (show && copyGuestUrlBtn.dataset.guestUrl) ? '' : 'none';
  logoutBtn.style.display = show ? '' : 'none';
}

updateGuestButtonVisibility();

// ---------- Auth status (admin session) ----------
// Detect auth state: if we loaded index.html, the middleware passed us,
// which means we have a valid session (or we're in guest mode).
isAuthenticated = !guestMode;

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
function filterByVisibility(containers) {
  if (!guestMode) return containers;
  const visible = new Set(visibilityConfig.visibleIds);
  return containers.filter((c) => visible.has(c.id));
}

// ---------- Alerts state (Phase 3) ----------
let alertsEnabled = false;
let thresholdPct = 80;
let thresholdSec = 15;
const sustainedSince = new Map(); // id -> { cpu: ts|null, mem: ts|null }

// ---------- Trend history for sparklines (Phase 4) ----------
const HISTORY_LEN = 24; // ~48s of history at a 2s poll interval
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
  const bar = '|'.repeat(filled) + '-'.repeat(width - filled);
  return `[${bar}] ${pct.toFixed(0)}%`;
}

// ---------- Sparklines ----------
function sparkline(values, fixedMax) {
  if (!values || !values.length) return '';
  const max = fixedMax !== undefined ? fixedMax : Math.max(...values, 1);
  return values
    .map((v) => {
      const ratio = max > 0 ? Math.min(1, Math.max(0, v / max)) : 0;
      const idx = Math.round(ratio * (SPARK_CHARS.length - 1));
      return SPARK_CHARS[idx];
    })
    .join('');
}

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
  clockEl.textContent = now.toLocaleTimeString('en-GB', { hour12: false });
}
setInterval(tickClock, 1000);
tickClock();

socket.on('connect', () => {
  connBadge.textContent = '● LIVE';
  connBadge.className = 'badge connected';
  // If not in guest mode, request visibility config
  if (!guestMode) {
    socket.emit('get_visibility_config');
  }
});

socket.on('disconnect', () => {
  connBadge.textContent = '● DISCONNECTED';
  connBadge.className = 'badge disconnected';
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
function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 420;
    gain.gain.value = 0.06;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
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

  return `
    <div class="detail-panel">
      <div class="detail-meta">
        <span>DISK (writable layer): <b>${formatBytes(detail.sizeRw)}</b></span>
        <span>ROOT FS: <b>${formatBytes(detail.sizeRootFs)}</b></span>
        <button type="button" class="refresh-btn" data-refresh="${id}">↻ refresh</button>
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

// ---------- Main render ----------
function renderContainers() {
  let containers = latestContainers;

  // Apply visibility filtering for guests (defense-in-depth — server already filters)
  containers = filterByVisibility(containers);

  const rows = applyFilters(containers);
  const totalShown = rows.length;
  const totalAvailable = latestContainers.length;
  const visibleCount = visibilityConfig.visibleIds.length;

  if (guestMode) {
    containerCountEl.textContent = `${totalShown} visible to guests`;
  } else {
    containerCountEl.textContent = `${totalShown} / ${totalAvailable} shown  ·  ${visibleCount} visible to guests`;
  }

  if (!latestContainers.length) {
    containersBody.innerHTML = '<tr><td colspan="10" class="empty">waiting for data…</td></tr>';
    renderVisibilityToggles([]);
    return;
  }
  if (!rows.length) {
    containersBody.innerHTML = guestMode
      ? '<tr><td colspan="10" class="empty">no containers visible to guests</td></tr>'
      : '<tr><td colspan="10" class="empty">no containers match filters</td></tr>';
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
          <tr data-id="${c.id}" class="${rowClasses}">
            <td class="container-id">${c.id}</td>
            <td class="container-name">${c.name}</td>
            <td><span class="status-pill ${statusClass}">[${c.status}]</span></td>
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
            <td>${c.uptime}</td>
          </tr>`;
      }

      // Admin view: 10 columns (VIS + toggle + 8 data)
      const toggleCol = `<td class="col-toggle"><button type="button" class="row-toggle ${isOpen ? 'open' : ''}" data-toggle="${c.id}">${isOpen ? '▾' : '▸'}</button></td>`;
      const visCol = `<td class="vis-toggle-col-cell"><span class="vis-indicator ${visible ? 'vis-on' : 'vis-off'}" title="${visible ? 'Visible to guests' : 'Hidden from guests'}"></span></td>`;

      const mainRow = `
        <tr data-id="${c.id}" class="${rowClasses}">
          ${visCol}
          ${toggleCol}
          <td class="container-id">${c.id}</td>
          <td class="container-name" data-toggle="${c.id}">${c.name}</td>
          <td><span class="status-pill ${statusClass}">[${c.status}]</span></td>
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
          <td>${c.uptime}</td>
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

socket.on('system', (sys) => {
  setBar('bar-cpu', 'val-cpu', sys.cpu.percent);
  setBar('bar-mem', 'val-mem', sys.mem.percent);
  document.getElementById('sub-mem').textContent =
    `${formatBytes(sys.mem.used)} / ${formatBytes(sys.mem.total)}`;
  setBar('bar-disk', 'val-disk', sys.disk.percent);
  setBar('bar-net', 'val-net', sys.network.percent);
  document.getElementById('sub-net').textContent =
    `${formatRate(sys.network.rxSec)} IN / ${formatRate(sys.network.txSec)} OUT`;
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
