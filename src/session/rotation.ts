// Ralph Loop - Cross-session rotation logic

import type { TaskMetadata, TaskProgress, SessionRecord } from '../types/index.js';
import { taskManager } from '../task/manager.js';
import { generateSessionId } from '../utils/id.js';
import { getPlanPath, getProgressPath, getTasksDir } from '../utils/paths.js';
import { calculateContextStatus, watchSessionTokens } from './monitor.js';

export interface RotationConfig {
  thresholdPercent: number;
  snapshotReserveTokens: number;
  effectiveContextLimitTokens: number;
  maxIterations: number;
  completionPromise: string;
}

export interface RotationState {
  taskId: string;
  sessionId: string;
  iteration: number;
  startedAt: Date;
  lastRotation?: Date;
}

const DEFAULT_CONFIG: RotationConfig = {
  thresholdPercent: 80,
  snapshotReserveTokens: 8000,
  effectiveContextLimitTokens: 150000,
  maxIterations: 100,
  completionPromise: ''
};

/**
 * Generate snapshot instructions for the current session
 */
export function generateSnapshotInstructions(taskId: string): string {
  return `
═══════════════════════════════════════════════════════════
CONTEXT ROTATION - SNAPSHOT REQUIRED
═══════════════════════════════════════════════════════════

⚠️ STOP ALL WORK IMMEDIATELY ⚠️

The context window is approaching capacity. You must STOP your current work and create a snapshot NOW.

DO NOT continue with any task execution. STOP and SAVE STATE ONLY.

1. Update progress.md with current state:
   - Mark completed steps as [x]
   - Add any key decisions made
   - List artifacts created
   - Note any blockers

2. Write comprehensive state including:
   - What you were working on
   - What's left to do
   - Important context for the next session

Files to update:
   - Progress: ${getProgressPath(taskId)}

DO NOT modify plan.md - only toggle checkboxes [ ] → [x]

AFTER updating progress.md, output exactly: ROTATION_SNAPSHOT_COMPLETE
Then STOP and wait for further instructions.

═══════════════════════════════════════════════════════════
`;
}

/**
 * Generate bootstrap instructions for a new session
 */
export function generateBootstrapInstructions(taskId: string): string {
  return `
═══════════════════════════════════════════════════════════
SESSION RESUMPTION - READ TASK STATE
═══════════════════════════════════════════════════════════

You are continuing a task from a previous session. Read the task state files:

1. First, read the plan:
   ${getPlanPath(taskId)}

2. Then, read the progress:
   ${getProgressPath(taskId)}

3. Continue from where the last session left off:
   - Check which steps are already completed
   - Resume work on the current/next step
   - Update progress.md as you complete work

IMPORTANT:
- NEVER modify plan.md content - only toggle checkboxes
- ALWAYS update progress.md after each step
- This enables seamless continuation across sessions

STATUS VALUES (for progress.md Status field):
When updating the Status field in progress.md, ONLY use these values:
- pending (task not started)
- active (task in progress)
- completed (task finished successfully)
- failed (task failed with error)
- cancelled (task was cancelled)

═══════════════════════════════════════════════════════════
`;
}

/**
 * Generate verification instructions for a clean session
 */
export function generateVerificationInstructions(taskId: string): string {
  return `
═══════════════════════════════════════════════════════════
TASK VERIFICATION - CLEAN SESSION
═══════════════════════════════════════════════════════════

You are a VERIFIER in a completely clean session with NO prior context.

Your task is to STRICTLY verify that the implementation matches the plan.

1. Read ONLY the plan file:
   ${getPlanPath(taskId)}

2. DO NOT read progress.md or any session history.

3. CRITICAL: Perform THOROUGH verification:
   - Read the plan's GOAL carefully - extract ALL requirements
   - For file creation tasks: VERIFY EXACT FILE CONTENTS match the goal
   - For tasks with "exact content" or specific values: VERIFY PRECISELY
   - Check each step in the plan is TRULY completed
   - DO NOT assume - VERIFY everything explicitly

4. Use READ-ONLY tools only (no Write/Edit).
   - Use Read tool to check file contents
   - Use Glob tool to find files
   - Verify EXACT matches, not "close enough"

5. IMPORTANT: Be STRICT and THOROUGH:
   - If the goal says "exact content X", the file MUST contain exactly X
   - If verification fails, you MUST list the specific gaps
   - "Good enough" is NOT acceptable - must match plan exactly

6. Produce a structured verification report:

## Verification Report: ${taskId}

### Summary
- PASS / FAIL (based on STRICT verification)

### Step Verification
| Step | Status | Notes |
|------|--------|-------|
| ... | ✓/✗ | ... |

### Acceptance Criteria
| Criterion | Status | Evidence |
|-----------|--------|----------|
| ... | ✓/✗ | ... |

### Gaps Found
- [List SPECIFIC gaps between plan and implementation]
- [Include EXACT differences found]

### Recommendations
- [If FAIL, specific EXACT changes needed]

═══════════════════════════════════════════════════════════
`;
}

