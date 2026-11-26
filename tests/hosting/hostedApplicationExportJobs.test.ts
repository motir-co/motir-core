import { describe, expect, it, vi, afterEach } from 'vitest';
import { ExportFailedError, ExportNotAllowedError } from '@/lib/hosting/errors';
import {
  HOSTED_APPLICATION_EXPORT_EXPIRY_CRON,
  hostedApplicationExport,
  hostedApplicationExportExpire,
} from '@/lib/jobs/definitions/hostedApplicationExport';
import { jobDefinitions } from '@/lib/jobs/registry';
import { jobServices } from '@/lib/jobs/services';
import { hostedApplicationExportService } from '@/lib/services/hostedApplicationExportService';

// The database export's two jobs (Story MOTIR-9800 · MOTIR-12134): registered,
// each running its one service call in a memoized step; the export job answers
// a refusal instead of throwing it (a retry cannot change it) and throws a
// failed dump, so it is retried.

afterEach(() => {
  vi.restoreAllMocks();
});

function ctxFor<T>(name: string, data: unknown) {
  const run = vi.fn(async (_id: string, fn: () => unknown) => fn());
  const ctx = {
    event: { name, data, id: 'e' },
    runId: 'run',
    attempt: 0,
    step: { run },
  } as unknown as T;
  return { ctx, run };
}

const data = {
  workspaceId: 'ws',
  applicationId: 'app',
  userId: 'u',
  exportId: 'exp-1',
  idempotencyKey: 'exp-1',
};

describe('hosting.application-export', () => {
  type Ctx = Parameters<typeof hostedApplicationExport.handler>[0];

  it('is registered, keyed by the export id, and takes the export the admin asked for', async () => {
    expect(jobDefinitions).toContain(hostedApplicationExport);
    expect(jobServices.hostedApplicationExport).toBe(hostedApplicationExportService);
    const create = vi
      .spyOn(hostedApplicationExportService, 'createExport')
      .mockResolvedValue('exp-1');
    const { ctx, run } = ctxFor<Ctx>('hosting.application-export', data);
    await expect(hostedApplicationExport.handler(ctx, jobServices)).resolves.toEqual({
      outcome: 'stored',
      exportId: 'exp-1',
    });
    expect(run).toHaveBeenCalledWith('take-export', expect.any(Function));
    expect(create).toHaveBeenCalledWith(
      'app',
      { kind: 'on_demand', exportId: 'exp-1' },
      { kind: 'user', userId: 'u' },
    );
  });

  it('answers a refusal rather than throwing it', async () => {
    vi.spyOn(hostedApplicationExportService, 'createExport').mockRejectedValue(
      new ExportNotAllowedError('app', 'not_in_grace'),
    );
    const { ctx } = ctxFor<Ctx>('hosting.application-export', data);
    await expect(hostedApplicationExport.handler(ctx, jobServices)).resolves.toEqual({
      outcome: 'refused',
      code: 'EXPORT_NOT_ALLOWED',
    });
  });

  it('throws a failed dump, so the run is retried', async () => {
    const failure = new ExportFailedError('app', 'dump', 1);
    vi.spyOn(hostedApplicationExportService, 'createExport').mockRejectedValue(failure);
    const { ctx } = ctxFor<Ctx>('hosting.application-export', data);
    await expect(hostedApplicationExport.handler(ctx, jobServices)).rejects.toBe(failure);
  });
});

describe('system.hosted-application-export-expire', () => {
  it('is registered on its daily slot and runs the sweep in its step', async () => {
    expect(jobDefinitions).toContain(hostedApplicationExportExpire);
    expect(HOSTED_APPLICATION_EXPORT_EXPIRY_CRON).toBe('50 5 * * *');
    vi.spyOn(hostedApplicationExportService, 'sweepExpiredExports').mockResolvedValue({
      deleted: 2,
      failed: 0,
    });
    type Ctx = Parameters<typeof hostedApplicationExportExpire.handler>[0];
    const { ctx, run } = ctxFor<Ctx>('system.hosted-application-export-expire', {});
    await expect(hostedApplicationExportExpire.handler(ctx, jobServices)).resolves.toEqual({
      deleted: 2,
      failed: 0,
    });
    expect(run).toHaveBeenCalledWith('sweep-expired-hosting-exports', expect.any(Function));
  });
});
