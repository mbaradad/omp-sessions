"""Switchyard page backend for the Hermes dashboard and Hermes Desktop: /api/plugins/switchyard/.

Hermes imports this file on its own (importlib, outside any package), so it loads the plugin folder
above it as a package and reuses the plugin's modules: switchyard calls (switchyard), settings, the kanban
lane's links and status (lane, store), and the place resolution of the switchyard_session_start tool.
Settings are the requesting profile's (config.yaml `plugins.entries.switchyard.settings`); the
lane's card links are machine-wide like the kanban boards.

Every handler is async and moves its blocking work (switchyard subprocesses, sqlite) to a thread.
Errors come back as JSON {"error": message} with a 4xx/5xx status. /ao/… is a streaming proxy to
AO's web UI (the Switchyard server's AO dashboard), not JSON.
"""

from __future__ import annotations

import asyncio
import importlib
import importlib.util
import json
import os
import subprocess
import sys
import threading
import time
import weakref
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import quote

import anyio
import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

INSTALL_HINT = (
    "switchyard is not installed. Install it with the Switchyard extension (command “Switchyard: Install switchyard Command”), "
    "or set plugins.entries.switchyard.settings.switchyard to switchyard or its cli.js."
)
EXCERPT_MAX = 320
VERSION_TTL_S = 30


def _plugin_version() -> Optional[str]:
    """plugin.yaml's version (the Desktop page compares it with the version it was built from)."""
    try:
        text = (Path(__file__).resolve().parent.parent / "plugin.yaml").read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        if line.startswith("version:"):
            return line.split(":", 1)[1].strip().strip("\"'") or None
    return None


PLUGIN_VERSION = _plugin_version()


def _plugin_package() -> str:
    """Imports the plugin folder (the parent of dashboard/) as a package; returns its module name."""
    name = "switchyard_dashboard_plugin"
    if name not in sys.modules:
        root = Path(__file__).resolve().parent.parent
        spec = importlib.util.spec_from_file_location(name, root / "__init__.py", submodule_search_locations=[str(root)])
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load the switchyard plugin from {root}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except BaseException:
            sys.modules.pop(name, None)
            raise
    return name


_PKG = _plugin_package()
commands = importlib.import_module(f"{_PKG}.commands")
lane_mod = importlib.import_module(f"{_PKG}.lane")
switchyard = importlib.import_module(f"{_PKG}.switchyard")
settings_mod = importlib.import_module(f"{_PKG}.settings")
store_mod = importlib.import_module(f"{_PKG}.store")
tools_mod = importlib.import_module(f"{_PKG}.tools")

SwitchyardError = switchyard.SwitchyardError


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


# ---------- settings of the requesting profile ----------


class ProfileConfig:
    """ctx.get_config of the plugin, for the profile the request runs for (writes go through
    settings.update_setting, like the plugin's own `hermes switchyard` commands)."""

    def get_config(self, key: str, default: Any = None) -> Any:
        from hermes_cli.config import load_config_readonly

        node: Any = load_config_readonly() or {}
        for part in ("plugins", "entries", settings_mod.PLUGIN_ID, "settings", key):
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node


def settings() -> Any:
    return settings_mod.read_settings(ProfileConfig())


def omp() -> Any:
    return switchyard.Switchyard(settings().switchyard)


def lane() -> Any:
    return lane_mod.Lane(store_mod.Store(store_mod.FileState(store_mod.lane_data_dir)), settings, omp)


def profile_name() -> str:
    from hermes_constants import get_hermes_home, profile_name_for_home

    return profile_name_for_home(get_hermes_home()) or "custom"


def require_omp(s: Any) -> Any:
    if not switchyard.find_switchyard(s.switchyard):
        raise ApiError(503, INSTALL_HINT)
    return switchyard.Switchyard(s.switchyard)


# ---------- caches (per process; keyed so a change is never served stale) ----------

_LOCK = threading.Lock()
_VERSION: dict[str, tuple[float, dict]] = {}
# session id -> (updatedAt, question): `switchyard show` only reruns when the session changed.
_QUESTIONS: dict[str, tuple[Any, Optional[dict]]] = {}


def omp_version(o: Any) -> dict:
    key = " ".join(o.command())
    with _LOCK:
        hit = _VERSION.get(key)
    if hit and time.time() - hit[0] < VERSION_TTL_S:
        return hit[1]
    v = o.version()
    with _LOCK:
        _VERSION[key] = (time.time(), v)
    return v


def questions_for(o: Any, infos: list[dict]) -> dict[str, Optional[dict]]:
    """The pending question of every session waiting for input."""
    waiting = [(str((i.get("meta") or {}).get("id")), (i.get("meta") or {}).get("updatedAt")) for i in infos if switchyard.agent_state(i) == "needs_input"]
    return waiting_questions(o, waiting)


def waiting_questions(o: Any, waiting: list[tuple[str, Any]]) -> dict[str, Optional[dict]]:
    """The pending question of each waiting session or orchestrator, given as (id, updatedAt): the dialog in full, which
    only `switchyard show` has. Rerun only when the session changed since the last time."""
    want: list[tuple[str, Any]] = []
    out: dict[str, Optional[dict]] = {}
    for sid, stamp in waiting:
        with _LOCK:
            hit = _QUESTIONS.get(sid)
        if hit and hit[0] == stamp:
            out[sid] = hit[1]
        else:
            want.append((sid, stamp))
    if want:

        def fetch(item: tuple[str, Any]) -> tuple[str, Any, Optional[dict]]:
            sid, stamp = item
            try:
                report = o.show(sid)
            except SwitchyardError:
                return sid, None, None  # not cached: tried again next time
            q = (report or {}).get("question")
            return sid, stamp, q if isinstance(q, dict) else None

        with ThreadPoolExecutor(max_workers=min(4, len(want))) as pool:
            for sid, stamp, q in pool.map(fetch, want):
                out[sid] = q
                if stamp is not None:
                    with _LOCK:
                        _QUESTIONS[sid] = (stamp, q)
    return out


# ---------- kanban ----------


def board_slugs() -> list[dict]:
    try:
        from hermes_cli import kanban_db as kb

        return [b for b in kb.list_boards(include_archived=False) if b.get("slug")]
    except Exception:
        return []


LINKS_CHUNK = 400  # card ids per link query (under SQLite's bound-parameter limit)


