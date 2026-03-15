// Tmux Session Spawner - Spawn Claude Code in tmux for injection support

import { spawn, exec, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { TokenUsage } from '../types/index.js';
import { generateSessionId } from '../utils/id.js';
import { getSessionsDir, ensureDir, getSessionPath, getProgressPath } from '../utils/paths.js';
import { parseSessionFile } from './monitor.js';

export interface TmuxSession {
  sessionId: string;
  tmuxSessionName: string;
  taskId: string;
  startedAt: Date;
  status: 'running' | 'completed' | 'rotating' | 'error';
  output: string;
  tokenUsage: TokenUsage;
  costUsd: number;
  jsonlPath: string;
}

export interface TmuxSpawnOptions {
  taskId: string;
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
  outputFile?: string;
  dangerousSkipPermissions?: boolean;
  verbose?: boolean;
  onOutput?: (chunk: string, parsed: ParsedOutput | null) => void;
  onTokenUpdate?: (usage: TokenUsage) => void | Promise<void>;
  onRotationSignal?: () => void | Promise<void>;
  ralphLoopMode?: boolean;
}

export interface ParsedOutput {
  type: string;
  content?: string;
  usage?: TokenUsage;
  costUsd?: number;
  isRotationSignal?: boolean;
  isCompletionSignal?: boolean;
}

// Rotation signal that Claude should output when context is getting full
export const ROTATION_SIGNAL = '<!-- ROTATION_REQUEST -->';
export const COMPLETION_SIGNAL_PREFIX = '<!-- COMPLETION:';
export const COMPLETION_SIGNAL_SUFFIX = ' -->';

/**
 * Claude Code input mode.
 * - 'vim': vim keybindings enabled (--vim flag). Status line shows '-- INSERT --' / '-- NORMAL --'.
 *          Injection requires: i → type → Escape → Enter
 * - 'normal': standard readline-style input (default). Prompt shows '❯'.
 *             Injection requires: type → Enter
 */
export type InputMode = 'vim' | 'normal';

/**
 * Detect Claude Code input mode from captured pane content.
 * Vim mode shows '-- INSERT --' or '-- NORMAL --' in the status line.
 */
export function detectInputMode(paneContent: string): InputMode {
  if (paneContent.includes('-- INSERT --') || paneContent.includes('-- NORMAL --')) {
    return 'vim';
  }
  return 'normal';
}

/**
 * Detect whether Claude Code is ready for initial input from pane content.
 * Returns the detected input mode, or null if not ready yet.
 *
 * Note: This is for startup detection only. During a session, vim mode's
 * '-- INSERT --' indicator disappears while Claude is processing and after
 * Ctrl+C interrupts. Use the stored inputMode from session start for
 * mid-session injections rather than re-detecting from the pane.
 */
export function detectReadyMode(paneContent: string): InputMode | null {
  // Vim mode: status line present at startup
  if (detectInputMode(paneContent) === 'vim') {
    return 'vim';
  }
  // Normal mode: Claude Code ❯ prompt visible
  if (paneContent.includes('❯') || /\n>\s*$/.test(paneContent)) {
    return 'normal';
  }
  return null;
}

/**
 * Check if tmux is available
 */
export async function isTmuxAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    exec('tmux -V', (error) => {
      resolve(!error);
    });
  });
}

/**
 * Generate tmux session name
 */
function generateTmuxSessionName(taskId: string, iteration: number): string {
  return `cc-daemon-${taskId.slice(0, 8)}-${iteration}`;
}

// Socket name for cc-daemon tmux sessions
const TMUX_SOCKET_NAME = 'cc-daemon';

/**
 * Execute a tmux command and return output
 * Uses setsid to create new session if needed (for environments without TTY)
 * Uses -L to specify a consistent socket name for all operations
 */
function execTmux(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    // Use setsid to create a new session, which allows tmux to work
    // even when stdin/stdout are redirected (e.g., in Claude Code subprocess)
    // Use -L to specify a consistent socket name
    // Properly quote arguments that contain spaces or special characters
    const quotedArgs = args.map(arg => {
      // If argument contains spaces, quotes, tmux format strings, or special chars, wrap in single quotes
      if (/[\s"'$`\\!#{}]/.test(arg)) {
        // Escape single quotes and wrap in single quotes
        return `'${arg.replace(/'/g, "'\\''")}'`;
      }
      return arg;
    }).join(' ');

    // setsid may not be available on macOS. Use it if available, otherwise run tmux directly.
    // The setsid helps when running in subprocesses with redirected stdin/stdout.
    const setsidPrefix = process.platform === 'darwin' ? '' : 'setsid ';
    const cmd = `${setsidPrefix}tmux -L ${TMUX_SOCKET_NAME} ${quotedArgs} 2>&1`;
    exec(cmd, (error, stdout, stderr) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: error ? 1 : 0
      });
    });
  });
}

