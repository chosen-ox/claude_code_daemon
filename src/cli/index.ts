#!/usr/bin/env node
// CC Session Daemon CLI

import { Command } from 'commander';
import { taskManager } from '../task/manager.js';
import { ensureDaemonDirs, DAEMON_DIR } from '../utils/paths.js';
import { RalphExecutor, runRalphLoop, type ProgressEvent } from '../session/ralph-executor.js';
import { TmuxRalphExecutor, type RalphProgressEvent } from '../session/tmux-ralph-executor.js';
import { isTmuxAvailable, listCcDaemonSessions } from '../session/tmux-spawner.js';
import { isClaudeAvailable } from '../session/spawner.js';
import { initRegistry, getActiveSessions, getSessionStats } from '../session/lifecycle.js';
import { verifyTask, VerificationExecutor } from '../session/verification-executor.js';
import { parseSessionFile } from '../session/monitor.js';
import {
  FR4Monitor,
  findAllActiveSessions,
  findClaudeSessionJsonl,
  formatContextStatus,
  formatTokenUsage,
  formatCost,
  createStatusDisplay,
  runWatchMode,
  type FR4Status
} from '../session/fr4-monitor.js';
import { getModelContextLimit, MODEL_CONTEXT_LIMITS } from '../types/index.js';
import { startGuiServer, getTasksWithDetails } from '../gui/index.js';

const program = new Command();

program
  .name('cc-daemon')
  .description('Orchestrates Claude Code sessions for perpetual autonomous task execution')
  .version('1.0.0');

// ============================================================================
// init command
// ============================================================================
program
  .command('init')
  .description('Initialize the daemon directory structure')
  .action(async () => {
    await ensureDaemonDirs();
    console.log(`CC Daemon initialized at ${DAEMON_DIR}`);
  });

// ============================================================================
// create-task command
// ============================================================================
program
  .command('create-task <goal>')
  .description('Create a new task with the given goal')
  .option('-p, --completion-promise <promise>', 'Completion promise string')
  .option('-m, --max-iterations <n>', 'Maximum iterations', parseInt)
  .option('-t, --threshold-percent <p>', 'Context threshold percent', parseInt)
  .option('-s, --steps <steps...>', 'Task steps')
  .option('-c, --criteria <criteria...>', 'Acceptance criteria')
  .action(async (goal, options) => {
    const metadata = await taskManager.createTask(goal, {
      completionPromise: options.completionPromise,
      maxIterations: options.maxIterations,
      thresholdPercent: options.thresholdPercent,
      steps: options.steps,
      acceptanceCriteria: options.criteria
    });
    console.log(`Created task: ${metadata.id}`);
    console.log(`  Goal: ${goal}`);
    console.log(`  Status: ${metadata.status}`);
    if (metadata.completionPromise) {
      console.log(`  Completion Promise: ${metadata.completionPromise}`);
    }
  });

