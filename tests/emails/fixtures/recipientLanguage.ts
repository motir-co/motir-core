import type { RenderedEmail } from '@/lib/emailTemplates/types';
import type { Locale } from '@/lib/i18n/locales';
import type { EmailTemplate } from '@/lib/services/emailService';
import {
  EMAIL_TEMPLATE_FIXTURES,
  EMAIL_TEMPLATE_RENDERERS,
  type TemplateData,
} from '../../helpers/emailTemplateFixtures';

// Story MOTIR-7732 · MOTIR-8111 — the shared fixtures for the story's
// recipient-language tests.
//
// RENDER PROPS: one set per template, built on the shared per-template fixture
// and overridden with QUOTED work content — a German comment excerpt, a work
// item title, a status label, an error detail. Quoted content is the person's
// own words and must reach every language byte-identical. The type is a
// `Record` over every `EmailTemplate`, so a new `TransactionalEmail` arm does
// not compile until it has a fixture here (through the shared helper too).

/** Quoted content, as typed by people: never translated, never altered. */
export const QUOTED = {
  excerpt: 'Bitte prüfe die Übersetzung – danke!',
  workItemTitle: 'Login-Seite überarbeiten',
  statusName: 'Erledigt',
  errorDetail: 'Feld „Bearbeiter“ nicht gefunden',
  ruleName: 'Automatisch zuweisen',
  projectName: 'Rakete',
  organizationName: 'Acme GmbH',
  filterName: 'Meine Fehler',
  agentName: 'builder-01',
} as const;

const QUOTED_PROPS: { [K in EmailTemplate]?: Partial<TemplateData<K>> } = {
  'mention-notification': { excerpt: QUOTED.excerpt, workItemTitle: QUOTED.workItemTitle },
  'watcher-comment-notification': {
    excerpt: QUOTED.excerpt,
    workItemTitle: QUOTED.workItemTitle,
  },
  'page-comment-notification': {
    excerpt: QUOTED.excerpt,
    pageTitle: QUOTED.workItemTitle,
  },
  'watcher-transition-notification': {
    workItemTitle: QUOTED.workItemTitle,
    statusName: QUOTED.statusName,
  },
  'automation-rule-failed': { ruleName: QUOTED.ruleName, errorDetail: QUOTED.errorDetail },
  'filter-subscription': {
    filterName: QUOTED.filterName,
    items: [{ identifier: 'PROD-42', title: QUOTED.workItemTitle, status: QUOTED.statusName }],
  },
  'follow-confirm': { projectName: QUOTED.projectName },
  'follow-digest': {
    projectName: QUOTED.projectName,
    entries: [
      {
        identifier: 'ROC-1',
        title: QUOTED.workItemTitle,
        url: 'https://app.example.test/p/r/ROC-1',
      },
    ],
  },
  'ownership-transferred': { organizationName: QUOTED.organizationName },
  'organization-deletion-scheduled': { organizationName: QUOTED.organizationName },
  'organization-deletion-cancelled': { organizationName: QUOTED.organizationName },
  'organization-deletion-reminder': { organizationName: QUOTED.organizationName },
  'organization-erased': { organizationName: QUOTED.organizationName },
  'agents-deletion-scheduled': {
    organizationName: QUOTED.organizationName,
    agentNames: [QUOTED.agentName],
  },
};

/** The quoted values a given template's render must carry unchanged. */
export function quotedIn(template: EmailTemplate): string[] {
  const props = QUOTED_PROPS[template] ?? {};
  const values = new Set<string>();
  const collect = (v: unknown) => {
    if (typeof v === 'string' && (Object.values(QUOTED) as string[]).includes(v)) values.add(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(props);
  return [...values];
}

/** Render one template from its quoted-content fixture, in `locale`. */
export function renderWithQuotes(
  template: EmailTemplate,
  locale: Locale,
  extra: Record<string, unknown> = {},
): Promise<RenderedEmail> {
  // The two records are keyed alike, so the pairing is sound; TypeScript cannot
  // correlate a generic key across them, hence the widening.
  const render = EMAIL_TEMPLATE_RENDERERS[template] as (p: object) => Promise<RenderedEmail>;
  return render({
    ...EMAIL_TEMPLATE_FIXTURES[template],
    ...(QUOTED_PROPS[template] ?? {}),
    ...extra,
    locale,
  });
}

/** The saved languages Part A gives its recipients — never English, and never
 *  the language of the person or request that triggers the email. */
export const RECIPIENT_LANGUAGES = ['ko', 'fr', 'ja', 'nl', 'pl'] as const;
/** The simulated request language: never a recipient's. */
export const REQUEST_LANGUAGE = 'es';
/** The triggering person's saved language: never a recipient's. */
export const ACTOR_LANGUAGE = 'de';
/** A stored value that is not one of the eleven. */
export const UNRECOGNISED_LANGUAGE = 'xx-unknown';
