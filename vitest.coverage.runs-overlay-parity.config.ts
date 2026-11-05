import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Coverage for THE RUN OVERLAY WORKS LIKE THE PLAN OVERLAY, AND THE RUNS LIST NAMES
// EACH RUN'S TARGET — Story MOTIR-8982's integration gate, MOTIR-9075: a draggable
// split, wrapped agent output, Close/Esc at top left, a List | Canvas left pane and
// a Target column in place of Command and Scope.
//
// ⚠️ WHAT A FLOOR IS FOR HERE. Whether the assembled seams are right is
// `tests/integration/runs/runOverlayParityGate.test.tsx`'s question (a real row to
// the rendered Target cell, real legs to the real console, the split's polarity and
// the wrap chain with the overlay's own wrappers). What a floor catches is what that
// cannot: a LATER change that deletes a branch's only test and leaves the branch.
//
// ⚠️ GATED: the files the story CREATED, PER FILE, at the MEASURED reading over this
// lane's suites, rounded DOWN. A RATCHET. CI: the `story-8982-coverage` job, which
// needs Postgres (the gate reads real rows).
//
// ⚠️ REPORTED, NOT GATED: the shared files the story CHANGED (the
// `vitest.coverage.plan-overlay-only.config.ts` precedent). A whole-file floor on
// them would measure other stories' lines.
//
// ⚠️ ROUTE GROUPS AND DYNAMIC SEGMENTS ARE MATCHED WITH `*` / `**`, NEVER THE
// LITERAL `(authed)` or `[key]` (MOTIR-2449: both are glob syntax to the matcher).

const FULL = { statements: 100, branches: 100, functions: 100, lines: 100 };

const CREATED = [
  'components/split/ResizableSplit.tsx',
  'components/split/SplitDivider.tsx',
  'lib/hooks/usePersistedPaneWidth.ts',
  'components/ui/OverlayExitButton.tsx',
  'app/**/runs/_components/runFrameRows.ts',
  'lib/runs/legLabel.ts',
  'app/**/runs/_components/RunSetListPane.tsx',
  'app/**/runs/_components/useRunSetLevel.ts',
];

const SHARED = [
  'app/**/runs/_components/RunsIndex.tsx',
  'app/**/runs/_components/RunModal.tsx',
  'app/**/runs/_components/RunLogPane.tsx',
  'app/**/runs/_components/RunCanvasPane.tsx',
  'lib/mappers/dispatchRunMappers.ts',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // The story gate (MOTIR-9075) — first.
      'tests/integration/runs/runOverlayParityGate.test.tsx',
      // Each code card's own suite (MOTIR-9068 · 9069 · 9070 · 9071 · 9072 · 9073 · 9074).
      'tests/components/resizable-split.test.tsx',
      'tests/components/planning-resizable-split.test.tsx',
      'tests/components/overlay-exit-button.test.tsx',
      'tests/components/run-modal-split.test.tsx',
      'tests/components/RunModal.test.tsx',
      'tests/components/RunsIndex.test.tsx',
      'tests/components/RunSetListPane.test.tsx',
      'tests/components/RunLogPane.test.tsx',
      'tests/components/RunCanvasPane.test.tsx',
      'tests/dispatchRunProjectHistory.test.ts',
      // The shared read's branches, each driven by a held promise (MOTIR-10432):
      // the gate above reaches the `live === false` arm only by timing.
      'tests/components/useRunSetLevel.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      all: true,
      include: [...CREATED, ...SHARED],
      // PER FILE, MEASURED 2026-10-19 at MOTIR-9075 over this lane's suites with
      // `pnpm coverage:runs-overlay-parity` (statements / branches / functions /
      // lines), rounded DOWN:
      //
      //   ResizableSplit.tsx        91.86 / 80.89 / 93.33 / 98.09
      //   SplitDivider.tsx          100 / 100 / 100 / 100
      //   usePersistedPaneWidth.ts  92.45 / 77.27 / 93.33 / 95.23
      //   OverlayExitButton.tsx, runFrameRows.ts, legLabel.ts, RunSetListPane.tsx,
      //   useRunSetLevel.ts         100 / 100 / 100 / 100
      //
      // ⚠️ TWO FILES SIT BELOW THE 90 FLOOR ON BRANCHES, and are gated at their
      // measurement rather than the floor: what is uncovered is the environment
      // guards no test environment reaches (`ResizeObserver` absent, `localStorage`
      // throwing, the server snapshot), not behaviour. A drop below the reading is
      // still caught.
      thresholds: {
        'components/split/ResizableSplit.tsx': {
          statements: 91,
          branches: 80,
          functions: 93,
          lines: 98,
        },
        'components/split/SplitDivider.tsx': FULL,
        'lib/hooks/usePersistedPaneWidth.ts': {
          statements: 92,
          branches: 77,
          functions: 93,
          lines: 95,
        },
        'components/ui/OverlayExitButton.tsx': FULL,
        'app/**/runs/_components/runFrameRows.ts': FULL,
        'lib/runs/legLabel.ts': FULL,
        'app/**/runs/_components/RunSetListPane.tsx': FULL,
        'app/**/runs/_components/useRunSetLevel.ts': FULL,
      },
    },
  },
});
