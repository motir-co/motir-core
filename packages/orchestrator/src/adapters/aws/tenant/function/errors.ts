// The function shape's typed errors (MOTIR-10008). Like the seam's, none carries
// an AWS message or a variable's value: each names the function, the variable or
// AWS's error code. A stack that ends failed is the seam's `StackFailedError`.

/** A rollback was asked for with no version to roll back to. */
export class NoPreviousFunctionVersionError extends Error {
  readonly code = 'AWS_NO_PREVIOUS_FUNCTION_VERSION' as const;
  constructor(readonly functionName: string) {
    super(`Function ${functionName} has no previous version to roll back to.`);
    this.name = 'NoPreviousFunctionVersionError';
  }
}

/** CloudWatch did not answer a release's usage; nothing was destroyed. */
export class FunctionUsageReadError extends Error {
  readonly code = 'AWS_FUNCTION_USAGE_UNREADABLE' as const;
  constructor(
    readonly functionName: string,
    readonly awsCode: string,
  ) {
    super(`The usage of function ${functionName} could not be read (${awsCode}).`);
    this.name = 'FunctionUsageReadError';
  }
}

/** A release variable that no environment can carry, named — never its value. */
export class ReleaseVariableInvalidError extends Error {
  readonly code = 'AWS_RELEASE_VARIABLE_INVALID' as const;
  constructor(
    readonly variable: string,
    readonly reason: string,
  ) {
    super(`Release variable ${JSON.stringify(variable)} ${reason}.`);
    this.name = 'ReleaseVariableInvalidError';
  }
}

/** `function-release.yaml` lost the marker the release's variables go at. */
export class FunctionTemplateMarkerMissingError extends Error {
  readonly code = 'AWS_FUNCTION_TEMPLATE_MARKER_MISSING' as const;
  constructor(readonly marker: string) {
    super(`function-release.yaml has no ${marker} line.`);
    this.name = 'FunctionTemplateMarkerMissingError';
  }
}
