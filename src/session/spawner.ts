// Session Spawner - Spawn Claude Code sessions and capture output

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { TokenUsage } from '../types/index.js';
import { generateSessionId } from '../utils/id.js';
import { getSessionsDir, ensureDir, getSessionPath } from '../utils/paths.js';

export interface SpawnResult {
  sessionId: string;
  output: string;
  tokenUsage: TokenUsage;
  success: boolean;
  error?: string;
  exitCode: number;
  duration: number;
  cost_usd?: number;
}

export interface SpawnOptions {
  timeout?: number; // milliseconds
  cwd?: string;
  env?: Record<string, string>;
  outputFile?: string; // path to save JSONL output
  dangerousSkipPermissions?: boolean;
}

export interface ClaudeMessage {
  type: string;
  subtype?: string;
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  usage?: TokenUsage;
  // Also support snake_case format from Claude CLI
  result?: string;
  error?: string;
  session_id?: string;
  cost_usd?: number;
  total_cost_usd?: number;
  is_error?: boolean;
  timestamp?: string;
  modelUsage?: {
    [model: string]: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      costUSD: number;
    };
  };
}

/**
 * Spawn a Claude Code session with the given prompt
 */
export async function spawnWithCLI(
  prompt: string,
  options: SpawnOptions = {}
): Promise<SpawnResult> {
  const sessionId = generateSessionId();
  const startTime = Date.now();

  // Ensure sessions directory exists
  await ensureDir(getSessionsDir());

  // Determine output file
  const outputPath = options.outputFile || getSessionPath(sessionId);

  // Build command arguments
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose'
  ];

  if (options.dangerousSkipPermissions !== false) {
    args.push('--dangerously-skip-permissions');
  }

  // Add the prompt at the end
  args.push(prompt);

  return new Promise((resolve) => {
    let output = '';
    let errorOutput = '';
    const messages: ClaudeMessage[] = [];
    let cumulativeUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    };
    let lastCost = 0;

    // Spawn the claude process
    // Remove CLAUDECODE env var to allow nested sessions
    const env = {
      ...process.env,
      ...options.env
    };
    delete env.CLAUDECODE;

    const claudeProcess = spawn('claude', args, {
      cwd: options.cwd || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Set up timeout
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (options.timeout) {
      timeoutId = setTimeout(() => {
        claudeProcess.kill('SIGTERM');
        errorOutput += '\nTimeout reached';
      }, options.timeout);
    }

    // Collect stdout (JSONL)
    claudeProcess.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      output += chunk;

      // Parse JSONL lines
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as ClaudeMessage;
          messages.push(msg);

          // Extract token usage from result message (final usage)
          if (msg.type === 'result' && msg.modelUsage) {
            // Get usage from modelUsage (most accurate)
            for (const model of Object.values(msg.modelUsage)) {
              cumulativeUsage.inputTokens = model.inputTokens || 0;
              cumulativeUsage.outputTokens = model.outputTokens || 0;
              cumulativeUsage.cacheReadInputTokens = model.cacheReadInputTokens || 0;
              cumulativeUsage.cacheCreationInputTokens = model.cacheCreationInputTokens || 0;
            }
          }
          // Also check usage field (snake_case format from CLI)
          else if (msg.usage) {
            const rawUsage = msg.usage as any;
            cumulativeUsage.inputTokens += rawUsage.inputTokens || rawUsage.input_tokens || 0;
            cumulativeUsage.outputTokens += rawUsage.outputTokens || rawUsage.output_tokens || 0;
            cumulativeUsage.cacheReadInputTokens += rawUsage.cacheReadInputTokens || rawUsage.cache_read_input_tokens || 0;
            cumulativeUsage.cacheCreationInputTokens += rawUsage.cacheCreationInputTokens || rawUsage.cache_creation_input_tokens || 0;
          }
          // Check nested message.usage (from assistant messages)
          else if (msg.message?.usage) {
            // These are incremental, just track for now
          }

          // Extract cost
          if (msg.total_cost_usd !== undefined) {
            lastCost = msg.total_cost_usd;
          } else if (msg.cost_usd !== undefined) {
            lastCost = msg.cost_usd;
          }
        } catch {
          // Not valid JSON, might be partial output
        }
      }
    });

    // Collect stderr
    claudeProcess.stderr?.on('data', (data: Buffer) => {
      errorOutput += data.toString();
    });

    // Handle process completion
    claudeProcess.on('close', (code) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const duration = Date.now() - startTime;
      const success = code === 0 && !errorOutput.includes('Error');

      // Extract final output from messages
      let finalOutput = '';
      for (const msg of messages) {
        if (msg.type === 'result' && msg.result) {
          finalOutput = msg.result;
        } else if (msg.type === 'assistant' && msg.message?.content) {
          // Handle nested message format
          const content = msg.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && (block as any).text) {
                finalOutput += (block as any).text;
              }
            }
          }
        } else if (msg.type === 'message' && msg.role === 'assistant') {
          if (typeof msg.content === 'string') {
            finalOutput += msg.content;
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) {
                finalOutput += block.text;
              }
            }
          }
        }
      }

      // Save JSONL output to file
      if (output.length > 0) {
        fs.promises.writeFile(outputPath, output).catch(() => {});
      }

      resolve({
        sessionId,
        output: finalOutput || output,
        tokenUsage: cumulativeUsage,
        success,
        error: errorOutput || undefined,
        exitCode: code || 0,
        duration,
        cost_usd: lastCost
      });
    });

    // Handle process errors
    claudeProcess.on('error', (err) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      resolve({
        sessionId,
        output: '',
        tokenUsage: cumulativeUsage,
        success: false,
        error: err.message,
        exitCode: 1,
        duration: Date.now() - startTime
      });
    });
  });
}

