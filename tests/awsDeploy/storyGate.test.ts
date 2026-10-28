import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '@/scripts/aws-deploy/awsDeploy';
import { GRANTED_ACTIONS } from '@/scripts/aws-deploy/ports';
import { stripComments } from '../helpers/importGraph';
import {
  CORE_REPO,
  DIGEST,
  FakeDeployAws,
  OLD_DIGEST,
  OTHER_REPO,
  PREFIX,
  migrateExits,
} from './fakeDeployAws';

// Story MOTIR-9709 · MOTIR-9933 — the story gate over the AWS deploy path.
// The deploy script's own tests pin each rule; this file runs the WHOLE script
// for the four outcomes a merge can have and holds each to its exact sequence of
// AWS calls, then guards the path's sources against an AWS key variable.

const ENV = { AWS_REGION: 'us-east-1', AWS_DEPLOY_NAME_PREFIX: PREFIX };
const DIGEST_PARAM = `/${PREFIX}/core/image-digest`;

/** Every action issued by any scenario here, held to the grant at the end. */
const issued = new Set<string>();

async function deploy(aws: FakeDeployAws, extra: string[] = []) {
  const err: string[] = [];
  const code = await main(
    ['--digest', DIGEST, ...extra],
    ENV,
    { out: () => undefined, err: (l) => err.push(l) },
    () => aws,
  );
  for (const action of aws.actions()) issued.add(action);
  return { code, err };
}

/** The call log with consecutive repeats (a poll) collapsed to one entry. */
function squash(methods: string[]): string[] {
  return methods.filter((m, i) => m !== methods[i - 1]);
}

/** One core service (web) beside a service of another image (ai). */
function fleet() {
  const aws = new FakeDeployAws();
  const previous = aws.addService('web', CORE_REPO);
  aws.addService('ai', OTHER_REPO);
  return { aws, previous };
}

const VERIFY = ['getParameter', 'describeTaskDefinition', 'imageExists'];
const MIGRATE = ['describeTaskDefinition', 'registerTaskDefinition', 'runTask', 'describeTask'];
const FIND = ['listServices', 'describeServices', 'describeTaskDefinition'];
const ROLL = ['registerTaskDefinition', 'updateService', 'describeServices'];

describe('the deploy, start to finish', () => {
  it('success: verify, migrate, find, roll, then the digest write last, exit 0', async () => {
    const { aws } = fleet();
    const { code } = await deploy(aws);
    expect(code).toBe(0);
    expect(squash(aws.methods())).toEqual([
      ...VERIFY,
      ...MIGRATE,
      ...FIND,
      ...ROLL,
      'putParameter',
    ]);
    expect(aws.params.get(DIGEST_PARAM)).toBe(DIGEST);
  });

  it('migrate exits non-zero: the log tail, then nothing — no update, no digest write', async () => {
    const { aws, previous } = fleet();
    aws.migrate = migrateExits(1);
    const { code } = await deploy(aws);
    expect(code).toBe(1);
    expect(squash(aws.methods())).toEqual([...VERIFY, ...MIGRATE, 'tailLog']);
    expect(aws.services.get('web')).toBe(previous);
    expect(aws.params.get(DIGEST_PARAM)).toBe(OLD_DIGEST);
  });

  it('a service reports FAILED: it is restored to its recorded revision, no digest write', async () => {
    const { aws, previous } = fleet();
    aws.rollouts.set('web', (_p, to) => ({ primary: to, state: 'FAILED' }));
    const { code } = await deploy(aws);
    expect(code).toBe(1);
    expect(squash(aws.methods())).toEqual([
      ...VERIFY,
      ...MIGRATE,
      ...FIND,
      ...ROLL,
      'updateService',
    ]);
    expect(aws.calls.at(-1)).toEqual(['updateService', 'motir-prod-core', 'web', previous]);
    expect(aws.services.get('web')).toBe(previous);
    expect(aws.params.get(DIGEST_PARAM)).toBe(OLD_DIGEST);
  });

  it('the service wait times out: it is restored, no digest write', async () => {
    const { aws, previous } = fleet();
    aws.rollouts.set('web', (_p, to) => ({ primary: to, state: 'IN_PROGRESS' }));
    const { code } = await deploy(aws, ['--timeout-minutes', '1']);
    expect(code).toBe(1);
    expect(squash(aws.methods())).toEqual([
      ...VERIFY,
      ...MIGRATE,
      ...FIND,
      ...ROLL,
      'updateService',
    ]);
    expect(aws.methods().filter((m) => m === 'describeServices').length).toBeGreaterThan(3);
    expect(aws.services.get('web')).toBe(previous);
    expect(aws.params.get(DIGEST_PARAM)).toBe(OLD_DIGEST);
  });

  it('--no-roll: verify, migrate, record — no service is listed or touched', async () => {
    const { aws } = fleet();
    const { code } = await deploy(aws, ['--no-roll']);
    expect(code).toBe(0);
    expect(squash(aws.methods())).toEqual([...VERIFY, ...MIGRATE, 'putParameter']);
  });

  it('issues only granted actions across every scenario above', () => {
    expect([...issued].sort()).toEqual(
      [
        'ecr:DescribeImages',
        'ecs:DescribeServices',
        'ecs:DescribeTaskDefinition',
        'ecs:DescribeTasks',
        'ecs:ListServices',
        'ecs:RegisterTaskDefinition',
        'ecs:RunTask',
        'ecs:UpdateService',
        'logs:GetLogEvents',
        'ssm:GetParameter',
        'ssm:PutParameter',
      ].sort(),
    );
    for (const action of issued) expect(GRANTED_ACTIONS).toContain(action);
  });
});

