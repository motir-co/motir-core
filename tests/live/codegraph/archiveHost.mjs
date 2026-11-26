/* eslint-disable no-console -- a standalone process: its console is its log. */
// THE LOCAL ARCHIVE HOST (MOTIR-12260) — its own process, started by the lane script.
//
// GitHub's `tarball/{ref}` answers a 302 to a pre-signed codeload URL, and
// motir-codegraph's worker downloads the archive from there, from ITS process. So the
// archive must be served by something that worker can reach over the network, and it
// fetches https only: this serves `GET /archive/<sha>.tar.gz` over TLS, with a
// certificate the lane mints and hands the codegraph worker as an extra CA.
//
//   LIVE_SCENARIO     the scenario file (`scenario.mjs`), read on every request
//   LIVE_ARCHIVE_PORT the port, on 127.0.0.1
//   LIVE_TLS_KEY / LIVE_TLS_CERT  the certificate's PEM files
//
// The query string (the "pre-signed" token) is accepted and never logged.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { readScenario, tarballOf } from './scenario.mjs';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`archiveHost: ${name} is not set`);
  return value;
}

const scenarioPath = required('LIVE_SCENARIO');
const port = Number(required('LIVE_ARCHIVE_PORT'));

const server = createServer(
  { key: readFileSync(required('LIVE_TLS_KEY')), cert: readFileSync(required('LIVE_TLS_CERT')) },
  (req, res) => {
    const match = /^\/archive\/([0-9a-f]{40})\.tar\.gz$/.exec(
      new URL(req.url, 'https://x').pathname,
    );
    const body = match ? tarballOf(readScenario(scenarioPath), match[1]) : null;
    console.log(
      `[archive-host] ${req.method} ${match ? match[1] : 'unknown path'} → ${body ? 200 : 404}`,
    );
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': body.length });
    res.end(body);
  },
);

server.listen(port, '127.0.0.1', () =>
  console.log(`[archive-host] listening on 127.0.0.1:${port}`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
