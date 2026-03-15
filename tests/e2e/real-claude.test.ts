// E2E Test - Real Claude CLI Integration
// This test actually calls Claude CLI to verify the complete flow

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Set test environment
const testDir = path.join(os.tmpdir(), `cc-daemon-real-test-${Date.now()}`);
process.env.CC_DAEMON_DIR = testDir;

import { spawnWithCLI, isClaudeAvailable } from '../../src/session/spawner.js';
import { initRegistry, registerSession, terminateSession } from '../../src/session/lifecycle.js';
import { RalphExecutor } from '../../src/session/ralph-executor.js';
import { verifyTask } from '../../src/session/verification-executor.js';
import { taskManager } from '../../src/task/manager.js';
import { ensureDaemonDirs } from '../../src/utils/paths.js';

// Skip tests if Claude is not available
const claudeAvailable = await isClaudeAvailable();

describe.skipIf(!claudeAvailable)('Real Claude CLI Integration', () => {
  beforeAll(async () => {
    await ensureDaemonDirs();
    await initRegistry();
  });

  afterAll(async () => {
    // Cleanup
    if (fs.existsSync(testDir)) {
      await fs.promises.rm(testDir, { recursive: true }).catch(() => {});
    }
  });

  describe('FR-4: Real JSONL Parsing', () => {
    it('should spawn Claude and parse JSONL output', async () => {
      const result = await spawnWithCLI('Say "Hello World" and nothing else.', {
        timeout: 60000
      });

      console.log('Spawn result:', {
        sessionId: result.sessionId,
        success: result.success,
        exitCode: result.exitCode,
        duration: result.duration,
        tokenUsage: result.tokenUsage,
        outputLength: result.output.length
      });

      expect(result.success).toBe(true);
      expect(result.sessionId).toBeDefined();
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(result.tokenUsage.outputTokens).toBeGreaterThan(0);
      expect(result.output.toLowerCase()).toContain('hello');
    }, 120000);

    it('should handle streaming output', async () => {
      const { spawnWithStreaming } = await import('../../src/session/spawner.js');
      const messages: any[] = [];

      const { promise, sessionId } = spawnWithStreaming(
        'Count from 1 to 3, one number per line.',
        (msg) => messages.push(msg),
        { timeout: 60000 }
      );

      const result = await promise;

      console.log('Streaming result:', {
        sessionId,
        success: result.success,
        messageCount: messages.length,
        output: result.output
      });

      expect(result.success).toBe(true);
    }, 120000);
  });

  describe('FR-1 & FR-3: Real Ralph Loop', () => {
    it('should create task and run Ralph Loop with real Claude', async () => {
      // Create a simple task
      const metadata = await taskManager.createTask(
        'Create a simple hello.txt file with content "Hello from Claude!"',
        {
          completionPromise: 'TASK_DONE',
          maxIterations: 2,
          thresholdPercent: 80
        }
      );

      console.log('Created task:', metadata.id);

      // Create executor
      const executor = new RalphExecutor({
        completionPromise: 'TASK_DONE',
        maxIterations: 2,
        thresholdPercent: 80,
        sessionTimeout: 120000,
        onProgress: (event) => {
          console.log(`[${event.type}] ${event.message || ''}`);
        }
      });

      // Run the loop
      const result = await executor.start(metadata.id);

      console.log('Ralph Loop result:', {
        taskId: result.taskId,
        completed: result.completed,
        cancelled: result.cancelled,
        totalSessions: result.totalSessions,
        totalTokens: result.totalTokens,
        totalCost: result.totalCost,
        duration: result.duration
      });

      expect(result.taskId).toBe(metadata.id);
      expect(result.totalSessions).toBeGreaterThanOrEqual(1);
      expect(result.totalTokens.inputTokens).toBeGreaterThan(0);

    }, 300000); // 5 minute timeout
  });

  describe('FR-2: Real Verification', () => {
    it('should run verification with real Claude', async () => {
      // Create a task
      const metadata = await taskManager.createTask(
        'Create a file called test.txt',
        {
          steps: ['Create test.txt file'],
          acceptanceCriteria: ['test.txt file exists']
        }
      );

      // Mark as completed (simulating previous work)
      await taskManager.updateMetadata(metadata.id, { status: 'completed' });

      console.log('Created task for verification:', metadata.id);

      // Run verification
      const result = await verifyTask(metadata.id, {
        maxCycles: 1,
        timeout: 120000,
        onProgress: (msg) => console.log('[Verify]', msg)
      });

      console.log('Verification result:', {
        taskId: result.taskId,
        passed: result.passed,
        cycles: result.cycles,
        gaps: result.finalResult?.gaps
      });

      expect(result.taskId).toBe(metadata.id);
      expect(result.cycles).toBeGreaterThanOrEqual(1);

    }, 180000); // 3 minute timeout
  });
});
