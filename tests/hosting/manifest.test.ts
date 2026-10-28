// MOTIR-9803 — the hosting manifest parser, against the decision of record's
// field table (MOTIR-5769 §7). Pure: no database, no network.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostingManifestInvalidError, HostingManifestMissingError } from '@/lib/hosting/errors';
import { HOSTING_MANIFEST_FILE_NAME, parseHostingManifest } from '@/lib/hosting/manifest';
import { HOSTING_FIXTURE_MANIFEST_PATH } from '../fixtures/hosting/fixtureImage';

const fixtureText = readFileSync(resolve(process.cwd(), HOSTING_FIXTURE_MANIFEST_PATH), 'utf8');

type Json = Record<string, unknown>;
const fixture = (): Json => JSON.parse(fixtureText) as Json;

/** Remove one dotted path from a fresh copy of the fixture. */
function without(path: string): string {
  const doc = fixture();
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce<Json>((node, key) => node[key] as Json, doc);
  delete parent[last];
  return JSON.stringify(doc);
}

function withValue(path: string, value: unknown): string {
  const doc = fixture();
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce<Json>((node, key) => node[key] as Json, doc);
  parent[last] = value;
  return JSON.stringify(doc);
}

function refusal(text: string | null): HostingManifestInvalidError {
  try {
    parseHostingManifest(text);
  } catch (err) {
    expect(err).toBeInstanceOf(HostingManifestInvalidError);
    return err as HostingManifestInvalidError;
  }
  throw new Error('expected the manifest to be refused');
}

describe('parseHostingManifest', () => {
  it('returns the typed manifest for the committed fixture', () => {
    expect(parseHostingManifest(fixtureText)).toEqual({
      schemaVersion: 1,
      targets: ['fly'],
      port: 8080,
      healthCheck: { path: '/health' },
      startCommand: '/whoami',
      buildCommand: 'echo prebuilt',
      requires: { websockets: false, backgroundWork: false },
      database: { kind: 'none' },
    });
  });

  it('refuses no manifest with the record’s file name', () => {
    expect(HOSTING_MANIFEST_FILE_NAME).toBe('motir.hosting.json');
    let caught: unknown;
    try {
      parseHostingManifest(null);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HostingManifestMissingError);
    expect((caught as HostingManifestMissingError).fileName).toBe('motir.hosting.json');
  });

  it.each([
    'schemaVersion',
    'targets',
    'port',
    'healthCheck',
    'healthCheck.path',
    'startCommand',
    'buildCommand',
    'requires',
    'requires.websockets',
    'requires.backgroundWork',
    'database',
    'database.kind',
  ])('refuses a manifest missing %s, naming it', (field) => {
    const err = refusal(without(field));
    expect(err.field).toBe(field);
    expect(err.reason).toBe('is missing');
    expect(err.issues).toHaveLength(1);
  });

  it('requires database.migrateCommand when the database is postgres', () => {
    const err = refusal(withValue('database', { kind: 'postgres' }));
    expect(err.field).toBe('database.migrateCommand');
    expect(err.reason).toMatch(/missing/);
    expect(
      parseHostingManifest(
        withValue('database', {
          kind: 'postgres',
          migrateCommand: 'pnpm migrate',
          seedCommand: 'pnpm seed',
        }),
      ).database,
    ).toEqual({ kind: 'postgres', migrateCommand: 'pnpm migrate', seedCommand: 'pnpm seed' });
  });

  it.each([
    ['port', '8080', /wrong type/],
    ['port', 0, /out of range/],
    ['port', 65536, /out of range/],
    ['port', 80.5, /integer/],
    ['healthCheck.path', 'health', /start with "\/"/],
    ['database.kind', 'mysql', /allowed values/],
    ['schemaVersion', 2, /must be 1/],
    ['targets', [], /at least one/],
    ['startCommand', '', /non-empty/],
    ['requires.websockets', 'no', /wrong type/],
  ])('refuses %s = %j by name', (field, value, reason) => {
    const err = refusal(withValue(field, value));
    expect(err.field).toBe(field);
    expect(err.reason).toMatch(reason);
  });

  it('names an unknown target by its element path', () => {
    const err = refusal(withValue('targets', ['fly', 'heroku']));
    expect(err.field).toBe('targets.1');
    expect(err.reason).toMatch(/allowed values/);
  });

  it('refuses an unknown top-level key by name rather than ignoring it', () => {
    const err = refusal(withValue('helthCheck', { path: '/health' }));
    expect(err.field).toBe('helthCheck');
    expect(err.reason).toBe('is not a manifest field');
  });

  it('refuses an unknown nested key by its dotted path', () => {
    const err = refusal(withValue('database.url', 'postgres://x'));
    expect(err.field).toBe('database.url');
  });

  it.each(['{ "port": ', 'port: 8080', ''])(
    'refuses unparseable text %j with field null',
    (text) => {
      const err = refusal(text);
      expect(err.field).toBeNull();
      expect(err.reason).toMatch(/not valid JSON/);
    },
  );

  it('refuses a document that is not an object', () => {
    expect(refusal('[]').field).toBeNull();
  });

  it('reports the earlier field in the record’s order first and lists every failure', () => {
    const doc = fixture();
    doc['database'] = { kind: 'sqlite' };
    delete doc['port'];
    const err = refusal(JSON.stringify(doc));
    expect(err.field).toBe('port');
    expect(err.issues.map((i) => i.field)).toEqual(['port', 'database.kind']);
    expect(err.message).toMatch(/and 1 more/);
  });

  it('infers nothing: the parser module has no fetch, no fs and no defaults', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/hosting/manifest.ts'), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/from ['"](node:)?fs/);
    expect(source).not.toMatch(/\.default\(/);
  });
});
