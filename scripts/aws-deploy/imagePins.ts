/**
 * The IMAGE PINS core's deploy writes (MOTIR-10883, MOTIR-10986).
 *
 * A pin is a file in `infra/image-pins/` whose one line is a pull-by-digest
 * image reference. The file is the only place the production value is written:
 * a release lane (or Publish latest on /admin/fleet-status) opens the pull
 * request that changes it, merging that pull request is the deliberate pin, and
 * the AWS deploy of the merge commit copies it into its TARGET before it rolls
 * the services (ECS reads a secret or a parameter only when a task starts, so
 * the roll that follows is what makes the new tasks read it). Rolling a pin back
 * is reverting its pull request.
 *
 * A pin has one of two kinds of target:
 *
 *   - a Secrets Manager SECRET, `<prefix>/core/<file name>` — the two GHCR
 *     image pins (`PINNED_SECRETS`);
 *   - an SSM PARAMETER, `/<prefix>/core/<parameter>` — the code-graph indexer's
 *     ECR reference (`PINNED_PARAMETERS`, MOTIR-10986), which holds no secret and
 *     which motir-infra creates as a `String` parameter that web and worker read
 *     as `MOTIR_INDEXER_IMAGE`.
 *
 * ⚠️ ONLY THE NAMES IN `PINNED_SECRETS` AND `PINNED_PARAMETERS` MAY BE WRITTEN.
 * The deploy role in motir-infra (`coreDeployStatements`: `DEPLOY_PINNED_SECRETS`
 * and `deployPinnedIndexerParameterName`) is granted exactly these targets, and
 * `tests/awsDeploy/imagePins.test.ts` holds the lists equal. A file with any
 * other name is refused before anything changes.
 *
 * ⚠️ A ROLE WITHOUT THE GRANT IS A WARNING, NOT A FAILED DEPLOY. The deploy role
 * gains its statements in motir-infra, which deploys on its own schedule, so the
 * two repositories may merge in either order. Until the grant lands, a pin reads
 * `not_granted` on the deploy's result line and the services roll exactly as
 * before; the daily health check's image probes report the stale pin meanwhile.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeployAws } from './ports';
import type { DeployLog } from './migrateRun';

/** Where the pins live, relative to the repository root. */
export const IMAGE_PINS_DIR = 'infra/image-pins';

/** Every secret a pin may write, by its name under `<prefix>/core/`. */
export const PINNED_SECRETS = ['motir-hosted-agent-image', 'motir-runner-image'] as const;

export type PinnedSecret = (typeof PINNED_SECRETS)[number];

/**
 * Every SSM parameter a pin may write: the pin file's name → the parameter's
 * name under `/<prefix>/core/` (motir-infra's `indexerImageParameterName`).
 */
export const PINNED_PARAMETERS = { 'motir-indexer-image': 'indexer-image' } as const;

export type PinnedParameter = keyof typeof PINNED_PARAMETERS;

/** A pin file's name: a pinned secret or a pinned parameter. */
export type PinName = PinnedSecret | PinnedParameter;

/** Every pin file the deploy accepts, in name order. */
export const PIN_NAMES: readonly PinName[] = [
  ...PINNED_SECRETS,
  ...(Object.keys(PINNED_PARAMETERS) as PinnedParameter[]),
].sort();

/**
 * A GHCR reference by digest, never a tag: the fleet runs agent-authored code,
 * and a tag that moved between the pin and the pull would change what ran
 * (`docs/decisions/ci-runner-fleet.md` §7.2). Lowercase only, as OCI requires.
 */
export const IMAGE_REF_PATTERN =
  /^ghcr\.io(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*){2,}@sha256:[a-f0-9]{64}$/;

/**
 * The indexer's pin: an `indexer` repository in an account's ECR, by digest —
 * the shape motir-ai's release lane mirrors every `indexer-v*` release into
 * (`mirror-ecr`). The parameter itself holds motir-infra's stricter
 * `indexerImagePattern` (this account, this region, `<prefix>/indexer`), which
 * `checkPinTargets` applies before the deploy changes anything.
 */
