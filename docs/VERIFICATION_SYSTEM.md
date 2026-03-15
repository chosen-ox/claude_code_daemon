# Verification System 设计文档

## 概述

Verification System 用于在任务完成后自动验证实现是否符合计划，如果不符合则生成修订计划并尝试修复。

## 当前实现状态

### 已实现的功能

#### 1. GUI 前端 (`src/gui/static/`)

**任务卡片 Verify 按钮**
- 位置：每个任务卡片上有黄色 "Verify" 按钮
- 行为：点击后显示确认对话框
- 确认对话框内容："Start verification for task xxx? This will run a clean session to verify completion."

**创建任务选项**
- 位置：创建任务表单中的复选框
- 字段：`enableVerification`
- 提示："Run a clean verification session after task completion to confirm it meets acceptance criteria"

#### 2. API 层 (`src/gui/server.ts:630-655`)

```typescript
POST /api/tasks/:taskId/verify
// 异步启动 verification 执行器
// 返回 { success: true, message: "Verification started", taskId }
```

#### 3. Verification 执行器 (`src/session/verification-executor.ts`)

**VerificationExecutor 类**
- `verify(taskId)`: 主入口，运行验证循环
- `generateVerificationPrompt(taskId)`: 生成验证提示词
- `parseVerificationOutput(taskId, output)`: 解析验证结果

**当前流程**
```
1. 启动干净 Claude session（使用 spawnWithCLI）
2. 生成只读验证提示词
3. 解析输出中的 VERIFICATION_RESULT: PASS/FAIL
4. 如果 FAIL，生成 revise_plan.md
5. 循环最多 3 次
```

#### 4. Verification 控制器 (`src/session/verification.ts`)

**VerificationReport 类**
- 生成结构化验证报告
- 支持 Markdown 格式输出

**VerificationController 类**
- 管理验证循环（最多 3 次）
- `processResult()`: 处理结果决定下一步

**generateRevisePlan() 函数**
- 从验证失败生成修订计划
- 输出格式：revise_plan.md

#### 5. 提示词生成 (`src/session/rotation.ts`)

**generateVerificationInstructions(taskId)**
```
═══════════════════════════════════════════════════════════
TASK VERIFICATION - CLEAN SESSION
═══════════════════════════════════════════════════════════

You are a VERIFIER in a completely clean session with NO prior context.

1. Read ONLY the plan file: ${getPlanPath(taskId)}
2. DO NOT read progress.md or any session history.
3. Examine the codebase to verify acceptance criteria
4. Use READ-ONLY tools only (no Write/Edit).
5. Produce a structured verification report
```

---

## 发现的问题

### 🐛 关键 Bug: revise_plan.md 从未被使用

**问题描述**

当前 verification 循环中，每次迭代都只运行 **verification session**（只读检查），没有运行 **fix session** 来执行修复。

**代码分析**

```typescript
// verification-executor.ts
while (cycles < this.options.maxCycles!) {
  cycles++;

  // 问题：每次都只生成 verification prompt
  const verificationPrompt = this.generateVerificationPrompt(taskId);

  // 运行 verification session（只读检查）
  const spawnResult = await spawnWithCLI(verificationPrompt, {...});

  if (result.status === 'PASS') {
    return { passed: true, ... };
  }

  // 生成 revise_plan.md
  await fs.promises.writeFile(revisePlanPath, revisePlan);

  // 问题：说 "Retrying with revised plan..."
  // 但下一轮循环仍然是 verification，不是修复！
  this.emit('\nRetrying with revised plan...');
}
```

**实际行为 vs 预期行为**

| 当前实现 | 预期行为 |
|---------|---------|
| Verification 失败 → 生成 revise_plan.md | Verification 失败 → 生成 revise_plan.md |
| 再次运行 **verification**（只读检查） | 启动 **fix session**（读写操作） |
| 结果：同样的失败重复 3 次 | 修复后再次 verification |

---

## 建议的改进方案

### 目标架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Task Execution (tmux)                     │
│                     completionPromise 检测                   │
└─────────────────────────┬───────────────────────────────────┘
                          ↓ 检测到完成
┌─────────────────────────────────────────────────────────────┐
│                 Verification Session (tmux)                  │
│                      只读检查 plan.md                        │
└───────────┬─────────────────────────────────┬───────────────┘
            ↓ PASS                            ↓ FAIL
     [Task Completed]              [生成 revise_plan.md]
                                          ↓
