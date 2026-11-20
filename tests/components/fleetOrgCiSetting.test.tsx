// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { FleetOrgCiStateDTO, FleetOrgCiTargetDTO } from '@/lib/dto/fleetOrgCiSetting';
import type {
  FleetReadinessCondition,
  FleetReadinessKey,
} from '@/lib/services/fleetReadinessService';

/**
 * The fleet org CI island (MOTIR-8715, design `platform-admin` § AMENDMENT
 * 2026-10 Fleet settings, Panels 1–11). The action is stubbed: its codes have
 * their own suite (`fleetOrgCiAction.test.ts`); here each answer is driven to
 * the state the design draws for it.
 */

const setFleetOrgCiAction = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, outcome: 'changed' })),
);
vi.mock('@/app/(admin)/admin/fleet-settings/actions', () => ({ setFleetOrgCiAction }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const { FleetOrgCiSetting } =
  await import('@/app/(admin)/admin/fleet-settings/_components/FleetOrgCiSetting');

afterEach(() => {
  cleanup();
  setFleetOrgCiAction.mockClear();
  refresh.mockClear();
});

const NOW = new Date('2026-10-15T12:00:00.000Z');
const ORDER: FleetReadinessKey[] = [
  'kill_switch',
  'app_installed',
  'app_runner_permission',
  'app_variables_permission',
  'workflow_job_subscription',
  'app_repositories',
  'delivery_attributable',
  'runner_group',
  'image_coverage',
];
const REPOS = ['acme-ci/api', 'acme-ci/gateway', 'acme-ci/meta'];

const target: FleetOrgCiTargetDTO = {
  projectId: 'proj_1',
  projectKey: 'ACME',
  workspaceId: 'ws_1',
  organizationId: 'org_1',
  org: 'acme-ci',
  installationId: '42',
};

const constants = {
  variableName: 'MOTIR_RUNNER',
  runnerLabel: 'motir-runner',
  fleetName: 'motir-fleet',
  killSwitchVariable: 'MOTIR_FLEET_MAX_IN_FLIGHT',
  arm64VariableName: 'MOTIR_RUNNER_ARM64',
  arm64RunnerLabel: 'motir-graviton',
};

function met(key: FleetReadinessKey): FleetReadinessCondition {
  const params: Record<string, unknown> =
    key === 'app_repositories' || key === 'image_coverage' ? { repositories: REPOS } : {};
  const reasonCode =
    key === 'app_repositories'
      ? 'all_reachable'
      : key === 'image_coverage'
        ? 'all_runnable'
        : 'granted';
  return { key, state: 'met', reasonCode, params, message: `${key} met` };
}

function job(i: number) {
  return {
    repoRef: 'acme-ci/gateway',
    workflow: `.github/workflows/w${i}.yml`,
    jobId: `job${i}`,
    verdict: 'needs-image',
    missing: ['binfmt'],
    reason: null,
  };
}

function state(
  over: Partial<FleetOrgCiStateDTO> = {},
  conditions: Partial<Record<FleetReadinessKey, FleetReadinessCondition>> = {},
): FleetOrgCiStateDTO {
  const list = ORDER.map((k) => conditions[k] ?? met(k));
  return {
    enabled: false,
    updatedBy: { userId: 'u1', email: 'ops@example.test' },
    updatedAt: '2026-10-13T12:00:00.000Z',
    lastReason: 'Back to hosted',
    variable: { state: 'absent' },
    arm64: { ready: false, reason: 'arm64_runner_ami_not_pinned', variable: { state: 'absent' } },
    codeScanning: [],
    readiness: {
      ready: list.every((c) => c.state === 'met'),
      org: 'acme-ci',
      checkedAt: '2026-10-15T11:59:00.000Z',
      conditions: list,
    },
    ...over,
  };
}

const runnerGroupUnmet: FleetReadinessCondition = {
  key: 'runner_group',
  state: 'unmet',
  reasonCode: 'sync_pending',
  params: { org: 'acme-ci', script: 'scripts/ci-fleet/sync.ts', projectKey: 'ACME' },
  message: 'English for logs',
};

function render(s: FleetOrgCiStateDTO) {
  return renderWithIntl(<FleetOrgCiSetting target={target} state={s} constants={constants} />, {
    now: NOW,
  });
}

// `hidden`: an open dialog marks the page behind it aria-hidden.
const theSwitch = () => screen.getByRole('switch', { hidden: true });

async function openConfirm() {
  fireEvent.click(theSwitch());
  return screen.findByRole('alertdialog');
}

async function flipWith(reason: string) {
  const dialog = await openConfirm();
  fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: reason } });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: /^Turn (on|off)$/ }));
  });
}

