# The AWS deploy

`.github/workflows/aws-deploy.yml` deploys every push to `main` onto core's
Fargate services (Story MOTIR-9709). It builds the image from the repository's
`Dockerfile`, pushes it to the ECR repository `<prefix>/motir-core` tagged with
the commit SHA, and runs `pnpm deploy:aws --digest <digest>` with the pushed
image's digest. The deploy script (`scripts/aws-deploy/awsDeploy.ts`) runs the
migrate task, rolls web, worker and relay, and records the digest in
`/<prefix>/core/image-digest` only when every service has completed. Any
failure leaves the previous tasks serving.

## The one release lane, and its guards

This workflow is Motir's only release lane: the old `deploy` job of `ci.yml`
was retired by MOTIR-10935. It shares no job with `ci.yml`, waits on nothing in
it and is not triggered by it.

It carries the release guards that job carried (MOTIR-11059):

- **It refuses to build without its monitoring secrets.** The first step fails
  the run with `Missing monitoring secret(s)` when `NEXT_PUBLIC_SENTRY_DSN`,
  `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` or `SENTRY_PROJECT` is empty, before any AWS
  session: an empty DSN builds a browser bundle that reports nothing, and an
  empty token ships stack traces nobody can read.
- **It refuses to build without the Server Action salt.** The next step fails
  with `Missing NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` when that secret is empty,
  because a build without it re-salts every Server Action id and every tab open
  across the release loses its writes (MOTIR-3948).
- **The image build uploads source maps.** `SENTRY_ORG`, `SENTRY_PROJECT`, the
  browser DSN and `MOTIR_RELEASE` (the commit SHA) go in as build arguments;
  `SENTRY_AUTH_TOKEN` and the salt go in as BuildKit secrets, which the
  `Dockerfile` mounts for `next build` alone.
- **It proves the upload ran.** The last step reads
  `GET /api/0/projects/<org>/<project>/releases/<sha>/` from Sentry and turns
  the run red when it is not `200`. It runs after the roll, so an outage of
  Sentry's API never holds a release back.

## Static assets — a tab open across a release keeps working

Each task serves only its own build's `/_next/static`, so when a roll stopped the
old task, a tab loaded from it asked for a chunk the new task had never built and
fell to the error page (MOTIR-11241). The release now serves those files from the
durable origin motir-infra builds (MOTIR-11240, its `docs/static-assets.md`):

- **Before the build**, `pnpm deploy:static target` reads
  `/<prefix>/core/static-assets` with the deploy role. Its `url` is passed as the
  `MOTIR_ASSET_PREFIX` build argument, which `next.config.ts` turns into
  `assetPrefix`; `MOTIR_RELEASE` also becomes Next's `deploymentId`, so a tab
  whose build no longer matches the server does a full page load instead of
  mixing two builds (`lib/build/versionSkew.ts`).
- **While there is no origin** — the parameter is missing, the role is not
  granted it, or `static.motir.co` does not answer yet — the step warns
  `No static-asset origin`, the image is built with no prefix as before, and every
  step below stands down. The first release after the origin answers switches
  over by itself.
- **Before the gate and the roll**, the job copies `/app/.next/static` out of the
  image and uploads it to `s3://<bucket>/_next/static/` with
  `Cache-Control: public, max-age=31536000, immutable`, never with `--delete`:
  the bucket's lifecycle rule expires old releases. `pnpm deploy:static
