---
'@motir/cli': minor
---

A run of an init card can now create the repository the card declares (MOTIR-11055). The agent writes a `repository` member into its self-report (the bare name, a role from `web`, `api`, `mobile`, `shared`, `infra` or `other`, and an optional `starterKey`; leave the key out for an empty base), and the CLI posts it with the run's own credential after the agent exits and before the leg settles, through the new `createDispatchRunRepository` operation. A member that is not well formed is ignored. A refused or failed creation prints one warning naming the repository, and the rest of the run keeps reporting.
