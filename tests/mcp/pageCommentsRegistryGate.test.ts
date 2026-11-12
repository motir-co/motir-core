import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/toolAnnotations';
import { EXEMPT_TOOLS } from '@/lib/mcp/payloads/exemptions';
import { mcpToolArgs } from '../helpers/mcpToolArgs';

// THE PAGE-COMMENT TOOL TABLES (Story MOTIR-10869 · MOTIR-10982) — the
// post-merge registry gate for `get_page_comments` (MOTIR-10978) and
// `add_page_comment` (MOTIR-10979). No DB, no token, no MCP server.
//
// Same argument as `code-read-tool-tables.test.ts`: `TOOL_PERMISSIONS`,
// `TOOL_SCOPES`, `TOOL_ANNOTATIONS` and `mcpToolArgs` are
// `Record<McpToolName, …>`, so a MISSING row is a compile error and this file
// pins the VALUE. `EXEMPT_TOOLS` is a plain object literal the compiler cannot
// see into.
//
// THE ONE FACT NO COMPILER SEES. Both tools are payload-exempt because no
// `/api/v1` operation returns a page's comments. That is a claim about
// `app/api/v1/pages/[pageId]`, so this file lists that directory at run time:
// the day a comments segment appears there, both exemptions are defects and
// this goes red.
//
// DELIBERATELY NOT PINNED HERE (each has one owner already):
//   - the payload column — `payload-seam.test.ts` (`DERIVED_TOOL_NAMES` typed
//     over `Exclude<McpToolName, ExemptToolName>`) and `drift-guard.test.ts`;
//   - `CLI_TOKEN_GRANT` — `scopes.test.ts` pins it as an exact sorted set;
//   - catalogue summaries / fingerprint — `tool-doc-truth`, `tool-schema-truth`;
//   - what `tools/list` SERVES — the end-to-end receipt (MOTIR-10981).
//
// Both predicates are extracted and driven in reverse below: a guard proved
// only to pass is a comment.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE_RESOURCE_DIR = join(REPO_ROOT, 'app', 'api', 'v1', 'pages', '[pageId]');

const EXPECTED = {
  get_page_comments: { permission: 'page:view', scope: 'read' },
  add_page_comment: { permission: 'comment:add', scope: 'work_items:write' },
} as const satisfies Record<string, { permission: PermissionKey; scope: string }>;

type PageCommentTool = keyof typeof EXPECTED;
const PAGE_COMMENT_TOOLS = Object.keys(EXPECTED) as PageCommentTool[];

/** The tools whose permission row differs from the expected key. */
function mismatchedPermissions(
  permissions: Readonly<Record<string, PermissionKey>>,
  expected: Readonly<Record<string, { permission: PermissionKey }>> = EXPECTED,
): string[] {
  return Object.entries(expected)
    .filter(([tool, { permission }]) => permissions[tool] !== permission)
    .map(([tool]) => tool);
}

/** The entries of a directory listing that name a comments resource. */
function commentsSegmentsIn(entries: readonly string[]): string[] {
  return entries.filter((e) => /comment/i.test(e));
}

const fixtureArgs = mcpToolArgs({
  projectKey: 'PROD',
  item1: 'PROD-1',
  item2: 'PROD-2',
  sprintId: 's',
  planId: 'p',
  pageId: 'g',
});

describe.each(PAGE_COMMENT_TOOLS)('%s — every McpToolName home carries its value', (tool) => {
  it('is registered', () => {
    expect(MCP_TOOL_NAMES).toContain(tool);
  });

  it('is gated on its permission key and filed under its retired scope', () => {
    expect(TOOL_PERMISSIONS[tool]).toBe(EXPECTED[tool].permission);
    expect(TOOL_SCOPES[tool]).toBe(EXPECTED[tool].scope);
  });

  it('has a payload exemption with a non-empty reason', () => {
    expect(EXEMPT_TOOLS, `${tool} has no row in lib/mcp/payloads/exemptions.ts`).toHaveProperty(
      tool,
    );
    const reason = (EXEMPT_TOOLS as Record<string, unknown>)[tool];
    expect(typeof reason).toBe('string');
    expect(String(reason).trim().length).toBeGreaterThan(0);
  });

  it('has a fixture in tests/helpers/mcpToolArgs.ts aimed at the seeded project', () => {
    expect(fixtureArgs[tool]).toMatchObject({ projectKey: 'PROD', pageId: 'g' });
  });
});

describe('annotation rows, by value', () => {
  it('get_page_comments is read-only and closed-world', () => {
    expect(TOOL_ANNOTATIONS.get_page_comments.readOnlyHint).toBe(true);
    expect(TOOL_ANNOTATIONS.get_page_comments.openWorldHint).toBe(false);
  });

  it('add_page_comment writes but destroys nothing', () => {
    expect(TOOL_ANNOTATIONS.add_page_comment).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });
});

describe('mismatchedPermissions', () => {
  it('is empty over the real TOOL_PERMISSIONS', () => {
    expect(mismatchedPermissions(TOOL_PERMISSIONS)).toEqual([]);
  });

  it('names exactly the tool whose key was changed', () => {
    const perturbed = { ...TOOL_PERMISSIONS, add_page_comment: 'page:view' as PermissionKey };
    expect(mismatchedPermissions(perturbed)).toEqual(['add_page_comment']);
  });
});

describe('the exemptions’ stated reason — no v1 comments resource on a page', () => {
  const entries = readdirSync(PAGE_RESOURCE_DIR);

  it('lists a real page resource directory', () => {
    expect(entries).toContain('route.ts');
  });

  it('holds no comments segment', () => {
    expect(
      commentsSegmentsIn(entries),
      `${PAGE_RESOURCE_DIR} now publishes a comments resource — both page-comment ` +
        'exemptions in lib/mcp/payloads/exemptions.ts are defects: derive the payloads',
    ).toEqual([]);
  });

  it('commentsSegmentsIn names exactly a comments entry in a synthetic listing', () => {
    expect(commentsSegmentsIn([...entries, 'comments'])).toEqual(['comments']);
  });
});
