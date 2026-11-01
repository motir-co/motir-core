// MOTIR-5772 — a preview's database through the database port (MOTIR-5769 §6):
// the repository's data-free preview database `<rid>-pv` and the pull request's
// branch `pr-<n>`, against the port's fake; the typed refusal when no provider
// is configured; and no environment read at module load.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerDatabaseAdapter,
  resetDatabaseFakes,
  unregisterDatabaseAdapter,
} from '@/lib/orchestrator/database';
import { PreviewHostingNotConfiguredError } from '@/lib/preview/errors';
import {
  createPreviewBranch,
  deletePreviewBranch,
  deletePreviewDatabase,
  ensurePreviewDatabase,
  previewBranchName,
  previewDatabaseApplicationRef,
} from '@/lib/preview/previewDatabase';
import { PREVIEW_DOMAIN_ENV, previewDomain } from '@/lib/preview/config';

const RID = 'cmvttubqa0076gkoox7buxdi7';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  resetDatabaseFakes();
});

describe('a preview database through the port', () => {
  it('names the preview database after the repository and the branch after the PR', () => {
    expect(previewDatabaseApplicationRef(RID)).toBe(`${RID}-pv`);
    expect(previewBranchName(12)).toBe('pr-12');
  });

  it('creates the preview database once, a branch per pull request, and tears both down', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const database = await ensurePreviewDatabase(RID);
    expect(database.applicationRef).toBe(`${RID}-pv`);
    expect(await ensurePreviewDatabase(RID)).toEqual(database);

    const one = await createPreviewBranch(database, 1);
    const again = await createPreviewBranch(database, 1);
    const two = await createPreviewBranch(database, 2);
    expect(one.branch.name).toBe('pr-1');
    expect(again).toEqual(one);
    expect(two.branch.branchRef).not.toBe(one.branch.branchRef);
    expect(one.env.map((pair) => pair.name)).toEqual(['DATABASE_URL', 'DIRECT_URL']);

    const usage = await deletePreviewBranch(one.branch);
    expect(usage.applicationRef).toBe(`${RID}-pv`);
    expect((await deletePreviewBranch(one.branch)).computeSeconds).toBe(0);
    expect((await deletePreviewDatabase(database)).applicationRef).toBe(`${RID}-pv`);
    expect((await deletePreviewBranch(two.branch)).storageBytes).toBe(0);
  });

  it('refuses every call with PreviewHostingNotConfiguredError when the provider is unset', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubEnv('MOTIR_HOSTING_NEON_API_KEY', '');
    vi.stubEnv('MOTIR_HOSTING_NEON_ORG_ID', '');
    const database = { provider: 'neon' as const, applicationRef: `${RID}-pv`, databaseRef: 'p' };
    const branch = { database, branchRef: 'b', name: 'pr-1' };
    for (const call of [
      () => ensurePreviewDatabase(RID),
      () => createPreviewBranch(database, 1),
      () => deletePreviewBranch(branch),
      () => deletePreviewDatabase(database),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(PreviewHostingNotConfiguredError);
      await expect(call()).rejects.toThrow(/MOTIR_HOSTING_NEON_API_KEY/);
    }
  });

  it('passes an adapter that fails to build through unchanged', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    const boom = new Error('adapter refused to build');
    registerDatabaseAdapter('neon', () => {
      throw boom;
    });
    try {
      await expect(ensurePreviewDatabase(RID)).rejects.toBe(boom);
    } finally {
      unregisterDatabaseAdapter('neon');
    }
  });

  it('passes any other failure through unchanged', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const database = {
      provider: 'neon' as const,
      applicationRef: `${RID}-pv`,
      databaseRef: 'gone',
    };
    await expect(createPreviewBranch(database, 1)).rejects.toMatchObject({
      code: 'DATABASE_NOT_FOUND',
    });
  });
});

describe('the preview domain', () => {
  it('is read at call time, lowercased, and named when unset', () => {
    vi.stubEnv(PREVIEW_DOMAIN_ENV, '');
    expect(() => previewDomain()).toThrow(PreviewHostingNotConfiguredError);
    expect(() => previewDomain()).toThrow(/MOTIR_PREVIEW_DOMAIN/);
    vi.stubEnv(PREVIEW_DOMAIN_ENV, ' Preview.Motir.Site ');
    expect(previewDomain()).toBe('preview.motir.site');
  });
});

describe('no module here reads the environment at load', () => {
  it.each([
    '@/lib/preview/config',
    '@/lib/preview/errors',
    '@/lib/preview/hostName',
    '@/lib/preview/states',
    '@/lib/preview/previewDatabase',
  ])('imports %s with every preview variable unset', async (path) => {
    for (const name of [
      PREVIEW_DOMAIN_ENV,
      'MOTIR_HOSTING_NEON_API_KEY',
      'MOTIR_HOSTING_NEON_ORG_ID',
      'MOTIR_FLEET_ORCHESTRATOR',
    ]) {
      vi.stubEnv(name, undefined);
    }
    vi.resetModules();
    await expect(import(path)).resolves.toBeDefined();
  });
});
