import { describe, expect, it } from 'vitest';
import { Ec2ApiError, createEc2Api, toEc2ApiError, type Ec2SdkClientFactory } from '../src/index';

// The SDK-backed `Ec2Api` (Story MOTIR-9270 · MOTIR-9273): the credentials the
// factory builds the client with, the request each method sends and how it reads
// the answer, and how an SDK exception becomes an `Ec2ApiError` carrying the code
// only. The SDK client is stubbed at its constructor; nothing reaches AWS.

interface Sent {
  readonly command: string;
  readonly input: Record<string, unknown>;
}

function stub(answers: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const built: unknown[] = [];
  const factory: Ec2SdkClientFactory = (config) => {
    built.push(config);
    return {
      async send(command: unknown) {
        const c = command as { constructor: { name: string }; input: Record<string, unknown> };
        const name = c.constructor.name;
        sent.push({ command: name, input: c.input });
        const answer = answers[name];
        if (answer instanceof Error) throw answer;
        return answer ?? {};
      },
    };
  };
  return { sent, built, factory };
}

const CONFIG = { accessKeyId: 'AKID', secretAccessKey: 'secret', region: 'us-east-1' };
const TAGS = [{ key: 'motir-shard', value: 'ci-1' }];
const SDK_TAGS = [{ Key: 'motir-shard', Value: 'ci-1' }];

