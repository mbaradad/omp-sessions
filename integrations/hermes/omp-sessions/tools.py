"""The omp_* tools (toolset omp_sessions): thin wrappers over the omp-vs CLI."""

from __future__ import annotations

import json
import os
from typing import Any, Callable, Optional

from .lane import one_line
from .notify import Notifier, current_session_key
from .ompvs import WAIT_EXIT, OmpVs, OmpVsError
from .settings import MODES, Settings

TOOLSET = "omp_sessions"
WAIT_MAX_S = 600
WAIT_DEFAULT_S = 300


def _ok(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _err(message: str) -> str:
    return json.dumps({"error": message}, ensure_ascii=False)


def _str(args: dict, key: str) -> Optional[str]:
    v = args.get(key)
    return v.strip() if isinstance(v, str) and v.strip() else None


def _list(args: dict, key: str) -> list[str]:
    v = args.get(key)
    if isinstance(v, str):
        v = [v]
    return [str(x).strip() for x in v if str(x).strip()] if isinstance(v, list) else []


SESSION_ID = {"type": "string", "description": "omp session id, id prefix (8 characters are enough) or a unique title fragment."}

SCHEMAS: dict[str, dict] = {
    "omp_sessions_list": {
        "name": "omp_sessions_list",
        "description": "List omp coding sessions (running and queued; all=true adds finished ones): id, title, folder, status, queue, group, tags.",
        "parameters": {"type": "object", "properties": {"all": {"type": "boolean", "description": "Include stopped and archived sessions."}}},
    },
    "omp_projects_list": {
        "name": "omp_projects_list",
        "description": "Where omp sessions can run: folders omp sessions used recently, the kanban boards with their configured folders and groups, and Hermes projects with their folders. Use it to pick cwd/project/board for omp_session_start.",
        "parameters": {"type": "object", "properties": {}},
    },
    "omp_session_start": {
        "name": "omp_session_start",
        "description": (
            "Start an omp coding session (an autonomous coding agent running in the background; the user can watch and steer it in VS Code or the omp phone app). "
            "Give `prompt` to start now, or `task` to queue it (it starts when omp's concurrency limit allows; with `at` it is scheduled). "
            "Where it runs: `cwd`, or `project` (a Hermes project or the name of a known folder), or `board` (that kanban board's folder and group). "
            "You are told when it finishes or needs input; omp_session_wait blocks until then."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "What omp should do, starting now."},
                "task": {"type": "string", "description": "A queued task title (instead of prompt); details go in notes."},
                "notes": {"type": "string", "description": "Details of the queued task (with task)."},
                "subtasks": {"type": "array", "items": {"type": "string"}, "description": "Checklist items of the queued task."},
                "at": {"type": "string", "description": "Schedule the queued task: +30m, +2h, 14:30 (next occurrence) or an ISO time."},
                "cwd": {"type": "string", "description": "Absolute folder to run in."},
                "project": {"type": "string", "description": "Hermes project id/slug/name, or the name of a folder from omp_projects_list."},
                "board": {"type": "string", "description": "Kanban board slug: run in its configured folder and omp group."},
                "title": {"type": "string", "description": "Session title (default: from the prompt or task)."},
                "mode": {"type": "string", "enum": list(MODES), "description": "Permission mode: ask (approve every edit/command), edits (edits auto, commands ask), plan (read-only), auto."},
                "group": {"type": "string", "description": "omp group to file it under (shown grouped in VS Code)."},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "Session tags."},
            },
        },
    },
    "omp_session_status": {
        "name": "omp_session_status",
        "description": "An omp session's state (queued, starting, working, needs_input, idle, stopped), its pending question with options, its last reply, queue, cost and changed files.",
        "parameters": {"type": "object", "properties": {"id": SESSION_ID}, "required": ["id"]},
    },
    "omp_session_wait": {
        "name": "omp_session_wait",
        "description": f"Block until an omp session settles: idle (done for now), needs_input, or stopped; or until the timeout (default {WAIT_DEFAULT_S}s, at most {WAIT_MAX_S}s). Returns the outcome and the session report.",
        "parameters": {
            "type": "object",
            "properties": {"id": SESSION_ID, "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": WAIT_MAX_S}},
            "required": ["id"],
        },
    },
    "omp_session_send": {
        "name": "omp_session_send",
        "description": "Send a prompt to an omp session (resumes it if stopped). While it works the text steers the current turn; follow_up=true queues it for after the turn instead.",
        "parameters": {
            "type": "object",
            "properties": {"id": SESSION_ID, "text": {"type": "string"}, "follow_up": {"type": "boolean"}},
            "required": ["id", "text"],
        },
    },
    "omp_session_answer": {
        "name": "omp_session_answer",
        "description": "Answer the question an omp session waits on (state needs_input): an option number or text, yes/no, or free text.",
        "parameters": {"type": "object", "properties": {"id": SESSION_ID, "answer": {"type": "string"}}, "required": ["id", "answer"]},
    },
    "omp_session_mode": {
        "name": "omp_session_mode",
        "description": "Switch an omp session's permission mode live (also answers a waiting approval accordingly).",
        "parameters": {"type": "object", "properties": {"id": SESSION_ID, "mode": {"type": "string", "enum": list(MODES)}}, "required": ["id", "mode"]},
    },
    "omp_session_stop": {
        "name": "omp_session_stop",
        "description": "Stop an omp session (its history stays; omp_session_send resumes it).",
        "parameters": {"type": "object", "properties": {"id": SESSION_ID}, "required": ["id"]},
    },
}


