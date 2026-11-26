import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Client } from 'pg';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from './adminDb';
import { adminConnectionString } from './parallelDb';

// THE DATABASE EXPORT'S WORLD (Story MOTIR-9800 · MOTIR-12134), shared by the
// export's service, restore and route suites: an organisation with a `grace`
// application; a small REAL Postgres database for `pg_dump` to read; and an
// in-memory private object store standing in for `lib/blob/uploader.ts` (the
// module's own stated test seam), which keeps the bytes so a restore can read
// them back.

/** A stored object: its bytes and the content type it was written with. */
export interface StoredObject {
  bytes: Buffer;
  contentType: string;
}

/** The in-memory private store. `failNextUpload` makes the next upload drain
 *  its stream and then fail with that HTTP status, as S3 would. */
export function createObjectStore() {
  const objects = new Map<string, StoredObject>();
  const deleted: string[] = [];
  const store = {
    objects,
    deleted,
    failNextUpload: null as number | null,
    async putPrivateStream(key: string, body: Readable, contentType: string) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
      const failure = store.failNextUpload;
      if (failure !== null) {
        store.failNextUpload = null;
        // A multipart upload can leave a partial object behind before it fails.
        objects.set(key, { bytes: Buffer.concat(chunks).subarray(0, 1), contentType });
        throw Object.assign(new Error('SlowDown'), { $metadata: { httpStatusCode: failure } });
      }
      const bytes = Buffer.concat(chunks);
      objects.set(key, { bytes, contentType });
      return { key, sizeBytes: bytes.length };
    },
    async deleteAttachmentBlob(key: string) {
      deleted.push(key);
      objects.delete(key);
    },
    async signedDownloadUrl(key: string, opts: { ttlSeconds?: number; download?: boolean } = {}) {
      return `https://store.test.invalid/${key}?ttl=${opts.ttlSeconds}&download=${opts.download}`;
    },
  };
  return store;
}
export type ObjectStore = ReturnType<typeof createObjectStore>;

/** A connection string to a database on the test cluster. */
function urlFor(dbname: string): string {
  const url = new URL(adminConnectionString());
  url.pathname = `/${dbname}`;
  return url.toString();
}

async function admin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminConnectionString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A fresh, empty database on the test cluster; returns its name and URL. */
export async function createScratchDatabase(prefix: string) {
  const name = `${prefix}_${randomBytes(4).toString('hex')}`;
  await admin((c) => c.query(`CREATE DATABASE "${name}"`));
  return { name, url: urlFor(name) };
}

export async function dropScratchDatabase(name: string): Promise<void> {
  await admin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
}

/** Run SQL against one database. */
export async function onDatabase<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A tenant's production database in miniature: two tables, a foreign key, a
 *  sequence and rows with awkward values. */
export async function seedTenantDatabase(url: string): Promise<void> {
  await onDatabase(url, async (c) => {
    await c.query(`
      CREATE TABLE customer (id serial PRIMARY KEY, name text NOT NULL, meta jsonb);
      CREATE TABLE "order" (
        id bigserial PRIMARY KEY,
        customer_id int NOT NULL REFERENCES customer(id),
        total numeric(12,2) NOT NULL,
        placed_at timestamptz NOT NULL
      );
      INSERT INTO customer (name, meta) VALUES
        ('Ada', '{"tier":"gold"}'), ('Bö «quoted»', NULL), (E'tab\\tnewline\\n', '[]');
      INSERT INTO "order" (customer_id, total, placed_at) VALUES
        (1, 10.50, '2026-11-01T10:00:00Z'), (1, 0.01, '2026-11-02T10:00:00Z'),
        (3, 99999.99, '2026-11-03T10:00:00Z');
    `);
  });
}

/** Every table's rows, ordered, so two databases can be compared. */
export async function snapshotTenantDatabase(url: string) {
  return onDatabase(url, async (c) => ({
    customers: (await c.query('SELECT id, name, meta FROM customer ORDER BY id')).rows,
    orders: (
      await c.query('SELECT id::text, customer_id, total::text, placed_at FROM "order" ORDER BY id')
    ).rows,
  }));
}

export interface ExportWorld {
  fx: WorkItemFixture;
  organizationId: string;
  applicationId: string;
}

let seq = 0;

/** An organisation whose owner is its admin, with one serverless or Fly
 *  application in `state` (a `grace` one by default). */
export async function seedExportWorld(
  opts: { target?: 'fly' | 'serverless' | 'aws'; state?: string } = {},
): Promise<ExportWorld> {
  seq += 1;
  const fx = await makeWorkItemFixture({ name: `Exp ${seq}` });
  const repo = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name: `web-${seq}`,
      position: `x${seq}`,
      seedSource: 'initialised',
      state: 'created',
    },
  });
  const app = await adminDb.hostedApplication.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      projectRepositoryId: repo.id,
      target: opts.target ?? 'fly',
      slug: `web-${seq}`,
      state: (opts.state ?? 'grace') as 'grace',
      databaseProjectId: `neon-${seq}`,
    },
  });
  return { fx, organizationId: fx.workspace.organizationId, applicationId: app.id };
}

/** Add a user to the organisation with `role`. */
export async function addOrgMember(
  organizationId: string,
  userId: string,
  role: 'member' | 'admin',
): Promise<void> {
  await adminDb.organizationMembership.create({ data: { organizationId, userId, role } });
}
