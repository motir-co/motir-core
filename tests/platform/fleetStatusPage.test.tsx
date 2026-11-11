import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatter, createTranslator } from 'next-intl';
import { db } from '@/lib/db';
import en from '@/messages/en.json';
import type { FleetImagePublishDTO } from '@/lib/dto/fleetStatusImages';
import type { RunnerAmiFreshnessDTO } from '@/lib/dto/runnerImageFreshness';
import { fleetStatusImagesService } from '@/lib/services/fleetStatusImagesService';
import {
  hostedRow,
  publishIdle,
  publishRecord,
  runnerRow,
  sandboxRow,
} from '../fixtures/fleetStatusImageRows';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { renderToHtml } from '../helpers/serverPageHarness';

// THE CONSOLE'S FLEET STATUS PAGE, Images section (MOTIR-10886; design
// MOTIR-10885). The page gate runs for real over a real session and the real
// `platformRole` column — the session is the one thing mocked. The service's
// reads are stubbed at the service object so every card state the design draws
// can be reached; the service has its own suite
// (`tests/fleetStatus/fleetStatusImagesService.test.ts`).

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

const { default: Page } = await import('@/app/(admin)/admin/fleet-status/page');
const { HostedImageCard, RunnerImageCard, SandboxImageCard } =
  await import('@/app/(admin)/admin/fleet-status/_components/ImageCards');

const ACTOR = 'ops+fleet-status@example.test';
let seq = 0;

