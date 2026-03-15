# GUI 功能改进建议

## 1. Session 启动目录显示

**位置**: Context 标签页 > Session 卡片

**现状**: 显示 "JSONL Path"，内容类似 `/Users/xxx/.claude/projects/-Users-xxx-.cc-daemon-tasks-task-xxx/uuid.jsonl`，可读性差。

**改进**: 改为显示 Session 的工作目录（即用户运行命令的目录），如 `/Users/xxx/projects/my-app`。

---

## 2. Session 标题显示

**位置**: Context 标签页 > Session 卡片顶部

**现状**: 显示 Session UUID，如 `ec31eb79-0eb5-40ec-966a-e5e513a08817`，对用户没有意义。

**改进**: 改为显示有意义的标题：
- 优先显示 Session 的第一句用户 Prompt（截断处理）
- 或者显示关联的 Task Goal
- 格式示例：`创建一个登录页面...` 或 `Task: 实现用户认证`

---

## 3. Context 使用量详细显示

**位置**: Context 标签页 > Session 卡片 > 百分比显示

**现状**: 只显示百分比，如 `45.2%`

**改进**: 在百分比旁边显示具体数值，格式：`45.2% (90.4k/200k)`
- 显示已使用 token 数
- 显示总 token 限制
- 单位使用 K 或 M 简化显示

---

## 4. Tmux Session 与 Claude Session 关联显示

**位置**: Sessions 标签页 > Tmux Sessions 区域

**现状**:
- Tmux Sessions 和 Active Claude Sessions 分开显示
- Tmux session 只显示名称（如 `cc-daemon-task-9bd13892-1`）
- 无法直观看到 tmux session 对应哪个 Claude session

**改进**: 在 Tmux Session 卡片中增加关联信息：
- 显示对应的 Claude Session UUID（方便与 Active Sessions 匹配）
- 显示第一句用户 Prompt（与功能 2 一致）

**效果示例**:

```
tmux: cc-daemon-task-9bd13892-1
  Claude: ec31eb79-0eb5...
  Prompt: 创建一个登录页面...
  Context: 45.2%
```

---

## 5. Active Session 显示来源 Tmux 信息

**位置**: Sessions 标签页 > Active Claude Sessions 区域

**现状**:
- Active Session 只显示 sessionId、修改时间、tokens、context 百分比
- 无法知道这个 session 是独立运行的还是由某个 tmux session 创建的

**改进**: 如果 Active Session 是由某个 tmux session 创建的，显示来源信息：
- 显示对应的 tmux session 名称
- 提供快捷复制 attach 命令的按钮
- 如果不是来自 tmux，可以显示"独立运行"或留空

**效果示例**:
```
Session: ec31eb79-0eb5...
  Modified: 10:30:45 AM
  Tokens: 38.1K in / 12.5K out
  Context: 45.2%
  Source: tmux:cc-daemon-task-9bd13892-1 [📋 attach]
```

---

## 6. Active Session 精简显示

**位置**: Sessions 标签页 > Active Claude Sessions 区域

**现状**:
- 显示 sessionId、修改时间、tokens、context 百分比
- Tokens 信息（如 `Tokens: 408 in / 77 out`）与 Context 标签页内容重叠

**改进**: 移除 Tokens 显示，保持精简：
- 只显示 sessionId（或标题/prompt）
- 修改时间
- 来源 tmux 信息（功能 5）
- Context 百分比保留

**理由**: 详细的 token 使用情况已在 Context 标签页展示，Sessions 标签页应聚焦于 session 的身份和来源信息。

---

## 7. 任务状态同步逻辑优化

**位置**: Tasks 标签页 > Task 状态显示 / 后端状态查询

**现状**:
- `metadata.json` 和 `progress.md` 都有状态字段，但更新不同步
- Agent 完成任务时更新 `progress.md` 为 `completed`，但代码没更新 `metadata.json`
- 外部 kill 时代码更新 `metadata.json` 为 `failed`，但没更新 `progress.md`
- 当前 GUI 优先读 `progress.currentStatus`，导致某些场景显示错误

**改进方案**: 统一状态查询逻辑

```
查询状态时：
1. 同时读取 progress.currentStatus 和 metadata.status
2. 如果 progress.currentStatus === 'completed'：
   - 同步更新 metadata.status = 'completed'
   - 返回 'completed'
3. 否则：
   - 返回 metadata.status
```

**理由**:
- `completed` 状态优先使用 progress 的结果（Agent 完成时会更新 progress）
- 其他状态使用 metadata 的结果（代码更新的是 metadata）
- 兼容两种状态来源，同时保持数据一致性

**效果**:

| 场景 | progress | metadata | 显示结果 |
|------|----------|----------|----------|
| Agent 完成 | completed | pending | completed ✅ |
| 外部 kill | pending | failed | failed ✅ |
| 正常运行 | active | active | active ✅ |
| 代码取消 | pending | cancelled | cancelled ✅ |

---

## 8. Agent Prompt 状态更新规范

**位置**: Session prompt / progress.md 状态字段

**现状**:
- Prompt 只告诉 Agent 输出 `TASK_COMPLETE` 表示任务完成
- 没有明确告诉 Agent 更新 `progress.md` 的 Status 字段
- 实际 progress.md 中出现了非标准状态值 `in_progress`（不在 `TaskStatus` 类型定义中）

**实际状态值分布**:
```
5 - Status: completed
2 - Status: in_progress  ← 非标准值！
8 - Status: pending
```

**问题**:
- Agent 可能自己创造非标准状态值
- 导致状态识别和处理出错

**改进**: 在 prompt 中明确告诉 Agent：

```
When updating progress.md Status field, ONLY use these values:
- pending (task not started)
- active (task in progress)
- completed (task finished successfully)
- failed (task failed with error)

When task is fully complete:
1. Update progress.md Status to "completed"
2. Output: TASK_COMPLETE
```

---

<!-- 在此继续添加更多改进建议 -->
