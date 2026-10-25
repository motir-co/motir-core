import { describe, expect, it } from 'vitest';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS, toolPermission } from '@/lib/mcp/toolPermissions';
import {
  LEGACY_SCOPE_PERMISSIONS,
  LEGACY_TOKEN_SCOPES,
  isLegacyTokenScope,
  TOOL_SCOPES,
  toolScope,
} from '@/lib/mcp/scopes';
import { GRANTABLE_PERMISSIONS, isGrantable } from '@/lib/tokens/grant';
import { isPermissionKey, type PermissionKey } from '@/lib/permissions/catalog';

// The tool→PERMISSION model guard (Story MOTIR-2572 · Subtask MOTIR-2574) —
// the 7.7.16 scope-map guard RE-POINTED onto the new vocabulary, not duplicated
// beside it. `TOOL_PERMISSIONS` is typed `Record<McpToolName, PermissionKey>`,
// so a tool added without a permission is a COMPILE error; this suite re-asserts
// the totality at runtime so the guarantee survives a type-erasure refactor, and
// pins the legacy forward map that keeps every already-minted token working.
// No DB, no I/O — a pure model check.

describe('TOOL_PERMISSIONS totality over MCP_TOOL_NAMES', () => {
  it('maps every registered tool to exactly one real catalog permission', () => {
    for (const name of MCP_TOOL_NAMES) {
      const permission = TOOL_PERMISSIONS[name];
      expect(permission, `tool "${name}" has no permission`).toBeDefined();
      expect(
        isPermissionKey(permission),
        `tool "${name}" maps to unknown permission "${permission}"`,
      ).toBe(true);
    }
  });

  it('maps every tool to a GRANTABLE permission — a tool nobody can be granted is undispatchable', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(
        isGrantable(TOOL_PERMISSIONS[name]),
        `tool "${name}" requires "${TOOL_PERMISSIONS[name]}", which no token can be granted`,
      ).toBe(true);
    }
  });

  it('has no entries for tools that are not in the registry', () => {
    const registry = new Set<string>(MCP_TOOL_NAMES);
    for (const mapped of Object.keys(TOOL_PERMISSIONS)) {
      expect(registry.has(mapped), `permission map has stale tool "${mapped}"`).toBe(true);
    }
  });

  it('covers the registry exactly (same cardinality, no gaps or extras)', () => {
    expect(Object.keys(TOOL_PERMISSIONS).length).toBe(MCP_TOOL_NAMES.length);
  });

  it('toolPermission() returns the same permission as the map for every tool', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(toolPermission(name)).toBe(TOOL_PERMISSIONS[name]);
    }
  });
});

describe('the permission split the six scopes could not express', () => {
  // Each of these was `work_items:write` (or `read`) under 7.7.16 because
  // nothing narrower existed. Naming the real gate is the point of the story, so
  // the split is pinned rather than left to a reviewer's eye.
  it('separates the billable planning submits onto ai:plan', () => {
    for (const name of [
      'expand_item',
      'open_plan_session',
      'append_plan_turn',
      'submit_plan_session',
    ] as const) {
      expect(TOOL_PERMISSIONS[name], `${name} must be withholdable on its own`).toBe('ai:plan');
    }
  });

  it('separates commenting onto comment:add', () => {
    expect(TOOL_PERMISSIONS.add_comment).toBe('comment:add');
  });

  // ⚠️ INVERTED BY MOTIR-3629. This read "puts archive on the same key as
  // delete, because the shipped gates do", and it was a true statement about the
  // gates that pinned a defect in them: `permission-inventory.md` R42 grouped the
  // two on "cascades over a subtree", which archive does not do. The map still
  // names exactly what each tool's service asserts (ADR §3) — the services moved
  // (`token-permissions.md` §10).
  it('separates the REVERSIBLE removal from the irreversible one', () => {
    for (const name of ['archive_work_item', 'unarchive_work_item'] as const) {
      expect(TOOL_PERMISSIONS[name]).toBe('work_item:archive');
    }
    expect(TOOL_PERMISSIONS.delete_work_item).toBe('work_item:delete');
  });

  it('keeps the two integration writes on the work-item edit gate they actually reach', () => {
    expect(TOOL_PERMISSIONS.mark_integrated).toBe('work_item:edit');
    expect(TOOL_PERMISSIONS.complete_session).toBe('work_item:edit');
    // The merge ADR §5 records: the same key `transition_status` asks for.
    expect(TOOL_PERMISSIONS.transition_status).toBe('work_item:edit');
  });
});

