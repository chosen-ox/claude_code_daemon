// Tests for Auto-Trigger Monitor Session Classification

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AutoTriggerMonitor, type SessionStatus } from '../../../src/session/auto-trigger-monitor.js';

// Mock child_process module
vi.mock('child_process', () => ({
  exec: vi.fn(),
  __esModule: true
}));

import { exec } from 'child_process';
const mockExec = exec as unknown as ReturnType<typeof vi.fn>;

describe('Auto-Trigger Monitor - Session Classification (Rule-Based)', () => {
  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    // Note: mock implementation is set up in classifyWithRules helper
  });

  describe('analyzeWithRules - Completion Detection', () => {
    it('should classify TASK_COMPLETE as completed', () => {
      const status = classifyWithRules(`
Some work output here
More processing
<promise>TASK_COMPLETE</promise>
Task finished successfully
`);
      expect(status.status).toBe('completed');
      expect(status.reason).toBe('Task completion signal detected');
    });

    it('should classify "completed successfully" as completed', () => {
      const status = classifyWithRules(`
All tests passed
Task completed successfully
Validation successful
`);
      expect(status.status).toBe('completed');
      expect(status.reason).toBe('Task completion signal detected');
    });

    it('should prioritize completion detection over other signals', () => {
      const status = classifyWithRules(`
Thinking...
❯
<promise>TASK_COMPLETE</promise>
`);
      expect(status.status).toBe('completed');
    });
  });

  describe('analyzeWithRules - Waiting for Input Detection', () => {
    it('should detect waiting state when prompt ends with ❯', () => {
      const status = classifyWithRules(`
What would you like to do?
❯
`);
      expect(status.status).toBe('stop');
      expect(status.trigger).toBe('continue');
      expect(status.reason).toContain('waiting');
    });

    it('should treat interruption as running (not stop)', () => {
      const status = classifyWithRules(`
Interrupted
The operation was cancelled.
What should Claude do instead?
> `);
      expect(status.status).toBe('running');
      expect(status.reason).toContain('interrupted');
      // No trigger should be present for running state
      expect(status.trigger).toBeUndefined();
    });

    it('should treat interrupted state with simple prompt as running', () => {
      const status = classifyWithRules(`
Interrupted by user
> `);
      expect(status.status).toBe('running');
      expect(status.reason).toContain('interrupted');
      // No trigger should be present for running state
      expect(status.trigger).toBeUndefined();
    });

    it('should generate context-specific triggers for rotation scenarios', () => {
      const status = classifyWithRules(`
ROTATION_SNAPSHOT_COMPLETE
Context: Approaching 80% capacity
❯
`);
      expect(status.status).toBe('stop');
      // Trigger should be generated based on context
      expect(status.trigger).toBeTruthy();
    });

    it('should generate rotation-aware trigger', () => {
      const status = classifyWithRules(`
ROTATION_REQUEST
Writing state to progress.md
❯
`);
      expect(status.status).toBe('stop');
      expect(status.trigger).toContain('continue');
    });
  });

  describe('analyzeWithRules - Active Processing Detection', () => {
    it('should detect "Thinking" state as running', () => {
      const testContent = `
Analyzing the code structure
Thinking about the best approach
Processing...
`;
      console.log('[TEST] Content being tested:', testContent);
      const status = classifyWithRules(testContent);
      expect(status.status).toBe('running');
      expect(status.reason).toContain('processing');
    });

    it('should detect "● " bullet points as running', () => {
      const status = classifyWithRules(`
● Reading file: src/index.ts
● Analyzing dependencies
● Building AST
`);
      expect(status.status).toBe('running');
      expect(status.reason).toContain('processing');
    });

    it('should detect "✓ " checkmarks as running', () => {
      const status = classifyWithRules(`
✓ Loaded configuration
✓ Initialized workspace
✓ Starting task execution
`);
      expect(status.status).toBe('running');
      expect(status.reason).toContain('processing');
    });

    it('should detect "Scampering" as running', () => {
      const status = classifyWithRules(`
Scampering around the codebase
Finding relevant files
`);
      expect(status.status).toBe('running');
      expect(status.reason).toContain('processing');
    });

    it('should detect "Transfiguring" as running', () => {
      const status = classifyWithRules(`
Transfiguring the code structure
Applying transformations
`);
      expect(status.status).toBe('running');
      expect(status.reason).toContain('processing');
    });

    it('should detect "Bootstrapping" as running', () => {
      const status = classifyWithRules(`
Bootstrapping the project
Setting up dependencies
`);
      expect(status.status).toBe('running');
      expect(status.reason).toContain('processing');
    });

    it('should detect "Conjuring" as running', () => {
      const status = classifyWithRules(`
Conjuring up a solution
Creating implementation
`);
      expect(status.status).toBe('running');
      expect(status.reason).toContain('processing');
    });
  });

  describe('analyzeWithRules - Edge Cases', () => {
    it('should default to running when state is unclear', () => {
      const status = classifyWithRules(`
Some output here
More text
Nothing specific
`);
      expect(status.status).toBe('running');
      expect(status.reason).toBe('Unable to determine status, assuming running');
    });

    it('should handle empty output', () => {
      const status = classifyWithRules('');
      expect(status.status).toBe('running');
      expect(status.reason).toBe('Unable to determine status, assuming running');
    });

    it('should handle output with only whitespace', () => {
      const status = classifyWithRules('   \n\n  \t  \n  ');
      expect(status.status).toBe('running');
      expect(status.reason).toBe('Unable to determine status, assuming running');
    });

    it('should handle very long output without clear signals', () => {
      const status = classifyWithRules('x'.repeat(10000));
      expect(status.status).toBe('running');
      expect(status.reason).toBe('Unable to determine status, assuming running');
    });
  });

  describe('Complex Session States', () => {
    it('should handle real session flow: processing -> waiting -> completed', () => {
      // Processing state
      let status = classifyWithRules(`
● Reading task file
Thinking about implementation
✓ Configuration loaded
`);
      expect(status.status).toBe('running');

      // Waiting state
      status = classifyWithRules(`
Ready to proceed
❯
`);
      expect(status.status).toBe('stop');

      // Completed state
      status = classifyWithRules(`
All steps completed
<promise>TASK_COMPLETE</promise>
`);
      expect(status.status).toBe('completed');
    });

    it('should handle session with error followed by prompt', () => {
      const status = classifyWithRules(`
Error: Failed to parse
Please provide valid input
❯
`);
      expect(status.status).toBe('stop');
      expect(status.trigger).toBeTruthy();
    });

    it('should detect rotation context in waiting state', () => {
      const status = classifyWithRules(`
ROTATION_REQUEST
Writing state to progress.md
❯
`);
      expect(status.status).toBe('stop');
    });
  });

  describe('Monitor Lifecycle Tests', () => {
    it('should start and stop monitoring', () => {
      const monitor = new AutoTriggerMonitor({ pollInterval: 100 });

      expect(monitor.isRunning()).toBe(false);

      monitor.start();
      expect(monitor.isRunning()).toBe(true);

      monitor.stop();
      expect(monitor.isRunning()).toBe(false);
    });

    it('should not start if already running', () => {
      const monitor = new AutoTriggerMonitor({ pollInterval: 100 });

      monitor.start();
      expect(monitor.isRunning()).toBe(true);

      // Starting again should be idempotent
      monitor.start();
      expect(monitor.isRunning()).toBe(true);

      monitor.stop();
    });

    it('should return session states', () => {
      const monitor = new AutoTriggerMonitor({ pollInterval: 100 });

      const states = monitor.getSessionStates();
      expect(states).toBeInstanceOf(Map);
      expect(states.size).toBe(0);
    });
  });
});

/**
 * Helper function to test classification using rule-based fallback.
 * Access the private analyzeWithRules method through type casting.
 */
function classifyWithRules(content: string): SessionStatus {
  // Create a monitor instance
  const monitor = new AutoTriggerMonitor({ pollInterval: 1000 });

  // Access private method using type casting
  // @ts-ignore - accessing private method for testing
  return monitor.analyzeWithRules(content);
}
