import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_MAX_AGE_MINUTES,
  EXIT_BLIND_READ,
  EXIT_CURRENT,
  EXIT_STALE,
  assertFreshness,
  formatResult,
  parseReleaseBody,
} from '../../scripts/deployFreshness.mjs';

// MOTIR-3760 — the reading that says "production is behind `main`", which
// nothing anywhere produced.
//
// On 2026-08-28 a story retiring an entire job engine merged at 07:44:30Z and
// production was still running the retired code at 11:00Z, with 278 references
// to it in the deployed worker bundle. Every signal was green and every signal
// was correct: each one was about a different relationship. Nobody was watching
// the only one that had broken.
//
// Two properties matter and both are asserted here:
//
//   1. The check goes RED on the incident it was written for — a deployment
//      three hours behind, with the age measured from the OLDEST undeployed
//      commit rather than from the size of the gap. A busy hour produces "behind
//      by four commits" and clears it on the next release; "the oldest thing we
//      merged and did not ship has been waiting three hours" is the sentence
//      with an incident behind it.
//
//   2. "Could not read" is a THIRD STATE and is never a pass. Every way this can
//      be blind — an unreachable body, a body that is not a sha, a deployed
//      commit that is not on the trunk at all — has a DELIBERATE NEGATIVE below
//      rather than being trusted because no red run has contradicted it. That is
//      the whole failure class the card is about, one level down: a probe whose
//      failure is indistinguishable from the answer it was looking for.

const ROOT = process.cwd();
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const NOW = new Date('2026-08-28T11:00:00Z');

/** `git log --reverse --format=%H %cI` output, already parsed. */
const commit = (sha: string, committedAt: string) => ({ sha, committedAt });

const verdict = (
  overrides: Partial<Parameters<typeof assertFreshness>[0]> = {},
): ReturnType<typeof assertFreshness> =>
  assertFreshness({
    deployed: A,
    head: B,
    deployedIsAncestor: true,
    undeployed: [commit(B, '2026-08-28T10:50:00Z')],
    now: NOW,
    maxAgeMinutes: DEFAULT_MAX_AGE_MINUTES,
    ...overrides,
  });

