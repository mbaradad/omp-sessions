"""The dashboard/Desktop backend (switchyard/dashboard/plugin_api.py), imported the way Hermes imports
it and mounted on a FastAPI app, against the real switchyard CLI + server with the fake omp and a real
kanban board. Shares test_plugin's temp homes (it sets them up on import)."""

from __future__ import annotations

import http.server
import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

import test_plugin as base
from test_plugin import HERMES_HOME, WORK, switchyard, until

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from hermes_cli import kanban_db as kb  # noqa: E402
from hermes_cli import kanban_db_boards as kbb  # noqa: E402
from hermes_cli import kanban_db_connect as kbc  # noqa: E402

API_FILE = HERMES_HOME / "plugins" / "switchyard" / "dashboard" / "plugin_api.py"
CONFIG = HERMES_HOME / "config.yaml"


def load_api():
    """Like hermes_cli/web_server_dashboard.py::_mount_one_plugin_api."""
    name = "hermes_dashboard_plugin_switchyard"
    spec = importlib.util.spec_from_file_location(name, API_FILE)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


class DashboardApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        switchyard("server", "start", check=False)
        for slug in ("proj", "asking", "other"):  # test_plugin's boards (create_board is idempotent)
            kbb.create_board(slug, name=f"{slug.title()} board")
        kbb.create_board("dash", name="Dash board")
        cls.config_text = CONFIG.read_text()
        cls.api = load_api()
        app = FastAPI()
        app.include_router(cls.api.router, prefix="/api/plugins/switchyard")
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls) -> None:
        CONFIG.write_text(cls.config_text)
        for s in base.sessions():
            if s["meta"]["status"] != "stopped":
                switchyard("stop", s["meta"]["id"], check=False)

    def get(self, path: str, status: int = 200) -> dict:
        r = self.client.get(f"/api/plugins/switchyard{path}")
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    def post(self, path: str, body: dict, status: int = 200) -> dict:
        r = self.client.post(f"/api/plugins/switchyard{path}", json=body)
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    def view(self, sid: str) -> dict | None:
        return next((s for s in self.get("/sessions")["sessions"] if s["id"] == sid), None)

    def state_is(self, sid: str, state: str) -> dict | None:
        v = self.view(sid)
        return v if v and v["state"] == state else None

    def test_loads_its_own_package_and_reports_status(self) -> None:
        self.assertIn("switchyard_dashboard_plugin", sys.modules, "plugin_api imports the plugin folder as a package")
        o = self.get("/overview")
        self.assertTrue(o["switchyard"]["found"])
        self.assertRegex(o["switchyard"]["cli"], r"^\d+\.\d+\.\d+")
        self.assertTrue(o["scheduler"]["server"])
        self.assertTrue(o["lane"]["enabled"])
        self.assertEqual(o["lane"]["boards"], ["asking", "proj"])
        self.assertIsInstance(o["profile"], str)

    def test_sessions_carry_state_question_schedule_and_card(self) -> None:
        with kbc.connect_closing(board="dash") as conn:
            card = kb.create_task(conn, title="Ship the dashboard tab", assignee="someone", board="dash")
        asking = self.post("/sessions", {"prompt": "ask\nwrite dash-q.txt hi", "where": {"kind": "folder", "value": str(WORK)}, "mode": "ask", "title": "asks first", "tags": ["dash-test"]})
        written = Path(asking["cwd"]) / "dash-q.txt"
        later = self.post("/sessions", {"prompt": "echo later", "title": "later on", "where": {"kind": "folder", "value": str(WORK)}, "when": "at", "at": "+2h", "group": "Dash group"})
        self.assertIn("startAt", later)
        linked = json.loads(switchyard("new", str(WORK), "--detach", "--json", "-p", "echo linked", "--tag", "hermes:dash", "--tag", f"card:{card}").stdout)

        a = until(lambda: self.state_is(asking["id"], "needs_input"), "needs_input")
        self.assertEqual(a["question"]["title"], "Pick one")
        self.assertIn(a["question"]["kind"], ("ask", "select"), "a plain choice, not an approval")
        self.assertEqual(a["mode"], "ask")
        self.assertEqual(a["project"], WORK.name)
        self.assertIn("dash-test", a["tags"])
        q = self.view(later["id"])
        self.assertEqual(q["state"], "scheduled")
        self.assertEqual(q["startAt"], later["startAt"])
        self.assertEqual(q["group"], "Dash group")
        self.assertEqual(q["title"], "later on")
        ln = until(lambda: self.state_is(linked["id"], "idle"), "linked idle")
        self.assertEqual(ln["card"], {"board": "dash", "id": card, "title": "Ship the dashboard tab", "status": "ready", "parents": [], "children": []})
        self.assertEqual(ln["excerpt"], "linked")
        # The turn the state belongs to: the page's sound dedupe key (`updatedAt` differs between tabs polling at different moments).
        self.assertTrue(isinstance(ln.get("turnId"), str) and ln["turnId"], ln)

        # Detail: the full question and reply; answer it, then follow up, switch mode, stop.
        d = self.get(f"/sessions/{asking['id']}")
        choices = d["question"].get("options") or d["question"]["questions"][0]["options"]  # a `select`, or an `ask` with its questions
        self.assertEqual(choices[0], "alpha")
        # An answer names its question: none, or another question's id, answers nothing.
        self.post(f"/sessions/{asking['id']}/answer", {"answer": "1"}, status=400)
        self.post(f"/sessions/{asking['id']}/answer", {"answer": "1", "question": "not-this-one"}, status=400)
        self.assertEqual(self.view(asking["id"])["state"], "needs_input")
        self.assertFalse(written.exists())
        self.post(f"/sessions/{asking['id']}/answer", {"answer": "1", "question": d["question"]["id"]})
        until(lambda: written.exists(), "file written after the answer")
        until(lambda: self.state_is(asking["id"], "idle"), "idle after the answer")
        err = self.post(f"/sessions/{asking['id']}/answer", {"answer": "1", "question": d["question"]["id"]}, status=400)
        self.assertIn("not waiting", err["error"])
        self.post(f"/sessions/{asking['id']}/send", {"text": "echo once more"})
        until(lambda: (self.get(f"/sessions/{asking['id']}").get("reply") or "") == "once more", "follow-up reply")
        self.post(f"/sessions/{asking['id']}/mode", {"mode": "plan"})
        until(lambda: self.get(f"/sessions/{asking['id']}")["mode"] == "plan", "mode switched")
        self.post(f"/sessions/{asking['id']}/stop", {})
        until(lambda: self.state_is(asking["id"], "stopped"), "stopped")
        self.assertEqual(self.post(f"/sessions/{asking['id']}/mode", {"mode": "bogus"}, status=400)["error"], "mode must be one of ask, edits, plan, auto")
        self.assertIn("no session matches", self.get("/sessions/nope-nope", status=404)["error"])

    def test_queue_actions_run_retry_schedule(self) -> None:
        sid = self.post("/sessions", {"prompt": "error boom", "title": "dash queue", "where": {"kind": "folder", "value": str(WORK)}, "when": "queue"})["id"]
        failed = until(lambda: (v := self.view(sid)) and v["queue"]["failed"] == 1 and v, "the queued task fails")
        self.assertEqual((failed["queue"]["pending"], failed["autoRun"], failed["startAt"]), (0, False, None))

        # Nothing pending to run; a missing or unreadable time is refused.
        self.assertIn("no pending task", self.post(f"/sessions/{sid}/run", {}, status=409)["error"])
        self.assertIn("at:", self.post(f"/sessions/{sid}/schedule", {}, status=400)["error"])
        self.assertIn("error", self.post(f"/sessions/{sid}/schedule", {"at": "soonish"}, status=400))

        # Schedule, then Retry: the failed task waits for the start, which Retry keeps.
        at = self.post(f"/sessions/{sid}/schedule", {"at": "+2h"})["queue"]["startAt"]
        self.assertAlmostEqual(at / 1000, time.time() + 7200, delta=60)
        q = self.post(f"/sessions/{sid}/retry", {})["queue"]
        self.assertEqual((q["tasks"][0]["status"], q["startAt"], q["autoRun"]), ("pending", at, False))
        v = self.view(sid)
        self.assertEqual((v["state"], v["startAt"], v["queue"]["failed"], v["queue"]["pending"]), ("scheduled", at, 0, 1))
        # Pending work that already waits for its start has nothing to requeue (Run now starts it): refused, not silent.
        self.assertIn("nothing to requeue", self.post(f"/sessions/{sid}/retry", {}, status=400)["error"])

        # Reschedule (epoch ms, as the page may send), then unschedule: the task stays, the queue paused.
        later = int((time.time() + 3 * 3600) * 1000)
        self.assertAlmostEqual(self.post(f"/sessions/{sid}/schedule", {"at": later})["queue"]["startAt"], later, delta=60_000)
        q = self.post(f"/sessions/{sid}/schedule", {"at": None})["queue"]
        self.assertEqual((q.get("startAt"), q["autoRun"], q["tasks"][0]["status"]), (None, False, "pending"))

        # Run now: the task runs (and fails again); Retry then runs it again at once.
        self.assertTrue(self.post(f"/sessions/{sid}/run", {})["queue"]["autoRun"])
        until(lambda: base.queue_of(sid)["tasks"][0].get("status") == "failed", "run now ran it")
        first = base.queue_of(sid)["tasks"][0]["finishedAt"]
        self.post(f"/sessions/{sid}/retry", {})
        until(lambda: (t := base.queue_of(sid)["tasks"][0]).get("status") == "failed" and t.get("finishedAt", 0) > first, "retry reran it")
        self.assertIn("unknown action", self.post(f"/sessions/{sid}/requeue", {}, status=404)["error"])

    def test_start_validates_and_resolves_places(self) -> None:
        self.assertEqual(self.post("/sessions", {"where": {"kind": "folder", "value": str(WORK)}}, status=400)["error"], "write what omp should do")
        self.assertIn("pick where", self.post("/sessions", {"prompt": "echo x"}, status=400)["error"])
        self.assertIn("has no folder", self.post("/sessions", {"prompt": "echo x", "where": {"kind": "board", "value": "other"}}, status=400)["error"])
        self.assertIn("not a folder", self.post("/sessions", {"prompt": "echo x", "where": {"kind": "folder", "value": str(WORK / "missing")}}, status=400)["error"])
        queued = self.post("/sessions", {"prompt": "echo on the board\n\nmore detail", "where": {"kind": "board", "value": "proj"}, "when": "queue"})
        info = next(s for s in base.sessions() if s["meta"]["id"] == queued["id"])
        self.assertEqual(info.get("group"), "Project board")
        self.assertEqual(info["meta"]["title"], "echo on the board")
        places = self.get("/projects")
        self.assertTrue(any(f["path"] == str(WORK) for f in places["folders"]))
        self.assertTrue(any(b["slug"] == "proj" and b["folder"] == str(WORK) for b in places["boards"]))
        by_project = self.post("/sessions", {"prompt": "echo by project", "where": {"kind": "project", "value": WORK.name}})
        self.assertTrue(base.same_repo(by_project["cwd"], WORK))

    def test_boards_view_and_lane_settings(self) -> None:
        try:
            v = self.get("/boards")
            dash = next(b for b in v["boards"] if b["slug"] == "dash")
            self.assertFalse(dash["listed"])
            self.assertFalse(dash["lane"])
            proj = next(b for b in v["boards"] if b["slug"] == "proj")
            self.assertTrue(proj["lane"])
            self.assertEqual(proj["folder"], str(WORK))
            v = self.post("/boards/dash", {"folder": str(WORK), "group": "Dash", "mode": "edits", "lane": True})
            dash = next(b for b in v["boards"] if b["slug"] == "dash")
            self.assertEqual((dash["folder"], dash["group"], dash["mode"], dash["listed"], dash["lane"]), (str(WORK), "Dash", "edits", True, True))
            s = self.api.settings()
            self.assertEqual(s.lane.boards["dash"], {"folder": str(WORK), "group": "Dash", "mode": "edits"})
            self.assertEqual(s.lane.boards["proj"]["group"], "Project board", "other boards keep their settings")
            self.assertEqual(dash["effectiveCommentAuthors"], ["dashboard"], "the default: only the dashboard and Hermes Console")
            v = self.post("/boards/dash", {"commentAuthors": "Dashboard, alice"})
            dash = next(b for b in v["boards"] if b["slug"] == "dash")
            self.assertEqual((dash["commentAuthors"], dash["effectiveCommentAuthors"]), (["dashboard", "alice"], ["dashboard", "alice"]))
            v = self.post("/boards/dash", {"commentAuthors": ""})
            dash = next(b for b in v["boards"] if b["slug"] == "dash")
            self.assertEqual((dash["commentAuthors"], dash["effectiveCommentAuthors"]), (None, ["dashboard"]))
            v = self.post("/boards/dash", {"group": "", "lane": False})
            dash = next(b for b in v["boards"] if b["slug"] == "dash")
            self.assertFalse(dash["listed"])
            self.assertNotIn("dash", self.api.settings().lane.boards)
            self.assertIn("not a folder", self.post("/boards/proj", {"folder": "/no/such/folder"}, status=400)["error"])
            self.assertIn("no kanban board", self.post("/boards/nope", {"group": "x"}, status=404)["error"])
            self.assertFalse(self.post("/lane", {"enabled": False})["enabled"])
            self.assertFalse(self.api.settings().lane.enabled)
            self.assertTrue(self.post("/lane", {"enabled": True})["enabled"])
        finally:
            CONFIG.write_text(self.config_text)

    def test_cards_carry_their_dependency_links(self) -> None:
        kbb.create_board("graph", name="Graph board")
        with kbc.connect_closing(board="graph") as conn:
            plan = kb.create_task(conn, title="Plan", assignee="switchyard", board="graph")
            build = kb.create_task(conn, title="Build", assignee="someone", parents=[plan], board="graph")
            docs = kb.create_task(conn, title="Docs", assignee="someone", parents=[plan], board="graph")
            ship = kb.create_task(conn, title="Ship", assignee="someone", parents=[build, docs], board="graph")
            alone = kb.create_task(conn, title="Alone", assignee="someone", board="graph")
            gone = kb.create_task(conn, title="Old parent", assignee="someone", board="graph")
            kb.link_tasks(conn, gone, alone)
            kb.archive_task(conn, gone)
        tagged_sid = json.loads(switchyard("new", str(WORK), "--detach", "--json", "-p", "echo building", "--tag", "hermes:graph", "--tag", f"card:{build}").stdout)["id"]
        until(lambda: self.state_is(tagged_sid, "idle"), "tagged session idle")

        def graph_board() -> dict:
            return next(b for b in self.get("/boards")["boards"] if b["slug"] == "graph")

        g = graph_board()
        cards = {c["id"]: c for c in g["cards"]}
        self.assertNotIn(gone, cards, "archived cards are not on the graph")
        self.assertEqual(set(cards), {plan, build, docs, ship, alone})
        links = {cid: (sorted(c["parents"]), sorted(c["children"])) for cid, c in cards.items()}
        self.assertEqual(links[plan], ([], sorted([build, docs])))
        self.assertEqual(links[build], ([plan], [ship]))
        self.assertEqual(links[docs], ([plan], [ship]))
        self.assertEqual(links[ship], (sorted([build, docs]), []))
        self.assertEqual(links[alone], ([gone], []), "a link to an archived card is still reported")
        self.assertEqual((cards[ship]["status"], cards[plan]["status"]), ("todo", "ready"), "a child waits for its parents")
        # The session working on a card: a tagged session (not the lane's), with its state.
        self.assertEqual((cards[build]["session"], cards[build]["sessionState"], cards[build]["lane"]), (tagged_sid, "idle", False))
        self.assertEqual((cards[plan]["session"], cards[plan]["sessionState"], cards[plan]["lane"]), (None, None, False))
        # The lane's ready list carries the links too.
        self.assertEqual([(r["id"], r["parents"], sorted(r["children"])) for r in g["ready"]], [(plan, [], sorted([build, docs]))])
        # So do the sessions' card refs (card_lookup).
        v = self.view(tagged_sid)
        self.assertEqual((v["card"]["parents"], v["card"]["children"]), ([plan], [ship]))

        # A Hermes without the batched graph API: the task_links table gives the same links.
        with mock.patch.dict(kb.__dict__):
            del kb.task_graph_contexts
            old = {c["id"]: (sorted(c["parents"]), sorted(c["children"])) for c in graph_board()["cards"]}
        self.assertEqual(old, links)

    def test_graph_cards_carry_the_planners_state_of_their_session(self) -> None:
        # A real planner: the child card's task is queued after the parent card's session (what the lane does), so
        # the planner holds it as blocked until the parent finishes; a third card's task is scheduled.
        kbb.create_board("planned", name="Planned board")
        with kbc.connect_closing(board="planned") as conn:
            up = kb.create_task(conn, title="Upstream work", assignee="someone", board="planned")
            down = kb.create_task(conn, title="Downstream work", assignee="someone", parents=[up], board="planned")
            later = kb.create_task(conn, title="Later work", assignee="someone", parents=[up], board="planned")
        tags = lambda card: ("--tag", "hermes:planned", "--tag", f"card:{card}")  # noqa: E731
        up_sid = json.loads(switchyard("new", str(WORK), "--detach", "--json", "--task", "Upstream work", "--notes", "slow 60000", *tags(up)).stdout)["id"]
        until(lambda: self.state_is(up_sid, "working"), "parent session working")
        down_sid = json.loads(switchyard("new", str(WORK), "--detach", "--json", "--task", "Downstream work", "--after", up_sid, *tags(down)).stdout)["id"]
        later_sid = json.loads(switchyard("new", str(WORK), "--detach", "--json", "--task", "Later work", "--at", "+2h", *tags(later)).stdout)["id"]

        def cards() -> dict:
            b = next(b for b in self.get("/boards")["boards"] if b["slug"] == "planned")
            return {c["id"]: c for c in b["cards"]}

        c = until(lambda: (lambda cs: cs if (cs[down]["plan"] or {}).get("state") == "blocked" else None)(cards()), "the child's task blocked in the planner")
        self.assertEqual((c[down]["session"], c[down]["plan"]["after"], c[down]["plan"]["blockedBy"]), (down_sid, [up], [up]), "the planner's `after` is the card's parent")
        self.assertEqual(sorted(c[down]["parents"]), [up], "the Hermes link and the planner's edge agree")
        self.assertEqual((c[later]["session"], c[later]["plan"]["state"], c[later]["plan"]["after"], isinstance(c[later]["plan"].get("until"), (int, float))), (later_sid, "scheduled", [], True))
        self.assertEqual(c[up]["plan"]["state"], "running")

    def test_card_links_degrade_without_task_links(self) -> None:
        import sqlite3
        import types

        conn = sqlite3.connect(":memory:")
        try:
            # Neither the batched API nor a task_links table (a Hermes before dependencies): no links, no error.
            self.assertEqual(self.api.card_links(conn, types.SimpleNamespace(), ["a", "b", "a"]), {"a": {"parents": [], "children": []}, "b": {"parents": [], "children": []}})
            broken = types.SimpleNamespace(task_graph_contexts=mock.Mock(side_effect=sqlite3.OperationalError("no such table: task_links")))
            self.assertEqual(self.api.card_links(conn, broken, ["a"]), {"a": {"parents": [], "children": []}})
        finally:
            conn.close()

    def test_open_in_vscode_records_the_request_and_links_the_last_window(self) -> None:
        queued = self.post("/sessions", {"prompt": "echo vscode", "where": {"kind": "folder", "value": str(WORK)}, "when": "queue"})
        sid = queued["id"]
        request = base.SWITCHYARD_HOME / "vscode-open.json"
        window = base.SWITCHYARD_HOME / "vscode-window.json"
        try:
            window.unlink(missing_ok=True)
            link = self.post(f"/sessions/{sid[:8]}/vscode", {})
            self.assertEqual(link["url"], f"vscode://mbaradad.switchyard/open?session={sid}", "no window recorded: the extension's handler")
            self.assertIsNone(link["authority"])
            self.assertEqual(json.loads(request.read_text())["session"], sid)
            window.write_text(json.dumps({"authority": "ssh-remote+ws", "scheme": "vscode", "at": 1}))
            link = self.post(f"/sessions/{sid}/vscode", {})
            # The session's own folder: its AO worktree.
            self.assertEqual(link["url"], f"vscode://vscode-remote/ssh-remote+ws{base.report(sid)['cwd']}")
            self.assertEqual(link["authority"], "ssh-remote+ws")
            # The redirect page for Hermes Desktop: on the address the request came in on, link in the fragment.
            base_url, _, fragment = link["page"].partition("#")
            self.assertRegex(base_url, r"^http://testserver/dashboard-plugins/(@[^/]+/)?switchyard/open-vscode\.html$")
            self.assertEqual(urllib.parse.unquote(fragment), link["url"])
            self.assertTrue((API_FILE.parent / "open-vscode.html").is_file())
            self.assertIn("no session matches", self.post("/sessions/nope-nope/vscode", {}, status=400)["error"])
        finally:
            window.unlink(missing_ok=True)
            request.unlink(missing_ok=True)

    def test_open_project_and_known_folders_in_vscode(self) -> None:
        import subprocess

        repo = WORK / "proj-repo"
        pkg = repo / "pkg"
        pkg.mkdir(parents=True, exist_ok=True)
        # AO makes a project of the repository, which needs a commit on its default branch.
        subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
        (pkg / "README.md").write_text("pkg\n")
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], check=True)
        window = base.SWITCHYARD_HOME / "vscode-window.json"
        window.unlink(missing_ok=True)
        inside = json.loads(switchyard("new", str(pkg), "--detach", "--json", "-p", "echo in a repo").stdout)
        on_board = json.loads(switchyard("new", str(WORK), "--detach", "--json", "-p", "echo on a board", "--tag", "hermes:proj", "--tag", "card:t_none").stdout)
        # A session's project: the git repository holding its folder; a board's session: the board folder.
        link = self.post(f"/sessions/{inside['id']}/project", {})
        self.assertEqual(link["folder"], str(repo))
        self.assertTrue(link["url"].startswith("vscode://file/"), link)
        self.assertEqual(urllib.parse.unquote(link["page"].partition("#")[2]), link["url"])
        self.assertEqual(self.post(f"/sessions/{on_board['id']}/project", {})["folder"], str(WORK))
        # Folders the page shows open; anything else is refused.
        self.assertEqual(self.post("/folders/vscode", {"path": str(repo)})["folder"], str(repo), "an AO project's folder")
        self.assertIn("error", self.post("/folders/vscode", {"path": str(pkg)}, status=403), "a folder inside a project is not shown")
        self.assertEqual(self.post("/folders/vscode", {"path": str(WORK)})["folder"], str(WORK), "a board folder")
        self.assertIn("error", self.post("/folders/vscode", {"path": str(WORK.parent)}, status=403))
        self.assertIn("error", self.post("/folders/vscode", {"path": "/"}, status=403))
        self.assertIn("error", self.post("/folders/vscode", {"path": str(WORK / ".." / "..")}, status=403))
        self.assertIn("error", self.post("/folders/vscode", {"path": "relative/dir"}, status=400))

    def test_models_and_the_default_model(self) -> None:
        # Only a running session's omp knows the real list: with none running the CLI says so, with no models.
        for s in base.sessions():
            if s["meta"]["status"] in ("working", "waiting", "idle", "starting"):
                switchyard("stop", s["meta"]["id"], check=False)
        none = self.get("/models")
        self.assertEqual((none["models"], none.get("source")), ([], None), none)
        self.assertIn("no running session", none.get("note", ""), none)
        # A running session names itself as the source of the list.
        sid = self.new("-p", "slow 30000")
        until(lambda: self.state_is(sid, "working"), "a running session")
        m = until(lambda: (r := self.get("/models")) and r["models"] and r, "models from the running session")
        self.assertEqual(m["source"], sid)
        pick = m["models"][-1]["selector"]
        try:
            self.assertEqual(self.post("/models/default", {"model": pick})["default"], pick)
            self.assertEqual(self.get("/models")["default"], pick)
            self.assertIn("error", self.post("/models/default", {"model": 3}, status=400))
        finally:
            self.assertIsNone(self.post("/models/default", {"model": None})["default"])
            switchyard("stop", sid, check=False)

    def new(self, *args: str) -> str:
        return json.loads(switchyard("new", str(WORK), "--detach", "--json", *args).stdout)["id"]

    def test_archive_unarchive_complete_and_uncomplete_actions(self) -> None:
        sid = self.new("-p", "echo to archive")
        v = until(lambda: self.state_is(sid, "idle"), "idle")
        self.assertEqual((v["archived"], v["completed"]), (False, False))
        self.post(f"/sessions/{sid}/archive", {})
        self.assertTrue(self.view(sid)["archived"])
        self.post(f"/sessions/{sid[:8]}/unarchive", {})
        self.assertFalse(self.view(sid)["archived"])
        # complete/uncomplete run the real `switchyard complete|uncomplete <session> --json` (the marker the planner keeps on the session's lane).
        done = self.post(f"/sessions/{sid}/complete", {})
        self.assertEqual((done["ok"], done["id"], done["completed"], done["changed"]), (True, sid, True, True))
        self.assertIsInstance(done["completedAt"], int)
        v = self.view(sid)
        self.assertEqual((v["completed"], v["completedAt"]), (True, done["completedAt"]))
        self.assertIs(json.loads(switchyard("show", sid, "--json").stdout)["completed"], True, "the CLI reports the same marker")
        self.assertFalse(self.post(f"/sessions/{sid}/complete", {})["changed"], "completing twice changes nothing")
        reopened = self.post(f"/sessions/{sid[:8]}/uncomplete", {})
        self.assertEqual((reopened["completed"], reopened["changed"]), (False, True))
        self.assertEqual((self.view(sid)["completed"], self.view(sid)["completedAt"]), (False, None))
        self.assertIn("unknown action", self.post(f"/sessions/{sid}/bogus", {}, status=404)["error"])
        self.assertIn("invalid value", self.post("/sessions/--all/archive", {}, status=400)["error"], "a session reference is never a flag")

    def test_archive_done_archives_a_views_done_sessions_in_one_request(self) -> None:
        group = "Archive-all group"
        done1 = self.new(f"--group={group}", "-p", "echo one")
        done2 = self.new(f"--group={group}", "--tag", "hermes:dash", "-p", "echo two")
        elsewhere = self.new("-p", "echo three")
        already = self.new(f"--group={group}", "-p", "echo four")
        later = self.new(f"--group={group}", "--task=echo later", "--at=+2h")
        marked = self.new(f"--group={group}", "--task=echo marked", "--at=+3h")
        for sid in (done1, done2, elsewhere, already):
            until(lambda: self.state_is(sid, "idle"), f"{sid[:8]} idle")
        switchyard("archive", already)
        self.assertEqual(self.view(later)["state"], "scheduled")

        # The view's filters: board (a card's board or a hermes:<board> tag) and group.
        self.assertEqual(self.post("/sessions/archive-done", {"group": group, "board": "dash"}), {"archived": [done2], "failed": []})
        # A session marked completed (the real `switchyard complete`) is done whatever its state: `marked` is scheduled.
        self.post(f"/sessions/{marked}/complete", {})
        self.assertEqual(self.view(marked)["state"], "scheduled")
        r = self.post("/sessions/archive-done", {"group": group})
        self.assertEqual((set(r["archived"]), r["failed"]), ({done1, marked}, []), "idle with nothing queued, or completed; never one already archived")
        self.assertFalse(self.view(later)["archived"], "scheduled work is not done")
        self.assertTrue(all(self.view(s)["archived"] for s in (done1, done2, marked, already)))
        # `ids`: the sessions the page shows; only the done ones among them are archived.
        self.assertEqual(self.post("/sessions/archive-done", {"ids": [elsewhere, later]})["archived"], [elsewhere])
        self.assertFalse(self.view(later)["archived"])
        self.assertEqual(self.post("/sessions/archive-done", {"ids": [later]})["archived"], [])
        self.assertIn("ids must be", self.post("/sessions/archive-done", {"ids": elsewhere}, status=400)["error"])

    def test_board_archive_setting_and_archiving_a_boards_done_cards(self) -> None:
        try:
            v = self.post("/boards/dash", {"archiveCompleted": True})
            dash = next(b for b in v["boards"] if b["slug"] == "dash")
            self.assertEqual((dash["archiveCompleted"], dash["effectiveArchiveCompleted"], v["archiveCompleted"]), (True, True, False))
            self.assertIs(self.api.settings().lane.boards["dash"]["archive_completed"], True)
            v = self.post("/boards/dash", {"archiveCompleted": None})
            dash = next(b for b in v["boards"] if b["slug"] == "dash")
            self.assertEqual((dash["archiveCompleted"], dash["effectiveArchiveCompleted"]), (None, False), "back to the lane's setting")
            self.assertIn("archiveCompleted", self.post("/boards/dash", {"archiveCompleted": "yes"}, status=400)["error"])

            with kbc.connect_closing(board="dash") as conn:
                done = kb.create_task(conn, title="dash done", assignee="switchyard", board="dash")
                kb.complete_task(conn, done, result="ok")
                other = kb.create_task(conn, title="dash someone's", assignee="someone", board="dash")
                kb.complete_task(conn, other, result="ok")
            r = self.post("/boards/dash/archive-done", {})
            self.assertEqual((r["archived"], r["failed"]), ([done], {}))
            self.assertTrue(any(b["slug"] == "dash" for b in r["view"]["boards"]))
            with kbc.connect_closing(board="dash") as conn:
                self.assertEqual((kb.get_task(conn, done).status, kb.get_task(conn, other).status), ("archived", "done"))
            self.assertIn("no kanban board", self.post("/boards/nope/archive-done", {}, status=404)["error"])
        finally:
            CONFIG.write_text(self.config_text)

    def test_missing_switchyard_is_explained(self) -> None:
        with mock.patch.object(self.api.switchyard, "find_switchyard", return_value=None):
            self.assertTrue(self.get("/sessions", status=503)["error"])
            o = self.get("/overview")
            self.assertFalse(o["switchyard"]["found"])
            self.assertTrue(o["switchyard"]["hint"])


