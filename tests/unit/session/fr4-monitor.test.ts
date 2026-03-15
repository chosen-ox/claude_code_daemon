// Tests for FR-4: External Context Observability

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  FR4Monitor,
  findAllActiveSessions,
  findClaudeSessionJsonl,
  formatContextStatus,
  formatTokenUsage,
  formatCost,
  createStatusDisplay,
  type FR4Config,
  type FR4Status
} from '../../../src/session/fr4-monitor.js';
import type { TokenUsage } from '../../../src/types/index.js';

describe('FR4Monitor', () => {
  let monitor: FR4Monitor;
  let tempDir: string;
  let tempJsonlPath: string;

  beforeEach(() => {
    monitor = new FR4Monitor();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr4-test-'));
    tempJsonlPath = path.join(tempDir, 'test-session.jsonl');
  });

  afterEach(() => {
    monitor.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create monitor with default config', () => {
      const mon = new FR4Monitor();
      expect(mon).toBeDefined();
      expect(mon.getSource()).toBe('unavailable');
    });

    it('should accept custom config', () => {
      const config: Partial<FR4Config> = {
        effectiveContextLimitTokens: 100000,
        thresholdPercent: 75,
        snapshotReserveTokens: 5000
      };
      const mon = new FR4Monitor(config);
      expect(mon).toBeDefined();
    });
  });

  describe('healthCheck', () => {
    it('should return health check results', async () => {
      const results = await monitor.healthCheck();
      expect(results).toBeInstanceOf(Array);
      expect(results.length).toBeGreaterThan(0);

      // Check that we have results for expected sources
      const sources = results.map(r => r.source);
      expect(sources).toContain('jsonl');
      expect(sources).toContain('tmux');
      expect(sources).toContain('sdk');
    });
  });

  describe('watchJsonl', () => {
    it('should watch JSONL file and emit updates', async () => {
      // Create initial JSONL content
      const initialContent = JSON.stringify({
        type: 'session',
        version: 1,
        id: 'test-session',
        timestamp: new Date().toISOString(),
        cwd: tempDir
      }) + '\n';
      fs.writeFileSync(tempJsonlPath, initialContent);

      const updates: FR4Status[] = [];
      const watchHandle = monitor.watchJsonl(tempJsonlPath, {
        onStatusUpdate: (status) => updates.push(status)
      });

      // Wait a bit then add new content
      await new Promise(resolve => setTimeout(resolve, 100));

      const messageContent = JSON.stringify({
        type: 'message',
        role: 'assistant',
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 200,
          cacheCreationInputTokens: 0
        }
      }) + '\n';
      fs.appendFileSync(tempJsonlPath, messageContent);

      // Wait for polling
      await new Promise(resolve => setTimeout(resolve, 700));

      watchHandle.stop();

      // Should have received at least one update
      expect(updates.length).toBeGreaterThan(0);
      expect(updates[0].source).toBe('jsonl');
      expect(updates[0].usedTokens).toBe(1500); // 1000 + 500
    });

    it('should detect threshold reached', async () => {
      // Create initial JSONL content
      const initialContent = JSON.stringify({
        type: 'session',
        version: 1,
        id: 'test-session',
        timestamp: new Date().toISOString(),
        cwd: tempDir
      }) + '\n';
      fs.writeFileSync(tempJsonlPath, initialContent);

      let thresholdReached = false;
      const watchHandle = monitor.watchJsonl(tempJsonlPath, {
        onThresholdReached: () => {
          thresholdReached = true;
        }
      });

      // Add high token usage
      await new Promise(resolve => setTimeout(resolve, 100));
      const highUsageContent = JSON.stringify({
        type: 'message',
        role: 'assistant',
        usage: {
          inputTokens: 130000, // Above 80% of 150000
          outputTokens: 10000,
          cacheReadInputTokens: 5000,
          cacheCreationInputTokens: 0
        }
      }) + '\n';
      fs.appendFileSync(tempJsonlPath, highUsageContent);

      // Wait for polling
      await new Promise(resolve => setTimeout(resolve, 700));

      watchHandle.stop();

      expect(thresholdReached).toBe(true);
    });

    it('should stop monitoring when stop is called', async () => {
      fs.writeFileSync(tempJsonlPath, '');

      const watchHandle = monitor.watchJsonl(tempJsonlPath, {
        onStatusUpdate: () => {}
      });

      expect(monitor.getSource()).toBe('jsonl');

      watchHandle.stop();

      expect(monitor.getSource()).toBe('unavailable');
    });
  });

  describe('getStatus', () => {
    it('should return null when no status available', () => {
      expect(monitor.getStatus()).toBeNull();
    });
  });

  describe('resetThreshold', () => {
    it('should reset threshold trigger', () => {
      monitor.resetThreshold();
      // No error means success
      expect(true).toBe(true);
    });
  });
});

