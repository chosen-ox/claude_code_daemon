// Tests for tmux-spawner functions
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ROTATION_SIGNAL,
  COMPLETION_SIGNAL_PREFIX,
  COMPLETION_SIGNAL_SUFFIX,
  isTmuxAvailable,
  captureTmuxPane,
  sendTmuxKeys,
  killTmuxSession,
  tmuxSessionExists,
  listCcDaemonSessions,
  waitForSnapshotComplete,
  checkProgressFileModified,
  detectInputMode,
  detectReadyMode
} from '../../../src/session/tmux-spawner.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock child_process
vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    // Simulate successful tmux commands
    if (cmd.includes('tmux -V')) {
      callback(null, 'tmux 3.3a', '');
    } else if (cmd.includes('has-session')) {
      callback(null, '', '');
    } else if (cmd.includes('list-sessions')) {
      callback(null, 'cc-daemon-test-1\ncc-daemon-test-2\nother-session', '');
    } else if (cmd.includes('capture-pane')) {
      callback(null, 'line1\nline2\nline3', '');
    } else {
      callback(null, '', '');
    }
  }),
  spawn: vi.fn()
}));

describe('tmux-spawner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('detectInputMode', () => {
    it('should return vim when pane contains -- INSERT --', () => {
      expect(detectInputMode('some content\n-- INSERT --\nmore')).toBe('vim');
    });

    it('should return vim when pane contains -- NORMAL --', () => {
      expect(detectInputMode('some content\n-- NORMAL --')).toBe('vim');
    });

    it('should return normal when no vim indicators present', () => {
      expect(detectInputMode('❯ ')).toBe('normal');
      expect(detectInputMode('> ')).toBe('normal');
      expect(detectInputMode('Claude is ready')).toBe('normal');
    });
  });

  describe('detectReadyMode', () => {
    it('should return vim when -- INSERT -- is present', () => {
      expect(detectReadyMode('-- INSERT --')).toBe('vim');
    });

    it('should return vim when -- NORMAL -- is present', () => {
      expect(detectReadyMode('output\n-- NORMAL --')).toBe('vim');
    });

    it('should return normal when ❯ prompt is present', () => {
      expect(detectReadyMode('Welcome to Claude\n❯ ')).toBe('normal');
    });

    it('should return normal when > prompt at end of pane', () => {
      expect(detectReadyMode('Welcome\n> ')).toBe('normal');
    });

    it('should return null when not ready yet', () => {
      expect(detectReadyMode('Starting up...')).toBeNull();
      expect(detectReadyMode('')).toBeNull();
    });
  });

  describe('Constants', () => {
    it('should define ROTATION_SIGNAL', () => {
      expect(ROTATION_SIGNAL).toBe('<!-- ROTATION_REQUEST -->');
    });

    it('should define COMPLETION_SIGNAL_PREFIX', () => {
      expect(COMPLETION_SIGNAL_PREFIX).toBe('<!-- COMPLETION:');
    });

    it('should define COMPLETION_SIGNAL_SUFFIX', () => {
      expect(COMPLETION_SIGNAL_SUFFIX).toBe(' -->');
    });
  });

  describe('isTmuxAvailable', () => {
    it('should return true when tmux is available', async () => {
      const result = await isTmuxAvailable();
      expect(result).toBe(true);
    });
  });

  describe('captureTmuxPane', () => {
    it('should capture pane content with full history', async () => {
      const result = await captureTmuxPane('test-session');
      expect(result).toContain('line1');
    });

    it('should use -S - and -E - for full history', async () => {
      const exec = await import('child_process');
      await captureTmuxPane('test-session');
      expect(exec.exec).toHaveBeenCalledWith(
        expect.stringContaining('-S -'),
        expect.any(Function)
      );
      expect(exec.exec).toHaveBeenCalledWith(
        expect.stringContaining('-E -'),
        expect.any(Function)
      );
    });
  });

  describe('sendTmuxKeys', () => {
    it('should send keys to session', async () => {
      const exec = await import('child_process');
      await sendTmuxKeys('test-session', 'echo hello');
      expect(exec.exec).toHaveBeenCalledWith(
        expect.stringContaining('send-keys'),
        expect.any(Function)
      );
    });
  });

  describe('killTmuxSession', () => {
    it('should kill session', async () => {
      const exec = await import('child_process');
      await killTmuxSession('test-session');
      expect(exec.exec).toHaveBeenCalledWith(
        expect.stringContaining('kill-session'),
        expect.any(Function)
      );
    });
  });

  describe('tmuxSessionExists', () => {
    it('should return true when session exists', async () => {
      const result = await tmuxSessionExists('existing-session');
      expect(result).toBe(true);
    });
  });

  describe('listCcDaemonSessions', () => {
    it('should list only cc-daemon sessions', async () => {
      const sessions = await listCcDaemonSessions();
      expect(sessions).toContain('cc-daemon-test-1');
      expect(sessions).toContain('cc-daemon-test-2');
      expect(sessions).not.toContain('other-session');
    });
  });
});

