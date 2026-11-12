# The load test — retired

motir-core's staging load-test harness (Story MOTIR-8538) is **retired**. It was
deleted by MOTIR-11141, as part of the Fly services decommission (Story
MOTIR-9716).

## Why it was retired

Every step of the harness ran on a platform the decommission removed:

- **The Fly staging app** (`motir-core-staging`), reached over Fly's private network — the
  private copy of production the load was driven against.
- **The Fly generator** (`motir-loadgen`), the Fly machine that ran k6.
- **The Neon branch** copied from production's Neon project, which the
  decommission deletes.
- **Fly's managed Prometheus**, the report's only source of platform readings,
  and Fly's command-line tool, which captured the app's logs.

With all four gone, the harness could not run anywhere. Its platform-neutral parts
— the k6 scenarios, the seed, the profile schema and the report rendering — were
retired with it: without the run command they had no entry point, and the report
pipeline read Prometheus throughout.

## Where the harness is last whole

The harness is complete, with its tests and its `package.json` scripts, at commit
**`1597dac98ad8d9e454e069833858cba7e7b5a99b`** on `main`. Read or restore any part
of it from there:

```sh
git show 1597dac98ad8d9e454e069833858cba7e7b5a99b:loadtest/README.md
```

```sh
git restore --source=1597dac98ad8d9e454e069833858cba7e7b5a99b -- loadtest/k6
```

## The reports in `loadtest/reports/`

`loadtest/reports/` holds the historical reports of the smoke runs against the Fly
staging app (2026-10-20 at one instance, 2026-10-22 at two). They are left exactly
as they were written: a record of what was measured on Fly, not a description of
any current system.

## The load test on AWS

The load test is still owed: production now runs on Fargate, and epic MOTIR-8536
still needs its baseline, sizing and closing measurements. Rebuilding it on AWS is
owned by Story **MOTIR-11142** — a staging copy of core's web and worker in the
AWS load-test account, k6 driven from a one-off Fargate task, and platform
readings from ECS and CloudWatch, restoring what it reuses from the commit above.
