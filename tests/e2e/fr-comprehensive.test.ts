// E2E Test - Comprehensive test for all 4 FRs
// This test verifies:
// FR-1: Ralph Loop Controller
// FR-2: Verification Report Generation
// FR-3: Task File Protocol
// FR-4: JSONL Parsing and Token Calculation

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Set test environment
process.env.CC_DAEMON_DIR = path.join(os.tmpdir(), `cc-daemon-test-${Date.now()}`);

import { taskManager } from '../../src/task/manager.js';
import {
  parseSessionFile,
  getLatestTokenUsage,
  calculateContextStatus,
  watchSessionTokens
} from '../../src/session/monitor.js';
import {
  RalphLoopController,
  generateBootstrapInstructions,
  generateSnapshotInstructions,
  generateVerificationInstructions
} from '../../src/session/rotation.js';
import {
  VerificationReport,
  generateRevisePlan,
  VerificationController
} from '../../src/session/verification.js';
import { serializePlan, parsePlan, serializeProgress, parseProgress } from '../../src/task/manager.js';
import type { TaskPlan, TaskProgress, TokenUsage, SessionRecord } from '../../src/types/index.js';
import { getTaskDir, getPlanPath, getProgressPath, getMetadataPath, ensureDaemonDirs } from '../../src/utils/paths.js';

describe('FR-3: Task File Protocol', () => {
  beforeAll(async () => {
    await ensureDaemonDirs();
  });

  it('should create task with plan.md, progress.md, and metadata.json', async () => {
    const goal = 'Test task for FR-3 verification';
    const metadata = await taskManager.createTask(goal, {
      completionPromise: 'FR3_COMPLETE',
      maxIterations: 5,
      thresholdPercent: 75,
      steps: ['Step 1', 'Step 2', 'Step 3'],
      acceptanceCriteria: ['Criteria A', 'Criteria B']
    });

    const taskDir = getTaskDir(metadata.id);

    // Verify all files exist
    expect(fs.existsSync(getPlanPath(metadata.id))).toBe(true);
    expect(fs.existsSync(getProgressPath(metadata.id))).toBe(true);
    expect(fs.existsSync(getMetadataPath(metadata.id))).toBe(true);

    // Verify metadata.json content
    const metadataRaw = await fs.promises.readFile(getMetadataPath(metadata.id), 'utf-8');
    const parsedMetadata = JSON.parse(metadataRaw);
    expect(parsedMetadata.id).toBe(metadata.id);
    expect(parsedMetadata.status).toBe('pending');
    expect(parsedMetadata.completionPromise).toBe('FR3_COMPLETE');
    expect(parsedMetadata.maxIterations).toBe(5);
    expect(parsedMetadata.thresholdPercent).toBe(75);
  });

  it('should serialize and parse plan.md correctly', async () => {
    const plan: TaskPlan = {
      title: 'Test Plan',
      goal: 'Test goal for serialization',
      steps: [
        { id: 'step-1', description: 'First step', completed: false },
        { id: 'step-2', description: 'Second step', completed: true },
        { id: 'step-3', description: 'Third step', completed: false }
      ],
      acceptanceCriteria: ['Accept 1', 'Accept 2']
    };

    const serialized = serializePlan(plan);
    const parsed = parsePlan(serialized);

    expect(parsed.title).toBe(plan.title);
    expect(parsed.goal).toBe(plan.goal);
    expect(parsed.steps).toHaveLength(3);
    expect(parsed.steps[0].completed).toBe(false);
    expect(parsed.steps[1].completed).toBe(true);
    expect(parsed.acceptanceCriteria).toEqual(plan.acceptanceCriteria);
  });

  it('should serialize and parse progress.md correctly', async () => {
    const progress: TaskProgress = {
      taskId: 'task-test-123',
      currentStatus: 'active',
      currentStep: 'step-2',
      currentSessionId: 'session-abc',
      completedSteps: [
        { stepId: 'step-1', completedAt: '2024-01-01T00:00:00Z', notes: 'Done' }
      ],
      keyDecisions: ['Decision 1'],
      artifacts: [{ path: '/tmp/artifact.txt', description: 'Test artifact' }],
      sessionHistory: [
        {
          sessionId: 'session-abc',
          startedAt: '2024-01-01T00:00:00Z',
          duration: 1000,
          stepsCompleted: 1,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 20,
          cost: 0.01
        }
      ],
      blockers: ['Blocker 1']
    };

    const serialized = serializeProgress(progress);
    const parsed = parseProgress(serialized);

    expect(parsed.taskId).toBe(progress.taskId);
    expect(parsed.currentStatus).toBe(progress.currentStatus);
    expect(parsed.currentStep).toBe(progress.currentStep);
    expect(parsed.completedSteps).toHaveLength(1);
    expect(parsed.keyDecisions).toEqual(progress.keyDecisions);
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.sessionHistory).toHaveLength(1);
    expect(parsed.blockers).toEqual(progress.blockers);
  });

  it('should update metadata with locking', async () => {
    const metadata = await taskManager.createTask('Locking test');
    const updated = await taskManager.updateMetadata(metadata.id, {
      status: 'active',
      totalSessions: 5
    });

    expect(updated.status).toBe('active');
    expect(updated.totalSessions).toBe(5);
  });

  it('should update progress with locking', async () => {
    const metadata = await taskManager.createTask('Progress update test');
    const updated = await taskManager.updateProgress(metadata.id, {
      currentStep: 'step-new',
      currentStatus: 'active'
    });

    expect(updated.currentStep).toBe('step-new');
    expect(updated.currentStatus).toBe('active');
  });

  it('should add session records', async () => {
    const metadata = await taskManager.createTask('Session record test');
    const record: SessionRecord = {
      sessionId: 'session-test',
      startedAt: new Date().toISOString(),
      duration: 5000,
      stepsCompleted: 2,
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 100,
      cost: 0.05
    };

    await taskManager.addSessionRecord(metadata.id, record);
    const task = await taskManager.getTask(metadata.id);

    expect(task?.progress.sessionHistory).toHaveLength(1);
    expect(task?.progress.sessionHistory[0].sessionId).toBe('session-test');
  });
});

