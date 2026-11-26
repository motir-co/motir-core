// THE TAKEOVER HANDOVER'S OWNER FIELDS (Story MOTIR-9800 · MOTIR-12131 ·
// MOTIR-12137) — the one rule for the owner email and the GitHub owner, read by
// the service that refuses a malformed start AND by the handover step that
// refuses it before any request, so the two can never disagree about what is
// well formed.

/** An address with one `@` and a dot in its domain. AWS checks the rest. */
export const HANDOVER_OWNER_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** RFC 5321's limit on an address. */
export const HANDOVER_OWNER_EMAIL_MAX = 254;

/** GitHub's login shape: alphanumerics and single hyphens, at most 39. */
export const HANDOVER_GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Whether `value` (already trimmed) is a well-formed owner email. */
export function isHandoverOwnerEmail(value: string): boolean {
  return HANDOVER_OWNER_EMAIL.test(value) && value.length <= HANDOVER_OWNER_EMAIL_MAX;
}

/** Whether `value` (already trimmed) is a well-formed GitHub login. */
export function isHandoverGithubOwner(value: string): boolean {
  return HANDOVER_GITHUB_OWNER.test(value);
}
