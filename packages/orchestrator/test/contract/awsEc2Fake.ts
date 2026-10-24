import {
  Ec2ApiError,
  type Ec2Api,
  type Ec2AvailabilityZone,
  type Ec2DescribeInstancesInput,
  type Ec2Filter,
  type Ec2Instance,
  type Ec2InternetGateway,
  type Ec2RouteTable,
  type Ec2RunInstanceInput,
  type Ec2SecurityGroup,
  type Ec2Subnet,
  type Ec2Tag,
  type Ec2Vpc,
} from '../../src/index';

// An in-memory EC2 (Story MOTIR-9270) — the AWS twin of the Fly harness's
// in-memory Machines API. It answers the `Ec2Api` calls, holds tags, and enforces
// the describe filters the adapter relies on (`tag:<key>`, `vpc-id`, `state`), so
// a test that passes here passes for the reason it would against EC2: the
// resource was FOUND by its tag, not handed back from a variable.
//
// Every call is recorded in `calls`, which is how a test counts creates.
//
// INSTANCES (MOTIR-9276) behave as EC2's do where the adapter depends on it:
// `RunInstances` answers a repeated `ClientToken` with the instance it already
// made; a launched instance reads `running` (or stays `pending`); a terminated one
// stays describable as `terminated` until it AGES OUT, after which its id is
// `InvalidInstanceID.NotFound`; and DescribeInstances pages by `maxResults`.

export interface FakeCall {
  readonly method: string;
  readonly input: unknown;
}

interface Tagged {
  tags: Ec2Tag[];
}

type Attributes = Record<string, readonly string[]>;

function matches(filters: readonly Ec2Filter[], tags: readonly Ec2Tag[], attrs: Attributes) {
  return filters.every((f) => {
    if (f.name.startsWith('tag:')) {
      const key = f.name.slice('tag:'.length);
      return tags.some((t) => t.key === key && f.values.includes(t.value));
    }
    if (f.name === 'tag-key') return tags.some((t) => f.values.includes(t.key));
    const have = attrs[f.name];
    if (!have) throw new Error(`awsEc2Fake: unsupported filter ${f.name}`);
    return have.some((v) => f.values.includes(v));
  });
}

/** The HTTP status EC2 answers each arranged code with. */
const STATUS_BY_CODE: Record<string, number> = {
  InsufficientInstanceCapacity: 500,
  RequestLimitExceeded: 503,
};

export class AwsEc2Fake implements Ec2Api {
  readonly calls: FakeCall[] = [];
  zones: Ec2AvailabilityZone[] = [
    { zoneName: 'us-east-1a', state: 'available' },
    { zoneName: 'us-east-1b', state: 'available' },
    { zoneName: 'us-east-1c', state: 'available' },
  ];
  readonly vpcs = new Map<string, Ec2Vpc & Tagged>();
  readonly internetGateways = new Map<string, Ec2InternetGateway & Tagged>();
  readonly routeTables = new Map<string, Ec2RouteTable & Tagged>();
  readonly subnets = new Map<string, Ec2Subnet & Tagged>();
  readonly securityGroups = new Map<string, Ec2SecurityGroup & Tagged>();
  /** Every instance ever launched, terminated ones included, by id. */
  readonly instances = new Map<string, Ec2Instance & { request: Ec2RunInstanceInput }>();
  /** The instance each `ClientToken` made. */
  private readonly byToken = new Map<string, string>();
  /** The next launch stays `pending`. */
  leaveNextPending = false;
  /** The next RunInstances creates its instance and THEN fails — an ambiguous
   *  timeout. */
  private failNextAfterCreate: string | null = null;
  /** Every RunInstances the fake refused for capacity: where, with which token. */
  readonly refusals: Array<{ zone: string; clientToken: string; code: string }> = [];
  /** Arranged RunInstances refusals, each consumed by the first call it matches. */
  private readonly arrangedRefusals: Array<{ code: string; zone?: string }> = [];
  /** Zones refusing every launch with InsufficientInstanceCapacity until cleared. */
  private readonly outOfStockZones = new Set<string>();
  private seq = 0;
  private readonly failures = new Map<string, string>();

  /** The next call of `method` throws an `Ec2ApiError` with `code`. */
  failNext(method: keyof Ec2Api, code = 'InternalError', httpStatus = 500): void {
    this.failures.set(method, `${code}|${httpStatus}`);
  }

  /** Forget everything: resources, instances, calls and arranged failures. */
  clear(): void {
    this.calls.length = 0;
    for (const map of [
      this.vpcs,
      this.internetGateways,
      this.routeTables,
      this.subnets,
      this.securityGroups,
      this.instances,
      this.byToken,
    ]) {
      map.clear();
    }
    this.failures.clear();
    this.leaveNextPending = false;
    this.failNextAfterCreate = null;
    this.arrangedRefusals.length = 0;
    this.outOfStockZones.clear();
    this.refusals.length = 0;
    this.seq = 0;
  }

