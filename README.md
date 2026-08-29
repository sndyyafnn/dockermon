# Dockermon (docker-monitor)

A real-time, terminal-styled web dashboard for monitoring and managing Docker containers — live status, CPU/RAM/network metrics per container, host resources, container action controls (Start/Stop/Restart/Pause), public guest view, and live Docker event logs via WebSockets.

**Stack:** Node.js + Express + Socket.IO (backend/real-time transport), [dockerode](https://github.com/apocas/dockerode) (talks to Docker Engine API), [systeminformation](https://systeminformation.io/) (host resource metrics), 100% self-contained Vanilla HTML/CSS/JS frontend (no external CDN dependencies).

---

## Direct Deployment via Docker Compose (Port 3100)

From the project root folder on your server:

```bash
docker compose up -d --build
```

### Accessing the Dashboard

Access directly using your server's IP address on **Port 3100**:

- **Admin Dashboard**: `http://<YOUR-SERVER-IP>:3100/` *(Login required)*
  - Default Admin User: `admin`
  - Default Admin Pass: `admin`
- **Public Guest View**: `http://<YOUR-SERVER-IP>:3100/guest` *(Public read-only, non-admin)*

---

## Configuration & Environment Variables

Configure settings in `docker-compose.yml` or via container environment:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3100` | Port the web UI listens on |
| `ADMIN_USER` | `admin` | Username for Admin login |
| `ADMIN_PASS` | `admin` | Password for Admin login |
| `SESSION_SECRET` | `docker-monitor-session-secret-2024` | Secret string used to sign session cookies |
| `POLL_INTERVAL_MS` | `2000` | Polling frequency for container and system metrics (ms) |

---

## Running with Docker CLI (Port 3100)

```bash
docker build -t docker-monitor .

docker run -d \
  --name docker-monitor \
  --restart unless-stopped \
  -p 3100:3100 \
  -e PORT=3100 \
  -e ADMIN_USER=admin \
  -e ADMIN_PASS=admin \
  -v /var/run/docker.sock:/var/run/docker.sock \
  docker-monitor
```

---

## Features & Capabilities

- **Admin Controls**: Dedicated container actions (`[START]`, `[STOP]`, `[RESTART]`, `[PAUSE]`) and guest visibility toggling.
- **Guest Read-Only View**: Lightweight public card view displaying live gauges and sparklines without access to sensitive container logs or environment variables.
- **Hardened Security**: Session-authenticated Socket.IO communication, stored XSS sanitization, and guest event isolation.
- **Offline / Air-Gapped Ready**: Self-contained CSS with zero external CDN script dependencies.
