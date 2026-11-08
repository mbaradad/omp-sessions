"""`/omp` (sessions summary) and `hermes omp …` (status and lane settings)."""

from __future__ import annotations

import argparse
import json
import os
import time
from typing import Any, Callable, Optional, Sequence

from .lane import Lane, short
from .ompvs import OmpVs, OmpVsError, find_omp_vs
from .settings import MODES, Settings, board_lane, update_setting
from .store import Store, profile_of


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


# The dispatcher ticks every ~60 s; quieter than this means it isn't running (or isn't reaching us).
DISPATCHER_STALE_S = 180


def dispatcher_notes(disp: Optional[dict], *, profile: str, lane_on: bool, now: Optional[float] = None) -> list[str]:
    """Problems with where Hermes's kanban dispatcher runs the plugin, for `hermes omp status` and the page.

    Hermes runs one dispatcher per machine, in the gateway holding its lock; its hook reaches the plugin
    instance of that gateway's profile, so the lane only works when it is on in that profile."""
    now = time.time() if now is None else now
    if not disp or not isinstance(disp.get("at"), (int, float)):
        return ["No kanban dispatcher tick has reached the plugin yet. It runs in the gateway: is the gateway running "
                "with the plugin enabled? (A gateway started before the plugin was installed needs `hermes gateway restart`.)"]
    notes = []
    age = now - float(disp["at"])
    if age > DISPATCHER_STALE_S:
        notes.append(f"The last kanban dispatcher tick was {_ago(disp['at'])}: the gateway or its dispatcher has stopped.")
    where = str(disp.get("profile") or "unknown")
    if lane_on and where != profile:
        notes.append(f"The dispatcher runs the plugin in profile '{where}', but the lane is on in '{profile}': "
                     f"turn it on there (`hermes -p {where} omp lane on`) and off here.")
    elif not lane_on and where == profile and disp.get("lane_on") is False:
        notes.append(f"The dispatcher runs in this profile ('{profile}') and the lane is off here: cards assigned to omp stay ready.")
    return notes


