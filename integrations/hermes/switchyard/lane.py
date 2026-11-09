"""Kanban lane: cards assigned to the lane's assignee (default `switchyard`) run as omp sessions.

Hermes's dispatcher leaves cards whose assignee is not a Hermes profile in `ready`
(`skipped_nonspawnable`). On every dispatch tick this lane claims them with Hermes's own kanban API,
resolves the workspace the way a Hermes worker would (worktree on the card's branch, dir, scratch,
or the board/project folder for scratch cards), queues an omp session there with `switchyard new --task`
(so omp's global concurrency limit applies), and then mirrors the session onto the card: heartbeat
while it is queued or works, `needs_input` block while it waits on a question or approval, `complete`
with its final reply, `transient` block when it fails, stops, is interrupted (host crash or reboot) or
is removed.

Cards are also a way to talk to the session from clients that only show kanban (Hermes Console on
Android): a comment on a linked card from a trusted author (the board's `comment_authors`, default
`dashboard`) answers omp's open question or reaches the session as a message marked as a kanban
comment from that author, and `@switchyard` from a trusted author on any card of a lane board assigns that
card to the lane. Approval dialogs are never answered from comments. A comment that can't be
delivered is retried on later passes (a few times) instead of being dropped. With `archive_completed`
on (the lane's or the board's setting), a card the lane completes is archived on the board right away,
together with its omp session.

Card <-> session links and the lane's lock are machine-wide (store.lane_data_dir, beside the shared
kanban boards), so several profiles' gateways never run two lane passes at once; before creating a
session the lane also looks for an omp session tagged `card:<id>`, so a card never gets two sessions
(restarts, crashes, two processes).
"""

from __future__ import annotations

import logging
import os
import re
import socket
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from .switchyard import USAGE_EXIT, Switchyard, SwitchyardError, edge_mark, edges_of, error_text, is_approval, short
from .settings import ANY_AUTHOR, BoardLane, Settings, archive_completed, board_lane
from .store import Busy, Store

log = logging.getLogger(__name__)

AUTHOR = "switchyard"
# The claim is renewed (heartbeat_claim) every tick; this only matters while the gateway is down.
CLAIM_TTL_S = 2 * 3600
# heartbeat_worker adds an event to the card; once in a while is enough (stale detection is hourly).
WORKER_HEARTBEAT_S = 10 * 60
NOTES_MAX = 19_000
RESULT_MAX = 20_000
SUMMARY_MAX = 4_000
MAX_NEW_PER_TICK = 4
# Lane passes that try to pass a card's comments to its session before giving up on them.
MAX_SEND_TRIES = 5
# Lane passes a finished session may wait for its reply to become final (`replyPending`: AO flags the last
# assistant message a moment after the turn ends) before the card completes without one: a tool-only or failed
# turn never gets a reply, so this is bounded.
REPLY_WAIT_PASSES = 3
# Session states in which card comments wait: the card's queued task hasn't (re)started yet.
HOLD_STATES = ("queued", "scheduled", "starting", "interrupted")
# `switchyard answer` failures that only mean the dialog changed meanwhile (look again next pass).
QUESTION_MOVED = re.compile(r"question changed|not waiting for an answer|no question is waiting", re.IGNORECASE)
WHERE_TO_ANSWER = "VS Code, the Agent Orchestrator app or AO Mobile, the Switchyard page"


def claimer_id() -> str:
    """Stable claim lock (host prefix like Hermes's own), so a gateway restart can renew it."""
    return f"{socket.gethostname()}:switchyard"


def link_key(board: str, card: str) -> str:
    return f"{board}/{card}"


def clip(text: str, limit: int) -> str:
    text = text.strip()
    return text if len(text) <= limit else f"{text[:limit].rstrip()}\n… (clipped)"


def one_line(text: str, limit: int = 200) -> str:
    line = next((l.strip() for l in text.splitlines() if l.strip()), "")
    return line if len(line) <= limit else f"{line[: limit - 1]}…"


def last_comment_id(conn: Any, card_id: str) -> int:
    from hermes_cli import kanban_db as kb

    return max((c.id for c in kb.list_comments(conn, card_id)), default=0)


def mentions(assignee: str) -> re.Pattern[str]:
    """`@switchyard` (the lane's assignee) as a word, not inside an e-mail address or `@@switchyard`."""
    return re.compile(rf"(?<![\w@])@{re.escape(assignee)}(?![\w-])", re.IGNORECASE)


# ---------- pure: prompt ----------


def compose_notes(
    *,
    board: str,
    card_id: str,
    context: str,
    skills: list[tuple[str, Optional[str]]],
) -> str:
    """The queued task's notes (omp gets them under the card title): what the session is for, the
    card's worker context as Hermes builds it for its own workers (body, parent results, comments),
    and the SKILL.md files of the card's skills. They name no folder or branch: AO runs the session in
    its own worktree, and a path here would send omp's edits into the folder the lane started from."""
    head = [
        f"This omp session works on Hermes kanban card {board}/{card_id}.",
        "The switchyard plugin reports back to the card on its own: your final reply becomes the card's result "
        "(and the input of cards that depend on it), and questions or approvals you ask show up on the card. "
        "You don't need any kanban tools.",
    ]
    tail: list[str] = []
    if skills:
        tail += ["", "## Skills", "The card asks for these skills. Read each SKILL.md before you start and follow it:"]
        for name, path in skills:
            tail.append(f"- {name}: {path}" if path else f"- {name}: (not found on this machine)")
    tail += ["", "Finish with a reply that sums up what you did and what is left; it is what the card records."]
    fixed = "\n".join(head) + "\n\n" + "\n".join(tail)
    room = max(1000, NOTES_MAX - len(fixed))
    return "\n".join(head) + "\n\n" + clip(context, room) + "\n" + "\n".join(tail)