def card_links(conn: Any, kb: Any, ids: list[str]) -> dict[str, dict[str, list[str]]]:
    """{card id: {"parents": [card id], "children": [card id]}} for `ids` on one board: the kanban
    dependency links (a child waits for its parents), batched (Hermes's task_graph_contexts, else the
    task_links table). Empty lists on a Hermes without task links."""
    ids = list(dict.fromkeys(str(i) for i in ids if i))
    out: dict[str, dict[str, list[str]]] = {i: {"parents": [], "children": []} for i in ids}
    try:
        if hasattr(kb, "task_graph_contexts"):
            for start in range(0, len(ids), LINKS_CHUNK):
                for tid, ctx in kb.task_graph_contexts(conn, ids[start : start + LINKS_CHUNK]).items():
                    if tid in out:
                        out[tid] = {k: [str(c["id"]) for c in ctx.get(k) or []] for k in ("parents", "children")}
        elif ids:
            for row in conn.execute("SELECT parent_id, child_id FROM task_links ORDER BY parent_id, child_id").fetchall():
                parent, child = str(row[0]), str(row[1])
                if child in out:
                    out[child]["parents"].append(parent)
                if parent in out:
                    out[parent]["children"].append(child)
    except Exception:
        return {i: {"parents": [], "children": []} for i in ids}
    return out


def card_lookup(refs: set[tuple[str, str]]) -> dict[tuple[str, str], dict]:
    """{(board, card id): {title, status, assignee, project, parents, children}} for the cards that still exist."""
    from hermes_cli import kanban_db as kb
    from hermes_cli import kanban_db_connect as kbc

    known = {b["slug"] for b in board_slugs()}
    out: dict[tuple[str, str], dict] = {}
    by_board: dict[str, list[str]] = {}
    for board, card in refs:
        if board in known:
            by_board.setdefault(board, []).append(card)
    for board, cards in by_board.items():
        try:
            with kbc.connect_closing(board=board) as conn:
                rel = card_links(conn, kb, cards)
                for card in cards:
                    t = kb.get_task(conn, card)
                    if t is not None:
                        out[(board, card)] = {"title": t.title, "status": t.status, "assignee": t.assignee, "project": getattr(t, "project_id", None), **rel[card]}
        except Exception:
            continue
    return out


def card_plan(info: dict, card_of: dict[str, str]) -> dict:
    """What the planner says about a card's session (`switchyard ls --json`), for the graph: its state
    (blocked, scheduled, held, paused, waiting, running, interrupted: absent once the work is done), why it is
    held, and the cards whose sessions it waits for (`after`: set by the lane from the parent cards that ran in
    it; `blockedBy`: the unfinished ones; `upstream`: the worst state of the merge edges from parents)."""
    cards = lambda sessions: [card_of[str(x)] for x in sessions or [] if str(x) in card_of]  # noqa: E731
    out: dict = {"state": info.get("planState")}
    if info.get("waitReason"):
        out["reason"] = info["waitReason"]
    if isinstance(info.get("waitUntil"), (int, float)):
        out["until"] = info["waitUntil"]
    # The parents the planner knows: the next task's `after`, and every graph edge into the session (kept after the task finished).
    edges = [e.get("parentSession") for e in info.get("upstream") or [] if isinstance(e, dict)]
    out["after"] = sorted({*cards(info.get("after")), *cards(edges)})
    out["blockedBy"] = cards(info.get("blockedBy"))
    if info.get("upstreamState"):
        out["upstream"] = info["upstreamState"]
    return out


def card_ref(info: dict, by_session: dict[str, dict]) -> Optional[tuple[str, str]]:
    """(board, card) a session works on: the lane's link, else its `hermes:<board>` + `card:<id>` tags."""
    sid = str((info.get("meta") or {}).get("id"))
    link = by_session.get(sid)
    if link:
        return str(link.get("board")), str(link.get("card"))
    tags = info.get("tags") if isinstance(info.get("tags"), list) else []
    board = next((t[7:] for t in tags if isinstance(t, str) and t.startswith("hermes:")), None)
    card = next((t[5:] for t in tags if isinstance(t, str) and t.startswith("card:")), None)
    return (board, card) if board and card else None


# ---------- sessions ----------


def tilde(path: str) -> str:
    """`path` with the home directory written as ~ (for display)."""
    home = os.path.expanduser("~").rstrip("/\\")
    if home and (path == home or path.startswith(home + os.sep)):
        return "~" + path[len(home):]
    return path


def excerpt(text: Any) -> Optional[str]:
    if not isinstance(text, str) or not text.strip():
        return None
    flat = " ".join(text.split())
    return flat if len(flat) <= EXCERPT_MAX else f"{flat[: EXCERPT_MAX - 1]}…"


def queue_counts(q: dict) -> dict:
    """The queue's task counts for the page. `show`/`ls` count pending, running and done; the rest of
    `total` (not interrupted) is failed or skipped tasks, the ones Retry brings back."""
    out = {k: int(q.get(k) or 0) for k in ("pending", "running", "done", "total", "interrupted")}
    out["failed"] = int(q["failed"]) if q.get("failed") is not None else max(0, out["total"] - out["done"] - out["pending"] - out["running"] - out["interrupted"])
    return out


def session_view(info: dict, card: Optional[dict], ref: Optional[tuple[str, str]], question: Optional[dict], upstream: Optional[list] = None) -> dict:
    meta = info.get("meta") or {}
    q = info.get("queue") or {}
    cwd = str(meta.get("cwd") or "")
    view = {
        "id": meta.get("id"),
        "title": meta.get("title") or "(untitled)",
        "cwd": cwd,
        "cwdLabel": tilde(cwd),
        # AO's project (its id names the repository); the cwd is the session's own worktree.
        "project": meta.get("project") or os.path.basename(cwd.rstrip("/\\")) or cwd,
        "state": switchyard.agent_state(info),
        "status": meta.get("status"),
        "mode": meta.get("permissionMode") or info.get("mode"),
        "model": meta.get("model"),
        # The AO harness running it (`ls --json` top level); missing on older servers means omp.
        "harness": info.get("harness") or "omp",
        "cost": meta.get("cost") or 0,
        "changedFiles": meta.get("changedFiles") or 0,
        "createdAt": meta.get("createdAt"),
        "updatedAt": meta.get("updatedAt"),
        "turnId": meta.get("turnId"),
        "group": info.get("group"),
        "color": info.get("color"),
        "priority": info.get("priority"),
        "tags": [t for t in (info.get("tags") or []) if isinstance(t, str)],
        "archived": info.get("archived") is True,
        "completed": info.get("completed") is True,
        "completedAt": info.get("completedAt"),
        "queue": queue_counts(q),
        "autoRun": q.get("autoRun") is True,
        "startAt": q.get("startAt"),
        "waiting": info.get("waiting"),
        "excerpt": excerpt(meta.get("lastText")),
        "exitReason": meta.get("exitReason") if meta.get("status") == "stopped" else None,
        "authProblem": meta.get("authProblem"),
        "question": question,
        "upstream": upstream_view(info.get("upstream") or upstream),
        "card": None,
    }
    if ref:
        c = card or {}
        view["card"] = {"board": ref[0], "id": ref[1], "title": c.get("title"), "status": c.get("status"), "parents": c.get("parents") or [], "children": c.get("children") or []}
    return view


