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
# Packer creates its own temporary key pair and security group, and removes
# both, but it does not create a VPC or a subnet.

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

# Canonical's own public parameter: the latest Ubuntu 24.04 amd64 gp3 AMI at
# build time. No AMI id is written down anywhere; the one used is recorded in
# the BaseAmi tag.
data "amazon-parameterstore" "ubuntu_noble" {
  region = "us-east-1"
  name   = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

locals {
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

  temporary_key_pair_type = "ed25519"

  ami_name        = local.ami_name
  ami_description = "Motir CI runner: Ubuntu 24.04, GitHub runner ${var.runner_version}, Docker on a 20 GB data volume (${substr(var.git_sha, 0, 7)})"
  ami_org_arns    = var.org_arns
  # Instances launched from the AMI accept IMDSv2 only.
  imds_support = "v2.0"
  ena_support  = true
  # Left unencrypted so it can be shared with member accounts; it holds no secret.
  encrypt_boot = false

  tags          = local.tags
  snapshot_tags = local.tags
  run_tags      = { Name = "packer-${local.ami_name}" }

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
      "PLAYWRIGHT_VERSION=${var.playwright_version}",
    ]
  }

  # build-ami.sh reads the AMI id out of this file.
  post-processor "manifest" {
    output     = var.manifest_path
    strip_path = true
  }
}
