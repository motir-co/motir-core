# syntax=docker/dockerfile:1
#
# motir-core on Fly.io — the production image (MOTIR-2387).
#
# ── Why this shape ──────────────────────────────────────────────────────────
# `next build` with `output: 'standalone'` traces the whole app ONCE and emits a
# self-contained server with a minimal node_modules. Every route shares that one
# process, so a heavy dependency is resident once rather than copied per route —
# which is the entire reason the Vercel build exhausted its packaging disk
# (MOTIR-2371: Prisma's 4.9 MB WASM compiler x 490 bundles). The decision and its
# measurements are `docs/decisions/application-hosting.md` Q1; the spike that
# produced them is MOTIR-2383.
#
#   standalone server   124 MB  (was 381→135 MB, pruned in the builder; MOTIR-3219
#                                removed the sweep that made a prune necessary)
#   static assets         7 MB
#   against Vercel    4,240 MB  traced across 490 function bundles
#
# The builder step below is an ASSERTION now, not a prune, and it is still a
# Dockerfile step rather than `next.config.ts`'s `outputFileTracingExcludes`
# because that key is inert under Turbopack — see the comment on the RUN below,
# MOTIR-2403 for the inert key, and MOTIR-3219 for why nothing needs pruning.
#
# ── Multi-stage, and why the builder is fat ─────────────────────────────────
# The builder needs the FULL dependency set: `postinstall` runs `prisma generate`
# and builds @motir/design-system, and `next build` needs devDependencies. The
# runner takes only the standalone output plus the migration toolchain below, so
# none of the builder's tree reaches the shipped image.

# ── deps ────────────────────────────────────────────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable
# openssl: Prisma's client probes for it at generate time even on the WASM path.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# `pnpm-workspace.yaml`'s patchedDependencies are applied AT install, so the patch
# files must be here before it (MOTIR-5255 — the vendored react-dom ping fix;
# `tests/react-dom-ping-patch.test.ts` pins this line).
COPY patches ./patches
COPY packages/design-system/package.json packages/design-system/
COPY packages/cli/package.json packages/cli/
COPY prisma ./prisma
# --ignore-scripts here: postinstall needs the full source tree (it builds the
# design-system package), which is not copied yet. It runs in the builder below.
RUN pnpm install --frozen-lockfile --ignore-scripts

# ── build ───────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/design-system/node_modules ./packages/design-system/node_modules
COPY . .
# `prisma generate` + the design-system build, the two things postinstall does.
RUN pnpm prisma generate \
 && pnpm --filter @motir/design-system build
# ⚠️ `next build`, NOT `pnpm build`. The `build` script is
# `prisma generate && node scripts/migrate-deploy.mjs && next build` — it applies
# MIGRATIONS, because on Vercel the build was the only deploy hook there was.
# Here it is not: Fly's release_command owns migrations (fly.toml), and running
# them during an image build would fail the build outright (no DATABASE_URL is
# set at build time, by design) or, worse, migrate whatever database the builder
# could reach. `prisma generate` is already done, one step up.
#
# ⚠️ DATABASE_URL IS READ AT BUILD TIME TOO — not only at runtime, which is what
# this comment used to claim and what cost the first deploy (MOTIR-2490). Next's
# page-data collection EVALUATES each route's module graph, so a route that
# imports `@/lib/auth` or a service reaches `lib/db.ts` and its module-load
# `requiredEnv('DATABASE_URL')`, which throws before any request exists.
# `app/(public)/p/[identifier]/opengraph-image.tsx` is one such route, and the
# build died on it with "Failed to collect page data".
#
# It never surfaced on Vercel because every build there ran with the project's
# real environment. This image is the first build in the repo's history that
# runs without one — and NOTHING in PR CI builds it, so the post-merge deploy is
# where a regression here shows up.
#
# The placeholders below exist ONLY to satisfy those module-load checks. Nothing
# connects to them: the routes collected here are dynamic (no
# generateStaticParams), so no query runs at build time. `runner` is a separate
# FROM, so none of this reaches the running image — the real values arrive as Fly
# secrets at runtime.
#
# They are set HERE rather than left to next.config.ts's seeding, which is
# guarded by `NODE_ENV !== 'production'` — a condition an image build does not
# reliably satisfy. Depending on that guard is what produced MOTIR-2490.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" \
    DATABASE_URL_UNPOOLED="postgresql://build:build@127.0.0.1:5432/build" \
    GOOGLE_CLIENT_ID="build-time-placeholder-client-id" \
    GOOGLE_CLIENT_SECRET="build-time-placeholder-client-secret" \
    BETTER_AUTH_SECRET="build-time-placeholder-secret-32-bytes-minimum"
