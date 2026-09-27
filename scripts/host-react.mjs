import { fileURLToPath } from "node:url";

const shim = fileURLToPath(new URL("../ui/jsx-runtime.js", import.meta.url));
const jsxRuntime = (build) =>
  build.onResolve({ filter: /^react\/jsx(-dev)?-runtime$/ }, () => ({ path: shim }));

/** esbuild plugin: React stays external (the host supplies it); the JSX runtime is bundled as a shim. */
export const hostReact = {
  name: "host-react",
  setup(build) {
    jsxRuntime(build);
    build.onResolve({ filter: /^react$/ }, () => ({ path: "react", external: true }));
  },
};

/** The standalone preview bundles React but routes the JSX runtime through the same shim. */
export const shimJsxRuntime = { name: "shim-jsx-runtime", setup: jsxRuntime };
