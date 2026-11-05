import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { API_MAJOR, GENERATED_AGAINST, V1_OPERATIONS, validators } from '../src/api/index.js';

// The generated v1 client, driven (Story 11.5 · Subtask 11.5.2 — MOTIR-2210).
//
// The freshness guard in `tests/cli/generated-api-freshness.test.ts` proves the
// committed artifact matches the emitter. It does NOT prove the artifact is
// USABLE — a generator can emit a perfectly fresh file that validates nothing,
// or that rejects a legal payload. So this suite round-trips a representative
// response from each of the four shipped resource families through its real
// generated validator, then corrupts one field of each and asserts the failure
// NAMES that field.
//
// That last half is the point. `docs/decisions/cli-v1-client.md` Q1 chose Ajv
// over a zod round-trip specifically because `instancePath` IS the story's
// "a precise error naming the field" criterion. A test that only checked
// `valid === false` would leave that claim unasserted.

/** Ajv's `instancePath`s for a failed validation, as the CLI will read them. */
function failingPaths(validate: (data: unknown) => boolean, payload: unknown): string[] {
  expect(validate(payload)).toBe(false);
  const errors = (validate as { errors?: { instancePath: string }[] | null }).errors ?? [];
  return errors.map((error) => error.instancePath);
}

const WORK_ITEM_DETAIL = {
  key: 'MOTIR-1',
  kind: 'subtask',
  type: 'code',
  title: 'A subtask',
  status: 'todo',
  priority: 'high',
  assigneeId: null,
  reporterId: 'user_1',
  dueDate: null,
  estimateMinutes: 30,
  storyPoints: 2,
  createdAt: '2026-08-05T12:00:00Z',
  updatedAt: '2026-08-05T12:00:00Z',
  // The OBSOLESCENCE mark (MOTIR-6581) — required-and-nullable, `null` on a
  // current card. The marked shape is driven by the tolerance cases below.
  obsolescence: null,
  obsolescenceNoteMd: null,
  descriptionMd: '# Body',
  languages: { title: 'en', description: 'en', explanation: null },
  parentKey: 'MOTIR-2',
  // Story MOTIR-5310 · MOTIR-5412 — the item's OWN folder placement. A subtask
  // under a parent is never filed, so both are null here; the filed shape is
  // driven by `tests/api/v1/work-item-folder-placement-route.test.ts`.
  folderId: null,
  folderPath: null,
  ancestorKeys: ['MOTIR-2'],
  children: [],
  links: {
    blockedBy: [],
    blocks: [],
    relatesTo: [],
    duplicates: [],
    clones: [],
    supersedes: [],
    supersededBy: [],
  },
  readiness: {
    ready: true,
    openBlockers: [],
    // Both halves of the blocked-ancestor projection 11.7 widened the schema
    // with (MOTIR-2236) — the KEY the schema always carried, and the TITLE it
    // used to drop on the floor while `renderReadinessLine` printed it.
    blockedByAncestorKey: null,
    blockedByAncestorTitle: null,
  },
  labels: [],
  components: [],
  commentCount: 0,
  sprintId: null,
  targetRepo: 'motir-core',
  targetRepos: ['motir-core'],
  // Story MOTIR-2732 · MOTIR-3041 — the REFERENCES the two name fields above
  // resolve to. Populated rather than empty here: this fixture is the one that
  // proves the validators accept a REAL body, so an empty array would leave the
  // element shape unexercised.
  targetRepositories: [
    {
      ref: 'cmrepo1',
      name: 'motir-core',
      role: 'web',
      label: null,
      state: 'connected',
      primary: true,
    },
  ],
  executor: 'coding_agent',
  difficulty: null,
  planningSource: 'mcp',
  planningHarness: null,
  planningModel: null,
  implementationSource: null,
  implementationHarness: null,
  implementationModel: null,
  archivedAt: null,
  // The DELIVERY SET (MOTIR-3697). An ARRAY on every work item, never null and
  // never absent — a card with none carries `[]`, which is the ordinary answer
  // and the one this fixture stands for.
  deliveries: [],
};

