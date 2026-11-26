import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The E2E object-store fake, shared across processes and fed streams
// (Story MOTIR-9800 · MOTIR-12142). The grace-window export streams a dump into
// `putPrivateStream` from the job worker and from the app server, and the spec
// reads it back — so with `MOTIR_FAKE_BLOB_STATE_PATH` set, the fake's store is
// files every process reads, and it accepts the SDK's streamed and multipart
// uploads. No SDK mock: the shipped uploader, the real `@aws-sdk/client-s3` and
// `@aws-sdk/lib-storage`, and only the transport swapped, as the E2E lane boots it.

const ENV = {
  MOTIR_S3_ENDPOINT: 'https://s3.shared.invalid',
  MOTIR_S3_REGION: 'auto',
  MOTIR_S3_ACCESS_KEY_ID: 'shared-access-key',
  MOTIR_S3_SECRET_ACCESS_KEY: 'shared-secret-key',
  MOTIR_S3_PRIVATE_BUCKET: 'motir-private',
  MOTIR_S3_PUBLIC_BUCKET: 'motir-public',
  MOTIR_S3_PUBLIC_BASE_URL: 'https://s3.shared.invalid/motir-public',
} as const;

const blobMock = await import('@/lib/test-blob-mock');
const { resetS3ClientForTests } = await import('@/lib/blob/s3');
const { putPrivateStream, getPrivateBlobBytes, headPrivateBlob, deleteAttachmentBlob } =
  await import('@/lib/blob/uploader');

const {
  FAKE_BLOB_STATE_PATH_ENV,
  createObjectStoreTransport,
  decodeAwsChunked,
  fakeBlobObjectFile,
  installBlobStoreMock,
  readFakeBlobObject,
} = blobMock;

let statePath: string;

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  statePath = join(mkdtempSync(join(tmpdir(), 'fake-blob-')), 'store', 'blob.json');
  vi.stubEnv(FAKE_BLOB_STATE_PATH_ENV, statePath);
  installBlobStoreMock();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetS3ClientForTests();
});

/** A Readable that yields `bytes` in chunks, as `pg_dump`'s stdout does. */
function streamOf(bytes: Buffer, chunk = 64 * 1024): Readable {
  const chunks: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += chunk) chunks.push(bytes.subarray(at, at + chunk));
  return Readable.from(chunks);
}

function patterned(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + (i >> 12)) & 0xff;
  return bytes;
}

describe('the blob mock’s shared store', () => {
  it('stores a small streamed body whole, in files another process reads', async () => {
    const bytes = Buffer.from('PGDMP small dump');
    const { sizeBytes } = await putPrivateStream('exports/a.dump', streamOf(bytes, 4), 'x/y');
    expect(sizeBytes).toBe(bytes.length);

    // What another process sees: the files alone, through a store it never wrote.
    const index = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(index)).toEqual(['motir-private/exports/a.dump']);
    expect(readFakeBlobObject('motir-private/exports/a.dump')).toEqual(bytes);
    expect(existsSync(fakeBlobObjectFile(statePath, 'motir-private/exports/a.dump'))).toBe(true);

    // A boot of another process's seam never wipes the shared store.
    installBlobStoreMock();
    expect(await getPrivateBlobBytes('exports/a.dump')).toEqual(bytes);
    expect(await headPrivateBlob('exports/a.dump')).toMatchObject({ size: bytes.length });
  });

  it('assembles a multipart upload in part order', async () => {
    const bytes = patterned(33 * 1024 * 1024);
    const { sizeBytes } = await putPrivateStream('exports/big.dump', streamOf(bytes), 'x/y');
    expect(sizeBytes).toBe(bytes.length);
    expect(readFakeBlobObject('motir-private/exports/big.dump')!.equals(bytes)).toBe(true);
  }, 60_000);

  it('deletes the index entry and the bytes file', async () => {
    await putPrivateStream('exports/gone.dump', streamOf(Buffer.from('x')), 'x/y');
    const file = fakeBlobObjectFile(statePath, 'motir-private/exports/gone.dump');
    await deleteAttachmentBlob('exports/gone.dump');
    expect(existsSync(file)).toBe(false);
    expect(readFakeBlobObject('motir-private/exports/gone.dump')).toBeNull();
    expect(await headPrivateBlob('exports/gone.dump')).toBeNull();
    // Idempotent, as the real store is.
    await expect(deleteAttachmentBlob('exports/gone.dump')).resolves.toBeUndefined();
  });

  it('reads a torn index as empty, and the next write replaces it', async () => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, '{"motir-private/');
    expect(readFakeBlobObject('motir-private/anything')).toBeNull();
    await putPrivateStream('exports/after.dump', streamOf(Buffer.from('ok')), 'x/y');
    expect(readFakeBlobObject('motir-private/exports/after.dump')).toEqual(Buffer.from('ok'));
  });

  it('answers null for an index entry whose bytes file is gone', async () => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({ 'motir-private/k': { contentType: 'x/y', file: `${statePath}.missing` } }),
    );
    expect(readFakeBlobObject('motir-private/k')).toBeNull();
  });

  it('keeps each process’s objects to itself with the variable unset', async () => {
    vi.stubEnv(FAKE_BLOB_STATE_PATH_ENV, '');
    installBlobStoreMock();
    await putPrivateStream('exports/mem.dump', streamOf(Buffer.from('mem')), 'x/y');
    expect(await getPrivateBlobBytes('exports/mem.dump')).toEqual(Buffer.from('mem'));
    expect(existsSync(statePath)).toBe(false);
    await deleteAttachmentBlob('exports/mem.dump');
    expect(await getPrivateBlobBytes('exports/mem.dump')).toBeNull();
  });
});

