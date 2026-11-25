import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { locales } from '@/lib/i18n/locales';

// Story MOTIR-8919 · the story gate, case 11. Every locale carries every key the
// story added or changed in `messages/en.json`, translated and recorded.
//
// The key set is COMPUTED, not listed: the leaves of `messages/en.json` whose
// text differs from the same leaf at the story's merge base with `origin/main`.
// This is stricter than `i18n-catalog.test.ts` parity on purpose — two feature
// cards seeded en text into the other catalogues as placeholders, which parity
// accepts and this does not: a translation byte-identical to en fails here
// (unless the locale's glossary keeps that very text verbatim), and so does a
// source record that is not the current en.

const ROOT = join(__dirname, '../..');
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as Json;
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function leaves(node: Json, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (typeof node === 'string') out[prefix] = node;
  else if (Array.isArray(node)) node.forEach((v, i) => leaves(v, `${prefix}.${i}`, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * Words that are the SAME word in a language, so an identical value is a
 * translation, not a leftover placeholder. Reviewed by hand; each carries its why.
 */
// The platform job ledger (MOTIR-9987) adds a "Status" label the Germanic and
// Polish catalogues spell as English does, and Portuguese keeps "Jobs" (the
// tenant ledger's own word) — the same words, not untranslated ones.
const JOBS_STATUS = ['platformAdmin.jobs.status.label', 'platformAdmin.jobs.columns.status'];

// The Custom domains pane (MOTIR-9529) labels a DNS record's columns and its
// field the way those languages spell them too: German « Domain », « Name »;
// French and Dutch « Type ».
const DNS_TYPE = 'settings.customDomains.records.type';
// The planner-findings console (Story MOTIR-10353 · MOTIR-10521) names two
// things that are proper names in every language — the `check plan` skill and
// the `plan.py` planner — shows a work-item key as its placeholder, and labels a
// bug with its key ("Bug {key}", the glossary's own `bug` term in the Latin-script
// catalogues). Each locale's list below adds the words that language spells as
// English does (« Source », « Plan », « Code », « Corpus », « Model », « Type »…).
const FINDINGS_NAMES = [
  'platformAdmin.plannerFindings.source.check_plan',
  'platformAdmin.plannerFindings.planner.plan_py',
  'platformAdmin.plannerFindings.detail.cellPlanpy',
  'platformAdmin.plannerFindings.bug.placeholder',
];
const FINDINGS_BUG_KEY = 'platformAdmin.plannerFindings.status.bugWithKey';
// The idle policy names an AWS app's shape (MOTIR-12107); « container » is the
// word Italian and Dutch use as well.
const IDLE_SHAPE_CONTAINER = 'settings.production.idle.shape.container';
// The Production panel's live app operations (MOTIR-12109) use words several
// languages spell as English does: « 15 min » (the minute's abbreviation), « app »
// (French, Spanish, Italian, Dutch and Portuguese), « Logs » (German, Dutch and
// Portuguese), « platform » (Dutch) and « Release {commit} » (German and Dutch,
// the word their catalogues already use for a release).
const LIVE_OPS = 'settings.production.logs.';
const LIVE_OPS_RANGE = `${LIVE_OPS}range.15m`;
const LIVE_OPS_APP = `${LIVE_OPS}stream.app`;
const LIVE_OPS_LOGS = `${LIVE_OPS}heading`;
const LIVE_OPS_RELEASE = 'settings.production.events.release';
// The Usage section's amounts (MOTIR-12110) are a number and a unit symbol —
// « h », « GB-s », « vCPU-h », « GB-h », « CU-h », « ACU-h » — written alike in
// every language; « Credits » is the German and Dutch word as well.
const USAGE_AMOUNTS = ['hours', 'gbSeconds', 'vcpuHours', 'gbHours', 'cuHours', 'acuHours'].map(
  (k) => `settings.production.usage.amount.${k}`,
);
const USAGE_CREDITS = 'settings.production.usage.col.credits';
// The Planning cadence's « Story » option (MOTIR-12206): the glossary keeps the
// work-item kind as « Story » in de, fr and nl, so the option label is the same word.
const CADENCE_STORY = 'settings.aiPlanning.planner.cadence.story.label';

const SAME_WORD: Record<string, string[]> = {
  zh: [...USAGE_AMOUNTS, ...FINDINGS_NAMES],
  ko: [...USAGE_AMOUNTS, ...FINDINGS_NAMES],
  ja: [...USAGE_AMOUNTS, ...FINDINGS_NAMES],
  it: [
    ...USAGE_AMOUNTS,
    LIVE_OPS_RANGE,
    LIVE_OPS_APP,
    ...FINDINGS_NAMES,
    FINDINGS_BUG_KEY,
    'platformAdmin.plannerFindings.attribution.corpus',
    // The idle policy's shape (MOTIR-12107): Italian says « container » too.
    IDLE_SHAPE_CONTAINER,
  ],
  fr: [
    CADENCE_STORY,
    ...USAGE_AMOUNTS,
    LIVE_OPS_RANGE,
    LIVE_OPS_APP,
    'reports.workload.tableTotal', // « Total »
    'platformAdmin.jobs.pageLabel', // « Page {page} »
    DNS_TYPE,
    'settings.customDomains.dialog.appLabel', // « Application »
    ...FINDINGS_NAMES,
    FINDINGS_BUG_KEY,
    'platformAdmin.plannerFindings.filter.source',
    'platformAdmin.plannerFindings.filter.attribution',
    'platformAdmin.plannerFindings.attribution.code',
    'platformAdmin.plannerFindings.attribution.corpus',
    'platformAdmin.plannerFindings.col.plans',
    'platformAdmin.plannerFindings.col.source',
    'platformAdmin.plannerFindings.col.plan',
    'platformAdmin.plannerFindings.col.attribution',
    'platformAdmin.plannerFindings.col.date',
    'platformAdmin.plannerFindings.row.plans',
    'platformAdmin.plannerFindings.pager.page',
    'platformAdmin.plannerFindings.detail.correction',
    'platformAdmin.plannerFindings.detail.provenance',
    'platformAdmin.plannerFindings.detail.source',
    'platformAdmin.plannerFindings.detail.attribution',
    'platformAdmin.plannerFindings.detail.plan',
    'platformAdmin.plannerFindings.cost.sessions',
    'platformAdmin.plannerFindings.attr.label',
    'platformAdmin.plannerFindings.promote.fieldType',
  ],
  es: [
    ...USAGE_AMOUNTS,
    LIVE_OPS_RANGE,
    LIVE_OPS_APP,
    'reports.workload.tableTotal', // « Total »
    'reports.cvr.seriesLabel', // « Series »
    ...FINDINGS_NAMES,
    FINDINGS_BUG_KEY,
    'platformAdmin.plannerFindings.attribution.corpus',
    'platformAdmin.plannerFindings.col.plan',
    'platformAdmin.plannerFindings.detail.plan',
    // Usage & cost · Failed usage (MOTIR-11794): « Error » is the Spanish word.
    'platformAdmin.usage.failed.col.error',
    'platformAdmin.usage.failed.confirm.error',
  ],
  pt: [
    ...USAGE_AMOUNTS,
    LIVE_OPS_LOGS,
    LIVE_OPS_RANGE,
    LIVE_OPS_APP,
    'reports.workload.tableTotal', // « Total »
    'platformAdmin.shell.navJobs',
    'platformAdmin.jobs.title',
    ...JOBS_STATUS,
    ...FINDINGS_NAMES,
    FINDINGS_BUG_KEY,
    'platformAdmin.plannerFindings.attribution.corpus',
  ],
  de: [
    CADENCE_STORY,
    ...USAGE_AMOUNTS,
    USAGE_CREDITS,
    LIVE_OPS_RELEASE,
    LIVE_OPS_LOGS,
    ...JOBS_STATUS,
    'settings.customDomains.dialog.label',
    'settings.customDomains.records.name',
    ...FINDINGS_NAMES,
    FINDINGS_BUG_KEY,
    'platformAdmin.plannerFindings.attribution.code',
    'platformAdmin.plannerFindings.col.plan',
    'platformAdmin.plannerFindings.detail.plan',
    'platformAdmin.plannerFindings.triage.title',
  ],
  nl: [
    CADENCE_STORY,
    ...USAGE_AMOUNTS,
    USAGE_CREDITS,
    LIVE_OPS_RELEASE,
    LIVE_OPS_LOGS,
    LIVE_OPS_RANGE,
    LIVE_OPS_APP,
    `${LIVE_OPS}stream.platform`,
    ...JOBS_STATUS,
    IDLE_SHAPE_CONTAINER, // « container »
    DNS_TYPE,
    ...FINDINGS_NAMES,
    FINDINGS_BUG_KEY,
    'platformAdmin.plannerFindings.filter.planner',
    'platformAdmin.plannerFindings.filter.count',
    'platformAdmin.plannerFindings.filter.sheetButton',
    'platformAdmin.plannerFindings.attribution.code',
    'platformAdmin.plannerFindings.attribution.corpus',
    'platformAdmin.plannerFindings.attribution.model',
    'platformAdmin.plannerFindings.col.planner',
    'platformAdmin.plannerFindings.col.plan',
    'platformAdmin.plannerFindings.detail.planner',
    'platformAdmin.plannerFindings.detail.plan',
    'platformAdmin.plannerFindings.cost.review',
    'platformAdmin.plannerFindings.promote.fieldType',
  ],
  pl: [
    ...USAGE_AMOUNTS,
    LIVE_OPS_RANGE,
    ...JOBS_STATUS,
    ...FINDINGS_NAMES,
    FINDINGS_BUG_KEY,
    'platformAdmin.plannerFindings.attribution.model',
    'platformAdmin.plannerFindings.col.plan',
    'platformAdmin.plannerFindings.detail.plan',
  ],
};

/** A value with no words of its own: only placeholders and punctuation. */
const isWordless = (v: string) =>
  v.replace(/\{[^}]*\}/g, '').replace(/[\p{P}\p{S}\s]/gu, '') === '';

const base = git('merge-base', 'HEAD', 'origin/main')?.trim() ?? null;
const baseEn = base ? git('show', `${base}:messages/en.json`) : null;

/** Skipped, with the reason on the test's name, only when git cannot supply the base. */
const maybe = baseEn ? describe : describe.skip;

maybe(
  `story gate C11 — every locale carries every new key${baseEn ? '' : ' (SKIPPED: no merge base with origin/main available)'}`,
  () => {
    const en = leaves(read('messages/en.json'));
    const before = baseEn ? leaves(JSON.parse(baseEn) as Json) : {};
    const keys = Object.keys(en).filter((k) => before[k] !== en[k]);
    const targets = locales.filter((l) => l !== 'en');

    it('the computed set covers the surfaces the story touched', () => {
      expect(keys.length).toBeGreaterThanOrEqual(56);
      for (const prefix of [
        'reports.help.',
        'reports.workload.',
        'reports.cvr.',
        'reports.velocity.',
        'backlog.sprintReport.',
      ]) {
        expect(
          keys.some((k) => k.startsWith(prefix)),
          prefix,
        ).toBe(true);
      }
    });

    it.each(targets)(
      '%s: every new key is present, translated, and recorded against today’s en',
      (locale) => {
        const tr = leaves(read(`messages/${locale}.json`));
        const rec = read(`messages/sources/${locale}.json`) as Record<string, string>;
        const glossary = read(`messages/glossary/${locale}.json`) as {
          terms?: Record<string, { translation: string; doNotTranslate?: boolean }>;
        };
        // Text the glossary keeps verbatim (a product name such as "Sprint").
        const verbatim = new Set(
          Object.entries(glossary.terms ?? {})
            .filter(([term, t]) => t.doNotTranslate || t.translation === term)
            .map(([term]) => term),
        );

        const missing = keys.filter((k) => tr[k] === undefined);
        const sameWord = new Set(SAME_WORD[locale] ?? []);
        const keptVerbatim = (k: string) => {
          const v = en[k]!;
          return (
            isWordless(v) || verbatim.has(v) || verbatim.has(v.replace(/s$/, '')) || sameWord.has(k)
          );
        };
        const untranslated = keys.filter((k) => tr[k] === en[k] && !keptVerbatim(k));
        const unrecorded = keys.filter((k) => rec[k] !== en[k]);
        expect({ missing, untranslated, unrecorded }).toEqual({
          missing: [],
          untranslated: [],
          unrecorded: [],
        });
      },
    );
  },
);
