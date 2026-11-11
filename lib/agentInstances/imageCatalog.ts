import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { listImageTags, probeImagePull } from '@motir/orchestrator';
import { selectedOrchestratorProvider } from '@/lib/orchestrator';
import { sandboxImageTag, SANDBOX_IMAGE_REPOSITORY } from './profiles';

// THE PUBLISHED-IMAGE CATALOG (Story MOTIR-6862 · MOTIR-6949,
// `docs/decisions/agent-image-update.md` Q1). For each offered profile: which
// published image is NEWEST, and what VERSION any digest an agent is pinned to
// carries. Read from the registry ANONYMOUSLY, the same way an agent's digest
// was resolved at create (`imageDigest.ts`).
//
// THE RULE (Q1):
// - NEWEST is the digest the moving `:<profile>` tag resolves to — exactly what
//   Create boots today, so Create and Update always agree.
// - Its VERSION is the `x.y.z` of the immutable `<profile>-x.y.z` tag with the
//   same digest. A moving tag no versioned tag shares is a publishing defect: no
//   update is offered on it, and the answer is `unknown`, never "up to date".
// - A DOWNGRADE is never offered: an update exists only when the newest version
//   is semver-greater than the agent's (or the agent's version cannot be named
//   and its digest differs).
//
// THE CACHE (Q1): the tag list and the moving tag's digest are reused for ten
// minutes per profile; an immutable tag's digest for the life of the process,
// because it never changes. A registry that cannot be read answers `unknown`.
//
// On the FAKE fleet (every test suite, the E2E lane) no registry is asked: the
// moving tag's stand-in digest is `imageDigest.ts`'s, named `FAKE_BASE_VERSION`,
// and a test sets a newer release through {@link imageCatalogSeam}.

/** One published release of a profile's image. */
export interface PublishedImage {
  readonly version: string;
  readonly digest: string;
}

/** `unknown` = the registry could not be asked, or its answer could not be trusted. */
export type CatalogUnknown = 'unknown';

/** How long a profile's tag list and moving digest are reused (Q1). */
export const IMAGE_CATALOG_TTL_MS = 10 * 60 * 1000;

/** The version the fake fleet names the stand-in digest every fake agent is created on. */
export const FAKE_BASE_VERSION = '1.0.0';

const VERSIONED = (profileId: string) =>
  new RegExp(`^${profileId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.(\\d+)\\.(\\d+)$`);

/** Compare two `x.y.z` versions: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The registry the catalog reads — a seam, so a test can count and stub it. */
export interface ImageRegistry {
  /** Every tag of the repository, or null when it could not be read. */
  listTags(repository: string): Promise<string[] | null>;
  /** The digest a reference resolves to, or null when it could not be resolved. */
  resolveDigest(reference: string): Promise<string | null>;
}

const liveRegistry: ImageRegistry = {
  async listTags(repository) {
    const listing = await listImageTags(repository);
    return listing.ok ? [...listing.tags] : null;
  },
  async resolveDigest(reference) {
    const verdict = await probeImagePull(reference);
    return verdict.pullable === true && verdict.digest ? verdict.digest : null;
  },
};

interface ProfileEntry {
  readonly expiresAt: number;
  /** null = the registry could not be read in this window. */
  readonly snapshot: { movingDigest: string; versions: string[] } | null;
}

let registry: ImageRegistry = liveRegistry;
let clock: () => number = () => Date.now();
const profileCache = new Map<string, ProfileEntry>();
const inflight = new Map<string, Promise<ProfileEntry>>();
/** Immutable tag → digest; never expires (an immutable tag never moves). */
const digestByTag = new Map<string, string>();
const inflightTags = new Map<string, Promise<string | null>>();
/** On the fake fleet: answer `unknown`, as a registry that cannot be read does (a test seam). */
let fakeUnavailable = false;
/** The fake fleet's newest version per profile, set by a test. */
const fakeNewest = new Map<string, string>();