┌─────────────────────────────────────────────────────────────┐
│                     Fix Session (tmux)                       │
│              读取 revise_plan.md，执行修复                    │
│                   更新 progress.md                           │
└─────────────────────────────────┬───────────────────────────┘
                                  ↓
                          [再次 Verification]
                                  ↓
                        (循环最多 3 次)
```

### 设计要点

| 方面 | 建议 |
|-----|-----|
| **Session 类型** | 全部使用 tmux，便于监控和调试 |
| **Verification** | 只读 session，只检查不修改 |
| **Fix Session** | 读写 session，根据 revise_plan.md 修复 |
| **循环限制** | 最多 3 次 verification + fix 循环 |
| **触发时机** | 检测到 `completionPromise` 后自动触发 |
| **状态追踪** | progress.md 记录 verification 历史 |

### 与 Ralph Loop 的关系

```
Ralph Loop: 处理 context rotation（context 接近上限时轮换）
    └── 在 Task Execution session 内部运行

Verification Loop: 处理质量验证（任务完成后验证）
    └── 在 Task Execution 完成后，作为独立的 session 序列运行
```

两者独立运行，不嵌套。

### 建议的实现结构

**新文件: `src/session/verification-loop.ts`**

```typescript
export interface VerificationLoopOptions {
  maxCycles?: number;        // 默认 3
  verificationTimeout?: number;  // 默认 10 分钟
  fixTimeout?: number;       // 默认 10 分钟
  onProgress?: (message: string) => void;
}

export interface VerificationLoopResult {
  taskId: string;
  passed: boolean;
  cycles: number;
  verificationResults: VerificationResult[];
  finalStatus: 'completed' | 'failed';
}

export class VerificationLoop {
  constructor(private options: VerificationLoopOptions = {}) {}

  async run(taskId: string): Promise<VerificationLoopResult> {
    let cycles = 0;
    const maxCycles = this.options.maxCycles ?? 3;
    const verificationResults: VerificationResult[] = [];

    while (cycles < maxCycles) {
      cycles++;
      this.emit(`\n=== Verification Cycle ${cycles}/${maxCycles} ===`);

      // 1. Verification session (tmux, read-only)
      this.emit('Starting verification session...');
      const verifyResult = await this.runVerificationSession(taskId);
      verificationResults.push(verifyResult);

      if (verifyResult.status === 'PASS') {
        this.emit('\n✅ VERIFICATION PASSED!');
        await taskManager.updateMetadata(taskId, { status: 'completed' });
        return { taskId, passed: true, cycles, verificationResults, finalStatus: 'completed' };
      }

      // 2. Generate revise_plan.md
      this.emit('\n❌ VERIFICATION FAILED');
      const revisePlan = await this.generateRevisePlan(taskId, verifyResult);
      this.emit(`Revise plan generated with ${revisePlan.gaps.length} gaps`);

      // 3. Fix session (tmux, read-write)
      this.emit('\nStarting fix session...');
      await this.runFixSession(taskId);
    }

    // All cycles failed
    await taskManager.updateMetadata(taskId, { status: 'failed' });
    return { taskId, passed: false, cycles, verificationResults, finalStatus: 'failed' };
  }

  private async runVerificationSession(taskId: string): Promise<VerificationResult> {
    // 使用 tmux-spawner 启动只读 verification session
    // 读取 plan.md，检查实现
    // 返回 PASS/FAIL 结果
  }

  private async runFixSession(taskId: string): Promise<void> {
    // 使用 tmux-spawner 启动读写 fix session
    // 读取 revise_plan.md
    // 执行修复步骤
    // 更新 progress.md
  }