export const INDEXER_IMAGE_REF_PATTERN =
  /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*indexer@sha256:[a-f0-9]{64}$/;

/** The reference shape each pin file must hold. */
const PATTERN_OF: Record<PinName, { pattern: RegExp; shape: string }> = {
  'motir-hosted-agent-image': {
    pattern: IMAGE_REF_PATTERN,
    shape: 'ghcr.io/<owner>/<name>@sha256:<64 hex>',
  },
  'motir-runner-image': {
    pattern: IMAGE_REF_PATTERN,
    shape: 'ghcr.io/<owner>/<name>@sha256:<64 hex>',
  },
  'motir-indexer-image': {
    pattern: INDEXER_IMAGE_REF_PATTERN,
    shape: '<account>.dkr.ecr.<region>.amazonaws.com/<prefix>/indexer@sha256:<64 hex>',
  },
};

export interface ImagePin {
  readonly name: PinName;
  readonly value: string;
}

/** What the deploy did with one pin; it rides on the deploy's result line. */
export interface AppliedPin {
  readonly name: PinName;
  readonly value: string;
  /** `restored`: written, then put back after the roll failed. */
  state: 'written' | 'unchanged' | 'not_granted' | 'restored';
}

/** A pin file the deploy refuses; nothing has changed when it is thrown. */
export class ImagePinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImagePinError';
  }
}

/** The secret a pin writes: motir-infra's `coreSecretName`. */
export const pinSecretId = (prefix: string, name: PinnedSecret) => `${prefix}/core/${name}`;

/** The parameter a pin writes: motir-infra's `indexerImageParameterName`. */
export const pinParameterName = (prefix: string, name: PinnedParameter) =>
  `/${prefix}/core/${PINNED_PARAMETERS[name]}`;

function isPinName(name: string): name is PinName {
  return (PIN_NAMES as readonly string[]).includes(name);
}

function isPinnedParameter(name: PinName): name is PinnedParameter {
  return Object.hasOwn(PINNED_PARAMETERS, name);
}

/** Where a pin is written: its secret id or its parameter name. */
export const pinTarget = (prefix: string, name: PinName) =>
  isPinnedParameter(name) ? pinParameterName(prefix, name) : pinSecretId(prefix, name);

