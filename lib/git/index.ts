// Public entry for the Git provider seam (Story 7.10 · MOTIR-891). Importing
// this module registers every built-in provider (via each provider module's
// import side-effect) and re-exports the resolver, so a consumer does
// `import { getGitProvider } from '@/lib/git'` and is guaranteed the provider is
// registered before it resolves one. Import `@/lib/git` (never
// `@/lib/git/registry` directly) so the registration side-effects run.

import './providers/github'; // side-effect: registers the GitHub provider
import './providers/gitlab'; // side-effect: registers the GitLab provider (7.23)

export {
  getGitProvider,
  registerGitProvider,
  registeredGitProviderIds,
  UnknownGitProviderError,
} from './registry';
export {
  requireRepoTarballUrlResolver,
  providerSupportsRepoTarballUrl,
  CHANGED_FILES_MAX,
  CHANGED_FILES_TIMEOUT_MS,
  CODE_HISTORY_MAX_BODY_BYTES,
  CODE_HISTORY_MAX_COMMITS,
  CODE_HISTORY_MAX_RANGES,
  CODE_HISTORY_TIMEOUT_MS,
  REPO_FILE_FETCH_MAX_BYTES,
  REPO_FILE_MAX_BYTES,
  REPO_FILE_READ_TIMEOUT_MS,
  REPO_TARBALL_TIMEOUT_MS,
} from './provider';
export { MAX_REPO_PATH_LENGTH, normalizeRepoFilePath } from './fileRead';
export type { GitProvider, RepoTarballUrlResolver } from './provider';
export {
  RepoFileReadError,
  RepoTarballUrlError,
  RepoTarballUrlMissingLocationError,
  RepoTarballUrlNotRedirectedError,
  RepoTarballUrlTimeoutError,
  RepoTarballUrlUnreachableError,
  RepoTarballUrlUnsupportedError,
} from './errors';
export type { RepoTarballUrlFailure } from './errors';
export type {
  ChangedFile,
  ChangedFileStatus,
  ChangedFilesResult,
  CodeBlameRange,
  CodeHistoryCommit,
  CodeHistoryKind,
  CodeHistoryResult,
  ChangeRequestLifecycle,
  ChangeRequestState,
  CiConclusion,
  GitProviderId,
  InstallationToken,
  NormalizedBranch,
  NormalizedChangeRequest,
  NormalizedRepo,
  NormalizedStatusEvent,
  RepoFileReadOutcome,
  RepoFileReadResult,
  RepoFileReadTransportFailure,
} from './types';
