/**
 * `breach` — a deliberate, bounded memory, CPU or event-loop breach, so each
 * CloudWatch alarm is proven by a real one (MOTIR-9884):
 *
 *   MOTIR_BREACH_ENABLED=true node breach/breach.mjs memory --percent 80 [--limit-mb N] [--seconds 300]
 *   MOTIR_BREACH_ENABLED=true node breach/breach.mjs cpu [--seconds 300]
 *   MOTIR_BREACH_ENABLED=true node breach/breach.mjs loop --block-ms 1500 [--seconds 300]
 *
 * Run ONLY as an ECS one-off task of the core image on a rehearsal service: the
 * web, worker and relay never start it and nothing in the services references
 * it. Without `MOTIR_BREACH_ENABLED=true`, or with a bad argument, it exits 2
 * with a one-line reason and does no work. Otherwise it writes a start and an end
 * JSON line to stdout and exits 0 once `--seconds` are up.
 *
 * The logic lives in `lib/monitoring/breachTask.ts`; this file only wires the
 * real clock, allocator, Worker and publishers to it. ⚠️ IT IS BUNDLED, NOT RUN
 * FROM SOURCE — `pnpm build:breach` esbuilds it into `.breach/breach.mjs`, which
 * the Dockerfile stages at `/app/breach/`.
 */
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import {
  busyBlock,
  readBreachFile,
  realClock,
  runBreachCommand,
} from '@/lib/monitoring/breachTask';
import { startEventLoopDelayPublisher } from '@/lib/monitoring/cloudwatchMetrics';
import { startWatchdogMetricsPublisher } from '@/lib/monitoring/watchdogMetrics';

void runBreachCommand(process.argv.slice(2), process.env, {
  clock: realClock,
  write: (line) => process.stdout.write(`${line}\n`),
  writeError: (line) => process.stderr.write(`${line}\n`),
  readFile: readBreachFile,
  hostTotalBytes: os.totalmem(),
  availableParallelism: os.availableParallelism(),
  allocate: (bytes) => Buffer.alloc(bytes, 1),
  rssBytes: () => process.memoryUsage.rss(),
  createWorker: () => new Worker('for (;;) {}', { eval: true }),
  block: busyBlock,
  // The services' own two publishers, so the task publishes under whatever
  // `MONITORING_CLOUDWATCH_SERVICE` its override sets.
  startPublishers: () => {
    startEventLoopDelayPublisher();
    startWatchdogMetricsPublisher();
  },
  // Never left running: whatever a mode holds, the process is gone 5 s past its
  // bounded time. Unref'd, so it never keeps the process up by itself.
  armDeadline: (ms) => {
    setTimeout(() => process.exit(0), ms).unref();
  },
}).then(
  // Exit at once: the watchdog's thread and the publishers' timers are not work.
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`breach: error: ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exit(1);
  },
);
