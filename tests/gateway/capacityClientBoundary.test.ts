import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE BOUNDARY OF THE GATEWAY CAPACITY TOKEN (MOTIR-9608) — the same scan as
// `tests/hostedRuns/hostedRunKeyBoundary.test.ts` does for the run-key secret:
// `MOTIR_GATEWAY_CAPACITY_TOKEN` is read in exactly one server-only module, and
// no client component names it.

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

describe('the gateway capacity token stays on the server', () => {
  it('is read in exactly one server-only module', () => {
    // A READ names the variable as a string (the env lookup's key); prose that
    // mentions it in a comment does not.
    const readers = files
      .filter(({ text }) => /['"]MOTIR_GATEWAY_CAPACITY_TOKEN['"]/.test(text))
      .map(({ path }) => path);
    expect(readers).toEqual(['lib/gateway/capacityClient.ts']);
    const client = files.find(({ path }) => path === 'lib/gateway/capacityClient.ts');
    expect(client?.text.startsWith("import 'server-only';")).toBe(true);
  });

  it('is named by no client component', () => {
    const clientComponents = files
      .filter(({ text }) => /^['"]use client['"]/m.test(text))
      .filter(({ text }) => text.includes('MOTIR_GATEWAY_CAPACITY_TOKEN'))
      .map(({ path }) => path);
    expect(clientComponents).toEqual([]);
  });
});
