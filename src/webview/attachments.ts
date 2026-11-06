// Composer attachments: images go to omp as vision input; any other file (PDF, docs, …) is
// written next to the session on the remote and referenced in the prompt for omp's read tool.
import type { FileAttachment, ImageAttachment } from "../shared/webview";
import { h, icon } from "./dom";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2048;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const VISION_TYPES: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true };

export interface Attachments {
	images: ImageAttachment[];
	files: FileAttachment[];
}

function blobToBase64(blob: Blob): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const reader = new FileReader();
	reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
	reader.onerror = () => reject(reader.error);
	reader.readAsDataURL(blob);
	return promise;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
	const { promise, resolve } = Promise.withResolvers<Blob | null>();
	canvas.toBlob(resolve, type, quality);
	return promise;
}

/** Downscales very large images so they stay within model limits; small ones pass untouched. */
async function prepareImage(file: Blob): Promise<{ data: string; mimeType: string }> {
	const type = VISION_TYPES[file.type] ? file.type : "image/png";
	try {
		const bitmap = await createImageBitmap(file);
		const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
		if (scale < 1 || file.size > MAX_IMAGE_BYTES || !VISION_TYPES[file.type]) {
			const canvas = document.createElement("canvas");
			canvas.width = Math.round(bitmap.width * scale);
			canvas.height = Math.round(bitmap.height * scale);
			canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			let out = await canvasBlob(canvas, "image/png");
			if (!out || out.size > MAX_IMAGE_BYTES) out = await canvasBlob(canvas, "image/jpeg", 0.9);
			if (out) return { data: await blobToBase64(out), mimeType: out.type };
		}
	} catch {
		/* not decodable here; send as-is */
	}
	return { data: await blobToBase64(file), mimeType: type };
}

export class AttachmentTray {
	readonly el = h("div", { class: "attachments hidden" });
	private items: Attachments = { images: [], files: [] };
	private onChange: () => void;
	private notify: (msg: string) => void;

	constructor(onChange: () => void, notify: (msg: string) => void) {
		this.onChange = onChange;
		this.notify = notify;
	}

	get count(): number {
		return this.items.images.length + this.items.files.length;
	}

	take(): Attachments {
		const out = this.items;
		this.items = { images: [], files: [] };
		this.render();
		return out;
	}

	add(att: Partial<Attachments>): void {
		this.items.images.push(...(att.images ?? []));
		this.items.files.push(...(att.files ?? []));
		this.render();
	}

	/** Accepts browser File objects from paste, drop or an <input type=file>. */
	async addFiles(list: Iterable<File>): Promise<void> {
		for (const file of list) {
			if (file.size > MAX_FILE_BYTES) {
				this.notify(`${file.name || "file"} is larger than 50 MB; attach it by path instead (📎 → pick from the remote disk).`);
				continue;
			}
			if (file.type.startsWith("image/") && file.type !== "image/svg+xml") {
				const img = await prepareImage(file);
				this.items.images.push({ ...img, name: file.name || `pasted-${this.items.images.length + 1}.png` });
			} else {
				this.items.files.push({ name: file.name || "pasted-file", mimeType: file.type || undefined, size: file.size, data: await blobToBase64(file) });
			}
			this.render();
		}
	}

	private render(): void {
		this.el.classList.toggle("hidden", this.count === 0);
		const chips: HTMLElement[] = [];
		this.items.images.forEach((img, i) => {
			chips.push(
				h(
					"div",
					{ class: "att att-image", title: img.name ?? "image" },
					h("img", { src: `data:${img.mimeType};base64,${img.data}`, alt: img.name ?? "image" }),
					this.removeBtn(() => this.items.images.splice(i, 1)),
				),
			);
		});
		this.items.files.forEach((f, i) => {
			const ext = (f.name.split(".").pop() ?? "").slice(0, 4).toUpperCase();
			chips.push(
				h(
					"div",
					{ class: "att att-file", title: f.path ?? f.name },
					h("span", { class: "att-ext" }, ext || "FILE"),
					h("span", { class: "att-name" }, f.name),
					f.size ? h("span", { class: "att-size" }, f.size > 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`) : "",
					this.removeBtn(() => this.items.files.splice(i, 1)),
				),
			);
		});
		this.el.replaceChildren(...chips);
		this.onChange();
	}

	private removeBtn(remove: () => void): HTMLElement {
		const btn = h("button", { class: "att-x", title: "Remove" }, icon("x"));
		btn.addEventListener("click", e => {
			e.preventDefault();
			remove();
			this.render();
		});
		return btn;
	}
}
