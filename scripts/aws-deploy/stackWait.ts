/**
 * The wait between the migrate and the roll (MOTIR-11235): while motir-infra
 * updates the stack that owns core's services, the roll does not start.
 *
 * `deploy-gate.sh` waits for that stack before the deploy starts (MOTIR-10436),
 * and the migrate then runs for a minute or more. A stack update that begins in
 * that minute registers its own revision of each service and rolls it; a roll
 * started meanwhile races it. So the roll asks again here, and waits for the
 * update to settle, so the revision it reads and clones (`rollServices`) is the
 * one the stack left.
 *
 * Like the gate, it must never stop a deploy that would otherwise go out: a
 * status it cannot read, or a stack still busy at the deadline, is logged and
 * the roll goes ahead. The roll's own re-read and its SUPERSEDED check
 * (MOTIR-10117) still guard that case.
 */
import type { DeployAws } from './ports';
import { POLL_INTERVAL_MS, type DeployLog } from './migrateRun';

/** The services stack motir-infra names `<prefix>-services` (the workflow's DEPLOY_STACKS). */
export const servicesStackName = (prefix: string) => `${prefix}-services`;

/** Whether `status` is a stack operation still running. */
export const isStackBusy = (status: string | undefined) =>
  status !== undefined && status.endsWith('_IN_PROGRESS');

/** Why the stack's status could not be read: a refusal, or the error's message. */
async function readStatus(
  aws: DeployAws,
  stack: string,
): Promise<{ status: string | undefined } | { unreadable: string }> {
  try {
    const read = await aws.stackStatus(stack);
    if (read.state === 'not_granted') return { unreadable: 'the deploy role may not read it' };
    return { status: read.value };
  } catch (err) {
    return { unreadable: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error' };
  }
}

/**
 * Wait until `stack` is not mid-update, or `timeoutMs` passes. Resolves to
 * whether the roll may assume the stack settled: `false` when its status could
 * not be read or it was still busy at the deadline, which the log says.
 */
export async function waitForServicesStack(
  aws: DeployAws,
  stack: string,
  timeoutMs: number,
  log: DeployLog,
): Promise<boolean> {
  const deadline = aws.now() + timeoutMs;
  for (;;) {
    const read = await readStatus(aws, stack);
    if ('unreadable' in read) {
      log(`stack: could not read ${stack}, rolling without waiting for it: ${read.unreadable}`);
      return false;
    }
    if (!isStackBusy(read.status)) return true;
    if (aws.now() >= deadline) {
      log(`stack: ${stack} is still ${String(read.status)} at the deadline; rolling anyway`);
      return false;
    }
    log(`stack: waiting for ${stack} (${String(read.status)}) to finish before the roll`);
    await aws.sleep(POLL_INTERVAL_MS);
  }
}
