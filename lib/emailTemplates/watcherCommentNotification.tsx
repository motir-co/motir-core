import { Link, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';
import { EMAIL_LINK } from './_components/emailColors';

// Watcher comment notification email (Story 5.4 · Subtask 5.4.5). Sent by the
// `email.send` job when someone comments on an issue the recipient WATCHES —
// "<Author> commented on PROD-N". The watcherNotify fan-out
// (lib/services/watcherNotificationsService.ts) composes the props; a watcher
// who was also @mentioned in the comment gets the MENTION email instead of
// this one (the cross-job dedupe rule — one email per person per event).
// Pure template per CLAUDE.md: no I/O, no env reads — `issueUrl` arrives
// fully built, `excerpt` is already plain text (mention tokens rendered as
// @Name via lib/mentions/excerpt.ts). Localized via next-intl's synchronous
// createTranslator (rendering runs off-request, in the email.send job);
// `locale` defaults to the base locale — there is no persisted per-user
// locale yet (the mentionNotification signal gap).

// A minimal translator shape (satisfied by createTranslator's result).
type T = (key: string, values?: Record<string, string | number>) => string;

export interface WatcherCommentNotificationEmailProps {
  recipientName: string;
  authorName: string;
  /** The work item's system identifier, e.g. "PROD-42". */
  workItemIdentifier: string;
  workItemTitle: string;
  /** Plain-text excerpt of the comment; null hides the quote block. */
  excerpt: string | null;
  /** The fully-built deep link to the work item. */
  issueUrl: string;
  locale?: Locale;
}

function WatcherCommentNotificationEmail(p: WatcherCommentNotificationEmailProps & { t: T }) {
  const { t } = p;
  return (
    <EmailLayout
      locale={p.locale}
      preview={t('preview', { author: p.authorName, identifier: p.workItemIdentifier })}
    >
      <Text style={greeting}>{t('greeting', { name: p.recipientName })}</Text>
      <Text style={lede}>
        {t('lede', {
          author: p.authorName,
          identifier: p.workItemIdentifier,
          title: p.workItemTitle,
        })}
      </Text>
      {p.excerpt ? <Text style={quote}>{p.excerpt}</Text> : null}
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
const quote = {
  borderLeft: '3px solid #e5e7eb',
  color: '#4b5563',
  fontSize: '14px',
  margin: '0 0 24px',
  padding: '4px 0 4px 12px',
};
const cta = { margin: '0 0 24px' };
const fallbackLabel = { color: '#6b7280', fontSize: '14px', margin: '0 0 8px' };
const fallbackLinkRow = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '13px',
  margin: '0 0 24px',
};
const fallbackLink = { color: EMAIL_LINK, wordBreak: 'break-all' as const };
const reason = { color: '#6b7280', fontSize: '12px', margin: '0 0 24px' };

export async function watcherCommentNotificationEmail(
  props: WatcherCommentNotificationEmailProps,
): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.watcherCommentNotification',
  }) as T;
  const html = await render(<WatcherCommentNotificationEmail {...props} t={t} />);
  return {
    subject: t('subject', {
      author: props.authorName,
      identifier: props.workItemIdentifier,
      title: props.workItemTitle,
    }),
    text: buildPlainText(props, t),
    html,
  };
}

function buildPlainText(p: WatcherCommentNotificationEmailProps, t: T): string {
  return [
    t('greeting', { name: p.recipientName }),
    '',
    t('lede', { author: p.authorName, identifier: p.workItemIdentifier, title: p.workItemTitle }),
    ...(p.excerpt ? ['', p.excerpt] : []),
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

export default WatcherCommentNotificationEmail;
