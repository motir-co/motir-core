import { describe, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// MOTIR-10056: on Fargate, core's pg driver adapter verifies the database
// certificate (node-postgres treats `sslmode=require` as verify-full), and Node
// does not ship Amazon's RDS roots. motir-infra sets NODE_EXTRA_CA_CERTS to the
// path below, so the image must carry the bundle there, and the bundle must hold
// the root the RDS instances are issued from (`rds-ca-rsa2048-g1` in us-east-1).

const BUNDLE = join(process.cwd(), 'certs/rds-global-bundle.pem');
const IMAGE_PATH = '/app/certs/rds-global-bundle.pem';

function certificates(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((block) => new X509Certificate(block));
}

/** The runner stage, from its FROM line to the end of the file. */
function runnerStage(dockerfile: string): string {
  const at = dockerfile.search(/^FROM \S+ AS runner$/m);
  expect(at, 'the Dockerfile has a runner stage').toBeGreaterThan(-1);
  return dockerfile.slice(at);
}

describe('the RDS CA bundle baked into the image (MOTIR-10056)', () => {
  const pem = readFileSync(BUNDLE, 'utf8');
  const certs = certificates(pem);

  it('is a bundle of CA certificates and nothing else', () => {
    expect(certs.length).toBeGreaterThan(10);
    expect(pem).not.toMatch(/PRIVATE KEY/);
    for (const cert of certs) {
      expect(cert.ca, cert.subject).toBe(true);
      // Node escapes the comma in the organisation: `Amazon Web Services\, Inc.`.
      expect(cert.subject).toMatch(/O=Amazon Web Services\\?, Inc\./);
    }
  });

  it("holds the us-east-1 root the production instances' certificates chain to", () => {
    const roots = certs.filter((c) => /CN=Amazon RDS us-east-1 Root CA RSA2048 G1/.test(c.subject));
    expect(roots.length).toBeGreaterThan(0);
    // A root is self-issued and still valid.
    const now = Date.now();
    expect(
      roots.some(
        (c) =>
          c.subject === c.issuer &&
          new Date(c.validFrom).getTime() < now &&
          new Date(c.validTo).getTime() > now,
      ),
    ).toBe(true);
  });

  it('is copied into the runner stage at the path motir-infra names', () => {
    const runner = runnerStage(readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8'));
    expect(runner).toMatch(
      /^COPY --chown=nextjs:nodejs certs\/rds-global-bundle\.pem \.\/certs\/rds-global-bundle\.pem$/m,
    );
    // WORKDIR /app makes the relative destination IMAGE_PATH, the path infra uses.
    expect(runner).toMatch(/^WORKDIR \/app$/m);
    expect(IMAGE_PATH.startsWith('/app/')).toBe(true);
  });

  it('is not excluded from the build context or from git', () => {
    const dockerignore = readFileSync(join(process.cwd(), '.dockerignore'), 'utf8');
    expect(dockerignore).not.toMatch(/^(?:\*\*\/)?\*\.pem$|^\/?certs\/?$/m);
    const gitignore = readFileSync(join(process.cwd(), '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^!\/certs\/rds-global-bundle\.pem$/m);
  });
});
