// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createTranslator, type AbstractIntlMessages } from 'next-intl';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { LinkedPullRequestDto, LinkedPullRequestReaderAccessDto } from '@/lib/dto/github';
import messages from '@/messages/en.json';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { countDelegateCalls } from '../helpers/countDelegateCalls';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { setWorkspaceRoleFor } from '../helpers/workspaceRoleFixtures';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// ═══════════════════════════════════════════════════════════════════════════
// THE READER'S ACCESS ON THE PULL-REQUEST ROW — the integration gate (Story
// MOTIR-4881 · MOTIR-12117; design `design/github/design-notes.md` § 35)
// ═══════════════════════════════════════════════════════════════════════════
//
// The data card's suite (`pullRequestReaderAccess.test.ts`) never renders, and the row
// card's (`prRowReaderAccess.test.tsx`) hands the row a hand-built DTO. This is the one
// suite that runs the REAL writer's output through the REAL consumer: a seeded project on
// real Postgres, read for each reader through the three hosts' own reads — the quick
// view's `getQuickView`, the item page's `readLateSections`, the approval overlay's
// `GET /api/work-items/approval-gate` (both kinds that port the Development block, with
// and without `?since=`) — each taken through a JSON round trip, as the wire carries it,
// and rendered through the real `DevelopmentSectionBody`.
//
// What is mocked, and why none of it is on the seam: `getSession()` and the active
// project the route resolves from the request's cookies (a Vitest process has neither,
// exactly as `tests/api/approval-gate-route.test.ts` stubs them); `next-intl/server`,
// which has no request to read a locale from (as `storyGateRender.test.tsx` answers it);
// and the app router the overlay frame's verbs call. Every read is the real path.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: async () => session.current };
});
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => activeCtx.current };
});
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: messages as unknown as AbstractIntlMessages,
      namespace: namespace as never,
    }),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const { GET: gateRoute } = await import('@/app/api/work-items/approval-gate/route');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { assignableMembersService } = await import('@/lib/services/assignableMembersService');
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { githubIdentityRepository } = await import('@/lib/repositories/githubIdentityRepository');
const { withUserContext, withWorkspaceContext } = await import('@/lib/workspaces/context');
const { readLateSections } = await import('@/app/(authed)/items/[key]/_components/lateReads');
const { DevelopmentSectionBody } = await import('@/components/github/DevelopmentSection');

const MOTIR_ORG = 'motir-projects';
const INVITATION = `https://github.com/${MOTIR_ORG}/shop-web/invitations`;
const OPEN_ON_GITHUB = messages.github.development.openOnGithub;

type ReaderName = 'accepted' | 'invited' | 'notInvited' | 'roleCannotEdit' | 'noGithub';
interface Reader {
  name: ReaderName;
  id: string;
  email: string;
  ctx: ServiceContext;
}

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  session.current = null;
  activeCtx.current = null;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Seed ────────────────────────────────────────────────────────────────────

async function mirror(on: WorkItemFixture, owner: string, name: string) {
  seq += 1;
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: on.workspaceId,
      installationId: `inst-12117-${seq}`,
      accountLogin: owner,
      accountType: 'Organization',
      provider: 'github',
    },
  });
  return adminDb.githubRepo.create({
    data: {
      workspaceId: on.workspaceId,
      organizationId: on.workspace.organizationId,
      installationId: installation.id,
      repoId: `repo-12117-${seq}`,
      owner,
      name,
      defaultBranch: 'main',
      provider: 'github',
    },
  });
}

async function setRow(
  on: WorkItemFixture,
  repo: { id: string; name: string },
  state: 'connected' | 'created',
) {
  const row = await linkProjectRepo({
    workspaceId: on.workspaceId,
    projectId: on.projectId,
    githubRepoId: repo.id,
    name: repo.name,
  });
  if (state === 'created') {
    await adminDb.projectRepo.update({ where: { id: row.id }, data: { state: 'created' } });
  }
  return row;
}

