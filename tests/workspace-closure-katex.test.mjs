/* The formula renderer (KaTeX and its mhchem extension, about 295 KB) loads only where a formula is drawn (StudyMath, the reader),
   never with the workspace itself. This walks the static import edges of the built host client from the workspace chunk: any
   module in that closure arrives before the workspace can show anything (issue #560). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { buildHostClient } from '../scripts/build.mjs';

test('the workspace chunk does not statically load KaTeX', async () => {
  const { metafile } = await buildHostClient({ write: false });
  const outputs = new Map(Object.entries(metafile.outputs).map(([path, output]) => [basename(path), output]));
  const workspace = [...outputs.keys()].filter(name => /^client\.workspace-[A-Za-z0-9]+\.js$/.test(name));
  assert.equal(workspace.length, 1, 'the workspace has one chunk of its own');
  const closure = new Set(), pending = [...workspace];
  while (pending.length) {
    const name = pending.pop();
    if (closure.has(name)) continue;
    closure.add(name);
    for (const edge of outputs.get(name).imports)
      if (!edge.external && edge.kind === 'import-statement') pending.push(basename(edge.path));
  }
  const inputs = [...closure].flatMap(name => Object.keys(outputs.get(name).inputs).map(input => input.replaceAll('\\', '/')));
  assert.deepEqual(inputs.filter(input => input.includes('node_modules/katex/')), [], 'KaTeX must stay behind a dynamic import');
  assert.ok(!inputs.includes('ui/study-math-render.js'), 'the formula renderer must stay behind a dynamic import');
  // The renderer still has its own chunk, which a dynamic import reaches.
  const math = [...outputs].find(([, output]) => output.entryPoint === 'ui/study-math-render.js');
  assert.ok(math, 'the formula renderer keeps its own chunk');
  assert.ok([...outputs.values()].some(output => output.imports.some(edge => edge.kind === 'dynamic-import' && basename(edge.path) === math[0])));
});