/**
 * Spawn a Claude Code session and stream output in real-time
 */
export function spawnWithStreaming(
  prompt: string,
  onMessage: (msg: ClaudeMessage) => void,
  options: SpawnOptions = {}
): {
  promise: Promise<SpawnResult>;
  process: ChildProcess;
  sessionId: string;
} {
  const sessionId = generateSessionId();
  const startTime = Date.now();

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose'
  ];

  if (options.dangerousSkipPermissions !== false) {
    args.push('--dangerously-skip-permissions');
  }

  args.push(prompt);

  // Remove CLAUDECODE env var to allow nested sessions
  const env = {
    ...process.env,
    ...options.env
  };
  delete env.CLAUDECODE;

  const claudeProcess = spawn('claude', args, {
    cwd: options.cwd || process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  let errorOutput = '';
  let cumulativeUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0
  };

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  if (options.timeout) {
    timeoutId = setTimeout(() => {
      claudeProcess.kill('SIGTERM');
      errorOutput += '\nTimeout reached';
    }, options.timeout);
  }

  claudeProcess.stdout?.on('data', (data: Buffer) => {
    const chunk = data.toString();
    output += chunk;

    const lines = chunk.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as ClaudeMessage;

        // Extract token usage from result message (final usage)
        if (msg.type === 'result' && msg.modelUsage) {
          // Get usage from modelUsage (most accurate)
          for (const model of Object.values(msg.modelUsage)) {
            cumulativeUsage.inputTokens = model.inputTokens || 0;
            cumulativeUsage.outputTokens = model.outputTokens || 0;
            cumulativeUsage.cacheReadInputTokens = model.cacheReadInputTokens || 0;
            cumulativeUsage.cacheCreationInputTokens = model.cacheCreationInputTokens || 0;
          }
        }
        // Also check usage field (supports both camelCase and snake_case)
        else if (msg.usage) {
          const rawUsage = msg.usage as any;
          cumulativeUsage.inputTokens += rawUsage.inputTokens || rawUsage.input_tokens || 0;
          cumulativeUsage.outputTokens += rawUsage.outputTokens || rawUsage.output_tokens || 0;
          cumulativeUsage.cacheReadInputTokens += rawUsage.cacheReadInputTokens || rawUsage.cache_read_input_tokens || 0;
          cumulativeUsage.cacheCreationInputTokens += rawUsage.cacheCreationInputTokens || rawUsage.cache_creation_input_tokens || 0;
        }

        onMessage(msg);
      } catch {
        // Partial JSON, ignore
      }
    }
  });

  claudeProcess.stderr?.on('data', (data: Buffer) => {
    errorOutput += data.toString();
  });

  const promise = new Promise<SpawnResult>((resolve) => {
    claudeProcess.on('close', (code) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      resolve({
        sessionId,
        output,
        tokenUsage: cumulativeUsage,
        success: code === 0 && !errorOutput.includes('Error'),
        error: errorOutput || undefined,
        exitCode: code || 0,
        duration: Date.now() - startTime
      });
    });

    claudeProcess.on('error', (err) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      resolve({
        sessionId,
        output: '',
        tokenUsage: cumulativeUsage,
        success: false,
        error: err.message,
        exitCode: 1,
        duration: Date.now() - startTime
      });
    });
  });

  return {
    promise,
    process: claudeProcess,
    sessionId
  };
}

/**
 * Check if Claude CLI is available
 */
export async function isClaudeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['--version'], { stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}
