# ADR: Motir reaches an AWS agent instance through a host agent on 8443, over mutual TLS

- **Status:** Accepted (2026-10-24), as part of MOTIR-9470.
- **Card:** MOTIR-9470 · **Story:** MOTIR-9361 (_agent instances on an AWS account_)
- **Code:** `packages/orchestrator/src/adapters/aws/hostAgentClient.ts` (the exec client and the TLS
  options), `hostCertificates.ts` (the certificates), `persistent.ts` (`exec`, `checkLiveness`,
  `awsTerminalEndpoint`, the ingress rule), `persistentUserData.ts` (where the TLS files land),
  `lib/orchestrator/index.ts` (`awsHosterConfig`, `hosterTerminalEndpointFor`) and
  `lib/agentTerminal/relay/terminalRelay.ts` (the relay's dial).

## Context

A Fly agent instance is reached through Fly's private network: the Machines API's `exec` runs a
command in it, and the relay dials its terminal server on the 6PN address. An EC2 instance in a
hoster account has neither. Motir has to run commands in it (the run's prompt, the liveness probe,
the credential write) and dial its terminal, from the Motir app and from the relay, both of which run
outside AWS.

## Decision

### 1. A host agent on every instance

The hoster AMI runs a small HTTPS service, the **host agent**, on **port 8443** of the instance. It is
part of the image, not of the user's container, and it runs the user's container's commands with
`docker exec`. It reads its configuration from `/etc/motir/instance.json` and its TLS material from
`/etc/motir/host-agent/` (`server.crt`, `server.key`, `ca.crt`, each mode 0600), which the boot
script writes from the instance's user-data on every boot.

**Exec.** `POST /v1/exec` with a JSON body:

```json
{ "command": ["sh", "-lc", "…"], "stdin": "…optional…", "timeoutSeconds": 120 }
```

answers `200` with:

```json
{ "exitCode": 0, "stdout": "…", "stderr": "…" }
```

A non-zero exit is a result, not an error. The agent answers `408` when the command outlived
`timeoutSeconds`; the client maps that to `OrchestratorApiError(408, 'exec_timeout')`. Any other
answer, or a `200` that is not that shape, is `host_agent_refused`, and the body is never echoed (it
may hold the command's output). A refused connection, a TLS failure or the client's deadline
(`timeoutSeconds` + 15 s) is `503 unreachable`. The default timeout is 120 s.

**Terminal.** `GET /v1/terminal` (and `/v1/chat`) upgrades to the same WebSocket protocol the Fly
terminal server speaks, with the same `Motir-Relay` authorization header, so the relay's frame
handling is unchanged. `awsTerminalEndpoint` answers `wss://<public ip>:8443/v1/terminal` with the TLS
material; the address is read at dial time because it changes on every start. An instance with no
public address (not running) answers `409 no_public_address`.

### 2. Mutual TLS, trusting only the Motir hoster CA

- **One Motir-wide hoster CA** (`MOTIR_HOSTER_CA_CERT`, `MOTIR_HOSTER_CA_KEY`). Its key may be EC P-256
  or RSA.
- **A server certificate per instance**, ECDSA P-256, subject `CN=motir-instance-<id>, O=Motir`,
  minted when the instance is provisioned and valid for **365 days**. Its key exists only in the
  instance's user-data document and on the instance's disk; Motir keeps no copy.
- **One Motir client certificate** (`MOTIR_HOSTER_CLIENT_CERT`, `MOTIR_HOSTER_CLIENT_KEY`) signed by
  the same CA. The host agent accepts only a client certificate that chains to the CA.
- **Every Motir dial trusts only that CA**, never the system roots, with `rejectUnauthorized: true`,
  and **does not check the host name**: the address is a changing public IP, and a certificate signed
  by the CA is the identity. The exec client and the relay share one definition
  (`hostAgentTlsOptions`).
- **The relay holds the CA certificate and the client pair, never the CA key or the AMI id.**
  `hosterTerminalEndpointFor` reads only the account's key (to describe the instance's address) and
  those three values. The CA key is read only where instances are provisioned.

A secret store keeps a PEM on one line; a literal `\n` in any of these variables reads as a newline.

### 3. One ingress rule

The instance's own security group gets one rule, **TCP 8443 from 0.0.0.0/0**, added at launch.
`InvalidPermission.Duplicate` is success, so the second instance in a group adds nothing. The hoster
IAM policy may `ec2:AuthorizeSecurityGroupIngress` only on a security group carrying its own account
tag. The rule is IPv4 only: the instances get no IPv6 address.

### 4. The certificate's year

A server certificate expires 365 days after the instance was provisioned. An instance that lives
longer than that is unreachable until it is re-provisioned; renewing in place is left to a later card,
because no instance can be that old before this ships plus a year.

## Alternatives not taken

- **An address allow-list instead of client certificates.** The Motir app and the relay egress from
  addresses Motir does not own (Fly's shared egress), so an allow-list would admit other tenants of the
  same platform. A client certificate is an identity the address cannot give.
- **A tunnel (WireGuard, Tailscale, an AWS VPN) from Motir into the account.** Each hoster account
  would need its own tunnel endpoint, kept alive and paid for, and a per-account network plan. The host
  agent needs one port and no state.
- **SSM Run Command for exec.** It needs no open port, but it stores each command's parameters and
  output in the account's Run Command history, and a run's prompt and credential travel as a command's
  stdin. It also cannot carry an interactive terminal. Session Manager could, but only through the AWS
  SDK's own WebSocket, which the browser relay would have to proxy.
- **Checking the host name.** The address changes on every start and is not known when the certificate
  is minted; putting the IP in a SAN would force a new certificate on every start.

## Consequences

- An exec and a terminal on AWS fail closed: no CA-signed client certificate, no command.
- The host agent's stdin can carry a run credential. It travels only in the TLS body of one request;
  no Motir error or log line holds it, or a command's output.
- Rotating the client pair needs no instance change. Rotating the CA needs every instance re-provisioned,
  because each one trusts the CA it was given.
