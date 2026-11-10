"""Runs the switchyard CLI (the Switchyard command line) and parses its JSON output.

Free text (prompts, answers, comments, titles, tags) only ever reaches switchyard as one argv entry
after `--`, in a `--flag=value` pair, or on stdin, and the CLI always runs as `node cli.js`: a Windows
`.cmd` shim is resolved to the node and cli.js it runs, never executed (cmd.exe would re-parse the
arguments)."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Sequence

# Exit codes of `switchyard wait` (4: stopped or interrupted; the report's state says which).
WAIT_EXIT = {0: "idle", 3: "needs_input", 4: "stopped", 5: "scheduled", 124: "timeout"}
# `switchyard` exits 2 on a usage error, e.g. an answer that doesn't fit the question.
USAGE_EXIT = 2
PRIORITIES = ("urgent", "high", "normal", "low")
# Sync state of a graph edge (GRAPH-PROPAGATION.md): how far a parent's changes reached its child.
SYNC_STATES = ("in-sync", "pending", "merged", "resolving", "conflict", "upstream-changed")
# Question kinds answered with text; the other dialogs (select, confirm, approval) may grant something.
TEXT_QUESTION_KINDS = ("ask", "input", "editor")
# Title of the question the Switchyard omp extension's permission-mode gate asks before a tool runs.
GATE_PREFIX = "Allow tool: "
ALLOW_CHOICE = re.compile(r"^(allow|approve|accept)\b", re.IGNORECASE)
DENY_CHOICE = re.compile(r"^(deny|reject|refuse)\b", re.IGNORECASE)
# Approval modes an AO orchestrator can start in (`switchyard orchestrator config --permissions`), most
# restrictive first; the one it gets when nothing is set (src/ao/orchestrator.ts DEFAULT_ORCHESTRATOR_PERMISSIONS).
ORCHESTRATOR_PERMISSIONS = ("default", "accept-edits", "auto", "bypass-permissions")
ORCHESTRATOR_DEFAULT_PERMISSIONS = "bypass-permissions"
# `orchestrator config` settings as the plugin names them -> the CLI flag. Text settings (rules aside, which
# go on stdin) are set as `--flag=value`, toggles as on/off; `none` clears one.
ORCHESTRATOR_TEXT = {
    "harness": "harness",
    "model": "model",
    "effort": "effort",
    "permissions": "permissions",
    "rules_file": "rules-file",
    "worker_harness": "worker-harness",
    "worker_model": "worker-model",
}
ORCHESTRATOR_TOGGLES = {"review": "review", "auto_review": "auto-review"}
# The words of src/shared/pr-review.ts prSummaryLine, for a PR's facts as `orchestrator status --json` gives them.
PR_CI = {"pending": "CI running", "passing": "CI passing", "failing": "CI failing"}
PR_REVIEW = {"approved": "approved", "changes_requested": "changes requested", "review_required": "review required"}
PR_MERGE = {"mergeable": "mergeable", "conflicting": "conflicts", "blocked": "merge blocked", "unstable": "merge unstable"}


def pr_summary_line(facts: dict) -> str:
    """`#12 open · CI passing · approved · mergeable`: the parts that say something; nothing but the
    state for a finished PR (the CLI and the Switchyard page print the same line)."""
    state = str(facts.get("state") or "open")
    parts = [state]
    if state in ("open", "draft"):
        for table, key in ((PR_CI, "ci"), (PR_REVIEW, "review")):
            if facts.get(key) in table:
                parts.append(table[facts[key]])
        if facts.get("reviewComments"):
            parts.append("unresolved comments")
        if facts.get("mergeability") in PR_MERGE:
            parts.append(PR_MERGE[facts["mergeability"]])
    return f"#{facts.get('number')} {' · '.join(parts)}"


def is_approval(question: dict) -> bool:
    """True for a dialog that approves or denies something (a tool permission, plan approval) rather than
    a plain question answered with text or a choice. The CLI says so itself (`approval`, when it can);
    else: a `select` is an approval when its choices allow and deny something (AO shows an omp `ask`
    with options as a `select` too, which the agent may answer); any other non-text kind is one;
    and the permission-mode gate's "Allow tool: …" question is one whatever its kind."""
    flag = question.get("approval")
    if isinstance(flag, bool):
        return flag
    if any(str(question.get(k) or "").startswith(GATE_PREFIX) for k in ("title", "message")):
        return True
    kind = str(question.get("kind") or "")
    if kind in TEXT_QUESTION_KINDS:
        return False
    if kind == "select":
        options = [str(o) for o in question.get("options") or []]
        return any(ALLOW_CHOICE.match(o) for o in options) and any(DENY_CHOICE.match(o) for o in options)
    return True


