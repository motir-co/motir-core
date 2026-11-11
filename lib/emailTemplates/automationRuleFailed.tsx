import { Link, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';
import { EMAIL_LINK } from './_components/emailColors';

// Automation-rule failure notification email (Story 6.6 · Subtask 6.6.2). Sent
// by the `email.send` job when one of the recipient's automation rules fails to
// execute — "Your automation rule '<name>' failed". The engine
// (automationEngineService.recordFailure) composes the props and enqueues it
// ONLY on the first failure after a success (the verified Jira dedupe), so the
// owner isn't spammed by a persistently-broken rule; when that failure also
// crossed the auto-disable threshold, `autoDisabled` adds the "we turned it
// off" line. Pure template per CLAUDE.md: no I/O, no env reads — the engine
// hands it a finished `rulesUrl`. Localized via next-intl's synchronous
// createTranslator; `locale` is the RECIPIENT's language, resolved by the
// sender (lib/services/emailRecipientLocale.ts); absent ⇒ English.

// A minimal translator shape (satisfied by createTranslator's result).
type T = (key: string, values?: Record<string, string | number>) => string;

export interface AutomationRuleFailedEmailProps {
  recipientName: string;
  ruleName: string;
  /** The short cause string the engine recorded on the execution row. */
  errorDetail: string;
  /** True when this failure crossed the consecutive-failure threshold and the
   * engine auto-disabled the rule (the extra "we turned it off" line). */
  autoDisabled: boolean;
  /** The fully-built deep link to the project's Automation settings. */
  rulesUrl: string;
  locale?: Locale;
}

function AutomationRuleFailedEmail(p: AutomationRuleFailedEmailProps & { t: T }) {
  const { t } = p;
  return (
    <EmailLayout locale={p.locale} preview={t('preview', { rule: p.ruleName })}>
      <Text style={greeting}>{t('greeting', { name: p.recipientName })}</Text>
      <Text style={lede}>{t('lede', { rule: p.ruleName })}</Text>
      <Text style={errorRow}>{t('errorLabel', { detail: p.errorDetail })}</Text>
      {p.autoDisabled ? <Text style={disabledRow}>{t('autoDisabled')}</Text> : null}
      <Section style={cta}>
        <PrimaryButton href={p.rulesUrl} label={t('view')} />
      </Section>
      <Text style={fallbackLabel}>{t('fallback')}</Text>
      <Text style={fallbackLinkRow}>
        <Link href={p.rulesUrl} style={fallbackLink}>
          {p.rulesUrl}
        </Link>
      </Text>
      <Text style={reason}>{t('reason')}</Text>
    </EmailLayout>
  );
}

const greeting = { fontSize: '16px', margin: '0 0 16px' };
const lede = { fontSize: '16px', margin: '0 0 16px' };
const errorRow = { color: '#b91c1c', fontSize: '14px', margin: '0 0 8px' };
const disabledRow = { color: '#92400e', fontSize: '14px', margin: '0 0 16px' };
const cta = { margin: '0 0 24px' };
const fallbackLabel = { color: '#6b7280', fontSize: '14px', margin: '0 0 8px' };
const fallbackLinkRow = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '13px',
  margin: '0 0 24px',
};
const fallbackLink = { color: EMAIL_LINK, wordBreak: 'break-all' as const };
const reason = { color: '#6b7280', fontSize: '12px', margin: '0 0 24px' };

export async function automationRuleFailedEmail(
  props: AutomationRuleFailedEmailProps,
): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.automationRuleFailed',
  }) as T;
  const html = await render(<AutomationRuleFailedEmail {...props} t={t} />);
  return {
    subject: t('subject', { rule: props.ruleName }),
    text: buildPlainText(props, t),
    html,
  };
}

function buildPlainText(p: AutomationRuleFailedEmailProps, t: T): string {
  return [
    t('greeting', { name: p.recipientName }),
    '',
    t('lede', { rule: p.ruleName }),
    t('errorLabel', { detail: p.errorDetail }),
    ...(p.autoDisabled ? ['', t('autoDisabled')] : []),
    '',
    // Hand-written plain text with the link UNREDACTED (the 1.1.6 dev-console
    // grep contract — never auto-derived `label (url)` form).
    `${t('view')}: ${p.rulesUrl}`,
    '',
    t('reason'),
    '',
    '— Motir',
  ].join('\n');
}

export default AutomationRuleFailedEmail;
