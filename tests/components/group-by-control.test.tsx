// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { GroupByControl } from '@/app/(authed)/boards/_components/GroupByControl';
import type { BoardSwimlaneGroupByDto } from '@/lib/dto/boards';

// The board header's group-by trigger and menu (MOTIR-11451, design MOTIR-11443
// panels 1–2), rendered with the real `en` catalogue. The menu is a Radix popover
// portaled to <body>, so its rows are read from `screen`, never from the group.

afterEach(cleanup);

function renderControl(
  props: Partial<{
    value: BoardSwimlaneGroupByDto;
    disabled: boolean;
    readOnlyReason: string;
    onChange: (v: BoardSwimlaneGroupByDto) => void;
  }> = {},
) {
  const onChange = props.onChange ?? vi.fn();
  const utils = render(
    <GroupByControl
      value={props.value ?? 'assignee'}
      onChange={onChange}
      disabled={props.disabled ?? false}
      readOnlyReason={props.readOnlyReason}
    />,
  );
  return { ...utils, onChange };
}

const group = () => screen.getByRole('group', { name: 'Swimlane group by' });
const trigger = () => within(group()).getByRole('button') as HTMLButtonElement;
const openMenu = () => {
  fireEvent.click(trigger());
  return screen.getByRole('menu', { name: 'Group by' });
};

describe('GroupByControl', () => {
  it('names the group and announces the current dimension on the trigger itself', () => {
    renderControl({ value: 'epic' });
    expect(trigger().textContent).toBe('Group by Epic');
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens a menu of all four dimensions in order, the active one checked', () => {
    renderControl({ value: 'assignee' });
    const menu = openMenu();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    const rows = within(menu).getAllByRole('menuitemradio');
    expect(rows.map((r) => r.textContent)).toEqual(['None', 'Assignee', 'Epic', 'Priority']);
    expect(rows.map((r) => r.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
  });

  it('calls the change callback exactly once with a different dimension, then closes', () => {
    const { onChange } = renderControl({ value: 'assignee' });
    fireEvent.click(within(openMenu()).getByRole('menuitemradio', { name: 'Priority' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('priority');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('calls nothing when the active dimension is chosen', () => {
    const { onChange } = renderControl({ value: 'none' });
    fireEvent.click(within(openMenu()).getByRole('menuitemradio', { name: 'None' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('renders the value it is handed, never a choice nobody persisted', () => {
    const { onChange, rerender } = renderControl({ value: 'assignee' });
    fireEvent.click(within(openMenu()).getByRole('menuitemradio', { name: 'Epic' }));
    expect(onChange).toHaveBeenCalledWith('epic');
    // The write was refused: the container keeps handing the previous value.
    expect(trigger().textContent).toBe('Group by Assignee');
    rerender(<GroupByControl value="epic" onChange={onChange} disabled={false} />);
    expect(trigger().textContent).toBe('Group by Epic');
  });

  it('closes on Escape and hands focus back to the trigger', async () => {
    renderControl();
    trigger().focus();
    const menu = openMenu();
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it('is inert and busy while a change re-lays, at the previous dimension', () => {
    const { onChange } = renderControl({ value: 'priority', disabled: true });
    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute('aria-busy')).toBe('true');
    expect(trigger().textContent).toBe('Group by Priority');
    fireEvent.click(trigger());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is read-only with its reason in the accessibility tree behind a focus stop', () => {
    const reason = 'Only a board admin can change the grouping';
    const { onChange } = renderControl({ readOnlyReason: reason });
    const g = group();
    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute('aria-busy')).toBeNull();
    expect(
      within(g)
        .getAllByRole('button')
        .every((b) => (b as HTMLButtonElement).disabled),
    ).toBe(true);
    expect(g.getAttribute('tabindex')).toBe('0');
    const describedBy = g.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toBe(reason);
    g.focus();
    expect(document.activeElement).toBe(g);
    fireEvent.click(trigger());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps an editable control off the tab order except through its trigger', () => {
    renderControl();
    expect(group().getAttribute('tabindex')).toBeNull();
    expect(group().getAttribute('aria-describedby')).toBeNull();
    expect(trigger().disabled).toBe(false);
  });
});
