#!/bin/sh
# Install the freshly packaged VSIX into this machine's VS Code server (Remote-SSH),
# or into a local desktop VS Code when no server is present.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p 'require("./package.json").version')
# Absolute: the VS Code server CLI resolves a relative path against its own working directory.
vsix="$PWD/dist/switchyard-$version.vsix"
[ -f "$vsix" ] || { echo "missing $vsix; run npm run package" >&2; exit 1; }

servers="$HOME/.vscode-server/cli/servers"
cli=""
if [ -f "$servers/lru.json" ]; then
	# Most recently used server first.
	for s in $(node -p 'require(process.argv[1]).join("\n")' "$servers/lru.json"); do
		if [ -x "$servers/$s/server/bin/code-server" ]; then cli="$servers/$s/server/bin/code-server"; break; fi
	done
fi
[ -n "$cli" ] || cli=$(command -v code || true)
[ -n "$cli" ] || { echo "no VS Code server or 'code' CLI found" >&2; exit 1; }

"$cli" --install-extension "$vsix" --force
echo "Installed $vsix via $cli — run 'Developer: Reload Window' in VS Code."