class PureDashboardTest(unittest.TestCase):
    def test_open_vscode_page_follows_only_switchyard_links(self) -> None:
        import re

        html = (base.PLUGIN_SRC / "dashboard" / "open-vscode.html").read_text()
        patterns = [re.compile(m) for m in re.findall(r"const (?:SESSION|REMOTE|FOLDER)_LINK = /(.+)/;", html)]
        self.assertEqual(len(patterns), 3)
        follows = lambda url: any(p.search(url) for p in patterns)  # noqa: E731
        for url in (
            "vscode://mbaradad.switchyard/open?session=0b8c2f6e-1a2b-4c3d-9e8f-0123456789ab",
            "vscode-insiders://mbaradad.switchyard/open?session=abc_123",
            f"vscode://vscode-remote/ssh-remote+ws{WORK}",
            "vscode://vscode-remote/wsl+Ubuntu/home/me/My%20Project",
            "vscodium://vscode-remote/ssh-remote+user@box.example/c:/src/app",
            "vscode://file/home/me/My%20Project",
            "vscode://file/C:/src/app",
            "vscode://file//server/share/x",
        ):
            self.assertTrue(follows(url), url)
        for url in (
            "vscode://other.extension/do?x=1",
            "vscode://mbaradad.switchyard/open?session=x&command=evil",
            "vscode://mbaradad.switchyard/open?session=%5Bx%5D(command:y)",
            "vscode-remote://ssh-remote+evil/x",
            "vscode://vscode-remote/ssh-remote+evil",
            "vscode://vscode-remote/ssh-remote+a/b?c",
            "vscode://vscode-remote/ssh-remote+a/b#c",
            "vscode://file",
            "vscode://file/x?windowId=1",
            "vscode://files/x",
            "javascript:alert(1)",
            "https://example.com/",
        ):
            self.assertFalse(follows(url), url)

    @classmethod
    def setUpClass(cls) -> None:
        if "hermes_plugins.switchyard" not in sys.modules:
            base.PluginManager().discover_and_load()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeAoServer(http.server.ThreadingHTTPServer):
    """Stands in for the Switchyard server's AO dashboard: echoes what it got, redirects, streams SSE."""

    daemon_threads = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), FakeAoHandler)
        self.stream_closed = threading.Event()


