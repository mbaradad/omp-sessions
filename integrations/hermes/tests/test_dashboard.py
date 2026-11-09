"""The dashboard/Desktop backend (omp-sessions/dashboard/plugin_api.py), imported the way Hermes imports
it and mounted on a FastAPI app, against the real omp-sessions CLI + server with the fake omp and a real
kanban board. Shares test_plugin's temp homes (it sets them up on import)."""

from __future__ import annotations

import importlib.util
import json
import sys
import time
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

import test_plugin as base
from test_plugin import HERMES_HOME, WORK, omp_sessions, until

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from hermes_cli import kanban_db as kb  # noqa: E402
from hermes_cli import kanban_db_boards as kbb  # noqa: E402
from hermes_cli import kanban_db_connect as kbc  # noqa: E402

API_FILE = HERMES_HOME / "plugins" / "omp-sessions" / "dashboard" / "plugin_api.py"
CONFIG = HERMES_HOME / "config.yaml"


def load_api():
    """Like hermes_cli/web_server_dashboard.py::_mount_one_plugin_api."""
    name = "hermes_dashboard_plugin_omp-sessions"
    spec = importlib.util.spec_from_file_location(name, API_FILE)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


class DashboardApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        omp_sessions("server", "start", check=False)
        for slug in ("proj", "asking", "other"):  # test_plugin's boards (create_board is idempotent)
            kbb.create_board(slug, name=f"{slug.title()} board")
        kbb.create_board("dash", name="Dash board")
        cls.config_text = CONFIG.read_text()
        cls.api = load_api()
        app = FastAPI()
        app.include_router(cls.api.router, prefix="/api/plugins/omp-sessions")
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls) -> None:
        CONFIG.write_text(cls.config_text)
        for s in base.sessions():
            if s["meta"]["status"] != "stopped":
                omp_sessions("stop", s["meta"]["id"], check=False)

    def get(self, path: str, status: int = 200) -> dict:
        r = self.client.get(f"/api/plugins/omp-sessions{path}")
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    def post(self, path: str, body: dict, status: int = 200) -> dict:
        r = self.client.post(f"/api/plugins/omp-sessions{path}", json=body)
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    def view(self, sid: str) -> dict | None:
        return next((s for s in self.get("/sessions")["sessions"] if s["id"] == sid), None)

    def state_is(self, sid: str, state: str) -> dict | None:
        v = self.view(sid)
        return v if v and v["state"] == state else None

    def test_loads_its_own_package_and_reports_status(self) -> None:
        self.assertIn("omp_sessions_dashboard_plugin", sys.modules, "plugin_api imports the plugin folder as a package")
        o = self.get("/overview")
        self.assertTrue(o["ompSessions"]["found"])
        self.assertRegex(o["ompSessions"]["cli"], r"^\d+\.\d+\.\d+")
        self.assertTrue(o["scheduler"]["server"])
        self.assertTrue(o["lane"]["enabled"])
        self.assertEqual(o["lane"]["boards"], ["asking", "proj"])
        self.assertIsInstance(o["profile"], str)

    def test_sessions_carry_state_question_schedule_and_card(self) -> None:
        with kbc.connect_closing(board="dash") as conn:
            card = kb.create_task(conn, title="Ship the dashboard tab", assignee="someone", board="dash")
        asking = self.post("/sessions", {"prompt": "bash ls\nwrite dash-q.txt hi", "where": {"kind": "folder", "value": str(WORK)}, "mode": "ask", "title": "asks first", "tags": ["dash-test"]})
        written = Path(asking["cwd"]) / "dash-q.txt"
        later = self.post("/sessions", {"prompt": "echo later", "title": "later on", "where": {"kind": "folder", "value": str(WORK)}, "when": "at", "at": "+2h", "group": "Dash group"})
        self.assertIn("startAt", later)
        linked = json.loads(omp_sessions("new", str(WORK), "--detach", "--json", "-p", "echo linked", "--tag", "hermes:dash", "--tag", f"card:{card}").stdout)

        a = until(lambda: self.state_is(asking["id"], "needs_input"), "needs_input")
        self.assertEqual(a["question"]["title"], "$ ls")
        self.assertEqual(a["question"]["kind"], "select", "an approval the page shows as a choice")
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

        # Detail: the full question and reply; answer it, then follow up, switch mode, stop.
        d = self.get(f"/sessions/{asking['id']}")
        self.assertEqual(d["question"]["options"][0], "Allow once")
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
            plan = kb.create_task(conn, title="Plan", assignee="omp", board="graph")
            build = kb.create_task(conn, title="Build", assignee="someone", parents=[plan], board="graph")
            docs = kb.create_task(conn, title="Docs", assignee="someone", parents=[plan], board="graph")
            ship = kb.create_task(conn, title="Ship", assignee="someone", parents=[build, docs], board="graph")
            alone = kb.create_task(conn, title="Alone", assignee="someone", board="graph")
            gone = kb.create_task(conn, title="Old parent", assignee="someone", board="graph")
            kb.link_tasks(conn, gone, alone)
            kb.archive_task(conn, gone)
        tagged_sid = json.loads(omp_sessions("new", str(WORK), "--detach", "--json", "-p", "echo building", "--tag", "hermes:graph", "--tag", f"card:{build}").stdout)["id"]
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
        request = base.OMP_HOME / "vscode-open.json"
        window = base.OMP_HOME / "vscode-window.json"
        try:
            window.unlink(missing_ok=True)
            link = self.post(f"/sessions/{sid[:8]}/vscode", {})
            self.assertEqual(link["url"], f"vscode://mbaradad.omp-sessions/open?session={sid}", "no window recorded: the extension's handler")
            self.assertIsNone(link["authority"])
            self.assertEqual(json.loads(request.read_text())["session"], sid)
            window.write_text(json.dumps({"authority": "ssh-remote+ws", "scheme": "vscode", "at": 1}))
            link = self.post(f"/sessions/{sid}/vscode", {})
            # The session's own folder: its AO worktree.
            self.assertEqual(link["url"], f"vscode://vscode-remote/ssh-remote+ws{base.report(sid)['cwd']}")
            self.assertEqual(link["authority"], "ssh-remote+ws")
            # The redirect page for Hermes Desktop: on the address the request came in on, link in the fragment.
            base_url, _, fragment = link["page"].partition("#")
            self.assertRegex(base_url, r"^http://testserver/dashboard-plugins/(@[^/]+/)?omp-sessions/open-vscode\.html$")
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
        window = base.OMP_HOME / "vscode-window.json"
        window.unlink(missing_ok=True)
        inside = json.loads(omp_sessions("new", str(pkg), "--detach", "--json", "-p", "echo in a repo").stdout)
        on_board = json.loads(omp_sessions("new", str(WORK), "--detach", "--json", "-p", "echo on a board", "--tag", "hermes:proj", "--tag", "card:t_none").stdout)
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
        m = self.get("/models")
        self.assertTrue(m["models"], m)
        pick = m["models"][-1]["selector"]
        try:
            self.assertEqual(self.post("/models/default", {"model": pick})["default"], pick)
            self.assertEqual(self.get("/models")["default"], pick)
            self.assertIn("error", self.post("/models/default", {"model": 3}, status=400))
        finally:
            self.assertIsNone(self.post("/models/default", {"model": None})["default"])

    def new(self, *args: str) -> str:
        return json.loads(omp_sessions("new", str(WORK), "--detach", "--json", *args).stdout)["id"]

    def test_archive_unarchive_complete_and_uncomplete_actions(self) -> None:
        sid = self.new("-p", "echo to archive")
        v = until(lambda: self.state_is(sid, "idle"), "idle")
        self.assertEqual((v["archived"], v["completed"]), (False, False))
        self.post(f"/sessions/{sid}/archive", {})
        self.assertTrue(self.view(sid)["archived"])
        self.post(f"/sessions/{sid[:8]}/unarchive", {})
        self.assertFalse(self.view(sid)["archived"])
        # complete/uncomplete run `omp-sessions complete|uncomplete <session> --json` (stubbed here, so the
        # test doesn't depend on the CLI version the plugin runs against).
        calls: list[list[str]] = []
        real_json = self.api.ompsessions.OmpSessions.json

        def fake_json(o, args, **kw):
            if args[0] in ("complete", "uncomplete"):
                calls.append(list(args))
                return {"id": sid, "completed": args[0] == "complete", "changed": True}
            return real_json(o, args, **kw)

        with mock.patch.object(self.api.ompsessions.OmpSessions, "json", fake_json):
            self.assertEqual(self.post(f"/sessions/{sid}/complete", {}), {"ok": True, "id": sid, "completed": True, "changed": True})
            self.assertFalse(self.post(f"/sessions/{sid}/uncomplete", {})["completed"])
        self.assertEqual(calls, [["complete", sid, "--json"], ["uncomplete", sid, "--json"]])
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
        omp_sessions("archive", already)
        self.assertEqual(self.view(later)["state"], "scheduled")

        # The view's filters: board (a card's board or a hermes:<board> tag) and group.
        self.assertEqual(self.post("/sessions/archive-done", {"group": group, "board": "dash"}), {"archived": [done2], "failed": []})
        # A session marked completed is done whatever its state (stubbed: `ls --json` reports `completed`).
        real_sessions = self.api.ompsessions.OmpSessions.sessions

        def with_completed(o, all=True):
            out = real_sessions(o, all)
            for i in out:
                if i["meta"]["id"] == marked:
                    i["completed"] = True
            return out

        with mock.patch.object(self.api.ompsessions.OmpSessions, "sessions", with_completed):
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
                done = kb.create_task(conn, title="dash done", assignee="omp", board="dash")
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

    def test_missing_omp_sessions_is_explained(self) -> None:
        with mock.patch.object(self.api.ompsessions, "find_omp_sessions", return_value=None):
            self.assertTrue(self.get("/sessions", status=503)["error"])
            o = self.get("/overview")
            self.assertFalse(o["ompSessions"]["found"])
            self.assertTrue(o["ompSessions"]["hint"])


class PureDashboardTest(unittest.TestCase):
    def test_open_vscode_page_follows_only_omp_sessions_links(self) -> None:
        import re

        html = (base.PLUGIN_SRC / "dashboard" / "open-vscode.html").read_text()
        patterns = [re.compile(m) for m in re.findall(r"const (?:SESSION|REMOTE|FOLDER)_LINK = /(.+)/;", html)]
        self.assertEqual(len(patterns), 3)
        follows = lambda url: any(p.search(url) for p in patterns)  # noqa: E731
        for url in (
            "vscode://mbaradad.omp-sessions/open?session=0b8c2f6e-1a2b-4c3d-9e8f-0123456789ab",
            "vscode-insiders://mbaradad.omp-sessions/open?session=abc_123",
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
            "vscode://mbaradad.omp-sessions/open?session=x&command=evil",
            "vscode://mbaradad.omp-sessions/open?session=%5Bx%5D(command:y)",
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
        if "hermes_plugins.omp_sessions" not in sys.modules:
            base.PluginManager().discover_and_load()


if __name__ == "__main__":
    unittest.main(verbosity=2)
