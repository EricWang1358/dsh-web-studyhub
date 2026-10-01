import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// The preview mounts App at import time; capture what it mounts instead of rendering it.
const probes = {
  name: 'preview-probes',
  setup(builder) {
    builder.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: 'react-dom-client', namespace: 'probe' }));
    builder.onResolve({ filter: /[\\/]App\.jsx$/ }, () => ({ path: 'app', namespace: 'probe' }));
    builder.onLoad({ filter: /^react-dom-client$/, namespace: 'probe' }, () => ({ loader: 'js', contents:
      'export function createRoot(node) { return { render(element) { globalThis.__mounted.push({ node, element }); } }; }' }));
    builder.onLoad({ filter: /^app$/, namespace: 'probe' }, () => ({ loader: 'js', contents: 'export default function App() { return null; }' }));
  },
};

test('the local preview names itself StudyHub and declares preview capabilities', async () => {
  const compiled = await build({ entryPoints: ['ui/dev.jsx'], bundle: true, write: false, platform: 'node', format: 'cjs',
    external: ['react'], loader: { '.css': 'text' }, plugins: [probes], logLevel: 'silent' });
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.__mounted = [];
  globalThis.document = { title: 'Study · DSH', getElementById: id => ({ id }) };
  globalThis.window = { STUDY_TOKEN: 'token' };
  try {
    const module = { exports: {} };
    new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
    assert.equal(globalThis.document.title, 'StudyHub');
    assert.equal(globalThis.__mounted.length, 1);
    const { element } = globalThis.__mounted[0];
    assert.deepEqual(element.props.host.capabilities, { edition: 'preview', chat: false, agentTasks: false, landing: false });
    assert.equal(typeof element.props.call, 'function');
  } finally {
    for (const key of Object.keys(saved)) saved[key] === undefined ? delete globalThis[key] : globalThis[key] = saved[key];
  }
});
