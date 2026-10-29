// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import { relativeLabel } from '@/components/github/RepairFixPart';
import type { WorkItemRepairViewDto } from '@/lib/dto/workItemRepair';
import { CORE_PR, GATEWAY_PR } from '../helpers/howToTestFixtures';
import messages from '@/messages/en.json';

// THE FIX PART of the Development block (Story MOTIR-5460 · MOTIR-5466, design
// `design/github` § 21 · Panels F1–F4). The state is decided server-side by the
// repair claim's own evaluation (asserted in `tests/ready/claimWorkItemRepair.test.ts`);
// what is asserted here is what each state DRAWS.

// ⚠️ THE CODE BLOCK IS THE SHARED ONE — asserted by IMPORT. The module is wrapped so
// every render through it is recorded; a hand-drawn block would record nothing.
const codeBlocks = vi.hoisted(() => [] as { language: string | null; code: string }[]);
vi.mock('@/components/markdown/CopyableCodeBlock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/markdown/CopyableCodeBlock')>();
  return {
    CopyableCodeBlock: (props: Parameters<typeof actual.CopyableCodeBlock>[0]) => {
      codeBlocks.push({ language: props.language, code: props.code });
      return actual.CopyableCodeBlock(props);
    },
  };
});

afterEach(() => {
  cleanup();
  codeBlocks.length = 0;
  vi.restoreAllMocks();
});

const fix = messages.github.development.fix;
const copyAria = messages.github.development.howToTest.code.copyAria;
const NOW = Date.parse('2026-09-16T14:06:00Z');
const CORE = {
  repo: CORE_PR.repo,
  number: CORE_PR.number,
  ci: 'failing' as const,
  queueExit: null,
  conflict: null,
  outOfDate: null,
};
const GATEWAY = {
  repo: GATEWAY_PR.repo,
  number: GATEWAY_PR.number,
  ci: 'failing' as const,
  queueExit: null,
  conflict: null,
  outOfDate: null,
};

function renderPart(repair: WorkItemRepairViewDto | null) {
  return render(
    <DevelopmentSectionBody
      pullRequests={[
        { ...CORE_PR, ci: 'failing' },
        { ...GATEWAY_PR, ci: 'failing' },
      ]}
      itemIdentifier="ACME-12"
      repair={repair}
    />,
  );
}

const part = () => screen.getByRole('group', { name: fix.aria.part });

describe('F1 — red, nobody fixing it', () => {
  it('names each failing pull request and offers `motir fix <KEY>` in the shared code block', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderPart({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [CORE, GATEWAY],
      lastGaveUp: null,
    });

    const p = part();
    expect(p.textContent).toContain(
      `Checks are failing on ${CORE.repo} · #${CORE.number} and ${GATEWAY.repo} · #${GATEWAY.number}.`,
    );
    expect(within(p).getAllByText(/ · #/, { selector: 'b' })).toHaveLength(2);
    expect(within(p).getByText(fix.howMany)).toBeTruthy();
    expect(codeBlocks).toEqual([{ language: 'shell', code: 'motir fix ACME-12' }]);

    fireEvent.click(within(p).getByRole('button', { name: copyAria }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('motir fix ACME-12'));
    expect(within(p).queryByText(fix.gaveUp.pill)).toBeNull();
  });

  it('one failing pull request reads in the singular', () => {
    renderPart({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [CORE],
      lastGaveUp: null,
    });
    expect(within(part()).getByText(fix.how)).toBeTruthy();
  });
});

describe('F2 — a fix in progress', () => {
  it('names the holder and the start, and shows NO command and no copy control', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    renderPart({
      state: 'in_progress',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [CORE],
      holder: { id: 'u-mara', name: 'Mara S.' },
      byViewer: false,
      startedAt: '2026-09-16T14:02:00Z',
    });

    const p = part();
    expect(p.textContent).toContain('Being fixed by Mara S. · started 4 min. ago');
    expect(within(p).getByText(fix.fixing.pill)).toBeTruthy();
    const time = p.querySelector('time')!;
    expect(time.getAttribute('datetime')).toBe('2026-09-16T14:02:00Z');
    expect(time.getAttribute('title')).toBeTruthy();
    expect(within(p).queryByRole('button', { name: copyAria })).toBeNull();
    expect(codeBlocks).toEqual([]);
    expect(p.textContent).not.toContain('motir fix');
  });

  it('says "you" to the holder, and "someone" when the holder account is gone', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const base = {
      state: 'in_progress' as const,
      repairClass: 'ci' as const,
      acceptanceRefusal: null,
      failing: [CORE],
      startedAt: '2026-09-16T11:06:00Z',
    };
    renderPart({ ...base, holder: { id: 'u-me', name: 'Me' }, byViewer: true });
    expect(part().textContent).toContain('Being fixed by you · started 3 hr. ago');
    cleanup();
    renderPart({ ...base, holder: null, byViewer: false });
    expect(part().textContent).toContain('Being fixed by someone');
  });
});