def upstream_view(edges: Any) -> list[dict]:
    """The session's parent edges (GRAPH-PROPAGATION.md), for the page: which parent, its sync state, the
    conflicting files."""
    out = []
    for e in switchyard.edges_of(edges):
        if e.get("state") in switchyard.SYNC_STATES:
            files = [f for f in e.get("files") or [] if isinstance(f, str)]
            out.append({"parent": e.get("parentSession") or e.get("parent"), "state": e["state"], "files": files[:50]})
    return out


def list_sessions() -> dict:
    s = settings()
    o = require_omp(s)
    infos = [i for i in o.sessions(all=True) if isinstance(i.get("meta"), dict)]
    by_session = {str(l.get("session")): l for l in lane().links().values() if l.get("session")}
    refs = {r: i for i in infos if (r := card_ref(i, by_session))}
    cards = card_lookup(set(refs)) if refs else {}
    questions = questions_for(o, infos)
    upstream = o.upstream_by_session()
    views = []
    for info in infos:
        ref = card_ref(info, by_session)
        sid = str(info["meta"].get("id"))
        views.append(session_view(info, cards.get(ref) if ref else None, ref, questions.get(sid), upstream.get(sid, [])))
    return {"sessions": views, "at": time.time()}


def session_detail(sid: str) -> dict:
    s = settings()
    o = require_omp(s)
    report = o.show(sid)
    if report is None:
        raise ApiError(404, f"no session matches {sid}")
    info = next((i for i in o.sessions(all=True) if (i.get("meta") or {}).get("id") == report.get("id")), None)
    if info is None:
        raise ApiError(404, f"session {switchyard.short(sid)} is gone")
    by_session = {str(l.get("session")): l for l in lane().links().values() if l.get("session")}
    ref = card_ref(info, by_session)
    card = card_lookup({ref}).get(ref) if ref else None
    question = report.get("question") if isinstance(report.get("question"), dict) else None
    view = session_view(info, card, ref, question, o.upstream_by_session().get(str(report.get("id")), []))
    view.update(reply=report.get("reply"), mode=report.get("mode") or view["mode"], model=report.get("model") or view["model"], changedFiles=report.get("changedFiles") or view["changedFiles"], prs=[p for p in report.get("prs") or [] if isinstance(p, dict)])
    return view


def _text(body: dict, key: str) -> Optional[str]:
    v = body.get(key)
    return v.strip() if isinstance(v, str) and v.strip() else None


def start_session(body: dict) -> dict:
    s = settings()
    o = require_omp(s)
    prompt = _text(body, "prompt")
    if not prompt:
        raise ApiError(400, "write what the agent should do")
    where = body.get("where") if isinstance(body.get("where"), dict) else {}
    kind, place = _text(where, "kind"), _text(where, "value")
    if kind not in ("folder", "project", "board") or not place:
        raise ApiError(400, "pick where it runs: a project, a folder or a board")
    cwd, default_group = tools_mod.resolve_place({"folder": {"cwd": place}, "project": {"project": place}, "board": {"board": place}}[kind], s, o)
    mode = _text(body, "mode")
    if mode and mode not in settings_mod.MODES:
        raise ApiError(400, f"mode must be one of {', '.join(settings_mod.MODES)}")
    tags = [t.strip() for t in body.get("tags") or [] if isinstance(t, str) and t.strip()]
    title = _text(body, "title")
    group = _text(body, "group") or default_group
    model = _text(body, "model")
    when = _text(body, "when") or "now"
    if when == "now":
        return o.new(cwd, prompt=prompt, title=title or lane_mod.one_line(prompt, 60), mode=mode, tags=tags, group=group, model=model)
    if when not in ("queue", "at"):
        raise ApiError(400, "when must be now, queue or at")
    at = _text(body, "at") if when == "at" else None
    if when == "at" and not at:
        raise ApiError(400, "say when it starts: +30m, 14:30 or a date and time")
    task = title or lane_mod.one_line(prompt, 80)
    notes = "\n\n".join(x for x in (prompt if prompt != task else None, _text(body, "notes")) if x) or None
    return o.new(cwd, task=task, notes=notes, at=at, title=title, mode=mode, tags=tags, group=group, model=model)


def session_action(sid: str, action: str, body: dict) -> dict:
    o = require_omp(settings())
    if action == "send":
        text = _text(body, "text")
        if not text:
            raise ApiError(400, "nothing to send")
        o.send(sid, text, steer=body.get("steer") is True)
        return {"ok": True}
    if action == "answer":
        answer = _text(body, "answer")
        question = _text(body, "question")
        if not answer:
            raise ApiError(400, "give an answer")
        if not question:
            raise ApiError(400, "name the question being answered")
        r = o.answer(sid, answer, question)
        if r.code != 0:
            raise ApiError(400, switchyard.error_text(r) or f"switchyard answer exited with {r.code}")
        return {"ok": True, "output": r.stdout.strip()}
    if action == "mode":
        mode = _text(body, "mode")
        if mode not in settings_mod.MODES:
            raise ApiError(400, f"mode must be one of {', '.join(settings_mod.MODES)}")
        return {"ok": True, "output": o.ok(["mode", switchyard.free_text_ok(sid), mode]).strip()}
    if action == "stop":
        return {"ok": True, "output": o.ok(["stop", switchyard.free_text_ok(sid)], timeout=60).strip()}
    if action == "model":
        model = _text(body, "model")
        if not model:
            raise ApiError(400, "pick a model")
        return {"ok": True, **o.model(sid, model)}
    if action in ("archive", "unarchive"):
        return {"ok": True, "output": o.archive(sid) if action == "archive" else o.unarchive(sid)}
    if action in ("complete", "uncomplete"):
        return {"ok": True, **(o.complete(sid) if action == "complete" else o.uncomplete(sid))}
    if action == "run":
        queue = o.queue_get(sid)
        if not any(isinstance(t, dict) and t.get("status") == "pending" for t in (queue or {}).get("tasks") or []):
            raise ApiError(409, "no pending task to run (retry requeues failed or finished tasks)")
        return {"ok": True, "queue": o.queue_run(sid)}
    if action == "retry":
        return {"ok": True, "queue": o.queue_retry(sid)}
    if action == "schedule":
        # `at: null` unschedules; a body without `at` is a mistake, not a cancel.
        if "at" not in body:
            raise ApiError(400, "at: when the queue starts (+30m, 14:30, an ISO time), or null to unschedule")
        at = body.get("at")
        if at is None:
            return {"ok": True, "queue": o.queue_at(sid, "off")}
        if isinstance(at, (int, float)) and not isinstance(at, bool):
            at = datetime.fromtimestamp(at / 1000, tz=timezone.utc).isoformat()
        if not isinstance(at, str) or not at.strip() or at.strip() in ("off", "none"):
            raise ApiError(400, "at: when the queue starts (+30m, 14:30, an ISO time), or null to unschedule")
        return {"ok": True, "queue": o.queue_at(sid, at.strip())}
    if action == "sync":
        # Bring the parents' changes in now; rerun: also run its task again with them (upstream-changed).
        return {"ok": True, **o.plan_sync(sid, rerun=body.get("rerun") is True)}
    raise ApiError(404, f"unknown action {action}")


