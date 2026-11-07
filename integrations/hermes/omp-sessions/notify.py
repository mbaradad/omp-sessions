"""Tells a Hermes session when an omp session it started settles.

omp_session_start (and send/answer) remember which Hermes session (its route key) asked; the
dispatch-tick hook checks those omp sessions and, once one is idle, needs input, or stopped,
queues a short note into that Hermes session with ctx.inject_message. The note is a normal
message: an idle Hermes session starts a turn on it, a busy one gets it after the current turn.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable, Optional

from .ompvs import OmpVs
from .store import Store

log = logging.getLogger(__name__)

SETTLED = ("idle", "needs_input", "stopped")
# Check at most this often (the hook fires once per board per dispatcher tick).
MIN_INTERVAL_S = 15
# Forget watches nobody could be told about (no gateway, injection not allowed) after this long.
WATCH_MAX_AGE_S = 7 * 24 * 3600
REPLY_EXCERPT = 600


def signature(report: dict) -> str:
    """What makes a settled state new: the state plus the pending question."""
    q = report.get("question") if isinstance(report.get("question"), dict) else {}
    return f"{report.get('state')}:{q.get('id', '')}"


def note_text(report: dict) -> str:
    sid = str(report.get("id", ""))[:8]
    title = report.get("title") or sid
    state = report.get("state")
    lines: list[str] = []
    if state == "needs_input":
        q = report.get("question") if isinstance(report.get("question"), dict) else {}
        lines.append(f'[omp-sessions] omp session "{title}" ({sid}) is waiting for input: {q.get("title") or q.get("kind") or "a question"}')
        if q.get("message"):
            lines.append(str(q["message"]))
        if q.get("options"):
            lines.append("Options: " + " · ".join(str(o) for o in q["options"]))
        lines.append(f"Answer with omp_session_answer (id {sid}), or let the user answer in VS Code or the omp phone app.")
    else:
        what = "finished its turn" if state == "idle" else "stopped"
        lines.append(f'[omp-sessions] omp session "{title}" ({sid}) {what}.')
        reply = str(report.get("reply") or "").strip()
        if reply:
            excerpt = reply if len(reply) <= REPLY_EXCERPT else f"{reply[:REPLY_EXCERPT].rstrip()}…"
            lines += ["Last reply:", excerpt]
        if state == "stopped" and report.get("exitReason"):
            lines.append(f"Reason: {report['exitReason']}")
    lines.append(f"Details: omp_session_status (id {sid}) or `omp-vs show {sid}`.")
    return "\n".join(lines)


class Notifier:
    def __init__(self, store: Store, omp: Callable[[], OmpVs], inject: Callable[..., bool], enabled: Callable[[], bool]) -> None:
        self.store = store
        self.omp = omp
        self.inject = inject
        self.enabled = enabled
        self._last_poll = 0.0

    def _watches(self) -> dict[str, dict]:
        v = self.store.get("watches", {})
        return v if isinstance(v, dict) else {}

    def watch(self, session_id: str, session_key: str, title: str = "") -> None:
        """(Re)arm: tell `session_key` when `session_id` next settles."""
        if not session_key:
            return
        with self.store.lock("watches"):
            w = self._watches()
            w[session_id] = {"session_key": session_key, "title": title, "since": time.time(), "last": None}
            self.store.set("watches", w)

    def seen(self, report: Optional[dict]) -> None:
        """The agent saw this state itself (status/wait): don't inject it again."""
        if not report or report.get("state") not in SETTLED:
            return
        sid = str(report.get("id", ""))
        with self.store.lock("watches"):
            w = self._watches()
            if sid not in w:
                return
            if report.get("state") == "needs_input":
                w[sid]["last"] = signature(report)
            else:
                w.pop(sid)
            self.store.set("watches", w)

    def poll(self, force: bool = False) -> int:
        """Checks watched sessions and injects notes; returns how many were delivered."""
        now = time.time()
        if not force and now - self._last_poll < MIN_INTERVAL_S:
            return 0
        self._last_poll = now
        if not self.enabled():
            return 0
        watches = self._watches()
        if not watches:
            return 0
        omp = self.omp()
        updates: dict[str, Optional[dict]] = {}
        delivered = 0
        for sid, w in watches.items():
            try:
                report = omp.show(sid)
            except Exception as exc:
                log.debug("omp notify: %s: %s", sid, exc)
                continue
            if report is None or now - float(w.get("since") or now) > WATCH_MAX_AGE_S:
                updates[sid] = None
                continue
            if report.get("state") not in SETTLED or signature(report) == w.get("last"):
                continue
            ok = self.inject(note_text(report), session_key=w["session_key"])
            # What `hermes omp status` reports about notifications (no public way to read the
            # allow_gateway_injection consent; a refused injection is the observable symptom).
            self.store.set("last_inject", {"at": now, "ok": ok, "session": sid})
            if not ok:
                continue
            delivered += 1
            updates[sid] = {**w, "last": signature(report)} if report.get("state") == "needs_input" else None
        if updates:
            with self.store.lock("watches"):
                cur = self._watches()
                for sid, value in updates.items():
                    if sid not in cur:
                        continue
                    # Re-armed meanwhile (a new prompt): keep the newer watch.
                    if float(cur[sid].get("since") or 0) > float(watches[sid].get("since") or 0):
                        continue
                    if value is None:
                        cur.pop(sid)
                    else:
                        cur[sid] = value
                self.store.set("watches", cur)
        return delivered


def current_session_key() -> str:
    """Route key of the Hermes session whose turn is calling us ("" outside one)."""
    try:
        from gateway.session_context import get_session_env

        return get_session_env("HERMES_SESSION_KEY", "") or ""
    except Exception:
        return ""


def inject_with(ctx: Any) -> Callable[..., bool]:
    def inject(text: str, *, session_key: str) -> bool:
        try:
            return bool(ctx.inject_message(text, session_key=session_key))
        except Exception as exc:
            log.debug("omp notify: inject failed: %s", exc)
            return False

    return inject
