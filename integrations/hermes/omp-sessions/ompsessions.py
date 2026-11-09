"""Runs the omp-sessions CLI (the omp Sessions command line) and parses its JSON output.

Free text (prompts, answers, comments, titles, tags) only ever reaches omp-sessions as one argv entry
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

# Exit codes of `omp-sessions wait` (4: stopped or interrupted; the report's state says which).
WAIT_EXIT = {0: "idle", 3: "needs_input", 4: "stopped", 5: "scheduled", 124: "timeout"}
# `omp-sessions` exits 2 on a usage error, e.g. an answer that doesn't fit the question.
USAGE_EXIT = 2
PRIORITIES = ("urgent", "high", "normal", "low")
# Sync state of a graph edge (GRAPH-PROPAGATION.md): how far a parent's changes reached its child.
SYNC_STATES = ("in-sync", "pending", "merged", "conflict", "upstream-changed")
# Question kinds answered with text; select/confirm dialogs grant something (tool approvals, plan
# approval) and are left to the user.
TEXT_QUESTION_KINDS = ("ask", "input", "editor")


def is_approval(question: dict) -> bool:
    """True for a dialog that approves or denies something (omp's `select`/`confirm` dialogs: tool
    permissions, plan approval) rather than a plain question answered with text or a choice."""
    return str(question.get("kind") or "") not in TEXT_QUESTION_KINDS


def short(session_id: str) -> str:
    """A session id for messages: AO ids (`<project>-<n>`, already short and what every command takes)
    in full; a legacy omp Sessions id (no `-`, 14 characters) by its first 8, the prefix it was known by."""
    return session_id[:8] if "-" not in session_id and len(session_id) > 12 else session_id


def free_text_ok(value: str) -> str:
    """A session reference or schedule for a positional argument: never something omp-sessions reads as a flag."""
    if value.startswith("-"):
        raise OmpSessionsError(f"invalid value {value[:40]!r}")
    return value


def agent_state(info: dict) -> str:
    """The session's state from an `omp-sessions ls --json` entry (agentState in
    src/shared/session-report.ts): queued, scheduled, starting, working, needs_input, idle, interrupted
    or stopped."""
    state = info.get("state")
    return state if isinstance(state, str) and state else "unknown"


class OmpSessionsError(RuntimeError):
    """omp-sessions is missing, failed, or printed something that isn't the expected JSON."""


@dataclass
class Result:
    code: int
    stdout: str
    stderr: str


def runtime_cli() -> Path:
    """cli.js in the omp-sessions runtime folder (<OMP_VSCODE_HOME or ~/.omp/vscode>/runtime)."""
    home = os.environ.get("OMP_VSCODE_HOME") or str(Path.home() / ".omp" / "vscode")
    return Path(home) / "runtime" / "cli.js"


# The Windows launcher the extension writes (src/shared/cli-launcher.ts launcherText):
#   @echo off / rem … / [set ELECTRON_RUN_AS_NODE=1] / "<node>" "<cli.js>" %*
_SHIM_RUN = re.compile(r'^"([^"]+)" "([^"]+\.js)" %\*\s*$', re.MULTILINE)
# The wrapper `npm install -g omp-sessions` writes next to the package (npm's cmd-shim):
#   … "%_prog%"  "%dp0%\node_modules\omp-sessions\<bin>.js" %*  (older npm: "%~dp0\node_modules\…")
# with node from %dp0%\node.exe, else PATH.
_NPM_SHIM_RUN = re.compile(r'"%(?:dp0%|~dp0)\\(node_modules\\omp-sessions\\[^"%]+\.js)"\s+%\*', re.IGNORECASE)