/**
 * The fake fleet's newest version for a profile: the in-process seam first, then
 * `MOTIR_FAKE_IMAGE_NEWEST` (`{"claude":"1.1.0"}`) — how a lane whose web server
 * is a separate process (the E2E lane) arranges a newer release.
 */
function fakeNewestVersion(profileId: string): string | null {
  const set = fakeNewest.get(profileId);
  if (set) return set;
  const shared = readSharedCatalog()?.newest?.[profileId];
  if (typeof shared === 'string') return shared;
  const raw = process.env['MOTIR_FAKE_IMAGE_NEWEST'];
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const value =
      parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[profileId] : null;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * THE CROSS-PROCESS SEAM (MOTIR-6955): `MOTIR_FAKE_IMAGE_CATALOG_PATH` names a
 * JSON file — `{ "newest": { "claude": "0.6.0" }, "unavailable": false }` — read
 * on every call, so an E2E spec (a separate process) changes what the lane's web
 * server answers MID-TEST, as the fake fleet's own state file does.
 */
function readSharedCatalog(): {
  newest?: Record<string, unknown>;
  unavailable?: unknown;
} | null {
  const path = process.env['MOTIR_FAKE_IMAGE_CATALOG_PATH'];
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, never>) : null;
  } catch {
    return null;
  }
}

function fakeIsUnavailable(): boolean {
  return fakeUnavailable || readSharedCatalog()?.unavailable === true;
}

function isFake(): boolean {
  return selectedOrchestratorProvider() === 'fake';
}

/** The fake fleet's stand-in digest for a profile at a version — `imageDigest.ts`'s at the base. */
export function fakeDigestFor(profileId: string, version: string): string {
  const tag = sandboxImageTag(profileId);
  const source = version === FAKE_BASE_VERSION ? tag : `${tag}-${version}`;
  return `sha256:${createHash('sha256').update(source).digest('hex')}`;
}

async function readProfile(profileId: string): Promise<ProfileEntry> {
  const [tags, movingDigest] = await Promise.all([
    registry.listTags(SANDBOX_IMAGE_REPOSITORY),
    registry.resolveDigest(sandboxImageTag(profileId)),
  ]);
  const expiresAt = clock() + IMAGE_CATALOG_TTL_MS;
  if (!tags || !movingDigest) return { expiresAt, snapshot: null };
  const pattern = VERSIONED(profileId);
  const versions = tags
    .map((tag) => pattern.exec(tag))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `${m[1]}.${m[2]}.${m[3]}`)
    .sort((a, b) => compareVersions(b, a));
  return { expiresAt, snapshot: { movingDigest, versions } };
}

async function profileEntry(profileId: string, fresh: boolean): Promise<ProfileEntry> {
  const cached = profileCache.get(profileId);
  if (!fresh && cached && cached.expiresAt > clock()) return cached;
  const pending = inflight.get(profileId);
  if (!fresh && pending) return pending;
  const read = readProfile(profileId)
    .then((entry) => {
      profileCache.set(profileId, entry);
      return entry;
    })
    .finally(() => inflight.delete(profileId));
  inflight.set(profileId, read);
  return read;
}

async function digestOfVersion(profileId: string, version: string): Promise<string | null> {
  const tag = `${sandboxImageTag(profileId)}-${version}`;
  const known = digestByTag.get(tag);
  if (known) return known;
  const pending = inflightTags.get(tag);
  if (pending) return pending;
  const read = registry
    .resolveDigest(tag)
    .then((digest) => {
      if (digest) digestByTag.set(tag, digest);
      return digest;
    })
    .finally(() => inflightTags.delete(tag));
  inflightTags.set(tag, read);
  return read;
}

