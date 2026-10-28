import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// NOTHING PROMOTES ITSELF (Story MOTIR-704 · MOTIR-710; decision MOTIR-706 v2
// §3.6). The starter library changes only when a Motir operator decides it
// should, so the two curation methods have exactly two callers: the operator
// routes. A job, a webhook, a plan approval or an agent run that called either
// would let the registry change with no person behind it — this scan turns such
// a call into a red build rather than a review finding.

const ROUTES = {
  promote: 'app/api/platform/seed-registry/promote/route.ts',
  retire: 'app/api/platform/seed-registry/[key]/retire/route.ts',
};

const SOURCE_ROOTS = ['app', 'lib', 'components', 'scripts', 'packages'];
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs)$/;

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE_FILE.test(entry.name) ? [path] : [];
  });
}

function callersOf(method: 'promote' | 'retire'): string[] {
  const call = new RegExp(`seedRegistryPromotionService\\s*\\.\\s*${method}\\b`);
  return SOURCE_ROOTS.flatMap(sourceFiles)
    .filter((file) => call.test(readFileSync(file, 'utf8')))
    .sort();
}

describe('the curation methods are called only by the operator routes', () => {
  it.each(['promote', 'retire'] as const)('%s', (method) => {
    expect(callersOf(method)).toEqual([ROUTES[method]]);
  });
});
