import { AccountClient } from '@aws-sdk/client-account';
import { describe, expect, it } from 'vitest';
import {
  AWS_STANDALONE_WAIT_MS,
  AwsManagementApiError,
  createAwsManagementApi,
  createAwsManagementSdkClient,
  type AwsManagementClientFactory,
  type AwsManagementService,
} from '../src/index';

// The Organizations side of the handover (MOTIR-12130) on `AwsManagementApi`,
// over a stubbed SDK whose Account API and Organizations hold one member
// account's state: its primary email, a pending update and its one-time code,
// its join, its delegated-administrator registrations and whether it is still
// in the Organization.

const ACCOUNT = '210987654321';
const NEW_EMAIL = 'ops@customer.example';
const CODE = '845120';
const DAY = 24 * 60 * 60_000;

function sdkError(name: string, extra: Record<string, unknown> = {}, status = 400): Error {
  return Object.assign(new Error(`AWS said ${name} about ${NEW_EMAIL} and ${CODE}`), {
    name,
    $metadata: { httpStatusCode: status },
    ...extra,
  });
}

interface MemberState {
  email: string;
  pending: { email: string; code: string } | null;
  status: string | null;
  joined: Date | undefined;
  joinedMethod: string;
  delegated: string[];
  inOrganization: boolean;
  refuseRemoval: string | null;
}

function harness(
  state: Partial<MemberState> = {},
  clock = { t: Date.parse('2026-11-23T00:00:00Z') },
) {
  const member: MemberState = {
    email: 'tenant-cmorg1@motir.example',
    pending: null,
    status: null,
    joined: new Date(clock.t - 10 * DAY),
    joinedMethod: 'CREATED',
    delegated: [],
    inOrganization: true,
    refuseRemoval: null,
    ...state,
  };
  const calls: Array<{ service: AwsManagementService; command: string; input: unknown }> = [];
  const handlers: Record<string, (input: Record<string, unknown>) => unknown> = {
    AssumeRoleCommand: () => ({
      Credentials: {
        AccessKeyId: 'ASIAMGMT',
        SecretAccessKey: 'secret',
        SessionToken: 'token',
        Expiration: new Date(clock.t + 900_000),
      },
    }),
    StartPrimaryEmailUpdateCommand: (input) => {
      member.pending = { email: String(input['PrimaryEmail']), code: CODE };
      member.status = 'PENDING';
      return { Status: 'PENDING' };
    },
    AcceptPrimaryEmailUpdateCommand: (input) => {
      if (!member.pending) throw sdkError('ResourceNotFoundException');
      if (input['Otp'] !== member.pending.code || input['PrimaryEmail'] !== member.pending.email) {
        throw sdkError('ValidationException');
      }
      member.email = member.pending.email;
      member.pending = null;
      member.status = 'ACCEPTED';
      return { Status: 'ACCEPTED' };
    },
    GetPrimaryEmailCommand: () => ({ PrimaryEmail: member.email }),
    GetPrimaryEmailUpdateStatusCommand: () => {
      if (!member.status) throw sdkError('ResourceNotFoundException');
      return { Status: member.status, UpdatedAt: new Date(clock.t) };
    },
    DescribeAccountCommand: () => {
      if (!member.inOrganization) throw sdkError('AccountNotFoundException');
      return {
        Account: {
          Id: ACCOUNT,
          JoinedTimestamp: member.joined,
          JoinedMethod: member.joinedMethod,
        },
      };
    },
    ListDelegatedServicesForAccountCommand: (input) => {
      if (member.delegated.length === 0) throw sdkError('AccountNotRegisteredException');
      // Two pages, to show the read follows NextToken.
      return input['NextToken']
        ? { DelegatedServices: member.delegated.slice(1).map((s) => ({ ServicePrincipal: s })) }
        : {
            DelegatedServices: [{ ServicePrincipal: member.delegated[0] }, {}],
            ...(member.delegated.length > 1 ? { NextToken: 'p2' } : {}),
          };
    },
    RemoveAccountFromOrganizationCommand: () => {
      if (!member.inOrganization) throw sdkError('AccountNotFoundException');
      if (member.refuseRemoval) {
        throw sdkError('ConstraintViolationException', { Reason: member.refuseRemoval });
      }
      member.inOrganization = false;
      return {};
    },
  };
  const factory: AwsManagementClientFactory = (service) => ({
    async send(command: unknown) {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      calls.push({ service, command: name, input });
      const handler = handlers[name];
      if (!handler) throw new Error(`unstubbed ${name}`);
      return handler(input);
    },
  });
  const api = createAwsManagementApi(
    { roleArn: 'arn:aws:iam::111122223333:role/motir-org-admin' },
    { clientFactory: factory, now: () => clock.t, sleep: async () => undefined },
  );
  return { api, member, calls, handlers, clock };
}

