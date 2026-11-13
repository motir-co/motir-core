import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoredAssetRewriteError } from '@/lib/blob/errors';
import { db } from '@/lib/db';
import { projectRepository } from '@/lib/repositories/projectRepository';
import {
  parseFromBase,
  storedAssetUrlRewriteService,
} from '@/lib/services/storedAssetUrlRewriteService';
import { createTestProject, createTestWorkspace } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { parseArgs, printReport } from '../../scripts/rewrite-stored-asset-urls';

// `pnpm db:rewrite:stored-asset-urls` (Story MOTIR-9712 · MOTIR-10075), driven through
// its service — the script's `main()` is argument parsing and printing over this call.
// Real Postgres, no mocks: rows are seeded through the owner client in two
// workspaces, so the sweep's cross-tenant read and its per-project binding are what
// is under test.

// The previous store's public base: a neutral `.test` host, because the service
// takes the base as an argument and knows no vendor.
const PREVIOUS = 'https://motir-core-public.previous-store.test';
const S3 = 'https://assets.motir.co';
const GOOGLE = 'https://lh3.googleusercontent.com/a/abc123';

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Two workspaces, each with a project; users and projects holding every form. */
async function seed() {
  const a = await createTestWorkspace({ name: 'Alpha' });
  const b = await createTestWorkspace({ name: 'Beta' });
  const pa = await createTestProject({
    workspaceId: a.workspace.id,
    actorUserId: a.owner.id,
    identifier: 'ALP',
  });
  const pb = await createTestProject({
    workspaceId: b.workspace.id,
    actorUserId: b.owner.id,
    identifier: 'BET',
  });
  const keyed = await createTestWorkspace({ name: 'Gamma' });
  const google = await createTestWorkspace({ name: 'Delta' });
  const older = await createTestWorkspace({ name: 'Epsilon' });

  const values = {
    userA: `${PREVIOUS}/avatars/${a.owner.id}/me.png`,
    userB: `${PREVIOUS}/avatars/${b.owner.id}/a%20b.png`,
    userKeyed: `avatars/${keyed.owner.id}/me.png`,
    userGoogle: GOOGLE,
    userOlder: `https://old-public.blob.example/avatars/${older.owner.id}/me.png`,
    projectA: `${PREVIOUS}/projects/${pa.id}/mark.png`,
    projectB: `projects/${pb.id}/mark.png`,
  };
  await adminDb.user.update({ where: { id: a.owner.id }, data: { image: values.userA } });
  await adminDb.user.update({ where: { id: b.owner.id }, data: { image: values.userB } });
  await adminDb.user.update({ where: { id: keyed.owner.id }, data: { image: values.userKeyed } });
  await adminDb.user.update({ where: { id: google.owner.id }, data: { image: values.userGoogle } });
  await adminDb.user.update({ where: { id: older.owner.id }, data: { image: values.userOlder } });
  await adminDb.project.update({ where: { id: pa.id }, data: { image: values.projectA } });
  await adminDb.project.update({ where: { id: pb.id }, data: { image: values.projectB } });

  return {
    ids: {
      userA: a.owner.id,
      userB: b.owner.id,
      userKeyed: keyed.owner.id,
      userGoogle: google.owner.id,
      userOlder: older.owner.id,
      projectA: pa.id,
      projectB: pb.id,
    },
    values,
  };
}

async function images(ids: Awaited<ReturnType<typeof seed>>['ids']) {
  const user = async (id: string) =>
    (await adminDb.user.findUniqueOrThrow({ where: { id }, select: { image: true } })).image;
  const project = async (id: string) =>
    (await adminDb.project.findUniqueOrThrow({ where: { id }, select: { image: true } })).image;
  return {
    userA: await user(ids.userA),
    userB: await user(ids.userB),
    userKeyed: await user(ids.userKeyed),
    userGoogle: await user(ids.userGoogle),
    userOlder: await user(ids.userOlder),
    projectA: await project(ids.projectA),
    projectB: await project(ids.projectB),
  };
}

describe('the dry run (the default)', () => {
  it('counts the rows on the base, shows each key, reports foreign hosts, and writes nothing', async () => {
    const { ids, values } = await seed();

    const report = await storedAssetUrlRewriteService.rewriteAbsoluteAssetUrls({
      fromBase: `${PREVIOUS}/`,
      apply: false,
    });

    expect(report.apply).toBe(false);
    expect(report.fromBase).toBe(PREVIOUS);
    expect(report.users.before).toBe(2);
    expect(report.users.rows).toEqual(
      expect.arrayContaining([
        { id: ids.userA, from: values.userA, to: `avatars/${ids.userA}/me.png` },
        { id: ids.userB, from: values.userB, to: `avatars/${ids.userB}/a b.png` },
      ]),
    );
    // Google and the older host — left alone, counted.
    expect(report.users.foreignAbsolute).toBe(2);
    expect(report.users.after).toBe(2);
    expect(report.projects).toEqual({
      before: 1,
      rows: [{ id: ids.projectA, from: values.projectA, to: `projects/${ids.projectA}/mark.png` }],
      foreignAbsolute: 0,
      after: 1,
    });

    expect(await images(ids)).toEqual(values);
  });
});

