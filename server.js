const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Docker = require('dockerode');
const si = require('systeminformation');
const session = require('express-session');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// ---------- Guest visibility config (persisted to guest-config.json) ----------
const GUEST_CONFIG_PATH = path.join(__dirname, 'guest-config.json');
let guestConfig;

function loadGuestConfig() {
  try {
    const raw = fs.readFileSync(GUEST_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.visibleContainerIds)) {
      return { version: 1, visibleContainerIds: parsed.visibleContainerIds };
    }
  } catch {}
  return { version: 1, visibleContainerIds: [] };
}

function saveGuestConfig() {
  try {
    fs.writeFileSync(GUEST_CONFIG_PATH, JSON.stringify(guestConfig, null, 2), 'utf8');
  } catch {}
}

guestConfig = loadGuestConfig();

function setContainerVisibility(ids) {
  guestConfig.visibleContainerIds = ids.map(String).filter(Boolean);
  saveGuestConfig();
}

function isContainerVisible(id) {
  return guestConfig.visibleContainerIds.includes(String(id));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------- Session & auth ----------
const SESSION_SECRET = process.env.SESSION_SECRET || 'docker-monitor-session-secret-2024';

const CRED_USERNAME = process.env.ADMIN_USER || 'admin';
const CRED_PASSWORD = process.env.ADMIN_PASS || 'admin';
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

// ---------- Body parsing (required for JSON POST bodies) ----------
app.use(express.json());

// ---------- Auth middleware: protect dashboard routes ----------
// Guest mode (read-only, via ?guest=<token>) bypasses login.
// Admin access requires a valid session.
app.use((req, res, next) => {
  const isGuest = req.query && req.query.guest ? true : false;
  if (isGuest) return next(); // guest read-only access
  if (req.session && req.session.auth) return next(); // authenticated admin
  // For navigation requests to the root or dashboard HTML, redirect to login
  if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
    return res.redirect('/login.html');
  }
  // For API calls and static assets (JS, CSS, images), allow without auth
  if (req.path.startsWith('/api/') ||
      req.path.endsWith('.js') ||
      req.path.endsWith('.css') ||
      req.path.endsWith('.html') && req.path !== '/index.html') {
    return next();
  }
  // Default: allow (e.g. favicon, other static assets)
  next();
});

// Login endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === CRED_USERNAME && password === CRED_PASSWORD) {
    req.session.auth = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'invalid credentials' });
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => { res.json({ ok: true }); });
});

// ---------- Static assets ----------
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '2000', 10);
const MAX_EVENTS = 200;

// ---------- In-memory rolling event log ----------
const eventLog = [];
function pushEvent(line, guestSafe = true) {
  const entry = { time: new Date().toISOString(), line };
  eventLog.push(entry);
  if (eventLog.length > MAX_EVENTS) eventLog.shift();
  io.to('admin').emit('event', entry);
  if (guestSafe) {
    io.to('guest').emit('event', entry);
  }
}

