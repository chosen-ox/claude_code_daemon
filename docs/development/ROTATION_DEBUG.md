# Rotation 自动开新 Session 功能调试记录

## 问题描述

cc-daemon 的自动 session rotation 功能无法正常工作。

## 已确认的现象

### 1. Rotation 触发正常
- Token 达到阈值时，rotation 正确触发
- 日志显示：`[Rotation Triggered] Context at 23.0% (34427 tokens), forcing rotation`
- `requestRotation` 被调用：`[DEBUG] requestRotation: injecting rotation prompt directly`

### 2. 注入后的问题
- 工具调用被中断（tmux 显示 `Interrupted · What should Claude do instead?`）
- **关键问题**：rotation prompt 没有显示在 tmux 输出中
- Claude 没有收到 rotation prompt，所以不会输出 `ROTATION_SNAPSHOT_COMPLETE`
- daemon 一直在等待 `ROTATION_SNAPSHOT_COMPLETE` 信号

### 3. tmux 输出样例
```
● Write(/home/grads/jiakunfan/.cc-daemon/tasks/task-xxx/progress.md)
  ⎿  Added 6 lines, removed 3 lines
  ⎿  Interrupted · What should Claude do instead?

❯
────────────────────────────────────────────────────────────────────────
  Agent is all you need!       Ctx: 17.2%       𖠰 main
  ⏵⏵ bypass permissions on (shift+tab to cycle)
```

## 根本原因分析

### 问题根因
当 `requestRotation` 被调用时，Claude Code 可能正在执行工具操作。此时 TUI 处于特殊状态（显示 `Interrupted · What should Claude do instead?`），而 `injectPrompt` 发送的文本没有被正确注入到输入框中。

关键问题：
1. **时机问题**：`injectPrompt` 在工具执行中被调用，TUI 不在正常输入模式
2. **Escape 键行为**：在中断对话框中，Escape 会关闭对话框而不是进入命令模式
3. **缺少日志**：没有足够的调试信息来确认 `injectPrompt` 是否成功

## 修复方案 (2026-03-01)

### 修改 `injectPrompt` 函数
修改 `src/session/tmux-spawner.ts` 中的 `injectPrompt` 函数：

1. **检测中断对话框**：在注入前检查 tmux pane 内容，判断是否有中断对话框
2. **处理中断状态**：如果检测到中断，先发送 Escape 关闭对话框
3. **增加等待时间**：增加各步骤之间的等待时间，确保 TUI 状态稳定
4. **添加详细日志**：添加 verbose 模式下的详细调试日志
5. **验证注入结果**：注入后检查 prompt 是否出现在输出中

### 修改 `requestRotation` 方法
修改 `TmuxClaudeSession` 类中的 `requestRotation` 方法：

1. **注入前状态记录**：记录注入前的 pane 内容
2. **中断状态检测**：检测并记录是否有中断对话框
3. **传递 verbose 标志**：将 verbose 标志传递给 `injectPrompt`

## 修复后的代码

### `injectPrompt` 新实现 (src/session/tmux-spawner.ts)
```typescript
export async function injectPrompt(sessionName: string, prompt: string, verbose?: boolean): Promise<void> {
  // Escape special characters for tmux
  const escapedPrompt = prompt
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');

  if (verbose) {
    console.log(`[injectPrompt] Starting injection for session: ${sessionName}`);
    console.log(`[injectPrompt] Original prompt length: ${prompt.length}`);
    console.log(`[injectPrompt] Escaped prompt length: ${escapedPrompt.length}`);
  }

  // Step 1: Capture current state to check for interruption dialog
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

  // Step 2: Check if there's an interruption dialog
  const hasInterruption = paneContent.includes('What should Claude do instead?') ||
                          paneContent.includes('Interrupted');

  if (hasInterruption) {
    if (verbose) {
      console.log(`[injectPrompt] Detected interruption dialog, dismissing first...`);
    }

    // Dismiss the interruption dialog with Escape
    // This closes the dialog and returns to normal mode
    await sendTmuxKeys(sessionName, 'Escape');
    await sleepMs(300);

    // Wait for the dialog to fully dismiss
    await sleepMs(500);
  }

  // Step 3: Clear any pending input and ensure we're in a clean state
  // Send Escape to exit any partial input mode
  await sendTmuxKeys(sessionName, 'Escape');
  await sleepMs(200);

  // Step 4: Send the prompt text
  // Use -l flag to send literal text without interpreting special keys
  await sendTmuxKeys(sessionName, escapedPrompt);
  await sleepMs(200);

  if (verbose) {
    console.log(`[injectPrompt] Sent prompt text, waiting before submit...`);
  }

  // Step 5: Exit INSERT mode (Claude Code TUI is in -- INSERT -- by default)
  await sendTmuxKeys(sessionName, 'Escape');
  await sleepMs(200);

  // Step 6: Submit the message
  await sendTmuxKeys(sessionName, 'Enter');

  if (verbose) {
    console.log(`[injectPrompt] Prompt injection complete`);
  }

  // Step 7: Wait a moment and verify the prompt was sent
  await sleepMs(500);
  try {
    const newContent = await captureTmuxPane(sessionName);
    if (verbose) {
      // Check if our prompt appears in the output (it should be echoed)
      const promptPreview = prompt.slice(0, 50).replace(/\n/g, ' ');
      const found = newContent.includes(promptPreview) ||
                    newContent.includes('ROTATION') ||
                    newContent.includes('URGENT');
      console.log(`[injectPrompt] Prompt visibility check: ${found ? 'FOUND' : 'NOT FOUND'}`);
    }
  } catch (e) {
    if (verbose) {
      console.log(`[injectPrompt] Could not verify prompt injection: ${e}`);
    }
  }
}
```

## 相关文件

- `src/session/tmux-spawner.ts` - tmux 会话管理和 prompt 注入
- `src/session/tmux-ralph-executor.ts` - Ralph Loop 执行器
- `src/cli/index.ts` - CLI 命令定义

## 测试命令

```bash
# 启动测试（带详细日志）
cc-daemon ralph "List numbers 1-30 with fun facts about each." -p "LIST_DONE" --tmux -t 15 -m 5 --verbose

# 查看 tmux 会话
tmux -L cc-daemon capture-pane -t cc-daemon-task-xxx-1 -p

# 列出 tmux 会话
tmux -L cc-daemon list-sessions
```

## 环境信息

- 日期：2026-03-01
- Claude Code 版本：v2.1.63
- 模型：glm-5
- Node.js：v22.14.0
