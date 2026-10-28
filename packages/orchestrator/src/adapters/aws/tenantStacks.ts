import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// THE AWS TENANT STACKS (MOTIR-10003) — the CloudFormation templates the AWS
// hosting adapter applies in a tenant account live in ONE self-contained
// directory beside this package's `src/`, `aws-tenant-stacks/`, shipped in the
// package's `files`. This constant is how motir-core finds it; nothing in the
// directory refers back here.
//
// Found by walking up from this module — from `src/adapters/aws/` under a test,
// from `dist/` once built (`tsup.config.ts` shims `import.meta.url` into the
// CommonJS build) — to the first directory that holds it.

const DIRECTORY = 'aws-tenant-stacks';

/** The `aws-tenant-stacks` directory at or above `start`, or — when a bundler
 *  moved the module away from its package — the installed package's copy under
 *  `cwd`. */
export function locateTenantStacks(start: string, cwd: string): string {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, DIRECTORY);
    if (existsSync(join(candidate, 'parameters.json'))) return candidate;
    if (dirname(dir) === dir) break;
  }
  return resolve(cwd, 'node_modules', '@motir', 'orchestrator', DIRECTORY);
}

/** The absolute path of the `aws-tenant-stacks` directory. */
export const AWS_TENANT_STACKS_DIR: string = locateTenantStacks(
  dirname(fileURLToPath(import.meta.url)),
  process.cwd(),
);

/** The six templates, by file name. */
export type TenantStackTemplate =
  | 'network.yaml'
  | 'registry.yaml'
  | 'database.yaml'
  | 'preview-database.yaml'
  | 'function-release.yaml'
  | 'container-release.yaml';

/** A template's body, exactly as the stack runner submits it. */
export function readTenantStackTemplate(
  template: TenantStackTemplate,
  dir: string = AWS_TENANT_STACKS_DIR,
): string {
  return readFileSync(join(dir, template), 'utf8');
}