const PROJECT = {
  key: 'MOTIR',
  name: 'Motir',
  accessLevel: 'open',
  accessMode: 'workspace',
  archived: false,
};

const SPRINT = {
  id: 'sprint_1',
  name: 'Sprint 1',
  goal: null,
  state: 'active',
  startDate: '2026-08-01T00:00:00Z',
  endDate: null,
  completedAt: null,
  sequence: 1,
  issueCount: 4,
  committedPoints: null,
  committedIssueCount: null,
};

const READY_LEAVES = {
  items: [
    {
      key: 'MOTIR-1',
      kind: 'subtask',
      title: 'A subtask',
      priority: 'high',
      status: { key: 'todo', category: 'todo' },
      type: 'code',
      executor: 'coding_agent',
      difficulty: null,
      obsolescence: null,
      obsolescenceNoteMd: null,
      assigneeId: 'user_1',
      // The minimal ACTOR object every v1 collection row embeds (ADR
      // Amendment 8 Q1, MOTIR-2279). `assigneeId` is kept beside it and carries
      // the same value — `renderReadyTable` reads the NAME, and before this
      // field existed it printed "unassigned" for every assigned row.
      assignee: { id: 'user_1', name: 'Zhu Yue' },
      descriptionExcerpt: null,
      inheritedSessionBranch: null,
      dependencies: { blockedBy: [], blocks: [] },
      // The lane row's runnable container (MOTIR-6832) — `null` for a row that
      // stands alone.
      container: null,
    },
  ],
  nextCursor: null,
};

describe('the generated validators accept a real response from each family', () => {
  it('WorkItemDetail — `getWorkItem`', () => {
    expect(validators.operation_getWorkItem(WORK_ITEM_DETAIL)).toBe(true);
  });

  it('Project — `getProject`', () => {
    expect(validators.operation_getProject(PROJECT)).toBe(true);
  });

  it('Sprint — `getSprint`', () => {
    expect(validators.operation_getSprint(SPRINT)).toBe(true);
  });

  it('ReadyLaneItem, inside its PAGE envelope — `getProjectReadyLeaves`', () => {
    // Deliberately the PAGED shape rather than a bare row. The emitter composes
    // it as `allOf: [$ref PageEnvelope, { items: … }]`, so this is the
    // assertion that the generator's "one Ajv instance, everything registered"
    // rule actually resolved the envelope reference — a validator compiled in
    // isolation would have thrown at generation time or passed anything here.
    expect(validators.operation_getProjectReadyLeaves(READY_LEAVES)).toBe(true);
  });
});

describe('a malformed response NAMES the field, rather than blanking a cell', () => {
  it('WorkItemDetail — a renamed `title`', () => {
    // The MCP-era failure mode this replaces: `structuredContent as T` accepted
    // this silently and `render.ts` printed an empty cell.
    const { title: _renamed, ...withoutTitle } = WORK_ITEM_DETAIL;
    expect(failingPaths(validators.operation_getWorkItem, withoutTitle)).toContainEqual('');
    const errors = (validators.operation_getWorkItem as { errors?: { params: unknown }[] | null })
      .errors;
    expect(JSON.stringify(errors)).toContain('title');
  });

  it('Project — a `key` that is not a project key', () => {
    expect(
      failingPaths(validators.operation_getProject, { ...PROJECT, key: 'not a key' }),
    ).toContainEqual('/key');
  });

  it('Sprint — a `state` outside the enum', () => {
    expect(
      failingPaths(validators.operation_getSprint, { ...SPRINT, state: 'paused' }),
    ).toContainEqual('/state');
  });

  it('ReadyItem — a bad field on a row INSIDE the page', () => {
    // The path points into the array, which is what makes the message
    // actionable on a 50-row page rather than merely true.
    const corrupted = {
      ...READY_LEAVES,
      items: [{ ...READY_LEAVES.items[0], priority: 'urgent' }],
    };
    expect(failingPaths(validators.operation_getProjectReadyLeaves, corrupted)).toContainEqual(
      '/items/0/priority',
    );
  });

  it('a MISSING field on a row inside the page is still named', () => {
    // The other half of opening the schemas (MOTIR-6180): tolerating an extra
    // field must not stop a missing one from being reported.
    const { key: _dropped, ...withoutKey } = READY_LEAVES.items[0]!;
    expect(
      failingPaths(validators.operation_getProjectReadyLeaves, {
        ...READY_LEAVES,
        items: [withoutKey],
      }),
    ).toContainEqual('/items/0');
    const errors = (
      validators.operation_getProjectReadyLeaves as { errors?: { params: unknown }[] | null }
    ).errors;
    expect(JSON.stringify(errors)).toContain('"missingProperty":"key"');
  });
});