describe('CLI_TOKEN_GRANT (the device-approval fixed grant)', () => {
  it('is every permission the CLI needs and nothing else', () => {
    // `lesson:view` joined the set in MOTIR-3480: `search_lessons` is gated on
    // it, and the sandboxed `motir run` agent that tool exists for is exactly the
    // caller a narrower grant would lock out. The argument for widening lives at
    // the constant, as `token-permissions.md` §3 requires.
    expect([...CLI_TOKEN_GRANT].sort()).toEqual(
      [
        'ai:plan',
        'comment:add',
        'lesson:view',
        // MOTIR-3553 — widened deliberately; the argument is on the constant and
        // in `attachFileTool.test.ts`'s pin beside it.
        'lesson:reinforce',
        'project:browse',
        'work_item:edit',
        // MOTIR-6329 — the Plans and Runs rooms' view keys, for the reads the CLI
        // already performs on browse; the argument is on the constant.
        'plan:view_any',
        'run:view_any',
        // MOTIR-7412 — the page keys, for `get_page` / `create_page` /
        // `update_page`; the argument is on the constant.
        'page:view',
        'page:edit',
      ].sort(),
    );
  });

  it('withholds the two a remote unattended credential must not hold', () => {
    expect(CLI_TOKEN_GRANT).not.toContain('work_item:delete');
    expect(CLI_TOKEN_GRANT).not.toContain('sprint:manage');
    // MOTIR-7412 — pages joined the grant without their destroying key (§5).
    expect(CLI_TOKEN_GRANT).not.toContain('page:delete');
  });

  it('is entirely grantable', () => {
    for (const key of CLI_TOKEN_GRANT) expect(isGrantable(key), key).toBe(true);
  });
});

