// Prints the Hermes plugin-catalog entry (plugin-catalog/omp-sessions.yaml in NousResearch/hermes-agent)
// for the omp-sessions plugin pinned at a commit: `node scripts/hermes-catalog-entry.mjs [ref]` (default HEAD).
// See docs/PUBLISHING.md, "Hermes plugin catalog".
import { execFileSync } from "node:child_process";

const REPO = "https://github.com/mbaradad/omp-vscode";
const SUBDIR = "integrations/hermes/omp-sessions";
const SCREENSHOTS = ["site/assets/shots/hermes-dashboard.png", "site/assets/shots/hermes-detail.png", "site/assets/shots/hermes-desktop.png"];

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const exists = (sha, file) => {
	try {
		git("cat-file", "-e", `${sha}:${file}`);
		return true;
	} catch {
		return false;
	}
};

const sha = git("rev-parse", `${process.argv[2] ?? "HEAD"}^{commit}`);
const manifest = git("show", `${sha}:${SUBDIR}/plugin.yaml`);
const scalar = key => {
	const raw = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(manifest)?.[1]?.trim();
	if (!raw) throw new Error(`plugin.yaml at ${sha.slice(0, 8)} has no ${key}`);
	return raw.replace(/^(["'])(.*)\1$/, "$2");
};
const list = key => {
	const block = new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s.+\\n?)*)`, "m").exec(manifest)?.[1] ?? "";
	return [...block.matchAll(/^\s+-\s+(.+)$/gm)].map(m => m[1].trim());
};

const pushed = git("branch", "-r", "--contains", sha).split("\n").some(b => b.trim() === "origin/main");
if (!pushed) process.stderr.write(`warning: ${sha.slice(0, 8)} is not on origin/main yet; push it before opening the catalog PR\n`);

const quote = s => `'${s.replace(/'/g, "''")}'`;
const yamlList = (items, indent) => (items.length ? `\n${items.map(i => `${indent}- ${i}`).join("\n")}` : " []");
const shots = SCREENSHOTS.filter(f => exists(sha, f)).map(f => `https://raw.githubusercontent.com/mbaradad/omp-vscode/${sha}/${f}`);

process.stdout.write(`name: ${scalar("name")}
repo: ${REPO}
sha: ${sha}
subdir: ${SUBDIR}
description: ${quote(scalar("description"))}
maintainer: mbaradad
tier: community
category: tools
requires_hermes: ${quote(scalar("requires_hermes"))}
docs_url: ${REPO}/blob/main/docs/HERMES.md
version: "${scalar("version")}"
title: omp Sessions
screenshots:${yamlList(shots, "  ")}
platforms: [linux, macos]
known_issues:
  - Needs the omp Sessions VS Code extension's omp-sessions CLI on PATH (VS Code, "omp: Install omp-sessions Command").
capabilities:
  provides_tools:${yamlList(list("provides_tools"), "    ")}
  provides_hooks:${yamlList(list("provides_hooks"), "    ")}
  provides_middleware: []
  requires_env: []
`);
