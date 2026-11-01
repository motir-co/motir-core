# The AWS deploy

`.github/workflows/aws-deploy.yml` deploys every push to `main` onto core's
Fargate services (Story MOTIR-9709). It builds the image from the repository's
`Dockerfile`, pushes it to the ECR repository `<prefix>/motir-core` tagged with
the commit SHA, and runs `pnpm deploy:aws --digest <digest>` with the pushed
image's digest. The deploy script (`scripts/aws-deploy/awsDeploy.ts`) runs the
migrate task, rolls web, worker and relay, and records the digest in
`/<prefix>/core/image-digest` only when every service has completed. Any
failure leaves the previous tasks serving.

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
`{ digest, migrate: { taskArn, exitCode }, services: [{ name, taskDefinition, rolloutState }], recorded }`.
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

The roll registers each service's next revision by copying the one it runs now,
with only the image changed. So before it migrates or changes anything, the
deploy refuses a service whose revision sets `MOTIR_BREACH_ENABLED` on a
container (MOTIR-10093): that is a hand-registered breach revision, and copying
it would make the breach the service's next release, run in a loop. The log
names the service and the revision. Point the service back at its own revision
once the breach ends, then re-run the workflow.
