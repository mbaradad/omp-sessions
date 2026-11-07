"""omp-sessions: Hermes plugin for omp coding sessions (the omp Sessions VS Code extension's omp-vs CLI).

- Tools (toolset omp_sessions) to list, start, queue, schedule, check, wait on, answer, steer and stop
  omp sessions.
- Notifications: a Hermes session that started an omp session gets a message when it settles.
- Kanban lane: cards assigned to `omp` run as omp sessions and report back to the card.
- Bundled skill `omp-sessions:omp-sessions`, `/omp`, and `hermes omp …`.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from .commands import run_cli, sessions_summary, setup_cli, status_data, status_text
from .lane import Lane
from .notify import Notifier, inject_with
from .ompvs import OmpVs
from .settings import read_settings
from .store import FileState, Store, lane_data_dir
from .tools import SCHEMAS, TOOLSET, Tools

log = logging.getLogger(__name__)

SKILL_FILE = Path(__file__).parent / "skills" / "omp-sessions" / "SKILL.md"
SKILL_DESCRIPTION = (
    "Start, queue, schedule and supervise omp coding sessions that keep running in the background "
    "(omp_session_* tools or the omp-vs CLI)."
)


class Plugin:
    """Everything register() wires up; tests build one around a stub ctx."""

    def __init__(self, ctx: Any) -> None:
        self.ctx = ctx
        self.store = Store(ctx.state)
        self.notifier = Notifier(self.store, self.omp, inject_with(ctx), lambda: self.settings().notify)
        # Machine-wide (shared by every profile that runs the plugin), like the kanban boards.
        self.lane = Lane(Store(FileState(lane_data_dir)), self.settings, self.omp)
        self.tools = Tools(self.settings, self.omp, self.notifier)

    def settings(self):
        return read_settings(self.ctx)

    def omp(self) -> OmpVs:
        return OmpVs(self.settings().omp_vs)

    def on_dispatch_tick(self, board: Any = None, dry_run: bool = False, **_: Any) -> None:
        if dry_run:
            return
        try:
            self.notifier.poll()
        except Exception as exc:
            log.warning("omp notify: %s", exc, exc_info=True)
        self.lane.tick(board)

    def slash(self, raw_args: str = "", **_: Any) -> str:
        arg = (raw_args or "").strip()
        if arg in ("status", "lane"):
            return status_text(status_data(self.ctx, self.settings(), self.store, self.lane, self.omp()))
        return sessions_summary(self.omp())

    def cli(self, args: Any) -> int:
        return run_cli(args, self.ctx, self.settings, self.store, self.omp, self.lane)


def register(ctx: Any) -> None:
    plugin = Plugin(ctx)
    available = lambda: plugin.omp().available()  # noqa: E731
    for name, handler in plugin.tools.handlers().items():
        ctx.register_tool(name=name, toolset=TOOLSET, schema=SCHEMAS[name], handler=handler, check_fn=available, emoji="🛠")
    ctx.register_hook("on_kanban_dispatch_tick", plugin.on_dispatch_tick)
    ctx.register_command("omp", plugin.slash, description="omp sessions (status: plugin and kanban lane)", args_hint="[status]")
    ctx.register_cli_command(name="omp", help="omp sessions: status, kanban lane, board folders", setup_fn=setup_cli, handler_fn=plugin.cli)
    if SKILL_FILE.is_file():
        ctx.register_skill("omp-sessions", SKILL_FILE, description=SKILL_DESCRIPTION, frontmatter={"name": "omp-sessions", "description": SKILL_DESCRIPTION})
