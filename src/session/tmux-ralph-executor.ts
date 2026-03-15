// Tmux Ralph Executor - Ralph Loop with true session rotation via tmux

import {
  TmuxClaudeSession,
  isTmuxAvailable,
  captureTmuxPane,
  sendTmuxKeys,
  killTmuxSession,
  listCcDaemonSessions,
  waitForSnapshotComplete,
  type TmuxSessionResult,
  type TmuxSpawnOptions,
  type SnapshotDetectionResult,
  ROTATION_SIGNAL
} from './tmux-spawner.js';
import { spawnWithCLI, isClaudeAvailable } from './spawner.js';
import { taskManager } from '../task/manager.js';
import { ensureDaemonDirs, getTasksDir } from '../utils/paths.js';
import { generateBootstrapInstructions, generateSnapshotInstructions, generateFixInstructions } from './rotation.js';
import { verifyTask, type VerificationExecutorResult } from './verification-executor.js';
import type { SessionRecord, TokenUsage } from '../types/index.js';
import * as path from 'path';
import * as fs from 'fs';
import { generateRevisePlan } from './verification.js';

export interface TmuxRalphConfig {
  completionPromise: string;
  maxIterations?: number;
  thresholdPercent?: number;
  snapshotReserveTokens?: number;
  effectiveContextLimitTokens?: number;
  sessionTimeout?: number;
  enableVerification?: boolean;
  maxVerificationCycles?: number;
  verbose?: boolean;
  onProgress?: (event: RalphProgressEvent) => void;
  // FR-4 Improvement 3: Error recovery with retry
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  // Working directory for tmux sessions
  workingDir?: string;
  // Inject /ralph-loop:ralph-loop skill at the start of the bootstrap prompt
  ralphLoopMode?: boolean;
}

// Verification loop state
enum VerificationLoopState {
  NONE = 'none',
  VERIFYING = 'verifying',
  FIXING = 'fixing'
}

export type RalphEventType =
  | 'session_start'
  | 'session_complete'
  | 'rotation_triggered'
  | 'rotation_complete'
  | 'completion_detected'
  | 'verification_start'
  | 'verification_pass'
  | 'verification_fail'
  | 'verification_retry'
  | 'error'
  | 'status';

export interface RalphProgressEvent {
  type: RalphEventType;
  taskId: string;
  sessionId?: string;
  iteration?: number;
  tokens?: TokenUsage;
  message?: string;
  error?: string;
  verificationResult?: VerificationExecutorResult;
}

export interface TmuxRalphResult {
  taskId: string;
  completed: boolean;
  verified: boolean;
  cancelled: boolean;
  totalSessions: number;
  totalIterations: number;
  totalRotations: number;
  totalTokens: TokenUsage;
  totalCost: number;
  duration: number;
  verificationResult?: VerificationExecutorResult;
  sessions: SessionRecord[];
  error?: string;
}

/**
 * Tmux Ralph Executor - Full Ralph Loop with tmux-based session rotation
 */
export class TmuxRalphExecutor {
  private config: Required<Omit<TmuxRalphConfig, 'onProgress' | 'sessionTimeout' | 'ralphLoopMode'>> & { onProgress?: (event: RalphProgressEvent) => void; sessionTimeout?: number; ralphLoopMode: boolean };
  private cancelled: boolean = false;
  private currentSession: TmuxClaudeSession | null = null;
  private rotationTriggeredForCurrentSession: boolean = false;
  // Verification loop state tracking
  private verificationState: VerificationLoopState = VerificationLoopState.NONE;
  private verificationAttempts: number = 0;

  constructor(config: TmuxRalphConfig) {
    this.config = {
      completionPromise: config.completionPromise,
      maxIterations: config.maxIterations ?? 100,
      thresholdPercent: config.thresholdPercent ?? 80,
      snapshotReserveTokens: config.snapshotReserveTokens ?? 8000,
      effectiveContextLimitTokens: config.effectiveContextLimitTokens ?? 150000,
      sessionTimeout: config.sessionTimeout,
      enableVerification: config.enableVerification ?? true,
      maxVerificationCycles: config.maxVerificationCycles ?? 3,
      verbose: config.verbose ?? false,
      onProgress: config.onProgress,
      // FR-4 Improvement 3: Retry configuration
      maxRetries: config.maxRetries ?? 3,
      retryBaseDelayMs: config.retryBaseDelayMs ?? 2000,
      retryMaxDelayMs: config.retryMaxDelayMs ?? 30000,
      workingDir: config.workingDir || process.cwd(),
      ralphLoopMode: config.ralphLoopMode ?? false,
    };
  }

