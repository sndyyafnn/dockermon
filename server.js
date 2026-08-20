const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Docker = require('dockerode');
const si = require('systeminformation');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '2000', 10);
const MAX_EVENTS = 200;

app.use(express.static(path.join(__dirname, 'public')));

// ---------- In-memory rolling event log ----------
const eventLog = [];
function pushEvent(line) {
  const entry = { time: new Date().toISOString(), line };
  eventLog.push(entry);
  if (eventLog.length > MAX_EVENTS) eventLog.shift();
  io.emit('event', entry);
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

async function getContainerSnapshot(containerInfo) {
  const container = docker.getContainer(containerInfo.Id);
  const base = {
    id: containerInfo.Id.substring(0, 12),
    name: containerInfo.Names[0].replace(/^\//, ''),
    image: containerInfo.Image,
    status: containerInfo.State === 'running' ? 'RUNNING' : containerInfo.State.toUpperCase(),
    cpu: 0,
    mem: 0,
    memUsage: 0,
    memLimit: 0,
    netRx: 0,
    netTx: 0,
    uptime: '-',
  };

  if (containerInfo.State !== 'running') {
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
  } catch (err) {
    // Container may have stopped mid-poll; fall back gracefully
  }

  return base;
}

async function pollContainers() {
  try {
    const containers = await docker.listContainers({ all: true });
    const snapshots = await Promise.all(containers.map(getContainerSnapshot));
    io.emit('containers', snapshots);
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
    const netPercent = Math.min(100, ((netRxSec + netTxSec) / (125 * 1024 * 1024)) * 100); // relative to ~1Gbps

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
      pushEvent(`ERROR attaching to docker event stream: ${err.message}`);
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
            pushEvent(describeDockerEvent(evt));
          } catch {
            // ignore malformed chunks
          }
        });
    });
    stream.on('error', (e) => pushEvent(`event stream error: ${e.message}`));
  });
}

// ---------- Socket.IO wiring ----------
io.on('connection', (socket) => {
  socket.emit('events_snapshot', eventLog);
  pollContainers();
  pollSystemResources();
});

// ---------- Boot ----------
pushEvent('docker-monitor server started');
attachDockerEventStream();
setInterval(pollContainers, POLL_INTERVAL_MS);
setInterval(pollSystemResources, POLL_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`docker-monitor listening on http://localhost:${PORT}`);
});