def session_board(info: dict, by_session: dict[str, dict]) -> Optional[str]:
    """The kanban board a session belongs to: its card's (card_ref), else its `hermes:<board>` tag."""
    ref = card_ref(info, by_session)
    if ref:
        return ref[0]
    tags = info.get("tags") if isinstance(info.get("tags"), list) else []
    return next((t[7:] for t in tags if isinstance(t, str) and t.startswith("hermes:")), None)


def archive_done(body: dict) -> dict:
    """Archives every done session (switchyard.is_done: completed, or idle with nothing queued) of a
    board view in one request: `ids` (the sessions the page shows) and/or the view's filters `board`,
    `group`, `project` narrow it down; an empty body means every done session.
    {"archived": [id], "failed": [{id, error}]}."""
    o = require_omp(settings())
    ids = body.get("ids")
    if ids is not None and (not isinstance(ids, list) or not all(isinstance(i, str) for i in ids)):
        raise ApiError(400, "ids must be a list of session ids")
    wanted = set(ids) if ids is not None else None
    board, group, project = _text(body, "board"), _text(body, "group"), _text(body, "project")
    by_session = {str(l.get("session")): l for l in lane().links().values() if l.get("session")} if board else {}
    archived: list[str] = []
    failed: list[dict] = []
    for info in o.sessions(all=True):
        meta = info.get("meta") if isinstance(info.get("meta"), dict) else {}
        sid = str(meta.get("id") or "")
        if not sid or info.get("archived") is True or not switchyard.is_done(info):
            continue
        if wanted is not None and sid not in wanted:
            continue
        if group and info.get("group") != group:
            continue
        cwd = str(meta.get("cwd") or "")
        if project and (os.path.basename(cwd.rstrip("/\\")) or cwd) != project:
            continue
        if board and session_board(info, by_session) != board:
            continue
        try:
            o.archive(sid)
            archived.append(sid)
        except SwitchyardError as exc:
            failed.append({"id": sid, "error": str(exc)})
    return {"archived": archived, "failed": failed}


def plugin_page(file: str, base_url: str) -> str:
    """URL of `file`, a public page of this plugin's dashboard folder (served without sign-in), at the
    address the caller reached this dashboard at (`base_url`). The profile segment serves the
    requesting profile's copy (the page's own `?profile=`)."""
    profile = profile_name()
    scope = f"@{quote(profile, safe='')}/" if profile != "custom" else ""
    return f"{base_url.rstrip('/')}/dashboard-plugins/{scope}switchyard/{file}"


def with_page(out: dict, base_url: str) -> dict:
    """`out` ({url, …} from `switchyard vscode`) plus `page`: a page of this dashboard that opens the
    link, for hosts that only open web links (Hermes Desktop). It holds nothing but a redirect."""
    url = out.get("url")
    if not isinstance(url, str) or not url:
        raise ApiError(502, "switchyard vscode printed no link")
    page = f"{plugin_page('open-vscode.html', base_url)}#{quote(url, safe='')}"
    return {"url": url, "page": page, "folder": out.get("folder"), "review": out.get("review"), "pr": out.get("pr"), "authority": out.get("authority"), "windowAt": out.get("windowAt")}


def vscode_intent(body: dict) -> list[str]:
    """`switchyard vscode`'s flags for the body's `review: "pr"` and `pr: N` (a pull request number of the session)."""
    review, pr = body.get("review"), body.get("pr")
    if review is None:
        if pr is not None:
            raise ApiError(400, "pr goes with review")
        return []
    if review != "pr":
        raise ApiError(400, 'review must be "pr"')
    if pr is None:
        return ["--review"]
    if isinstance(pr, bool) or not isinstance(pr, int) or pr < 1:
        raise ApiError(400, "pr must be a pull request number")
    return ["--review", "--pr", str(pr)]


def open_in_vscode(sid: str, body: dict, base_url: str) -> dict:
    """Asks the VS Code window last used on the Switchyard machine to open the session's chat, and its
    pull request review when the body says `review: "pr"` (`switchyard vscode`)."""
    o = require_omp(settings())
    out = o.json(["vscode", switchyard.free_text_ok(sid), *vscode_intent(body), "--json"])
    return with_page(out if isinstance(out, dict) else {}, base_url)


def _inside(path: str, folder: str) -> bool:
    path, folder = os.path.realpath(path), os.path.realpath(folder)
    return path == folder or path.startswith(folder.rstrip(os.sep) + os.sep)


def project_folders(s: Any) -> list[str]:
    """Folders of projects: the plugin's `projects` setting and Hermes projects (primary path and folders)."""
    out = [os.path.expanduser(p) for p in s.projects.values()]
    for p in tools_mod.hermes_projects():
        out += [x for x in (p.get("path"), *(p.get("folders") or [])) if x]
    return out


