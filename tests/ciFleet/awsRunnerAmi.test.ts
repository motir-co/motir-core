import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// THE AWS RUNNER AMI's sources, guarded against drift (MOTIR-9272).
//
// The AMI is built in AWS by `.github/workflows/release-ci-runner-ami.yml`, so
// nothing here can boot it — the boot itself is MOTIR-9274's to measure. What
// this file guards is everything checkable from the text, in the style of
// `ciRunnerImage.test.ts` for the Fly image, and above all the two ways the AMI
// can quietly stop being the Fly image's twin: a pin written a second time in
// `infra/ci-runner-aws/`, and a Fly script rewritten instead of copied.

const ROOT = process.cwd();
const AWS_DIR = join(ROOT, 'infra/ci-runner-aws');
const FLY_DIR = join(ROOT, 'infra/ci-runner');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const dockerfile = read('infra/ci-runner/Dockerfile');
const template = read('infra/ci-runner-aws/packer/runner.pkr.hcl');
const provision = read('infra/ci-runner-aws/provision.sh');
const prepare = read('infra/ci-runner-aws/boot/motir-runner-prepare.sh');
const unit = read('infra/ci-runner-aws/boot/motir-ci-runner.service');
const parser = read('infra/ci-runner-aws/boot/parse-user-data.sh');
const vmEntrypoint = read('infra/ci-runner-aws/boot/motir-vm-entrypoint.sh');
const containerEntrypoint = read('infra/ci-runner-aws/boot/motir-container-entrypoint.sh');
const buildAmi = read('infra/ci-runner-aws/build-ami.sh');
const readme = read('infra/ci-runner-aws/README.md');
const workflowSource = read('.github/workflows/release-ci-runner-ami.yml');
const workflow = parse(workflowSource) as {
  on: Record<string, unknown>;
  jobs: Record<string, { if?: string; permissions?: Record<string, string>; steps: Step[] }>;
};
type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
};

/** Executable lines only: a comment is free to name what the code must not do. */
function code(source: string): string {
  return source
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s+#.*$/, ''))
    .filter((l) => l.trim() !== '')
    .join('\n');
}

/** Every file under `infra/ci-runner-aws/`, as repo-relative paths. */
function awsFiles(dir = AWS_DIR): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? awsFiles(full) : [relative(ROOT, full)];
  });
}

/** The value of `ARG <name>=<value>` in the Fly Dockerfile. */
function arg(name: string): string {
  const m = new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(dockerfile);
  if (!m) throw new Error(`no ARG ${name} in the Dockerfile`);
  return m[1]!;
}

/** The package names of the Dockerfile's base `apt-get install` block. */
function dockerfileAptPackages(): string[] {
  const block = /apt-get install -y --no-install-recommends \\\n([\s\S]*?)&& rm -rf/.exec(
    dockerfile,
  );
  if (!block) throw new Error('no apt-get install block in the Dockerfile');
  return block[1]!
    .split('\n')
    .map((l) => l.replace(/\\$/, '').trim())
    .filter(Boolean)
    .sort();
}

