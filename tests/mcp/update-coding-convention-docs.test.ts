import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// `update_coding_convention`'s TEXT HOMES (MOTIR-10183, criterion 6) — the half of
// the tool's guard whose subject is a document: `docs/mcp.md` documents it after
// `get_coding_convention` with its gate and refusals, `design/mcp-server/build.py`
// carries its summary, and `docs/decisions/member-facing-permissions.md` records
// that it makes `ai:configure` grantable. Split out of
// `update-coding-convention.test.ts` so it imports nothing from `lib/` and opens no
// database, and can run in the docs-guard lane, which a docs-only pull request
// still executes.

const TOOL = 'update_coding_convention';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe(`${TOOL} — every text home documents it`, () => {
  it('has its own section in docs/mcp.md, after get_coding_convention, naming its gate and refusals', () => {
    const doc = read('docs/mcp.md');
    const start = doc.indexOf(`#### \`${TOOL}\``);
    expect(start).toBeGreaterThan(doc.indexOf('#### `get_coding_convention`'));
    const section = doc.slice(start, doc.indexOf('\n#### ', start + 1));
    for (const word of [
      '`ai:configure`',
      '`CONVENTION_BLANK`',
      '`CONVENTION_TOO_LONG`',
      '`CONVENTION_VERSION_CONFLICT`',
      '`baseVersion`',
    ]) {
      expect(section).toContain(word);
    }
  });

  it('is summarised in design/mcp-server/build.py', () => {
    expect(read('design/mcp-server/build.py')).toContain(`"${TOOL}":`);
  });

  it('is recorded in the member-facing-permissions ADR as what makes ai:configure grantable', () => {
    const adr = read('docs/decisions/member-facing-permissions.md');
    expect(adr).toMatch(/## AMENDMENT 5[^\n]*`ai:configure`[^\n]*grantable[^\n]*MOTIR-10183/);
  });
});
