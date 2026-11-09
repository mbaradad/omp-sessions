// Installs the omp extensions omp Sessions ships (`out/omp-extension/*.js`, built from
// src/omp-extension) into omp's agent folder as one package, `<agent dir>/extensions/omp-sessions/`
// with a `package.json` listing the modules, which omp's native discovery loads in every omp
// process. Each module does nothing unless AO runs that omp (`AO_SESSION_ID`). The folder is ours:
// modules no longer shipped are removed. Node-only.
import * as fs from "node:fs";
import * as path from "node:path";
import { type OmpPathOptions, ompPaths } from "./omp-paths";

export const OMP_EXTENSION_PACKAGE = "omp-sessions";

export function ompExtensionDir(opts?: OmpPathOptions): string {
	return path.join(ompPaths(opts).agentDir, "extensions", OMP_EXTENSION_PACKAGE);
}

/** Copies the modules in `sourceDir` into `targetDir` when they differ; true when anything changed. */
export function installOmpExtensions(sourceDir: string, targetDir: string): boolean {
	const modules = fs
		.readdirSync(sourceDir)
		.filter(f => f.endsWith(".js"))
		.sort();
	const files = new Map<string, Buffer>(modules.map(f => [f, fs.readFileSync(path.join(sourceDir, f))]));
	files.set("package.json", Buffer.from(`${JSON.stringify({ name: OMP_EXTENSION_PACKAGE, private: true, type: "module", omp: { extensions: modules.map(f => `./${f}`) } }, null, "\t")}\n`));
	fs.mkdirSync(targetDir, { recursive: true });
	let changed = false;
	for (const [name, content] of files) {
		const target = path.join(targetDir, name);
		let current: Buffer | undefined;
		try {
			current = fs.readFileSync(target);
		} catch {
			current = undefined;
		}
		if (current?.equals(content)) continue;
		// Temp file + rename: an omp starting right now never imports a half-written module.
		const tmp = `${target}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, content);
		fs.renameSync(tmp, target);
		changed = true;
	}
	for (const name of fs.readdirSync(targetDir)) {
		if (files.has(name)) continue;
		fs.rmSync(path.join(targetDir, name), { recursive: true, force: true });
		changed = true;
	}
	return changed;
}
