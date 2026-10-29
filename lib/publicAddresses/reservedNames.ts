// The reserved-label set and the label grammar for a workspace subdomain —
// Story MOTIR-3878 · Subtask MOTIR-4209.
//
// `docs/decisions/public-tenant-addresses.md` §8 is the record, as amended by its
// AMENDMENT 4 (the address of each hosted application, MOTIR-9790 · MOTIR-10025),
// which reserves the `--` separator, caps a workspace label at 30 and adds the
// application-slug rule at the bottom of this file. The set is
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

/**
 * The longest workspace label (ADR §8 AMENDMENT 4).
 *
 * The DNS label limit (RFC 1035 §2.3.4) is 63, but an application's host is
 * `<app>--<workspace>.<base>` — ONE label holding both names — so each half is
 * capped at 30 and the whole (30 + 2 + 30 = 62) always fits.
 */
export const MAX_SUBDOMAIN_LENGTH = 30;

/**
 * The separator between an application slug and its workspace label in an
 * application host (ADR §8 AMENDMENT 4). It is reserved ANYWHERE in a workspace
 * label so no workspace label can ever equal an application host — which also
 * covers the old rule-4 clause (`--` at positions 3–4, the punycode-lookalike
 * form) that `refuseLabel` never enforced.
 */
export const RESERVED_SEPARATOR = '--';

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
 * Is this label RESERVED — the ADR §8 set plus the STRUCTURAL rules?
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
 *   * a `motir-` prefix keeps the namespace's first-party-looking corner ours;
 *   * a `--` anywhere is the application-host separator (AMENDMENT 4), so no
 *     workspace label can ever equal an `<app>--<workspace>` host.
 *
 * Case is NOT normalised here. DNS labels are lowercase by the grammar above, so
 * an uppercase input is a grammar failure rather than a name to fold — the
 * caller lowercases at the edge if it wants to be forgiving, and doing it here
 * would make `isReservedLabel('ADMIN')` answer `false`.
 */
export function isReservedLabel(label: string): boolean {
  return isStructurallyReserved(label) || RESERVED_SUBDOMAIN_LABELS.has(label);
}

/**
 * The structural rules as ONE predicate, so `isReservedLabel` and `refuseLabel`
 * cannot disagree about them: the `_`, `xn--` and `motir-` prefixes, and the
 * reserved `--` separator anywhere in the label (AMENDMENT 4).
 */
function isStructurallyReserved(label: string): boolean {
  return (
    label.startsWith('_') ||
    label.startsWith('xn--') ||
    label.startsWith('motir-') ||
    label.includes(RESERVED_SEPARATOR)
  );
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
  if (isStructurallyReserved(label)) return 'structurally_reserved';
  if (RESERVED_SUBDOMAIN_LABELS.has(label)) return 'reserved';
  return null;
}

// ── The application slug (ADR §8 AMENDMENT 4, rule 3) ───────────────────────

/** The shortest application slug. Below 3, `<app>--` would put `--` at positions 3–4 — the punycode-lookalike form. */
export const MIN_APPLICATION_SLUG_LENGTH = 3;

/** The longest application slug: its half of the 62-character application host. */
export const MAX_APPLICATION_SLUG_LENGTH = 30;

/** Why an application slug was refused. */
export type ApplicationSlugRefusal = Exclude<LabelRefusal, 'reserved'>;

/**
 * May `slug` name an application inside its workspace's host
 * `<slug>--<workspace>.<base>`? `null` when it may.
 *
 * The label grammar, 3 to 30 characters, and no `--`. **The listed reserved
 * names do NOT apply** (AMENDMENT 4, rule 4): the full label always ends in the
 * tenant's own workspace label, and the workspace label is where the reserved set
 * protects Motir's names — so `admin--acme` is the tenant's, never Motir's. The
 * 3-character minimum with the grammar also rules out a leading `xn--`.
 */
export function refuseApplicationSlug(slug: string): ApplicationSlugRefusal | null {
  if (!LABEL_GRAMMAR.test(slug)) return 'bad_grammar';
  if (slug.length < MIN_APPLICATION_SLUG_LENGTH) return 'too_short';
  if (slug.length > MAX_APPLICATION_SLUG_LENGTH) return 'too_long';
  if (slug.includes(RESERVED_SEPARATOR)) return 'structurally_reserved';
  return null;
}