describe('F3 — the last fix gave up', () => {
  it('says so with the attempt count FROM DATA, and offers the command again', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    renderPart({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [CORE],
      lastGaveUp: { attempts: 3, endedAt: '2026-09-16T13:46:00Z' },
    });

    const p = part();
    const callout = within(p).getByRole('status');
    // 3, not the CLI's 5 — the count is the run's own report.
    expect(callout.textContent).toContain('The last fix gave up after 3 attempts · 20 min. ago.');
    expect(callout.textContent).toContain(fix.gaveUp.body);
    expect(within(p).getByText(fix.gaveUp.pill)).toBeTruthy();
    expect(codeBlocks).toEqual([{ language: 'shell', code: 'motir fix ACME-12' }]);
  });

  it('a give-up that reported no count still says it gave up', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    renderPart({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [CORE],
      lastGaveUp: { attempts: null, endedAt: '2026-09-14T14:06:00Z' },
    });
    expect(within(part()).getByRole('status').textContent).toContain(
      'The last fix gave up · 2 days ago.',
    );
  });
});

describe('F4 — a child of a container run', () => {
  it('points at the run target by key, with no command', () => {
    renderPart({ state: 'pointer', failing: [CORE], runTargetKey: 'ACME-10' });

    const p = part();
    expect(p.textContent).toContain('Run the fix from ACME-10');
    expect(within(p).getByRole('link', { name: 'ACME-10' }).getAttribute('href')).toBe(
      '/items/ACME-10',
    );
    expect(codeBlocks).toEqual([]);
    expect(p.textContent).not.toContain('motir fix');
  });
});

describe('state 5 — not shown', () => {
  // The server answers `hidden` for running / passing / no CI / not implemented
  // (each asserted on the evaluation); the peek passes nothing at all.
  it.each([
    ['hidden', { state: 'hidden' } as const],
    ['omitted', null],
  ])('%s renders the block with no fix part', (_label, repair) => {
    const { container } = renderPart(repair);
    expect(screen.queryByRole('group', { name: fix.aria.part })).toBeNull();
    expect(container.textContent).toContain(CORE_PR.title);
    expect(codeBlocks).toEqual([]);
  });
});

describe('relativeLabel', () => {
  it('reads minutes, then hours, then days, and never the future', () => {
    const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
    expect(relativeLabel(at(0), 'en', NOW)).toBe('this minute');
    expect(relativeLabel(at(59), 'en', NOW)).toBe('59 min. ago');
    expect(relativeLabel(at(120), 'en', NOW)).toBe('2 hr. ago');
    expect(relativeLabel(at(60 * 72), 'en', NOW)).toBe('3 days ago');
    expect(relativeLabel(new Date(NOW + 600_000).toISOString(), 'en', NOW)).toBe('this minute');
    expect(relativeLabel(at(4), 'zh', NOW)).toBe('4分钟前');
  });
});

