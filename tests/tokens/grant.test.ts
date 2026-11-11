import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_PUBLISH_PERMISSION,
  DEFAULT_TOKEN_GRANT,
  GRANTABLE_PERMISSIONS,
  grantableFor,
  IRREVERSIBLE_PERMISSIONS,
  UNGRANTABLE_PERMISSIONS,
  V1_ONLY_PERMISSIONS,
  RECORD_VIEW_PERMISSIONS,
  expandStoredGrant,
  grantAllows,
  grantsIrreversible,
  isGrantable,
  ROOM_VIEW_FORWARD_KEYS,
  GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER,
} from '@/lib/tokens/grant';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { PERMISSIONS, isPermissionKey, type PermissionKey } from '@/lib/permissions/catalog';
import { V1_OPERATIONS } from '@/lib/api/v1/openapi/registry';

// The GRANT model guard (Story MOTIR-2572 · Subtask MOTIR-2574), decided in
// `docs/decisions/token-permissions.md`. Pure model: no DB, no I/O.
//
// The load-bearing test in this file is the DERIVATION, in both directions. The
// catalog opens by forbidding a permission with no operation behind it, and a
// picker switch that gates nothing is the same lie one level up — so "grantable"
// has to be a computed consequence of the operation maps, and this is what says
// it still is.

describe('GRANTABLE_PERMISSIONS is DERIVED, in both directions', () => {
  it('offers no key that no token-reachable operation asserts', () => {
    const asserted = new Set<PermissionKey>([
      ...Object.values(TOOL_PERMISSIONS),
      ...V1_ONLY_PERMISSIONS,
      // MOTIR-6330 — the record-view keys a token-reachable read consults after
      // its door, honoured against the grant in the service (`holdsRecordView`).
      ...RECORD_VIEW_PERMISSIONS,
      ACCEPTANCE_PUBLISH_PERMISSION,
    ]);
    for (const key of GRANTABLE_PERMISSIONS) {
      expect(asserted.has(key), `"${key}" is grantable but no operation asserts it`).toBe(true);
    }
  });

  it('omits no key that a token-reachable operation asserts', () => {
    for (const [tool, key] of Object.entries(TOOL_PERMISSIONS)) {
      expect(GRANTABLE_PERMISSIONS, `tool "${tool}" needs ungrantable "${key}"`).toContain(key);
    }
    expect(GRANTABLE_PERMISSIONS).toContain(ACCEPTANCE_PUBLISH_PERMISSION);
  });

  it('covers every /api/v1 declaration — the seam grant.ts cannot import', () => {
    // `lib/api/v1/**` pulls in Zod and every schema, and `grant.ts` is consumed
    // by the create-token modal in the browser, so the derivation deliberately
    // stops at the MCP map + the publish route (see V1_ONLY_PERMISSIONS). THIS
    // is what closes the v1 half — at test time, where the import is free.
    //
    for (const operation of V1_OPERATIONS) {
      expect(
        GRANTABLE_PERMISSIONS,
        `${operation.method} ${operation.path} requires "${operation.permission}", which no token can be granted`,
      ).toContain(operation.permission);
    }
  });

  it('keeps V1_ONLY_PERMISSIONS honest — every entry is a v1 need no MCP tool asserts', () => {
    const mcp = new Set<PermissionKey>(Object.values(TOOL_PERMISSIONS));
    const v1 = new Set<PermissionKey>(V1_OPERATIONS.map((o) => o.permission));
    for (const key of V1_ONLY_PERMISSIONS) {
      expect(v1.has(key), `"${key}" is listed v1-only but no v1 operation asserts it`).toBe(true);
      expect(mcp.has(key), `"${key}" is listed v1-only but an MCP tool asserts it too`).toBe(false);
    }
  });

  it('is a real subset of the catalog, in catalog order, with no duplicates', () => {
    for (const key of GRANTABLE_PERMISSIONS) expect(isPermissionKey(key)).toBe(true);
    expect(new Set(GRANTABLE_PERMISSIONS).size).toBe(GRANTABLE_PERMISSIONS.length);
    const order = PERMISSIONS.filter((k) => GRANTABLE_PERMISSIONS.includes(k));
    expect([...GRANTABLE_PERMISSIONS]).toEqual(order);
  });

  it('partitions the catalog with UNGRANTABLE_PERMISSIONS', () => {
    expect(GRANTABLE_PERMISSIONS.length + UNGRANTABLE_PERMISSIONS.length).toBe(PERMISSIONS.length);
    for (const key of UNGRANTABLE_PERMISSIONS) expect(isGrantable(key)).toBe(false);
  });

  it('does not offer a key whose only home is a UI-administration surface', () => {
    // A spot-check with teeth: these are exactly the switches a reader would be
    // confused to find on a token screen, because no API caller can exercise them.
    for (const key of ['board:configure', 'workflow:manage', 'member:manage'] as const) {
      expect(GRANTABLE_PERMISSIONS, `"${key}" gates nothing a token can call`).not.toContain(key);
    }
  });
});

