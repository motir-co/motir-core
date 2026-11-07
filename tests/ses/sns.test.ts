import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnsSignatureError, SnsSubscriptionConfirmError } from '@/lib/ses/errors';
import {
  clearSnsCertificateCache,
  confirmSnsSubscription,
  isSnsCertificateUrl,
  isSnsUrl,
  parseSnsMessage,
  snsStringToSign,
  verifySnsMessage,
  type SnsMessage,
} from '@/lib/ses/sns';
import { CERT_URL, SUBSCRIBE_URL, signed, stubSnsFetch } from './snsFixtures';

// The SNS signature check and subscription confirmation (MOTIR-10565), with a
// real RSA key standing in for AWS's and global fetch serving its certificate.

describe('SNS message verification', () => {
  beforeEach(() => clearSnsCertificateCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    clearSnsCertificateCache();
  });

  it.each(['1', '2'] as const)('verifies a signature-version-%s notification', async (version) => {
    stubSnsFetch();
    const message = signed({
      Type: 'Notification',
      Message: '{"eventType":"Bounce"}',
      Subject: 'Amazon SES Email Event Notification',
      SignatureVersion: version,
    });
    await expect(verifySnsMessage(message)).resolves.toBeUndefined();
  });

  it('verifies a subscription confirmation, whose canonical string signs SubscribeURL and Token', async () => {
    stubSnsFetch();
    const message = signed({
      Type: 'SubscriptionConfirmation',
      Message: 'You have chosen to subscribe',
    });
    expect(snsStringToSign(message)).toBe(
      `Message\nYou have chosen to subscribe\nMessageId\n${message.MessageId}\n` +
        `SubscribeURL\n${SUBSCRIBE_URL}\nTimestamp\n${message.Timestamp}\nToken\ntoken-1\n` +
        `TopicArn\n${message.TopicArn}\nType\nSubscriptionConfirmation\n`,
    );
    await expect(verifySnsMessage(message)).resolves.toBeUndefined();
  });

  it('omits an absent Subject from the signed string rather than signing it empty', () => {
    const message = signed({ Type: 'Notification', Message: 'm' });
    expect(snsStringToSign(message)).not.toContain('Subject');
  });

  it('refuses a message whose body was altered after signing', async () => {
    stubSnsFetch();
    const message = signed({ Type: 'Notification', Message: '{"eventType":"Complaint"}' });
    await expect(
      verifySnsMessage({ ...message, Message: '{"eventType":"Bounce"}' }),
    ).rejects.toBeInstanceOf(SnsSignatureError);
  });

  it('refuses a message signed with a key other than the certificate’s', async () => {
    stubSnsFetch();
    const message = signed({ Type: 'Notification', Message: 'm' }, { forge: true });
    await expect(verifySnsMessage(message)).rejects.toBeInstanceOf(SnsSignatureError);
  });

  it.each([
    ['plain http', CERT_URL.replace('https:', 'http:')],
    ['a host that is not SNS', 'https://attacker.example/cert.pem'],
    ['an SNS lookalike suffix', 'https://sns.eu-west-1.amazonaws.com.attacker.example/cert.pem'],
    ['credentials in the URL', 'https://user:pw@sns.eu-west-1.amazonaws.com/cert.pem'],
    ['a port', 'https://sns.eu-west-1.amazonaws.com:8443/cert.pem'],
    ['a path that is not a certificate', 'https://sns.eu-west-1.amazonaws.com/cert.txt'],
    ['not a URL at all', 'not a url'],
  ])('refuses a signing certificate URL with %s, without fetching it', async (_, url) => {
    const fetchMock = stubSnsFetch();
    const message = signed({ Type: 'Notification', Message: 'm', SigningCertURL: url });
    expect(isSnsCertificateUrl(url)).toBe(false);
    await expect(verifySnsMessage(message)).rejects.toBeInstanceOf(SnsSignatureError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts the China partition’s SNS host', () => {
    expect(isSnsUrl('https://sns.cn-north-1.amazonaws.com.cn/x.pem')).toBe(true);
  });

  it('fetches a certificate once per URL and serves it from the cache after', async () => {
    const fetchMock = stubSnsFetch();
    await verifySnsMessage(signed({ Type: 'Notification', Message: 'a' }));
    await verifySnsMessage(signed({ Type: 'Notification', Message: 'b' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('empties the cache once it holds its limit, then keeps working', async () => {
    const fetchMock = stubSnsFetch();
    // Every URL below is a distinct SNS certificate URL that 404s — and one
    // that verifies, fetched again after the cache is cleared by the 17th.
    for (let i = 0; i < 16; i += 1) {
      const url = `https://sns.eu-west-1.amazonaws.com/cert-${i}.pem`;
      fetchMock.mockImplementationOnce(async () => new Response('junk', { status: 200 }));
      await expect(
        verifySnsMessage(signed({ Type: 'Notification', Message: 'm', SigningCertURL: url })),
      ).rejects.toBeInstanceOf(SnsSignatureError);
    }
    await expect(
      verifySnsMessage(signed({ Type: 'Notification', Message: 'm' })),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(17);
  });

  it('refuses when the certificate cannot be fetched or is not served', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    await expect(
      verifySnsMessage(signed({ Type: 'Notification', Message: 'm' })),
    ).rejects.toBeInstanceOf(SnsSignatureError);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('gone', { status: 404 })));
    await expect(
      verifySnsMessage(signed({ Type: 'Notification', Message: 'm' })),
    ).rejects.toBeInstanceOf(SnsSignatureError);
  });

  it('treats a certificate body that is not a key as a failed verification', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not a pem', { status: 200 })));
    await expect(
      verifySnsMessage(signed({ Type: 'Notification', Message: 'm' })),
    ).rejects.toBeInstanceOf(SnsSignatureError);
  });
});

describe('parseSnsMessage', () => {
  const base = signed({ Type: 'Notification', Message: 'm' });

  it('reads a well-formed notification and confirmation', () => {
    expect(parseSnsMessage({ ...base })).toEqual(base);
    const confirmation = signed({ Type: 'SubscriptionConfirmation', Message: 'm' });
    expect(parseSnsMessage({ ...confirmation }).SubscribeURL).toBe(SUBSCRIBE_URL);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'Notification'],
    ['an unknown type', { ...base, Type: 'Other' }],
    ['an unknown signature version', { ...base, SignatureVersion: '3' }],
    ['a missing signature', { ...base, Signature: undefined }],
    ['an empty topic', { ...base, TopicArn: '' }],
    ['a non-string subject', { ...base, Subject: 7 }],
    [
      'a confirmation without a SubscribeURL',
      { ...base, Type: 'SubscriptionConfirmation', Token: 't' },
    ],
  ])('refuses %s', (_, body) => {
    expect(() => parseSnsMessage(body)).toThrow(SnsSignatureError);
  });
});

describe('confirmSnsSubscription', () => {
  afterEach(() => vi.unstubAllGlobals());

  const confirmation = (over: Partial<SnsMessage> = {}) =>
    signed({ Type: 'SubscriptionConfirmation', Message: 'm', ...over });

  it('GETs the SubscribeURL', async () => {
    const fetchMock = stubSnsFetch();
    await confirmSnsSubscription(confirmation());
    expect(fetchMock).toHaveBeenCalledWith(
      SUBSCRIBE_URL,
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('refuses a SubscribeURL that is not an SNS host, without requesting it', async () => {
    const fetchMock = stubSnsFetch();
    await expect(
      confirmSnsSubscription(
        confirmation({ SubscribeURL: 'https://169.254.169.254/latest/meta-data' }),
      ),
    ).rejects.toBeInstanceOf(SnsSignatureError);
    await expect(
      confirmSnsSubscription(confirmation({ SubscribeURL: undefined })),
    ).rejects.toBeInstanceOf(SnsSignatureError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a confirm error naming the status when SNS refuses', async () => {
    stubSnsFetch({ subscribeStatus: 403 });
    await expect(confirmSnsSubscription(confirmation())).rejects.toThrow(
      new SnsSubscriptionConfirmError(
        `Confirming the SNS subscription to ${confirmation().TopicArn} was answered HTTP 403.`,
      ),
    );
  });

  it('throws a confirm error carrying the cause when no answer came', async () => {
    const cause = new Error('ETIMEDOUT');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));
    const failure = await confirmSnsSubscription(confirmation()).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SnsSubscriptionConfirmError);
    expect((failure as Error).cause).toBe(cause);
    expect((failure as Error).message).toMatch(/failed before a response was received/);
  });
});
