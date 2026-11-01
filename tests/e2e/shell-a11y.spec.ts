// Accessibility audit for the app shell (Subtask 1.5.5).
//
// Locks in the shell's a11y properties BEFORE any Epic-2-7 surface inherits
// them: an automated axe-core sweep of every shell-bearing route, the core
// create/edit/detail surfaces, plus the landmark/aria assertions the shell's
// structure guarantees. Future a11y Subtasks for Epic-2-7 surfaces extend the
// route list + docs/a11y/shell-audit.md.
//
// This file was split out of the original 16-test shell-a11y.spec.ts so
// Playwright's file-level CI sharding can spread the axe sweeps across legs
// instead of pinning them all into one shard (the bulk-3 long-pole):
//   • shell-a11y.spec.ts         — this file: shell routes + core CRUD + aria
//   • shell-a11y-tokens.spec.ts  — the public /tokens specimen sweeps (no DB)
//   • shell-a11y-detail.spec.ts  — the heavy populated detail/comments/activity
//                                  /attachments sweeps (server-side seeding)
// The shared WCAG_TAGS / formatViolations / AxeViolation live in _helpers/a11y.
//
// Layered with shell-keyboard.spec.ts (keyboard-only navigation) — this spec
// is invariant-driven (zero violations, correct landmarks); that one is
// journey-driven (tab → skip-link → ⌘K → navigate → ⌘\ → ?).
//
// axe runs WCAG 2.1 A + AA. On a violation the spec prints the rule id, help
// URL, and the offending selector(s) so CI surfaces exactly what failed and
// where — see formatViolations.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, createFirstProject } from './_helpers/shell-session';
import { WCAG_TAGS, formatViolations, type AxeViolation } from './_helpers/a11y';

const USER_EMAIL = 'e2e-shell-a11y@example.com';

// The shell-bearing routes. /dashboard, /items, /boards, /reports are
// project-scoped (need an active project for the sidebar project-nav to
// render); the two settings routes render under the same shell. `ready` is a
// per-route settle anchor so axe analyses a fully-painted DOM, not a mid-render
// frame.
const SHELL_ROUTES: { path: string; ready: (page: Page) => Promise<void> }[] = [
  {
    path: '/dashboard',
    ready: async (page) => expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible(),
  },
  {
    path: '/items',
    // The sweep's user has a project but no issues → the real route renders its
    // empty state inside a Suspense boundary. Wait for BOTH the page h1 (level:1
    // — the empty-state h2 "No issues yet" substring-matches a bare name:'Work Items')
    // AND the resolved empty state, so axe analyses the settled DOM, not a
    // mid-stream frame. (2.5.6 adds the POPULATED /items sweep with a fixture.)
    ready: async (page) => {
      await expect(page.getByRole('heading', { name: 'Work Items', level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'No work items yet' })).toBeVisible();
    },
  },
  {
    path: '/boards',
    ready: async (page) => expect(page.getByRole('heading', { name: 'Boards' })).toBeVisible(),
  },
  {
    path: '/reports',
    ready: async (page) => expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible(),
  },
  {
    // The Code room (MOTIR-1768) — the project's repository set and its index
    // freshness, with the shipped code-health audit as its second section.
    //
    // ⚠️ SWEPT AS A MEMBER-REACHABLE ROOM, which is the property that makes the
    // collapse legal (design/code-context §2.1). This sweep's user is browsing a
    // fresh project, so what axe analyses is the Repositories section's empty
    // state and the section switch — the two things every reader meets first,
    // and the two the old `/code-health` route never rendered for them at all,
    // because it refused them outright.
    path: '/code',
    ready: async (page) =>
      expect(page.getByRole('heading', { name: 'Codebase', level: 1 })).toBeVisible(),
  },
  {
    // ⚠️ `/settings/organization`, not `/settings/workspace` (MOTIR-3502 ·
    // organization-tier.md §6d). This sweep signs up a fresh user, who gets ONE
    // auto-created workspace — the COLLAPSED state, in which the workspace area
    // 404s and its Name / Members / Danger-zone sections are hosted here
    // instead. So this entry sweeps strictly MORE markup than it used to: the
    // org-scoped cards plus the three folded-in workspace cards.
    //
    // ⚠️ THE OPERATOR DASHBOARD WAS SWEPT HERE from Story MOTIR-4843 · MOTIR-4861
    // until Story MOTIR-9982 retired it: the tenant Job runs section left this
    // page with the tenant Job runs route, and the ledger is staff-only at
    // `/admin/jobs`. Neither tenant address returns to this list.
    path: '/settings/organization',
    ready: async (page) =>
      expect(page.getByRole('heading', { name: 'Organization settings' })).toBeVisible(),
  },
  {
    path: '/settings/project',
    ready: async (page) =>
      expect(page.getByRole('heading', { name: 'Details', exact: true })).toBeVisible(),
  },
  {
    // Workflow editor (Subtask 2.2.5). Swept against a fresh project's default
    // seed (the six default statuses) — STRICT, zero exclusions: the category
    // Pills (todo/in_progress/done) are AA-safe (PRODECT_FINDINGS #35 resolved),
    // the transition matrix is a semantic <table> of aria-checkbox cells, the
    // policy control is a labelled aria-pressed segmented group.
    path: '/settings/project/workflow',
    ready: async (page) =>
      expect(page.getByRole('heading', { name: 'Workflow', exact: true })).toBeVisible(),
  },
  {
    // Custom-fields admin (Subtask 5.3.6). Swept in its EMPTY state (a fresh
    // project defines no custom fields) — STRICT, zero exclusions: the
    // EmptyState CTA is a real button, the page heading is the h1, and the
    // populated list's editors are covered by the 5.3.8 story sweep.
    path: '/settings/project/fields',
    ready: async (page) =>
      expect(page.getByRole('heading', { name: 'Fields', exact: true })).toBeVisible(),
  },
];

