// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { AiPlanningSettingsEditor } from '@/app/(authed)/settings/project/ai-planning/_components/AiPlanningSettingsEditor';
import type { ProjectAiSettingsDto } from '@/lib/dto/projectAiSettings';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';

// THE DATA-PRACTICE PROMISE (Story MOTIR-3665 · Subtask MOTIR-3670) — the two
// sentences and the link at the foot of the Planner card, per
// `design/ai-settings/design-notes.md` §D2–D5.
//
// ⚠️ THE ASSERTION THIS FILE EXISTS FOR IS THE ABSENCE, and it is the one the
// design asks for by name: **no provider fact may appear in this component.** No
// retention window, no training answer, no provider names. Those live in the
// gateway (`motir/datapolicy`) and on the published provider page, and a third
// copy in a React component is how that data has already gone stale four times.
// A comment saying so is not a check; this is.
//
// The rest is the two arms the copy has — a configured manifest (the link
// renders) and an unconfigured one (`null`, the common case for the open
// product, where the COMMITMENT still stands and only the pointer is missing).

function dto(over: Partial<ProjectAiSettingsDto> = {}): ProjectAiSettingsDto {
  return {
    aiAutoPlanEnabled: false,
    aiAutoPlanThreshold: 5,
    aiSprintPlanningEnabled: false,
    aiSprintLengthDays: 2,
    aiGenerateExplanations: false,
    aiRecordPlanningMistakes: true,
    aiFinalCheck: true,
    ...over,
  };
}

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

function mount(props: { providerTableUrl?: string | null; isAdmin?: boolean } = {}) {
  return render(
    <AiPlanningSettingsEditor
      projectKey="PROD"
      projectName="motir"
      settings={dto()}
      isAdmin={props.isAdmin ?? true}
      aiConfigured
      canViewLessons={false}
      pause={null}
      providerTableUrl={
        props.providerTableUrl === undefined
          ? 'https://motir.co/legal/model-providers'
          : props.providerTableUrl
      }
    />,
  );
}

const copy = enMessages.settings.aiPlanning.planner;
const link = () => screen.queryByTestId('ai-planning-provider-table-link');

afterEach(() => cleanup());

describe('the promise renders where the model is chosen', () => {
  it('states the commitment and the report, as two sentences', () => {
    mount();
    expect(screen.getByText(copy.dataPracticeCommitment, { exact: false })).toBeTruthy();
    expect(screen.getByText(copy.dataPracticeReport, { exact: false })).toBeTruthy();
  });

  it('links out to the configured provider table, at its ABSOLUTE url', () => {
    mount({ providerTableUrl: 'https://motir.co/legal/model-providers' });
    const a = link() as HTMLAnchorElement;
    expect(a).toBeTruthy();
    // ⚠️ ABSOLUTE, not `/legal/model-providers`. MOTIR-4103 moved
    // `app/(public)/legal/` out of this repository, so a same-origin path would
    // resolve against this app and survive only on MOTIR-3884's 301.
    expect(a.getAttribute('href')).toBe('https://motir.co/legal/model-providers');
  });

  it('names its destination out of context, rather than "learn more"', () => {
    mount();
    // A screen-reader link list shows the text alone; "learn more" in that list
    // is a link to nowhere the reader can identify.
    expect((link() as HTMLAnchorElement).textContent).toContain(copy.dataPracticeLink);
  });

  it('renders for a non-admin too — it is copy, not a control', () => {
    mount({ isAdmin: false });
    expect(screen.getByText(copy.dataPracticeCommitment, { exact: false })).toBeTruthy();
    expect(link()).toBeTruthy();
  });
});

describe('the unconfigured build — the commitment stands, the pointer does not', () => {
  it('renders NO link when the legal manifest is not configured', () => {
    mount({ providerTableUrl: null });
    expect(link()).toBeNull();
  });

  it('still states the commitment, which is true whether or not a page is published', () => {
    mount({ providerTableUrl: null });
    // ⚠️ This is the half that distinguishes it from `signUpLegalLinks`'
    // both-or-neither rule. That paragraph would otherwise assert agreement to a
    // document nobody published; here only the POINTER is missing, and what
    // Motir does with the content is true on a self-hosted build regardless.
    expect(screen.getByText(copy.dataPracticeCommitment, { exact: false })).toBeTruthy();
  });
});

describe('⚠️ no provider fact appears in the component', () => {
  // ⚠️ SCOPED TO THE CALLOUT, and the scope is the finding. A first draft of this
  // test scanned the whole card for the phrase "trains on" — which is exactly
  // what the COMMITMENT sentence says about Motir, so it forbade the copy the
  // design requires. The rule is not "this vocabulary is banned"; it is "this
  // component does not state what a PROVIDER does". Those are different checks,
  // and only the second one is true.
  //
  // Scoping also settles the picker: `deepseek-v4-pro` is a model id an operator
  // pins, not a data-practice fact, and it legitimately renders two rows up.
  const promise = () => screen.getByTestId('ai-planning-data-practice').textContent ?? '';

  const vendors = [
    'openai',
    'anthropic',
    'deepseek',
    'moonshot',
    'kimi',
    'zhipu',
    'glm',
    'qwen',
    'alibaba',
    'claude',
    'brave',
  ];

  it('names no provider, in either arm', () => {
    for (const providerTableUrl of ['https://motir.co/legal/model-providers', null]) {
      cleanup();
      mount({ providerTableUrl });
      const text = promise().toLowerCase();
      for (const vendor of vendors) {
        expect(
          text.includes(vendor),
          `The promise names the provider "${vendor}". It states MOTIR's position and ` +
            `points at the page carrying each provider's own answer — naming one here ` +
            `creates a copy that goes stale the next time the roster moves, which has ` +
            `already happened four times.`,
        ).toBe(false);
      }
    }
  });

  it('states no retention window', () => {
    mount();
    // Any duration at all: "30 days", "90 days", "24 hours". A window is the
    // per-provider fact most likely to be helpfully added here and most likely to
    // rot, because it is the one a reader asks for first.
    expect(
      /\d+\s*(day|hour|week|month)/i.test(promise()),
      'The promise states a retention window. Retention is a per-provider fact and ' +
        'belongs on the published page, not in this component.',
    ).toBe(false);
  });

  it("does not borrow the provider page's own cell vocabulary", () => {
    mount();
    const text = promise().toLowerCase();
    // These are the words the published table uses for a per-provider VERDICT.
    // Their appearance here would mean the component had started answering the
    // question it is supposed to hand over.
    for (const cell of ['not confirmed', 'not stated', 'zero data retention', 'zero-retention']) {
      expect(text.includes(cell), `The promise borrows the table's "${cell}" verdict.`).toBe(false);
    }
  });

  it('names no provider in the promise copy itself, in either language', () => {
    // Asserted on the CATALOG rather than the render, so a translator adding
    // "(e.g. OpenAI)" is caught by this test rather than by a reader.
    for (const [lang, messages] of [
      ['en', enMessages],
      ['zh', zhMessages],
    ] as const) {
      const planner = messages.settings.aiPlanning.planner as Record<string, string>;
      for (const key of ['dataPracticeCommitment', 'dataPracticeReport', 'dataPracticeLink']) {
        const value = (planner[key] ?? '').toLowerCase();
        expect(
          value.length,
          `${lang}.${key} is missing — zh parity is a release gate`,
        ).toBeGreaterThan(0);
        for (const vendor of vendors) {
          expect(value.includes(vendor), `${lang}.${key} names the provider "${vendor}".`).toBe(
            false,
          );
        }
      }
    }
  });
});
