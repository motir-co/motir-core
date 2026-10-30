import { describe, expect, it } from 'vitest';
import {
  MCP_TOOL_ANNOTATIONS,
  MCP_TOOL_INPUT_SCHEMAS,
  MCP_TOOL_TITLES,
} from '@/lib/apiDocs/mcpToolSchemas';
import { mcpToolRows, type McpCatalogueToolName } from '@/lib/apiDocs/mcp';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import {
  generateMcpToolSchemas,
  isMcpToolSchemasStale,
  listShippedTools,
  listShippedToolSchemas,
  readCommittedMcpToolSchemas,
} from '../../scripts/generateMcpToolSchemas';

// THE TOOL-SCHEMA TRUTH GATE (Story MOTIR-3875 · Subtask MOTIR-4389) — what
// makes `lib/apiDocs/mcpToolSchemas.ts` a PROJECTION of the registry rather than
// a second declaration of it.
//
// ── Why the file it guards exists at all ───────────────────────────────────
// A tool's `inputSchema` is declared inside its `registerTool(...)` call, so
// reading one means building the server — which imports every tool, every
// service and Prisma. `lib/apiDocs/mcp.ts` may not do that (its own header
// states the rule) and neither may the anonymous route that serves the document
// (`tests/api/docs/mcp-tools-route.test.ts` asserts its imports are exactly
// two). A generated leaf is how the VALUE crosses that boundary while the
// IMPORT does not — and this file is the reason that is honest.
//
// ── Its home, chosen the same way `tool-doc-truth.test.ts`'s was ───────────
// Beside it, in `tests/mcp/`, and importing no route, no page and nothing under
// `app/`. That is not incidental: the fingerprint gate spent a day deleted
// because it lived in a directory named after four pages, and the first
// divergence landed the next day, green.
//
// ── Two guards, deliberately, over one artifact ────────────────────────────
//   Guard A — the COMMITTED file is what the generator produces right now.
//   Guard B — the SERVED catalogue carries, per tool, the schema the SERVER
//             serves for that tool.
//
// Collapsing them would leave a world where the file is fresh and the catalogue
// drops it on the way out, or the catalogue is right and the file was hand-
// edited into agreement — one green check either way. Guard A is a byte
// comparison against a regeneration; Guard B walks a live handshake and compares
// values. The pair is the same shape `tests/cli/generated-api-freshness.test.ts`
// holds over `packages/cli/src/api/`, and a strictly stronger one than the
// fingerprint gate beside it: that pins a HASH of the prose, this pins the value.

const REPO_ROOT = process.cwd();

/**
 * THE PREDICATE for guard B, extracted so the counterfactual below can drive the
 * SAME code the real assertion runs: which tools' committed schema is not the
 * one the server serves. A guard proved only to pass is a comment.
 */
function driftedSchemas(
  shipped: readonly [string, unknown][],
  stored: (name: string) => unknown,
): string[] {
  return shipped
    .filter(([name, schema]) => JSON.stringify(stored(name)) !== JSON.stringify(schema))
    .map(([name]) => name);
}

describe('Guard A — the committed schema map is FRESH', () => {
  it('is byte-identical to what the generator produces right now', async () => {
    const generated = await generateMcpToolSchemas();
    const committed = await readCommittedMcpToolSchemas(REPO_ROOT);
    expect(
      isMcpToolSchemasStale(generated, committed),
      'Run `pnpm generate:mcp-tool-schemas` and commit the result.',
    ).toBe(false);
  });

  it('is byte-identical across two runs, so the guard cannot flap', async () => {
    // The guard is only a signal if regeneration is deterministic. If it were
    // not, every pull request would show a diff and the guard would be turned
    // off within a week — which is how a generated file goes back to being a
    // hand-written mirror with extra ceremony. The generator sorts by tool name
    // for exactly this reason: the handshake's own order is the registry's
    // registration order.
    const [first, second] = await Promise.all([generateMcpToolSchemas(), generateMcpToolSchemas()]);
    expect(isMcpToolSchemasStale(first, second)).toBe(false);
  });

  it('REPORTS a hand-edited file — the guard is driven, not trusted', async () => {
    const generated = await generateMcpToolSchemas();
    expect(isMcpToolSchemasStale(generated, `${generated}\n// a hand edit\n`)).toBe(true);
  });

  it('reads a missing committed file as null, which the predicate reports', async () => {
    expect(await readCommittedMcpToolSchemas('/nonexistent-motir-root')).toBeNull();
  });

  it('REPORTS a missing file rather than passing it', async () => {
    const generated = await generateMcpToolSchemas();
    expect(isMcpToolSchemasStale(generated, null)).toBe(true);
  });
});

