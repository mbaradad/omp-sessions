# Contributing to Switchyard

Thanks for helping. Bug reports, fixes and features are welcome. For anything large, open an issue first so we can agree on the approach.

## Setup

Requirements: Node.js 22+, npm, git, VS Code 1.100+. Linux or macOS for the full test suite; Windows works for unit tests (named pipes and `.cmd` shims are handled, but the platform is not yet fully tested). The integration tests start an isolated Agent Orchestrator daemon, so they need an `ao` binary (`SWITCHYARD_TEST_AO_BIN`, or `ao` on `PATH`; see [docs/SETUP.md](docs/SETUP.md)); they skip without one. `omp` itself is only needed to try the extension by hand; the tests use a scripted stand-in.

```sh
git clone https://github.com/mbaradad/switchyard.git
cd switchyard
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
npm run test:e2e:desktop   # real desktop VS Code (downloaded to .vscode-test/, xvfb-run if no DISPLAY; Linux and macOS, never touches the OS keychain); SWITCHYARD_E2E_FAKE_OMP=1 runs the daemon's sessions on the scripted fake omp (no tokens), SWITCHYARD_E2E_SUITES=sounds runs only the named suite files (desktop, flow, sounds; the sounds suite is the session sounds in a real VS Code, with a real X key press as the first gesture), SWITCHYARD_E2E_AO_PORT pins the daemon port
```

- Tests never call a model. `test/fake-omp-acp.mjs` is a scripted stand-in for `omp acp`: the prompt is the script, one step per line (`echo`, `prompt`, `bash` (asks for approval), `write`, `edit`, `append`, `delete`, `commit`, `ask`, `slow` (steerable), `plan`, `title`, `cost`, `limited`, `fail`, `error`, `crash`, …), documented at the top of the file. Only command lines run; prose around them (task titles, parents' results) is ignored. The files it writes and the commits it makes land in its working folder. `test/ao-fixture.mjs` (`startAoFixture()`) starts an isolated `ao daemon` (free port, temporary data dir and run file) with the fake as `omp`, and tears it down with its chat hosts (`await ao.stop()`); `test/planner-fixture.mjs` (`startPlannerFixture({ ao })`) runs the real planner on top of it. Integration tests skip when no `ao` binary is found.
- Pure logic goes in `test/unit/<feature>.test.ts`. Behaviour that needs a running AO daemon or planner goes in `test/integration/<feature>.test.ts` (see `test/integration/ao-chat.test.ts`).
- Integration tests wait for observable state, not for time: poll the conversation, the planner's plan or the fake's log. Never compare wall-clock timestamps across a wait: the clock can step (WSL2 jumps back ~3 s every half minute).
- `TEST_FILTER=<regex>` runs only matching test files. `TEST_OUT=<dir>` bundles somewhere other than `.test-out/`.
- Tests never touch your real sessions or your home. The fixtures enforce it with no opt-out: `startAoFixture()` sets `HOME`, `USERPROFILE`, `XDG_*`, `SWITCHYARD_HOME` and `OMP_VSCODE_HOME` under its temporary root, for the daemon, for `ao.stackEnv` **and for the test process itself** while the fixture lives (`os.homedir()` follows; each key is restored by `stop()`), and refuses to start if you point any of them elsewhere. A test that uses a fixture needs no env setup of its own; one that reads the real home on purpose must use `os.userInfo().homedir`, not `os.homedir()` or `HOME`. `realOmp: true` runs under that home too, with only `.omp/agent` linked to the real agent folder, because the omp login lives there. `startPlannerFixture` shares the fixture's Switchyard home by default (its files go under `<home>/planner/`) and rejects a state folder outside the temporary dir. Start CLI, planner or Hermes subprocesses with `ao.stackEnv` / `planner.clientEnv`, never with the bare `process.env`, so installs of the CLI launcher, the agent skill, a service or the Hermes plugin land in the temporary home. Unit tests get a throwaway `SWITCHYARD_HOME` from `test/run.mjs`. Code that runs **outside** a fixture (a smoke, a script, your own e2e runner) must set `HOME` and `SWITCHYARD_HOME` itself, in its own `process.env` and in child processes (client code writes Switchyard state: `src/ao/spawn.ts` writes `sessions/<id>/mode`, the planner and the CLI write `~/.switchyard/…`), or pass `ao.stackEnv`; `startAoFixture({ switchyardHome })` lets a test VS Code, the daemon and the planner share one folder (see `test/e2e-desktop/run.mjs`). A hand-run smoke does the same by hand: `HOME` and `XDG_*` under a temporary folder, `SWITCHYARD_HOME`, `AO_PORT`, `AO_DATA_DIR` and `AO_RUN_FILE` temporary (a daemon without `AO_RUN_FILE` overwrites `~/.ao/running.json` and takes over discovery for every client). Do not let a test VS Code install Switchyard's omp extensions into `~/.omp/agent/extensions/`; load them from the scratch repository's `.omp/extensions/`. `test/e2e-desktop/run.mjs` fails the run if the real launchers, `~/.switchyard` or `~/.omp/agent/extensions` changed.
- CI (`.github/workflows/ci.yml`) runs typecheck + tests on Linux and macOS (Windows is allowed to fail), the desktop e2e under xvfb on Linux, and packages the VSIX.

## Code style

- TypeScript, tabs, double quotes. Keep code boring and robust across Linux, macOS, Windows, local desktop and Remote-SSH, with the agent harness (omp or another) missing and sessions stopped.
- No `any` and no `as { … }` casts: narrow with type guards. Prefer `Promise.withResolvers()` to `new Promise`.
- New user-facing behaviour gets a test, a README mention and a `CHANGELOG.md` entry under the next version.

## Pull requests

1. Branch from `main`, keep each PR to one change.
2. Make sure `npm run typecheck` and `npm test` pass; run `npm run test:e2e:desktop` if you touched activation, panels or the planner or AO integration.
3. Describe what changed and how you tested it. Add screenshots for UI changes.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
