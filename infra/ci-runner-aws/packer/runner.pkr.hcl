# The AWS CI runner AMI (MOTIR-9272): x86_64 Ubuntu 24.04 in us-east-1, with the
# Fly runner image's toolchain, privileged Docker, the GitHub runner and a
# second 20 GB volume for Docker's data root.
#
# Built by `infra/ci-runner-aws/build-ami.sh`, which reads every version and
# checksum from `infra/ci-runner/Dockerfile` and passes them in as variables —
# none is written here. `packer validate` needs no AWS credentials (data
# sources are not evaluated during validation), which is what the workflow's
# validate job runs on every pull request.
#
# The build VM runs in the account's DEFAULT VPC unless `subnet_id` names one.
# With `security_group_id` given, Packer creates no security group; without it,
# Packer creates a temporary one and removes it. It always creates a temporary
# key pair, tagged with `run_tags`, and it never creates a VPC or a subnet.
#
# THE BUILD TAG (MOTIR-10909). The services-account build role (motir-infra's
# `motir-ami-build`, MOTIR-10910) may create a resource only when the create
# itself carries `motir-shard = motir-ami-build`, and may act only on resources
# that carry it. So the tag is written AT CREATE, never after:
#   - `run_tags`        -> RunInstances' instance and network interface, the
#                          temporary key pair, and CreateImage's image and its
#                          snapshots (Packer attaches the run tags to the AMI
#                          unless `skip_ami_run_tags` is set, which it is not);
#   - `run_volume_tags` -> RunInstances' volumes.
# It is deliberately NOT in `tags` or `snapshot_tags`: Packer applies those with
# a later CreateTags, which the role allows for every key except the build tag's.

packer {
  required_plugins {
    amazon = {
      version = "= 1.8.3"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "runner_version" {
  type        = string
  description = "infra/ci-runner/Dockerfile ARG RUNNER_VERSION."
  validation {
    condition     = can(regex("^[0-9]+(\\.[0-9]+)+$", var.runner_version))
    error_message = "The runner_version must be a dotted version number."
  }
}

variable "runner_sha256" {
  type        = string
  description = "infra/ci-runner/Dockerfile ARG RUNNER_SHA256."
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.runner_sha256))
    error_message = "The runner_sha256 must be 64 hex characters."
  }
}

variable "node_version" {
  type        = string
  description = "infra/ci-runner/Dockerfile ARG NODE_VERSION."
}

variable "node_sha256" {
  type        = string
  description = "infra/ci-runner/Dockerfile ARG NODE_SHA256."
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.node_sha256))
    error_message = "The node_sha256 must be 64 hex characters."
  }
}

variable "docker_version" {
  type        = string
  description = "infra/ci-runner/Dockerfile ARG DOCKER_VERSION."
}

variable "docker_sha256" {
  type        = string
  description = "infra/ci-runner/Dockerfile ARG DOCKER_SHA256."
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.docker_sha256))
    error_message = "The docker_sha256 must be 64 hex characters."
  }
}

variable "awscli_version" {
  type        = string
  description = "infra/ci-runner/Dockerfile ARG AWSCLI_VERSION."
  validation {
    condition     = can(regex("^[0-9]+(\\.[0-9]+)+$", var.awscli_version))
    error_message = "The awscli_version must be a dotted version number."
  }
}

variable "awscli_sha256" {
  type        = string
  description = "infra/ci-runner/Dockerfile ARG AWSCLI_SHA256."
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.awscli_sha256))
    error_message = "The awscli_sha256 must be 64 hex characters."
  }
}

variable "playwright_version" {
  type        = string
  description = "infra/ci-runner/Dockerfile ARG PLAYWRIGHT_VERSION."
}

variable "git_sha" {
  type        = string
  description = "The motir-core commit the AMI is built from (40 hex)."
  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.git_sha))
    error_message = "The git_sha must be a full 40-character commit SHA."
  }
}

variable "version" {
  type        = string
  description = "The release this build belongs to: the ci-runner-ami-v* tag, or manual-<sha7>."
}

variable "org_arns" {
  type        = list(string)
  default     = []
  description = "AWS Organization ARNs given launch permission on the AMI. Empty: the AMI stays private to the build account."
}

variable "manifest_path" {
  type        = string
  default     = "packer-manifest.json"
  description = "Where the manifest post-processor writes the built AMI id."
}

variable "subnet_id" {
  type        = string
  default     = ""
  description = "The subnet the build VM runs in. Empty: the account's default VPC."
}

variable "security_group_id" {
  type        = string
  default     = ""
  description = "The security group the build VM runs in; it must admit SSH and belong to subnet_id's VPC. Empty: Packer creates a temporary one."
  validation {
    condition     = var.security_group_id == "" || can(regex("^sg-[0-9a-f]+$", var.security_group_id))
    error_message = "The security_group_id must be empty or a security group id (sg-...)."
  }
}

