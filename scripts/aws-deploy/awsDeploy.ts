/**
 * `pnpm deploy:aws --digest sha256:<64 hex> [--timeout-minutes 20] [--no-roll]`
 * (Story MOTIR-9709 · MOTIR-9927) — deploy an image CI has already pushed to ECR
 * onto core's Fargate services, in the one order that is safe:
 *
 *   1. verify the digest and that the image exists;
 *   2. run the migrate task from it once; only exit 0 continues;
 *   3. find the cluster's services that run the core image;
 *   4. roll them all onto it and wait for every PRIMARY deployment to complete;
 *   5. on a failure or a timeout, put each back on the revision it ran before;
 *   6. only then record the digest in `/<prefix>/core/image-digest`, which the
 *      next motir-infra deploy builds the services from.
 *
 * `--no-roll` runs 1, 2 and 6 only: the first deploy, before the services exist.
 *
 * It reads `AWS_REGION` and `AWS_DEPLOY_NAME_PREFIX` and nothing else from the
 * environment; the deploy role's credentials reach the SDK through its default
 * chain. It prints one JSON line to stdout and its progress to stderr.
 *
 * Exit codes: 0 when the digest is recorded, 1 otherwise.
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { awsSdkPorts, type DeployAws } from './ports';
import { runMigrate, type DeployLog, type DeployTarget, type MigrateResult } from './migrateRun';
import { findCoreServices, rollBack, rollServices, type RolledService } from './rollingDeploy';
import { ecrRepositoryName, imageRepository } from './taskDefinitions';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

export const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_TIMEOUT_MINUTES = 20;

export const USAGE =
  'usage: deploy:aws --digest sha256:<64 hex> [--timeout-minutes <n>] [--no-roll]' +
  ' (env: AWS_REGION, AWS_DEPLOY_NAME_PREFIX)';

/** The parameter names motir-infra's `lib/config/core-deploy.ts` and `fargate-service.ts` use. */
export const deployTargetParameterName = (prefix: string) => `/${prefix}/core/deploy-target`;
export const imageDigestParameterName = (prefix: string) => `/${prefix}/core/image-digest`;

export interface DeployIo {
  out(line: string): void;
  err(line: string): void;
}

export interface DeployOptions {
  digest: string;
  timeoutMs: number;
  noRoll: boolean;
  namePrefix: string;
}

export interface DeployResult {
  digest: string;
  migrate: { taskArn: string | null; exitCode: number | null } | null;
  services: RolledService[];
  recorded: boolean;
}

/** Parse the flags; `null` on anything malformed. */
export function parseDeployArgs(argv: string[]) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        digest: { type: 'string' },
        'timeout-minutes': { type: 'string' },
        'no-roll': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
    const minutes = Number(values['timeout-minutes'] ?? DEFAULT_TIMEOUT_MINUTES);
    if (!values.digest || !Number.isInteger(minutes) || minutes <= 0) return null;
    return { digest: values.digest, timeoutMs: minutes * 60_000, noRoll: !!values['no-roll'] };
  } catch {
    return null;
  }
}

/** Read and check the deploy-target parameter. */
async function readTarget(aws: DeployAws, prefix: string): Promise<DeployTarget> {
  const name = deployTargetParameterName(prefix);
  const raw = await aws.getParameter(name);
  if (!raw) throw new Error(`${name} is empty`);
  const target = JSON.parse(raw) as Partial<DeployTarget>;
  for (const key of ['cluster', 'migrateFamily', 'migrateContainer', 'region'] as const) {
    if (typeof target[key] !== 'string' || !target[key]) throw new Error(`${name} has no ${key}`);
  }
  if (!Array.isArray(target.subnets) || !Array.isArray(target.securityGroups)) {
    throw new Error(`${name} has no subnets or securityGroups`);
  }
  return target as DeployTarget;
}

/** Step 1: the core repository, read from the migrate task, and the image's presence. */
async function verifyImage(aws: DeployAws, target: DeployTarget, digest: string) {
  const migrate = await aws.describeTaskDefinition(target.migrateFamily);
  const image = migrate.containerDefinitions?.find(
    (c) => c.name === target.migrateContainer,
  )?.image;
  if (!image) throw new Error(`${target.migrateFamily} has no ${target.migrateContainer} image`);
  const repository = imageRepository(image);
  if (!(await aws.imageExists(ecrRepositoryName(repository), digest))) {
    throw new Error(`${repository} has no image ${digest}`);
  }
  return repository;
}