  /**
   * Put a shard's network in place directly, with FIXED ids — what
   * `ensureAwsShardNetwork` leaves, without its calls. One subnet per zone and
   * one no-inbound group, all tagged `motir-shard=<shardTag>`.
   */
  seedShardNetwork(shardTag: string, zones: readonly string[] = ['us-east-1a', 'us-east-1b']) {
    const tags = [{ key: 'motir-shard', value: shardTag }];
    const vpcId = `vpc-${shardTag}`;
    this.vpcs.set(vpcId, { vpcId, cidrBlock: '10.40.0.0/16', tags });
    zones.forEach((zone, i) => {
      const subnetId = `subnet-${shardTag}-${zone}`;
      this.subnets.set(subnetId, {
        subnetId,
        vpcId,
        availabilityZone: zone,
        cidrBlock: `10.40.${i * 16}.0/20`,
        mapPublicIpOnLaunch: true,
        tags,
      });
    });
    const groupId = `sg-${shardTag}`;
    this.securityGroups.set(groupId, {
      groupId,
      groupName: `motir-runner-${shardTag}`,
      vpcId,
      ingressRuleCount: 0,
      tags,
    });
    return { vpcId, groupId, subnetIds: zones.map((z) => `subnet-${shardTag}-${z}`) };
  }

  /**
   * Refuse the next RunInstances with an AWS error `code` — in `zone` only, when
   * named. Each call queues one refusal; the HTTP status is the one EC2 sends for
   * that code (InsufficientInstanceCapacity 500, RequestLimitExceeded 503).
   */
  failNextRunInstances(refusal: { code: string; zone?: string }): void {
    this.arrangedRefusals.push(refusal);
  }

  /** Every launch in `zone` is InsufficientInstanceCapacity until cleared. */
  setZoneOutOfStock(zone: string, outOfStock = true): void {
    if (outOfStock) this.outOfStockZones.add(zone);
    else this.outOfStockZones.delete(zone);
  }

  /** The next RunInstances makes its instance, then answers `code` as a 5xx. */
  failNextRunAfterCreate(code = 'InternalError'): void {
    this.failNextAfterCreate = code;
  }

  /** The instance's VM powers off with `terminate` behaviour — a finished job. */
  endJob(instanceId: string, at = new Date()): void {
    this.setState(instanceId, 'terminated', userInitiated(at));
  }

  /** Move an instance to `state`, as a person in the console or AWS would. */
  setState(instanceId: string, state: string, reason: string | null = null): void {
    const instance = this.instance(instanceId);
    this.instances.set(instanceId, { ...instance, state, stateTransitionReason: reason });
  }

  /** The instance was launched at `launchTime`. */
  backdate(instanceId: string, launchTime: Date): void {
    this.instances.set(instanceId, { ...this.instance(instanceId), launchTime });
  }

  /** A terminated instance drops out of DescribeInstances, as EC2's do after an hour. */
  ageOut(instanceId: string): void {
    this.instances.delete(instanceId);
  }

  /** Put an instance in the fake directly — another shard's, or a hand-made one. */
  plantInstance(instance: Partial<Ec2Instance> & { tags: readonly Ec2Tag[] }): string {
    const instanceId = instance.instanceId ?? this.nextId('i');
    this.instances.set(instanceId, {
      instanceId,
      state: 'running',
      launchTime: new Date(),
      stateTransitionReason: null,
      availabilityZone: 'us-east-1a',
      ...instance,
      request: {} as Ec2RunInstanceInput,
    });
    return instanceId;
  }

  /** Instances that still bill — every one not terminated. */
  liveInstanceIds(): string[] {
    return [...this.instances.values()]
      .filter((i) => i.state !== 'terminated')
      .map((i) => i.instanceId);
  }

  /** The RunInstances request that made `instanceId`. */
  requestOf(instanceId: string): Ec2RunInstanceInput {
    return this.instance(instanceId).request;
  }