def npm_shim_command(path: Path, text: str) -> Optional[list[str]]:
    """The argv npm's `omp-sessions.cmd` wrapper runs (node and the package's cli.js), or None."""
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
    """(argv, extra env) a `.cmd` launcher of omp-sessions runs, or None when it isn't one."""
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
    """(argv, extra env) that runs omp-sessions: the configured path, then PATH, then where `omp: Install
    omp-sessions Command` puts it (~/.local/bin/omp-sessions; %LOCALAPPDATA%\\omp-sessions\\omp-sessions.cmd
    on Windows), then the runtime folder's cli.js.

    A .js path (out/cli.js, the runtime's cli.js) runs with node from PATH; a .cmd/.bat launcher is
    read for the node and cli.js it runs and never executed itself."""
    candidates = [configured] if configured else []
    on_path = shutil.which("omp-sessions")
    if on_path:
        candidates.append(on_path)
    candidates.append(str(Path.home() / ".local" / "bin" / "omp-sessions"))
    if os.environ.get("LOCALAPPDATA"):
        candidates.append(str(Path(os.environ["LOCALAPPDATA"]) / "omp-sessions" / "omp-sessions.cmd"))
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


def find_omp_sessions(configured: Optional[str] = None) -> Optional[list[str]]:
    """The argv that runs omp-sessions (see resolve_command), or None."""
    found = resolve_command(configured)
    return found[0] if found else None




