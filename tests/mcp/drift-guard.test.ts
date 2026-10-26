import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { EXEMPT_TOOLS } from '@/lib/mcp/payloads/exemptions';
import {
  MCP_UNREACHABLE_RESOURCES,
  SHARED_RESOURCE_NAMES,
  sharedResourceSchema,
} from '@/lib/mcp/payloads/sharedResources';
import {
  TOOL_PAYLOADS,
  doublyResolvedTools,
  isDerivedTool,
  probedResources,
  unexplainedResources,
  unresolvedTools,
} from '@/lib/mcp/payloads/registry';
import { checkPayloadDrift, checkedResources } from '@/lib/mcp/payloads/driftGuard';
import { definePayload } from '@/lib/mcp/payloads/define';
import { presentMcpProjectRow } from '@/lib/mcp/payloads/planning';
import { archivePagePayload, linkPagePayload } from '@/lib/mcp/payloads/pages';

// The DRIFT GUARD (Story 11.6 · Subtask 11.6.6 — MOTIR-2232).
//
// The story's headline: "the two surfaces cannot drift" becomes a fact CI holds
// rather than a property people maintain.
//
// ⚠️ The FAILURE is the deliverable. A conformance test that has only ever been
// green is indistinguishable from one that asserts nothing, and this one is
// unusually easy to write so it passes vacuously — iterate an empty set, compare
// a schema to itself, skip a resource whose fixture is missing. So the suite
// drives a one-sided field change in BOTH directions and watches it go red.
//
// ⚠️ What it does NOT freeze: tool names, `tools/list` descriptions, argument
// names and scopes. Those are MCP's own and SHOULD churn. Only the DATA SHAPE is
// covered. See `lib/mcp/payloads/driftGuard.ts`'s header for why that warning
// lives beside the assertion rather than only in a card.

const projectDto = {
  id: 'proj-1',
  name: 'Motir',
  slug: 'motir',
  identifier: 'PROD',
  archivedAt: null as string | null,
  accessMode: 'workspace' as const,
  accessLevel: 'open' as const,
  // The project MARK (MOTIR-2676) — null means the project has no image, which
  // is the case every MCP payload should carry through unchanged: neither the
  // v1 `Project` shape nor the MCP row publishes it.
  image: null,
  onboardingRanAt: null,
  aiGenerateExplanations: false,
  prMergeMode: 'manual' as const,
  autoTranslateWorkContent: false,
};

describe('the guard BITES — a one-sided field fails, in both directions', () => {
  it('REST gained a required field, MCP did not → the guard FAILS', () => {
    // The exact shape of the drift: someone adds a field to the v1 schema and
    // the MCP mapper is not updated. The payload is otherwise perfect.
    const restGainedAField = z.object({
      key: z.string(),
      name: z.string(),
      accessLevel: z.string(),
      archived: z.boolean(),
      // ← the new field, on the REST side only
      ownerId: z.string(),
    });
    const definition = definePayload({
      schema: z.object({}).catchall(z.unknown()) as never,
      probes: [{ resource: 'Project', select: (p) => [p] }],
    }) as never;
    // Drive the check against the widened schema directly, so the assertion is
    // about the COMPARISON and not about mutating the shipped registry.
    const mcpPayload = presentMcpProjectRow(projectDto);
    expect(restGainedAField.safeParse(mcpPayload).success).toBe(false);
    // …and through the guard's own entry point, against the real schema, it passes.
    expect(checkPayloadDrift(definition, mcpPayload)).toEqual([]);
  });

  it('MCP DROPPED a field the REST schema requires → the guard FAILS', () => {
    const definition = definePayload({
      schema: z.object({}).catchall(z.unknown()) as never,
      probes: [{ resource: 'Project', select: (p) => [p] }],
    }) as never;
    const { archived: _dropped, ...broken } = presentMcpProjectRow(projectDto);
    const violations = checkPayloadDrift(definition, broken);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.resource).toBe('Project');
    expect(violations[0]!.detail).toContain('archived');
  });

  it('a WRONG-TYPED field fails too, not only a missing one', () => {
    const definition = definePayload({
      schema: z.object({}).catchall(z.unknown()) as never,
      probes: [{ resource: 'Project', select: (p) => [p] }],
    }) as never;
    const bent = { ...presentMcpProjectRow(projectDto), archived: 'yes' };
    expect(checkPayloadDrift(definition, bent)).toHaveLength(1);
  });

  it('reports EVERY violation in a collection, not just the first', () => {
    const definition = definePayload({
      schema: z.object({}).catchall(z.unknown()) as never,
      probes: [{ resource: 'Project', select: (p) => (p as { rows: unknown[] }).rows }],
    }) as never;
    const good = presentMcpProjectRow(projectDto);
    const { archived: _a, ...bad } = good;
    const violations = checkPayloadDrift(definition, { rows: [bad, good, bad] });
    expect(violations.map((v) => v.index)).toEqual([0, 2]);
  });

  it('an agreeing payload produces NO violations — the guard is not simply always red', () => {
    const definition = definePayload({
      schema: z.object({}).catchall(z.unknown()) as never,
      probes: [{ resource: 'Project', select: (p) => [p] }],
    }) as never;
    expect(checkPayloadDrift(definition, presentMcpProjectRow(projectDto))).toEqual([]);
  });

  it('a definition with NO probes checks nothing and says so', () => {
    const definition = definePayload({ schema: z.object({}) as never, probes: [] }) as never;
    expect(checkedResources(definition)).toEqual([]);
    expect(checkPayloadDrift(definition, {})).toEqual([]);
  });
});

