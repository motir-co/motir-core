import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OVERLAY_PARAM_NAMES,
  planningOverlaySearch,
  withPlanningOverlay,
  withoutPlanningOverlay,
  parsePlanningOverlay,
  resolvePlanningMode,
  parsePlanningLaunch,
  parsePlanningMode,
  parsePlanningOrigin,
  planningHostPathFor,
  DEFAULT_PLANNING_MODE,
  type PlanningLaunchContext,
} from '@/lib/planning/launcher';

// The "Plan with AI" launcher's context→mode resolution (MOTIR-1299). The pure
// core is the launcher's testable contract (the AC: "Unit tests for the
// context→mode resolution"); the per-surface mounting is covered by each
// surface's E2E.

describe('resolvePlanningMode', () => {
  it('maps a project surface WITH a plan to re-plan/augment (7.11)', () => {
    expect(resolvePlanningMode({ kind: 'project', hasPlan: true })).toBe('replan');
  });

  it('maps a project surface with NO plan yet to generation (7.4)', () => {
    expect(resolvePlanningMode({ kind: 'project', hasPlan: false })).toBe('generation');
  });

  it('maps a project surface with an UNKNOWN plan state to the coarse project mode', () => {
    // The global header pill's case — it does not pay a per-render plan lookup;
    // the workspace seeds generation-vs-augment from the live tree.
    expect(resolvePlanningMode({ kind: 'project' })).toBe('project');
  });

  it('maps a specific work item to contextual planning (7.12)', () => {
    expect(resolvePlanningMode({ kind: 'work-item', itemKey: 'MOTIR-42' })).toBe('contextual');
  });

  it('maps a work item that ALREADY has a plan to re-plan (MOTIR-910)', () => {
    // The per-item entrance's second face: an item with children is being
    // RE-planned, so the workspace opens asking what's wrong — the same
    // hasPlan split the project context makes, one level down.
    expect(resolvePlanningMode({ kind: 'work-item', itemKey: 'MOTIR-5', hasPlan: true })).toBe(
      'replan',
    );
    expect(resolvePlanningMode({ kind: 'work-item', itemKey: 'MOTIR-42', hasPlan: false })).toBe(
      'contextual',
    );
  });

  it('maps the roadmap surface to roadmap-read (7.19)', () => {
    expect(resolvePlanningMode({ kind: 'roadmap' })).toBe('roadmap');
  });
});

// ⚠️ `describe('planningWorkspaceHref')` STOOD HERE and is DELETED with the
// function (MOTIR-4732). It asserted that a door built `/planning?mode=…&from=…`
// — a DESTINATION — and every one of its properties (the resolved mode, the
// origin, the item key only for an item launch, the URLSearchParams encoding)
// is asserted of `planningOverlaySearch` in *the overlay address* below. The
// cases moved; nothing about the launcher's contract went untested.

// ─── The host side (MOTIR-1729) — reading the context back off the URL ────────

/** Parse the query the builder just wrote — the round trip both halves must hold. */
function parseHref(context: PlanningLaunchContext) {
  // The ROUTE-era query shape, built here rather than by a deleted function —
  // because `parsePlanningLaunch` still READS it: the `/planning` forward
  // (MOTIR-4732) is its one remaining caller, and an old bookmark is exactly
  // this address.
  const params = new URLSearchParams({
    mode: resolvePlanningMode(context),
    from: context.kind,
  });
  if (context.kind === 'work-item') params.set('item', context.itemKey);
  return parsePlanningLaunch(Object.fromEntries(params.entries()));
}

