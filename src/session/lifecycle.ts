// Session Lifecycle - Manage active sessions

import * as fs from 'fs';
import * as path from 'path';
import type { TokenUsage, SessionRecord } from '../types/index.js';
import { generateSessionId } from '../utils/id.js';
import { getSessionsDir, ensureDir, getSessionPath } from '../utils/paths.js';

export type SessionStatus = 'starting' | 'active' | 'rotating' | 'completed' | 'failed' | 'terminated';

export interface ActiveSession {
  id: string;
  taskId: string;
  status: SessionStatus;
  startedAt: Date;
  pid?: number;
  outputFilePath: string;
  currentTokens: TokenUsage;
  lastActivity: Date;
}

export interface SessionRegistry {
  sessions: Map<string, ActiveSession>;
  sessionsDir: string;
}

// Global registry
let registry: SessionRegistry | null = null;

/**
 * Initialize the session registry
 */
export async function initRegistry(): Promise<SessionRegistry> {
  if (registry) {
    return registry;
  }

  await ensureDir(getSessionsDir());

  registry = {
    sessions: new Map(),
    sessionsDir: getSessionsDir()
  };

  // Load persisted sessions
  await loadPersistedSessions();

  return registry;
}

/**
 * Get the current registry
 */
export function getRegistry(): SessionRegistry {
  if (!registry) {
    throw new Error('Session registry not initialized. Call initRegistry() first.');
  }
  return registry;
}

/**
 * Load persisted sessions from disk
 */
async function loadPersistedSessions(): Promise<void> {
  if (!registry) return;

  const sessionsFile = path.join(registry.sessionsDir, 'active-sessions.json');

  if (!(await fileExists(sessionsFile))) {
    return;
  }

  try {
    const raw = await fs.promises.readFile(sessionsFile, 'utf-8');
    const sessions = JSON.parse(raw) as Array<{
      id: string;
      taskId: string;
      status: SessionStatus;
      startedAt: string;
      pid?: number;
      outputFilePath: string;
      currentTokens: TokenUsage;
      lastActivity: string;
    }>;

    // Only restore active sessions
    for (const s of sessions) {
      if (s.status === 'active' || s.status === 'starting') {
        registry.sessions.set(s.id, {
          ...s,
          startedAt: new Date(s.startedAt),
          lastActivity: new Date(s.lastActivity)
        });
      }
    }
  } catch {
    // Ignore errors loading persisted sessions
  }
}

/**
 * Persist sessions to disk
 */
async function persistSessions(): Promise<void> {
  if (!registry) return;

  const sessionsFile = path.join(registry.sessionsDir, 'active-sessions.json');

  const sessions = Array.from(registry.sessions.values()).map(s => ({
    ...s,
    startedAt: s.startedAt.toISOString(),
    lastActivity: s.lastActivity.toISOString()
  }));

  await fs.promises.writeFile(sessionsFile, JSON.stringify(sessions, null, 2));
}

/**
 * Register a new session
 */
export async function registerSession(
  taskId: string,
  options?: { pid?: number }
): Promise<ActiveSession> {
  const reg = getRegistry();

  const session: ActiveSession = {
    id: generateSessionId(),
    taskId,
    status: 'starting',
    startedAt: new Date(),
    pid: options?.pid,
    outputFilePath: getSessionPath(generateSessionId()),
    currentTokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    },
    lastActivity: new Date()
  };

  reg.sessions.set(session.id, session);
  await persistSessions();

  return session;
}

/**
 * Update session status
 */
export async function updateSessionStatus(
  sessionId: string,
  status: SessionStatus
): Promise<void> {
  const reg = getRegistry();
  const session = reg.sessions.get(sessionId);

  if (session) {
    session.status = status;
    session.lastActivity = new Date();
    await persistSessions();
  }
}

/**
 * Update session tokens
 */
export async function updateSessionTokens(
  sessionId: string,
  tokens: TokenUsage
): Promise<void> {
  const reg = getRegistry();
  const session = reg.sessions.get(sessionId);

  if (session) {
    session.currentTokens = tokens;
    session.lastActivity = new Date();
    await persistSessions();
  }
}

/**
 * Get session by ID
 */
export function getSession(sessionId: string): ActiveSession | undefined {
  const reg = getRegistry();
  return reg.sessions.get(sessionId);
}

/**
 * Get all active sessions
 */
export function getActiveSessions(): ActiveSession[] {
  const reg = getRegistry();
  return Array.from(reg.sessions.values()).filter(
    s => s.status === 'active' || s.status === 'starting' || s.status === 'rotating'
  );
}

/**
 * Get sessions for a task
 */
export function getSessionsForTask(taskId: string): ActiveSession[] {
  const reg = getRegistry();
  return Array.from(reg.sessions.values()).filter(s => s.taskId === taskId);
}

/**
 * Terminate a session
 */
export async function terminateSession(sessionId: string): Promise<void> {
  const reg = getRegistry();
  const session = reg.sessions.get(sessionId);

  if (session) {
    session.status = 'terminated';
    session.lastActivity = new Date();
    reg.sessions.delete(sessionId);
    await persistSessions();
  }
}

/**
 * Complete a session and create a record
 */
export async function completeSession(
  sessionId: string,
  record: Omit<SessionRecord, 'sessionId' | 'startedAt'>
): Promise<SessionRecord | null> {
  const reg = getRegistry();
  const session = reg.sessions.get(sessionId);

  if (!session) {
    return null;
  }

  const fullRecord: SessionRecord = {
    sessionId,
    startedAt: session.startedAt.toISOString(),
    ...record
  };

  session.status = 'completed';
  reg.sessions.delete(sessionId);
  await persistSessions();

  return fullRecord;
}

/**
 * Check for timed out sessions
 */
export async function checkTimeouts(timeoutMs: number = 30 * 60 * 1000): Promise<ActiveSession[]> {
  const reg = getRegistry();
  const now = new Date();
  const timedOut: ActiveSession[] = [];

  for (const session of reg.sessions.values()) {
    const age = now.getTime() - session.lastActivity.getTime();
    if (age > timeoutMs && (session.status === 'active' || session.status === 'starting')) {
      timedOut.push(session);
      session.status = 'terminated';
      reg.sessions.delete(session.id);
    }
  }

  if (timedOut.length > 0) {
    await persistSessions();
  }

  return timedOut;
}

/**
 * Get session statistics
 */
export function getSessionStats(): {
  total: number;
  active: number;
  completed: number;
  failed: number;
} {
  const reg = getRegistry();
  let active = 0;
  let completed = 0;
  let failed = 0;

  for (const session of reg.sessions.values()) {
    switch (session.status) {
      case 'active':
      case 'starting':
      case 'rotating':
        active++;
        break;
      case 'completed':
        completed++;
        break;
      case 'failed':
      case 'terminated':
        failed++;
        break;
    }
  }

  return {
    total: reg.sessions.size,
    active,
    completed,
    failed
  };
}

/**
 * Helper to check file existence
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}
