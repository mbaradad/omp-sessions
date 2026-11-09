// Models omp can use (GET /models, from `omp-sessions models --json`) and a searchable picker that
// marks the omp Sessions default. An empty value means "the default".
import { errorMessage, type Host, type Models } from "./api";
import { Button } from "./components";
import { h, type ReactElement, useEffect, useState } from "./react";
import { icon } from "./util";

let cache: { host: Host; models: Promise<Models> } | null = null;

/** The model list, fetched once per page (`fresh` refetches, e.g. after the default changed). */
export function loadModels(host: Host, fresh = false): Promise<Models> {
	if (fresh || !cache || cache.host !== host) {
		const models = host.request<Models>("/models");
		models.catch(() => {
			if (cache?.models === models) cache = null;
		});
		cache = { host, models };
	}
	return cache.models;
}

export function useModels(host: Host): { models: Models | null; error: string | null; loading: boolean; reload: () => void } {
	const [models, setModels] = useState<Models | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const load = (fresh: boolean): void => {
		setLoading(true);
		loadModels(host, fresh)
			.then(m => {
				setModels(m);
				setError(null);
			})
			.catch(err => setError(errorMessage(err)))
			.finally(() => setLoading(false));
	};
	useEffect(() => load(false), []);
	return { models, error, loading, reload: () => load(true) };
}

/** The model list failed to load: why, in line under a model field, and Retry. */
export function ModelsError(p: { error: string; loading: boolean; onRetry: () => void }): ReactElement {
	return h(
		"div",
		{ className: "omps-field-hint is-error omps-models-error", role: "alert" },
		icon("alert", 12),
		h("span", null, `Models unavailable: ${p.error}`),
		h(Button, { small: true, kind: "ghost", icon: "refresh", label: "Retry", busy: p.loading, onClick: p.onRetry }),
	);
}

/** What an empty model choice means. */
export function defaultLabel(m: Models | null): string {
	if (m?.default) return `Default (${m.default})`;
	return m?.ompDefault ? `omp's default (${m.ompDefault})` : "omp's default";
}

/** A text box with the models as suggestions (type to search); "" = the default. */
export function ModelPicker(p: { id: string; models: Models | null; value: string; onChange: (value: string) => void; disabled?: boolean; label?: string; placeholder?: string }): ReactElement {
	const list = `${p.id}-list`;
	// Only a running session's omp knows the real list: with none running the CLI says so instead of listing models.
	const note = p.models && p.models.models.length === 0 ? p.models.note : undefined;
	return h(
		"span",
		{ className: "omps-model-picker" },
		note ? h("span", { className: "omps-field-hint", role: "note" }, note) : null,
		h("input", {
			id: p.id,
			className: "omps-input omps-mono",
			list,
			value: p.value,
			placeholder: p.placeholder ?? defaultLabel(p.models),
			disabled: p.disabled,
			"aria-label": p.label ?? "Model",
			autoComplete: "off",
			spellCheck: false,
			onChange: (e: Event) => p.onChange((e.target as HTMLInputElement).value),
		}),
		h(
			"datalist",
			{ id: list },
			...(p.models?.models ?? []).map(m => h("option", { key: m.selector, value: m.selector }, `${m.name ?? m.id}${m.selector === p.models?.default ? " · default" : ""}`)),
		),
	);
}
