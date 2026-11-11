import type {
  FleetImagePublishDTO,
  FleetPublishRecordDTO,
  HostedImageReadDTO,
  RunnerImageReadDTO,
  SandboxImageReadDTO,
} from '@/lib/dto/fleetStatusImages';

// Read rows of the Fleet status page's three image cards (MOTIR-10886), shaped as
// the service answers them, for the verdict, card and page suites. Each builder
// takes a shallow override.

export const PINNED_DIGEST = `sha256:${'46'.repeat(32)}`;
export const NEWEST_DIGEST = `sha256:${'9f'.repeat(32)}`;
export const PINNED_COMMIT = '4a9cb14b54e2366d2a30ad19ac4b924dddca6d31';
export const NEWEST_COMMIT = 'c22cba55d5ece36c13e01d22c2656f03e7cb33cc';

export function publishIdle(over: Partial<FleetImagePublishDTO> = {}): FleetImagePublishDTO {
  return {
    record: null,
    progress: { state: 'idle' },
    activeRun: false,
    target: null,
    blocked: 'up_to_date',
    ...over,
  };
}

export function publishRecord(over: Partial<FleetPublishRecordDTO> = {}): FleetPublishRecordDTO {
  return {
    actorEmail: 'ops+publisher@example.test',
    at: '2026-11-10T10:00:00.000Z',
    from: PINNED_DIGEST,
    to: NEWEST_DIGEST,
    target: NEWEST_DIGEST,
    runId: 77,
    runUrl: 'https://github.com/motir-co/motir-core/actions/runs/77',
    runNumber: 12,
    ...over,
  };
}

export function hostedRow(over: Partial<HostedImageReadDTO> = {}): HostedImageReadDTO {
  return {
    status: 'read',
    pinned: { digest: PINNED_DIGEST, commit: PINNED_COMMIT, createdAt: '2026-11-01T00:00:00Z' },
    newest: { digest: NEWEST_DIGEST, commit: NEWEST_COMMIT, createdAt: '2026-11-04T00:00:00Z' },
    behind: true,
    daysBehind: 3,
    cliCommits: 5,
    compareUrl: `https://github.com/motir-co/motir-core/compare/${PINNED_COMMIT}...${NEWEST_COMMIT}`,
    publish: publishIdle({
      blocked: null,
      target: {
        workflow: 'hosted-agent-image.yml',
        ref: 'main',
        inputs: { digest: NEWEST_DIGEST, source_commit: NEWEST_COMMIT },
        from: `${PINNED_DIGEST} (4a9cb14)`,
        to: `${NEWEST_DIGEST} (c22cba5)`,
        target: NEWEST_DIGEST,
      },
    }),
    ...over,
  };
}

export function runnerRow(over: Partial<RunnerImageReadDTO> = {}): RunnerImageReadDTO {
  return {
    status: 'read',
    pinned: {
      digest: PINNED_DIGEST,
      commit: PINNED_COMMIT,
      createdAt: '2026-11-01T00:00:00Z',
      version: '0.2.4',
    },
    newest: {
      digest: NEWEST_DIGEST,
      commit: NEWEST_COMMIT,
      createdAt: '2026-11-06T00:00:00Z',
      version: '0.2.6',
    },
    behind: true,
    releasesBetween: ['runner-v0.2.5', 'runner-v0.2.6'],
    daysBehind: 5,
    runnerCommits: 4,
    compareUrl: 'https://github.com/motir-co/motir-core/compare/runner-v0.2.4...runner-v0.2.6',
    unreleased: [],
    nextTag: 'runner-v0.2.7',
    ami: { state: 'unset' },
    publish: publishIdle({
      blocked: null,
      target: {
        workflow: 'release-runner-image.yml',
        ref: 'main',
        inputs: { pin_digest: NEWEST_DIGEST, pin_version: '0.2.6' },
        from: `runner-v0.2.4 (${PINNED_DIGEST})`,
        to: `runner-v0.2.6 (${NEWEST_DIGEST})`,
        target: NEWEST_DIGEST,
      },
    }),
    ...over,
  };
}

export const SANDBOX_IDS = [
  'base',
  'claude',
  'codex',
  'opencode',
  'kimi',
  'antigravity',
  'cursor',
  'aider',
  'goose',
];

export function sandboxRow(
  missing: string[] = [],
  over: Partial<SandboxImageReadDTO> = {},
): SandboxImageReadDTO {
  return {
    status: 'read',
    release: {
      tag: 'cli-v0.18.0',
      version: '0.18.0',
      commit: NEWEST_COMMIT,
      committedAt: '2026-11-05T00:00:00Z',
    },
    profiles: SANDBOX_IDS.map((id) => ({
      id,
      tag: `${id}-0.18.0`,
      published: !missing.includes(id),
    })),
    previous: missing.length > 0 ? '0.17.2' : null,
    liveOlder: 0,
    republishable: missing.length > 0,
    publish:
      missing.length > 0
        ? publishIdle({
            blocked: null,
            target: {
              workflow: 'release-sandbox.yml',
              ref: 'cli-v0.18.0',
              inputs: { dry_run: 'false' },
              from: `cli-v0.18.0: ${9 - missing.length} of 9 tags`,
              to: 'cli-v0.18.0: 9 of 9 tags',
              target: '0.18.0',
            },
          })
        : publishIdle(),
    ...over,
  };
}