/**
 * Generate fix session instructions after verification failure
 */
export function generateFixInstructions(taskId: string): string {
  const tasksDir = getTasksDir();
  const planPath = getPlanPath(taskId);
  const progressPath = getProgressPath(taskId);
  const revisePlanPath = `${tasksDir}/${taskId}/revise_plan.md`;

  return `
═══════════════════════════════════════════════════════════
FIX SESSION - VERIFICATION FAILED
═══════════════════════════════════════════════════════════

The previous implementation failed verification. You must fix the issues.

1. Read the plan:
   ${planPath}

2. Read the progress:
   ${progressPath}

3. Read the revise plan (THIS IS CRITICAL):
   ${revisePlanPath}

4. Execute the fixes identified in the revise plan:
   - Follow each step listed in the revise plan
   - Update progress.md as you complete each fix
   - You MAY use Write/Edit tools to make fixes

5. When ALL fixes are complete, output exactly:
   <promise>FIX_COMPLETE</promise>

IMPORTANT:
- The revise_plan.md contains the exact gaps found and how to fix them
- Focus ONLY on the issues identified in the revise plan
- Update progress.md to track your fixes
- Output FIX_COMPLETE when done (this will trigger re-verification)

═══════════════════════════════════════════════════════════
`;
}

/**
 * Ralph Loop Controller
 */
export class RalphLoopController {
  private config: RotationConfig;
  private state: RotationState | null = null;
  private tokenWatcher: { stop: () => void } | null = null;

  constructor(config: Partial<RotationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the Ralph Loop for a task
   */
  async start(taskId: string): Promise<void> {
    const task = await taskManager.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const sessionId = generateSessionId();
    this.state = {
      taskId,
      sessionId,
      iteration: task.progress.sessionHistory.length + 1,
      startedAt: new Date()
    };

    // Update task status
    await taskManager.updateMetadata(taskId, { status: 'active' });
    await taskManager.updateProgress(taskId, {
      currentSessionId: sessionId,
      currentStatus: 'active'
    });

    // Print bootstrap instructions
    console.log(generateBootstrapInstructions(taskId));
  }

  /**
   * Monitor token usage and trigger rotation when needed
   */
  async monitorAndRotate(
    taskId: string,
    sessionFilePath: string,
    onRotate: () => Promise<void>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.tokenWatcher = watchSessionTokens(
        sessionFilePath,
        async (usage, cumulative) => {
          const status = calculateContextStatus(cumulative, {
            effectiveContextLimit: this.config.effectiveContextLimitTokens,
            thresholdPercent: this.config.thresholdPercent,
            snapshotReserveTokens: this.config.snapshotReserveTokens
          });

          console.log(`Context: ${status.percentUsed.toFixed(1)}% (${status.usedTokens.toLocaleString()} / ${status.totalTokens.toLocaleString()} tokens)`);

          if (status.emergencyRotate) {
            console.log('\n⚠️  EMERGENCY ROTATION - Context critically low!\n');
            console.log(generateSnapshotInstructions(taskId));
            await onRotate();
            resolve();
            return;
          }

          if (status.shouldRotate) {
            console.log('\n🔄 Planned rotation - Context threshold reached\n');
            console.log(generateSnapshotInstructions(taskId));
            await onRotate();
            resolve();
            return;
          }
        }
      );
    });
  }

  /**
   * Complete a session rotation
   */
  async completeRotation(sessionRecord: SessionRecord): Promise<void> {
    if (!this.state) return;

    const { taskId } = this.state;

    // Add session record to progress
    await taskManager.addSessionRecord(taskId, sessionRecord);

    // Update metadata
    const task = await taskManager.getTask(taskId);
    if (task) {
      await taskManager.updateMetadata(taskId, {
        totalSessions: task.progress.sessionHistory.length,
        totalTokens: task.metadata.totalTokens +
          sessionRecord.inputTokens + sessionRecord.outputTokens,
        totalCost: task.metadata.totalCost + sessionRecord.cost
      });
    }

    // Check max iterations
    if (this.state.iteration >= this.config.maxIterations) {
      console.log(`\nMax iterations (${this.config.maxIterations}) reached. Stopping.`);
      await this.stop();
    }
  }

  /**
   * Stop the Ralph Loop
   */
  async stop(): Promise<void> {
    if (this.tokenWatcher) {
      this.tokenWatcher.stop();
      this.tokenWatcher = null;
    }

    if (this.state) {
      await taskManager.updateMetadata(this.state.taskId, { status: 'completed' });
      this.state = null;
    }
  }

  /**
   * Check if completion promise is met
   */
  checkCompletionPromise(text: string): boolean {
    if (!this.config.completionPromise) return false;
    return text.includes(`<promise>${this.config.completionPromise}</promise>`);
  }
}

/**
 * Create a default controller instance
 */
export function createRalphController(config: Partial<RotationConfig> = {}): RalphLoopController {
  return new RalphLoopController(config);
}
