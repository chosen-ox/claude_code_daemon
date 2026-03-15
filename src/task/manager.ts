// Task file management - handles plan.md, progress.md, and metadata.json

import * as fs from 'fs';
import * as path from 'path';
import lockfile from 'proper-lockfile';
import type { TaskMetadata, TaskPlan, TaskProgress, Step, SessionRecord, TaskStatus } from '../types/index.js';
import {
  getTaskDir,
  getPlanPath,
  getProgressPath,
  getMetadataPath,
  ensureDir,
  fileExists,
  getTasksDir
} from '../utils/paths.js';
import { generateTaskId } from '../utils/id.js';

// ============================================================================
// Plan.md Management
// ============================================================================

export function serializePlan(plan: TaskPlan): string {
  const lines: string[] = [
    `# Task: ${plan.title}`,
    '',
    '## Goal',
    plan.goal,
    '',
    '## Steps'
  ];

  for (const step of plan.steps) {
    const checkbox = step.completed ? '[x]' : '[ ]';
    lines.push(`- ${checkbox} ${step.id}: ${step.description}`);
  }

  lines.push('', '## Acceptance Criteria');
  for (const criterion of plan.acceptanceCriteria) {
    lines.push(`- ${criterion}`);
  }

  return lines.join('\n');
}

export function parsePlan(content: string): TaskPlan {
  const lines = content.split('\n');
  let title = '';
  let goal = '';
  const steps: Step[] = [];
  const acceptanceCriteria: string[] = [];

  let section = '';

  for (const line of lines) {
    if (line.startsWith('# Task: ')) {
      title = line.substring('# Task: '.length).trim();
    } else if (line.startsWith('## ')) {
      section = line.substring(2).trim().toLowerCase();
    } else if (section === 'goal' && line.trim() && !line.startsWith('#')) {
      goal = line.trim();
    } else if (section === 'steps' && line.match(/^- \[[ x]\] .+/)) {
      const match = line.match(/^- \[([ x])\] (\S+): (.+)$/);
      if (match) {
        steps.push({
          id: match[2],
          description: match[3],
          completed: match[1] === 'x'
        });
      }
    } else if (section === 'acceptance criteria' && line.startsWith('- ') && !line.startsWith('- [ ]')) {
      acceptanceCriteria.push(line.substring(2).trim());
    }
  }

  return { title, goal, steps, acceptanceCriteria };
}

// ============================================================================
// Progress.md Management
// ============================================================================