describe('FleetOrgCiSetting', () => {
  it('renders the nine conditions in the service order, each with its word', () => {
    render(state());
    const rows = screen.getAllByTestId(/^fleet-condition-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(
      ORDER.map((k) => `fleet-condition-${k}`),
    );
    for (const row of rows) expect(row.textContent).toContain('Met');
    expect(screen.getByTestId('fleet-readiness-verdict').textContent).toContain('Ready');
    expect(screen.getByTestId('fleet-readiness-verdict').textContent).toContain(
      'All 9 conditions met',
    );
  });

  it('draws unknown as NOT met, with its own word and sentence', () => {
    render(
      state(
        {},
        {
          app_installed: {
            key: 'app_installed',
            state: 'unknown',
            reasonCode: 'read_failed',
            params: { status: 502 },
            message: 'x',
          },
        },
      ),
    );
    const row = screen.getByTestId('fleet-condition-app_installed');
    expect(row.getAttribute('data-state')).toBe('unknown');
    expect(row.textContent).toContain('Couldn’t check'.replace('’', "'"));
    expect(row.textContent).not.toMatch(/\bMet\b/);
    expect(row.textContent).toContain('GitHub answered HTTP 502');
    const verdict = screen.getByTestId('fleet-readiness-verdict').textContent;
    expect(verdict).toContain('Not ready — 1 condition not met');
    expect(verdict).toContain("1 couldn't be checked");
  });

  it('renders a reason code from the catalogue, and an unknown code from its message', () => {
    render(
      state(
        {},
        {
          runner_group: runnerGroupUnmet,
          kill_switch: {
            key: 'kill_switch',
            state: 'unmet',
            reasonCode: 'something_new',
            params: {},
            message: 'A brand-new English reason.',
          },
        },
      ),
    );
    expect(screen.getByTestId('fleet-condition-runner_group').textContent).toContain(
      'An operator runs scripts/ci-fleet/sync.ts --project ACME.',
    );
    expect(screen.getByTestId('fleet-condition-runner_group').textContent).not.toContain(
      'English for logs',
    );
    expect(screen.getByTestId('fleet-condition-kill_switch').textContent).toContain(
      'A brand-new English reason.',
    );
  });

  it('disables ON while not ready, and says why beside the switch', () => {
    render(state({}, { runner_group: runnerGroupUnmet }));
    expect(theSwitch().hasAttribute('disabled')).toBe(true);
    expect(theSwitch().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('fleet-org-ci-blocked').textContent).toBe(
      "Can't turn on until every condition is met.",
    );
  });

  it('keeps OFF enabled when stored ON and not ready, with the degraded band', () => {
    render(
      state(
        {
          enabled: true,
          variable: { state: 'present', value: 'motir-runner', visibility: 'private' },
        },
        { runner_group: runnerGroupUnmet },
      ),
    );
    expect(theSwitch().hasAttribute('disabled')).toBe(false);
    expect(theSwitch().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('fleet-org-ci-degraded').textContent).toContain(
      'New jobs will queue until this is fixed or the setting is turned off.',
    );
    expect(screen.queryByTestId('fleet-org-ci-blocked')).toBeNull();
    expect(screen.getByText('Turning off never waits on readiness.')).toBeTruthy();
  });

  it('shows a drift note when the variable disagrees with the stored state', () => {
    render(state({ enabled: true, variable: { state: 'absent' } }));
    expect(screen.getByTestId('fleet-org-ci-drift').textContent).toContain(
      'Stored on, but GitHub disagrees.',
    );
  });

  it('renders the last-changed line with its audit-log link, the variable and the repositories', () => {
    render(state());
    const line = screen.getByTestId('fleet-org-ci-last-changed');
    expect(line.textContent).toContain('ops@example.test');
    expect(line.textContent).toContain('“Back to hosted”');
    expect(within(line).getByRole('link', { name: 'Audit log' }).getAttribute('href')).toBe(
      '/admin/audit-log?action=fleet.org_ci.disable',
    );
    expect(screen.getByTestId('fleet-org-ci-variable').textContent).toBe(
      'MOTIR_RUNNER is not set on acme-ci — jobs fall back to GitHub-hosted runners.',
    );
    expect(screen.getByText('api · gateway · meta')).toBeTruthy();
  });

  it('refuses a blank reason inline, with no action call', async () => {
    render(state());
    const dialog = await openConfirm();
    expect(dialog.textContent).toContain('Turn on fleet CI for acme-ci?');
    expect(dialog.textContent).toContain('Off → On');
    const confirm = within(dialog).getByRole('button', { name: 'Turn on' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(dialog.textContent).toContain('The button stays disabled until a reason is typed');
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: '   ' } });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirm);
    expect(setFleetOrgCiAction).not.toHaveBeenCalled();
  });

  it('names the OFF direction and its consequence in the OFF confirm', async () => {
    render(
      state({
        enabled: true,
        variable: { state: 'present', value: 'motir-runner', visibility: 'private' },
      }),
    );
    const dialog = await openConfirm();
    expect(dialog.textContent).toContain('Turn off fleet CI for acme-ci?');
    expect(dialog.textContent).toContain('On → Off. New jobs go back to GitHub-hosted runners');
  });

  it('calls the action with the pair, the direction and the trimmed reason', async () => {
    render(state());
    await flipWith('  Moving CI  ');
    expect(setFleetOrgCiAction).toHaveBeenCalledWith('proj_1', 'acme-ci', true, 'Moving CI');
    expect(screen.getByTestId('fleet-org-ci-answer').textContent).toContain('Turned on.');
  });

  it('lists the first five uncovered jobs, then +N more expanding to the rest', () => {
    const jobs = Array.from({ length: 7 }, (_, i) => job(i + 1));
    render(
      state(
        {},
        {
          image_coverage: {
            key: 'image_coverage',
            state: 'unmet',
            reasonCode: 'jobs_not_runnable',
            params: { jobs },
            message: 'x',
          },
        },
      ),
    );
    const list = screen.getByTestId('fleet-uncovered-jobs');
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(list.textContent).toContain('gateway · w1.yml · job1 — missing binfmt');
    expect(screen.getByTestId('fleet-condition-image_coverage').textContent).toContain(
      "7 jobs can't run on the fleet runner image yet.",
    );
    fireEvent.click(screen.getByRole('button', { name: '+2 more' }));
    expect(
      within(screen.getByTestId('fleet-uncovered-jobs')).getAllByRole('listitem'),
    ).toHaveLength(7);
    expect(screen.queryByRole('button', { name: /more$/ })).toBeNull();
  });

  it('names a job that cannot be judged, and one that cannot be hosted, by their reasons (MOTIR-10290)', () => {
    render(
      state(
        {},
        {
          image_coverage: {
            key: 'image_coverage',
            state: 'unmet',
            reasonCode: 'jobs_not_runnable',
            params: {
              jobs: [
                {
                  ...job(1),
                  verdict: 'unverified',
                  missing: ['unverified'],
                  reason: 'the computed command $CLI',
                },
                { ...job(2), verdict: 'cannot-host', missing: [], reason: 'it asks for macos-14' },
              ],
            },
            message: 'x',
          },
        },
      ),
    );
    const list = screen.getByTestId('fleet-uncovered-jobs');
    expect(list.textContent).toContain(
      "gateway · w1.yml · job1 — can't be judged: the computed command $CLI",
    );
    expect(list.textContent).toContain(
      "gateway · w2.yml · job2 — can't be hosted: it asks for macos-14",
    );
    expect(screen.getByTestId('fleet-condition-image_coverage').textContent).toContain(
      'Judged from each repository',
    );
  });

  it('unchanged is information, not an error', async () => {
    setFleetOrgCiAction.mockResolvedValueOnce({ ok: true, outcome: 'unchanged', enabled: true });
    render(state());
    await flipWith('x');
    const band = screen.getByTestId('fleet-org-ci-answer');
    expect(band.getAttribute('role')).toBe('status');
    expect(band.getAttribute('data-tone')).toBe('info');
    expect(band.textContent).toContain('Already on — nothing changed.');
  });

  it('REASON_REQUIRED from the server shows inline in the dialog, which stays open', async () => {
    setFleetOrgCiAction.mockResolvedValueOnce({ ok: false, code: 'REASON_REQUIRED' });
    render(state());
    await flipWith('x');
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Not turned on: a reason is required');
    expect(theSwitch().getAttribute('aria-checked')).toBe('false');
  });

  it.each([
    [
      { ok: false, code: 'GITHUB_WRITE_FAILED', org: 'acme-ci', status: 403, operation: 'set' },
      'Not turned on: GitHub refused to set MOTIR_RUNNER on acme-ci (HTTP 403).',
    ],
    [
      { ok: false, code: 'GITHUB_WRITE_FAILED', org: 'acme-ci', status: null, operation: 'read' },
      'Not turned on: GitHub could not be reached to read MOTIR_RUNNER on acme-ci.',
    ],
    [
      {
        ok: false,
        code: 'NOT_READY',
        conditions: [
          { key: 'app_variables_permission', state: 'unmet', reasonCode: 'permission_missing' },
        ],
      },
      'Not met now: App permission: Variables (write).',
    ],
    [
      {
        ok: false,
        code: 'CODE_SCANNING_FAILED',
        org: 'acme-ci',
        repo: 'gateway',
        status: 403,
        operation: 'write',
        to: 'fleet',
      },
      'Not turned on: GitHub refused to move the CodeQL default setup of acme-ci/gateway to the fleet (HTTP 403).',
    ],
    [
      {
        ok: false,
        code: 'CODE_SCANNING_FAILED',
        org: 'acme-ci',
        repo: 'gateway',
        status: null,
        operation: 'write',
        to: 'github_hosted',
      },
      'Not turned on: GitHub could not be reached to move the CodeQL default setup of acme-ci/gateway to GitHub-hosted runners.',
    ],
    [
      {
        ok: false,
        code: 'CODE_SCANNING_FAILED',
        org: 'acme-ci',
        repo: 'api',
        status: 502,
        operation: 'read',
        to: 'fleet',
      },
      'Not turned on: GitHub refused to read the CodeQL default setup of acme-ci/api (HTTP 502).',
    ],
    [
      {
        ok: false,
        code: 'CODE_SCANNING_FAILED',
        org: 'acme-ci',
        repo: 'api',
        status: null,
        operation: 'read',
        to: 'fleet',
      },
      'Not turned on: GitHub could not be reached to read the CodeQL default setup of acme-ci/api.',
    ],
    [{ ok: false, code: 'NOT_PERMITTED' }, 'only a superadmin can change this setting'],
    [{ ok: false, code: 'TARGET_UNKNOWN' }, 'no longer offered this setting'],
    [{ ok: false, code: 'FAILED' }, 'Not turned on: something went wrong.'],
  ])(
    'a failed answer %# leaves the switch at its previous state and says so',
    async (result, words) => {
      setFleetOrgCiAction.mockResolvedValueOnce(result);
      render(state());
      await flipWith('x');
      expect(theSwitch().getAttribute('aria-checked')).toBe('false');
      expect(screen.queryByRole('alertdialog')).toBeNull();
      const band = screen.getByTestId('fleet-org-ci-answer');
      expect(band.getAttribute('role')).toBe('alert');
      expect(band.textContent).toContain(words);
      if ((result as { code: string }).code === 'CODE_SCANNING_FAILED') {
        expect(band.textContent).toContain(
          "Nothing changed: the setting, the GitHub variable and every repository's CodeQL default setup are as they were.",
        );
      }
      if ((result as { code: string }).code === 'GITHUB_WRITE_FAILED') {
        expect(band.textContent).toContain(
          'Nothing changed: the setting and the GitHub variable are as they were.',
        );
      }
    },
  );

  it('after NOT_READY the readiness card says it was checked again', async () => {
    setFleetOrgCiAction.mockResolvedValueOnce({ ok: false, code: 'NOT_READY', conditions: [] });
    render(state());
    await flipWith('x');
    expect(screen.getByTestId('fleet-readiness').textContent).toContain('Checked again');
  });
});

