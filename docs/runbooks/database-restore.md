# Runbook — restoring the production database (RDS point-in-time recovery)

**Scope:** motir-core's production database, `motir_core` on the `core` RDS
instance. motir-ai's `motir_ai` is on its own instance and takes the same
procedure with its own names (§8).

**Who runs it:** an operator signed in to the services account (`944842271421`,
`us-east-1`) with RDS, Secrets Manager and ECS rights, from AWS CloudShell.

Every figure on this page is either a parameter of the CDK app in motir-infra
(`lib/config/environments/production.ts`), which wins whenever it changes, or a
reading the drill in §6 must take. None is quoted from a previous platform.

---

## §1 — What production's database is now

`motir_core` lives on the `core` instance that motir-infra's data stack creates
(`lib/constructs/databases.ts`):

- **RDS for PostgreSQL**, `db.t4g.medium`, PostgreSQL 18.6, with the `vector`,
  `pg_trgm` and `pg_stat_statements` extensions.
- **Single-AZ before launch** (`multiAz: false`, MOTIR-10892): there is no
  standby until users depend on the instance.
- **Storage encrypted** with the data key, **deletion protection on**, a final
  snapshot taken if the instance is ever deleted, and **never publicly
  accessible**.
- **In the isolated subnets**, behind a security group of its own that admits
  TCP 5432 from the service security group and nothing else.

The logins are Secrets Manager entries named `<namePrefix>/<service>/<name>`,
so in production:

| secret                         | login                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `motir/core/db-core-master`    | the instance's master user                                                                                                                 |
| `motir/core/database-app`      | `motir_app`, the application login web, worker and relay use. It has no BYPASSRLS, so row-level security runs in production                |
| `motir/core/database-owner`    | the schema owner, which owns the tables the migrations change. The migrate task connects as it                                             |
| `motir/core/database-readonly` | `motir_readonly`, the diagnosis login: SELECT only, bound by row-level security, read-only and with a 30 s statement timeout (MOTIR-10594) |

Each login secret is attached to the instance, so it carries the instance's
`host` and `port` beside the user name and password, and Secrets Manager
rotates them every 30 days. A task does not receive a URL: ECS injects the
login's parts as `MOTIR_DB_HOST`, `MOTIR_DB_PORT`, `MOTIR_DB_USERNAME`,
`MOTIR_DB_PASSWORD` and `MOTIR_DB_NAME` when the task starts, and core composes
`DATABASE_URL` from them with `sslmode=verify-full`
([production-data-scripts.md](production-data-scripts.md) describes the same
path for the data scripts).

**Read the host, never the secret.** `jq` keeps the password out of the
terminal:

```sh
aws secretsmanager get-secret-value --region us-east-1 --secret-id motir/core/database-app \
  --query SecretString --output text | jq -r '.host + ":" + (.port|tostring)'
```

Then name the instance that serves that host:

```sh
aws rds describe-db-instances --region us-east-1 \
  --query "DBInstances[?Endpoint.Address=='<host>'].[DBInstanceIdentifier,DBSubnetGroup.DBSubnetGroupName,VpcSecurityGroups[0].VpcSecurityGroupId,DBParameterGroups[0].DBParameterGroupName,LatestRestorableTime]" \
  --output table
```

Keep those five values: §4 restores with them.

---

## §2 — RPO: how far back we can go

**The instance's `backupRetentionDays` parameter, 14 in production.** RDS keeps
daily snapshots and the transaction logs between them for that many days, so
point-in-time recovery reaches any second from the start of the window up to
the instance's `LatestRestorableTime`, usually a few minutes before now.

Retention is a parameter, not a property of the platform: read it in
motir-infra rather than trusting this page, and read the live value on the
instance (`BackupRetentionPeriod` in `describe-db-instances`).

**There is no second backup.** No logical dump runs on a schedule. A corruption
noticed after the window (a bad migration or a bad script, found weeks later) is
not recoverable. If 14 days is judged too short, the fix is a periodic logical
dump to object storage, which is its own card rather than this page's.

---

## §3 — RTO: how long a restore takes

**This page carries no measured RTO.** A restore here creates a new instance,
waits for it to become available, verifies a copy and then moves production
onto it (§4). None of those steps has been timed on this database, so any
number written here would be invented.

The drill in §6 takes the readings that fill this section in. Until it has run,
plan an incident on the assumption that the database half is not seconds.

---

## §4 — The procedure

### 4.0 Before anything: stop the writes you can

There is no maintenance mode. For a targeted repair (one table, one tenant)
prefer extracting the good rows (4.3) over moving production at all: it needs
no downtime and loses nothing written since the incident.

If production must move, stop the writers first by scaling the three core
services to zero tasks. That stops the app as well as its writes:

```sh
for s in web worker relay; do
  aws ecs update-service --region us-east-1 --cluster motir-core \
    --service "motir-core-$s" --desired-count 0 >/dev/null
done
```

