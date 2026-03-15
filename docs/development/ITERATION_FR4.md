# FR-4 迭代文档

**最后更新**: 2026-03-01
**状态**: 全部完成 ✅

---

## 已完成的工作

### 1. 修复 JSONL Token 解析

**问题**: 原代码使用驼峰命名 (`inputTokens`)，但 JSONL 文件使用蛇形命名 (`input_tokens`)

**修复**: `src/session/monitor.ts`
- 添加 `RawUsage` 接口支持两种命名格式
- 添加 `normalizeUsage()` 函数统一处理
- 检查两个位置的 usage: `msg.usage` 和 `msg.message.usage`

### 2. 修复上下文计算逻辑

**问题**: 原代码累积所有历史消息的 usage，导致显示 4M+ tokens

**修复**: 只取最后一条 assistant 消息的 usage
- 返回 `currentContextUsage` 而不是累积的 `totalUsage`
- 当前上下文 = `input_tokens + cache_read_input_tokens`

### 3. 修复 tmux 注入

**问题**: 原代码只按 Enter，但 Claude Code TUI 在 INSERT 模式

**修复**: `src/session/tmux-spawner.ts`
```typescript
// 1. 发送文本
await sendTmuxKeys(sessionName, escapedPrompt);
// 2. 退出 INSERT 模式 (关键!)
await sendTmuxKeys(sessionName, 'Escape');
// 3. 提交消息
await sendTmuxKeys(sessionName, 'Enter');
```

### 4. 新增 CLI 命令

**`cc-daemon context`** - 显示所有活跃会话的上下文使用量
```bash
cc-daemon context           # 一次性检查
cc-daemon context --watch    # 持续监控
cc-daemon context --json     # JSON 输出
```

**`cc-daemon status --watch`** - 实时监控任务状态

### 5. 新增模块

**`src/session/fr4-monitor.ts`** - FR4 专用监控模块
- `FR4Monitor` 类
- `findAllActiveSessions()` - 发现活跃会话
- `formatContextStatus()` - 格式化显示
- `runWatchMode()` - watch 模式

---

## 当前架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        FR-4 架构 (v2)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Layer 1: JSONL 监控                                           │
│   ───────────────────                                           │
│   文件: ~/.claude/projects/<hash>/<session>.jsonl               │
│   用途: 监控 token 使用量 (结构化数据)                            │
│   实现: src/session/monitor.ts                                  │
│         - parseSessionFile()                                    │
│         - watchSessionTokens()                                  │
│         - calculateContextStatus()                              │
│                                                                  │
│                           ↓                                     │
│                                                                  │
│   Layer 2: tmux 输出检测                                        │
│   ────────────────────────                                      │
│   方式: tmux capture-pane -t session -p -S -                    │
│   用途: 检测完成信号 (纯文本)                                    │
│   信号: ROTATION_SNAPSHOT_COMPLETE                              │
│   实现: src/session/tmux-spawner.ts                             │
│         - captureTmuxPane()                                     │
│         - pollOutput()                                          │
│         - checkForCompletion()                                  │
│                                                                  │
│   ─────────────────────────────────────────────────────────────│
│   新增功能 (2026-03-01)                                         │
│   ─────────────────────────────────────────────────────────────│
│                                                                  │
│   [1] 双重快照检测                                              │
│       - waitForSnapshotComplete()                               │
│       - tmux 输出信号 + progress.md 文件修改                     │
│                                                                  │
│   [2] 动态上下文限制                                            │
│       - MODEL_CONTEXT_LIMITS (types/index.ts)                   │
│       - getModelContextLimit()                                  │
│       - 支持 Claude 4/3.5/3, GLM 系列模型                       │
│                                                                  │
│   [3] 错误恢复机制                                              │
│       - runSessionWithRetry()                                   │
│       - 指数退避 + 随机抖动                                      │
│       - 智能可重试错误判断                                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 关键文件

| 文件 | 作用 |
|------|------|
| `src/session/monitor.ts` | JSONL 解析、token 监控 |
| `src/session/fr4-monitor.ts` | FR4 专用监控类 |
| `src/session/tmux-spawner.ts` | tmux session 管理、注入、**快照检测** |
| `src/session/tmux-ralph-executor.ts` | Ralph Loop 主控制器、**重试机制** |
| `src/session/rotation.ts` | 旋转指令生成 |
| `src/types/index.ts` | 类型定义、**模型上下文限制** |
| `src/cli/index.ts` | CLI 命令定义 |

---

## 测试状态

- **113 tests passing** (新增 14 tests)
- 新增 `src/session/fr4-monitor.test.ts` (20 tests)
- 新增 `src/types/index.test.ts` (9 tests) - 模型上下文限制测试
- 更新 `src/session/tmux-spawner.test.ts` (+5 tests) - 快照检测测试
- 更新 `src/session/monitor.test.ts` (8 tests)
- 更新 `tests/e2e/fr-comprehensive.test.ts`

