# CC Session Daemon - Research Findings

## Overview

This document summarizes research findings from studying the OpenClaw codebase and `~/.claude/` directory structure to inform the CC Session Daemon implementation.

---

## 1. OpenClaw Codebase Patterns

### Session Management

**Key Pattern: Hierarchical Session Keys**
```
agent:<agentId>:<channel>:<type>:<identifier>
```

Examples:
- `agent:main:telegram:direct:123456789`
- `agent:main:subagent:<uuid>`
- `agent:main:cron:<cronId>:run:<runId>`

**Session Store** (`~/.openclaw/agents/<agentId>/sessions/sessions.json`):
- JSON file persistence with in-memory cache (45s TTL)
- Queue-based write locks for concurrent access
- Automatic pruning of stale entries (30 days default)
- Entry count capping (500 default) and file rotation (10MB)

**Session Entry Structure**:
```typescript
type SessionEntry = {
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
  spawnedBy?: string;
  spawnDepth?: number;
  chatType?: SessionChatType;
  thinkingLevel?: string;
  modelOverride?: string;
  // ... more fields
}
```

### Context Persistence

**Format**: JSONL files at `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`

**Header Structure**:
```json
{
  "type": "session",
  "version": 1,
  "id": "<sessionId>",
  "timestamp": "2026-02-28T00:00:00.000Z",
  "cwd": "/path/to/project"
}
```

**Message Format**: Each line is a JSON object with `type: "message"` and message content.

### Memory Systems

**Hybrid Search**: Combines vector embeddings with BM25 text search

**Key Features**:
- MMR (Maximal Marginal Relevance) for diversity
- Temporal decay for recency boosting
- Embedding cache with configurable max entries
- FTS-only mode when embeddings unavailable

**Session Memory Export**:
- Parses JSONL session files to extract user/assistant text
- Redacts sensitive text (API keys, etc.) before indexing
- Maps content to source JSONL line numbers

### Key Patterns for CC Daemon

1. **Singleton Caching**: Managers use cached singletons with composite keys
2. **JSONL Transcripts**: Efficient append/streaming for conversation history
3. **Lock-Based Concurrency**: Queue-based locks for session store writes
4. **Graceful Degradation**: FTS-only mode when embeddings unavailable

---

## 2. ~/.claude/ Directory Structure

### Key Files for Token Tracking

#### stats-cache.json
**Location**: `~/.claude/stats-cache.json`

**Structure**:
```json
{
  "version": 2,
  "lastComputedDate": "2026-02-18",
  "dailyModelTokens": [{
    "date": "2026-01-05",
    "tokensByModel": {
      "claude-sonnet-4-5-20250929": 66564
    }
  }],
  "modelUsage": {
    "claude-sonnet-4-5-20250929": {
      "inputTokens": 87867,
      "outputTokens": 506855,
      "cacheReadInputTokens": 114226571,
      "cacheCreationInputTokens": 13588537,
      "costUSD": 0
    }
  }
}
```

**Use for FR-4**: Contains per-model token usage statistics, but aggregated daily - not real-time.

#### projects/ Directory
**Structure**:
```
projects/
  -home-grads-jiakunfan-py-proj-claude-copilot/
    <session-id>.jsonl          # Main session transcript
    <session-id>/
      subagents/
        agent-<id>.jsonl        # Subagent transcripts
      tool-results/
        <id>.txt                # Tool execution results
```

**Session JSONL Content**: Contains full conversation including:
- System prompts and instructions
- User messages
- Assistant responses with thinking blocks
- Tool call definitions and results
- Token usage per message (in streaming responses)

**Use for FR-4**: Real-time token tracking by parsing session JSONL files.

#### history.jsonl
**Structure per entry**:
```json
{
  "display": "user input text",
  "pastedContents": {},
  "timestamp": 1762897195222,
  "project": "/home/grads/jiakunfan/py_proj/AgentSlice",
  "sessionId": "8bb6119f-266e-44ce-a87c-4cfd64105c36"
}
```

### Additional Useful Files