// Each test signs up a fresh user, creates a project, then sweeps several
// routes running axe on each — heavier than the 30s default. Raise the ceiling
// so a cold-compiled route or a slow argon2 sign-up doesn't time out.
test.describe.configure({ timeout: 90_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test.describe('@a11y shell accessibility', () => {
  test('every shell-bearing route has zero axe violations (WCAG 2.1 AA)', async ({ page }) => {
    await signUp(page, USER_EMAIL);
    await createFirstProject(page, 'Mobile App');

    for (const route of SHELL_ROUTES) {
      await page.goto(route.path);
      await route.ready(page);

      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(
        results.violations,
        formatViolations(route.path, results.violations as AxeViolation[]),
      ).toEqual([]);
    }
  });

  // Create-issue modal (Subtask 2.3.3) + the Type/Parent pickers (2.3.4), swept
  // in their open state. STRICT, zero exclusions: Radix wires the dialog focus
  // trap + accessible name; each field has a label; the Combobox uses the
  // WAI-ARIA listbox-combobox shape (role="combobox" trigger → role="listbox" of
  // role="option" rows, aria-activedescendant). Swept twice — modal alone, then
  // with the Type listbox expanded — so the open listbox is audited too.
  test('the create-issue modal + type/parent pickers have zero axe violations (WCAG 2.1 AA)', async ({
    page,
  }) => {
    await signUp(page, 'e2e-create-issue-a11y@example.com');
    await createFirstProject(page, 'Mobile App');
    await page.goto('/items');

    await page.getByRole('button', { name: 'Create work item' }).click();
    await expect(page.getByRole('heading', { name: 'Create work item' })).toBeVisible();
    // The real MarkdownEditor (2.3.10: a Tiptap WYSIWYG) — wait for its
    // contenteditable to mount, then exclude only the third-party `.ProseMirror`
    // surface. Our own toolbar (labelled buttons) + label + notice stay swept.
    await expect(page.locator('.ProseMirror').first()).toBeVisible();

    const modalResults = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .exclude('.ProseMirror')
      .analyze();
    expect(
      modalResults.violations,
      formatViolations('/items (create-issue modal)', modalResults.violations as AxeViolation[]),
    ).toEqual([]);

    // Open the Type picker so the expanded listbox is in the swept DOM.
    // `exact` so it's the KIND picker ("Type"), not the new "Work type"
    // combobox (2.7.4) — Playwright's accessible-name match is substring.
    await page.getByRole('combobox', { name: 'Type', exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Type', exact: true })).toBeVisible();

    const listboxResults = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .exclude('.ProseMirror')
      .analyze();
    expect(
      listboxResults.violations,
      formatViolations('/items (type picker open)', listboxResults.violations as AxeViolation[]),
    ).toEqual([]);
  });

  // The issue edit route (Subtask 2.3.6). Creates a project + an issue (via the
  // create modal, reading its identifier off the success toast), then sweeps the
  // /items/[key]/edit page. STRICT — only the third-party `.ProseMirror`
  // contenteditable is excluded; the editor's own toolbar + the form's controls
  // + the Status/Parent/Assignee comboboxes are held to full AA.
  test('the issue edit route has zero axe violations (WCAG 2.1 AA; third-party editor chrome excluded)', async ({
    page,
  }) => {
    await signUp(page, 'e2e-edit-issue-a11y@example.com');
    await createFirstProject(page, 'Mobile App');

    await page.goto('/items');
    await page.getByRole('button', { name: 'Create work item' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill('Editable issue');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    const toast = page.getByText(/^\S+ created$/);
    await expect(toast).toBeVisible();
    const identifier = ((await toast.textContent()) ?? '').replace(/ created$/, '').trim();
    expect(identifier).toMatch(/^[A-Z]+-\d+$/);

    await page.goto(`/items/${identifier}/edit`);
    await expect(page.getByRole('heading', { name: 'Edit work item' })).toBeVisible();
    // Wait for the Tiptap editor's contenteditable to mount before sweeping.
    await expect(page.locator('.ProseMirror').first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .exclude('.ProseMirror')
      .analyze();
    expect(
      results.violations,
      formatViolations('/items/[key]/edit', results.violations as AxeViolation[]),
    ).toEqual([]);
  });

  // The issue DETAIL route (Subtask 2.4.2) with content populated: the rendered
  // description + explanation + the core-fields metadata panel. STRICT, zero
  // exclusions — unlike the edit route there is NO `@uiw/react-md-editor` on the
  // page (the detail page renders read-only Markdown via MarkdownView, not the
  // editor), so the whole DOM is held to full WCAG 2.1 AA.
  test('the issue detail route has zero axe violations (WCAG 2.1 AA; content populated)', async ({
    page,
  }) => {
    await signUp(page, 'e2e-detail-issue-a11y@example.com');
    await createFirstProject(page, 'Mobile App');

    await page.goto('/items');
    await page.getByRole('button', { name: 'Create work item' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill('Detail-view issue');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    const toast = page.getByText(/^\S+ created$/);
    await expect(toast).toBeVisible();
    const identifier = ((await toast.textContent()) ?? '').replace(/ created$/, '').trim();
    expect(identifier).toMatch(/^[A-Z]+-\d+$/);

    await page.goto(`/items/${identifier}`);
    await expect(page.getByRole('heading', { name: 'Detail-view issue' })).toBeVisible();
    // The metadata rail (its field boxes) is part of the populated content the
    // sweep must cover — wait for a field label to confirm it has rendered.
    await expect(page.getByText('Reporter')).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(
      results.violations,
      formatViolations('/items/[key]', results.violations as AxeViolation[]),
    ).toEqual([]);
  });

  // The issue detail route with the LINK-MANAGEMENT add form open (Subtask
  // 2.4.9, swept here as part of the 2.4.6 Story closer). The card's AC: the
  // /items/[key] route stays in the STRICT sweep "INCLUDING the open add-link
  // combobox/dialog". STRICT — zero exclusions (no third-party editor on the
  // detail page). Opens the "+ Link issue" form, then expands the Relationship
  // listbox so the WAI-ARIA listbox-combobox (role="combobox" → role="listbox"
  // of role="option" rows) is audited in its open state, mirroring the
  // create-modal type-picker-open sweep above.
  test('the issue detail route is axe-clean with the add-link form open (WCAG 2.1 AA; strict)', async ({
    page,
  }) => {
    await signUp(page, 'e2e-detail-addlink-a11y@example.com');
    await createFirstProject(page, 'Mobile App');

    await page.goto('/items');
    await page.getByRole('button', { name: 'Create work item' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill('Linkable issue');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    const toast = page.getByText(/^\S+ created$/);
    await expect(toast).toBeVisible();
    const identifier = ((await toast.textContent()) ?? '').replace(/ created$/, '').trim();
    expect(identifier).toMatch(/^[A-Z]+-\d+$/);

    await page.goto(`/items/${identifier}`);
    await expect(page.getByRole('heading', { name: 'Linkable issue', level: 1 })).toBeVisible();

    // Open the add-link form, then expand the Relationship listbox.
    await page.getByRole('button', { name: 'Link work item' }).click();
    await expect(page.getByRole('combobox', { name: 'Work item to link' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Relationship' }).click();
    await expect(page.getByRole('listbox', { name: 'Relationship' })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(
      results.violations,
      formatViolations('/items/[key] (add-link form open)', results.violations as AxeViolation[]),
    ).toEqual([]);
  });

  // Structural aria assertions — the contract every shell surface inherits.
  // Kept here (not only in the keyboard spec) so the invariants are asserted
  // even if the journey spec is skipped/filtered.
  test('shell landmarks + aria states are correctly wired', async ({ page }) => {
    await signUp(page, 'e2e-shell-a11y-aria@example.com');
    await createFirstProject(page, 'Mobile App');
    await page.goto('/items');

    // Two distinctly-named nav landmarks: the global top bar + the primary rail.
    await expect(page.getByRole('navigation', { name: 'Global' })).toBeVisible();
    const rail = page.getByRole('navigation', { name: 'Primary' });
    await expect(rail).toBeVisible();

    // aria-current="page" tracks the active route — Issues here, Dashboard not.
    await expect(rail.getByRole('link', { name: 'Work Items' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(rail.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );

    // The collapse toggle is a disclosure control: aria-expanded reflects the
    // rail state (expanded by default → true).
    const collapseToggle = rail.getByRole('button', { name: 'Collapse sidebar' });
    await expect(collapseToggle).toHaveAttribute('aria-expanded', 'true');
  });
});
