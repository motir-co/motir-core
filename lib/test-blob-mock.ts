// Node-only object-store fake for E2E (Subtask 5.2.8; moved onto the S3 API by
// MOTIR-2389; shared across the lane's processes by MOTIR-12142).
//
// CI's Playwright lane runs with placeholder blob credentials — "no E2E
// performs a real upload (the real credentials live on the platform)" is the
// standing ci.yml decision — so the attachments journey (tests/e2e/
// attachments.spec.ts) needs a seam that lets the app upload through its real
// route with no real store. The SERVER-side put/head/get/delete calls land
// here; the BROWSER-side reads of the returned URLs (thumbnails, the lightbox,
// downloads) are fulfilled by the spec's own `page.route` — nothing ever leaves
// localhost.
//
// ⚠️ THIS IS NOT AN UNDICI MOCK, and that is the whole point.
//
// Every other E2E seam here (OAuth, billing, GitHub) intercepts an undici
// `MockAgent` installed as the global dispatcher. That mechanism CANNOT reach
// the object store: undici's dispatcher governs `fetch`, and the AWS SDK's
// default Node transport is `node:https`. `@vercel/blob` used `fetch`, so the
// interception worked; moving to the S3 SDK silently relocated the traffic to a
// layer the interceptor does not see, and the suite's uploads left as real DNS
// lookups (`getaddrinfo ENOTFOUND e2e.s3.invalid`) — passing locally, failing in
// CI, and surfacing as "the attachment list has one row instead of two."
//
// So the fake is installed at the SDK's OWN transport seam
// (`installObjectStoreTransport`), where nothing can route around it, and it
// never touches the network at all. The configured endpoint host is therefore
// irrelevant and unreachable BY DESIGN.
//
// ── SHARED ACROSS PROCESSES on request (MOTIR-12142) ─────────────────────────
// The grace-window export uploads a database dump from the job worker AND from
// the app server, and the spec reads it back, so with
// `MOTIR_FAKE_BLOB_STATE_PATH` set the store is a JSON index at that path plus
// one bytes file per object in `<path>.objects/`, named by a hash of
// `<bucket>/<key>` so a dump never lands base64'd inside the index. Every
// operation reads the index afresh; every write replaces a file whole (sibling
// + rename), so a reader in another process sees the old file or the new one.
// Unset, the store is this process's `Map`, as it always was.
//
// ── STREAMED BODIES AND MULTIPART ────────────────────────────────────────────
// `putPrivateStream` hands the SDK a Node `Readable` through
// `@aws-sdk/lib-storage`: a small body arrives as one `PutObject` whose body may
// still be a stream, a large one as the S3 multipart sequence. The transport
// drains a stream (or async iterable) rather than storing nothing, decodes the
// SDK's `aws-chunked` framing when it uses it, and answers create / upload part /
// complete / abort, assembling the parts in part-number order on completion. An
// upload in flight lives in the process driving it; only the completed object
// reaches the shared store.

import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { installObjectStoreTransport } from '@/lib/blob/s3';
import {
  fixtureFileExistsSync,
  readFixtureBytesSync,
  readFixtureFileSync,
  removeFixtureFileSync,
  replaceFixtureBytesSync,
  replaceFixtureFileSync,
} from '@/lib/test-fixture-file';

/** The env var naming the shared store's index file. */
export const FAKE_BLOB_STATE_PATH_ENV = 'MOTIR_FAKE_BLOB_STATE_PATH';

interface StoredObject {
  body: Buffer;
  contentType: string;
}

/** The in-memory store, keyed by `<bucket>/<key>` — one Map per server boot. */
const memory = new Map<string, StoredObject>();

/** Multipart uploads in flight in this process, by upload id. */
const uploads = new Map<string, { id: string; contentType: string; parts: Map<number, Buffer> }>();

function sharedPath(): string | null {
  const raw = process.env[FAKE_BLOB_STATE_PATH_ENV];
  return raw !== undefined && raw !== '' ? raw : null;
}

type Index = Record<string, { contentType: string; file: string }>;

