import { describe, expect, it } from 'vitest';
import {
  DATABASE_DIRECT_ENV,
  DATABASE_POOLED_ENV,
  DatabaseNotFoundError,
  type DatabasePort,
  type ReleaseEnvVar,
} from '../src/index';

// THE DATABASE PORT'S CONTRACT (Story MOTIR-9793 · MOTIR-9971) — one case list,
// run unchanged against every adapter. The fake runs it in
// `databaseFake.test.ts`; the Neon adapter joins with one
// `runDatabasePortContract('neon', …)` call over its simulated API, which is
// what lets the production and preview stories trust the fake.
//
// The credential rule is checked by VALUE, not by a prefix only one adapter
// knows: every pair value the port hands out is collected, and every other
// thing the port returns or throws is serialised and searched for it.

export interface DatabaseHarness {
  readonly port: DatabasePort;
  /** Move the adapter's clock forward, so usage has a window to count. */
  advanceSeconds(seconds: number): void;
}

const APP_A = 'mh-repo-a-production';
const APP_B = 'mh-repo-b-production';

function serialised(value: unknown): string {
  return value instanceof Error
    ? `${value.name} ${value.message} ${JSON.stringify(value)}`
    : JSON.stringify(value);
}

function secretsIn(env: readonly ReleaseEnvVar[]): string[] {
  return env.map((pair) => pair.value);
}

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

export function runDatabasePortContract(name: string, factory: () => DatabaseHarness): void {
  describe(`database port contract — ${name}`, () => {
    it('creates one database per application and returns exactly two secret pairs', async () => {
      const { port } = factory();
      const created = await port.createDatabase({ applicationRef: APP_A });
      expect(created.handle.applicationRef).toBe(APP_A);
      expect(created.handle.provider).toBe(port.provider);
      expect(created.env.map((pair) => pair.name)).toEqual([
        DATABASE_POOLED_ENV,
        DATABASE_DIRECT_ENV,
      ]);
      expect(created.env.every((pair) => pair.secret)).toBe(true);
      expect(created.env.every((pair) => pair.value.length > 0)).toBe(true);
    });

    it('is idempotent: a second create for the application returns the same database', async () => {
      const { port } = factory();
      const first = await port.createDatabase({ applicationRef: APP_A });
      const second = await port.createDatabase({ applicationRef: APP_A });
      expect(second.handle).toEqual(first.handle);
      expect(second.env).toEqual(first.env);
      expect(await port.list()).toHaveLength(1);
    });

    it('re-reads the same pairs through connectionEnv', async () => {
      const { port } = factory();
      const created = await port.createDatabase({ applicationRef: APP_A });
      expect(await port.connectionEnv(created.handle)).toEqual(created.env);
    });

    it('reports usage over a window while the database lives', async () => {
      const { port, advanceSeconds } = factory();
      const created = await port.createDatabase({ applicationRef: APP_A });
      const since = new Date(0);
      advanceSeconds(120);
      const usage = await port.usageSince(created.handle, since);
      expect(usage.applicationRef).toBe(APP_A);
      expect(usage.provider).toBe(port.provider);
      expect(usage.since).toEqual(since);
      expect(usage.until.getTime()).toBeGreaterThanOrEqual(since.getTime());
      expect(usage.computeSeconds).toBeGreaterThanOrEqual(0);
      expect(usage.storageBytes).toBeGreaterThanOrEqual(0);
    });

    it('deletes with a usage record over its whole life and leaves list() empty', async () => {
      const { port, advanceSeconds } = factory();
      const created = await port.createDatabase({ applicationRef: APP_A });
      advanceSeconds(300);
      const usage = await port.deleteDatabase(created.handle);
      expect(usage.applicationRef).toBe(APP_A);
      expect(usage.provider).toBe(port.provider);
      expect(usage.until.getTime()).toBeGreaterThanOrEqual(usage.since.getTime());
      expect(usage.computeSeconds).toBeGreaterThanOrEqual(0);
      expect(await port.list()).toEqual([]);
      await expect(port.connectionEnv(created.handle)).rejects.toBeInstanceOf(
        DatabaseNotFoundError,
      );
    });

    it('deletes an already-gone database with zero usage instead of throwing', async () => {
      const { port } = factory();
      const created = await port.createDatabase({ applicationRef: APP_A });
      await port.deleteDatabase(created.handle);
      const again = await port.deleteDatabase(created.handle);
      expect(again.applicationRef).toBe(APP_A);
      expect(again.computeSeconds).toBe(0);
      expect(again.storageBytes).toBe(0);
    });

    it('gives a second application its own database, untouched by deleting the first', async () => {
      const { port } = factory();
      const a = await port.createDatabase({ applicationRef: APP_A });
      const b = await port.createDatabase({ applicationRef: APP_B });
      expect(b.handle.databaseRef).not.toBe(a.handle.databaseRef);
      expect(secretsIn(b.env)).not.toEqual(secretsIn(a.env));
      await port.deleteDatabase(a.handle);
      expect((await port.list()).map((entry) => entry.handle)).toEqual([b.handle]);
      expect(await port.connectionEnv(b.handle)).toEqual(b.env);
    });

    it('returns no connection string in any handle, list entry, usage record or error', async () => {
      const { port, advanceSeconds } = factory();
      const a = await port.createDatabase({ applicationRef: APP_A });
      const b = await port.createDatabase({ applicationRef: APP_B });
      const secrets = [...secretsIn(a.env), ...secretsIn(b.env)];
      advanceSeconds(60);
      const notFound = await thrown(() =>
        port.connectionEnv({ ...a.handle, databaseRef: `${a.handle.databaseRef}-gone` }),
      );
      const returned: unknown[] = [
        a.handle,
        b.handle,
        await port.list(),
        await port.usageSince(a.handle, new Date(0)),
        await port.deleteDatabase(a.handle),
        await port.deleteDatabase(a.handle),
        notFound,
        await thrown(() => port.usageSince(a.handle, new Date(0))),
      ];
      for (const value of returned) {
        const text = serialised(value);
        for (const secret of secrets) expect(text).not.toContain(secret);
      }
    });
  });
}
