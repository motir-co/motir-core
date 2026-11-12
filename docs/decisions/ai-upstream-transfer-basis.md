# The AI upstream transfer basis — which providers may serve hosted prompt content

- **Status:** Accepted (2026-08-26, drafted for Bug MOTIR-3624 under Story
  MOTIR-657, 8.4 Legal — ToS + privacy). **No application behaviour ships in
  this record** — it writes this file and amends `content/legal/subprocessors.md`.
  The routing change and its enforcement are carried by the cards under
  **Consequences**.
- **Story / Bug:** MOTIR-657 (8.4 Legal — ToS + privacy) · Bug MOTIR-3624.
- **Answers:** `production-service-stack.md` **Q8** — _"What makes each vendor
  lawful to use? A DPF certification or SCCs, read per vendor. Not assumed, and
  not optional."_ Q8 was discharged for every vendor except the AI upstream while
  MOTIR-1160 drafted the subprocessor list. This record discharges that one.
- **Assessed against:** `legal-document-set.md` §3 — moooon B.V. is the
  controller for the hosted service at `app.motir.co`, and for that service only.
  A self-hosted install is its own controller and none of this binds it.
- **Amends:** `motir-ai` `docs/planner-llm.md` §3 (_Provider + model — DeepSeek
  first_). That record chose the planner's default upstream on capability and
  cost, and recorded **no transfer basis** for it. §4 below states what changes
  and what survives.
- **Consumed by:** MOTIR-1160 (the subprocessor list — amended in the same
  change as this record), MOTIR-3621 (counsel review), MOTIR-1134 (publication).
- **AMENDED 2026-10-01 (MOTIR-3687):** **D2 and D3 are SUPERSEDED** by
  MOTIR-3665 — DeepSeek stays served, the way OpenRouter serves it, and a caller
  excludes it per request. The finding that justified D2 and D3 was wrong in three
  places. The amendment directly below is the whole change. The original text is
  kept and struck in place, because the reasoning trail is the point of a decision
  record.
- **EXTENDED 2026-10-02 (MOTIR-4332):** §2 gains dated rows for **Z.ai (GLM)**
  and **Alibaba Cloud Model Studio, Frankfurt (Qwen)**, transcribed from the
  legal card MOTIR-7192. No decision in §3 changes.
- **EXTENDED 2026-10-02 (MOTIR-7351):** §2 gains a dated row for **Moonshot AI,
  international platform (`api.moonshot.ai`, Kimi)**, transcribed from the legal
  card MOTIR-7356. The 2026-08-26 Moonshot rows (the `.cn` channel row and the
  _not established_ vendor row) are struck in place. No decision in §3 changes.
- **AMENDED 2026-11-12 (MOTIR-11119, Story MOTIR-11116):** Qwen moves to a
  **Global-scope US (Virginia)** Model Studio workspace, and its row becomes a
  **Chapter V transfer under the SCCs** of the EEA DPA (§6, with the clauses §2
  defines), with a dated transfer-impact note — see _Amended 2026-11-12
  (MOTIR-11119): Alibaba Cloud Model Studio, US (Virginia), Global scope (Qwen)_
  in §2. The 2026-10-02 Frankfurt row, the counter-example's _"the inference
  never leaves the Union"_ and the _"EU-resident inference"_ sentence are struck
  in place. No decision in §3 changes.

> Convention per `work-item-type-taxonomy.md`: **Status → Context → Decision →
> Consequences**, load-bearing facts pinned in explicit tables.

---

## ⚠️ AMENDMENT 2026-10-01 — D2 and D3 are SUPERSEDED: DeepSeek is served the way OpenRouter serves it

- **Status:** Accepted on approval of MOTIR-3687. **Replacing card:**
  MOTIR-3665 (re-scoped 2026-09-06), whose gateway half shipped as MOTIR-3669.
- **Why now:** two shipped artefacts cite this record as their reason to keep
  DeepSeek out of hosted agent runs — `motir-ai` `src/llm/hostedAgentModels.ts`
  (`HOSTED_AGENT_PROVIDERS`) and `motir-gateway` `docs/hosted-run-egress.md` §2.
  Founder, 2026-10-01: _"we are going to serve DeepSeek."_ A record that still
  reads as an instruction to switch DeepSeek off would send every reader who
  follows those citations back to the retirement.

### What this record now decides, row by row

| #      | As of 2026-10-01                                                                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | **Not amended here.** The planner's default is still not DeepSeek. Its model was re-targeted on 2026-08-28, and that change is recorded on MOTIR-3687's card rather than decided in this amendment.              |
| **D2** | **SUPERSEDED.** The DeepSeek channel is not disabled. It stays served, and a caller who does not accept its data policy excludes it per request (below). The executing card MOTIR-3636 was cancelled 2026-08-27. |
| **D3** | **SUPERSEDED as a binding.** No caller is pinned to a basis-only group. The residency GROUP survives as a mechanism (§5). The executing card MOTIR-3637 was cancelled 2026-08-27.                                |
| **D4** | Stands. Anthropic carries SCCs and is enabled.                                                                                                                                                                   |
| **D5** | **Its D2 clause falls with D2.** The rest of the publication precondition is not re-decided here (see _What this amendment does NOT decide_).                                                                    |

### What replaces D2 and D3 — the OpenRouter shape, in OpenRouter's own terms

OpenRouter serves DeepSeek. It publishes DeepSeek's data practices beside the
model, and it lets any caller refuse them. Read 2026-10-01 from OpenRouter's public
provider table (`/api/frontend/v1/all-providers`, slug `deepseek`) and its
provider-routing documentation:

| OpenRouter                                                                                                                                                                                                                         | Motir                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The provider's data policy is disclosed per endpoint.** DeepSeek reads `training: true` (labelled _"may train on your data"_), `retainsPrompts: true`, `headquarters: CN`, with links to DeepSeek's own terms and privacy policy | **The same facts, read from DeepSeek's own documents** on motir-marketing `content/legal/model-providers.md` (read 2026-09-06): trains on API content, no retention period stated, People's Republic of China — and on `content/legal/subprocessors.md` |
| **`data_collection: "allow"` is the default** — _"allow providers which store user data non-transiently and may train on it"_                                                                                                      | **A request with no `X-Motir-Data-Policy` header is unconstrained** (`motir-gateway` `motir/datapolicy`), so DeepSeek is reachable when the caller asks for a DeepSeek model                                                                            |
| **`data_collection: "deny"`** — _"use only providers which do not collect user data"_                                                                                                                                              | **`X-Motir-Data-Policy: must-not-train`** — DeepSeek's channel is declared `TrainingYes`, so it is excluded                                                                                                                                             |
| **`zdr: true`** — _"the request will only be routed to endpoints that do not retain prompts"_                                                                                                                                      | **`X-Motir-Data-Policy: zero-retention`** — DeepSeek's retention is declared unknown, which fails closed, so it is excluded                                                                                                                             |
| **No compliant provider ⇒ _"your application chooses what happens next"_** — the request is not routed around the restriction                                                                                                      | **Fails closed** at the gateway when no channel satisfies the policy (MOTIR-3669)                                                                                                                                                                       |
| An account-wide privacy setting layers on top of the per-request fields                                                                                                                                                            | **None.** MOTIR-3665 retired the per-workspace control. The filter is per request only                                                                                                                                                                  |

**So the position is: Motir never assigns DeepSeek, and the customer may choose
it, including as their default.** Motir's own platform defaults are not DeepSeek.
A customer may pick a DeepSeek model for one request or run. A customer may also
make it their project's default for a difficulty level, through the per-project
override MOTIR-6989 shipped, exactly as an OpenRouter caller names the model it
wants. DeepSeek's data practices are published where the model is chosen. A
caller who will not accept a provider that trains on prompts or retains them says
so on the request, and the gateway refuses rather than routing around it.

**The choice is the customer's because the customers are global.** Motir is
established in the EU and serves customers everywhere. How much a customer cares
about where its content is processed, and by whom, differs by customer. A team in
a jurisdiction with no transfer rules, or a small startup that weighs cost over
data handling, may reasonably prefer DeepSeek. A team that may not use it never
picks it, or sends the policy. Motir does not impose on every customer the
strictest provider policy any one customer needs. It publishes the facts, keeps
its own defaults off DeepSeek, and enforces whatever restriction a caller states.

This relies on neither of the two _Keep DeepSeek_ rows under **Rejected
alternatives**: it is not an Art. 49 derogation and it is not a consent gate, and
both stay rejected for their original reasons.

### Why the finding behind D2 and D3 was wrong

§1 concluded retirement from _"DeepSeek carries no Chapter V mechanism"_. The
observation was accurate: DeepSeek's policy names no SCCs. The reasoning built on
it was defective in three separate places, and restating the conclusion without
correcting them would leave the same inference for the next reader.

1. **Adequacy is not the gate.** **Art. 46(2)(c) SCCs are available for transfers
   to ANY third country**, with or without an adequacy decision. _"China has no
   EU adequacy decision"_ is true and nearly irrelevant, and §1 treated it as
   decisive.
2. **The real gap is Art. 28, not Chapter V.** DeepSeek publishes no **processing
   agreement**, and so offers no clauses to sign. That is one vendor's paperwork.
   An EU-established vendor with the same gap would be equally hard to use as a
   processor, so the defect has nothing to do with where DeepSeek is established.
3. **The regulatory actions were misread.** Italy's Garante ordered **DeepSeek**
   to stop processing Italian users' data through its **consumer app**. The
   proceedings opened in France, Ireland, Germany, Belgium and Portugal are of the
   same kind. All of them are findings about DeepSeek as **controller of its own
   users**. **None restricts a European company from calling the API.**

**The counter-example:** **Alibaba Cloud** serves Qwen from Model Studio's
~~**Frankfurt** region~~ **US (Virginia) region, Global scope** (2026-11-12),
under an EEA DPA that incorporates the SCCs. ~~It is a Chinese company with a
stronger transfer position than any US provider on the list, because the
inference never leaves the Union.~~ Any reasoning that concludes _"Chinese
vendor ⇒ retire"_ fails on that row.

> **Corrected 2026-11-12 (MOTIR-11119):** Qwen is now served from a
> **Global-scope US (Virginia)** workspace, whose inference may run on _"any
> available node, including Chinese mainland and overseas"_, so the struck claim
> that the inference never leaves the Union is no longer true. **The
> counter-example's argument still holds:** Art. 46 SCCs reach ANY third country,
> and Alibaba's EEA DPA commits it to them for transfers out of the EEA (§6), so a
> Chinese vendor with a processing agreement and the SCCs carries a basis that a
> vendor with neither does not. See _Amended 2026-11-12 (MOTIR-11119): Alibaba
> Cloud Model Studio, US (Virginia), Global scope (Qwen)_ in §2.

### Who reaches DeepSeek

- **The hosted planner** — only when a caller asks for a DeepSeek model. D1
  keeps it off the default.
- **Hosted agent runs.** Customer repository content reaches DeepSeek when a
  person picks a DeepSeek model for a hosted run (Story MOTIR-7205). It also
  reaches DeepSeek when the project has made a DeepSeek model its default for the
  card's difficulty level, through MOTIR-6989's per-project override. **Motir's
  platform default stays Claude at every level. A project's override is the
  customer's choice, and it may name DeepSeek.** Runs are **subject to the same
  per-request data policy**: a request carrying `must-not-train` or
  `zero-retention` cannot reach DeepSeek.
  How a hosted run carries a policy, and which providers its offered list spans,
  is `hosted-agent-run.md` §7's to decide (MOTIR-7206), not this record's.

### What SURVIVES from the original record

The amendment retracts D2 and D3 and the inference behind them, and nothing else:

- **The enumeration method** (§1 _How it was read_): read the gateway's channel
  set from the running platform, not from source. `content/legal/subprocessors.md`
  § _How this list is compiled_ (motir-marketing) depends on it.
- **The rejection of `model_mapping`** (§4): still correct, for the original
  reason. The model id a request names must stay the model a provider served, or
  the consume log stops being a transfer audit.
- **The residency GROUP as the enforcement seam** (§5): now the substrate for a
  mixed provider set rather than the mechanism of a retirement. MOTIR-3634
  shipped it, and DeepSeek stays OUT of the `transfer-basis` group
  (`motir-gateway` `motir/catalog/channel-groups.sh`, `DEEPSEEK_GROUPS="default"`).
- **The ordering hazard** (§3 _D1 and D2 have a MANDATORY ORDER_): routing is
  `(group, model, enabled) → channel`. Binding a user to a group with no channel
  for its model, or disabling the only channel serving a default model, is an
  instant failure. That trap outlives the decision that found it.