describe('FleetOrgCiSetting — the remaining states (MOTIR-8716)', () => {
  const enabledState = (over: Partial<FleetOrgCiStateDTO> = {}) =>
    state({
      enabled: true,
      variable: { state: 'present', value: 'motir-runner', visibility: 'private' },
      ...over,
    });

  it('stored OFF while GitHub still holds the variable is drift', () => {
    render(state({ variable: { state: 'present', value: 'motir-runner', visibility: 'private' } }));
    expect(screen.getByTestId('fleet-org-ci-drift').textContent).toContain(
      'Stored off, but GitHub disagrees.',
    );
  });

  it('a setting nobody has changed says so; an unreadable variable gives its status or says unreachable', () => {
    render(state({ updatedBy: null, updatedAt: null, lastReason: null }));
    expect(screen.getByTestId('fleet-org-ci-last-changed').textContent).toBe('Never changed');
    cleanup();
    render(state({ variable: { state: 'unknown', status: 502 } }));
    expect(screen.getByTestId('fleet-org-ci-variable').textContent).toBe(
      "Couldn't read MOTIR_RUNNER on acme-ci — GitHub answered HTTP 502.",
    );
    cleanup();
    render(state({ variable: { state: 'unknown', status: null } }));
    expect(screen.getByTestId('fleet-org-ci-variable').textContent).toBe(
      "Couldn't read MOTIR_RUNNER on acme-ci — GitHub could not be reached.",
    );
  });

  it('a recorded change with no time and no reason still names who', () => {
    render(state({ updatedAt: null, lastReason: null }));
    expect(screen.getByTestId('fleet-org-ci-last-changed').textContent).toContain(
      'by ops@example.test,  — “”',
    );
  });

  it('with no met repository list the line is left out and the ON confirm counts none', async () => {
    const unmetRepos: FleetReadinessCondition = {
      key: 'app_repositories',
      state: 'unmet',
      reasonCode: 'repositories_not_granted',
      params: { org: 'acme-ci', missing: ['acme-ci/api'] },
      message: 'x',
    };
    const coverageUnknown: FleetReadinessCondition = {
      key: 'image_coverage',
      state: 'unknown',
      reasonCode: 'read_failed',
      params: { status: 500 },
      message: 'x',
    };
    const s = state({}, { app_repositories: unmetRepos, image_coverage: coverageUnknown });
    // Marked ready by hand so the ON switch is not blocked: the confirm is what is read.
    render({ ...s, readiness: { ...s.readiness, ready: true } });
    expect(screen.queryByText('Repositories')).toBeNull();
    const dialog = await openConfirm();
    expect(dialog.textContent).toContain('0 repositories');
  });

  it('falls back to image_coverage’s list, and keeps a name with no owner as it is', () => {
    const notReached: FleetReadinessCondition = {
      key: 'app_repositories',
      state: 'met',
      reasonCode: 'all_reachable',
      params: { repositories: [] },
      message: 'x',
    };
    const covered: FleetReadinessCondition = {
      key: 'image_coverage',
      state: 'met',
      reasonCode: 'all_runnable',
      params: { repositories: ['bare-name', 'acme-ci/api'] },
      message: 'x',
    };
    render(state({}, { app_repositories: notReached, image_coverage: covered }));
    expect(screen.getByText('Repositories').nextElementSibling?.textContent).toContain('bare-name');
  });

  it('a job that cannot be hosted gives its reason, or none', () => {
    const coverage: FleetReadinessCondition = {
      key: 'image_coverage',
      state: 'unmet',
      reasonCode: 'jobs_not_runnable',
      params: {
        jobs: [
          { ...job(1), verdict: 'cannot-host', reason: 'runs-on macos-latest' },
          { ...job(2), verdict: 'cannot-host', reason: null },
          'not a job',
        ],
      },
      message: 'x',
    };
    render(state({}, { image_coverage: coverage }));
    const items = within(screen.getByTestId('fleet-uncovered-jobs')).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      "gateway · w1.yml · job1 — can't be hosted: runs-on macos-latest",
      "gateway · w2.yml · job2 — can't be hosted: ",
    ]);
  });

  it('a suspended App gives its date, and a condition key it does not know is shown as the key', () => {
    const suspended: FleetReadinessCondition = {
      key: 'app_installed',
      state: 'unmet',
      reasonCode: 'app_suspended',
      params: { org: 'acme-ci', suspendedAt: '2026-10-01T00:00:00Z' },
      message: 'x',
    };
    render(
      state(
        {},
        {
          app_installed: suspended,
          kill_switch: {
            key: 'some_future_key' as FleetReadinessKey,
            state: 'unknown',
            reasonCode: 'a_future_code',
            params: {},
            message: 'The future, in English.',
          },
        },
      ),
    );
    expect(screen.getByTestId('fleet-condition-app_installed').textContent).toContain(
      'suspended since Oct 1, 2026',
    );
    const future = screen.getByTestId('fleet-condition-some_future_key');
    expect(future.textContent).toContain('some_future_key');
    expect(future.textContent).toContain('The future, in English.');
  });

  it('turning OFF reports done off; an OFF that GitHub refuses says “Not turned off”', async () => {
    setFleetOrgCiAction.mockResolvedValueOnce({ ok: true, outcome: 'changed' });
    render(enabledState());
    await flipWith('back to hosted');
    expect(setFleetOrgCiAction).toHaveBeenCalledWith('proj_1', 'acme-ci', false, 'back to hosted');
    expect(screen.getByTestId('fleet-org-ci-answer').textContent).toBe(
      'Turned off. New jobs go back to GitHub-hosted runners.',
    );
    cleanup();
    setFleetOrgCiAction.mockResolvedValueOnce({
      ok: false,
      code: 'GITHUB_WRITE_FAILED',
      org: 'acme-ci',
      status: 500,
      operation: 'delete',
    });
    render(enabledState());
    await flipWith('x');
    expect(screen.getByTestId('fleet-org-ci-answer').textContent).toContain('Not turned off');
  });

  it('unchanged while asking OFF says already off', async () => {
    setFleetOrgCiAction.mockResolvedValueOnce({ ok: true, outcome: 'unchanged', enabled: false });
    render(enabledState());
    await flipWith('x');
    expect(screen.getByTestId('fleet-org-ci-answer').textContent).toContain(
      'Already off — nothing changed.',
    );
  });

  it('Re-check refreshes the server read', () => {
    render(state());
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the confirm, discarding the reason', async () => {
    render(state());
    const dialog = await openConfirm();
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'half typed' } });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    const again = await openConfirm();
    expect((within(again).getByLabelText(/Reason/) as HTMLInputElement).value).toBe('');
    expect(setFleetOrgCiAction).not.toHaveBeenCalled();
  });
});

