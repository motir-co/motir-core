import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '@/scripts/aws-deploy/awsDeploy';
import {
  IMAGE_PINS_DIR,
  IMAGE_REF_PATTERN,
  INDEXER_IMAGE_REF_PATTERN,
  ImagePinError,
  PINNED_PARAMETERS,
  PINNED_SECRETS,
  PIN_NAMES,
  applyPins,
  checkPinTargets,
  parseImagePins,
  pinParameterName,
  pinSecretId,
  pinTarget,
  readImagePins,
  restorePins,
} from '@/scripts/aws-deploy/imagePins';
import { GRANTED_ACTIONS } from '@/scripts/aws-deploy/ports';
import {
  CORE_REPO,
  DIGEST,
  FakeDeployAws,
  PREFIX,
  REGISTRY,
  completesAfter,
  migrateExits,
} from './fakeDeployAws';

// MOTIR-10883 — MOTIR_RUNNER_IMAGE stayed on runner-v0.2.4 through two releases,
// because the secret was a value a person had to copy in after each one. The pin
// is now a file in this repository, and the AWS deploy of the commit that changes
// it writes the secret before the roll that makes the new tasks read it.

const ENV = { AWS_REGION: 'us-east-1', AWS_DEPLOY_NAME_PREFIX: PREFIX };
const V024 = `ghcr.io/motir-co/motir-ci-runner@sha256:46ed04438d0ecf403a9fee916373ad10327ebfbdee8e6114678b70dae07c860a`;
const V026 = `ghcr.io/motir-co/motir-ci-runner@sha256:bf38f5940e5a327ad171cabb6f9bbe41db2ba1e7a0abb5c5ff8f9a81d9e1f6cc`;
/** Build sha-ca74591b, the interim re-pin of 2026-11-10 (MOTIR-10882). */
const HOSTED_AGENT_CA74591B =
  'ghcr.io/motir-co/motir-hosted-agent@sha256:035f996160f027655ac677135faa512277559608819a4cb8a89337ba435be4f7';
/**
 * The deploy tests read this fixture, not the checked-in directory: both pins
 * move by a release lane's pull request (the hosted-agent one on every publish
 * from `main`), so a test holding the checked-in digests would fail the very
 * pull request that bumps them.
 */
const PINS_FIXTURE: Record<string, string> = {
  'motir-hosted-agent-image': `${HOSTED_AGENT_CA74591B}\n`,
  'motir-runner-image': `${V026}\n`,
};
const SECRET = pinSecretId(PREFIX, 'motir-runner-image');
/** The indexer's pin (MOTIR-10986): this account's ECR, by digest. */
const INDEXER_REPO = `${REGISTRY}/${PREFIX}/indexer`;
const INDEXER_050 = `${INDEXER_REPO}@sha256:${'2f'.repeat(32)}`;
const INDEXER_051 = `${INDEXER_REPO}@sha256:${'e0'.repeat(32)}`;
const PARAMETER = pinParameterName(PREFIX, 'motir-indexer-image');
const log = () => {};

function pinsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'image-pins-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

function coreFleet() {
  const aws = new FakeDeployAws();
  aws.addService('web', CORE_REPO);
  aws.addService('worker', CORE_REPO);
  aws.secrets.set(SECRET, V024);
  return aws;
}

async function deploy(aws: FakeDeployAws, dir: string, extra: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    ['--digest', DIGEST, '--pins', dir, ...extra],
    ENV,
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    () => aws,
  );
  for (const action of aws.actions()) expect(GRANTED_ACTIONS).toContain(action);
  const result = out.length ? (JSON.parse(out[0] ?? '{}') as Record<string, unknown>) : null;
  return { code, err, result };
}

