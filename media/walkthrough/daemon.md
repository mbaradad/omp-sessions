# Agent Orchestrator runs the sessions

omp Sessions is a client of the **Agent Orchestrator (AO)** daemon, `ao daemon`: AO starts omp (`omp acp`) for every session in its own detached host, and keeps them running with no editor open. Next to it, the **planner** runs your task queues, dependencies and schedules.

- Install `ao` and make sure `omp` is logged in to a model provider.
- The extension finds a running daemon through `~/.ao/running.json`. When none runs, it starts one: on Linux as the `ao-daemon` systemd user service (it starts at login and restarts after a crash; `omp.server.installService`), elsewhere as a background process. It starts the planner the same way. `omp.server.autoStart` turns both off.
- The status bar's omp item shows a disconnected plug while the daemon is unreachable; click it to start it. *omp: Show Planner or AO Daemon Log* opens either log.