def slim_session(info: dict) -> dict:
    meta = info.get("meta") if isinstance(info.get("meta"), dict) else {}
    out = {
        "id": meta.get("id"),
        "title": meta.get("title"),
        "cwd": meta.get("cwd"),
        "status": meta.get("status"),
        "column": info.get("column"),
        "queue": info.get("queue"),
    }
    for key in ("group", "tags", "waiting", "archived"):
        if info.get(key):
            out[key] = info[key]
    if meta.get("lastText"):
        out["lastText"] = meta["lastText"]
    return out


def hermes_projects() -> list[dict]:
    try:
        from hermes_cli import projects_db as pdb

        with pdb.connect_closing() as conn:
            projects = pdb.list_projects(conn)
    except Exception:
        return []
    out = []
    for p in projects:
        path = p.primary_path or (p.folders[0].path if p.folders else None)
        out.append({"id": p.id, "slug": p.slug, "name": p.name, "path": path, "board": p.board_slug, "folders": [f.path for f in p.folders]})
    return out


def kanban_boards(settings: Settings) -> list[dict]:
    try:
        from hermes_cli import kanban_db as kb

        boards = kb.list_boards(include_archived=False)
    except Exception:
        return []
    out = []
    for b in boards:
        slug = b.get("slug") or "default"
        e = settings.lane.boards.get(slug, {})
        lane = settings.lane.enabled and (not settings.lane.boards or slug in settings.lane.boards)
        out.append({"slug": slug, "name": b.get("name"), "folder": e.get("folder"), "group": e.get("group") or b.get("name") or slug, "lane": lane})
    return out


def resolve_place(args: dict, settings: Settings, omp: OmpVs) -> tuple[str, Optional[str]]:
    """(cwd, default group) from cwd / board / project."""
    cwd, board, project = _str(args, "cwd"), _str(args, "board"), _str(args, "project")
    if cwd:
        cwd = os.path.abspath(os.path.expanduser(cwd))
        if not os.path.isdir(cwd):
            raise OmpVsError(f"not a folder: {cwd}")
        return cwd, None
    if board:
        b = next((x for x in kanban_boards(settings) if x["slug"] == board or (x.get("name") or "").lower() == board.lower()), None)
        folder = (b or {}).get("folder") or settings.lane.boards.get(board, {}).get("folder")
        if not folder:
            raise OmpVsError(f"board {board} has no folder: set one with `hermes omp board {board} --folder <path>`, or pass cwd")
        return os.path.expanduser(folder), (b or {}).get("group") or board
    if project:
        return resolve_project(project, settings, omp), None
    raise OmpVsError("say where to run: cwd, project or board (omp_projects_list shows the options)")


def resolve_project(name: str, settings: Settings, omp: OmpVs) -> str:
    low = name.lower()
    if name in settings.projects:
        return os.path.expanduser(settings.projects[name])
    for p in hermes_projects():
        if p["path"] and low in (str(p["id"]).lower(), str(p["slug"]).lower(), str(p["name"]).lower()):
            return settings.projects.get(p["slug"]) or p["path"]
    known = omp.projects()
    exact = [p for p in known if str(p.get("path")) == os.path.expanduser(name)]
    if exact:
        return str(exact[0]["path"])
    hits = [p for p in known if low in (str(p.get("name", "")).lower(), os.path.basename(str(p.get("path", ""))).lower())]
    if len(hits) == 1:
        return str(hits[0]["path"])
    if len(hits) > 1:
        raise OmpVsError(f"project {name} matches several folders: {', '.join(str(h['path']) for h in hits[:6])}; pass cwd")
    raise OmpVsError(f"no project or known folder called {name} (omp_projects_list shows the options); pass cwd")


