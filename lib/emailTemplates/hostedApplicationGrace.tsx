import { Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { GraceNoticeKind } from '@/lib/hosting/vocabulary';
import type { RenderedEmail } from './types';

// A GRACE-WINDOW NOTICE about a hosted application (Story MOTIR-9800 ·
// MOTIR-12136; decision MOTIR-9802 "Consequences"): to the organisation's
// Owner and Admins — the people who can download the database export or press
// Stop now — when the repository's transfer lands (`transferred`), 7 days and
// 1 day before the app stops (`seven_days`, `one_day`), and at the stop
// (`stopped`). One template; `kind` chooses the subject and the lede. Pure: the
// caller resolves the recipient, the locale and the formatted date.

type T = (key: string, values?: Record<string, string | number>) => string;

export interface HostedApplicationGraceEmailProps {
  kind: GraceNoticeKind;
  recipientName: string;
  /** The repository the application runs — the name its admins know it by. */
  repositoryName: string;
  /** `stopsAt`, already formatted in the recipient's locale. */
  stopDate: string;
  /** The Production panel, selecting this application's repository. */
  productionUrl: string;
  locale?: Locale;
}

function values(p: HostedApplicationGraceEmailProps) {
  return { name: p.recipientName, repository: p.repositoryName, date: p.stopDate, kind: p.kind };
}

function HostedApplicationGraceEmail(props: HostedApplicationGraceEmailProps & { t: T }) {
  const { t } = props;
  return (
    <EmailLayout locale={props.locale} preview={t('preview', values(props))} footer={t('footer')}>
      <Text style={para}>{t('greeting', values(props))}</Text>
      <Text style={para}>{t(`lede.${props.kind}`, values(props))}</Text>
      <Section style={cta}>
        <PrimaryButton href={props.productionUrl} label={t('openProduction')} />
      </Section>
    </EmailLayout>
  );
}

const para = { fontSize: '16px', margin: '0 0 16px' };
const cta = { margin: '8px 0 24px' };

export async function hostedApplicationGraceEmail(
  props: HostedApplicationGraceEmailProps,
): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.hostedApplicationGrace',
  }) as T;
  const html = await render(<HostedApplicationGraceEmail {...props} t={t} />);
  return {
    subject: t('subject', values(props)),
    text: [
      t('greeting', values(props)),
      '',
      t(`lede.${props.kind}`, values(props)),
      '',
      `${t('openProduction')}: ${props.productionUrl}`,
      '',
      t('footer'),
      '',
      '— Motir',
    ].join('\n'),
    html,
  };
}

export default HostedApplicationGraceEmail;
