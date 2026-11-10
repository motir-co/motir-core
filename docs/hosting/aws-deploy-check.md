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

## Where it runs: inside AWS, with no long-lived key

The check runs from **inside AWS** (MOTIR-10301). No step uses an AWS access key,
and no step needs a person's laptop to hold Motir's management role: that role
trusts only core's task roles, so the steps that act as Motir run in a core task.
It runs in two places, because a Fargate task cannot run Docker:

| where                                            | what runs there                                                                                                             | as whom                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **a task of `motir-core-worker`**, over ECS Exec | every step that acts as Motir: `no-shape`, `converge`, `app`, `deploy`, `page`, `release2`, `rollback`, `status`, `destroy` | the worker's task role, `motir-core-worker-task`, and the roles it assumes |
| **AWS CloudShell in the tenant account**         | building the fixture image twice and pushing both to the app's registry — what `push` does on a machine with Docker         | the person's console session in the tenant account                         |

The worker task is the one `fleet-admin` runs in on AWS (MOTIR-10264): it serves
no traffic, ECS Exec is enabled on it, its task definition injects the database
login parts (`MOTIR_DB_*`) and `NODE_EXTRA_CA_CERTS`, and its task role assumes the
management-account role (`AWS_ORG_ADMIN_ROLE_ARN`, from the SDK's default
credential chain — no key is set on the task). The bundle's entry
(`scripts/hosting-deploy-check-main.ts`) composes `DATABASE_URL` from those parts
exactly as the services do, with `sslmode=verify-full`, before anything loads the
database client, and removes the URL and the password from everything it prints.

`push` and `all` still exist for a machine that has Docker and an operator
profile; they are not part of the run inside AWS, because the task has no Docker
and no profile.

## What must be true first

- **A repository made for the check.** The app is `mh-<repository id>` — the
  tenant app of a real Motir repository in the staging organisation, not a
  customer's. `destroy` acts on that repository's production app, so never point
  it at a repository anyone uses. Note its id and its organisation's id.
- **The worker task carries the hosting values.** The adapter reads
  `MOTIR_HOSTING_ORIGIN_SECRET_KEY` (a secret) when it is built, for every step,
  and `MOTIR_HOSTING_AWS_FORWARDER_PRINCIPAL_ARN` and `MOTIR_HOSTING_AWS_APP_DOMAIN`.
  The two plain values are given on each command below. The key is a secret, and
  an ECS Exec command line is recorded in CloudTrail, so it must reach the task
  from Secrets Manager, never from the command. motir-infra creates that entry
  (`<prefix>/core/motir-hosting-origin-secret-key`) with a random placeholder.
  The check runs on the placeholder, but every app it deploys derives its origin
  secret from it, so a container release deployed now rejects the forwarder once a
  person sets the real key. Set the key before the check, or deploy the fixture
  again after the key changes.