/**
 * Capture tmux pane content
 */
export async function captureTmuxPane(sessionName: string): Promise<string> {
  // Capture the full scrollback history, not just visible content
  // -S - means start from beginning of history
  // -E - means end at bottom of history
  const result = await execTmux(['capture-pane', '-t', sessionName, '-p', '-S', '-', '-E', '-']);
  return result.stdout;
}

/**
 * Capture only the visible pane area as plain text (no ANSI escape sequences).
 * Used by the embedded terminal. Plain text avoids replaying tmux's cursor-positioning
 * sequences into xterm.js which would cause garbled rendering.
 */
export async function captureTmuxPaneVisible(sessionName: string): Promise<string> {
  const result = await execTmux(['capture-pane', '-t', sessionName, '-p']);
  // Trim trailing whitespace from each line (tmux pads lines to pane width with spaces)
  return result.stdout.split('\n').map(l => l.trimEnd()).join('\n');
}

/**
 * Resize a tmux window to the given dimensions.
 */
export async function resizeTmuxWindow(sessionName: string, cols: number, rows: number): Promise<void> {
  await execTmux(['resize-window', '-t', sessionName, '-x', String(cols), '-y', String(rows)]);
}

/**
 * Send keys to tmux session
 */
export async function sendTmuxKeys(sessionName: string, keys: string): Promise<void> {
  await execTmux(['send-keys', '-t', sessionName, keys]);
}

/**
 * Send text input to running Claude session.
 *
 * Supports two input modes:
 * - 'vim': Claude Code started with --vim. Uses i/Escape keybindings.
 * - 'normal': Standard readline input (default). Type + Enter only.
 *
 * If `mode` is omitted, auto-detects from the current pane content.
 *
 * IMPORTANT: Also handles the interruption dialog ("What should Claude do instead?").
 */
