import { agentsDeletionScheduledEmail } from '@/lib/emailTemplates/agentsDeletionScheduled';
import { automationRuleFailedEmail } from '@/lib/emailTemplates/automationRuleFailed';
import { dataExportReadyEmail } from '@/lib/emailTemplates/dataExportReady';
import { emailChangeEmail } from '@/lib/emailTemplates/emailChange';
import { filterSubscriptionEmail } from '@/lib/emailTemplates/filterSubscription';
import { followConfirmEmail } from '@/lib/emailTemplates/followConfirm';
import { followDigestEmail } from '@/lib/emailTemplates/followDigest';
import { mentionNotificationEmail } from '@/lib/emailTemplates/mentionNotification';
import { organizationDeletionCancelledEmail } from '@/lib/emailTemplates/organizationDeletionCancelled';
import { organizationDeletionReminderEmail } from '@/lib/emailTemplates/organizationDeletionReminder';
import { organizationDeletionScheduledEmail } from '@/lib/emailTemplates/organizationDeletionScheduled';
import { organizationErasedEmail } from '@/lib/emailTemplates/organizationErased';
import { ownershipTransferredEmail } from '@/lib/emailTemplates/ownershipTransferred';
import { passwordResetEmail } from '@/lib/emailTemplates/passwordReset';
import { twoFactorOtpEmail } from '@/lib/emailTemplates/twoFactorOtp';
import type { RenderedEmail } from '@/lib/emailTemplates/types';
import type { Locale } from '@/lib/i18n/locales';
import { watcherCommentNotificationEmail } from '@/lib/emailTemplates/watcherCommentNotification';
import { pageCommentNotificationEmail } from '@/lib/emailTemplates/pageCommentNotification';
import { watcherTransitionNotificationEmail } from '@/lib/emailTemplates/watcherTransitionNotification';
import { workspaceInviteEmail } from '@/lib/emailTemplates/workspaceInvite';
import type { EmailTemplate, TransactionalEmail } from '@/lib/services/emailService';

// One minimal, valid set of props per transactional template, and the render
// function for each (Story MOTIR-7732). A `Record` over EVERY template, so a new
// template does not compile here until it has a fixture — which is what keeps a
// "for every template" test honest.

export type TemplateData<K extends EmailTemplate> = Extract<
  TransactionalEmail,
  { template: K }
>['data'];

const URL = 'https://app.example.test';

