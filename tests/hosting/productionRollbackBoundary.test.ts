import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// MOTIR-10035 — ROLLBACK TOUCHES NO SCHEMA. A rollback reverts running code and
// its environment; the application's database is never migrated, read or
// reconfigured by it. A source scan of the service, so a later edit that reaches
// for the database or a migration runner fails here, not in production.

const SERVICE = 'lib/services/productionRollbackService.ts';

function imports(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
}

describe('productionRollbackService', () => {
  it('imports no database client, no production database service and no migration runner', () => {
    const found = imports(SERVICE);
    expect(found.length).toBeGreaterThan(0);
    expect(found).not.toContain('@/lib/db');
    expect(found.filter((i) => /productionDatabase|migrat|releaseEnvironment/i.test(i))).toEqual(
      [],
    );
  });

  it('runs no release command, reads no DATABASE_URL and posts no status itself', () => {
    const source = readFileSync(SERVICE, 'utf8');
    expect(source).not.toMatch(/runReleaseCommand\s*\(/);
    expect(source).not.toMatch(/DATABASE_URL|DIRECT_URL/);
    expect(source).not.toMatch(/enqueueReleaseStatusPost|postReleaseDeploymentStatus/);
    expect(
      imports(SERVICE).filter((i) => /repoDeployments|releaseDeploymentStatus/.test(i)),
    ).toEqual([]);
  });
});
