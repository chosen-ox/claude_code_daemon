// Auto-Trigger Monitor - Monitors tmux sessions and auto-triggers Claude when waiting

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Timeout for claude -p analysis (30 seconds)
const CLAUDE_ANALYSIS_TIMEOUT = 30000;

export interface SessionStatus {
  status: 'running' | 'stop' | 'completed';
  trigger?: string;
  reason: string;
}

export interface MonitorOptions {
  /** Polling interval in milliseconds (default: 60000 = 1 minute) */
  pollInterval?: number;
  /** Maximum retries on API failure */
  maxRetries?: number;
  /** Callback for status changes */
  onStatusChange?: (sessionName: string, status: SessionStatus) => void;
  /** Callback for auto-trigger */
  onTrigger?: (sessionName: string, trigger: string) => void;
}

export interface MonitorState {
  interval: ReturnType<typeof setInterval> | null;
  running: boolean;
  sessions: Map<string, SessionStatus>;
}

/**
 * Auto-Trigger Monitor class
 *
 * Monitors running tmux sessions and automatically sends trigger prompts
 * when Claude is waiting for user input.
 */
export class AutoTriggerMonitor {
  private options: Required<MonitorOptions>;
  private state: MonitorState;

  constructor(options: MonitorOptions = {}) {
    this.options = {
      pollInterval: options.pollInterval ?? 60000, // 1 minute default
      maxRetries: options.maxRetries ?? 3,
      onStatusChange: options.onStatusChange ?? (() => {}),
      onTrigger: options.onTrigger ?? (() => {})
    };
    this.state = {
      interval: null,
      running: false,
      sessions: new Map()
    };
  }

  /**
   * Start monitoring
   */
  start(): void {
    if (this.state.running) {
      console.log('[AutoTrigger] Already running');
      return;
    }

    this.state.running = true;
    console.log(`[AutoTrigger] Started with poll interval: ${this.options.pollInterval}ms`);

    // Initial poll
    this.poll().catch(error => {
      console.error('[AutoTrigger] Initial poll error:', error);
    });

    // Set up interval
    this.state.interval = setInterval(() => {
      this.poll().catch(error => {
        console.error('[AutoTrigger] Poll error:', error);
      });
    }, this.options.pollInterval);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (!this.state.running) {
      return;
    }

    this.state.running = false;
    if (this.state.interval) {
      clearInterval(this.state.interval);
      this.state.interval = null;
    }
    console.log('[AutoTrigger] Stopped');
  }

  /**
   * Check if monitoring is running
   */
  isRunning(): boolean {
    return this.state.running;
  }

  /**
   * Get current session states
   */
  getSessionStates(): Map<string, SessionStatus> {
    return new Map(this.state.sessions);
  }

  /**
   * Poll all running sessions
   */
  private async poll(): Promise<void> {
    if (!this.state.running) {
      return;
    }

    try {
      // List all cc-daemon tmux sessions
      const sessions = await this.listCcDaemonSessions();
      console.log('[AutoTrigger] Poll: found', sessions.length, 'sessions:', sessions);

      for (const sessionName of sessions) {
        await this.checkSession(sessionName);
      }
    } catch (error) {
      console.error('[AutoTrigger] Poll error:', error);
    }
  }

  /**
   * Check a single session
   */
  private async checkSession(sessionName: string): Promise<void> {
    try {
      // Capture the pane content
      const content = await this.capturePane(sessionName);
      console.log(`[AutoTrigger] checkSession ${sessionName}: captured ${content.length} chars`);

      // Analyze the content to determine status
      const status = await this.analyzeStatus(sessionName, content);
      console.log(`[AutoTrigger] checkSession ${sessionName}: status=${status.status}, trigger=${status.trigger || 'none'}, reason=${status.reason}`);

      // Check if status changed
      const previousStatus = this.state.sessions.get(sessionName);
      if (!previousStatus || JSON.stringify(previousStatus) !== JSON.stringify(status)) {
        this.state.sessions.set(sessionName, status);
        this.options.onStatusChange(sessionName, status);

        // Auto-trigger if status is 'stop' and trigger is provided
        if (status.status === 'stop' && status.trigger) {
          console.log(`[AutoTrigger] Auto-triggering session: ${sessionName} with trigger: ${status.trigger}`);
          await this.sendTrigger(sessionName, status.trigger);
          this.options.onTrigger(sessionName, status.trigger);
        }
      }
    } catch (error) {
      console.error(`[AutoTrigger] Error checking session ${sessionName}:`, error);
    }
  }