export const EMAIL_TEMPLATE_FIXTURES: { [K in EmailTemplate]: TemplateData<K> } = {
  'password-reset': { recipientName: 'Sam', resetUrl: `${URL}/reset-password?token=abc` },
  'email-change': {
    recipientName: 'Sam',
    newEmail: 'sam.new@example.com',
    confirmUrl: `${URL}/confirm-email?token=abc`,
  },
  'two-factor-otp': { recipientName: 'Sam', code: '123456', expiresInMinutes: 5 },
  'workspace-invite': {
    inviterName: 'Alex',
    workspaceName: 'Acme',
    acceptUrl: `${URL}/invite/abc`,
  },
  'data-export-ready': {
    recipientName: 'Sam',
    paneUrl: `${URL}/settings/account/data`,
    retentionDays: 7,
  },
  'follow-confirm': { projectName: 'Rocket', confirmUrl: `${URL}/follow/confirm?token=abc` },
  'follow-digest': {
    projectName: 'Rocket',
    changelogUrl: `${URL}/p/rocket/changelog`,
    unsubscribeUrl: `${URL}/follow/unsubscribe?token=abc`,
    entries: [{ identifier: 'ROC-1', title: 'Launch pad', url: `${URL}/p/rocket/ROC-1` }],
  },
  'mention-notification': {
    recipientName: 'Sam',
    authorName: 'Alex',
    workItemIdentifier: 'PROD-42',
    workItemTitle: 'Fix the login',
    source: 'comment',
    excerpt: 'Can you look at this?',
    issueUrl: `${URL}/items/PROD-42`,
  },
  'watcher-comment-notification': {
    recipientName: 'Sam',
    authorName: 'Alex',
    workItemIdentifier: 'PROD-42',
    workItemTitle: 'Fix the login',
    excerpt: 'Done on my side.',
    issueUrl: `${URL}/items/PROD-42`,
  },
  'page-comment-notification': {
    recipientName: 'Sam',
    authorName: 'Alex',
    pageTitle: 'Release checklist',
    variant: 'reply',
    excerpt: 'Done on my side.',
    threadUrl: `${URL}/pages/page-1?thread=comment-1`,
  },
  'watcher-transition-notification': {
    recipientName: 'Sam',
    actorName: 'Alex',
    workItemIdentifier: 'PROD-42',
    workItemTitle: 'Fix the login',
    statusName: 'Done',
    issueUrl: `${URL}/items/PROD-42`,
  },
  'filter-subscription': {
    recipientName: 'Sam',
    filterName: 'My bugs',
    projectKey: 'PROD',
    items: [{ identifier: 'PROD-42', title: 'Fix the login', status: 'To Do' }],
    totalCount: 1,
    resultCap: 50,
    filterUrl: `${URL}/items?filter=v1:abc`,
    unsubscribeUrl: `${URL}/filters/unsubscribe?token=abc`,
  },
  'automation-rule-failed': {
    recipientName: 'Sam',
    ruleName: 'Auto-assign',
    errorDetail: 'Assignee not found',
    autoDisabled: true,
    rulesUrl: `${URL}/settings/project/automation`,
  },
  'ownership-transferred': {
    audience: 'new-owner',
    recipientName: 'Sam',
    organizationName: 'Acme',
    previousOwnerName: 'Alex',
    newOwnerName: 'Sam',
    settingsUrl: `${URL}/settings/organization`,
  },
  'organization-deletion-scheduled': {
    audience: 'owner',
    recipientName: 'Sam',
    organizationName: 'Acme',
    scheduledByName: 'Sam',
    dueDate: '1 November 2026',
    settingsUrl: `${URL}/settings/organization`,
    exportUrl: `${URL}/settings/account/data`,
  },
  'organization-deletion-cancelled': {
    recipientName: 'Sam',
    organizationName: 'Acme',
    cancelledByName: 'Alex',
    appUrl: URL,
  },
  'organization-deletion-reminder': {
    audience: 'owner',
    recipientName: 'Sam',
    organizationName: 'Acme',
    ownerName: 'Sam',
    dueDate: '1 November 2026',
    daysLeft: 3,
    settingsUrl: `${URL}/settings/organization`,
  },
  'organization-erased': {
    recipientName: 'Sam',
    organizationName: 'Acme',
    retentionUntilYear: 2033,
  },
  'agents-deletion-scheduled': {
    recipientName: 'Sam',
    organizationName: 'Acme',
    deletionDate: '1 November 2026',
    agentNames: ['Builder'],
    billingUrl: `${URL}/settings/organization/billing`,
  },
};

export const EMAIL_TEMPLATE_RENDERERS: {
  [K in EmailTemplate]: (props: TemplateData<K>) => Promise<RenderedEmail>;
} = {
  'password-reset': passwordResetEmail,
  'email-change': emailChangeEmail,
  'two-factor-otp': twoFactorOtpEmail,
  'workspace-invite': workspaceInviteEmail,
  'data-export-ready': dataExportReadyEmail,
  'follow-confirm': followConfirmEmail,
  'follow-digest': followDigestEmail,
  'mention-notification': mentionNotificationEmail,
  'watcher-comment-notification': watcherCommentNotificationEmail,
  'page-comment-notification': pageCommentNotificationEmail,
  'watcher-transition-notification': watcherTransitionNotificationEmail,
  'filter-subscription': filterSubscriptionEmail,
  'automation-rule-failed': automationRuleFailedEmail,
  'ownership-transferred': ownershipTransferredEmail,
  'organization-deletion-scheduled': organizationDeletionScheduledEmail,
  'organization-deletion-cancelled': organizationDeletionCancelledEmail,
  'organization-deletion-reminder': organizationDeletionReminderEmail,
  'organization-erased': organizationErasedEmail,
  'agents-deletion-scheduled': agentsDeletionScheduledEmail,
};

/** Render one template from its fixture, in `locale` when one is given. */
export function renderFixture(
  template: EmailTemplate,
  extra: { locale?: Locale } = {},
): Promise<RenderedEmail> {
  // The two records are keyed alike, so the pairing is sound; TypeScript cannot
  // correlate a generic key across them, hence the widening.
  const render = EMAIL_TEMPLATE_RENDERERS[template] as (p: object) => Promise<RenderedEmail>;
  return render({ ...EMAIL_TEMPLATE_FIXTURES[template], ...extra });
}
