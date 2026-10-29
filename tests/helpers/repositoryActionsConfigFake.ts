import sodium from 'libsodium-wrappers';

// A stateful fake of GitHub's REPOSITORY Actions secrets and variables endpoints
// (Story MOTIR-5766 · MOTIR-5775), shared by every suite whose flow switches
// previews on or off — establishment, the sweep, the takeover saga.
//
// It holds a real libsodium key pair per repository and serves its public key, so
// a test can OPEN the sealed value a write sent and prove two things at once: the
// write carried the right value, and the request carried it only sealed. Every
// request is recorded with its raw body for exactly that second assertion.

export interface RepositoryActionsCall {
  url: string;
  method: string;
  /** The body exactly as sent — what a no-plaintext assertion searches. */
  rawBody: string | null;
}

export interface RepositoryActionsConfigFake {
  /** Handle a repository Actions secret/variable request, or null when the URL is
   *  not one, so a suite chains it into its own `fetch` fake. */
  handle(url: string, method: string, rawBody: string | null): Promise<Response | null>;
  readonly calls: RepositoryActionsCall[];
  /** The DECRYPTED secrets of `owner/repo`, by name. */
  secrets(fullName: string): Map<string, string>;
  /** The variables of `owner/repo`, by name. */
  variables(fullName: string): Map<string, string>;
  /** Make the next call whose method and URL suffix match fail with `status`. */
  failNext(method: string, urlSuffix: string, status: number): void;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const PATH = /\/repos\/([^/]+)\/([^/]+)\/actions\/(secrets|variables)(?:\/([^/]+))?$/;

export function createRepositoryActionsConfigFake(): RepositoryActionsConfigFake {
  const calls: RepositoryActionsCall[] = [];
  const keys = new Map<string, sodium.KeyPair>();
  const secrets = new Map<string, Map<string, string>>();
  const variables = new Map<string, Map<string, string>>();
  const failures: Array<{ method: string; urlSuffix: string; status: number }> = [];

  const of = <T>(store: Map<string, Map<string, T>>, repo: string) => {
    let entry = store.get(repo);
    if (!entry) store.set(repo, (entry = new Map()));
    return entry;
  };

  async function keyPair(repo: string): Promise<sodium.KeyPair> {
    await sodium.ready;
    let pair = keys.get(repo);
    if (!pair) keys.set(repo, (pair = sodium.crypto_box_keypair()));
    return pair;
  }

  return {
    calls,
    secrets: (fullName) => of(secrets, fullName),
    variables: (fullName) => of(variables, fullName),
    failNext(method, urlSuffix, status) {
      failures.push({ method, urlSuffix, status });
    },
    async handle(url, method, rawBody) {
      const match = PATH.exec(url);
      if (!match) return null;
      calls.push({ url, method, rawBody });
      const failure = failures.findIndex((f) => f.method === method && url.endsWith(f.urlSuffix));
      if (failure >= 0) {
        const [f] = failures.splice(failure, 1);
        return json(f!.status, { message: 'refused by the fake' });
      }
      const repo = `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`;
      const kind = match[3]!;
      const name = match[4] ? decodeURIComponent(match[4]) : null;
      const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};

      if (kind === 'secrets') {
        const pair = await keyPair(repo);
        if (name === 'public-key' && method === 'GET') {
          return json(200, {
            key_id: `key-${repo}`,
            key: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL),
          });
        }
        const held = of(secrets, repo);
        if (method === 'PUT' && name) {
          if (body['key_id'] !== `key-${repo}`) return json(422, { message: 'bad key id' });
          const opened = sodium.crypto_box_seal_open(
            sodium.from_base64(String(body['encrypted_value']), sodium.base64_variants.ORIGINAL),
            pair.publicKey,
            pair.privateKey,
          );
          const existed = held.has(name);
          held.set(name, sodium.to_string(opened));
          return new Response(null, { status: existed ? 204 : 201 });
        }
        if (method === 'DELETE' && name) {
          if (!held.delete(name)) return json(404, { message: 'Not Found' });
          return new Response(null, { status: 204 });
        }
      } else {
        const held = of(variables, repo);
        if (!name && method === 'POST') {
          const variable = String(body['name']);
          if (held.has(variable)) return json(409, { message: 'Already exists' });
          held.set(variable, String(body['value']));
          return json(201, {});
        }
        if (name && method === 'GET') {
          const value = held.get(name);
          return value === undefined
            ? json(404, { message: 'Not Found' })
            : json(200, { name, value });
        }
        if (name && method === 'PATCH') {
          if (!held.has(name)) return json(404, { message: 'Not Found' });
          held.set(name, String(body['value']));
          return new Response(null, { status: 204 });
        }
        if (name && method === 'DELETE') {
          if (!held.delete(name)) return json(404, { message: 'Not Found' });
          return new Response(null, { status: 204 });
        }
      }
      return json(405, { message: `unhandled ${method} ${url}` });
    },
  };
}
