# Contributing to Switchyard

Thanks for helping. Bug reports, fixes and features are welcome. For anything large, open an issue first so we can agree on the approach.

## Setup

Requirements: Node.js 22+, npm, git, VS Code 1.100+. Linux or macOS for the full test suite; Windows works for unit tests (named pipes and `.cmd` shims are handled, but the platform is not yet fully tested). The integration tests start an isolated Agent Orchestrator daemon, so they need an `ao` binary (`AO_BIN`, or `ao` on `PATH`; see [docs/SETUP.md](docs/SETUP.md)). `omp` itself is only needed to try the extension by hand; the tests use a scripted stand-in.

```sh
git clone https://github.com/mbaradad/omp-sessions.git
cd omp-sessions
npm ci
npm run build        # esbuild → out/ (npm run watch to rebuild on change)
```

Press **F5** in VS Code to start an Extension Development Host with this checkout. Pick *Run Extension (isolated session state)* to keep experiments in `.dev-state/` instead of your real `~/.switchyard`. The planner and the omp extension that are already running or installed keep the code they started with: after changing `src/planner` or `src/omp-extension`, restart the planner (`switchyard server restart`) and start a new session.

## Architecture

[README.md](README.md#how-it-works) explains the moving parts. In short:

- `src/ao`: the only module that talks HTTP to Agent Orchestrator: the typed client (generated from AO's OpenAPI spec), the event stream, daemon discovery and start, and the view model that maps AO sessions to Switchyard states. Clients import `src/ao/client.ts` and `src/ao/model.ts`, never the generated schema.
- `src/planner`: the planner service: plans, queues, schedules, the dispatcher that sends ready tasks to AO, and the local API (types in `src/planner/types.ts`).
- `src/omp-extension`: the extension loaded by omp inside AO sessions (checkpoints, permission modes, the omp id record).
- `src/ext`: the VS Code extension: sessions, chat panels, views, editor integration. `src/webview`: the chat UI. `src/kanban`: the Sessions Board. `src/cli`: the `switchyard` command. `src/bridge`: the VS Code bridge for omp.
- `src/shared`: helpers and wire contracts shared by the above (`webview.ts` is extension ⇄ webview).

## Tests

```sh
npm run typecheck          # tsc --noEmit
npm test                   # unit + integration suites; npm run test:unit / test:integration for one
npm run test:e2e:desktop   # real desktop VS Code (downloaded to .vscode-test/, xvfb-run if no DISPLAY; Linux and macOS, never touches the OS keychain)
```

- Tests never call a model. `test/fake-omp-acp.mjs` is a scripted stand-in for `omp acp`; its prompts are commands (`echo`, `write`, `edit`, `ask`, `slow`, `fail`, `limited`, `/<cmd>`), documented at the top of the file. `test/ao-fixture.mjs` starts an isolated `ao daemon` (free port, temporary data dir and run file) with the fake as `omp`, and tears it down with its chat hosts; `test/planner-fixture.mjs` adds a planner on top.
- Pure logic goes in `test/unit/<feature>.test.ts`. Behaviour that needs a running AO daemon or planner goes in `test/integration/<feature>.test.ts` (see `test/integration/ao-chat.test.ts`).
- Integration tests wait for observable state, not for time: poll the conversation, the planner's plan or the fake's log. Never compare wall-clock timestamps across a wait: the clock can step (WSL2 jumps back ~3 s every half minute).
- `TEST_FILTER=<regex>` runs only matching test files. `TEST_OUT=<dir>` bundles somewhere other than `.test-out/`.
- Scripts must never touch your real sessions: use the fixtures, or set `SWITCHYARD_HOME`, `AO_PORT`, `AO_DATA_DIR` and `AO_RUN_FILE` to temporary values. A daemon started without `AO_RUN_FILE` overwrites `~/.ao/running.json` and takes over discovery for every client.
- CI (`.github/workflows/ci.yml`) runs typecheck + tests on Linux and macOS (Windows is allowed to fail), the desktop e2e under xvfb on Linux, and packages the VSIX.

## Code style

- TypeScript, tabs, double quotes. Keep code boring and robust across Linux, macOS, Windows, local desktop and Remote-SSH, with omp missing and sessions stopped.
- No `any` and no `as { … }` casts: narrow with type guards. Prefer `Promise.withResolvers()` to `new Promise`.
- New user-facing behaviour gets a test, a README mention and a `CHANGELOG.md` entry under the next version.

## Pull requests

1. Branch from `main`, keep each PR to one change.
2. Make sure `npm run typecheck` and `npm test` pass; run `npm run test:e2e:desktop` if you touched activation, panels or the planner or AO integration.
3. Describe what changed and how you tested it. Add screenshots for UI changes.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