function readIndex(path: string): Index {
  if (!fixtureFileExistsSync(path)) return {};
  try {
    return JSON.parse(readFixtureFileSync(path)) as Index;
  } catch {
    // A torn read — treat it as the last whole index the writer will replace.
    return {};
  }
}

/** Where an object's bytes live beside the index. */
export function fakeBlobObjectFile(path: string, id: string): string {
  return `${path}.objects/${createHash('sha256').update(id).digest('hex')}`;
}

function getObject(id: string): StoredObject | null {
  const path = sharedPath();
  if (!path) return memory.get(id) ?? null;
  const entry = readIndex(path)[id];
  if (!entry || !fixtureFileExistsSync(entry.file)) return null;
  return { body: readFixtureBytesSync(entry.file), contentType: entry.contentType };
}

function putObject(id: string, object: StoredObject): void {
  const path = sharedPath();
  if (!path) {
    memory.set(id, object);
    return;
  }
  const file = fakeBlobObjectFile(path, id);
  replaceFixtureBytesSync(file, object.body);
  replaceFixtureFileSync(
    path,
    JSON.stringify({ ...readIndex(path), [id]: { contentType: object.contentType, file } }),
  );
}

function deleteObject(id: string): void {
  const path = sharedPath();
  if (!path) {
    memory.delete(id);
    return;
  }
  const index = readIndex(path);
  const entry = index[id];
  if (!entry) return;
  delete index[id];
  replaceFixtureFileSync(path, JSON.stringify(index));
  removeFixtureFileSync(entry.file);
}

/** The bytes stored under `<bucket>/<key>`, or null — for a spec helper that
 *  holds only the shared store's files. */
export function readFakeBlobObject(id: string): Buffer | null {
  return getObject(id)?.body ?? null;
}

/** The shape the SDK hands its transport: a serialized, signed request. */
interface TransportRequest {
  method: string;
  path: string;
  query?: Record<string, string | string[] | null | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
}

function objectId(path: string): string {
  const [withoutQuery] = path.split('?');
  return decodeURIComponent(withoutQuery ?? '').replace(/^\/+/, '');
}

/** The request's query, from the SDK's `query` object and any `?…` on the path. */
function queryOf(request: TransportRequest): Map<string, string> {
  const query = new Map<string, string>();
  const onPath = request.path.split('?')[1];
  if (onPath) for (const [k, v] of new URLSearchParams(onPath)) query.set(k, v);
  for (const [k, v] of Object.entries(request.query ?? {})) {
    if (v === undefined) continue;
    query.set(k, Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
  }
  return query;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === 'function'
  );
}

function chunkBytes(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.alloc(0);
}

/** Every byte of a body the SDK hands over: a buffer, a string, a typed array,
 *  or a stream / async iterable drained to its end. */
async function toBuffer(body: unknown): Promise<Buffer> {
  if (isAsyncIterable(body)) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunkBytes(chunk));
    return Buffer.concat(chunks);
  }
  return chunkBytes(body);
}

/** Undo the SDK's `aws-chunked` framing: `<hex size>[;ext]\r\n<bytes>\r\n`
 *  repeated, ending with a zero-size chunk and optional trailers. */
