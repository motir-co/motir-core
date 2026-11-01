import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItemLink } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { autoRelateWorkItemMentions } from '@/lib/workItems/autoRelateMentions';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, createTestProject } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { spyOnJobDispatch } from '../helpers/jobs';

// Auto-relate-on-mention (Story 5.8 · Subtask 5.8.3): saving a work-item text
// field or comment that REFERENCES another item (`[KEY](motir:<id>)` token or a
// bare `KEY-N`) auto-creates a `relates_to` link stamped `source = mention` —
// the link row IS the durable record (no separate mention table). ADD-only,
// idempotent, view-scoped, concurrency-safe. Real Postgres; the one external
// seam stubbed is the Inngest client's `send()` (the comment/mention events the
// hooks fan out — irrelevant to the link assertions here).
//
// Every item is created through `workItemsService.createWorkItem` (NOT the
// `createTestWorkItem` repo fixture) so each carries a VALID fractional-index
// position — a fixture-seeded padded position would break the next service
// create's sibling-append in the same project (the seed-position gotcha).

beforeEach(async () => {
  await truncateAuthTables();
  // Block the network for every post-commit event the hooks emit.
  spyOnJobDispatch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Create a task via the service (valid fractional position) in a project/ctx. */
function makeItem(
  projectId: string,
  ctx: ServiceContext,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem({ projectId, kind: 'task', title, ...extra }, ctx);
}

const token = (item: Pick<WorkItemDto, 'id' | 'identifier'>) =>
  `[${item.identifier}](motir:${item.id})`;

/** Every `relates_to` out-edge of an item, with its provenance. */
function relatesOut(fromId: string): Promise<WorkItemLink[]> {
  return adminDb.workItemLink.findMany({ where: { fromId, kind: 'relates_to' } });
}

function linkBetween(aId: string, bId: string): Promise<WorkItemLink | null> {
  return adminDb.workItemLink.findFirst({
    where: {
      OR: [
        { fromId: aId, toId: bId },
        { fromId: bId, toId: aId },
      ],
    },
  });
}

describe('auto-relate on create', () => {
  it('a motir: token in the description creates a relates_to link (source=mention) + reciprocal', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');

    const dto = await makeItem(fx.projectId, fx.ctx, 'Source', {
      descriptionMd: `Depends on context from ${token(target)}.`,
    });

    const forward = await adminDb.workItemLink.findUnique({
      where: { fromId_toId_kind: { fromId: dto.id, toId: target.id, kind: 'relates_to' } },
    });
    expect(forward).not.toBeNull();
    expect(forward!.source).toBe('mention');

    // The symmetric reciprocal row exists too, also stamped mention.
    const reciprocal = await adminDb.workItemLink.findUnique({
      where: { fromId_toId_kind: { fromId: target.id, toId: dto.id, kind: 'relates_to' } },
    });
    expect(reciprocal).not.toBeNull();
    expect(reciprocal!.source).toBe('mention');
  });

  it('a bare KEY-N in the title links too', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');

    const dto = await makeItem(fx.projectId, fx.ctx, `Follow-up to ${target.identifier}`);

    const link = await linkBetween(dto.id, target.id);
    expect(link).not.toBeNull();
    expect(link!.source).toBe('mention');
  });

  it('a bare KEY-N in the explanation links too', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');

    const dto = await makeItem(fx.projectId, fx.ctx, 'With explanation', {
      explanationMd: `Implements the plan from ${target.identifier}.`,
    });

    expect(await linkBetween(dto.id, target.id)).not.toBeNull();
  });

  it('skips a self-reference', async () => {
    const fx = await makeWorkItemFixture();
    // A create can't reference its not-yet-allocated key, so drive it via update.
    const dto = await makeItem(fx.projectId, fx.ctx, 'Lonely');
    await workItemsService.updateWorkItem(
      dto.id,
      { descriptionMd: `See ${dto.identifier} (myself).` },
      fx.ctx,
    );
    expect(await relatesOut(dto.id)).toHaveLength(0);
  });
});