class Tools:
    def __init__(self, settings: Callable[[], Settings], omp: Callable[[], OmpVs], notifier: Notifier) -> None:
        self.settings = settings
        self.omp = omp
        self.notifier = notifier

    def handlers(self) -> dict[str, Callable[..., str]]:
        return {
            "omp_sessions_list": self.sessions_list,
            "omp_projects_list": self.projects_list,
            "omp_session_start": self.start,
            "omp_session_status": self.status,
            "omp_session_wait": self.wait,
            "omp_session_send": self.send,
            "omp_session_answer": self.answer,
            "omp_session_mode": self.mode,
            "omp_session_stop": self.stop,
        }

    def _run(self, fn: Callable[[], Any]) -> str:
        try:
            return _ok(fn())
        except OmpVsError as exc:
            return _err(str(exc))

    def _id(self, args: dict) -> str:
        sid = _str(args, "id")
        if not sid:
            raise OmpVsError("id is required")
        return sid

    def sessions_list(self, args: dict, **_: Any) -> str:
        return self._run(lambda: [slim_session(s) for s in self.omp().sessions(all=args.get("all") is True)])

    def projects_list(self, args: dict, **_: Any) -> str:
        def go() -> dict:
            settings = self.settings()
            return {
                "folders": self.omp().projects(),
                "boards": kanban_boards(settings),
                "hermes_projects": hermes_projects(),
                "configured_projects": settings.projects,
            }

        return self._run(go)

    def start(self, args: dict, **_: Any) -> str:
        def go() -> dict:
            settings = self.settings()
            omp = self.omp()
            prompt, task = _str(args, "prompt"), _str(args, "task")
            if bool(prompt) == bool(task):
                raise OmpVsError("give either prompt (start now) or task (queue it)")
            if _str(args, "at") and not task:
                raise OmpVsError("at schedules a queued task: use task instead of prompt")
            mode = _str(args, "mode")
            if mode and mode not in MODES:
                raise OmpVsError(f"mode must be one of {', '.join(MODES)}")
            cwd, group = resolve_place(args, settings, omp)
            res = omp.new(
                cwd,
                prompt=prompt,
                task=task,
                subtasks=_list(args, "subtasks"),
                notes=_str(args, "notes"),
                at=_str(args, "at"),
                # omp-vs names queued sessions after the task; prompt sessions after the prompt here.
                title=_str(args, "title") or (one_line(prompt, 60) if prompt else None),
                mode=mode,
                tags=_list(args, "tags"),
                group=_str(args, "group") or group,
            )
            key = current_session_key()
            if key and settings.notify:
                self.notifier.watch(str(res["id"]), key, str(res.get("title") or ""))
                res["notify"] = "you will get a message here when it finishes or needs input"
            return res

        return self._run(go)

    def status(self, args: dict, **_: Any) -> str:
        def go() -> dict:
            report = self.omp().show(self._id(args))
            if report is None:
                raise OmpVsError(f"no session matches {args.get('id')}")
            self.notifier.seen(report)
            return report

        return self._run(go)

    def wait(self, args: dict, **_: Any) -> str:
        def go() -> dict:
            sid = self._id(args)
            try:
                timeout = int(args.get("timeout_seconds") or WAIT_DEFAULT_S)
            except (TypeError, ValueError):
                timeout = WAIT_DEFAULT_S
            timeout = max(1, min(WAIT_MAX_S, timeout))
            r = self.omp().run(["wait", sid, "--timeout", f"{timeout}s", "--json"], timeout=timeout + 60)
            outcome = WAIT_EXIT.get(r.code)
            if outcome is None:
                raise OmpVsError((r.stderr or r.stdout).strip().splitlines()[-1] if (r.stderr or r.stdout).strip() else f"omp-vs wait exited with {r.code}")
            try:
                report = json.loads(r.stdout) if r.stdout.strip() else None
            except ValueError:
                report = None
            if isinstance(report, dict):
                self.notifier.seen(report)
            return {"outcome": outcome, "session": report}

        return self._run(go)

    def _rearm(self, sid: str) -> None:
        key = current_session_key()
        if not key or not self.settings().notify:
            return
        report = self.omp().show(sid)
        if report:
            self.notifier.watch(str(report.get("id")), key, str(report.get("title") or ""))

    def send(self, args: dict, **_: Any) -> str:
        def go() -> dict:
            sid = self._id(args)
            text = _str(args, "text")
            if not text:
                raise OmpVsError("text is required")
            self.omp().ok(["send", sid, "-", *(["--follow-up"] if args.get("follow_up") is True else [])], stdin=text, timeout=90)
            self._rearm(sid)
            return {"sent": True}

        return self._run(go)

    def answer(self, args: dict, **_: Any) -> str:
        def go() -> dict:
            sid = self._id(args)
            answer = _str(args, "answer")
            if not answer:
                raise OmpVsError("answer is required")
            out = self.omp().ok(["answer", sid, answer])
            self._rearm(sid)
            return {"answered": True, "output": out.strip()}

        return self._run(go)

    def mode(self, args: dict, **_: Any) -> str:
        def go() -> dict:
            mode = _str(args, "mode")
            if mode not in MODES:
                raise OmpVsError(f"mode must be one of {', '.join(MODES)}")
            out = self.omp().ok(["mode", self._id(args), mode])
            return {"mode": mode, "output": out.strip()}

        return self._run(go)

    def stop(self, args: dict, **_: Any) -> str:
        return self._run(lambda: {"output": self.omp().ok(["stop", self._id(args)], timeout=60).strip()})
