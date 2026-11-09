// The Hermes dashboard screenshots for scripts/screenshots/run.mjs: opens the Switchyard page of a running
// `hermes dashboard` and saves hermes-dashboard.png (the session board) and hermes-detail.png (a session that
// needs an answer, opened). Run through `npx -p playwright@<version> node hermes.mjs <dashboard url> <out dir>`:
// playwright comes from npx's cache (first `node_modules/.bin` on PATH), not from the repository.
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const [url, outDir] = process.argv.slice(2);
const bin = (process.env.PATH ?? "").split(path.delimiter).find(p => p.endsWith(path.join("node_modules", ".bin")) && fs.existsSync(path.join(p, "..", "playwright")));
if (!bin) throw new Error("run me with `npx -p playwright node hermes.mjs …`");
const { chromium } = createRequire(path.join(bin, "..", "index.js"))("playwright");

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: "dark" });
	await page.goto(url, { waitUntil: "networkidle" });
	// Hermes's first-run metrics question (answered in the scratch HERMES_HOME only).
	await page.getByRole("button", { name: "No thanks" }).click({ timeout: 5000 }).catch(() => {});
	await page.getByRole("link", { name: /^switchyard$/i }).first().click();
	await page.getByText("Needs you", { exact: true }).first().waitFor({ timeout: 30_000 });
	await page.waitForTimeout(4000);
	await page.screenshot({ path: path.join(outDir, "hermes-dashboard.png") });
	await page.getByText("Fix the flaky checkout test", { exact: true }).first().click();
	await page.waitForTimeout(3000);
	await page.screenshot({ path: path.join(outDir, "hermes-detail.png") });
} finally {
	await browser.close();
}
