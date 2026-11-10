// Switchyard site: copy buttons, permission-mode demo, scroll reveal, terminal typing.
// Everything degrades to static content without JS or with reduced motion.
(() => {
	"use strict";

	const root = document.documentElement;
	root.classList.add("js");
	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

	// Copy-to-clipboard for command snippets.
	for (const btn of document.querySelectorAll("[data-copy]")) {
		btn.addEventListener("click", async () => {
			const text = btn.closest("[data-copy-root]")?.querySelector("[data-copy-text]")?.textContent ?? "";
			try {
				await navigator.clipboard.writeText(text.trim());
			} catch {
				return;
			}
			const use = btn.querySelector("use");
			const label = btn.getAttribute("aria-label");
			btn.classList.add("is-copied");
			use?.setAttribute("href", "#i-check");
			btn.setAttribute("aria-label", "Copied");
			setTimeout(() => {
				btn.classList.remove("is-copied");
				use?.setAttribute("href", "#i-copy");
				if (label) btn.setAttribute("aria-label", label);
			}, 1600);
		});
	}

	// Permission modes: an interactive example of the composer chip.
	const MODES = {
		ask: "The agent asks before every file edit and command. Read-only tools never ask.",
		edits: "File edits go through; commands and other tools ask.",
		plan: "Read-only: the agent explores and proposes a plan, and file edits are refused. omp only.",
		auto: "Every tool call is approved. The agent just works.",
	};
	const desc = document.querySelector("[data-mode-desc]");
	const modeButtons = [...document.querySelectorAll(".seg__b[data-mode]")];
	for (const btn of modeButtons) {
		btn.addEventListener("click", () => {
			for (const b of modeButtons) b.setAttribute("aria-pressed", String(b === btn));
			if (desc) desc.textContent = MODES[btn.dataset.mode] ?? "";
		});
	}

	if (reduceMotion || !("IntersectionObserver" in window)) return;

	// Reveal sections as they scroll into view.
	const revealer = new IntersectionObserver(
		entries => {
			for (const e of entries) {
				if (!e.isIntersecting) continue;
				e.target.classList.add("is-in");
				revealer.unobserve(e.target);
			}
		},
		{ rootMargin: "0px 0px -8% 0px" },
	);
	for (const el of document.querySelectorAll(".reveal")) revealer.observe(el);

	// Terminal: type commands, print output, once, when it comes into view.
	const term = document.querySelector("[data-term]");
	if (!term) return;
	const lines = [...term.querySelectorAll(".tline")];
	term.classList.add("term--armed");
	const play = () => {
		let t = 250;
		for (const line of lines) {
			const cmd = line.querySelector(".tc");
			if (cmd) {
				const n = Math.max(1, cmd.textContent.length);
				const dur = Math.min(1600, n * 32);
				line.style.setProperty("--n", String(n));
				line.style.setProperty("--dur", `${dur}ms`);
				setTimeout(() => line.classList.add("is-shown", "is-typing"), t);
				t += dur + 380;
			} else {
				setTimeout(() => line.classList.add("is-shown"), t);
				t += 70;
			}
		}
	};
	const watcher = new IntersectionObserver(
		entries => {
			if (!entries.some(e => e.isIntersecting)) return;
			watcher.disconnect();
			play();
		},
		{ threshold: 0.35 },
	);
	watcher.observe(term);
})();
