// Running omp's npm/bun `.cmd` shims on Windows without `shell: true`: Node joins shell arguments
// with spaces and no quoting, so a folder or transcript path holding `&`, `|`, `%VAR%` or a space
// would run commands or break the launch. Instead cmd.exe gets one command line with every
// argument quoted and every cmd metacharacter caret-escaped (the cross-spawn / BatBadBut scheme).
// Node-only; pure apart from reading `ComSpec`.

/** What to pass to spawn/execFile: `file` + `args`, with `windowsVerbatimArguments` in the options. */
export interface SpawnTarget {
	file: string;
	args: string[];
	windowsVerbatimArguments: boolean;
}

/** cmd metacharacters, escaped with `^` (`%` too: `^%VAR^%` names no variable, so nothing expands). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for a `.cmd` shim: C-runtime quoting, then caret escapes for both cmd passes (cmd /c and the shim's `%*` line). */
export function cmdShimArg(arg: string): string {
	// Backslashes before a quote or the closing quote are doubled; quotes become \".
	const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
	return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/** How to start `file` with `args`: directly, or through cmd.exe with escaped arguments for `.cmd`/`.bat` shims on Windows. */
export function spawnTarget(file: string, args: readonly string[], platform: NodeJS.Platform = process.platform): SpawnTarget {
	if (platform !== "win32" || !/\.(cmd|bat)$/i.test(file)) return { file, args: [...args], windowsVerbatimArguments: false };
	// The shim path itself is parsed once, by cmd /c.
	const line = [file.replace(CMD_META, "^$1"), ...args.map(cmdShimArg)].join(" ");
	return { file: process.env.ComSpec || process.env.comspec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}