ENV NEXT_TELEMETRY_DISABLED=1

# ── the BUILD-TIME configuration seam (MOTIR-1162) ──────────────────────────
# ⚠️ THIS BLOCK EXISTS BECAUSE A `NEXT_PUBLIC_*` VALUE IS NOT A RUNTIME VALUE.
# `next build` SUBSTITUTES it into the JavaScript sent to the browser, so a Fly
# runtime secret set afterwards is invisible to it. Wiring the browser half of
# error monitoring to a Fly secret would produce something that reviews cleanly,
# tests green, and never reports a single client-side error — which is exactly
# why MOTIR-1161 handed each value over labelled with which of the two homes it
# belongs in, and why this file had ZERO `ARG`s until this card.
#
# The GENERAL shape, not a Sentry special case: any future build-time value —
# MOTIR-1163 was the next candidate before it settled on a runtime one — adds an
# `ARG`/`ENV` pair here and a `--build-arg` in `ci.yml`'s deploy step. Nothing
# else needs to change.
#
# EVERY ONE OF THESE IS OPTIONAL AND DEFAULTS TO EMPTY. A `docker build` with no
# `--build-arg` — a self-hoster's, or anyone's local one — produces an image
# with monitoring disabled, which is the self-host contract from the card. The
# empty defaults are what make that true without a second code path.
#
# ⚠️ THE AUTH TOKEN IS A SECRET AND IS DELIBERATELY *NOT* HERE. A `--build-arg`
# value is recorded in the build's own metadata; a credential goes in through
# `--mount=type=secret` on the RUN below, where it exists for one command and is
# never written to a layer. `flyctl deploy --build-secret` is the other half.
ARG NEXT_PUBLIC_SENTRY_DSN=""
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT=""
ARG MOTIR_RELEASE=""
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_SENTRY_ENVIRONMENT=$NEXT_PUBLIC_SENTRY_ENVIRONMENT \
    MOTIR_RELEASE=$MOTIR_RELEASE \
    SENTRY_ORG=$SENTRY_ORG \
    SENTRY_PROJECT=$SENTRY_PROJECT

# ── the SERVER-ACTION SALT (MOTIR-3948) ─────────────────────────────────────
# ⚠️ THIS ONE IS WHY AN OPEN TAB STOPS BEING ABLE TO WRITE AFTER A DEPLOY.
# Next hashes every Server Action id with the build's `encryptionKey`
# (`serverReferenceHashSalt`, `next/dist/build/webpack-config.js`), and generates
# that key RANDOMLY PER BUILD unless `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is set
# (`next/dist/build/index.js` → `encryption-utils-server.js`). So without a pinned
# value every release re-salts every id: a browser holding the previous build's
# JavaScript posts ids this build has never heard of, the server answers 404
# `x-nextjs-action-not-found`, and every write from that tab fails until it is
# reloaded. Measured on this repo: three builds of one commit, three different
# ids for the same exported action.
#
# It is a BUILD-time value, not a runtime one — the salt is baked into the client
# bundle and into `server-reference-manifest.json` — and the RUNTIME reads it back
# out of that manifest (`encryption-utils.js`: `process.env.NEXT_SERVER_ACTIONS_
# ENCRYPTION_KEY || serverActionsManifest.encryptionKey`). So there is deliberately
# NO Fly runtime secret for it: a runtime value that disagreed with the baked one
# would break decryption of every bound argument instead of fixing anything.
#
# It goes in as a build SECRET rather than an `ARG` for the reason the block above
# states — it encrypts the arguments closed over by server actions, and a
# `--build-arg` is recorded in the build's metadata. `ci.yml`'s deploy step is the
# other half, and it REFUSES to release without it.
#
# Both secrets are mounted for THIS command only. `|| true` on each read is
# deliberate: with no secret mounted the file does not exist, the variable stays
# empty, and the build proceeds — source-map upload disabled, salt back to
# per-build random. That is the self-host path, unchanged and unbroken by either.
# Read `set -eu` as covering everything after it.
RUN --mount=type=secret,id=SENTRY_AUTH_TOKEN \
    --mount=type=secret,id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY \
    set -eu; \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/SENTRY_AUTH_TOKEN 2>/dev/null || true)"; \
    export SENTRY_AUTH_TOKEN; \
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/NEXT_SERVER_ACTIONS_ENCRYPTION_KEY 2>/dev/null || true)"; \
    export NEXT_SERVER_ACTIONS_ENCRYPTION_KEY; \
    NODE_OPTIONS=--max-old-space-size=6144 pnpm exec next build

