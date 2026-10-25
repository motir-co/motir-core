import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// THE AWS VM's user-data parser, run for real (MOTIR-9419).
//
// `infra/ci-runner-aws/boot/parse-user-data.sh` is text in, files out, with no
// network and no VM, so each refusal rule is checked here by running it on a
// fixture: what it writes, what it refuses, and that a refusal writes nothing
// and never prints a value. `awsRunnerAmi.test.ts` guards how the hook and the
// unit call it.

const SCRIPT = join(process.cwd(), 'infra/ci-runner-aws/boot/parse-user-data.sh');
const DIGEST = 'a'.repeat(64);
const IMAGE = `ghcr.io/motir-co/motir-hosted-agent@sha256:${DIGEST}`;
// A value that must never reach stderr: every fixture that carries one checks.
const MARKER = 'S3CRET-MARKER-VALUE';

let dir: string;
let out: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motir-user-data-'));
  out = join(dir, 'out');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Result = { status: number; stderr: string };

function parse(userData: string): Result {
  const file = join(dir, 'user-data');
  writeFileSync(file, userData);
  try {
    execFileSync('bash', [SCRIPT, file, out], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stderr: '' };
  } catch (error) {
    const e = error as { status: number; stderr: Buffer };
    return { status: e.status, stderr: e.stderr.toString() };
  }
}

const written = (name: string): string => readFileSync(join(out, name), 'utf8');
const mode = (name: string): number => statSync(join(out, name)).mode & 0o777;

function expectRefused(result: Result, names: string): void {
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(names);
  expect(result.stderr).not.toContain(MARKER);
  for (const file of ['mode', 'env', 'container.env', 'container.image']) {
    expect(existsSync(join(out, file)), file).toBe(false);
  }
}

describe('CI mode — no mode line, MOTIR-9272’s four keys', () => {
  it('writes the four lines to env (0600) and ci to mode', () => {
    const lines = [
      'ACTIONS_RUNNER_INPUT_JITCONFIG=eyJhIjoiYiJ9+/=',
      'MOTIR_RUNNER_LABEL=motir-aws-1',
      'MOTIR_INTENT_ID=cmabc123',
      'MOTIR_WORKFLOW_JOB_ID=4242',
    ];
    expect(parse(`${lines.join('\r\n')}\r\n\n`).status).toBe(0);
    expect(written('mode')).toBe('ci\n');
    expect(written('env')).toBe(`${lines.join('\n')}\n`);
    expect(mode('env')).toBe(0o600);
    expect(existsSync(join(out, 'container.env'))).toBe(false);
  });

  it('refuses an unknown key', () => {
    expectRefused(parse(`ACTIONS_RUNNER_INPUT_JITCONFIG=abc\nPATH=${MARKER}\n`), 'not accepted');
  });

  it('refuses a repeated key', () => {
    expectRefused(
      parse(`ACTIONS_RUNNER_INPUT_JITCONFIG=abc\nMOTIR_INTENT_ID=1\nMOTIR_INTENT_ID=${MARKER}\n`),
      'MOTIR_INTENT_ID twice',
    );
  });

  it('refuses a value outside the plain charset', () => {
    expectRefused(
      parse(`ACTIONS_RUNNER_INPUT_JITCONFIG=abc\nMOTIR_RUNNER_LABEL=${MARKER} x\n`),
      'MOTIR_RUNNER_LABEL',
    );
  });

  it('refuses user-data with no JIT config', () => {
    expectRefused(parse('MOTIR_RUNNER_LABEL=motir-aws-1\n'), 'ACTIONS_RUNNER_INPUT_JITCONFIG');
  });
});

