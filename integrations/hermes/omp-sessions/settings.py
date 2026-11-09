"""Plugin settings: config.yaml `plugins.entries.omp-sessions.settings` (read with ctx.get_config,
written with update_setting).

    omp_sessions: /path/to/omp-sessions        # default: PATH, ~/.local/bin/omp-sessions, %LOCALAPPDATA%\\omp-sessions\\omp-sessions.cmd, ~/.omp/vscode/runtime/cli.js
    notify: true                   # tell the Hermes session that started an omp session when it settles
    agent_approvals: false         # let the Hermes agent answer omp's approval dialogs (omp_session_answer, omp_session_mode)
    lane:
      enabled: false               # run kanban cards assigned to `assignee` as omp sessions
      assignee: omp
      mode: ask                    # starting permission mode of card sessions (default: omp's)
      comment_authors: [dashboard] # whose card comments reach omp sessions and whose `@omp` assigns cards ("*": anyone)
      archive_completed: false     # archive a card (and its omp session) once the lane completes it
      boards:                      # empty: every board, with the defaults above
        lightscale:
          folder: /home/me/src/lightscale   # cwd for cards with a scratch workspace
          group: Lightscale                 # omp group of the board's sessions (default: board name)
          mode: edits
          assignee: omp
          model: anthropic/claude-sonnet-4-5    # model of the board's card sessions (a card's own model override wins; default: omp Sessions' default)
          comment_authors: [dashboard, alice]   # replaces the lane's list on this board
          archive_completed: true               # replaces the lane's archive_completed on this board
    projects:                      # Hermes project id/slug/name (or any name you like) -> folder
      lightscale: /home/me/src/lightscale

Comment authors: the Hermes dashboard and Hermes Console post as `dashboard`, `hermes kanban comment`
as the profile name (or `--author`), and Hermes agents' kanban tools as their profile name. The
default trusts only `dashboard` (the token-protected UI a person uses), so other profiles' agents,
which may act on untrusted input, can't prompt omp or hand it cards; list a profile to trust it.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional

PLUGIN_ID = "omp-sessions"
MODES = ("ask", "edits", "plan", "auto")
# Permission modes from most to least restrictive.
MODE_ORDER = ("plan", "ask", "edits", "auto")
DEFAULT_ASSIGNEE = "omp"
DEFAULT_COMMENT_AUTHORS = ("dashboard",)
ANY_AUTHOR = "*"


@dataclass
class BoardLane:
    """The lane's settings for one board, after defaults."""

    slug: str
    assignee: str
    group: str
    folder: Optional[str] = None
    mode: Optional[str] = None
    model: Optional[str] = None
    comment_authors: tuple[str, ...] = DEFAULT_COMMENT_AUTHORS
    archive_completed: bool = False

    def trusts(self, author: str) -> bool:
        """Whether `author`'s comments reach omp and their `@omp` mentions assign cards."""
        return ANY_AUTHOR in self.comment_authors or author.strip().lower() in self.comment_authors


@dataclass
class LaneSettings:
    enabled: bool = False
    assignee: str = DEFAULT_ASSIGNEE
    mode: Optional[str] = None
    comment_authors: tuple[str, ...] = DEFAULT_COMMENT_AUTHORS
    archive_completed: bool = False
    boards: dict[str, dict[str, Any]] = field(default_factory=dict)


@dataclass
class Settings:
    omp_sessions: Optional[str] = None
    notify: bool = True
    agent_approvals: bool = False
    lane: LaneSettings = field(default_factory=LaneSettings)
    projects: dict[str, str] = field(default_factory=dict)


def _str(v: Any) -> Optional[str]:
    return v.strip() if isinstance(v, str) and v.strip() else None


def _mode(v: Any) -> Optional[str]:
    s = _str(v)
    return s.lower() if s and s.lower() in MODES else None


def parse_authors(v: Any) -> Optional[tuple[str, ...]]:
    """A list of comment authors (or one comma-separated string), lowercased; None when not given."""
    if isinstance(v, str):
        v = v.split(",")
    if not isinstance(v, (list, tuple)):
        return None
    return tuple(dict.fromkeys(str(a).strip().lower() for a in v if str(a).strip()))


