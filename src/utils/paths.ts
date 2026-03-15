// Path utilities for CC Session Daemon

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Support test mode via environment variable
function getDaemonDir(): string {
  return process.env.CC_DAEMON_DIR || path.join(os.homedir(), '.cc-daemon');
}

// Export both functions and constants for backward compatibility
export function getDaemonRoot(): string {
  return getDaemonDir();
}

export function getTasksDir(): string {
  return path.join(getDaemonDir(), 'tasks');
}

export function getSessionsDir(): string {
  return path.join(getDaemonDir(), 'sessions');
}

export function getConfigFile(): string {
  return path.join(getDaemonDir(), 'config.json');
}

// Constants (computed at import time - use functions for test compatibility)
export const DAEMON_DIR = getDaemonDir();
export const TASKS_DIR = getTasksDir();
export const SESSIONS_DIR = getSessionsDir();
export const CONFIG_FILE = getConfigFile();

export function getTaskDir(taskId: string): string {
  return path.join(getTasksDir(), taskId);
}

export function getPlanPath(taskId: string): string {
  return path.join(getTaskDir(taskId), 'plan.md');
}

export function getProgressPath(taskId: string): string {
  return path.join(getTaskDir(taskId), 'progress.md');
}

export function getMetadataPath(taskId: string): string {
  return path.join(getTaskDir(taskId), 'metadata.json');
}

export function getSessionPath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.jsonl`);
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

export async function ensureDaemonDirs(): Promise<void> {
  await ensureDir(getDaemonDir());
  await ensureDir(getTasksDir());
  await ensureDir(getSessionsDir());
}

export function fileExists(filePath: string): Promise<boolean> {
  return fs.promises.access(filePath).then(() => true).catch(() => false);
}
