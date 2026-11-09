// What the page needs from its host, and the shapes of the plugin backend's answers
// (integrations/hermes/switchyard/dashboard/plugin_api.py).
import type { ReactLike } from "./react";

export interface RequestOptions {
	method?: "GET" | "POST";
	/** Sent as JSON. */
	body?: unknown;
}

export interface Host {
	kind: "dashboard" | "desktop";
	React: ReactLike;
	/** JSON request to the plugin's backend; `path` is relative to /api/plugins/switchyard. */
	request<T>(path: string, options?: RequestOptions): Promise<T>;
	/** The page's CSS, when the host doesn't load dist/style.css itself (Desktop). */
	css?: string;
	/** Opens an "Open in VS Code" link: the dashboard (a browser) opens `url`; Desktop opens only web links, so `page`. */
	openVscode(link: VscodeLink): Promise<void>;
}

/** POST /sessions/<id>/vscode: the request is recorded on omp's machine; these links bring up VS Code. */
export interface VscodeLink {
	/** vscode://… link. */
	url: string;
	/** Web page of this dashboard that opens `url`. */
	page: string;
	/** The folder a project/folder link opens (absent for a session's chat). */
	folder?: string | null;
	/** Remote authority of the VS Code window last used on omp's machine ("" local, null none recorded). */
	authority?: string | null;
	windowAt?: number | null;
}

/** GET /models: `switchyard models --json`. */
export interface Model {
	/** provider/id: what a session's model is set to. */
	selector: string;
	provider: string;
	id: string;
	name?: string;
	contextWindow?: number;
	/** The Switchyard default. */
	default?: boolean;
}

export interface Models {
	models: Model[];
	/** The Switchyard default model for new sessions (null: omp's own default). */
	default: string | null;
	ompDefault?: string | null;
	/** The session whose omp's choices these are; null when no session is running (then `note` says so and the list is empty). */
	source?: string | null;
	note?: string;
}

export type State = "queued" | "scheduled" | "starting" | "working" | "needs_input" | "idle" | "interrupted" | "stopped";
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

/** Kanban dependency links: a child card waits for its parents. */
export interface CardLinks {
	parents: string[];
	children: string[];
}

export interface CardRef extends Partial<CardLinks> {
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
	/** What the state belongs to (the latest turn, or the waiting question): the sounds' dedupe key. */
	turnId?: string | null;
	group?: string | null;
	color?: string | null;
	priority?: string | null;
	tags: string[];
	archived: boolean;
	/** Marked completed (switchyard complete): done, whatever its state. */
	completed: boolean;
	completedAt?: number | null;
	queue: { pending: number; running: number; done: number; total: number; failed?: number; interrupted?: number };
	/** The queue runs its pending tasks by itself (off: paused, or waiting for `startAt`). */
	autoRun?: boolean;
	startAt?: number | null;
	waiting?: { position: number; since?: number; launch?: boolean } | null;
	excerpt?: string | null;
	exitReason?: string | null;
	authProblem?: string | null;
	question?: Question | null;
	/** Parent edges of the session's task (GRAPH-PROPAGATION.md): how far each parent's changes reached it. */
	upstream?: UpstreamEdge[];
	card?: CardRef | null;
	/** Detail only: the full last reply. */
	reply?: string | null;
}

export type SyncState = "in-sync" | "pending" | "merged" | "resolving" | "conflict" | "upstream-changed";

export interface UpstreamEdge {
	/** The parent's omp session. */
	parent?: string | null;
	state: SyncState;
	/** Conflicting files (state conflict). */
	files: string[];
}

export interface Scheduler {
	maxConcurrent?: number;
	paused?: boolean;
	running?: number;
	waiting?: number;
	server?: boolean;
}

/** The kanban dispatcher's last tick as the lane saw it: when, in which profile, and whether that
 *  profile has the lane on. */
export interface Dispatcher {
	at: number;
	profile: string;
	laneOn: boolean;
}

