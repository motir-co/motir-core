# AWS tenant stacks

The CloudFormation templates Motir applies in an organisation's own AWS tenant
account to host its applications, to the confirmed decision MOTIR-5769 §4 (the
"AWS functions" and "AWS containers" columns). They are the ONE source of AWS
infrastructure for the hosting adapter, and this directory is self-contained so
a repository can copy it whole: nothing in it refers to a file outside it.

| Template                 | One per                   | Stack name                   |
| ------------------------ | ------------------------- | ---------------------------- |
| `network.yaml`           | tenant account            | `motir-network`              |
| `registry.yaml`          | repository                | `motir-registry-<rid>`       |
| `database.yaml`          | application (repository)  | `motir-database-<rid>`       |
| `preview-database.yaml`  | preview                   | `motir-database-<rid>-pr<n>` |
| `function-release.yaml`  | (repository, environment) | `motir-release-<appRef>`     |
| `container-release.yaml` | (repository, environment) | `motir-release-<appRef>`     |

`<rid>` is the Motir repository id (a lowercase cuid), `<n>` the pull request,
and `<appRef>` the release's app name: `mh-<rid>` for production and
`mh-<rid>-pr<n>` for a preview. A repository's release runs in ONE shape, so the
two release templates share a stack name. `parameters.json` lists every
template's parameters (those without a default are required) and outputs.

## Naming

- **Every stack name begins `motir-`.** Resources are named from the stack's
  parameters (the repository id, the `appRef`), so applying a template again
  updates in place and never makes a second copy.
- **Every IAM role a template creates is named `motir-…`, at most 64
  characters** — `motir-<appRef>-fn` for a function and `motir-<appRef>-door` for
  its front door, `motir-<appRef>-exec` and
  `motir-<appRef>-task` for a container — except the two push roles, whose names
  the decision fixes: `mh-<rid>-preview-push` and `mh-<rid>-production-push`.
- The ECR repositories are `mh/<rid>/preview` and `mh/<rid>/production`.

## Tags

Every taggable resource carries `motir:organization` (the `OrganizationId`
parameter) and `motir:repository` (the `RepositoryId` parameter). The caller
applies both as stack tags too; the templates repeat them on every resource, so
a resource that does not inherit stack tags carries them as well. The network
stack belongs to no repository: its resources carry `motir:repository=shared`.

## Cross-stack values

A release, database or preview-database stack takes the network's and the
database's outputs as PARAMETERS (`PrivateSubnetIds`, `AppSecurityGroupId`,
`AlbListenerArn`, …), never `Fn::ImportValue`, so a stack can be copied and
applied without export names.

## The OIDC subject the push roles expect