# ⚠️ THE HEAP CEILING ABOVE MUST TRACK `package.json`'s `build` SCRIPT, and the
# reason it is repeated rather than inherited is this line: the image runs
# `next build` DIRECTLY, so the ceiling set inside that script never reaches it.
#
# `next build` compiles and then runs TypeScript in a build worker, and node 22's
# default old-space (~4.1GB) does not hold both — the compile succeeds, the check
# starts, and the worker dies with SIGABRT naming nothing. It is not one bad
# type: measured on one box, `tsc --noEmit --extendedDiagnostics` reported 5.36GB
# on `main` against 5.54GB with MOTIR-1789 on top, a 3.4% delta. The tree had
# grown to the edge and a story crossed it.
#
# ⚠️ AND THIS IMAGE IS NOT BUILT ON A PULL REQUEST. `Deploy to Fly` is
# `main`-push only, so the branch that raises the ceiling everywhere else goes
# green with this path never exercised, and the OOM lands on the DEPLOY instead —
# after the pull request merged clean. That gap is why the value is duplicated
# here deliberately rather than left for whoever next reads a red deploy.

# ── the worker bundle (MOTIR-3421) ──────────────────────────────────────────
# The `worker` process group in fly.toml runs the Postgres job engine's claim
# loop. It CANNOT be run from source in this image and it cannot import the app's
# modules from the standalone tree, for the same reason `/app/migrate` exists:
# `.next/standalone/node_modules` is the minimal set Next traced for the SERVER's
# entries, and `lib/` source arriving there at all is a tracing side effect the
# assertion below explicitly refuses to depend on.
#
# So the worker is esbuilt into ONE self-contained ESM file whose only unresolved
# imports are packages the standalone tree actually carries. That set was
# MEASURED, not assumed — `.next/standalone/node_modules` holds `@aws-sdk`,
# `argon2`, `next`, `pg`, `react`, `react-dom` and a nested `.pnpm`, so `pg` and
# `argon2` (both native, both present) stay external and everything else,
# `@prisma/client` and the generated client included, is inlined. The generator
# is `prisma-client` with a driver adapter, so there is no query-engine binary
# for a bundler to break. `scripts/build-worker.mjs` carries the full argument.
#
# It runs AFTER `next build` so a build failure surfaces on the app first, and
# BEFORE the standalone assertion so the bundle is not mistaken for traced output.
RUN pnpm build:worker

# ── the terminal relay bundle (MOTIR-6940) ──────────────────────────────────
# The `motir-relay` Fly app (`fly.relay.toml`, `docs/decisions/agent-terminal.md`
# Q1) runs from THIS image, as the worker does, so it is bundled the worker's way
# for the worker's reason (`scripts/build-relay.mjs`): one ESM file, `ws` inlined,
# only `pg`/`argon2`-class natives external. Its import graph stops short of
# `lib/auth`, so the relay app boots with its four secrets and no others.
RUN pnpm build:relay

