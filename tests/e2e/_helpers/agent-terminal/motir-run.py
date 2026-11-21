#!/usr/bin/env python3
"""A STUB of `motir run <KEY> --run-id <id>` in AGENT MODE — what a card's run
session runs on the acceptance lane's fake agent machines (Story MOTIR-6864 ·
MOTIR-7031). TEST-ONLY: only the lane's terminal host (host.ts) hands it to the
REAL terminal server as the CLI its run session re-enters.

WHY A STUB. Everything around it is real: Motir's start, the launch job, the
orchestrator exec, the real `motir agent-terminal run` launcher writing the run
token into the run's 0700 state directory, the real server opening the run
session on a real PTY, the relay, the browser watching it. What the real
`motir run` would do INSIDE the session — clone the card's repositories from
GitHub, drive a real coding agent for minutes, push a branch — cannot happen in
this lane. So this plays the CLI's side of the run over the SAME `/api/v1`
ingest the real one uses, authenticated with the run's OWN token (read from
`$MOTIR_HOSTED_STATE/run.json`, which is where the launcher wrote it), and runs
the stub `claude -p` as its coding agent, echoing what it prints to the session
and into the run's log.

    adopt the run -> checkout_ready (no clone; see below) -> agent_started
    -> claude -p (its lines, live) -> agent_exited
    -> link the pull request the fake GitHub opened -> delivery_linked
    -> the card to Implemented -> close the run (drained)

The pull request's number is the content of the release file the spec writes
(paths.ts `runReleaseFile`) — the spec plays GitHub opening it. SIGTERM/SIGHUP
(Cancel run -> `motir agent-terminal stop`) stop the coding agent and exit.

THE `fix` FORM (Story MOTIR-8981 - MOTIR-9056). `motir fix <KEY>` is what a run started
with `command: 'fix'` re-enters, adopting the server-opened run through
`MOTIR_DISPATCH_RUN_ID` (the real CLI's own contract). Everything that CHOOSES the agent
is the shipped code: the run's `repair.resume` is read off `GET /api/v1/dispatch-runs/<id>`
and handed to `fix-agent-argv.ts`, which asks `chooseRepairAgent` for the command, so the
argv the stub vendor CLI records is the product's. What the real fix does around that
(check the branches out, push, watch CI) needs a real GitHub and is not played: the stub
runs the agent, then waits for the file the spec writes to say how the fix ended
(`green` closes the run `completed`, `gave_up` closes it `halted`).

THE `review` FORM (Story MOTIR-11941 - MOTIR-11951). `motir review <KEY>` is what a run
started from *Review in my agent* (`command: 'review'`, `origin: 'instance'`) re-enters,
adopting the server-opened run through `MOTIR_DISPATCH_RUN_ID` as a fix does. It plays the
real CLI's own-agent pipeline (`packages/cli/src/commands/review.ts`) over the same
`/api/v1` doors, with the run's OWN token: what the run reviews is read off the run
(`view.review`), the served `review-prompt` must still name that version (a moved head is
closed `completed` with nothing submitted, as the real one does), and the ONE verdict goes
through the user-token door `POST /api/v1/work-items/<KEY>/review-verdict` with the agent's
harness (its profile's label, from `MOTIR_SANDBOX_AGENT`) and its self-reported model. No
coding agent runs: the review's words are printed to the session and the run's log, and the
verdict is the content of the release file the spec writes (`{"verdict", "findingsMd"?,
"summaryMd"?, "model"}`), so the spec decides what the agent concluded without a clock.
"""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

CHILD = None


def stop(signum, _frame):
    if CHILD is not None and CHILD.poll() is None:
        CHILD.terminate()
    print(f"\r\n[motir] run stopped (signal {signum})", flush=True)
    sys.exit(128 + signum)


def say(line):
    print(f"[motir] {line}", flush=True)


class Api:
    def __init__(self, base, token):
        self.base = base.rstrip("/")
        self.token = token

    def call(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                raw = res.read().decode("utf-8")
                return res.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", "replace")
            return err.code, raw

    def must(self, method, path, body=None, ok=(200, 201, 204)):
        status, answer = self.call(method, path, body)
        if status not in ok:
            say(f"{method} {path} answered {status}: {str(answer)[:300]}")
            sys.exit(1)
        return answer

    def events(self, run_id, events):
        self.must("POST", f"/api/v1/dispatch-runs/{run_id}/events", {"events": events})

    def heartbeat(self, run_id):
        self.call("POST", f"/api/v1/dispatch-runs/{run_id}/heartbeat")


HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))


