import { Ec2ApiError } from './ec2Client';

// A NEW ACCOUNT'S EC2 ACTIVATION (MOTIR-10204). For a while after
// `CreateAccount` succeeds, EC2 in the new account refuses every call with
// `OptInRequired` (HTTP 401) — or `PendingVerification` while AWS verifies it —
// until its activation finishes: about a minute when observed, and AWS documents
// that it can take longer. Both refusals are retried here, but only for an
// account young enough that activation explains them. The same codes on an old
// account mean a region that is not enabled or a service the account cannot use,
// and waiting would only delay that answer.
//
// References, read 2026-11-01:
//   https://docs.aws.amazon.com/AWSEC2/latest/APIReference/errors-overview.html
//   (OptInRequired, PendingVerification), and the Organizations guide's note that a
//   new member account's services can take time to activate.

/** The EC2 refusals a new account answers until its activation finishes. */
export const AWS_EC2_ACTIVATION_CODES: readonly string[] = ['OptInRequired', 'PendingVerification'];

/** How young an account must be for an activation refusal to be waited out. */
export const AWS_EC2_ACTIVATION_WINDOW_MS = 24 * 60 * 60_000;

/** How long one run waits for EC2 to activate before asking for a re-run. */
export const AWS_EC2_ACTIVATION_TIMEOUT_MS = 15 * 60_000;

const ACTIVATION_POLL_MS = 15_000;

/** EC2 in a new account was still activating at the deadline: run again later. */
export class AwsEc2ActivationPendingError extends Error {
  readonly code = 'AWS_EC2_ACTIVATION_PENDING';
  constructor(
    readonly accountId: string,
    /** The refusal EC2 was still answering: `OptInRequired` or `PendingVerification`. */
    readonly awsCode: string,
  ) {
    super(
      `EC2 in AWS account ${accountId} was still activating (${awsCode}) after ` +
        `${AWS_EC2_ACTIVATION_TIMEOUT_MS / 60_000} minutes; run the command again to keep waiting`,
    );
    this.name = 'AwsEc2ActivationPendingError';
  }
}

export interface AwsEc2ActivationInput {
  readonly accountId: string;
  /** When the account joined the organization; `null` when that is not known,
   *  which is never taken for a new account. */
  readonly accountJoinedAt: Date | null;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Whether `err` is the refusal of an account that is still activating EC2. */
export function isAwsEc2ActivationRefusal(err: unknown): err is Ec2ApiError {
  return err instanceof Ec2ApiError && AWS_EC2_ACTIVATION_CODES.includes(err.code);
}

/**
 * Run `call` — the first EC2 call a run makes in an account — and, while EC2
 * answers an activation refusal in an account younger than the window, call it
 * again until it answers or the deadline passes. Every other error, and an
 * activation refusal from an older account (or one whose age is unknown), is
 * thrown unchanged.
 */
export async function withAwsEc2Activation<T>(
  call: () => Promise<T>,
  input: AwsEc2ActivationInput,
): Promise<T> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const joinedAt = input.accountJoinedAt?.getTime() ?? null;
  const deadline = now() + AWS_EC2_ACTIVATION_TIMEOUT_MS;
  for (;;) {
    try {
      return await call();
    } catch (err) {
      if (!isAwsEc2ActivationRefusal(err)) throw err;
      if (joinedAt === null || now() - joinedAt > AWS_EC2_ACTIVATION_WINDOW_MS) throw err;
      if (now() >= deadline) throw new AwsEc2ActivationPendingError(input.accountId, err.code);
      await sleep(ACTIVATION_POLL_MS);
    }
  }
}