# ── the fleet-admin command bundle (MOTIR-8967) ─────────────────────────────
# `fleet-admin add-shard` / `refresh-limits` run inside a motir-core machine
# (`fly ssh console -a motir-core -C "node fleet/fleet-admin.mjs …"`), where the
# Enterprise and App secrets live. The image carries no `scripts/`, so the command
# is bundled the worker's way for the worker's reason
# (`scripts/build-fleet-admin.mjs`), with the worker's external set.
RUN pnpm build:fleet-admin

# ── the operator deploy-check bundle (MOTIR-9965) ───────────────────────────
# `node hosting/deploy-check.mjs <step> --workspace … --repository … --environment …`
# resolves a repository's stored environment, which needs the database and
# ENVIRONMENT_CONFIG_ENCRYPTION_KEY — so it runs on this machine, bundled the
# fleet-admin way (`scripts/build-deploy-check.mjs`).
RUN pnpm build:deploy-check


# ── assert the standalone output stayed small — the prune's successor ────────
# ⚠️ THIS STEP USED TO PRUNE. It does not any more, because there is nothing
# left to prune (MOTIR-3219, 2026-08-20) — and the change of polarity is
# deliberate, not a deletion.
#
# The history matters, because the step's own comment predicted this moment.
# Next's tracer used to sweep the repo root into `.next/standalone`: 381 MB, of
# which `design/` was 222 MB, `tests/` 15 MB, `scripts/` 6 MB and `docs/` 5 MB.
# Nothing serving a request reads any of them (the only runtime file reads in
# app code are the three Inter faces the OG cards load — `app/_brand/fonts/*.ttf`
# then, `packages/brand/fonts/*.ttf` since MOTIR-3848 gave them one home across
# both properties — and an env-supplied test-only path in
# `lib/email.ts`), and the release lane gets `prisma/` + its two scripts by
# explicit COPY in the runner below, never from the trace. So this step deleted
# them, and it failed loudly if one was missing — *"if a Next upgrade stops
# sweeping one of these directories in, this build stops and someone edits this
# step on purpose"* (MOTIR-2403).
#
# It was never a Next upgrade. The sweep was the `instrumentation.ts` E2E
# boundary mocks: each read a fixture from a path Turbopack could not resolve
# statically, and its fallback for an unresolvable read is to trace the ENTIRE
# project. `lib/test-fixture-file.ts` marks those reads `turbopackIgnore`, and
# `instrumentation.js.nft.json` went from **4510 traced files to 168** —
# `.next/standalone` from **464 MB to 124 MB**, measured on this Dockerfile's own
# `next build`. Every directory this step used to delete is now simply never
# traced in.
#
# So the step INVERTS rather than disappears. Two properties carry over intact:
#
#   1. It still runs HERE, in the builder, NOT in the runner — the reason a
#      prune had to (a `RUN rm -rf` after the runner's `COPY` frees nothing; the
#      bytes are committed in the COPY layer and a later layer only adds a
#      whiteout) is the same reason the CHECK belongs before the copy: it is the
#      last moment at which the size of what gets copied is still a decision.
#   2. It still FAILS LOUDLY rather than becoming a silent no-op. That was the
#      whole point of the `[ ! -d ]` guard — the bug it replaced was an
#      `outputFileTracingExcludes` that Turbopack never reads, pruning nothing
#      while reading as solved. Keeping a `rm -rf` here would have re-created
#      exactly that: a step removing nothing, indistinguishable from a step
#      doing its job.
#
# `pnpm assert:nft-trace` (CI's `build` job) asserts the same fact one level up,
# against the `.nft.json` files themselves, and catches it on the PULL REQUEST.
# This one is the backstop on the path that actually ships the bytes — and it is
# the only one of the two that runs on a `flyctl deploy`, which happens after
# the merge.
RUN set -eu; \
    cd .next/standalone; \
    echo "standalone: $(du -sm . | cut -f1) MB"; \
    for d in design tests docs scripts; do \
      if [ -d "$d" ]; then \
        echo "'$d/' is in the standalone output — an entry's output file trace" >&2; \
        echo "has widened to the whole project again (the MOTIR-3219 condition)." >&2; \
        echo "Run 'pnpm assert:nft-trace' after a build: it names every entry and" >&2; \
        echo "what it dragged in. The cause is a filesystem read whose path" >&2; \
        echo "Turbopack cannot resolve — see lib/test-fixture-file.ts. Fix the" >&2; \
        echo "read; do not re-add a prune here." >&2; \
        exit 1; \
      fi; \
    done; \
    echo "no never-served directory reached the standalone output"

