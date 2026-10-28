import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
  UpdateStackCommand,
  type Stack,
} from '@aws-sdk/client-cloudformation';
import type { AwsSdkClient } from '../management';
import type { TenantCloudFormation, TenantStack, TenantStackWrite } from './clients';
import { AwsTenantApiError, TenantRoleUnavailableError } from './errors';

// The SDK-backed tenant clients (MOTIR-10004). The only file of the seam that
// imports an AWS SDK package; what it exports speaks only `clients.ts`'s types.
//
// API references, read 2026-10-28:
//   https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_DescribeStacks.html,
//   API_GetTemplate.html, API_CreateStack.html, API_UpdateStack.html, API_DeleteStack.html

/** The services a tenant client bundle builds. Later cards add theirs. */
export type TenantSdkService = 'cloudformation';

/** Temporary credentials, as the SDK's credential provider answers them. */
export interface TenantSdkCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration?: Date;
}

/** How the seam builds each SDK client: always with a credential PROVIDER, the
 *  deploy-role session, never a static key. */
export type TenantSdkClientFactory = (
  service: TenantSdkService,
  config: { region: string; credentials: () => Promise<TenantSdkCredentials> },
) => AwsSdkClient;

/** The real SDK client for each service. */
export const createTenantSdkClient: TenantSdkClientFactory = (_service, config) =>
  new CloudFormationClient(config);

interface SdkErrorShape {
  name?: unknown;
  Code?: unknown;
  message?: unknown;
  $metadata?: { httpStatusCode?: unknown };
}

function shapeOf(err: unknown): SdkErrorShape {
  return (typeof err === 'object' && err !== null ? err : {}) as SdkErrorShape;
}

/** AWS's code for the error — never its message, which can echo inputs. */
export function tenantApiError(
  service: string,
  err: unknown,
): AwsTenantApiError | TenantRoleUnavailableError {
  // A credential the provider could not get is the role's refusal, not the call's.
  if (err instanceof AwsTenantApiError || err instanceof TenantRoleUnavailableError) return err;
  const shape = shapeOf(err);
  const code =
    (typeof shape.Code === 'string' && shape.Code) ||
    (typeof shape.name === 'string' && shape.name) ||
    'UnknownError';
  const status =
    typeof shape.$metadata?.httpStatusCode === 'number' ? shape.$metadata.httpStatusCode : null;
  return new AwsTenantApiError(service, code, status);
}

/** CloudFormation answers both of these as a `ValidationError`; only the
 *  message tells them apart, so it is read here and never carried further. */
function validationSays(err: unknown, text: RegExp): boolean {
  const shape = shapeOf(err);
  return (
    (shape.name === 'ValidationError' || shape.Code === 'ValidationError') &&
    typeof shape.message === 'string' &&
    text.test(shape.message)
  );
}

const pairs = (record: Readonly<Record<string, string>>) => Object.entries(record);

function stackOf(name: string, stack: Stack): TenantStack {
  return {
    name,
    status: stack.StackStatus ?? 'UNKNOWN',
    parameters: Object.fromEntries(
      (stack.Parameters ?? []).map((p) => [p.ParameterKey ?? '', p.ParameterValue ?? '']),
    ),
    tags: Object.fromEntries((stack.Tags ?? []).map((t) => [t.Key ?? '', t.Value ?? ''])),
    outputs: Object.fromEntries(
      (stack.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']),
    ),
  };
}

/** The write's fields as CreateStack and UpdateStack take them. Named IAM roles
 *  need `CAPABILITY_NAMED_IAM`. */
function writeOf(input: TenantStackWrite) {
  return {
    StackName: input.name,
    TemplateBody: input.templateBody,
    Parameters: pairs(input.parameters).map(([ParameterKey, ParameterValue]) => ({
      ParameterKey,
      ParameterValue,
    })),
    Tags: pairs(input.tags).map(([Key, Value]) => ({ Key, Value })),
    Capabilities: ['CAPABILITY_NAMED_IAM' as const],
  };
}

/** `TenantCloudFormation` over an SDK client. */
export function sdkTenantCloudFormation(client: AwsSdkClient): TenantCloudFormation {
  async function send<T>(command: unknown): Promise<T> {
    try {
      return (await client.send(command)) as T;
    } catch (err) {
      throw tenantApiError('cloudformation', err);
    }
  }

  return {
    async describeStack(name) {
      try {
        const { Stacks } = (await client.send(new DescribeStacksCommand({ StackName: name }))) as {
          Stacks?: Stack[];
        };
        const stack = Stacks?.[0];
        return stack ? stackOf(name, stack) : null;
      } catch (err) {
        if (validationSays(err, /does not exist/)) return null;
        throw tenantApiError('cloudformation', err);
      }
    },

    async getTemplateBody(name) {
      const { TemplateBody } = await send<{ TemplateBody?: string }>(
        new GetTemplateCommand({ StackName: name, TemplateStage: 'Original' }),
      );
      return TemplateBody ?? '';
    },

    async createStack(input) {
      await send(new CreateStackCommand(writeOf(input)));
    },

    async updateStack(input) {
      try {
        await client.send(new UpdateStackCommand(writeOf(input)));
        return 'updating';
      } catch (err) {
        if (validationSays(err, /No updates are to be performed/)) return 'no_change';
        throw tenantApiError('cloudformation', err);
      }
    },

    async deleteStack(name) {
      await send(new DeleteStackCommand({ StackName: name }));
    },
  };
}
