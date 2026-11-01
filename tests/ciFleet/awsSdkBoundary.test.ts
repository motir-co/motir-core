import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
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
 * The registered exceptions, each scoped to one directory AND to the modules it
 * was argued for. `lib/blob/` is the attachment store's S3 port (object storage,
 * not the fleet): it boots nothing and imports nothing from `@motir/orchestrator`.
 * Any other `@aws-sdk/*` module there still fails.
 */
const BLOB_STORE = {
  dir: join('lib', 'blob'),
  modules: new Set(['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner']),
};

/**
 * The SERVERLESS hosting adapter (Story MOTIR-9793 · MOTIR-9972): Lambda with
 * function URLs in Motir's own `motir-hosting-serverless` account — the hosting
 * deploy port, not the fleet. Only its client module imports the SDK, and only
 * the services it deploys to and the STS client it assumes its one role with.
 * It reads its role and region from the environment like the Fly hosting
 * adapter, so the no-environment case below still covers only `adapters/aws/`.
 */
const SERVERLESS_HOSTING = {
  dir: join('packages', 'orchestrator', 'src', 'adapters', 'serverless'),
  modules: new Set([
    '@aws-sdk/client-lambda',
    '@aws-sdk/client-ecr',
    '@aws-sdk/client-secrets-manager',
    '@aws-sdk/client-cloudwatch',
    '@aws-sdk/client-cloudwatch-logs',
    '@aws-sdk/client-sts',
  ]),
};

const EXCEPTIONS = [BLOB_STORE, SERVERLESS_HOSTING];

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

  it('covers the tenant adapter and the hosting composition root', () => {
    expect(FILES).toEqual(
      expect.arrayContaining([
        join(ADAPTER_DIR, 'tenant', 'hostingAdapter.ts'),
        join(ADAPTER_DIR, 'tenant', 'sdk.ts'),
        join('lib', 'orchestrator', 'hosting.ts'),
      ]),
    );
  });

  it('every @aws-sdk/* import is under packages/orchestrator/src/adapters/aws/', () => {
    const leaks = FILES.filter((file) => !within(file, ADAPTER_DIR)).flatMap((file) =>
      sdkImportsOf(file)
        .filter(
          (module) => !EXCEPTIONS.some((ex) => within(file, ex.dir) && ex.modules.has(module)),
        )
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

  it('the @motir/orchestrator barrel exports no AWS SDK name, type or value', () => {
    const entry = join(ROOT, 'packages', 'orchestrator', 'src', 'index.ts');
    const config = ts.getParsedCommandLineOfConfigFile(
      join(ROOT, 'packages', 'orchestrator', 'tsconfig.json'),
      {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
    );
    const program = ts.createProgram([entry], { ...config?.options, noEmit: true });
    const checker = program.getTypeChecker();
    const fromSdk = (file: string) => /node_modules[\\/](?:@aws-sdk|@smithy)[\\/]/.test(file);
    // The SDK's declarations are in the program, so a leak would be seen.
    expect(program.getSourceFiles().some((file) => fromSdk(file.fileName))).toBe(true);

    const barrel = checker.getSymbolAtLocation(program.getSourceFile(entry)!)!;
    const exported = checker.getExportsOfModule(barrel);
    expect(exported.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(['createAwsHostingDeployPort', 'createSigV4Fetch', 'TenantClients']),
    );
    const leaks = exported
      .filter((symbol) => {
        const target =
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        return (target.declarations ?? []).some((d) => fromSdk(d.getSourceFile().fileName));
      })
      .map((symbol) => symbol.name);
    expect(leaks).toEqual([]);
  }, 120_000);
});
