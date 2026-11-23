import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hostedApplicationGraceEmail,
  type HostedApplicationGraceEmailProps,
} from '@/lib/emailTemplates/hostedApplicationGrace';
import { GRACE_NOTICE_KINDS } from '@/lib/hosting/vocabulary';
import { EMAIL_TEMPLATE_CLASS } from '@/lib/services/emailService';

// The grace-window notice TEMPLATE alone (Story MOTIR-9800 · MOTIR-12136): each
// kind's subject and lede name the repository and the date, the button opens
// the Production panel, the plain text carries the same link, the reader's
// language is honoured, and the template stays pure.

const URL = 'https://app.example.test/production?repository=repo-1';

const base: HostedApplicationGraceEmailProps = {
  kind: 'seven_days',
  recipientName: 'Ana',
  repositoryName: 'shop-web',
  stopDate: 'December 1, 2026',
  productionUrl: URL,
};

const SUBJECTS: Record<HostedApplicationGraceEmailProps['kind'], string> = {
  transferred: 'shop-web keeps running on Motir until December 1, 2026',
  seven_days: 'shop-web stops running on Motir in 7 days',
  one_day: 'shop-web stops running on Motir tomorrow',
  stopped: 'shop-web has stopped running on Motir',
};

const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/[​⁠﻿]/g, '')
    .replace(/\s+/g, ' ');

describe('hostedApplicationGraceEmail', () => {
  it.each(GRACE_NOTICE_KINDS)(
    'the %s notice names the repository, its date and the panel',
    async (kind) => {
      const email = await hostedApplicationGraceEmail({ ...base, kind });
      expect(email.subject).toBe(SUBJECTS[kind]);
      const text = textOf(email.html);
      expect(text).toContain('Hi Ana,');
      expect(text).toContain('shop-web');
      if (kind !== 'stopped') expect(text).toContain('December 1, 2026');
      expect(text).toContain('Open the Production panel');
      expect(email.html).toContain(`href="${URL}"`);
      expect(email.text).toContain(`Open the Production panel: ${URL}`);
      expect(email.text.startsWith('Hi Ana,')).toBe(true);
      expect({ subject: email.subject, text: email.text }).toMatchSnapshot();
    },
  );

  it('the stopped notice points at the final export, not a stop date', async () => {
    const email = await hostedApplicationGraceEmail({ ...base, kind: 'stopped' });
    expect(email.text).toContain('final database export');
    expect(email.text).toContain('30 days');
  });

  it('renders in the reader’s language', async () => {
    const email = await hostedApplicationGraceEmail({ ...base, kind: 'one_day', locale: 'de' });
    expect(email.subject).not.toBe(SUBJECTS.one_day);
    expect(email.subject).toContain('shop-web');
    expect(email.html).toContain('lang="de-DE"');
    expect(email.text).toContain('Hallo Ana,');
  });

  it('is an essential email, and its template is pure', () => {
    expect(EMAIL_TEMPLATE_CLASS['hosted-application-grace']).toBe('essential');
    const source = readFileSync(
      join(__dirname, '..', '..', 'lib', 'emailTemplates', 'hostedApplicationGrace.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/from '@\/lib\/db'|process\.env|sendEmail/);
  });
});
