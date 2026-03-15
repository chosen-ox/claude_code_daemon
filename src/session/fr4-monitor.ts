// FR-4: External Context Observability
// Real-time token monitoring with multi-source support (SDK > JSONL > tmux)

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { TokenUsage, ContextStatus, DaemonConfig } from '../types/index.js';
import { watchSessionTokens, calculateContextStatus, parseSessionFile } from './monitor.js';
import { captureTmuxPane, tmuxSessionExists, injectSlashCommand } from './tmux-spawner.js';

// ============================================================================
// Types
// ============================================================================

export type MonitoringSource = 'sdk' | 'jsonl' | 'tmux' | 'unavailable';

export interface FR4Config {
  effectiveContextLimitTokens: number;
  thresholdPercent: number;
  snapshotReserveTokens: number;
  pollIntervalMs?: number;
}

export interface FR4Status extends ContextStatus {
  source: MonitoringSource;
  costUsd: number;
  lastUpdated: Date;
  sessionId?: string;
  taskId?: string;
}

export interface SessionInfo {
  sessionId: string;
  taskId: string;
  tmuxSessionName?: string;
  jsonlPath?: string;
  startedAt: Date;
  tokenUsage: TokenUsage;
  costUsd: number;
  status: 'running' | 'rotating' | 'completed' | 'error';
}

export interface HealthCheckResult {
  source: MonitoringSource;
  available: boolean;
  message: string;
}

// ============================================================================
// JSONL Path Discovery
// ============================================================================

/**
 * Find the JSONL file for a Claude Code session
 * Claude Code stores session files in ~/.claude/projects/<project-hash>/<session-id>.jsonl
 */
export function findClaudeSessionJsonl(sessionId?: string): string | null {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  if (!fs.existsSync(claudeDir)) {
    return null;
  }

  // Get project directories
  const projectDirs = fs.readdirSync(claudeDir).filter(f => {
    const fullPath = path.join(claudeDir, f);
    return fs.statSync(fullPath).isDirectory();
  });

  // Search for JSONL files
  for (const projectDir of projectDirs) {
    const projectPath = path.join(claudeDir, projectDir);
    const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      if (sessionId && !file.includes(sessionId)) {
        continue;
      }

      const filePath = path.join(projectPath, file);
      // Check if this file is recent (modified in last hour)
      const stat = fs.statSync(filePath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < 3600000) { // 1 hour
        return filePath;
      }
    }
  }

  return null;
}

/**
 * Find all active Claude Code session JSONL files
 */
export function findAllActiveSessions(): Array<{ jsonlPath: string; sessionId: string; modifiedAt: Date }> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const sessions: Array<{ jsonlPath: string; sessionId: string; modifiedAt: Date }> = [];

  if (!fs.existsSync(claudeDir)) {
    return sessions;
  }

  const projectDirs = fs.readdirSync(claudeDir).filter(f => {
    const fullPath = path.join(claudeDir, f);
    return fs.statSync(fullPath).isDirectory();
  });

  for (const projectDir of projectDirs) {
    const projectPath = path.join(claudeDir, projectDir);
    const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(projectPath, file);
      const stat = fs.statSync(filePath);
      const ageMs = Date.now() - stat.mtimeMs;

      // Active if modified in last 3 minutes
      if (ageMs < 180000) {
        sessions.push({
          jsonlPath: filePath,
          sessionId: file.replace('.jsonl', ''),
          modifiedAt: stat.mtime
        });
      }
    }
  }

  return sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

// ============================================================================
// FR4 Monitor Class
// ============================================================================

export class FR4Monitor {
  private config: FR4Config;
  private watchHandle: { stop: () => void } | null = null;
  private currentSource: MonitoringSource = 'unavailable';
  private lastStatus: FR4Status | null = null;
  private onStatusUpdate?: (status: FR4Status) => void;
  private onThresholdReached?: (status: FR4Status) => void | Promise<void>;
  private thresholdTriggered: boolean = false;

  constructor(config: Partial<FR4Config> = {}) {
    this.config = {
      effectiveContextLimitTokens: config.effectiveContextLimitTokens || 150000,
      thresholdPercent: config.thresholdPercent || 80,
      snapshotReserveTokens: config.snapshotReserveTokens || 8000,
      pollIntervalMs: config.pollIntervalMs || 500
    };
  }

  /**
   * Check health of monitoring sources
   */
  async healthCheck(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];

