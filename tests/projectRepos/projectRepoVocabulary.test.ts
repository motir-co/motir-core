import { ProjectRepoRole, ProjectRepoState } from '@/generated/prisma/client';
import { describe, expect, it } from 'vitest';
import {
  ESTABLISHED_PROJECT_REPO_STATES,
  PROJECT_REPO_PROPOSAL_SIGNALS,
  PROJECT_REPO_ROLES,
  PROJECT_REPO_STATES,
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_LEGACY_PLATFORM_STARTER,
  SEED_SOURCE_PLATFORM_STARTER,
  defaultSeedSourceForRole,
  isEstablishedState,
  isProjectRepoProposalSignal,
  isProjectRepoRole,
} from '@/lib/projectRepos/vocabulary';
import {
  PROJECT_REPO_TRANSITIONS,
  allowedTransitions,
  canTransition,
  isSettledState,
} from '@/lib/projectRepos/transitions';
import { toProjectRepoNames, toProjectRepoPinNames } from '@/lib/projectRepos/names';
import type { ProjectRepoWithRealized } from '@/lib/mappers/projectRepoMappers';

// The PURE half of the project repository SET (Story MOTIR-1775 · MOTIR-1780) —
// the ADR's vocabulary, its state machine, and the name-resolution policy. No DB:
// these three modules are where the ADR's decisions are encoded, so they are worth
// pinning independently of any row. The DB-backed half is
// `projectRepoSetService.test.ts`; the tenancy half is `project-repo-rls.test.ts`.

/** A minimal row for the name-resolution tests. */
function row(over: Partial<ProjectRepoWithRealized> = {}): ProjectRepoWithRealized {
  const now = new Date('2026-07-30T00:00:00.000Z');
  return {
    id: 'row-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    role: 'web',
    label: null,
    name: 'acme-web',
    seedSource: SEED_SOURCE_PLATFORM_STARTER,
    state: 'created',
    failureReason: null,
    proposalSignal: null,
    githubRepoId: 'gr-1',
    seedHeadSha: null,
    hostingTarget: null,
    hostingUseCase: null,
    hostingSize: null,
    position: 'a0',
    // The CI-Actions intent (MOTIR-1907) — irrelevant to name resolution, but
    // part of the row's shape, so the fixture carries its default.
    ciActionsDisabled: false,
    ciActionsIntentAt: null,
    ciActionsAppliedAt: null,
    // The TAKE-IT-OVER saga (MOTIR-711) — likewise part of the row's shape and
    // irrelevant to name resolution; null means no handoff was ever requested.
    takeoverState: null,
    takeoverTargetOwner: null,
    takeoverRequestedAt: null,
    takeoverTransferredAt: null,
    takeoverCompletedAt: null,
    takeoverFailureReason: null,
    // The collaborator records (MOTIR-1900, per-member since MOTIR-1910) —
    // likewise part of the shape and irrelevant here: access is orthogonal to
    // which names a row resolves to.
    collaborators: [],
    createdAt: now,
    updatedAt: now,
    githubRepo: {
      // MOTIR-4644's drift columns — part of the row's shape since that card,
      // and absent here only because `tsc --noEmit` does not cover `tests/`.
      commitsBehind: null,
      commitsBehindBaseSha: null,
      commitsBehindHeadSha: null,
      // MOTIR-4593's index pause — part of the shape, irrelevant to name resolution.
      indexPausedReason: null,
      indexPausedAt: null,
      // MOTIR-7129's size refusal — part of the shape, irrelevant to name resolution.
      indexRefusedSizeBytes: null,
      indexRefusedCapBytes: null,
      indexRefusedAt: null,
      id: 'gr-1',
      provider: 'github',
      workspaceId: 'ws-1',
      installationId: 'inst-1',
      repoId: '1',
      owner: 'acme',
      name: 'acme-web',
      defaultBranch: 'main',
      archived: false,
      organizationId: 'org-1',
      defaultBranchHeadSha: null,
      indexedHeadSha: null,
      indexedAt: null,
      indexingRunId: null,
      createdAt: now,
      updatedAt: now,
    },
    ...over,
  };
}

