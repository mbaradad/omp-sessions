# Publishing checklist

Releases are automated by `.github/workflows/release.yml`: pushing a tag `v<version>` runs the tests, packages the VSIX, publishes it to the VS Code Marketplace and Open VSX, and creates a GitHub release with the VSIX and the standalone CLI package `omp-sessions-<version>.tgz` attached (`node packaging/cli/pack.mjs` builds it; `npm install -g <its release URL>` installs it). The steps below are the one-time setup plus the per-release routine.

## One-time setup

### 1. GitHub repository

`package.json` already points `repository`, `bugs`, `homepage` and `qna` at `https://github.com/mbaradad/omp-sessions`. The Marketplace page links there, and `vsce` rewrites relative README links against it, so the repository must exist and be public before the first publish.

1. Create the **public** repository `mbaradad/omp-sessions` on GitHub (no README, license or .gitignore: they already exist here).
2. Push:
   ```sh
   git remote add origin git@github.com:mbaradad/omp-sessions.git
   git push -u origin main
   ```
3. Settings → **Code security** → enable *Private vulnerability reporting* (`SECURITY.md` links to it).
4. Settings → General → make sure *Issues* is enabled (bug reports and Marketplace Q&A both go there).
5. Check that the **CI** workflow passes on `main` (Actions tab).
6. Optional: Settings → Branches → protect `main` and require the `test (ubuntu-latest)`, `test (macos-latest)`, `desktop e2e (ubuntu, xvfb)` and `package vsix` checks.

### 2. VS Code Marketplace publisher and Trusted Publishing

Azure DevOps retires global Personal Access Tokens on December 1, 2026, so releases authenticate with **Trusted Publishing** (GitHub OIDC): no token is stored anywhere. `release.yml` has `id-token: write` and runs `vsce publish --oidc`.

1. Sign in at <https://marketplace.visualstudio.com/manage/createpublisher> with a Microsoft account and create the publisher with ID **`mbaradad`**. It must equal `publisher` in `package.json`.
2. <https://marketplace.visualstudio.com/manage> → publisher **mbaradad** → **Trusted Publishing** → *Create*:
   - Policy name: `Release workflow`
   - Repository owner: `mbaradad`
   - Repository: `omp-sessions`
   - Workflow: `release.yml`
   - Environment: empty
3. Renaming the workflow file or moving the repository needs a new policy.

### 3. Open VSX namespace and token (Cursor, VSCodium, Windsurf, Gitpod, …)

1. Sign in at <https://open-vsx.org> with GitHub.
2. In your profile settings, log in with an Eclipse account and sign the **Open VSX Publisher Agreement**. Publishing is rejected without it.
3. Profile settings → **Access Tokens** → generate a token.
4. Create the namespace once: `npx ovsx create-namespace mbaradad -p <token>`.
5. Optional: claim ownership of the namespace (open-vsx.org → *Namespaces*) so the listing shows as verified.

### 4. Repository secrets

Settings → Secrets and variables → **Actions** → *New repository secret* (or `gh secret set NAME`):

| Secret | Value | If missing |
| --- | --- | --- |
| `OVSX_PAT` | Open VSX token from step 3 | Open VSX is skipped with a warning |

The Marketplace needs no secret (Trusted Publishing, step 2). The workflow uses the built-in `GITHUB_TOKEN` for the GitHub release.

### 5. Marketplace listing assets

The README and the website (`site/assets/shots/`) use the same seven PNGs, kept in `docs/images/`. Embed them in `README.md` with relative paths (`![…](docs/images/chat.png)`): `vsce` rewrites relative paths to `https://github.com/mbaradad/omp-sessions/raw/HEAD/…`, so the images only show once they are pushed to the public repo. `docs/` is never packaged into the VSIX (see `.vscodeignore`).

Capture guidelines: 1600×1000 (16:10; the website crops with `object-fit: cover` anchored top-left), Dark Modern, zoom level 1, a real VS Code with the released VSIX installed in an isolated profile (`--user-data-dir`/`--extensions-dir`) so the title bar shows no *Extension Development Host*, and no OS window chrome. Drive omp with `test/fake-omp.mjs` (`FAKE_OMP_DEMO=1` gives real-looking model names, prices and tok/s; `FAKE_OMP_REPLIES` scripts the answers) in a throwaway `OMP_VSCODE_HOME`, so no personal paths, keys or costs appear. The Marketplace does not accept SVG images in the README (only badges from trusted hosts), and every image must be HTTPS.

| # | File | What it shows |
| --- | --- | --- |
| 1 | `chat.png` | A chat tab with the Sessions view: inline diff, tool call, Markdown answer with `file:line` links, and the footer (model, thinking, permission mode, context, cost, tok/s) |
| 2 | `sessions.png` | Sessions across two projects (working, needs input, idle, stopped) and a pending tool approval card in Ask mode |
| 3 | `board.png` | The Sessions Board by status |
| 4 | `review.png` | *Review Changes*: the session's edits in VS Code's multi-file diff |
| 5 | `tasks.png` | The Tasks view with a running queue, subtasks and pending tasks |
| 6 | `checkpoints.png` | The *Restore the checkpoint before this prompt?* confirmation listing the files that go back |
| 7 | `dashboard.png` | The usage dashboard: spend cards, per-day chart, projects and models |