describe('the checked-in pin', () => {
  // The digests themselves are not held here: the release lanes move them by
  // pull request (README.md), and the pull request's own image check proves the
  // one it names. This holds what every bump must keep: one pull-by-digest
  // reference per pin, each naming its own image.
  it('pins each target to its own image, by digest', () => {
    const pins = readImagePins(IMAGE_PINS_DIR);
    expect(pins.map((p) => p.name)).toEqual([
      'motir-hosted-agent-image',
      'motir-indexer-image',
      'motir-runner-image',
    ]);
    const [hostedAgent, indexer, runner] = pins;
    expect(hostedAgent!.value).toMatch(
      /^ghcr\.io\/motir-co\/motir-hosted-agent@sha256:[a-f0-9]{64}$/,
    );
    // Production's indexer repository: the services account's ECR (motir-infra).
    expect(indexer!.value).toMatch(
      /^944842271421\.dkr\.ecr\.us-east-1\.amazonaws\.com\/motir\/indexer@sha256:[a-f0-9]{64}$/,
    );
    expect(runner!.value).toMatch(/^ghcr\.io\/motir-co\/motir-ci-runner@sha256:[a-f0-9]{64}$/);
  });

  it('holds exactly the pinned targets, and only notes besides them', () => {
    const files = readdirSync(IMAGE_PINS_DIR).filter((f) => !f.endsWith('.md'));
    expect(files.sort()).toEqual([...PIN_NAMES]);
    const readme = readFileSync(join(IMAGE_PINS_DIR, 'README.md'), 'utf8');
    for (const name of PIN_NAMES) expect(readme).toContain(`\`${name}\``);
    expect(readme).toContain('`/motir/core/indexer-image`');
  });

  it("holds the list to the secrets motir-infra's deploy role may write (DEPLOY_PINNED_SECRETS)", () => {
    expect([...PINNED_SECRETS]).toEqual(['motir-hosted-agent-image', 'motir-runner-image']);
  });

  it("holds the parameter to the one motir-infra's deploy role may write (deployPinnedIndexerParameterName)", () => {
    expect(PINNED_PARAMETERS).toEqual({ 'motir-indexer-image': 'indexer-image' });
    expect(pinParameterName('motir', 'motir-indexer-image')).toBe('/motir/core/indexer-image');
    expect(pinTarget('motir', 'motir-indexer-image')).toBe('/motir/core/indexer-image');
    expect(pinTarget('motir', 'motir-runner-image')).toBe('motir/core/motir-runner-image');
  });
});

describe('parseImagePins', () => {
  it('accepts a pull-by-digest reference, trimmed, and skips notes', () => {
    expect(
      parseImagePins([
        { name: 'README.md', content: 'anything' },
        { name: 'motir-runner-image', content: `  ${V026}\n` },
      ]),
    ).toEqual([{ name: 'motir-runner-image', value: V026 }]);
  });

  it.each([
    ['a tag', 'ghcr.io/motir-co/motir-ci-runner:0.2.6'],
    ['a short digest', 'ghcr.io/motir-co/motir-ci-runner@sha256:bf38f594'],
    ['another registry', `docker.io/motir/motir-ci-runner@${DIGEST}`],
    ['upper case', `ghcr.io/Motir-Co/motir-ci-runner@${DIGEST}`],
    ['two lines', `${V026}\n${V024}`],
    ['nothing', ''],
  ])('refuses %s', (_, content) => {
    expect(() => parseImagePins([{ name: 'motir-runner-image', content }])).toThrow(ImagePinError);
  });

  it('refuses a file whose name the deploy role may not write', () => {
    expect(() => parseImagePins([{ name: 'better-auth-secret', content: V026 }])).toThrow(
      /not a pinned secret or parameter/,
    );
  });

  it("accepts the indexer's ECR reference by digest, and only that shape", () => {
    expect(parseImagePins([{ name: 'motir-indexer-image', content: `${INDEXER_051}\n` }])).toEqual([
      { name: 'motir-indexer-image', value: INDEXER_051 },
    ]);
    expect(INDEXER_IMAGE_REF_PATTERN.test(INDEXER_051)).toBe(true);
  });

  it.each([
    ['a GHCR reference', `ghcr.io/motir-co/motir-indexer@${DIGEST}`],
    ['a tag', `${INDEXER_REPO}:indexer-0.5.1`],
    ['another repository', `${REGISTRY}/${PREFIX}/motir-core@${DIGEST}`],
    ['a short digest', `${INDEXER_REPO}@sha256:e0e0e0`],
    ['two lines', `${INDEXER_051}\n${INDEXER_050}`],
  ])("refuses %s as the indexer's pin", (_, content) => {
    expect(() => parseImagePins([{ name: 'motir-indexer-image', content }])).toThrow(
      /motir-indexer-image must hold one pull-by-digest reference, <account>\.dkr\.ecr/,
    );
  });

  it("refuses a GHCR pin's reference in the indexer's ECR shape", () => {
    expect(() => parseImagePins([{ name: 'motir-runner-image', content: INDEXER_051 }])).toThrow(
      /ghcr\.io\/<owner>\/<name>/,
    );
  });
});