// ── An EJECTED member (Story MOTIR-5628 · MOTIR-5721; design § 26) ───────────────
describe('a member the merge queue threw out (MOTIR-5721)', () => {
  const EJECTED = {
    repo: GATEWAY_PR.repo,
    number: GATEWAY_PR.number,
    ci: 'passing' as const,
    queueExit: {
      rawReason: 'CI_FAILURE',
      disposition: 'failure' as const,
      failingCheckName: 'CI complete',
    },
    conflict: null,
    outOfDate: null,
  };
  const TAGS = ['<b>', '</b>', '<code>', '</code>'] as const;
  const plain = (text: string) => TAGS.reduce((out, tag) => out.split(tag).join(''), text);

  it('with NO exit the part is exactly the shipped F1 — no left-the-queue line, no sentence', () => {
    renderPart({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [CORE],
      lastGaveUp: null,
    });
    const p = part();
    expect(p.textContent).toContain('Checks are failing on');
    expect(p.textContent).not.toContain('left the merge queue');
    expect(within(p).queryByTestId('repair-which')).toBeNull();
  });

  it('an own-failing and an ejected member draw BOTH lines, own-failing first', () => {
    renderPart({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [CORE, EJECTED],
      lastGaveUp: null,
    });
    const text = part().textContent!;
    const own = text.indexOf(`Checks are failing on ${CORE.repo} · #${CORE.number}.`);
    const left = text.indexOf(`${EJECTED.repo} · #${EJECTED.number} left the merge queue.`);
    expect(own).toBeGreaterThanOrEqual(0);
    expect(left).toBeGreaterThan(own);
    // A queue FAILURE is CAN'T-LAND (MOTIR-6596, design § 31): the FAILED sentence.
    expect(within(part()).getByTestId('repair-which').textContent).toBe(plain(fix.which.failed));
  });

  it('a member red on its OWN checks that also carries an exit stays on the failing line, and adds no sentence', () => {
    renderPart({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [{ ...EJECTED, ci: 'failing' }],
      lastGaveUp: null,
    });
    expect(part().textContent).toContain('Checks are failing on');
    expect(within(part()).queryByTestId('repair-which')).toBeNull();
  });

  it('a failure that is neither a check nor a conflict reads the same FAILED sentence, then the re-arm line', () => {
    renderPart({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [
        {
          ...EJECTED,
          queueExit: {
            rawReason: 'INVALID_MERGE_COMMIT',
            disposition: 'failure' as const,
            failingCheckName: null,
          },
        },
      ],
      lastGaveUp: null,
    });
    expect(within(part()).getByTestId('repair-which').textContent).toBe(plain(fix.which.failed));
    // § 31 panel 1: nothing is asked until a push goes green, and the part says so.
    expect(part().textContent).toContain(fix.rearm);
  });

  it('with several ejected members a CONFLICT wins', () => {
    renderPart({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [
        { ...EJECTED, repo: CORE.repo, number: CORE.number },
        {
          ...EJECTED,
          queueExit: {
            rawReason: 'MERGE_CONFLICT',
            disposition: 'failure' as const,
            failingCheckName: null,
          },
        },
      ],
      lastGaveUp: null,
    });
    expect(within(part()).getByTestId('repair-which').textContent).toBe(plain(fix.which.conflict));
  });

  it('the pointer state names no command and no sentence', () => {
    renderPart({ state: 'pointer', failing: [EJECTED], runTargetKey: 'ACME-3' });
    expect(within(part()).queryByTestId('repair-which')).toBeNull();
  });
});

// A CONFLICTED member (MOTIR-5916; design/github § 30's fix part): green checks, no queue
// exit, and the host reports it conflicts with its base. It is named on the CONFLICT line —
// never on *Checks are failing*, which would be false — and the notes say the agent rebases
// or resolves and that nothing is asked until a push.
describe('a member failing only because it CONFLICTS (MOTIR-5916)', () => {
  const CONFLICTED = {
    repo: GATEWAY_PR.repo,
    number: GATEWAY_PR.number,
    ci: 'passing' as const,
    queueExit: null,
    conflict: { baseRef: 'main' },
    outOfDate: null,
  };

  it('names it on the conflict line with its base, and says how an agent resolves it', () => {
    renderPart({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [CONFLICTED],
      lastGaveUp: null,
    });
    const part = screen.getByTestId('repair-fix-part');
    expect(part.textContent).not.toContain('Checks are failing on');
    expect(screen.getByTestId('repair-conflict-line').textContent).toBe(
      fix.conflictOn
        .replace('<prs></prs>', `${GATEWAY_PR.repo} · #${GATEWAY_PR.number}`)
        .replace('{base}', 'main'),
    );
    expect(part.textContent).toContain(fix.howConflict);
    expect(part.textContent).toContain(fix.rearm);
  });

  it('a row with no recorded base reads *its base branch*', () => {
    renderPart({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [{ ...CONFLICTED, conflict: { baseRef: null } }],
      lastGaveUp: null,
    });
    expect(screen.getByTestId('repair-conflict-line').textContent).toBe(
      fix.conflictOnNoBase.replace('<prs></prs>', `${GATEWAY_PR.repo} · #${GATEWAY_PR.number}`),
    );
  });

  it('a member red on its OWN checks AND conflicted is on both lines', () => {
    renderPart({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [{ ...CONFLICTED, ci: 'failing' as const }],
      lastGaveUp: null,
    });
    const part = screen.getByTestId('repair-fix-part');
    expect(part.textContent).toContain('Checks are failing on');
    expect(screen.getByTestId('repair-conflict-line')).toBeTruthy();
  });
});

