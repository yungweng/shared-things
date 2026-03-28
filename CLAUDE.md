# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

shared-things syncs Things 3 between multiple macOS users via a central REST+WebSocket server. Each user runs a local daemon that watches the Things SQLite WAL file for changes, pushes to the server via REST, and receives real-time deltas via WebSocket. Supports syncing a single project or an entire area (including all projects within it).

## Commands

```bash
# Install dependencies & build all packages
pnpm install
pnpm build

# Build single package
pnpm --filter @shared-things/common build
pnpm --filter shared-things-server build
pnpm --filter shared-things-daemon build

# Linting & formatting (Biome — tabs, double quotes)
pnpm lint              # Check
pnpm lint:fix          # Auto-fix
pnpm typecheck         # TypeScript strict check

# Run server locally
node packages/server/dist/cli.js start --port 3334

# Run server via Docker
docker compose up -d

# Daemon CLI (after build)
node packages/daemon/dist/cli.js init
node packages/daemon/dist/cli.js sync
node packages/daemon/dist/cli.js daemon   # foreground mode (for debugging)
```

## Architecture

**Monorepo (pnpm workspaces):**

- `packages/common/` — Shared types (`Todo`, `PushTodo`, `SyncDelta`, `DaemonConfig`), WebSocket protocol (`ServerMessage`/`ClientMessage`), validation. Builds with `tsc`.
- `packages/server/` — Fastify REST API + WebSocket (`ws`) + SQLite (`better-sqlite3`). Builds with `tsup`, bundles common.
- `packages/daemon/` — macOS CLI (Commander.js + @inquirer/prompts). Interacts with Things via AppleScript (read/create/delete) and URL Scheme (update). Builds with `tsup`, bundles common.

**Event-driven sync flow:**

```
Things 3 writes → SQLite WAL changes → fs.watch fires (500ms debounce)
→ Daemon reads Things via AppleScript → diffs against local state
→ POST /push to server → server stores in SQLite
→ server sends WebSocket delta to other connected clients
→ remote daemon applies: AppleScript create / URL Scheme update / AppleScript delete
→ re-reads Things state to prevent false change detection on next sync
```

**Key daemon modules:**
- `watcher.ts` — `fs.watch` on Things WAL file, 60s fallback poll, auto-restart on WAL checkpoint
- `ws-client.ts` — WebSocket client with exponential backoff reconnect, emits `delta` and `reconnected` events
- `daemon.ts` — Orchestrator: connects watcher + WS + sync, 5s cooldown to avoid feedback loops, queues deltas during active sync
- `sync.ts` — `runSync()` (full push/pull cycle) and `applyDelta()` (lightweight remote-only apply). Reconciles existing Things todos with server on first sync to prevent duplicates
- `things.ts` — AppleScript integration. `createTodo` returns ID atomically (no polling). `deleteTodo` uses `move to list 9` (locale-independent trash). Area functions: `getTodosFromArea`, `createProjectInArea`, `createTodoInArea`
- `state.ts` — Local state (todos, serverIdToThingsId mapping, dirty tracking), file locking, conflict history

**Conflict resolution:** Last-write-wins by `editedAt` timestamp, user ID as tiebreaker for equal timestamps.

**Sync modes:** Config `syncMode` is `"project"` (single project) or `"area"` (all projects + loose todos within an area). Todos carry `projectName` metadata. Missing projects are auto-created on the remote side.

## Server

**Endpoints** (all except `/health` require `Authorization: Bearer <api-key>`):
- `GET /health` — No auth
- `GET /state` — Full state
- `GET /delta?since=<timestamp>` — Changes since timestamp
- `POST /push` — Push changes (triggers WebSocket notification to others)
- `DELETE /reset` — Delete all user's data
- `WS /ws` — Real-time deltas (auth via first message: `{ type: "auth", payload: { apiKey } }`)

**DB schema** (`better-sqlite3`, WAL mode): `users`, `todos` (with `project_name`), `deleted_items`, `schema_version`. Migrations run automatically on startup (checks schema version, adds columns as needed).

## Data Storage

- **Server:** `~/.shared-things-server/data.db` or `/data/data.db` (Docker volume)
- **Client:** `~/.shared-things/config.json`, `state.json`, `conflicts.json`, `sync.log`
- **LaunchAgent:** `~/Library/LaunchAgents/com.shared-things.daemon.plist`

## Things 3 AppleScript Limitations

- URL Scheme can update title, notes, due date, status — **not** tags or position
- `move to list 9` moves to trash (locale-independent) but cannot permanently delete
- `to dos of area` returns only loose todos, not todos inside projects — must iterate projects separately via `area of project` comparison
- File watcher may miss changes during WAL checkpoint (60s fallback poll handles this)
