# Where the marketing site runs — Fly.io, a second app, and why the apex settles it

- **Status:** Accepted (2026-08-27, drafted for Story MOTIR-656 per the
  decision-subtask ladder). **No application behaviour ships in this subtask** —
  it writes this file and changes no code, no workflow and no config. What it
  binds is `motir-marketing`, a repository that does not exist yet.
- **Story / Subtask:** MOTIR-656 (8.3 Marketing site + brand mark) · Subtask
  MOTIR-2854.
- **Consumed by:** MOTIR-1455 (8.3.10, provisioning — `blocked_by` this record),
  MOTIR-1152 (8.3.6, the landing build), MOTIR-1154 (8.3.7, the SEO root),
  MOTIR-1160 (8.4.4, the published subprocessor list). §7 says which of them this
  decision changes and which it leaves alone.
- **Builds on:** `application-hosting.md` — which decided where **motir-core**
  runs and deliberately said nothing about the marketing site (its §10, _"what
  this record deliberately does NOT decide"_, does not name it either). This is a
  genuine gap rather than a clause to re-read.
- **Filed by:** MOTIR-2518's Vercel sweep (2026-08-15), which found the plan
  answering this question twice in opposite directions.
- **Supersedes / superseded by:** **AMENDED 2026-08-29 by
  `public-surface-hosts.md`** — see AMENDMENT 1 at the foot of this file. It is
  the first record in this directory about a repository other than `motir-core`.
  **§3 is additionally CORRECTED 2026-09-04 — see AMENDMENT 2**, which fixes what
  it said about the kind of IPv4 the `motir-marketing` app holds.
  **Q1 and Q3's deploy step are SUPERSEDED 2026-10-27 by AMENDMENT 3: the site
  runs on Vercel.**

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `application-hosting.md` / `production-service-stack.md`): a decision record is
> a markdown file under `docs/decisions/`, structured **Status → Context →
> Decision → Consequences**, with load-bearing facts pinned in explicit tables.
> The numbered-**Q** section shape and the per-Q rejected-alternatives table are
> `public-api-conventions.md`'s (Amendments 9–11).

---

## The problem

**The plan answers this question twice, in opposite directions, and both answers
were written correctly.**

MOTIR-1455 (8.3.10) says to create a **new Vercel project** for `motir.co` and
point the domain at it. It was written on 2026-06-30, before the move off Vercel
was decided. MOTIR-2396 closed the Vercel account down for good. It was written
as the last step of that move. Neither is aware of the other, and whoever picked
up the first would either have done work that had to be undone, or stopped and
asked the question this record exists to answer.

Three cards sit behind that unanswered question — MOTIR-1455 `blocked`, and
MOTIR-1152 and MOTIR-1154 `blocked` behind it. **The delay is the decision, not
the work:** a repository, a DNS record and a build pipeline are all cheap once
somebody says where.

### ⚠️ The ground truth was re-read for this record, and one premise had changed

MOTIR-2854 was authored on 2026-08-15 with its readings taken that day. They were
retaken on **2026-08-27** before a word of this record was written, because a
decision argued from a twelve-day-old reading of a platform somebody was actively
dismantling is a decision argued from prose.

| Reading                             | 2026-08-15 (as the card was filed)          | **2026-08-27 (this record)**                                                                                                 | Changed? |
| ----------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| `motir-marketing` repository        | does not exist                              | **still does not exist** (`gh repo view moooon-B-V/motir-marketing` → _Could not resolve to a Repository_)                   | no       |
| `motir.co` apex A / AAAA            | resolves to nothing                         | **still nothing** — no `A`, no `AAAA`, no `CNAME`                                                                            | no       |
| `www.motir.co`                      | resolves to nothing                         | **still nothing**                                                                                                            | no       |
| `app.motir.co`                      | → `66.241.124.71`, Fly                      | → `CNAME 0pl288z.motir-core.fly.dev` → `66.241.124.71`                                                                       | no       |
| **The Vercel project**              | alive; MOTIR-2396 `in_progress` retiring it | **⚠️ DELETED 2026-08-26.** MOTIR-2396 is `done`; its close-out records _"deleted, not downgraded; both production URLs 404"_ | **YES**  |
| `vercel.json`                       | present, load-bearing                       | **absent from `origin/main`** — MOTIR-2508 is `done`                                                                         | **YES**  |
| **The `motir.co` apex is occupied** | not read                                    | **`MX 0 mx1.spacemail.com` / `MX 0 mx2.spacemail.com` and `TXT "v=spf1 include:spf.spacemail.com ~all"`** — MOTIR-2596       | **NEW**  |

Two consequences, and the second is the one that decides Q1:

- **Option C is no longer an option.** The card framed it as _"available until
  MOTIR-2396 step 4 runs"_. Step 4 ran on 2026-08-26, ≈22 hours before this
  record was drafted. C is recorded below as **rejected AND expired**, with both
  reasons, because the argument against it stands on its own and would have been
  the answer even if the project were still alive — see §6.
- **The apex is not empty**, which no version of this question had read. §3 is
  where that turns out to be load-bearing.

---

## §1 — The decisions, in one table

| #      | Question                                                         | Decision                                                                                                                                               |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Q1** | Where does the `motir-marketing` site (`motir.co`) run?          | **Fly.io** — a second app, `motir-marketing`, in org `moooon`, primary region `iad`, beside `motir-core` and `motir-ai`                                |
| **Q2** | Who owns the `motir.co` apex + `www`, and what do they point at? | **The zone stays at Spaceship.** The apex takes Fly `A` + `AAAA`; `www` takes a `CNAME` to the app's Fly hostname. The mail records are untouched      |
| **Q3** | What CI deploys it?                                              | **GitHub Actions in `motir-marketing`**, mirroring motir-core's `ci.yml`: lint + build gates, then `flyctl deploy` on push to `main`, app-scoped token |
| **Q4** | Does the choice add a subprocessor row?                          | **No.** Fly.io is already row 1 of the published list, with its transfer basis closed. This is the largest single reason for Q1                        |

---

## §2 — Q1: where the marketing site runs

### The decision

**`motir.co` is served by a second Fly.io app, `motir-marketing`, in the org that
already holds `motir-core` and `motir-ai` — `moooon` — primary region `iad`.**

It is the same shape `application-hosting.md` Q1 chose for the application: a
Next app built from `output: 'standalone'` by a multi-stage `Dockerfile`, one
long-running process, `HOSTNAME=0.0.0.0`. The marketing site is a far smaller
thing than motir-core, so the build is smaller and the machine is smaller — but
**there is no second build model to learn, operate or debug**, which is the
argument.

### What it costs, stated rather than glossed

|                                    |                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Static-asset egress**            | **$0.02/GB**, with no CDN in front — exactly the trade `application-hosting.md` **Q7** accepted explicitly for motir-core, and for the same reason: it buys nothing measurable at zero traffic                                                                                               |
| **Compute**                        | One more Fly app. A marketing site is the workload `auto_stop_machines` was designed for, so the floor can be lower than motir-core's — **the pool and floor are MOTIR-1455's to set and this record does not fix them**, per Amendment 7's rule that the floor is the availability decision |
| **A worse CDN than a static host** | True, and conceded. See B below                                                                                                                                                                                                                                                              |

### Why not simply the best static host — the honest weighing of B

**B is the defensible dissent and it is a real one.** A marketing site is exactly
the workload a static CDN is best at: global points of presence, free tier,
better first-byte time from outside `iad` than a single Ashburn machine will ever
give. If the question were only _"what serves a static page best?"_, B wins.

It is rejected on three costs, in increasing order of how hard they are to
reverse:

1. **A third vendor relationship** — an account, a bill, and a row on a
   **published legal document** (§5).
2. **A second build and deploy model.** Motir would operate a container pipeline
   for two apps and a static-adapter pipeline for a third. That is the same
   objection `application-hosting.md` §5 raised against keeping Vercel for
   previews — _"two build paths that can disagree"_ — applied to a build path
   nobody has run yet.
3. **⚠️ The apex.** Whichever static host is chosen, `motir.co` is an apex, the
   apex already carries `MX` and `TXT` records, and that combination is what §3
   is about. It is the cost B does not advertise, and it is the one that would
   have surfaced during provisioning rather than during a decision.

**What would reverse this, concretely.** The trigger `application-hosting.md` Q7
already wrote for motir-core is the right one here too, and it is now shared:
when the monthly egress bill is a material fraction of compute, or a static-asset
latency complaint arrives from outside `iad`'s region, **front `motir.co` with
Cloudflare's free CDN in front of the Fly origin.** That is a DNS-level change
that keeps the origin, the pipeline and the repository exactly as they are — it
is not this decision being revisited, it is the CDN question being answered
separately, which is the point of separating them.

### Rejected alternatives