export interface Lane {
	enabled: boolean;
	assignee: string;
	mode?: Mode | null;
	boards: string[] | "all";
	linked: number;
	/** null: no dispatcher tick seen yet; absent: a backend that doesn't report it (unknown). */
	dispatcher?: Dispatcher | null;
	/** Ready-made warnings about the dispatcher (none when all is well). */
	notes?: string[];
}

export interface Overview {
	profile: string;
	switchyard: { found: boolean; command?: string | null; hint?: string | null; cli?: string; server?: string | null; pid?: number | null; error?: string };
	scheduler: Scheduler | null;
	notify: boolean;
	lane: Lane;
	/** The plugin version on the backend (the Desktop page compares it with its own). */
	pluginVersion?: string;
}

export interface LinkedCard extends Partial<CardLinks> {
	id: string;
	title?: string | null;
	status: string;
	session?: string | null;
	sessionState: string;
	laneState?: string | null;
	waitingOnInput: boolean;
	error?: string | null;
}

/** What Switchyard's planner says about a card's session (plugin_api.card_plan). */
export interface CardPlan {
	/** blocked, scheduled, held, paused, waiting, interrupted or running; null once the work is done. */
	state: string | null;
	/** Why the work is held (provider limit, usage window, budget, backoff). */
	reason?: string;
	/** Epoch ms the wait ends. */
	until?: number;
	/** Cards whose sessions this one is queued after (the planner's mirror of the card's parents). */
	after: string[];
	/** The unfinished ones of those. */
	blockedBy: string[];
	/** The worst propagation state of the merges from the parents' work (in-sync, merged, pending, upstream-changed, resolving, conflict). */
	upstream?: string;
}

/** A card of the board (archived ones aside) for the dependency graph. */
export interface GraphCard extends CardLinks {
	id: string;
	title: string;
	status: string;
	assignee?: string | null;
	/** The omp session working on the card: the lane's, else the latest tagged with it. */
	session?: string | null;
	/** That session's state ("removed" when it's gone; "not created" for a lane card not started yet). */
	sessionState?: string | null;
	/** The kanban lane runs this card. */
	lane: boolean;
	laneState?: string | null;
	/** The planner's view of that session (absent from an older backend, null without a session). */
	plan?: CardPlan | null;
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
	/** Model of the board's card sessions (a card's own model override wins). */
	model?: string | null;
	/** This board's trusted comment authors (null: the lane's list). */
	commentAuthors?: string[] | null;
	/** Whose comments reach omp and whose @switchyard assigns cards on this board ("*": anyone). */
	effectiveCommentAuthors: string[];
	/** This board's archive_completed (null: the lane's setting). */
	archiveCompleted?: boolean | null;
	/** Whether the lane archives the cards it completes on this board (and their omp sessions). */
	effectiveArchiveCompleted: boolean;
	linked: LinkedCard[];
	ready: Array<{ id: string; title: string } & Partial<CardLinks>>;
	/** Absent from an older backend. */
	cards?: GraphCard[];
	lastPass?: number | null;
	error?: string | null;
}

export interface BoardsView {
	profile: string;
	enabled: boolean;
	assignee: string;
	mode?: Mode | null;
	archiveCompleted: boolean;
	allBoards: boolean;
	boards: Board[];
}

/** POST /sessions/archive-done: the done sessions it archived, and the ones switchyard refused. */
export interface ArchiveDone {
	archived: string[];
	failed: Array<{ id: string; error: string }>;
}

/** POST /boards/<slug>/archive-done: the board's done lane cards it archived, with their omp sessions. */
export interface ArchiveDoneCards {
	archived: string[];
	sessions: string[];
	failed: Record<string, string>;
	view: BoardsView;
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
	model?: string;
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

export const NOT_MOUNTED = "The Switchyard backend is not running here: enable the plugin (hermes plugins enable switchyard) and restart Hermes.";
