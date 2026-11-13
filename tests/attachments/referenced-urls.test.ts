import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachmentContentPath,
  avatarBlobPrefix,
  extractReferencedAttachmentIds,
  extractReferencedAttachmentIdsFromBodies,
  isOwnAvatarRef,
  isOwnProjectImageRef,
  projectImagePrefix,
  publicUrlToKey,
  storedAssetKey,
  storedAssetUrl,
} from '@/lib/blob/referencedUrls';

// Pure-parser tests for the link-on-write ID extractor (Subtask 5.2.3; id-based
// since MOTIR-1668). No DB: string work only; the DB half (workspace-scoped
// linking) is tests/attachments/link-on-write.test.ts. Content attachments are
// PRIVATE and embed as their authenticated content path
// `/api/attachments/<id>/content` — tenancy is enforced at the DB, not here, so
// a foreign id would extract but can never link.

const cp = (id: string) => attachmentContentPath(id);

describe('extractReferencedAttachmentIds', () => {
  it('extracts image embeds, file links, and bare pastes of content paths', () => {
    const a = 'aaa111';
    const b = 'bbb222';
    const c = 'ccc333';
    const body = `Intro ![shot](${cp(a)}) then [the spec](${cp(b)}) and bare ${cp(c)} end.`;
    expect(extractReferencedAttachmentIds(body)).toEqual([a, b, c]);
  });

  it('dedupes repeated references in first-seen order', () => {
    const a = 'onea11';
    const b = 'twob22';
    const body = `![x](${cp(a)}) ![y](${cp(b)}) again ![z](${cp(a)})`;
    expect(extractReferencedAttachmentIds(body)).toEqual([a, b]);
  });

  it('ignores non-content attachment paths and other app routes', () => {
    const body =
      `[thumb](/api/attachments/xyz789/thumbnail) ` +
      `[item](/api/work-items/wi12345/content) ` +
      `[plain](https://example.com/pic.png)`;
    expect(extractReferencedAttachmentIds(body)).toEqual([]);
  });

  it('null / undefined / empty / path-free bodies extract to []', () => {
    expect(extractReferencedAttachmentIds(null)).toEqual([]);
    expect(extractReferencedAttachmentIds(undefined)).toEqual([]);
    expect(extractReferencedAttachmentIds('')).toEqual([]);
    expect(extractReferencedAttachmentIds('plain prose, no links')).toEqual([]);
  });
});

describe('extractReferencedAttachmentIdsFromBodies', () => {
  it('merges several bodies, deduped in first-seen order, skipping null bodies', () => {
    const a = 'a11aaa';
    const b = 'b22bbb';
    expect(
      extractReferencedAttachmentIdsFromBodies([
        `![x](${cp(a)})`,
        null,
        `![y](${cp(b)}) ![x](${cp(a)})`,
      ]),
    ).toEqual([a, b]);
  });
});

// ── The stored-reference seam (MOTIR-2404) ───────────────────────────────────
// `User.image` holds the object KEY for our own avatars and an absolute URL for
// a provider avatar. Both must round-trip: resolve for display, reduce to a key
// for the GC, and be gated to their owning user. These are the three functions
// that must agree about what a stored value MEANS.
//
// MOTIR-2393 removed a third form — an absolute URL on the retired Vercel public
// host, which `storedAssetKey`/`isOwnAvatarRef` used to recognise as ours. It is
// now indistinguishable from any other foreign absolute URL: it still DISPLAYS
// (the passthrough arm below), and it is no longer collectable or gate-passing.

