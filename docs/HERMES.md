# Hermes Agent: the switchyard plugin

[Hermes Agent](https://github.com/NousResearch/hermes-agent) can hand coding work to omp. The `switchyard` Hermes plugin gives it:

- **Tools** (toolset `switchyard`, 16 tools) to start, queue, schedule, check, wait on, answer, steer and stop omp sessions, chain them (`after`), sync a parent's changes into them, switch their model, and check the Switchyard setup (the Agent Orchestrator daemon and omp).
- **Notifications.** When an omp session that a Hermes session started finishes or needs input, Hermes gets a message about it in that session, so it doesn't have to poll.
- **A kanban lane.** Kanban cards assigned to `switchyard` run as omp sessions, and their outcome goes back to the card. Hermes's dependency chaining works as usual: a child card starts when its parents are done, with their results in its prompt.
- The **`switchyard` skill**, plus `/switchyard` in chats and `hermes switchyard …` in a terminal.

The plugin drives the `switchyard` CLI, so every session it starts is an ordinary omp session run by [Agent Orchestrator](https://github.com/OrchestratorInc/agent-orchestrator) (AO), the daemon behind Switchyard. The plugin never talks to AO itself: `switchyard` is the one client that maps AO sessions onto Switchyard states, questions, queues and costs, the same way for VS Code, the CLI and Hermes. You can watch and steer a session from the Switchyard page in Hermes, with `switchyard attach`, in the AO app or AO Mobile, or in VS Code (Switchyard). Queued sessions respect omp's global concurrency limit (`switchyard sched set <n>`).

For the whole arrangement (one workstation running omp, the AO daemon and Hermes; VS Code and Hermes Desktop on a laptop; AO Mobile on the phone), see [the setup guide](SETUP.md).

## Install

You need `switchyard` (VS Code: **Switchyard: Install switchyard Command**, or the standalone package: see the [README](../README.md#get-started)) and Hermes Agent 0.23 or later. Install the plugin either from switchyard or with Hermes's own plugin installer.

**From switchyard** (the copy that ships with the extension, always matching your `switchyard`):

```sh
switchyard hermes install     # copy the plugin into $HERMES_HOME/plugins (default ~/.hermes) and enable it
switchyard hermes status      # per profile: installed, current or outdated, enabled, lane on or off
switchyard hermes uninstall
```

**From Git**, with Hermes (it fetches only the plugin folder of this repository):

```sh
hermes plugins install mbaradad/omp-sessions/integrations/hermes/switchyard --enable
hermes config set plugins.entries.switchyard.allow_gateway_injection true
hermes plugins update switchyard      # later, to update
```

Add `-p <profile>` (`hermes -p <profile> plugins install …`) for other profiles. Once the plugin is listed in the [Hermes plugin catalog](https://hermes-agent.nousresearch.com/docs/plugins), `hermes plugins install switchyard` installs the reviewed version by name.

An older copy of this plugin installed as `omp-sessions` is no longer managed by Switchyard: remove it with `hermes plugins disable omp-sessions` and delete its folder (`<home>/plugins/omp-sessions/`).

`install` copies the plugin to `<home>/plugins/switchyard/` and runs these two commands against that profile:

- `hermes plugins enable switchyard`
- `hermes config set plugins.entries.switchyard.allow_gateway_injection true` (this lets the plugin message Hermes sessions)

A running gateway loads a plugin as soon as it is enabled. The tools then appear in new Hermes sessions. If `hermes plugins list` shows the plugin as enabled but the tools are missing, restart the gateway with `hermes gateway restart`. A plugin folder that switchyard didn't install is only replaced with `--force`.

**Updates are automatic.** When the extension updates, it refreshes the copies switchyard installed (the `.managed-by-switchyard` marker; copies 0.5.0 and earlier installed carry an older marker and count too) in every profile, and says once what changed. It only replaces a copy when its bundled plugin is newer: a higher `plugin.yaml` version, or the same version from a later build (the marker records the build). So editors with different extension versions (Stable, Insiders, a fork) never downgrade each other; the Doctor shows a newer copy as such. Copies installed from Git or the catalog are never touched; update those with `hermes plugins update switchyard`. `switchyard hermes install` replaces the copy with the one it ships, whatever its version. Installs take a lock in the profile's `plugins/` folder (`.switchyard.install.lock`), so several windows don't race: a window that finds it held skips that profile. Where the plugin was enabled, the update disables and re-enables it, which makes the running gateway reload it in place: hooks and commands (notifications, the kanban lane) use the new code at once and tools from the next Hermes session, with no gateway restart and running chats untouched. If enabling it again fails twice, you're told plainly that it was left disabled in that profile (VS Code offers Enable). Only the dashboard's page backend (`dashboard/plugin_api.py`) waits for a dashboard restart; you're told when files under `dashboard/` changed. Nothing restarts the gateway or the dashboard for you.

### In VS Code

Sessions started from Hermes show where they came from. Those started by the Hermes tools (`switchyard_session_start`) are tagged `hermes` and show a **Hermes** chip; those started by the kanban lane are tagged `hermes`, `hermes:<board>` and `card:<task id>` and show **Hermes · board · card** in the Sessions view and in the chat header. For a card, **Open Hermes Card** (chip, chat menu or right-click in the Sessions view) opens the Kanban page of the Hermes dashboard (`omp.hermes.dashboardUrl`; empty, the default, uses the dashboard Hermes reports running on the machine, at whatever port, else `http://localhost:9119`; in a Remote-SSH or WSL window a `localhost` address is forwarded to your machine; with no dashboard running it offers **Show Hermes Card**). The Kanban page has no link to one card, so it opens on the board you picked last and the status bar names the card. **Show Hermes Card** runs `hermes kanban --board <board> show <id>` (no shell) and shows the card as text in a read-only *Hermes Card* output channel.

**Switchyard Doctor** (*Switchyard: Run Doctor*) has a Hermes section when Hermes is installed: the plugin in each profile (current, outdated, disabled, or installed from Git), notifications (`allow_gateway_injection`, and whether Hermes refused the last one), the kanban dispatcher's last tick and the profile it reaches, the lane being on in several profiles or in a profile the dispatcher doesn't tick, and whether the plugin finds `switchyard` (its `switchyard` setting, the running gateway's `PATH` (read on Linux), or where *Switchyard: Install switchyard Command* puts it). Problems come with one-click fixes: Update, Enable, Allow, Turn the lane on/off in a profile (it asks first), Install switchyard.

### Profiles

Hermes plugins are installed and enabled per profile. Each profile is a Hermes home with its own `config.yaml`, `plugins/` and plugin settings. Every `switchyard hermes` command takes the same profile flags:

| Flags | Homes |
| --- | --- |
| (none) | `$HERMES_HOME`, else `~/.hermes` (the default profile) |
| `--profile <name>` (repeatable) | `~/.hermes/profiles/<name>` (`default` is `~/.hermes` itself). The `hermes` steps run as `hermes -p <name> …`. |
| `--all-profiles` | the default profile and every named profile |

```sh
switchyard hermes install --profile lightscale --profile lightscale-zynq-prototyper
switchyard hermes status --all-profiles
```

Only real profiles are accepted. Like Hermes, switchyard counts a folder under `profiles/` as a profile when it has one of `config.yaml`, `.env`, `SOUL.md`, `profile.yaml`, `auth.json` or `state.db`, and `hermes profile delete` hasn't removed it. Folders that only logs or cron created are skipped.

**Switchyard: Install Hermes Plugin…** in VS Code first asks what to do (install or update, show status, uninstall), then which profiles to apply it to. For install, it pre-selects the default profile plus any profile whose `config.yaml` sets `kanban: dispatch_in_gateway: true`. It then shows each profile's status, and `hermes switchyard status` for profiles where the lane is on.

Install the plugin in the profiles you chat with: tools and notifications work in the profile whose session calls them. **Turn the kanban lane on in one profile only.** That is the profile whose gateway runs the kanban dispatcher, and its lane settings (boards, folders, modes) are the ones that apply.

## Tools

| Tool | What it does |
| --- | --- |
| `switchyard_sessions_list` | Lists sessions: running and with work ahead (queued, scheduled, interrupted), or all with `all: true`. |
| `switchyard_projects_list` | Lists where sessions can run: recent omp folders, kanban boards with their configured folders and groups, and Hermes projects. |
| `switchyard_session_start` | Starts a session now (`prompt`) or queues one (`task`, with optional `notes` and `subtasks`). `at` schedules a queued task (`+30m`, `14:30`, an ISO time); `after` (with `task`) names sessions whose work must finish first: the task branches from their work and later gets their changes (see [Parent changes](#parent-changes)). Where it runs is set by `cwd`, `project` (a Hermes project, or the name of a known folder) or `board` (that board's folder and group). Also takes `title`, `mode` (`ask`, `edits`, `plan`, `auto`), `group`, `tags`, `priority` and `model`. |
| `switchyard_session_status` | Returns a session's state, pending question, last reply, queue, cost, changed files, and `upstream`: the sync state of each parent. |
| `switchyard_session_wait` | Blocks until the session is idle, needs input, stopped or interrupted, or scheduled. The default timeout is 300 s, at most 600 s. |
| `switchyard_session_send` | Sends a prompt (resuming a stopped session). While the session works, the prompt runs after the current turn; `steer: true` redirects the turn instead. |
| `switchyard_session_answer` | Answers the waiting question with an option number or text, yes/no, or free text. Refused for approval dialogs unless `agent_approvals` is on. |
| `switchyard_session_mode` | Switches the permission mode live. Unless `agent_approvals` is on, it refuses while an approval waits (the switch would answer it) and refuses switching to a less restrictive mode (plan < ask < edits < auto; a session without a mode counts as ask). |
| `switchyard_session_model` | Shows the session's model, or switches it (live while it runs, else from its next resume). |
| `switchyard_session_stop` | Stops the session, or cancels a scheduled start. Its history stays, and `switchyard_session_send` resumes it. |
| `switchyard_queue_add` | Adds a task to an existing session's queue: `task` is a one-line title, `notes` the full task for omp, plus `subtasks`; `top` puts it first, `run` turns the queue on; `after` sets the sessions the queue waits for. |
| `switchyard_queue_schedule` | Sets or changes when a session's queue starts (`at`), cancels it (`at: "off"`), and/or sets its `priority`. |
| `switchyard_models_list` | Lists the models omp can use (`provider/id`), with the Switchyard default and omp's own. |
| `switchyard_server_status` | The `switchyard status` overview: server, omp, sessions by state, tasks, scheduler, remote access and problems. |
| `switchyard_plan_status` | Lists the graph's edges (parent → child) with their sync state and conflicting files, for one session or every plan. |
| `switchyard_plan_sync` | Brings a session's parents' changes into its worktree now and returns each edge's sync state; `rerun: true` also runs its task again with them. |

States: `queued` (waiting for a slot), `scheduled` (waiting for its start time), `starting`, `working`, `needs_input`, `idle` (done for now), `interrupted` (a crash or reboot cut a queued task short; it waits for a person), `stopped`.

**Approvals stay with people.** Select and confirm dialogs (tool approvals, plan approval) count as approvals. By default the Hermes agent can't answer them, can't switch the mode while one waits, and can't switch a session to a less restrictive mode; set `agent_approvals: true` in the plugin settings to allow it. Answers carry the question's id, so an answer is refused if a different dialog has come up meanwhile. omp's text in tool results and chat notes is marked as data, not instructions.

**Models.** A session started by the tools or the lane uses, in order: the `model` given (or a card's own model override), the board's `model`, then the Switchyard default (`switchyard config set model`), then omp's own default.

## Notifications

`switchyard_session_start`, `switchyard_session_send` and `switchyard_session_answer` remember which Hermes session called them. Once that omp session settles (idle, needs input or stopped), the plugin queues a short message into the Hermes session. The message gives the title, the state, a reply excerpt or the question, and `switchyard show <id>`. An idle Hermes session starts a turn on it; a busy one gets it after its current turn. If the agent already saw that state through `switchyard_session_status` or `switchyard_session_wait`, no message is sent.

Notifications need:

- a running Hermes gateway (Hermes 0.23 runs every session in it);
- `plugins.entries.switchyard.allow_gateway_injection: true` (`switchyard hermes install` sets it);
- the gateway's kanban dispatcher. The plugin checks sessions on its tick, every 60 s by default (`kanban.dispatch_interval_seconds`).

Turn notifications off with `hermes switchyard notify off`.

## Kanban lane

Hermes's dispatcher only spawns workers for cards assigned to a Hermes profile. A card assigned to anything else (here, `omp`) stays `ready`, and the dispatcher logs `skipped_nonspawnable`. On every dispatcher tick, the lane:

1. **Claims** ready cards assigned to `switchyard`, using Hermes's kanban API with a claim lock `<host>:switchyard`. It only takes cards while omp has free concurrency slots (`switchyard sched`), at most 4 per tick.
2. **Prepares the workspace** the way Hermes prepares one for its own workers:
   - `worktree`: a git worktree on the card's branch (default `wt/<card id>`), recorded on the card;
   - `dir`: that folder;
   - `scratch`: the folder of the card's Hermes project, else the board's configured `folder`, else Hermes's scratch folder.
3. **Queues an omp session** there. The title is the card title. The task notes hold:
   - a note that the session works on card `<board>/<id>` and that the lane reports back on its own, so the agent needs no kanban tools;
   - the card's worker context exactly as Hermes builds it for its own workers (body, parent results, comments);
   - the paths of the `SKILL.md` files the card asks for.

   The session gets the tags `hermes`, `hermes:<board>` and `card:<id>`, goes into the board's omp group, and starts in the board's permission mode, if one is set.
4. **Comments** on the card with the session id and how to watch it: the Switchyard page, `switchyard attach <id>`, the AO app or AO Mobile, or VS Code.
5. **Tracks** the session and mirrors it onto the card:

| Session | Card |
| --- | --- |
| queued or working | The claim is renewed every tick, and a heartbeat is recorded every 10 minutes. |
| scheduled | The card stays claimed; comments are held until the session runs. |
| waiting on a question or approval | `block --kind needs_input` with the question and how to answer it. Once the session moves on, the card is unblocked and claimed again. |
| task done (idle, or stopped afterwards) | `complete`. The result is the session's last reply, and so is the run summary that child cards read. The metadata holds the omp session id, folder, cost (including subagents) and changed-file count. |
| interrupted (crash or reboot during the task) | Blocked with the reason and "Unblock the card to continue it in the same session". Unblocking starts the queue again. |
| task failed, session stopped early, or session removed | `block --kind transient` with the reason. |
| a parent's changes don't merge into its worktree (`conflict`) | `block --kind needs_input` with the files. Resolve the merge in the session (a card comment reaches it); the card is unblocked once the edge is merged. |
| card done, archived, deleted or reassigned | The lane stops tracking it and leaves the session alone. A done card whose parent changes later gets one comment saying how to re-run it (below). |

Unblocking a card that failed (in Hermes: `hermes kanban unblock <id>`) retries it in the same omp session, or in a new one if the session was removed.

The card↔session links and the lane's lock live beside the kanban boards, which every profile shares: `~/.hermes/plugin-data/switchyard-lane/` (`state.json`, `lane.lock`). Before it creates a session, the lane also looks for an omp session tagged `card:<id>`. A card never gets two sessions, even across restarts or crashes.

### Parent changes

A card whose Hermes parents ran in the lane is queued with those parents' sessions as `after`, so its omp session branches from their work instead of the repository base. When a parent changes later (a follow-up, a re-run), the planner merges the change into each child's worktree: a child that is working gets it after its turn, an idle one gets it with a note, a done one is marked **upstream changed** and is not run again. Each edge has a sync state: `in-sync`, `pending`, `merged`, `conflict` or `upstream-changed`.

- A `conflict` blocks the child's card (see the table above). The session itself does not turn `needs_input` (and `switchyard_session_wait` doesn't return for it): read `upstream.state` in `switchyard_session_status` (the worst of its parent edges: conflict > resolving > upstream-changed > pending > merged > in-sync).
- An `upstream-changed` card gets one comment. Re-run it with `switchyard plan sync <session> --rerun`, **Re-run with parent changes** on the Switchyard page, or `switchyard_plan_sync` with `rerun: true`.
- `switchyard plan status` lists every edge; the Switchyard page shows a **merge conflict** or **parent changed** chip on the card and the parents' states in the detail panel, with **Sync now**.

### Several profiles

The plugin may be enabled in several profiles, and their gateways may each tick the dispatcher. This is what the plugin guarantees:

- **One lane pass at a time on the machine.** A lane pass takes `lane.lock` with an exclusive file lock (`flock`) and skips the tick if another process holds it. Whichever profile ticks next does the next pass. On Windows, the lock only works within one process.
- **Shared links.** Every profile reads and writes the same links. A card claimed in one profile is tracked and finished from any of them, and is never started twice.
- **A card keeps the assignee it was claimed for.** If another profile's lane settings name a different assignee, that doesn't make the lane drop the card.
- **New cards follow the settings of whichever profile has its lane on.** A profile whose lane is off claims nothing, but it still reports on cards that are already linked.

The lane is off by default. Turn it on in one profile (`hermes -p <name> switchyard lane on`). `switchyard hermes status --all-profiles` warns when it is on in more than one, and `hermes switchyard status` shows where the shared state lives.

Hermes runs one kanban dispatcher per machine (a lock at `<kanban home>/kanban/.dispatcher.lock`), in the gateway that took it. With the default multiplexed gateway (one gateway serving every profile) that is the default profile, so turn the lane on there: `hermes -p default switchyard lane on`. Without `-p`, `hermes switchyard …` acts on the active profile (`hermes profile use`), which may not be the one you mean.

### Assign cards to omp

```sh
hermes kanban --board lightscale create "Fix the flaky upload test" --assignee switchyard --body "…"
hermes kanban --board lightscale create "Release notes" --assignee switchyard --parent t_1234abcd   # starts when the parent is done
hermes kanban --board lightscale create "Refactor" --assignee switchyard --workspace worktree --branch refactor/x
hermes kanban --board lightscale assign t_1234abcd omp      # an existing card (not while it is running)
```

`--board` goes before the verb. A card without parents starts `ready`; with open parents it waits in `todo` until they are done.

From any chat (including clients whose assignee picker lists only Hermes profiles, such as Hermes Console), `/switchyard take <card id> [board]` assigns an existing card to the lane's assignee; `hermes switchyard take <card id> [--board b]` does the same in a terminal. On a board the lane takes, a comment from a trusted author that mentions `@switchyard` does it too.

### Talk to a card's session through comments

Comments on a card the lane runs can reach its omp session, but only from **trusted authors**: `lane.comment_authors`, default `["dashboard"]`, which is what the Hermes dashboard and Hermes Console post as (`*` trusts anyone). Hermes agents comment under their profile name, so another profile's agent, which may act on untrusted input, can't prompt omp or hand it cards unless you list that profile. A comment from anyone else gets one note per author per card saying it doesn't reach the session. Approvals are never answered by comments.

- While omp waits on a question (ask, input or editor), the first new comment is the answer (an option's number or label, or free text); the lane then unblocks the card. If it doesn't fit the question, the lane says so and tries the next comment.
- **Approvals are never answered by comments.** While one waits, comments are held, the card gets one note saying where to approve (the Switchyard page, the AO app or AO Mobile, VS Code or `switchyard answer`), and the comments are delivered after it's answered.
- Otherwise comments arrive as a message: a follow-up while omp works, a new prompt once it is idle (the card is completed again from the new reply). omp sees each one wrapped as `<kanban-comment author="…">`.
- Comments are held until the card's queued task has started, so they never jump the concurrency limit or a scheduled start.
- The lane confirms each delivery with its own comment (`omp session 1a2b3c4d: passed the comment on`), and says so when omp rejects an answer. If a comment can't be delivered, the card gets one "Couldn't reach omp session …" note and the lane retries on later passes, giving up (and saying so) after 5 tries.

### Turn it on and configure it

```sh
hermes switchyard lane on                                   # every board, assignee switchyard
hermes switchyard lane on --board lightscale --mode auto    # only these boards (repeat --board); starting permission mode
hermes switchyard lane on --comment-authors dashboard,alice # whose comments reach omp ("*": anyone)
hermes switchyard board lightscale --folder ~/src/lightscale --group Lightscale --mode auto --model anthropic/claude-sonnet-4-5
hermes switchyard project lightscale ~/src/lightscale       # folder for a Hermes project, by id, slug or name
hermes switchyard lane off                                  # stop taking new cards; linked cards keep reporting
hermes switchyard lane run                                  # one pass now
hermes switchyard lane on --archive-completed on            # archive each card (and its omp session) once the lane completes it
hermes switchyard board lightscale --archive-completed on   # the same for one board (off; default: the lane's setting)
hermes switchyard archive-done --board lightscale          # archive a board's done lane cards and their omp sessions now (repeat --board; default: every board)
hermes switchyard status                                    # lane, last passes, errors, linked cards and their sessions
```

The settings live in Hermes's `config.yaml`:

```yaml
plugins:
  entries:
    switchyard:
      allow_gateway_injection: true
      settings:
        switchyard: /path/to/switchyard  # default: PATH, then ~/.local/bin/switchyard (%LOCALAPPDATA%\switchyard\switchyard.cmd on Windows), then ~/.switchyard/runtime/cli.js
        notify: true
        agent_approvals: false         # true: the Hermes agent may answer approval dialogs
        lane:
          enabled: true
          assignee: switchyard
          mode: auto                   # unset: the Switchyard default (switchyard config set mode), else auto (nothing asks); ask/edits/plan need Switchyard's omp extension (switchyard status shows it) and make cards wait for a person at the first command
          comment_authors: [dashboard] # whose comments reach omp and whose @switchyard assigns cards ("*": anyone)
          archive_completed: false     # true: archive a card on the board, and its omp session, as soon as the lane completes it
          boards:                      # empty: every board
            lightscale:
              folder: /home/me/src/lightscale
              group: Lightscale        # default: the board's name
              mode: auto
              model: anthropic/claude-sonnet-4-5   # unset: the Switchyard default
              comment_authors: [dashboard, alice]  # replaces the lane's list on this board
              archive_completed: true              # replaces the lane's archive_completed on this board
        projects:
          lightscale: /home/me/src/lightscale
```

### Archiving done cards

Done cards pile up on a board. With `archive_completed` on (the lane's setting, or a board's own), the lane archives a card right after it completes it, with the card's result kept, and archives the card's omp session too (`switchyard archive`; it stays in `ls --all` and under *Show archived* on the page). It is off by default.

`hermes switchyard archive-done [--board <slug>]` does it in one go for the cards already done: every `done` card assigned to the board's lane assignee, or run by an omp session (tagged `hermes:<board>` and `card:<id>`), is archived with Hermes's own `archive_task`, together with those sessions. Cards of other assignees and open cards are left alone. The Boards view has the same, per board: *Archive done cards* (when the lane completes them, keep them, or the lane's default) and *Archive done now*.

### Answering a card's question

When a card is blocked with `needs_input`, answer the omp session in any of these places:

- the Switchyard page in Hermes, the AO app or AO Mobile;
- VS Code (the session's chat);
- `switchyard answer <id> <choice>`;
- from Hermes, with `switchyard_session_answer` (questions only; approvals need `agent_approvals`);
- a comment on the card, for questions (not approvals).

On its next tick the lane unblocks and reclaims the card.

### Limits

- The lane runs where the dispatcher ticks: the gateway's embedded dispatcher (`kanban.dispatch_in_gateway`, on by default, every 60 s), `hermes kanban dispatch`, or `hermes switchyard lane run`. Without any of them, cards wait in `ready`.
- Hermes sends a card to `triage` when it is blocked twice for the same reason (its unblock-loop guard), and nothing can complete a card in triage. So only the first question on a card blocks it; later questions are added as comments, and the omp session still waits for an answer.
- A failed card that fails again after a retry goes to `triage` for the same reason.
- `max_runtime_seconds` is not enforced for omp cards. The omp session runs until it finishes. Give the queued task a time limit in omp if you need one.
- When a card completes, Hermes removes its scratch folder, and its worktree too if the worktree is clean and pushed. The omp session's folder may then be gone. Its transcript stays.
- A card whose task the user interrupted (the queue is paused) stays `running` until the task is resumed or the card is completed by hand. A task a crash or reboot interrupted blocks the card instead (see above).
- `review` cards assigned to switchyard are not picked up.

## Several boards, projects and folders

- Give each board a `folder` and a `group`. Card sessions for that board run there, and VS Code and the omp board show them grouped.
- A Hermes project's cards already run in worktrees of the project's repository, because Hermes sets that up when the card is created. For project cards with a scratch workspace, the lane uses `projects` from the settings, then the project's primary folder.
- `switchyard_projects_list` shows all of these, so Hermes can pick `cwd`, `project` or `board` for `switchyard_session_start`.

## Recurring work

Schedules belong to Hermes cron. A cron job can queue an omp session directly:

```sh
hermes cron create "0 7 * * 1-5" "Use switchyard_session_start with project lightscale and task 'Run the full test suite and fix what fails'. Report the session id." --name omp-nightly-tests
```

Or it can create a kanban card for omp, which keeps the history on the board:

```sh
hermes cron create "every 1d" "Create a kanban card on board lightscale, assigned to switchyard, titled 'Update dependencies and run the tests'." --name omp-deps
```

For a one-off later start, `switchyard_session_start` with `task` and `at` (e.g. `"at": "22:00"`) is enough.

## Dashboard and Desktop

The plugin adds an **Switchyard** page to the left sidebar of the Hermes web dashboard (`hermes dashboard`, next to Kanban) and of Hermes Desktop.

![Switchyard in the Hermes dashboard](images/hermes-dashboard.png)

- **Status strip:** `switchyard` and its server, omp's concurrency slots (running, waiting, limit), the kanban lane with the kanban dispatcher's last pass, and how many sessions need you. When the lane can't run (no dispatcher tick seen, the last one is stale, or the dispatcher ticks in a profile whose lane is off) the Lane item turns amber and says why, here and in the Boards view.
- **Session board** with five columns: Needs you, Working, Queued & scheduled, Done, Stopped. A card shows the title, project folder, group, permission mode, cost, when it was last active (or when it starts), the linked kanban card with its status, and the question or the start of the last reply; interrupted sessions say so. Filter by board, group or project, or search (`/`). Each card has a button to open its project in VS Code, and (on hover) **Mark completed** / **Mark not completed** and **Archive** / **Unarchive**. **Archive all** on the Done column header (after a confirm) archives, in one request, every done session the board shows: idle with nothing queued, or marked completed (`switchyard complete`). Archived sessions are hidden; **Show archived** brings them back, with Unarchive on each.
- **Detail panel** (click a card): the question with one button per answer (the answer names the question, so a stale click fails instead of answering a different dialog), the full last reply, queue controls (*Run now* runs the queue's first pending task at once and drops a scheduled start; *Retry* puts a failed, interrupted or finished task back to pending and keeps the schedule; *Schedule* sets or cancels the queue's start time, the same as `switchyard_queue_schedule`), a follow-up box (it runs after the current turn; tick *Steer this turn* to redirect it instead), the permission mode switch, a model switcher, Mark completed and Archive (or their undo), Stop (hidden for interrupted sessions), **VS Code** and **Open project in VS Code** (below).
- **New session** (`N`): the prompt, a title, where it runs (a recent folder, a Hermes project, any folder, or a kanban board's folder and group), mode, a searchable model picker, group, tags, and when: now, queued for a free slot, or scheduled (`+30m`, `22:00`, a date and time).
- **Boards:** the lane switch, and per board (the ones in the lane first) the lane's folder (with an open-in-VS-Code button), omp group, mode, default model, trusted comment authors and assignee, the cards it runs as omp sessions with their status, and the ready cards it takes next.
- **Graph:** a board's kanban cards as a dependency graph, parents on the left and their children (cards that wait for them: `hermes kanban link <parent> <child>`, or a card created with parents) to the right. Cards are coloured by status and show the state of the omp session working on them: the lane's session (marked *lane*), else the latest session tagged `hermes:<board>` + `card:<id>`. An edge is solid once its parent is done and dashed while it still holds the child back. Only cards linked to another card show until you switch **Linked cards only** to **All cards** (unlinked cards then sit in a grid below; archived cards never show). Click a card (or focus it and press Enter) to see what it waits for and what it unblocks; a card with an omp session also opens that session's detail panel.
  Switchyard's planner state of the card's session shows on the card too: *blocked* (queued after a session that has not finished; the card's parents that ran in the lane become the session's `after`, so the Switchyard row of the selected card lists them as *queued after*), *scheduled* (with the time), *held* (the usage gate: a provider limit, usage window, budget or retry backoff, with the reason), *paused*, *waiting for a slot* or *interrupted*. A thicker line marks a link the planner enforces as well (the child's session is queued after the parent's); a link only Hermes knows (the parent ran outside the lane) gates the card in Hermes alone. Edges that skip a column are routed between the cards they pass, and a long title is cut to the card's width with an ellipsis (the whole title is the tooltip).

![A session that needs an answer](images/hermes-detail.png)

The page refreshes every few seconds while it is visible. **Sounds:** the bell in the header plays the cue Hermes Desktop uses for its own turns when a session finishes its turn, and a second one when a session starts waiting for you (a question or an approval). It stays silent for the first list a tab loads, and when the page is open in two tabs only one plays. Click the bell to mute (the choice is kept in that browser). There is no sound while the page is closed: the page only polls while it is open. Lane settings it changes are the active profile's, like `hermes switchyard lane` and `hermes switchyard board`.

**Open in VS Code.** The detail panel's **VS Code** button opens the session's chat in a VS Code window on omp's machine, including a Remote-SSH window on your laptop. Every window of the extension records itself (`vscode-window.json` in the `switchyard` state folder, `~/.switchyard`: its remote authority, folders and workspace file) when it gains focus. The button picks a window that has the session's folder open, else the one you used last, records the request (`vscode-open.json`, valid for two minutes) and opens a link that brings that window up: `vscode://vscode-remote/<authority><folder>` for a remote window (that window's workspace, or the git checkout around the session; VS Code focuses the window holding it, or opens one), or `vscode://mbaradad.switchyard/open?session=<id>` for a local one. The window takes the request when it gains focus and opens the chat. In the dashboard the browser asks before opening VS Code. Hermes Desktop opens only web links, so it opens a small page of the dashboard (`/dashboard-plugins/switchyard/open-vscode.html`, served without sign-in; it holds nothing but the link and follows only VS Code links) in your browser, which then asks to open VS Code. From a terminal: `switchyard vscode <session>` records the request and prints the link (`--authority` picks the Remote-SSH window).

**Open project in VS Code** opens a folder rather than a chat: the card's Hermes project folder, else the board's folder (when the session runs inside it), else the deepest project folder containing the session, else its git repository, else the session's own folder. The page only opens folders it shows (session, board and project folders). From a terminal: `switchyard vscode --folder <dir>` opens exactly that folder, and `switchyard vscode path/to/dir` the git checkout around it.

What it takes:

- **Dashboard:** the plugin must be enabled (`hermes plugins enable switchyard`; `switchyard hermes install` does it). Hermes mounts the page's backend (`dashboard/plugin_api.py`, under `/api/plugins/switchyard/`) when the dashboard or gateway starts, so restart it after enabling (`hermes gateway restart`, or restart `hermes dashboard`).
- **Desktop with Hermes on the same computer:** Desktop copies the desktop half (`desktop/plugin.js`) from the installed plugin, from the first profile that has it (default first), so keep every profile's copy current (`switchyard hermes install --all-profiles`; the extension does it on update). It ships off: turn on **Switchyard** in **Capabilities → Plugins** (use **Rescan** there if it isn't listed or after an update; once the desktop half is in, the row is titled *Switchyard*, so search for that rather than `switchyard`). It uses the same backend, so the plugin must also be enabled in that profile.
- **Desktop against a remote backend** (Desktop on a laptop, Hermes on another machine): the desktop half has to be on the laptop, because Desktop loads plugins from its own `~/.hermes/desktop-plugins/`. Until it is, the plugin's row says *Desktop: unavailable (remote backend)*. In **Capabilities → Plugins → Install from Git**, enter `mbaradad/omp-sessions/integrations/hermes/switchyard`, review, and Install. Desktop clones the desktop half into `~/.hermes/desktop-plugins/switchyard/` with a `.hermes-package.json` marker that pairs it with the agent half on the backend. If the agent half is already installed there, the dialog reports *Plugin 'switchyard' already exists*, which is harmless: the desktop half is still installed. Then turn on its **Desktop** switch. To update it later, run Install from Git again with **Force reinstall** on. Desktop doesn't refresh a Git-installed desktop half by itself, and Force reinstall also replaces the agent half on the backend. The install link `hermes://plugin/install?repo=mbaradad/omp-sessions/integrations/hermes/switchyard` opens the same dialog.

The page is built from `integrations/hermes/ui` by `node build.mjs` into `dashboard/dist/` and `desktop/plugin.js`; those files are committed because Hermes installs the plugin folder without a build step.

## Hermes Console (Android)

[Hermes Console](https://github.com/xP3ta/hermes-console) talks to the Hermes dashboard but shows only its own screens, so the Switchyard page doesn't appear there. Everything else works through Hermes's own features:

- **Chats**: Hermes calls the `switchyard_session_*` tools as usual (Console shows them as steps), and the note that a session finished or needs input arrives in the chat that started it.
- **`/switchyard`**: a short summary (how many sessions need you, are working, queued, scheduled, interrupted or done, and which need you); `/switchyard status` for the lane; `/switchyard take <card> [board]` routes a kanban card to omp, which Console's assignee picker can't (it lists only profiles).
- **Tasks**: cards the lane runs show `@switchyard`, their status, results and comments. Console posts comments as `dashboard`, so they are trusted by default. Comment `@switchyard` on a card to hand it to omp. When a card's session asks a question, the card is blocked with the question as the reason and Console notifies you; answer with a comment on the card. Approvals can't be answered by comment: approve them in AO Mobile or on the Switchyard page. Any other comment reaches the session as a message (see [comments](#talk-to-a-cards-session-through-comments)).

For the omp sessions themselves on Android (every session, not only cards), pair AO Mobile with the AO daemon (see the [setup guide](SETUP.md)): it lists them, follows them live, and answers questions and approvals.

## Troubleshooting

- **Start with `switchyard status`** on the machine (the AO daemon, omp, problems; `ao doctor` checks AO itself), then **Switchyard Doctor** in VS Code (*Switchyard: Run Doctor*): its Hermes section checks the plugin in every profile, notifications, the dispatcher and the lane, and `switchyard`, with fixes (see [In VS Code](#in-vs-code)).
- **`hermes switchyard status` says `switchyard: NOT FOUND`.** Install the command (VS Code: **Switchyard: Install switchyard Command**, or the release package), or set `plugins.entries.switchyard.settings.switchyard` to its path. The gateway may run with a smaller `PATH` than your shell. A 0.5.0 setting named `omp_vs` is no longer read; rename it to `switchyard`.
- **Comments don't reach the session.** Check the author: only `lane.comment_authors` (default `dashboard`) count. Approvals never go through comments.
- **The tools are missing in Hermes.** Check `hermes plugins list`. A user plugin loads only once it is enabled. Start a new Hermes session after enabling, or run `hermes gateway restart`.
- **No notifications arrive.** `hermes switchyard status` shows whether the last note was delivered or refused. A refused note usually means `plugins.entries.switchyard.allow_gateway_injection` is not `true`. Notes are sent on the dispatcher's tick, so the gateway and its kanban dispatcher must be running.
- **Cards stay `ready`.**
  - `hermes switchyard status` shows the kanban dispatcher's last tick and which profile's plugin it reached, and warns when the lane is on in a different profile, when the dispatcher's profile has the lane off, or when no tick has arrived for 3 minutes. The Switchyard page shows the same warnings on its Lane item.
  - Is the board in the lane's list? Is the card assigned exactly to the lane's assignee?
  - Is omp's concurrency limit full (`switchyard sched`)?
  - `hermes switchyard lane run` forces a pass from the terminal.
  - Just updated the plugin files? The running gateway keeps the old code until it reloads the plugin: the extension's automatic refresh and `switchyard hermes install` do that for you; by hand, `hermes -p <profile> plugins disable switchyard` then `enable`, or `hermes gateway restart`.
- **A card was blocked with "could not prepare the workspace".** A `worktree` card needs a path inside a git repository, or a board `default_workdir`. A `dir` path must be absolute.
- **Logs.** Lane and notification errors are written to Hermes's log (`~/.hermes/logs/agent.log`) and shown by `hermes switchyard status`. A session's own output: `switchyard tail <id>`; the AO daemon: `ao status` and `ao doctor`.