---

## 待改进项 (已完成 ✅)

### 1. 快照完成检测增强 ✅

**实现**: `src/session/tmux-spawner.ts`
- 新增 `waitForSnapshotComplete()` 函数
- 双重检测机制：
  1. tmux 输出信号 (`ROTATION_SNAPSHOT_COMPLETE`)
  2. progress.md 文件修改时间
- 返回检测方式 (`tmux_signal` | `file_modification` | `timeout`)

```typescript
// 实际实现
export async function waitForSnapshotComplete(
  sessionName: string,
  options: SnapshotDetectionOptions = {}
): Promise<SnapshotDetectionResult> {
  // 同时检测两种信号
  while (Date.now() - startTime < timeout) {
    // 方式1: tmux 输出信号
    if (newContent.includes('ROTATION_SNAPSHOT_COMPLETE')) {
      return { detected: true, method: 'tmux_signal', elapsed };
    }

    // 方式2: 文件修改
    const currentModTime = fs.statSync(progressPath).mtimeMs;
    if (currentModTime > initialModTime) {
      return { detected: true, method: 'file_modification', elapsed };
    }

    await sleep(pollInterval);
  }
  return { detected: false, method: 'timeout', elapsed };
}
```

### 2. 上下文限制配置 ✅

**实现**: `src/types/index.ts`, `src/cli/index.ts`
- 新增 `MODEL_CONTEXT_LIMITS` 常量
- 新增 `getModelContextLimit()` 函数
- 支持多种模型：Claude 4/3.5/3 系列、GLM 系列
- CLI 命令使用动态限制而非硬编码 200k

```typescript
// 不同模型有不同的上下文限制
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-4': 200000,
  'claude-sonnet-4': 200000,
  'glm-5': 200000,
  // ... 更多模型
};

export function getModelContextLimit(modelId: string): number {
  // 支持精确匹配和前缀匹配
}
```

### 3. 错误恢复 ✅

**实现**: `src/session/tmux-ralph-executor.ts`
- 新增 `runSessionWithRetry()` 方法
- 指数退避 + 随机抖动
- 可配置最大重试次数和延迟
- 智能判断可重试错误类型

```typescript
// 重试配置
interface TmuxRalphConfig {
  maxRetries?: number;           // 默认 3
  retryBaseDelayMs?: number;     // 默认 2000ms
  retryMaxDelayMs?: number;      // 默认 30000ms
}

// 错误判断
private isRetryableError(error: Error): boolean {
  // 网络错误、tmux 会话问题、速率限制等可重试
  // 其他错误直接失败
}
```

---

## 使用方式

```bash
# 启动 Ralph Loop (自动旋转)
cc-daemon ralph "完成任务" -p "DONE" --tmux -t 80

# 启动 Ralph Loop (带重试配置)
cc-daemon ralph "完成任务" -p "DONE" --tmux \
  --max-retries 5 \
  --retry-base-delay 1000 \
  --retry-max-delay 60000

# 检查活跃会话上下文
cc-daemon context

# 持续监控
cc-daemon context --watch

# 查看任务状态
cc-daemon status --sessions
```

---

## 注意事项

1. **JSONL 路径**: `~/.claude/projects/<project-hash>/<session-id>.jsonl`
2. **token 计算**: 当前上下文 = `input_tokens + cache_read_input_tokens` (不是累积值!)
3. **tmux 注入**: 需要 `Escape` + `Enter` 才能提交
4. **完成信号**: `ROTATION_SNAPSHOT_COMPLETE` 用于快照，`<promise>DONE</promise>` 用于任务完成

---

## 新增改进 (2026-03-01)

### 关键文件变更

| 文件 | 变更 |
|------|------|
| `src/types/index.ts` | 新增 `MODEL_CONTEXT_LIMITS`, `getModelContextLimit()` |
| `src/session/tmux-spawner.ts` | 新增 `waitForSnapshotComplete()`, `checkProgressFileModified()` |
| `src/session/tmux-ralph-executor.ts` | 新增 `runSessionWithRetry()`, `isRetryableError()`, `calculateRetryDelay()` |
| `src/cli/index.ts` | 使用动态上下文限制 |

### 新增配置选项

```bash
# Ralph Loop 新增重试配置
cc-daemon ralph "任务" -p "DONE" --tmux \
  --max-retries 5 \
  --retry-base-delay 1000 \
  --retry-max-delay 60000
```

### API 变更

```typescript
// 新增导出
export { waitForSnapshotComplete, checkProgressFileModified } from './tmux-spawner.js';
export { MODEL_CONTEXT_LIMITS, getModelContextLimit } from './types/index.js';

// TmuxRalphConfig 新增字段
interface TmuxRalphConfig {
  // ... 原有字段
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}
```
