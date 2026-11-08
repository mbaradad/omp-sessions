"""Kanban lane: cards assigned to the lane's assignee (default `omp`) run as omp sessions.

Hermes's dispatcher leaves cards whose assignee is not a Hermes profile in `ready`
(`skipped_nonspawnable`). On every dispatch tick this lane claims them with Hermes's own kanban API,
resolves the workspace the way a Hermes worker would (worktree on the card's branch, dir, scratch,
or the board/project folder for scratch cards), queues an omp session there with `omp-vs new --task`
(so omp's global concurrency limit applies), and then mirrors the session onto the card: heartbeat
while it works, `needs_input` block while it waits on a question, `complete` with its final reply,
`transient` block when it fails, stops or is removed.

Cards are also a way to talk to the session from clients that only show kanban (Hermes Console on
Android): a comment on a linked card answers omp's open question or reaches the session as a
message, and `@omp` in a comment on any card of a lane board assigns that card to the lane.

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

from .ompvs import OmpVs, OmpVsError
from .settings import BoardLane, Settings, board_lane
from .store import Busy, Store

log = logging.getLogger(__name__)

AUTHOR = "omp"
# The claim is renewed (heartbeat_claim) every tick; this only matters while the gateway is down.
CLAIM_TTL_S = 2 * 3600
# heartbeat_worker adds an event to the card; once in a while is enough (stale detection is hourly).
WORKER_HEARTBEAT_S = 10 * 60
NOTES_MAX = 19_000
RESULT_MAX = 20_000
SUMMARY_MAX = 4_000
MAX_NEW_PER_TICK = 4


def claimer_id() -> str:
    """Stable claim lock (host prefix like Hermes's own), so a gateway restart can renew it."""
    return f"{socket.gethostname()}:omp-sessions"


def link_key(board: str, card: str) -> str:
    return f"{board}/{card}"


def short(session_id: str) -> str:
    return session_id[:8]


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
    """`@omp` (the lane's assignee) as a word, not inside an e-mail address or `@@omp`."""
    return re.compile(rf"(?<![\w@])@{re.escape(assignee)}(?![\w-])", re.IGNORECASE)


# ---------- pure: prompt ----------


def compose_notes(
    *,
    board: str,
    card_id: str,
    cwd: str,
    branch: Optional[str],
    context: str,
    skills: list[tuple[str, Optional[str]]],
) -> str:
    """The queued task's notes (omp gets them under the card title): what the session is for, the
    card's worker context as Hermes builds it for its own workers (body, parent results, comments),
    and the SKILL.md files of the card's skills."""
    head = [
        f"This omp session works on Hermes kanban card {board}/{card_id}.",
        "The omp-sessions plugin reports back to the card on its own: your final reply becomes the card's result "
        "(and the input of cards that depend on it), and questions or approvals you ask show up on the card. "
        "You don't need any kanban tools.",
        "",
        f"Working folder: {cwd}",
    ]
    if branch:
        head.append(f"Branch: {branch} (a git worktree for this card; commit your work on it)")
    tail: list[str] = []
    if skills:
        tail += ["", "## Skills", "The card asks for these skills. Read each SKILL.md before you start and follow it:"]
        for name, path in skills:
            tail.append(f"- {name}: {path}" if path else f"- {name}: (not found on this machine)")
    tail += ["", "Finish with a reply that sums up what you did and what is left; it is what the card records."]
    fixed = "\n".join(head) + "\n\n" + "\n".join(tail)
    room = max(1000, NOTES_MAX - len(fixed))
    return "\n".join(head) + "\n\n" + clip(context, room) + "\n" + "\n".join(tail)


def find_skill(name: str, roots: list[Path]) -> Optional[str]:
    """SKILL.md of skill `name` under the skill roots (nested category folders allowed)."""
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
    lines = [str(q.get("title") or "omp asks a question")]
    if q.get("message"):
        lines.append(str(q["message"]))
    if q.get("options"):
        lines.append("Options: " + " · ".join(str(o) for o in q["options"]))
    for sub in q.get("questions") or []:
        if isinstance(sub, dict):
            opts = " · ".join(str(o) for o in sub.get("options") or [])
            lines.append(f"{sub.get('question', '')}" + (f" ({opts})" if opts else ""))
    return "\n".join(lines)


def decide(card: Card, link: dict, report: Optional[dict], assignee: str) -> list[tuple]:
    """Actions that bring the card in line with its omp session. `report` is `omp-vs show --json`
    (None: the session was removed). Actions: ("drop", why), ("claim",), ("heartbeat",),
    ("block_input", text, question_id), ("comment_input", text, question_id), ("unblock",),
    ("complete",), ("block_transient", reason), ("retry",), ("recreate",)."""
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
            acts.append(("block_transient", f"The omp session {short(str(link.get('session', '')))} was removed."))
        return acts
    state = report.get("state")
    q = report.get("queue") if isinstance(report.get("queue"), dict) else {}
    done, pending, running, total = (int(q.get(k) or 0) for k in ("done", "pending", "running", "total"))
    finished = done >= 1 and pending == 0 and running == 0
    if state in ("idle", "stopped") and finished:
        return [("complete",)]
    if link.get("state") == "failed":
        return [("claim",), ("retry",)] if card.status == "ready" else []
    if state == "needs_input":
        acts = [("claim",)] if card.status == "ready" else []
        question = report.get("question") if isinstance(report.get("question"), dict) else {}
        qid = str(question.get("id") or "")
        if qid and qid not in (link.get("asked") or []):
            text = question_text(question)
            # A second needs_input block on one card sends it to triage (Hermes's unblock-loop
            # guard), where nothing can complete it: later questions become comments.
            if card.status in ("running", "ready") and card.block_kind != "needs_input":
                acts.append(("block_input", text, qid))
            else:
                acts.append(("comment_input", text, qid))
        return acts
    failed_task = state == "idle" and pending == 0 and running == 0 and total > done
    if state == "stopped" or failed_task:
        reason = report.get("reply") if failed_task else None
        reason = one_line(str(reason or report.get("exitReason") or ""), 500)
        why = "The omp session's task failed" if failed_task else "The omp session stopped before finishing"
        acts = [("unblock",)] if our_block else []
        if card.status in ("running", "ready") or our_block:
            acts.append(("block_transient", f"{why}{': ' + reason if reason else '.'}"))
        return acts
    # starting, queued, working, or idle with an interrupted task the user will pick up.
    if our_block:
        return [("unblock",), ("claim",)]
    if card.status == "ready":
        return [("claim",)]
    if card.status == "running":
        return [("heartbeat",)]
    return []


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
    def __init__(self, store: Store, settings: Callable[[], Settings], omp: Callable[[], OmpVs]) -> None:
        self.store = store
        self.settings = settings
        self.omp = omp

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

    def heartbeat(self, board: Optional[str], *, profile: str, lane_on: bool) -> None:
        """Records that the kanban dispatcher ticked this plugin (machine-wide, so every profile's
        `hermes omp status` and page can tell where the dispatcher runs and whether the lane is there)."""
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
            log.debug("omp lane: another process is on board %s", slug)
        except Exception as exc:  # never break the dispatcher
            log.warning("omp lane: board %s: %s", slug, exc, exc_info=True)
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
        errors: list[str] = []
        started: list[str] = []
        with kbc.connect_closing(board=slug) as conn:
            for key in mine:
                try:
                    self._track(conn, slug, links, key, cfg, settings, omp)
                except Exception as exc:
                    log.warning("omp lane: %s: %s", key, exc, exc_info=True)
                    errors.append(f"{key}: {exc}")
                self._save(links)
            if cfg is not None:
                try:
                    self._mentions(conn, slug, links, cfg)
                except Exception as exc:
                    log.warning("omp lane: mentions on %s: %s", slug, exc, exc_info=True)
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
                        log.warning("omp lane: %s: %s", key, exc, exc_info=True)
                        errors.append(f"{key}: {exc}")
                    self._save(links)
        self._status(slug, started=started, error="; ".join(errors) or None)

    # -- new cards --

    def _start(self, conn: Any, slug: str, links: dict, task: Any, cfg: BoardLane, settings: Settings, omp: OmpVs) -> bool:
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
            log.info("omp lane: %s re-linked to existing session %s", key, short(link["session"]))
            return True
        try:
            cwd, branch = self._workspace(conn, slug, claimed, cfg, settings)
        except Exception as exc:
            kb.block_task(conn, task.id, reason=f"omp lane could not prepare the workspace: {exc}", kind="transient")
            return False
        link.update(cwd=cwd, branch=branch)
        links[key] = link
        self._save(links)  # before the session exists: a crash now must not lose the claim's owner
        self._create(conn, slug, link, claimed, cfg, omp)
        return True

    def _tagged_session(self, omp: OmpVs, slug: str, card_id: str) -> Optional[dict]:
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

    def _create(self, conn: Any, slug: str, link: dict, task: Any, cfg: Optional[BoardLane], omp: OmpVs) -> None:
        from hermes_cli import kanban_db as kb
        from hermes_constants import get_hermes_home

        try:
            context = kb.build_worker_context(conn, task.id)
        except Exception as exc:
            context = f"# Kanban task {task.id}: {task.title}\n\n## Body\n{task.body or '(empty)'}\n\n(worker context unavailable: {exc})"
        roots = skill_roots(Path(get_hermes_home()))
        skills = [(name, find_skill(name, roots)) for name in (task.skills or [])]
        notes = compose_notes(board=slug, card_id=task.id, cwd=link["cwd"], branch=link.get("branch"), context=context, skills=skills)
        try:
            res = omp.new(
                link["cwd"],
                task=task.title,
                notes=notes,
                title=task.title,
                mode=cfg.mode if cfg else None,
                tags=["hermes", f"hermes:{slug}", f"card:{task.id}"],
                group=cfg.group if cfg else None,
            )
        except OmpVsError as exc:
            link["state"] = "failed"
            link["error"] = str(exc)
            kb.block_task(conn, task.id, reason=f"omp lane could not start a session: {exc}", kind="transient")
            return
        sid = str(res["id"])
        link.update(session=sid, state="active", asked=[], heartbeat_at=time.time())
        link.pop("error", None)
        log.info("omp lane: %s/%s -> omp session %s in %s", slug, task.id, short(sid), link["cwd"])
        link["comment_seen"] = kb.add_comment(
            conn,
            task.id,
            AUTHOR,
            f"Queued as omp session {short(sid)} in {link['cwd']}"
            + (f" (branch {link['branch']})" if link.get("branch") else "")
            + f". It starts when omp has a free slot. Watch or steer it in VS Code (omp Sessions), with `omp-vs attach {short(sid)}`, "
            "or in the omp phone app, or comment here: comments reach the session. This card is updated when it finishes or needs input.",
        )

    def _mentions(self, conn: Any, slug: str, links: dict, cfg: BoardLane) -> None:
        """`@omp` in a comment assigns the card to the lane: the way to hand a card to omp from Hermes
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
            task = kb.get_task(conn, card_id)
            if task is None or task.status in ("done", "archived") or (task.assignee or "").lower() == cfg.assignee:
                continue
            try:
                kb.assign_task(conn, card_id, cfg.assignee)
            except RuntimeError as exc:  # a Hermes worker runs it under a claim
                kb.add_comment(conn, card_id, AUTHOR, f"Couldn't assign this card to {cfg.assignee}: {exc}")
                continue
            when = "now" if task.status == "ready" else f"once the card is ready (it is {task.status})"
            kb.add_comment(conn, card_id, AUTHOR, f"Assigned to {cfg.assignee} because {author} mentioned @{cfg.assignee}. The omp lane runs it as an omp session {when}.")
            log.info("omp lane: %s/%s assigned to %s by a mention from %s", slug, card_id, cfg.assignee, author)
        self.store.set("mention_seen", marks)

    # -- linked cards --

    def _track(self, conn: Any, slug: str, links: dict, key: str, cfg: Optional[BoardLane], settings: Settings, omp: OmpVs) -> None:
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
        if self._forward_comments(conn, link, report, omp):
            return  # the session got something new: look at it again next tick
        for act in decide(card, link, report, assignee):
            self._apply(conn, slug, links, key, link, act, report, cfg, omp)
            if key not in links:
                return

    def _forward_comments(self, conn: Any, link: dict, report: Optional[dict], omp: OmpVs) -> bool:
        """New comments on the card from anyone but the lane (Hermes Console, the dashboard, other
        agents) go to the omp session: the first answers omp's open question, the rest arrive as a
        message (a follow-up while omp works). Held until the card's queued task has started, so they
        never run ahead of it or of omp's concurrency limit. True when something was sent."""
        from hermes_cli import kanban_db as kb

        card_id, sid = link["card"], str(link["session"])
        seen = link.get("comment_seen")
        if not isinstance(seen, int):  # linked before comments were forwarded: only newer ones count
            link["comment_seen"] = last_comment_id(conn, card_id)
            return False
        state = report.get("state") if report else None
        q = report.get("queue") if report and isinstance(report.get("queue"), dict) else {}
        if state in ("queued", "starting") or (int(q.get("running") or 0) == 0 and int(q.get("done") or 0) == 0 and int(q.get("pending") or 0) > 0):
            return False
        new = kb.list_comments_after(conn, card_id, after_id=seen)
        if not new:
            return False
        link["comment_seen"] = new[-1].id
        theirs = [c for c in new if c.author != AUTHOR and c.body.strip()]
        if not theirs:
            return False
        if report is None:
            kb.add_comment(conn, card_id, AUTHOR, f"omp session {short(sid)} is gone, so that comment went nowhere. Unblock the card to start a new session, then comment again.")
            return False
        done: list[str] = []
        question = report.get("question") if isinstance(report.get("question"), dict) else None
        if state == "needs_input" and question:
            first, theirs = theirs[0], theirs[1:]
            r = omp.run(["answer", sid, first.body.strip()])
            if r.code != 0:
                err = one_line(r.stderr or r.stdout or f"omp-vs answer exited with {r.code}", 300)
                kb.add_comment(conn, card_id, AUTHOR, f"omp didn't take that as an answer ({err}). Reply with one of the options, or answer in VS Code or the omp phone app.")
                return False
            done.append(f"answered omp's question with \"{one_line(first.body, 80)}\"")
        if theirs:
            busy = state not in ("idle", "stopped")
            text = "\n\n".join(f"{c.author}: {c.body.strip()}" for c in theirs)
            omp.ok(["send", sid, "-", *(["--follow-up"] if busy else [])], stdin=f"New comment on Hermes kanban card {link['board']}/{card_id}:\n{text}", timeout=90)
            n = "comments" if len(theirs) > 1 else "comment"
            done.append(f"passed the {n} on" + (" as a follow-up" if busy else ""))
        kb.add_comment(conn, card_id, AUTHOR, f"omp session {short(sid)}: {' and '.join(done)}.")
        log.info("omp lane: %s/%s: %s", link["board"], card_id, "; ".join(done))
        return True

    def _apply(self, conn: Any, slug: str, links: dict, key: str, link: dict, act: tuple, report: Optional[dict], cfg: Optional[BoardLane], omp: OmpVs) -> None:
        from hermes_cli import kanban_db as kb
        from hermes_cli import kanban_db_dispatch as kbd

        card_id = link["card"]
        kind = act[0]
        if kind == "drop":
            log.info("omp lane: %s no longer tracked (%s); session %s left alone", key, act[1], short(str(link.get("session", ""))))
            links.pop(key, None)
        elif kind == "claim":
            if kb.claim_task(conn, card_id, ttl_seconds=CLAIM_TTL_S, claimer=claimer_id()) is not None:
                link["heartbeat_at"] = time.time()
        elif kind == "heartbeat":
            kb.heartbeat_claim(conn, card_id, ttl_seconds=CLAIM_TTL_S, claimer=claimer_id())
            if time.time() - float(link.get("heartbeat_at") or 0) >= WORKER_HEARTBEAT_S:
                note = f"omp session {short(link['session'])}: {report.get('state') if report else 'working'}"
                if kbd.heartbeat_worker(conn, card_id, note=note):
                    link["heartbeat_at"] = time.time()
        elif kind == "block_input":
            if kb.block_task(conn, card_id, reason=f"omp needs input (answer with a comment on this card, in VS Code, the omp phone app, or `omp-vs answer {short(link['session'])} <choice>`):\n{act[1]}", kind="needs_input"):
                link["input_blocked"] = True
            link["asked"] = [*(link.get("asked") or []), act[2]]
        elif kind == "comment_input":
            kb.add_comment(conn, card_id, AUTHOR, f"omp needs input again (answer with a comment on this card, in VS Code, the omp phone app, or `omp-vs answer {short(link['session'])} <choice>`):\n{act[1]}")
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
                log.info("omp lane: %s completed from omp session %s", key, short(link["session"]))
                links.pop(key, None)
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
                omp.ok(["resume", sid])
            link.update(state="active", asked=[], input_blocked=False)
            kb.add_comment(conn, card_id, AUTHOR, f"Retrying in omp session {short(sid)}.")
        elif kind == "recreate":
            task = kb.get_task(conn, card_id)
            if task is None or task.status != "running":
                return
            link.pop("session", None)
            link.pop("session_gone", None)
            self._create(conn, slug, link, task, cfg, omp)


def board_lane_fallback(settings: Settings, slug: str) -> BoardLane:
    """Settings for a linked card whose board the lane no longer takes new cards from."""
    return BoardLane(slug=slug, assignee=settings.lane.assignee, group=slug, mode=settings.lane.mode)


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
