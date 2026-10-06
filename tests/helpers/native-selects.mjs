import { fileURLToPath } from 'node:url';

const stub = fileURLToPath(new URL('./native-select-stub.jsx', import.meta.url));

/** esbuild plugin for server-render tests: Select and Combobox become native <select> markup (see native-select-stub.jsx). */
export const nativeSelects = {
  name: 'native-selects',
  setup(build) {
    build.onResolve({ filter: /(^|\/)(Select|Combobox)\.jsx$/ }, () => ({ path: stub }));
  },
};
