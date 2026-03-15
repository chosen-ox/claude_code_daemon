# CC-Daemon GUI 功能改进建议

## 当前功能概览

### 已实现功能
- **Tasks 标签页**: 任务列表、状态过滤、批量操作、任务创建
- **Sessions 标签页**: Tmux 会话列表、Active Claude 会话列表
- **Context 标签页**: 上下文使用监控、Token 统计
- **任务详情模态框**: Overview 和 Logs 两个标签页
- **全局功能**: 深色/浅色主题、导出（JSON/CSV）、键盘快捷键、自动刷新

---

## 发现的 Bug [需要修复]

### ~~BUG-1: 任务完成后 tmux session 未自动清理 [严重]~~ ✅ 已修复
- **现象**: 任务状态显示 `completed`，但对应的 tmux session 仍然存在
- **复现步骤**:
  1. 通过 GUI 创建 tmux 任务
  2. 等待任务完成（状态变为 completed）
  3. 查看 Sessions 标签页，tmux session 仍然显示为 Running
- **影响**:
  - 资源泄漏（tmux session 和 Claude 进程不会终止）
  - GUI 显示误导（Sessions 显示运行中，但任务已完成）
  - 用户可能误以为任务还在运行
- **预期行为**: 任务完成后应自动终止对应的 tmux session
- **优先级**: P0 - 立即修复
- **修复方案**: 在 `TmuxRalphExecutor.start()` 方法末尾添加 `cleanupRemainingSessions()` 方法，确保任务完成时清理所有关联的 tmux session

---

## 功能改进建议

### 1. 任务管理增强 [高优先级]

#### 1.1 任务搜索功能 ✅ 已实现
- **描述**: 添加搜索框，支持按任务 ID、Goal、Project 路径搜索
- **实现位置**: Task List 标题栏右侧
- **UI 设计**:
  ```
  [🔍 Search tasks...] [Status Filter ▼]
  ```

#### 1.2 任务排序功能 ✅ 已实现
- **描述**: 支持按创建时间、更新时间、状态、Cost、Token 使用量排序
- **实现位置**: 任务列表表头（如改为表格视图）或排序下拉菜单
- **UI 设计**:
  ```
  Sort by: [Created ▼] [↓ Newest first]
  ```

#### 1.3 任务分组/标签
- **描述**: 为任务添加标签或项目分组功能
- **实现方式**: 在创建任务时可添加标签，列表中按标签/项目分组显示
- **数据结构**:
  ```json
  {
    "tags": ["api", "frontend"],
    "project": "my-project"
  }
  ```

#### 1.4 任务收藏/置顶
- **描述**: 允许用户收藏重要任务，置顶显示
- **UI**: 任务卡片上添加星标按钮

### 2. 实时监控增强 [高优先级]

#### 2.1 WebSocket 实时更新
- **描述**: 用 WebSocket 替代轮询，实现真正的实时更新
- **优势**: 减少服务器负载，更快响应状态变化

#### 2.2 Session 输出实时流
- **描述**: 在 Logs 标签页实时显示 Claude 的输出
- **实现**: 通过 WebSocket 推送 tmux session 的输出

#### 2.3 Context 使用预警 ✅ 已实现
- **描述**: 当 context 接近阈值时显示警告
- **UI**: Context 标签页中添加警告横幅
  ```
  ⚠️ Context at 75% - Rotation will occur at 80%
  ```
- **实现**:
  - 在 Context 标签页顶部显示警告横幅
  - 可配置的预警阈值（默认 75%）和危险阈值（默认 90%）
  - 在任务卡片上显示 context 百分比并带颜色标识

### 3. 用户体验改进 [中优先级]

#### 3.1 任务卡片信息增强 ✅ 已实现
- **描述**: 显示更多有用信息
- **新增字段**:
  - ✅ 运行时长（Running tasks）
  - ✅ 当前步骤描述
  - ✅ 最后活动时间
  - ✅ 错误/阻塞原因预览

### 4. 新增功能 [中优先级]

#### 4.1 Ralph Loop 模式 ✅ 已实现
- **描述**: 创建任务时可选启用 Claude Code 的 Ralph Loop skill
- **实现**:
  - 在创建任务表单中添加 "Enable Ralph Loop" checkbox
  - 勾选后，在初始 prompt 前注入 `/ralph-loop:ralph-loop ` (注意末尾有空格)
  - Context rotation 时，新 session 的 prompt 也要添加此前缀
  - 示例: `/ralph-loop:ralph-loop 完成用户认证功能`
- **优势**:
  - 利用 Claude Code 内置的 Ralph Loop skill，更好的 session 连续性
  - 自动处理 context rotation 的状态传递
- **UI**:
  ```
  ☑ Enable Ralph Loop (recommended for long-running tasks)
  ```
- **代码改动点**:
  - `src/gui/static/index.html`: 添加 checkbox
  - `src/gui/server.ts`: 处理 `ralphLoop` 参数
  - `src/session/tmux-ralph-executor.ts`: 在 prompt 前添加 `/ralph-loop:ralph-loop`