### What remains OPEN — disclosed, not closed

**The Art. 28 gap is not closed by this amendment.** DeepSeek still offers no
processing agreement, trains on API content and states no retention period. The
published pages say so, which is the OpenRouter posture: disclose the provider's
practices and let the caller refuse them. Counsel review is still MOTIR-3621's.
The gap is reopened if DeepSeek publishes a DPA, if a supervisory authority
addresses business use of the API, or if a customer requires it closed.

### Clauses elsewhere this amendment makes false — named here, edited on their own cards

- **`legal-document-set.md` § _AMENDED 2026-08-27 — the set is SEVEN pages_** still
  commits that _"only a provider with a recorded transfer basis may serve EU
  traffic"_, enforced at the gateway. That is D3's principle, now superseded. The
  edit is MOTIR-7216, because this record is the one file the decision gate reads.
- **motir-marketing `content/legal/subprocessors.md` and `model-providers.md`** say
  _"today the default is DeepSeek"_ (false since D1), name no hosted-run consumer,
  and describe a transfer-basis group that binds no caller. The edit is MOTIR-7215.

### What this amendment does NOT decide

- **Motir's platform defaults.** They stay off DeepSeek: the planner's (D1) and
  the hosted-run default at every difficulty level. A project's own override is
  not restricted by this record.
- **D1's model.** The planner default stays off DeepSeek. Recording what it now
  is belongs to another card.
- **D5's remaining precondition** beyond its D2 clause, and whether
  `content/legal/subprocessors.md` is now publishable. That is MOTIR-1134's.
- **The published legal pages.** They live in motir-marketing and are not edited
  here. Where they disagree with this record, the disagreement is written on
  MOTIR-3687.
- **A per-workspace data-policy control.** MOTIR-3665 retired it.
- **How a hosted run carries a data policy, and which providers it offers.**
  `hosted-agent-run.md` §7 (MOTIR-7206).
- **Self-hosting DeepSeek's weights.** Still open on cost and capability grounds,
  as §6 already says.

---

## §1 — Context: what was READ, on which surface, and when

The card that produced this record could not be answered from any checkout. The
gateway's enabled channel set is **administration state**, not repository state,
so every fact in this section was read from the **running platform on
2026-08-26** and is dated as such.

### How it was read (so the reading can be repeated)

`motir-gateway` has **no public IP** — `GET /v1/apps/motir-gateway` returns one
address, `fdaa:ab:2cdf:0:1::3`, `private_v6`. `motir-gateway.fly.dev` has no `A`
record and `curl` from outside the Fly network fails to connect. `motir-ai`
reaches it at `http://motir-gateway.flycast/v1`, over 6PN.

So the admin API was read **from inside the machine**:

```
POST https://api.machines.dev/v1/apps/motir-gateway/machines/<id>/exec
  { "command": ["sh","-c","wget -qO- --header='Authorization: Bearer $TOK' \
      'http://127.0.0.1:3000/api/channel/?p=0'"] }
```

`$TOK` is the root user's access token, recovered from the same machine's
`INITIAL_ROOT_ACCESS_TOKEN` (`fly-platform-facts`); it was never printed.

> **⚠️ The 6PN-only posture is a fact about INGRESS and says nothing about this
> record.** Nobody on the internet can reach the gateway; the gateway can still
> reach every upstream it is configured for. The question here is **egress**, and
> a private relay egresses exactly as far as a public one.

### The enabled channel set, read 2026-08-26

`model/channel.go` defines the status enum: `1` enabled, `2` manually disabled,
`3` auto-disabled.

| #   | Channel      | Upstream                      | Models served                                              | Status on 2026-08-26                                                                                                                                                                                    |
| --- | ------------ | ----------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **DeepSeek** | `https://api.deepseek.com`    | `deepseek-v4-pro`, `deepseek-v4-flash`                     | **ENABLED** (`status: 1`)                                                                                                                                                                               |
| 2   | Anthropic    | `https://api.anthropic.com`   | `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` | manually disabled (`status: 2`)                                                                                                                                                                         |
| 3   | **OpenAI**   | `https://api.openai.com`      | `gpt-4o`, `gpt-4o-mini`, `o3`, `text-embedding-3-small`    | **ENABLED** (`status: 1`)                                                                                                                                                                               |
| 4   | ~~Moonshot~~ | ~~`https://api.moonshot.cn`~~ | ~~`moonshot-v1-128k`, `kimi-k2`~~                          | ~~manually disabled (`status: 2`)~~ **Struck 2026-10-02 (MOTIR-7351):** the channel moves to `https://api.moonshot.ai` — see _Added 2026-10-02 (MOTIR-7351): Moonshot AI, international platform_ below |

There is one further upstream that is **not a channel row** and is therefore
absent from the table above and easy to miss: the **Brave Search API**
(`https://api.search.brave.com`, `motir/search/brave.go`), billed through the
gateway's per-call-unit path as the unit `search.brave`. It has served **3 live
calls**, 2026-08-12 → 2026-08-21.

### ⚠️ §2 — The card's own premise was too CAUTIOUS, and the correction runs the wrong way

MOTIR-3624 was filed honestly and said so in its own words: _"This bug does not
claim DeepSeek is switched on — it claims nothing prevents it."_ **It is switched
on, it is the planner's default, and it has carried real traffic.** The
correction is recorded here rather than absorbed, because a filed premise that
turns out UNDERSTATED reads, from a green run, exactly like one that was right.

Three readings compose into the finding, and none of them is sufficient alone:

1. **The channel is enabled** — table above, `status: 1`.
2. **The planner asks for that channel's model.** `motir-ai`
   `src/llm/gatewayClient.ts` pins `PLANNER_MODELS.default = 'deepseek-v4-pro'`,
   overridable only by `PLANNER_MODEL`.
3. **`PLANNER_MODEL` is UNSET in production** — read from **both** running
   `motir-ai` machines (`48ee5d6fd24328`, `895905f6d67d68`) with
   `machines/<id>/exec` → `PLANNER_MODEL=[<UNSET>]`, `NODE_ENV=production`. Not
   from `fly.toml`, which does not carry it, and not from `fly secrets list`,
   which does not list it.

Reading (3) is the one that decides it, and it is the one no checkout can
supply. A config file is a claim about the deployment; the machine is the
deployment.