// Bug MOTIR-9825 — a key or token quoted in code is literal text, not a
// reference, so saving it wires no edge; the same key in prose still does.
describe('auto-relate ignores code', () => {
  it('a key or token only in an inline code span or a code block relates nothing', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const other = await makeItem(fx.projectId, fx.ctx, 'Other');
    const dto = await makeItem(fx.projectId, fx.ctx, 'Source', {
      descriptionMd: [
        `Quote \`${target.identifier}\` and \`\`${token(other)}\`\`.`,
        '',
        '```',
        `${target.identifier} ${token(other)}`,
        '```',
      ].join('\n'),
      explanationMd: `    ${target.identifier}`,
    });

    expect(await relatesOut(dto.id)).toHaveLength(0);

    // An edit and a comment take the same rule.
    await workItemsService.updateWorkItem(
      dto.id,
      { descriptionMd: `Still only quoted: \`${target.identifier}\`.` },
      fx.ctx,
    );
    await commentsService.addComment(dto.id, { bodyMd: `\`${token(other)}\`` }, fx.ctx);
    expect(await relatesOut(dto.id)).toHaveLength(0);
  });

  it('the same key in prose relates, and a title key relates even in backticks', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const titled = await makeItem(fx.projectId, fx.ctx, 'Titled');

    const dto = await makeItem(fx.projectId, fx.ctx, `Follow-up to \`${titled.identifier}\``, {
      descriptionMd: `Quoted \`${target.identifier}\`, then meant: ${target.identifier}.`,
    });

    expect(await linkBetween(dto.id, target.id)).not.toBeNull();
    // A title is plain text and chips every bare key, so it relates every one.
    expect(await linkBetween(dto.id, titled.id)).not.toBeNull();
  });
});

describe('auto-relate on update + comment', () => {
  it('a bare KEY-N added in an edited description links', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const dto = await makeItem(fx.projectId, fx.ctx, 'Source');
    expect(await relatesOut(dto.id)).toHaveLength(0);

    await workItemsService.updateWorkItem(
      dto.id,
      { descriptionMd: `Now relates to ${target.identifier}.` },
      fx.ctx,
    );
    expect(await linkBetween(dto.id, target.id)).not.toBeNull();
  });

  it('a reference in a comment links from the comment’s work item', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const host = await makeItem(fx.projectId, fx.ctx, 'Host');

    await commentsService.addComment(host.id, { bodyMd: `cf. ${token(target)}` }, fx.ctx);

    const link = await linkBetween(host.id, target.id);
    expect(link).not.toBeNull();
    expect(link!.source).toBe('mention');
  });

  it('a reference added in a comment EDIT links', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const host = await makeItem(fx.projectId, fx.ctx, 'Host');

    const comment = await commentsService.addComment(host.id, { bodyMd: 'no refs yet' }, fx.ctx);
    expect(await relatesOut(host.id)).toHaveLength(0);

    await commentsService.editComment(
      comment.id,
      { bodyMd: `actually see ${target.identifier}` },
      fx.ctx,
    );
    expect(await linkBetween(host.id, target.id)).not.toBeNull();
  });
});

