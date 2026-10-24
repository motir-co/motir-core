import { createPrivateKey, randomBytes, webcrypto } from 'node:crypto';

type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;
type SignAlgorithm = webcrypto.Algorithm | webcrypto.EcdsaParams;
import * as x509 from '@peculiar/x509';

// The certificates of the AWS agent hoster's MUTUAL TLS (Story MOTIR-9361 ·
// MOTIR-9470, `docs/decisions/aws-hoster-host-agent.md`). One Motir-wide
// certificate authority signs:
//
//   - a SERVER certificate per instance, minted at provision, valid for a year,
//     whose subject names the instance. It and its private key travel only in
//     the instance's config document (its user-data), so the host agent on 8443
//     can prove it is that instance's agent and nothing else's;
//   - Motir's one CLIENT certificate, which the exec client and the terminal
//     relay present, and the only certificate the host agent accepts.
//
// The keys are ECDSA P-256 with SHA-256 signatures. A CA key may be EC P-256 or
// RSA; it is read from PEM (PKCS#8 or the SEC1 / PKCS#1 forms `openssl` writes).
//
// ⚠️ A PRIVATE KEY IS A SECRET. Nothing here logs one or puts one in an error.

/** How long a server certificate is valid from its mint (one year). */
export const HOST_CERTIFICATE_VALIDITY_DAYS = 365;

/** A server certificate with fewer days than this left is reissued at the next
 *  wake (MOTIR-9481). */
export const HOST_CERTIFICATE_RENEW_BEFORE_DAYS = 60;

/** How far `notBefore` is backdated, for clock skew between Motir and a host. */
const CLOCK_SKEW_MS = 5 * 60_000;

const DAY_MS = 86_400_000;

const EC_KEY: webcrypto.EcKeyGenParams & { hash: string } = {
  name: 'ECDSA',
  namedCurve: 'P-256',
  hash: 'SHA-256',
};
const RSA_SIGN = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

const subtle = webcrypto.subtle;

/** A certificate and its private key, PEM. */
export interface HostCertificatePem {
  readonly certPem: string;
  readonly keyPem: string;
}

/** A CA key that cannot sign — refused without its bytes in the message. */
export class HostCertificateError extends Error {
  readonly code = 'AWS_HOST_CERTIFICATE_REFUSED' as const;
  constructor(readonly reason: 'unsupported_key' | 'unreadable_key' | 'unreadable_certificate') {
    super(
      reason === 'unsupported_key'
        ? 'The hoster CA key is neither EC P-256 nor RSA.'
        : reason === 'unreadable_key'
          ? 'The hoster CA key is not a readable PEM private key.'
          : 'The hoster CA certificate is not a readable PEM certificate.',
    );
    this.name = 'HostCertificateError';
  }
}

function toPem(der: ArrayBuffer, label: string): string {
  const body = Buffer.from(der)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** A signing key and its algorithm, from a PEM private key of either kind. */
async function signingKeyOf(keyPem: string): Promise<{ key: CryptoKey; algorithm: SignAlgorithm }> {
  let pkcs8: Buffer;
  let type: string | undefined;
  let curve: string | undefined;
  try {
    const key = createPrivateKey(keyPem);
    type = key.asymmetricKeyType;
    curve = key.asymmetricKeyDetails?.namedCurve;
    pkcs8 = key.export({ format: 'der', type: 'pkcs8' });
  } catch {
    throw new HostCertificateError('unreadable_key');
  }
  if (type === 'ec' && curve === 'prime256v1') {
    const key = await subtle.importKey('pkcs8', pkcs8, EC_KEY, false, ['sign']);
    return { key, algorithm: EC_KEY };
  }
  if (type === 'rsa') {
    const key = await subtle.importKey('pkcs8', pkcs8, RSA_SIGN, false, ['sign']);
    return { key, algorithm: RSA_SIGN };
  }
  throw new HostCertificateError('unsupported_key');
}

function readCertificate(pem: string): x509.X509Certificate {
  try {
    return new x509.X509Certificate(pem);
  } catch {
    throw new HostCertificateError('unreadable_certificate');
  }
}

async function newKeyPair(): Promise<CryptoKeyPair> {
  return subtle.generateKey(EC_KEY, true, ['sign', 'verify']);
}

async function privatePem(keys: CryptoKeyPair): Promise<string> {
  return toPem(await subtle.exportKey('pkcs8', keys.privateKey), 'PRIVATE KEY');
}

function serial(): string {
  // Positive (top bit clear) 128-bit serial, as RFC 5280 asks.
  const bytes = randomBytes(16);
  bytes[0] = bytes[0]! & 0x7f;
  return bytes.toString('hex');
}

/** Sign a leaf certificate for `subject` with `usage`, valid `days` from `now`. */
async function leaf(input: {
  ca: HostCertificatePem;
  subject: string;
  usage: 'server' | 'client';
  now: Date;
  days: number;
}): Promise<HostCertificatePem> {
  const issuer = readCertificate(input.ca.certPem);
  const { key: signingKey, algorithm } = await signingKeyOf(input.ca.keyPem);
  const keys = await newKeyPair();
  const cert = await x509.X509CertificateGenerator.create(
    {
      serialNumber: serial(),
      subject: input.subject,
      issuer: issuer.subject,
      notBefore: new Date(input.now.getTime() - CLOCK_SKEW_MS),
      notAfter: new Date(input.now.getTime() + input.days * DAY_MS),
      publicKey: keys.publicKey,
      signingKey,
      signingAlgorithm: algorithm,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension(
          [
            input.usage === 'server'
              ? x509.ExtendedKeyUsage.serverAuth
              : x509.ExtendedKeyUsage.clientAuth,
          ],
          false,
        ),
        await x509.AuthorityKeyIdentifierExtension.create(issuer, false, webcrypto),
      ],
    },
    webcrypto,
  );
  return { certPem: cert.toString('pem'), keyPem: await privatePem(keys) };
}

