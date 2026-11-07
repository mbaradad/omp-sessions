"""Durable plugin state plus named cross-process locks for read-modify-write updates.

Two stores:
- the profile's own state (ctx.state: <HERMES_HOME>/plugin-data/<plugin>/state.json): which Hermes
  session to notify about which omp session;
- the lane's state (FileState in <kanban root>/plugin-data/omp-sessions-lane/): card <-> session links.
  Kanban boards are shared by every profile, so the lane's links and its lock live next to them:
  however many gateways (profiles) run the plugin, one lane pass runs at a time on this machine and
  they all see the same links.
"""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Callable, Iterator

try:
    import fcntl
except ImportError:  # Windows: in-process locking only
    fcntl = None  # type: ignore[assignment]

_THREAD_LOCKS: dict[str, threading.Lock] = {}
_GUARD = threading.Lock()


class Busy(Exception):
    """A non-blocking lock is held by someone else."""


@contextlib.contextmanager
def file_lock(path: Path, *, blocking: bool = True) -> Iterator[None]:
    """Exclusive lock on `path` across threads and processes; Busy when not blocking and taken."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with _GUARD:
        tl = _THREAD_LOCKS.setdefault(str(path), threading.Lock())
    if not tl.acquire(blocking=blocking):
        raise Busy(path.name)
    try:
        with open(path, "a+") as handle:
            if fcntl is not None:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
                except BlockingIOError as exc:
                    raise Busy(path.name) from exc
            try:
                yield
            finally:
                if fcntl is not None:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        tl.release()


class FileState:
    """A JSON key/value file with the same get/set/data_dir surface as ctx.state."""

    def __init__(self, data_dir: Callable[[], Path]) -> None:
        self._data_dir = data_dir

    @property
    def data_dir(self) -> Path:
        return Path(self._data_dir())

    @property
    def path(self) -> Path:
        return self.data_dir / "state.json"

    def _read(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"cannot read {self.path}: {exc}") from exc
        return data if isinstance(data, dict) else {}

    def get(self, key: str, default: Any = None) -> Any:
        with file_lock(self.data_dir / "state.json.lock"):
            return self._read().get(key, default)

    def set(self, key: str, value: Any) -> None:
        with file_lock(self.data_dir / "state.json.lock"):
            data = self._read()
            data[key] = value
            fd, tmp = tempfile.mkstemp(dir=self.data_dir, prefix=".state.", suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(data, handle, ensure_ascii=False, indent=2)
                os.chmod(tmp, 0o600)
                os.replace(tmp, self.path)
            except BaseException:
                with contextlib.suppress(OSError):
                    os.unlink(tmp)
                raise


def lane_data_dir() -> Path:
    """Machine-wide (all profiles): beside the shared kanban boards."""
    from hermes_cli import kanban_db as kb

    return kb.kanban_home() / "plugin-data" / "omp-sessions-lane"


class Store:
    def __init__(self, state: Any) -> None:
        self.state = state

    def get(self, key: str, default: Any = None) -> Any:
        return self.state.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self.state.set(key, value)

    @contextlib.contextmanager
    def lock(self, name: str, *, blocking: bool = True) -> Iterator[None]:
        """Holds `<data_dir>/<name>.lock`; raises Busy when not blocking and it is taken."""
        with file_lock(Path(self.state.data_dir) / f"{name}.lock", blocking=blocking):
            yield
