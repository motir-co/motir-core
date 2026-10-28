// The seam through which feature-flag values reach a repository's environment
// (Story MOTIR-9795). `resolveEnvironment` merges what a source returns into the
// deploy environment as non-secret values; the flag records and a real source
// arrive with MOTIR-7136, which swaps the default at the call site.
import type { EnvironmentName } from './vocabulary';

export interface EnvironmentFlagValue {
  readonly name: string;
  readonly value: string;
}

export interface EnvironmentFlagSource {
  listFlagValues(
    repositoryId: string,
    environment: EnvironmentName,
  ): Promise<readonly EnvironmentFlagValue[]>;
}

/** The shipped default: no flags until MOTIR-7136 provides them. */
export const emptyEnvironmentFlagSource: EnvironmentFlagSource = {
  async listFlagValues() {
    return [];
  },
};
