import { readFileSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { Locale } from '@/lib/i18n/locales';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { AiJobsFixture, SubmittedJob, TranslateJobOutcome } from '@/lib/test-ai-jobs-mock';
import { succeededTranslateJobCount } from '@/lib/test-ai-jobs-mock';
import type { BillingFixture, BillingFixtureTranslation } from '@/lib/test-billing-mock';
import { TRANSLATION_CREDITS_PER_JOB } from '@/lib/test-billing-mock';
import { adminDb } from './db-reset';
import { createTestPerson } from './testPerson';

// THE TRANSLATION-STORY seed (Story MOTIR-7735 · MOTIR-8125), for the receipt
// `regression-translation-story.spec.ts` records.
//
// Two organisations. The first holds three Chinese work items and four people:
// its owner reading in Deutsch (A), a second Deutsch reader (B), a 中文 reader
// (C). The second, whose credit is gone, holds one Chinese item, its Deutsch
// owner (D) and a Deutsch member (E). Plus the two motir-ai boundary mocks'
// fixture files, read and written the way the lane's webServer reads them.

export const PASSWORD = 'translation-story-e2e-9';
export { TRANSLATION_CREDITS_PER_JOB };

/** The story item's text, in Chinese as written and in German as translated. */
export function storyText(chipId: string, chipKey: string) {
  const link = 'https://example.com/export-guide';
  const chip = `[${chipKey}](motir:${chipId})`;
  const zh = {
    lead: '导出需要包含所有字段，并且按日期排序。',
    editedLead: '导出还必须包含客户的时区。',
  };
  const de = {
    lead: 'Der Export muss alle Felder enthalten und nach Datum sortiert sein.',
    editedLead: 'Der Export muss außerdem die Zeitzone des Kunden enthalten.',
  };
  return {
    link,
    zh: {
      ...zh,
      title: '为所有客户构建导出功能',
      description: `${zh.lead}参见[导出指南](${link})和 ${chip}。`,
      explanation: '客户每周都需要这份报告来核对账目。',
      todos: [
        { text: '检查现有的导出代码', notes: '先阅读服务层的实现。' },
        { text: '编写新的日期排序', notes: '按创建日期升序排列。' },
      ],
      edited: `${zh.editedLead}参见 ${chip}。`,
    },
    de: {
      ...de,
      title: 'Exportfunktion für alle Kunden bauen',
      description: `${de.lead} Siehe [Exportleitfaden](${link}) und ${chip}.`,
      explanation: 'Kunden brauchen diesen Bericht jede Woche, um ihre Konten abzugleichen.',
      todos: [
        { text: 'Den bestehenden Exportcode prüfen', notes: 'Zuerst die Serviceschicht lesen.' },
        { text: 'Die neue Datumssortierung schreiben', notes: 'Aufsteigend nach Datum sortieren.' },
      ],
      edited: `${de.editedLead} Siehe ${chip}.`,
    },
  };
}

export type StoryText = ReturnType<typeof storyText>;

export interface Person {
  id: string;
  email: string;
}

/** A person whose saved account language — the interface language — is `locale`. */
export async function createReader(email: string, name: string, locale: Locale): Promise<Person> {
  const person = await createTestPerson({ email, password: PASSWORD, name });
  await adminDb.user.update({ where: { id: person.id }, data: { locale } });
  return { id: person.id, email };
}

export interface OrgSeed {
  orgId: string;
  workspaceId: string;
  projectId: string;
  owner: Person;
}

/** An organisation, its workspace and project, owned by `owner`; `members` joined. */
export async function seedOrg(owner: Person, identifier: string, members: Person[]) {
  const { workspace } = await workspacesService.createWorkspace({
    name: `Translation ${identifier}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: `Export ${identifier}`,
    identifier,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  for (const person of [owner, ...members]) {
    if (person !== owner) {
      await workspacesService.addMember({ userId: person.id, workspaceId: workspace.id });
    }
    await adminDb.workspaceMembership.updateMany({
      where: { userId: person.id, workspaceId: workspace.id },
      data: { activeProjectId: project.id },
    });
  }
  const seed: OrgSeed = {
    orgId: workspace.organizationId,
    workspaceId: workspace.id,
    projectId: project.id,
    owner,
  };
  return seed;
}

export interface ChineseFields {
  title: string;
  description: string;
  explanation?: string;
  todos?: readonly { text: string; notes: string }[];
}

/** A task whose fields — and its to-dos' text and notes — all record `zh`. */
export async function seedChineseItem(org: OrgSeed, fields: ChineseFields) {
  const ctx = { userId: org.owner.id, workspaceId: org.workspaceId };
  const item = await workItemsService.createWorkItem(
    { projectId: org.projectId, kind: 'task', title: fields.title },
    ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      descriptionMd: fields.description,
      explanationMd: fields.explanation ?? null,
      titleLanguage: 'zh',
      descriptionLanguage: 'zh',
      explanationLanguage: fields.explanation ? 'zh' : null,
    },
  });
  const todoIds: string[] = [];
  for (const todo of fields.todos ?? []) {
    const added = await workItemTodosService.addTodo(
      item.id,
      { text: todo.text, notesMd: todo.notes, languages: { text: 'zh', notes: 'zh' } },
      ctx,
    );
    todoIds.push(added.todo.id);
  }
  return { id: item.id, key: item.identifier, todoIds };
}

/** An MCP token for `person` in `org`, as an agent or the CLI holds one. */
export async function mintToken(org: OrgSeed, person: Person, label: string): Promise<string> {
  const minted = await apiTokensService.create(person.id, org.workspaceId, {
    label,
    // No explicit list: the default for this project — everything the person
    // can confer there (an explicit CLI grant names keys a member cannot).
    projectId: org.projectId,
  });
  return minted.token;
}

/** Sign `person` in on this page's browser context, through the real auth route. */
export async function signInAs(page: Page, baseURL: string, person: Person): Promise<void> {
  await page.context().clearCookies();
  const res = await page.request.post('/api/auth/sign-in/email', {
    data: { email: person.email, password: PASSWORD },
    headers: { origin: new URL(baseURL).origin },
  });
  if (res.status() !== 200) {
    throw new Error(`sign-in for ${person.email}: ${res.status()} ${await res.text()}`);
  }
}

// ── The jobs mock's fixture (lib/test-ai-jobs-mock.ts) ───────────────────────

function jobsPath(): string {
  const p = process.env['MOTIR_AI_JOBS_FIXTURE_PATH'];
  if (!p) throw new Error('MOTIR_AI_JOBS_FIXTURE_PATH not set — run under the acceptance lane');
  return p;
}

function readJobs(): AiJobsFixture {
  try {
    return JSON.parse(readFileSync(jobsPath(), 'utf8')) as AiJobsFixture;
  } catch {
    return {};
  }
}

/** Start from an empty job record. */
export function resetJobs(): void {
  writeFileSync(jobsPath(), JSON.stringify({ submitted: [] }));
}

/** Every `translate` submit the mock recorded, refused ones included, in order. */
export function translateSubmits(): SubmittedJob[] {
  return (readJobs().submitted ?? []).filter((s) => s.kind === 'translate');
}

/**
 * Declare the outcome of the `ordinal`-th `translate` submit, KEEPING the record
 * and every earlier outcome as it stood (the queue's last entry repeats, so the
 * gap up to `ordinal` is filled with what those submits were already given). The
 * mock re-reads this file on every request, so switching a `running` job to
 * `succeeded` settles it on the door's next poll.
 */
export function setTranslateOutcome(ordinal: number, outcome: TranslateJobOutcome): void {
  const fixture = readJobs();
  const queue = [...(fixture.translate ?? [])];
  const filler = queue.length > 0 ? queue[queue.length - 1]! : {};
  while (queue.length < ordinal) queue.push(filler);
  queue[ordinal] = outcome;
  writeFileSync(jobsPath(), JSON.stringify({ ...fixture, translate: queue }));
}

/** The outcome for the NEXT `translate` submit (and every one after it, until changed). */
export function setNextTranslateOutcome(outcome: TranslateJobOutcome): number {
  const ordinal = translateSubmits().length;
  setTranslateOutcome(ordinal, outcome);
  return ordinal;
}

// ── The billing mock's figure (lib/test-billing-mock.ts) ─────────────────────

/**
 * The `translation` block the billing mock reports for `orgId`: the entry's own
 * when it scripts one, else the figure it derives from the jobs mock's succeeded
 * `translate` jobs (lane-global, not org-keyed — the seam's stated boundary).
 */
export function reportedTranslation(orgId: string): BillingFixtureTranslation | null {
  const path = process.env['MOTIR_AI_BILLING_FIXTURE_PATH'];
  if (!path) throw new Error('MOTIR_AI_BILLING_FIXTURE_PATH not set — run under the lane');
  const entry = (JSON.parse(readFileSync(path, 'utf8')) as BillingFixture)[orgId];
  if (entry && 'translation' in entry) return entry.translation ?? null;
  const spend = succeededTranslateJobCount() * TRANSLATION_CREDITS_PER_JOB;
  return { totalSpend: spend, monthSpend: spend };
}