def status_data(ctx: Any, settings: Settings, store: Store, lane: Lane, omp: OmpVs) -> dict:
    sessions = _session_map(omp)
    links = lane.links()
    try:
        sched: Optional[dict] = omp.scheduler()
    except OmpVsError:
        sched = None
    cmd = find_omp_vs(settings.omp_vs)
    profile = profile_of(store)
    disp = lane.dispatcher()
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
    last_inject = store.get("last_inject")
    return {
        "omp_vs": " ".join(cmd) if cmd else None,
        "scheduler": sched,
        "notify": settings.notify,
        "last_notification": last_inject if isinstance(last_inject, dict) else None,
        "watches": len(store.get("watches", {}) or {}),
        "profile": profile,
        "dispatcher": disp,
        "dispatcher_notes": dispatcher_notes(disp, profile=profile, lane_on=settings.lane.enabled),
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
    last = d.get("last_notification") or {}
    lines.append(
        f"notify: {'on' if d['notify'] else 'off'}"
        + (f" · last note {'delivered' if last.get('ok') else 'REFUSED'} {_ago(last.get('at'))}" if last else "")
        + (" (allow_gateway_injection off, or the chat that started the session had ended, e.g. a one-shot `hermes chat -Q`)" if last and not last.get("ok") else "")
        + f" · {d['watches']} watched session(s)"
    )
    boards = lane["boards"]
    board_text = "every board" if boards == "all" else ", ".join(
        f"{slug}" + (f" ({', '.join(f'{k}={v}' for k, v in cfg.items())})" if cfg else "") for slug, cfg in boards.items()
    )
    lines.append(f"lane (profile {d['profile']}): {'on' if lane['enabled'] else 'off'} · assignee {lane['assignee']} · mode {lane['mode'] or 'omp default'} · {board_text}")
    disp = d.get("dispatcher")
    if disp:
        lines.append(f"kanban dispatcher: last tick {_ago(disp.get('at'))} in profile {disp.get('profile')} (lane {'on' if disp.get('lane_on') else 'off'} there, pid {disp.get('pid')})")
    lines.extend(f"  ! {n}" for n in d.get("dispatcher_notes") or [])
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


def sessions_brief(omp: OmpVs) -> str:
    """`/omp` in a chat: short enough for a phone (Hermes Console shows slash output as a brief notice)."""
    try:
        infos = omp.sessions(all=False)
    except OmpVsError as exc:
        return f"omp-sessions: {exc}"
    if not infos:
        return "No running omp sessions."
    by: dict[str, list[dict]] = {}
    for s in infos:
        by.setdefault(str(s.get("column") or (s.get("meta") or {}).get("status") or ""), []).append(s)
    labels = (("input", "need you"), ("working", "working"), ("waiting", "queued"), ("idle", "done"), ("stopped", "stopped"))
    lines = [" · ".join(f"{len(by[k])} {label}" for k, label in labels if by.get(k))]
    for s in (by.get("input") or [])[:5]:
        m = s.get("meta") or {}
        lines.append(f"needs you: {str(m.get('id', ''))[:8]} {m.get('title', '')!s:.60}")
    return "\n".join(lines)


def take_card(card_id: str, board: Optional[str], settings: Settings, lane: Lane) -> str:
    """Assigns a kanban card to the omp lane (`/omp take <card> [board]`): the way to route a card to omp
    from clients whose assignee picker only offers Hermes profiles (Hermes Console on Android)."""
    from hermes_cli import kanban_db as kb
    from hermes_cli import kanban_db_connect as kbc

    boards = {b.get("slug"): b.get("name") for b in kb.list_boards(include_archived=False) if b.get("slug")}
    if board and board not in boards:
        return f"No open board {board}."
    slugs = [board] if board else list(boards)
    for slug in slugs:
        with kbc.connect_closing(board=slug) as conn:
            task = kb.get_task(conn, card_id)
            if task is None:
                continue
            cfg = board_lane(settings, slug, boards.get(slug))
            assignee = cfg.assignee if cfg else settings.lane.assignee
            if (task.assignee or "").lower() != assignee:
                try:
                    kb.assign_task(conn, card_id, assignee)
                except RuntimeError as exc:  # a worker runs it under a claim
                    return f"Hermes refused to reassign {card_id} on {slug}: {exc}"
        disp = lane.dispatcher()
        if disp and disp.get("lane_on") is False:
            note = f" The omp lane is off in profile {disp.get('profile')}, where the kanban dispatcher runs: `hermes -p {disp.get('profile')} omp lane on`."
        else:
            note = " The omp lane starts it as an omp session once it is ready."
        return f"{card_id} on {slug} is assigned to {assignee}.{note}"
    return f"No card {card_id} on {'board ' + board if board else 'any open board'}."


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
    take = sub.add_parser("take", help="assign a kanban card to the omp lane")
    take.add_argument("card")
    take.add_argument("--board", help="the card's board (default: search every open board)")


def _lane(raw: Any) -> dict:
    lane = dict(raw) if isinstance(raw, dict) else {}
    boards = lane.get("boards")
    if isinstance(boards, list):  # the short form: a list of slugs
        lane["boards"] = {str(k): {} for k in boards if str(k).strip()}
    elif isinstance(boards, dict):
        lane["boards"] = {str(k): dict(v) if isinstance(v, dict) else {} for k, v in boards.items()}
    else:
        lane["boards"] = {}
    return lane


def set_lane(*, enabled: bool, assignee: Optional[str] = None, mode: Optional[str] = None, boards: Sequence[str] = ()) -> None:
    """Turns the lane on or off (plus, when turning it on, its assignee, mode and extra boards)."""

    def change(raw: Any) -> dict:
        lane = _lane(raw)
        lane["enabled"] = enabled
        if assignee:
            lane["assignee"] = assignee.lower()
        if mode:
            lane["mode"] = mode
        for b in boards:
            lane["boards"].setdefault(b, {})
        return lane

    update_setting("lane", change)


def set_board(
    slug: str,
    *,
    folder: Optional[str] = None,
    group: Optional[str] = None,
    mode: Optional[str] = None,
    assignee: Optional[str] = None,
    remove: bool = False,
) -> None:
    """Per-board lane settings: None leaves a field alone, "" clears it; `remove` drops the board
    from the lane's list. Raises ValueError for a folder that doesn't exist or an unknown mode."""
    if mode and mode not in MODES:
        raise ValueError(f"mode must be one of {', '.join(MODES)}")
    path = os.path.abspath(os.path.expanduser(folder.strip())) if folder and folder.strip() else None
    if path and not os.path.isdir(path):
        raise ValueError(f"not a folder: {path}")

    def change(raw: Any) -> dict:
        lane = _lane(raw)
        if remove:
            lane["boards"].pop(slug, None)
            return lane
        entry = lane["boards"].setdefault(slug, {})
        if folder is not None:
            if path:
                entry["folder"] = path
            else:
                entry.pop("folder", None)
        for key, value in (("group", group), ("mode", mode), ("assignee", assignee)):
            if value is None:
                continue
            if value.strip():
                entry[key] = value.strip().lower() if key == "assignee" else value.strip()
            else:
                entry.pop(key, None)
        return lane

    update_setting("lane", change)


def set_board_in_lane(slug: str, on: bool, all_slugs: Sequence[str]) -> None:
    """Adds a board to the lane's list or takes it out. An empty list means every board, so taking
    one out of it lists every other board explicitly."""

    def change(raw: Any) -> dict:
        lane = _lane(raw)
        boards = lane["boards"]
        if on:
            if boards:  # empty: every board already
                boards.setdefault(slug, {})
        elif slug in boards or not boards:
            if not boards:
                boards.update({s: {} for s in all_slugs if s != slug})
            boards.pop(slug, None)
            if not boards:
                raise ValueError("the lane needs at least one board: turn the lane off instead")
        return lane

    update_setting("lane", change)


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
        if sub == "on":
            set_lane(enabled=True, assignee=args.assignee, mode=args.mode, boards=args.board)
        elif sub == "off":
            set_lane(enabled=False)
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
        try:
            set_board(args.slug, folder=args.folder or None, group=args.group or None, mode=args.mode or None, assignee=args.assignee or None, remove=args.remove)
        except ValueError as exc:
            print(exc)
            return 1
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
        update_setting("projects", lambda _: projects)
        print("project folders: " + (", ".join(f"{k} → {p}" for k, p in projects.items()) or "none"))
        return 0
    if cmd == "notify":
        ctx.set_config("notify", args.value == "on")
        print(f"notify: {args.value}")
        return 0
    if cmd == "take":
        print(take_card(args.card, args.board or None, settings(), lane))
        return 0
    return 2
