// Module `bridge.js` of the Switchyard omp extension package: the VS Code bridge tools (`mcp__vscode_*`).
// Not gated by AO_SESSION_ID: they help a terminal omp too, and answer "VS Code is not connected" when
// no window is open. `omp.vscodeTools` off writes the bridge's `disabled` flag, which it honours at runtime.
export { default } from "../bridge/omp-extension";
