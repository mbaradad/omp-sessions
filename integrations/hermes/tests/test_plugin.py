"""omp-sessions plugin against real Hermes code (temp HERMES_HOME, real kanban DB, the real plugin
loader) and the real omp-sessions CLI + server with the fake omp (temp OMP_VSCODE_HOME).

Run with `npm run test:hermes` (integrations/hermes/tests/run.mjs sets the environment)."""

from __future__ import annotations

import contextvars
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(os.environ["OMP_TEST_ROOT"])
CLI = ROOT / "out" / "cli.js"
PLUGIN_SRC = ROOT / "out" / "hermes-plugin" / "omp-sessions"
FAKE_OMP = ROOT / "test" / "fake-omp.mjs"
NODE = os.environ.get("OMP_TEST_NODE") or shutil.which("node") or "node"

# The temp homes must be set before Hermes modules are imported.
TMP = Path(tempfile.mkdtemp(prefix="omp-hermes-test-"))
HERMES_HOME = TMP / "hermes"
OMP_HOME = TMP / "omp"
WORK = TMP / "work"
for d in (HERMES_HOME / "plugins", OMP_HOME / "sessions", WORK, TMP / "fake-sessions"):
    d.mkdir(parents=True, exist_ok=True)
os.environ.update(
    HERMES_HOME=str(HERMES_HOME),
    OMP_VSCODE_HOME=str(OMP_HOME),
    FAKE_OMP_SESSIONS=str(TMP / "fake-sessions"),
    OMP_SESSIONS_DONE_GRACE_MS="1000",
    NO_COLOR="1",
)
os.environ.pop("HERMES_KANBAN_DB", None)
os.environ.pop("HERMES_KANBAN_BOARD", None)
(OMP_HOME / "launcher.json").write_text(json.dumps({"ompPath": str(FAKE_OMP)}))
shutil.copytree(PLUGIN_SRC, HERMES_HOME / "plugins" / "omp-sessions")
(HERMES_HOME / "config.yaml").write_text(
    "plugins:\n"
    "  enabled: [omp-sessions]\n"
    "  entries:\n"
    "    omp-sessions:\n"
    "      allow_gateway_injection: true\n"
    "      settings:\n"
    f"        omp_sessions: {CLI}\n"
    "        lane:\n"
    "          enabled: true\n"
    "          boards:\n"
    "            proj:\n"
    f"              folder: {WORK}\n"
    "              group: Project board\n"
    "            asking:\n"
    f"              folder: {WORK}\n"
    "              mode: ask\n"
)

from hermes_cli import kanban_db as kb  # noqa: E402
from hermes_cli import kanban_db_boards as kbb  # noqa: E402
from hermes_cli import kanban_db_connect as kbc  # noqa: E402
from hermes_cli.plugins import PluginManager  # noqa: E402