describe('the primary-email update', () => {
  it('moves the primary email to the address given once the code is accepted', async () => {
    const h = harness();
    expect(await h.api.getPrimaryEmailUpdateStatus(ACCOUNT)).toBeNull();
    expect(await h.api.startPrimaryEmailUpdate(ACCOUNT, NEW_EMAIL)).toEqual({ status: 'PENDING' });
    expect(await h.api.getPrimaryEmailUpdateStatus(ACCOUNT)).toEqual({
      status: 'PENDING',
      updatedAt: new Date(h.clock.t),
    });
    expect(await h.api.acceptPrimaryEmailUpdate(ACCOUNT, NEW_EMAIL, CODE)).toEqual({
      outcome: 'accepted',
      status: 'ACCEPTED',
    });
    expect(await h.api.getPrimaryEmail(ACCOUNT)).toBe(NEW_EMAIL);
    // Every call went to the Account API on the management session.
    expect(
      h.calls
        .filter((c) => c.command !== 'AssumeRoleCommand')
        .every((c) => c.service === 'account'),
    ).toBe(true);
  });

  it('answers a wrong or expired code with a typed refusal that names neither', async () => {
    const h = harness();
    await h.api.startPrimaryEmailUpdate(ACCOUNT, NEW_EMAIL);
    const wrong = await h.api.acceptPrimaryEmailUpdate(ACCOUNT, NEW_EMAIL, '000000');
    expect(wrong).toEqual({ outcome: 'code_refused', reason: 'ValidationException' });
    h.member.pending = null; // expired
    const expired = await h.api.acceptPrimaryEmailUpdate(ACCOUNT, NEW_EMAIL, CODE);
    expect(expired).toEqual({ outcome: 'code_refused', reason: 'ResourceNotFoundException' });
    for (const answer of [wrong, expired]) {
      expect(JSON.stringify(answer)).not.toContain(CODE);
      expect(JSON.stringify(answer)).not.toContain(NEW_EMAIL);
    }
    expect(h.member.email).not.toBe(NEW_EMAIL);
  });

  it('throws any other refusal as AWS’s code only, never the address or the code', async () => {
    const h = harness();
    h.handlers['AcceptPrimaryEmailUpdateCommand'] = () => {
      throw sdkError('AccessDeniedException', {}, 403);
    };
    h.handlers['StartPrimaryEmailUpdateCommand'] = () => {
      throw sdkError('TooManyRequestsException', {}, 429);
    };
    h.handlers['GetPrimaryEmailUpdateStatusCommand'] = () => {
      throw sdkError('InternalServerException', {}, 500);
    };
    for (const run of [
      () => h.api.acceptPrimaryEmailUpdate(ACCOUNT, NEW_EMAIL, CODE),
      () => h.api.startPrimaryEmailUpdate(ACCOUNT, NEW_EMAIL),
      () => h.api.getPrimaryEmailUpdateStatus(ACCOUNT),
    ]) {
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AwsManagementApiError);
      const text = `${(err as Error).message} ${JSON.stringify(err)}`;
      expect(text).not.toContain(CODE);
      expect(text).not.toContain(NEW_EMAIL);
    }
  });

  it('refuses a status AWS has not documented', async () => {
    const h = harness();
    h.handlers['StartPrimaryEmailUpdateCommand'] = () => ({ Status: 'SOMETHING_NEW' });
    await expect(h.api.startPrimaryEmailUpdate(ACCOUNT, NEW_EMAIL)).rejects.toMatchObject({
      awsCode: 'UnknownStatus:SOMETHING_NEW',
    });
    h.handlers['GetPrimaryEmailUpdateStatusCommand'] = () => ({ Status: 'COMPLETED' });
    expect(await h.api.getPrimaryEmailUpdateStatus(ACCOUNT)).toEqual({
      status: 'COMPLETED',
      updatedAt: null,
    });
    h.handlers['AcceptPrimaryEmailUpdateCommand'] = () => ({});
    await expect(h.api.acceptPrimaryEmailUpdate(ACCOUNT, NEW_EMAIL, CODE)).rejects.toMatchObject({
      awsCode: 'UnknownStatus:',
    });
    h.handlers['GetPrimaryEmailCommand'] = () => ({});
    await expect(h.api.getPrimaryEmail(ACCOUNT)).rejects.toMatchObject({
      awsCode: 'MissingField:PrimaryEmail',
    });
  });
});

