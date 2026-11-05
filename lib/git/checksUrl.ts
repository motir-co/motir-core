import { gitlabBaseUrl } from '@/lib/gitlab/gitlabOAuth';
import type { GitProviderId } from './types';

/** Where a reader of the CI feedback comment goes to see a change request's checks:
 *  a GitHub pull request's Checks tab, a GitLab merge request's Pipelines tab.
 *
 *  ONE builder for both callers that need it (Bug MOTIR-10425): the webhook
 *  consumers, which render the comment as a delivery lands, and the reconcile
 *  backstop, which re-renders it after settling rows from the host and has no
 *  delivery — and so no provider seam — to ask. */
export function changeRequestChecksUrl(
  provider: GitProviderId,
  repo: { owner: string; name: string },
  changeRequestNumber: number,
): string {
  return provider === 'gitlab'
    ? `${gitlabBaseUrl()}/${repo.owner}/${repo.name}/-/merge_requests/${changeRequestNumber}/pipelines`
    : `https://github.com/${repo.owner}/${repo.name}/pull/${changeRequestNumber}/checks`;
}