describe('createEc2Api', () => {
  it('passes a session token through when one is given, and omits it otherwise', () => {
    const withToken = stub();
    createEc2Api({ ...CONFIG, sessionToken: 'session' }, withToken.factory);
    expect(withToken.built).toEqual([
      {
        region: 'us-east-1',
        credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret', sessionToken: 'session' },
      },
    ]);

    const without = stub();
    createEc2Api(CONFIG, without.factory);
    expect(without.built).toEqual([
      { region: 'us-east-1', credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' } },
    ]);
  });

  it('builds a real SDK client by default', () => {
    expect(() => createEc2Api(CONFIG)).not.toThrow();
  });

  it('sends each create with its tags in TagSpecifications and reads the id back', async () => {
    const { sent, factory } = stub({
      CreateVpcCommand: { Vpc: { VpcId: 'vpc-1' } },
      CreateInternetGatewayCommand: { InternetGateway: { InternetGatewayId: 'igw-1' } },
      CreateRouteTableCommand: { RouteTable: { RouteTableId: 'rtb-1' } },
      CreateSubnetCommand: { Subnet: { SubnetId: 'subnet-1' } },
      CreateSecurityGroupCommand: { GroupId: 'sg-1' },
    });
    const ec2 = createEc2Api(CONFIG, factory);

    expect(await ec2.createVpc({ cidrBlock: '10.40.0.0/16', tags: TAGS })).toEqual({
      vpcId: 'vpc-1',
    });
    expect(await ec2.createInternetGateway({ tags: TAGS })).toEqual({ internetGatewayId: 'igw-1' });
    expect(await ec2.createRouteTable({ vpcId: 'vpc-1', tags: TAGS })).toEqual({
      routeTableId: 'rtb-1',
    });
    expect(
      await ec2.createSubnet({
        vpcId: 'vpc-1',
        cidrBlock: '10.40.0.0/20',
        availabilityZone: 'us-east-1a',
        tags: TAGS,
      }),
    ).toEqual({ subnetId: 'subnet-1' });
    expect(
      await ec2.createSecurityGroup({
        groupName: 'motir-runner-ci-1',
        description: 'd',
        vpcId: 'vpc-1',
        tags: TAGS,
      }),
    ).toEqual({ groupId: 'sg-1' });

    expect(sent.map((s) => [s.command, s.input['TagSpecifications']])).toEqual([
      ['CreateVpcCommand', [{ ResourceType: 'vpc', Tags: SDK_TAGS }]],
      ['CreateInternetGatewayCommand', [{ ResourceType: 'internet-gateway', Tags: SDK_TAGS }]],
      ['CreateRouteTableCommand', [{ ResourceType: 'route-table', Tags: SDK_TAGS }]],
      ['CreateSubnetCommand', [{ ResourceType: 'subnet', Tags: SDK_TAGS }]],
      ['CreateSecurityGroupCommand', [{ ResourceType: 'security-group', Tags: SDK_TAGS }]],
    ]);
  });

  it('sends the attach, route, associate and modify calls as EC2 names their fields', async () => {
    const { sent, factory } = stub();
    const ec2 = createEc2Api(CONFIG, factory);

    await ec2.attachInternetGateway({ internetGatewayId: 'igw-1', vpcId: 'vpc-1' });
    await ec2.createRoute({
      routeTableId: 'rtb-1',
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: 'igw-1',
    });
    await ec2.associateRouteTable({ routeTableId: 'rtb-1', subnetId: 'subnet-1' });
    await ec2.modifySubnetAttribute({ subnetId: 'subnet-1', mapPublicIpOnLaunch: true });

    expect(sent).toEqual([
      {
        command: 'AttachInternetGatewayCommand',
        input: { InternetGatewayId: 'igw-1', VpcId: 'vpc-1' },
      },
      {
        command: 'CreateRouteCommand',
        input: { RouteTableId: 'rtb-1', DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1' },
      },
      {
        command: 'AssociateRouteTableCommand',
        input: { RouteTableId: 'rtb-1', SubnetId: 'subnet-1' },
      },
      {
        command: 'ModifySubnetAttributeCommand',
        input: { SubnetId: 'subnet-1', MapPublicIpOnLaunch: { Value: true } },
      },
    ]);
  });

  it('maps every describe answer into plain shapes, passing the filters through', async () => {
    const { sent, factory } = stub({
      DescribeAvailabilityZonesCommand: {
        AvailabilityZones: [
          { ZoneName: 'us-east-1a', State: 'available' },
          { ZoneName: 'us-east-1b' },
        ],
      },
      DescribeVpcsCommand: {
        Vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.40.0.0/16', Tags: SDK_TAGS }, { VpcId: 'vpc-2' }],
      },
      DescribeInternetGatewaysCommand: {
        InternetGateways: [
          { InternetGatewayId: 'igw-1', Attachments: [{ VpcId: 'vpc-1' }, {}], Tags: SDK_TAGS },
          { InternetGatewayId: 'igw-2' },
        ],
      },
      DescribeRouteTablesCommand: {
        RouteTables: [
          {
            RouteTableId: 'rtb-1',
            VpcId: 'vpc-1',
            Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1' }, {}],
            Associations: [{ SubnetId: 'subnet-1' }, { Main: true }],
            Tags: [{}],
          },
          { RouteTableId: 'rtb-2' },
        ],
      },
      DescribeSubnetsCommand: {
        Subnets: [
          {
            SubnetId: 'subnet-1',
            VpcId: 'vpc-1',
            AvailabilityZone: 'us-east-1a',
            CidrBlock: '10.40.0.0/20',
            MapPublicIpOnLaunch: true,
          },
          { SubnetId: 'subnet-2' },
        ],
      },
      DescribeSecurityGroupsCommand: {
        SecurityGroups: [
          { GroupId: 'sg-1', GroupName: 'g', VpcId: 'vpc-1', IpPermissions: [{}], Tags: SDK_TAGS },
          { GroupId: 'sg-2' },
        ],
      },
    });
    const ec2 = createEc2Api(CONFIG, factory);
    const filter = [{ name: 'tag:motir-shard', values: ['ci-1'] }];

    expect(await ec2.describeAvailabilityZones([])).toEqual([
      { zoneName: 'us-east-1a', state: 'available' },
      { zoneName: 'us-east-1b', state: '' },
    ]);
    expect(await ec2.describeVpcs(filter)).toEqual([
      { vpcId: 'vpc-1', cidrBlock: '10.40.0.0/16', tags: TAGS },
      { vpcId: 'vpc-2', cidrBlock: '', tags: [] },
    ]);
    expect(await ec2.describeInternetGateways(filter)).toEqual([
      { internetGatewayId: 'igw-1', attachedVpcIds: ['vpc-1'], tags: TAGS },
      { internetGatewayId: 'igw-2', attachedVpcIds: [], tags: [] },
    ]);
    expect(await ec2.describeRouteTables(filter)).toEqual([
      {
        routeTableId: 'rtb-1',
        vpcId: 'vpc-1',
        routes: [
          { destinationCidrBlock: '0.0.0.0/0', gatewayId: 'igw-1' },
          { destinationCidrBlock: null, gatewayId: null },
        ],
        associatedSubnetIds: ['subnet-1'],
        tags: [{ key: '', value: '' }],
      },
      { routeTableId: 'rtb-2', vpcId: '', routes: [], associatedSubnetIds: [], tags: [] },
    ]);
    expect(await ec2.describeSubnets(filter)).toEqual([
      {
        subnetId: 'subnet-1',
        vpcId: 'vpc-1',
        availabilityZone: 'us-east-1a',
        cidrBlock: '10.40.0.0/20',
        mapPublicIpOnLaunch: true,
        tags: [],
      },
      {
        subnetId: 'subnet-2',
        vpcId: '',
        availabilityZone: '',
        cidrBlock: '',
        mapPublicIpOnLaunch: false,
        tags: [],
      },
    ]);
    expect(await ec2.describeSecurityGroups(filter)).toEqual([
      { groupId: 'sg-1', groupName: 'g', vpcId: 'vpc-1', ingressRuleCount: 1, tags: TAGS },
      { groupId: 'sg-2', groupName: '', vpcId: '', ingressRuleCount: 0, tags: [] },
    ]);

    expect(sent[0]!.input['Filters']).toBeUndefined();
    expect(sent[1]!.input['Filters']).toEqual([{ Name: 'tag:motir-shard', Values: ['ci-1'] }]);
  });

  it('refuses an answer that is missing the id it exists to return', async () => {
    const ec2 = createEc2Api(CONFIG, stub({ CreateVpcCommand: {} }).factory);
    await expect(ec2.createVpc({ cidrBlock: '10.40.0.0/16', tags: [] })).rejects.toMatchObject({
      code: 'MissingField.VpcId',
    });
    const empty = createEc2Api(CONFIG, stub().factory);
    expect(await empty.describeVpcs([])).toEqual([]);
    expect(await empty.describeAvailabilityZones([])).toEqual([]);
    expect(await empty.describeInternetGateways([])).toEqual([]);
    expect(await empty.describeRouteTables([])).toEqual([]);
    expect(await empty.describeSubnets([])).toEqual([]);
    expect(await empty.describeSecurityGroups([])).toEqual([]);
  });

  it('turns an SDK exception into an Ec2ApiError carrying the code and never the message', async () => {
    const sdkError = Object.assign(new Error('Invalid user data: SECRET-MARKER'), {
      name: 'InvalidParameterValue',
      $metadata: { httpStatusCode: 400 },
    });
    const ec2 = createEc2Api(CONFIG, stub({ DescribeVpcsCommand: sdkError }).factory);

    const thrown = await ec2.describeVpcs([]).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(Ec2ApiError);
    expect(thrown).toMatchObject({
      code: 'InvalidParameterValue',
      httpStatus: 400,
      retryable: false,
    });
    expect((thrown as Error).message).not.toContain('SECRET-MARKER');
  });
});

describe('toEc2ApiError', () => {
  it('prefers the query-protocol Code, then the name, and marks 5xx and transport as retryable', () => {
    expect(
      toEc2ApiError({
        Code: 'RequestLimitExceeded',
        name: 'X',
        $metadata: { httpStatusCode: 503 },
      }),
    ).toMatchObject({
      code: 'RequestLimitExceeded',
      httpStatus: 503,
      retryable: true,
    });
    expect(toEc2ApiError({ name: 'TimeoutError' })).toMatchObject({
      code: 'TimeoutError',
      httpStatus: null,
      retryable: true,
    });
    expect(
      toEc2ApiError({ name: 'Throttling', $retryable: {}, $metadata: { httpStatusCode: 400 } }),
    ).toMatchObject({
      retryable: true,
    });
    expect(toEc2ApiError('a string')).toMatchObject({ code: 'UnknownError' });
    const already = new Ec2ApiError('X', 400, false);
    expect(toEc2ApiError(already)).toBe(already);
  });
});

describe('createEc2Api — the instance calls (MOTIR-9276)', () => {
  const LAUNCH = {
    clientToken: 'token-1',
    imageId: 'ami-1',
    instanceType: 'm6i.large',
    subnetId: 'subnet-1',
    securityGroupIds: ['sg-1'],
    userData: 'QUJD',
    metadataOptions: {
      httpTokens: 'required',
      httpPutResponseHopLimit: 1,
      httpEndpoint: 'enabled',
    },
    instanceInitiatedShutdownBehavior: 'terminate',
    blockDeviceMappings: [
      { deviceName: '/dev/sdb', volumeSizeGb: 20, volumeType: 'gp3', deleteOnTermination: true },
    ],
    tags: TAGS,
  } as const;

  it('sends RunInstances with every launch field, tagging the instance and its volumes', async () => {
    const launchTime = new Date('2026-10-24T10:00:00.000Z');
    const { sent, factory } = stub({
      RunInstancesCommand: {
        Instances: [
          {
            InstanceId: 'i-1',
            State: { Name: 'pending' },
            LaunchTime: launchTime,
            StateTransitionReason: '',
            Placement: { AvailabilityZone: 'us-east-1a' },
            Tags: SDK_TAGS,
          },
        ],
      },
    });
    const instance = await createEc2Api(CONFIG, factory).runInstances(LAUNCH);

    expect(instance).toEqual({
      instanceId: 'i-1',
      state: 'pending',
      launchTime,
      stateTransitionReason: null,
      availabilityZone: 'us-east-1a',
      tags: TAGS,
    });
    expect(sent[0]).toEqual({
      command: 'RunInstancesCommand',
      input: {
        ClientToken: 'token-1',
        ImageId: 'ami-1',
        InstanceType: 'm6i.large',
        MinCount: 1,
        MaxCount: 1,
        SubnetId: 'subnet-1',
        SecurityGroupIds: ['sg-1'],
        UserData: 'QUJD',
        MetadataOptions: {
          HttpTokens: 'required',
          HttpPutResponseHopLimit: 1,
          HttpEndpoint: 'enabled',
        },
        InstanceInitiatedShutdownBehavior: 'terminate',
        BlockDeviceMappings: [
          {
            DeviceName: '/dev/sdb',
            Ebs: { VolumeSize: 20, VolumeType: 'gp3', DeleteOnTermination: true },
          },
        ],
        TagSpecifications: [
          { ResourceType: 'instance', Tags: SDK_TAGS },
          { ResourceType: 'volume', Tags: SDK_TAGS },
        ],
      },
    });
    expect(sent[0]!.input).not.toHaveProperty('IamInstanceProfile');
    expect(sent[0]!.input).not.toHaveProperty('KeyName');
  });

  it('omits BlockDeviceMappings when there is no Docker disk, and refuses an empty answer', async () => {
    const { sent, factory } = stub({ RunInstancesCommand: { Instances: [] } });
    await expect(
      createEc2Api(CONFIG, factory).runInstances({ ...LAUNCH, blockDeviceMappings: [] }),
    ).rejects.toMatchObject({ code: 'MissingField.Instances' });
    expect(sent[0]!.input).not.toHaveProperty('BlockDeviceMappings');
  });

  it('describes instances across reservations, passing ids, filters and paging through', async () => {
    const { sent, factory } = stub({
      DescribeInstancesCommand: {
        Reservations: [
          { Instances: [{ InstanceId: 'i-1', State: { Name: 'running' } }] },
          { Instances: [{ InstanceId: 'i-2' }] },
          {},
        ],
        NextToken: 'page-2',
      },
    });
    const ec2 = createEc2Api(CONFIG, factory);

    const page = await ec2.describeInstances({
      filters: [{ name: 'instance-state-name', values: ['running'] }],
      maxResults: 5,
      nextToken: 'page-1',
    });
    await ec2.describeInstances({ instanceIds: ['i-1'] });

    expect(page.nextToken).toBe('page-2');
    expect(page.instances.map((i) => [i.instanceId, i.state, i.launchTime])).toEqual([
      ['i-1', 'running', null],
      ['i-2', '', null],
    ]);
    expect(sent[0]!.input).toEqual({
      Filters: [{ Name: 'instance-state-name', Values: ['running'] }],
      MaxResults: 5,
      NextToken: 'page-1',
    });
    expect(sent[1]!.input).toEqual({ Filters: undefined, InstanceIds: ['i-1'] });
  });

  it('reads a last page as nextToken null, and terminates by id', async () => {
    const { sent, factory } = stub({ DescribeInstancesCommand: {} });
    const ec2 = createEc2Api(CONFIG, factory);
    expect(await ec2.describeInstances({})).toEqual({ instances: [], nextToken: null });
    await ec2.terminateInstances(['i-1']);
    expect(sent[1]).toEqual({
      command: 'TerminateInstancesCommand',
      input: { InstanceIds: ['i-1'] },
    });
  });
});
