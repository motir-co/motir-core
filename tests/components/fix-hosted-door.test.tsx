// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import type { FixDetailDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import type { HomeWorkItemRowDto } from '@/lib/dto/home';
import type { OpenRepairRunDto, WorkItemRepairViewDto } from '@/lib/dto/workItemRepair';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// FIX ON THE HOSTED AGENT (Story MOTIR-1626 · MOTIR-6930), built to MOTIR-6817's approved
// design — `design/github/approve-and-merge--agent-review.mock.html` Panels 3–3e and
// `design/workbench/workbench--to-fix--review-agent.mock.html` Panels 2 and 4. The
// Continue hosted door's exact row, beside `motir fix <KEY>`, on the three surfaces: the
// Development frame's fix part, the To fix banner and the Workbench To fix row. Offered
// ONLY for a card a REVIEW sent back, to a viewer who may press Run hosted; every state is
// the route's own answer (`POST /api/work-items/{key}/hosted-runs`, `mode: 'fix'`).

const refresh = vi.fn();
/** The window re-read the Workbench list is handed (MOTIR-8574). */
const reread = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh }),
  usePathname: () => '/items/ACME-12',
  useSearchParams: () => new URLSearchParams(),
}));

import { HostedModelsProvider } from '@/components/hosted/HostedModelsProvider';
import { FixHostedControl } from '@/components/hosted/FixHostedControl';
import { RepairFixPart } from '@/components/github/RepairFixPart';
import { ToFixBanner } from '@/app/(authed)/items/[key]/_components/ToFixBanner';
import { ToFixHostedDoor } from '@/app/(authed)/items/[key]/_components/ToFixHostedDoor';
import { WorkbenchList } from '@/app/(authed)/workbench/_components/WorkbenchList';
import { toWorkbenchRowViews } from '@/app/(authed)/workbench/_components/workbenchRows';

const fix = en.github.development.fix;
const hosted = fix.hosted;
const refused = en.runs.hosted.refused;
const picker = en.runs.hosted.picker;

// ── the fake routes ─────────────────────────────────────────────────────────

type Answer = { status: number; body: unknown };
let models: Answer;
let start: () => Answer | Promise<Answer>;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const answer =
    url === '/api/hosted-runs/models'
      ? models
      : url.endsWith('/hosted-runs') && init?.method === 'POST'
        ? await start()
        : { status: 500, body: {} };
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { 'Content-Type': 'application/json' },
  });
});
const starts = () =>
  fetchMock.mock.calls
    .filter(([u, init]) => String(u).endsWith('/hosted-runs') && init?.method === 'POST')
    .map(([u, init]) => ({
      url: String(u),
      body: JSON.parse(String(init!.body)) as Record<string, unknown>,
    }));
const modelReads = () =>
  fetchMock.mock.calls.filter(([u]) => String(u) === '/api/hosted-runs/models').length;