verify-upload` then fails the run, before anything rolls, unless one of the
  files answers `200` from the origin with CORS for the app. A re-run of a commit
  whose image was already pushed pulls that image by digest and uploads again.
- **After the roll**, `pnpm deploy:static verify-release` turns the run red unless
  the app's HTML loads this build's files from the origin and a file the previous
  release loaded from there (noted before the roll) still answers `200`. On the
  first release after the switch the previous release served its own files, so
  only the first half is checked.

## Repository secrets

| Secret                               | Used for                                                       |
| ------------------------------------ | -------------------------------------------------------------- |
| `NEXT_PUBLIC_SENTRY_DSN`             | The browser DSN, inlined into the client bundle at build time. |
| `SENTRY_AUTH_TOKEN`                  | The source-map upload, and the release check.                  |
| `SENTRY_ORG`                         | The Sentry organisation slug the maps are uploaded to.         |
| `SENTRY_PROJECT`                     | The Sentry project slug the maps are uploaded to.              |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | The Server Action salt. It must never change once set.         |

## Repository variables

All five are repository **variables**, not secrets: none is a credential. Both
AWS sessions are GitHub OIDC role assumptions.

| Variable                 | Value                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `AWS_REGION`             | The services account's region, e.g. `us-east-1`.                                                           |
| `AWS_DEPLOY_NAME_PREFIX` | motir-infra's `namePrefix` for the environment (the `<prefix>` above).                                     |
| `AWS_ECR_PUSH_ROLE_ARN`  | The ECR push role for `motir-core`, `<prefix>-ecr-push-motir-core` (the motir-infra ECR stack's output).   |
| `AWS_DEPLOY_ROLE_ARN`    | The core deploy role, `<prefix>-core-deploy` (`DeployRoleArn` output of motir-infra's `CoreDeploy` stack). |
| `AWS_DEPLOY_NO_ROLL`     | Optional. `true` only for the first run (below); remove it afterwards.                                     |

Until `AWS_DEPLOY_ROLE_ARN` is set the job is skipped, not failed. Both roles
trust only `refs/heads/main` of this repository; the job has no
`environment:`, because one would change the OIDC subject they trust.

## The first run

The first deploy happens before the services exist, while the digest parameter
still holds its placeholder:

1. Set the four variables above, and `AWS_DEPLOY_NO_ROLL` to `true`.
2. Run the workflow once (Actions → AWS deploy → Run workflow on `main`). With
   `--no-roll` the script checks the image, runs the migrate task and records
   the digest, and touches no service.
3. Deploy motir-infra's services stack, which creates the services from the
   recorded digest.
4. Delete `AWS_DEPLOY_NO_ROLL`. Every later merge rolls the services.

## Image pins

The deploy also passes `--pins infra/image-pins`. Each file there is one image
pin: its name is a secret under `<prefix>/core/`, and its line is a
pull-by-digest reference (MOTIR-10883, `infra/image-pins/README.md`). After the
migrate task and before the roll, the script writes each pin whose secret holds
another value, so the tasks the roll starts read it; ECS reads secrets only at
task start. A failed roll puts the previous value back before it rolls the
services back, so the tasks the rollback starts read the old image. The
directory is the only place a pin is written: a release lane opens the pull
request that changes it, and reverting that pull request rolls it back. The
pins are `motir-runner-image` (MOTIR-10883) and `motir-hosted-agent-image`
(MOTIR-10882); the daily health check's `hosted-agent-image-lag` step fails when
the hosted-agent pin lags `main`'s newest build.

The deploy role needs motir-infra's `WriteImagePins` statement for this. Until
it is deployed the pin reads `not_granted` on the result line and the services
roll as before.

## Reading a run

The job summary shows the digest and, on success, the deploy script's JSON
result line:
`{ digest, migrate: { taskArn, exitCode }, services: [{ name, taskDefinition, base, clonedFrom, rolloutState }], pins: [{ name, value, state }], recorded }`,
where a pin's `state` is `written`, `unchanged`, `not_granted` or `restored`.
On a failure the step log shows why (a migrate exit code or stop reason with
the last 50 migrate log lines, or the services' rollout states) and that every
service is back on its previous revision.

A service another deployer moves while the roll waits is the one exception
(MOTIR-10117). A motir-infra deploy that changes a service's task definition
makes its own revision PRIMARY. The roll then reports that service
`SUPERSEDED`, fails without recording the digest, and leaves the service on
the other deployer's revision. Forcing the previous revision back would undo
the infra change, and every later deploy would copy the stale revision
forward. The log names the service and the revision it was left on. Re-run the
workflow once the other deploy has finished.

Before it rolls, the workflow runs `scripts/aws-deploy/deploy-gate.sh`
(MOTIR-10436). It stands down when a first attempt's commit is no longer main's
newest, because that commit's deploy carries it; such a run is green and its log
says so. It asks that first, so a run that stands down does not hold the deploy
lock through a wait, and again after any wait. A re-run or a manual dispatch of an
older commit still deploys, with a warning, and puts the older image on the
services. Otherwise it waits up to 20 minutes for a running update of the services
stack to finish, which avoids most of those collisions. An update that starts
after the roll begins still collides. The roll then assumes the deploy role again,
because a session lasts an hour and the wait may have spent a third of it.

The roll copies each service's next revision from the newest revision of its
family that motir-infra's CloudFormation registered, with only the image
changed (MOTIR-11235). That revision is the CDK template as deployed, so every
infra-owned field (environment values, secrets, sizes, roles) comes from the
template, and an infra update the deploy overlapped is kept. Copying the
revision a service ran instead put a stale one back whenever an infra deploy
landed during the migrate, and CloudFormation, which still recorded its own
revision, never put it right. The roll finds the source by reading the family's
revisions downward from the newest, up to 100, and takes the first ACTIVE one
whose `registeredBy` is CloudFormation's `AWSCloudFormation` session. When it
finds none, or a read fails, the log says why and that service is copied from
the revision it runs, as before. A revision a person registered by hand is
never a source, so the next deploy replaces it with the template's.

Three more things keep the roll off an infra update's toes:

- After the migrate, the deploy waits up to the timeout while the services
  stack (`<prefix>-services`) is mid-update, as `deploy-gate.sh` does before
  the deploy starts. A status it cannot read, or a stack still busy at the
  deadline, is logged and the roll goes ahead.
- Each service is read again right before its register, and is registered and
  updated in turn. A service that moved while the migrate ran is rolled back,
  on a failure, to the revision it ran at that moment, never to the one the
  deploy first read. The log says
  `roll: <service> moved from <old> to <new> after the deploy read it`.
- If another revision of the family is registered between that read and the
  register, the roll waits one poll and reads again, up to three times, and
  then fails with nothing more rolled.

The result line names each service's `base` (the revision it ran before its
update) and `clonedFrom` (the revision its new one copies).

Before it migrates or changes anything, and again before each service's
register, the deploy refuses a service whose revision sets `MOTIR_BREACH_ENABLED` on a
container (MOTIR-10093): that is a hand-registered breach revision, and a breach
run holds the service. The log
names the service and the revision. Point the service back at its own revision
once the breach ends, then re-run the workflow.
