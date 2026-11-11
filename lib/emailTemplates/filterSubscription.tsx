import { Hr, Link, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';
import { EMAIL_LINK } from './_components/emailColors';

// Filter-subscription results email (Story 6.2 · Subtask 6.2.5). Sent by the
// `email.send` job when a saved-filter subscription is DUE: the filter name,
// the first 50 matching work items (identifier · title · status), the TRUE
// total count, a deep link to the applied `?filter=v1:` URL, and a
// token-authenticated unsubscribe link. A REPORT, not an alert — it sends even
// when nothing matches (the verified Jira subscription behaviour), so the body
// has a zero-results branch. Pure template per CLAUDE.md (no I/O, no env): the
// savedFilterSubscriptionsService.deliver fan-out composes every prop (it
// already built both URLs + resolved the rows AS the subscriber). Localized via
// next-intl's synchronous createTranslator; `locale` is the RECIPIENT's
// language, resolved by the sender (lib/services/emailRecipientLocale.ts);
// absent ⇒ English.

type T = (key: string, values?: Record<string, string | number>) => string;

/** One result row the email lists (the bounded 50, mapped by the service). */
export interface FilterSubscriptionResultItem {
  identifier: string;
  title: string;
  /** The work item's status DISPLAY label (the service resolved key → label). */
  status: string;
}

export interface FilterSubscriptionEmailProps {
  recipientName: string;
  filterName: string;
  /** The project key (e.g. "PROD") — context in the lede. */
  projectKey: string;
  /** Up to `resultCap` rows (the first page); empty for a zero-result run. */
  items: FilterSubscriptionResultItem[];
  /** The TRUE total across the whole filtered set (may exceed `items.length`). */
  totalCount: number;
  /** The per-email row cap (50) — drives the "showing first N of M" line. */
  resultCap: number;
  /** Deep link to the applied filter on /items (the `?filter=v1:` URL). */
  filterUrl: string;
  /** Token-authenticated one-click unsubscribe link. */
  unsubscribeUrl: string;
  locale?: Locale;
}

function FilterSubscriptionEmail(p: FilterSubscriptionEmailProps & { t: T }) {
  const { t } = p;
  const truncated = p.totalCount > p.items.length;
  return (
    <EmailLayout
      locale={p.locale}
      preview={t('preview', { filter: p.filterName, count: p.totalCount })}
    >
      <Text style={greeting}>{t('greeting', { name: p.recipientName })}</Text>
      <Text style={lede}>
        {p.totalCount === 0
          ? t('ledeEmpty', { filter: p.filterName, project: p.projectKey })
          : t('lede', { filter: p.filterName, project: p.projectKey, count: p.totalCount })}
      </Text>

      {p.items.length > 0 ? (
        <Section style={list}>
          {p.items.map((item) => (
            <Text key={item.identifier} style={row}>
              <span style={ident}>{item.identifier}</span>
              {'  '}
              {item.title}
              {'  '}
              <span style={statusChip}>{item.status}</span>
            </Text>
          ))}
        </Section>
      ) : null}

      {truncated ? (
        <Text style={moreNote}>
          {t('truncated', { shown: p.items.length, total: p.totalCount })}
        </Text>
      ) : null}

      <Section style={cta}>
        <PrimaryButton href={p.filterUrl} label={t('view')} />
      </Section>
      <Text style={fallbackLabel}>{t('fallback')}</Text>
      <Text style={fallbackLinkRow}>
        <Link href={p.filterUrl} style={fallbackLink}>
          {p.filterUrl}
        </Link>
      </Text>

      <Hr style={hr} />
      <Text style={reason}>{t('reason', { filter: p.filterName })}</Text>
      <Text style={unsubscribeRow}>
        <Link href={p.unsubscribeUrl} style={unsubscribeLink}>
          {t('unsubscribe')}
        </Link>
      </Text>
    </EmailLayout>
  );
}

const greeting = { fontSize: '16px', margin: '0 0 16px' };
const lede = { fontSize: '16px', margin: '0 0 16px' };
const list = { margin: '0 0 16px' };
const row = { fontSize: '14px', margin: '0 0 8px', lineHeight: '1.4' };
const ident = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '13px',
  fontWeight: 600,
};
const statusChip = { color: '#6b7280', fontSize: '13px' };
const moreNote = { color: '#6b7280', fontSize: '13px', margin: '0 0 16px' };
const cta = { margin: '8px 0 24px' };
const fallbackLabel = { color: '#6b7280', fontSize: '14px', margin: '0 0 8px' };
const fallbackLinkRow = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '13px',
  margin: '0 0 24px',
};
const fallbackLink = { color: EMAIL_LINK, wordBreak: 'break-all' as const };
const hr = { borderColor: '#e5e7eb', margin: '8px 0 16px' };
const reason = { color: '#6b7280', fontSize: '12px', margin: '0 0 8px' };
const unsubscribeRow = { fontSize: '12px', margin: '0 0 8px' };
const unsubscribeLink = { color: '#6b7280', textDecoration: 'underline' };

export async function filterSubscriptionEmail(
  props: FilterSubscriptionEmailProps,
): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.filterSubscription',
  }) as T;
  const html = await render(<FilterSubscriptionEmail {...props} t={t} />);
  return {
    subject: t('subject', { filter: props.filterName, count: props.totalCount }),
    text: buildPlainText(props, t),
    html,
  };
}

function buildPlainText(p: FilterSubscriptionEmailProps, t: T): string {
  const lines: string[] = [
    t('greeting', { name: p.recipientName }),
    '',
    p.totalCount === 0
      ? t('ledeEmpty', { filter: p.filterName, project: p.projectKey })
      : t('lede', { filter: p.filterName, project: p.projectKey, count: p.totalCount }),
    '',
  ];
  for (const item of p.items) {
    lines.push(`${item.identifier}  ${item.title}  (${item.status})`);
  }
  if (p.items.length > 0) lines.push('');
  if (p.totalCount > p.items.length) {
    lines.push(t('truncated', { shown: p.items.length, total: p.totalCount }), '');
  }
  lines.push(
    // Link UNREDACTED (the 1.1.6 dev-console grep contract — never `label (url)`).
    `${t('view')}: ${p.filterUrl}`,
    '',
    t('reason', { filter: p.filterName }),
    `${t('unsubscribe')}: ${p.unsubscribeUrl}`,
    '',
    '— Motir',
  );
  return lines.join('\n');
}

export default FilterSubscriptionEmail;
