import type { Locale } from '@/lib/i18n/locales';
import type { Page } from '@playwright/test';
import { projectAutoTranslateSettingsService } from '@/lib/services/projectAutoTranslateSettingsService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from './db-reset';
import { createReader, type OrgSeed, type Person } from './translation-seed';

// THE AUTO-TRANSLATE-STORY seed (Story MOTIR-7738 · MOTIR-8836), for the receipt
// `regression-auto-translate-story.spec.ts` records. It builds on the on-demand
// story's helpers (`translation-seed.ts`: readers, organisations, sign-in, the
// token, the jobs mock's record and outcomes, the billing mock's figure) and adds
// only what differs: items whose fields record ENGLISH (the shipped seeder records
// Chinese), the six people, the project switch turned on through its own service,
// and a board card's rendered height.

export interface EnglishFields {
  title: string;
  description?: string;
  explanation?: string;
  todos?: readonly { text: string; notes: string }[];
}

/** A task whose every field — and its to-dos' text and notes — records `en`. */
export async function seedEnglishItem(org: OrgSeed, fields: EnglishFields) {
  const ctx = { userId: org.owner.id, workspaceId: org.workspaceId };
  const item = await workItemsService.createWorkItem(
    { projectId: org.projectId, kind: 'task', title: fields.title },
    ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      descriptionMd: fields.description ?? null,
      explanationMd: fields.explanation ?? null,
      titleLanguage: 'en',
      descriptionLanguage: fields.description ? 'en' : null,
      explanationLanguage: fields.explanation ? 'en' : null,
    },
  });
  const todoIds: string[] = [];
  for (const todo of fields.todos ?? []) {
    const added = await workItemTodosService.addTodo(
      item.id,
      { text: todo.text, notesMd: todo.notes, languages: { text: 'en', notes: 'en' } },
      ctx,
    );
    todoIds.push(added.todo.id);
  }
  return { id: item.id, key: item.identifier, todoIds, title: fields.title };
}

export type SeededItem = Awaited<ReturnType<typeof seedEnglishItem>>;

export interface People {
  olivia: Person;
  minji: Person;
  joon: Person;
  greta: Person;
  zara: Person;
  zeno: Person;
}

/** LANG's owner (English) and members (한국어 ×2, Deutsch); ZWEI's owner and member (한국어). */
export async function seedPeople(): Promise<People> {
  const slug = Date.now().toString(36);
  const person = (who: string, name: string, locale: Locale) =>
    createReader(`at-${who}-${slug}@example.com`, name, locale);
  return {
    olivia: await person('olivia', 'Olivia Owner', 'en'),
    minji: await person('minji', 'Minji Kim', 'ko'),
    joon: await person('joon', 'Joon Park', 'ko'),
    greta: await person('greta', 'Greta Leser', 'de'),
    zara: await person('zara', 'Zara Inhaberin', 'ko'),
    zeno: await person('zeno', 'Zeno Mitglied', 'ko'),
  };
}

/** Turn a project's switch on through the switch's own service, as its owner. */
export async function turnOnAutoTranslate(org: OrgSeed): Promise<void> {
  await projectAutoTranslateSettingsService.updateSettings(
    org.projectId,
    { autoTranslateWorkContent: true },
    { userId: org.owner.id, workspaceId: org.workspaceId },
  );
}

/** A board card's rendered height in CSS pixels. */
export async function cardHeight(page: Page, key: string): Promise<number> {
  const box = await page.getByRole('main').getByTestId(`board-card-${key}`).boundingBox();
  if (!box) throw new Error(`board card ${key} has no box`);
  return Math.round(box.height);
}

/** A language's name in `uiLocale`, as the page names it ("영어" for English in 한국어). */
export function languageName(code: string, uiLocale: string): string {
  return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(code) ?? code;
}

const LINK = 'https://example.com/export-guide';

/** The three languages' text for the story item, and for the edit the member makes. */
export function storyTexts(chipId: string, chipKey: string) {
  const chip = `[${chipKey}](motir:${chipId})`;
  const en = {
    lead: 'The export must include every field and be sorted by date.',
    added: 'It must also include the customer’s time zone.',
  };
  const ko = {
    lead: '내보내기에는 모든 필드가 포함되어야 하며 날짜순으로 정렬되어야 합니다.',
    added: '고객의 시간대도 포함해야 합니다.',
  };
  const de = { lead: 'Der Export muss alle Felder enthalten und nach Datum sortiert sein.' };
  return {
    link: LINK,
    en: {
      ...en,
      title: 'Build the export feature for all customers',
      description: `${en.lead} See [the export guide](${LINK}) and ${chip}.`,
      explanation: 'Customers need this report every week to reconcile their accounts.',
      todos: [
        { text: 'Check the existing export code', notes: 'Read the service layer first.' },
        { text: 'Write the new date sorting', notes: 'Sort by creation date, ascending.' },
      ],
    },
    ko: {
      ...ko,
      title: '모든 고객을 위한 내보내기 기능 만들기',
      description: `${ko.lead} [내보내기 안내](${LINK}) 및 ${chip}를 참고하세요.`,
      explanation: '고객은 계정을 대조하기 위해 매주 이 보고서가 필요합니다.',
      todos: [
        { text: '기존 내보내기 코드 확인', notes: '먼저 서비스 계층을 읽으세요.' },
        { text: '새 날짜 정렬 작성', notes: '생성일 기준 오름차순으로 정렬하세요.' },
      ],
      edited: `${ko.lead} ${ko.added} [내보내기 안내](${LINK}) 및 ${chip}를 참고하세요.`,
    },
    de: {
      title: 'Exportfunktion für alle Kunden bauen',
      description: `${de.lead} Siehe [Exportleitfaden](${LINK}) und ${chip}.`,
      explanation: 'Kunden brauchen diesen Bericht jede Woche, um ihre Konten abzugleichen.',
      todos: [
        { text: 'Den bestehenden Exportcode prüfen', notes: 'Zuerst die Serviceschicht lesen.' },
        { text: 'Die neue Datumssortierung schreiben', notes: 'Aufsteigend nach Datum sortieren.' },
      ],
      lead: de.lead,
    },
  };
}

export type StoryTexts = ReturnType<typeof storyTexts>;

/** The scripted translation of the story item's seven fields, in `lang`'s text. */
export function itemTranslations(
  item: Pick<SeededItem, 'todoIds'>,
  text: StoryTexts['ko'] | StoryTexts['de'],
) {
  const [one, two] = item.todoIds as [string, string];
  return [
    { fieldRef: 'title', text: text.title },
    { fieldRef: 'description', text: text.description },
    { fieldRef: 'explanation', text: text.explanation },
    { fieldRef: `todo:${one}:text`, text: text.todos[0]!.text },
    { fieldRef: `todo:${one}:notes`, text: text.todos[0]!.notes },
    { fieldRef: `todo:${two}:text`, text: text.todos[1]!.text },
    { fieldRef: `todo:${two}:notes`, text: text.todos[1]!.notes },
  ];
}

/** The three board titles in 한국어, keyed by the position the spec seeds them in. */
export const KO_TITLES = [
  '로그인 페이지 레이아웃 수정',
  '도움말 센터 스크린샷 업데이트',
  '고객 피드백 정리',
] as const;

export const EN_TITLES = [
  'Fix the login page layout',
  'Update the help centre screenshots',
  'Tidy the customer feedback',
] as const;