def agent_text(line):
    """The words in one line of a stub vendor CLI's JSON stream, or None."""
    try:
        value = json.loads(line)
    except ValueError:
        return line.rstrip("\n") or None
    if value.get("type") == "assistant":
        parts = value.get("message", {}).get("content", [])
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
        return text or None
    item = value.get("item") or {}
    if value.get("type") == "item.completed" and item.get("type") == "agent_message":
        return item.get("text")
    return None


def launch_agent(argv, key, api, run_id):
    """Run the vendor stub on the fix prompt; its words go to the session and the run's log."""
    global CHILD
    prompt = f"The checks on {key}'s pull request are failing. Fix them on the same branch."
    CHILD = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    CHILD.stdin.write(prompt)
    CHILD.stdin.close()
    for line in CHILD.stdout:
        text = agent_text(line)
        if text:
            print(text, flush=True)
            api.events(run_id, [{"kind": "log", "workItemKey": key, "body": text + "\n"}])
        api.heartbeat(run_id)
    return CHILD.wait()


def fix(key):
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    run_id = os.environ.get("MOTIR_DISPATCH_RUN_ID", "")
    state = os.environ.get("MOTIR_HOSTED_STATE", "")
    if os.environ.get("MOTIR_AGENT_RUN") != "1" or not state or not run_id:
        say("not started as a fix in an agent (MOTIR_AGENT_RUN / MOTIR_HOSTED_STATE / MOTIR_DISPATCH_RUN_ID unset)")
        return 2
    with open(os.path.join(state, "run.json"), encoding="utf-8") as fh:
        access = json.load(fh)
    # The run the launcher wrote the token for IS the run this process adopts.
    if access.get("runId") not in (None, run_id):
        say(f"run.json names {access.get('runId')}, not {run_id}")
        return 2
    api = Api(access["apiUrl"], access["token"])
    say(f"motir fix {key} - agent mode, run {run_id}")
    view = api.must("GET", f"/api/v1/dispatch-runs/{run_id}")
    if view.get("command") != "fix":
        say(f"run {run_id} is a {view.get('command')} run, not a repair")
        api.must("POST", f"/api/v1/dispatch-runs/{run_id}/close", {"stopReason": "halted"})
        return 1
    repair = view.get("repair") or {}
    e2e_dir = os.path.join(os.environ["HOME"], ".motir-e2e")
    chosen = subprocess.run(
        [os.path.join(REPO_ROOT, "node_modules", ".bin", "tsx"), os.path.join(HERE, "fix-agent-argv.ts"), key],
        input=json.dumps(repair.get("resume")),
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    if chosen.returncode != 0:
        say(f"could not choose the agent: {chosen.stderr[-400:]}")
        api.must("POST", f"/api/v1/dispatch-runs/{run_id}/close", {"stopReason": "halted"})
        return 1
    choice = json.loads(chosen.stdout)
    for pr in repair.get("pullRequests", []):
        say(f"  {pr['repo']}#{pr['number']} - {pr['branch']}")
    api.events(
        run_id,
        [{"kind": "checkout_ready", "workItemKey": key, "disposition": "running",
          "data": {"branch": (repair.get("pullRequests") or [{}])[0].get("branch")}}],
    )
    say(choice["line"])
    api.events(run_id, [{"kind": "agent_started", "workItemKey": key, "disposition": "running"}])
    code = launch_agent(choice["argv"], key, api, run_id)
    if code != 0 and choice.get("fresh"):
        # withFreshFallback: the FIRST failed resumed turn is retried once as a fresh agent.
        say("the agent could not resume that session - starting a fresh agent.")
        code = launch_agent(choice["fresh"], key, api, run_id)
    api.events(run_id, [{"kind": "agent_exited", "workItemKey": key, "exitCode": code}])
    if code != 0:
        say(f"the agent exited {code}")
        api.must("POST", f"/api/v1/dispatch-runs/{run_id}/close", {"stopReason": "halted"})
        return code
    say("fix pushed - watching the checks")
    release = os.path.join(e2e_dir, f"release-{run_id}")
    while not os.path.exists(release):
        time.sleep(1)
        api.heartbeat(run_id)
    with open(release, encoding="utf-8") as fh:
        ended = fh.read().strip()
    if ended == "gave_up":
        say(f"{key}: the checks are still red - giving up.")
        api.events(run_id, [{"kind": "card_settled", "workItemKey": key, "disposition": "failed"}])
        api.must("POST", f"/api/v1/dispatch-runs/{run_id}/close", {"stopReason": "halted"})
        return 1
    say(f"{key}: the checks are green.")
    api.events(run_id, [{"kind": "card_settled", "workItemKey": key, "disposition": "implemented"}])
    api.must("POST", f"/api/v1/dispatch-runs/{run_id}/close", {"stopReason": "completed"})
    return 0


# The harness an own-agent verdict names: the agent profile's label (the CLI's `ownHarness`).
PROFILE_LABELS = {"claude": "Claude Code", "codex": "Codex"}


def review(key):
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    run_id = os.environ.get("MOTIR_DISPATCH_RUN_ID", "")
    state = os.environ.get("MOTIR_HOSTED_STATE", "")
    if os.environ.get("MOTIR_AGENT_RUN") != "1" or not state or not run_id:
        say("not started as a review in an agent (MOTIR_AGENT_RUN / MOTIR_HOSTED_STATE / MOTIR_DISPATCH_RUN_ID unset)")
        return 2
    with open(os.path.join(state, "run.json"), encoding="utf-8") as fh:
        access = json.load(fh)
    if access.get("runId") not in (None, run_id):
        say(f"run.json names {access.get('runId')}, not {run_id}")
        return 2
    api = Api(access["apiUrl"], access["token"])
    say(f"motir review {key} - agent mode, run {run_id}")
    view = api.must("GET", f"/api/v1/dispatch-runs/{run_id}")
    if view.get("command") != "review":
        say(f"run {run_id} is a {view.get('command')} run, not a review")
        api.must("POST", f"/api/v1/dispatch-runs/{run_id}/close", {"stopReason": "halted"})
        return 1
    target = view.get("review")
    if not target:
        say(f"cannot review on run {run_id} - the run records no review target")
        api.events(run_id, [{"kind": "card_settled", "workItemKey": key, "disposition": "failed",
                             "data": {"reason": "the run records no review target"}}])
        api.must("POST", f"/api/v1/dispatch-runs/{run_id}/close", {"stopReason": "halted"})
        return 20
    served = api.must("GET", f"/api/v1/work-items/{key}/review-prompt")
    version = served["subjectVersion"]
    if target.get("subjectVersion") != version or target.get("gateId") != served.get("gateId"):
        say(f"{key}: the code moved since this review was started - it is now under review as {version}.")
        api.must("POST", f"/api/v1/dispatch-runs/{run_id}/close", {"stopReason": "completed"})
        return 0
    say(f"Adopted run {run_id}: reviewing {key} at {version}.")
    for pr in served.get("pullRequests", []):
        say(f"  {pr['repository']} #{pr['number']} at {pr['headSha']}")
    api.events(run_id, [{"kind": "checkout_ready", "workItemKey": key, "disposition": "running",
                         "data": {"checkouts": served.get("pullRequests", []), "branch": None}}])
    api.events(run_id, [{"kind": "agent_started", "workItemKey": key, "data": {"step": "review"}}])
    for line in (
        f"Reviewing {key} against its acceptance criteria…",
        "Reading the pull requests at their reviewed heads…",
    ):
        print(line, flush=True)
        api.events(run_id, [{"kind": "log", "workItemKey": key, "body": line + "\n"}])
    release = os.path.join(os.environ["HOME"], ".motir-e2e", f"release-{run_id}")
    while not os.path.exists(release):
        time.sleep(1)
        api.heartbeat(run_id)
    with open(release, encoding="utf-8") as fh:
        concluded = json.load(fh)
    model = concluded.get("model") or view.get("model") or "unknown"
    api.events(run_id, [{"kind": "agent_exited", "workItemKey": key, "exitCode": 0, "model": model,
                         "data": {"step": "review", "exitCode": 0, "model": model, "signal": None}}])
    profile = os.environ.get("MOTIR_SANDBOX_AGENT", "").strip()
    status, decided = api.call("POST", f"/api/v1/work-items/{key}/review-verdict", {
        "subjectVersion": version,
        "verdict": concluded["verdict"],
        "summaryMd": concluded.get("summaryMd"),
        "findingsMd": concluded.get("findingsMd"),
        "checklist": [],
        "harness": PROFILE_LABELS.get(profile, profile or "Claude Code"),
        "model": model,
    })
    if status != 200:
        say(f"POST review-verdict answered {status}: {str(decided)[:300]}")
        api.events(run_id, [{"kind": "card_settled", "workItemKey": key, "disposition": "failed"}])
        api.must("POST", f"/api/v1/dispatch-runs/{run_id}/close", {"stopReason": "halted"})
        return 1
    said = "approved" if decided["verdict"] == "approved" else "changes requested"
    say(f"{key}: verdict submitted - {said} at {decided['subjectVersion']}.")
    api.events(run_id, [{"kind": "card_settled", "workItemKey": key, "disposition": "implemented",
                         "data": {"verdict": decided["verdict"], "outcome": decided.get("outcome")}}])
    api.must("POST", f"/api/v1/dispatch-runs/{run_id}/close", {"stopReason": "completed"})
    return 0


def main():
    global CHILD
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "fix":
        return fix(args[1])
    if len(args) == 2 and args[0] == "review":
        return review(args[1])
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    if len(args) < 4 or args[0] != "run" or args[2] != "--run-id":
        say(f"unexpected arguments: {args}")
        return 2
    key, run_id = args[1], args[3]
    state = os.environ.get("MOTIR_HOSTED_STATE", "")
    if os.environ.get("MOTIR_AGENT_RUN") != "1" or not state:
        say("not started as a run in an agent (MOTIR_AGENT_RUN / MOTIR_HOSTED_STATE unset)")
        return 2
    with open(os.path.join(state, "run.json"), encoding="utf-8") as fh:
        access = json.load(fh)
    api = Api(access["apiUrl"], access["token"])

    say(f"motir run {key} — agent mode, run {run_id}")
    api.must("GET", f"/api/v1/dispatch-runs/{run_id}")
    api.heartbeat(run_id)
    # The real CLI clones here, with the run's git credential. The lane cannot mint
    # a GitHub installation token, so the stub clones nothing and reads the
    # project's repository from the file the seed wrote (paths.ts
    # `runRepositoryFile`).
    e2e_dir = os.path.join(os.environ["HOME"], ".motir-e2e")
    with open(os.path.join(e2e_dir, "repository"), encoding="utf-8") as fh:
        repository = fh.read().strip()
    branch = f"motir/{key.lower()}"
    say(f"checked out {repository} on {branch}")
    api.events(
        run_id,
        [
            {
                "kind": "checkout_ready",
                "workItemKey": key,
                "data": {
                    "branch": branch,
                    "branches": [{"repository": repository, "branch": branch, "workBranch": branch}],
                },
            }
        ],
    )
    say("starting Claude Code")
    # The conversation this run's agent holds, recorded the way the real CLI records it
    # (`agent_started.data.sessionId`) so a later fix can resume it (MOTIR-9056). A marker
    # file in the agent's e2e dir makes a run that recorded none.
    session_id = str(uuid.uuid4())
    with open(os.path.join(e2e_dir, f"session-{run_id}"), "w", encoding="utf-8") as fh:
        fh.write(session_id + "\n")
    started = {"kind": "agent_started", "workItemKey": key}
    if not os.path.exists(os.path.join(e2e_dir, "no-session")):
        started["data"] = {"agent": "claude", "sessionId": session_id}
    api.events(run_id, [started])

    release = os.path.join(e2e_dir, f"release-{run_id}")
    env = dict(os.environ, MOTIR_E2E_RELEASE=release)
    CHILD = subprocess.Popen(
        ["claude", "-p", f"Work on {key}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )
    for line in CHILD.stdout:
        print(line, end="", flush=True)
        api.events(run_id, [{"kind": "log", "workItemKey": key, "body": line}])
        api.heartbeat(run_id)
    code = CHILD.wait()
    api.events(run_id, [{"kind": "agent_exited", "workItemKey": key, "exitCode": code}])
    if code != 0:
        say(f"Claude Code exited {code}")
        api.must("POST", f"/api/v1/dispatch-runs/{run_id}/close", {"stopReason": "halted"})
        return code

    with open(release, encoding="utf-8") as fh:
        number = int(fh.read().strip())
    api.must(
        "POST",
        f"/api/v1/work-items/{key}/pull-requests",
        {"repository": repository, "number": number, "headRef": branch, "baseRef": "main"},
    )
    api.events(run_id, [{"kind": "delivery_linked", "workItemKey": key, "data": {"repository": repository}}])
    say(f"opened pull request {repository}#{number}")
    api.must("POST", f"/api/v1/work-items/{key}/transitions", {"status": "implemented"})
    say(f"{key} is Implemented")
    api.must("POST", f"/api/v1/dispatch-runs/{run_id}/close", {"stopReason": "drained"})
    say("run closed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