describe('the deployed commit is compared against main (MOTIR-3760)', () => {
  it('is CURRENT when production is running the head', () => {
    const result = verdict({ deployed: B, head: B, undeployed: [] });
    expect(result.code).toBe(EXIT_CURRENT);
    expect(result.state).toBe('current');
    expect(result.behindBy).toBe(0);
  });

  it('is BEHIND BUT GREEN inside the ceiling — a release on its way is not a defect', () => {
    // The measured merge→released spread is 21.2–45.2 minutes over nine
    // consecutive successful `main` runs, so a ten-minute-old undeployed commit
    // is the ordinary state of a repository that merged ten minutes ago. A check
    // that went red here would be red on every busy morning, and a check that is
    // red on ordinary mornings is one somebody mutes.
    const result = verdict({ undeployed: [commit(B, '2026-08-28T10:50:00Z')] });
    expect(result.code).toBe(EXIT_CURRENT);
    expect(result.state).toBe('behind-within-grace');
    expect(result.behindBy).toBe(1);
    expect(result.ageMinutes).toBe(10);
  });

  it('goes RED on the 2026-08-28 incident — 3h15m behind', () => {
    // `6dafd2ee8` merged 07:44:30Z; production was still on the previous build
    // at 11:00Z. This is the reading that did not exist that morning.
    const result = verdict({ undeployed: [commit(B, '2026-08-28T07:44:30Z')] });
    expect(result.code).toBe(EXIT_STALE);
    expect(result.state).toBe('stale');
    expect(result.ageMinutes).toBeCloseTo(195.5, 1);
    expect(result.detail).toContain('past the 90-minute ceiling');
  });

  it('measures the age from the OLDEST undeployed commit, not the newest', () => {
    // The inversion that makes a naive version useless: a commit landing five
    // minutes ago does not clear a commit that has been waiting three hours, and
    // a check reading the newest entry would report the three-hour outage as
    // five minutes old and stay green through it.
    const result = verdict({
      undeployed: [commit(B, '2026-08-28T07:44:30Z'), commit(C, '2026-08-28T10:55:00Z')],
      head: C,
    });
    expect(result.code).toBe(EXIT_STALE);
    expect(result.behindBy).toBe(2);
    expect(result.oldestUndeployed?.sha).toBe(B);
  });

  it('takes the ceiling from its argument, so a dispatch can tighten it', () => {
    const commits = [commit(B, '2026-08-28T10:00:00Z')];
    expect(verdict({ undeployed: commits }).code).toBe(EXIT_CURRENT);
    expect(verdict({ undeployed: commits, maxAgeMinutes: 30 }).code).toBe(EXIT_STALE);
  });

  it('reports OFF-TRUNK rather than current when the deployed commit is not an ancestor', () => {
    // ⚠️ THE CASE THAT LOOKS EXACTLY LIKE FRESHNESS. `<deployed>..HEAD` is EMPTY
    // both when production is at the head and when production is running
    // something that is not on the trunk at all — a merge into a stale base, a
    // force-push, a hand-deploy. A check that counted commits would call the
    // second one current, and it is strictly worse than being behind: no later
    // merge corrects it.
    const result = verdict({ deployedIsAncestor: false, undeployed: [] });
    expect(result.code).toBe(EXIT_BLIND_READ);
    expect(result.state).toBe('off-trunk');
    expect(result.detail).toContain('not on the trunk');
  });

  it('refuses an impossible pair of reads instead of averaging them into a verdict', () => {
    const result = verdict({ undeployed: [] });
    expect(result.code).toBe(EXIT_BLIND_READ);
    expect(result.state).toBe('inconsistent');
  });

  it('refuses an unparseable committer date', () => {
    const result = verdict({ undeployed: [commit(B, 'last Tuesday')] });
    expect(result.code).toBe(EXIT_BLIND_READ);
    expect(result.state).toBe('unreadable-date');
  });
});

