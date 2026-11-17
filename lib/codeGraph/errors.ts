// The name-record door's OWN refusals (MOTIR-11647 · story MOTIR-11497) — the caller's
// input, fixable in one hop, so each is a typed error `toToolError` answers with its
// code and message. Everything the FORWARD meets (motir-ai down, a non-2xx, an
// unmapped repository) is NOT here: that is a degraded answer, never an error
// (`lib/services/nameOccurrencesService.ts`). Each message names the cap or the field
// and the value it met, because an agent cannot ask what went wrong.

/** The look-up's cap: motir-codegraph's MAX_LOOKUP_NAMES. */
export const NAME_LOOKUP_MAX = 200;
/** The record's cap per call: motir-codegraph's MAX_NAME_OCCURRENCES. */
export const NAME_RECORD_MAX = 2_000;

export abstract class NameOccurrenceError extends Error {
  abstract readonly code: string;
  /** HTTP status a route would return. */
  readonly status: number = 400;
}

export class NameOccurrenceNamesTooManyError extends NameOccurrenceError {
  readonly code = 'NAME_OCCURRENCE_NAMES_TOO_MANY' as const;
  constructor(readonly count: number) {
    super(
      `A look-up asks at most ${NAME_LOOKUP_MAX} names; this one asked ${count}. Split the names into calls of ${NAME_LOOKUP_MAX} or fewer.`,
    );
    this.name = 'NameOccurrenceNamesTooManyError';
  }
}

export class EmptyNameOccurrenceNamesError extends NameOccurrenceError {
  readonly code = 'NAME_OCCURRENCE_NAMES_EMPTY' as const;
  constructor() {
    super(`A look-up asks 1 to ${NAME_LOOKUP_MAX} names; this one asked none.`);
    this.name = 'EmptyNameOccurrenceNamesError';
  }
}

export class DuplicateNameOccurrenceNamesError extends NameOccurrenceError {
  readonly code = 'NAME_OCCURRENCE_NAMES_DUPLICATE' as const;
  constructor(readonly repeated: string) {
    super(`A look-up asks each name once; "${repeated}" was asked more than once.`);
    this.name = 'DuplicateNameOccurrenceNamesError';
  }
}

export class NameOccurrenceBatchTooLargeError extends NameOccurrenceError {
  readonly code = 'NAME_OCCURRENCE_BATCH_TOO_LARGE' as const;
  constructor(readonly count: number) {
    super(
      `A record call carries at most ${NAME_RECORD_MAX} occurrences; this one carried ${count}. Send them in batches of ${NAME_RECORD_MAX} or fewer.`,
    );
    this.name = 'NameOccurrenceBatchTooLargeError';
  }
}

export class EmptyNameOccurrenceBatchError extends NameOccurrenceError {
  readonly code = 'NAME_OCCURRENCE_BATCH_EMPTY' as const;
  constructor() {
    super(`A record call carries 1 to ${NAME_RECORD_MAX} occurrences; this one carried none.`);
    this.name = 'EmptyNameOccurrenceBatchError';
  }
}

export class MalformedNameOccurrenceError extends NameOccurrenceError {
  readonly code = 'NAME_OCCURRENCE_MALFORMED' as const;
  constructor(
    readonly index: number,
    readonly field: 'blob' | 'name' | 'startLine' | 'endLine',
  ) {
    super(
      field === 'blob' || field === 'name'
        ? `occurrences[${index}] is missing its \`${field}\` (a non-empty string).`
        : `occurrences[${index}] is missing its \`${field}\` (an integer of 1 or more, with startLine ≤ endLine).`,
    );
    this.name = 'MalformedNameOccurrenceError';
  }
}

export class UnknownNameOccurrenceRepoError extends NameOccurrenceError {
  readonly code = 'NAME_OCCURRENCE_REPO_NOT_IN_SET' as const;
  constructor(
    readonly repo: string,
    readonly available: readonly string[],
  ) {
    super(
      available.length === 0
        ? `The repo "${repo}" is not in this project's set — the project has no repository. Nothing was sent.`
        : `The repo "${repo}" is not in this project's set — only ${available.map((r) => `"${r}"`).join(', ')} can be named. Nothing was sent.`,
    );
    this.name = 'UnknownNameOccurrenceRepoError';
  }
}
