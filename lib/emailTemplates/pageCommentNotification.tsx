import { Link, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';
import { EMAIL_LINK } from './_components/emailColors';

// Page-comment notification email (Story MOTIR-10868 · MOTIR-10925), drawn in
// `design/notifications/page-comment-email.mock.html`. ONE template, two variants:
// a MENTION in a page comment, and a REPLY in a thread the reader started or
// replied in. The parts are the shipped comment emails', in their order —
// greeting, lede, the quote when there is an excerpt, the button, the fallback
// link — and the reply adds its reason line after the fallback. The page-comment
// fan-out (`lib/services/pageCommentEmailService.ts`) composes the props.
//
// Pure template: no I/O, no env reads. `threadUrl` arrives fully built; the
// excerpt is already plain text; `locale` is the RECIPIENT's language. An empty
// page title renders the pages surface's own `pages.untitled` word, in that same
// language — applied HERE, at render, because one stored title serves readers in
// several languages.

// A minimal translator shape (satisfied by createTranslator's result).
type T = (key: string, values?: Record<string, string | number>) => string;

export interface PageCommentNotificationEmailProps {
  recipientName: string;
  authorName: string;
  /** The page's title as stored — `''` for an untitled page. */
  pageTitle: string;
  /** Picks the subject, the preview, the lede and whether the reason line shows. */
  variant: 'mention' | 'reply';
  /** Plain-text excerpt of the comment; null hides the quote block. */
  excerpt: string | null;
  /** The fully-built link to the page with the discussion open at the thread. */
  threadUrl: string;
  locale?: Locale;
}

interface Copy {
  t: T;
  page: string;
}

function PageCommentNotificationEmail(p: PageCommentNotificationEmailProps & Copy) {
  const { t } = p;
  const values = { author: p.authorName, page: p.page };
  const mention = p.variant === 'mention';
  return (
    <EmailLayout locale={p.locale} preview={t(mention ? 'previewMention' : 'previewReply', values)}>
      <Text style={greeting}>{t('greeting', { name: p.recipientName })}</Text>
      <Text style={lede}>{t(mention ? 'ledeMention' : 'ledeReply', values)}</Text>
      {p.excerpt ? <Text style={quote}>{p.excerpt}</Text> : null}
      <Section style={cta}>
        <PrimaryButton href={p.threadUrl} label={t('view')} />
      </Section>
      <Text style={fallbackLabel}>{t('fallback')}</Text>
      <Text style={fallbackLinkRow}>
        <Link href={p.threadUrl} style={fallbackLink}>
          {p.threadUrl}
        </Link>
      </Text>
      {mention ? null : <Text style={reason}>{t('reasonReply')}</Text>}
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
// The fallback label's grey (4.83:1 on the white body), NOT the #9ca3af the
// work-item reason lines use, which is 2.54:1 and fails AA (bug MOTIR-10964).
const reason = { color: '#6b7280', fontSize: '12px', margin: '0 0 24px' };

/** The translator and the page's display name, in the recipient's language. */
function copyFor(props: PageCommentNotificationEmailProps): Copy {
  const locale = props.locale ?? defaultLocale;
  const messages = getMessagesFor(locale);
  const t = createTranslator({
    locale,
    messages,
    namespace: 'email.pageCommentNotification',
  }) as T;
  const pages = createTranslator({ locale, messages, namespace: 'pages' }) as T;
  return { t, page: props.pageTitle || pages('untitled') };
}

export async function pageCommentNotificationEmail(
  props: PageCommentNotificationEmailProps,
): Promise<RenderedEmail> {
  const copy = copyFor(props);
  const html = await render(<PageCommentNotificationEmail {...props} {...copy} />);
  const subjectKey = props.variant === 'mention' ? 'subjectMention' : 'subjectReply';
  return {
    subject: copy.t(subjectKey, { author: props.authorName, page: copy.page }),
    text: buildPlainText(props, copy),
    html,
  };
}

function buildPlainText(p: PageCommentNotificationEmailProps, { t, page }: Copy): string {
  const mention = p.variant === 'mention';
  return [
    t('greeting', { name: p.recipientName }),
    '',
    t(mention ? 'ledeMention' : 'ledeReply', { author: p.authorName, page }),
    ...(p.excerpt ? ['', p.excerpt] : []),
    '',
    // Hand-written plain text with the link UNREDACTED (the 1.1.6 dev-console
    // grep contract — never auto-derived `label (url)` form).
    `${t('view')}: ${p.threadUrl}`,
    ...(mention ? [] : ['', t('reasonReply')]),
    '',
    '— Motir',
  ].join('\n');
}

export default PageCommentNotificationEmail;