  private async generateRevisePlan(taskId: string, result: VerificationResult): Promise<RevisePlan> {
    // 调用现有的 generateRevisePlan 函数
    // 写入 revise_plan.md
  }
}
```

**修改: `src/session/tmux-spawner.ts`**

需要添加支持 verification loop 的功能：
- 检测任务完成（completionPromise）
- 自动触发 verification loop
- 管理 verification/fix session 序列

---

## 文件清单

### 现有文件

| 文件 | 用途 |
|-----|-----|
| `src/session/verification.ts` | VerificationReport, VerificationController, generateRevisePlan |
| `src/session/verification-executor.ts` | VerificationExecutor (当前实现，有 bug) |
| `src/session/rotation.ts` | generateVerificationInstructions |
| `src/gui/server.ts` | `/api/tasks/:taskId/verify` API |
| `src/gui/static/app.js` | GUI verifyTask 函数 |
| `src/gui/static/index.html` | enableVerification 复选框 |

### 需要新增/修改的文件

| 文件 | 用途 |
|-----|-----|
| `src/session/verification-loop.ts` | **新增** - 完整的 verification + fix 循环逻辑 |
| `src/session/tmux-spawner.ts` | **修改** - 集成 verification loop 触发 |
| `src/session/rotation.ts` | **修改** - 添加 fix session 的提示词生成 |

---

## 测试验证

### 已验证的功能 (2026-03-10 测试)

- [x] GUI "Verify" 按钮显示
- [x] 点击按钮显示确认对话框
- [x] API `/api/tasks/:taskId/verify` 正常工作
- [x] Verification session 正确启动
- [x] Verification 提示词正确生成
- [x] GUI 创建任务时 "Enable Verification" 复选框工作正常
- [x] 任务创建后自动触发 verification（通过 enableVerification 选项）
- [x] Verification session 使用只读模式检查 plan.md
- [x] 任务完成后状态正确更新为 "completed"

### 待进一步验证的功能

- [x] Verification 失败时是否正确生成 revise_plan.md ✅ 已验证 (2026-03-10)
- [x] Fix session 是否正确执行 ✅ 已验证 (2026-03-10)
- [x] 循环迭代是否有效 ✅ 已验证 (2026-03-10)

### 测试记录

**测试任务 1**: task-2b265f8e
- 目标: Create a file workspace/verification-test.txt with current timestamp and hostname
- 创建时间: 2026-03-11T00:24:06
- 完成时间: 2026-03-11T00:29:42
- 最终状态: completed
- Verification: 自动触发 + 手动触发均正常启动

**测试任务 2**: task-ba3a3381 (Verification FAIL → Fix → PASS 测试)
- 目标: Create a file workspace/fail-test.txt with content "Expected Content Here"
- 测试场景: 文件内容被手动改为错误值，触发 verification 失败
- 流程记录:
  1. Verification Session 1 (e342b469) → FAIL (检测到内容不匹配)
  2. 生成 revise_plan.md (记录问题和修复步骤)
  3. Fix Session (a34b4e15) → 修复文件内容 → 输出 `<promise>FIX_COMPLETE</promise>`
  4. Verification Session 2 (1fdf1cfa) → PASS
  5. 任务状态更新为 completed

**测试任务 3**: task-9be60647 (GUI Verification Flow 完整测试)
- 目标: Create workspace/verify-fix-test.txt with exact content EXPECT_FIX_CONTENT_123
- 创建时间: 2026-03-11T13:59:21
- 测试场景: 验证 GUI 创建带 verification 的任务，手动破坏文件触发 verification 失败
- 流程记录:
  1. GUI API 创建任务 (enableVerification: true)
  2. 原始任务完成 (cc-daemon-task-9be-1)
  3. 手动修改文件内容为错误值
  4. 触发 Verification API → FAIL
  5. **Fix Session 在 tmux 中启动** (cc-daemon-task-9be-1000)
  6. 修复执行完成，输出 FIX_COMPLETE
  7. 文件内容已修正，GUI 显示 "verify the fix"
- Tmux Session: 新的 fix session 使用独立 tmux session (cc-daemon-task-9be-1000)
- 状态: completed (fix applied)

**测试任务 4**: task-f1433f26 (完整 Verification Loop 自动触发测试)
- 目标: Create workspace/full-verify-test.txt with exact content "CORRECT_CONTENT_ABC_123_XYZ"
- 创建时间: 2026-03-11T22:31:02
- 测试场景: GUI 创建带 verification 的任务，任务完成后手动破坏文件，验证自动触发修复流程
- 流程记录:
  1. GUI 创建任务 (enableVerification: true, completionPromise: TASK_COMPLETE)
  2. Session 1 (f8a69014): 初始任务执行，创建文件 (16.4s, 53→294 tokens)
  3. 任务完成，手动修改文件内容为 "WRONG_CONTENT"
  4. 自动触发 Verification → 检测到内容不匹配
  5. 生成 revise_plan.md，记录: "File contains 'WRONG_CONTENT' instead of 'CORRECT_CONTENT_ABC_123_XYZ'"
  6. Session 2 (89043dc9): Fix session 执行修复 (18.4s, 233→82 tokens)
  7. Fix session 完成，文件内容恢复为 "CORRECT_CONTENT_ABC_123_XYZ"
  8. 自动 Re-verification → PASS
  9. 任务状态更新为 completed
- 总计: 2 sessions, 662 tokens, 0 cost
- 状态: ✅ completed (verification passed after fix)
- 验证: 文件内容最终正确

---

## 实现状态更新

### 已完成的改进

1. **VerificationExecutor** (`src/session/verification-executor.ts`)
   - 实现了完整的 verification + fix 循环
   - Verification 失败后生成 revise_plan.md
   - 启动 Fix session 执行修复
   - 最多循环 3 次

2. **Fix Session 提示词** (`src/session/rotation.ts`)
   - 添加了 `generateFixInstructions()` 函数
   - 生成读写 session 的修复指令

3. **GUI 集成** (`src/gui/server.ts`)
   - 创建任务时支持 `enableVerification` 选项
   - 任务卡片上有 "Verify" 按钮
   - 修复了 RalphProgressEvent 类型错误

---

## 🐛 发现的 Bug: Fix Session 未使用 Ralph Loop Rotation 机制

### 问题描述

Fix session 应该使用和 Ralph Loop rotation **完全相同的机制**：
1. 退出当前 tmux session 中的 claude 进程
2. 启动新的 claude session（带相同的 Ralph Loop 参数）
3. 只是 inject 的 prompt 不同（读取 revise_plan.md）

当前实现使用 `spawnWithCLI` 作为独立子进程，没有：
- 使用 Ralph Loop 参数（completionPromise, maxIterations 等）
- 在同一个 tmux session 中运行
- 支持后续的 context rotation

### 正确的设计

```
┌─────────────────────────────────────────────────────────────────┐
│                    任务执行 (tmux session)                       │
│              Ralph Loop 参数: completionPromise, maxIterations   │
└─────────────────────────┬───────────────────────────────────────┘
                          ↓ 完成后