describe('FleetOrgCiSetting — CodeQL default setup per repository (MOTIR-10289)', () => {
  it('lists each configured repository with where its CodeQL runs, and says when a read failed', () => {
    render(
      state({
        codeScanning: [
          { repo: 'api', state: 'fleet' },
          { repo: 'docs', state: 'not_configured' },
          { repo: 'gateway', state: 'github_hosted' },
          { repo: 'meta', state: 'unknown', status: 502 },
          { repo: 'site', state: 'unavailable' },
          { repo: 'tools', state: 'unknown', status: null },
        ],
      }),
    );
    const row = screen.getByTestId('fleet-org-ci-code-scanning');
    expect(
      within(row)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'api — on the fleet (motir-runner)',
      'gateway — on GitHub-hosted runners',
      "meta — couldn't read — GitHub answered HTTP 502",
      "tools — couldn't read — GitHub could not be reached",
    ]);
    expect(screen.getByText('CodeQL default setup')).toBeTruthy();
  });

  it('says a deferred repository moves onto the fleet with the next fleet job', () => {
    render(state({ codeScanning: [{ repo: 'motir-ai', state: 'pending_fleet' }] }));
    const item = screen.getByTestId('fleet-org-ci-code-scanning-motir-ai');
    expect(item.getAttribute('data-state')).toBe('pending_fleet');
    expect(item.textContent).toBe(
      "motir-ai — on GitHub-hosted runners until the next fleet job — that job's runner lets it move onto the fleet (motir-runner)",
    );
  });

  it('says so when no private repository has default setup configured', () => {
    render(state({ codeScanning: [{ repo: 'docs', state: 'not_configured' }] }));
    expect(screen.getByTestId('fleet-org-ci-code-scanning').textContent).toBe(
      'No private repository on acme-ci has CodeQL default setup configured.',
    );
  });
});

