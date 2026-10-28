// The provider-agnostic parts of the FILE-READ capability
// (Story MOTIR-4585 · MOTIR-4586): the repository-relative path guard, and the
// two small measurements both providers make on a response — whether a blob is
// text at all (MOTIR-7873), and a safe description of a failed one.
//
// ⚠️ IT LIVES BESIDE THE SEAM, NOT INSIDE ONE PROVIDER, AND EVERY PROVIDER CALLS
// IT FIRST. The path a `read_file` carries is MODEL-SUPPLIED — it is the one
// argument of the whole capability that is not bound from the job context — so
// the refusal has to be a property of the seam rather than of whichever call
// site happened to remember it. A guard written once at the route would be
// correct today and absent the first time anything else reaches a provider
// directly.
//
// ⚠️ AND IT REFUSES BEFORE ANY HOST CALL, WHICH IS THE POINT. Both hosts would
// very likely 404 a traversal anyway, and that is not the guarantee being made:
// a 404 is the HOST deciding, over the network, with our credential attached,
// and it is indistinguishable in a log from an honest miss. Refusing here means
// no request carrying a traversal is ever issued at all — which is what makes
// "a path outside the named repository cannot be reached" a fact about this
// code rather than a bet on two third parties.

import type { RepoDirectoryEntry } from './types';

/** Why a path was refused. Rendered to the caller verbatim, so it says what to
 *  fix rather than that something was wrong. */
export type RepoPathRefusal = string;

export interface RepoPathOk {
  ok: true;
  /** The path in its canonical form — no leading slash, no `./`, no `//`. */
  path: string;
}

export interface RepoPathRefused {
  ok: false;
  reason: RepoPathRefusal;
}

/**
 * Normalize a repository-relative file path, or refuse it.
 *
 * REFUSED: an absolute path (`/etc/passwd`), a Windows drive or UNC path, any
 * `..` segment however it is spelled or nested, a URL, an empty path, a NUL or
 * newline (header/URL smuggling), and anything over {@link MAX_REPO_PATH_LENGTH}.
 *
 * ACCEPTED and normalized: a leading `./`, redundant separators, a trailing
 * slash on a directory-looking path (the host answers for it; that is the
 * host's business, not the guard's).
 *
 * ⚠️ THE `..` CHECK IS PER-SEGMENT, NOT A SUBSTRING SCAN. `src/..foo/bar.ts` is
 * a legal path with a file whose name begins with two dots, and a
 * `path.includes('..')` guard refuses it — a guard that is wrong in the
 * direction nobody notices, because the only report is a model being told a
 * real file does not exist.
 */
export const MAX_REPO_PATH_LENGTH = 1024;

