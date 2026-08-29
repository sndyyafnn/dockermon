const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Docker = require('dockerode');
const si = require('systeminformation');
const session = require('express-session');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// ---------- Mock mode (for dev/test when no Docker daemon is available) ----------
const MOCK_MODE = process.env.MOCK_MODE === '1';
let mockContainerIndex = 0;
const MOCK_CONTAINER_POOL = [
  { name: 'portal-ujian',       image: 'nginx:alpine',         state: 'running', health: 'healthy',  exposedPorts: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080', PrivatePort: 80, Type: 'tcp' }] }, cpuSigma: 12, memBase: 48e6,  memLimit: 256e6,  netRxBase: 1.24e6, netTxBase: 340e3, startedAt: Date.now() - 12 * 86400e3 - 4 * 3600e3 - 32 * 60e3 },
  { name: 'api-gateway',         image: 'node:20-alpine',       state: 'running', health: 'healthy',  exposedPorts: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3001', PrivatePort: 3000, Type: 'tcp' }] }, cpuSigma: 8,  memBase: 92e6,  memLimit: 512e6,  netRxBase: 890e3,  netTxBase: 1.4e6,  startedAt: Date.now() - 8 * 86400e3 - 14 * 3600e3 - 22 * 60e3 },
  { name: 'auth-service',        image: 'golang:1.22-alpine',   state: 'running', health: 'starting', exposedPorts: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '8081', PrivatePort: 8080, Type: 'tcp' }] }, cpuSigma: 3,  memBase: 34e6,  memLimit: 128e6,  netRxBase: 210e3,  netTxBase: 95e3,   startedAt: Date.now() - 3 * 86400e3 - 6 * 3600e3 - 11 * 60e3 },
  { name: 'file-storage',        image: 'minio/minio:latest',    state: 'running', health: 'healthy',  exposedPorts: { '9000/tcp': [{ HostIp: '0.0.0.0', HostPort: '9000', PrivatePort: 9000, Type: 'tcp' }], '9001/tcp': [{ HostIp: '0.0.0.0', HostPort: '9001', PrivatePort: 9001, Type: 'tcp' }] }, cpuSigma: 5,  memBase: 180e6, memLimit: 1e9,    netRxBase: 4.5e6,  netTxBase: 2.1e6,  startedAt: Date.now() - 20 * 86400e3 - 2 * 3600e3 - 5 * 60e3 },
  { name: 'cache-redis',         image: 'redis:7-alpine',        state: 'running', health: 'healthy',  exposedPorts: { '6379/tcp': [] }, cpuSigma: 2,  memBase: 12e6,  memLimit: 64e6,   netRxBase: 85e3,   netTxBase: 120e3,  startedAt: Date.now() - 45 * 86400e3 - 0 * 3600e3 - 0 * 60e3 },
  { name: 'log-collector',       image: 'fluent/fluent-bit:3.0', state: 'running', health: 'healthy',  exposedPorts: { '2020/tcp': [{ HostIp: '0.0.0.0', HostPort: '2020', PrivatePort: 2020, Type: 'tcp' }] }, cpuSigma: 4,  memBase: 28e6,  memLimit: 128e6,  netRxBase: 1.8e6,  netTxBase: 980e3,  startedAt: Date.now() - 6 * 86400e3 - 18 * 3600e3 - 44 * 60e3 },
  { name: 'monitoring-stack',    image: 'prom/prometheus:v2.54', state: 'running', health: 'healthy',  exposedPorts: { '9090/tcp': [{ HostIp: '0.0.0.0', HostPort: '9090', PrivatePort: 9090, Type: 'tcp' }] }, cpuSigma: 15, memBase: 220e6, memLimit: 1e9,    netRxBase: 3.2e6,  netTxBase: 1.7e6,  startedAt: Date.now() - 15 * 86400e3 - 9 * 3600e3 - 17 * 60e3 },
  { name: 'dead-service-v1',     image: 'python:3.12-slim',      state: 'exited',  health: 'none',     exposedPorts: {}, cpuSigma: 0, memBase: 0,     memLimit: 0,      netRxBase: 0,      netTxBase: 0,      startedAt: Date.now() - 90 * 86400e3 },
];

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

// In mock mode, auto-visibility all mock containers so guests see them immediately
if (MOCK_MODE) {
  guestConfig.visibleContainerIds = MOCK_CONTAINER_POOL.map((_, i) => String(i));
  saveGuestConfig();
}

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

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// ---------- Body parsing (required for JSON POST bodies) ----------
app.use(express.json());

