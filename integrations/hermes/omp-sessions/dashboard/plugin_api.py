"""omp Sessions page backend for the Hermes dashboard and Hermes Desktop: /api/plugins/omp-sessions/.

Hermes imports this file on its own (importlib, outside any package), so it loads the plugin folder
above it as a package and reuses the plugin's modules: omp-sessions calls (ompsessions), settings, the kanban
lane's links and status (lane, store), and the place resolution of the omp_session_start tool.
Settings are the requesting profile's (config.yaml `plugins.entries.omp-sessions.settings`); the
lane's card links are machine-wide like the kanban boards.

Every handler is async and moves its blocking work (omp-sessions subprocesses, sqlite) to a thread.
Errors come back as JSON {"error": message} with a 4xx/5xx status.
"""

from __future__ import annotations

import asyncio
import importlib
import importlib.util
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

INSTALL_HINT = (
    "omp-sessions is not installed. Install the omp Sessions extension in VS Code and run "
    "“omp: Install omp-sessions Command”, or set plugins.entries.omp-sessions.settings.omp_sessions to its path."
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
    name = "omp_sessions_dashboard_plugin"
    if name not in sys.modules:
        root = Path(__file__).resolve().parent.parent
        spec = importlib.util.spec_from_file_location(name, root / "__init__.py", submodule_search_locations=[str(root)])
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load the omp-sessions plugin from {root}")
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
ompsessions = importlib.import_module(f"{_PKG}.ompsessions")
settings_mod = importlib.import_module(f"{_PKG}.settings")
store_mod = importlib.import_module(f"{_PKG}.store")
tools_mod = importlib.import_module(f"{_PKG}.tools")

OmpSessionsError = ompsessions.OmpSessionsError


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


# ---------- settings of the requesting profile ----------


class ProfileConfig:
    """ctx.get_config of the plugin, for the profile the request runs for (writes go through
    settings.update_setting, like the plugin's own `hermes omp` commands)."""

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
    return ompsessions.OmpSessions(settings().omp_sessions)


def lane() -> Any:
    return lane_mod.Lane(store_mod.Store(store_mod.FileState(store_mod.lane_data_dir)), settings, omp)


def profile_name() -> str:
    from hermes_constants import get_hermes_home, profile_name_for_home

    return profile_name_for_home(get_hermes_home()) or "custom"


def require_omp(s: Any) -> Any:
    if not ompsessions.find_omp_sessions(s.omp_sessions):
        raise ApiError(503, INSTALL_HINT)
    return ompsessions.OmpSessions(s.omp_sessions)


# ---------- caches (per process; keyed so a change is never served stale) ----------

_LOCK = threading.Lock()
_VERSION: dict[str, tuple[float, dict]] = {}
# session id -> (updatedAt, question): `omp-sessions show` only reruns when the session changed.
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
    want: list[tuple[str, Any]] = []
    out: dict[str, Optional[dict]] = {}
    for info in infos:
        meta = info.get("meta") or {}
        if ompsessions.agent_state(info) != "needs_input":
            continue
        sid, stamp = str(meta.get("id")), meta.get("updatedAt")
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
            except OmpSessionsError:
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


def card_lookup(refs: set[tuple[str, str]]) -> dict[tuple[str, str], dict]:
    """{(board, card id): {title, status, assignee}} for the cards that still exist."""
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
                for card in cards:
                    t = kb.get_task(conn, card)
                    if t is not None:
                        out[(board, card)] = {"title": t.title, "status": t.status, "assignee": t.assignee}
        except Exception:
            continue
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


def session_view(info: dict, card: Optional[dict], ref: Optional[tuple[str, str]], question: Optional[dict]) -> dict:
    meta = info.get("meta") or {}
    q = info.get("queue") or {}
    cwd = str(meta.get("cwd") or "")
    view = {
        "id": meta.get("id"),
        "title": meta.get("title") or "(untitled)",
        "cwd": cwd,
        "cwdLabel": tilde(cwd),
        "project": os.path.basename(cwd.rstrip("/\\")) or cwd,
        "state": ompsessions.agent_state(info),
        "status": meta.get("status"),
        "mode": meta.get("permissionMode"),
        "model": meta.get("model"),
        "cost": meta.get("cost") or 0,
        "changedFiles": meta.get("changedFiles") or 0,
        "createdAt": meta.get("createdAt"),
        "updatedAt": meta.get("updatedAt"),
        "group": info.get("group"),
        "color": info.get("color"),
        "priority": info.get("priority"),
        "tags": [t for t in (info.get("tags") or []) if isinstance(t, str)],
        "archived": info.get("archived") is True,
        "queue": {k: int(q.get(k) or 0) for k in ("pending", "running", "done", "total")},
        "startAt": q.get("startAt"),
        "waiting": info.get("waiting"),
        "excerpt": excerpt(meta.get("lastText")),
        "exitReason": meta.get("exitReason") if meta.get("status") == "stopped" else None,
        "authProblem": meta.get("authProblem"),
        "question": question,
        "card": None,
    }
    if ref:
        view["card"] = {"board": ref[0], "id": ref[1], "title": (card or {}).get("title"), "status": (card or {}).get("status")}
    return view


def list_sessions() -> dict:
    s = settings()
    o = require_omp(s)
    infos = [i for i in o.sessions(all=True) if isinstance(i.get("meta"), dict)]
    by_session = {str(l.get("session")): l for l in lane().links().values() if l.get("session")}
    refs = {r: i for i in infos if (r := card_ref(i, by_session))}
    cards = card_lookup(set(refs)) if refs else {}
    questions = questions_for(o, infos)
    views = []
    for info in infos:
        ref = card_ref(info, by_session)
        sid = str(info["meta"].get("id"))
        views.append(session_view(info, cards.get(ref) if ref else None, ref, questions.get(sid)))
    return {"sessions": views, "at": time.time()}


def session_detail(sid: str) -> dict:
    s = settings()
    o = require_omp(s)
    report = o.show(sid)
    if report is None:
        raise ApiError(404, f"no session matches {sid}")
    info = next((i for i in o.sessions(all=True) if (i.get("meta") or {}).get("id") == report.get("id")), None)
    if info is None:
        raise ApiError(404, f"session {sid[:8]} is gone")
    by_session = {str(l.get("session")): l for l in lane().links().values() if l.get("session")}
    ref = card_ref(info, by_session)
    card = card_lookup({ref}).get(ref) if ref else None
    question = report.get("question") if isinstance(report.get("question"), dict) else None
    view = session_view(info, card, ref, question)
    view.update(reply=report.get("reply"), model=report.get("model") or view["model"], changedFiles=report.get("changedFiles") or view["changedFiles"])
    return view


def _text(body: dict, key: str) -> Optional[str]:
    v = body.get(key)
    return v.strip() if isinstance(v, str) and v.strip() else None


def start_session(body: dict) -> dict:
    s = settings()
    o = require_omp(s)
    prompt = _text(body, "prompt")
    if not prompt:
        raise ApiError(400, "write what omp should do")
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
    when = _text(body, "when") or "now"
    if when == "now":
        return o.new(cwd, prompt=prompt, title=title or lane_mod.one_line(prompt, 60), mode=mode, tags=tags, group=group)
    if when not in ("queue", "at"):
        raise ApiError(400, "when must be now, queue or at")
    at = _text(body, "at") if when == "at" else None
    if when == "at" and not at:
        raise ApiError(400, "say when it starts: +30m, 14:30 or a date and time")
    task = title or lane_mod.one_line(prompt, 80)
    notes = "\n\n".join(x for x in (prompt if prompt != task else None, _text(body, "notes")) if x) or None
    return o.new(cwd, task=task, notes=notes, at=at, title=title, mode=mode, tags=tags, group=group)


def session_action(sid: str, action: str, body: dict) -> dict:
    o = require_omp(settings())
    if action == "send":
        text = _text(body, "text")
        if not text:
            raise ApiError(400, "nothing to send")
        o.ok(["send", sid, "-", *(["--follow-up"] if body.get("followUp") is True else [])], stdin=text, timeout=90)
        return {"ok": True}
    if action == "answer":
        answer = _text(body, "answer")
        if not answer:
            raise ApiError(400, "give an answer")
        return {"ok": True, "output": o.ok(["answer", sid, answer]).strip()}
    if action == "mode":
        mode = _text(body, "mode")
        if mode not in settings_mod.MODES:
            raise ApiError(400, f"mode must be one of {', '.join(settings_mod.MODES)}")
        return {"ok": True, "output": o.ok(["mode", sid, mode]).strip()}
    if action == "stop":
        return {"ok": True, "output": o.ok(["stop", sid], timeout=60).strip()}
    raise ApiError(404, f"unknown action {action}")


def open_in_vscode(sid: str, base_url: str) -> dict:
    """Asks the VS Code window last used on omp's machine to open the session (`omp-sessions vscode`).

    `url` is the vscode:// link (a browser opens it); `page` is a page of this dashboard that opens
    it, for hosts that only open web links (Hermes Desktop): it is served without sign-in and holds
    nothing but a redirect, so `base_url` is the address the caller reached this dashboard at."""
    o = require_omp(settings())
    out = o.json(["vscode", sid, "--json"])
    url = out.get("url") if isinstance(out, dict) else None
    if not isinstance(url, str) or not url:
        raise ApiError(502, "omp-sessions vscode printed no link")
    # The profile segment serves the requesting profile's copy (the page's own `?profile=`).
    profile = profile_name()
    scope = f"@{quote(profile, safe='')}/" if profile != "custom" else ""
    page = f"{base_url.rstrip('/')}/dashboard-plugins/{scope}omp-sessions/open-vscode.html#{quote(url, safe='')}"
    return {"url": url, "page": page, "authority": out.get("authority"), "windowAt": out.get("windowAt")}


# ---------- overview, places, boards ----------


def overview() -> dict:
    s = settings()
    ln = lane()
    cmd = ompsessions.find_omp_sessions(s.omp_sessions)
    profile = profile_name()
    disp = ln.dispatcher()
    out: dict[str, Any] = {
        "profile": profile,
        "pluginVersion": PLUGIN_VERSION,
        "ompSessions": {"found": bool(cmd), "command": " ".join(cmd) if cmd else None, "hint": None if cmd else INSTALL_HINT},
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
        o = ompsessions.OmpSessions(s.omp_sessions)
        try:
            out["ompSessions"].update(omp_version(o))
        except OmpSessionsError as exc:
            out["ompSessions"]["error"] = str(exc)
        try:
            out["scheduler"] = o.scheduler()
        except OmpSessionsError as exc:
            out["ompSessions"]["error"] = str(exc)
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
    ticks = ln.store.get("lane_status", {}) or {}
    states: dict[str, str] = {}
    if ompsessions.find_omp_sessions(s.omp_sessions):
        try:
            states = {str(i["meta"]["id"]): ompsessions.agent_state(i) for i in ompsessions.OmpSessions(s.omp_sessions).sessions(all=True) if isinstance(i.get("meta"), dict)}
        except OmpSessionsError:
            states = {}
    out = []
    for b in board_slugs():
        slug = str(b["slug"])
        entry = s.lane.boards.get(slug, {})
        assignee = (entry.get("assignee") or s.lane.assignee).lower()
        listed = not s.lane.boards or slug in s.lane.boards
        linked, ready = [], []
        try:
            with kbc.connect_closing(board=slug) as conn:
                for key, l in sorted(links.items()):
                    if l.get("board") != slug:
                        continue
                    t = kb.get_task(conn, str(l.get("card")))
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
                        }
                    )
                mine = {str(l.get("card")) for l in links.values() if l.get("board") == slug}
                ready = [{"id": t.id, "title": t.title} for t in kb.list_tasks(conn, assignee=assignee, status="ready") if t.id not in mine]
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
                "linked": linked,
                "ready": ready,
                "lastPass": tick.get("at"),
                "error": tick.get("error"),
            }
        )
    return {
        "profile": profile_name(),
        "enabled": s.lane.enabled,
        "assignee": s.lane.assignee,
        "mode": s.lane.mode,
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
    for key in ("folder", "group", "mode", "assignee"):
        if key in body:
            v = body[key]
            if v is not None and not isinstance(v, str):
                raise ApiError(400, f"{key} must be text")
            fields[key] = v or ""
    try:
        if fields:
            commands.set_board(slug, **fields)
        if isinstance(body.get("lane"), bool):
            commands.set_board_in_lane(slug, body["lane"], [b["slug"] for b in board_slugs()])
    except ValueError as exc:
        raise ApiError(400, str(exc)) from exc
    return boards_view()


# ---------- routes ----------

router = APIRouter()


async def _run(fn: Callable[..., Any], *args: Any, write: bool = False) -> Any:
    try:
        return await asyncio.to_thread(fn, *args)
    except ApiError as exc:
        return JSONResponse({"error": str(exc)}, status_code=exc.status)
    except OmpSessionsError as exc:
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
    return await _run(open_in_vscode, sid, str(request.base_url), write=True)


@router.post("/sessions/{sid}/{action}")
async def post_session_action(sid: str, action: str, request: Request) -> Any:
    return await _run(session_action, sid, action, await _body(request), write=True)


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
