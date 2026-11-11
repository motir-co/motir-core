# The AWS CI runner AMI

The machine image every AWS CI runner boots from (MOTIR-9272): x86_64 Ubuntu 24.04 in
`us-east-1`, with the same runner, Node, Docker and Playwright libraries as the Fly runner
image in [`infra/ci-runner/`](../ci-runner/), privileged Docker on its own 20 GB volume, and
one systemd unit that runs ONE job and powers the VM off.

It follows the Fly image rather than forking it. The three scripts the Fly container runs
(`entrypoint.sh`, `start-dockerd.sh`, `job-started.sh`) are copied into the AMI byte for
byte at build time. This directory adds only what a VM needs and a container does not.

| File                                 | What it is                                                                                                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packer/runner.pkr.hcl`              | The Packer template: the Ubuntu base from Canonical's SSM parameter, `m6i.large`, a 30 GB gp3 root, and a blank 20 GB gp3 `/dev/sdb` in the AMI's mapping.                                            |
| `provision.sh`                       | Runs once inside the build VM: the Dockerfile's apt packages, Node in the tool cache, the Docker static binaries, the Playwright libraries, the runner (with `config.sh` deleted), the `runner` user. |
| `boot/motir-runner-prepare.sh`       | The unit's `ExecStartPre`: user-data → the entrypoint's environment, the data volume at `/var/lib/docker`, the metadata service closed.                                                               |
| `boot/parse-user-data.sh`            | The user-data parser the hook calls: picks the boot mode and refuses anything that mode does not accept. Text in, files out, no network.                                                              |
| `boot/motir-vm-entrypoint.sh`        | The unit's `ExecStart`: execs the CI entrypoint in CI mode, the container entrypoint in container mode.                                                                                               |
| `boot/motir-container-entrypoint.sh` | Container mode: dockerd, pull ONE image by digest, run it once with the run's environment.                                                                                                            |
| `boot/motir-runner-report-exit.sh`   | The unit's first `ExecStopPost` (MOTIR-10706): one console line saying whether the runner took its job, so a runner GitHub refused is not read as one that finished. Never fails.                     |
| `boot/motir-ci-runner.service`       | The one unit: prepare, run the entrypoint, remove the env file, report the exit, power off when the entrypoint exits.                                                                                 |
| `build-ami.sh`                       | `validate` (no credentials) or `build`: reads the pins, runs Packer, prints the AMI id.                                                                                                               |

## Where the pins live

Only in [`infra/ci-runner/Dockerfile`](../ci-runner/Dockerfile), as the ARGs
`RUNNER_VERSION`, `RUNNER_SHA256`, `NODE_VERSION`, `NODE_SHA256`, `DOCKER_VERSION`,
`DOCKER_SHA256`, `AWSCLI_VERSION`, `AWSCLI_SHA256` and `PLAYWRIGHT_VERSION`. `build-ami.sh` reads them by grep and passes them
to Packer. Bump a version there and both the Fly image and the next AMI pick it up.
`tests/ciFleet/awsRunnerAmi.test.ts` fails if a version or a checksum is written anywhere in
this directory, or if `provision.sh`'s apt package list drifts from the Dockerfile's.

## Rebuilding

Merge the change, then push a release tag:

```sh
git tag ci-runner-ami-v<n> && git push origin ci-runner-ami-v<n>
```

or run **Release CI runner AMI** from the Actions tab. The workflow
(`.github/workflows/release-ci-runner-ami.yml`) validates, then builds in the build account
over OIDC. Its job summary carries the AMI id and the command to set it:

```sh
fly secrets set -a motir-core MOTIR_AWS_RUNNER_AMI_ID=ami-…
```

`MOTIR_AWS_RUNNER_AMI_ID` is the AWS counterpart of `MOTIR_RUNNER_IMAGE`: the AWS
orchestrator adapter launches runners from it. A rebuild is always a new, versioned AMI
(`motir-ci-runner-<runnerVersion>-<yyyymmddHHMM>-<sha7>`), never an edit of an old one, so
the setting only moves when a person moves it.

The code-graph indexer does not use this AMI. An AWS index VM boots the stock ECS-optimized
Amazon Linux 2023 AMI, which ships Docker, and pulls the indexer image (`MOTIR_INDEXER_IMAGE`,
pinned by digest) at boot. Set its id per region from AWS's public parameter:

```sh
aws ssm get-parameter --region us-east-1 --name /aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id --query Parameter.Value --output text
```

```sh
fly secrets set -a motir-core MOTIR_AWS_INDEXER_AMI_ID=ami-…
```

An index VM writes the indexer's exit code (or, when the pull fails, a pull-failure line) to its
serial console, then powers off. Unlike a runner it launches with shutdown behaviour `stop`, so a
finished index VM shows as **stopped** in the EC2 console until Motir has read the code and
terminates it at settle. A stopped `motir-index-…` instance that stays stopped is one nobody
settled; the orphan reaper terminates it.

To check the template locally without credentials:

```sh
infra/ci-runner-aws/build-ami.sh validate
```

### What the workflow reads

| Name                                    | Kind     | What                                                                                                      |
| --------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `MOTIR_AWS_AMI_BUILD_ROLE_ARN`          | secret   | The IAM role the build assumes over GitHub OIDC. No access key exists anywhere.                           |
| `MOTIR_AWS_ORG_ARN`                     | variable | The AWS Organization given launch permission, so every shard (member) account can launch the AMI.         |
| `MOTIR_AWS_AMI_BUILD_SUBNET_ID`         | variable | Optional. The subnet the build VM runs in.                                                                |
| `MOTIR_AWS_AMI_BUILD_SECURITY_GROUP_ID` | variable | Optional. The security group the build VM runs in, so Packer creates none. Needs the subnet variable too. |

In the services account both variables are required: they are the `motir-ami-build` stack's
`BuildSubnetId` and `BuildSecurityGroupId` outputs (motir-infra, MOTIR-10910), and the build
role may launch into nothing else. `MOTIR_AWS_AMI_BUILD_ROLE_ARN` is the same stack's
`BuildRoleArn`. `build-ami.sh` refuses a security group with no subnet, because a group
belongs to one VPC and the default VPC is not the build network's.

⚠️ **Packer does not create a VPC or a subnet.** It creates a temporary key pair and removes
it, and, unless `MOTIR_AWS_AMI_BUILD_SECURITY_GROUP_ID` names one, a temporary security group
too. The build VM runs in the build account's **default VPC** unless
`MOTIR_AWS_AMI_BUILD_SUBNET_ID` names a subnet (with a route to the internet and public IPs
on launch). An account without a default VPC can get one back with
`aws ec2 create-default-vpc --region us-east-1`.

### The build tag

Everything the build creates carries **`motir-shard = motir-ami-build`** (the stack's
`BuildTagKey` / `BuildTagValue` outputs): the build VM, its network interface and volumes, the
temporary key pair, the AMI and its snapshots. The services-account build role may create a
resource only when the create itself carries the tag, and may stop, terminate, delete,
deregister or share only what carries it, so it cannot touch the install fleet's VMs, volumes
or images. Packer is made to write the tag at create:

- `run_tags` carries it to RunInstances (instance and interface), CreateKeyPair, and
  CreateImage, which tags the AMI and its snapshots with the run tags;
- `run_volume_tags` carries it to the build VM's volumes;
- `tags` and `snapshot_tags` do **not** carry it. Packer writes those with a later
  CreateTags, which the role allows for any key except the build tag's.

So never set `skip_ami_run_tags`, and never add the build tag to `tags` or `snapshot_tags`:
either fails the build with an access denial. `tests/ciFleet/awsRunnerAmi.test.ts` holds all
three. The role grants no `CopyImage`, so the template uses no `ami_regions` and no
copy-to-encrypt step.

### An image built elsewhere is copied in before it is pinned

The images every pool boots are owned by the services account (MOTIR-10909). An AMI built in
any other account — the retired `ci-ami-build` account, or a hand build — is never set as
`MOTIR_AWS_RUNNER_AMI_ID` where it is. A person with services-account access copies it there
first, then shares the copy with the Organization, and pins the copy's id:

```sh
aws ec2 copy-image --region us-east-1 --source-region us-east-1 --source-image-id ami-… --name motir-ci-runner-… --copy-image-tags
```

```sh
aws ec2 modify-image-attribute --region us-east-1 --image-id ami-… --launch-permission "Add=[{OrganizationArn=arn:aws:organizations::…:organization/o-…}]"
```

The build role cannot do this: it has no `CopyImage`, because that action authorises only the
copy and so cannot be held to a build-tagged source.

Sharing is AMI launch permission only. EC2 cannot share a snapshot with an Organization,
and launching an unencrypted AMI shared this way needs no snapshot permission.

## The user-data contract

user-data is data, not a script: up to four `KEY=value` lines, nothing else.

```text
ACTIONS_RUNNER_INPUT_JITCONFIG=<the base64 JIT config>
MOTIR_RUNNER_LABEL=<the fleet label>
MOTIR_INTENT_ID=<the boot intent id>
MOTIR_WORKFLOW_JOB_ID=<the GitHub workflow job id>
```

`ACTIONS_RUNNER_INPUT_JITCONFIG` is required. Any other key, a duplicate, or a value outside
`[A-Za-z0-9+/=._:-]` fails the boot, and the VM powers itself off. cloud-init ignores text
that is not a script or cloud-config, so a mistake here cannot run code. The prepare hook
writes the lines to `/run/motir-ci-runner/env` (0600, root), adds
`MOTIR_RUNNER_DOCKER_STORAGE=overlay2`, deletes cloud-init's on-disk copies of user-data, and
the unit removes the env file once the entrypoint has started. Nothing prints a value.

### What the adapter must do at launch

The image cannot enforce these; the launch request must:

- map the AMI's block devices unchanged (the 20 GB `/dev/sdb` is Docker's data root, and the
  boot fails without it rather than filling the root disk);
- require IMDSv2 with hop limit 1, and attach **no** instance profile;
- set `InstanceInitiatedShutdownBehavior=terminate`, so the power-off at the end of the job
  ends the instance; terminating it again at settle is harmless.

## Container mode

The same AMI, and the same `MOTIR_AWS_RUNNER_AMI_ID`, also boots a hosted agent run
(MOTIR-9419): one OCI image, pulled by digest and run once, the way a Fly Machine runs the
hosted-agent image. user-data alone chooses the mode; user-data with no mode line is CI mode,
exactly as above.

```text
MOTIR_BOOT_MODE=container
MOTIR_CONTAINER_IMAGE=<registry>/<repo>@sha256:<64 hex>
MOTIR_ENV_<NAME>=<value>
```

- `MOTIR_BOOT_MODE=container` is the mode line. Any other value is refused.
- `MOTIR_CONTAINER_IMAGE` is required and must be pinned by digest: a tag, a missing digest,
  a digest that is not 64 hex characters or anything after it is refused.
- Each `MOTIR_ENV_<NAME>=<value>` line becomes `<NAME>=<value>` in the container's
  environment, the value unchanged. `<NAME>` must match `^[A-Z_][A-Z0-9_]*$`. The prefix keeps
  the container's environment apart from the host's, so no line can set a host variable.
- Any other key, any of the four CI keys, a repeated key, or a line that is not `KEY=value`
  fails the boot before anything is pulled, and the VM powers itself off. Which `<NAME>`s a run
  may carry is the adapter's allow-list; the AMI enforces the shape.

The prepare hook runs the same disk mount, `MOTIR_RUNNER_DOCKER_STORAGE=overlay2` and
metadata block in both modes. The container entrypoint then starts dockerd, pulls the image
**anonymously** (there is no pull credential on the VM), checks the pulled image's
`RepoDigests` holds the requested digest, creates it with `--env-file`, `--cap-drop ALL` and
`--security-opt no-new-privileges` (no privilege, no host network, no mount, no Docker
socket), deletes the env file, and `exec`s `docker start --attach`. The container's exit is
the unit's exit, and the unit powers the VM off.

### The metadata service

On EC2 anything on the instance can read user-data back from `169.254.169.254`, and
user-data holds the JIT config. Once the prepare hook has read it, it rejects that address
for the `runner` user, for every other user (the runner has passwordless sudo), and in
Docker's `DOCKER-USER` chain for containers on the bridge.

## Deleting an old AMI

Deregistering does not delete its snapshots; do both:

```sh
aws ec2 describe-images --region us-east-1 --image-ids ami-… \
  --query 'Images[0].BlockDeviceMappings[].Ebs.SnapshotId' --output text
```

```sh
aws ec2 deregister-image --region us-east-1 --image-id ami-…
```

```sh
aws ec2 delete-snapshot --region us-east-1 --snapshot-id snap-…
```

Check first that no setting still names the AMI (`MOTIR_AWS_RUNNER_AMI_ID`).

## Not here

Running the first build and setting the id (MOTIR-9282), measuring a boot (MOTIR-9274), the
adapter (MOTIR-9276) and the network (MOTIR-9273) are their own cards. So are other regions,
Graviton, spot, and AMI lifecycle automation.
