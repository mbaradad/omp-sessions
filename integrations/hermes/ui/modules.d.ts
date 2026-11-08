// The modules Hermes Desktop provides to plugin.js (never bundled), typed for what desktop.ts uses.
// Reference: apps/desktop/src/sdk/index.ts in hermes-agent; docs: developer-guide/desktop-plugin-sdk.md.

declare module "react" {
	export function createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): { readonly type: unknown };
	export const Fragment: unknown;
	export function useState<T>(initial: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void];
	export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
	export function useRef<T>(initial: T): { current: T };
	export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
}

declare module "@hermes/plugin-sdk" {
	export interface PluginRestOptions {
		method?: string;
		body?: unknown;
		timeoutMs?: number;
	}
	export interface Contribution {
		id: string;
		area: string;
		order?: number;
		data?: unknown;
		render?: () => unknown;
	}
	export interface PluginContext {
		rest<T>(path: string, opts?: PluginRestOptions): Promise<T>;
		registerMany(cs: Contribution[]): () => void;
		/** Opens http(s)/mailto links with the OS; false when refused or unavailable. */
		os: { openExternal(url: string): Promise<boolean> };
	}
	export const ROUTES_AREA: string;
	export const SIDEBAR_NAV_AREA: string;
	export const PALETTE_AREA: string;
	export const host: { navigate(path: string): void };
}

declare module "*.css" {
	const text: string;
	export default text;
}

/** The plugin version this page was built from (build.mjs defines it). */
declare const PAGE_VERSION: string;
