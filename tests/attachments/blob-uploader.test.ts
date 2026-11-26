import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';

/** The shape the transport receives: a fully serialized, fully SIGNED request.
 *  Declared structurally so the test needs no direct `@smithy/*` dependency. */
interface SignedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

// The two-bucket blob adapter, on the S3 API (MOTIR-2389).
//
// ⚠️ This suite deliberately does NOT mock the SDK. It runs the REAL
// `@aws-sdk/client-s3` — real request serialization, real SigV4 signing, real
// presigning — and fakes only the HTTP layer, by swapping the client's
// `requestHandler` for one that records the fully-signed request and answers it.
//
// That is the difference between asserting our own call and asserting the
// artefact: a mocked SDK would happily agree that we "passed the right options"
// while the request it produced targeted the wrong bucket or carried an unsigned
// content type. `notes.html` #207 is the incident where exactly that gap — a
// stand-in that agreed with the code by construction — stored objects a later
// reader refused forever. Here the assertions read the wire.

const ENV = {
  MOTIR_S3_ENDPOINT: 'https://s3.test.invalid',
  MOTIR_S3_REGION: 'auto',
  MOTIR_S3_ACCESS_KEY_ID: 'test-access-key',
  MOTIR_S3_SECRET_ACCESS_KEY: 'test-secret-key',
  MOTIR_S3_PRIVATE_BUCKET: 'motir-private',
  MOTIR_S3_PUBLIC_BUCKET: 'motir-public',
  MOTIR_S3_PUBLIC_BASE_URL: 'https://s3.test.invalid/motir-public',
} as const;

const {
  putAttachment,
  putPublicAsset,
  putPrivateAttachment,
  putPrivateStream,
  signedDownloadUrl,
  mintPrivateUploadToken,
  headPrivateBlob,
  getPrivateBlobBytes,
  deleteAttachmentBlob,
  deletePublicAsset,
} = await import('@/lib/blob/uploader');
const { s3Client, resetS3ClientForTests } = await import('@/lib/blob/s3');
const { storedAssetKey } = await import('@/lib/blob/referencedUrls');

/** What the fake transport hands back — the SDK deserializes it as a response. */
interface FakeTransportResult {
  response: {
    statusCode: number;
    reason: string;
    headers: Record<string, string>;
    body: Readable;
  };
}

interface Seen {
  method: string;
  bucket: string;
  key: string;
  headers: Record<string, string>;
  body: unknown;
}

let seen: Seen[] = [];
/** Per-request canned responses, keyed by `<METHOD> <bucket>/<key>`. */
let responses: Map<string, { statusCode: number; headers?: Record<string, string>; body?: string }>;

/**
 * Replace the client's transport. Everything above it — serialization, the
 * SigV4 signer, the error deserializer — is the SDK's own.
 */
function installFakeTransport(): void {
  const client = s3Client();
  client.config.requestHandler = {
    async handle(request: SignedRequest): Promise<FakeTransportResult> {
      const [, bucket = '', ...rest] = request.path.split('/');
      const key = decodeURIComponent(rest.join('/'));
      seen.push({
        method: request.method,
        bucket,
        key,
        headers: request.headers,
        body: request.body,
      });
      const canned = responses.get(`${request.method} ${bucket}/${key}`) ?? { statusCode: 200 };
      return {
        response: {
          statusCode: canned.statusCode,
          reason: '',
          headers: { etag: '"abc"', ...(canned.headers ?? {}) },
          // A canned BODY where the case needs one — the GET path reads bytes
          // back, so an always-empty stream could not tell a correct read from
          // one that returns nothing.
          body: Readable.from(canned.body === undefined ? [] : [Buffer.from(canned.body)]),
        },
      };
    },
  } as unknown as typeof client.config.requestHandler;
}

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) process.env[name] = value;
  resetS3ClientForTests();
  seen = [];
  responses = new Map();
  installFakeTransport();
});

afterEach(() => {
  for (const name of Object.keys(ENV)) delete process.env[name];
  delete process.env['E2E_TEST_BLOB'];
  resetS3ClientForTests();
  vi.restoreAllMocks();
});

/** `avatars/u1/a-3f9c1d2e4b.png` → the stable part, so a random suffix is assertable. */
function withoutSuffix(key: string): string {
  return key.replace(/-[0-9a-f]{10}(\.[^.]+)?$/, '$1');
}