#### 4.2 Tmux Session 交互终端 ✅ 已实现
- **描述**: 为每个 running 的 tmux session 提供交互入口
- **功能**:
  - 点击按钮打开真实终端并 attach 到 tmux session
  - 实时查看 Claude Code session 动态
  - 支持用户直接输入 prompt
- **实现方式**:
  - **方式 A (已实现)**: 打开真实 Terminal 窗口
    - macOS: 使用 `osascript` 或 `open -a Terminal` 执行命令
    - Linux: 使用 `gnome-terminal -e` 或 `xterm -e`
    - 实现示例 (macOS):
      ```bash
      # 使用 osascript 打开新 Terminal 窗口并执行命令
      osascript -e 'tell application "Terminal" to do script "tmux -L cc-daemon attach -t cc-daemon-task-xxx"'
      ```
    - 后端 API:
      ```
      POST /api/sessions/tmux/:name/attach
      Response: { success: true }
      ```
  - **方式 B (高级)**: 集成 xterm.js，在 GUI 内嵌终端
    - 需要后端 WebSocket 代理 tmux I/O
    - 更好的用户体验，但实现复杂
- **UI 位置**: Sessions 标签页的每个 session 卡片上
- **按钮设计**:
  ```
  cc-daemon-task-abc-1
  ─────────────────────────────────────
  Command: tmux -L cc-daemon attach -t cc-daemon-task-abc-1
  [📋 Copy] [🖥️ Open Terminal]         ← 点击打开真实终端窗口
  ```

#### 4.3 Session 内容实时查看 ✅ 已实现
- **描述**: 如果无法实现打开终端，至少要能实时查看 Claude session 输出
- **实现**:
  - 使用 `tmux capture-pane -t session -p` 获取当前屏幕内容
  - 定时轮询或通过 WebSocket 推送
  - 在 GUI 中显示只读的 session 输出
- **UI**:
  - 在 Sessions 标签页的 session 卡片中添加 "View Output" 按钮
  - 点击后弹出模态框显示实时输出
  - 自动滚动到最新内容
- **后端 API**:
  ```
  GET /api/sessions/tmux/:name/output
  Response: { content: "..." }
  ```
- **优先级**: P1 - 如果 4.2 无法实现，则必须实现此功能

#### 4.4 统计仪表板 ✅ 已实现
- **描述**: 添加 Overview/Dashboard 标签页，显示统计数据
- **内容**:
  - ✅ 总任务数（按状态分类）
  - ✅ 总 Token 使用量
  - ✅ 总 Cost
  - ⏳ 本周/本月任务趋势图
  - ⏳ 活跃任务分布
- **UI 设计**:
  ```
  ┌─────────────────────────────────────────────────┐
  │  📊 Dashboard                                    │
  ├─────────────────────────────────────────────────┤
  │  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐            │
  │  │  12 │  │  45 │  │   8 │  │   3 │            │
  │  │Active│ │Done │  │Fail │  │Cancel│           │
  │  └─────┘  └─────┘  └─────┘  └─────┘            │
  │                                                  │
  │  Total Tokens: 1.2M    Total Cost: $12.34       │
  │                                                  │
  │  [本周任务趋势图]                                │
  └─────────────────────────────────────────────────┘
  ```

#### 4.5 任务模板系统
- **描述**: 保存常用任务配置为模板
- **实现**: localStorage 或服务端存储
- **UI**: 创建任务时选择模板
  ```
  Create from template: [Select template ▼] or start fresh
  ```

#### 4.6 系统设置页面 ✅ 已实现
- **描述**: 允许用户配置默认值和偏好
- **设置项**:
  - ✅ 默认 Max Iterations
  - ✅ 默认 Context Threshold
  - ✅ 默认使用 Tmux
  - ✅ 刷新间隔
  - ✅ 通知开关
  - ✅ Context 预警阈值配置
  - ✅ 默认 Ralph Loop 模式
- **UI**: 添加设置按钮（齿轮图标）到 header
- **实现**:
  - 设置模态框，包含所有可配置选项
  - 使用 localStorage 持久化设置
  - 设置会自动应用到创建任务表单和刷新间隔

#### 4.7 任务依赖/工作流
- **描述**: 支持任务之间的依赖关系
- **实现**: 一个任务完成后自动启动下一个任务
- **数据结构**:
  ```json
  {
    "dependsOn": ["task-xxx"],
    "onComplete": "start-next"
  }
  ```

---

## Future Work

长期规划功能已移至 [GUI_FUTURE_WORK.md](./GUI_FUTURE_WORK.md)

---

## 优先级排序

### P0 - 立即修复
1. ~~BUG-1: 任务完成后 tmux session 未自动清理~~ ✅ 已修复