Phone screenshots (`docs/images/phone/*.png`, copied to `site/assets/shots/phone-*.png`) are 390×844 at 3× from the phone app against the same demo state (`omp-sessions remote on --bind localhost`, then open the pairing URL in a mobile browser viewport). The README graphics (`hero.png`, `a-day.png`, `how-it-works.png`, `phone.png`) are rendered from HTML in `docs/images/src/`, which embeds these screenshots: re-render them after a retake (commands in `docs/images/src/README.md`).

Optional: a 10–20 s GIF of starting a session, closing VS Code, reopening and finding the finished work (keep it under about 5 MB).

## Every release

1. Bump `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version` also updates `package-lock.json`).
2. Add a `## <x.y.z>` section at the top of `CHANGELOG.md`. The release workflow uses that section as the GitHub release notes and fails without it.
3. Pre-flight locally:
   ```sh
   npm run typecheck && npm test
   npx vsce ls            # only out/, media/, README.md, CHANGELOG.md, LICENSE, package.json
   ```
4. Commit, tag, push:
   ```sh
   git commit -am "Release <x.y.z>"
   git tag v<x.y.z>
   git push origin main v<x.y.z>
   ```
5. Watch the **Release** workflow. It checks the tag against `package.json`, runs the tests, packages, publishes to the Marketplace and then Open VSX, and creates the GitHub release with the VSIX.
6. Within about 5–10 minutes, check that the listing appears on <https://marketplace.visualstudio.com/items?itemName=mbaradad.omp-sessions> and <https://open-vsx.org/extension/mbaradad/omp-sessions>, then install it in a clean profile (`code --profile Temp --install-extension mbaradad.omp-sessions`).

If the Marketplace publish succeeded but a later step failed, do not re-push the tag (the version already exists there). Finish by hand: `npx ovsx publish <vsix> -p <token>` and/or `gh release create v<x.y.z> <vsix> --notes-file …`.

Manual fallback without CI: upload the VSIX from `npx vsce package` at <https://marketplace.visualstudio.com/manage> (*New extension → Visual Studio Code*), then `OVSX_PAT=… npm run publish:ovsx`.

## Hermes plugin

The plugin in `integrations/hermes/omp-sessions/` ships three ways. Its `plugin.yaml` `version` must equal `package.json`'s (`node build.mjs` fails otherwise), so bump both together.

1. **Inside the extension.** `build.mjs` copies the folder into `out/hermes-plugin/`; `omp-sessions hermes install` and *omp: Install Hermes Plugin…* install it from there. Nothing to do beyond the extension release.
2. **From Git.** `hermes plugins install mbaradad/omp-sessions/integrations/hermes/omp-sessions` fetches only that folder from `main`, so the folder must be self-contained: `build.mjs` keeps its copy of the skill (`skills/omp-sessions/SKILL.md`) and the dashboard and Desktop bundles (built from `integrations/hermes/ui/`) up to date, and they are committed. Run `node build.mjs` and commit before pushing. Users update with `hermes plugins update omp-sessions`.
3. **The Hermes plugin catalog** (`hermes plugins install omp-sessions`, listed on <https://hermes-agent.nousresearch.com/docs/plugins>). Entries are YAML files in [`NousResearch/hermes-agent/plugin-catalog/`](https://github.com/NousResearch/hermes-agent/tree/main/plugin-catalog), added by a reviewed pull request that pins an exact commit. To submit, or to move it to a new release:
   1. Validate the plugin at the commit you'll pin (the same check catalog CI runs):
      ```sh
      HERMES_HOME=$(mktemp -d) hermes plugins validate integrations/hermes/omp-sessions --install-deps
      ```
      It must pass. The warnings about private core imports (`hermes_cli.kanban_db*` and `hermes_constants`, used by the lane, the page's backend and the profile name in `hermes omp status`) are expected: Hermes has no public kanban API for plugins yet. Mention them in the PR.
   2. Generate the entry for the release tag: `npm run -s hermes:catalog -- v<x.y.z> > omp-sessions.yaml` (the tag must be pushed; screenshots are pinned to the same commit).
   3. Fork `NousResearch/hermes-agent`, add the file as `plugin-catalog/omp-sessions.yaml`, and open a pull request. For a new release, the same file with the new `sha` and `version` is a new pull request.
   4. In the description, say what the plugin does, which surfaces it uses (tools, the `on_kanban_dispatch_tick` hook, a slash command, a CLI command, a skill, a dashboard tab with a FastAPI router, a Desktop page), and the disclosures from the plugin README's *What it does on your machine* section. Attach `site/assets/shots/hermes-dashboard.png` and `hermes-detail.png`.
   5. Wait for the catalog CI job and the maintainers' review. Listing is at their discretion.

## Listing flags to revisit

- `"preview": true` shows a *Preview* badge. Remove it once Windows is tested and the feature set is stable (1.0).
- `"categories": ["AI", "Chat", "Other"]` and the 25 `keywords` drive search. Keep keywords at 30 or fewer, and adjust them after seeing what users search for.
- `"private": true` only stops an accidental `npm publish`. `vsce` and `ovsx` ignore it.