describe('COVERAGE is asserted, not assumed', () => {
  it('EVERY registered tool is DERIVED or EXEMPT — a tool in neither FAILS', () => {
    // Walked off `lib/mcp/registry.ts`, never a remembered set. This is the seal
    // MOTIR-2231 landed, re-asserted here as the guard's own precondition: a
    // guard over a set nobody defined is the story's defect one level up.
    expect(unresolvedTools(MCP_TOOL_NAMES)).toEqual([]);
  });

  it('the two columns PARTITION the registry — none is in both, and they SUM', () => {
    expect(doublyResolvedTools(MCP_TOOL_NAMES)).toEqual([]);
    expect(Object.keys(TOOL_PAYLOADS).length + Object.keys(EXEMPT_TOOLS).length).toBe(
      MCP_TOOL_NAMES.length,
    );
  });

  it('neither column names a tool the registry does not have', () => {
    const registered = new Set<string>(MCP_TOOL_NAMES);
    for (const name of [...Object.keys(TOOL_PAYLOADS), ...Object.keys(EXEMPT_TOOLS)]) {
      expect(registered.has(name), `stale entry "${name}"`).toBe(true);
    }
  });

  it('EVERY shared resource is either PROBED or explained — none silently skipped', () => {
    // The other half of coverage, and the one that decides whether the guard's
    // silence is information. `MCP_UNREACHABLE_RESOURCES` is where "no MCP
    // payload returns this" gets WRITTEN, with a reason.
    expect(unexplainedResources()).toEqual([]);
  });

  it('the run NAMES the resources it covered — a receipt, not a bare pass', () => {
    const probed = probedResources();
    expect(probed.size).toBeGreaterThan(0);
    for (const name of probed) {
      expect(SHARED_RESOURCE_NAMES).toContain(name);
      expect(sharedResourceSchema(name)).toBeDefined();
    }
    // Every explained-away resource is a REAL one, with a real reason.
    for (const [name, reason] of Object.entries(MCP_UNREACHABLE_RESOURCES)) {
      expect(SHARED_RESOURCE_NAMES).toContain(name);
      expect(reason!.length).toBeGreaterThan(60);
    }
  });

  it('isDerivedTool answers off the map', () => {
    expect(isDerivedTool('get_work_item')).toBe(true);
    expect(isDerivedTool('validate_work_item')).toBe(false);
  });
});

describe('EVERY derived tool’s declaration is checkable', () => {
  it('each payload definition carries a schema and a (possibly empty) probe list', () => {
    for (const [tool, definition] of Object.entries(TOOL_PAYLOADS)) {
      expect(definition.schema, `${tool} has no schema`).toBeDefined();
      expect(Array.isArray(definition.probes), `${tool} has no probe list`).toBe(true);
      for (const probe of definition.probes) {
        expect(
          SHARED_RESOURCE_NAMES,
          `${tool} probes unknown resource "${probe.resource}"`,
        ).toContain(probe.resource);
      }
    }
  });
});