beforeEach(() => {
  models = {
    status: 200,
    body: {
      models: [
        { id: 'claude-sonnet-5', provider: 'anthropic' },
        { id: 'claude-opus-5-5', provider: 'anthropic' },
      ],
      default: 'claude-opus-5-5',
    },
  };
  start = () => ({ status: 201, body: { dispatchRunId: 'run_fix_1', created: true } });
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  refresh.mockReset();
  reread.mockReset();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => {});
const pressFix = (scope: HTMLElement = document.body) =>
  act(async () => {
    fireEvent.click(within(scope).getByTestId('fix-hosted'));
  });

// ── fixtures ────────────────────────────────────────────────────────────────

const PR_GREEN = {
  repo: 'acme/web',
  number: 7,
  ci: 'passing' as const,
  queueExit: null,
  conflict: null,
  outOfDate: null,
};
const PR_GREEN_2 = {
  repo: 'acme/ai',
  number: 88,
  ci: 'passing' as const,
  queueExit: null,
  conflict: null,
  outOfDate: null,
};

function offer(over: Partial<Extract<WorkItemRepairViewDto, { state: 'offer' }>> = {}) {
  return {
    state: 'offer' as const,
    repairClass: 'review' as const,
    acceptanceRefusal: null,
    failing: [PR_GREEN, PR_GREEN_2],
    lastGaveUp: null,
    ...over,
  };
}

const MARA = { id: 'usr_mara', name: 'Mara S.' };
const STARTED = new Date(Date.now() - 3 * 60_000).toISOString();

function openRun(over: Partial<OpenRepairRunDto> = {}): OpenRepairRunDto {
  return {
    id: 'run_fix_612',
    label: 'motir fix · 2026-09-29 10:02 UTC',
    hosted: true,
    holder: MARA,
    byViewer: false,
    startedAt: STARTED,
    ...over,
  };
}

const DETAIL: FixDetailDto = {
  groupKey: null,
  repair: 'fix',
  check: null,
  queueReason: null,
  base: null,
  reviewerName: null,
  notePreview: null,
  gate: null,
  lastHeardAt: null,
  ranByName: null,
  branch: null,
  branches: null,
  pushed: null,
  continueKey: null,
  diedReason: null,
  affected: 2,
  total: 2,
};
const AGENT: Partial<FixDetailDto> = {
  gate: 'agent_review',
  reviewerName: 'Review agent',
  notePreview: 'Two of the card’s acceptance criteria are not met yet.',
};
const PERSON: Partial<FixDetailDto> = {
  gate: 'pull_request_approval',
  reviewerName: 'Mei Lin',
  notePreview: 'The empty state should name the reviewer.',
};

/** Every To fix reason the door must NOT be offered for (§12.9). */
const NOT_A_REVIEW: [string, WorkItemFixReasonDto, Partial<FixDetailDto>][] = [
  ['red CI', 'ci_failed', { check: 'vitest' }],
  ['a merge-queue failure', 'queue_failed', { queueReason: 'CI_FAILURE' }],
  ['a conflict', 'conflicted', { base: 'main' }],
  ['an acceptance Re-run', 'changes_requested', { gate: 'acceptance_result', reviewerName: 'Mei' }],
  [
    'a dead run',
    'run_died',
    {
      repair: 'continue',
      lastHeardAt: STARTED,
      ranByName: 'Mara S.',
      branch: 'b',
      branches: [{ repository: 'web', branch: 'b' }],
      pushed: true,
      continueKey: 'ACME-12',
      diedReason: 'lapsed',
    },
  ],
];

// ═══════════════════════════════════════════════════════════════════════════
// The control — every answer the start path gives
// ═══════════════════════════════════════════════════════════════════════════

function mountControl(
  props: { viewerId?: string; onStarted?: () => void; onStateMoved?: () => void } = {},
  zh = false,
) {
  render(
    <HostedModelsProvider>
      <FixHostedControl itemKey="ACME-12" viewerId={props.viewerId ?? 'usr_me'} {...props} />
    </HostedModelsProvider>,
    zh ? { locale: 'zh', messages: zhMessages } : {},
  );
  return flush();
}

describe('the door — the Continue hosted door’s exact row (Panel 3)', () => {
  it('draws the model picker with the offered default, then the primary button', async () => {
    await mountControl();
    const door = screen.getByTestId('fix-hosted-door');
    expect(door.className).toContain('flex-wrap'); // ~400px: the button drops under the picker
    expect(within(door).getByRole('combobox').textContent).toContain('claude-opus-5-5');
    const button = within(door).getByTestId('fix-hosted');
    expect(button.textContent).toBe(hosted.button);
    expect(button.hasAttribute('disabled')).toBe(false);
    // The picker precedes the button, as the Continue hosted row orders them.
    expect(door.firstElementChild?.contains(within(door).getByRole('combobox'))).toBe(true);
  });

  it('a press posts mode fix, the picked model and a FRESH idempotency key each time', async () => {
    const onStarted = vi.fn();
    start = () => ({ status: 409, body: { code: 'hosted_run_unavailable' } });
    await mountControl({ onStarted });
    await pressFix();
    await pressFix();
    const [a, b] = starts();
    expect(a!.url).toBe('/api/work-items/ACME-12/hosted-runs');
    expect(a!.body).toMatchObject({ mode: 'fix', model: 'claude-opus-5-5' });
    expect(typeof a!.body.idempotencyKey).toBe('string');
    expect(a!.body.idempotencyKey).not.toBe(b!.body.idempotencyKey);
  });

  it('starting (Panel 3a) — the picker and the button disabled, the button reads Starting…', async () => {
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    start = async () => {
      await pending;
      return { status: 201, body: { dispatchRunId: 'r' } };
    };
    await mountControl();
    act(() => {
      fireEvent.click(screen.getByTestId('fix-hosted'));
    });
    const button = screen.getByTestId('fix-hosted');
    expect(button.textContent).toContain(en.runs.hosted.door.starting);
    expect(button.hasAttribute('disabled')).toBe(true);
    const combo = screen.getByRole('combobox');
    expect(combo.hasAttribute('disabled') || combo.getAttribute('aria-disabled') === 'true').toBe(
      true,
    );
    await act(async () => {
      release();
      await pending;
    });
  });

  it('201 — started: the surface re-reads (the running state is the server’s to draw)', async () => {
    const onStarted = vi.fn();
    const onStateMoved = vi.fn();
    await mountControl({ onStarted, onStateMoved });
    await pressFix();
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onStateMoved).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('refused — a repair is already running (Panel 3c)', () => {
  it('names the holder in the door’s warning notice, directly under the door — never a start', async () => {
    const onStarted = vi.fn();
    const onStateMoved = vi.fn();
    start = () => ({
      status: 409,
      body: { code: 'hosted_fix_taken', holder: MARA, startedAt: STARTED },
    });
    await mountControl({ onStarted, onStateMoved });
    await pressFix();
    const notice = screen.getByTestId('fix-hosted-refused-taken');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toMatch(
      /^Not started — a repair is already running, started by Mara S\. 3 min\. ago\./,
    );
    expect(notice.querySelector('b')?.textContent).toBe('Mara S.');
    expect(notice.textContent).toContain(refused.notReady.body);
    // The door stays, the notice under it; nothing started and the view is not re-read.
    const control = screen.getByTestId('fix-hosted-control');
    expect(control.firstElementChild).toBe(screen.getByTestId('fix-hosted-door'));
    expect(onStarted).not.toHaveBeenCalled();
    expect(onStateMoved).not.toHaveBeenCalled();
  });

  it('the viewer’s own repair reads *you*', async () => {
    start = () => ({
      status: 409,
      body: { code: 'hosted_fix_taken', holder: { id: 'usr_me', name: 'Me' }, startedAt: STARTED },
    });
    await mountControl();
    await pressFix();
    expect(screen.getByTestId('fix-hosted-refused-taken').textContent).toMatch(
      /^Not started — you already have a repair running, started 3 min\. ago\./,
    );
  });
});

describe('could not start (Panel 3d) — the Continue hosted door’s answers, reused', () => {
  const cases: [string, Answer, string, string, string][] = [
    [
      'out of credits',
      { status: 402, body: { code: 'hosted_run_out_of_credits' } },
      'outOfCredits',
      refused.outOfCredits.title,
      hosted.refused.outOfCredits.body,
    ],
    [
      'model not offered',
      { status: 422, body: { code: 'hosted_model_not_offered' } },
      'modelNotOffered',
      'claude-opus-5-5 is no longer offered.',
      refused.modelNotOffered.body,
    ],
    [
      'models unavailable',
      { status: 503, body: { code: 'hosted_models_unavailable' } },
      'unavailable',
      refused.unavailable.title,
      refused.unavailable.body,
    ],
    [
      'hosted runs unavailable',
      { status: 503, body: { code: 'hosted_run_unavailable' } },
      'unavailable',
      refused.unavailable.title,
      refused.unavailable.body,
    ],
    [
      'boot failed',
      { status: 503, body: { code: 'hosted_run_boot_failed', dispatchRunId: 'r' } },
      'bootFailed',
      refused.bootFailed.title,
      refused.bootFailed.body,
    ],
    ['failed', { status: 500, body: {} }, 'failed', refused.failed.title, refused.failed.body],
  ];
  it.each(cases)(
    '%s — its own notice, and no started state',
    async (_n, answer, kind, title, body) => {
      const onStarted = vi.fn();
      start = () => answer;
      await mountControl({ onStarted });
      await pressFix();
      const notice = screen.getByTestId(`fix-hosted-refused-${kind}`);
      expect(notice.querySelector('p.font-semibold')?.textContent).toBe(title);
      expect(notice.textContent).toContain(body);
      expect(onStarted).not.toHaveBeenCalled();
    },
  );

  it('out of credits names THIS door and the terminal, never Run hosted', async () => {
    start = () => ({ status: 402, body: { code: 'hosted_run_out_of_credits' } });
    await mountControl();
    await pressFix();
    const text = screen.getByTestId('fix-hosted-refused-outOfCredits').textContent ?? '';
    expect(text).toContain('Fix on the hosted agent works again');
    expect(text).not.toContain('Run works again');
  });

  it('model not offered re-reads the list, so the person chooses again in place', async () => {
    start = () => ({ status: 422, body: { code: 'hosted_model_not_offered' } });
    await mountControl();
    expect(modelReads()).toBe(1);
    await pressFix();
    expect(modelReads()).toBe(2);
  });

  it('a repository the app cannot write to — the shipped per-repository list', async () => {
    start = () => ({
      status: 409,
      body: {
        code: 'hosted_repository_not_writable',
        repositories: [
          {
            repository: 'acme/ai',
            reason: 'The app is not installed.',
            fix: 'Install',
            fixUrl: null,
          },
        ],
        totalRepositories: 2,
      },
    });
    await mountControl();
    await pressFix();
    const notice = screen.getByTestId('fix-hosted-refused-notWritable');
    expect(notice.textContent).toContain(
      'Not started — Motir’s app can’t write to 1 of this run’s 2 repositories.',
    );
    expect(notice.textContent).toContain('acme/ai');
    expect(within(notice).getByRole('link', { name: refused.notWritable.open })).toBeTruthy();
  });

  it.each(['hosted_fix_not_sent_back', 'hosted_fix_not_repairable'])(
    '%s — the page is stale: not started, and the surface re-reads (the door then goes)',
    async (code) => {
      const onStateMoved = vi.fn();
      start = () => ({ status: 409, body: { code } });
      await mountControl({ onStateMoved });
      await pressFix();
      expect(screen.getByTestId('fix-hosted-refused-stale').textContent).toContain(
        refused.failed.title,
      );
      expect(onStateMoved).toHaveBeenCalledTimes(1);
    },
  );

  it('the picker’s two notices — models could not load, and no model offered', async () => {
    models = { status: 503, body: {} };
    await mountControl();
    expect(screen.getByTestId('fix-hosted-models-unavailable').textContent).toContain(
      picker.unavailableBody,
    );
    expect(screen.getByTestId('fix-hosted').hasAttribute('disabled')).toBe(true);
    cleanup();
    models = { status: 200, body: { models: [], default: null } };
    await mountControl();
    expect(screen.getByTestId('fix-hosted-models-empty').textContent).toContain(picker.emptyBody);
  });

  it('zh — the door and a refusal render with no English fallback', async () => {
    start = () => ({
      status: 409,
      body: { code: 'hosted_fix_taken', holder: MARA, startedAt: STARTED },
    });
    await mountControl({}, true);
    expect(screen.getByTestId('fix-hosted').textContent).toBe(
      zhMessages.github.development.fix.hosted.button,
    );
    await pressFix();
    const text = screen.getByTestId('fix-hosted-refused-taken').textContent ?? '';
    expect(text).toContain('未启动——已有一个修复在运行');
    expect(text).not.toMatch(/Not started|repair/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Surface 1 — the Development frame's fix part (§ 30 Panels 3, 3b, 3e)
// ═══════════════════════════════════════════════════════════════════════════

const DOOR = <span data-testid="door-slot">door</span>;

function renderPart(
  repair: WorkItemRepairViewDto,
  opts: { door?: boolean; sentBackBy?: Parameters<typeof RepairFixPart>[0]['sentBackBy'] } = {},
) {
  return render(
    <RepairFixPart
      repair={repair}
      itemIdentifier="ACME-12"
      sentBackBy={opts.sentBackBy ?? { by: 'agent' }}
      hostedDoor={opts.door === false ? null : DOOR}
    />,
  );
}

const part = () => screen.getByTestId('repair-fix-part');

describe('the fix part — two repairs for a card a review sent back', () => {
  it('Panel 3 — the hosted door LEADS under its lead, then the terminal command; either-way note', () => {
    renderPart(offer());
    const p = part();
    const text = p.textContent ?? '';
    expect(within(p).getByTestId('door-slot')).toBeTruthy();
    const order = [
      text.indexOf(hosted.lead),
      text.indexOf('door'),
      text.indexOf(hosted.orTerminal),
      text.indexOf('motir fix ACME-12'),
      text.indexOf(`${hosted.eitherWay} ${fix.reviewedAgain}`),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The shipped single-repair lead is not drawn beside the door.
    expect(text).not.toContain(fix.lead);
  });

  it('Panel 3e — a person’s Changes requested offers the same door', () => {
    renderPart(offer(), { sentBackBy: { by: 'person', name: 'Mei Lin' } });
    expect(within(part()).getByTestId('door-slot')).toBeTruthy();
    expect(part().textContent).toContain('Mei Lin sent these commits back');
  });

  it('no door for a viewer who may not press Run hosted — the command alone, with fix.lead', () => {
    renderPart(offer(), { door: false });
    expect(screen.queryByTestId('door-slot')).toBeNull();
    expect(part().textContent).toContain(fix.lead);
    expect(part().textContent).toContain('motir fix ACME-12');
    expect(part().textContent).not.toContain(hosted.lead);
  });

  it.each([
    ['red CI', offer({ repairClass: 'ci', failing: [{ ...PR_GREEN, ci: 'failing' as const }] })],
    [
      'an acceptance Re-run',
      offer({
        repairClass: 'acceptance_rerun',
        acceptanceRefusal: { reasonMd: 'x', decidedByLabel: 'Mei', decidedAt: STARTED },
      }),
    ],
  ])('absent for %s even when the host passes it', (_n, repair) => {
    renderPart(repair);
    expect(screen.queryByTestId('door-slot')).toBeNull();
    expect(part().textContent).toContain('motir fix ACME-12');
  });

  it('Panel 3b — a HOSTED repair running: Fixing, who, since when, the run link; no door, no command', () => {
    renderPart({
      state: 'in_progress',
      repairClass: 'review',
      acceptanceRefusal: null,
      failing: [PR_GREEN],
      holder: { id: 'usr_me', name: 'Me' },
      byViewer: true,
      startedAt: STARTED,
      run: { id: 'run_fix_612', label: 'motir fix · 2026-09-29 10:02 UTC', hosted: true },
    });
    const p = part();
    expect(p.textContent).toContain(fix.fixing.pill);
    const line = within(p).getByTestId('repair-hosted-fixing');
    expect(line.textContent).toMatch(
      /^Being fixed by you on the hosted agent · started 3 min\. ago · motir fix · 2026-09-29 10:02 UTC$/,
    );
    const link = within(p).getByTestId('repair-hosted-run-link');
    expect(link.getAttribute('href')).toContain('run_fix_612');
    expect(p.textContent).toContain(hosted.fixing.why);
    expect(screen.queryByTestId('door-slot')).toBeNull();
    expect(p.textContent).not.toContain('motir fix ACME-12');
  });

  it('a hosted repair someone else started names them', () => {
    renderPart({
      state: 'in_progress',
      repairClass: 'review',
      acceptanceRefusal: null,
      failing: [PR_GREEN],
      holder: MARA,
      byViewer: false,
      startedAt: STARTED,
      run: { id: 'run_fix_612', label: 'motir fix · 2026-09-29 10:02 UTC', hosted: true },
    });
    expect(screen.getByTestId('repair-hosted-fixing').textContent).toMatch(
      /^Being fixed by Mara S\. on the hosted agent/,
    );
  });

  it('a LOCAL `motir fix` holding the claim draws § 21’s F2 unchanged — no door either', () => {
    renderPart({
      state: 'in_progress',
      repairClass: 'review',
      acceptanceRefusal: null,
      failing: [PR_GREEN],
      holder: MARA,
      byViewer: false,
      startedAt: STARTED,
      run: { id: 'run_fix_9', label: 'motir fix · x', hosted: false },
    });
    expect(screen.queryByTestId('repair-hosted-fixing')).toBeNull();
    expect(part().textContent).toContain('Being fixed by Mara S. · started');
    expect(part().textContent).toContain(fix.fixing.why);
    expect(screen.queryByTestId('door-slot')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Surface 2 — the To fix banner (§ 32 Panel 4)
// ═══════════════════════════════════════════════════════════════════════════

const banner = en.toFix.banner;

function renderBanner(
  reason: WorkItemFixReasonDto,
  over: Partial<FixDetailDto>,
  opts: { door?: boolean; repairRun?: OpenRepairRunDto | null; zh?: boolean } = {},
) {
  return render(
    <ToFixBanner
      identifier="ACME-12"
      fixReason={reason}
      fixDetail={{ ...DETAIL, ...over }}
      statusCategory="in_progress"
      repairRun={opts.repairRun ?? null}
      hostedDoor={opts.door === false ? null : DOOR}
    />,
    opts.zh ? { locale: 'zh', messages: zhMessages } : {},
  );
}

describe('the To fix banner', () => {
  it.each([
    ['the review agent', AGENT],
    ['a person’s Request changes', PERSON],
  ])(
    'sent back by %s — the door leads, then *Or repair it from your terminal* and the command',
    (_n, who) => {
      renderBanner('changes_requested', who);
      const b = screen.getByTestId('to-fix-banner');
      const text = b.textContent ?? '';
      const order = [
        text.indexOf(banner.hostedLead),
        text.indexOf('door'),
        text.indexOf(banner.orTerminal),
        text.indexOf('motir fix ACME-12'),
      ];
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(text).not.toContain(banner.leadFix);
    },
  );

  it('a viewer who may not run it hosted keeps leadFix and the command alone', () => {
    renderBanner('changes_requested', AGENT, { door: false });
    const text = screen.getByTestId('to-fix-banner').textContent ?? '';
    expect(text).toContain(banner.leadFix);
    expect(text).not.toContain(banner.hostedLead);
    expect(screen.queryByTestId('door-slot')).toBeNull();
  });

  it.each(NOT_A_REVIEW)('absent for %s', (_n, reason, over) => {
    renderBanner(reason, over);
    expect(screen.queryByTestId('door-slot')).toBeNull();
    expect(screen.getByTestId('to-fix-banner').textContent).not.toContain(banner.hostedLead);
  });

  it('a hosted repair running — one line naming who and when, with the run link; no door, no command', () => {
    renderBanner('changes_requested', AGENT, { repairRun: openRun() });
    const b = screen.getByTestId('to-fix-banner');
    const line = within(b).getByTestId('to-fix-banner-hosted-fixing');
    expect(line.textContent).toMatch(
      /^A hosted repair is running — started by Mara S\. 3 min\. ago · motir fix · 2026-09-29 10:02 UTC$/,
    );
    expect(within(b).getByTestId('repair-hosted-run-link').getAttribute('href')).toContain(
      'run_fix_612',
    );
    expect(screen.queryByTestId('door-slot')).toBeNull();
    expect(b.textContent).not.toContain('motir fix ACME-12');
    expect(b.textContent).not.toContain(banner.leadFix);
  });

  it('…started by you, when the viewer pressed it', () => {
    renderBanner('changes_requested', PERSON, { repairRun: openRun({ byViewer: true }) });
    expect(screen.getByTestId('to-fix-banner-hosted-fixing').textContent).toMatch(
      /^A hosted repair is running — started by you 3 min\. ago/,
    );
  });

  it('a LOCAL repair open withdraws the door and keeps the command', () => {
    renderBanner('changes_requested', AGENT, { repairRun: openRun({ hosted: false }) });
    expect(screen.queryByTestId('door-slot')).toBeNull();
    expect(screen.queryByTestId('to-fix-banner-hosted-fixing')).toBeNull();
    expect(screen.getByTestId('to-fix-banner').textContent).toContain('motir fix ACME-12');
  });

  it('zh — the leads and the running line render with no English fallback', () => {
    renderBanner('changes_requested', AGENT, { zh: true });
    const text = screen.getByTestId('to-fix-banner').textContent ?? '';
    expect(text).toContain(zhMessages.toFix.banner.hostedLead);
    expect(text).toContain(zhMessages.toFix.banner.orTerminal);
    cleanup();
    renderBanner('changes_requested', AGENT, { zh: true, repairRun: openRun() });
    const running = screen.getByTestId('to-fix-banner-hosted-fixing').textContent ?? '';
    expect(running).toContain('托管修复正在运行');
    expect(running).not.toMatch(/repair is running|started by/);
  });

  it('the banner’s own door posts mode fix and, on a start, refreshes the page', async () => {
    const onRunsChanged = vi.fn();
    window.addEventListener('motir:hosted-runs-changed', onRunsChanged);
    render(
      <ToFixBanner
        identifier="ACME-12"
        fixReason="changes_requested"
        fixDetail={{ ...DETAIL, ...AGENT }}
        statusCategory="in_progress"
        hostedDoor={<ToFixHostedDoor itemKey="ACME-12" viewerId="usr_me" />}
      />,
    );
    await flush();
    await pressFix(screen.getByTestId('to-fix-banner'));
    expect(starts()[0]!.body).toMatchObject({ mode: 'fix', model: 'claude-opus-5-5' });
    // Server surfaces re-read, and the Run section's island is told to refetch.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onRunsChanged).toHaveBeenCalledTimes(1);
    window.removeEventListener('motir:hosted-runs-changed', onRunsChanged);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Surface 3 — the Workbench To fix row (§ 32 Panel 2)
// ═══════════════════════════════════════════════════════════════════════════

const MEMBERS: WorkspaceMemberDTO[] = [
  {
    userId: 'u1',
    name: 'Zhu Yue',
    email: 'y@example.com',
    workspaceRole: 'manager',
    customRole: null,
  },
];
const WORKFLOW = {
  statuses: [{ key: 'in_review', label: 'In Review', category: 'in_progress' }],
} as unknown as WorkflowDto;

function row(
  identifier: string,
  fixReason: WorkItemFixReasonDto,
  over: Partial<FixDetailDto>,
  flags: { canFixHosted?: boolean; repairRun?: OpenRepairRunDto | null } = {},
): HomeWorkItemRowDto {
  return {
    id: `wi_${identifier}`,
    kind: 'task',
    type: null,
    key: 1,
    identifier,
    title: `Title of ${identifier}`,
    status: 'in_review',
    ciState: null,
    fixReason,
    fixDetail: { ...DETAIL, ...over },
    priority: 'medium',
    assigneeId: 'u1',
    reporterId: 'u1',
    executor: null,
    storyPoints: null,
    estimateMinutes: null,
    updatedAt: '2026-09-29T00:00:00.000Z',
    completedAt: null,
    project: { id: 'p1', identifier: 'ACME', name: 'Acme' },
    viewerIsAssignee: true,
    viewerIsReporter: false,
    canContinueHosted: false,
    fixGroupKind: null,
    fixMembers: [],
    resumeState: null,
    resumeRunId: null,
    resumeMembers: [],
    groupHead: null,
    groupMembers: [],
    canFixHosted: flags.canFixHosted ?? true,
    repairRun: flags.repairRun ?? null,
  };
}

function renderRows(rows: HomeWorkItemRowDto[], zh = false) {
  render(
    <WorkbenchList
      rows={toWorkbenchRowViews(rows, WORKFLOW, MEMBERS, false)}
      label="To fix"
      tab="to-fix"
      pagination={{ total: rows.length, page: 1, pageSize: 25 }}
      empty={<p>Nothing to fix</p>}
      viewerId="usr_me"
      reread={reread}
    />,
    zh ? { locale: 'zh', messages: zhMessages } : {},
  );
  return flush();
}

const fixLine = (key: string) => screen.getByTestId(`workbench-fix-${key}`);

describe('the Workbench To fix row', () => {
  it('both review refusals — the door LEADS, the command keeps the right edge; ONE model read', async () => {
    await renderRows([
      row('ACME-12', 'changes_requested', AGENT),
      row('ACME-14', 'changes_requested', PERSON),
    ]);
    for (const key of ['ACME-12', 'ACME-14']) {
      const line = fixLine(key);
      const door = within(line).getByTestId('fix-hosted-door');
      const command = within(line).getByText(`motir fix ${key}`);
      expect(door.compareDocumentPosition(command) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(modelReads()).toBe(1);
  });

  it('a press posts mode fix for THAT row and re-reads the page', async () => {
    await renderRows([
      row('ACME-12', 'changes_requested', AGENT),
      row('ACME-14', 'changes_requested', PERSON),
    ]);
    await pressFix(fixLine('ACME-14'));
    expect(starts().map((s) => s.url)).toEqual(['/api/work-items/ACME-14/hosted-runs']);
    expect(starts()[0]!.body.mode).toBe('fix');
    // The list re-reads its window (MOTIR-8574) — never the route.
    expect(reread).toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refused — the door’s warning notice in the row’s notice slot names the holder', async () => {
    start = () => ({
      status: 409,
      body: { code: 'hosted_fix_taken', holder: MARA, startedAt: STARTED },
    });
    await renderRows([row('ACME-14', 'changes_requested', PERSON)]);
    await pressFix(fixLine('ACME-14'));
    const notice = within(fixLine('ACME-14')).getByTestId('fix-hosted-refused-taken');
    expect(notice.textContent).toContain('a repair is already running, started by Mara S.');
    expect(within(fixLine('ACME-14')).getByTestId('fix-hosted-door')).toBeTruthy();
  });

  it('a hosted repair running — one sentence and the run link in place of the door AND the command', async () => {
    await renderRows([
      row('ACME-12', 'changes_requested', AGENT, { repairRun: openRun({ byViewer: true }) }),
    ]);
    const line = fixLine('ACME-12');
    const sentence = within(line).getByTestId('workbench-fix-hosted-fixing-ACME-12');
    expect(sentence.textContent).toBe(
      'Being fixed on the hosted agent by you · motir fix · 2026-09-29 10:02 UTC',
    );
    expect(within(line).getByTestId('repair-hosted-run-link').getAttribute('href')).toContain(
      'run_fix_612',
    );
    expect(within(line).queryByTestId('fix-hosted-door')).toBeNull();
    expect(within(line).queryByText('motir fix ACME-12')).toBeNull();
    // Nothing on the page offers the door, so the model list is never read.
    expect(modelReads()).toBe(0);
  });

  it('a local repair open — no door, the command stays', async () => {
    await renderRows([
      row('ACME-12', 'changes_requested', AGENT, { repairRun: openRun({ hosted: false }) }),
    ]);
    expect(within(fixLine('ACME-12')).queryByTestId('fix-hosted-door')).toBeNull();
    expect(within(fixLine('ACME-12')).getByText('motir fix ACME-12')).toBeTruthy();
  });

  it('a viewer who may not run it hosted — the command alone', async () => {
    await renderRows([row('ACME-12', 'changes_requested', AGENT, { canFixHosted: false })]);
    expect(within(fixLine('ACME-12')).queryByTestId('fix-hosted-door')).toBeNull();
    expect(within(fixLine('ACME-12')).getByText('motir fix ACME-12')).toBeTruthy();
  });

  it.each(NOT_A_REVIEW)(
    'absent for %s — even if a row claimed it could',
    async (_n, reason, over) => {
      await renderRows([row('ACME-20', reason, over, { canFixHosted: true })]);
      expect(within(fixLine('ACME-20')).queryByTestId('fix-hosted-door')).toBeNull();
    },
  );

  it('zh — the running sentence renders with no English fallback', async () => {
    await renderRows([row('ACME-12', 'changes_requested', AGENT, { repairRun: openRun() })], true);
    const text = screen.getByTestId('workbench-fix-hosted-fixing-ACME-12').textContent ?? '';
    expect(text).toContain('正在用托管智能体修复');
    expect(text).not.toMatch(/Being fixed|hosted agent/);
  });
});

// A MODEL WITH NO AGENT-RUN CAPACITY at the Fix door (Story MOTIR-9541 · MOTIR-9630;
// `design/runs/run-section--no-capacity.mock.html` Panel N8): the same hold and the
// same refusal as Run, which keeps the door (it is NOT stale) and re-reads the list.
describe('no agent-run capacity (N8)', () => {
  const held = {
    status: 200,
    body: {
      models: [
        { id: 'claude-sonnet-5', provider: 'anthropic', capacity: { verdict: 'available' } },
        {
          id: 'claude-opus-5-5',
          provider: 'anthropic',
          capacity: { verdict: 'no_capacity', reason: 'provider_rate_limited' },
        },
      ],
      default: 'claude-opus-5-5',
    },
  };

  it('a held preselected model holds Fix with the Held Run line', async () => {
    models = held;
    await mountControl();
    const button = screen.getByTestId('fix-hosted') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const line = screen.getByTestId('hosted-held-line');
    expect(line.textContent).toContain('claude-opus-5-5 has no agent-run capacity right now.');
    expect(button.getAttribute('aria-describedby')).toBe(line.id);
  });

  it('a refused fix names the model, keeps the door and re-reads the list once', async () => {
    const onStateMoved = vi.fn();
    start = () => ({
      status: 409,
      body: { code: 'hosted_run_no_capacity', model: 'claude-opus-5-5', reason: 'x' },
    });
    await mountControl({ onStateMoved });
    models = held;
    await pressFix();
    await flush();
    const notice = screen.getByTestId('fix-hosted-refused-noCapacity');
    expect(notice.textContent).toContain(
      refused.noCapacity.title.replace('{model}', 'claude-opus-5-5'),
    );
    expect(notice.textContent).toContain(refused.noCapacity.body);
    expect(onStateMoved).not.toHaveBeenCalled();
    expect(screen.getByTestId('fix-hosted-door')).toBeTruthy();
    expect(modelReads()).toBe(2);
    expect(screen.queryByTestId('hosted-held-line')).toBeNull();
  });

  it('reads in zh', async () => {
    start = () => ({
      status: 409,
      body: { code: 'hosted_run_no_capacity', model: 'claude-opus-5-5', reason: 'x' },
    });
    await mountControl({}, true);
    await pressFix();
    await flush();
    expect(screen.getByTestId('fix-hosted-refused-noCapacity').textContent).toContain(
      zhMessages.runs.hosted.refused.noCapacity.title.replace('{model}', 'claude-opus-5-5'),
    );
  });
});
