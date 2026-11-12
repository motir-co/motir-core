# AWS alarms — memory, CPU, event-loop block and steal per service

The on-call engineer reads a breach from CloudWatch alarms and the SNS topic
they notify, and reads errors from Sentry, which stays the issue channel. Each
watched service has its own alarms: core's three (`web`, `worker`, `relay`) and
the AI side's five (`ai-conversation`, `ai-planning`, `gateway`, `gateway-run`,
`codegraph`). This page lists them, names the series each alarm reads, and gives
the breach that proves each core alarm fires.

The alarms are built by motir-infra (`lib/constructs/service-alarms.ts`), from
the `monitoring` block of its parameter file
(`lib/config/environments/production.ts`). This page copies the production
values as merged. When the parameter file changes, it wins.

## The alarms

No memory, CPU-steal or event-loop-block alert rule existed before these
alarms: the check that read the previous host's dashboards and Sentry on
2026-10-29 found none (MOTIR-9879; the previous host was Fly). So each
threshold below is a target the story stated, not a copy of an earlier rule.

Every alarm is named `<namePrefix>-<service>-<kind>`, so in production it is
`motir-web-memory`, `motir-worker-cpu`, `motir-relay-event-loop-block` and so on.
Each one notifies the SNS topic `motir-alarms` when it goes to ALARM and again
when it returns to OK. The topic is encrypted with the secrets-and-logs key, and
its subscribers are listed in the parameter file.

Core's three services carry four alarms each:

| alarm (per service)                | signal read                                 | threshold | period | datapoints to alarm |
| ---------------------------------- | ------------------------------------------- | --------- | ------ | ------------------- |
| `motir-<service>-memory`           | `AWS/ECS` `MemoryUtilization`, Maximum      | ≥ 85 %    | 60 s   | 2 of 3              |
| `motir-<service>-cpu`              | `AWS/ECS` `CPUUtilization`, Maximum         | ≥ 90 %    | 60 s   | 5 of 5              |
| `motir-<service>-steal`            | `Motir/Core` `CpuStealMs`, Maximum          | ≥ 6000 ms | 60 s   | 5 of 5              |
| `motir-<service>-event-loop-block` | `Motir/Core` `EventLoopDelayMaxMs`, Maximum | ≥ 2000 ms | 60 s   | 1 of 3              |

The AI side's five services carry memory and CPU alarms only, because their
images run none of core's publishers; `codegraph` also carries the graph
service's two alarms (MOTIR-10273). No rule existed for any of them before
either, so each threshold is a target:

| AWS alarm                            | services                                                   | signal read                                      | threshold | period | datapoints to alarm |
| ------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------ | --------- | ------ | ------------------- |
| `motir-<service>-memory`             | `ai-conversation`, `ai-planning`, `gateway`, `gateway-run` | `AWS/ECS` `MemoryUtilization`, Maximum           | ≥ 85 %    | 60 s   | 3 of 5              |
| `motir-codegraph-memory`             | `codegraph`                                                | `AWS/ECS` `MemoryUtilization`, Maximum           | ≥ 90 %    | 60 s   | 3 of 5              |
| `motir-<service>-cpu`                | all five                                                   | `AWS/ECS` `CPUUtilization`, Maximum              | ≥ 90 %    | 60 s   | 8 of 10             |
| `motir-codegraph-graph-read-latency` | `codegraph`                                                | `Motir/Core` `GraphReadP95Ms`, Maximum           | > 300 ms  | 600 s  | 1 of 1              |
| `motir-codegraph-graph-memory`       | `codegraph`                                                | `Motir/Core` `GraphMemoryLowestPercent`, Maximum | > 80 %    | 600 s  | 1 of 1              |

The targets these numbers implement:

- **Memory** alarms below the out-of-memory kill, so there is time to act before
  ECS kills the task.
- **CPU** alarms at sustained saturation of the task's reservation: five minutes
  at 90 % or more on core's services, and eight minutes of ten on the AI side's.
- **Event-loop block** alarms on one block of 2 s or more, well under the 5 s
  interactive-transaction timeout that a P2028 marks.
- **Steal** alarms on CPU taken by the host. On 2026-10-15, that starvation
  showed up as a 17 s event-loop freeze and P2028s. Only five straight minutes
  alarm: Fargate steal is spiky, and 3 of 5 fired on harmless spikes
  (MOTIR-10732).

## The series each alarm reads