┌─────────────────────────────────────────────────────────────────┐
│                 Verification Session (独立子进程)                │
│                      只读检查 plan.md                            │
└───────────┬─────────────────────────────────┬───────────────────┘
            ↓ PASS                            ↓ FAIL
     [Task Completed]              [生成 revise_plan.md]
                                          ↓
┌─────────────────────────────────────────────────────────────────┐
│              Fix Session (Ralph Loop Rotation)                   │
│                                                                  │
│   和普通 rotation 完全一样，只是 bootstrap prompt 不同：          │
│   - 读取 revise_plan.md                                          │
│   - 执行修复步骤                                                  │
│   - 保持 Ralph Loop 参数 (completionPromise, maxIterations)      │
│   - 支持后续 context rotation                                    │
│   - 输出 FIX_COMPLETE 作为 completionPromise                     │
└─────────────────────────┬───────────────────────────────────────┘
                          ↓
                  [再次 Verification]
                          ↓
                    (循环最多 3 次)
```

### Ralph Loop Rotation vs Fix Session Rotation

| 特性 | Ralph Loop Rotation | Fix Session Rotation |
|------|---------------------|---------------------|
| 触发条件 | Context 接近上限 | Verification FAIL |
| Bootstrap Prompt | 读取 plan.md + progress.md | 读取 plan.md + **revise_plan.md** |
| Completion Promise | 原始的 TASK_COMPLETE | FIX_COMPLETE |
| Max Iterations | 原始值 | 原始值（继承） |
| tmux session | 同一个 | 同一个 |
| 后续 rotation | 支持 | 支持 |

### 当前实现 (错误)

```typescript
// src/session/verification-executor.ts:128
// 使用 spawnWithCLI - 独立子进程，没有 Ralph Loop 参数
const fixResult = await spawnWithCLI(fixPrompt, {
  timeout: this.options.timeout,
  dangerousSkipPermissions: true
});
```

### 应该的实现

```typescript
// src/session/tmux-ralph-executor.ts

