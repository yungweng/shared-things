# Client Setup (macOS)

Guide for setting up the shared-things daemon on your Mac.

## Prerequisites

- macOS
- Things 3 installed
- Node.js 18+
- The shared project must already exist in Things

## 1. Install

### From source

```bash
git clone https://github.com/YOUR_USERNAME/shared-things.git
cd shared-things
pnpm install
pnpm build

# Install daemon globally
cd packages/daemon
npm install -g .
```

### Verify installation

```bash
shared-things --version
```

## 2. Enable Things URL Scheme

The daemon needs the Things URL Scheme to be enabled:

1. Open **Things 3**
2. Go to **Things → Settings → General**
3. Enable **Things URLs**
4. Note the **Auth Token** (you'll need this for updates)

## 3. Create Shared Project

In Things, create a project that will be synced:

1. Create a new project (e.g., "Shared Tasks")
2. Note the exact project name

Both you and the other user must have a project with the **same name**.

## 4. Initialize

Run the setup wizard:

```bash
shared-things init
```

You'll be prompted for:

1. **Server URL** - e.g., `https://things.example.com`
2. **API Key** - Get this from whoever set up the server
3. **Project name** - The Things project to sync

Configuration is saved to `~/.shared-things/config.json`.

> The project must be empty when you run `init`.

## 5. Test Sync

Run a manual sync to verify everything works:

```bash
shared-things sync
```

## 6. Install Daemon

Install the launchd daemon for automatic syncing:

```bash
shared-things start
```

This creates a LaunchAgent that:
- Starts automatically at login
- Syncs every 30 seconds
- Restarts if it crashes

## Commands

| Command | Description |
|---------|-------------|
| `shared-things init` | Setup wizard |
| `shared-things start` | Start launchd daemon |
| `shared-things stop` | Stop launchd daemon |
| `shared-things status` | Show sync status |
| `shared-things sync` | Manual one-time sync |
| `shared-things logs` | Show sync logs |
| `shared-things logs -f` | Follow logs in real-time |
| `shared-things conflicts [--all]` | Show conflict history |
| `shared-things repair` | Diagnose state issues (no auto-fix) |
| `shared-things reset --local` | Clear local state |
| `shared-things reset --server` | Clear server data |
| `shared-things doctor` | Comprehensive health check |

## File Locations

| File | Purpose |
|------|---------|
| `~/.shared-things/config.json` | Configuration |
| `~/.shared-things/state.json` | Last sync state |
| `~/.shared-things/sync.log` | Sync logs |
| `~/Library/LaunchAgents/com.shared-things.daemon.plist` | LaunchAgent |

## Troubleshooting

### Daemon not running

Check status:

```bash
shared-things status
```

Check if launchd loaded it:

```bash
launchctl list | grep shared-things
```

Manually load:

```bash
launchctl load ~/Library/LaunchAgents/com.shared-things.daemon.plist
```

### Sync errors

Check logs:

```bash
shared-things logs -f
```

Common issues:
- **Connection refused** - Server not running or wrong URL
- **401 Unauthorized** - Invalid API key
- **Project not found** - Project name doesn't match Things

### Things not updating

The daemon can **create** new todos but has limitations for **updating** existing ones:

- Updates require the Things Auth Token
- Some changes may require manual action
- Check logs for "Update needed" or "manual action needed" messages

### Reset everything

```bash
shared-things stop
rm -rf ~/.shared-things
shared-things init
shared-things start
```

## How Sync Works

1. Daemon polls Things every 30 seconds via AppleScript
2. Detects new/changed/deleted todos
3. Pushes changes to server
4. Pulls changes from server
5. Creates new todos via Things URL Scheme
6. Logs any conflicts (last-write-wins)

### Limitations

- **Headings**: Currently not synced (AppleScript access is limited)
- **Checklists**: Not synced (kept local)
- **Deleting todos**: Server tracks deletions but cannot auto-delete in Things
- **Real-time**: Polling-based, not instant (30s delay)