| Directory/File | Purpose | Relevance |
|----------------|---------|-----------|
| `shell-snapshots/` | Shell environment persistence | Session restoration |
| `file-history/` | Versioned file snapshots | Undo/audit trail |
| `todos/` | Task tracking per session | Task state |
| `tasks/` | Task queue management | Progress tracking |
| `debug/` | Debug logging | Troubleshooting |

---

## 3. Token Monitoring Strategy (FR-4)

Based on research, here are the paths for token monitoring:

### Path 1: Session JSONL Parsing (Recommended)
**Location**: `~/.claude/projects/<project>/<session-id>.jsonl`

**Method**: Watch and parse session JSONL files for `usage` fields in assistant messages.

**Pros**:
- Zero-intrusion
- Real-time updates
- Per-message granularity

**Cons**:
- File I/O overhead
- Need to handle concurrent writes

### Path 2: Agent SDK Streaming
**Method**: Use `@anthropic-ai/claude-agent-sdk` for daemon-managed sessions.

The SDK provides:
- Per-message `usage` data
- `total_cost_usd` in result messages
- Streaming events

**Pros**:
- Cleanest integration
- No file parsing needed
- Event-driven

**Cons**:
- Only works for daemon-managed sessions
- Requires SDK setup

### Path 3: tmux Injection (Fallback)
**Method**: Send `/cost` to running session via `tmux send-keys`.

**Pros**:
- Works with externally-started sessions

**Cons**:
- Intrusive
- Output parsing required
- May interrupt user

---

## 4. Task State Persistence Design (FR-3)

Based on OpenClaw patterns and plan requirements:

### File Structure
```
~/.cc-daemon/
├── tasks/
│   └── <task-id>/
│       ├── plan.md           # Immutable contract
│       ├── progress.md       # Mutable execution log
│       └── metadata.json     # Task metadata
├── sessions/
│   └── <session-id>.jsonl    # Session history
└── config.json               # Daemon configuration
```

### plan.md Format
```markdown
# Task: <title>

## Goal
<goal description>

## Steps
- [ ] Step 1: <description>
- [ ] Step 2: <description>
...

## Acceptance Criteria
- <criterion 1>
- <criterion 2>
```

### progress.md Format
```markdown
# Progress: <task-id>

## Current State
- Status: in_progress | blocked | completed
- Current Step: <step description>
- Session: <session-id>

## Completed Steps
- [x] Step 1 - <timestamp> - <notes>
- [x] Step 2 - <timestamp> - <notes>

## Key Decisions
- <decision 1>
- <decision 2>

## Artifacts
- <file path>: <description>

## Session History
| Session ID | Started | Duration | Steps | Tokens |
|------------|---------|----------|-------|--------|
| <id> | <time> | <dur> | <n> | <count> |

## Blockers
- <blocker description>
```

### metadata.json Format
```json
{
  "id": "<task-id>",
  "createdAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>",
  "status": "pending | active | completed | failed",
  "completionPromise": "DAEMON_COMPLETE",
  "totalSessions": 0,
  "totalTokens": 0,
  "totalCost": 0
}
```

---

## 5. Implementation Recommendations

### Phase 1: FR-3 Foundation
1. Create task file protocol (plan.md, progress.md, metadata.json)
2. Implement CLI commands: `init`, `create-task`, `list`, `resume`
3. Add session history tracking

### Phase 2: FR-4 Token Monitoring
1. Implement file watcher for session JSONL files
2. Parse usage data from streaming responses
3. Add threshold detection and alerts

### Phase 3: FR-1 Ralph Loop
1. Implement snapshot generation
2. Create session handoff mechanism
3. Build bootstrapping with context injection

### Phase 4: FR-2 Verification
1. Create isolated verification session
2. Implement verification report format
3. Build feedback loop for failures

---

## 6. Tech Stack Decisions

- **Runtime**: Node.js with TypeScript
- **CLI Framework**: Commander.js
- **Testing**: Vitest
- **Session Control**: `@anthropic-ai/claude-agent-sdk` (primary), `claude -p --output-format stream-json` (fallback)
- **File Watching**: chokidar
- **Locking**: proper-lockfile
