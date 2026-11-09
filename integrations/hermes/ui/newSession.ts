// New session: what to do, where (a project, a folder or a kanban board), mode, model, group, tags,
// and when (now, queued for a free slot, or at a time).
import { errorMessage, type Host, MODE_INFO, MODES, type Mode, type Places, type StartBody, type Started } from "./api";
import { Button, ErrorBox, Field, Segmented, useDismiss } from "./components";
import { ModelPicker, ModelsError, useModels } from "./models";
import { h, type ReactElement, useEffect, useRef, useState } from "./react";
import { icon } from "./util";
import { AT_PRESETS } from "./queue";
import { openInVscode } from "./vscode";

type Where = StartBody["where"]["kind"];
type When = StartBody["when"];

export function NewSessionDialog(p: { host: Host; groups: string[]; onClose: () => void; onStarted: (s: Started) => void }): ReactElement {
	const [places, setPlaces] = useState<Places | null>(null);
	const [placesError, setPlacesError] = useState<string | null>(null);
	const [prompt, setPrompt] = useState("");
	const [title, setTitle] = useState("");
	const [where, setWhere] = useState<Where>("project");
	const [project, setProject] = useState("");
	const [folder, setFolder] = useState("");
	const [board, setBoard] = useState("");
	const [mode, setMode] = useState<Mode | "default">("default");
	const [group, setGroup] = useState("");
	const [tags, setTags] = useState("");
	const [when, setWhen] = useState<When>("now");
	const [at, setAt] = useState("+1h");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [model, setModel] = useState("");
	const models = useModels(p.host);
	const [opening, setOpening] = useState(false);
	const [folderNote, setFolderNote] = useState<string | null>(null);
	const root = useRef<HTMLElement | null>(null);
	useDismiss(p.onClose, root);

	useEffect(() => {
		p.host
			.request<Places>("/projects")
			.then(pl => {
				setPlaces(pl);
				const first = pl.folders[0]?.path;
				if (first) setProject(`folder:${first}`);
				else if (pl.hermesProjects[0]) setProject(`project:${pl.hermesProjects[0].slug}`);
				else setWhere("folder");
				const b = pl.boards.find(x => x.folder);
				if (b) setBoard(b.slug);
			})
			.catch(err => setPlacesError(errorMessage(err)));
	}, []);

	const target = (): StartBody["where"] | null => {
		if (where === "board") return board ? { kind: "board", value: board } : null;
		if (where === "folder") return folder.trim() ? { kind: "folder", value: folder.trim() } : null;
		const sep = project.indexOf(":");
		if (sep < 0) return null;
		return project.startsWith("folder:") ? { kind: "folder", value: project.slice(sep + 1) } : { kind: "project", value: project.slice(sep + 1) };
	};

	const submit = async (): Promise<void> => {
		const place = target();
		if (!prompt.trim()) return setError("Write what omp should do.");
		if (!place) return setError("Pick where it runs.");
		setBusy(true);
		setError(null);
		const body: StartBody = {
			prompt,
			where: place,
			when,
			...(title.trim() ? { title: title.trim() } : {}),
			...(mode !== "default" ? { mode } : {}),
			...(group.trim() ? { group: group.trim() } : {}),
			...(tags.trim() ? { tags: tags.split(",").map(t => t.trim()).filter(Boolean) } : {}),
			...(when === "at" ? { at: at.trim() } : {}),
			...(model.trim() ? { model: model.trim() } : {}),
		};
		try {
			p.onStarted(await p.host.request<Started>("/sessions", { method: "POST", body }));
		} catch (err) {
			setError(errorMessage(err));
			setBusy(false);
		}
	};

	const boards = places?.boards ?? [];
	const projectOptions = [
		...(places?.folders.length ? [h("optgroup", { key: "f", label: "Recent folders" }, ...places.folders.map(f => h("option", { key: f.path, value: `folder:${f.path}` }, `${f.name} — ${f.label}`)))] : []),
		...(places?.hermesProjects.length ? [h("optgroup", { key: "h", label: "Hermes projects" }, ...places.hermesProjects.map(x => h("option", { key: x.id, value: `project:${x.slug}` }, x.path ? `${x.name} — ${x.path}` : x.name)))] : []),
		...(places && Object.keys(places.configured).length ? [h("optgroup", { key: "c", label: "switchyard projects" }, ...Object.entries(places.configured).map(([name, path]) => h("option", { key: name, value: `project:${name}` }, `${name} — ${path}`)))] : []),
	];
	// The folder the current choice runs in, when the page knows it (for Open in VS Code).
	const chosenFolder = ((): string | null => {
		if (where === "folder") return folder.trim() || null;
		if (where === "board") return boards.find(b => b.slug === board)?.folder ?? null;
		const name = project.slice(project.indexOf(":") + 1);
		if (project.startsWith("folder:")) return name;
		return places?.configured[name] ?? places?.hermesProjects.find(x => x.slug === name)?.path ?? null;
	})();
	const openFolder = async (): Promise<void> => {
		if (!chosenFolder) return;
		setOpening(true);
		setFolderNote(null);
		try {
			setFolderNote(await openInVscode(p.host, "/folders/vscode", { path: chosenFolder }));
		} catch (err) {
			setFolderNote(errorMessage(err));
		} finally {
			setOpening(false);
		}
	};

	return h(
		"div",
		{ className: "omps-backdrop", onMouseDown: (e: MouseEvent) => e.target === e.currentTarget && p.onClose() },
		h(
			"form",
			{
				className: "omps-dialog",
				ref: root,
				role: "dialog",
				"aria-modal": true,
				"aria-labelledby": "omps-new-title",
				onSubmit: (e: Event) => {
					e.preventDefault();
					void submit();
				},
			},
			h("header", { className: "omps-dialog-head" }, h("h2", { id: "omps-new-title" }, icon("plus", 16), "New omp session"), h(Button, { kind: "ghost", icon: "x", title: "Close (Esc)", onClick: p.onClose })),
			h(
				"div",
				{ className: "omps-dialog-body" },
				h(Field, {
					label: "What should omp do?",
					htmlFor: "omps-prompt",
					children: h("textarea", {
						id: "omps-prompt",
						"data-autofocus": true,
						className: "omps-input omps-prompt",
						rows: 5,
						value: prompt,
						placeholder: "Add rate limiting to the public API and cover it with tests",
						onChange: (e: Event) => setPrompt((e.target as HTMLTextAreaElement).value),
						onKeyDown: (e: KeyboardEvent) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								void submit();
							}
						},
					}),
				}),
				h(Field, { label: "Title", hint: "Optional; defaults to the first line of the prompt.", htmlFor: "omps-title", children: h("input", { id: "omps-title", className: "omps-input", value: title, onChange: (e: Event) => setTitle((e.target as HTMLInputElement).value) }) }),
				h(
					"div",
					{ className: "omps-field" },
					h("span", { className: "omps-field-label" }, "Where"),
					h(Segmented<Where>, {
						label: "Where it runs",
						value: where,
						onChange: setWhere,
						options: [
							{ value: "project", label: "Project" },
							{ value: "folder", label: "Folder" },
							{ value: "board", label: "Kanban board" },
						],
					}),
					placesError ? h("div", { className: "omps-field-hint is-error" }, placesError) : null,
					where === "project"
						? projectOptions.length
							? h("select", { className: "omps-input", "aria-label": "Project", value: project, onChange: (e: Event) => setProject((e.target as HTMLSelectElement).value) }, ...projectOptions)
							: h("div", { className: "omps-field-hint" }, places ? "No projects yet: pick a folder." : "Loading projects…")
						: where === "folder"
							? h(
									"div",
									null,
									h("input", { className: "omps-input omps-mono", list: "omps-folders", "aria-label": "Folder", placeholder: "/home/me/src/project", value: folder, onChange: (e: Event) => setFolder((e.target as HTMLInputElement).value) }),
									h("datalist", { id: "omps-folders" }, ...(places?.folders ?? []).map(f => h("option", { key: f.path, value: f.path }))),
								)
							: boards.length
								? h(
										"select",
										{ className: "omps-input", "aria-label": "Kanban board", value: board, onChange: (e: Event) => setBoard((e.target as HTMLSelectElement).value) },
										...boards.map(b => h("option", { key: b.slug, value: b.slug, disabled: !b.folder }, `${b.name ?? b.slug}${b.folder ? ` — ${b.folder}` : " (no folder set)"}`)),
									)
								: h("div", { className: "omps-field-hint" }, "No kanban boards."),
					where === "board" ? h("div", { className: "omps-field-hint" }, "Runs in the board's folder and omp group (set them in Boards).") : null,
					chosenFolder
						? h(
								"div",
								{ className: "omps-field-hint" },
								h(Button, { small: true, kind: "ghost", icon: "external", label: "Open in VS Code", title: `Open ${chosenFolder} in VS Code`, busy: opening, onClick: () => void openFolder() }),
								folderNote ? ` ${folderNote}` : null,
							)
						: null,
				),
				h(
					"div",
					{ className: "omps-row2" },
					h(Field, {
						label: "Permission mode",
						children: h(Segmented<Mode | "default">, {
							label: "Permission mode",
							small: true,
							value: mode,
							onChange: setMode,
							options: [{ value: "default", label: "Default", title: "omp's configured mode" }, ...MODES.map(m => ({ value: m, label: MODE_INFO[m].label, title: MODE_INFO[m].detail }))],
						}),
					}),
					h(Field, {
						label: "Model",
						htmlFor: "omps-model",
						children: h(
							"div",
							null,
							h(ModelPicker, { id: "omps-model", models: models.models, value: model, onChange: setModel }),
							models.error ? h(ModelsError, { error: models.error, loading: models.loading, onRetry: models.reload }) : null,
						),
					}),
				),
				h(
					"div",
					{ className: "omps-row2" },
					h(Field, {
						label: "Group",
						htmlFor: "omps-group",
						children: h(
							"div",
							null,
							h("input", { id: "omps-group", className: "omps-input", list: "omps-groups", value: group, placeholder: where === "board" ? "The board's group" : "None", onChange: (e: Event) => setGroup((e.target as HTMLInputElement).value) }),
							h("datalist", { id: "omps-groups" }, ...p.groups.map(g => h("option", { key: g, value: g }))),
						),
					}),
					h(Field, { label: "Tags", htmlFor: "omps-tags", hint: "Comma-separated", children: h("input", { id: "omps-tags", className: "omps-input", value: tags, placeholder: "api, backend", onChange: (e: Event) => setTags((e.target as HTMLInputElement).value) }) }),
				),
				h(
					"div",
					{ className: "omps-field" },
					h("span", { className: "omps-field-label" }, "When"),
					h(Segmented<When>, {
						label: "When it starts",
						value: when,
						onChange: setWhen,
						options: [
							{ value: "now", label: "Start now" },
							{ value: "queue", label: "Queue", title: "Starts when the Switchyard scheduler's concurrency limit has a free slot" },
							{ value: "at", label: "Schedule" },
						],
					}),
					when === "at"
						? h(
								"div",
								{ className: "omps-at" },
								h("input", { className: "omps-input omps-mono", "aria-label": "Start time", value: at, placeholder: "+30m, 14:30 or 2026-01-31T09:00", onChange: (e: Event) => setAt((e.target as HTMLInputElement).value) }),
								h("div", { className: "omps-at-presets" }, ...AT_PRESETS.map(x => h("button", { key: x.label, type: "button", className: "omps-chip omps-chip-btn", onClick: () => setAt(x.at()) }, x.label))),
							)
						: h("div", { className: "omps-field-hint" }, when === "queue" ? "Waits for a free slot under the Switchyard scheduler's concurrency limit." : "Starts right away."),
				),
				error ? h(ErrorBox, { message: error }) : null,
			),
			h(
				"footer",
				{ className: "omps-dialog-foot" },
				h("span", { className: "omps-hint" }, "Ctrl+Enter to start"),
				h("span", { className: "omps-grow" }),
				h(Button, { kind: "ghost", label: "Cancel", onClick: p.onClose }),
				h(Button, { type: "submit", kind: "brand", icon: when === "now" ? "sparkle" : "clock", label: when === "now" ? "Start session" : when === "queue" ? "Queue session" : "Schedule session", busy }),
			),
		),
	);
}
