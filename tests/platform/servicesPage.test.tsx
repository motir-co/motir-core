import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatter, createTranslator } from 'next-intl';
import { db } from '@/lib/db';
import en from '@/messages/en.json';
import type { EcsDeploymentRead, EcsServiceRead } from '@/lib/awsServices/ecsServicesReader';
import type { PlatformServicesDTO } from '@/lib/dto/platformServices';
import {
  judgeCluster,
  judgeShare,
  platformServicesService,
  type DeploymentVersionRead,
} from '@/lib/services/platformServicesService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { deferred, renderFirstFlush, renderToHtml } from '../helpers/serverPageHarness';

// THE CONSOLE'S SERVICES PAGE (MOTIR-10890, design MOTIR-10889). The page gate
// runs for real over a real session and the real `platformRole` column; the
// read is stubbed at the service object with DTOs the service's own judges
// build, so every state the design draws is reached. The read itself has its
// own suite.

class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/serverPageHarness')).navigationHooks(),
  notFound: () => {
    throw new NotFoundSentinel();
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as 'platformAdmin' }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

const { default: Page } = await import('@/app/(admin)/admin/services/page');
const { utcTime } = await import('@/app/(admin)/admin/services/_components/ServicesSection');

const ACCOUNT = '123456789012';
const td = (family: string, revision: number) =>
  `arn:aws:ecs:eu-central-1:${ACCOUNT}:task-definition/${family}:${revision}`;
const ago = (ms: number) => new Date(Date.now() - ms);

function dep(over: Partial<EcsDeploymentRead> & { taskDefinitionArn: string }): EcsDeploymentRead {
  return {
    status: 'PRIMARY',
    rolloutState: 'COMPLETED',
    createdAt: ago(2 * 3_600_000),
    runningCount: 2,
    desiredCount: 2,
    ...over,
  };
}

function service(
  name: string,
  running: number,
  desired: number,
  opts: {
    deployments?: EcsDeploymentRead[];
    current?: string;
    sizes?: Record<string, { cpuUnits: number; memoryMib: number }>;
  } = {},
): EcsServiceRead {
  const current = opts.current ?? td(name, 4);
  const deployments = opts.deployments ?? [
    dep({ taskDefinitionArn: current, runningCount: running, desiredCount: desired }),
  ];
  const arns = [...new Set([current, ...deployments.map((d) => d.taskDefinitionArn)])];
  return {
    name,
    arn: `arn:aws:ecs:eu-central-1:${ACCOUNT}:service/motir-core/${name}`,
    runningCount: running,
    desiredCount: desired,
    taskDefinitionArn: current,
    deployments,
    taskDefinitions: Object.fromEntries(
      arns.map((arn) => {
        const [family, revision] = arn.split('/').pop()!.split(':');
        return [
          arn,
          {
            family: family!,
            revision: Number(revision),
            ...(opts.sizes?.[arn] ?? { cpuUnits: 1024, memoryMib: 2048 }),
            containers: [],
          },
        ];
      }),
    ),
  };
}

/** The design's mixed board: steady, rolling (two sizes), failed, short, scaled to 0. */
const MIXED = [
  service('motir-web', 2, 2),
  service('motir-relay', 3, 2, {
    deployments: [
      dep({
        taskDefinitionArn: td('motir-relay', 9),
        rolloutState: 'IN_PROGRESS',
        runningCount: 1,
        desiredCount: 2,
        createdAt: ago(5 * 60_000),
      }),
      dep({
        status: 'ACTIVE',
        taskDefinitionArn: td('motir-relay', 8),
        runningCount: 2,
        desiredCount: 0,
      }),
    ],
    current: td('motir-relay', 9),
    sizes: { [td('motir-relay', 8)]: { cpuUnits: 512, memoryMib: 1024 } },
  }),
  service('motir-jobs', 1, 1, {
    deployments: [
      dep({
        taskDefinitionArn: td('motir-jobs', 12),
        rolloutState: 'FAILED',
        runningCount: 0,
        desiredCount: 1,
      }),
      dep({
        status: 'ACTIVE',
        taskDefinitionArn: td('motir-jobs', 11),
        runningCount: 1,
        desiredCount: 1,
      }),
    ],
    current: td('motir-jobs', 12),
  }),
  service('motir-worker', 1, 3, {
    sizes: { [td('motir-worker', 4)]: { cpuUnits: 256, memoryMib: 512 } },
  }),
  service('motir-batch', 0, 0),
];