describe('LEGACY_SCOPE_PERMISSIONS (the forward map)', () => {
  it('covers all six stored scope strings', () => {
    for (const scope of LEGACY_TOKEN_SCOPES) {
      expect(LEGACY_SCOPE_PERMISSIONS[scope], `no forward mapping for "${scope}"`).toBeDefined();
      expect(LEGACY_SCOPE_PERMISSIONS[scope].length).toBeGreaterThan(0);
    }
  });

  it('expands only to grantable catalog permissions', () => {
    for (const scope of LEGACY_TOKEN_SCOPES) {
      for (const key of LEGACY_SCOPE_PERMISSIONS[scope]) {
        expect(isGrantable(key), `"${scope}" expands to ungrantable "${key}"`).toBe(true);
      }
    }
  });

  it('the union of the six is the grantable set MINUS the keys that postdate them', () => {
    // A token holding all six scopes could reach every token-reachable operation
    // that EXISTED when those scopes were written. It still can. That is the
    // property making "no already-minted token loses authority" checkable rather
    // than asserted — and it is a claim about the SIX, not about the catalog's
    // future.
    //
    // ⚠️ THE EXCLUSION IS THE RULE WORKING (MOTIR-3188). `ai:decide_plan` gates
    // plan APPROVAL, whose only token entrance
    // (`POST /api/v1/work-items/{key}/plan-approval`) MOTIR-3021 created in 2026,
    // long after these six strings stopped being written. No legacy scope expands
    // to it, because a legacy row is stale data and stale data may never WIDEN
    // access — the same posture `expandStoredValue`'s third arm takes toward a
    // value it cannot interpret at all.
    //
    // ⚠️ AND WITHOUT THE SPLIT IT WOULD HAVE WIDENED. `work_items:write` expands
    // to `ai:view_plan`, and for the hours between MOTIR-3021 merging and
    // MOTIR-3188 landing that key gated plan approval — so a token carrying a
    // legacy string could have approved a proposed subtree into somebody's tree.
    // Splitting DECIDE off closed that without anybody having to notice it.
    //
    // Named as an exact set rather than a filter over the constant under test: a
    // SECOND exclusion must appear here as a failure, not join an allowance —
    // the same discipline the ONE-named-loss assertion below applies.
    const union = new Set(LEGACY_TOKEN_SCOPES.flatMap((s) => [...LEGACY_SCOPE_PERMISSIONS[s]]));
    //
    // ⚠️ `lesson:manage` JOINED THIS LIST 2026-08-23 (MOTIR-3361), for exactly
    // the reason above and not as an allowance. `add_lesson` is the first MCP
    // tool to assert the key, and the key itself is MOTIR-3336's — minted in
    // 2026, years after these six strings stopped being written. Conferring it
    // on a legacy `work_items:write` row would let a token minted for work-item
    // edits rewrite the STANDING INSTRUCTIONS a project's planner is given,
    // which is precisely the widening this test exists to forbid. The tool is
    // therefore recorded as a named LOSS in the tool-by-tool check below: a
    // legacy token does not reach it, deliberately, and a token that should
    // reach it is granted `lesson:manage` in the permission vocabulary.
    //
    // ⚠️ `lesson:view` JOINS IT 2026-08-25 (MOTIR-3480), for the SAME reason as
    // its manage sibling and on the same terms. `search_lessons` is the first
    // tool to assert the READ key, and `lesson:view` is MOTIR-3336's — also
    // minted long after these six strings stopped being written. Conferring it
    // on a legacy `read` row would let a token minted years ago for work-item
    // reads pull a project's accumulated planning lessons, which are distilled
    // from its own work and can name specifics of it. A stale row may not gain
    // that, so the tool is a named LOSS below rather than a widening here.
    const POSTDATE_THE_SCOPES: PermissionKey[] = [
      'ai:decide_plan',
      'lesson:manage',
      'lesson:view',
      // MOTIR-3553. Same reason as its two lesson siblings: it did not exist
      // when the six strings were written, so no stale token may acquire it.
      'lesson:reinforce',
      // MOTIR-6330 — not in the static map: a browsing row is read FORWARD into
      // it at read time, from the token's provenance (`expandStoredGrant`,
      // MOTIR-6329), which the forward map does not carry.
      'plan:view_any',
      'run:view_any',
      // MOTIR-7410 — minted with pages (MOTIR-7277) and made grantable by
      // `get_page`, the first tool to assert it. No stale row may acquire it.
      'page:view',
      // MOTIR-7411 — the same, made grantable by `create_page` / `update_page`.
      'page:edit',
    ];
    expect([...union].sort()).toEqual(
      GRANTABLE_PERMISSIONS.filter((k) => !POSTDATE_THE_SCOPES.includes(k)).sort(),
    );
    for (const key of POSTDATE_THE_SCOPES) expect([...union]).not.toContain(key);
  });

  it('maps every operation the six scopes gated, tool by tool, with ONE named loss', () => {
    // The exhaustive direction, and the one that makes "a stored row keeps
    // working" true per-operation rather than in aggregate: for each tool, the
    // scope that USED to gate it must forward-map to the permission that gates
    // it now.
    //
    // `open_plan_session` is the single measured exception (ADR §5). It declared
    // `read` while its service asserts `ai:plan`, so the OLD SCOPE was
    // over-permissive relative to its own gate. Widening `read` to cover it
    // would hand every legacy read-only token `expand_item` and
    // `submit_plan_session` — billable operations it never had. Asserting the
    // loss by name is what keeps this check exhaustive: a SECOND loss appears
    // here as a failure instead of quietly joining an allowance.
    const KNOWN_LOSSES: Partial<Record<(typeof MCP_TOOL_NAMES)[number], true>> = {
      open_plan_session: true,
      // MOTIR-3361. A SECOND loss, and of a different kind from the first:
      // `open_plan_session` is a tool whose old scope was over-permissive, while
      // this one is a tool NO legacy scope ever gated because it did not exist.
      // Its `TOOL_SCOPES` entry files it under `work_items:write` as the nearest
      // bucket in a table this story deprecates — but the forward map must NOT
      // be widened to match, because `lesson:manage` postdates all six strings
      // and a stale row may never gain authority. So the loss is correct, and
      // naming it here is what keeps the check exhaustive rather than what
      // excuses it.
      add_lesson: true,
      // MOTIR-3480. A THIRD loss, of the same kind as `add_lesson` and for the
      // same reason one key over: no legacy scope ever gated `search_lessons`,
      // because `lesson:view` did not exist when the six strings were written.
      // Its `TOOL_SCOPES` entry files it under `read` as the nearest bucket in a
      // table this story deprecates; the forward map is deliberately NOT widened
      // to match, so a stale `read` row cannot start pulling a project's
      // lessons. The loss is correct, and naming it is what keeps this check
      // exhaustive rather than what excuses it.
      search_lessons: true,
      // MOTIR-3553. A FOURTH loss, of the same kind as the two above: no legacy
      // scope ever gated `reinforce_lesson`, because `lesson:reinforce` did not
      // exist when the six strings were written. Its `TOOL_SCOPES` entry files
      // it under `work_items:write` as the nearest bucket in a table this story
      // deprecates; `LEGACY_SCOPE_PERMISSIONS` is deliberately NOT widened to
      // match, so a stale `work_items:write` row cannot start writing to a
      // project's lesson corpus. The loss is correct, and naming it is what
      // keeps this check exhaustive rather than what excuses it.
      reinforce_lesson: true,
      // MOTIR-7793 — `get_code_health`, the SAME kind of loss as
      // `open_plan_session`: a read filed under `read` whose service asserts
      // `ai:plan`. Widening `read` to cover it would hand every legacy read-only
      // token the billable planning submits; and the tool postdates the six
      // strings, so no stale row ever had it to lose.
      get_code_health: true,
      // MOTIR-9083 — `get_coding_convention`, the same loss and the same reason.
      get_coding_convention: true,
      // MOTIR-7861 — `read_file`, the same loss as `get_code_health`: a read filed
      // under `read` whose service asserts `ai:plan`, and a tool that postdates
      // the six strings.
      read_file: true,
      // MOTIR-7862 — the two graph reads, the same loss and the same reason.
      code_explore: true,
      code_search: true,
      // MOTIR-7410. A FIFTH loss, of the lesson tools' kind: no legacy scope ever
      // gated `get_page`, because `page:view` did not exist when the six strings
      // were written. Its `TOOL_SCOPES` row files it under `read` as the nearest
      // bucket; the forward map is NOT widened, so a stale `read` row cannot start
      // reading a project's pages.
      get_page: true,
      // MOTIR-7411 — the page writes, the same kind of loss: `page:edit` postdates
      // the six strings, so a stale `write` row cannot start rewriting pages.
      create_page: true,
      update_page: true,
      rename_page: true,
      // MOTIR-9553 — the page search, `page:view` like `get_page`, the same loss.
      search_pages: true,
      // MOTIR-9556 — the page move, `page:edit` like `update_page`, the same loss.
      move_page: true,
      // MOTIR-9557 — the page archive / restore, `page:edit`, the same loss.
      archive_page: true,
      // MOTIR-9558 — the page hand link, `page:edit`, the same loss.
      link_page: true,
    };
    const losses: string[] = [];
    for (const name of MCP_TOOL_NAMES) {
      const wasGatedBy = TOOL_SCOPES[name];
      if (!LEGACY_SCOPE_PERMISSIONS[wasGatedBy].includes(TOOL_PERMISSIONS[name])) {
        losses.push(`${name}: '${wasGatedBy}' -> '${TOOL_PERMISSIONS[name]}'`);
      }
    }
    expect(losses).toEqual(
      Object.keys(KNOWN_LOSSES).map(
        (n) =>
          `${n}: '${TOOL_SCOPES[n as keyof typeof TOOL_SCOPES]}' -> '${TOOL_PERMISSIONS[n as keyof typeof TOOL_PERMISSIONS]}'`,
      ),
    );
  });

  it('records the integration ↔ work_items:write merge rather than hiding it', () => {
    // ADR §5. Asserted so the merge is a checked, visible property: if a future
    // change separates them again, this test says so out loud.
    expect(LEGACY_SCOPE_PERMISSIONS.integration).toContain('work_item:edit');
    expect(LEGACY_SCOPE_PERMISSIONS['work_items:write']).toContain('work_item:edit');
  });
});