describe('readStandaloneReadiness', () => {
  it('reads the wait and delegated administration; the rest are unknown', async () => {
    const h = harness();
    expect(await h.api.readStandaloneReadiness(ACCOUNT)).toEqual({
      inOrganization: true,
      waitPeriod: {
        status: 'met',
        eligibleAt: new Date(h.member.joined!.getTime() + AWS_STANDALONE_WAIT_MS),
      },
      delegatedAdministrator: { status: 'met', services: [] },
      paymentMethod: 'unknown',
      supportPlan: 'unknown',
      contactInformation: 'unknown',
      ready: null,
    });
  });

  it('is not ready inside the four days after the account was created', async () => {
    const clock = { t: Date.parse('2026-11-23T00:00:00Z') };
    const h = harness({ joined: new Date(clock.t - 3 * DAY) }, clock);
    const readiness = await h.api.readStandaloneReadiness(ACCOUNT);
    expect(readiness.waitPeriod).toEqual({
      status: 'not_met',
      eligibleAt: new Date(clock.t + DAY),
    });
    expect(readiness.ready).toBe(false);
  });

  it('has no wait for an invited account, and an unknown one with no join time', async () => {
    const invited = harness({ joinedMethod: 'INVITED', joined: new Date() });
    expect((await invited.api.readStandaloneReadiness(ACCOUNT)).waitPeriod).toEqual({
      status: 'met',
      eligibleAt: null,
    });
    const untimed = harness({ joined: undefined });
    expect((await untimed.api.readStandaloneReadiness(ACCOUNT)).waitPeriod).toEqual({
      status: 'unknown',
      eligibleAt: null,
    });
  });

  it('is not ready while the account is a delegated administrator, across pages', async () => {
    const h = harness({ delegated: ['securityhub.amazonaws.com', 'guardduty.amazonaws.com'] });
    const readiness = await h.api.readStandaloneReadiness(ACCOUNT);
    expect(readiness.delegatedAdministrator).toEqual({
      status: 'not_met',
      services: ['securityhub.amazonaws.com', 'guardduty.amazonaws.com'],
    });
    expect(readiness.ready).toBe(false);
  });

  it('says so for an account already outside the Organization', async () => {
    const h = harness({ inOrganization: false });
    const readiness = await h.api.readStandaloneReadiness(ACCOUNT);
    expect(readiness.inOrganization).toBe(false);
    expect(readiness.ready).toBeNull();
  });

  it('throws any other refusal of either read', async () => {
    const h = harness();
    h.handlers['ListDelegatedServicesForAccountCommand'] = () => {
      throw sdkError('AccessDeniedException', {}, 403);
    };
    await expect(h.api.readStandaloneReadiness(ACCOUNT)).rejects.toMatchObject({
      service: 'organizations',
      awsCode: 'AccessDeniedException',
    });
    h.handlers['DescribeAccountCommand'] = () => {
      throw sdkError('TooManyRequestsException', {}, 429);
    };
    await expect(h.api.readStandaloneReadiness(ACCOUNT)).rejects.toMatchObject({
      awsCode: 'TooManyRequestsException',
    });
  });
});

describe('removeAccountFromOrganization', () => {
  it('answers not_ready with AWS’s reason, and throws nothing', async () => {
    const h = harness({ refuseRemoval: 'MEMBER_ACCOUNT_PAYMENT_INSTRUMENT_REQUIRED' });
    expect(await h.api.removeAccountFromOrganization(ACCOUNT)).toEqual({
      outcome: 'not_ready',
      missing: ['MEMBER_ACCOUNT_PAYMENT_INSTRUMENT_REQUIRED'],
    });
    expect(h.member.inOrganization).toBe(true);
  });

  it('names the constraint itself when AWS gives no reason', async () => {
    const h = harness({ refuseRemoval: '' });
    h.handlers['RemoveAccountFromOrganizationCommand'] = () => {
      throw sdkError('ConstraintViolationException');
    };
    expect(await h.api.removeAccountFromOrganization(ACCOUNT)).toEqual({
      outcome: 'not_ready',
      missing: ['ConstraintViolationException'],
    });
  });

  it('removes an accepted account, and answers removed again once it is outside', async () => {
    const h = harness();
    expect(await h.api.removeAccountFromOrganization(ACCOUNT)).toEqual({ outcome: 'removed' });
    expect(h.member.inOrganization).toBe(false);
    expect(await h.api.removeAccountFromOrganization(ACCOUNT)).toEqual({ outcome: 'removed' });
  });

  it('throws any other refusal as AWS’s code', async () => {
    const h = harness();
    h.handlers['RemoveAccountFromOrganizationCommand'] = () => {
      throw sdkError('MasterCannotLeaveOrganizationException');
    };
    await expect(h.api.removeAccountFromOrganization(ACCOUNT)).rejects.toMatchObject({
      service: 'organizations',
      awsCode: 'MasterCannotLeaveOrganizationException',
    });
  });
});

describe('the Account API client', () => {
  it('is the real AccountClient', () => {
    expect(createAwsManagementSdkClient('account', { region: 'us-east-1' })).toBeInstanceOf(
      AccountClient,
    );
  });
});