describe('auto-relate guards', () => {
  it('does NOT add a relates_to when the pair is already linked is_blocked_by', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Blocker');
    const source = await makeItem(fx.projectId, fx.ctx, 'Source');
    await workItemsService.linkWorkItems(
      { fromId: source.id, toId: target.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    await workItemsService.updateWorkItem(
      source.id,
      { descriptionMd: `relates? ${target.identifier}` },
      fx.ctx,
    );

    // The existing block is untouched; no relates_to edge was added.
    expect(await relatesOut(source.id)).toHaveLength(0);
    expect(
      await adminDb.workItemLink.findUnique({
        where: { fromId_toId_kind: { fromId: source.id, toId: target.id, kind: 'is_blocked_by' } },
      }),
    ).not.toBeNull();
  });

  it('is idempotent: re-saving the same reference adds no duplicate', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const dto = await makeItem(fx.projectId, fx.ctx, 'Source', {
      descriptionMd: `see ${target.identifier}`,
    });
    expect(await relatesOut(dto.id)).toHaveLength(1);

    // Edit the description to a DIFFERENT body that still references the same key.
    await workItemsService.updateWorkItem(
      dto.id,
      { descriptionMd: `still see ${target.identifier}, more text` },
      fx.ctx,
    );
    expect(await relatesOut(dto.id)).toHaveLength(1);
  });

  it('is non-destructive: removing the reference leaves the link', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const dto = await makeItem(fx.projectId, fx.ctx, 'Source', {
      descriptionMd: `see ${target.identifier}`,
    });
    expect(await linkBetween(dto.id, target.id)).not.toBeNull();

    await workItemsService.updateWorkItem(
      dto.id,
      { descriptionMd: 'no more references here' },
      fx.ctx,
    );
    // The link survives the reference's removal.
    expect(await linkBetween(dto.id, target.id)).not.toBeNull();
  });

  it('silently drops unresolved + cross-workspace references', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTH' });
    const foreign = await makeItem(other.projectId, other.ctx, 'Foreign');

    const dto = await makeItem(fx.projectId, fx.ctx, 'Source', {
      // A dangling token id AND a cross-workspace token id — both dropped.
      descriptionMd: `ghost [PROD-999](motir:does-not-exist) and ${token(foreign)}`,
    });

    expect(await relatesOut(dto.id)).toHaveLength(0);
    expect(await linkBetween(dto.id, foreign.id)).toBeNull();
  });

  it('silently drops a reference to a project the author cannot browse', async () => {
    const fx = await makeWorkItemFixture();
    // A second, PRIVATE project in the same workspace, with a target item.
    const secretProject = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Secret',
      identifier: 'SEC',
    });
    const hidden = await makeItem(secretProject.id, fx.ctx, 'Hidden');
    await projectMembersService.setAccessMode({
      key: 'SEC',
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      mode: 'members',
    });

    // A non-owner workspace member: can edit the OPEN source project, cannot
    // browse the PRIVATE target project (added after the flip, no membership).
    const editor = await usersService.createUser({
      email: 'editor@example.com',
      password: 'hunter2hunter2',
      name: 'Editor',
    });
    await workspacesService.addMember({ userId: editor.id, workspaceId: fx.workspaceId });
    const editorCtx: ServiceContext = { userId: editor.id, workspaceId: fx.workspaceId };

    const dto = await makeItem(fx.projectId, editorCtx, 'Source', {
      descriptionMd: `peek at ${token(hidden)}`,
    });

    expect(await linkBetween(dto.id, hidden.id)).toBeNull();
  });
});

