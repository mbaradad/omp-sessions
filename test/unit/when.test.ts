// planner/when.ts parseStartTime: the one start-time parser the CLI (`queue at`, `new --at`), the VS Code board
// and Tasks view and the Hermes plugin (through the CLI) share.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { UsageError, parseWhen } from "../../src/cli/args";
import { parseStartTime } from "../../src/planner/when";

const now = new Date(2025, 0, 15, 15, 0, 0).getTime();
const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe("parseStartTime", () => {
	test("relative: +30m, 30m, 2H, in 2h, 1h30m, in 90 minutes", () => {
		assert.equal(parseStartTime("+30m", now), now + 30 * 60_000);
		assert.equal(parseStartTime("30m", now), now + 30 * 60_000);
		assert.equal(parseStartTime("2H", now), now + 2 * 3_600_000);
		assert.equal(parseStartTime("in 2h", now), now + 2 * 3_600_000);
		assert.equal(parseStartTime("1h30m", now), now + 90 * 60_000);
		assert.equal(parseStartTime("in 90 minutes", now), now + 90 * 60_000);
		assert.equal(parseStartTime("+1d", now), now + 86_400_000);
	});

	test("a time of day is the next occurrence; today and tomorrow name the day", () => {
		assert.equal(parseStartTime("16:30", now), local(2025, 1, 15, 16, 30));
		assert.equal(parseStartTime("09:00", now), local(2025, 1, 16, 9), "already past today: tomorrow");
		assert.equal(parseStartTime("9pm", now), local(2025, 1, 15, 21));
		assert.equal(parseStartTime("9:30 am", now), local(2025, 1, 16, 9, 30));
		assert.equal(parseStartTime("at 18:00", now), local(2025, 1, 15, 18));
		assert.equal(parseStartTime("today 18:00", now), local(2025, 1, 15, 18));
		assert.equal(parseStartTime("tomorrow 9:00", now), local(2025, 1, 16, 9));
		assert.equal(parseStartTime("12am", now), local(2025, 1, 16, 0));
	});

	test("ISO dates and times, with a space or T, with or without a zone", () => {
		assert.equal(parseStartTime("2025-02-01T08:00:00Z", now), Date.UTC(2025, 1, 1, 8));
		assert.equal(parseStartTime("2025-02-01 08:00", now), local(2025, 2, 1, 8));
		assert.equal(parseStartTime("2025-02-01T08:00", now), local(2025, 2, 1, 8));
	});

	test("unreadable, ambiguous or past input throws an Error that says why", () => {
		for (const bad of ["", "soonish", "3", "22", "in 5", "25:99", "12:60", "13pm", "0am", "0m"]) assert.throws(() => parseStartTime(bad, now), Error, bad);
		assert.throws(() => parseStartTime("soonish", now), /can't read "soonish" as a time: use \+30m/);
		assert.throws(() => parseStartTime("25:99", now), /not a time of day/);
		assert.throws(() => parseStartTime("2024-01-01T08:00:00Z", now), /in the past/);
		assert.throws(() => parseStartTime("today 09:00", now), /in the past/);
	});
});

describe("parseWhen (the CLI) is the same parser with usage errors", () => {
	test("same results, UsageError on failure", () => {
		assert.equal(parseWhen("tomorrow 9:00", now), parseStartTime("tomorrow 9:00", now));
		assert.equal(parseWhen("+2h", now), now + 2 * 3_600_000);
		assert.throws(() => parseWhen("soonish", now), UsageError);
		assert.throws(() => parseWhen("2024-01-01T08:00:00Z", now), UsageError);
	});
});
