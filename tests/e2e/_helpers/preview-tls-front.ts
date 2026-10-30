import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer, type Server } from 'node:https';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// THE PREVIEW HOST'S HTTPS FRONT for the acceptance lane (Story MOTIR-5766 ·
// MOTIR-5781).
//
// A preview host is HTTPS on every deployed environment, and the shipped gate
// writes it that way: the admission redirect, the post-handshake return and the
// relayed `location` are all `https://<host>/…`, the gate cookie is `__Host-`
// (Secure, no Domain), and `previewUrl()` composes `https://` unless a lane says
// otherwise. So the lane serves the preview host the way production does — over
// TLS, on the default port — rather than teaching the product a plain-HTTP shape
// it never runs.
//
// How: this front terminates TLS on a loopback port with a throwaway self-signed
// certificate (generated per run by `openssl`, never committed) and relays every
// request to the app server with its Host header intact; the spec launches
// Chromium with a host-resolver rule mapping `*.<preview domain>` to this port
// and accepts the certificate. The app server therefore answers exactly the
// request a viewer's browser would send it behind the edge.

export interface PreviewTlsFront {
  /** Close the listener and remove the certificate. */
  stop(): Promise<void>;
}

/** Response headers a relay re-frames itself. */
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding'];

function selfSignedCertificate(dir: string): { key: Buffer; cert: Buffer } {
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=preview.localhost',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

function forwardable(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...headers };
  for (const name of HOP_BY_HOP) delete out[name];
  return out;
}

/** Start the front on `127.0.0.1:port`, relaying to `appOrigin` (`http://…`). */
export async function startPreviewTlsFront(
  port: number,
  appOrigin: string,
): Promise<PreviewTlsFront> {
  const dir = mkdtempSync(join(tmpdir(), 'preview-tls-'));
  const app = new URL(appOrigin);
  const server: Server = createServer(selfSignedCertificate(dir), (req, res) => {
    const upstream = httpRequest(
      {
        host: app.hostname,
        port: app.port,
        method: req.method,
        path: req.url,
        // The viewer's Host header, untouched: it is how the app knows the
        // request is for a preview host at all.
        headers: { ...forwardable(req.headers), 'x-forwarded-proto': 'https' },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, forwardable(answer.headers));
        answer.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`preview TLS front: ${error.message}`);
    });
    req.pipe(upstream);
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return {
    async stop() {
      server.closeAllConnections();
      await promisify(server.close.bind(server))();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
