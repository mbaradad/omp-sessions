// Demo content for scripts/screenshots: the two projects, the fake omp's scripted replies (FAKE_OMP_RULES, matched
// against each prompt; see test/fake-omp-acp.mjs for the step commands) and a month of earlier usage.

export const demoRepos = {
	"acme-api": {
		"package.json": `${JSON.stringify({ name: "acme-api", version: "1.4.2", private: true, type: "module", scripts: { dev: "tsx watch src/index.ts", test: "vitest run" }, dependencies: { express: "^4.21.2" }, devDependencies: { supertest: "^7.0.0", tsx: "^4.19.0", typescript: "^5.6.0", vitest: "^3.2.4" } }, null, 2)}\n`,
		"README.md": "# acme-api\n\nThe public and checkout API of Acme.\n",
		"CHANGELOG.md": "# Changelog\n\n## Unreleased\n\n- Checkout: retry card authorization once on a network error.\n- Public API: `GET /v1/products` supports `?cursor=`.\n",
		"src/index.ts": 'import { app } from "./server";\n\napp.listen(Number(process.env.PORT ?? 3000));\n',
		"src/server.ts":
			'import express from "express";\nimport { checkoutRoutes } from "./routes/checkout";\nimport { publicRoutes } from "./routes/public";\n\nexport const app = express();\n\napp.use(express.json());\napp.use("/v1/checkout", checkoutRoutes);\napp.use("/v1", publicRoutes);\n',
		"src/routes/public.ts":
			'import { Router } from "express";\nimport { listProducts } from "../products";\n\nexport const publicRoutes = Router();\n\npublicRoutes.get("/products", async (req, res) => {\n\tres.json(await listProducts(String(req.query.cursor ?? "")));\n});\n\npublicRoutes.post("/signup", async (req, res) => {\n\tres.status(201).json({ email: req.body.email });\n});\n',
		"src/routes/checkout.ts":
			'import { Router } from "express";\nimport { chargeCard, reserveStock } from "../payments";\n\nexport const checkoutRoutes = Router();\n\ncheckoutRoutes.post("/", async (req, res) => {\n\tconst reservation = reserveStock(req.body.items);\n\tconst charge = await chargeCard(req.body.card, req.body.total);\n\tres.json({ reservation: await reservation, charge });\n});\n',
		"src/products.ts": "export async function listProducts(cursor: string) {\n\treturn { items: [], next: cursor || null };\n}\n",
		"src/payments.ts":
			"export async function reserveStock(items: string[]) {\n\treturn { items, at: Date.now() };\n}\n\nexport async function chargeCard(card: string, total: number) {\n\treturn { card: card.slice(-4), total };\n}\n",
		"test/checkout.test.ts":
			'import request from "supertest";\nimport { expect, test } from "vitest";\nimport { app } from "../src/server";\n\ntest("checkout reserves stock before charging", async () => {\n\tconst res = await request(app).post("/v1/checkout").send({ items: ["sku-1"], card: "4242424242424242", total: 1200 });\n\texpect(res.body.reservation.items).toEqual(["sku-1"]);\n});\n',
	},
	"web-app": {
		"package.json": `${JSON.stringify({ name: "web-app", version: "2.1.0", private: true, type: "module", scripts: { dev: "vite", build: "vite build" }, dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" }, devDependencies: { vite: "^6.0.0", typescript: "^5.6.0" } }, null, 2)}\n`,
		"README.md": "# web-app\n\nAcme's customer dashboard.\n",
		"src/settings/SettingsPage.tsx":
			'import "./settings.css";\n\nexport function SettingsPage() {\n\treturn (\n\t\t<main className="settings">\n\t\t\t<h1>Settings</h1>\n\t\t</main>\n\t);\n}\n',
		"src/settings/settings.css": ".settings {\n\tbackground: #ffffff;\n\tcolor: #1f2328;\n}\n",
	},
};

const RATE_LIMIT_TS = [
	'import type { NextFunction, Request, Response } from "express";',
	"",
	"interface Bucket {",
	"\ttokens: number;",
	"\tupdatedAt: number;",
	"}",
	"",
	"/** Token bucket per API key (`x-api-key`, else the client IP), refilled continuously. */",
	"export function rateLimit({ perMinute }: { perMinute: number }) {",
	"\tconst buckets = new Map<string, Bucket>();",
	"\tconst refillPerMs = perMinute / 60_000;",
	"\treturn (req: Request, res: Response, next: NextFunction) => {",
	'\t\tconst key = req.header("x-api-key") ?? req.ip ?? "anonymous";',
	"\t\tconst now = Date.now();",
	"\t\tconst bucket = buckets.get(key) ?? { tokens: perMinute, updatedAt: now };",
	"\t\tbucket.tokens = Math.min(perMinute, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);",
	"\t\tbucket.updatedAt = now;",
	"\t\tbuckets.set(key, bucket);",
	"\t\tif (bucket.tokens < 1) {",
	'\t\t\tres.setHeader("Retry-After", String(Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)));',
	'\t\t\treturn res.status(429).json({ error: "rate limit exceeded" });',
	"\t\t}",
	"\t\tbucket.tokens -= 1;",
	"\t\tnext();",
	"\t};",
	"}",
	"",
].join("\\n");

const steps = (...lines) => lines.join("\n");

