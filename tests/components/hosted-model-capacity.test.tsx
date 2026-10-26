// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { HostedRunProvider } from '@/app/(authed)/items/[key]/_components/HostedRunProvider';
import { RunDoorControl } from '@/app/(authed)/items/[key]/_components/RunHostedButton';
import { HostedDoorNotices } from '@/app/(authed)/items/[key]/_components/HostedDoorNotices';
import { HOSTED_CAPACITY_REFRESH_MS } from '@/components/hosted/HostedModelsProvider';
import { capacityOf, readModels, refusalOf } from '@/components/hosted/hostedModels';

// A MODEL WITH NO AGENT-RUN CAPACITY, IN THE BROWSER (Story MOTIR-9541 · MOTIR-9630;
// `design/runs/run-section--no-capacity.mock.html`, Panels N1–N9, and
// `design/runs/design-notes.md` § Run hosted — a model with no agent-run capacity).
// The parser, the Held model option, the held Run door, the All-models-held line,
// the quiet re-read that clears a label in place, and the No-capacity refusal.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const picker = en.runs.hosted.picker;
const refused = en.runs.hosted.refused;
const zhPicker = zhMessages.runs.hosted.picker;
const zhRefused = zhMessages.runs.hosted.refused;

type Wire = { id: string; provider: string; capacity?: unknown };
const AVAILABLE = { verdict: 'available' };
const FULL = { verdict: 'no_capacity', reason: 'agent_share_exhausted' };
const LIMITED = { verdict: 'no_capacity', reason: 'provider_rate_limited' };

let list: Wire[] = [];
let start: () => { status: number; body: unknown } = () => ({ status: 201, body: {} });
/** A read the test holds open — resolved by hand to race two re-reads. */
let gate: Promise<void> | null = null;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input).split('?')[0] ?? '';
  if (url === '/api/hosted-runs/models') {
    const snapshot = list;
    if (gate) await gate;
    return json(200, { models: snapshot, default: 'claude-opus-5-5' });
  }
  if (url.endsWith('/hosted-runs') && init?.method === 'POST') {
    const a = start();
    return json(a.status, a.body);
  }
  return new Response(null, { status: 500 });
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const modelReads = () =>
  fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/hosted-runs/models')).length;

function models(over: Record<string, unknown> = {}): Wire[] {
  return [
    {
      id: 'claude-opus-5-5',
      provider: 'anthropic',
      capacity: over['claude-opus-5-5'] ?? AVAILABLE,
    },
    { id: 'claude-opus-5', provider: 'anthropic', capacity: over['claude-opus-5'] ?? AVAILABLE },
    {
      id: 'claude-fable-5-1',
      provider: 'anthropic',
      capacity: over['claude-fable-5-1'] ?? AVAILABLE,
    },
  ];
}

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockClear();
  list = models();
  gate = null;
  start = () => ({ status: 201, body: { dispatchRunId: 'run_1' } });
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountDoor({ zh = false }: { zh?: boolean } = {}) {
  const view = render(
    <HostedRunProvider itemKey="PROD-42" ready openBlockers={0}>
      <RunDoorControl />
      <HostedDoorNotices />
    </HostedRunProvider>,
    zh ? { locale: 'zh', messages: zhMessages } : {},
  );
  await act(async () => {});
  return view;
}

const trigger = () => screen.getByRole('combobox');
const runButton = () => screen.getByTestId('run-hosted') as HTMLButtonElement;
const optionFor = (id: string) =>
  screen
    .getAllByRole('option')
    .find((o) => o.textContent?.startsWith(id) && !o.textContent.startsWith(`${id}-`))!;
async function openMenu() {
  await act(async () => {
    fireEvent.click(trigger());
  });
}
/** Advance one poll and let its read land. */
async function tick() {
  await act(async () => {
    vi.advanceTimersByTime(HOSTED_CAPACITY_REFRESH_MS);
  });
  await act(async () => {});
}

