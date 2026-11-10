import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '@/scripts/aws-deploy/awsDeploy';
import {
  IMAGE_PINS_DIR,
  IMAGE_REF_PATTERN,
  ImagePinError,
  PINNED_SECRETS,
  applyPins,
  parseImagePins,
  pinSecretId,
  readImagePins,
  restorePins,
} from '@/scripts/aws-deploy/imagePins';
import { GRANTED_ACTIONS } from '@/scripts/aws-deploy/ports';
import {
  CORE_REPO,
  DIGEST,
  FakeDeployAws,
  PREFIX,
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
const SECRET = pinSecretId(PREFIX, 'motir-runner-image');
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
  it('pins production to runner-v0.2.6, the release that records its tool list', () => {
    const pins = readImagePins(IMAGE_PINS_DIR);
    expect(pins).toEqual([{ name: 'motir-runner-image', value: V026 }]);
  });

  it('holds exactly the pinned secrets, and only notes besides them', () => {
    const files = readdirSync(IMAGE_PINS_DIR).filter((f) => !f.endsWith('.md'));
    expect(files.sort()).toEqual([...PINNED_SECRETS].sort());
    expect(readFileSync(join(IMAGE_PINS_DIR, 'README.md'), 'utf8')).toContain('motir-runner-image');
  });

  it("holds the list to the secrets motir-infra's deploy role may write (DEPLOY_PINNED_SECRETS)", () => {
    expect([...PINNED_SECRETS]).toEqual(['motir-runner-image']);
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
      /not a pinned secret/,
    );
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

describe('the deploy writes the pin, then rolls (MOTIR-10883)', () => {
  it('writes the secret after the migrate task and before the first service changes', async () => {
    const aws = coreFleet();
    const { code, result } = await deploy(aws, IMAGE_PINS_DIR);
    expect(code).toBe(0);
    expect(aws.secrets.get(SECRET)).toBe(V026);
    expect(result?.['pins']).toEqual([
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
    const { code, result } = await deploy(aws, IMAGE_PINS_DIR);
    expect(code).toBe(1);
    expect(aws.secrets.get(SECRET)).toBe(V024);
    expect(result?.['pins']).toEqual([
      { name: 'motir-runner-image', value: V026, state: 'restored' },
    ]);
    expect(result?.['recorded']).toBe(false);
  });

  it('stops before any service changes when the secret write is refused', async () => {
    const aws = coreFleet();
    aws.failPutSecretOf = SECRET;
    const { code, err } = await deploy(aws, IMAGE_PINS_DIR);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain(`put ${SECRET} refused`);
    expect(aws.methods()).not.toContain('updateService');
    expect(aws.secrets.get(SECRET)).toBe(V024);
  });

  it('rolls as before when the role is not granted the secret yet, and says so on the result', async () => {
    const aws = coreFleet();
    aws.secretsGranted = false;
    const { code, result } = await deploy(aws, IMAGE_PINS_DIR);
    expect(code).toBe(0);
    expect(result?.['pins']).toEqual([
      { name: 'motir-runner-image', value: V026, state: 'not_granted' },
    ]);
    expect(aws.methods()).toContain('updateService');
  });

  it('writes no pin on a --no-roll deploy, which has no service to start', async () => {
    const aws = new FakeDeployAws();
    aws.migrate = migrateExits(0);
    const { code } = await deploy(aws, IMAGE_PINS_DIR, ['--no-roll']);
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
