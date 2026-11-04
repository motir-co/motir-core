// Referenced-attachment parsing (Story 5.2 · Subtask 5.2.3; re-architected to
// ID-based by MOTIR-1668). Content attachments are now PRIVATE — they have no
// public blob URL. The editor inserts an upload into stored Markdown as its
// authenticated CONTENT PATH — `![name](/api/attachments/<id>/content)` for
// images, `[name](/api/attachments/<id>/content)` for files
// (lib/blob/uploadClient.ts) — so the embeds-are-attachments rule resolves at
// BODY-WRITE time by extracting the attachment IDS a body references and linking
// the matching rows. THIS helper is the pure string half (the sibling of
// lib/mentions/parse.ts): no Prisma, no IO, unit-testable anywhere. The DB half
// is attachmentsService.syncEditorLinks, which re-checks tenancy at the DB
// (findManyByIds is workspace-scoped — defence in depth, finding #26).
//
// Matching is construct-agnostic ON PURPOSE: any occurrence of a content path
// counts (embed, link, bare paste), mirroring the substring `contains` probe the
// unlink path uses for "still referenced elsewhere" — extraction and the
// keep-linked check ({@link attachmentContentPath}) must agree on what
// "referenced" means, or an edit could unlink a file the body still displays.

/**
 * The authenticated content path an attachment is served + embedded under
 * (MOTIR-1667). The single source of truth for both the DTO/embed value and the
 * keep-linked substring probe — they MUST agree.
 */