def valid_skill_name(name: str) -> bool:
    """A card's skill name is a folder name: never a path (`/`, `\\`, `..`)."""
    return bool(name) and "/" not in name and "\\" not in name and ".." not in name


def find_skill(name: str, roots: list[Path]) -> Optional[str]:
    """SKILL.md of skill `name` under the skill roots (nested category folders allowed)."""
    if not valid_skill_name(name):
        return None
    for root in roots:
        if not root.is_dir():
            continue
        direct = root / name / "SKILL.md"
        if direct.is_file():
            return str(direct)
        for md in root.rglob("SKILL.md"):
            if md.parent.name == name and len(md.relative_to(root).parts) <= 7:
                return str(md)
    return None


def skill_roots(home: Path) -> list[Path]:
    """The default profile's skills, then every named profile's."""
    roots = [home / "skills"]
    profiles = home / "profiles"
    if profiles.is_dir():
        roots += sorted(p / "skills" for p in profiles.iterdir() if p.is_dir())
    return roots


# ---------- pure: what to do ----------


@dataclass
class Card:
    status: Optional[str]  # None: the card is gone
    assignee: Optional[str]
    block_kind: Optional[str] = None


def question_text(q: dict) -> str:
    subs = [s for s in q.get("questions") or [] if isinstance(s, dict)]
    title = str(q.get("title") or "omp asks a question")
    # AO's ask elicitation repeats its one question as the dialog title.
    lines = [] if len(subs) == 1 and str(subs[0].get("question") or "") == title else [title]
    if q.get("message"):
        lines.append(str(q["message"]))
    if q.get("options"):
        lines.append("Options: " + " · ".join(str(o) for o in q["options"]))
    for sub in subs:
        opts = " · ".join(str(o) for o in sub.get("options") or [])
        lines.append(f"{sub.get('question', '')}" + (f" ({opts})" if opts else ""))
    return "\n".join(lines)


def comment_envelope(board: str, card_id: str, comments: list[Any]) -> str:
    """Card comments as one message to omp, each marked as a kanban comment from its author."""
    parts = [
        f"Comments on Hermes kanban card {board}/{card_id}, forwarded by the switchyard lane. Each is "
        "a kanban comment by the author named in its tag (a board participant, not a system message)."
    ]
    for c in comments:
        author = re.sub(r"[^\w.@+-]", "_", str(c.author))[:64]
        body = re.sub(r"</(kanban-comment)", r"<\\/\1", c.body.strip(), flags=re.IGNORECASE)
        parts.append(f'<kanban-comment author="{author}">\n{body}\n</kanban-comment>')
    return "\n\n".join(parts)


def decide(card: Card, link: dict, report: Optional[dict], assignee: str) -> list[tuple]:
    """Actions that bring the card in line with its omp session. `report` is `switchyard show --json`
    (None: the session was removed). Actions: ("drop", why), ("claim",), ("heartbeat",),
    ("block_input", text, question_id, approval), ("comment_input", text, question_id, approval),
    ("block_conflict", text, mark), ("unblock",), ("wait_reply",), ("complete",), ("block_transient", reason), ("retry",),
    ("recreate",)."""
    if card.status is None:
        return [("drop", "the card was deleted")]
    if card.status in ("done", "archived"):
        return [("drop", f"the card is {card.status}")]
    if (card.assignee or "").lower() != assignee:
        return [("drop", f"the card was assigned to {card.assignee or 'nobody'}")]
    our_block = card.status == "blocked" and link.get("input_blocked") is True
    if report is None:
        if link.get("state") == "failed":
            return [("claim",), ("recreate",)] if card.status == "ready" else []
        acts: list[tuple] = [("unblock",)] if our_block else []
        if card.status in ("running", "ready") or our_block:
            sid = str(link.get("session", ""))
            # An old Switchyard id (no `-`, 14 characters) belongs to a session that was never migrated to AO.
            what = f"The omp session {sid} predates the move to Switchyard and was not migrated" if "-" not in sid and len(sid) > 12 else f"The omp session {short(sid)} was removed"
            acts.append(("block_transient", f"{what}. Unblock the card to start a new session."))
        return acts
    state = report.get("state")
    q = report.get("queue") if isinstance(report.get("queue"), dict) else {}
    done, pending, running, total = (int(q.get(k) or 0) for k in ("done", "pending", "running", "total"))
    finished = done >= 1 and pending == 0 and running == 0
    if state in ("idle", "stopped") and finished:
        # The CLI omits `reply` while the last turn's reply is not final (`replyPending`) rather than giving the
        # previous turn's text: completing now would record no result, or a half one.
        if report.get("replyPending") is True and not str(report.get("reply") or "").strip() and int(link.get("reply_waits") or 0) < REPLY_WAIT_PASSES:
            return [("wait_reply",)]
        return [("complete",)]
    if link.get("state") == "failed":
        return [("claim",), ("retry",)] if card.status == "ready" else []
    # A parent's changes that don't merge (GRAPH-PROPAGATION.md) need a person, like a question.
    conflict = next((e for e in upstream_edges(report) if e.get("state") == "conflict"), None)
    if conflict is not None:
        mark = f"conflict:{edge_mark(conflict)}"
        if mark in (link.get("asked") or []):
            return [("claim",)] if card.status == "ready" else []
        acts = [("claim",)] if card.status == "ready" else []
        if card.status in ("running", "ready") and card.block_kind != "needs_input":
            acts.append(("block_conflict", conflict_text(conflict), mark))
        return acts
    if state == "needs_input":
        acts = [("claim",)] if card.status == "ready" else []
        question = report.get("question") if isinstance(report.get("question"), dict) else {}
        qid = str(question.get("id") or "")
        if qid and qid not in (link.get("asked") or []):
            text = question_text(question)
            # A second needs_input block on one card sends it to triage (Hermes's unblock-loop
            # guard), where nothing can complete it: later questions become comments.
            kind = "block_input" if card.status in ("running", "ready") and card.block_kind != "needs_input" else "comment_input"
            acts.append((kind, text, qid, is_approval(question)))
        return acts
    failed_task = state == "idle" and pending == 0 and running == 0 and total > done
    if state in ("stopped", "interrupted") or failed_task:
        if failed_task:
            why, reason = "The omp session's task failed", report.get("reply")
        elif state == "interrupted":
            why, reason = "The omp session was interrupted (its process ended without finishing: a crash, reboot or kill)", report.get("exitReason")
        else:
            why, reason = "The omp session stopped before finishing", report.get("exitReason")
        reason = one_line(str(reason or ""), 500)
        acts = [("unblock",)] if our_block else []
        if card.status in ("running", "ready") or our_block:
            acts.append(("block_transient", f"{why}{': ' + reason if reason else '.'} Unblock the card to continue it in the same session."))
        return acts
    # queued, scheduled, starting, working, or idle with an interrupted task the user will pick up.
    if our_block:
        return [("unblock",), ("claim",)]
    if card.status == "ready":
        return [("claim",)]
    if card.status == "running":
        return [("heartbeat",)]
    return []