### P1 - 短期实现
1. ~~任务搜索功能~~ ✅ 已实现 - 在任务列表上方添加搜索框，支持按任务 ID、Goal、Project 路径搜索
2. ~~任务排序功能~~ ✅ 已实现 - 添加排序下拉菜单，支持按创建时间、更新时间、Cost、Token、状态排序
3. ~~WebSocket 实时更新~~ ✅ 已实现 - 客户端和服务端 WebSocket 连接，支持实时推送统计信息、任务更新
4. ~~统计仪表板~~ ✅ 已实现 - 添加 Dashboard 标签页，显示任务统计、Token 使用、Cost 等信息
5. ~~任务卡片信息增强~~ ✅ 已实现 - 显示运行时长、当前步骤、最后活动时间、错误/阻塞预览
6. ~~Ralph Loop 模式（创建任务时勾选）~~ ✅ 已实现 - 在创建任务表单中添加 "Enable Ralph Loop Mode" checkbox
7. ~~Tmux Session 交互终端（打开真实终端窗口）~~ ✅ 已实现 - 在 Sessions 标签页添加 "🖥️ Attach" 按钮
8. ~~Session 内容实时查看（如果 7 无法实现则必须实现）~~ ✅ 已实现 - 在 Sessions 标签页添加 "👁️ View Output" 按钮

### P2 - 中期实现
1. ~~任务模板系统~~ ✅ 已实现 - 保存常用任务配置为模板，可从模板加载
2. ~~系统设置页面~~ ✅ 已实现 - 添加设置模态框，可配置刷新间隔、Context 阈值、默认任务设置等
3. ~~Session 输出实时流~~ ✅ 已实现 - 通过 WebSocket 订阅/取消订阅机制，实时推送 tmux session 输出
4. ~~Context 使用预警~~ ✅ 已实现 - 在 Context 标签页显示警告横幅，可配置预警阈值
5. ~~任务分组/标签~~ ✅ 已实现 - 创建任务时可添加标签，支持按标签过滤
6. ~~任务收藏/置顶~~ ✅ 已实现 - 任务卡片上添加星标按钮，收藏的任务显示在顶部
7. ~~任务依赖/工作流~~ ✅ 已实现 - 创建任务时可选择依赖的任务，任务卡片上显示依赖状态

### P3 - 长期规划 (Future Work)
1. 任务执行进度实时显示
2. 任务产出文件预览
3. 任务列表分页/虚拟滚动
4. 任务操作撤销
5. 任务调度
6. 移动端适配
7. 通知增强
8. 键盘快捷键扩展
9. 任务对比功能
10. 日志增强

---

*文档创建时间: 2026-03-04*
*最后更新时间: 2026-03-05*
*基于 CC-Daemon GUI v1.3 当前实现*

## 实现总结 (2026-03-05)

### 已完成功能 (共 16 项)
1. **BUG-1 修复**: 任务完成后自动清理 tmux session
2. **任务搜索功能**: 支持按任务 ID、Goal、Project 路径搜索
3. **任务排序功能**: 支持按创建时间、更新时间、Cost、Token、状态排序
4. **统计仪表板**: 显示任务统计、Token 使用、Cost 等信息
5. **Ralph Loop 模式**: 创建任务时可勾选启用 Ralph Loop
6. **Tmux Session 交互终端**: 打开真实终端窗口 attach 到 session
7. **Session 内容实时查看**: 查看 tmux session 输出
8. **任务卡片信息增强**: 显示运行时长、当前步骤、最后活动时间、错误/阻塞预览
9. **Context 使用预警**: 在 Context 标签页显示警告横幅，可配置预警阈值
10. **系统设置页面**: 添加设置模态框，可配置刷新间隔、Context 阈值、默认任务设置等
11. **任务收藏/置顶**: 任务卡片上添加星标按钮，收藏的任务优先显示
12. **任务模板系统**: 保存常用任务配置为模板，创建任务时可从模板加载
13. **任务分组/标签**: 创建任务时可添加标签，支持按标签过滤任务
14. **WebSocket 实时更新**: 添加 WebSocket 服务器和客户端，支持实时推送统计信息、任务创建/更新/删除通知
15. **Session 输出实时流**: 通过 WebSocket 订阅机制，实时推送 tmux session 输出到 GUI
16. **任务依赖/工作流**: 创建任务时可选择依赖的任务，任务卡片上显示依赖状态（完成/失败/等待中）

### 待完成功能
- 无（所有 P0、P1、P2 功能已实现）

### 代码改动文件
- `src/session/tmux-ralph-executor.ts`: 添加 cleanupRemainingSessions 方法
- `src/gui/server.ts`: 添加 /api/stats, /api/sessions/tmux/:name/output, /api/sessions/tmux/:name/attach 端点，WebSocket 服务器
- `src/gui/static/index.html`: 添加搜索框、排序下拉、标签过滤、Dashboard 标签页、Ralph Loop checkbox、Session Output Modal、Settings Modal、Tags 输入
- `src/gui/static/app.js`: 实现搜索、排序、标签过滤、Dashboard 加载、Session 输出查看、设置管理、Context 预警、任务收藏、模板管理等功能
- `src/gui/static/styles.css`: 添加 Dashboard、Session Output Modal、Settings Modal、Context Warning、Task Card Enhancement、Tag 样式
- `package.json`: 添加 ws 和 @types/ws 依赖
