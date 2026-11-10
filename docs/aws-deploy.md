# The AWS deploy

`.github/workflows/aws-deploy.yml` deploys every push to `main` onto core's
Fargate services (Story MOTIR-9709). It builds the image from the repository's
`Dockerfile`, pushes it to the ECR repository `<prefix>/motir-core` tagged with
the commit SHA, and runs `pnpm deploy:aws --digest <digest>` with the pushed
image's digest. The deploy script (`scripts/aws-deploy/awsDeploy.ts`) runs the
migrate task, rolls web, worker and relay, and records the digest in
`/<prefix>/core/image-digest` only when every service has completed. Any
failure leaves the previous tasks serving.

## The hosted-agent image pin

The deploy also applies the hosted-agent image pin (MOTIR-10882).
`infra/hosted-agent-image.ref` holds the one image every hosted run boots,
`ghcr.io/motir-co/motir-hosted-agent@sha256:…`, and the workflow passes it as
`--hosted-agent-pin infra/hosted-agent-image.ref`. After the migrate task exits
0 and before the roll, the script writes that image into the
`<prefix>/core/motir-hosted-agent-image` secret, the `MOTIR_HOSTED_AGENT_IMAGE`
the web and worker read. ECS reads a secret only when a task starts, so the
roll is what makes the new tasks read it. A secret that already holds the pin is
left alone. When the roll fails, the script puts the previous image back before it rolls back, so
the rolled-back tasks boot what they booted before.

Nobody edits the file by hand in the normal course. After every publish on
`main`, `.github/workflows/hosted-agent-image.yml`'s `pin` job opens or updates
one pull request on the branch `chore/hosted-agent-image-pin` that writes the
new digest into it, and `.github/workflows/hosted-agent-pin.yml` pulls that
image anonymously and runs the smoke test and the provider probe against it.
Merging the pull request is the deliberate pin. Reverting it is the rollback.
The daily health check fails when a newer `main` build has gone unpinned for
more than a day, or the pin is more than a week behind it.

## Independent of the Fly deploy

The workflow is independent of the Fly deploy, which is the `deploy` job of
`ci.yml`. It is a separate workflow with no `needs`, `workflow_run` or shared
job, so an AWS failure turns only its own run red and never blocks or rolls
back Fly, and a Fly failure never blocks AWS. Both deploy the same `main`
commit. The AWS image is a second build of that commit; only the Fly build
uploads source maps to Sentry.

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

## Reading a run

The job summary shows the digest and, on success, the deploy script's JSON
result line:
`{ digest, migrate: { taskArn, exitCode }, services: [{ name, taskDefinition, rolloutState }], hostedAgentImage: { image, previous, written, restored }, recorded }`.
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
workflow once the other deploy has finished: it copies the revision each
service runs now.

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

The roll registers each service's next revision by copying the one it runs now,
with only the image changed. So before it migrates or changes anything, the
deploy refuses a service whose revision sets `MOTIR_BREACH_ENABLED` on a
container (MOTIR-10093): that is a hand-registered breach revision, and copying
it would make the breach the service's next release, run in a loop. The log
names the service and the revision. Point the service back at its own revision
once the breach ends, then re-run the workflow.