async runVerification(taskId: string, attemptNumber: number): Promise<VerificationResult> {
  // 1. 运行 verification（独立子进程，只读）
  const verifyResult = await verifyTask(taskId, { maxCycles: 1 });

  if (verifyResult.passed) {
    return verifyResult;
  }

  // 2. 生成 revise_plan.md
  const revisePlan = generateRevisePlan(task.plan, verifyResult.finalResult);
  await fs.promises.writeFile(revisePlanPath, revisePlan);

  // 3. Fix session - 使用 Ralph Loop rotation 机制
  //    和普通 rotation 完全一样，只是 prompt 不同
  const fixBootstrapPrompt = this.generateFixBootstrapPrompt(taskId);

  // 退出当前 session，启动新 session（带相同的 Ralph Loop 参数）
  await this.rotateSession({
    ...this.config,  // 保持原有 Ralph Loop 参数
    customPrompt: fixBootstrapPrompt,  // 使用 fix prompt
    completionPromise: 'FIX_COMPLETE'  // 修复完成的信号
  });

  // 等待 FIX_COMPLETE
  // ...
}

private generateFixBootstrapPrompt(taskId: string): string {
  // 和 generateBootstrapPrompt 类似，但读取 revise_plan.md
  let prompt = generateBootstrapInstructions(taskId);

  // 添加 fix 相关指令
  prompt += `

═══════════════════════════════════════════════════════════
FIX SESSION - VERIFICATION FAILED
═══════════════════════════════════════════════════════════

Previous verification failed. Read the revise plan:
${getRevisePlanPath(taskId)}

Fix the issues identified, then output:
<promise>FIX_COMPLETE</promise>
`;
  return prompt;
}
```

### 需要修改的文件

| 文件 | 修改内容 |
|------|----------|
| `src/session/tmux-ralph-executor.ts` | 添加 `runVerification()` 方法，失败后调用 `rotateSession()` |
| `src/session/verification-executor.ts` | 只负责 verification 检查，不负责 fix session |
| `src/session/rotation.ts` | 添加 `generateFixBootstrapPrompt()` |

---

## 🧪 需要通过的测试

### 单元测试

```typescript
// src/session/tmux-ralph-executor.test.ts

describe('TmuxRalphExecutor - Verification Flow', () => {
  it('should call rotateSession with fix prompt after verification FAIL', async () => {
    // 验证 FAIL 后调用 rotateSession
  });

  it('should pass same Ralph Loop config to fix session', async () => {
    // 验证 maxIterations, completionPromise 等参数被继承
  });

  it('should set completionPromise to FIX_COMPLETE for fix session', async () => {
    // 验证 fix session 使用 FIX_COMPLETE 作为完成信号
  });

  it('should include revise_plan.md in fix bootstrap prompt', async () => {
    // 验证 fix prompt 包含 revise_plan.md 路径
  });
});
```

### 集成测试

```typescript
// tests/e2e/verification-loop.test.ts

describe('Verification Loop E2E', () => {
  it('should run fix session as Ralph Loop rotation', async () => {
    // 1. 创建任务（带 Ralph Loop 参数）
    // 2. 触发 verification → FAIL
    // 3. 验证 tmux session 数量不变
    // 4. 验证 fix session 使用相同的 maxIterations
    // 5. 验证能 attach 到 session
  });

  it('should support context rotation during fix session', async () => {
    // 验证 fix session 也支持 context rotation
  });
});
```

### 手动测试步骤

```bash
# 1. 创建带 Ralph Loop 参数的任务
curl -X POST http://localhost:9876/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "Create file with specific content",
    "enableVerification": true,
    "tmux": true,
    "ralphLoop": true,
    "maxIterations": 100,
    "completionPromise": "TASK_COMPLETE"
  }'

# 2. 手动破坏文件，触发 verification FAIL
echo "wrong content" > workspace/test-file.txt

# 3. 触发 verification
curl -X POST http://localhost:9876/api/tasks/{taskId}/verify

# 4. 检查 tmux session (应该还是同一个)
tmux -L cc-daemon list-sessions
# 输出: cc-daemon-task-xxx-1: 1 windows (只有一个)

# 5. Attach 查看 fix session
tmux -L cc-daemon attach -t cc-daemon-task-xxx-1
# 应该看到:
# - 读取 revise_plan.md
# - 执行修复步骤
# - 支持 context rotation (如果 context 接近上限)
# - 输出 FIX_COMPLETE
```

---

## 下一步

1. ~~实现 `VerificationLoop` 类~~ ✅ 已在 VerificationExecutor 中实现
2. ~~添加 fix session 提示词生成~~ ✅ 已添加 generateFixInstructions
3. ~~集成到 tmux-spawner 的任务完成检测~~ ✅ 已在 TmuxRalphExecutor 中集成
4. 添加 verification 历史记录到 progress.md
5. 编写测试用例