def git_checkout(folder: str) -> Optional[str]:
    """The main checkout of the git repository holding `folder`: for an AO session's worktree, the
    repository it was made from (not the worktree); None outside git."""
    try:
        r = subprocess.run(["git", "-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    lines = r.stdout.split("\n")
    if r.returncode != 0 or len(lines) < 2 or not lines[1].strip():
        return None
    common, top = os.path.normpath(lines[0].strip()), os.path.normpath(lines[1].strip())
    return os.path.dirname(common) if os.path.basename(common) == ".git" else top


def session_project(info: dict, card: Optional[dict], ref: Optional[tuple[str, str]], s: Any) -> str:
    """The project folder of a session: its card's Hermes project folder, else its board's folder, else
    the deepest project folder holding it (each only when the session is inside it), else its git
    repository, else its cwd. An AO session runs in its own worktree; it counts as being where the
    repository it was made from is (the checkout the user has open)."""
    cwd = str((info.get("meta") or {}).get("cwd") or "")
    checkout = git_checkout(cwd) if cwd else None
    places = [p for p in (cwd, checkout) if p]
    candidates: list[str] = []
    if card and card.get("project"):
        folder = lane_mod.project_folder(str(card["project"]), s)
        if folder:
            candidates.append(os.path.expanduser(folder))
    if ref and s.lane.boards.get(ref[0], {}).get("folder"):
        candidates.append(os.path.expanduser(s.lane.boards[ref[0]]["folder"]))
    candidates += sorted((p for p in project_folders(s) if any(_inside(x, p) for x in places)), key=len, reverse=True)
    for folder in candidates:
        if os.path.isdir(folder) and any(_inside(x, folder) for x in places):
            return folder
    return checkout or cwd


def open_project(sid: str, base_url: str) -> dict:
    """Opens the session's project folder (session_project) in VS Code."""
    s = settings()
    o = require_omp(s)
    report = o.show(sid)
    if report is None:
        raise ApiError(404, f"no session matches {sid}")
    info = next((i for i in o.sessions(all=True) if (i.get("meta") or {}).get("id") == report.get("id")), None)
    if info is None:
        raise ApiError(404, f"session {switchyard.short(sid)} is gone")
    by_session = {str(l.get("session")): l for l in lane().links().values() if l.get("session")}
    ref = card_ref(info, by_session)
    card = card_lookup({ref}).get(ref) if ref else None
    return with_page(o.open_folder(session_project(info, card, ref, s)), base_url)


def known_folders(s: Any, o: Any) -> set[str]:
    """Folders the page shows, which are the only ones /folders/vscode opens: session folders, the
    lane's board folders and project folders."""
    paths = [str((i.get("meta") or {}).get("cwd") or "") for i in o.sessions(all=True)]
    paths += [str(p.get("path") or "") for p in o.projects()]
    paths += [os.path.expanduser(str(e["folder"])) for e in s.lane.boards.values() if e.get("folder")]
    paths += project_folders(s)
    return {os.path.realpath(p) for p in paths if p}


def open_folder(body: dict, base_url: str) -> dict:
    """Opens a folder the page shows (a session's, a board's or a project's) in VS Code."""
    s = settings()
    o = require_omp(s)
    path = _text(body, "path")
    if not path or not os.path.isabs(os.path.expanduser(path)):
        raise ApiError(400, "give the folder's absolute path")
    path = os.path.expanduser(path)
    if os.path.realpath(path) not in known_folders(s, o):
        raise ApiError(403, "only folders of sessions, boards and projects open from here")
    return with_page(o.open_folder(path), base_url)


def models_view(search: Optional[str]) -> dict:
    return require_omp(settings()).models(search or None)


def set_default_model(body: dict) -> dict:
    model = body.get("model")
    if model is not None and not (isinstance(model, str) and model.strip()):
        raise ApiError(400, "model must be a provider/id or null")
    o = require_omp(settings())
    o.set_default_model(model.strip() if isinstance(model, str) else None)
    return o.models()


# ---------- orchestrators: AO's coordinating agent of a project, through `switchyard orchestrator …` ----------
# The chat of an orchestrator is a session: its question is answered, and a follow-up sent, with the /sessions/<id>/…
# routes (answer, send, stop, vscode) given its id; nothing here re-implements what AO or the CLI do.

# Page names of the settings -> the plugin's (Switchyard.orchestrator_config); text first, then the on/off ones.
ORCHESTRATOR_TEXT = {"harness": "harness", "model": "model", "effort": "effort", "permissions": "permissions", "rules": "rules", "rulesFile": "rules_file", "workerHarness": "worker_harness", "workerModel": "worker_model"}
ORCHESTRATOR_TOGGLES = {"workersRequestReview": "review", "autoReview": "auto_review"}


def orchestrator_views(o: Any, infos: list[dict]) -> list[dict]:
    """Orchestrators for the page: the CLI's own fields, a ~ label of the folder, and the question in full
    (`orchestrator status` has its title and message; the dialog's options and sub-questions are in `show`)."""
    waiting = [(str(i["id"]), i.get("updatedAt")) for i in infos if isinstance(i.get("question"), dict)]
    full = waiting_questions(o, waiting) if waiting else {}
    out = []
    for info in infos:
        view = {**info, "projectPathLabel": tilde(str(info.get("projectPath") or ""))}
        q = info.get("question")
        if isinstance(q, dict):
            # Without the dialog, kind "unknown": the page says where it can be answered instead of guessing buttons.
            view["question"] = {"kind": "unknown", **{k: q[k] for k in ("title", "message") if q.get(k)}, **(full.get(str(info["id"])) or {}), "id": q.get("id"), "approval": q.get("approval") is True}
        out.append(view)
    return out


def list_orchestrators() -> dict:
    o = require_omp(settings())
    return {"orchestrators": orchestrator_views(o, o.orchestrators(stopped=True)), "at": time.time()}


def get_orchestrator(project: str) -> dict:
    """`orchestrator status <project>`: {project, orchestrator: view | None, note?}."""
    o = require_omp(settings())
    out = o.orchestrator(project)
    info = out.get("orchestrator")
    view = orchestrator_views(o, [info])[0] if isinstance(info, dict) else None
    return {**out, "orchestrator": view}


def submit_to_orchestrator(body: dict) -> dict:
    """Gives the project's orchestrator a task (starting it when needed). The project is named: without one the CLI
    would take the git project of this server's working folder."""
    o = require_omp(settings())
    task, project = _text(body, "task"), _text(body, "project")
    if not task:
        raise ApiError(400, "write what the orchestrator should do")
    if not project:
        raise ApiError(400, "pick the project")
    if "steer" in body and not isinstance(body["steer"], bool):
        raise ApiError(400, "steer must be true or false")
    return o.orchestrator_submit(task, project=project, steer=body.get("steer") is True, harness=_text(body, "harness"))


def orchestrator_action(project: str, action: str, body: dict) -> dict:
    if action not in ("start", "restart", "stop"):
        raise ApiError(404, f"unknown action {action}")
    harness = _text(body, "harness")
    if harness and action == "stop":
        raise ApiError(400, "harness goes with start or restart")
    out = require_omp(settings()).orchestrator_lifecycle(action, project, harness=harness)
    if action == "stop" and out.get("stopped") is False:
        raise ApiError(409, "this project has no running orchestrator")
    return out


def orchestrator_config(project: str, body: Optional[dict] = None) -> dict:
    """The project's orchestrator settings ({projectId, config}); `body` (the page's names) changes the ones it has first.
    A text or toggle set to "" / null clears it. A running orchestrator keeps what it started with: restart applies them."""
    patch: dict[str, Any] = {}
    for key, name in ORCHESTRATOR_TEXT.items():
        if key in (body or {}):
            v = body[key]
            if v is not None and not isinstance(v, str):
                raise ApiError(400, f"{key} must be text")
            patch[name] = (v or "").strip() or None
    for key, name in ORCHESTRATOR_TOGGLES.items():
        if key in (body or {}):
            v = body[key]
            if v is not None and not isinstance(v, bool):
                raise ApiError(400, f"{key} must be true, false or null")
            patch[name] = v
    if patch.get("permissions") not in (None, *switchyard.ORCHESTRATOR_PERMISSIONS):
        raise ApiError(400, f"permissions must be one of {', '.join(switchyard.ORCHESTRATOR_PERMISSIONS)}")
    return require_omp(settings()).orchestrator_config(project, patch)


def harnesses_view() -> dict:
    return require_omp(settings()).harnesses()


# ---------- overview, places, boards ----------


def overview() -> dict:
    s = settings()
    ln = lane()
    cmd = switchyard.find_switchyard(s.switchyard)
    profile = profile_name()
    disp = ln.dispatcher()
    out: dict[str, Any] = {
        "profile": profile,
        "pluginVersion": PLUGIN_VERSION,
        "switchyard": {"found": bool(cmd), "command": " ".join(cmd) if cmd else None, "hint": None if cmd else INSTALL_HINT},
        "scheduler": None,
        "notify": s.notify,
        "lane": {
            "enabled": s.lane.enabled,
            "assignee": s.lane.assignee,
            "mode": s.lane.mode,
            "boards": sorted(s.lane.boards) if s.lane.boards else "all",
            "linked": len(ln.links()),
            "dispatcher": {"at": disp.get("at"), "profile": disp.get("profile"), "laneOn": disp.get("lane_on")} if disp else None,
            "notes": commands.dispatcher_notes(disp, profile=profile, lane_on=s.lane.enabled),
        },
    }
    if cmd:
        o = switchyard.Switchyard(s.switchyard)
        try:
            out["switchyard"].update(omp_version(o))
        except SwitchyardError as exc:
            out["switchyard"]["error"] = str(exc)
        try:
            out["scheduler"] = o.scheduler()
        except SwitchyardError as exc:
            out["switchyard"]["error"] = str(exc)
    return out


def places() -> dict:
    s = settings()
    o = require_omp(s)
    return {
        "folders": [{**f, "label": tilde(str(f.get("path") or ""))} for f in o.projects()],
        "boards": tools_mod.kanban_boards(s),
        "hermesProjects": tools_mod.hermes_projects(),
        "configured": s.projects,
    }


def boards_view() -> dict:
    from hermes_cli import kanban_db as kb
    from hermes_cli import kanban_db_connect as kbc

    s = settings()
    ln = lane()
    links = ln.links()
    ticks = ln.ticks()
    infos: list[dict] = []
    if switchyard.find_switchyard(s.switchyard):
        try:
            infos = [i for i in switchyard.Switchyard(s.switchyard).sessions(all=True) if isinstance(i.get("meta"), dict)]
        except SwitchyardError:
            infos = []
    states = {str(i["meta"]["id"]): switchyard.agent_state(i) for i in infos}
    info_of = {str(i["meta"]["id"]): i for i in infos}
    # The session of each card: the lane's, else the latest one tagged hermes:<board> + card:<id>.
    by_session = {str(l.get("session")): l for l in links.values() if l.get("session")}
    session_of: dict[tuple[str, str], str] = {}
    for i in sorted(infos, key=lambda i: (str(i["meta"]["id"]) in by_session, i["meta"].get("updatedAt") or 0)):
        ref = card_ref(i, by_session)
        if ref:
            session_of[ref] = str(i["meta"]["id"])
    out = []
    for b in board_slugs():
        slug = str(b["slug"])
        # session -> card id, for the sessions of this board's cards: the planner names sessions, the graph cards.
        card_of = {sid: card for (board, card), sid in session_of.items() if board == slug}
        entry = s.lane.boards.get(slug, {})
        assignee = (entry.get("assignee") or s.lane.assignee).lower()
        listed = not s.lane.boards or slug in s.lane.boards
        trusted = settings_mod.board_lane(s, slug, b.get("name")) or lane_mod.board_lane_fallback(s, slug)
        linked, ready, cards = [], [], []
        try:
            with kbc.connect_closing(board=slug) as conn:
                lane_of = {str(l.get("card")): l for _, l in sorted(links.items()) if l.get("board") == slug}
                tasks = kb.list_tasks(conn)
                rel = card_links(conn, kb, [t.id for t in tasks] + list(lane_of))
                no_links: dict[str, list[str]] = {"parents": [], "children": []}
                for card, l in lane_of.items():
                    t = kb.get_task(conn, card)
                    sid = str(l.get("session") or "")
                    linked.append(
                        {
                            "id": l.get("card"),
                            "title": t.title if t else l.get("title"),
                            "status": t.status if t else "deleted",
                            "session": sid or None,
                            "sessionState": states.get(sid) or ("removed" if sid else "not created"),
                            "laneState": l.get("state"),
                            "waitingOnInput": l.get("input_blocked") is True,
                            "error": l.get("error"),
                            **rel.get(card, no_links),
                        }
                    )
                ready = [{"id": t.id, "title": t.title, **rel.get(t.id, no_links)} for t in kb.list_tasks(conn, assignee=assignee, status="ready") if t.id not in lane_of]
                # Every card (archived ones aside) with its links and session: the dependency graph.
                for t in tasks:
                    l = lane_of.get(t.id)
                    sid = str((l or {}).get("session") or "") or session_of.get((slug, t.id), "")
                    cards.append(
                        {
                            "id": t.id,
                            "title": t.title,
                            "status": t.status,
                            "assignee": t.assignee,
                            **rel.get(t.id, no_links),
                            "session": sid or None,
                            "sessionState": (states.get(sid) or "removed") if sid else ("not created" if l else None),
                            "lane": l is not None,
                            "laneState": l.get("state") if l else None,
                            "plan": card_plan(info_of[sid], card_of) if sid in info_of else None,
                        }
                    )
        except Exception as exc:
            ticks.setdefault(slug, {})["error"] = f"cannot read the board: {exc}"
        tick = ticks.get(slug) if isinstance(ticks.get(slug), dict) else {}
        out.append(
            {
                "slug": slug,
                "name": b.get("name") or slug,
                "lane": s.lane.enabled and listed,
                "listed": listed,
                "folder": entry.get("folder"),
                "group": entry.get("group"),
                "defaultGroup": b.get("name") or slug,
                "mode": entry.get("mode"),
                "assignee": entry.get("assignee"),
                "effectiveAssignee": assignee,
                "effectiveMode": entry.get("mode") or s.lane.mode,
                "model": entry.get("model"),
                "harness": entry.get("harness"),
                "commentAuthors": entry.get("comment_authors"),
                "effectiveCommentAuthors": list(trusted.comment_authors),
                "archiveCompleted": entry.get("archive_completed"),
                "effectiveArchiveCompleted": settings_mod.archive_completed(s, slug),
                "linked": linked,
                "ready": ready,
                "cards": cards,
                "lastPass": tick.get("at"),
                "error": tick.get("error"),
            }
        )
    return {
        "profile": profile_name(),
        "enabled": s.lane.enabled,
        "assignee": s.lane.assignee,
        "mode": s.lane.mode,
        "archiveCompleted": s.lane.archive_completed,
        "allBoards": not s.lane.boards,
        "boards": out,
    }


def set_lane_enabled(body: dict) -> dict:
    if not isinstance(body.get("enabled"), bool):
        raise ApiError(400, "enabled must be true or false")
    commands.set_lane(enabled=body["enabled"])
    return boards_view()


def update_board(slug: str, body: dict) -> dict:
    if slug not in {b["slug"] for b in board_slugs()}:
        raise ApiError(404, f"no kanban board {slug}")
    fields: dict[str, Optional[str]] = {}
    for key, name in (("folder", "folder"), ("group", "group"), ("mode", "mode"), ("assignee", "assignee"), ("model", "model"), ("harness", "harness"), ("commentAuthors", "comment_authors")):
        if key in body:
            v = body[key]
            if v is not None and not isinstance(v, str):
                raise ApiError(400, f"{key} must be text")
            fields[name] = v or ""
    if "archiveCompleted" in body:
        v = body["archiveCompleted"]
        if v is not None and not isinstance(v, bool):
            raise ApiError(400, "archiveCompleted must be true, false or null (the lane's setting)")
        fields["archive_completed"] = "" if v is None else "on" if v else "off"
    try:
        if fields:
            commands.set_board(slug, **fields)
        if isinstance(body.get("lane"), bool):
            commands.set_board_in_lane(slug, body["lane"], [b["slug"] for b in board_slugs()])
    except ValueError as exc:
        raise ApiError(400, str(exc)) from exc
    return boards_view()


def archive_done_cards(slug: str) -> dict:
    """Archives the board's done lane cards and their sessions (`hermes switchyard archive-done`)."""
    if slug not in {b["slug"] for b in board_slugs()}:
        raise ApiError(404, f"no kanban board {slug}")
    require_omp(settings())
    return {**lane().archive_done(slug), "view": boards_view()}


# ---------- AO dashboard: AO's web UI, served by the Switchyard server on the machine with your code ----------
# /ao/… proxies to http://127.0.0.1:<dashboardPort>/…, behind Hermes's own sign-in (the browser
# dashboard's session cookie reaches a same-origin iframe). Every URL of AO's UI is relative, so it
# works under /api/plugins/switchyard/ao/. HTTP only: no WebSocket (AO's terminal panes), since
# Hermes's auth gate is HTTP middleware and a socket here would go unauthenticated.

AO_DEFAULT_PORT = 3012
AO_INSTALL = "switchyard dashboard install"
# Hop-by-hop headers (RFC 9110 §7.6.1) never cross a proxy, nor do the headers that carry the
# browser's origin or its Hermes credentials: the AO server's request policy wants a loopback Host
# and no foreign Origin/Sec-Fetch-*, and Hermes's cookies/tokens are none of its business.
_HOP_BY_HOP = frozenset({"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"})
_NOT_FORWARDED = frozenset({"host", "origin", "referer", "cookie", "authorization", "content-length", "forwarded", "x-real-ip"})
_NOT_FORWARDED_PREFIXES = ("sec-fetch-", "x-forwarded-", "x-hermes-")
# Responses land on Hermes's origin: a cookie AO set would be a cookie of the Hermes dashboard. The
# server in front (uvicorn) dates the response itself.
_NOT_RETURNED = frozenset({"set-cookie", "set-cookie2", "date"})
_OTHER_PAGE = frozenset({"cross-site", "same-site"})
# One client per event loop (pooled connections belong to the loop that opened them).
_AO_CLIENTS: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, httpx.AsyncClient]" = weakref.WeakKeyDictionary()


def switchyard_home() -> Path:
    return Path(os.environ.get("SWITCHYARD_HOME") or Path.home() / ".switchyard")


def ao_dashboard_port() -> Optional[int]:
    """The AO dashboard server's port: `dashboardPort` of <SWITCHYARD_HOME or ~/.switchyard>/config.json
    (default 3012), or None when `"dashboard": "off"` (the keys src/ao/config.ts reads)."""
    try:
        raw = json.loads((switchyard_home() / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    if not isinstance(raw, dict):
        raw = {}
    if raw.get("dashboard") == "off":
        return None
    port = raw.get("dashboardPort")
    return port if isinstance(port, int) and not isinstance(port, bool) and 0 < port < 65536 else AO_DEFAULT_PORT


def _connection_listed(headers: list[tuple[str, str]]) -> set[str]:
    """Header names a Connection header declares hop-by-hop."""
    return {t.strip().lower() for k, v in headers if k.lower() == "connection" for t in v.split(",") if t.strip()}


def ao_request_headers(raw: list[tuple[bytes, bytes]]) -> list[tuple[str, str]]:
    """The browser's request headers the AO server gets (httpx sets Host to 127.0.0.1:<port>)."""
    headers = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in raw]
    listed = _connection_listed(headers)
    out = []
    for k, v in headers:
        name = k.lower()
        if name in _HOP_BY_HOP or name in listed or name in _NOT_FORWARDED or name.startswith(_NOT_FORWARDED_PREFIXES):
            continue
        out.append((k, v))
    return out


def ao_response_headers(raw: list[tuple[bytes, bytes]], port: int, mount: str) -> list[tuple[bytes, bytes]]:
    """The AO server's response headers the browser gets; a redirect into the server stays under `mount`
    (the public path of /ao/, ending in /)."""
    headers = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in raw]
    listed = _connection_listed(headers)
    origin = f"http://127.0.0.1:{port}"
    out = []
    for k, v in headers:
        name = k.lower()
        if name in _HOP_BY_HOP or name in listed or name in _NOT_RETURNED:
            continue
        if name == "location":
            if v == origin or v.startswith(origin + "/"):
                v = v[len(origin):] or "/"
            if v.startswith("/") and not v.startswith("//"):
                v = mount + v[1:]
        out.append((name, v))
    return [(k.encode("latin-1"), v.encode("latin-1")) for k, v in out]


def ao_other_page_write(request: Request) -> bool:
    """A write another page made, by the browser's own Sec-Fetch-Site verdict (pages can't forge it)."""
    if request.method in ("GET", "HEAD"):
        return False
    return any(v.strip().lower() in _OTHER_PAGE for v in request.headers.getlist("sec-fetch-site"))


def ao_split_path(request: Request, path: str) -> tuple[str, str]:
    """(mount, upstream path): the public path of /ao/ (with Hermes's X-Forwarded-Prefix) and the rest
    of the request path as the browser sent it (still percent-encoded)."""
    raw = request.scope.get("raw_path")
    text = raw.decode("latin-1") if isinstance(raw, bytes) else request.url.path
    i = text.find("/ao/")
    if i < 0:
        return "/api/plugins/switchyard/ao/", quote(path)
    return f"{_forwarded_prefix(request)}{text[: i + 4]}", text[i + 4 :]


def _forwarded_prefix(request: Request) -> str:
    try:
        from hermes_cli.dashboard_auth.prefix import prefix_from_request
    except ImportError:
        return ""
    return prefix_from_request(request)


def public_base(request: Request) -> str:
    """The address the caller reached this dashboard at, with its reverse-proxy path prefix."""
    return str(request.base_url).rstrip("/") + _forwarded_prefix(request)


def ao_page(base_url: str) -> dict:
    """The public page that opens the AO dashboard in a browser (Hermes Desktop can't embed it: its
    bearer token stays in its main process). The page signs in if needed, then goes to /ao/."""
    return {"page": plugin_page("ao-dashboard.html", base_url), "port": ao_dashboard_port()}


def _ao_client() -> httpx.AsyncClient:
    loop = asyncio.get_running_loop()
    client = _AO_CLIENTS.get(loop)
    if client is None:
        # No read timeout: SSE streams stay open for as long as the page does.
        client = httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=httpx.Timeout(None, connect=5.0, write=30.0, pool=5.0))
        _AO_CLIENTS[loop] = client
    return client