// A member OUT OF DATE with a base that requires it (Bug MOTIR-10054): green checks, no
// exit, no conflict. It is named on its own line — never *Checks are failing*, and never
// the conflict line, which would be false too.
describe('a member failing only because it is OUT OF DATE (MOTIR-10054)', () => {
  const BEHIND = {
    repo: GATEWAY_PR.repo,
    number: GATEWAY_PR.number,
    ci: 'passing' as const,
    queueExit: null,
    conflict: null,
    outOfDate: { baseRef: 'main' },
  };
  const offer = (failing: (typeof BEHIND)[]) =>
    renderPart({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing,
      lastGaveUp: null,
    });

  it('names it on the out-of-date line with its base', () => {
    offer([BEHIND]);
    const part = screen.getByTestId('repair-fix-part');
    expect(part.textContent).not.toContain('Checks are failing on');
    expect(screen.queryByTestId('repair-conflict-line')).toBeNull();
    expect(screen.getByTestId('repair-out-of-date-line').textContent).toBe(
      fix.outOfDateOn
        .replace('<prs></prs>', `${GATEWAY_PR.repo} · #${GATEWAY_PR.number}`)
        .replace('{base}', 'main'),
    );
  });

  it('a row with no recorded base reads *its base branch*', () => {
    offer([{ ...BEHIND, outOfDate: { baseRef: null } as unknown as { baseRef: string } }]);
    expect(screen.getByTestId('repair-out-of-date-line').textContent).toBe(
      fix.outOfDateOnNoBase.replace('<prs></prs>', `${GATEWAY_PR.repo} · #${GATEWAY_PR.number}`),
    );
  });

  it('a member red on its OWN checks as well is named on the checks line alone', () => {
    offer([{ ...BEHIND, ci: 'failing' as unknown as 'passing' }]);
    expect(screen.getByTestId('repair-fix-part').textContent).toContain('Checks are failing on');
    expect(screen.queryByTestId('repair-out-of-date-line')).toBeNull();
  });
});

