import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// THE RETIREMENT GUARD (Story MOTIR-3418).
//
// ⚠️ IT ASSERTS AN ABSENCE, WHICH IS THE ONLY SHAPE THIS PROPERTY HAS. Four
// story gates used to assert the cutover switch's presence — that a job routed to
// the Postgres engine ran there and not on the vendor, that an unrouted one still
// ran on the vendor, that an event kept needing the old transport while any
// subscriber remained on it. Every one of those sentences names a second engine,
// so retiring the second engine deletes them all, and deleting a guard is
// normally how a property stops being checked.
//
// So the property is RESTATED as its complement. What the epic bought was not
// "the jobs moved" — that is provable from the ledger — but "there is no second
// place a job can run", and the machine-checkable form of that is: the package is
// not installed, nothing imports it, the serve route does not exist, and the
// switch that chose between the two lanes does not exist.
//
// ⚠️ HISTORICAL MENTIONS ARE ALLOWED AND WANTED. The card's own verification
// recipe says `grep -ri inngest` should return "only historical references in
// decision records and comments that explain what was replaced", and this file is
// full of them. A guard that banned the WORD would have been cheaper to write and
// would have deleted the record of why the engine looks the way it does — the
// stepped supervisors, the `lane` column's second enum member, the debounce cap.
// So the assertions below are about IMPORTS, DEPENDENCIES and FILES: the things
// that would make a second lane runnable again.

const repoRoot = resolve(__dirname, '..', '..');

/** Every tracked file matching a pattern, via `git ls-files` — a REF-based read. */
function trackedMatching(pattern: string): string[] {
  const out = execFileSync('git', ['ls-files', '--', pattern], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n').filter((l) => l.length > 0);
}

/** Lines of tracked source matching a regex, via `git grep` — likewise. */
function trackedGrep(pattern: string, ...pathspecs: string[]): string[] {
  try {
    const out = execFileSync('git', ['grep', '-nIE', pattern, '--', ...pathspecs], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return out.split('\n').filter((l) => l.length > 0);
  } catch (err) {
    // `git grep` exits 1 with no output when nothing matched — which is the
    // passing case here, so it must not read as a failure.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

describe('the vendor job runtime is gone, not merely unused', () => {
  it('is not a dependency of this package, in any group', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | unknown
    >;
    const groups = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    const named: string[] = [];
    for (const group of groups) {
      const deps = pkg[group];
      if (!deps || typeof deps !== 'object') continue;
      for (const name of Object.keys(deps as Record<string, string>)) {
        if (/(^|\/)inngest($|[-/])/.test(name)) named.push(`${group}.${name}`);
      }
    }
    expect(named).toEqual([]);
  });

  it('is not in the lockfile — the check the removal is actually provable by', () => {
    // ⚠️ THE MANIFEST IS NOT SUFFICIENT. A transitive dependency reintroducing the
    // SDK would leave `package.json` clean and put the package back in
    // `node_modules`, which is enough for an import to resolve and for a
    // `no-restricted-imports` rule that no longer exists to stay silent.
    const lock = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
    expect(lock.toLowerCase()).not.toContain('inngest');
  });

  it('is imported by no tracked source file', () => {
    // The import forms that would resolve to the package: a bare specifier, a
    // subpath (`inngest/next`, `inngest/types`), and the CLI's bin path.
    const hits = trackedGrep(
      '(from|require\\()[[:space:]]*[\'"]inngest(/[^\'"]*)?[\'"]|node_modules/inngest-cli',
      '.',
      ':!pnpm-lock.yaml',
      ':!tests/jobs/inngest-retired.test.ts',
    );
    expect(hits).toEqual([]);
  });

  it('has no serve route, no client, and no cutover switch', () => {
    // The four files the story deletes, named so a reader of a failure knows
    // WHICH one came back rather than only that something did.
    expect(trackedMatching('app/api/inngest/**')).toEqual([]);
    expect(trackedMatching('lib/jobs/client.ts')).toEqual([]);
    expect(trackedMatching('lib/jobs/engine/cutover.ts')).toEqual([]);
    expect(trackedMatching('lib/jobs/engine/census.ts')).toEqual([]);
  });

  it('reads no `INNGEST_*` environment variable on the shipped path', () => {
    // ⚠️ THE ACCEPTANCE CRITERION THIS ONE SERVES IS ABOUT MONEY, and it is only
    // half checkable here. "The account can be closed" needs BOTH halves: nothing
    // in the shipped path reads a key (this assertion), and nothing in the
    // DEPLOYMENT still supplies one (`fly secrets list -a motir-core`, which no
    // test can reach). The card's own words are "verified by `fly secrets list`
    // and by grepping the shipped path for each variable, not by reading
    // `.env.example`" — so this is the grep half, stated where it can regress.
    //
    // ⚠️ `scripts/plan-seed/` IS EXCLUDED, and it is the one exclusion. That
    // directory is the FROZEN bootstrap snapshot of the original plan — Story 1.6's
    // own cards, which say in their acceptance criteria that the keys must be set
    // in Vercel. Those sentences were true when they were written and are a record
    // of what was built, not configuration anything reads.
    const hits = trackedGrep(
      'INNGEST_(EVENT_KEY|SIGNING_KEY|DEV|BASE_URL|PORT|SERVE_URL)',
      'lib',
      'app',
      'components',
      'Dockerfile',
      '.github',
      'scripts',
      ':!scripts/plan-seed',
    );
    expect(hits).toEqual([]);
  });

  it('leaves no experiment script probing a package the repo does not have', () => {
    // The card's "the abandoned path is itself a deliverable" clause. An
    // unmaintained probe against an absent dependency is not a harmless leftover:
    // it reads as a measurement someone could re-run, and it cannot be run.
    const scripts = trackedMatching('scripts/experiments/*');
    expect(scripts.filter((f) => /inngest/i.test(f))).toEqual([]);
  });
});
