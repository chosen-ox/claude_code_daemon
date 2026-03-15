// Tests for Session Spawner

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Set test environment
process.env.CC_DAEMON_DIR = path.join(os.tmpdir(), `cc-daemon-spawner-test-${Date.now()}`);

import { isClaudeAvailable } from '../../../src/session/spawner.js';
import { ensureDaemonDirs, getSessionsDir } from '../../../src/utils/paths.js';

describe('Session Spawner', () => {
  beforeAll(async () => {
    await ensureDaemonDirs();
  });

  afterAll(async () => {
    // Cleanup
    const dir = process.env.CC_DAEMON_DIR;
    if (dir && fs.existsSync(dir)) {
      await fs.promises.rm(dir, { recursive: true }).catch(() => {});
    }
  });

  it('should check if Claude CLI is available', async () => {
    // This test depends on whether Claude is installed
    const available = await isClaudeAvailable();
    // We just verify the function runs without error
    expect(typeof available).toBe('boolean');
  });

  it('should have sessions directory created', async () => {
    const sessionsDir = getSessionsDir();
    expect(fs.existsSync(sessionsDir)).toBe(true);
  });
});