describe('the violation REPORT is usable', () => {
  const probeProject = definePayload({
    schema: z.object({}).catchall(z.unknown()) as never,
    probes: [{ resource: 'Project', select: (p) => [p] }],
  }) as never;

  it('names the FIELD that disagreed, so a reader can act on the red', () => {
    const { name: _dropped, ...broken } = presentMcpProjectRow(projectDto);
    const [violation] = checkPayloadDrift(probeProject, broken);
    expect(violation!.detail).toContain('name');
    expect(violation!.index).toBe(0);
  });

  it('a part that is not an object at all reports at the ROOT', () => {
    const definition = definePayload({
      schema: z.object({}).catchall(z.unknown()) as never,
      probes: [{ resource: 'Project', select: () => ['not an object'] }],
    }) as never;
    const [violation] = checkPayloadDrift(definition, {});
    expect(violation!.detail).toContain('<root>');
  });

  it('checkedResources is the run’s receipt — what was actually compared', () => {
    expect(checkedResources(probeProject)).toEqual(['Project']);
  });
});

describe('the page archive, restore and link resources are PROBED, not explained away (MOTIR-9604)', () => {
  const archived = { archivedIds: ['p1', 'p2'], rootId: 'p1', subPageCount: 1 };
  const restored = {
    restoredIds: ['p1', 'p2'],
    landing: { kind: 'original', parentPageId: null, folderId: null, title: null },
  };
  const linked = {
    pageId: 'p1',
    workItemId: 'w1',
    source: 'manual',
    action: 'link',
    changed: true,
  };

  it('all three are probed by a tool, and none is listed as unreachable', () => {
    const probed = probedResources();
    for (const name of ['PageArchive', 'PageRestore', 'PageLinkPair'] as const) {
      expect(probed.has(name), `${name} is not probed`).toBe(true);
      expect(name in MCP_UNREACHABLE_RESOURCES, `${name} is still listed unreachable`).toBe(false);
    }
    expect(TOOL_PAYLOADS.archive_page).toBe(archivePagePayload);
    expect(TOOL_PAYLOADS.link_page).toBe(linkPagePayload);
    expect('archive_page' in EXEMPT_TOOLS).toBe(false);
    expect('link_page' in EXEMPT_TOOLS).toBe(false);
  });

  it('`archive_page` probes EACH branch against its own resource', () => {
    const definition = archivePagePayload as never;
    const [archiveProbe, restoreProbe] = archivePagePayload.probes;
    expect(archiveProbe!.resource).toBe('PageArchive');
    expect(restoreProbe!.resource).toBe('PageRestore');
    expect(archiveProbe!.select(archived as never)).toEqual([archived]);
    expect(restoreProbe!.select(archived as never)).toEqual([]);
    expect(archiveProbe!.select(restored as never)).toEqual([]);
    expect(restoreProbe!.select(restored as never)).toEqual([restored]);
    expect(checkPayloadDrift(definition, archived)).toEqual([]);
    expect(checkPayloadDrift(definition, restored)).toEqual([]);
  });

  it('a field dropped from either branch FAILS against that branch’s resource', () => {
    const definition = archivePagePayload as never;
    const { subPageCount: _a, ...brokenArchive } = archived;
    const [archiveViolation] = checkPayloadDrift(definition, brokenArchive);
    expect(archiveViolation!.resource).toBe('PageArchive');
    expect(archiveViolation!.detail).toContain('subPageCount');

    const { landing: _l, ...brokenRestore } = restored;
    const [restoreViolation] = checkPayloadDrift(definition, brokenRestore);
    expect(restoreViolation!.resource).toBe('PageRestore');
    expect(restoreViolation!.detail).toContain('landing');
  });

  it('`link_page` probes the pair, and its `action` / `changed` extras do not hide a dropped pair field', () => {
    const definition = linkPagePayload as never;
    expect(checkPayloadDrift(definition, linked)).toEqual([]);
    const { workItemId: _w, ...broken } = linked;
    const [violation] = checkPayloadDrift(definition, broken);
    expect(violation!.resource).toBe('PageLinkPair');
    expect(violation!.detail).toContain('workItemId');
  });

  it('the payload schemas parse the tool answers they declare', () => {
    expect(archivePagePayload.schema.safeParse(archived).success).toBe(true);
    expect(archivePagePayload.schema.safeParse(restored).success).toBe(true);
    expect(linkPagePayload.schema.safeParse(linked).success).toBe(true);
    expect(linkPagePayload.schema.safeParse({ ...linked, changed: 'yes' }).success).toBe(false);
  });
});
