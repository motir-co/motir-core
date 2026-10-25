import { afterEach, beforeEach, vi } from 'vitest';
import { describePersistentContract } from './contract/persistentContract';
import { flyPersistentApi, flyPersistentHarness } from './contract/flyPersistentHarness';

// The Fly adapter's persistent half against the shared persistent contract
// (MOTIR-9467), over an in-memory Fly Machines and Volumes API. No network, no
// database.

beforeEach(() => {
  vi.stubEnv('FLY_INSTANCES_API_TOKEN', 'instances-token');
  vi.stubEnv('FLY_INSTANCES_REGION', '');
  vi.stubEnv('FLY_INSTANCES_APP_PREFIX', '');
  vi.stubEnv('FLY_INSTANCES_ORG', '');
  vi.stubGlobal('fetch', vi.fn(flyPersistentApi));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describePersistentContract('fly', flyPersistentHarness);
