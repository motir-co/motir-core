# Image pins

Each file here (other than this note) is **one production image pin**. Its one
line is a pull-by-digest reference, never a tag, and its name says where the
deploy writes it:

- a **GHCR image** pin writes the Secrets Manager secret of its own name under
  `<prefix>/core/`, and holds `ghcr.io/<owner>/<name>@sha256:<64 hex>`;
- the **indexer** pin writes the SSM parameter `/<prefix>/core/indexer-image`
  (it holds no secret), and holds the indexer in this account's ECR,
  `<account>.dkr.ecr.<region>.amazonaws.com/<prefix>/indexer@sha256:<64 hex>`.

| file                       | written to                                                                | read by                                                  | bumped by                                                                                    |
| -------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `motir-hosted-agent-image` | secret `motir/core/motir-hosted-agent-image` (`MOTIR_HOSTED_AGENT_IMAGE`) | the hosted-run orchestrator, on Fly and AWS              | `hosted-agent-image.yml`'s `pin` job, on every publish from `main` (MOTIR-10882)             |
| `motir-runner-image`       | secret `motir/core/motir-runner-image` (`MOTIR_RUNNER_IMAGE`)             | the fleet's readiness and health probes, the Fly adapter | `release-runner-image.yml`, on every `runner-v*` tag                                         |
| `motir-indexer-image`      | parameter `/motir/core/indexer-image` (`MOTIR_INDEXER_IMAGE`)             | web and worker, which boot every code-graph index run    | `indexer-image-pin.yml`, dispatched by Publish latest on `/admin/fleet-status` (MOTIR-10986) |

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

### The indexer pin (MOTIR-10986)

The indexer is released in motir-ai: an `indexer-v<x.y.z>` tag runs that
repository's `release-indexer-image.yml`, which publishes the image to GHCR and
its `mirror-ecr` job copies the same digest into this account's ECR as
`<prefix>/indexer:indexer-<x.y.z>`. No motir-core lane runs on that tag, so the
pin moves from the console: **Publish latest** on the Fleet status page's
Indexer image card dispatches `.github/workflows/indexer-image-pin.yml` with
`pin_reference` set to the newest release's ECR reference. That workflow checks
the reference, opens (or updates) the one pull request on
`chore/indexer-image-pin` that writes it here, and queues it to merge. It needs
no AWS credential. The deploy of the merge writes `/<prefix>/core/indexer-image`
before it rolls `web` and `worker`, and index runs started after the roll boot
the new image.

To move it by hand, dispatch the same workflow:

```sh
gh workflow run indexer-image-pin.yml -f pin_reference=<account>.dkr.ecr.<region>.amazonaws.com/<prefix>/indexer@sha256:<64 hex> -f pin_version=<x.y.z>
```

This directory is the **only** place the value is written. Setting the secret or parameter by
hand is overwritten by the next deploy of `main`.

## Adding a pin

A new file must also be added to `PINNED_SECRETS` (a secret) or
`PINNED_PARAMETERS` (an SSM parameter) in `scripts/aws-deploy/imagePins.ts`, with
the reference shape it must hold, and granted to the core deploy role in
motir-infra (`DEPLOY_PINNED_SECRETS`, or the parameter statement beside
`deployPinnedIndexerParameterName`, in `lib/constructs/core-deploy-role.ts`).
`tests/awsDeploy/imagePins.test.ts` holds the lists to this directory and to the infra lists,
and the deploy refuses a file whose name is not on them.