### What has actually been transmitted

From the gateway's own consume log (`type=2`, filtered `channel=1`, paged to
exhaustion):

|                             |                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------- |
| calls to `api.deepseek.com` | **72** (`deepseek-v4-pro` ×68, `deepseek-v4-flash` ×4)                            |
| prompt tokens transmitted   | **4,232,283**                                                                     |
| completion tokens returned  | 200,726                                                                           |
| window                      | **2026-06-24 → 2026-08-21** (1 · 1 · 14 · 56 calls on 06-24, 06-30, 08-10, 08-21) |
| gateway token               | `motir-ai-planner` — the hosted planner's own token                               |
| channels 2 and 4            | **zero rows.** Anthropic and Moonshot have never served a request                 |

**Whose content that was is NOT determinable from this log, and this record does
not guess.** Every row carries an empty `core_org_id`, but that proves nothing:
`Log.CoreOrgId` is written only on the per-call-unit path
(`relay/billing/motir_per_call.go`) and is blank on **every** LLM row ever
written. The honest statement is that hosted planning traffic egressed to a
PRC-hosted upstream over a two-month window, and that the gateway's log cannot
say which tenants' content it was. Whether any of it was a third party's personal
data is a question for **MOTIR-3621**, not for this record.

### The transfer bases, read per vendor on 2026-08-26

| Upstream             | Jurisdiction                       | Chapter V basis                                                                                                                                                                                                                                                               | Read from                                       |
| -------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **DeepSeek**         | **People's Republic of China**     | **NONE.** Its policy names no SCCs, no BCRs and no mechanism — only _"appropriate safeguards … in accordance with the requirements of applicable data protection laws"_                                                                                                       | DeepSeek's published privacy policy             |
| **OpenAI**           | USA                                | **SCCs** — Module 2 as controller, Module 3 as processor                                                                                                                                                                                                                      | OpenAI's published DPA (recorded by MOTIR-1160) |
| **Anthropic**        | USA                                | **SCCs** — its DPA is auto-incorporated into the Commercial Terms and relies on SCCs for transfers to countries without an adequacy decision                                                                                                                                  | Anthropic's published DPA / Trust Center        |
| ~~**Moonshot**~~     | ~~**People's Republic of China**~~ | ~~**Not established.** Same jurisdictional problem as DeepSeek; not read further, because §3 keeps it disabled~~ **Struck 2026-10-02 (MOTIR-7351):** re-read from the international platform — see _Added 2026-10-02 (MOTIR-7351): Moonshot AI, international platform_ below | —                                               |
| **Brave Search API** | USA                                | **SCCs** — its Search API DPA incorporates the EU SCCs (and the UK Addendum). Query records retained **90 days** by default for billing/troubleshooting; Zero Data Retention is available to enterprise customers                                                             | Brave's published Search API DPA                |

DeepSeek's own words are the load-bearing quote: _"we directly collect, process
and store your Personal Data in People's Republic of China."_ **China has no EU
adequacy decision**, and with no SCCs offered the Article 46 route is not
available off the shelf either. Article 49 derogations do not rescue it: they are
for occasional transfers, and routing every planning request through one upstream
is the definition of systematic.

> **⚠️ SUPERSEDED REASONING (AMENDMENT 2026-10-01, MOTIR-3687).** The quote and the
> missing SCCs are accurate. The inference drawn from them is not: adequacy is not
> the gate (Art. 46(2)(c) SCCs reach any third country), the real gap is DeepSeek's
> missing Art. 28 processing agreement, and the regulators acted against DeepSeek's
> consumer app, not against API callers. See the amendment at the top of this record.

### Added 2026-10-02 (MOTIR-4332): Z.ai (GLM) and Alibaba Cloud Model Studio, Frankfurt (Qwen)

Both rows are transcribed field for field from the dated readings commented on
the legal card **MOTIR-7192**, read 2026-10-02 as moooon B.V. (controller and
exporter). A **basis** is two recorded facts, an Art. 28 agreement AND an Art.
46/45 mechanism (`motir-gateway` `motir/residency/residency.go`), and the verdict
column is that card's verdict, unparaphrased.

| Upstream                                                       | Vendor and jurisdiction                                                                                                                                                  | Endpoint                                                         | Art. 28 instrument                                                                                                                                                                                                                                  | Chapter V mechanism                                                                                                                                                                                                                                 | Filed at                                                                      | Verdict                                                       | Read on                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Z.ai (GLM)**                                                 | JINGSHENG HENGXING TECHNOLOGY PTE.LTD (Z.ai), **Singapore**                                                                                                              | `https://api.z.ai`                                               | _"Data Processing Addendum for API Services"_, inside the Z.ai Privacy Policy (last updated 2025-09-29), incorporated into the Additional Terms for API Services §2(a); accepted by use on 2026-10-02 by Zhu Yue (Google sign-in, no click-through) | **NONE.** DPA §3(b) says only _"legally recognized transfer mechanisms"_; no SCCs are named, and Singapore has no adequacy decision                                                                                                                 | `https://docs.z.ai/legal-agreement/privacy-policy`                            | **no basis — served in default only, outside transfer-basis** | 2026-10-02                                                                                                                                                                                                              |
| ~~**Alibaba Cloud Model Studio, Germany (Frankfurt) (Qwen)**~~ | ~~Intelligent Cloud Computing (Singapore) Private Limited (Alibaba Cloud international edition, `alibabacloud.com`; entity as shown in the account console), Singapore~~ | ~~`https://ws-tpooed538vl85iw2.eu-central-1.maas.aliyuncs.com`~~ | ~~_"EEA Data Processing Addendum"_ (last updated 2023-08-02), which _"forms part of Your Membership Agreement"_ (§1); accepted on 2026-10-02 by Zhu Yue at account registration~~                                                                   | ~~**No transfer — EU-resident.** Workspace `235341` in `eu-central-1` with deployment scope **EU** (_"Service deployment scope: Determines the inference execution location"_); the DPA's §2 references the 2021/914 SCCs for any onward transfer~~ | ~~the Alibaba Cloud account; `alibabacloud.com/help/en/legal/latest/ae8upq`~~ | ~~**basis recorded**~~                                        | ~~2026-10-02~~ **Struck 2026-11-12 (MOTIR-11119):** Qwen moves to a Global-scope US (Virginia) workspace — see _Amended 2026-11-12 (MOTIR-11119): Alibaba Cloud Model Studio, US (Virginia), Global scope (Qwen)_ below |

