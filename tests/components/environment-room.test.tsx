// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  EnvironmentRoom,
  type EnvironmentRepositoryOption,
} from '@/app/(authed)/settings/project/environment/_components/EnvironmentRoom';
import type { EnvironmentChangeDto, EnvironmentEntryDto } from '@/lib/dto/environmentConfig';
import type { EnvironmentName } from '@/lib/environmentConfig/vocabulary';

// EnvironmentRoom (Story MOTIR-9795 · MOTIR-9966) — the Environment settings room,
// per `design/environment/environment.mock.html` (MOTIR-9959). Driven under
// happy-dom (DB-free): the room is a client island over the four environment
// routes, so global fetch is a small in-memory fake of those routes, answering
// the DTO shapes and typed refusals they answer. The page-level loader is tested
// against real Postgres in `tests/settings/environmentPage.test.tsx`.

const SECRET = 'sk_live_DISTINCTIVE_9966_value';
const REPOS: EnvironmentRepositoryOption[] = [
  { id: 'repo-web', name: 'acme-web', role: 'web', label: null },
  { id: 'repo-api', name: 'acme-api', role: 'api', label: 'billing' },
];

interface Call {
  method: string;
  url: string;
  body: string | null;
}

/** An in-memory stand-in for the routes, per repository and environment. */
function fakeRoutes() {
  const entries = new Map<string, EnvironmentEntryDto[]>();
  const changes = new Map<string, EnvironmentChangeDto[]>();
  const calls: Call[] = [];
  let failNext: { method: string; status: number } | null = null;
  let refuseName: string | null = null;
  let hold: Promise<void> | null = null;
  let id = 0;

  const json = (status: number, body: unknown) =>
    ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

  const handler = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ method, url: input, body });
    if (hold && method !== 'GET') await hold;
    const m = input.match(
      /repositories\/([^/]+)\/environments\/([^/]+)\/(entries|changes)(?:\/([^/]+))?$/,
    );
    if (!m) return json(404, {});
    const [, repo, env, kind, rawName] = m;
    const key = `${repo}:${env}`;
    if (failNext && failNext.method === method) {
      const { status } = failNext;
      failNext = null;
      return json(status, { error: { code: 'internal', message: 'boom' } });
    }
    const list = entries.get(key) ?? [];
    const record = (name: string, action: EnvironmentChangeDto['action'], isSecret: boolean) => {
      const prev = changes.get(key) ?? [];
      changes.set(key, [
        {
          id: `c${++id}`,
          environment: env as EnvironmentName,
          name,
          action,
          isSecret,
          actorId: 'u1',
          actorName: 'Ada Park',
          createdAt: new Date(Date.now() - 60_000).toISOString(),
        },
        ...prev,
      ]);
    };
    if (kind === 'changes') return json(200, changes.get(key) ?? []);
    if (method === 'GET') return json(200, list);
    const name = decodeURIComponent(rawName!);
    if (method === 'PUT') {
      if (name === refuseName) {
        return json(422, {
          error: { code: 'reserved_environment_name', message: 'reserved', name },
        });
      }
      const { value, isSecret } = JSON.parse(body!) as { value: string; isSecret: boolean };
      const had = list.find((e) => e.name === name);
      const entry: EnvironmentEntryDto = {
        name,
        isSecret,
        value: isSecret ? null : value,
        updatedAt: new Date().toISOString(),
      };
      entries.set(key, [...list.filter((e) => e.name !== name), entry]);
      record(name, had ? 'replaced' : 'added', isSecret);
      return json(200, { outcome: had ? 'replaced' : 'created', entry });
    }
    if (method === 'DELETE') {
      const had = list.find((e) => e.name === name);
      if (!had) return json(404, { error: { code: 'environment_entry_not_found' } });
      entries.set(
        key,
        list.filter((e) => e.name !== name),
      );
      record(name, 'deleted', had.isSecret);
      return { ok: true, status: 204, json: async () => null } as unknown as Response;
    }
    return json(405, {});
  });

  return {
    handler,
    calls,
    seed(repo: string, env: EnvironmentName, rows: EnvironmentEntryDto[]) {
      entries.set(`${repo}:${env}`, rows);
    },
    failNext(method: string, status = 500) {
      failNext = { method, status };
    },
    refuse(name: string) {
      refuseName = name;
    },
    holdWrites() {
      let release!: () => void;
      hold = new Promise((r) => (release = r));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

let routes: ReturnType<typeof fakeRoutes>;
let consoleLines: string[];

beforeEach(() => {
  routes = fakeRoutes();
  vi.stubGlobal('fetch', routes.handler);
  consoleLines = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const plain = (name: string, value: string): EnvironmentEntryDto => ({
  name,
  isSecret: false,
  value,
  updatedAt: '2026-10-28T10:00:00.000Z',
});
const secret = (name: string): EnvironmentEntryDto => ({
  name,
  isSecret: true,
  value: null,
  updatedAt: '2026-10-28T10:00:00.000Z',
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function mount(
  props: Partial<{
    canEdit: boolean;
    showReleaseTab: boolean;
    initialEnvironment: EnvironmentName;
  }> = {},
) {
  renderWithIntl(
    <EnvironmentRoom
      projectKey="ACME"
      repositories={REPOS}
      initialRepositoryId="repo-web"
      initialEnvironment={props.initialEnvironment ?? 'production'}
      canEdit={props.canEdit ?? true}
      showReleaseTab={props.showReleaseTab ?? false}
    />,
    { now: new Date() },
  );
  await settle();
}

const writes = () => routes.calls.filter((c) => c.method !== 'GET');
const nameField = () => screen.getByRole('textbox', { name: 'Name' });
const valueField = () => screen.getByPlaceholderText('Value', { exact: true }) as HTMLInputElement;
const saveButton = () =>
  within(screen.getByTestId('environment-add')).getByRole('button', { name: 'Save' });
const rowNamed = (name: string) =>
  screen.getAllByTestId('environment-entry').find((li) => li.getAttribute('data-name') === name)!;

async function add(name: string, value: string, isSecret = false) {
  fireEvent.change(nameField(), { target: { value: name } });
  fireEvent.change(valueField(), { target: { value } });
  if (isSecret) fireEvent.click(screen.getByRole('switch', { name: 'Secret' }));
  fireEvent.click(saveButton());
  await settle();
}

describe('the administrator, in Production and Preview', () => {
  it.each(['production', 'preview'] as const)(
    'in %s: add a plain entry, edit it, add a secret, delete one — one route call each, rows from the response',
    async (env) => {
      await mount({ initialEnvironment: env });
      expect(screen.getByRole('tab', { selected: true }).textContent).toBe(
        env === 'production' ? 'Production' : 'Preview',
      );

      await add('GREETING', 'hello');
      expect(writes()).toHaveLength(1);
      expect(writes()[0]).toMatchObject({ method: 'PUT' });
      expect(writes()[0]!.url).toContain(`/environments/${env}/entries/GREETING`);
      expect(rowNamed('GREETING').textContent).toContain('hello');

      fireEvent.click(screen.getByRole('button', { name: 'Edit GREETING' }));
      const edit = screen.getByRole('textbox', { name: 'Edit GREETING' }) as HTMLInputElement;
      expect(edit.value).toBe('hello');
      fireEvent.change(edit, { target: { value: 'hello-again' } });
      fireEvent.click(within(edit.closest('li')!).getByRole('button', { name: 'Save' }));
      await settle();
      expect(writes()).toHaveLength(2);
      expect(rowNamed('GREETING').textContent).toContain('hello-again');

      await add('API_KEY', SECRET, true);
      expect(writes()).toHaveLength(3);
      expect(JSON.parse(writes()[2]!.body!)).toEqual({ value: SECRET, isSecret: true });
      expect(rowNamed('API_KEY').textContent).toContain('Set');

      fireEvent.click(screen.getByRole('button', { name: 'Delete GREETING' }));
      const dialog = await screen.findByRole('alertdialog');
      expect(
        within(dialog).getByText(
          'Delete GREETING from ' + (env === 'production' ? 'Production' : 'Preview') + '?',
        ),
      ).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
      await settle();
      expect(writes()).toHaveLength(4);
      expect(writes()[3]).toMatchObject({ method: 'DELETE' });
      expect(
        screen.getAllByTestId('environment-entry').map((li) => li.getAttribute('data-name')),
      ).toEqual(['API_KEY']);
      // No GET of the entries list after the first: every row came from a response.
      expect(
        routes.calls.filter((c) => c.method === 'GET' && c.url.endsWith('/entries')),
      ).toHaveLength(1);
    },
  );
});

describe('the Release tab', () => {
  it('is absent from the DOM unless showReleaseTab is true', async () => {
    await mount();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Production', 'Preview']);
    expect(screen.queryByRole('tab', { name: 'Release' })).toBeNull();
  });

  it('when shown, supports the same actions', async () => {
    await mount({ showReleaseTab: true });
    fireEvent.click(screen.getByRole('tab', { name: 'Release' }));
    await settle();
    expect(screen.getByText('No values in Release yet')).toBeTruthy();
    await add('GREETING', 'hello-release');
    expect(writes()[0]!.url).toContain('/environments/release/entries/GREETING');
    expect(rowNamed('GREETING').textContent).toContain('hello-release');
  });

  it('the delete confirmation names the other drawn tabs', async () => {
    routes.seed('repo-web', 'production', [plain('GREETING', 'hi')]);
    await mount({ showReleaseTab: true });
    fireEvent.click(screen.getByRole('button', { name: 'Delete GREETING' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Preview and Release keep their own values.');
  });
});

describe('tabs keyboard contract', () => {
  it('moves with the arrow keys, Home and End, with a roving tabindex', async () => {
    await mount({ showReleaseTab: true });
    const tab = (name: string) => screen.getByRole('tab', { name });
    expect(tab('Production').tabIndex).toBe(0);
    expect(tab('Preview').tabIndex).toBe(-1);
    fireEvent.keyDown(tab('Production'), { key: 'ArrowRight' });
    await settle();
    expect(tab('Preview').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('Preview'));
    fireEvent.keyDown(tab('Preview'), { key: 'End' });
    await settle();
    expect(tab('Release').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tab('Release'), { key: 'ArrowRight' });
    await settle();
    expect(tab('Production').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tab('Production'), { key: 'ArrowLeft' });
    await settle();
    expect(tab('Release').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tab('Release'), { key: 'Home' });
    await settle();
    expect(tab('Production').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab('Production').id);
  });
});

describe('a secret is never shown', () => {
  it('after a save, the value is nowhere in the DOM, any input, or any console line', async () => {
    await mount();
    await add('API_KEY', SECRET, true);

    expect(document.body.innerHTML).not.toContain(SECRET);
    for (const input of Array.from(document.querySelectorAll('input'))) {
      expect(input.value).not.toContain(SECRET);
      for (const attr of Array.from(input.attributes)) expect(attr.value).not.toContain(SECRET);
    }
    expect(consoleLines.join('\n')).not.toContain(SECRET);
    // The row is the Set display, with no dots or masked characters.
    const row = rowNamed('API_KEY');
    expect(row.textContent).toContain('Set');
    expect(row.textContent).toContain('Secret · value hidden');
    expect(row.textContent).not.toMatch(/[•*]{3,}/);
    expect(screen.getByTestId('environment-saved').textContent).toBe(
      'API_KEY saved as a secret. Its value is hidden from now on.',
    );
    // The add row is cleared.
    expect(valueField().value).toBe('');
    expect((nameField() as HTMLInputElement).value).toBe('');
  });

  it('the value field is a password input with autocomplete off while Secret is on', async () => {
    await mount();
    const toggle = screen.getByRole('switch', { name: 'Secret' });
    expect(valueField().type).toBe('text');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(valueField().type).toBe('password');
    expect(valueField().getAttribute('autocomplete')).toBe('off');
  });

  it('Replace opens an EMPTY write-only field, never prefilled; Escape cancels to Replace', async () => {
    routes.seed('repo-web', 'production', [secret('API_KEY')]);
    await mount();
    const replace = screen.getByRole('button', { name: 'Replace API_KEY' });
    fireEvent.click(replace);
    await settle();
    const field = screen.getByLabelText('New value for API_KEY') as HTMLInputElement;
    expect(field.value).toBe('');
    expect(field.type).toBe('password');
    expect(document.activeElement).toBe(field);
    expect(
      screen.getByText('The current value stays hidden. Saving replaces it on the next deploy.'),
    ).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Escape' });
    await settle();
    expect(screen.queryByLabelText('New value for API_KEY')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Replace API_KEY' }));

    fireEvent.click(screen.getByRole('button', { name: 'Replace API_KEY' }));
    await settle();
    const again = screen.getByLabelText('New value for API_KEY') as HTMLInputElement;
    fireEvent.change(again, { target: { value: SECRET } });
    fireEvent.click(within(again.closest('li')!).getByRole('button', { name: 'Save' }));
    await settle();
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0]!.body!)).toEqual({ value: SECRET, isSecret: true });
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(rowNamed('API_KEY').textContent).toContain('Set');
  });
});

describe('reserved and invalid names', () => {
  it.each([
    ['production', 'PORT'],
    ['preview', 'DATABASE_URL'],
    ['production', 'MOTIR_ANYTHING'],
    ['preview', 'MOTIR_ANYTHING'],
  ] as const)(
    'in %s, %s is refused inline, naming it, focused and described',
    async (env, name) => {
      await mount({ initialEnvironment: env });
      await add(name, 'x');
      const alert = screen.getByTestId('environment-add-error');
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent).toContain(name);
      expect(alert.textContent).toContain('is reserved');
      expect(nameField().getAttribute('aria-invalid')).toBe('true');
      expect(nameField().getAttribute('aria-describedby')).toBe(alert.id);
      expect(document.activeElement).toBe(nameField());
      expect(writes()).toHaveLength(0);
      expect(screen.queryAllByTestId('environment-entry')).toHaveLength(0);
    },
  );

  it('a reserved_environment_name answer from the route is shown the same way', async () => {
    routes.refuse('NEWLY_RESERVED');
    await mount();
    await add('NEWLY_RESERVED', 'x');
    expect(writes()).toHaveLength(1);
    const alert = screen.getByTestId('environment-add-error');
    expect(alert.textContent).toContain('NEWLY_RESERVED is reserved');
    expect(document.activeElement).toBe(nameField());
    expect(screen.queryAllByTestId('environment-entry')).toHaveLength(0);
  });

  it('an invalid name, an empty name and a duplicate show their own messages, adding nothing', async () => {
    routes.seed('repo-web', 'production', [plain('GREETING', 'hi')]);
    await mount();
    await add('1BAD-NAME', 'x');
    expect(screen.getByTestId('environment-add-error').textContent).toBe(
      'Use letters, digits and underscores, not starting with a digit.',
    );
    await add('', 'x');
    expect(screen.getByTestId('environment-add-error').textContent).toBe('Enter a name.');
    await add('GREETING', 'x');
    expect(screen.getByTestId('environment-add-error').textContent).toBe(
      'GREETING is already set in Production. Edit it in the list instead.',
    );
    expect(writes()).toHaveLength(0);
    expect(screen.getAllByTestId('environment-entry')).toHaveLength(1);
  });
});

describe('the states the design draws', () => {
  it('loading: a busy, polite region with the spinner line', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = routes.handler.getMockImplementation()!;
    routes.handler.mockImplementation(async (input: string, init?: RequestInit) => {
      await gate;
      return base(input, init);
    });
    renderWithIntl(
      <EnvironmentRoom
        projectKey="ACME"
        repositories={REPOS}
        initialRepositoryId="repo-web"
        initialEnvironment="production"
        canEdit
        showReleaseTab={false}
      />,
    );
    const loading = screen.getByTestId('environment-loading');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.textContent).toContain('Loading values…');
    release();
    await settle();
  });

  it('empty: the tab’s empty state with the add row', async () => {
    await mount();
    expect(screen.getByText('No values in Production yet')).toBeTruthy();
    expect(screen.getByText('Your live app gets these. Add the first one below.')).toBeTruthy();
    expect(screen.getByTestId('environment-add')).toBeTruthy();
    expect(
      screen.getByText(
        'No changes yet. Each change to this environment is listed here — who made it and when, never the value.',
      ),
    ).toBeTruthy();
  });

  it('error: the list error with Try again re-reads', async () => {
    routes.failNext('GET');
    await mount();
    expect(screen.getByText('Couldn’t load the values')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(screen.queryByText('Couldn’t load the values')).toBeNull();
    expect(screen.getByText('No values in Production yet')).toBeTruthy();
  });

  it('a failed save keeps the typed value and offers Try again; a failed delete says it is still set', async () => {
    routes.seed('repo-web', 'production', [plain('OLD_FLAG', '1')]);
    await mount();
    routes.failNext('PUT');
    await add('LOG_LEVEL', 'debug');
    const alert = screen.getByTestId('environment-row-error');
    expect(alert.textContent).toContain('Couldn’t save LOG_LEVEL. Nothing was changed.');
    expect(valueField().value).toBe('debug');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await settle();
    expect(rowNamed('LOG_LEVEL').textContent).toContain('debug');

    routes.failNext('DELETE');
    fireEvent.click(screen.getByRole('button', { name: 'Delete OLD_FLAG' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    await settle();
    expect(screen.getByTestId('environment-row-error').textContent).toContain(
      'Couldn’t delete OLD_FLAG. It is still set.',
    );
    expect(rowNamed('OLD_FLAG')).toBeTruthy();
  });

  it('saving: the saving row shows its spinner and Save its loading state', async () => {
    await mount();
    const release = routes.holdWrites();
    fireEvent.change(nameField(), { target: { value: 'GREETING' } });
    fireEvent.change(valueField(), { target: { value: 'hi' } });
    fireEvent.click(saveButton());
    await settle();
    expect(saveButton().getAttribute('aria-busy')).toBe('true');
    release();
    await settle();
    expect(rowNamed('GREETING')).toBeTruthy();
  });

  it('the delete confirmation is an alert dialog; Cancel deletes nothing', async () => {
    routes.seed('repo-web', 'production', [plain('GREETING', 'hi')]);
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Delete GREETING' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain(
      'The app stops receiving GREETING in Production on its next deploy. Preview keeps its own value. This cannot be undone.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(writes()).toHaveLength(0);
  });
});

describe('the read-only member', () => {
  it('sees the values and Set markers, the note, and every control disabled with its reason', async () => {
    routes.seed('repo-web', 'production', [secret('API_KEY'), plain('GREETING', 'hello-prod')]);
    await mount({ canEdit: false });
    expect(screen.getByRole('note').textContent).toBe(
      'You can read these values. Only project administrators can change them.',
    );
    expect(rowNamed('GREETING').textContent).toContain('hello-prod');
    expect(rowNamed('API_KEY').textContent).toContain('Set');
    for (const name of ['Replace API_KEY', 'Delete API_KEY', 'Edit GREETING', 'Delete GREETING']) {
      const button = screen.getByRole('button', { name });
      expect(button.getAttribute('aria-disabled')).toBe('true');
      // Focusable, so the tooltip is reachable by keyboard.
      expect(button.hasAttribute('disabled')).toBe(false);
    }
    const save = saveButton();
    expect(save.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Delete GREETING' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace API_KEY' }));
    fireEvent.change(nameField(), { target: { value: 'NEW' } });
    fireEvent.click(save);
    await settle();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByLabelText('New value for API_KEY')).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it('a 403 that arrives anyway turns the room read-only with the note', async () => {
    await mount();
    routes.failNext('PUT', 403);
    await add('GREETING', 'hi');
    expect(screen.getByRole('note').textContent).toContain('Only project administrators');
  });
});

describe('recent changes', () => {
  it('after an add, a replace and a delete, lists three rows — actor, action, entry, Secret — never a value', async () => {
    await mount();
    await add('API_KEY', SECRET, true);
    fireEvent.click(screen.getByRole('button', { name: 'Replace API_KEY' }));
    await settle();
    const field = screen.getByLabelText('New value for API_KEY');
    fireEvent.change(field, { target: { value: `${SECRET}-2` } });
    fireEvent.click(within(field.closest('li')!).getByRole('button', { name: 'Save' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Delete API_KEY' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    await settle();

    const rows = screen.getAllByTestId('environment-change');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/Ada Park.*deleted.*API_KEY.*Secret/),
      expect.stringMatching(/Ada Park.*replaced.*API_KEY.*Secret/),
      expect.stringMatching(/Ada Park.*added.*API_KEY.*Secret/),
    ]);
    const list = screen.getByTestId('environment-changes');
    expect(list.innerHTML).not.toContain(SECRET);
    expect(screen.getByRole('heading', { name: 'Recent changes · Production' })).toBeTruthy();
  });
});

describe('the repository selector', () => {
  it('offers only the repositories it is handed and switches the section', async () => {
    routes.seed('repo-api', 'production', [plain('API_ONLY', 'yes')]);
    await mount();
    expect(screen.getByText('No values in Production yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('combobox', { name: 'Repository' }));
    await settle();
    fireEvent.click(screen.getByRole('option', { name: /acme-api/ }));
    await settle();
    expect(rowNamed('API_ONLY').textContent).toContain('yes');
    expect(window.location.search).toContain('repository=repo-api');
  });
});
