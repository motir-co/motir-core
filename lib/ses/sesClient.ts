import {
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandInput,
  type SendEmailCommandOutput,
} from '@aws-sdk/client-sesv2';

// The Amazon SES transport (MOTIR-10565) — the ONLY file in motir-core that
// imports the SES SDK, the same way `lib/blob/s3.ts` is the only one that
// imports S3's (`tests/ciFleet/awsSdkBoundary.test.ts` registers the directory).
// `lib/email.ts` owns everything about the send — the env it reads, the message
// it builds, how a failure is classified — and reaches SES through the one
// method below, so the provider logic stays testable without a network and the
// SDK stays out of every other module.
//
// ⚠️ NO CREDENTIALS ARE PASSED, DELIBERATELY. The client resolves them through
// the SDK's DEFAULT CREDENTIAL CHAIN, which on ECS is the task role served by
// the container credentials endpoint. A key pair in an environment variable is
// the thing this design removes: the task role is rotated by AWS and scoped by
// IAM, and nothing here can leak it.
//
// ⚠️ AND THE SDK MAKES ONE ATTEMPT (`maxAttempts: 1`). The `email.send` job is
// the retry layer for every provider — `lib/email.ts` classifies the failure and
// the job engine decides whether to repeat it — so a second, SDK-internal retry
// loop would compete with it. It would also cost a duplicate: SES's SendEmail
// takes no idempotency key, so an SDK retry after a timed-out request that SES
// had in fact accepted delivers the message twice.

/** The one SES call the email arm makes. */
export interface SesTransport {
  sendEmail(input: SendEmailCommandInput): Promise<SendEmailCommandOutput>;
}

/** A transport bound to one region, credentials from the default chain. */
export function createSesTransport(region: string): SesTransport {
  const client = new SESv2Client({ region, maxAttempts: 1 });
  return {
    sendEmail: (input) => client.send(new SendEmailCommand(input)),
  };
}