async def ao_proxy(request: Request, path: str) -> Response:
    if ao_other_page_write(request):
        return JSONResponse({"error": "AO dashboard writes must come from this dashboard's own page"}, status_code=403)
    port = await asyncio.to_thread(ao_dashboard_port)
    if port is None:
        hint = f'The AO dashboard is off ("dashboard": "off" in {switchyard_home() / "config.json"}): remove that key and run switchyard server restart.'
        return JSONResponse({"error": hint}, status_code=404)
    mount, upstream_path = ao_split_path(request, path)
    url = f"http://127.0.0.1:{port}/{upstream_path}"
    if request.url.query:
        url += f"?{request.url.query}"
    client = _ao_client()
    body = None if request.method in ("GET", "HEAD") else await request.body()
    try:
        upstream = await client.send(client.build_request(request.method, url, headers=ao_request_headers(request.headers.raw), content=body), stream=True)
    except httpx.TransportError:
        return JSONResponse({"error": f"AO dashboard server not running on 127.0.0.1:{port} (switchyard server start)"}, status_code=502)

    async def close() -> None:
        # Shielded: a client that went away cancels the response, and the upstream stream must still close.
        with anyio.CancelScope(shield=True):
            await upstream.aclose()

    async def chunks() -> Any:
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        except httpx.TransportError:
            return  # the AO server went away mid-stream: end the response
        finally:
            await close()

    response = StreamingResponse(chunks(), status_code=upstream.status_code, background=BackgroundTask(close))
    response.raw_headers = ao_response_headers(upstream.headers.raw, port, mount)
    return response


