import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AWS_TENANT_STACKS_DIR, locateTenantStacks } from '../src/index';

// Where motir-core finds the AWS tenant stack templates (MOTIR-10003). The
// templates' own rules are linted by the root `tests/hosting/awsTenantStacks.test.ts`.

describe('AWS_TENANT_STACKS_DIR', () => {
  it('is the package’s own aws-tenant-stacks directory', () => {
    expect(AWS_TENANT_STACKS_DIR).toBe(resolve(__dirname, '..', 'aws-tenant-stacks'));
  });

  it('is found from any depth below the directory’s parent, else under the installed package', () => {
    const root = mkdtempSync(join(tmpdir(), 'stacks-'));
    mkdirSync(join(root, 'aws-tenant-stacks'));
    writeFileSync(join(root, 'aws-tenant-stacks', 'parameters.json'), '{}');
    mkdirSync(join(root, 'dist', 'nested'), { recursive: true });
    expect(locateTenantStacks(join(root, 'dist', 'nested'), '/srv')).toBe(
      join(root, 'aws-tenant-stacks'),
    );

    const elsewhere = mkdtempSync(join(tmpdir(), 'bundle-'));
    expect(locateTenantStacks(elsewhere, '/srv/app')).toBe(
      '/srv/app/node_modules/@motir/orchestrator/aws-tenant-stacks',
    );
  });
});
