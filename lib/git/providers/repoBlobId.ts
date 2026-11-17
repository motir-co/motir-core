import { FULL_COMMIT_SHA } from '../commitSha';
import { REPO_FILE_READ_TIMEOUT_MS } from '../provider';

// THE HOST'S OBJECT ID OF ONE FILE AT ONE COMMIT (MOTIR-11528) — the second,
// deliberate question `readFileAtRef` asks when its caller sets
// `options.blobSha`, once the text read has already produced a `found` answer.
//
// ⚠️ THE ID IS THE HOST'S, NEVER OURS. Neither raw text endpoint carries it, and
// hashing the bytes we received would be a value the host can disagree with
// (line-ending filters, LFS pointers, a different object format) — and the id
// is recorded as the key another service stores content under, so a computed
// one would make every later lookup miss. Both helpers below read an answer the
// host gave about that path at that ref, and validate it with the same
// full-object-id pattern the seam already applies to a resolved commit.
//
// ⚠️ A DELIBERATE EXCEPTION TO "NO SWALLOWED ERRORS". Every failure here — a
// refused credential, a status no arm names, a timeout, a body that is not the
// expected shape — is absorbed into `undefined`. The id is BEST EFFORT: it is an
// addition to a read a planning session has already been given, and that read
// must never be lost, or turned into a different outcome, over it. The caller
// answers `found` without the field, which is exactly what a host that has no
// id answers too.

/** A full object id from a host's answer, canonical, or `undefined`. */
function fullObjectId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim().toLowerCase();
  return FULL_COMMIT_SHA.test(id) ? id : undefined;
}

/** A fetch bounded by {@link REPO_FILE_READ_TIMEOUT_MS}; `null` on any transport failure. */
async function boundedFetch(url: string, init: RequestInit): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPO_FILE_READ_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    // Best effort (see the header): a dead host or the deadline is "no id".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GitHub's `Repository.object(expression: "<ref>:<path>")` read as a `Blob`'s
 * `oid` — the same GraphQL surface the blame read uses for what REST cannot
 * answer. The REST contents ENVELOPE also carries a `sha`, and is deliberately
 * not used: it brings the token-bearing `download_url` into this process, which
 * the raw media type exists to keep out.
 */
const BLOB_OID_QUERY = `query($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expression) { ... on Blob { oid } }
  }
}`;

/**
 * The object id GitHub gives for `path` at `ref`, or `undefined` when it gives
 * none (an object that is not a blob, an error, a refusal, a timeout).
 * `ref` and `path` are the ones the text was read at, so the id names that
 * content and nothing a range sliced later could change.
 */
export async function githubBlobId(
  apiBase: string,
  token: string,
  owner: string,
  name: string,
  ref: string,
  path: string,
): Promise<string | undefined> {
  const res = await boundedFetch(`${apiBase}/graphql`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'motir',
    },
    body: JSON.stringify({
      query: BLOB_OID_QUERY,
      variables: { owner, name, expression: `${ref}:${path}` },
    }),
  });
  if (!res?.ok) return undefined;
  const body = (await res.json().catch(() => null)) as {
    data?: { repository?: { object?: { oid?: unknown } | null } | null } | null;
  } | null;
  return fullObjectId(body?.data?.repository?.object?.oid);
}

/** The header GitLab's files endpoints set to the blob's id (`X-Gitlab-Blob-Id`). */
export const GITLAB_BLOB_ID_HEADER = 'x-gitlab-blob-id';

/**
 * The object id GitLab gives for a file, or `undefined`.
 *
 * GitLab's raw read already answers the id: its files endpoints set the
 * `X-Gitlab-*` metadata headers from the blob they served, `X-Gitlab-Blob-Id`
 * among them (`lib/api/files.rb`, `set_http_headers(blob_data(…))` on the `raw`
 * route as on the `HEAD` metadata route). So the header on the response the text
 * came from is read first, costing no request at all. Only where that response
 * carries none — a proxy that strips `X-*` headers, an older deployment — is the
 * documented metadata read asked: `HEAD /projects/:id/repository/files/:path?ref=`,
 * the same path and ref, which answers the same headers with no body.
 */
export async function gitlabBlobId(
  rawResponse: Response,
  metadataUrl: string,
  token: string,
): Promise<string | undefined> {
  const served = fullObjectId(rawResponse.headers.get(GITLAB_BLOB_ID_HEADER));
  if (served) return served;
  const res = await boundedFetch(metadataUrl, {
    method: 'HEAD',
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'motir' },
  });
  if (!res?.ok) return undefined;
  return fullObjectId(res.headers.get(GITLAB_BLOB_ID_HEADER));
}