// ── No AWS key on the AWS path ───────────────────────────────────────────────

const AWS_KEY_NAMES = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];
/** The Fly-era static keys: the deploy path must not reach for them either. */
const STATIC_KEY_NAMES = [
  'MOTIR_S3_ACCESS_KEY_ID',
  'MOTIR_S3_SECRET_ACCESS_KEY',
  'AWS_ORG_ADMIN_ACCESS_KEY_ID',
  'AWS_ORG_ADMIN_SECRET_ACCESS_KEY',
];

const ROOT = process.cwd();
const DEPLOY_DIR = join('scripts', 'aws-deploy');
/** The workflow ships as a hand-applied patch (MOTIR-9928); scanned once it is in the tree. */
const WORKFLOW = join('.github', 'workflows', 'aws-deploy.yml');
const DEPLOY_PATH = [
  ...readdirSync(join(ROOT, DEPLOY_DIR))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(DEPLOY_DIR, f)),
  ...(existsSync(join(ROOT, WORKFLOW)) ? [WORKFLOW] : []),
];
const AWS_PATH = [
  join('lib', 'blob', 's3.ts'),
  join('scripts', 'fleet', 'fleetAdminCheckQuota.ts'),
  ...DEPLOY_PATH,
];

/** The code of a file with its comments dropped: a comment may name a variable, code may not read it. */
function codeOf(path: string): string {
  const source = readFileSync(path, 'utf8');
  if (path.endsWith('.yml')) return source.replace(/^\s*#.*$/gm, '');
  return stripComments(source);
}

/** `file: NAME` for each forbidden name the file's code contains. */
function keyReads(paths: string[], names: string[]): string[] {
  return paths.flatMap((path) =>
    names.filter((name) => codeOf(path).includes(name)).map((name) => `${path}: ${name}`),
  );
}

describe('no AWS key variable on the AWS path', () => {
  it('scans a named, non-empty file set', () => {
    expect(DEPLOY_PATH).toEqual(
      expect.arrayContaining([
        join(DEPLOY_DIR, 'awsDeploy.ts'),
        join(DEPLOY_DIR, 'migrateRun.ts'),
        join(DEPLOY_DIR, 'ports.ts'),
        join(DEPLOY_DIR, 'rollingDeploy.ts'),
        join(DEPLOY_DIR, 'taskDefinitions.ts'),
      ]),
    );
    for (const path of AWS_PATH) expect(existsSync(join(ROOT, path))).toBe(true);
  });

  it('none of them reads AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY or AWS_SESSION_TOKEN', () => {
    expect(
      keyReads(
        AWS_PATH.map((p) => join(ROOT, p)),
        AWS_KEY_NAMES,
      ),
    ).toEqual([]);
  });

  it('the deploy path reads no static S3 or management key either', () => {
    expect(
      keyReads(
        DEPLOY_PATH.map((p) => join(ROOT, p)),
        STATIC_KEY_NAMES,
      ),
    ).toEqual([]);
  });

  it('fails on a planted name, and ignores one that is only in a comment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'key-scan-'));
    const planted = join(dir, 'planted.ts');
    writeFileSync(
      planted,
      '// AWS_SESSION_TOKEN is read by the SDK\nconst k = process.env.AWS_ACCESS_KEY_ID;\n',
    );
    expect(keyReads([planted], AWS_KEY_NAMES)).toEqual([`${planted}: AWS_ACCESS_KEY_ID`]);
    const yml = join(dir, 'planted.yml');
    writeFileSync(
      yml,
      '# AWS_ACCESS_KEY_ID\nenv:\n  K: ${{ secrets.MOTIR_S3_SECRET_ACCESS_KEY }}\n',
    );
    expect(keyReads([yml], [...AWS_KEY_NAMES, ...STATIC_KEY_NAMES])).toEqual([
      `${yml}: MOTIR_S3_SECRET_ACCESS_KEY`,
    ]);
  });
});

// ── Branches the deploy script's own tests left open ─────────────────────────

describe('edges the predecessors left uncovered', () => {
  it('rolls back and names the roll as failed when an update throws a non-Error', async () => {
    const { aws, previous } = fleet();
    aws.updateService = (cluster, service, taskDefinition) => {
      aws.calls.push(['updateService', cluster, service, taskDefinition]);
      return taskDefinition === previous ? Promise.resolve() : Promise.reject('refused');
    };
    const { code, err } = await deploy(aws);
    expect(code).toBe(1);
    expect(err).toContain('roll: failed');
    expect(aws.methods()).not.toContain('putParameter');
  });

  it('counts a container with no name as a core container to roll', async () => {
    const { containersIn } = await import('@/scripts/aws-deploy/taskDefinitions');
    expect(
      containersIn({ containerDefinitions: [{ image: `${CORE_REPO}@${DIGEST}` }] }, CORE_REPO),
    ).toEqual(['']);
  });
});