describe('an ACCEPTANCE SENT BACK TO RE-RUN (Story MOTIR-6071 · MOTIR-6502 / MOTIR-6506)', () => {
  const REFUSAL = {
    reasonMd: 'The empty board should say how to add the first card.\nAnd the toolbar wraps.',
    decidedByLabel: 'Yue Zhu',
    decidedAt: '2026-09-26T10:00:00.000Z',
  };
  const GREEN = { ...CORE, ci: 'passing' as const };
  const GREEN_GATEWAY = { ...GATEWAY, ci: 'passing' as const };
  const sentBackPart = () => screen.getByRole('group', { name: fix.aria.partSentBack });

  it('titles the part as sent back, names the review — never failing checks — and offers `motir fix`', () => {
    renderPart({
      state: 'offer',
      repairClass: 'acceptance_rerun',
      acceptanceRefusal: REFUSAL,
      failing: [GREEN],
      lastGaveUp: null,
    });

    const p = sentBackPart();
    expect(p.getAttribute('data-repair-kind')).toBe('sent_back');
    expect(within(p).getByRole('heading', { name: fix.titleSentBack })).toBeTruthy();
    const line = within(p).getByTestId('repair-sent-back-line');
    expect(line.textContent).toBe(
      'The acceptance video was sent back to re-run. An agent fixes it on the same pull request, from the reason given, then records a new video.',
    );
    // The shipped `pointer` recipe: secondary ink, the undo glyph in muted icon ink.
    expect(line.className).toContain('text-(--el-text-secondary)');
    expect(line.className).toContain('text-[13px]');
    expect(line.querySelector('svg')!.getAttribute('class')).toContain('text-(--el-icon-muted)');
    expect(p.textContent).not.toContain('Checks are failing');
    // The command, the lead and `how` are the shipped ones.
    expect(within(p).getByText(fix.lead)).toBeTruthy();
    expect(within(p).getByText(fix.how)).toBeTruthy();
    expect(codeBlocks).toEqual([{ language: 'shell', code: 'motir fix ACME-12' }]);
  });

  it('counts the story’s open pull requests, and says `howMany` for several', () => {
    renderPart({
      state: 'offer',
      repairClass: 'acceptance_rerun',
      acceptanceRefusal: REFUSAL,
      failing: [GREEN, GREEN_GATEWAY],
      lastGaveUp: null,
    });
    expect(screen.getByTestId('repair-sent-back-line').textContent).toContain(
      'on the same pull requests,',
    );
    expect(within(sentBackPart()).getByText(fix.howMany)).toBeTruthy();
  });

  it('a member that is ALSO red keeps the shipped failing line after the sent-back line', () => {
    renderPart({
      state: 'offer',
      repairClass: 'acceptance_rerun',
      acceptanceRefusal: REFUSAL,
      failing: [GREEN, GATEWAY],
      lastGaveUp: null,
    });
    const p = sentBackPart();
    expect(within(p).getByRole('heading', { name: fix.titleSentBack })).toBeTruthy();
    const text = p.textContent ?? '';
    expect(text.indexOf('sent back to re-run')).toBeLessThan(text.indexOf('Checks are failing'));
    expect(text).toContain(`Checks are failing on ${GATEWAY.repo} · #${GATEWAY.number}.`);
    expect(text).not.toContain(`${CORE.repo} · #${CORE.number}`);
  });

  it('while it is being fixed, still names the review and shows no command', () => {
    renderPart({
      state: 'in_progress',
      repairClass: 'acceptance_rerun',
      acceptanceRefusal: REFUSAL,
      failing: [GREEN],
      holder: { id: 'u1', name: 'Yue Zhu' },
      byViewer: true,
      startedAt: '2026-09-26T12:00:00.000Z',
    });
    const p = sentBackPart();
    expect(within(p).getByTestId('repair-sent-back-line')).toBeTruthy();
    expect(codeBlocks).toEqual([]);
  });

  it('a CI repair keeps its shipped title and draws no sent-back line', () => {
    renderPart({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [CORE],
      lastGaveUp: null,
    });
    expect(part().getAttribute('data-repair-kind')).toBe('failing');
    expect(screen.queryByTestId('repair-sent-back-line')).toBeNull();
  });
});

describe('Fix in my agent — the door node beside the command (MOTIR-9053)', () => {
  const DOOR = <span data-testid="my-agent-door">door</span>;
  const renderWithDoor = (repair: WorkItemRepairViewDto) =>
    render(
      <DevelopmentSectionBody
        pullRequests={[{ ...CORE_PR, ci: 'failing' }]}
        itemIdentifier="ACME-12"
        repair={repair}
        repairMyAgentDoor={DOOR}
      />,
    );

  it('draws the door beside the copyable command for a red-checks offer', () => {
    renderWithDoor({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [CORE],
      lastGaveUp: null,
    });
    expect(within(part()).getByTestId('my-agent-door')).toBeTruthy();
    expect(codeBlocks).toEqual([{ language: 'shell', code: 'motir fix ACME-12' }]);
  });

  it.each([
    [
      'in progress',
      {
        state: 'in_progress',
        repairClass: 'ci',
        acceptanceRefusal: null,
        failing: [CORE],
        holder: null,
        byViewer: false,
        startedAt: '2026-09-16T14:00:00Z',
      },
    ],
    [
      'an acceptance re-run',
      {
        state: 'offer',
        repairClass: 'acceptance_rerun',
        acceptanceRefusal: null,
        failing: [CORE],
        lastGaveUp: null,
      },
    ],
    [
      'a review sent back',
      {
        state: 'offer',
        repairClass: 'review',
        acceptanceRefusal: null,
        failing: [CORE],
        lastGaveUp: null,
      },
    ],
    ['hidden', { state: 'hidden' }],
  ])('draws no door for %s', (_name, repair) => {
    renderWithDoor(repair as WorkItemRepairViewDto);
    expect(screen.queryByTestId('my-agent-door')).toBeNull();
  });
});