def upstream_edges(report: Optional[dict]) -> list[dict]:
    """The report's parent edges (`upstream` in `show --json`; GRAPH-PROPAGATION.md)."""
    return edges_of((report or {}).get("upstream"))


def conflict_text(edge: dict) -> str:
    files = [f for f in edge.get("files") or [] if isinstance(f, str)]
    parent = short(str(edge.get("parentSession") or edge.get("parent") or "?"))
    listed = ", ".join(files[:20]) + (f" … {len(files) - 20} more" if len(files) > 20 else "")
    return (
        f"The changes of parent omp session {parent} don't merge cleanly into this card's worktree"
        + (f" ({listed})" if listed else "")
        + ". Resolve the merge in the omp session (a comment on this card reaches it), then the lane picks the card up again."
    )


def capacity(sched: dict) -> int:
    """How many more cards to claim now: omp's free concurrency slots (scheduler.json limit)."""
    if sched.get("paused") is True:
        return 0
    limit = int(sched.get("maxConcurrent") or 0)
    if limit <= 0:
        return MAX_NEW_PER_TICK
    used = int(sched.get("running") or 0) + int(sched.get("waiting") or 0)
    return max(0, min(MAX_NEW_PER_TICK, limit - used))


# ---------- the lane ----------


class Lane:
    def __init__(self, store: Store, settings: Callable[[], Settings], omp: Callable[[], Switchyard]) -> None:
        self.store = store
        self.settings = settings
        self.omp = omp
        # {child session: parent edges} of this pass (`plan status`), put into each tracked session's report.
        self._upstream: dict[str, list[dict]] = {}

    # -- plugin state --

    def links(self) -> dict[str, dict]:
        v = self.store.get("links", {})
        return v if isinstance(v, dict) else {}

    def _save(self, links: dict[str, dict]) -> None:
        self.store.set("links", links)

    def _status(self, board: str, **fields: Any) -> None:
        st = self.store.get("lane_status", {})
        st = st if isinstance(st, dict) else {}
        st[board] = {"at": time.time(), **fields}
        self.store.set("lane_status", st)

    def ticks(self) -> dict[str, dict]:
        """Last pass per board, for boards that are still open (archived or deleted boards drop out)."""
        from hermes_cli import kanban_db as kb

        st = self.store.get("lane_status", {})
        st = st if isinstance(st, dict) else {}
        try:
            open_boards = {b.get("slug") for b in kb.list_boards(include_archived=False)}
        except Exception:
            return st
        return {slug: t for slug, t in st.items() if slug in open_boards}

    def heartbeat(self, board: Optional[str], *, profile: str, lane_on: bool) -> None:
        """Records that the kanban dispatcher ticked this plugin (machine-wide, so every profile's
        `hermes switchyard status` and page can tell where the dispatcher runs and whether the lane is there)."""
        self.store.set(
            "dispatcher",
            {"at": time.time(), "pid": os.getpid(), "profile": profile, "lane_on": lane_on, "board": board},
        )

    def dispatcher(self) -> Optional[dict]:
        v = self.store.get("dispatcher")
        return v if isinstance(v, dict) else None

    # -- entry point --

    def tick(self, board: Optional[str]) -> None:
        """One pass over one board (the dispatch-tick hook fires once per board)."""
        from hermes_cli import kanban_db as kb

        slug = board or kb.DEFAULT_BOARD
        try:
            with self.store.lock("lane", blocking=False):
                self._tick(slug)
        except Busy:
            log.debug("Switchyard lane: another process is on board %s", slug)
        except Exception as exc:  # never break the dispatcher
            log.warning("Switchyard lane: board %s: %s", slug, exc, exc_info=True)
            try:
                self._status(slug, error=str(exc))
            except Exception:
                pass

    def _tick(self, slug: str) -> None:
        from hermes_cli import kanban_db as kb
        from hermes_cli import kanban_db_connect as kbc

        settings = self.settings()
        links = self.links()
        mine = [k for k, l in links.items() if l.get("board") == slug]
        board_name = next((b.get("name") for b in kb.list_boards(include_archived=True) if b.get("slug") == slug), None)
        cfg = board_lane(settings, slug, board_name)
        if not mine and cfg is None:
            return
        omp = self.omp()
        self._upstream = omp.upstream_by_session()
        errors: list[str] = []
        started: list[str] = []
        with kbc.connect_closing(board=slug) as conn:
            for key in mine:
                try:
                    self._track(conn, slug, links, key, cfg, settings, omp)
                except Exception as exc:
                    log.warning("Switchyard lane: %s: %s", key, exc, exc_info=True)
                    errors.append(f"{key}: {exc}")
                self._save(links)
            if cfg is not None:
                try:
                    self._mentions(conn, slug, links, cfg)
                except Exception as exc:
                    log.warning("Switchyard lane: mentions on %s: %s", slug, exc, exc_info=True)
                    errors.append(f"mentions: {exc}")
                free = capacity(omp.scheduler())
                for task in kb.list_tasks(conn, assignee=cfg.assignee, status="ready"):
                    if free <= 0:
                        break
                    key = link_key(slug, task.id)
                    if key in links:
                        continue
                    try:
                        if self._start(conn, slug, links, task, cfg, settings, omp):
                            started.append(task.id)
                            free -= 1
                    except Exception as exc:
                        log.warning("Switchyard lane: %s: %s", key, exc, exc_info=True)
                        errors.append(f"{key}: {exc}")
                    self._save(links)
                try:
                    self._upstream_notes(conn, slug, omp)
                except SwitchyardError as exc:  # e.g. a CLI without `plan status`
                    log.debug("Switchyard lane: plan status on %s: %s", slug, exc)
        self._status(slug, started=started, error="; ".join(errors) or None)

    def _upstream_notes(self, conn: Any, slug: str, omp: Switchyard) -> None:
        """A done card whose parent card changed afterwards (edge state upstream-changed,
        GRAPH-PROPAGATION.md): the planner merged the change into its worktree but doesn't re-run it, so
        say so once on the card, with how to re-run it."""
        from hermes_cli import kanban_db as kb

        edges = [e for es in self._upstream.values() for e in es if e.get("state") == "upstream-changed"]
        if not edges:
            return
        cards = {sid: card for card, sid in self._card_sessions(omp, slug).items()}
        noted = self.store.get("upstream_noted", [])
        noted = noted if isinstance(noted, list) else []
        for e in edges:
            child = str(e.get("childSession") or "")
            card = cards.get(child)
            mark = f"{child}:{edge_mark(e)}"
            if not card or mark in noted:
                continue
            parent = str(e.get("parentSession") or "")
            what = f"card {cards[parent]}" if parent in cards else f"omp session {short(parent)}"
            kb.add_comment(
                conn,
                card,
                AUTHOR,
                f"Parent {what} changed after this card was done. Its changes are merged into omp session {short(child)}'s worktree, "
                f"but this card's task was not run again. To re-run it with them: `switchyard plan sync {short(child)} --rerun`, "
                f"the Switchyard page (Re-run with parent changes), or ask Hermes (switchyard_plan_sync with rerun).",
            )
            noted.append(mark)
        self.store.set("upstream_noted", noted[-500:])

    def _card_sessions(self, omp: Switchyard, slug: str) -> dict[str, str]:
        """{card id: omp session id} of the board's cards, from the sessions' `hermes:<board>` + `card:<id>` tags."""
        out: dict[str, str] = {}
        for s in omp.sessions(all=True):
            tags = s.get("tags") if isinstance(s.get("tags"), list) else []
            meta = s.get("meta") if isinstance(s.get("meta"), dict) else {}
            if f"hermes:{slug}" in tags and meta.get("id"):
                for t in tags:
                    if isinstance(t, str) and t.startswith("card:"):
                        out[t[5:]] = str(meta["id"])
        return out

    # -- new cards --

    def _start(self, conn: Any, slug: str, links: dict, task: Any, cfg: BoardLane, settings: Settings, omp: Switchyard) -> bool:
        from hermes_cli import kanban_db as kb

        key = link_key(slug, task.id)
        existing = self._tagged_session(omp, slug, task.id)
        claimed = kb.claim_task(conn, task.id, ttl_seconds=CLAIM_TTL_S, claimer=claimer_id())
        if claimed is None:
            return False  # someone else got it, or a parent is open again
        link: dict[str, Any] = {"board": slug, "card": task.id, "title": task.title, "assignee": cfg.assignee, "state": "active", "asked": [], "created_at": time.time()}
        if existing:
            link.update(session=existing["meta"]["id"], cwd=existing["meta"].get("cwd"), comment_seen=last_comment_id(conn, task.id))
            links[key] = link
            log.info("Switchyard lane: %s re-linked to existing session %s", key, short(link["session"]))
            return True
        try:
            cwd, branch = self._workspace(conn, slug, claimed, cfg, settings)
        except Exception as exc:
            kb.block_task(conn, task.id, reason=f"Switchyard lane could not prepare the workspace: {exc}", kind="transient")
            return False
        link.update(cwd=cwd, branch=branch)
        links[key] = link
        self._save(links)  # before the session exists: a crash now must not lose the claim's owner
        self._create(conn, slug, link, claimed, cfg, omp)
        return True

    def _tagged_session(self, omp: Switchyard, slug: str, card_id: str) -> Optional[dict]:
        want = {f"card:{card_id}", f"hermes:{slug}"}
        for s in omp.sessions(all=True):
            tags = s.get("tags") if isinstance(s.get("tags"), list) else []
            if want.issubset(set(tags)) and isinstance(s.get("meta"), dict):
                return s
        return None

    def _workspace(self, conn: Any, slug: str, task: Any, cfg: BoardLane, settings: Settings) -> tuple[str, Optional[str]]:
        """(cwd, branch) the way Hermes's dispatcher prepares a worker; scratch cards run in the
        project's or board's folder when one is configured."""
        from hermes_cli import kanban_db_workspace as kbw

        kind = task.workspace_kind or "scratch"
        if kind == "worktree":
            path, branch = kbw._resolve_worktree_workspace(task, board=slug)
            kbw.set_workspace_path(conn, task.id, str(path))
            branch = branch or (task.branch_name or "").strip() or f"wt/{task.id}"
            kbw.set_branch_name(conn, task.id, branch)
            return str(path), branch
        if kind == "scratch":
            folder = project_folder(getattr(task, "project_id", None), settings) or cfg.folder
            if folder:
                folder = os.path.expanduser(folder)
                if not os.path.isdir(folder):
                    raise ValueError(f"folder {folder} does not exist")
                return folder, None
        path = kbw.resolve_workspace(task, board=slug)
        kbw.set_workspace_path(conn, task.id, str(path))
        return str(path), None

    def _create(self, conn: Any, slug: str, link: dict, task: Any, cfg: Optional[BoardLane], omp: Switchyard) -> None:
        from hermes_cli import kanban_db as kb
        from hermes_constants import get_hermes_home

        try:
            context = kb.build_worker_context(conn, task.id)
        except Exception as exc:
            context = f"# Kanban task {task.id}: {task.title}\n\n## Body\n{task.body or '(empty)'}\n\n(worker context unavailable: {exc})"
        roots = skill_roots(Path(get_hermes_home()))
        skills = [(name, find_skill(name, roots)) for name in (task.skills or [])]
        notes = compose_notes(board=slug, card_id=task.id, context=context, skills=skills)
        # Parent cards that ran in the lane become the session's `after`, so the planner starts this
        # card's worktree from their branches and later propagates their changes (GRAPH-PROPAGATION.md).
        try:
            parents = kb.parent_ids(conn, task.id)
        except Exception:
            parents = []
        by_card = self._card_sessions(omp, slug) if parents else {}
        after = [by_card[p] for p in parents if p in by_card]
        try:
            res = omp.new(
                link["cwd"],
                task=task.title,
                notes=notes,
                title=task.title,
                mode=cfg.mode if cfg else None,
                tags=["hermes", f"hermes:{slug}", f"card:{task.id}"],
                group=cfg.group if cfg else None,
                model=card_model(task) or (cfg.model if cfg else None),
                after=after,
            )
        except SwitchyardError as exc:
            link["state"] = "failed"
            link["error"] = str(exc)
            kb.block_task(conn, task.id, reason=f"Switchyard lane could not start a session: {exc}", kind="transient")
            return
        sid = str(res["id"])
        link.update(session=sid, state="active", asked=[], heartbeat_at=time.time())
        link.pop("error", None)
        log.info("Switchyard lane: %s/%s -> omp session %s in %s", slug, task.id, short(sid), link["cwd"])
        trusted = (cfg or board_lane_fallback(self.settings(), slug)).comment_authors
        authors = "anyone" if ANY_AUTHOR in trusted else ", ".join(trusted) or "nobody (comments are off)"
        link["comment_seen"] = kb.add_comment(
            conn,
            task.id,
            AUTHOR,
            # Where omp really works: AO's worktree for the session, not the folder the lane gave it.
            f"Queued as omp session {short(sid)} in {res.get('cwd') or link['cwd']}"
            + (f" (branch {link['branch']})" if link.get("branch") and res.get("cwd") in (None, link["cwd"]) else "")
            + f". It starts when omp has a free slot. Follow or steer it in {WHERE_TO_ANSWER}, or with `switchyard attach {short(sid)}`; "
            f"comments here by {authors} reach the session too. This card is updated when it finishes or needs input.",
        )

    def _mentions(self, conn: Any, slug: str, links: dict, cfg: BoardLane) -> None:
        """`@switchyard` in a comment assigns the card to the lane: the way to hand a card to omp from Hermes
        Console, whose assignee picker only lists Hermes profiles. Watermark per board (comment row id)."""
        from hermes_cli import kanban_db as kb

        marks = self.store.get("mention_seen", {})
        marks = marks if isinstance(marks, dict) else {}
        top = int(conn.execute("SELECT COALESCE(MAX(id), 0) FROM task_comments").fetchone()[0])
        seen = marks.get(slug)
        if not isinstance(seen, int) or seen > top:  # first pass on this board, or the board was recreated
            marks[slug] = top
            self.store.set("mention_seen", marks)
            return
        if seen == top:
            return
        pattern = mentions(cfg.assignee)
        rows = conn.execute("SELECT id, task_id, author, body FROM task_comments WHERE id > ? ORDER BY id", (seen,)).fetchall()
        for row in rows:
            marks[slug] = int(row["id"])
            card_id, author = str(row["task_id"]), str(row["author"])
            if author == AUTHOR or not pattern.search(str(row["body"])) or link_key(slug, card_id) in links:
                continue
            if not cfg.trusts(author):
                log.info("Switchyard lane: %s/%s: ignored @%s from %s (not a trusted comment author)", slug, card_id, cfg.assignee, author)
                continue
            task = kb.get_task(conn, card_id)
            if task is None or task.status in ("done", "archived") or (task.assignee or "").lower() == cfg.assignee:
                continue
            try:
                kb.assign_task(conn, card_id, cfg.assignee)
            except RuntimeError as exc:  # a Hermes worker runs it under a claim
                kb.add_comment(conn, card_id, AUTHOR, f"Couldn't assign this card to {cfg.assignee}: {exc}")
                continue
            when = "now" if task.status == "ready" else f"once the card is ready (it is {task.status})"
            kb.add_comment(conn, card_id, AUTHOR, f"Assigned to {cfg.assignee} because {author} mentioned @{cfg.assignee}. The Switchyard lane runs it as an omp session {when}.")
            log.info("Switchyard lane: %s/%s assigned to %s by a mention from %s", slug, card_id, cfg.assignee, author)
        self.store.set("mention_seen", marks)

    # -- linked cards --

    def _track(self, conn: Any, slug: str, links: dict, key: str, cfg: Optional[BoardLane], settings: Settings, omp: Switchyard) -> None:
        from hermes_cli import kanban_db as kb

        link = links[key]
        task = kb.get_task(conn, link["card"])
        # The assignee the card was claimed for: links are shared by every profile running the
        # plugin, and another profile's lane settings may differ.
        assignee = link.get("assignee") or (cfg.assignee if cfg else settings.lane.assignee)
        card = Card(task.status if task else None, task.assignee if task else None, getattr(task, "block_kind", None) if task else None)
        if not link.get("session"):
            if card.status in ("done", "archived", None) or (card.assignee or "").lower() != assignee:
                links.pop(key)
                return
            if card.status == "ready":
                task = kb.claim_task(conn, link["card"], ttl_seconds=CLAIM_TTL_S, claimer=claimer_id()) or task
            if task and task.status == "running":
                existing = self._tagged_session(omp, slug, link["card"])
                if existing:
                    link.update(session=existing["meta"]["id"], state="active")
                else:
                    if not link.get("cwd"):
                        link["cwd"], link["branch"] = self._workspace(conn, slug, task, cfg or board_lane_fallback(settings, slug), settings)
                    self._create(conn, slug, link, task, cfg, omp)
            return
        report = omp.show(link["session"])
        if report is not None and "upstream" not in report:
            report["upstream"] = self._upstream.get(str(link["session"]), [])
        if self._forward_comments(conn, link, report, omp, cfg or board_lane_fallback(settings, slug)):
            return  # the session got something new: look at it again next tick
        for act in decide(card, link, report, assignee):
            self._apply(conn, slug, links, key, link, act, report, cfg, omp)
            if key not in links:
                return

    def _forward_comments(self, conn: Any, link: dict, report: Optional[dict], omp: Switchyard, cfg: BoardLane) -> bool:
        """New comments on the card by trusted authors (cfg.comment_authors) go to the omp session: while
        omp waits on a question they are tried as its answer in order (one that doesn't fit is
        reported and the next one tried), the rest arrive as one message (a follow-up while omp works).
        Approval dialogs are never answered from here: comments wait until the approval is given
        elsewhere. Held until the card's queued task runs, so they never run ahead of it or of omp's
        concurrency limit. `comment_seen` only moves past comments that were delivered (or given up on
        after MAX_SEND_TRIES passes). True when something was sent."""
        from hermes_cli import kanban_db as kb

        card_id, sid = link["card"], str(link["session"])
        seen = link.get("comment_seen")
        if not isinstance(seen, int):  # linked before comments were forwarded: only newer ones count
            link["comment_seen"] = last_comment_id(conn, card_id)
            return False
        state = report.get("state") if report else None
        q = report.get("queue") if report and isinstance(report.get("queue"), dict) else {}
        if state in HOLD_STATES or (int(q.get("running") or 0) == 0 and int(q.get("done") or 0) == 0 and int(q.get("pending") or 0) > 0):
            return False
        new = kb.list_comments_after(conn, card_id, after_id=seen)
        if not new:
            return False
        last = new[-1].id
        theirs = []
        for c in new:
            if c.author == AUTHOR or not c.body.strip():
                continue
            if cfg.trusts(c.author):
                theirs.append(c)
            else:
                self._untrusted(conn, link, c.author, cfg)
        if not theirs:
            link["comment_seen"] = last
            return False
        if report is None:
            link["comment_seen"] = last
            kb.add_comment(conn, card_id, AUTHOR, f"omp session {short(sid)} is gone, so that comment went nowhere. Unblock the card to start a new session, then comment again.")
            return False
        question = report.get("question") if state == "needs_input" and isinstance(report.get("question"), dict) else None
        if question and is_approval(question):
            qid = str(question.get("id") or "")
            if link.get("approval_noted") != qid:
                link["approval_noted"] = qid
                kb.add_comment(
                    conn,
                    card_id,
                    AUTHOR,
                    f"omp session {short(sid)} waits for an approval ({one_line(str(question.get('title') or 'a dialog'), 120)}), which card comments can't give. "
                    f"Approve or deny it in {WHERE_TO_ANSWER}, or with `switchyard answer {short(sid)} <choice>`; your comment reaches the session after that.",
                )
            return False
        done: list[str] = []
        refused: list[str] = []
        rest = list(theirs)
        if question:
            while rest:
                c = rest[0]
                try:
                    r = omp.answer(sid, c.body.strip(), str(question.get("id") or "") or None)
                except SwitchyardError as exc:
                    return self._undelivered(conn, link, last, str(exc), refused)
                if r.code == 0:
                    rest.pop(0)
                    link["comment_seen"] = c.id
                    done.append(f"answered omp's question with \"{one_line(c.body, 80)}\"")
                    break
                err = one_line(error_text(r) or f"switchyard answer exited with {r.code}", 300)
                if r.code != USAGE_EXIT:
                    if QUESTION_MOVED.search(err):  # answered elsewhere or a new dialog: look again next pass
                        if refused:
                            kb.add_comment(conn, card_id, AUTHOR, "\n".join(refused))
                        return False
                    return self._undelivered(conn, link, last, err, refused)
                rest.pop(0)
                link["comment_seen"] = c.id
                refused.append(f"omp didn't take \"{one_line(c.body, 80)}\" as an answer ({err}).")
        if rest:
            try:
                omp.send(sid, comment_envelope(link["board"], card_id, rest))
            except SwitchyardError as exc:
                return self._undelivered(conn, link, last, str(exc), refused, done)
            n = "comments" if len(rest) > 1 else "comment"
            done.append(f"passed the {n} on" + (" as a follow-up" if state not in ("idle", "stopped") else ""))
        link["comment_seen"] = last
        link.pop("send_failures", None)
        lines = [f"omp session {short(sid)}: {' and '.join(done)}."] if done else []
        if refused:
            lines += [*refused, f"Reply with one of the options, or answer in {WHERE_TO_ANSWER}, or with `switchyard answer {short(sid)} -- <answer>`."]
        kb.add_comment(conn, card_id, AUTHOR, "\n".join(lines))
        log.info("Switchyard lane: %s/%s: %s", link["board"], card_id, "; ".join(done) or "answer refused")
        return bool(done)

    def _undelivered(self, conn: Any, link: dict, last: int, err: str, refused: list[str], done: Optional[list[str]] = None) -> bool:
        """Comments that couldn't reach the session stay unseen and are retried next pass; after
        MAX_SEND_TRIES passes in a row they are given up on. Says so on the card (once per streak)."""
        from hermes_cli import kanban_db as kb

        sid = short(str(link["session"]))
        tries = int(link.get("send_failures") or 0) + 1
        lines = [f"omp session {sid}: {' and '.join(done)}."] if done else []
        lines += refused
        if tries >= MAX_SEND_TRIES:
            link["comment_seen"] = last
            link.pop("send_failures", None)
            lines.append(f"Gave up passing comments to omp session {sid} after {tries} tries ({one_line(err, 300)}). Comment again once it runs, or use {WHERE_TO_ANSWER}.")
        else:
            link["send_failures"] = tries
            if tries == 1:
                lines.append(f"Couldn't reach omp session {sid} ({one_line(err, 300)}); trying again on the next lane pass.")
        if lines:
            kb.add_comment(conn, link["card"], AUTHOR, "\n".join(lines))
        log.warning("Switchyard lane: %s/%s: comment not delivered (try %d): %s", link["board"], link["card"], tries, err)
        return False

    def _untrusted(self, conn: Any, link: dict, author: str, cfg: BoardLane) -> None:
        """Says once per author and card that their comments don't reach omp."""
        from hermes_cli import kanban_db as kb

        noted = link.get("untrusted_noted") if isinstance(link.get("untrusted_noted"), list) else []
        if author.lower() in noted:
            return
        link["untrusted_noted"] = [*noted, author.lower()]
        kb.add_comment(
            conn,
            link["card"],
            AUTHOR,
            f"Comments by {author} don't reach the omp session: comment authors trusted on this board are {', '.join(cfg.comment_authors) or 'none'} "
            f"(`hermes switchyard board {cfg.slug} --comment-authors …`).",
        )

    def _apply(self, conn: Any, slug: str, links: dict, key: str, link: dict, act: tuple, report: Optional[dict], cfg: Optional[BoardLane], omp: Switchyard) -> None:
        from hermes_cli import kanban_db as kb
        from hermes_cli import kanban_db_dispatch as kbd

        card_id = link["card"]
        kind = act[0]
        if kind == "drop":
            log.info("Switchyard lane: %s no longer tracked (%s); session %s left alone", key, act[1], short(str(link.get("session", ""))))
            links.pop(key, None)
        elif kind == "claim":
            if kb.claim_task(conn, card_id, ttl_seconds=CLAIM_TTL_S, claimer=claimer_id()) is not None:
                link["heartbeat_at"] = time.time()
        elif kind == "wait_reply":
            link["reply_waits"] = int(link.get("reply_waits") or 0) + 1
            kb.heartbeat_claim(conn, card_id, ttl_seconds=CLAIM_TTL_S, claimer=claimer_id())
        elif kind == "heartbeat":
            kb.heartbeat_claim(conn, card_id, ttl_seconds=CLAIM_TTL_S, claimer=claimer_id())
            if time.time() - float(link.get("heartbeat_at") or 0) >= WORKER_HEARTBEAT_S:
                note = f"omp session {short(link['session'])}: {report.get('state') if report else 'working'}"
                if kbd.heartbeat_worker(conn, card_id, note=note):
                    link["heartbeat_at"] = time.time()
        elif kind in ("block_input", "comment_input"):
            sid = short(link["session"])
            how = (
                f"approve or deny in {WHERE_TO_ANSWER}, or with `switchyard answer {sid} <choice>`; card comments can't approve"
                if act[3]
                else f"answer with a comment on this card, in {WHERE_TO_ANSWER}, or with `switchyard answer {sid} -- <answer>`"
            )
            what = "omp asks for approval" if act[3] else "omp needs input"
            if kind == "comment_input":
                kb.add_comment(conn, card_id, AUTHOR, f"{what} again ({how}):\n{act[1]}")
            elif kb.block_task(conn, card_id, reason=f"{what} ({how}):\n{act[1]}", kind="needs_input"):
                link["input_blocked"] = True
            link["asked"] = [*(link.get("asked") or []), act[2]]
        elif kind == "block_conflict":
            if kb.block_task(conn, card_id, reason=act[1], kind="needs_input"):
                link["input_blocked"] = True
            link["asked"] = [*(link.get("asked") or []), act[2]]
        elif kind == "unblock":
            kb.unblock_task(conn, card_id)
            link["input_blocked"] = False
        elif kind == "complete":
            reply = str((report or {}).get("reply") or "").strip() or "(omp finished without a final reply)"
            meta = {
                "omp_session": link["session"],
                "cwd": (report or {}).get("cwd") or link.get("cwd"),
                "changed_files": (report or {}).get("changedFiles"),
                "cost_usd": (report or {}).get("cost"),
            }
            ok = kb.complete_task(conn, card_id, result=clip(reply, RESULT_MAX), summary=clip(reply, SUMMARY_MAX), metadata={k: v for k, v in meta.items() if v is not None})
            after = kb.get_task(conn, card_id)
            if ok or (after and after.status == "done"):
                log.info("Switchyard lane: %s completed from omp session %s", key, short(link["session"]))
                links.pop(key, None)
                if (cfg or board_lane_fallback(self.settings(), slug)).archive_completed:
                    self.archive_card(conn, slug, card_id, [str(link["session"])], omp)
            else:
                link["error"] = "complete refused (are all parents done?)"
        elif kind == "block_transient":
            kb.block_task(conn, card_id, reason=act[1], kind="transient")
            link.update(state="failed", input_blocked=False)
            if report is None:
                link["session_gone"] = True
        elif kind == "retry":
            sid = link["session"]
            omp.ok(["queue", sid, "retry"])
            omp.ok(["queue", sid, "start"])
            if report and report.get("status") == "stopped":
                # The server also starts a stopped session with runnable queued work: a resume that
                # loses that race ("already running") is fine.
                omp.run(["resume", sid])
            link.update(state="active", asked=[], input_blocked=False)
            kb.add_comment(conn, card_id, AUTHOR, f"Retrying in omp session {short(sid)}.")
        elif kind == "recreate":
            task = kb.get_task(conn, card_id)
            if task is None or task.status != "running":
                return
            link.pop("session", None)
            link.pop("session_gone", None)
            self._create(conn, slug, link, task, cfg, omp)

    # -- archiving --

    def archive_card(self, conn: Any, slug: str, card_id: str, sessions: list[str], omp: Switchyard) -> Optional[str]:
        """Archives a done card on Hermes's board and its omp sessions; returns what failed, or None.
        The card is archived even when an omp session can't be (it is then still listed by omp)."""
        from hermes_cli import kanban_db as kb

        failed = []
        if not kb.archive_task(conn, card_id):
            after = kb.get_task(conn, card_id)
            if after is None or after.status != "archived":
                failed.append(f"Hermes refused to archive card {card_id}")
        for sid in sessions:
            try:
                omp.archive(sid)
            except SwitchyardError as exc:
                failed.append(f"omp session {short(sid)}: {exc}")
        if failed:
            log.warning("Switchyard lane: archiving %s/%s: %s", slug, card_id, "; ".join(failed))
            return "; ".join(failed)
        log.info("Switchyard lane: %s/%s archived with omp session(s) %s", slug, card_id, ", ".join(short(s) for s in sessions) or "none")
        return None

    def archive_done(self, slug: str) -> dict:
        """Archives every done lane card on `slug` (`hermes switchyard archive-done`): done cards assigned to the
        lane's assignee or worked by an omp session (tagged `hermes:<slug>` + `card:<id>`), together
        with those sessions. {"archived": [card id], "sessions": [session id], "failed": {card id: why}}."""
        from hermes_cli import kanban_db as kb
        from hermes_cli import kanban_db_connect as kbc

        settings = self.settings()
        assignee = (settings.lane.boards.get(slug, {}).get("assignee") or settings.lane.assignee).lower()
        omp = self.omp()
        by_card: dict[str, list[str]] = {}
        for s in omp.sessions(all=True):
            tags = s.get("tags") if isinstance(s.get("tags"), list) else []
            meta = s.get("meta") if isinstance(s.get("meta"), dict) else {}
            if f"hermes:{slug}" not in tags or not meta.get("id"):
                continue
            for t in tags:
                if isinstance(t, str) and t.startswith("card:"):
                    by_card.setdefault(t[5:], [])
                    if s.get("archived") is not True:
                        by_card[t[5:]].append(str(meta["id"]))
        out: dict[str, Any] = {"archived": [], "sessions": [], "failed": {}}
        with kbc.connect_closing(board=slug) as conn:
            for task in kb.list_tasks(conn, status="done"):
                if (task.assignee or "").lower() != assignee and task.id not in by_card:
                    continue
                sessions = by_card.get(task.id, [])
                err = self.archive_card(conn, slug, task.id, sessions, omp)
                if err:
                    out["failed"][task.id] = err
                else:
                    out["archived"].append(task.id)
                    out["sessions"].extend(sessions)
        return out


