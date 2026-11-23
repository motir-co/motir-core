import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DatabaseNotFoundError,
  FAKE_DATABASE_STATE_PATH_ENV,
  createFakeDatabasePort,
  emptyFakeDatabaseSlice,
  fakeDatabaseStatePath,
  readFakeDatabaseSlice,
  saveFakeDatabaseSlice,
} from '../src/index';

// The fake database port's CROSS-PROCESS store (Story MOTIR-9800 · MOTIR-12142):
// two fakes over one state file stand for the acceptance lane's job worker and
// app server — what one creates, the other reads and deletes — and the spec
// asks the file whether the database is still there.

const START = new Date('2026-10-28T00:00:00.000Z');

let path: string;

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'fake-database-')), 'nested', 'database.json');
  vi.stubEnv(FAKE_DATABASE_STATE_PATH_ENV, path);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the fake database port’s shared store', () => {
  it('one process creates a database and another, sharing the file, reads and deletes it', async () => {
    const worker = createFakeDatabasePort({ start: START });
    const server = createFakeDatabasePort({ start: START });
    const { handle, env } = await worker.createDatabase({
      applicationRef: 'app-1',
      region: 'aws-us-east-2',
    });
    await worker.createBranch(handle, { name: 'preview-1' });

    expect(await server.connectionEnv(handle)).toEqual(env);
    expect(server.databases()).toEqual([{ handle, region: 'aws-us-east-2', createdAt: START }]);
    expect(server.branches()).toHaveLength(1);
    expect(server.branches()[0]?.createdAt).toBeInstanceOf(Date);

    const usage = await server.deleteDatabase(handle);
    expect(usage.storageBytes).toBeGreaterThan(0);
    await expect(worker.connectionEnv(handle)).rejects.toBeInstanceOf(DatabaseNotFoundError);
    expect(readFakeDatabaseSlice('neon')).toMatchObject({ databases: {} });
  });

  it('shares the sequence, so two processes never mint the same ref', async () => {
    const one = createFakeDatabasePort({ start: START });
    const two = createFakeDatabasePort({ start: START });
    const a = await one.createDatabase({ applicationRef: 'app-a' });
    const b = await two.createDatabase({ applicationRef: 'app-b' });
    expect(a.handle.databaseRef).not.toBe(b.handle.databaseRef);
    expect((await one.list()).map(({ handle }) => handle.applicationRef).sort()).toEqual([
      'app-a',
      'app-b',
    ]);
  });

  it('shares the clock, so usage reads the same in every process', async () => {
    const one = createFakeDatabasePort({ start: START });
    const two = createFakeDatabasePort({ start: START });
    const { handle } = await one.createDatabase({ applicationRef: 'app' });
    two.advanceSeconds(120);
    expect((await one.usageSince(handle, START)).computeSeconds).toBe(120);
    one.setClock(new Date(START.getTime() + 60_000));
    expect(two.now()).toEqual(new Date(START.getTime() + 60_000));
  });

  it('deletes a branch another process made, and reports nothing for a stale ref', async () => {
    const one = createFakeDatabasePort({ start: START });
    const two = createFakeDatabasePort({ start: START });
    const { handle } = await one.createDatabase({ applicationRef: 'app' });
    const { branch } = await one.createBranch(handle, { name: 'feature' });
    two.advanceSeconds(30);
    expect((await two.branchUsage(branch)).computeSeconds).toBe(30);
    expect((await two.deleteBranch(branch)).computeSeconds).toBe(30);
    expect(one.branches()).toEqual([]);
    expect((await one.deleteBranch(branch)).computeSeconds).toBe(0);
  });

  it('keeps every other provider’s slice when one is written', () => {
    saveFakeDatabaseSlice('other', emptyFakeDatabaseSlice(START));
    saveFakeDatabaseSlice('neon', { ...emptyFakeDatabaseSlice(START), sequence: 7 });
    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(file).sort()).toEqual(['neon', 'other']);
    expect(readFakeDatabaseSlice('neon')).toMatchObject({ sequence: 7 });
    expect(readFakeDatabaseSlice('missing')).toBeNull();
  });

  it('keeps what the process has on a torn read, and a write replaces the torn file', async () => {
    const fake = createFakeDatabasePort({ start: START });
    const { handle } = await fake.createDatabase({ applicationRef: 'app' });
    writeFileSync(path, '{"neon": {"datab');
    expect(readFakeDatabaseSlice('neon')).toBe('torn');
    expect(fake.databases().map((d) => d.handle)).toEqual([handle]);
    fake.advanceSeconds(1);
    expect(readFakeDatabaseSlice('neon')).toMatchObject({ databases: { app: { handle } } });
  });

  it('refuses a store key that reaches Object.prototype', () => {
    expect(() => readFakeDatabaseSlice('__proto__')).toThrow(/not a fake database store key/);
    expect(() => saveFakeDatabaseSlice('constructor', emptyFakeDatabaseSlice())).toThrow(
      /not a fake database store key/,
    );
  });

  it('stays in memory with the variable unset or empty', async () => {
    vi.stubEnv(FAKE_DATABASE_STATE_PATH_ENV, '');
    expect(fakeDatabaseStatePath()).toBeNull();
    expect(readFakeDatabaseSlice('neon')).toBeNull();
    saveFakeDatabaseSlice('neon', emptyFakeDatabaseSlice());
    const one = createFakeDatabasePort({ start: START });
    const two = createFakeDatabasePort({ start: START });
    await one.createDatabase({ applicationRef: 'app' });
    expect(two.databases()).toEqual([]);
    expect(one.databases()).toHaveLength(1);
  });

  it('starts empty at its own clock when the file holds nothing yet', () => {
    const fake = createFakeDatabasePort({ start: START });
    expect(fake.databases()).toEqual([]);
    expect(fake.now()).toEqual(START);
    expect(readFakeDatabaseSlice('neon')).toBeNull();
  });
});