// A server newer than this client may add fields (MOTIR-6180).
// `public-api-conventions.md` §8 allows a new field on a response object within
// `v1` and says a client MUST tolerate unknown fields. These validators used to be
// compiled closed, so `@motir/cli@0.5.0` rejected every ready-set response once
// `ReadyItem.difficulty` shipped.
describe('a response carrying a field this client does not know is ACCEPTED', () => {
  it('at the root of a resource — `getProject`', () => {
    expect(validators.operation_getProject({ ...PROJECT, surprise: true })).toBe(true);
  });

  it('on a row INSIDE a page — the ready-row failure users hit (0.5.0)', () => {
    const grown = {
      ...READY_LEAVES,
      items: [{ ...READY_LEAVES.items[0], difficulty: null, surprise: 'later field' }],
      surprise: 'on the envelope too',
    };
    expect(validators.operation_getProjectReadyLeaves(grown)).toBe(true);
  });

  it('on nested objects at every depth — `getWorkItem`', () => {
    const grown = {
      ...WORK_ITEM_DETAIL,
      surprise: 1,
      readiness: { ...WORK_ITEM_DETAIL.readiness, surprise: 2 },
      links: { ...WORK_ITEM_DETAIL.links, surprise: 3 },
      targetRepositories: [{ ...WORK_ITEM_DETAIL.targetRepositories[0], surprise: 4 }],
    };
    expect(validators.operation_getWorkItem(grown)).toBe(true);
  });

  // MOTIR-6581 — the OBSOLESCENCE mark, asserted BY NAME rather than trusted to
  // the generic `surprise` cases above: the last additive field (`difficulty`)
  // broke every published client, so this one is proven on the two shapes a CLI
  // reads before it builds on a card — the detail and the ready row.
  it('the obsolescence mark on the DETAIL — `getWorkItem`, set and cleared', () => {
    const marked = {
      ...WORK_ITEM_DETAIL,
      status: 'done',
      obsolescence: 'deprecated',
      obsolescenceNoteMd: 'Overturned by **MOTIR-9**.',
    };
    expect(validators.operation_getWorkItem(marked)).toBe(true);
    expect(
      validators.operation_getWorkItem({ ...marked, obsolescence: null, obsolescenceNoteMd: null }),
    ).toBe(true);
  });

  it('the obsolescence mark on a READY row — `getProjectReadyLeaves`', () => {
    const marked = {
      ...READY_LEAVES,
      items: [
        {
          ...READY_LEAVES.items[0],
          obsolescence: 'outdated',
          obsolescenceNoteMd: 'See the new flow.',
        },
      ],
    };
    expect(validators.operation_getProjectReadyLeaves(marked)).toBe(true);
  });

  it('the obsolescence mark on a COLLECTION row and on the write answers', () => {
    const row = {
      key: 'MOTIR-1',
      kind: 'story',
      type: null,
      title: 'A story',
      status: 'done',
      priority: 'medium',
      assigneeId: null,
      reporterId: 'user_1',
      dueDate: null,
      estimateMinutes: null,
      storyPoints: null,
      createdAt: '2026-08-05T12:00:00Z',
      updatedAt: '2026-08-05T12:00:00Z',
      obsolescence: 'outdated',
      obsolescenceNoteMd: null,
      dependencies: { blockedBy: [], blocks: [] },
    };
    expect(validators.operation_listProjectWorkItems({ items: [row], nextCursor: null })).toBe(
      true,
    );
    const marked = { ...WORK_ITEM_DETAIL, obsolescence: 'outdated', obsolescenceNoteMd: null };
    expect(validators.operation_createWorkItem(marked)).toBe(true);
    expect(validators.operation_updateWorkItem(marked)).toBe(true);
  });

  it('while an obsolescence OUTSIDE the enum is still rejected, naming the field', () => {
    // Proves the shared `WorkItemObsolescence` component the carriers `$ref`
    // actually RESOLVED in the compiled validator, rather than degrading to `{}`.
    expect(
      failingPaths(validators.operation_getWorkItem, {
        ...WORK_ITEM_DETAIL,
        obsolescence: 'stale',
      }),
    ).toContainEqual('/obsolescence');
    expect(
      failingPaths(validators.operation_getProjectReadyLeaves, {
        ...READY_LEAVES,
        items: [{ ...READY_LEAVES.items[0], obsolescence: 'stale' }],
      }),
    ).toContainEqual('/items/0/obsolescence');
  });

  it('while a wrong TYPE on a known field is still rejected', () => {
    expect(
      failingPaths(validators.operation_getSprint, { ...SPRINT, surprise: true, sequence: 'one' }),
    ).toContainEqual('/sequence');
  });

  it('because no generated validator can raise an unknown-field error at all', () => {
    // A source-level guard, so a regenerate cannot quietly close the schemas
    // again. Ajv's standalone code emits `keyword:"additionalProperties"` only for
    // `additionalProperties: false`; a schema-valued one reports its inner
    // keyword instead.
    const source = readFileSync(new URL('../src/api/validators.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/keyword:\s*"additionalProperties"/);
  });
});

describe('the operation table the transport will read', () => {
  it('carries the scope for every operation, so a 403 need not parse prose', () => {
    for (const [id, row] of Object.entries(V1_OPERATIONS)) {
      expect(row.permission, `${id} has no permission`).toBeTruthy();
      expect(row.method).toMatch(/^(GET|POST|PATCH|PUT|DELETE)$/);
      expect(row.path.startsWith('/api/v1/'), `${id}: ${row.path}`).toBe(true);
      expect(row.successStatus).toBeGreaterThanOrEqual(200);
      expect(row.successStatus).toBeLessThan(300);
    }
  });

  it('has a validator for every operation that returns a body, and none for a 204', () => {
    for (const [id, row] of Object.entries(V1_OPERATIONS)) {
      const validator = (validators as Record<string, unknown>)[`operation_${id}`];
      if (row.successStatus === 204) {
        expect(validator, `${id} returns 204 but has a validator`).toBeUndefined();
      } else {
        expect(validator, `${id} returns a body but has no validator`).toBeTypeOf('function');
      }
    }
  });

  it('pins the contract version this client was generated against', () => {
    expect(API_MAJOR).toBe(1);
    expect(GENERATED_AGAINST).toMatch(/^\d+\.\d+\.\d+$/);
    expect(GENERATED_AGAINST.startsWith(`${API_MAJOR}.`)).toBe(true);
  });
});

// THE MODULE IS PURE ESM WITH NO RUNTIME IMPORT (MOTIR-10327). Ajv's standalone output
// `require`s a runtime helper for some keywords — `maxLength` / `minLength` pull in
// `ajv/dist/runtime/ucs2length` — and a `require` in this ES module throws on the first
// load, which took down every hosted-agent command at once. A response schema carries no
// length bound for that reason; this pins it.
describe('validators.js loads as plain ESM', () => {
  it('has no require() call', () => {
    const source = readFileSync(new URL('../src/api/validators.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\brequire\(/);
  });
});
