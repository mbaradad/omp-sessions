"""`/omp` (sessions summary) and `hermes omp …` (status and lane settings)."""

from __future__ import annotations

import argparse
import json
import os
import time
from typing import Any, Callable, Optional

from .lane import Lane, short
from .ompvs import OmpVs, OmpVsError, find_omp_vs
from .settings import MODES, Settings
from .store import Store


def _ago(ts: Any) -> str:
    try:
        s = int(time.time() - float(ts))
    except (TypeError, ValueError):
        return "never"
    if s < 90:
        return f"{s}s ago"
    if s < 5400:
        return f"{s // 60}m ago"
    return f"{s // 3600}h ago"


def _session_map(omp: OmpVs) -> dict[str, dict]:
    try:
        return {str(s["meta"]["id"]): s for s in omp.sessions(all=True) if isinstance(s.get("meta"), dict)}
    except OmpVsError:
        return {}


def status_data(ctx: Any, settings: Settings, store: Store, lane: Lane, omp: OmpVs) -> dict:
    sessions = _session_map(omp)
    links = lane.links()
    try:
        sched: Optional[dict] = omp.scheduler()
    except OmpVsError:
        sched = None
    cmd = find_omp_vs(settings.omp_vs)
    try:
        inject = bool(ctx._gateway_injection_allowed())
    except Exception:
        inject = None
    linked = []
    for key, l in sorted(links.items()):
        s = sessions.get(str(l.get("session", "")))
        linked.append(
            {
                "card": key,
                "title": l.get("title"),
                "session": l.get("session"),
                "session_status": (s or {}).get("column") or ((s or {}).get("meta") or {}).get("status") or ("removed" if l.get("session") else "not created"),
                "lane_state": l.get("state"),
                "waiting_on_input": l.get("input_blocked") is True,
                "cwd": l.get("cwd"),
                "branch": l.get("branch"),
                "error": l.get("error"),
            }
        )
    return {
        "omp_vs": " ".join(cmd) if cmd else None,
        "scheduler": sched,
        "notify": settings.notify,
        "injection_allowed": inject,
        "watches": len(store.get("watches", {}) or {}),
        "lane": {
            "enabled": settings.lane.enabled,
            "assignee": settings.lane.assignee,
            "mode": settings.lane.mode,
            "boards": settings.lane.boards or "all",
            "ticks": lane.store.get("lane_status", {}) or {},
            "state": str(lane.store.state.data_dir),
        },
        "projects": settings.projects,
        "linked": linked,
    }


def status_text(d: dict) -> str:
    lane = d["lane"]
    lines = [f"omp-vs: {d['omp_vs'] or 'NOT FOUND (install it from VS Code: omp: Install omp-vs Command)'}"]
    s = d.get("scheduler")
    if s:
        limit = f"limit {s.get('maxConcurrent')}" if s.get("maxConcurrent") else "no limit"
        lines.append(f"omp scheduler: {s.get('running', 0)} running, {s.get('waiting', 0)} waiting ({limit}{', paused' if s.get('paused') else ''}){'' if s.get('server') else ' · omp-vs server not running'}")
    inj = d.get("injection_allowed")
    lines.append(
        f"notify: {'on' if d['notify'] else 'off'}"
        + (" · injection NOT allowed (set plugins.entries.omp-sessions.allow_gateway_injection: true)" if inj is False else "")
        + f" · {d['watches']} watched session(s)"
    )
    boards = lane["boards"]
    board_text = "every board" if boards == "all" else ", ".join(
        f"{slug}" + (f" ({', '.join(f'{k}={v}' for k, v in cfg.items())})" if cfg else "") for slug, cfg in boards.items()
    )
    lines.append(f"lane (this profile): {'on' if lane['enabled'] else 'off'} · assignee {lane['assignee']} · mode {lane['mode'] or 'omp default'} · {board_text}")
    lines.append(f"lane links and lock (all profiles): {lane['state']}")
    for slug, t in sorted((lane.get("ticks") or {}).items()):
        extra = f" · started {', '.join(t['started'])}" if t.get("started") else ""
        err = f" · error: {t['error']}" if t.get("error") else ""
        lines.append(f"  {slug}: last pass {_ago(t.get('at'))}{extra}{err}")
    if d["projects"]:
        lines.append("project folders: " + ", ".join(f"{k} → {v}" for k, v in d["projects"].items()))
    if d["linked"]:
        lines.append("linked cards:")
        for l in d["linked"]:
            sid = short(str(l["session"])) if l["session"] else "-"
            flags = " · waiting on input" if l["waiting_on_input"] else ""
            flags += f" · lane {l['lane_state']}" if l["lane_state"] != "active" else ""
            flags += f" · {l['error']}" if l.get("error") else ""
            lines.append(f"  {l['card']}  {l['title']!s:.50}  → omp {sid} ({l['session_status']}){flags}")
    else:
        lines.append("linked cards: none")
    return "\n".join(lines)


def sessions_summary(omp: OmpVs) -> str:
    try:
        infos = omp.sessions(all=False)
    except OmpVsError as exc:
        return f"omp-sessions: {exc}"
    if not infos:
        return "No running omp sessions."
    lines = []
    for s in infos:
        m = s.get("meta") or {}
        q = s.get("queue") or {}
        queue = f" · queue {q.get('done', 0)}/{q.get('total', 0)}" if q.get("total") else ""
        group = f" · {s['group']}" if s.get("group") else ""
        lines.append(f"{str(m.get('id', ''))[:8]}  {s.get('column', m.get('status'))!s:<11} {m.get('title', '')!s:.60}{group}{queue}\n          {m.get('cwd', '')}")
    return "\n".join(lines)


