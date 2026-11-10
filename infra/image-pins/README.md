# Image pins

Each file here (other than this note) is **one production image pin**. Its name
is the Secrets Manager secret it writes, under `<prefix>/core/`, and its one line
is a pull-by-digest reference: `ghcr.io/<owner>/<name>@sha256:<64 hex>`, never a
tag.

| file                 | secret                                                 | read by                                                  | bumped by                                            |
| -------------------- | ------------------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------- |
| `motir-runner-image` | `motir/core/motir-runner-image` (`MOTIR_RUNNER_IMAGE`) | the fleet's readiness and health probes, the Fly adapter | `release-runner-image.yml`, on every `runner-v*` tag |

## How a pin moves (MOTIR-10883)

1. **The release lane opens the pull request.** A `runner-v*` tag builds, proves
   and publishes the image, pulls it back by digest, and then opens (or updates)
   the one pull request on `chore/runner-image-pin` that writes the published
   reference here. The tag is the deliberate release; merging the pull request is
   the deliberate pin.
2. **The AWS deploy of the merge applies it.** `.github/workflows/aws-deploy.yml`
   passes `--pins infra/image-pins` to `pnpm deploy:aws`, which writes each pin
   into its secret after the migrate task and before it rolls `web`, `worker` and
   `relay`. ECS reads a secret only when a task starts, so the roll is what makes
   the new tasks read it. A failed roll puts the old value back.
3. **Rolling back is reverting the pull request.** The next deploy writes the
   previous reference.

This directory is the **only** place the value is written. Setting the secret by
hand is overwritten by the next deploy of `main`.

## Adding a pin

A new file must also be added to `PINNED_SECRETS` in
`scripts/aws-deploy/imagePins.ts` and granted to the core deploy role in
motir-infra (`DEPLOY_PINNED_SECRETS` in `lib/constructs/core-deploy-role.ts`).
`tests/awsDeploy/imagePins.test.ts` holds the list to this directory and to the infra list,
and the deploy refuses a file whose name is not on the list.
