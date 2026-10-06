import { fileURLToPath } from "node:url";

const shim = fileURLToPath(new URL("../ui/jsx-runtime.js", import.meta.url));
const jsxRuntime = (build) =>
  build.onResolve({ filter: /^react\/jsx(-dev)?-runtime$/ }, () => ({ path: shim }));

/** esbuild plugin: React and React DOM stay external (the DSH host seeds both: `react`, `react-dom`, `react-dom/client` are in its platform
 *  table, and it is React 18); the JSX runtime is bundled as a shim. A bundled react-dom of another major version cannot work next to the
 *  host's react: its flushSync reads React 19 internals that React 18 does not have, which Base UI (Select, Combobox) calls to place a popup. */
export const hostReact = {
  name: "host-react",
  setup(build) {
    jsxRuntime(build);
    build.onResolve({ filter: /^react$/ }, () => ({ path: "react", external: true }));
    build.onResolve({ filter: /^react-dom(\/client)?$/ }, (args) => ({ path: args.path, external: true }));
  },
};

/** The standalone preview bundles React but routes the JSX runtime through the same shim. */
export const shimJsxRuntime = { name: "shim-jsx-runtime", setup: jsxRuntime };