describe('the ADR §1.1 role vocabulary', () => {
  it('is exactly the six values the ADR fixes — no invented values', () => {
    expect(PROJECT_REPO_ROLES).toEqual(['web', 'api', 'mobile', 'shared', 'infra', 'other']);
  });

  it('stays in lockstep with the Prisma enum in BOTH directions', () => {
    // A value added to the schema but not to the vocabulary (or vice versa) is the
    // drift that would let a row exist with a role no code path handles — and it
    // must stay in lockstep with motir-ai's proposal-schema enum (MOTIR-1885) too.
    expect([...PROJECT_REPO_ROLES].sort()).toEqual(Object.values(ProjectRepoRole).sort());
  });
});

describe('the ADR §4.1 state vocabulary', () => {
  it('is exactly the six states the ADR names', () => {
    expect(PROJECT_REPO_STATES).toEqual([
      'proposed',
      'creating',
      'created',
      'connected',
      'skipped',
      'failed',
    ]);
  });

  it('stays in lockstep with the Prisma enum in BOTH directions', () => {
    expect([...PROJECT_REPO_STATES].sort()).toEqual(Object.values(ProjectRepoState).sort());
  });

  it('treats created + connected as ESTABLISHED, and nothing else', () => {
    // "Established" is the ADR §5.3 word for "this row names a repository that
    // exists" — the filter every repo resolution applies. A `skipped` or `failed`
    // row must never be resolvable, or an agent gets sent to a checkout that will
    // never exist.
    expect(ESTABLISHED_PROJECT_REPO_STATES).toEqual(['created', 'connected']);
    expect(isEstablishedState('created')).toBe(true);
    expect(isEstablishedState('connected')).toBe(true);
    for (const state of ['proposed', 'creating', 'skipped', 'failed'] as const) {
      expect(isEstablishedState(state)).toBe(false);
    }
  });
});

describe('the fixed default map (ADR §2 as amended by MOTIR-706 v2, 3.8)', () => {
  it('seeds a web row from the ONE default platform starter, under its renamed key', () => {
    expect(defaultSeedSourceForRole('web')).toBe(SEED_SOURCE_PLATFORM_STARTER);
    expect(SEED_SOURCE_PLATFORM_STARTER).toBe('nextjs-prisma-serverless-starter');
    // The pre-rename key survives only as the registry entry's legacy key.
    expect(SEED_SOURCE_LEGACY_PLATFORM_STARTER).toBe('nextjs-prisma-vercel-starter');
  });

  it('seeds every NON-web role from an initialised repo — the honest fallback', () => {
    // The single starter is a full-stack Next.js web app, so it cannot seed an
    // API-only or shared-package repo, and the multi-stack registry is Epic 9's.
    // The flow says "near-empty" rather than implying a scaffold that does not exist.
    for (const role of ['api', 'mobile', 'shared', 'infra', 'other'] as const) {
      expect(defaultSeedSourceForRole(role)).toBe(SEED_SOURCE_INITIALISED);
    }
  });

  it('gives every role in the vocabulary a default (the map is total)', () => {
    for (const role of PROJECT_REPO_ROLES) {
      expect(defaultSeedSourceForRole(role).length).toBeGreaterThan(0);
    }
  });
});

describe('the role GUARD — what a plan proposal may pin (MOTIR-1912)', () => {
  it('admits every role in the vocabulary', () => {
    for (const role of PROJECT_REPO_ROLES) {
      expect(isProjectRepoRole(role)).toBe(true);
    }
  });

  it('rejects a plausible near-miss, a blank, and a non-string', () => {
    // The values that actually show up: a producer using its own word for a role
    // (`backend` / `frontend`), a blank the JSON carried through, and anything the
    // proposal's untyped JSON can hold. `null` / `undefined` are rejected HERE and
    // interpreted one layer up as "unpinned" — the guard answers "is this a role?",
    // not "is this legal on a proposal?".
    for (const other of [
      'backend',
      'frontend',
      'Web',
      'web ',
      '',
      null,
      undefined,
      0,
      ['web'],
      { role: 'web' },
    ]) {
      expect(isProjectRepoRole(other)).toBe(false);
    }
  });
});

