// Tests for types and utility functions
import { describe, it, expect } from 'vitest';
import { MODEL_CONTEXT_LIMITS, getModelContextLimit } from '../../../src/types/index.js';

describe('MODEL_CONTEXT_LIMITS', () => {
  it('should have context limits for Claude 4 series', () => {
    expect(MODEL_CONTEXT_LIMITS['claude-opus-4']).toBe(200000);
    expect(MODEL_CONTEXT_LIMITS['claude-sonnet-4']).toBe(200000);
    expect(MODEL_CONTEXT_LIMITS['claude-haiku-4']).toBe(200000);
  });

  it('should have context limits for Claude 3.5 series', () => {
    expect(MODEL_CONTEXT_LIMITS['claude-3-5-sonnet']).toBe(200000);
    expect(MODEL_CONTEXT_LIMITS['claude-3-5-haiku']).toBe(200000);
  });

  it('should have context limits for Claude 3 series', () => {
    expect(MODEL_CONTEXT_LIMITS['claude-3-opus']).toBe(200000);
    expect(MODEL_CONTEXT_LIMITS['claude-3-sonnet']).toBe(200000);
    expect(MODEL_CONTEXT_LIMITS['claude-3-haiku']).toBe(200000);
  });

  it('should have context limits for GLM series', () => {
    expect(MODEL_CONTEXT_LIMITS['glm-5']).toBe(200000);
    expect(MODEL_CONTEXT_LIMITS['glm-4']).toBe(128000);
  });

  it('should have default fallback', () => {
    expect(MODEL_CONTEXT_LIMITS['default']).toBe(200000);
  });
});

describe('getModelContextLimit', () => {
  it('should return exact match for known models', () => {
    expect(getModelContextLimit('claude-opus-4')).toBe(200000);
    expect(getModelContextLimit('claude-3-5-sonnet')).toBe(200000);
    expect(getModelContextLimit('glm-5')).toBe(200000);
    expect(getModelContextLimit('glm-4')).toBe(128000);
  });

  it('should return default for unknown models', () => {
    expect(getModelContextLimit('unknown-model')).toBe(200000);
    expect(getModelContextLimit('random-ai')).toBe(200000);
  });

  it('should handle versioned model names with partial match', () => {
    // These should match via partial matching logic
    expect(getModelContextLimit('claude-opus-4-6-20250519')).toBe(200000);
    expect(getModelContextLimit('claude-3-5-sonnet-20241022')).toBe(200000);
  });

  it('should handle model names with dates', () => {
    expect(getModelContextLimit('claude-3-opus-20240229')).toBe(200000);
    expect(getModelContextLimit('claude-3-haiku-20240307')).toBe(200000);
  });
});