async function openPullRequest(
  on: WorkItemFixture,
  item: { id: string },
  repo: { id: string; name: string },
) {
  seq += 1;
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: 400 + seq,
      title: `Change in ${repo.name}`,
      state: 'open',
      merged: false,
      headRef: `parent/PROD-${seq}`,
      baseRef: 'main',
      provider: 'github',
    },
  });
  await adminDb.githubCheckRun.create({
    data: {
      pullRequestId: pr.id,
      commitSha: `${repo.name}-${seq}`.padEnd(40, '0'),
      checkName: 'Vitest',
      conclusion: 'success',
    },
  });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: on.workspaceId,
      workItemId: item.id,
      githubPullRequestId: pr.id,
      repoId: repo.id,
    },
  });
  return pr;
}

async function connectGithub(userId: string, login: string) {
  seq += 1;
  await withUserContext(userId, (tx) =>
    githubIdentityRepository.upsertForUser(
      {
        userId,
        githubUserId: `gh-12117-${seq}`,
        githubLogin: login,
        avatarUrl: null,
        accessTokenEncrypted: 'encrypted-not-read-here',
      },
      tx,
    ),
  );
}

/** A project member with a REAL role — `viewer` is the role that cannot edit. */
async function addReader(on: WorkItemFixture, name: ReaderName, role: 'member' | 'viewer') {
  seq += 1;
  const email = `${name}-${seq}@example.com`;
  const user = await adminDb.user.create({ data: { name, email, emailVerified: true } });
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: on.workspaceId, workspaceRole: 'member' },
  });
  await setWorkspaceRoleFor(user.id, on.workspaceId, role);
  await adminDb.projectMembership.create({
    data: { userId: user.id, projectId: on.projectId, workspaceId: on.workspaceId },
  });
  return { name, id: user.id, email, ctx: { userId: user.id, workspaceId: on.workspaceId } };
}

async function record(
  on: WorkItemFixture,
  projectRepoId: string,
  userId: string,
  login: string,
  o: { invited?: boolean; accepted?: boolean },
) {
  await adminDb.projectRepoCollaborator.create({
    data: {
      workspaceId: on.workspaceId,
      projectRepoId,
      userId,
      githubLogin: login,
      permission: 'push',
      invitedAt: new Date(),
      acceptedAt: o.accepted ? new Date() : null,
      invitationUrl: o.accepted ? null : INVITATION,
    },
  });
}

/**
 * The story's world: a project with a Motir-created repository (`created`, realized) and
 * a connected one, a repository outside the set, a card in review with an open pull
 * request in each and its approve-to-merge and review gates awaiting, a READY preview on
 * the created repository's pull request, and one reader per state.
 */
async function seed() {
  const created = await mirror(fx, MOTIR_ORG, 'shop-web');
  const createdRow = await setRow(fx, created, 'created');
  const connected = await mirror(fx, 'acme', 'shop-api');
  await setRow(fx, connected, 'connected');
  const outside = await mirror(fx, 'acme', 'design-tokens');

  const made = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Export the invoice list as CSV' },
    fx.ctx,
  );
  await workItemsService.updateStatus(made.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(made.id, 'in_review', fx.ctx);
  const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: made.id } });

  const createdPr = await openPullRequest(fx, item, created);
  const connectedPr = await openPullRequest(fx, item, connected);
  const outsidePr = await openPullRequest(fx, item, outside);
  const preview = await adminDb.previewDeployment.create({
    data: {
      workspaceId: fx.workspaceId,
      repoId: created.id,
      pullRequestNumber: createdPr.number,
      headSha: 'a'.repeat(40),
      host: `pr-${createdPr.number}--shop-web.preview.motir.site`,
      state: 'ready',
    },
  });
  for (const kind of ['pull_request_approval', 'agent_review'] as const) {
    await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: item.id,
          kind: kind as 'design_result',
          subjectId: item.id,
        },
        tx,
      ),
    );
  }

  const readers = {
    accepted: await addReader(fx, 'accepted', 'member'),
    invited: await addReader(fx, 'invited', 'member'),
    notInvited: await addReader(fx, 'notInvited', 'member'),
    roleCannotEdit: await addReader(fx, 'roleCannotEdit', 'viewer'),
    noGithub: await addReader(fx, 'noGithub', 'member'),
  } satisfies Record<ReaderName, Reader>;
  for (const r of ['accepted', 'invited', 'notInvited', 'roleCannotEdit'] as const) {
    await connectGithub(readers[r].id, `${r}-gh`);
  }
  await record(fx, createdRow.id, readers.accepted.id, 'accepted-gh', { accepted: true });
  await record(fx, createdRow.id, readers.invited.id, 'invited-gh', { invited: true });
  await record(fx, createdRow.id, readers.roleCannotEdit.id, 'roleCannotEdit-gh', {
    accepted: true,
  });

  return { item, createdPr, connectedPr, outsidePr, preview, readers };
}

