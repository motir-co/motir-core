// MOTIR-9971 — the database port's composition: which port `getDatabasePort()`
// returns, and the typed not-configured error when no adapter is registered.
// Pure: no database, no network.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OrchestratorNotConfiguredError,
  createFakeDatabasePort,
  getDatabasePort,
  registerDatabaseAdapter,
  resetDatabaseFakes,
  unregisterDatabaseAdapter,
} from '@/lib/orchestrator';

afterEach(() => {
  vi.unstubAllEnvs();
  unregisterDatabaseAdapter('neon');
  resetDatabaseFakes();
});

describe('getDatabasePort', () => {
  it('returns one fake per process while the fake is selected', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const port = getDatabasePort();
    expect(port.provider).toBe('neon');
    expect(getDatabasePort('neon')).toBe(port);
    await port.createDatabase({ applicationRef: 'app' });
    expect(await getDatabasePort().list()).toHaveLength(1);
    resetDatabaseFakes();
    expect(await getDatabasePort().list()).toEqual([]);
  });

  it('throws the typed not-configured error naming the missing adapter', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    expect(() => getDatabasePort()).toThrow(OrchestratorNotConfiguredError);
    expect(() => getDatabasePort()).toThrow(/no neon database adapter is registered/);
  });

  it('returns the port a registered factory builds, until it is unregistered', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    const neon = createFakeDatabasePort();
    registerDatabaseAdapter('neon', () => neon);
    expect(getDatabasePort()).toBe(neon);
    unregisterDatabaseAdapter('neon');
    expect(() => getDatabasePort()).toThrow(OrchestratorNotConfiguredError);
  });

  it('prefers the fake over a registered adapter while the fake is selected', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const neon = createFakeDatabasePort();
    registerDatabaseAdapter('neon', () => neon);
    expect(getDatabasePort()).not.toBe(neon);
  });

  it('loads no database client: the accessor imports only the package and the selector', () => {
    const source = readFileSync(join(__dirname, '../../lib/orchestrator/database.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports).toEqual(['@motir/orchestrator', './provider']);
  });
});
