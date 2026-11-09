# Start a background session

Click **+** in the omp **Sessions** view (or run *Switchyard: New Session*). The [Agent Orchestrator](https://github.com/OrchestratorInc/agent-orchestrator) daemon runs the session — over Remote-SSH on the server, locally on your computer — and it keeps running when VS Code closes, the laptop sleeps or SSH drops. Reopen VS Code and the views pick up everything that happened meanwhile.

In a git repository each session works in **its own git worktree** on its own branch (`ao/<session>/root`), so parallel sessions never overwrite each other: *Compare with Base* shows what it did and *Merge into Main Checkout…* brings it back. Outside git a session gets a scratch folder.

*New Session with Options…* picks the model, thinking level, permission mode and a first prompt; *Set Default Model / Mode* applies to every new session.
