import { describe, expect, it, expectTypeOf } from 'vitest';

import {
  planRowDestination,
  planSessionLaunchContext,
  type PlanRowDestination,
  type PlanRowDestinationInput,
} from '@/lib/planning/planDestination';
import { PLAN_STATUS_DTO_VALUES, type PlanStatusDto } from '@/lib/dto/plans';
import { readerRoutes } from '@/lib/visitor/routes';

// WHERE A PLAN'S ROW GOES — the one rule both lists call (Story MOTIR-6043 ·
// MOTIR-6045; design Part XXI, ADR `approval-gates.md` §11.5b).
//
// The table below is the whole contract: `PlanStatus` × session-present, every
// cell named. It is enumerated from `PLAN_STATUS_DTO_VALUES` rather than written
// out, so a sixth status fails HERE as well as at the compiler.

const HOST = '/plans?planState=planned';

function call(over: Partial<PlanRowDestinationInput> = {}): PlanRowDestination {
  return planRowDestination({
    planStatus: 'planned',
    planId: 'p_31',
    sessionId: 's_1',
    host: HOST,
    anchorKey: 'MOTIR-812',
    ...over,
  });
}

// `approving` (Bug MOTIR-9006) is undecided: the overlay draws its progress until it commits.
const UNDECIDED = [
  'generating',
  'planned',
  'approving',
  'stale',
] as const satisfies readonly PlanStatusDto[];
const DECIDED = ['approved', 'declined'] as const satisfies readonly PlanStatusDto[];

describe('the rule is TOTAL over PlanStatus', () => {
  it('answers every member of the enum, with a session and without one', () => {
    for (const planStatus of PLAN_STATUS_DTO_VALUES) {
      expect(call({ planStatus }).kind).toBeTypeOf('string');
      expect(call({ planStatus, sessionId: null }).kind).toBeTypeOf('string');
    }
  });

  it('the two arms PARTITION the enum — no status is in both, none is in neither', () => {
    expect([...UNDECIDED, ...DECIDED].toSorted()).toEqual([...PLAN_STATUS_DTO_VALUES].toSorted());
  });

  // The type-level half. `planRowDestination` has no `default` arm, so a sixth
  // `PlanStatusDto` member makes its switch non-exhaustive and the return type
  // widens to include `undefined` — which this assertion catches at build time,
  // before any runtime test gets the chance to be written for it.
  it('never returns undefined — the switch is exhaustive by construction', () => {
    expectTypeOf(planRowDestination).returns.toEqualTypeOf<PlanRowDestination>();
  });
});

describe('UNDECIDED with a session → the planning surface', () => {
  it.each(UNDECIDED)('%s opens the overlay over the host page, at that session', (planStatus) => {
    const destination = call({ planStatus });
    expect(destination.kind).toBe('planning-surface');
    const href = new URL(destination.href, 'http://x');
    expect(href.pathname).toBe('/plans');
    // The host's own parameters survive — Close returns to this exact list.
    expect(href.searchParams.get('planState')).toBe('planned');
    expect(href.searchParams.get('planSession')).toBe('s_1');
    expect(href.searchParams.get('planItem')).toBe('MOTIR-812');
  });

  it('a session with no anchor opens the PROJECT overlay', () => {
    const destination = call({ anchorKey: null });
    const href = new URL(destination.href, 'http://x');
    expect(href.searchParams.get('planFrom')).toBe('project');
    expect(href.searchParams.get('planSession')).toBe('s_1');
    expect(href.searchParams.has('planItem')).toBe(false);
  });

  it('`via` rides the address, and only when given', () => {
    expect(new URL(call({ via: 'approvals' }).href, 'http://x').searchParams.get('planVia')).toBe(
      'approvals',
    );
    expect(new URL(call().href, 'http://x').searchParams.has('planVia')).toBe(false);
  });
});