describe('checkPinTargets', () => {
  const indexer = (value: string) => [{ name: 'motir-indexer-image' as const, value }];

  it("accepts the indexer of the deployed image's own account and prefix", () => {
    expect(() => checkPinTargets(PREFIX, CORE_REPO, indexer(INDEXER_051))).not.toThrow();
  });

  it.each([
    ['another account', `999988887777.dkr.ecr.us-east-1.amazonaws.com/${PREFIX}/indexer@${DIGEST}`],
    ['another region', `111122223333.dkr.ecr.eu-west-1.amazonaws.com/${PREFIX}/indexer@${DIGEST}`],
    ['another prefix', `${REGISTRY}/motir-staging/indexer@${DIGEST}`],
  ])('refuses an indexer in %s', (_, value) => {
    expect(() => checkPinTargets(PREFIX, CORE_REPO, indexer(value))).toThrow(
      `motir-indexer-image must name ${INDEXER_REPO} by digest`,
    );
  });

  it('leaves the GHCR pins alone', () => {
    expect(() =>
      checkPinTargets(PREFIX, CORE_REPO, [{ name: 'motir-runner-image', value: V026 }]),
    ).not.toThrow();
  });

  it('matches the reference shape the release lane writes', () => {
    expect(IMAGE_REF_PATTERN.test(V026)).toBe(true);
  });
});

describe('applyPins and restorePins', () => {
  it('writes a pin whose secret holds another value, and keeps the value it replaced', async () => {
    const aws = coreFleet();
    const { applied, previous } = await applyPins(
      aws,
      PREFIX,
      [{ name: 'motir-runner-image', value: V026 }],
      log,
    );
    expect(applied).toEqual([{ name: 'motir-runner-image', value: V026, state: 'written' }]);
    expect(aws.secrets.get(SECRET)).toBe(V026);
    await restorePins(aws, PREFIX, applied, previous, log);
    expect(aws.secrets.get(SECRET)).toBe(V024);
    expect(applied[0]!.state).toBe('restored');
  });

  it('writes nothing when the secret already holds the pin', async () => {
    const aws = coreFleet();
    aws.secrets.set(SECRET, V026);
    const { applied } = await applyPins(
      aws,
      PREFIX,
      [{ name: 'motir-runner-image', value: V026 }],
      log,
    );
    expect(applied[0]!.state).toBe('unchanged');
    expect(aws.methods()).not.toContain('putSecretValue');
  });

  it('keeps a pin it wrote into an empty secret when the roll fails: there is nothing to restore', async () => {
    const aws = coreFleet();
    aws.secrets.delete(SECRET);
    const { applied, previous } = await applyPins(
      aws,
      PREFIX,
      [{ name: 'motir-runner-image', value: V026 }],
      log,
    );
    await restorePins(aws, PREFIX, applied, previous, log);
    expect(aws.secrets.get(SECRET)).toBe(V026);
    expect(applied[0]!.state).toBe('written');
  });

  it('reports a restore it could not make and carries on', async () => {
    const aws = coreFleet();
    const lines: string[] = [];
    const { applied, previous } = await applyPins(
      aws,
      PREFIX,
      [{ name: 'motir-runner-image', value: V026 }],
      log,
    );
    aws.failPutSecretOf = SECRET;
    await restorePins(aws, PREFIX, applied, previous, (l) => lines.push(l));
    expect(lines.join('\n')).toContain(`restoring ${SECRET} failed`);
    expect(applied[0]!.state).toBe('written');
  });

  it('reads the pin as not granted, and writes nothing, before motir-infra grants the role', async () => {
    const aws = coreFleet();
    aws.secretsGranted = false;
    const lines: string[] = [];
    const { applied } = await applyPins(
      aws,
      PREFIX,
      [{ name: 'motir-runner-image', value: V026 }],
      (l) => lines.push(l),
    );
    expect(applied[0]!.state).toBe('not_granted');
    expect(aws.secrets.get(SECRET)).toBe(V024);
    expect(lines.join('\n')).toContain('is not granted to the deploy role');
  });
});