type World = Awaited<ReturnType<typeof seed>>;

/** What the story's table names for each reader on the created repository's row. */
const EXPECTED: Record<
  ReaderName,
  { access: LinkedPullRequestReaderAccessDto; linkOut: boolean; variant: string | null }
> = {
  accepted: {
    access: { state: 'accepted', reason: null, invitationUrl: null },
    linkOut: true,
    variant: null,
  },
  invited: {
    access: { state: 'invited', reason: null, invitationUrl: INVITATION },
    linkOut: true,
    variant: 'invited',
  },
  notInvited: {
    access: { state: 'not_invited', reason: null, invitationUrl: null },
    linkOut: true,
    variant: 'notInvited',
  },
  roleCannotEdit: {
    access: { state: 'accepted', reason: 'role_cannot_edit', invitationUrl: null },
    linkOut: false,
    variant: 'roleCannotEdit',
  },
  noGithub: {
    access: { state: 'not_invited', reason: 'no_github_identity', invitationUrl: null },
    linkOut: false,
    variant: 'noGithubPreview',
  },
};

// ── The three hosts' reads, as the wire carries them ────────────────────────

const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function signIn(reader: Reader) {
  session.current = { user: { id: reader.id, email: reader.email, name: reader.name } };
  activeCtx.current = {
    userId: reader.id,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  } as ProjectContext;
}

async function viaRoute(item: WorkItem, kind: string, since?: string) {
  const qs = new URLSearchParams({ key: item.identifier, kind });
  if (since !== undefined) qs.set('since', since);
  const res = await gateRoute(
    new Request(`http://localhost:3000/api/work-items/approval-gate?${qs}`),
  );
  return { status: res.status, body: await res.json() };
}

interface HostReads {
  peek: LinkedPullRequestDto[];
  page: LinkedPullRequestDto[];
  overlay: LinkedPullRequestDto[];
  /** Every pull-request list the three hosts were handed, labelled. */
  all: [string, LinkedPullRequestDto[]][];
  statuses: number[];
}

async function readAllHosts(w: World, reader: Reader): Promise<HostReads> {
  const { item } = w;
  const quick = wire(
    await workItemsService.getQuickView(
      fx.projectId,
      item.identifier,
      fx.project.accessMode,
      reader.ctx,
      'en',
    ),
  );
  const late = wire(
    await readLateSections({
      itemId: item.id,
      itemType: null,
      itemStatus: 'in_review',
      itemKind: 'story',
      projectId: fx.projectId,
      ctx: reader.ctx,
      fullCtx: reader.ctx,
      activityTab: 'comments',
      canEdit: false,
      itemIdentifier: item.identifier,
      projectKey: fx.projectIdentifier,
      hasChildren: false,
    }),
  );
  const linked = wire(await workItemsService.listLinkedPullRequests(item.id, reader.ctx));
  const set = wire(await workItemsService.listDeliverySet(item.id, reader.ctx));

  signIn(reader);
  const statuses: number[] = [];
  const all: [string, LinkedPullRequestDto[]][] = [
    ['getQuickView', quick.pullRequests],
    ['readLateSections', late.pullRequests],
    ['listLinkedPullRequests', linked],
    ['listDeliverySet', set.map((d) => d.pullRequest)],
  ];
  let overlay: LinkedPullRequestDto[] = [];
  for (const kind of ['pull_request_approval', 'agent_review']) {
    const first = await viaRoute(item, kind);
    const again = await viaRoute(item, kind, first.body.stamp ?? 'v1.stale');
    for (const [label, read] of [
      [kind, first],
      [`${kind}?since=`, again],
    ] as const) {
      statuses.push(read.status);
      all.push([`route ${label} pullRequests`, read.body.subject.pullRequests]);
      all.push([
        `route ${label} deliveries`,
        read.body.subject.deliveries.map(
          (d: { pullRequest: LinkedPullRequestDto }) => d.pullRequest,
        ),
      ]);
    }
    if (kind === 'pull_request_approval') overlay = first.body.subject.pullRequests;
  }
  return { peek: quick.pullRequests, page: late.pullRequests, overlay, all, statuses };
}