Read each service's present `desiredCount` before you do, so 4.4 can put it
back.

### 4.1 Restore to a new instance at the candidate time

Point-in-time recovery never rewinds an instance in place. It **creates a new
instance** from the backups at the time you name. Give it the source's subnet
group, security group and parameter group, or it lands on defaults that the
services cannot reach:

```sh
aws rds restore-db-instance-to-point-in-time --region us-east-1 \
  --source-db-instance-identifier <instance> \
  --target-db-instance-identifier motir-core-pitr-<incident> \
  --restore-time 2026-11-10T20:54:00Z \
  --db-subnet-group-name <subnet group> \
  --vpc-security-group-ids <security group> \
  --db-parameter-group-name <parameter group> \
  --db-instance-class db.t4g.medium \
  --no-publicly-accessible \
  --deletion-protection
```

`--restore-time` must lie inside the window (§2). The copy is encrypted with
the source's key. Wait for it:

```sh
aws rds wait db-instance-available --region us-east-1 \
  --db-instance-identifier motir-core-pitr-<incident>
aws rds describe-db-instances --region us-east-1 \
  --db-instance-identifier motir-core-pitr-<incident> \
  --query 'DBInstances[0].Endpoint.[Address,Port]' --output text
```

### 4.2 Inspect the copy first — never a blind move

The restored instance is a full, writable copy that touches nothing in
production. Read it before anything moves. It carries the roles and passwords
production had **at the restore time**, so the logins in Secrets Manager reach
it unless a rotation ran after that time (4.4 says what to do then).

Read it from a `motir-core-worker` task over ECS Exec, as the deploy check
does (`docs/hosting/aws-deploy-check.md`), with the host substituted inside the
task so the password never leaves it:

```js
// node, inside the worker container
const { Client } = require('/app/node_modules/pg');
const c = new Client({
  host: '<restored endpoint>',
  port: Number(process.env.MOTIR_DB_PORT),
  user: process.env.MOTIR_DB_USERNAME,
  password: process.env.MOTIR_DB_PASSWORD,
  database: process.env.MOTIR_DB_NAME,
  ssl: { rejectUnauthorized: true }, // NODE_EXTRA_CA_CERTS carries the RDS bundle
});
```

`aws ecs execute-command` passes one command line, so base64 the script rather
than fight its quoting. Check, at minimum: `count(*)` on the affected table
against the same count in production; the specific rows the incident is
about; and
`select migration_name from _prisma_migrations order by finished_at desc limit 1`,
which §5 needs.

### 4.3 Decide: extract, or move production

