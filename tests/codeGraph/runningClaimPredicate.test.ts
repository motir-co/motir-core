import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CODE_GRAPH_CLAIMING_FUNCTION_IDS } from '@/lib/repositories/jobRunRepository';

// THE RUNNING-CLAIM PREDICATE HAS ONE HOME (bug MOTIR-10821).
//
// Since MOTIR-9454 a first INDEX and a REFRESH both claim a repository with their
// own `job_run` id. The read that decides "is the claimed run still running" had
// three copies — one in `jobRunRepository` and two inline in services — and all
// three counted only `system.code-graph-index`, so a refresh in flight read
// `stale` everywhere a state is shown. The terminal read beside it had already
// been widened to both functions; nothing made the running read follow.
//
// So the predicate now lives once, in `lib/repositories/jobRunRepository.ts`, and
// this file fails if an inline copy of it reappears anywhere else under `lib/`.
// Asserted lexically: a second copy compiles perfectly and is simply a different
// answer on a different screen.

const HOME = 'lib/repositories/jobRunRepository.ts';

/**
 * A `job_run` filter naming a code-graph claiming job AND `status: 'running'`
 * inside one object literal, in either order. `[^{}]*` keeps both keys in the
 * same braces, so a `where` that merely mentions both in sibling objects does not
 * match.
 */
const FUNCTION = String.raw`functionId:\s*(?:['"]system\.code-graph-(?:index|refresh)['"]|\{\s*in:[^{}]*system\.code-graph[^{}]*\})`;
const RUNNING = String.raw`status:\s*['"]running['"]`;
const INLINE_RUNNING_CLAIM = new RegExp(
  String.raw`\{[^{}]*(?:${FUNCTION}[^{}]*${RUNNING}|${RUNNING}[^{}]*${FUNCTION})`,
);

/** The four readers that turn `indexing_run_id` into `indexing`. */
const CALLERS = [
  'lib/services/codeContextService.ts',
  'lib/services/organizationRepoService.ts',
  'lib/services/projectStateService.ts',
  'lib/services/migrateOnboardingService.ts',
];

describe('the running-claim predicate is defined once (bug MOTIR-10821)', () => {
  it('names both claiming jobs', () => {
    expect([...CODE_GRAPH_CLAIMING_FUNCTION_IDS].sort()).toEqual([
      'system.code-graph-index',
      'system.code-graph-refresh',
    ]);
  });

  it('the pattern catches the inline shape the bug shipped, in either key order', () => {
    // Without this the guard below could pass by matching nothing at all.
    expect(
      INLINE_RUNNING_CLAIM.test(`{ functionId: 'system.code-graph-index', status: 'running' }`),
    ).toBe(true);
    expect(
      INLINE_RUNNING_CLAIM.test(
        `where: {\n  status: 'running',\n  functionId: 'system.code-graph-refresh',\n}`,
      ),
    ).toBe(true);
    expect(
      INLINE_RUNNING_CLAIM.test(
        `{ functionId: { in: ['system.code-graph-index', 'system.code-graph-refresh'] }, status: 'running' }`,
      ),
    ).toBe(true);
    // A terminal read, and an unrelated running read, are not the predicate.
    expect(
      INLINE_RUNNING_CLAIM.test(
        `{ functionId: 'system.code-graph-index', status: { in: ['failed'] } }`,
      ),
    ).toBe(false);
    expect(INLINE_RUNNING_CLAIM.test(`{ functionId: 'email.send', status: 'running' }`)).toBe(
      false,
    );
  });

  it('no file under lib/ other than the repository carries an inline copy', () => {
    const files = execSync("git ls-files 'lib/*.ts' 'lib/*.tsx'", { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(100);

    const offenders = files
      .filter((file) => file !== HOME)
      .filter((file) => INLINE_RUNNING_CLAIM.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('every reader asks the repository, over both claiming jobs', () => {
    for (const file of CALLERS) {
      expect(readFileSync(file, 'utf8'), file).toMatch(
        /jobRunRepository\.listRunningCodeGraphRunIds(Among)?\(/,
      );
    }
    const home = readFileSync(HOME, 'utf8');
    expect(home).not.toMatch(/listRunningCodeGraphIndexRunIds/);
    // The terminal read and the running read share the one list of jobs.
    expect(home.match(/\[\.\.\.CODE_GRAPH_CLAIMING_FUNCTION_IDS\]/g)?.length).toBe(2);
  });
});
