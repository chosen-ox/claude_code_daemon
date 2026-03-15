// Session JSONL parsing for token monitoring

import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import type { TokenUsage } from '../types/index.js';

// JSONL 中的 usage 可能是驼峰或蛇形命名
interface RawUsage {
  // 驼峰命名 (SDK 模式)
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  // 蛇形命名 (JSONL 文件)
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface SessionMessage {
  type: 'message' | 'session' | 'user' | 'assistant' | 'result' | 'system' | 'progress' | 'file-history-snapshot';
  role?: 'user' | 'assistant';
  content?: string | Array<{ type: string; text?: string; thinking?: string }>;
  usage?: RawUsage;
  message?: {
    usage?: RawUsage;
    role?: 'user' | 'assistant';
    content?: string | Array<{ type: string; text?: string; thinking?: string }>;
    [key: string]: unknown;
  };
  timestamp?: string;
  sessionId?: string;
}

export interface SessionHeader {
  type: 'session';
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
}

// Extended message format that includes cwd and other fields from JSONL
export interface ExtendedSessionMessage extends SessionMessage {
  cwd?: string;
  uuid?: string;
  isMeta?: boolean;
}

/**
 * 从 RawUsage 提取标准化的 TokenUsage
 * 支持驼峰命名和蛇形命名两种格式
 */
function normalizeUsage(raw: RawUsage | undefined): TokenUsage {
  if (!raw) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    };
  }

  return {
    inputTokens: raw.inputTokens || raw.input_tokens || 0,
    outputTokens: raw.outputTokens || raw.output_tokens || 0,
    cacheReadInputTokens: raw.cacheReadInputTokens || raw.cache_read_input_tokens || 0,
    cacheCreationInputTokens: raw.cacheCreationInputTokens || raw.cache_creation_input_tokens || 0
  };
}

/**
 * Parse a session JSONL file and extract token usage
 * 注意：返回的是最后一条 assistant 消息的 usage（当前上下文），不是累积值
 */
export async function parseSessionFile(filePath: string, completionPromise?: string): Promise<{
  header: SessionHeader | null;
  messages: ExtendedSessionMessage[];
  currentContextUsage: TokenUsage;
  hasAssistantMessage: boolean;  // Whether Claude has started responding
  workingDir: string | null;  // Extracted from cwd field
  completionDetected: boolean;  // Whether completion promise was detected in assistant message
}> {
  const messages: ExtendedSessionMessage[] = [];
  let header: SessionHeader | null = null;
  let workingDir: string | null = null;
  // 当前上下文使用量（取最后一条 assistant 消息的 usage）
  let currentContextUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0
  };
  let hasAssistantMessage = false;
  let completionDetected = false;

  if (!fs.existsSync(filePath)) {
    return { header, messages, currentContextUsage, hasAssistantMessage, workingDir, completionDetected };
  }

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const msg = JSON.parse(line) as ExtendedSessionMessage;

      // Extract working directory from cwd field (present in most lines)
      if (msg.cwd && !workingDir) {
        workingDir = msg.cwd;
      }

      if (msg.type === 'session') {
        header = msg as SessionHeader;
      } else {
        messages.push(msg);

        // Check for completion promise in assistant messages
        if (msg.type === 'assistant') {
          if (msg.message?.usage) {
            hasAssistantMessage = true;
            const usage = normalizeUsage(msg.message.usage);
            // 只更新如果有实际的 token 数据
            if (usage.inputTokens > 0 || usage.cacheReadInputTokens > 0) {
              currentContextUsage = usage;
            }
          }

          // Check for completion promise in assistant message content
          if (completionPromise && !completionDetected) {
            const content = msg.message?.content;
            if (Array.isArray(content)) {
              for (const item of content) {
                if (item.type === 'text' && item.text) {
                  // Check for <promise>TASK_COMPLETE</promise> format or plain text
                  if (item.text.includes(`<promise>${completionPromise}</promise>`) ||
                      item.text.includes(completionPromise)) {
                    completionDetected = true;
                    break;
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return { header, messages, currentContextUsage, hasAssistantMessage, workingDir, completionDetected };
}

/**
 * Get the latest token usage from a session file
 * Returns the most recent usage data
 */
export async function getLatestTokenUsage(filePath: string): Promise<TokenUsage | null> {
  let lastUsage: TokenUsage | null = null;

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const msg = JSON.parse(line) as SessionMessage;
      // 检查多种 usage 位置
      const rawUsage = msg.usage || msg.message?.usage;
      if (rawUsage) {
        lastUsage = normalizeUsage(rawUsage);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return lastUsage;
}

/**
 * Watch a session file for changes and emit token updates
 */
export function watchSessionTokens(
  filePath: string,
  callback: (usage: TokenUsage, cumulative: TokenUsage) => void,
  options?: { pollIntervalMs?: number }
): { stop: () => void } {
  let cumulative: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0
  };

  let lastSize = 0;
  const pollInterval = options?.pollIntervalMs || 500;

  const poll = async () => {
    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.size > lastSize) {
        // Read only the new content
        const fd = await fs.promises.open(filePath, 'r');
        const buffer = Buffer.alloc(stats.size - lastSize);
        await fd.read(buffer, 0, buffer.length, lastSize);
        await fd.close();

        const newContent = buffer.toString('utf-8');
        const lines = newContent.split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const msg = JSON.parse(line) as SessionMessage;
            // 检查多种 usage 位置
            const rawUsage = msg.usage || msg.message?.usage;
            if (rawUsage) {
              const usage = normalizeUsage(rawUsage);
              cumulative.inputTokens += usage.inputTokens;
              cumulative.outputTokens += usage.outputTokens;
              cumulative.cacheReadInputTokens += usage.cacheReadInputTokens;
              cumulative.cacheCreationInputTokens += usage.cacheCreationInputTokens;
              callback(usage, { ...cumulative });
            }
          } catch {
            // Skip malformed lines
          }
        }

        lastSize = stats.size;
      }
    } catch {
      // File might not exist yet
    }
  };

  const intervalId = setInterval(poll, pollInterval);

  // Initial read
  poll();

  return {
    stop: () => {
      clearInterval(intervalId);
    }
  };
}

/**
 * Calculate context window status
 */
export function calculateContextStatus(
  cumulativeUsage: TokenUsage,
  config: {
    effectiveContextLimit: number;
    thresholdPercent: number;
    snapshotReserveTokens: number;
  }
): {
  usedTokens: number;
  totalTokens: number;
  percentUsed: number;
  shouldRotate: boolean;
  emergencyRotate: boolean;
} {
  // Approximate context usage from cumulative tokens
  // Note: This is an approximation as actual context depends on caching
  const effectiveUsed = cumulativeUsage.inputTokens + cumulativeUsage.outputTokens;

  const percentUsed = (effectiveUsed / config.effectiveContextLimit) * 100;
  const shouldRotate = percentUsed >= config.thresholdPercent;
  const emergencyRotate = effectiveUsed >= (config.effectiveContextLimit - config.snapshotReserveTokens);

  return {
    usedTokens: effectiveUsed,
    totalTokens: config.effectiveContextLimit,
    percentUsed,
    shouldRotate,
    emergencyRotate
  };
}
