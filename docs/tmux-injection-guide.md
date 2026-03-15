# Tmux 注入指南

> 最后更新: 2026-03-04
> 状态: 已实现并通过集成测试

## 核心发现

Claude Code 有两种输入模式，注入方式不同：

| 模式 | 激活方式 | 状态栏标志 | 提交方式 |
|------|----------|-----------|----------|
| **normal** | 默认（无配置） | `❯` 提示符 | 直接 `Enter` |
| **vim** | 会话内输入 `/vim` 切换 | `-- INSERT --` / `-- NORMAL --` | `Escape` → `Enter` |

## 输入模式检测

### 启动时检测（`detectReadyMode`）

```typescript
// 返回 'vim' | 'normal' | null（null 表示尚未就绪）
function detectReadyMode(paneContent: string): InputMode | null {
  if (paneContent.includes('-- INSERT --') || paneContent.includes('-- NORMAL --')) {
    return 'vim';
  }
  if (paneContent.includes('❯') || /\n>\s*$/.test(paneContent)) {
    return 'normal';
  }
  return null;
}
```

### 运行时检测（`detectInputMode`）

```typescript
// 用于 pane 内容分析，返回 'vim' | 'normal'
function detectInputMode(paneContent: string): InputMode {
  if (paneContent.includes('-- INSERT --') || paneContent.includes('-- NORMAL --')) {
    return 'vim';
  }
  return 'normal';
}
```

**重要**：vim 模式下，Claude 处理请求时和 Ctrl+C 中断后，`-- INSERT --` 会从状态栏**消失**。
中途注入应使用**会话启动时存储的 mode**，而不是重新检测 pane。

## 注入逻辑

### Normal 模式

Claude Code 启动时已处于可输入状态（`❯` 提示符）。

```
C-u         ← 清除当前行（防止有残留输入）
[type text] ← 逐块输入文本（50字符/块）
Enter       ← 提交
```

### Vim 模式

Claude Code 启动时处于 INSERT 模式（`-- INSERT --` 可见）。

**初始注入**（`start()` 内，已在 INSERT 模式）：
```
[type text] ← 直接输入，无需按 i
Escape      ← 退出 INSERT → NORMAL
Enter       ← 从 NORMAL 模式提交
```

**中途注入**（Ctrl+C 后，INSERT 模式已丢失）：
```
i           ← 重新进入 INSERT 模式
C-u         ← 清除当前行
[type text] ← 输入文本
Escape      ← 退出 INSERT → NORMAL
Enter       ← 从 NORMAL 模式提交
```

## Ctrl+C 中断后的状态

**"Interrupted · What should Claude do instead?"** 是对话区域的显示文本，**不是阻塞型 modal**。
Ctrl+C 后 `❯` 输入光标已经就绪，无需发送 `Escape` 来"关闭"任何对话框。

```
# Ctrl+C 后的正确处理
normal 模式: C-u → 输入 → Enter         ← 无需任何 Escape
vim 模式:    i → C-u → 输入 → Escape → Enter
```

## `injectPrompt` API

```typescript
// src/session/tmux-spawner.ts
export async function injectPrompt(
  sessionName: string,
  prompt: string,
  verbose?: boolean,
  mode?: InputMode    // 不传则自动从 pane 内容检测
): Promise<void>
```

`TmuxClaudeSession` 内部会在启动时检测并存储 `inputMode`，后续所有注入（`injectPrompt()`、`requestRotation()`）均使用该存储值而非重新检测。

## 特殊字符转义

发送到 tmux 前需转义：

```typescript
chunk
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/\$/g, '\\$')
  .replace(/`/g, '\\`')
```

长文本分块发送（50字符/块），每块间隔 50ms，避免 tmux 丢字符。

## 相关文件

- `src/session/tmux-spawner.ts` — `injectPrompt`、`detectInputMode`、`detectReadyMode`、`TmuxClaudeSession`
- `src/session/tmux-ralph-executor.ts` — Ralph Loop 中调用 rotation 注入
