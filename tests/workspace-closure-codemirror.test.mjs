/* The editor libraries stay out of the workspace's first load (#561). Opening the workspace downloaded and ran CodeMirror and its
   Markdown, HTML and JavaScript grammars (597 KB) because the review book's editor (ui/book/BookEditor.jsx) was imported statically
   by ui/book/book-views.jsx; only 编辑这个知识点 and the study notes' editor use them. This builds the real DSH client modules
   (scripts/build.mjs, nothing written), follows the static `import-statement` edges from the workspace chunk — the modules that
   arrive with it — and checks that none of them carries an `@codemirror/*`, `@uiw/react-codemirror` or `@lezer/*` input, while the
   editor itself is still built, behind a dynamic import. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { buildHostClient } from '../scripts/build.mjs';

const editorPackage = /node_modules[\\/](?:@codemirror|@lezer|@uiw[\\/]react-codemirror)[\\/]/;

test('the workspace chunk and its static imports carry no CodeMirror or lezer code; the review-book editor loads on its own', async () => {
  const { metafile } = await buildHostClient({ write: false });
  const outputs = new Map(Object.entries(metafile.outputs).map(([path, output]) => [basename(path), output]));
  const workspace = [...outputs.keys()].filter(name => /^client\.workspace-[^.]+\.js$/.test(name));
  assert.equal(workspace.length, 1, `one workspace chunk: ${workspace.join(', ')}`);
  const closure = new Set();
  const visit = name => {
    if (closure.has(name)) return;
    closure.add(name);
    for (const edge of outputs.get(name).imports) if (!edge.external && edge.kind === 'import-statement') visit(basename(edge.path));
  };
  visit(workspace[0]);
  const inputs = [...closure].flatMap(name => Object.keys(outputs.get(name).inputs).map(input => [name, input]));
  const editor = inputs.filter(([, input]) => editorPackage.test(input));
  assert.deepEqual(editor.slice(0, 5), [], `the workspace's static closure carries ${editor.length} editor inputs`);
  const bytes = [...closure].reduce((sum, name) => sum + outputs.get(name).bytes, 0);
  console.log(`workspace static closure: ${closure.size} modules, ${bytes} bytes`);
  // The editor is still built: BookEditor has a chunk of its own, reached by a dynamic import only.
  const bookEditor = [...outputs].find(([, output]) => output.entryPoint === 'ui/book/BookEditor.jsx');
  assert.ok(bookEditor, 'the review-book editor is a lazily loaded module');
  assert.ok(!closure.has(bookEditor[0]));
  assert.ok([...outputs.values()].some(output => output.imports.some(edge => edge.kind === 'dynamic-import' && basename(edge.path) === bookEditor[0])));
});