def edges_of(upstream: Any) -> list[dict]:
    """The parent edges of an `upstream` value: `show`/`ls` give {state, edges: [{parent, state, files?}]}
    (state: the worst incoming edge); `plan status` edges come as a bare list."""
    if isinstance(upstream, dict):
        upstream = upstream.get("edges")
    return [e for e in upstream if isinstance(e, dict)] if isinstance(upstream, list) else []


def edge_mark(edge: dict) -> str:
    """What makes an edge's state new: its parent and head, or (when the CLI gives no head) the files at issue."""
    return f"{edge.get('parentSession') or edge.get('parent')}:{edge.get('parentHead') or edge.get('at') or ','.join(sorted(str(f) for f in edge.get('files') or []))}"


def short(session_id: str) -> str:
    """A session id for messages: AO ids (`<project>-<n>`, already short and what every command takes)
    in full; a legacy Switchyard id (no `-`, 14 characters) by its first 8, the prefix it was known by."""
    return session_id[:8] if "-" not in session_id and len(session_id) > 12 else session_id


def free_text_ok(value: str) -> str:
    """A session reference or schedule for a positional argument: never something switchyard reads as a flag."""
    if value.startswith("-"):
        raise SwitchyardError(f"invalid value {value[:40]!r}")
    return value


def agent_state(info: dict) -> str:
    """The session's state from an `switchyard ls --json` entry (agentState in
    src/shared/session-report.ts): queued, scheduled, starting, working, needs_input, idle, interrupted
    or stopped."""
    state = info.get("state")
    return state if isinstance(state, str) and state else "unknown"


def is_done(info: dict) -> bool:
    """A finished session the user can archive: marked completed (`switchyard complete`), or idle with
    nothing queued or running."""
    if info.get("completed") is True:
        return True
    q = info.get("queue") if isinstance(info.get("queue"), dict) else {}
    return agent_state(info) == "idle" and not int(q.get("pending") or 0) and not int(q.get("running") or 0)


class SwitchyardError(RuntimeError):
    """switchyard is missing, failed, or printed something that isn't the expected JSON."""


@dataclass
class Result:
    code: int
    stdout: str
    stderr: str


def runtime_cli() -> Path:
    """cli.js in the switchyard runtime folder (<SWITCHYARD_HOME or ~/.switchyard>/runtime)."""
    home = os.environ.get("SWITCHYARD_HOME") or str(Path.home() / ".switchyard")
    return Path(home) / "runtime" / "cli.js"


# The Windows launcher the extension writes (src/shared/cli-launcher.ts launcherText):
#   @echo off / rem … / [set ELECTRON_RUN_AS_NODE=1] / "<node>" "<cli.js>" %*
_SHIM_RUN = re.compile(r'^"([^"]+)" "([^"]+\.js)" %\*\s*$', re.MULTILINE)
# The wrapper `npm install -g switchyard` writes next to the package (npm's cmd-shim):
#   … "%_prog%"  "%dp0%\node_modules\switchyard\<bin>.js" %*  (older npm: "%~dp0\node_modules\…")
# with node from %dp0%\node.exe, else PATH.
_NPM_SHIM_RUN = re.compile(r'"%(?:dp0%|~dp0)\\(node_modules\\switchyard\\[^"%]+\.js)"\s+%\*', re.IGNORECASE)


def npm_shim_command(path: Path, text: str) -> Optional[list[str]]:
    """The argv npm's `switchyard.cmd` wrapper runs (node and the package's cli.js), or None."""
    m = _NPM_SHIM_RUN.search(text)
    if not m:
        return None
    prefix = path.parent
    script = prefix.joinpath(*m.group(1).split("\\"))
    if not script.is_file():
        return None
    local_node = prefix / "node.exe"
    node = str(local_node) if local_node.is_file() else shutil.which("node")
    return [node, str(script)] if node else None


