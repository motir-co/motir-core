// E2E: every main surface in each of the nine new languages (Story MOTIR-7730 ·
// MOTIR-7761, the story's Verification steps 9–10).
//
// Nine languages × seven surfaces is far past any video budget, so this walk is
// the main-lane half of the story E2E: evidence for the gate, not footage for a
// person (the receipt is `regression-eleven-languages.spec.ts`).
//
// One test per language. Each signs the seeded person in from a browser whose
// `locale` is that language, saves it as the ACCOUNT language through the UI
// choice in Settings (never a database write), and then visits the work item
// list, a work item page, the board, the backlog, a plan review, Settings →
// Account and the approvals queue. On each surface:
//
//   * `<html lang>` is the language;
//   * a landmark string equals its value in THAT language's catalogue;
//   * the raw-key scan passes (no `en.json` key path rendered as text);
//   * the seeded 2026-10-07 renders with the month `Intl` names in that
//     language where the surface shows it (the backlog's sprint, the item's
//     dates), and the English `Oct` appears nowhere as a whole word;
//   * in the seven languages the fit work item (MOTIR-7759) did not measure,
//     every label fits its control (`assertLabelsFit`);
//   * "Motir" stays untranslated in the shell, and "Sprint" stays Latin on the
//     backlog.
//
// Every expected string is read from `messages/<locale>.json` at run time.
// Nothing waits on a timeout: each surface is proven rendered by a role read
// before it is scanned, and each language choice waits on the `setLocale`
// response and the re-rendered `<html lang>` (CLAUDE.md, the
// authoritative-signal rule).

import { expect, test } from '@playwright/test';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { assertLabelsFit } from './_helpers/label-fit';
import { seedLabelFitTenant, type LabelFitSeed } from './_helpers/label-fit-seed';
import {
  NEW_LOCALES,
  pinSeededDates,
  saveAccountLanguageInSettings,
  signInHere,
  visitSurface,
  walkSurfaces,
} from './_helpers/i18n-walk';

const EMAIL = 'e2e-i18n-walk@example.com';

/** The languages `label-fit-long-locales.spec.ts` (MOTIR-7759) did not measure. */
const UNMEASURED_FIT = new Set(['ja', 'ko', 'fr', 'es', 'it', 'nl', 'pt']);

/** The BCP 47 tag a browser in each language sends (`Accept-Language`). */
const BROWSER_TAG: Record<(typeof NEW_LOCALES)[number], string> = {
  ja: 'ja-JP',
  ko: 'ko-KR',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  it: 'it-IT',
  nl: 'nl-NL',
  pl: 'pl-PL',
  pt: 'pt-PT',
};

let seed: LabelFitSeed;

test.describe('every main surface in each new language', () => {
  test.beforeAll(async () => {
    await resetDatabase();
    // The crowded tenant `label-fit-long-locales.spec.ts` measures: work items in
    // every board column, an active sprint, a plan awaiting review (which is the
    // approval in the queue). Its sprint and one work item are then pinned to the
    // story's fixed date — seeding, not the account language.
    seed = await seedLabelFitTenant(EMAIL);
    const sprint = await adminDb.sprint.findFirstOrThrow({ where: { name: 'Sprint 1' } });
    const item = await adminDb.workItem.findFirstOrThrow({ where: { identifier: seed.itemKey } });
    await pinSeededDates(sprint.id, item.id);
    // A sprint name that is not the word under test, so "Sprint" on the backlog
    // can only come from the product's own copy.
    await adminDb.sprint.update({ where: { id: sprint.id }, data: { name: 'Autumn push' } });
  });

  test.afterAll(async () => {
    await adminDb.$disconnect();
  });

  for (const locale of NEW_LOCALES) {
    test.describe(locale, () => {
      test.use({ locale: BROWSER_TAG[locale] });

      test(`the seven surfaces render in ${locale}`, async ({ page }) => {
        test.setTimeout(240_000);
        await signInHere(page, seed.email, seed.password);
        await saveAccountLanguageInSettings(page, locale);
        const row = await adminDb.user.findUniqueOrThrow({ where: { email: EMAIL } });
        expect(row.locale, 'the account language the Settings choice saved').toBe(locale);

        for (const surface of walkSurfaces(seed)) {
          const where = `${surface.name} · ${locale}`;
          await visitSurface(page, surface, locale);
          if (UNMEASURED_FIT.has(locale)) await assertLabelsFit(page, { label: where });
        }
      });
    });
  }
});
