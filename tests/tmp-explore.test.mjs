import test from 'node:test';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary, outlineModel } from './helpers/course-outline-library.mjs';
import { isCourseOutlineSource } from '../lib/exam-point-list.js';

test('explore', async t => {
  const fake = outlineModel();
  const root = await privateRoot(t, 'explore-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const { sources, decks } = outlineLibrary({ paper: true });
  await service.store.update(state => { state.sources.push(...structuredClone(sources)); state.decks.push(...structuredClone(decks)); state.focus = { mode: 'class', course: COURSE }; });
  const job = await settleJob(service, (await service.call('generation.courseOutline.build', { course: COURSE, language: 'zh' })).jobId);
  console.log(job.status, JSON.stringify(job.error ?? null));
  const outline = (await service.store.read()).sources.filter(isCourseOutlineSource)[0].courseOutline;
  const show = (nodes, d) => nodes.forEach(n => { console.log(`${'  '.repeat(d)}${n.title} ${n.anchors ? `[${n.anchors.length} anchors: ${n.anchors.slice(0, 3).join(' ')}] items ${n.items?.length} ex ${n.exam?.evidence?.length ?? 0}` : ''}`); if (n.children) show(n.children, d + 1); });
  show(outline.nodes, 0);
  console.log('other', outline.other.anchors, outline.counts, outline.papers?.map(p => p.key), outline.papersBy, outline.from);
  const view = await service.call('course.outline', { course: COURSE });
  console.log('total', view.total, 'unplaced', view.unplaced.total, 'book', view.book.nodes.reduce((s, n) => s + n.total, 0), 'other', view.book.other?.total);
});
