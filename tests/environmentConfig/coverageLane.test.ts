// MOTIR-9967 — the repository-environment story's coverage lane names the story's
// files, and every name resolves. With `all: true` a NAMED file that exists is
// reported even when no suite loads it (and then fails the floor at 0%); a name
// that matches no file is reported as nothing at all, which looks exactly like a
// pass. So the lane fails here if a named file or glob matches nothing.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '..', '..');
const CONFIG = 'vitest.coverage.environment-config.config.ts';
const config = readFileSync(join(REPO, CONFIG), 'utf8');
const globsIn = (block: RegExp) =>
  [...(config.match(block)?.[1] ?? '').matchAll(/^\s*'([^']+\.tsx?)',?$/gm)].map((m) => m[1]!);
const measured = globsIn(/const MEASURED = \[([\s\S]*?)\n\];/);
const shared = globsIn(/SHARED_NOT_FLOORED = \[([\s\S]*?)\n\];/);
const included = globsIn(/include: \[([\s\S]*?)\n {4}\],/);
// The one glob, and the three doors it must match. Named rather than walked, so
// this stays a bounded read and out of the structural-guards lane.
const DOORS_GLOB = 'app/api/projects/**/environments/**/route.ts';
const DOORS = ['changes', 'entries', 'entries/[name]'].map(
  (door) =>
    `app/api/projects/[key]/repositories/[rowId]/environments/[environment]/${door}/route.ts`,
);

describe('the environment-config coverage lane', () => {
  it('names each file once — floored or shared, never both — and every name matches a file', () => {
    expect(measured).toEqual(
      expect.arrayContaining([
        'lib/services/environmentConfigService.ts',
        'lib/environmentConfig/resolveEnvironment.ts',
        DOORS_GLOB,
      ]),
    );
    expect(new Set([...measured, ...shared]).size).toBe(measured.length + shared.length);
    for (const file of [...measured, ...shared]) {
      if (file === DOORS_GLOB) continue;
      expect(file, file).not.toContain('*');
      expect(existsSync(join(REPO, file)), file).toBe(true);
    }
    for (const door of DOORS) expect(existsSync(join(REPO, door)), door).toBe(true);
  });

  it('measures no client file', () => {
    for (const pattern of measured) {
      expect(pattern).not.toMatch(/^app\/\(authed\)/);
      expect(pattern).not.toBe('lib/environmentConfig/client.ts');
    }
  });

  it('runs suites that exist, the story gate among them', () => {
    expect(included).toContain('tests/environmentConfig/storyIntegration.test.ts');
    for (const file of included) expect(existsSync(join(REPO, file)), file).toBe(true);
  });

  it('floors per file at 90 on all four measures', () => {
    expect(config).toContain('perFile: true');
    expect(config).toContain('statements: 90, functions: 90, branches: 90, lines: 90');
  });

  it('is run by its package.json script and by its own CI job', () => {
    const scripts = (
      JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['coverage:environment-config']).toContain(CONFIG);
    const ci = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toMatch(/\n {2}story-9795-coverage:\n/);
    expect(ci).toMatch(/\n {6}- run: pnpm coverage:environment-config\n/);
    expect(ci).toMatch(/\n {8}story-9795-coverage,\n/);
  });
});