- **Extract** (preferred, and the default for anything narrower than "the whole
  database is wrong"): copy the good rows from the restored instance into
  production. No downtime, no schema problem, no loss of what was written since
  the incident. Production never moves, and 4.4 does not apply.
- **Move production** onto the restored instance only when the damage is broad
  and recent. It **discards every write since the restore time.**

### 4.4 Moving production onto the restored instance

Production finds its database through the `host` and `port` in the login
secrets, read when each task starts. So the move is: re-point those secrets at
the restored instance, then start the services again.

**Step 1 — re-point every login secret on the instance.** The services read
`database-app`, the migrate task `database-owner`, the diagnosis login
`database-readonly`, and rotation uses the master secret, so all four move
together. The new value is written without being printed:

```sh
NEW_HOST=<restored endpoint>
NEW_PORT=5432
for id in motir/core/database-app motir/core/database-owner \
          motir/core/database-readonly motir/core/db-core-master; do
  aws secretsmanager get-secret-value --region us-east-1 --secret-id "$id" \
    --query SecretString --output text \
  | jq -c --arg h "$NEW_HOST" --argjson p "$NEW_PORT" '.host = $h | .port = $p' \
  | aws secretsmanager put-secret-value --region us-east-1 --secret-id "$id" \
      --secret-string file:///dev/stdin >/dev/null
done
```

Read each `host` back with the command in §1.

**Step 2 — check the logins reach it.** Run the 4.2 read again from a fresh
worker task, without the substitution. If a login is refused, a rotation
changed its password after the restore time: set the restored instance's
master password to the master secret's value
(`aws rds modify-db-instance --master-user-password`, from the secret, never
typed), then, as the master user, `ALTER ROLE … PASSWORD` each refused login to
its secret's current value.

**Step 3 — roll the services onto it.** Bring the schema level first (§5),
which runs the migrate task and rolls web, worker and relay through the AWS
deploy path. Then put each service's `desiredCount` back to the value you read
in 4.0.

**Step 4 — verify.** Sign in, open a work item, post a comment (the smoke in
MOTIR-1124's card is the right shape), and read `motir-core-<service>`'s
tasks running in the ECS console.

**The original instance stays.** It is what the CDK app manages and it is
deletion-protected; do not delete it during the incident. The restored instance
now serves production outside the stack, so the incident record owes a
motir-infra change that brings the stack and the instance back into one
description.

### 4.5 Clean up

When the incident closes, delete every restored instance that does not serve
production. Each was created with deletion protection, so turn it off first and
read the identifier before you do:

```sh
aws rds modify-db-instance --region us-east-1 \
  --db-instance-identifier motir-core-pitr-<incident> --no-deletion-protection --apply-immediately
aws rds delete-db-instance --region us-east-1 \
  --db-instance-identifier motir-core-pitr-<incident> --skip-final-snapshot
```

Delete any manual snapshot the incident took the same way
(`aws rds delete-db-snapshot`). **If a delete is refused for deletion
protection on an instance you did not create, you have aimed it at
production.** Read the identifier; do not turn protection off to retry.

---

## §5 — ⚠️ The half that is not the database's: the schema will have moved on

Every core deploy runs the migrate task (`prisma migrate deploy`, as the schema
owner) before it rolls any service, and records the image digest it deployed in
the SSM parameter `/<prefix>/core/image-digest` (`/motir/core/image-digest` in
production) only once every service has completed ([the AWS deploy](../aws-deploy.md)).
So the schema advances with the code, and **a restore takes the schema back
with the data**, to a shape the running image may not expect. A table the
image queries may not exist at the restore time, and its first request throws
`relation does not exist`.

**What the operator does, in order:**

1. Read the restored `_prisma_migrations` tail (4.2) and diff it against
   `prisma/migrations/` on the commit of the live digest. Read the digest:

   ```sh
   aws ssm get-parameter --region us-east-1 --name /motir/core/image-digest \
     --query Parameter.Value --output text
   ```

2. **If the restored schema is BEHIND the live image** (the common case):
   re-run the deploy of the live digest. Re-run the AWS deploy workflow run of
   that commit (Actions → AWS deploy). Its migrate task re-applies exactly the
   migrations the restored schema lacks, and the roll starts every service on
   the re-pointed secrets. Prefer this over running `prisma migrate deploy` by
   hand. ⚠️ A migration that is not safe to re-apply on a restored database
   (one that backfills, or that drops and re-creates what the restore brought
   back) needs reading before it runs: `migrate deploy` will not stop to ask.
3. **If the restored schema is AHEAD of the image you want to run** (you are
   also rolling the app back): deploy the older image whose migrations match the
   restore time, by a manual dispatch of the AWS deploy workflow on that commit,
   rather than rolling the schema forward. The deploy warns that the commit is
   not `main`'s newest and deploys it anyway.
4. Either way, **check the app after** (4.4 step 4).

---

## §6 — The drill

A restore that has not been executed is not a backup. The drill restores to a
new instance and moves nothing, so production stays read-only throughout:

1. **Baseline** in production: the table count, `count(*)` on `work_item`,
   `comment` and `job_run`, the newest and oldest work item, and how many work
   items were created in the last 24 h.
2. **Restore** to a new instance at T−24 h (4.1). Record the requested restore
   time, the instance's own `LatestRestorableTime` and the time each command
   returned.
3. **Read** the copy (4.2): the counts against the baseline less the last
   24 h, the newest work item at or before the restore time, the oldest
   unchanged, and the schema diff (§5).
4. **Time it**: request → instance available, and request → a verified query
   answering. Those two numbers are §3's RTO; write them there with the date.
5. **Delete** the copy (4.5).

The previous version of this page recorded restore times measured on Neon on 2026-08-26 (MOTIR-1164).
Those figures describe that platform, not this instance, and none of them is used here.

---

## §7 — Standing notes

- **The secrets** are the four in §1. Nothing on this page prints one: read a
  field with `jq`, and write one through a pipe.
- **Reading production** without moving a credential: a `motir-core-worker`
  task over ECS Exec, as the deploy check documents
  (`docs/hosting/aws-deploy-check.md`), or the read-only login through
  motir-infra's SSM-only jumpbox (MOTIR-10595). Never `printenv` wholesale in a
  task: a multi-line secret defeats per-line truncation.
- **A system-scoped table needs the GUC or the read is blind.** `motir_app` is
  NOBYPASSRLS and tables like `email_delivery` FORCE row-level security, so a
  plain `SELECT` returns 0 rows and no error. Wrap verification reads in
  `begin; select set_config('app.system_admin','true',true); … ; rollback;`.
- **CloudTrail records an ECS Exec command line.** Put no credential in one.

## §8 — What this runbook does not cover

- **Object storage (S3).** Attachments are not in Postgres, and a database
  restore restores no object. A restored attachment row may point at an object
  that a later deletion removed. Check the object in its bucket rather than
  assuming it is there.
- **`motir_ai`'s instance.** It has its own parameters (instance `ai`, the same
  14-day retention, secrets under `motir/ai/`) and takes the same procedure with
  those names. motir-gateway's database is on a third instance the same way.
- **A tested application-level rollback**, which is MOTIR-2516's card, not this
  one. §5 step 3 depends on it.
