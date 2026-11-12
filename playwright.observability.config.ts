import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  OBSERVABILITY_CAPTURE_PORT,
  OBSERVABILITY_FARGATE_ENV,
  OBSERVABILITY_METRICS_PORT,
} from './tests/e2e/_helpers/observability-const';
import { NEXT_START_KEEP_ALIVE_FLAG } from './tests/e2e/_helpers/server-keep-alive';

// THE OBSERVABILITY LANE (Story MOTIR-8537 · Subtask MOTIR-8557).
//
// One production server with Sentry ON at trace rate 1, pointed at a LOCAL
// ingest (`tests/e2e/_helpers/sentry-capture.ts`), with the instance env Fly
// would inject and the private metrics port open. Its one spec drives the hot
// routes and the MCP tools, then reads back what the server emitted: the
// envelopes the real SDK sent, and `/metrics`.
//
// WHY ITS OWN LANE. Every other lane's server has ONE `webServer.env`, and
// putting a DSN, rate 1 and a Fargate identity in it would switch Sentry and full tracing
// on for every spec in that lane — a posture change made inside a test refactor,
// the thing `playwright.cloud.config.ts`'s header rejects. This lane reuses the
// `next-build` artifact (`E2E_REUSE_BUILD=1`), so it costs one `next start` and
// one spec.
//
// MEMBERSHIP: `observability-*.spec.ts`. The main and cloud configs `testIgnore`
// that prefix, so nothing runs twice.
//
// ⚠️ THE DSN IS ON THE SERVER ONLY. It is in `webServer.env` and never on the
// runner, so the job worker `globalSetup` starts from the runner's env stays
// uninitialised, as a worker without the variable does in production.

loadEnv();

const REUSE_PREBUILT_NEXT = process.env['E2E_REUSE_BUILD'] === '1';

// Its own default port, so it runs beside the main (3000) and cloud (3100) lanes.
const USING_CUSTOM_ORIGIN = Boolean(process.env['E2E_BASE_URL']) || Boolean(process.env['PORT']);
const BASE_URL = process.env['E2E_BASE_URL'] ?? `http://localhost:${process.env['PORT'] ?? '3200'}`;
const PORT = new URL(BASE_URL).port || '3200';

// The same executor and email sink as the main lane (see playwright.config.ts).
process.env['E2E_JOB_WORKER'] ??= '1';
process.env['EMAIL_OUTBOX_PATH'] ??= path.resolve('/tmp/motir-test-emails.jsonl');
process.env['MOTIR_FLEET_ORCHESTRATOR'] ??= 'fake';
const EMAIL_OUTBOX_FILE = process.env['EMAIL_OUTBOX_PATH'];

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['**/observability-*.spec.ts'],
  // MOTIR-921: the runner seeds through services; see playwright.config.ts.
  tsconfig: './tsconfig.node.json',
  globalSetup: './tests/e2e/observability-global-setup.ts',
  globalTeardown: './tests/e2e/observability-global-teardown.ts',
  // The spec walks five requests and polls the capture after each.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'out/playwright-report-observability' }],
  ],
  outputDir: 'out/playwright-output-observability',
  use: {
    baseURL: BASE_URL,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: [
        'pnpm exec prisma generate',
        ...(REUSE_PREBUILT_NEXT ? [] : ['pnpm exec next build']),
        'pnpm run build:worker',
        `pnpm exec next start --port ${PORT} ${NEXT_START_KEEP_ALIVE_FLAG}`,
      ].join(' && '),
      url: BASE_URL,
      reuseExistingServer: !process.env['CI'] && !USING_CUSTOM_ORIGIN,
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // ── What this lane exists for ──
        SENTRY_DSN: `http://e2e@127.0.0.1:${OBSERVABILITY_CAPTURE_PORT}/1`,
        SENTRY_ENVIRONMENT: 'e2e',
        SENTRY_TRACES_SAMPLE_RATE: '1',
        ...OBSERVABILITY_FARGATE_ENV,
        MONITORING_METRICS_PORT: String(OBSERVABILITY_METRICS_PORT),
        // ── The main lane's prod-build harness (see playwright.config.ts) ──
        E2E_PROD_HARNESS: '1',
        UV_THREADPOOL_SIZE: '64',
        NODE_OPTIONS: '--max-old-space-size=6144',
        EMAIL_PROVIDER: 'file',
        EMAIL_OUTBOX_PATH: EMAIL_OUTBOX_FILE,
        E2E_TEST_OAUTH: '1',
        E2E_TEST_OAUTH_USER_PATH: path.resolve('/tmp/motir-test-oauth-user.json'),
        MOTIR_BASE_URL: BASE_URL,
        E2E_DISABLE_RATE_LIMIT: '1',
        E2E_DISABLE_DEV_INDICATOR: '1',
        MOTIR_FLEET_ORCHESTRATOR: process.env['MOTIR_FLEET_ORCHESTRATOR'] ?? 'fake',
      },
    },
  ],
});