describe('FleetOrgCiSetting — what a flip skipped or could not confirm (MOTIR-11933)', () => {
  const lines = () =>
    within(screen.getByTestId('fleet-org-ci-code-scanning'))
      .getAllByRole('listitem')
      .map((li) => li.textContent);

  it('an OFF that skipped an unreadable repository warns, and that repository’s line says why', async () => {
    setFleetOrgCiAction.mockResolvedValueOnce({
      ok: true,
      outcome: 'changed',
      codeScanning: { skipped: [{ repo: 'motir-ai', status: 500 }], unverified: [] },
    });
    render(
      state({
        enabled: true,
        codeScanning: [
          { repo: 'gateway', state: 'github_hosted' },
          { repo: 'motir-ai', state: 'unknown', status: 500 },
        ],
      }),
    );
    await flipWith('fleet broke');
    const answer = screen.getByTestId('fleet-org-ci-answer');
    expect(answer.getAttribute('data-tone')).toBe('warning');
    expect(answer.textContent).toBe(
      "Turned off. New jobs go back to GitHub-hosted runners.Some repositories' CodeQL default setup needs a look — see CodeQL default setup below.",
    );
    expect(lines()).toEqual([
      'gateway — on GitHub-hosted runners',
      'motir-ai — skipped by this change — GitHub answered HTTP 500 when its setting was read, so its runner was left as it was',
    ]);
  });

  it('names a skip GitHub could not be reached for, and every read-back problem, on its own line', async () => {
    setFleetOrgCiAction.mockResolvedValueOnce({
      ok: true,
      outcome: 'changed',
      codeScanning: {
        skipped: [{ repo: 'api', status: null }],
        unverified: [
          { repo: 'b500', to: 'fleet', problem: 'read_failed', status: 500 },
          { repo: 'c-down', to: 'fleet', problem: 'read_failed', status: null },
          { repo: 'd-std', to: 'fleet', problem: 'mismatch', found: { state: 'standard' } },
          {
            repo: 'e-label',
            to: 'github_hosted',
            problem: 'mismatch',
            found: { state: 'labeled', label: 'motir-runner' },
          },
          { repo: 'f-none', to: 'fleet', problem: 'mismatch', found: { state: 'not_configured' } },
          { repo: 'g-off', to: 'fleet', problem: 'mismatch', found: { state: 'unavailable' } },
        ],
      },
    });
    render(
      state({
        codeScanning: [
          { repo: 'api', state: 'unknown', status: null },
          { repo: 'b500', state: 'unknown', status: 500 },
          { repo: 'c-down', state: 'unknown', status: null },
          { repo: 'd-std', state: 'github_hosted' },
          { repo: 'e-label', state: 'fleet' },
          // Listed although the page's read hides these states, because the flip names them.
          { repo: 'f-none', state: 'not_configured' },
          { repo: 'g-off', state: 'unavailable' },
          { repo: 'h-quiet', state: 'not_configured' },
        ],
      }),
    );
    await flipWith('onto the fleet');
    expect(lines()).toEqual([
      'api — skipped by this change — GitHub could not be reached to read its setting, so its runner was left as it was',
      'b500 — moved to the fleet, but GitHub now answers HTTP 500 when the setting is read back',
      'c-down — moved to the fleet, but GitHub could not be reached to read the setting back',
      'd-std — moved to the fleet, but GitHub now reports GitHub-hosted runners',
      'e-label — moved to GitHub-hosted runners, but GitHub now reports the runner label motir-runner',
      'f-none — moved to the fleet, but GitHub now reports default setup not configured',
      'g-off — moved to the fleet, but GitHub now reports code scanning unavailable',
    ]);
  });

  it('a changed flip with nothing to look at keeps the plain answer and the read-back lines', async () => {
    setFleetOrgCiAction.mockResolvedValueOnce({ ok: true, outcome: 'changed' });
    render(state({ codeScanning: [{ repo: 'api', state: 'github_hosted' }] }));
    await flipWith('onto the fleet');
    expect(screen.getByTestId('fleet-org-ci-answer').getAttribute('data-tone')).toBe('info');
    expect(lines()).toEqual(['api — on GitHub-hosted runners']);
  });
});