class OmpSessions:
    def __init__(self, configured: Optional[str] = None) -> None:
        self.configured = configured

    def resolved(self) -> tuple[list[str], dict[str, str]]:
        found = resolve_command(self.configured)
        if not found:
            raise OmpSessionsError(
                "omp-sessions not found: install it (omp Sessions extension: omp: Install omp-sessions Command) "
                "or set the plugin's omp_sessions setting to omp-sessions or its cli.js"
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
            raise OmpSessionsError(f"omp-sessions {' '.join(args[:2])} timed out after {int(timeout)}s") from exc
        except OSError as exc:
            raise OmpSessionsError(f"could not run omp-sessions: {exc}") from exc
        return Result(p.returncode, p.stdout, p.stderr)

    def ok(self, args: Sequence[str], *, stdin: Optional[str] = None, timeout: float = 60) -> str:
        """Runs a command that must succeed; returns its stdout."""
        r = self.run(args, stdin=stdin, timeout=timeout)
        if r.code != 0:
            raise OmpSessionsError(error_text(r) or f"omp-sessions {args[0]} exited with {r.code}")
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
            raise OmpSessionsError(msg or f"omp-sessions show exited with {r.code}")
        report = parse_json(r.stdout, ["show"])
        return report if isinstance(report, dict) else None

    def answer(self, session: str, text: str, question: Optional[str] = None) -> Result:
        """`omp-sessions answer <session> [--question <id>] -- <text>`: exit 0 answered, USAGE_EXIT the
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

    def plan_sync(self, ref: str, *, rerun: bool = False) -> dict:
        """`plan sync <task|session> --json`: brings the parents' changes into its worktree now;
        `rerun` also runs its task again with them (for a done task marked upstream-changed)."""
        out = self.json(["plan", "sync", "--json", *(["--rerun"] if rerun else []), "--", free_text_ok(ref)], timeout=120)
        return out if isinstance(out, dict) else {}

    def priority(self, session: str, priority: str) -> str:
        if priority not in PRIORITIES:
            raise OmpSessionsError(f"priority must be one of {', '.join(PRIORITIES)}")
        return self.ok(["prio", free_text_ok(session), priority]).strip()

    def scheduler(self) -> dict:
        out = self.json(["sched", "--json"])
        return out if isinstance(out, dict) else {}

    def status(self) -> dict:
        """`omp-sessions status --json`: the server, omp, sessions by state, tasks, scheduler and remote
        access, with `ok` and `problems` (it exits 1 when something is wrong, still printing the JSON)."""
        r = self.run(["status", "--json"], timeout=30)
        try:
            out = json.loads(r.stdout)
        except ValueError as exc:
            raise OmpSessionsError(error_text(r) or f"omp-sessions status exited with {r.code}") from exc
        if not isinstance(out, dict):
            raise OmpSessionsError(f"omp-sessions status printed {r.stdout.strip()[:100]!r}")
        return out

    def projects(self) -> list[dict]:
        out = self.json(["projects", "--json"])
        return [p for p in out if isinstance(p, dict)] if isinstance(out, list) else []

    def models(self, search: Optional[str] = None) -> dict:
        """`omp-sessions models --json`: {"models": [{selector, provider, id, name, default, …}],
        "default": the omp Sessions default selector or None, "ompDefault": omp's own default or None}."""
        out = self.json(["models", "--json", *(["--", search] if search else [])], timeout=60)
        if not isinstance(out, dict) or not isinstance(out.get("models"), list):
            raise OmpSessionsError(f"omp-sessions models printed {str(out)[:100]!r}")
        return out

    def model(self, session: str, selector: Optional[str] = None) -> dict:
        """A session's model ({id, model, running}), or switches it ({id, model, applied: live|next-resume})."""
        out = self.json(["model", free_text_ok(session), "--json", *(["--", selector] if selector else [])])
        return out if isinstance(out, dict) else {}

    def default_model(self) -> Optional[str]:
        """The omp Sessions default model (selector) new sessions get when they name none."""
        out = self.json(["config", "get", "model", "--json"])
        return out if isinstance(out, str) and out else None

    def set_default_model(self, selector: Optional[str]) -> None:
        self.ok(["config", "set", "model", "--", selector or "none"])

    def open_folder(self, folder: str) -> dict:
        """`omp-sessions vscode --folder=<dir> --json`: {folder, url, authority, windowAt}, a link that
        opens exactly that folder in VS Code (in the last-used window's remote, if any)."""
        out = self.json(["vscode", f"--folder={folder}", "--json"])
        if not isinstance(out, dict) or not isinstance(out.get("url"), str):
            raise OmpSessionsError("omp-sessions vscode printed no link")
        return out

    def version(self) -> dict:
        """{"cli": version, "server": version or None, "pid": server pid or None}."""
        out = self.json(["version", "--json"], timeout=20)
        if not isinstance(out, dict) or not isinstance(out.get("cli"), str):
            raise OmpSessionsError(f"omp-sessions version printed {str(out)[:100]!r}")
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
        after: Sequence[str] = (),
    ) -> dict:
        """Starts a session (prompt) or queues one (task); returns {id, started, title, cwd, startAt?, after?}.
        `after` (task only): sessions whose work must finish before the task starts."""
        if bool(prompt) == bool(task):
            raise OmpSessionsError("give either a prompt or a task")
        if priority and priority not in PRIORITIES:
            raise OmpSessionsError(f"priority must be one of {', '.join(PRIORITIES)}")
        if prompt and after:
            raise OmpSessionsError("after holds back a queued task: give a task, not a prompt")
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
        for flag, value in (("title", title), ("mode", mode), ("group", group), ("priority", priority), ("model", model)):
            if value:
                args.append(f"--{flag}={value}")
        args += [f"--tag={t}" for t in tags]
        args += ["--", cwd]
        out = self.json(args, stdin=stdin, timeout=90)
        if not isinstance(out, dict) or not isinstance(out.get("id"), str):
            raise OmpSessionsError(f"omp-sessions new printed no session id: {str(out)[:200]}")
        return out


def parse_json(text: str, args: Sequence[str]) -> Any:
    try:
        return json.loads(text)
    except ValueError as exc:
        raise OmpSessionsError(f"omp-sessions {' '.join(args[:1])} printed no JSON: {text.strip()[:200]}") from exc


def error_text(r: Result) -> str:
    """The error omp-sessions printed (its last stderr line, else stdout's)."""
    text = (r.stderr.strip() or r.stdout.strip()).splitlines()
    return text[-1].removeprefix("omp-sessions: ").strip() if text else ""