export function decodeAwsChunked(framed: Buffer): Buffer {
  const out: Buffer[] = [];
  let at = 0;
  while (at < framed.length) {
    const eol = framed.indexOf('\r\n', at);
    if (eol < 0) break;
    const size = Number.parseInt(framed.subarray(at, eol).toString('latin1').split(';')[0]!, 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(framed.subarray(eol + 2, eol + 2 + size));
    at = eol + 2 + size + 2;
  }
  return Buffer.concat(out);
}

async function bodyBytes(request: TransportRequest): Promise<Buffer> {
  const raw = await toBuffer(request.body);
  const encoding = (request.headers ?? {})['content-encoding'] ?? '';
  return encoding.includes('aws-chunked') ? decodeAwsChunked(raw) : raw;
}

/** The SDK's body collector pipes what it is given, so this must be a real Node
 *  `Readable` — an async iterable is not enough (`nodeStream.pipe is not a
 *  function`). */
function bodyStream(bytes: Buffer): Readable {
  return Readable.from(bytes.length > 0 ? [bytes] : []);
}

function reply(statusCode: number, reason: string, headers: Record<string, string>, body?: string) {
  return {
    response: {
      statusCode,
      reason,
      headers,
      body: bodyStream(body ? Buffer.from(body) : Buffer.alloc(0)),
    },
  };
}

function xml(bucketAndKey: string, inner: string, root: string): string {
  const slash = bucketAndKey.indexOf('/');
  const bucket = bucketAndKey.slice(0, slash);
  const key = bucketAndKey.slice(slash + 1);
  return `<?xml version="1.0" encoding="UTF-8"?><${root}><Bucket>${bucket}</Bucket><Key>${key}</Key>${inner}</${root}>`;
}

/**
 * The transport. PUT stores the bytes; HEAD/GET answer from what was stored (404
 * when absent, which is what `headPrivateBlob` turns into null); DELETE is
 * idempotent — the same contract the real store gives us. The multipart
 * sequence (`POST ?uploads`, `PUT ?partNumber&uploadId`, `POST ?uploadId`,
 * `DELETE ?uploadId`) assembles one object on completion.
 */
export function createObjectStoreTransport() {
  return {
    async handle(request: TransportRequest) {
      const id = objectId(request.path);
      const query = queryOf(request);
      const headers = request.headers ?? {};
      const uploadId = query.get('uploadId');

      if (request.method === 'POST' && query.has('uploads')) {
        const fresh = randomUUID();
        uploads.set(fresh, {
          id,
          contentType: headers['content-type'] ?? 'application/octet-stream',
          parts: new Map(),
        });
        return reply(
          200,
          'OK',
          { 'content-type': 'application/xml' },
          xml(id, `<UploadId>${fresh}</UploadId>`, 'InitiateMultipartUploadResult'),
        );
      }

      if (uploadId !== undefined) {
        const upload = uploads.get(uploadId);
        if (request.method === 'DELETE') {
          uploads.delete(uploadId);
          return reply(204, 'No Content', {});
        }
        if (!upload || upload.id !== id) {
          return reply(
            404,
            'Not Found',
            { 'content-type': 'application/xml' },
            '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchUpload</Code></Error>',
          );
        }
        if (request.method === 'PUT') {
          const part = Number(query.get('partNumber'));
          upload.parts.set(part, await bodyBytes(request));
          return reply(200, 'OK', { etag: `"e2e-part-${part}"` });
        }
        // POST ?uploadId — complete: the parts, in part-number order.
        await toBuffer(request.body);
        const body = Buffer.concat(
          [...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes),
        );
        uploads.delete(uploadId);
        putObject(id, { body, contentType: upload.contentType });
        return reply(
          200,
          'OK',
          { 'content-type': 'application/xml' },
          xml(id, '<ETag>"e2e"</ETag>', 'CompleteMultipartUploadResult'),
        );
      }

      if (request.method === 'PUT') {
        putObject(id, {
          body: await bodyBytes(request),
          contentType: headers['content-type'] ?? 'application/octet-stream',
        });
        return reply(200, 'OK', { etag: '"e2e"' });
      }

      if (request.method === 'DELETE') {
        deleteObject(id);
        return reply(204, 'No Content', {});
      }

      const object = getObject(id);
      if (!object) return reply(404, 'Not Found', {});
      return {
        response: {
          statusCode: 200,
          reason: 'OK',
          headers: {
            'content-length': String(object.body.length),
            'content-type': object.contentType,
            etag: '"e2e"',
          },
          body: bodyStream(request.method === 'HEAD' ? Buffer.alloc(0) : object.body),
        },
      };
    },
  };
}

/** Wire the fake store into the S3 client. Called once, at instrumentation.
 *  The in-memory store starts empty; a shared one is never wiped by a boot,
 *  because the other processes' objects live in it. */
export function installBlobStoreMock(): void {
  memory.clear();
  uploads.clear();
  installObjectStoreTransport(createObjectStoreTransport());
}