describe('the parser', () => {
  it('copies only the verdict and a known reason; anything else reads available', () => {
    expect(capacityOf(FULL)).toEqual(FULL);
    expect(capacityOf(LIMITED)).toEqual(LIMITED);
    for (const bad of [
      undefined,
      null,
      'no_capacity',
      { verdict: 'no_capacity' },
      { verdict: 'no_capacity', reason: 'tenant_quota' },
      { verdict: 'full' },
    ]) {
      expect(capacityOf(bad)).toEqual({ verdict: 'available' });
    }
    expect(Object.keys(capacityOf({ ...FULL, inFlight: 3, limit: 4 }))).toEqual([
      'verdict',
      'reason',
    ]);
  });

  it('readModels returns each model as exactly { id, provider, capacity }, no wire extras', async () => {
    list = [
      {
        id: 'claude-opus-5-5',
        provider: 'anthropic',
        capacity: { ...FULL, tokensPerMinute: 480000 },
        limit: 600,
      } as Wire,
      { id: 'claude-opus-5', provider: 'anthropic' },
    ];
    const read = await readModels('PROD-42');
    if (read.state !== 'ok') throw new Error('expected ok');
    expect(read.models).toEqual([
      { id: 'claude-opus-5-5', provider: 'anthropic', capacity: FULL },
      { id: 'claude-opus-5', provider: 'anthropic', capacity: { verdict: 'available' } },
    ]);
    expect(JSON.stringify(read)).not.toMatch(/480000|600/);
  });

  it('refusalOf maps hosted_run_no_capacity to noCapacity naming the body model', () => {
    expect(
      refusalOf(409, { code: 'hosted_run_no_capacity', model: 'claude-opus-5', reason: 'x' }, 'm'),
    ).toEqual({ kind: 'noCapacity', model: 'claude-opus-5' });
    expect(refusalOf(409, { code: 'hosted_run_no_capacity' }, 'claude-opus-5-5')).toEqual({
      kind: 'noCapacity',
      model: 'claude-opus-5-5',
    });
  });
});

describe('the Held model option (N1, N2)', () => {
  it('is aria-disabled, focusable, tagged, described, and never picked', async () => {
    list = models({ 'claude-fable-5-1': FULL });
    await mountDoor();
    await openMenu();
    const held = optionFor('claude-fable-5-1');
    expect(held.getAttribute('aria-disabled')).toBe('true');
    expect(within(held).getByTestId('hosted-no-capacity-tag').textContent).toBe(
      picker.noCapacityTag,
    );
    expect(held.textContent).toContain(picker.noCapacityReason);
    // Its secondary (the provider) gives its slot to the tag.
    expect(held.textContent).not.toContain('anthropic');
    await act(async () => {
      fireEvent.click(held);
    });
    expect(trigger().textContent).toContain('claude-opus-5-5');
    // An available model renders as today.
    const free = optionFor('claude-opus-5');
    expect(free.getAttribute('aria-disabled')).toBeNull();
    expect(free.textContent).toContain('anthropic');
  });

  it('reads in zh', async () => {
    list = models({ 'claude-fable-5-1': LIMITED });
    await mountDoor({ zh: true });
    await openMenu();
    const held = optionFor('claude-fable-5-1');
    expect(held.textContent).toContain(zhPicker.noCapacityTag);
    expect(held.textContent).toContain(zhPicker.noCapacityReason);
  });
});

describe('a held selection holds Run (N3) — the model stays', () => {
  it('keeps the model in the trigger, disables Run and draws the Held Run line', async () => {
    list = models({ 'claude-opus-5-5': FULL });
    await mountDoor();
    expect(trigger().textContent).toContain('claude-opus-5-5');
    expect(runButton().disabled).toBe(true);
    const line = screen.getByTestId('hosted-held-line');
    expect(line.textContent).toBe(
      'claude-opus-5-5 has no agent-run capacity right now. Pick another model, or wait until it has.',
    );
    expect(runButton().getAttribute('aria-describedby')).toBe(line.id);
    expect(screen.queryByTestId('hosted-models-all-held')).toBeNull();
  });

  it('a held line in zh', async () => {
    list = models({ 'claude-opus-5-5': FULL });
    await mountDoor({ zh: true });
    expect(screen.getByTestId('hosted-held-line').textContent).toContain('目前没有智能体运行容量');
  });

  it('picking an available model lifts the hold', async () => {
    list = models({ 'claude-opus-5-5': FULL });
    await mountDoor();
    await openMenu();
    await act(async () => {
      fireEvent.click(optionFor('claude-opus-5'));
    });
    expect(runButton().disabled).toBe(false);
    expect(screen.queryByTestId('hosted-held-line')).toBeNull();
  });

  it('every model held: the All-models-held line, Run off, no Held Run line (N5)', async () => {
    list = models({ 'claude-opus-5-5': FULL, 'claude-opus-5': LIMITED, 'claude-fable-5-1': FULL });
    await mountDoor();
    expect(screen.getByTestId('hosted-models-all-held').textContent).toBe(picker.allHeldBody);
    expect(runButton().disabled).toBe(true);
    expect(screen.queryByTestId('hosted-held-line')).toBeNull();
  });

  it('fail-open (every model available) is today’s door (N9)', async () => {
    await mountDoor();
    expect(runButton().disabled).toBe(false);
    expect(screen.queryByTestId('hosted-held-line')).toBeNull();
    expect(screen.queryByTestId('hosted-models-all-held')).toBeNull();
    await openMenu();
    expect(screen.queryAllByTestId('hosted-no-capacity-tag')).toHaveLength(0);
  });
});