# ---------- routes ----------

router = APIRouter()


async def _run(fn: Callable[..., Any], *args: Any, write: bool = False) -> Any:
    try:
        return await asyncio.to_thread(fn, *args)
    except ApiError as exc:
        return JSONResponse({"error": str(exc)}, status_code=exc.status)
    except SwitchyardError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400 if write else 502)
    except PermissionError as exc:
        return JSONResponse({"error": str(exc)}, status_code=403)


async def _body(request: Request) -> dict:
    try:
        data = await request.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


@router.get("/overview")
async def get_overview() -> Any:
    return await _run(overview)


@router.get("/sessions")
async def get_sessions() -> Any:
    return await _run(list_sessions)


@router.get("/sessions/{sid}")
async def get_session(sid: str) -> Any:
    return await _run(session_detail, sid)


@router.post("/sessions")
async def post_session(request: Request) -> Any:
    return await _run(start_session, await _body(request), write=True)


@router.post("/sessions/{sid}/vscode")
async def post_session_vscode(sid: str, request: Request) -> Any:
    return await _run(open_in_vscode, sid, await _body(request), str(request.base_url), write=True)


@router.post("/sessions/{sid}/project")
async def post_session_project(sid: str, request: Request) -> Any:
    return await _run(open_project, sid, str(request.base_url), write=True)


