// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ApprovalGateControl } from '@/components/approvals/ApprovalGateControl';
import { DesignApprovalGateCard } from '@/app/(authed)/settings/project/approvals/_components/DesignApprovalGateCard';
import { AutoRerunLine } from '@/components/approvals/AutoRerunLine';
import type { ApprovalGateDTO, DesignAutoRerunDTO } from '@/lib/dto/approvalGate';
import zhMessages from '@/messages/zh.json';

// STORY MOTIR-693's THREE SURFACES (MOTIR-702), each drawn state of MOTIR-694's
// published design asserted:
//
//   · the DESIGN APPROVAL switch (`approvals--design-gate.mock.html` panels 1–2) — on,
//     off, and a flip that PATCHes and reconciles. No read-only state: the room is
//     manage-only, so the design draws none.
//   · the SYSTEM-APPROVED record (`design-result--system-approved.mock.html` panels
//     1–2) — "Approved automatically", the setting as a link for a manager and as text
//     for everyone else, and NEVER the "No longer attributable" fallback (§6a).
//   · the AUTOMATIC RE-RUN line (`design-result--auto-rerun.mock.html` panels 1–3) —
//     started with its run link, every skipped reason with its next step, and no line
//     at all when the refusal attempted nothing.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DesignApprovalGateCard — the switch', () => {
  function renderCard(initialEnabled: boolean) {
    return renderWithIntl(
      <ToastProvider>
        <DesignApprovalGateCard projectKey="MOTIR" initialEnabled={initialEnabled} />
      </ToastProvider>,
    );
  }
  const gateSwitch = () =>
    screen.getByRole('switch', { name: 'Design approval' }) as HTMLButtonElement;

  it('on (the default): the state and its consequence', () => {
    renderCard(true);
    expect(gateSwitch().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('On')).toBeTruthy();
    expect(
      screen.getByText('Every published design waits for a person to approve it.'),
    ).toBeTruthy();
  });

  it('off: says the approvals still happen, on the record', () => {
    renderCard(false);
    expect(gateSwitch().getAttribute('aria-checked')).toBe('false');
    expect(
      screen.getByText(
        'Published designs are approved automatically, and each approval says this setting made it.',
      ),
    ).toBeTruthy();
  });

  it('a flip PATCHes `designApprovalGate` and reconciles from the response', async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({ acceptanceVideoEnabled: true, designApprovalGate: false }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    renderCard(true);

    fireEvent.click(gateSwitch());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/projects/MOTIR/approval-gates');
    expect(JSON.parse(init.body as string)).toEqual({ designApprovalGate: false });
    expect(await screen.findByText('Off')).toBeTruthy();
  });

  it('puts the switch BACK when the server refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    renderCard(true);

    fireEvent.click(gateSwitch());

    expect(await screen.findByText("Couldn't save — try again.")).toBeTruthy();
    expect(gateSwitch().getAttribute('aria-checked')).toBe('true');
  });
});

const DECIDED: ApprovalGateDTO = {
  id: 'gate-1',
  workItemId: 'wi-1',
  kind: 'design_result',
  subjectId: 'ev-1',
  state: 'approved',
  decidedById: null,
  decidedAt: '2026-09-29T21:42:00.000Z',
  noteMd: null,
  supersededCause: null,
  subjectVersion: 'c0389f2a11223344',
  decidedByLabel: null,
  routedToId: null,
  decidedUnderAuthority: 'project_setting',
  decisionSource: 'system',
  outcomeRef: 'done',
  confirmedRecord: null,
  refusalVerdict: null,
  offersRefusalVerdict: false,
  replanOwed: null,
  chosenOption: null,
  createdAt: '2026-09-29T21:42:00.000Z',
  updatedAt: '2026-09-29T21:42:00.000Z',
};

function renderFrame(gate: ApprovalGateDTO) {
  return renderWithIntl(
    <ApprovalGateControl
      gate={gate}
      canDecide={false}
      kindLabel="Design result"
      subjectMeta="version c0389f2a"
      port={<div>port</div>}
      verbs={[]}
      consequence={null}
      confirmConsequences={[]}
      onDecide={async () => null}
    />,
  );
}