/** `readerAccess` per pull-request id, from one host's list. */
const accessById = (rows: LinkedPullRequestDto[]) =>
  new Map(rows.map((r) => [r.id, r.readerAccess]));

// ── The render ──────────────────────────────────────────────────────────────

interface DrawnRow {
  linkOut: string | null;
  variant: string | null;
  lineLink: string | null;
}

function drawn(ui: ReactElement): Map<string, DrawnRow> {
  render(ui);
  const out = new Map<string, DrawnRow>();
  for (const li of screen.getAllByRole('listitem')) {
    const title = li.textContent ?? '';
    const line = within(li).queryByTestId('pr-row-access');
    // Keyed by the repository NAME the row's meta line shows (`owner/name · #n`).
    const key = /[\w-]+\/([\w-]+) · #/.exec(title)?.[1] ?? title;
    out.set(key, {
      linkOut:
        within(li).queryByRole('link', { name: OPEN_ON_GITHUB })?.getAttribute('href') ?? null,
      variant: line?.dataset.accessVariant ?? null,
      lineLink: line ? (within(line).queryByRole('link')?.getAttribute('href') ?? null) : null,
    });
    expect(li.textContent!.trim().length).toBeGreaterThan(0);
  }
  cleanup();
  return out;
}

function renderOnHosts(h: HostReads) {
  return {
    peek: drawn(<DevelopmentSectionBody pullRequests={h.peek} itemIdentifier="PROD-1" />),
    page: drawn(
      <DevelopmentSectionBody
        pullRequests={h.page}
        itemIdentifier="PROD-1"
        manualLinkable
        rowAction={() => null}
      />,
    ),
    overlay: drawn(<DevelopmentSectionBody pullRequests={h.overlay} itemIdentifier="PROD-1" />),
  };
}

// ── The cases ───────────────────────────────────────────────────────────────

