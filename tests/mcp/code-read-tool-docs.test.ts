import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// THE CODE-READ TOOLS' TEXT HOMES (Story MOTIR-7858 · Subtask MOTIR-7865) — the
// half of the code-read table guard whose subject is a document: `docs/mcp.md`,
// `docs/decisions/member-facing-permissions.md` and `design/mcp-server/build.py`
// each name all four tools (`code_grep` since MOTIR-10066). Split out of `code-read-tool-tables.test.ts` so it
// imports nothing from `lib/` (the registry pulls in the auth wiring) and can
// run in the docs-guard lane, which a docs-only pull request still executes.

const CODE_READ_TOOLS = ['read_file', 'code_explore', 'code_search', 'code_grep'] as const;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const docsMcp = read('docs/mcp.md');
const docHeadings = docsMcp.split('\n').filter((l) => /^#{1,6}\s/.test(l));
const buildPy = read('design/mcp-server/build.py');
const permissionsAdr = read('docs/decisions/member-facing-permissions.md');

describe.each(CODE_READ_TOOLS)('%s — every text home names it', (tool) => {
  it('is documented under a heading in docs/mcp.md', () => {
    expect(
      docHeadings.some((h) => h.includes(`\`${tool}\``)),
      `docs/mcp.md has no heading naming \`${tool}\``,
    ).toBe(true);
  });

  it('is named in design/mcp-server/build.py and the ai:plan amendment', () => {
    expect(buildPy).toContain(`"${tool}":`);
    expect(permissionsAdr).toContain(`\`${tool}\``);
  });
});
