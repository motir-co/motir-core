import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXCLUDED_FROM_EXPORT, PERSONAL_DATA_SECTIONS } from '@/lib/export/personalDataSections';
import { REPO_ROOT } from '../helpers/importGraph';

// THE ENUMERATION'S TOTALITY GUARD (Story 8.4 · Subtask MOTIR-3701).
//
// The export's contents are a hand-written list, and a hand-written list of a
// schema's tables has one failure mode: a table added later is silently absent,
// and the export keeps passing every test it has. An incomplete enumeration
// fails by PASSING — the archive looks thorough, the reader has no way to tell
// what is missing, and the omission is discovered by a regulator or not at all.
//
// So the list is not trusted; it is DERIVED-CHECKED. This suite reads
// `prisma/schema.prisma` — the source of truth for what personal data exists —
// and requires every model carrying a `User` foreign key to appear in exactly
// one of two places: the sections that are exported, or the exclusions that say
// why not. A new user-keyed table therefore fails the build until somebody
// decides which it is, which is the only mechanism that makes "everything" mean
// everything a year from now.
//
// This is the same shape `TINTED_SURFACE_TOKENS` takes against `theme.css`
// (MOTIR-3693) and for the identical reason recorded there: a check written to
// stop a list being a list of spellings must not itself be a list of spellings.

const SCHEMA = readFileSync(path.join(REPO_ROOT, 'prisma/schema.prisma'), 'utf8');

interface SchemaModel {
  name: string;
  body: string;
  /** The `@@map`ped physical table name, or the model name when unmapped. */
  table: string;
}

function parseModels(): SchemaModel[] {
  const out: SchemaModel[] = [];
  const re = /^model (\w+) \{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SCHEMA))) {
    const [, name, body] = m;
    const mapped = /@@map\("([^"]+)"\)/.exec(body!);
    out.push({ name: name!, body: body!, table: mapped?.[1] ?? name! });
  }
  return out;
}

const MODELS = parseModels();

/** Models with a field whose TYPE is `User` and which declares an FK — i.e. the
 *  row is keyed to a person. A back-relation (no `fields:`) is not one. */
function modelsWithUserForeignKey(): SchemaModel[] {
  return MODELS.filter((model) =>
    new RegExp(String.raw`^\s+\w+\s+User(\?|\[\])?\s+@relation\([^)]*fields:`, 'm').test(
      model.body,
    ),
  );
}

/** Prisma's delegate name for a model: the name with a lower-cased first letter. */
function delegateFor(modelName: string): string {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

describe('the enumeration is total over the schema', () => {
  it('parses a plausible number of models (the guard is reading the schema at all)', () => {
    expect(MODELS.length).toBeGreaterThan(50);
    expect(modelsWithUserForeignKey().length).toBeGreaterThan(30);
  });

  it('accounts for EVERY model carrying a User foreign key', () => {
    const byDelegate = new Map(PERSONAL_DATA_SECTIONS.map((s) => [s.model as string, s]));
    const unaccounted = modelsWithUserForeignKey()
      .filter((m) => !byDelegate.has(delegateFor(m.name)) && !(m.name in EXCLUDED_FROM_EXPORT))
      .map((m) => m.name);

    expect(
      unaccounted,
      'Every model with a User FK must be EXPORTED (add it to PERSONAL_DATA_SECTIONS) ' +
        'or EXCLUDED with a reason (add it to EXCLUDED_FROM_EXPORT). ' +
        'A user-keyed table in neither list is personal data the export silently drops.',
    ).toEqual([]);
  });

  it('exports the User row itself', () => {
    // `User` carries no FK to itself, so the sweep above cannot reach it — and
    // it is the one table the whole export is about.
    expect(PERSONAL_DATA_SECTIONS.map((s) => s.model)).toContain('user');
  });

  it('excludes nothing without a reason, and nothing that is also exported', () => {
    const exported = new Set(PERSONAL_DATA_SECTIONS.map((s) => s.model as string));
    for (const [model, reason] of Object.entries(EXCLUDED_FROM_EXPORT)) {
      expect(reason.length, `${model}'s exclusion needs a real reason`).toBeGreaterThan(60);
      expect(exported.has(delegateFor(model)), `${model} is both exported and excluded`).toBe(
        false,
      );
      expect(
        MODELS.some((m) => m.name === model),
        `${model} is excluded but is not a model in the schema — a stale exclusion`,
      ).toBe(true);
    }
  });
});

describe('each section names a real table, model and column set', () => {
  it('has no duplicate tables', () => {
    const tables = PERSONAL_DATA_SECTIONS.map((s) => s.table);
    expect(tables.length).toBe(new Set(tables).size);
  });

  it("every section's `table` is the model's actual @@map", () => {
    for (const section of PERSONAL_DATA_SECTIONS) {
      const model = MODELS.find((m) => delegateFor(m.name) === section.model);
      expect(model, `no model for delegate ${section.model}`).toBeDefined();
      expect(
        section.table,
        `section '${section.table}' names a table the model '${model!.name}' does not map to`,
      ).toBe(model!.table);
    }
  });

  it('every redacted column exists on its model — a rename must not silently un-redact', () => {
    // A redaction that names a column the model no longer has is not an error at
    // any layer: Prisma's `omit` would reject it at runtime, in a background job,
    // long after the rename. Here it is a failing unit test in the same commit.
    for (const section of PERSONAL_DATA_SECTIONS) {
      const model = MODELS.find((m) => delegateFor(m.name) === section.model)!;
      for (const column of section.redact ?? []) {
        expect(
          new RegExp(String.raw`^\s+${column}\s+\w`, 'm').test(model.body),
          `${model.name}.${column} is redacted by the export but is not a field on the model`,
        ).toBe(true);
      }
    }
  });

  it('redacts every credential-shaped column the exported auth tables carry', () => {
    // The positive statement of the security rule, so that ADDING a secret
    // column to an already-exported table fails here rather than shipping it.
    // Names, not heuristics, because the consequence of a miss is a password
    // hash in a file the account's owner can download and forward.
    const MUST_REDACT: Record<string, readonly string[]> = {
      account: ['password', 'accessToken', 'refreshToken', 'idToken'],
      session: ['token'],
      two_factor: ['secret', 'backupCodes'],
      api_token: ['tokenHash'],
      passkey: ['publicKey', 'credentialID'],
      email_change_request: ['token'],
      github_identity: ['accessTokenEncrypted', 'refreshTokenEncrypted'],
      import_source_identity: ['accessTokenEncrypted', 'refreshTokenEncrypted'],
      device_code: ['deviceCode', 'userCode'],
      oauth_client: ['clientSecret'],
      oauth_access_token: ['token'],
      oauth_refresh_token: ['token'],
    };
    for (const [table, columns] of Object.entries(MUST_REDACT)) {
      const section = PERSONAL_DATA_SECTIONS.find((s) => s.table === table);
      expect(section, `${table} is expected in the export`).toBeDefined();
      for (const column of columns) {
        expect(section!.redact ?? [], `${table}.${column} must never be exported`).toContain(
          column,
        );
      }
    }
  });

  it('every section states the basis on which the rows are that person’s', () => {
    for (const section of PERSONAL_DATA_SECTIONS) {
      expect(section.basis.length, `${section.table} needs a basis`).toBeGreaterThan(20);
    }
  });
});
