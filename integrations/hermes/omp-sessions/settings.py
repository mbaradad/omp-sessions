"""Plugin settings: config.yaml `plugins.entries.omp-sessions.settings` (read with ctx.get_config,
written with update_setting).

    omp_vs: /path/to/omp-vs        # default: PATH, then ~/.local/bin/omp-vs
    notify: true                   # tell the Hermes session that started an omp session when it settles
    lane:
      enabled: false               # run kanban cards assigned to `assignee` as omp sessions
      assignee: omp
      mode: ask                    # starting permission mode of card sessions (default: omp's)
      boards:                      # empty: every board, with the defaults above
        lightscale:
          folder: /home/me/src/lightscale   # cwd for cards with a scratch workspace
          group: Lightscale                 # omp group of the board's sessions (default: board name)
          mode: edits
          assignee: omp
    projects:                      # Hermes project id/slug/name (or any name you like) -> folder
      lightscale: /home/me/src/lightscale
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional

PLUGIN_ID = "omp-sessions"
MODES = ("ask", "edits", "plan", "auto")
DEFAULT_ASSIGNEE = "omp"


@dataclass
class BoardLane:
    """The lane's settings for one board, after defaults."""

    slug: str
    assignee: str
    group: str
    folder: Optional[str] = None
    mode: Optional[str] = None


@dataclass
class LaneSettings:
    enabled: bool = False
    assignee: str = DEFAULT_ASSIGNEE
    mode: Optional[str] = None
    boards: dict[str, dict[str, Any]] = field(default_factory=dict)


@dataclass
class Settings:
    omp_vs: Optional[str] = None
    notify: bool = True
    lane: LaneSettings = field(default_factory=LaneSettings)
    projects: dict[str, str] = field(default_factory=dict)


def _str(v: Any) -> Optional[str]:
    return v.strip() if isinstance(v, str) and v.strip() else None


def _mode(v: Any) -> Optional[str]:
    s = _str(v)
    return s.lower() if s and s.lower() in MODES else None


def _board_entry(v: Any) -> dict[str, Any]:
    if not isinstance(v, Mapping):
        return {}
    out: dict[str, Any] = {}
    for key in ("folder", "group", "assignee"):
        s = _str(v.get(key))
        if s:
            out[key] = s
    if _mode(v.get("mode")):
        out["mode"] = _mode(v.get("mode"))
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
    return Settings(
        omp_vs=_str(raw.get("omp_vs")),
        notify=raw.get("notify") is not False,
        lane=LaneSettings(
            enabled=lane_raw.get("enabled") is True,
            assignee=(_str(lane_raw.get("assignee")) or DEFAULT_ASSIGNEE).lower(),
            mode=_mode(lane_raw.get("mode")),
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
    )


def read_settings(ctx: Any) -> Settings:
    raw: dict[str, Any] = {}
    for key in ("omp_vs", "notify", "lane", "projects"):
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
