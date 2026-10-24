import { adminDb } from './db-reset';
import { linkProjectRepo } from '@/tests/helpers/projectRepoLink';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { reconcileGatesFor } from '@/lib/services/gateSetFor';
import { createTestPerson } from './testPerson';
import { seedGithubInstallation } from './github-seed';
import { E2E_PROVISIONING_ORG } from './github-const';

// THE ACCEPTANCE-GATE E2E SEED (Story MOTIR-4949 · Subtask MOTIR-5792), for the receipt
// `regression-gate.spec.ts` records.
//
// WHAT GOES THROUGH THE PRODUCT, AND WHAT IS PLANTED:
//   * the people, workspace, project, memberships, stories and their E2E subtasks — their
//     services;
//   * the GitHub installation and both repositories — `seedGithubInstallation`, as every
//     GitHub E2E seeds them;
//   * How to test — `testInstructionsService.publish`;
//   * the pull requests, their links, their green checks, the MERGE gate and every merge —
//     NOT seeded. The spec drives them through the REAL webhook route and the REAL link
//     door, so the questions the walk decides are the ones the product raised.
//
// ⚠️ THE RECEIPT'S BYTES ARE PLANTED AND ITS QUESTION IS NOT (`publishReceipt` below).
// `acceptanceEvidenceService.recordFromUpload` writes through the blob uploader, and the
// RUNNER has no blob mock — only the server does (`E2E_TEST_BLOB`, selected in
// `playwright.acceptance.config.ts`), which is why the older `acceptance-seed.ts` inserts
// its rows directly too. So the rows are written here and then the SHIPPED predicate is
// asked what the story should be asking: `reconcileGatesFor` is the one place a gate row
// is created (`lib/services/gateSetFor.ts`), and it is the same call the publish path
// makes. A hand-planted `approval_gate` row would make the walk prove nothing about which
// questions a receipt raises.
//
// ⚠️ THE REPOSITORIES BELONG TO THE PROVISIONING ORG, and that is load-bearing — a merge
// mints its installation token with the App the repository's owner selects, and this lane
// configures only the provisioning App. The sibling seed records the same fact at length.
//
// ⚠️ PLAIN MEMBER, not an admin, for the person who must NOT be able to decide: the gate's
// admin arm reads the WORKSPACE role, so an admin bystander would be offered the verbs.
//
// ⚠️ AND THE ORG MUST BE ON A PAID PLAN, which the SPEC sets (`setOrgBillingState`), because
// the acceptance panel reaches its State A — the recording plus the door into the decision —
// only for a paid org with the toggle on. A free org gets the UPSELL instead, and the walk
// reads it as *the question is missing*: the second recording attempt failed exactly there,
// on a story whose Development block had already shown the receipt correctly, because the
// slot consults no entitlement and the standalone section does.

export const ACCEPTANCE_GATE_PASSWORD = 'acceptance-gate-e2e-pass-4';

/** The two repositories a story run delivers into, on the shared E2E installation. */
export const WEB_REPO = {
  providerRepoId: '88020001',
  owner: E2E_PROVISIONING_ORG,
  name: 'accgate-web',
  defaultBranch: 'main',
  archived: false,
} as const;
export const API_REPO = {
  providerRepoId: '88020002',
  owner: E2E_PROVISIONING_ORG,
  name: 'accgate-api',
  defaultBranch: 'main',
  archived: false,
} as const;

export type SeedRepo = typeof WEB_REPO | typeof API_REPO;

export interface SeededCard {
  id: string;
  identifier: string;
  title: string;
}

/** A story and the E2E subtask under it that recorded its run. */
export interface SeededStory {
  story: SeededCard;
  e2e: SeededCard;
}

