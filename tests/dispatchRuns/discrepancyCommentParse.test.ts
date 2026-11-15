import { describe, expect, it } from 'vitest';
import type { RunDiscrepancyEntry } from '@/generated/prisma/client';
import {
  composeDiscrepancyComment,
  DISCREPANCY_COMMENT_HEADERS,
  parseDiscrepancyComment,
  type RunDecisionPoint,
  type RunDiscrepancyPoint,
} from '@/lib/dispatchRuns/discrepancyComment';
import { fromEntries, toEntryInputs } from '@/lib/dispatchRuns/discrepancyRecord';

// The discrepancy comment's INVERSE (Task MOTIR-11361) — what the backfill reads a
// record written before `run_discrepancy_record` back out of. Pure: compose, parse,
// and assert the round trip, plus the bodies it must refuse rather than half-read.

const P1: RunDiscrepancyPoint = {
  planAsked: 'call fooBar()',
  built: 'called bazQux()',
  why: 'retired',
};
const P2: RunDiscrepancyPoint = {
  planAsked: 'multi\nline ask',
  built: 'a value with **bold** and - **Built:** inside',
  why: 'line one\n\nline three after a blank',
};
const D1: RunDecisionPoint = { planSaid: 'nothing', chose: 'Postgres', why: 'convention' };
const D2: RunDecisionPoint = {
  planSaid: 'silent',
  chose: 'two tables',
  why: 'best practice',
  alternatives: 'one JSON column',
};

describe('parseDiscrepancyComment', () => {
  it.each([
    ['one point', [P1], []],
    ['several points with newlines and look-alike labels', [P1, P2], []],
    ['decisions only, one with alternatives', [], [D1, D2]],
    ['points and decisions', [P1, P2], [D2, D1]],
  ] as const)('round-trips %s', (_label, points, decisions) => {
    const body = composeDiscrepancyComment(points, decisions);
    expect(parseDiscrepancyComment(body)).toEqual({ points, decisions });
  });

  it('round-trips the maximum: twenty points and twenty decisions', () => {
    const points = Array.from({ length: 20 }, (_, i) => ({ ...P1, why: `why ${i}` }));
    const decisions = Array.from({ length: 20 }, (_, i) => ({ ...D2, chose: `chose ${i}` }));
    const body = composeDiscrepancyComment(points, decisions);
    expect(parseDiscrepancyComment(body)).toEqual({ points, decisions });
  });

  // An edit that only appends text reads as part of the last field — it is still a
  // record in the composer's shape, so it is accepted; the cases below are not.
  it('refuses a body that is not a record, or was edited out of its shape', () => {
    const body = composeDiscrepancyComment([P1, P2], [D1]);
    for (const bad of [
      '',
      'a human comment',
      `> ${body}`,
      body.replace('**2.**', '**3.**'),
      body.replace('- **Built:** ', '- **Made:** '),
      body.replace(' — 2 discrepancies', ' — 3 discrepancies'),
      body.replace('- **Plan said:** ', ''),
      DISCREPANCY_COMMENT_HEADERS[0]! + ' — 0 discrepancies. text',
      DISCREPANCY_COMMENT_HEADERS[1]! + ' — 1 decision, x\n\n**1.**\n- **Plan said:** a',
    ]) {
      expect(parseDiscrepancyComment(bad), JSON.stringify(bad.slice(0, 60))).toBeNull();
    }
  });

  it('both headers are the lines the composer starts a comment with', () => {
    expect(composeDiscrepancyComment([P1]).startsWith(DISCREPANCY_COMMENT_HEADERS[0]!)).toBe(true);
    expect(composeDiscrepancyComment([], [D1]).startsWith(DISCREPANCY_COMMENT_HEADERS[1]!)).toBe(
      true,
    );
  });
});

describe('the entry mapping', () => {
  it('stores each kind numbered from 1 and reads it back in the order sent', () => {
    const inputs = toEntryInputs([P1, P2], [D2, D1]);
    expect(inputs.map((e) => [e.kind, e.position])).toEqual([
      ['point', 1],
      ['point', 2],
      ['decision', 1],
      ['decision', 2],
    ]);
    expect(inputs[2]).toMatchObject({
      planText: 'silent',
      outcomeText: 'two tables',
      alternatives: 'one JSON column',
    });
    expect(inputs[3]!.alternatives).toBeNull();
    // Stored rows come back in any order; the mapping restores the run's.
    const rows = inputs
      .map((e, i) => ({ ...e, id: `e${i}`, workspaceId: 'w', recordId: 'r' }))
      .reverse() as RunDiscrepancyEntry[];
    expect(fromEntries(rows)).toEqual({ points: [P1, P2], decisions: [D2, D1] });
  });
});
