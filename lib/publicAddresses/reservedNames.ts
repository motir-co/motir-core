// The reserved-label set and the label grammar for a workspace subdomain —
// Story MOTIR-3878 · Subtask MOTIR-4209.
//
// `docs/decisions/public-tenant-addresses.md` §8 is the record. The set is
// enumerated THERE and mirrored here, and `tests/publicAddresses/reservedNames.test.ts`
// re-derives it from the ADR's own tables so the two cannot drift: a name added
// to the record and not to this file fails the suite, and so does the reverse.
//
// ── Why a constant and not a database table ────────────────────────────────
//
// The set is a property of MOTIR'S OWN hostnames and of what a reader could
// mistake for one — not of a tenant, not of a deployment, and not something an
// operator should be able to edit without review. It changes when we add a
// hostname of our own, which is a code change with a pull request attached. A
// table would make it editable by whoever holds the console and invisible to
// `git log`.

/**
 * Motir's own hostnames, and hostnames a reader would read as ours.
 *
 * Every entry is here because a customer holding it could serve content that
 * looks like Motir at an address that looks like Motir's. `app` and `api` are
 * the sharpest — those are real hosts today — but `login`, `auth` and `billing`
 * are the same hazard with the phishing step already done.
 */
const MOTIR_HOSTNAMES: readonly string[] = [
  'www',
  'app',
  'api',
  'mail',
  'smtp',
  'imap',
  'mx',
  'ns',
  'ns1',
  'ns2',
  'status',
  'docs',
  'help',
  'support',
  'blog',
  'admin',
  'assets',
  'cdn',
  'static',
  'img',
  'media',
  'motir',
  'moooon',
  'staging',
  'preview',
  'dev',
  'test',
  'internal',
  'dashboard',
  'account',
  'accounts',
  'billing',
  'login',
  'signin',
  'signup',
  'auth',
  'oauth',
  'sso',
  'webhook',
  'webhooks',
  'ai',
  'gateway',
];

/**
 * Labels whose whole value to an attacker is that they sound official.
 *
 * Distinct from the list above, and kept separate on purpose: those are names we
 * USE, these are names we would never use and precisely for that reason nobody
 * would question. `security.<base>` hosting a customer's page is a worse outcome
 * than `blog.<base>` doing so.
 */
const IMPERSONATION_RISKS: readonly string[] = [
  'security',
  'abuse',
  'postmaster',
  'hostmaster',
  'webmaster',
  'noreply',
  'no-reply',
  'official',
  'verify',
  'verification',
  'payment',
  'payments',
  'invoice',
  'legal',
  'privacy',
  'terms',
];

/** The ADR §8 reserved set, as one membership test. */
export const RESERVED_SUBDOMAIN_LABELS: ReadonlySet<string> = new Set([
  ...MOTIR_HOSTNAMES,
  ...IMPERSONATION_RISKS,
]);

/**
 * The shortest label a workspace may claim.
 *
 * Short labels are the scarcest thing in the namespace and the most valuable, so
 * they are held back deliberately rather than handed to whoever signs up first.
 * Stated as a RULE rather than by listing every one- and two-character string,
 * which is the same reason rule 3 below is a predicate and not a list.
 */
export const MIN_SUBDOMAIN_LENGTH = 3;

/** The DNS label limit (RFC 1035 §2.3.4). Not ours to choose. */
export const MAX_SUBDOMAIN_LENGTH = 63;

/**
 * The label grammar: lowercase letters, digits and hyphens, not starting or
 * ending with a hyphen.
 */
const LABEL_GRAMMAR = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Why a label was refused — the discriminator the service turns into copy. */
export type LabelRefusal =
  | 'too_short'
  | 'too_long'
  | 'bad_grammar'
  | 'structurally_reserved'
  | 'reserved';

/**
 * Is this label RESERVED — the ADR §8 set plus the two STRUCTURAL rules?
 *
 * The structural rules are predicates rather than list entries, which is the
 * whole reason they are rules:
 *
 *   * a leading `_` is the underscore space `_acme-challenge` and
 *     `_motir-verify` live in, and it is TOTAL over that space — a list would
 *     have to be extended every time a protocol invents a new underscore name;
 *   * a leading `xn--` is punycode, which is the form a homograph attack
 *     arrives in. Refusing the prefix refuses the whole class without anybody
 *     enumerating confusable scripts;
 *   * a `motir-` prefix keeps the namespace's first-party-looking corner ours.
 *
 * Case is NOT normalised here. DNS labels are lowercase by the grammar above, so
 * an uppercase input is a grammar failure rather than a name to fold — the
 * caller lowercases at the edge if it wants to be forgiving, and doing it here
 * would make `isReservedLabel('ADMIN')` answer `false`.
 */
export function isReservedLabel(label: string): boolean {
  if (label.startsWith('_')) return true;
  if (label.startsWith('xn--')) return true;
  if (label.startsWith('motir-')) return true;
  return RESERVED_SUBDOMAIN_LABELS.has(label);
}

/**
 * The full check: grammar, length, and the reserved set, in the order that
 * produces the most useful refusal.
 *
 * Returns `null` when the label is claimable. Grammar is tested BEFORE the
 * reserved set so `Admin` is reported as bad grammar rather than as reserved —
 * telling someone a name is taken when the real problem is the capital letter
 * sends them looking for a different name they do not need.
 */
export function refuseLabel(label: string): LabelRefusal | null {
  if (!LABEL_GRAMMAR.test(label)) return 'bad_grammar';
  if (label.length < MIN_SUBDOMAIN_LENGTH) return 'too_short';
  if (label.length > MAX_SUBDOMAIN_LENGTH) return 'too_long';
  if (label.startsWith('_') || label.startsWith('xn--') || label.startsWith('motir-')) {
    return 'structurally_reserved';
  }
  if (RESERVED_SUBDOMAIN_LABELS.has(label)) return 'reserved';
  return null;
}