**Corrected 2026-10-02 (MOTIR-7198):** the Qwen endpoint was first recorded
as `https://235341.eu-central-1.maas.aliyuncs.com`, built from the console's
numeric workspace number. Alibaba answers that host with `IllegalEndpoint`; the
`<WorkspaceId>` its _Regions and endpoints_ page means is the `ws-…` id, and the
host above is the one that answered 200 in MOTIR-7194's proofs. Same workspace,
same region, same verdict.

Training and retention, as each vendor's international documents state them
(the full quotes are on MOTIR-7192):

- **Z.ai:** API content is not used _"to develop or improve Services, unless you
  explicitly agree"_ (Additional Terms §3(b), a sentence Z.ai prints in square
  brackets), and is _"processed in real-time … and is not saved on our servers"_
  (DPA §4(b)).
- **Alibaba:** _"never uses your data for model training"_ (Model Studio FAQ);
  retention of API calls is **not stated**.

**Why these endpoints and not the mainland ones.**

- **Z.ai:** the earlier Zhipu reading (_"no Art. 28 agreement on offer"_,
  2026-08-27) was taken from `open.bigmodel.cn`, the mainland platform, which by
  the **MOTIR-6258** precedent requires a PRC-registered company and so is not one
  Motir can use. `api.z.ai` is the international platform moooon B.V. holds an
  account on, and the platform this row reads.
- **Alibaba:** the account is on `alibabacloud.com` (international), not
  `aliyun.com`, and the endpoint is ~~the Frankfurt workspace URL in the form
  Alibaba's _Regions and endpoints_ page gives
  (`https://<WorkspaceId>.eu-central-1.maas.aliyuncs.com`,
  `alibabacloud.com/help/en/model-studio/regions`). That is the EU-resident
  inference the public subprocessor page already promises.~~
  **Corrected 2026-11-12 (MOTIR-11119):** the US (Virginia) workspace URL in the
  form Alibaba's _US (Virginia) — Global_ page gives
  (`https://<WorkspaceId>.us-east-1.maas.aliyuncs.com`,
  `alibabacloud.com/help/en/model-studio/usa-virginia-global`), a `us-east-1`
  host and no longer `eu-central-1`, and still never `aliyun.com` or
  `dashscope.aliyuncs.com`. Its deployment scope is **Global**, so the inference
  is no longer EU-resident: it is a Chapter V transfer, recorded in _Amended
  2026-11-12 (MOTIR-11119)_ below.

**What each verdict means for routing.** **Z.ai's _no basis_ does not switch
GLM off.** The channel is **served**: enabled in the gateway's `default` group
and kept out of `transfer-basis`, the treatment DeepSeek has under **MOTIR-3665**
(the amendment at the top), chosen for these two upstreams by the hosted-agent
epic's decision **MOTIR-7242** on 2026-10-01. A caller that needs a basis
excludes it per request. Qwen's _basis recorded_ puts the Frankfurt channel in
both `default` and `transfer-basis`.

**Who reaches them.** For both vendors: **the hosted planner**, when a caller
asks for a GLM or Qwen model, and **hosted agent runs**, when a person picks one
for a run or a project's per-level default names one (`hosted-agent-run.md` §7).

### Added 2026-10-02 (MOTIR-7351): Moonshot AI, international platform (`api.moonshot.ai`)

The row is transcribed field for field from the dated reading commented on the
legal card **MOTIR-7356**, read 2026-10-02 as moooon B.V. (controller and
exporter). The verdict column is that card's verdict, unparaphrased. The
account is held by moooon B.V.: a Google sign-in with the company address, no
separate organisation profile, nothing changed.

| Upstream                                       | Vendor and jurisdiction                                                                          | Endpoint                  | Art. 28 instrument                                                                                                         | Chapter V mechanism                                                                | Filed at                                                                                                   | Verdict                                                       | Read on    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------- |
| **Moonshot AI, international platform (Kimi)** | Moonshot AI PTE. LTD., **Singapore** (data stored in Singapore; Singapore law, SIAC arbitration) | `https://api.moonshot.ai` | **NONE** — none in the Terms (updated 2026-07-30), the Privacy Policy (2025-04-30), the docs index, or the account console | **NONE** — no SCCs or other Art. 46 instrument; Singapore has no adequacy decision | `https://platform.kimi.ai/docs/agreement/modeluse` · `https://platform.kimi.ai/docs/agreement/userprivacy` | **no basis — served in default only, outside transfer-basis** | 2026-10-02 |

`platform.moonshot.ai` now redirects to `platform.kimi.ai`; both are the
international platform. Training and retention, as its documents state them (the
full quotes are on MOTIR-7356):

- **Training:** yes by default. Customer Content may be used to _"provide,
  maintain, develop, support, and improve the Services"_, and _"Unless otherwise
  expressly agreed in writing, Customer Content may be used for the foregoing
  purposes"_ — a restriction is available only through an enterprise or separate
  written agreement (Terms §4).
- **Retention:** **not stated** as a period. _"account, input, and payment
  information are retained while your account is active"_ (Privacy Policy §6),
  and content is deleted after termination _"in accordance with the requirements
  of applicable laws and regulations"_ (Terms §11).