# ── the migration toolchain ─────────────────────────────────────────────────
# `fly.toml`'s release_command runs `prisma migrate deploy` inside THIS image,
# and the pnpm tree above cannot come with it. Two reasons, both verified rather
# than assumed (MOTIR-2387):
#
#   1. `node_modules/prisma` under pnpm is a SYMLINK into `.pnpm/<hash>/`, and
#      the CLI's dependencies are that directory's SIBLINGS, not the package's
#      children. Copying `node_modules/prisma` into the runner therefore yields
#      `Cannot find module '@prisma/engines'` on the first invocation — a deploy
#      that dies in the release step, before any machine takes traffic.
#   2. `node_modules/.bin/prisma` is a pnpm shim carrying ABSOLUTE build-host
#      paths in its NODE_PATH export, so it does not survive relocation either.
#
# So the toolchain is a FLAT, relocatable npm tree, pinned to the exact versions
# pnpm resolved (read from the installed packages, so it cannot drift from the
# lockfile behind a `^` range), installed HERE so any platform-specific artifact
# matches the runner's architecture. `dotenv` is in the set because
# `prisma.config.ts` imports it. It is not small (~225 MB, nearly all of it
# @prisma/studio-core, which the CLI bundle requires eagerly — pruning it breaks
# `migrate deploy` with `Cannot find module '@prisma/studio-core/data/bff'`), and
# it is the price of a migration lane that runs from the app's own image.
RUN PRISMA_VERSION="$(node -p "require('prisma/package.json').version")" \
 && DOTENV_VERSION="$(node -p "require('dotenv/package.json').version")" \
 && npm install --prefix /migrate --no-audit --no-fund --save-exact \
      "prisma@${PRISMA_VERSION}" "dotenv@${DOTENV_VERSION}"

# ── runner ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# ⚠️ HOSTNAME MUST be 0.0.0.0, and omitting it FAILS SILENTLY. Next's standalone
# server binds the CONTAINER HOSTNAME by default: the process logs "✓ Ready",
# every health signal looks correct, and nothing outside the container can reach
# it — on a first deploy it presents as a networking problem and is debugged as
# one. Verified the hard way during the spike (MOTIR-2383).
ENV HOSTNAME=0.0.0.0
ENV PORT=8080
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# The standalone bundle carries its own minimal node_modules; static and public
# are NOT included by Next and must be copied alongside it.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# ── /app/migrate — the release lane, in ONE self-contained directory ────────
# It gets its own directory rather than merging into the standalone server's
# node_modules for two independent reasons:
#
#   * The two trees share `@prisma`, `react` and `react-dom`, and a merge would
#     let the CLI's copies shadow the ones the running server was traced against.
#   * `prisma.config.ts` is a MODULE, not a data file: it imports `dotenv` and
#     `prisma/config`, which Node resolves from the config file's OWN directory.
#     Left at /app it resolves against the standalone server's minimal
#     node_modules, which has neither, and the release command dies with
#     `Cannot find module 'dotenv'` — verified (MOTIR-2387). Beside the toolchain
#     it simply works.
#
# Next's tracer happens to sweep the repo root into the standalone output today,
# so `prisma/` and `scripts/` also land at /app whether or not anything asks. The
# release lane must not inherit them from that: it is a tracing side effect a
# Next upgrade could withdraw without a word. Everything it reads is copied here
# explicitly.
COPY --from=builder --chown=nextjs:nodejs /migrate/node_modules ./migrate/node_modules
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./migrate/prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./migrate/prisma.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/migrate-deploy.mjs ./migrate/migrate-deploy.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/release-migrate.mjs ./migrate/release-migrate.mjs

