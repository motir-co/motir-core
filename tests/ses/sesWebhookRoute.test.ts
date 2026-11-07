import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { clearSnsCertificateCache, type SnsMessage } from '@/lib/ses/sns';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  CONFIRM_URL,
  fetchedUrls,
  TOPIC_ARN,
  complaint,
  permanentBounce,
  sesNotification,
  signed,
  stubSnsFetch,
} from './snsFixtures';

// POST /api/ses/webhook (MOTIR-10565) against a real Postgres: the SNS
// signature gate, the topic check, subscription confirmation, and what reaches
// the suppression list — a PERMANENT bounce and a complaint do, a transient
// bounce does not. The SNS signature is real (a test key served as the
// certificate); only global fetch is stubbed.

function post(body: string | SnsMessage): NextRequest {
  return new NextRequest('http://localhost:3000/api/ses/webhook', {
    method: 'POST',
    // SNS posts its JSON as text/plain.
    headers: {
      'content-type': 'text/plain; charset=UTF-8',
      'x-amz-sns-message-type': 'Notification',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function call(body: string | SnsMessage) {
  const { POST } = await import('@/app/api/ses/webhook/route');
  const res = await POST(post(body));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function suppressionRows() {
  return adminDb.emailSuppression.findMany({ orderBy: { address: 'asc' } });
}

describe('POST /api/ses/webhook', () => {
  const originalTopic = process.env['SES_NOTIFICATION_TOPIC_ARN'];
  let fetchMock: ReturnType<typeof stubSnsFetch>;

  beforeEach(async () => {
    await truncateAuthTables();
    clearSnsCertificateCache();
    process.env['SES_NOTIFICATION_TOPIC_ARN'] = TOPIC_ARN;
    fetchMock = stubSnsFetch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalTopic === undefined) delete process.env['SES_NOTIFICATION_TOPIC_ARN'];
    else process.env['SES_NOTIFICATION_TOPIC_ARN'] = originalTopic;
  });

  it('confirms a subscription to our topic by GETting its SubscribeURL', async () => {
    const res = await call(signed({ Type: 'SubscriptionConfirmation', Message: 'confirm me' }));

    expect(res).toEqual({
      status: 200,
      json: { ok: true, result: { outcome: 'subscription_confirmed' } },
    });
    expect(fetchedUrls(fetchMock)).toContain(CONFIRM_URL);
  });

  it('answers 502 when SNS refuses the confirmation', async () => {
    fetchMock = stubSnsFetch({ subscribeStatus: 500 });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await call(signed({ Type: 'SubscriptionConfirmation', Message: 'confirm me' }));

    expect(res).toEqual({
      status: 502,
      json: { code: 'SES_NOTIFICATION_SUBSCRIPTION_CONFIRM_FAILED' },
    });
  });

  it('suppresses every recipient of a PERMANENT bounce, normalised', async () => {
    const res = await call(
      sesNotification(permanentBounce(['  Ada@Example.COM ', 'bob@example.com'], 'NoEmail')),
    );

    expect(res.status).toBe(200);
    expect(res.json['result']).toEqual({
      outcome: 'suppressed',
      reason: 'bounce',
      addresses: ['ada@example.com', 'bob@example.com'],
    });
    const rows = await suppressionRows();
    expect(
      rows.map((r) => [r.address, r.reason, r.provider, r.detail, r.providerMessageId]),
    ).toEqual([
      ['ada@example.com', 'bounce', 'ses', 'NoEmail', 'ses-message-1'],
      ['bob@example.com', 'bounce', 'ses', 'NoEmail', 'ses-message-1'],
    ]);
  });

  it('suppresses the recipient of a complaint', async () => {
    const res = await call(sesNotification(complaint(['carol@example.com'], 'abuse')));

    expect(res.json['result']).toEqual({
      outcome: 'suppressed',
      reason: 'complaint',
      addresses: ['carol@example.com'],
    });
    const [row] = await suppressionRows();
    expect(row).toMatchObject({
      address: 'carol@example.com',
      reason: 'complaint',
      detail: 'abuse',
    });
  });

  it('suppresses a complaint with no feedback type, storing no detail', async () => {
    await call(sesNotification(complaint(['dan@example.com'])));
    const [row] = await suppressionRows();
    expect(row).toMatchObject({ address: 'dan@example.com', detail: null });
  });

  it.each(['Transient', 'Undetermined'])('does NOT suppress a %s bounce', async (bounceType) => {
    const event = permanentBounce(['erin@example.com']);
    event.bounce.bounceType = bounceType;

    const res = await call(sesNotification(event));

    expect(res).toEqual({
      status: 200,
      json: { ok: true, result: { outcome: 'not_suppressed', bounceType } },
    });
    expect(await suppressionRows()).toEqual([]);
  });

  it('reads an identity notification (notificationType) the same as an event (eventType)', async () => {
    const { eventType: _, ...rest } = permanentBounce(['fay@example.com']);
    const res = await call(sesNotification({ ...rest, notificationType: 'Bounce' }));
    expect(res.json['result']).toMatchObject({
      outcome: 'suppressed',
      addresses: ['fay@example.com'],
    });
  });

  it('treats a bounce with no bounce type as undetermined', async () => {
    const res = await call(sesNotification({ eventType: 'Bounce', mail: {}, bounce: {} }));
    expect(res.json['result']).toEqual({ outcome: 'not_suppressed', bounceType: 'Undetermined' });
  });

  it('refreshes the row on a second event for the same address, keeping when it was first suppressed', async () => {
    await call(sesNotification(permanentBounce(['gus@example.com'])));
    const [first] = await suppressionRows();

    await call(sesNotification(complaint(['GUS@example.com'], 'abuse')));

    const rows = await suppressionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      address: 'gus@example.com',
      reason: 'complaint',
      detail: 'abuse',
    });
    expect(rows[0]!.createdAt).toEqual(first!.createdAt);
  });

  it.each<[string, Record<string, unknown> | string]>([
    ['a delivery event', { eventType: 'Delivery', mail: { messageId: 'm' } }],
    ['a Message that is not JSON', 'not json'],
    ['a Message that is JSON but not an object', '"Bounce"'],
    ['a bounce naming no recipients', { eventType: 'Bounce', bounce: { bounceType: 'Permanent' } }],
    [
      'a complaint whose recipients carry no address',
      {
        eventType: 'Complaint',
        complaint: { complainedRecipients: [{}, null, { emailAddress: '' }] },
      },
    ],
    [
      'a bounce whose only address is blank',
      {
        eventType: 'Bounce',
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: ' ' }] },
      },
    ],
  ])('acks and ignores %s', async (_, event) => {
    const message =
      typeof event === 'string'
        ? signed({ Type: 'Notification', Message: event })
        : sesNotification(event);

    const res = await call(message);

    expect(res).toEqual({ status: 200, json: { ok: true, result: { outcome: 'ignored' } } });
    expect(await suppressionRows()).toEqual([]);
  });

  it('acks an UnsubscribeConfirmation without confirming anything', async () => {
    const res = await call(signed({ Type: 'UnsubscribeConfirmation', Message: 'bye' }));

    expect(res.json['result']).toEqual({ outcome: 'ignored' });
    expect(fetchedUrls(fetchMock)).not.toContain(CONFIRM_URL);
  });

  it('refuses 401 a forged signature, and writes nothing', async () => {
    const res = await call(
      signed(
        { Type: 'Notification', Message: JSON.stringify(permanentBounce(['h@example.com'])) },
        { forge: true },
      ),
    );

    expect(res).toEqual({ status: 401, json: { code: 'SES_NOTIFICATION_INVALID_SIGNATURE' } });
    expect(await suppressionRows()).toEqual([]);
  });

  it('refuses 401 a body that is not an SNS message', async () => {
    expect(await call(JSON.stringify({ hello: 'world' }))).toEqual({
      status: 401,
      json: { code: 'SES_NOTIFICATION_INVALID_SIGNATURE' },
    });
  });

  it('refuses 400 a body that is not JSON', async () => {
    expect(await call('{not json')).toEqual({
      status: 400,
      json: { code: 'SES_NOTIFICATION_MALFORMED_BODY' },
    });
  });

  it('refuses 403 a genuinely signed message from another topic — and does not confirm it', async () => {
    const res = await call(
      signed({
        Type: 'SubscriptionConfirmation',
        Message: 'subscribe me',
        TopicArn: 'arn:aws:sns:eu-west-1:999999999999:someone-elses-topic',
      }),
    );

    expect(res).toEqual({ status: 403, json: { code: 'SES_NOTIFICATION_TOPIC_NOT_ALLOWED' } });
    // Refused before ANY request — not even the certificate is fetched.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 500 when no topic is configured', async () => {
    process.env['SES_NOTIFICATION_TOPIC_ARN'] = '  ';

    const res = await call(sesNotification(permanentBounce(['i@example.com'])));

    expect(res).toEqual({ status: 500, json: { code: 'SES_NOTIFICATIONS_NOT_CONFIGURED' } });
    expect(await suppressionRows()).toEqual([]);
  });

  it('answers 500 when the configured topic is not an SNS topic ARN, fetching nothing', async () => {
    process.env['SES_NOTIFICATION_TOPIC_ARN'] = 'https://attacker.example/';

    const res = await call(
      sesNotification(permanentBounce(['k@example.com']), {
        TopicArn: 'https://attacker.example/',
      }),
    );

    expect(res).toEqual({ status: 500, json: { code: 'SES_NOTIFICATIONS_NOT_CONFIGURED' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rethrows an error it does not map', async () => {
    const { sesNotificationService } = await import('@/lib/services/sesNotificationService');
    vi.spyOn(sesNotificationService, 'handleMessage').mockRejectedValue(new Error('db down'));

    await expect(call(sesNotification(permanentBounce(['j@example.com'])))).rejects.toThrow(
      'db down',
    );
  });
});
