// Models omp can use (GET /models, from `omp-sessions models --json`) and a searchable picker that
// marks the omp Sessions default. An empty value means "the default".
import { errorMessage, type Host, type Models } from "./api";
import { h, type ReactElement, useEffect, useState } from "./react";

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

export function useModels(host: Host): { models: Models | null; error: string | null; reload: () => void } {
	const [models, setModels] = useState<Models | null>(null);
	const [error, setError] = useState<string | null>(null);
	const load = (fresh: boolean): void => {
		loadModels(host, fresh)
			.then(m => {
				setModels(m);
				setError(null);
			})
			.catch(err => setError(errorMessage(err)));
	};
	useEffect(() => load(false), []);
	return { models, error, reload: () => load(true) };
}

/** What an empty model choice means. */
export function defaultLabel(m: Models | null): string {
	if (m?.default) return `Default (${m.default})`;
	return m?.ompDefault ? `omp's default (${m.ompDefault})` : "omp's default";
}

/** A text box with the models as suggestions (type to search); "" = the default. */
export function ModelPicker(p: { id: string; models: Models | null; value: string; onChange: (value: string) => void; disabled?: boolean; label?: string; placeholder?: string }): ReactElement {
	const list = `${p.id}-list`;
	return h(
		"span",
		{ className: "omps-model-picker" },
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