describe("applyPins and restorePins on the indexer's parameter (MOTIR-10986)", () => {
  const pins = [{ name: 'motir-indexer-image' as const, value: INDEXER_051 }];

  it('writes the SSM parameter, never a secret, and restores the value it replaced', async () => {
    const aws = coreFleet();
    aws.params.set(PARAMETER, INDEXER_050);
    const { applied, previous } = await applyPins(aws, PREFIX, pins, log);
    expect(applied).toEqual([
      { name: 'motir-indexer-image', value: INDEXER_051, state: 'written' },
    ]);
    expect(aws.params.get(PARAMETER)).toBe(INDEXER_051);
    expect(aws.calls).toEqual([
      ['readParameter', PARAMETER],
      ['putParameter', PARAMETER, INDEXER_051],
    ]);
    await restorePins(aws, PREFIX, applied, previous, log);
    expect(aws.params.get(PARAMETER)).toBe(INDEXER_050);
    expect(applied[0]!.state).toBe('restored');
    expect(aws.methods()).not.toContain('putSecretValue');
  });

  it('writes nothing when the parameter already holds the pin', async () => {
    const aws = coreFleet();
    aws.params.set(PARAMETER, INDEXER_051);
    const { applied } = await applyPins(aws, PREFIX, pins, log);
    expect(applied[0]!.state).toBe('unchanged');
    expect(aws.methods()).not.toContain('putParameter');
  });

  it('reads the parameter as not granted, and writes nothing, before MOTIR-10988 grants it', async () => {
    const aws = coreFleet();
    aws.params.set(PARAMETER, INDEXER_050);
    aws.pinParameterGranted = false;
    const lines: string[] = [];
    const { applied } = await applyPins(aws, PREFIX, pins, (l) => lines.push(l));
    expect(applied[0]!.state).toBe('not_granted');
    expect(aws.params.get(PARAMETER)).toBe(INDEXER_050);
    expect(lines.join('\n')).toContain(`${PARAMETER} is not granted to the deploy role`);
  });

  it('puts the pins already written back when a later write is refused', async () => {
    const aws = coreFleet();
    aws.params.set(PARAMETER, INDEXER_050);
    aws.failPutSecretOf = SECRET;
    await expect(
      applyPins(aws, PREFIX, [...pins, { name: 'motir-runner-image', value: V026 }], log),
    ).rejects.toThrow(`put ${SECRET} refused`);
    expect(aws.params.get(PARAMETER)).toBe(INDEXER_050);
  });

  it('reports a parameter restore it could not make and carries on', async () => {
    const aws = coreFleet();
    aws.params.set(PARAMETER, INDEXER_050);
    const { applied, previous } = await applyPins(aws, PREFIX, pins, log);
    aws.failPutParameterOf = PARAMETER;
    const lines: string[] = [];
    await restorePins(aws, PREFIX, applied, previous, (l) => lines.push(l));
    expect(lines.join('\n')).toContain(`restoring ${PARAMETER} failed`);
    expect(aws.params.get(PARAMETER)).toBe(INDEXER_051);
  });
});

