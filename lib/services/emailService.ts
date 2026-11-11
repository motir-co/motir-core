import {
  emailProviderName,
  getNotificationDailyBudget,
  sendEmail,
  type EmailSendResult,
} from '@/lib/email';
import type { Locale } from '@/lib/i18n/locales';
import { emailDeliveryService } from '@/lib/services/emailDeliveryService';
import { emailSuppressionService } from '@/lib/services/emailSuppressionService';
import {
  passwordResetEmail,
  type PasswordResetEmailProps,
} from '@/lib/emailTemplates/passwordReset';
import {
  followConfirmEmail,
  type FollowConfirmEmailProps,
} from '@/lib/emailTemplates/followConfirm';
import { followDigestEmail, type FollowDigestEmailProps } from '@/lib/emailTemplates/followDigest';
import { emailChangeEmail, type EmailChangeEmailProps } from '@/lib/emailTemplates/emailChange';
import {
  dataExportReadyEmail,
  type DataExportReadyEmailProps,
} from '@/lib/emailTemplates/dataExportReady';
import {
  workspaceInviteEmail,
  type WorkspaceInviteEmailProps,
} from '@/lib/emailTemplates/workspaceInvite';
import {
  mentionNotificationEmail,
  type MentionNotificationEmailProps,
} from '@/lib/emailTemplates/mentionNotification';
import {
  watcherCommentNotificationEmail,
  type WatcherCommentNotificationEmailProps,
} from '@/lib/emailTemplates/watcherCommentNotification';
import {
  pageCommentNotificationEmail,
  type PageCommentNotificationEmailProps,
} from '@/lib/emailTemplates/pageCommentNotification';
import {
  watcherTransitionNotificationEmail,
  type WatcherTransitionNotificationEmailProps,
} from '@/lib/emailTemplates/watcherTransitionNotification';
import {
  filterSubscriptionEmail,
  type FilterSubscriptionEmailProps,
} from '@/lib/emailTemplates/filterSubscription';
import {
  automationRuleFailedEmail,
  type AutomationRuleFailedEmailProps,
} from '@/lib/emailTemplates/automationRuleFailed';
import { twoFactorOtpEmail, type TwoFactorOtpEmailProps } from '@/lib/emailTemplates/twoFactorOtp';
import {
  ownershipTransferredEmail,
  type OwnershipTransferredEmailProps,
} from '@/lib/emailTemplates/ownershipTransferred';
import {
  organizationDeletionScheduledEmail,
  type OrganizationDeletionScheduledEmailProps,
} from '@/lib/emailTemplates/organizationDeletionScheduled';
import {
  agentsDeletionScheduledEmail,
  type AgentsDeletionScheduledEmailProps,
} from '@/lib/emailTemplates/agentsDeletionScheduled';
import {
  organizationDeletionCancelledEmail,
  type OrganizationDeletionCancelledEmailProps,
} from '@/lib/emailTemplates/organizationDeletionCancelled';
import {
  organizationDeletionReminderEmail,
  type OrganizationDeletionReminderEmailProps,
} from '@/lib/emailTemplates/organizationDeletionReminder';
import {
  organizationErasedEmail,
  type OrganizationErasedEmailProps,
} from '@/lib/emailTemplates/organizationErased';

// The execution-side email service (Story 1.6 · Subtask 1.6.3). This is the
// ONE place a transactional email is rendered and handed to the provider:
// it picks the template by the `template` discriminant, renders it, and
// dispatches via `sendEmail`. Per motir-core/CLAUDE.md ("Email templates
// live in lib/emailTemplates/, NOT in service code" + "lib/email.ts ... ONLY
// services import this"), composition + dispatch belong to a service and the
// template stays a pure render function.
//
// WHO CALLS THIS: only the `email.send` background job
// (lib/jobs/definitions/emailSend.ts), via the injected jobServices bag. The
// request-lifecycle callers (password-reset in lib/auth, invites in
// workspaceInvitesService) NO LONGER render or dispatch inline — they enqueue
// an `email.send` event with sendEvent(). So the slow/flaky provider call
// runs in the durable job (with retries), not in the user-facing request.
// An ESLint no-restricted-imports rule pins `@/lib/email` to this file so a
// future caller can't regress to a synchronous send.