describe('FleetOrgCiSetting — the arm64 line (MOTIR-11786)', () => {
  const arm64Row = () => screen.getByTestId('fleet-org-ci-arm64-variable');
  const readiness = () => screen.getByTestId('fleet-org-ci-arm64-readiness');

  it('not ready: the variable is not set, and the reason is said in words', () => {
    render(state());
    expect(arm64Row().textContent).toContain(
      "MOTIR_RUNNER_ARM64 is not set on acme-ci — arm64 jobs run on GitHub's arm runners.",
    );
    expect(readiness().getAttribute('data-ready')).toBe('false');
    expect(readiness().getAttribute('data-reason')).toBe('arm64_runner_ami_not_pinned');
    expect(readiness().textContent).toContain('arm64 pool not ready');
    expect(screen.getByTestId('fleet-org-ci-arm64-not-ready-reason').textContent).toBe(
      "No arm64 runner AMI is pinned, so arm64 jobs keep running on GitHub's arm runners.",
    );
  });

  it('the row is labelled as the arm64 GitHub variable, beside the x86 one', () => {
    render(state());
    const labels = screen.getAllByText(/GitHub variable$/).map((n) => n.textContent);
    expect(labels).toEqual(['GitHub variable', 'arm64 GitHub variable']);
  });

  it('ready and set: the value and the org, and the ready note', () => {
    render(
      state({
        enabled: true,
        arm64: {
          ready: true,
          reason: null,
          variable: { state: 'present', value: 'motir-graviton', visibility: 'private' },
        },
      }),
    );
    expect(arm64Row().textContent).toContain(
      "MOTIR_RUNNER_ARM64 = motir-graviton on acme-ci — new arm64 jobs request Motir's arm64 fleet.",
    );
    expect(arm64Row().querySelector('[data-state]')?.getAttribute('data-state')).toBe('present');
    expect(readiness().getAttribute('data-ready')).toBe('true');
    expect(readiness().textContent).toContain('arm64 pool ready');
    expect(readiness().textContent).toContain(
      'An arm64 runner AMI is pinned, so turning the setting on writes MOTIR_RUNNER_ARM64.',
    );
    expect(screen.queryByTestId('fleet-org-ci-arm64-not-ready-reason')).toBeNull();
  });

  it('unreadable: unreachable with no status, the status otherwise, while the x86 row keeps its own', () => {
    render(
      state({
        variable: { state: 'present', value: 'motir-runner', visibility: 'private' },
        arm64: { ready: true, reason: null, variable: { state: 'unknown', status: null } },
      }),
    );
    expect(arm64Row().textContent).toContain(
      "Couldn't read MOTIR_RUNNER_ARM64 on acme-ci — GitHub could not be reached.",
    );
    expect(screen.getByTestId('fleet-org-ci-variable').textContent).toContain(
      'MOTIR_RUNNER = motir-runner on acme-ci',
    );
    cleanup();
    render(
      state({ arm64: { ready: true, reason: null, variable: { state: 'unknown', status: 502 } } }),
    );
    expect(arm64Row().textContent).toContain(
      "Couldn't read MOTIR_RUNNER_ARM64 on acme-ci — GitHub answered HTTP 502.",
    );
  });

  it('a pool that is not ready never disables the ON switch', () => {
    render(state());
    expect(theSwitch().hasAttribute('disabled')).toBe(false);
  });
});

