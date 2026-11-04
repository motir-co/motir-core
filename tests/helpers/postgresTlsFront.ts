// A TLS front for Postgres and a throwaway CA, for a test that runs a bundle in
// a child process with `sslmode=verify-full` (MOTIR-10264 · MOTIR-10301): the
// child's connection really verifies a certificate, against a CA it is given as
// `NODE_EXTRA_CA_CERTS`, as a Fargate task verifies the RDS one.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';

/** Postgres's SSLRequest code (protocol 1234.5679). */
const SSL_REQUEST_CODE = 80877103;

/**
 * A TLS front for Postgres: it answers the SSLRequest with `S`, terminates TLS
 * with `cert`, and relays the plaintext protocol to the real server — so the
 * child's `verify-full` connection really verifies a certificate.
 */
export function startTlsFront(
  upstream: { host: string; port: number },
  cert: { key: string; cert: string },
): Promise<{ port: number; handshakes: () => number; close: () => Promise<void> }> {
  let handshakes = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.once('data', (chunk) => {
      if (chunk.length < 8 || chunk.readInt32BE(4) !== SSL_REQUEST_CODE) {
        socket.destroy(); // a plaintext client: the front speaks TLS only
        return;
      }
      socket.write('S');
      const secure = new tls.TLSSocket(socket, { isServer: true, ...cert });
      secure.on('error', () => socket.destroy());
      secure.once('secure', () => {
        handshakes += 1;
        const up = net.connect(upstream.port, upstream.host);
        up.on('error', () => secure.destroy());
        secure.pipe(up);
        up.pipe(secure);
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        port,
        handshakes: () => handshakes,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** A throwaway CA and a server certificate for localhost it signed, made by `openssl`. */
export function makeCertificates(dir: string): { caPath: string; key: string; cert: string } {
  const at = (name: string) => path.join(dir, name);
  const openssl = (args: string[]) => execFileSync('openssl', args, { stdio: 'pipe' });
  openssl([
    ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1'],
    ...['-subj', '/CN=bundle test CA', '-keyout', at('ca.key'), '-out', at('ca.pem')],
    ...['-addext', 'basicConstraints=critical,CA:TRUE'],
    ...['-addext', 'keyUsage=critical,keyCertSign,cRLSign'],
  ]);
  openssl([
    ...['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost'],
    ...['-keyout', at('server.key'), '-out', at('server.csr')],
  ]);
  writeFileSync(
    at('server.ext'),
    'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
  );
  openssl([
    ...['x509', '-req', '-in', at('server.csr'), '-CA', at('ca.pem'), '-CAkey', at('ca.key')],
    ...['-CAcreateserial', '-days', '1', '-out', at('server.pem'), '-extfile', at('server.ext')],
  ]);
  return {
    caPath: at('ca.pem'),
    key: readFileSync(at('server.key'), 'utf8'),
    cert: readFileSync(at('server.pem'), 'utf8'),
  };
}
