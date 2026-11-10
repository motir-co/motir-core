/**
 * The IMAGE PINS core's deploy writes into Secrets Manager (MOTIR-10883).
 *
 * A pin is a file in `infra/image-pins/` whose NAME is the secret's name under
 * `<prefix>/core/` and whose one line is a pull-by-digest image reference. The
 * file is the only place the production value is written: a release lane opens
 * the pull request that changes it, merging that pull request is the deliberate
 * pin, and the AWS deploy of the merge commit copies it into the secret before it
 * rolls the services (ECS reads a secret only when a task starts, so the roll
 * that follows is what makes the new tasks read it). Rolling a pin back is
 * reverting its pull request.
 *
 * ⚠️ ONLY THE NAMES IN `PINNED_SECRETS` MAY BE WRITTEN. The deploy role in
 * motir-infra (`coreDeployStatements`, `DEPLOY_PINNED_SECRETS`) is granted
 * exactly these secrets, and `tests/awsDeploy/imagePins.test.ts` holds the two
 * lists equal. A file with any other name is refused before anything changes.
 *
 * ⚠️ A ROLE WITHOUT THE GRANT IS A WARNING, NOT A FAILED DEPLOY. The deploy role
 * gains its secret statement in motir-infra, which deploys on its own schedule,
 * so the two repositories may merge in either order. Until the grant lands, a
 * pin reads `not_granted` on the deploy's result line and the services roll
 * exactly as before; the daily health check's runner-image probes report the
 * stale pin meanwhile.
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
 * A GHCR reference by digest, never a tag: the fleet runs agent-authored code,
 * and a tag that moved between the pin and the pull would change what ran
 * (`docs/decisions/ci-runner-fleet.md` §7.2). Lowercase only, as OCI requires.
 */
export const IMAGE_REF_PATTERN =
  /^ghcr\.io(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*){2,}@sha256:[a-f0-9]{64}$/;

export interface ImagePin {
  readonly name: PinnedSecret;
  readonly value: string;
}

/** What the deploy did with one pin; it rides on the deploy's result line. */
export interface AppliedPin {
  readonly name: PinnedSecret;
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

function isPinnedSecret(name: string): name is PinnedSecret {
  return (PINNED_SECRETS as readonly string[]).includes(name);
}

/** Check the pin files' names and contents. Pure; `*.md` files are notes, not pins. */
export function parseImagePins(files: readonly { name: string; content: string }[]): ImagePin[] {
  const pins: ImagePin[] = [];
  for (const file of files) {
    if (file.name.endsWith('.md')) continue;
    if (!isPinnedSecret(file.name)) {
      throw new ImagePinError(
        `${file.name} is not a pinned secret (${PINNED_SECRETS.join(', ')}); ` +
          'the deploy role may write only those',
      );
    }
    const value = file.content.trim();
    if (!IMAGE_REF_PATTERN.test(value)) {
      throw new ImagePinError(
        `${file.name} must hold one pull-by-digest reference, ` +
          `ghcr.io/<owner>/<name>@sha256:<64 hex>, not "${value.slice(0, 120)}"`,
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
 * Write each pin whose secret holds another value. Returns what it did, in the
 * order given, with the value each written secret held before, for `restorePins`.
 */
export async function applyPins(
  aws: DeployAws,
  prefix: string,
  pins: readonly ImagePin[],
  log: DeployLog,
): Promise<{ applied: AppliedPin[]; previous: Map<PinnedSecret, string> }> {
  const applied: AppliedPin[] = [];
  const previous = new Map<PinnedSecret, string>();
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
  previous: Map<PinnedSecret, string>,
): Promise<void> {
  for (const pin of pins) {
    const id = pinSecretId(prefix, pin.name);
    const current = await aws.getSecretValue(id);
    if (current.state === 'not_granted') {
      log(`pin: ${id} is not granted to the deploy role; it keeps its value (MOTIR-10883)`);
      applied.push({ name: pin.name, value: pin.value, state: 'not_granted' });
      continue;
    }
    if (current.value === pin.value) {
      applied.push({ name: pin.name, value: pin.value, state: 'unchanged' });
      continue;
    }
    await aws.putSecretValue(id, pin.value);
    log(`pin: ${id} = ${pin.value}`);
    if (current.value !== undefined) previous.set(pin.name, current.value);
    applied.push({ name: pin.name, value: pin.value, state: 'written' });
  }
}

/**
 * After a failed roll, put back the value each written pin replaced, so the
 * services that went back to their previous revision also start with their
 * previous image. A secret that held nothing before keeps the pin: there is no
 * earlier value to restore. Best effort: one failed write does not stop the rest.
 */
export async function restorePins(
  aws: DeployAws,
  prefix: string,
  applied: AppliedPin[],
  previous: ReadonlyMap<PinnedSecret, string>,
  log: DeployLog,
): Promise<void> {
  for (const pin of applied) {
    const value = previous.get(pin.name);
    if (pin.state !== 'written' || value === undefined) continue;
    const id = pinSecretId(prefix, pin.name);
    try {
      await aws.putSecretValue(id, value);
      pin.state = 'restored';
      log(`pin: ${id} restored to ${value}`);
    } catch (err) {
      log(`pin: restoring ${id} failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }
}