export function serializeProgress(progress: TaskProgress): string {
  const lines: string[] = [
    `# Progress: ${progress.taskId}`,
    '',
    '## Current State',
    `- Status: ${progress.currentStatus}`,
    `- Current Step: ${progress.currentStep || 'none'}`,
    `- Session: ${progress.currentSessionId || 'none'}`,
    ''
  ];

  if (progress.completedSteps.length > 0) {
    lines.push('## Completed Steps');
    for (const step of progress.completedSteps) {
      lines.push(`- [x] ${step.stepId} - ${step.completedAt}${step.notes ? ` - ${step.notes}` : ''}`);
    }
    lines.push('');
  }

  if (progress.keyDecisions.length > 0) {
    lines.push('## Key Decisions');
    for (const decision of progress.keyDecisions) {
      lines.push(`- ${decision}`);
    }
    lines.push('');
  }

  if (progress.artifacts.length > 0) {
    lines.push('## Artifacts');
    for (const artifact of progress.artifacts) {
      lines.push(`- \`${artifact.path}\`: ${artifact.description}`);
    }
    lines.push('');
  }

  if (progress.sessionHistory.length > 0) {
    lines.push('## Session History');
    lines.push('| Session ID | Started | Duration | Steps | Input Tokens | Output Tokens | Cost |');
    lines.push('|------------|---------|----------|-------|--------------|---------------|------|');
    for (const session of progress.sessionHistory) {
      lines.push(`| ${session.sessionId} | ${session.startedAt} | ${session.duration || 'ongoing'}ms | ${session.stepsCompleted} | ${session.inputTokens} | ${session.outputTokens} | $${session.cost.toFixed(4)} |`);
    }
    lines.push('');
  }

  if (progress.blockers.length > 0) {
    lines.push('## Blockers');
    for (const blocker of progress.blockers) {
      lines.push(`- ${blocker}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function parseProgress(content: string): TaskProgress {
  const lines = content.split('\n');
  let taskId = '';
  let currentStatus: TaskStatus = 'pending';
  let currentStep: string | undefined;
  let currentSessionId: string | undefined;
  const completedSteps: Array<{ stepId: string; completedAt: string; notes?: string }> = [];
  const keyDecisions: string[] = [];
  const artifacts: Array<{ path: string; description: string }> = [];
  const sessionHistory: SessionRecord[] = [];
  const blockers: string[] = [];

  let section = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('# Progress: ')) {
      taskId = line.substring('# Progress: '.length).trim();
    } else if (line.startsWith('## ')) {
      section = line.substring(2).trim().toLowerCase();
    } else if (section === 'current state') {
      if (line.startsWith('- Status: ')) {
        currentStatus = line.substring('- Status: '.length).trim() as TaskStatus;
      } else if (line.startsWith('- Current Step: ')) {
        const val = line.substring('- Current Step: '.length).trim();
        currentStep = val === 'none' ? undefined : val;
      } else if (line.startsWith('- Session: ')) {
        const val = line.substring('- Session: '.length).trim();
        currentSessionId = val === 'none' ? undefined : val;
      }
    } else if (section === 'completed steps' && line.startsWith('- [x] ')) {
      const match = line.match(/^- \[x\] (\S+) - (\S+)(?: - (.+))?$/);
      if (match) {
        completedSteps.push({
          stepId: match[1],
          completedAt: match[2],
          notes: match[3]
        });
      }
    } else if (section === 'key decisions' && line.startsWith('- ') && !line.startsWith('- [')) {
      keyDecisions.push(line.substring(2).trim());
    } else if (section === 'artifacts' && line.startsWith('- `')) {
      const match = line.match(/^- `(.+)`: (.+)$/);
      if (match) {
        artifacts.push({ path: match[1], description: match[2] });
      }
    } else if (section === 'session history' && line.startsWith('|') && !line.includes('---')) {
      const parts = line.split('|').map(p => p.trim()).filter(p => p);
      if (parts.length >= 7 && parts[0] !== 'Session ID') {
        sessionHistory.push({
          sessionId: parts[0],
          startedAt: parts[1],
          duration: parts[2] === 'ongoing' ? undefined : parseInt(parts[2]),
          stepsCompleted: parseInt(parts[3]),
          inputTokens: parseInt(parts[4]),
          outputTokens: parseInt(parts[5]),
          cacheReadTokens: 0,
          cost: parseFloat(parts[6].replace('$', ''))
        });
      }
    } else if (section === 'blockers' && line.startsWith('- ')) {
      blockers.push(line.substring(2).trim());
    }
  }

  return {
    taskId,
    currentStatus,
    currentStep,
    currentSessionId,
    completedSteps,
    keyDecisions,
    artifacts,
    sessionHistory,
    blockers
  };
}

// ============================================================================
// Task Manager Class
// ============================================================================

export class TaskManager {
  async createTask(goal: string, options?: {
    completionPromise?: string;
    maxIterations?: number;
    thresholdPercent?: number;
    steps?: string[];
    acceptanceCriteria?: string[];
    dependsOn?: string[];
    tags?: string[];
  }): Promise<TaskMetadata> {
    await ensureDir(getTasksDir());
    const taskId = generateTaskId();
    const taskDir = getTaskDir(taskId);
    await ensureDir(taskDir);

    const now = new Date().toISOString();
    const steps: Step[] = (options?.steps || []).map((desc, i) => ({
      id: `step-${i + 1}`,
      description: desc,
      completed: false
    }));

    // Default steps if none provided
    if (steps.length === 0) {
      steps.push({
        id: 'step-1',
        description: 'Complete the task goal',
        completed: false
      });
    }

    const plan: TaskPlan = {
      title: goal.substring(0, 50) + (goal.length > 50 ? '...' : ''),
      goal,
      steps,
      acceptanceCriteria: options?.acceptanceCriteria || ['Task goal is achieved']
    };

    const progress: TaskProgress = {
      taskId,
      currentStatus: 'pending',
      completedSteps: [],
      keyDecisions: [],
      artifacts: [],
      sessionHistory: [],
      blockers: []
    };

    const metadata: TaskMetadata = {
      id: taskId,
      createdAt: now,
      updatedAt: now,
      status: 'pending',
      completionPromise: options?.completionPromise,
      maxIterations: options?.maxIterations,
      thresholdPercent: options?.thresholdPercent,
      totalSessions: 0,
      totalTokens: 0,
      totalCost: 0,
      projectPath: process.cwd(),
      dependsOn: options?.dependsOn,
      tags: options?.tags
    };

    await fs.promises.writeFile(getPlanPath(taskId), serializePlan(plan));
    await fs.promises.writeFile(getProgressPath(taskId), serializeProgress(progress));
    await fs.promises.writeFile(getMetadataPath(taskId), JSON.stringify(metadata, null, 2));

    return metadata;
  }

  async getTask(taskId: string): Promise<{
    metadata: TaskMetadata;
    plan: TaskPlan;
    progress: TaskProgress;
  } | null> {
    const taskDir = getTaskDir(taskId);
    if (!(await fileExists(taskDir))) {
      return null;
    }

    const [metadataRaw, planRaw, progressRaw] = await Promise.all([
      fs.promises.readFile(getMetadataPath(taskId), 'utf-8'),
      fs.promises.readFile(getPlanPath(taskId), 'utf-8'),
      fs.promises.readFile(getProgressPath(taskId), 'utf-8')
    ]);

    return {
      metadata: JSON.parse(metadataRaw),
      plan: parsePlan(planRaw),
      progress: parseProgress(progressRaw)
    };
  }

  async updateMetadata(taskId: string, updates: Partial<TaskMetadata>): Promise<TaskMetadata> {
    const taskDir = getTaskDir(taskId);
    const metadataPath = getMetadataPath(taskId);

    // Use lock for safe concurrent access
    const release = await lockfile.lock(taskDir, { retries: 3 });
    try {
      const metadataRaw = await fs.promises.readFile(metadataPath, 'utf-8');
      const metadata: TaskMetadata = {
        ...JSON.parse(metadataRaw),
        ...updates,
        updatedAt: new Date().toISOString()
      };
      await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
      return metadata;
    } finally {
      await release();
    }
  }

  async updateProgress(taskId: string, updates: Partial<TaskProgress> | ((p: TaskProgress) => TaskProgress)): Promise<TaskProgress> {
    const taskDir = getTaskDir(taskId);
    const progressPath = getProgressPath(taskId);

    const release = await lockfile.lock(taskDir, { retries: 3 });
    try {
      const progressRaw = await fs.promises.readFile(progressPath, 'utf-8');
      let progress = parseProgress(progressRaw);

      if (typeof updates === 'function') {
        progress = updates(progress);
      } else {
        progress = { ...progress, ...updates };
      }

      await fs.promises.writeFile(progressPath, serializeProgress(progress));
      return progress;
    } finally {
      await release();
    }
  }

  async completeStep(taskId: string, stepId: string, notes?: string): Promise<TaskProgress> {
    return this.updateProgress(taskId, (progress) => {
      const existing = progress.completedSteps.find(s => s.stepId === stepId);
      if (!existing) {
        progress.completedSteps.push({
          stepId,
          completedAt: new Date().toISOString(),
          notes
        });
      }
      return progress;
    });
  }

  async addSessionRecord(taskId: string, record: SessionRecord): Promise<TaskProgress> {
    return this.updateProgress(taskId, (progress) => {
      progress.sessionHistory.push(record);
      return progress;
    });
  }

  async listTasks(): Promise<TaskMetadata[]> {
    await ensureDir(getTasksDir());
    const entries = await fs.promises.readdir(getTasksDir(), { withFileTypes: true });
    const tasks: TaskMetadata[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('task-')) {
        const metadataPath = getMetadataPath(entry.name);
        if (await fileExists(metadataPath)) {
          const raw = await fs.promises.readFile(metadataPath, 'utf-8');
          tasks.push(JSON.parse(raw));
        }
      }
    }

    return tasks.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const taskDir = getTaskDir(taskId);
    if (!(await fileExists(taskDir))) {
      return false;
    }
    await fs.promises.rm(taskDir, { recursive: true });
    return true;
  }
}

// Singleton instance
export const taskManager = new TaskManager();
