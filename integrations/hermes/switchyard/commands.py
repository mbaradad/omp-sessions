"""`/switchyard` (sessions summary) and `hermes switchyard …` (status and lane settings)."""

from __future__ import annotations

import argparse
import json
import os
import time
from typing import Any, Callable, Optional, Sequence

from .lane import Lane
from .switchyard import Switchyard, SwitchyardError, agent_state, find_switchyard, short
from .settings import MODES, Settings, board_lane, parse_authors, update_setting
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


def _session_map(omp: Switchyard) -> dict[str, dict]:
    try:
        return {str(s["meta"]["id"]): s for s in omp.sessions(all=True) if isinstance(s.get("meta"), dict)}
    except SwitchyardError:
        return {}


# The dispatcher ticks every ~60 s; quieter than this means it isn't running (or isn't reaching us).
DISPATCHER_STALE_S = 180


def dispatcher_notes(disp: Optional[dict], *, profile: str, lane_on: bool, now: Optional[float] = None) -> list[str]:
    """Problems with where Hermes's kanban dispatcher runs the plugin, for `hermes switchyard status` and the page.

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
                     f"turn it on there (`hermes -p {where} switchyard lane on`) and off here.")
    elif not lane_on and where == profile and disp.get("lane_on") is False:
        notes.append(f"The dispatcher runs in this profile ('{profile}') and the lane is off here: cards assigned to switchyard stay ready.")
    return notes


def status_data(ctx: Any, settings: Settings, store: Store, lane: Lane, omp: Switchyard) -> dict:
    sessions = _session_map(omp)
    links = lane.links()
    try:
        sched: Optional[dict] = omp.scheduler()
    except SwitchyardError:
        sched = None
    cmd = find_switchyard(settings.switchyard)
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
    try:
        omp_info = omp.status().get("omp")
    except SwitchyardError:
        omp_info = None
    return {
        "switchyard": " ".join(cmd) if cmd else None,
        # `status --json` `omp`: installed/authenticated, Switchyard's omp extension (needed for ask/edits/plan), shim.
        "omp": omp_info if isinstance(omp_info, dict) else None,
        "scheduler": sched,
        "notify": settings.notify,
        "last_notification": last_inject if isinstance(last_inject, dict) else None,
        "watches": len(store.get("watches", {}) or {}),
        "profile": profile,
        "dispatcher": disp,
        "dispatcher_notes": dispatcher_notes(disp, profile=profile, lane_on=settings.lane.enabled),
        "agent_approvals": settings.agent_approvals,
        "lane": {
            "enabled": settings.lane.enabled,
            "assignee": settings.lane.assignee,
            "mode": settings.lane.mode,
            "comment_authors": list(settings.lane.comment_authors),
            "archive_completed": settings.lane.archive_completed,
            "boards": settings.lane.boards or "all",
            "ticks": lane.ticks(),
            "state": str(lane.store.state.data_dir),
        },
        "projects": settings.projects,
        "linked": linked,
    }


def _usage_lines(s: Optional[dict]) -> list[str]:
    """What holds queued work back: provider limits in force (with their reset), over-budget windows, held tasks."""
    if not s:
        return []
    now = time.time() * 1000
    out: list[str] = []
    held = int(s.get("held") or 0)
    if held:
        out.append(f"held: {held} task(s) wait on a provider limit, a usage window, the budget or a retry backoff")
    for lim in s.get("limits") or []:
        until = lim.get("until")
        if isinstance(until, (int, float)) and until > now:
            out.append(f"limit: {lim.get('provider')} until {time.strftime('%Y-%m-%d %H:%M', time.localtime(until / 1000))}{' (a guess: the error gave no reset time)' if lim.get('guessed') else ''}")
    budget = s.get("budget") or {}
    if budget:
        spent = {u.get("window"): u for u in s.get("spend") or []}
        parts = []
        for window, cap in budget.items():
            u = spent.get(window) or {}
            parts.append(f"{window} {float(u.get('spent') or 0):.2f}/{cap} USD{' OVER' if u.get('over') else ''}")
        out.append("budget: " + ", ".join(parts))
    return out


def status_text(d: dict) -> str:
    lane = d["lane"]
    lines = [f"switchyard: {d['switchyard'] or 'NOT FOUND (install it with the Switchyard extension: Switchyard: Install switchyard Command, or set the switchyard setting)'}"]
    s = d.get("scheduler")
    if s:
        limit = f"limit {s.get('maxConcurrent')}" if s.get("maxConcurrent") else "no limit"
        lines.append(f"omp scheduler: {s.get('running', 0)} running, {s.get('waiting', 0)} waiting ({limit}{', paused' if s.get('paused') else ''}){'' if s.get('server') else ' · the planner is not running (queued tasks start once switchyard starts it)'}")
    lines.extend(_usage_lines(s))
    ext = (d.get("omp") or {}).get("extension")
    if isinstance(ext, dict) and ext.get("installed") is False:
        lines.append("omp extension: NOT INSTALLED: cards in mode ask, edits or plan can't be started (auto works); install Switchyard's omp extension (open VS Code with Switchyard)")
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
    lines.append(f"trusted comment authors: {', '.join(lane['comment_authors']) or 'none'} · agent answers approvals: {'yes' if d['agent_approvals'] else 'no'} · archive completed cards: {'yes' if lane.get('archive_completed') else 'no'}")
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


def sessions_summary(omp: Switchyard) -> str:
    try:
        infos = omp.sessions(all=False)
    except SwitchyardError as exc:
        return f"switchyard: {exc}"
    if not infos:
        return "No running omp sessions."
    lines = []
    for s in infos:
        m = s.get("meta") or {}
        q = s.get("queue") or {}
        queue = f" · queue {q.get('done', 0)}/{q.get('total', 0)}" if q.get("total") else ""
        group = f" · {s['group']}" if s.get("group") else ""
        lines.append(f"{short(str(m.get('id', '')))}  {agent_state(s):<11} {m.get('title', '')!s:.60}{group}{queue}\n          {m.get('cwd', '')}")
    return "\n".join(lines)


def sessions_brief(omp: Switchyard) -> str:
    """`/switchyard` in a chat: short enough for a phone (Hermes Console shows slash output as a brief notice)."""
    try:
        infos = omp.sessions(all=False)
    except SwitchyardError as exc:
        return f"switchyard: {exc}"
    if not infos:
        return "No running omp sessions."
    by: dict[str, list[dict]] = {}
    for s in infos:
        by.setdefault(agent_state(s), []).append(s)
    labels = (
        ("needs_input", "need you"),
        ("starting", "starting"),
        ("working", "working"),
        ("queued", "queued"),
        ("scheduled", "scheduled"),
        ("interrupted", "interrupted"),
        ("idle", "done"),
        ("stopped", "stopped"),
    )
    lines = [" · ".join(f"{len(by[k])} {label}" for k, label in labels if by.get(k))]
    for s in (by.get("needs_input") or [])[:5]:
        m = s.get("meta") or {}
        lines.append(f"needs you: {short(str(m.get('id', '')))} {m.get('title', '')!s:.60}")
    return "\n".join(lines)


def take_card(card_id: str, board: Optional[str], settings: Settings, lane: Lane) -> str:
    """Assigns a kanban card to the Switchyard lane (`/switchyard take <card> [board]`): the way to route a card to omp
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
            note = f" The Switchyard lane is off in profile {disp.get('profile')}, where the kanban dispatcher runs: `hermes -p {disp.get('profile')} switchyard lane on`."
        else:
            note = " The Switchyard lane starts it as an omp session once it is ready."
        return f"{card_id} on {slug} is assigned to {assignee}.{note}"
    return f"No card {card_id} on {'board ' + board if board else 'any open board'}."


