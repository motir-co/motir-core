# Request database timing — wait, hold and pool per route

Every interactive transaction the web server opens through a `with*Context`
helper is recorded, sampled for a trace or not, into Prometheus histograms
labelled with the request's route and, on MCP, the tool (MOTIR-8553). A Sentry
trace says what one sampled request did; these series say what the p95 and p99
of every request were.

- **Recorded by** `lib/monitoring/requestDbTiming.ts`, which listens to the
  transaction seam's measurements (`lib/monitoring/transactionSpan.ts`,
  MOTIR-8550).
- **Labelled by** `lib/monitoring/requestLabel.ts`, which the hot routes set.
- **Served by** `lib/monitoring/metricsServer.ts` on `GET /metrics` at
  `MONITORING_METRICS_PORT`. The port is unset everywhere except Fly, where
  `fly.toml` sets it to `9091` and declares the `[[metrics]]` scrape for the
  `app` group.
- **Stored in** Fly's managed Prometheus. It is scraped every 15 s and kept for
  about 15 days (<https://docs.fly.io/monitoring/metrics>).

The job worker does not run `instrumentation.ts`, so it records nothing here.

## On AWS

On AWS the same series reach CloudWatch, and Fly's scrape of `9091` keeps
working unchanged wherever `MONITORING_METRICS_PORT` is set.

- **Published by** a collector container (the AWS Distro for OpenTelemetry)
  beside the web task, which scrapes the web's own `/metrics` over the task's
  loopback every 15 s and writes the series with its `awsemf` exporter. The
  production parameters turn it on for the web only (motir-infra,
  `lib/config/environments/production.ts`, `monitoring.requestTiming`).
- **Stored in** the CloudWatch namespace `monitoring.metricNamespace`, which is
  `Motir/Core` in production. The raw EMF lines land in the log group
  `/motir/core/web/request-timing`, one log stream per task.
- **Dimensioned by** the collector's `dimensionSets`, and production declares
  ONE set for each of the seven series: the empty set, `[[]]`. So each series is
  a single aggregate metric with no dimension, counting every transaction of
  every route, tool, context, outcome and attempt together. The per-route and
  per-tool sets (MOTIR-10070) made about 670 paid metrics that no alarm read, so
  they were dropped before launch (MOTIR-10892); a set can come back in the
  parameter file for a timing investigation. In CloudWatch a query cannot group
  or filter by any label.
- **The labels are still in the log lines.** `awsemf` writes every scraped
  point to the log group with all its labels as fields, whatever the dimension
  sets say. So a per-route, per-tool or per-attempt reading comes from Logs
  Insights over `/motir/core/web/request-timing` (the
  [Logs Insights](#logs-insights--per-route-per-tool-per-task) section below),
  or from the web task's own `/metrics` port. Fly's `instance` label has no
  equivalent in CloudWatch, because the collector adds no task dimension; the
  log streams are named by task id instead. A service's memory and CPU are
  ECS's `AWS/ECS` service metrics (see [the AWS alarms](./aws-alarms.md)).
- **Only count, sum and average are real.** `awsemf` sends each histogram as one
  statistic set per period, not as buckets, and a Prometheus histogram carries
  no minimum or maximum. So of CloudWatch's statistics only `SampleCount`, `Sum`
  and `Average` (Sum / SampleCount) hold measured values. **`Minimum` and
  `Maximum` read 0 whatever was observed — never read them as a longest wait or
  hold.** And `histogram_quantile` has no CloudWatch equivalent: **p50, p95 and
  p99 are not available on AWS.** The nearest reading beside each quantile query
  below is the Average.
- **Cost.** Each distinct combination of a series' dimension values is a
  separately billed CloudWatch custom metric, so production pays for seven.

The CloudWatch blocks below are
[Metrics Insights](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/query_with_cloudwatch-metrics-insights.html)
queries. Paste one into the console's Metrics → All metrics → Query tab, or pass
it to `aws cloudwatch get-metric-data` as a `MetricDataQueries` expression. In
Metrics Insights, `SUM` reads the Sum statistic and `COUNT` reads SampleCount;
`MAX` and `MIN` read the Maximum and Minimum, which are 0 here. `SCHEMA` matches
metrics with exactly the dimensions it names, so `SCHEMA("Motir/Core")`, naming
none, reads the dimensionless aggregate production publishes.
Set the period to the window you would have put in `[5m]`.

## The series

| series                       | kind      | labels                                           | what it is                                                                                                            |
| ---------------------------- | --------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `db_tx_wait_seconds`         | histogram | `route`, `tool`, `context`, `outcome`, `attempt` | The helper asked → the body started: pool acquire, `BEGIN` and the `set_config` binds.                                |
| `db_tx_hold_seconds`         | histogram | same                                             | The body started → `COMMIT` / `ROLLBACK`. Not recorded for an attempt whose body never ran (a P2028 before the body). |
| `db_pool_waiting_at_acquire` | histogram | `route`, `tool`                                  | Requests already queued for a connection when this transaction asked, summed over every pool in the process.          |
| `db_pool_idle_at_acquire`    | histogram | `route`, `tool`                                  | Idle connections when this transaction asked.                                                                         |
| `db_pool_max`                | gauge     | —                                                | The summed pool `max` at the latest measurement.                                                                      |
| `db_pool_count`              | gauge     | —                                                | How many pools were registered at the latest measurement.                                                             |
| `db_pool_unmeasured_total`   | counter   | `route`, `tool`                                  | Transactions whose pool could not be read. These are counted here and never recorded as a zero.                       |

The labels:

- **`route`** is one of `workbench` (the `/workbench` page, its Approvals and
  Planning tabs included), `workbench_stream` (`/api/workbench/stream`, for the
  stream's whole life), `plan_get` (`GET /api/plans/<id>`), `mcp` (`/api/mcp`),
  or `unlabelled` for everything else.
- **`tool`** is the MCP tool name on `route="mcp"`. It is empty for the request's
  own work outside a tool call, and for every other route. A name the registry
  never registered is recorded as `other`.
- **`context`** is the helper: `workspace`, `workspace_service`, `system`,
  `bootstrap_slug`, `user`, `org` or `org_service_write`.
- **`outcome`** is `committed`, `rolled_back`, `p2028_wait`, `p2028_timeout` or
  `error_before_body`.
- **`attempt`** is `1`, or `2` for the one retry after a P2028 before the body.

Fly adds `app`, `instance` and `region` at scrape time, so `by (instance)` gives
one machine and leaving it out gives the fleet. That works because these are
histograms, not summaries.

## Where to run the queries

- **Fly's managed Grafana** (`fly dashboard metrics -a motir-core`, or the
  dashboard's Metrics tab). Paste a query into an Explore panel over the managed
  Prometheus data source.
- **The Prometheus HTTP API**, with a Fly access token. The org slug is `moooon`
  (`fly.toml`'s `app` comment):

  ```sh
  curl -sG https://api.fly.io/prometheus/moooon/api/v1/query \
    -H "Authorization: Bearer $(fly auth token)" \
    --data-urlencode 'query=histogram_quantile(0.95, sum by (le, route) (rate(db_tx_wait_seconds_bucket{app="motir-core"}[5m])))'
  ```

  A token from `fly tokens create` goes in as `Authorization: FlyV1 <token>`.

Change `[5m]` to the window you want. Use `[1h]` over a load test, or the length
of an incident.

## Queries

### Wait per route — p50, p95, p99

```promql
histogram_quantile(0.50, sum by (le, route) (rate(db_tx_wait_seconds_bucket{app="motir-core"}[5m])))
histogram_quantile(0.95, sum by (le, route) (rate(db_tx_wait_seconds_bucket{app="motir-core"}[5m])))
histogram_quantile(0.99, sum by (le, route) (rate(db_tx_wait_seconds_bucket{app="motir-core"}[5m])))
```

**CloudWatch** has no p50, p95 or p99, and no longest wait. The nearest reading
is the average wait, the first query divided by the second (a metric-math
`m1 / m2`). The metric has no `route` dimension, so this is the average over
every route; the per-route average is in Logs Insights
([below](#logs-insights--per-route-per-tool-per-task)):

```sql
SELECT SUM(db_tx_wait_seconds) FROM SCHEMA("Motir/Core")
SELECT COUNT(db_tx_wait_seconds) FROM SCHEMA("Motir/Core")
```

### Hold per route — p50, p95, p99

```promql
histogram_quantile(0.50, sum by (le, route) (rate(db_tx_hold_seconds_bucket{app="motir-core"}[5m])))
histogram_quantile(0.95, sum by (le, route) (rate(db_tx_hold_seconds_bucket{app="motir-core"}[5m])))
histogram_quantile(0.99, sum by (le, route) (rate(db_tx_hold_seconds_bucket{app="motir-core"}[5m])))
```

**CloudWatch** has no quantiles and no longest hold. Use the average over every
route (`m1 / m2`), and Logs Insights for it per route:

```sql
SELECT SUM(db_tx_hold_seconds) FROM SCHEMA("Motir/Core")
SELECT COUNT(db_tx_hold_seconds) FROM SCHEMA("Motir/Core")
```

### Wait and hold per MCP tool — p50, p95, p99

```promql
histogram_quantile(0.50, sum by (le, tool) (rate(db_tx_wait_seconds_bucket{app="motir-core", route="mcp"}[5m])))
histogram_quantile(0.95, sum by (le, tool) (rate(db_tx_wait_seconds_bucket{app="motir-core", route="mcp"}[5m])))
histogram_quantile(0.99, sum by (le, tool) (rate(db_tx_wait_seconds_bucket{app="motir-core", route="mcp"}[5m])))

histogram_quantile(0.50, sum by (le, tool) (rate(db_tx_hold_seconds_bucket{app="motir-core", route="mcp"}[5m])))
histogram_quantile(0.95, sum by (le, tool) (rate(db_tx_hold_seconds_bucket{app="motir-core", route="mcp"}[5m])))
histogram_quantile(0.99, sum by (le, tool) (rate(db_tx_hold_seconds_bucket{app="motir-core", route="mcp"}[5m])))
```

**CloudWatch** has no quantiles and no `tool` dimension, so no Metrics Insights
query reads a tool. The average per tool is in Logs Insights
([below](#logs-insights--per-route-per-tool-per-task)).

### The same, per machine

Add `instance` to the `by`. For example, the p95 wait per route and machine:

```promql
histogram_quantile(0.95, sum by (le, route, instance) (rate(db_tx_wait_seconds_bucket{app="motir-core"}[5m])))
```

**CloudWatch** metrics have no equivalent. The series carry no task dimension,
because Fly's `instance` label is added by Fly's scrape and the collector adds
none. The per-task values are in the log group, whose log streams are named by
task id: the per-task query in
[Logs Insights](#logs-insights--per-route-per-tool-per-task) below. A service's
memory and CPU are ECS's `AWS/ECS` service metrics, whose Maximum is its busiest
task ([the AWS alarms](./aws-alarms.md)).

### Pool waiting at acquire, per route

```promql
histogram_quantile(0.95, sum by (le, route) (rate(db_pool_waiting_at_acquire_bucket{app="motir-core"}[5m])))
# the mean queue a transaction joined
sum by (route) (rate(db_pool_waiting_at_acquire_sum{app="motir-core"}[5m]))
  / sum by (route) (rate(db_pool_waiting_at_acquire_count{app="motir-core"}[5m]))
```

**CloudWatch** has no p95 and no longest queue. The mean queue over every route
(`m1 / m2`, the second Fly query without its `by (route)`), and Logs Insights
for it per route:

```sql
SELECT SUM(db_pool_waiting_at_acquire) FROM SCHEMA("Motir/Core")
SELECT COUNT(db_pool_waiting_at_acquire) FROM SCHEMA("Motir/Core")
```

### The retry rate

This is the share of transaction attempts that were the one retry after a P2028
before the body.

```promql
sum by (route) (rate(db_tx_wait_seconds_count{app="motir-core", attempt="2"}[5m]))
  / sum by (route) (rate(db_tx_wait_seconds_count{app="motir-core"}[5m]))
```

**CloudWatch** metrics cannot give it: `attempt` is not a dimension. Logs
Insights gives it exactly, per route
([below](#logs-insights--per-route-per-tool-per-task)).

### The unlabelled share

This is how much of the database's transaction load comes from routes outside the
four hot ones.

```promql
sum(rate(db_tx_wait_seconds_count{app="motir-core", route="unlabelled"}[5m]))
  / sum(rate(db_tx_wait_seconds_count{app="motir-core"}[5m]))
```

**CloudWatch** metrics cannot give it: `route` is not a dimension. The
transactions per route in Logs Insights give it exactly
([below](#logs-insights--per-route-per-tool-per-task)): the `unlabelled` row's
count over the total.

### Transactions per second, per route

This shows that every request is recorded, sampled for a trace or not.

```promql
sum by (route) (rate(db_tx_wait_seconds_count{app="motir-core"}[5m]))
```

**CloudWatch**: the transactions per period, over every route. Divide by the
period in seconds (`m1 / PERIOD(m1)`) for a per-second rate. Per route, use
Logs Insights:

```sql
SELECT COUNT(db_tx_wait_seconds) FROM SCHEMA("Motir/Core")
```

### Logs Insights — per route, per tool, per task

The log group `/motir/core/web/request-timing` holds every point the collector
scraped, one log stream per task id, with all its labels (`route`, `tool`,
`context`, `outcome`, `attempt`) as fields. Run these in the CloudWatch console's
Logs Insights over that log group, or with `aws logs start-query`. The lines
carry the same statistic set as the metrics, so read counts, sums and averages
(their `Max` and `Min` are 0 too).

The average wait per route, with the transactions behind it. Swap
`db_tx_wait_seconds` for `db_tx_hold_seconds` to read hold, or for
`db_pool_waiting_at_acquire` to read the mean queue:

```
filter ispresent(db_tx_wait_seconds.Count)
| stats sum(db_tx_wait_seconds.Sum) / sum(db_tx_wait_seconds.Count) as avg_wait_seconds,
        sum(db_tx_wait_seconds.Count) as transactions
  by route
```

The average wait per MCP tool (swap in `db_tx_hold_seconds` for hold):

```
filter route = "mcp" and ispresent(tool) and ispresent(db_tx_wait_seconds.Count)
| stats sum(db_tx_wait_seconds.Sum) / sum(db_tx_wait_seconds.Count) as avg_wait_seconds,
        sum(db_tx_wait_seconds.Count) as transactions
  by tool
```

The attempts per route and attempt. The retry rate of a route is its
`attempt` `2` row over the sum of its two rows:

```
filter ispresent(db_tx_wait_seconds.Count)
| stats sum(db_tx_wait_seconds.Count) as attempts by route, attempt
```

The average wait per task and route:

```
fields @logStream, route
| filter ispresent(db_tx_wait_seconds.Count)
| stats sum(db_tx_wait_seconds.Sum) / sum(db_tx_wait_seconds.Count) as avg_wait_seconds by @logStream, route
```

## What these series do not say

- **Which statement was slow.** Hold is the whole transaction body. A sampled
  trace's `db.transaction.hold` span names its statements, and
  `pnpm ops:pg-top-statements` ranks the statements the database itself timed
  (MOTIR-8552).
- **The request's own latency.** These series are per transaction attempt, and a
  request can open several.
- **That Fly scraped anything.** `fly.toml` declares the scrape. Reading the
  series back from Fly's Prometheus after a deploy is the proof.
