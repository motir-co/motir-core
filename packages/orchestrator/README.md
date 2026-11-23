# `@motir/orchestrator`

The **container-orchestrator port** for Motir's CI runner fleet, plus its two adapters.
Extracted from `motir-core`'s `lib/orchestrator/` by MOTIR-4299 under
[`docs/decisions/app-shell-over-packages.md`](../../docs/decisions/app-shell-over-packages.md);
the port itself is decided in
[`docs/decisions/ci-runner-fleet.md`](../../docs/decisions/ci-runner-fleet.md) §3–§4.

Private to this repository. One consumer: the app.

## What it exports

- **The port** — `ContainerOrchestrator`, `ContainerHandle`, `ContainerSpec`,
  `ContainerUsage`, `ContainerAccrual`, `UsageAttribution`, `FleetWorkloadKind`, and the
  typed errors.
- **The adapters** — `flyOrchestrator` (Fly Machines) and `fakeOrchestrator` (the in-process
  double the test suites and the fleet story gate select), plus the Fly config accessors the
  app's selector reads.
- **The cost model** — `resolveContainerRate`, `FLEET_CONTAINER_SIZE`, `buildContainerUsage`,
  `billableSecondsFor`, `isUnpriced`.
- **The usage sink FACTORY** — `createUsageSink(meter)`.
- **The image-pull probe** — `probeImagePull` and its parsers.

Everything is reached through the package's barrel. There is no deep-import path, and
`tests/packages/importDirection.test.ts` in the app asserts that in both directions.

## What the APP must inject

The package binds nothing. Its composition root is `lib/orchestrator/index.ts` in the app,
which does three things and nothing else:

| the app supplies                                                                                      | why it cannot live here                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **the adapter choice** — `getOrchestrator()` reads `MOTIR_FLEET_ORCHESTRATOR` and the Fly credentials | it is a fact about a DEPLOYMENT, not about the port. A self-hosted `motir-core` must boot with no fleet credentials at all                                    |
| **a `UsageMeter`** — `createUsageSink(ciFleetCostMeterService)`                                       | persisting a cost record needs the app's database, its tenancy and its schema. The port fixes the FIELDS; the meter owns the SCHEMA (`ci-runner-fleet.md` §5) |
| **the container-fleet config** — `hostedAgentFleetConfig()`                                           | same reason as the first: it reads this deployment's environment for a digest-pinned image                                                                    |

## What it may NOT depend on

No `@/…` import, no Prisma client, no `@motir/*` sibling's internals. Money arithmetic uses
`decimal.js` directly — the same library Prisma's `Decimal` is, so the numbers and the
`toFixed()` strings are identical and the package stays Prisma-free.

## Running it

```
pnpm --filter @motir/orchestrator typecheck   # tsc -b, the composite project the root solution references
pnpm --filter @motir/orchestrator build       # tsup → dist/
pnpm --filter @motir/orchestrator test        # its own vitest suite; `-- --coverage` for the ≥90 per-file floor
```

`ci.yml`'s `orchestrator` job runs all three. `pnpm typecheck` at the repository root builds
this project too, through `tsconfig.solution.json`.