/** The subject of an instance's server certificate. */
export function hostServerSubject(instanceId: string): string {
  return `CN=motir-instance-${instanceId.replace(/[,+=<>#;"\\]/g, '_')}, O=Motir`;
}

/**
 * Mint one instance's SERVER certificate, signed by the hoster CA, valid for
 * {@link HOST_CERTIFICATE_VALIDITY_DAYS} from `now`, with the instance id in its
 * subject. A fresh key pair every call.
 */
export function mintHostServerCertificate(input: {
  ca: HostCertificatePem;
  instanceId: string;
  now: Date;
}): Promise<HostCertificatePem> {
  return leaf({
    ca: input.ca,
    subject: hostServerSubject(input.instanceId),
    usage: 'server',
    now: input.now,
    days: HOST_CERTIFICATE_VALIDITY_DAYS,
  });
}

/** Mint a CLIENT certificate signed by the hoster CA — Motir's own, issued once
 *  by the secrets card's procedure, and what a test presents. */
export function mintHostClientCertificate(input: {
  ca: HostCertificatePem;
  name: string;
  now: Date;
  days?: number;
}): Promise<HostCertificatePem> {
  return leaf({
    ca: input.ca,
    subject: `CN=${input.name.replace(/[,+=<>#;"\\]/g, '_')}, O=Motir`,
    usage: 'client',
    now: input.now,
    days: input.days ?? HOST_CERTIFICATE_VALIDITY_DAYS,
  });
}

/** Mint a self-signed hoster CA (EC P-256) — the secrets card's one-off, and
 *  what a test trusts. */
export async function mintHostCertificateAuthority(input: {
  name: string;
  now: Date;
  days: number;
}): Promise<HostCertificatePem> {
  const keys = await newKeyPair();
  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: serial(),
      name: `CN=${input.name.replace(/[,+=<>#;"\\]/g, '_')}, O=Motir`,
      keys,
      signingAlgorithm: EC_KEY,
      notBefore: new Date(input.now.getTime() - CLOCK_SKEW_MS),
      notAfter: new Date(input.now.getTime() + input.days * DAY_MS),
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
          true,
        ),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey, false, webcrypto),
      ],
    },
    webcrypto,
  );
  return { certPem: cert.toString('pem'), keyPem: await privatePem(keys) };
}

/** A certificate's validity end, or null when the PEM is not a readable
 *  certificate. Never throws, and never puts the PEM in an error. */
export function certificateNotAfter(certPem: string | null | undefined): Date | null {
  if (!certPem) return null;
  try {
    return new x509.X509Certificate(certPem).notAfter;
  } catch {
    return null;
  }
}

/**
 * Whether a server certificate must be reissued (MOTIR-9481): fewer than
 * {@link HOST_CERTIFICATE_RENEW_BEFORE_DAYS} left, already past its end, or no
 * readable certificate at all (which counts as expired).
 */
export function hostCertificateNeedsRenewal(
  certPem: string | null | undefined,
  now: Date,
): boolean {
  const notAfter = certificateNotAfter(certPem);
  if (!notAfter) return true;
  return notAfter.getTime() - now.getTime() < HOST_CERTIFICATE_RENEW_BEFORE_DAYS * DAY_MS;
}