The network stack declares the account's GitHub OIDC provider
(`token.actions.githubusercontent.com`, audience `sts.amazonaws.com`). The push
roles bind the GitHub repository by its immutable ids, never by its name, through
the token's `sub` claim. That needs the repository's OIDC subject template
customised (GitHub's `PUT /repos/{owner}/{repo}/actions/oidc/customization/sub`)
to `include_claim_keys: ["repository_owner_id", "repository_id", "context"]`,
which gives:

| Role                       | Expected `sub`                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `mh-<rid>-preview-push`    | `repository_owner_id:<GithubOwnerId>:repository_id:<GithubRepositoryId>:pull_request`           |
| `mh-<rid>-production-push` | `repository_owner_id:<GithubOwnerId>:repository_id:<GithubRepositoryId>:environment:production` |

So a pull-request workflow can push only previews, and only a job running in the
`production` environment can push production. Setting the subject template on
the GitHub side is not done by these templates.

An account holds one OIDC provider per URL. If the account already has one for
`token.actions.githubusercontent.com`, the network stack cannot create it and
the existing provider must be removed or imported first.

## Secrets

- The cluster's master credentials are `database.yaml`'s own tagged secret, not
  a password RDS manages, so a tag-scoped `GetSecretValue` reaches them.
- A connection secret (production's in `database.yaml`, a preview's in
  `preview-database.yaml`) is created holding a generated `password`; the hosting
  adapter adds the connection URL under the key `url`. A container receives it as
  the `DATABASE_URL` secret entry; a function receives its ARN.
- A release's own variables: the plain ones are in the function's environment
  or the task's `environment` (the hosting adapter writes them into the template
  at `# <release variables>`); the secret ones (and, for a function, any over
  Lambda's 4 KB) are in the release stack's own environment secret, at the
  secret version `ConfigHash` names, so each release reads the variables it was
  released with. A container gets each as a task `secrets` entry (written at
  `# <release secrets>`); a function's entrypoint loads the secret by ARN.
- Secret names carry the stack id's unique suffix, so a re-created stack never
  collides with a secret still scheduled for deletion.

## The function's front door

A function release is reached through its FRONT DOOR (MOTIR-10129, to the
decision MOTIR-10128), never through its own URL: a second, small function
`<appRef>-front-door` on a public function URL. It admits a request only when
its `X-Motir-Origin-Secret` header equals the `OriginSecret` parameter (the
caller derives it, as it does a container's), removes the header and invokes
the function's `live` alias with the same event; anything else is a 403 that
never reaches the app. So every forwarder presents the same credential to a
function as to a container, and no credential for this account is ever held
outside it. The function's own IAM-auth URL stays, for the forwarder principal
alone. The front door publishes a version per `FrontDoorRevision` (a hash of the
secret and the template) behind its own `live`, which carries provisioned
concurrency when the app is always on.

## Rollback

A function release publishes a version per image and RETAINS the version it
replaces, so a rollback points the `live` alias back at it. A container release
RETAINS the task-definition revision it replaces, so a rollback moves the
service back to it.

## The container's front door

A container release is reached through the network's FRONT DOOR (MOTIR-11846):
one CloudFront distribution per account, `https://<id>.cloudfront.net` with
CloudFront's own certificate, whose VPC origin is the account's load balancer.
The load balancer's `*.elb.amazonaws.com` name cannot carry a public
certificate, so TLS terminates at the distribution, and the hop on to the
load balancer runs over the AWS network to its plain-HTTP listener. The load
balancer is internal, in the private subnets, and its security group admits only
CloudFront's origin-facing prefix list, whose id the caller looks up and passes
as `CloudFrontOriginFacingPrefixListId`.

The distribution caches nothing and passes every viewer header but `Host` on, so
the load balancer sees the forwarder's `X-Motir-Origin-Secret`. A release's
listener rule matches that header ALONE: the secret is derived from the app's
name, so it picks the app as well as admitting it, and there is no app host and
no apps domain. Every container release in the account shares the one address;
the secret is what tells them apart. An answer slower than 60 seconds (the
origin read timeout, matching the load balancer's idle timeout) is a 504.

## Opening a production release (MOTIR-12128)

Every production release can be switched to answer WITHOUT Motir, for an app
whose repository is taken over, by the stack parameter `OriginAccess`
(`motir_edge`, the default, or `open`). Nothing else about the stack changes,
and `OriginSecret` stays, so Motir's edge keeps answering at the same moment.
The stack runner sends full parameter sets, so every deploy reads the stack's
current `OriginAccess` and sends it again: a deploy never closes an opened app.

- **Function release:** the front door runs with `MOTIR_FRONT_DOOR_MODE=open`
  and no `MOTIR_FRONT_DOOR_SECRET`, passes every request to `live` (still
  removing any `X-Motir-Origin-Secret` header) and keeps its 502 on a failed
  invoke. The app's address is the existing `FrontDoorUrl`. `FunctionUrl`
  stays `AWS_IAM`.
- **Container release:** the secret rule stays; a second rule at
  `OpenListenerRulePriority` matches `X-Motir-App: <AppRef>`, and the stack
  gains its own CloudFront distribution on the network's VPC origin
  (`FrontDoorVpcOriginId`, with `AlbDnsName` as the origin's name) that sets
  that header as an origin custom header, which CloudFront puts in place of any
  viewer header of the same name. The app's address is that distribution,
  output as `OpenUpstreamUrl`. The header is the app's public name, not a
  secret: no value derived from Motir's origin-secret key is in either open
  path.

## Copying the directory

Copy `aws-tenant-stacks/` whole into a repository and apply the templates in
order: the network once per account, then the registry, then the database (and
a preview-database per preview), then one release stack per environment, giving
each stack the outputs of the ones before it as parameters.