describe('FR-4: JSONL Parsing and Token Calculation', () => {
  const testJsonlPath = path.join(os.tmpdir(), `test-session-${Date.now()}.jsonl`);

  beforeAll(async () => {
    // Create a test JSONL file (使用真实的 JSONL 格式)
    const lines = [
      JSON.stringify({ type: 'session', version: 1, id: 'test-session', timestamp: new Date().toISOString(), cwd: '/tmp' }),
      JSON.stringify({ type: 'user', role: 'user', content: 'Hello' }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } }),
      JSON.stringify({ type: 'user', role: 'user', content: 'More text' }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 30, output_tokens: 50, cache_read_input_tokens: 15, cache_creation_input_tokens: 3 } } })
    ];
    await fs.promises.writeFile(testJsonlPath, lines.join('\n'));
  });

  afterAll(async () => {
    await fs.promises.unlink(testJsonlPath).catch(() => {});
  });

  it('should parse JSONL file and extract messages', async () => {
    const { header, messages, currentContextUsage } = await parseSessionFile(testJsonlPath);

    expect(header).not.toBeNull();
    expect(header?.type).toBe('session');
    expect(messages).toHaveLength(4);
    expect(messages[0].type).toBe('user');
    expect(messages[1].type).toBe('assistant');
  });

  it('should return last assistant message usage (current context)', async () => {
    const { currentContextUsage } = await parseSessionFile(testJsonlPath);

    // 只返回最后一条 assistant 消息的 usage（当前上下文），不是累积
    expect(currentContextUsage.inputTokens).toBe(30);
    expect(currentContextUsage.outputTokens).toBe(50);
    expect(currentContextUsage.cacheReadInputTokens).toBe(15);
    expect(currentContextUsage.cacheCreationInputTokens).toBe(3);
  });

  it('should get latest token usage', async () => {
    const latest = await getLatestTokenUsage(testJsonlPath);

    expect(latest).not.toBeNull();
    expect(latest?.inputTokens).toBe(30);
    expect(latest?.outputTokens).toBe(50);
  });

  it('should calculate context status correctly', () => {
    const usage: TokenUsage = {
      inputTokens: 50000,
      outputTokens: 25000,
      cacheReadInputTokens: 10000,
      cacheCreationInputTokens: 5000
    };

    const status = calculateContextStatus(usage, {
      effectiveContextLimit: 150000,
      thresholdPercent: 80,
      snapshotReserveTokens: 8000
    });

    // Effective used = 50000 + 25000 = 75000
    // Percent = 75000 / 150000 * 100 = 50%
    expect(status.usedTokens).toBe(75000);
    expect(status.totalTokens).toBe(150000);
    expect(status.percentUsed).toBeCloseTo(50, 1);
    expect(status.shouldRotate).toBe(false);
    expect(status.emergencyRotate).toBe(false);
  });

  it('should detect rotation threshold', () => {
    const usage: TokenUsage = {
      inputTokens: 100000,
      outputTokens: 30000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    };

    const status = calculateContextStatus(usage, {
      effectiveContextLimit: 150000,
      thresholdPercent: 80,
      snapshotReserveTokens: 8000
    });

    // Effective used = 130000
    // Percent = 86.67%
    expect(status.percentUsed).toBeCloseTo(86.67, 1);
    expect(status.shouldRotate).toBe(true);
    expect(status.emergencyRotate).toBe(false);
  });

  it('should detect emergency rotation', () => {
    const usage: TokenUsage = {
      inputTokens: 140000,
      outputTokens: 5000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    };

    const status = calculateContextStatus(usage, {
      effectiveContextLimit: 150000,
      thresholdPercent: 80,
      snapshotReserveTokens: 8000
    });

    // Effective used = 145000 > 150000 - 8000 = 142000
    expect(status.shouldRotate).toBe(true);
    expect(status.emergencyRotate).toBe(true);
  });
});