export const fakeRules = [
	{
		match: "^Add rate limiting to the public API",
		script: steps(
			"title Add rate limiting to the public API",
			"think The public routes are mounted in src/server.ts. A token bucket per API key fits, with the client IP as the fallback.",
			`write src/middleware/rate-limit.ts ${RATE_LIMIT_TS}`,
			'edit src/server.ts import { publicRoutes } from "./routes/public"; => import { publicRoutes } from "./routes/public";\\nimport { rateLimit } from "./middleware/rate-limit";',
			'edit src/server.ts app.use("/v1", publicRoutes); => app.use("/v1", rateLimit({ perMinute: 100 }), publicRoutes);',
			"bash npx vitest run",
			"echo Done. Public routes are now limited to **100 requests per minute per API key**.\\n\\n- `src/middleware/rate-limit.ts:9`: a token bucket per `x-api-key` (falls back to the client IP), refilled continuously, so short bursts are allowed up to the limit.\\n- `src/server.ts:10`: mounted in front of `/v1`; `/v1/checkout` is unaffected.\\n- Over the limit the API answers `429` with `Retry-After` in seconds.\\n\\n| Case | Response |\\n| --- | --- |\\n| ≤ 100 req/min | passes through |\\n| over the limit | `429` + `Retry-After: 1` |\\n\\nThe buckets live in memory, so with several instances each one counts separately. Say if you want a Redis-backed store.",
			"cost 0.46",
		),
	},
	{
		match: "^The checkout test fails about one run in ten",
		script: steps(
			"approval always-ask",
			"think The test checks the reservation after the charge; reserveStock is not awaited before chargeCard.",
			"echo Let me reproduce it first by running the test in a loop.",
			"bash for i in $(seq 20); do npx vitest run checkout || break; done",
		),
	},
	{
		match: "^Draft the release notes for 1\\.5",
		script: steps(
			"write RELEASE_NOTES.md # acme-api 1.5\\n\\n- **Checkout** retries card authorization once on a network error.\\n- **Public API** pages `GET /v1/products` with `?cursor=`.\\n",
			"echo Drafted `RELEASE_NOTES.md` from the two unreleased entries in `CHANGELOG.md`.",
			"cost 0.18",
		),
	},
	{
		match: "Bump express to v5",
		script: steps("echo Reading the Express 5 migration guide and checking our routes for removed APIs…", "bash npm install express@5"),
	},
	{
		match: "^Add a dark theme to the settings page",
		script: steps(
			"title Dark theme for the settings page",
			"edit src/settings/settings.css .settings { => @media (prefers-color-scheme: dark) {\\n\t.settings {\\n\t\tbackground: #0d1117;\\n\t\tcolor: #e6edf3;\\n\t}\\n}\\n\\n.settings {",
			"echo The settings page now follows the system theme: dark colors under `prefers-color-scheme: dark` in `src/settings/settings.css`.",
			"cost 0.31",
		),
	},
	{
		match: "^Move the config loader",
		script: steps(
			"write src/config.ts export const config = {\\n\tport: Number(process.env.PORT ?? 3000),\\n};\\n",
			"echo Moved the settings into `src/config.ts`; `src/index.ts` reads the port from there.",
			"cost 0.22",
		),
	},
];

/** Earlier omp sessions in the demo projects over the last 30 days, as omp transcripts with `model_usage` lines. */
export function historyTranscripts(projects) {
	let seed = 7;
	const rand = () => {
		seed = (seed * 16807) % 2147483647;
		return seed / 2147483647;
	};
	const titles = {
		"acme-api": ["Paginate the products endpoint", "Retry card authorization", "Split the checkout router", "Typed config loader", "Add request ids to logs", "Fix the refund rounding bug"],
		"web-app": ["Settings page layout", "Debounce the search box", "Product list virtualization", "Fix the login redirect loop"],
	};
	const models = [
		["anthropic", "claude-sonnet-4-5", 1],
		["anthropic", "claude-opus-4-5", 2.6],
		["openai", "gpt-5.1-codex", 0.8],
	];
	const out = [];
	const now = Date.now();
	for (let day = 29; day >= 1; day--) {
		const sessions = rand() < 0.2 ? 0 : 1 + Math.floor(rand() * 3);
		for (let n = 0; n < sessions; n++) {
			const name = rand() < 0.65 ? "acme-api" : "web-app";
			const cwd = projects[name];
			const start = now - day * 86_400_000 + Math.floor(rand() * 8 * 3_600_000);
			const id = `${start.toString(16)}-${Math.floor(rand() * 1e9).toString(16)}`;
			const pick = titles[name][Math.floor(rand() * titles[name].length)];
			const [provider, model, price] = models[rand() < 0.6 ? 0 : rand() < 0.6 ? 1 : 2];
			const lines = [{ type: "session", version: 3, id, cwd, title: pick, timestamp: new Date(start).toISOString() }];
			const calls = 4 + Math.floor(rand() * 14);
			for (let c = 0; c < calls; c++) {
				const tokens = 8_000 + Math.floor(rand() * 40_000);
				lines.push({ type: "model_usage", provider, model, usage: { totalTokens: tokens, cost: { total: Number(((tokens / 1e6) * 3.2 * price).toFixed(4)) } }, timestamp: new Date(start + c * 60_000).toISOString() });
			}
			out.push({ cwd, name: `${new Date(start).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`, lines });
		}
	}
	return out;
}