def card_model(task: Any) -> Optional[str]:
    """The card's model override (`hermes kanban set-model`) as an omp model selector (provider/model
    when the card names its provider), or None."""
    model = (getattr(task, "model_override", None) or "").strip()
    provider = (getattr(task, "provider_override", None) or "").strip()
    if not model:
        return None
    return f"{provider}/{model}" if provider and "/" not in model else model


def board_lane_fallback(settings: Settings, slug: str) -> BoardLane:
    """Settings for a linked card whose board the lane no longer takes new cards from."""
    e = settings.lane.boards.get(slug, {})
    authors = tuple(e["comment_authors"]) if "comment_authors" in e else settings.lane.comment_authors
    return BoardLane(slug=slug, assignee=settings.lane.assignee, group=slug, mode=settings.lane.mode, model=e.get("model"), comment_authors=authors, archive_completed=archive_completed(settings, slug))


def project_folder(project_id: Optional[str], settings: Settings) -> Optional[str]:
    """Folder of a Hermes project: the plugin's `projects` setting (by id or slug), else the project's
    primary path (or first folder) in Hermes's projects.db."""
    if not project_id:
        return None
    if project_id in settings.projects:
        return settings.projects[project_id]
    try:
        from hermes_cli import projects_db as pdb

        with pdb.connect_closing() as pconn:
            p = pdb.get_project(pconn, project_id)
    except Exception:
        return None
    if p is None:
        return None
    for key in (p.slug, p.name):
        if key in settings.projects:
            return settings.projects[key]
    if p.primary_path:
        return p.primary_path
    return p.folders[0].path if p.folders else None
