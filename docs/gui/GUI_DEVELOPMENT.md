# CC-Daemon GUI Development

本文档记录 GUI 开发功能。

---

## 1. GUI 内嵌终端 (xterm.js) ✅ 已完成

- **描述**: 在 GUI 内集成完整的终端模拟器
- **状态**: 已完成
- **功能**:
  - 在浏览器中直接查看和控制 tmux session ✅
  - 无需打开外部终端，更好的集成体验 ✅
  - 支持复制/粘贴、主题切换 ✅
  - 终端尺寸自适应 ✅

**实现文件**:
- `src/gui/static/index.html` - 添加 Terminal 标签页
- `src/gui/static/terminal.js` - xterm.js 集成和 WebSocket 连接
- `src/gui/static/styles.css` - 终端样式
- `src/gui/server.ts` - WebSocket 终端服务端点

**使用方法**:
1. 打开 GUI 后点击 "💻 Terminal" 标签
2. 从下拉菜单选择一个 tmux session
3. 点击 "Connect" 连接到终端
4. 在浏览器中直接与 tmux session 交互

---

## 2. 自动触发监控 (Auto-Trigger Monitor) ✅ 已完成

- **描述**: 使用 Claude Code headless 模式 (claude -p )自动判断运行中的 tmux session 是否需要触发继续工作
- **状态**: 已完成
- **功能**:
  - 定期轮询所有 running 状态的 tmux session ✅
  - 使用 `tmux capture-pane` 获取终端输出内容 ✅
  - 调用 Claude Code 分析当前状态 ✅
  - 根据分析结果自动执行操作 ✅

### 状态判断

Claude API 返回三种状态：

| 状态 | 说明 | 操作 |
|------|------|------|
| `running` | Claude 正在执行中 | 继续监控 |
| `stop` | Claude 停止等待用户输入 | 自动发送 trigger prompt |
| `completed` | 任务已完成 | 标记完成，停止监控 |

### 配置选项

- **轮询间隔**: 默认 1 分钟（可配置，10-600 秒）✅
- **重试机制**: API 调用失败时自动重试 ✅

### 工作流程

```
1. 获取所有 running 的 tmux sessions
2. 对每个 session 捕获终端输出
3. 分析状态（检测 prompt、等待输入等）
4. 如果状态是 "stop"，获取 trigger prompt
5. 使用 tmux send-keys 发送 trigger
6. 重复上述步骤
```

### Claude 输出格式

```json
{
  "status": "running" | "stop" | "completed",
  "trigger": "需要发送的 prompt（仅 stop 时）",
  "reason": "判断原因说明"
}
```

### 使用方法

1. 打开 GUI 设置面板 (⚙️ 按钮)
2. 找到 "Auto-Trigger Monitor" 部分
3. 勾选 "Enable Auto-Trigger Monitor"
4. 设置轮询间隔（默认 60 秒）
5. 点击 "Save Settings"

**实现文件**:
- `src/session/auto-trigger-monitor.ts` - 自动触发监控核心逻辑
- `src/gui/server.ts` - API 端点 `/api/auto-trigger`
- `src/gui/static/index.html` - 设置界面

---

## 3. 默认工作目录设置 ✅ 已完成

- **描述**: 设置创建任务的默认工作目录
- **状态**: 已完成
- **默认值**: `./test_work_dir`

**实现位置**: Settings 模板中的 "Default Working Directory" 选项

---

*文档创建时间: 2026-03-05*
*最后更新时间: 2026-03-05 - 所有功能已完成*
