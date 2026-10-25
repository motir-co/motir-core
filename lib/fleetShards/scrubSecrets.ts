// The last line of defence for text an operator reads (Story MOTIR-9362 ·
// MOTIR-9463). The fleet code keeps secrets out by construction — it prints and
// stores outcomes, AWS's error codes and request ids — but some text is AWS's own
// (a refusal reason), so every line `fleet-admin`'s pool commands print, and the
// failure text their audit row carries, passes through here first.

const REDACTED = '[redacted]';

const SECRET_PATTERNS: readonly RegExp[] = [
  // AWS access key ids: long-lived (AKIA), session (ASIA), role and user ids.
  /\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9_]{8,}/g,
  // GitHub tokens: installation, user, OAuth, refresh, PAT.
  /\bgh[pousr]_[A-Za-z0-9_]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // A PEM block (an App's private key).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // A long base64 run: a secret access key (40) or a session token (hundreds).
  /[A-Za-z0-9/+=]{40,}/g,
];

/** `text` with every credential-shaped run replaced by `[redacted]`. */
export function scrubSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((out, pattern) => out.replace(pattern, REDACTED), text);
}
