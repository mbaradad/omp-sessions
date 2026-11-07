// Small controls drawn with the page's own CSS (style.css), the same in the dashboard and Desktop.
import { type Child, h, type ReactElement, useEffect, useRef } from "./react";
import { cx, type IconName, icon } from "./util";

export interface ButtonProps {
	kind?: "primary" | "ghost" | "danger" | "default" | "brand";
	small?: boolean;
	icon?: IconName;
	label?: string;
	title?: string;
	disabled?: boolean;
	busy?: boolean;
	pressed?: boolean;
	onClick?: () => void;
	type?: "button" | "submit";
	className?: string;
}

export function Button(p: ButtonProps): ReactElement {
	return h(
		"button",
		{
			type: p.type ?? "button",
			className: cx("omps-btn", `omps-btn-${p.kind ?? "default"}`, p.small && "omps-btn-sm", !p.label && "omps-btn-icon", p.className),
			title: p.title,
			"aria-label": p.label ? undefined : p.title,
			"aria-pressed": p.pressed,
			"aria-busy": p.busy || undefined,
			disabled: p.disabled || p.busy,
			onClick: p.onClick,
		},
		p.busy ? h("span", { className: "omps-spinner", "aria-hidden": true }) : p.icon ? icon(p.icon, p.small ? 13 : 14) : null,
		p.label ? h("span", null, p.label) : null,
	);
}

export interface SegmentedOption<T extends string> {
	value: T;
	label: string;
	title?: string;
}

/** A radio group drawn as segments; arrow keys move the choice. */
export function Segmented<T extends string>(p: { label: string; options: readonly SegmentedOption<T>[]; value: T | null | undefined; onChange: (v: T) => void; small?: boolean; disabled?: boolean }): ReactElement {
	const index = p.options.findIndex(o => o.value === p.value);
	const move = (e: KeyboardEvent): void => {
		const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
		if (!step) return;
		e.preventDefault();
		const next = p.options[(Math.max(index, 0) + step + p.options.length) % p.options.length];
		p.onChange(next.value);
		const group = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
		requestAnimationFrame(() => group?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus());
	};
	return h(
		"div",
		{ className: cx("omps-seg", p.small && "omps-seg-sm"), role: "radiogroup", "aria-label": p.label, onKeyDown: move },
		...p.options.map((o, i) =>
			h(
				"button",
				{
					key: o.value,
					type: "button",
					role: "radio",
					"data-value": o.value,
					"aria-checked": o.value === p.value,
					tabIndex: i === index || (index < 0 && i === 0) ? 0 : -1,
					title: o.title,
					disabled: p.disabled,
					className: cx("omps-seg-item", o.value === p.value && "is-on"),
					onClick: () => p.onChange(o.value),
				},
				o.label,
			),
		),
	);
}

export function Switch(p: { checked: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean; busy?: boolean }): ReactElement {
	return h(
		"button",
		{
			type: "button",
			role: "switch",
			"aria-checked": p.checked,
			"aria-label": p.label,
			title: p.label,
			disabled: p.disabled || p.busy,
			className: cx("omps-switch", p.checked && "is-on", p.busy && "is-busy"),
			onClick: () => p.onChange(!p.checked),
		},
		h("span", { className: "omps-switch-knob" }),
	);
}

export function Field(p: { label: string; hint?: string; children: Child; htmlFor?: string }): ReactElement {
	return h(
		"div",
		{ className: "omps-field" },
		h("label", { className: "omps-field-label", htmlFor: p.htmlFor }, p.label),
		p.children,
		p.hint ? h("div", { className: "omps-field-hint" }, p.hint) : null,
	);
}

export function Empty(p: { icon: IconName; title: string; body?: Child; action?: Child; compact?: boolean }): ReactElement {
	return h(
		"div",
		{ className: cx("omps-empty", p.compact && "omps-empty-compact") },
		h("div", { className: "omps-empty-icon" }, icon(p.icon, p.compact ? 16 : 22)),
		h("div", { className: "omps-empty-title" }, p.title),
		p.body ? h("div", { className: "omps-empty-body" }, p.body) : null,
		p.action ?? null,
	);
}

export function ErrorBox(p: { message: string; onRetry?: () => void }): ReactElement {
	return h(
		"div",
		{ className: "omps-error", role: "alert" },
		icon("alert", 15),
		h("div", { className: "omps-error-text" }, p.message),
		p.onRetry ? h(Button, { small: true, label: "Retry", icon: "refresh", onClick: p.onRetry }) : null,
	);
}

/** Warnings shown in line (amber), one per row: the kanban dispatcher notes. */
export function Notes(p: { notes: string[]; className?: string }): ReactElement {
	return h("ul", { className: cx("omps-notes", p.className) }, ...p.notes.map((n, i) => h("li", { key: i }, icon("alert", 12), h("span", null, n))));
}

// Escape closes the newest open layer only (the New session dialog over the detail panel).
const layers: Array<{ current: () => void }> = [];
function onEscape(e: KeyboardEvent): void {
	const top = layers[layers.length - 1];
	if (e.key !== "Escape" || e.defaultPrevented || !top) return;
	e.preventDefault();
	top.current();
}

/** Closes the layer on Escape while mounted; focuses its `[data-autofocus]` element (or first
 *  control) on mount and gives focus back to what had it on unmount. */
export function useDismiss(onClose: () => void, root: { current: HTMLElement | null }): void {
	const close = useRef(onClose);
	close.current = onClose;
	useEffect(() => {
		const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		root.current?.querySelector<HTMLElement>("[data-autofocus], textarea, input, button:not([disabled])")?.focus();
		if (layers.length === 0) window.addEventListener("keydown", onEscape);
		layers.push(close);
		return () => {
			layers.splice(layers.indexOf(close), 1);
			if (layers.length === 0) window.removeEventListener("keydown", onEscape);
			if (before && document.contains(before)) before.focus();
		};
	}, []);
}
