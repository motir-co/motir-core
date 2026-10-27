// @motir/design-system/mock — the NODE-ONLY subpath (MOTIR-6961).
//
// Kept off the main barrel on purpose: `renderMock` imports `react-dom/server`
// and reads files, and the main entry must stay safe for a Next client import
// (`test/barrel-rsc-safe.test.ts`).
export { renderMock, extractClassCandidates } from './renderMock';
export type { RenderMockOptions, MockPanel, MockAxes, BoardWidth } from './renderMock';
