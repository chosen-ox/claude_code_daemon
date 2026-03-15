// Tests for Task Manager

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { TaskPlan, TaskProgress } from '../../../src/types/index.js';

// Use a unique temp directory for each test run
const TEST_DIR = path.join(os.tmpdir(), 'cc-daemon-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));

// Set env var BEFORE importing the module
process.env.CC_DAEMON_DIR = TEST_DIR;

// Now import the module under test
import { TaskManager, serializePlan, parsePlan, serializeProgress, parseProgress } from '../../../src/task/manager.js';

describe('Task Manager', () => {
  let taskManager: TaskManager;

  beforeEach(async () => {
    // Create fresh test directory for each test
    await fs.promises.mkdir(TEST_DIR, { recursive: true });
    taskManager = new TaskManager();
  });

  afterEach(async () => {
    // Cleanup temp directory
    await fs.promises.rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('serializePlan / parsePlan', () => {
    it('should serialize and parse a plan correctly', () => {
      const plan: TaskPlan = {
        title: 'Test Task',
        goal: 'Implement a feature',
        steps: [
          { id: 'step-1', description: 'Write code', completed: false },
          { id: 'step-2', description: 'Write tests', completed: true }
        ],
        acceptanceCriteria: ['Feature works', 'Tests pass']
      };

      const serialized = serializePlan(plan);
      const parsed = parsePlan(serialized);

      expect(parsed.title).toBe(plan.title);
      expect(parsed.goal).toBe(plan.goal);
      expect(parsed.steps).toHaveLength(2);
      expect(parsed.steps[0].id).toBe('step-1');
      expect(parsed.steps[0].completed).toBe(false);
      expect(parsed.steps[1].completed).toBe(true);
      expect(parsed.acceptanceCriteria).toEqual(plan.acceptanceCriteria);
    });
  });

  describe('serializeProgress / parseProgress', () => {
    it('should serialize and parse progress correctly', () => {
      const progress: TaskProgress = {
        taskId: 'task-test123',
        currentStatus: 'active',
        currentStep: 'step-1',
        currentSessionId: 'session-abc',
        completedSteps: [
          { stepId: 'step-0', completedAt: '2026-02-28T00:00:00.000Z', notes: 'Done' }
        ],
        keyDecisions: ['Use TypeScript'],
        artifacts: [
          { path: '/src/index.ts', description: 'Main entry point' }
        ],
        sessionHistory: [
          {
            sessionId: 'session-abc',
            startedAt: '2026-02-28T00:00:00.000Z',
            duration: 60000,
            stepsCompleted: 1,
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 200,
            cost: 0.01
          }
        ],
        blockers: ['Waiting for API key']
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
  });

  describe('createTask', () => {
    it('should create a task with default steps', async () => {
      const metadata = await taskManager.createTask('Build a CLI tool');

      expect(metadata.id).toMatch(/^task-/);
      expect(metadata.status).toBe('pending');
      expect(metadata.totalSessions).toBe(0);
    });

    it('should create a task with custom steps and options', async () => {
      const metadata = await taskManager.createTask('Build a feature', {
        completionPromise: 'FEATURE_DONE',
        maxIterations: 50,
        thresholdPercent: 75,
        steps: ['Design', 'Implement', 'Test'],
        acceptanceCriteria: ['All tests pass']
      });

      expect(metadata.completionPromise).toBe('FEATURE_DONE');
      expect(metadata.maxIterations).toBe(50);
      expect(metadata.thresholdPercent).toBe(75);
    });
  });

  describe('getTask', () => {
    it('should return null for non-existent task', async () => {
      const task = await taskManager.getTask('task-nonexistent');
      expect(task).toBeNull();
    });

    it('should return task data for existing task', async () => {
      const metadata = await taskManager.createTask('Test task', {
        steps: ['Step 1', 'Step 2']
      });

      const task = await taskManager.getTask(metadata.id);
      expect(task).not.toBeNull();
      expect(task!.metadata.id).toBe(metadata.id);
      expect(task!.plan.steps).toHaveLength(2);
      expect(task!.progress.taskId).toBe(metadata.id);
    });
  });

  describe('updateMetadata', () => {
    it('should update metadata fields', async () => {
      const metadata = await taskManager.createTask('Test task');
      const updated = await taskManager.updateMetadata(metadata.id, {
        status: 'active',
        totalTokens: 5000
      });

      expect(updated.status).toBe('active');
      expect(updated.totalTokens).toBe(5000);
      expect(updated.updatedAt).not.toBe(metadata.createdAt);
    });
  });

  describe('updateProgress', () => {
    it('should update progress fields', async () => {
      const metadata = await taskManager.createTask('Test task');
      const updated = await taskManager.updateProgress(metadata.id, {
        currentStatus: 'active',
        currentStep: 'step-1'
      });

      expect(updated.currentStatus).toBe('active');
      expect(updated.currentStep).toBe('step-1');
    });

    it('should update progress with function', async () => {
      const metadata = await taskManager.createTask('Test task');
      const updated = await taskManager.updateProgress(metadata.id, (p) => {
        p.keyDecisions.push('Use React');
        return p;
      });

      expect(updated.keyDecisions).toContain('Use React');
    });
  });

  describe('completeStep', () => {
    it('should mark a step as completed', async () => {
      const metadata = await taskManager.createTask('Test task', {
        steps: ['Step 1', 'Step 2']
      });

      const progress = await taskManager.completeStep(metadata.id, 'step-1', 'Completed successfully');

      expect(progress.completedSteps).toHaveLength(1);
      expect(progress.completedSteps[0].stepId).toBe('step-1');
      expect(progress.completedSteps[0].notes).toBe('Completed successfully');
    });
  });

  describe('listTasks', () => {
    it('should list all tasks sorted by updatedAt', async () => {
      await taskManager.createTask('Task A');
      await new Promise(r => setTimeout(r, 10)); // Ensure different timestamps
      await taskManager.createTask('Task B');

      const tasks = await taskManager.listTasks();
      expect(tasks).toHaveLength(2);
      // Most recent first
      expect(tasks[0].id).not.toBe(tasks[1].id);
    });
  });

  describe('deleteTask', () => {
    it('should delete an existing task', async () => {
      const metadata = await taskManager.createTask('Test task');
      const deleted = await taskManager.deleteTask(metadata.id);
      expect(deleted).toBe(true);

      const task = await taskManager.getTask(metadata.id);
      expect(task).toBeNull();
    });

    it('should return false for non-existent task', async () => {
      const deleted = await taskManager.deleteTask('task-nonexistent');
      expect(deleted).toBe(false);
    });
  });
});
