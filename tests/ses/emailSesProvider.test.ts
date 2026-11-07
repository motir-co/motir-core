import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The `ses` arm of lib/email.ts (MOTIR-10565), with the SES SDK MOCKED: nothing
// here reaches AWS, and no credential is needed. The mock replaces the client
// and the command class, so the request asserted below is exactly the one the
// arm hands the SDK — through the real `lib/ses/sesClient.ts`, not a stand-in.

const sdk = vi.hoisted(() => ({
  send: vi.fn(),
  clientConfigs: [] as unknown[],
}));

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {
    constructor(config: unknown) {
      sdk.clientConfigs.push(config);
    }
    send(command: unknown) {
      return sdk.send(command);
    }
  },
  SendEmailCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

import { EmailDeliveryError, classifySesError, getEmailProvider, sesProvider } from '@/lib/email';

const SES_ENV = ['EMAIL_PROVIDER', 'AWS_REGION', 'EMAIL_FROM', 'SES_CONFIGURATION_SET'] as const;

/** An SDK service exception, the shape `@aws-sdk/client-sesv2` throws. */
function serviceError(
  name: string,
  status: number,
  fault: 'client' | 'server' = 'client',
  message = `${name} happened`,
): Error & { $metadata: { httpStatusCode: number } } {
  return Object.assign(new Error(message), {
    name,
    $fault: fault,
    $metadata: { httpStatusCode: status },
  });
}

