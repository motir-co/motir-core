import { Body, Container, Head, Hr, Html, Img, Preview, Text } from '@react-email/components';
import type { ReactNode } from 'react';
import { EMAIL_MARK_PATH, EMAIL_MARK_PX } from '@motir/brand';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import { BCP47 } from '@/lib/utils/datetime';

// Shared chrome for every Motir transactional email. Each template
// wraps its content in <EmailLayout preview="…">…</EmailLayout> so
// the outer styling (max-width, padding, header, footer divider,
// "— Motir" sign-off) stays consistent.
//
// `preview` is the inbox snippet text — the first thing users see in
// Gmail / Outlook list views. Always pass a one-line summary of the
// email's purpose; an empty preview lets the email client pick
// arbitrary leading body text which usually reads badly.

export interface EmailLayoutProps {
  preview: string;
  children: ReactNode;
  // The footer is rendered above the "— Motir" line. Templates that
  // need a per-email caveat ("This invite expires in 7 days." / "If
  // you didn't request this, you can ignore this email.") pass it
  // here; the line break + small grey treatment is consistent.
  footer?: ReactNode;
  // The language the email is written in — the RECIPIENT's (MOTIR-8104).
  // Declared on <html lang> so a screen reader and a mail client's translate
  // offer read the body in the right language. Omitted ⇒ English.
  locale?: Locale;
}

const main = {
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  backgroundColor: '#ffffff',
  margin: '0',
  padding: '0',
};

const container = {
  maxWidth: '560px',
  margin: '0 auto',
  padding: '24px',
};

const brandRow = {
  color: '#6b7280',
  fontSize: '14px',
  margin: '0 0 24px',
};

// The brand mark for email (design/brand/design-notes.md §7e). Email is a
// raster-and-tables world: Outlook's Word renderer drops inline <svg> entirely
// and Gmail strips <style>, so the mark ships as an <img> with a LITERAL colour
// baked into the pixels and explicit width/height — never an inline <svg>
// element, never a CSS variable. `alt="Motir"` is not decoration: roughly 40% of
// clients block images by default, and the alt text is then the entire header.
//
// One colour for both themes. Email has no reliable dark-mode signal, and the
// mark's `BRAND_GLYPH_HEX` (#155bc4, the Motir palette's --el-accent-on-surface)
// holds 6.31:1 on the white body this layout hardcodes (§10).
//
// ⚠️ THE SRC IS A HOSTED PNG AT AN ABSOLUTE https:// URL, AND ALL THREE WORDS
// ARE LOAD-BEARING (MOTIR-3505). The paragraph above was here from the start and
// is right; what sat under it was a `data:image/svg+xml` URI, which is the
// format it had just ruled out delivered by a transport email does not accept.
// Every one of the eight templates wraps in this layout, so the mark rendered
// for nobody — it degraded to the alt text for 100% of recipients, not 40%,
// which is why it shipped unnoticed. Three constraints, each with a client that
// punishes getting it wrong:
//
//   RASTER, not SVG   — Gmail, Outlook and Yahoo render SVG in email in no
//                       transport at all, hosted or inline.
//   HOSTED, not data: — Gmail rewrites every image through its
//                       googleusercontent.com proxy and drops sources it cannot
//                       FETCH. A data URI has nothing to proxy.
//   ABSOLUTE, not /…  — an email is not a document with a base URL, so a
//                       root-relative src resolves against nothing.
//
// ⚠️ AND THE ORIGIN IS RESOLVED HERE rather than threaded in as a prop, which is
// a deliberate exception to `CLAUDE.md`'s "templates read no `process.env`". That
// rule is about a template's CONTENT — the invite link a service builds and hands
// over. This is the shared CHROME, whose whole reason for living in
// `_components/` is that it changes in ONE place; threading an identical origin
// through eight templates, their prop types and their dispatching services would
// make a ninth template's omission fail exactly the way this bug did — a silently
// empty header. `resolveBaseUrl()` never throws and falls back to
// `http://localhost:3000`, so the layout stays snapshot-testable and
// preview-renderable, which is what that rule is protecting.
const BRAND_MARK_PX = EMAIL_MARK_PX;

const brandMark = {
  display: 'inline-block',
  verticalAlign: 'middle',
  marginRight: '8px',
};

const brandName = {
  verticalAlign: 'middle',
};

const divider = {
  borderColor: '#e5e7eb',
  borderStyle: 'solid',
  borderWidth: '1px 0 0',
  margin: '24px 0',
};

const footerText = {
  color: '#6b7280',
  fontSize: '14px',
  margin: '0 0 8px',
};

const signOff = {
  color: '#6b7280',
  fontSize: '14px',
  margin: '0',
};

export function EmailLayout({ preview, children, footer, locale }: EmailLayoutProps) {
  const brandMarkSrc = `${resolveBaseUrlTrimmed()}${EMAIL_MARK_PATH}`;
  return (
    <Html lang={BCP47[locale ?? defaultLocale]}>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={brandRow}>
            <Img
              src={brandMarkSrc}
              width={BRAND_MARK_PX}
              height={BRAND_MARK_PX}
              alt="Motir"
              style={brandMark}
            />
            <span style={brandName}>Motir</span>
          </Text>
          {children}
          {footer ? (
            <>
              <Hr style={divider} />
              <Text style={footerText}>{footer}</Text>
            </>
          ) : null}
          <Text style={signOff}>— Motir</Text>
        </Container>
      </Body>
    </Html>
  );
}
