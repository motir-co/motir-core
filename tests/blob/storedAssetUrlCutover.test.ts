import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { toProjectDTO } from '@/lib/mappers/projectMappers';
import { toUserProfileDto } from '@/lib/mappers/userMappers';
import { storedAssetUrlRewriteService } from '@/lib/services/storedAssetUrlRewriteService';
import { createTestProject, createTestWorkspace } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The cutover integration gate (Story MOTIR-9712 · MOTIR-10077): the window's
// step 5 then step 6, in one test against real Postgres. Rows on the OLD
// public base (Tigris, in the window; a neutral `.test` host here) are rewritten
// to keys by the shipped service while the configured base still names it; the
// base then switches to S3, and the rows are read through the DTO mappers users
// actually see. Every image must land on S3 with no old host and no doubled
// bucket segment, and a foreign avatar must pass through untouched.

const S3 = 'https://motir-core-public.s3.eu-central-1.amazonaws.com';
const GOOGLE = 'https://lh3.googleusercontent.com/a/ACg8ocK-cutover=s96-c';
const BASES = {
  'path-style': 'https://old-store.test/motir-core-public',
  'virtual-host': 'https://motir-core-public.old-store.test',
};

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function readUser(id: string) {
  return adminDb.user.findUniqueOrThrow({ where: { id } });
}
async function readProject(id: string) {
  return adminDb.project.findUniqueOrThrow({ where: { id } });
}

describe.each(Object.entries(BASES))('a %s old base', (_style, oldBase) => {
  it('rewrites to keys that resolve on the S3 base, leaving foreign URLs and keys alone', async () => {
    // Before the switch: the configured base is still the old one.
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', oldBase);
    const a = await createTestWorkspace({ name: 'Alpha' });
    const google = await createTestWorkspace({ name: 'Google' });
    const keyed = await createTestWorkspace({ name: 'Keyed' });
    const project = await createTestProject({
      workspaceId: a.workspace.id,
      actorUserId: a.owner.id,
      identifier: 'CUT',
    });
    const userKey = `avatars/${a.owner.id}/a.png`;
    const projectKey = `projects/${project.id}/p.png`;
    const keyedKey = `avatars/${keyed.owner.id}/k.png`;
    await adminDb.user.update({
      where: { id: a.owner.id },
      data: { image: `${oldBase}/${userKey}` },
    });
    await adminDb.user.update({ where: { id: google.owner.id }, data: { image: GOOGLE } });
    await adminDb.user.update({ where: { id: keyed.owner.id }, data: { image: keyedKey } });
    await adminDb.project.update({
      where: { id: project.id },
      data: { image: `${oldBase}/${projectKey}` },
    });

    // Step 5: the rewrite, named with the old base.
    const applied = await storedAssetUrlRewriteService.rewriteAbsoluteAssetUrls({
      fromBase: oldBase,
      apply: true,
    });
    expect(applied.users.before + applied.projects.before).toBe(2);

    // Step 6: the base names S3, and the rows are read as users see them.
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', S3);
    const userImage = toUserProfileDto(await readUser(a.owner.id)).image;
    const projectImage = toProjectDTO(await readProject(project.id)).image;
    expect(userImage).toBe(`${S3}/${userKey}`);
    expect(projectImage).toBe(`${S3}/${projectKey}`);
    for (const url of [userImage, projectImage]) {
      expect(url).not.toContain(new URL(oldBase).host);
      expect(url).not.toContain('motir-core-public/motir-core-public');
      expect(new URL(url!).pathname.split('/').filter((s) => s === 'motir-core-public')).toEqual(
        [],
      );
    }

    // A Google avatar is stored and shown byte-for-byte unchanged.
    expect((await readUser(google.owner.id)).image).toBe(GOOGLE);
    expect(toUserProfileDto(await readUser(google.owner.id)).image).toBe(GOOGLE);

    // A row that was already a key keeps it, and resolves on S3.
    expect((await readUser(keyed.owner.id)).image).toBe(keyedKey);
    expect(toUserProfileDto(await readUser(keyed.owner.id)).image).toBe(`${S3}/${keyedKey}`);

    // Nothing in the database names the old host any more…
    const oldHost = new URL(oldBase).host;
    expect(await adminDb.user.count({ where: { image: { contains: oldHost } } })).toBe(0);
    expect(await adminDb.project.count({ where: { image: { contains: oldHost } } })).toBe(0);
    // …and a second dry run finds nothing to do.
    const again = await storedAssetUrlRewriteService.rewriteAbsoluteAssetUrls({
      fromBase: oldBase,
      apply: false,
    });
    expect(again.users.before).toBe(0);
    expect(again.projects.before).toBe(0);
  });
});
