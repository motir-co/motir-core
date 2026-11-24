# Image pins

Each file here (other than this note) is **one production image pin**. Its one
line is a pull-by-digest reference, never a tag
(`ghcr.io/<owner>/<name>@sha256:<64 hex>`), and the deploy writes it into the
Secrets Manager secret of its own name under `<prefix>/core/`.

| file                       | written to                                                                | read by                                                  | bumped by                                                                        |
| -------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `motir-hosted-agent-image` | secret `motir/core/motir-hosted-agent-image` (`MOTIR_HOSTED_AGENT_IMAGE`) | the hosted-run orchestrator, on Fly and AWS              | `hosted-agent-image.yml`'s `pin` job, on every publish from `main` (MOTIR-10882) |
| `motir-runner-image`       | secret `motir/core/motir-runner-image` (`MOTIR_RUNNER_IMAGE`)             | the fleet's readiness and health probes, the Fly adapter | `release-runner-image.yml`, on every `runner-v*` tag                             |

## How a pin moves (MOTIR-10883)

1. **The release lane opens the pull request.** A `runner-v*` tag (or, for the
   hosted-agent image, a `packages/cli/**` merge to `main`) builds, proves
   and publishes the image, pulls it back by digest, and then opens (or updates)
   the one pull request on `chore/runner-image-pin` (`chore/hosted-agent-image-pin`) that writes the published
   reference here. The tag is the deliberate release; merging the pull request is
   the deliberate pin.
2. **The AWS deploy of the merge applies it.** `.github/workflows/aws-deploy.yml`
   passes `--pins infra/image-pins` to `pnpm deploy:aws`, which writes each pin
   into its secret after the migrate task and before it rolls `web`, `worker` and
   `relay`. ECS reads a secret only when a task starts, so the roll is what makes
   the new tasks read it. A failed roll puts the old value back.
3. **Rolling back is reverting the pull request.** The next deploy writes the
   previous reference.

### Publish latest

Publish latest on `/admin/fleet-status` starts every image's workflow —
`hosted-agent-image.yml`, `release-runner-image.yml` and `release-sandbox.yml` — as the provisioning GitHub
App, **Motir Studio**, on its `motir-co` installation. Starting a workflow
(`POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches`) needs
**Actions: read and write**; with `Actions: read` alone GitHub answers 403
`Resource not accessible by integration`, and the page names the missing
permission (MOTIR-11229). A token keeps the permissions it was minted with, so
after granting it the next press retries its 403 once with a newly minted token
rather than waiting out the cached one's hour.

This directory is the **only** place the value is written. Setting the secret by
hand is overwritten by the next deploy of `main`.

## Adding a pin

A new file must also be added to `PINNED_SECRETS` in
`scripts/aws-deploy/imagePins.ts`, with the reference shape it must hold, and
granted to the core deploy role in motir-infra (`DEPLOY_PINNED_SECRETS` in
`lib/constructs/core-deploy-role.ts`).
`tests/awsDeploy/imagePins.test.ts` holds the lists to this directory and to the infra lists,
and the deploy refuses a file whose name is not on them.