export interface AcceptanceGateSeed {
  ownerEmail: string;
  /** The workspace's organization — whose billing state the acceptance panel reads. */
  organizationId: string;
  ownerName: string;
  /** The owner's user id — the receipt's uploader, and the person every gate is routed to. */
  ownerUserId: string;
  bystanderEmail: string;
  password: string;
  workspaceId: string;
  projectId: string;
  /** Run as a WHOLE: the story's own pull requests, green. One press accepts and merges. */
  storyRun: SeededStory;
  /** A SINGLE-CARD run: the E2E subtask holds the pull requests, the story holds the receipt. */
  singleCard: SeededStory;
  /** Accepted BEFORE the checks pass — the merge follows the next green with no second press. */
  held: SeededStory;
  /** Walked in `zh`, run as a whole. */
  zh: SeededStory;
}

const OWNER_NAME = 'Olive Owner';

export async function seedAcceptanceGate(slug: string): Promise<AcceptanceGateSeed> {
  const ownerEmail = `accgate-owner-${slug}@example.com`;
  const bystanderEmail = `accgate-bystander-${slug}@example.com`;
  const owner = await createTestPerson({
    email: ownerEmail,
    password: ACCEPTANCE_GATE_PASSWORD,
    name: OWNER_NAME,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acceptance gate E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Checkout',
    identifier: 'ACCG',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // A person approves a green pull request before it merges — the mode this story is for.
  // The acceptance-video switch carries `@default(true)`, and it is SET here rather than
  // left to the default: a walk that passes because nobody turned it off passes for the
  // wrong reason (`acceptance-seed.ts` § `setProjectAcceptanceVideo`).
  await adminDb.project.update({
    where: { id: project.id },
    data: { prMergeMode: 'manual', acceptanceVideoEnabled: true },
  });

  const bystander = await createTestPerson({
    email: bystanderEmail,
    password: ACCEPTANCE_GATE_PASSWORD,
    name: 'Rae Reporter',
  });
  await workspacesService.addMember({ userId: bystander.id, workspaceId: workspace.id });
  for (const userId of [owner.id, bystander.id]) {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
  }

  await seedGithubInstallation(workspace.id, [WEB_REPO, API_REPO]);
  const repoRow = (providerRepoId: string) =>
    adminDb.githubRepo.findFirstOrThrow({ where: { repoId: providerRepoId } });
  const webRow = await repoRow(WEB_REPO.providerRepoId);
  const apiRow = await repoRow(API_REPO.providerRepoId);
  // Sequentially — concurrent project-repo appends race on the position key.
  for (const [row, role] of [
    [webRow, 'web'],
    [apiRow, 'api'],
  ] as const) {
    await linkProjectRepo({
      workspaceId: workspace.id,
      projectId: project.id,
      githubRepoId: row.id,
      name: row.name,
      role,
    });
  }

  const ctx = { userId: owner.id, workspaceId: workspace.id };

  /**
   * A story IN REVIEW with the E2E subtask that recorded it beneath, at `implemented`.
   *
   * ⚠️ THE CHILD STOPS SHORT OF `done`, AND THE FIRST RECORDING ATTEMPT IS WHY. Taking it
   * all the way rolls the STORY up to `done` — a parent whose children are all closed is
   * closed with them, and the parent transition back to `in_review` does not stick against
   * the roll-up. A terminal card asks NOTHING (`resolveGateSet`'s first line), so the
   * publish raised no question at all and the To-approve tab read *Nothing is waiting on
   * your approval*: a seed that had quietly built the one shape this walk cannot record.
   *
   * An `implemented` child is not a problem for the decision it is recording: the story
   * reaches `done` on its MERGE (the MOTIR-5787 amendment, point 7), and the child status
   * cascade closes every still-open child with it.
   */
  const story = async (title: string, e2eTitle: string): Promise<SeededStory> => {
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'story', title },
      ctx,
    );
    const child = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'subtask', title: e2eTitle, parentId: item.id },
      ctx,
    );
    // Routed to the owner — `assigneeId ?? reporterId`.
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: owner.id } });
    for (const status of ['in_progress', 'in_review', 'implemented'] as const) {
      await workItemsService.updateStatus(child.id, status, ctx);
    }
    await workItemsService.updateStatus(item.id, 'in_progress', ctx);
    await workItemsService.updateStatus(item.id, 'in_review', ctx);
    return {
      story: { id: item.id, identifier: item.identifier, title },
      e2e: { id: child.id, identifier: child.identifier, title: e2eTitle },
    };
  };

  const storyRun = await story(
    'Hold a basket for fifteen minutes',
    'E2E · hold a basket for fifteen minutes',
  );
  const singleCard = await story(
    'Show the delivery estimate at checkout',
    'E2E · show the delivery estimate',
  );
  const held = await story('Let a shopper save a card', 'E2E · let a shopper save a card');
  const zh = await story('Resend a receipt by email', 'E2E · resend a receipt by email');

  // The first story's REPORTER is the bystander: somebody who can see the card and is not
  // the person the question is routed to.
  await adminDb.workItem.update({
    where: { id: storyRun.story.id },
    data: { reporterId: bystander.id },
  });

  // How to test on the story run, so its frame's port shows the evidence below the rows.
  await testInstructionsService.publish(
    {
      workItemId: storyRun.story.id,
      bodyMd: [
        '## Click-path',
        '',
        '1. Put a bike light in the basket and leave.',
        '2. Come back inside fifteen minutes — the basket still holds it.',
      ].join('\n'),
      repos: [
        { repoId: webRow.id, commitSha: headShaFor(17101) },
        { repoId: apiRow.id, commitSha: headShaFor(17102) },
      ],
    },
    ctx,
  );

  return {
    ownerEmail,
    organizationId: workspace.organizationId ?? '',
    ownerName: OWNER_NAME,
    ownerUserId: owner.id,
    bystanderEmail,
    password: ACCEPTANCE_GATE_PASSWORD,
    workspaceId: workspace.id,
    projectId: project.id,
    storyRun,
    singleCard,
    held,
    zh,
  };
}