@router.post("/folders/vscode")
async def post_folder_vscode(request: Request) -> Any:
    return await _run(open_folder, await _body(request), str(request.base_url), write=True)


@router.get("/models")
async def get_models(search: Optional[str] = None) -> Any:
    return await _run(models_view, search)


@router.post("/models/default")
async def post_default_model(request: Request) -> Any:
    return await _run(set_default_model, await _body(request), write=True)


@router.post("/sessions/archive-done")
async def post_archive_done(request: Request) -> Any:
    return await _run(archive_done, await _body(request), write=True)


@router.post("/sessions/{sid}/{action}")
async def post_session_action(sid: str, action: str, request: Request) -> Any:
    return await _run(session_action, sid, action, await _body(request), write=True)


@router.post("/boards/{slug}/archive-done")
async def post_board_archive_done(slug: str) -> Any:
    return await _run(archive_done_cards, slug, write=True)


@router.get("/orchestrators")
async def get_orchestrators() -> Any:
    return await _run(list_orchestrators)


@router.post("/orchestrators/submit")
async def post_orchestrator_submit(request: Request) -> Any:
    return await _run(submit_to_orchestrator, await _body(request), write=True)


@router.get("/orchestrators/{project}")
async def get_orchestrator_of(project: str) -> Any:
    return await _run(get_orchestrator, project)


@router.get("/orchestrators/{project}/config")
async def get_orchestrator_config(project: str) -> Any:
    return await _run(orchestrator_config, project)


@router.post("/orchestrators/{project}/config")
async def post_orchestrator_config(project: str, request: Request) -> Any:
    return await _run(orchestrator_config, project, await _body(request), write=True)


@router.post("/orchestrators/{project}/{action}")
async def post_orchestrator_action(project: str, action: str, request: Request) -> Any:
    return await _run(orchestrator_action, project, action, await _body(request), write=True)


@router.get("/harnesses")
async def get_harnesses() -> Any:
    return await _run(harnesses_view)


@router.get("/projects")
async def get_projects() -> Any:
    return await _run(places)


@router.get("/boards")
async def get_boards() -> Any:
    return await _run(boards_view)


@router.post("/lane")
async def post_lane(request: Request) -> Any:
    return await _run(set_lane_enabled, await _body(request), write=True)


@router.post("/boards/{slug}")
async def post_board(slug: str, request: Request) -> Any:
    return await _run(update_board, slug, await _body(request), write=True)


@router.get("/ao-page")
async def get_ao_page(request: Request) -> Any:
    return await _run(ao_page, public_base(request))


@router.api_route("/ao", methods=["GET", "HEAD"])
async def ao_root(request: Request) -> Response:
    # Relative, so it lands under whatever prefix the browser used; AO's relative URLs need the slash.
    return RedirectResponse(f"ao/?{request.url.query}" if request.url.query else "ao/", status_code=307)


@router.api_route("/ao/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
async def ao_route(path: str, request: Request) -> Response:
    return await ao_proxy(request, path)