describe('FR-1: Ralph Loop Controller', () => {
  it('should create controller with config', () => {
    const controller = new RalphLoopController({
      thresholdPercent: 75,
      maxIterations: 10,
      completionPromise: 'RALPH_DONE'
    });

    expect(controller).toBeDefined();
  });

  it('should generate bootstrap instructions', async () => {
    const metadata = await taskManager.createTask('Bootstrap test');
    const instructions = generateBootstrapInstructions(metadata.id);

    expect(instructions).toContain('SESSION RESUMPTION');
    expect(instructions).toContain(metadata.id);
    expect(instructions).toContain('plan');
    expect(instructions).toContain('progress');
  });

  it('should generate snapshot instructions', async () => {
    const metadata = await taskManager.createTask('Snapshot test');
    const instructions = generateSnapshotInstructions(metadata.id);

    expect(instructions).toContain('CONTEXT ROTATION');
    expect(instructions).toContain('SNAPSHOT REQUIRED');
    expect(instructions).toContain('progress.md');
  });

  it('should start and manage task', async () => {
    const controller = new RalphLoopController({
      completionPromise: 'TEST_COMPLETE'
    });

    const metadata = await taskManager.createTask('Controller start test');
    await controller.start(metadata.id);

    const task = await taskManager.getTask(metadata.id);
    expect(task?.metadata.status).toBe('active');
    expect(task?.progress.currentStatus).toBe('active');

    await controller.stop();
  });

  it('should check completion promise', () => {
    const controller = new RalphLoopController({
      completionPromise: 'MY_PROMISE'
    });

    expect(controller.checkCompletionPromise('Some text <promise>MY_PROMISE</promise> more text')).toBe(true);
    expect(controller.checkCompletionPromise('Some text without promise')).toBe(false);
    expect(controller.checkCompletionPromise('<promise>WRONG_PROMISE</promise>')).toBe(false);
  });
});

describe('FR-2: Verification Report Generation', () => {
  it('should create verification report', async () => {
    const metadata = await taskManager.createTask('Verification report test');
    const report = new VerificationReport(metadata.id);

    report.addStepResult('step-1', 'First step', 'PASS', 'Completed successfully');
    report.addStepResult('step-2', 'Second step', 'FAIL', 'Missing implementation');

    report.addCriteriaResult('Criteria 1', 'PASS', 'Found in code');
    report.addCriteriaResult('Criteria 2', 'FAIL', 'Not implemented');

    report.addGap('Missing error handling');
    report.addGap('No tests');

    report.addRecommendation('Add error handling');
    report.addRecommendation('Write unit tests');

    const result = report.getResult();

    expect(result.status).toBe('FAIL');
    expect(result.stepResults).toHaveLength(2);
    expect(result.criteriaResults).toHaveLength(2);
    expect(result.gaps).toHaveLength(2);
    expect(result.recommendations).toHaveLength(2);
  });

  it('should generate markdown report', async () => {
    const metadata = await taskManager.createTask('Markdown report test');
    const report = new VerificationReport(metadata.id);

    report.addStepResult('step-1', 'Test step', 'PASS', 'OK');
    report.addCriteriaResult('Criteria', 'PASS', 'Evidence');
    report.addGap('Gap 1');
    report.addRecommendation('Rec 1');

    const markdown = report.toMarkdown();

    expect(markdown).toContain('# Verification Report');
    expect(markdown).toContain('**Status: FAIL**');
    expect(markdown).toContain('## Step Verification');
    expect(markdown).toContain('## Acceptance Criteria');
    expect(markdown).toContain('## Gaps Found');
    expect(markdown).toContain('## Recommendations');
  });

  it('should generate revise plan from verification result', async () => {
    const plan: TaskPlan = {
      title: 'Original Plan',
      goal: 'Original goal',
      steps: [
        { id: 'step-1', description: 'Step 1', completed: true },
        { id: 'step-2', description: 'Step 2', completed: false }
      ],
      acceptanceCriteria: ['Criteria 1']
    };

    const metadata = await taskManager.createTask('Revise plan test');
    const report = new VerificationReport(metadata.id);
    report.addGap('Missing feature X');
    report.addRecommendation('Implement feature X');

    const result = report.getResult();
    const revisePlan = generateRevisePlan(plan, result);

    expect(revisePlan).toContain('# Revise Plan');
    expect(revisePlan).toContain('## Issues Found');
    expect(revisePlan).toContain('Missing feature X');
    expect(revisePlan).toContain('## Additional Steps to Complete');
    expect(revisePlan).toContain('Implement feature X');
  });

  it('should generate verification instructions', async () => {
    const metadata = await taskManager.createTask('Verification instructions test');
    const instructions = generateVerificationInstructions(metadata.id);

    expect(instructions).toContain('TASK VERIFICATION');
    expect(instructions).toContain('CLEAN SESSION');
    expect(instructions).toContain('plan');
    expect(instructions).toContain('DO NOT read progress.md');
    expect(instructions).toContain('READ-ONLY');
  });

  it('should create verification controller', async () => {
    const controller = new VerificationController(3);
    const metadata = await taskManager.createTask('Controller test');

    const { instructions, report } = await controller.startVerification(metadata.id);

    expect(instructions).toContain('VERIFICATION');
    expect(controller.canRetry()).toBe(true);

    // Test PASS result
    report.addStepResult('step-1', 'Test', 'PASS', 'OK');
    report.addCriteriaResult('Criteria', 'PASS', 'Evidence');
    const result = report.getResult();

    const action = await controller.processResult(metadata.id, result);
    expect(action.action).toBe('complete');
    expect(action.message).toContain('passed');

    const task = await taskManager.getTask(metadata.id);
    expect(task?.metadata.status).toBe('completed');
  });
});