    // Check JSONL availability
    const activeSessions = findAllActiveSessions();
    results.push({
      source: 'jsonl',
      available: activeSessions.length > 0,
      message: activeSessions.length > 0
        ? `Found ${activeSessions.length} active session(s)`
        : 'No active JSONL sessions found'
    });

    // Check tmux availability
    try {
      const { exec } = await import('child_process');
      const tmuxAvailable = await new Promise<boolean>((resolve) => {
        exec('tmux -V', (error) => resolve(!error));
      });
      results.push({
        source: 'tmux',
        available: tmuxAvailable,
        message: tmuxAvailable ? 'tmux is available' : 'tmux is not installed'
      });
    } catch {
      results.push({
        source: 'tmux',
        available: false,
        message: 'tmux check failed'
      });
    }

    // SDK would require running in-process, mark as available if we're in a Claude session
    results.push({
      source: 'sdk',
      available: false,
      message: 'SDK monitoring requires in-process integration'
    });

    return results;
  }

  /**
   * Start monitoring a JSONL file
   */
  watchJsonl(
    jsonlPath: string,
    callbacks: {
      onStatusUpdate?: (status: FR4Status) => void;
      onThresholdReached?: (status: FR4Status) => void | Promise<void>;
    }
  ): { stop: () => void } {
    this.onStatusUpdate = callbacks.onStatusUpdate;
    this.onThresholdReached = callbacks.onThresholdReached;
    this.currentSource = 'jsonl';
    this.thresholdTriggered = false;

    // Stop any existing watch
    if (this.watchHandle) {
      this.watchHandle.stop();
    }

    // Start watching
    this.watchHandle = watchSessionTokens(
      jsonlPath,
      (usage, cumulative) => {
        this.handleTokenUpdate(cumulative);
      },
      { pollIntervalMs: this.config.pollIntervalMs }
    );

    return { stop: () => this.stop() };
  }

  /**
   * Monitor all active sessions
   */
  watchActiveSessions(
    callbacks: {
      onStatusUpdate?: (status: FR4Status, sessionId: string) => void;
      onThresholdReached?: (status: FR4Status, sessionId: string) => void | Promise<void>;
    }
  ): { stop: () => void } {
    const activeSessions = findAllActiveSessions();

    if (activeSessions.length === 0) {
      return { stop: () => {} };
    }

    // Monitor the most recent session
    const latestSession = activeSessions[0];
    return this.watchJsonl(latestSession.jsonlPath, {
      onStatusUpdate: (status) => callbacks.onStatusUpdate?.(status, latestSession.sessionId),
      onThresholdReached: (status) => callbacks.onThresholdReached?.(status, latestSession.sessionId)
    });
  }

  /**
   * Handle token update from monitoring
   */
  private handleTokenUpdate(cumulative: TokenUsage): void {
    const contextStatus = calculateContextStatus(cumulative, {
      effectiveContextLimit: this.config.effectiveContextLimitTokens,
      thresholdPercent: this.config.thresholdPercent,
      snapshotReserveTokens: this.config.snapshotReserveTokens
    });

    const status: FR4Status = {
      ...contextStatus,
      source: this.currentSource,
      costUsd: this.lastStatus?.costUsd || 0,
      lastUpdated: new Date()
    };

    this.lastStatus = status;

    // Emit status update
    this.onStatusUpdate?.(status);

    // Check threshold
    if ((status.shouldRotate || status.emergencyRotate) && !this.thresholdTriggered) {
      this.thresholdTriggered = true;
      this.onThresholdReached?.(status);
    }
  }

  /**
   * Get current status
   */
  getStatus(): FR4Status | null {
    return this.lastStatus;
  }

  /**
   * Get monitoring source
   */
  getSource(): MonitoringSource {
    return this.currentSource;
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.watchHandle) {
      this.watchHandle.stop();
      this.watchHandle = null;
    }
    this.currentSource = 'unavailable';
  }

  /**
   * Reset threshold trigger (after rotation)
   */
  resetThreshold(): void {
    this.thresholdTriggered = false;
  }
}

// ============================================================================
// Status Display Utilities
// ============================================================================

/**
 * Format context status for display
 */
export function formatContextStatus(status: FR4Status): string {
  const barLength = 20;
  const filled = Math.round((status.percentUsed / 100) * barLength);
  const empty = barLength - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  const statusIcon = status.emergencyRotate ? '🚨' : status.shouldRotate ? '⚠️' : '✓';

  return `${statusIcon} Context: [${bar}] ${status.percentUsed.toFixed(1)}% (${status.usedTokens.toLocaleString()} / ${status.totalTokens.toLocaleString()} tokens)`;
}

