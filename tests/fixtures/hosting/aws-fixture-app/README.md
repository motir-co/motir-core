# AWS deploy check fixture app

The app the operator deploy check (`pnpm hosting:deploy-check --target aws`,
MOTIR-10011) deploys to a staging tenant account. It exists because the Fly
check's `traefik/whoami` image cannot read a database.

- `GET /health` answers `200` with `{ ok, release }`.
- `GET /row` creates a one-row `deploy_check` table in `DATABASE_URL` the first
  time (`CREATE TABLE IF NOT EXISTS`, then one insert that a repeat leaves alone)
  and answers `{ release, row }`. A database that is still waking answers `503`,
  which the check's `page` step retries.

`release` is baked in at build time with `--build-arg RELEASE=1|2`, so release 1
and release 2 are different image digests. The image copies in the AWS Lambda
Web Adapter, so the same image runs as a Lambda container image (the `function`
shape) and as an ECS Fargate task (the `container` shape). The adapter image is
pinned by tag in the `LAMBDA_WEB_ADAPTER` build argument; pass a digest there to
pin it harder.

The check's `push` step builds it for `linux/amd64` (both shapes run x86_64) with
`--provenance=false` (Lambda refuses an image index with attestations), tags it
`<registry>/mh/<repository id>/production:release-1` and `:release-2`, and pushes
both under the operator's own AWS profile. See `docs/hosting/aws-deploy-check.md`.

`../motir.hosting.aws.json` is its hosting manifest.