  /**
   * Analyze session content to determine status using claude -p
   */
  private async analyzeStatus(sessionName: string, content: string): Promise<SessionStatus> {
    // First, do a quick check for obvious completion signals (no need to call Claude)
    if (content.includes('TASK_COMPLETE') || content.includes('completed successfully')) {
      return {
        status: 'completed',
        reason: 'Task completion signal detected'
      };
    }

    // Use claude -p to analyze the terminal content
    try {
      console.log(`[AutoTrigger] analyzeStatus: calling claude -p for ${sessionName}`);
      const claudeResult = await this.analyzeWithClaude(content);

      if (claudeResult) {
        console.log(`[AutoTrigger] Claude analysis for ${sessionName}: ${claudeResult.status} - ${claudeResult.reason}`);
        return claudeResult;
      }
    } catch (error) {
      console.error(`[AutoTrigger] Claude analysis failed for ${sessionName}:`, error);
      // Fall through to rule-based fallback
    }

    // Fallback to rule-based analysis if Claude fails
    console.log(`[AutoTrigger] analyzeStatus: falling back to rules for ${sessionName}`);
    const ruleResult = this.analyzeWithRules(content);
    console.log(`[AutoTrigger] Rule analysis for ${sessionName}: ${ruleResult.status} - ${ruleResult.reason}`);
    return ruleResult;
  }

