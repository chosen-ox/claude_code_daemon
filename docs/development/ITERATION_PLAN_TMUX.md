# CC-Daemon Tmux 模式迭代计划

> 基于 2026-03-01 的工作进度

---

## ✅ 已完成功能

### 核心功能
- [x] FR-3: Task 文件协议 (`plan.md` + `progress.md` + `metadata.json`)
- [x] FR-4: JSONL 解析和 token 计算
- [x] FR-1: Ralph Loop 控制器框架 + 执行器
- [x] FR-2: Verification 报告生成框架 + 执行器
- [x] CLI: 所有基础命令 (`init`, `create-task`, `list`, `resume`, `status`, `cancel`, `ralph`, `verify`)

### Tmux 模式 (新增)
- [x] `tmux-spawner.ts` - tmux 会话管理
- [x] `tmux-ralph-executor.ts` - 基于 tmux 的 Ralph Loop
- [x] 解决 TTY 问题 (`setsid`)
- [x] 解决嵌套会话问题 (`unset CLAUDECODE`)
- [x] 解决 bash 历史扩展问题 (`set +H`)
- [x] 正确传递 prompt (`-p` 标志)
- [x] 参数引号处理
- [x] 实际任务执行成功 (文件创建验证通过)

### CLI 选项
- [x] `--tmux` - 使用 tmux 模式
- [x] `--verify` - 启用自动验证
- [x] `--max-verify-cycles` - 最大验证周期
- [x] `tmux-sessions` 命令 - 列出活跃的 tmux 会话

---

## 🔄 进行中的任务

### Task #1: 完成检测误触发 ✅ 已修复
**问题**: completion promise 在 prompt 文本中被检测到
**修复**: 改为只检测独立行或特定格式的完成信号
**文件**: `src/session/tmux-spawner.ts`

### Task #2: Token 统计 ✅ 已修复
**问题**: token 显示为 0
**修复**: 添加 `modelUsage` 格式解析 (result 消息中的最终统计)
**文件**: `src/session/tmux-spawner.ts`

### Task #3: 轮转流程测试 ✅ 已完成
**状态**: 已完成
**已完成**:
- [x] 修复轮转信号重复触发问题 (设置 `rotationRequested` 标志)
- [x] 修复轮转信号在 prompt 文本中误触发 (跳过第一次 poll)
- [x] 添加异步 `onRotationSignal` 回调支持
- [x] 增加 tmux 滚动缓冲区 (100000 行)
- [x] 捕获完整滚动历史 (`-S - -E -`)
- [x] 会话结束时的完成检测修复

### Task #4: Ralph + Verify 集成 ✅ 已完成
**状态**: 已完成
**已验证**:
- [x] `--verify` 选项工作正常
- [x] PASS 后任务标记为 completed
- [x] 文件创建验证通过

### Task #5: 完成检测增强 ✅ 已完成
**问题**: completion promise 在 JSON 输出中未被检测
**修复**: 添加 JSON 内容解析，检测 `text` 字段和 `result` 字段
**文件**: `src/session/tmux-spawner.ts`

### Task #6: Verbose 模式 ✅ 已完成
**问题**: 调试输出太多
**修复**: 添加 `--verbose` 选项控制调试输出
**文件**: `src/session/tmux-spawner.ts`, `src/session/tmux-ralph-executor.ts`, `src/cli/index.ts`

### Task #7: Metadata 更新 ✅ 已完成
**问题**: totalSessions 和 totalTokens 未更新
**修复**: 在 Ralph Loop 完成时更新 metadata
**文件**: `src/session/tmux-ralph-executor.ts`

---

## 📋 待完成任务

### P0 - 关键功能

#### 1. 轮转流程完善 (长任务测试)
```
文件: src/session/tmux-ralph-executor.ts

任务:
[ ] 测试上下文阈值触发轮转 (需要长任务)
[ ] 验证 ROTATION_SIGNAL 检测
[ ] 测试 requestRotation() 方法
[ ] 验证 progress.md 更新
[ ] 测试会话切换后状态恢复
```

#### 2. 验证反馈循环 ✅ 已验证
```
文件: src/session/tmux-ralph-executor.ts, src/session/verification-executor.ts

已完成:
[x] 测试 --verify 选项
[x] 验证 PASS 后任务标记为 completed
[x] 验证文件创建检测
待测试:
[ ] 验证 FAIL 后生成 revise_plan.md
[ ] 测试 revise_plan.md 被下一轮 Ralph 读取
[ ] 测试最大验证周期限制
```

### P1 - 重要改进

#### 3. 移除调试输出 ✅ 已完成
```
文件: src/session/tmux-spawner.ts, src/session/tmux-ralph-executor.ts, src/cli/index.ts

已完成:
[x] 添加 --verbose 选项
[x] 条件化 [DEBUG] 输出
[x] CLI 传递 verbose 选项
```

#### 4. 错误处理增强 ✅ 已完成
```
任务:
[x] 添加 tmux 会话创建失败的详细错误信息
[x] 添加超时处理
[x] 添加信号处理 (SIGTERM, SIGKILL)
```