describe('the ADR §0.1 derivation-signal vocabulary (MOTIR-1892)', () => {
  it('is exactly the rungs the ADR names, in ladder order — no invented signals', () => {
    // The persisted column is what the establish step maps to copy, so this list
    // and §0.1 are the same list. A value here the ADR does not name is a rung
    // nobody decided; a rung missing here cannot be recorded at all.
    expect(PROJECT_REPO_PROPOSAL_SIGNALS).toEqual([
      'plan-item-role',
      'preplan-platform',
      'default-web',
    ]);
  });

  it('admits every listed signal and rejects anything else', () => {
    for (const signal of PROJECT_REPO_PROPOSAL_SIGNALS) {
      expect(isProjectRepoProposalSignal(signal)).toBe(true);
    }
    // Absence is legal at the COLUMN (a user-added row records null) but is not a
    // signal, so the guard itself must say no — the service is what maps
    // null/undefined to "no inference".
    for (const other of ['', 'vibes', 'plan_item_role', 'PLAN-ITEM-ROLE', null, undefined, 0]) {
      expect(isProjectRepoProposalSignal(other)).toBe(false);
    }
  });
});

describe('the ADR §4.1 establish machine — the edges it PERMITS', () => {
  it('lets a proposed row start creating, connect an existing repo, or be skipped', () => {
    expect(canTransition('proposed', 'creating')).toBe(true);
    expect(canTransition('proposed', 'connected')).toBe(true);
    expect(canTransition('proposed', 'skipped')).toBe(true);
  });

  it('lets a creating row land or error', () => {
    expect(canTransition('creating', 'created')).toBe(true);
    expect(canTransition('creating', 'failed')).toBe(true);
  });

  it('makes failed RESUMABLE, not terminal — retry, connect, or skip', () => {
    // ADR §4.1: "`failed` is resumable, not terminal": a failed row can be retried,
    // switched to connect-existing, or skipped, at any later visit to the step.
    expect(canTransition('failed', 'creating')).toBe(true);
    expect(canTransition('failed', 'connected')).toBe(true);
    expect(canTransition('failed', 'skipped')).toBe(true);
    expect(isSettledState('failed')).toBe(false);
  });
});

describe('the ADR §4.1 establish machine — the edges it REJECTS', () => {
  it('refuses to skip the creating step (proposed → created is not an edge)', () => {
    expect(canTransition('proposed', 'created')).toBe(false);
    expect(canTransition('proposed', 'failed')).toBe(false);
  });

  it('treats created / connected / skipped as SETTLED — no outgoing edge at all', () => {
    // Changing one's mind about a settled row is a REMOVE-and-re-add, so "this repo
    // was created" is never quietly overwritten by "actually, skip it". Widening
    // this is an ADR change, which is what this assertion protects.
    for (const settled of ['created', 'connected', 'skipped'] as const) {
      expect(isSettledState(settled)).toBe(true);
      expect(allowedTransitions(settled)).toEqual([]);
      for (const target of PROJECT_REPO_STATES) {
        expect(canTransition(settled, target)).toBe(false);
      }
    }
  });

  it('rejects every self-transition', () => {
    for (const state of PROJECT_REPO_STATES) {
      expect(canTransition(state, state)).toBe(false);
    }
  });

  it('declares edges for EVERY state (the table is total) and names only real states', () => {
    // A state with no entry would be silently unreachable; a target outside the
    // vocabulary would be a typo the type system cannot see through a string.
    expect(Object.keys(PROJECT_REPO_TRANSITIONS).sort()).toEqual([...PROJECT_REPO_STATES].sort());
    for (const targets of Object.values(PROJECT_REPO_TRANSITIONS)) {
      for (const target of targets) {
        expect(PROJECT_REPO_STATES).toContain(target);
      }
    }
  });

  it('reaches every non-initial state from `proposed`, so none is orphaned', () => {
    // A breadth-first walk from the only state a row is created in. If a state were
    // unreachable, the machine would declare a lifecycle a row can never enter.
    const seen = new Set<ProjectRepoState>(['proposed']);
    const queue: ProjectRepoState[] = ['proposed'];
    while (queue.length > 0) {
      for (const next of PROJECT_REPO_TRANSITIONS[queue.shift()!]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...PROJECT_REPO_STATES].sort());
  });
});

