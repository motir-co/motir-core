// THE ACCEPTANCE LANE'S OBJECT-STORE PLACEHOLDERS (Story MOTIR-9800 · MOTIR-12142),
// in one place because two processes need them: the webServer
// (`playwright.acceptance.config.ts`) and the job worker
// (`job-worker-process.ts`'s `graceWindowSeamEnv`), whose grace-window stop
// writes the application's export. `E2E_TEST_BLOB=1` installs
// `lib/test-blob-mock.ts` in front of the S3 client, so the endpoint below is
// the host that seam intercepts and nothing ever leaves the process. None of
// these is a credential: every value is a test-only placeholder.
export const E2E_OBJECT_STORE_ENV = {
  MOTIR_S3_ENDPOINT: 'https://e2e.s3.invalid',
  MOTIR_S3_REGION: 'auto',
  MOTIR_S3_ACCESS_KEY_ID: 'e2e-playwright-only-placeholder',
  MOTIR_S3_SECRET_ACCESS_KEY: 'e2e-playwright-only-placeholder-secret',
  MOTIR_S3_PRIVATE_BUCKET: 'motir-e2e-private',
  MOTIR_S3_PUBLIC_BUCKET: 'motir-e2e-public',
  MOTIR_S3_PUBLIC_BASE_URL: 'https://e2etest.public.store.invalid',
} as const satisfies Record<string, string>;
