// The serverless deploy-check fixture's server (MOTIR-9975). `GET /health`
// connects to DATABASE_URL and runs `select 1`: 200 with the release label and
// `database: reachable`, or 503 with `database: unreachable`. It never echoes a
// connection string or any other env value. `node server.mjs migrate` is the
// manifest's migrateCommand: there is nothing to migrate.
import { createServer } from 'node:http';

const release = process.env.MOTIR_FIXTURE_RELEASE ?? 'unlabelled';
const port = Number(process.env.PORT ?? 8080);

async function databaseReachable() {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

function answer(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

if (process.argv[2] === 'migrate') {
  process.exit(0);
}

createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/health') return answer(res, 404, {});
  databaseReachable().then(
    (ok) =>
      ok
        ? answer(res, 200, { release, database: 'reachable' })
        : answer(res, 503, { database: 'unreachable' }),
    () => answer(res, 503, { database: 'unreachable' }),
  );
}).listen(port);
