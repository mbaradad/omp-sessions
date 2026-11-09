// Queue controls on session cards and in the detail panel: Run now, Retry, Schedule (presets or a typed
// time) and Unschedule, through POST /sessions/<id>/{run,retry,schedule} (plugin_api.py session_action).
import { errorMessage, type Session } from "./api";
import { Button } from "./components";
import { h, type ReactElement, useState } from "./react";
import { clock, cx } from "./util";

export type QueueAction = "run" | "retry" | "schedule";
/** Runs a queue action for a session; rejects with the backend's error. */
export type RunQueueAction = (id: string, action: QueueAction, body: Record<string, unknown>) => Promise<void>;

export const AT_PRESETS: ReadonlyArray<{ label: string; at: () => string }> = [
	{ label: "+30m", at: () => "+30m" },
	{ label: "+1h", at: () => "+1h" },
	{ label: "+3h", at: () => "+3h" },
	{ label: "Tonight 22:00", at: () => nextLocal(22, 0) },
	{ label: "Tomorrow 09:00", at: () => nextLocal(9, 1) },
];

/**
 * `hour`:00 of this browser's day `days` ahead (tonight: tomorrow if already past), as an ISO time with
 * its UTC offset (2026-01-31T09:00+01:00), so omp's machine starts it at the time shown here whatever
 * its own time zone.
 */
function nextLocal(hour: number, days: number): string {
	const d = new Date();
	d.setDate(d.getDate() + days);
	d.setHours(hour, 0, 0, 0);
	if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
	const pad = (n: number): string => String(n).padStart(2, "0");
	const off = -d.getTimezoneOffset();
	const zone = `${off >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00${zone}`;
}

/**
 * What a session's queue offers (the VS Code board's queueActions): Run now for pending tasks that
 * don't already run on their own; Retry for failed tasks or a finished queue (an interrupted one has
 * Continue in VS Code and the phone; Retry runs it too); Schedule for pending or failed work.
 */
export function queueAbilities(s: Session): { run: boolean; retry: boolean; schedule: boolean; unschedule: boolean } {
	const q = s.queue;
	const scheduled = typeof s.startAt === "number";
	if (q.total === 0) return { run: false, retry: false, schedule: false, unschedule: false };
	return {
		run: q.pending > 0 && (s.autoRun !== true || scheduled),
		retry: (q.failed ?? 0) > 0 || (q.interrupted ?? 0) > 0 || (q.pending === 0 && q.running === 0),
		schedule: q.pending > 0 || (q.failed ?? 0) > 0 || scheduled,
		unschedule: scheduled,
	};
}

/** Start-time picker: presets start at once; a typed time (+30m, 14:30, ISO) with Schedule. */
function ScheduleBox(p: { s: Session; busy: boolean; onSchedule: (at: string | null) => void }): ReactElement {
	const [at, setAt] = useState("");
	return h(
		"form",
		{
			className: "omps-at omps-queue-at",
			onClick: (e: Event) => e.stopPropagation(),
			onKeyDown: (e: KeyboardEvent) => e.stopPropagation(),
			onSubmit: (e: Event) => {
				e.preventDefault();
				if (at.trim()) p.onSchedule(at.trim());
			},
		},
		h("div", { className: "omps-at-presets" }, ...AT_PRESETS.map(x => h("button", { key: x.label, type: "button", className: "omps-chip omps-chip-btn", disabled: p.busy, onClick: () => p.onSchedule(x.at()) }, x.label))),
		h(
			"div",
			{ className: "omps-queue-at-row" },
			h("input", { className: "omps-input omps-mono", "aria-label": "Start time", value: at, placeholder: "+30m, 14:30 or 2026-01-31T09:00", onChange: (e: Event) => setAt((e.target as HTMLInputElement).value) }),
			h(Button, { type: "submit", small: true, kind: "primary", label: "Schedule", busy: p.busy, disabled: !at.trim() }),
			typeof p.s.startAt === "number" ? h(Button, { small: true, kind: "ghost", label: "Unschedule", title: `Cancel the start at ${clock(p.s.startAt)}; the tasks stay`, disabled: p.busy, onClick: () => p.onSchedule(null) }) : null,
		),
	);
}

/** Run now / Retry / Schedule buttons (only those the queue allows) and the start-time picker. */
export function QueueControls(p: { s: Session; onAction: RunQueueAction; compact?: boolean }): ReactElement | null {
	const [busy, setBusy] = useState<QueueAction | null>(null);
	const [picking, setPicking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const can = queueAbilities(p.s);
	if (!can.run && !can.retry && !can.schedule) return null;
	const run = async (action: QueueAction, body: Record<string, unknown> = {}): Promise<void> => {
		setBusy(action);
		setError(null);
		try {
			await p.onAction(p.s.id, action, body);
			if (action === "schedule") setPicking(false);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(null);
		}
	};
	const scheduled = typeof p.s.startAt === "number";
	return h(
		"div",
		{ className: cx("omps-queue-controls", p.compact && "is-compact"), onClick: (e: Event) => e.stopPropagation(), onKeyDown: (e: KeyboardEvent) => e.stopPropagation() },
		h(
			"div",
			{ className: "omps-queue-buttons" },
			can.run ? h(Button, { small: true, kind: "ghost", icon: "send", label: "Run now", title: "Start the queue now (a scheduled start is dropped)", busy: busy === "run", onClick: () => void run("run") }) : null,
			can.retry ? h(Button, { small: true, kind: "ghost", icon: "refresh", label: "Retry", title: "Failed or interrupted tasks (else the last finished one) back to pending, and the queue on; a scheduled start is kept", busy: busy === "retry", onClick: () => void run("retry") }) : null,
			can.schedule ? h(Button, { small: true, kind: picking ? "primary" : "ghost", icon: "clock", label: scheduled ? "Reschedule" : "Schedule", pressed: picking, onClick: () => setPicking(!picking) }) : null,
			can.unschedule && !picking ? h(Button, { small: true, kind: "ghost", icon: "x", label: "Unschedule", title: "Cancel the scheduled start; the tasks stay", busy: busy === "schedule", onClick: () => void run("schedule", { at: null }) }) : null,
		),
		picking ? h(ScheduleBox, { s: p.s, busy: busy === "schedule", onSchedule: at => void run("schedule", { at }) }) : null,
		error ? h("div", { className: "omps-queue-error", role: "alert" }, error) : null,
	);
}