/**
 * The language an email is written in: the RECIPIENT's, one of the eleven
 * (MOTIR-8104). Every template's props carry it as `locale`, so it rides on the
 * `email.send` payload's `data` and a retried send renders in the language the
 * first attempt did. Resolve it with `lib/services/emailRecipientLocale.ts`.
 */
export type EmailLocale = Locale;

/**
 * A transactional email to render + dispatch. Discriminated by `template`;
 * each arm's `data` is exactly the matching template's props, so adding a
 * template is: add a template file, add an arm here, add a `case` in `send`.
 */
export type TransactionalEmail =
  | { to: string; template: 'password-reset'; data: PasswordResetEmailProps }
  | { to: string; template: 'email-change'; data: EmailChangeEmailProps }
  | { to: string; template: 'data-export-ready'; data: DataExportReadyEmailProps }
  | { to: string; template: 'workspace-invite'; data: WorkspaceInviteEmailProps }
  | { to: string; template: 'mention-notification'; data: MentionNotificationEmailProps }
  | {
      to: string;
      template: 'watcher-comment-notification';
      data: WatcherCommentNotificationEmailProps;
    }
  | {
      to: string;
      template: 'page-comment-notification';
      data: PageCommentNotificationEmailProps;
    }
  | {
      to: string;
      template: 'watcher-transition-notification';
      data: WatcherTransitionNotificationEmailProps;
    }
  | { to: string; template: 'filter-subscription'; data: FilterSubscriptionEmailProps }
  | {
      to: string;
      template: 'automation-rule-failed';
      data: AutomationRuleFailedEmailProps;
    }
  | { to: string; template: 'two-factor-otp'; data: TwoFactorOtpEmailProps }
  | { to: string; template: 'follow-confirm'; data: FollowConfirmEmailProps }
  | { to: string; template: 'follow-digest'; data: FollowDigestEmailProps }
  | { to: string; template: 'ownership-transferred'; data: OwnershipTransferredEmailProps }
  | {
      to: string;
      template: 'organization-deletion-scheduled';
      data: OrganizationDeletionScheduledEmailProps;
    }
  | {
      to: string;
      template: 'organization-deletion-cancelled';
      data: OrganizationDeletionCancelledEmailProps;
    }
  | {
      to: string;
      template: 'organization-deletion-reminder';
      data: OrganizationDeletionReminderEmailProps;
    }
  | { to: string; template: 'organization-erased'; data: OrganizationErasedEmailProps }
  | {
      to: string;
      template: 'agents-deletion-scheduled';
      data: AgentsDeletionScheduledEmailProps;
    };

/** Every template discriminant — handy for exhaustiveness + tests. */
export type EmailTemplate = TransactionalEmail['template'];

/**
 * A `TransactionalEmail` plus the background-job envelope the `email.send` job
 * already carries. Every field beyond the email itself is OPTIONAL, because
 * the email domain knows nothing about job envelopes and a direct caller need
 * supply none of them — they are what the delivery record (MOTIR-3513) is
 * correlated by, not what the send needs to work.
 *
 * `runId` / `eventId` are the ACTIVE lane's own identifiers — a `job_queue.id`
 * cuid on the Postgres engine, Inngest's ids on the Inngest lane. They are
 * recorded as given rather than normalised; the discriminator is the id's
 * shape, which is what the two ledgers already record.
 */
export type SendableEmail = TransactionalEmail & {
  idempotencyKey?: string;
  workspaceId?: string | null;
  runId?: string | null;
  eventId?: string | null;
};

/**
 * Which share of the provider's quota a template draws on (MOTIR-5873).
 *
 * `essential` — mail a person is WAITING on, usually to get back into their
 * account or to act on something they just asked for: a password reset, an
 * email change, a sign-in code, an invite, a follow confirmation, their own
 * data export. Never budgeted: it may use the whole quota.
 *
 * `notification` — mail Motir sends ABOUT activity (watchers, mentions,
 * subscriptions, digests, a failed automation). Each is also visible in the
 * app, and a burst of them is what spent the quota on 2026-09-14. Budgeted,
 * so a burst stops short of the quota and leaves the essential mail its room.
 *
 * A `Record` over EVERY template, so a new template does not compile until
 * somebody has decided which kind it is — the decision that was never made
 * for the ten templates before this one.
 */
