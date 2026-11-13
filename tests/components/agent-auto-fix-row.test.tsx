// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { AgentAutoFixRow } from '@/app/(authed)/settings/project/hosted-agent/_components/AgentAutoFixRow';

// AgentAutoFixRow (Story MOTIR-8981 · MOTIR-9060) — the one switch in the Hosted
// agent room: the stored value rendered, disabled without `canConfigure`, a press
// that cannot repeat while in flight, and the put-back on a failed write.

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(initial: boolean, canConfigure = true) {
  renderWithIntl(
    <ToastProvider>
      <AgentAutoFixRow projectKey="PROD" initial={initial} canConfigure={canConfigure} />
    </ToastProvider>,
  );
}
const sw = () => screen.getByRole('switch') as HTMLButtonElement;
const press = async () => {
  await act(async () => {
    fireEvent.click(sw());
  });
};
const reply = (ok: boolean, body: unknown = {}) =>
  ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;

describe('AgentAutoFixRow', () => {
  it('renders the stored value, never a default', () => {
    mount(true);
    expect(sw().getAttribute('aria-checked')).toBe('true');
    cleanup();
    mount(false);
    expect(sw().getAttribute('aria-checked')).toBe('false');
  });

  it('is disabled without canConfigure and a press sends nothing', async () => {
    mount(false, false);
    expect(sw().disabled).toBe(true);
    await press();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a press moves the switch and PATCHes the new value once, taking the response as committed', async () => {
    fetchMock.mockResolvedValue(reply(true, { agentAutoFixEnabled: true }));
    mount(false);
    await press();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/projects/PROD/agent-auto-fix');
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      agentAutoFixEnabled: true,
    });
    expect(sw().getAttribute('aria-checked')).toBe('true');
  });

  it('refuses a second press while one write is in flight', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    mount(false);
    await press();
    expect(sw().disabled).toBe(true);
    await press();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a failed write returns the switch to the value the row still holds and raises the toast', async () => {
    fetchMock.mockResolvedValue(reply(false));
    mount(false);
    await press();
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(sw().disabled).toBe(false);
    expect(screen.getByText(/Motir agent settings weren.t saved/i)).toBeTruthy();
  });

  it('a write that never reaches the server restores the switch the same way', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    mount(true);
    await press();
    expect(sw().getAttribute('aria-checked')).toBe('true');
    expect(sw().disabled).toBe(false);
    expect(screen.getByText(/Motir agent settings weren.t saved/i)).toBeTruthy();
  });

  it('turning it off sends the off value', async () => {
    fetchMock.mockResolvedValue(reply(true, { agentAutoFixEnabled: false }));
    mount(true);
    await press();
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      agentAutoFixEnabled: false,
    });
    expect(sw().getAttribute('aria-checked')).toBe('false');
  });
});
