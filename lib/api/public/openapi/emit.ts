import { PUBLIC_CONTRACT_VERSION } from '@/lib/api/public/contractVersion';
import { toOpenApiSchema } from '@/lib/api/v1/openapi/emit';
import { PUBLIC_OPERATIONS } from '@/lib/api/public/openapi/operations';
import type { z } from 'zod/v4';
import type { PublicOperation, PublicParameter } from '@/lib/api/public/openapi/operation';

// The published PUBLIC OpenAPI 3.1 document, assembled from the operation
// registry (MOTIR-3946).
//
// ⚠️ IT REUSES `toOpenApiSchema` FROM v1's EMITTER AND NOTHING ELSE. That
// function is exported for exactly this: a second document should not need a
// second zod→OpenAPI conversion, and the one place both surfaces genuinely
// agree is how a schema becomes a schema object. Everything below it —
// envelopes, error responses, shared headers, the security scheme — is v1's own
// and does not describe this surface (`docs/decisions/public-surface-hosts.md`
// AMENDMENT 1).
//
// ⚠️ NO SECURITY SCHEME — and the reason is sharper than "everything here is
// anonymous", which MOTIR-3990 measured to be FALSE. Four of the twelve
// operations require the application's own browser session (`follow` POST and
// DELETE, `requests` POST, and its `duplicates` pre-check). A security scheme
// describes a credential the READER OF THIS DOCUMENT can present, and there is
// none: the session cookie is host-only on the application's origin
// (`docs/decisions/public-surface-hosts.md` §4), so a consumer on another origin
// cannot send it — those four are simply not callable from there. Declaring a
// cookie scheme would advertise a door that does not open, and copying v1's
// bearer scheme would advertise one that does not exist at all.
//
// So the gatedness is declared where a consumer actually meets it: the 401 is a
// documented response, and `sessionRequired` marks the operation. What makes
// that honest rather than remembered is that
// `tests/api/public/contract-coverage.test.ts` derives the same fact from each
// route's SOURCE and fails when the two disagree.

type JsonObject = Record<string, unknown>;

/**
 * The named shapes hoisted out of the conversion, keyed by component name.
 *
 * ⚠️ WHY THIS EXISTS AT ALL. `toOpenApiSchema` runs zod's converter, and a
 * subschema carrying `.meta({ id })` comes back as a `$ref` to `#/$defs/<id>`
 * with the definition attached to the ROOT of that one conversion. Copy those
 * roots into a document and every such `$ref` dangles: `$defs` sits under one
 * response's schema, not at the document's root, so nothing resolves it. The
 * OpenAPI validator in `tests/api/public/contract-route.test.ts` caught exactly
 * that — `Can't resolve #/$defs/PublicProjectStats` — before this document was
 * ever served.
 *
 * The fix is the one v1 already made, arrived at from the other end: v1
 * registers its resources and `$ref`s `#/components/schemas/<name>`, so we
 * MOVE each `$defs` entry there and rewrite the pointers. A shared shape is
 * then named once in the document a consumer reads, which is what the `.meta`
 * id was asking for in the first place.
 */
type Components = Map<string, JsonObject>;

const DEFS_POINTER = '#/$defs/';
const COMPONENTS_POINTER = '#/components/schemas/';

/** Rewrite every `#/$defs/X` pointer, at any depth, to its component address. */
function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (value && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [key, member] of Object.entries(value as JsonObject)) {
      out[key] =
        key === '$ref' && typeof member === 'string' && member.startsWith(DEFS_POINTER)
          ? COMPONENTS_POINTER + member.slice(DEFS_POINTER.length)
          : rewriteRefs(member);
    }
    return out;
  }
  return value;
}

/**
 * Convert one schema, HOISTING its named subschemas into `components.schemas`.
 *
 * The write is unconditional rather than guarded by "is it already there": a
 * `.meta({ id })` names ONE schema object, so a second operation referencing the
 * same shape hoists a byte-identical definition. Referential integrity —
 * every `$ref` resolving to a component that exists — is asserted in
 * `tests/api/public/contract-document.test.ts`, which is the property a reader
 * of the document actually depends on.
 */
function convert(schema: z.ZodType, io: 'input' | 'output', components: Components): JsonObject {
  const emitted = toOpenApiSchema(schema, io) as JsonObject;
  const { $defs: defs, ...rest } = emitted;
  if (defs && typeof defs === 'object') {
    for (const [name, definition] of Object.entries(defs as JsonObject)) {
      components.set(name, stripMetaId(rewriteRefs(definition) as JsonObject));
    }
  }
  return stripMetaId(rewriteRefs(rest) as JsonObject);
}

