import assert from "node:assert/strict";
import { test } from "node:test";
import { plain } from "../../src/ext/plain";

// VS Code's notification link syntax: [label](command:…|https:…|file:…), optionally with a title.
const LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^)\s]+)(?: (["'])(.+?)(\3))?\)/i;

test("plain: link syntax from a title or omp's text no longer forms a link, and reads the same", () => {
	for (const text of [
		"[Update required](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22calc%5Cn%22%7D)",
		'Fix [docs](https://evil.example "t") now',
		"[a](file:///etc/passwd) and [b](command:x)",
		"nested [[x](command:y)](command:z)",
	]) {
		const out = plain(text);
		assert.equal(LINK.test(out), false, out);
		assert.equal(out.replace(/\u200b/g, ""), text, "only invisible characters are added");
	}
	assert.equal(plain("exit code 2 (host crashed)"), "exit code 2 (host crashed)", "plain parentheses stay as they are");
});