- **Memory and CPU** are ECS's own service metrics, `MemoryUtilization` and
  `CPUUtilization` in the namespace `AWS/ECS`, with the dimensions
  `ClusterName` (`motir-core`) and `ServiceName`: `motir-core-<service>` for
  core's three, and `motir-ai-conversation`, `motir-ai-planning`,
  `motir-gateway`, `motir-gateway-run` and `motir-codegraph` for the AI side.
  ECS publishes them for every service at no charge, each already a percentage
  of what the task definition reserves. They count only the tasks the service
  owns, the ones its scheduler started. The alarms read the **Maximum**, which
  is the one task with the highest utilization, so a busy task alarms whatever
  its siblings do
  ([ECS service utilization](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_utilization.html)).
  Container Insights is off in production, MOTIR-10892 (the parameter
  `containerInsights` is `false`): nothing reads its paid per-task series, so
  `ECS/ContainerInsights` holds nothing for these services.
- **Event-loop delay, loop blocks and steal** are published by core itself as
  CloudWatch embedded-metric-format lines on stdout, in the namespace
  `Motir/Core`, with one dimension, `Service` (`web`, `worker` or `relay`):
  - `EventLoopDelayMaxMs` and `EventLoopDelayP99Ms`, every 60 s
    (`lib/monitoring/cloudwatchMetrics.ts`). The event-loop-block alarm reads
    the max. The first 60 s after a process starts is not published: a web
    task's boot stalls its loop for 2–2.5 s while Next loads its routes, and
    publishing that minute fired the alarm on every deploy (MOTIR-10141). A
    task's first line therefore comes about two minutes after it starts.
    A module graph that first loads on a live request blocks the loop in
    whichever minute it lands, so the web task's readiness check
    (`/api/health/ready`, the target group's health check) warms both of Next's
    server runtimes before the task takes traffic: it loads the webhook route's
    graph in the route-handler runtime (MOTIR-8231) and renders
    `/health/warm-up` over loopback, which loads the pages graph and its editor
    in the page runtime (MOTIR-10142).
  - `LoopBlockMaxMs` and `LoopBlockCount`, for each 60 s in which a block of
    1 s or more ended (`lib/monitoring/watchdogMetrics.ts`).
  - `CpuStealMs`, the CPU time stolen from the task in each 60 s, only where
    `MONITORING_CLOUDWATCH_STEAL` is on.
- **The graph series** are published by motir-ai's graph service
  (`src/capacityAlerts/graphCloudWatchMetrics.ts`) in the same way, in
  `Motir/Core` with `Service` `codegraph`, once per 10-minute window it judges:
  `GraphReadP95Ms`, the service-wide read p95, and `GraphMemoryLowestPercent`,
  each machine's lowest memory ratio over the window. They alarm above the
  levels motir-ai's own alerts use.

**CPU steal is readable on Fargate: `reported`.** The `/proc/stat` check
([MOTIR-9880](https://app.motir.co/items/MOTIR-9880)) read a live, non-zero
steal counter on a Fargate task (platform 1.4.0, kernel 6.1.188). So production
publishes `CpuStealMs` and alarms on it with `motir-<service>-steal`. Its 6000 ms
threshold is a starting point. That check found steal at 0.1–1.5 % of CPU on a
quiet host, which proves the signal exists but does not calibrate the threshold.
The window was calibrated later: the worker's one-minute p99.9 was 10190 ms over
2026-11-01 to 2026-11-08, so the alarm needs 5 of 5 datapoints (MOTIR-10732).

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
metrics server is a separate setting: `MONITORING_METRICS_PORT` opens it, and
motir-infra sets it on the web task only, so the request-timing collector beside
that task can scrape `/metrics` over the task's loopback
([request database timing](./request-db-timing.md)). Nothing else sets it.

## Proving an alarm

Each alarm is proved by a real, bounded breach, never by setting the alarm's
state by hand. The core image carries the breach command
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
- **The output.** It writes one JSON start line and one end line to stdout:
  into the task's log group when it is a one-off task's command, into the
  session when it runs over ECS Exec.

### Where a breach is counted

The alarms read two kinds of series, and a breach is counted in each by a
different rule, so the venue depends on the alarm:

- **Event-loop block** reads `Motir/Core`, where a task publishes under the
  `Service` its environment names. A one-off ECS task publishes under the
  `Service` its container override sets, so `aws ecs run-task` proves it
  (below).
- **Memory and CPU** read `AWS/ECS`, which counts only the tasks a service owns.
  AWS defines the service's `CPUUtilization` and `MemoryUtilization` over "the
  tasks that belong to the service", reported for "each running task owned by
  the service"
  ([ECS CloudWatch metrics](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/available-metrics.html),
  [ECS service utilization](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_utilization.html)).
  A service owns the tasks its scheduler starts, whose `startedBy` is the
  service's deployment ID. `run-task` starts a standalone task, and its
  `--group` is a free label (by default `family:<task definition family>`)
  that does not make the service own it
  ([`RunTask`](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html)).
  So a breach in a one-off task, `--group service:<name>` or not, is counted
  in no service's `AWS/ECS` series and cannot fire these alarms. The group
  mattered only to Container Insights, which production no longer runs. The
  memory and CPU breach therefore runs inside a running task of the service,
  over ECS Exec (below).

ECS Exec is on for core's three services and off for the AI side's, whose
images carry no breach command either. So this page proves core's alarms; the
AI side's memory and CPU alarms have no breach procedure.

### Memory and CPU — inside a task the service owns

Pick one running task of the service, and run the breach in its main container
with the guard set on that command only:

```sh
aws ecs list-tasks --cluster motir-core --service-name motir-core-<service> --desired-status RUNNING
```

```sh
aws ecs execute-command \
  --cluster motir-core \
  --task <task id> \
  --container <service> \
  --interactive \
  --command "env MOTIR_BREACH_ENABLED=true node /app/breach/breach.mjs <mode and flags>"
```

`<service>` is `web`, `worker` or `relay`, which is also the container's name.
Keep the session open until the end line prints: the breach is a child of the
session. Its start and end lines print there, not in the task's log group.

The breach shares the task with live traffic for its whole run, so choose the
service and the time accordingly. Prefer `worker` or `relay`: a `web` task that
stops answering its load-balancer health check is replaced, which ends the run
early. Because the alarms read the Maximum, the busiest task decides, and the
service's other tasks need not be stopped.

**Never point the service at a breach revision.** The guard is set only on the
breach's own command, by a container override or an exec command, and the
service's own revision is never edited. So a core deploy that runs during the
breach rolls the service, ending a breach in one of its tasks, and leaves a
one-off task alone. A
hand-registered revision that sets `MOTIR_BREACH_ENABLED`, with the service
pointed at it, is what a deploy would copy into the service's next release. The
deploy refuses such a service rather than copy it (MOTIR-10093,
[the AWS deploy](../aws-deploy.md)), so that route also blocks every core
deploy until the service is pointed back.

### Memory — `motir-<service>-memory`

```sh
--command "env MOTIR_BREACH_ENABLED=true node /app/breach/breach.mjs memory --percent <N> --seconds 300"
```

This grows the resident set in 16 MB steps to `--percent` of the task's memory
limit, then holds it. `--percent` is 1–95: the command never targets more than
95 %, because an out-of-memory kill would end the run without the clean OK.
The limit is the cgroup's. `--limit-mb` gives one where the cgroup sets none,
and when both exist the lower one wins. `--percent` counts only the breach's own
memory, and the service's process beside it already holds some. So read the
service's `MemoryUtilization` Maximum first (`m`, in percent) and choose `N`
above `85 − m` and at most `95 − m`: the task crosses the 85 % threshold and
stays clear of its limit.

### CPU — `motir-<service>-cpu`

```sh
--command "env MOTIR_BREACH_ENABLED=true node /app/breach/breach.mjs cpu --seconds 420"
```

This holds every CPU the task's quota allows, one busy thread per CPU, for the
whole run, so the task's utilization reaches the reservation whatever the
service's process is doing. The alarm needs 5 of 5 one-minute datapoints, so run for more than
five minutes; 420 s leaves room for the first datapoint.

### Event-loop block — `motir-<service>-event-loop-block`

This one runs as a one-off ECS task of the service's own task definition, with
a container override. The override sets the command, the guard and the
publication settings: the namespace, and the `Service` the alarm reads. The task
is counted under that `Service` in `Motir/Core` whichever group it is in, so no
`--group` is needed, and the service's own tasks keep serving.

```sh
aws ecs run-task \
  --cluster motir-core \
  --task-definition <the service's task definition> \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[<private subnet>],securityGroups=[<service security group>],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"<service>","command":["node","breach/breach.mjs",<mode and flags>],"environment":[{"name":"MOTIR_BREACH_ENABLED","value":"true"},{"name":"MONITORING_CLOUDWATCH_NAMESPACE","value":"Motir/Core"},{"name":"MONITORING_CLOUDWATCH_SERVICE","value":"<service>"}]}]}'
```

The mode and flags:

```json
"command": ["node", "breach/breach.mjs", "loop", "--block-ms", "3000", "--seconds", "300"]
```

This starts the same two publishers the services run, then blocks the event
loop for `--block-ms` (100–20000) about every 5 s, with at least 1 s idle
between blocks so the publishers' timers run. Use a block above the 2000 ms
threshold. The task publishes `EventLoopDelayMaxMs` and `LoopBlockMaxMs` under
the `Service` its override sets. Its first minute of delay is not published (the
boot rule above), so the first breaching datapoint covers the second minute and
the alarm goes to ALARM about three minutes after the task starts. Steal is not breached here: the host, not the
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

The event-loop breach's own start and end lines are in the task's log group
(`/motir/core/<service>`); the memory and CPU breaches print theirs in the exec
session.