export async function injectPrompt(sessionName: string, prompt: string, verbose?: boolean, mode?: InputMode): Promise<void> {
  if (verbose) {
    console.log(`[injectPrompt] Starting injection for session: ${sessionName}`);
    console.log(`[injectPrompt] Original prompt length: ${prompt.length}`);
  }

  // Step 1: Capture current state
  let paneContent = '';
  try {
    paneContent = await captureTmuxPane(sessionName);
    if (verbose) {
      console.log(`[injectPrompt] Current pane content length: ${paneContent.length}`);
    }
  } catch (e) {
    if (verbose) {
      console.log(`[injectPrompt] Failed to capture pane: ${e}`);
    }
  }

  // Auto-detect mode from pane if not provided
  const inputMode: InputMode = mode ?? detectInputMode(paneContent);
  if (verbose) {
    console.log(`[injectPrompt] Input mode: ${inputMode}${mode ? ' (explicit)' : ' (auto-detected)'}`);
  }

  // Step 2: Handle post-interrupt state.
  // "Interrupted · What should Claude do instead?" is display text in the conversation
  // area, NOT a blocking modal. In both vim and normal mode, the ❯ input cursor is
  // already active after Ctrl+C — no Escape needed to "dismiss" anything.
  if (verbose && (paneContent.includes('Interrupted') || paneContent.includes('What should Claude do instead?'))) {
    console.log(`[injectPrompt] Post-interrupt state detected (not a modal, proceeding directly)`);
  }

  // Helper: send prompt text in chunks with escaping
  const sendPromptText = async () => {
    const chunkSize = 50;
    for (let i = 0; i < prompt.length; i += chunkSize) {
      const chunk = prompt.slice(i, i + chunkSize);
      const escapedChunk = chunk
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`');
      await sendTmuxKeys(sessionName, escapedChunk);
      await sleepMs(50);
    }
  };

  if (inputMode === 'vim') {
    // Vim mode:
    // After Ctrl+C, the input returns but -- INSERT -- disappears from the status bar.
    // Must press 'i' first to re-activate INSERT mode, then C-u clears the line,
    // then type, then Escape (→ NORMAL) + Enter to submit.
    await sendTmuxKeys(sessionName, 'i');      // ensure INSERT mode
    await sleepMs(200);
    await sendTmuxKeys(sessionName, 'C-u');    // clear line (works in INSERT mode)
    await sleepMs(100);

    if (verbose) console.log(`[injectPrompt] Vim mode: ready to send prompt text...`);

    await sendPromptText();
    await sleepMs(300);

    await sendTmuxKeys(sessionName, 'Escape'); // INSERT → NORMAL
    await sleepMs(150);
    await sendTmuxKeys(sessionName, 'Enter');  // submit from NORMAL
  } else {
    // Normal (readline) mode:
    // C-u clears the current input line, then type, then Enter to submit.
    // No 'i' needed — there is no modal to escape from after Ctrl+C.
    await sendTmuxKeys(sessionName, 'C-u');
    await sleepMs(100);

    if (verbose) console.log(`[injectPrompt] Normal mode: ready to send prompt text...`);

    await sendPromptText();
    await sleepMs(300);

    await sendTmuxKeys(sessionName, 'Enter');
  }

  if (verbose) {
    console.log(`[injectPrompt] Prompt injection complete`);
  }

  if (verbose) {
    await sleepMs(1000);
    try {
      const newContent = await captureTmuxPane(sessionName);
      const promptPreview = prompt.slice(0, 30).replace(/\n/g, ' ');
      const found = newContent.includes('URGENT') ||
                    newContent.includes('ROTATION') ||
                    newContent.includes(promptPreview);
      console.log(`[injectPrompt] Prompt visibility check: ${found ? 'FOUND' : 'NOT FOUND'}`);
      console.log(`[injectPrompt] Pane content length after: ${newContent.length}`);
    } catch (e) {
      console.log(`[injectPrompt] Could not verify prompt injection: ${e}`);
    }
  }
}

/**
 * Inject a slash command (e.g., /context, /cost)
 */
export async function injectSlashCommand(sessionName: string, command: string, verbose?: boolean): Promise<void> {
  // Ensure command starts with /
  const cmd = command.startsWith('/') ? command : `/${command}`;
  await injectPrompt(sessionName, cmd, verbose);
}

/**
 * Sleep helper for injection delays
 */
function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Kill tmux session
 */
export async function killTmuxSession(sessionName: string): Promise<void> {
  await execTmux(['kill-session', '-t', sessionName]);
}

/**
 * Check if tmux session exists
 */
export async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  const result = await execTmux(['has-session', '-t', sessionName]);
  return result.code === 0;
}

/**
 * List all cc-daemon tmux sessions
 */
export async function listCcDaemonSessions(): Promise<string[]> {
  const result = await execTmux(['list-sessions', '-F', '#{session_name}']);
  if (result.code !== 0) return [];

  return result.stdout
    .split('\n')
    .filter(name => name.startsWith('cc-daemon-'));
}

// ============================================================================
// Enhanced Snapshot Completion Detection (FR-4 Improvement 1)
// ============================================================================

/**
 * Snapshot completion detection options
 */
export interface SnapshotDetectionOptions {
  /** Timeout in milliseconds */
  timeout?: number;
  /** Poll interval in milliseconds */
  pollInterval?: number;
  /** Task ID for progress.md monitoring */
  taskId?: string;
  /** Progress file path (alternative to taskId) */
  progressPath?: string;
}

/**
 * Snapshot completion detection result
 */
export interface SnapshotDetectionResult {
  detected: boolean;
  method: 'tmux_signal' | 'file_modification' | 'timeout';
  elapsed: number;
}

/**
 * Wait for snapshot completion using dual detection mechanism
 * 1. Monitor tmux output for ROTATION_SNAPSHOT_COMPLETE signal
 * 2. Monitor progress.md modification time as backup
 *
 * @param sessionName - tmux session name to monitor
 * @param options - Detection options
 * @returns Detection result with method used
 */
export async function waitForSnapshotComplete(
  sessionName: string,
  options: SnapshotDetectionOptions = {}
): Promise<SnapshotDetectionResult> {
  const timeout = options.timeout || 60000; // Default 1 minute
  const pollInterval = options.pollInterval || 500;
  const startTime = Date.now();

  // Determine progress file path
  let progressPath: string | null = null;
  if (options.progressPath) {
    progressPath = options.progressPath;
  } else if (options.taskId) {
    progressPath = getProgressPath(options.taskId);
  }

  // Get initial modification time if file exists
  let initialModTime = 0;
  if (progressPath && fs.existsSync(progressPath)) {
    initialModTime = fs.statSync(progressPath).mtimeMs;
  }

  // Get initial output to compare against
  let lastOutput = await captureTmuxPane(sessionName);

  while (Date.now() - startTime < timeout) {
    // Method 1: Check tmux output for completion signal
    const currentOutput = await captureTmuxPane(sessionName);
    const newContent = currentOutput.slice(lastOutput.length);
    lastOutput = currentOutput;

    if (newContent.includes('ROTATION_SNAPSHOT_COMPLETE')) {
      return {
        detected: true,
        method: 'tmux_signal',
        elapsed: Date.now() - startTime
      };
    }

    // Method 2: Check progress.md modification time
    if (progressPath && fs.existsSync(progressPath)) {
      const currentModTime = fs.statSync(progressPath).mtimeMs;
      if (currentModTime > initialModTime && initialModTime > 0) {
        return {
          detected: true,
          method: 'file_modification',
          elapsed: Date.now() - startTime
        };
      }
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return {
    detected: false,
    method: 'timeout',
    elapsed: Date.now() - startTime
  };
}

/**
 * Check if progress file has been modified recently
 * Useful for detecting completion when tmux output is unreliable
 */
export async function checkProgressFileModified(
  taskId: string,
  sinceMs: number
): Promise<boolean> {
  const progressPath = getProgressPath(taskId);

  if (!fs.existsSync(progressPath)) {
    return false;
  }

  const modTime = fs.statSync(progressPath).mtimeMs;
  return modTime > sinceMs;
}

/**
 * Spawn Claude Code in a tmux session
 */
export class TmuxClaudeSession {
  private sessionId: string;
  private tmuxSessionName: string;
  private taskId: string;
  private iteration: number;
  private options: TmuxSpawnOptions;
  private inputMode: InputMode = 'normal';
  private output: string = '';
  private tokenUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0
  };
  private costUsd: number = 0;
  private status: TmuxSession['status'] = 'running';
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private startTime: number = 0;
  private completionPromise: string;
  private resolvePromise: ((result: TmuxSessionResult) => void) | null = null;
  private firstPollDone: boolean = false;
  private rotationRequested: boolean = false;
  private _completionDetected: boolean = false;

  constructor(
    taskId: string,
    iteration: number,
    options: TmuxSpawnOptions,
    completionPromise: string
  ) {
    this.sessionId = generateSessionId();
    this.tmuxSessionName = generateTmuxSessionName(taskId, iteration);
    this.taskId = taskId;
    this.iteration = iteration;
    this.options = options;
    this.completionPromise = completionPromise;
  }

  /**
   * Start the session
   */
  async start(initialPrompt: string): Promise<TmuxSessionResult> {
    this.startTime = Date.now();

    // Check tmux availability
    if (!(await isTmuxAvailable())) {
      throw new Error('tmux is not available. Please install tmux first.');
    }

    // Create tmux session with Claude
    const cwd = this.options.cwd || process.cwd();

    // Build claude command - use interactive mode (no -p) so user can attach and see
    // Include --session-id to bind tmux session with JSONL file for precise token monitoring
    const claudeArgs = [
      'claude',
      '--output-format', 'stream-json',
      '--verbose',
      '--session-id', this.sessionId
    ];

    if (this.options.dangerousSkipPermissions !== false) {
      claudeArgs.push('--dangerously-skip-permissions');
    }

    // Create tmux session with a shell first (to keep it alive)
    // Then we'll send the claude command with the prompt
    if (this.options.verbose && this.options.onOutput) {
      this.options.onOutput(`[DEBUG] Creating tmux session: ${this.tmuxSessionName}\n`, null);
    }

    const createResult = await execTmux([
      'new-session',
      '-d',
      '-s', this.tmuxSessionName,
      '-c', cwd,
      '-x', '200',
      '-y', '50',
      'bash'  // Start with bash to keep session alive
    ]);

    // Increase scrollback limit to 100000 lines to prevent content loss
    await execTmux(['set-option', '-t', this.tmuxSessionName, 'history-limit', '100000']);

    if (this.options.verbose && this.options.onOutput) {
      this.options.onOutput(`[DEBUG] Create result: code=${createResult.code}, stdout=${createResult.stdout}, stderr=${createResult.stderr}\n`, null);
    }

    if (createResult.code !== 0) {
      throw new Error(`Failed to create tmux session: ${createResult.stderr}`);
    }

    // Verify session was created
    const existsAfterCreate = await tmuxSessionExists(this.tmuxSessionName);
    if (this.options.verbose && this.options.onOutput) {
      this.options.onOutput(`[DEBUG] Session exists after create: ${existsAfterCreate}\n`, null);
    }

    if (!existsAfterCreate) {
      throw new Error('Tmux session was created but does not exist');
    }

    // Wait for shell to start
    await this.sleep(1000);

    // Disable bash history expansion to avoid issues with ! character
    await sendTmuxKeys(this.tmuxSessionName, 'set +H');
    await sendTmuxKeys(this.tmuxSessionName, 'Enter');
    await this.sleep(500);

    // Unset CLAUDECODE to allow nested Claude sessions
    await sendTmuxKeys(this.tmuxSessionName, 'unset CLAUDECODE');
    await sendTmuxKeys(this.tmuxSessionName, 'Enter');
    await this.sleep(500);

    // Start claude in INTERACTIVE mode (no -p flag)
    // This allows user to attach and use /context, /cost commands
    const fullCommand = claudeArgs.join(' ');
    if (this.options.verbose && this.options.onOutput) {
      this.options.onOutput(`[DEBUG] Starting claude in interactive mode...\n`, null);
      this.options.onOutput(`[DEBUG] Session ID: ${this.sessionId}\n`, null);
      this.options.onOutput(`[DEBUG] JSONL path: ${this.getJsonlPath()}\n`, null);
    }

    // Send the claude command (without prompt - will start REPL)
    await sendTmuxKeys(this.tmuxSessionName, fullCommand);
    await sendTmuxKeys(this.tmuxSessionName, 'Enter');

    // Wait for Claude REPL to be ready - detect both vim and normal mode
    const readyTimeout = 30000; // 30 seconds max wait
    const readyStart = Date.now();
    let claudeReady = false;
    while (Date.now() - readyStart < readyTimeout) {
      try {
        const pane = await captureTmuxPane(this.tmuxSessionName);
        const detectedMode = detectReadyMode(pane);
        if (detectedMode !== null) {
          this.inputMode = detectedMode;
          claudeReady = true;
          break;
        }
      } catch { /* ignore */ }
      await this.sleep(1000);
    }

    if (!claudeReady) {
      if (this.options.verbose && this.options.onOutput) {
        this.options.onOutput(`[DEBUG] Warning: Claude REPL may not be ready, proceeding anyway...\n`, null);
      }
      // Best-effort mode detection from final pane state
      try {
        const pane = await captureTmuxPane(this.tmuxSessionName);
        this.inputMode = detectInputMode(pane);
      } catch { /* ignore */ }
    }

    if (this.options.verbose && this.options.onOutput) {
      this.options.onOutput(`[DEBUG] Detected input mode: ${this.inputMode}\n`, null);
    }

    // Now send the prompt as user input in the REPL
    const enhancedPrompt = this.buildEnhancedPrompt(initialPrompt);
    if (this.options.verbose && this.options.onOutput) {
      this.options.onOutput(`[DEBUG] Sending prompt to Claude REPL...\n`, null);
    }

    // Send prompt as a single concatenated line (tmux send-keys handles it)
    // Replace newlines with spaces to avoid partial submission
    const flatPrompt = enhancedPrompt.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    await sendTmuxKeys(this.tmuxSessionName, flatPrompt);
    await this.sleep(200);

    if (this.inputMode === 'vim') {
      // Vim mode: exit INSERT mode then Enter submits from NORMAL mode
      await sendTmuxKeys(this.tmuxSessionName, 'Escape');
      await this.sleep(100);
    }
    await sendTmuxKeys(this.tmuxSessionName, 'Enter');

    // Wait for Claude to start processing
    await this.sleep(2000);

    // Start polling for output
    return new Promise((resolve) => {
      this.resolvePromise = resolve;

      // Poll for output and status
      this.pollInterval = setInterval(() => {
        this.pollOutput();
      }, 1000);

      // Set timeout
      if (this.options.timeout) {
        setTimeout(async () => {
          if (this.status === 'running') {
            this.status = 'error';
            this.cleanup();
            // Kill tmux session to free resources
            try {
              await killTmuxSession(this.tmuxSessionName);
            } catch {
              // Session might already be gone
            }
            resolve(this.getResult('Timeout reached'));
          }
        }, this.options.timeout);
      }
    });
  }

  /**
   * Inject a prompt into the running session
   */
  async injectPrompt(prompt: string): Promise<void> {
    if (this.status !== 'running') {
      throw new Error('Session is not running');
    }

    // Add rotation instructions to prompt if this is a mid-session injection
    const enhancedPrompt = `${prompt}

IMPORTANT: Monitor your context usage. When you feel you're approaching 80% context capacity, output this exact signal: ${ROTATION_SIGNAL}
Then complete your current step and wait for further instructions.`;

    await injectPrompt(this.tmuxSessionName, enhancedPrompt, this.options.verbose, this.inputMode);
  }

  /**
   * Request rotation - directly inject rotation prompt
   * Called when context threshold is reached
   * Waits for ROTATION_SNAPSHOT_COMPLETE signal before returning
   */
  async requestRotation(progressPath: string, planPath: string): Promise<SnapshotDetectionResult> {
    if (this.options.verbose && this.options.onOutput) {
      this.options.onOutput(`[DEBUG] requestRotation: starting rotation request\n`, null);
      this.options.onOutput(`[DEBUG] requestRotation: progressPath=${progressPath}\n`, null);
    }

    // Capture current state before injection
    let beforeContent = '';
    try {
      beforeContent = await captureTmuxPane(this.tmuxSessionName);
      if (this.options.verbose && this.options.onOutput) {
        this.options.onOutput(`[DEBUG] requestRotation: pane content before: ${beforeContent.length} bytes\n`, null);
        // Check for interruption state
        const hasInterruption = beforeContent.includes('What should Claude do') ||
                                beforeContent.includes('Interrupted');
        this.options.onOutput(`[DEBUG] requestRotation: hasInterruption=${hasInterruption}\n`, null);
      }
    } catch (e) {
      if (this.options.verbose && this.options.onOutput) {
        this.options.onOutput(`[DEBUG] requestRotation: failed to capture pane: ${e}\n`, null);
      }
    }

    // Use the full snapshot instructions from rotation.ts
    // Extract taskId from progressPath for generateSnapshotInstructions
    const taskIdMatch = progressPath.match(/\/tasks\/([^/]+)\//);
    const taskId = taskIdMatch ? taskIdMatch[1] : this.taskId;

    const { generateSnapshotInstructions } = await import('./rotation.js');
    const rotationPrompt = generateSnapshotInstructions(taskId);

    if (this.options.verbose && this.options.onOutput) {
      this.options.onOutput(`[DEBUG] requestRotation: calling injectPrompt with prompt length=${rotationPrompt.length}\n`, null);
    }

    await injectPrompt(this.tmuxSessionName, rotationPrompt, this.options.verbose, this.inputMode);

    if (this.options.verbose && this.options.onOutput) {
      this.options.onOutput(`[DEBUG] requestRotation: injectPrompt completed, waiting for ROTATION_SNAPSHOT_COMPLETE...\n`, null);
    }

    // Wait for ROTATION_SNAPSHOT_COMPLETE signal or progress.md modification
    const result = await waitForSnapshotComplete(this.tmuxSessionName, {
      timeout: 60000, // 1 minute timeout
      taskId,
      pollInterval: 500
    });

    if (this.options.verbose && this.options.onOutput) {
      this.options.onOutput(`[DEBUG] requestRotation: snapshot detection result: detected=${result.detected}, method=${result.method}, elapsed=${result.elapsed}ms\n`, null);
    }

    // Mark rotation as requested and end the session so TmuxRalphExecutor can start
    // the next iteration. This must happen regardless of whether snapshot was detected —
    // without ending the session here, start() never resolves and the loop stalls.
    this.rotationRequested = true;
    await this.complete();

    return result;
  }

  /**
   * Poll for output
   */
  private async pollOutput(): Promise<void> {
    if (this.status !== 'running' && this.status !== 'rotating') return;

    try {
      // First check if session exists
      const sessionExists = await tmuxSessionExists(this.tmuxSessionName);

      if (this.options.verbose && this.options.onOutput) {
        this.options.onOutput(`[DEBUG] Poll: session ${this.tmuxSessionName} exists: ${sessionExists}\n`, null);
      }

      // Capture pane content before checking session existence
      // This ensures we don't miss the final output when the session ends
      let paneContent = '';
      if (sessionExists) {
        paneContent = await captureTmuxPane(this.tmuxSessionName);

        if (this.options.verbose && this.options.onOutput) {
          this.options.onOutput(`[DEBUG] Pane content length: ${paneContent.length}\n`, null);
        }
      }

      // Check for new content
      if (paneContent.length > this.output.length) {
        const newContent = paneContent.slice(this.output.length);
        this.output = paneContent;

        // Debug: Log new content length
        if (this.options.verbose && this.options.onOutput) {
          this.options.onOutput(`[DEBUG] New content: ${newContent.length} bytes\n`, null);
        }

        // Parse the new content
        await this.parseOutput(newContent);

        if (this.options.onOutput) {
          this.options.onOutput(newContent, null);
        }
      }

      // Poll token usage from JSONL file (more reliable than terminal output)
      await this.pollTokenUsage();

      // Check if session ended (after checking for completion)
      if (!sessionExists) {
        if (this.options.verbose && this.options.onOutput) {
          this.options.onOutput(`[DEBUG] Session ended, completionDetected=${this._completionDetected}, rotationRequested=${this.rotationRequested}\n`, null);
        }

        // If completion was already detected during polling, just complete
        // Don't do raw string search on full output (it includes echoed prompt with completion promise)
        if (this._completionDetected) {
          if (this.options.onOutput) {
            this.options.onOutput('[Session completed - completion promise detected]\n', null);
          }
        } else if (this.rotationRequested) {
          if (this.options.onOutput) {
            this.options.onOutput('[Session ended - rotation requested]\n', null);
          }
        } else {
          // Session was externally killed (not by rotation or completion)
          if (this.options.onOutput) {
            this.options.onOutput('[Session ended - externally killed]\n', null);
          }
          // Mark as error to signal external termination
          this.status = 'error';
        }
        await this.complete();
        return;
      }

    } catch (error) {
      // Session might have ended
      const sessionExists = await tmuxSessionExists(this.tmuxSessionName);
      if (!sessionExists) {
        await this.complete();
      }
    }
  }

  /**
   * Get the precise JSONL file path for this session
   * Uses the session ID passed to Claude via --session-id
   */
  private getJsonlPath(): string {
    const cwd = this.options.cwd || process.cwd();
    // Project directory name: convert path like /home/user/my_project to -home-user-my-project
    // Claude Code replaces both '/' and '_' with '-'
    const projectName = '-' + cwd.slice(1).replace(/[\/_]/g, '-');
    return path.join(
      os.homedir(),
      '.claude',
      'projects',
      projectName,
      `${this.sessionId}.jsonl`
    );
  }

  /**
   * Poll token usage from JSONL file
   * Uses precise path binding via --session-id for reliable matching
   * Also checks for completion promise in JSONL file (more reliable than tmux pane)
   */
  private async pollTokenUsage(): Promise<void> {
    try {
      // Use precise JSONL path from --session-id binding
      const jsonlPath = this.getJsonlPath();

      if (!fs.existsSync(jsonlPath)) {
        // JSONL file not created yet, wait for next poll
        return;
      }

      // Parse the JSONL file for token usage and completion detection
      const { currentContextUsage, hasAssistantMessage, completionDetected } = await parseSessionFile(jsonlPath, this.completionPromise);

      // Check for completion promise in JSONL file (primary detection method)
      // This is more reliable than tmux pane parsing
      if (completionDetected && !this._completionDetected && !this.rotationRequested) {
        this._completionDetected = true;
        await this.complete();
        return;
      }

      // Update our token usage if we got valid data and callback is set
      if (this.options.onTokenUpdate) {
        if (currentContextUsage.inputTokens > 0 || currentContextUsage.outputTokens > 0) {
          this.tokenUsage = { ...currentContextUsage };
          // Call the callback
          await this.options.onTokenUpdate({ ...this.tokenUsage });
        }
      }
    } catch (error) {
      // Ignore errors in token polling
      if (this.options.verbose && this.options.onOutput) {
        this.options.onOutput(`[DEBUG] Token poll error: ${error}\n`, null);
      }
    }
  }

  /**
   * Parse output for tokens and signals
   */
  private async parseOutput(content: string): Promise<void> {
    // Try to parse JSONL lines
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const msg = JSON.parse(line);

        // Extract token usage from result message (most accurate - final totals)
        if (msg.type === 'result' && msg.modelUsage) {
          for (const model of Object.values(msg.modelUsage) as any[]) {
            this.tokenUsage.inputTokens = model.inputTokens || 0;
            this.tokenUsage.outputTokens = model.outputTokens || 0;
            this.tokenUsage.cacheReadInputTokens = model.cacheReadInputTokens || 0;
            this.tokenUsage.cacheCreationInputTokens = model.cacheCreationInputTokens || 0;
          }
        }
        // Extract from usage field (incremental updates)
        else if (msg.usage) {
          const rawUsage = msg.usage as any;
          this.tokenUsage.inputTokens += rawUsage.inputTokens || rawUsage.input_tokens || 0;
          this.tokenUsage.outputTokens += rawUsage.outputTokens || rawUsage.output_tokens || 0;
          this.tokenUsage.cacheReadInputTokens += rawUsage.cacheReadInputTokens || 0;
          this.tokenUsage.cacheCreationInputTokens += rawUsage.cacheCreationInputTokens || 0;
        }

        // Update callback
        if (this.options.onTokenUpdate && (msg.usage || msg.modelUsage)) {
          await this.options.onTokenUpdate({ ...this.tokenUsage });
        }

        // Extract cost
        if (msg.total_cost_usd !== undefined) {
          this.costUsd = msg.total_cost_usd;
        } else if (msg.cost_usd !== undefined) {
          this.costUsd = msg.cost_usd;
        } else if (msg.type === 'result' && msg.modelUsage) {
          // Extract cost from modelUsage
          for (const model of Object.values(msg.modelUsage) as any[]) {
            if (model.costUSD !== undefined) {
              this.costUsd = model.costUSD;
            }
          }
        }

      } catch {
        // Not JSON - rotation signal is handled in pollOutput
      }
    }
  }

  /**
   * Complete the session
   */
  private async complete(): Promise<void> {
    // Don't change status if already completed or error (externally killed)
    if (this.status === 'completed') return;
    // Keep 'error' status for external kill detection
    if (this.status !== 'error') {
      this.status = 'completed';
    }

    this.cleanup();

    // Kill tmux session to free resources
    try {
      await killTmuxSession(this.tmuxSessionName);
    } catch {
      // Session might already be gone
    }

    if (this.resolvePromise) {
      this.resolvePromise(this.getResult());
    }
  }

  /**
   * Force stop the session
   */
  async stop(): Promise<void> {
    this.status = 'error';
    this.cleanup();

    try {
      await killTmuxSession(this.tmuxSessionName);
    } catch {
      // Session might already be gone
    }
  }

  /**
   * Check if session was externally killed (not by rotation or completion)
   */
  wasExternallyKilled(): boolean {
    // Session was externally killed if:
    // - Status is not 'completed' (normal end)
    // - Status is not 'rotating' (context rotation)
    // - Completion was not detected
    // - Rotation was not requested
    return this.status === 'error' &&
           !this._completionDetected &&
           !this.rotationRequested;
  }

  /**
   * Cleanup polling
   */
  private cleanup(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Get session result
   */
  private getResult(error?: string): TmuxSessionResult {
    return {
      sessionId: this.sessionId,
      tmuxSessionName: this.tmuxSessionName,
      taskId: this.taskId,
      iteration: this.iteration,
      output: this.output,
      tokenUsage: { ...this.tokenUsage },
      costUsd: this.costUsd,
      duration: Date.now() - this.startTime,
      status: this.status,
      rotationRequested: this.rotationRequested,
      completionDetected: this._completionDetected,
      externallyKilled: this.wasExternallyKilled(),
      error,
      jsonlPath: this.getJsonlPath()
    };
  }

  /**
   * Get current status
   */
  getStatus(): TmuxSession {
    return {
      sessionId: this.sessionId,
      tmuxSessionName: this.tmuxSessionName,
      taskId: this.taskId,
      startedAt: new Date(this.startTime),
      status: this.status,
      output: this.output,
      tokenUsage: { ...this.tokenUsage },
      costUsd: this.costUsd,
      jsonlPath: this.getJsonlPath()
    };
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Build enhanced prompt with rotation instructions
   */
  private buildEnhancedPrompt(prompt: string): string {
    // The bootstrap prompt is already fully constructed by generateBootstrapPrompt
    // (includes context monitoring and completion instructions for both modes).
    return prompt;
  }
}

export interface TmuxSessionResult {
  sessionId: string;
  tmuxSessionName: string;
  taskId: string;
  iteration: number;
  output: string;
  tokenUsage: TokenUsage;
  costUsd: number;
  duration: number;
  status: TmuxSession['status'];
  rotationRequested: boolean;
  completionDetected: boolean;
  externallyKilled: boolean;
  error?: string;
  jsonlPath: string;
}

/**
 * Quick function to run a single tmux session
 */
export async function runTmuxSession(
  taskId: string,
  iteration: number,
  prompt: string,
  options: TmuxSpawnOptions & { completionPromise: string }
): Promise<TmuxSessionResult> {
  const session = new TmuxClaudeSession(
    taskId,
    iteration,
    options,
    options.completionPromise
  );
  return session.start(prompt);
}

/**
 * Run a fix session in tmux after verification failure
 *
 * Fix sessions use tmux to execute the fixes identified in revise_plan.md.
 * They run with completion promise "FIX_COMPLETE" to signal when done.
 *
 * @param taskId - Task ID
 * @param cycleNumber - Verification cycle number (used for session naming)
 * @param options - Optional spawn options
 * @returns Result of the fix session
 */
export async function runFixSession(
  taskId: string,
  cycleNumber: number,
  options: Partial<TmuxSpawnOptions> = {}
): Promise<TmuxSessionResult> {
  const { generateFixInstructions } = await import('./rotation.js');

  // Use iteration 1000 + cycle number for fix sessions to distinguish them
  // from main task sessions (iteration 1, 2, 3, ...)
  const fixIteration = 1000 + cycleNumber;

  // Generate fix instructions prompt
  const fixPrompt = generateFixInstructions(taskId);

  // Build the full options with required taskId
  const fullOptions: TmuxSpawnOptions & { completionPromise: string } = {
    taskId,
    dangerousSkipPermissions: true,
    timeout: options.timeout || 10 * 60 * 1000, // 10 minutes default
    verbose: options.verbose ?? false,
    cwd: options.cwd,
    env: options.env,
    outputFile: options.outputFile,
    onOutput: options.onOutput,
    onTokenUpdate: options.onTokenUpdate,
    onRotationSignal: options.onRotationSignal,
    ralphLoopMode: options.ralphLoopMode,
    completionPromise: 'FIX_COMPLETE',
  };

  // Run the fix session with FIX_COMPLETE as completion promise
  return runTmuxSession(taskId, fixIteration, fixPrompt, fullOptions);
}
