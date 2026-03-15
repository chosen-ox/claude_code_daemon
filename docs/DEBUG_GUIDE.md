# CC-Daemon Debug Guide

This guide helps debug session lifecycle issues, especially completion detection and auto-kill behavior.

## Debug Log File

**Location:** `/tmp/cc-daemon-debug.log`

**Enable:** Add `fs.appendFileSync` calls at the locations documented below.

## Key Debug Locations

### 1. pollOutput Entry Point
**File:** `src/session/tmux-spawner.ts`
**Line:** ~733 (inside `pollOutput()`)

```typescript
fs.appendFileSync('/tmp/cc-daemon-debug.log', `[${new Date().toISOString()}] pollOutput called, status=${this.status}, session=${this.tmuxSessionName}\n`);
```

**Purpose:** Track every time pollOutput is called, shows session status and name.

---

### 2. pollTokenUsage (JSONL Detection)
**File:** `src/session/tmux-spawner.ts`
**Lines:** ~914-938 (inside `pollTokenUsage()`)

```typescript
// Entry: Called every second
fs.appendFileSync('/tmp/cc-daemon-debug.log', `[${new Date().toISOString()}] pollTokenUsage called, JSONL path: ${jsonlPath}\n`);

// JSONL file not yet created
fs.appendFileSync('/tmp/cc-daemon-debug.log', `[${new Date().toISOString()}] pollTokenUsage: JSONL file does not exist yet\n`);

// Checking for completion promise
fs.appendFileSync('/tmp/cc-daemon-debug.log', `[${new Date().toISOString()}] pollTokenUsage: Checking JSONL for promise "${this.completionPromise}"\n`);

// COMPLETION DETECTED
fs.appendFileSync('/tmp/cc-daemon-debug.log', `[${new Date().toISOString()}] JSONL completion detected for promise: "${this.completionPromise}"\n`);
```

**Purpose:** Primary completion detection via JSONL. This is the most reliable method.

---

### 3. EXTRA CHECK (Pane Fallback)
**File:** `src/session/tmux-spawner.ts`
**Lines:** ~826-844 (inside `pollOutput()`, after `pollTokenUsage()`)

```typescript
// Condition check
fs.appendFileSync('/tmp/cc-daemon-debug.log', `[${new Date().toISOString()}] EXTRA CHECK: sessionExists=${sessionExists}, claudeStartedProcessing=${this.claudeStartedProcessing}, _completionDetected=${this._completionDetected}, rotationRequested=${this.rotationRequested}\n`);

// About to check pane content
fs.appendFileSync('/tmp/cc-daemon-debug.log', `[${new Date().toISOString()}] EXTRA CHECK: paneContent length=${paneContent.length}, checking for "${this.completionPromise}"\n`);

// Completion found
fs.appendFileSync('/tmp/cc-daemon-debug.log', `[${new Date().toISOString()}] EXTRA CHECK: Completion detected! Calling complete()\n`);

// Not found
fs.appendFileSync('/tmp/cc-daemon-debug.log', `[${new Date().toISOString()}] EXTRA CHECK: checkForCompletionIn returned FALSE\n`);

// Condition not met
fs.appendFileSync('/tmp/cc-daemon-debug.log', `[${new Date().toISOString()}] EXTRA CHECK: Condition NOT MET - sessionExists=${sessionExists}, claudeStartedProcessing=${this.claudeStartedProcessing}, _completionDetected=${this._completionDetected}, rotationRequested=${this.rotationRequested}\n`);
```

**Purpose:** Fallback completion detection via tmux pane. Handles ralph-loop return to REPL scenario.

---

### 4. checkForCompletionIn (Content Parsing)
**File:** `src/session/tmux-spawner.ts`
**Lines:** ~981, 988-989 (inside `checkForCompletionIn()`)

```typescript
// Rotation detected
require('fs').appendFileSync('/tmp/cc-daemon-debug.log', `[${new Date().toISOString()}] ROTATION_SNAPSHOT_COMPLETE detected\n`);

// Completion detected in line
require('fs').appendFileSync('/tmp/cc-daemon-debug.log', `[${new Date().toISOString()}] COMPLETION DETECTED: "${this.completionPromise}" in line: "${trimmed.substring(0, 100)}"\n`);

// Returning true
require('fs').appendFileSync('/tmp/cc-daemon-debug.log', `[${new Date().toISOString()}] Returning TRUE from checkForCompletionIn\n`);
```

**Purpose:** Low-level content parsing for rotation and completion signals.

---

## Expected Flow (Normal Completion)

```
1. pollOutput called (status=running, session=cc-daemon-task-xxx-1)
2. pollTokenUsage called, JSONL path: /Users/.../.claude/projects/.../uuid.jsonl
3. pollTokenUsage: Checking JSONL for promise "TASK_COMPLETE"
4. (repeat steps 1-3 every second)
5. JSONL completion detected for promise: "TASK_COMPLETE"
   → complete() called → session killed
```

## Expected Flow (Ralph Loop / REPL Return)

```
1. pollOutput called...
2. pollTokenUsage called... (no completion detected in JSONL)
3. EXTRA CHECK: sessionExists=true, claudeStartedProcessing=true, ...
4. EXTRA CHECK: paneContent length=5000, checking for "TASK_COMPLETE"
5. EXTRA CHECK: Completion detected! Calling complete()
   → complete() called → session killed
```

## Debugging Common Issues

### Issue: Task completed but session not killed

**Check:**
1. Is completion promise being output? Search JSONL for `<promise>TASK_COMPLETE</promise>`
2. Is completion detected in JSONL? Look for `JSONL completion detected` in debug log
3. Is EXTRA CHECK running? Look for `EXTRA CHECK` entries

**Possible causes:**
- Completion promise format doesn't match (case-sensitive, exact match required)
- JSONL file not being read (check path in debug log)
- `_completionDetected` or `rotationRequested` flags preventing EXTRA CHECK

### Issue: Session killed too early

**Check:**
1. What triggered completion? Look for `COMPLETION DETECTED` entries with line content
2. Was it echoed prompt? Check if `claudeStartedProcessing` was true

### Issue: Rotation not working

**Check:**
1. Is `ROTATION_SNAPSHOT_COMPLETE` being output? Look for detection in debug log
2. Is `rotationRequested` flag being set correctly?

## Quick Debug Commands

```bash
# Watch debug log in real-time
tail -f /tmp/cc-daemon-debug.log

# Search for completion detection
grep "COMPLETION DETECTED\|JSONL completion\|EXTRA CHECK.*Completion" /tmp/cc-daemon-debug.log

# Check flow for specific task
grep "task-abc123" /tmp/cc-daemon-debug.log

# See what's being checked in EXTRA CHECK
grep "EXTRA CHECK.*checking for" /tmp/cc-daemon-debug.log

# Check rotation detection
grep "ROTATION" /tmp/cc-daemon-debug.log
```

## Re-enabling Debug Logs

To re-enable debug logs, add the `fs.appendFileSync` calls at the locations documented above. The `fs` module is already imported at the top of the file.

**Example pattern:**
```typescript
// At the start of the function you want to debug
fs.appendFileSync('/tmp/cc-daemon-debug.log', `[${new Date().toISOString()}] FUNCTION_NAME called, var1=${var1}, var2=${var2}\n`);
```

**Remember to remove debug logs before committing!**
