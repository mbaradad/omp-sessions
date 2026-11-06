// Syntax highlighting for code blocks and diff lines (highlight.js core + common languages).
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGS = { bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, lua, makefile, markdown, php, python, ruby, rust, scss, shell, sql, swift, typescript, xml, yaml };
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);

const ALIASES: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	pyi: "python",
	sh: "bash",
	zsh: "bash",
	console: "shell",
	rs: "rust",
	rb: "ruby",
	cs: "csharp",
	h: "c",
	hpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	kt: "kotlin",
	kts: "kotlin",
	yml: "yaml",
	toml: "ini",
	cfg: "ini",
	conf: "ini",
	html: "xml",
	htm: "xml",
	svg: "xml",
	vue: "xml",
	md: "markdown",
	mdx: "markdown",
	jsonc: "json",
	json5: "json",
	mk: "makefile",
	patch: "diff",
};

export function languageFor(nameOrPath: string): string | undefined {
	const raw = nameOrPath.toLowerCase();
	const base = raw.split("/").pop() ?? raw;
	if (base === "dockerfile") return "dockerfile";
	if (base === "makefile") return "makefile";
	const key = base.includes(".") ? (base.split(".").pop() ?? "") : base;
	const lang = ALIASES[key] ?? key;
	return hljs.getLanguage(lang) ? lang : undefined;
}

/** Highlighted HTML for `code`, or undefined when the language is unknown. */
export function highlight(code: string, language: string | undefined): string | undefined {
	if (!language || code.length > 200_000) return undefined;
	try {
		return hljs.highlight(code, { language, ignoreIllegals: true }).value;
	} catch {
		return undefined;
	}
}