def archive_done_text(slugs: Sequence[str], lane: Lane) -> str:
    """`hermes switchyard archive-done`: archives each board's done lane cards and their omp sessions."""
    lines = []
    for slug in slugs:
        try:
            r = lane.archive_done(slug)
        except SwitchyardError as exc:
            lines.append(f"{slug}: {exc}")
            continue
        n = len(r["archived"])
        lines.append(f"{slug}: archived {n} done card{'' if n == 1 else 's'}" + (f" ({', '.join(r['archived'])})" if n else "") + f" and {len(r['sessions'])} omp session(s)")
        lines.extend(f"  ! {card}: {why}" for card, why in r["failed"].items())
    return "\n".join(lines) or "No boards."


def setup_cli(parser: argparse.ArgumentParser) -> None:
    sub = parser.add_subparsers(dest="omp_cmd")
    st = sub.add_parser("status", help="switchyard, notifications, the kanban lane and linked cards")
    st.add_argument("--json", action="store_true")
    sub.add_parser("sessions", help="running omp sessions")
    lane = sub.add_parser("lane", help="the kanban lane: on, off, run")
    lane_sub = lane.add_subparsers(dest="lane_cmd")
    on = lane_sub.add_parser("on", help="run cards assigned to the assignee as omp sessions")
    on.add_argument("--assignee", help="card assignee the lane takes (default switchyard)")
    on.add_argument("--mode", choices=MODES, help="starting permission mode of card sessions")
    on.add_argument("--board", action="append", default=[], help="only this board (repeatable; default: every board)")
    on.add_argument("--comment-authors", help="comma-separated kanban comment authors whose comments reach omp and whose @switchyard assigns cards (default dashboard; * anyone)")
    on.add_argument("--archive-completed", choices=("on", "off"), help="archive a card and its omp session once the lane completes it (default off)")
    lane_sub.add_parser("off", help="stop taking new cards (linked cards are still reported)")
    run = lane_sub.add_parser("run", help="one lane pass now (normally every dispatcher tick)")
    run.add_argument("--board", action="append", default=[], help="only this board (repeatable)")
    board = sub.add_parser("board", help="per-board lane settings")
    board.add_argument("slug")
    board.add_argument("--folder", help="cwd for cards with a scratch workspace")
    board.add_argument("--group", help="omp group of the board's sessions (default: board name)")
    board.add_argument("--mode", choices=MODES)
    board.add_argument("--assignee")
    board.add_argument("--model", help="model of the board's card sessions, e.g. anthropic/claude-sonnet-4-5 (\"\": Switchyard' default)")
    board.add_argument("--comment-authors", help="comma-separated trusted comment authors on this board (\"\": the lane's list)")
    board.add_argument("--archive-completed", choices=("on", "off", "default"), help="archive this board's cards (and their omp sessions) once the lane completes them (default: the lane's setting)")
    board.add_argument("--remove", action="store_true", help="drop the board from the lane's list")
    project = sub.add_parser("project", help="map a Hermes project (or any name) to a folder")
    project.add_argument("name")
    project.add_argument("folder", nargs="?")
    project.add_argument("--remove", action="store_true")
    notify = sub.add_parser("notify", help="tell Hermes sessions when their omp sessions settle")
    notify.add_argument("value", choices=("on", "off"))
    take = sub.add_parser("take", help="assign a kanban card to the Switchyard lane")
    take.add_argument("card")
    take.add_argument("--board", help="the card's board (default: search every open board)")
    done = sub.add_parser("archive-done", help="archive the done lane cards of a board and their omp sessions")
    done.add_argument("--board", action="append", default=[], help="only this board (repeatable; default: every open board)")


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