def omp_sessions(*args: str, stdin: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
    p = subprocess.run([NODE, str(CLI), *args], input=stdin, capture_output=True, text=True, timeout=60)
    if check and p.returncode != 0:
        raise AssertionError(f"omp-sessions {' '.join(args)} failed ({p.returncode}): {p.stderr or p.stdout}")
    return p


def sessions() -> list[dict]:
    return json.loads(omp_sessions("ls", "--all", "--json").stdout)


def tagged(card_id: str) -> list[dict]:
    return [s for s in sessions() if f"card:{card_id}" in (s.get("tags") or [])]


def until(fn, what: str, timeout: float = 30, every: float = 0.3):
    deadline = time.time() + timeout
    while True:
        v = fn()
        if v:
            return v
        if time.time() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(every)


class PluginTest(unittest.TestCase):
    injected: list[dict] = []

    @classmethod
    def setUpClass(cls) -> None:
        omp_sessions("server", "start")
        for slug in ("proj", "asking", "other"):
            kbb.create_board(slug, name=f"{slug.title()} board")
        cls.load()

    @classmethod
    def load(cls) -> None:
        """Loads the plugin the way Hermes does (discovery, enabled list, register(ctx))."""
        cls.manager = PluginManager()
        cls.manager.discover_and_load()
        loaded = cls.manager._plugins.get("omp-sessions")
        assert loaded is not None and not loaded.error, getattr(loaded, "error", "plugin not discovered")
        cls.manager.set_gateway_message_injector(cls, lambda **kw: cls.injected.append(kw) or True)
        hooks = cls.manager._hooks["on_kanban_dispatch_tick"]
        cls.plugin = hooks[-1].__self__

    @classmethod
    def tearDownClass(cls) -> None:
        for s in sessions():
            if s["meta"]["status"] != "stopped":
                omp_sessions("stop", s["meta"]["id"], check=False)

    # ---- helpers ----

    def tick(self, board: str) -> None:
        self.manager.invoke_hook("on_kanban_dispatch_tick", board=board, profile_name="default", dry_run=False, outcome="ok", result=None)

    def card(self, board: str, card_id: str):
        with kbc.connect_closing(board=board) as conn:
            return kb.get_task(conn, card_id)

    def create(self, board: str, title: str, **kw) -> str:
        with kbc.connect_closing(board=board) as conn:
            return kb.create_task(conn, title=title, assignee="omp", board=board, **kw)

    def tick_until(self, board: str, card_id: str, pred, what: str, timeout: float = 40):
        def check():
            self.tick(board)
            t = self.card(board, card_id)
            return t if pred(t) else None

        return until(check, what, timeout, every=0.5)

    def tool(self, name: str, args: dict, session_key: str = "") -> dict:
        from gateway.session_context import set_session_vars
        from tools.registry import registry

        def call():
            if session_key:
                set_session_vars(platform="local", session_key=session_key, session_id="hs-1")
            return registry.dispatch(name, args, scope=self.manager.scope_key)

        out = contextvars.copy_context().run(call)
        return json.loads(out) if isinstance(out, str) else out

    def links(self) -> dict:
        return self.plugin.lane.links()

    # ---- registration ----

    def test_registers_tools_hook_commands_and_skill(self) -> None:
        from tools.registry import registry

        for name in ("omp_sessions_list", "omp_projects_list", "omp_session_start", "omp_session_status", "omp_session_wait", "omp_session_send", "omp_session_answer", "omp_session_mode", "omp_session_stop"):
            self.assertIsNotNone(registry.get_entry(name, scope=self.manager.scope_key), name)
        self.assertIn("omp", self.manager._plugin_commands)
        self.assertIn("omp", self.manager._cli_commands)
        self.assertIn("omp-sessions:omp-sessions", self.manager._plugin_skills)

    # ---- lane ----

    def test_lane_claims_runs_and_completes_then_chains_to_the_child(self) -> None:
        parent = self.create("proj", "echo parent result", body="Say it.")
        child = self.create("proj", "echo child result", parents=[parent], skills=["nope-skill"])
        self.assertEqual(self.card("proj", child).status, "todo")
        self.tick("proj")
        t = self.card("proj", parent)
        self.assertEqual(t.status, "running")
        [s] = until(lambda: tagged(parent), "parent session")
        self.assertEqual(set(s["tags"]), {"hermes", "hermes:proj", f"card:{parent}"})
        self.assertEqual(s["meta"]["cwd"], str(WORK), "scratch card runs in the board folder")
        self.assertEqual(s.get("group"), "Project board")
        with kbc.connect_closing(board="proj") as conn:
            comments = kb.list_comments(conn, parent)
        self.assertTrue(any(s["meta"]["id"][:8] in c.body and "omp-sessions attach" in c.body for c in comments), comments)

        done = self.tick_until("proj", parent, lambda t: t.status == "done", "parent done")
        self.assertEqual(done.result, "parent result")
        self.assertNotIn(f"proj/{parent}", self.links())
        # Completing promoted the child; the same or next tick runs it with the parent's result.
        c = self.tick_until("proj", child, lambda t: t.status in ("running", "done"), "child claimed")
        [cs] = until(lambda: tagged(child), "child session")
        queue = json.loads((OMP_HOME / "sessions" / cs["meta"]["id"] / "queue.json").read_text())
        notes = queue["tasks"][0]["notes"]
        self.assertIn(f"Hermes kanban card proj/{child}", notes)
        self.assertIn("parent result", notes, "parent results are in the prompt")
        self.assertIn("nope-skill: (not found on this machine)", notes)
        self.assertEqual(queue["tasks"][0]["title"], "echo child result")
        self.tick_until("proj", child, lambda t: t.status == "done", "child done")
        self.assertEqual(len(tagged(child)), 1)
        del c

    def test_needs_input_blocks_and_unblocks_then_completes(self) -> None:
        card = self.create("asking", "write a.txt hi")
        self.tick("asking")
        [s] = until(lambda: tagged(card), "session")
        sid = s["meta"]["id"]
        blocked = self.tick_until("asking", card, lambda t: t.status == "blocked", "needs_input block")
        self.assertEqual(blocked.block_kind, "needs_input")
        with kbc.connect_closing(board="asking") as conn:
            runs = kb.list_runs(conn, card)
        self.assertTrue(any("Allow tool: write" in (r.summary or "") for r in runs), [r.summary for r in runs])
        # Ticking again while it still waits doesn't block twice.
        self.tick("asking")
        self.assertEqual(self.card("asking", card).status, "blocked")
        omp_sessions("answer", sid, "1")
        done = self.tick_until("asking", card, lambda t: t.status == "done", "done after the answer")
        self.assertTrue((WORK / "a.txt").exists())
        self.assertIn("a.txt", done.result or "")

    def comments(self, board: str, card_id: str) -> list:
        with kbc.connect_closing(board=board) as conn:
            return kb.list_comments(conn, card_id)

    def comment(self, board: str, card_id: str, body: str, author: str = "dashboard") -> None:
        with kbc.connect_closing(board=board) as conn:
            kb.add_comment(conn, card_id, author, body)

    def test_a_comment_answers_omps_question(self) -> None:
        card = self.create("asking", "write c.txt hi")
        self.tick("asking")
        self.tick_until("asking", card, lambda t: t.status == "blocked", "needs_input block")
        self.comment("asking", card, "1")
        self.tick("asking")
        self.assertTrue(any(c.author == "omp" and "answered omp's question" in c.body for c in self.comments("asking", card)))
        done = self.tick_until("asking", card, lambda t: t.status == "done", "done after the comment answered")
        self.assertTrue((WORK / "c.txt").exists())
        self.assertIn("c.txt", done.result or "")

    def test_a_comment_reaches_the_working_session_as_a_follow_up(self) -> None:
        card = self.create("proj", "slow 4000")
        self.tick("proj")
        [s] = until(lambda: tagged(card), "session")
        until(lambda: (json.loads(omp_sessions("show", s["meta"]["id"], "--json").stdout).get("queue") or {}).get("running") == 1, "the card's task running", 20)
        self.tick("proj")  # own "Queued as" comment is not forwarded
        self.assertFalse(any("passed the" in c.body for c in self.comments("proj", card)))
        self.comment("proj", card, "echo banana")
        self.tick("proj")
        self.assertTrue(any(c.author == "omp" and "passed the comment on as a follow-up" in c.body for c in self.comments("proj", card)))
        done = self.tick_until("proj", card, lambda t: t.status == "done", "done after the follow-up")
        self.assertIn("banana", done.result or "")

    def test_mentioning_omp_in_a_comment_assigns_the_card(self) -> None:
        with kbc.connect_closing(board="proj") as conn:
            card = kb.create_task(conn, title="echo mentioned", board="proj")
            other = kb.create_task(conn, title="echo not mine", board="proj")
        self.tick("proj")  # the board's mention watermark starts at the newest comment
        self.comment("proj", other, "mail me at someone@omp.dev")
        self.comment("proj", card, "@omp can you take this?")
        self.tick("proj")
        self.assertEqual(self.card("proj", card).assignee, "omp")
        self.assertIn(self.card("proj", other).assignee, (None, ""))
        self.assertTrue(any(c.author == "omp" and "mentioned @omp" in c.body for c in self.comments("proj", card)))
        done = self.tick_until("proj", card, lambda t: t.status == "done", "mentioned card done")
        self.assertEqual(done.result, "mentioned")

    def test_failed_task_blocks_transient_and_unblock_retries_in_the_same_session(self) -> None:
        card = self.create("proj", "fail boom")
        self.tick("proj")
        t = self.tick_until("proj", card, lambda t: t.status == "blocked", "transient block")
        self.assertEqual(t.block_kind, "transient")
        self.assertEqual(self.links()[f"proj/{card}"]["state"], "failed")
        with kbc.connect_closing(board="proj") as conn:
            kb.unblock_task(conn, card)
        self.tick("proj")
        self.assertEqual(self.links()[f"proj/{card}"]["state"], "active")
        self.assertEqual(len(tagged(card)), 1, "retried in the same session")

    def test_removed_session_blocks_transient(self) -> None:
        card = self.create("proj", "slow 20000")
        self.tick("proj")
        [s] = until(lambda: tagged(card), "session")
        # Remove it once it runs (removing a session the server is launching races with its host).
        until(lambda: json.loads(omp_sessions("show", s["meta"]["id"], "--json").stdout)["state"] == "working", "working")
        omp_sessions("rm", s["meta"]["id"], "-y")
        t = self.tick_until("proj", card, lambda t: t.status == "blocked", "transient block")
        self.assertEqual(t.block_kind, "transient")
        with kbc.connect_closing(board="proj") as conn:
            runs = kb.list_runs(conn, card)
        self.assertTrue(any("was removed" in (r.summary or "") for r in runs), [r.summary for r in runs])

    def test_restart_and_lost_link_never_make_a_second_session(self) -> None:
        card = self.create("proj", "slow 15000")
        self.tick("proj")
        [s] = until(lambda: tagged(card), "session")
        # A restarted gateway (new manager, same plugin state) keeps tracking it.
        type(self).load()
        self.tick("proj")
        self.assertEqual(self.card("proj", card).status, "running")
        # Lost link (crash between `omp-sessions new` and saving it) and the claim released: the lane
        # finds the session by its card tag instead of starting another.
        links = self.links()
        links.pop(f"proj/{card}")
        self.plugin.lane.store.set("links", links)
        with kbc.connect_closing(board="proj") as conn:
            self.assertTrue(kb.reclaim_task(conn, card, reason="test"))
        self.assertEqual(self.card("proj", card).status, "ready")
        self.tick("proj")
        self.assertEqual(self.card("proj", card).status, "running")
        self.assertEqual(self.links()[f"proj/{card}"]["session"], s["meta"]["id"])
        self.assertEqual(len(tagged(card)), 1)
        omp_sessions("stop", s["meta"]["id"], check=False)

    def test_cards_of_other_assignees_and_boards_are_left_alone(self) -> None:
        with kbc.connect_closing(board="proj") as conn:
            mine = kb.create_task(conn, title="echo not mine", assignee="someone", board="proj")
        other = self.create("other", "echo other board")
        self.tick("proj")
        self.tick("other")
        self.assertEqual(self.card("proj", mine).status, "ready")
        self.assertEqual(self.card("other", other).status, "ready")
        self.assertEqual(tagged(mine) + tagged(other), [])

    # ---- several profiles ----

    def test_lane_state_and_lock_are_machine_wide(self) -> None:
        lane_dir = HERMES_HOME / "plugin-data" / "omp-sessions-lane"
        self.assertEqual(Path(self.plugin.lane.store.state.data_dir), lane_dir, "beside the shared kanban boards, not in a profile")
        card = self.create("proj", "echo locked out")
        # Another process (another profile's gateway) holds the lane lock: this pass does nothing.
        holder = subprocess.Popen(
            [sys.executable, "-c", "import fcntl, sys, time; f = open(sys.argv[1], 'a+'); fcntl.flock(f, fcntl.LOCK_EX); print('locked', flush=True); time.sleep(30)", str(lane_dir / "lane.lock")],
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            self.assertEqual(holder.stdout.readline().strip(), "locked")
            self.tick("proj")
            self.assertEqual(self.card("proj", card).status, "ready")
        finally:
            holder.kill()
            holder.wait()
        self.tick_until("proj", card, lambda t: t.status == "done", "done once the lock is free")

    def test_a_second_profile_shares_the_links_and_never_duplicates(self) -> None:
        p2 = HERMES_HOME / "profiles" / "p2"
        (p2 / "plugins").mkdir(parents=True, exist_ok=True)
        shutil.copytree(PLUGIN_SRC, p2 / "plugins" / "omp-sessions", dirs_exist_ok=True)
        (p2 / "config.yaml").write_text(
            "plugins:\n  enabled: [omp-sessions]\n  entries:\n    omp-sessions:\n      settings:\n"
            f"        omp_sessions: {CLI}\n        lane:\n          enabled: true\n          boards:\n            proj:\n              folder: {WORK}\n"
        )
        card = self.create("proj", "slow 3000")
        os.environ["HERMES_HOME"] = str(p2)
        try:
            other = PluginManager()
            other.discover_and_load()
            self.assertFalse(other._plugins["omp-sessions"].error)
            other_plugin = other._hooks["on_kanban_dispatch_tick"][-1].__self__
            self.assertEqual(other_plugin.lane.store.state.data_dir, self.plugin.lane.store.state.data_dir)
            other.invoke_hook("on_kanban_dispatch_tick", board="proj", profile_name="p2", dry_run=False, outcome="ok", result=None)
        finally:
            os.environ["HERMES_HOME"] = str(HERMES_HOME)
        [s] = until(lambda: tagged(card), "session started by the p2 lane")
        # The default profile's lane sees p2's link and finishes the card; nobody starts another.
        self.assertEqual(self.links()[f"proj/{card}"]["session"], s["meta"]["id"])
        self.tick_until("proj", card, lambda t: t.status == "done", "done")
        self.assertEqual(len(tagged(card)), 1)

    def test_dispatcher_heartbeat_shows_where_the_lane_runs(self) -> None:
        from hermes_plugins.omp_sessions import commands

        self.tick("other")
        d = commands.status_data(None, self.plugin.settings(), self.plugin.store, self.plugin.lane, self.plugin.omp())
        self.assertEqual(d["profile"], "default")
        self.assertEqual((d["dispatcher"]["profile"], d["dispatcher"]["lane_on"], d["dispatcher"]["board"]), ("default", True, "other"))
        self.assertEqual(d["dispatcher_notes"], [])
        self.assertIn("kanban dispatcher: last tick", commands.status_text(d))

    def test_slash_take_routes_a_card_to_omp_and_brief_fits_a_phone(self) -> None:
        with kbc.connect_closing(board="other") as conn:
            card = kb.create_task(conn, title="from the phone", assignee="alice", board="other")
        self.assertIn("No card t_nope", self.plugin.slash("take t_nope"))
        out = self.plugin.slash(f"take {card}")
        self.assertIn(f"{card} on other is assigned to omp", out)
        self.assertEqual(self.card("other", card).assignee, "omp")
        self.assertEqual(self.plugin.slash("take"), "usage: /omp take <card id> [board]")
        self.assertEqual(self.plugin.slash(f"take {card} no-such-board"), "No open board no-such-board.")
        brief = self.plugin.slash("")
        self.assertLessEqual(len(brief.splitlines()), 6, brief)

    # ---- tools + notifications ----

    def test_tools_start_status_wait_answer_and_notify(self) -> None:
        key = "agent:main:local:test"
        res = self.tool("omp_session_start", {"prompt": "write b.txt yo", "cwd": str(WORK), "mode": "ask", "title": "tool session", "tags": ["from-hermes"]}, session_key=key)
        self.assertNotIn("error", res, res)
        sid = res["id"]
        self.assertIn("notify", res)
        waited = self.tool("omp_session_wait", {"id": sid, "timeout_seconds": 30})
        self.assertEqual(waited["outcome"], "needs_input", waited)
        self.assertIn("Allow tool: write", waited["session"]["question"]["title"])
        status = self.tool("omp_session_status", {"id": sid[:8]})
        self.assertEqual(status["state"], "needs_input")
        self.assertIn("from-hermes", status["tags"])
        # The agent saw the question itself: no notification for it.
        self.injected.clear()
        self.plugin.notifier.poll(force=True)
        self.assertEqual(self.injected, [])
        ans = self.tool("omp_session_answer", {"id": sid, "answer": "1"}, session_key=key)
        self.assertTrue(ans.get("answered"), ans)
        until(lambda: (WORK / "b.txt").exists(), "b.txt written")
        until(lambda: json.loads(omp_sessions("show", sid, "--json").stdout)["state"] == "idle", "idle")
        self.plugin.notifier.poll(force=True)
        self.assertEqual(len(self.injected), 1, self.injected)
        note = self.injected[0]
        self.assertEqual(note["session_key"], key)
        self.assertIn("finished its turn", note["content"])
        self.assertIn(f"omp-sessions show {sid[:8]}", note["content"])
        # Delivered once.
        self.plugin.notifier.poll(force=True)
        self.assertEqual(len(self.injected), 1)

    def test_start_queues_on_a_board_or_project_and_lists_places(self) -> None:
        res = self.tool("omp_session_start", {"task": "echo queued", "notes": "details", "board": "proj", "at": "+2h"})
        self.assertNotIn("error", res, res)
        self.assertIn("startAt", res)
        s = next(x for x in sessions() if x["meta"]["id"] == res["id"])
        self.assertEqual(s["meta"]["cwd"], str(WORK))
        self.assertEqual(s.get("group"), "Project board")
        self.assertEqual(json.loads(omp_sessions("show", res["id"], "--json").stdout)["state"], "queued")
        places = self.tool("omp_projects_list", {})
        self.assertTrue(any(b["slug"] == "proj" and b["folder"] == str(WORK) for b in places["boards"]))
        self.assertTrue(any(f["path"] == str(WORK) for f in places["folders"]))
        by_name = self.tool("omp_session_start", {"prompt": "echo hi", "project": WORK.name})
        self.assertNotIn("error", by_name, by_name)
        self.assertEqual(by_name["cwd"], str(WORK))
        self.assertIn("error", self.tool("omp_session_start", {"prompt": "echo hi"}))
        self.assertIn("error", self.tool("omp_session_start", {"prompt": "echo hi", "board": "other"}))


class PureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if "hermes_plugins.omp_sessions" not in sys.modules:
            PluginManager().discover_and_load()

    def setUp(self) -> None:
        from hermes_plugins.omp_sessions import lane, settings

        self.lane = lane
        self.settings = settings

    def test_dispatcher_notes(self) -> None:
        from hermes_plugins.omp_sessions.commands import dispatcher_notes

        now = 1_000_000.0
        tick = lambda profile, lane_on, age=30: {"at": now - age, "profile": profile, "lane_on": lane_on}  # noqa: E731
        self.assertIn("No kanban dispatcher tick", dispatcher_notes(None, profile="default", lane_on=True, now=now)[0])
        self.assertEqual(dispatcher_notes(tick("default", True), profile="default", lane_on=True, now=now), [])
        # The dispatcher ticks another profile's plugin: the lane here never runs.
        [n] = dispatcher_notes(tick("default", False), profile="robedrone", lane_on=True, now=now)
        self.assertIn("hermes -p default omp lane on", n)
        # Lane off where the dispatcher runs: said in that profile, not in the others.
        self.assertIn("lane is off here", dispatcher_notes(tick("default", False), profile="default", lane_on=False, now=now)[0])
        self.assertEqual(dispatcher_notes(tick("default", True), profile="robedrone", lane_on=False, now=now), [])
        [stale] = dispatcher_notes(tick("default", True, age=600), profile="default", lane_on=True, now=now)
        self.assertIn("has stopped", stale)

    def test_settings_defaults_and_board_lanes(self) -> None:
        s = self.settings.parse_settings({})
        self.assertFalse(s.lane.enabled)
        self.assertIsNone(self.settings.board_lane(s, "x"))
        s = self.settings.parse_settings({"lane": {"enabled": True, "mode": "edits", "boards": {"a": {"group": "A", "mode": "bogus"}}}})
        a = self.settings.board_lane(s, "a", "Board A")
        self.assertEqual((a.assignee, a.group, a.mode), ("omp", "A", "edits"))
        self.assertIsNone(self.settings.board_lane(s, "b"))
        every = self.settings.parse_settings({"lane": {"enabled": True, "assignee": "OMP"}})
        b = self.settings.board_lane(every, "b", "Board B")
        self.assertEqual((b.assignee, b.group), ("omp", "Board B"))

    def test_decide(self) -> None:
        d, Card = self.lane.decide, self.lane.Card
        link = {"session": "s1", "state": "active", "asked": []}
        rep = lambda state, **q: {"state": state, "queue": {"pending": 0, "running": 0, "done": 0, "total": 1, **q}}  # noqa: E731
        self.assertEqual(d(Card(None, "omp"), link, rep("working"), "omp"), [("drop", "the card was deleted")])
        self.assertEqual(d(Card("running", "bob"), link, rep("working"), "omp")[0][0], "drop")
        self.assertEqual(d(Card("running", "omp"), link, rep("working", running=1), "omp"), [("heartbeat",)])
        self.assertEqual(d(Card("ready", "omp"), link, rep("queued", pending=1), "omp"), [("claim",)])
        self.assertEqual(d(Card("running", "omp"), link, rep("idle", done=1), "omp"), [("complete",)])
        self.assertEqual(d(Card("running", "omp"), link, rep("stopped", done=1), "omp"), [("complete",)])
        q = {**rep("needs_input", running=1), "question": {"id": "q1", "title": "Allow tool: write", "options": ["Approve", "Deny"]}}
        acts = d(Card("running", "omp"), link, q, "omp")
        self.assertEqual(acts[0][0], "block_input")
        self.assertIn("Approve · Deny", acts[0][1])
        self.assertEqual(d(Card("running", "omp", "needs_input"), link, q, "omp")[0][0], "comment_input")
        self.assertEqual(d(Card("blocked", "omp"), {**link, "input_blocked": True, "asked": ["q1"]}, q, "omp"), [])
        self.assertEqual(d(Card("blocked", "omp"), {**link, "input_blocked": True}, rep("working", running=1), "omp"), [("unblock",), ("claim",)])
        failed = d(Card("running", "omp"), link, {**rep("idle"), "reply": "boom"}, "omp")
        self.assertEqual(failed, [("block_transient", "The omp session's task failed: boom")])
        stopped = d(Card("running", "omp"), link, {**rep("stopped", running=1), "exitReason": "killed"}, "omp")
        self.assertEqual(stopped, [("block_transient", "The omp session stopped before finishing: killed")])
        self.assertEqual(d(Card("running", "omp"), link, None, "omp")[0][0], "block_transient")
        gone = {**link, "state": "failed"}
        self.assertEqual(d(Card("ready", "omp"), gone, None, "omp"), [("claim",), ("recreate",)])
        self.assertEqual(d(Card("ready", "omp"), gone, rep("idle"), "omp"), [("claim",), ("retry",)])
        self.assertEqual(d(Card("blocked", "omp"), gone, rep("idle"), "omp"), [])

    def test_capacity_follows_the_omp_scheduler(self) -> None:
        c = self.lane.capacity
        self.assertEqual(c({"maxConcurrent": 0}), self.lane.MAX_NEW_PER_TICK)
        self.assertEqual(c({"maxConcurrent": 2, "running": 1, "waiting": 0}), 1)
        self.assertEqual(c({"maxConcurrent": 2, "running": 1, "waiting": 3}), 0)
        self.assertEqual(c({"maxConcurrent": 0, "paused": True}), 0)

    def test_compose_notes_and_skills(self) -> None:
        root = TMP / "skills-test"
        (root / "skills" / "cat" / "my-skill").mkdir(parents=True)
        (root / "skills" / "cat" / "my-skill" / "SKILL.md").write_text("---\nname: my-skill\n---\n")
        roots = self.lane.skill_roots(root)
        found = self.lane.find_skill("my-skill", roots)
        self.assertEqual(found, str(root / "skills" / "cat" / "my-skill" / "SKILL.md"))
        notes = self.lane.compose_notes(board="b", card_id="t_1", cwd="/w", branch="wt/t_1", context="X" * 50_000, skills=[("my-skill", found), ("gone", None)])
        self.assertLessEqual(len(notes), 20_000)
        self.assertIn("Branch: wt/t_1", notes)
        self.assertIn(f"- my-skill: {found}", notes)
        self.assertIn("- gone: (not found on this machine)", notes)
        self.assertIn("(clipped)", notes)

    def test_notification_text(self) -> None:
        from hermes_plugins.omp_sessions import notify

        idle = notify.note_text({"id": "abcdef123", "title": "T", "state": "idle", "reply": "done it"})
        self.assertIn('omp session "T" (abcdef12) finished its turn', idle)
        self.assertIn("done it", idle)
        ask = notify.note_text({"id": "abcdef123", "title": "T", "state": "needs_input", "question": {"id": "q", "title": "Pick", "options": ["a", "b"]}})
        self.assertIn("waiting for input: Pick", ask)
        self.assertIn("Options: a · b", ask)

    def test_a_refused_note_is_retried_for_an_hour_then_dropped(self) -> None:
        from hermes_plugins.omp_sessions import notify
        from hermes_plugins.omp_sessions.store import Store

        class State(dict):
            data_dir = str(TMP)

            def set(self, key, value) -> None:
                self[key] = value

        class Omp:
            def show(self, sid):
                return {"id": sid, "title": "T", "state": "idle", "reply": "ok"}

        answers = [False]
        store = Store(State())
        n = notify.Notifier(store, lambda: Omp(), lambda text, session_key: answers[0], lambda: True)
        n.watch("s1", "chat-1")
        self.assertEqual(n.poll(force=True), 0)
        self.assertIn("refused_since", store.get("watches")["s1"], "kept for a retry")
        answers[0] = True  # consent turned on: the retry delivers and the watch ends
        self.assertEqual(n.poll(force=True), 1)
        self.assertEqual(store.get("watches"), {})
        answers[0] = False
        n.watch("s2", "chat-gone")
        n.poll(force=True)
        store.get("watches")["s2"]["refused_since"] -= notify.REFUSED_GIVE_UP_S + 1
        n.poll(force=True)
        self.assertEqual(store.get("watches"), {}, "given up after an hour of refusals")


def tearDownModule() -> None:
    omp_sessions("server", "stop", check=False)
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