const PUBLIC_BASE = 'https://s3.test.invalid/motir-public';
const GOOGLE = 'https://lh3.googleusercontent.com/a/abc123';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('storedAssetUrl — a stored reference becomes something a browser can fetch', () => {
  it('resolves a bare KEY against the configured public base', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    expect(storedAssetUrl('avatars/u1/me.png')).toBe(`${PUBLIC_BASE}/avatars/u1/me.png`);
  });

  it('returns an ABSOLUTE value unchanged, whoever owns it', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    // A provider avatar is a URL this repo does not own and can never re-derive,
    // so display resolution has to be a passthrough for anything absolute.
    expect(storedAssetUrl(GOOGLE)).toBe(GOOGLE);
    // ...and it is not double-prefixed by the configured base.
    expect(storedAssetUrl(`${PUBLIC_BASE}/avatars/u1/x.png`)).toBe(
      `${PUBLIC_BASE}/avatars/u1/x.png`,
    );
  });

  it('passes null/empty through rather than inventing a URL', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    expect(storedAssetUrl(null)).toBeNull();
    expect(storedAssetUrl(undefined)).toBeNull();
    expect(storedAssetUrl('')).toBeNull();
  });

  it('degrades to the raw key when the store is unconfigured, never throws', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', '');
    // This runs inside DTO mappers on every read path, so an unconfigured store
    // must cost a broken image, not a 500 on the board.
    expect(() => storedAssetUrl('avatars/u1/me.png')).not.toThrow();
    expect(storedAssetUrl('avatars/u1/me.png')).toBe('avatars/u1/me.png');
  });

  it('joins without doubling or dropping a slash', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', `${PUBLIC_BASE}/`);
    expect(storedAssetUrl('avatars/u1/me.png')).toBe(`${PUBLIC_BASE}/avatars/u1/me.png`);
  });
});

describe('storedAssetKey — the object the GC acts on', () => {
  it('reduces both of OUR forms to the same key', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    const key = 'avatars/u1/me.png';
    expect(storedAssetKey(key)).toBe(key);
    expect(storedAssetKey(`${PUBLIC_BASE}/${key}`)).toBe(key);
  });

  it('yields null for anything that is not ours — any other ORIGIN included', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    expect(storedAssetKey(GOOGLE)).toBeNull();
    // The configured origin is the ONLY absolute form we claim (MOTIR-2393
    // dropped the retired platform's host): a same-shaped path on a different
    // host is somebody else's object, so the GC must not act on it.
    expect(storedAssetKey('https://other.test.invalid/avatars/u1/me.png')).toBeNull();
    expect(storedAssetKey(null)).toBeNull();
    expect(storedAssetKey('')).toBeNull();
  });
});

describe('isOwnAvatarRef — the gate, in both storage forms', () => {
  it('accepts the caller’s own key and own absolute URL', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    expect(isOwnAvatarRef(`${avatarBlobPrefix('u1')}me.png`, 'u1')).toBe(true);
    expect(isOwnAvatarRef(`${PUBLIC_BASE}/avatars/u1/me.png`, 'u1')).toBe(true);
  });

  it('rejects another user’s object in either form', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    expect(isOwnAvatarRef('avatars/u2/me.png', 'u1')).toBe(false);
    expect(isOwnAvatarRef(`${PUBLIC_BASE}/avatars/u2/me.png`, 'u1')).toBe(false);
  });

  it('rejects a filename that merely CONTAINS the caller’s prefix', () => {
    // The reason the check is startsWith and never includes: the key's tail is
    // a user-supplied filename.
    expect(isOwnAvatarRef('avatars/u2/x-avatars-u1-y.png', 'u1')).toBe(false);
  });

  it('rejects a relative value that escapes its own prefix', () => {
    expect(isOwnAvatarRef('avatars/u1/../u2/me.png', 'u1')).toBe(false);
    expect(isOwnAvatarRef('/avatars/u1/me.png', 'u1')).toBe(false);
  });

  it('rejects a non-https scheme that would otherwise reach an <img src>', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    // `javascript:`/`data:` parse perfectly well as URLs — the protocol check is
    // what stops one being stored and later rendered.
    expect(isOwnAvatarRef('javascript:alert(1)//avatars/u1/x.png', 'u1')).toBe(false);
    expect(isOwnAvatarRef('data:image/png;base64,AAAA', 'u1')).toBe(false);
    // The SCHEME is what fails here, not the host: this is the configured public
    // origin, own prefix and all, downgraded to http.
    expect(isOwnAvatarRef('http://s3.test.invalid/motir-public/avatars/u1/x.png', 'u1')).toBe(
      false,
    );
  });

  it('rejects a foreign provider URL and empty input', () => {
    expect(isOwnAvatarRef(GOOGLE, 'u1')).toBe(false);
    expect(isOwnAvatarRef(null, 'u1')).toBe(false);
    expect(isOwnAvatarRef(undefined, 'u1')).toBe(false);
    expect(isOwnAvatarRef('', 'u1')).toBe(false);
  });
});