// ============================================================================
// list command
// ============================================================================
program
  .command('list')
  .description('List all tasks')
  .option('-a, --all', 'Show all tasks including completed')
  .option('-j, --json', 'Output as JSON')
  .option('-d, --detailed', 'Show detailed task information')
  .action(async (options) => {
    const tasks = await taskManager.listTasks();
    const filtered = options.all
      ? tasks
      : tasks.filter(t => t.status !== 'completed' && t.status !== 'cancelled');

    if (options.json) {
      // For JSON output, include full task details
      if (options.detailed) {
        const detailedTasks = await getTasksWithDetails();
        console.log(JSON.stringify(detailedTasks, null, 2));
      } else {
        console.log(JSON.stringify(filtered, null, 2));
      }
      return;
    }

    if (filtered.length === 0) {
      console.log('No tasks found.');
      return;
    }

    console.log(`Found ${filtered.length} task(s):\n`);

    // Get detailed info if requested
    if (options.detailed) {
      const detailedTasks = await getTasksWithDetails();
      const filteredDetailed = detailedTasks.filter(t =>
        options.all || (t.metadata.status !== 'completed' && t.metadata.status !== 'cancelled')
      );

      for (const task of filteredDetailed) {
        const age = formatAge(task.metadata.createdAt);
        const completedSteps = task.plan.steps.filter(s => s.completed).length;
        const totalSteps = task.plan.steps.length;

        console.log(`  ${task.metadata.id}`);
        console.log(`    Goal: ${task.plan.goal.substring(0, 60)}${task.plan.goal.length > 60 ? '...' : ''}`);
        console.log(`    Status: ${task.metadata.status}`);
        console.log(`    Created: ${age}`);
        console.log(`    Progress: ${completedSteps}/${totalSteps} steps`);
        console.log(`    Sessions: ${task.metadata.totalSessions}`);
        console.log(`    Tokens: ${task.metadata.totalTokens.toLocaleString()}`);
        console.log(`    Cost: $${task.metadata.totalCost.toFixed(4)}`);
        console.log(`    Directory: ${task.taskDir}`);
        if (task.tmuxSession) {
          console.log(`    tmux Session: ${task.tmuxSession}`);
          console.log(`    Attach Command: tmux attach -t ${task.tmuxSession}`);
        }
        if (task.contextPercent !== undefined) {
          console.log(`    Context Usage: ${task.contextPercent.toFixed(1)}%`);
        }
        console.log();
      }
    } else {
      for (const task of filtered) {
        const age = formatAge(task.createdAt);
        console.log(`  ${task.id}`);
        console.log(`    Status: ${task.status}`);
        console.log(`    Created: ${age}`);
        console.log(`    Sessions: ${task.totalSessions}`);
        console.log(`    Tokens: ${task.totalTokens.toLocaleString()}`);
        console.log();
      }
    }

    console.log('Tip: Use --detailed for more information, or start GUI with: cc-daemon gui');
  });

// ============================================================================
// status command
// ============================================================================
program
  .command('status [taskId]')
  .description('Show task status and progress')
  .option('-j, --json', 'Output as JSON')
  .option('-a, --all', 'Show all tasks including completed')
  .option('--sessions', 'Show active sessions')
  .option('-w, --watch', 'Watch mode - real-time context monitoring')
  .option('--interval <ms>', 'Watch refresh interval in milliseconds', parseInt)
  .action(async (taskId, options) => {
    // Handle watch mode for real-time monitoring
    if (options.watch) {
      console.log('Starting real-time context monitoring...\n');

      // Find active sessions
      const activeSessions = findAllActiveSessions();

      if (activeSessions.length === 0) {
        console.log('No active Claude Code sessions found.');
        console.log('Start a Claude Code session first, then run this command.');
        process.exit(1);
      }

      console.log(`Found ${activeSessions.length} active session(s):`);
      for (const session of activeSessions) {
        console.log(`  ${session.sessionId} (modified: ${session.modifiedAt.toLocaleTimeString()})`);
      }
      console.log('\nMonitoring the most recent session...\n');
      console.log('Press Ctrl+C to exit.\n');

      // Run watch mode
      const watchHandle = await runWatchMode({
        taskId,
        jsonlPath: activeSessions[0].jsonlPath,
        refreshIntervalMs: options.interval || 1000,
        onDisplay: (display) => {
          process.stdout.write(display);
        }
      });

      // Handle exit
      const exitHandler = () => {
        console.log('\n\nStopping watch mode...');
        watchHandle.stop();
        process.exit(0);
      };

      process.on('SIGINT', exitHandler);
      process.on('SIGTERM', exitHandler);

      // Keep running
      return new Promise(() => {}); // Never resolves
    }

    // Show session stats if requested
    if (options.sessions) {
      try {
        await initRegistry();
        const stats = getSessionStats();
        const activeSessions = getActiveSessions();

        console.log('Session Statistics:');
        console.log(`  Total: ${stats.total}`);
        console.log(`  Active: ${stats.active}`);
        console.log(`  Completed: ${stats.completed}`);
        console.log(`  Failed: ${stats.failed}`);

        if (activeSessions.length > 0) {
          console.log('\nActive Sessions:');
          for (const session of activeSessions) {
            console.log(`  ${session.id.substring(0, 8)}...`);
            console.log(`    Task: ${session.taskId}`);
            console.log(`    Status: ${session.status}`);
            console.log(`    Tokens: ${session.currentTokens.inputTokens} in / ${session.currentTokens.outputTokens} out`);
            console.log(`    Started: ${formatAge(session.startedAt.toISOString())}`);
          }
        }
        return;
      } catch (error) {
        console.error('Error loading session info:', error);
        return;
      }
    }

    let tasks;
    if (taskId) {
      const task = await taskManager.getTask(taskId);
      if (!task) {
        console.error(`Task not found: ${taskId}`);
        process.exit(1);
      }
      tasks = [task];
    } else {
      const allTasks = await taskManager.listTasks();
      const filtered = options.all
        ? allTasks
        : allTasks.filter(t => t.status === 'active' || t.status === 'pending');
      if (filtered.length === 0) {
        console.log('No active tasks. Use --all to see all tasks.');
        return;
      }
      const taskData = await Promise.all(filtered.map(t => taskManager.getTask(t.id)));
      tasks = taskData.filter((t): t is NonNullable<typeof t> => t !== null);
    }

    if (options.json) {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }

    for (const { metadata, plan, progress } of tasks) {
      console.log(`Task: ${metadata.id}`);
      console.log(`  Goal: ${plan.goal}`);
      console.log(`  Status: ${metadata.status}`);

      const completedSteps = plan.steps.filter(s => s.completed).length;
      console.log(`  Progress: ${completedSteps}/${plan.steps.length} steps`);

      if (progress.currentStep) {
        console.log(`  Current Step: ${progress.currentStep}`);
      }

      if (progress.currentSessionId) {
        console.log(`  Current Session: ${progress.currentSessionId.substring(0, 8)}...`);
      }

      console.log(`  Total Sessions: ${metadata.totalSessions}`);
      console.log(`  Total Tokens: ${metadata.totalTokens.toLocaleString()}`);
      console.log(`  Total Cost: $${metadata.totalCost.toFixed(4)}`);

      if (progress.blockers.length > 0) {
        console.log(`  Blockers:`);
        for (const blocker of progress.blockers) {
          console.log(`    - ${blocker}`);
        }
      }

      console.log();
    }
  });