describe('Guard B — every served schema is the one the SERVER serves', () => {
  // TOTALITY first, because the comparison below iterates the SHIPPED list: a
  // stored schema for a tool the server no longer exposes would never be
  // compared, and "every schema was verified" would be false while green.
  it('the map carries exactly the tools the server exposes — none missing, none left over', async () => {
    const shipped = (await listShippedToolSchemas()).map(([name]) => name).sort();
    expect(Object.keys(MCP_TOOL_INPUT_SCHEMAS).sort()).toEqual(shipped);
    // And the type-level totality, restated as a value comparison: the map is
    // annotated `Record<keyof typeof TOOL_PERMISSIONS, …>`, which typecheck
    // holds — this is what catches a serialization that dropped one.
    expect(Object.keys(MCP_TOOL_INPUT_SCHEMAS).sort()).toEqual(
      Object.keys(TOOL_PERMISSIONS).sort(),
    );
  });

  it('every tool’s stored schema equals the one `tools/list` serves', async () => {
    const shipped = await listShippedToolSchemas();
    expect(
      driftedSchemas(shipped, (name) => MCP_TOOL_INPUT_SCHEMAS[name as McpCatalogueToolName]),
      'Run `pnpm generate:mcp-tool-schemas` and commit the result.',
    ).toEqual([]);
  });

  it('the predicate FIRES — proved by perturbing one stored schema', async () => {
    const shipped = await listShippedToolSchemas();
    const victim = shipped[0]![0];
    expect(
      driftedSchemas(shipped, (name) =>
        name === victim
          ? { type: 'object', properties: {}, required: ['invented'] }
          : MCP_TOOL_INPUT_SCHEMAS[name as McpCatalogueToolName],
      ),
    ).toEqual([victim]);
  });

  it('the CATALOGUE row carries the schema, not just the map', async () => {
    // `mcpCatalogue()` is what the served document is built from. A map that is
    // perfect and a row that drops it are the same failure to a reader.
    const shipped = new Map(await listShippedToolSchemas());
    const rows = mcpToolRows();
    expect(rows.length).toBe(shipped.size);
    expect(
      driftedSchemas([...shipped], (name) => rows.find((r) => r.name === name)?.inputSchema),
    ).toEqual([]);
  });
});

// ── The TITLE and HINT maps (Story MOTIR-6974 · Subtask MOTIR-7002) ────────
// The same two guards, over the two values the generated leaf gained. Guard A
// above already covers them (it compares the whole file, byte for byte); these
// compare each VALUE against a fresh handshake, and drive the predicate over an
// in-memory edit so it is proved to fire.
describe('Guard B, for titles and hints — every stored value is the one `tools/list` serves', () => {
  async function shippedPairs(field: 'title' | 'annotations'): Promise<[string, unknown][]> {
    return (await listShippedTools()).map((tool): [string, unknown] => [tool.name, tool[field]]);
  }

  it('the two maps carry exactly the tools the server exposes', async () => {
    const shipped = (await listShippedTools()).map((tool) => tool.name).sort();
    expect(Object.keys(MCP_TOOL_TITLES).sort()).toEqual(shipped);
    expect(Object.keys(MCP_TOOL_ANNOTATIONS).sort()).toEqual(shipped);
  });

  it('every stored title equals the served one', async () => {
    expect(
      driftedSchemas(
        await shippedPairs('title'),
        (name) => MCP_TOOL_TITLES[name as McpCatalogueToolName],
      ),
      'Run `pnpm generate:mcp-tool-schemas` and commit the result.',
    ).toEqual([]);
  });

  it('every stored hint set equals the served one', async () => {
    expect(
      driftedSchemas(
        await shippedPairs('annotations'),
        (name) => MCP_TOOL_ANNOTATIONS[name as McpCatalogueToolName],
      ),
      'Run `pnpm generate:mcp-tool-schemas` and commit the result.',
    ).toEqual([]);
  });

  it('FIRES on an edited title — a copy changed in memory', async () => {
    const shipped = await shippedPairs('title');
    const victim = shipped[0]![0];
    const edited = { ...MCP_TOOL_TITLES, [victim]: 'A title nobody registered' };
    expect(driftedSchemas(shipped, (name) => edited[name as McpCatalogueToolName])).toEqual([
      victim,
    ]);
  });

  it('FIRES on an edited hint — a destructive tool published as read-only', async () => {
    const shipped = await shippedPairs('annotations');
    const edited = {
      ...MCP_TOOL_ANNOTATIONS,
      delete_work_item: { readOnlyHint: true as const, openWorldHint: false },
    };
    expect(driftedSchemas(shipped, (name) => edited[name as McpCatalogueToolName])).toEqual([
      'delete_work_item',
    ]);
  });

  it('REPORTS a regenerated file whose hints moved — the byte guard sees the maps too', async () => {
    const generated = await generateMcpToolSchemas();
    const flipped = generated.replace(/(delete_work_item: \{[^}]*?readOnlyHint: )false/, '$1true');
    expect(flipped).not.toBe(generated);
    expect(isMcpToolSchemasStale(generated, flipped)).toBe(true);
  });

  it('the CATALOGUE row carries the title and hints, not just the maps', async () => {
    const rows = mcpToolRows();
    const byName = new Map(rows.map((row) => [row.name as string, row]));
    expect(driftedSchemas(await shippedPairs('title'), (name) => byName.get(name)?.title)).toEqual(
      [],
    );
    expect(
      driftedSchemas(await shippedPairs('annotations'), (name) => byName.get(name)?.annotations),
    ).toEqual([]);
  });
});

