# ADR: Public tenant addresses — a separate registrable domain, a workspace subdomain, and customer-owned domains on Fly certificates

- **Status:** Accepted (2026-09-03)
- **Story / Subtask:** MOTIR-3878 (Customer-owned addresses for a public project) ·
  Subtask MOTIR-4206
- **Supersedes / superseded by:** none. **§8 is AMENDED 2026-10-29 by its AMENDMENT 4**
  (the address of each hosted application, MOTIR-9790), which also supersedes §3's
  second paragraph and §4's one-project rule for an application host. **§6 (Q5) is AMENDED 2026-10-28 — see
  its AMENDMENT 1:** the `motir-marketing` Fly app it names no longer exists. It **closes** `public-surface-hosts.md`
  §4's reversal condition (AMENDMENT 6 of that record, written by this card) and
  is the record `public-surface-hosts.md` §9 named as owning per-tenant and
  custom domains.
- **Consumed by:** MOTIR-4208 (buy the base domain), MOTIR-4209 (the address
  store), MOTIR-4210 (the Fly certificates adapter), MOTIR-4211 (the settings
  design), MOTIR-4212 (the AUP clause), MOTIR-4214 (the runtime configuration), MOTIR-4215 (claim/rename the
  subdomain), MOTIR-4216 (the customer-domain lifecycle), MOTIR-4217 (the host
  contract), MOTIR-4218 (CORS + return target), MOTIR-4219 (the certificate
  status job), MOTIR-4220 (the host router), MOTIR-4221 / MOTIR-4229 (the
  settings pane), MOTIR-4222 (the canonical), MOTIR-4228 (the entitlement).

> **No application behaviour, schema or copy ships in this record.** What it
> freezes is what makes the store, the services, the router and the settings pane
> buildable — and, per the convention `work-item-type-taxonomy.md` set, every
> load-bearing fact is pinned in a table so each consumer implements against one
> authoritative source rather than re-deciding.

---

## Context

`public-surface-hosts.md` moved the public surface off `app.motir.co` and onto
`motir.co`, rendered by `motir-marketing` over `motir-core`'s public contract.
That record's §4 accepted a **deviation it named as a deviation**: tenant-authored
content would sit on `motir.co`, the _parent domain_ of the host holding the
session, where every mirror in the category puts tenant content on a **separate
registrable domain**. It accepted the residual exposure on one condition — the
session cookie stays host-only — and it wrote a reversal condition naming **this
story** as where the arrangement is revisited, for two reasons quoted verbatim
from §4:

> 1. Per-tenant addressing multiplies the exposure — one origin of user content
>    becomes one per customer, all under the session's registrable domain.
> 2. A base on a subdomain forces three-level addresses (`acme.open.motir.co`),
>    which a `*.motir.co` certificate does not cover. A separate registrable
>    domain gives `acme.motir.build` under one wildcard.

So this record has two jobs at once. It answers the ten questions the story's
other cards each encode an answer to, and in answering Q1 it discharges §4's
reversal condition — turning an accepted risk back into the arrangement every
mirror chose.

### How each answer is grounded

Every question below is answered from **rung 1** (the mirror product, _fetched_
for this record — the observation and its URL are quoted) and **rung 2** (shipped
code on `origin/main`, cited by path), per the decision-authority ladder. Where a
rung-1 reading came back **different from what this card's own brief asserted**,
the reading wins and the difference is recorded rather than quietly absorbed —
see Q7, which is the one place that happened.

---

## §1 — The decisions, in one table

| #       | Question                                               | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q1**  | Which base domain do tenant subdomains hang off?       | A **separate registrable domain**, never a subdomain of `motir.co`. The exact string is **configuration, not code** — MOTIR-4208 buys one from the ranked, RDAP-checked shortlist in §2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Q2**  | What does a subdomain NAME?                            | The **WORKSPACE**. `acme.<base>/<identifier>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Q3**  | What does a customer domain name?                      | **ONE public project, at the domain's root.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Q4**  | Which customer hostnames, and how is ownership proven? | **Any hostname the customer can point** — `CNAME` for a subdomain, `A`/`AAAA` for an apex. Ownership proven by a **`TXT` record** at `_motir-verify.<host>` BEFORE a certificate is requested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Q5**  | Who issues and renews the certificate?                 | ⚠️ **The APP is SUPERSEDED by AMENDMENT 1 (§6): `motir-marketing` left Fly on 2026-10-27 and its Fly app is destroyed; the hosted-applications epic names the app.** **Fly**, per hostname, on the **`motir-marketing`** app, driven from `motir-core` over Fly's REST certificates API. One **wildcard** `*.<base>` covers every tenant subdomain.                                                                                                                                                                                                                                                                                                           |
| **Q6**  | The canonical rule                                     | **Exactly one PRIMARY address per project.** Every other address `301`s to it; `canonical`, `og:url`, JSON-LD `@id`, the sitemap and the Atom feed all name the primary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Q7**  | Rename, release, and the reserved set                  | ⚠️ **SUPERSEDED by AMENDMENT 3 (§8).** Public project pages are served from `motir.co/p/<identifier>`, not a tenant subdomain, so this question no longer applies to them. `motir.site` subdomains are RETAINED for hosted applications and deferred to MOTIR-4527 / MOTIR-4528, under six rules: one name per workspace, no aliases, rename and release both stop serving at once, under 24h back to the pool and longer a **90-day quarantine**, one change per workspace per 30 days, **no cap**. The superseded wording — _never released, capped at 5_ — is preserved inside Amendment 3. The reserved-name set is a constant in code, enumerated in §8. |
| **Q8**  | The tier gate                                          | A new `EntitlementKind` **`custom_domains`** and **`maxCustomDomains`** on `PmEntitlements`, read through `entitlementsService`. **Tenant subdomains are free on every tier; custom domains are gated.**                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Q9**  | The open-core line                                     | The whole capability is **cloud-only** behind `isCloud()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Q10** | Branding on a customer address                         | **The public chrome stays Motir's on every address.** No white-label in this story — a decision with a reversal condition, not a deferral.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## §2 — Q1: which base domain do tenant subdomains hang off

### The decision

**A separate registrable domain.** Not `open.motir.co`, not any subdomain of
`motir.co`, now or as a convenience later.

**The exact string is NOT frozen by this record**, and that is deliberate rather
than an omission. The base domain reaches the code in exactly one way — the
`MOTIR_PUBLIC_TENANT_DOMAIN` configuration variable of §10 — so **no module
contains it**, no test asserts it, and changing it is a Fly secret and a build
arg rather than a pull request. What this record fixes is the SHAPE the string
must have; MOTIR-4208 buys one and MOTIR-4214 configures it.

### The shape the string must have

1. **A registrable domain of its own** — one label under a public suffix, so that
   a browser treats `<tenant>.<base>` and `app.motir.co` as different _sites_,
   not merely different origins.
2. **Two levels, not three** — `acme.<base>`, so that a single wildcard
   certificate `*.<base>` covers every tenant. A three-level address
   (`acme.open.motir.co`) needs a certificate `*.open.motir.co` that
   `*.motir.co` does not cover, which is §4's second reason verbatim.
3. **Submittable to the Public Suffix List** — an OPTION the shape retains, not
   a plan it commits to. §4 is explicit that nothing here waits on it, and §4's
   note now goes further: **no submission is owed at all.** Nothing served on
   this namespace can execute script, so a listing would protect against
   nothing; and if a surface that CAN ever ships, the isolation is inherited
   from the hosting platform's own already-listed domain (`fly.dev`,
   `vercel.app` and every peer are public suffixes today) rather than applied
   for. The criterion earns its place here because a namespace that could NEVER
   be listed would be a one-way door; this one is not.
4. **Registrable at Spaceship**, the registrar that already holds `motir.co`
   (`marketing-site-hosting.md` §3, nameservers `launch1.spaceship.net` /
   `launch2.spaceship.net`). No new vendor, and therefore no subprocessor row —
   a registrar is not a processor of personal data on our behalf, and §5 of that
   record's reasoning about _adding_ a vendor is what this avoids.

### The ranked shortlist, with its RDAP readings

Availability was **read, not assumed**. RDAP is the registry's own authoritative
answer: `404` is _no such registration_, `200` is _registered_.

```
$ curl -sL -o /tmp/rdap.json -w '%{http_code}' \
    -H 'Accept: application/rdap+json' https://rdap.org/domain/<name>
```

`.com` candidates were read from Verisign's registry endpoint directly, because
`rdap.org` rate-limits (`HTTP 429`) after a handful of queries and a `429` is not
an availability reading:

```
$ curl -sL -o /tmp/rdap.json -w '%{http_code}' \
    -H 'Accept: application/rdap+json' \
    https://rdap.verisign.com/com/v1/domain/<name>
