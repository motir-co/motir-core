import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CostExplorerHistoryUnavailableError } from '@/lib/awsCost/costExplorerReader';
import { db } from '@/lib/db';
import { main, parseArgs, run } from '@/scripts/backfill-aws-costs';
import { adminDb } from '../helpers/adminDb';

// `pnpm db:backfill:aws-costs` (MOTIR-11712): the CLI over the backfill service,
// against the real database with Cost Explorer stood in.

const NOW = new Date('2026-11-18T06:12:00Z');

function capture() {
  const log: string[] = [];
  const error: string[] = [];
  return {
    out: { log: (l: string) => log.push(l), error: (l: string) => error.push(l) },
    log,
    error,
  };
}

const reader = (oldest: string) => ({
  async readDailyCosts(from: string) {
    if (from < oldest) throw new CostExplorerHistoryUnavailableError('too old');
    return [{ day: from, recordType: 'Usage', service: 'Amazon S3', amountMicroUsd: 1_000_000 }];
  },
});

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "aws_cost_day", "aws_cost_fetch"');
  vi.unstubAllEnvs();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('parseArgs', () => {
  it('reads --dry-run and --max-months, and refuses anything else', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, maxMonths: 38 });
    expect(parseArgs(['--dry-run', '--max-months=13'])).toEqual({ dryRun: true, maxMonths: 13 });
    for (const bad of ['--max-months=2', '--max-months=39', '--max-months=x', '--max-months=']) {
      expect(() => parseArgs([bad])).toThrow('takes a whole number from 3 to 38');
    }
    expect(() => parseArgs(['--apply'])).toThrow('unknown argument: --apply');
  });
});

describe('run', () => {
  it('a dry run lists the months and reads nothing', async () => {
    const { out, log } = capture();
    expect(await run(['--dry-run', '--max-months=4'], { out, now: NOW })).toBe(0);
    expect(log).toEqual([
      '[backfill-aws-costs] DRY RUN — nothing will be read or written.',
      '[backfill-aws-costs] would read 2 month(s), newest first: 2026-09, 2026-08. Each is one billed Cost Explorer request or more.',
      '[backfill-aws-costs] done. Re-run without --dry-run to read them.',
    ]);
    expect(await adminDb.awsCostFetch.count()).toBe(0);
  });

  it('stores each month back to the oldest Cost Explorer holds, and says why it stopped', async () => {
    const { out, log } = capture();
    expect(await run([], { out, now: NOW, reader: reader('2026-08-01') })).toBe(0);
    expect(log).toEqual([
      '[backfill-aws-costs]   2026-09: stored 1 line(s).',
      '[backfill-aws-costs]   2026-08: stored 1 line(s).',
      '[backfill-aws-costs] stored 2 month(s) (2026-09 back to 2026-08) — stopped: Cost Explorer holds no older month.',
      '[backfill-aws-costs] done.',
    ]);
    expect(await adminDb.awsCostDay.count()).toBe(2);
  });

  it('says so when no month was older than the current two', async () => {
    const { out, log } = capture();
    expect(await run([], { out, now: NOW, reader: reader('2030-01-01') })).toBe(0);
    expect(log[0]).toBe(
      '[backfill-aws-costs] stored 0 month(s) — stopped: Cost Explorer holds no older month.',
    );
  });

  it('fails with no role configured, and on an interruption', async () => {
    vi.stubEnv('AWS_COST_EXPLORER_ROLE_ARN', '');
    const a = capture();
    expect(await run([], { out: a.out, now: NOW })).toBe(1);
    expect(a.error).toEqual([
      '[backfill-aws-costs] AWS_COST_EXPLORER_ROLE_ARN is not set — nothing was read.',
    ]);

    const controller = new AbortController();
    controller.abort();
    const b = capture();
    expect(
      await run([], {
        out: b.out,
        now: NOW,
        reader: reader('2000-01-01'),
        signal: controller.signal,
      }),
    ).toBe(1);
    expect(b.log).toEqual(['[backfill-aws-costs] stored 0 month(s) — stopped: INTERRUPTED.']);
    expect(b.error[0]).toContain('INTERRUPTED');
  });
});

describe('main', () => {
  it('wires SIGINT to stop after the month in flight, and unhooks it after', async () => {
    vi.stubEnv('AWS_COST_EXPLORER_ROLE_ARN', '');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
    const before = process.listenerCount('SIGINT');
    const pending = main([]);
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGINT', 'SIGINT');
    expect(await pending).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(before);
    expect(errors.filter((l) => l.includes('SIGINT received'))).toHaveLength(1);
  });
});