describe('isGrantable', () => {
  it('accepts a grantable key', () => {
    expect(isGrantable('project:browse')).toBe(true);
  });

  it('rejects a catalog key nothing token-reachable asserts', () => {
    expect(isGrantable('board:configure')).toBe(false);
  });

  it('rejects a non-key, including a legacy scope string', () => {
    expect(isGrantable('work_items:write')).toBe(false);
    expect(isGrantable('')).toBe(false);
    expect(isGrantable(undefined)).toBe(false);
    expect(isGrantable(7)).toBe(false);
  });
});

describe('grantAllows', () => {
  it('admits a permission the grant holds and refuses one it does not', () => {
    const grant: PermissionKey[] = ['project:browse', 'work_item:edit'];
    expect(grantAllows(grant, 'work_item:edit')).toBe(true);
    expect(grantAllows(grant, 'work_item:delete')).toBe(false);
  });

  it('refuses everything on an empty grant', () => {
    for (const key of GRANTABLE_PERMISSIONS) expect(grantAllows([], key)).toBe(false);
  });
});

describe('repository:manage (MOTIR-11038)', () => {
  it('is grantable by derivation from create_project_repository, and in the default grant', () => {
    expect(TOOL_PERMISSIONS.create_project_repository).toBe('repository:manage');
    expect(GRANTABLE_PERMISSIONS).toContain('repository:manage');
    expect(DEFAULT_TOKEN_GRANT).toContain('repository:manage');
  });

  it('is offered by grantableFor only to an actor who already holds it', () => {
    expect(grantableFor(new Set(['project:browse', 'repository:manage']))).toContain(
      'repository:manage',
    );
    expect(grantableFor(new Set(['project:browse', 'work_item:edit']))).not.toContain(
      'repository:manage',
    );
  });
});

describe('DEFAULT_TOKEN_GRANT', () => {
  it('is every grantable permission except the irreversible ones', () => {
    expect([...DEFAULT_TOKEN_GRANT].sort()).toEqual(
      GRANTABLE_PERMISSIONS.filter((k) => !IRREVERSIBLE_PERMISSIONS.includes(k)).sort(),
    );
  });

  it('withholds work_item:delete', () => {
    expect(DEFAULT_TOKEN_GRANT).not.toContain('work_item:delete');
    expect(grantsIrreversible(DEFAULT_TOKEN_GRANT)).toBe(false);
  });

  // ⚠️ INVERTED BY MOTIR-3629, and the inversion is what §10 records. This read
  // "therefore also withholds ARCHIVE, which is the narrowing ADR §8 records":
  // under the six scopes archive was ON by default (recoverable) and delete OFF,
  // both asserted `work_item:delete` in shipped code, so one key could not hold
  // them apart and the safe direction was the one that withheld.
  //
  // The key that could not hold them apart now exists, so the default grant is
  // back where §8 said it wanted to be — and by the SAME derivation, with no arm
  // added: archive is grantable and is not irreversible, so it falls in.
  it('DOES confer ARCHIVE again, without conferring the irreversible delete', () => {
    expect(TOOL_PERMISSIONS.archive_work_item).toBe('work_item:archive');
    expect(grantAllows(DEFAULT_TOKEN_GRANT, TOOL_PERMISSIONS.archive_work_item)).toBe(true);
    expect(grantAllows(DEFAULT_TOKEN_GRANT, TOOL_PERMISSIONS.unarchive_work_item)).toBe(true);
    expect(grantAllows(DEFAULT_TOKEN_GRANT, TOOL_PERMISSIONS.delete_work_item)).toBe(false);
    // …and it is the derivation, not a special case, that puts it there.
    expect(IRREVERSIBLE_PERMISSIONS).not.toContain('work_item:archive');
  });

  it('still admits the everyday work: read, edit, comment, plan, sprints', () => {
    for (const key of [
      'project:browse',
      'work_item:edit',
      'comment:add',
      'ai:plan',
      'sprint:manage',
    ] as const) {
      expect(DEFAULT_TOKEN_GRANT).toContain(key);
    }
  });
});

