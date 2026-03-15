// Verification System - Clean session verification

import type { TaskPlan, TaskMetadata } from '../types/index.js';
import { taskManager } from '../task/manager.js';
import { getPlanPath } from '../utils/paths.js';
import { generateVerificationInstructions } from './rotation.js';

export interface VerificationResult {
  taskId: string;
  status: 'PASS' | 'FAIL';
  stepResults: Array<{
    stepId: string;
    description: string;
    status: 'PASS' | 'FAIL' | 'SKIP';
    notes: string;
  }>;
  criteriaResults: Array<{
    criterion: string;
    status: 'PASS' | 'FAIL';
    evidence: string;
  }>;
  gaps: string[];
  recommendations: string[];
  verifiedAt: string;
}

/**
 * Verification Report Generator
 */
export class VerificationReport {
  private result: VerificationResult;
  private taskId: string;

  constructor(taskId: string) {
    this.taskId = taskId;
    this.result = {
      taskId,
      status: 'PASS',
      stepResults: [],
      criteriaResults: [],
      gaps: [],
      recommendations: [],
      verifiedAt: new Date().toISOString()
    };
  }

  addStepResult(
    stepId: string,
    description: string,
    status: 'PASS' | 'FAIL' | 'SKIP',
    notes: string
  ): void {
    this.result.stepResults.push({ stepId, description, status, notes });
    if (status === 'FAIL') {
      this.result.status = 'FAIL';
    }
  }

  addCriteriaResult(
    criterion: string,
    status: 'PASS' | 'FAIL',
    evidence: string
  ): void {
    this.result.criteriaResults.push({ criterion, status, evidence });
    if (status === 'FAIL') {
      this.result.status = 'FAIL';
    }
  }

  addGap(description: string): void {
    this.result.gaps.push(description);
    // Gaps indicate verification failure
    this.result.status = 'FAIL';
  }

  addRecommendation(description: string): void {
    this.result.recommendations.push(description);
  }

  getResult(): VerificationResult {
    return this.result;
  }

  toMarkdown(): string {
    const lines: string[] = [
      `# Verification Report: ${this.taskId}`,
      '',
      `**Status: ${this.result.status}**`,
      `**Verified At: ${this.result.verifiedAt}**`,
      '',
      '## Step Verification',
      '| Step | Status | Notes |',
      '|------|--------|-------|'
    ];

    for (const step of this.result.stepResults) {
      const icon = step.status === 'PASS' ? '✓' : step.status === 'FAIL' ? '✗' : '○';
      lines.push(`| ${step.stepId} | ${icon} ${step.status} | ${step.notes} |`);
    }

    lines.push('', '## Acceptance Criteria', '| Criterion | Status | Evidence |', '|-----------|--------|----------|');

    for (const criteria of this.result.criteriaResults) {
      const icon = criteria.status === 'PASS' ? '✓' : '✗';
      lines.push(`| ${criteria.criterion} | ${icon} ${criteria.status} | ${criteria.evidence} |`);
    }

    if (this.result.gaps.length > 0) {
      lines.push('', '## Gaps Found');
      for (const gap of this.result.gaps) {
        lines.push(`- ${gap}`);
      }
    }

    if (this.result.recommendations.length > 0) {
      lines.push('', '## Recommendations');
      for (const rec of this.result.recommendations) {
        lines.push(`- ${rec}`);
      }
    }

    return lines.join('\n');
  }
}

/**
 * Generate a revise plan from verification gaps
 */
export function generateRevisePlan(
  originalPlan: TaskPlan,
  verificationResult: VerificationResult
): string {
  const lines: string[] = [
    `# Revise Plan: ${originalPlan.title}`,
    '',
    '## Original Goal',
    originalPlan.goal,
    '',
    '## Issues Found'
  ];

  for (const gap of verificationResult.gaps) {
    lines.push(`- ${gap}`);
  }

  lines.push('', '## Additional Steps to Complete');
  let stepNum = originalPlan.steps.length + 1;

  for (const rec of verificationResult.recommendations) {
    lines.push(`- [ ] step-${stepNum}: ${rec}`);
    stepNum++;
  }

  lines.push('', '## Original Acceptance Criteria');
  for (const criteria of originalPlan.acceptanceCriteria) {
    lines.push(`- ${criteria}`);
  }

  // Add any new criteria from gaps
  if (verificationResult.gaps.length > 0) {
    lines.push('', '## Additional Criteria');
    for (const gap of verificationResult.gaps) {
      lines.push(`- Address: ${gap}`);
    }
  }

  return lines.join('\n');
}

/**
 * Verification Controller
 */
export class VerificationController {
  private maxCycles: number;
  private currentCycle: number = 0;

  constructor(maxCycles: number = 3) {
    this.maxCycles = maxCycles;
  }

  /**
   * Start verification for a task
   */
  async startVerification(taskId: string): Promise<{
    instructions: string;
    report: VerificationReport;
  }> {
    const task = await taskManager.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    this.currentCycle++;

    console.log(`Starting verification cycle ${this.currentCycle}/${this.maxCycles} for task ${taskId}`);

    const instructions = generateVerificationInstructions(taskId);
    const report = new VerificationReport(taskId);

    return { instructions, report };
  }

  /**
   * Check if more verification cycles are allowed
   */
  canRetry(): boolean {
    return this.currentCycle < this.maxCycles;
  }

  /**
   * Process verification result and decide next action
   */
  async processResult(
    taskId: string,
    result: VerificationResult
  ): Promise<{
    action: 'complete' | 'retry' | 'fail';
    message: string;
  }> {
    if (result.status === 'PASS') {
      await taskManager.updateMetadata(taskId, { status: 'completed' });
      return {
        action: 'complete',
        message: 'Verification passed! Task is complete.'
      };
    }

    if (this.canRetry()) {
      const task = await taskManager.getTask(taskId);
      if (task) {
        const revisePlan = generateRevisePlan(task.plan, result);
        console.log('\n--- REVISE PLAN ---');
        console.log(revisePlan);
        console.log('--- END REVISE PLAN ---\n');
      }

      return {
        action: 'retry',
        message: `Verification failed. Retry ${this.currentCycle + 1}/${this.maxCycles} starting...`
      };
    }

    await taskManager.updateMetadata(taskId, { status: 'failed' });
    return {
      action: 'fail',
      message: `Max verification cycles (${this.maxCycles}) reached. Task marked as failed.`
    };
  }
}

/**
 * Create a verification controller
 */
export function createVerificationController(maxCycles: number = 3): VerificationController {
  return new VerificationController(maxCycles);
}
