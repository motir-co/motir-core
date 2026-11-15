// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PublicAddressDoorCard } from '@/app/(authed)/settings/organization/_components/PublicAddressDoorCard';

// THE PUBLIC ADDRESS DOOR on Organisation settings (Story MOTIR-4528 ·
// MOTIR-9514), and its link text for a workspace with no Motir repository (ADR
// §8 AMENDMENT 5 · MOTIR-11287): it names the reason page instead of inviting a
// claim the pane would refuse.

afterEach(cleanup);

const link = () => screen.getByRole('link');

describe('the Public address door card', () => {
  it('no name, eligible (the default): “Claim a name →”', () => {
    renderWithIntl(<PublicAddressDoorCard hostname={null} />);
    expect(screen.getByText('No name claimed yet.')).toBeTruthy();
    expect(link().textContent).toBe('Claim a name →');
    expect(link().getAttribute('href')).toBe('/settings/workspace/public-address');
  });

  it('no name, not eligible: “Why there’s no name →”, the same door', () => {
    renderWithIntl(<PublicAddressDoorCard hostname={null} eligible={false} />);
    expect(screen.getByText('No name claimed yet.')).toBeTruthy();
    expect(link().textContent).toBe('Why there’s no name →');
    expect(link().getAttribute('href')).toBe('/settings/workspace/public-address');
  });

  it('a name held: “Manage →” whatever the eligibility', () => {
    renderWithIntl(<PublicAddressDoorCard hostname="acme.motir.site" eligible={false} />);
    expect(screen.getByText('acme.motir.site — one name for the workspace.')).toBeTruthy();
    expect(link().textContent).toBe('Manage →');
  });
});