describe('parsePlanningLaunch — the ROUTE-era query, still read by the forward', () => {
  it('round-trips a project launch WITH a plan (the established-project door)', () => {
    expect(parseHref({ kind: 'project', hasPlan: true })).toEqual({
      mode: 'replan',
      from: 'project',
      itemKey: null,
    });
  });

  it('round-trips a coarse project launch (mode unresolved at the call site)', () => {
    expect(parseHref({ kind: 'project' })).toEqual({
      mode: 'project',
      from: 'project',
      itemKey: null,
    });
  });

  it('round-trips a work-item launch, carrying the target key', () => {
    expect(parseHref({ kind: 'work-item', itemKey: 'MOTIR-7' })).toEqual({
      mode: 'contextual',
      from: 'work-item',
      itemKey: 'MOTIR-7',
    });
  });

  it('round-trips a RE-PLAN work-item launch — mode and anchor both survive', () => {
    // The entrance's re-plan face (MOTIR-910): the host must see BOTH that this
    // is a re-plan (so the composer asks what's wrong) and WHICH item it anchors
    // at (so the conversation is the item's, not the project's).
    expect(parseHref({ kind: 'work-item', itemKey: 'MOTIR-5', hasPlan: true })).toEqual({
      mode: 'replan',
      from: 'work-item',
      itemKey: 'MOTIR-5',
    });
  });

  it('round-trips a roadmap launch', () => {
    expect(parseHref({ kind: 'roadmap' })).toEqual({
      mode: 'roadmap',
      from: 'roadmap',
      itemKey: null,
    });
  });
});

describe('parsePlanningLaunch — a hand-edited or absent query never errors', () => {
  it('falls back to the project-scoped default when the query is empty', () => {
    expect(parsePlanningLaunch({})).toEqual({
      mode: DEFAULT_PLANNING_MODE,
      from: 'project',
      itemKey: null,
    });
    expect(DEFAULT_PLANNING_MODE).toBe('project');
  });

  it('falls back for an unknown mode / origin rather than throwing', () => {
    expect(parsePlanningMode('teleport')).toBe('project');
    expect(parsePlanningMode(undefined)).toBe('project');
    expect(parsePlanningMode('')).toBe('project');
    expect(parsePlanningOrigin('elsewhere')).toBe('project');
    expect(parsePlanningLaunch({ mode: 'teleport', from: 'elsewhere' })).toEqual({
      mode: 'project',
      from: 'project',
      itemKey: null,
    });
  });

  it('takes the first value when a param is repeated', () => {
    expect(parsePlanningLaunch({ mode: ['roadmap', 'generation'] }).mode).toBe('roadmap');
  });

  it('drops a target the origin did not write (no smuggling into another mode)', () => {
    const launch = parsePlanningLaunch({ mode: 'roadmap', from: 'roadmap', item: 'MOTIR-7' });
    expect(launch.itemKey).toBeNull();
  });
});

// ⚠️ `describe('planningLaunchBackHref')` STOOD HERE and is DELETED with the
// function (MOTIR-4732). It asserted where Close RETURNED to — the item page,
// `/code-health`, `/roadmap` — which an overlay does not need, because closing
// removes four parameters from the address the reader is already at. The
// MAPPING it tested is not lost: it is inlined in `app/(authed)/planning/page.tsx`
// (the forward for an old link) and asserted by that page's own test, where it
// answers the question it is now for — *which page did this old address belong
// to?* rather than *where should Close go?*

describe('the overlay address — the parameter NAMES are the design contract', () => {
  // ⚠️ These four literals are copied from `design/ai-chat/design-notes.md`
  // § *The ADDRESS — a NAMESPACED query, settled here because three cards read
  // it*. They are duplicated here ON PURPOSE: this is the assertion that fails
  // when either home is renamed without the other, which is the whole reason the
  // design records them rather than whichever file was written first.
  // `planSession` joined with MOTIR-6024 (MOTIR-6019's design, §19.8), and `planVia`
  // with MOTIR-6037 (MOTIR-6033's design, Part XXII §22.2), and `planGate` with
  // MOTIR-6210 (MOTIR-6206's design, § *The SEEDED re-plan* → *The ADDRESS*), and
  // `planStart` with MOTIR-7973 (MOTIR-7875's design), `planOffer` with MOTIR-8693,
  // and `planAsk` with MOTIR-10624 (MOTIR-10623's design, § *The planner asks to
  // start planning…* → *Which launches show it*).
  const DESIGN_NAMES = [
    'plan',
    'planFrom',
    'planItem',
    'planSession',
    'planVia',
    'planGate',
    'planStart',
    'planOffer',
    'planAsk',
  ];

  it('emits exactly the names the design records, and no others', () => {
    expect(Object.values(OVERLAY_PARAM_NAMES).sort()).toEqual([...DESIGN_NAMES].sort());
  });

  it('writes the mode on the presence key and the origin beside it', () => {
    const params = planningOverlaySearch({ kind: 'project', hasPlan: true });
    expect(params.get('plan')).toBe('replan');
    expect(params.get('planFrom')).toBe('project');
    expect([...params.keys()]).toEqual(['plan', 'planFrom']);
  });

  it('avoids every measured collision — none of the names is one a host route owns', () => {
    // `?item=` is /roadmap's drilled level (MOTIR-3836), `?peek=` the quick view,
    // `?run=` the run modal, and `?mode=` / `?from=` are the launcher's own
    // route-era names, which the /planning forward still has to read.
    for (const taken of ['item', 'peek', 'run', 'mode', 'from', 'repo', 'scope', 'filter']) {
      expect(Object.values(OVERLAY_PARAM_NAMES)).not.toContain(taken);
    }
  });
});