# Canonical's own public parameter: the latest Ubuntu 24.04 amd64 gp3 AMI at
# build time. No AMI id is written down anywhere; the one used is recorded in
# the BaseAmi tag.
data "amazon-parameterstore" "ubuntu_noble" {
  region = "us-east-1"
  name   = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

locals {
  # The tag the build role keys on — motir-infra's BuildTagKey / BuildTagValue
  # stack outputs. See THE BUILD TAG at the top.
  build_tag = { "motir-shard" = "motir-ami-build" }
  timestamp = formatdate("YYYYMMDDhhmm", timestamp())
  ami_name  = "motir-ci-runner-${var.runner_version}-${local.timestamp}-${substr(var.git_sha, 0, 7)}"
  tags = {
    Name          = local.ami_name
    Version       = var.version
    RunnerVersion = var.runner_version
    GitSha        = var.git_sha
    BaseAmi       = data.amazon-parameterstore.ubuntu_noble.value
  }
}

source "amazon-ebs" "runner" {
  region        = "us-east-1"
  source_ami    = data.amazon-parameterstore.ubuntu_noble.value
  instance_type = "m6i.large"
  subnet_id     = var.subnet_id
  ssh_username  = "ubuntu"

  # Given: Packer launches into it and creates no group. Empty: Packer creates
  # a temporary group (an account whose role may create one).
  security_group_id = var.security_group_id

  temporary_key_pair_type = "ed25519"

  ami_name        = local.ami_name
  # The full commit, because a shared AMI's tags (GitSha above) are visible only
  # in this build account; the accounts it is shared with see the name and this
  # description, and the daily health check reads the commit from here
  # (MOTIR-10395, lib/ciFleet/runnerImageSources.ts amiBuildCommitFrom).
  ami_description = "Motir CI runner: Ubuntu 24.04, GitHub runner ${var.runner_version}, Docker on a 20 GB data volume (commit ${var.git_sha})"
  ami_org_arns    = var.org_arns
  # Instances launched from the AMI accept IMDSv2 only.
  imds_support = "v2.0"
  ena_support  = true
  # Left unencrypted so it can be shared with member accounts; it holds no secret.
  encrypt_boot = false

  # The build tag only at create (run_tags, run_volume_tags); see THE BUILD TAG.
  tags            = local.tags
  snapshot_tags   = local.tags
  run_tags        = merge(local.build_tag, { Name = "packer-${local.ami_name}" })
  run_volume_tags = merge(local.build_tag, { Name = "packer-${local.ami_name}" })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  # The root volume, for the build VM and for the AMI made from it.
  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = 30
    volume_type           = "gp3"
    delete_on_termination = true
  }

  # Docker's data root: a blank volume added to the AMI's mapping only, so every
  # launch gets a fresh one and the build VM never sees it. The boot hook finds
  # it by elimination, formats it and mounts it at /var/lib/docker.
  ami_block_device_mappings {
    device_name           = "/dev/sdb"
    volume_size           = 20
    volume_type           = "gp3"
    delete_on_termination = true
  }
}

build {
  sources = ["source.amazon-ebs.runner"]

  provisioner "shell" {
    inline = ["mkdir -p /tmp/motir-ci-runner"]
  }

  # The Fly image's three scripts, uploaded as they are in the tree and
  # installed unchanged by provision.sh.
  provisioner "file" {
    source      = "${path.root}/../../ci-runner/entrypoint.sh"
    destination = "/tmp/motir-ci-runner/entrypoint.sh"
  }

  provisioner "file" {
    source      = "${path.root}/../../ci-runner/start-dockerd.sh"
    destination = "/tmp/motir-ci-runner/start-dockerd.sh"
  }

  provisioner "file" {
    source      = "${path.root}/../../ci-runner/job-started.sh"
    destination = "/tmp/motir-ci-runner/job-started.sh"
  }

  provisioner "file" {
    source      = "${path.root}/../boot/motir-runner-prepare.sh"
    destination = "/tmp/motir-ci-runner/motir-runner-prepare.sh"
  }

  provisioner "file" {
    source      = "${path.root}/../boot/parse-user-data.sh"
    destination = "/tmp/motir-ci-runner/parse-user-data.sh"
  }

  provisioner "file" {
    source      = "${path.root}/../boot/motir-vm-entrypoint.sh"
    destination = "/tmp/motir-ci-runner/motir-vm-entrypoint.sh"
  }

  provisioner "file" {
    source      = "${path.root}/../boot/motir-container-entrypoint.sh"
    destination = "/tmp/motir-ci-runner/motir-container-entrypoint.sh"
  }

  provisioner "file" {
    source      = "${path.root}/../boot/motir-runner-report-exit.sh"
    destination = "/tmp/motir-ci-runner/motir-runner-report-exit.sh"
  }

  provisioner "file" {
    source      = "${path.root}/../boot/motir-ci-runner.service"
    destination = "/tmp/motir-ci-runner/motir-ci-runner.service"
  }

  provisioner "shell" {
    script          = "${path.root}/../provision.sh"
    execute_command = "chmod +x {{ .Path }}; sudo env {{ .Vars }} bash {{ .Path }}"
    environment_vars = [
      "RUNNER_VERSION=${var.runner_version}",
      "RUNNER_SHA256=${var.runner_sha256}",
      "NODE_VERSION=${var.node_version}",
      "NODE_SHA256=${var.node_sha256}",
      "DOCKER_VERSION=${var.docker_version}",
      "DOCKER_SHA256=${var.docker_sha256}",
      "AWSCLI_VERSION=${var.awscli_version}",
      "AWSCLI_SHA256=${var.awscli_sha256}",
      "PLAYWRIGHT_VERSION=${var.playwright_version}",
    ]
  }

  # build-ami.sh reads the AMI id out of this file.
  post-processor "manifest" {
    output     = var.manifest_path
    strip_path = true
  }
}
