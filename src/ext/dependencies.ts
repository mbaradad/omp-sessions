// "Dependencies…": which sessions a session's queued tasks wait for, picked from the other sessions. The
// planner holds the tasks back until those sessions' tasks are done, and refuses a cycle (PARKED §1).
import * as path from "node:path";
import * as vscode from "vscode";
import type { OmpApi } from "./api";
import { plain } from "./plain";

async function setDependencies(api: OmpApi, arg?: unknown): Promise<void> {
	const { sessions } = api;
	const id = api.idFrom(arg) ?? (await api.pickSession("Set the dependencies of which session?"));
	const meta = id ? sessions.get(id) : undefined;
	if (!meta) return;
	const current = meta.queue?.after ?? [];
	type Item = vscode.QuickPickItem & { id: string };
	const items: Item[] = sessions
		.all()
		.filter(m => m.id !== meta.id)
		.sort((a, b) => Number(current.includes(b.id)) - Number(current.includes(a.id)) || b.updatedAt - a.updatedAt)
		.map(m => ({ id: m.id, label: m.title, description: `${path.basename(m.cwd)} · ${m.status}`, picked: current.includes(m.id) }));
	const picks = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		matchOnDescription: true,
		ignoreFocusOut: true,
		title: plain(`Dependencies of “${meta.title}”`),
		placeHolder: "Its queued tasks start once the ticked sessions' tasks are done (none ticked: no waiting)",
	});
	if (!picks) return;
	try {
		const edited = await sessions.setDependencies(meta.id, picks.map(p => p.id));
		if (!edited && picks.length) void vscode.window.showInformationMessage(plain(`“${meta.title}” has no queued task: dependencies hold back queued tasks, so add one to its queue first.`));
	} catch (err) {
		void vscode.window.showErrorMessage(plain(`Can't set the dependencies of “${meta.title}”: ${err instanceof Error ? err.message : String(err)}`));
	}
}

export function registerDependencies(api: OmpApi): void {
	api.context.subscriptions.push(vscode.commands.registerCommand("switchyard.setDependencies", (arg?: unknown) => setDependencies(api, arg)));
}