describe('DECIDED → the plan page, reason `decided`', () => {
  it.each(DECIDED)('%s opens /plans/<id> whatever its session holds', (planStatus) => {
    for (const sessionId of ['s_1', null]) {
      const destination = call({ planStatus, sessionId });
      expect(destination).toEqual({ kind: 'plan-page', href: '/plans/p_31', reason: 'decided' });
    }
  });
});

// ⚠️ RETIRED 2026-10-08 by Story MOTIR-7883 (MOTIR-7885): this arm answered
// `no-conversation`, and two renderers explained it. Every plan has a session now,
// so a null one is an invariant breach that degrades to the page with no copy.
describe('UNDECIDED with NO session → the plan page, reason `no-session` (invariant breach, no copy)', () => {
  it.each(UNDECIDED)('%s with a null session degrades to the page', (planStatus) => {
    expect(call({ planStatus, sessionId: null })).toEqual({
      kind: 'plan-page',
      href: '/plans/p_31',
      reason: 'no-session',
    });
  });

  it('the plan id is encoded, so an id with a slash cannot escape the path', () => {
    const destination = call({ sessionId: null, planId: 'p/31' });
    expect(destination.href).toBe('/plans/p%2F31');
  });
});

// ⚠️ THE SETTLEMENT, asserted as an ABSENCE (Story MOTIR-6043's *SETTLED*
// section). The two readings this rule rejected — the session's ORIGIN and its
// TURN COUNT — are not merely unused: they cannot be supplied. A test that
// asserted "a cadence session still opens the surface" would pass vacuously
// forever; the load-bearing statement is that the input type has nowhere to put
// one, so a future reader cannot reintroduce either without changing this file.
describe('neither the session ORIGIN nor its TURN COUNT is an input', () => {
  it('the input type carries exactly the facts the rule reads', () => {
    // `routes` (MOTIR-6888) is WHO is reading — a Visitor lands on the plan page —
    // never a fact about the session.
    expectTypeOf<keyof PlanRowDestinationInput>().toEqualTypeOf<
      'planStatus' | 'planId' | 'sessionId' | 'host' | 'anchorKey' | 'via' | 'routes'
    >();
  });
});

describe('a Visitor’s row lands on the plan’s Visitor page (MOTIR-6888)', () => {
  it('every status, with a session or without, is the Visitor plan page — never the planning surface', () => {
    const routes = readerRoutes('ACME');
    for (const planStatus of PLAN_STATUS_DTO_VALUES) {
      for (const sessionId of ['s_1', null]) {
        expect(call({ planStatus, sessionId, routes })).toEqual({
          kind: 'plan-page',
          href: '/p/ACME/plans/p_31',
          reason: 'visitor',
        });
      }
    }
  });

  it('a member’s routes change nothing', () => {
    for (const planStatus of PLAN_STATUS_DTO_VALUES) {
      for (const sessionId of ['s_1', null]) {
        expect(call({ planStatus, sessionId, routes: readerRoutes(null) })).toEqual(
          call({ planStatus, sessionId }),
        );
      }
    }
  });
});

describe('planSessionLaunchContext — the one session→context mapping (MOTIR-7884)', () => {
  it('anchors at the first key, else opens project-wide; `via` rides only when given', () => {
    expect(planSessionLaunchContext('s_1', 'MOTIR-812', undefined)).toEqual({
      kind: 'work-item',
      itemKey: 'MOTIR-812',
      sessionId: 's_1',
    });
    expect(planSessionLaunchContext('s_1', null, undefined)).toEqual({
      kind: 'project',
      sessionId: 's_1',
    });
    expect(planSessionLaunchContext('s_1', undefined, 'approvals')).toEqual({
      kind: 'project',
      sessionId: 's_1',
      via: 'approvals',
    });
    expect(planSessionLaunchContext('s_1', 'MOTIR-812', 'approvals')).toEqual({
      kind: 'work-item',
      itemKey: 'MOTIR-812',
      sessionId: 's_1',
      via: 'approvals',
    });
  });
});