export interface PublishedReceipt {
  id: string;
  commitSha: string;
}

/**
 * The story's RECEIPT — the rows a green recording leaves, and then the shipped predicate.
 *
 * The chapter list is what the player scrubs by and what the queue row counts, so it is
 * real rather than a placeholder. `blobPathname` is an empty `data:` URL: the player's
 * `<video>` needs a valid source and this walk never plays one, so a byte over that is a
 * byte the recording has to wait for.
 */
export async function publishReceipt(args: {
  workspaceId: string;
  uploaderUserId: string;
  story: SeededCard;
  producedByKey: string;
  commitSha: string;
}): Promise<PublishedReceipt> {
  const attachment = await adminDb.attachment.create({
    data: {
      workspaceId: args.workspaceId,
      uploaderUserId: args.uploaderUserId,
      workItemId: args.story.id,
      source: 'acceptance_video',
      blobPathname: 'data:video/webm;base64,',
      mimeType: 'video/webm',
      sizeBytes: 1024,
      originalFilename: 'acceptance.webm',
    },
  });
  const evidence = await adminDb.acceptanceEvidence.create({
    data: {
      workspaceId: args.workspaceId,
      workItemId: args.story.id,
      attachmentId: attachment.id,
      chapters: [
        { label: 'Fill the basket', tSeconds: 0 },
        { label: 'Leave and come back', tSeconds: 12 },
        { label: 'The basket still holds it', tSeconds: 31 },
      ],
      status: 'pending',
      commitSha: args.commitSha,
      ciRunUrl: 'https://ci.example/run/16',
      producedByKey: args.producedByKey,
      isCurrent: true,
    },
  });

  // THE QUESTION, raised by the product (`reconcileGatesFor`) rather than by this seed —
  // see the file header. `adminDb` owns the transaction, as every other write here does.
  const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: args.story.id } });
  await adminDb.$transaction((tx) => reconcileGatesFor(item, tx));

  return { id: evidence.id, commitSha: args.commitSha };
}

/** The head commit a pull request's green checks report — stable per number, 40 hex chars. */
export function headShaFor(number: number): string {
  return number.toString(16).padStart(8, '0').repeat(5);
}
