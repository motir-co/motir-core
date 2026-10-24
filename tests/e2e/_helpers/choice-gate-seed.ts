import { adminDb } from '@/tests/helpers/adminDb';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestPerson } from './testPerson';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// THE CHOICE GATE E2E SEED (Story MOTIR-4914 · Subtask MOTIR-5899), for the acceptance
// receipt `regression-choice-gate.spec.ts` records.
//
// WHAT GOES THROUGH A SERVICE, AND WHAT IS LEFT TO THE SPEC. The people, the workspace,
// the project and the choice work items are created through their services — and that
// is ALSO what raises every gate: a `type: choice` work item whose body reads complete
// asks its question on create (MOTIR-5891), so no gate is written here. The spec drives
// every DECISION through the UI.

export const CHOICE_GATE_PASSWORD = 'choice-gate-e2e-pass-4914';

export interface SeededChoice {
  id: string;
  identifier: string;
  title: string;
}

export interface ChoiceGateSeed {
  ownerEmail: string;
  viewerEmail: string;
  password: string;
  workspaceId: string;
  projectId: string;
  ownerId: string;
  /** A 2-option choice, picked from To approve. */
  two: SeededChoice;
  /** A 4-option choice, picked through the same port. */
  four: SeededChoice;
  /** A choice whose second option says nothing about what it is best for — no gate. */
  defect: SeededChoice;
  /** A choice sent back with *None of these*. */
  none: SeededChoice;
  /** A choice a member who may not decide opens — read-only. */
  watched: SeededChoice;
}

/** A canonical choice body, as the planner's `type-choice` pack teaches it. */
export function choiceBody(input: {
  question: string;
  situation: 'contradicts your decision' | 'better than your decision' | 'two workflows';
  youSaid?: string;
  evidence: string;
  options: Array<{ label: string; bestFor: string | null; why: string }>;
  gates: string;
}): string {
  return [
    '## Question',
    input.question,
    '',
    '## Why this is a choice',
    `**Situation:** ${input.situation}`,
    ...(input.youSaid ? [`**You said:** "${input.youSaid}"`] : []),
    input.evidence,
    '',
    '## Options',
    ...input.options.flatMap((option) => [
      '',
      `### ${option.label}`,
      ...(option.bestFor ? [`**Best if you want:** ${option.bestFor}`] : []),
      option.why,
    ]),
    '',
    '## What this choice gates',
    input.gates,
  ].join('\n');
}

export const TWO_BODY = choiceBody({
  question: 'Where do exported reports live once they are generated?',
  situation: 'better than your decision',
  youSaid: 'Store the exports in our own Postgres — no new vendor.',
  evidence:
    'Your choice works. Research found exports average 40 MB once PDFs are attached, so keeping them in Postgres grows every backup; managed object storage keeps them for less.',
  options: [
    {
      label: 'Managed object storage',
      bestFor: 'less to operate',
      why: 'The provider runs durability, lifecycle rules and signed download links.',
    },
    {
      label: 'Our own Postgres',
      bestFor: 'more cost-effective',
      why: 'No new bill and no new vendor, at the cost of a larger database to back up.',
    },
  ],
  gates:
    'The report exports story — the storage adapter, the retention rule and the download page.',
});

export const FOUR_BODY = choiceBody({
  question: 'How should a customer receive an export?',
  situation: 'two workflows',
  evidence:
    'The requirement names both a download from the app and a link sent to someone outside the workspace.',
  options: [
    { label: 'Download from the app', bestFor: 'faster to the goal', why: 'One button, no email.' },
    {
      label: 'Emailed link',
      bestFor: 'less to operate',
      why: 'Nothing for the customer to find; the link expires.',
    },
    {
      label: 'Shared folder',
      bestFor: 'more customisable later',
      why: 'The customer picks where exports land, and we can add rules later.',
    },
    {
      label: 'All three',
      bestFor: 'more cost-effective',
      why: 'One export pipeline, three doors.',
    },
  ],
  gates: 'The delivery story — the channel, its notification and its expiry rule.',
});

export async function seedChoiceGate(slug: string): Promise<ChoiceGateSeed> {
  const ownerEmail = `choice-owner-${slug}@example.com`;
  const viewerEmail = `choice-viewer-${slug}@example.com`;
  const owner = await createTestPerson({
    email: ownerEmail,
    password: CHOICE_GATE_PASSWORD,
    name: 'Yue Owner',
  });
  const viewer = await createTestPerson({
    email: viewerEmail,
    password: CHOICE_GATE_PASSWORD,
    name: 'Vic Viewer',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Choice gate E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Exports',
    identifier: 'CHOS',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  // A member who may browse and edit the project, and is neither the assignee, the
  // reporter nor an admin — so a choice routed to the owner is NOT theirs to decide.
  await workspacesService.addMember({ userId: viewer.id, workspaceId: workspace.id });
  const ctx = { userId: owner.id, workspaceId: workspace.id };
  await addToProjectAs({
    key: project.identifier,
    actorUserId: owner.id,
    ctx,
    targetUserId: viewer.id,
    role: 'member',
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: viewer.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  const choice = async (title: string, descriptionMd: string): Promise<SeededChoice> => {
    const item = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: 'task',
        title,
        type: 'choice',
        executor: 'human',
        assigneeId: owner.id,
        descriptionMd,
      },
      ctx,
    );
    return { id: item.id, identifier: item.identifier, title };
  };

  return {
    ownerEmail,
    viewerEmail,
    password: CHOICE_GATE_PASSWORD,
    workspaceId: workspace.id,
    projectId: project.id,
    ownerId: owner.id,
    two: await choice('Choose where exported reports live', TWO_BODY),
    four: await choice('Choose how a customer receives an export', FOUR_BODY),
    defect: await choice(
      'Choose the export file format',
      choiceBody({
        question: 'Which file format do exports use?',
        situation: 'two workflows',
        evidence: 'Finance reads spreadsheets; the archive wants something frozen.',
        options: [
          { label: 'CSV', bestFor: 'faster to the goal', why: 'Every tool opens it.' },
          { label: 'PDF', bestFor: null, why: 'A frozen copy of what was shown.' },
        ],
        gates: 'The export format story.',
      }),
    ),
    none: await choice(
      'Choose the export retention window',
      choiceBody({
        question: 'How long are exports kept?',
        situation: 'contradicts your decision',
        youSaid: 'Keep every export forever.',
        evidence: 'Research found the retention law caps personal data at seven years.',
        options: [
          { label: 'Seven years', bestFor: 'less to operate', why: 'The law’s own ceiling.' },
          {
            label: 'Anonymise after seven',
            bestFor: 'more customisable later',
            why: 'The data stays useful without the personal part.',
          },
        ],
        gates: 'The retention story.',
      }),
    ),
    watched: await choice('Choose the export naming scheme', TWO_BODY),
  };
}