describe('the ses email provider', () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of SES_ENV) original[key] = process.env[key];
    process.env['EMAIL_PROVIDER'] = 'ses';
    process.env['AWS_REGION'] = 'eu-west-1';
    process.env['EMAIL_FROM'] = 'Motir <no-reply@motir.co>';
    process.env['SES_CONFIGURATION_SET'] = 'motir-transactional';
    sdk.send.mockReset();
    sdk.clientConfigs.length = 0;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('is selected by EMAIL_PROVIDER=ses and sends one SESv2 SendEmail', async () => {
    sdk.send.mockResolvedValue({ MessageId: '0102018f-ses-id', $metadata: {} });
    const send = getEmailProvider();

    const result = await send({
      to: 'ada@example.com',
      subject: 'Reset your password',
      html: '<p>Hello <b>Ada</b></p>',
      headers: { 'List-Unsubscribe': '<https://motir.example/u/1>' },
      idempotencyKey: 'job-key-1',
    });

    expect(result).toEqual({ providerMessageId: '0102018f-ses-id' });
    // The region is the env's, credentials come from the default chain (none
    // passed), and the SDK retries nothing — the job is the retry layer.
    expect(sdk.clientConfigs).toEqual([{ region: 'eu-west-1', maxAttempts: 1 }]);
    expect(sdk.send).toHaveBeenCalledTimes(1);
    const command = sdk.send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(command.input).toEqual({
      FromEmailAddress: 'Motir <no-reply@motir.co>',
      Destination: { ToAddresses: ['ada@example.com'] },
      ConfigurationSetName: 'motir-transactional',
      Content: {
        Simple: {
          Subject: { Data: 'Reset your password', Charset: 'UTF-8' },
          Body: {
            Html: { Data: '<p>Hello <b>Ada</b></p>', Charset: 'UTF-8' },
            Text: { Data: expect.stringContaining('Hello'), Charset: 'UTF-8' },
          },
          Headers: [{ Name: 'List-Unsubscribe', Value: '<https://motir.example/u/1>' }],
        },
      },
    });
  });

  it('sends the caller’s text part as given and adds no Headers when there are none', async () => {
    sdk.send.mockResolvedValue({ MessageId: undefined, $metadata: {} });
    const send = getEmailProvider();

    const result = await send({
      to: 'b@example.com',
      subject: 's',
      html: '<p>h</p>',
      text: 'plain',
    });

    // An accepted send with no id is still accepted.
    expect(result).toEqual({ providerMessageId: null });
    const { input } = sdk.send.mock.calls[0]![0] as {
      input: { Content: { Simple: Record<string, unknown> } };
    };
    expect(input.Content.Simple['Body']).toEqual({
      Html: { Data: '<p>h</p>', Charset: 'UTF-8' },
      Text: { Data: 'plain', Charset: 'UTF-8' },
    });
    expect(input.Content.Simple).not.toHaveProperty('Headers');
  });

  it.each(['AWS_REGION', 'EMAIL_FROM', 'SES_CONFIGURATION_SET'])(
    'refuses to resolve, naming %s, when it is unset or blank',
    (name) => {
      delete process.env[name];
      expect(() => getEmailProvider()).toThrowError(
        new RegExp(`EMAIL_PROVIDER='ses' requires ${name}, which is unset or empty`),
      );
      process.env[name] = '   ';
      expect(() => getEmailProvider()).toThrowError(new RegExp(`requires ${name}`));
      // The hint says where SES's settings live — not Fly's secrets.
      expect(() => getEmailProvider()).toThrowError(/on ECS: the task definition/);
      // The refusal is at resolution: no client was ever built.
      expect(sdk.clientConfigs).toEqual([]);
    },
  );

  it('accepts an injected transport, built with the configured region', async () => {
    const sendEmail = vi.fn().mockResolvedValue({ MessageId: 'injected', $metadata: {} });
    const createTransport = vi.fn().mockReturnValue({ sendEmail });

    const send = sesProvider(createTransport);

    expect(createTransport).toHaveBeenCalledWith('eu-west-1');
    await expect(send({ to: 'c@example.com', subject: 's', html: 'h' })).resolves.toEqual({
      providerMessageId: 'injected',
    });
  });

  it.each([
    ['a spent daily quota', serviceError('LimitExceededException', 400), 'quota_exhausted'],
    [
      'a quota message under another name',
      serviceError('SendingPausedException', 400, 'client', 'Daily message quota exceeded.'),
      'quota_exhausted',
    ],
    ['a send-rate throttle', serviceError('TooManyRequestsException', 429), 'transient'],
    ['an SDK throttle', serviceError('ThrottlingException', 400), 'transient'],
    ['a server fault', serviceError('InternalFailure', 500, 'server'), 'transient'],
    ['a 5xx with no fault flag', serviceError('Unknown', 503, 'client'), 'transient'],
    ['an unverified sender', serviceError('MessageRejected', 400), 'permanent'],
    ['a missing configuration set', serviceError('NotFoundException', 404), 'permanent'],
  ] as const)('classifies %s as %s and throws an EmailDeliveryError', async (_, err, kind) => {
    sdk.send.mockRejectedValue(err);
    const send = getEmailProvider();

    const failure = await send({ to: 'd@example.com', subject: 's', html: 'h' }).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(EmailDeliveryError);
    const delivery = failure as EmailDeliveryError;
    expect(delivery.kind).toBe(kind);
    expect(delivery.status).toBe(err.$metadata.httpStatusCode);
    expect(delivery.providerErrorName).toBe(err.name);
    expect(delivery.cause).toBe(err);
    expect(delivery.message).toMatch(/^SES send to 'd@example\.com' /);
    expect(delivery.message).toContain(`with HTTP ${err.$metadata.httpStatusCode} (${err.name})`);
  });

  it('treats an error that never got a response as transient, with no status', async () => {
    // A socket reset or a failed credential lookup: no `$metadata`.
    sdk.send.mockRejectedValue(new Error('socket hang up'));
    const send = getEmailProvider();

    const failure = (await send({ to: 'e@example.com', subject: 's', html: 'h' }).catch(
      (e: unknown) => e,
    )) as EmailDeliveryError;

    expect(failure.kind).toBe('transient');
    expect(failure.status).toBeUndefined();
    expect(failure.message).toContain('socket hang up');
    expect(failure.message).not.toContain('HTTP');
  });

  it('classifies a non-Error throw without a name as transient, and a nameless response as permanent', async () => {
    expect(classifySesError(undefined)).toBe('transient');
    expect(classifySesError('boom')).toBe('transient');
    expect(classifySesError({ $metadata: {} })).toBe('permanent');
    expect(classifySesError({ $metadata: null })).toBe('transient');

    sdk.send.mockRejectedValue({ $metadata: { httpStatusCode: 400 } });
    const send = getEmailProvider();
    const failure = (await send({ to: 'f@example.com', subject: 's', html: 'h' }).catch(
      (e: unknown) => e,
    )) as EmailDeliveryError;
    expect(failure.kind).toBe('permanent');
    expect(failure.providerErrorName).toBeUndefined();
    expect(failure.message).toContain('with HTTP 400:');
  });
});
