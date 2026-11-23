import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE GRACE-WINDOW NOTICES (Story MOTIR-9800 · MOTIR-12136) over real Postgres:
// each notice reaches the organisation's Owner and Admins — never a Member — by
// one `email.send` each, in their own language, exactly once per
// (application, kind); a kind that no longer matches its application's state
// sends nothing; the hourly sweep enqueues only the smallest reminder reached;
// the ledger is workspace-scoped; and the banner reads back the newest notice.
// The job queue is a recording stub.

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: vi.fn(async () => undefined) }));

const { db } = await import('@/lib/db');
const { HostedApplicationNoticeKind } = await import('@/generated/prisma/client');
const { GRACE_NOTICE_KINDS } = await import('@/lib/hosting/vocabulary');
const { sendEvent } = await import('@/lib/jobs/sendEvent');
const { hostedApplicationNoticeRepository } =
  await import('@/lib/repositories/hostedApplicationNoticeRepository');
const { hostedApplicationGraceNotifier, GRACE_REMINDER_DAYS } =
  await import('@/lib/services/hostedApplicationGraceNotifier');
const { formatDate } = await import('@/lib/utils/datetime');
const { withWorkspaceServiceContext } = await import('@/lib/workspaces/context');
const { hostedApplicationGraceNotice } =
  await import('@/lib/jobs/definitions/hostedApplicationGraceNotice');
const { HOSTED_APPLICATION_GRACE_NOTICE_SWEEP_CRON, hostedApplicationGraceNoticeSweep } =
  await import('@/lib/jobs/definitions/hostedApplicationGraceNoticeSweep');