- **The worker task role may call a function URL** — needed now only for a
  function stack applied before its front door (MOTIR-10129). A function release
  deployed since is reached through its FRONT DOOR with the origin secret, as a
  container is, and `page` signs nothing for it. For an older stack, `page`
  signs its request (SigV4, service `lambda`) with the task's own
  credentials, and a function URL in another account admits a caller only when the
  URL's resource policy names it AND the caller's own policy allows it. Since
  October 2025 a new function URL needs BOTH `lambda:InvokeFunctionUrl` and
  `lambda:InvokeFunction` on each side (AWS, "Control access to Lambda function
  URLs"); `InvokeFunction` is held only through the URL
  (`lambda:InvokedViaFunctionUrl`). The check names the worker's task role as the
  forwarder principal, so the resource policy is the release template's
  (`ForwarderInvoke` and `ForwarderInvokeFunction` in `function-release.yaml`);
  the identity policy is motir-infra's.

### What core's task roles needed

Before MOTIR-10304, motir-infra gave the worker task neither of the last two
items. Both are one motir-infra change (motir-infra#51):

| the step needs                                                                                                 | what motir-infra adds                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every step: `MOTIR_HOSTING_ORIGIN_SECRET_KEY` on the worker task                                               | a Secrets Manager secret injected into the worker's (and the web's) task definition                                                                                                                                                                  |
| `page`, `release2`, `rollback` on the `function` shape: `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` | two statements on `motir-core-worker-task` on `arn:aws:lambda:<region>:*:function:mh-*`: `lambda:InvokeFunctionUrl` conditioned on `lambda:FunctionUrlAuthType` `AWS_IAM`, and `lambda:InvokeFunction` conditioned on `lambda:InvokedViaFunctionUrl` |

Until that lands, every step refuses with `set MOTIR_HOSTING_ORIGIN_SECRET_KEY`,
and the function `page` answers 403. A function release deployed from a template
older than this change has no `ForwarderInvokeFunction` permission, so it
answers 403 too until it is deployed again. Nothing else is missing: the management-role
grant, the database login, the RDS CA bundle, ECS Exec and outbound HTTPS (the
container `page` reaches the tenant load balancer through the services account's
NAT gateways) are already on the task.

## The caller

Run the ECS Exec commands from **AWS CloudShell in the services account**
(`944842271421`, region `us-east-1`), signed in through the console. The caller
needs, in that account:

- `ecs:ListTasks` on the cluster `motir-core`, and `ecs:ExecuteCommand` on the
  cluster and its tasks;
- the Session Manager plugin, which CloudShell does not carry. Install it once per
  session:

```sh
sudo dnf install -y https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm
```

The task role already holds the `ssmmessages` actions ECS Exec needs.

## Run order

Set the values once, in the services account's CloudShell:

```sh
export TASK="$(aws ecs list-tasks --region us-east-1 --cluster motir-core \
  --service-name motir-core-worker --desired-status RUNNING \
  --query 'taskArns[0]' --output text)"
export HOSTING="MOTIR_HOSTING_AWS_FORWARDER_PRINCIPAL_ARN=arn:aws:iam::944842271421:role/motir-core-worker-task MOTIR_HOSTING_AWS_APP_DOMAIN=<apps domain>"
export CHECK="--target aws --repository <repository id> --organization <organization id>"
check() {
  aws ecs execute-command --region us-east-1 --cluster motir-core --task "$TASK" \
    --container worker --interactive \
    --command "sh -c '$HOSTING node /app/hosting/deploy-check.mjs $* $CHECK'"
}
```

`check <step> [flags]` runs one step in the task. ECS Exec does not return the
remote exit code, so **read the last line**: `deploy-check exit 0` is success,
`deploy-check exit 1` a refusal or a failure, printed after the step's own block.
The forwarder principal is the worker's own task role, so the function URLs the
adapter creates admit the `page` read the same task signs.

Then, for each shape (`function` first, then `container`):

### 1. `no-shape` — in the task

```sh
check no-shape
```

Must end `deploy-check exit 1` with `error: HOSTING_SHAPE_REQUIRED`, and
`releases: none`. Nothing is created: the adapter refuses before it touches the
account. Needs: the database (the repository row) and the management role.

### 2. `converge` — in the task

```sh
check converge
```

Prints `outcome: changed` or `unchanged`. Reads the organisation's tenant account
row from the database, then brings its deploy role onto today's policy through
the management role.

### 3. `app` — in the task

```sh
check app --shape function
```

Ensures the tenant app's network and registry and prints, building nothing:
`pushNamespace` (`mh/<repository id>/production`), `pushesInCiAs` (the role CI
will push as, `mh-<id>-production-push`, which trusts only GitHub OIDC from the
repository) and the two tags to push, `release1` and `release2`. Needs: the
database (the repository's organisation and GitHub ids) and the management role.

### 4. The images — in CloudShell in the tenant account

Open CloudShell in the **tenant account** (`us-east-1`, a default environment, not
a VPC one), signed in to it through the console — an IAM Identity Center
permission set for that account, or a role switch into its
`OrganizationAccountAccessRole`. The session needs `sts:GetCallerIdentity`,
`ecr:GetAuthorizationToken`, and the push actions (`ecr:BatchCheckLayerAvailability`,
`ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`,
`ecr:PutImage`, `ecr:BatchGetImage`) on `mh/<repository id>/production`. Its
credentials are the console session's, short-lived; no key is created.

Fetch the fixture alone (the repository is public; nothing else is checked out):

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/motir-co/motir-core.git
git -C motir-core sparse-checkout set tests/fixtures/hosting/aws-fixture-app
```

Build and push both releases to the tags `app` printed. CloudShell is
`linux/amd64`, the architecture both shapes run. Lambda refuses an image index
with attestations, so with buildx present the build passes `--provenance=false`,
as `push` does:

```sh
export REGISTRY="$(aws sts get-caller-identity --query Account --output text).dkr.ecr.us-east-1.amazonaws.com"
export NAMESPACE="mh/<repository id>/production"
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "$REGISTRY"
PROVENANCE="$(docker buildx version >/dev/null 2>&1 && echo --provenance=false)"
for n in 1 2; do
  docker build --platform linux/amd64 $PROVENANCE --build-arg RELEASE=$n \
    --tag "$REGISTRY/$NAMESPACE:release-$n" motir-core/tests/fixtures/hosting/aws-fixture-app
  docker push "$REGISTRY/$NAMESPACE:release-$n"
  docker image inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/$NAMESPACE:release-$n"
done
```

The password is piped, never an argument and never printed. The two digests
differ: the release number is baked in at build. Leave the tenant account's
CloudShell open; the next steps run in the services account's again.

### 5. `deploy`, `page`, `release2`, `rollback` — in the task

```sh
check deploy --shape function
check probe --shape function
check page --shape function
check release2 --shape function
check rollback --shape function
```

| step       | prints                                                                       | needs                                                                                |
| ---------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `deploy`   | release 1, its state, its HTTPS address and origin credential                | the database, the management role                                                    |
| `probe`    | the health path with the origin secret, without it and with a wrong value    | the management role, outbound HTTPS                                                  |
| `page`     | `/health` and `/row` status, `release: 1`, the row                           | the management role; the function URL grant (function) or outbound HTTPS (container) |
| `release2` | release 2, then its `page`: `release: 2`                                     | as `deploy`, then as `page`                                                          |
| `rollback` | the serving release, then its `page`: `release: 1` again — no build, no push | the management role, then as `page`                                                  |

`page` sends either shape the origin secret derived from
`MOTIR_HOSTING_ORIGIN_SECRET_KEY`: a function release at its front door's URL
(MOTIR-10129), a container release at the load balancer. Only a function stack
applied before the front door is still described with SigV4, and `page` signs
that one with the task's own credentials. It retries a 5xx or an unreachable
release up to six times, five seconds apart: a function's first invocation and a
scale-from-zero database both answer 5xx while they wake. `status` and `probe`
work as on Fly. `probe` proves what admits the forwarder — a function's front
door, a container's load-balancer rule — with three reads of the health path:
2xx with the origin secret, 403 without it and 403 with a wrong value. A
function's 403s come from the front door, which never invokes the app for them
(the app's own log group, `/aws/lambda/mh-<id>`, shows no invocation for
them; the front door's, `/aws/lambda/mh-<id>-front-door`, shows all three).
`page` after it shows the request the front door admitted reaching the app.

### 6. `destroy` — in the task

```sh
check destroy --shape function
```

Prints the usage, its `compute` (`lambda` GB-seconds or `fargate` vCPU- and
GB-seconds), then no releases. Needs the database and the management role.

Repeat from step 3 with `--shape container`. State lives in the account, not in
the task, so any running worker task can take any step.

## What to look at in the console

In the **tenant account**, region `us-east-1`, while a release is up:

- **Function shape:** Lambda shows the function `mh-<id>` with its function URL
  (auth type `AWS_IAM`), and two published versions after `release2`, and its
  front door `mh-<id>-front-door` with a function URL of auth type `NONE` — the
  address `deploy` prints. Nothing named `mh-<id>` exists in Motir's own
  accounts.
- **Container shape:** ECS shows the Fargate service `mh-<id>` in the account's
  cluster; EC2 › Target groups shows its target group, and the account's load
  balancer has a host rule for the app that checks `X-Motir-Origin-Secret`.
- **Both:** ECR holds `mh/<id>/production` with `release-1` and `release-2`;
  CloudFormation shows the release stack and, after `destroy`, none.

After `destroy`, the release stack is gone and `check status` prints
`state: none`.

## Known open item

A container release's upstream is the load balancer's `*.elb.amazonaws.com`
name, which cannot carry a public ACM certificate, so HTTPS to it is unsettled.
The check uses the address the adapter returns as given and never disables TLS
verification. If the container `page` fails on TLS, record it against that open
item rather than working around it.
