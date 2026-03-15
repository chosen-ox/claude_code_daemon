// Ralph Executor - Complete Ralph Loop execution

import { spawnWithCLI, spawnWithStreaming, isClaudeAvailable, type SpawnResult, type ClaudeMessage } from './spawner.js';
import { initRegistry, registerSession, updateSessionStatus, updateSessionTokens, completeSession, terminateSession, type ActiveSession } from './lifecycle.js';
import { RalphLoopController, generateBootstrapInstructions, generateSnapshotInstructions, type RotationConfig } from './rotation.js';
import { watchSessionTokens, calculateContextStatus } from './monitor.js';
import { taskManager } from '../task/manager.js';
import { ensureDaemonDirs, getSessionPath } from '../utils/paths.js';
import type { SessionRecord, TokenUsage } from '../types/index.js';

export interface RalphExecutorConfig extends RotationConfig {
  sessionTimeout?: number;
  pollInterval?: number;
  onProgress?: (event: ProgressEvent) => void;
}

export type ProgressEventType =
  | 'session_start'
  | 'session_complete'
  | 'rotation'
  | 'completion_detected'
  | 'error'
  | 'status';

export interface ProgressEvent {
  type: ProgressEventType;
  taskId: string;
  sessionId?: string;
  iteration?: number;
  tokens?: TokenUsage;
  message?: string;
  error?: string;
}

export interface RalphExecutionResult {
  taskId: string;
  completed: boolean;
  cancelled: boolean;
  totalSessions: number;
  totalTokens: TokenUsage;
  totalCost: number;
  duration: number;
  sessions: SessionRecord[];
  error?: string;
}

/**
 * Ralph Loop Executor - executes the complete Ralph Loop
 */
export class RalphExecutor {
  private config: RalphExecutorConfig;
  private controller: RalphLoopController;
  private cancelled = false;
  private currentSessionId: string | null = null;
  private currentProcess: ReturnType<typeof spawnWithStreaming>['process'] | null = null;

  constructor(config: Partial<RalphExecutorConfig> = {}) {
    this.config = {
      thresholdPercent: 80,
      snapshotReserveTokens: 8000,
      effectiveContextLimitTokens: 150000,
      maxIterations: 100,
      completionPromise: '',
      sessionTimeout: 30 * 60 * 1000, // 30 minutes
      pollInterval: 1000,
      ...config
    };
    this.controller = new RalphLoopController(this.config);
  }

  /**
   * Start the Ralph Loop execution
   */
  async start(taskId: string): Promise<RalphExecutionResult> {
    const startTime = Date.now();
    const sessions: SessionRecord[] = [];
    let totalTokens: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    };
    let totalCost = 0;
    let completed = false;

    // Initialize
    await ensureDaemonDirs();
    await initRegistry();

    // Get task
    const task = await taskManager.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Check Claude availability
    if (!(await isClaudeAvailable())) {
      throw new Error('Claude CLI is not available. Please install it first.');
    }

    // Start the controller
    await this.controller.start(taskId);

    let iteration = task.progress.sessionHistory.length + 1;

    this.emit('status', taskId, { message: `Starting Ralph Loop for task: ${taskId}` });