describe('the label clearing in place (N4)', () => {
  it('a quiet re-read clears and sets the label within one window, never via loading', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    list = models({ 'claude-fable-5-1': FULL });
    await mountDoor();
    await openMenu();
    expect(optionFor('claude-fable-5-1').getAttribute('aria-disabled')).toBe('true');

    list = models({ 'claude-opus-5': LIMITED });
    await tick();
    // The menu stayed open; the rows swapped in place.
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(optionFor('claude-fable-5-1').getAttribute('aria-disabled')).toBeNull();
    expect(optionFor('claude-opus-5').getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByText(picker.loadingTrigger)).toBeNull();
    expect(screen.queryByText(picker.loadingBody)).toBeNull();
  });

  it('a held selection lifts by itself when capacity returns', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    list = models({ 'claude-opus-5-5': FULL });
    await mountDoor();
    expect(runButton().disabled).toBe(true);
    list = models();
    await tick();
    expect(runButton().disabled).toBe(false);
    expect(screen.queryByTestId('hosted-held-line')).toBeNull();
  });

  it('stops while the document is hidden and on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const view = await mountDoor();
    await tick();
    expect(modelReads()).toBe(2);
    visibility = 'hidden';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await tick();
    await tick();
    expect(modelReads()).toBe(2);
    visibility = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await tick();
    expect(modelReads()).toBe(3);
    view.unmount();
    await tick();
    expect(modelReads()).toBe(3);
  });

  it('a slower earlier read never overwrites a newer one', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await mountDoor();
    // The first poll reads a held default, and is held open…
    list = models({ 'claude-opus-5-5': FULL });
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    await act(async () => {
      vi.advanceTimersByTime(HOSTED_CAPACITY_REFRESH_MS);
    });
    // …while a newer poll reads it free and lands first.
    gate = null;
    list = models();
    await tick();
    expect(runButton().disabled).toBe(false);
    await act(async () => {
      release();
    });
    await act(async () => {});
    expect(runButton().disabled).toBe(false);
    expect(screen.queryByTestId('hosted-held-line')).toBeNull();
  });
});

describe('the No-capacity refusal on the Run door (N6)', () => {
  it('names the model, refreshes quietly to held, and clears on another pick', async () => {
    start = () => ({
      status: 409,
      body: { code: 'hosted_run_no_capacity', model: 'claude-opus-5-5', reason: 'x' },
    });
    await mountDoor();
    list = models({ 'claude-opus-5-5': FULL });
    const before = modelReads();
    await act(async () => {
      fireEvent.click(runButton());
    });
    await act(async () => {});
    const notice = screen.getByTestId('hosted-refused-noCapacity');
    expect(notice.textContent).toContain(
      refused.noCapacity.title.replace('{model}', 'claude-opus-5-5'),
    );
    expect(notice.textContent).toContain(refused.noCapacity.body);
    expect(notice.textContent).not.toMatch(/\d{2,}/);
    expect(modelReads()).toBe(before + 1);
    // The picker now reads held; the refusal names the model, so the Held Run line waits.
    expect(runButton().disabled).toBe(true);
    expect(screen.queryByTestId('hosted-held-line')).toBeNull();
    expect(screen.queryByText(picker.loadingBody)).toBeNull();

    await openMenu();
    await act(async () => {
      fireEvent.click(optionFor('claude-opus-5'));
    });
    expect(screen.queryByTestId('hosted-refused-noCapacity')).toBeNull();
    expect(runButton().disabled).toBe(false);
  });

  it('reads in zh', async () => {
    start = () => ({
      status: 409,
      body: { code: 'hosted_run_no_capacity', model: 'claude-opus-5-5', reason: 'x' },
    });
    await mountDoor({ zh: true });
    await act(async () => {
      fireEvent.click(runButton());
    });
    await act(async () => {});
    const notice = screen.getByTestId('hosted-refused-noCapacity');
    expect(notice.textContent).toContain(
      zhRefused.noCapacity.title.replace('{model}', 'claude-opus-5-5'),
    );
    expect(notice.textContent).toContain(zhRefused.noCapacity.body);
  });
});

describe('the copy', () => {
  it('no new string carries a digit, a limit word, tenant wording or “card”', () => {
    const strings = [
      picker.noCapacityTag,
      picker.noCapacityReason,
      picker.allHeldBody,
      en.runs.hosted.door.heldModel,
      refused.noCapacity.title,
      refused.noCapacity.body,
    ];
    for (const s of strings) {
      expect(s).not.toMatch(/\d|limit|share|counter|quota|tenant|workspace|\bcard\b/i);
    }
  });
});
