import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { readCommitActionsSuites } from '@/lib/github/checkRuns';
import { readReportedCheckSet } from '@/lib/services/checkSetReconcile';
import { stubBothAppCredentials } from '../helpers/appCredentials';

// THE HOST READ SEES A WORKFLOW RUN THAT HAS NO JOB YET (MOTIR-6946).
//
// The fixture is the real `GET /commits/688ce704…/check-suites` answer for
// moooon-B-V/motir-core#3261, read while CI's run was queued behind its
// `concurrency` group: three third-party Apps' suites `queued` for ever with no
// runs, the acceptance lane and CodeQL as Actions suites, and CI's own Actions
// suite `in_progress` — the one the check-run read could not see. (At the moment
// of the raise it had zero check runs; by the time this was read it had 40, which
// changes nothing about what the suite reports.)

const HEAD_SHA = '688ce704e'.padEnd(40, '0');

function suite(id: number, slug: string, status: string, conclusion: string | null, runs: number) {
  return {
    id,
    app: { slug },
    status,
    conclusion,
    latest_check_runs_count: runs,
  };
}

const THE_688CE704_SUITES = [
  suite(99154165029, 'vercel', 'queued', null, 0),
  suite(99154165582, 'sentry', 'queued', null, 0),
  suite(99154166057, 'claude', 'queued', null, 0),
  suite(99154195673, 'github-actions', 'completed', 'success', 1),
  suite(99154196040, 'github-actions', 'completed', 'success', 4),
  suite(99154198281, 'github-actions', 'in_progress', null, 0),
  suite(99156784699, 'github-advanced-security', 'completed', 'success', 1),
];

let suitesAnswer: () => Response;
let checkRunsAnswer: () => Response;

beforeEach(() => {
  _resetInstallationTokenCache();
  vi.stubEnv('GITHUB_FALLBACK_ORG', 'moooon');
  stubBothAppCredentials();
  suitesAnswer = () =>
    new Response(JSON.stringify({ total_count: 7, check_suites: THE_688CE704_SUITES }), {
      status: 200,
    });
  checkRunsAnswer = () =>
    new Response(
      JSON.stringify({
        total_count: 1,
        check_runs: [
          {
            name: 'Acceptance complete',
            status: 'completed',
            conclusion: 'success',
            check_suite: { id: 99154196040 },
          },
        ],
      }),
      { status: 200 },
    );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/access_tokens'))
        return new Response(
          JSON.stringify({
            token: 'ghs_suites',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200 },
        );
      if (url.includes('/check-suites')) return suitesAnswer();
      if (url.includes('/check-runs')) return checkRunsAnswer();
      return new Response('{}', { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('readCommitActionsSuites — every Actions workflow run, and nothing else', () => {
  it('reports the three Actions suites as roll-up rows, CI’s queued run PENDING', async () => {
    const rows = await readCommitActionsSuites('inst-suites', 'moooon-B-V', 'motir-core', HEAD_SHA);
    expect(rows).toEqual([
      expect.objectContaining({
        checkName: 'github-actions',
        checkSuiteId: '99154195673',
        conclusion: 'success',
        suiteAggregate: true,
      }),
      expect.objectContaining({
        checkName: 'github-actions',
        checkSuiteId: '99154196040',
        conclusion: 'success',
        suiteAggregate: true,
      }),
      expect.objectContaining({
        checkName: 'github-actions',
        checkSuiteId: '99154198281',
        conclusion: 'pending',
        suiteAggregate: true,
      }),
    ]);
  });

  it('never reports a third-party App’s suite — they sit `queued` for ever with no runs', async () => {
    const rows = await readCommitActionsSuites('inst-suites', 'moooon-B-V', 'motir-core', HEAD_SHA);
    expect(rows!.map((r) => r.checkSuiteId)).not.toEqual(
      expect.arrayContaining(['99154165029', '99154165582', '99154166057', '99156784699']),
    );
  });

  it('a roll-up carries no raw conclusion, so it can never be named a queue exit’s failing check', async () => {
    const rows = await readCommitActionsSuites('inst-suites', 'moooon-B-V', 'motir-core', HEAD_SHA);
    expect(rows!.every((r) => r.rawConclusion === null)).toBe(true);
  });

  it('dates a FINISHED suite by its `updated_at` and a running one by nothing (MOTIR-11827)', async () => {
    suitesAnswer = () =>
      new Response(
        JSON.stringify({
          total_count: 2,
          check_suites: [
            {
              ...suite(1, 'github-actions', 'completed', 'success', 3),
              updated_at: '2026-11-19T15:12:10Z',
            },
            {
              ...suite(2, 'github-actions', 'in_progress', null, 0),
              updated_at: '2026-11-19T15:20:00Z',
            },
          ],
        }),
        { status: 200 },
      );
    const rows = await readCommitActionsSuites('inst-suites', 'moooon-B-V', 'motir-core', HEAD_SHA);
    expect(rows!.map((r) => r.completedAt?.toISOString() ?? null)).toEqual([
      '2026-11-19T15:12:10.000Z',
      null,
    ]);
  });

  it('answers `null` — not an empty set — when the host refuses', async () => {
    suitesAnswer = () => new Response('{"message":"Resource not accessible"}', { status: 403 });
    expect(
      await readCommitActionsSuites('inst-suites', 'moooon-B-V', 'motir-core', HEAD_SHA),
    ).toBeNull();
  });

  it('answers `null` rather than a truncated set past one page', async () => {
    suitesAnswer = () =>
      new Response(JSON.stringify({ total_count: 101, check_suites: THE_688CE704_SUITES }), {
        status: 200,
      });
    expect(
      await readCommitActionsSuites('inst-suites', 'moooon-B-V', 'motir-core', HEAD_SHA),
    ).toBeNull();
  });
});

describe('readReportedCheckSet — the check runs PLUS the Actions workflow runs', () => {
  const args = {
    installationId: 'inst-suites',
    owner: 'moooon-B-V',
    name: 'motir-core',
    commitSha: HEAD_SHA,
  };

  it('carries CI’s pending roll-up beside the acceptance lane’s finished check', async () => {
    const set = await readReportedCheckSet(args);
    expect(set!.map((r) => [r.checkName, r.checkSuiteId, r.conclusion])).toEqual([
      ['Acceptance complete', '99154196040', 'success'],
      ['github-actions', '99154195673', 'success'],
      ['github-actions', '99154196040', 'success'],
      ['github-actions', '99154198281', 'pending'],
    ]);
  });

  it('keeps the check runs — the set that shipped before — when only the suites read fails', async () => {
    suitesAnswer = () => new Response('{}', { status: 502 });
    const set = await readReportedCheckSet(args);
    expect(set!.map((r) => r.checkName)).toEqual(['Acceptance complete']);
  });

  it('is `null` when the check-run read itself has no answer', async () => {
    checkRunsAnswer = () => new Response('{}', { status: 502 });
    expect(await readReportedCheckSet(args)).toBeNull();
  });
});
