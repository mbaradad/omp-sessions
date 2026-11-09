// Sessions view organization: custom (nested) groups, colors, priorities, pins, archive, tags, lanes,
// manual order (Move Up/Down, drag & drop), grouping/sorting modes, filter and bulk actions.
// State lives in organize.json (shared/organize.ts) so every window and the CLI/daemon see it.

import * as fs from "node:fs";
import * as vscode from "vscode";
import { ORG_COLORS, type OrgColor, type OrgData, type OrgGroup, PRIORITIES, type Priority, childGroups, effectiveColor, groupPath } from "../shared/organize";
import { GROUP_MODES, type GroupMode, ROOT_KEY, SORT_MODES, type SortMode, isGroupMode, isSortMode, resolveSort } from "../shared/organize-view";
import { type SessionMeta, sessionDir } from "../shared/protocol";
import type { OmpApi } from "./api";
import { setChatDecorator } from "./panel";
import { plain } from "./plain";
import { type ContainerNode, type Node, isNode } from "./tree";

type SessionNode = Extract<Node, { kind: "session" }>;

/** Hex of the colored π used as chat tab icon (theme colors can't be used in an SVG file). */
const COLOR_HEX: Record<OrgColor, string> = {
	red: "#e5484d",
	orange: "#f76b15",
	yellow: "#e2b203",
	green: "#30a46c",
	blue: "#0090ff",
	purple: "#8e4ec6",
	pink: "#e93d82",
	gray: "#8b8d98",
};

/** Theme color for a group/session label color (used by tree.ts for icons). */
export function orgThemeColor(color: OrgColor | undefined): vscode.ThemeColor | undefined {
	return color ? new vscode.ThemeColor(`charts.${color}`) : undefined;
}

/** Colored marks for plain-text places (quick picks, side bar chat header). */
export const COLOR_EMOJI: Record<OrgColor, string> = {
	red: "🔴",
	orange: "🟠",
	yellow: "🟡",
	green: "🟢",
	blue: "🔵",
	purple: "🟣",
	pink: "🌸",
	gray: "⚫",
};

const PRIORITY_INFO: Record<Priority, { label: string; icon: string; badge?: string; color?: string }> = {
	urgent: { label: "Urgent", icon: "flame", badge: "‼", color: "charts.red" },
	high: { label: "High", icon: "arrow-up", badge: "!", color: "charts.orange" },
	normal: { label: "Normal", icon: "dash" },
	low: { label: "Low", icon: "arrow-down", badge: "↓", color: "disabledForeground" },
};

const GROUP_ICONS = [
	"folder",
	"star-full",
	"rocket",
	"beaker",
	"bug",
	"tools",
	"book",
	"briefcase",
	"lightbulb",
	"flame",
	"zap",
	"target",
	"shield",
	"globe",
	"server",
	"database",
	"package",
	"milestone",
	"calendar",
	"checklist",
	"comment-discussion",
	"heart",
	"home",
	"sparkle",
];

const GROUP_MODE_INFO: Record<GroupMode, { label: string; detail: string }> = {
	project: { label: "$(repo) Project", detail: "One folder per git repository / folder" },
	group: { label: "$(folder-library) Custom Groups", detail: "Your groups and sub-groups; ungrouped sessions at the bottom" },
	status: { label: "$(pulse) Status", detail: "Needs input · Working · Idle · Stopped" },
	none: { label: "$(list-flat) None", detail: "A flat list (other folders in their own section)" },
};

const SORT_MODE_INFO: Record<SortMode, { label: string; detail: string }> = {
	auto: { label: "$(wand) Automatic", detail: "Manual order when grouped by custom groups, else last activity" },
	manual: { label: "$(grabber) Manual", detail: "Your order: Move Up/Down (Alt+↑/↓) or drag & drop" },
	activity: { label: "$(history) Last Activity", detail: "Most recently active first" },
	priority: { label: "$(flame) Priority", detail: "Urgent → Low, then last activity" },
	name: { label: "$(case-sensitive) Name", detail: "Alphabetical" },
	created: { label: "$(calendar) Created", detail: "Newest first" },
	cost: { label: "$(credit-card) Cost", detail: "Most expensive first" },
};

function piSvg(hex: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 8 48 48"><path d="M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z" fill="${hex}"/></svg>`;
}

