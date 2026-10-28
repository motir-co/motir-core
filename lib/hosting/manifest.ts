// The hosting manifest contract (MOTIR-9803): the file each starter ships at its
// root to say how it builds, starts and answers a health check. The schema is the
// field table of the decision of record, MOTIR-5769 §7 (page
// cmvrcywwc00jkhpr1zvvnike8, version 1) — no field here is inferred, defaulted or
// sniffed from the repository (R2). Reading the file from GitHub stays with the
// caller: this module takes text, so the deploy port, the operator deploy check
// and the starters' own tests can use it without a network.

import { z, type ZodIssue } from 'zod';

import {
  HostingManifestInvalidError,
  HostingManifestMissingError,
  type HostingManifestIssue,
} from './errors';
import { HOSTING_TARGETS } from './vocabulary';

/** The manifest's file name, at the repository root. JSON only. */
export const HOSTING_MANIFEST_FILE_NAME = 'motir.hosting.json';

export const HOSTING_DATABASE_KINDS = ['none', 'postgres'] as const;
export type HostingDatabaseKind = (typeof HOSTING_DATABASE_KINDS)[number];

/** The record's field order. "The first failing field" is the earliest entry
 *  here that an issue's path starts with; anything unlisted sorts last. */
const FIELD_ORDER = [
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
  'database.migrateCommand',
  'database.seedCommand',
] as const;

const nonEmpty = z.string().min(1, 'must be a non-empty string');

const databaseSchema = z
  .object({
    kind: z.enum(HOSTING_DATABASE_KINDS),
    migrateCommand: nonEmpty.optional(),
    seedCommand: nonEmpty.optional(),
  })
  .strict()
  .superRefine((db, ctx) => {
    if (db.kind === 'postgres' && db.migrateCommand === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['migrateCommand'],
        message: 'is missing (required when database.kind is "postgres")',
      });
    }
  });

export const hostingManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    targets: z.array(z.enum(HOSTING_TARGETS)).nonempty('must list at least one target'),
    port: z
      .number()
      .int('must be an integer')
      .min(1, 'is out of range (1–65535)')
      .max(65535, 'is out of range (1–65535)'),
    healthCheck: z.object({ path: z.string().startsWith('/', 'must start with "/"') }).strict(),
    startCommand: nonEmpty,
    buildCommand: nonEmpty,
    requires: z.object({ websockets: z.boolean(), backgroundWork: z.boolean() }).strict(),
    database: databaseSchema,
  })
  .strict();

export type HostingManifest = z.infer<typeof hostingManifestSchema>;

/**
 * Turn a repository's manifest text into a typed `HostingManifest`, or refuse it
 * by name. `null` means the file is not in the repository at that ref.
 *
 * @throws HostingManifestMissingError when `text` is null.
 * @throws HostingManifestInvalidError when the text is not JSON (`field: null`)
 *   or any field is missing, wrongly typed, out of range or unknown.
 */
export function parseHostingManifest(text: string | null): HostingManifest {
  if (text === null) throw new HostingManifestMissingError(HOSTING_MANIFEST_FILE_NAME);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HostingManifestInvalidError([
      { field: null, reason: `is not valid JSON: ${message}` },
    ]);
  }
  const parsed = hostingManifestSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new HostingManifestInvalidError(sortIssues(parsed.error.issues.flatMap(toManifestIssues)));
}

/** One zod issue → one or more manifest issues. An unknown-keys issue becomes
 *  one issue per key, each named by its own dotted path. */
function toManifestIssues(issue: ZodIssue): HostingManifestIssue[] {
  const base = issue.path.map(String).join('.');
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return issue.keys.map((key) => ({
      field: base ? `${base}.${key}` : key,
      reason: 'is not a manifest field',
    }));
  }
  return [{ field: base || null, reason: reasonFor(issue) }];
}

function reasonFor(issue: ZodIssue): string {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return issue.received === 'undefined'
        ? 'is missing'
        : `has the wrong type (expected ${issue.expected}, got ${issue.received})`;
    case z.ZodIssueCode.invalid_literal:
      if (issue.received === undefined) return 'is missing';
      return `must be ${JSON.stringify(issue.expected)}`;
    case z.ZodIssueCode.invalid_enum_value:
      return `is not one of the allowed values (${issue.options.map((o) => JSON.stringify(o)).join(', ')})`;
    default:
      return issue.message;
  }
}

function orderOf(field: string | null): number {
  if (field === null) return -1;
  // The most specific match wins (a parent is listed before its children);
  // array elements (`targets.0`) sort with their field.
  const index = FIELD_ORDER.findLastIndex((f) => field === f || field.startsWith(`${f}.`));
  return index === -1 ? FIELD_ORDER.length : index;
}

function sortIssues(issues: HostingManifestIssue[]): HostingManifestIssue[] {
  return issues
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => orderOf(a.issue.field) - orderOf(b.issue.field) || a.i - b.i)
    .map(({ issue }) => issue);
}