  /**
   * Start the Ralph Loop with full rotation and verification support
   */
  async start(taskId: string): Promise<TmuxRalphResult> {
    const startTime = Date.now();
    const sessions: SessionRecord[] = [];
    let totalTokens: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    };
    let totalCost = 0;
    let totalRotations = 0;
    let completed = false;
    let verified = false;

    // Initialize
    await ensureDaemonDirs();

    // Get task
    const task = await taskManager.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Check tmux availability
    if (!(await isTmuxAvailable())) {
      throw new Error('tmux is not available. Please install tmux first.');
    }

    // Check Claude availability
    if (!(await isClaudeAvailable())) {
      throw new Error('Claude CLI is not available. Please install it first.');
    }

    this.emit('status', taskId, { message: `Starting Tmux Ralph Loop for task: ${taskId}` });

    // Mark task as active
    await taskManager.updateMetadata(taskId, { status: 'active' });

    let iteration = task.progress.sessionHistory.length + 1;

    // Main loop
    while (!completed && !this.cancelled && iteration <= this.config.maxIterations) {
      this.emit('session_start', taskId, { iteration, message: `Starting session ${iteration}` });

      // Generate bootstrap prompt
      let bootstrapPrompt = this.generateBootstrapPrompt(taskId, iteration);

      // If in fixing state, use fix instructions instead
      if (this.verificationState === VerificationLoopState.FIXING) {
        bootstrapPrompt = this.generateFixPrompt(taskId);
        this.emit('status', taskId, { message: 'Running FIX session...' });
      }

      // Run session with retry (FR-4 Improvement 3)
      let sessionResult: TmuxSessionResult;
      try {
        sessionResult = await this.runSessionWithRetry(taskId, iteration, bootstrapPrompt);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.emit('error', taskId, { error: `Session failed after retries: ${errorMsg}` });

        // Record failure and decide whether to continue
        await taskManager.updateProgress(taskId, (progress) => {
          progress.blockers.push(`Session ${iteration} failed: ${errorMsg}`);
          return progress;
        });

        // Continue to next iteration if not cancelled
        if (this.cancelled) break;
        iteration++;
        continue;
      }

      if (this.cancelled) break;

      // Record session
      const sessionRecord: SessionRecord = {
        sessionId: sessionResult.sessionId,
        startedAt: new Date(startTime).toISOString(),
        endedAt: new Date().toISOString(),
        duration: sessionResult.duration,
        stepsCompleted: 0,
        inputTokens: sessionResult.tokenUsage.inputTokens,
        outputTokens: sessionResult.tokenUsage.outputTokens,
        cacheReadTokens: sessionResult.tokenUsage.cacheReadInputTokens,
        cost: sessionResult.costUsd
      };

      sessions.push(sessionRecord);
      totalTokens.inputTokens += sessionResult.tokenUsage.inputTokens;
      totalTokens.outputTokens += sessionResult.tokenUsage.outputTokens;
      totalTokens.cacheReadInputTokens += sessionResult.tokenUsage.cacheReadInputTokens;
      totalTokens.cacheCreationInputTokens += sessionResult.tokenUsage.cacheCreationInputTokens;
      totalCost += sessionResult.costUsd;

      if (sessionResult.rotationRequested) {
        totalRotations++;
        this.emit('rotation_complete', taskId, {
          sessionId: sessionResult.sessionId,
          iteration,
          tokens: sessionResult.tokenUsage,
          message: `Session rotated after ${sessionResult.duration}ms`
        });
      }


      // Check for external kill - session was killed from outside
      if (sessionResult.externallyKilled) {
        this.emit('error', taskId, {
          error: 'Session was externally killed (tmux session terminated from outside)',
        });
        // Mark task as failed and don't continue to next iteration
        await taskManager.updateProgress(taskId, (progress) => {
          progress.blockers.push('Session was externally killed');
          return progress;
        });
        await taskManager.updateMetadata(taskId, { status: 'failed' });
        break;
      }

      // Add to task progress
      await taskManager.addSessionRecord(taskId, sessionRecord);

      // Check for completion promise (use session's own detection which filters echoed prompts)
      if (sessionResult.completionDetected) {
        // Handle completion based on current verification state
        if (this.verificationState === VerificationLoopState.NONE) {
          // Initial task completion - trigger verification
          this.emit('completion_detected', taskId, {
            message: `Task completion detected: ${this.config.completionPromise}`
          });

          if (this.config.enableVerification) {
            // Enter verification loop
            this.verificationState = VerificationLoopState.VERIFYING;
            this.verificationAttempts = 0;

            // Run verification
            const verifyResult = await this.runVerification(taskId);
            if (verifyResult.passed) {
              verified = true;
              completed = true;
              this.emit('verification_pass', taskId, {
                verificationResult: verifyResult,
                message: 'Task verified successfully'
              });
              break; // Exit loop - task is complete
            } else {
              // Verification failed - generate revise plan and start fix session
              this.emit('verification_fail', taskId, {
                verificationResult: verifyResult,
                message: `Verification failed. Starting fix session...`
              });

              // Generate revise plan
              await this.generateRevisePlanForTask(taskId, verifyResult);

              // Set state to fixing and continue to next iteration
              this.verificationState = VerificationLoopState.FIXING;
              this.verificationAttempts++;

              if (this.verificationAttempts >= this.config.maxVerificationCycles) {
                // Max cycles reached, task failed
                this.emit('error', taskId, {
                  error: `Max verification cycles (${this.config.maxVerificationCycles}) reached`
                });
                await taskManager.updateMetadata(taskId, { status: 'failed' });
                break;
              }

              // Continue to next iteration for fix session
              iteration++;
              continue;
            }
          } else {
            // Verification not enabled - task is complete
            completed = true;
            break;
          }
        } else if (this.verificationState === VerificationLoopState.FIXING) {
          // Fix session completed - verify the fixes
          this.emit('completion_detected', taskId, {
            message: 'Fix session completed. Re-running verification...'
          });

          // Run verification again
          const verifyResult = await this.runVerification(taskId);
          if (verifyResult.passed) {
            verified = true;
            completed = true;
            this.emit('verification_pass', taskId, {
              verificationResult: verifyResult,
              message: 'Fixes verified successfully'
            });
            break; // Exit loop - task is complete
          } else {
            // Verification still failing - generate new revise plan and try again
            this.emit('verification_fail', taskId, {
              verificationResult: verifyResult,
              message: `Verification still failing (attempt ${this.verificationAttempts + 1}/${this.config.maxVerificationCycles})`
            });

            // Generate updated revise plan
            await this.generateRevisePlanForTask(taskId, verifyResult);

            this.verificationAttempts++;
            if (this.verificationAttempts >= this.config.maxVerificationCycles) {
              // Max cycles reached, task failed
              this.emit('error', taskId, {
                error: `Max verification cycles (${this.config.maxVerificationCycles}) reached`
              });
              await taskManager.updateMetadata(taskId, { status: 'failed' });
              break;
            }

            // Continue fixing in next iteration
            iteration++;
            continue;
          }
        } else {
          // Unexpected state
          this.emit('error', taskId, {
            error: `Unexpected completion in verification state: ${this.verificationState}`
          });
          completed = true;
          break;
        }
      }

      this.emit('session_complete', taskId, {
        sessionId: sessionResult.sessionId,
        iteration,
        tokens: sessionResult.tokenUsage
      });

      iteration++;
    }

