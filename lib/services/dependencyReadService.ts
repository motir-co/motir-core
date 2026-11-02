import { gunzipSync } from 'node:zlib';

// The DEPENDENCY read (MOTIR-10242) — what a package offers at a given version:
// its published versions, and the text of one file (or one directory's entries)
// of its published source. The hosted planner reads it through
// `app/api/internal/ai/dependency-{versions,source}` and an agent on the MCP
// through `list_dependency_versions` / `read_dependency_source`, so both planners
// see the same evidence.
//
// ⚠️ MOTIR-CORE PERFORMS THE READ, AND EVERYTHING ABOUT IT IS FIXED IN CODE:
//   - the HOST is the public npm registry — a caller names a package, never a
//     URL, and the tarball URL is BUILT here from the validated name and an exact
//     version from the registry's own list, never taken from the registry's
//     answer; redirects are refused, so no response can point the fetch elsewhere;
//   - the name is validated BEFORE any request, so a name holding a URL, `:`,
//     `..` or an extra `/` is `invalid_package` and nothing is fetched;
//   - every fetch has a TIME limit and a BYTE cap, and the archive is unpacked IN
//     MEMORY under a second cap: nothing is written to disk and no package code is
//     run;
//   - symlink and hard-link entries are SKIPPED, and so is any entry whose path
//     escapes the package root.
//
// Every result names its `outcome`, as `read_file` does — the consumer is a model,
// and "that version does not exist" is an answer, not a failure. A registry that
// did not answer is `unreachable` with the failure kind: a failure to ASK, never
// evidence the package is absent. What the archive holds is THIRD-PARTY text:
// every result carries `framing: "data"`, and the renderers quote file text
// between markers under a sentence saying instructions in it are not to be
// followed.
//
// No tenant table is read and no project data enters a registry request; the
// scoping is the door (the job token on the routes, the project key and `ai:plan`
// on the MCP tools).

/** The ONE registry host this door ever requests. */
export const DEPENDENCY_REGISTRY_HOST = 'registry.npmjs.org';
/** The ecosystems this door reads; any other is the named `ecosystem_unsupported`. */
export const DEPENDENCY_ECOSYSTEMS = ['npm'] as const;
export type DependencyEcosystem = (typeof DEPENDENCY_ECOSYSTEMS)[number];

/** Per-request time limit. Two requests at most per read, inside the routes' 30 s budget. */
export const DEPENDENCY_FETCH_TIMEOUT_MS = 10_000;
/** Byte cap on the registry's (abbreviated) metadata document. */
export const DEPENDENCY_METADATA_MAX_BYTES = 16 * 1024 * 1024;
/** Byte cap on the downloaded (gzipped) tarball; over it the archive is not unpacked. */
export const DEPENDENCY_TARBALL_MAX_BYTES = 10 * 1024 * 1024;
/** Byte cap on the UNPACKED archive — a small tarball can inflate a great deal. */
export const DEPENDENCY_UNPACKED_MAX_BYTES = 64 * 1024 * 1024;
/** A whole-file read over this is `too_large`; a LINE-RANGE read is served past it. */
export const DEPENDENCY_SOURCE_FILE_MAX_BYTES = 1_000_000;
/** The most versions a list returns (newest last, as the registry lists them). */
export const DEPENDENCY_VERSIONS_MAX = 500;
/** The most entries a directory listing returns. */
export const DEPENDENCY_DIRECTORY_MAX_ENTRIES = 500;

const NAME_MAX = 214;
const VERSION_MAX = 256;
// npm's own name grammar: an optional `@scope/` and a name, URL-safe characters
// only. One `/` (after a scope) at most; `:` and whitespace never.
const NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

export type DependencyFetch = (url: string, init: RequestInit) => Promise<Response>;

export type DependencyUnreachableFailure =
  | 'timeout'
  | 'network'
  | 'http_status'
  | 'invalid_response'
  | 'invalid_archive';

interface Framed {
  framing: 'data';
}

interface PackageRef extends Framed {
  ecosystem: DependencyEcosystem;
  package: string;
}

interface VersionRef extends PackageRef {
  version: string;
  /** The dist-tag the asked version was resolved through (`latest`), or null for an exact version. */
  resolvedFrom: string | null;
}