/**
 * Format token usage for display
 */
export function formatTokenUsage(usage: TokenUsage): string {
  const input = (usage.inputTokens + usage.cacheReadInputTokens).toLocaleString();
  const output = usage.outputTokens.toLocaleString();
  const cache = usage.cacheReadInputTokens.toLocaleString();

  return `Tokens: ${input} in / ${output} out (cache: ${cache})`;
}

/**
 * Format cost for display
 */
export function formatCost(costUsd: number): string {
  if (costUsd < 0.01) {
    return `$${(costUsd * 100).toFixed(2)}¢`;
  }
  return `$${costUsd.toFixed(4)}`;
}

/**
 * Create a real-time status display
 */
export function createStatusDisplay(
  taskId: string,
  status: FR4Status,
  sessionInfo?: { iteration: number; duration: number }
): string {
  const lines: string[] = [];
  const width = 70;

  lines.push('┌' + '─'.repeat(width - 2) + '┐');
  const taskLine = `│ Task: ${taskId.slice(0, 8)}...`;
  lines.push(taskLine + ' '.repeat(width - taskLine.length - 1) + '│');
  lines.push('├' + '─'.repeat(width - 2) + '┤');

  // Context bar
  const contextBar = formatContextStatus(status);
  const contextLine = `│ ${contextBar}`;
  lines.push(contextLine + ' '.repeat(Math.max(0, width - contextLine.length - 1)) + '│');

  // Token details
  if (status.usedTokens > 0) {
    lines.push('├' + '─'.repeat(width - 2) + '┤');

    const thresholdLine = `│ Threshold: ${status.percentUsed}% (${status.usedTokens.toLocaleString()} tokens)`;
    lines.push(thresholdLine + ' '.repeat(Math.max(0, width - thresholdLine.length - 1)) + '│');

    const reserve = status.totalTokens - status.usedTokens;
    const reserveLine = `│ Reserve: ${reserve.toLocaleString()} tokens`;
    lines.push(reserveLine + ' '.repeat(Math.max(0, width - reserveLine.length - 1)) + '│');

    if (status.costUsd > 0) {
      const costStr = formatCost(status.costUsd);
      const costLine = `│ Cost: ${costStr}`;
      lines.push(costLine + ' '.repeat(Math.max(0, width - costLine.length - 1)) + '│');
    }
  }

  if (sessionInfo) {
    lines.push('├' + '─'.repeat(width - 2) + '┤');
    const sessionLine = `│ Session: #${sessionInfo.iteration}`;
    lines.push(sessionLine + ' '.repeat(Math.max(0, width - sessionLine.length - 1)) + '│');
    const duration = formatDuration(sessionInfo.duration);
    const durationLine = `│ Duration: ${duration}`;
    lines.push(durationLine + ' '.repeat(Math.max(0, width - durationLine.length - 1)) + '│');
  }

  lines.push('└' + '─'.repeat(width - 2) + '┘');

  return lines.join('\n');
}

/**
 * Format duration in human-readable form
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

// ============================================================================
// Watch Mode for CLI
// ============================================================================

export interface WatchModeOptions {
  taskId?: string;
  jsonlPath?: string;
  refreshIntervalMs?: number;
  onDisplay?: (display: string) => void;
}

/**
 * Run watch mode for real-time status display
 */
export async function runWatchMode(options: WatchModeOptions): Promise<{ stop: () => void }> {
  const refreshInterval = options.refreshIntervalMs || 1000;
  let monitor: FR4Monitor | null = null;
  let running = true;

  // Find JSONL path
  let jsonlPath: string | undefined = options.jsonlPath;
  if (!jsonlPath) {
    jsonlPath = findClaudeSessionJsonl() ?? undefined;
  }

  if (!jsonlPath) {
    options.onDisplay?.('No active Claude Code session found.');
    return { stop: () => { running = false; } };
  }

  // Create monitor
  monitor = new FR4Monitor();

  // Start watching
  const watchHandle = monitor.watchJsonl(jsonlPath, {
    onStatusUpdate: (status) => {
      if (!running) return;

      // Clear screen and show status
      const display = createStatusDisplay(
        options.taskId || 'unknown',
        status
      );

      options.onDisplay?.(`\x1b[2J\x1b[H${display}\n\nSource: ${status.source} | Updated: ${status.lastUpdated.toLocaleTimeString()}`);
    }
  });

  return {
    stop: () => {
      running = false;
      watchHandle.stop();
      monitor?.stop();
    }
  };
}