describe('withPlanningOverlay / withoutPlanningOverlay', () => {
  it("keeps the roadmap's drilled level across the whole round trip", () => {
    const opened = withPlanningOverlay('/roadmap?item=MOTIR-12', { kind: 'project' });
    expect(opened).toContain('item=MOTIR-12');
    expect(opened).toContain('plan=project');
    expect(withoutPlanningOverlay(opened)).toBe('/roadmap?item=MOTIR-12');
  });

  it('keeps the quick view across the whole round trip', () => {
    const opened = withPlanningOverlay('/items?peek=MOTIR-12', {
      kind: 'work-item',
      itemKey: 'MOTIR-12',
    });
    expect(opened).toContain('peek=MOTIR-12');
    expect(opened).toContain('planItem=MOTIR-12');
    expect(withoutPlanningOverlay(opened)).toBe('/items?peek=MOTIR-12');
  });

  it('leaves NO dangling `?` on a bare route', () => {
    const opened = withPlanningOverlay('/backlog', { kind: 'project' });
    expect(opened.startsWith('/backlog?plan=')).toBe(true);
    expect(withoutPlanningOverlay(opened)).toBe('/backlog');
    // …and stripping an href that never had the overlay is a no-op.
    expect(withoutPlanningOverlay('/backlog')).toBe('/backlog');
  });

  it('preserves a multi-parameter host query, order and encoding included', () => {
    const href = '/backlog?filter=type%3Acode&sort=rank&page=3';
    const opened = withPlanningOverlay(href, { kind: 'roadmap' });
    expect(withoutPlanningOverlay(opened)).toBe(href);
  });

  it('preserves a hash fragment on both halves', () => {
    const opened = withPlanningOverlay('/items?peek=MOTIR-9#comments', { kind: 'project' });
    expect(opened.endsWith('#comments')).toBe(true);
    expect(withoutPlanningOverlay(opened)).toBe('/items?peek=MOTIR-9#comments');
  });

  it('REPLACES an open overlay rather than appending a second set', () => {
    const first = withPlanningOverlay('/items?peek=MOTIR-1', {
      kind: 'work-item',
      itemKey: 'MOTIR-1',
    });
    const second = withPlanningOverlay(first, { kind: 'work-item', itemKey: 'MOTIR-2' });
    const params = new URLSearchParams(second.split('?')[1]);
    expect(params.getAll('plan')).toHaveLength(1);
    expect(params.getAll('planItem')).toEqual(['MOTIR-2']);
    expect(withoutPlanningOverlay(second)).toBe('/items?peek=MOTIR-1');
  });

  it('DROPS the stale payload when the new launch is a different origin', () => {
    // Re-targeting from a work-item launch to the project conversation must not
    // leave `planItem` behind — the parse would ignore it, but an address that
    // says one thing and means another is what the next reader debugs.
    const itemLaunch = withPlanningOverlay('/backlog', {
      kind: 'work-item',
      itemKey: 'MOTIR-1',
    });
    const projectLaunch = withPlanningOverlay(itemLaunch, { kind: 'project' });
    expect(projectLaunch).not.toContain('planItem');
  });
});

