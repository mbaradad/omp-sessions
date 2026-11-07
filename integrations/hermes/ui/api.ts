// What the page needs from its host, and the shapes of the plugin backend's answers
// (integrations/hermes/omp-sessions/dashboard/plugin_api.py).
import type { ReactLike } from "./react";

export interface RequestOptions {
	method?: "GET" | "POST";
	/** Sent as JSON. */
	body?: unknown;
}

export interface Host {
	kind: "dashboard" | "desktop";
	React: ReactLike;
	/** JSON request to the plugin's backend; `path` is relative to /api/plugins/omp-sessions. */
	request<T>(path: string, options?: RequestOptions): Promise<T>;
	/** The page's CSS, when the host doesn't load dist/style.css itself (Desktop). */
	css?: string;
}

export type State = "queued" | "starting" | "working" | "needs_input" | "idle" | "stopped";
export type Mode = "ask" | "edits" | "plan" | "auto";
export const MODES: readonly Mode[] = ["ask", "edits", "plan", "auto"];
export const MODE_INFO: Record<Mode, { label: string; detail: string }> = {
	ask: { label: "Ask", detail: "approve every edit and command" },
	edits: { label: "Edits", detail: "edits run, commands ask" },
	plan: { label: "Plan", detail: "read-only" },
	auto: { label: "Auto", detail: "everything runs" },
};

export interface Question {
	id: string;
	kind: string;
	title: string;
	message?: string;
	options?: string[];
	questions?: Array<{ question: string; options: string[]; multi: boolean }>;
}

export interface CardRef {
	board: string;
	id: string;
	title?: string | null;
	status?: string | null;
}

export interface Session {
	id: string;
	title: string;
	cwd: string;
	/** cwd with the home directory as ~. */
	cwdLabel: string;
	project: string;
	state: State;
	status: string;
	mode?: Mode | null;
	model?: string | null;
	cost: number;
	changedFiles: number;
	createdAt?: number;
	updatedAt?: number;
	group?: string | null;
	color?: string | null;
	priority?: string | null;
	tags: string[];
	archived: boolean;
	queue: { pending: number; running: number; done: number; total: number };
	startAt?: number | null;
	waiting?: { position: number; since?: number; launch?: boolean } | null;
	excerpt?: string | null;
	exitReason?: string | null;
	authProblem?: string | null;
	question?: Question | null;
	card?: CardRef | null;
	/** Detail only: the full last reply. */
	reply?: string | null;
}

export interface Scheduler {
	maxConcurrent?: number;
	paused?: boolean;
	running?: number;
	waiting?: number;
	server?: boolean;
}

export interface Overview {
	profile: string;
	ompVs: { found: boolean; command?: string | null; hint?: string | null; cli?: string; server?: string | null; pid?: number | null; error?: string };
	scheduler: Scheduler | null;
	notify: boolean;
	lane: { enabled: boolean; assignee: string; mode?: Mode | null; boards: string[] | "all"; linked: number };
}

export interface LinkedCard {
	id: string;
	title?: string | null;
	status: string;
	session?: string | null;
	sessionState: string;
	laneState?: string | null;
	waitingOnInput: boolean;
	error?: string | null;
}

export interface Board {
	slug: string;
	name: string;
	lane: boolean;
	listed: boolean;
	folder?: string | null;
	group?: string | null;
	defaultGroup: string;
	mode?: Mode | null;
	assignee?: string | null;
	effectiveAssignee: string;
	effectiveMode?: Mode | null;
	linked: LinkedCard[];
	ready: Array<{ id: string; title: string }>;
	lastPass?: number | null;
	error?: string | null;
}

export interface BoardsView {
	profile: string;
	enabled: boolean;
	assignee: string;
	mode?: Mode | null;
	allBoards: boolean;
	boards: Board[];
}

export interface Places {
	folders: Array<{ name: string; path: string; label: string; sessions?: number; lastUsed?: number }>;
	boards: Array<{ slug: string; name?: string | null; folder?: string | null; group?: string | null; lane: boolean }>;
	hermesProjects: Array<{ id: string; slug: string; name: string; path?: string | null }>;
	configured: Record<string, string>;
}

export interface StartBody {
	prompt: string;
	title?: string;
	where: { kind: "project" | "folder" | "board"; value: string };
	mode?: Mode;
	group?: string;
	tags?: string[];
	when: "now" | "queue" | "at";
	at?: string;
}

export interface Started {
	id: string;
	started: boolean;
	title: string;
	cwd: string;
	startAt?: number;
}

/** The message of a failed request. The dashboard's fetchJSON throws an ApiError whose message is
 *  the body's detail/error and whose `status` is the HTTP status; Desktop's ctx.rest throws
 *  Error("<status>: <body>"). The backend's body is {"error": "..."} (FastAPI's own: {"detail": ...}). */
export function errorMessage(err: unknown): string {
	const text = err instanceof Error ? err.message : String(err);
	const status = err && typeof err === "object" && "status" in err && typeof err.status === "number" ? err.status : undefined;
	const m = /^(\d{3}):\s*([\s\S]*)$/.exec(text);
	let code = status;
	let detail = text.trim();
	if (m) {
		code = Number(m[1]);
		detail = m[2].trim();
		try {
			const body: unknown = JSON.parse(detail);
			if (body && typeof body === "object") {
				if ("error" in body && typeof body.error === "string") return body.error;
				if ("detail" in body && typeof body.detail === "string") detail = body.detail;
			}
		} catch {
			/* not JSON */
		}
	}
	if (code === 404 && (!detail || detail === "Not Found")) return NOT_MOUNTED;
	return detail || `HTTP ${code ?? "error"}`;
}

export const NOT_MOUNTED = "The omp Sessions backend is not running here: enable the plugin (hermes plugins enable omp-sessions) and restart Hermes.";
