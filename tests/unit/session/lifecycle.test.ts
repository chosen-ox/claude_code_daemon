// Tests for Session Lifecycle

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Set test environment
process.env.CC_DAEMON_DIR = path.join(os.tmpdir(), `cc-daemon-lifecycle-test-${Date.now()}`);

import {
  initRegistry,
  getRegistry,
  registerSession,
  updateSessionStatus,
  updateSessionTokens,
  getSession,
  getActiveSessions,
  getSessionsForTask,
  terminateSession,
  completeSession,
  checkTimeouts,
  getSessionStats
} from '../../../src/session/lifecycle.js';
import { ensureDaemonDirs, getTasksDir } from '../../../src/utils/paths.js';
import { taskManager } from '../../../src/task/manager.js';

describe('Session Lifecycle', () => {
  beforeAll(async () => {
    await ensureDaemonDirs();
    await initRegistry();
  });

  afterAll(async () => {
    // Cleanup
    const dir = process.env.CC_DAEMON_DIR;
    if (dir && fs.existsSync(dir)) {
      await fs.promises.rm(dir, { recursive: true }).catch(() => {});
    }
  });

  beforeEach(async () => {
    // Clear sessions before each test
    const registry = getRegistry();
    registry.sessions.clear();
  });

  it('should initialize registry', () => {
    const registry = getRegistry();
    expect(registry).toBeDefined();
    expect(registry.sessions).toBeInstanceOf(Map);
  });

  it('should register a new session', async () => {
    const metadata = await taskManager.createTask('Lifecycle test task');
    const session = await registerSession(metadata.id);

    expect(session).toBeDefined();
    expect(session.taskId).toBe(metadata.id);
    expect(session.status).toBe('starting');
    expect(session.currentTokens.inputTokens).toBe(0);
  });

  it('should update session status', async () => {
    const metadata = await taskManager.createTask('Status update test');
    const session = await registerSession(metadata.id);

    await updateSessionStatus(session.id, 'active');

    const updated = getSession(session.id);
    expect(updated?.status).toBe('active');
  });

  it('should update session tokens', async () => {
    const metadata = await taskManager.createTask('Token update test');
    const session = await registerSession(metadata.id);

    await updateSessionTokens(session.id, {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 10
    });

    const updated = getSession(session.id);
    expect(updated?.currentTokens.inputTokens).toBe(100);
    expect(updated?.currentTokens.outputTokens).toBe(50);
  });

  it('should get active sessions', async () => {
    const metadata1 = await taskManager.createTask('Active session 1');
    const metadata2 = await taskManager.createTask('Active session 2');

    await registerSession(metadata1.id);
    const session2 = await registerSession(metadata2.id);
    await updateSessionStatus(session2.id, 'active');

    const active = getActiveSessions();
    expect(active.length).toBe(2);
  });

  it('should get sessions for a specific task', async () => {
    const metadata = await taskManager.createTask('Task sessions test');
    await registerSession(metadata.id);
    await registerSession(metadata.id);

    const sessions = getSessionsForTask(metadata.id);
    expect(sessions.length).toBe(2);
  });

  it('should terminate a session', async () => {
    const metadata = await taskManager.createTask('Terminate test');
    const session = await registerSession(metadata.id);

    await terminateSession(session.id);

    const terminated = getSession(session.id);
    expect(terminated).toBeUndefined();
  });

  it('should complete a session and create record', async () => {
    const metadata = await taskManager.createTask('Complete test');
    const session = await registerSession(metadata.id);
    await updateSessionStatus(session.id, 'active');

    const record = await completeSession(session.id, {
      endedAt: new Date().toISOString(),
      duration: 5000,
      stepsCompleted: 2,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cost: 0.01
    });

    expect(record).toBeDefined();
    expect(record?.sessionId).toBe(session.id);
    expect(record?.stepsCompleted).toBe(2);

    const completed = getSession(session.id);
    expect(completed).toBeUndefined();
  });

  it('should get session stats', async () => {
    const metadata = await taskManager.createTask('Stats test');
    await registerSession(metadata.id);
    await registerSession(metadata.id);

    const stats = getSessionStats();
    expect(stats.total).toBe(2);
    expect(stats.active).toBe(2);
  });

  it('should check for timed out sessions', async () => {
    const metadata = await taskManager.createTask('Timeout test');
    const session = await registerSession(metadata.id);

    // Set last activity to 31 minutes ago
    const activeSession = getSession(session.id);
    if (activeSession) {
      activeSession.lastActivity = new Date(Date.now() - 31 * 60 * 1000);
    }

    const timedOut = await checkTimeouts(30 * 60 * 1000);
    expect(timedOut.length).toBe(1);
    expect(timedOut[0].id).toBe(session.id);

    const afterTimeout = getSession(session.id);
    expect(afterTimeout).toBeUndefined();
  });
});
