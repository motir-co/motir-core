import { PreviewHostInvalidError } from './errors';

// THE PREVIEW HOST (MOTIR-5769 §9 "Host name"), as a pure function.
//
//   pr-<n>--<repo-slug>.<preview domain>
//
// Slug: the GitHub repository name, lowercased, every run of characters outside
// `[a-z0-9]` → `-`, trimmed of `-`, then cut so the whole first label is at most
// 63 characters (a DNS label). COLLISION: when another row already holds that
// host, append `-` + the first 6 characters of the repository's row id, cutting
// the slug further so the label still fits.
//
// The host is STORED on the `preview_deployment` row and looked up host → row;
// nothing ever parses it back into a repository, so the cut and the suffix may
// lose information freely.

/** A DNS label's limit (RFC 1035 §2.3.4). */
export const DNS_LABEL_MAX = 63;
/** How much of the row id disambiguates a colliding slug. */
export const COLLISION_SUFFIX_LENGTH = 6;

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export interface PreviewHostInput {
  readonly pullRequestNumber: number;
  /** The GitHub repository name, as GitHub returns it (`My.Repo_name`). */
  readonly repositoryName: string;
  /** The repository's row id — a lowercase cuid. */
  readonly repositoryId: string;
  /** `preview.motir.site` (`previewDomain()`). */
  readonly domain: string;
}

/** The repository name as a label fragment: may be empty. */
export function repositorySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The id's first characters that can stand in a label. */
function idFragment(repositoryId: string): string {
  const fragment = repositorySlug(repositoryId).replace(/-/g, '').slice(0, COLLISION_SUFFIX_LENGTH);
  if (!fragment) throw new PreviewHostInvalidError('the repository id has no letter or digit');
  return fragment;
}

function checkDomain(domain: string): string {
  const lower = domain.trim().toLowerCase();
  const labels = lower.split('.');
  if (!lower || !labels.every((l) => l.length <= DNS_LABEL_MAX && LABEL.test(l))) {
    throw new PreviewHostInvalidError(`"${domain}" is not a DNS name`);
  }
  return lower;
}

/** The first label, `pr-<n>--<slug>[-<id6>]`, within 63 characters. */
function firstLabel(input: PreviewHostInput, disambiguate: boolean): string {
  const n = input.pullRequestNumber;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new PreviewHostInvalidError(`pull request number ${String(n)} is not a positive integer`);
  }
  const prefix = `pr-${n}--`;
  const suffix = disambiguate ? `-${idFragment(input.repositoryId)}` : '';
  // An all-symbol name slugs to nothing; the id keeps the label meaningful.
  const slug = repositorySlug(input.repositoryName) || idFragment(input.repositoryId);
  const room = DNS_LABEL_MAX - prefix.length - suffix.length;
  const cut = slug.slice(0, room).replace(/-+$/, '');
  return `${prefix}${cut}${suffix}`;
}

/** The host before any collision: `pr-<n>--<slug>.<domain>`. */
export function previewHostName(input: PreviewHostInput): string {
  return `${firstLabel(input, false)}.${checkDomain(input.domain)}`;
}

/** The host when `previewHostName` is already held by another row. */
export function disambiguatedPreviewHostName(input: PreviewHostInput): string {
  return `${firstLabel(input, true)}.${checkDomain(input.domain)}`;
}

/**
 * The ADR's rule in one call: the plain host unless `isTaken` says another row
 * holds it, then the disambiguated one. `isTaken` answers for a host held by a
 * row OTHER than this repository's own preview of this pull request.
 */
export async function choosePreviewHostName(
  input: PreviewHostInput,
  isTaken: (host: string) => Promise<boolean>,
): Promise<string> {
  const plain = previewHostName(input);
  return (await isTaken(plain)) ? disambiguatedPreviewHostName(input) : plain;
}