describe('FleetOrgCiSetting — the arm64 drift band and confirm sentence (MOTIR-11791)', () => {
  const PRESENT = { state: 'present' as const, value: 'motir-graviton', visibility: 'private' };
  const X86_ON = { state: 'present' as const, value: 'motir-runner', visibility: 'private' };
  const arm64Drift = () => screen.queryByTestId('fleet-org-ci-arm64-drift');
  const x86Drift = () => screen.queryByTestId('fleet-org-ci-drift');

  it('ON, ready, arm64 variable absent ⇒ the ON-absent warning band, naming the variable and org', () => {
    render(
      state({
        enabled: true,
        variable: X86_ON,
        arm64: { ready: true, reason: null, variable: { state: 'absent' } },
      }),
    );
    const band = arm64Drift()!;
    expect(band.textContent).toContain('Stored on, but GitHub has no arm64 variable.');
    expect(band.textContent).toContain(
      "MOTIR_RUNNER_ARM64 is not set on acme-ci although the arm64 pool is ready, so arm64 jobs still run on GitHub's arm runners.",
    );
    expect(band.getAttribute('role')).toBe('status');
    // The x86 variable agrees with the switch: its own band stays away.
    expect(x86Drift()).toBeNull();
  });

  it('ON, NOT ready, arm64 variable absent ⇒ no arm64 band (that is the not-ready reason)', () => {
    render(state({ enabled: true, variable: X86_ON }));
    expect(arm64Drift()).toBeNull();
    expect(screen.getByTestId('fleet-org-ci-arm64-not-ready-reason')).toBeTruthy();
  });

  it('OFF with the arm64 variable present ⇒ the OFF-present warning band', () => {
    render(
      state({ arm64: { ready: false, reason: 'arm64_runner_ami_not_pinned', variable: PRESENT } }),
    );
    const band = arm64Drift()!;
    expect(band.textContent).toContain('Stored off, but the arm64 variable is still set.');
    expect(band.textContent).toContain(
      "MOTIR_RUNNER_ARM64 is still set on acme-ci, so new arm64 jobs still request Motir's arm64 fleet.",
    );
    expect(x86Drift()).toBeNull();
  });

  it('the switch and the arm64 variable agreeing ⇒ no arm64 band, either way', () => {
    render(
      state({
        enabled: true,
        variable: X86_ON,
        arm64: { ready: true, reason: null, variable: PRESENT },
      }),
    );
    expect(arm64Drift()).toBeNull();
    cleanup();
    render(state());
    expect(arm64Drift()).toBeNull();
  });

  it('the x86 drift band renders exactly as before beside an arm64 one', () => {
    render(
      state({
        enabled: true,
        variable: { state: 'absent' },
        arm64: { ready: true, reason: null, variable: { state: 'absent' } },
      }),
    );
    expect(x86Drift()!.textContent).toContain('Stored on, but GitHub disagrees.');
    expect(arm64Drift()).not.toBeNull();
  });

  it('the ON confirm while ready says both variables will be written', async () => {
    render(state({ arm64: { ready: true, reason: null, variable: { state: 'absent' } } }));
    const dialog = await openConfirm();
    expect(within(dialog).getByTestId('fleet-org-ci-confirm-arm64').textContent).toBe(
      'arm64: the arm64 pool is ready, so this writes both MOTIR_RUNNER and MOTIR_RUNNER_ARM64 on acme-ci.',
    );
    expect(dialog.textContent).toContain('Turn on fleet CI for acme-ci?');
    expect(within(dialog).getByLabelText(/Reason/)).toBeTruthy();
  });

  it('the ON confirm while not ready says only MOTIR_RUNNER is written', async () => {
    render(state());
    const dialog = await openConfirm();
    expect(within(dialog).getByTestId('fleet-org-ci-confirm-arm64').textContent).toBe(
      "arm64: no arm64 runner AMI is pinned, so this writes only MOTIR_RUNNER. arm64 jobs stay on GitHub's arm runners.",
    );
  });

  it('the OFF confirm says both variables will be deleted, whatever the pool', async () => {
    render(state({ enabled: true, variable: X86_ON }));
    const dialog = await openConfirm();
    expect(within(dialog).getByTestId('fleet-org-ci-confirm-arm64').textContent).toBe(
      'arm64: this deletes both MOTIR_RUNNER and MOTIR_RUNNER_ARM64 from acme-ci.',
    );
    expect(dialog.textContent).toContain('Turn off fleet CI for acme-ci?');
    expect(within(dialog).getByRole('button', { name: /^Turn off$/ })).toBeTruthy();
  });

  it('the island spells neither the arm64 label nor the arm64 variable name', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      'app/(admin)/admin/fleet-settings/_components/FleetOrgCiSetting.tsx',
      'utf8',
    );
    expect(source).not.toContain("'motir-graviton'");
    expect(source).not.toContain("'MOTIR_RUNNER_ARM64'");
  });
});
