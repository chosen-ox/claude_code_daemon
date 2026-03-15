// Core types for CC Session Daemon

export type TaskStatus = 'pending' | 'active' | 'completed' | 'failed' | 'cancelled';

export interface TaskMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: TaskStatus;
  completionPromise?: string;
  maxIterations?: number;
  thresholdPercent?: number;
  totalSessions: number;
  totalTokens: number;
  totalCost: number;
  projectPath: string;
  // Task dependencies - this task will only start after all dependencies are completed
  dependsOn?: string[];
  // Tags for categorization
  tags?: string[];
}

export interface Step {
  id: string;
  description: string;
  completed: boolean;
  completedAt?: string;
  notes?: string;
}

export interface TaskPlan {
  title: string;
  goal: string;
  steps: Step[];
  acceptanceCriteria: string[];
}

export interface SessionRecord {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  duration?: number;
  stepsCompleted: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
}

export interface TaskProgress {
  taskId: string;
  currentStatus: TaskStatus;
  currentStep?: string;
  currentSessionId?: string;
  completedSteps: Array<{
    stepId: string;
    completedAt: string;
    notes?: string;
  }>;
  keyDecisions: string[];
  artifacts: Array<{
    path: string;
    description: string;
  }>;
  sessionHistory: SessionRecord[];
  blockers: string[];
}

export interface DaemonConfig {
  tasksDir: string;
  sessionsDir: string;
  thresholdPercent: number;
  snapshotReserveTokens: number;
  effectiveContextLimitTokens: number;
  maxVerificationCycles: number;
  /** 自动触发监控配置 */
  autoTrigger?: AutoTriggerConfig;
}

/**
 * 自动触发监控配置
 */
export interface AutoTriggerConfig {
  /** 是否启用自动触发监控 */
  enabled: boolean;
  /** 轮询间隔（毫秒），默认 60000 (1分钟) */
  pollInterval?: number;
  /** Claude API 模型 */
  model?: string;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 重试延迟（毫秒） */
  retryDelay?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ContextStatus {
  usedTokens: number;
  totalTokens: number;
  percentUsed: number;
  shouldRotate: boolean;
  emergencyRotate: boolean;
}

// ============================================================================
// Model Context Limits (FR-4 Improvement 2)
// ============================================================================

/**
 * Model-specific context limits
 * Different Claude models have different context window sizes
 */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Claude 4 series
  'claude-opus-4': 200000,
  'claude-opus-4-6': 200000,
  'claude-sonnet-4': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-haiku-4': 200000,

  // Claude 3.5 series
  'claude-3-5-sonnet': 200000,
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-5-sonnet-20240620': 200000,
  'claude-3-5-haiku': 200000,
  'claude-3-5-haiku-20241022': 200000,

  // Claude 3 series
  'claude-3-opus': 200000,
  'claude-3-opus-20240229': 200000,
  'claude-3-sonnet': 200000,
  'claude-3-sonnet-20240229': 200000,
  'claude-3-haiku': 200000,
  'claude-3-haiku-20240307': 200000,

  // GLM series
  'glm-5': 200000,
  'glm-4': 128000,

  // Default fallback
  'default': 200000
};

/**
 * Get context limit for a model
 * Falls back to default if model not found
 */
export function getModelContextLimit(modelId: string): number {
  // Direct lookup
  if (MODEL_CONTEXT_LIMITS[modelId]) {
    return MODEL_CONTEXT_LIMITS[modelId];
  }

  // Partial match (e.g., "claude-opus-4-6-20250519" matches "claude-opus-4-6")
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (modelId.startsWith(key) || key.startsWith(modelId.split('-').slice(0, 3).join('-'))) {
      return limit;
    }
  }

  return MODEL_CONTEXT_LIMITS['default'];
}
