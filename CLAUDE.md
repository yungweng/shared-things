# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

shared-things syncs a Things 3 project between multiple macOS users via a central REST server. Each user runs a local daemon that polls Things every 30 seconds, pushes changes to the server, and pulls changes to apply locally via Things URL Scheme.

## Commands

```bash
# Install dependencies & build all packages
pnpm install
pnpm build

# Development (watch mode for all packages)
pnpm dev

# Build single package
pnpm --filter @shared-things/server build
pnpm --filter @shared-things/daemon build
pnpm --filter @shared-things/common build

# Run server locally (development)
node packages/server/dist/cli.js start --port 3334

# Create server users (interactive prompt)
node packages/server/dist/cli.js create-user

# Test daemon locally (after build)
node packages/daemon/dist/cli.js init
node packages/daemon/dist/cli.js sync
```

## Published Packages

- `shared-things-daemon` - CLI client for macOS users
- `shared-things-server` - Self-hosted sync server

Internal workspace packages use `@shared-things/*` naming.

## Architecture

**Monorepo structure with pnpm workspaces:**

- `packages/common/` - Shared TypeScript types (`Todo`, `Heading`, `ProjectState`, `SyncDelta`, `PushRequest`) and validation utilities
- `packages/server/` - Fastify REST API with SQLite (better-sqlite3), runs on Linux VPS
- `packages/daemon/` - macOS CLI client using Commander.js, interacts with Things via AppleScript/osascript

**Data flow:**

1. Daemon reads Things via AppleScript (`things.ts`)
2. Detects changes by comparing against local state file (`~/.shared-things/state.json`)
3. Pushes changes to server with `serverIdToThingsId` mapping for cross-device correlation
4. Pulls delta from server, creates/updates todos via Things URL Scheme

**Key sync detail:** Server uses its own IDs (`id` field), while Things has different IDs (`thingsId`). The daemon maintains a `serverIdToThingsId` map in local state to correlate items across devices.

## Server Endpoints

- `GET /health` - No auth required
- `GET /state` - Full project state
- `GET /delta?since=<timestamp>` - Changes since timestamp
- `POST /push` - Push local changes
- `DELETE /reset` - Delete all user's data (clean slate)

All except `/health` require `Authorization: Bearer <api-key>` header.

## Data Storage

- **Server:** `~/.shared-things-server/data.db` (SQLite)
- **Client:** `~/.shared-things/config.json`, `~/.shared-things/state.json`
- **LaunchAgent:** `~/Library/LaunchAgents/com.shared-things.daemon.plist`

## Limitations

- Things URL Scheme can create todos but has limited update capabilities (requires auth token)
- Deletions are tracked but cannot be auto-executed in Things
- Headings sync support is partial due to AppleScript limitations
- Polling-based (30s interval), not real-time
