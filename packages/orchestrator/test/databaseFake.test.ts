import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DatabaseApplicationRefInvalidError,
  DatabaseNotFoundError,
  FAKE_DATABASE_STORAGE_BYTES,
  createFakeDatabasePort,
  databaseEnvPairs,
} from '../src/index';
import { runDatabasePortContract } from './databasePortContract';

// MOTIR-9971 — the fake database port: the shared contract, then what only the
// fake promises (its clock, its usage arithmetic, its controls).

const START = new Date('2026-10-28T00:00:00.000Z');

runDatabasePortContract('fake', () => {
  const fake = createFakeDatabasePort({ start: START });
  return { port: fake, advanceSeconds: (s) => fake.advanceSeconds(s) };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('databaseEnvPairs', () => {
  it('names the pooled string DATABASE_URL and the direct one DIRECT_URL, both secret', () => {
    expect(databaseEnvPairs({ pooledUrl: 'pooled', directUrl: 'direct' })).toEqual([
      { name: 'DATABASE_URL', value: 'pooled', secret: true },
      { name: 'DIRECT_URL', value: 'direct', secret: true },
    ]);
  });
});

describe('createFakeDatabasePort', () => {
  it('refuses a blank application ref by name before creating anything', async () => {
    const fake = createFakeDatabasePort();
    await expect(fake.createDatabase({ applicationRef: '  ' })).rejects.toBeInstanceOf(
      DatabaseApplicationRefInvalidError,
    );
    await expect(fake.createDatabase({ applicationRef: '' })).rejects.toMatchObject({
      code: 'DATABASE_APPLICATION_REF_INVALID',
    });
    expect(fake.databases()).toEqual([]);
  });

  it('counts compute from creation to now, and storage while the database exists', async () => {
    const fake = createFakeDatabasePort({ start: START });
    const { handle } = await fake.createDatabase({
      applicationRef: 'app',
      region: 'aws-us-east-2',
    });
    fake.advanceSeconds(90);
    const before = await fake.usageSince(handle, new Date(START.getTime() - 3_600_000));
    expect(before.computeSeconds).toBe(90);
    expect(before.storageBytes).toBe(FAKE_DATABASE_STORAGE_BYTES);
    const window = await fake.usageSince(handle, new Date(START.getTime() + 60_000));
    expect(window.computeSeconds).toBe(30);

    fake.advanceSeconds(30);
    const deleted = await fake.deleteDatabase(handle);
    expect(deleted).toEqual({
      provider: 'neon',
      applicationRef: 'app',
      since: START,
      until: new Date(START.getTime() + 120_000),
      computeSeconds: 120,
      storageBytes: FAKE_DATABASE_STORAGE_BYTES,
    });
  });

  it('exposes its clock and what it holds, without the connection strings', async () => {
    const fake = createFakeDatabasePort({ start: START });
    fake.setClock(new Date('2026-11-01T00:00:00.000Z'));
    expect(fake.now()).toEqual(new Date('2026-11-01T00:00:00.000Z'));
    const created = await fake.createDatabase({ applicationRef: 'app', region: 'eu' });
    await fake.createDatabase({ applicationRef: 'other' });
    expect(fake.databases()).toEqual([
      { handle: created.handle, region: 'eu', createdAt: new Date('2026-11-01T00:00:00.000Z') },
      expect.objectContaining({ region: null }),
    ]);
    expect(JSON.stringify(fake.databases())).not.toContain('postgresql://');
  });

  it('lists its branches across databases, without their connection strings (MOTIR-5772)', async () => {
    const fake = createFakeDatabasePort({ start: START });
    const a = await fake.createDatabase({ applicationRef: 'a-pv' });
    const b = await fake.createDatabase({ applicationRef: 'b-pv' });
    const one = await fake.createBranch(a.handle, { name: 'pr-1' });
    fake.advanceSeconds(10);
    const two = await fake.createBranch(b.handle, { name: 'pr-1' });
    expect(fake.branches()).toEqual([
      { branch: one.branch, createdAt: START },
      { branch: two.branch, createdAt: new Date(START.getTime() + 10_000) },
    ]);
    expect(JSON.stringify(fake.branches())).not.toContain('postgresql://');
    // A stale ref under a live name is not that branch.
    const stale = await fake.deleteBranch({ ...one.branch, branchRef: 'fake-br-0' });
    expect(stale.computeSeconds).toBe(0);
    expect(fake.branches()).toHaveLength(2);
  });

  it('treats a stale handle as not found, and its delete as already gone', async () => {
    const fake = createFakeDatabasePort();
    const first = await fake.createDatabase({ applicationRef: 'app' });
    await fake.deleteDatabase(first.handle);
    const second = await fake.createDatabase({ applicationRef: 'app' });
    expect(second.handle.databaseRef).not.toBe(first.handle.databaseRef);
    await expect(fake.connectionEnv(first.handle)).rejects.toBeInstanceOf(DatabaseNotFoundError);
    await expect(fake.usageSince(first.handle, new Date(0))).rejects.toMatchObject({
      code: 'DATABASE_NOT_FOUND',
      applicationRef: 'app',
    });
    expect((await fake.deleteDatabase(first.handle)).computeSeconds).toBe(0);
    expect(fake.databases()).toHaveLength(1);
  });

  it('reads no environment variable and takes no credential', async () => {
    vi.stubEnv('NEON_API_KEY', 'must-not-be-read');
    const fake = createFakeDatabasePort();
    const { env } = await fake.createDatabase({ applicationRef: 'app' });
    expect(JSON.stringify(env)).not.toContain('must-not-be-read');
  });
});
