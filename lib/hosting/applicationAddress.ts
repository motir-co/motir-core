import {
  MAX_APPLICATION_SLUG_LENGTH,
  MIN_APPLICATION_SLUG_LENGTH,
  RESERVED_SEPARATOR,
} from '@/lib/publicAddresses/reservedNames';

// The ADDRESS of a hosted application (Story MOTIR-9797 · MOTIR-10026), per the
// address decision MOTIR-9790 and ADR public-tenant-addresses §8 AMENDMENT 4:
// `<slug>--<workspace label>.<base>`, one DNS label under the `*.<base>`
// wildcard. Pure: the service reads the workspace's claimed subdomain and the
// workspace's taken slugs, and hands them in.

/** What a slug is padded with when the repository name yields fewer than
 *  {@link MIN_APPLICATION_SLUG_LENGTH} characters (`ui` → `ui-app`). */
const SHORT_SLUG_SUFFIX = '-app';

/**
 * The repository name as a DNS-label-shaped slug: lowercased, every run of
 * characters outside `[a-z0-9]` one hyphen (so no `--` survives), no leading or
 * trailing hyphen, cut to {@link MAX_APPLICATION_SLUG_LENGTH}. The same
 * normalisation every single-label platform host uses (Netlify, Vercel).
 */
function baseSlug(repositoryName: string): string {
  let slug = repositoryName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0) slug = 'app';
  if (slug.length < MIN_APPLICATION_SLUG_LENGTH) slug += SHORT_SLUG_SUFFIX;
  return trimTo(slug, MAX_APPLICATION_SLUG_LENGTH);
}

function trimTo(slug: string, length: number): string {
  return slug.slice(0, length).replace(/-+$/, '');
}

/**
 * The application's slug in its workspace: the repository name's slug, or on a
 * clash with `takenSlugs` the first free `-2`, `-3`, … (the base cut short so the
 * suffix still fits in 30). By construction it always passes
 * `refuseApplicationSlug` — lowercase `[a-z0-9-]`, no `--`, no edge hyphen,
 * 3–30 long — which `tests/hosting/hostedVocabulary.test.ts` asserts.
 */
export function deriveApplicationSlug(
  repositoryName: string,
  takenSlugs: ReadonlySet<string>,
): string {
  const base = baseSlug(repositoryName);
  let candidate = base;
  for (let n = 2; takenSlugs.has(candidate); n += 1) {
    const suffix = `-${n}`;
    candidate = `${trimTo(base, MAX_APPLICATION_SLUG_LENGTH - suffix.length)}${suffix}`;
  }
  return candidate;
}

/** The production host, `<slug>--<workspace label>.<base>`, without scheme. */
export function applicationHost(slug: string, workspaceLabel: string, base: string): string {
  return `${slug}${RESERVED_SEPARATOR}${workspaceLabel}.${base}`;
}

/**
 * The application host for a workspace's claimed subdomain hostname
 * (`acme.motir.site` → `shop--acme.motir.site`). A workspace subdomain is
 * exactly one label on the base, so its first label is the workspace label and
 * the rest is the base.
 */
export function applicationHostForWorkspaceHostname(
  slug: string,
  workspaceHostname: string,
): string {
  const dot = workspaceHostname.indexOf('.');
  return applicationHost(slug, workspaceHostname.slice(0, dot), workspaceHostname.slice(dot + 1));
}