describe('normalize bare refs on write (bug MOTIR-1440)', () => {
  /** The stored (canonical) description body, read back authoritatively. */
  async function storedDescription(id: string): Promise<string | null> {
    const row = await adminDb.workItem.findUnique({ where: { id } });
    return row?.descriptionMd ?? null;
  }

  it('CREATE rewrites a bare KEY-N in the description to the canonical token AND wires the edge', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');

    const dto = await makeItem(fx.projectId, fx.ctx, 'Source', {
      descriptionMd: `Depends on ${target.identifier} to ship.`,
    });

    // The stored body now carries the chip token, not the bare key.
    expect(await storedDescription(dto.id)).toBe(`Depends on ${token(target)} to ship.`);
    // The relates_to edge is still created (the 5.8.3 behaviour is preserved).
    expect(await linkBetween(dto.id, target.id)).not.toBeNull();
  });

  it('CREATE leaves an already-explicit token unchanged', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const body = `cf. ${token(target)} here.`;

    const dto = await makeItem(fx.projectId, fx.ctx, 'Source', { descriptionMd: body });

    expect(await storedDescription(dto.id)).toBe(body);
  });

  it('CREATE leaves an unknown bare key as plain text', async () => {
    const fx = await makeWorkItemFixture();
    const dto = await makeItem(fx.projectId, fx.ctx, 'Source', {
      descriptionMd: `ghost ${fx.projectIdentifier}-99999 not real`,
    });
    expect(await storedDescription(dto.id)).toBe(`ghost ${fx.projectIdentifier}-99999 not real`);
  });

  it('UPDATE rewrites a bare KEY-N added to the description', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const dto = await makeItem(fx.projectId, fx.ctx, 'Source');

    await workItemsService.updateWorkItem(
      dto.id,
      { descriptionMd: `Now relates to ${target.identifier}.` },
      fx.ctx,
    );

    expect(await storedDescription(dto.id)).toBe(`Now relates to ${token(target)}.`);
    expect(await linkBetween(dto.id, target.id)).not.toBeNull();
  });

  it('UPDATE re-saving an already-normalized body is a no-op (no spurious revision)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const dto = await makeItem(fx.projectId, fx.ctx, 'Source', {
      descriptionMd: `see ${target.identifier}`,
    });
    const canonical = await storedDescription(dto.id);
    expect(canonical).toBe(`see ${token(target)}`);

    const revisionsBefore = await adminDb.workItemRevision.count({ where: { workItemId: dto.id } });
    // Re-submit the canonical token form (what the editor reloads + re-saves).
    await workItemsService.updateWorkItem(dto.id, { descriptionMd: canonical! }, fx.ctx);

    expect(await storedDescription(dto.id)).toBe(canonical);
    // No body change → no new revision (the normalize is idempotent).
    const revisionsAfter = await adminDb.workItemRevision.count({
      where: { workItemId: dto.id },
    });
    expect(revisionsAfter).toBe(revisionsBefore);
  });

  it('also normalizes a bare key in the explanation body', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');

    const dto = await makeItem(fx.projectId, fx.ctx, 'Source', {
      explanationMd: `Implements ${target.identifier}.`,
    });

    const row = await adminDb.workItem.findUnique({ where: { id: dto.id } });
    expect(row?.explanationMd).toBe(`Implements ${token(target)}.`);
  });

  // Bug MOTIR-2043 — the write path must not splice a token into a key the
  // author deliberately put in code or in a path. Asserted HERE, at the seam,
  // because the corruption was PERSISTED: the unit test proves the string rule,
  // this proves the row that lands in the DB.
  it('CREATE leaves a key in code / a link destination literal, yet still wires the edge', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const body = [
      `Documented as \`${target.identifier}\`, linked at [it](/items/${target.identifier}),`,
      '',
      '```',
      `const key = "${target.identifier}";`,
      '```',
      '',
      `and blocked by ${target.identifier} in prose.`,
    ].join('\n');

    const dto = await makeItem(fx.projectId, fx.ctx, 'Source', { descriptionMd: body });

    // Only the PROSE key became a chip token; code, span and path are verbatim.
    expect(await storedDescription(dto.id)).toBe(
      body.replace(`blocked by ${target.identifier}`, `blocked by ${token(target)}`),
    );
    // The reference still counts: the relates_to edge (5.8.3) is unaffected.
    expect(await linkBetween(dto.id, target.id)).not.toBeNull();
  });

  it('UPDATE of a body whose ONLY key sits in code stores it byte-identical', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const dto = await makeItem(fx.projectId, fx.ctx, 'Source');
    const body = `Write \`${target.identifier}\` to reference it.`;

    await workItemsService.updateWorkItem(dto.id, { descriptionMd: body }, fx.ctx);

    expect(await storedDescription(dto.id)).toBe(body);
  });
});

describe('auto-relate concurrency', () => {
  it('two near-simultaneous writes referencing the same target yield exactly ONE link', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const source = await makeItem(fx.projectId, fx.ctx, 'Source');

    const refText = `see ${token(target)}`;
    // Bound (MOTIR-2753): `autoRelateWorkItemMentions` is the code under test and it
    // reads the mention target through `work_item`. Unbound the target is invisible,
    // no link is attempted by either racer, and "exactly ONE link" holds trivially at
    // zero — the concurrency claim would evaporate.
    const run = () =>
      withWorkspaceContext(fx.ctx, (tx) =>
        autoRelateWorkItemMentions(
          {
            source: {
              id: source.id,
              workspaceId: fx.workspaceId,
              projectId: fx.projectId,
              projectIdentifier: fx.projectIdentifier,
            },
            bodies: [refText],
            ctx: fx.ctx,
          },
          tx,
        ),
      );

    // Either winner is fine — the @@unique serialises the race; neither throws.
    await Promise.all([run(), run()]);

    const forward = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemLinkRepository.findByFromItem(source.id, 'relates_to', tx),
    );
    const toTarget = forward.filter((l) => l.toId === target.id);
    expect(toTarget).toHaveLength(1);
    expect(toTarget[0]!.source).toBe('mention');
  });
});
