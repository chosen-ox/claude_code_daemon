# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build (compiles TypeScript + copies static GUI assets)
npm run build

# Run tests (146 unit + e2e tests)
npm test

# Run tests in watch mode
npm run test:watch

# Run a single test file
npx vitest run tests/unit/session/tmux-spawner.test.ts

# Lint
npm run lint

# Link globally after build
npm link
```

## Architecture

**cc-daemon** orchestrates Claude Code sessions for perpetual autonomous task execution across context window boundaries (the "Ralph Loop").

### Core Concept: Ralph Loop

When a Claude Code session's context approaches the threshold (default 80%), cc-daemon:
1. Sends a rotation signal to the session instructing it to write a state snapshot to `progress.md`
2. Detects `ROTATION_SNAPSHOT_COMPLETE` in tmux output (or monitors `progress.md` modification time as backup)
3. Kills the current session
4. Starts a fresh session with instructions to resume from `plan.md` + `progress.md`

### Two Execution Modes

- **Standard Mode**: Uses `@anthropic-ai/claude-agent-sdk` for in-process session control
- **Tmux Mode** (`--tmux`): Spawns Claude Code in tmux sessions with a custom socket (`-L cc-daemon`). Enables true context rotation and external monitoring. **All tmux commands must use `-L cc-daemon`.**

### Task File Protocol

Each task lives in `~/.cc-daemon/tasks/<task-id>/` with three files:
- `plan.md` — immutable task plan (goal, steps checklist, acceptance criteria)
- `progress.md` — mutable state (current status, completed steps, session history, blockers); the sole source of truth for resuming
- `metadata.json` — structured metadata for tracking (status, tokens, cost)

Task status in `progress.currentStatus` takes priority over `metadata.status` for real-time accuracy.

### Source Layout

```
src/
├── cli/index.ts              # All CLI command definitions (Commander.js)
├── session/
│   ├── monitor.ts            # JSONL file parsing, token usage extraction
│   ├── fr4-monitor.ts        # FR-4 context monitoring class
│   ├── tmux-spawner.ts       # tmux session management, snapshot detection signals
│   ├── tmux-ralph-executor.ts # Ralph Loop orchestration with retry/backoff
│   ├── ralph-executor.ts     # Standard mode Ralph Loop (SDK-based)
│   ├── rotation.ts           # Generates rotation/bootstrap instructions for Claude
│   ├── verification.ts       # Task verification logic
│   └── verification-executor.ts
├── task/manager.ts           # TaskManager class: CRUD for plan/progress/metadata files
├── types/index.ts            # All TypeScript types + MODEL_CONTEXT_LIMITS map
├── utils/
│   ├── paths.ts              # ~/.cc-daemon path helpers
│   └── id.ts                 # Task ID generation
└── gui/
    ├── server.ts             # Express HTTP server for the web GUI
    ├── index.ts              # GUI module exports
    └── static/               # Frontend HTML/CSS/JS (copied to dist/gui/ on build)
```

### Session-JSONL Binding

In tmux mode, cc-daemon generates a UUID and passes `--session-id <uuid>` to Claude Code. This creates a precise binding to `~/.claude/projects/<project-name>/<uuid>.jsonl` for accurate token monitoring without heuristic file searching.

**Path conversion**: Working directory → project name by removing leading `/` and replacing `/` and `_` with `-`.

### Manual Testing Convention

When manually testing cc-daemon (running tasks, spawning sessions, etc.), always use `workspace/` as the working directory to avoid polluting the project root:

```bash
mkdir -p workspace
cc-daemon ralph "some task" --tmux --working-dir workspace/
```

`workspace/` is gitignored. Never run ad-hoc tasks against the project root — files created by Claude sessions (scripts, notes, test outputs) should stay inside `workspace/`.

### Key Implementation Details

- `proper-lockfile` is used for concurrent-safe reads/writes to task files
- `chokidar` watches JSONL files for real-time token monitoring
- The GUI runs as a Node.js native HTTP server (default port 9876) serving static assets from `dist/gui/static/`
- E2E tests in `tests/e2e/` require real Claude API access; unit tests in `tests/unit/` mock all external calls
- `vitest` is the test runner; test files co-located with source files have been moved to `tests/unit/` matching the source structure
