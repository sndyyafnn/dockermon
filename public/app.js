const socket = io();

const connBadge = document.getElementById('conn-status');
const clockEl = document.getElementById('clock');
const containersBody = document.getElementById('containers-body');
const eventsWrap = document.getElementById('events');

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

function tickClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString('en-GB', { hour12: false });
}
setInterval(tickClock, 1000);
tickClock();

socket.on('connect', () => {
  connBadge.textContent = '● LIVE';
  connBadge.className = 'badge connected';
});

socket.on('disconnect', () => {
  connBadge.textContent = '● DISCONNECTED';
  connBadge.className = 'badge disconnected';
});

socket.on('containers', (containers) => {
  if (!containers.length) {
    containersBody.innerHTML = '<tr><td colspan="7" class="empty">no containers found</td></tr>';
    return;
  }
  containersBody.innerHTML = containers
    .map((c) => {
      const statusClass = c.status.toLowerCase();
      return `
        <tr>
          <td class="container-id">${c.id}</td>
          <td class="container-name">${c.name}</td>
          <td><span class="status-pill ${statusClass}">[${c.status}]</span></td>
          <td class="meter">${asciiBar(c.cpu)}</td>
          <td class="meter">${asciiBar(c.mem)}</td>
          <td>${formatBytes(c.netRx)} IN / ${formatBytes(c.netTx)} OUT</td>
          <td>${c.uptime}</td>
        </tr>`;
    })
    .join('');
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