export type DependencyVersionsResult =
  | (PackageRef & {
      outcome: 'versions';
      versions: string[];
      distTags: Record<string, string>;
      truncated: boolean;
      total: number;
    })
  | DependencyRequestRefusal
  | (PackageRef & { outcome: 'package_not_found' })
  | (PackageRef & { outcome: 'too_large'; what: 'metadata'; maxBytes: number })
  | DependencyUnreachable;

export interface DependencyDirectoryEntry {
  name: string;
  type: 'file' | 'dir';
  /** Bytes, for a file; null for a directory. */
  size: number | null;
}

export type DependencySourceResult =
  | (VersionRef & {
      outcome: 'source_file';
      path: string;
      bytes: number;
      text: string;
      lines: { from: number; to: number; total: number } | null;
    })
  | (VersionRef & {
      outcome: 'directory';
      path: string;
      entries: DependencyDirectoryEntry[];
      truncated: boolean;
    })
  | (VersionRef & { outcome: 'path_not_found'; path: string })
  | (VersionRef & { outcome: 'binary'; path: string; bytes: number })
  | (PackageRef & {
      outcome: 'too_large';
      what: 'metadata' | 'tarball' | 'archive' | 'file';
      maxBytes: number;
      version: string | null;
      path: string | null;
    })
  | (PackageRef & { outcome: 'version_not_found'; version: string; distTags: string[] })
  | (PackageRef & { outcome: 'package_not_found' })
  | (Framed & { outcome: 'invalid_path'; path: string; reason: string })
  | DependencyRequestRefusal
  | DependencyUnreachable;

export type DependencyRequestRefusal =
  | (Framed & { outcome: 'ecosystem_unsupported'; ecosystem: string; supported: string[] })
  | (Framed & { outcome: 'invalid_package'; package: string; reason: string });

export type DependencyUnreachable = PackageRef & {
  outcome: 'unreachable';
  failure: DependencyUnreachableFailure;
  /** The HTTP status, for `http_status`. */
  status: number | null;
};

const FRAMING = { framing: 'data' } as const;

/** Why a package name is refused, or null when it is a well-formed npm name. */
export function packageNameProblem(name: string): string | null {
  if (name.length === 0) return 'the package name is empty';
  if (name.length > NAME_MAX) return `a package name is at most ${NAME_MAX} characters`;
  if (name.includes('..')) return 'a package name may not contain ".."';
  if (!NAME_RE.test(name)) {
    return (
      'not an npm package name: an optional "@scope/" then a name of letters, digits and ' +
      '".", "_", "~", "-" — no URL, ":" or further "/"'
    );
  }
  return null;
}

/** The path normalized to the package root ('' is the root), or the reason it is refused. */
export function normalizeDependencyPath(
  raw: string | undefined,
): { ok: true; path: string } | { ok: false; reason: string } {
  const p = raw ?? '';
  if (p.includes('\u0000')) return { ok: false, reason: 'a path may not contain a NUL' };
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-z]:/i.test(p)) {
    return { ok: false, reason: 'the path must be relative to the package root' };
  }
  const segments = p.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) {
    return { ok: false, reason: 'a path may not contain ".."' };
  }
  return { ok: true, path: segments.join('/') };
}

function metadataUrl(name: string): string {
  return `https://${DEPENDENCY_REGISTRY_HOST}/${name.replace('/', '%2f')}`;
}

/** The tarball URL npm publishes at, BUILT here — never read from the registry's answer. */
export function tarballUrl(name: string, version: string): string {
  const base = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  return `https://${DEPENDENCY_REGISTRY_HOST}/${name}/-/${base}-${encodeURIComponent(version)}.tgz`;
}

type FetchFailureKind = DependencyUnreachableFailure | 'too_large';

/** A cancel that fails leaves nothing to do: the body is being dropped anyway. */
function ignoreCancelFailure(): undefined {
  return undefined;
}

/** Drop a body we will not read, so the connection is released. */
async function discard(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body) await body.cancel().catch(ignoreCancelFailure);
}

/** What one capped GET answered: the body, a 404, or the failure kind. */
type FetchOutcome =
  | { kind: 'body'; body: Buffer }
  | { kind: 'not_found' }
  | { kind: 'failed'; failure: FetchFailureKind; status: number | null };

const failed = (failure: FetchFailureKind, status: number | null = null): FetchOutcome => ({
  kind: 'failed',
  failure,
  status,
});