def set_lane(*, enabled: bool, assignee: Optional[str] = None, mode: Optional[str] = None, boards: Sequence[str] = (), comment_authors: Optional[str] = None, archive_completed: Optional[bool] = None) -> None:
    """Turns the lane on or off (plus, when turning it on, its assignee, mode, extra boards and
    trusted comment authors)."""

    def change(raw: Any) -> dict:
        lane = _lane(raw)
        lane["enabled"] = enabled
        if assignee:
            lane["assignee"] = assignee.lower()
        if mode:
            lane["mode"] = mode
        if comment_authors is not None:
            lane["comment_authors"] = list(parse_authors(comment_authors) or ())
        if archive_completed is not None:
            lane["archive_completed"] = archive_completed
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
    model: Optional[str] = None,
    comment_authors: Optional[str] = None,
    archive_completed: Optional[str] = None,
    remove: bool = False,
) -> None:
    """Per-board lane settings: None leaves a field alone, "" clears it (comment_authors: back to the
    lane's list; archive_completed, else "on"/"off": back to the lane's setting); `remove` drops the
    board from the lane's list. Raises ValueError for a folder that doesn't exist or an unknown mode."""
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
        for key, value in (("group", group), ("mode", mode), ("assignee", assignee), ("model", model)):
            if value is None:
                continue
            if value.strip():
                entry[key] = value.strip().lower() if key == "assignee" else value.strip()
            else:
                entry.pop(key, None)
        if comment_authors is not None:
            if comment_authors.strip():
                entry["comment_authors"] = list(parse_authors(comment_authors) or ())
            else:
                entry.pop("comment_authors", None)
        if archive_completed is not None:
            if archive_completed in ("on", "off"):
                entry["archive_completed"] = archive_completed == "on"
            else:
                entry.pop("archive_completed", None)
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


def run_cli(args: argparse.Namespace, ctx: Any, settings: Callable[[], Settings], store: Store, omp: Callable[[], Switchyard], lane: Lane) -> int:
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
            set_lane(enabled=True, assignee=args.assignee, mode=args.mode, boards=args.board, comment_authors=args.comment_authors, archive_completed=None if args.archive_completed is None else args.archive_completed == "on")
        elif sub == "off":
            set_lane(enabled=False)
        elif sub == "run":
            from hermes_cli import kanban_db as kb

            slugs = args.board or [b.get("slug") or kb.DEFAULT_BOARD for b in kb.list_boards(include_archived=False)]
            for slug in slugs:
                lane.tick(slug)
        else:
            print("usage: hermes switchyard lane on|off|run")
            return 2
        print(status_text(status_data(ctx, settings(), store, lane, omp())))
        return 0
    if cmd == "board":
        try:
            ac = args.archive_completed
            set_board(args.slug, folder=args.folder or None, group=args.group or None, mode=args.mode or None, assignee=args.assignee or None, model=args.model, comment_authors=args.comment_authors, archive_completed=None if ac is None else "" if ac == "default" else ac, remove=args.remove)
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
    if cmd == "archive-done":
        from hermes_cli import kanban_db as kb

        slugs = args.board or [b.get("slug") or kb.DEFAULT_BOARD for b in kb.list_boards(include_archived=False)]
        print(archive_done_text(slugs, lane))
        return 0
    return 2