describe('--apply', () => {
  it('rewrites every counted row to its key in one transaction, and re-counts 0', async () => {
    const { ids, values } = await seed();

    const report = await storedAssetUrlRewriteService.rewriteAbsoluteAssetUrls({
      fromBase: PREVIOUS,
      apply: true,
    });

    expect(report.users.before).toBe(2);
    expect(report.projects.before).toBe(1);
    expect(report.users.after).toBe(0);
    expect(report.projects.after).toBe(0);
    expect(await images(ids)).toEqual({
      ...values,
      userA: `avatars/${ids.userA}/me.png`,
      userB: `avatars/${ids.userB}/a b.png`,
      projectA: `projects/${ids.projectA}/mark.png`,
    });
  });

  it('a second apply counts 0 and writes nothing', async () => {
    const { ids } = await seed();
    await storedAssetUrlRewriteService.rewriteAbsoluteAssetUrls({
      fromBase: PREVIOUS,
      apply: true,
    });
    const afterFirst = await images(ids);

    const again = await storedAssetUrlRewriteService.rewriteAbsoluteAssetUrls({
      fromBase: PREVIOUS,
      apply: true,
    });

    expect(again.users).toEqual({ before: 0, rows: [], foreignAbsolute: 2, after: 0 });
    expect(again.projects).toEqual({ before: 0, rows: [], foreignAbsolute: 0, after: 0 });
    expect(await images(ids)).toEqual(afterFirst);
  });

  it('rolls everything back, naming the row, when one does not reduce to a key', async () => {
    const { ids, values } = await seed();
    // A `..` between encoded slashes survives decoding, so it never reduces.
    const bad = `${PREVIOUS}/avatars/x%2F..%2Fy/me.png`;
    await adminDb.user.update({ where: { id: ids.userKeyed }, data: { image: bad } });

    const err = await storedAssetUrlRewriteService
      .rewriteAbsoluteAssetUrls({ fromBase: PREVIOUS, apply: true })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StoredAssetRewriteError);
    expect(err).toMatchObject({
      code: 'STORED_ASSET_NOT_REDUCIBLE',
      table: 'user',
      rowId: ids.userKeyed,
    });
    expect(await images(ids)).toEqual({ ...values, userKeyed: bad });
  });

  it('rolls everything back when a compare-and-set changes nothing', async () => {
    const { ids, values } = await seed();
    // The project write comes after both user writes, so a refusal here proves the
    // user rows already written are undone too.
    vi.spyOn(projectRepository, 'compareAndSetImage').mockResolvedValue(0);

    const err = await storedAssetUrlRewriteService
      .rewriteAbsoluteAssetUrls({ fromBase: PREVIOUS, apply: true })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: 'STORED_ASSET_CHANGED',
      table: 'project',
      rowId: ids.projectA,
    });
    expect(await images(ids)).toEqual(values);
  });

  it('rolls everything back when the re-count is not 0', async () => {
    const { ids, values } = await seed();
    const real = projectRepository.listImagesWithPrefix.bind(projectRepository);
    let calls = 0;
    vi.spyOn(projectRepository, 'listImagesWithPrefix').mockImplementation(async (prefix, tx) => {
      calls += 1;
      const rows = await real(prefix, tx);
      // The re-count pretends a row is still on the base.
      return calls === 1 ? rows : [{ id: ids.projectA, workspaceId: 'w', image: values.projectA }];
    });

    const err = await storedAssetUrlRewriteService
      .rewriteAbsoluteAssetUrls({ fromBase: PREVIOUS, apply: true })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'STORED_ASSET_REWRITE_INCOMPLETE' });
    expect(await images(ids)).toEqual(values);
  });

  it('writes keys the product resolves on a NEW public base, and does not read the configured one', async () => {
    const { ids } = await seed();
    // The window runs this while the configured base already names S3.
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', S3);

    const report = await storedAssetUrlRewriteService.rewriteAbsoluteAssetUrls({
      fromBase: PREVIOUS,
      apply: true,
    });

    expect(report.users.before + report.projects.before).toBe(3);
    const after = await images(ids);
    expect(after.userA).toBe(`avatars/${ids.userA}/me.png`);
  });
});

describe('the base and the arguments', () => {
  it('requires --from-base and refuses a non-https one before any query', () => {
    expect(() => parseFromBase(undefined)).toThrowError(/--from-base is required/);
    expect(() => parseFromBase('http://motir-core-public.previous-store.test')).toThrowError(
      /https/,
    );
    expect(() => parseFromBase('not a url')).toThrowError(/not a URL/);
    expect(parseFromBase(`${PREVIOUS}//`)).toBe(PREVIOUS);
  });

  it('the script defaults to a dry run, takes --apply, and refuses anything else', () => {
    expect(parseArgs([`--from-base=${PREVIOUS}`])).toEqual({ fromBase: PREVIOUS, apply: false });
    expect(parseArgs([`--from-base=${PREVIOUS}`, '--apply'])).toEqual({
      fromBase: PREVIOUS,
      apply: true,
    });
    expect(() => parseArgs(['--apply'])).toThrowError(StoredAssetRewriteError);
    expect(() => parseArgs([`--from-base=${PREVIOUS}`, '--force'])).toThrowError(
      /unknown argument/,
    );
  });

  it('prints each row with its key, and says when there is nothing to apply', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
    const { ids } = await seed();

    printReport(
      await storedAssetUrlRewriteService.rewriteAbsoluteAssetUrls({
        fromBase: PREVIOUS,
        apply: false,
      }),
    );
    expect(lines.join('\n')).toContain(`→ avatars/${ids.userA}/me.png (dry run)`);
    expect(lines.join('\n')).toContain('3 row(s) would be rewritten. Re-run with --apply');

    lines.length = 0;
    printReport(
      await storedAssetUrlRewriteService.rewriteAbsoluteAssetUrls({
        fromBase: PREVIOUS,
        apply: true,
      }),
    );
    expect(lines.join('\n')).toContain('3 row(s) rewritten in one transaction; after-count 0.');

    lines.length = 0;
    printReport(
      await storedAssetUrlRewriteService.rewriteAbsoluteAssetUrls({
        fromBase: PREVIOUS,
        apply: false,
      }),
    );
    expect(lines.join('\n')).toContain('0 rows to rewrite; there is nothing to apply.');
  });
});