describe('Integration: Complete Task Flow', () => {
  it('should create task, run through FR-1, FR-2, FR-3, FR-4', async () => {
    // FR-3: Create task with file protocol
    const metadata = await taskManager.createTask('Complete flow integration test', {
      completionPromise: 'FLOW_COMPLETE',
      maxIterations: 5,
      steps: ['Initialize', 'Process', 'Finalize'],
      acceptanceCriteria: ['All steps completed', 'No errors']
    });

    // Verify FR-3 files exist
    expect(fs.existsSync(getPlanPath(metadata.id))).toBe(true);
    expect(fs.existsSync(getProgressPath(metadata.id))).toBe(true);
    expect(fs.existsSync(getMetadataPath(metadata.id))).toBe(true);

    // FR-1: Ralph Loop Controller
    const controller = new RalphLoopController({
      completionPromise: 'FLOW_COMPLETE',
      maxIterations: 5,
      thresholdPercent: 80
    });

    await controller.start(metadata.id);
    let task = await taskManager.getTask(metadata.id);
    expect(task?.metadata.status).toBe('active');

    // FR-4: Token calculation (simulate)
    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 50
    };

    const status = calculateContextStatus(usage, {
      effectiveContextLimit: 150000,
      thresholdPercent: 80,
      snapshotReserveTokens: 8000
    });
    expect(status.percentUsed).toBeCloseTo(1, 1); // Very low usage

    // Add session record (simulating FR-1 rotation)
    const sessionRecord: SessionRecord = {
      sessionId: 'session-flow-test',
      startedAt: new Date().toISOString(),
      duration: 10000,
      stepsCompleted: 2,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      cost: 0.01
    };
    await taskManager.addSessionRecord(metadata.id, sessionRecord);

    task = await taskManager.getTask(metadata.id);
    expect(task?.progress.sessionHistory).toHaveLength(1);

    // FR-2: Verification
    const verifyController = new VerificationController(3);
    const { report } = await verifyController.startVerification(metadata.id);

    report.addStepResult('step-1', 'Initialize', 'PASS', 'Done');
    report.addStepResult('step-2', 'Process', 'PASS', 'Done');
    report.addStepResult('step-3', 'Finalize', 'PASS', 'Done');
    report.addCriteriaResult('All steps completed', 'PASS', '3/3 steps done');
    report.addCriteriaResult('No errors', 'PASS', 'No errors found');

    const verifyResult = report.getResult();
    expect(verifyResult.status).toBe('PASS');

    const action = await verifyController.processResult(metadata.id, verifyResult);
    expect(action.action).toBe('complete');

    // Final verification
    task = await taskManager.getTask(metadata.id);
    expect(task?.metadata.status).toBe('completed');

    // Cleanup
    await controller.stop();
  });
});
