// The AWS deploy check's FIXTURE APP (MOTIR-10011): the smallest HTTP app that
// proves a release reaches its database. `GET /health` answers 200; `GET /row`
// seeds a one-row `deploy_check` table the first time (the fixture seeds itself
// because migrations are another card's) and answers `{ release, row }`, where
// `release` is baked in at image build (`--build-arg RELEASE=1|2`). One image
// serves both AWS shapes: the Lambda Web Adapter the Dockerfile copies in turns
// Lambda invocations into these HTTP requests, and ECS runs it as it is.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const SEED = [
  'CREATE TABLE IF NOT EXISTS deploy_check (id integer PRIMARY KEY, note text NOT NULL)',
  "INSERT INTO deploy_check (id, note) VALUES (1, 'seeded by the deploy check fixture') ON CONFLICT (id) DO NOTHING",
];
const READ = 'SELECT id, note FROM deploy_check ORDER BY id LIMIT 1';

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The app over `query(sql) → { rows }`; the release is a string from the build. */
export function createFixtureServer({ release, query }) {
  let seeded = null;
  const seed = async () => {
    for (const sql of SEED) await query(sql);
  };
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname;
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    if (path === '/health') return send(res, 200, { ok: true, release });
    if (path !== '/row') return send(res, 404, { error: 'not found' });
    try {
      seeded ??= seed().catch((err) => {
        seeded = null;
        throw err;
      });
      await seeded;
      const { rows } = await query(READ);
      return send(res, 200, { release, row: rows[0] ?? null });
    } catch {
      // Never the connection string or the driver's message: a database that
      // is waking answers 503 and the deploy check retries.
      return send(res, 503, { error: 'database unavailable', release });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const server = createFixtureServer({
    release: process.env.MOTIR_FIXTURE_RELEASE ?? 'unknown',
    query: (sql) => pool.query(sql),
  });
  server.listen(Number(process.env.PORT ?? 8080));
}