describe('parsePlanningOverlay', () => {
  it('returns NULL when the overlay is not in the address — the mount predicate', () => {
    expect(parsePlanningOverlay(new URLSearchParams(''))).toBeNull();
    expect(parsePlanningOverlay(new URLSearchParams('item=MOTIR-12&peek=MOTIR-3'))).toBeNull();
    expect(parsePlanningOverlay({ item: 'MOTIR-12' })).toBeNull();
    // The route era's own names do NOT open the overlay — that address is the
    // forward's problem (MOTIR-4732), not the shell's.
    expect(parsePlanningOverlay(new URLSearchParams('mode=project&from=project'))).toBeNull();
  });

  it('round-trips every launch-context variant', () => {
    const contexts: PlanningLaunchContext[] = [
      { kind: 'project' },
      { kind: 'project', hasPlan: true },
      { kind: 'project', hasPlan: false },
      { kind: 'roadmap' },
      { kind: 'work-item', itemKey: 'MOTIR-42' },
      { kind: 'work-item', itemKey: 'MOTIR-42', hasPlan: true },
    ];
    for (const context of contexts) {
      const launch = parsePlanningOverlay(planningOverlaySearch(context));
      expect(launch).not.toBeNull();
      expect(launch!.mode).toBe(resolvePlanningMode(context));
      expect(launch!.from).toBe(context.kind);
      expect(launch!.itemKey).toBe(context.kind === 'work-item' ? context.itemKey : null);
    }
  });

  it('reads a Server Component `searchParams` record as well as URLSearchParams', () => {
    const record = { plan: 'contextual', planFrom: 'work-item', planItem: 'MOTIR-7' };
    expect(parsePlanningOverlay(record)).toEqual({
      mode: 'contextual',
      from: 'work-item',
      itemKey: 'MOTIR-7',
    });
    // Next hands a repeated key through as an array — take the first, as the
    // route-era parser does.
    expect(parsePlanningOverlay({ plan: ['replan', 'project'], planFrom: 'roadmap' })?.mode).toBe(
      'replan',
    );
  });

  it('does NOT let a hand-edited address smuggle a target', () => {
    const smuggled = parsePlanningOverlay(
      new URLSearchParams('plan=roadmap&planFrom=roadmap&planItem=MOTIR-1'),
    );
    expect(smuggled).toEqual({ mode: 'roadmap', from: 'roadmap', itemKey: null });
  });

  it('degrades an unknown mode and an unknown origin to the project defaults', () => {
    expect(parsePlanningOverlay(new URLSearchParams('plan=nonsense&planFrom=nowhere'))).toEqual({
      mode: DEFAULT_PLANNING_MODE,
      from: 'project',
      itemKey: null,
    });
    // A present-but-blank `plan` is an ABSENT overlay, not a defaulted one: a
    // stripped address can leave `?plan=` behind, and opening the workspace on
    // it would be an overlay nobody asked for.
    expect(parsePlanningOverlay(new URLSearchParams('plan='))).toBeNull();
    expect(parsePlanningOverlay(new URLSearchParams('plan=%20%20'))).toBeNull();
  });
});

describe('the ROUTE-era exports are GONE (MOTIR-4732)', () => {
  it('exports none of the trio, and says where each went', () => {
    // A migration is done when the abandoned path is GONE, not when the new one
    // works. This is that assertion: the three exports the doors, the host and
    // the page all used are removed, and the module carries the note a reader
    // meeting an old citation lands on.
    const source = readFileSync(join(process.cwd(), 'lib/planning/launcher.ts'), 'utf8');
    for (const name of [
      'PLANNING_WORKSPACE_PATH',
      'planningWorkspaceHref',
      'planningLaunchBackHref',
    ]) {
      expect(source).not.toMatch(new RegExp(`export (const|function) ${name}\\b`));
      // …and the retirement note names it, so the citation still lands.
      expect(source).toContain(name);
    }
    expect(source).toContain('MOTIR-4732');
  });

  it('stays framework-free — no React and no `server-only` reaches this module', () => {
    const source = readFileSync(join(process.cwd(), 'lib/planning/launcher.ts'), 'utf8');
    expect(source).not.toMatch(/from 'react'/);
    expect(source).not.toMatch(/from 'server-only'/);
    expect(source).not.toMatch(/'use client'/);
  });
});