describe('the transport’s multipart and framing edges', () => {
  async function text(body: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8');
  }

  it('aborts an upload, after which completing it is NoSuchUpload', async () => {
    const transport = createObjectStoreTransport();
    const created = await transport.handle({
      method: 'POST',
      path: '/motir-private/k.dump?uploads',
      headers: {},
    });
    const uploadId = /<UploadId>(.+)<\/UploadId>/.exec(await text(created.response.body))![1]!;
    const part = await transport.handle({
      method: 'PUT',
      path: '/motir-private/k.dump',
      query: { partNumber: '1', uploadId, ignored: undefined },
      body: Buffer.from('part'),
    });
    expect(part.response.headers['etag']).toBe('"e2e-part-1"');

    const aborted = await transport.handle({
      method: 'DELETE',
      path: '/motir-private/k.dump',
      query: { uploadId: [uploadId] },
    });
    expect(aborted.response.statusCode).toBe(204);
    const completed = await transport.handle({
      method: 'POST',
      path: `/motir-private/k.dump?uploadId=${uploadId}`,
      body: '<CompleteMultipartUpload/>',
    });
    expect(completed.response.statusCode).toBe(404);
    expect(await text(completed.response.body)).toContain('NoSuchUpload');
    expect(readFakeBlobObject('motir-private/k.dump')).toBeNull();
  });

  it('refuses a part addressed to another key under the same upload id', async () => {
    const transport = createObjectStoreTransport();
    const created = await transport.handle({ method: 'POST', path: '/b/one?uploads' });
    const uploadId = /<UploadId>(.+)<\/UploadId>/.exec(await text(created.response.body))![1]!;
    const wrong = await transport.handle({
      method: 'PUT',
      path: `/b/two?partNumber=1&uploadId=${uploadId}`,
      body: new Uint8Array([1]),
    });
    expect(wrong.response.statusCode).toBe(404);
  });

  it('decodes an aws-chunked body on a plain PUT', async () => {
    const transport = createObjectStoreTransport();
    const framed = Buffer.from(
      '5;chunk-signature=x\r\nhello\r\n6\r\n world\r\n0\r\nx-amz-trailer:1\r\n\r\n',
    );
    await transport.handle({
      method: 'PUT',
      path: '/motir-private/framed',
      headers: { 'content-encoding': 'aws-chunked', 'content-type': 'text/plain' },
      body: framed,
    });
    const got = await transport.handle({ method: 'GET', path: '/motir-private/framed' });
    expect(got.response.headers['content-type']).toBe('text/plain');
    expect(await text(got.response.body)).toBe('hello world');
  });

  it('drains a streamed body to its end', async () => {
    const transport = createObjectStoreTransport();
    await transport.handle({
      method: 'PUT',
      path: '/motir-private/streamed',
      body: Readable.from([Buffer.from('ab'), 'cd', new Uint8Array([101])]),
    });
    expect(readFakeBlobObject('motir-private/streamed')).toEqual(Buffer.from('abcde'));
  });

  it('decodeAwsChunked stops at a frame with no line end, and reads nothing from nothing', () => {
    expect(decodeAwsChunked(Buffer.from('3\r\nabc\r\n3'))).toEqual(Buffer.from('abc'));
    expect(decodeAwsChunked(Buffer.alloc(0))).toEqual(Buffer.alloc(0));
    expect(decodeAwsChunked(Buffer.from('zz\r\n'))).toEqual(Buffer.alloc(0));
  });

  it('stores an unrecognised body as empty, with the default content type', async () => {
    const transport = createObjectStoreTransport();
    await transport.handle({ method: 'PUT', path: '/motir-private/odd', body: 42 });
    const head = await transport.handle({ method: 'HEAD', path: '/motir-private/odd' });
    expect(head.response.headers).toMatchObject({
      'content-length': '0',
      'content-type': 'application/octet-stream',
    });
  });
});

describe('readFakeExportDump', () => {
  it('reads an export from the lane’s private bucket, and refuses outside the lane', async () => {
    const { readFakeExportDump } = await import('../e2e/_helpers/hosting-grace-fakes');
    const { E2E_OBJECT_STORE_ENV } = await import('../e2e/_helpers/e2e-object-store-env');
    vi.stubEnv('MOTIR_S3_PRIVATE_BUCKET', E2E_OBJECT_STORE_ENV.MOTIR_S3_PRIVATE_BUCKET);
    resetS3ClientForTests();
    installBlobStoreMock();
    await putPrivateStream('hosting-exports/w/a/e.dump', streamOf(Buffer.from('PGDMP')), 'x/y');
    expect(readFakeExportDump('hosting-exports/w/a/e.dump')).toEqual(Buffer.from('PGDMP'));
    expect(readFakeExportDump('hosting-exports/w/a/none.dump')).toBeNull();
    vi.stubEnv(FAKE_BLOB_STATE_PATH_ENV, ' ');
    expect(() => readFakeExportDump('x')).toThrow(/run under the acceptance lane/);
  });
});