  /**
   * Analyze terminal content using claude -p
   */
  private async analyzeWithClaude(content: string): Promise<SessionStatus | null> {
    // Get the last 2000 characters for analysis (to avoid token limits)
    const recentContent = content.slice(-2000);

    const prompt = `Analyze the following terminal output from a Claude Code session and determine its state.

Terminal output:
\`\`\`
${recentContent}
\`\`\`

Determine the current state and respond with ONLY a JSON object (no markdown, no explanation):
{
  "status": "running" | "stop" | "completed",
  "trigger": "the prompt to send if status is stop, otherwise omit",
  "reason": "brief explanation of the determination"
}

Status definitions:
- "running": Claude is actively working (showing Thinking, processing, tool use, Scampering, etc.) OR was interrupted by the user (shows "Interrupted", "What should Claude do instead?")
- "stop": Claude is waiting for user input after completing work (showing ❯ prompt at the end). This is a natural pause where Claude expects guidance.
- "completed": Task is finished (shows completion message like TASK_COMPLETE, "Task finished", etc.)

IMPORTANT distinctions:
- "Interrupted" or "What should Claude do instead?" → status: "running" (user intentionally interrupted, do NOT auto-trigger)
- "❯" prompt after work completion → status: "stop" (Claude is asking for next step, OK to auto-trigger)
- "Thinking", "●", "✓", "Scampering" → status: "running"

If status is "stop", provide a trigger prompt that would help Claude continue (e.g., "continue", "yes", "proceed", etc.).
If status is "running", do NOT include a "trigger" field.

Respond with ONLY the JSON object, nothing else.`;

    try {
      // Execute claude -p with timeout
      const { stdout } = await execAsync(
        `claude -p "${prompt.replace(/"/g, '\\"').replace(/\n/g, ' ')}" 2>/dev/null`,
        {
          timeout: CLAUDE_ANALYSIS_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024 // 10MB buffer
        }
      );

      // Parse the JSON response
      const jsonMatch = stdout.match(/\{[\s\S]*"status"[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]) as SessionStatus;

        // Validate the response
        if (['running', 'stop', 'completed'].includes(result.status)) {
          return result;
        }
      }

      console.log('[AutoTrigger] Failed to parse Claude response:', stdout.slice(0, 200));
      return null;
    } catch (error) {
      // Handle timeout or execution errors
      if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        console.error('[AutoTrigger] Claude analysis timed out');
      }
      return null;
    }
  }

  /**
   * Fallback rule-based analysis (used when Claude is unavailable)
   */
  private analyzeWithRules(content: string): SessionStatus {
    // Check for completion signals
    if (content.includes('TASK_COMPLETE') || content.includes('completed successfully')) {
      return {
        status: 'completed',
        reason: 'Task completion signal detected'
      };
    }

    // Check if Claude was interrupted by user - this is running state, NOT stop
    // User intentionally interrupted, so we should NOT auto-trigger
    if (content.includes('Interrupted') || content.includes('What should Claude do instead?')) {
      return {
        status: 'running',
        reason: 'User interrupted the session, waiting for manual input'
      };
    }

    // Check if Claude is waiting for input (natural pause after work completion)
    // Only the "❯" prompt indicates Claude is asking for next step
    const isWaitingForInput = /\n❯\s*$/.test(content);

    if (isWaitingForInput) {
      // Get the trigger prompt based on context
      const trigger = this.generateTriggerPrompt(content);
      return {
        status: 'stop',
        trigger,
        reason: 'Claude is waiting for user input after completing work'
      };
    }

    // Check if Claude is actively processing
    const isProcessing =
      content.includes('Thinking') ||
      content.includes('● ') ||
      content.includes('✓ ') ||
      content.includes('Scampering') ||
      content.includes('Transfiguring') ||
      content.includes('Bootstrapping') ||
      content.includes('Conjuring');

    if (isProcessing) {
      return {
        status: 'running',
        reason: 'Claude is actively processing'
      };
    }

    // Default to running if we can't determine status
    return {
      status: 'running',
      reason: 'Unable to determine status, assuming running'
    };
  }

  /**
   * Generate trigger prompt based on session content
   */
  private generateTriggerPrompt(content: string): string {
    // Check if there's a rotation signal
    if (content.includes('ROTATION') || content.includes('context')) {
      return 'Please continue with the next step of the task.';
    }

    // Default trigger
    return 'continue';
  }

  /**
   * Send trigger to tmux session
   */
  private async sendTrigger(sessionName: string, trigger: string): Promise<void> {
    const cmd = `tmux -L cc-daemon send-keys -t ${sessionName} "${trigger}" Enter`;
    await execAsync(cmd);
  }

  /**
   * List all cc-daemon tmux sessions
   */
  private async listCcDaemonSessions(): Promise<string[]> {
    const { stdout } = await execAsync('tmux -L cc-daemon list-sessions -F "#{session_name}" 2>/dev/null || true');
    if (!stdout.trim()) {
      return [];
    }
    return stdout
      .split('\n')
      .filter(name => name.startsWith('cc-daemon-'));
  }

  /**
   * Capture tmux pane content
   */
  private async capturePane(sessionName: string): Promise<string> {
    const { stdout } = await execAsync(
      `tmux -L cc-daemon capture-pane -t ${sessionName} -p -S - -E - 2>/dev/null || true`
    );
    return stdout;
  }
}

// Singleton instance for global monitoring
let globalMonitor: AutoTriggerMonitor | null = null;

/**
 * Start global auto-trigger monitoring
 */
export function startAutoTriggerMonitoring(options: MonitorOptions = {}): AutoTriggerMonitor {
  if (!globalMonitor) {
    globalMonitor = new AutoTriggerMonitor(options);
    globalMonitor.start();
  } else if (!globalMonitor.isRunning()) {
    globalMonitor.start();
  }
  return globalMonitor;
}

/**
 * Stop global auto-trigger monitoring
 */
export function stopAutoTriggerMonitoring(): void {
  if (globalMonitor) {
    globalMonitor.stop();
  }
}

/**
 * Get global monitor instance
 */
export function getAutoTriggerMonitor(): AutoTriggerMonitor | null {
  return globalMonitor;
}