/** Check the pin files' names and contents. Pure; `*.md` files are notes, not pins. */
export function parseImagePins(files: readonly { name: string; content: string }[]): ImagePin[] {
  const pins: ImagePin[] = [];
  for (const file of files) {
    if (file.name.endsWith('.md')) continue;
    if (!isPinName(file.name)) {
      throw new ImagePinError(
        `${file.name} is not a pinned secret or parameter (${PIN_NAMES.join(', ')}); ` +
          'the deploy role may write only those',
      );
    }
    const value = file.content.trim();
    const { pattern, shape } = PATTERN_OF[file.name];
    if (!pattern.test(value)) {
      throw new ImagePinError(
        `${file.name} must hold one pull-by-digest reference, ` +
          `${shape}, not "${value.slice(0, 120)}"`,
      );
    }
    pins.push({ name: file.name, value });
  }
  return pins.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read and check every pin in `dir`. */
export function readImagePins(dir: string): ImagePin[] {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  return parseImagePins(
    names.map((name) => ({ name, content: readFileSync(join(dir, name), 'utf8') })),
  );
}

/**
 * Check each pin against the account the deploy runs in, before anything is
 * written: the indexer's reference must name `<prefix>/indexer` in the same ECR
 * registry as the core image being deployed — motir-infra's `indexerImagePattern`,
 * which the parameter would otherwise refuse only at `put-parameter`, after the
 * migrate task and the other pins. `coreRepository` is the core image's ECR
 * repository URI (`<account>.dkr.ecr.<region>.<suffix>/<prefix>/<name>`).
 */
export function checkPinTargets(
  prefix: string,
  coreRepository: string,
  pins: readonly ImagePin[],
): void {
  const registry = coreRepository.split('/')[0] ?? '';
  for (const pin of pins) {
    if (!isPinnedParameter(pin.name)) continue;
    const repository = `${registry}/${prefix}/indexer`;
    const at = pin.value.lastIndexOf('@');
    if (pin.value.slice(0, at) !== repository) {
      throw new ImagePinError(
        `${pin.name} must name ${repository} by digest, the indexer repository of the ` +
          `account this deploy runs in, not "${pin.value.slice(0, 160)}"`,
      );
    }
  }
}

/** A pin target's current value: its secret's, or its parameter's. */
function readTarget(aws: DeployAws, prefix: string, name: PinName) {
  return isPinnedParameter(name)
    ? aws.readParameter(pinParameterName(prefix, name))
    : aws.getSecretValue(pinSecretId(prefix, name));
}

/** Make `value` a pin target's current value. */
function writeTarget(aws: DeployAws, prefix: string, name: PinName, value: string) {
  return isPinnedParameter(name)
    ? aws.putParameter(pinParameterName(prefix, name), value)
    : aws.putSecretValue(pinSecretId(prefix, name), value);
}

/**
 * Write each pin whose target holds another value. Returns what it did, in the
 * order given, with the value each written target held before, for `restorePins`.
 */
export async function applyPins(
  aws: DeployAws,
  prefix: string,
  pins: readonly ImagePin[],
  log: DeployLog,
): Promise<{ applied: AppliedPin[]; previous: Map<PinName, string> }> {
  const applied: AppliedPin[] = [];
  const previous = new Map<PinName, string>();
  try {
    await writeEach(aws, prefix, pins, log, applied, previous);
  } catch (err) {
    // A refused write stops the deploy before any service changes, so the pins
    // already written go back first.
    await restorePins(aws, prefix, applied, previous, log);
    throw err;
  }
  return { applied, previous };
}

async function writeEach(
  aws: DeployAws,
  prefix: string,
  pins: readonly ImagePin[],
  log: DeployLog,
  applied: AppliedPin[],
  previous: Map<PinName, string>,
): Promise<void> {
  for (const pin of pins) {
    const id = pinTarget(prefix, pin.name);
    const current = await readTarget(aws, prefix, pin.name);
    if (current.state === 'not_granted') {
      log(`pin: ${id} is not granted to the deploy role; it keeps its value (MOTIR-10883)`);
      applied.push({ name: pin.name, value: pin.value, state: 'not_granted' });
      continue;
    }
    if (current.value === pin.value) {
      applied.push({ name: pin.name, value: pin.value, state: 'unchanged' });
      continue;
    }
    await writeTarget(aws, prefix, pin.name, pin.value);
    log(`pin: ${id} = ${pin.value}`);
    if (current.value !== undefined) previous.set(pin.name, current.value);
    applied.push({ name: pin.name, value: pin.value, state: 'written' });
  }
}

/**
 * After a failed roll, put back the value each written pin replaced, so the
 * services that went back to their previous revision also start with their
 * previous image. A target that held nothing before keeps the pin: there is no
 * earlier value to restore. Best effort: one failed write does not stop the rest.
 */
export async function restorePins(
  aws: DeployAws,
  prefix: string,
  applied: AppliedPin[],
  previous: ReadonlyMap<PinName, string>,
  log: DeployLog,
): Promise<void> {
  for (const pin of applied) {
    const value = previous.get(pin.name);
    if (pin.state !== 'written' || value === undefined) continue;
    const id = pinTarget(prefix, pin.name);
    try {
      await writeTarget(aws, prefix, pin.name, value);
      pin.state = 'restored';
      log(`pin: ${id} restored to ${value}`);
    } catch (err) {
      log(`pin: restoring ${id} failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }
}