describe('container mode — one digest-pinned image and its environment', () => {
  it('writes the image, the prefix-stripped env (0600) and container to mode', () => {
    const userData = [
      'MOTIR_BOOT_MODE=container',
      `MOTIR_CONTAINER_IMAGE=${IMAGE}`,
      'MOTIR_ENV_MOTIR_RUN_ID=run_1',
      'MOTIR_ENV_RUN_TOKEN=a=b c $HOME "q"',
    ].join('\n');
    expect(parse(`${userData}\n`).status).toBe(0);
    expect(written('mode')).toBe('container\n');
    expect(written('container.image')).toBe(`${IMAGE}\n`);
    expect(written('container.env')).toBe('MOTIR_RUN_ID=run_1\nRUN_TOKEN=a=b c $HOME "q"\n');
    for (const file of ['mode', 'container.image', 'container.env']) {
      expect(mode(file), file).toBe(0o600);
    }
    expect(existsSync(join(out, 'env'))).toBe(false);
  });

  it('accepts a registry with a port and a nested repository', () => {
    const image = `registry.example.com:5000/motir/agents/runner@sha256:${DIGEST}`;
    expect(parse(`MOTIR_BOOT_MODE=container\nMOTIR_CONTAINER_IMAGE=${image}\n`).status).toBe(0);
    expect(written('container.image')).toBe(`${image}\n`);
    expect(written('container.env')).toBe('');
  });

  const head = 'MOTIR_BOOT_MODE=container\n';
  const withImage = `${head}MOTIR_CONTAINER_IMAGE=${IMAGE}\n`;

  it.each([
    ['a tag and no digest', 'ghcr.io/motir-co/agent:latest'],
    ['a tag before the digest', `ghcr.io/motir-co/agent:1.0@sha256:${DIGEST}`],
    ['a short digest', `ghcr.io/motir-co/agent@sha256:${'a'.repeat(63)}`],
    ['text after the digest', `${IMAGE}x`],
    ['an upper-case digest', `ghcr.io/motir-co/agent@sha256:${'A'.repeat(64)}`],
    ['no repository path', `agent@sha256:${DIGEST}`],
  ])('refuses an image with %s', (_case, image) => {
    expectRefused(parse(`${head}MOTIR_CONTAINER_IMAGE=${image}\n`), 'MOTIR_CONTAINER_IMAGE');
  });

  it('refuses container mode with no image', () => {
    expectRefused(parse(`${head}MOTIR_ENV_A=${MARKER}\n`), 'MOTIR_CONTAINER_IMAGE');
  });

  it.each([
    'ACTIONS_RUNNER_INPUT_JITCONFIG',
    'MOTIR_RUNNER_LABEL',
    'MOTIR_INTENT_ID',
    'MOTIR_WORKFLOW_JOB_ID',
  ])('refuses the CI key %s in container mode', (key) => {
    expectRefused(parse(`${withImage}${key}=${MARKER}\n`), `CI key ${key}`);
  });

  it('refuses an unknown key', () => {
    expectRefused(parse(`${withImage}LD_PRELOAD=${MARKER}\n`), 'LD_PRELOAD');
  });

  it.each(['MOTIR_ENV_lower', 'MOTIR_ENV_1ABC', 'MOTIR_ENV_A-B', 'MOTIR_ENV_'])(
    'refuses the env key %s, whose name is not a variable',
    (key) => {
      expectRefused(parse(`${withImage}${key}=${MARKER}\n`), key);
    },
  );

  it('refuses a repeated env key', () => {
    expectRefused(parse(`${withImage}MOTIR_ENV_A=1\nMOTIR_ENV_A=${MARKER}\n`), 'MOTIR_ENV_A twice');
  });

  it('refuses a mode line that is not container', () => {
    expectRefused(parse(`MOTIR_BOOT_MODE=${MARKER}\n`), 'MOTIR_BOOT_MODE');
  });

  it('refuses a line that is not KEY=value, without printing it', () => {
    expectRefused(parse(`${withImage}${MARKER}\n`), 'not KEY=value');
  });

  it('refuses a line with an empty key, without printing it', () => {
    expectRefused(parse(`${withImage}=${MARKER}\n`), 'empty key');
  });
});

describe('the parser’s source', () => {
  const source = readFileSync(SCRIPT, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  it('never evaluates user-data and makes no network call', () => {
    expect(source).not.toMatch(/\beval\b|\bsource\b|^\s*\.\s/m);
    expect(source).not.toMatch(/\b(curl|wget)\b/);
  });
});