```

All readings taken **2026-09-03**:

| rank  | candidate                                   | RDAP                             | reading         | why it is ranked here                                                                                                                                                                                                    |
| ----- | ------------------------------------------- | -------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | `motir.site`                                | `404`                            | **available**   | The exact rung-1 shape: Notion publishes tenant sites on `notion.site`. `acme.motir.site/ROADMAP` reads as _a site published with Motir_, which is what the page is.                                                     |
| **2** | `motir.build`                               | `404`                            | **available**   | The candidate `public-surface-hosts.md` §4 itself used to illustrate the decision, and on-brand for build-in-public.                                                                                                     |
| **3** | `motirhq.com`                               | `404`                            | **available**   | The conservative option — a `.com` carries no TLD reputation question anywhere, at the cost of a longer, less legible address.                                                                                           |
| 4     | `motir.page`                                | `404`                            | available       | HSTS-preloaded (Google TLD): a browser will not speak HTTP to it at all, which is a genuine plus for a domain hosting tenant content. Reads narrower than `.site`.                                                       |
| 5     | `motir.pub` · `motir.space`                 | `404`                            | available       | Both free; neither has a mirror precedent nor a brand argument.                                                                                                                                                          |
| —     | `motir.dev` · `motir.app`                   | `404`                            | available       | **Not recommended.** Both read as _developer tooling_ / _the application_, and `app.motir.co` already answers for the application. An address whose name contradicts what it serves is a permanent tax on explaining it. |
| —     | `motir.com`                                 | `200`, registered **2006-04-22** | **unavailable** | Recorded so the next reader does not spend the query.                                                                                                                                                                    |
| —     | `motir.works` · `motir.zone` · `motir.host` | `429`                            | **not read**    | `rdap.org` rate-limited these. They are not asserted available or unavailable.                                                                                                                                           |

**The recommendation is `motir.site`**, on the ladder: rung 1 is the default
where the mirror implements the behaviour, and Notion's is the closest mirror to
what this serves (published tenant pages, not status pages or issue boards).
`motir.build` is the runner-up and the choice between the two is a **brand call
for Yue at purchase time** — MOTIR-4208 buys whichever, and nothing in the code
changes either way.

### Rejected alternatives

| alternative                                                        | why not                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A subdomain of `motir.co`** (`acme.open.motir.co`)               | §4's reversal condition rejects it in advance on two independent grounds: it multiplies user-content origins under the session's own registrable domain, and it forces a three-level address no `*.motir.co` certificate covers. Adopting it would be re-taking the decision §4 asked this record to revisit, in the direction §4 already argued against. |
| **`motir.co` with a path prefix per tenant** (`motir.co/t/acme/…`) | This is what ships today (`/p/<identifier>`) and it is precisely the arrangement the story exists to replace. It gives the customer no address of their own, so it answers none of Q2–Q4.                                                                                                                                                                 |
| **A per-tenant domain we register on the customer's behalf**       | Motir becomes the registrant of names customers think they own — a renewal obligation, a transfer dispute and a trademark exposure per customer, for a capability Q3's customer-domain path already delivers with the customer as registrant.                                                                                                             |

---

## §3 — Q2: what a subdomain NAMES

### The decision

**A subdomain names a WORKSPACE.** The address of a public project is
`acme.<base>/<identifier>`, where `acme` is the workspace's claimed subdomain and
`<identifier>` is the project's key.

**The workspace root `acme.<base>/`** lists that workspace's public projects — or
renders the single project directly when the workspace has exactly one.

### Why the workspace and not the organization or the project

**Rung 2 settles it.** `Project.identifier` is unique **per workspace**, not per
organization — `prisma/schema.prisma` carries `@@unique([workspaceId,
identifier])` on `Project` (line 1543) and the identical shape on
`ProjectKeyAlias` (line 1748). So:

- `acme.<base>/PROD` with `acme` a **workspace** is unambiguous by construction.
- `acme.<base>/PROD` with `acme` an **organization** is not: two workspaces of one
  organization may each hold a project keyed `PROD`, and the address would need a
  second segment to disambiguate — which is the path-prefix scheme Q1 rejected,
  reintroduced one level down.

**`Organization.slug` stays exactly as `organization-url.md` §3 left it** — the
column, its `@unique`, the create-time slugify and `organizationRepository.findBySlug`
— _"internal substrate from now on, not a user-facing value."_ This record does
not touch it and does not make it user-facing.

**`organization-url.md`'s reversal condition is NOT triggered**, and this is the
one line that record's reversal asks for: it fires on _organization-addressable
URLs_ — re-basing the **authed** application's routes under a tenant segment and
retiring the cookie as the source of truth. Nothing here re-bases an authed
route; the addresses in this record are read-only public surfaces served by
`motir-marketing`, and the active organization is still resolved from the cookie
exactly as it is today.

### Rung 1

| mirror         | what it does                                                                                                       | source                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **Notion**     | A workspace claims a `notion.site` domain; pages hang under it.                                                    | `https://www.notion.com/help/connect-a-custom-domain-with-notion-sites`                        |
| **Canny**      | Every portal starts at a **company** subdomain — the default shape is `company.canny.io` — with boards underneath. | `https://help.canny.io/en/articles/1355038-setting-up-your-custom-domain` (read 2026-09-03)    |
| **Statuspage** | The default is `mycompany.statuspage.io` — the _company_, not the page.                                            | `https://support.atlassian.com/statuspage/docs/set-a-custom-domain-and-ssl/` (read 2026-09-03) |

All three name a **tenant**, and hang content underneath. None names a single
document at the subdomain level.

---

## §4 — Q3: what a CUSTOMER domain names

### The decision

**A customer domain names ONE public project, and serves it at the domain's
root.** `roadmap.acme.com/` is that project's overview; `roadmap.acme.com/board`
is its board.

So an address is exactly one of two shapes, and the store (MOTIR-4209) holds both
in one table:

| shape                                  | example                   | names                                |
| -------------------------------------- | ------------------------- | ------------------------------------ |
| **workspace subdomain + project path** | `acme.motir.site/ROADMAP` | a workspace; the project is the path |
| **customer domain at its root**        | `roadmap.acme.com/`       | one project                          |

### Why the root, and why one project

Rung 1 is unanimous: a Statuspage page and a Productboard portal each answer at
the root of the domain the customer pointed. A customer who buys
`roadmap.acme.com` means _this domain is our roadmap_; serving it at
`roadmap.acme.com/ROADMAP` would repeat the project's name in a path the customer
already encoded in the hostname.

**One project, not a workspace**, because the two directions are not symmetric: a
customer who wants several projects on their own domain can point several
hostnames (`roadmap.acme.com`, `status.acme.com`), each naming one project — which
is what the mirrors do — whereas a workspace-rooted customer domain would need a
path segment and would make the customer's own domain look like ours.

### Consequence for the router

The `motir-marketing` host router (MOTIR-4220) therefore resolves a host to a
**subject** that is either a workspace (render its project list at `/`, and
`/<identifier>/…` beneath) or a single project (render its pages at `/` directly).
That is one branch, taken once per request, and it is the reason MOTIR-4217's
contract returns the subject rather than just an id.

---

## §5 — Q4: which customer hostnames are accepted, and how ownership is proven

### The decision — which hostnames

**Any hostname the customer can point at the `motir-marketing` app.** No
restriction to subdomains, and no restriction to one hostname per domain.

| customer's hostname                  | record they create                                                                                       | why                                                                                                                                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a **subdomain** (`roadmap.acme.com`) | `CNAME` → the app's Fly hostname                                                                         | Fly: _"CNAME records work well for subdomains (like `www.example.com` or `app.example.com`). A CNAME points your custom domain at a unique `.fly.dev` hostname for your app."_                                                       |
| an **apex** (`acme-roadmap.com`)     | `A` + `AAAA` → the app's public ingress IPs — a **shared** IPv4 and a dedicated IPv6 (AMENDMENT 1 below) | Fly: _"Use A and AAAA records for most direct connections to your app. These records point your domain directly to your app's IP addresses."_ This is the same shape `marketing-site-hosting.md` §3 already relies on at `motir.co`. |

**An apex is accepted rather than refused**, and Statuspage is the mirror we
deviate from here — its help page recommends _"that you make this a dedicated
domain (e.g. `www.mycompanystatus.com`)"_. The concrete use case that earns the
deviation: a customer who has bought a domain **for** their roadmap will point its
apex, and `marketing-site-hosting.md` §3 has already proven the `A`/`AAAA` shape
works against this exact Fly app. Refusing it would be refusing the case the
capability is bought for.

> **The apex path carries a real, stateful cost — recorded because it is not
> obvious.** A customer apex is pinned to the `motir-marketing` app's **IP
> addresses**, not to a name we control — and, per AMENDMENT 1 below, the IPv4
> among them is a **shared Fly Anycast address from a platform pool**, which is
> less ours still. If those addresses ever change, every customer apex breaks at
> once and the fix is on the customer's side. A
> subdomain pointed by `CNAME` does not have this property. The settings pane
> (MOTIR-4229) therefore presents `CNAME` as the recommended shape and the apex
> as the one that needs the customer's DNS to be re-edited if we ever move — and
> `A`/`AAAA` values are read from `fly ips list` at provisioning, never
> hardcoded. (`marketing-site-hosting.md` §3's own table already reads them that
> way.) **The variables they are read INTO are §10's AMENDMENT 1, added by
> MOTIR-4278 — this paragraph decided the rule and named no carrier, and until
> it had one the pane could show the customer no pointing record at all.**

### The decision — how ownership is proven

**A `TXT` record at `_motir-verify.<host>`, carrying a per-address token, must be
present BEFORE a certificate is requested.**

**Rung 1 is split and we follow Notion.** Notion requires exactly this — its
instructions are _"Next, add a TXT record for the domain. You can copy the record
name and value for easy use"_, at the name `_notion-dcv.[subdomain]`. Canny
relies on the `CNAME` alone; its instructions ask only for a record pointing at
`cname.canny.io`.

**Why the TXT is worth its friction**, which is the half a reader will question:
without it, **whoever points a hostname at us first claims it**. Anyone can create
`motir.acme.com CNAME <our app>` for a domain they do not control; if pointing is
the whole proof, they have taken a name inside somebody else's domain and we have
issued a certificate for it. The TXT is the only step that requires **write access
to the zone**, which is the thing ownership actually means. It costs the customer
one extra record, once, at add time.

### The order of operations, fixed here because three cards implement it

1. Customer adds the hostname in settings → we store it `unverified` with a freshly
   minted token.
2. Customer creates `_motir-verify.<host> TXT "<token>"`, and the record they must
   create for traffic (`CNAME` or `A`/`AAAA`).
3. Customer presses **Verify** → we resolve the `TXT`. Match → `verified`.
4. **Only then** do we `POST` the certificate request to Fly. A certificate is
   never requested for an unverified hostname — which also keeps us clear of
   Let's Encrypt's per-registered-domain issuance limits for names we do not own.

### ⚠️ AMENDMENT 1 (2026-09-04, Bug MOTIR-4338) — the apex IPv4 is **shared**, and the stateful cost above is re-stated against that

**The record set table and the stateful-cost note both said _dedicated_. The
platform says _shared_, and has since before either sentence was written.**

Read first-hand from Fly on **2026-09-03**, as `zhuyue11@gmail.com`:

```
$ fly ips list -a motir-marketing
 VERSION │ IP                      │ TYPE                       │ REGION │ CREATED AT
 v6      │ 2a09:8280:1::17d:93fd:0 │ public ingress (dedicated) │ global │ Aug 28 2026 00:17
 v4      │ 66.241.125.217          │ public ingress (shared)    │        │ Jan 1 0001 00:00
```

Corroborated from the public DNS on **2026-09-04**, which is what a customer's
resolver sees:

```
$ dig +short motir.co A     → 66.241.125.217
$ dig +short motir.co AAAA  → 2a09:8280:1::17d:93fd:0
```

`motir-core` is the same shape (`66.241.124.71` shared v4, `2a09:8280:1::163:172a:0`
dedicated v6), so this is the org's default posture and not one app's anomaly.

### The decision: **accept the shared IPv4.** It is not upgraded to a dedicated one

`fly ips allocate-v4 -a motir-marketing` would cost $2/mo
(`application-hosting.md` §27) and would make the word _dedicated_ true. It is
**rejected**, and the reason matters more than the price:

> **A dedicated IPv4 buys protection against _Fly moving this app to a different
> address_. That is not the exposure.** Fly's shared IPv4 is the platform's own
> ingress Anycast range, not a per-app lease that rotates — and a customer apex
> is pinned to whichever address we publish either way. The blast radius the
> paragraph above sizes is **identical** under both options, so $2/mo buys the
> adjective and nothing behind it.

Nothing in this directory ever decided otherwise. `application-hosting.md` has
recorded the shared posture as a **cost reading** twice — _"All three apps are on
shared IPv4 (no $2/mo dedicated address) and Anycast IPv6 is free"_ (2026-08-13)
and §27's pricing row — but neither is a choice, and no rejected-alternatives
table anywhere weighed allocation. The word _dedicated_ in this section and in
`marketing-site-hosting.md` §3 was an **assumption written as fact**, describing a
state no app in the org has ever been in. This amendment is the first time the
question has actually been put.

### What this changes, and what stands