describe('each reader reads the story’s table on all three hosts', () => {
  it.each(Object.keys(EXPECTED) as ReaderName[])('%s', async (name) => {
    const w = await seed();
    const reader = w.readers[name];
    const want = EXPECTED[name];
    const h = await readAllHosts(w, reader);

    expect(h.statuses.every((s) => s === 200)).toBe(true);
    for (const [label, rows] of h.all) {
      const byId = accessById(rows);
      expect({ label, access: byId.get(w.createdPr.id) }).toEqual({ label, access: want.access });
      // The connected row and the repository outside the set carry no access fact.
      expect({ label, access: byId.get(w.connectedPr.id) }).toEqual({ label, access: null });
      expect({ label, access: byId.get(w.outsidePr.id) }).toEqual({ label, access: null });
    }

    const renders = renderOnHosts(h);
    const created = renders.peek.get('shop-web')!;
    expect(created.linkOut !== null).toBe(want.linkOut);
    if (created.linkOut) {
      expect(created.linkOut).toBe(
        `https://github.com/${MOTIR_ORG}/shop-web/pull/${w.createdPr.number}`,
      );
    }
    expect(created.variant).toBe(want.variant);
    if (name === 'invited') expect(created.lineLink).toBe(INVITATION);
    if (name === 'notInvited') expect(created.lineLink).toBe('/settings/project/code-access');
    for (const other of ['shop-api', 'design-tokens']) {
      expect(renders.peek.get(other)).toMatchObject({ variant: null });
      expect(renders.peek.get(other)!.linkOut).toMatch(/^https:\/\/github\.com\/acme\//);
    }
    // The three hosts draw the row the same.
    expect(renders.page).toEqual(renders.peek);
    expect(renders.overlay).toEqual(renders.peek);
  });

  it('the no-GitHub reader is told no preview is available once the preview closes', async () => {
    const w = await seed();
    await adminDb.previewDeployment.update({
      where: { id: w.preview.id },
      data: { state: 'closed' },
    });
    const h = await readAllHosts(w, w.readers.noGithub);
    const renders = renderOnHosts(h);
    expect(renders.peek.get('shop-web')).toEqual({
      linkOut: null,
      variant: 'noGithubNoPreview',
      lineLink: null,
    });
    expect(renders.page).toEqual(renders.peek);
    expect(renders.overlay).toEqual(renders.peek);
  });
});

describe('the guards', () => {
  it('a reader outside the access candidate set reads null everywhere, and every host still answers', async () => {
    const w = await seed();
    const reader = w.readers.invited;
    // Every reader who may browse is enumerated by the shipped scope chokepoint today, so
    // a reader it does not return is made by filtering them out of its REAL answer.
    const real = assignableMembersService.list.bind(assignableMembersService);
    vi.spyOn(assignableMembersService, 'list').mockImplementation(async (input) =>
      (await real(input)).filter((m) => m.userId !== reader.id),
    );

    const h = await readAllHosts(w, reader);
    expect(h.statuses.every((s) => s === 200)).toBe(true);
    for (const [, rows] of h.all) {
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(row.readerAccess).toBeNull();
    }
    const renders = renderOnHosts(h);
    for (const row of renders.peek.values()) {
      expect(row.linkOut).not.toBeNull();
      expect(row.variant).toBeNull();
    }
  });

  it('the access lookup costs the same with one pull request as with several', async () => {
    const created = await mirror(fx, MOTIR_ORG, 'shop-web');
    const row = await setRow(fx, created, 'created');
    const connected = await mirror(fx, 'acme', 'shop-api');
    await setRow(fx, connected, 'connected');
    const outside = await mirror(fx, 'acme', 'design-tokens');
    const reader = await addReader(fx, 'invited', 'member');
    await connectGithub(reader.id, 'invited-gh');
    await record(fx, row.id, reader.id, 'invited-gh', { invited: true });

    const one = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'One' },
      fx.ctx,
    );
    await openPullRequest(fx, one, created);
    const many = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Many' },
      fx.ctx,
    );
    for (const repo of [created, created, created, connected, outside]) {
      await openPullRequest(fx, many, repo);
    }

    const count = async (id: string) =>
      (
        await countDelegateCalls('projectRepoCollaborator', 'findMany', () =>
          workItemsService.listLinkedPullRequests(id, reader.ctx),
        )
      ).queries;
    const identities = async (id: string) =>
      (
        await countDelegateCalls('githubIdentity', 'findMany', () =>
          workItemsService.listDeliverySet(id, reader.ctx),
        )
      ).queries;

    expect(await count(one.id)).toBe(1);
    expect(await count(many.id)).toBe(1);
    expect(await identities(many.id)).toBe(await identities(one.id));
  });

  it('a second workspace’s record for the same login and owner/name never reaches workspace A', async () => {
    const w = await seed();
    const fxB = await makeWorkItemFixture({ name: 'Beta', identifier: 'BETA' });
    const repoB = await mirror(fxB, MOTIR_ORG, 'shop-web');
    const rowB = await setRow(fxB, repoB, 'created');
    // Workspace B's member holds an ACCEPTED record under the not-invited reader's login.
    const memberB = await addReader(fxB, 'accepted', 'member');
    await record(fxB, rowB.id, memberB.id, 'notInvited-gh', { accepted: true });
    // …and the not-invited reader of workspace A is a member of B too, accepted there.
    await adminDb.workspaceMembership.create({
      data: {
        userId: w.readers.notInvited.id,
        workspaceId: fxB.workspaceId,
        workspaceRole: 'member',
      },
    });
    await record(fxB, rowB.id, w.readers.notInvited.id, 'notInvited-gh', { accepted: true });

    const h = await readAllHosts(w, w.readers.notInvited);
    for (const [label, rows] of h.all) {
      expect({ label, access: accessById(rows).get(w.createdPr.id) }).toEqual({
        label,
        access: EXPECTED.notInvited.access,
      });
    }
  });
});