describe('grantsIrreversible', () => {
  it('flags a grant holding the irreversible key', () => {
    expect(grantsIrreversible(['project:browse', 'work_item:delete'])).toBe(true);
  });

  it('does not flag one that does not', () => {
    expect(grantsIrreversible(['project:browse'])).toBe(false);
    expect(grantsIrreversible([])).toBe(false);
  });
});

describe('expandStoredGrant — reading a row written before this story', () => {
  it('passes a permission key straight through', () => {
    const { grant, unrecognised } = expandStoredGrant(['project:browse', 'work_item:edit']);
    expect(grant).toEqual(['work_item:edit', 'project:browse'].sort((a, b) => a.localeCompare(b)));
    expect(unrecognised).toEqual([]);
  });

  it('expands the six legacy strings', () => {
    const { grant, unrecognised } = expandStoredGrant(['read', 'work_items:write']);
    // `ai:view_plan` joined `work_items:write` on 2026-08-18 (MOTIR-2988):
    // `add_plan_items` is the first MCP tool to assert that key, and the forward
    // map must confer whatever `TOOL_SCOPES` files under a scope or a legacy row
    // silently loses a tool — which `tests/tokens/story-gate.test.ts` asserts
    // directly, tool by tool.
    expect([...grant].sort()).toEqual(
      ['project:browse', 'work_item:edit', 'comment:add', 'ai:plan', 'ai:view_plan'].sort(),
    );
    expect(unrecognised).toEqual([]);
  });

  it('de-duplicates across a mixed row', () => {
    const { grant } = expandStoredGrant([
      'read',
      'project:browse',
      'work_items:archive',
      'work_items:delete',
    ]);
    // MOTIR-3629 — the two legacy strings stop collapsing onto one key: each
    // expands to the key its own operations now assert. `work_item:archive`
    // appears once even though BOTH rows reach it (one by expansion, one by the
    // delete → archive implication), which is what this test is about.
    expect([...grant].sort()).toEqual(
      ['project:browse', 'work_item:archive', 'work_item:delete'].sort(),
    );
  });

  // ── MOTIR-3629 — the token half of the back-compatibility decision ────────
  // The archive split would otherwise have taken an operation away from every
  // credential already minted, and §5's standing posture forbids the obvious
  // repair: nothing rewrites a live credential's row. So the expansion carries
  // it, on READ, exactly as a legacy scope string is carried.

  it('a stored `work_item:delete` still confers archiving — no minted token lost an operation', () => {
    const { grant } = expandStoredGrant(['project:browse', 'work_item:delete']);
    expect([...grant].sort()).toEqual(
      ['project:browse', 'work_item:archive', 'work_item:delete'].sort(),
    );
    expect(grantAllows(grant, TOOL_PERMISSIONS.archive_work_item)).toBe(true);
  });

  it('does NOT confer it in the other direction — archiving never implies destroying', () => {
    // The whole point of the split: a grant may now say "you may tidy the board"
    // WITHOUT saying "you may destroy a tree". If this ever passes both ways the
    // split has bought nothing.
    const { grant } = expandStoredGrant(['project:browse', 'work_item:archive']);
    expect([...grant].sort()).toEqual(['project:browse', 'work_item:archive'].sort());
    expect(grantAllows(grant, TOOL_PERMISSIONS.delete_work_item)).toBe(false);
  });

  it('a legacy `work_items:archive` row stops conferring the cascade delete', () => {
    // The archive → delete half of ADR §5's accepted merge, closed. That string
    // was minted to mean "may archive"; while the two shared a key it silently
    // meant "may destroy a subtree" as well.
    const { grant, unrecognised } = expandStoredGrant(['work_items:archive']);
    expect([...grant]).toEqual(['work_item:archive']);
    expect(grantAllows(grant, TOOL_PERMISSIONS.delete_work_item)).toBe(false);
    expect(unrecognised).toEqual([]);
  });

  it('a legacy `work_items:delete` row keeps BOTH, via the implication', () => {
    const { grant } = expandStoredGrant(['work_items:delete']);
    expect([...grant].sort()).toEqual(['work_item:archive', 'work_item:delete'].sort());
  });

  it('DROPS an unrecognised value rather than throwing or defaulting', () => {
    // The two failure directions are not symmetric. A row we cannot interpret
    // must degrade to LESS access; yielding a default grant would hand out
    // access nobody chose.
    const { grant, unrecognised } = expandStoredGrant(['read', 'work_items:nuke', '']);
    expect(grant).toEqual(['project:browse']);
    expect(unrecognised).toEqual([{ value: 'work_items:nuke' }, { value: '' }]);
  });

  it('yields nothing at all for a wholly unreadable row', () => {
    const { grant, unrecognised } = expandStoredGrant(['garbage']);
    expect(grant).toEqual([]);
    expect(unrecognised).toHaveLength(1);
  });

  it('returns an empty grant for an empty row', () => {
    expect(expandStoredGrant([])).toEqual({ grant: [], unrecognised: [] });
  });

  it('never returns an ungrantable key', () => {
    const { grant } = expandStoredGrant([
      'read',
      'work_items:write',
      'work_items:archive',
      'work_items:delete',
      'sprints:write',
      'integration',
    ]);
    for (const key of grant) expect(isGrantable(key)).toBe(true);
    // The compatibility promise, stated exactly (ADR §5): the six together reach
    // everything the six's OPERATIONS could reach. That was ALL of
    // `GRANTABLE_PERMISSIONS` until MOTIR-3188, and the ADR's shorthand for it
    // was "i.e. everything".
    //
    // ⚠️ IT NOW HAS ONE EXCLUSION, AND THE EXCLUSION IS THE POINT — not a gap to
    // close. `ai:decide_plan` gates plan APPROVAL, whose only token entrance
    // (`POST /api/v1/work-items/{key}/plan-approval`) was created by MOTIR-3021
    // in 2026, long after these six strings stopped being written. A legacy row
    // is stale data, and stale data may never WIDEN access — the same rule
    // `customRoleBase` applies to a retired role key.
    //
    // ⚠️ AND WITHOUT THE SPLIT IT WOULD HAVE WIDENED. `work_items:write` expands
    // to `ai:view_plan`, and for the few hours between MOTIR-3021 merging and
    // MOTIR-3188 that was the key gating plan approval — so a token holding a
    // legacy string could have approved a plan into somebody's tree. Splitting
    // DECIDE off closed that without anybody having to notice it.
    //
    // ⚠️ AND `lesson:manage` IS THE SECOND EXCLUSION (MOTIR-3361), arriving by
    // the same route and for the same reason. `add_lesson` is the first MCP tool
    // to assert it, which made the key grantable; the key itself is MOTIR-3336's,
    // minted in 2026. Conferring it on a stored `work_items:write` row would let
    // a token issued for work-item edits rewrite the standing instructions a
    // project's planner is given. Named as a LIST now rather than a single
    // filter, so a third exclusion has somewhere to be written down instead of
    // quietly widening the expression.
    //
    // ⚠️ AND `lesson:view` IS THE THIRD — the one the list above was made a LIST
    // for (MOTIR-3480). Same route, same reason: `search_lessons` is the first
    // MCP tool to assert the READ key, which made it grantable; the key is
    // MOTIR-3336's, minted in 2026. Conferring it on a stored `read` row would
    // let a token issued years ago for work-item reads pull a project's
    // accumulated planning lessons, which are distilled from its own work.
    //
    // ⚠️ AND `lesson:reinforce` IS THE FOURTH (MOTIR-3553). Same route, same
    // reason, one key further: `reinforce_lesson` is the first MCP tool to
    // assert it, which made it grantable, and the key was minted in that change
    // — later than every one of the three above. Conferring it on a stored
    // `work_items:write` row would let a token issued years ago for work-item
    // edits start recording occurrences against a project's lesson corpus.
    //
    // ⚠️ AND `plan:view_any` (MOTIR-6330) is not an exclusion of the same kind:
    // a legacy row that BROWSES is read forward into it — but only given the
    // token's provenance (`expandStoredGrant`'s second argument, MOTIR-6329),
    // which this provenance-free call does not pass. The forward read has its own
    // describe block below.
    const POSTDATE_THE_SCOPES: PermissionKey[] = [
      'ai:decide_plan',
      'lesson:manage',
      'lesson:view',
      'lesson:reinforce',
      'plan:view_any',
      'run:view_any',
      // MOTIR-7410 — the lesson keys' kind again: `get_page` is the first MCP tool
      // to assert `page:view`, which made it grantable, and the key was minted
      // with pages (MOTIR-7277). A stale `read` row may never start reading a
      // project's documents.
      'page:view',
      // MOTIR-7411 — `create_page` / `update_page` make `page:edit` grantable; a
      // stale `write` row may never start rewriting a project's documents.
      'page:edit',
      // MOTIR-10183 — `update_coding_convention` makes `ai:configure` grantable;
      // no legacy scope ever conferred it, so a stale row never gains it.
      'ai:configure',
      // MOTIR-11038 — `create_project_repository` makes `repository:manage`
      // grantable; no legacy scope ever conferred it, so a stale row never gains it.
      'repository:manage',
    ];
    expect(GRANTABLE_PERMISSIONS).toContain('page:view');
    expect(GRANTABLE_PERMISSIONS).toContain('page:edit');
    expect([...grant].sort()).toEqual(
      GRANTABLE_PERMISSIONS.filter((k) => !POSTDATE_THE_SCOPES.includes(k)).sort(),
    );
    // Said as its own assertion so an exclusion cannot be read as an oversight
    // in the line above: no legacy scope confers either key, by construction.
    for (const key of POSTDATE_THE_SCOPES) expect(grant).not.toContain(key);
  });
});