    // Finalize
    const duration = Date.now() - startTime;

    // BUG FIX: Clean up any remaining tmux sessions for this task
    // This ensures sessions are killed even if the task completes normally
    await this.cleanupRemainingSessions(taskId);

    // Update metadata with totals
    const metadataUpdates: Partial<import('../types/index.js').TaskMetadata> = {
      totalSessions: sessions.length,
      totalTokens: totalTokens.inputTokens + totalTokens.outputTokens,
      totalCost
    };

    if (completed && verified) {
      metadataUpdates.status = 'completed';
    } else if (completed && !verified && !this.config.enableVerification) {
      metadataUpdates.status = 'completed';
    } else if (this.cancelled) {
      metadataUpdates.status = 'cancelled';
    } else if (this.verificationAttempts >= this.config.maxVerificationCycles) {
      metadataUpdates.status = 'failed';
    }

    await taskManager.updateMetadata(taskId, metadataUpdates);

    return {
      taskId,
      completed,
      verified,
      cancelled: this.cancelled,
      totalSessions: sessions.length,
      totalIterations: iteration,
      totalRotations,
      totalTokens,
      totalCost,
      duration,
      sessions,
      error: this.verificationAttempts >= this.config.maxVerificationCycles
        ? 'Max verification cycles reached'
        : undefined
    };
  }

  /**
   * Check if rotation threshold is reached
   * Returns true if rotation was triggered
   */
  private async checkRotationThreshold(taskId: string, usage: TokenUsage, iteration: number): Promise<boolean> {
    // Guard: only trigger rotation once per session
    if (this.rotationTriggeredForCurrentSession) {
      return false;
    }

    const effectiveLimit = this.config.effectiveContextLimitTokens;
    const threshold = this.config.thresholdPercent / 100 * effectiveLimit;

    // Total context = input + cache_read + cache_creation (each turn's full input size)
    const totalContext = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;

    if (totalContext >= threshold && this.currentSession) {
      this.rotationTriggeredForCurrentSession = true;

      this.emit('rotation_triggered', taskId, {
        iteration,
        tokens: usage,
        message: `Context at ${((totalContext / effectiveLimit) * 100).toFixed(1)}% (${totalContext} tokens), forcing rotation`
      });

      // Force rotation by requesting it
      const tasksDir = getTasksDir();
      const progressPath = path.join(tasksDir, taskId, 'progress.md');
      const planPath = path.join(tasksDir, taskId, 'plan.md');
      await this.currentSession.requestRotation(progressPath, planPath);
      return true;
    }
    return false;
  }

  /**
   * Run verification (isolated, read-only check)
   */
  private async runVerification(taskId: string): Promise<VerificationExecutorResult> {
    this.emit('verification_start', taskId, {
      message: `Starting verification (attempt ${this.verificationAttempts + 1})`
    });

    return verifyTask(taskId, {
      maxCycles: 1, // One verification attempt - we manage the loop externally
      timeout: 10 * 60 * 1000,
      onProgress: (msg) => {
        this.emit('status', taskId, { message: msg });
      }
    });
  }

  /**
   * Generate revise plan from verification result
   */
  private async generateRevisePlanForTask(
    taskId: string,
    verifyResult: VerificationExecutorResult
  ): Promise<void> {
    const task = await taskManager.getTask(taskId);
    if (!task || !verifyResult.finalResult) {
      this.emit('error', taskId, { error: 'Cannot generate revise plan - task or result missing' });
      return;
    }

    const revisePlan = generateRevisePlan(task.plan, verifyResult.finalResult);
    const revisePlanPath = path.join(getTasksDir(), taskId, 'revise_plan.md');
    await fs.promises.writeFile(revisePlanPath, revisePlan);

    this.emit('status', taskId, {
      message: `Revise plan generated with ${verifyResult.finalResult.gaps.length} gaps`
    });
  }

  /**
   * Generate fix session prompt
   */
  private generateFixPrompt(taskId: string): string {
    const tasksDir = getTasksDir();
    const planPath = path.join(tasksDir, taskId, 'plan.md');
    const progressPath = path.join(tasksDir, taskId, 'progress.md');
    const revisePlanPath = path.join(tasksDir, taskId, 'revise_plan.md');

    return `
═══════════════════════════════════════════════════════════
FIX SESSION - VERIFICATION FAILED (Attempt ${this.verificationAttempts}/${this.config.maxVerificationCycles})
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
   * Generate bootstrap prompt
   */
  private generateBootstrapPrompt(taskId: string, iteration: number): string {
    const tasksDir = getTasksDir();
    const planPath = path.join(tasksDir, taskId, 'plan.md');
    const progressPath = path.join(tasksDir, taskId, 'progress.md');
    const revisePlanPath = path.join(tasksDir, taskId, 'revise_plan.md');

    let content = generateBootstrapInstructions(taskId);

    if (iteration > 1) {
      content += `\n\nIMPORTANT: This is iteration ${iteration}. Previous sessions have made progress.`;
      content += `\nRead ${progressPath} to see what was already done.`;
    }

    // Check if there's a revise_plan from failed verification
    if (fs.existsSync(revisePlanPath)) {
      content += `\n\n⚠️ VERIFICATION FEEDBACK:`;
      content += `\nThe previous implementation failed verification. Read the revise plan:`;
      content += `\n${revisePlanPath}`;
      content += `\nAddress the gaps identified before continuing.`;
    }

    if (this.config.completionPromise) {
      content += `\n\nWhen the task is FULLY complete, output exactly: <promise>${this.config.completionPromise}</promise>`;
    }

    if (this.config.ralphLoopMode) {
      // Wrap all content in quotes so ralph-loop skill receives it as its argument
      // Format: /ralph-loop:ralph-loop "PROMPT" --completion-promise "TEXT"
      // Escape both double quotes and newlines for proper command-line formatting
      const escaped = content.replace(/"/g, '\\"').replace(/\n/g, '\\n');
      if (this.config.completionPromise) {
        const escapedPromise = this.config.completionPromise.replace(/"/g, '\\"');
        return `/ralph-loop:ralph-loop "${escaped}" --completion-promise "${escapedPromise}"`;
      }
      return `/ralph-loop:ralph-loop "${escaped}"`;
    }

    return content;
  }

  /**
   * Cancel execution
   */
  cancel(): void {
    this.cancelled = true;
    if (this.currentSession) {
      this.currentSession.stop();
    }
  }

  /**
   * Clean up any remaining tmux sessions for a task
   * BUG FIX: Ensures sessions are killed when task completes
   */
  private async cleanupRemainingSessions(taskId: string): Promise<void> {
    try {
      const sessions = await listCcDaemonSessions();
      // The session name format is: cc-daemon-${taskId.slice(0, 8)}-${iteration}
      // where taskId includes the 'task-' prefix (e.g., 'task-abc123' -> 'cc-daemon-task-abc-1')
      const sessionPrefix = `cc-daemon-${taskId.slice(0, 8)}-`;

      // Find and kill any sessions matching this task ID pattern
      for (const sessionName of sessions) {
        if (sessionName.startsWith(sessionPrefix)) {
          try {
            await killTmuxSession(sessionName);
            if (this.config.verbose) {
              this.emit('status', taskId, { message: `Cleaned up session: ${sessionName}` });
            }
          } catch {
            // Session might already be gone
          }
        }
      }
    } catch (error) {
      // Ignore errors during cleanup
      if (this.config.verbose) {
        this.emit('error', taskId, { error: `Cleanup warning: ${error}` });
      }
    }
  }

  /**
   * Emit progress event
   */
  private emit(type: RalphEventType, taskId: string, data: Partial<RalphProgressEvent>): void {
    if (this.config.onProgress) {
      this.config.onProgress({
        type,
        taskId,
        ...data
      });
    }
  }

  // ============================================================================
  // FR-4 Improvement 3: Error Recovery with Retry
  // ============================================================================

  /**
   * Calculate delay with exponential backoff and jitter
   */
  private calculateRetryDelay(attempt: number): number {
    const baseDelay = this.config.retryBaseDelayMs;
    const maxDelay = this.config.retryMaxDelayMs;

    // Exponential backoff: baseDelay * 2^attempt
    const exponentialDelay = baseDelay * Math.pow(2, attempt);

    // Add jitter (±25%) to prevent thundering herd
    const jitter = 0.75 + Math.random() * 0.5;

    // Cap at max delay
    return Math.min(exponentialDelay * jitter, maxDelay);
  }

  /**
   * Execute a session with retry logic
   */
  private async runSessionWithRetry(
    taskId: string,
    iteration: number,
    bootstrapPrompt: string
  ): Promise<TmuxSessionResult> {
    let lastError: Error | null = null;
    const maxRetries = this.config.maxRetries;
    // Reset rotation flag for new session
    this.rotationTriggeredForCurrentSession = false;

    // Determine completion promise based on verification state
    const completionPromise = this.verificationState === VerificationLoopState.FIXING
      ? 'FIX_COMPLETE'
      : this.config.completionPromise;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.cancelled) {
        throw new Error('Execution cancelled');
      }

      try {
        // Create tmux session
        this.currentSession = new TmuxClaudeSession(
          taskId,
          iteration,
          {
            taskId,
            timeout: this.config.sessionTimeout,
            verbose: this.config.verbose,
            cwd: this.config.workingDir,
            ralphLoopMode: this.config.ralphLoopMode,
            onOutput: (chunk) => {
              if (this.config.verbose) {
                this.emit('status', taskId, { message: chunk.trim() });
              }
            },
            onTokenUpdate: async (usage) => {
              const totalCtx = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
              if (this.config.verbose) {
                this.emit('status', taskId, { message: `[DEBUG] Token update: total=${totalCtx} (input=${usage.inputTokens}, cache_read=${usage.cacheReadInputTokens}, cache_create=${usage.cacheCreationInputTokens}), threshold=${(this.config.thresholdPercent / 100 * this.config.effectiveContextLimitTokens).toFixed(0)}` });
              }
              await this.checkRotationThreshold(taskId, usage, iteration);
            },
            onRotationSignal: async () => {
              if (this.rotationTriggeredForCurrentSession) return;
              this.rotationTriggeredForCurrentSession = true;

              this.emit('rotation_triggered', taskId, {
                sessionId: this.currentSession?.getStatus().sessionId,
                iteration,
                message: 'Context threshold reached, preparing rotation'
              });

              if (this.currentSession) {
                const tasksDir = getTasksDir();
                const progressPath = path.join(tasksDir, taskId, 'progress.md');
                const planPath = path.join(tasksDir, taskId, 'plan.md');
                await this.currentSession.requestRotation(progressPath, planPath);
              }
            }
          },
          completionPromise
        );

        // Save current sessionId to progress for GUI tracking
        const currentSessionId = this.currentSession.getStatus().sessionId;
        await taskManager.updateProgress(taskId, (progress) => {
          progress.currentSessionId = currentSessionId;
          return progress;
        });

        // Run session
        const result = await this.currentSession.start(bootstrapPrompt);
        this.currentSession = null;

        // Clear currentSessionId after session ends
        await taskManager.updateProgress(taskId, (progress) => {
          progress.currentSessionId = undefined;
          return progress;
        });

        return result;

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is retryable
        const isRetryable = this.isRetryableError(lastError);

        if (attempt < maxRetries && isRetryable) {
          const delay = this.calculateRetryDelay(attempt);

          this.emit('error', taskId, {
            error: `Session failed (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}. Retrying in ${delay}ms...`
          });

          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, delay));

          // Update progress to indicate retry
          await taskManager.updateProgress(taskId, (progress) => {
            progress.blockers.push(`Session retry ${attempt + 1}: ${lastError?.message}`);
            return progress;
          });
        } else {
          // Non-retryable error or max retries reached
          throw lastError;
        }
      }
    }

    throw lastError || new Error('Max retries reached');
  }

  /**
   * Determine if an error is retryable
   */
  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();

    // Network/temporary errors
    if (message.includes('etimedout') ||
        message.includes('econnrefused') ||
        message.includes('econnreset') ||
        message.includes('enotfound')) {
      return true;
    }

    // tmux session issues
    if (message.includes('tmux') && (
        message.includes('no session') ||
        message.includes('not found'))) {
      return true;
    }

    // Rate limiting
    if (message.includes('rate limit') || message.includes('429')) {
      return true;
    }

    // Default: don't retry unknown errors
    return false;
  }

  /**
   * Wait for snapshot completion with dual detection (FR-4 Improvement 1 integration)
   */
  private async waitForRotationComplete(
    taskId: string,
    sessionName: string,
    timeout: number = 60000
  ): Promise<SnapshotDetectionResult> {
    return waitForSnapshotComplete(sessionName, {
      timeout,
      taskId,
      pollInterval: 500
    });
  }
}

/**
 * Quick start function for Tmux Ralph Loop
 */
export async function runTmuxRalphLoop(
  taskId: string,
  config: TmuxRalphConfig
): Promise<TmuxRalphResult> {
  const executor = new TmuxRalphExecutor(config);
  return executor.start(taskId);
}