/** Read a body under a byte cap; past it the read is cancelled and `too_large` answered. */
async function readCapped(res: Response, maxBytes: number): Promise<FetchOutcome> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(res.body);
    return failed('too_large');
  }
  if (!res.body) return { kind: 'body', body: Buffer.alloc(0) };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(ignoreCancelFailure);
      return failed('too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return { kind: 'body', body: Buffer.concat(chunks) };
}

/**
 * One GET to the fixed host, time-limited and byte-capped. It never throws: a
 * request that could not be made, a non-2xx answer and a body that broke
 * mid-read are each a named failure.
 */
async function fetchCapped(
  doFetch: DependencyFetch,
  url: string,
  accept: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<FetchOutcome> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { accept },
      redirect: 'error',
      signal,
    });
    if (res.status === 404) {
      await discard(res.body);
      return { kind: 'not_found' };
    }
    if (!res.ok) {
      await discard(res.body);
      return failed('http_status', res.status);
    }
    return await readCapped(res, maxBytes);
  } catch (err) {
    return failed(isTimeout(err, signal) ? 'timeout' : 'network');
  }
}

function isTimeout(err: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
  );
}

interface PackageMetadata {
  versions: string[];
  distTags: Record<string, string>;
}

function parseMetadata(body: Buffer): PackageMetadata | null {
  let doc: unknown;
  try {
    doc = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const versions = (doc as { versions?: unknown }).versions;
  if (!versions || typeof versions !== 'object') return null;
  const tags = (doc as { 'dist-tags'?: unknown })['dist-tags'];
  const distTags: Record<string, string> = {};
  if (tags && typeof tags === 'object') {
    for (const [k, v] of Object.entries(tags)) if (typeof v === 'string') distTags[k] = v;
  }
  return { versions: Object.keys(versions), distTags };
}

interface ArchiveFile {
  type: 'file';
  data: Buffer;
}

/**
 * The FILES of a tar archive, in memory, keyed by their path under the package
 * root (the first path segment — `package/` in an npm tarball — is dropped).
 * Links and every other non-file entry are skipped, and so is any entry whose
 * path is absolute or climbs out with `..`. `null` for a malformed archive.
 * Handles ustar names (with `prefix`), pax `path` records and GNU long names.
 */
export function readTarFiles(tar: Buffer): Map<string, ArchiveFile> | null {
  const files = new Map<string, ArchiveFile>();
  let offset = 0;
  let nextName: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const sizeField = header.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim();
    if (!/^[0-7]*$/.test(sizeField)) return null;
    const size = sizeField === '' ? 0 : parseInt(sizeField, 8);
    const dataStart = offset + 512;
    if (dataStart + size > tar.length) return null;
    const data = tar.subarray(dataStart, dataStart + size);
    const type = String.fromCharCode(header[156]!);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'x') {
      const path = paxPath(data);
      if (path !== null) nextName = path;
      continue;
    }
    if (type === 'L') {
      nextName = data.toString('utf8').replace(/\0[\s\S]*$/, '');
      continue;
    }
    const name = nextName ?? ustarName(header);
    nextName = null;
    // Only regular files are kept: '0', the old '\0', and contiguous '7'. Links
    // ('1', '2'), directories ('5' — implied by the file paths) and devices are not.
    if (type !== '0' && type !== '\0' && type !== '7') continue;
    const under = underPackageRoot(name);
    if (under === null) continue;
    files.set(under, { type: 'file', data: Buffer.from(data) });
  }
  return files;
}

function ustarName(header: Buffer): string {
  const name = header
    .subarray(0, 100)
    .toString('utf8')
    .replace(/\0[\s\S]*$/, '');
  const magic = header.subarray(257, 262).toString('latin1');
  if (magic !== 'ustar') return name;
  const prefix = header
    .subarray(345, 500)
    .toString('utf8')
    .replace(/\0[\s\S]*$/, '');
  return prefix ? `${prefix}/${name}` : name;
}

function paxPath(data: Buffer): string | null {
  const text = data.toString('utf8');
  for (const record of text.split('\n')) {
    const m = /^\d+ path=([\s\S]*)$/.exec(record);
    if (m) return m[1]!;
  }
  return null;
}

function underPackageRoot(name: string): string | null {
  if (name.includes('\u0000') || name.startsWith('/') || name.includes('\\')) return null;
  const segments = name.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length < 2 || segments.some((s) => s === '..')) return null;
  return segments.slice(1).join('/');
}