/** Groups as an indented, depth-first list (for pickers). */
function flattenGroups(data: OrgData, exclude?: string): Array<{ group: OrgGroup; depth: number }> {
	const out: Array<{ group: OrgGroup; depth: number }> = [];
	const walk = (parent: string | undefined, depth: number, seen: Set<string>) => {
		for (const g of childGroups(data, parent)) {
			if (g.id === exclude || seen.has(g.id)) continue;
			seen.add(g.id);
			out.push({ group: g, depth });
			walk(g.id, depth + 1, seen);
		}
	};
	walk(undefined, 0, new Set());
	return out;
}

/** Ids of a group and all groups below it. */
function subtree(data: OrgData, id: string): Set<string> {
	const ids = new Set([id]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const g of data.groups) {
			if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) {
				ids.add(g.id);
				grew = true;
			}
		}
	}
	return ids;
}

export function registerOrganize(api: OmpApi): void {
	const { context, organize: store, sessionTree: tree, sessionsView: view, sessions } = api;
	const reg = (name: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(name, fn));
	const config = () => vscode.workspace.getConfiguration("omp");
	const groupBy = (): GroupMode => {
		const v = config().get<string>("groupBy");
		return isGroupMode(v) ? v : "project";
	};
	const sortBy = (): SortMode => {
		const v = config().get<string>("sortBy");
		return isSortMode(v) ? v : "auto";
	};
	/** Writes a setting where the user keeps it (workspace override, else user settings). */
	const updateSetting = async (key: string, value: string) => {
		const inspected = config().inspect(key);
		const target = inspected?.workspaceFolderValue !== undefined || inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
		await config().update(key, value, target);
	};

	// ---------- view state: filter, archived, context keys ----------
	tree.showArchived = context.globalState.get<boolean>("omp.organize.showArchived") ?? false;
	tree.hideFinished = context.globalState.get<boolean>("omp.organize.hideFinished") ?? false;
	/** Description and empty message from the last render (no extra tree build). */
	const updateDescription = () => {
		const hidden = tree.hideFinished && tree.hiddenFinished ? `${tree.hiddenFinished} finished hidden` : "";
		const scope = sessions.scope() === "all" ? "all sessions" : "this workspace";
		view.description = [scope, tree.filter ? `Filtered: ${tree.filter}` : "", hidden].filter(Boolean).join(" · ");
		view.message =
			tree.rootCount > 0
				? undefined
				: tree.filter
					? `No sessions match “${tree.filter}”.`
					: hidden
						? `All sessions are finished (${tree.hiddenFinished} hidden). Show Finished Sessions lists them.`
						: sessions.scope() === "workspace" && sessions.all().length
							? "No sessions in this workspace's folders. Show All Sessions lists the others on this machine."
							: undefined;
	};
	tree.onRender = updateDescription;
	const updateChrome = () => {
		updateDescription();
		void vscode.commands.executeCommand("setContext", "omp.sessions.filtered", !!tree.filter);
		void vscode.commands.executeCommand("setContext", "omp.sessions.showArchived", tree.showArchived);
		void vscode.commands.executeCommand("setContext", "omp.sessions.hideFinished", tree.hideFinished);
		void vscode.commands.executeCommand("setContext", "omp.sessions.scopeAll", config().get<string>("sessionScope") === "all");
		void vscode.commands.executeCommand("setContext", "omp.sessions.groupBy", groupBy());
	};
	const setFilter = (text: string) => {
		tree.filter = text.trim();
		tree.refresh();
		updateChrome();
	};
	updateChrome();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration("omp.groupBy") || e.affectsConfiguration("omp.sessionScope")) updateChrome();
			if (e.affectsConfiguration("omp.sessionScope")) api.refreshTree();
		}),
	);

	// ---------- decorations: priority badges, chat tab colors ----------
	const decoEmitter = new vscode.EventEmitter<vscode.Uri[]>();
	const sessionUri = (id: string) => vscode.Uri.from({ scheme: "omp-org", path: `/session/${id}` });
	context.subscriptions.push(
		decoEmitter,
		vscode.window.registerFileDecorationProvider({
			onDidChangeFileDecorations: decoEmitter.event,
			provideFileDecoration(uri) {
				if (uri.scheme !== "omp-org") return undefined;
				const id = /^\/session\/(.+)$/.exec(uri.path)?.[1];
				const e = id ? store.data.sessions[id] : undefined;
				if (!e) return undefined;
				const p = e.priority ? PRIORITY_INFO[e.priority] : undefined;
				if (p?.badge) return { badge: p.badge, tooltip: `Priority: ${p.label}`, color: p.color ? new vscode.ThemeColor(p.color) : undefined };
				if (e.archived) return { tooltip: "Archived", color: new vscode.ThemeColor("disabledForeground") };
				return undefined;
			},
		}),
	);

	const iconDir = vscode.Uri.joinPath(context.globalStorageUri, "organize-icons");
	let iconsReady = false;
	const chatDecoration = (id: string) => {
		const color = effectiveColor(store.data, id);
		if (!color) return undefined;
		return { icon: iconsReady ? vscode.Uri.joinPath(iconDir, `pi-${color}.svg`) : undefined, mark: COLOR_EMOJI[color] };
	};
	setChatDecorator(chatDecoration);
	void (async () => {
		try {
			await vscode.workspace.fs.createDirectory(iconDir);
			for (const c of ORG_COLORS) await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(iconDir, `pi-${c}.svg`), new TextEncoder().encode(piSvg(COLOR_HEX[c])));
			iconsReady = true;
			setChatDecorator(chatDecoration);
		} catch {
			/* no storage: chats keep the default icon, the side bar still gets the mark */
		}
	})();

	// ---------- store sync, cleanup of deleted sessions, AO pins ----------
	/** Session ids of the last AO list; undefined until the first one arrived (an empty list before that means "not loaded", not "all deleted"). */
	let known: Set<string> | undefined;
	/** AO's pin of each session as last seen, so a pin set in AO's own apps comes over while ours is still in flight to AO. */
	const aoPins = new Map<string, boolean>();
	const cleanup = () => store.cleanup(id => !!sessions.get(id) || fs.existsSync(sessionDir(id)));
	const storeSub = store.onDidChange(() => {
		decoEmitter.fire(sessions.all().map(m => sessionUri(m.id)));
		setChatDecorator(chatDecoration);
		if (tree.filter) updateChrome();
	});
	const syncFromAo = () => {
		if (!sessions.loaded) return;
		const now = new Set(sessions.all().map(m => m.id));
		const removed = !known || [...known].some(id => !now.has(id));
		known = now;
		if (removed) {
			try {
				cleanup();
			} catch {
				/* read-only home: retried on the next removal */
			}
		}
		const pinned: string[] = [];
		const unpinned: string[] = [];
		for (const id of now) {
			const ao = sessions.model(id)?.pinned;
			if (ao === undefined || aoPins.get(id) === ao) continue;
			aoPins.set(id, ao);
			if (ao !== !!store.session(id).pinned) (ao ? pinned : unpinned).push(id);
		}
		if (pinned.length) store.setPinned(pinned, true);
		if (unpinned.length) store.setPinned(unpinned, false);
		if (tree.filter) updateChrome();
	};
	syncFromAo();
	context.subscriptions.push({ dispose: () => storeSub.dispose() }, sessions.onDidChange(syncFromAo));

	// ---------- collapse state ----------
	const remember = (node: Node, collapsed: boolean) => {
		if (tree.filter || node.kind === "session" || node.kind === "file") return;
		store.setCollapsed(node.key, collapsed);
	};
	context.subscriptions.push(
		view.onDidCollapseElement(e => remember(e.element, true)),
		view.onDidExpandElement(e => remember(e.element, false)),
	);

	// ---------- argument resolution (single click, multi-select, keybinding, palette) ----------
	const pickedNodes = (arg: unknown, all: unknown): Node[] => {
		if (Array.isArray(all)) {
			const nodes = all.filter(isNode);
			if (nodes.length) return nodes;
		}
		if (isNode(arg)) return [arg];
		if (arg === undefined && view.visible) return [...view.selection];
		return [];
	};
	const sessionIdsOf = (nodes: readonly Node[]): string[] => [...new Set(nodes.flatMap(n => (n.kind === "session" ? [n.meta.id] : n.kind === "file" ? [n.sessionId] : [])))];
	const groupsOf = (nodes: readonly Node[]): OrgGroup[] => nodes.flatMap(n => (n.kind === "orgGroup" ? [n.group] : []));
	async function targetSessions(arg: unknown, all: unknown, placeHolder: string, filter?: (m: SessionMeta) => boolean): Promise<SessionMeta[]> {
		let ids = typeof arg === "string" ? [arg] : sessionIdsOf(pickedNodes(arg, all));
		if (ids.length === 0 && !groupsOf(pickedNodes(arg, all)).length) {
			const id = await api.pickSession(placeHolder, filter);
			ids = id ? [id] : [];
		}
		return ids.map(id => sessions.get(id)).filter((m): m is SessionMeta => !!m);
	}
	async function pickGroupFrom(arg: unknown, all: unknown, placeHolder: string): Promise<OrgGroup | undefined> {
		const g = groupsOf(pickedNodes(arg, all))[0] ?? (typeof arg === "string" ? store.group(arg) : undefined);
		if (g) return g;
		const items = flattenGroups(store.data).map(({ group, depth }) => ({ label: `${"\u2003".repeat(depth)}$(${group.icon ?? "folder"}) ${group.name}`, group }));
		if (items.length === 0) {
			void vscode.window.showInformationMessage("No custom groups yet. Create one with New Group….");
			return undefined;
		}
		return (await vscode.window.showQuickPick(items, { placeHolder }))?.group;
	}

	const offerGroupMode = () => {
		if (groupBy() === "group") return;
		void vscode.window.showInformationMessage("Custom groups show when the Sessions view is grouped by Custom Groups.", "Group by Custom Groups").then(a => {
			if (a) void updateSetting("groupBy", "group");
		});
	};

	/** Asks for a group name and creates it. */
	async function createGroup(parentId?: string): Promise<OrgGroup | undefined> {
		const parent = store.group(parentId);
		const name = (await vscode.window.showInputBox({ prompt: parent ? `New group inside “${groupPath(store.data, parent.id)}”` : "New group name", placeHolder: "e.g. Feature X, Bugs, Research" }))?.trim();
		if (!name) return undefined;
		return store.createGroup({ name, parentId: parent?.id });
	}

	/** Group to move into: an existing group, a new one, or `null` for "no group". */
	async function pickTargetGroup(placeHolder: string, opts: { exclude?: Set<string>; none: string; current?: string }): Promise<OrgGroup | null | undefined> {
		type Item = vscode.QuickPickItem & { action: "new" | "none" | "group"; group?: OrgGroup };
		const groups = flattenGroups(store.data).filter(x => !opts.exclude?.has(x.group.id));
		const items: Item[] = [
			{ label: "$(new-folder) New Group…", action: "new" },
			{ label: `$(close) ${opts.none}`, action: "none" },
			...(groups.length ? [{ label: "Groups", kind: vscode.QuickPickItemKind.Separator, action: "none" as const }] : []),
			...groups.map(({ group, depth }): Item => ({
				label: `${"\u2003".repeat(depth)}$(${group.icon ?? "folder"}) ${group.name}`,
				description: [group.color ? COLOR_EMOJI[group.color] : "", group.id === opts.current ? "current" : ""].filter(Boolean).join(" "),
				action: "group",
				group,
			})),
		];
		const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
		if (!pick) return undefined;
		if (pick.action === "none") return null;
		if (pick.action === "new") return (await createGroup()) ?? undefined;
		return pick.group;
	}

	/** Switches to manual order, keeping the order currently shown in `siblings`. */
	async function ensureManual(siblings: readonly string[]): Promise<void> {
		if (resolveSort(sortBy(), groupBy()) === "manual") return;
		store.reorder(siblings);
		await updateSetting("sortBy", "manual");
		vscode.window.setStatusBarMessage("$(grabber) Sessions are now sorted manually", 4000);
	}

	// ---------- drag & drop ----------
	tree.onDrop = async (target, dragged) => {
		const ids = sessionIdsOf(dragged.filter(n => n.kind === "session"));
		const groups = groupsOf(dragged);
		let container: Node | undefined = target?.kind === "file" ? tree.findSession(target.sessionId) : target;
		let before: string | undefined;
		if (container?.kind === "session") {
			before = container.meta.id;
			container = tree.getParent(container);
		}
		const box: ContainerNode | undefined = container && container.kind !== "session" && container.kind !== "file" ? container : undefined;
		for (const g of groups) {
			const parentId = box?.kind === "orgGroup" ? box.group.id : undefined;
			if (g.id === parentId) continue;
			if (!store.moveGroup(g.id, parentId)) void vscode.window.showWarningMessage(plain(`Can't move “${g.name}” into its own sub-group.`));
		}
		if (ids.length === 0) return;
		const sameBox = dragged.every(n => n.kind !== "session" || n.parent === (box?.key ?? ROOT_KEY));
		if (!sameBox) {
			store.update(d => {
				for (const id of ids) {
					const e = d.sessions[id] ?? {};
					if (box?.kind === "section" && box.section === "pinned") {
						e.pinned = true;
						delete e.archived;
					} else if (box?.kind === "section" && box.section === "archived") e.archived = true;
					else {
						delete e.pinned;
						delete e.archived;
						if (box?.kind === "orgGroup") e.groupId = box.group.id;
						else if ((box?.kind === "section" && box.section === "ungrouped") || (!box && groupBy() === "group")) delete e.groupId;
					}
					d.sessions[id] = e;
				}
			});
		}
		if (!before || ids.includes(before)) return;
		const siblings = tree.sessionIdsIn(box?.key ?? ROOT_KEY);
		if (sameBox) await ensureManual(siblings);
		else if (resolveSort(sortBy(), groupBy()) !== "manual") return;
		const rest = siblings.filter(id => !ids.includes(id));
		store.place(ids, siblings, rest.indexOf(before));
	};

	// ---------- view title ----------
	reg("omp.toggleGrouping", async () => {
		const current = groupBy();
		const pick = await vscode.window.showQuickPick(
			GROUP_MODES.map(mode => ({ label: GROUP_MODE_INFO[mode].label, detail: GROUP_MODE_INFO[mode].detail, description: mode === current ? "current" : undefined, mode })),
			{ placeHolder: "Group the Sessions view by" },
		);
		if (pick && pick.mode !== current) await updateSetting("groupBy", pick.mode);
	});

	reg("omp.organize.sortBy", async () => {
		const current = sortBy();
		const pick = await vscode.window.showQuickPick(
			SORT_MODES.map(mode => ({ label: SORT_MODE_INFO[mode].label, detail: SORT_MODE_INFO[mode].detail, description: mode === current ? "current" : undefined, mode })),
			{ placeHolder: "Sort sessions within each group by" },
		);
		if (pick && pick.mode !== current) await updateSetting("sortBy", pick.mode);
	});

	reg("omp.organize.filter", () => {
		const before = tree.filter;
		const box = vscode.window.createInputBox();
		box.title = "Filter Sessions";
		box.placeholder = "Words to match in title, #tags, project, group, color, priority, last reply…";
		box.prompt = "Live filter: all words must match. Enter keeps it, Escape restores the previous filter.";
		box.value = before;
		let accepted = false;
		box.onDidChangeValue(v => setFilter(v));
		box.onDidAccept(() => {
			accepted = true;
			box.hide();
		});
		box.onDidHide(() => {
			if (!accepted) setFilter(before);
			box.dispose();
		});
		box.show();
	});
	reg("omp.organize.clearFilter", () => setFilter(""));

	const setShowArchived = (value: boolean) => {
		tree.showArchived = value;
		void context.globalState.update("omp.organize.showArchived", value);
		tree.refresh();
		updateChrome();
	};
	reg("omp.organize.showArchived", () => setShowArchived(true));
	reg("omp.organize.hideArchived", () => setShowArchived(false));
	const setHideFinished = (value: boolean) => {
		tree.hideFinished = value;
		void context.globalState.update("omp.organize.hideFinished", value);
		tree.refresh();
		updateChrome();
	};
	reg("omp.organize.hideFinished", () => setHideFinished(true));
	reg("omp.organize.showFinished", () => setHideFinished(false));
	reg("omp.sessions.showAll", () => updateSetting("sessionScope", "all"));
	reg("omp.sessions.showWorkspace", () => updateSetting("sessionScope", "workspace"));

	reg("omp.organize.newGroup", async (arg?: unknown, all?: unknown) => {
		const nodes = pickedNodes(arg, all);
		const parent = groupsOf(nodes)[0];
		const group = await createGroup(parent?.id);
		if (!group) return;
		const ids = sessionIdsOf(nodes);
		if (ids.length) store.setGroup(ids, group.id);
		offerGroupMode();
	});

	// ---------- sessions (multi-select aware) ----------
	reg("omp.organize.moveToGroup", async (arg?: unknown, all?: unknown) => {
		const nodes = pickedNodes(arg, all);
		const groups = groupsOf(nodes);
		const metas = groups.length ? sessionIdsOf(nodes).flatMap(id => sessions.get(id) ?? []) : await targetSessions(arg, all, "Move which session to a group?");
		if (!metas.length && !groups.length) return;
		const exclude = new Set(groups.flatMap(g => [...subtree(store.data, g.id)]));
		const current = metas.length === 1 && !groups.length ? store.session(metas[0].id).groupId : undefined;
		const what = [metas.length ? `${metas.length} session${metas.length === 1 ? "" : "s"}` : "", groups.length ? `${groups.length} group${groups.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
		const target = await pickTargetGroup(`Move ${what} to…`, { exclude, none: groups.length ? "Top Level / No Group" : "No Group", current });
		if (target === undefined) return;
		const gid = target?.id;
		if (metas.length) store.setGroup(metas.map(m => m.id), gid);
		for (const g of groups) store.moveGroup(g.id, gid);
		if (gid) offerGroupMode();
	});

	reg("omp.organize.removeFromGroup", async (arg?: unknown, all?: unknown) => {
		const metas = await targetSessions(arg, all, "Remove which session from its group?", m => !!store.session(m.id).groupId);
		store.setGroup(
			metas.map(m => m.id),
			undefined,
		);
	});

	reg("omp.organize.setColor", async (arg?: unknown, all?: unknown) => {
		const nodes = pickedNodes(arg, all);
		const groups = groupsOf(nodes);
		const metas = groups.length ? sessionIdsOf(nodes).flatMap(id => sessions.get(id) ?? []) : await targetSessions(arg, all, "Color which session?");
		if (!metas.length && !groups.length) return;
		const current = metas.length === 1 && !groups.length ? store.session(metas[0].id).color : groups.length === 1 && !metas.length ? groups[0].color : undefined;
		const items = [
			{ label: "$(circle-slash) No Color", color: undefined, description: current === undefined ? "current" : undefined },
			...ORG_COLORS.map(c => ({ label: `${COLOR_EMOJI[c]} ${c[0].toUpperCase()}${c.slice(1)}`, color: c, description: c === current ? "current" : undefined })),
		];
		const pick = await vscode.window.showQuickPick(items, { placeHolder: groups.length ? "Color of the group (its sessions inherit it)" : "Color label of the session" });
		if (!pick) return;
		if (metas.length) store.setColor(
			metas.map(m => m.id),
			pick.color,
		);
		for (const g of groups) store.updateGroup(g.id, { color: pick.color ?? null });
	});

	reg("omp.organize.setPriority", async (arg?: unknown, all?: unknown) => {
		const metas = await targetSessions(arg, all, "Set the priority of which session?");
		if (!metas.length) return;
		const current = metas.length === 1 ? (store.session(metas[0].id).priority ?? "normal") : undefined;
		const pick = await vscode.window.showQuickPick(
			PRIORITIES.map(p => ({ label: `$(${PRIORITY_INFO[p].icon}) ${PRIORITY_INFO[p].label}`, description: p === current ? "current" : undefined, priority: p })),
			{ placeHolder: `Priority of ${metas.length === 1 ? `“${metas[0].title}”` : `${metas.length} sessions`} (also decides which waiting session runs next)` },
		);
		if (pick) store.setPriority(
			metas.map(m => m.id),
			pick.priority,
		);
	});

	const flagCommand = (name: string, placeHolder: string, apply: (ids: string[]) => void, filter?: (m: SessionMeta) => boolean) =>
		reg(name, async (arg?: unknown, all?: unknown) => {
			const metas = await targetSessions(arg, all, placeHolder, filter);
			if (metas.length) apply(metas.map(m => m.id));
		});
	/** Pins live in AO too (its apps show them); organize.json keeps the copy the views sort by. */
	const pin = (ids: string[], pinned: boolean) => {
		store.setPinned(ids, pinned);
		for (const id of ids) void sessions.setPinned(id, pinned).catch(err => api.ao.log.warn(`AO pin ${id}: ${String(err)}`));
	};
	flagCommand("omp.organize.pin", "Pin which session?", ids => pin(ids, true), m => !store.session(m.id).pinned);
	flagCommand("omp.organize.unpin", "Unpin which session?", ids => pin(ids, false), m => !!store.session(m.id).pinned);
	flagCommand(
		"omp.organize.archive",
		"Archive which session?",
		ids => {
			store.setArchived(ids, true);
			if (!tree.showArchived) vscode.window.setStatusBarMessage(`$(archive) Archived ${ids.length} session${ids.length === 1 ? "" : "s"} — Show Archived lists them again`, 5000);
		},
		m => !store.session(m.id).archived,
	);
	flagCommand("omp.organize.unarchive", "Unarchive which session?", ids => store.setArchived(ids, false), m => !!store.session(m.id).archived);

	reg("omp.organize.editTags", async (arg?: unknown, all?: unknown) => {
		const metas = await targetSessions(arg, all, "Tag which session?");
		if (!metas.length) return;
		if (metas.length === 1) {
			const value = (store.session(metas[0].id).tags ?? []).map(t => `#${t}`).join(" ");
			const input = await vscode.window.showInputBox({ prompt: `Tags of “${metas[0].title}” (space separated; empty removes all)`, value, placeHolder: "#bug #frontend" });
			if (input !== undefined) store.setTags([metas[0].id], input.split(/[\s,]+/));
			return;
		}
		const input = await vscode.window.showInputBox({ prompt: `Tags for ${metas.length} sessions: words add tags, -word removes one`, placeHolder: "#review -wip" });
		if (input === undefined) return;
		const words = input.split(/[\s,]+/).filter(Boolean);
		const add = words.filter(w => !w.startsWith("-"));
		const remove = new Set(words.filter(w => w.startsWith("-")).map(w => w.replace(/^-#?/, "").toLowerCase()));
		store.update(d => {
			for (const m of metas) {
				const e = d.sessions[m.id] ?? {};
				e.tags = [...(e.tags ?? []).filter(t => !remove.has(t.toLowerCase())), ...add];
				d.sessions[m.id] = e;
			}
		});
	});

	reg("omp.organize.setLane", async (arg?: unknown, all?: unknown) => {
		const metas = await targetSessions(arg, all, "Move which session to a board lane?");
		if (!metas.length) return;
		const current = metas.length === 1 ? store.session(metas[0].id).lane : undefined;
		const pick = await vscode.window.showQuickPick(
			[{ label: "$(close) No Lane", lane: undefined, description: undefined }, ...store.lanes().map(l => ({ label: `${l.color ? `${COLOR_EMOJI[l.color]} ` : ""}${l.name}`, lane: l.id, description: l.id === current ? "current" : undefined }))],
			{ placeHolder: "Board lane" },
		);
		if (pick) store.setLane(
			metas.map(m => m.id),
			pick.lane,
		);
	});

	// ---------- manual order ----------
	const moveCommand = (name: string, delta: number | "top") =>
		reg(name, async (arg?: unknown, all?: unknown) => {
			const node = pickedNodes(arg, all)[0] ?? (typeof arg === "string" ? tree.findSession(arg) : undefined);
			if (!node) return;
			if (node.kind === "orgGroup") {
				if (delta === "top") store.moveGroup(node.group.id, node.group.parentId, 0);
				else store.shiftGroup(node.group.id, delta);
				return;
			}
			const sessionNode: SessionNode | undefined = node.kind === "session" ? node : node.kind === "file" ? tree.findSession(node.sessionId) : undefined;
			if (!sessionNode) return;
			const siblings = tree.sessionIdsIn(sessionNode.parent);
			await ensureManual(siblings);
			if (delta === "top") store.moveToTop([sessionNode.meta.id], siblings);
			else store.move(sessionNode.meta.id, delta, siblings);
		});
	moveCommand("omp.organize.moveUp", -1);
	moveCommand("omp.organize.moveDown", 1);
	moveCommand("omp.organize.moveToTop", "top");

	// ---------- groups ----------
	reg("omp.organize.newSubgroup", async (arg?: unknown, all?: unknown) => {
		const parent = await pickGroupFrom(arg, all, "New sub-group inside which group?");
		if (parent && (await createGroup(parent.id))) offerGroupMode();
	});

	reg("omp.organize.renameGroup", async (arg?: unknown, all?: unknown) => {
		const g = await pickGroupFrom(arg, all, "Rename which group?");
		if (!g) return;
		const name = (await vscode.window.showInputBox({ prompt: "Group name", value: g.name }))?.trim();
		if (name && name !== g.name) store.updateGroup(g.id, { name });
	});

	reg("omp.organize.setGroupIcon", async (arg?: unknown, all?: unknown) => {
		const g = await pickGroupFrom(arg, all, "Change the icon of which group?");
		if (!g) return;
		const pick = await vscode.window.showQuickPick(
			[
				...GROUP_ICONS.map(icon => ({ label: `$(${icon}) ${icon}`, icon, description: icon === (g.icon ?? "folder") ? "current" : undefined })),
				{ label: "$(edit) Other codicon…", icon: "", description: "Any name from code.visualstudio.com/api/references/icons-in-labels" },
			],
			{ placeHolder: `Icon of “${g.name}”` },
		);
		if (!pick) return;
		const icon = pick.icon || (await vscode.window.showInputBox({ prompt: "Codicon name (e.g. rocket, bug, beaker)", validateInput: v => (/^[a-z0-9-]+$/.test(v.trim()) ? undefined : "Lowercase letters, digits and dashes") }))?.trim();
		if (icon) store.updateGroup(g.id, { icon: icon === "folder" ? null : icon });
	});

	reg("omp.organize.deleteGroup", async (arg?: unknown, all?: unknown) => {
		const g = await pickGroupFrom(arg, all, "Delete which group?");
		if (!g) return;
		const ids = subtree(store.data, g.id);
		const count = Object.values(store.data.sessions).filter(e => e.groupId && ids.has(e.groupId)).length;
		const parent = store.group(g.parentId);
		if (count > 0 || ids.size > 1) {
			const ok = await vscode.window.showWarningMessage(
				`Delete the group “${g.name}”?`,
				{ modal: true, detail: `Its sessions and sub-groups move to ${parent ? `“${parent.name}”` : "the top level"}. No session is deleted.` },
				"Delete Group",
			);
			if (ok !== "Delete Group") return;
		}
		store.deleteGroup(g.id);
	});

	reg("omp.organize.newSessionInGroup", async (arg?: unknown, all?: unknown) => {
		const g = await pickGroupFrom(arg, all, "New session in which group?");
		if (!g) return;
		const cwd = await api.pickFolder();
		if (!cwd) return;
		const panel = await api.launchAndOpen({ cwd });
		if (panel) store.setGroup([panel.sessionId], g.id);
	});

	// ---------- bulk lifecycle ----------
	reg("omp.organize.stopSelected", async (arg?: unknown, all?: unknown) => {
		const metas = (await targetSessions(arg, all, "Stop which session?", m => m.status !== "stopped")).filter(m => m.status !== "stopped");
		if (!metas.length) return;
		const working = metas.filter(m => m.status === "working").length;
		if (working || metas.length > 1) {
			const ok = await vscode.window.showWarningMessage(
				`Stop ${metas.length === 1 ? `“${metas[0].title}”` : `${metas.length} sessions`}?`,
				{ modal: true, detail: `${working ? `${working} ${working === 1 ? "is" : "are"} working. ` : ""}The omp agents exit; the sessions and transcripts stay and can be resumed.` },
				"Stop",
			);
			if (ok !== "Stop") return;
		}
		const failed = (await Promise.allSettled(metas.map(m => sessions.stop(m.id)))).filter(r => r.status === "rejected");
		if (failed.length) void vscode.window.showErrorMessage(plain(`Could not stop ${failed.length} session(s): ${String((failed[0] as PromiseRejectedResult).reason)}`));
	});

	reg("omp.organize.resumeSelected", async (arg?: unknown, all?: unknown) => {
		const metas = (await targetSessions(arg, all, "Resume which session?", m => m.status === "stopped")).filter(m => m.status === "stopped");
		if (metas.length === 1) {
			await api.launchAndOpen({ cwd: metas[0].cwd, id: metas[0].id });
			return;
		}
		let started = 0;
		for (const m of metas) {
			try {
				await sessions.resume(m.id);
				started++;
			} catch (err) {
				void vscode.window.showErrorMessage(plain(`Could not resume “${m.title}”: ${err instanceof Error ? err.message : String(err)}`));
				break;
			}
		}
		if (started) vscode.window.setStatusBarMessage(`$(debug-start) Resumed ${started} session${started === 1 ? "" : "s"}`, 4000);
	});

	reg("omp.organize.deleteSelected", async (arg?: unknown, all?: unknown) => {
		const picked = await targetSessions(arg, all, "Delete which stopped session?", m => m.status === "stopped");
		const metas = picked.filter(m => m.status === "stopped");
		const running = picked.length - metas.length;
		if (!metas.length) {
			if (running) void vscode.window.showWarningMessage("Stop the sessions before deleting them.");
			return;
		}
		const ok = await vscode.window.showWarningMessage(
			`Remove ${metas.length === 1 ? `“${metas[0].title}”` : `${metas.length} stopped sessions`}?`,
			{
				modal: true,
				detail: `Deletes the sessions from AO, with their worktrees when they have no uncommitted changes. omp transcripts stay in ~/.omp/agent/sessions.${running ? ` ${running} running session${running === 1 ? " is" : "s are"} skipped.` : ""}`,
			},
			"Remove",
		);
		if (ok !== "Remove") return;
		for (const m of metas) {
			api.closePanel(m.id);
			try {
				await sessions.remove(m.id);
			} catch (err) {
				void vscode.window.showErrorMessage(plain(`Could not remove “${m.title}”: ${err instanceof Error ? err.message : String(err)}`));
			}
		}
	});
}