describe('what the schemas actually carry — the three facts a reader needs', () => {
  it('`create_work_item` keeps its required set, its optional fields and its enum', () => {
    // The same subject the route test and the consuming page assert on, so
    // producer and consumer are checked against one example end to end.
    const schema = MCP_TOOL_INPUT_SCHEMAS.create_work_item;
    const properties = schema.properties as Record<string, { enum?: unknown[] }>;
    expect(schema.required).toEqual(expect.arrayContaining(['projectKey', 'kind', 'title']));
    expect(schema.required).not.toContain('storyPoints');
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['storyPoints', 'kind']));
    expect(properties.kind?.enum).toEqual(['epic', 'story', 'task', 'bug', 'subtask']);
  });

  it('a tool that takes NO arguments says so, rather than being absent', () => {
    // `whoami` has `inputSchema: {}` at its registration. The distinction the
    // consumer needs is "this tool takes nothing" versus "this tool's arguments
    // were not published", and an absent key cannot express the first.
    expect(MCP_TOOL_INPUT_SCHEMAS.whoami.type).toBe('object');
    expect(MCP_TOOL_INPUT_SCHEMAS.whoami.properties).toEqual({});
    expect(MCP_TOOL_INPUT_SCHEMAS.whoami.required).toBeUndefined();
  });

  it('nothing is flattened away — a nullable arm and a nested item schema survive', () => {
    // The route header records the choice to emit the schema WHOLE. These are
    // the two shapes a flattened parameter list would have silently dropped.
    const nullable = (MCP_TOOL_INPUT_SCHEMAS.create_work_item.properties as Record<string, unknown>)
      .storyPoints as { anyOf?: unknown[] };
    expect(nullable.anyOf).toBeDefined();
    const list = (MCP_TOOL_INPUT_SCHEMAS.create_work_item.properties as Record<string, unknown>)
      .targetRepos as { type?: string; items?: unknown };
    expect(list.type).toBe('array');
    expect(list.items).toBeDefined();
  });
});

describe('`targetRepos` does not promise to wait for every repository (MOTIR-10135)', () => {
  // Completion follows the pull requests LINKED to the item, each merged onto
  // its repository's default branch; the list records where work ships and no
  // longer holds the item for a repository that needed no change. A schema
  // that still told an agent otherwise would have it open empty pull requests
  // to "complete" a repository.
  const SCHEMAS_WITH_TARGET_REPOS = [
    'create_work_item',
    'update_work_item',
    'add_plan_items',
  ] as const;

  it.each(SCHEMAS_WITH_TARGET_REPOS)(
    '%s says completion follows the linked pull requests',
    (tool) => {
      const text = JSON.stringify(MCP_TOOL_INPUT_SCHEMAS[tool]);
      expect(text).not.toMatch(/does not complete until EVERY repository/i);
      expect(text).not.toMatch(/until EVERY repository on the list/i);
      expect(text).toContain('every pull request LINKED to it');
    },
  );
});