describe('ApprovalGateControl — a gate the SYSTEM approved', () => {
  it('for a manager: "Approved automatically", and the setting links to the switch', () => {
    renderFrame({
      ...DECIDED,
      systemApprovalSettingsHref: '/settings/project/approvals#design-approval',
    });
    expect(screen.getByText('Approved automatically')).toBeTruthy();
    const why = screen.getByRole('link', { name: 'Design approval is off for this project' });
    expect(why.getAttribute('href')).toBe('/settings/project/approvals#design-approval');
    expect(screen.queryByText('No longer attributable')).toBeNull();
  });

  it('for everyone else: the same words, and no link', () => {
    renderFrame({ ...DECIDED, systemApprovalSettingsHref: null });
    expect(screen.getByText('Approved automatically')).toBeTruthy();
    expect(screen.getByText('Design approval is off for this project')).toBeTruthy();
    expect(
      screen.queryByRole('link', { name: 'Design approval is off for this project' }),
    ).toBeNull();
    expect(screen.queryByText('No longer attributable')).toBeNull();
  });
});

const REFUSED: ApprovalGateDTO = {
  ...DECIDED,
  state: 'changes_requested',
  decidedById: 'user-1',
  decidedByLabel: 'Ada Lovelace',
  decidedUnderAuthority: 'assignee',
  decisionSource: 'ui',
  outcomeRef: 'todo',
  noteMd: 'tighter spacing, the header is too loud',
  refusalVerdict: 'revise',
};

const rerun = (over: Partial<DesignAutoRerunDTO>): DesignAutoRerunDTO => ({
  outcome: 'skipped',
  skipReason: null,
  dispatchRunId: null,
  ordinal: 1,
  cap: 3,
  detail: null,
  ...over,
});

describe('ApprovalGateControl — the automatic re-run line', () => {
  it('started: re-running, which one of the cap, and the run link', () => {
    renderFrame({
      ...REFUSED,
      autoRerun: rerun({ outcome: 'started', dispatchRunId: 'run_7c1e', ordinal: 2 }),
    });
    expect(screen.getByText('Re-running on the hosted agent')).toBeTruthy();
    expect(screen.getByText(/automatic re-run 2 of 3/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'View run' });
    expect(link.getAttribute('href')).toContain('run=run_7c1e');
  });

  it.each([
    ['cap_reached', null, /sent back 3 times/, 'Run on the hosted agent'],
    ['dispatcher_gone', null, /no longer here/, 'Run on the hosted agent'],
    [
      'no_project_access',
      'Grace Hopper',
      /Grace Hopper, who last ran it/,
      'Run on the hosted agent',
    ],
    ['ci_credits_exhausted', null, /CI credits are used up/, 'Billing'],
    [
      'model_not_offered',
      'claude-opus-5-5',
      /claude-opus-5-5, the model it last ran on/,
      'Choose a model and run',
    ],
    ['models_unavailable', null, /list of models could not be read/, 'Run on the hosted agent'],
    ['out_of_credits', null, /out of credits/, 'Buy credits'],
    // MOTIR-9633: recorded with the model, never retried.
    [
      'no_capacity',
      'claude-opus-5-5',
      /claude-opus-5-5, the model it last ran on, has no agent-run capacity right now/,
      'Pick another model and run',
    ],
    ['credits_unavailable', null, /credit balance could not be read/, 'Run on the hosted agent'],
    [
      'repository_not_writable',
      'moooon-B-V/motir-core',
      /cannot write to moooon-B-V\/motir-core/,
      'Repositories',
    ],
  ] as const)('skipped · %s: says why and offers the next step', (reason, detail, why, next) => {
    renderFrame({ ...REFUSED, autoRerun: rerun({ skipReason: reason, detail }) });
    expect(screen.getByText('Automatic re-run skipped')).toBeTruthy();
    expect(screen.getByText(why)).toBeTruthy();
    expect(screen.getByRole('link', { name: next })).toBeTruthy();
  });

  it('skipped · no_capacity reads in zh, naming the model (MOTIR-9633)', () => {
    renderWithIntl(
      <AutoRerunLine rerun={rerun({ skipReason: 'no_capacity', detail: 'claude-opus-5-5' })} />,
      { locale: 'zh', messages: zhMessages },
    );
    expect(screen.getByTestId('auto-rerun-line').textContent).toContain(
      '它上次使用的模型 claude-opus-5-5 目前没有智能体运行容量。',
    );
    expect(
      screen.getByRole('link', { name: zhMessages.approvalGate.autoRerun.next.no_capacity }),
    ).toBeTruthy();
  });

  it('skipped · card_not_ready: says why and offers nothing', () => {
    renderFrame({ ...REFUSED, autoRerun: rerun({ skipReason: 'card_not_ready' }) });
    expect(screen.getByText(/someone picked the work item up first/)).toBeTruthy();
    expect(screen.getByTestId('auto-rerun-line').querySelector('a')).toBeNull();
  });

  it('no record — not hosted, a Re-plan, a GitHub refusal — draws no line', () => {
    renderFrame({ ...REFUSED, autoRerun: null });
    expect(screen.queryByTestId('auto-rerun-line')).toBeNull();
  });
});