// ── The PROJECT-image gate (MOTIR-2676) ─────────────────────────────────────
// The tenant-mark twin of `isOwnAvatarRef` above. Same shared reduction
// (`ownStoredAssetKey`), so the hardening cases below are not duplicated
// paranoia — they are the SAME code path re-asserted at the seam a project
// image actually enters through, which is the one that decides whether project
// A can point its mark at project B's blob.
describe('isOwnProjectImageRef — the project-mark gate, in both storage forms', () => {
  it('accepts our own object under THIS project, as a bare key and as an absolute URL', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    expect(isOwnProjectImageRef(`${projectImagePrefix('p1')}logo.png`, 'p1')).toBe(true);
    expect(isOwnProjectImageRef(`${PUBLIC_BASE}/projects/p1/logo.png`, 'p1')).toBe(true);
  });

  it('rejects ANOTHER project\u2019s object, in both forms', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    expect(isOwnProjectImageRef('projects/p2/logo.png', 'p1')).toBe(false);
    expect(isOwnProjectImageRef(`${PUBLIC_BASE}/projects/p2/logo.png`, 'p1')).toBe(false);
  });

  // The reason the gate is `startsWith` and not `includes`: the key's tail is a
  // user-supplied FILENAME, so a containment check would let this read as p1's.
  it('rejects a crafted FILENAME that contains this project\u2019s prefix', () => {
    expect(isOwnProjectImageRef('projects/p2/x-projects-p1-y.png', 'p1')).toBe(false);
  });

  it('rejects a traversal or an absolute path that could escape the prefix', () => {
    expect(isOwnProjectImageRef('projects/p1/../p2/logo.png', 'p1')).toBe(false);
    expect(isOwnProjectImageRef('/projects/p1/logo.png', 'p1')).toBe(false);
  });

  it('rejects a non-https scheme that would otherwise reach an <img src>', () => {
    expect(isOwnProjectImageRef('javascript:alert(1)//projects/p1/x.png', 'p1')).toBe(false);
    expect(isOwnProjectImageRef('data:image/png;base64,AAAA', 'p1')).toBe(false);
  });

  it('rejects a foreign absolute URL and empty input', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    expect(isOwnProjectImageRef(GOOGLE, 'p1')).toBe(false);
    expect(
      isOwnProjectImageRef('http://s3.test.invalid/motir-public/projects/p1/x.png', 'p1'),
    ).toBe(false);
    expect(isOwnProjectImageRef(null, 'p1')).toBe(false);
    expect(isOwnProjectImageRef(undefined, 'p1')).toBe(false);
    expect(isOwnProjectImageRef('', 'p1')).toBe(false);
  });

  // A project's KEY changes (`changeKey`); its id does not. Prefixing by id is
  // what stops a rename stranding every previously-stored object.
  it('keys the prefix by the project ID, so it survives a key change', () => {
    expect(projectImagePrefix('cmsn5vkyf01qoi2phmjopsmyu')).toBe(
      'projects/cmsn5vkyf01qoi2phmjopsmyu/',
    );
  });
});