const READ_AT = new Date().toISOString();

function okDto(
  services: EcsServiceRead[],
  quota: PlatformServicesDTO['quota'] = { status: 'ok', vcpu: 16, readAt: READ_AT },
  account: string | null = ACCOUNT,
  versions?: ReadonlyMap<string, DeploymentVersionRead>,
): PlatformServicesDTO {
  const read = judgeCluster(services, versions);
  return {
    cluster: 'motir-core',
    account,
    readAt: READ_AT,
    read,
    quota,
    share: quota.status === 'ok' ? judgeShare(read.total.vcpu, quota.vcpu) : null,
  };
}

let seq = 0;
async function signInAs(role: 'support' | 'operator' | 'superadmin'): Promise<void> {
  const user = await createTestUser({ email: `ops+services-page-${role}-${++seq}@example.test` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  currentSession = { user: { id: user.id } };
}

async function render(dto: PlatformServicesDTO): Promise<string> {
  await signInAs('superadmin');
  vi.spyOn(platformServicesService, 'read').mockResolvedValue(dto);
  return renderToHtml(await Page());
}

/** HTML text with React's comment markers dropped, so copy can be matched whole. */
function text(html: string): string {
  return html
    .replace(/<!-- -->/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

beforeEach(async () => {
  currentSession = null;
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the services page gate', () => {
  it.each(['support', 'operator'] as const)(
    'a %s gets the 404, and AWS is not read',
    async (role) => {
      await signInAs(role);
      const read = vi.spyOn(platformServicesService, 'read');
      await expect(Page()).rejects.toBeInstanceOf(NotFoundSentinel);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('a superadmin sees the frame first, with the loading state, then the read', async () => {
    await signInAs('superadmin');
    const body = deferred<PlatformServicesDTO>();
    vi.spyOn(platformServicesService, 'read').mockReturnValue(body.promise);
    const flush = await renderFirstFlush(await Page());
    expect(flush.shell).toContain('Operations · Services');
    expect(flush.shell).toContain('data-testid="services-loading"');
    expect(flush.shell).toContain('aria-busy="true"');
    expect(flush.shell).toContain('Reading the cluster and the Fargate quota from AWS…');
    body.resolve(okDto([service('motir-web', 2, 2)]));
    expect(await flush.complete()).toContain('data-testid="services-card"');
  });
});

describe('the services card', () => {
  it('lists every service with its tasks, size, vCPU and deployment, and the header pills', async () => {
    const html = text(await render(okDto(MIXED)));

    expect(html).toContain('ECS services · cluster motir-core');
    expect(html).toContain(`What Motir itself runs in its AWS account (${ACCOUNT})`);
    expect(html).toMatch(new RegExp(`Read from AWS \\d+ s ago · ${utcTime(READ_AT)} UTC`));
    expect(html).toContain('5 services');
    expect(html).toContain('1 rolling');
    expect(html).toContain('1 rollout failed');
    expect(html).toContain('1 service short of tasks');
    // Total: 2 + (1 + 1) + 1 + 0.25 + 0 = 5.25 vCPU of 16 ⇒ 32.8%, shown floored as 32%.
    expect(html).toContain('data-verdict="under"');
    expect(html).toContain('32% of the Fargate quota');
    expect(html).toContain('5.25 vCPU');
    expect(html).toContain('5.95 vCPU to go to 70%'); // 11.2 − 5.25
  });

  it('draws each row state as the design does', async () => {
    const html = text(await render(okDto(MIXED)));
    // steady
    expect(html).toContain('task definition motir-web:4');
    expect(html).toContain('on revision 4');
    expect(html).toContain('2 × 1');
    expect(html).toContain('2 GB');
    // rolling: two sizes, so no × line for it
    expect(html).toContain('Rolling · in progress');
    expect(html).toContain('desired 2 · 2 old + 1 new');
    expect(html).toContain('revision 8 → 9 · 1 of 2 new up');
    expect(html).toContain('started 5 min ago');
    expect(html).not.toContain('3 × 1');
    // failed
    expect(html).toContain('Rollout failed');
    expect(html).toContain('revision 12 stopped · still on 11');
    expect(html).toContain('data-rail="danger"');
    // short
    expect(html).toContain('1 of 3 running');
    expect(html).toContain('2 not started');
    expect(html).toContain('Not rolling');
    expect(html).toContain('data-rail="warning"');
    expect(html).toContain('512 MB');
    expect(html).toContain('0.25 vCPU');
    // scaled to 0
    expect(html).toContain('Scaled to 0');
    // the quota row
    expect(html).toContain('Fargate On-Demand vCPU · L-3032A538');
    expect(html).toContain('16 vCPU');
    expect(html).toMatch(/read \d+ s ago/);
    expect(html).toContain('The Fargate limit for this account and region.');
    // the phone list carries the same rows
    expect(html).toContain('aria-label="ECS services in cluster motir-core"');
    expect(html).toContain('1 vCPU · 2 GB');
    expect(html).toContain('ECS services in cluster motir-core, with the total against');
  });

  it('at or over 70% is the warning mark with what is left before the quota', async () => {
    const html = text(await render(okDto([service('motir-web', 12, 12)])));
    expect(html).toContain('data-verdict="over70"');
    expect(html).toContain('Over 70% of the Fargate quota');
    expect(html).toContain('data-bar="over70"');
    expect(html).toContain('4 vCPU left before the quota');
    expect(html).not.toContain('rolling');
  });

  it('exactly at the quota: no vCPU left', async () => {
    const html = text(await render(okDto([service('motir-web', 16, 16)])));
    expect(html).toContain('data-verdict="atQuota"');
    expect(html).toContain('At the Fargate quota');
    expect(html).toContain('data-bar="atQuota"');
    expect(html).toContain('no vCPU left · a new task will not start');
  });

  it('past the quota: the vCPU over', async () => {
    const html = text(await render(okDto([service('motir-web', 18, 18)])));
    expect(html).toContain('2 vCPU over · a new task will not start');
  });

  it('a quota never read: Not read, never read, and no share or bar — the vCPU stays a figure', async () => {
    const html = text(await render(okDto(MIXED, { status: 'notRead', lastReadAt: null })));
    expect(html).toContain('data-verdict="notRead"');
    expect(html).toContain('aria-label="Fargate quota not read from AWS"');
    expect(html).toContain('aria-label="Quota not read from AWS"');
    expect(html).toContain('never read');
    expect(html).toContain('Not available');
    expect(html).toContain('of the Fargate quota · not known while the quota is not read');
    expect(html).toContain('Service Quotas did not answer');
    expect(html).not.toContain('data-bar=');
    expect(html).toContain('5.25 vCPU');
  });

  it('a quota read before: its last read age', async () => {
    const html = text(
      await render(
        okDto([service('motir-web', 2, 2)], {
          status: 'notRead',
          lastReadAt: ago(3 * 3_600_000).toISOString(),
        }),
      ),
    );
    expect(html).toContain('last read 3 h ago');
  });

  it('a cluster never read in an unknown account: the dash, no rows, and no earlier figure', async () => {
    const html = text(
      await render({
        cluster: 'motir-core',
        account: null,
        readAt: READ_AT,
        read: { status: 'failed', lastReadAt: null },
        quota: { status: 'ok', vcpu: 16, readAt: READ_AT },
        share: null,
      }),
    );
    expect(html).toContain('its AWS account (—)');
    expect(html).toContain(`AWS read failed at ${utcTime(READ_AT)} UTC`);
    expect(html).toContain('Cluster not read');
    expect(html).toContain('role="alert"');
    expect(html).toContain('ECS did not answer');
    expect(html).toContain('No earlier read is on record. Reload to try again.');
    // The loading fallback's table stays in the streamed markup; no ROW is drawn.
    expect(html).not.toContain('data-service=');
    expect(html).not.toContain('data-row="total"');
    expect(html).not.toContain('of the Fargate quota</span>');
  });

  it('a cluster read before: when it was last read', async () => {
    const lastReadAt = '2026-11-10T09:15:00.000Z';
    const html = text(
      await render({
        cluster: 'motir-core',
        account: ACCOUNT,
        readAt: READ_AT,
        read: { status: 'failed', lastReadAt },
        quota: { status: 'notRead', lastReadAt: null },
        share: null,
      }),
    );
    expect(html).toMatch(/It was last read .+ ago, at 09:15 UTC\./);
  });

  it('a steady deployment with no start time draws no "started" line', async () => {
    const html = text(
      await render(
        okDto([
          service('motir-web', 1, 1, {
            deployments: [
              dep({
                taskDefinitionArn: td('motir-web', 4),
                rolloutState: 'IN_PROGRESS',
                runningCount: 1,
                desiredCount: 1,
                createdAt: null,
              }),
            ],
          }),
        ]),
      ),
    );
    expect(html).toContain('Rolling · in progress');
    expect(html).toContain('revision 4 → 4 · 1 of 1 new up');
    expect(html).not.toContain('started ');
  });

  it('a failed rollout with nothing else deployed names its own revision', async () => {
    const html = text(
      await render(
        okDto([
          service('motir-web', 0, 1, {
            deployments: [
              dep({
                taskDefinitionArn: td('motir-web', 4),
                rolloutState: 'FAILED',
                runningCount: 0,
                desiredCount: 1,
              }),
            ],
          }),
        ]),
      ),
    );
    expect(html).toContain('revision 4 stopped · still on 4');
  });
});

// ── The Commit column, the version pill and the stale count (MOTIR-11112,
// design MOTIR-11242 Panels 1–6) ─────────────────────────────────────────────

const SHA = {
  core: 'db9aef8a3c51e7f02b6d4a9e1c8f37b25d06e4a1',
  ai: 'e23526ba90c4d1f7a2e83b56c09d4f1e7a2b3c84',
  gw: '8c03e1f45a7b2d96e0c3f18a4b7d25e90c6f3a17',
  unmapped: '5be09a2d4c1e7f3a9b6d0e2c4a8f1b3d5e7c9a0f',
};
const linked = (sha: string, repo: string) => ({
  sha,
  repository: repo,
  url: `https://github.com/motir-co/${repo}/commit/${sha}`,
});
const behindRead = (
  sha: string,
  repo: string,
  count: number,
  minutes: number,
): DeploymentVersionRead => ({
  commit: linked(sha, repo),
  judgement: {
    state: 'behind',
    count,
    oldestUndeployedAt: ago(minutes * 60_000).toISOString(),
    severity: minutes >= 45 ? 'stale' : 'fresh',
    compareUrl: `https://github.com/motir-co/${repo}/compare/${sha}...main`,
  },
});
const unknownRead = (
  reason: 'no_sha_tag' | 'ecr_not_read' | 'github_not_read' | 'source_not_mapped',
  commit: DeploymentVersionRead['commit'] = null,
): DeploymentVersionRead => ({ commit, judgement: { state: 'unknown', reason } });

/** Panel 2: at scale, mixed. */
const AT_SCALE: EcsServiceRead[] = [
  service('motir-core-web', 2, 2),
  service('motir-ai-planning', 1, 1),
  service('motir-ai-conversation', 1, 1),
  service('motir-codegraph', 1, 1, {
    deployments: [
      dep({
        taskDefinitionArn: td('motir-codegraph', 4),
        rolloutState: 'IN_PROGRESS',
        runningCount: 1,
        desiredCount: 1,
      }),
    ],
  }),
  service('motir-gateway', 1, 1),
  service('motir-gateway-run', 1, 1),
  service('motir-edge-cache', 1, 1),
];
const AT_SCALE_VERSIONS = new Map<string, DeploymentVersionRead>([
  ['motir-core-web', { commit: linked(SHA.core, 'motir-core'), judgement: { state: 'latest' } }],
  ['motir-ai-planning', behindRead(SHA.ai, 'motir-ai', 7, 180)],
  ['motir-ai-conversation', behindRead(SHA.ai, 'motir-ai', 7, 180)],
  ['motir-codegraph', behindRead(SHA.ai, 'motir-ai', 1, 3)],
  ['motir-gateway', behindRead(SHA.gw, 'motir-gateway', 2, 12)],
  [
    'motir-gateway-run',
    { commit: linked(SHA.gw, 'motir-gateway'), judgement: { state: 'diverged' } },
  ],
  [
    'motir-edge-cache',
    unknownRead('source_not_mapped', { sha: SHA.unmapped, repository: null, url: null }),
  ],
]);

/** One row's markup, desktop (`<tr>`) or phone (`<li>`), by its service name. */
function rowOf(html: string, name: string, tag: 'tr' | 'li'): string {
  const start = html.indexOf(`<${tag} data-service="${name}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf(`</${tag}>`, start));
}

describe('the commit column and the version pill', () => {
  it('every service on its latest: a linked short SHA, Latest, and no stale count', async () => {
    const services = [service('motir-core-web', 2, 2), service('motir-ai-planning', 1, 1)];
    const html = text(
      await render(
        okDto(
          services,
          undefined,
          ACCOUNT,
          new Map([
            [
              'motir-core-web',
              { commit: linked(SHA.core, 'motir-core'), judgement: { state: 'latest' } },
            ],
            [
              'motir-ai-planning',
              { commit: linked(SHA.ai, 'motir-ai'), judgement: { state: 'latest' } },
            ],
          ]),
        ),
      ),
    );
    expect(html).toContain('min-w-[62rem]');
    expect(html).toMatch(/<th[^>]*scope="col"[^>]*>Commit<\/th>/);
    for (const tag of ['tr', 'li'] as const) {
      const row = rowOf(html, 'motir-core-web', tag);
      expect(row).toContain(`href="https://github.com/motir-co/motir-core/commit/${SHA.core}"`);
      expect(row).toContain('aria-label="Commit db9aef8 of motir-core on GitHub"');
      expect(row).toContain('>db9aef8</a>');
      expect(row).toContain('data-version="latest"');
      expect(row).toContain('Latest');
    }
    expect(rowOf(html, 'motir-core-web', 'li')).toContain('>Commit</dt>');
    expect(html).not.toContain('data-element="stale-count"');
  });

  it('at scale: behind stale and fresh, rolling with its primary, diverged, unmapped, and the count', async () => {
    const html = text(await render(okDto(AT_SCALE, undefined, ACCOUNT, AT_SCALE_VERSIONS)));
    // header: 3 stale or diverged (two motir-ai stale + gateway-run diverged), not the fresh ones
    expect(html).toContain('3 services stale or diverged');
    expect(html.indexOf('1 rolling')).toBeLessThan(html.indexOf('3 services stale or diverged'));

    const stale = rowOf(html, 'motir-ai-planning', 'tr');
    expect(stale).toContain('data-version="behind-stale"');
    expect(stale).toContain('7 commits behind');
    expect(stale).toContain('oldest undeployed 3 h ago');
    expect(stale).toContain(`href="https://github.com/motir-co/motir-ai/compare/${SHA.ai}...main"`);
    expect(stale).toContain('Compare on GitHub');

    const fresh = rowOf(html, 'motir-gateway', 'tr');
    expect(fresh).toContain('data-version="behind-fresh"');
    expect(fresh).toContain('2 commits behind');
    expect(fresh).toContain('oldest undeployed 12 min ago');

    const rolling = rowOf(html, 'motir-codegraph', 'tr');
    expect(rolling).toContain('data-version="rolling"');
    expect(rolling).toContain('>Rolling<');
    expect(rolling).toContain('data-version="behind-fresh"');
    expect(rolling).toContain('1 commit behind');
    expect(rolling).toContain('the new deployment’s commit');

    const diverged = rowOf(html, 'motir-gateway-run', 'li');
    expect(diverged).toContain('data-version="diverged"');
    expect(diverged).toContain('Diverged');
    expect(diverged).toContain('not on the default branch');

    const unmapped = rowOf(html, 'motir-edge-cache', 'tr');
    expect(unmapped).toContain(
      'class="font-mono text-xs text-(--el-text-identifier)">5be09a2</span>',
    );
    expect(unmapped).not.toContain('/commit/');
    expect(unmapped).toContain(
      'aria-label="Version unknown: No source repository is mapped for this image, so its commit is not compared."',
    );
    expect(unmapped).toContain('data-reason="source_not_mapped"');
    expect(unmapped).toContain('tabindex="0"');
    // desktop: the tooltip carries the reason; the phone writes it out
    expect(unmapped).not.toContain('no source repository mapped');
    expect(rowOf(html, 'motir-edge-cache', 'li')).toContain('no source repository mapped');
  });

  it.each([
    [
      'no_sha_tag',
      'The running image carries no commit tag, so its commit is not known.',
      'no commit tag on the image',
      null,
    ],
    [
      'ecr_not_read',
      'The image’s tags could not be read from ECR, so its commit is not known.',
      'image tags not read',
      null,
    ],
    [
      'github_not_read',
      'GitHub could not be compared just now, so whether this commit is the latest is not known.',
      'GitHub not compared',
      linked(SHA.ai, 'motir-ai'),
    ],
  ] as const)(
    'Unknown · %s: its own reason, and the commit cell the design draws',
    async (reason, sentence, short, commit) => {
      const html = text(
        await render(
          okDto(
            [service('motir-ai-planning', 1, 1)],
            undefined,
            ACCOUNT,
            new Map([['motir-ai-planning', unknownRead(reason, commit)]]),
          ),
        ),
      );
      const row = rowOf(html, 'motir-ai-planning', 'tr');
      expect(row).toContain(`aria-label="Version unknown: ${sentence}"`);
      expect(row).toContain('data-version="unknown"');
      expect(rowOf(html, 'motir-ai-planning', 'li')).toContain(short);
      if (commit) {
        expect(row).toContain('aria-label="Commit e23526b of motir-ai on GitHub"');
      } else {
        expect(row).toContain('class="italic text-(--el-text-secondary)">Not known</span>');
      }
      // every row Unknown: the header says so, never a zero
      expect(html).toContain('aria-label="No service’s deployed version could be read"');
      expect(html).toContain('Versions not read');
    },
  );

  it('one stale service: the singular count; the total and quota rows carry the hidden dash', async () => {
    const html = text(
      await render(
        okDto(
          [service('motir-gateway', 1, 1)],
          undefined,
          ACCOUNT,
          new Map([['motir-gateway', behindRead(SHA.gw, 'motir-gateway', 1, 50)]]),
        ),
      ),
    );
    expect(html).toContain('1 service stale or diverged');
    expect(html).toContain('1 commit behind');
    expect(html).not.toContain('Versions not read');
    const total = html.slice(
      html.indexOf('<tr data-row="total"'),
      html.indexOf('<tr data-row="quota"'),
    );
    expect(total).toContain('<span aria-hidden="true" class="text-(--el-text-secondary)">—</span>');
  });
});

describe('utcTime', () => {
  it('is the HH:MM of the instant in UTC', () => {
    expect(utcTime('2026-11-10T23:05:59.000Z')).toBe('23:05');
  });
});