/**
 * Step 6, and the only write of the digest. Reached only from `deploy` after
 * the migrate task exited 0 and every rolled service completed.
 */
async function recordDigest(aws: DeployAws, prefix: string, digest: string): Promise<true> {
  await aws.putParameter(imageDigestParameterName(prefix), digest);
  return true;
}

/** Steps 3 to 5; `null` on success, else why the roll failed. */
async function roll(
  aws: DeployAws,
  target: DeployTarget,
  repository: string,
  image: string,
  options: DeployOptions,
  result: DeployResult,
  log: DeployLog,
): Promise<string | null> {
  const services = await findCoreServices(aws, target.cluster, repository);
  if (services.length === 0) {
    return `no service in cluster ${target.cluster} runs ${repository}; pass --no-roll for the first deploy`;
  }
  try {
    const rolled = await rollServices(aws, target.cluster, services, image, options.timeoutMs, log);
    result.services = rolled.services;
    if (rolled.ok) return null;
  } catch (err) {
    log(`roll: ${err instanceof Error ? err.message : 'failed'}`);
  }
  await rollBack(aws, target.cluster, services, log);
  return 'the roll did not complete; every service is back on its previous revision';
}

/** Steps 1 to 6 against `aws`. Fills `result` as it goes; throws on an AWS error. */
async function deploy(
  aws: DeployAws,
  options: DeployOptions,
  result: DeployResult,
  log: DeployLog,
): Promise<string | null> {
  const target = await readTarget(aws, options.namePrefix);
  const repository = await verifyImage(aws, target, options.digest);
  const image = `${repository}@${options.digest}`;
  log(`deploy: ${image} to ${target.cluster}`);
  const migrate: MigrateResult = await runMigrate(aws, target, image, options.timeoutMs, log);
  result.migrate = { taskArn: migrate.taskArn, exitCode: migrate.exitCode };
  if (!migrate.ok) return `migrate ${migrate.reason}; no service changed`;
  if (!options.noRoll) {
    const failure = await roll(aws, target, repository, image, options, result, log);
    if (failure) return failure;
  }
  result.recorded = await recordDigest(aws, options.namePrefix, options.digest);
  return null;
}

/** Run a deploy and print its one JSON line. */
export async function runDeploy(
  options: DeployOptions,
  aws: DeployAws,
  io: DeployIo,
): Promise<number> {
  const result: DeployResult = {
    digest: options.digest,
    migrate: null,
    services: [],
    recorded: false,
  };
  let failure: string | null;
  try {
    failure = await deploy(aws, options, result, io.err);
  } catch (err) {
    failure = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
  }
  if (failure) io.err(`error: ${failure}`);
  io.out(JSON.stringify(result));
  return failure ? EXIT_ERROR : EXIT_OK;
}

/** The entry: flags and environment in, ports wired, exit code out. */
export async function main(
  argv: string[],
  env: Readonly<Record<string, string | undefined>>,
  io: DeployIo,
  ports: (region: string) => DeployAws = awsSdkPorts,
): Promise<number> {
  const parsed = parseDeployArgs(argv);
  const region = env.AWS_REGION;
  const namePrefix = env.AWS_DEPLOY_NAME_PREFIX;
  if (!parsed || !region || !namePrefix) {
    io.err(USAGE);
    return EXIT_ERROR;
  }
  if (!DIGEST_PATTERN.test(parsed.digest)) {
    io.err(`error: --digest must match ${DIGEST_PATTERN.source}`);
    return EXIT_ERROR;
  }
  return runDeploy({ ...parsed, namePrefix }, ports(region), io);
}

/** Where the entry writes: the JSON line to stdout, progress to stderr. */
export const processIo: DeployIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** Run as a script: the process's flags and environment in, its exit code out. */
export async function entry(
  argv: string[],
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  exit(await main(argv, process.env, processIo));
}

const isEntry =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) void entry(process.argv.slice(2));
