import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { assembleDispatchPrompt, type DispatchPromptSource } from '@/lib/dispatch/promptTemplate';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { workItemsService } from '@/lib/services/workItemsService';
import { INIT_SUBJECT, isInitCard } from '@/lib/workItems/initCard';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-10162 · Subtask MOTIR-11054 — the PROMPT half of "an init card
// completes on its repository being created, not on a merged pull request".
// The pure grammar against `assembleDispatchPrompt`, and the service handing the
// stored subject through (`dispatchPromptService`, real Postgres).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const BODY = [
  'Create the `acme-infra` repository from the infra starter.',
  '',
  '## Acceptance criteria',
  '',
  '- `acme-infra` is established in the project set.',
].join('\n');

function source(over: Partial<DispatchPromptSource> = {}): DispatchPromptSource {
  return {
    key: 'PROD-9',
    title: 'Create the infra repository',
    kind: 'task',
    type: 'code',
    executor: 'coding_agent',
    difficulty: null,
    priority: 'high',
    storyPoints: 2,
    estimateMinutes: 30,
    descriptionMd: BODY,
    blockerKeys: [],
    openDependentKeys: ['PROD-10'],
    errorEvidence: [],
    parent: { key: 'PROD-2', title: 'Infra' },
    projectName: 'Motir',
    projectKey: 'PROD',
    targetRepo: null,
    sessionBranch: null,
    ...over,
  };
}

const init = (over: Partial<DispatchPromptSource> = {}) =>
  assembleDispatchPrompt(source({ subject: INIT_SUBJECT, ...over }));

describe('isInitCard — one rule over two facts', () => {
  it.each([
    [{ subject: 'init' }],
    [{ initRepositoryName: 'motir-infra' }],
    [{ subject: 'init', initRepositoryName: 'motir-infra' }],
  ])('%j is an init card', (shape) => {
    expect(isInitCard(shape)).toBe(true);
  });

  it.each([[{}], [{ subject: null }], [{ subject: 'data' }], [{ initRepositoryName: null }]])(
    '%j is not',
    (shape) => {
      expect(isInitCard(shape)).toBe(false);
    },
  );

  it('names the subject member once', () => {
    expect(INIT_SUBJECT).toBe('init');
  });
});

describe('an init card’s assembled prompt', () => {
  it('drops the GIT WORKFLOW and the ordinary protocol — and only for the init card', () => {
    const ordinary = assembleDispatchPrompt(source());
    const withNullSubject = assembleDispatchPrompt(source({ subject: null }));
    const initCard = init();

    // The same card WITHOUT the subject renders exactly as today, both ways of
    // being absent included.
    expect(withNullSubject.prompt).toBe(ordinary.prompt);
    expect(ordinary.prompt).toContain('\nGIT WORKFLOW');
    expect(ordinary.prompt).toContain('transition_status tool');
    expect(ordinary.prompt).toContain('REPORTING YOUR STEPS');

    expect(initCard.prompt).not.toContain('\nGIT WORKFLOW');
    expect(initCard.prompt).not.toContain('REPORTING YOUR STEPS');
    expect(initCard.prompt).not.toContain('move PROD-9 to Implemented');
    expect(initCard.prompt).not.toContain('status implemented');
  });

  it('opens WHAT TO DO with the init steps', () => {
    const { prompt } = init();
    const whatToDo = prompt.slice(prompt.indexOf('WHAT TO DO\n'));
    const body = whatToDo.slice(whatToDo.indexOf('═\n') + 2).trimStart();
    expect(body.startsWith('THIS IS AN INIT CARD')).toBe(true);
    expect(body).toContain('Work at the workspace root');
    expect(body).toContain('nothing to check out and no branch to cut');
    expect(body).toContain('The repository this card creates is named on the card');
    expect(body).toContain("create it are the card's own description");
  });

  it('states FINISHED as the repository established and forbids transition_status by name, keeping both failure branches', () => {
    const { prompt } = init();
    expect(prompt).toContain(
      "FINISHED — the declared repository appears in the project's repository list in",
    );
    expect(prompt).toContain('an established state (created or connected)');
    expect(prompt).toContain('Do NOT move PROD-9 with transition_status');
    expect(prompt).toContain('BUILD THROUGH — the WHAT holds');
    expect(prompt).toContain('STOP — the WHAT itself breaks');
    expect(prompt).toContain('never improvise a pull request in its place');
    expect(prompt).toContain('FOUND A DEFECT');
    expect(prompt).toContain('before you create the repository');
  });

  it('assembles with every branch null', () => {
    const assembled = init({ sessionBranch: 'session/PROD-1-run' });
    expect(assembled.branch).toBeNull();
    expect(assembled.workBranch).toBeNull();
    expect(assembled.sessionBranch).toBeNull();
    expect(assembled.workflowMode).toBe('per_item_pr');
  });

  it.each([
    ['type: manual', { type: 'manual' as const, executor: 'human' as const }],
    ['executor: human on a code card', { type: 'code' as const, executor: 'human' as const }],
  ])('a MANUAL init card (%s) keeps the manual closing unchanged', (_label, over) => {
    const manualInit = init(over);
    const manualPlain = assembleDispatchPrompt(source(over));
    expect(manualInit.prompt).toBe(manualPlain.prompt);
    expect(manualInit.prompt).toContain('There is no git workflow for this work item');
    expect(manualInit.prompt).not.toContain('THIS IS AN INIT CARD');
    expect(manualInit.prompt).not.toContain('FINISHED — the declared repository');
  });
});

describe('dispatchPromptService passes the stored subject through', () => {
  it('a card whose stored subject is init is handed the init prompt', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Create the infra repository',
        descriptionMd: BODY,
        type: 'code',
        executor: 'coding_agent',
      },
      fx.ctx,
    );
    const plain = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(plain.prompt).toContain('\nGIT WORKFLOW');

    await adminDb.workItem.update({ where: { id: item.id }, data: { subject: INIT_SUBJECT } });
    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(dto.prompt).toContain('THIS IS AN INIT CARD');
    expect(dto.prompt).not.toContain('\nGIT WORKFLOW');
    expect(dto.branch).toBeNull();
    expect(dto.workBranch).toBeNull();
  });
});