describe('the deploy writes the pin, then rolls (MOTIR-10883)', () => {
  it('writes the secret after the migrate task and before the first service changes', async () => {
    const aws = coreFleet();
    const { code, result } = await deploy(aws, pinsDir(PINS_FIXTURE));
    expect(code).toBe(0);
    expect(aws.secrets.get(SECRET)).toBe(V026);
    expect(result?.['pins']).toEqual([
      { name: 'motir-hosted-agent-image', value: HOSTED_AGENT_CA74591B, state: 'written' },
      { name: 'motir-runner-image', value: V026, state: 'written' },
    ]);
    const methods = aws.methods();
    expect(methods.indexOf('putSecretValue')).toBeGreaterThan(methods.lastIndexOf('describeTask'));
    expect(methods.indexOf('putSecretValue')).toBeLessThan(methods.indexOf('updateService'));
    expect(result?.['recorded']).toBe(true);
  });

  it('puts the previous value back when the roll fails, beside the services', async () => {
    const aws = coreFleet();
    aws.rollouts.set('worker', (_, rolledTo) => ({ primary: rolledTo, state: 'FAILED' }));
    const { code, result } = await deploy(aws, pinsDir(PINS_FIXTURE));
    expect(code).toBe(1);
    expect(aws.secrets.get(SECRET)).toBe(V024);
    // The hosted-agent secret held nothing before, so there is nothing to put back.
    expect(result?.['pins']).toEqual([
      { name: 'motir-hosted-agent-image', value: HOSTED_AGENT_CA74591B, state: 'written' },
      { name: 'motir-runner-image', value: V026, state: 'restored' },
    ]);
    expect(result?.['recorded']).toBe(false);
    // The restore lands before the rollback's updateService calls start tasks (MOTIR-10882).
    const methods = aws.methods();
    const restore = methods.lastIndexOf('putSecretValue');
    expect(restore).toBeGreaterThan(methods.indexOf('updateService'));
    expect(restore).toBeLessThan(methods.lastIndexOf('updateService'));
  });

  it('stops before any service changes when the secret write is refused', async () => {
    const aws = coreFleet();
    aws.failPutSecretOf = SECRET;
    const { code, err } = await deploy(aws, pinsDir(PINS_FIXTURE));
    expect(code).toBe(1);
    expect(err.join('\n')).toContain(`put ${SECRET} refused`);
    expect(aws.methods()).not.toContain('updateService');
    expect(aws.secrets.get(SECRET)).toBe(V024);
  });

  it('rolls as before when the role is not granted the secret yet, and says so on the result', async () => {
    const aws = coreFleet();
    aws.secretsGranted = false;
    const { code, result } = await deploy(aws, pinsDir(PINS_FIXTURE));
    expect(code).toBe(0);
    expect(result?.['pins']).toEqual([
      { name: 'motir-hosted-agent-image', value: HOSTED_AGENT_CA74591B, state: 'not_granted' },
      { name: 'motir-runner-image', value: V026, state: 'not_granted' },
    ]);
    expect(aws.methods()).toContain('updateService');
  });

  it('writes no pin on a --no-roll deploy, which has no service to start', async () => {
    const aws = new FakeDeployAws();
    aws.migrate = migrateExits(0);
    const { code } = await deploy(aws, pinsDir(PINS_FIXTURE), ['--no-roll']);
    expect(code).toBe(0);
    expect(aws.methods()).not.toContain('getSecretValue');
  });

  it('refuses a malformed pin before it reads AWS at all', async () => {
    const aws = coreFleet();
    const dir = pinsDir({ 'motir-runner-image': 'ghcr.io/motir-co/motir-ci-runner:0.2.6' });
    const { code, err, result } = await deploy(aws, dir);
    expect(code).toBe(1);
    expect(result).toBeNull();
    expect(err.join('\n')).toContain(`--pins ${dir}: motir-runner-image must hold`);
    expect(aws.calls).toEqual([]);
  });

  it('refuses a pins directory that cannot be read', async () => {
    const aws = coreFleet();
    const { code, err } = await deploy(aws, join(tmpdir(), 'no-such-image-pins'));
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/--pins .*no-such-image-pins/);
  });

  it('rolls a fleet whose services take several polls with the pin written once', async () => {
    const aws = coreFleet();
    aws.rollouts.set('web', completesAfter(3));
    const dir = pinsDir({ 'motir-runner-image': `${V026}\n`, 'README.md': '# notes' });
    const { code } = await deploy(aws, dir);
    expect(code).toBe(0);
    expect(aws.methods().filter((m) => m === 'putSecretValue')).toHaveLength(1);
  });
});

