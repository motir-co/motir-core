import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

// EVENT-LOOP DELAY AS CLOUDWATCH METRICS (MOTIR-9881).
//
// On AWS the web, worker and relay run as Fargate services whose stdout reaches a
// CloudWatch log group through the awslogs driver. CloudWatch turns a log line in
// EMBEDDED METRIC FORMAT (EMF) into metrics on ingestion, so a process publishes a
// metric by printing one JSON object on its own line: no collector, no AWS SDK,
// no port. The monitoring construct in motir-infra alarms on
// `EventLoopDelayMaxMs`, per `Service`.
//
// ⚠️ UNSET MEANS NOTHING. With `MONITORING_CLOUDWATCH_NAMESPACE` unset or blank
// no histogram is created, no timer starts and nothing is written. Fly and a
// self-hosted build set neither variable and behave exactly as before.
//
// ⚠️ ITS OWN HISTOGRAM, NOT SENTRY'S. `transactionStall.ts` keeps an event-loop
// histogram too, but it starts only where `Sentry.init` runs with a DSN and the
// relay never starts it. A Fargate task may run with no DSN, so the metric owns
// its measurement.
//
// ⚠️ ONE PUBLISHER PER PROCESS, NOT PER MODULE INSTANCE (the MOTIR-7007 rule).
// Next evaluates `instrumentation.ts` in a different module graph from the route
// handlers, so the holder lives on `globalThis` under a registered symbol, as
// `metricsServer.ts` does.
//
// THE READING. Each interval publishes the MAX and the p99 of that interval, then
// resets the histogram. A block that ended just before a tick is in the interval
// that tick reports; a block long enough to stall the tick itself is reported on
// the first tick after it ends, since the histogram recorded it meanwhile.

export const EMF_INTERVAL_MS = 60_000;

export type EmfUnit = 'Milliseconds' | 'Percent' | 'Count' | 'None';

export interface EmfMetric {
  readonly name: string;
  readonly unit: EmfUnit;
  readonly value: number;
}

/** What the two settings resolve to, read once when a publisher starts. */
export interface CloudWatchSettings {
  readonly namespace: string;
  readonly service: string;
}

const RESOLUTION_MS = 10;
const NS_PER_MS = 1_000_000;
const UNKNOWN_SERVICE = 'unknown';
const PUBLISHER_KEY = Symbol.for('motir.cloudwatchMetrics.publisher');

type Env = Readonly<Record<string, string | undefined>>;

export interface EventLoopDelayPublisher {
  readonly settings: CloudWatchSettings;
  readonly histogram: IntervalHistogram;
  readonly timer: NodeJS.Timeout;
}

type Holder = { [PUBLISHER_KEY]?: EventLoopDelayPublisher };

/**
 * The publication settings, or null when `MONITORING_CLOUDWATCH_NAMESPACE` is
 * unset or blank. A blank `MONITORING_CLOUDWATCH_SERVICE` reads as `unknown`,
 * with one warning per call, so a caller that reads once at start warns once.
 */
export function readCloudWatchSettings(env: Env = process.env): CloudWatchSettings | null {
  const namespace = env['MONITORING_CLOUDWATCH_NAMESPACE']?.trim();
  if (!namespace) return null;
  const service = env['MONITORING_CLOUDWATCH_SERVICE']?.trim();
  if (service) return { namespace, service };
  console.warn(
    `[cloudwatchMetrics] MONITORING_CLOUDWATCH_SERVICE is not set; publishing as Service="${UNKNOWN_SERVICE}".`,
  );
  return { namespace, service: UNKNOWN_SERVICE };
}

/**
 * Write ONE EMF line to stdout. Through `process.stdout.write`, not
 * `console.log`, so no prefix or console breadcrumb wraps the JSON: CloudWatch
 * parses the line only when it is the object alone.
 */
export function emitEmfLine(
  namespace: string,
  dimensions: Readonly<Record<string, string>>,
  metrics: readonly EmfMetric[],
  now: number = Date.now(),
): void {
  if (metrics.length === 0) return;
  const line: Record<string, unknown> = {
    _aws: {
      Timestamp: Math.trunc(now),
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          Dimensions: [Object.keys(dimensions)],
          Metrics: metrics.map(({ name, unit }) => ({ Name: name, Unit: unit })),
        },
      ],
    },
    ...dimensions,
  };
  for (const metric of metrics) line[metric.name] = metric.value;
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/** Milliseconds from a histogram's nanoseconds, to 2 decimals. */
export function nsToMs(ns: number): number {
  return Math.round((ns / NS_PER_MS) * 100) / 100;
}

function emitDelay(settings: CloudWatchSettings, histogram: IntervalHistogram): void {
  // An interval with no sample (the histogram's own timer never ran) has no
  // reading to publish; a 0 would claim a healthy loop nobody measured.
  if (histogram.count > 0) {
    emitEmfLine(settings.namespace, { Service: settings.service }, [
      { name: 'EventLoopDelayMaxMs', unit: 'Milliseconds', value: nsToMs(histogram.max) },
      {
        name: 'EventLoopDelayP99Ms',
        unit: 'Milliseconds',
        value: nsToMs(histogram.percentile(99)),
      },
    ]);
  }
  histogram.reset();
}

/**
 * Start publishing this process's event-loop delay when
 * `MONITORING_CLOUDWATCH_NAMESPACE` is set. Returns the publisher, or null when
 * the setting is unset or blank. A second call returns the first publisher.
 */
export function startEventLoopDelayPublisher(
  env: Env = process.env,
): EventLoopDelayPublisher | null {
  const holder = globalThis as Holder;
  if (holder[PUBLISHER_KEY]) return holder[PUBLISHER_KEY];
  const settings = readCloudWatchSettings(env);
  if (!settings) return null;

  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
  const timer = setInterval(() => emitDelay(settings, histogram), EMF_INTERVAL_MS);
  // Never keep a process alive for a measurement.
  timer.unref();
  const publisher: EventLoopDelayPublisher = { settings, histogram, timer };
  holder[PUBLISHER_KEY] = publisher;
  return publisher;
}

/** Tests only: stop the publisher and forget it. */
export function stopEventLoopDelayPublisherForTests(): void {
  const holder = globalThis as Holder;
  const publisher = holder[PUBLISHER_KEY];
  delete holder[PUBLISHER_KEY];
  if (!publisher) return;
  clearInterval(publisher.timer);
  publisher.histogram.disable();
}
