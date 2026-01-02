# shared-things Behavioral Specification v2.0

This document describes the complete behavior of the shared-things sync system. It serves as the authoritative reference for how the system must work.

---

## 1. System Overview

### Purpose

Bidirectional sync of Things 3 todos between multiple macOS users via a central server.

### Actors

- **User A** (e.g., you) - macOS + Things 3 + daemon
- **User B** (e.g., Florian) - macOS + Things 3 + daemon
- **Server** - REST API + SQLite on VPS

### Core Principle

Each device's Things app is authoritative for that user's intent. The server is the coordination point that resolves conflicts using timestamps.

### Data Flow

```
Things App ──AppleScript──▶ Daemon ──HTTP──▶ Server ──HTTP──▶ Other Daemon ──URL Scheme──▶ Other Things
```

---

## 2. Identity Model

### The Problem

Things 3 assigns local IDs (`thingsId`) that differ per device. The same logical todo has different IDs on each Mac.

### The Solution

The server assigns a stable `serverId` (UUID). Each daemon maintains a `serverIdToThingsId` mapping.

```
Device A: thingsId="ABC" ◀──maps──▶ serverId="s1" ◀──maps──▶ thingsId="XYZ" :Device B
```

### Critical Invariant

The `serverIdToThingsId` map MUST be preserved. Loss of this mapping leads to duplicate todos.

---

## 3. State Management

### State File Location

`~/.shared-things/state.json`

### State File Structure

```json
{
  "lastSyncedAt": "2026-01-02T20:30:00.000Z",
  "todos": {
    "<thingsId>": {
      "thingsId": "ABC123",
      "title": "Buy milk",
      "notes": "",
      "dueDate": "2026-01-05",
      "tags": ["groceries"],
      "status": "open",
      "editedAt": "2026-01-02T20:25:00.000Z"
    }
  },
  "serverIdToThingsId": {
    "<serverId>": "<thingsId>"
  },
  "dirty": {
    "upserted": ["<thingsId>"],
    "deleted": {
      "<serverId>": "<deletedAt>"
    }
  }
}
```

### Guarantees

| Guarantee | Implementation |
|-----------|----------------|
| **Atomic writes** | Write to temp file, then `rename()`. Never partial writes. |
| **Backup on load** | Copy to `state.json.bak` before modifying. |
| **Validation** | If JSON invalid, refuse to sync (no silent reset). |
| **Dirty tracking** | Unpushed changes tracked for crash recovery. |

---

## 4. Sync Flow

```
┌─────────────────────────────────────────────────────────────┐
│                      SYNC CYCLE                              │
├─────────────────────────────────────────────────────────────┤
│ 1. ACQUIRE LOCK (sync.lock with PID)                        │
│    └─ If locked & process alive → skip cycle                │
│                                                              │
│ 2. LOAD STATE                                                │
│    └─ If invalid → ERROR, refuse to sync                    │
│                                                              │
│ 3. READ THINGS (AppleScript)                                 │
│    └─ Get all todos from configured project                 │
│                                                              │
│ 4. DETECT LOCAL CHANGES                                      │
│    ├─ New: not in state.todos → editedAt = now              │
│    ├─ Modified: different from state → editedAt = now       │
│    └─ Deleted: in state but not in Things                   │
│                                                              │
│ 5. PUSH TO SERVER                                            │
│    └─ Send upserts/deletes with editedAt timestamps         │
│                                                              │
│ 6. PROCESS PUSH RESPONSE                                     │
│    ├─ Record new serverId mappings                          │
│    └─ Log any conflicts                                      │
│                                                              │
│ 7. PULL FROM SERVER (GET /delta)                             │
│    └─ Get all changes since lastSyncedAt                    │
│                                                              │
│ 8. APPLY REMOTE CHANGES                                      │
│    ├─ No mapping → CREATE in Things                         │
│    ├─ Mapping + remote newer → UPDATE Things                │
│    └─ Mapping + local newer → SKIP (we win)                 │
│                                                              │
│ 9. SAVE STATE (atomic)                                       │
│                                                              │
│ 10. RELEASE LOCK                                             │
│     └─ Show notification if conflicts                       │
└─────────────────────────────────────────────────────────────┘
```

### Mutex

Only ONE sync runs at a time. Lock file with PID check prevents concurrent syncs.

---

## 5. Conflict Resolution

### Principle

**Last-EDIT-wins** based on client timestamps (not last-sync-wins).