async function signInAs(role: 'support' | 'operator' | 'superadmin'): Promise<void> {
  const user = await createTestUser({ email: `ops+fleet-status-${role}-${++seq}@example.test` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  currentSession = { user: { id: user.id } };
}

const decode = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

const hosted = async (row: Parameters<typeof HostedImageCard>[0]['row']) =>
  decode(await renderToHtml(await HostedImageCard({ row, actorEmail: ACTOR })));
const runner = async (row: Parameters<typeof RunnerImageCard>[0]['row']) =>
  decode(await renderToHtml(await RunnerImageCard({ row, actorEmail: ACTOR })));
const sandbox = async (row: Parameters<typeof SandboxImageCard>[0]['row']) =>
  decode(await renderToHtml(await SandboxImageCard({ row, actorEmail: ACTOR })));

beforeEach(async () => {
  currentSession = null;
  await truncateAuthTables();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the fleet status page', () => {
  it.each(['support', 'operator'] as const)(
    'a %s gets the 404, and nothing is read',
    async (role) => {
      await signInAs(role);
      const read = vi.spyOn(fleetStatusImagesService, 'publishRecords');
      await expect(Page()).rejects.toBeInstanceOf(NotFoundSentinel);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('a superadmin gets the frame and the three image cards, in order', async () => {
    await signInAs('superadmin');
    const records = vi.spyOn(fleetStatusImagesService, 'publishRecords').mockResolvedValue({
      hosted: publishRecord(),
      runner: null,
      sandbox: null,
    });
    const readHosted = vi
      .spyOn(fleetStatusImagesService, 'readHosted')
      .mockResolvedValue(hostedRow());
    vi.spyOn(fleetStatusImagesService, 'readRunner').mockResolvedValue(runnerRow());
    vi.spyOn(fleetStatusImagesService, 'readSandbox').mockResolvedValue(sandboxRow());
    const html = decode(await renderToHtml(await Page()));
    expect(html).toContain('Operations · Fleet status');
    expect(html).toContain('<h1');
    expect(html).toContain('id="images-heading"');
    const order = ['hosted', 'runner', 'sandbox'].map((i) => html.indexOf(`data-image="${i}"`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(readHosted).toHaveBeenCalledWith(publishRecord());
    expect(records).toHaveBeenCalled();
  });

  it('one image that cannot be read leaves the other two cards whole', async () => {
    await signInAs('superadmin');
    vi.spyOn(fleetStatusImagesService, 'publishRecords').mockResolvedValue({
      hosted: null,
      runner: null,
      sandbox: null,
    });
    vi.spyOn(fleetStatusImagesService, 'readHosted').mockResolvedValue(hostedRow());
    vi.spyOn(fleetStatusImagesService, 'readRunner').mockResolvedValue({
      status: 'not_read',
      source: 'ghcr',
      detail: 'the private detail',
    });
    vi.spyOn(fleetStatusImagesService, 'readSandbox').mockResolvedValue(sandboxRow());
    const html = decode(await renderToHtml(await Page()));
    expect(html).toContain('data-image="runner" data-state="not_read"');
    expect(html).toContain("Couldn't read the CI runner image");
    expect(html).toContain('data-image="hosted" data-state="days_behind"');
    expect(html).toContain('data-image="sandbox" data-state="up_to_date"');
    expect(html).not.toContain('the private detail');
  });
});

describe('the hosted-agent card', () => {
  it('behind: both tiles, the gap line and an enabled Publish latest', async () => {
    const html = await hosted(hostedRow());
    expect(html).toContain('data-verdict="days_behind"');
    expect(html).toContain('3 days behind');
    expect(html).toContain('5 commits to packages/cli');
    expect(html).toContain('See the commits');
    expect(html).toContain('href="https://github.com/motir-co/motir-core/commit/4a9cb14');
    expect(html).toContain('data-publish="enabled"');
    expect(html).toContain('Pins the newest main build');
    expect(html).toContain('Never published from this page.');
    expect(html).toContain('href="/admin/audit-log?action=fleet.image.publish"');
  });

  it('on the newest build: the same-as-pinned tile and the disabled note', async () => {
    const html = await hosted(
      hostedRow({
        behind: false,
        daysBehind: null,
        cliCommits: null,
        compareUrl: null,
        pinned: { digest: 'sha256:aa', commit: null, createdAt: null },
        publish: publishIdle(),
      }),
    );
    expect(html).toContain('data-verdict="up_to_date"');
    expect(html).toContain('Same as pinned');
    expect(html).toContain('No build commit recorded');
    expect(html).toContain('data-publish="disabled"');
    expect(html).toContain('Production pins the newest main build');
    expect(html).not.toContain('data-element="gap"');
  });

  it('a gap with no commit count or compare still names the days', async () => {
    const html = await hosted(hostedRow({ cliCommits: null, compareUrl: null, daysBehind: null }));
    expect(html).toContain('0 days behind');
    expect(html).not.toContain('See the commits');
  });

  it('publishing: the progress band, the run link and who started it', async () => {
    const publish: FleetImagePublishDTO = publishIdle({
      record: publishRecord(),
      progress: { state: 'running', startedAt: new Date(Date.now() - 120_000).toISOString() },
      blocked: 'running',
    });
    const html = await hosted(hostedRow({ publish }));
    expect(html).toContain('data-verdict="publishing"');
    expect(html).toContain('data-publish="running"');
    expect(html).toContain('Publishing.');
    expect(html).toContain('Hosted-agent pin · run #12');
    expect(html).toContain('by ops+publisher@example.test');
    expect(html).toContain('Publish started by ops+publisher@example.test');
    expect(html).toContain('Publishing…');
  });

  it('publishing with no actor or run number', async () => {
    const publish = publishIdle({
      record: publishRecord({ actorEmail: null, runNumber: null }),
      progress: { state: 'running', startedAt: new Date().toISOString() },
      blocked: 'running',
    });
    const html = await hosted(hostedRow({ publish }));
    expect(html).toContain('Hosted-agent pin · run<');
    expect(html).toContain('Publish started by —');
  });

  it('done: the success band naming the new pin', async () => {
    const publish = publishIdle({
      record: publishRecord({ runUrl: null }),
      progress: { state: 'done', endedAt: new Date().toISOString() },
    });
    const html = await hosted(hostedRow({ behind: false, publish }));
    expect(html).toContain('data-tone="success"');
    expect(html).toContain('Published.');
    expect(html).toContain('Production now pins 4a9cb14 (sha256:464646464646).');
    expect(html).toContain('data-publish="done"');
    expect(html).toContain('Last published from this page by ops+publisher@example.test');
  });

  it('failed: the danger band, GitHub’s words or the no-detail line, and Retry', async () => {
    const failed = (error: string | null) =>
      hostedRow({
        publish: {
          ...hostedRow().publish,
          record: publishRecord(),
          progress: { state: 'failed', endedAt: new Date().toISOString(), error },
        },
      });
    const html = await hosted(failed('the pin PR could not be opened'));
    expect(html).toContain('data-verdict="publish_failed"');
    expect(html).toContain('data-publish="failed"');
    expect(html).toContain('the pin PR could not be opened');
    expect(html).toContain('Retry');
    expect(await hosted(failed(null))).toContain('GitHub recorded no error message');
  });

  it('not read and unset rows are their own cards, with no button', async () => {
    const notRead = await hosted({ status: 'not_read', source: 'github', detail: 'secret' });
    expect(notRead).toContain("Couldn't read the hosted-agent image");
    expect(notRead).toContain("GitHub didn't answer");
    expect(notRead).not.toContain('Publish latest<');
    expect(notRead).not.toContain('secret');
    expect(console.error).toHaveBeenCalledWith('[admin] fleet status image could not be read', {
      image: 'hosted',
      source: 'github',
      detail: 'secret',
    });
    const unset = await hosted({ status: 'unset', variable: 'MOTIR_HOSTED_AGENT_IMAGE' });
    expect(unset).toContain('data-verdict="unset"');
    expect(unset).toContain('MOTIR_HOSTED_AGENT_IMAGE is not set on this deployment');
  });
});

describe('the CI runner card', () => {
  const build = {
    amiId: 'ami-0abc',
    name: 'motir-ci-runner-0.2.4-202611051230-4a9cb14',
    commit: '4a9cb14b54e2366d2a30ad19ac4b924dddca6d31',
    source: 'name' as const,
    account: 'motir-pool-1',
  };

  it('behind by releases: the tags between, an enabled publish, and a current AMI', async () => {
    const html = await runner(runnerRow({ ami: { state: 'current', build } }));
    expect(html).toContain('data-verdict="releases_behind"');
    expect(html).toContain('2 releases behind');
    expect(html).toContain('(runner-v0.2.5, runner-v0.2.6) · 5 days · 4 commits');
    expect(html).toContain('Pins runner-v0.2.6 through the runner pin workflow');
    expect(html).toContain('data-ami="current"');
    expect(html).toContain('Contains every merged change to infra/ci-runner-aws');
    expect(html).toContain('Nov 5, 2026');
    expect(html).toContain('motir-pool-1');
  });

  it('pinned bytes no release names: the unknown-release tile and the day gap', async () => {
    const html = await runner(
      runnerRow({
        pinned: { digest: 'sha256:aa', commit: null, createdAt: null, version: null },
        releasesBetween: null,
        ami: { state: 'stale', build: { ...build, name: null }, unreleased: [] },
      }),
    );
    expect(html).toContain('No release tag names these bytes');
    expect(html).toContain('5 days behind');
    expect(html).toContain('5 days · 4 commits to infra/ci-runner');
    expect(html).toContain('data-ami="stale"');
    expect(html).toContain('0 merged changes to infra/ci-runner-aws came after it');
  });

  it('no commit count: the gap names only the releases', async () => {
    const html = await runner(
      runnerRow({ runnerCommits: null, releasesBetween: null, daysBehind: null }),
    );
    expect(html).toContain('0 days behind');
    expect(html).not.toContain('commits to infra/ci-runner');
  });

  it('a release is needed: the unreleased changes and the tag to push', async () => {
    const ami: RunnerAmiFreshnessDTO = {
      state: 'indeterminate',
      amiId: 'ami-0abc',
      phase: 'ec2',
      detail: 'x',
    };
    const html = await runner(
      runnerRow({
        behind: false,
        releasesBetween: [],
        unreleased: [
          {
            commit: 'a4e83f13c8a344fd306993b997c9c361c29aa3e4',
            committedAt: '2026-11-07T00:00:00Z',
            subject: 'Bump the runner base image',
            paths: ['infra/ci-runner/Dockerfile'],
            relation: 'ahead',
          },
        ],
        ami,
        publish: publishIdle({ blocked: 'release_needed' }),
      }),
    );
    expect(html).toContain('data-verdict="release_needed"');
    expect(html).toContain('data-element="unreleased"');
    expect(html).toContain('Bump the runner base image');
    expect(html).toContain('git tag runner-v0.2.7 origin/main && git push origin runner-v0.2.7');
    expect(html).toContain('The merged changes above need a release first.');
    expect(html).toContain('data-ami="indeterminate"');
    expect(html).toContain('ami-0abc is pinned, but its build could not be read');
  });

  it('up to date with no AMI pinned', async () => {
    const html = await runner(
      runnerRow({ behind: false, releasesBetween: [], publish: publishIdle() }),
    );
    expect(html).toContain('data-verdict="up_to_date"');
    expect(html).toContain('Production pins the newest runner release');
    expect(html).toContain('MOTIR_AWS_RUNNER_AMI_ID is unset');
  });

  it('a publish in flight on another tab shows the running note', async () => {
    const html = await runner(
      runnerRow({ publish: { ...runnerRow().publish, activeRun: true, blocked: 'running' } }),
    );
    expect(html).toContain('data-publish="disabled"');
    expect(html).toContain('already in progress');
  });

  it('done: names the release now pinned', async () => {
    const html = await runner(
      runnerRow({
        behind: false,
        publish: publishIdle({ progress: { state: 'done', endedAt: new Date().toISOString() } }),
      }),
    );
    expect(html).toContain('Production now pins runner-v0.2.4');
    const noTag = await runner(
      runnerRow({
        pinned: { ...runnerRow().pinned, version: null },
        publish: publishIdle({ progress: { state: 'done', endedAt: new Date().toISOString() } }),
      }),
    );
    expect(noTag).toContain('Production now pins sha256:464646464646');
  });

  it('not read and unset rows', async () => {
    expect(await runner({ status: 'not_read', source: 'aws', detail: 'x' })).toContain(
      "AWS didn't answer",
    );
    expect(await runner({ status: 'unset', variable: 'MOTIR_RUNNER_IMAGE' })).toContain(
      'MOTIR_RUNNER_IMAGE is not set',
    );
  });
});

describe('the agent-instance card', () => {
  it('missing tags: the profile grid, the fallback line, older live agents and Re-publish', async () => {
    const html = await sandbox(sandboxRow(['kimi', 'goose'], { liveOlder: 2 }));
    expect(html).toContain('data-verdict="tags_missing"');
    expect(html).toContain('2 of 9 tags missing');
    expect(html).toContain('Newest release <span class="font-mono">cli-v0.18.0</span>');
    expect(html).toContain('7 of 9 published · 2 missing');
    expect(html).toContain('data-profile="kimi" data-published="false"');
    expect(html).toContain(
      'kimi and goose have no 0.18.0 tag, so agents of those profiles still get 0.17.2',
    );
    expect(html).toContain('2 live agents run an older version.');
    expect(html).toContain('Only the 2 missing tags are pushed');
    expect(html).toContain('data-publish="enabled"');
  });

  it('every tag published and every live agent current', async () => {
    const html = await sandbox(sandboxRow());
    expect(html).toContain('All 9 published');
    expect(html).toContain('Every live agent runs 0.18.0.');
    expect(html).toContain('Every profile has its tag at the newest release.');
  });

  it('missing tags with no older release, none published, on a release that cannot be re-run', async () => {
    const row = sandboxRow(
      ['base', 'claude', 'codex', 'opencode', 'kimi', 'antigravity', 'cursor', 'aider', 'goose'],
      {
        previous: null,
        republishable: false,
        publish: publishIdle({ blocked: 'not_republishable' }),
      },
    );
    const html = await sandbox(row);
    expect(html).toContain('have no 0.18.0 tag.</span>');
    expect(html).toContain('cli-v0.18.0 was cut before a re-run could push only the missing tags');
    expect(html).toContain('data-publish="disabled"');
  });

  it('every profile missing but re-runnable still builds the confirm', async () => {
    const all = [
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
    const html = await sandbox(sandboxRow(all, { previous: null }));
    expect(html).toContain('data-publish="enabled"');
  });

  it('done: every profile now has its tag', async () => {
    const html = await sandbox(
      sandboxRow([], {
        publish: publishIdle({
          record: publishRecord({ target: '0.18.0' }),
          progress: { state: 'done', endedAt: new Date().toISOString() },
        }),
      }),
    );
    expect(html).toContain('Every profile now has its tag at 0.18.0.');
    expect(html).toContain('Sandbox release cli-v0.18.0 · run #12');
  });

  it('not read and unset rows', async () => {
    expect(await sandbox({ status: 'not_read', source: 'ghcr', detail: 'x' })).toContain(
      "GHCR didn't answer",
    );
    expect(await sandbox({ status: 'unset', variable: 'X' })).toContain('X is not set');
  });
});
