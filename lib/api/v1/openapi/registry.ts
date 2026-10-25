import type { z } from 'zod/v4';
import { FOLDER_COMPONENTS, FOLDER_OPERATIONS } from '@/lib/api/v1/folders/operations';
import { operationKey, type V1Operation } from '@/lib/api/v1/openapi/operation';
import { PAGE_COMPONENTS, PAGE_OPERATIONS } from '@/lib/api/v1/pages/operations';
import { PLANNING_COMPONENTS, PLANNING_OPERATIONS } from '@/lib/api/v1/planning/operations';
import {
  WORK_ITEM_COMPONENTS,
  WORK_ITEM_OPERATIONS,
  WORK_ITEM_SHARED_SCHEMAS,
} from '@/lib/api/v1/workItems/operations';
import {
  SECTION_SET_COMPONENTS,
  SECTION_SET_OPERATIONS,
} from '@/lib/api/v1/sectionSets/operations';
import { WORK_LOOP_COMPONENTS, WORK_LOOP_OPERATIONS } from '@/lib/api/v1/workLoop/operations';

// The v1 OPERATION REGISTRY (Story 11.4 · Subtask 11.4.4 — MOTIR-2185).
//
// One assembly point over the per-resource `operations.ts` modules — the shape
// ADR Amendment 4 Q2 pins, and the same one `lib/mcp/registry.ts` uses for MCP
// tools: the declarations live with the thing they describe, and exactly one
// value knows the whole set.
//
// COMPLETE as of Subtask 11.4.5: the work-item resource (11.4.4's proving
// resource) plus identity, workspaces, projects, sprints, the backlog, the
// membership moves and the ready set. `tests/api/v1/openapi-operations-coverage.test.ts`
// WALKS `app/api/v1` and fails on any exported method with no declaration, so
// this list cannot fall behind a route added later — which is the property
// Subtask 11.4.6 turns into the full route↔spec drift guard.

/** What one per-resource `operations.ts` module contributes. */
export interface V1ResourceModule {
  operations: readonly V1Operation[];
  components: Readonly<Record<string, z.ZodType>>;
  /**
   * Named FIELD VOCABULARIES (an enum, say) this resource contributes — emitted
   * as one component each and `$ref`ed from every schema that embeds the same
   * instance (MOTIR-6581). Kept apart from `components` because those are the
   * SHARED RESOURCES the MCP payload guard derives from, and a vocabulary is not
   * a resource.
   */
  sharedSchemas?: Readonly<Record<string, z.ZodType>>;
}

/** Every resource module contributing to the document. */
const RESOURCE_MODULES: readonly V1ResourceModule[] = [
  {
    operations: WORK_ITEM_OPERATIONS,
    components: WORK_ITEM_COMPONENTS,
    sharedSchemas: WORK_ITEM_SHARED_SCHEMAS,
  },
  { operations: PLANNING_OPERATIONS, components: PLANNING_COMPONENTS },
  // Story 11.7's work-loop resources. It grows one entry per endpoint card, in
  // step with the routes — see the module header for why a declaration cannot
  // land ahead of its route.
  { operations: WORK_LOOP_OPERATIONS, components: WORK_LOOP_COMPONENTS },
  // Story MOTIR-5310's folder resource (MOTIR-5408).
  { operations: FOLDER_OPERATIONS, components: FOLDER_COMPONENTS },
  // Story MOTIR-9023's section sets read (MOTIR-9029).
  { operations: SECTION_SET_OPERATIONS, components: SECTION_SET_COMPONENTS },
  // Story MOTIR-9486's page resource (MOTIR-9493).
  { operations: PAGE_OPERATIONS, components: PAGE_COMPONENTS },
];

/**
 * Key the operations by `` `${METHOD} ${path}` ``, REFUSING a duplicate.
 *
 * Exported and pure so the refusal can be driven with a duplicate, the way
 * `tests/helpers/v1RouteAudit.ts`'s rules are driven with a violating source:
 * two modules claiming one operation is a real mistake (a resource moved and
 * its old declaration stayed), and a silent last-wins `Map.set` would hide it
 * behind a document that still looks complete.
 */
export function buildOperationRegistry(
  operations: readonly V1Operation[],
): ReadonlyMap<string, V1Operation> {
  const registry = new Map<string, V1Operation>();
  for (const operation of operations) {
    const key = operationKey(operation);
    if (registry.has(key)) {
      throw new Error(`duplicate v1 operation declared: ${key}`);
    }
    registry.set(key, operation);
  }
  return registry;
}

/**
 * Merge the modules' component schemas, REFUSING a duplicate NAME.
 *
 * Same discipline, sharper reason: two resources declaring different shapes
 * under one component name would emit a document in which one of them is
 * silently wrong — and `$ref` makes that wrongness invisible at every use site.
 */
export function mergeResourceComponents(
  modules: readonly V1ResourceModule[],
): Readonly<Record<string, z.ZodType>> {
  const components: Record<string, z.ZodType> = {};
  for (const resource of modules) {
    for (const [name, schema] of Object.entries(resource.components)) {
      if (name in components) {
        throw new Error(`duplicate v1 component schema declared: ${name}`);
      }
      components[name] = schema;
    }
  }
  return components;
}

/**
 * Merge the modules' SHARED schemas, REFUSING a duplicate name — against each
 * other AND against the resource components, since both land in one
 * `components.schemas` map — and a schema instance registered twice, since the
 * emitter resolves a `$ref` by instance.
 */
export function mergeSharedSchemas(
  modules: readonly V1ResourceModule[],
): ReadonlyMap<z.ZodType, string> {
  const resourceNames = new Set(modules.flatMap((resource) => Object.keys(resource.components)));
  const byName = new Set<string>();
  const byInstance = new Map<z.ZodType, string>();
  for (const resource of modules) {
    for (const [name, schema] of Object.entries(resource.sharedSchemas ?? {})) {
      if (byName.has(name) || resourceNames.has(name)) {
        throw new Error(`duplicate v1 component schema declared: ${name}`);
      }
      if (byInstance.has(schema)) {
        throw new Error(`v1 shared schema registered twice: ${name} / ${byInstance.get(schema)}`);
      }
      byName.add(name);
      byInstance.set(schema, name);
    }
  }
  return byInstance;
}

/** Every declared operation, in resource order. */
export const V1_OPERATIONS: readonly V1Operation[] = RESOURCE_MODULES.flatMap(
  (resource) => resource.operations,
);

/** Every declared operation, keyed by `` `${METHOD} ${path}` ``. */
export const V1_OPERATION_REGISTRY: ReadonlyMap<string, V1Operation> =
  buildOperationRegistry(V1_OPERATIONS);

/** Every named component schema, merged across the resource modules. */
export const V1_RESOURCE_COMPONENTS: Readonly<Record<string, z.ZodType>> =
  mergeResourceComponents(RESOURCE_MODULES);

/**
 * Every named SHARED schema, keyed by its schema INSTANCE → component name — the
 * lookup the emitter's `$ref` substitution runs on.
 */
export const V1_SHARED_SCHEMAS: ReadonlyMap<z.ZodType, string> =
  mergeSharedSchemas(RESOURCE_MODULES);

/** Look one operation up by verb and path. */
export function findV1Operation(method: string, path: string): V1Operation | undefined {
  return V1_OPERATION_REGISTRY.get(`${method} ${path}`);
}

/** The operationIds, for the uniqueness a code generator depends on. */
export function v1OperationIds(): string[] {
  return V1_OPERATIONS.map((operation) => operation.operationId);
}