class FakeAoHandler(http.server.BaseHTTPRequestHandler):
    server: FakeAoServer

    def log_message(self, *_: object) -> None:
        pass

    def reply(self, status: int, body: bytes, headers: list[tuple[str, str]] = []) -> None:
        self.send_response(status)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def handle_any(self) -> None:
        path, _, query = self.path.partition("?")
        if path == "/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            try:
                self.wfile.write(b"data: one\n\n")
                self.wfile.flush()
                for _ in range(200):  # pings until the proxy closes the stream (or 20 s)
                    time.sleep(0.1)
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except OSError:
                self.server.stream_closed.set()
            return
        if path == "/go":
            return self.reply(302, b"", [("Location", f"http://127.0.0.1:{self.server.server_port}/echo?x=1")])
        if path == "/go-root":
            return self.reply(302, b"", [("Location", "/other")])
        if path == "/switchyard-ao-dashboard/status":
            return self.reply(200, json.dumps({"installed": True, "version": "1.2.3", "source": "test", "daemon": True, "port": self.server.server_port}).encode(), [("Content-Type", "application/json")])
        length = int(self.headers.get("Content-Length") or 0)
        got = {
            "method": self.command,
            "path": path,
            "query": query,
            "headers": [[k.lower(), v] for k, v in self.headers.items()],
            "body": self.rfile.read(length).decode() if length else "",
        }
        status = 418 if path == "/teapot" else 200
        extra = [("Content-Type", "application/json"), ("Set-Cookie", "ao=1; Path=/"), ("Connection", "X-Private"), ("X-Private", "hop"), ("Keep-Alive", "timeout=5"), ("X-Upstream", "yes")]
        self.reply(status, json.dumps(got).encode(), extra)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = handle_any


