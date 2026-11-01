import { describe, expect, it } from 'vitest';
import {
  MCP_TOOL_ANNOTATIONS,
  MCP_TOOL_INPUT_SCHEMAS,
  MCP_TOOL_TITLES,
} from '@/lib/apiDocs/mcpToolSchemas';
import { mcpToolRows } from '@/lib/apiDocs/mcp';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/toolAnnotations';
import { EXEMPT_TOOLS } from '@/lib/mcp/payloads/exemptions';
import { mcpToolArgs } from '../helpers/mcpToolArgs';

// THE CODE-READ TOOL TABLES (Story MOTIR-7858 · Subtask MOTIR-7865) — every home
// keyed by an MCP tool name carries all four code-read tools (`code_grep` since
// MOTIR-10066), with the value the story decided. No DB.
//
// ⚠️ THE HOME LIST IS A MEASUREMENT, not a memory. It is the output of
//
//     git grep -l get_code_health origin/main -- lib docs design tests
//
// (`get_code_health` is the nearest precedent: an `ai:plan` planning read on the
// MCP), minus the files that are `get_code_health`'s OWN (its tool, DTO, service
// and test) and the guard suites that loop the registry themselves
// (`permission-gate`, `scopes`, `story-roundtrip`, `mcp-doc-guards`). Re-run it
// when a home is added; a name it prints that this file does not assert is one
// more assertion here.
//
// WHY A GUARD WHEN `tsc` ALREADY CHECKS SOME OF THESE. `TOOL_PERMISSIONS`,
// `TOOL_SCOPES`, `TOOL_ANNOTATIONS`, the three `mcpToolSchemas.ts` maps and the
// `mcpToolArgs` map are `Record<McpToolName, …>`, so a MISSING row is already a
// compile error — for those this file pins the VALUE (the `ai:plan` gate, the
// `read` scope, read-only). `EXEMPT_TOOLS` is a plain object literal, and
// `docs/mcp.md`, `docs/decisions/member-facing-permissions.md` and
// `design/mcp-server/build.py` are text: a missing row there is invisible to the
// compiler, and THAT is what this guard exists for. Those three TEXT homes are
// asserted in `code-read-tool-docs.test.ts`, which imports nothing from `lib/` so
// it can run in the database-free docs-guard lane on a docs-only pull request.

const CODE_READ_TOOLS = [
  'read_file',
  'list_changed_files',
  'code_explore',
  'code_search',
  'code_grep',
] as const;

const catalogue = new Map(mcpToolRows().map((r) => [r.name as string, r]));
const fixtureArgs = mcpToolArgs({
  projectKey: 'PROD',
  item1: 'PROD-1',
  item2: 'PROD-2',
  sprintId: 's',
  planId: 'p',
  pageId: 'g',
});

describe.each(CODE_READ_TOOLS)('%s — every McpToolName home carries it', (tool) => {
  it('is registered, gated on ai:plan, scoped read, annotated read-only', () => {
    expect(MCP_TOOL_NAMES).toContain(tool);
    expect(TOOL_PERMISSIONS[tool]).toBe('ai:plan');
    expect(TOOL_SCOPES[tool]).toBe('read');
    expect(TOOL_ANNOTATIONS[tool].readOnlyHint).toBe(true);
  });

  it('has a payload exemption with a reason', () => {
    expect(EXEMPT_TOOLS, `${tool} has no row in lib/mcp/payloads/exemptions.ts`).toHaveProperty(
      tool,
    );
    expect(String((EXEMPT_TOOLS as Record<string, unknown>)[tool]).length).toBeGreaterThan(0);
  });

  it('has a schema, a title and its hints in lib/apiDocs/mcpToolSchemas.ts', () => {
    expect(MCP_TOOL_INPUT_SCHEMAS[tool]).toBeTruthy();
    expect(MCP_TOOL_TITLES[tool]).toBeTruthy();
    expect(MCP_TOOL_ANNOTATIONS[tool]?.readOnlyHint).toBe(true);
  });

  it('has a row in the lib/apiDocs/mcp.ts catalogue, on ai:plan', () => {
    const row = catalogue.get(tool);
    expect(row, `${tool} is missing from mcpToolRows()`).toBeTruthy();
    expect(row!.permission).toBe('ai:plan');
    expect(row!.summary.length).toBeGreaterThan(0);
  });

  it('has a fixture in tests/helpers/mcpToolArgs.ts', () => {
    expect(fixtureArgs[tool]).toMatchObject({ projectKey: 'PROD' });
  });
});