# ── /app/worker — the job engine's process group ────────────────────────────
# One file. Its unresolved imports (`pg`, `argon2`) resolve UPWARD into
# `/app/node_modules`, which is the standalone bundle's own tree — Node walks
# `/app/worker/node_modules` then `/app/node_modules`, so the worker needs no
# node_modules of its own. That is the whole reason the external set was pinned
# to what that tree already contains.
#
# The sourcemap is copied too: a worker stack trace with no map names a line in a
# 15 MB bundle, which is the difference between diagnosing a background-job
# failure in minutes and not diagnosing it at all.
COPY --from=builder --chown=nextjs:nodejs /app/.worker/worker.mjs ./worker/worker.mjs
COPY --from=builder --chown=nextjs:nodejs /app/.worker/worker.mjs.map ./worker/worker.mjs.map

# ── /app/relay — the terminal relay app (MOTIR-6940) ─────────────────────────
# `fly.relay.toml` runs `node relay/relay.mjs`. Like the worker, its unresolved
# imports resolve upward into `/app/node_modules`; the map is copied for the
# same reason.
COPY --from=builder --chown=nextjs:nodejs /app/.relay/relay.mjs ./relay/relay.mjs
COPY --from=builder --chown=nextjs:nodejs /app/.relay/relay.mjs.map ./relay/relay.mjs.map

# ── /app/fleet — the platform admin's fleet-account command (MOTIR-8967) ────
# Run by hand over `fly ssh console`, never by a process group. Its unresolved
# imports resolve upward into `/app/node_modules`, as the worker's do; the map is
# copied so an error names a source line.
COPY --from=builder --chown=nextjs:nodejs /app/.fleet-admin/fleet-admin.mjs ./fleet/fleet-admin.mjs
COPY --from=builder --chown=nextjs:nodejs /app/.fleet-admin/fleet-admin.mjs.map ./fleet/fleet-admin.mjs.map

# ── /app/hosting — the operator deploy check (MOTIR-9965) ───────────────────
# Run by hand over `fly ssh console`, like fleet-admin; its unresolved imports
# resolve upward into `/app/node_modules`.
COPY --from=builder --chown=nextjs:nodejs /app/.deploy-check/deploy-check.mjs ./hosting/deploy-check.mjs
COPY --from=builder --chown=nextjs:nodejs /app/.deploy-check/deploy-check.mjs.map ./hosting/deploy-check.mjs.map

# ── the RUNNING process must be able to name its own build (MOTIR-3760) ─────
# ⚠️ THE BUILDER STAGE'S `MOTIR_RELEASE` DOES NOT REACH HERE, AND FOR MONTHS
# NOTHING NEEDED IT TO. Its `ARG`/`ENV` pair sits in `builder` (see the
# monitoring block above), where `next build` reads it to name the Sentry release
# and tag the source maps it uploads. A Docker `ENV` is scoped to its own stage,
# and this stage copies artifacts rather than inheriting an environment — so
# `process.env.MOTIR_RELEASE` in the SERVER process was `undefined`, and the
# deployment had no way to say which commit it was running.
#
# `/api/health/release` is what needs it: the freshness check outside the
# deployment compares this string against `main`'s head
# (`scripts/deployFreshness.mjs`), and the whole design rests on the deployment
# stating ONE honest fact about itself. Without this line the route answers 503
# `unset` on every release and the check is permanently blind.
#
# ⚠️ IT MUST BE THE SAME VALUE THE BUILDER GOT — one `--build-arg` reaches every
# stage that declares the `ARG`, which is why this re-declares rather than
# re-deriving. `.git` is in `.dockerignore`, so there is no `git rev-parse`
# fallback inside the image and a mismatch could not be detected here.
#
# ⚠️ AND IT SITS AFTER EVERY `COPY`, DELIBERATELY. An `ENV` that changes on every
# commit invalidates every layer built after it; placed at the top of the stage
# it would cost a full re-copy of the standalone bundle on each release for a
# 40-character string.
#
# Empty default, like every other build argument here: a `docker build` with no
# arguments still produces a working self-hosted image, one that honestly reports
# that it cannot name its commit.
ARG MOTIR_RELEASE=""
ENV MOTIR_RELEASE=$MOTIR_RELEASE

USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
