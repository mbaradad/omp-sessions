// The React the host page runs (the dashboard's window.__HERMES_PLUGIN_SDK__.React, Desktop's
// `react` module): never bundled. The UI calls it through these wrappers, typed for what it uses.

/** An element React created (opaque here). */
export interface ReactElement {
	readonly type: unknown;
}
export type Child = ReactElement | string | number | boolean | null | undefined | readonly Child[];
export type Component<P> = (props: P) => Child;
export type Props = Record<string, unknown>;
export type SetState<T> = (value: T | ((prev: T) => T)) => void;
export interface Ref<T> {
	current: T;
}

export interface ReactLike {
	createElement(type: unknown, props: Props | null, ...children: Child[]): ReactElement;
	Fragment: unknown;
	useState<T>(initial: T | (() => T)): [T, SetState<T>];
	useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
	useRef<T>(initial: T): Ref<T>;
	useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
}

let R: ReactLike | undefined;

export function setReact(react: ReactLike): void {
	R = react;
}

function react(): ReactLike {
	if (!R) throw new Error("Switchyard: React is not set");
	return R;
}

/** createElement for host tags (props: DOM attributes and handlers) and own components. */
export function h(type: string, props?: Props | null, ...children: Child[]): ReactElement;
export function h<P extends object>(type: Component<P>, props: P & { key?: string | number }, ...children: Child[]): ReactElement;
export function h(type: unknown, props?: object | null, ...children: Child[]): ReactElement {
	return react().createElement(type, (props ?? null) as Props | null, ...children);
}

export function fragment(...children: Child[]): ReactElement {
	return react().createElement(react().Fragment, null, ...children);
}

export const useState = <T>(initial: T | (() => T)): [T, SetState<T>] => react().useState(initial);
export const useEffect = (effect: () => void | (() => void), deps?: readonly unknown[]): void => react().useEffect(effect, deps);
export const useRef = <T>(initial: T): Ref<T> => react().useRef(initial);
export const useMemo = <T>(factory: () => T, deps: readonly unknown[]): T => react().useMemo(factory, deps);