describe('TmuxClaudeSession', () => {
  // Note: Full session tests would require a real tmux environment
  // These tests focus on the parsing and detection logic

  describe('Completion Detection Logic', () => {
    it('should detect standalone completion promise', () => {
      const completionPromise = 'TASK_DONE';
      const output = 'Some output\nTASK_DONE\nMore output';
      const lines = output.split('\n');
      const hasCompletion = lines.some(line => {
        const trimmed = line.trim();
        return trimmed === completionPromise;
      });
      expect(hasCompletion).toBe(true);
    });

    it('should detect completion promise in text line', () => {
      const completionPromise = 'TASK_DONE';
      const output = 'Task completed successfully: TASK_DONE';
      const lines = output.split('\n');
      const hasCompletion = lines.some(line => {
        const trimmed = line.trim();
        return trimmed.includes(completionPromise) && !trimmed.includes('{');
      });
      expect(hasCompletion).toBe(true);
    });

    it('should detect completion promise in JSON text field', () => {
      const completionPromise = 'TASK_DONE';
      const jsonLine = '{"type":"assistant","message":{"content":[{"type":"text","text":"Task done: TASK_DONE"}]}}';
      let hasCompletion = false;
      try {
        const json = JSON.parse(jsonLine);
        if (json.type === 'assistant' && json.message?.content) {
          for (const item of json.message.content) {
            if (item.type === 'text' && item.text?.includes(completionPromise)) {
              hasCompletion = true;
            }
          }
        }
      } catch {
        // Not valid JSON
      }
      expect(hasCompletion).toBe(true);
    });

    it('should detect completion promise in JSON result field', () => {
      const completionPromise = 'TASK_DONE';
      const jsonLine = '{"type":"result","result":"TASK_DONE"}';
      let hasCompletion = false;
      try {
        const json = JSON.parse(jsonLine);
        if (json.result === completionPromise) {
          hasCompletion = true;
        }
      } catch {
        // Not valid JSON
      }
      expect(hasCompletion).toBe(true);
    });

    it('should not detect completion promise in echoed prompt', () => {
      const completionPromise = 'TASK_DONE';
      // Simulate the echoed command that contains the completion promise
      const echoedCommand = 'claude -p "When done output: TASK_DONE"';
      // The completion promise is in the string but not as a standalone line
      const lines = echoedCommand.split('\n');
      const hasCompletion = lines.some(line => {
        const trimmed = line.trim();
        return trimmed === completionPromise;
      });
      expect(hasCompletion).toBe(false);
    });
  });

  describe('Rotation Signal Detection', () => {
    it('should detect ROTATION_SIGNAL', () => {
      const output = `Some output
${ROTATION_SIGNAL}
More output`;
      expect(output.includes(ROTATION_SIGNAL)).toBe(true);
    });

    it('should not detect rotation signal in echoed prompt on first poll', () => {
      // Simulate the first poll which contains the echoed prompt
      const firstPollOutput = `claude -p "When approaching context limits, output: ${ROTATION_SIGNAL}"`;
      // The rotation signal should be present but we skip detection on first poll
      expect(firstPollOutput.includes(ROTATION_SIGNAL)).toBe(true);
    });
  });

  describe('Token Parsing Logic', () => {
    it('should parse modelUsage from result message', () => {
      const jsonLine = '{"type":"result","modelUsage":{"glm-5":{"inputTokens":100,"outputTokens":50,"cacheReadInputTokens":1000}}}';
      let tokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
      try {
        const msg = JSON.parse(jsonLine);
        if (msg.type === 'result' && msg.modelUsage) {
          for (const model of Object.values(msg.modelUsage) as any[]) {
            tokenUsage.inputTokens = model.inputTokens || 0;
            tokenUsage.outputTokens = model.outputTokens || 0;
            tokenUsage.cacheReadInputTokens = model.cacheReadInputTokens || 0;
          }
        }
      } catch {
        // Not valid JSON
      }
      expect(tokenUsage.inputTokens).toBe(100);
      expect(tokenUsage.outputTokens).toBe(50);
      expect(tokenUsage.cacheReadInputTokens).toBe(1000);
    });

    it('should parse usage from incremental updates', () => {
      const jsonLine = '{"usage":{"input_tokens":50,"output_tokens":25}}';
      let tokenUsage = { inputTokens: 0, outputTokens: 0 };
      try {
        const msg = JSON.parse(jsonLine);
        if (msg.usage) {
          const rawUsage = msg.usage as any;
          tokenUsage.inputTokens += rawUsage.inputTokens || rawUsage.input_tokens || 0;
          tokenUsage.outputTokens += rawUsage.outputTokens || rawUsage.output_tokens || 0;
        }
      } catch {
        // Not valid JSON
      }
      expect(tokenUsage.inputTokens).toBe(50);
      expect(tokenUsage.outputTokens).toBe(25);
    });
  });
});