// ============================================================================
// resume command
// ============================================================================
program
  .command('resume <taskId>')
  .description('Resume a task in a new session')
  .action(async (taskId) => {
    const task = await taskManager.getTask(taskId);
    if (!task) {
      console.error(`Task not found: ${taskId}`);
      process.exit(1);
    }

    // Update status to active
    await taskManager.updateMetadata(taskId, { status: 'active' });

    console.log(`Resuming task: ${taskId}`);
    console.log(`  Goal: ${task.plan.goal}`);
    console.log(`  Completed Steps: ${task.progress.completedSteps.length}/${task.plan.steps.length}`);

    // Print instructions for Claude Code to resume
    console.log('\n--- RESUME INSTRUCTIONS ---');
    console.log(`Read the task files and continue from where the last session left off:`);
    console.log(`  Plan: ~/.cc-daemon/tasks/${taskId}/plan.md`);
    console.log(`  Progress: ~/.cc-daemon/tasks/${taskId}/progress.md`);
    console.log('\n--- END INSTRUCTIONS ---');
  });

// ============================================================================
// verify command
// ============================================================================
program
  .command('verify <taskId>')
  .description('Verify task completion in a clean session')
  .option('-m, --max-cycles <n>', 'Maximum verification cycles', (val) => parseInt(val, 10), 3)
  .option('--timeout <ms>', 'Timeout per cycle in milliseconds', (val) => parseInt(val, 10), 600000)
  .action(async (taskId, options) => {
    const task = await taskManager.getTask(taskId);
    if (!task) {
      console.error(`Task not found: ${taskId}`);
      process.exit(1);
    }

    // Check Claude availability
    if (!(await isClaudeAvailable())) {
      console.error('Error: Claude CLI is not available. Please install it first.');
      process.exit(1);
    }

    console.log(`Starting verification for task: ${taskId}`);
    console.log(`  Goal: ${task.plan.goal}`);
    console.log(`  Max Cycles: ${options.maxCycles}`);
    console.log(`  Timeout: ${options.timeout}ms\n`);

    try {
      const result = await verifyTask(taskId, {
        maxCycles: options.maxCycles,
        timeout: options.timeout,
        onProgress: (message) => console.log(message)
      });

      console.log('\n' + '='.repeat(60));
      console.log('VERIFICATION COMPLETE');
      console.log('='.repeat(60));
      console.log(`Task ID: ${result.taskId}`);
      console.log(`Status: ${result.passed ? 'PASSED ✅' : 'FAILED ❌'}`);
      console.log(`Cycles: ${result.cycles}`);

      if (result.finalResult) {
        console.log(`\nGaps: ${result.finalResult.gaps.length}`);
        for (const gap of result.finalResult.gaps) {
          console.log(`  - ${gap}`);
        }
      }

      if (result.revisePlanPath) {
        console.log(`\nRevise Plan: ${result.revisePlanPath}`);
      }

      process.exit(result.passed ? 0 : 1);
    } catch (error) {
      console.error('\nVerification error:', error);
      process.exit(1);
    }
  });