// ---------- Auth middleware: protect dashboard routes ----------
// Public guest view at /guest is always allowed (no auth, no token).
// Admin access requires a valid session.
app.use((req, res, next) => {
  // Public guest endpoint — no auth needed
  if (req.path === '/guest' || req.path === '/guest/') {
    return next();
  }
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

// ---------- Public guest page ----------
app.get('/guest', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Login endpoint ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === CRED_USERNAME && password === CRED_PASSWORD) {
    req.session.auth = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'invalid credentials' });
});

// ---------- Logout endpoint ----------
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => { res.json({ ok: true }); });
});

// ---------- Static assets ----------
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3100;
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

// ---------- Mock container snapshot (when MOCK_MODE=1 and no Docker daemon) ----------
function generateMockSnapshot(poolEntry, idx) {
  const id = String(idx);
  const name = poolEntry.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();

  // Vary metrics slightly each poll to keep sparklines alive
  const t = Date.now() / 1000;
  const cpuJitter = 3 * Math.sin(t / (60 + poolEntry.cpuSigma * 5)) + 2 * Math.sin(t / 37);
  const memJitter = 2 * Math.sin(t / (45 + poolEntry.cpuSigma * 3)) + Math.sin(t / 23);
  const cpu = poolEntry.cpuSigma + cpuJitter;
  const memUsage = poolEntry.memBase + memJitter * 1e6;
  const memLimit = poolEntry.memLimit || (poolEntry.memBase * 4);
  const mem = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;
  const netRx = poolEntry.netRxBase + 0.1e6 * Math.sin(t / 53);
  const netTx = poolEntry.netTxBase + 0.05e6 * Math.sin(t / 41 + 1);

  return {
    id: String(idx),
    name: name,
    image: poolEntry.image,
    status: poolEntry.state === 'running' ? 'RUNNING' : poolEntry.state.toUpperCase(),
    health: poolEntry.health,
    restartCount: poolEntry.state === 'exited' ? 3 : Math.floor(Math.random() * 10),
    ports: Object.entries(poolEntry.exposedPorts).flatMap(([privatePort, bindings]) => {
      const [portNum, type] = privatePort.split('/');
      if (!bindings || !bindings.length) return [{ PrivatePort: parseInt(portNum), Type: type }];
      return bindings.map((b) => ({
        IP: b.HostIp || '0.0.0.0',
        PublicPort: b.HostPort ? parseInt(b.HostPort) : null,
        PrivatePort: parseInt(portNum),
        Type: type,
      }));
    }),
    cpu: Math.max(0, cpu),
    mem: Math.max(0, Math.min(100, mem)),
    memUsage: memUsage,
    memLimit: memLimit,
    netRx: netRx,
    netTx: netTx,
    uptime: poolEntry.startedAt ? humanizeUptime(poolEntry.startedAt) : '-',
  };
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
  if (!buffer) return '';
  if (isTty) return buffer.toString('utf8');
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  let offset = 0;
  const lines = [];
  try {
    while (offset + 8 <= buffer.length) {
      const size = buffer.readUInt32BE(offset + 4);
      const start = offset + 8;
      const end = start + size;
      if (end > buffer.length) break;
      lines.push(buffer.subarray(start, end).toString('utf8'));
      offset = end;
    }
  } catch {
    return buffer.toString('utf8');
  }
  return lines.length > 0 ? lines.join('') : buffer.toString('utf8');
}