describe('expandStoredGrant — the room view keys read FORWARD (MOTIR-6329)', () => {
  const CHOSEN = { projectId: 'p1' };
  const MARK = GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER;

  it('a CHOSEN grant stored WITHOUT the mint marker that browses gains both keys', () => {
    const { grant } = expandStoredGrant(['project:browse', 'work_item:edit'], CHOSEN);
    expect(grant).toContain('plan:view_any');
    expect(grant).toContain('run:view_any');
  });

  it('a CHOSEN grant minted WITH the marker and without the keys stays without — a deliberate narrowing holds', () => {
    const { grant, unrecognised } = expandStoredGrant(
      ['project:browse', 'work_item:edit', MARK],
      CHOSEN,
    );
    expect(unrecognised).toEqual([]);
    expect(grant).toEqual(['project:browse', 'work_item:edit']);
  });

  it('a marked grant that CHOSE one key keeps exactly what it chose', () => {
    const { grant } = expandStoredGrant(['project:browse', 'plan:view_any', MARK], CHOSEN);
    expect(grant).toContain('plan:view_any');
    expect(grant).not.toContain('run:view_any');
  });

  it('the marker is never a permission — it is dropped, not displayed and not unrecognised', () => {
    const { grant, unrecognised } = expandStoredGrant([MARK], CHOSEN);
    expect(grant).toEqual([]);
    expect(unrecognised).toEqual([]);
  });

  it('a FIXED device grant follows the same rule — read forward without the marker, exact with it', () => {
    const before = expandStoredGrant(['project:browse'], { projectId: null }).grant;
    expect(before).toContain('plan:view_any');
    expect(before).toContain('run:view_any');
    expect(expandStoredGrant(['project:browse', MARK], { projectId: null }).grant).toEqual([
      'project:browse',
    ]);
  });

  it('a grant that cannot browse gains nothing', () => {
    expect(expandStoredGrant(['comment:add'], CHOSEN).grant).toEqual(['comment:add']);
  });

  it('a legacy `read` scope maps to browse and is carried forward with it', () => {
    const { grant } = expandStoredGrant(['read'], CHOSEN);
    expect(grant).toContain('project:browse');
    expect(grant).toContain('plan:view_any');
    expect(grant).toContain('run:view_any');
  });

  it('legacy scopes map EXACTLY as before when no provenance is given', () => {
    expect(expandStoredGrant(['read']).grant).not.toContain('plan:view_any');
  });

  it('the forward keys are ONLY the Plans and Runs view keys — never approval:view_any', () => {
    expect([...ROOM_VIEW_FORWARD_KEYS]).toEqual(['plan:view_any', 'run:view_any']);
  });

  it('DEFAULT_TOKEN_GRANT carries each view key exactly when it is grantable — derived, never hand-added', () => {
    for (const key of ROOM_VIEW_FORWARD_KEYS) {
      expect(DEFAULT_TOKEN_GRANT.includes(key), key).toBe(GRANTABLE_PERMISSIONS.includes(key));
    }
  });
});