  private instance(instanceId: string) {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`awsEc2Fake: no instance ${instanceId}`);
    return instance;
  }

  /** How many recorded calls of `method` there were. */
  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  /** Every recorded call whose name starts with a mutating verb. */
  mutations(): FakeCall[] {
    return this.calls.filter((c) =>
      /^(create|attach|associate|modify|authorize|run|terminate)/.test(c.method),
    );
  }

  protected record(method: string, input: unknown): void {
    this.calls.push({ method, input });
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      const [code, status] = failure.split('|');
      throw new Ec2ApiError(code!, Number(status), Number(status) >= 500);
    }
  }

  protected nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq.toString(16).padStart(8, '0')}`;
  }

  async describeAvailabilityZones(filters: readonly Ec2Filter[]) {
    this.record('describeAvailabilityZones', filters);
    return this.zones.filter((z) => matches(filters, [], { state: [z.state] }));
  }

  async describeVpcs(filters: readonly Ec2Filter[]) {
    this.record('describeVpcs', filters);
    return [...this.vpcs.values()].filter((v) => matches(filters, v.tags, { 'vpc-id': [v.vpcId] }));
  }

  async createVpc(input: { cidrBlock: string; tags: readonly Ec2Tag[] }) {
    this.record('createVpc', input);
    const vpcId = this.nextId('vpc');
    this.vpcs.set(vpcId, { vpcId, cidrBlock: input.cidrBlock, tags: [...input.tags] });
    return { vpcId };
  }

  async describeInternetGateways(filters: readonly Ec2Filter[]) {
    this.record('describeInternetGateways', filters);
    return [...this.internetGateways.values()].filter((g) =>
      matches(filters, g.tags, { 'attachment.vpc-id': g.attachedVpcIds }),
    );
  }

  async createInternetGateway(input: { tags: readonly Ec2Tag[] }) {
    this.record('createInternetGateway', input);
    const internetGatewayId = this.nextId('igw');
    this.internetGateways.set(internetGatewayId, {
      internetGatewayId,
      attachedVpcIds: [],
      tags: [...input.tags],
    });
    return { internetGatewayId };
  }

  async attachInternetGateway(input: { internetGatewayId: string; vpcId: string }) {
    this.record('attachInternetGateway', input);
    const gateway = this.internetGateways.get(input.internetGatewayId);
    if (!gateway) throw new Ec2ApiError('InvalidInternetGatewayID.NotFound', 400, false);
    if (gateway.attachedVpcIds.length > 0)
      throw new Ec2ApiError('Resource.AlreadyAssociated', 400, false);
    this.internetGateways.set(input.internetGatewayId, {
      ...gateway,
      attachedVpcIds: [input.vpcId],
    });
  }

  async describeRouteTables(filters: readonly Ec2Filter[]) {
    this.record('describeRouteTables', filters);
    return [...this.routeTables.values()].filter((t) =>
      matches(filters, t.tags, { 'vpc-id': [t.vpcId] }),
    );
  }

  async createRouteTable(input: { vpcId: string; tags: readonly Ec2Tag[] }) {
    this.record('createRouteTable', input);
    const routeTableId = this.nextId('rtb');
    this.routeTables.set(routeTableId, {
      routeTableId,
      vpcId: input.vpcId,
      routes: [{ destinationCidrBlock: '10.40.0.0/16', gatewayId: 'local' }],
      associatedSubnetIds: [],
      tags: [...input.tags],
    });
    return { routeTableId };
  }

  async createRoute(input: {
    routeTableId: string;
    destinationCidrBlock: string;
    gatewayId: string;
  }) {
    this.record('createRoute', input);
    const table = this.routeTables.get(input.routeTableId)!;
    this.routeTables.set(input.routeTableId, {
      ...table,
      routes: [
        ...table.routes,
        { destinationCidrBlock: input.destinationCidrBlock, gatewayId: input.gatewayId },
      ],
    });
  }

  async associateRouteTable(input: { routeTableId: string; subnetId: string }) {
    this.record('associateRouteTable', input);
    const table = this.routeTables.get(input.routeTableId)!;
    this.routeTables.set(input.routeTableId, {
      ...table,
      associatedSubnetIds: [...table.associatedSubnetIds, input.subnetId],
    });
  }

  async describeSubnets(filters: readonly Ec2Filter[]) {
    this.record('describeSubnets', filters);
    return [...this.subnets.values()].filter((s) =>
      matches(filters, s.tags, {
        'vpc-id': [s.vpcId],
        'subnet-id': [s.subnetId],
        'availability-zone': [s.availabilityZone],
      }),
    );
  }

  async createSubnet(input: {
    vpcId: string;
    cidrBlock: string;
    availabilityZone: string;
    tags: readonly Ec2Tag[];
  }) {
    this.record('createSubnet', input);
    const subnetId = this.nextId('subnet');
    this.subnets.set(subnetId, {
      subnetId,
      vpcId: input.vpcId,
      availabilityZone: input.availabilityZone,
      cidrBlock: input.cidrBlock,
      mapPublicIpOnLaunch: false,
      tags: [...input.tags],
    });
    return { subnetId };
  }

  async modifySubnetAttribute(input: { subnetId: string; mapPublicIpOnLaunch: boolean }) {
    this.record('modifySubnetAttribute', input);
    const subnet = this.subnets.get(input.subnetId)!;
    this.subnets.set(input.subnetId, { ...subnet, mapPublicIpOnLaunch: input.mapPublicIpOnLaunch });
  }

  async describeSecurityGroups(filters: readonly Ec2Filter[]) {
    this.record('describeSecurityGroups', filters);
    return [...this.securityGroups.values()].filter((g) =>
      matches(filters, g.tags, { 'vpc-id': [g.vpcId], 'group-id': [g.groupId] }),
    );
  }

  async createSecurityGroup(input: {
    groupName: string;
    description: string;
    vpcId: string;
    tags: readonly Ec2Tag[];
  }) {
    this.record('createSecurityGroup', input);
    const groupId = this.nextId('sg');
    this.securityGroups.set(groupId, {
      groupId,
      groupName: input.groupName,
      vpcId: input.vpcId,
      ingressRuleCount: 0,
      tags: [...input.tags],
    });
    return { groupId };
  }

  async runInstances(input: Ec2RunInstanceInput) {
    this.record('runInstances', input);
    const existing = this.byToken.get(input.clientToken);
    if (existing) return this.view(existing);
    if (!this.subnets.has(input.subnetId)) {
      throw new Ec2ApiError('InvalidSubnetID.NotFound', 400, false);
    }
    const subnet = this.subnets.get(input.subnetId)!;
    const zone = subnet.availabilityZone;
    const arranged = this.arrangedRefusals.findIndex((r) => !r.zone || r.zone === zone);
    const code =
      arranged >= 0
        ? this.arrangedRefusals.splice(arranged, 1)[0]!.code
        : this.outOfStockZones.has(zone)
          ? 'InsufficientInstanceCapacity'
          : null;
    if (code) {
      this.refusals.push({ zone, clientToken: input.clientToken, code });
      const status = STATUS_BY_CODE[code] ?? 400;
      throw new Ec2ApiError(code, status, status >= 500);
    }
    const instanceId = this.nextId('i');
    this.instances.set(instanceId, {
      instanceId,
      state: this.leaveNextPending ? 'pending' : 'running',
      launchTime: new Date(),
      stateTransitionReason: null,
      availabilityZone: subnet.availabilityZone,
      tags: [...input.tags],
      request: input,
    });
    this.leaveNextPending = false;
    this.byToken.set(input.clientToken, instanceId);
    if (this.failNextAfterCreate) {
      const code = this.failNextAfterCreate;
      this.failNextAfterCreate = null;
      throw new Ec2ApiError(code, 500, true);
    }
    // EC2's own answer to a launch: `pending`, whatever it is a moment later.
    return { ...this.view(instanceId), state: 'pending' };
  }

  async describeInstances(input: Ec2DescribeInstancesInput) {
    this.record('describeInstances', input);
    if (input.instanceIds) {
      if (input.maxResults) throw new Ec2ApiError('InvalidParameterCombination', 400, false);
      for (const id of input.instanceIds) {
        if (!/^i-[0-9a-f]+$/.test(id))
          throw new Ec2ApiError('InvalidInstanceID.Malformed', 400, false);
        if (!this.instances.has(id))
          throw new Ec2ApiError('InvalidInstanceID.NotFound', 400, false);
      }
    }
    const matching = [...this.instances.values()]
      .filter((i) => !input.instanceIds || input.instanceIds.includes(i.instanceId))
      .filter((i) =>
        matches(input.filters ?? [], i.tags, {
          'instance-state-name': [i.state],
          'instance-id': [i.instanceId],
        }),
      )
      .map((i) => this.view(i.instanceId));
    const start = input.nextToken ? Number(input.nextToken) : 0;
    const size = input.maxResults ?? matching.length;
    const end = start + size;
    return {
      instances: matching.slice(start, end),
      nextToken: end < matching.length ? String(end) : null,
    };
  }

  async terminateInstances(instanceIds: readonly string[]) {
    this.record('terminateInstances', instanceIds);
    for (const id of instanceIds) {
      if (!this.instances.has(id)) throw new Ec2ApiError('InvalidInstanceID.NotFound', 400, false);
    }
    for (const id of instanceIds) {
      const instance = this.instances.get(id)!;
      if (instance.state !== 'terminated') {
        this.setState(id, 'terminated', userInitiated(new Date()));
      }
    }
  }

  /** What DescribeInstances reports — the instance without its recorded request. */
  private view(instanceId: string): Ec2Instance {
    const { request: _request, ...instance } = this.instance(instanceId);
    return { ...instance, tags: [...instance.tags] };
  }
}

/** EC2's `StateTransitionReason` for a user-initiated transition. */
export function userInitiated(at: Date): string {
  return `User initiated (${at.toISOString().slice(0, 19).replace('T', ' ')} GMT)`;
}