// ============================================================================
// cancel command
// ============================================================================
program
  .command('cancel <taskId>')
  .description('Cancel a task')
  .option('-r, --reason <reason>', 'Cancellation reason')
  .action(async (taskId, options) => {
    const task = await taskManager.getTask(taskId);
    if (!task) {
      console.error(`Task not found: ${taskId}`);
      process.exit(1);
    }

    await taskManager.updateMetadata(taskId, {
      status: 'cancelled'
    });

    if (options.reason) {
      await taskManager.updateProgress(taskId, (progress) => {
        progress.blockers.push(`Cancelled: ${options.reason}`);
        return progress;
      });
    }

    console.log(`Cancelled task: ${taskId}`);
  });

// ============================================================================
// ralph command
// ============================================================================
program
  .command('ralph <goal>')
  .description('Start a Ralph Loop for perpetual task execution')
  .option('-p, --completion-promise <promise>', 'Completion promise string (optional - if not set, task completes when all steps are done)')
  .option('-m, --max-iterations <n>', 'Maximum total iterations', (val) => parseInt(val, 10), 100)
  .option('-t, --threshold-percent <p>', 'Context threshold percent for rotation', (val) => parseInt(val, 10), 80)
  .option('-s, --steps <steps...>', 'Task steps')
  .option('--dry-run', 'Create task but do not execute')
  .option('--tmux', 'Use tmux for session management (enables true rotation)')
  .option('--verify', 'Enable automatic verification after completion')
  .option('--max-verify-cycles <n>', 'Maximum verification cycles', (val) => parseInt(val, 10), 3)
  .option('--verbose', 'Enable verbose debug output')
  // FR-4 Improvement 3: Retry configuration
  .option('--max-retries <n>', 'Maximum retry attempts per session', (val) => parseInt(val, 10), 3)
  .option('--retry-base-delay <ms>', 'Base delay for retry in milliseconds', (val) => parseInt(val, 10), 2000)
  .option('--retry-max-delay <ms>', 'Maximum delay for retry in milliseconds', (val) => parseInt(val, 10), 30000)
  .option('--context-limit <n>', 'Effective context limit in tokens (default: 150000)', (val) => parseInt(val, 10), 150000)
  .option('--working-dir <path>', 'Working directory for the task (tmux mode only)')
  .action(async (goal, options) => {
    // Completion promise is now optional - if not set, task will complete when all steps are done
    const completionPromise = options.completionPromise || 'TASK_COMPLETE';

    // Check Claude availability
    if (!(await isClaudeAvailable())) {
      console.error('Error: Claude CLI is not available. Please install it first.');
      process.exit(1);
    }

    // Check tmux if requested
    if (options.tmux && !(await isTmuxAvailable())) {
      console.error('Error: tmux is not available. Install tmux or remove --tmux flag.');
      process.exit(1);
    }

    const maxIterations = options.maxIterations || 100;
    const thresholdPercent = options.thresholdPercent || 80;
    const useTmux = options.tmux || false;
    const enableVerify = options.verify || false;
    const maxVerifyCycles = options.maxVerifyCycles || 3;

    // Create task
    const metadata = await taskManager.createTask(goal, {
      completionPromise: options.completionPromise, // Store undefined if not provided
      maxIterations,
      thresholdPercent,
      steps: options.steps
    });

    console.log(`Created task: ${metadata.id}`);
    console.log(`  Goal: ${goal}`);
    if (options.completionPromise) {
      console.log(`  Completion Promise: ${options.completionPromise}`);
    } else {
      console.log(`  Completion Mode: Auto-detect (task completes when all steps are done)`);
    }
    console.log(`  Max Iterations: ${maxIterations}`);
    console.log(`  Threshold: ${thresholdPercent}%`);
    console.log(`  Mode: ${useTmux ? 'tmux (true rotation)' : 'standard'}`);
    if (enableVerify) {
      console.log(`  Verification: enabled (max ${maxVerifyCycles} cycles)`);
    }

    if (options.dryRun) {
      console.log('\n[DRY RUN] Task created but not executed.');
      console.log(`Use 'cc-daemon resume ${metadata.id}' to execute later.`);
      return;
    }

    console.log('\nStarting Ralph Loop execution...\n');

    if (useTmux) {
      // Use tmux-based executor
      await runTmuxRalph(metadata.id, {
        completionPromise,
        maxIterations,
        thresholdPercent,
        effectiveContextLimitTokens: options.contextLimit,
        enableVerification: enableVerify,
        maxVerificationCycles: maxVerifyCycles,
        verbose: options.verbose || false,
        // FR-4 Improvement 3: Retry configuration
        maxRetries: options.maxRetries,
        retryBaseDelayMs: options.retryBaseDelay,
        retryMaxDelayMs: options.retryMaxDelay,
        workingDir: options.workingDir
      });
    } else {
      // Use standard executor
      await runStandardRalph(metadata.id, {
        completionPromise,
        maxIterations,
        thresholdPercent
      });
    }
  });

