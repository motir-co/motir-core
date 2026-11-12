import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@/lib/permissions/catalog';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS, toolPermission } from '@/lib/mcp/toolPermissions';

// The tool → permission map and the CLI's fixed grant, for the rows a card adds
// (MOTIR-11038 first). The map's totality is the type; the GRANT's shape is not,
// so what a widening must hold is asserted here.

describe('TOOL_PERMISSIONS', () => {
  it('gates create_project_repository on the key the repository-set service asserts', () => {
    expect(TOOL_PERMISSIONS.create_project_repository).toBe('repository:manage');
    expect(toolPermission('create_project_repository')).toBe('repository:manage');
  });

  it('is the ONLY tool asserting repository:manage — the measured blast radius', () => {
    const holders = Object.entries(TOOL_PERMISSIONS)
      .filter(([, key]) => key === 'repository:manage')
      .map(([name]) => name);
    expect(holders).toEqual(['create_project_repository']);
  });
});

describe('CLI_TOKEN_GRANT', () => {
  it('carries repository:manage exactly once', () => {
    expect(CLI_TOKEN_GRANT.filter((k) => k === 'repository:manage')).toHaveLength(1);
  });

  it('is declared in catalog order, which the device flow’s scope string relies on', () => {
    const order = PERMISSIONS.filter((k) => CLI_TOKEN_GRANT.includes(k));
    expect([...CLI_TOKEN_GRANT]).toEqual(order);
  });

  it('still withholds the irreversible and the unattended-unsafe keys', () => {
    for (const key of [
      'work_item:delete',
      'work_item:archive',
      'page:delete',
      'sprint:manage',
    ] as const) {
      expect(CLI_TOKEN_GRANT).not.toContain(key);
    }
  });
});
