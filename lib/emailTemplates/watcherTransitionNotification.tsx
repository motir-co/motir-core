import { Link, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';
import { EMAIL_LINK } from './_components/emailColors';

// Watcher status-transition notification email (Story 5.4 · Subtask 5.4.5).
// Sent by the `email.send` job when an issue the recipient WATCHES moves to a
// new status — "<Actor> moved PROD-N to <Status>". The watcherNotify fan-out
// (lib/services/watcherNotificationsService.ts) composes the props off the
// `work-item/transitioned` event; `statusName` arrives resolved (the status's
// display name, or its key when the status was deleted between write and
// send). Pure template per CLAUDE.md: no I/O, no env reads. Localized via
// next-intl's synchronous createTranslator; `locale` is the RECIPIENT's
// language, resolved by the sender (lib/services/emailRecipientLocale.ts);
// absent ⇒ English.

// A minimal translator shape (satisfied by createTranslator's result).
type T = (key: string, values?: Record<string, string | number>) => string;

export interface WatcherTransitionNotificationEmailProps {
  recipientName: string;
  actorName: string;
  /** The work item's system identifier, e.g. "PROD-42". */
  workItemIdentifier: string;
  workItemTitle: string;
  /** The target status's display name (falls back to its key when deleted). */
  statusName: string;
  /** The fully-built deep link to the work item. */
  issueUrl: string;
  locale?: Locale;
}

function WatcherTransitionNotificationEmail(p: WatcherTransitionNotificationEmailProps & { t: T }) {
  const { t } = p;
  return (
    <EmailLayout
      locale={p.locale}
      preview={t('preview', {
        actor: p.actorName,
        identifier: p.workItemIdentifier,
        status: p.statusName,
      })}
    >
      <Text style={greeting}>{t('greeting', { name: p.recipientName })}</Text>
      <Text style={lede}>
        {t('lede', {
          actor: p.actorName,
          identifier: p.workItemIdentifier,
          title: p.workItemTitle,
          status: p.statusName,
        })}
      </Text>
      <Section style={cta}>
        <PrimaryButton href={p.issueUrl} label={t('view')} />
      </Section>
      <Text style={fallbackLabel}>{t('fallback')}</Text>
      <Text style={fallbackLinkRow}>
        <Link href={p.issueUrl} style={fallbackLink}>
          {p.issueUrl}
        </Link>
      </Text>
      <Text style={reason}>{t('reason', { identifier: p.workItemIdentifier })}</Text>
    </EmailLayout>
  );
}

const greeting = { fontSize: '16px', margin: '0 0 16px' };
const lede = { fontSize: '16px', margin: '0 0 16px' };
const cta = { margin: '0 0 24px' };
const fallbackLabel = { color: '#6b7280', fontSize: '14px', margin: '0 0 8px' };
const fallbackLinkRow = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '13px',
  margin: '0 0 24px',
};
const fallbackLink = { color: EMAIL_LINK, wordBreak: 'break-all' as const };
const reason = { color: '#6b7280', fontSize: '12px', margin: '0 0 24px' };

export async function watcherTransitionNotificationEmail(
  props: WatcherTransitionNotificationEmailProps,
): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.watcherTransitionNotification',
  }) as T;
  const html = await render(<WatcherTransitionNotificationEmail {...props} t={t} />);
  return {
    subject: t('subject', {
      actor: props.actorName,
      identifier: props.workItemIdentifier,
      status: props.statusName,
    }),
    text: buildPlainText(props, t),
    html,
  };
}

function buildPlainText(p: WatcherTransitionNotificationEmailProps, t: T): string {
  return [
    t('greeting', { name: p.recipientName }),
    '',
    t('lede', {
      actor: p.actorName,
      identifier: p.workItemIdentifier,
      title: p.workItemTitle,
      status: p.statusName,
    }),
    '',
    // Hand-written plain text with the link UNREDACTED (the 1.1.6 dev-console
    // grep contract — never auto-derived `label (url)` form).
    `${t('view')}: ${p.issueUrl}`,
    '',
    t('reason', { identifier: p.workItemIdentifier }),
    '',
    '— Motir',
  ].join('\n');
}

export default WatcherTransitionNotificationEmail;
