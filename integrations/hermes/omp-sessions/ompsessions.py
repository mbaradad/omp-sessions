"""Runs the omp-sessions CLI (the omp Sessions command line) and parses its JSON output."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Sequence

# Exit codes of `omp-sessions wait`.
WAIT_EXIT = {0: "idle", 3: "needs_input", 4: "stopped", 124: "timeout"}


def agent_state(info: dict) -> str:
    """The session's state as `omp-sessions show --json` reports it, from an `omp-sessions ls --json` entry
    (same rules as agentState in src/shared/session-report.ts): queued, starting, working,
    needs_input, idle or stopped."""
    meta = info.get("meta") if isinstance(info.get("meta"), dict) else {}
    q = info.get("queue") if isinstance(info.get("queue"), dict) else {}
    status = meta.get("status")
    pending, running = int(q.get("pending") or 0), int(q.get("running") or 0)
    auto_run, scheduled = q.get("autoRun") is True, q.get("startAt") is not None
    if status == "waiting":
        return "needs_input"
    if status in ("starting", "working"):
        return str(status)
    if info.get("waiting"):
        return "queued"
    if status == "stopped":
        return "queued" if pending > 0 and (auto_run or scheduled) else "stopped"
    if running > 0 or (auto_run and pending > 0):
        return "working"
    return "queued" if pending > 0 and scheduled else "idle"


class OmpSessionsError(RuntimeError):
    """omp-sessions is missing, failed, or printed something that isn't the expected JSON."""


@dataclass
class Result:
    code: int
    stdout: str
    stderr: str


def find_omp_sessions(configured: Optional[str] = None) -> Optional[list[str]]:
    """The command that runs omp-sessions: the configured path, then PATH, then where `omp: Install omp-sessions
    Command` puts it (~/.local/bin/omp-sessions; %LOCALAPPDATA%\\omp-sessions\\omp-sessions.cmd on Windows).

    A path ending in .js (the bundled out/cli.js) runs with node.
    """
    candidates = [configured] if configured else []
    on_path = shutil.which("omp-sessions")
    if on_path:
        candidates.append(on_path)
    candidates.append(str(Path.home() / ".local" / "bin" / "omp-sessions"))
    if os.environ.get("LOCALAPPDATA"):
        candidates.append(str(Path(os.environ["LOCALAPPDATA"]) / "omp-sessions" / "omp-sessions.cmd"))
    for c in candidates:
        if not c:
            continue
        p = Path(os.path.expanduser(c))
        if not p.is_file():
            continue
        if p.suffix == ".js":
            node = shutil.which("node")
            return [node, str(p)] if node else None
        if os.access(p, os.X_OK):
            return [str(p)]
    return None


class OmpSessions:
    def __init__(self, configured: Optional[str] = None) -> None:
        self.configured = configured

    def command(self) -> list[str]:
        cmd = find_omp_sessions(self.configured)
        if not cmd:
            raise OmpSessionsError("omp-sessions not found: install it from VS Code (omp: Install omp-sessions Command) or set the plugin's omp_sessions setting")
        return cmd

    def available(self) -> bool:
        return find_omp_sessions(self.configured) is not None

    def run(self, args: Sequence[str], *, stdin: Optional[str] = None, timeout: float = 60) -> Result:
        env = {**os.environ, "NO_COLOR": "1"}
        try:
            p = subprocess.run(
                [*self.command(), *args],
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
            raise OmpSessionsError(_message(r) or f"omp-sessions {args[0]} exited with {r.code}")
        return r.stdout

    def json(self, args: Sequence[str], *, stdin: Optional[str] = None, timeout: float = 60) -> Any:
        return parse_json(self.ok(args, stdin=stdin, timeout=timeout), args)

    # ---- the commands the plugin uses ----

    def sessions(self, all: bool = True) -> list[dict]:
        out = self.json(["ls", "--json", *(["--all"] if all else [])])
        return [s for s in out if isinstance(s, dict)] if isinstance(out, list) else []

    def show(self, session: str) -> Optional[dict]:
        """The session's report, or None when no such session exists (removed)."""
        r = self.run(["show", session, "--json"])
        if r.code != 0:
            msg = _message(r)
            if "no session matches" in msg.lower():
                return None
            raise OmpSessionsError(msg or f"omp-sessions show exited with {r.code}")
        report = parse_json(r.stdout, ["show"])
        return report if isinstance(report, dict) else None

    def scheduler(self) -> dict:
        out = self.json(["sched", "--json"])
        return out if isinstance(out, dict) else {}

    def projects(self) -> list[dict]:
        out = self.json(["projects", "--json"])
        return [p for p in out if isinstance(p, dict)] if isinstance(out, list) else []

    def version(self) -> dict:
        """{"cli": version, "server": version or None, "pid": server pid or None} from `omp-sessions version`."""
        out = self.ok(["version"], timeout=20).strip()
        m = re.match(r"omp-sessions (\S+)(?: · server (\S+) \(pid (\d+)\))?", out)
        if not m:
            raise OmpSessionsError(f"omp-sessions version printed {out[:100]!r}")
        return {"cli": m.group(1), "server": m.group(2), "pid": int(m.group(3)) if m.group(3) else None}

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
    ) -> dict:
        """Starts a session (prompt) or queues one (task); returns {id, started, title, cwd, startAt?}."""
        if bool(prompt) == bool(task):
            raise OmpSessionsError("give either a prompt or a task")
        args = ["new", cwd, "--detach", "--json"]
        stdin = None
        if prompt:
            args += ["-p", "-"]
            stdin = prompt
        else:
            args += ["--task", task or ""]
            for s in subtasks:
                args += ["--sub", s]
            if notes:
                args += ["--notes", "-"]
                stdin = notes
            if at:
                args += ["--at", at]
        if title:
            args += ["--title", title]
        if mode:
            args += ["--mode", mode]
        for t in tags:
            args += ["--tag", t]
        if group:
            args += ["--group", group]
        out = self.json(args, stdin=stdin, timeout=90)
        if not isinstance(out, dict) or not isinstance(out.get("id"), str):
            raise OmpSessionsError(f"omp-sessions new printed no session id: {str(out)[:200]}")
        return out


def parse_json(text: str, args: Sequence[str]) -> Any:
    try:
        return json.loads(text)
    except ValueError as exc:
        raise OmpSessionsError(f"omp-sessions {' '.join(args[:1])} printed no JSON: {text.strip()[:200]}") from exc


def _message(r: Result) -> str:
    text = (r.stderr.strip() or r.stdout.strip()).splitlines()
    return text[-1].removeprefix("omp-sessions: ").strip() if text else ""
