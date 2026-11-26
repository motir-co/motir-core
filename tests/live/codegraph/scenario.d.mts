// Types for `scenario.mjs`, the plain ESM the suite shares with the worker preload
// and the archive host (MOTIR-12260).

export interface Commit {
  parents: string[];
  files: Record<string, string>;
}

export interface PullRequest {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headRepoId: number | null;
}

export interface Scenario {
  owner: string;
  name: string;
  id: number;
  defaultBranch: string;
  commits: Record<string, Commit>;
  refs: Record<string, string>;
  pulls: Record<string, PullRequest>;
  archiveOrigin: string;
}

export function readScenario(path: string): Scenario;
export function writeScenario(path: string, scenario: Scenario): void;
export function commitSha(parents: string[], files: Record<string, string>): string;
export function addCommit(
  scenario: Scenario,
  parent: string | null,
  changes: Record<string, string | null>,
): string;
export function mergeBase(scenario: Scenario, a: string, b: string): string | null;
export function compareThreeDot(
  scenario: Scenario,
  base: string,
  head: string,
): {
  base_commit: { sha: string };
  merge_base_commit: { sha: string };
  commits: { sha: string }[];
  files: { filename: string; status: 'added' | 'removed' | 'modified' }[];
} | null;
export function tarballOf(scenario: Scenario, sha: string): Buffer | null;