describe('planVia — the entrance a NAMED session was reopened from (MOTIR-6037, §22.2)', () => {
  it('is written only WITH a named session', () => {
    const withSession = planningOverlaySearch({
      kind: 'work-item',
      itemKey: 'MOTIR-6010',
      sessionId: 's-1',
      via: 'approvals',
    });
    expect(withSession.get('planSession')).toBe('s-1');
    expect(withSession.get('planVia')).toBe('approvals');
    expect(withSession.get('plan')).toBe('contextual');
    // No session → no entrance: it says where THAT session came from.
    const bare = planningOverlaySearch({ kind: 'project', via: 'approvals' });
    expect(bare.has('planVia')).toBe(false);
    expect(planningOverlaySearch({ kind: 'project', sessionId: 's-1' }).has('planVia')).toBe(false);
  });

  it('is read only with planSession, and only its one value', () => {
    expect(
      parsePlanningOverlay(
        new URLSearchParams('plan=project&planFrom=project&planSession=s-1&planVia=approvals'),
      ),
    ).toMatchObject({ sessionId: 's-1', via: 'approvals' });
    // Without a session it is ignored.
    expect(
      parsePlanningOverlay(new URLSearchParams('plan=project&planFrom=project&planVia=approvals')),
    ).not.toHaveProperty('via');
    // Any other value is the Plans page — absent.
    expect(
      parsePlanningOverlay(
        new URLSearchParams('plan=project&planFrom=project&planSession=s-1&planVia=plans'),
      ),
    ).not.toHaveProperty('via');
    // The server-side record form reads the same.
    expect(
      parsePlanningOverlay({
        plan: 'project',
        planFrom: 'project',
        planSession: 's-1',
        planVia: 'approvals',
      }),
    ).toMatchObject({ via: 'approvals' });
  });

  it('Close strips it with the others, and leaves the host query alone', () => {
    const opened = withPlanningOverlay('/workbench?tab=approvals', {
      kind: 'project',
      sessionId: 's-1',
      via: 'approvals',
    });
    expect(opened).toContain('planVia=approvals');
    expect(withoutPlanningOverlay(opened)).toBe('/workbench?tab=approvals');
  });
});

describe('planGate — a REFUSED gate opens the seeded re-plan (MOTIR-6210, §10f)', () => {
  const gate: PlanningLaunchContext = { kind: 'refused-gate', gateId: 'cmg7k2q0' };

  it('resolves to re-plan — a refusal is re-planned by definition', () => {
    expect(resolvePlanningMode(gate)).toBe('replan');
  });

  it('writes plan=replan&planFrom=refused-gate&planGate=<id> and nothing else', () => {
    const params = planningOverlaySearch(gate);
    expect(params.toString()).toBe('plan=replan&planFrom=refused-gate&planGate=cmg7k2q0');
  });

  it('keeps the host page’s own params, and round-trips through the parse', () => {
    const opened = withPlanningOverlay('/items/MOTIR-44?tab=activity&peek=MOTIR-9', gate);
    expect(opened).toContain('tab=activity');
    expect(opened).toContain('peek=MOTIR-9');
    const parsed = parsePlanningOverlay(new URLSearchParams(opened.split('?')[1]));
    expect(parsed).toEqual({
      mode: 'replan',
      from: 'refused-gate',
      itemKey: null,
      gateId: 'cmg7k2q0',
    });
    // The record form a Server Component hands over reads the same.
    expect(
      parsePlanningOverlay({ plan: 'replan', planFrom: 'refused-gate', planGate: 'cmg7k2q0' }),
    ).toMatchObject({ from: 'refused-gate', gateId: 'cmg7k2q0' });
  });

  it('is read ONLY for its own origin, and an origin without it carries none', () => {
    expect(
      parsePlanningOverlay(new URLSearchParams('plan=project&planFrom=project&planGate=g-1')),
    ).not.toHaveProperty('gateId');
    expect(
      parsePlanningOverlay(
        new URLSearchParams('plan=replan&planFrom=work-item&planItem=A-1&planGate=g-1'),
      ),
    ).not.toHaveProperty('gateId');
    expect(
      parsePlanningOverlay(new URLSearchParams('plan=replan&planFrom=refused-gate')),
    ).not.toHaveProperty('gateId');
    // …and no other context writes it.
    expect(planningOverlaySearch({ kind: 'work-item', itemKey: 'A-1' }).has('planGate')).toBe(
      false,
    );
  });

  it('Close strips all EIGHT owned params and leaves the host query byte-identical', () => {
    const host = '/items/MOTIR-44?tab=activity&peek=MOTIR-9';
    const loaded = `${host}&plan=replan&planFrom=refused-gate&planItem=X&planSession=s&planVia=approvals&planGate=g&planReturned=1`;
    expect(withoutPlanningOverlay(loaded)).toBe(host);
    expect(withoutPlanningOverlay(withPlanningOverlay(host, gate))).toBe(host);
  });

  it('carries the gate id and NOTHING else — no reason, no title', () => {
    const params = planningOverlaySearch(gate);
    expect([...params.keys()]).toEqual(['plan', 'planFrom', 'planGate']);
  });
});

