// Minimal stand-in for the VS Code webview global so webview modules can load under node.
Object.assign(globalThis, {
	acquireVsCodeApi: () => ({ postMessage() {}, setState() {}, getState: () => undefined }),
});
