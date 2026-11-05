---
'@motir/cli': minor
---

`motir auth refresh` gives the token `motir login` stored the permissions this CLI uses now, and keeps the same token (MOTIR-10185). The sandbox's debugging Postgres now runs on 18, production's major (MOTIR-10223). The API client also picks up the review verdict and review dismissal operations (MOTIR-10327) and the runner-stop advisories `validate_plan` reports (MOTIR-10350).