export function attachmentContentPath(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/content`;
}

/** An attachment content path in a Markdown body → its id. cuid: [a-z0-9]+. */
const CONTENT_PATH_RE = /\/api\/attachments\/([a-z0-9]+)\/content/gi;

/**
 * Extract the attachment IDS a Markdown body references via their content path,
 * DEDUPED in first-seen order (the parseMentionIds convention). Null/undefined
 * bodies extract to []. Tenancy is enforced at the DB (findManyByIds is
 * workspace-scoped), so a foreign/cross-workspace id extracts here but can never
 * link (or unlink) a row.
 */
export function extractReferencedAttachmentIds(bodyMd: string | null | undefined): string[] {
  if (!bodyMd) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of bodyMd.matchAll(CONTENT_PATH_RE)) {
    const id = match[1]!;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * The multi-body form: one issue write can carry several Markdown bodies
 * (description + explanation; a root comment + its replies on a thread delete).
 * Extracts each and merges, deduped in first-seen order.
 */
export function extractReferencedAttachmentIdsFromBodies(
  bodies: ReadonlyArray<string | null | undefined>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const body of bodies) {
    for (const id of extractReferencedAttachmentIds(body)) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * The per-USER avatar prefix an avatar upload writes under (Story 8.8 ·
 * Subtask 8.8.21) — `avatars/<userId>/…`. The personal analogue of the
 * `attachments/<workspaceId>/` attachment prefix above: an avatar is account
 * substrate (the account-settings area has no workspace/access axis), so it is
 * keyed by the owning USER, not a workspace. The avatar UPLOAD route writes the
 * blob here; `usersService.updateProfile` accepts an `image` URL only if it
 * lands here for THAT user (so user A can never point their avatar at user B's
 * — or any foreign — blob).
 */
export function avatarBlobPrefix(userId: string): string {
  return `avatars/${userId}/`;
}

/**
 * True iff `stored` refers to one of OUR public-bucket uploads under the calling
 * user's own avatar prefix. Used to (a) GATE an `image` update to a real
 * own-avatar reference, and (b) decide whether a REPLACED/removed prior `image`
 * is ours to delete — a provider URL from an OAuth signup (e.g. a Google avatar)
 * is NOT ours and must never be deleted. Anything else returns false (never
 * throws).
 *
 * ⚠️ It takes a STORED REFERENCE, not a URL (MOTIR-2404). `User.image` now holds
 * the object KEY for our own avatars, so the two accepted forms are:
 *  - a bare KEY (`avatars/<userId>/…`) — what `uploadAvatar` returns today;
 *  - the CONFIGURED public bucket origin (`MOTIR_S3_PUBLIC_BASE_URL`) — what it
 *    returned between MOTIR-2389 and MOTIR-2404.
 *
 * A third form — an absolute URL on the retired Vercel public host — used to be
 * accepted here as read tolerance for rows written before MOTIR-2389. MOTIR-2393
 * dropped it with the rest of the abandoned path: the live database holds ZERO
 * rows with a non-null `image` (measured 2026-08-07), so the tolerance protects
 * nothing and only keeps the old platform's hostname load-bearing.
 *
 * Accepting the absolute form is NOT a security relaxation: the owning-user
 * prefix check below is what scopes an avatar to its user, and it applies to
 * both forms because each is reduced to a key FIRST.
 */
export function isOwnAvatarRef(stored: string | null | undefined, userId: string): boolean {
  if (!stored) return false;
  const key = ownStoredAssetKey(stored);
  if (key === null) return false;
  // startsWith, never includes: the key's tail is a user-supplied FILENAME, so
  // a containment check would let `avatars/<b>/x-avatars-<a>-y.png` read as A's.
  return key.startsWith(avatarBlobPrefix(userId));
}

/**
 * The per-PROJECT image prefix a project-image upload writes under (MOTIR-2676)
 * — `projects/<projectId>/…`. The TENANT-mark analogue of `avatarBlobPrefix`
 * above: a project image is project substrate, so it is keyed by the owning
 * PROJECT, not a user or a workspace. The project-image UPLOAD route writes the
 * blob here; `projectsService.updateDetails` accepts an `image` only if it lands
 * here for THAT project.
 *
 * Keyed by the project's internal id rather than its identifier ON PURPOSE: a
 * project's KEY is changeable (`changeKey`, with alias rows behind it), so a
 * key-derived prefix would strand every previously-stored object the moment a
 * project is renamed — the stored ref would stop matching its own gate.
 */
export function projectImagePrefix(projectId: string): string {
  return `projects/${projectId}/`;
}

/**
 * True iff `stored` refers to one of OUR public-bucket uploads under THIS
 * project's own image prefix. The project-mark twin of {@link isOwnAvatarRef},
 * and used for the same two jobs: (a) GATE an `image` update to a real
 * own-project reference, so project A can never point its mark at project B's
 * blob, and (b) decide whether a REPLACED/removed prior `image` is ours to
 * delete. Anything else returns false (never throws).
 *
 * It takes a STORED REFERENCE, not a URL — the same two accepted forms as the
 * avatar gate (a bare KEY, or an absolute URL on the configured public base),
 * because both run through `ownStoredAssetKey` FIRST. That shared reduction is
 * what rejects a `javascript:` value, a leading slash and a `..` segment before
 * the prefix check ever reads the string.
 *
 * Unlike `User.image` there is no foreign-provider arm to tolerate: nothing
 * writes a project image except our own upload route, so a value that is not
 * ours is simply refused.
 */
export function isOwnProjectImageRef(
  stored: string | null | undefined,
  projectId: string,
): boolean {
  if (!stored) return false;
  const key = ownStoredAssetKey(stored);
  if (key === null) return false;
  // startsWith, never includes — same reason as the avatar gate above: the key's
  // tail is a user-supplied FILENAME, so a containment check would let
  // `projects/<b>/x-projects-<a>-y.png` read as A's.
  return key.startsWith(projectImagePrefix(projectId));
}

/**
 * A stored public-asset reference → the ABSOLUTE URL a browser fetches it from.
 * The resolution half of MOTIR-2404, and the reason storing a key costs no
 * external contract: every DTO that carries a user image runs its stored value
 * through this, so every consumer keeps receiving an absolute URL exactly as it
 * did when the column held one.
 *
 * An ABSOLUTE input is returned UNCHANGED, and that arm is load-bearing rather
 * than defensive: `User.image` is permanently polymorphic because better-auth's
 * Google provider writes a `googleusercontent.com` URL at signup through an
 * adapter this repo does not own. Since a foreign absolute URL must work
 * forever, a legacy own-avatar URL works for free — which is what let the
 * storage change ship against live rows with no migration and no dual-read.
 *
 * A RELATIVE input is a key and is resolved against the configured public base.
 * With no base configured the key is returned as-is rather than throwing: this
 * runs inside DTO mappers on every read path, and an unconfigured store must
 * degrade to a broken image, never to a 500 on the board.
 */
export function storedAssetUrl(stored: string): string;
export function storedAssetUrl(stored: null | undefined): null;
export function storedAssetUrl(stored: string | null | undefined): string | null;
export function storedAssetUrl(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (isAbsoluteRef(stored)) return stored;
  const base = process.env['MOTIR_S3_PUBLIC_BASE_URL'];
  if (!base) return stored;
  return `${base.replace(/\/+$/, '')}/${stored.replace(/^\/+/, '')}`;
}

/**
 * A stored public-asset reference → the object KEY, or null when it is not ours.
 * What the avatar GC deletes by. The counterpart to {@link storedAssetUrl}: that
 * one is for showing a value, this one is for acting on the object behind it.
 *
 * The two are deliberately NOT symmetric on an absolute value: `storedAssetUrl`
 * passes ANY absolute reference through (it must — a Google avatar has to keep
 * rendering), while this one recognises only the configured public origin. A
 * foreign URL is therefore displayable and not collectable, which is the correct
 * pair of answers for an object we do not own.
 */
export function storedAssetKey(stored: string | null | undefined): string | null {
  if (!stored) return null;
  return ownStoredAssetKey(stored);
}

/**
 * Does this stored value carry a URI scheme? The discriminator between the two
 * storage forms, and it is `new URL` rather than a regex on purpose: a key is
 * always `avatars/<id>/<file>`, so the `/` precedes any `:` in it and the parse
 * fails, while anything with a real scheme parses. Getting this wrong in the
 * permissive direction is what would let `javascript:…` reach an `<img src>`,
 * which is why the gate below re-checks for `https:` rather than trusting this.
 */
function isAbsoluteRef(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** The shared reduction both public entry points above are built from. */
function ownStoredAssetKey(stored: string): string | null {
  if (isAbsoluteRef(stored)) {
    let parsed: URL;
    try {
      parsed = new URL(stored);
    } catch {
      return null;
    }
    // https only — a `javascript:`/`data:` value parses perfectly well, and this
    // is the line that stops one being stored and later rendered.
    if (parsed.protocol !== 'https:') return null;
    return ownPublicAssetKey(stored);
  }
  // A bare key. Reject anything that could escape its own prefix before the
  // owning-user check reads it: a leading slash or a `..` segment would make
  // `startsWith(avatars/<me>/)` true for a path that does not resolve there.
  if (stored.startsWith('/')) return null;
  if (stored.split('/').includes('..')) return null;
  return stored;
}

/**
 * An ABSOLUTE public-asset URL → its object KEY, or null when it is not one of
 * ours. The shared derivation behind the avatar GATE, the avatar GC and the
 * display resolver above, so none of the three can disagree about what a stored
 * value means. It is {@link publicUrlToKey} with the CONFIGURED base.
 *
 * It lives HERE rather than beside the S3 client so this module stays
 * dependency-free — it is the pure string half of the blob seam, safe to pull
 * into any bundle. (That is also why the resolver above reads
 * `MOTIR_S3_PUBLIC_BASE_URL` from the environment directly rather than calling
 * `publicBaseUrl()`: importing `lib/blob/s3.ts` would drag the AWS SDK into
 * every bundle that maps a user DTO.)
 */
function ownPublicAssetKey(url: string): string | null {
  const configured = process.env['MOTIR_S3_PUBLIC_BASE_URL'];
  if (!configured) return null;
  return publicUrlToKey(url, configured);
}

/**
 * An ABSOLUTE URL on `base` → the object KEY it names, or null when it is not
 * one (MOTIR-10075). Pure: the base is an ARGUMENT, so a caller that must reduce
 * against a base other than the configured one — the cutover's stored-reference
 * rewrite, run while `MOTIR_S3_PUBLIC_BASE_URL` may already name S3, reducing
 * Tigris URLs — uses exactly the reduction the product does, and the two can
 * never disagree about which key a URL names.
 *
 * - **https only** — a `javascript:`/`data:` value parses perfectly well.
 * - **On `base` only** — the URL must start with `<base>/`.
 * - **Path-style aware** — a path-style endpoint puts the BUCKET in the path
 *   (`https://host/motir-public/avatars/…`), so the base's own path is stripped
 *   before the key is returned; otherwise the bucket segment would defeat the
 *   prefix checks above.
 * - **No escape** — a decoded key with a `..` segment or a leading slash is
 *   refused, the same rule the bare-key branch applies. `new URL` normalises a
 *   literal `..` away, but a percent-encoded one (`%2e%2e`) survives into the
 *   decoded path.
 */
export function publicUrlToKey(url: string, base: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;

  const trimmedBase = base.replace(/\/+$/, '');
  if (!url.startsWith(`${trimmedBase}/`)) return null;

  let path: string;
  let basePath: string;
  try {
    path = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    basePath = decodeURIComponent(new URL(trimmedBase).pathname).replace(/^\/+|\/+$/g, '');
  } catch {
    return null;
  }

  let key = path;
  if (basePath) {
    if (!path.startsWith(`${basePath}/`)) return null;
    key = path.slice(basePath.length + 1);
  }
  if (!key || key.startsWith('/') || key.split('/').includes('..')) return null;
  return key;
}