### Edit-Edit Conflict

**Scenario:**
- You edit "Buy milk" → "Buy oat milk" at 10:00
- Florian edits same → "Buy almond milk" at 10:02
- You sync at 10:05 (later, but your edit was OLDER)

**Resolution:**
- Server compares: your `editedAt(10:00)` < stored `editedAt(10:02)`
- Result: Your edit REJECTED. Florian's version wins.
- Your daemon updates your Things with "Buy almond milk"

### Delete-Edit Conflict

**Scenario:**
- You delete "Buy milk" at 10:00 (`deletedAt=10:00`)
- Florian edits it at 10:02 (`editedAt=10:02`)

**Resolution:**
- Server compares: `deletedAt(10:00)` < `editedAt(10:02)`
- Result: Edit wins. Todo RESURRECTED with Florian's version.
- Your daemon re-creates it in your Things.

### Server Algorithm

```javascript
function shouldApplyChange(incoming, stored) {
  if (!stored) return true;                              // New item
  if (incoming.editedAt > stored.editedAt) return true;  // Incoming is newer
  if (incoming.editedAt === stored.editedAt) {
    return incoming.userId > stored.userId;              // Tiebreaker: lexicographic
  }
  return false;                                          // Stored is newer, reject
}
```

---

## 6. First Sync Procedure

### Requirement

The Things project **MUST be empty** when running `init`.

### Init Flow

```
shared-things init
  │
  ├─▶ Prompt: Server URL
  ├─▶ Prompt: API key
  ├─▶ Test connection (GET /health)
  ├─▶ List Things projects
  ├─▶ Prompt: Select project
  │
  ├─▶ VERIFY: Project has 0 todos
  │   └─ If not empty → ERROR "Project must be empty"
  │
  ├─▶ Save config.json
  ├─▶ Initialize state.json (lastSyncedAt = now)
  └─▶ Offer to install LaunchAgent
```

### Multi-User Setup Sequence

1. **User A:** Run `init` with empty project → create todos → sync
2. **User B:** Run `init` with empty project → sync → pulls A's todos

---

## 7. Offline Behavior

| Scenario | Behavior |
|----------|----------|
| **Offline for hours** | Edits timestamped when made. On reconnect, timestamps determine winner. |
| **Offline for weeks** | All changes sync in one batch. No limit. |
| **Both offline, both edit same** | Whoever edited LATER wins (by timestamp), regardless of sync order. |
| **Network fails mid-sync** | State not updated. Retry next cycle. Nothing lost. |
| **Server down** | Log error, keep local state, retry next cycle. |

### Guarantee

Local edits are NEVER lost due to being offline. Timestamps preserve the true edit time.

---

## 8. Error Handling

| Error | Response |
|-------|----------|
| State file missing | ERROR: Run `shared-things init` |
| State file corrupted | ERROR: Manual intervention required |
| Things project not found | ERROR: Update config or create project |
| Server unreachable | Log warning, retry next cycle |
| Auth failure (401) | ERROR: Check API key |
| Conflict from server | Accept server version, notify user |

### Recovery

`shared-things repair` diagnoses issues but does NOT auto-fix. This ensures the user is aware of any problems before data is modified.

---

## 9. CLI Commands

| Command | Purpose |
|---------|---------|
| `init` | First-time setup |
| `sync` | Run one sync cycle manually |
| `status` | Show sync status, pending changes, recent conflicts |
| `conflicts [--all]` | Show conflict history |
| `logs [--follow]` | View sync logs |
| `repair` | Diagnose state issues (no auto-fix) |
| `reset --local` | Clear local state, re-sync from server |
| `reset --server` | Clear server data for this user |
| `start` / `stop` | Control daemon |
| `doctor` | Comprehensive health check |

---

## 10. Logging & Notifications

### Log File

`~/.shared-things/sync.log`

### Log Format

```
[2026-01-02T21:30:00Z] [INFO] Sync started
[2026-01-02T21:30:00Z] [DEBUG] Loaded state: todos=5, mappings=5
[2026-01-02T21:30:00Z] [DEBUG] Local changes: 1 upserted
[2026-01-02T21:30:00Z] [DEBUG] Push payload: {...}
[2026-01-02T21:30:01Z] [INFO] Sync complete: pushed=1, pulled=1, conflicts=0
```

### Log Levels

