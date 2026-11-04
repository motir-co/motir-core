import { defineConfig, devices } from '@playwright/test';
import { readSmokeEnv } from './tests/smoke/env';

// The CUTOVER SMOKE lane (Story MOTIR-9712 · MOTIR-10076): `pnpm test:smoke:cutover`.
//
// ⚠️ UNLIKE EVERY OTHER LANE, THIS ONE STARTS NOTHING. There is no `webServer`,
// no `globalSetup` / `globalTeardown`, no database and no request mocking: it
// drives the DEPLOYED stack at `SMOKE_BASE_URL` — a rehearsal hostname, or
// production — so every assertion is answered by real DNS, TLS, rows and
// buckets. The other configs read `tests/e2e`; this one reads `tests/smoke`
// only, and none of theirs reaches it.
//
// The `SMOKE_*` inputs are read HERE, at load, so a run with any of them unset
// exits non-zero before a browser launches, naming every missing variable
// (`tests/smoke/env.ts`). The runbook (`docs/core-cutover.md` in motir-infra)
// lists the values for the rehearsal and for production.
//
// `retries: 0`: a smoke run that needs a retry is a no-go to report, not one to
// hide. One worker, because the spec is one serial walk that signs in once.

const env = readSmokeEnv();

export default defineConfig({
  testDir: 'tests/smoke',
  testMatch: ['**/*.smoke.spec.ts'],
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: 'out/smoke-output',
  use: {
    baseURL: env.baseUrl,
    navigationTimeout: 45_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
