// MOTIR-10028 — the production database URL reaches production only. Previews
// have no application row, so the structural guarantee is who can reach the two
// doors: `productionDatabaseService` is imported only by the production release
// service, and the ciphertext column is named only by the repository that
// stores it, the service that decrypts it and the mapper that refuses to copy it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const SCANNED = ['lib', 'app'];

/** The production release service (MOTIR-10030) — the one importer allowed. */
const ALLOWED_IMPORTERS = new Set(['lib/services/productionReleaseService.ts']);

const CIPHERTEXT_READERS = new Set([
  'lib/repositories/hostedApplicationRepository.ts',
  'lib/services/productionDatabaseService.ts',
  // Names the column only in the rule that it is never copied.
  'lib/mappers/hostedApplicationMappers.ts',
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out;
}

const files = SCANNED.flatMap((root) => sources(join(ROOT, root)));

describe('the production database boundary', () => {
  it('scans a real tree', () => {
    expect(files).toContain('lib/services/productionDatabaseService.ts');
  });

  it('lets only the production release service import productionDatabaseService', () => {
    const importers = files.filter((f) =>
      /from\s+['"]@\/lib\/services\/productionDatabaseService['"]/.test(
        readFileSync(join(ROOT, f), 'utf8'),
      ),
    );
    expect(importers.filter((f) => !ALLOWED_IMPORTERS.has(f))).toEqual([]);
  });

  it('names the ciphertext column nowhere else, and in no preview module', () => {
    const readers = files.filter((f) =>
      /databaseUrlCiphertext|database_url_ciphertext/.test(readFileSync(join(ROOT, f), 'utf8')),
    );
    expect(readers.filter((f) => !CIPHERTEXT_READERS.has(f))).toEqual([]);
    expect(readers.filter((f) => /preview/i.test(f))).toEqual([]);
  });
});