// MOTIR-10075: the reduction lifted out of `ownPublicAssetKey`, with the base as an
// argument, so the cutover's stored-reference rewrite reduces the previous store's
// URLs exactly as the product does even after `MOTIR_S3_PUBLIC_BASE_URL` names S3.
describe('publicUrlToKey — an absolute URL on a given base becomes its key', () => {
  const VIRTUAL_HOST = 'https://motir-core-public.previous-store.test';

  it('reduces a URL on a virtual-host base to its path', () => {
    expect(publicUrlToKey(`${VIRTUAL_HOST}/avatars/u1/me.png`, VIRTUAL_HOST)).toBe(
      'avatars/u1/me.png',
    );
    // A trailing slash on the base is the same base.
    expect(publicUrlToKey(`${VIRTUAL_HOST}/projects/p1/mark.png`, `${VIRTUAL_HOST}/`)).toBe(
      'projects/p1/mark.png',
    );
  });

  it("strips a path-style base's bucket segment", () => {
    expect(publicUrlToKey(`${PUBLIC_BASE}/avatars/u1/me.png`, PUBLIC_BASE)).toBe(
      'avatars/u1/me.png',
    );
  });

  it('agrees with storedAssetKey under the configured base', () => {
    for (const base of [PUBLIC_BASE, VIRTUAL_HOST]) {
      vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', base);
      const url = `${base}/avatars/u1/a%20b.png`;
      expect(publicUrlToKey(url, base)).toBe(storedAssetKey(url));
      expect(publicUrlToKey(url, base)).toBe('avatars/u1/a b.png');
    }
  });

  it("refuses a URL on another host, or outside the base's path", () => {
    expect(publicUrlToKey(GOOGLE, VIRTUAL_HOST)).toBeNull();
    expect(
      publicUrlToKey('https://s3.test.invalid/other-bucket/avatars/u1/me.png', PUBLIC_BASE),
    ).toBeNull();
    // A host that merely STARTS with the base's host is not the base.
    expect(publicUrlToKey(`${VIRTUAL_HOST}.evil.test/avatars/u1/me.png`, VIRTUAL_HOST)).toBeNull();
  });

  it('refuses a `..` segment that survives decoding, and an empty or slash-led key', () => {
    // `new URL` normalises a literal or `%2e%2e` segment away; one between ENCODED
    // slashes is not a segment to the parser and survives into the decoded key.
    expect(publicUrlToKey(`${VIRTUAL_HOST}/avatars/u1%2F..%2Fu2/me.png`, VIRTUAL_HOST)).toBeNull();
    // On a path-style base an encoded slash after the bucket leaves a slash-led key.
    expect(publicUrlToKey(`${PUBLIC_BASE}/%2Favatars/u1/me.png`, PUBLIC_BASE)).toBeNull();
    expect(publicUrlToKey(`${VIRTUAL_HOST}/`, VIRTUAL_HOST)).toBeNull();
    expect(publicUrlToKey(`${PUBLIC_BASE}/`, PUBLIC_BASE)).toBeNull();
  });

  it('refuses a non-https URL, a malformed one, and a malformed base', () => {
    expect(
      publicUrlToKey(
        'http://motir-core-public.previous-store.test/avatars/u1/me.png',
        'http://motir-core-public.previous-store.test',
      ),
    ).toBeNull();
    expect(publicUrlToKey('javascript:alert(1)//avatars/u1', 'javascript:alert(1)/')).toBeNull();
    expect(publicUrlToKey('avatars/u1/me.png', VIRTUAL_HOST)).toBeNull();
    expect(publicUrlToKey(`${VIRTUAL_HOST}/avatars/%E0%A4%A.png`, VIRTUAL_HOST)).toBeNull();
    expect(publicUrlToKey('https://x.test/avatars/u1/me.png', 'https://x.test')).toBe(
      'avatars/u1/me.png',
    );
    expect(publicUrlToKey('https://x.test/avatars/u1/me.png', 'not a url')).toBeNull();
  });
});
