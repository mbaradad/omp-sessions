"""omp-sessions: Hermes plugin for omp coding sessions, run by the omp Sessions server through its
omp-sessions CLI (the same sessions VS Code, the omp phone app and the CLI show).

- Tools (toolset omp_sessions) to list, start, queue, schedule, check, wait on, answer, steer and stop
  omp sessions, add tasks to their queues, set priority, and read the server's status.
- Notifications: a Hermes session that started an omp session gets a message when it settles.
- Kanban lane: cards assigned to `omp` run as omp sessions and report back to the card.
- Bundled skill `omp-sessions:omp-sessions`, `/omp`, and `hermes omp …`.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from .commands import run_cli, sessions_brief, sessions_summary, setup_cli, status_data, status_text, take_card
from .lane import Lane
from .notify import Notifier, inject_with
from .ompsessions import OmpSessions
from .settings import read_settings
from .store import FileState, Store, lane_data_dir, profile_of
from .tools import SCHEMAS, TOOLSET, Tools

log = logging.getLogger(__name__)

SKILL_FILE = Path(__file__).parent / "skills" / "omp-sessions" / "SKILL.md"
SKILL_DESCRIPTION = (
    "Start, queue, schedule and supervise omp coding sessions that keep running in the background "
    "(omp_session_* tools or the omp-sessions CLI)."
)


class _ProfileState:
    """ctx.state, looked up on first use (it touches the profile's plugin-data; register() must not)."""

    def __init__(self, ctx: Any) -> None:
        self._ctx = ctx

    def get(self, key: str, default: Any = None) -> Any:
        return self._ctx.state.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self._ctx.state.set(key, value)

    @property
    def data_dir(self) -> Path:
        return Path(self._ctx.state.data_dir)


class Plugin:
    """Everything register() wires up; tests build one around a stub ctx."""

    def __init__(self, ctx: Any) -> None:
        self.ctx = ctx
        self.store = Store(_ProfileState(ctx))
        self.notifier = Notifier(self.store, self.omp, inject_with(ctx), lambda: self.settings().notify, lambda: self.settings().agent_approvals)
        # Machine-wide (shared by every profile that runs the plugin), like the kanban boards.
        self.lane = Lane(Store(FileState(lane_data_dir)), self.settings, self.omp)
        self.tools = Tools(self.settings, self.omp, self.notifier)

    def settings(self):
        return read_settings(self.ctx)

    def omp(self) -> OmpSessions:
        return OmpSessions(self.settings().omp_sessions)

    def on_dispatch_tick(self, board: Any = None, dry_run: bool = False, **_: Any) -> None:
        if dry_run:
            return
        try:
            self.lane.heartbeat(board, profile=profile_of(self.store), lane_on=self.settings().lane.enabled)
        except Exception as exc:
            log.debug("omp lane: heartbeat: %s", exc)
        try:
            self.notifier.poll()
        except Exception as exc:
            log.warning("omp notify: %s", exc, exc_info=True)
        self.lane.tick(board)

    def slash(self, raw_args: str = "", **_: Any) -> str:
        args = (raw_args or "").split()
        if args[:1] in (["status"], ["lane"]):
            return status_text(status_data(self.ctx, self.settings(), self.store, self.lane, self.omp()))
        if args[:1] == ["take"]:
            if len(args) not in (2, 3):
                return "usage: /omp take <card id> [board]"
            return take_card(args[1], args[2] if len(args) == 3 else None, self.settings(), self.lane)
        if args[:1] == ["sessions"]:
            return sessions_summary(self.omp())
        return sessions_brief(self.omp())

    def cli(self, args: Any) -> int:
        return run_cli(args, self.ctx, self.settings, self.store, self.omp, self.lane)


def register(ctx: Any) -> None:
    plugin = Plugin(ctx)
    available = lambda: plugin.omp().available()  # noqa: E731
    for name, handler in plugin.tools.handlers().items():
        ctx.register_tool(name=name, toolset=TOOLSET, schema=SCHEMAS[name], handler=handler, check_fn=available, emoji="🛠")
    ctx.register_hook("on_kanban_dispatch_tick", plugin.on_dispatch_tick)
    ctx.register_command("omp", plugin.slash, description="omp sessions: what's working and what needs you; status; take <card> assigns a kanban card to omp", args_hint="[status|sessions|take <card> [board]]")
    ctx.register_cli_command(name="omp", help="omp sessions: status, kanban lane, board folders", setup_fn=setup_cli, handler_fn=plugin.cli)
    if SKILL_FILE.is_file():
        ctx.register_skill("omp-sessions", SKILL_FILE, description=SKILL_DESCRIPTION, frontmatter={"name": "omp-sessions", "description": SKILL_DESCRIPTION})