describe('the two-bucket split — every path writes the bucket it should', () => {
  it('putPublicAsset writes the PUBLIC bucket and returns the KEY, never a URL', async () => {
    const result = await putPublicAsset('avatars/u1/a.png', new Blob(['x']), 'image/png');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.bucket).toBe('motir-public');
    expect(withoutSuffix(seen[0]!.key)).toBe('avatars/u1/a.png');
    expect(seen[0]!.headers['content-type']).toBe('image/png');
    // Since MOTIR-2404 it returns the SUFFIXED key — the object actually
    // written — and no origin at all, so the caller cannot persist one.
    expect(result).not.toHaveProperty('url');
    expect(result.key).toBe(seen[0]!.key);
  });

  it('putPrivateAttachment writes the PRIVATE bucket and returns the KEY, never a URL', async () => {
    const result = await putPrivateAttachment('attachments/w1/f.pdf', new Blob(['x']), 'x/pdf');

    expect(seen[0]!.bucket).toBe('motir-private');
    expect(result).not.toHaveProperty('url');
    expect(withoutSuffix(result.pathname)).toBe('attachments/w1/f.pdf');
    expect(result.pathname).toBe(seen[0]!.key);
  });

  it('putAttachment (the legacy public put) still targets the PUBLIC bucket', async () => {
    const result = await putAttachment('legacy/a.png', new Blob(['x']), 'image/png');
    expect(seen[0]!.bucket).toBe('motir-public');
    expect(result.url.startsWith(ENV.MOTIR_S3_PUBLIC_BASE_URL)).toBe(true);
  });

  it('deleteAttachmentBlob deletes from PRIVATE, deletePublicAsset from PUBLIC', async () => {
    await deleteAttachmentBlob('attachments/w1/f-aaaaaaaaaa.pdf');
    await deletePublicAsset('avatars/u1/a-bbbbbbbbbb.png');

    expect(seen.map((s) => [s.method, s.bucket, s.key])).toEqual([
      ['DELETE', 'motir-private', 'attachments/w1/f-aaaaaaaaaa.pdf'],
      ['DELETE', 'motir-public', 'avatars/u1/a-bbbbbbbbbb.png'],
    ]);
  });

  // The URL-to-key derivation moved to `storedAssetKey` when MOTIR-2404 made
  // `deletePublicAsset` take a key (its caller now has one directly), so the
  // case that still matters follows the logic to where it now lives. (The
  // companion case — a URL on the retired Vercel public host — went with the
  // arm that recognised it, MOTIR-2393.)
  it('storedAssetKey yields nothing for a value that is not ours, so the GC no-ops', async () => {
    expect(storedAssetKey('https://lh3.googleusercontent.com/a/photo.jpg')).toBeNull();
    // And the deleter refuses an empty key rather than issuing a DELETE against
    // the bucket root.
    await deletePublicAsset('');
    expect(seen).toHaveLength(0);
  });

  it('two same-named uploads get DIFFERENT keys (the random suffix)', async () => {
    await putPrivateAttachment('attachments/w1/shot.png', new Blob(['a']), 'image/png');
    await putPrivateAttachment('attachments/w1/shot.png', new Blob(['b']), 'image/png');
    expect(seen[0]!.key).not.toBe(seen[1]!.key);
    // The suffix is an INFIX — the extension survives for content-type sniffing.
    for (const s of seen) expect(s.key.endsWith('.png')).toBe(true);
  });
});

