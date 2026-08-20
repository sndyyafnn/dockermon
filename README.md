# docker-monitor

A real-time, terminal-styled web dashboard for monitoring your local Docker containers — live status, CPU/RAM/network per container, aggregate system resources, and a live event log, all pushed over WebSockets so the UI updates seamlessly with no page refresh.

**Stack:** Node.js + Express + Socket.IO (backend/real-time transport), [dockerode](https://github.com/apocas/dockerode) (talks to the Docker Engine API over the Docker socket), [systeminformation](https://systeminformation.io/) (host resource metrics), plain HTML/CSS/JS frontend (no build step).

## Run it (one command)

From this folder:

```bash
docker compose up -d --build
```

Then open **http://localhost:3000**

That's it — it builds the image, starts the container, mounts your Docker socket read-only so it can see your other containers, and starts polling every 2 seconds.

Stop it with:
```bash
docker compose down
```

## What you get

- **Container Status** — ID, name, image, running/stopped state, live CPU %, memory %, network I/O, and uptime for every container, refreshed every 2s.
- **System Resources** — CPU, RAM, disk, and network utilization bars.
- **Events Log** — live stream of Docker daemon events (container start/stop/die/create/destroy, etc.) as they happen.
- Auto-reconnect indicator (● LIVE / ● DISCONNECTED) if the socket drops.

## Notes on accuracy of "System Resources"

By default the container reports resource usage from its own cgroup view, not the full host. For fully accurate **host-level** CPU/RAM/disk numbers, edit `docker-compose.yml` and uncomment:

```yaml
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
    pid: host
```

then `docker compose up -d --build` again. Container-level stats (the main table) are always accurate regardless, since those come directly from the Docker Engine API.

## Configuration

Environment variables (set in `docker-compose.yml`):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the web UI listens on |
| `POLL_INTERVAL_MS` | `2000` | How often container/system stats are polled and pushed to the browser |

## Running without Docker Compose

```bash
docker build -t docker-monitor .
docker run -d --name docker-monitor \
  -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  docker-monitor
```

## Running locally without Docker at all (dev mode)

```bash
npm install
npm start
```

Requires Docker Desktop/Engine to be running on the same machine so `/var/run/docker.sock` exists locally (on Windows, Docker Desktop exposes this via WSL2/named pipe integration automatically for most setups).

## Security note

The container is granted read-only access to your Docker socket, which is enough to list containers, read stats, and stream events — it cannot start, stop, or modify containers. Still, treat access to this dashboard like access to your Docker host: don't expose port 3000 to the public internet without adding authentication (e.g. put it behind a reverse proxy with basic auth, or bind it to `127.0.0.1:3000:3000` instead of `3000:3000` if you only need local access).