describe('the GUIDE address (MOTIR-7466)', () => {
  it('resolves a guide launch to the guide mode', () => {
    expect(resolvePlanningMode({ kind: 'guide', itemKey: 'MOTIR-9' })).toBe('guide');
  });

  it('writes the guided card into the address and reads it back', () => {
    const params = planningOverlaySearch({ kind: 'guide', itemKey: 'MOTIR-9' });
    expect(params.get('plan')).toBe('guide');
    expect(params.get('planFrom')).toBe('guide');
    expect(params.get('planItem')).toBe('MOTIR-9');
    expect(parsePlanningOverlay(params)).toEqual({
      mode: 'guide',
      from: 'guide',
      itemKey: 'MOTIR-9',
    });
  });

  it('opens the guide from a bare plan=guide with a card', () => {
    expect(parsePlanningOverlay(new URLSearchParams('plan=guide&planItem=MOTIR-9'))).toEqual({
      mode: 'guide',
      from: 'guide',
      itemKey: 'MOTIR-9',
    });
  });

  it('degrades a guide address with NO card to the default project mode', () => {
    expect(parsePlanningOverlay(new URLSearchParams('plan=guide&planFrom=guide'))).toEqual({
      mode: 'project',
      from: 'project',
      itemKey: null,
    });
  });
});

describe('planStart — Expand STARTS a conversation on its stub (MOTIR-7973)', () => {
  const start = { kind: 'work-item', itemKey: 'ACME-14', startTurn: true } as const;

  it('writes planStart=1 beside the anchor and keeps the host query byte-identical', () => {
    expect(withPlanningOverlay('/ready?lane=x', start)).toBe(
      '/ready?lane=x&plan=contextual&planFrom=work-item&planItem=ACME-14&planStart=1',
    );
  });

  it('round-trips through the parse', () => {
    expect(parsePlanningOverlay(planningOverlaySearch(start))).toEqual({
      mode: 'contextual',
      from: 'work-item',
      itemKey: 'ACME-14',
      startTurn: true,
    });
  });

  it('is not written beside a named session, nor without startTurn', () => {
    expect(planningOverlaySearch({ ...start, sessionId: 's-1' }).has('planStart')).toBe(false);
    expect(planningOverlaySearch({ kind: 'work-item', itemKey: 'ACME-14' }).has('planStart')).toBe(
      false,
    );
  });

  it('is read only for a work-item origin with an anchor and no planSession', () => {
    for (const qs of [
      'plan=project&planFrom=project&planStart=1',
      'plan=roadmap&planFrom=roadmap&planItem=ACME-14&planStart=1',
      'plan=replan&planFrom=refused-gate&planGate=g&planStart=1',
      'plan=contextual&planFrom=work-item&planStart=1',
      'plan=contextual&planFrom=work-item&planItem=ACME-14&planSession=s-1&planStart=1',
    ]) {
      expect(parsePlanningOverlay(new URLSearchParams(qs))).not.toHaveProperty('startTurn');
    }
  });

  it('is stripped by Close with the rest of the overlay', () => {
    expect(withoutPlanningOverlay(withPlanningOverlay('/ready?lane=x', start))).toBe(
      '/ready?lane=x',
    );
  });
});

