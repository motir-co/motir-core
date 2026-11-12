import path from 'node:path';

// The observability lane's fixed values (MOTIR-8557), shared by
// `playwright.observability.config.ts`, its global setup and its spec so the
// three cannot drift.

/** The local Sentry ingest (`./sentry-capture.ts`) the server's DSN points at. */
export const OBSERVABILITY_CAPTURE_PORT = 9393;
/** The file the ingest writes and the spec reads. Under `out/` so CI uploads it. */
export const OBSERVABILITY_CAPTURE_FILE = path.resolve('out', 'e2e-sentry-capture.jsonl');
/** The server's private metrics port (`MONITORING_METRICS_PORT`). */
export const OBSERVABILITY_METRICS_PORT = 9191;

/** The Fargate task id the lane's server says it is (MOTIR-10962). */
export const OBSERVABILITY_TASK_ID = 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0';
/** The instance the lane's server says it is — the env a Fargate core task carries. */
export const OBSERVABILITY_FARGATE_ENV = {
  AWS_EXECUTION_ENV: 'AWS_ECS_FARGATE',
  AWS_REGION: 'us-east-1',
  ECS_CONTAINER_METADATA_URI_V4: `http://169.254.170.2/v4/${OBSERVABILITY_TASK_ID}-1234567890`,
  MONITORING_CLOUDWATCH_SERVICE: 'web',
} as const;