// ============================================================================
// tmux-sessions command
// ============================================================================
program
  .command('tmux-sessions')
  .description('List active cc-daemon tmux sessions')
  .action(async () => {
    if (!(await isTmuxAvailable())) {
      console.error('tmux is not available');
      process.exit(1);
    }

    const sessions = await listCcDaemonSessions();

    if (sessions.length === 0) {
      console.log('No active cc-daemon tmux sessions.');
      return;
    }

    console.log(`Found ${sessions.length} cc-daemon tmux session(s):\n`);
    for (const session of sessions) {
      console.log(`  ${session}`);
      console.log(`    Attach: tmux attach -t ${session}`);
    }
    console.log('\nTip: Copy the attach command and run it in your terminal to connect to the session.');
    console.log('     Use the GUI (cc-daemon gui) for a visual interface with one-click commands.');
  });

// ============================================================================
// gui command
// ============================================================================
program
  .command('gui')
  .description('Start the web-based GUI for cc-daemon')
  .option('-p, --port <port>', 'Port to listen on', (val) => parseInt(val, 10), 9876)
  .option('-h, --host <host>', 'Host to bind to', 'localhost')
  .action(async (options) => {
    console.log('Starting CC-Daemon GUI...');

    try {
      const server = await startGuiServer({
        port: options.port,
        host: options.host
      });

      // Handle graceful shutdown
      const shutdown = () => {
        console.log('\nShutting down GUI server...');
        server.close(() => {
          console.log('GUI server stopped.');
          process.exit(0);
        });
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

    } catch (error) {
      console.error('Failed to start GUI server:', error);
      process.exit(1);
    }
  });

// ============================================================================
// context command (FR-4)
// ============================================================================
program
  .command('context')
  .description('Show real-time context usage for active Claude Code sessions')
  .option('-w, --watch', 'Watch mode - continuously update')
  .option('--interval <ms>', 'Watch refresh interval in milliseconds', parseInt)
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    const activeSessions = findAllActiveSessions();

    if (activeSessions.length === 0) {
      console.log('No active Claude Code sessions found.');
      console.log('\nTip: Start a Claude Code session first, then run this command.');
      return;
    }

    if (options.json) {
      // Output JSON format
      const monitor = new FR4Monitor();
      const results = [];
      const contextLimit = getModelContextLimit('default'); // Use default model limit

      for (const session of activeSessions) {
        const { currentContextUsage } = await parseSessionFile(session.jsonlPath);
        const status = {
          sessionId: session.sessionId,
          jsonlPath: session.jsonlPath,
          modifiedAt: session.modifiedAt,
          tokens: currentContextUsage,
          contextPercent: ((currentContextUsage.inputTokens + currentContextUsage.cacheReadInputTokens) / contextLimit * 100).toFixed(1),
          contextLimit
        };
        results.push(status);
      }

      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (options.watch) {
      // Watch mode
      console.log('Starting context watch mode...\n');
      console.log(`Monitoring ${activeSessions.length} session(s)...\n`);
      console.log('Press Ctrl+C to exit.\n');

      const watchHandle = await runWatchMode({
        jsonlPath: activeSessions[0].jsonlPath,
        refreshIntervalMs: options.interval || 1000,
        onDisplay: (display) => {
          process.stdout.write(display);
        }
      });

      const exitHandler = () => {
        console.log('\n\nStopping...');
        watchHandle.stop();
        process.exit(0);
      };

      process.on('SIGINT', exitHandler);
      process.on('SIGTERM', exitHandler);

      return new Promise(() => {});
    }

    // One-time display
    console.log(`Found ${activeSessions.length} active Claude Code session(s):\n`);

    const contextLimit = getModelContextLimit('default'); // Use default model limit
    const thresholdPercent = 80;
    const snapshotReserveTokens = 8000;

    for (const session of activeSessions) {
      console.log(`Session: ${session.sessionId.slice(0, 16)}...`);
      console.log(`  Modified: ${session.modifiedAt.toLocaleTimeString()}`);

      // Parse session file for token usage
      const { currentContextUsage } = await parseSessionFile(session.jsonlPath);
      console.log(`  ${formatTokenUsage(currentContextUsage)}`);

      // Calculate context status (当前上下文 = input + cache_read)
      const currentContext = currentContextUsage.inputTokens + currentContextUsage.cacheReadInputTokens;
      const contextPercent = (currentContext / contextLimit * 100);
      const shouldRotate = contextPercent >= thresholdPercent;
      const emergencyRotate = currentContext >= (contextLimit - snapshotReserveTokens);

      const icon = emergencyRotate ? '🚨' : shouldRotate ? '⚠️' : '✓';
      const limitK = (contextLimit / 1000).toFixed(0);
      console.log(`  ${icon} Context: ${contextPercent.toFixed(1)}% (${(currentContext/1000).toFixed(1)}k / ${limitK}k)${shouldRotate ? ' (rotation recommended)' : ''}`);
      console.log();
    }
  });