describe('toProjectRepoNames — which rows a dispatch may be pinned to', () => {
  it('returns established rows in SET ORDER, primary first', () => {
    const names = toProjectRepoNames([
      row({ id: 'r1', position: 'a0', name: 'acme-web', role: 'web' }),
      row({
        id: 'r2',
        position: 'a1',
        role: 'api',
        name: 'acme-api',
        githubRepoId: 'gr-2',
        githubRepo: { ...row().githubRepo!, id: 'gr-2', name: 'acme-api' },
      }),
    ]);
    expect(names.map((n) => n.name)).toEqual(['acme-web', 'acme-api']);
    expect(names.map((n) => n.role)).toEqual(['web', 'api']);
    expect(names[0]!.repoRef).toBe('acme/acme-web');
    expect(names[0]!.rowId).toBe('r1');
  });

  it('EXCLUDES every unestablished row — proposed, creating, skipped, failed', () => {
    // Each of these names no checkout that exists. Pinning an item to one would send
    // an agent's cwd into a directory that will never exist, which
    // docs/decisions/target-repo-attribution.md §3 establishes is strictly worse
    // than no answer. This is ADR §5.3's "no established row → targetRepo null".
    for (const state of ['proposed', 'creating', 'skipped', 'failed'] as const) {
      expect(toProjectRepoNames([row({ state })])).toEqual([]);
    }
  });

  it('EXCLUDES a settled row whose realized repo has since been disconnected', () => {
    // The plan survives (role + name + seed source are intact — a disconnected repo
    // is not a lost plan), but the repository does not exist in Motir's mirror any
    // more, so it is not a name a dispatch may resolve to.
    expect(
      toProjectRepoNames([row({ state: 'created', githubRepoId: null, githubRepo: null })]),
    ).toEqual([]);
  });

  it("uses the REALIZED repo's name, not the row's authored intent", () => {
    // The host's name is what `work_item.targetRepo` stores and what the CLI keys
    // `<root>/<name>` on. Once someone renames the repo on the host the two differ,
    // and handing out the stale intent would name a checkout nothing answers to.
    const names = toProjectRepoNames([
      row({
        name: 'acme-web',
        githubRepo: { ...row().githubRepo!, name: 'acme-frontend', owner: 'acme' },
      }),
    ]);
    expect(names.map((n) => n.name)).toEqual(['acme-frontend']);
    expect(names[0]!.repoRef).toBe('acme/acme-frontend');
  });

  it('de-duplicates by name case-insensitively, first in set order winning', () => {
    // Same rule (and reason) as `listConnectedRepoNames`: two names differing only
    // in case are ONE checkout identity as far as dispatch is concerned.
    const names = toProjectRepoNames([
      row({ id: 'r1', position: 'a0', githubRepo: { ...row().githubRepo!, name: 'acme-web' } }),
      row({
        id: 'r2',
        position: 'a1',
        name: 'other',
        githubRepoId: 'gr-2',
        githubRepo: { ...row().githubRepo!, id: 'gr-2', name: 'ACME-Web' },
      }),
    ]);
    expect(names).toHaveLength(1);
    expect(names[0]!.rowId).toBe('r1');
  });

  it('carries role + label so a caller can detect a REPEATED role', () => {
    // ADR §1.2 lets a role repeat (two services are two `api` rows) and §5.3 says an
    // ambiguous role must resolve to null rather than to an arbitrary row — which a
    // caller can only see if each name says which row and role it came from.
    const names = toProjectRepoNames([
      row({
        id: 'r1',
        position: 'a0',
        role: 'api',
        label: 'billing',
        githubRepo: { ...row().githubRepo!, name: 'acme-api-billing' },
      }),
      row({
        id: 'r2',
        position: 'a1',
        role: 'api',
        label: 'search',
        name: 'acme-api-search',
        githubRepoId: 'gr-2',
        githubRepo: { ...row().githubRepo!, id: 'gr-2', name: 'acme-api-search' },
      }),
    ]);
    expect(names.filter((n) => n.role === 'api')).toHaveLength(2);
    expect(names.map((n) => n.label)).toEqual(['billing', 'search']);
  });

  it('is empty for an empty set', () => {
    expect(toProjectRepoNames([])).toEqual([]);
  });
});

