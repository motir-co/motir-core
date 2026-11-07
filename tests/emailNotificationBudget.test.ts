import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { EmailTemplate } from '@/lib/services/emailService';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from './helpers/db';
import { randomToken } from './helpers/random';

// The NOTIFICATION budget (MOTIR-5873), against a real Postgres, with only the
// provider's fetch stubbed.
//
// Every template shares one provider account and so one daily quota. On
// 2026-09-14 a burst of watcher notifications spent it — and a password reset
// asked for that day would have been refused the same way. The budget caps
// notification-class sends per rolling 24 hours so the rest of the quota stays
// for the mail a person is waiting on.
//
// ⚠️ THE SEEDED ROWS ARE WORKSPACE-SCOPED ON PURPOSE. `email_delivery` is FORCE
// row-level security, and a watcher notification's row carries its workspace.
// A count read off the singleton or under a workspace binding comes back
// SMALLER and plausible — and the budget then never engages. Seeding rows
// under a workspace no caller is bound to is what makes a narrowed read fail
// this file rather than pass it.

const RESEND_ENV = [
  'EMAIL_PROVIDER',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'EMAIL_NOTIFICATION_DAILY_BUDGET',
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

describe('the notification budget (MOTIR-5873)', () => {
  const original: Record<string, string | undefined> = {};
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await truncateAuthTables();
    await truncateJobRuns();
    for (const key of RESEND_ENV) original[key] = process.env[key];
    process.env['EMAIL_PROVIDER'] = 'resend';
    process.env['RESEND_API_KEY'] = 'test-resend-key';
    process.env['EMAIL_FROM'] = 'Motir <no-reply@motir.co>';
    process.env['EMAIL_NOTIFICATION_DAILY_BUDGET'] = '3';
    // A FRESH Response per call — a body can be read once.
    fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ id: `msg_${randomToken()}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await truncateJobRuns();
  });

  /** `sendEmail` resolves its provider at import, so re-import under the stubbed env. */
  async function loadEmailService() {
    vi.resetModules();
    const { emailService } = await import('@/lib/services/emailService');
    return emailService;
  }

  async function makeWorkspace(): Promise<string> {
    const tag = randomToken();
    const user = await usersService.createUser({
      email: `budget-${tag}@example.com`,
      password: 'hunter2hunter2',
      name: `Budget ${tag}`,
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: `Budget WS ${tag}`,
      ownerUserId: user.id,
    });
    return workspace.id;
  }

  /** Accepted deliveries, written as the admin role so no binding hides them from the SEED. */
  async function seedAccepted(
    workspaceId: string | null,
    template: EmailTemplate,
    count: number,
    ageMs = 60_000,
  ): Promise<void> {
    const createdAt = new Date(Date.now() - ageMs);
    for (let i = 0; i < count; i += 1) {
      await adminDb.emailDelivery.create({
        data: {
          providerMessageId: `seed_${randomToken()}`,
          provider: 'resend',
          recipient: 'mo@example.com',
          template,
          workspaceId,
          createdAt,
        },
      });
    }
  }

  function watcherComment(workspaceId: string) {
    return {
      to: 'mo@example.com',
      template: 'watcher-comment-notification' as const,
      data: {
        recipientName: 'Mo',
        authorName: 'Yue',
        workItemIdentifier: 'MOTIR-1',
        workItemTitle: 'A card',
        excerpt: 'looks good',
        issueUrl: 'https://app.motir.co/items/MOTIR-1',
      },
      workspaceId,
      idempotencyKey: `watch_${randomToken()}`,
    };
  }

  function passwordReset() {
    return {
      to: 'locked-out@example.com',
      template: 'password-reset' as const,
      data: { recipientName: 'Locked Out', resetUrl: 'https://app.motir.co/reset-password/tok' },
      workspaceId: null,
      idempotencyKey: `tok_${randomToken()}`,
    };
  }

  it('SKIPS a notification once the budget is spent — nothing reaches the provider', async () => {
    const ws = await makeWorkspace();
    // Spent across TWO notification templates: the budget is shared by the class.
    await seedAccepted(ws, 'watcher-transition-notification', 2);
    await seedAccepted(ws, 'mention-notification', 1);
    const emailService = await loadEmailService();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await emailService.send(watcherComment(ws));

    expect(result).toEqual({ providerMessageId: null, skipped: 'notification_budget_exhausted' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('notification budget'));
    // A skip records no delivery — nothing was accepted.
    expect(await adminDb.emailDelivery.count()).toBe(3);
  });

  it('still ATTEMPTS a password reset against the provider when notifications have spent their budget', async () => {
    const ws = await makeWorkspace();
    await seedAccepted(ws, 'watcher-transition-notification', 3);
    const emailService = await loadEmailService();

    const result = await emailService.send(passwordReset());

    expect(result.skipped).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(String(init.body)).to).toBe('locked-out@example.com');
    expect(await adminDb.emailDelivery.count({ where: { template: 'password-reset' } })).toBe(1);
  });

  it('SENDS a notification while the budget has room, and counts only the last 24 hours', async () => {
    const ws = await makeWorkspace();
    // Two inside the window, and five from YESTERDAY that must not count.
    await seedAccepted(ws, 'watcher-comment-notification', 2);
    await seedAccepted(ws, 'watcher-comment-notification', 5, DAY_MS + 60_000);
    // Essential mail inside the window does not draw on the notification budget.
    await seedAccepted(null, 'password-reset', 4);
    const emailService = await loadEmailService();

    const result = await emailService.send(watcherComment(ws));

    expect(result.skipped).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('`none` disables the budget, and 0 turns notification email off entirely', async () => {
    const ws = await makeWorkspace();
    await seedAccepted(ws, 'watcher-comment-notification', 50);

    process.env['EMAIL_NOTIFICATION_DAILY_BUDGET'] = 'none';
    const unlimited = await loadEmailService();
    expect((await unlimited.send(watcherComment(ws))).skipped).toBeUndefined();

    await adminDb.emailDelivery.deleteMany();
    process.env['EMAIL_NOTIFICATION_DAILY_BUDGET'] = '0';
    const off = await loadEmailService();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await off.send(watcherComment(ws))).skipped).toBe('notification_budget_exhausted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('getNotificationDailyBudget', () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['EMAIL_PROVIDER', 'EMAIL_NOTIFICATION_DAILY_BUDGET']) {
      original[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('defaults to 60 on Resend and to no budget on the dev providers', async () => {
    const { getNotificationDailyBudget, DEFAULT_RESEND_NOTIFICATION_DAILY_BUDGET } =
      await import('@/lib/email');
    delete process.env['EMAIL_NOTIFICATION_DAILY_BUDGET'];
    process.env['EMAIL_PROVIDER'] = 'resend';
    expect(getNotificationDailyBudget()).toBe(DEFAULT_RESEND_NOTIFICATION_DAILY_BUDGET);
    expect(DEFAULT_RESEND_NOTIFICATION_DAILY_BUDGET).toBe(60);
    process.env['EMAIL_PROVIDER'] = 'console';
    expect(getNotificationDailyBudget()).toBeNull();
  });

  it('applies to the resend arm only — ses and the dev providers never read it (MOTIR-10565)', async () => {
    const { getNotificationDailyBudget } = await import('@/lib/email');
    for (const provider of ['ses', 'console', 'file']) {
      process.env['EMAIL_PROVIDER'] = provider;
      process.env['EMAIL_NOTIFICATION_DAILY_BUDGET'] = '25';
      expect(getNotificationDailyBudget()).toBeNull();
      // Not read at all: a value that would fail a Resend boot does not fail this one.
      process.env['EMAIL_NOTIFICATION_DAILY_BUDGET'] = 'sixty';
      expect(getNotificationDailyBudget()).toBeNull();
    }
  });

  it('reads an integer, `none`, and refuses anything else by name', async () => {
    const { getNotificationDailyBudget } = await import('@/lib/email');
    process.env['EMAIL_PROVIDER'] = 'resend';
    process.env['EMAIL_NOTIFICATION_DAILY_BUDGET'] = ' 25 ';
    expect(getNotificationDailyBudget()).toBe(25);
    process.env['EMAIL_NOTIFICATION_DAILY_BUDGET'] = 'NONE';
    expect(getNotificationDailyBudget()).toBeNull();
    for (const bad of ['-1', '2.5', 'sixty', '60/day']) {
      process.env['EMAIL_NOTIFICATION_DAILY_BUDGET'] = bad;
      expect(() => getNotificationDailyBudget()).toThrow(/EMAIL_NOTIFICATION_DAILY_BUDGET/);
    }
  });
});

describe('EMAIL_TEMPLATE_CLASS', () => {
  it('keeps every sign-in and account-recovery template out of the budget', async () => {
    const { EMAIL_TEMPLATE_CLASS, NOTIFICATION_TEMPLATES } =
      await import('@/lib/services/emailService');
    for (const essential of [
      'password-reset',
      'email-change',
      'two-factor-otp',
      'workspace-invite',
    ] as const) {
      expect(EMAIL_TEMPLATE_CLASS[essential]).toBe('essential');
      expect(NOTIFICATION_TEMPLATES).not.toContain(essential);
    }
    // The two templates that spent the quota on 2026-09-14 are budgeted.
    expect(NOTIFICATION_TEMPLATES).toContain('watcher-comment-notification');
    expect(NOTIFICATION_TEMPLATES).toContain('watcher-transition-notification');
  });
});
