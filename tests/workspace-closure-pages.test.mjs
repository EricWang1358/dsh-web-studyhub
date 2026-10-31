import test from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { buildHostClient } from '../scripts/build.mjs';

/* #562: the study workspace's first load carries the daily path only. The DSH loader fetches the workspace chunk after every chunk it
   imports statically, one depth level (wave) at a time, so whatever sits in that static closure delays the first screen. The pages the
   learner opens now and then arrive with their own chunk through deferredView (ui/workspace-views.jsx) the first time they are opened. */

// Measured with this file's closure() on the change that made these pages lazy: 4,839,744 bytes (79 chunks, 6 waves) before, 3,858,173 bytes (96 chunks, 6 waves) after.
const CEILING_BYTES = 3_950_000;
const MAX_WAVES = 6;
const ON_DEMAND = ['ui/Exam.jsx', 'ui/Board.jsx', 'ui/Dashboard.jsx', 'ui/book/BookPage.jsx', 'ui/outline/CourseOutline.jsx', 'ui/exam-prep/ExamPrep.jsx',
  'ui/LiveClass.jsx', 'ui/AudioDashboard.jsx', 'ui/BlogNotes.jsx', 'ui/Skeleton.jsx', 'ui/Workflows.jsx', 'ui/Graph.jsx', 'ui/tasks/TaskConsole.jsx',
  'ui/guided-study/GuidedStudyWorkbench.jsx'];
const DAILY = ['ui/StudyMap.jsx', 'ui/Sources.jsx', 'ui/Generate.jsx', 'ui/Draft.jsx', 'ui/Review.jsx', 'ui/WrongBook.jsx', 'ui/Settings.jsx'];

async function closure() {
  const { metafile } = await buildHostClient({ write: false });
  const outputs = new Map(Object.entries(metafile.outputs).map(([path, output]) => [basename(path), output]));
  const statics = (name) => outputs.get(name).imports.filter((edge) => !edge.external && edge.kind === 'import-statement').map((edge) => basename(edge.path));
  const workspace = [...outputs].find(([, output]) => output.entryPoint === 'ui/host/workspace.jsx')?.[0];
  assert.ok(workspace, 'the workspace has a chunk of its own');
  const chunks = new Set(), pending = [workspace];
  while (pending.length) { const name = pending.pop(); if (!chunks.has(name)) { chunks.add(name); pending.push(...statics(name)); } }
  // The same depth the build's loadExpression gives a chunk: the number of waves fetched before the workspace itself.
  const depth = new Map();
  const depthOf = (name) => { if (!depth.has(name)) depth.set(name, Math.max(-1, ...statics(name).map(depthOf)) + 1); return depth.get(name); };
  const inputs = new Set([...chunks].flatMap((name) => Object.keys(outputs.get(name).inputs)));
  const lazilyReached = new Set([...outputs.values()].flatMap((output) => output.imports.filter((edge) => edge.kind === 'dynamic-import').map((edge) => basename(edge.path))));
  const entryChunk = (input) => [...outputs].find(([, output]) => output.entryPoint === input)?.[0];
  return { bytes: [...chunks].reduce((sum, name) => sum + outputs.get(name).bytes, 0), waves: depthOf(workspace), inputs, lazilyReached, entryChunk };
}

test('the pages off the daily path are not in the workspace first load, and that load stays under its ceiling', async () => {
  const { bytes, waves, inputs, lazilyReached, entryChunk } = await closure();
  for (const page of ON_DEMAND) {
    assert.ok(!inputs.has(page), `${page} is loaded on demand, not with the workspace`);
    const chunk = entryChunk(page);
    assert.ok(chunk && lazilyReached.has(chunk), `${page} has its own chunk, reached by a dynamic import`);
  }
  for (const page of DAILY) assert.ok(inputs.has(page), `${page} is on the daily path and stays in the first load`);
  assert.ok(bytes <= CEILING_BYTES, `the workspace static closure is ${bytes} bytes, over the ${CEILING_BYTES} ceiling: a page or a library joined the first load`);
  assert.ok(waves <= MAX_WAVES, `the loader needs ${waves} sequential waves before the workspace, more than ${MAX_WAVES}`);
});
