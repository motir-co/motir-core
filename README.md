# motir-core

Open-source PM substrate for **Motir** — an AI-native project management tool
for small startup teams. The user describes what they want to build; Motir
produces a structured Epic → Story → Subtask tree; coding agents execute the
Subtasks one at a time using prompts Motir generates.

## Open source

`motir-core` is **open source under the GPL-3.0 license** (see [LICENSE](LICENSE)).
This repo is the **PM substrate**: Work Items, Stories, dependency graph,
multi-tenant workspaces, projects, the tree-view UI, GitHub integration, the
human-todo queue, the delivery agent. The kind of thing Jira and Linear are,
but open and AI-native.

The **closed-source planning intelligence** — the planner agent, prompt
generation, async-expansion loop, shared-context retrieval — ships separately
as the proprietary [`motir-ai`](https://github.com/moooon-B-V/motir-ai) service.
It runs headless and is called server-to-server by `motir-core`. Browsers
never talk to `motir-ai` directly, so the user experience stays unified
(one app, one domain, one cookie) and the GPL boundary stays clean (a network
service interface is not a derivative work).

See `vision.html` principle #19 and `feasibility.html` ADR-008 in the planning
docs for the open-core architecture rationale. This split follows the same
playbook as GitLab, Sentry, Plane, and Mattermost.

> **Rename interim**: these repos are being renamed from their pre-rebrand
> `prodect-*` names to `motir-core` / `motir-ai`. GitHub redirects the old
> repo URLs automatically, so existing clones, remotes, and links keep
> working; update remotes with `git remote set-url` at leisure. (Vercel does
> NOT redirect — the `*.vercel.app` URLs below apply once the Vercel project
> rename lands.)

## Stack

- **Runtime**: [Node.js](https://nodejs.org) ≥22 (pnpm 11 requires it)
- **Framework**: [Next.js 16](https://nextjs.org) (App Router, React Server Components, Turbopack)
- **Language**: [TypeScript](https://www.typescriptlang.org) (strict mode; `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com)
- **Persistence**: [Postgres 18](https://www.postgresql.org) with pgvector — production's major (local Docker; host port `5433` to coexist with other local Postgres instances) + [Prisma 7](https://www.prisma.io) with [`@prisma/adapter-pg`](https://www.npmjs.com/package/@prisma/adapter-pg). Connection URL lives in [`prisma.config.ts`](prisma.config.ts) (Prisma 7 split it out of `schema.prisma`).
- **Auth**: NextAuth / Better-Auth (lands in Story 1.1 — not yet present)
- **Testing**: [Vitest](https://vitest.dev) unit + [Playwright](https://playwright.dev) e2e (scaffolding lands in later Subtasks)
- **Lint / format**: [ESLint 9](https://eslint.org) (flat config) + [Prettier 3](https://prettier.io). [Husky](https://typicode.github.io/husky) pre-commit hook runs [lint-staged](https://github.com/lint-staged/lint-staged) to auto-fix staged files on every commit.
- **Package manager**: [pnpm](https://pnpm.io) (version pinned via `packageManager` in `package.json`; use `corepack enable`)
- **Deploy**: [Vercel](https://vercel.com) (lands in Subtask 1.0.5)
- **CI**: [GitHub Actions](https://docs.github.com/actions) — three parallel jobs (lint, typecheck, build) on every PR; build runs against a Postgres container started by the `.github/actions/postgres` composite action

This Stack section is the **authoritative reference** for every later coding-agent
prompt. Motir's planner (Epic 4) reads it verbatim into Subtask prompts so
generated code matches the project's actual stack.

## Local setup

Prerequisites: [Node 22+](https://nodejs.org), [Docker](https://www.docker.com) or
[OrbStack](https://orbstack.dev), [pnpm](https://pnpm.io) (`corepack enable`
will handle this).

```bash
cp .env.example .env       # creates the dev DATABASE_URL
pnpm install               # installs deps + sets up husky pre-commit hook
./scripts/db-up.sh         # starts Postgres in Docker and applies migrations
pnpm dev                   # http://localhost:3000
```

You should see a placeholder "Motir" page on a dark theme — not the default
`create-next-app` welcome page.

### Coming from the PostgreSQL 16 dev database

The dev database runs PostgreSQL 18, production's major (MOTIR-10221). A 16 data
directory cannot start under 18, so `docker-compose.yml` uses a new volume,
`prodect-pg18-data`, and `./scripts/db-up.sh` initialises it empty. Your old
`prodect-pg-data` volume is left as it was. List it with:

```bash
docker volume ls --filter name=prodect-pg-data
```

**Start fresh (recommended).** Dev data is reproducible with `pnpm db:seed` /
`pnpm db:seed:large`. Once you no longer need the old data, remove the old
volume, using the name the command above printed:

```bash
docker volume rm motir-core_prodect-pg-data
```

**Keep the data.** Dump it while the 16 container still runs, _before_ you pull
this change (or check out an older commit and run `docker compose up -d postgres`
there first):

```bash
docker exec prodect-postgres pg_dumpall -U prodect > prodect-pg16.sql
```

Then, on this change, start the empty 18 database, load the dump and finish the
setup:

```bash
docker compose rm -sf postgres && docker compose up -d postgres
```

```bash
docker exec -i prodect-postgres psql -q -U prodect -d postgres < prodect-pg16.sql
```

```bash
./scripts/db-up.sh
```

The load reports `role "prodect" already exists` and `database "prodect" already
exists`. Those are expected, because the container creates both at first boot.

### Scripts

| Script               | What it does                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`           | Start the dev server on `localhost:3000`                                                                                                                                                                                                                           |
| `pnpm build`         | Production build (must pass with 0 warnings)                                                                                                                                                                                                                       |
| `pnpm start`         | Start the production server                                                                                                                                                                                                                                        |
| `pnpm lint`          | Run ESLint                                                                                                                                                                                                                                                         |
| `pnpm format`        | Run Prettier and write fixes in place                                                                                                                                                                                                                              |
| `pnpm format:check`  | Run Prettier in check mode (used by CI)                                                                                                                                                                                                                            |
| `pnpm typecheck`     | Run `tsc --noEmit`                                                                                                                                                                                                                                                 |
| `pnpm db:seed:large` | Seed a real-scale demo project (~2,000 issues, deep tree) so the `/issues` List pagination + lazy/virtualized Tree are visible at scale. Idempotent; prints a sign-in. Tune via `SEED_ROOTS` / `SEED_BIG_CHILDREN` / `SEED_SMALL_CHILDREN` / `SEED_DEEP_CHILDREN`. |

## Project layout

```
app/          Next.js App Router routes
components/   React UI primitives (filled in Story 1.0.5)
lib/          Server-side logic (DB, auth, agents). `lib/db.ts` exports the
              singleton PrismaClient with the dev-mode hot-reload guard.
prisma/       Prisma schema + migrations. Real models (User, Workspace,
              WorkItem) land in Stories 1.1 / 1.2 / 1.4. Current placeholder
              `MigrationMarker` exists only to prove the migration system works.
tests/        Vitest unit + Playwright e2e (scaffolding lands in later Subtasks)
docs/         Project docs. Design system lands here in Story 1.0.5.
scripts/      Dev-loop scripts. `db-up.sh` brings up Postgres + runs migrations.
public/       Static assets
.github/
  workflows/  CI definitions (see Testing below)
```

## Agent dispatch (BYOK)

Motir exposes a stable agent contract so you can drive your own coding agent
(Claude Code / Cursor / Aider / your own script) against the project's ready
set — the work items whose blockers have all landed, so they're safe to start:

- `GET /api/ready?projectKey=ACME` — list every ready work item.
- `POST /api/ready/next` with body `{ "projectKey": "ACME", "kinds": ["subtask"] }` —
  get ONE item to run next, including its full description + context-file
  references. Pass `"excludeIds": [...]` across calls to walk the set.

The session cookie is the auth surface; use the same login flow your browser
does.

The `/ready` page is the human mirror of `/api/ready` — anything an agent
sees, a planner can see.

## Testing

CI runs on every PR and push to `main` via [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
Three parallel jobs:

- **Lint** — `pnpm lint` + `pnpm format:check`
- **TypeScript** — `pnpm prisma generate` then `pnpm typecheck`
- **Build** — `pnpm prisma migrate deploy` then `pnpm build`, against a
  Postgres 18 container (started by `.github/actions/postgres`, which pulls the
  image mirror-first and retries — a `services:` block cannot, MOTIR-1742)

The full suite targets <3 min on a fresh clone. The pre-commit hook (Husky +
lint-staged) catches lint/format issues before they reach CI; CI is the
backstop, not the primary gate.

Unit + e2e test scaffolding (Vitest, Playwright) lands in later Subtasks.

## Deploys

Production runs on AWS: core's web, worker and relay services on ECS Fargate,
with its PostgreSQL database on Amazon RDS and its stored files on Amazon S3. The
infrastructure is motir-infra's CDK app; [`docs/aws-deploy.md`](./docs/aws-deploy.md)
is the release lane in full.

- **Production**: every push to `main` runs
  [`.github/workflows/aws-deploy.yml`](.github/workflows/aws-deploy.yml),
  which builds the image from the `Dockerfile`, pushes it to ECR and runs
  `pnpm deploy:aws` with its digest: the migrate task runs first, then web,
  worker and relay roll. The app answers at <https://app.motir.co>.
- **Rollback**: a failed roll leaves the previous tasks serving. To go back
  to an earlier release on purpose, revert the change on `main`; the next
  deploy ships the revert.
- **Env vars**: each service's task definition carries its environment, and
  its secrets come from AWS Secrets Manager. `DATABASE_URL` is the runtime
  connection; `DATABASE_URL_UNPOOLED` is the direct connection
  `prisma migrate deploy` uses. Never commit secrets to git. `.env.example`
  documents what's needed locally.
- **Service-to-service tokens (open-core boundary)**: `motir-ai` calls
  `motir-core` over a shared bearer. `MOTIR_AI_TO_CORE_SERVICE_TOKEN`
  authenticates the inbound billing-propagation route
  (`POST /api/internal/billing/scaled-tracker-state`, Subtask 8.1.4c) — the
  same secret is set on `motir-ai`'s `coreClient` (8.1.4d). It must match on
  both sides; the route fails CLOSED (rejects every request) when it is unset.
  Stripe secrets never enter `motir-core` — only this plain propagated state
  crosses the boundary.

## Docs

- [`docs/cli.md`](./docs/cli.md) — the `motir` CLI guide: install, authenticate,
  link a workspace, the work loop (`next` / `run` / `auto` / `batch` / `done`),
  terminal planning (`plan`), session-branch semantics, agent wiring, the
  sandbox, and troubleshooting.
- [`docs/mcp.md`](./docs/mcp.md) — the MCP server: minting a personal access
  token, token scopes, wiring an agent, and the full tool catalog.
- [`docs/approval-gates.md`](./docs/approval-gates.md) — approval gates: when
  Motir asks a person to say yes, what Approve and Request changes each do, who
  is asked versus who may answer, what an approval keeps, and what has not
  shipped yet.
- [`loadtest/README.md`](./loadtest/README.md) — the retired load test: why
  the Fly-bound harness was removed, the commit where it is last whole, and the
  historical Fly staging reports kept in `loadtest/reports/`. The load test on
  AWS is Story MOTIR-11142's.
- [`docs/design-system.md`](./docs/design-system.md) — canonical reference
  for using the design system: tokens, primitives, patterns, voice & tone,
  don'ts. Read this when building any UI.
- [`docs/DESIGN.md`](./docs/DESIGN.md) — architectural spec of the design
  system: token taxonomy, palette/typography/spacing rules, component
  implementation notes.
- [`/tokens`](./app/tokens/page.tsx) — live specimen route. Visit
  `localhost:3000/tokens` to see every token + primitive rendered with
  interactive theme + display-style toggles.
- **Planning corpus** (sibling to this repo, not inside it): `vision.html` for
  the 19 design principles, `feasibility.html` for ADRs (incl. ADR-008 on
  open-core), `discovery.html` / `validation.html` / `workflow.html` for
  product context, `prodect_plan.html` + `prodect_plan/` for the Epic-Story-
  Subtask build plan, `notes.html` for the running mistakes-log + lessons.

## License

[GPL-3.0-only](LICENSE). The planning intelligence ships separately under a
proprietary license in [`moooon-B-V/motir-ai`](https://github.com/moooon-B-V/motir-ai).
See `feasibility.html` ADR-008 in the planning docs for the open-core split
rationale.
