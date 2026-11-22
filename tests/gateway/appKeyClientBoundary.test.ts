import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE BOUNDARY OF THE TENANT-APP KEY SECRET (MOTIR-8339): `MOTIR_APP_KEY_MINT_SECRET`
// is read in exactly one server-only module — the app-key client — and no client
// component names it. It mirrors tests/hostedRuns/hostedRunKeyBoundary.test.ts for
// the run-key secret, which stays unchanged.

const ROOT = join(__dirname, '..', '..');
const SCANNED = ['lib', 'app', 'components', 'packages'];
const SKIP = new Set(['node_modules', 'dist', '.next', 'generated']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

const files = SCANNED.flatMap((dir) => sourceFiles(join(ROOT, dir))).map((full) => ({
  path: relative(ROOT, full),
  text: readFileSync(full, 'utf8'),
}));

describe('the app-key mint secret stays on the server', () => {
  it('is read in exactly one server-only module', () => {
    const readers = files
      .filter(({ text }) => /['"]MOTIR_APP_KEY_MINT_SECRET['"]/.test(text))
      .map(({ path }) => path);
    expect(readers).toEqual(['lib/gateway/appKeyClient.ts']);
    const client = files.find(({ path }) => path === 'lib/gateway/appKeyClient.ts');
    expect(client?.text.startsWith("import 'server-only';")).toBe(true);
  });

  it('is named by no client component', () => {
    const clientComponents = files
      .filter(({ text }) => /^['"]use client['"]/m.test(text))
      .filter(({ text }) => text.includes('MOTIR_APP_KEY_MINT_SECRET'))
      .map(({ path }) => path);
    expect(clientComponents).toEqual([]);
  });
});
