import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { pageStoreFor, savePageMarkdown, systemClock } from '@/lib/pages';
import { runCreatePage } from '@/lib/mcp/tools/createPage';
import { runUpdatePage } from '@/lib/mcp/tools/updatePage';
import { pagesService } from '@/lib/services/pagesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Bug MOTIR-11281: a page body link written with a card's KEY where its id belongs —
// `[KEY](motir:KEY)` — was stored as written, drew as a DELETED chip on every page
// surface, and linked the page to nothing. Real Postgres.
//
//  - the READ side resolves a key-shaped token as that key, so a body already stored
//    this way (a version sealed for a decision cannot be re-saved) draws live chips;
//  - the MARKDOWN WRITE door stores the id, writes the derived link, and reports
//    every `motir:` link still naming no card;
//  - the derived-link sync resolves a key-shaped mention for a save that bypasses
//    the markdown door (the raw package procedure, as an editor paste does).

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'PGK' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function item(title: string, where: WorkItemFixture = fx) {
  const row = await createTestWorkItem(where, { kind: 'task', title });
  await adminDb.workItem.update({ where: { id: row.id }, data: { status: 'todo' } });
  return row;
}

/** Store `markdown` exactly as written, as a body saved before this fix was. */
async function storedAsWritten(markdown: string): Promise<string> {
  const page = await pagesService.createPage(fx.ctx, { projectId: fx.projectId, title: 'Notes' });
  await withWorkspaceContext(
    { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
    (tx) =>
      savePageMarkdown(pageStoreFor(tx), systemClock, {
        pageId: page.id,
        actorId: fx.ownerId,
        markdown,
        expectedRevision: page.revision,
      }),
  );
  return page.id;
}

const linkedIds = async (pageId: string) =>
  [
    ...new Set(
      (await adminDb.pageWorkItemLink.findMany({ where: { pageId } })).map((r) => r.workItemId),
    ),
  ].sort();

async function privateProjectItem() {
  const priv = await createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    identifier: 'PRIV',
  });
  await projectMembersService.setAccessMode({
    key: priv.identifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    mode: 'members',
  });
  return item('Secret', { ...fx, projectId: priv.id, projectIdentifier: 'PRIV' });
}

