# Running a data script against production

motir-core has five data scripts that change production rows. Each is an
explicit operator action, idempotent and safe to re-run, and each defaults to a
rehearsal where it has one:

| script                     | `pnpm` command (from a checkout)   | what it does                                                                    | flags                           |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- | ------------------------------- |
| `backfill-boards`          | `pnpm db:backfill:boards`          | seeds the default board on every project that has none                          | none (no dry run: it only adds) |
| `backfill-ci-state`        | `pnpm db:backfill:ci-state`        | recomputes `WorkItem.ciState` on every card with pull requests                  | `--dry-run`, `--workspace=<id>` |
| `backfill-fix-reason`      | `pnpm db:backfill:fix-reason`      | recomputes `WorkItem.fixReason` on every live card                              | `--dry-run`, `--workspace=<id>` |
| `backfill-author-finished` | `pnpm db:backfill:author-finished` | records `authorFinished` on the finished cards of every open plan (MOTIR-10491) | `--dry-run`, `--workspace=<id>` |
| `converge-unlanded-cards`  | `pnpm db:converge:unlanded-cards`  | puts cards the old merge rules stranded where the current rules put them        | `--dry-run`                     |

Each `pnpm` command runs `scripts/data-script-main.ts <script>`. The same entry
ships in the core image as `/app/data/data-script.mjs` (MOTIR-10465).

## Where production is, and so where the script runs

| production database                           | route                                                    |
| --------------------------------------------- | -------------------------------------------------------- |
| **RDS** (`motir_core` on the `core` instance) | **inside a core worker task, over ECS Exec** — this page |

RDS admits only core's service security group, so no GitHub runner reaches it.
The repository secret `SEED_DATABASE_URL`, which once carried a production database
URL to `workflow_dispatch` data workflows, was deleted at the AWS cutover's go
(motir-infra `docs/core-cutover.md`, step 9; read back as gone on 2026-11-07),
and those workflows were removed (MOTIR-10573). This page is the only route.
**Never recreate that secret or point anything in GitHub at RDS.**

## How it runs inside AWS

The script runs as `node /app/data/data-script.mjs <script> [flags]` in a task of
`motir-core-worker`: the task `fleet-admin` and the operator deploy check already
run in (docs/hosting/aws-deploy-check.md). It serves no traffic, ECS Exec is
enabled on it, and its task definition injects the database login parts
(`MOTIR_DB_*`) and `NODE_EXTRA_CA_CERTS`.

- **It connects as core's application role**, the role the services use, with
  `sslmode=verify-full`. The entry composes `DATABASE_URL` from the parts exactly
  as the services do, before anything loads the database client. Every row it
  writes passes the same RLS policies a request's writes pass.
- **It runs the image the worker runs**, so the script and the schema are the
  release that is live. There is no `prisma migrate deploy` step to run first: the
  deploy that rolled the worker migrated.
- **Nothing it prints carries the URL or the password.** Every line passes through
  the same redactor as `fleet-admin`.
- **The last line is `data-script exit <code>`.** `aws ecs execute-command` does not
  hand the remote exit code back, so read that line. `0` is success; `1` is a
  failed card, an interrupted sweep, an unknown flag or a database it could not
  reach.

## The caller

Run the commands from **AWS CloudShell in the services account** (`944842271421`,
region `us-east-1`), signed in through the console. The caller needs, in that
account, `ecs:ListTasks` on the cluster `motir-core` and `ecs:ExecuteCommand` on
the cluster and its tasks, and the Session Manager plugin, which CloudShell does
not carry. Install it once per session:

```sh
sudo dnf install -y https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm
```

## Run order

1. **Pick a worker task.**

   ```sh
   export TASK="$(aws ecs list-tasks --region us-east-1 --cluster motir-core \
     --service-name motir-core-worker --desired-status RUNNING \
     --query 'taskArns[0]' --output text)"
   data() {
     aws ecs execute-command --region us-east-1 --cluster motir-core --task "$TASK" \
       --container worker --interactive \
       --command "node /app/data/data-script.mjs $*"
   }
   ```

2. **Rehearse.** Every script but `backfill-boards` takes `--dry-run`, which reads
   and prints and writes nothing:

   ```sh
   data backfill-ci-state --dry-run
   ```

   - **Expected:** a `done — …` summary with the counts, then
     `data-script exit 0` as the last line.
   - **Read the counts before applying.** A hundred `failing → passing` is a repair;
     a hundred `passing → failing` is a reason to stop.

3. **Apply** — the same command without `--dry-run`:

   ```sh
   data backfill-ci-state
   ```

   - **Expected:** the same summary with `changed` in place of `would change`, and
     `data-script exit 0`.

`data` with no script, or an unknown one, prints the list of scripts and
`data-script exit 1`.

## What to know before a long sweep

- **A deploy can end the run.** A rolling deploy replaces the worker task, which
  stops the session. The CI-state and fix-reason sweeps stop between cards, and
  the author-finished sweep between plans, on `SIGTERM` and print a partial
  report, and every script resumes cheaply on a re-run, because a card that is
  already right is a no-op. Re-pick the task
  (step 1) and run it again.
- **It shares the worker's CPU and memory.** The sweeps take one card per
  transaction, so they are light, but run a long one outside a busy hour.
- **CloudTrail records the command line.** Flags are not secret (a workspace id at
  most), so this is fine. Never put a credential in one.

## Adding a script

A new production data script exports `main(argv): Promise<number>` and gets an
entry in `DATA_SCRIPTS` (`scripts/data-script-main.ts`). That entry is what ships
it in the image and what its `pnpm` command runs. Read any workspace-scoped table
under the context helper its policy admits (`withSystemContext` for a
cross-workspace sweep, then the workspace's own context): the application role
sees no row of an unbound read.
