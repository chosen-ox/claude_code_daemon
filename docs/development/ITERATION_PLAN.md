# CC Session Daemon - 迭代计划

> 只包含**未完成**的功能，按优先级排序

---

## 已完成功能 ✅ (无需再实现)

- FR-3: Task 文件协议 (`plan.md` + `progress.md` + `metadata.json`)
- FR-4: JSONL 解析和 token 计算
- FR-1: Ralph Loop 控制器框架 + 执行器
- FR-2: Verification 报告生成框架 + 执行器
- CLI: `init`, `create-task`, `list`, `resume`, `status`, `cancel`, `ralph`, `verify`, `tmux-sessions`
- 迭代 1.1: Session Spawner (`src/session/spawner.ts` + tests)
- 迭代 1.2: Session 生命周期 (`src/session/lifecycle.ts` + tests)
- 迭代 2.1: Ralph 执行器 (`src/session/ralph-executor.ts`)
- 迭代 2.2: CLI `ralph` 命令 (完整实现)
- 迭代 3.1: Verification 执行器 (`src/session/verification-executor.ts`)
- 迭代 3.2: CLI `verify` 命令 (完整实现)
- 迭代 5.1: E2E 测试 (`tests/e2e/fr-comprehensive.test.ts` - 79 tests passing)
- **迭代 6: Tmux 模式** (`src/session/tmux-spawner.ts`, `src/session/tmux-ralph-executor.ts`)
  - `--tmux` 选项 - 真正的会话轮转
  - `--verify` 选项 - 自动验证循环
  - `--verbose` 选项 - 调试输出
  - `tmux-sessions` 命令 - 列出活跃会话
  - 79 个单元测试通过

---

## 迭代 4: 监控增强 (P1)

### 4.1 多源 Token 监控

**文件**: 扩展 `src/session/monitor.ts`

```
任务:
[ ] 从 Agent SDK streaming 回调获取 token (如果使用 SDK)
[ ] 添加健康检查 - 确认监控源可用
[ ] 统一接口: SDK > JSONL > 文件轮询
```

---

### 4.2 CLI `status` 增强

**文件**: 修改 `src/cli/index.ts`

```
任务:
[x] --json 输出 (已完成)
[x] --sessions 显示活跃会话 (已完成)
[x] --all 显示所有任务 (已完成)
[ ] --watch 模式 - 实时更新 (每秒刷新)
[ ] 显示预估剩余 token 和轮转倒计时
```

---

## 迭代 5: 测试与文档 (P2)

### 5.1 E2E 测试

```
任务:
[x] tests/e2e/fr-comprehensive.test.ts - 全 FR 验证 (已完成, 23 tests)
[ ] tests/e2e/ralph-loop.test.ts - 完整轮转流程 (可选)
[ ] tests/e2e/verification.test.ts - PASS/FAIL 场景 (可选)
[ ] tests/e2e/interrupt.test.ts - SIGINT 恢复 (可选)
```

---

### 5.2 文档

```
任务:
[x] README 命令示例
[x] tmux 模式说明
[x] 验证机制说明
[x] 故障排除 FAQ
[ ] 架构图 (ASCII)
```

---

## 文件清单

### 新增 (已完成)
| 文件 | 迭代 | 优先级 | 状态 |
|-----|------|-------|------|
| `src/session/spawner.ts` | 1.1 | P0 | ✅ |
| `src/session/spawner.test.ts` | 1.1 | P0 | ✅ |
| `src/session/lifecycle.ts` | 1.2 | P0 | ✅ |
| `src/session/lifecycle.test.ts` | 1.2 | P0 | ✅ |
| `src/session/ralph-executor.ts` | 2.1 | P0 | ✅ |
| `src/session/verification-executor.ts` | 3.1 | P1 | ✅ |
| `tests/e2e/fr-comprehensive.test.ts` | 5.1 | P2 | ✅ |
| `src/session/tmux-spawner.ts` | 6.0 | P0 | ✅ |
| `src/session/tmux-spawner.test.ts` | 6.0 | P0 | ✅ |
| `src/session/tmux-ralph-executor.ts` | 6.0 | P0 | ✅ |
| `tests/e2e/real-claude.test.ts` | 6.0 | P1 | ✅ |

### 修改 (已完成)
| 文件 | 变更 | 状态 |
|-----|------|------|
| `src/cli/index.ts` | 完善 ralph, verify, status | ✅ |
| `src/session/rotation.ts` | 连接 spawner | ✅ |
| `src/session/verification.ts` | 修复 gap 状态逻辑 | ✅ |
| `src/task/manager.ts` | 修复 session ID 序列化 | ✅ |
| `src/index.ts` | 添加新模块导出 | ✅ |
| `vitest.config.ts` | 添加 tests 目录支持 | ✅ |

---

## 完成标准

```bash
# 1. Ralph Loop 能完成跨 session 任务 ✅
cc-daemon ralph "实现一个计算器" -p "CALC_DONE"
# 输出: Task completed in X sessions, XXXXX tokens, $X.XX

# 2. Verification 能检测问题 ✅
cc-daemon verify task-xxx
# 输出: FAIL - Missing: ...

# 3. Status 能显示实时状态 ✅
cc-daemon status task-xxx
# 显示: Session, Tokens, Cost 等

# 4. Tmux 模式工作正常 ✅
cc-daemon ralph "创建 /tmp/test.txt" -p "DONE" --tmux
# 输出: Status: COMPLETED, File created

# 5. 验证模式工作正常 ✅
cc-daemon ralph "创建 /tmp/verified.txt" -p "VERIFIED" --tmux --verify
# 输出: Status: COMPLETED, Verified: YES

# 6. 所有测试通过 ✅
npm test
# 79 tests passing
```

---

## 测试结果

```
 ✓ src/session/monitor.test.ts (8 tests)
 ✓ src/session/lifecycle.test.ts (10 tests)
 ✓ src/task/manager.test.ts (13 tests)
 ✓ tests/e2e/fr-comprehensive.test.ts (23 tests)
 ✓ src/session/spawner.test.ts (2 tests)
 ✓ src/session/tmux-spawner.test.ts (19 tests)
 ✓ tests/e2e/real-claude.test.ts (4 tests)

 Test Files  7 passed (7)
      Tests  79 passed (79)
```

---

## 待完成 (P2 - 可选)

1. **--watch 模式**: 实时刷新状态显示
2. **文档**: README 示例和架构图
3. **更多 E2E 测试**: 中断恢复、实际 Claude 调用等
