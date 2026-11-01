import type { LinkedPullRequestDto } from '@/lib/dto/github';
import type { HowToTestDto } from '@/lib/dto/howToTest';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// Fixtures for the Development block (MOTIR-5336) — the design board's own
// `ACME-n` shapes (design/github §20, Panels 12a–12o; § 25 for How to test since
// MOTIR-5691), so they link to nothing.

/** The heads the two rows are at — the record below was written for CORE_HEAD. */
export const CORE_HEAD = '3f2a91c0000000000000000000000000000000aa';
export const GATEWAY_HEAD = 'aa11bb2000000000000000000000000000000000';

export const CORE_PR: LinkedPullRequestDto = {
  id: 'pr-core-131',
  title: 'Rate-limit the public API per key',
  repo: 'moooon/motir-core',
  number: 131,
  state: 'open',
  ci: 'passing',
  headSha: CORE_HEAD,
  url: 'https://github.com/moooon/motir-core/pull/131',
  githubReview: null,
  preview: null,
  baseRef: 'main',
  conflicted: false,
};

export const GATEWAY_PR: LinkedPullRequestDto = {
  id: 'pr-gateway-57',
  title: 'Throttle burst traffic on /v1',
  repo: 'moooon/motir-gateway',
  number: 57,
  state: 'open',
  ci: 'running',
  headSha: GATEWAY_HEAD,
  url: 'https://github.com/moooon/motir-gateway/pull/57',
  githubReview: null,
  preview: null,
  baseRef: 'main',
  conflicted: false,
};

export const SECTIONED_BODY = [
  '## Precondition',
  '',
  'The seed creates **ada@acme.test**, a workspace admin.',
  '',
  '## Set up',
  '',
  '```bash',
  'pnpm install --frozen-lockfile && pnpm db:seed',
  '```',
  '',
  '```sh',
  'pnpm dev',
  '```',
  '',
  '## Click-path',
  '',
  '1. Sign in as **ada@acme.test**.',
  '2. Send 61 requests — the 61st answers `429`.',
].join('\n');

export function recordDto(over: Partial<HowToTestDto> = {}): HowToTestDto {
  return {
    state: 'record',
    runTarget: null,
    owedBy: null,
    record: {
      id: 'rec-1',
      author: { kind: 'run', runId: 'run-318', label: 'Parent run #318' },
      createdAt: '2026-09-13T14:05:00.000Z',
      bodyMd: SECTIONED_BODY,
      workItemRefs: {},
      previewPath: '/settings/api-keys',
    },
    history: [],
    ...over,
  };
}

export const AWAITING_MERGE_GATE: ApprovalGateDTO = {
  id: 'gate-merge-1',
  workItemId: 'wi-acme-12',
  kind: 'pull_request_approval',
  subjectId: 'delivery-1',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  supersededCause: null,
  subjectVersion: null,
  decidedByLabel: null,
  routedToId: 'user-2',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  confirmedRecord: null,
  refusalVerdict: null,
  offersRefusalVerdict: false,
  replanOwed: null,
  chosenOption: null,
  createdAt: '2026-09-13T14:10:00.000Z',
  updatedAt: '2026-09-13T14:10:00.000Z',
};
