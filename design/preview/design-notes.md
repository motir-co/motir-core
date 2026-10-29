# Preview — design notes

Design reference for the `preview` area: the pages a person meets between clicking a pull
request's preview link and seeing the preview, and every page they meet instead when they do not
get there (Story [MOTIR-5766](motir:cmu8jy0410003hutx7wbivthe) · card
[MOTIR-5774](motir:cmu8jy1cy0018hutxu9ymz7fu)).

| Surface              | Asset                                    | Notes                                                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The preview gate** | **`preview-gate.mock.html`** (HTML mock) | Panels E and 1–10: the entry, sign in to view, the member hand-off, refused, building, starting, failed, not available in previews, closed, not found, narrow, dark. **Gates [MOTIR-5779](motir:cmu8jy1qr001ihutx8ef0brkp)** (serving). See § The preview gate. |

---

## The preview gate (MOTIR-5774, 2026-10-29)

### Where each behaviour comes from

Nothing in this asset invents a step. The flow is the hosting decision page,
[MOTIR-5769](https://app.motir.co/pages/cmvrcywwc00jkhpr1zvvnike8) (approved), and the code that
already ships on this branch:

| Behaviour                                                             | Source                                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No gate cookie → app.motir.co/preview-access with `host` and `return` | §9 _The member gate_: _"No gate cookie → `https://app.motir.co/preview-access?host=<host>&return=<path>`, which needs a Motir session."_                                                                                     |
| Who is let in                                                         | §9: _"Access is the `project:browse` permission on the repository's project, never a role"_ — `lib/permissions/builtinRoles.ts:242` (workspace `member`) and `:289` (`viewer`)                                               |
| The hand-off                                                          | §9: a signed, single-use token (60 s), a redirect to `https://<host>/__motir/preview-auth?token=…`, which sets `__Host-motir-gate` (host-only, 8 hours). Motir's own session cookie is stripped from every forwarded request |
| The states                                                            | §9 _States_: _"`PreviewDeployment.state`, closed enum: `building`, `starting`, `ready`, `failed`, `closed`."_ — `lib/preview/states.ts`                                                                                      |
| The failure reasons                                                   | `lib/services/previewLifecycleService.ts`: the image build naming GitHub's conclusion, and the health check that did not pass in 10 minutes                                                                                  |
| The 501 / 413 / 411 answers                                           | §5: the gate _"refuses rather than truncates"_ — `413` over the gated body limit, `411` for a write with no `Content-Length`, `501` and _"the failed page's 'not available in previews' text"_ for a websocket upgrade       |
| Closed                                                                | §9 _Teardown_: the pull request closed, the repository taken over (previews destroyed), or the reaper                                                                                                                        |
| Who builds the pages and their copy                                   | §14: _"The gate pages' copy and layout: MOTIR-5774."_ The pages and both locales are [MOTIR-5779](motir:cmu8jy1qr001ihutx8ef0brkp)'s                                                                                         |

### The entry is composed, not redrawn (Panel E)

The door is the **In the preview** fact inside the Development block's How to test —
`../github/design-notes.md` §20, Panel **12e**, approved as the design result of
[MOTIR-5327](motir:cmtzoqqmt00bzhvtxgxduxev2), built by
[MOTIR-5336](motir:cmtzoqrc900cmhvtxgr8ueqjw) and fed by
[MOTIR-5333](motir:cmtzoqr5000cghvtxnaytfoe0)'s read. Its state table already distinguishes every
state the preview can be in. Quoted from §20:

> | preview `success` | severity success (mint) · _Ready_ | `circle-check` |
> | preview `in_progress` | severity warning (peach) · _Deploying_ | `circle-ellipsis` |
> | preview `failure` / `error` | severity danger (rose) · _Deploy failed_ / _Deploy errored_ | `circle-x` |
> | preview `inactive` / `canceled` | tone neutral · _Inactive_ / _Canceled_ | `circle-slash` / `ban` |

And MOTIR-5769 §9 _GitHub deployment statuses_ posts exactly those states for the preview's own
enum: `in_progress` for building and starting, `success` with `environment_url` for ready,
`failure` for failed, `inactive` for closed. So:

| preview state | GitHub state the lifecycle posts | what the row already shows (12e) |
| ------------- | -------------------------------- | -------------------------------- |
| `building`    | `in_progress`                    | Deploying                        |
| `starting`    | `in_progress`                    | Deploying                        |
| `ready`       | `success` + the URL              | Ready, and the link              |
| `failed`      | `failure`                        | Deploy failed                    |
| `closed`      | `inactive`                       | Inactive                         |

**No `development-block--preview-states.mock.html` delta is needed**, and none is drawn. Panel E
draws only the path from that row to the preview.

### Every state resolves to a page

| state      | page                                                                           | panel |
| ---------- | ------------------------------------------------------------------------------ | ----- |
| `building` | **Building**                                                                   | 4     |
| `starting` | **shares Building's page**, with the second step lit, its own heading and pill | 5     |
| `ready`    | **no page** — the request is forwarded and the application answers             | —     |
| `failed`   | **Failed** (and its neutral variant for the gate's 501 / 413 / 411)            | 6, 6b |
| `closed`   | **Closed**                                                                     | 7     |
| no row     | **Not found**, which shares Closed's layout                                    | 8     |

`starting` shares Building's page because a viewer can do nothing different in either: both say
wait, both end in ready or failed, and the steps already say which half they are in. A second page
would only be a second thing to keep in step.

### The six surfaces, and where each is served

| surface            | host             | when                                                                                                                                              | panel |
| ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **Preview access** | app.motir.co     | The redirect target. Signed out → the shipped sign-in with the preview banner (1). A member → no page (2). Signed in without access → Refused (3) | 1, 2  |
| **Refused**        | app.motir.co     | The viewer lacks `project:browse`, **or** the host matches no preview                                                                             | 3     |
| **Building**       | the preview host | A member is let in and the row is `building` or `starting`                                                                                        | 4, 5  |
| **Failed**         | the preview host | The row is `failed`, or the gate refuses a request (501 / 413 / 411)                                                                              | 6, 6b |
| **Closed**         | the preview host | The row is `closed`                                                                                                                               | 7     |
| **Not found**      | the preview host | A viewer with a valid gate cookie for a host whose row is gone                                                                                    | 8     |

### Not found cannot be told apart from closed, or from refused

The preview host **always** redirects a request without a gate cookie to preview-access, whatever
the host holds: a live row, a closed row or no row. Preview-access then answers a host with no row
exactly as it answers a viewer without `project:browse` — the Refused page, which names nothing.
So a viewer without access gets the same page for a preview that exists, one that is closed and
one that never existed, and learns nothing by trying hosts. Only a viewer who was already let in
(a valid, host-bound gate cookie) ever sees Closed or Not found, and Not found still says nothing
it cannot know.

### The chrome, and why it has no app navigation

- **app.motir.co pages** (1, 3) wear the shipped `(auth)` frame: the `--el-auth-wash` page, one
  `28rem` card at `--radius-card` with `--shadow-elevated`, the brand lockup inside the card
  (`../auth/two-factor-required.mock.html`). They are pre-session or held pages, as sign-in and the
  2FA hold are.
- **Preview-host pages** (4–8) wear a minimal Motir frame: a brand bar (lockup and a _Preview_
  tag), one card, one primary action, and a footer naming the address. **No app navigation**, for
  two reasons:
  1. The preview host carries **no Motir session**. §9 strips Motir's session cookie from every
     forwarded request and the gate cookie is host-only, so every nav link would bounce through a
     sign-in.
  2. A Motir shell on a foreign address is the exact shape a phishing page takes. The footer says
     the one thing a careful user needs: _Motir never asks for your password on this address;
     signing in happens only on app.motir.co._ No preview-host page holds a form field, ever.
- The brand bar's _Preview_ tag (lavender tint) is what keeps the page from being mistaken for the
  tenant's own application, whose chrome it never borrows.

### Elements — primitive, colour role and shape role

| element                                                          | primitive / markup                                | colour (`--el-*`)                                                                                                                                            | shape                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `(auth)` page and card                                           | the shipped `app/(auth)/layout.tsx`               | `--el-auth-wash` page · `--el-page-bg` card                                                                                                                  | `--radius-card` · `--shadow-elevated`                  |
| brand lockup                                                     | `BrandMark` (`../brand/brand-mark.mock.html` §7b) | glyph `--el-accent` / `--el-accent-text` · wordmark `--el-text`                                                                                              | `--radius-control`                                     |
| preview banner (1)                                               | `Callout` tone info                               | `--el-tint-sky` fill · `--el-text-strong` ink                                                                                                                | `--radius-card` · `--spacing-card-padding-12`          |
| preview-host page                                                | new frame (`PreviewGateFrame`)                    | `--el-surface` page · `--el-page-bg` bar and card · `--el-border`                                                                                            | `--radius-card` · `--shadow-card`                      |
| _Preview_ tag                                                    | `Pill`                                            | `--el-tint-lavender` · `--el-text-strong`                                                                                                                    | `--radius-badge` · `--spacing-chip-x/y`                |
| state pill                                                       | `Pill`                                            | Building / Starting `--el-tint-peach`; Failed `--el-tint-rose`; Closed, Not available `--el-muted` with `--el-text-secondary`; all others `--el-text-strong` | `--radius-badge` · `--spacing-chip-x/y`                |
| heading                                                          | `h1`, serif                                       | `--el-text`                                                                                                                                                  | —                                                      |
| body copy, facts labels, steps not reached, refresh line, footer | `p` / `dl`                                        | `--el-text-secondary` (AA on every surface)                                                                                                                  | —                                                      |
| steps                                                            | `ol` with `aria-current="step"`                   | done: `--el-success` dot, `--el-text-inverted` check · now: `--el-warning` ring · next: `--el-border-strong` ring                                            | circular dots (`50%`, genuinely circular)              |
| failure reason                                                   | `Callout`, hue in the border and the glyph        | border and glyph `--el-danger` · title and reason `--el-text` (never `--el-danger-text`)                                                                     | `--radius-card` · `--spacing-card-padding-12`          |
| neutral callout (6b)                                             | the same `Callout`                                | border `--el-border-strong` · glyph `--el-text-secondary` · text `--el-text`                                                                                 | as above                                               |
| the address                                                      | inline `code`                                     | `--el-code-bg` / `--el-code-text`                                                                                                                            | `--radius-control`                                     |
| work-item key                                                    | mono span                                         | `--el-text-secondary`                                                                                                                                        | —                                                      |
| primary action                                                   | `Button` primary                                  | `--el-accent` / `--el-accent-text`                                                                                                                           | `--radius-btn` · `--height-btn-md` · `--spacing-btn-x` |
| _Sign in with a different account_                               | `Button` ghost                                    | `--el-text-secondary`                                                                                                                                        | `--height-btn-sm` · `--spacing-btn-x-sm`               |

### Copy — every user-facing string, ready for `en` and `zh`

Keys are under `previewGate.*`. `{host}`, `{key}`, `{title}`, `{n}`, `{repo}` and `{email}` are
values; `{reason}` is the record's `failure_reason` (see _Handed to serving_).

| key                                    | en                                                                                                                                                                | zh                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `frame.tag`                            | Preview                                                                                                                                                           | 预览                                                                                                                     |
| `frame.footer`                         | You are on {host}, a preview Motir runs for a pull request. Motir never asks for your password on this address. Signing in happens only on app.motir.co.          | 你正在访问 {host}，这是 Motir 为一个拉取请求运行的预览。Motir 绝不会在此地址要求你输入密码。登录只在 app.motir.co 进行。 |
| `signIn.banner`                        | Sign in to open the preview at {host}. Previews open only for members of the project.                                                                             | 登录以打开 {host} 上的预览。预览仅对项目成员开放。                                                                       |
| `refused.pill`                         | Preview                                                                                                                                                           | 预览                                                                                                                     |
| `refused.title`                        | You don't have access to this preview                                                                                                                             | 你无权访问此预览                                                                                                         |
| `refused.body`                         | Previews open only for members of the project they belong to. If someone shared this link with you, ask them to add you to the project, then open the link again. | 预览仅对其所属项目的成员开放。如果是别人分享给你的链接，请让对方把你加入该项目，然后重新打开链接。                       |
| `refused.signedInAs`                   | Signed in as {email}                                                                                                                                              | 当前登录：{email}                                                                                                        |
| `refused.home`                         | Go to Motir                                                                                                                                                       | 前往 Motir                                                                                                               |
| `refused.switch`                       | Sign in with a different account                                                                                                                                  | 使用其他账号登录                                                                                                         |
| `refused.switchHint`                   | You'll come back to this preview after you sign in.                                                                                                               | 登录后你会回到此预览。                                                                                                   |
| `building.pill`                        | Building                                                                                                                                                          | 构建中                                                                                                                   |
| `building.title`                       | This preview is being built                                                                                                                                       | 正在构建此预览                                                                                                           |
| `building.body`                        | The repository's CI is building the preview image for this pull request's latest commit. It usually takes a few minutes.                                          | 仓库的 CI 正在为此拉取请求的最新提交构建预览镜像，通常需要几分钟。                                                       |
| `starting.pill`                        | Starting                                                                                                                                                          | 启动中                                                                                                                   |
| `starting.title`                       | This preview is starting                                                                                                                                          | 正在启动此预览                                                                                                           |
| `starting.body`                        | The image is built. Motir is starting it and waiting for its health check to pass.                                                                                | 镜像已构建完成。Motir 正在启动它，并等待健康检查通过。                                                                   |
| `steps.build`                          | Building the image                                                                                                                                                | 构建镜像                                                                                                                 |
| `steps.start`                          | Starting the preview                                                                                                                                              | 启动预览                                                                                                                 |
| `steps.ready`                          | Ready                                                                                                                                                             | 就绪                                                                                                                     |
| `building.refresh`                     | This page checks again every 10 seconds and opens the preview when it is ready.                                                                                   | 此页面每 10 秒检查一次，预览就绪后会自动打开。                                                                           |
| `facts.workItem`                       | Work item                                                                                                                                                         | 工作项                                                                                                                   |
| `facts.pullRequest`                    | Pull request                                                                                                                                                      | 拉取请求                                                                                                                 |
| `facts.pullRequestValue`               | {repo} · #{n}                                                                                                                                                     | {repo} · #{n}                                                                                                            |
| `action.openWorkItem`                  | Open {key} in Motir                                                                                                                                               | 在 Motir 中打开 {key}                                                                                                    |
| `action.openPullRequest`               | Open pull request #{n} on GitHub                                                                                                                                  | 在 GitHub 上打开拉取请求 #{n}                                                                                            |
| `failed.pill`                          | Failed                                                                                                                                                            | 失败                                                                                                                     |
| `failed.title`                         | This preview didn't start                                                                                                                                         | 此预览未能启动                                                                                                           |
| `failed.body`                          | Nothing is running for this pull request's latest commit. A new push builds it again.                                                                             | 此拉取请求的最新提交没有在运行的预览。新的推送会重新构建它。                                                             |
| `failed.reasonTitle`                   | What went wrong                                                                                                                                                   | 出了什么问题                                                                                                             |
| `failed.checks`                        | The work item shows this pull request's checks and their logs.                                                                                                    | 工作项中可以查看此拉取请求的检查及其日志。                                                                               |
| `unsupported.pill`                     | Not available in previews                                                                                                                                         | 预览中不可用                                                                                                             |
| `unsupported.title`                    | Previews can't do this                                                                                                                                            | 预览无法执行此操作                                                                                                       |
| `unsupported.websocket`                | Live connections (websockets) don't pass through the preview gate. The rest of the preview works as usual.                                                        | 实时连接（WebSocket）无法通过预览网关。预览的其他功能照常可用。                                                          |
| `unsupported.tooLarge`                 | Requests larger than 10 MB can't be sent to a preview.                                                                                                            | 无法向预览发送大于 10 MB 的请求。                                                                                        |
| `unsupported.noLength`                 | This request didn't say how large it is, so the preview gate can't accept it.                                                                                     | 此请求没有说明其大小，因此预览网关无法接受。                                                                             |
| `unsupported.otherTitle`               | The other two answers                                                                                                                                             | 另外两种情况                                                                                                             |
| `closed.pill`                          | Closed                                                                                                                                                            | 已关闭                                                                                                                   |
| `closed.title`                         | This preview has been shut down                                                                                                                                   | 此预览已关闭                                                                                                             |
| `closed.merged`                        | Pull request #{n} was merged, so Motir shut its preview down and deleted its database.                                                                            | 拉取请求 #{n} 已合并，因此 Motir 关闭了它的预览并删除了其数据库。                                                        |
| `closed.closed`                        | Pull request #{n} was closed without merging, so Motir shut its preview down and deleted its database.                                                            | 拉取请求 #{n} 未合并即被关闭，因此 Motir 关闭了它的预览并删除了其数据库。                                                |
| `closed.takenOver`                     | This repository has left Motir, so Motir shut its previews down and deleted their databases.                                                                      | 此仓库已离开 Motir，因此 Motir 关闭了它的预览并删除了其数据库。                                                          |
| `closed.unknown`                       | Motir shut this preview down and deleted its database.                                                                                                            | Motir 已关闭此预览并删除了其数据库。                                                                                     |
| `notFound.pill`                        | Not available                                                                                                                                                     | 不可用                                                                                                                   |
| `notFound.title`                       | There is no preview here                                                                                                                                          | 这里没有预览                                                                                                             |
| `notFound.body`                        | This address doesn't belong to a running preview. It may have been shut down, or the link may be mistyped.                                                        | 此地址不属于任何正在运行的预览。它可能已被关闭，或者链接输入有误。                                                       |
| `notFound.home`                        | Go to Motir                                                                                                                                                       | 前往 Motir                                                                                                               |
| `failed.reason.imageBuild` (record)    | The preview image did not build: the "Preview image" workflow ended with "{conclusion}". Its run log on GitHub says why.                                          | 预览镜像未能构建：「Preview image」工作流以「{conclusion}」结束。原因见其在 GitHub 上的运行日志。                        |
| `failed.reason.healthTimeout` (record) | The preview did not pass its health check within {minutes} minutes.                                                                                               | 预览未能在 {minutes} 分钟内通过健康检查。                                                                                |
| `failed.reason.healthFailed` (record)  | The preview started but failed its health check.                                                                                                                  | 预览已启动，但未通过健康检查。                                                                                           |
| `failed.reason.fallback` (record)      | The preview could not start.                                                                                                                                      | 预览无法启动。                                                                                                           |

### Decisions

| question                               | decision                                                                                                | why                                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| does the refusal name the project?     | **never** — it names only the address, which is already in the viewer's address bar                     | the card allows a name only where the viewer could already know the project exists; the one page that answers both "no access" and "no such host" can only honour that by naming nothing |
| a separate page for `starting`?        | **no**, it shares Building's                                                                            | the viewer's action is the same (wait), and the step list says which half they are in                                                                                                    |
| the way out of the refusal             | _Go to Motir_ and _Sign in with a different account_; the copy points at the person who shared the link | Motir has no access-request flow today; a button for one would be a dead end                                                                                                             |
| unknown host                           | redirect to the gate like any other, and refuse there                                                   | the preview host can never say whether a preview exists before the gate knows who is asking                                                                                              |
| the action when no work item is linked | _Open pull request #{n} on GitHub_                                                                      | a pull request without a linked card still has a place where its checks are                                                                                                              |
| refreshing a building page             | every 10 seconds, swapping in the application when the row turns ready                                  | the lifecycle polls health for up to 10 minutes; a 10-second check keeps the wait short without hammering the gate                                                                       |
| the gate's 501 / 413 / 411             | the Failed frame with a **neutral** callout, not a red one                                              | the preview is healthy; the request is what the gate cannot carry                                                                                                                        |
| a red reason ink                       | the hue in the callout's **border and glyph**, the reason on `--el-text`                                | `CLAUDE.md`'s danger rule; `--el-danger-text` is the ink for a danger FILL only                                                                                                          |

### Handed to serving ([MOTIR-5779](motir:cmu8jy1qr001ihutx8ef0brkp))

- **Building the pages and both locales** from the copy table above.
- **The closed reason** is not a column today. Serving derives it: the linked pull request merged
  (`closed.merged`) or closed (`closed.closed`), or the repository's takeover completed
  (`closed.takenOver`); anything else is `closed.unknown`.
- **The failure reason is stored as English text** on `preview_deployment.failure_reason`. The
  four strings the lifecycle writes are in the copy table as `(record)` rows. A zh page shows the
  translated string when the stored text matches one of them, and the stored text verbatim
  otherwise; storing a reason code beside the text is serving's call.
- **The refresh** needs no script: a `Refresh` header or `<meta http-equiv="refresh">` of 10 seconds
  on Building and Starting.
