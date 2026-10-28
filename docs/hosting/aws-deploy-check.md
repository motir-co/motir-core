# The operator deploy check on the AWS target

`pnpm hosting:deploy-check --target aws` (MOTIR-10011) drives the AWS hosting
adapter end to end against a **staging** tenant account: it deploys the fixture
app (`tests/fixtures/hosting/aws-fixture-app`) in either shape, reads its health
and a database row, moves to a second release and back without a rebuild, and
destroys it, printing the compute it used. `--target fly` (the default) is the
Fly check as it was.

Nothing in CI runs it against AWS. Under `MOTIR_FLEET_ORCHESTRATOR=fake` it runs
against the fake port, which is what `tests/hosting/deployCheckAws.test.ts`
proves; the steps below are the same commands run live.

## Before you start

- **A repository made for the check.** The app is `mh-<repository id>` — the
  tenant app of a real Motir repository in the staging organisation, not a
  customer's. `destroy` acts on that repository's production app, so never point
  it at a repository anyone uses. Note its id and its organisation's id.
- **motir-core's database.** The adapter reads the repository row (its
  organisation, whether it is a customer repository, its GitHub ids) and the
  tenant account row, so set `DATABASE_URL` to the database that holds them.
- **Motir's hosting identity**, the credentials the adapter's assumed-role chain
  starts from: `AWS_ORG_ADMIN_ROLE_ARN` (with `AWS_ORG_ADMIN_ACCESS_KEY_ID` /
  `AWS_ORG_ADMIN_SECRET_ACCESS_KEY` off an AWS host),
  `MOTIR_HOSTING_AWS_FORWARDER_PRINCIPAL_ARN`, `MOTIR_HOSTING_AWS_APP_DOMAIN`
  and `MOTIR_HOSTING_ORIGIN_SECRET_KEY`.
- **The forwarder's identity in your default credential chain.** `page` signs a
  function release's request with SigV4 (service `lambda`) using the default
  chain, and a function URL admits only the forwarder principal, so the chain
  must resolve to (or assume) that principal.
- **An operator profile in the tenant account**, e.g. one that assumes
  `OrganizationAccountAccessRole` there, with ECR push rights. `push` uses it.
- **Docker** with `buildx`, able to build `linux/amd64`.

## Run order

Set the common flags once:

```sh
export CHECK="--target aws --repository <repository id> --organization <organization id> --aws-profile <tenant profile>"
```

Then, for each shape (`function` first, then `container`):

```sh
pnpm hosting:deploy-check no-shape $CHECK
```

Must exit 1 with `error: HOSTING_SHAPE_REQUIRED`, and `releases: none`. Nothing
is created: the adapter refuses before it touches the account.

```sh
pnpm hosting:deploy-check all $CHECK --shape function
```

`all` runs, in order:

| step       | runs as                                                  | what it prints                                                                                     |
| ---------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `converge` | Motir's hosting identity                                 | the deploy-role convergence outcome (`changed` or `unchanged`)                                     |
| `push`     | your `--aws-profile`                                     | the role CI will push as (`mh-<id>-production-push`), the registry, two digests                    |
| `deploy`   | Motir's hosting identity                                 | release 1, its state, its HTTPS address and origin credential                                      |
| `page`     | the forwarder (function) / the origin secret (container) | `/health` and `/row` status, `release: 1`, the row                                                 |
| `release2` | Motir's hosting identity                                 | release 2, then its `page`: `release: 2`                                                           |
| `rollback` | Motir's hosting identity                                 | the serving release, then its `page`: `release: 1` again — no build, no push                       |
| `destroy`  | Motir's hosting identity                                 | the usage, its `compute` (`lambda` GB-seconds or `fargate` vCPU- and GB-seconds), then no releases |

Each step can also be run on its own (`pnpm hosting:deploy-check page $CHECK
--shape function`): state lives in the account, not on your machine. `status`
and `probe` work as on Fly; `probe` proves a container release's load-balancer
rule (2xx with the origin secret, 403 without) and stops on a function release,
whose credential is SigV4, not the secret.

`push` prints the push role but does not use it: its trust admits only GitHub
OIDC from the repository. It logs Docker in by piping
`aws ecr get-login-password` into `docker login --password-stdin`; the password
is never an argument and never printed.

`page` retries a 5xx or an unreachable release up to six times, five seconds
apart: a function's first invocation and a scale-from-zero database both answer
5xx while they wake.

Repeat with `--shape container`.

## What to look at in the console

In the **tenant account**, region `us-east-1`, while a release is up:

- **Function shape:** Lambda shows the function `mh-<id>` with its function URL
  (auth type `AWS_IAM`), and two published versions after `release2`. Nothing
  named `mh-<id>` exists in Motir's own accounts.
- **Container shape:** ECS shows the Fargate service `mh-<id>` in the account's
  cluster; EC2 › Target groups shows its target group, and the account's load
  balancer has a host rule for the app that checks `X-Motir-Origin-Secret`.
- **Both:** ECR holds `mh/<id>/production` with `release-1` and `release-2`;
  CloudFormation shows the release stack and, after `destroy`, none.

After `destroy`, the release stack is gone and `status` prints `state: none`.

## Known open item

A container release's upstream is the load balancer's `*.elb.amazonaws.com`
name, which cannot carry a public ACM certificate, so HTTPS to it is unsettled.
The check uses the address the adapter returns as given and never disables TLS
verification. If the container `page` fails on TLS, record it against that open
item rather than working around it.