describe('the release payload is read loudly or not at all', () => {
  it('reads the sha out of the route’s 200 body', () => {
    expect(parseReleaseBody(JSON.stringify({ release: A, state: 'known' }))).toBe(A);
  });

  it('THROWS on the route’s 503 body rather than returning null', () => {
    // A deployment that cannot name its own build is a finding — `aws-deploy.yml`
    // passes `MOTIR_RELEASE=${{ github.sha }}` as a build argument and the
    // Dockerfile's runner stage carries it forward precisely so a production
    // release cannot answer this way.
    // Returning `null` here would let the caller sort it into a state it already
    // has a use for, and the real cause would never be named.
    expect(() => parseReleaseBody(JSON.stringify({ release: null, state: 'unset' }))).toThrow(
      /MOTIR_RELEASE` is unset/,
    );
  });

  it('THROWS on an HTML error page, naming what it actually got', () => {
    expect(() => parseReleaseBody('<!doctype html><title>502 Bad Gateway</title>')).toThrow(
      /did not return JSON/,
    );
  });

  it('THROWS on a value that is not a 40-character sha', () => {
    expect(() => parseReleaseBody(JSON.stringify({ release: 'v1.2.3' }))).toThrow(
      /not a 40-character commit sha/,
    );
    expect(() => parseReleaseBody(JSON.stringify({ release: A.slice(0, 7) }))).toThrow(
      /not a 40-character commit sha/,
    );
  });

  it('THROWS on an empty body', () => {
    expect(() => parseReleaseBody('')).toThrow(/empty body/);
  });
});

describe('the report names the gap on its first screen', () => {
  it('carries the deployed commit, the head, the age and the ceiling', () => {
    const text = formatResult(
      'https://motir-core.fly.dev/api/health/release',
      verdict({ undeployed: [commit(B, '2026-08-28T07:44:30Z')] }),
    );
    expect(text).toContain('STALE');
    expect(text).toContain(A);
    expect(text).toContain(B);
    expect(text).toContain('ceiling 90');
  });
});

describe('the default endpoint is production', () => {
  it("reads app.motir.co, whichever host serves it, not a host's own name", () => {
    const script = readFileSync(join(process.cwd(), 'scripts/assert-deploy-freshness.mjs'), 'utf8');
    expect(script).toContain("const DEFAULT_URL = 'https://app.motir.co/api/health/release';");
    expect(script).not.toContain('fly.dev');
  });
});

describe('the scheduled lane is wired to the script it claims to run', () => {
  // The `sandboxCi.test.ts` shape: a lane whose script is unit-tested here is
  // still worthless if the workflow calls something else, on a trigger that
  // never fires, from a checkout that cannot answer. `env-block-trips-guards`'s
  // lesson in this repository is that a narrowly-triggered workflow can be
  // merged broken and stay green by absence — its first execution is its first
  // failure — so the wiring is asserted from the file rather than from a run.
  const workflow = readFileSync(join(ROOT, '.github/workflows/deploy-freshness.yml'), 'utf8');

  it('runs the script this file tests', () => {
    expect(workflow).toContain('node scripts/assert-deploy-freshness.mjs');
  });

  it('is scheduled AND dispatchable — a lane that only fires on a cron cannot be proved', () => {
    expect(workflow).toMatch(/^\s+- cron: /m);
    expect(workflow).toContain('workflow_dispatch:');
  });

  it('checks out the FULL history', () => {
    // Without this the ancestry walk and the commit list both come back empty,
    // which is byte-identical to "up to date" — the check would report freshness
    // it never established, which is the defect it exists to detect.
    expect(workflow).toContain('fetch-depth: 0');
  });

  it('passes the dispatch input through the environment, never into the script body', () => {
    // An expression inside `run:` is substituted textually before bash sees it.
    expect(workflow).toContain('MAX_AGE_MINUTES: ${{ inputs.max_age_minutes }}');
    expect(workflow).not.toMatch(/--max-age-minutes "?\$\{\{/);
  });

  it('exits with the script’s own code rather than swallowing it', () => {
    // `set -uo pipefail` without `-e` means the assignment does not abort the
    // step, so the exit has to be explicit — the shape `ci-shell-assertion-traps`
    // records, where a pipeline's status silently replaces the assertion's.
    expect(workflow).toContain('exit "$code"');
  });

  it('prints a failing script report to the log and summary before preserving its red exit', () => {
    // `shell: bash` starts GitHub steps with `-e -o pipefail`. Execute the
    // workflow's own body under those flags with a real failing `node` command:
    // a textual `set +e` assertion alone would not prove that `$report`, the
    // summary, and `exit "$code"` are all reached.
    const runBody = workflow.match(/        run: \|\n((?:          .*\n?)+)/)?.[1];
    expect(runBody).toBeDefined();
    const script = runBody!.replace(/^          /gm, '');
    const dir = mkdtempSync(join(tmpdir(), 'motir-deploy-freshness-'));
    const bin = join(dir, 'bin');
    const summary = join(dir, 'summary.md');
    const fakeNode = join(bin, 'node');
    execFileSync('mkdir', ['-p', bin]);
    writeFileSync(fakeNode, '#!/usr/bin/env bash\necho "STALE: behind by 13 hours"\nexit 1\n');
    execFileSync('chmod', ['+x', fakeNode]);

    let error: { status?: number; stdout?: Buffer } | undefined;
    try {
      execFileSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: summary },
        encoding: 'buffer',
      });
    } catch (caught) {
      error = caught as { status?: number; stdout?: Buffer };
    }

    expect(error?.status).toBe(1);
    expect(error?.stdout?.toString()).toContain('STALE: behind by 13 hours');
    expect(readFileSync(summary, 'utf8')).toContain('STALE: behind by 13 hours');
  });
});
