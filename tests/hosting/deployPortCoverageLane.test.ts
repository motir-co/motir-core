// MOTIR-9806 — the deploy-interface story's coverage lane names the story's files,
// and every name resolves. With `all: true` a NAMED file that exists is reported
// even when no suite loads it (and then fails the floor at 0%); a name that
// matches no file is reported as nothing at all, which looks exactly like a pass.
// So the lane fails here if a named file is missing.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '..', '..');
const CONFIG = 'vitest.coverage.deploy-port.config.ts';
const config = readFileSync(join(REPO, CONFIG), 'utf8');
// A glob escapes the brackets of a Next.js segment (`\\[key\\]`); the file has none.
const globsIn = (block: RegExp) =>
  [...(config.match(block)?.[1] ?? '').matchAll(/^\s*'([^']+\.tsx?)',?$/gm)].map((m) =>
    m[1]!.replace(/\\\\/g, ''),
  );
const measured = globsIn(/const MEASURED = \[([\s\S]*?)\n\];/);
const shared = globsIn(/SHARED_NOT_FLOORED = \[([\s\S]*?)\n\];/);
const included = globsIn(/include: \[([\s\S]*?)\n {4}\],/);

describe('the deploy-port coverage lane', () => {
  it('names each file once — floored or shared, never both — and every name is a real file', () => {
    expect(measured).toEqual(
      expect.arrayContaining([
        'lib/hosting/manifest.ts',
        'lib/hosting/errors.ts',
        'lib/hosting/deployCheck.ts',
      ]),
    );
    expect(shared).toContain('lib/orchestrator/index.ts');
    expect(new Set([...measured, ...shared]).size).toBe(measured.length + shared.length);
    for (const file of [...measured, ...shared])
      expect(existsSync(join(REPO, file)), file).toBe(true);
  });

  it('runs suites that exist, the story gate among them', () => {
    expect(included).toContain('tests/hosting/manifestToDeploy.test.ts');
    for (const file of included) expect(existsSync(join(REPO, file)), file).toBe(true);
  });

  it('floors per file at 90 on all four measures, and leaves the port to its package', () => {
    expect(config).toContain('perFile: true');
    expect(config).toContain('statements: 90, functions: 90, branches: 90, lines: 90');
    // The orchestrator port is floored by its own package suite. The hosting
    // guard (MOTIR-9947) has no package suite — its tests are root ones that run
    // the server against a local upstream — so it is floored HERE, and is the
    // one package file allowed.
    for (const file of [...measured, ...shared]) {
      expect(file).not.toMatch(/^packages\/(?!hosting-guard\/)/);
    }
    expect(measured).toContain('packages/hosting-guard/src/guard.ts');
  });

  it('is run by its package.json script and by its own CI job', () => {
    const scripts = (
      JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['coverage:deploy-port']).toContain(CONFIG);
    const ci = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toMatch(/\n {6}- run: pnpm coverage:deploy-port\n/);
    expect(ci).toMatch(/\n {8}story-9791-coverage,\n/);
  });
});