/**
 * Drop the `id` zod writes from `.meta({ id })`.
 *
 * A component's KEY is its name here, and `id` is not an OpenAPI 3.1 keyword
 * (`$id` is) — leaving it publishes a field that means nothing to a reader and
 * nothing to a generator. Only the schema's OWN top-level `id` goes; a resource
 * with an `id` PROPERTY keeps it, since that sits under `properties`.
 */
function stripMetaId(schema: JsonObject): JsonObject {
  const { id: _metaId, ...rest } = schema;
  return rest;
}

function parameterObject(parameter: PublicParameter, components: Components): JsonObject {
  return {
    name: parameter.name,
    in: parameter.in,
    required: parameter.required,
    description: parameter.description,
    schema: convert(parameter.schema, 'input', components),
  };
}

function responsesFor(operation: PublicOperation, components: Components): JsonObject {
  const status = String(operation.successStatus ?? 200);
  const responses: JsonObject = {
    // A 202 with no body is DECLARED as one: `content` is omitted rather than
    // given an empty schema, which is how OpenAPI says "there is no body" and
    // how a generator learns not to parse one.
    [status]:
      operation.response === null
        ? { description: successDescription(operation) }
        : {
            description: successDescription(operation),
            content: {
              // The declared media type, defaulting to JSON — which every
              // operation here answered until the changelog feed (MOTIR-4111).
              [operation.responseMediaType ?? 'application/json']: {
                schema: convert(operation.response, 'output', components),
              },
            },
          },
  };
  for (const error of operation.errors) {
    responses[String(error.status)] = {
      description: error.description,
      content: { 'application/json': { schema: convert(error.schema, 'output', components) } },
    };
  }
  return responses;
}

/** What the success status MEANS on this operation, not a generic label. */
function successDescription(operation: PublicOperation): string {
  if (operation.response === null) return 'Accepted. There is deliberately no body — see above.';
  return operation.successStatus === 201 ? 'Created.' : 'The requested resource.';
}

function requestBodyObject(operation: PublicOperation, components: Components): JsonObject {
  const body = operation.requestBody;
  if (body === undefined) return {};
  return {
    requestBody: {
      description: body.description,
      required: body.required,
      content: { 'application/json': { schema: convert(body.schema, 'input', components) } },
    },
  };
}

function operationObject(operation: PublicOperation, components: Components): JsonObject {
  return {
    operationId: operation.operationId,
    summary: operation.summary,
    description: operation.deprecated
      ? `${operation.description}\n\nDeprecated: ${operation.deprecated.reason}. ` +
        `Use ${operation.deprecated.replacement}.`
      : operation.description,
    ...(operation.deprecated ? { deprecated: true } : {}),
    ...(operation.parameters.length > 0
      ? { parameters: operation.parameters.map((p) => parameterObject(p, components)) }
      : {}),
    ...requestBodyObject(operation, components),
    responses: responsesFor(operation, components),
  };
}

/**
 * The whole document.
 *
 * Assembled from `PUBLIC_OPERATIONS` — no path, method or schema is written
 * twice, which is what makes the drift guard able to compare the document to
 * the routes rather than to a second hand-maintained list.
 */
export function emitPublicOpenApiDocument(): JsonObject {
  const components: Components = new Map();
  const paths: JsonObject = {};
  for (const operation of PUBLIC_OPERATIONS) {
    const existing = (paths[operation.path] as JsonObject | undefined) ?? {};
    existing[operation.method.toLowerCase()] = operationObject(operation, components);
    paths[operation.path] = existing;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Motir public read API',
      version: PUBLIC_CONTRACT_VERSION,
      description:
        'The anonymous read surface a public renderer consumes. Separate from the authenticated ' +
        '`/api/v1` client API, which requires a token and has its own version ' +
        'and its own document — see `docs/decisions/public-surface-hosts.md` AMENDMENT 1 for why ' +
        'these are two contracts rather than one.',
    },
    paths,
    // Sorted, so the document is byte-identical run to run: a consumer may cache
    // it, and `Map` order would otherwise follow whichever operation happened to
    // reference a shape first.
    components: {
      schemas: Object.fromEntries([...components.entries()].sort(([a], [b]) => a.localeCompare(b))),
    },
  };
}

export { PUBLIC_CONTRACT_VERSION };