// ============================================================================
// Helper functions for Ralph modes
// ============================================================================

async function runStandardRalph(taskId: string, options: {
  completionPromise: string;
  maxIterations: number;
  thresholdPercent: number;
}): Promise<void> {
  const executor = new RalphExecutor({
    completionPromise: options.completionPromise,
    maxIterations: options.maxIterations,
    thresholdPercent: options.thresholdPercent,
    onProgress: (event: ProgressEvent) => {
      switch (event.type) {
        case 'session_start':
          console.log(`\n[Session ${event.iteration}] Starting...`);
          break;
        case 'session_complete':
          console.log(`[Session ${event.iteration}] Completed`);
          console.log(`  Tokens: ${event.tokens?.inputTokens || 0} in / ${event.tokens?.outputTokens || 0} out`);
          break;
        case 'rotation':
          console.log(`\n[Rotation] ${event.message}`);
          break;
        case 'completion_detected':
          console.log(`\n[Complete] ${event.message}`);
          break;
        case 'error':
          console.error(`[Error] ${event.error}`);
          break;
        case 'status':
          console.log(event.message);
          break;
      }
    }
  });

  // Handle SIGINT/SIGTERM for graceful shutdown
  let cancelling = false;
  const signalHandler = async () => {
    if (cancelling) return;
    cancelling = true;
    console.log('\n\nCancelling... Please wait for current session to complete.');
    executor.cancel();
  };
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);

  try {
    const result = await executor.start(taskId);

    console.log('\n' + '='.repeat(60));
    console.log('RALPH LOOP COMPLETE');
    console.log('='.repeat(60));
    console.log(`Task ID: ${result.taskId}`);
    console.log(`Status: ${result.completed ? 'COMPLETED' : result.cancelled ? 'CANCELLED' : 'INCOMPLETE'}`);
    console.log(`Total Sessions: ${result.totalSessions}`);
    console.log(`Total Tokens: ${result.totalTokens.inputTokens.toLocaleString()} in / ${result.totalTokens.outputTokens.toLocaleString()} out`);
    console.log(`Total Cost: $${result.totalCost.toFixed(4)}`);
    console.log(`Duration: ${formatDuration(result.duration)}`);

    if (result.error) {
      console.log(`Error: ${result.error}`);
    }

    process.exit(result.completed ? 0 : 1);
  } catch (error) {
    console.error('\nFatal error:', error);
    process.exit(1);
  } finally {
    process.off('SIGINT', signalHandler);
    process.off('SIGTERM', signalHandler);
  }
}

