# shared-things

Sync a Things 3 project between multiple users via a central server.

```mermaid
flowchart LR
    A[Things User A] <-->|AppleScript| DA[Daemon A]
    DA <-->|REST API| S[Server]
    S <-->|REST API| DB[Daemon B]
    DB <-->|AppleScript| B[Things User B]
```

## How It Works

1. Each user runs a local **daemon** that polls Things every 30 seconds
2. Changes are pushed to a central **server** (your own Hetzner VPS)
3. Other users pull changes and apply them locally via Things URL Scheme
4. Server is the **single source of truth** - last write wins on conflicts

## What Gets Synced

Within the shared project:
- Todos (title, notes, due date, tags, status)
- Headings (title, order)

Not synced:
- Checklist items (kept local)
- Areas (project must exist in both Things apps)

## Architecture

```
shared-things/
├── packages/
│   ├── common/      # Shared types & validation
│   ├── server/      # REST API + SQLite (runs on Hetzner)
│   └── daemon/      # macOS client (runs locally)
└── package.json     # pnpm workspace root
```

## Quick Start

### 1. Clone & Build

```bash
git clone https://github.com/moto-nrw/shared-things.git
cd shared-things
pnpm install
pnpm build
```

### 2. Server (one person hosts)

```bash
cd packages/server

# Create users
node dist/cli.js create-user --name "yonnock"
node dist/cli.js create-user --name "florian"
# → Save the API keys!

# Start server
PORT=3333 node dist/index.js
```

### 3. Client (each user)

```bash
cd packages/daemon
pnpm link --global

shared-things init
# → Server URL: http://localhost:3333 (or https://your-server.com)
# → API Key: <your key from step 2>
# → Project: <Things project to sync>
# → Things Token: <from Things → Settings → General → Things URLs>

shared-things install   # Auto-starts on login
```

### Updating

After pulling changes:

```bash
pnpm build
shared-things uninstall
shared-things install
```

## Commands

| Command | Description |
|---------|-------------|
| `init` | Setup wizard (server URL, API key, project, Things token) |
| `install` | Install launchd daemon (auto-starts on Mac login) |
| `uninstall` | Remove launchd daemon |
| `status` | Show sync status & last sync time |
| `sync` | Force immediate one-time sync |
| `logs` | Show daemon logs (`-f` to follow) |
| `daemon` | Run sync loop (used internally by launchd) |

## Server Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check (no auth required) |
| `GET /state` | Get full project state |
| `GET /delta?since=<timestamp>` | Get changes since timestamp |
| `POST /push` | Push local changes |

All endpoints except `/health` require `Authorization: Bearer <api-key>` header.

## Configuration

Config is stored in `~/.shared-things/config.json`:

```json
{
  "serverUrl": "https://things.yourdomain.com",
  "apiKey": "your-api-key",
  "projectName": "Shared Project",
  "pollInterval": 30,
  "thingsAuthToken": "your-things-token"
}
```

## Requirements

- **Server:** Linux/macOS, Node.js 18+
- **Client:** macOS, Things 3, Node.js 18+
- **Things:** URL Scheme must be enabled (Settings → General → Things URLs)

## Documentation

- [Server Deployment](docs/DEPLOYMENT.md) - Hetzner VPS setup with Caddy & systemd
- [Client Setup](docs/CLIENT.md) - macOS daemon installation & troubleshooting

## Security

- Each user has their own API key (hashed in database)
- All traffic should be over HTTPS in production
- Server tracks who changed what (`updatedBy` field)

## License

MIT
