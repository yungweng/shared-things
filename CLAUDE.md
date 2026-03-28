# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

shared-things (v3) syncs a Things 3 project between multiple macOS users via a central REST+WebSocket server. Each user runs a local daemon that watches the Things SQLite WAL file for changes, pushes to the server via REST, and receives real-time deltas via WebSocket.

## Commands

```bash
# Install dependencies & build all packages
pnpm install
pnpm build

# Development (watch mode for all packages)
pnpm dev

# Linting & formatting (Biome)
pnpm lint              # Check for issues
pnpm lint:fix          # Auto-fix issues
pnpm format            # Format code

# Type checking
pnpm typecheck

# Build single package
pnpm --filter @shared-things/server build
pnpm --filter @shared-things/daemon build
pnpm --filter @shared-things/common build

# Run server locally
node packages/server/dist/cli.js start --port 3334

# Run server via Docker
docker compose up -d

# Create server users
node packages/server/dist/cli.js create-user

# Test daemon locally (after build)
node packages/daemon/dist/cli.js init
node packages/daemon/dist/cli.js sync
```

## Code Style

Biome enforces tabs for indentation and double quotes. Run `pnpm lint:fix` before committing.

## Architecture

**Monorepo structure with pnpm workspaces:**

- `packages/common/` - Shared TypeScript types, WebSocket protocol definitions, validation
- `packages/server/` - Fastify REST API + WebSocket (ws) with SQLite (better-sqlite3)
- `packages/daemon/` - macOS CLI client using Commander.js, interacts with Things via AppleScript

**Data flow (v3 — event-driven):**

1. `fs.watch` on Things SQLite WAL file detects local changes (no polling)
2. Daemon reads Things project via AppleScript, diffs against local state
3. Pushes changes to server via `POST /push`
4. Server processes changes, notifies other clients via WebSocket
5. Remote clients apply changes: create (AppleScript), update (URL Scheme), delete (AppleScript move to Papierkorb)

**Key v3 improvements over v2:**
- File watcher replaces 30s polling (with 60s fallback poll)
- WebSocket for server→client push (no client-side polling for remote changes)
- AppleScript `make new to do` returns ID atomically (no findNewTodo retry loop)
- Deletion via AppleScript `move to list "Papierkorb"` (v2 couldn't delete)

**ID mapping:** Server uses its own UUIDs (`id`), while Things has different IDs (`thingsId`). Each daemon maintains a `serverIdToThingsId` map in local state.

## Server Endpoints

- `GET /health` - No auth required
- `GET /state` - Full project state
- `GET /delta?since=<timestamp>` - Changes since timestamp
- `POST /push` - Push local changes (triggers WebSocket notification to others)
- `DELETE /reset` - Delete all user's data
- `WS /ws` - WebSocket for real-time deltas (auth via first message)

All except `/health` require `Authorization: Bearer <api-key>` header.

## Data Storage

- **Server:** `~/.shared-things-server/data.db` (SQLite) or `/data/data.db` (Docker)
- **Client:** `~/.shared-things/config.json`, `~/.shared-things/state.json`
- **LaunchAgent:** `~/Library/LaunchAgents/com.shared-things.daemon.plist`

## Docker

```bash
docker compose up -d                    # Start server
docker compose exec shared-things \
  node packages/server/dist/cli.js create-user  # Create user inside container
```

## Limitations

- Things URL Scheme can update title, notes, due date, status — but not tags or position
- File watcher may miss changes during WAL checkpoint (60s fallback poll handles this)
- AppleScript move to Papierkorb works but cannot permanently delete