const { jobDefinitions } = await import('@/lib/jobs/registry');
const { jobServices } = await import('@/lib/jobs/services');
const { createTestUser } = await import('../fixtures/userFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const fixtures = await import('../helpers/hostedApplicationExportFixtures');

const DAY = 86_400_000;
const HOUR = 3_600_000;

beforeEach(async () => {
  await truncateAuthTables();
  vi.mocked(sendEvent).mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** An organisation with its Owner (no saved language), a German-speaking Admin
 *  and a Member, and one serverless or Fly application in `state`. */
async function seedWorld(opts: { state?: string; stopsAt?: Date; handedOverAt?: Date } = {}) {
  const world = await fixtures.seedExportWorld({ state: opts.state ?? 'grace' });
  const admin = await createTestUser({ name: 'Ada' });
  const member = await createTestUser({ name: 'Mo' });
  await adminDb.user.update({ where: { id: admin.id }, data: { locale: 'de' } });
  await fixtures.addOrgMember(world.organizationId, admin.id, 'admin');
  await fixtures.addOrgMember(world.organizationId, member.id, 'member');
  const app = await adminDb.hostedApplication.update({
    where: { id: world.applicationId },
    data: {
      stopsAt: opts.stopsAt ?? new Date('2026-12-20T10:00:00Z'),
      handedOverAt: opts.handedOverAt ?? null,
    },
    include: { projectRepository: true },
  });
  const owner = await adminDb.user.findUniqueOrThrow({ where: { id: world.fx.ownerId } });
  return { ...world, app, owner, admin, member };
}

const emails = () =>
  vi
    .mocked(sendEvent)
    .mock.calls.filter(([name]) => name === 'email.send')
    .map(
      ([, data]) => data as unknown as Record<string, unknown> & { data: Record<string, unknown> },
    );
const notices = () =>
  vi
    .mocked(sendEvent)
    .mock.calls.filter(([name]) => name === 'hosting.application-grace.notice')
    .map(([, data]) => data as { applicationId: string; kind: string; idempotencyKey: string });
const ledger = (applicationId: string) =>
  adminDb.hostedApplicationNotice.findMany({ where: { applicationId } });

describe('the vocabulary', () => {
  it('the Prisma enum carries exactly the grace notice kinds', () => {
    expect(Object.values(HostedApplicationNoticeKind).sort()).toEqual(
      [...GRACE_NOTICE_KINDS].sort(),
    );
    expect(GRACE_REMINDER_DAYS.map((t) => t.kind)).toEqual(['seven_days', 'one_day']);
  });
});

describe('notify', () => {
  it.each([
    ['transferred', 'grace'],
    ['seven_days', 'grace'],
    ['one_day', 'grace'],
    ['stopped', 'handed_over'],
  ] as const)(
    'sends %s to every Owner and Admin, never a Member, each in their language',
    async (kind, state) => {
      const stoppedAt = new Date('2026-12-02T08:00:00Z');
      const w = await seedWorld({
        state,
        handedOverAt: state === 'handed_over' ? stoppedAt : undefined,
      });
      expect(
        await hostedApplicationGraceNotifier.notify({ applicationId: w.applicationId, kind }),
      ).toEqual({ outcome: 'sent', recipients: 2 });

      const sent = emails();
      expect(sent.map((e) => e.to).sort()).toEqual([w.admin.email, w.owner.email].sort());
      expect(sent.map((e) => e.to)).not.toContain(w.member.email);
      const dateIso = (kind === 'stopped' ? stoppedAt : w.app.stopsAt!).toISOString();
      for (const email of sent) {
        const recipient = email.to === w.admin.email ? w.admin : w.owner;
        const locale = recipient === w.admin ? 'de' : 'en';
        expect(email).toMatchObject({
          workspaceId: w.fx.workspaceId,
          template: 'hosted-application-grace',
          idempotencyKey: `hosting-grace:${w.applicationId}:${kind}:${recipient.id}`,
          data: {
            kind,
            recipientName: recipient.name,
            repositoryName: w.app.projectRepository.name,
            stopDate: formatDate(dateIso, locale),
            locale,
          },
        });
        expect(email.data['productionUrl']).toMatch(
          new RegExp(`/settings/project/production\\?repository=${w.app.projectRepositoryId}$`),
        );
      }
      const rows = await ledger(w.applicationId);
      expect(rows).toMatchObject([{ kind, workspaceId: w.fx.workspaceId }]);
    },
  );

  it('sends a notice once: a second run enqueues and records nothing', async () => {
    const w = await seedWorld();
    await hostedApplicationGraceNotifier.notify({
      applicationId: w.applicationId,
      kind: 'transferred',
    });
    vi.mocked(sendEvent).mockClear();
    expect(
      await hostedApplicationGraceNotifier.notify({
        applicationId: w.applicationId,
        kind: 'transferred',
      }),
    ).toEqual({ outcome: 'already_sent' });
    expect(sendEvent).not.toHaveBeenCalled();
    expect(await ledger(w.applicationId)).toHaveLength(1);
  });

  it('a retry after the emails were enqueued re-sends them under the same keys, which the queue collapses, and records once', async () => {
    const w = await seedWorld();
    vi.spyOn(hostedApplicationNoticeRepository, 'create').mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(
      hostedApplicationGraceNotifier.notify({ applicationId: w.applicationId, kind: 'one_day' }),
    ).rejects.toThrow('db down');
    const firstKeys = emails().map((e) => e.idempotencyKey);
    vi.mocked(sendEvent).mockClear();
    await hostedApplicationGraceNotifier.notify({
      applicationId: w.applicationId,
      kind: 'one_day',
    });
    expect(
      emails()
        .map((e) => e.idempotencyKey)
        .sort(),
    ).toEqual([...firstKeys].sort());
    expect(await ledger(w.applicationId)).toHaveLength(1);
  });

  it('two concurrent runs record one row (the loser’s P2002 counts as recorded)', async () => {
    const w = await seedWorld();
    const run = () =>
      hostedApplicationGraceNotifier.notify({ applicationId: w.applicationId, kind: 'seven_days' });
    const outcomes = await Promise.all([run(), run(), run()]);
    expect(outcomes.some((o) => o.outcome === 'sent')).toBe(true);
    expect(await ledger(w.applicationId)).toHaveLength(1);
    expect(new Set(emails().map((e) => e.idempotencyKey)).size).toBe(2);
  });

  it('rethrows a ledger failure that is not a lost race', async () => {
    const w = await seedWorld();
    vi.spyOn(hostedApplicationNoticeRepository, 'create').mockRejectedValueOnce('not an Error');
    await expect(
      hostedApplicationGraceNotifier.notify({ applicationId: w.applicationId, kind: 'seven_days' }),
    ).rejects.toBe('not an Error');
  });

  it.each([
    ['transferred', 'handed_over'],
    ['seven_days', 'live'],
    ['one_day', 'handing_over'],
    ['stopped', 'grace'],
  ] as const)('sends and records nothing for %s on a %s application', async (kind, state) => {
    const w = await seedWorld({ state });
    expect(
      await hostedApplicationGraceNotifier.notify({ applicationId: w.applicationId, kind }),
    ).toEqual({ outcome: 'not_applicable', reason: 'state_mismatch' });
    expect(sendEvent).not.toHaveBeenCalled();
    expect(await ledger(w.applicationId)).toEqual([]);
  });

  it('sends nothing for an application that is gone', async () => {
    expect(
      await hostedApplicationGraceNotifier.notify({ applicationId: 'nope', kind: 'stopped' }),
    ).toEqual({ outcome: 'not_applicable', reason: 'no_application' });
  });

  it('records the notice with no recipient when the organisation has no admin with an address', async () => {
    const w = await seedWorld();
    await adminDb.organizationMembership.deleteMany({
      where: { organizationId: w.organizationId, role: { in: ['owner', 'admin'] } },
    });
    expect(
      await hostedApplicationGraceNotifier.notify({
        applicationId: w.applicationId,
        kind: 'transferred',
      }),
    ).toEqual({ outcome: 'sent', recipients: 0 });
    expect(emails()).toEqual([]);
  });

  it('mails no one when the workspace’s organisation can no longer be read', async () => {
    const w = await seedWorld();
    const { workspaceRepository } = await import('@/lib/repositories/workspaceRepository');
    vi.spyOn(workspaceRepository, 'findOrganizationId').mockResolvedValueOnce(null);
    expect(
      await hostedApplicationGraceNotifier.notify({
        applicationId: w.applicationId,
        kind: 'transferred',
      }),
    ).toEqual({ outcome: 'sent', recipients: 0 });
    expect(emails()).toEqual([]);
  });

  it('a window with no stopsAt names today’s date, and its banner reads no stopsAt', async () => {
    const w = await seedWorld();
    await adminDb.hostedApplication.update({
      where: { id: w.applicationId },
      data: { stopsAt: null },
    });
    await hostedApplicationGraceNotifier.notify({
      applicationId: w.applicationId,
      kind: 'transferred',
    });
    const owner = emails().find((e) => e.to === w.owner.email)!;
    expect(owner.data['stopDate']).toBe(formatDate(new Date().toISOString(), 'en'));
    const latest = await withWorkspaceServiceContext(w.fx.workspaceId, (tx) =>
      hostedApplicationGraceNotifier.latestGraceNotice(w.applicationId, tx),
    );
    expect(latest).toMatchObject({ kind: 'transferred', stopsAt: null });
  });
});

describe('sendDueReminders', () => {
  const now = new Date('2026-12-10T12:00:00Z');
  const at = (ms: number) => new Date(now.getTime() + ms);

  it('enqueues only the smallest threshold reached, once, for grace applications within 7 days', async () => {
    const sixDays = await seedWorld({ stopsAt: at(6 * DAY) });
    const halfDay = await seedWorld({ stopsAt: at(12 * HOUR) });
    const tenDays = await seedWorld({ stopsAt: at(10 * DAY) });
    const past = await seedWorld({ stopsAt: at(-HOUR) });
    const live = await seedWorld({ state: 'live', stopsAt: at(2 * DAY) });

    expect(await hostedApplicationGraceNotifier.sendDueReminders(now)).toEqual({ enqueued: 2 });
    expect(notices()).toEqual(
      expect.arrayContaining([
        {
          workspaceId: sixDays.fx.workspaceId,
          applicationId: sixDays.applicationId,
          kind: 'seven_days',
          idempotencyKey: `${sixDays.applicationId}:seven_days`,
        },
        {
          workspaceId: halfDay.fx.workspaceId,
          applicationId: halfDay.applicationId,
          kind: 'one_day',
          idempotencyKey: `${halfDay.applicationId}:one_day`,
        },
      ]),
    );
    const told = notices().map((n) => n.applicationId);
    for (const quiet of [tenDays, past, live]) expect(told).not.toContain(quiet.applicationId);
    expect(notices().filter((n) => n.applicationId === halfDay.applicationId)).toHaveLength(1);
  });

  it('skips a reminder already recorded, then sends the next threshold when it is reached', async () => {
    const w = await seedWorld({ stopsAt: at(5 * DAY) });
    await hostedApplicationGraceNotifier.notify({
      applicationId: w.applicationId,
      kind: 'seven_days',
    });
    vi.mocked(sendEvent).mockClear();
    expect(await hostedApplicationGraceNotifier.sendDueReminders(now)).toEqual({ enqueued: 0 });

    const later = new Date(w.app.stopsAt!.getTime() - 20 * HOUR);
    expect(await hostedApplicationGraceNotifier.sendDueReminders(later)).toEqual({ enqueued: 1 });
    expect(notices()).toMatchObject([{ applicationId: w.applicationId, kind: 'one_day' }]);
  });

  it('a failure on one application never holds up the others', async () => {
    const a = await seedWorld({ stopsAt: at(2 * DAY) });
    const b = await seedWorld({ stopsAt: at(3 * DAY) });
    vi.spyOn(hostedApplicationNoticeRepository, 'find').mockRejectedValueOnce(new Error('boom'));
    expect(await hostedApplicationGraceNotifier.sendDueReminders(now)).toEqual({ enqueued: 1 });
    expect(notices().map((n) => n.applicationId)).toEqual([b.applicationId]);
    void a;
  });

  it('defaults to the current time', async () => {
    await seedWorld({ stopsAt: new Date(Date.now() + 3 * DAY) });
    expect(await hostedApplicationGraceNotifier.sendDueReminders()).toEqual({ enqueued: 1 });
  });
});

describe('latestGraceNotice', () => {
  it('reads the newest notice with the application’s stopsAt, null when none, and nothing across workspaces', async () => {
    const w = await seedWorld();
    const read = (workspaceId: string) =>
      withWorkspaceServiceContext(workspaceId, (tx) =>
        hostedApplicationGraceNotifier.latestGraceNotice(w.applicationId, tx),
      );
    expect(await read(w.fx.workspaceId)).toBeNull();

    await adminDb.hostedApplicationNotice.create({
      data: {
        workspaceId: w.fx.workspaceId,
        applicationId: w.applicationId,
        kind: 'transferred',
        sentAt: new Date('2026-11-20T10:00:00Z'),
      },
    });
    await adminDb.hostedApplicationNotice.create({
      data: {
        workspaceId: w.fx.workspaceId,
        applicationId: w.applicationId,
        kind: 'seven_days',
        sentAt: new Date('2026-12-13T10:00:00Z'),
      },
    });
    expect(await read(w.fx.workspaceId)).toEqual({
      kind: 'seven_days',
      sentAt: new Date('2026-12-13T10:00:00Z'),
      stopsAt: w.app.stopsAt,
    });

    const other = await seedWorld();
    expect(await read(other.fx.workspaceId)).toBeNull();
    expect(
      await withWorkspaceServiceContext(other.fx.workspaceId, (tx) =>
        tx.hostedApplicationNotice.findMany(),
      ),
    ).toEqual([]);
  });
});

describe('the hosted_application_notice table', () => {
  it('is workspace-scoped: foreign key, index, unique key, forced RLS and its one policy', async () => {
    const [table] = await adminDb.$queryRaw<{ rls: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS rls, relforcerowsecurity AS forced
      FROM pg_class WHERE relname = 'hosted_application_notice'`;
    expect(table).toEqual({ rls: true, forced: true });
    const policies = await adminDb.$queryRaw<{ policyname: string; cmd: string; qual: string }[]>`
      SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'hosted_application_notice'`;
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      policyname: 'hosted_application_notice_active_workspace',
      cmd: 'ALL',
    });
    expect(policies[0]!.qual).toContain("current_setting('app.workspace_id'::text, true)");
    const indexes = await adminDb.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'hosted_application_notice'`;
    const defs = indexes.map((i) => i.indexdef).join('\n');
    expect(defs).toMatch(
      /INDEX \S+ ON public\.hosted_application_notice USING btree \(workspace_id\)/,
    );
    expect(defs).toMatch(
      /UNIQUE INDEX \S+ ON public\.hosted_application_notice USING btree \(application_id, kind\)/,
    );
    const fks = await adminDb.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'hosted_application_notice'::regclass AND contype = 'f'`;
    expect(fks.map((f) => f.def).sort()).toEqual([
      'FOREIGN KEY (application_id) REFERENCES hosted_application(id) ON UPDATE CASCADE ON DELETE CASCADE',
      'FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON UPDATE CASCADE ON DELETE CASCADE',
    ]);
  });
});

describe('the two jobs', () => {
  function ctxFor<T>(name: string, data: unknown) {
    const run = vi.fn(async (_id: string, fn: () => unknown) => fn());
    const ctx = { event: { name, data, id: 'e' }, runId: 'run', attempt: 0, step: { run } };
    return { ctx: ctx as unknown as T, run };
  }

  it('hosting.application-grace.notice is registered and runs notify in its step', async () => {
    expect(jobDefinitions).toContain(hostedApplicationGraceNotice);
    expect(jobServices.hostedApplicationGraceNotifier).toBe(hostedApplicationGraceNotifier);
    const notify = vi
      .spyOn(hostedApplicationGraceNotifier, 'notify')
      .mockResolvedValue({ outcome: 'already_sent' });
    type Ctx = Parameters<typeof hostedApplicationGraceNotice.handler>[0];
    const { ctx, run } = ctxFor<Ctx>('hosting.application-grace.notice', {
      workspaceId: 'ws',
      applicationId: 'app',
      kind: 'stopped',
      idempotencyKey: 'app:stopped',
    });
    await expect(hostedApplicationGraceNotice.handler(ctx, jobServices)).resolves.toEqual({
      outcome: 'already_sent',
    });
    expect(run).toHaveBeenCalledWith('send-grace-notice', expect.any(Function));
    expect(notify).toHaveBeenCalledWith({ applicationId: 'app', kind: 'stopped' });
  });

  it('system.hosted-application-grace-notice-sweep is registered hourly and runs the reminder pass', async () => {
    expect(jobDefinitions).toContain(hostedApplicationGraceNoticeSweep);
    expect(HOSTED_APPLICATION_GRACE_NOTICE_SWEEP_CRON).toBe('25 * * * *');
    vi.spyOn(hostedApplicationGraceNotifier, 'sendDueReminders').mockResolvedValue({
      enqueued: 3,
    });
    type Ctx = Parameters<typeof hostedApplicationGraceNoticeSweep.handler>[0];
    const { ctx, run } = ctxFor<Ctx>('system.hosted-application-grace-notice-sweep', {});
    await expect(hostedApplicationGraceNoticeSweep.handler(ctx, jobServices)).resolves.toEqual({
      enqueued: 3,
    });
    expect(run).toHaveBeenCalledWith('enqueue-due-grace-reminders', expect.any(Function));
  });
});