describe('planAsk — the Plan / Re-plan button ASKS before starting (MOTIR-10624)', () => {
  const ask = { kind: 'work-item', itemKey: 'ACME-14', confirmStart: true } as const;

  it('writes planAsk=1 beside the anchor and keeps the host query byte-identical', () => {
    expect(withPlanningOverlay('/items?peek=ACME-14', ask)).toBe(
      '/items?peek=ACME-14&plan=contextual&planFrom=work-item&planItem=ACME-14&planAsk=1',
    );
  });

  it('round-trips through the parse, for both faces', () => {
    expect(parsePlanningOverlay(planningOverlaySearch(ask))).toEqual({
      mode: 'contextual',
      from: 'work-item',
      itemKey: 'ACME-14',
      confirmStart: true,
    });
    expect(parsePlanningOverlay(planningOverlaySearch({ ...ask, hasPlan: true }))).toEqual({
      mode: 'replan',
      from: 'work-item',
      itemKey: 'ACME-14',
      confirmStart: true,
    });
  });

  it('is not written beside a named session, beside a start, nor without confirmStart', () => {
    expect(planningOverlaySearch({ ...ask, sessionId: 's-1' }).has('planAsk')).toBe(false);
    const both = planningOverlaySearch({ ...ask, startTurn: true });
    expect(both.has('planAsk')).toBe(false);
    expect(both.get('planStart')).toBe('1');
    expect(planningOverlaySearch({ kind: 'work-item', itemKey: 'ACME-14' }).has('planAsk')).toBe(
      false,
    );
  });

  it('is read only for a work-item origin with an anchor, no planSession and no planStart', () => {
    for (const qs of [
      'plan=project&planFrom=project&planAsk=1',
      'plan=roadmap&planFrom=roadmap&planItem=ACME-14&planAsk=1',
      'plan=replan&planFrom=refused-gate&planGate=g&planAsk=1',
      'plan=contextual&planFrom=guide-offer&planOffer=t1&planAsk=1',
      'plan=contextual&planFrom=work-item&planAsk=1',
      'plan=contextual&planFrom=work-item&planItem=ACME-14&planSession=s-1&planAsk=1',
      'plan=contextual&planFrom=work-item&planItem=ACME-14&planStart=1&planAsk=1',
    ]) {
      expect(parsePlanningOverlay(new URLSearchParams(qs))).not.toHaveProperty('confirmStart');
    }
  });

  it('is stripped by Close with the rest of the overlay', () => {
    expect(withoutPlanningOverlay(withPlanningOverlay('/items?peek=ACME-14', ask))).toBe(
      '/items?peek=ACME-14',
    );
  });
});

describe('planOffer — a GUIDE re-plan offer opens the seeded planner (MOTIR-8693)', () => {
  const offer = { kind: 'guide-offer', guideTurnId: 't1' } as const;

  it('writes plan=contextual&planFrom=guide-offer&planOffer=<turn id> and nothing else', () => {
    expect(planningOverlaySearch(offer).toString()).toBe(
      'plan=contextual&planFrom=guide-offer&planOffer=t1',
    );
    expect(withPlanningOverlay('/items/ACME-31', offer)).toBe(
      '/items/ACME-31?plan=contextual&planFrom=guide-offer&planOffer=t1',
    );
  });

  it('reads the turn id back, and Close strips it', () => {
    const opened = withPlanningOverlay('/items/ACME-31?tab=a', offer);
    const params = new URL(opened, 'http://x').searchParams;
    expect(parsePlanningOverlay(params)).toMatchObject({
      mode: 'contextual',
      from: 'guide-offer',
      guideTurnId: 't1',
      itemKey: null,
    });
    expect(withoutPlanningOverlay(opened)).toBe('/items/ACME-31?tab=a');
  });

  it('is read only for its own origin', () => {
    for (const from of ['project', 'work-item', 'refused-gate', 'roadmap']) {
      const parsed = parsePlanningOverlay(
        new URLSearchParams(`plan=contextual&planFrom=${from}&planOffer=t1`),
      );
      expect(parsed?.guideTurnId).toBeUndefined();
    }
    expect(planningOverlaySearch({ kind: 'work-item', itemKey: 'A-1' }).has('planOffer')).toBe(
      false,
    );
  });

  it('opens over the roadmap when it has no host page', () => {
    expect(planningHostPathFor(offer)).toBe('/roadmap');
  });
});
