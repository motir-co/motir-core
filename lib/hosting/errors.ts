// Typed errors for HOSTING a Motir repository (Story MOTIR-9791). The decision of
// record is MOTIR-5769 (page cmvrcywwc00jkhpr1zvvnike8, version 1). Kept free of
// Prisma so the operator deploy check and the deploy port can import them without
// a database. The suggested HTTP mapping is on each class.

/** One failing manifest field: its dotted path (`null` for the document itself)
 *  and a one-line reason. */
export interface HostingManifestIssue {
  field: string | null;
  reason: string;
}

/** The repository has no hosting manifest at that ref. The caller passes `null`
 *  when the file is absent; the parser never looks for one itself. → 422 */
export class HostingManifestMissingError extends Error {
  readonly code = 'HOSTING_MANIFEST_MISSING' as const;
  constructor(readonly fileName: string) {
    super(`No hosting manifest: the repository has no ${fileName} at its root.`);
    this.name = 'HostingManifestMissingError';
  }
}

/**
 * The hosting manifest is not valid JSON, or a field is missing or invalid.
 * `field` names the FIRST failing field in the record's field order (`null` when
 * the text does not parse at all); `issues` lists every failing field, so one run
 * shows them all. → 422
 */
export class HostingManifestInvalidError extends Error {
  readonly code = 'HOSTING_MANIFEST_INVALID' as const;
  readonly field: string | null;
  readonly reason: string;
  constructor(readonly issues: readonly HostingManifestIssue[]) {
    const first = issues[0] ?? { field: null, reason: 'invalid' };
    super(
      `Invalid hosting manifest: ${first.field ?? 'the document'} — ${first.reason}` +
        (issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''),
    );
    this.name = 'HostingManifestInvalidError';
    this.field = first.field;
    this.reason = first.reason;
  }
}