describe('toProjectRepoPinNames — which rows an AUTHORED pin may name', () => {
  // The sibling domain, and the asymmetry between the two is the whole point:
  // authoring records a decision about work that has not run (the plan names
  // repositories before they exist), while dispatch names a checkout that has to
  // exist right now. Reached only through the DB-backed suites until now, which
  // left its own branches — the unrealized ref, the null coordinates, the
  // case-insensitive dedup, the unnameable row — untested directly.

  it('INCLUDES an unrealized row — the plan pins before the repository exists', () => {
    // The ordinary onboarding case: "this subtask ships in the api repo we are
    // about to create." Rejecting it would make the pin unusable exactly when the
    // planner emits it.
    const names = toProjectRepoPinNames([
      row({ state: 'proposed', name: 'acme-api', githubRepoId: null, githubRepo: null }),
    ]);
    expect(names.map((n) => n.name)).toEqual(['acme-api']);
  });

  it('carries NO coordinates for an unrealized row, and the ref IS the name', () => {
    // There is no host casing to prefer and no clone URL to know, so the domain
    // says so rather than inventing either — a pin resolved through it can never
    // claim to know where something lives that does not.
    const [name] = toProjectRepoPinNames([
      row({ state: 'proposed', name: 'acme-api', githubRepoId: null, githubRepo: null }),
    ]);
    expect(name).toMatchObject({
      repoRef: 'acme-api',
      cloneUrl: null,
      defaultBranch: null,
      archived: false,
      role: 'web',
    });
  });

  it("prefers the REALIZED repo's name and coordinates once the row is real", () => {
    const [name] = toProjectRepoPinNames([
      row({
        name: 'acme-web',
        githubRepo: { ...row().githubRepo!, name: 'acme-frontend', owner: 'acme' },
      }),
    ]);
    expect(name).toMatchObject({ name: 'acme-frontend', repoRef: 'acme/acme-frontend' });
    expect(name!.cloneUrl).toContain('acme/acme-frontend');
  });

  it('admits EVERY state — a skipped or failed row is still a name a plan may have pinned', () => {
    for (const state of [
      'proposed',
      'creating',
      'created',
      'connected',
      'skipped',
      'failed',
    ] as const) {
      expect(
        toProjectRepoPinNames([
          row({ state, name: 'acme-api', githubRepoId: null, githubRepo: null }),
        ]).map((n) => n.name),
      ).toEqual(['acme-api']);
    }
  });

  it('de-duplicates by name case-insensitively, first in set order winning', () => {
    const names = toProjectRepoPinNames([
      row({ id: 'r1', position: 'a0', name: 'acme-web', githubRepoId: null, githubRepo: null }),
      row({ id: 'r2', position: 'a1', name: 'ACME-Web', githubRepoId: null, githubRepo: null }),
    ]);
    expect(names).toHaveLength(1);
    expect(names[0]!.rowId).toBe('r1');
  });

  it('DROPS a row whose name normalizes to nothing rather than emitting a blank pin', () => {
    // A blank name is "unpinned" everywhere else in the system; emitting it here
    // would put an empty string in the domain a pin is validated against.
    expect(
      toProjectRepoPinNames([row({ name: '  ', githubRepoId: null, githubRepo: null })]),
    ).toEqual([]);
  });

  it('is empty for an empty set', () => {
    expect(toProjectRepoPinNames([])).toEqual([]);
  });
});
