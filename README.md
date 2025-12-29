<p align="center">
  <a href="https://www.npmjs.com/package/shared-things-daemon"><img src="https://img.shields.io/npm/v/shared-things-daemon.svg" alt="npm version"></a>
  <a href="https://github.com/yungweng/shared-things/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/shared-things-daemon.svg" alt="license"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/node/v/shared-things-daemon.svg" alt="node version"></a>
</p>

# shared-things

**Sync a Things 3 project between multiple macOS users**

Stop duplicating todos manually. shared-things keeps your team's Things 3 project in sync via a lightweight self-hosted server—perfect for shared shopping lists, family tasks, or team todos.

<!--
TODO: Add demo GIF showing sync in action
<p align="center">
  <img src="assets/demo.gif" alt="shared-things demo" width="600">
</p>
-->

## Quick Start

**Client (each user)**
```bash
npm install -g shared-things-daemon
shared-things init
```
That's it. Follow the prompts.

## Features

- 🔄 **Real-time sync** - Changes propagate within 30 seconds
- 🏠 **Self-hosted** - No cloud subscription, host on your own server
- 👥 **Multi-user** - Each person gets their own API key
- 🤫 **Background daemon** - Auto-starts on login, runs silently
- 🛠️ **Interactive CLI** - Easy setup wizard for configuration

## Prerequisites

- **macOS** with [Things 3](https://culturedcode.com/things/) installed
- **Node.js >= 18**
- A server running `shared-things-server` (see [Server Setup](#server-setup))

## Usage

### Interactive Mode

```bash
shared-things init
```
```
? Server URL: https://things.yourdomain.com
? API Key: ****
? Project name in Things: Shared Project
? Things auth token (optional):
```

### After Setup

```bash
shared-things install   # Start daemon (auto-runs on login)
shared-things status    # Check sync status
shared-things logs -f   # Follow sync logs
```

### All Commands

| Command | Description |
|---------|-------------|
| `init` | Setup wizard |
| `install` | Install launchd daemon (auto-starts on login) |
| `uninstall` | Remove launchd daemon |
| `status` | Show sync status & last sync time |
| `sync` | Force immediate sync |
| `logs [-f]` | Show logs (`-f` to follow) |
| `reset [--server]` | Reset local state (`--server` clears server too) |
| `purge` | Remove all local config |

## Server Setup

One person hosts the server. Everyone else just needs an API key.

```bash
# Install
npm install -g shared-things-server

# Create a user (generates API key)
shared-things-server create-user
# → User "alice" created. API key: sk_abc123...

# Start server
shared-things-server start -d --port 3334
```

### Server Commands

| Command | Description |
|---------|-------------|
| `start [-d] [-p port]` | Start server (`-d` for background) |
| `stop` | Stop background server |
| `status` | Show server status |
| `logs [-f]` | Show logs (`-f` to follow) |
| `create-user` | Create user and generate API key |
| `list-users` | List all users |
| `delete-user` | Delete a user |
| `reset` | Delete all todos (keeps users) |

<details>
<summary><strong>Production Deployment</strong></summary>

### systemd Service

```bash
sudo tee /etc/systemd/system/shared-things.service << 'EOF'
[Unit]
Description=shared-things sync server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/shared-things-server start --port 3334
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now shared-things
```

### HTTPS with Caddy

```
things.yourdomain.com {
    reverse_proxy localhost:3334
}
```

</details>

## What Syncs

| Synced | Not Synced |
|--------|------------|
| Todo title, notes, due date, tags | Completed todos |
| Headings | Checklist items |
| | Areas |

> **Note:** The project must exist in each user's Things app. Only items within that project sync.

## How It Works

```
Things User A ←→ Daemon A ←→ Server ←→ Daemon B ←→ Things User B
```

Each daemon polls Things every 30 seconds via AppleScript, pushes changes to the server, and pulls updates to apply via Things URL Scheme. Server is the single source of truth (last write wins).

## Development

```bash
git clone https://github.com/yungweng/shared-things.git
cd shared-things
pnpm install
pnpm build
```

## Contributing

Issues and PRs welcome! See [open issues](https://github.com/yungweng/shared-things/issues).

## Links

- [Repository](https://github.com/yungweng/shared-things)
- [Issues](https://github.com/yungweng/shared-things/issues)
- [npm (daemon)](https://www.npmjs.com/package/shared-things-daemon)
- [npm (server)](https://www.npmjs.com/package/shared-things-server)

## Author

Maintained by [@yungweng](https://github.com/yungweng)

## License

MIT