### P2 - 优化项

#### 5. 测试覆盖
```
文件: src/session/tmux-spawner.test.ts (新建)

任务:
[ ] 测试 execTmux 参数引号
[ ] 测试 completion 检测逻辑
[ ] 测试 rotation 信号检测
[ ] 测试 token 解析
```

#### 6. 文档更新 ✅ 已完成
```
文件: README.md

已完成:
[x] 添加 tmux 模式说明
[x] 添加 --verify 选项说明
[x] 添加轮转机制说明
[x] 添加故障排除指南
```

---

## 🔧 快速启动命令

```bash
cd /home/grads/jiakunfan/py_proj/claude_copilot/cc-daemon

# 构建
npm run build

# 测试标准模式
node dist/cli.js ralph "创建文件 /tmp/test.txt 内容为 Hello" -p "DONE"

# 测试 tmux 模式
node dist/cli.js ralph "创建文件 /tmp/tmux-test.txt 内容为 HelloTmux" -p "TMUX_DONE" --tmux

# 测试 tmux + 验证
node dist/cli.js ralph "创建文件 /tmp/verify-test.txt" -p "VERIFY_DONE" --tmux --verify

# 运行测试
npm test

# 查看 tmux 会话
node dist/cli.js tmux-sessions
```

---

## 📁 关键文件

| 文件 | 功能 |
|-----|------|
| `src/session/tmux-spawner.ts` | tmux 会话管理、命令发送、输出解析 |
| `src/session/tmux-ralph-executor.ts` | tmux 模式的 Ralph Loop 执行器 |
| `src/session/rotation.ts` | 轮转指令生成 |
| `src/session/verification-executor.ts` | 验证执行器 |
| `src/cli/index.ts` | CLI 命令定义 |

---

## 🐛 已知问题

1. **完成检测在 prompt 文本中误触发** - ✅ 已修复
2. **Token 统计显示 0** - ✅ 已修复 (但短任务可能仍然显示 0，因为输出捕获时序)
3. **轮转信号重复触发** - ✅ 已修复 (设置 `rotationRequested` 标志)
4. **轮转信号在 prompt 中误触发** - ✅ 已修复 (跳过第一次 poll)
5. **滚动缓冲区内容丢失** - ✅ 已修复 (增加 history-limit 到 100000)
6. **完成检测不支持 JSON 输出** - ✅ 已修复 (添加 JSON 解析)
7. **调试输出太多** - ✅ 已修复 (添加 --verbose 选项)
8. **会话在完成检测前结束** - ✅ 已修复 (添加最终检测逻辑)
9. **验证反馈循环未测试** - ✅ 已验证 (基本流程工作正常)
10. **Metadata totalSessions 未更新** - ✅ 已修复

---

## 📝 下次工作建议

1. **首先**: 运行测试确保修改没有破坏现有功能
   ```bash
   npm test
   ```

2. **然后**: 测试 tmux 模式的完整流程
   ```bash
   # 简单任务
   node dist/cli.js ralph "创建 /tmp/hello.txt" -p "HELLO_DONE" --tmux

   # 带验证
   node dist/cli.js ralph "创建 /tmp/verify.txt 内容为 test" -p "VERIFY_DONE" --tmux --verify
   ```

3. **最后**: 测试轮转流程（需要长任务）
   - 创建一个复杂任务，预期会消耗大量上下文
   - 观察 ROTATION_SIGNAL 是否被触发
   - 验证会话切换后状态恢复

---

## 完成标准

```bash
# 1. 所有测试通过
npm test  # 应该 60+ tests passing

# 2. tmux 模式工作正常
node dist/cli.js ralph "创建 /tmp/final.txt" -p "FINAL" --tmux
# 输出: Status: COMPLETED, File created

# 3. 验证模式工作正常
node dist/cli.js ralph "创建 /tmp/verified.txt 内容为 test" -p "VERIFIED" --tmux --verify
# 输出: Status: COMPLETED, Verified: YES

# 4. 轮转流程（长任务）
# 触发 ROTATION_SIGNAL 后自动切换会话
```

## 当前状态 (2026-03-01)

✅ **核心功能已完成**
- 79 个测试全部通过 (60 原有 + 19 新增 tmux-spawner 测试)
- tmux 模式工作正常
- 验证模式工作正常
- 完成检测可靠
- Metadata 正确更新
- FAIL 反馈循环已修复并测试

✅ **今日完成的修复**
1. 修复完成检测时序问题 - 添加 `checkForCompletion()` 方法
2. 修复 Metadata 更新 - 正确更新 totalSessions/totalTokens/totalCost
3. 修复验证失败后的重试循环 - 添加 `continue` 跳过 `break`
4. 添加 tmux-spawner 单元测试 - 19 个新测试
5. 更新 README 文档 - 添加 tmux 模式、验证、故障排除说明
6. 添加 SIGTERM 信号处理 - 支持优雅关闭

🔄 **待完善**
- 长任务轮转测试 (需要消耗 200k tokens 的任务)
- 单元测试可以继续扩展