export const imageCatalog = {
  /**
   * The newest published image for a profile (Q1), or `unknown`. `fresh`
   * bypasses the cache — pressing Update pins what is newest AT the press.
   */
  async newestFor(
    profileId: string,
    options: { fresh?: boolean } = {},
  ): Promise<PublishedImage | CatalogUnknown> {
    if (isFake()) {
      if (fakeIsUnavailable()) return 'unknown';
      const version = fakeNewestVersion(profileId) ?? FAKE_BASE_VERSION;
      return { version, digest: fakeDigestFor(profileId, version) };
    }
    const entry = await profileEntry(profileId, options.fresh === true);
    if (!entry.snapshot) return 'unknown';
    for (const version of entry.snapshot.versions) {
      const digest = await digestOfVersion(profileId, version);
      if (digest === entry.snapshot.movingDigest) return { version, digest };
    }
    console.warn('[imageCatalog] the moving tag names a digest no versioned tag shares', {
      profileId,
      digest: entry.snapshot.movingDigest,
    });
    return 'unknown';
  },

  /** The version a digest carries for a profile, null when no tag names it, or `unknown`. */
  async versionOf(profileId: string, digest: string): Promise<string | null | CatalogUnknown> {
    if (isFake()) {
      if (fakeIsUnavailable()) return 'unknown';
      if (digest === fakeDigestFor(profileId, FAKE_BASE_VERSION)) return FAKE_BASE_VERSION;
      const newest = fakeNewestVersion(profileId);
      return newest && digest === fakeDigestFor(profileId, newest) ? newest : null;
    }
    const entry = await profileEntry(profileId, false);
    if (!entry.snapshot) return 'unknown';
    for (const version of entry.snapshot.versions) {
      if ((await digestOfVersion(profileId, version)) === digest) return version;
    }
    return null;
  },

  /**
   * What an agent on `digest` is offered (Q1): the newest image when it is
   * semver-newer than the agent's own version — or, when the agent's version
   * cannot be named, when its digest differs — else null; `unknown` when the
   * registry could not answer. Never a downgrade.
   */
  async updateFor(
    profileId: string,
    digest: string,
  ): Promise<{ imageVersion: string | null; update: PublishedImage | null | CatalogUnknown }> {
    const [newest, version] = await Promise.all([
      this.newestFor(profileId),
      this.versionOf(profileId, digest),
    ]);
    const imageVersion = version === 'unknown' ? null : version;
    if (newest === 'unknown' || version === 'unknown') return { imageVersion, update: 'unknown' };
    if (newest.digest === digest) return { imageVersion, update: null };
    if (version === null) return { imageVersion, update: newest };
    return {
      imageVersion,
      update: compareVersions(newest.version, version) > 0 ? newest : null,
    };
  },
};

/**
 * The registry this catalog reads — the live GHCR client, or the one a test set
 * through {@link imageCatalogSeam}. The Fleet status page (MOTIR-10886) asks it
 * which `<profile>-<version>` tags the sandbox repository holds, so the page and
 * the catalog read the same registry the same way.
 */
export function catalogRegistry(): ImageRegistry {
  return registry;
}

/** Test seam: the registry, the clock, the fake fleet's newest version, and a reset. */
export const imageCatalogSeam = {
  setRegistry(next: ImageRegistry | null): void {
    registry = next ?? liveRegistry;
  },
  setClock(next: (() => number) | null): void {
    clock = next ?? (() => Date.now());
  },
  /** On the fake fleet: make `version` the newest published release of `profileId`. */
  setFakeNewest(profileId: string, version: string | null): void {
    if (version === null) fakeNewest.delete(profileId);
    else fakeNewest.set(profileId, version);
  },
  /** On the fake fleet: make the catalog answer as an unreachable registry does. */
  setFakeUnavailable(value: boolean): void {
    fakeUnavailable = value;
  },
  reset(): void {
    fakeUnavailable = false;
    registry = liveRegistry;
    clock = () => Date.now();
    profileCache.clear();
    inflight.clear();
    digestByTag.clear();
    inflightTags.clear();
    fakeNewest.clear();
  },
};