describe('signedDownloadUrl — a presigned GET at the ADR’s 300 s', () => {
  it('signs a GET on the private bucket that expires in 300 s by default', async () => {
    const url = await signedDownloadUrl('attachments/w1/f-aaaaaaaaaa.pdf');
    const parsed = new URL(url);

    expect(parsed.pathname).toBe('/motir-private/attachments/w1/f-aaaaaaaaaa.pdf');
    // The expiry is read off the URL the caller is handed, not off our own input.
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(parsed.searchParams.get('X-Amz-Signature')).toBeTruthy();
    // Presigning is client-side: no request left the process.
    expect(seen).toHaveLength(0);
  });

  it('honours an explicit ttl', async () => {
    const url = await signedDownloadUrl('attachments/w1/f.pdf', { ttlSeconds: 60 });
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('60');
  });

  it('binds the download disposition INTO the signature, not as a bare suffix', async () => {
    const url = await signedDownloadUrl('attachments/w1/archive-aaaaaaaaaa.zip', {
      download: true,
    });
    const parsed = new URL(url);

    expect(parsed.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="archive-aaaaaaaaaa.zip"',
    );
    // S3 rejects an UNSIGNED response-header override, so the override has to be
    // covered by the signature — which it is only because it was part of the
    // signed command. (The old `?download=1` suffix could not have survived.)
    expect(parsed.searchParams.get('X-Amz-Signature')).toBeTruthy();
    const plain = await signedDownloadUrl('attachments/w1/archive-aaaaaaaaaa.zip');
    expect(new URL(plain).searchParams.get('X-Amz-Signature')).not.toBe(
      parsed.searchParams.get('X-Amz-Signature'),
    );
  });

  // The regression guard for MOTIR-2395. This test used to assert the OPPOSITE
  // — that E2E_TEST_BLOB short-circuited to a fabricated, signature-free URL on
  // a host of its own — which meant every "private" download in the E2E suite
  // proved nothing about access control. `signedDownloadUrl` now has ONE code
  // path; the browser-side interception moved to a `page.route` on the endpoint
  // (tests/e2e/_helpers/object-store.ts), which is where the fetch actually is.
  it('E2E_TEST_BLOB changes NOTHING — there is one code path, and it signs', async () => {
    process.env['E2E_TEST_BLOB'] = '1';
    const underFlag = new URL(await signedDownloadUrl('a/b.png'));

    expect(underFlag.pathname).toBe('/motir-private/a/b.png');
    expect(underFlag.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(underFlag.searchParams.get('X-Amz-Expires')).toBe('300');
    // …and against the CONFIGURED endpoint, not a host the flag invented.
    expect(underFlag.origin).toBe(ENV.MOTIR_S3_ENDPOINT);
  });
});

describe('mintPrivateUploadToken — a presigned PUT whose content type is BOUND', () => {
  it('binds contentType at SIGNING time — it is inside X-Amz-SignedHeaders', async () => {
    const url = await mintPrivateUploadToken('acceptance/w/s/v.webm', {
      contentType: 'video/webm',
      maxBytes: 100,
    });
    const parsed = new URL(url);

    expect(parsed.pathname).toBe('/motir-private/acceptance/w/s/v.webm');
    // THE assertion this seam exists for. A presigned PUT carries only what the
    // SIGNER bound; by default the presigner drops ContentType entirely, leaving
    // the uploader free to send anything. Naming it in the signed headers is what
    // makes the bound type enforceable — an uploader sending a different one is
    // rejected by the signature check.
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(parsed.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('a DIFFERENT content type produces a different signature — the binding is real', async () => {
    const asVideo = await mintPrivateUploadToken('acceptance/w/s/v.webm', {
      contentType: 'video/webm',
      maxBytes: 100,
      ttlSeconds: 300,
    });
    const asZip = await mintPrivateUploadToken('acceptance/w/s/v.webm', {
      contentType: 'application/zip',
      maxBytes: 100,
      ttlSeconds: 300,
    });
    // Same key, same expiry, same credentials — only the bound type differs. If
    // the type were NOT signed, these two would be identical, and the "binding"
    // would be decoration.
    expect(new URL(asVideo).searchParams.get('X-Amz-Signature')).not.toBe(
      new URL(asZip).searchParams.get('X-Amz-Signature'),
    );
  });

  it('defaults to a 300 s grant and honours an explicit ttl', async () => {
    const dflt = await mintPrivateUploadToken('a/b.webm', {
      contentType: 'video/webm',
      maxBytes: 1,
    });
    expect(new URL(dflt).searchParams.get('X-Amz-Expires')).toBe('300');
    const short = await mintPrivateUploadToken('a/b.webm', {
      contentType: 'video/webm',
      maxBytes: 1,
      ttlSeconds: 30,
    });
    expect(new URL(short).searchParams.get('X-Amz-Expires')).toBe('30');
  });
});

describe('headPrivateBlob — the authoritative metadata read', () => {
  it('returns the size + contentType the STORE reports', async () => {
    responses.set('HEAD motir-private/acceptance/v.webm', {
      statusCode: 200,
      headers: { 'content-length': '4096', 'content-type': 'video/webm' },
    });

    expect(await headPrivateBlob('acceptance/v.webm')).toEqual({
      size: 4096,
      contentType: 'video/webm',
    });
    expect(seen[0]).toMatchObject({ method: 'HEAD', bucket: 'motir-private' });
  });

  it('returns null for an object that is not there', async () => {
    responses.set('HEAD motir-private/acceptance/missing.webm', { statusCode: 404 });
    expect(await headPrivateBlob('acceptance/missing.webm')).toBeNull();
  });
});

describe('putPrivateStream — a streamed upload under EXACTLY the key given (MOTIR-12134)', () => {
  const KEY = 'hosting-exports/ws1/app1/exp1.dump';

  it('writes the private bucket under the key as given, and answers the size the store reports', async () => {
    responses.set(`HEAD motir-private/${KEY}`, {
      statusCode: 200,
      headers: { 'content-length': '11', 'content-type': 'application/octet-stream' },
    });

    const result = await putPrivateStream(
      KEY,
      Readable.from([Buffer.from('hello '), Buffer.from('dump')]),
      'application/octet-stream',
    );

    expect(result).toEqual({ key: KEY, sizeBytes: 11 });
    const put = seen.find((s) => s.method === 'PUT');
    expect(put).toMatchObject({ bucket: 'motir-private', key: KEY });
    expect(put?.headers['content-type']).toBe('application/octet-stream');
  });

  it('rethrows a refused upload and never reads it back', async () => {
    responses.set(`PUT motir-private/${KEY}`, { statusCode: 500 });
    await expect(
      putPrivateStream(KEY, Readable.from([Buffer.from('x')]), 'application/octet-stream'),
    ).rejects.toBeTruthy();
    expect(seen.some((s) => s.method === 'HEAD')).toBe(false);
  });

  it('rethrows the upload’s own failure even when aborting it fails too', async () => {
    const { Upload } = await import('@aws-sdk/lib-storage');
    vi.spyOn(Upload.prototype, 'abort').mockRejectedValue(new Error('abort refused'));
    responses.set(`PUT motir-private/${KEY}`, { statusCode: 500 });
    const error = await putPrivateStream(
      KEY,
      Readable.from([Buffer.from('x')]),
      'application/octet-stream',
    ).catch((e: unknown) => e);
    expect(String(error)).not.toContain('abort refused');
  });

  it('refuses an upload the store then cannot find', async () => {
    responses.set(`HEAD motir-private/${KEY}`, { statusCode: 404 });
    await expect(
      putPrivateStream(KEY, Readable.from([Buffer.from('x')]), 'application/octet-stream'),
    ).rejects.toThrow(/could not be read back/);
  });
});

describe('getPrivateBlobBytes — the one private reader that is not a browser', () => {
  // Every other private read here mints a presigned URL and lets the BROWSER
  // fetch it. The personal-data export (MOTIR-3701) packages a reader's uploaded
  // files into an archive on the server, so it needs the bytes in process.
  it('returns the BYTES the store serves, from the private bucket', async () => {
    responses.set('GET motir-private/attachments/w1/report.pdf', {
      statusCode: 200,
      headers: { 'content-type': 'application/pdf' },
      body: 'PDF-BYTES',
    });

    const bytes = await getPrivateBlobBytes('attachments/w1/report.pdf');

    expect(bytes).toBeInstanceOf(Buffer);
    expect(bytes!.toString()).toBe('PDF-BYTES');
    expect(seen[0]).toMatchObject({ method: 'GET', bucket: 'motir-private' });
  });

  it('returns null when the store answers with no body at all', async () => {
    // ⚠️ THE ONE PLACE THIS SUITE STUBS `send` INSTEAD OF THE TRANSPORT, and the
    // reason is that the real transport CANNOT produce this shape: the S3
    // deserializer always attaches a stream to a 200, so the `Body` guard is
    // unreachable through a signed round trip. It is still worth having —
    // `GetObjectOutput.Body` is optional in the SDK's own types — so it is
    // covered here rather than deleted to satisfy a metric. `vi.restoreAllMocks`
    // in `afterEach` puts the client back.
    vi.spyOn(s3Client(), 'send').mockResolvedValueOnce({} as never);
    expect(await getPrivateBlobBytes('attachments/w1/bodyless.pdf')).toBeNull();
  });

  it('returns null for an object that is not there, rather than throwing', async () => {
    // The export packages what it can and records what it could not: a row whose
    // object was GC'd must not fail the whole archive.
    responses.set('GET motir-private/attachments/w1/gone.pdf', { statusCode: 404 });
    expect(await getPrivateBlobBytes('attachments/w1/gone.pdf')).toBeNull();
  });
});

describe('a PRE-MIGRATION object — written behind the module’s back — still downloads', () => {
  // The assertion that catches code pointed at an empty new bucket. Every other
  // test here creates what it reads, so all of them would pass against a store
  // that only ever contains what this module put there. This one writes with the
  // RAW client — bypassing `putPrivateAttachment`, its random suffix and its
  // content-type handling, exactly as an object copied from the old store would
  // arrive — and then demands that the module serve it.
  it('reads back an object the uploader never wrote', async () => {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const legacyKey = 'attachments/w1/legacy-no-suffix.pdf';

    await s3Client().send(
      new PutObjectCommand({
        Bucket: ENV.MOTIR_S3_PRIVATE_BUCKET,
        Key: legacyKey,
        Body: Buffer.from('legacy bytes'),
        ContentType: 'application/pdf',
      }),
    );
    expect(seen[0]).toMatchObject({ method: 'PUT', bucket: 'motir-private', key: legacyKey });

    responses.set(`HEAD motir-private/${legacyKey}`, {
      statusCode: 200,
      headers: { 'content-length': '12', 'content-type': 'application/pdf' },
    });
    expect(await headPrivateBlob(legacyKey)).toEqual({ size: 12, contentType: 'application/pdf' });

    // And the content route's presign addresses that exact key — no suffix is
    // invented, nothing assumes the key came from our own put path.
    const url = new URL(await signedDownloadUrl(legacyKey));
    expect(url.pathname).toBe(`/motir-private/${legacyKey}`);
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });
});

describe('the E2E seam is wired at the SDK TRANSPORT, not at undici', () => {
  // The regression this locks down cost a CI round trip and looked like a UI
  // bug. Every other E2E seam intercepts an undici MockAgent; undici's
  // dispatcher governs `fetch`, and the AWS SDK transports over `node:https` —
  // so an undici intercept cannot see this traffic at all. `@vercel/blob` used
  // `fetch`, which is why the old mock worked and why the swap broke it
  // SILENTLY: uploads left as real DNS lookups (`ENOTFOUND e2e.s3.invalid`) and
  // the failure surfaced as "the attachment list has one row instead of two."
  //
  // The endpoint below is deliberately unresolvable. If this seam ever stops
  // being installed at the transport, these tests do not fall back to a mock —
  // they fail trying to reach the network, which is the honest signal.
  it('an upload + head + delete round-trips entirely in process', async () => {
    const { installBlobStoreMock } = await import('@/lib/test-blob-mock');
    installBlobStoreMock();

    const { pathname } = await putPrivateAttachment(
      'attachments/w1/e2e.png',
      new Blob(['12345']),
      'image/png',
    );

    // The HEAD reports what was actually stored — the register step's
    // authoritative read, answered without a network.
    expect(await headPrivateBlob(pathname)).toEqual({ size: 5, contentType: 'image/png' });

    await deleteAttachmentBlob(pathname);
    expect(await headPrivateBlob(pathname)).toBeNull();
  });

  it('keeps the two buckets separate in the fake, exactly as the real one does', async () => {
    const { installBlobStoreMock } = await import('@/lib/test-blob-mock');
    installBlobStoreMock();

    const priv = await putPrivateAttachment('shared/name.png', new Blob(['ab']), 'image/png');
    await putPublicAsset('shared/name.png', new Blob(['abcd']), 'image/png');

    // A same-named key in the PUBLIC bucket must not answer a private HEAD with
    // the wrong bytes — the fake keys on `<bucket>/<key>`, not on the key.
    expect(await headPrivateBlob(priv.pathname)).toEqual({ size: 2, contentType: 'image/png' });
  });
});

describe('configuration', () => {
  it('an unset bucket fails LOUDLY rather than writing somewhere unexpected', async () => {
    delete process.env['MOTIR_S3_PRIVATE_BUCKET'];
    await expect(
      putPrivateAttachment('attachments/w1/f.pdf', new Blob(['x']), 'x/pdf'),
    ).rejects.toThrow(/MOTIR_S3_PRIVATE_BUCKET is not set/);
  });

  it('importing the module requires NO configuration (the build traces it unset)', async () => {
    for (const name of Object.keys(ENV)) delete process.env[name];
    await expect(import('@/lib/blob/uploader')).resolves.toBeTruthy();
  });
});
