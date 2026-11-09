import { mock } from "node:test";

/**
 * Virtual time for tests of code that waits on timers (the watcher's debounce and re-reads, polling loops):
 * `setTimeout` and `Date` are mocked, nothing sleeps, and the outcome cannot depend on how loaded the machine is.
 * `advance(ms)` moves time forward in small steps and lets the promises each fired timer starts settle in between, so a
 * timer that schedules the next one fires in order. The code under test must wait on nothing but these timers and
 * promises that resolve without real I/O (fakes, an in-memory `Response`). Call `stop()` in `finally`.
 *
 * Never `await` a promise that waits on a mocked timer directly: if the clock is not moved far enough nothing will
 * ever fire it, the event loop empties and every later test in the file is cancelled. Use `resolve(promise)`.
 */
export function virtualClock(start = 1_000_000) {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
	/** Lets every promise chain that can make progress without a timer run to its end (setImmediate is not mocked). */
	const flush = async (): Promise<void> => {
		for (let round = 0; round < 3; round++) {
			for (let i = 0; i < 50; i++) await Promise.resolve();
			await new Promise<void>(resolve => setImmediate(resolve));
		}
	};
	return {
		flush,
		async advance(ms: number): Promise<void> {
			for (let moved = 0; moved < ms; moved += 5) {
				mock.timers.tick(Math.min(5, ms - moved));
				await flush();
			}
			await flush();
		},
		/** Moves time on until `promise` settles, and returns its result; throws (naming the budget) if it never does. */
		async resolve<T>(promise: Promise<T>, budgetMs = 10_000): Promise<T> {
			let settled = false;
			promise.then(
				() => (settled = true),
				() => (settled = true),
			);
			await flush();
			for (let spent = 0; !settled && spent < budgetMs; spent += 5) {
				mock.timers.tick(5);
				await flush();
			}
			if (!settled) throw new Error(`the promise was still pending after ${budgetMs} ms of virtual time`);
			return promise;
		},
		stop: () => mock.timers.reset(),
	};
}