**Why this endpoint and not the mainland one.** `api.moonshot.cn` is Moonshot's
mainland platform, a separate product with separate accounts and terms, which
requires a PRC-registered company; moooon B.V. is not one (**MOTIR-6258**). The
2026-08-26 row above (_People's Republic of China, not established_) and the
2026-09-06 Kimi Open Platform reading on the public pages were both taken from mainland-facing
documents (the 2026-09-06 one from the Chinese-language terms on `platform.kimi.com`);
this row reads the international one.

**What the verdict means for routing.** **_No basis_ does not switch Kimi off.**
The channel is **served**: enabled in the gateway's `default` group and kept out
of `transfer-basis`, the treatment DeepSeek and GLM have
under **MOTIR-3665** (the amendment at the top), chosen for Kimi by the
hosted-agent decision **MOTIR-7350** on 2026-10-02. A caller that needs a basis
excludes it per request.

**Who reaches it.** **The hosted planner**, when a caller asks for a Kimi model,
and **hosted agent runs**, when a person picks a Kimi model for a run or a
project's per-level default names one (`hosted-agent-run.md` §7).

### Amended 2026-11-12 (MOTIR-11119): Alibaba Cloud Model Studio, US (Virginia), Global scope (Qwen)

Qwen leaves the EU-scope Frankfurt workspace for a **new** Model Studio workspace
in **US (Virginia)**, created with deployment scope **Global** (Story
MOTIR-11116). Alibaba fixes a workspace's scope when it is created, so the
Frankfurt row above could not be amended into this one: it is struck, and this
row replaces it. The workspace facts are transcribed from the precondition card
**MOTIR-11117** (read 2026-11-12); the Art. 28 instrument and its acceptance are
**MOTIR-7192**'s reading; the transfer clause was re-read on 2026-11-12. The
exporter is moooon B.V., controller for the hosted service.

| Upstream                                                           | Vendor and jurisdiction                                                                                                                                                                                                                                                                                                                              | Endpoint                                                  | Art. 28 instrument                                                                                                                                                            | Chapter V mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Filed at                                                                                                                               | Verdict            | Read on                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| **Alibaba Cloud Model Studio, US (Virginia), Global scope (Qwen)** | Alibaba Cloud international edition (`alibabacloud.com`), a Chinese group. Counterparty as shown in the account console: Intelligent Cloud Computing (Singapore) Private Limited, Singapore (MOTIR-7192). Data stored in the **United States** (Virginia, `us-east-1`); inference on _"any available node, including Chinese mainland and overseas"_ | `https://ws-a6i8uqg4jvoubhf3.us-east-1.maas.aliyuncs.com` | _"EEA Data Processing Addendum"_ (last updated 2023-08-02), which _"forms part of Your Membership Agreement"_ (§1); accepted on 2026-10-02 by Zhu Yue at account registration | **The Standard Contractual Clauses.** DPA §6 _International transfers_: _"If the processing of Data involves transfers out of the EEA, Alibaba Cloud will take such measures as are necessary to ensure the transfer is in compliance with applicable Data Protection Legislation"_, including a transfer _"to a recipient that has executed Standard Contractual Clauses together with any supplementary measures that may be necessary"_. DPA §2 defines those clauses as _"the standard contractual clauses annexed to the European Commission's Implementing Decision 2021/914/EU of 4 June 2021"_. Workspace `ws-a6i8uqg4jvoubhf3`, deployment scope **Global** (console read-back, verbatim: `Global`) | the Alibaba Cloud account; `alibabacloud.com/help/en/legal/latest/ae8upq`; `alibabacloud.com/help/en/model-studio/usa-virginia-global` | **basis recorded** | 2026-11-12 (the _US (Virginia) — Global_ page, last updated 2026-10-13; the DPA, re-read) |

**Why §6 and not §2.** §2 only DEFINES the Standard Contractual Clauses; it
commits Alibaba to nothing. §6 is the operative clause, and it offers three
routes: an adequacy decision, binding corporate rules, or the SCCs. The People's
Republic of China has no adequacy decision, so the route this row names is the
SCC route of §6, with §2 cited for what those clauses are. The 2026-10-02 row's
_"the DPA's §2 references the 2021/914 SCCs"_ described the same document; this
row states which clause binds.

**What has not changed.** The account, the DPA and its acceptance, and the
training and retention statements above (_"never uses your data for model
training"_; retention of API calls not stated) are the vendor's and stand as
read. The verdict stays **basis recorded** — an Art. 28 agreement AND an Art. 46
mechanism — so Qwen's channel stays in both `default` and `transfer-basis`
(`motir-gateway` `motir/catalog/channel-groups.sh`, `QWEN_GROUPS="default,transfer-basis"`,
read on `main` at `b3c4c00`).

#### Transfer-impact note — dated 2026-11-12

Recorded by moooon B.V. as exporter before any customer request is routed to the
Global-scope workspace. Every fact below is taken from the source named beside
it, on the date given; where a document is silent, this note says so instead of
filling the gap.

1. **Where the data goes.** Alibaba's _US (Virginia) — Global_ page (last updated
   2026-10-13, read 2026-11-12): _"The application sends a request to the
   selected region through the endpoint, and the request data is stored in that
   region. The access region forwards the request to an inference node within
   the service deployment scope for computation. Transmission is encrypted
   end-to-end. The inference result returns to the access region for storage and
   is then returned to the application. User static data is always stored in the
   selected region."_ For US (Virginia) the Global scope is _"Global (any
   available node, including Chinese mainland and overseas)"_. So request and
   static user data are **stored in the United States (Virginia)**, and
   **inference may run in mainland China or another country outside the EEA**.
   Both are third countries.
2. **Adequacy.** The People's Republic of China has **no EU adequacy decision**.
   The United States' adequacy decision (the EU-U.S. Data Privacy Framework)
   covers **only organisations certified under it**. Read 2026-11-12 from the
   DPF List (`dataprivacyframework.gov/list`, the participant record behind it):
   **Alibaba Cloud US LLC** (Dover, Delaware; covered entity _Alibaba Cloud LLC_)
   holds an **Active EU-U.S. certification for non-HR data**, first certified
   2018-03-12, with a record end date of 2027-02-02. **That certification is not
   relied on here**, for a reason the documents themselves give:
   - the **EEA DPA names no Alibaba entity** — it says only _"Alibaba Cloud"_,
     with terms defined by the Membership Agreement;
   - the **Membership Agreement** (last updated 2026-09-10, read 2026-11-12)
     chooses the contracting entity by the customer's **billing address**, not by
     region: _"your billing address is an address within European Economic Area,
     you are contracting with Alibaba (Netherlands) B.V."_, and
     _"Alibaba Cloud US LLC"_ only for a billing address in the United States;
   - the **account console** names Intelligent Cloud Computing (Singapore)
     Private Limited as moooon B.V.'s counterparty (MOTIR-7192, 2026-10-02) —
     which differs from the agreement's EEA mapping, and is recorded as read
     rather than reconciled here (counsel review is MOTIR-3621's);
   - **no document read says which Alibaba entity operates or stores data in
     US (Virginia)**.

   So it is not established that the recipient in the United States is the
   DPF-certified entity, and **the US storage rests on the SCCs as well**, the
   same as the inference outside the EEA.

3. **Supplementary measures that actually exist**, each with its source:
   - **Encryption in transit.** The gateway calls the workspace over `https://`
     (TLS) — the endpoint in the row above. Between Alibaba's access region and
     the inference node, Alibaba's page states _"Transmission is encrypted
     end-to-end"_ (read 2026-11-12); it does not name the protocol.
   - **No training.** _"never uses your data for model training"_ (Model Studio
     FAQ, read 2026-10-02 by MOTIR-7192); re-read 2026-11-12 on the Model Studio
     _Security certifications and privacy_ page (last updated 2026-10-11) as
     _"will never use your data for model training"_.
   - **Retention is not stated.** The same page says Model Studio
     _"stores data generated from model and application calls"_ and gives **no
     period** (read 2026-11-12). Silence is not a commitment, and this note does
     not read one into it.
   - **A per-request exclusion.** Under this record's data policy (the amendment
     at the top), a caller may exclude Qwen on any request. Read from
     `motir-gateway` `motir/datapolicy/datapolicy.go` on `main` at `b3c4c00`:
     the Qwen channel is declared `TrainingNo` and `RetentionUnknown`, so
     **`X-Motir-Data-Policy: zero-retention` excludes it** (unknown retention
     fails closed) and `must-not-train` does not. A caller who will not accept a
     transfer outside the EEA does not pick a Qwen model.
4. **Conclusion of the controller.** The transfer proceeds under the **SCCs**
   that Alibaba's EEA DPA §6 commits it to, with the measures in point 3. This
   note asserts no fact about mainland-Chinese public-authority access, Alibaba's
   internal sub-processors, or the US entity's role beyond what is quoted above:
   none of the documents read states them. Counsel review of this note is
   **MOTIR-3621**'s, as for the rest of this record.

**Who reaches it.** Unchanged from the 2026-10-02 row: **the hosted planner**,
when a caller asks for a Qwen model, and **hosted agent runs**, when a person
picks one for a run or a project's per-level default names one
(`hosted-agent-run.md` §7). Customer requests reach this workspace only after
the live cut-over (MOTIR-11121), which waits on this story.

---

## §3 — The decision

~~**The hosted planner egresses only to upstreams carrying a recorded Chapter V
basis, and the gateway ENFORCES that rather than documenting it.**~~
**SUPERSEDED 2026-10-01 by MOTIR-3665** for D2 and D3: a provider's data policy is
disclosed and a caller excludes it per request (the amendment at the top). D1, D4
and the D5 text other than its D2 clause are not changed by that amendment.

| #      | Decision                                                                                                                                                                                                        | Where it lands                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **D1** | **The planner's default upstream stops being DeepSeek.** `PLANNER_MODELS.default` becomes **`o3`**, served by channel 3                                                                                         | `motir-ai` `src/llm/gatewayClient.ts`            |
| **D2** | ~~**The DeepSeek channel is disabled; Moonshot stays disabled.** Neither carries a basis~~ **SUPERSEDED 2026-10-01 by MOTIR-3665** — DeepSeek stays served; a caller excludes it per request                    | ~~gateway administration (channel `status: 2`)~~ |
| **D3** | ~~**The gateway enforces residency by GROUP**, so no caller can route to a no-basis channel whatever it asks for~~ **SUPERSEDED 2026-10-01 by MOTIR-3665** as a binding; the group survives as a mechanism (§5) | `motir-gateway` — the seam is named in §5        |
| **D4** | **Anthropic is the recorded fallback**, enablable without another decision record: its basis is now on file                                                                                                     | gateway administration                           |
| **D5** | **`content/legal/subprocessors.md` does not publish until D1 and D2 are applied AND the channel set has been re-read to confirm it**                                                                            | the publication precondition, §6                 |

### ⚠️ D1 and D2 have a MANDATORY ORDER, and the wrong one is an outage

Routing is `(group, model, enabled) → channel` (`model/ability.go`
`GetRandomSatisfiedChannel`). Channel 1 is the **only** channel serving
`deepseek-v4-pro`, and `deepseek-v4-pro` is the **code default**. So **disabling
the DeepSeek channel first takes AI planning down**: every request resolves to no
satisfied channel and `middleware/distributor.go` answers _"当前分组 %s 下对于模型
%s 无可用渠道"_.

**D1 before D2.** Ship the default change, confirm the planner is serving from
channel 3, then disable channel 1. The order is stated here because the
attractive move — "switch off the unlawful thing immediately" — is the one that
breaks the product, and whoever is holding the console at that moment will be in
a hurry.

### Why `o3` and not Anthropic

Both carry SCCs, so the basis does not separate them; it only decides the
**eligible set**. Within that set `o3` wins on three shipped facts:

- **Channel 3 is already enabled and already routable for `o3`** — it needs no
  key provisioned and no channel enabled.
- **It adds no new subprocessor.** OpenAI already receives our embedding traffic
  (`text-embedding-3-small`) and is already on the published list with its basis
  recorded. Anthropic is not on that list, so choosing it would enlarge the
  subprocessor set in the same change that is meant to settle it.
- **It retires a documented reliability workaround.** `gatewayClient.ts` carries
  a `deepseek-v4-pro` caveat — the model _"lands tool-calls in NON-thinking
  mode"_ and the loop reads around a missing `tool_calls` field
  (`deepseek-ai/DeepSeek-V3#1244`). The current default is the one our own code
  works around.

**This record does not claim `o3` matches `deepseek-v4-pro` on planning quality
— nobody has measured that here.** If the planner regresses, the eligible set is
`{OpenAI, Anthropic}` and moving within it is a config change, not another
decision record. What is _not_ available is moving back outside the set.

---

## §4 — What this amends in `planner-llm.md`, and one sentence there that is FALSE

`motir-ai` `docs/planner-llm.md` §3 chose DeepSeek as the first channel and
`deepseek-v4-pro` as the default. **That choice is superseded by D1.** Its
routing decision (§1, _through the gateway, never direct_), its SDK choice (§2),
its inference defaults (§4) and its structured-output mechanism (§5) all stand
untouched — this record changes which upstream is on the far side of the gateway,
not how the planner reaches it.

**One sentence in §3 is false against shipped code and must not be relied on:**

> _"Flipping the default is a **gateway channel + `ModelCreditRate` config
> change, NOT a `motir-ai` code change**."_

`gatewayClient.ts` hardcodes `PLANNER_MODELS.default`, and the only override is
the `PLANNER_MODEL` environment variable — which production does not set. A
gateway-side change alone cannot flip the default.

### ⚠️ The one way to make that sentence true is REJECTED, and it is worth naming

`model_mapping` (`model/channel.go` `GetModelMapping`) remaps a requested model
id to a different upstream model **inside a channel**. A channel could therefore
accept `deepseek-v4-pro` and serve it from OpenAI, making the superseded sentence
technically accurate with no `motir-ai` change at all.

**Rejected.** The consume log would then record `model_name: deepseek-v4-pro` for
requests OpenAI served. That log is the instrument §1 of this record used to
enumerate what has actually been transmitted, and it is the instrument any future
audit will use. A remedy that makes the transfer record unreadable is not a
remedy — it converts a legal problem into an _invisible_ legal problem, which is
strictly worse than the one being fixed. **The model id a request names must stay
the model a provider served.**

---

## §5 — D3: the enforcement seam, named

> **AMENDED 2026-10-01 (MOTIR-3687).** D3's binding, which pinned the planner user
> to a basis-only group, is SUPERSEDED. The seam described below SURVIVES: the GROUP
> column is still how residency is enforced for a mixed provider set, and DeepSeek
> stays outside the `transfer-basis` group.

The lesson this record is most at risk of repeating is that **a decision record
ships no code**. D1 is a default and D2 is a switch; both are one edit away from
being undone by someone who does not know why they are set. D3 is what makes the
constraint survive that.

**The seam is the gateway's GROUP column, and routing already reads it:**

| element                    | file                                                            | what it does                                                                |
| -------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| routing predicate          | `model/ability.go` `GetRandomSatisfiedChannel(group, model, …)` | selects a channel `WHERE group = ? AND model = ? AND enabled`               |
| where the group comes from | `middleware/distributor.go:24` — `CacheGetUserGroup(userId)`    | **the gateway USER, not the token.** A token inherits its owner's group     |
| the ability rows           | `model/ability.go` `AddAbilities`                               | one row per (model × group) from the channel's `models` and `group` columns |
| fail-closed message        | `middleware/distributor.go:49`                                  | _"当前分组 %s 下对于模型 %s 无可用渠道"_                                    |

**The state today is that no partition exists.** Read 2026-08-26: there is
exactly **one gateway user** (`root`, group `default`) and **all four channels
are in group `default`**. Every model any channel lists is reachable by the only
caller there is.

**The enforcement, therefore:** put the basis-carrying channels in a dedicated
group, set the planner user's group to it, and leave every no-basis channel out
of it. A request for `deepseek-v4-pro` then **fails closed** at the distributor
instead of egressing — which is the correct failure mode, because a planning job
that errors is recoverable and a transfer that happened is not.

**This is what makes D2 durable rather than a switch someone flips back.** A
re-enabled DeepSeek channel outside the planner's group still serves nobody.

Filed as its own card (**Consequences**), because it is product work across
`motir-ai` and `motir-gateway` plus a platform action, and this record ships no
code.

---

## §6 — Consequences

| #   | What must happen                                                                                                                                                           | Owner                   | Blocking?                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------- |
| 1   | **D1** — repoint `PLANNER_MODELS.default` to `o3`                                                                                                                          | `motir-ai`              | **Yes**, and FIRST           |
| 2   | ~~**D2** — disable gateway channel 1; keep channel 4 disabled~~ **STRUCK 2026-10-01** — card MOTIR-3636 cancelled 2026-08-27                                               | ~~platform (`manual`)~~ | ~~**Yes**, after 1~~ — no    |
| 3   | ~~**D3** — the residency group + planner-user binding~~ **STRUCK 2026-10-01** (the binding) — card MOTIR-3637 cancelled 2026-08-27; the group itself shipped as MOTIR-3634 | ~~`motir-gateway`~~     | ~~Yes, for durability~~ — no |
| 4   | Re-read the channel set and record the date                                                                                                                                | this record, amended    | Yes — D5                     |
| 5   | Amend `content/legal/subprocessors.md`                                                                                                                                     | done in this change     | —                            |
| 6   | Counsel + founder read §2's exposure window                                                                                                                                | MOTIR-3621              | Yes, before publication      |

**The publication precondition (D5), stated the way `legal-document-set.md` §3
states its own:** `subprocessors.md` may describe the settled decision now, and
it may not describe the settled _state_ until the state is settled. The page
carries the decision, the enumerated upstreams, their bases, and an explicit note
that the AI row is contingent on rows 1–3 above. **MOTIR-1134 must not publish a
page whose AI section still names a contingency.** That is a mechanical check,
exactly like the `«KVK NUMBER»` one.

### What this record deliberately does NOT do

- **It does not disable the channel.** That is an outward-facing change to a
  running production service which would take AI planning down if taken out of
  order, and it belongs to a person holding the console — surfaced as a card, not
  performed by the run that found it.
- **It does not assert who was affected.** §2 says what the log can support and
  names what it cannot.
- **It does not settle self-hosting the model.** A self-hoster is their own
  controller and configures their own gateway; for the hosted service, an
  upstream with SCCs discharges Q8 today and a self-hosted model is a cost and
  capability question, not a legality one.

---

## Rejected alternatives

| Alternative                                                      | Why not                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keep DeepSeek, rely on Art. 49 derogations**                   | The derogations cover _occasional_ transfers. Routing every planning request through one upstream is systematic by construction, and the EDPB has been explicit that Art. 49 is not a route to routine transfers                                            |
| **Keep DeepSeek, ask users for explicit consent**                | Consent must be freely given and revocable. Making it the condition of using the AI features at all is neither, and it would put a Chinese-jurisdiction disclosure in the sign-up path for a feature we can serve lawfully from an existing enabled channel |
| **Disable the DeepSeek channel first and fix the default after** | Takes AI planning down — `deepseek-v4-pro` is the code default and channel 1 is its only server. Same destination, an outage in the middle. See §3                                                                                                          |
| **`model_mapping` the id onto another upstream**                 | Makes the consume log lie about which provider served a request, destroying the one instrument that can audit transfers. §4                                                                                                                                 |
| **Document the constraint without enforcing it**                 | A decision record ships no code. D1 and D2 are both one edit from being undone, and the person undoing them would have no signal that a legal constraint was attached. §5                                                                                   |
| **Self-host the model**                                          | The largest change available and it buys nothing D1 does not, for the hosted service's Chapter V problem. Remains open on capability and cost grounds, decided elsewhere                                                                                    |
