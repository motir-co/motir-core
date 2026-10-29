# AWS alarms — memory, CPU, event-loop block and steal per service

On Fly, the on-call engineer reads Fly's Grafana and Sentry. On AWS, each core
service (`web`, `worker`, `relay`) has CloudWatch alarms that notify one SNS
topic. This page maps each Fly signal to the alarm that replaces it, names the
series each alarm reads, and gives the one-off breach task that proves each
alarm fires.

The alarms are built by motir-infra (`lib/constructs/service-alarms.ts`), from
the `monitoring` block of its parameter file
(`lib/config/environments/production.ts`). This page copies the production
values as merged. When the parameter file changes, it wins.

## Fly alert → AWS alarm

No Fly or Sentry rule watched memory, CPU steal or event-loop blocks before
this story. The Fly-rules check
([MOTIR-9879](https://app.motir.co/items/MOTIR-9879)) read Fly's Grafana and
Prometheus, the Fly dashboard and Sentry on 2026-10-29 and found none. The one
destination in use was Sentry's email to an issue's owners. So each AWS alarm
below is set from the target the story stated, not copied from a Fly rule.

Every alarm is named `<namePrefix>-<service>-<kind>`, so in production it is
`motir-web-memory`, `motir-worker-cpu`, `motir-relay-event-loop-block` and so on.
Each one notifies the SNS topic `motir-alarms` when it goes to ALARM and again
when it returns to OK. The topic is encrypted with the secrets-and-logs key, and
its subscribers are listed in the parameter file.

| Fly signal today                                 | AWS alarm (per service)            | signal read                                      | threshold | period | datapoints to alarm |
| ------------------------------------------------ | ---------------------------------- | ------------------------------------------------ | --------- | ------ | ------------------- |
| memory: no rule existed                          | `motir-<service>-memory`           | `100 * MemoryUtilized / MemoryReserved`, Maximum | ≥ 85 %    | 60 s   | 2 of 3              |
| CPU steal: no rule existed                       | `motir-<service>-cpu`              | `100 * CpuUtilized / CpuReserved`, Maximum       | ≥ 90 %    | 60 s   | 5 of 5              |
|                                                  | `motir-<service>-steal`            | `CpuStealMs`, Maximum                            | ≥ 6000 ms | 60 s   | 3 of 5              |
| event-loop block: no rule existed (Sentry mails) | `motir-<service>-event-loop-block` | `EventLoopDelayMaxMs`, Maximum                   | ≥ 2000 ms | 60 s   | 1 of 3              |

The targets these numbers implement:

- **Memory** alarms below the out-of-memory kill, so there is time to act before
  ECS kills the task.
- **CPU** alarms at sustained saturation of the task's reservation: five minutes
  at 90 % or more.
- **Event-loop block** alarms on one block of 2 s or more, well under the 5 s
  interactive-transaction timeout that a P2028 marks. On Fly today, Sentry's
  `new-issue` alert emails only when such a block opens a _new_ issue.
- **Steal** alarms on CPU taken by the host. On 2026-10-15, that starvation
  showed up as a 17 s event-loop freeze and P2028s.

## The series each alarm reads

- **Memory and CPU** come from ECS Container Insights, namespace
  `ECS/ContainerInsights`, dimensions `ClusterName` (`motir-core`) and
  `ServiceName` (`motir-core-<service>`). Each is a percentage of the task's
  reservation. motir-infra turns Container Insights on for the core cluster
  whenever monitoring is on.
- **Event-loop delay, loop blocks and steal** are published by core itself as
  CloudWatch embedded-metric-format lines on stdout, in the namespace
  `Motir/Core`, with one dimension, `Service` (`web`, `worker` or `relay`):
  - `EventLoopDelayMaxMs` and `EventLoopDelayP99Ms`, every 60 s
    (`lib/monitoring/cloudwatchMetrics.ts`). The event-loop-block alarm reads
    the max.
  - `LoopBlockMaxMs` and `LoopBlockCount`, for each 60 s in which a block of
    1 s or more ended (`lib/monitoring/watchdogMetrics.ts`).
  - `CpuStealMs`, the CPU time stolen from the task in each 60 s, only where
    `MONITORING_CLOUDWATCH_STEAL` is on.

**CPU steal is readable on Fargate: `reported`.** The `/proc/stat` check
([MOTIR-9880](https://app.motir.co/items/MOTIR-9880)) read a live, non-zero
steal counter on a Fargate task (platform 1.4.0, kernel 6.1.188). So production
publishes `CpuStealMs` and alarms on it with `motir-<service>-steal`. Its 6000 ms
threshold is a starting point. That check found steal at 0.1–1.5 % of CPU on a
quiet host, which proves the signal exists but does not calibrate the threshold.

**Missing data is not a breach.** Every alarm treats missing data as not
breaching. The publishers write nothing for an interval with nothing to report:
no block ended, no delay sample, or a task that is stopped or deploying. Such an
interval must not page.

## The settings that switch publication on

Core publishes nothing to CloudWatch unless its environment sets:

| setting                           | value                                             |
| --------------------------------- | ------------------------------------------------- |
| `MONITORING_CLOUDWATCH_NAMESPACE` | the namespace, `Motir/Core` in production         |
| `MONITORING_CLOUDWATCH_SERVICE`   | the `Service` dimension: `web`, `worker`, `relay` |
| `MONITORING_CLOUDWATCH_STEAL`     | `true` to publish `CpuStealMs`                    |

All three are **unset by default**. With the namespace unset or blank, a local
or self-hosted build starts no timer and no watchdog thread, opens no port,
writes nothing and sends nothing (`tests/monitoring/monitoringUnsetGuarantee.test.ts`).
On AWS, motir-infra sets them on each watched service's task definition. The
`9091` metrics server that Fly scrapes is a separate setting
(`MONITORING_METRICS_PORT`) and keeps serving Fly unchanged
([request database timing](./request-db-timing.md)).

## Proving an alarm

Each alarm is proved by a real, bounded breach on a **rehearsal** service, never
by setting the alarm's state by hand. The core image carries the breach command
at `/app/breach/breach.mjs`:

```sh
node breach/breach.mjs <memory --percent N [--limit-mb N] | cpu | loop --block-ms N> [--seconds N]
```

- **The guard.** It does nothing unless `MOTIR_BREACH_ENABLED=true`. Without it,
  or with an unknown mode or flag, a missing required flag or an out-of-range
  value, it exits 2 with one line on stderr and does no work. No service ever
  starts it.
- **The bound.** Every mode runs for `--seconds` (default **300**, at most
  **900**; a larger value is refused, not clamped), then ends by itself with exit
  code 0, so the alarm returns to OK. A deadline 5 s past that bound ends the
  process whatever it holds.
- **The output.** It writes one JSON start line and one end line to stdout,
  which land in the task's log group.

Run it as a one-off ECS task of the rehearsal service's own task definition,
with a container override. The override sets the command, the guard and the
publication settings (namespace and the `Service` the alarm reads).
`--group service:<ecs service name>` files the task under that service in
Container Insights, which is where the memory and CPU alarms read. Scale the
rehearsal service to zero tasks first. Those two alarms read the service's
used-over-reserved across all its tasks, so an idle sibling task would dilute
the breach.

```sh
aws ecs run-task \
  --cluster <cluster> \
  --task-definition <rehearsal task definition> \
  --launch-type FARGATE \
  --group service:<ecs service name> \
  --network-configuration 'awsvpcConfiguration={subnets=[<private subnet>],securityGroups=[<service security group>],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"<container>","command":["node","breach/breach.mjs",<mode and flags>],"environment":[{"name":"MOTIR_BREACH_ENABLED","value":"true"},{"name":"MONITORING_CLOUDWATCH_NAMESPACE","value":"Motir/Core"},{"name":"MONITORING_CLOUDWATCH_SERVICE","value":"<service>"}]}]}'
```

`<container>` is the service's main container (`web`, `worker` or `relay`), and
`<service>` is the same name. Before reading the alarm, confirm in Container
Insights that the task appears under `ServiceName` `motir-core-<service>`.

### Memory — `motir-<service>-memory`

```json
"command": ["node", "breach/breach.mjs", "memory", "--percent", "90", "--seconds", "300"]
```

This grows the resident set in 16 MB steps to `--percent` of the task's memory
limit, then holds it. `--percent` is 1–95: the command never targets more than
95 %, because an out-of-memory kill would end the run without the clean OK.
The limit is the cgroup's. `--limit-mb` gives one where the cgroup sets none,
and when both exist the lower one wins. Use a percentage above the 85 %
threshold.

### CPU — `motir-<service>-cpu`

```json
"command": ["node", "breach/breach.mjs", "cpu", "--seconds", "420"]
```

This holds every CPU the task's quota allows, one busy thread per CPU, for the
whole run. The alarm needs 5 of 5 one-minute datapoints, so run for more than
five minutes; 420 s leaves room for the first datapoint.

### Event-loop block — `motir-<service>-event-loop-block`

```json
"command": ["node", "breach/breach.mjs", "loop", "--block-ms", "3000", "--seconds", "300"]
```

This starts the same two publishers the services run, then blocks the event
loop for `--block-ms` (100–20000) about every 5 s, with at least 1 s idle
between blocks so the publishers' timers run. Use a block above the 2000 ms
threshold. The task publishes `EventLoopDelayMaxMs` and `LoopBlockMaxMs` under
the `Service` its override sets. Steal is not breached here: the host, not the
task, causes it.

### What to expect, and how to read it

Each breach should produce this sequence: the alarm goes to **ALARM**, the topic
notifies its subscribers, and once the run ends the alarm returns to **OK** with
a second notification. Read the sequence back from the alarm's history:

```sh
aws cloudwatch describe-alarm-history \
  --alarm-name motir-<service>-<kind> \
  --history-item-type StateUpdate \
  --start-date <run start, ISO 8601> \
  --query 'AlarmHistoryItems[].[Timestamp,HistorySummary]' --output table
```

The breach's own start and end lines are in the task's log group
(`/motir/core/<service>`).