def setup_cli(parser: argparse.ArgumentParser) -> None:
    sub = parser.add_subparsers(dest="omp_cmd")
    st = sub.add_parser("status", help="omp-vs, notifications, the kanban lane and linked cards")
    st.add_argument("--json", action="store_true")
    sub.add_parser("sessions", help="running omp sessions")
    lane = sub.add_parser("lane", help="the kanban lane: on, off, run")
    lane_sub = lane.add_subparsers(dest="lane_cmd")
    on = lane_sub.add_parser("on", help="run cards assigned to the assignee as omp sessions")
    on.add_argument("--assignee", help="card assignee the lane takes (default omp)")
    on.add_argument("--mode", choices=MODES, help="starting permission mode of card sessions")
    on.add_argument("--board", action="append", default=[], help="only this board (repeatable; default: every board)")
    lane_sub.add_parser("off", help="stop taking new cards (linked cards are still reported)")
    run = lane_sub.add_parser("run", help="one lane pass now (normally every dispatcher tick)")
    run.add_argument("--board", action="append", default=[], help="only this board (repeatable)")
    board = sub.add_parser("board", help="per-board lane settings")
    board.add_argument("slug")
    board.add_argument("--folder", help="cwd for cards with a scratch workspace")
    board.add_argument("--group", help="omp group of the board's sessions (default: board name)")
    board.add_argument("--mode", choices=MODES)
    board.add_argument("--assignee")
    board.add_argument("--remove", action="store_true", help="drop the board from the lane's list")
    project = sub.add_parser("project", help="map a Hermes project (or any name) to a folder")
    project.add_argument("name")
    project.add_argument("folder", nargs="?")
    project.add_argument("--remove", action="store_true")
    notify = sub.add_parser("notify", help="tell Hermes sessions when their omp sessions settle")
    notify.add_argument("value", choices=("on", "off"))


def _lane_raw(ctx: Any) -> dict:
    v = ctx.get_config("lane", None)
    return dict(v) if isinstance(v, dict) else {}


def run_cli(args: argparse.Namespace, ctx: Any, settings: Callable[[], Settings], store: Store, omp: Callable[[], OmpVs], lane: Lane) -> int:
    cmd = getattr(args, "omp_cmd", None) or "status"
    if cmd == "status":
        d = status_data(ctx, settings(), store, lane, omp())
        print(json.dumps(d, indent=2, default=str) if getattr(args, "json", False) else status_text(d))
        return 0
    if cmd == "sessions":
        print(sessions_summary(omp()))
        return 0
    if cmd == "lane":
        sub = getattr(args, "lane_cmd", None)
        raw = _lane_raw(ctx)
        if sub == "on":
            raw["enabled"] = True
            if args.assignee:
                raw["assignee"] = args.assignee.lower()
            if args.mode:
                raw["mode"] = args.mode
            if args.board:
                boards = dict(raw.get("boards") or {}) if isinstance(raw.get("boards"), dict) else {}
                for b in args.board:
                    boards.setdefault(b, {})
                raw["boards"] = boards
            ctx.set_config("lane", raw)
        elif sub == "off":
            raw["enabled"] = False
            ctx.set_config("lane", raw)
        elif sub == "run":
            from hermes_cli import kanban_db as kb

            slugs = args.board or [b.get("slug") or kb.DEFAULT_BOARD for b in kb.list_boards(include_archived=False)]
            for slug in slugs:
                lane.tick(slug)
        else:
            print("usage: hermes omp lane on|off|run")
            return 2
        print(status_text(status_data(ctx, settings(), store, lane, omp())))
        return 0
    if cmd == "board":
        raw = _lane_raw(ctx)
        boards = dict(raw.get("boards") or {}) if isinstance(raw.get("boards"), dict) else {}
        if args.remove:
            boards.pop(args.slug, None)
        else:
            entry = dict(boards.get(args.slug) or {})
            if args.folder:
                folder = os.path.abspath(os.path.expanduser(args.folder))
                if not os.path.isdir(folder):
                    print(f"not a folder: {folder}")
                    return 1
                entry["folder"] = folder
            for key in ("group", "mode", "assignee"):
                if getattr(args, key):
                    entry[key] = getattr(args, key)
            boards[args.slug] = entry
        raw["boards"] = boards
        ctx.set_config("lane", raw)
        print(status_text(status_data(ctx, settings(), store, lane, omp())))
        return 0
    if cmd == "project":
        v = ctx.get_config("projects", None)
        projects = dict(v) if isinstance(v, dict) else {}
        if args.remove:
            projects.pop(args.name, None)
        elif args.folder:
            folder = os.path.abspath(os.path.expanduser(args.folder))
            if not os.path.isdir(folder):
                print(f"not a folder: {folder}")
                return 1
            projects[args.name] = folder
        else:
            print(projects.get(args.name, f"{args.name}: no folder set"))
            return 0
        ctx.set_config("projects", projects)
        print("project folders: " + (", ".join(f"{k} → {p}" for k, p in projects.items()) or "none"))
        return 0
    if cmd == "notify":
        ctx.set_config("notify", args.value == "on")
        print(f"notify: {args.value}")
        return 0
    return 2