export type EmailTemplateClass = 'essential' | 'notification';

export const EMAIL_TEMPLATE_CLASS: Record<EmailTemplate, EmailTemplateClass> = {
  'password-reset': 'essential',
  'email-change': 'essential',
  'two-factor-otp': 'essential',
  'workspace-invite': 'essential',
  'follow-confirm': 'essential',
  'data-export-ready': 'essential',
  // Who controls an organization changed — a security-relevant fact about the
  // reader's own account, never budgeted away (MOTIR-6310).
  'ownership-transferred': 'essential',
  // Organization deletion (MOTIR-6395): a person loses their work if they miss one
  // of these, and none of them is visible anywhere else once the org is gone.
  'organization-deletion-scheduled': 'essential',
  'organization-deletion-cancelled': 'essential',
  'organization-deletion-reminder': 'essential',
  'organization-erased': 'essential',
  // An org's AI plan ended (MOTIR-6921): the reader loses their agents' homes on
  // the date unless the plan is renewed — never budgeted away.
  'agents-deletion-scheduled': 'essential',
  'mention-notification': 'notification',
  'watcher-comment-notification': 'notification',
  // A page comment's mention or reply (MOTIR-10925) — counted by the rolling budget.
  'page-comment-notification': 'notification',
  'watcher-transition-notification': 'notification',
  'filter-subscription': 'notification',
  'automation-rule-failed': 'notification',
  'follow-digest': 'notification',
};

export const NOTIFICATION_TEMPLATES: readonly EmailTemplate[] = (
  Object.keys(EMAIL_TEMPLATE_CLASS) as EmailTemplate[]
).filter((t) => EMAIL_TEMPLATE_CLASS[t] === 'notification');

/** The budget's window: ROLLING, so it holds whichever clock the provider resets on. */
export const NOTIFICATION_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * What a send reports. `skipped` is set — and nothing reached the provider —
 * when the recipient is on the suppression list (`recipient_suppressed`,
 * MOTIR-10565) or a notification was held back by the budget
 * (`notification_budget_exhausted`). Both are deliberate policy outcomes, not
 * failures, so the job SUCCEEDS with them on its output rather than
 * dead-lettering: a dead letter asks an operator to act, and a retry of a send
 * to an address that bounced permanently would only bounce again.
 */
export type EmailServiceSendResult = EmailSendResult & {
  skipped?: 'recipient_suppressed' | 'notification_budget_exhausted';
};

/**
 * True when this send is a notification and the rolling-24h budget is spent.
 *
 * ⚠️ A COUNT-THEN-SEND, deliberately unlocked. The send is an HTTP call that
 * cannot sit inside a row lock, so concurrent workers can each read the same
 * count and overshoot the budget by at most the number of sends in flight
 * (the worker pool, `POOL_SIZE` = 10). That is what the headroom is for: the
 * default budget is 60 against a 100/day quota, so an overshoot of ten still
 * leaves thirty for essential mail. A budget set within `POOL_SIZE` of the
 * quota would not have that margin.
 */
async function notificationBudgetExhausted(template: EmailTemplate): Promise<boolean> {
  if (EMAIL_TEMPLATE_CLASS[template] !== 'notification') return false;
  const budget = getNotificationDailyBudget();
  if (budget === null) return false;
  if (budget === 0) return true;
  const used = await emailDeliveryService.countAcceptedWithin({
    provider: emailProviderName(),
    templates: NOTIFICATION_TEMPLATES,
    windowMs: NOTIFICATION_BUDGET_WINDOW_MS,
  });
  return used >= budget;
}