def shim_command(path: Path) -> Optional[tuple[list[str], dict[str, str]]]:
    """(argv, extra env) a `.cmd` launcher of switchyard runs, or None when it isn't one."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    m = _SHIM_RUN.search(text)
    if not m:
        npm = npm_shim_command(path, text)
        return (npm, {}) if npm else None
    if not Path(m.group(1)).is_file() or not Path(m.group(2)).is_file():
        return None
    env = {"ELECTRON_RUN_AS_NODE": "1"} if re.search(r"^set ELECTRON_RUN_AS_NODE=1\s*$", text, re.MULTILINE) else {}
    return [m.group(1), m.group(2)], env


def resolve_command(configured: Optional[str] = None) -> Optional[tuple[list[str], dict[str, str]]]:
    """(argv, extra env) that runs switchyard: the configured path, then PATH, then where `Switchyard: Install
    switchyard Command` puts it (~/.local/bin/switchyard; %LOCALAPPDATA%\\switchyard\\switchyard.cmd
    on Windows), then the runtime folder's cli.js.

    A .js path (out/cli.js, the runtime's cli.js) runs with node from PATH; a .cmd/.bat launcher is
    read for the node and cli.js it runs and never executed itself."""
    candidates = [configured] if configured else []
    on_path = shutil.which("switchyard")
    if on_path:
        candidates.append(on_path)
    candidates.append(str(Path.home() / ".local" / "bin" / "switchyard"))
    if os.environ.get("LOCALAPPDATA"):
        candidates.append(str(Path(os.environ["LOCALAPPDATA"]) / "switchyard" / "switchyard.cmd"))
    candidates.append(str(runtime_cli()))
    for c in candidates:
        if not c:
            continue
        p = Path(os.path.expanduser(c))
        if not p.is_file():
            continue
        suffix = p.suffix.lower()
        if suffix == ".js":
            node = shutil.which("node")
            if node:
                return [node, str(p)], {}
        elif suffix in (".cmd", ".bat"):
            shim = shim_command(p)
            if shim:
                return shim
        elif os.name != "nt" and os.access(p, os.X_OK):
            return [str(p)], {}
    return None


def find_switchyard(configured: Optional[str] = None) -> Optional[list[str]]:
    """The argv that runs switchyard (see resolve_command), or None."""
    found = resolve_command(configured)
    return found[0] if found else None




class Switchyard:
    def __init__(self, configured: Optional[str] = None) -> None:
        self.configured = configured

    def resolved(self) -> tuple[list[str], dict[str, str]]:
        found = resolve_command(self.configured)
        if not found:
            raise SwitchyardError(
                "switchyard not found: install it (Switchyard extension: Switchyard: Install switchyard Command) "
                "or set the plugin's switchyard setting to switchyard or its cli.js"
            )
        return found

    def command(self) -> list[str]:
        return self.resolved()[0]

    def available(self) -> bool:
        return resolve_command(self.configured) is not None

    def run(self, args: Sequence[str], *, stdin: Optional[str] = None, timeout: float = 60) -> Result:
        argv, extra = self.resolved()
        env = {**os.environ, "NO_COLOR": "1", **extra}
        try:
            p = subprocess.run(
                [*argv, *args],
                input=stdin,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
            )
        except subprocess.TimeoutExpired as exc:
            raise SwitchyardError(f"switchyard {' '.join(args[:2])} timed out after {int(timeout)}s") from exc
        except OSError as exc:
            raise SwitchyardError(f"could not run switchyard: {exc}") from exc
        return Result(p.returncode, p.stdout, p.stderr)

    def ok(self, args: Sequence[str], *, stdin: Optional[str] = None, timeout: float = 60) -> str:
        """Runs a command that must succeed; returns its stdout."""
        r = self.run(args, stdin=stdin, timeout=timeout)
        if r.code != 0:
            raise SwitchyardError(error_text(r) or f"switchyard {args[0]} exited with {r.code}")
        return r.stdout

    def json(self, args: Sequence[str], *, stdin: Optional[str] = None, timeout: float = 60) -> Any:
        return parse_json(self.ok(args, stdin=stdin, timeout=timeout), args)

    # ---- the commands the plugin uses ----

    def sessions(self, all: bool = True) -> list[dict]:
        out = self.json(["ls", "--json", *(["--all"] if all else [])])
        return [s for s in out if isinstance(s, dict)] if isinstance(out, list) else []

    def show(self, session: str) -> Optional[dict]:
        """The session's report, or None when no such session exists (removed)."""
        r = self.run(["show", "--json", "--", free_text_ok(session)])
        if r.code != 0:
            msg = error_text(r)
            if "no session matches" in msg.lower():
                return None
            raise SwitchyardError(msg or f"switchyard show exited with {r.code}")
        report = parse_json(r.stdout, ["show"])
        return report if isinstance(report, dict) else None

    def answer(self, session: str, text: str, question: Optional[str] = None) -> Result:
        """`switchyard answer <session> [--question <id>] -- <text>`: exit 0 answered, USAGE_EXIT the
        text doesn't fit the question; with `question`, 1 when another dialog is first by now."""
        q = [f"--question={question}"] if question else []
        return self.run(["answer", free_text_ok(session), *q, "--", text])

    def send(self, session: str, text: str, *, steer: bool = False) -> None:
        """A prompt (stdin) to the session; while it works it waits for the end of the turn unless `steer`."""
        self.ok(["send", free_text_ok(session), "-", *(["--steer"] if steer else [])], stdin=text, timeout=90)

    def queue_add(self, session: str, task: str, *, notes: Optional[str] = None, subtasks: Sequence[str] = (), top: bool = False, run: bool = False, after: Sequence[str] = ()) -> Any:
        """Adds a task to the session's queue; returns the queue. stdin carries the title (one line) and,
        after the first newline, the notes (`queue add -` keeps them verbatim). `after`: sessions the
        queue waits for (replaces the queue's current dependencies)."""
        args = ["queue", free_text_ok(session), "add", "-", "--json", *(f"--sub={s}" for s in subtasks)]
        args += [*(["--top"] if top else []), *(["--run"] if run else [])]
        title = " ".join(task.split())
        # Dependencies first: with --run the task must not start before they are in place.
        if after:
            self.queue_after(session, after)
        return self.json(args, stdin=f"{title}\n{notes}" if notes else title)

    def queue_at(self, session: str, when: str) -> Any:
        """Schedules the session's queue (+30m, 14:30, an ISO time) or cancels the schedule (off); returns the queue."""
        return self.json(["queue", free_text_ok(session), "at", "--json", "--", free_text_ok(when)])

    def queue_run(self, session: str) -> Any:
        """Runs the session's queue now (its first pending task goes ahead, a scheduled start is dropped); returns the queue."""
        return self.json(["queue", free_text_ok(session), "run", "--json"])

    def queue_retry(self, session: str) -> Any:
        """`queue requeue`: failed tasks, else a paused or interrupted queue, else the last finished task back to
        pending and the queue on (a scheduled start is kept); returns the queue. Fails when there is nothing to requeue."""
        return self.json(["queue", free_text_ok(session), "requeue", "--json"])

    def queue_get(self, session: str) -> Any:
        """The session's queue (queue.json: tasks, autoRun, startAt)."""
        return self.json(["queue", free_text_ok(session), "--json"])

    def queue_after(self, session: str, after: Sequence[str]) -> Any:
        """Pending tasks of the session wait until these sessions finished (empty: no waiting); returns
        the queue. Refused for the session itself, unknown sessions and cycles."""
        refs = [free_text_ok(s) for s in after] or ["off"]
        return self.json(["queue", free_text_ok(session), "after", "--json", "--", *refs])

    def plan_status(self, ref: Optional[str] = None) -> list[dict]:
        """`plan status --json`: the graph edges and how far each parent's changes reached its child
        ({parent, parentSession, child, childSession, state, files?, parentHead?, childHead?, at?};
        state is one of SYNC_STATES), for one task or session, else for every plan."""
        out = self.json(["plan", "status", "--json", *(["--", free_text_ok(ref)] if ref else [])])
        edges = out.get("edges") if isinstance(out, dict) else None
        return [e for e in edges if isinstance(e, dict)] if isinstance(edges, list) else []

    def upstream_by_session(self) -> dict[str, list[dict]]:
        """{child session: its parent edges} from `plan status`: what `show`/`ls` don't carry. {} when the
        CLI has no `plan status` or the planner isn't reachable: propagation is then simply not shown."""
        try:
            edges = self.plan_status()
        except SwitchyardError:
            return {}
        out: dict[str, list[dict]] = {}
        for e in edges:
            if e.get("childSession"):
                out.setdefault(str(e["childSession"]), []).append(e)
        return out

    def plan_sync(self, ref: str, *, rerun: bool = False) -> dict:
        """`plan sync <task|session> --json`: brings the parents' changes into its worktree now;
        `rerun` also runs its task again with them (for a done task marked upstream-changed)."""
        out = self.json(["plan", "sync", "--json", *(["--rerun"] if rerun else []), "--", free_text_ok(ref)], timeout=120)
        return out if isinstance(out, dict) else {}

    def priority(self, session: str, priority: str) -> str:
        if priority not in PRIORITIES:
            raise SwitchyardError(f"priority must be one of {', '.join(PRIORITIES)}")
        return self.ok(["prio", free_text_ok(session), priority]).strip()

    def scheduler(self) -> dict:
        out = self.json(["sched", "--json"])
        return out if isinstance(out, dict) else {}

    def status(self) -> dict:
        """`switchyard status --json`: the server, omp, sessions by state, tasks, scheduler and remote
        access, with `ok` and `problems` (it exits 1 when something is wrong, still printing the JSON)."""
        r = self.run(["status", "--json"], timeout=30)
        try:
            out = json.loads(r.stdout)
        except ValueError as exc:
            raise SwitchyardError(error_text(r) or f"switchyard status exited with {r.code}") from exc
        if not isinstance(out, dict):
            raise SwitchyardError(f"switchyard status printed {r.stdout.strip()[:100]!r}")
        return out

    def archive(self, session: str) -> str:
        """Hides the session from the default lists (`switchyard archive`); returns what it printed."""
        return self.ok(["archive", free_text_ok(session)]).strip()

    def unarchive(self, session: str) -> str:
        return self.ok(["unarchive", free_text_ok(session)]).strip()

    def complete(self, session: str) -> dict:
        """Marks the session completed (`switchyard complete`): done, whatever its state. Returns
        {id, completed, completedAt?, changed}."""
        return self._completed("complete", session)

    def uncomplete(self, session: str) -> dict:
        return self._completed("uncomplete", session)

    def _completed(self, cmd: str, session: str) -> dict:
        out = self.json([cmd, free_text_ok(session), "--json"])
        if not isinstance(out, dict):
            raise SwitchyardError(f"switchyard {cmd} printed {str(out)[:100]!r}")
        return out

    def projects(self) -> list[dict]:
        out = self.json(["projects", "--json"])
        return [p for p in out if isinstance(p, dict)] if isinstance(out, list) else []

    def models(self, search: Optional[str] = None) -> dict:
        """`switchyard models --json`: {"models": [{selector, provider, id, name, default, …}],
        "default": the Switchyard default selector or None, "ompDefault": omp's own default or None,
        "source": the running session whose omp's choices these are, else None with a "note" and no models}."""
        out = self.json(["models", "--json", *(["--", search] if search else [])], timeout=60)
        if not isinstance(out, dict) or not isinstance(out.get("models"), list):
            raise SwitchyardError(f"switchyard models printed {str(out)[:100]!r}")
        return out

    def model(self, session: str, selector: Optional[str] = None) -> dict:
        """A session's model ({id, model, running}), or switches it ({id, model, applied: live|next-resume})."""
        out = self.json(["model", free_text_ok(session), "--json", *(["--", selector] if selector else [])])
        return out if isinstance(out, dict) else {}

    def default_model(self) -> Optional[str]:
        """The Switchyard default model (selector) new sessions get when they name none."""
        out = self.json(["config", "get", "model", "--json"])
        return out if isinstance(out, str) and out else None

    def set_default_model(self, selector: Optional[str]) -> None:
        self.ok(["config", "set", "model", "--", selector or "none"])

    def open_folder(self, folder: str) -> dict:
        """`switchyard vscode --folder=<dir> --json`: {folder, url, authority, windowAt}, a link that
        opens exactly that folder in VS Code (in the last-used window's remote, if any)."""
        out = self.json(["vscode", f"--folder={folder}", "--json"])
        if not isinstance(out, dict) or not isinstance(out.get("url"), str):
            raise SwitchyardError("switchyard vscode printed no link")
        return out

    def version(self) -> dict:
        """{"cli": version, "server": version or None, "pid": server pid or None}."""
        out = self.json(["version", "--json"], timeout=20)
        if not isinstance(out, dict) or not isinstance(out.get("cli"), str):
            raise SwitchyardError(f"switchyard version printed {str(out)[:100]!r}")
        return {"cli": out["cli"], "server": out.get("server"), "pid": out.get("pid")}

    def new(
        self,
        cwd: str,
        *,
        prompt: Optional[str] = None,
        task: Optional[str] = None,
        subtasks: Sequence[str] = (),
        notes: Optional[str] = None,
        at: Optional[str] = None,
        title: Optional[str] = None,
        mode: Optional[str] = None,
        tags: Sequence[str] = (),
        group: Optional[str] = None,
        priority: Optional[str] = None,
        model: Optional[str] = None,
        harness: Optional[str] = None,
        after: Sequence[str] = (),
    ) -> dict:
        """Starts a session (prompt) or queues one (task); returns {id, started, title, cwd, startAt?, after?}.
        `after` (task only): sessions whose work must finish before the task starts."""
        if bool(prompt) == bool(task):
            raise SwitchyardError("give either a prompt or a task")
        if priority and priority not in PRIORITIES:
            raise SwitchyardError(f"priority must be one of {', '.join(PRIORITIES)}")
        if prompt and after:
            raise SwitchyardError("after holds back a queued task: give a task, not a prompt")
        # `--flag=value`: a value starting with `--` stays a value.
        args = ["new", "--detach", "--json"]
        stdin = None
        if prompt:
            args += ["-p", "-"]
            stdin = prompt
        else:
            args.append(f"--task={task}")
            args += [f"--sub={s}" for s in subtasks]
            if notes:
                args += ["--notes", "-"]
                stdin = notes
            if at:
                args.append(f"--at={at}")
            args += [f"--after={s}" for s in after]
        for flag, value in (("title", title), ("mode", mode), ("group", group), ("priority", priority), ("model", model), ("harness", harness)):
            if value:
                args.append(f"--{flag}={value}")
        args += [f"--tag={t}" for t in tags]
        # The folder is a plain argument, not after `--`: what follows `--` is omp's own flags. It is
        # always an absolute path (resolve_place), so it never reads as a flag.
        if cwd.startswith("-"):
            raise SwitchyardError(f"not a folder: {cwd}")
        args.append(cwd)
        out = self.json(args, stdin=stdin, timeout=90)
        if not isinstance(out, dict) or not isinstance(out.get("id"), str):
            raise SwitchyardError(f"switchyard new printed no session id: {str(out)[:200]}")
        return out

    # ---- the project's AO orchestrator (`switchyard orchestrator …`; everything about it is AO's and the CLI's) ----

    def _orchestrator_args(self, verb: str, project: Optional[str], *flags: str) -> list[str]:
        """`orchestrator <verb> --json [--project=<id|name|folder>] …`: the project is a flag value, so a name
        starting with `--` stays a name; without one the CLI uses the git project of its working folder."""
        return ["orchestrator", verb, "--json", *([f"--project={project}"] if project else []), *flags]

    def orchestrators(self, *, stopped: bool = False) -> list[dict]:
        """Every project's orchestrator (`orchestrator ls --json`; `stopped` adds the ones no longer running): the
        CLI's OrchestratorInfo (id, projectId, projectName, projectPath, harness, model, state, displayStatus, active,
        question?, reply?, config, workers[{id, title, state, displayStatus, branch, prs[]}], counts), running first."""
        out = self.json(["orchestrator", "ls", "--json", *(["--all"] if stopped else [])])
        items = out.get("orchestrators") if isinstance(out, dict) else None
        if not isinstance(items, list):
            raise SwitchyardError(f"switchyard orchestrator ls printed {str(out)[:100]!r}")
        return [o for o in items if isinstance(o, dict)]

    def orchestrator(self, project: Optional[str] = None) -> dict:
        """`orchestrator status --json`: {project: {id, name, path} | None, orchestrator: OrchestratorInfo | None, note?};
        no orchestrator yet is `orchestrator: None`, a folder AO has no project for `project: None` with a note."""
        out = self.json(self._orchestrator_args("status", project))
        if not isinstance(out, dict) or "orchestrator" not in out:
            raise SwitchyardError(f"switchyard orchestrator status printed {str(out)[:100]!r}")
        return out

    def orchestrator_submit(self, text: str, *, project: Optional[str] = None, steer: bool = False, harness: Optional[str] = None) -> dict:
        """Gives the orchestrator a high-level task on stdin (starting it, or bringing a stopped one back, when needed);
        returns {orchestrator, projectId, harness?, started, revived, turnId?, mode: send|steer, project}. `steer` redirects
        the turn in progress instead of queueing behind it. `harness` applies when this call starts it."""
        flags = ["-", *(["--steer"] if steer else []), *([f"--harness={harness}"] if harness else [])]
        out = self.json(self._orchestrator_args("submit", project, *flags), stdin=text, timeout=240)
        if not isinstance(out, dict) or not isinstance(out.get("orchestrator"), str):
            raise SwitchyardError(f"switchyard orchestrator submit printed no orchestrator id: {str(out)[:200]}")
        return out

    def orchestrator_lifecycle(self, verb: str, project: Optional[str] = None, *, harness: Optional[str] = None) -> dict:
        """`orchestrator start|restart|stop`: start/restart give {id, started, revived, harness?, projectId} (restart replaces
        the orchestrator with a fresh one on the project's current settings; `harness` is saved first), stop {id, projectId,
        stopped}. Stopping when nothing runs is `{projectId, stopped: False}`, not an error."""
        if verb not in ("start", "restart", "stop"):
            raise SwitchyardError("orchestrator action must be start, restart or stop")
        r = self.run(self._orchestrator_args(verb, project, *([f"--harness={harness}"] if harness and verb != "stop" else [])), timeout=240)
        try:
            out = json.loads(r.stdout)
        except ValueError:
            out = None
        if isinstance(out, dict) and (r.code == 0 or (verb == "stop" and out.get("stopped") is False)):
            return out
        raise SwitchyardError(error_text(r) or f"switchyard orchestrator {verb} exited with {r.code}")

    def orchestrator_config(self, project: Optional[str] = None, patch: Optional[dict[str, Any]] = None) -> dict:
        """The project's orchestrator settings ({projectId, config}), changed first by `patch` when it has any: keys are
        harness, model, effort, permissions, rules, rules_file, worker_harness, worker_model (text), review and auto_review
        (True/False); a None value clears the setting, a missing key keeps it. A running orchestrator keeps what it started
        with: `orchestrator_lifecycle("restart")` applies the change. AO validates the values."""
        flags: list[str] = []
        stdin: Optional[str] = None
        for key, value in (patch or {}).items():
            if key == "rules":
                # Standing instructions are free text: stdin, whatever their length or first characters.
                flags.append("--rules=none" if value is None else "--rules=-")
                stdin = None if value is None else str(value)
            elif key in ORCHESTRATOR_TEXT:
                flags.append(f"--{ORCHESTRATOR_TEXT[key]}={'none' if value is None else value}")
            elif key in ORCHESTRATOR_TOGGLES:
                flags.append(f"--{ORCHESTRATOR_TOGGLES[key]}={'none' if value is None else 'on' if value else 'off'}")
            else:
                raise SwitchyardError(f"unknown orchestrator setting {key}")
        out = self.json(self._orchestrator_args("config", project, *flags), stdin=stdin)
        if not isinstance(out, dict) or not isinstance(out.get("config"), dict):
            raise SwitchyardError(f"switchyard orchestrator config printed {str(out)[:100]!r}")
        return out

    def harnesses(self) -> dict:
        """`switchyard harnesses --json`: {harnesses: [{id, label, authStatus, installed, usageCount, unavailable?, default}],
        default: {harness, source, reason} | None, problem?}: AO's chat harnesses (it exits 1 with a `problem` when none is usable)."""
        r = self.run(["harnesses", "--json"], timeout=30)
        try:
            out = json.loads(r.stdout)
        except ValueError as exc:
            raise SwitchyardError(error_text(r) or f"switchyard harnesses exited with {r.code}") from exc
        if not isinstance(out, dict) or not isinstance(out.get("harnesses"), list):
            raise SwitchyardError(f"switchyard harnesses printed {r.stdout.strip()[:100]!r}")
        return out


def parse_json(text: str, args: Sequence[str]) -> Any:
    try:
        return json.loads(text)
    except ValueError as exc:
        raise SwitchyardError(f"switchyard {' '.join(args[:1])} printed no JSON: {text.strip()[:200]}") from exc


def error_text(r: Result) -> str:
    """The error switchyard printed (its last stderr line, else stdout's)."""
    text = (r.stderr.strip() or r.stdout.strip()).splitlines()
    return text[-1].removeprefix("switchyard: ").strip() if text else ""
