import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as plannerFindingsService from '@/lib/services/plannerFindingsService';

// THE RECORDS LEVEL IS SINGLE-SOURCED AND SET PER ROUTE (Story MOTIR-11455 ·
// MOTIR-11458 · `docs/decisions/platform-staff-auth.md` §2, the 2026-11-16
// amendment).
//
// A route's level is ONE argument at the gate and ONE constant at the service,
// so the two cannot disagree. This file is what keeps that true: every gate call
// under `app/api/platform/planner-findings/**` (found by scanning, not by a hand
// list) must pass a named level constant exported by the records service, never
// a literal, and every write must ask for `operator`. Narrowing or widening one
// route is then a change to one argument and one constant.

const ROOT = process.cwd();
const ROUTES_DIR = path.join(ROOT, 'app/api/platform/planner-findings');
const SERVICE = path.join(ROOT, 'lib/services/plannerFindingsService.ts');

/** The level constants a planner-findings handler may pass. Each is exported by the service. */
const LEVEL_CONSTANTS = Object.keys(plannerFindingsService).filter((name) =>
  /^PLANNER_FINDING_RECORDS(_[A-Z]+)*_LEVEL$/.test(name),
);

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === 'route.ts' ? [full] : [];
  });
}

interface HandlerGate {
  file: string;
  method: string;
  level: string;
}

/** Each exported handler in a route file and the level its gate call passes. */
function handlerGates(file: string): HandlerGate[] {
  const source = readFileSync(file, 'utf8');
  const handlers = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)];
  return handlers.map((match, i) => {
    const body = source.slice(match.index, handlers[i + 1]?.index ?? source.length);
    const calls = [
      ...body.matchAll(
        /requirePlatformStaffForPlannerFindings\(\s*req\s*,\s*([^,)\s]+)\s*,?\s*\)/g,
      ),
    ];
    expect(
      calls,
      `${path.relative(ROOT, file)} ${match[1]} calls the gate exactly once`,
    ).toHaveLength(1);
    return { file: path.relative(ROOT, file), method: match[1]!, level: calls[0]![1]! };
  });
}

const GATES = routeFiles(ROUTES_DIR).flatMap(handlerGates);

describe('the planner-findings records level', () => {
  it('scans every handler of the door', () => {
    // The five handlers MOTIR-11458 ships and the two key writes MOTIR-11590 adds;
    // a card that adds a route adds to this floor.
    expect(GATES.length).toBeGreaterThanOrEqual(7);
    expect(LEVEL_CONSTANTS).toContain('PLANNER_FINDING_RECORDS_LEVEL');
  });

  it.each(GATES.map((g) => [`${g.method} ${g.file}`, g]))(
    '%s passes a named level constant, never a literal',
    (_label, gate) => {
      expect(LEVEL_CONSTANTS).toContain((gate as HandlerGate).level);
    },
  );

  it('every write route asks for operator', () => {
    const writes = GATES.filter((g) => g.method !== 'GET');
    expect(writes.length).toBeGreaterThan(0);
    for (const gate of writes) {
      const value = (plannerFindingsService as Record<string, unknown>)[gate.level];
      expect(value, `${gate.method} ${gate.file}`).toBe('operator');
    }
  });

  it('the records level is written once: no level literal in the service checks', () => {
    const source = readFileSync(SERVICE, 'utf8');
    const checks = [
      ...source.matchAll(/platformRoleAtLeast\(\s*[^,]+,\s*([^,)\s]+)\s*,?\s*\)/g),
    ].map((m) => m[1]);
    expect(checks.length).toBeGreaterThan(0);
    for (const level of checks) expect(LEVEL_CONSTANTS).toContain(level);
    expect(plannerFindingsService.PLANNER_FINDING_RECORDS_LEVEL).toBe('operator');
  });
});