def _board_entry(v: Any) -> dict[str, Any]:
    if not isinstance(v, Mapping):
        return {}
    out: dict[str, Any] = {}
    for key in ("folder", "group", "assignee", "model"):
        s = _str(v.get(key))
        if s:
            out[key] = s
    if _mode(v.get("mode")):
        out["mode"] = _mode(v.get("mode"))
    authors = parse_authors(v.get("comment_authors"))
    if authors is not None:
        out["comment_authors"] = list(authors)
    if isinstance(v.get("archive_completed"), bool):
        out["archive_completed"] = v["archive_completed"]
    return out


def parse_settings(raw: Mapping[str, Any]) -> Settings:
    """Settings from the raw `settings` mapping; anything malformed falls back to the defaults."""
    lane_raw = raw.get("lane") if isinstance(raw.get("lane"), Mapping) else {}
    boards_raw = lane_raw.get("boards")
    boards: dict[str, dict[str, Any]] = {}
    if isinstance(boards_raw, Mapping):
        boards = {str(k): _board_entry(v) for k, v in boards_raw.items()}
    elif isinstance(boards_raw, list):
        boards = {str(k): {} for k in boards_raw if _str(k)}
    projects_raw = raw.get("projects")
    projects = {str(k): str(v) for k, v in projects_raw.items() if _str(v)} if isinstance(projects_raw, Mapping) else {}
    authors = parse_authors(lane_raw.get("comment_authors"))
    return Settings(
        omp_sessions=_str(raw.get("omp_sessions")),
        notify=raw.get("notify") is not False,
        agent_approvals=raw.get("agent_approvals") is True,
        lane=LaneSettings(
            enabled=lane_raw.get("enabled") is True,
            assignee=(_str(lane_raw.get("assignee")) or DEFAULT_ASSIGNEE).lower(),
            mode=_mode(lane_raw.get("mode")),
            comment_authors=DEFAULT_COMMENT_AUTHORS if authors is None else authors,
            archive_completed=lane_raw.get("archive_completed") is True,
            boards=boards,
        ),
        projects=projects,
    )


def board_lane(s: Settings, slug: str, board_name: Optional[str] = None) -> Optional[BoardLane]:
    """The lane's settings for `slug`, or None when the lane doesn't take cards from that board."""
    if not s.lane.enabled:
        return None
    if s.lane.boards and slug not in s.lane.boards:
        return None
    e = s.lane.boards.get(slug, {})
    return BoardLane(
        slug=slug,
        assignee=(e.get("assignee") or s.lane.assignee).lower(),
        group=e.get("group") or board_name or slug,
        folder=e.get("folder"),
        mode=e.get("mode") or s.lane.mode,
        model=e.get("model"),
        comment_authors=tuple(e["comment_authors"]) if "comment_authors" in e else s.lane.comment_authors,
        archive_completed=archive_completed(s, slug),
    )


def archive_completed(s: Settings, slug: str) -> bool:
    """Whether the lane archives the cards it completes on `slug` (the board's setting, else the lane's)."""
    v = s.lane.boards.get(slug, {}).get("archive_completed")
    return v if isinstance(v, bool) else s.lane.archive_completed


def read_settings(ctx: Any) -> Settings:
    raw: dict[str, Any] = {}
    for key in ("omp_sessions", "notify", "agent_approvals", "lane", "projects"):
        v = ctx.get_config(key, None)
        if v is not None:
            raw[key] = v
    return parse_settings(raw)


def update_setting(key: str, change: Callable[[Any], Any]) -> None:
    """Read-modify-write of `plugins.entries.omp-sessions.settings.<key>` in the active profile's
    config.yaml: `change` gets the current value (a copy) and returns the new one, written as is.

    ctx.set_config deep-merges into what is on disk, so it can't drop a board or clear a field.
    Holds the lock Hermes's own plugin-setting writer takes (`.config.yaml.lock`)."""
    from hermes_cli import config as cfg

    from .store import file_lock

    if cfg.is_managed():
        raise PermissionError("plugin settings cannot be changed in a managed install")
    path = cfg.get_config_path()
    with file_lock(path.with_name(f".{path.name}.lock")):
        raw = cfg.require_readable_config_before_write(path)
        node = raw
        for part in ("plugins", "entries", PLUGIN_ID, "settings"):
            if not isinstance(node.get(part), dict):
                node[part] = {}
            node = node[part]
        node[key] = change(copy.deepcopy(node.get(key)))
        cfg.save_config(raw)