describe('the deploy writes the indexer pin, then rolls web and worker (MOTIR-10986)', () => {
  const files = { ...PINS_FIXTURE, 'motir-indexer-image': `${INDEXER_051}\n` };

  function indexerFleet() {
    const aws = coreFleet();
    aws.params.set(PARAMETER, INDEXER_050);
    return aws;
  }

  it('writes /<prefix>/core/indexer-image after the migrate task and before the roll', async () => {
    const aws = indexerFleet();
    const { code, result } = await deploy(aws, pinsDir(files));
    expect(code).toBe(0);
    expect(aws.params.get(PARAMETER)).toBe(INDEXER_051);
    expect(result?.['pins']).toContainEqual({
      name: 'motir-indexer-image',
      value: INDEXER_051,
      state: 'written',
    });
    const write = aws.calls.findIndex(([m, name]) => m === 'putParameter' && name === PARAMETER);
    const methods = aws.methods();
    expect(write).toBeGreaterThan(methods.lastIndexOf('describeTask'));
    expect(write).toBeLessThan(methods.indexOf('updateService'));
  });

  it('puts the previous indexer back when the roll fails', async () => {
    const aws = indexerFleet();
    aws.rollouts.set('web', (_, rolledTo) => ({ primary: rolledTo, state: 'FAILED' }));
    const { code, result } = await deploy(aws, pinsDir(files));
    expect(code).toBe(1);
    expect(aws.params.get(PARAMETER)).toBe(INDEXER_050);
    expect(result?.['pins']).toContainEqual({
      name: 'motir-indexer-image',
      value: INDEXER_051,
      state: 'restored',
    });
  });

  it('fails a malformed indexer pin before it reads AWS at all', async () => {
    const aws = indexerFleet();
    const dir = pinsDir({ 'motir-indexer-image': `${INDEXER_REPO}:indexer-0.5.1\n` });
    const { code, err } = await deploy(aws, dir);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain(`--pins ${dir}: motir-indexer-image must hold`);
    expect(aws.calls).toEqual([]);
  });

  it("fails another account's indexer before anything is written or migrated", async () => {
    const aws = indexerFleet();
    const other = `999988887777.dkr.ecr.us-east-1.amazonaws.com/${PREFIX}/indexer@${DIGEST}`;
    const { code, err, result } = await deploy(aws, pinsDir({ 'motir-indexer-image': other }));
    expect(code).toBe(1);
    expect(err.join('\n')).toContain(`motir-indexer-image must name ${INDEXER_REPO} by digest`);
    expect(aws.methods()).not.toContain('runTask');
    expect(aws.methods()).not.toContain('putParameter');
    expect(aws.methods()).not.toContain('putSecretValue');
    expect(result?.['pins']).toEqual([]);
    expect(aws.params.get(PARAMETER)).toBe(INDEXER_050);
  });
});