/** The immediate entries of `dir` ('' is the root), directories first, then by name. */
function listDirectory(files: Map<string, ArchiveFile>, dir: string): DependencyDirectoryEntry[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = new Map<string, DependencyDirectoryEntry>();
  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) entries.set(rest, { name: rest, type: 'file', size: file.data.length });
    else {
      const name = rest.slice(0, slash);
      if (!entries.has(name)) entries.set(name, { name, type: 'dir', size: null });
    }
  }
  return [...entries.values()].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
  );
}

/** A 1-based inclusive line range, clamped to the text — `read_file`'s `sliceLines`. */
function sliceRange(
  text: string,
  range: { startLine?: number; endLine?: number },
): { text: string; lines: { from: number; to: number; total: number } } | null {
  if (range.startLine === undefined && range.endLine === undefined) return null;
  const all = text.split('\n');
  const total = all.length;
  const from = Math.max(1, Math.min(range.startLine ?? 1, total));
  const to = Math.max(from, Math.min(range.endLine ?? total, total));
  return { text: all.slice(from - 1, to).join('\n'), lines: { from, to, total } };
}

function refusal(
  ecosystem: string,
  packageName: string,
): DependencyRequestRefusal | { ecosystem: DependencyEcosystem } {
  if (!(DEPENDENCY_ECOSYSTEMS as readonly string[]).includes(ecosystem)) {
    return {
      ...FRAMING,
      outcome: 'ecosystem_unsupported',
      ecosystem,
      supported: [...DEPENDENCY_ECOSYSTEMS],
    };
  }
  const problem = packageNameProblem(packageName);
  if (problem)
    return { ...FRAMING, outcome: 'invalid_package', package: packageName, reason: problem };
  return { ecosystem: ecosystem as DependencyEcosystem };
}

export interface DependencyReadServiceOptions {
  /** The fetch every registry request goes through — injectable so tests never touch the network. */
  fetch?: DependencyFetch;
  timeoutMs?: number;
}

