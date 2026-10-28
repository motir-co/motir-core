import { describe, expect, it } from 'vitest';
import { exampleModels } from '@/lib/billing/modelExamples';

// `exampleModels` — what a Calculator category names as its examples. The bands below
// are cut from motir-ai's live answer of 2026-10-28, cheapest first, as it lists them.

describe('exampleModels', () => {
  it('skips the dated snapshots and variants at the head of a band', () => {
    const flagship = [
      'gpt-4o',
      'gpt-4o-2024-08-06',
      'gpt-4o-2024-11-20',
      'gpt-4o-search-preview',
      'gpt-audio-2025-08-28',
      'gpt-5.4-2026-03-05',
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-4-6',
      'kimi-k3',
      'claude-opus-5-5',
      'kimi-k3.1-pro-highspeed',
      'chat-latest',
      'gpt-6-astra',
      'o1-pro',
    ];
    expect(exampleModels(flagship, 3)).toEqual([
      'claude-opus-5-5',
      'gpt-6-astra',
      'kimi-k3.1-pro-highspeed',
    ]);
  });

  it('keeps one model per family, its highest version, and spans makers', () => {
    const balanced = [
      'gpt-5-mini',
      'qwen3-235b-a22b-thinking-2507',
      'glm-4.7',
      'deepseek-v4-pro',
      'glm-5.2',
      'claude-haiku-4-5-20251001',
      'gpt-6.1-sol',
      'claude-sonnet-5-5',
    ];
    expect(exampleModels(balanced, 3)).toEqual(['claude-sonnet-5-5', 'gpt-6.1-sol', 'glm-5.2']);
  });

  it('counts o-series models as one family with gpt', () => {
    expect(exampleModels(['o3-mini', 'gpt-5.4-mini', 'o4-mini'], 3)).toEqual(['gpt-5.4-mini']);
  });

  it('falls back to the first models when the filter leaves nothing', () => {
    expect(exampleModels(['gpt-4o-2024-08-06', 'gpt-4o-2024-11-20'], 3)).toEqual([
      'gpt-4o-2024-08-06',
      'gpt-4o-2024-11-20',
    ]);
    expect(exampleModels([], 3)).toEqual([]);
  });
});
