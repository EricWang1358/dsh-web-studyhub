import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { recapDay } from '../lib/daily-recap.js';

test('daily status previews saved prose without headings, images, markup or internal preparation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'recap-preview-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.store.update(state => {
    state.decks.push({ id: 'd', title: '第一章', course: '数学', cards: [] });
    state.notes.push({ id: 'n', kind: 'daily-recap', title: '今日回顾', markdown: '# 今日回顾\n\n![图片](https://example.com/figure.png)\n\n先**核对条件**，再看[推理步骤](https://example.com)。\n\n## 后续讲解\n\n第二段不应出现在预览。',
      daily: { day: recapDay(Date.now(), 'Asia/Shanghai'), course: '数学', timeZone: 'Asia/Shanghai', fragments: [{ markdown: '内部准备片段' }] },
      generation: { status: 'running' }, status: 'draft', revision: 0, cards: [] });
  });
  const group = (await service.call('note.daily.status', { course: '数学' })).groups[0];
  assert.equal(group.preview, '先核对条件，再看推理步骤。');
  assert.ok(group.hasContent, 'the previous version is available during updates');
  assert.ok(!JSON.stringify(group).includes('内部准备片段'));
  for (const markdown of ['# 今日回顾\n\n- 先**核对条件**，再看推理步骤。\n- 之后再练习。', '# 今日回顾\n\n> 先**核对条件**，再看推理步骤。']) {
    await service.store.update(state => { state.notes[0].markdown = markdown; });
    assert.equal((await service.call('note.daily.status', { course: '数学' })).groups[0].preview, '先核对条件，再看推理步骤。');
  }
});