export function normalizeRepoFilePath(raw: string): RepoPathOk | RepoPathRefused {
  const refuse = (reason: string): RepoPathRefused => ({ ok: false, reason });

  if (typeof raw !== 'string') return refuse('the path must be a string');
  const path = raw.trim();
  if (!path) return refuse('the path is empty');
  if (path.length > MAX_REPO_PATH_LENGTH) {
    return refuse(`the path is longer than ${MAX_REPO_PATH_LENGTH} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    return refuse('the path contains a control character');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    return refuse('the path must be repository-relative, not a URL');
  }
  if (path.startsWith('/') || path.startsWith('\\')) {
    return refuse('the path must be repository-relative, not absolute');
  }
  if (/^[a-z]:[\\/]/i.test(path)) {
    return refuse('the path must be repository-relative, not a drive path');
  }

  const segments = path.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return refuse('the path names no file');
  if (segments.some((s) => s === '..')) {
    return refuse('the path must not traverse out of the repository ("..")');
  }

  return { ok: true, path: segments.join('/') };
}

/**
 * How much of a blob is scanned for a NUL — git's own `FIRST_FEW_BYTES`
 * (`xdiff-interface.c`'s `buffer_is_binary`), so a file this read calls binary
 * is a file `git diff` calls binary too.
 */
export const BINARY_SNIFF_BYTES = 8000;

/** A blob, classified BEFORE it is decoded (MOTIR-7873). */
export type RepoBlob = { kind: 'text'; text: string } | { kind: 'binary' };

/**
 * Decide whether a blob is text, and decode it only if it is.
 *
 * BINARY when either holds: a NUL in the first {@link BINARY_SNIFF_BYTES}
 * (git's heuristic — valid UTF-8 can carry a NUL, and no source file does), or
 * the bytes are not valid UTF-8 (a strict, `fatal` decode). Both are needed: a
 * PNG fails both, but a run of 0xFF bytes has no NUL, and a NUL-delimited record
 * is perfectly valid UTF-8.
 *
 * ⚠️ IT CLASSIFIES THE BYTES, NEVER A DECODED STRING. The read used to call
 * `res.text()`, which is a LENIENT decode: every invalid byte becomes U+FFFD and
 * the call always succeeds, so a PNG came back as `found` — a page of
 * replacement characters handed to a model as source. And because U+FFFD is
 * three bytes in UTF-8, measuring that string inflated the size: the repo's own
 * 4,877-byte `app/apple-icon.png` measured 8,737, and a binary well under the
 * cap could be reported `too_large`. A size is the blob's own `byteLength`.
 */
export function classifyRepoBlob(bytes: Uint8Array): RepoBlob {
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: 'binary' };
  try {
    return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { kind: 'binary' };
  }
}

/**
 * A short, SAFE description of a failed response, for a thrown error's message.
 *
 * ⚠️ IT IS TRUNCATED AND IT IS NEVER THE WHOLE BODY. An error message travels
 * into logs and, on some paths, into a response — and a host's error body can
 * echo the request, headers included. Taking the first 200 characters of text
 * is enough for an operator to recognise the failure and small enough that a
 * whole echoed request cannot ride along inside it.
 */
export async function describeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}

/**
 * The most children one directory read lists (MOTIR-9868) — GitHub's own cap on
 * its contents endpoint, applied on GitLab too so the SAME directory is cut at
 * the same place on either host.
 */
export const REPO_DIRECTORY_MAX_ENTRIES = 1000;

const GITHUB_ENTRY_TYPES = new Set(['file', 'dir', 'symlink', 'submodule']);

/**
 * GitHub's answer for a DIRECTORY, or `null` for anything else (MOTIR-9868).
 *
 * Asked for a directory, the contents endpoint ignores the raw media type and
 * answers its own JSON listing — which used to reach the caller as `found` text,
 * an undocumented shape owned by the host. A file's raw bytes can be a JSON
 * array too, so the listing is recognised by its SHAPE rather than by a header:
 * every element names a child whose `path` is `<dir>/<name>`, with a type the
 * endpoint uses and a blob `sha`. No committed file is that by accident.
 */
export function parseGithubDirectoryListing(
  bytes: Uint8Array,
  dirPath: string,
): RepoDirectoryEntry[] | null {
  const first = bytes.find((b) => b !== 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09);
  if (first !== 0x5b /* [ */) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const entries: RepoDirectoryEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return null;
    const { name, path, type, sha } = item as Record<string, unknown>;
    if (typeof name !== 'string' || typeof sha !== 'string' || typeof type !== 'string') {
      return null;
    }
    if (path !== `${dirPath}/${name}` || !GITHUB_ENTRY_TYPES.has(type)) return null;
    entries.push({ name, type: type as RepoDirectoryEntry['type'] });
  }
  return sortEntries(entries);
}

/**
 * One GitLab `repository/tree` item as a directory entry (MOTIR-9868): `tree` is
 * a directory, `commit` a submodule, and a `blob` with mode `120000` a symlink —
 * the same four types GitHub names.
 */
export function gitlabTreeEntry(item: unknown): RepoDirectoryEntry | null {
  if (!item || typeof item !== 'object') return null;
  const { name, type, mode } = item as Record<string, unknown>;
  if (typeof name !== 'string') return null;
  if (type === 'tree') return { name, type: 'dir' };
  if (type === 'commit') return { name, type: 'submodule' };
  if (type === 'blob') return { name, type: mode === '120000' ? 'symlink' : 'file' };
  return null;
}

export function sortEntries(entries: RepoDirectoryEntry[]): RepoDirectoryEntry[] {
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