export const emailService = {
  /**
   * Render the chosen template and dispatch it. Throws whatever the provider
   * throws (the job wrapper turns that into a retried run, then a DLQ entry in
   * 1.6.4) — this method does not swallow failures, so a down provider is
   * visible to the runtime rather than silently dropped.
   *
   * `idempotencyKey` is the envelope field the `email.send` event already
   * carries (`EmailSendData`), threaded to the provider so a job RETRY of an
   * accepted send is deduped AT THE PROVIDER too (MOTIR-1127). It is optional
   * because the parameter's shape is the email domain's `TransactionalEmail`,
   * which knows nothing about background-job envelopes; the job supplies it,
   * a direct caller need not. No caller changed to gain this — the job was
   * already passing the whole `EmailSendData` payload, envelope included.
   */
  async send(message: SendableEmail): Promise<EmailServiceSendResult> {
    // FIRST, under every provider and for every template: an address that
    // bounced permanently or complained is never sent to again (MOTIR-10565).
    // A password reset is not exempt — a reset to an address that does not
    // exist reaches nobody, and each bounce counts against the sending
    // account's reputation. The log line is how an operator finds the skip.
    if (await emailSuppressionService.isSuppressed(message.to)) {
      console.warn(
        `[email] ${message.template} to '${message.to}' skipped: the address is on the ` +
          `suppression list (a permanent bounce or a complaint).`,
      );
      return { providerMessageId: null, skipped: 'recipient_suppressed' };
    }
    // Before rendering: a notification the budget holds back never reaches
    // the provider, so it cannot spend the quota the essential mail needs.
    if (await notificationBudgetExhausted(message.template)) {
      console.warn(
        `[email] ${message.template} to '${message.to}' skipped: the notification ` +
          `budget (EMAIL_NOTIFICATION_DAILY_BUDGET=${getNotificationDailyBudget()} per ` +
          `rolling 24h) is spent, and the rest of the provider quota is kept for ` +
          `password-reset, invite and sign-in mail.`,
      );
      return { providerMessageId: null, skipped: 'notification_budget_exhausted' };
    }
    const rendered = await renderTemplate(message);
    const result = await sendEmail({
      to: message.to,
      // The spread carries `headers` when the template returned any — the
      // follower digest's `List-Unsubscribe` pair is the one shipped case.
      ...rendered,
      idempotencyKey: message.idempotencyKey,
    });
    // AFTER the send returned, and deliberately not inside it: this records
    // something that has already happened. `recordAccepted` swallows its own
    // failures for that reason — see emailDeliveryService's header.
    await emailDeliveryService.recordAccepted({
      providerMessageId: result.providerMessageId,
      provider: emailProviderName(),
      recipient: message.to,
      template: message.template,
      workspaceId: message.workspaceId ?? null,
      idempotencyKey: message.idempotencyKey ?? null,
      runId: message.runId ?? null,
      eventId: message.eventId ?? null,
    });
    return result;
  },
};

async function renderTemplate(message: TransactionalEmail) {
  switch (message.template) {
    case 'password-reset':
      return passwordResetEmail(message.data);
    case 'follow-confirm':
      return followConfirmEmail(message.data);
    case 'follow-digest':
      return followDigestEmail(message.data);
    case 'email-change':
      return emailChangeEmail(message.data);
    case 'data-export-ready':
      return dataExportReadyEmail(message.data);
    case 'workspace-invite':
      return workspaceInviteEmail(message.data);
    case 'mention-notification':
      return mentionNotificationEmail(message.data);
    case 'watcher-comment-notification':
      return watcherCommentNotificationEmail(message.data);
    case 'page-comment-notification':
      return pageCommentNotificationEmail(message.data);
    case 'watcher-transition-notification':
      return watcherTransitionNotificationEmail(message.data);
    case 'filter-subscription':
      return filterSubscriptionEmail(message.data);
    case 'automation-rule-failed':
      return automationRuleFailedEmail(message.data);
    case 'two-factor-otp':
      return twoFactorOtpEmail(message.data);
    case 'ownership-transferred':
      return ownershipTransferredEmail(message.data);
    case 'organization-deletion-scheduled':
      return organizationDeletionScheduledEmail(message.data);
    case 'organization-deletion-cancelled':
      return organizationDeletionCancelledEmail(message.data);
    case 'organization-deletion-reminder':
      return organizationDeletionReminderEmail(message.data);
    case 'organization-erased':
      return organizationErasedEmail(message.data);
    case 'agents-deletion-scheduled':
      return agentsDeletionScheduledEmail(message.data);
    default: {
      // Exhaustiveness guard: a new template arm without a case here is a
      // compile error, not a silent fall-through.
      const _exhaustive: never = message;
      throw new Error(`Unhandled email template: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
