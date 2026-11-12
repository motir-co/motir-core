import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The Server Action SALT is pinned across builds (MOTIR-3948).
//
// Next hashes every Server Action id with the build's `encryptionKey`
// (`serverReferenceHashSalt`), and generates that key randomly per build unless
// `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is set. Unpinned, every release re-salts
// every id: a browser holding the previous build's JavaScript posts ids the new
// build has never heard of and gets a 404 on every write until it reloads.
//
// Nothing about that is visible from a green build — which is why the assertions
// below are about WIRING, in the style `tests/monitoring/sentry-wiring.test.ts`
// established for the release build. The failure they guard against is not a bug
// somebody writes; it is a line somebody deletes while tidying the Dockerfile.

const ROOT = process.cwd();
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const awsDeploy = readFileSync(join(ROOT, '.github', 'workflows', 'aws-deploy.yml'), 'utf8');

const KEY = 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY';

/**
 * The release lane's image build — `aws-deploy.yml`'s build step, comments
 * dropped. The Fly `deploy` job these assertions used to read was deleted by
 * MOTIR-10935; `aws-deploy.yml` is Motir's one deploy lane.
 */
function releaseBuild(): string {
  const code = awsDeploy
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const start = code.indexOf('- name: Build and push the image');
  expect(start).toBeGreaterThan(-1);
  const rest = code.slice(start);
  const next = /\n {6}- (?:name|uses|run):/.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

/** The release build's `build-args:` block alone — the lines indented under it. */
function buildArgs(): string {
  const block = /^( *)build-args: \|\n((?:\1 {2}.*\n)*)/m.exec(releaseBuild());
  expect(block, 'the release build declares build-args').not.toBeNull();
  // Non-vacuity: the block read is the real one, which carries the release sha.
  expect(block![2]).toContain('MOTIR_RELEASE=');
  return block![2]!;
}

/**
 * The single `RUN … next build` instruction, comments dropped and line
 * continuations joined. The comments have to go FIRST: this file explains
 * `next build` at length, and a comment paragraph attaches to whichever
 * instruction precedes it — three chunks match the phrase otherwise, none of
 * them by running the command.
 */
function nextBuildRun(): string {
  const runs = dockerfile
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .split(/\n(?=[A-Z]+ )/)
    .map((instruction) => instruction.replace(/\\\n\s*/g, ' '))
    .filter((instruction) => instruction.startsWith('RUN ') && instruction.includes('next build'));
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

describe('the Dockerfile bakes the salt into the build that uses it', () => {
  it('mounts the key as a build SECRET on the very RUN that calls `next build`', () => {
    // Both halves matter and only together: the salt is applied by `next build`
    // itself, so a mount on any other instruction — or an `ENV` in a stage the
    // build does not run in — configures nothing while reading as solved.
    const run = nextBuildRun();
    expect(run).toContain(`--mount=type=secret,id=${KEY}`);
    expect(run).toContain(`export ${KEY}`);
  });

  it('reads it defensively, so a build with no secret still succeeds', () => {
    // The self-host contract: `docker build` with no secret leaves the value
    // empty, Next falls back to a per-build key, and the image builds. An
    // unguarded `cat` under `set -eu` would fail the build instead.
    expect(nextBuildRun()).toMatch(
      new RegExp(`${KEY}="\\$\\(cat /run/secrets/${KEY} 2>/dev/null \\|\\| true\\)"`),
    );
  });

  it('is never a build ARG — it encrypts the arguments actions close over', () => {
    // A `--build-arg` value is recorded in the build's own metadata. This is the
    // same line the Sentry auth token is on, and for the same reason.
    expect(dockerfile).not.toMatch(new RegExp(`^ARG ${KEY}`, 'm'));
    expect(buildArgs()).not.toContain(KEY);
  });
});

describe('the release build supplies it', () => {
  it('passes it to the image build as a BuildKit SECRET', () => {
    expect(releaseBuild()).toMatch(/^\s*secrets: \|$/m);
    expect(releaseBuild()).toMatch(
      new RegExp(`^\\s*${KEY}=\\$\\{\\{ secrets\\.${KEY} \\}\\}$`, 'm'),
    );
  });
});

describe('the release lane refuses to release without it (MOTIR-11059)', () => {
  const guard = (
    parse(awsDeploy) as {
      jobs: {
        'aws-deploy': { steps: { name?: string; run?: string; env?: Record<string, string> }[] };
      };
    }
  ).jobs['aws-deploy'].steps.find((s) => s.name === 'Assert the Server Action salt is pinned');

  function run(value: string | undefined) {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: process.env['PATH'] ?? '' };
    if (value !== undefined) env[KEY] = value;
    const result = spawnSync('bash', ['-e', '-c', guard!.run!], { env, encoding: 'utf8' });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  }

  it('reads the value from the repository secret, never from a literal', () => {
    expect(guard, 'aws-deploy.yml has the salt guard').toBeDefined();
    expect(guard!.env?.[KEY]).toBe(`\${{ secrets.${KEY} }}`);
  });

  it.each([
    ['empty', ''],
    ['unset', undefined],
  ])(
    'stops the release when the secret is %s, rather than shipping a re-salted build',
    (_, value) => {
      // An empty value is not a degraded release — it is MOTIR-3948, shipped
      // again, silently: the build succeeds, the tasks are healthy, and every open
      // tab loses its writes.
      const { status, out } = run(value);
      expect(status).toBe(1);
      expect(out).toContain(`::error::Missing ${KEY}`);
    },
  );

  it('lets the release through when the salt is pinned', () => {
    const { status, out } = run('c2FsdA==');
    expect(status).toBe(0);
    expect(out).toContain('the Server Action salt is pinned');
  });
});
