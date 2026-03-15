# GUI Bug Report

测试时间：2026-03-06
GUI 版本：本地构建，端口 9876

---

## Bug 1: Create Task 不支持指定 Working Directory

**位置**：Tasks 页 → "+ Create Task" 表单

**现象**：
Create Task 表单包含以下字段：Goal、Completion Promise、Max Iterations、Context Threshold、Custom Steps、Tags、Dependencies、Use Tmux Session、Enable Ralph Loop Mode。
**没有 Working Directory 字段**，任务创建后固定使用服务器进程的 `process.cwd()` 作为工作目录。

**影响**：
用户无法通过 GUI 指定任务运行目录，所有任务都会在 cc-daemon 启动时的目录下执行，容易污染项目根目录（参见 CLAUDE.md workspace 规范）。

**后端支持情况**：
`server.ts` 的 `/api/tasks` 接口已支持 `workingDir` 参数（`body.workingDir || process.cwd()`），只是前端表单没有暴露该字段。

**期望行为**：
表单中增加 Working Directory 输入框，默认值为 `./workspace/`。

---

## Bug 2: tmux Attach 后 Terminal.app 配色问题（绿色/难以阅读）

**位置**：Sessions 页 → Tmux Sessions → "Attach" 按钮

**现象**：
点击 Attach 后，服务端通过 `osascript` 调用 Terminal.app 执行：
```
tmux -L cc-daemon attach -t <session-name>
```
Terminal.app 打开后，随着 tmux 内容滚动，绿色持续覆盖整个屏幕区域（不是单行文字变绿，而是绿色背景/前景扩散填满屏幕），导致完全无法阅读内容。

**补充信息**：
直接在 Terminal.app 手动执行同样的 attach 命令，颜色正常无问题。问题只在通过 GUI Attach 按钮打开时复现，说明问题出在 `osascript` 打开 Terminal.app 的方式上（可能是 profile、环境变量或 TERM 设置不同）。

**根本原因推断**：
`osascript` 启动的 Terminal.app 窗口与用户默认终端环境不一致（如 `TERM` 变量、Terminal profile 差异），导致 tmux 内的 ANSI 转义序列解析异常，颜色随滚动不断蔓延覆盖屏幕。

**影响**：Attach 后屏幕被绿色覆盖，完全无法查看 Claude 运行状态。

**期望行为**：
排查 tmux session 内哪里产生了未 reset 的颜色序列（可能在 cc-daemon 向 tmux 注入的提示文本或 rotation signal 中），确保所有彩色输出后都有 `\033[0m` reset。

---

## Bug 3: Embedded Terminal 连接失败

**位置**：Terminal tab → 选择 session → 点击 Connect

**现象**：
选择 `cc-daemon-task-73c-1`，点击 Connect 后立即显示：
```
✗ Connection error
⚠ Connection closed
Attempting to reconnect (1/5)...
```
终端区域保持黑屏，无任何内容显示。多次重连均失败。

**控制台错误**：
```
WebSocket connection to 'ws://localhost:9876/...' failed: response code: 400
Terminal WebSocket error: Event
```

主 WebSocket（实时更新）也持续失败：
```
WebSocket connection failed: invalid frame header
WebSocket disconnected: 1006
WebSocket reconnecting in 3000ms (attempt 1/5)
```

**根本原因分析**：
- 终端 WebSocket 握手时服务端返回 HTTP 400，说明 `/terminal` WebSocket 升级被拒绝
- 主 WebSocket 的 `invalid frame header` 说明协议层存在问题（可能是 WebSocket 子协议协商失败，或服务端 ws 实现与客户端不兼容）
- 两个 WebSocket 同时失败，主 WS 靠轮询降级维持"Real-time updates connected"假象

**历史经验**：
据用户反映，即使连接成功过，终端内容也是乱码（ANSI 转义序列未正确渲染）。

**影响**：Terminal tab 功能完全不可用。

**期望行为**：
1. WebSocket 握手成功，终端显示 tmux session 的实时输出
2. 支持键盘输入，能与 tmux session 交互
3. ANSI 颜色/转义序列正确渲染（xterm.js 已引入但未正常工作）
