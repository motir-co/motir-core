import { resolveBaseUrl } from '@/lib/baseUrl';

// Which links leave Motir (MOTIR-12300). A link to code — a GitHub file, pull
// request or commit — is an absolute `http(s)` URL on another host, and it must
// open in a NEW tab so the person keeps their place in Motir. Everything that is
// Motir itself keeps navigating in place: a relative path, a fragment, the
// internal schemes the renderer turns into chips (`mention:`, `motir:`,
// `motir-page:`, `motir-ref:`), `mailto:` / `tel:`, and an absolute URL on the
// app's OWN origin (a link to an item page pasted into a comment).

/** The anchor attributes a new-tab link carries — `rel` cuts the opener and the referrer. */
export const NEW_TAB_LINK_PROPS = { target: '_blank', rel: 'noopener noreferrer' } as const;

/**
 * The origin a link is compared against: the page's own in the browser, and the
 * configured application origin (`lib/baseUrl.ts`) while rendering on the server.
 */
export function currentAppOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return new URL(resolveBaseUrl()).origin;
}

// An absolute http(s) URL, or a protocol-relative one (`//host/path`).
const ABSOLUTE_WEB_URL_RE = /^(?:https?:)?\/\//i;

/** True when `href` is an http(s) link to an origin other than `appOrigin`. */
export function isExternalHref(href: unknown, appOrigin: string = currentAppOrigin()): boolean {
  if (typeof href !== 'string') return false;
  const trimmed = href.trim();
  if (!ABSOLUTE_WEB_URL_RE.test(trimmed)) return false;
  let target: URL;
  let base: URL;
  try {
    base = new URL(appOrigin);
    target = new URL(trimmed, base);
  } catch {
    // An unparseable href is not a navigation anywhere else; leave it as authored.
    return false;
  }
  return target.origin !== base.origin;
}

/** `NEW_TAB_LINK_PROPS` for an external `href`, nothing otherwise — spread onto the `<a>`. */
export function externalLinkProps(
  href: unknown,
  appOrigin?: string,
): typeof NEW_TAB_LINK_PROPS | Record<string, never> {
  return isExternalHref(href, appOrigin) ? NEW_TAB_LINK_PROPS : {};
}