/** The package names of `provision.sh`'s APT_PACKAGES array. */
function provisionAptPackages(source: string): string[] {
  const block = /^APT_PACKAGES=\(\n([\s\S]*?)^\)/m.exec(source);
  if (!block) throw new Error('no APT_PACKAGES array in provision.sh');
  return block[1]!
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

/** A named HCL block's body, by its opening line (blocks here nest one level). */
function hclBlock(source: string, opening: RegExp): string {
  const start = source.search(opening);
  if (start === -1) throw new Error(`no block matching ${opening}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated block matching ${opening}`);
}

describe('the template — Ubuntu 24.04 x86_64 in us-east-1, with no AMI id written down', () => {
  it('takes its base from Canonical’s SSM public parameter and names no literal ami- id', () => {
    expect(template).toContain('data "amazon-parameterstore" "ubuntu_noble"');
    expect(template).toContain(
      'name   = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"',
    );
    expect(template).toContain('source_ami    = data.amazon-parameterstore.ubuntu_noble.value');
    expect(code(template)).not.toMatch(/\bami-[0-9a-f]{8,}/);
  });

  it('builds x86_64 on m6i.large in us-east-1', () => {
    const source = hclBlock(template, /source "amazon-ebs" "runner"/);
    expect(source).toMatch(/region\s+= "us-east-1"/);
    expect(source).toMatch(/instance_type\s+= "m6i\.large"/);
    // The parameter is the amd64 one; m6i is an x86_64 family.
    expect(template).toContain('/amd64/');
  });

  it('maps a 30 GB gp3 root and a blank 20 GB gp3 /dev/sdb that dies with the instance', () => {
    const root = hclBlock(template, /launch_block_device_mappings \{/);
    expect(root).toMatch(/device_name\s+= "\/dev\/sda1"/);
    expect(root).toMatch(/volume_size\s+= 30\b/);
    expect(root).toMatch(/volume_type\s+= "gp3"/);
    const data = hclBlock(template, /ami_block_device_mappings \{/);
    expect(data).toMatch(/device_name\s+= "\/dev\/sdb"/);
    expect(data).toMatch(/volume_size\s+= 20\b/);
    expect(data).toMatch(/volume_type\s+= "gp3"/);
    expect(data).toMatch(/delete_on_termination\s+= true/);
    expect(data).not.toContain('snapshot_id');
  });

  it('registers the AMI IMDSv2-only and unencrypted, so it can be shared', () => {
    expect(template).toMatch(/imds_support\s+= "v2\.0"/);
    expect(template).toMatch(/encrypt_boot\s+= false/);
  });

  it('names the AMI motir-ci-runner-<runnerVersion>-<timestamp>-<sha7> and tags it', () => {
    expect(template).toContain(
      'ami_name  = "motir-ci-runner-${var.runner_version}-${local.timestamp}-${substr(var.git_sha, 0, 7)}"',
    );
    expect(template).toContain('formatdate("YYYYMMDDhhmm", timestamp())');
    const tags = hclBlock(template, /tags = \{/);
    for (const tag of ['Name', 'Version', 'RunnerVersion', 'GitSha', 'BaseAmi']) {
      expect(tags).toMatch(new RegExp(`^\\s+${tag}\\s+=`, 'm'));
    }
    expect(template).toMatch(/^\s+tags\s+= local\.tags$/m);
  });

  it('shares with the Organization ARNs it is given, and with nobody by default', () => {
    expect(template).toMatch(/ami_org_arns\s+= var\.org_arns/);
    expect(hclBlock(template, /variable "org_arns"/)).toContain('default     = []');
  });
});

describe('the pins live once, in infra/ci-runner/Dockerfile', () => {
  const PIN_ARGS = [
    'RUNNER_VERSION',
    'RUNNER_SHA256',
    'NODE_VERSION',
    'NODE_SHA256',
    'DOCKER_VERSION',
    'DOCKER_SHA256',
    'PLAYWRIGHT_VERSION',
  ];

  it('no file in infra/ci-runner-aws/ carries a runner, Node, Docker or Playwright pin', () => {
    const files = awsFiles();
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const text = read(file);
      for (const name of PIN_ARGS) {
        expect(text.includes(arg(name)), `${file} repeats ${name}=${arg(name)}`).toBe(false);
      }
      // Any 64-hex string is a checksum written a second time. (The Ubuntu
      // 24.04 in Canonical's parameter path is a release name, not a pin.)
      expect(text, `${file} carries a 64-hex checksum`).not.toMatch(/\b[0-9a-f]{64}\b/);
    }
  });

  it('build-ami.sh reads every pin from the Dockerfile by grep and passes it to Packer', () => {
    expect(buildAmi).toContain('DOCKERFILE="${ROOT}/infra/ci-runner/Dockerfile"');
    expect(buildAmi).toContain('grep -E "^ARG $1=" "${DOCKERFILE}"');
    for (const name of PIN_ARGS) {
      expect(buildAmi).toContain(`-var "${name.toLowerCase()}=$(pin ${name})"`);
      // …and the template hands each one to provision.sh under its own name.
      expect(template).toContain(`"${name}=\${var.${name.toLowerCase()}}"`);
    }
  });

  it('provision.sh installs exactly the Dockerfile’s apt package set', () => {
    expect(provisionAptPackages(provision)).toEqual(dockerfileAptPackages());
  });

  it('the package comparison fails on drift', () => {
    // The control: the same parser over a provision.sh missing one package.
    const drifted = provision.replace(/^ {2}jq\n/m, '');
    expect(drifted).not.toBe(provision);
    expect(provisionAptPackages(drifted)).not.toEqual(dockerfileAptPackages());
  });

  it('provision.sh checksum-verifies every download it makes', () => {
    const body = code(provision);
    const downloads = body.match(/curl -fsSLo/g)?.length ?? 0;
    expect(downloads).toBe(3);
    expect(body.match(/sha256sum -c -/g)?.length ?? 0).toBe(downloads);
  });
});

describe('the Fly scripts are copied, never rewritten', () => {
  const FLY_SCRIPTS = ['entrypoint.sh', 'start-dockerd.sh', 'job-started.sh'];

  it('the template uploads the three scripts from infra/ci-runner/', () => {
    for (const script of FLY_SCRIPTS) {
      expect(template).toContain(`source      = "\${path.root}/../../ci-runner/${script}"`);
      expect(template).toContain(`destination = "/tmp/motir-ci-runner/${script}"`);
    }
  });

  it('provision.sh installs them under the names the Fly image uses', () => {
    // The same destinations as the Dockerfile's COPY lines, so the entrypoint
    // finds `motir-ci-runner-dockerd` and the job-started hook where it looks.
    const installs: Record<string, string> = {
      'entrypoint.sh': '/usr/local/bin/motir-ci-runner-entrypoint',
      'start-dockerd.sh': '/usr/local/bin/motir-ci-runner-dockerd',
      'job-started.sh': '/usr/local/bin/motir-ci-runner-job-started.sh',
    };
    for (const [script, dest] of Object.entries(installs)) {
      expect(provision).toContain(`install -m 0755 "\${STAGING}/${script}" ${dest}`);
      expect(dockerfile).toContain(`${script} ${dest}`);
    }
  });

  it('no file in infra/ci-runner-aws/ carries a second copy of their logic', () => {
    for (const file of awsFiles().filter((f) => !f.endsWith('.md'))) {
      const body = code(read(file));
      expect(body, file).not.toContain('--jitconfig');
      expect(body, file).not.toContain('setpriv');
      expect(body, file).not.toContain('.wh.gone');
      expect(body, file).not.toMatch(/dockerd --host/);
    }
  });

  it('nothing in infra/ci-runner/ refers to the AWS image', () => {
    // This card adds a directory beside the Fly image and edits nothing in it.
    for (const file of ['Dockerfile', ...FLY_SCRIPTS]) {
      expect(readFileSync(join(FLY_DIR, file), 'utf8')).not.toContain('ci-runner-aws');
    }
  });

  it('provision.sh deletes config.sh and config.cmd from the runner', () => {
    expect(provision).toContain('rm -f config.sh config.cmd');
    expect(provision).toContain('test ! -e config.sh');
    // The only executable mentions are the delete and the check after it.
    const offenders = code(provision)
      .split('\n')
      .filter((l) => l.includes('config.sh') && !/rm -f|test ! -e/.test(l));
    expect(offenders).toEqual([]);
  });

  it('provision.sh creates the runner user as the image does: sudo and docker', () => {
    expect(provision).toMatch(/useradd --uid 1001 .*runner/);
    expect(provision).toContain('usermod -aG docker runner');
    expect(provision).toContain("echo 'runner ALL=(ALL) NOPASSWD:ALL'");
    expect(code(provision)).not.toContain('RUNNER_ALLOW_RUNASROOT');
  });

  it('provision.sh installs and enables the boot unit and its hook', () => {
    expect(provision).toContain(
      'install -m 0755 "${STAGING}/motir-runner-prepare.sh" /usr/local/sbin/motir-runner-prepare',
    );
    expect(provision).toContain(
      'install -m 0644 "${STAGING}/motir-ci-runner.service" /etc/systemd/system/motir-ci-runner.service',
    );
    expect(provision).toContain('systemctl enable motir-ci-runner.service');
  });
});

describe('the boot hook — user-data in, the Docker volume mounted, the metadata service closed', () => {
  const body = code(prepare);

  it('reads user-data over IMDSv2: a session token first, then the read with it', () => {
    expect(body).toContain('-X PUT');
    expect(body).toContain("'X-aws-ec2-metadata-token-ttl-seconds: 60'");
    expect(body).toContain('"${IMDS}/latest/api/token"');
    expect(body).toContain('-H "X-aws-ec2-metadata-token: ${token}" "${IMDS}/latest/user-data"');
  });

  it('accepts exactly the four keys of the entrypoint’s contract and refuses any other', () => {
    // The parse lives in parse-user-data.sh since MOTIR-9419; the hook calls it.
    const parse = code(parser);
    expect(parse).toContain(
      'CI_KEYS=(ACTIONS_RUNNER_INPUT_JITCONFIG MOTIR_RUNNER_LABEL MOTIR_INTENT_ID MOTIR_WORKFLOW_JOB_ID)',
    );
    expect(parse).toContain('is_ci_key "${key}" || die');
    expect(body).toContain('PARSER=/usr/local/sbin/motir-parse-user-data');
    expect(body).toContain('"${PARSER}" "${raw}" "${STATE_DIR}"');
    expect(body).not.toContain('KNOWN_KEYS');
    // The four keys are the ones the Fly entrypoint reads.
    const entrypoint = readFileSync(join(FLY_DIR, 'entrypoint.sh'), 'utf8');
    for (const key of [
      'ACTIONS_RUNNER_INPUT_JITCONFIG',
      'MOTIR_RUNNER_LABEL',
      'MOTIR_INTENT_ID',
      'MOTIR_WORKFLOW_JOB_ID',
    ]) {
      expect(entrypoint).toContain(key);
    }
  });

  it('writes the env file 0600, owned by root, before any value goes into it', () => {
    expect(body).toContain('install -d -m 0700 -o root -g root "${ENV_DIR}"');
    expect(body).toMatch(/chmod 0600 "\$\{tmp\}"[\s\S]*cat "\$\{STATE_DIR\}\/env" >>"\$\{tmp\}"/);
    // The parser writes under umask 077 and the raw user-data copy is 0600 first.
    expect(code(parser)).toMatch(/umask 077[\s\S]*TMP_DIR="\$\(mktemp -d/);
    expect(body).toMatch(/chmod 0600 "\$\{raw\}"[\s\S]*printf '%s\\n' "\$\{data\}" >"\$\{raw\}"/);
    expect(body).toContain('chown root:root "${ENV_FILE}"');
    expect(body).toContain('chmod 0600 "${ENV_FILE}"');
    expect(body).toContain('ENV_DIR=/run/motir-ci-runner');
  });

  it('forces overlay2, so the vfs fallback cannot hide a bad disk (MOTIR-8839)', () => {
    expect(body).toContain('printf \'MOTIR_RUNNER_DOCKER_STORAGE=overlay2\\n\' >>"${tmp}"');
  });

  it('mounts the blank data disk at /var/lib/docker, formatting it only when it has no filesystem', () => {
    expect(body).toContain('DOCKER_ROOT=/var/lib/docker');
    expect(body).toContain('blkid -o value -s TYPE "/dev/${disk}"');
    expect(body).toMatch(/if \[ -z "\$\{fstype\}" \]; then[\s\S]*mkfs\.ext4/);
    expect(body).toContain('mount -o noatime /dev/"${disk}" "${DOCKER_ROOT}"');
    // The disk is found by elimination, never by a device name.
    expect(body).toContain('findmnt -no SOURCE /');
    expect(body).not.toMatch(/\/dev\/(sdb|xvdb|nvme1n1)\b/);
  });

  it('closes 169.254.169.254 for uid runner, for every user, and in DOCKER-USER', () => {
    expect(body).toContain('-d 169.254.169.254/32 -m owner --uid-owner runner -j REJECT');
    expect(body).toContain('iptables -w -I OUTPUT 1 -d 169.254.169.254/32 -j REJECT');
    expect(body).toContain('iptables -w -I DOCKER-USER 1 -d 169.254.169.254/32 -j REJECT');
  });

  it('closes it only AFTER user-data is read', () => {
    const main = body.slice(body.indexOf('main() {'));
    expect(main.indexOf('read_user_data')).toBeLessThan(main.indexOf('block_metadata_service'));
  });

  it('deletes cloud-init’s on-disk copies of user-data', () => {
    expect(body).toContain('rm -f /var/lib/cloud/instances/*/user-data.txt');
  });

  it('never powers the VM off itself — the unit does that', () => {
    expect(body).not.toMatch(/poweroff|shutdown|halt/);
  });
});

const boot = {
  'motir-runner-prepare.sh': code(prepare),
  'motir-ci-runner.service': code(unit),
  'parse-user-data.sh': code(parser),
  'motir-vm-entrypoint.sh': code(vmEntrypoint),
};
// Every boot file, the container entrypoint included (it pulls ONE image).
const allBoot = { ...boot, 'motir-container-entrypoint.sh': code(containerEntrypoint) };

describe('the boot files download nothing, trace nothing, print no secret', () => {
  it.each(Object.entries(boot))(
    '%s runs no package manager, pull or runner download',
    (_name, body) => {
      expect(body).not.toMatch(
        /\bapt(-get)?\b|\bdnf\b|\byum\b|\bpip3?\b|\bnpm\b|\bnpx\b|\bsnap install\b/,
      );
      expect(body).not.toMatch(/docker pull|wget|releases\/download|actions-runner-linux/);
    },
  );

  it('the only network calls in the hook go to the metadata service', () => {
    const curls = code(prepare)
      .split('\n')
      .filter((l) => /\bcurl\b/.test(l));
    expect(curls.length).toBe(2);
    // Each curl's URL is on its continuation line and is the IMDS variable.
    expect(code(prepare)).not.toMatch(/https?:\/\/(?!169\.254\.169\.254)/);
  });

  it.each(Object.entries(allBoot))('%s never enables tracing', (_name, body) => {
    expect(body).not.toMatch(/set -[a-z]*x|set -o xtrace|bash -x/);
  });

  it('never prints a user-data value', () => {
    // A value is only ever written to the env file; every log or die line names
    // keys, never `${value}`, `${line}`, `${data}` or the JIT variable.
    const messages = Object.values(allBoot).flatMap((body) =>
      [...body.matchAll(/\b(?:log|die|echo)\s+"([^"]*)"/g)].map((m) => m[1]!),
    );
    expect(messages.length).toBeGreaterThan(15);
    for (const message of messages) {
      expect(message).not.toMatch(
        /\$\{?(value|line|data|user_data|raw|name|ACTIONS_RUNNER_INPUT_JITCONFIG)\b/,
      );
    }
  });

  it('the unit removes the env file once the entrypoint has started', () => {
    expect(unit).toMatch(/^Type=exec$/m);
    expect(unit).toMatch(/^ExecStartPost=\/usr\/bin\/rm -f \/run\/motir-ci-runner\/env$/m);
  });
});

describe('the unit — one job, then the VM powers off', () => {
  it('prepares, then runs the Fly entrypoint with the env file the hook wrote', () => {
    expect(unit).toMatch(/^ExecStartPre=\/usr\/local\/sbin\/motir-runner-prepare$/m);
    expect(unit).toMatch(/^EnvironmentFile=-\/run\/motir-ci-runner\/env$/m);
    expect(unit).toMatch(/^ExecStart=\/usr\/local\/bin\/motir-vm-entrypoint$/m);
    expect(unit).toMatch(/^Restart=no$/m);
  });

  it('powers the VM off when the entrypoint exits, whatever its status', () => {
    // ExecStopPost runs after a clean exit, a failed exit and a failed
    // ExecStartPre alike; `--no-block` so the unit's own stop is not waited on.
    expect(unit).toMatch(/^ExecStopPost=\/usr\/bin\/systemctl --no-block poweroff$/m);
    expect(unit).not.toMatch(/^ExecStopPost=-/m);
  });

  it('is enabled at boot, after cloud-init has read the datasource', () => {
    expect(unit).toMatch(/^After=network-online\.target cloud-init\.service$/m);
    // Not after cloud-final, which is ordered after multi-user.target: a cycle.
    expect(code(unit)).not.toContain('cloud-final');
    expect(unit).toMatch(/^WantedBy=multi-user\.target$/m);
  });
});

describe('build-ami.sh publishes the AMI id as MOTIR_AWS_RUNNER_AMI_ID', () => {
  it('validates with no credentials and builds only on `build`', () => {
    expect(buildAmi).toContain('packer validate "${VARS[@]}" "${TEMPLATE}"');
    expect(buildAmi).toContain('[ "${mode}" = build ] || { log "valid"; return 0; }');
    expect(buildAmi).toContain('packer build -color=false "${VARS[@]}"');
  });

  it('passes the commit and the release as the GitSha and Version tags', () => {
    expect(buildAmi).toContain('-var "git_sha=${sha}"');
    expect(buildAmi).toContain('-var "version=$(release_version "${sha}")"');
    expect(template).toContain('GitSha        = var.git_sha');
    expect(template).toContain('Version       = var.version');
    expect(template).toContain('RunnerVersion = var.runner_version');
  });

  it('shares the AMI with AWS_ORG_ARN when it is set, and only an Organization ARN', () => {
    expect(buildAmi).toContain('if [ -n "${AWS_ORG_ARN:-}" ]; then');
    expect(buildAmi).toContain('org_arns="[\\"${AWS_ORG_ARN}\\"]"');
    expect(buildAmi).toContain('^arn:aws:organizations::[0-9]{12}:organization/o-[a-z0-9]+$');
  });

  it('writes the AMI id and the fly secrets set command to stdout and the job summary', () => {
    expect(buildAmi).toContain('fly secrets set -a motir-core MOTIR_AWS_RUNNER_AMI_ID=${ami_id}');
    expect(buildAmi).toContain('>>"${GITHUB_STEP_SUMMARY}"');
    expect(buildAmi).toContain("jq -r '.builds[-1].artifact_id'");
  });

  it('the README documents the key, the pins, the secrets and the user-data contract', () => {
    expect(readme).toContain('MOTIR_AWS_RUNNER_AMI_ID');
    expect(readme).toContain('infra/ci-runner/Dockerfile');
    expect(readme).toContain('MOTIR_AWS_AMI_BUILD_ROLE_ARN');
    expect(readme).toContain('MOTIR_AWS_ORG_ARN');
    expect(readme).toContain('ACTIONS_RUNNER_INPUT_JITCONFIG=<the base64 JIT config>');
    expect(readme).toContain('aws ec2 deregister-image');
    expect(readme).toContain('aws ec2 delete-snapshot');
  });
});

describe('the release workflow', () => {
  it('triggers on workflow_dispatch and on a ci-runner-ami-v* tag', () => {
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect((workflow.on.push as { tags: string[] }).tags).toEqual(['ci-runner-ami-v*']);
    expect(workflow.on.push).not.toHaveProperty('branches');
  });

  it('validates with no credentials: packer validate and shellcheck over every new script', () => {
    const validate = workflow.jobs.validate!;
    expect(validate.permissions).toBeUndefined();
    const runs = validate.steps.map((s) => s.run ?? '').join('\n');
    expect(runs).toContain('infra/ci-runner-aws/build-ami.sh validate');
    expect(runs).toContain('koalaman/shellcheck');
    for (const script of awsFiles().filter((f) => f.endsWith('.sh'))) {
      expect(runs, `${script} is not shellchecked`).toContain(script);
    }
    expect(validate.steps.some((s) => s.uses?.startsWith('aws-actions/'))).toBe(false);
  });

  it('builds only off a pull request, authenticating by OIDC with the role from a secret', () => {
    const build = workflow.jobs.build!;
    expect(build.if).toBe("github.event_name != 'pull_request'");
    expect(build.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    const creds = build.steps.find((s) =>
      s.uses?.startsWith('aws-actions/configure-aws-credentials@'),
    )!;
    expect(creds.with!['role-to-assume']).toBe('${{ secrets.MOTIR_AWS_AMI_BUILD_ROLE_ARN }}');
    expect(creds.with!['aws-region']).toBe('us-east-1');
    expect(creds.with).not.toHaveProperty('aws-access-key-id');
    expect(creds.with).not.toHaveProperty('aws-secret-access-key');
    expect(build.steps.map((s) => s.run ?? '').join('\n')).toContain(
      'infra/ci-runner-aws/build-ami.sh build',
    );
  });

  it('contains no access key or secret literal', () => {
    expect(workflowSource).not.toMatch(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/);
    expect(workflowSource).not.toMatch(/aws-(access-key-id|secret-access-key|session-token)/);
    expect(workflowSource).not.toMatch(/AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)/);
  });

  it('the scripts the workflow runs are executable', () => {
    for (const script of awsFiles().filter((f) => f.endsWith('.sh'))) {
      expect(statSync(join(ROOT, script)).mode & 0o111, script).toBeGreaterThan(0);
    }
  });
});

describe('container mode (MOTIR-9419) — the same AMI runs ONE digest-pinned image', () => {
  const hook = code(prepare);
  const parse = code(parser);
  const entry = code(containerEntrypoint);
  const dispatch = code(vmEntrypoint);

  it('the hook parses, then writes the env file, mounts the disk and closes metadata, in that order', () => {
    const main = hook.slice(hook.indexOf('main() {'));
    const order = [
      'read_user_data',
      'parse_user_data',
      'write_env_file',
      'mount_docker_disk',
      'block_metadata_service',
    ].map((step) => main.indexOf(step));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // write_env_file adds the storage line whatever the mode: it reads the CI
    // env file only when the parser wrote one.
    const write = hook.slice(
      hook.indexOf('write_env_file() {'),
      hook.indexOf('scrub_cloud_init_copies() {'),
    );
    expect(write).toContain('if [ -f "${STATE_DIR}/env" ]; then');
    expect(write).toContain('printf \'MOTIR_RUNNER_DOCKER_STORAGE=overlay2\\n\' >>"${tmp}"');
    // The metadata block is unconditional: no mode test wraps it.
    expect(hook.slice(hook.indexOf('block_metadata_service() {'))).not.toContain('mode');
  });

  it('the parser makes no network call and never evaluates user-data', () => {
    expect(parse).not.toMatch(/\b(curl|wget|nc|ncat|ssh|docker)\b/);
    expect(parse).not.toMatch(/\beval\b|\bsource\b|^\s*\.\s/m);
    expect(parse).toContain('while IFS= read -r line');
    expect(parse).toContain('key="${line%%=*}"');
  });

  it('the dispatch execs the CI entrypoint for ci, the container entrypoint for container, and refuses anything else', () => {
    expect(dispatch).toContain('MODE_FILE=/run/motir/mode');
    expect(dispatch).toContain('ci) exec /usr/local/bin/motir-ci-runner-entrypoint ;;');
    expect(dispatch).toContain('container) exec /usr/local/bin/motir-container-entrypoint ;;');
    expect(dispatch).toContain('*) die "unknown boot mode in ${MODE_FILE}" ;;');
    expect(dispatch).toContain('die() { printf');
    expect(dispatch).toMatch(/exit 1; \}/);
  });

  it('the container entrypoint starts dockerd, pulls by digest, checks RepoDigests, and creates an unprivileged container', () => {
    const steps = [
      '/usr/local/bin/motir-ci-runner-dockerd',
      'docker pull --quiet "${image}"',
      'docker image inspect --format \'{{range .RepoDigests}}{{println .}}{{end}}\' "${image}"',
      'grep -qxF "${repo}@${digest}" <<<"${pulled}"',
      'docker create --rm --env-file "${ENV_FILE}"',
      'rm -f "${ENV_FILE}" "${IMAGE_FILE}"',
      'exec docker start --attach "${NAME}"',
    ].map((line) => {
      const at = entry.indexOf(line);
      expect(at, line).toBeGreaterThanOrEqual(0);
      return at;
    });
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(entry).toContain('--security-opt no-new-privileges --cap-drop ALL');
    expect(entry).not.toMatch(
      /--privileged|--network[ =]host|--net[ =]host|\s-v\s|--volume|--mount|docker\.sock/,
    );
    // The last executable line hands the process to the container.
    expect(entry.trim().split('\n').at(-1)).toBe('exec docker start --attach "${NAME}"');
  });

  it('no boot file passes a container env value on a command line', () => {
    for (const [name, body] of Object.entries(allBoot)) {
      expect(body, name).not.toMatch(/docker (create|run)[^\n]*\s(-e|--env)\s/);
      expect(body, name).not.toMatch(/\becho\s+"\$\{?value/);
    }
    // The env reaches the container only through --env-file.
    expect(entry.match(/--env-file/g)?.length).toBe(1);
  });

  it('the template copies the three scripts and provision.sh installs them root-owned 0755', () => {
    const installs: Record<string, string> = {
      'parse-user-data.sh': '/usr/local/sbin/motir-parse-user-data',
      'motir-vm-entrypoint.sh': '/usr/local/bin/motir-vm-entrypoint',
      'motir-container-entrypoint.sh': '/usr/local/bin/motir-container-entrypoint',
    };
    for (const [script, dest] of Object.entries(installs)) {
      expect(template).toContain(`source      = "\${path.root}/../boot/${script}"`);
      expect(template).toContain(`destination = "/tmp/motir-ci-runner/${script}"`);
      expect(provision).toContain(
        `install -m 0755 -o root -g root "\${STAGING}/${script}" ${dest}`,
      );
      expect(workflowSource).toContain(`infra/ci-runner-aws/boot/${script}`);
    }
  });

  it('the README documents the container-mode contract, and nothing in infra/ci-runner/ changed for it', () => {
    for (const term of [
      '## Container mode',
      'MOTIR_BOOT_MODE=container',
      'MOTIR_CONTAINER_IMAGE',
      'MOTIR_ENV_<NAME>',
      'anonymously',
      'MOTIR_AWS_RUNNER_AMI_ID',
    ]) {
      expect(readme).toContain(term);
    }
    for (const file of readdirSync(FLY_DIR).filter((f) => f.endsWith('.sh'))) {
      expect(readFileSync(join(FLY_DIR, file), 'utf8')).not.toMatch(
        /MOTIR_BOOT_MODE|motir-vm-entrypoint/,
      );
    }
  });
});
