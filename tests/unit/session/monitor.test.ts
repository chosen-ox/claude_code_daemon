// Tests for Session Monitor

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseSessionFile,
  getLatestTokenUsage,
  calculateContextStatus
} from '../../../src/session/monitor.js';
import type { TokenUsage } from '../../../src/types/index.js';

describe('Session Monitor', () => {
  let testFile: string;

  beforeEach(async () => {
    const testDir = path.join(os.tmpdir(), 'cc-daemon-session-test-' + Date.now());
    await fs.promises.mkdir(testDir, { recursive: true });
    testFile = path.join(testDir, 'test-session.jsonl');
  });

  afterEach(async () => {
    await fs.promises.rm(path.dirname(testFile), { recursive: true, force: true });
  });

  describe('parseSessionFile', () => {
    it('should parse an empty file', async () => {
      await fs.promises.writeFile(testFile, '');
      const result = await parseSessionFile(testFile);

      expect(result.header).toBeNull();
      expect(result.messages).toHaveLength(0);
      expect(result.currentContextUsage.inputTokens).toBe(0);
    });

    it('should parse session header and messages', async () => {
      const content = [
        JSON.stringify({ type: 'session', version: 1, id: 'test-id', timestamp: '2026-02-28T00:00:00.000Z', cwd: '/test' }),
        JSON.stringify({ type: 'user', role: 'user', content: 'Hello' }),
        JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
      ].join('\n');

      await fs.promises.writeFile(testFile, content);
      const result = await parseSessionFile(testFile);

      expect(result.header).not.toBeNull();
      expect(result.header!.id).toBe('test-id');
      expect(result.messages).toHaveLength(2);
      // 只取最后一条 assistant 消息的 usage
      expect(result.currentContextUsage.inputTokens).toBe(10);
      expect(result.currentContextUsage.outputTokens).toBe(5);
    });

    it('should return last assistant message usage (not cumulative)', async () => {
      const content = [
        JSON.stringify({ type: 'session', version: 1, id: 'test-id', timestamp: '2026-02-28T00:00:00.000Z', cwd: '/test' }),
        JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 } } }),
        JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 30, cache_creation_input_tokens: 15 } } })
      ].join('\n');

      await fs.promises.writeFile(testFile, content);
      const result = await parseSessionFile(testFile);

      // 应该返回最后一条 assistant 的 usage，不是累积
      expect(result.currentContextUsage.inputTokens).toBe(200);
      expect(result.currentContextUsage.outputTokens).toBe(100);
      expect(result.currentContextUsage.cacheReadInputTokens).toBe(30);
      expect(result.currentContextUsage.cacheCreationInputTokens).toBe(15);
    });
  });

  describe('getLatestTokenUsage', () => {
    it('should return null for non-existent file', async () => {
      const usage = await getLatestTokenUsage('/nonexistent/file.jsonl');
      expect(usage).toBeNull();
    });

    it('should return the last usage from a session file', async () => {
      const content = [
        JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
        JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
      ].join('\n');

      await fs.promises.writeFile(testFile, content);
      const usage = await getLatestTokenUsage(testFile);

      expect(usage).not.toBeNull();
      expect(usage!.inputTokens).toBe(200);
      expect(usage!.outputTokens).toBe(100);
    });
  });

  describe('calculateContextStatus', () => {
    const config = {
      effectiveContextLimit: 150000,
      thresholdPercent: 80,
      snapshotReserveTokens: 8000
    };

    it('should calculate context status correctly for low usage', () => {
      const usage: TokenUsage = {
        inputTokens: 50000,
        outputTokens: 20000,
        cacheReadInputTokens: 10000,
        cacheCreationInputTokens: 5000
      };

      const status = calculateContextStatus(usage, config);

      expect(status.usedTokens).toBe(70000);
      expect(status.totalTokens).toBe(150000);
      expect(status.percentUsed).toBeCloseTo(46.67, 1);
      expect(status.shouldRotate).toBe(false);
      expect(status.emergencyRotate).toBe(false);
    });

    it('should trigger planned rotation at threshold', () => {
      const usage: TokenUsage = {
        inputTokens: 100000,
        outputTokens: 30000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0
      };

      const status = calculateContextStatus(usage, config);

      expect(status.percentUsed).toBeCloseTo(86.67, 1);
      expect(status.shouldRotate).toBe(true);
      expect(status.emergencyRotate).toBe(false);
    });

    it('should trigger emergency rotation when near limit', () => {
      const usage: TokenUsage = {
        inputTokens: 140000,
        outputTokens: 5000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0
      };

      const status = calculateContextStatus(usage, config);

      expect(status.shouldRotate).toBe(true);
      expect(status.emergencyRotate).toBe(true);
    });
  });
});
