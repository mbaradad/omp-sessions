// New session: what to do, where (a project, a folder or a kanban board), mode, group, tags, and
// when (now, queued for a free slot, or at a time).
import { errorMessage, type Host, MODE_INFO, MODES, type Mode, type Places, type StartBody, type Started } from "./api";
import { Button, ErrorBox, Field, Segmented, useDismiss } from "./components";
import { h, type ReactElement, useEffect, useRef, useState } from "./react";
import { icon } from "./util";

type Where = StartBody["where"]["kind"];
type When = StartBody["when"];

const AT_PRESETS: ReadonlyArray<{ label: string; at: () => string }> = [
	{ label: "+30m", at: () => "+30m" },
	{ label: "+1h", at: () => "+1h" },
	{ label: "+3h", at: () => "+3h" },
	{ label: "Tonight 22:00", at: () => "22:00" },
	{ label: "Tomorrow 09:00", at: () => localIso(9) },
];

/** Tomorrow at `hour`:00 local time, as omp-vs --at takes it (2026-01-31T09:00). */
function localIso(hour: number): string {
	const d = new Date();
	d.setDate(d.getDate() + 1);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
}

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
		...(places && Object.keys(places.configured).length ? [h("optgroup", { key: "c", label: "omp-sessions projects" }, ...Object.entries(places.configured).map(([name, path]) => h("option", { key: name, value: `project:${name}` }, `${name} — ${path}`)))] : []),
	];

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
							{ value: "queue", label: "Queue", title: "Starts when omp's concurrency limit has a free slot" },
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
						: h("div", { className: "omps-field-hint" }, when === "queue" ? "Waits for a free slot under omp's concurrency limit." : "Starts right away."),
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