export function createDependencyReadService(options: DependencyReadServiceOptions = {}) {
  const doFetch: DependencyFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEPENDENCY_FETCH_TIMEOUT_MS;

  async function readMetadata(
    name: string,
  ): Promise<
    | PackageMetadata
    | null
    | { failure: DependencyUnreachableFailure | 'too_large'; status: number | null }
  > {
    const got = await fetchCapped(
      doFetch,
      metadataUrl(name),
      'application/vnd.npm.install-v1+json',
      DEPENDENCY_METADATA_MAX_BYTES,
      timeoutMs,
    );
    if (got.kind === 'not_found') return null;
    if (got.kind === 'failed') return { failure: got.failure, status: got.status };
    return parseMetadata(got.body) ?? { failure: 'invalid_response', status: null };
  }

  return {
    /** The package's published versions (as the registry lists them) and its dist-tags. */
    async listVersions(ecosystem: string, packageName: string): Promise<DependencyVersionsResult> {
      const checked = refusal(ecosystem, packageName);
      if ('outcome' in checked) return checked;
      const ref = { ...FRAMING, ecosystem: checked.ecosystem, package: packageName };
      const meta = await readMetadata(packageName);
      if (meta === null) return { ...ref, outcome: 'package_not_found' };
      if ('failure' in meta) {
        if (meta.failure === 'too_large') {
          return {
            ...ref,
            outcome: 'too_large',
            what: 'metadata',
            maxBytes: DEPENDENCY_METADATA_MAX_BYTES,
          };
        }
        return { ...ref, outcome: 'unreachable', failure: meta.failure, status: meta.status };
      }
      const total = meta.versions.length;
      const truncated = total > DEPENDENCY_VERSIONS_MAX;
      return {
        ...ref,
        outcome: 'versions',
        versions: truncated ? meta.versions.slice(total - DEPENDENCY_VERSIONS_MAX) : meta.versions,
        distTags: meta.distTags,
        truncated,
        total,
      };
    },

    /**
     * One file's text, or one directory's entries, of the package's published
     * source at `version` — an exact version from the registry's list, or a
     * dist-tag the registry resolves (`latest`). `path` is relative to the
     * package root; omitted, the root is listed.
     */
    async readSource(
      ecosystem: string,
      packageName: string,
      version: string,
      path?: string,
      range: { startLine?: number; endLine?: number } = {},
    ): Promise<DependencySourceResult> {
      const checked = refusal(ecosystem, packageName);
      if ('outcome' in checked) return checked;
      const normalized = normalizeDependencyPath(path);
      if (!normalized.ok) {
        return { ...FRAMING, outcome: 'invalid_path', path: path ?? '', reason: normalized.reason };
      }
      const ref = { ...FRAMING, ecosystem: checked.ecosystem, package: packageName };
      const tooLarge = (
        what: 'metadata' | 'tarball' | 'archive' | 'file',
        maxBytes: number,
        at: string | null,
      ) => ({
        ...ref,
        outcome: 'too_large' as const,
        what,
        maxBytes,
        version: at,
        path: what === 'file' ? normalized.path : null,
      });

      const meta = await readMetadata(packageName);
      if (meta === null) return { ...ref, outcome: 'package_not_found' };
      if ('failure' in meta) {
        if (meta.failure === 'too_large')
          return tooLarge('metadata', DEPENDENCY_METADATA_MAX_BYTES, null);
        return { ...ref, outcome: 'unreachable', failure: meta.failure, status: meta.status };
      }

      const asked = version.trim().slice(0, VERSION_MAX);
      let exact: string | null = meta.versions.includes(asked) ? asked : null;
      let resolvedFrom: string | null = null;
      if (exact === null && Object.hasOwn(meta.distTags, asked)) {
        const tagged = meta.distTags[asked]!;
        if (meta.versions.includes(tagged)) {
          exact = tagged;
          resolvedFrom = asked;
        }
      }
      if (exact === null) {
        return {
          ...ref,
          outcome: 'version_not_found',
          version: asked,
          distTags: Object.keys(meta.distTags),
        };
      }
      const at = { ...ref, version: exact, resolvedFrom };

      const got = await fetchCapped(
        doFetch,
        tarballUrl(packageName, exact),
        'application/octet-stream',
        DEPENDENCY_TARBALL_MAX_BYTES,
        timeoutMs,
      );
      // A version the registry LISTS whose tarball is gone is the registry failing
      // to serve it, not the version being absent.
      if (got.kind === 'not_found') {
        return { ...ref, outcome: 'unreachable', failure: 'http_status', status: 404 };
      }
      if (got.kind === 'failed') {
        if (got.failure === 'too_large') {
          return tooLarge('tarball', DEPENDENCY_TARBALL_MAX_BYTES, exact);
        }
        return { ...ref, outcome: 'unreachable', failure: got.failure, status: got.status };
      }
      const gz = got.body;

      let tar: Buffer;
      try {
        tar = gunzipSync(gz, { maxOutputLength: DEPENDENCY_UNPACKED_MAX_BYTES });
      } catch (err) {
        if (err instanceof RangeError)
          return tooLarge('archive', DEPENDENCY_UNPACKED_MAX_BYTES, exact);
        return { ...ref, outcome: 'unreachable', failure: 'invalid_archive', status: null };
      }
      const files = readTarFiles(tar);
      if (files === null) {
        return { ...ref, outcome: 'unreachable', failure: 'invalid_archive', status: null };
      }

      const file = normalized.path === '' ? undefined : files.get(normalized.path);
      if (file) {
        if (file.data.includes(0)) {
          return { ...at, outcome: 'binary', path: normalized.path, bytes: file.data.length };
        }
        const text = file.data.toString('utf8');
        const sliced = sliceRange(text, range);
        if (!sliced && file.data.length > DEPENDENCY_SOURCE_FILE_MAX_BYTES) {
          return tooLarge('file', DEPENDENCY_SOURCE_FILE_MAX_BYTES, exact);
        }
        return {
          ...at,
          outcome: 'source_file',
          path: normalized.path,
          bytes: file.data.length,
          text: sliced ? sliced.text : text,
          lines: sliced ? sliced.lines : null,
        };
      }
      const entries = listDirectory(files, normalized.path);
      if (entries.length === 0) return { ...at, outcome: 'path_not_found', path: normalized.path };
      const truncated = entries.length > DEPENDENCY_DIRECTORY_MAX_ENTRIES;
      return {
        ...at,
        outcome: 'directory',
        path: normalized.path,
        entries: truncated ? entries.slice(0, DEPENDENCY_DIRECTORY_MAX_ENTRIES) : entries,
        truncated,
      };
    },
  };
}

export const dependencyReadService = createDependencyReadService();