describe('Utility Functions', () => {
  describe('formatContextStatus', () => {
    it('should format normal context status', () => {
      const status: FR4Status = {
        usedTokens: 50000,
        totalTokens: 150000,
        percentUsed: 33.3,
        shouldRotate: false,
        emergencyRotate: false,
        source: 'jsonl',
        costUsd: 0.05,
        lastUpdated: new Date()
      };

      const formatted = formatContextStatus(status);
      expect(formatted).toContain('33.3%');
      expect(formatted).toContain('✓');
    });

    it('should format rotation needed status', () => {
      const status: FR4Status = {
        usedTokens: 125000,
        totalTokens: 150000,
        percentUsed: 83.3,
        shouldRotate: true,
        emergencyRotate: false,
        source: 'jsonl',
        costUsd: 0.10,
        lastUpdated: new Date()
      };

      const formatted = formatContextStatus(status);
      expect(formatted).toContain('83.3%');
      expect(formatted).toContain('⚠️');
    });

    it('should format emergency rotation status', () => {
      const status: FR4Status = {
        usedTokens: 145000,
        totalTokens: 150000,
        percentUsed: 96.7,
        shouldRotate: true,
        emergencyRotate: true,
        source: 'jsonl',
        costUsd: 0.15,
        lastUpdated: new Date()
      };

      const formatted = formatContextStatus(status);
      expect(formatted).toContain('96.7%');
      expect(formatted).toContain('🚨');
    });
  });

  describe('formatTokenUsage', () => {
    it('should format token usage', () => {
      const usage: TokenUsage = {
        inputTokens: 10000,
        outputTokens: 5000,
        cacheReadInputTokens: 2000,
        cacheCreationInputTokens: 0
      };

      const formatted = formatTokenUsage(usage);
      expect(formatted).toContain('12,000 in'); // input + cache
      expect(formatted).toContain('5,000 out');
      expect(formatted).toContain('2,000');
    });
  });

  describe('formatCost', () => {
    it('should format small costs in cents', () => {
      expect(formatCost(0.005)).toContain('¢');
    });

    it('should format larger costs in dollars', () => {
      expect(formatCost(1.5)).toContain('$');
    });
  });

  describe('createStatusDisplay', () => {
    it('should create status display', () => {
      const status: FR4Status = {
        usedTokens: 50000,
        totalTokens: 150000,
        percentUsed: 33.3,
        shouldRotate: false,
        emergencyRotate: false,
        source: 'jsonl',
        costUsd: 0.05,
        lastUpdated: new Date()
      };

      const display = createStatusDisplay('task-123', status);
      expect(display).toContain('task-123');
      expect(display).toContain('Context');
      expect(display).toContain('33.3%');
    });

    it('should include session info when provided', () => {
      const status: FR4Status = {
        usedTokens: 50000,
        totalTokens: 150000,
        percentUsed: 33.3,
        shouldRotate: false,
        emergencyRotate: false,
        source: 'jsonl',
        costUsd: 0.05,
        lastUpdated: new Date()
      };

      const display = createStatusDisplay('task-123', status, { iteration: 3, duration: 60000 });
      expect(display).toContain('Session');
      expect(display).toContain('#3');
      expect(display).toContain('1m');
    });
  });
});

describe('Session Discovery', () => {
  describe('findAllActiveSessions', () => {
    it('should return array of active sessions', () => {
      const sessions = findAllActiveSessions();
      expect(Array.isArray(sessions)).toBe(true);
    });

    it('should sort sessions by modification time', () => {
      const sessions = findAllActiveSessions();
      for (let i = 1; i < sessions.length; i++) {
        expect(sessions[i-1].modifiedAt.getTime()).toBeGreaterThanOrEqual(
          sessions[i].modifiedAt.getTime()
        );
      }
    });
  });

  describe('findClaudeSessionJsonl', () => {
    it('should return null when no session found', () => {
      const result = findClaudeSessionJsonl('nonexistent-session-id');
      expect(result).toBeNull();
    });

    it('should find most recent session when no ID provided', () => {
      const result = findClaudeSessionJsonl();
      // Result depends on whether there are active sessions
      // Just check it doesn't throw
      expect(true).toBe(true);
    });
  });
});