- **§5's record-set table** now names the kinds: shared IPv4, dedicated IPv6.
- **The stateful-cost note** now says the IPv4 is a shared platform address. Its
  conclusion is **unchanged** — an apex is still pinned to an address rather than
  a name, `CNAME` is still the recommended shape, and the values are still read
  from `fly ips list` at provisioning and never hardcoded.
- **§10's AMENDMENT 1 rows** for `MOTIR_PUBLIC_ADDRESS_A_RECORDS` /
  `..._AAAA_RECORDS` now describe the addresses they actually carry.
- **`marketing-site-hosting.md` §3** is corrected by the same card, at its table
  row and at the Fly cell of its comparison table. That cell's **verdict is
  untouched**: the Fly-vs-static-host asymmetry turns on the apex taking
  `A`/`AAAA` rather than a `CNAME`, which is true of a shared address too.
- **`application-hosting.md` needs no change.** It is the record that was right.
- **MOTIR-4314's value is unaffected.** `MOTIR_PUBLIC_ADDRESS_A_RECORDS` is
  `66.241.125.217` under this decision, which is what it was already set to.

### One correction to the report that produced this amendment

MOTIR-4338 cited `motir-marketing`'s `/docs/public-address` page as already
publishing `66.241.125.217` to customers. **It does not**, and had already
stopped by the time the card was filed: MOTIR-4316 (`81a946c`, 2026-09-03)
replaced every literal on that page with _"shown in the pane"_ and the sentence
_"These are the addresses Motir is served on, read from the platform we run on,
and they can change — the pane changes with them and a page like this one does
not."_ No IP literal exists anywhere in that repository. That is the posture this
amendment wants and it is already in force — the customer's copy of the address
comes from the pane, which reads the variables, which are read from the platform.

---

## §6 — Q5: who issues and renews the certificate

### The decision

**Fly issues and renews, per hostname, on the `motir-marketing` app, driven from
`motir-core` over Fly's REST certificates API.**

`motir-marketing` is the app the addresses point at (`fly.toml`: `app =
"motir-marketing"`, org `moooon`, region `iad`), so it is the app that must hold
the certificates. `motir-core` is where the store, the lifecycle and the settings
pane live, so it is what drives the API. The adapter (MOTIR-4210) sits **beside**
`lib/orchestrator/adapters/fly/flyMachines.ts`, not inside it — a different Fly
app, a different token, a different question.

### The endpoints, pinned

Read from `https://fly.io/docs/networking/custom-domain-api/` on **2026-09-03**:

| act                   | call                                                     |
| --------------------- | -------------------------------------------------------- |
| request a certificate | `POST /v1/apps/{app_name}/certificates/acme`             |
| check its state       | `POST /v1/apps/{app_name}/certificates/{hostname}/check` |
| remove it             | `DELETE /v1/apps/{app_name}/certificates/{hostname}`     |

The check answers with `hostname`, `configured`, `acme_requested`, `status`,
`dns_provider`, `rate_limited_until`, `certificates`, `validation`,
`dns_requirements`, `validation_errors` and `dns_records`; `validation` carries
`dns_configured`, `alpn_configured`, `http_configured` and
`ownership_txt_configured`. `dns_requirements` carries an `acme_challenge` object
with a `name` (e.g. `_acme-challenge.example.com`) and a `target` for CNAME
delegation. **MOTIR-4210 maps those fields to our own states and MOTIR-4219 polls
this endpoint** — neither invents a state machine, and neither reads a field this
table does not name without adding it here.

The base URL is Fly's Machines API host, the one `flyMachines.ts` already uses:
`https://api.machines.dev/v1`.

### The wildcard, and who cuts it

**One wildcard certificate `*.<base>` covers every tenant subdomain**, so claiming
a subdomain issues no certificate at all — it writes a row. Fly's docs are
explicit that _"Wildcard certificates are supported"_, that a wildcard hostname
must be URL-encoded (`%2A.example.com`), and that the DNS-01 challenge is the one
to use _"when you need a wildcard certificate, or when you want to generate the
certificate before directing traffic to your app"_ — which needs an
`_acme-challenge` CNAME delegation on the base domain.

**A human cuts the wildcard once, with `fly certs add`** (MOTIR-4208). It is not
in the adapter's surface, because it happens once per base domain rather than once
per address, and it happens before any code exists.

### Renewal

Fly renews. We do not hold a renewal clock, and the only renewal fact this record
pins is Fly's own: _"certificate renewals don't count against your Certificates
per Registered Domain limit."_ **What we own is SURFACING the state, not
maintaining it** — MOTIR-4219 refreshes pending and issued certificates from the
check endpoint and records the last check, so an `expired` or `revoked` state
becomes something the customer sees rather than something a visitor discovers.

> **⚠️ This is a claim about a RUNNING system, and MOTIR-4207 is what discharges
> it.** Nothing in this record proves Fly will issue a certificate for a hostname
> we do not own on an app we do — the docs say so, and docs are not the platform.
> That is exactly why the story carries a `verification` task **outside** this
> container (MOTIR-4207: _the first customer domain issues a certificate on the
> live `motir-marketing` Fly app, read from the platform_). No card inside this
> story may report the certificate path proven; the deploy is a later clock.

### Rejected alternatives

| alternative                                           | why not                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare for SaaS**                               | Purpose-built for exactly this and rejected on `marketing-site-hosting.md` §5's reasoning: it is a **third vendor** in the request path for tenant content, which is a **subprocessor row** on a published legal document plus a verified transfer basis under `production-service-stack.md` Q8 — a real legal change to buy a capability the platform we already pay for provides. |
| **A self-run ACME client** (Certbot / `lego` / Caddy) | A second certificate system beside the one the platform already operates, with its own storage, its own renewal clock, its own failure mode and its own on-call. Fly terminates TLS for this app; a certificate we issue would have nowhere to be installed without also taking over termination.                                                                                   |
| **A single wildcard covering customer domains too**   | Not expressible — a wildcard is scoped to one registrable domain, and customer domains are by definition domains we do not control. One certificate per customer hostname is not a choice.                                                                                                                                                                                          |

---

### ⚠️ AMENDMENT 1 (2026-10-28) — the certificates no longer live on `motir-marketing`; the hosted-applications epic places them

**Fly still issues per hostname over its REST certificates API, and one
wildcard still covers the tenant subdomains. What is retired is the APP this
section put them on.**

- **`motir-marketing` left Fly.** `motir.co` is served by Vercel since
  2026-10-27 (`marketing-site-hosting.md` AMENDMENT 3), and the Fly app
  `motir-marketing` was destroyed on 2026-10-28 — with it the `motir.site` and
  `*.motir.site` certificates and the app's IPs. `motir.site` serves nothing
  today.
- **Nothing this record governs is served by the marketing site any more.**
  Public project pages are `motir.co/p/<identifier>` (§8 AMENDMENT 3), and
  `motir.site` subdomains AND customer-owned domains are addresses of **hosted
  applications** — Epic MOTIR-4527 — not of `motir.co`.
- **What that epic decides:** which Fly app (or host) terminates `*.motir.site`
  and the customer domains, and therefore the value of `motir-core`'s
  `FLY_CERTS_APP` / `FLY_CERTS_TOKEN` secrets. Until then a certificate request
  through `lib/publicAddresses/adapters/fly/flyCertificates.ts` fails if those
  secrets still name `motir-marketing`. The pointing records customers are shown
  (`pointingRecords.ts`) follow that same app.

The adapter, the store, the lifecycle and the TXT-before-certificate rule of §5
are unchanged; only their target moves, and the code comments that name
`motir-marketing` describe the retired placement.

## §7 — Q6: the canonical rule

### The decision

**Exactly one address per project is PRIMARY.** Every other address for the same
page returns a **`301`** to the primary, and `canonical`, `og:url`, the JSON-LD
`@id`, the sitemap entry and the Atom feed's links all name the primary — never
the address the request arrived on.

**The default primary:**

| state                              | primary                                                |
| ---------------------------------- | ------------------------------------------------------ |
| no subdomain claimed               | `motir.co/p/<identifier>` — today's address, unchanged |
| a workspace subdomain claimed      | `<workspace>.<base>/<identifier>`                      |
| a customer domain **made primary** | that customer domain's root                            |

A customer domain becomes primary **only by an explicit act** — a _make primary_
control — never by being added. Adding a domain is a technical step that can be
half-finished (unverified, certificate pending); promoting the canonical is a
publishing decision, and conflating them would move a project's canonical to an
address that does not yet serve traffic.

### Rung 1

