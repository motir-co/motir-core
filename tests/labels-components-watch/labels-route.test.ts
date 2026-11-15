import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceContext } from '@/lib/workspaces';

// GET /api/projects/[key]/labels — the label picker's prefix search (`?q=`), and
// the `?ids=` resolve the create-board dialog uses to name the labels a copied
// saved filter references (Story MOTIR-10560 · Subtask MOTIR-11333). Real
// Postgres; only the session's workspace context is stubbed.
const wsCtx = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => wsCtx.current };
});

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { GET } from '@/app/api/projects/[key]/labels/route';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function fixture() {
  const user = await usersService.createUser({
    email: 'labels-route@example.com',
    password: 'hunter2hunter2',
    name: 'Labels',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Labels WS', ownerUserId: user.id });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({ workspaceId, actorUserId: user.id, identifier: 'LBL' });
  const other = await createTestProject({ workspaceId, actorUserId: user.id, identifier: 'OTH' });
  const label = async (projectId: string, name: string) =>
    (
      await adminDb.label.create({
        data: { workspaceId, projectId, name, nameLower: name.toLowerCase() },
      })
    ).id;
  const mobile = await label(project.id, 'mobile');
  const web = await label(project.id, 'web');
  const foreign = await label(other.id, 'mobile');
  wsCtx.current = { userId: user.id, workspaceId };
  return { key: project.identifier, mobile, web, foreign };
}

const get = (key: string, query: string) =>
  GET(new Request(`http://localhost/api/projects/${key}/labels?${query}`), {
    params: Promise.resolve({ key }),
  });

describe('GET /api/projects/[key]/labels', () => {
  it('searches by prefix with ?q= (unchanged)', async () => {
    const fx = await fixture();
    const res = await get(fx.key, 'q=mob');
    expect(res.status).toBe(200);
    const { labels } = (await res.json()) as { labels: Array<{ id: string; name: string }> };
    expect(labels.map((l) => l.id)).toEqual([fx.mobile]);
  });

  it('resolves ?ids= to the project’s labels, leaving out a deleted or foreign id', async () => {
    const fx = await fixture();
    const res = await get(fx.key, `ids=${fx.mobile},${fx.web},deleted-id,${fx.foreign},${fx.web}`);
    expect(res.status).toBe(200);
    const { labels } = (await res.json()) as { labels: Array<{ id: string; name: string }> };
    expect(labels.map((l) => l.id).sort()).toEqual([fx.mobile, fx.web].sort());
    expect(labels.find((l) => l.id === fx.mobile)?.name).toBe('mobile');
  });

  it('ignores ?q= when ?ids= is present, and answers [] for an empty list', async () => {
    const fx = await fixture();
    const both = (await (await get(fx.key, `ids=${fx.web}&q=mob`)).json()) as {
      labels: Array<{ id: string }>;
    };
    expect(both.labels.map((l) => l.id)).toEqual([fx.web]);
    const empty = (await (await get(fx.key, 'ids=')).json()) as { labels: unknown[] };
    expect(empty.labels).toEqual([]);
  });

  it('refuses more than 100 ids with a 400', async () => {
    const fx = await fixture();
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`).join(',');
    const res = await get(fx.key, `ids=${ids}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('is a 404 for a project key outside the workspace', async () => {
    await fixture();
    const res = await get('NOPE', 'ids=x');
    expect(res.status).toBe(404);
  });
});
