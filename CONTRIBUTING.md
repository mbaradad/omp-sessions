# Contributing to omp Sessions

Thanks for helping. Bug reports, fixes and features are welcome. For anything large, open an issue first so we can agree on the approach.

## Setup

Requirements: Node.js 22+, npm, git, VS Code 1.100+. Linux or macOS for the full test suite; Windows works for unit tests (named pipes and `.cmd` shims are handled, but the platform is not yet fully tested). `omp` itself is only needed to try the extension by hand; the tests use a scripted stand-in.

```sh
git clone https://github.com/mbaradad/omp-vscode.git
cd omp-vscode
npm ci
npm run build        # esbuild → out/ (npm run watch to rebuild on change)
```

Press **F5** in VS Code to start an Extension Development Host with this checkout. Pick *Run Extension (isolated session state)* to keep experiments in `.dev-state/` instead of your real `~/.omp/vscode`. Session hosts already running keep the code they started with: after changing `src/host`, stop and resume a session.

## Architecture

[README.md](README.md#architecture) explains the moving parts. In short:

- `src/host`: the detached session host (one process per session) that runs `omp --mode rpc-ui` and serves clients over a local socket.
- `src/ext`: the VS Code extension: sessions, chat panels, views, editor integration.
- `src/webview`: the chat UI.
- `src/shared`: wire contracts shared by all three (`protocol.ts` is host ⇄ extension, `webview.ts` is extension ⇄ webview).

## Tests

```sh
npm run typecheck          # tsc --noEmit
npm test                   # unit + session-host suites (~10 s); npm run test:unit / test:host for one
npm run test:e2e:desktop   # real desktop VS Code (downloaded to .vscode-test/, xvfb-run if no DISPLAY)
```

- Tests never call a model. `test/fake-omp.mjs` is a scripted stand-in for `omp --mode rpc-ui`; its prompts are commands (`echo`, `write`, `edit`, `ask`, `slow`, `fail`, `/<cmd>`), documented at the top of the file.
- Pure logic goes in `test/unit/<feature>.test.ts`. Behaviour that needs a running host goes in `test/host/<feature>.test.ts` (see `test/host/harness.ts`): it starts the real host in a temporary `OMP_VSCODE_HOME` against the fake omp.
- `TEST_FILTER=<regex>` runs only matching test files. `TEST_OUT=<dir>` bundles somewhere other than `.test-out/`.
- Scripts must never touch your real sessions: set `OMP_VSCODE_HOME` to a temp directory.
- CI (`.github/workflows/ci.yml`) runs typecheck + tests on Linux and macOS (Windows is allowed to fail), the desktop e2e under xvfb on Linux, and packages the VSIX.

## Code style

- TypeScript, tabs, double quotes. Keep code boring and robust across Linux, macOS, Windows, local desktop and Remote-SSH, with omp missing and sessions stopped.
- No `any` and no `as { … }` casts: narrow with type guards. Prefer `Promise.withResolvers()` to `new Promise`.
- New user-facing behaviour gets a test, a README mention and a `CHANGELOG.md` entry under the next version.

## Pull requests

1. Branch from `main`, keep each PR to one change.
2. Make sure `npm run typecheck` and `npm test` pass; run `npm run test:e2e:desktop` if you touched activation, panels or the host lifecycle.
3. Describe what changed and how you tested it. Add screenshots for UI changes.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
