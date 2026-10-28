import { describe, expect, it } from 'vitest';
import {
  AGENT_STATES_IN_MOTION,
  AGENT_STATE_TONE,
  allowedAgentMoves,
  formatMachineTime,
} from '@/lib/agentInstances/presentation';
import { refusalKey } from '@/app/(authed)/my-agents/_components/agentRefusal';

// The My agents page's pure decisions (Story MOTIR-6860 · MOTIR-6874), held to
// `design/my-agents/design-notes.md` panels 3–5.

describe('the row menu offers exactly the moves §4 allows', () => {
  it.each([
    ['running', ['delete', 'hibernate']],
    ['hibernated', ['delete', 'wake']],
    ['failed', ['delete', 'wake']],
    // AMENDMENT 4 (MOTIR-7341): a boot or a stop that never settles is deletable.
    ['starting', ['delete']],
    ['hibernating', ['delete']],
    ['waking', ['delete']],
    ['deleting', []],
    ['updating', []],
  ] as const)('%s → %j', (state, moves) => {
    expect([...allowedAgentMoves(state)].sort()).toEqual([...moves]);
  });
});

describe('the tones reuse the run vocabulary', () => {
  it('maps every state, with failed the only danger tone', () => {
    expect(AGENT_STATE_TONE).toEqual({
      starting: 'running',
      running: 'implemented',
      hibernating: 'queued',
      hibernated: 'cancelled',
      waking: 'running',
      failed: 'failed',
      deleting: 'queued',
      updating: 'running',
    });
    expect([...AGENT_STATES_IN_MOTION].sort()).toEqual([
      'deleting',
      'hibernating',
      'starting',
      'updating',
      'waking',
    ]);
  });
});

describe('machine time', () => {
  it.each([
    [0, '0m'],
    [59, '0m'],
    [38 * 60, '38m'],
    [72 * 60, '1h 12m'],
    [123 * 60 + 30, '2h 03m'],
    [12 * 3600, '12h 00m'],
  ])('%d s → %s', (seconds, text) => {
    expect(formatMachineTime(seconds)).toBe(text);
  });
});

describe('every refusal maps to the design’s copy', () => {
  it.each([
    [{ reason: 'ai_plan_required' }, 'aiPlanRequired'],
    [{ reason: 'ai_plan_unknown' }, 'aiPlanUnknown'],
    [{ reason: 'credits' }, 'credits'],
    [{ reason: 'credits_unknown' }, 'creditsUnknown'],
    [{ reason: 'user_cap' }, 'userCap'],
    [{ reason: 'org_cap', limit: 50 }, 'orgCap'],
    [{ reason: 'fleet_busy' }, 'busy'],
    [{ code: 'agent_instance_name_taken' }, 'nameTaken'],
    [{ code: 'agent_instance_name_invalid' }, 'nameInvalid'],
    [{ code: 'agent_profile_not_offered' }, 'notOffered'],
    [{ code: 'agent_instances_unavailable' }, 'unavailable'],
    [{ code: 'agent_instance_state_conflict' }, 'conflict'],
    [{ code: 'agent_instance_not_found' }, 'conflict'],
    [{ code: 'something_else' }, 'generic'],
    [null, 'generic'],
  ])('%j → %s', (body, key) => {
    expect(refusalKey(body)).toBe(key);
  });
});
