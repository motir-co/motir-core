import { describe, expect, it } from 'vitest';
import {
  pageCommentNotificationEmail,
  type PageCommentNotificationEmailProps,
} from '@/lib/emailTemplates/pageCommentNotification';
import { EMAIL_TEMPLATE_CLASS, NOTIFICATION_TEMPLATES } from '@/lib/services/emailService';
import enMessages from '@/messages/en.json';

// The page-comment email TEMPLATE alone (Story MOTIR-10868 · MOTIR-10925), as
// drawn in `design/notifications/page-comment-email.mock.html`: both variants'
// parts and their order, the reply's reason line, the quote block's absence, the
// untitled fallback in the reader's language, and the hand-written plain text.

const URL = 'https://app.example.test/pages/page-1?thread=comment-1';

const base: PageCommentNotificationEmailProps = {
  recipientName: 'Ben',
  authorName: 'Ana Ruiz',
  pageTitle: 'Release checklist',
  variant: 'mention',
  excerpt: 'Can you check this, @Ben Okafor?',
  threadUrl: URL,
};

/** The HTML's visible text, tags dropped and whitespace collapsed. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/[​⁠﻿]/g, '')
    .replace(/\s+/g, ' ');

/** The index of each fragment in `text`, asserting each is present. */
function positions(text: string, fragments: string[]): number[] {
  return fragments.map((f) => {
    const at = text.indexOf(f);
    expect(at, `"${f}" in the email`).toBeGreaterThanOrEqual(0);
    return at;
  });
}

const REASON = "You're receiving this because you replied in this thread.";

describe('pageCommentNotificationEmail', () => {
  it('the mention variant draws its parts in order and no reason line', async () => {
    const email = await pageCommentNotificationEmail(base);
    expect(email.subject).toBe('Ana Ruiz mentioned you on Release checklist');
    const text = textOf(email.html);
    const at = positions(text, [
      'Ana Ruiz mentioned you on Release checklist', // the preview
      'Hi Ben,',
      'Ana Ruiz mentioned you in a comment on Release checklist.',
      'Can you check this, @Ben Okafor?',
      'Open the discussion',
      'Or copy this link into your browser:',
      URL,
    ]);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).not.toContain(REASON);
    expect(email.html).toContain(`href="${URL.replace(/&/g, '&amp;')}"`);
    expect(email.html).not.toContain('/items/');
  });

  it('the reply variant adds its reason line after the fallback link', async () => {
    const email = await pageCommentNotificationEmail({
      ...base,
      variant: 'reply',
      excerpt: 'Done.',
    });
    expect(email.subject).toBe('Ana Ruiz replied to a thread on Release checklist');
    const text = textOf(email.html);
    const at = positions(text, [
      'Hi Ben,',
      'Ana Ruiz replied to a thread on Release checklist.',
      'Done.',
      'Open the discussion',
      'Or copy this link into your browser:',
      URL,
      REASON,
    ]);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The AA grey of the fallback label, not the work-item reason line's #9ca3af.
    expect(email.html).not.toContain('#9ca3af');
  });

  it('a null excerpt omits the quote block and its spacing', async () => {
    const withQuote = await pageCommentNotificationEmail(base);
    const without = await pageCommentNotificationEmail({ ...base, excerpt: null });
    expect(withQuote.html).toContain('border-left:3px solid #e5e7eb');
    expect(without.html).not.toContain('border-left:3px solid #e5e7eb');
    expect(without.html).not.toMatch(/<p[^>]*>\s*<\/p>/);
    expect(without.text).not.toContain('\n\n\n');
  });

  it('an untitled page reads the pages word in the reader’s language', async () => {
    const en = await pageCommentNotificationEmail({ ...base, pageTitle: '' });
    expect(en.subject).toBe(`Ana Ruiz mentioned you on ${enMessages.pages.untitled}`);
    expect(en.text).toContain(`on ${enMessages.pages.untitled}.`);

    const { getMessagesFor } = await import('@/lib/i18n/messages');
    const de = getMessagesFor('de') as unknown as { pages: { untitled: string } };
    const german = await pageCommentNotificationEmail({ ...base, pageTitle: '', locale: 'de' });
    expect(german.subject).toContain(de.pages.untitled);
    expect(german.html).toContain('lang="de-DE"');
  });

  it('writes the plain text by hand with the link unredacted', async () => {
    const mention = await pageCommentNotificationEmail(base);
    expect(mention.text).toBe(
      [
        'Hi Ben,',
        '',
        'Ana Ruiz mentioned you in a comment on Release checklist.',
        '',
        'Can you check this, @Ben Okafor?',
        '',
        `Open the discussion: ${URL}`,
        '',
        '— Motir',
      ].join('\n'),
    );
    const reply = await pageCommentNotificationEmail({ ...base, variant: 'reply', excerpt: null });
    expect(reply.text).toBe(
      [
        'Hi Ben,',
        '',
        'Ana Ruiz replied to a thread on Release checklist.',
        '',
        `Open the discussion: ${URL}`,
        '',
        REASON,
        '',
        '— Motir',
      ].join('\n'),
    );
  });

  it('reads exactly the design’s ten keys', () => {
    expect(Object.keys(enMessages.email.pageCommentNotification).sort()).toEqual(
      [
        'subjectMention',
        'previewMention',
        'subjectReply',
        'previewReply',
        'greeting',
        'ledeMention',
        'ledeReply',
        'view',
        'fallback',
        'reasonReply',
      ].sort(),
    );
  });

  it('matches the committed snapshot of each variant', async () => {
    for (const variant of ['mention', 'reply'] as const) {
      const email = await pageCommentNotificationEmail({ ...base, variant });
      // The brand mark's origin is the environment's base URL; the snapshot pins
      // the email, not where the suite happens to run.
      const html = email.html.replace(/https?:\/\/[^"]*(\/email-mark-\d+\.png)/g, '<base>$1');
      expect({ ...email, html }).toMatchSnapshot(variant);
    }
  });
});

describe('the email service registration', () => {
  it('classifies the template as a notification, so the rolling budget counts it', () => {
    expect(EMAIL_TEMPLATE_CLASS['page-comment-notification']).toBe('notification');
    expect(NOTIFICATION_TEMPLATES).toContain('page-comment-notification');
  });
});
