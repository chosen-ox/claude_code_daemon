// Verification Executor - Run verification in isolated sessions

import { spawnWithCLI, isClaudeAvailable, type SpawnResult } from './spawner.js';
import { isTmuxAvailable } from './tmux-spawner.js';
import { runFixSession } from './tmux-spawner.js';
import { generateVerificationInstructions } from './rotation.js';
import { VerificationReport, VerificationController, generateRevisePlan, type VerificationResult } from './verification.js';
import { taskManager } from '../task/manager.js';
import { ensureDaemonDirs } from '../utils/paths.js';
import * as fs from 'fs';
import * as path from 'path';
import { getTasksDir } from '../utils/paths.js';

export interface VerificationExecutorOptions {
  maxCycles?: number;
  timeout?: number;
  onProgress?: (message: string) => void;
}

export interface VerificationExecutorResult {
  taskId: string;
  passed: boolean;
  cycles: number;
  finalResult: VerificationResult | null;
  revisePlanPath?: string;
  error?: string;
}

/**
 * Verification Executor - runs verification in isolated sessions
 */
export class VerificationExecutor {
  private options: VerificationExecutorOptions;
  private controller: VerificationController;

  constructor(options: VerificationExecutorOptions = {}) {
    this.options = {
      maxCycles: 3,
      timeout: 10 * 60 * 1000, // 10 minutes
      ...options
    };
    this.controller = new VerificationController(this.options.maxCycles);
  }

  /**
   * Run verification for a task
   */
  async verify(taskId: string): Promise<VerificationExecutorResult> {
    await ensureDaemonDirs();

    const task = await taskManager.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Check Claude availability
    if (!(await isClaudeAvailable())) {
      throw new Error('Claude CLI is not available. Please install it first.');
    }

    // Check tmux availability for fix sessions
    const tmuxAvailable = await isTmuxAvailable();
    if (!tmuxAvailable) {
      this.emit('Warning: tmux is not available. Fix sessions will be skipped.');
    }

    this.emit(`Starting verification for task: ${taskId}`);
    this.emit(`Task goal: ${task.plan.goal}`);

    let cycles = 0;
    let finalResult: VerificationResult | null = null;

    while (cycles < this.options.maxCycles!) {
      cycles++;
      const cycleMsg = `\n--- Verification Cycle ${cycles}/${this.options.maxCycles} ---`;
      this.emit(cycleMsg);
      console.log(`[verification-executor] ${cycleMsg}`);

      // Phase 1: Run verification (read-only, isolated)
      const verifyMsg = 'Phase 1: Running verification session (read-only)...';
      this.emit(verifyMsg);
      console.log(`[verification-executor] ${verifyMsg}`);
      const verificationResult = await this.runVerificationPhase(taskId);

      if (verificationResult.status === 'PASS') {
        const passMsg = '\n✅ VERIFICATION PASSED!';
        this.emit(passMsg);
        console.log(`[verification-executor] ${passMsg}`);
        finalResult = verificationResult;
        await taskManager.updateMetadata(taskId, { status: 'completed' });
        return {
          taskId,
          passed: true,
          cycles,
          finalResult
        };
      }

      // Verification failed
      this.emit('\n❌ VERIFICATION FAILED');
      this.emit(`Gaps found: ${verificationResult.gaps.length}`);
      for (const gap of verificationResult.gaps) {
        this.emit(`  - ${gap}`);
      }

      finalResult = verificationResult;

      // Phase 2: Generate revise plan
      this.emit('Phase 2: Generating revise plan...');
      const revisePlan = generateRevisePlan(task.plan, verificationResult);
      const revisePlanPath = path.join(getTasksDir(), taskId, 'revise_plan.md');
      await fs.promises.writeFile(revisePlanPath, revisePlan);
      this.emit(`Revise plan saved to: ${revisePlanPath}`);

      // Phase 3: Run fix session (if tmux available)
      if (tmuxAvailable) {
        this.emit('Phase 3: Running fix session (tmux)...');
        try {
          const fixResult = await runFixSession(taskId, cycles, {
            timeout: this.options.timeout,
            verbose: false,
            cwd: process.cwd(),
            onOutput: (chunk) => {
              // Emit fix session output for monitoring
              if (chunk.includes('FIX_COMPLETE')) {
                this.emit('✅ Fix session completed!');
              }
            }
          });

          if (fixResult.completionDetected) {
            this.emit('Fix session completed successfully');
            // Continue to next verification cycle
            if (cycles < this.options.maxCycles!) {
              this.emit('\n→ Re-running verification to check fixes...\n');
            }
          } else {
            this.emit('Fix session did not complete normally');
            if (fixResult.error) {
              this.emit(`Error: ${fixResult.error}`);
            }
          }
        } catch (error) {
          this.emit(`Fix session failed: ${error}`);
          // Continue to next cycle anyway
        }
      } else {
        this.emit('Skipping fix session (tmux not available)');
        if (cycles < this.options.maxCycles!) {
          this.emit('\n→ Retrying verification without fixes...\n');
        }
      }
    }

    // All cycles failed
    await taskManager.updateMetadata(taskId, { status: 'failed' });
    this.emit(`\n❌ All ${cycles} verification cycles failed.`);

    return {
      taskId,
      passed: false,
      cycles,
      finalResult,
      error: 'Verification failed after all cycles'
    };
  }