- **ERROR** - Something failed, needs attention
- **WARN** - Something unexpected but handled
- **INFO** - High-level sync events (start, complete, counts)
- **DEBUG** - Detailed operations (payloads, mappings, decisions)

All levels are enabled by default.

### Conflict Log

`~/.shared-things/conflicts.json`

```json
[
  {
    "timestamp": "2026-01-02T21:30:00Z",
    "serverId": "s1",
    "title": "Buy milk",
    "yourVersion": {
      "title": "Buy oat milk",
      "editedAt": "2026-01-02T21:25:00Z"
    },
    "winningVersion": {
      "title": "Buy almond milk",
      "editedAt": "2026-01-02T21:27:00Z"
    },
    "reason": "Remote edit was newer"
  }
]
```

### macOS Notification

After sync completes, if conflicts occurred:

```
"Sync complete. 2 conflicts resolved (your edits were older).
 Run `shared-things conflicts` for details."
```

---

## 11. Server Behavior

### Database Schema

```sql
CREATE TABLE todos (
  id TEXT PRIMARY KEY,              -- serverId (UUID)
  title TEXT NOT NULL,
  notes TEXT DEFAULT '',
  due_date TEXT,
  tags TEXT,                        -- JSON array
  status TEXT CHECK (status IN ('open', 'completed', 'canceled')),
  position INTEGER,
  edited_at TEXT NOT NULL,          -- Client timestamp
  updated_at TEXT NOT NULL,         -- Server timestamp
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id)
);

CREATE TABLE deleted_items (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,          -- Deleted todo's serverId
  deleted_at TEXT NOT NULL,         -- Client timestamp
  deleted_by TEXT REFERENCES users(id)
);
```

### Push Handling

- **ALL operations in transaction** (atomic)
- Compare `editedAt` timestamps
- Reject older edits, return as conflicts
- Delete-vs-edit: newer wins (edit can resurrect deleted todo)

### Foreign Keys

`PRAGMA foreign_keys = ON` on every connection.

---

## 12. Things 3 Integration

| Operation | Method | Limitations |
|-----------|--------|-------------|
| Read todos | AppleScript | None |
| Create todo | URL Scheme | Cannot set completed status on create |
| Update todo | URL Scheme | Requires auth-token |
| Set completed | URL Scheme | Works with auth-token |
| Delete todo | — | NOT POSSIBLE (log only) |
| Set position | AppleScript | Research needed |
| Set heading | — | NOT SUPPORTED in v1 |

### Delimiter Safety

Escape `|||` and `^^^` in content before parsing to prevent injection.

### Finding New Todo After Create

1. Record set of thingsIds before create
2. Create via URL scheme
3. Wait 500ms
4. Re-read todos
5. Find todo where: thingsId not in before-set AND title matches exactly
6. Retry up to 3 times (1.5s total)

---

## 13. Guarantees

| Guarantee | Description |
|-----------|-------------|
| **G1: No Data Loss** | Local todos never lost from sync |
| **G2: No Silent Duplicates** | Duplication risk → halt and notify |
| **G3: Atomic Updates** | Crash at any point → consistent state |
| **G4: Conflict Transparency** | All conflicts logged and notified |
| **G5: Offline Resilience** | Timestamps preserve true edit time |

---

## 14. Invariants

These conditions must always be true:

| Invariant | Description |
|-----------|-------------|
| **I1** | `serverIdToThingsId` is 1:1 (no duplicate mappings) |
| **I2** | Mapped todos exist (or were deleted) |
| **I3** | State reflects last successful sync |
| **I4** | Dirty tracking is accurate |
| **I5** | Server eventually consistent after all syncs |

---

## 15. Edge Cases

| Case | Behavior |
|------|----------|
| Todo created during sync | Detected next cycle |
| Things not running | AppleScript launches it (or errors) |
| URL too long | Truncate for create, log warning |
| Special characters | Proper escaping throughout |
| Clock significantly wrong | Conflicts may resolve incorrectly (trust NTP) |
| Same title, different todos | Both exist (no deduplication by title) |

---

## Design Philosophy

This spec prioritizes **data integrity over convenience**. When in doubt, the system stops and asks for human intervention rather than potentially corrupting data.

Key principles:

1. **Never lose user data** - Local edits are always preserved until successfully synced
2. **Fail loudly** - Errors are surfaced, not hidden
3. **Transparency** - All conflicts and decisions are logged
4. **Recoverability** - State can always be diagnosed and manually corrected