async function runTmuxRalph(taskId: string, options: {
  completionPromise: string;
  maxIterations: number;
  thresholdPercent: number;
  effectiveContextLimitTokens?: number;
  enableVerification: boolean;
  maxVerificationCycles: number;
  verbose: boolean;
  // FR-4 Improvement 3: Retry configuration
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  workingDir?: string;
}): Promise<void> {
  const executor = new TmuxRalphExecutor({
    completionPromise: options.completionPromise,
    maxIterations: options.maxIterations,
    thresholdPercent: options.thresholdPercent,
    effectiveContextLimitTokens: options.effectiveContextLimitTokens,
    enableVerification: options.enableVerification,
    maxVerificationCycles: options.maxVerificationCycles,
    verbose: options.verbose,
    // FR-4 Improvement 3: Retry configuration
    maxRetries: options.maxRetries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    retryMaxDelayMs: options.retryMaxDelayMs,
    workingDir: options.workingDir,
    onProgress: (event: RalphProgressEvent) => {
      switch (event.type) {
        case 'session_start':
          console.log(`\n[Session ${event.iteration}] Starting in tmux...`);
          break;
        case 'session_complete':
          console.log(`[Session ${event.iteration}] Completed`);
          console.log(`  Tokens: ${event.tokens?.inputTokens || 0} in / ${event.tokens?.outputTokens || 0} out`);
          break;
        case 'rotation_triggered':
          console.log(`\n[Rotation Triggered] ${event.message}`);
          break;
        case 'rotation_complete':
          console.log(`[Rotation Complete] ${event.message}`);
          break;
        case 'completion_detected':
          console.log(`\n[Complete] ${event.message}`);
          break;
        case 'verification_start':
          console.log(`\n[Verification] ${event.message}`);
          break;
        case 'verification_pass':
          console.log(`\n[Verification PASSED] ${event.message}`);
          break;
        case 'verification_fail':
          console.log(`\n[Verification FAILED] ${event.message}`);
          break;
        case 'verification_retry':
          console.log(`\n[Verification Retry] ${event.message}`);
          break;
        case 'error':
          console.error(`[Error] ${event.error}`);
          break;
        case 'status':
          console.log(event.message);
          break;
      }
    }
  });

  // Handle SIGINT/SIGTERM for graceful shutdown
  let cancelling = false;
  const signalHandler = async () => {
    if (cancelling) return;
    cancelling = true;
    console.log('\n\nCancelling... Please wait for current session to complete.');
    executor.cancel();
  };
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);

  try {
    const result = await executor.start(taskId);

    console.log('\n' + '='.repeat(60));
    console.log('RALPH LOOP COMPLETE (tmux mode)');
    console.log('='.repeat(60));
    console.log(`Task ID: ${result.taskId}`);
    console.log(`Status: ${result.completed ? 'COMPLETED' : result.cancelled ? 'CANCELLED' : 'INCOMPLETE'}`);
    console.log(`Verified: ${result.verified ? 'YES' : 'NO'}`);
    console.log(`Total Sessions: ${result.totalSessions}`);
    console.log(`Total Iterations: ${result.totalIterations}`);
    console.log(`Total Rotations: ${result.totalRotations}`);
    console.log(`Total Tokens: ${result.totalTokens.inputTokens.toLocaleString()} in / ${result.totalTokens.outputTokens.toLocaleString()} out`);
    console.log(`Total Cost: $${result.totalCost.toFixed(4)}`);
    console.log(`Duration: ${formatDuration(result.duration)}`);

    if (result.error) {
      console.log(`Error: ${result.error}`);
    }

    process.exit(result.completed && result.verified ? 0 : 1);
  } catch (error) {
    console.error('\nFatal error:', error);
    process.exit(1);
  } finally {
    process.off('SIGINT', signalHandler);
    process.off('SIGTERM', signalHandler);
  }
}

// ============================================================================
// Helper functions
// ============================================================================

function formatAge(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHours > 0) return `${diffHours}h ago`;
  if (diffMins > 0) return `${diffMins}m ago`;
  return 'just now';
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

// ============================================================================
// Run CLI
// ============================================================================

export { program };

program.parse();