Canny is the mirror here and the wording is theirs: pressing **make primary** on a
custom domain is what makes Canny treat it as **the canonical source**, and once a
primary custom domain is set Canny uses that URL for public links and email
notifications rather than the `canny.io` one
(`https://help.canny.io/en/articles/1355038-setting-up-your-custom-domain` and
Canny's own feedback board, read 2026-09-03). That second half is the part worth
copying and easy to miss: **the primary is not only a `<link rel="canonical">`,
it is the address the product itself emits everywhere** — so MOTIR-4222 changes
what `publicProjectUrl()` produces, not merely what a `<head>` says.

### ⚠️ The consequence for §4's exposure, stated because it is the good news

Once a project's primary is off `motir.co`, **`motir.co/p/<identifier>` for that
project becomes a redirect** — it serves no tenant content at all. So adopting
per-tenant addresses does not merely _avoid_ multiplying §4's exposure; for every
project that claims an address it **removes** the exposure, one project at a time.
The `motir.co/p/*` route survives for projects that have claimed nothing, which is
the default and stays free.

### Rejected alternatives

| alternative                                                               | why not                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Serve every address `200`, with a `canonical` pointing at the primary** | It is what a naive reading of "canonical" suggests, and it is worse in two measurable ways: a `canonical` is a **hint** a crawler may ignore, and every non-primary address stays a live, indexable, screenshot-able copy of the tenant's content. A `301` is an instruction, and it collapses the duplicate. |
| **The address the request arrived on is canonical**                       | Two addresses then compete for the same page in exactly the way Canny's _"canonical source"_ framing exists to prevent, and a customer's own domain would rank against ours.                                                                                                                                  |

---

## §8 — Q7: rename, and the reserved-name set

### The decision — the old address is never released

> **⚠️ AMENDED by AMENDMENT 2 (2026-09-04, Story MOTIR-4451), at the end of this
> section.** The sentence below is the decision as originally taken and is kept
> verbatim; it is NARROWED there to the case it was written for — a rename — and
> joined by a second limb allowing a workspace to release its own subdomain
> against a permanent reservation. Read both.

**A renamed subdomain keeps redirecting, permanently, and is never released for
another workspace to claim.**

**Rung 2 has the precedent in-repo**: `ProjectKeyAlias` (`prisma/schema.prisma`
line 1738) is exactly this shape for project keys — its own comment says a retired
key's row _"reserves the key workspace-wide — the SAME uniqueness shape
`project.identifier` carries — so a rename's collision"_ behaves identically to a
live key's. A retained subdomain alias is that pattern one level up, and
MOTIR-4209 models it the same way: a retained alias occupies the uniqueness slot,
so nobody else can claim it and a lookup still resolves it.

**Rung 1 confirms the redirect half.** Atlassian: _"We'll store the previous URL
in your site's history and redirect all links to the new URL"_
(`https://support.atlassian.com/organization-administration/docs/update-a-product-url/`,
read 2026-09-03).

### The rename cap: **5**

> **⚠️ A rung-1 figure in this card's own brief was WRONG, and the correction is
> recorded rather than absorbed.** MOTIR-4206's description asserts _"Atlassian
> caps at 3 — decide a number"_. Read from the cited surface on **2026-09-03**,
> Atlassian's documented cap is **15**: _"You can update the subdomain up to 15
> times."_ The card's own instruction (decide a number) is unaffected, but the
> number it offered as grounds is not the mirror's. Filed as a planning bug and
> amended on the card.

**We cap at 5**, deviating from the mirror's 15 with a concrete use case, as the
ladder requires: **every rename permanently burns a name in a shared namespace**.
A workspace that renames 15 times permanently reserves 15 subdomains it does not
use. On `atlassian.net` that namespace is enormous and a decade old; ours will be
new and small, and the reserved-name set below already carves a chunk out of it.
Five is enough for a real rebrand plus mistakes, and it is a **constant one line
changes** if it turns out to bind anyone.

### The reserved-name set

A **constant in code**, enumerated here so the service (MOTIR-4215) and the ADR
cannot drift. A claim is refused when the requested label:

1. **Is one of Motir's own hostnames or a hostname a reader would read as ours:**
   `www` · `app` · `api` · `mail` · `smtp` · `imap` · `mx` · `ns` · `ns1` · `ns2` ·
   `status` · `docs` · `help` · `support` · `blog` · `admin` · `assets` · `cdn` ·
   `static` · `img` · `media` · `motir` · `moooon` · `staging` · `preview` · `dev` ·
   `test` · `internal` · `dashboard` · `account` · `accounts` · `billing` ·
   `login` · `signin` · `signup` · `auth` · `oauth` · `sso` · `webhook` ·
   `webhooks` · `ai` · `gateway`.
2. **Is an impersonation risk**: `security` · `abuse` · `postmaster` · `hostmaster` ·
   `webmaster` · `noreply` · `no-reply` · `official` · `verify` · `verification` ·
   `payment` · `payments` · `invoice` · `legal` · `privacy` · `terms`.
3. **Is structurally reserved**: any label beginning `_` (the underscore space
   `_acme-challenge` and `_motir-verify` live in), any label beginning `xn--`
   (punycode, which a homograph attack arrives as), and `motir-*` as a prefix.
4. **Fails the shape rule**: shorter than **3** characters, longer than **63**
   (the DNS label limit), not matching `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, or
   containing `--` at positions 3–4 (the punycode-lookalike form).
   **Amended 2026-10-29 (AMENDMENT 4 below):** the longest label is now **30**, and
   `--` is refused ANYWHERE in a label as a structural reservation.

The single-character and two-character exclusion is the minimum-length rule
stated as a rule rather than a list: short labels are the scarcest and the most
valuable, and they are the ones to hold back deliberately rather than hand to
whoever signs up first.

> `_motir-verify` and `_acme-challenge` are covered by rule 3 rather than by being
> listed, because rule 3 is total over the underscore space and a list is not.

### ⚠️ AMENDMENT 1 (2026-09-03, Bug MOTIR-4366) — a WORKSPACE DELETE released every name this section reserves

> ⚠️ **Superseded IN PART by AMENDMENT 3 below (2026-09-04).** The
> never-released rule this repairs is replaced by a 90-day quarantine. The
> hashed-reservation reasoning below — a digest that can be TESTED and not
> READ BACK — is RETAINED, and gains an expiry beside it.

**What §8 decided is unchanged. What it relied on was incomplete, and the gap ran
on the one path nobody drives by hand.**

The never-released rule was implemented with no machinery of its own: the
`public_address.hostname` unique index holds a name for as long as its row
exists, so _"a retired label keeps its row, the row keeps the name"_.
`public_address.workspace_id` is `onDelete: Cascade`. **So deleting a workspace
deleted the rows, and the live subdomain plus every retained alias fell back into
the global namespace for anyone to claim** — and the sole owner requesting
account erasure is exactly the person whose published address a stranger would
then inherit, along with every README, post and bookmark still pointing at it.
`accountErasureSweepService` routes a sole-membership workspace through
`workspacesService.deleteWorkspace` on a scheduled job, so this needed no
operator, raised nothing and logged nothing unusual.

**The root cause is worth recording, because the precedent this section cites is
what hid it.** §8 grounds the rule in `ProjectKeyAlias`, and that precedent is
sound _at its own level_: its uniqueness is `@@unique([workspaceId, identifier])`,
so its slot is scoped BY the tenant and cascading it away with the tenant costs
nothing. `PublicAddress.hostname` is `@unique` **globally**. The pattern was
lifted one level up and kept every visible property of its precedent except the
one that made the cascade safe.

#### The shape chosen: a separate reservation table, holding a HASH

`PublicHostnameReservation(hostname_hash @unique, retired_from_workspace_id,
retired_at)`. `workspacesService.deleteWorkspace` writes one row per
subdomain-kind address **inside the same transaction as the delete**, and a claim
refuses a hostname whose digest is present.

**Rejected: tombstoning the `PublicAddress` row in place** (nulling its tenancy,
clearing `verification_token`, keeping the name). Rejected on the erasure half
rather than the schema half — the value it retains is the literal hostname, which
is the thing the erasure was asked to remove — and secondarily because
`workspace_id` is the RLS tenancy key every policy on that table compares
against, so making it nullable would turn every one of those policies into a NULL
comparison and every `workspaceId: string` in the codebase into a lie. Keeping
`PublicAddress` cascading leaves erasure simple and complete.

#### What happens when the hostname IS the personal datum

`jane-smith.<base>` is a hostname and a name. **"Hold the reservation for ever"
and "erase on request" are reconciled by never retaining the hostname:** what is
stored is a SHA-256 digest under a versioned domain-separation prefix
(`lib/publicAddresses/hostnameReservation.ts`). The reservation is never read
back, only TESTED against a candidate a claimant supplies — which is the only
operation this rule has ever needed. `retired_from_workspace_id` is retained
alongside it and is an opaque, orphaned identifier: the workspace it names no
longer exists, nothing joins to it, and it exists so the RLS `WITH CHECK` has a
column to compare against.

**No pepper, stated as a decision with its residual.** A keyed hash resists an
offline dictionary attack better, and it also means the whole namespace silently
reopens the day the key is lost or rotated — a reservation whose promise is _for
ever_ is the wrong place for a rotatable secret. The residual is that somebody
holding a database dump can confirm a hostname they had already guessed; that is
accepted, because these hostnames were served on the public internet by the
person who chose them.

#### A CUSTOMER domain is NOT reserved

The rule is about **Motir's own namespace**. We hand out `<label>.<base>` from a
space we own, so releasing a label lets a stranger inherit someone's links.
`docs.acme.com` is the customer's property whatever becomes of their Motir
account, and reserving it for ever would lock its rightful owner out of
re-connecting it. Holding a name we do not own is not a protection.

#### Two limits, stated rather than discovered

- **No backfill.** Workspaces deleted before this amendment have already released
  their labels and left no record to reserve. Nothing can recover them.
- **A reservation is released only by an operator**, under `app.system_admin`.
  The table has no tenant `UPDATE` or `DELETE` arm and the repository has no
  remove method, so releasing a name is a deliberate act with a person behind it.

### ⚠️ AMENDMENT 2 (2026-09-04, Story MOTIR-4451) — a workspace may RELEASE its own subdomain

> ⚠️ **SUPERSEDED by AMENDMENT 3 below (2026-09-04).** Do not build from this
> section. The release path it describes is DEPLOYED but dormant, and its
> alias-plus-permanent-reservation design is replaced by six rules recorded
> there.

**This amendment does not overturn the decision above. It reads what the decision
is ABOUT**, and the distinction it turns on is small enough to be worth stating
before anything else:

> **Never-released is a rule about who may take the name NEXT. It was never a
> rule about who must keep SERVING it.**

Those were the same thing only because deleting the row was the only way to stop
serving, and Amendment 1 has already separated them: `PublicHostnameReservation`
holds a name out of the namespace with no address row behind it. So the release
keeps the property Q7 actually protects and drops the one it never argued for.

The reasoning is not read into the rule from outside — the code that implements
it says so in as many words
(`lib/publicAddresses/hostnameReservation.ts`, `reservesItsHostname`):

> _"§8's never-released rule is about MOTIR'S OWN namespace: we hand out
> `<label>.<base>` from a space we own, so releasing a label lets a stranger
> inherit somebody's inbound links."_

Nothing in that sentence is about a workspace un-claiming its OWN name.

#### The original wording, preserved

The decision at the head of this section read, and until this amendment read only:

> ~~**A renamed subdomain keeps redirecting, permanently, and is never released
> for another workspace to claim.**~~

It is not replaced. It is **narrowed to the case it was written for — a RENAME —
and joined by a second limb** for the case it never asked about:

> **A workspace may RELEASE its own subdomain. Releasing removes the live label
> and every retained alias as ADDRESSES, and reserves every one of those
> hostnames for ever, so no workspace — including the one releasing it — can ever
> claim any of them again.**

A rename is still never released in the sense §8 meant: the retired label keeps
its slot, keeps redirecting, and cannot be taken by a stranger. What changes is
that a workspace now has an exit that is not "delete the workspace".

#### The three properties, each stated so a test can be written from it

1. **The name is held for ever.** Every hostname the release removes — the live
   `workspace_subdomain` and every `workspace_subdomain_alias` — is written into
   `PublicHostnameReservation` as a digest in the SAME transaction as the delete,
   and the reserve happens BEFORE the delete. A claim for any of those labels is
   refused afterwards, by this workspace or any other, through the same
   reservation check a claim already runs.
2. **The redirect stops.** A released hostname is no longer an address: it
   resolves to no workspace and no project, so it serves a `404` rather than a
   `301` to an address that no longer exists. This is the one behaviour a reader
   of Q7's _"keeps redirecting"_ would predict wrongly — the redirect is a
   property of the retained alias ROW, and release is what removes the row.
3. **The workspace's projects fall back.** With no subdomain claimed, §7's
   default-primary table takes its first row again: `motir.co/p/<identifier>` is
   the primary for every public project in that workspace, `motir.co/p/*` serves
   `200` rather than `301`, and those projects reappear in `motir.co`'s own
   sitemap under MOTIR-4222's per-host rule.

#### What release does NOT do

**It does not touch `custom_domain` rows.** The kinds a release acts on are
chosen by `reservesItsHostname`, which already excludes them and already carries
the reason: a customer's own domain is theirs whatever happens to their Motir
account, and holding it would be _"a hostage"_ rather than a protection (the
_A CUSTOMER domain is NOT reserved_ sub-section above). A workspace with custom
domains keeps every one of them, keeps their certificate states, and a **promoted
custom domain stays the canonical** — releasing the subdomain changes nothing for
a project whose primary was already a customer domain.

#### The rename cap: **releasing does NOT reset it**

**Decided here rather than left to the implementation, because the implementation
has a default and the default is wrong.** `renamesLeft` is derived today as
`MAX_SUBDOMAIN_RENAMES − aliases.length` (`publicSubdomainService.toDto`), a count
of alias ROWS. A release deletes those rows, so an implementation that changes
nothing else hands a workspace a fresh cap on every release — and
claim → rename ×5 → release, repeated, burns names out of a shared namespace
without bound. That is precisely what the cap exists to stop, so a release that
reset it would give back through the exit what §8's cap holds at the door.

**The cap is therefore measured over the names the workspace has TAKEN OUT of the
namespace, not over the alias rows it currently holds:**

> `renamesLeft = MAX_SUBDOMAIN_RENAMES − (aliases held + hostnames this workspace
has reserved)`

For every workspace that has never released, the second term is zero and this is
the same number as before — the generalisation agrees with today's behaviour
everywhere today's behaviour is defined. After a release it keeps counting.

Two consequences worth naming rather than discovering:

- **A release charges the LIVE label too**, because the live label is also
  permanently burnt. A workspace that claims once and releases once has spent one
  of its five, not zero. That is the honest count under _names burnt in a shared
  namespace_, and the alternative — distinguishing a released alias from a
  released live label — would need a column on the reservation table that exists
  only to make the cap kinder.
- **A workspace can exhaust its cap and still release.** Release is not a claim
  and is not capped; what the cap bounds is how many times it can come BACK.
  A workspace at `renamesLeft: 0` may release, and then cannot claim again.

#### The reservation's provenance now names a LIVING workspace

`retired_from_workspace_id` was introduced by Amendment 1 for the workspace-delete
path only, and both its schema comment and its RLS migration describe it as
naming _"a workspace that no longer exists"_. **After this amendment that is no
longer true in general** — a release writes it while the workspace is very much
alive. Nothing about the column's shape or its policies has to change: it is still
not a relation, the `FOR SELECT USING (true)` read arm is still what makes a
global namespace answerable, and the `WITH CHECK ("retired_from_workspace_id" =
current_setting('app.workspace_id', true))` insert arm is satisfied by
construction, because a release runs inside `withWorkspaceContext` bound to the
workspace it is releasing. What has to change is the two COMMENTS, and correcting
them is part of the release card rather than of this one.

#### Why this is written down rather than worked around

The workaround for a subdomain somebody regrets is a hand-written database
delete, and **that is the version that actually breaks Q7**: it removes the
`public_address` row, leaves no reservation behind, and hands the label back to
the world — the exact outcome the rule exists to prevent, arrived at in the act
of respecting it.

#### The trigger, recorded honestly

This amendment exists because we hit it ourselves. `hey.motir.site` was claimed on
the `moooon` workspace as testing input and then renamed, so `motir.co/p/MOTIR`
`301`s to a subdomain nobody wants and Motir's own project pages are absent from
Motir's own sitemap — with no operation between _rename_ and _delete the
workspace_. The cost of finding it this way is our own sitemap for a few days. The
same shape reaches the first customer who claims their company name at the wrong
level, publishes it, and asks how to undo it.

### ⚠️ AMENDMENT 3 (2026-09-04, Epic MOTIR-4527 / Story MOTIR-4528) — the subdomain is NOT the address for public project pages, and the rename/release design above is REPLACED

**§8's decision is not corrected here. It is retired from the surface it was
written for, and re-decided for a different one.** Q7 asked what happens when a
workspace renames or releases the address its PUBLIC PROJECT PAGES answer on.
That address no longer exists, so the question it answers is gone, and the
answer is replaced rather than amended a third time.

Two decisions, and the second only became available because of the first.

#### 1. Public project pages are served from `motir.co/p/<identifier>`, permanently

Not a workspace subdomain, not a transitional state on the way to one. A public
project page is rendered by Motir, from Motir's data, in Motir's chrome, and
`motir.co` is the honest address for it — `acme.motir.site/WEB` implies an
ownership the page does not have. §7's canonical rule is unchanged; what changes
is which address is PRIMARY, and it is now `motir.co` for every project that has
not brought a customer domain of its own.

This makes MOTIR-4458's release the END STATE rather than a step. That card
released `hey.motir.site` and its `tak.motir.site` alias and read the canonical
back from the live index; the readings it recorded — `primaryHost: "motir.co"`,
a `200` at `motir.co/p/MOTIR`, twenty-six sitemap URLs with the six `/p/MOTIR*`
entries present — are now the intended steady state.

#### 2. `motir.site` is retained, repointed at HOSTED APPLICATIONS, and deferred

The tenant subdomain survives, addressing something else: the running
application Epic 9's hosted agent produces. That work lives in MOTIR-4527, and
the subdomain design in MOTIR-4528. Nothing in this record is implemented by
either; the sections above describe code that is DEPLOYED, and §8's caveat below
says what happens to it.

**No second domain is needed, and §2's rejection stands.** §2 ranked
`motir.app` and `motir.dev` as _not recommended_ — _"Both read as developer
tooling / the application, and `app.motir.co` already answers for the
application"_ — and the only thing that would have forced one anyway was
`motir.site` being occupied by public project pages. Decision 1 vacates it. The
Notion precedent §2 chose on (`acme.motir.site` reads as _a site published with
Motir_) reads at least as well for a hosted application as it did for a roadmap.

#### The six rules that replace Amendments 1 and 2's rename/release design

1. **One subdomain per workspace. No aliases, no redirects.** A workspace has
   one name or none. Renaming does not leave the old name serving.
2. **Rename and release both stop serving the old name immediately.** It does
   not redirect. Inbound links break, which is the honest outcome: the address
   moved.
3. **Held under 24 hours → the name returns to the pool at once. Held longer →
   a 90-day quarantine.** The only reason to hold a released name is that
   someone may hold a link to it; a label claimed and abandoned inside a day was
   never indexed, bookmarked or linked, so there is nothing to protect.
4. **One subdomain change per workspace per 30 days, counting renames AND
   deletes alike. No cap.** The count-based cap of 5 is gone.
5. **The confirm dialog names the exact date the label returns to the pool** —
   _"`hey.motir.site` stops answering now. Anyone can claim it from 3 December
   2026."_
6. **The address control lives in WORKSPACE settings**, which collapses to org
   level for a single default workspace; the project's public settings page
   echoes the resulting URL read-only. §3's answer to Q2 is unchanged and is
   independently forced by `@@unique([workspaceId, identifier])` on `Project`:
   org-scoping would make `acme.motir.site/WEB` ambiguous across two workspaces.

**Amendment 1's hashed-reservation reasoning is RETAINED, not discarded.** The
Article 17 argument for storing a digest that can be TESTED and not READ BACK
survives intact; rule 3 keeps the hash and adds an expiry beside it.

#### Why the cap of 5 could not simply be kept

It was bypassable, and by the cheapest possible route: it counted RENAMES, so
`delete → re-claim` was a rename that did not count. Rule 4 counts the CHANGE
instead, which is the thing the limit was always trying to bound.

Removing the cap without rule 3 would have been worse than keeping it. With no
limit and an unconditional quarantine, one workspace can cycle
`claim → rename` through every desirable label in the namespace and hold each
out of reach for the quarantine period, at whatever rate the API answers. Rule 3
is what makes that pointless — a cycled name was never exposed, so it never
enters quarantine — and rule 4 bounds the patient version. What neither closes:
a griefer registering many workspaces, one name each. That is signup friction
and abuse response, not a namespace rule, and it is stated here rather than
implied to be solved.

#### Why the quarantine is justified for an application and was NOT for a project page

The risk a recycled name carries is not constant across the two surfaces, and
sizing it against the wrong one is how this gets over- or under-built.

On a public project page it is modest. The attacker inheriting a name gets our
renderer, sanitised Markdown (`rehype-sanitize` strips `<script>`, `<iframe>`
and `on*` handlers; `href` protocols are allowlisted), and no custom branding —
attacker-written TEXT and outbound links, on a page that visibly belongs to
Motir. No credential form can render, and no script can run.

A hosted application has none of those constraints: arbitrary HTML, real forms,
real cookies, under our wildcard certificate, at an address the previous tenant
published and may still be linked from. **That** is what 90 days is sized
against. The calibration is the registry precedent, which answers the obvious
objection that names are not normally held at all: a lapsed gTLD is held roughly
75–80 days — up to 45 days of auto-renew grace, a MANDATORY 30-day redemption
period, then 5 days pending delete — before anyone else may take it.

#### The Public Suffix List entry this creates a need for

Tenant applications set cookies where public project pages never did. Without a
PSL entry for `motir.site`, every tenant application under `*.motir.site` shares
a cookie jar and one same-site origin for the browser's purposes. PSL additions
propagate through browser release cycles — **months** — so the submission
belongs well ahead of the first hosted application, not beside it. MOTIR-4528
carries it.

#### ⚠️ The implementation described above is DEPLOYED, and stays dormant

Amendment 2's release path, the retained aliases, the permanent reservations and
the cap of 5 all shipped on 2026-09-04 and are running in production now. They
are NOT removed by this amendment, deliberately: Motir has no customers, so the
feature is unreachable in practice, and a removal project spends a sprint on
code nobody can hit while real defects block real customers.

**The deadline is onboarding, not this record.** The implementation must be
removed or migrated to the six rules BEFORE the first customer can claim a
subdomain. A name claimed under the rules above is a name we owe someone under
rules we have abandoned.

Two defects in that dormant code are known and deliberately NOT fixed, recorded
here so they are not re-discovered and worked:

- `release.renamesAfter` in `PublicSubdomainCard.tsx` passes the CURRENT
  `renamesLeft` as the post-release figure, but a release additionally burns the
  live label. The rename branch three lines above correctly uses
  `renamesLeft - 1`; the release branch does not. On the `moooon` workspace the
  confirm read _"4 renames left"_ where the service computes 3.
- The re-claim refusal explains only the rename path — _"A subdomain that has
  been renamed away from also keeps its name…"_ — to a user whose name is held
  by a RELEASE, which the confirm dialog described as permanent and
  namespace-wide.

Rules 3–5 eliminate both: there is no cap left to miscount, and the refusal has
a date to state instead of a story to tell.

#### The trigger, recorded honestly

This amendment exists because the previous one was exercised for the first time
and the walk through it, end to end, found more than it fixed. MOTIR-4458
performed the release Amendment 2 shipped, and reading the result raised, in
order: the miscounted cap, the rename-only refusal copy, the delete-bypasses-
the-cap hole, the namespace-griefing hole that removing the cap would open, and
finally the question the whole design rested on — whether a public project page
should be on a tenant subdomain at all. It should not. The subdomain was only
ever wanted here because it could later be reused for application hosting, and
once that reuse needed the domain to itself, the page had no reason to be there.

The cost of finding it this way is one shipped story superseded the day it
merged. The alternative was finding it after a customer had claimed a name.

### ⚠️ AMENDMENT 4 (2026-10-29, Decision MOTIR-9790 · Story MOTIR-9797 · MOTIR-10025) — the address of each hosted application: `<app>--<workspace>.motir.site`, the default application, and one application per customer domain

**Source.** The approved decision page _"Decision — the address of each hosted
application: `<app>--<workspace>.motir.site`, the default application, and one
application per customer domain"_ (decision card MOTIR-9790, page
`cmvrcqw7200pwhpr7gnc8me53`, version 1, approved 2026-10-28). It is mirrored here
because a workspace will hold several applications — one per Motir repository's
production deployment (MOTIR-9797: _"The unit is the repository"_) — and every rule
above assumed it ran one.

**What it supersedes.** §3's second paragraph (_"The workspace root `acme.<base>/`
lists that workspace's public projects"_) and the `workspace` host outcome MOTIR-4217
built for it; §4 / §1 Q3 (_"A customer domain names ONE public project"_) for an
application host — a customer domain names ONE APPLICATION. **Not dropped:** §3's
answer to Q2 (a subdomain names a WORKSPACE), Amendment 3's six rules, §5's ownership
proof, §6's certificate path and its single wildcard.

#### 1. The host of an application is `<app>--<workspace>.motir.site`

- `<workspace>` is the workspace's claimed label, unchanged: every rule of Amendment 3
  and MOTIR-4528 still holds.
- `<app>` is the **application slug**, one per application record. It is derived from
  the repository name when the record is created (the derivation the preview host uses
  for `<repo-slug>`); if the slug is already used in the workspace, `-2`, `-3`… is
  appended. A workspace admin may rename it.
- The host is stored on the application record and **resolved by lookup, never
  parsed**, as the preview host is. The `--` separator is for readers; it is reserved
  only so that no workspace label can ever equal an application host.
- A workspace with no claimed label has no `motir.site` address for any of its
  applications.
- **An application rename stops the old host at once**, with no redirect and no hold:
  only the workspace holding `<workspace>` can mint a `*--<workspace>` host, so a freed
  application host can only be reused by its own workspace.
- **A workspace rename moves every application host with it**: all `*--<old>` hosts
  stop at once together with `<old>.motir.site` (Amendment 3 rule 2) and are held by
  the same reservation on `<old>`. The rename confirm names how many application hosts
  it moves.

#### 2. What the bare `<workspace>.motir.site` answers

| applications in the workspace               | `<workspace>.motir.site` answers                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **zero**, or none with a production release | the plain _no application deployed yet_ page — the state a customer domain shows; not a project page and not the shared 404                   |
| **one**                                     | that application, served directly (`200`, no redirect); it is the default automatically                                                       |
| **several**                                 | the workspace's **default application**, served directly; the first application to get an address becomes the default; an admin may change it |

- The default is a workspace setting naming one application record.
- **Removing the default never promotes another application silently**, even when one
  is left: the bare host answers _no application deployed yet_ until an admin picks one
  (the recycled-name hazard Amendment 3's quarantine is sized against).
- The default also answers on its own `<app>--<workspace>` host; Motir adds no redirect
  or canonical between the two.
- The bare host no longer lists the workspace's public projects; those live at
  `motir.co/p/<identifier>` (Amendment 3, decision 1).
- A members-only application is behind the member gate on both of its `motir.site`
  hosts; the gate is MOTIR-9817's.

#### 3. A customer domain names exactly one application

- **Chosen when the domain is added**: the add step asks which application it serves,
  and the domain row stores that application record's id. The domain still belongs to
  the workspace; §5 and §6 are unchanged.
- **Re-pointing** moves it to another application of the same workspace — one row
  update, effective on the next request, no certificate reissued, no DNS change. A
  domain never names two applications, and never names "the default" indirectly.
- **When its application is removed**, the domain stays in the workspace, unbound: its
  host answers _no application deployed yet_ and the pane offers Re-point and Remove;
  the certificate stays issued.
- **When its repository is taken over** (MOTIR-711), it stops being a Motir repo and
  Motir does not host customer repos: its `<app>--<workspace>` host and its customer
  domains keep serving for MOTIR-9802's 30-day grace window from the transfer, and both
  stop at the stop. Then the application record is removed, its host answers the shared
  404, its slug is free in the workspace, and its domains are unbound as on removal.
  **Domains do not travel with the repository.**

#### 4. The reserved separator and the label grammar — the rules `reservedNames.ts` mirrors

This is the part §8's reserved-name set changes, and the part
`tests/publicAddresses/reservedNames.test.ts` reads back from this table:

| Rule                                    | Value | Mirrored in `lib/publicAddresses/reservedNames.ts`                                    |
| --------------------------------------- | ----- | ------------------------------------------------------------------------------------- |
| reserved separator in a workspace label | `--`  | `RESERVED_SEPARATOR`; `isReservedLabel` true, `refuseLabel` → `structurally_reserved` |
| longest workspace label                 | `30`  | `MAX_SUBDOMAIN_LENGTH`                                                                |
| shortest application slug               | `3`   | `MIN_APPLICATION_SLUG_LENGTH`                                                         |
| longest application slug                | `30`  | `MAX_APPLICATION_SLUG_LENGTH`                                                         |

1. **A workspace label may not contain `--` anywhere**; `refuseLabel` refuses it as
   `structurally_reserved`. This replaces rule 4's _"`--` at positions 3–4"_ clause with
   a stricter rule, and closes the gap where `refuseLabel` never enforced that clause
   (`refuseLabel('ab--cd')` answered `null`).
2. **`MAX_SUBDOMAIN_LENGTH` drops from 63 to 30** for a workspace label, so
   `<app>--<workspace>` (at most 30 + 2 + 30 = 62 characters) always fits one DNS label
   (RFC 1035, 63).
3. **The application-slug rule** (`refuseApplicationSlug`): `LABEL_GRAMMAR`, 3 to 30
   characters, no `--`. The minimum of 3 matters: a 2-character slug would put `--` at
   positions 3–4 of the full label — the punycode-lookalike form — and with the grammar
   it also rules out a leading `xn--`.
4. **The listed reserved names do not apply to application slugs.** The full label
   always ends in the tenant's own workspace label, which is where the reserved set
   protects Motir's names.
5. **No new reserved label.** `preview` is already reserved, so no workspace can collide
   with `preview.motir.site`. Rules 1 and 2 of §8's set are unchanged.

#### Why this option, and why the other two lose

| option                                      | why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<app>--<workspace>.motir.site`, **chosen** | One label, so the single `*.motir.site` wildcard §6 holds covers every application and claiming or renaming issues no certificate. With `motir.site` on the PSL (MOTIR-5767) every application is its own registrable domain, so its own site and cookie jar. Netlify (`staging--mysitename.netlify.app`) and Vercel (`<project>-<scope>.vercel.app`) use the same single-label shape, and it matches the preview host `pr-<n>--<repo-slug>.preview.motir.site`. Its costs: an application slug per repository, a default setting per workspace, and `--` reserved in workspace labels. |
| `<app>.<workspace>.motir.site`, rejected    | `*.motir.site` does not cover a second level, so every claimed workspace needs its own wildcard certificate, issued and renewed on every claim and rename (Let's Encrypt: 50 per registered domain per 7 days). Under a `motir.site` PSL entry, `acme.motir.site` would be the registrable domain, so its applications would share one site and could set each other's cookies. No reference host nests apps under a team label.                                                                                                                                                        |
| `<workspace>.motir.site/<app>/…`, rejected  | Every app would run under a base path every framework must honour, and two apps would share one origin — cookies, storage and service workers colliding. No reference host does this.                                                                                                                                                                                                                                                                                                                                                                                                   |

#### The change list it gives the serving cards — recorded, not performed

The decision named, card by card, the sentence each consumer must change on its next
pass. This record carries the list; **it does not edit those cards and nothing here
waits on them.**

- **MOTIR-4528's children.** MOTIR-9507 (publicSubdomainService): a rename or release of
  the workspace label stops every `*--<label>` application host in the same transaction;
  claim and rename refuse `--` and labels over 30 through `refuseLabel` (this amendment
  makes `refuseLabel` do so). MOTIR-9510 / 9513 / 9514 (routes, design, control): the
  rename / release preview and confirm name how many application hosts move; the field
  error for `--` and the 30-character limit is its own copy. MOTIR-9511 (host contract):
  a workspace host answers the default `application`, `no_application`, or a 404, and a
  `<app>--<workspace>` host answers its application by lookup, under the 30-second cache
  bound. MOTIR-9516 (Vitest gate): _"the new hostname still resolves to the workspace"_
  becomes _"… to the workspace's default application, or `no_application`"_, plus a case
  that a rename stops every `*--<old>` host. MOTIR-9517 (marketing gate): kind
  `application` / `no_application`. MOTIR-9512 (router): the project-list `workspace`
  arm goes, replaced by MOTIR-9527's forward. **New work owed, no card yet:** resolving
  `<app>--<workspace>` and the bare host to an application record; the per-workspace
  default-application setting and its control; the application-slug rename.
- **MOTIR-4533's children.** MOTIR-9521: the host contract returns the application the
  domain names. MOTIR-9522 (pane design): an application picker in Add domain, Re-point
  on the row, and a _names no application_ state. MOTIR-9523 (store): the row carries a
  nullable `applicationId` (null = unbound). MOTIR-9524 (lifecycle): `POST` takes
  `{ hostname, applicationId }`, a re-point action, and removing an application unbinds
  its domains in the same transaction. MOTIR-9525 (host contract):
  `resolveApplicationTarget(applicationId)` read from the domain row, the `application`
  outcome naming `{ id, slug }`, and `primaryHostsForProjects` / `addressesForProject`
  answering `motir.co/p/<identifier>` only. MOTIR-9527 (router): the outcome gains the
  application, and the same forward arm serves `motir.site` application hosts.
  MOTIR-9529 (pane): the DTO carries the named application. MOTIR-9532 (docs): _"the
  application you chose for it"_, re-pointing and removal. MOTIR-9530 / 9531 / 9533
  (gates and E2E): re-point, unbound-after-removal, and a two-application workspace.
  MOTIR-9819: _"to the application it names"_.
- **MOTIR-9797** (this story): the application record carries `slug` and its
  `motir.site` host, the workspace carries `defaultApplicationId`, and this amendment
  lands §4 above.

#### What this amendment does NOT decide

The workspace label's own rules beyond the cap and the `--` refusal (Amendment 3,
MOTIR-4528); a primary or redirect between a customer's domains, the cache bound for a
removed host, and the member gate on a customer host (MOTIR-9521); when Motir stops
serving an application at takeover (MOTIR-9802, MOTIR-9800); who may open an
application (MOTIR-9817); the preview host (MOTIR-9791); where an application runs
(MOTIR-9797, MOTIR-9791); and the application-slug derivation itself, which reuses the
preview's.

---

## §9 — Q8: the tier gate

### The decision

**A new `EntitlementKind` `custom_domains`, and a new `maxCustomDomains` field on
`PmEntitlements`** (`lib/billing/entitlements.ts`), asserted through
`entitlementsService` exactly as every other §4 cap is.

**Tenant subdomains are FREE on every tier. Custom domains are gated.**

| tier         | `maxCustomDomains` (provisional) |
| ------------ | -------------------------------- |
| `free`       | `0`                              |
| `scaled`     | `5`                              |
| `enterprise` | `null` (unlimited)               |
| `meta`       | `null` (unlimited)               |

### ⚠️ The VALUES are `billing-tiering.md`'s, not this record's

This story **ships the capability and the gate it reads, not the price.** The four
numbers above are a provisional seed so MOTIR-4228 has something total to write;
changing them is a one-line edit in `entitlements.ts` with **no migration**,
exactly as `PM_ENTITLEMENTS`'s own comment says (_"a tunable seed policy — a later
change is a one-line edit here, no schema migration"_). **`billing-tiering.md` §4
owns the numbers, and Stories 8.1 / 8.6 are where they are set.** A card that
wants to argue about `5` is arguing with that record, not this one.

### The shape MOTIR-4228 implements, pinned

Rung 2, read from `lib/services/entitlementsService.ts`: every count cap is the
same five lines, and the custom-domain assert is the sixth instance of them, not a
new pattern.

```ts
async assertWithinCustomDomainCap(
  organizationId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (!isCloudBilling()) return;
  await lockOrgRowOrRefuse(organizationId, tx);
  const { maxCustomDomains } = entitlementsFor(await tierForOrgInTx(organizationId, tx));
  if (maxCustomDomains === null) return;
  const current = await publicAddressRepository.countCustomDomainsByOrganization(organizationId, tx);
  if (current >= maxCustomDomains) {
    throw new EntitlementExceededError('custom_domains', { limit: maxCustomDomains, usage: current });
  }
}
```

Three properties of that shape are **required, not stylistic**, and the module's
own header says why: the org row is locked `FOR UPDATE` before the count is read
(a count-then-write guard with no lock fails under a warm pool), the assert runs
**inside the same transaction as the create it guards**, and it returns early when
`isCloudBilling()` is false so a self-hosted build never consults a cap. `free: 0`
means the assert refuses on the **first** domain, which is what makes
`EntitlementExceededError('custom_domains', …)` the upgrade prompt's trigger rather
than a special-cased empty state.

### Rung 1 — the whole category gates this, and only this

| mirror           | subdomain                            | custom domain                                                                                                          |
| ---------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Notion**       | included                             | **paid add-on** — _"This feature is only available on paid plans"_, `$10 per month` (`$8` annually) on top of the plan |
| **Statuspage**   | included (`mycompany.statuspage.io`) | **excluded from Free** — _"Public pages can use a custom domain, except for pages on the Free plan"_                   |
| **Canny**        | included (`company.canny.io`)        | paid                                                                                                                   |
| **Productboard** | included                             | on a _"Host Portal on your domain"_ toggle                                                                             |

All read 2026-09-03. Nobody gates the tenant subdomain, and everybody gates the
custom domain — which is the split this record adopts unchanged.

---

## §10 — The configuration this record decides

Named here so MOTIR-4214 can run **before any code lands**, which is the whole
point of deciding it in a document.

| variable                          | app               | kind                                                        | value                                                        | read by                                                                            |
| --------------------------------- | ----------------- | ----------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `MOTIR_PUBLIC_TENANT_DOMAIN`      | `motir-core`      | **runtime secret / env**                                    | the base domain (`motir.site`)                               | the address store, the subdomain service, the host contract, the canonical builder |
| `NEXT_PUBLIC_MOTIR_TENANT_DOMAIN` | `motir-marketing` | **`NEXT_PUBLIC_*` BUILD ARG**, in `fly.toml` `[build.args]` | the same base domain                                         | the host router, the per-host canonical / sitemap / robots                         |
| `FLY_CERTS_TOKEN`                 | `motir-core`      | **runtime secret**                                          | a Fly API token **scoped to the `motir-marketing` app only** | the certificates adapter, the certificate status job                               |
| `FLY_CERTS_APP`                   | `motir-core`      | env                                                         | `motir-marketing`                                            | the certificates adapter                                                           |

**AMENDMENT 1 (2026-09-03, MOTIR-4278) — three rows this table OMITTED, and the
omission is what §5's table could not be implemented without.**

| variable                            | app          | kind | value                                                                                        | read by                                  |
| ----------------------------------- | ------------ | ---- | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `MOTIR_PUBLIC_ADDRESS_CNAME_TARGET` | `motir-core` | env  | the app's own hostname (`motir-marketing.fly.dev`)                                           | `lib/publicAddresses/pointingRecords.ts` |
| `MOTIR_PUBLIC_ADDRESS_A_RECORDS`    | `motir-core` | env  | the app's public ingress IPv4 addresses — **shared**, per §5's AMENDMENT 1 — comma-separated | the same module                          |
| `MOTIR_PUBLIC_ADDRESS_AAAA_RECORDS` | `motir-core` | env  | the app's public ingress IPv6 addresses (dedicated), comma-separated                         | the same module                          |

**Why they were missing, said plainly.** §5's table decides that a subdomain
creates a `CNAME` and an apex creates `A` + `AAAA`, and §5's order of operations
has the customer create that record **at step 2 — before _Verify_**. Both are
correct and neither is implementable without the VALUES, which this section is
the only place that names. Nothing caught it: the adapter parses Fly's own
`dns_requirements`, the DTO's type union allows all three record types, and the
settings pane renders whatever it is handed — so every layer passed its own tests
while the array the customer reads carried only the ownership `TXT`
(MOTIR-4278).

**Three rules on these rows.**

- **They name what the value IS, not who supplies it** — deliberately not
  `FLY_*`. §6 makes the certificate provider a PORT so Fly is replaceable;
  deriving the `CNAME` target as `${FLY_CERTS_APP}.fly.dev` inside a service
  would weld Fly through the service layer and put a Fly name outside the
  adapter directory, which is the leak `certificatePortBoundary.test.ts` exists
  to catch.
- **The values are READ FROM THE PLATFORM at provisioning, never hardcoded** —
  `fly ips list -a motir-marketing` for the two address rows, the app's own
  `.fly.dev` hostname for the third. This is §5's own recorded rule ("`A`/`AAAA`
  values are read from `fly ips list` at provisioning, never hardcoded"), and the
  address lists are plural because an app may hold more than one of each.
- **Unset omits the ROW rather than defaulting** — `tenantDomain.ts`'s rule,
  which applies here for the same reason it applies there: a guessed value would
  land in DNS instructions a customer follows, pointing a domain they own at
  something we do not operate.

**Two of the first four rows carry a rule rather than a value.**

- **`NEXT_PUBLIC_MOTIR_TENANT_DOMAIN` is a BUILD ARG, not a Fly secret**, and
  setting it as a secret would silently do nothing. `motir-marketing`'s
  `lib/siteOrigin.ts` states the reason for exactly this class of variable:
  _"Every consumer here is statically rendered … so the value is baked into the
  output by `next build` exactly as `NEXT*PUBLIC*_`is — setting it as a Fly
SECRET would do nothing."* It travels in`fly.toml`'s `[build.args]`, beside
`NEXT_PUBLIC_MOTIR_APP_ORIGIN`.
- **`FLY_CERTS_TOKEN` is scoped to `motir-marketing` and has NO fallback to a
  general Fly token.** This follows `flyMachines.ts`'s rule verbatim —
  _"`FLY_FLEET_API_TOKEN`, never the token `motir-ai` or `motir-gateway` deploy
  with … a token that could reach the production org is the one thing that could
  quietly undo that, so the config accessor names a distinct variable and there is
  no fallback to a general Fly token."_ The reason transfers exactly: this token's
  only job is to add and remove certificates on one app, and a deploy-capable
  token in a code path driven by customer input is a much larger grant than the
  path needs.
- **Config is read at CALL time, never at module load** — `appAuth.ts`'s contract,
  restated in `flyMachines.ts`: a self-hosted deploy that never provisions
  certificates must not crash on boot; it must simply be unable to reach the path.

---

## §11 — Q9: the open-core line

**The whole capability is cloud-only.** `public-surface-hosts.md` §5 already
decided that public projects are a cloud capability and that with `MOTIR_CLOUD`
unset the feature is **ABSENT, not hidden** — and a build with no public projects
has nothing to address.

So there is nothing new to decide, only something to inherit consistently:

- Every new `app/api/public/*` route added by this story opens with
  `publicSurfaceUnavailable()`, as its first statement, before the rate-limit
  guard and before any session read — `lib/publicProjects/cloudGate.ts`. The
  totality test `tests/api/public/cloud-gate-totality.test.ts` enumerates the
  surface from the filesystem, so a route that forgets is caught rather than
  reviewed for.
- The **Public address settings pane** (MOTIR-4221 / MOTIR-4229) and its rail entry
  are gated on `isCloud()`, and a self-hosted build shows no entry — not a
  disabled one.
- The certificate status job (MOTIR-4219) does not schedule on a non-cloud build.

---

## §12 — Q10: branding on a customer address

**The public chrome stays Motir's on every address**, including a customer's own
domain. A page at `roadmap.acme.com` is visibly a Motir page.

**This is a DECISION with a reversal condition, not a deferral**, which is why it
appears here rather than in §14. Notion couples the two — buying its custom-domain
add-on is also what unlocks removing Notion's branding from that domain — so the
coupling is a known product shape and this record declines it on purpose:
white-labelling is a second capability (which surfaces carry the mark, what
replaces it, what a customer may upload, and the abuse question of an unbranded
Motir-hosted page on a domain we do not control), and bundling it into an
addressing story would put a brand system on the critical path of a URL.

**Reversal condition:** a paying customer asks for it, or a deal is lost naming it.
Adopting it is then a per-address branding record plus an asset pipeline — an
epic, not a settings toggle.

---

## Consequences — §13: what this record binds, card by card

| card                                                  | what it inherits from here                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-4208** (buy the domain, manual)               | §2's shape rules and ranked shortlist; the RDAP readings and the command that produced them; Spaceship as registrar; `fly certs add` for the wildcard `*.<base>`, and the `_acme-challenge` CNAME delegation the DNS-01 challenge needs.                                                                                                                                                                                              |
| **MOTIR-4209** (the store)                            | §3 + §4's two address shapes in one table; §7's exactly-one-primary invariant; §8's retained-alias rule (`ProjectKeyAlias`'s uniqueness shape) and reserved-name set.                                                                                                                                                                                                                                                                 |
| **MOTIR-4210** (the certificates adapter)             | §6's three endpoints, the check response's field names, `https://api.machines.dev/v1`, the `%2A.` wildcard encoding, and §10's `FLY_CERTS_TOKEN` / `FLY_CERTS_APP` with the no-fallback token rule.                                                                                                                                                                                                                                   |
| **MOTIR-4211** (the design)                           | §5's add → verify → issue order and its two record shapes; §6's certificate states; §7's _make primary_; §9's tier upsell on `EntitlementExceededError('custom_domains')`; §8's rename warning ("the old address keeps redirecting and is never released").                                                                                                                                                                           |
| **MOTIR-4212** (the AUP clause)                       | §12 (our chrome stays), and §5's point that we serve hostnames whose zones we do not control — which is what the acceptable-use clause is about.                                                                                                                                                                                                                                                                                      |
| **MOTIR-4214** (provisioning)                         | §10's table, in full: four variables, which app each lives on, and which one is a build arg rather than a secret.                                                                                                                                                                                                                                                                                                                     |
| **MOTIR-4215** (claim / rename)                       | §3 (a subdomain names a workspace), §8's cap of **5**, the reserved-name set, and the retained-alias rule.                                                                                                                                                                                                                                                                                                                            |
| **MOTIR-4216** (the customer-domain lifecycle)        | §5's four-step order — a certificate is **never** requested before the TXT verifies — and §9's cap assert, run inside the create's transaction.                                                                                                                                                                                                                                                                                       |
| **MOTIR-4217** (the host contract)                    | §4's subject shapes: a host resolves to a workspace **or** to one project, and the DTO carries the project's addresses and its primary.                                                                                                                                                                                                                                                                                               |
| **MOTIR-4218** (CORS + return target)                 | §7's rule that every registered address is a legitimate public origin — `publicCorsHeaders` and `resolvePublicReturnTarget` currently compare against the **single** `publicSiteOrigin()`, and both become a membership test over the registered set. **The positive-test discipline in `returnTarget.ts` is not relaxed by that**: it stays an origin equality check against a set, never a `startsWith` or a hostname suffix match. |
| **MOTIR-4219** (the status job)                       | §6's check endpoint and its `validation` fields; §6's division of labour — Fly renews, we surface.                                                                                                                                                                                                                                                                                                                                    |
| **MOTIR-4220** (the host router)                      | §4's one branch per request; §11's cloud gate.                                                                                                                                                                                                                                                                                                                                                                                        |
| **MOTIR-4221 / MOTIR-4229** (the pane)                | §5, §7, §8, §9 and §11 — the whole customer-facing vocabulary.                                                                                                                                                                                                                                                                                                                                                                        |
| **MOTIR-4222** (the canonical)                        | §7 in full, including the half that is easy to miss: the primary is what `publicProjectUrl()` **emits**, not only what `<link rel="canonical">` says.                                                                                                                                                                                                                                                                                 |
| **MOTIR-4228** (the entitlement)                      | §9's kind, field, four provisional values and the six-line assert shape.                                                                                                                                                                                                                                                                                                                                                              |
| **MOTIR-4207** (verification, **outside** this story) | §6's warning: the certificate path is a claim about a running system and only a live issue discharges it.                                                                                                                                                                                                                                                                                                                             |
| **MOTIR-4454** (the release path, Amendment 2)        | Amendment 2 in full: reserve-before-delete in ONE transaction, the kinds chosen by `reservesItsHostname`, custom domains untouched, no certificate call, and the `renamesLeft` rule — the cap counts names BURNT (aliases held + hostnames this workspace has reserved), so a release does not reset it. Also the two comment corrections Amendment 2's provenance sub-section names.                                                 |
| **MOTIR-4453 / MOTIR-4455** (the Remove control)      | What the confirm may promise, and only that: the name held for ever and claimable by nobody, the redirect STOPPING rather than continuing, and the projects returning to `motir.co/p/<identifier>` per §7's default-primary table. It may not promise the label back.                                                                                                                                                                 |
| **MOTIR-4458** (release `hey` / `tak`, manual)        | Amendment 2's three properties, read back from the DEPLOYMENT rather than from a merge — which is why it sits outside the story that ships the capability.                                                                                                                                                                                                                                                                            |

### ⚠️ What this record CHANGES about cards already written

Per the close-out discipline that a decision must diff itself against the
criteria of the cards it names, **every consumer's acceptance criteria were
re-read against the answers above.** The result:

- **MOTIR-4206 (this card) — AMENDED.** Its Q7 grounds cite Atlassian's rename
  cap as **3**; the fetched figure is **15**. Amended on the record, and a
  planning bug filed under MOTIR-1465.
- **MOTIR-4209 (the store) — CHECKED, and nothing is owed.** Its _title_ reads
  _"a SET of addresses per public project"_, which §3 does not support for the
  subdomain half. Its **body** does: its own table already assigns
  `workspace_subdomain` to the workspace (`workspaceId`, `projectId` null) and
  `custom_domain` to the project, which is exactly §3 and §4. The title is a
  pointer and the body is the spec, so the card is correct as it stands and is
  left alone. Recorded here because the next reader will notice the title and
  should not re-open it.
- **Every other consumer — CHECKED, no contradiction.** Each either names no
  shape this record fixes differently, or already states the answer above.
- **AMENDMENT 2's own sweep (2026-09-04) — CHECKED.** The three rows added to the
  table above were re-read against Amendment 2 and none contradicts it. Two
  pointers rather than contradictions are recorded so the next reader does not
  re-open them. MOTIR-4454's criteria cite the fallback as _"§7 rule 3"_, which is
  §7's default-primary TABLE — its first row, _no subdomain claimed_ — and not a
  numbered rule; the address it names is the right one. And MOTIR-4211's row above
  records that the pane inherits §8's rename warning _"the old address keeps
  redirecting and is never released"_: that warning is still correct for a RENAME
  and must NOT be reused as the release confirm's copy, where property 2 above
  says the redirect stops. MOTIR-4453 draws the release copy separately, which is
  what keeps the two apart.

The check that mattered most is the one that came back **negative**: a decision's
own consequences table makes it easy to assert an amendment that was never made,
and _"I checked and nothing was owed"_ is a different claim from _"I did not
check"_ only if it is written down.

## §14 — What this record deliberately does NOT decide

**Every entry names the card or record that owns it** — nothing is left _"for
later"_ without an owner.

- **Which string the base domain actually is.** §2 fixes the shape and ranks the
  candidates; **MOTIR-4208** buys one. No code changes when it does.
- **The Public Suffix List submission.** **No card, and none should exist** —
  MOTIR-4213 was cancelled on 2026-09-03. The trigger recorded here used to be
  _"the base domain is registered and serving"_, and that was wrong: serving
  build-in-public pages is precisely the case a listing does nothing for, because
  nothing on them can execute script. See `public-surface-hosts.md` §4's note for
  the measurement, the condition that would change it, and why even then the
  answer is to INHERIT a platform's listing rather than apply for our own.
- **The per-tier values of `maxCustomDomains`.** `billing-tiering.md` §4, via
  Stories **8.1 / 8.6**. §9 seeds them provisionally so MOTIR-4228 is total.
- **White-labelling a customer address.** §12, with its reversal condition. No
  card exists and none should until the condition fires.
- **What a customer address serves when the project stops being public.** The
  address record survives and the page 404s through the existing
  `ProjectNotFoundError` → 404 path (_"deliberately indistinguishable from an
  unknown key"_, `cloudGate.ts`) — but the _"your domain now points at a 404"_
  notification is not this story's. Trigger: the first support ticket.
  **MOTIR-4193** owns what that 404 looks like on `motir-marketing`.
- **Whether a workspace root lists projects or renders the single one.** §3 decides
  the rule; **MOTIR-4220** decides the rendering and **MOTIR-4211** draws it.

---

## Sources

**Rung 2 — `motir-core` `origin/main` at `f8fb84d8`, read 2026-09-03**

- `docs/decisions/public-surface-hosts.md` — §4 (the deviation, the accepted
  exposure, the reversal condition), §5 (the cloud gate), §9 (what it does not
  decide), AMENDMENT 4
- `docs/decisions/organization-url.md` — §3 (`Organization.slug` stays as
  substrate), the reversal condition
- `docs/decisions/marketing-site-hosting.md` — §3 (Spaceship, the Fly `A`/`AAAA`
  shape, the apex `MX`/`TXT` constraint and RFC 1034 §3.6.2), §5 (the
  subprocessor reasoning)
- `docs/decisions/billing-tiering.md` · `lib/billing/entitlements.ts` (`PmTier`,
  `EntitlementKind`, `PmEntitlements`, `PM_ENTITLEMENTS`) ·
  `lib/services/entitlementsService.ts` (the lock-then-count assert shape)
- `prisma/schema.prisma` — `Project` `@@unique([workspaceId, identifier])` (1543),
  `ProjectKeyAlias` (1738–1750), `Organization.slug @unique`
- `lib/publicProjects/urls.ts` (`publicSiteOrigin`, `publicProjectUrl`) ·
  `cors.ts` (`publicCorsHeaders`) · `returnTarget.ts`
  (`resolvePublicReturnTarget`) — the three modules that assume ONE public origin
- `lib/publicProjects/cloudGate.ts` (`publicSurfaceUnavailable`) ·
  `lib/billing/availability.ts` (`isCloud`)
- `lib/orchestrator/adapters/fly/flyMachines.ts` — the Fly boundary, the
  call-time config rule and the scoped-token rule
- `motir-marketing` `origin/main` at `e263dbc` — `fly.toml` (`app =
"motir-marketing"`, org `moooon`, `iad`, `[build.args]`), `lib/siteOrigin.ts`
  (why a `NEXT_PUBLIC_*` build arg and not a secret)

**Rung 1 — fetched 2026-09-03**

- Fly — `https://fly.io/docs/networking/custom-domain-api/` (the three endpoints,
  the check response fields, wildcard support and `%2A.` encoding) ·
  `https://fly.io/docs/networking/custom-domain/` (CNAME for subdomains, A/AAAA
  for apex, the `_acme-challenge` CNAME, DNS-01 for wildcards, renewals not
  counting against the per-registered-domain limit)
- Notion —
  `https://www.notion.com/help/connect-a-custom-domain-with-notion-sites`
  (_"This feature is only available on paid plans"_, `$10`/month, the
  `_notion-dcv.<subdomain>` TXT and the `external.notion.site.` CNAME)
- Canny — `https://help.canny.io/en/articles/1355038-setting-up-your-custom-domain`
  (`company.canny.io`, `cname.canny.io`, no TXT) and Canny's own feedback board
  for _make primary_ → the canonical source
- Statuspage —
  `https://support.atlassian.com/statuspage/docs/set-a-custom-domain-and-ssl/`
  (`mycompany.statuspage.io`; _"Public pages can use a custom domain, except for
  pages on the Free plan"_; the dedicated-domain **recommendation**)
- Atlassian —
  `https://support.atlassian.com/organization-administration/docs/update-a-product-url/`
  (_"We'll store the previous URL in your site's history and redirect all links
  to the new URL"_; _"You can update the subdomain up to 15 times"_)
- RDAP — `https://rdap.org/domain/<name>`, and
  `https://rdap.verisign.com/com/v1/domain/<name>` for `.com`

**Read but NOT confirmed, recorded so nobody re-cites it from here**

- Statuspage's help page, as fetched, does **not** state that a root/apex domain
  cannot be used; it _recommends_ a dedicated domain. §5 accepts apex domains and
  does not rest on that claim either way.
- The Atlassian page cited by this card's brief does not itself state that the old
  URL cannot be claimed by another organization. Atlassian's community
  documentation says a redirected URL is not available to another site while the
  owning site exists; §8's decision is taken on `ProjectKeyAlias`'s in-repo
  precedent (rung 2), which does not depend on that reading.
