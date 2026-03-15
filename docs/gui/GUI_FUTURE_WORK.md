# CC-Daemon GUI Future Work

本文档包含 GUI 功能的长期规划，这些功能在当前版本中不会实现，但可以在未来版本中考虑。

---

## 1. 任务执行进度实时显示
- **描述**: 显示任务当前执行的步骤和进度
- **UI**: 任务卡片上添加实时进度指示器
  ```
  ▶ Running: step-2 (Implement solution)
  ████████░░░░ 40% (2/5 steps)
  ```
- **挑战**: 需要解析 Claude 输出或让 Claude 主动报告进度

## 2. 任务产出文件预览
- **描述**: 对于已完成的任务，显示产出的文件列表
- **实现**: 读取 progress.md 中的 artifacts 字段
- **UI**: 任务详情中添加 "Artifacts" 标签页

## 3. 任务列表分页/虚拟滚动
- **描述**: 处理大量任务时的性能优化
- **实现**: 每页显示 20 条，或使用虚拟滚动
- **UI**:
  ```
  Showing 1-20 of 156 tasks  [< Prev] [1] [2] [3] ... [8] [Next >]
  ```

## 4. 任务操作撤销
- **描述**: 添加操作撤销功能（5秒内可撤销删除）

## 5. 任务调度
- **描述**: 支持定时执行任务
- **UI**: 创建任务时设置执行时间
  ```
  Schedule: [Now ▼] or [Pick date/time]
  ```

## 6. 移动端适配
- **响应式布局优化**: 底部导航栏、任务卡片简化视图、滑动操作
- **PWA 支持**: 添加 manifest.json 和 service worker

## 7. 通知增强
- **描述**: 更丰富的浏览器通知
- **通知场景**: 任务完成、任务失败、Context 接近阈值

## 8. 键盘快捷键扩展
- **当前快捷键**: N, R, F, ?, Esc, D, E, S
- **建议添加**:
  - `1/2/3`: 切换到 Tasks/Sessions/Context 标签
  - `↑/↓`: 在任务列表中导航
  - `Enter`: 打开选中任务详情
  - `Delete`: 删除选中任务（需确认）

## 9. 任务对比功能
- **描述**: 选择两个任务对比 Token 使用、Cost 等
- **UI**: 在 Select Mode 中添加 "Compare" 按钮

## 10. 日志增强
- **描述**: Logs 标签页功能增强
- **改进点**:
  - 日志搜索
  - 日志级别过滤（info/warn/error）
  - 日志下载
  - 日志高亮（错误信息红色高亮）

## 11. 前端框架迁移
- **描述**: 从原生 JavaScript 迁移到现代前端框架
- **候选方案**:
  - **Vue 3 + Vite**: 轻量级，学习曲线平缓
  - **React + Next.js**: 生态丰富，组件化开发
  - **Svelte**: 编译时框架，性能优秀
- **触发条件**: 当功能复杂度超过原生 JS 可维护范围时

## 12. CLI 功能补全

以下功能已在 GUI 中实现，但 CLI 尚未支持：

- **`cc-daemon resume` 实际启动会话**: 当前 `resume` 命令只打印任务文件路径提示，不会真正启动新会话。理想行为是调用 `TmuxRalphExecutor` 从 `progress.md` 断点继续执行。
- **`--ralph-loop` 选项**: `TmuxRalphExecutor` 支持 `ralphLoopMode`（在引导提示中注入 ralph-loop skill），GUI 通过 `ralphLoop` 字段传入，但 CLI 未暴露此选项。

---

*文档创建时间: 2026-03-05*