    // Main loop
    while (!completed && !this.cancelled && iteration <= this.config.maxIterations) {
      this.emit('session_start', taskId, { iteration, message: `Starting session ${iteration}` });

      // Generate bootstrap prompt
      const bootstrapPrompt = this.generateBootstrapPrompt(taskId, iteration);

      // Spawn session with streaming
      const sessionResult = await this.runSession(taskId, bootstrapPrompt, iteration);

      if (this.cancelled) {
        break;
      }

      // Record session
      const sessionRecord: SessionRecord = {
        sessionId: sessionResult.sessionId,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        duration: sessionResult.duration,
        stepsCompleted: 0,
        inputTokens: sessionResult.tokenUsage.inputTokens,
        outputTokens: sessionResult.tokenUsage.outputTokens,
        cacheReadTokens: sessionResult.tokenUsage.cacheReadInputTokens,
        cost: sessionResult.cost_usd || 0
      };

      sessions.push(sessionRecord);
      totalTokens.inputTokens += sessionResult.tokenUsage.inputTokens;
      totalTokens.outputTokens += sessionResult.tokenUsage.outputTokens;
      totalTokens.cacheReadInputTokens += sessionResult.tokenUsage.cacheReadInputTokens;
      totalTokens.cacheCreationInputTokens += sessionResult.tokenUsage.cacheCreationInputTokens;
      totalCost += sessionRecord.cost;

      // Add to task progress
      await taskManager.addSessionRecord(taskId, sessionRecord);

      // Check for completion promise (support both <promise>GOAL</promise> and plain GOAL format)
      if (this.config.completionPromise && (
          sessionResult.output.includes(`<promise>${this.config.completionPromise}</promise>`) ||
          sessionResult.output.includes(this.config.completionPromise)
        )) {
        completed = true;
        this.emit('completion_detected', taskId, {
          message: `Completion promise detected: ${this.config.completionPromise}`
        });
        break;
      }

      // Check if task is actually complete (output indicates completion)
      if (sessionResult.output.includes('TASK_COMPLETE') ||
          sessionResult.output.includes('All steps completed') ||
          sessionResult.success) {
        // Check if there are remaining steps
        const currentTask = await taskManager.getTask(taskId);
        if (currentTask) {
          const remainingSteps = currentTask.plan.steps.filter(s => !s.completed);
          if (remainingSteps.length === 0) {
            completed = true;
            this.emit('completion_detected', taskId, {
              message: 'All steps completed'
            });
            break;
          }
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

    if (completed) {
      await taskManager.updateMetadata(taskId, { status: 'completed' });
    } else if (this.cancelled) {
      await taskManager.updateMetadata(taskId, { status: 'cancelled' });
    }

    await this.controller.stop();

    return {
      taskId,
      completed,
      cancelled: this.cancelled,
      totalSessions: sessions.length,
      totalTokens,
      totalCost,
      duration,
      sessions
    };
  }

  /**
   * Run a single session
   */
  private async runSession(
    taskId: string,
    prompt: string,
    iteration: number
  ): Promise<SpawnResult & { cost_usd?: number }> {
    return new Promise(async (resolve, reject) => {
      let cumulativeTokens: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0
      };
      let totalCost = 0;
      let lastOutput = '';
      let shouldRotate = false;

      // Variable to hold sessionId once available
      let capturedSessionId: string = '';

      // Register session
      const activeSession = await registerSession(taskId);
      this.currentSessionId = activeSession.id;

      // Spawn with streaming
      const { promise, process, sessionId } = spawnWithStreaming(
        prompt,
        async (msg: ClaudeMessage) => {
          // Capture sessionId on first callback
          if (!capturedSessionId) {
            capturedSessionId = sessionId;
          }

          // Update tokens on each message
          if (msg.usage) {
            cumulativeTokens.inputTokens += msg.usage.inputTokens || 0;
            cumulativeTokens.outputTokens += msg.usage.outputTokens || 0;
            cumulativeTokens.cacheReadInputTokens += msg.usage.cacheReadInputTokens || 0;
            cumulativeTokens.cacheCreationInputTokens += msg.usage.cacheCreationInputTokens || 0;

            await updateSessionTokens(capturedSessionId, cumulativeTokens);

            // Check for rotation threshold
            const status = calculateContextStatus(cumulativeTokens, {
              effectiveContextLimit: this.config.effectiveContextLimitTokens,
              thresholdPercent: this.config.thresholdPercent,
              snapshotReserveTokens: this.config.snapshotReserveTokens
            });

            if (status.shouldRotate && !shouldRotate) {
              shouldRotate = true;
              this.emit('rotation', taskId, {
                sessionId: capturedSessionId,
                tokens: cumulativeTokens,
                message: `Context at ${status.percentUsed.toFixed(1)}%, triggering rotation`
              });

              // Inject snapshot instruction into running session is not possible
              // Instead, we let the session complete and start a new one
            }
          }

          // Track cost
          if (msg.cost_usd !== undefined) {
            totalCost = msg.cost_usd;
          }

          // Track output
          if (msg.type === 'result' && msg.result) {
            lastOutput = msg.result;
          }
        },
        {
          timeout: this.config.sessionTimeout
        }
      );

      this.currentProcess = process;

      try {
        const result = await promise;
        this.currentProcess = null;
        this.currentSessionId = null;

        await updateSessionStatus(sessionId, 'completed');

        resolve({
          ...result,
          output: lastOutput || result.output,
          cost_usd: totalCost
        });
      } catch (error) {
        this.currentProcess = null;
        this.currentSessionId = null;
        reject(error);
      }
    });
  }

  /**
   * Generate bootstrap prompt for a session
   */
  private generateBootstrapPrompt(taskId: string, iteration: number): string {
    let prompt = generateBootstrapInstructions(taskId);

    if (iteration > 1) {
      prompt += `\n\nIMPORTANT: This is iteration ${iteration}. Previous sessions have made progress. Check the progress file to see what was already done.\n`;
    }

    if (this.config.completionPromise) {
      prompt += `\n\nWhen the task is FULLY complete, output exactly: <promise>${this.config.completionPromise}</promise>\n`;
    }

    return prompt;
  }

  /**
   * Cancel the execution
   */
  cancel(): void {
    this.cancelled = true;

    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
    }

    if (this.currentSessionId) {
      terminateSession(this.currentSessionId);
    }
  }

  /**
   * Emit progress event
   */
  private emit(type: ProgressEventType, taskId: string, data: Partial<ProgressEvent>): void {
    if (this.config.onProgress) {
      this.config.onProgress({
        type,
        taskId,
        ...data
      });
    }
  }
}

/**
 * Quick start function for Ralph Loop
 */
export async function runRalphLoop(
  goal: string,
  options: {
    completionPromise: string;
    maxIterations?: number;
    thresholdPercent?: number;
    onProgress?: (event: ProgressEvent) => void;
  }
): Promise<RalphExecutionResult> {
  // Create task
  const metadata = await taskManager.createTask(goal, {
    completionPromise: options.completionPromise,
    maxIterations: options.maxIterations,
    thresholdPercent: options.thresholdPercent
  });

  // Create executor
  const executor = new RalphExecutor({
    completionPromise: options.completionPromise,
    maxIterations: options.maxIterations,
    thresholdPercent: options.thresholdPercent,
    onProgress: options.onProgress
  });

  // Run
  return executor.start(metadata.id);
}