async function member(): Promise<ServiceContext> {
  const user = await usersService.createUser({
    email: 'reader@example.com',
    password: 'hunter2hunter2',
    name: 'Reader',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

describe('the read side resolves a key-shaped token (MOTIR-11281)', () => {
  it('draws a stored [KEY](motir:KEY) live on the page and its version, beside a real id and a deleted one', async () => {
    const keyed = await item('Keyed');
    const byId = await item('By id');
    const gone = await item('Gone');
    const pageId = await storedAsWritten(
      `See [${keyed.identifier}](motir:${keyed.identifier}), [lower](motir:${keyed.identifier.toLowerCase()}), ` +
        `[B](motir:${byId.id}), [G](motir:${gone.id}) and [N](motir:PGK-999).`,
    );
    await adminDb.workItem.delete({ where: { id: gone.id } });

    const page = await pagesService.getPage(fx.ctx, { projectId: fx.projectId, pageId });
    expect(page.workItemRefs[keyed.identifier]).toMatchObject({
      accessible: true,
      id: keyed.id,
      title: 'Keyed',
      status: { key: 'todo' },
    });
    expect(page.workItemRefs[keyed.identifier.toLowerCase()]).toMatchObject({ id: keyed.id });
    expect(page.workItemRefs[byId.id]).toMatchObject({ id: byId.id, title: 'By id' });
    expect(page.workItemRefs[gone.id]).toBeUndefined();
    expect(page.workItemRefs['PGK-999']).toBeUndefined();

    const version = await pagesService.getPageVersion(fx.ctx, {
      projectId: fx.projectId,
      pageId,
      number: 1,
    });
    expect(version.workItemRefs[keyed.identifier]).toMatchObject({ id: keyed.id, title: 'Keyed' });
    // The stored body was not rewritten by the read.
    const stored = await adminDb.page.findUniqueOrThrow({ where: { id: pageId } });
    expect(stored.bodyMarkdown).toContain(`(motir:${keyed.identifier})`);
  });

  it('gives a key in a project the reader cannot browse the no-access chip', async () => {
    const hidden = await privateProjectItem();
    const pageId = await storedAsWritten(`[PRIV-1](motir:${hidden.identifier})`);
    const page = await pagesService.getPage(await member(), { projectId: fx.projectId, pageId });
    expect(page.workItemRefs[hidden.identifier]).toEqual({ accessible: false, id: hidden.id });
  });

  it('writes the derived link for a key-shaped mention saved past the markdown door', async () => {
    const keyed = await item('Keyed');
    const pageId = await storedAsWritten(`[K](motir:${keyed.identifier}) [X](motir:PGK-404)`);
    expect(await linkedIds(pageId)).toEqual([keyed.id]);
  });
});

describe('the markdown write door stores the id and reports dead links (MOTIR-11281)', () => {
  it('update_page rewrites a key href and a bare key, links the card and names each dead link', async () => {
    const keyed = await item('Keyed');
    const bare = await item('Bare');
    const page = await pagesService.createPage(fx.ctx, { projectId: fx.projectId, title: 'P' });

    const result = await runUpdatePage(
      {
        projectKey: 'PGK',
        pageId: page.id,
        revision: page.revision,
        markdown:
          `See [${keyed.identifier}](motir:${keyed.identifier}) and ${bare.identifier}.\n\n` +
          `![E](motir:${keyed.identifier})\n\n[dead](motir:nosuchid) [none](motir:PGK-999) ` +
          '[req](motir:page:abc) `[code](motir:PGK-1)`',
      },
      fx.ctx,
    );

    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      markdown: string;
      unresolvedItemLinks: { link: string }[];
    };
    expect(payload.markdown).toContain(`[${keyed.identifier}](motir:${keyed.id})`);
    expect(payload.markdown).toContain(`![E](motir:${keyed.id})`);
    expect(payload.markdown).toContain(`[${bare.identifier}](motir:${bare.id})`);
    expect(payload.markdown).toContain('`[code](motir:PGK-1)`');
    expect(payload.unresolvedItemLinks.map((l) => l.link)).toEqual([
      '[dead](motir:nosuchid)',
      '[none](motir:PGK-999)',
      '[req](motir:page:abc)',
    ]);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('3 work-item link(s) name no card you can see');
    expect(text).toContain('[none](motir:PGK-999)');
    expect(await linkedIds(page.id)).toEqual([bare.id, keyed.id].sort());
  });

  it('create_page resolves a key href and reports nothing when every link resolves', async () => {
    const keyed = await item('Keyed');
    const result = await runCreatePage(
      { projectKey: 'PGK', title: 'New', markdown: `[K](motir:${keyed.identifier})` },
      fx.ctx,
    );
    const payload = result.structuredContent as {
      id: string;
      markdown: string;
      unresolvedItemLinks: unknown[];
    };
    expect(payload.markdown).toContain(`[K](motir:${keyed.id})`);
    expect(payload.unresolvedItemLinks).toEqual([]);
    expect((result.content[0] as { text: string }).text).not.toContain('⚠️');
    expect(await linkedIds(payload.id)).toEqual([keyed.id]);
  });

  it('treats a card in a project the writer cannot browse as naming no card, and leaves it as written', async () => {
    const hidden = await privateProjectItem();
    const writer = await member();
    const page = await pagesService.createPage(fx.ctx, { projectId: fx.projectId, title: 'P' });
    const body = `[S](motir:${hidden.identifier}) [I](motir:${hidden.id})`;
    const saved = await pagesService.savePageMarkdown(writer, {
      projectId: fx.projectId,
      pageId: page.id,
      markdown: body,
      expectedRevision: page.revision,
    });
    expect(saved.markdown).toContain(body);
    expect(saved.unresolvedItemLinks.map((l) => l.target)).toEqual([hidden.identifier, hidden.id]);
  });

  it('leaves a body with no item link unchanged and creates an empty page with no report', async () => {
    const empty = await pagesService.createPageFromMarkdown(fx.ctx, {
      projectId: fx.projectId,
      title: 'Empty',
    });
    expect(empty.unresolvedItemLinks).toEqual([]);
    const saved = await pagesService.savePageMarkdown(fx.ctx, {
      projectId: fx.projectId,
      pageId: empty.id,
      markdown: 'Plain text, [a link](https://example.test).',
      expectedRevision: empty.revision,
    });
    expect(saved.markdown).toContain('[a link](https://example.test)');
    expect(saved.unresolvedItemLinks).toEqual([]);
  });
});