// ---------- Helpers ----------
function humanizeUptime(startedAt) {
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return 'n/a';
  const diffMs = Date.now() - started;
  if (diffMs < 0) return 'n/a';
  const sec = Math.floor(diffMs / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
  if (mins > 0) return `${mins} min${mins > 1 ? 's' : ''}`;
  return `${sec}s`;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}GB`;
  if (mb >= 1) return `${mb.toFixed(1)}MB`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function cpuPercentFromStats(stats) {
  try {
    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta =
      stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const onlineCpus =
      stats.cpu_stats.online_cpus ||
      (stats.cpu_stats.cpu_usage.percpu_usage
        ? stats.cpu_stats.cpu_usage.percpu_usage.length
        : 1);
    if (systemDelta > 0 && cpuDelta > 0) {
      return (cpuDelta / systemDelta) * onlineCpus * 100;
    }
    return 0;
  } catch {
    return 0;
  }
}

function netIOFromStats(stats) {
  let rx = 0;
  let tx = 0;
  if (stats.networks) {
    for (const iface of Object.values(stats.networks)) {
      rx += iface.rx_bytes || 0;
      tx += iface.tx_bytes || 0;
    }
  }
  return { rx, tx };
}

function formatPorts(ports) {
  if (!ports || !ports.length) return [];
  return ports.map((p) => {
    if (p.PublicPort) {
      return `${p.IP || '0.0.0.0'}:${p.PublicPort} -> ${p.PrivatePort}/${p.Type}`;
    }
    return `${p.PrivatePort}/${p.Type} (not published)`;
  });
}

// Docker multiplexes stdout/stderr into a single stream with an 8-byte frame
// header per chunk when the container was NOT created with a TTY. Strip
// those headers so raw log text is readable. TTY containers have no framing.
function demuxDockerLogBuffer(buffer, isTty) {
  if (isTty) return buffer.toString('utf8');
  let offset = 0;
  const lines = [];
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) break;
    lines.push(buffer.slice(start, end).toString('utf8'));
    offset = end;
  }
  return lines.join('');
}

async function getContainerSnapshot(containerInfo) {
  const container = docker.getContainer(containerInfo.Id);
  const base = {
    id: containerInfo.Id.substring(0, 12),
    name: containerInfo.Names[0].replace(/^\//, ''),
    image: containerInfo.Image,
    status: containerInfo.State === 'running' ? 'RUNNING' : containerInfo.State.toUpperCase(),
    health: 'none',
    restartCount: 0,
    ports: formatPorts(containerInfo.Ports),
    cpu: 0,
    mem: 0,
    memUsage: 0,
    memLimit: 0,
    netRx: 0,
    netTx: 0,
    uptime: '-',
  };

  if (containerInfo.State !== 'running') {
    try {
      const inspect = await container.inspect();
      base.restartCount = inspect.RestartCount || 0;
    } catch {
      // ignore - container may have been removed mid-poll
    }
    return base;
  }

  try {
    const [stats, inspect] = await Promise.all([
      container.stats({ stream: false }),
      container.inspect(),
    ]);
    base.cpu = cpuPercentFromStats(stats);
    base.memUsage = stats.memory_stats.usage || 0;
    base.memLimit = stats.memory_stats.limit || 0;
    base.mem = base.memLimit > 0 ? (base.memUsage / base.memLimit) * 100 : 0;
    const { rx, tx } = netIOFromStats(stats);
    base.netRx = rx;
    base.netTx = tx;
    base.uptime = humanizeUptime(inspect.State.StartedAt);
    base.restartCount = inspect.RestartCount || 0;
    base.health = inspect.State.Health ? inspect.State.Health.Status : 'none';
  } catch (err) {
    // Container may have stopped mid-poll; fall back gracefully
  }

  return base;
}

// Sort: running first, then by CPU desc, then MEM desc
function sortContainers(containers) {
  return containers.sort((a, b) => {
    const aRunning = a.status === 'RUNNING';
    const bRunning = b.status === 'RUNNING';
    if (aRunning !== bRunning) return aRunning ? -1 : 1;
    if (b.cpu !== a.cpu) return b.cpu - a.cpu;
    return b.mem - a.mem;
  });
}

// ---------- Polling ----------
async function pollContainers() {
  try {
    const containers = await docker.listContainers({ all: true });
    const snapshots = await Promise.all(containers.map(getContainerSnapshot));
    const sorted = sortContainers(snapshots);

    const visibleSet = new Set(guestConfig.visibleContainerIds);
    const visibleOnly = sorted.filter((c) => visibleSet.has(c.id));

    // Admin room gets full list, guest room gets filtered list
    io.to('admin').emit('containers', sorted);
    io.to('guest').emit('containers', visibleOnly);
  } catch (err) {
    io.emit('error', { message: 'Failed to reach Docker daemon', detail: err.message });
  }
}

async function pollSystemResources() {
  try {
    const [cpuLoad, mem, fsSize, netStats, dockerInfo] = await Promise.all([
      si.currentLoad().catch(() => null),
      si.mem().catch(() => null),
      si.fsSize().catch(() => []),
      si.networkStats().catch(() => []),
      docker.info().catch(() => null),
    ]);

    const cpuPercent = cpuLoad ? cpuLoad.currentLoad : 0;

    const memTotal = mem ? mem.total : dockerInfo ? dockerInfo.MemTotal : 0;
    const memUsed = mem ? mem.active : 0;
    const memPercent = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;

    let diskUsed = 0;
    let diskTotal = 0;
    if (fsSize && fsSize.length) {
      const root = fsSize.find((d) => d.mount === '/') || fsSize[0];
      diskUsed = root.used;
      diskTotal = root.size;
    }
    const diskPercent = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0;

    let netRxSec = 0;
    let netTxSec = 0;
    if (netStats && netStats.length) {
      netRxSec = netStats.reduce((s, n) => s + (n.rx_sec || 0), 0);
      netTxSec = netStats.reduce((s, n) => s + (n.tx_sec || 0), 0);
    }
    const netPercent = Math.min(100, ((netRxSec + netTxSec) / (125 * 1024 * 1024)) * 100);

    io.emit('system', {
      cpu: { percent: cpuPercent },
      mem: { percent: memPercent, used: memUsed, total: memTotal },
      disk: { percent: diskPercent, used: diskUsed, total: diskTotal },
      network: { percent: netPercent, rxSec: netRxSec, txSec: netTxSec },
    });
  } catch (err) {
    // system metrics are best-effort; don't crash the loop
  }
}

// ---------- Docker events stream (for the live Events Log panel) ----------
function describeDockerEvent(evt) {
  const actorName = (evt.Actor && evt.Actor.Attributes && evt.Actor.Attributes.name) || evt.Actor?.ID?.substring(0, 12) || 'unknown';
  return `[${evt.Type}] ${evt.Action} :: ${actorName}`;
}

function attachDockerEventStream() {
  docker.getEvents({}, (err, stream) => {
    if (err) {
      pushEvent(`ERROR attaching to docker event stream: ${err.message}`, false);
      return;
    }
    stream.on('data', (chunk) => {
      chunk
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .forEach((line) => {
          try {
            const evt = JSON.parse(line);
            const actorId = evt.Actor?.ID?.substring(0, 12) || null;
            const guestSafe = !actorId || isContainerVisible(actorId);
            pushEvent(describeDockerEvent(evt), guestSafe);
          } catch {
            // ignore malformed chunks
          }
        });
    });
    stream.on('error', (e) => pushEvent(`event stream error: ${e.message}`, false));
  });
}

// ---------- On-demand container detail (expanded row): logs, env, ports, disk ----------
async function getContainerDetail(id) {
  const container = docker.getContainer(id);
  const inspect = await container.inspect({ size: true });

  let logText = '';
  try {
    const logBuffer = await container.logs({
      stdout: true,
      stderr: true,
      tail: 80,
      timestamps: true,
      follow: false,
    });
    logText = demuxDockerLogBuffer(logBuffer, inspect.Config.Tty);
  } catch (err) {
    logText = `(could not read logs: ${err.message})`;
  }

  return {
    id: id.substring(0, 12),
    name: inspect.Name.replace(/^\//, ''),
    env: inspect.Config.Env || [],
    ports: formatPorts(
      Object.entries(inspect.NetworkSettings.Ports || {}).flatMap(([privatePort, bindings]) => {
        const [portNum, type] = privatePort.split('/');
        if (!bindings) return [{ PrivatePort: portNum, Type: type }];
        return bindings.map((b) => ({
          IP: b.HostIp,
          PublicPort: b.HostPort,
          PrivatePort: portNum,
          Type: type,
        }));
      })
    ),
    restartCount: inspect.RestartCount || 0,
    health: inspect.State.Health ? inspect.State.Health.Status : 'none',
    sizeRw: inspect.SizeRw || 0,
    sizeRootFs: inspect.SizeRootFs || 0,
    logs: logText.split('\n').filter((l) => l.length > 0).slice(-80),
  };
}

// ---------- Socket.IO wiring ----------
io.on('connection', (socket) => {
  const guestMode = socket.handshake.auth?.guestMode === true;
  const guestToken = socket.handshake.auth?.guestToken || '';

  // Join the appropriate room so polls can target admin vs guest sockets
  if (guestMode) {
    socket.join('guest');
  } else {
    socket.join('admin');
  }

  socket.emit('events_snapshot', eventLog);
  pollSystemResources();

  // ---- Admin-only events ----

  // Set which containers are visible to guests (admin only)
  socket.on('set_container_visibility', (ids) => {
    if (guestMode) return; // reject from guests
    setContainerVisibility(ids);
    io.emit('visibility_updated', { visibleIds: guestConfig.visibleContainerIds });
  });

  // Get current visibility config (admin only)
  socket.on('get_visibility_config', () => {
    if (guestMode) return;
    socket.emit('visibility_config', { visibleIds: guestConfig.visibleContainerIds });
  });

  socket.on('get_container_detail', async (id) => {
    // Enforce visibility in guest mode: reject detail requests for non-visible containers
    if (guestMode && !isContainerVisible(id)) {
      socket.emit('container_detail_error', { id, message: 'Container is not visible in guest view' });
      return;
    }
    try {
      const detail = await getContainerDetail(id);
      socket.emit('container_detail', detail);
    } catch (err) {
      socket.emit('container_detail_error', { id, message: err.message });
    }
  });
});

// ---------- Boot ----------
pushEvent('docker-monitor server started', false);
attachDockerEventStream();
setInterval(pollContainers, POLL_INTERVAL_MS);
setInterval(pollSystemResources, POLL_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`docker-monitor listening on http://localhost:${PORT}`);
});
