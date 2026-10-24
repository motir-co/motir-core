import { defineConfig } from '@playwright/test';
import acceptance from './playwright.acceptance.config';

// The REGRESSION lane (MOTIR-9411) — the done stories' acceptance specs, kept
// as regression tests and taken off the recording apparatus.
//
// Every spec here was an `acceptance-*.spec.ts` whose story is done. Its receipt
// is frozen, so the recording has done its job (the lifecycle ADR §3), but the
// flow it drives still needs a test, and most of these flows need the SAME
// cloud-on server the acceptance lane boots: billing, the motir-ai boundary
// mock, the code-health and GitHub-repository fixtures, the job worker. So this
// config IS the acceptance config, with only the recording taken out. The
// server, its env and its seams live in `playwright.acceptance.config.ts` and
// are not restated here; a seam added there reaches both lanes.
//
// ⚠️ WHY NOT THE MAIN OR CLOUD LANE. Both run on every pull request that touches
// the app (`ci.yml`'s `e2e` job). These specs used to run only when a PR touched
// the acceptance lane's own paths, in the merge queue under the same gate, and
// in full on every push to `main`. Promoting them into a per-PR lane would put
// roughly an hour and a half of browser tests on every app PR. This lane keeps
// their old triggers instead (`.github/workflows/acceptance-tests.yml`, the
// `regression` jobs), so a PR pays for them only when it changes them.
//
// What the recording took, and this lane gives back:
//   * PACING. Each spec imports `_helpers/promoted-regression`, whose `chapter()`
//     keeps the `test.step` and drops the hold, and whose `beat()` is a no-op —
//     about 136 minutes of holds across the lane. The holds were never
//     synchronisation (see `CHAPTER_HOLD_MS` in `_helpers/acceptance-video.ts`),
//     so no assertion changes.
//   * VIDEO and TRACE on every green run. A regression run keeps them only when
//     a test fails, like the main lane.
//   * RETRIES. The acceptance lane never retries, because a retry records a
//     second clip. Nothing is recorded here, so a CI retry is allowed, as in
//     the main lane.
//
// ⚠️ THE PORT IS THE ACCEPTANCE LANE'S (3200). The two lanes run on separate CI
// runners, and the server they would boot is the same build with the same env,
// so a local run of both at once reuses one server. Set `PORT` to keep them
// apart.
export default defineConfig({
  ...acceptance,
  testMatch: ['**/regression-*.spec.ts'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'out/playwright-report-regression' }],
  ],
  outputDir: 'out/playwright-output-regression',
  use: {
    ...acceptance.use,
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
});