describe('isLegacyTokenScope', () => {
  it('accepts every stored scope string', () => {
    for (const scope of LEGACY_TOKEN_SCOPES) expect(isLegacyTokenScope(scope)).toBe(true);
  });

  it('rejects anything else, including a permission key', () => {
    expect(isLegacyTokenScope('work_items:nuke')).toBe(false);
    expect(isLegacyTokenScope('')).toBe(false);
    expect(isLegacyTokenScope('READ')).toBe(false);
    expect(isLegacyTokenScope('work_item:edit')).toBe(false);
    expect(isLegacyTokenScope(undefined)).toBe(false);
  });
});

describe('the deprecated 7.7.16 exports (scaffolding — see the file header)', () => {
  // They survive only until the cards that read them re-point (MOTIR-2575 /
  // -2579 / -2580 / -2581). Covered so the shim cannot rot silently while it is
  // still load-bearing for the published /docs MCP page.
  it('toolScope() still answers for every tool', () => {
    for (const name of MCP_TOOL_NAMES) expect(toolScope(name)).toBe(TOOL_SCOPES[name]);
  });

  it('deliberately DISAGREES with TOOL_PERMISSIONS where the vocabulary changed', () => {
    // Not a shim over the new map — see its @deprecated note. If these ever
    // agreed, the docs page would render the new split under the old names.
    expect(toolScope('add_comment')).toBe('work_items:write');
    expect(TOOL_PERMISSIONS.add_comment).toBe('comment:add');
  });
});
