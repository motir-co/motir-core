import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../helpers/importGraph';

// THE AWS SDK BOUNDARY (Story MOTIR-9270 · MOTIR-9280). The fleet's AWS
// adapter is the one place the fleet speaks to AWS: every `@aws-sdk/*` import
// under the scanned roots is a file under `packages/orchestrator/src/adapters/aws/`,
// and that directory reads no environment — its caller hands credentials in.
//
// It scans SOURCE with its own walk, the same shape as
// `orchestratorPortBoundary.test.ts` beside it, and for the same reason: the
// guard's reach is the whole of `lib/` and `app/`, because a boundary narrowed to
// the directory it protects is one you evade by moving a file.

const ROOT = process.cwd();
const ADAPTER_DIR = join('packages', 'orchestrator', 'src', 'adapters', 'aws');
const SCANNED_ROOTS = [join('packages', 'orchestrator', 'src'), 'lib', 'app'];

/**
 * The ONE registered exception, scoped to one directory AND to the modules it
 * was argued for. `lib/blob/` is the attachment store's S3 port (object storage,
 * not the fleet): it boots nothing and imports nothing from `@motir/orchestrator`.
 * Any other `@aws-sdk/*` module there still fails.
 */
const BLOB_STORE = {
  dir: join('lib', 'blob'),
  modules: new Set(['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner']),
};

const SDK_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)['"](@aws-sdk\/[^'"]+)['"]/gm;

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(ROOT, dir));
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist') return [];
    if (statSync(join(ROOT, path)).isDirectory()) return walk(path);
    return /\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry) ? [path] : [];
  });
}

const within = (file: string, dir: string) => file.startsWith(dir + sep);
const read = (file: string) => stripComments(readFileSync(join(ROOT, file), 'utf8'));
const FILES = SCANNED_ROOTS.flatMap(walk);

function sdkImportsOf(file: string): string[] {
  return [...read(file).matchAll(SDK_IMPORT)].map((match) => match[1]!);
}

describe('the AWS SDK boundary (MOTIR-9280)', () => {
  it('scans the roots at all — the walk is not vacuous', () => {
    expect(FILES.some((file) => within(file, ADAPTER_DIR))).toBe(true);
    expect(FILES.some((file) => within(file, 'lib'))).toBe(true);
    expect(FILES.some((file) => within(file, 'app'))).toBe(true);
    // The adapter itself imports the SDK, so a pattern that matched nothing
    // would fail here rather than pass below.
    expect(FILES.filter((file) => within(file, ADAPTER_DIR)).flatMap(sdkImportsOf)).toEqual(
      expect.arrayContaining(['@aws-sdk/client-ec2', '@aws-sdk/client-organizations']),
    );
  });

  it('every @aws-sdk/* import is under packages/orchestrator/src/adapters/aws/', () => {
    const leaks = FILES.filter((file) => !within(file, ADAPTER_DIR)).flatMap((file) =>
      sdkImportsOf(file)
        .filter((module) => !(within(file, BLOB_STORE.dir) && BLOB_STORE.modules.has(module)))
        .map((module) => `${relative(ROOT, join(ROOT, file))}: ${module}`),
    );
    expect(leaks).toEqual([]);
  });

  it('the adapter reads no environment', () => {
    const readers = FILES.filter(
      // Raw text, comments included: the package's own guard reads it the same way.
      (file) =>
        within(file, ADAPTER_DIR) &&
        /process\s*\.\s*env/.test(readFileSync(join(ROOT, file), 'utf8')),
    );
    expect(readers).toEqual([]);
  });
});