class AoDashboardProxyTest(unittest.TestCase):
    """/ao/…: the proxy to the Switchyard server's AO dashboard, against a fake AO server."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.api = sys.modules.get("hermes_dashboard_plugin_switchyard") or load_api()
        cls.upstream = FakeAoServer()
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        cls.port = cls.upstream.server_port
        cls.home = Path(tempfile.mkdtemp(prefix="omp-ao-dashboard-"))
        (cls.home / "config.json").write_text(json.dumps({"dashboardPort": cls.port}))
        cls.env = mock.patch.dict(os.environ, SWITCHYARD_HOME=str(cls.home))
        cls.env.start()
        cls.app = FastAPI()
        cls.app.include_router(cls.api.router, prefix="/api/plugins/switchyard")
        cls.client = TestClient(cls.app)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.env.stop()
        cls.upstream.shutdown()
        cls.upstream.server_close()

    def ao(self, method: str, path: str, **kw: object):
        return self.client.request(method, f"/api/plugins/switchyard/ao{path}", follow_redirects=False, **kw)

    def test_port_comes_from_switchyard_config(self) -> None:
        cases = [(None, 3012), ({}, 3012), ({"dashboardPort": 4567}, 4567), ({"dashboardPort": "4567"}, 3012), ({"dashboardPort": True}, 3012), ({"dashboardPort": 70000}, 3012), ({"dashboard": "on", "dashboardPort": 4000}, 4000), ({"dashboard": "off", "dashboardPort": 4000}, None), ([1], 3012)]
        for config, port in cases:
            with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, SWITCHYARD_HOME=home):
                if config is not None:
                    Path(home, "config.json").write_text(json.dumps(config))
                self.assertEqual(self.api.ao_dashboard_port(), port, config)
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, SWITCHYARD_HOME=home):
            Path(home, "config.json").write_text("{not json")
            self.assertEqual(self.api.ao_dashboard_port(), 3012)
            Path(home, "config.json").write_text(json.dumps({"dashboard": "off"}))
            r = self.ao("GET", "/")
            self.assertEqual(r.status_code, 404)
            self.assertIn('"dashboard": "off"', r.json()["error"])

    def test_forwards_the_request_without_the_browsers_origin_or_credentials(self) -> None:
        r = self.ao(
            "GET",
            "/assets/a%2Fb.js?x=1&y=%2F",
            headers={
                "Accept": "application/json",
                "X-Keep": "yes",
                "Origin": "https://hermes.example",
                "Referer": "https://hermes.example/switchyard",
                "Cookie": "hermes_session=secret",
                "Authorization": "Bearer secret",
                "X-Hermes-Session-Token": "secret",
                "Sec-Fetch-Site": "same-origin",
                "Sec-Fetch-Mode": "cors",
                "X-Forwarded-For": "10.0.0.1",
                "X-Forwarded-Proto": "https",
                "Forwarded": "for=10.0.0.1",
                "Connection": "keep-alive, X-Drop",
                "X-Drop": "hop",
            },
        )
        self.assertEqual(r.status_code, 200, r.text)
        got = r.json()
        self.assertEqual((got["method"], got["path"], got["query"]), ("GET", "/assets/a%2Fb.js", "x=1&y=%2F"))
        headers = dict(got["headers"])
        self.assertEqual(headers["host"], f"127.0.0.1:{self.port}")
        self.assertEqual(headers["accept"], "application/json")
        self.assertEqual(headers["x-keep"], "yes")
        for name in ("origin", "referer", "cookie", "authorization", "x-hermes-session-token", "sec-fetch-site", "sec-fetch-mode", "x-forwarded-for", "x-forwarded-proto", "forwarded", "x-drop"):
            self.assertNotIn(name, headers)
        # Back: AO's status and headers, minus hop-by-hop ones and cookies (they would be Hermes's origin's).
        self.assertEqual(r.headers["x-upstream"], "yes")
        for name in ("set-cookie", "x-private", "keep-alive"):
            self.assertNotIn(name, r.headers)
        self.assertEqual(self.ao("GET", "/teapot").status_code, 418)
        head = self.ao("HEAD", "/echo")
        self.assertEqual((head.status_code, head.content), (200, b""))

    def test_writes_carry_their_body_and_refuse_other_pages(self) -> None:
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            r = self.ao(method, "/api/v1/things", json={"n": 1}, headers={"Sec-Fetch-Site": "same-origin"})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual((r.json()["method"], json.loads(r.json()["body"])), (method, {"n": 1}))
        for site in ("cross-site", "same-site"):
            r = self.ao("POST", "/api/v1/things", json={}, headers={"Sec-Fetch-Site": site})
            self.assertEqual(r.status_code, 403, site)
            self.assertIn("own page", r.json()["error"])
        # A page load from elsewhere (a link, the landing page) is no write.
        self.assertEqual(self.ao("GET", "/", headers={"Sec-Fetch-Site": "cross-site"}).status_code, 200)

    def test_ao_without_slash_redirects_relative(self) -> None:
        r = self.ao("GET", "")
        self.assertEqual((r.status_code, r.headers["location"]), (307, "ao/"))
        self.assertEqual(self.ao("GET", "?a=1").headers["location"], "ao/?a=1")

    def test_redirects_stay_under_the_proxy(self) -> None:
        self.assertEqual(self.ao("GET", "/go").headers["location"], "/api/plugins/switchyard/ao/echo?x=1")
        self.assertEqual(self.ao("GET", "/go-root").headers["location"], "/api/plugins/switchyard/ao/other")
        r = self.ao("GET", "/go-root", headers={"X-Forwarded-Prefix": "/hermes"})
        self.assertEqual(r.headers["location"], "/hermes/api/plugins/switchyard/ao/other")

    def test_nothing_listening_is_502(self) -> None:
        port = free_port()
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, SWITCHYARD_HOME=home):
            Path(home, "config.json").write_text(json.dumps({"dashboardPort": port}))
            r = self.ao("GET", "/switchyard-ao-dashboard/status")
        self.assertEqual(r.status_code, 502)
        self.assertEqual(r.json()["error"], f"AO dashboard server not running on 127.0.0.1:{port} (switchyard server start)")

    def test_status_and_landing_page(self) -> None:
        self.assertEqual(self.ao("GET", "/switchyard-ao-dashboard/status").json()["version"], "1.2.3")
        scope = self.api.plugin_page("ao-dashboard.html", "")  # "/dashboard-plugins/[@profile/]switchyard/ao-dashboard.html"
        r = self.client.get("/api/plugins/switchyard/ao-page")
        self.assertEqual(r.json(), {"page": f"http://testserver{scope}", "port": self.port})
        r = self.client.get("/api/plugins/switchyard/ao-page", headers={"X-Forwarded-Prefix": "/hermes/"})
        self.assertEqual(r.json()["page"], f"http://testserver/hermes{scope}")
        self.assertTrue(scope.endswith("/switchyard/ao-dashboard.html"))
        html = (base.PLUGIN_SRC / "dashboard" / "ao-dashboard.html").read_text()
        for needle in ("/api/plugins/switchyard/ao/", "switchyard-ao-dashboard/status", "?next=${encodeURIComponent(location.pathname + location.search)}"):
            self.assertIn(needle, html)

    def test_streams_unbuffered_and_closes_upstream_when_the_browser_leaves(self) -> None:
        import uvicorn

        port = free_port()
        server = uvicorn.Server(uvicorn.Config(self.app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        try:
            until(lambda: server.started, "uvicorn started", timeout=10, every=0.05)
            self.upstream.stream_closed.clear()
            with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
                s.sendall(b"GET /api/plugins/switchyard/ao/stream HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n")
                got = b""
                while b"data: one" not in got:  # AO keeps the stream open: the first event must arrive on its own
                    chunk = s.recv(4096)
                    self.assertTrue(chunk, f"stream ended early: {got!r}")
                    got += chunk
                self.assertIn(b"text/event-stream", got)
                self.assertFalse(self.upstream.stream_closed.is_set())
            until(lambda: self.upstream.stream_closed.is_set(), "upstream stream closed after the browser left", timeout=10)
        finally:
            server.should_exit = True
            thread.join(10)


if __name__ == "__main__":
    unittest.main(verbosity=2)