| Alternative                                                                        | Why rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B — Cloudflare Pages / Netlify** (a dedicated static host)                       | A genuinely better CDN for this workload, and a free tier, weighed in full above. Rejected on **a third vendor** (a new account, a new bill, and a new row on the published subprocessor list — §5), **a second build model**, and **the apex constraint in §3**. The CDN benefit is recoverable later without any of those costs, by fronting the Fly origin — which is why the better answer to _"we want a CDN"_ is not _"a different host"_.                                             |
| **C — keep the Vercel project alive for the marketing site only**                  | **Rejected on the merits, and separately EXPIRED.** On the merits, `application-hosting.md` §5 already rejected the isomorphic proposal for previews: _"Keeps the account, the billing relationship, `vercel.json`, and two build paths that can disagree — a preview that passes on a packaging model production no longer uses is worse than no preview."_ Every word applies. And as of **2026-08-26** the project is deleted, the integration removed, both production URLs 404. See §6. |
| **D — serve `motir.co` from `motir-core` itself**                                  | Rejected by Story 8.3's own premise — _"the public marketing site is no longer motir-core's `app/page.tsx`"_ (the 2026-06-30 re-plan) — and by MOTIR-1457, which repointed motir-core's root at `/login`. It also re-couples marketing deploys to application deploys: a copy change would ride motir-core's full CI, its migrations and its `fly-deploy` concurrency group.                                                                                                                 |
| **A static bucket on Tigris + a CDN**                                              | Motir already pays for Tigris and it is already on the subprocessor list, so this looks like B without the vendor cost. It is not: it splits the deployment across an origin and an asset-versioning problem (`application-hosting.md` Q7 rejected the same shape for motir-core's own static output), and it cannot serve a Next app — 8.3.6 builds a Next site, not a folder of HTML.                                                                                                      |
| **A fourth host nobody has named** (Render / Railway / Cloud Run / a VPS)          | The same reasoning `application-hosting.md` Q1 used to decline measuring them: each solves the problem the same way (one process, one image), so no measurement distinguishes them, and each adds a second platform relationship to operate. The working precedent — two apps already on Fly, same org, same region, same `release_command` shape — is the whole argument.                                                                                                                   |
| **Defer the decision and unblock MOTIR-1455 by letting it choose at provisioning** | This is the failure mode the card was filed against. A host choice made inside a provisioning card is made by whoever happens to run it, with no record, and it is the choice that determines Q4 — a legal-document change decided as a side effect of a dashboard session.                                                                                                                                                                                                                  |

---

## §3 — Q2: who owns the `motir.co` apex and `www`, and what they point at

### The decision

**The `motir.co` zone stays exactly where it is — at Spaceship**, the registrar,
on nameservers `launch1.spaceship.net` / `launch2.spaceship.net` (read
2026-08-27). No nameserver change, and **no existing record is touched.**

Two records are ADDED, and they are additions to a name that is already in use:

| Name           | Type             | Points at                                                                                                                                                  | Added by   |
| -------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `motir.co`     | **`A` + `AAAA`** | the `motir-marketing` Fly app's public ingress addresses — a **shared** IPv4 and a dedicated IPv6 (AMENDMENT 2) — read from `fly ips list` at provisioning | MOTIR-1455 |
| `www.motir.co` | **`CNAME`**      | the app's Fly hostname (`<hash>.motir-marketing.fly.dev`), the shape `app.motir.co` already uses                                                           | MOTIR-1455 |

### ⚠️ Why this is a decision and not a formality: the apex is already occupied

Read from `1.1.1.1` on **2026-08-27**, first-hand:

```
$ dig +short motir.co MX
0 mx1.spacemail.com.
0 mx2.spacemail.com.

$ dig +short motir.co TXT
"v=spf1 include:spf.spacemail.com ~all"

$ dig +short motir.co A      → (nothing)
$ dig +short motir.co CNAME  → (nothing)
```

Those mail records were published by **MOTIR-2596** (8.5.15, `done` 2026-08-26),
along with the Spacemail DKIM key and the shared `_dmarc` record. The A/AAAA slot
at the apex is free; **the name is not.**

**A `CNAME` cannot coexist with other record types at the same name** (RFC 1034
§3.6.2). So the apex cannot be pointed with a `CNAME` while `MX` and `TXT` records
live there — and pointing it that way would not fail loudly, it would break
_mail_. That constraint is what turns Q1 from a preference into an asymmetry:

| Host                  | How the apex is pointed                                                                                                                                                                     | Verdict                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fly (A)**           | Fly gives every app public ingress addresses — a shared IPv4 by default, a dedicated IPv6 (AMENDMENT 2); the apex takes ordinary `A` + `AAAA` records                                       | ✅ coexists with `MX` / `TXT` with nothing to work around                                                                                                                           |
| **A static host (B)** | Typically a `CNAME` to a platform hostname. At an apex that needs either an `ALIAS` / `ANAME` record type the DNS provider must offer, **or** moving the zone to the host's own nameservers | ⚠️ the second path means **re-creating seven records MOTIR-2596 published the day before**, including a two-string DKIM `TXT` — an operation whose failure mode is silent mail loss |

**This is not a knockout argument against B and is not presented as one.** A host
can be reached from an apex; Netlify publishes a load-balancer `A` record for
exactly this case, and whether Spaceship offers `ALIAS`/`ANAME` was NOT read for
this record and is not asserted either way. What the constraint does is remove
B's apparent simplicity: the cheap-looking option needs a DNS capability check
and possibly a zone migration, while the option that adds no vendor also needs no
new record type.

### ⚠️ Do not write a second `v=spf1`, and do not re-add `_dmarc`

Any card touching this zone reads MOTIR-2596's record table first. **Two `v=spf1`
records at one name is a permanent SPF `permerror` that fails CLOSED on strict
receivers**, and two `v=DMARC1` records means receivers treat the domain as having
no DMARC policy at all. Neither is a marketing-site concern until a marketing
card edits the apex — which is precisely what Q2 does.

### Rejected alternatives

| Alternative                                                       | Why rejected                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Move the `motir.co` zone to Cloudflare (or the static host's DNS) | It buys apex `CNAME` flattening and a CDN — and it costs re-creating every record MOTIR-2596 published on 2026-08-26, one day earlier, with mail authentication as the failure mode. A zone migration is a real operation, not a checkbox, and nothing here needs one. |
| Serve the marketing site at `www.motir.co` and redirect the apex  | Reverses the convention every reader expects and hands the SEO root (MOTIR-1154) a redirect to canonicalise around. The apex is where an Organization/WebSite entity signal belongs.                                                                                   |
| Point the apex at motir-core and route `/` by host header         | D by another route, plus a host-header branch in the application's middleware — the coupling 8.3 exists to remove, now invisible in the routing layer.                                                                                                                 |
| Leave `www` unpointed                                             | A bare `www.motir.co` that fails to resolve is a support question and a lost visitor for the sake of one record.                                                                                                                                                       |

---

## §4 — Q3: what CI deploys it

### The decision

**GitHub Actions in the `motir-marketing` repository, mirroring motir-core's
`ci.yml` deploy job** — which is the shape MOTIR-1455 already asks for
(_"wire CI (lint + build) mirroring motir-core's gates"_), now with the deploy
half named.

The pattern to copy, read from `motir-core/.github/workflows/ci.yml` on
`origin/main` (2026-08-27):

| Element             | motir-core                                                                                                        | `motir-marketing`                                                                                                                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gates before deploy | `needs: [lint, typecheck, build, test, coverage, e2e, e2e-at-scale]`                                              | **lint + typecheck + build.** There is no suite to gate on yet; add each gate as the repository grows one, rather than declaring `needs` on jobs that do not exist                                                                                                           |
| Trigger             | `if: github.ref == 'refs/heads/main' && github.event_name == 'push'`                                              | identical                                                                                                                                                                                                                                                                    |
| Release tool        | `superfly/flyctl-actions/setup-flyctl@master`, then `flyctl deploy --local-only --app "$FLY_APP"`                 | identical, `FLY_APP: motir-marketing`                                                                                                                                                                                                                                        |
| Concurrency         | `group: fly-deploy`, **`cancel-in-progress: false`** — a release must not be cancelled mid-flight by a newer push | identical, and its OWN group (`fly-deploy-marketing`): two repositories sharing one group name would serialise unrelated releases                                                                                                                                            |
| Credential          | `secrets.FLY_API_TOKEN`                                                                                           | **an APP-scoped deploy token** — `flyctl tokens create deploy -a motir-marketing`. Not an org token: an app token cannot create Machines and cannot see sibling apps in the same org, and it does carry `registry.fly.io` write for its own app, which is all a deploy needs |

**No preview deployments.** `application-hosting.md` Q4 dropped them for
motir-core with a named reversal trigger — _the first reviewer who is not a
committer_ — and nothing about a marketing site argues for reintroducing them
here first. A copy change is reviewed by reading the diff and running the site
locally, exactly as motir-core's are.

### Rejected alternatives

| Alternative                                         | Why rejected                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A host-side Git integration (push-to-deploy)        | It is the mechanism this project has just spent a Story removing. A build that runs somewhere other than CI is a build whose gates are configured in a dashboard, and `vercel.json` is the scar: a config file whose only job was holding a still-connected integration shut. |
| Deploy `motir-marketing` from motir-core's `ci.yml` | Couples two repositories' releases and gives motir-core's token a second app to reach. One repository, one pipeline, one app-scoped credential.                                                                                                                               |
| An org-scoped Fly token shared by all three apps    | A single credential that can deploy the product, the AI backend and a marketing page. The app-scoped token exists, is narrower, and costs one command to mint.                                                                                                                |
| Copy motir-core's full `ci.yml`                     | It declares `needs` on seven jobs, a coverage gate, nine E2E legs and a Sentry release check — none of which exist in a new repository. Mirroring the SHAPE is the instruction; copying the file makes a red pipeline on day one.                                             |

---

## §5 — Q4: does this add a subprocessor row?

### The decision

**No. Fly.io is already a subprocessor and this adds nothing to the list.**

Read from `content/legal/subprocessors.md` on `origin/main` (last reviewed
2026-08-27):

| processor                 | already listed as                                                                         | transfer basis                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Fly.io** (Fly.io, Inc.) | _"Application hosting — Motir runs as a long-running Node process"_, primary region `iad` | **DPF-certified** — active participant under the EU–US Data Privacy Framework and its UK and Swiss extensions |

Serving a second app in the same org, same region, under the same contract, adds
no company, no new category of data and no new Chapter V question. The published
list needs **no change**, and MOTIR-1160 — which is `done` — needs no re-opening.

**Answered explicitly for the other direction too, because the card asks for
that:** option B **would** have added a row. A static host serving EU visitors
receives their IP addresses in its request logs, which is personal data, so it
would be an Art. 28 processor and would need its own entry plus a verified
transfer basis under `production-service-stack.md` **Q8** — DPF certification
looked up on `dataprivacyframework.gov`, or SCCs in its DPA, and preferably both,
since _"a stack whose entire lawfulness rests on the current adequacy decision has
a single point of failure with a track record."_ That is a change to a
**published legal document**, not an internal note.

### ⚠️ What the marketing host does NOT receive, and why the answer is still "a row"

Worth pinning, because it is the counter-argument and it is half right. The
landing page's hero forwards the visitor's idea to motir-core's pre-auth draft
endpoint (MOTIR-1458) **cross-origin, from the browser** — so the idea text goes
from the visitor straight to `app.motir.co` and **never touches the marketing
host**. The marketing origin serves static assets and nothing else.

That is a genuine reduction in what the host sees; it is not a reduction to zero.
Request logs still carry IP addresses and user agents. So "it's only a static
site" would not have kept a new vendor off the list — it would only have made its
row a short one.

### Rejected alternatives

| Alternative                                                                           | Why rejected                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Treat "no new vendor" as decisive on its own                                          | It is the largest reason and it is not the only one, and a decision that rests on one axis is a decision that flips when that axis moves. §2 and §3 stand independently: the build model and the apex would argue for Fly at zero legal cost.                        |
| Add the row later, when the site actually launches                                    | The list is _"derived from what the running application actually integrates with"_ and is reviewed on a schedule; adding a vendor is the change that integrates it. Deferring the row means the published document is wrong in between.                              |
| Count the marketing host as out of scope because the hosted service is `app.motir.co` | The list's own scope note covers _"the hosted Motir service"_, and a visitor to the marketing site is a data subject whether or not they ever sign in. Spaceship is on the list for corporate correspondence alone; a public origin is not a smaller case than that. |

---

## §6 — ORDERING: this record's relationship to MOTIR-2396

**The card that filed this decision made an ordering claim, and it is now
resolved rather than pending.** Recorded in full, because a reader arriving later
will find the claim in MOTIR-2854's description and in a comment on MOTIR-2396
and should not have to work out which way it went.

**The claim, 2026-08-15:** option C was available only until MOTIR-2396 step 4
(_"delete or downgrade the Vercel project"_) ran, which is irreversible; so if C
were to be considered at all, this decision had to land first. No `blocked_by`
edge was wired, deliberately — _"serializing an in-flight retirement on a
marketing question would be the wrong trade."_

**What happened:** MOTIR-2396 ran steps 3, 4 and 5 on **2026-08-26**, on Yue's
go-ahead, and closed. Its close-out records the project as **deleted, not
downgraded**, with both production URLs returning 404, the Neon Marketplace
resource removed and the integration uninstalled. MOTIR-2508 then deleted
`vercel.json`, and it is absent from `origin/main` today.

**So:**

- **Option C expired ≈22 hours before this record was drafted.** It is rejected
  in §2 on the merits AND recorded as expired, and the merits are given first on
  purpose: **the deletion did not decide this question.** Had this record landed
  on 2026-08-15 with the project still alive, C would still have been rejected,
  by `application-hosting.md` §5's argument. Letting an expiry stand in for a
  reason would leave the next reader unable to tell a decision from an accident.
- **The deliberate absence of a `blocked_by` edge was correct, and this is the
  evidence.** The retirement was not held up, the decision was not pre-empted,
  and the only thing lost was an option nobody wanted.
- **Options A, B and D were unaffected by MOTIR-2396 throughout**, and are
  unaffected by it now. Nothing in the retirement touches Fly, a static host, or
  motir-core's own routing.

---

## Consequences — §7: what this record binds, card by card

| card                                                                               | what changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-1455** (8.3.10 — provisioning, `manual`/`human`, `blocked_by` this record) | **CHANGED, and materially.** Its title and its Vercel bullet name a platform that no longer exists. Re-scoped to Fly as part of closing MOTIR-2854 — see the amendment note below. It provisions: the `motir-marketing` GitHub repo; a Fly app `motir-marketing` in org `moooon`, region `iad`; an **app-scoped** deploy token as the repository's `FLY_API_TOKEN`; `fly certs add motir.co` and `fly certs add www.motir.co`; and the two DNS records in §3 — **without touching the apex `MX` / `TXT`.** Its second acceptance criterion reads _"motir.co resolves to its production deploy on the host MOTIR-2854 decided"_, which is now answerable. |
| **MOTIR-1152** (8.3.6 — the landing build)                                         | **UNCHANGED in substance, one constraint added.** It still builds a Next app in `motir-marketing`. The host now implies `output: 'standalone'` and a `Dockerfile`, the same pair motir-core uses — not a static export. The cross-origin draft POST (MOTIR-1458) is unaffected: it is a browser→`app.motir.co` call and the marketing origin is not in its path (§5).                                                                                                                                                                                                                                                                                    |
| **MOTIR-1154** (8.3.7 — the entity-signal SEO root)                                | **UNCHANGED.** It writes Organization/WebSite JSON-LD, the root OG image, `robots.txt` and the GSC verification at `motir.co`. §3 confirms the apex is where the site is served, which is what this card assumed. GSC verification is normally a `TXT` at the apex — one more record on a name MOTIR-2596 occupies, so it reads that table before adding one.                                                                                                                                                                                                                                                                                            |
| **MOTIR-1160** (8.4.4 — the published subprocessor list, `done`)                   | **UNCHANGED, and that is the finding rather than an omission.** §5: Fly.io is already listed with its basis closed, so this decision generates no amendment. Had B been chosen, this card would have had to re-open.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **MOTIR-2396 / MOTIR-2508** (the retirement)                                       | **UNCHANGED, and complete.** §6. Nothing here asks anything of either card; both are `done`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **`application-hosting.md`**                                                       | **UNCHANGED — not amended.** Its §10 scopes it to motir-core, and this record is a sibling rather than an amendment. Q7's CDN trigger is _cited_ by §2 as the reversal path for the CDN question, which does not modify it.                                                                                                                                                                                                                                                                                                                                                                                                                              |

### ⚠️ MOTIR-1455's re-scope is part of closing MOTIR-2854, not a later sweep

MOTIR-2854's last acceptance criterion says so explicitly. The re-scope is an
`update_work_item` on MOTIR-1455 — its title, its Vercel bullet and its second
acceptance criterion — performed in the same run that opens this record's pull
request, and recorded on that card with a link back here. It is named in this
section so that a reader who finds MOTIR-1455 still saying "Vercel project"
knows it is a defect rather than a decision.

---

## §8 — What this record deliberately does NOT decide

Each named with its trigger, so a reader in six months finds a boundary rather
than a hole:

- **The machine pool, the availability floor and the VM size for
  `motir-marketing`.** `application-hosting.md` **Amendment 7** is emphatic that
  the floor is the availability decision and that a `fly.toml` cannot provision —
  `flyctl deploy` reconciles the declared group set, and `fly scale count` is an
  operator action. **Trigger:** MOTIR-1455 sets both and records what it read from
  the platform, not from the file.
- **Whether a CDN fronts `motir.co`.** §2 hands this to
  `application-hosting.md` Q7's existing trigger — a material egress bill, or a
  latency complaint from outside `iad`. Fronting a Fly origin with Cloudflare
  changes DNS, not the host.
- **Whether Spaceship's DNS offers `ALIAS`/`ANAME`.** Not read, not asserted, and
  not needed by the decision taken (§3 needs only `A` / `AAAA` / `CNAME`). It
  would become load-bearing only if B were revisited.
- **The `motir-marketing` repository's licence, branch protection and CLA
  configuration.** MOTIR-1455 says _"consistent with motir-core"_ and that is
  enough; the open-core split (`vision.html` Principle #19) governs code, and a
  marketing site is not the PM substrate.
- **The site's content, brand mark or design.** 8.3's other cards.
- **Anything about `app.motir.co`.** It resolves to motir-core on Fly and this
  record does not touch it, its certificate, or its records.

---

## Sources

Every reading below was taken for this record on **2026-08-27** unless dated
otherwise, and each is reproducible.

| Claim                                                                                                                                                 | Source                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| The apex carries `MX` and `TXT` and no `A` / `AAAA` / `CNAME`; `www` resolves to nothing; `app.motir.co` is a `CNAME` to `0pl288z.motir-core.fly.dev` | `dig +short motir.co MX / TXT / A / AAAA / CNAME @1.1.1.1`, `dig +short www.motir.co`, `dig +short app.motir.co CNAME` |
| The zone is on Spaceship's nameservers                                                                                                                | `dig +short motir.co NS @1.1.1.1` → `launch1.spaceship.net.` / `launch2.spaceship.net.`                                |
| Those mail records were published by MOTIR-2596, and the apex SPF slot may not be written twice                                                       | MOTIR-2596 (8.5.15), `done` 2026-08-26                                                                                 |
| `motir-marketing` does not exist                                                                                                                      | `gh repo view moooon-B-V/motir-marketing` → _Could not resolve to a Repository_                                        |
| The Vercel project is deleted, not downgraded; both production URLs 404                                                                               | MOTIR-2396's close-out comment, 2026-08-26                                                                             |
| `vercel.json` is absent from `origin/main`                                                                                                            | the working tree at `f4b5793d7`; MOTIR-2508 `done`                                                                     |
| Fly.io is already a listed subprocessor, DPF-certified                                                                                                | `content/legal/subprocessors.md`, core subprocessors table + transfer-bases table                                      |
| A new vendor needs a per-vendor transfer basis, and the DPF alone is not enough                                                                       | `production-service-stack.md` **§8 / Q8**                                                                              |
| The keep-the-old-account-alive shape was already argued and rejected                                                                                  | `application-hosting.md` **§5 / Q4**, rejected-alternatives table                                                      |
| Static egress is $0.02/GB with no CDN, accepted with a trigger                                                                                        | `application-hosting.md` **§8 / Q7**                                                                                   |
| One process, one image, `output: 'standalone'`, org `moooon`, region `iad`                                                                            | `application-hosting.md` **§2 / Q1**; `motir-core/fly.toml`                                                            |
| A pool is not provisioned by `fly.toml`; the floor is the availability decision                                                                       | `application-hosting.md` **Amendment 7**, §11 and §13–§14                                                              |
| The deploy job's shape — gates, trigger, `--local-only`, the non-cancelling concurrency group                                                         | `motir-core/.github/workflows/ci.yml`, the `deploy` job                                                                |
| A `CNAME` may not coexist with other records at the same name                                                                                         | RFC 1034 §3.6.2                                                                                                        |
| The marketing site is no longer motir-core's `app/page.tsx`; the hero forwards cross-origin via a pre-auth draft API                                  | Story 8.3's 2026-06-30 re-plan; MOTIR-1458                                                                             |

---

## AMENDMENT 1 — the question widened from _where does the site run_ to _which host answers for each public surface_ (MOTIR-3879, 2026-08-29)

`docs/decisions/public-surface-hosts.md` is the successor record. This
amendment says which of the answers above still stand, so a reader who arrives
here first is not misled by a record that is right about what it was asked.

### What STANDS, unchanged

- **Q1 — the marketing site runs on Fly, as a second app `motir-marketing` in
  org `moooon`, region `iad`.** True, and now more load-bearing than when it was
  written: that application serves the WHOLE public surface, not one page.
- **Q3 — GitHub Actions in `motir-marketing` deploys it**, mirroring
  motir-core's `ci.yml`. Unchanged.
- **Q4 — no new subprocessor row.** Unchanged, and for the same reason: Fly.io
  is already row 1 with its transfer basis closed.
- **§3's warnings about the apex record set** — the single `v=spf1`, the DKIM
  key, the shared `_dmarc`, the Search Console verification `TXT`. These are
  _more_ important now, not less: the successor record's arrangement means the
  apex **does not move at all**, so any future edit to that zone is even less
  likely to be reviewed with this table in front of it.

### What is SUPERSEDED

- **Q2's framing.** This record answered _"who owns the apex and what does it
  point at"_ for a site that was about to be provisioned. The apex now points at
  `motir-marketing` and **stays there** — the successor record decides that
  every public surface moves TO that application rather than the hostname moving
  anywhere. The `A` / `AAAA` targets in §3 are therefore a record of a state that
  is no longer expected to change, rather than a provisioning instruction.
- **§2's rejected alternative D — _"serve `motir.co` from `motir-core`
  itself"_.** The reasoning given here (it re-couples marketing deploys to
  application deploys) still holds, and the successor record rejects the same
  option again on a _stronger_ ground it could not have known: `motir-core` is
  GPL-3.0 and must not carry moooon B.V.'s marketing material or legal
  documents. **The conclusion is unchanged; the argument is now the open-core
  one.**
- **§8's boundary list.** It named what this record did not decide. It did not
  name — because nobody had asked — which repository owns `/explore`, `/docs`,
  `/legal` and `/p/*`, all of which already existed in `motir-core` when this
  was written. That is the gap the successor record fills.

### What this amendment does NOT do

It does not re-open Q1, Q3 or Q4, and it changes no cited reading. The
measurements in the 2026-08-27 ground-truth table were correct on the day and
are left exactly as they were.

---

## AMENDMENT 2 — §3 called the `motir-marketing` IPv4 _dedicated_; it is **shared** (MOTIR-4338, 2026-09-04)

This amendment corrects a fact, not a decision. **Every answer in §3 stands** —
the apex is pointed with `A` + `AAAA`, `www` with a `CNAME`, and the reasoning
that made that a decision rather than a formality is untouched.

Read first-hand from Fly on **2026-09-03**, as `zhuyue11@gmail.com`:

```
$ fly ips list -a motir-marketing
 VERSION │ IP                      │ TYPE                       │ REGION │ CREATED AT
 v6      │ 2a09:8280:1::17d:93fd:0 │ public ingress (dedicated) │ global │ Aug 28 2026 00:17
 v4      │ 66.241.125.217          │ public ingress (shared)    │        │ Jan 1 0001 00:00
```

Corroborated from the public DNS on **2026-09-04**:

```
$ dig +short motir.co A     → 66.241.125.217
$ dig +short motir.co AAAA  → 2a09:8280:1::17d:93fd:0
```

**The shared IPv4 is accepted and not upgraded.** A dedicated one is $2/mo and
would buy the adjective without changing anything behind it; the full weighing
lives in `public-tenant-addresses.md` §5's AMENDMENT 1, which is where the trade
actually bites, because that is the record that hands the address to customers.

### What was corrected

| line                                         | was                                                  | is                                                                                            |
| -------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| §3's record table, `motir.co` row            | _"the app's **dedicated** addresses"_                | _"public ingress addresses — a **shared** IPv4 and a dedicated IPv6"_                         |
| §3's host-comparison table, **Fly (A)** cell | _"Fly issues a **dedicated** IPv4 and IPv6 per app"_ | _"Fly gives every app public ingress addresses — a shared IPv4 by default, a dedicated IPv6"_ |

**The Fly (A) verdict does not move.** That cell's argument is that the apex
takes ordinary `A` + `AAAA` records and therefore coexists with the `MX` and
`TXT` records MOTIR-2596 published — which is equally true of a shared address.
The comparison against a static host is unaffected in both directions.

### Why the error was worth a card

`application-hosting.md` already carried the correct reading, twice — its
2026-08-13 cost note (_"All three apps are on shared IPv4 (no $2/mo dedicated
address)"_) and §27's pricing row, both sourced to Fly's published pricing. So
the corpus contained its own refutation and nothing compared the two, while the
records a reader reaches for **while setting the value customers point an apex
at** were the wrong ones.

---

## AMENDMENT 3 — `motir.co` moves to Vercel (2026-10-27)

**Q1 is reversed: `motir.co` is served by a Vercel project, `motir-marketing`,
functions pinned to `iad1`.** Q3 stands in substance — GitHub Actions in
`motir-marketing` deploys it, behind the same gates — but the deploy step is now
`vercel build` on the runner and `vercel deploy --prebuilt --prod`, with
Vercel's Git integration turned off in `vercel.json`, so no build runs anywhere
the gates do not.

### Why

Q1 chose Fly for **one build model**, not because the site needs a long-running
process. It does not: every page is a server render or an ISR page reading
motir-core's public API. On 2026-10-27 that one argument stopped paying for
itself:

| reading (2026-10-27, Fly Prometheus and `fly logs`)                  | value                               |
| -------------------------------------------------------------------- | ----------------------------------- |
| CPU steal on both `shared-cpu-1x` machines, different physical hosts | 57–91, from ~0 earlier the same day |
| First byte, every page, while it lasted                              | 3–11 s                              |
| Requests per day, 10-21 → 10-27, mostly crawlers on filter URLs      | 130–175k                            |

Two small shared machines put every visitor behind every crawler render and
every neighbour's CPU. A serverless host scales a burst out instead of queueing
it, and leaves no machine to be starved.

### What no longer binds the site to Fly

- **Public project pages** are `motir.co/p/<identifier>` (`public-tenant-addresses.md`
  AMENDMENT 3) — the site's own host.
- **`*.motir.site` and customer-owned domains** belong to the hosted-applications
  epic (MOTIR-4527), not to this site. `public-tenant-addresses.md` Q5's
  _"on the `motir-marketing` app"_ and the certificate comments in
  `lib/publicAddresses/` describe a placement that epic will re-decide; the
  `motir.site` certificates on the old Fly app are dormant.

### What it costs

- **Vercel is back as a vendor** — reversing MOTIR-2396 for this one site. It is
  **not** a subprocessor row: it hosts the marketing site, which carries no
  customer data, and the privacy policy covers `app.motir.co`. The rows
  `subprocessors.md` publishes are for the hosted service, which stays on Fly.
- **Two build models** — the cost Q1 named. Accepted: the site is not the product.
- **§3's apex** points at Vercel (`A 216.198.79.1` and `A 64.29.17.1`, `www` → `98ddd21bbcbedce4.vercel-dns-017.com`, as Vercel recommended on 2026-10-27);
  the `MX`, `TXT`, DKIM and `_dmarc` records §3 protects are untouched.