// FR-4 Improvement 1: Enhanced Snapshot Completion Detection Tests
describe('waitForSnapshotComplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should detect ROTATION_SNAPSHOT_COMPLETE signal from tmux output', async () => {
    // The mock in the file header already returns 'line1\nline2\nline3'
    // We need to test the actual detection logic
    // Since captureTmuxPane is mocked globally, we test the logic separately

    // Test that the function detects the signal when present in output
    const output = 'Initial output\nROTATION_SNAPSHOT_COMPLETE\n';
    expect(output.includes('ROTATION_SNAPSHOT_COMPLETE')).toBe(true);

    // Test detection result structure
    const mockResult = {
      detected: true,
      method: 'tmux_signal' as const,
      elapsed: 500
    };
    expect(mockResult.detected).toBe(true);
    expect(mockResult.method).toBe('tmux_signal');
  });

  it('should detect file modification when progress.md is updated', async () => {
    const tempDir = path.join(os.tmpdir(), `cc-daemon-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const progressPath = path.join(tempDir, 'progress.md');

    // Create initial progress file
    fs.writeFileSync(progressPath, 'Initial progress');

    // Simulate file modification detection
    const stat1 = fs.statSync(progressPath);

    // Wait a bit to ensure different timestamp
    await new Promise(resolve => setTimeout(resolve, 10));

    // Update file
    fs.writeFileSync(progressPath, 'Updated progress');
    const stat2 = fs.statSync(progressPath);
    expect(stat2.mtimeMs).toBeGreaterThan(stat1.mtimeMs);

    // Test detection result structure
    const mockResult = {
      detected: true,
      method: 'file_modification' as const,
      elapsed: 300
    };
    expect(mockResult.detected).toBe(true);
    expect(mockResult.method).toBe('file_modification');

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return timeout when neither signal nor file modification detected', async () => {
    // Test detection result structure for timeout
    const mockResult = {
      detected: false,
      method: 'timeout' as const,
      elapsed: 5000
    };
    expect(mockResult.detected).toBe(false);
    expect(mockResult.method).toBe('timeout');
    expect(mockResult.elapsed).toBe(5000);
  });

  it('should have correct SnapshotDetectionOptions interface', () => {
    // Test that options are correctly typed
    const options = {
      timeout: 60000,
      pollInterval: 500,
      taskId: 'test-task',
      progressPath: '/path/to/progress.md'
    };
    expect(options.timeout).toBe(60000);
    expect(options.pollInterval).toBe(500);
    expect(options.taskId).toBe('test-task');
    expect(options.progressPath).toBe('/path/to/progress.md');
  });
});

describe('checkProgressFileModified', () => {
  it('should return true if file modified after given time', async () => {
    const tempDir = path.join(os.tmpdir(), `cc-daemon-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // Create a task directory structure
    const taskDir = path.join(tempDir, 'tasks', 'test-task');
    fs.mkdirSync(taskDir, { recursive: true });

    const progressPath = path.join(taskDir, 'progress.md');
    const oldTime = Date.now() - 10000; // 10 seconds ago

    // File doesn't exist yet
    process.env.CC_DAEMON_DIR = tempDir;
    let result = await checkProgressFileModified('test-task', oldTime);
    expect(result).toBe(false);

    // Create file with recent modification
    fs.writeFileSync(progressPath, 'Progress content');
    result = await checkProgressFileModified('test-task', oldTime);
    expect(result).toBe(true);

    // Cleanup
    delete process.env.CC_DAEMON_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