async function getContainerSnapshot(containerInfo) {
  if (MOCK_MODE) return generateMockSnapshot(containerInfo);

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
    if (MOCK_MODE) {
      const snapshots = MOCK_CONTAINER_POOL.map((p, i) => generateMockSnapshot(p, i));
      const sorted = sortContainers(snapshots);
      const visibleSet = new Set(guestConfig.visibleContainerIds);
      const visibleOnly = sorted.filter((c) => visibleSet.has(c.id));
      io.to('admin').emit('containers', sorted);
      io.to('guest').emit('containers', visibleOnly);
      return;
    }
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

// Mock event generator: cycles through container names with realistic Docker event actions
const MOCK_EVENTS = [
  { type: 'container', action: 'exec_create',   cmd: '/usr/sbin/health.sh' },
  { type: 'container', action: 'exec_start',    cmd: '/usr/sbin/health.sh' },
  { type: 'container', action: 'exec_die',      cmd: null },
  { type: 'container', action: 'health_status_update', status: 'healthy' },
  { type: 'container', action: 'death',         cmd: null },
  { type: 'network',    action: 'connect',      name: 'bridge' },
  { type: 'volume',     action: 'mount',        name: 'data-vol' },
];

let mockEventIndex = 0;
function attachDockerEventStream() {
  if (MOCK_MODE) {
    // Generate mock events on a 30-second cycle so the Events Log panel has activity
    const cycleMs = 30000;
    const interval = setInterval(() => {
      const template = MOCK_EVENTS[mockEventIndex % MOCK_EVENTS.length];
      mockEventIndex++;
      const poolEntry = MOCK_CONTAINER_POOL[mockEventIndex % MOCK_CONTAINER_POOL.length];
      let line;
      const actorName = poolEntry.name;

      switch (template.action) {
        case 'exec_create':
          line = `[container] exec_create: /bin/sh -c ${template.cmd} :: ${actorName}`;
          break;
        case 'exec_start':
          line = `[container] exec_start: /bin/sh -c ${template.cmd} :: ${actorName}`;
          break;
        case 'exec_die':
          line = `[container] exec_die :: ${actorName}`;
          break;
        case 'health_status_update':
          line = `[container] health_status_update: ${template.status} :: ${actorName}`;
          break;
        case 'death':
          line = `[container] die :: ${actorName}`;
          break;
        case 'connect':
          line = `[network] connect :: ${actorName}`;
          break;
        case 'mount':
          line = `[volume] mount :: ${actorName}`;
          break;
        default:
          line = `[container] ${template.action} :: ${actorName}`;
      }
      pushEvent(line, true);
    }, cycleMs);
    // Store interval so it can be cleaned up if needed
    mockEventInterval = interval;
    return;
  }

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

let mockEventInterval = null;

// ---------- On-demand container detail (expanded row): logs, env, ports, disk ----------
async function getContainerDetail(id) {
  if (MOCK_MODE) {
    const poolEntry = MOCK_CONTAINER_POOL.find((p) => p.name === id || ('mock_' + id) === id);
    if (!poolEntry) {
      // Try matching by index in the pool
      const idx = parseInt(id);
      if (!isNaN(idx) && idx >= 0 && idx < MOCK_CONTAINER_POOL.length) {
        return getMockDetailForPoolEntry(MOCK_CONTAINER_POOL[idx]);
      }
      throw new Error('Container not found in mock pool');
    }
    return getMockDetailForPoolEntry(poolEntry);
  }

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

function getMockDetailForPoolEntry(poolEntry) {
  const logs = [
    '2024-01-15T08:00:01Z INFO  Service starting up',
    '2024-01-15T08:00:02Z INFO  Loading configuration from /etc/config.ini',
    '2024-01-15T08:00:03Z INFO  Database connection established',
    '2024-01-15T08:00:05Z INFO  Listening on port ' + (poolEntry.exposedPorts ? Object.keys(poolEntry.exposedPorts)[0] || '8080' : '8080'),
    '2024-01-15T08:00:10Z INFO  Health check endpoint registered',
    '2024-01-15T08:15:22Z INFO  Request processed: GET /api/status',
    '2024-01-15T08:30:45Z WARN  High memory usage detected: 78%',
    '2024-01-15T08:31:00Z INFO  Garbage collection triggered',
    '2024-01-15T09:00:00Z INFO  Periodic health check OK',
    '2024-01-15T09:15:33Z INFO  Request processed: POST /api/data',
  ];
  return {
    id: poolEntry.name.substring(0, 12),
    name: poolEntry.name,
    env: ['NODE_ENV=production', 'LOG_LEVEL=info', 'PORT=8080'],
    ports: formatPorts(
      Object.entries(poolEntry.exposedPorts || {}).flatMap(([privatePort, bindings]) => {
        const [portNum, type] = privatePort.split('/');
        if (!bindings || !bindings.length) return [{ PrivatePort: parseInt(portNum, 10), Type: type }];
        return bindings.map((b) => ({
          IP: b.HostIp || '0.0.0.0',
          PublicPort: b.HostPort ? parseInt(b.HostPort, 10) : null,
          PrivatePort: parseInt(portNum, 10),
          Type: type,
        }));
      })
    ),
    restartCount: poolEntry.state === 'exited' ? 3 : Math.floor(Math.random() * 10),
    health: poolEntry.health,
    sizeRw: Math.floor(Math.random() * 500e6),
    sizeRootFs: Math.floor(Math.random() * 2e9),
    logs: logs,
  };
}

async function performContainerAction(id, action) {
  if (MOCK_MODE) {
    let poolEntry = MOCK_CONTAINER_POOL.find((p) => p.name === id || ('mock_' + id) === id);
    if (!poolEntry) {
      const idx = parseInt(id, 10);
      if (!isNaN(idx) && idx >= 0 && idx < MOCK_CONTAINER_POOL.length) {
        poolEntry = MOCK_CONTAINER_POOL[idx];
      }
    }
    if (!poolEntry) throw new Error(`Container '${id}' not found in mock pool`);

    switch (action) {
      case 'start':
        poolEntry.state = 'running';
        poolEntry.startedAt = Date.now();
        break;
      case 'stop':
        poolEntry.state = 'exited';
        break;
      case 'restart':
        poolEntry.state = 'running';
        poolEntry.startedAt = Date.now();
        break;
      case 'pause':
        poolEntry.state = 'paused';
        break;
      case 'unpause':
        poolEntry.state = 'running';
        break;
      default:
        throw new Error(`Unknown container action '${action}'`);
    }
    return `Mock container '${poolEntry.name}' action '${action}' succeeded`;
  }

  const container = docker.getContainer(id);
  switch (action) {
    case 'start':
      await container.start();
      break;
    case 'stop':
      await container.stop();
      break;
    case 'restart':
      await container.restart();
      break;
    case 'pause':
      await container.pause();
      break;
    case 'unpause':
      await container.unpause();
      break;
    default:
      throw new Error(`Unknown container action '${action}'`);
  }
  return `Container '${id}' action '${action}' executed successfully`;
}

// ---------- Socket.IO wiring ----------
io.on('connection', (socket) => {
  const reqSession = socket.request?.session;
  const isAdmin = reqSession && reqSession.auth === true;
  const guestMode = !isAdmin || socket.handshake.auth?.guestMode === true;

  // Join room based on verified session auth (guests cannot join admin room)
  if (isAdmin && !guestMode) {
    socket.join('admin');
  } else {
    socket.join('guest');
  }

  socket.emit('events_snapshot', eventLog);
  pollSystemResources();

  // ---- Admin-only events ----

  // Set which containers are visible to guests (admin only)
  socket.on('set_container_visibility', (ids) => {
    if (!isAdmin) return; // enforce session auth check
    setContainerVisibility(ids);
    io.emit('visibility_updated', { visibleIds: guestConfig.visibleContainerIds });
  });

  // Get current visibility config (admin only)
  socket.on('get_visibility_config', () => {
    if (!isAdmin) return;
    socket.emit('visibility_config', { visibleIds: guestConfig.visibleContainerIds });
  });

  // Container detail (logs, env, ports)
  socket.on('get_container_detail', async (id) => {
    // Enforce visibility in guest mode: reject detail requests for non-visible containers
    if (!isAdmin && !isContainerVisible(id)) {
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

  // Container action (start, stop, restart, pause, unpause - admin only)
  socket.on('container_action', async ({ id, action }) => {
    if (!isAdmin) {
      socket.emit('container_action_result', { ok: false, error: 'Unauthorized: Admin privileges required' });
      return;
    }
    try {
      const message = await performContainerAction(id, action);
      socket.emit('container_action_result', { ok: true, id, action, message });
      pushEvent(`[ADMIN ACTION] ${action.toUpperCase()} :: ${id}`, true);
      setTimeout(pollContainers, 300);
    } catch (err) {
      socket.emit('container_action_result', { ok: false, id, action, error: err.message });
    }
  });
});

// ---------- Boot ----------
pushEvent('docker-monitor server started' + (MOCK_MODE ? ' [MOCK MODE — no Docker daemon]' : ''), false);
attachDockerEventStream();
setInterval(pollContainers, POLL_INTERVAL_MS);
setInterval(pollSystemResources, POLL_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`docker-monitor listening on http://localhost:${PORT}`);
  console.log(`  Admin:      http://localhost:${PORT}/        (login required)`);
  console.log(`  Guest view: http://localhost:${PORT}/guest    (public, read-only)`);
  if (MOCK_MODE) {
    console.log(`  [MOCK MODE] Using ${MOCK_CONTAINER_POOL.length} synthetic containers — no Docker daemon required`);
  }
});