  /**
   * Run verification phase (read-only)
   */
  private async runVerificationPhase(taskId: string): Promise<VerificationResult> {
    // Generate verification prompt
    const verificationPrompt = this.generateVerificationPrompt(taskId);

    // Run verification in isolated session
    const spawnResult = await spawnWithCLI(verificationPrompt, {
      timeout: this.options.timeout,
      dangerousSkipPermissions: true
    });

    if (!spawnResult.success) {
      this.emit(`Session error: ${spawnResult.error || 'Unknown error'}`);
      // Return a failure result with all required fields
      return {
        taskId,
        status: 'FAIL',
        stepResults: [{
          stepId: 'verification',
          description: 'Verification session',
          status: 'FAIL',
          notes: spawnResult.error || 'Unknown error during verification'
        }],
        criteriaResults: [],
        gaps: [spawnResult.error || 'Unknown error during verification'],
        recommendations: ['Fix verification session errors and retry'],
        verifiedAt: new Date().toISOString()
      };
    }

    // Parse verification result from output
    return this.parseVerificationOutput(taskId, spawnResult.output);
  }

  /**
   * Generate verification prompt
   */
  private generateVerificationPrompt(taskId: string): string {
    let prompt = generateVerificationInstructions(taskId);

    prompt += `

IMPORTANT OUTPUT FORMAT:
After your verification, you MUST output your result in one of these formats:

For PASS:
## VERIFICATION_RESULT: PASS
All acceptance criteria met.

For FAIL:
## VERIFICATION_RESULT: FAIL
### GAPS
- [gap 1]
- [gap 2]
### RECOMMENDATIONS
- [recommendation 1]
- [recommendation 2]
`;

    return prompt;
  }

  /**
   * Parse verification output
   */
  private parseVerificationOutput(taskId: string, output: string): VerificationResult {
    const report = new VerificationReport(taskId);
    const lowerOutput = output.toLowerCase();

    // Check for PASS/FAIL marker
    const passMatch = output.match(/VERIFICATION_RESULT:\s*PASS/i);
    const failMatch = output.match(/VERIFICATION_RESULT:\s*FAIL/i);

    if (passMatch) {
      // Extract any notes
      const notesMatch = output.match(/VERIFICATION_RESULT:\s*PASS\s*\n([\s\S]*?)(?=##|$)/i);
      const notes = notesMatch ? notesMatch[1].trim() : 'All criteria met';

      // Add default passing results
      report.addStepResult('verification', 'All steps verified', 'PASS', notes);
      report.addCriteriaResult('All criteria', 'PASS', notes);

      return report.getResult();
    }

    if (failMatch) {
      // Extract gaps
      const gapsMatch = output.match(/GAPS\s*\n([\s\S]*?)(?=###|##|$)/i);
      if (gapsMatch) {
        const gapLines = gapsMatch[1].split('\n')
          .map(l => l.trim())
          .filter(l => l.startsWith('-') || l.startsWith('*'));
        for (const line of gapLines) {
          const gap = line.replace(/^[-*]\s*/, '').trim();
          if (gap) {
            report.addGap(gap);
          }
        }
      }

      // Extract recommendations
      const recsMatch = output.match(/RECOMMENDATIONS\s*\n([\s\S]*?)(?=###|##|$)/i);
      if (recsMatch) {
        const recLines = recsMatch[1].split('\n')
          .map(l => l.trim())
          .filter(l => l.startsWith('-') || l.startsWith('*'));
        for (const line of recLines) {
          const rec = line.replace(/^[-*]\s*/, '').trim();
          if (rec) {
            report.addRecommendation(rec);
          }
        }
      }

      // Add failing results
      report.addStepResult('verification', 'Verification failed', 'FAIL',
        `Found ${report.getResult().gaps.length} gaps`);

      return report.getResult();
    }

    // No clear marker - try to infer from content
    if (lowerOutput.includes('all criteria') && lowerOutput.includes('met')) {
      report.addStepResult('verification', 'All steps verified', 'PASS', 'Inferred from output');
      return report.getResult();
    }

    // Default to fail with raw output as gap
    report.addGap('Could not determine verification status from output');
    report.addStepResult('verification', 'Unclear result', 'FAIL', 'No clear PASS/FAIL marker found');
    return report.getResult();
  }

  /**
   * Emit progress message
   */
  private emit(message: string): void {
    if (this.options.onProgress) {
      this.options.onProgress(message);
    }
  }
}

/**
 * Quick verification function
 */
export async function verifyTask(
  taskId: string,
  options?: VerificationExecutorOptions
): Promise<VerificationExecutorResult> {
  const executor = new VerificationExecutor(options);
  return executor.verify(taskId);
}
