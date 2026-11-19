import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPullRequestBaseRef } from '@/lib/github/pullRequestBase';
import {
  countGithubRequest,
  flushGithubRequestMetricsForTests,
  GITHUB_REQUEST_METRIC,
  GITHUB_REQUEST_METRICS_INTERVAL_MS,
  resetGithubRequestMetricsForTests,
} from '@/lib/monitoring/githubRequestMetrics';

// MOTIR-11842 — a `Motir/Core` EMF metric counting GitHub REST requests per
// caller per minute, so the burst BEFORE a throttle can be attributed afterwards
// in CloudWatch. Counted in memory and written once a minute (one line per
// caller), never a line per request; nothing at all when the namespace is unset.

const SET = {
  MONITORING_CLOUDWATCH_NAMESPACE: 'Motir/Core',
  MONITORING_CLOUDWATCH_SERVICE: 'worker',
};

let written: string[];

beforeEach(() => {
  resetGithubRequestMetricsForTests();
  written = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-11-19T21:57:00Z'));
});

afterEach(() => {
  resetGithubRequestMetricsForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function parsedLines(): Record<string, unknown>[] {
  return written.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('with the namespace unset or blank', () => {
  it.each([{}, { MONITORING_CLOUDWATCH_NAMESPACE: '   ' }])(
    'counts nothing, starts no timer and writes nothing (%o)',
    (env) => {
      const intervals = vi.spyOn(globalThis, 'setInterval');
      countGithubRequest('pullRequestReconcile', env);
      countGithubRequest('mergeChangeRequest', env);
      vi.advanceTimersByTime(GITHUB_REQUEST_METRICS_INTERVAL_MS * 3);
      flushGithubRequestMetricsForTests();
      expect(intervals).not.toHaveBeenCalled();
      expect(written).toEqual([]);
    },
  );
});

describe('with the namespace set', () => {
  it('writes ONE EMF line per caller per minute, carrying its count', () => {
    for (let i = 0; i < 37; i += 1) countGithubRequest('pullRequestReconcile', SET);
    for (let i = 0; i < 4; i += 1) countGithubRequest('mergeChangeRequest', SET);
    expect(written).toEqual([]); // never a line per request

    vi.advanceTimersByTime(GITHUB_REQUEST_METRICS_INTERVAL_MS);

    expect(written.every((line) => line.endsWith('\n') && line.split('\n').length === 2)).toBe(
      true,
    );
    const lines = parsedLines();
    expect(lines).toHaveLength(2);
    const byCaller = Object.fromEntries(lines.map((line) => [line['Caller'], line]));
    expect(byCaller['pullRequestReconcile']).toEqual({
      _aws: {
        Timestamp: Date.parse('2026-11-19T21:58:00Z'),
        CloudWatchMetrics: [
          {
            Namespace: 'Motir/Core',
            Dimensions: [['Service', 'Caller']],
            Metrics: [{ Name: GITHUB_REQUEST_METRIC, Unit: 'Count' }],
          },
        ],
      },
      Service: 'worker',
      Caller: 'pullRequestReconcile',
      [GITHUB_REQUEST_METRIC]: 37,
    });
    expect(byCaller['mergeChangeRequest']?.[GITHUB_REQUEST_METRIC]).toBe(4);
  });

  it('starts each minute from zero, and a quiet minute writes nothing', () => {
    countGithubRequest('webhook.changedPaths', SET);
    vi.advanceTimersByTime(GITHUB_REQUEST_METRICS_INTERVAL_MS);
    expect(parsedLines().map((line) => line[GITHUB_REQUEST_METRIC])).toEqual([1]);

    vi.advanceTimersByTime(GITHUB_REQUEST_METRICS_INTERVAL_MS);
    expect(written).toHaveLength(1);

    countGithubRequest('webhook.changedPaths', SET);
    countGithubRequest('webhook.changedPaths', SET);
    vi.advanceTimersByTime(GITHUB_REQUEST_METRICS_INTERVAL_MS);
    expect(parsedLines().map((line) => line[GITHUB_REQUEST_METRIC])).toEqual([1, 2]);
  });

  it('keeps one counter per process, and an unref’d timer that holds no process open', () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    countGithubRequest('pullRequestReconcile', SET);
    countGithubRequest('pullRequestReconcile', SET);
    expect(intervals).toHaveBeenCalledTimes(1);
    const timer = intervals.mock.results[0]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
  });

  it('publishes as Service="unknown" when the service is unset, as the other publishers do', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    countGithubRequest('mergeQueueEnqueue', { MONITORING_CLOUDWATCH_NAMESPACE: 'Motir/Core' });
    flushGithubRequestMetricsForTests();
    expect(parsedLines()[0]).toMatchObject({ Service: 'unknown', Caller: 'mergeQueueEnqueue' });
  });

  it('carries no token: the line is the namespace, the dimensions and the count only', () => {
    countGithubRequest('pullRequestReconcile', SET);
    flushGithubRequestMetricsForTests();
    const line = parsedLines()[0]!;
    expect(Object.keys(line).sort()).toEqual(
      ['Caller', GITHUB_REQUEST_METRIC, 'Service', '_aws'].sort(),
    );
  });
});

describe('a read leaf counts every request it sends, retries included', () => {
  it('a read throttled once is two requests on its caller', async () => {
    vi.stubEnv('MONITORING_CLOUDWATCH_NAMESPACE', SET.MONITORING_CLOUDWATCH_NAMESPACE);
    vi.stubEnv('MONITORING_CLOUDWATCH_SERVICE', SET.MONITORING_CLOUDWATCH_SERVICE);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 429 }))
        .mockResolvedValue(
          new Response(JSON.stringify({ base: { ref: 'main' } }), { status: 200 }),
        ),
    );
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'Date'] });

    const read = readPullRequestBaseRef('ghs_t', 'motir-co', 'motir-core', 7, {
      caller: 'pullRequestBaseRefBackfill',
      installationId: '144235820',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(read).resolves.toEqual({ kind: 'answered', baseRef: 'main' });

    flushGithubRequestMetricsForTests();
    expect(parsedLines()).toEqual([
      expect.objectContaining({ Caller: 'pullRequestBaseRefBackfill', [GITHUB_REQUEST_METRIC]: 2 }),
    ]);
  });
});
